/**
 * Kernel-side `.csg` geometry builder — walks `csgImport.ts`'s AST with LIVE
 * OCCT handles and returns one `TopoDS_Shape` (a compound, possibly empty).
 * Called from `loadBRep`/`exportBRep`'s `"csg"` branches; the `.csg` document's
 * base shape is OPAQUE (like a STEP import — user edits layer on top via the
 * sidecar, the parsed structure is not itself an edit history). See
 * `csgImport.ts` for why lowering to `EditOp`s was rejected (index
 * simulation fragility, shear, `addPolyhedron`-needs-an-icon).
 *
 * Every OCCT call shape below was probed live before writing (see the
 * session's throwaway `csg-probe*.cjs` scripts, not committed):
 * - empty compound + `applyEditsBRep`-free direct build: `TopoDS_Compound` +
 *   `BRep_Builder.MakeCompound` + per-node solids, union volume exact.
 * - primitives: `BRepPrimAPI_MakeBox_3(pnt, pnt)` (same overload booleans
 *   use), `MakeSphere_5`, `MakeCylinder_3(ax2, r, h)`, `MakeCone_3`,
 *   `MakeTorus_5` — the exact suffixes `occtOperations.ts` uses.
 * - booleans: `BRepAlgoAPI_{Fuse,Cut,Common}_3(a, b).Shape()` + `IsDone()`
 *   gate; operands compounded first (the `booleanSolids` skeleton).
 * - transforms: EVERYTHING (rigid, scale, mirror, shear) through ONE path —
 *   `gp_GTrsf_1` + `SetValue(r, c, v)` (1-based 3×4) +
 *   `BRepBuilderAPI_GTransform_2(shape, g, true)` — verified for
 *   near-identity (float noise `2.22045e-16`), scale-×2 (volume doubles
 *   exactly), and mirror (volume stays positive). No rigid/non-rigid split,
 *   no Euler decomposition into op-shaped pieces.
 * - polyhedron: per-face `MakeWire_1` + `MakeEdge_3` + `MakeFace_15(wire,
 *   true)`, then `BRepBuilderAPI_Sewing(1e-6, true, true, true, false)` +
 *   `Perform(Handle_Message_ProgressIndicator_1)` + `NbFreeEdges() == 0`
 *   gate (the promotion pipeline's own closure check) + `MakeSolid_3` +
 *   orientation fix (below). Verified: square pyramid sews to 0 free edges.
 * - N-gon prism (faceted cylinders): wire + face + `MakePrism_1`, volume
 *   exact vs analytic `(N/2)r²sin(2π/N)h` — the `addPrism` recipe.
 *
 * Memory discipline: every created handle is pushed into `cleanup` (the
 * `meshExtract.ts`/`occtOperations.ts` convention); the RETURNED shape is
 * also in `cleanup` — its lifetime belongs to the caller, exactly like
 * `applyEditsBRep`'s contract.
 */

import type { CsgNode } from "./csgImport";
import { resolveSegments } from "./csgImport";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Oc = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Shape = any;
type Cleanup = Array<{ delete(): void }>;

const SEW_TOL = 1e-6;
/** Last row a `gp_GTrsf` can represent — anything else is projective. */
const AFFINE_LAST_ROW: [number, number, number, number] = [0, 0, 0, 1];

function keep<T extends { delete(): void }>(cleanup: Cleanup, h: T): T {
  cleanup.push(h);
  return h;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asVec3(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const [a, b, c] = v as unknown[];
  if (typeof a !== "number" || typeof b !== "number" || typeof c !== "number") return null;
  if (![a, b, c].every(Number.isFinite)) return null;
  return [a, b, c];
}

function pnt(oc: Oc, p: [number, number, number], cleanup: Cleanup): unknown {
  return keep(cleanup, new oc.gp_Pnt_3(p[0], p[1], p[2]));
}

/** Canonical "positive" orientation — the same rule `occtOperations.ts`'s
 * (private) `orientPositiveVolume` enforces for thin features: a reversed
 * solid reports NEGATIVE volume into every consumer, so flip it. Probed:
 * a CCW-wound pyramid sews to volume −266.67 without this. */
function orientPositive(oc: Oc, solid: Shape, cleanup: Cleanup): Shape | null {
  const props = keep(cleanup, new oc.GProp_GProps_1());
  oc.BRepGProp.VolumeProperties2(solid, props, 1e-3, false, false);
  const v = props.Mass() as number;
  if (!Number.isFinite(v) || Math.abs(v) < 1e-9) return null;
  return v < 0 ? keep(cleanup, solid.Reversed()) : solid;
}

function compoundOf(oc: Oc, shapes: Shape[], cleanup: Cleanup): Shape {
  const comp = keep(cleanup, new oc.TopoDS_Compound());
  const builder = keep(cleanup, new oc.BRep_Builder());
  builder.MakeCompound(comp);
  for (const s of shapes) {
    if (s == null) continue;
    if (typeof s.IsNull === "function" && s.IsNull()) continue;
    builder.Add(comp, s);
  }
  return comp;
}

function emptyCompound(oc: Oc, cleanup: Cleanup): Shape {
  const comp = keep(cleanup, new oc.TopoDS_Compound());
  keep(cleanup, new oc.BRep_Builder()).MakeCompound(comp);
  return comp;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function buildBox(oc: Oc, node: CsgNode, cleanup: Cleanup, warn: (m: string) => void): Shape | null {
  const s = node.params["size"] ?? node.params["#0"];
  let size: [number, number, number] | null = null;
  if (typeof s === "number") size = [s, s, s];
  else if (Array.isArray(s) && s.length === 3) size = asVec3(s as unknown);
  if (!size || size.some((x) => !(x > 0))) { warn(`cube with non-positive/unparseable size — skipping`); return null; }
  const center = node.params["center"] === true;
  const c: [number, number, number] = center ? [0, 0, 0] : [size[0] / 2, size[1] / 2, size[2] / 2];
  const mk = keep(cleanup, new oc.BRepPrimAPI_MakeBox_3(
    pnt(oc, [c[0] - size[0] / 2, c[1] - size[1] / 2, c[2] - size[2] / 2], cleanup),
    pnt(oc, [c[0] + size[0] / 2, c[1] + size[1] / 2, c[2] + size[2] / 2], cleanup),
  ));
  return mk.Shape();
}

function buildSphere(oc: Oc, node: CsgNode, cleanup: Cleanup, warn: (m: string) => void, useMaxFN: number): Shape | null {
  const p = node.params;
  let r = num(p["r"]) ?? (num(p["d"]) !== undefined ? (num(p["d"]) as number) / 2 : undefined);
  if (!(r !== undefined && r > 0)) { warn(`sphere with unparseable radius — skipping`); return null; }
  const n = resolveSegments(r, num(p["$fn"]), num(p["$fa"]), num(p["$fs"]));
  if (n <= useMaxFN) {
    warn(`sphere(r=${r}, $fn=${num(p["$fn"]) ?? 0}) is a ${n}-segment faceted solid in OpenSCAD — importing analytic (chord error ${(r * (1 - Math.cos(Math.PI / n))).toPrecision(3)}mm)`);
  }
  const mk = keep(cleanup, new oc.BRepPrimAPI_MakeSphere_5(pnt(oc, [0, 0, 0], cleanup), r));
  return mk.Shape();
}

function buildCylinder(oc: Oc, node: CsgNode, cleanup: Cleanup, warn: (m: string) => void, useMaxFN: number): Shape | null {
  const p = node.params;
  const h = num(p["h"]) ?? num(p["height"]);
  if (!(h !== undefined && h > 0)) { warn(`cylinder with unparseable height — skipping`); return null; }
  let r1 = num(p["r1"]) ?? (num(p["d1"]) !== undefined ? (num(p["d1"]) as number) / 2 : undefined);
  let r2 = num(p["r2"]) ?? (num(p["d2"]) !== undefined ? (num(p["d2"]) as number) / 2 : undefined);
  const r = num(p["r"]) ?? (num(p["d"]) !== undefined ? (num(p["d"]) as number) / 2 : undefined);
  if (r !== undefined) { r1 = r; r2 = r; }
  if (!(r1 !== undefined && r2 !== undefined && r1 >= 0 && r2 >= 0 && (r1 > 0 || r2 > 0))) {
    warn(`cylinder with unparseable radii — skipping`);
    return null;
  }
  const center = p["center"] === true;
  const base: [number, number, number] = center ? [0, 0, -h / 2] : [0, 0, 0];
  const ax2 = keep(cleanup, new oc.gp_Ax2_3(pnt(oc, base, cleanup), keep(cleanup, new oc.gp_Dir_4(0, 0, 1))));
  const rMax = Math.max(r1, r2);
  const n = resolveSegments(rMax, num(p["$fn"]), num(p["$fa"]), num(p["$fs"]));
  if (r1 === r2 && n <= useMaxFN) {
    // Faithful N-gon prism. OpenSCAD starts its first polygon vertex at +X;
    // so does this loop — orientation matches by construction.
    return buildNgonPrism(oc, base, r1, n, h, cleanup);
  }
  if (r1 === r2) {
    warn(`cylinder(r=${r1}, $fn=${num(p["$fn"]) ?? 0} → ${n} segments) above useMaxFN=${useMaxFN} — importing analytic (chord error ${(r1 * (1 - Math.cos(Math.PI / n))).toPrecision(3)}mm)`);
    return keep(cleanup, new oc.BRepPrimAPI_MakeCylinder_3(ax2, r1, h)).Shape();
  }
  if (n <= useMaxFN) warn(`tapered cylinder(r1=${r1}, r2=${r2}, ${n} segments) is faceted in OpenSCAD — importing analytic frustum`);
  return keep(cleanup, new oc.BRepPrimAPI_MakeCone_3(ax2, r1, r2, h)).Shape();
}

/** Regular N-gon prism, base at `base`, axis +Z — the `addPrism` recipe
 * (`occtOperations.ts`), restricted to the axis OpenSCAD cylinders use. */
function buildNgonPrism(
  oc: Oc, base: [number, number, number], radius: number, sides: number, height: number, cleanup: Cleanup,
): Shape | null {
  const pts: Array<[number, number, number]> = [];
  for (let i = 0; i < sides; i++) {
    const a = (2 * Math.PI * i) / sides;
    pts.push([base[0] + radius * Math.cos(a), base[1] + radius * Math.sin(a), base[2]]);
  }
  const wireMk = keep(cleanup, new oc.BRepBuilderAPI_MakeWire_1());
  for (let i = 0; i < pts.length; i++) {
    const e = keep(cleanup, new oc.BRepBuilderAPI_MakeEdge_3(pnt(oc, pts[i], cleanup), pnt(oc, pts[(i + 1) % pts.length], cleanup)));
    wireMk.Add_1(e.Edge());
  }
  if (!wireMk.IsDone()) return null;
  const faceMk = keep(cleanup, new oc.BRepBuilderAPI_MakeFace_15(wireMk.Wire(), true));
  const face = faceMk.Face();
  const vec = keep(cleanup, new oc.gp_Vec_4(0, 0, height));
  return keep(cleanup, new oc.BRepPrimAPI_MakePrism_1(face, vec, false, true)).Shape();
}

function buildPolyhedron(oc: Oc, node: CsgNode, cleanup: Cleanup, warn: (m: string) => void): Shape | null {
  const rawPts = node.params["points"];
  if (!Array.isArray(rawPts) || (rawPts as unknown[]).length < 12) {
    warn(`polyhedron with <4 points — skipping`);
    return null;
  }
  const flat = rawPts as unknown[];
  if (flat.some((x) => typeof x !== "number" || !Number.isFinite(x))) {
    warn(`polyhedron with non-numeric points — skipping`);
    return null;
  }
  const points: Array<[number, number, number]> = [];
  for (let i = 0; i + 2 < flat.length; i += 3) points.push([flat[i] as number, flat[i + 1] as number, flat[i + 2] as number]);
  const faces = node.faces;
  if (!faces || faces.length < 4) {
    warn(`polyhedron with <4 faces (or unparseable faces=) — skipping`);
    return null;
  }
  try {
    const gpPts = points.map((q) => pnt(oc, q, cleanup));
    const brepFaces: Shape[] = [];
    for (const f of faces) {
      if (f.length < 3 || f.some((x) => !(Number.isInteger(x) && x >= 0 && x < points.length))) {
        warn(`polyhedron with out-of-range face index — skipping`);
        return null;
      }
      // fan-triangulate N-gons
      for (let i = 1; i + 1 < f.length; i++) {
        const wireMk = keep(cleanup, new oc.BRepBuilderAPI_MakeWire_1());
        for (const [a, b] of [[f[0], f[i]], [f[i], f[i + 1]], [f[i + 1], f[0]]]) {
          const e = keep(cleanup, new oc.BRepBuilderAPI_MakeEdge_3(gpPts[a], gpPts[b]));
          wireMk.Add_1(e.Edge());
        }
        if (!wireMk.IsDone()) { warn(`polyhedron face failed to wire — skipping`); return null; }
        brepFaces.push(keep(cleanup, new oc.BRepBuilderAPI_MakeFace_15(wireMk.Wire(), true)).Face());
      }
    }
    const sew = keep(cleanup, new oc.BRepBuilderAPI_Sewing(SEW_TOL, true, true, true, false));
    for (const f of brepFaces) sew.Add(f);
    sew.Perform(keep(cleanup, new oc.Handle_Message_ProgressIndicator_1()));
    if (sew.NbFreeEdges() > 0) {
      warn(`polyhedron did not close (${sew.NbFreeEdges()} free edges) — skipping`);
      return null;
    }
    const exp = keep(cleanup, new oc.TopExp_Explorer_2(sew.SewedShape(), oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
    if (!exp.More()) { warn(`polyhedron produced no shell — skipping`); return null; }
    const solid = keep(cleanup, new oc.BRepBuilderAPI_MakeSolid_3(oc.TopoDS.Shell_1(exp.Current()))).Solid();
    const oriented = orientPositive(oc, solid, cleanup);
    if (!oriented) { warn(`polyhedron collapsed to zero volume — skipping`); return null; }
    return oriented;
  } catch (e) {
    warn(`polyhedron build threw (${e instanceof Error ? e.message : String(e)}) — skipping`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transforms — one uniform gp_GTrsf path for every node kind
// ---------------------------------------------------------------------------

function translateMatrix(v: [number, number, number]): number[] {
  return [1, 0, 0, v[0], 0, 1, 0, v[1], 0, 0, 1, v[2], 0, 0, 0, 1];
}

function scaleMatrix(v: [number, number, number]): number[] {
  return [v[0], 0, 0, 0, 0, v[1], 0, 0, 0, 0, v[2], 0, 0, 0, 0, 1];
}

function mirrorMatrix(n: [number, number, number]): number[] {
  const l = Math.hypot(n[0], n[1], n[2]);
  const nx = n[0] / l, ny = n[1] / l, nz = n[2] / l;
  return [
    1 - 2 * nx * nx, -2 * nx * ny, -2 * nx * nz, 0,
    -2 * ny * nx, 1 - 2 * ny * ny, -2 * ny * nz, 0,
    -2 * nz * nx, -2 * nz * ny, 1 - 2 * nz * nz, 0,
    0, 0, 0, 1,
  ];
}

/** OpenSCAD `rotate(a=[x,y,z])` is extrinsic X→Y→Z (R = Rz·Ry·Rx); `a=deg,
 * v=` is axis-angle (Rodrigues). Returns row-major 4×4 or null. */
function rotateMatrix(p: Record<string, unknown>): number[] | null {
  const a = p["a"] ?? p["#0"];
  const v = asVec3(p["v"]);
  if (typeof a === "number" && !v) {
    // rotate(deg) — about Z by OpenSCAD convention.
    return rotateMatrix({ a, v: [0, 0, 1] });
  }
  if (typeof a === "number" && v) {
    const l = Math.hypot(v[0], v[1], v[2]);
    if (!(l > 0)) return null;
    const [x, y, z] = [v[0] / l, v[1] / l, v[2] / l];
    const t = (a * Math.PI) / 180;
    const c = Math.cos(t), s = Math.sin(t), C = 1 - c;
    return [
      x * x * C + c, x * y * C - z * s, x * z * C + y * s, 0,
      y * x * C + z * s, y * y * C + c, y * z * C - x * s, 0,
      z * x * C - y * s, z * y * C + x * s, z * z * C + c, 0,
      0, 0, 0, 1,
    ];
  }
  if (Array.isArray(a) && a.length === 3) {
    const av = asVec3(a as unknown);
    if (!av) return null;
    const [ex, ey, ez] = [(av[0] * Math.PI) / 180, (av[1] * Math.PI) / 180, (av[2] * Math.PI) / 180];
    const Rx = [1, 0, 0, 0, 0, Math.cos(ex), -Math.sin(ex), 0, 0, Math.sin(ex), Math.cos(ex), 0, 0, 0, 0, 1];
    const Ry = [Math.cos(ey), 0, Math.sin(ey), 0, 0, 1, 0, 0, -Math.sin(ey), 0, Math.cos(ey), 0, 0, 0, 0, 1];
    const Rz = [Math.cos(ez), -Math.sin(ez), 0, 0, Math.sin(ez), Math.cos(ez), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    return matMul(Rz, matMul(Ry, Rx));
  }
  return null;
}

function matMul(A: number[], B: number[]): number[] {
  const out = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) out[r * 4 + c] += A[r * 4 + k] * B[k * 4 + c];
  return out;
}

function nodeMatrix(node: CsgNode, warn: (m: string) => void): number[] | null {
  const p = node.params as Record<string, unknown>;
  switch (node.name) {
    case "multmatrix": {
      const m = (p["m"] ?? p["#0"]) as unknown;
      if (!Array.isArray(m) || m.length !== 16 || !(m as unknown[]).every((x) => typeof x === "number" && Number.isFinite(x))) {
        warn(`multmatrix with unparseable m= — dropping children`);
        return null;
      }
      return m as number[];
    }
    case "translate": {
      const v = asVec3(p["v"] ?? p["#0"]);
      if (!v) { warn(`translate with unparseable v — dropping children`); return null; }
      return translateMatrix(v);
    }
    case "scale": {
      const raw = (p["v"] ?? p["#0"]) as unknown;
      const v = typeof raw === "number" ? [raw, raw, raw] as [number, number, number] : asVec3(raw);
      if (!v) { warn(`scale with unparseable v — dropping children`); return null; }
      return scaleMatrix(v);
    }
    case "mirror": {
      const v = asVec3(p["v"] ?? p["#0"] ?? p["vec"]);
      if (!v || Math.hypot(v[0], v[1], v[2]) <= 0) { warn(`mirror with unparseable v — dropping children`); return null; }
      return mirrorMatrix(v);
    }
    case "rotate": {
      const m = rotateMatrix(p);
      if (!m) { warn(`rotate with unparseable params — importing children unrotated`); return null; }
      return m;
    }
    default:
      return null;
  }
}

/** Applies a row-major 4×4 to every shape. The last row must be affine;
 * shear needs NO special path (`gp_GTrsf` is general 3×4 — probed). */
function applyMatrix(oc: Oc, shapes: Shape[], m: number[], cleanup: Cleanup, warn: (m: string) => void): Shape[] | null {
  for (let i = 0; i < 4; i++) {
    if (Math.abs(m[12 + i] - AFFINE_LAST_ROW[i]) > 1e-9) {
      warn(`transform with projective last row — dropping children (affine only)`);
      return null;
    }
  }
  const out: Shape[] = [];
  for (const s of shapes) {
    try {
      const g = keep(cleanup, new oc.gp_GTrsf_1());
      for (let r = 1; r <= 3; r++) for (let c = 1; c <= 4; c++) g.SetValue(r, c, m[(r - 1) * 4 + (c - 1)]);
      out.push(keep(cleanup, new oc.BRepBuilderAPI_GTransform_2(s, g, true)).Shape());
    } catch (e) {
      warn(`transform build threw (${e instanceof Error ? e.message : String(e)}) — dropping child`);
      return null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tree walk — returns live shapes (caller owns nothing; all in cleanup)
// ---------------------------------------------------------------------------

const SKIP_SUBTREE_MSGS: Record<string, string> = {
  hull: "hull() has no OCCT equivalent — skipping",
  minkowski: "minkowski() has no OCCT equivalent — skipping",
  text: "text() carries a font name, not outlines (the reference WASM ships with no font support) — skipping",
  import: "import() references an external file — skipping",
  surface: "surface() references an external heightmap file — skipping",
  square: "2D square() is not imported in v1 (linear_extrude of 2D is out of scope) — skipping",
  circle: "2D circle() is not imported in v1 — skipping",
  polygon: "2D polygon() is not imported in v1 — skipping",
  linear_extrude: "linear_extrude() of 2D profiles is not imported in v1 — skipping",
  rotate_extrude: "rotate_extrude() of 2D profiles is not imported in v1 — skipping",
  offset: "2D offset() is not imported in v1 — skipping",
  projection: "projection() cuts to 2D — skipping",
  resize: "resize() is not imported in v1 — skipping",
};

function booleanOf(oc: Oc, kind: "union" | "subtract" | "intersect", a: Shape, b: Shape, cleanup: Cleanup): Shape | null {
  const Ctor =
    kind === "union" ? oc.BRepAlgoAPI_Fuse_3
    : kind === "subtract" ? oc.BRepAlgoAPI_Cut_3
    : oc.BRepAlgoAPI_Common_3;
  const algo = keep(cleanup, new Ctor(a, b));
  if (!algo.IsDone()) return null;
  const r = algo.Shape();
  cleanup.push(r);
  if (typeof r.IsNull === "function" && r.IsNull()) return null;
  return r;
}

function evalShapes(oc: Oc, node: CsgNode, cleanup: Cleanup, warn: (m: string) => void, useMaxFN: number): Shape[] {
  if (node.modifier === "*") { warn(`disabled (*${node.name}) subtree — skipping`); return []; }
  if (node.modifier === "!") warn(`show-only (!${node.name}) treated as transparent — siblings are NOT hidden on import`);

  const name = node.name;
  if (name === "group" || name === "color" || name === "render") {
    // transparent containers (color carries no geometry; render is a no-op)
    return node.children.flatMap((c) => evalShapes(oc, c, cleanup, warn, useMaxFN));
  }
  if (name === "union" || name === "intersection") {
    // Note: the .csg verb is `intersection`, the boolean kind is `intersect`.
    const kind = name === "union" ? "union" : "intersect";
    const kids = node.children.map((c) => evalShapes(oc, c, cleanup, warn, useMaxFN));
    const all = kids.flat();
    if (all.length === 0) { warn(`${name}() — every child was skipped, nothing to combine`); return []; }
    if (all.length === 1) return all;
    let acc = all[0];
    for (const s of all.slice(1)) {
      const r = booleanOf(oc, kind, acc, s, cleanup);
      if (!r) { warn(`${name}() boolean did not complete (IsDone() false) — keeping operands uncombined`); return all; }
      acc = r;
    }
    return [acc];
  }
  if (name === "difference") {
    if (node.children.length === 0) { warn(`difference() with no children — skipping`); return []; }
    const first = evalShapes(oc, node.children[0], cleanup, warn, useMaxFN);
    const rest = node.children.slice(1).flatMap((c) => evalShapes(oc, c, cleanup, warn, useMaxFN));
    if (first.length === 0) {
      if (rest.length > 0) warn(`difference() — minuend was skipped, dropping ${rest.length} subtrahend solid(s)`);
      return [];
    }
    if (rest.length === 0) return first;
    let acc = first.length === 1 ? first[0] : compoundOf(oc, first, cleanup);
    const tool = rest.length === 1 ? rest[0] : compoundOf(oc, rest, cleanup);
    const r = booleanOf(oc, "subtract", acc, tool, cleanup);
    if (!r) { warn(`difference() boolean did not complete — keeping minuend uncut`); return first; }
    return [r];
  }
  if (name === "multmatrix" || name === "translate" || name === "scale" || name === "mirror" || name === "rotate") {
    const m = nodeMatrix(node, warn);
    const kids = node.children.flatMap((c) => evalShapes(oc, c, cleanup, warn, useMaxFN));
    if (kids.length === 0) return [];
    if (!m) {
      // nodeMatrix already warned. rotate() with bad params keeps children
      // unrotated (documented); every other failure drops them (documented).
      if (name === "rotate") return kids;
      return [];
    }
    return applyMatrix(oc, kids, m, cleanup, warn) ?? [];
  }
  if (name === "cube") return single(oc, buildBox(oc, node, cleanup, warn));
  if (name === "sphere") return single(oc, buildSphere(oc, node, cleanup, warn, useMaxFN));
  if (name === "cylinder") return single(oc, buildCylinder(oc, node, cleanup, warn, useMaxFN));
  if (name === "polyhedron") return single(oc, buildPolyhedron(oc, node, cleanup, warn));

  const skip = SKIP_SUBTREE_MSGS[name];
  if (skip) { warn(`${name}(): ${skip}`); return []; }
  warn(`unknown statement ${name}() — skipping`);
  return [];
}

function single(_oc: Oc, s: Shape | null): Shape[] {
  void _oc;
  return s ? [s] : [];
}

/**
 * Builds the `.csg` base shape: one compound of every root's solids (or a
 * single solid, or an empty compound when nothing built — the blank-model
 * empty-shape guard downstream handles that, same as an empty `.brep`).
 * Parser-level warnings pass through; kernel-level ones append. Never
 * throws on bad geometry (only on a dead kernel) — an empty result with
 * warnings beats a failed open.
 */
export function buildCsgShape(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  oc: any,
  roots: CsgNode[],
  parserWarnings: string[],
  useMaxFN: number,
  cleanup: Cleanup,
  warnings: string[],
): Shape {
  warnings.push(...parserWarnings);
  const warn = (m: string): void => { warnings.push(m); };
  const all: Shape[] = [];
  for (const r of roots) {
    try {
      all.push(...evalShapes(oc, r, cleanup, warn, useMaxFN));
    } catch (e) {
      warn(`${r.name}() subtree threw (${e instanceof Error ? e.message : String(e)}) — skipping`);
    }
  }
  if (all.length === 0) return emptyCompound(oc, cleanup);
  if (all.length === 1) return all[0];
  return compoundOf(oc, all, cleanup);
}
