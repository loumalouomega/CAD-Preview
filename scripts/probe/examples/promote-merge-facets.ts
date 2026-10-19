/** Roadmap "Planar-facet merging before mesh -> B-rep promotion" probe.
 * Run: npm run probe -- scripts/probe/examples/promote-merge-facets.ts --run
 * Diagnostics are JSON on stderr. Exit 0 means the probe completed, not that the gate passed.
 *
 * Builds ONE planar face per coplanar facet (outer loop + hole loops traced from the facet's directed
 * boundary edges) instead of one per triangle, sews them with the same tolerance ladder, and compares with
 * the shipped per-triangle path (`checkMeshHealth`): face count, healed volume, tolerance reached, time.
 *
 * Fixtures (analytic volumes): examples/STL/cube.stl (1000), a 32-sided prism (radius 5, height 10), and a
 * 10 x 10 x 4 plate with a 4 x 4 through-hole (400 - 64 = 336).
 * Gate (set before running): identical volume to 1e-6 relative, a much lower face count, and a time win.
 */
import * as fs from "fs";
import { getOcct } from "../../../src/occtService";
import { checkMeshHealth } from "../../../src/meshHeal";
import { parseToWeldedMesh } from "../../../src/meshParse";
import { volumePropertiesAdaptive } from "../../../src/brepGProp";

console.log = console.error.bind(console);
/** Same ladder as `meshHeal.ts` (not exported there). */
const SEWING_TOLERANCE_LADDER = [1e-6, 1e-5, 1e-4, 1e-3, 1e-2];
type Oc = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Del = { delete(): void };
type V3 = [number, number, number];

function stlAscii(tris: V3[][]): Uint8Array {
  const lines = ["solid probe"];
  for (const [a, b, c] of tris) {
    lines.push("facet normal 0 0 0", "outer loop", ...[a, b, c].map((p) => `vertex ${p[0]} ${p[1]} ${p[2]}`), "endloop", "endfacet");
  }
  lines.push("endsolid probe");
  return new TextEncoder().encode(lines.join("\n"));
}

/** n-sided prism about the z axis, outward winding. */
function prism(n: number, r: number, h: number): V3[][] {
  const ring = (z: number): V3[] => Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n), z] as V3);
  const lo = ring(0), hi = ring(h);
  const tris: V3[][] = [];
  const cLo: V3 = [0, 0, 0], cHi: V3 = [0, 0, h];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tris.push([cLo, lo[j], lo[i]]); // bottom, normal -z
    tris.push([cHi, hi[i], hi[j]]); // top, normal +z
    tris.push([lo[i], lo[j], hi[j]], [lo[i], hi[j], hi[i]]); // side
  }
  return tris;
}

function stlBinary(tris: V3[][]): Uint8Array {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => {
    const o = 84 + i * 50;
    t.forEach((p, k) => p.forEach((c, a) => buf.writeFloatLE(c, o + 12 + k * 12 + a * 4)));
  });
  return new Uint8Array(buf);
}

/** A cube of side 10 whose six faces are each an n x n grid of quads, every quad split in two (12 n^2 triangles). */
function gridCube(n: number): V3[][] {
  const L = 10, tris: V3[][] = [];
  const face = (origin: V3, du: V3, dv: V3): void => {
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const p = (a: number, b: number): V3 => [0, 1, 2].map((k) => origin[k] + (du[k] * a) / n + (dv[k] * b) / n) as V3;
      tris.push([p(i, j), p(i + 1, j), p(i + 1, j + 1)], [p(i, j), p(i + 1, j + 1), p(i, j + 1)]);
    }
  };
  face([0, 0, 0], [0, L, 0], [L, 0, 0]); // -z (outward normal -z)
  face([0, 0, L], [L, 0, 0], [0, L, 0]); // +z
  face([0, 0, 0], [L, 0, 0], [0, 0, L]); // -y
  face([0, L, 0], [0, 0, L], [L, 0, 0]); // +y
  face([0, 0, 0], [0, 0, L], [0, L, 0]); // -x
  face([L, 0, 0], [0, L, 0], [0, 0, L]); // +x
  return tris;
}

/** 10 x 10 x 4 plate (x,y in [0,10], z in [0,4]) with a 4 x 4 through-hole centred at (5,5). */
function plateWithHole(): V3[][] {
  const o = [0, 10], i0 = 3, i1 = 7;
  const quad = (a: V3, b: V3, c: V3, d: V3): V3[][] => [[a, b, c], [a, c, d]];
  const tris: V3[][] = [];
  const outer = (z: number): V3[] => [[0, 0, z], [10, 0, z], [10, 10, z], [0, 10, z]];
  const inner = (z: number): V3[] => [[i0, i0, z], [i1, i0, z], [i1, i1, z], [i0, i1, z]];
  // Annulus between outer and inner squares, as 4 trapezoids (each split in two). Top normal +z (CCW), bottom -z.
  for (let k = 0; k < 4; k++) {
    const k2 = (k + 1) % 4;
    const top = quad(outer(4)[k], outer(4)[k2], inner(4)[k2], inner(4)[k]);
    const bot = quad(outer(0)[k], inner(0)[k], inner(0)[k2], outer(0)[k2]);
    tris.push(...top, ...bot);
    // outer wall (outward) and hole wall (inward, i.e. normal toward the hole axis)
    tris.push(...quad(outer(0)[k], outer(0)[k2], outer(4)[k2], outer(4)[k]));
    tris.push(...quad(inner(0)[k], inner(4)[k], inner(4)[k2], inner(0)[k2]));
  }
  void o;
  return tris;
}

interface Welded { positions: Float32Array; indices: Uint32Array }

function triNormals(m: Welded): V3[] {
  const n: V3[] = [];
  for (let t = 0; t < m.indices.length / 3; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => m.indices[t * 3 + k] * 3);
    const u = [0, 1, 2].map((k) => m.positions[b + k] - m.positions[a + k]);
    const v = [0, 1, 2].map((k) => m.positions[c + k] - m.positions[a + k]);
    const x = u[1] * v[2] - u[2] * v[1], y = u[2] * v[0] - u[0] * v[2], z = u[0] * v[1] - u[1] * v[0];
    const len = Math.hypot(x, y, z) || 1;
    n.push([x / len, y / len, z / len]);
  }
  return n;
}

/** Connected near-coplanar triangle groups: adjacent via a shared edge, within `tolDeg` of the seed normal. */
function segmentFacets(m: Welded, tolDeg: number): number[][] {
  const normals = triNormals(m);
  const cosTol = Math.cos((tolDeg * Math.PI) / 180);
  const triCount = m.indices.length / 3;
  const edgeTris = new Map<string, number[]>();
  const key = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);
  for (let t = 0; t < triCount; t++) for (let k = 0; k < 3; k++) {
    const e = key(m.indices[t * 3 + k], m.indices[t * 3 + ((k + 1) % 3)]);
    const l = edgeTris.get(e); if (l) l.push(t); else edgeTris.set(e, [t]);
  }
  const seen = new Uint8Array(triCount);
  const facets: number[][] = [];
  for (let s = 0; s < triCount; s++) {
    if (seen[s]) continue;
    seen[s] = 1;
    const group = [s], stack = [s];
    const sn = normals[s];
    while (stack.length) {
      const t = stack.pop()!;
      for (let k = 0; k < 3; k++) {
        for (const u of edgeTris.get(key(m.indices[t * 3 + k], m.indices[t * 3 + ((k + 1) % 3)])) ?? []) {
          if (seen[u]) continue;
          const dot = normals[u][0] * sn[0] + normals[u][1] * sn[1] + normals[u][2] * sn[2];
          if (dot < cosTol) continue;
          seen[u] = 1; group.push(u); stack.push(u);
        }
      }
    }
    facets.push(group);
  }
  return facets;
}

/** Closed loops (vertex index lists) of a facet's boundary, traced along the triangles' own directed edges. */
function boundaryLoops(m: Welded, tris: number[]): number[][] {
  const directed = new Map<string, [number, number]>();
  for (const t of tris) for (let k = 0; k < 3; k++) {
    const a = m.indices[t * 3 + k], b = m.indices[t * 3 + ((k + 1) % 3)];
    directed.set(`${a}>${b}`, [a, b]);
  }
  const out = new Map<number, number[]>(); // vertex -> next vertices along boundary edges (no reverse partner)
  for (const [, [a, b]] of directed) if (!directed.has(`${b}>${a}`)) { const l = out.get(a); if (l) l.push(b); else out.set(a, [b]); }
  const loops: number[][] = [];
  const used = new Set<string>();
  for (const [start, nexts] of out) for (const first of nexts) {
    if (used.has(`${start}>${first}`)) continue;
    const loop = [start];
    let a = start, b = first;
    for (;;) {
      used.add(`${a}>${b}`);
      if (b === start) break;
      loop.push(b);
      const cand = (out.get(b) ?? []).find((c) => !used.has(`${b}>${c}`));
      if (cand === undefined) { loop.length = 0; break; }
      a = b; b = cand;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** Signed area of a loop about the facet normal (positive = counter-clockwise seen from the normal). */
function signedArea(m: Welded, loop: number[], n: V3): number {
  let sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i] * 3, q = loop[(i + 1) % loop.length] * 3;
    const px = m.positions[p], py = m.positions[p + 1], pz = m.positions[p + 2];
    const qx = m.positions[q], qy = m.positions[q + 1], qz = m.positions[q + 2];
    sx += py * qz - pz * qy; sy += pz * qx - px * qz; sz += px * qy - py * qx;
  }
  return 0.5 * (sx * n[0] + sy * n[1] + sz * n[2]);
}

function polygonWire(oc: Oc, m: Welded, loop: number[], cleanup: Del[]): any {
  const wm = new oc.BRepBuilderAPI_MakeWire_1(); cleanup.push(wm);
  const pts = loop.map((v) => { const p = new oc.gp_Pnt_3(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]); cleanup.push(p); return p; });
  for (let i = 0; i < pts.length; i++) {
    const e = new oc.BRepBuilderAPI_MakeEdge_3(pts[i], pts[(i + 1) % pts.length]).Edge(); cleanup.push(e);
    wm.Add_1(e);
  }
  const w = wm.Wire(); cleanup.push(w);
  return w;
}

function mergedFace(oc: Oc, m: Welded, tris: number[], normal: V3, cleanup: Del[]): any {
  const loops = boundaryLoops(m, tris).map((loop) => ({ loop, a: signedArea(m, loop, normal) }));
  const outers = loops.filter((l) => l.a > 0).sort((x, y) => y.a - x.a);
  if (outers.length === 0) throw new Error("facet has no outer loop");
  const mk = new oc.BRepBuilderAPI_MakeFace_15(polygonWire(oc, m, outers[0].loop, cleanup), true); cleanup.push(mk);
  for (const h of loops.filter((l) => l.a < 0)) mk.Add(polygonWire(oc, m, h.loop, cleanup));
  const f = mk.Face(); cleanup.push(f);
  return f;
}

async function mergedPromote(oc: Oc, m: Welded, tolDeg: number): Promise<Record<string, unknown>> {
  const cleanup: Del[] = [];
  try {
    const t0 = Date.now();
    const facets = segmentFacets(m, tolDeg);
    const normals = triNormals(m);
    const faces = facets.map((tris) => {
      // Area-weighted normal of the facet.
      let nx = 0, ny = 0, nz = 0;
      for (const t of tris) { nx += normals[t][0]; ny += normals[t][1]; nz += normals[t][2]; }
      const len = Math.hypot(nx, ny, nz) || 1;
      return mergedFace(oc, m, tris, [nx / len, ny / len, nz / len], cleanup);
    });
    for (const tolerance of SEWING_TOLERANCE_LADDER) {
      const sewer = new oc.BRepBuilderAPI_Sewing(tolerance, true, true, true, false); cleanup.push(sewer);
      for (const f of faces) sewer.Add(f);
      sewer.Perform(new oc.Handle_Message_ProgressIndicator_1());
      if (sewer.NbFreeEdges() !== 0) continue;
      const sewed = sewer.SewedShape(); cleanup.push(sewed);
      const exp = new oc.TopExp_Explorer_2(sewed, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); cleanup.push(exp);
      const shell = oc.TopoDS.Shell_1(exp.Current()); cleanup.push(shell);
      const solid = new oc.BRepBuilderAPI_MakeSolid_3(shell).Solid(); cleanup.push(solid);
      const props = new oc.GProp_GProps_1(); cleanup.push(props);
      volumePropertiesAdaptive(oc, solid, props);
      return { tolDeg, facets: facets.length, tolerance, volume: props.Mass(), ms: Date.now() - t0 };
    }
    return { tolDeg, facets: facets.length, closed: false, ms: Date.now() - t0 };
  } catch (e) {
    return { tolDeg, error: String((e as Error)?.message ?? e).slice(0, 200) };
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) { try { cleanup[i].delete(); } catch { /* ignore */ } }
  }
}

async function main(): Promise<void> {
  const oc: Oc = await getOcct(process.cwd());
  const fixtures: Array<{ name: string; bytes: Uint8Array; volume: number }> = [
    { name: "cube.stl", bytes: new Uint8Array(fs.readFileSync("examples/STL/cube.stl")), volume: 1000 },
    { name: "prism32", bytes: stlAscii(prism(32, 5, 10)), volume: 0.5 * 32 * 25 * Math.sin((2 * Math.PI) / 32) * 10 },
    { name: "plate-with-hole", bytes: stlAscii(plateWithHole()), volume: 336 },
    { name: "grid-cube-40 (19 200 triangles)", bytes: stlBinary(gridCube(40)), volume: 1000 },
  ];
  const mergedOnly: Array<{ name: string; bytes: Uint8Array; volume: number }> = [
    { name: "grid-cube-150 (270 000 triangles, above the 50 000 ceiling)", bytes: stlBinary(gridCube(150)), volume: 1000 },
  ];
  const out: unknown[] = [];
  for (const fx of fixtures) {
    const m = parseToWeldedMesh(fx.bytes, "stl");
    const t0 = Date.now();
    const base = await checkMeshHealth(process.cwd(), fx.bytes, "stl").then((r) => ({ triangles: r.components[0].triangleCount, healedVolume: r.components[0].healedVolume, tolerance: r.components[0].requiredTolerance, ms: Date.now() - t0 })).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
    const merged = [];
    // 15 and 30 degrees exceed the 11.25 degree dihedral between the prism's sides: the sides merge into one
    // non-planar "facet", which is where flattening starts to distort volume (or the face cannot be built).
    for (const tol of fx.name === "prism32" ? [0.01, 1, 5, 15, 30] : [0.01, 1, 5]) merged.push(await mergedPromote(oc, m, tol));
    out.push({ fixture: fx.name, analyticVolume: fx.volume, perTriangle: base, merged });
  }
  for (const fx of mergedOnly) {
    const m = parseToWeldedMesh(fx.bytes, "stl");
    out.push({ fixture: fx.name, analyticVolume: fx.volume, triangles: m.indices.length / 3, merged: [await mergedPromote(oc, m, 1)] });
  }
  console.error(JSON.stringify(out, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
