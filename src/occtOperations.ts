import type { EditOp, Vec3, OpOutcome, OutcomeFail, RegionPick } from "./editOps";
import { TOPOLOGY_CHANGING_OPS } from "./editOps";
import type { OpBucket } from "./opBuckets";
import { PRODUCED_ROLE } from "./opBuckets";
// TYPE-ONLY, and that is load-bearing: `entityFacts.ts` imports this module
// at runtime, so a value import here would close a genuine require() cycle in
// the CJS bundle.
import type { SurfaceType, SurfaceParams } from "./entityFacts";
import { enumerateEdges, buildEdgeFaceAdjacency, EDGE_DEFLECTION } from "./edgeEnumeration";
import { volumePropertiesAdaptive } from "./brepGProp";

/** Bucket capacity for `HashCode`-based shape de-dup (shared by face + vertex dedup; edge dedup has its own copy in `edgeEnumeration.ts`). */
const HASH_UPPER = 1 << 30;

export interface GuideCollector { faces: any[]; edges: any[]; vertices: any[]; }

function isGuideHandle(handle: any, collector: GuideCollector | undefined): boolean {
  if (!collector) return false;
  for (const f of collector.faces) if (f.IsSame(handle)) return true;
  for (const e of collector.edges) if (e.IsSame(handle)) return true;
  for (const v of collector.vertices) if (v.IsSame(handle)) return true;
  return false;
}

function resolveMidplane(oc: any, shape: any, ids: [string, string], cleanup: Array<{ delete(): void }>, fail: OutcomeFail): { point: Vec3; normal: Vec3 } | null {
  const faces = collectFaces(oc, shape, cleanup);
  const a = faces[faceIndex(ids[0])];
  const b = faces[faceIndex(ids[1])];
  if (!a || !b) { fail(`midplane face ${!a ? ids[0] : ids[1]} does not resolve`); return null; }
  const pa = facePlane(oc, a, cleanup);
  const pb = facePlane(oc, b, cleanup);
  if (!pa || !pb) { fail(`midplane requires two planar faces — ${!pa ? ids[0] : ids[1]} is not planar`); return null; }
  const dot = pa.nl[0]*pb.nl[0]+pa.nl[1]*pb.nl[1]+pa.nl[2]*pb.nl[2];
  if (Math.abs(Math.abs(dot) - 1) > 1e-6) { fail(`midplane requires parallel planes — ${ids[0]} and ${ids[1]} are not parallel`); return null; }
  const nb: Vec3 = dot < 0 ? [-pb.nl[0], -pb.nl[1], -pb.nl[2]] : pb.nl;
  const n: Vec3 = pa.nl;
  const da = pa.pt[0]*n[0]+pa.pt[1]*n[1]+pa.pt[2]*n[2];
  const db = pb.pt[0]*n[0]+pb.pt[1]*n[1]+pb.pt[2]*n[2];
  const midD = (da + db) / 2;
  const point: Vec3 = [pa.pt[0] + n[0]*(midD - da), pa.pt[1] + n[1]*(midD - da), pa.pt[2] + n[2]*(midD - da)];
  return { point, normal: n };
}

function edgeDirection(oc: any, edge: any, cleanup: Array<{ delete(): void }>): Vec3 | null {
  try {
    const vExp = new oc.TopExp_Explorer_2(edge, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_VERTEX);
    cleanup.push(vExp);
    const pts: any[] = [];
    for (; vExp.More(); vExp.Next()) pts.push(oc.TopoDS.Vertex_1(vExp.Current()));
    if (pts.length < 2) return null;
    const p1 = oc.BRep_Tool.Pnt(pts[0]);
    const p2 = oc.BRep_Tool.Pnt(pts[pts.length - 1]);
    const d: Vec3 = [p2.X()-p1.X(), p2.Y()-p1.Y(), p2.Z()-p1.Z()];
    const len = Math.hypot(d[0],d[1],d[2]);
    return len < 1e-9 ? null : [d[0]/len, d[1]/len, d[2]/len];
  } catch { return null; }
}

function edgeMidpoint(oc: any, edge: any, cleanup: Array<{ delete(): void }>): Vec3 | null {
  try {
    const vExp = new oc.TopExp_Explorer_2(edge, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_VERTEX);
    cleanup.push(vExp);
    const pts: any[] = [];
    for (; vExp.More(); vExp.Next()) pts.push(oc.TopoDS.Vertex_1(vExp.Current()));
    if (pts.length < 2) return null;
    const p1 = oc.BRep_Tool.Pnt(pts[0]);
    const p2 = oc.BRep_Tool.Pnt(pts[pts.length - 1]);
    return [(p1.X()+p2.X())/2,(p1.Y()+p2.Y())/2,(p1.Z()+p2.Z())/2];
  } catch { return null; }
}

function resolveMidaxis(oc: any, shape: any, ids: [string, string], cleanup: Array<{ delete(): void }>, fail: OutcomeFail): { point: Vec3; dir: Vec3 } | null {
  function faceAxis(id: string): { loc: Vec3; dir: Vec3 } | null {
    const faces = collectFaces(oc, shape, cleanup);
    const f = faces[faceIndex(id)];
    if (!f) return null;
    const info = faceSurfaceInfo(oc, f, cleanup);
    if (info.params?.kind !== "cylinder") return null;
    return { loc: (info.params as any).axisLocation, dir: (info.params as any).axisDirection };
  }
  function edgeAxis(id: string): { loc: Vec3; dir: Vec3 } | null {
    const edges = collectEdges(oc, shape, cleanup);
    const idx = edgeIndex(id);
    const e = edges[idx];
    if (!e) return null;
    const d = edgeDirection(oc, e, cleanup);
    const m = edgeMidpoint(oc, e, cleanup);
    return d && m ? { loc: m, dir: d } : null;
  }
  const isFaceA = ids[0].startsWith("face-");
  const isFaceB = ids[1].startsWith("face-");
  if (isFaceA !== isFaceB) { fail(`midaxis requires two faces or two edges — got ${ids[0]} and ${ids[1]}`); return null; }
  let a: { loc: Vec3; dir: Vec3 } | null;
  let b: { loc: Vec3; dir: Vec3 } | null;
  if (isFaceA) { a = faceAxis(ids[0]); b = faceAxis(ids[1]); if (!a) { fail(`midaxis: ${ids[0]} is not a cylindrical face`); return null; } if (!b) { fail(`midaxis: ${ids[1]} is not a cylindrical face`); return null; } }
  else { a = edgeAxis(ids[0]); b = edgeAxis(ids[1]); if (!a) { fail(`midaxis: ${ids[0]} does not resolve to a straight edge`); return null; } if (!b) { fail(`midaxis: ${ids[1]} does not resolve to a straight edge`); return null; } }
  const dot = a.dir[0]*b.dir[0]+a.dir[1]*b.dir[1]+a.dir[2]*b.dir[2];
  if (Math.abs(Math.abs(dot) - 1) > 1e-6) { fail(`midaxis requires parallel axes — ${ids[0]} and ${ids[1]} are not parallel`); return null; }
  const nbDir: Vec3 = dot < 0 ? [-b.dir[0],-b.dir[1],-b.dir[2]] : b.dir;
  const midLoc: Vec3 = [(a.loc[0]+b.loc[0])/2,(a.loc[1]+b.loc[1])/2,(a.loc[2]+b.loc[2])/2];
  const dir: Vec3 = [a.dir[0]+nbDir[0], a.dir[1]+nbDir[1], a.dir[2]+nbDir[2]];
  const len = Math.hypot(dir[0],dir[1],dir[2]);
  if (len < 1e-12) { fail(`midaxis axes are antiparallel and cancel`); return null; }
  return { point: midLoc, dir: [dir[0]/len, dir[1]/len, dir[2]/len] };
}

export function collectGuideIds(oc: any, shape: any, collector: GuideCollector, cleanup: Array<{ delete(): void }>): string[] {
  const ids: string[] = [];
  if (collector.faces.length > 0) {
    const faces = collectFaces(oc, shape, cleanup);
    for (let i = 0; i < faces.length; i++) for (const gf of collector.faces) if (gf.IsSame(faces[i])) { ids.push(`face-${i}`); break; }
  }
  if (collector.edges.length > 0) {
    const edges = collectEdges(oc, shape, cleanup);
    for (let i = 0; i < edges.length; i++) for (const ge of collector.edges) if (ge.IsSame(edges[i])) { ids.push(`edge-${i}`); break; }
  }
  if (collector.vertices.length > 0) {
    const vertices = collectVertices(oc, shape, cleanup);
    for (let i = 0; i < vertices.length; i++) for (const gv of collector.vertices) if (gv.IsSame(vertices[i])) { ids.push(`point-${i}`); break; }
  }
  return ids;
}

/**
 * Host-side (OCCT) edit engine. Folds the replayable op-list over a freshly-read
 * base `TopoDS_Shape`, returning the edited shape to tessellate + display +
 * export. The webview never sees OCCT — it only receives the re-tessellated
 * geometry, exactly as for an unedited B-rep file.
 *
 * Memory discipline (the project's top bug source): every wrapped OCCT handle
 * created while applying an op is pushed into `cleanup` and `.delete()`d in
 * reverse order by the caller's `try/finally`. The *returned* shape must NOT be
 * deleted here — its lifetime belongs to the caller, which tessellates it and
 * then frees it alongside everything in `cleanup`.
 *
 * OCCT transform API, verified against the live WASM (see CLAUDE.md):
 *   translate → `gp_Trsf.SetTranslation_1(gp_Vec_4)`
 *   rotate    → `gp_Trsf.SetRotation_1(gp_Ax1_2(pnt, dir), angleRad)`
 *   mirror    → `gp_Trsf.SetMirror_3(gp_Ax2_3(pnt, normal))`  (plane mirror)
 *   uniform scale     → `gp_Trsf.SetScale(gp_Pnt_3(center), s)`
 *   non-uniform scale → `gp_GTrsf.SetValue(r, c, v)` (1-based 3×4) + `BRepBuilderAPI_GTransform_2`
 * applied via `BRepBuilderAPI_Transform_2(shape, trsf, true).Shape()`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyEditsBRep(oc: any, baseShape: any, ops: EditOp[], cleanup: Array<{ delete(): void }>, outcomes?: OpOutcome[], guideCollector?: GuideCollector, opBuckets?: OpBucket[]): any {
  let shape = baseShape;
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    const before = shape;
    const outcome: OpOutcome = { index, kind: op.op, applied: true };
    // First `fail` call wins for this op; every helper calls it immediately
    // before returning the unmodified shape at a skip site.
    const fail: OutcomeFail = (diagnostic, hint) => {
      if (!outcome.applied) return;
      outcome.applied = false;
      outcome.diagnostic = diagnostic;
      if (hint) outcome.hint = hint;
    };
    try {
      shape = applyOneOp(oc, shape, op, cleanup, fail, guideCollector);
    } catch (err) {
      // A helper's own builder throws are caught internally; reaching here is
      // an unexpected fault. Record it, then re-throw to preserve the existing
      // "a hard kernel error fails the whole load" behavior.
      fail(`threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
      outcomes?.push(outcome);
      throw err;
    }
    // Every helper signals a skip by returning the SAME shape handle (its own
    // documented convention), so identity is the universal backstop for any
    // skip site without its own `fail` reason yet.
    if (outcome.applied && shape === before) {
      fail("returned the model unchanged");
    }
    if (opBuckets !== undefined && outcome.applied && shape !== before && TOPOLOGY_CHANGING_OPS.has(op.op)) {
      const bucket = collectBucketForOp(oc, before, shape, index, op);
      if (bucket) opBuckets.push(bucket);
    }
    outcomes?.push(outcome);
  }
  return shape;
}

/** How many wires bound `face` — 1 for a plain face, 2+ once it has holes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wireCountOf(oc: any, face: any, cleanup: Array<{ delete(): void }>): number {
  let n = 0;
  const exp = new oc.TopExp_Explorer_2(face, oc.TopAbs_ShapeEnum.TopAbs_WIRE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  cleanup.push(exp);
  for (; exp.More(); exp.Next()) n++;
  return n;
}

/**
 * Classifies one just-applied topology-changing op's produced faces into an
 * {@link OpBucket} — the OCCT half of `opBuckets.ts`. Mechanism: a
 * before/after face-set diff (`HashCode` bucket + `IsSame`, the established
 * dedup technique) finds the NEW faces; per-kind knowledge names them.
 *
 * The `TOPOLOGY_CHANGING_OPS` gate in {@link applyEditsBRep} is load-bearing
 * for correctness, not just cost: rigid transforms (`translate`/`rotate`/…)
 * run `BRepBuilderAPI_Transform_2(..., copy=true)`, which creates genuinely
 * new TShapes — a diff across one would report EVERY face as "produced".
 *
 * Role semantics, per kind (all verified against the live WASM):
 * - `extrude` and `revolve` get a `startCap` role: `BRepPrimAPI_MakePrism_1`/
 *   `MakeRevol_1`'s `Copy=false` reuses the profile face object as the start
 *   cap (probe-confirmed `IsSame` hit for both), so the profile face's id in
 *   the AFTER enumeration is recorded. With `Copy=false` that face is the
 *   SAME TShape as the operand it came from, so it can appear at two
 *   enumeration positions (its original body's and the new solid's) — the
 *   first match wins; both ids resolve to the same live face.
 * - `extrude` additionally splits its produced set geometrically: `endCap`
 *   is the produced face farthest along the extrusion direction (probe: the
 *   cap centre sits at the profile plane + length), everything else `side`.
 * - Every other kind names its whole produced set from `PRODUCED_ROLE`
 *   (`band`/`inner`/`wall`/`cutFace`/`sectionFace`/`copies`/`body`), or the
 *   generic `produced` when the table has no entry. **`band` (fillet/chamfer/
 *   draft) and the boolean/rebuild roles include REBUILT faces, not just
 *   genuinely-new ones** — probe-verified: filleting one box edge reports 5
 *   faces (1 new cylinder + 4 rebuilt adjacent planes), because rebuilding a
 *   shrunken face creates a new TShape the diff correctly catches. Those
 *   rebuilt faces drift positionally exactly like new ones, so recording them
 *   is the point; the role name is the op's dominant effect, not a claim
 *   that every listed face is brand-new.
 * - An op whose diff finds no new faces (e.g. `addPoint` — a vertex, no
 *   faces) produces no bucket at all. Face-only: wireframe ops
 *   (`addLine`/`addArc`/…) record nothing in Phase 1.
 *
 * Recorded ids are the AFTER enumeration's `face-N` positions — i.e. valid
 * against the model state at this op's own step, not necessarily against the
 * final shape (later ops renumber). That is the documented Phase 1 contract;
 * re-resolution against a newer shape is prefix-replay work (Phase 2).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectBucketForOp(oc: any, before: any, after: any, index: number, op: EditOp): OpBucket | null {
  const tmp: Array<{ delete(): void }> = [];
  try {
    const beforeFaces = collectFaces(oc, before, tmp);
    const afterFaces = collectFaces(oc, after, tmp);
    const beforeBuckets = new Map<number, any[]>();
    for (const f of beforeFaces) {
      const h = f.HashCode(HASH_UPPER);
      let b = beforeBuckets.get(h);
      if (!b) { b = []; beforeBuckets.set(h, b); }
      b.push(f);
    }
    // Produced = after faces with no `IsSame` partner in before. `startCap`
    // is the inverse: a before face (the extrude's profile) still present in
    // after — only ever consulted for extrude below.
    const producedIdx: number[] = [];
    for (let i = 0; i < afterFaces.length; i++) {
      const f = afterFaces[i];
      const h = f.HashCode(HASH_UPPER);
      const bucket = beforeBuckets.get(h);
      let found = false;
      if (bucket) for (const bf of bucket) if (bf.IsSame(f)) { found = true; break; }
      if (!found) producedIdx.push(i);
    }
    const kind = op.op;
    const roles: Record<string, string[]> = {};
    const isThin = thinSpecOf(op) !== null;
    if (kind === "extrude" || kind === "revolve") {
      // A PLAIN extrude/revolve reuses the profile face itself as the start cap
      // (`Copy=false`), so finding it in `after` identifies that cap. A THIN one
      // consumes a freshly built band face instead and leaves the profile
      // sketch behind as a free face — so this match would label the leftover
      // sketch `startCap` even though it is not part of the new solid at all.
      // `profile` is optional since the wire-operand form shipped; an
      // edge-set profile has no face to match, so this branch is skipped.
      const profileId = (op as { profile?: string }).profile;
      const profileFace = isThin || profileId === undefined ? null : collectFaces(oc, before, tmp)[faceIndex(profileId)];
      if (profileFace) {
        for (let i = 0; i < afterFaces.length; i++) {
          if (afterFaces[i].IsSame(profileFace)) { roles.startCap = [`face-${i}`]; break; }
        }
      }
      if (kind === "extrude") {
        const [dx, dy, dz] = (op as { dir: Vec3 }).dir;
        const len = Math.hypot(dx, dy, dz) || 1;
        let bestIdx = -1;
        let bestDot = -Infinity;
        let firstIdx = -1;
        let firstDot = Infinity;
        const remaining: number[] = [];
        for (const i of producedIdx) {
          const c = bboxCenter(oc, afterFaces[i], tmp);
          const dot = (c[0] * dx + c[1] * dy + c[2] * dz) / len;
          if (dot > bestDot) { bestDot = dot; bestIdx = i; }
          // Only ANNULAR faces can be a thin extrude's caps, and requiring that
          // is load-bearing rather than tidy: a thin extrude does not consume
          // its profile sketch (see below), so the leftover sketch sits exactly
          // on top of the start cap with an identical bbox. A min-dot rule
          // alone ties between them and picked the sketch — verified. The caps
          // are the only produced faces with an inner wire.
          if (isThin && dot < firstDot && wireCountOf(oc, afterFaces[i], tmp) > 1) { firstDot = dot; firstIdx = i; }
        }
        // A THIN extrude's start cap is a band face built fresh for this op, so
        // it does not exist in `before` and the `IsSame(profileFace)` match
        // above cannot find it. Recover it as the annular produced face
        // furthest BACK along `dir` — the mirror of the `endCap` max-dot rule —
        // otherwise the start annulus is silently misfiled under `side`.
        let thinStartIdx = -1;
        if (!roles.startCap && isThin && firstIdx >= 0 && firstIdx !== bestIdx) {
          roles.startCap = [`face-${firstIdx}`];
          thinStartIdx = firstIdx;
        }
        for (const i of producedIdx) if (i !== bestIdx && i !== thinStartIdx) remaining.push(i);
        if (bestIdx >= 0) roles.endCap = [`face-${bestIdx}`];
        if (remaining.length > 0) roles.side = remaining.map((i) => `face-${i}`);
      } else if (producedIdx.length > 0) {
        roles.produced = producedIdx.map((i) => `face-${i}`);
      }
    } else {
      const role = PRODUCED_ROLE[kind] ?? "produced";
      if (producedIdx.length > 0) roles[role] = producedIdx.map((i) => `face-${i}`);
    }
    if (Object.keys(roles).length === 0) return null;
    return { op: index, kind, roles };
  } finally {
    // Enumerated handles are `TopoDS.Face_1` wrappers around live sub-shapes
    // — deleting the wrappers (never the shapes themselves) right after
    // correlation is the established `guideTmp` pattern (see occtService.ts).
    for (let i = tmp.length - 1; i >= 0; i--) { try { tmp[i].delete(); } catch { /* ignore */ } }
  }
}

/** A function that returns a transformed copy of the shape/solid it is given. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Transformer = (s: any) => any;

/**
 * Applies a single op to `shape`, returning the resulting shape (possibly the
 * same handle when the op is a no-op). Unimplemented ops are skipped so a sidecar
 * authored against a newer build never hard-fails an older one. A skip calls
 * `fail` with a reason (see {@link OpOutcome}) before returning.
 * Exported for `opQueryResolve.ts`'s interleaved resolution fold — the one
 * external consumer; the main replay path stays inside this file.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyOneOp(oc: any, shape: any, op: EditOp, cleanup: Array<{ delete(): void }>, fail: OutcomeFail, guideCollector?: GuideCollector): any {
  switch (op.op) {
    case "translate":
    case "rotate":
    case "scale":
    case "mirror": {
      const transform = makeTransformer(oc, op as any, cleanup, shape, fail);
      return transform ? transformSolids(oc, shape, (op as any).targets, transform, cleanup, fail) : shape;
    }
    case "boolean":
      return booleanSolids(oc, shape, op, cleanup, fail);
    case "fillet":
    case "chamfer":
      return filletEdges(oc, shape, op, cleanup, fail);
    case "extrude":
    case "revolve":
    case "sweep":
    case "loft":
    case "rib":
    case "wrap":
      return featureModel(oc, shape, op, cleanup, fail, guideCollector);
    case "explode":
      return explodeSolids(oc, shape, op.factor, cleanup, fail);
    case "mate":
      return mateShape(oc, shape, op, cleanup, fail);
    case "shell":
      return shellSolids(oc, shape, op, cleanup, fail);
    case "draft":
      return draftFaces(oc, shape, op, cleanup, fail);
    case "splitByPlane":
      return splitSolidsByPlane(oc, shape, op as any, cleanup, fail);
    case "section":
      return sectionSolids(oc, shape, op as any, cleanup, fail);
    case "addBox":
    case "addSphere":
    case "addCylinder":
    case "addCone":
    case "addTorus":
    case "addPrism":
    case "addWedge":
      return addPrimitive(oc, shape, op, cleanup, fail);
    case "addHole":
    case "addCounterboreHole":
    case "addCountersinkHole":
      return cutHole(oc, shape, op, cleanup, fail);
    case "drill":
      return drillCut(oc, shape, op, cleanup, fail);
    case "addCircleProfile":
    case "addRectangleProfile":
    case "addPolygonProfile":
    case "addEllipseProfile":
    case "addRoundedRectangleProfile":
    case "addSlotProfile":
    case "addTrapezoidProfile":
      return addProfile(oc, shape, op, cleanup, fail, guideCollector);
    case "addEdgeSlot":
      return addEdgeSlot(oc, shape, op, cleanup, fail);
    case "addPoint":
    case "addLine":
    case "addArc":
    case "addPolyline":
    case "addThreePointArc":
    case "addSpline":
    case "addBezier":
    case "addEllipseArc":
    case "addHelix":
      return addWireframePrimitive(oc, shape, op, cleanup, fail, guideCollector);
    case "addSurfaceFromLines":
      return addSurfaceFromLines(oc, shape, op, cleanup, fail, guideCollector);
    case "addVolumeFromSurfaces":
      return addVolumeFromSurfaces(oc, shape, op, cleanup, fail, guideCollector);
    case "align":
      return alignSolids(oc, shape, op, cleanup, fail);
    case "patternLinear":
      return patternLinear(oc, shape, op, cleanup, fail);
    case "patternCircular":
      return patternCircular(oc, shape, op as any, cleanup, fail);
    default:
      // Exhaustive over the current union — reachable only against a sidecar
      // authored on a NEWER build (the tolerant-replay case this guards).
      fail(`op kind "${(op as { op: string }).op}" is not implemented in this build`);
      return shape;
  }
}

/** Builds the geometric transformer for a transform op, or null if unsupported. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeTransformer(oc: any, op: EditOp, cleanup: Array<{ delete(): void }>, shape?: any, fail?: OutcomeFail): Transformer | null {
  const push = <T extends { delete(): void }>(o: T): T => (cleanup.push(o), o);

  switch (op.op) {
    case "translate": {
      const t = push(new oc.gp_Trsf_1());
      t.SetTranslation_1(push(vec(oc, (op as any).vec)));
      return rigid(oc, t, cleanup);
    }
    case "rotate": {
      const t = push(new oc.gp_Trsf_1());
      const ax = push(new oc.gp_Ax1_2(push(pnt(oc, (op as any).axisPoint)), push(dir(oc, (op as any).axisDir))));
      t.SetRotation_1(ax, ((op as any).angleDeg * Math.PI) / 180);
      return rigid(oc, t, cleanup);
    }
    case "mirror": {
      let pt: Vec3 | null = null;
      let nl: Vec3 | null = null;
      const mop = op as any;
      if (mop.midplaneFaces) {
        if (!shape || !fail) return null;
        const mid = resolveMidplane(oc, shape, mop.midplaneFaces, cleanup, fail);
        if (!mid) return null;
        pt = mid.point; nl = mid.normal;
      } else { pt = mop.planePoint; nl = mop.planeNormal; }
      if (!pt || !nl) return null;
      const t = push(new oc.gp_Trsf_1());
      const ax2 = push(new oc.gp_Ax2_3(push(pnt(oc, pt)), push(dir(oc, nl))));
      t.SetMirror_3(ax2);
      return rigid(oc, t, cleanup);
    }
    case "scale": {
      const [sx, sy, sz] = op.factors;
      if (sx === sy && sy === sz) {
        const t = push(new oc.gp_Trsf_1());
        t.SetScale(push(pnt(oc, op.center)), sx);
        return rigid(oc, t, cleanup);
      }
      // Non-uniform scale about `center`: x' = s·x + (c − s·c). `gp_GTrsf` is a
      // general 3×4 affine, applied with BRepBuilderAPI_GTransform.
      const g = push(new oc.gp_GTrsf_1());
      const [cx, cy, cz] = op.center;
      g.SetValue(1, 1, sx); g.SetValue(2, 2, sy); g.SetValue(3, 3, sz);
      g.SetValue(1, 4, cx - sx * cx);
      g.SetValue(2, 4, cy - sy * cy);
      g.SetValue(3, 4, cz - sz * cz);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (s: any) => {
        const b = push(new oc.BRepBuilderAPI_GTransform_2(s, g, true));
        return push(b.Shape());
      };
    }
    default:
      return null;
  }
}

/**
 * Uniformly scales `shape` about the origin by `factor` — the geometric half
 * of "unit conversion on export" (`src/occtService.ts`'s `exportBRep`), reusing
 * the exact verified `gp_Trsf.SetScale` + `BRepBuilderAPI_Transform` call
 * shape the `"scale"` edit op above already uses. Scaling about the origin
 * (not the shape's centroid, and not exposed as a per-op `center` the way the
 * edit op is) is deliberate: unit conversion means "multiply every coordinate
 * by this factor," not "resize the shape around some point" — scaling about
 * any other point would also translate the shape.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function scaleShapeForExport(oc: any, shape: any, factor: number, cleanup: Array<{ delete(): void }>): any {
  const push = <T extends { delete(): void }>(o: T): T => (cleanup.push(o), o);
  const t = push(new oc.gp_Trsf_1());
  t.SetScale(push(new oc.gp_Pnt_3(0, 0, 0)), factor);
  return rigid(oc, t, cleanup)(shape);
}

/** Wraps a `gp_Trsf` into a transformer via `BRepBuilderAPI_Transform`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rigid(oc: any, trsf: any, cleanup: Array<{ delete(): void }>): Transformer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (s: any) => {
    const b = new oc.BRepBuilderAPI_Transform_2(s, trsf, true);
    cleanup.push(b);
    const r = b.Shape();
    cleanup.push(r);
    return r;
  };
}

/**
 * Applies `transform` to just the targeted solids, identified by the same
 * deterministic `solid-N` explorer order the read pipeline uses. When every
 * solid is targeted (or the shape has no solids, i.e. a single `solid-0`
 * surface model) the whole shape is transformed directly; otherwise a new
 * compound is assembled from the transformed targets plus the untouched rest.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transformSolids(oc: any, shape: any, targets: string[], transform: Transformer, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const want = new Set(targets);
  const solids = collectSolids(oc, shape, cleanup);

  if (solids.length === 0) {
    if (want.has("solid-0")) return transform(shape);
    fail?.(`none of the target ids (${[...want].join(", ")}) resolve — the model has no solids`);
    return shape;
  }
  if (solids.every((s) => want.has(s.id))) {
    return transform(shape);
  }
  const targeted = solids.filter((s) => want.has(s.id));
  if (targeted.length === 0) {
    fail?.(
      `none of the target ids (${[...want].join(", ")}) resolve to a solid`,
      "re-check solid-N ids after topology-changing ops — load_model re-lists them"
    );
    return shape;
  }

  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  for (const { id, solid } of solids) {
    builder.Add(comp, want.has(id) ? transform(solid) : solid);
  }
  return comp;
}

const AXIS_INDEX: Record<"x" | "y" | "z", 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

/**
 * Translates each targeted solid along `op.axis` so its OWN bbox `op.extent`
 * (min/center/max) lands at the absolute coordinate `op.to`. Deliberately
 * ALWAYS aligns every targeted solid independently — unlike `transformSolids`
 * above, there is no "transform the whole shape as one unit" fast path even
 * when every solid is targeted, since that would use the COMBINED bbox
 * extent of all solids together rather than each solid's own extent,
 * silently changing behavior based on how many solids happen to be
 * selected. A solid already at the target coordinate (`|delta| < 1e-9`) is
 * left untouched rather than producing a wasted zero-length transform.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function alignSolids(oc: any, shape: any, op: Extract<EditOp, { op: "align" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const solids = collectSolids(oc, shape, cleanup);
  const want = new Set(op.targets);
  const idx = AXIS_INDEX[op.axis];
  let moved = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const alignOne = (s: any): any => {
    const ext = bboxExtent(oc, s, cleanup);
    const current = op.extent === "min" ? ext.min[idx] : op.extent === "max" ? ext.max[idx] : (ext.min[idx] + ext.max[idx]) / 2;
    const delta = op.to - current;
    if (Math.abs(delta) < 1e-9) return s;
    moved++;
    const v: Vec3 = [0, 0, 0];
    v[idx] = delta;
    const t = new oc.gp_Trsf_1();
    cleanup.push(t);
    t.SetTranslation_1(vec(oc, v));
    return rigid(oc, t, cleanup)(s);
  };

  if (solids.length === 0) {
    if (want.has("solid-0")) return alignOne(shape);
    fail?.(`none of the target ids (${[...want].join(", ")}) resolve — the model has no solids`);
    return shape;
  }
  if (!solids.some((s) => want.has(s.id))) {
    fail?.(
      `none of the target ids (${[...want].join(", ")}) resolve to a solid`,
      "re-check solid-N ids after topology-changing ops — load_model re-lists them"
    );
    return shape;
  }

  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  for (const { id, solid } of solids) {
    builder.Add(comp, want.has(id) ? alignOne(solid) : solid);
  }
  if (moved === 0) {
    // Every targeted solid was already at the requested coordinate.
    fail?.(`all targeted solids are already ${op.extent}-aligned to ${op.to} on ${op.axis}`);
  }
  return comp;
}

/**
 * Shared linear/circular-pattern assembly: keeps every targeted solid in
 * place AND appends `count - 1` additional copies (`copyAt(solid, k)` for
 * k = 1..count-1) alongside the untouched rest — a hybrid of
 * `transformSolids`'s "resolve targets" and `addPrimitive`'s "compound
 * (existing + new)" append, since pattern is the one op family that needs
 * both at once (every other transform op replaces a target in place; every
 * other append op has no pre-existing target to keep).
 */
function patternSolids(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  oc: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shape: any,
  targets: string[],
  count: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  copyAt: (solid: any, k: number) => any,
  cleanup: Array<{ delete(): void }>,
  fail?: OutcomeFail
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const solids = collectSolids(oc, shape, cleanup);
  const want = new Set(targets);

  if (count < 2) {
    fail?.(`count is ${count} — a pattern's count INCLUDES the original, so fewer than 2 instances adds no copies`);
    return shape;
  }

  if (solids.length === 0) {
    if (!want.has("solid-0")) {
      fail?.(`none of the target ids (${[...want].join(", ")}) resolve — the model has no solids`);
      return shape;
    }
    const comp = new oc.TopoDS_Compound();
    cleanup.push(comp);
    const builder = new oc.BRep_Builder();
    cleanup.push(builder);
    builder.MakeCompound(comp);
    builder.Add(comp, shape);
    for (let k = 1; k < count; k++) builder.Add(comp, copyAt(shape, k));
    return comp;
  }

  const targeted = solids.filter((s) => want.has(s.id));
  if (targeted.length === 0) {
    fail?.(
      `none of the target ids (${[...want].join(", ")}) resolve to a solid`,
      "re-check solid-N ids after topology-changing ops — load_model re-lists them"
    );
    return shape;
  }

  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  for (const { id, solid } of solids) {
    if (!want.has(id)) {
      builder.Add(comp, solid);
      continue;
    }
    builder.Add(comp, solid); // original, kept in place
    for (let k = 1; k < count; k++) builder.Add(comp, copyAt(solid, k));
  }
  return comp;
}

/** Linear array: `op.count` total instances (the original plus `count - 1` new
 * copies), each `op.spacing` further along the normalized `op.direction`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function patternLinear(oc: any, shape: any, op: Extract<EditOp, { op: "patternLinear" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const [dx, dy, dz] = op.direction;
  const len = Math.hypot(dx, dy, dz);
  const unit: Vec3 = [dx / len, dy / len, dz / len];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const copyAt = (s: any, k: number): any => {
    const v: Vec3 = [unit[0] * op.spacing * k, unit[1] * op.spacing * k, unit[2] * op.spacing * k];
    const t = new oc.gp_Trsf_1();
    cleanup.push(t);
    t.SetTranslation_1(vec(oc, v));
    return rigid(oc, t, cleanup)(s);
  };
  return patternSolids(oc, shape, op.targets, op.count, copyAt, cleanup, fail);
}

/** Circular array: `op.count` total instances (the original plus `count - 1`
 * new copies), each a further `op.angleDeg` rotated about the axis through
 * `op.axisPoint` along `op.axisDir`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function patternCircular(oc: any, shape: any, op: Extract<EditOp, { op: "patternCircular" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  let axisPoint: Vec3 = (op as any).axisPoint;
  let axisDir: Vec3 = (op as any).axisDir;
  if ((op as any).midaxisOf) {
    const mid = resolveMidaxis(oc, shape, (op as any).midaxisOf, cleanup, fail!);
    if (!mid) return shape;
    axisPoint = mid.point; axisDir = mid.dir;
  }
  if (!axisPoint || !axisDir) { fail?.(`patternCircular axis not specified`); return shape; }
  const angleRad = (op.angleDeg * Math.PI) / 180;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const copyAt = (s: any, k: number): any => {
    const t = new oc.gp_Trsf_1();
    cleanup.push(t);
    const ax = new oc.gp_Ax1_2(pnt(oc, axisPoint), dir(oc, axisDir));
    cleanup.push(ax);
    t.SetRotation_1(ax, angleRad * k);
    return rigid(oc, t, cleanup)(s);
  };
  return patternSolids(oc, shape, op.targets, op.count, copyAt, cleanup, fail);
}

/**
 * Combines two solid sets with a boolean operator, identified by the same stable
 * `solid-N` ids. Operand shapes are built from the selected solids (a compound
 * when more than one); the operands are removed from the model and replaced by the
 * single boolean result, with all untargeted solids preserved.
 *
 * OCCT boolean API, verified against the live WASM (see CLAUDE.md): the useful
 * overload is the `_3` constructor `new BRepAlgoAPI_{Fuse,Cut,Common}_3(s1, s2)`
 * (its 3rd `Message_ProgressRange` arg is optional and not constructible in this
 * build) → `.Shape()`. A boolean whose operands don't resolve, or that doesn't
 * complete (`IsDone()` false), is skipped so replay never hard-fails.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function booleanSolids(oc: any, shape: any, op: Extract<EditOp, { op: "boolean" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const solids = collectSolids(oc, shape, cleanup);
  const byId = new Map(solids.map((s) => [s.id, s.solid]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aShapes = op.a.map((id) => byId.get(id)).filter((s): s is any => s != null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bShapes = op.b.map((id) => byId.get(id)).filter((s): s is any => s != null);
  if (aShapes.length === 0 || bShapes.length === 0) {
    fail?.(
      `operand ${aShapes.length === 0 ? "A" : "B"} ids (${(aShapes.length === 0 ? op.a : op.b).join(", ")}) did not resolve to solids`,
      "re-check solid-N ids after topology-changing ops — load_model re-lists them"
    );
    return shape;
  }

  const a = combineSolids(oc, aShapes, cleanup);
  const b = combineSolids(oc, bShapes, cleanup);
  const Ctor =
    op.kind === "union" ? oc.BRepAlgoAPI_Fuse_3
      : op.kind === "subtract" ? oc.BRepAlgoAPI_Cut_3
        : oc.BRepAlgoAPI_Common_3;
  const algo = new Ctor(a, b);
  cleanup.push(algo);
  if (!algo.IsDone()) {
    fail?.(`the ${op.kind} boolean did not complete (IsDone() false)`, "operands may not intersect or may be degenerate");
    return shape;
  }
  const result = algo.Shape();
  cleanup.push(result);

  // Preserve solids not consumed by either operand.
  const used = new Set([...op.a, ...op.b]);
  const leftovers = solids.filter((s) => !used.has(s.id)).map((s) => s.solid);
  if (leftovers.length === 0) return result;

  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  builder.Add(comp, result);
  for (const s of leftovers) builder.Add(comp, s);
  return comp;
}

/**
 * Cuts a hole (plain / counterbored / countersunk) into the target solids: the
 * tool solid — a cylinder, optionally fused (`BRepAlgoAPI_Fuse_3`) with a wider
 * mouth cylinder (counterbore) or a mouth cone (countersink) — is subtracted
 * via the already-verified `BRepAlgoAPI_Cut_3`, and the result replaces the
 * targets in a rebuilt compound alongside the untargeted solids (the exact
 * {@link booleanSolids} skeleton). Unresolved targets / a failed tool build /
 * `IsDone()` false all skip gracefully.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cutHole(oc: any, shape: any, op: Extract<EditOp, { op: "addHole" | "addCounterboreHole" | "addCountersinkHole" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const solids = collectSolids(oc, shape, cleanup);
  const byId = new Map(solids.map((s) => [s.id, s.solid]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const targets = op.targets.map((id) => byId.get(id)).filter((s): s is any => s != null);
  if (targets.length === 0) {
    fail?.(
      `target ids (${op.targets.join(", ")}) did not resolve to solids`,
      "re-check solid-N ids after topology-changing ops — load_model re-lists them"
    );
    return shape;
  }

  const tool = buildHoleTool(oc, op, cleanup);
  if (!tool) {
    fail?.("the hole's cutting tool could not be built", "check radius/depth values are positive and the axis is a non-zero direction");
    return shape;
  }

  const a = combineSolids(oc, targets, cleanup);
  const algo = new oc.BRepAlgoAPI_Cut_3(a, tool);
  cleanup.push(algo);
  if (!algo.IsDone()) {
    fail?.("the hole subtraction did not complete (IsDone() false)", "the hole may lie entirely outside the target solid");
    return shape;
  }
  const result = algo.Shape();
  cleanup.push(result);

  const used = new Set(op.targets);
  const leftovers = solids.filter((s) => !used.has(s.id)).map((s) => s.solid);
  if (leftovers.length === 0) return result;

  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  builder.Add(comp, result);
  for (const s of leftovers) builder.Add(comp, s);
  return comp;
}

/**
 * Cuts the picked regions of a profile through the target solids: one prism
 * per picked region (fused into a single tool when several were picked),
 * subtracted via the already-verified `BRepAlgoAPI_Cut_3`, with the result
 * replacing the targets alongside the untargeted solids — the exact
 * {@link cutHole} skeleton with a region-built tool. Unresolved targets /
 * regions, a failed tool build, or `IsDone()` false all skip gracefully.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function drillCut(oc: any, shape: any, op: Extract<EditOp, { op: "drill" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const solids = collectSolids(oc, shape, cleanup);
  const byId = new Map(solids.map((s) => [s.id, s.solid]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const targets = op.targets.map((id) => byId.get(id)).filter((s): s is any => s != null);
  if (targets.length === 0) {
    fail?.(
      `target ids (${op.targets.join(", ")}) did not resolve to solids`,
      "re-check solid-N ids after topology-changing ops — load_model re-lists them"
    );
    return shape;
  }

  const faces = featureProfileFaces(oc, shape, op, cleanup, fail);
  if (!faces) return shape;
  const tool = prismsForFaces(oc, faces, op.dir, op.length, cleanup, fail);
  if (!tool) return shape;

  const a = combineSolids(oc, targets, cleanup);
  const algo = new oc.BRepAlgoAPI_Cut_3(a, tool);
  cleanup.push(algo);
  if (!algo.IsDone()) {
    fail?.("the drill subtraction did not complete (IsDone() false)", "the tool may lie entirely outside the target solids");
    return shape;
  }
  const result = algo.Shape();
  cleanup.push(result);

  const used = new Set(op.targets);
  const leftovers = solids.filter((s) => !used.has(s.id)).map((s) => s.solid);
  if (leftovers.length === 0) return result;

  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  builder.Add(comp, result);
  for (const s of leftovers) builder.Add(comp, s);
  return comp;
}

/** Builds the hole's tool solid (to subtract), or null on builder failure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildHoleTool(oc: any, op: Extract<EditOp, { op: "addHole" | "addCounterboreHole" | "addCountersinkHole" }>, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    const ax2 = keep(new oc.gp_Ax2_3(keep(pnt(oc, op.position)), keep(dir(oc, op.axis))));
    const main = keep(keep(new oc.BRepPrimAPI_MakeCylinder_3(ax2, op.radius, op.depth)).Shape());
    if (op.op === "addHole") return main;

    // The mouth feature: a wider coaxial cylinder (counterbore) or a cone
    // tapering from csRadius at the surface down to the hole radius
    // (countersink; depth from the included angle).
    const mouth =
      op.op === "addCounterboreHole"
        ? keep(keep(new oc.BRepPrimAPI_MakeCylinder_3(ax2, op.cbRadius, op.cbDepth)).Shape())
        : keep(keep(new oc.BRepPrimAPI_MakeCone_3(
          ax2, op.csRadius, op.radius,
          (op.csRadius - op.radius) / Math.tan((op.csAngleDeg * Math.PI) / 360)
        )).Shape());
    const fuse = keep(new oc.BRepAlgoAPI_Fuse_3(main, mouth));
    if (!fuse.IsDone()) return null;
    return keep(fuse.Shape());
  } catch {
    return null;
  }
}

/** A single operand shape from one-or-more solids (compound when more than
 * one) — exported alongside `collectSolids` for `entityFacts.ts`'s
 * `checkInterference`, which needs the exact same "compound the operand's
 * solids together first" framing this file's own `booleanSolids` already
 * established, read-only. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function combineSolids(oc: any, shapes: any[], cleanup: Array<{ delete(): void }>): any {
  if (shapes.length === 1) return shapes[0];
  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  for (const s of shapes) builder.Add(comp, s);
  return comp;
}

/**
 * Rounds (fillet) or bevels (chamfer) the selected edges of `shape`.
 *
 * OCCT fillet/chamfer API, verified against the live WASM (see CLAUDE.md):
 *   fillet  → `new BRepFilletAPI_MakeFillet(shape, ChFi3d_FilletShape.ChFi3d_Rational)`
 *   chamfer → `new BRepFilletAPI_MakeChamfer(shape)`
 * both then `.Add_2(amount, edge)` per edge → `.Shape()` (auto-builds; `.Build()`
 * needs the unbound `Message_ProgressRange`, so rely on `.Shape()`). An op whose
 * edges don't resolve, or that doesn't complete (`IsDone()` false / `.Shape()`
 * throws), is skipped so replay never hard-fails.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function filletEdges(oc: any, shape: any, op: Extract<EditOp, { op: "fillet" | "chamfer" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const edges = collectEdges(oc, shape, cleanup);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const picked = op.edges.map((id) => edges[edgeIndex(id)]).filter((e): e is any => e != null);
  if (picked.length === 0) {
    fail?.(
      `none of the edge ids (${op.edges.join(", ")}) resolve`,
      "re-check edge-N ids after topology-changing ops — load_model re-lists them"
    );
    return shape;
  }

  const isFillet = op.op === "fillet";
  const maker = isFillet
    ? new oc.BRepFilletAPI_MakeFillet(shape, oc.ChFi3d_FilletShape.ChFi3d_Rational)
    : new oc.BRepFilletAPI_MakeChamfer(shape);
  cleanup.push(maker);
  if (!isFillet && isChamferWithFace(op)) {
    const faces = collectFaces(oc, shape, cleanup);
    const faceIdx = faceIndex(op.face!);
    const refFace = faces[faceIdx];
    if (!refFace) {
      fail?.(`chamfer face ${op.face} does not resolve`, "re-check face-N ids");
      return shape;
    }
    const { edgeFaces, faces: adjFaces } = buildEdgeFaceAdjacency(oc, shape, cleanup);
    const refPos = adjFaces.findIndex((f) => f.IsSame(refFace));
    if (refPos === -1) {
      fail?.(`chamfer face ${op.face} is not adjacent to the model`, "pick a face that shares the chamfered edges");
      return shape;
    }
    for (const e of picked) {
      const bucket = edgeFaces.get(e.HashCode(1 << 30));
      const entry = bucket?.find((b) => b.edge.IsSame(e));
      if (!entry || !entry.faceIdxs.includes(refPos)) {
        fail?.(`edge is not on face ${op.face}`, "pick edges of that face");
        return shape;
      }
    }
    if (op.distance2 !== undefined) {
      for (const e of picked) maker.Add_3(op.distance, op.distance2!, e, refFace);
    } else {
      const angleRad = ((op.angleDeg as number) * Math.PI) / 180;
      for (const e of picked) maker.AddDA(op.distance, angleRad, e, refFace);
    }
  } else {
    const amount = isFillet ? op.radius : op.distance;
    for (const e of picked) maker.Add_2(amount, e);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any;
  try {
    result = maker.Shape();
  } catch {
    const d = isFillet ? (op as Extract<EditOp, { op: "fillet" }>).radius : op.distance;
    fail?.(
      `the ${op.op} build threw — the ${isFillet ? "radius" : "distance"} ${d} is likely too large for the geometry`,
      `try a smaller value, or fewer edges at once`
    );
    return shape;
  }
  if (!maker.IsDone()) {
    const d = isFillet ? (op as Extract<EditOp, { op: "fillet" }>).radius : op.distance;
    fail?.(`the ${op.op} did not complete (IsDone() false)`, `the ${isFillet ? "radius" : "distance"} ${d} may be too large for the selected edges`);
    return shape;
  }
  cleanup.push(result);
  return result;
}

/** Parses an `edge-N` id to its index, or -1. */
function edgeIndex(id: string): number {
  const m = /^edge-(\d+)$/.exec(id);
  return m ? Number(m[1]) : -1;
}

/** Parses a `face-N` id to its index, or -1. */
function faceIndex(id: string): number {
  const m = /^face-(\d+)$/.exec(id);
  return m ? Number(m[1]) : -1;
}

function isChamferWithFace(op: Extract<EditOp, { op: "chamfer" }>): boolean {
  return op.distance2 !== undefined || op.angleDeg !== undefined;
}

/**
 * Feature modeling: builds a new solid from a selected profile face/wire and
 * **appends** it to the model as an additional body (a compound of the existing
 * shape + the new solid) — non-destructive, B-rep only. A feature whose operands
 * don't resolve, or whose builder throws, is skipped so replay never hard-fails.
 *
 * OCCT feature API, verified against the live WASM (see CLAUDE.md):
 *   extrude → `BRepPrimAPI_MakePrism_1(face, gp_Vec_4, false, true).Shape()`
 *   revolve → `BRepPrimAPI_MakeRevol_1(face, gp_Ax1_2(pnt, dir), angleRad, false).Shape()`
 *   sweep   → `BRepOffsetAPI_MakePipe_1(spineWire, profileFace).Shape()`
 *             (spine wire `BRepBuilderAPI_MakeWire_2(edge).Wire()` from the path edge)
 *   loft    → `new BRepOffsetAPI_ThruSections(true, false, 1e-6)` + `.AddWire(
 *             BRepTools.OuterWire(face))` per profile + `.Build()` + `.Shape()`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function featureModel(oc: any, shape: any, op: EditOp, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail, guideCollector?: GuideCollector): any {
  if (guideCollector) {
    // Both operand forms are checked: a guide face can't be a profile, and
    // neither can a guide edge — an `addPolyline { guide: true }` is exactly
    // the kind of construction spine someone would otherwise try to extrude.
    // The sweep PATH edge is checked too; it used to be the one operand of
    // this family that a guide could still slip through.
    const single = op.op === "extrude" || op.op === "revolve" || op.op === "sweep" || op.op === "drill" ? (op as any).profile : undefined;
    const terminator: string[] = op.op === "extrude" && typeof (op as any).upToFace === "string" ? [(op as any).upToFace as string] : [];
    // Rib carries its own operand names (spineEdges/upTo, not profile) — a
    // guide spine or guide terminator must refuse exactly like any other
    // construction-geometry operand. Wrap's profile is a plain face id.
    const ribFaces: string[] = op.op === "rib" && typeof (op as any).upTo === "string" ? [(op as any).upTo as string] : [];
    const ribEdges: string[] = op.op === "rib" ? ((op as any).spineEdges ?? []) : [];
    const wrapFaces: string[] = op.op === "wrap" && typeof (op as any).profile === "string" ? [(op as any).profile as string] : [];
    const faceIds: string[] = op.op === "loft" ? ((op as any).profiles ?? []) : single !== undefined ? [single, ...terminator] : [...terminator, ...ribFaces, ...wrapFaces];
    const edgeIds: string[] = op.op === "loft"
      ? ((op as any).profileEdgeSets ?? []).flat()
      : [...((op as any).profileEdges ?? []), ...(op.op === "sweep" ? [(op as any).path] : []), ...ribEdges];
    if (faceIds.length > 0) {
      const faces = collectFaces(oc, shape, cleanup);
      for (const fid of faceIds) {
        const f = faces[faceIndex(fid)];
        if (f && isGuideHandle(f, guideCollector)) { fail?.(`profile ${fid} is construction (guide) geometry — guide entities are excluded from feature resolution`); return shape; }
      }
    }
    if (edgeIds.length > 0) {
      const edges = collectEdges(oc, shape, cleanup);
      for (const eid of edgeIds) {
        const e = edges[edgeIndex(eid)];
        if (e && isGuideHandle(e, guideCollector)) { fail?.(`edge ${eid} is construction (guide) geometry — guide entities are excluded from feature resolution`); return shape; }
      }
    }
  }
  // Rib fuses instead of appending (the wall must become one solid with its
  // support), so it returns the full new shape itself rather than a body for
  // the compound path below. Wrap likewise returns the full new shape
  // (standalone appends, emboss fuses, engrave cuts — each rebuilds with
  // leftovers + debris like ribFused, so none of them fit the append path).
  if (op.op === "rib") return ribFused(oc, shape, op, cleanup, fail);
  if (op.op === "wrap") return wrapDevelop(oc, shape, op as Extract<EditOp, { op: "wrap" }>, cleanup, fail);
  const solid = buildFeatureSolid(oc, shape, op, cleanup, fail);
  if (!solid) {
    if (thinSpecOf(op)) {
      // A thin build has its own distinct failure modes, and an over-large
      // offset is BY FAR the likeliest: OCCT reports no error for it, it just
      // hands back an empty compound instead of an offset wire.
      fail?.(
        `${op.op} could not build a thin-walled body from ${describeThinProfile(op)}`,
        "the wall is probably thicker than the profile's narrowest half-width — reduce thin; a profile that already has holes, or is non-planar, also cannot be thinned"
      );
    } else {
      fail?.(`${op.op} could not build a new body`, "check that the profile (a face-N, or a connected set of edge-N ids) and, for sweep, the path edge-N resolve to real entities");
    }
    return shape;
  }
  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  builder.Add(comp, shape);
  builder.Add(comp, solid);
  return comp;
}

/**
 * The two boundary wires of a thin-walled band around a CLOSED profile wire
 * (a face's outer wire, or one assembled from picked edges), or `null` when
 * the offsets can't produce one. The open-wire case is
 * {@link openBandFaceFromWire} — a genuinely different construction.
 *
 * `thin` is the total wall thickness and `thinOuter` how much of it sits
 * outside the profile boundary (see {@link ThinSpec}), so the offsets applied
 * are `+thinOuter` and `-(thin - thinOuter)`; an offset of exactly 0 reuses the
 * profile wire itself rather than round-tripping it through the offsetter.
 *
 * The `isOpenResult` ctor arg is `false` here, which for a CLOSED spine means
 * "offset outward for a positive distance". Verified live that this holds
 * regardless of the spine's winding: a hand-assembled rectangle wire built
 * clockwise and one built counter-clockwise both grow to 192.566 at `+2` and
 * shrink to 36 at `-2`, so a user-picked edge set needs no orientation fix-up.
 *
 * OCCT API, verified against the live WASM (this is the first use of
 * `BRepOffsetAPI_MakeOffset` anywhere in this codebase):
 * `new BRepOffsetAPI_MakeOffset_3(wire, GeomAbs_JoinType.GeomAbs_Arc, false)`
 * — exactly 3 ctor args, the 0-arg `_1` being the default ctor — then
 * `.Perform(offset, 0)` and `.Shape()`.
 *
 * **An over-large offset does NOT report failure.** Verified: offsetting a
 * 10x10 square inward by 5, 6 or 20 returns a non-null shape that is an EMPTY
 * COMPOUND (`TopAbs_COMPOUND`, zero edges) rather than a wire — no throw, no
 * `IsDone` false. So the result is checked for actually being a wire before
 * use; without that check the caller would build a degenerate solid from
 * nothing and report a confidently-wrong volume.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function thinProfileWires(oc: any, spine: any, thin: number, thinOuter: number, cleanup: Array<{ delete(): void }>): { outer: any; inner: any } | null {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const offsetWire = (d: number): any => {
    if (d === 0) return spine;
    const mk = keep(new oc.BRepOffsetAPI_MakeOffset_3(spine, oc.GeomAbs_JoinType.GeomAbs_Arc, false));
    mk.Perform(d, 0);
    const s = mk.Shape();
    if (!s || s.IsNull()) return null;
    if (s.ShapeType().value !== oc.TopAbs_ShapeEnum.TopAbs_WIRE.value) return null; // the empty-compound case above
    return keep(oc.TopoDS.Wire_1(s));
  };
  const outer = offsetWire(thinOuter);
  const inner = offsetWire(-(thin - thinOuter));
  if (!outer || !inner) return null;
  return { outer, inner };
}

/**
 * True when `wire` forms a closed loop.
 *
 * There is no usable closedness API in this binding — recorded while building
 * `addSurfaceFromLines`, which had to accept a best-effort face from an open
 * chain for exactly this reason: `BRepTools.IsReallyClosed`/`DetectClosedness`
 * need arguments the binding doesn't expose, and `ShapeAnalysis_Wire.
 * CheckClosed` did not distinguish a closed 4-edge square from an open 3-edge
 * chain. Here the answer is load-bearing (it picks between two completely
 * different band constructions), so it is computed from topology instead:
 * tally each vertex's degree across the wire's own edges, using the same
 * `HashCode` bucket + `IsSame` dedup `enumerateEdges`/`buildEdgeFaceAdjacency`
 * already rely on. A closed loop has every vertex shared by two edges; an open
 * chain has exactly two free ends.
 *
 * Verified live: a 1-edge open wire reports 2 free ends of 2 vertices, a
 * 2-edge open chain 2 of 3, and a 4-edge rectangle 0 of 4.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wireIsClosed(oc: any, wire: any, cleanup: Array<{ delete(): void }>): boolean {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buckets = new Map<number, Array<{ vertex: any; degree: number }>>();
  const edges = keep(new oc.TopExp_Explorer_2(wire, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
  for (; edges.More(); edges.Next()) {
    const edge = keep(oc.TopoDS.Edge_1(edges.Current()));
    const verts = keep(new oc.TopExp_Explorer_2(edge, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
    for (; verts.More(); verts.Next()) {
      const vertex = keep(oc.TopoDS.Vertex_1(verts.Current()));
      const hash = vertex.HashCode(HASH_UPPER);
      const bucket = buckets.get(hash);
      const seen = bucket?.find((v) => v.vertex.IsSame(vertex));
      if (seen) seen.degree++;
      else if (bucket) bucket.push({ vertex, degree: 1 });
      else buckets.set(hash, [{ vertex, degree: 1 }]);
    }
  }
  for (const bucket of buckets.values()) for (const v of bucket) if (v.degree === 1) return false;
  return true;
}

/**
 * The closed band boundary around an OPEN profile wire, as a face, or `null`.
 *
 * Genuinely different from {@link thinProfileWires}' two-offset construction:
 * an open spine has no interior to offset into, so the band is a single closed
 * loop straddling it. `BRepOffsetAPI_MakeOffset` produces exactly that when
 * asked for a NON-open result — which is the opposite of what the name
 * suggests and is worth stating, since the alternative silently returns
 * something usable-looking:
 *
 * - `isOpenResult = true` gives a ONE-SIDED offset (an open wire on whichever
 *   side the sign of the distance selects) — **not** a band;
 * - `isOpenResult = false` gives the closed band of half-width `|d|`,
 *   symmetric about the spine, with semicircular end caps. The sign of `d` is
 *   irrelevant.
 *
 * Verified live to be exact: a length-10 spine at `d = 1` encloses
 * `2·d·L + π·d²` = 23.141593, and at `d = 2`, 52.566371; a quarter-circle
 * spine of radius 10 gives 34.557519 by the same formula. So the band's total
 * width is `2·d`, and `thin` (a TOTAL thickness) maps to `d = thin / 2`.
 *
 * **A wire that is a single straight edge throws** (`___cxa_can_catch is not
 * defined` — an Emscripten exception-machinery failure surfacing as an
 * ordinary JS error, which the module survives). A lone straight line has no
 * offset direction defined; a lone ARC offsets fine. Splitting the line at its
 * midpoint into two collinear edges makes it work and yields the identical
 * exact area, so that is done rather than refusing what is otherwise a
 * completely reasonable profile — see {@link splitLoneLine}.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function openBandWire(oc: any, spine: any, thin: number, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    const usable = splitLoneLine(oc, spine, cleanup);
    const mk = keep(new oc.BRepOffsetAPI_MakeOffset_3(usable, oc.GeomAbs_JoinType.GeomAbs_Arc, false));
    mk.Perform(thin / 2, 0);
    const s = mk.Shape();
    if (!s || s.IsNull()) return null;
    keep(s);
    if (s.ShapeType().value !== oc.TopAbs_ShapeEnum.TopAbs_WIRE.value) return null;
    return keep(oc.TopoDS.Wire_1(s));
  } catch {
    return null;
  }
}

/** {@link openBandWire} closed off into the face a feature builder consumes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function openBandFaceFromWire(oc: any, spine: any, thin: number, cleanup: Array<{ delete(): void }>): any {
  const boundary = openBandWire(oc, spine, thin, cleanup);
  return boundary ? faceFromWire(oc, boundary, cleanup) : null;
}

/** A planar face bounded by one closed wire, or null. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function faceFromWire(oc: any, wire: any, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  const mk = keep(new oc.BRepBuilderAPI_MakeFace_15(wire, true));
  if (!mk.IsDone()) return null;
  const face = keep(mk.Face());
  return face.IsNull() ? null : face;
}

/**
 * Returns `wire` unchanged, or — when it is a single straight edge, the one
 * shape this build's offsetter refuses (see {@link openBandFaceFromWire}) — an
 * equivalent two-edge wire split at the midpoint.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function splitLoneLine(oc: any, wire: any, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const edges: any[] = [];
  const exp = keep(new oc.TopExp_Explorer_2(wire, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
  for (; exp.More(); exp.Next()) edges.push(keep(oc.TopoDS.Edge_1(exp.Current())));
  if (edges.length !== 1) return wire;
  try {
    const curve = keep(new oc.BRepAdaptor_Curve_2(edges[0]));
    if (curve.GetType().value !== oc.GeomAbs_CurveType.GeomAbs_Line.value) return wire;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ends: any[] = [];
    const verts = keep(new oc.TopExp_Explorer_2(edges[0], oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
    for (; verts.More(); verts.Next()) ends.push(keep(oc.BRep_Tool.Pnt(keep(oc.TopoDS.Vertex_1(verts.Current())))));
    if (ends.length !== 2) return wire;
    const mid = keep(new oc.gp_Pnt_3((ends[0].X() + ends[1].X()) / 2, (ends[0].Y() + ends[1].Y()) / 2, (ends[0].Z() + ends[1].Z()) / 2));
    const mkWire = keep(new oc.BRepBuilderAPI_MakeWire_1());
    mkWire.Add_1(keep(keep(new oc.BRepBuilderAPI_MakeEdge_3(ends[0], mid)).Edge()));
    mkWire.Add_1(keep(keep(new oc.BRepBuilderAPI_MakeEdge_3(mid, ends[1])).Edge()));
    return mkWire.IsDone() ? keep(mkWire.Wire()) : wire;
  } catch {
    return wire;
  }
}

/** The annular face between a band's two boundary wires, or null. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bandFaceFromWires(oc: any, outer: any, inner: any, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  const mk = keep(new oc.BRepBuilderAPI_MakeFace_15(outer, true));
  mk.Add(keep(oc.TopoDS.Wire_1(inner.Reversed())));
  if (!mk.IsDone()) return null;
  const face = keep(mk.Face());
  return face.IsNull() ? null : face;
}

/** Names the thin profile operand(s) for a diagnostic, in either form. */
function describeThinProfile(op: EditOp): string {
  const single = (op as { profile?: string }).profile;
  if (single) return single;
  const edges = (op as { profileEdges?: string[] }).profileEdges;
  if (edges) return edges.join(", ");
  const many = (op as { profiles?: string[] }).profiles;
  if (many) return many.join(", ");
  const sets = (op as { profileEdgeSets?: string[][] }).profileEdgeSets;
  return sets ? sets.map((ids) => ids.join("+")).join(", ") : "the profile";
}

/** The `thin`/`thinOuter` pair of a sweep-family op, or null when not thin. */
function thinSpecOf(op: EditOp): { thin: number; thinOuter: number } | null {
  const thin = (op as { thin?: number }).thin;
  if (thin === undefined) return null;
  return { thin, thinOuter: (op as { thinOuter?: number }).thinOuter ?? 0 };
}

/**
 * Signed-volume sanity gate for a thin build. Nothing downstream takes an
 * absolute value — `massProperties.ts`, `modelDiffHost.ts`, `entityFacts.ts`
 * and `occtService.ts` all read `props.Mass()` raw — so a reversed solid would
 * report a NEGATIVE volume into mass properties, the BOM and model-diff. A
 * near-zero result means the offsets collapsed the band, which is the other
 * way a thin build fails without throwing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function orientPositiveVolume(oc: any, solid: any, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  const props = keep(new oc.GProp_GProps_1());
  volumePropertiesAdaptive(oc, solid, props);
  const v = props.Mass();
  if (!Number.isFinite(v) || Math.abs(v) < 1e-9) return null;
  return v < 0 ? keep(solid.Reversed()) : solid;
}

/**
 * One resolved profile section: the wire that defines it, whether that wire
 * closes, and — when it came from a `face-N` — the face itself, which the
 * plain (non-thin) path consumes directly so its inner wires (holes) survive.
 */
interface ProfileSection {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  face: any | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wire: any;
  closed: boolean;
  /** True when a face profile already has inner wires — a thin band would silently lose them. */
  holed: boolean;
  /** For diagnostics. */
  label: string;
}

/**
 * Resolves a sweep-family {@link ProfileOperand} — either a `face-N` or a set
 * of `edge-N` ids assembled into one wire — to a {@link ProfileSection}.
 *
 * The edge form reuses `buildSurfaceFromLines`' verified recipe
 * (`BRepBuilderAPI_MakeWire_1` + `.Add_1()` per edge), whose `.IsDone()` is
 * the disconnected-set gate and which joins edges by shared vertices in
 * whatever order they were picked. It deliberately does NOT copy that
 * function's "at least 3 edges" rule: a closed loop needs three, but an open
 * profile is perfectly legitimate as one edge.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveProfileSection(oc: any, shape: any, faceId: string | undefined, edgeIds: string[] | undefined, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): ProfileSection | null {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  if (faceId !== undefined) {
    const face = collectFaces(oc, shape, cleanup)[faceIndex(faceId)];
    if (!face) { fail?.(`profile ${faceId} did not resolve to a face`, "the id may have been renumbered by an earlier topology-changing op — re-inspect the model"); return null; }
    return { face, wire: keep(oc.BRepTools.OuterWire(face)), closed: true, holed: wireCountOf(oc, face, cleanup) !== 1, label: faceId };
  }
  const ids = edgeIds ?? [];
  const label = ids.join(", ");
  const all = collectEdges(oc, shape, cleanup);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const picked: any[] = [];
  for (const id of ids) {
    const edge = all[edgeIndex(id)];
    if (!edge) { fail?.(`profile edge ${id} did not resolve`, "the id may have been renumbered by an earlier topology-changing op — re-inspect the model"); return null; }
    picked.push(edge);
  }
  if (picked.length === 0) { fail?.("the profile named no edges"); return null; }
  const mkWire = keep(new oc.BRepBuilderAPI_MakeWire_1());
  for (const edge of picked) mkWire.Add_1(edge);
  if (!mkWire.IsDone()) { fail?.(`the profile edges (${label}) do not connect into a single wire`, "pick edges that meet end-to-end — a disconnected set has no profile"); return null; }
  const wire = keep(mkWire.Wire());
  return { face: null, wire, closed: wireIsClosed(oc, wire, cleanup), holed: false, label };
}

/**
 * The face a feature builder should actually consume for one section — the
 * whole feature in four quadrants:
 *
 * |            | plain                          | thin                              |
 * |------------|--------------------------------|-----------------------------------|
 * | face id    | the face itself (holes kept)   | two-offset annular band           |
 * | closed wire| a face built from the wire     | two-offset annular band           |
 * | open wire  | **refused** — encloses no area | symmetric band about the spine    |
 *
 * Null means the section could not produce a usable face; `fail` has already
 * been given the specific reason at every branch that returns one.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function profileFaceFor(oc: any, section: ProfileSection, op: EditOp, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const spec = thinSpecOf(op);
  if (!spec) {
    if (section.face) return section.face;
    if (!section.closed) { fail?.(...openProfileNeedsThin(section)); return null; }
    const face = faceFromWire(oc, section.wire, cleanup);
    if (!face) fail?.(`the profile edges (${section.label}) did not bound a face`);
    return face;
  }
  if (!section.closed) {
    if (!openThinOuterOk(op, spec)) { fail?.(...openProfileThinOuter()); return null; }
    const face = openBandFaceFromWire(oc, section.wire, spec.thin, cleanup);
    if (!face) fail?.(`could not build a wall around the open profile (${section.label})`, "a lone straight edge is split automatically, but a self-intersecting spine, or a wall wider than the spine's own turns, has no band");
    return face;
  }
  if (section.holed) { fail?.(`the profile ${section.label} already has a hole`, "a thin wall is built from the outer boundary alone, which would silently discard it"); return null; }
  const wires = thinProfileWires(oc, section.wire, spec.thin, spec.thinOuter, cleanup);
  if (!wires) return null; // featureModel's thin diagnostic covers the over-thick case
  return bandFaceFromWires(oc, wires.outer, wires.inner, cleanup);
}

/**
 * The wires bounding `face`, in `TopExp_Explorer` order. Region 0 of a
 * {@link PickSpec} is whichever of these `BRepTools.OuterWire` matches (by
 * `IsSame`); regions 1..N are the rest in this order.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wiresOfFace(oc: any, face: any, cleanup: Array<{ delete(): void }>): any[] {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wires: any[] = [];
  const exp = keep(new oc.TopExp_Explorer_2(face, oc.TopAbs_ShapeEnum.TopAbs_WIRE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
  for (; exp.More(); exp.Next()) wires.push(keep(oc.TopoDS.Wire_1(exp.Current())));
  return wires;
}

/**
 * The faces a plain (non-thin) feature builder should consume for one
 * section under an explicit {@link PickSpec} — one face per picked region.
 *
 * Orientation is load-bearing and was probed live rather than assumed: an
 * enumerated inner wire added as-is preserves hole-ness (a 20×20 face with
 * a 10×10 hole rebuilds to exactly 300), while the same wire reversed adds
 * an island (500). So a picked inner loop builds as its own forward face
 * (an island disk, verified: each enumerated wire alone builds its enclosed
 * area), and `TopoDS.Orientation` is never read — it is unbound in this
 * build (`Orientation is not a function`), so no implementation may depend
 * on it. `BRepTools.OuterWire` + `IsSame` is the outer match (verified:
 * matches exactly one enumerated wire).
 *
 * - `"outer"`/absent → the section as modeled (holes preserved) — one face.
 * - `"all"` or an index list containing 0 → the outer boundary alone
 *   (holes filled) — one face.
 * - an index list without 0 → one island face per picked inner loop.
 * An out-of-range index, or any non-`[0]` pick on a single-region (edge)
 * profile, skips with a diagnostic. Null means unusable; `fail` already told.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function regionFacesFor(oc: any, section: ProfileSection, pick: Exclude<RegionPick, "outer">, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any[] | null {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  if (!section.face) {
    // Edge profiles expose a single region: anything naming more is a miss,
    // not a resolve-time failure (same reasoning as `asMidaxisPair`).
    const ok = pick === "all" || (Array.isArray(pick) && pick.length === 1 && pick[0] === 0);
    if (!ok) { fail?.(`pick ${JSON.stringify(pick)} names regions an edge profile does not have`, "an edge wire is a single region — use a face profile to pick among holes"); return null; }
    if (!section.closed) { fail?.(...openProfileNeedsThin(section)); return null; }
    const face = faceFromWire(oc, section.wire, cleanup);
    if (!face) fail?.(`the profile edges (${section.label}) did not bound a face`);
    return face ? [face] : null;
  }
  const wires = wiresOfFace(oc, section.face, cleanup);
  const outer = keep(oc.BRepTools.OuterWire(section.face));
  const outerIdx = wires.findIndex((w) => (outer as any).IsSame(w));
  const inners = wires.filter((_, i) => i !== outerIdx);
  if (pick === "all" || (Array.isArray(pick) && pick.includes(0))) {
    if (Array.isArray(pick) && pick.some((r) => r < 0 || r > inners.length)) {
      fail?.(`pick ${JSON.stringify(pick)} is out of range for ${section.label} (${inners.length} inner loop(s))`, "re-inspect the profile face — region 0 is the outer boundary, 1..N its inner loops in order");
      return null;
    }
    const filled = faceFromWire(oc, wires[outerIdx], cleanup);
    if (!filled) fail?.(`the outer boundary of ${section.label} did not bound a face`);
    return filled ? [filled] : null;
  }
  // Islands only: one forward face per picked inner loop.
  const idx = pick as number[];
  if (idx.some((r) => r < 1 || r > inners.length)) {
    fail?.(`pick ${JSON.stringify(pick)} is out of range for ${section.label} (${inners.length} inner loop(s))`, "re-inspect the profile face — region 0 is the outer boundary, 1..N its inner loops in order");
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const faces: any[] = [];
  for (const r of idx) {
    const island = faceFromWire(oc, inners[r - 1], cleanup);
    if (!island) { fail?.(`inner loop ${r} of ${section.label} did not bound a face`); return null; }
    faces.push(island);
  }
  return faces;
}

/** The `thinOuter` rule for an open profile — see {@link ThinSpec}. */
function openThinOuterOk(op: EditOp, spec: { thin: number; thinOuter: number }): boolean {
  // `thinSpecOf` defaults an ABSENT `thinOuter` to 0, which is the common case
  // and must stay allowed, so the raw field is what decides.
  const raw = (op as { thinOuter?: number }).thinOuter;
  return raw === undefined || raw === spec.thin / 2;
}

function openProfileNeedsThin(section: ProfileSection): [string, string] {
  return [
    `the profile (${section.label}) is an open wire, which encloses no area`,
    "add `thin` to build a walled body from it, or pick edges that close into a loop",
  ];
}

function openProfileThinOuter(): [string, string] {
  return [
    "`thinOuter` has no meaning for an open profile — an open wire has no inside or outside",
    "omit `thinOuter` (the wall is centred on the spine), or set it to exactly thin/2",
  ];
}

/** Applies the thin sanity gate only when the op is thin; a plain feature is unchanged. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function finishThin(oc: any, op: EditOp, solid: any, cleanup: Array<{ delete(): void }>): any {
  if (!solid || !thinSpecOf(op)) return solid;
  return orientPositiveVolume(oc, solid, cleanup);
}

/**
 * Resolves the single-profile ops' operand and turns it into the face their
 * builder consumes, or null (with `fail` already told why).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function featureProfileFace(oc: any, shape: any, op: EditOp & { profile?: string; profileEdges?: string[] }, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const section = resolveProfileSection(oc, shape, op.profile, op.profileEdges, cleanup, fail);
  return section ? profileFaceFor(oc, section, op, cleanup, fail) : null;
}

/**
 * The faces a single-profile feature builder (extrude/revolve/sweep) or
 * {@link drillCut} should consume — one face per picked region.
 *
 * A thin build always uses the outer boundary alone (`thinProfileWires`
 * takes the section wire, which IS the outer wire for a face profile), so
 * an explicit `pick` alongside `thin` is refused rather than silently
 * coinciding: the caller must drop one of them. A plain build with no
 * explicit pick keeps the existing single-face path byte-for-byte
 * (`profileFaceFor`), so pick-free replay is untouched.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function featureProfileFaces(oc: any, shape: any, op: EditOp & { profile?: string; profileEdges?: string[]; pick?: RegionPick }, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any[] | null {
  const section = resolveProfileSection(oc, shape, op.profile, op.profileEdges, cleanup, fail);
  if (!section) return null;
  const pick = op.pick;
  if (thinSpecOf(op)) {
    if (pick !== undefined) { fail?.(`pick cannot combine with thin — thin walls build from the outer boundary alone`, "drop `pick` (the default already consumes the outer boundary) or drop `thin`"); return null; }
    const face = profileFaceFor(oc, section, op, cleanup, fail);
    return face ? [face] : null;
  }
  if (pick === undefined || pick === "outer") {
    const face = profileFaceFor(oc, section, op, cleanup, fail);
    return face ? [face] : null;
  }
  return regionFacesFor(oc, section, pick, cleanup, fail);
}

/**
 * Prism bodies for `faces` along `dir`×`length` (the extrude builder shape:
 * `BRepPrimAPI_MakePrism_1(face, vec, false, true)`), fused into one tool
 * when several regions were picked. Null when any prism fails to build.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function prismsForFaces(oc: any, faces: any[], dir: Vec3, length: number, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  const [dx, dy, dz] = dir;
  const len = Math.hypot(dx, dy, dz) || 1;
  const s = length / len; // dir scaled so |vec| == length
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bodies: any[] = [];
  for (const face of faces) {
    const vec = keep(new oc.gp_Vec_4(dx * s, dy * s, dz * s));
    let body: any = null;
    try {
      body = keep(keep(new oc.BRepPrimAPI_MakePrism_1(face, vec, false, true)).Shape());
    } catch {
      fail?.("a picked region's prism failed to build", "the region face may be degenerate — try picking fewer regions");
      return null;
    }
    if (!body || body.IsNull()) {
      fail?.("a picked region's prism failed to build", "the region face may be degenerate — try picking fewer regions");
      return null;
    }
    bodies.push(body);
  }
  if (bodies.length === 1) return bodies[0];
  return combineSolids(oc, bodies, cleanup);
}

/**
 * Derives an extrusion length from a terminator face (`upToFace`) — the
 * distance from the profile plane to the terminator plane along `dir`, or
 * `null` (with `fail` told exactly why) when there is no usable answer.
 *
 * This is deliberately plane math over the two faces' analytic planes
 * (`faceSurfaceInfo`, verified), NOT a `BRepAlgoAPI_Section` call: probed
 * live, `BRepAlgoAPI_Section` has no accessible constructor in this build
 * (`BindingError`) and its 0-arg form exposes no shape setters (only
 * `Build`/`IsDone`/`Shape`) — the fourth "green is necessary but not
 * sufficient" instance in this codebase. An overshoot-prism +
 * half-space-`Common` composition (the `splitSolidsByPlane` call shape) was
 * probed as the fallback and verified exact (z=[10,25], volume 1500 on the
 * analytic fixture), but a directly-built prism at the derived length is
 * cheaper and equally exact, so that is what the caller builds — the
 * fallback pattern stands validated for a future cut-variant, not used here.
 *
 * Semantics: up-to-face terminates at the terminator's PLANE (mainstream
 * "up to surface" behavior for the footprint-covered case). A zero/negative
 * distance (terminator behind or coplanar with the profile) is a MISS, and a
 * direction perpendicular to the plane normal is PARALLEL — both skip
 * gracefully rather than building a degenerate or unbounded solid, and a
 * non-planar profile or terminator is refused (no plane to measure to).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extrudeLengthUpToFace(
  oc: any,
  shape: any,
  profileFace: any,
  op: Extract<EditOp, { op: "extrude" }>,
  cleanup: Array<{ delete(): void }>,
  fail?: OutcomeFail
): number | null {
  const upToFace = op.upToFace as string | undefined;
  const term = upToFace === undefined ? undefined : collectFaces(oc, shape, cleanup)[faceIndex(upToFace)];
  if (!term) {
    fail?.(
      `up-to-face ${upToFace} did not resolve to a face`,
      "re-check face-N ids — load_model re-lists them after topology-changing ops"
    );
    return null;
  }
  const profInfo = faceSurfaceInfo(oc, profileFace, cleanup);
  if (profInfo.type !== "plane" || !profInfo.params || profInfo.params.kind !== "plane") {
    fail?.("up-to-face extrusion needs a planar profile face", "sketch a flat profile (Circle, Rectangle, Polygon) instead");
    return null;
  }
  const termInfo = faceSurfaceInfo(oc, term, cleanup);
  if (termInfo.type !== "plane" || !termInfo.params || termInfo.params.kind !== "plane") {
    fail?.(
      `up-to-face ${upToFace} is a ${termInfo.type} surface, not a plane`,
      "only planar terminator faces are supported — curved faces are a queued follow-up"
    );
    return null;
  }
  const [dx, dy, dz] = op.dir;
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 0)) {
    fail?.("extrusion direction has zero length", "give a non-zero dir vector");
    return null;
  }
  const n = termInfo.params.normal;
  const denom = (dx * n[0] + dy * n[1] + dz * n[2]) / len;
  if (Math.abs(denom) < 1e-9) {
    fail?.(
      `extrusion direction is parallel to ${upToFace}'s plane — it never meets the terminator`,
      "rotate the direction out of the terminator plane, or pick a different terminator face"
    );
    return null;
  }
  const p0 = profInfo.params.origin;
  const p1 = termInfo.params.origin;
  // Sign-independent: when the normal points back toward the profile, both
  // numerator and denominator are negative and the quotient stays positive.
  const t = ((p1[0] - p0[0]) * n[0] + (p1[1] - p0[1]) * n[1] + (p1[2] - p0[2]) * n[2]) / denom;
  if (!(t > 1e-9)) {
    fail?.(
      `terminator ${upToFace} lies behind (or on) the profile plane along the extrusion direction`,
      "flip the extrusion direction, or pick a terminator face ahead of the profile"
    );
    return null;
  }
  return t;
}

/**
 * The wall↔support junction edges of a freshly fused rib, for blending —
 * edges lying in the support plane (within a diag-relative tolerance) AND
 * laterally near the spine wire (within wall thickness plus drift
 * compensation), deduplicated by `IsSame`. The plane test alone is not
 * enough (the box top perimeter lies in the same plane — probed: 24
 * candidates without the footprint rule, 16 with it). A bbox of the BAND
 * face does NOT work as the footprint test (first attempt, caught live):
 * the band sits at the spine plane while the wall extends far beyond it
 * along `dir`, so every real junction edge fails a band-bbox check. Lateral
 * distance to the spine is the correct footprint measure; the drift term
 * (`t·tan tilt`) keeps it correct when `dir` is oblique to the band plane.
 * Returned as `Edge_1` handles: `MakeFillet.Add_2` rejects the raw explorer
 * wrapper (`BindingError`, probed — same cast `collectEdges`' callers
 * already rely on).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ribJunctionEdges(
  oc: any,
  fused: any,
  planePoint: Vec3,
  planeNormal: Vec3,
  spine: any,
  dirUnit: Vec3,
  thin: number,
  cleanup: Array<{ delete(): void }>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any[] {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  const diag = Math.max(bboxDiagonal(oc, fused, cleanup), 1e-9);
  const planeTol = Math.max(diag * 1e-7, 1e-9);
  // Spine polyline points (world): the footprint reference.
  const spinePts: Vec3[] = [];
  const vexp = keep(new oc.TopExp_Explorer_2(spine, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
  for (; vexp.More(); vexp.Next()) {
    // Cast required: the raw explorer wrapper is a TopoDS_Shape, which
    // BRep_Tool.Pnt rejects (same BindingError class as Add_2/Edge_1 above).
    const pnt = keep(oc.BRep_Tool.Pnt(keep(oc.TopoDS.Vertex_1(vexp.Current()))));
    spinePts.push([pnt.X(), pnt.Y(), pnt.Z()]);
  }
  // The projection above already corrects for oblique extrusion (lateral
  // distance is measured ⊥ dir). The threshold is HALF the wall plus float
  // slack: a junction edge lies on the wall surface, exactly thin/2 from the
  // spine centerline (arcs less). A full-thin threshold admits the support
  // solid's own boundary edges at the wall's far side (probed: two dd=2.0
  // cap-perimeter edges joined the set) — each fillets fine alone, but the
  // combination throws, so the tighter bound is load-bearing, not tidy.
  const lateralTol = thin / 2 + Math.max(diag * 1e-7, 1e-9);
  const [nx, ny, nz] = planeNormal;
  // Lateral distance only: the wall extends along dirUnit, so the extrusion
  // component must be projected OUT before measuring — a plain 3D distance
  // to the spine (which sits one extrusion length away from the junction)
  // would reject every real junction edge (caught live: identical
  // blended/fuse-only volumes). Measured in the plane ⊥ dirUnit.
  const helper: Vec3 = Math.abs(dirUnit[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1: Vec3 = [
    dirUnit[1] * helper[2] - dirUnit[2] * helper[1],
    dirUnit[2] * helper[0] - dirUnit[0] * helper[2],
    dirUnit[0] * helper[1] - dirUnit[1] * helper[0],
  ];
  const e1Len = Math.hypot(e1[0], e1[1], e1[2]) || 1;
  const e2: Vec3 = [
    (dirUnit[1] * e1[2] - dirUnit[2] * e1[1]) / e1Len,
    (dirUnit[2] * e1[0] - dirUnit[0] * e1[2]) / e1Len,
    (dirUnit[0] * e1[1] - dirUnit[1] * e1[0]) / e1Len,
  ];
  const e1n: Vec3 = [e1[0] / e1Len, e1[1] / e1Len, e1[2] / e1Len];
  const ref = spinePts[0];
  const proj = (p: Vec3): [number, number] => [
    (p[0] - ref[0]) * e1n[0] + (p[1] - ref[1]) * e1n[1] + (p[2] - ref[2]) * e1n[2],
    (p[0] - ref[0]) * e2[0] + (p[1] - ref[1]) * e2[1] + (p[2] - ref[2]) * e2[2],
  ];
  const spine2d = spinePts.map(proj);
  const distToSpine = (mid: Vec3): number => {
    const [mx, my] = proj(mid);
    let best = Infinity;
    for (let i = 0; i + 1 < spine2d.length; i++) {
      const ax = spine2d[i][0];
      const ay = spine2d[i][1];
      const abx = spine2d[i + 1][0] - ax;
      const aby = spine2d[i + 1][1] - ay;
      const denom = abx * abx + aby * aby;
      const tt = denom > 0 ? Math.max(0, Math.min(1, ((mx - ax) * abx + (my - ay) * aby) / denom)) : 0;
      const d = Math.hypot(mx - (ax + abx * tt), my - (ay + aby * tt));
      if (d < best) best = d;
    }
    return best;
  };
  const found: Array<{ hash: number; edge: any }> = [];
  for (const edge of collectEdges(oc, fused, cleanup)) {
    const props = keep(new oc.GProp_GProps_1());
    oc.BRepGProp.LinearProperties(edge, props, false, false);
    const c = keep(props.CentreOfMass());
    const mid: Vec3 = [c.X(), c.Y(), c.Z()];
    const offPlane = Math.abs((mid[0] - planePoint[0]) * nx + (mid[1] - planePoint[1]) * ny + (mid[2] - planePoint[2]) * nz);
    if (offPlane > planeTol) continue;
    if (spinePts.length < 2 || distToSpine(mid) > lateralTol) continue;
    const cast = keep(oc.TopoDS.Edge_1(edge));
    const h = cast.HashCode(1 << 30);
    if (found.some((f) => f.hash === h && f.edge.IsSame(cast))) continue;
    found.push({ hash: h, edge: cast });
  }
  return found.map((f) => f.edge);
}

/**
 * Builds a rib fused into the model — the full new shape (not a body for the
 * append path: fusing IS the operation). Reuses the open-profile machinery
 * (`resolveProfileSection` + `profileFaceFor`, including the thinOuter and
 * over-thick rules) and the up-to-face plane derivation, then:
 * extrude to terminator plane + one wall-thickness of embed (so the wall
 * robustly intersects for fusing — the embedded part vanishes, probed exact)
 * → `Fuse_3` (wall first, the probed order) → blend the junction at
 * `blendRadius` (default `thin / 4`; `0` = fuse only).
 *
 * Every failure returns the unmodified `shape` with a specific diagnostic
 * (the graceful-skip rule): unresolved spine/terminator, non-planar band or
 * terminator, zero direction, parallel, miss, fuse `IsDone()` false or
 * builder throw, and blend failure (which skips the whole op with a naming
 * diagnostic — a fused-but-unblended wall is never silently substituted for
 * the requested blend; set `blendRadius: 0` for fuse-only).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ribFused(
  oc: any,
  shape: any,
  op: Extract<EditOp, { op: "rib" }>,
  cleanup: Array<{ delete(): void }>,
  fail?: OutcomeFail
): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    const section = resolveProfileSection(oc, shape, undefined, op.spineEdges, cleanup, fail);
    if (!section) return shape;
    const bandFace = profileFaceFor(oc, section, op, cleanup, fail);
    if (!bandFace) return shape;
    const term = collectFaces(oc, shape, cleanup)[faceIndex(op.upTo)];
    if (!term) {
      fail?.(
        `rib terminator ${op.upTo} did not resolve to a face`,
        "re-check face-N ids — load_model re-lists them after topology-changing ops"
      );
      return shape;
    }
    const termInfo = faceSurfaceInfo(oc, term, cleanup);
    if (termInfo.type !== "plane" || !termInfo.params || termInfo.params.kind !== "plane") {
      fail?.(
        `rib terminator ${op.upTo} is a ${termInfo.type} surface, not a plane`,
        "only planar terminator faces are supported — curved faces are a queued follow-up"
      );
      return shape;
    }
    const bandInfo = faceSurfaceInfo(oc, bandFace, cleanup);
    if (bandInfo.type !== "plane" || !bandInfo.params || bandInfo.params.kind !== "plane") {
      fail?.("the rib wall is not planar, so it has no plane to measure the extrusion from", "a non-planar spine cannot drive a rib");
      return shape;
    }
    const [dx, dy, dz] = op.dir;
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 0)) {
      fail?.("rib direction has zero length", "give a non-zero dir vector");
      return shape;
    }
    const n = termInfo.params.normal;
    const denom = (dx * n[0] + dy * n[1] + dz * n[2]) / len;
    if (Math.abs(denom) < 1e-9) {
      fail?.(
        `rib direction is parallel to ${op.upTo}'s plane — it never meets the terminator`,
        "rotate the direction out of the terminator plane, or pick a different terminator face"
      );
      return shape;
    }
    const p0 = bandInfo.params.origin;
    const p1 = termInfo.params.origin;
    const t = ((p1[0] - p0[0]) * n[0] + (p1[1] - p0[1]) * n[1] + (p1[2] - p0[2]) * n[2]) / denom;
    if (!(t > 1e-9)) {
      fail?.(
        `terminator ${op.upTo} lies behind (or on) the spine plane along the rib direction`,
        "flip the rib direction, or pick a terminator face ahead of the spine"
      );
      return shape;
    }
    // The wall starts one thickness BELOW the spine plane (not on it): a
    // coplanar touch between the wall's base cap and the support face makes
    // the fuse fail (`IsDone()` false — probed live), while a penetrating
    // overlap fuses exactly. The embedded part vanishes into the solid, so
    // the visible wall still runs spine-plane → terminator plane.
    const ux = dx / len;
    const uy = dy / len;
    const uz = dz / len;
    const back = keep(new oc.gp_Trsf_1());
    back.SetTranslation_1(keep(new oc.gp_Vec_4(-ux * op.thin, -uy * op.thin, -uz * op.thin)));
    const sunkFace = rigid(oc, back, cleanup)(bandFace);
    const total = t + 2 * op.thin;
    const vec = keep(new oc.gp_Vec_4(ux * total, uy * total, uz * total));
    const prism = keep(keep(new oc.BRepPrimAPI_MakePrism_1(sunkFace, vec, false, true)).Shape());
    // Fuse against the solids only (see splitSolidsAndDebris); debris carries
    // over untouched around the fused bodies, in original relative order.
    const { solids: supportSolids, debris } = splitSolidsAndDebris(oc, shape, cleanup);
    if (supportSolids.length === 0) {
      fail?.("the rib has no solid to fuse with", "build the supporting body first — a rib floating in empty space is refused");
      return shape;
    }
    let fused: any;
    try {
      const fuse = keep(new oc.BRepAlgoAPI_Fuse_3(prism, combineSolids(oc, supportSolids, cleanup)));
      if (!fuse.IsDone()) {
        fail?.("the rib wall would not fuse with the model (IsDone() false)", "the embedded wall portion may miss every solid — check the spine sits over one");
        return shape;
      }
      const fusedBodies = keep(fuse.Shape());
      if (debris.length === 0) {
        fused = fusedBodies;
      } else {
        const rebuilt = keep(new oc.TopoDS_Compound());
        const rb = keep(new oc.BRep_Builder());
        rb.MakeCompound(rebuilt);
        for (const s of collectSolids(oc, fusedBodies, cleanup)) rb.Add(rebuilt, s.solid);
        for (const d of debris) rb.Add(rebuilt, d);
        fused = rebuilt;
      }
    } catch {
      fail?.("the rib fuse threw", "the embedded wall portion may miss every solid — check the spine sits over one");
      return shape;
    }
    const blendRadius = op.blendRadius === undefined ? op.thin / 4 : op.blendRadius;
    if (!(blendRadius > 0)) return fused;
    const junction = ribJunctionEdges(oc, fused, termInfo.params.origin, n, section.wire, [ux, uy, uz], op.thin, cleanup);
    if (junction.length === 0) return fused;
    try {
      const fil = keep(new oc.BRepFilletAPI_MakeFillet(fused, oc.ChFi3d_FilletShape.ChFi3d_Rational));
      for (const e of junction) fil.Add_2(blendRadius, e);
      const out = keep(fil.Shape());
      if (!fil.IsDone()) {
        fail?.(
          `the rib junction blend failed at r=${blendRadius} (IsDone() false)`,
          "set blendRadius: 0 for fuse-only, or try a smaller radius"
        );
        return shape;
      }
      return out;
    } catch {
      fail?.(
        `the rib junction blend threw at r=${blendRadius}`,
        "set blendRadius: 0 for fuse-only, or try a smaller radius — an over-large radius is the usual cause"
      );
      return shape;
    }
  } catch (err) {
    fail?.(
      `the rib builder threw (${err instanceof Error ? err.message : String(err)})`.slice(0, 160),
      "this is a builder-internal failure, not an operand problem — re-check the spine and terminator ids"
    );
    return shape;
  }
}

/**
 * Develop a flat sketch profile onto a cylinder or cone and thicken it into
 * a closed shell, then combine it with the model per `variant` (roadmap
 * item 1 `wrap()`, unblocked by the green sew-two-offsets probe — see
 * `doc/roadmap.md`'s record, not re-derived here).
 *
 * Mapping (deterministic, stated — no hidden state): the sketch's 2D frame
 * is `(xdir, ydir)` in its own plane, where `ydir` is the axis direction
 * projected onto the sketch (`xdir = ydir × normal`), falling back — when
 * the sketch is perpendicular to the axis — to `xdir` = the radial
 * direction (`ydir = normal × xdir`); a sketch centred exactly on the axis
 * has no meridian and is refused. The loop's bbox centre maps to its own
 * angular position (meridian) and axial station, so translating the sketch
 * moves the result predictably; radial distance is ignored (development is
 * intrinsic). Local `(x, y)` maps to `(angle = x / r, slant = y)` — the
 * true unrolling isometry on both cylinder (constant `r`) and cone
 * (`r` at the point's own station; the cone's V parameter is slant
 * distance, probed live). A loop spanning ≥ 2π of angle would self-overlap
 * and is refused.
 *
 * Each stage degrades to a graceful skip with a diagnostic (never a throw,
 * never a wrong solid): unresolved/non-planar/holed profile, apex
 * crossing (`r ≤ 0`), over-wide loop, offset/skirt/sew failure, unresolved
 * fuse/cut targets.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapDevelop(
  oc: any,
  shape: any,
  op: Extract<EditOp, { op: "wrap" }>,
  cleanup: Array<{ delete(): void }>,
  fail?: OutcomeFail
): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    const face = collectFaces(oc, shape, cleanup)[faceIndex(op.profile)];
    if (!face) {
      fail?.(
        `wrap profile ${op.profile} did not resolve to a face`,
        "the id may have been renumbered by an earlier topology-changing op — re-inspect the model"
      );
      return shape;
    }
    if (wireCountOf(oc, face, cleanup) !== 1) {
      fail?.(
        `wrap profile ${op.profile} already has a hole`,
        "a developed band is built from the outer boundary alone, which would silently discard it"
      );
      return shape;
    }
    const info = faceSurfaceInfo(oc, face, cleanup);
    if (info.type !== "plane" || !info.params || info.params.kind !== "plane") {
      fail?.(
        `wrap profile ${op.profile} is a ${info.type} surface, not a plane`,
        "only flat sketch faces can be developed — pick a sketch profile"
      );
      return shape;
    }
    const n = info.params.normal;
    const [ax, ay, az] = op.axisDir;
    const axisLen = Math.hypot(ax, ay, az);
    if (!(axisLen > 0)) {
      fail?.("wrap axis has zero length", "give a non-zero axisDir vector");
      return shape;
    }
    const ux = ax / axisLen;
    const uy = ay / axisLen;
    const uz = az / axisLen;
    // In-sketch frame: ydir = axis projected onto the sketch plane...
    const dot = ux * n[0] + uy * n[1] + uz * n[2];
    let px = ux - dot * n[0];
    let py = uy - dot * n[1];
    let pz = uz - dot * n[2];
    let pl = Math.hypot(px, py, pz);
    let xdir: Vec3;
    let ydir: Vec3;
    // Ordered boundary loop via per-edge discretization + greedy chaining
    // (endpoints coincide exactly — UniformDeflection includes curve bounds
    // on shared vertices — so a 1e-9 match is exact, not approximate).
    const loop = wrapBoundaryLoop(oc, face, cleanup);
    if (!loop || loop.length < 3) {
      fail?.(
        `wrap profile ${op.profile} has no usable boundary loop`,
        "the face may be degenerate — pick a sketch profile with real extent"
      );
      return shape;
    }
    // Loop bbox centre: stable under resampling (unlike a point average,
    // which edge-density would bias).
    let mnx = Infinity;
    let mny = Infinity;
    let mnz = Infinity;
    let mxx = -Infinity;
    let mxy = -Infinity;
    let mxz = -Infinity;
    for (const p of loop) {
      if (p[0] < mnx) mnx = p[0];
      if (p[1] < mny) mny = p[1];
      if (p[2] < mnz) mnz = p[2];
      if (p[0] > mxx) mxx = p[0];
      if (p[1] > mxy) mxy = p[1];
      if (p[2] > mxz) mxz = p[2];
    }
    const O: Vec3 = [(mnx + mxx) / 2, (mny + mxy) / 2, (mnz + mxz) / 2];
    if (pl > 1e-9) {
      ydir = [px / pl, py / pl, pz / pl];
      // xdir = ydir × n (right-handed: (ydir × n) × ydir = n).
      xdir = [
        ydir[1] * n[2] - ydir[2] * n[1],
        ydir[2] * n[0] - ydir[0] * n[2],
        ydir[0] * n[1] - ydir[1] * n[0],
      ];
    } else {
      // Sketch perpendicular to the axis: radial direction lies in-plane.
      const ox = O[0] - op.axisPoint[0];
      const oy = O[1] - op.axisPoint[1];
      const oz = O[2] - op.axisPoint[2];
      const oq = ox * ux + oy * uy + oz * uz;
      const rx = ox - oq * ux;
      const ry = oy - oq * uy;
      const rz = oz - oq * uz;
      const rl = Math.hypot(rx, ry, rz);
      if (!(rl > 1e-9)) {
        fail?.(
          `wrap profile ${op.profile} is centred exactly on the wrap axis`,
          "offset the sketch so a meridian is defined — a centred profile has no angular position"
        );
        return shape;
      }
      xdir = [rx / rl, ry / rl, rz / rl];
      // ydir = n × xdir (right-handed: xdir × (n × xdir) = n).
      ydir = [
        n[1] * xdir[2] - n[2] * xdir[1],
        n[2] * xdir[0] - n[0] * xdir[2],
        n[0] * xdir[1] - n[1] * xdir[0],
      ];
    }
    // Meridian + station of the loop centre (preserved by development).
    const ox = O[0] - op.axisPoint[0];
    const oy = O[1] - op.axisPoint[1];
    const oz = O[2] - op.axisPoint[2];
    const q0 = ox * ux + oy * uy + oz * uz;
    const cosA = op.target === "cone" ? Math.cos((op.halfAngleDeg as number) * Math.PI / 180) : 1;
    const sinA = op.target === "cone" ? Math.sin((op.halfAngleDeg as number) * Math.PI / 180) : 0;
    // Slant of the centre: axial station projected onto the slant direction.
    const s0 = op.target === "cone" ? q0 / cosA : q0;
    // Reference radial direction at the centre (for the angular origin).
    const refR = op.target === "cone" ? op.radius + s0 * sinA : op.radius;
    const refx = ox - q0 * ux;
    const refy = oy - q0 * uy;
    const refz = oz - q0 * uz;
    const refl = Math.hypot(refx, refy, refz);
    if (!(refl > 1e-9)) {
      fail?.(
        `wrap profile ${op.profile} is centred exactly on the wrap axis`,
        "offset the sketch so a meridian is defined — a centred profile has no angular position"
      );
      return shape;
    }
    // Surface frame: Ax3(location=axisPoint, direction=axisDir) gets a
    // default XDir we must not assume — read it back and offset our angles
    // (u = theta + phi), since a u-offset of 2πk is the identity anyway.
    const ax3 = keep(new oc.gp_Ax3_4(keep(pnt(oc, op.axisPoint)), keep(dir(oc, [ux, uy, uz]))));
    const sX = keep(ax3.XDirection());
    const sY = keep(ax3.YDirection());
    const sxx = sX.X();
    const sxy = sX.Y();
    const sxz = sX.Z();
    const syx = sY.X();
    const syy = sY.Y();
    const syz = sY.Z();
    const phi = Math.atan2(refx * syx + refy * syy + refz * syz, refx * sxx + refy * sxy + refz * sxz);
    const shell = wrapThickenedShell(oc, loop, O, xdir, ydir, phi, s0, refR, cosA, sinA, op, cleanup, fail);
    if (!shell) return shape;

    if (op.variant === "standalone") {
      const comp = keep(new oc.TopoDS_Compound());
      const builder = keep(new oc.BRep_Builder());
      builder.MakeCompound(comp);
      builder.Add(comp, shape);
      builder.Add(comp, shell);
      return comp;
    }
    // Emboss fuses, engrave cuts — against the solids only (debris in a
    // fused operand fails IsDone, probed live — same load-bearing split as
    // ribFused, debris carried over in original relative order).
    const solids = collectSolids(oc, shape, cleanup);
    const byId = new Map(solids.map((s) => [s.id, s.solid]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const targets = (op.targets ?? []).map((id) => byId.get(id)).filter((s): s is any => s != null);
    if (targets.length === 0) {
      fail?.(
        `wrap target ids (${(op.targets ?? []).join(", ")}) did not resolve to solids`,
        "re-check solid-N ids — load_model re-lists them after topology-changing ops"
      );
      return shape;
    }
    const { solids: supportSolids, debris } = splitSolidsAndDebris(oc, shape, cleanup);
    const wanted = new Set(op.targets ?? []);
    const supportTargets = supportSolids.filter((_, i) => wanted.has(solids[i]?.id ?? ""));
    if (supportTargets.length === 0) {
      fail?.(
        `wrap target ids (${(op.targets ?? []).join(", ")}) did not resolve to solids`,
        "re-check solid-N ids — load_model re-lists them after topology-changing ops"
      );
      return shape;
    }
    try {
      const combined = combineSolids(oc, supportTargets, cleanup);
      const algo = op.variant === "emboss"
        ? keep(new oc.BRepAlgoAPI_Fuse_3(shell, combined))
        : keep(new oc.BRepAlgoAPI_Cut_3(combined, shell));
      if (!algo.IsDone()) {
        fail?.(
          `the wrap ${op.variant} boolean did not complete (IsDone() false)`,
          op.variant === "emboss"
            ? "the shell may miss every target solid — check the wrap placement against them"
            : "the shell may lie entirely outside the target solids"
        );
        return shape;
      }
      const result = keep(algo.Shape());
      const used = new Set(op.targets ?? []);
      const leftovers = solids.filter((s) => !used.has(s.id)).map((s) => s.solid);
      if (leftovers.length === 0 && debris.length === 0) return result;
      const rebuilt = keep(new oc.TopoDS_Compound());
      const rb = keep(new oc.BRep_Builder());
      rb.MakeCompound(rebuilt);
      // ribFused puts the fused result first; keep that order.
      rb.Add(rebuilt, result);
      for (const s of leftovers) rb.Add(rebuilt, s);
      for (const d of debris) rb.Add(rebuilt, d);
      return rebuilt;
    } catch {
      fail?.(
        `the wrap ${op.variant} boolean threw`,
        "the shell may miss every target solid — check the wrap placement against them"
      );
      return shape;
    }
  } catch (err) {
    fail?.(
      `the wrap builder threw (${err instanceof Error ? err.message : String(err)})`.slice(0, 160),
      "this is a builder-internal failure, not an operand problem — re-check the profile and target ids"
    );
    return shape;
  }
}

/**
 * Ordered closed boundary loop of a face via per-edge discretization +
 * greedy chaining. `BRepAdaptor_Curve_2` + `GCPnts_UniformDeflection_2` at
 * the shared `EDGE_DEFLECTION` (never varied — the enumerator-discipline
 * rule in `edgeEnumeration.ts`); endpoints coincide exactly on shared
 * vertices, so a 1e-9 match is exact, not approximate. Returns the loop
 * WITHOUT repeating the first point at the end, or null when the edges
 * don't chain into one closed loop.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapBoundaryLoop(oc: any, face: any, cleanup: Array<{ delete(): void }>): Vec3[] | null {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    const wire = keep(oc.BRepTools.OuterWire(face));
    const exp = keep(new oc.TopExp_Explorer_2(wire, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
    const edgeHandles: any[] = [];
    while (exp.More()) { edgeHandles.push(keep(oc.TopoDS.Edge_1(exp.Current()))); exp.Next(); }
    if (edgeHandles.length === 0) return null;
    const polylines: Vec3[][] = [];
    for (const edge of edgeHandles) {
      const curve = keep(new oc.BRepAdaptor_Curve_2(edge));
      const disc = keep(new oc.GCPnts_UniformDeflection_2(curve, EDGE_DEFLECTION, false));
      if (!disc.IsDone() || disc.NbPoints() < 2) return null;
      polylines.push(polylineToVec3(disc));
    }
    // Greedy chain by endpoint coincidence.
    const used = new Array<boolean>(polylines.length).fill(false);
    const ordered: Vec3[] = [...polylines[0]];
    used[0] = true;
    const dist2 = (a: Vec3, b: Vec3): number => {
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      const dz = a[2] - b[2];
      return dx * dx + dy * dy + dz * dz;
    };
    const TOL2 = 1e-18; // (1e-9)^2 — exact coincidence, not approximate
    for (let k = 1; k < polylines.length; k++) {
      const end = ordered[ordered.length - 1];
      let found = -1;
      let flip = false;
      for (let i = 0; i < polylines.length; i++) {
        if (used[i]) continue;
        const p = polylines[i];
        if (dist2(p[0], end) < TOL2) { found = i; flip = false; break; }
        if (dist2(p[p.length - 1], end) < TOL2) { found = i; flip = true; break; }
      }
      if (found < 0) return null;
      used[found] = true;
      const p = flip ? [...polylines[found]].reverse() : polylines[found];
      ordered.push(...p.slice(1));
    }
    // Must close back on the start.
    if (dist2(ordered[ordered.length - 1], ordered[0]) >= TOL2) return null;
    ordered.pop();
    return ordered.length >= 3 ? ordered : null;
  } catch {
    return null;
  }
}

/** `Float32Array` xyz polyline → `Vec3[]` (the discretizer's flat layout). */
function polylineToVec3(disc: { NbPoints(): number; Value(i: number): { X(): number; Y(): number; Z(): number; delete(): void } }): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 1; i <= disc.NbPoints(); i++) {
    const pt = disc.Value(i);
    out.push([pt.X(), pt.Y(), pt.Z()]);
    pt.delete();
  }
  return out;
}

/**
 * Thickened closed shell around the developed profile: two one-sided
 * `PerformByJoin` offsets (±thickness/2) pulled as single faces (never ask
 * the offsetter for a solid — the red whole-solid finding), `OuterWire` ×
 * 2 through `ThruSections` (which already returns a closed solid with
 * shared topology, probed), plus a confirming fresh-instance sew
 * (`NbFreeEdges() == 0` gate, tolerance ladder as built-in sweep) before
 * `MakeSolid_3` + orient-positive. Returns the shell solid or null (with
 * `fail` already carrying the specific reason).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapThickenedShell(
  oc: any,
  loop: Vec3[],
  O: Vec3,
  xdir: Vec3,
  ydir: Vec3,
  phi: number,
  s0: number,
  refR: number,
  cosA: number,
  sinA: number,
  op: Extract<EditOp, { op: "wrap" }>,
  cleanup: Array<{ delete(): void }>,
  fail?: OutcomeFail
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    const isCone = op.target === "cone";
    const dot3 = (p: Vec3, d: Vec3, o: Vec3): number =>
      (p[0] - o[0]) * d[0] + (p[1] - o[1]) * d[1] + (p[2] - o[2]) * d[2];
    // uvOf maps a sketch-boundary 3D point to development (u, v) with u
    // UNSHIFTED (the seam shift applies once, below). Null at non-positive
    // radius — the cone-apex crossing.
    const uvOf = (p: Vec3): [number, number] | null => {
      const x = dot3(p, xdir, O);
      const y = dot3(p, ydir, O);
      const r = isCone ? op.radius + (s0 + y) * sinA : op.radius;
      if (!(r > 1e-9)) return null;
      return [x / r, s0 + y];
    };
    const apexFail = (): null => {
      fail?.(
        "the wrap profile crosses the cone apex (radius ≤ 0 there)",
        "move the sketch or widen the cone angle so every point stays at positive radius"
      );
      return null;
    };
    // Coarse pass over the loop vertices: apex + span guards live here, on
    // exact vertex positions (subdivision can only shrink spans).
    const coarse: Array<[number, number]> = [];
    for (const p of loop) {
      const q = uvOf(p);
      if (!q) return apexFail();
      coarse.push(q);
    }
    let minA = Infinity;
    let maxA = -Infinity;
    for (const [u] of coarse) {
      if (u < minA) minA = u;
      if (u > maxA) maxA = u;
    }
    if (!(maxA - minA < 2 * Math.PI - 1e-9)) {
      fail?.(
        "the wrap profile spans a full turn or more around the target",
        "a developed loop wider than the target circumference would self-overlap — use a narrower profile or a larger radius"
      );
      return null;
    }
    // Analytic development surface. Cylinder: (angle, axial height).
    // Cone: (angle, slant) — the cone's V parameter IS slant distance
    // (probed live: Value(0,10) sits at r=R+10·sin α, z=10·cos α).
    const hSurf = op.target === "cone"
      ? keep(new oc.Handle_Geom_Surface_2(
        new oc.Geom_ConicalSurface_1(
          keep(new oc.gp_Ax3_4(keep(pnt(oc, op.axisPoint)), keep(dir(oc, [op.axisDir[0], op.axisDir[1], op.axisDir[2]])))),
          Math.atan2(sinA, cosA),
          op.radius
        )
      ))
      : keep(new oc.Handle_Geom_Surface_2(
        new oc.Geom_CylindricalSurface_1(
          keep(new oc.gp_Ax3_4(keep(pnt(oc, op.axisPoint)), keep(dir(oc, [op.axisDir[0], op.axisDir[1], op.axisDir[2]])))),
          op.radius
        )
      ));
    // pcurve loop on the development surface, u centred on (-π, π] so no
    // segment crosses the periodic seam (a 2π shift is the identity, so
    // this changes placement not at all).
    const meanA = (minA + maxA) / 2;
    const shift = Math.round((meanA + phi) / (2 * Math.PI)) * 2 * Math.PI;
    const sh = (q: [number, number]): [number, number] => [phi + q[0] - shift, q[1]];
    // Adaptive midpoint subdivision per span: a straight sketch line maps
    // to a CURVED uv path on a cone (θ = x/r(y)), so straight uv chords
    // would inflate the area (+0.4% measured on the cone fixture — caught
    // by smoke, not review). Subdividing at 3D chord midpoints is exact
    // for straight sketch edges (the midpoint lies on the boundary) and
    // bounded by the base 0.1-deflection discretization for curved ones;
    // endpoints are preserved, so loop chaining is unaffected.
    //
    // Tolerance is 1e-9 in (u, v) — NOT tightened further on purpose:
    // ~2000 spans per long edge at 1e-9 demonstrably hangs the run
    // (offsetter over thousands of near-collinear micro-edges), while
    // 1e-7 needs ~170 and bounds the area error to ~1e-5. Same philosophy
    // as the shared EDGE_DEFLECTION: a stated discretization tolerance,
    // not silent exactness.
    const SUB_TOL = 1e-6;
    const SUB_DEPTH = 14;
    let apexHit = false;
    const subdivide = (
      p0: Vec3, q0: [number, number], p1: Vec3, q1: [number, number],
      depth: number, acc: Array<[number, number]>
    ): void => {
      const mx: Vec3 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
      const mq = uvOf(mx);
      if (!mq) { apexHit = true; return; }
      const ms = sh(mq);
      const du = ms[0] - (q0[0] + q1[0]) / 2;
      const dv = ms[1] - (q0[1] + q1[1]) / 2;
      if (du * du + dv * dv <= SUB_TOL * SUB_TOL || depth >= SUB_DEPTH) {
        acc.push(q1);
        return;
      }
      subdivide(p0, q0, mx, ms, depth + 1, acc);
      if (!apexHit) subdivide(mx, ms, p1, q1, depth + 1, acc);
    };
    const refined: Array<[number, number]> = [];
    for (let i = 0; i < coarse.length; i++) {
      const a3 = loop[i];
      const b3 = loop[(i + 1) % loop.length];
      const qa = sh(coarse[i]);
      const qb = sh(coarse[(i + 1) % coarse.length]);
      if (i === 0) refined.push(qa);
      subdivide(a3, qa, b3, qb, 0, refined);
      if (apexHit) return apexFail();
    }
    // The last span's endpoint IS the first point (closed loop) — drop the
    // duplicate or the wire builder sees a zero-length span.
    if (refined.length > 1) {
      const f = refined[0];
      const l = refined[refined.length - 1];
      const dx = l[0] - f[0];
      const dy = l[1] - f[1];
      if (dx * dx + dy * dy < 1e-18) refined.pop();
    }
    const uv = refined;
    const wireMk = keep(new oc.BRepBuilderAPI_MakeWire_1());
    for (let i = 0; i < uv.length; i++) {
      const [u1, v1] = uv[i];
      const [u2, v2] = uv[(i + 1) % uv.length];
      const seg = keep(new oc.GCE2d_MakeSegment_1(keep(new oc.gp_Pnt2d_3(u1, v1)), keep(new oc.gp_Pnt2d_3(u2, v2))));
      if (!seg.IsDone()) {
        fail?.("the developed profile has a degenerate span", "the sketch boundary may contain a zero-length run");
        return null;
      }
      const h2d = keep(new oc.Handle_Geom2d_Curve_2(keep(seg.Value()).get()));
      const mkEdge = keep(new oc.BRepBuilderAPI_MakeEdge_30(h2d, hSurf));
      if (!mkEdge.IsDone()) {
        fail?.("a developed profile edge failed to build", "the sketch boundary may be self-intersecting");
        return null;
      }
      const edge = keep(mkEdge.Edge());
      if (edge.IsNull()) {
        fail?.("a developed profile edge is null", "the sketch boundary may be self-intersecting");
        return null;
      }
      oc.BRepLib.BuildCurves3d_2(edge);
      wireMk.Add_1(edge);
    }
    if (!wireMk.IsDone()) {
      fail?.("the developed profile wire did not close", "the sketch boundary may be self-intersecting");
      return null;
    }
    const devFace = keep(new oc.BRepBuilderAPI_MakeFace_21(hSurf, keep(wireMk.Wire()), true).Face());
    if (!devFace || devFace.IsNull()) {
      fail?.("the developed face failed to build", "the sketch boundary may be self-intersecting on the target surface");
      return null;
    }
    // Two one-sided offsets, single faces pulled via explorer (csgModel
    // style — PerformByJoin wraps its face in a shell).
    const offFaces: any[] = [];
    for (const d of [op.thickness / 2, -(op.thickness / 2)]) {
      const mk = keep(new oc.BRepOffsetAPI_MakeOffsetShape_1());
      mk.PerformByJoin(
        devFace, d, 1e-6,
        oc.BRepOffset_Mode.BRepOffset_Skin.value, false, false,
        oc.GeomAbs_JoinType.GeomAbs_Arc.value, false
      );
      if (!mk.IsDone()) {
        fail?.(
          `the wrap thickening offset (d=${d}) did not complete`,
          "the wall may be thicker than the profile's narrowest half-width — reduce thickness"
        );
        return null;
      }
      const exp = keep(new oc.TopExp_Explorer_2(keep(mk.Shape()), oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
      let found: any = null;
      let n = 0;
      while (exp.More()) { n++; found = exp.Current(); exp.Next(); }
      if (n !== 1 || !found) {
        fail?.(
          `the wrap thickening offset (d=${d}) produced ${n} faces, not one`,
          "the wall may be thicker than the profile's narrowest half-width — reduce thickness"
        );
        return null;
      }
      offFaces.push(keep(oc.TopoDS.Face_1(found)));
    }
    const wires = offFaces.map((f) => keep(oc.BRepTools.OuterWire(f)));
    const ts = keep(new oc.BRepOffsetAPI_ThruSections(true, false, 1.0e-6));
    ts.AddWire(wires[0]);
    ts.AddWire(wires[1]);
    ts.Build();
    if (!ts.IsDone()) {
      fail?.("the wrap wall skirt failed to build", "the developed loop may be degenerate on the target surface");
      return null;
    }
    const closed = keep(ts.Shape());
    if (closed.IsNull() || closed.ShapeType().value !== oc.TopAbs_ShapeEnum.TopAbs_SOLID.value) {
      fail?.("the wrap wall did not close into a solid", "the developed loop may be degenerate on the target surface");
      return null;
    }
    // Confirming sew (fresh instance, ladder as built-in sweep): the probe
    // showed ThruSections already shares topology, so this is a safety net,
    // not the closer — but a nonzero free-edge count here means a genuinely
    // open wall, which must never ship silently.
    const fexp = keep(new oc.TopExp_Explorer_2(closed, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
    const parts: any[] = [];
    while (fexp.More()) { parts.push(keep(oc.TopoDS.Face_1(fexp.Current()))); fexp.Next(); }
    let sewed: any = null;
    for (const tol of [1e-6, 1e-5, 1e-4, 1e-3, 1e-2]) {
      const sew = keep(new oc.BRepBuilderAPI_Sewing(tol, true, true, true, false));
      for (const f of parts) sew.Add(f);
      sew.Perform(keep(new oc.Handle_Message_ProgressIndicator_1()));
      if (sew.NbFreeEdges() === 0) { sewed = keep(sew.SewedShape()); break; }
    }
    if (!sewed) {
      fail?.("the wrap wall did not sew closed (free edges at every tolerance)", "the developed loop may be degenerate on the target surface");
      return null;
    }
    const shexp = keep(new oc.TopExp_Explorer_2(sewed, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
    if (!shexp.More()) {
      fail?.("the wrap wall produced no shell", "the developed loop may be degenerate on the target surface");
      return null;
    }
    const solid = keep(new oc.BRepBuilderAPI_MakeSolid_3(keep(oc.TopoDS.Shell_1(shexp.Current()))).Solid());
    const oriented = orientPositiveVolume(oc, solid, cleanup);
    if (!oriented) {
      fail?.("the wrap wall collapsed to zero volume", "the wall may be thicker than the profile's narrowest half-width — reduce thickness");
      return null;
    }
    return oriented;
  } catch (err) {
    fail?.(
      `the wrap builder threw (${err instanceof Error ? err.message : String(err)})`.slice(0, 160),
      "this is a builder-internal failure, not an operand problem — re-check the profile and target ids"
    );
    return null;
  }
}

/**
 * Splits a model shape into its solids vs everything else (free sketch faces,
 * loose wireframe edges, standalone points). A rib fuses against the solids
 * ONLY: loose debris in the fused operand makes `Fuse_3` return
 * `IsDone() === false` (probed live — an identical prism+boxes fuses clean,
 * but fails with two loose edges added to the compound — so this is load-
 * bearing, not hygiene). Debris carries over untouched around the fused
 * bodies, in original relative order. `HashCode`-bucket + `IsSame` is the
 * established dedup technique (`enumerateEdges`, the free-face pass).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function splitSolidsAndDebris(oc: any, shape: any, cleanup: Array<{ delete(): void }>): { solids: any[]; debris: any[] } {
  const solids = collectSolids(oc, shape, cleanup).map((s) => s.solid);
  const owned = new Map<number, any[]>();
  const own = (h: any): void => {
    const k = h.HashCode(1 << 30);
    let b = owned.get(k);
    if (!b) { b = []; owned.set(k, b); }
    b.push(h);
  };
  for (const s of solids) {
    for (const f of collectFaces(oc, s, cleanup)) own(f);
    for (const e of collectEdges(oc, s, cleanup)) own(e);
    for (const v of collectVertices(oc, s, cleanup)) own(v);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isOwned = (h: any): boolean => {
    const b = owned.get(h.HashCode(1 << 30));
    return b !== undefined && b.some((o) => o.IsSame(h));
  };
  const debris = [
    ...collectFaces(oc, shape, cleanup).filter((f) => !isOwned(f)),
    ...collectEdges(oc, shape, cleanup).filter((e) => !isOwned(e)),
    ...collectVertices(oc, shape, cleanup).filter((v) => !isOwned(v)),
  ];
  return { solids, debris };
}

/** Builds the new solid for a feature op, or null on unresolved operands / failure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildFeatureSolid(oc: any, shape: any, op: EditOp, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    switch (op.op) {
      case "extrude": {
        const faces = featureProfileFaces(oc, shape, op, cleanup, fail);
        if (!faces) return null;
        // Terminator form derives the length from the up-to-face plane;
        // explicit-length form uses it directly. Either way the SAME prism
        // builder below runs, so thin-wall handling, Copy=false start-cap
        // identity, and bucket roles behave identically for both forms. The
        // plane math reads the first region face — every region of one
        // profile shares its sketch plane.
        let length = op.length;
        if (op.upToFace !== undefined) {
          const derived = extrudeLengthUpToFace(oc, shape, faces[0], op, cleanup, fail);
          if (derived === null) return null;
          length = derived;
        }
        if (length === undefined || !Number.isFinite(length)) {
          fail?.("extrusion has neither a usable length nor a resolvable up-to-face terminator");
          return null;
        }
        const tool = prismsForFaces(oc, faces, op.dir, length, cleanup, fail);
        if (!tool) return null;
        return finishThin(oc, op, tool, cleanup);
      }
      case "revolve": {
        const faces = featureProfileFaces(oc, shape, op, cleanup, fail);
        if (!faces) return null;
        const ax = keep(new oc.gp_Ax1_2(keep(pnt(oc, op.axisPoint)), keep(dir(oc, op.axisDir))));
        const angle = (op.angleDeg * Math.PI) / 180;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bodies: any[] = [];
        for (const face of faces) {
          bodies.push(keep(keep(new oc.BRepPrimAPI_MakeRevol_1(face, ax, angle, false)).Shape()));
        }
        const tool = bodies.length === 1 ? bodies[0] : combineSolids(oc, bodies, cleanup);
        return finishThin(oc, op, tool, cleanup);
      }
      case "sweep": {
        const edge = collectEdges(oc, shape, cleanup)[edgeIndex(op.path)];
        if (!edge) { fail?.(`the sweep path ${op.path} did not resolve to an edge`); return null; }
        // Verified live: MakePipe_1 sweeps an ANNULAR profile correctly on a
        // straight spine (exactly 1280 for a 64-area band over length 20) AND
        // on a 90-degree arc spine (2010.6193, matching Pappus exactly), so
        // thin sweep needs no outer/inner-and-cut fallback. It sweeps an
        // open-profile band the same way (verified: 462.8318 for a 23.1416
        // band over length 20).
        const faces = featureProfileFaces(oc, shape, op, cleanup, fail);
        if (!faces) return null;
        const wire = keep(new oc.BRepBuilderAPI_MakeWire_2(edge)).Wire();
        keep(wire);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bodies: any[] = [];
        for (const face of faces) {
          bodies.push(keep(keep(new oc.BRepOffsetAPI_MakePipe_1(wire, face)).Shape()));
        }
        const tool = bodies.length === 1 ? bodies[0] : combineSolids(oc, bodies, cleanup);
        return finishThin(oc, op, tool, cleanup);
      }
      case "loft": {
        // One section per profile, in either operand form. Unlike the other
        // three, loft historically filtered unresolved ids out silently and
        // only failed below 2 survivors; resolving each section explicitly
        // reports WHICH one is missing instead.
        const sections: ProfileSection[] = [];
        if (op.profiles) {
          for (const id of op.profiles) {
            const section = resolveProfileSection(oc, shape, id, undefined, cleanup, fail);
            if (!section) return null;
            sections.push(section);
          }
        } else {
          for (const ids of op.profileEdgeSets ?? []) {
            const section = resolveProfileSection(oc, shape, undefined, ids, cleanup, fail);
            if (!section) return null;
            sections.push(section);
          }
        }
        if (sections.length < 2) { fail?.("loft needs at least 2 profile sections"); return null; }
        // Every section must agree, because the two thin constructions are
        // genuinely different shapes — a closed section yields an outer and an
        // inner boundary to loft and cut, an open one a single band boundary.
        const open = sections.filter((s) => !s.closed).length;
        if (open !== 0 && open !== sections.length) {
          fail?.("loft mixes open and closed profile sections", "every section must close, or none — the two build a thin wall in different ways");
          return null;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const loftWires = (ws: any[], smoothing?: boolean): any => {
          const ts = keep(new oc.BRepOffsetAPI_ThruSections(true, false, 1.0e-6));
          for (const w of ws) ts.AddWire(w);
          // The only ThruSections knob with a measured effect in this build
          // (probed: smoothing moves a 4-section twisted loft -0.711%;
          // SetContinuity/SetParType/SetMaxDegree/SetCriteriumWeight are
          // accepted but change nothing, so they are deliberately NOT
          // exposed). Applies to every loft path below, thin included.
          if (smoothing === true) ts.SetSmoothing(true);
          ts.Build();
          return ts.IsDone() ? keep(ts.Shape()) : null;
        };
        const spec = thinSpecOf(op);
        if (!spec) {
          if (open > 0) { fail?.(...openProfileNeedsThin(sections.find((s) => !s.closed)!)); return null; }
          return loftWires(sections.map((s) => s.wire), (op as Extract<EditOp, { op: "loft" }>).smoothing);
        }
        if (open > 0) {
          // An open section's band is ONE closed boundary, so it lofts
          // directly — no outer/inner pair and no cut. Verified: two identical
          // 23.1416 bands 10 apart loft to 231.4159.
          if (!openThinOuterOk(op, spec)) { fail?.(...openProfileThinOuter()); return null; }
          const bands = sections.map((s) => openBandWire(oc, s.wire, spec.thin, cleanup));
          if (bands.some((b) => b === null)) { fail?.("could not build a wall around every open loft section"); return null; }
          return finishThin(oc, op, loftWires(bands, (op as Extract<EditOp, { op: "loft" }>).smoothing), cleanup);
        }
        const holed = sections.find((s) => s.holed);
        if (holed) { fail?.(`the loft profile ${holed.label} already has a hole`, "a thin wall is built from the outer boundary alone, which would silently discard it"); return null; }
        // `ThruSections` is WIRE-based and keeps only the wires it is given, so
        // handing it an annular band face's outer wire would silently loft a
        // FILLED solid (verified: 813.33 for a case whose thin answer is 560).
        // Loft the two band boundaries as separate solids and cut instead —
        // verified exact (outer 1000, inner 360, cut 640).
        const bands = sections.map((s) => thinProfileWires(oc, s.wire, spec.thin, spec.thinOuter, cleanup));
        if (bands.some((b) => b === null)) return null;
        const outerSolid = loftWires(bands.map((b) => b!.outer), (op as Extract<EditOp, { op: "loft" }>).smoothing);
        const innerSolid = loftWires(bands.map((b) => b!.inner), (op as Extract<EditOp, { op: "loft" }>).smoothing);
        if (!outerSolid || !innerSolid) return null;
        const cut = keep(new oc.BRepAlgoAPI_Cut_3(outerSolid, innerSolid));
        if (!cut.IsDone()) return null;
        return finishThin(oc, op, keep(cut.Shape()), cleanup);
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Primitive creation: builds a new solid from scratch (no existing operands) and
 * **appends** it to the model as an extra body — same non-destructive
 * `compound(existing shape + new solid)` pattern as {@link featureModel}. A
 * primitive whose builder throws is skipped so replay never hard-fails.
 *
 * OCCT primitive API, verified against the live WASM (see CLAUDE.md):
 *   box      → `BRepPrimAPI_MakeBox_3(gp_Pnt_3 corner1, gp_Pnt_3 corner2)`
 *   sphere   → `BRepPrimAPI_MakeSphere_5(gp_Pnt_3 center, radius)`
 *   cylinder → `BRepPrimAPI_MakeCylinder_3(gp_Ax2_3(pnt, dir), radius, height)`
 *   cone     → `BRepPrimAPI_MakeCone_3(gp_Ax2_3(pnt, dir), radius1, radius2, height)`
 *   torus    → `BRepPrimAPI_MakeTorus_5(gp_Ax2_3(pnt, dir), majorRadius, minorRadius)`
 * (`gp_Ax2` placement means cylinder/cone/torus are addressed as an OCCT
 * `location`+`direction` pair — the base for cylinder/cone, the ring centre/normal
 * for torus. `Bnd_Box` confirms cylinder/cone are **base-centred**, matching this
 * op family's `center` semantics.) There is no OCCT "regular polygon" primitive,
 * so the N-gon prism is built manually: N points around `center` in the plane
 * perpendicular to `axis` → `BRepBuilderAPI_MakeWire_1` + `.Add_1()` per
 * `BRepBuilderAPI_MakeEdge_3(pnt, pnt)` edge → `BRepBuilderAPI_MakeFace_15(wire,
 * true)` → the already-verified `BRepPrimAPI_MakePrism_1(face, vec, false, true)`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addPrimitive(oc: any, shape: any, op: EditOp, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const solid = buildPrimitiveSolid(oc, op, cleanup);
  if (!solid) {
    fail?.(`could not build the ${op.op} body`, "check the primitive's parameters (radii/sizes must be positive, axis a non-zero direction)");
    return shape;
  }
  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  builder.Add(comp, shape);
  builder.Add(comp, solid);
  return comp;
}

/** Builds the new primitive solid, or null on builder failure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildPrimitiveSolid(oc: any, op: EditOp, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    switch (op.op) {
      case "addBox": {
        const [cx, cy, cz] = op.center;
        const [sx, sy, sz] = op.size;
        const c1 = keep(pnt(oc, [cx - sx / 2, cy - sy / 2, cz - sz / 2]));
        const c2 = keep(pnt(oc, [cx + sx / 2, cy + sy / 2, cz + sz / 2]));
        return keep(keep(new oc.BRepPrimAPI_MakeBox_3(c1, c2)).Shape());
      }
      case "addSphere": {
        const center = keep(pnt(oc, op.center));
        return keep(keep(new oc.BRepPrimAPI_MakeSphere_5(center, op.radius)).Shape());
      }
      case "addCylinder": {
        const ax2 = keep(new oc.gp_Ax2_3(keep(pnt(oc, op.center)), keep(dir(oc, op.axis))));
        return keep(keep(new oc.BRepPrimAPI_MakeCylinder_3(ax2, op.radius, op.height)).Shape());
      }
      case "addCone": {
        const ax2 = keep(new oc.gp_Ax2_3(keep(pnt(oc, op.center)), keep(dir(oc, op.axis))));
        return keep(keep(new oc.BRepPrimAPI_MakeCone_3(ax2, op.radius1, op.radius2, op.height)).Shape());
      }
      case "addTorus": {
        const ax2 = keep(new oc.gp_Ax2_3(keep(pnt(oc, op.center)), keep(dir(oc, op.axis))));
        return keep(keep(new oc.BRepPrimAPI_MakeTorus_5(ax2, op.majorRadius, op.minorRadius)).Shape());
      }
      case "addPrism": {
        const [ux, vx] = planeBasis(op.axis);
        const points = regularPolygonPoints(op.center, ux, vx, op.radius, op.sides, op.circumscribed);
        const face = buildFlatFace(oc, points, cleanup);
        if (!face) return null;
        const [ax, ay, az] = op.axis;
        const len = Math.hypot(ax, ay, az) || 1;
        const s = op.height / len;
        const extrudeVec = keep(new oc.gp_Vec_4(ax * s, ay * s, az * s));
        return keep(keep(new oc.BRepPrimAPI_MakePrism_1(face, extrudeVec, false, true)).Shape());
      }
      case "addWedge": {
        // `BRepPrimAPI_MakeWedge_2(gp_Ax2, dx, dy, dz, ltx)`, verified against
        // the live WASM: the Ax2 location is the wedge's local ORIGIN corner
        // (local x → Ax2 X-dir, local z → Ax2 main dir), so offset it by
        // −dx/2·u −dy/2·v to make `center` the centre of the base rectangle —
        // matching the base-centre convention of the other extruded primitives.
        const [u, v] = inPlaneBasis(op.axis, op.up);
        const origin = addScaled(op.center, u, -op.dx / 2, v, -op.dy / 2);
        const ax2 = keep(new oc.gp_Ax2_2(keep(pnt(oc, origin)), keep(dir(oc, op.axis)), keep(dir(oc, u))));
        return keep(keep(new oc.BRepPrimAPI_MakeWedge_2(ax2, op.dx, op.dy, op.dz, op.ltx)).Shape());
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Builds a closed planar face from an ordered loop of points, connecting them
 * with straight edges — the shared wire/face pattern behind the N-gon prism
 * (subsequently extruded) and the flat rectangle/polygon profiles (used as-is).
 * OCCT API, verified against the live WASM (see CLAUDE.md):
 * `BRepBuilderAPI_MakeWire_1` + `.Add_1()` per `BRepBuilderAPI_MakeEdge_3(pnt,
 * pnt)` edge → `BRepBuilderAPI_MakeFace_15(wire, true)`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildFlatFace(oc: any, points: Vec3[], cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  const pts = points.map((p) => keep(pnt(oc, p)));
  const mkWire = keep(new oc.BRepBuilderAPI_MakeWire_1());
  for (let i = 0; i < pts.length; i++) {
    const edge = keep(new oc.BRepBuilderAPI_MakeEdge_3(pts[i], pts[(i + 1) % pts.length])).Edge();
    keep(edge);
    mkWire.Add_1(edge);
  }
  if (!mkWire.IsDone()) return null;
  const wire = keep(mkWire.Wire());
  const face = keep(new oc.BRepBuilderAPI_MakeFace_15(wire, true)).Face();
  return face.IsNull() ? null : keep(face);
}

/** N points evenly spaced around `center` on the circle of `radius` spanned by
 * orthonormal in-plane basis (`u`, `v`). When `circumscribed` is true,
 * `radius` is the apothem (the circle is INSIDE the polygon, sides tangent). */
function regularPolygonPoints(center: Vec3, u: Vec3, v: Vec3, radius: number, sides: number, circumscribed?: boolean): Vec3[] {
  const r = circumscribed ? radius / Math.cos(Math.PI / sides) : radius;
  const points: Vec3[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (2 * Math.PI * i) / sides;
    points.push(addScaled(center, u, Math.cos(a) * r, v, Math.sin(a) * r));
  }
  return points;
}

/**
 * 2D profile creation: builds a new standalone flat face (no thickness) and
 * **appends** it to the model — same non-destructive `compound(existing + new)`
 * pattern as {@link addPrimitive}/{@link featureModel}, except the appended body
 * here is a bare `TopoDS_Face`, not a solid. `tessellateByGroup`'s free-face pass
 * (`src/meshExtract.ts`) is what makes it visible/pickable afterward — without
 * that, a loose face mixed into a compound alongside real solids would be
 * silently dropped from tessellation. A profile whose builder throws is skipped.
 *
 * OCCT circle API, verified against the live WASM: `gp_Circ_2(gp_Ax2_3(pnt,
 * normal), radius)` → `BRepBuilderAPI_MakeEdge_8(circ)` → `BRepBuilderAPI_
 * MakeWire_1` + `.Add_1()` → `BRepBuilderAPI_MakeFace_15(wire, true)`.
 * Rectangle/polygon use {@link buildFlatFace} with corners computed via
 * {@link inPlaneBasis} (unlike the 3D primitives' `planeBasis`, this derives the
 * in-plane `u` axis from the op's `up` vector so orientation is user-controlled,
 * not arbitrary — needed here because width ≠ height / polygon phase matters for
 * a flat sketch in a way it mostly doesn't for a solid of revolution).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addProfile(oc: any, shape: any, op: EditOp, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail, guideCollector?: GuideCollector): any {
  const face = buildProfileFace(oc, op, cleanup);
  if (!face) {
    fail?.(`could not build the ${op.op} sketch face`, "check the profile's parameters (radius/width/height must be positive, normal a non-zero direction)");
    return shape;
  }
  if ((op as any).guide) guideCollector?.faces.push(face);
  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  builder.Add(comp, shape);
  builder.Add(comp, face);
  return comp;
}

/** Builds the new profile face, or null on builder failure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildProfileFace(oc: any, op: EditOp, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    switch (op.op) {
      case "addCircleProfile": {
        const ax2 = keep(new oc.gp_Ax2_3(keep(pnt(oc, op.center)), keep(dir(oc, op.normal))));
        const circ = keep(new oc.gp_Circ_2(ax2, op.radius));
        const edge = keep(keep(new oc.BRepBuilderAPI_MakeEdge_8(circ)).Edge());
        const mkWire = keep(new oc.BRepBuilderAPI_MakeWire_1());
        mkWire.Add_1(edge);
        if (!mkWire.IsDone()) return null;
        const wire = keep(mkWire.Wire());
        const face = keep(new oc.BRepBuilderAPI_MakeFace_15(wire, true)).Face();
        return face.IsNull() ? null : keep(face);
      }
      case "addRectangleProfile": {
        const [u, v] = inPlaneBasis(op.normal, op.up);
        const hw = op.width / 2, hh = op.height / 2;
        const corners: Vec3[] = [
          addScaled(op.center, u, -hw, v, -hh),
          addScaled(op.center, u, hw, v, -hh),
          addScaled(op.center, u, hw, v, hh),
          addScaled(op.center, u, -hw, v, hh),
        ];
        return buildFlatFace(oc, corners, cleanup);
      }
      case "addPolygonProfile": {
        const [u, v] = inPlaneBasis(op.normal, op.up);
        return buildFlatFace(oc, regularPolygonPoints(op.center, u, v, op.radius, op.sides, op.circumscribed), cleanup);
      }
      case "addEllipseProfile": {
        // `gp_Elips_2(ax2, major, minor)` requires major ≥ minor; when radiusY
        // is the larger, rotate the in-plane basis 90° (major axis along `v`)
        // and swap the radii instead. `gp_Ax2_2(pnt, normal, xdir)` pins the
        // ellipse's major axis to an explicit in-plane X direction (verified:
        // it projects/normalizes the given X into the plane).
        const [u, v] = inPlaneBasis(op.normal, op.up);
        const swap = op.radiusY > op.radiusX;
        const major = swap ? op.radiusY : op.radiusX;
        const minor = swap ? op.radiusX : op.radiusY;
        const xdir = swap ? v : u;
        const ax2 = keep(new oc.gp_Ax2_2(keep(pnt(oc, op.center)), keep(dir(oc, op.normal)), keep(dir(oc, xdir))));
        const elips = keep(new oc.gp_Elips_2(ax2, major, minor));
        const edge = keep(keep(new oc.BRepBuilderAPI_MakeEdge_12(elips)).Edge());
        return faceFromEdges(oc, [edge], cleanup);
      }
      case "addRoundedRectangleProfile": {
        // 4 straight edges + 4 quarter-circle corner arcs. Corner-arc angles
        // are measured from each arc's own `gp_Ax2_2` explicit X direction
        // (`u`), which makes the quadrant math deterministic pure JS.
        const [u, v] = inPlaneBasis(op.normal, op.up);
        const at = (du: number, dv: number): Vec3 => addScaled(op.center, u, du, v, dv);
        const hw = op.width / 2, hh = op.height / 2, r = op.cornerRadius;
        const arc = (c: Vec3, a1: number, a2: number) => cornerArcEdge(oc, c, op.normal, u, r, a1, a2, cleanup);
        const line = (p1: Vec3, p2: Vec3) =>
          keep(keep(new oc.BRepBuilderAPI_MakeEdge_3(keep(pnt(oc, p1)), keep(pnt(oc, p2)))).Edge());
        const edges = [
          line(at(-(hw - r), -hh), at(hw - r, -hh)),          // bottom
          arc(at(hw - r, -(hh - r)), -Math.PI / 2, 0),        // bottom-right corner
          line(at(hw, -(hh - r)), at(hw, hh - r)),            // right
          arc(at(hw - r, hh - r), 0, Math.PI / 2),            // top-right corner
          line(at(hw - r, hh), at(-(hw - r), hh)),            // top
          arc(at(-(hw - r), hh - r), Math.PI / 2, Math.PI),   // top-left corner
          line(at(-hw, hh - r), at(-hw, -(hh - r))),          // left
          arc(at(-(hw - r), -(hh - r)), Math.PI, Math.PI * 1.5), // bottom-left corner
        ];
        return faceFromEdges(oc, edges, cleanup);
      }
      case "addSlotProfile": {
        // A stadium: two straight edges + two semicircular end caps, overall
        // `length` along `u` (so `up` is the slot's long axis).
        const [u, v] = inPlaneBasis(op.normal, op.up);
        const at = (du: number, dv: number): Vec3 => addScaled(op.center, u, du, v, dv);
        const r = op.width / 2;
        const cx = op.length / 2 - r; // end-cap centres at ±cx
        const arc = (c: Vec3, a1: number, a2: number) => cornerArcEdge(oc, c, op.normal, u, r, a1, a2, cleanup);
        const line = (p1: Vec3, p2: Vec3) =>
          keep(keep(new oc.BRepBuilderAPI_MakeEdge_3(keep(pnt(oc, p1)), keep(pnt(oc, p2)))).Edge());
        const edges = [
          line(at(-cx, -r), at(cx, -r)),                   // bottom
          arc(at(cx, 0), -Math.PI / 2, Math.PI / 2),       // right cap
          line(at(cx, r), at(-cx, r)),                     // top
          arc(at(-cx, 0), Math.PI / 2, Math.PI * 1.5),     // left cap
        ];
        return faceFromEdges(oc, edges, cleanup);
      }
      case "addTrapezoidProfile": {
        const [u, v] = inPlaneBasis(op.normal, op.up);
        const hb = op.bottomWidth / 2, ht = op.topWidth / 2, hh = op.height / 2;
        const corners: Vec3[] = [
          addScaled(op.center, u, -hb, v, -hh),
          addScaled(op.center, u, hb, v, -hh),
          addScaled(op.center, u, ht, v, hh),
          addScaled(op.center, u, -ht, v, hh),
        ];
        return buildFlatFace(oc, corners, cleanup);
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * A circular-arc edge for rounded-wire profiles: the circle of `radius` at
 * `center`, in the plane of `normal`, with angles measured from the explicit
 * in-plane X direction `xdir` — `gp_Ax2_2(pnt, normal, xdir)` (verified against
 * the live WASM: the given X is projected into the plane and normalized) +
 * the already-verified `gp_Circ_2` + `BRepBuilderAPI_MakeEdge_9(circ, a1, a2)`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cornerArcEdge(oc: any, center: Vec3, normal: Vec3, xdir: Vec3, radius: number, a1: number, a2: number, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  const ax2 = keep(new oc.gp_Ax2_2(keep(pnt(oc, center)), keep(dir(oc, normal)), keep(dir(oc, xdir))));
  const circ = keep(new oc.gp_Circ_2(ax2, radius));
  return keep(keep(new oc.BRepBuilderAPI_MakeEdge_9(circ, a1, a2)).Edge());
}

/**
 * Assembles pre-built edges into a wire and caps it with a face — the shared
 * tail of every mixed line/arc profile (`MakeWire_1` auto-orders the edges by
 * shared vertices, so build order is forgiving; `MakeFace_15(wire, true)`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function faceFromEdges(oc: any, edges: any[], cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  const mkWire = keep(new oc.BRepBuilderAPI_MakeWire_1());
  for (const e of edges) mkWire.Add_1(e);
  if (!mkWire.IsDone()) return null;
  const wire = keep(mkWire.Wire());
  const face = keep(new oc.BRepBuilderAPI_MakeFace_15(wire, true)).Face();
  return face.IsNull() ? null : keep(face);
}

function addEdgeSlot(oc: any, shape: any, op: Extract<EditOp, { op: "addEdgeSlot" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  try {
    const edges = collectEdges(oc, shape, cleanup);
    const idx = edgeIndex(op.edge);
    const edge = edges[idx];
    if (!edge) {
      fail?.(`edge ${op.edge} does not resolve`);
      return shape;
    }
    const vExp = new oc.TopExp_Explorer_2(edge, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_VERTEX);
    cleanup.push(vExp);
    const pts: any[] = [];
    for (; vExp.More(); vExp.Next()) pts.push(oc.TopoDS.Vertex_1(vExp.Current()));
    if (pts.length < 2) {
      fail?.("edge has no endpoints");
      return shape;
    }
    const p1 = oc.BRep_Tool.Pnt(pts[0]);
    const p2 = oc.BRep_Tool.Pnt(pts[pts.length - 1]);
    const mid: Vec3 = [(p1.X() + p2.X()) / 2, (p1.Y() + p2.Y()) / 2, (p1.Z() + p2.Z()) / 2];
    const dir: Vec3 = [p2.X() - p1.X(), p2.Y() - p1.Y(), p2.Z() - p1.Z()];
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    if (len < 1e-9) {
      fail?.("edge is degenerate");
      return shape;
    }
    const totalLen = len + op.width;
    const hw = totalLen / 2, hw2 = op.width / 2;
    const { edgeFaces } = buildEdgeFaceAdjacency(oc, shape, cleanup);
    const bucket = edgeFaces.get(edge.HashCode(1 << 30));
    const entry = bucket?.find((b) => b.edge.IsSame(edge));
    let normal: Vec3 = [0, 0, 1];
    if (entry && entry.faceIdxs.length > 0) {
      const faces = collectFaces(oc, shape, cleanup);
      const f = faces[entry.faceIdxs[0]];
      const info = f ? facePlane(oc, f, cleanup) : null;
      if (info) normal = info.nl;
    }
    const [u, v] = inPlaneBasis(normal, dir as Vec3);
    const ux: Vec3 = [u[0] * hw, u[1] * hw, u[2] * hw];
    const vx: Vec3 = [v[0] * hw2, v[1] * hw2, v[2] * hw2];
    const corners: Vec3[] = [
      addScaled(mid, ux, -1, vx, -1),
      addScaled(mid, ux, 1, vx, -1),
      addScaled(mid, ux, 1, vx, 1),
      addScaled(mid, ux, -1, vx, 1),
    ];
    const face = buildFlatFace(oc, [corners[0], corners[1], corners[2], corners[3]], cleanup);
    if (!face) {
      fail?.("could not build slot face");
      return shape;
    }
    const comp = new oc.TopoDS_Compound();
    cleanup.push(comp);
    const builder = new oc.BRep_Builder();
    cleanup.push(builder);
    builder.MakeCompound(comp);
    builder.Add(comp, shape);
    builder.Add(comp, face);
    return comp;
  } catch {
    fail?.("addEdgeSlot threw");
    return shape;
  }
}

/**
 * Wireframe primitive creation (Point/Line/Arc): builds a bare `TopoDS_Vertex`
 * or `TopoDS_Edge` — no existing operands, no thickness — and **appends** it,
 * same non-destructive `compound(existing shape + new vertex/edge)` pattern as
 * {@link addPrimitive}/{@link addProfile}. Points are display-only (surfaced by
 * `extractVertices` in `src/meshExtract.ts`) and are never resolved as an
 * operand by any other op, so unlike faces this has no lockstep-pipeline
 * counterpart to keep in sync — appending a bare vertex/edge just works with
 * the existing unconditional whole-shape vertex/edge extraction. A wireframe
 * primitive whose builder throws is skipped.
 *
 * OCCT API, verified against the live WASM:
 *   point → `BRepBuilderAPI_MakeVertex(gp_Pnt)` (unsuffixed — this class has no
 *           `_N` overloads, unlike almost everything else in this codebase)
 *           → `.Vertex()`.
 *   line  → the already-verified `BRepBuilderAPI_MakeEdge_3(pnt, pnt)`.
 *   arc   → the already-verified `gp_Circ_2(gp_Ax2_3(pnt, normal), radius)`,
 *           trimmed via `BRepBuilderAPI_MakeEdge_9(circ, alpha1, alpha2)` (of
 *           35 total `MakeEdge` overloads — found by probing each index with a
 *           `(gp_Circ, number, number)` argument shape). Sweeps from
 *           `alpha1` to `alpha2` in the increasing (counterclockwise about
 *           `normal`) direction, wrapping through 0 if `alpha2 < alpha1` —
 *           confirmed against the live WASM, not assumed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addWireframePrimitive(oc: any, shape: any, op: EditOp, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail, guideCollector?: GuideCollector): any {
  const entity = buildWireframePrimitive(oc, op, cleanup);
  if (!entity) {
    fail?.(`could not build the ${op.op} entity`, "check the coordinates (a collinear 3-point arc, for example, cannot build an edge)");
    return shape;
  }
  if ((op as any).guide && guideCollector) {
    if (op.op === "addPoint") guideCollector.vertices.push(entity);
    else if (op.op === "addPolyline") {
      const exp = new oc.TopExp_Explorer_2(entity, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      cleanup.push(exp);
      for (; exp.More(); exp.Next()) { const e = oc.TopoDS.Edge_1(exp.Current()); cleanup.push(e); guideCollector.edges.push(e); }
      if (guideCollector.edges.length === 0) guideCollector.edges.push(entity);
    } else guideCollector.edges.push(entity);
  }
  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  builder.Add(comp, shape);
  builder.Add(comp, entity);
  return comp;
}

/** Builds the new vertex/edge, or null on builder failure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildWireframePrimitive(oc: any, op: EditOp, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    switch (op.op) {
      case "addPoint": {
        const p = keep(pnt(oc, op.position));
        const vertex = keep(new oc.BRepBuilderAPI_MakeVertex(p)).Vertex();
        return vertex.IsNull() ? null : keep(vertex);
      }
      case "addLine": {
        const edge = keep(new oc.BRepBuilderAPI_MakeEdge_3(keep(pnt(oc, op.start)), keep(pnt(oc, op.end)))).Edge();
        return edge.IsNull() ? null : keep(edge);
      }
      case "addArc": {
        const ax2 = keep(new oc.gp_Ax2_3(keep(pnt(oc, op.center)), keep(dir(oc, op.normal))));
        const circ = keep(new oc.gp_Circ_2(ax2, op.radius));
        const alpha1 = (op.startAngleDeg * Math.PI) / 180;
        const alpha2 = (op.endAngleDeg * Math.PI) / 180;
        const edge = keep(new oc.BRepBuilderAPI_MakeEdge_9(circ, alpha1, alpha2)).Edge();
        return edge.IsNull() ? null : keep(edge);
      }
      case "addPolyline": {
        // A wire of straight segments (the wire's edges are individually
        // enumerated by the unrestricted edge extraction, so each segment gets
        // its own pickable `edge-N`).
        const pts = op.points.map((p) => keep(pnt(oc, p)));
        const mkWire = keep(new oc.BRepBuilderAPI_MakeWire_1());
        const last = op.closed ? pts.length : pts.length - 1;
        for (let i = 0; i < last; i++) {
          const edge = keep(keep(new oc.BRepBuilderAPI_MakeEdge_3(pts[i], pts[(i + 1) % pts.length])).Edge());
          mkWire.Add_1(edge);
        }
        if (!mkWire.IsDone()) return null;
        const wire = keep(mkWire.Wire());
        return wire.IsNull() ? null : wire;
      }
      case "addThreePointArc": {
        // `GC_MakeArcOfCircle_4(p1, p2, p3)` (verified against the live WASM) —
        // `IsDone()` is false for a collinear triple, the graceful-skip gate.
        const mk = keep(new oc.GC_MakeArcOfCircle_4(keep(pnt(oc, op.p1)), keep(pnt(oc, op.p2)), keep(pnt(oc, op.p3))));
        if (!mk.IsDone()) return null;
        return edgeFromCurveHandle(oc, keep(mk.Value()), cleanup);
      }
      case "addSpline": {
        // `GeomAPI_PointsToBSpline_2(arr, 3, 8, GeomAbs_C2, 1e-6)` (verified):
        // an approximating fit through the points, endpoint-exact —
        // `GeomAPI_Interpolate` is not bound in this build.
        const arr = keep(new oc.TColgp_Array1OfPnt_2(1, op.points.length));
        op.points.forEach((p, i) => arr.SetValue(i + 1, keep(pnt(oc, p))));
        const fit = keep(new oc.GeomAPI_PointsToBSpline_2(arr, 3, 8, oc.GeomAbs_Shape.GeomAbs_C2, 1e-6));
        return edgeFromCurveHandle(oc, keep(fit.Curve()), cleanup);
      }
      case "addBezier": {
        // `TColgp_Array1OfPnt_2(1, n)` + `Geom_BezierCurve_1(arr)` (verified).
        const arr = keep(new oc.TColgp_Array1OfPnt_2(1, op.controlPoints.length));
        op.controlPoints.forEach((p, i) => arr.SetValue(i + 1, keep(pnt(oc, p))));
        const bez = new oc.Geom_BezierCurve_1(arr); // owned by the handle below
        const hCurve = keep(new oc.Handle_Geom_Curve_2(bez));
        const mkEdge = keep(new oc.BRepBuilderAPI_MakeEdge_24(hCurve));
        if (!mkEdge.IsDone()) return null;
        const edge = keep(mkEdge.Edge());
        return edge.IsNull() ? null : edge;
      }
      case "addEllipseArc": {
        // Same major≥minor radii-swap as addEllipseProfile; when swapped the
        // parametric angle is measured from the rotated major axis (`v`), so
        // shift both trim angles by −90° to keep them measured from `up`.
        const [u, v] = inPlaneBasis(op.normal, op.up);
        const swap = op.radiusY > op.radiusX;
        const major = swap ? op.radiusY : op.radiusX;
        const minor = swap ? op.radiusX : op.radiusY;
        const xdir = swap ? v : u;
        const shift = swap ? -Math.PI / 2 : 0;
        const ax2 = keep(new oc.gp_Ax2_2(keep(pnt(oc, op.center)), keep(dir(oc, op.normal)), keep(dir(oc, xdir))));
        const elips = keep(new oc.gp_Elips_2(ax2, major, minor));
        const a1 = (op.startAngleDeg * Math.PI) / 180 + shift;
        const a2 = (op.endAngleDeg * Math.PI) / 180 + shift;
        const edge = keep(keep(new oc.BRepBuilderAPI_MakeEdge_13(elips, a1, a2)).Edge());
        return edge.IsNull() ? null : edge;
      }
      case "addHelix": {
        // Verified chain: a 2D line segment in the (angle, height) parameter
        // space of a `Geom_CylindricalSurface`, turned into a real 3D edge by
        // `BRepLib.BuildCurves3d_2`. `MakeEdge_30(h2dcurve, hsurface)` is the
        // curve-on-surface overload (found by probing all 35 indices).
        const ax3 = keep(new oc.gp_Ax3_4(keep(pnt(oc, op.center)), keep(dir(oc, op.axis))));
        const cyl = new oc.Geom_CylindricalSurface_1(ax3, op.radius); // owned by the handle below
        const hSurf = keep(new oc.Handle_Geom_Surface_2(cyl));
        const p2a = keep(new oc.gp_Pnt2d_3(0, 0));
        const p2b = keep(new oc.gp_Pnt2d_3(2 * Math.PI * op.turns, op.pitch * op.turns));
        const seg = keep(new oc.GCE2d_MakeSegment_1(p2a, p2b));
        if (!seg.IsDone()) return null;
        const hSeg = keep(seg.Value());
        const h2d = keep(new oc.Handle_Geom2d_Curve_2(hSeg.get()));
        const mkEdge = keep(new oc.BRepBuilderAPI_MakeEdge_30(h2d, hSurf));
        if (!mkEdge.IsDone()) return null;
        const edge = keep(mkEdge.Edge());
        if (edge.IsNull()) return null;
        oc.BRepLib.BuildCurves3d_2(edge);
        return edge;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Wraps a `Handle_Geom_TrimmedCurve`/`Handle_Geom_BSplineCurve` (any Geom curve
 * handle with `.get()`) into a `TopoDS_Edge` via `Handle_Geom_Curve_2` +
 * `BRepBuilderAPI_MakeEdge_24` (both verified against the live WASM).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function edgeFromCurveHandle(oc: any, handle: any, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  const hCurve = keep(new oc.Handle_Geom_Curve_2(handle.get()));
  const mkEdge = keep(new oc.BRepBuilderAPI_MakeEdge_24(hCurve));
  if (!mkEdge.IsDone()) return null;
  const edge = keep(mkEdge.Edge());
  return edge.IsNull() ? null : edge;
}

/**
 * Builds a standalone flat face from the wire formed by the selected edges and
 * **appends** it — same non-destructive `compound(existing shape + new face)`
 * pattern as {@link addProfile}, and it likewise benefits from the free-face
 * tessellation pass with zero further changes needed there. Edge `edge-N` ids
 * are resolved via the **existing** `collectEdges`.
 *
 * OCCT wire-assembly API, verified against the live WASM: `BRepBuilderAPI_
 * MakeWire_1` + `.Add_1()` per selected edge — confirmed to auto-assemble
 * edges added in an arbitrary (shuffled) order by their shared vertices, not
 * just sequential order, so the pick order in the view doesn't matter. `.Add_1
 * ()`'s connectivity check is what rejects a genuinely unrelated/disconnected
 * edge set (`.IsDone()` false) — the primary graceful-skip gate. **Caveat,
 * verified not assumed:** a chain of edges that connects but does not loop
 * back to its own start (an "almost closed" open polyline) may still succeed
 * through `.IsDone()` and `BRepBuilderAPI_MakeFace_15` in this OCCT build —
 * OCCT wires are not required to be closed, and no reliable "is this wire a
 * closed loop" API was found in this binding (`BRepTools.IsReallyClosed`/
 * `DetectClosedness` need extra args this binding doesn't expose usefully;
 * `ShapeAnalysis_Wire.CheckClosed` did not distinguish the two cases in
 * testing). Accepted: a best-effort face from an open chain is harmless
 * (never a crash), consistent with this codebase's graceful-degradation rule.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addSurfaceFromLines(oc: any, shape: any, op: Extract<EditOp, { op: "addSurfaceFromLines" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail, guideCollector?: GuideCollector): any {
  if (guideCollector) {
    const edges = collectEdges(oc, shape, cleanup);
    for (const id of op.edges) { const e = edges[edgeIndex(id)]; if (e && isGuideHandle(e, guideCollector)) { fail?.(`edge ${id} is construction (guide) geometry — guide entities are excluded from surface resolution`); return shape; } }
  }
  const face = buildSurfaceFromLines(oc, shape, op, cleanup);
  if (!face) {
    fail?.(
      "the selected edges did not form a buildable face",
      "at least 3 edge-N ids that connect into a chain are required (a genuinely disconnected set is rejected)"
    );
    return shape;
  }
  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  builder.Add(comp, shape);
  builder.Add(comp, face);
  return comp;
}

/** Builds the new face from the selected edges, or null on unresolved operands / failure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildSurfaceFromLines(oc: any, shape: any, op: Extract<EditOp, { op: "addSurfaceFromLines" }>, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    const edges = collectEdges(oc, shape, cleanup);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const picked = op.edges.map((id) => edges[edgeIndex(id)]).filter((e): e is any => e != null);
    if (picked.length < 3) return null; // a closed loop needs at least 3 edges

    const mkWire = keep(new oc.BRepBuilderAPI_MakeWire_1());
    for (const e of picked) mkWire.Add_1(e);
    if (!mkWire.IsDone()) return null; // edges don't connect into a wire at all

    const wire = keep(mkWire.Wire());
    const face = keep(new oc.BRepBuilderAPI_MakeFace_15(wire, true)).Face();
    return face.IsNull() ? null : keep(face);
  } catch {
    return null;
  }
}

/**
 * Builds a new solid by sewing the selected faces into a closed shell and
 * **appends** it — the standard extra-body append pattern used throughout this
 * file. Face `face-N` ids are resolved via the **existing** `collectFaces`
 * (already includes the free-face pass, so a face built by `addSurfaceFromLines`
 * is naturally selectable here too — zero further changes needed).
 *
 * OCCT sewing API, verified against the live WASM (probed with a realistic
 * input: 6 mutually-disconnected faces, built independently — not from
 * `BRepPrimAPI_MakeBox` — matching what a user actually selects):
 *   `new BRepBuilderAPI_Sewing(tolerance, true, true, true, false)` (this
 *   class's only constructor takes all 5 params — no defaulted overload in
 *   this binding) → `.Add(face)` per face → `.Perform(new Handle_Message_
 *   ProgressIndicator_1())` (the unsuffixed `Perform` needs this progress
 *   handle arg, unlike most single-shape ops in this codebase, which skip a
 *   progress arg entirely) → `.SewedShape()`, then an explorer pulls the
 *   `TopAbs_SHELL` out of the result (`TopoDS.Shell_1`).
 *
 * **Closure check — verified NOT to be `.IsNull()`/volume sign/`BRepCheck_
 * Analyzer`** (all tried and rejected during probing): `BRepBuilderAPI_
 * MakeSolid` happily builds a non-null "solid" from an OPEN shell, and
 * `BRepGProp.VolumeProperties` returns a plausible-looking (wrong) number for
 * an open shell too — neither is a reliable skip signal. The reliable one is
 * `sew.NbFreeEdges()`: exactly 0 for a properly closed shell, > 0 (the
 * boundary edges of whatever's missing) for an open one — confirmed with a
 * unit box built from all 6 faces (0 free edges) vs. 5-of-6 (4 free edges) vs.
 * 3-of-6 (8 free edges). This is the gate `addVolumeFromSurfaces` uses.
 *
 * `BRepBuilderAPI_MakeSolid_3(shell)` builds the solid from the verified-closed
 * shell (found by brute-force probing all 7 numbered overloads against a real
 * shell argument).
 *
 * **Unlike `extrude`'s `Copy=false` (which reuses and thereby consumes its
 * source face), sewing does NOT consume the input faces** — verified end-to-end
 * on `bull.stp`: after sewing 6 rectangle-profile faces into a box solid, all 6
 * original faces are still present as free faces (visible in "Sketches")
 * alongside the new solid's own 6. This is accepted, not a bug: the sewn shell
 * is built from copies, so the original sketches remain available to reuse for
 * another operation. Not worth suppressing — doing so would mean excluding
 * specific faces from the compound rebuild, extra complexity for a purely
 * cosmetic concern.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addVolumeFromSurfaces(oc: any, shape: any, op: Extract<EditOp, { op: "addVolumeFromSurfaces" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail, guideCollector?: GuideCollector): any {
  if (guideCollector) {
    const faces = collectFaces(oc, shape, cleanup);
    for (const id of op.faces) { const f = faces[faceIndex(id)]; if (f && isGuideHandle(f, guideCollector)) { fail?.(`face ${id} is construction (guide) geometry — guide entities are excluded from volume resolution`); return shape; } }
  }
  const solid = buildVolumeFromSurfaces(oc, shape, op, cleanup);
  if (!solid) {
    fail?.(
      "the selected faces did not sew into a CLOSED shell",
      "at least 4 face-N ids forming a closed volume are required — run a smaller selection or check for missing faces"
    );
    return shape;
  }
  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  builder.Add(comp, shape);
  builder.Add(comp, solid);
  return comp;
}

/** Builds the new solid from the selected faces, or null on unresolved operands / an open shell / failure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildVolumeFromSurfaces(oc: any, shape: any, op: Extract<EditOp, { op: "addVolumeFromSurfaces" }>, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    const faces = collectFaces(oc, shape, cleanup);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const picked = op.faces.map((id) => faces[faceIndex(id)]).filter((f): f is any => f != null);
    if (picked.length < 4) return null; // a closed volume needs at least 4 faces

    const sew = keep(new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false));
    for (const f of picked) sew.Add(f);
    sew.Perform(keep(new oc.Handle_Message_ProgressIndicator_1()));
    if (sew.NbFreeEdges() > 0) return null; // open/non-manifold shell — can't make a solid

    const sewn = keep(sew.SewedShape());
    const shellExp = keep(new oc.TopExp_Explorer_2(
      sewn, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE
    ));
    if (!shellExp.More()) return null;
    const shell = keep(oc.TopoDS.Shell_1(shellExp.Current()));

    const solid = keep(new oc.BRepBuilderAPI_MakeSolid_3(shell)).Solid();
    return solid.IsNull() ? null : keep(solid);
  } catch {
    return null;
  }
}

/**
 * Orthonormal in-plane basis (`u`, `v`) perpendicular to `normal`, with `u`
 * derived from `up` (projected off `normal`, then normalized) so rectangle/
 * polygon profiles orient predictably from a user-supplied reference direction,
 * unlike {@link planeBasis}'s arbitrary perpendicular. Callers must ensure `up`
 * is not (anti-)parallel to `normal` (`validateEditOp` already enforces this).
 */
function inPlaneBasis(normal: Vec3, up: Vec3): [Vec3, Vec3] {
  const n = normalized(normal);
  const d = up[0] * n[0] + up[1] * n[1] + up[2] * n[2]; // up · n
  const proj: Vec3 = [up[0] - d * n[0], up[1] - d * n[1], up[2] - d * n[2]];
  const u = normalized(proj);
  const v = normalized(cross(n, u));
  return [u, v];
}

/** A new, normalized copy of `v` (pure — does not mutate the input). */
function normalized(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** `base + u*du + v*dv`. */
function addScaled(base: Vec3, u: Vec3, du: number, v: Vec3, dv: number): Vec3 {
  return [base[0] + u[0] * du + v[0] * dv, base[1] + u[1] * du + v[1] * dv, base[2] + u[2] * du + v[2] * dv];
}

/**
 * Two unit vectors spanning the plane perpendicular to `axis` (for building the
 * N-gon prism's base polygon). Pure JS math — no OCCT handles involved.
 */
function planeBasis(axis: Vec3): [Vec3, Vec3] {
  const [ax, ay, az] = axis;
  const len = Math.hypot(ax, ay, az) || 1;
  const n: Vec3 = [ax / len, ay / len, az / len];
  // Pick a helper vector not parallel to n (avoid near-zero cross product).
  const helper: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = cross(helper, n);
  normalize(u);
  const v = cross(n, u);
  normalize(v);
  return [u, v];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): void {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  v[0] /= len; v[1] /= len; v[2] /= len;
}

/**
 * Enumerates faces in the SAME global `face-N` order `tessellateByGroup`
 * (`src/meshExtract.ts`) assigns: solids in `TopExp_Explorer` order, faces within
 * each in explorer order, with a fallback to the whole shape's faces when there are
 * no solids — and, when solids DO exist, any standalone 2D profile faces (added via
 * `addCircleProfile`/`addRectangleProfile`/`addPolygonProfile`) not owned by any
 * solid, appended last in whole-shape explorer order. This mirrors
 * `tessellateByGroup`'s free-face pass exactly (same `HashCode`+`IsSame` claiming
 * algorithm) so a `face-N` id picked in the view always resolves to the same live
 * face here. (It does not replay tessellation's skip-untriangulated-faces step, so
 * in the rare degenerate-face case an index could shift — accepted.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function collectFaces(oc: any, shape: any, cleanup: Array<{ delete(): void }>): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const claimed = new Map<number, any[]>();
  const solidExp = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_SOLID,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE
  );
  cleanup.push(solidExp);
  let anySolid = false;
  for (; solidExp.More(); solidExp.Next()) {
    anySolid = true;
    addFacesOf(oc, solidExp.Current(), out, cleanup, claimed);
  }
  if (!anySolid) addFacesOf(oc, shape, out, cleanup);
  else addFreeFacesOf(oc, shape, out, cleanup, claimed);
  return out;
}

/** Appends every face of `shapeRef`; when `claim` is given, also records each
 * face's identity into it (`HashCode` bucket) so {@link addFreeFacesOf} can skip
 * faces already owned by a solid. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addFacesOf(oc: any, shapeRef: any, out: any[], cleanup: Array<{ delete(): void }>, claim?: Map<number, any[]>): void {
  const exp = new oc.TopExp_Explorer_2(
    shapeRef,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE
  );
  cleanup.push(exp);
  for (; exp.More(); exp.Next()) {
    const face = oc.TopoDS.Face_1(exp.Current());
    cleanup.push(face);
    out.push(face);
    if (claim) {
      const hash = face.HashCode(HASH_UPPER);
      const bucket = claim.get(hash);
      if (bucket) bucket.push(face); else claim.set(hash, [face]);
    }
  }
}

/** Appends faces of the whole `shape` not already present in `claimed` — the
 * `collectFaces` mirror of `meshExtract.ts`'s `extractFreeFaces`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addFreeFacesOf(oc: any, shape: any, out: any[], cleanup: Array<{ delete(): void }>, claimed: Map<number, any[]>): void {
  const exp = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE
  );
  cleanup.push(exp);
  for (; exp.More(); exp.Next()) {
    const face = oc.TopoDS.Face_1(exp.Current());
    const bucket = claimed.get(face.HashCode(HASH_UPPER));
    if (bucket && bucket.some((f) => f.IsSame(face))) { face.delete(); continue; } // owned by a solid
    cleanup.push(face);
    out.push(face);
  }
}

/**
 * Assembly **explode**: spreads every solid radially from the model's bounding-box
 * centre by `factor` (0 = no move). Each solid is translated by
 * `(solidCentre − modelCentre) · factor`; single-solid models are returned
 * unchanged. Centres are bbox centres via `Bnd_Box`/`CornerMin`/`CornerMax`
 * (`Bnd_Box.Get()` is unbound — see CLAUDE.md).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function explodeSolids(oc: any, shape: any, factor: number, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const solids = collectSolids(oc, shape, cleanup);
  if (solids.length < 2) {
    fail?.("explode spreads multiple bodies apart — the model has fewer than two solids");
    return shape;
  }
  const c = bboxCenter(oc, shape, cleanup);

  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  for (const { solid } of solids) {
    const ci = bboxCenter(oc, solid, cleanup);
    const t = new oc.gp_Trsf_1();
    cleanup.push(t);
    const off = new oc.gp_Vec_4((ci[0] - c[0]) * factor, (ci[1] - c[1]) * factor, (ci[2] - c[2]) * factor);
    cleanup.push(off);
    t.SetTranslation_1(off);
    builder.Add(comp, rigid(oc, t, cleanup)(solid));
  }
  return comp;
}

/**
 * Assembly **mate**: aligns planar face `faceA` onto planar face `faceB` (opposing
 * normals), moving the solid that owns `faceA` and leaving the rest in place.
 * Verified API (see CLAUDE.md): face plane via `BRepAdaptor_Surface_2(face, true)`
 * → `GetType()===GeomAbs_Plane` → `.Plane()` (`Location()` + `Axis().Direction()`);
 * rigid motion `gp_Trsf.SetDisplacement(gp_Ax3_4(ptA, nA), gp_Ax3_4(ptB, −nB))`.
 * Non-planar faces, unresolved ids, or a failed displacement are skipped.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mateShape(oc: any, shape: any, op: Extract<EditOp, { op: "mate" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const faces = collectFaces(oc, shape, cleanup);
  const fa = faces[faceIndex(op.faceA)];
  const fb = faces[faceIndex(op.faceB)];
  if (!fa || !fb) {
    fail?.(
      `face id${!fa && !fb ? "s" : ""} ${[!fa ? op.faceA : null, !fb ? op.faceB : null].filter(Boolean).join(", ")} did not resolve`,
      "re-check face-N ids after topology-changing ops — load_model re-lists them"
    );
    return shape;
  }
  const pa = facePlane(oc, fa, cleanup);
  const pb = facePlane(oc, fb, cleanup);
  if (!pa || !pb) {
    fail?.(
      `face ${!pa ? op.faceA : op.faceB} is not planar`,
      "mate aligns two PLANAR faces onto each other — pick flat faces"
    );
    return shape;
  }

  const t = new oc.gp_Trsf_1();
  cleanup.push(t);
  try {
    const ax3A = new oc.gp_Ax3_4(pnt(oc, pa.pt), dir(oc, pa.nl));
    cleanup.push(ax3A);
    const ax3B = new oc.gp_Ax3_4(pnt(oc, pb.pt), dir(oc, [-pb.nl[0], -pb.nl[1], -pb.nl[2]]));
    cleanup.push(ax3B);
    t.SetDisplacement(ax3A, ax3B);
  } catch {
    fail?.("the rigid displacement between the two face planes could not be built");
    return shape;
  }
  const transform = rigid(oc, t, cleanup);

  const own = owningSolid(oc, shape, fa, cleanup);
  if (!own) return transform(shape); // no solids — move the whole shape

  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  builder.Add(comp, transform(own.owner));
  for (const o of own.others) builder.Add(comp, o);
  return comp;
}

/**
 * Hollows out the solid(s) owning the selected opening faces: those faces are
 * removed and the rest of each owning solid's boundary grows walls of
 * `|thickness|` (negative = inward, the usual hollow — verified: closing the
 * top of a 10-box with thickness −1 leaves volume 1000 − 8·8·9 = 424).
 *
 * OCCT API, verified against the live WASM: `new BRepOffsetAPI_MakeThickSolid_1()`
 * (no-arg ctor) → `.MakeThickSolidByJoin(solid, closingFaces, offset, tol,
 * BRepOffset_Mode.BRepOffset_Skin, false, false, GeomAbs_JoinType.GeomAbs_Arc,
 * false)` — exactly 9 args; the 10th `Message_ProgressRange` is not
 * constructible in this build (the same quirk as booleans/BREP read) and must
 * be omitted. Closing faces travel in a `TopTools_ListOfShape_1()` via
 * `.Append_1(face)` (`.Size()`, not `.Extent()`, reads it back). **An EMPTY
 * closing list does NOT hollow** — it returns the plain inner offset solid
 * (verified: volume 512, i.e. the shrunk 8-box, not 1000−512) — which is why
 * `validateEditOp` requires ≥ 1 opening face. Unresolved faces, faces not
 * owned by any solid, or a failed/`!IsDone()` build skip gracefully (the
 * affected solid stays unshelled).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shellSolids(oc: any, shape: any, op: Extract<EditOp, { op: "shell" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    const faces = collectFaces(oc, shape, cleanup);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const picked = op.openingFaces.map((id) => faces[faceIndex(id)]).filter((f): f is any => f != null);
    if (picked.length === 0) {
      fail?.(
        `none of the opening-face ids (${op.openingFaces.join(", ")}) resolve`,
        "re-check face-N ids after topology-changing ops — load_model re-lists them"
      );
      return shape;
    }
    const solids = collectSolids(oc, shape, cleanup);
    if (solids.length === 0) {
      fail?.("the model has no solids to shell");
      return shape;
    }

    // Group the opening faces by owning solid (a face can only belong to one).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const openingsBySolid = new Map<number, any[]>();
    for (const face of picked) {
      for (let i = 0; i < solids.length; i++) {
        const exp = keep(new oc.TopExp_Explorer_2(
          solids[i].solid, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE
        ));
        let owned = false;
        for (; exp.More(); exp.Next()) {
          const f = keep(oc.TopoDS.Face_1(exp.Current()));
          if (f.IsSame(face)) { owned = true; break; }
        }
        if (owned) {
          const list = openingsBySolid.get(i) ?? [];
          list.push(face);
          openingsBySolid.set(i, list);
          break;
        }
      }
    }
    if (openingsBySolid.size === 0) {
      fail?.("no opening face is owned by a solid");
      return shape;
    }

    const mode = oc.BRepOffset_Mode.BRepOffset_Skin;
    const joinMap: Record<string, number> = {
      arc: oc.GeomAbs_JoinType.GeomAbs_Arc,
      intersection: oc.GeomAbs_JoinType.GeomAbs_Intersection,
      tangent: oc.GeomAbs_JoinType.GeomAbs_Tangent,
    };
    const join = joinMap[op.join ?? "arc"] ?? oc.GeomAbs_JoinType.GeomAbs_Arc;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const replaced = new Map<number, any>();
    for (const [i, openings] of openingsBySolid) {
      try {
        const list = keep(new oc.TopTools_ListOfShape_1());
        for (const f of openings) list.Append_1(f);
        const mk = keep(new oc.BRepOffsetAPI_MakeThickSolid_1());
        mk.MakeThickSolidByJoin(solids[i].solid, list, op.thickness, 1e-3, mode, false, false, join, false);
        if (mk.IsDone()) replaced.set(i, keep(mk.Shape()));
      } catch {
        // this solid stays unshelled
      }
    }
    if (replaced.size === 0) {
      fail?.("the hollow build failed for every opening solid", "the thickness may be too large for the solid's walls");
      return shape;
    }
    if (solids.length === 1) return replaced.get(0) ?? shape;

    const comp = new oc.TopoDS_Compound();
    cleanup.push(comp);
    const builder = new oc.BRep_Builder();
    cleanup.push(builder);
    builder.MakeCompound(comp);
    solids.forEach((s, i) => builder.Add(comp, replaced.get(i) ?? s.solid));
    return comp;
  } catch {
    fail?.("the shell builder threw");
    return shape;
  }
}

function draftFaces(oc: any, shape: any, op: Extract<EditOp, { op: "draft" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    const faces = collectFaces(oc, shape, cleanup);
    const picked = op.faces.map((id) => faces[faceIndex(id)]).filter((f): f is any => f != null);
    if (picked.length === 0) {
      fail?.(`none of the face ids (${op.faces.join(", ")}) resolve`);
      return shape;
    }
    const angleRad = (op.angleDeg * Math.PI) / 180;
    // VERIFIED against the live WASM (see CLAUDE.md's item-10 section for the
    // probing trail): the plain `BRepOffsetAPI_DraftAngle` ctor is UNBOUND
    // ("no accessible constructor") and `_1` wants >1 params — `_2(shape)` is
    // the working 1-arg ctor. `Add` is a 5-arg `(face, gp_Dir, angleRad,
    // gp_Pln, flag)` — deduced from embind's own type errors, confirmed live.
    // `gp_Pln_2(Ax3)` is the 1-arg plane form (gp_Pln_3 takes (Pnt, Dir)).
    const draft = keep(new oc.BRepOffsetAPI_DraftAngle_2(shape));
    for (const f of picked) {
      let pln: any;
      let pull: Vec3;
      if (op.planePoint && op.planeNormal) {
        const ax = keep(new oc.gp_Ax3_4(keep(pnt(oc, op.planePoint)), keep(dir(oc, op.planeNormal))));
        pln = keep(new oc.gp_Pln_2(ax));
        pull = op.planeNormal;
      } else {
        const info = facePlane(oc, f, cleanup);
        if (!info) {
          fail?.("could not derive neutral plane for a drafted face");
          return shape;
        }
        const ax = keep(new oc.gp_Ax3_4(keep(pnt(oc, info.pt)), keep(dir(oc, info.nl))));
        pln = keep(new oc.gp_Pln_2(ax));
        pull = info.nl;
      }
      try {
        draft.Add(f, dir(oc, pull), angleRad, pln, true);
      } catch (err) {
        fail?.(`draft Add failed for a face: ${err instanceof Error ? err.message : String(err)}`);
        return shape;
      }
    }
    try {
      draft.Build();
    } catch {
      // Probed against the live WASM (3 fresh processes, identical result):
      // `Add` succeeds with the verified 5-arg signature, but `Build()` — the
      // call that actually computes the tapered shape — RELIABLY throws an
      // un-decodable OCCT failure (a Standard_Failure with no message) on real
      // geometry. Kernel-broken in this build, the same "green in the manifest
      // is necessary but not sufficient" class as ShapeFix_Shape /
      // Interface_Static.CVal / BRepExtrema_DistanceSS-max (see CLAUDE.md).
      // The op stays: it validates, its wiring is correct, and a future OCCT
      // build that fixes Build() needs no code change — until then this is an
      // honest graceful skip, never a silent no-op.
      fail?.(
        "this OCCT build's draft engine (BRepOffsetAPI_DraftAngle.Build) failed — a kernel limitation of the bundled WASM, not an input problem",
        "the draft op is skipped here; the surrounding ops still apply"
      );
      return shape;
    }
    if (!draft.IsDone()) {
      fail?.("draft Build did not complete (IsDone() false)");
      return shape;
    }
    const res = draft.Shape();
    cleanup.push(res);
    return res;
  } catch {
    fail?.("draft builder threw");
    return shape;
  }
}

/**
 * Splits the target solids by a plane, keeping the piece on the normal side
 * ("positive"), the opposite piece ("negative"), or both. Implemented as a
 * **half-space cut with only already-verified bindings** (deliberately avoiding
 * a `BRepAlgoAPI_Splitter` binding probe): an axis-aligned box spanning the
 * NEGATIVE side of the canonical z=0 plane (extent 10× the model's bbox
 * diagonal) is moved onto the split plane with the mate-verified
 * `gp_Trsf.SetDisplacement(gp_Ax3, gp_Ax3)`, then `positive → Cut_3(targets,
 * box)`, `negative → Common_3(targets, box)`, `both → compound of both`.
 * Unresolved targets or a failed boolean skip gracefully.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function splitSolidsByPlane(oc: any, shape: any, op: Extract<EditOp, { op: "splitByPlane" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    let planePoint: Vec3 | null = (op as any).planePoint ?? null;
    let planeNormal: Vec3 | null = (op as any).planeNormal ?? null;
    if ((op as any).midplaneFaces) {
      const mid = resolveMidplane(oc, shape, (op as any).midplaneFaces, cleanup, fail!);
      if (!mid) return shape;
      planePoint = mid.point; planeNormal = mid.normal;
    }
    if (!planePoint || !planeNormal) { fail?.(`splitByPlane plane not specified`); return shape; }
    const solids = collectSolids(oc, shape, cleanup);
    const byId = new Map(solids.map((s) => [s.id, s.solid]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const targets = op.targets.map((id) => byId.get(id)).filter((s): s is any => s != null);
    if (targets.length === 0) {
      fail?.(
        `target ids (${op.targets.join(", ")}) did not resolve to solids`,
        "re-check solid-N ids after topology-changing ops — load_model re-lists them"
      );
      return shape;
    }

    const d = Math.max(bboxDiagonal(oc, shape, cleanup), 1) * 10;
    const rawBox = keep(keep(new oc.BRepPrimAPI_MakeBox_3(
      keep(pnt(oc, [-d / 2, -d / 2, -d])), keep(pnt(oc, [d / 2, d / 2, 0]))
    )).Shape());
    const t = keep(new oc.gp_Trsf_1());
    t.SetDisplacement(
      keep(new oc.gp_Ax3_4(keep(pnt(oc, [0, 0, 0])), keep(dir(oc, [0, 0, 1])))),
      keep(new oc.gp_Ax3_4(keep(pnt(oc, planePoint)), keep(dir(oc, planeNormal))))
    );
    const halfSpace = rigid(oc, t, cleanup)(rawBox);

    const a = combineSolids(oc, targets, cleanup);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pieces: any[] = [];
    if (op.keep === "positive" || op.keep === "both") {
      const cut = keep(new oc.BRepAlgoAPI_Cut_3(a, halfSpace));
      if (!cut.IsDone()) {
        fail?.("the positive-side cut did not complete (IsDone() false)");
        return shape;
      }
      pieces.push(keep(cut.Shape()));
    }
    if (op.keep === "negative" || op.keep === "both") {
      const common = keep(new oc.BRepAlgoAPI_Common_3(a, halfSpace));
      if (!common.IsDone()) {
        fail?.("the negative-side intersection did not complete (IsDone() false)");
        return shape;
      }
      pieces.push(keep(common.Shape()));
    }

    const used = new Set(op.targets);
    const leftovers = solids.filter((s) => !used.has(s.id)).map((s) => s.solid);
    if (pieces.length === 1 && leftovers.length === 0) return pieces[0];

    const comp = new oc.TopoDS_Compound();
    cleanup.push(comp);
    const builder = new oc.BRep_Builder();
    cleanup.push(builder);
    builder.MakeCompound(comp);
    for (const p of pieces) builder.Add(comp, p);
    for (const s of leftovers) builder.Add(comp, s);
    return comp;
  } catch {
    fail?.("the split builder threw");
    return shape;
  }
}

/**
 * Appends the planar cross-section of the target solids as a standalone flat
 * face — non-destructive (the solids stay untouched); the section face shows
 * up under "Sketches" via the free-face tessellation pass, pickable for
 * extrude/revolve like any other sketch. Implemented with verified bindings
 * only: a large plane face (`buildFlatFace`, 10× bbox diagonal) intersected
 * with the targets via `BRepAlgoAPI_Common_3(planeFace, targets)` (probe:
 * exactly the trimmed cross-section face). A plane that misses the targets
 * (no faces in the result) or a failed boolean skips gracefully.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sectionSolids(oc: any, shape: any, op: Extract<EditOp, { op: "section" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    let planePoint: Vec3 | null = (op as any).planePoint ?? null;
    let planeNormal: Vec3 | null = (op as any).planeNormal ?? null;
    if ((op as any).midplaneFaces) {
      const mid = resolveMidplane(oc, shape, (op as any).midplaneFaces, cleanup, fail!);
      if (!mid) return shape;
      planePoint = mid.point; planeNormal = mid.normal;
    }
    if (!planePoint || !planeNormal) { fail?.(`section plane not specified`); return shape; }
    const solids = collectSolids(oc, shape, cleanup);
    const byId = new Map(solids.map((s) => [s.id, s.solid]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const targets = op.targets.map((id) => byId.get(id)).filter((s): s is any => s != null);
    if (targets.length === 0) {
      fail?.(
        `target ids (${op.targets.join(", ")}) did not resolve to solids`,
        "re-check solid-N ids after topology-changing ops — load_model re-lists them"
      );
      return shape;
    }

    const d = Math.max(bboxDiagonal(oc, shape, cleanup), 1) * 10;
    const [u, v] = planeBasis(planeNormal);
    const corners: Vec3[] = [
      addScaled(planePoint, u, -d / 2, v, -d / 2),
      addScaled(planePoint, u, d / 2, v, -d / 2),
      addScaled(planePoint, u, d / 2, v, d / 2),
      addScaled(planePoint, u, -d / 2, v, d / 2),
    ];
    const planeFace = buildFlatFace(oc, corners, cleanup);
    if (!planeFace) {
      fail?.("the cutting plane face could not be built", "the planeNormal must be a non-zero direction");
      return shape;
    }

    const a = combineSolids(oc, targets, cleanup);
    const algo = keep(new oc.BRepAlgoAPI_Common_3(planeFace, a));
    if (!algo.IsDone()) {
      fail?.("the section intersection did not complete (IsDone() false)");
      return shape;
    }
    const section = keep(algo.Shape());

    // The plane must actually cross the targets — an empty result appends nothing.
    const faceExp = keep(new oc.TopExp_Explorer_2(
      section, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE
    ));
    if (!faceExp.More()) {
      fail?.(
        "the plane does not cross the targeted solids — there is no cross-section",
        "move planePoint onto/through the model"
      );
      return shape;
    }

    const comp = new oc.TopoDS_Compound();
    cleanup.push(comp);
    const builder = new oc.BRep_Builder();
    cleanup.push(builder);
    builder.MakeCompound(comp);
    builder.Add(comp, shape);
    builder.Add(comp, section);
    return comp;
  } catch {
    fail?.("the section builder threw");
    return shape;
  }
}

/** The bounding-box diagonal length of a shape (via `Bnd_Box` corners). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bboxDiagonal(oc: any, s: any, cleanup: Array<{ delete(): void }>): number {
  const box = new oc.Bnd_Box_1();
  cleanup.push(box);
  oc.BRepBndLib.Add(s, box, false);
  const mn = box.CornerMin();
  cleanup.push(mn);
  const mx = box.CornerMax();
  cleanup.push(mx);
  return Math.hypot(mx.X() - mn.X(), mx.Y() - mn.Y(), mx.Z() - mn.Z());
}

/** The bounding-box centre of a shape (via `Bnd_Box` corners). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bboxCenter(oc: any, s: any, cleanup: Array<{ delete(): void }>): Vec3 {
  const box = new oc.Bnd_Box_1();
  cleanup.push(box);
  oc.BRepBndLib.Add(s, box, false);
  const mn = box.CornerMin();
  cleanup.push(mn);
  const mx = box.CornerMax();
  cleanup.push(mx);
  return [(mn.X() + mx.X()) / 2, (mn.Y() + mx.Y()) / 2, (mn.Z() + mx.Z()) / 2];
}

/** The bounding-box min/max corners of a shape (via `Bnd_Box` corners) — used
 * by `alignSolids` to read a per-axis extent that `bboxCenter`/`bboxDiagonal`
 * don't expose, and by `entityFacts.ts`'s `checkInterferenceAll` for its cheap
 * AABB pair pre-filter (promoted from module-private to exported for that
 * caller, the same convention combineSolids/facePlane/bboxCenter each followed
 * for their own first cross-file caller). `Bnd_Box.Get()` is NOT bound in this
 * WASM build (see CLAUDE.md); `CornerMin`/`CornerMax` is the established
 * workaround every bbox reader here uses. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bboxExtent(oc: any, s: any, cleanup: Array<{ delete(): void }>): { min: Vec3; max: Vec3 } {
  const box = new oc.Bnd_Box_1();
  cleanup.push(box);
  oc.BRepBndLib.Add(s, box, false);
  const mn = box.CornerMin();
  cleanup.push(mn);
  const mx = box.CornerMax();
  cleanup.push(mx);
  return { min: [mn.X(), mn.Y(), mn.Z()], max: [mx.X(), mx.Y(), mx.Z()] };
}

/**
 * The analytic classification AND parameters of a face's surface, from ONE
 * `BRepAdaptor_Surface`.
 *
 * **Every accessor here was verified against the live WASM**, since none of
 * `.Cylinder()`/`.Cone()`/`.Sphere()`/`.Torus()` had a single call site in
 * this codebase and the bindings manifest lists class names only, with no
 * method-level information (this repo's history is full of green-but-broken
 * bindings — `ShapeFix_Shape`, `Message_ProgressRange_1`, `HLRBRep_*`).
 * Confirmed members: `gp_Cylinder{Radius,Location,Axis}`,
 * `gp_Cone{RefRadius,SemiAngle,Apex,Location,Axis}`,
 * `gp_Sphere{Radius,Location}` (note: **no `Axis()`**), and
 * `gp_Torus{MajorRadius,MinorRadius,Location,Axis}` — each round-tripped
 * against a primitive built with known parameters, and additionally against a
 * fillet-generated cylindrical face, which is the case that matters for
 * imported STEP (its faces come from someone else's kernel, not
 * `BRepPrimAPI`).
 *
 * **Every sub-accessor returns its own handle needing `.delete()`** — the
 * `gp_*` itself and each `Location()`/`Axis()`/`Direction()`/`Apex()` — hence
 * the cleanup discipline below, copied from what `facePlane` already did.
 *
 * **The type gate is symbolic and mandatory.** Calling the wrong accessor
 * (e.g. `.Cylinder()` on a plane) throws a raw JS `number` — an OCCT
 * exception pointer, not an `Error`, with no decoder available in this build
 * — so an escaped throw would surface to the user as the literal string
 * `"16412792"`. It is also not matched by `isOcctWasmAbort`, so it would not
 * trigger a (spurious) kernel reset. The `try/catch` below is what keeps that
 * contained; the parameter read degrades to `params: null` while `type` is
 * still reported.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function faceSurfaceInfo(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  oc: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  face: any,
  cleanup: Array<{ delete(): void }>
): { type: SurfaceType; params: SurfaceParams | null } {
  const surf = new oc.BRepAdaptor_Surface_2(face, true);
  cleanup.push(surf);
  const t = surf.GetType().value;
  const E = oc.GeomAbs_SurfaceType;

  // Keeps every handle a sub-accessor hands back, so the caller's `finally`
  // frees them in reverse order.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const keep = (...handles: any[]) => {
    for (const h of handles) if (h && typeof h.delete === "function") cleanup.push(h);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pointOf = (h: any): Vec3 => [h.X(), h.Y(), h.Z()];
  /** A `gp_Ax1`'s location + direction, both kept for cleanup. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const axisOf = (g: any): { loc: Vec3; dir: Vec3 } => {
    const ax = g.Axis();
    const l = ax.Location();
    const d = ax.Direction();
    const out = { loc: pointOf(l), dir: pointOf(d) };
    keep(ax, l, d);
    return out;
  };

  let type: SurfaceType = "other";
  let params: SurfaceParams | null = null;
  try {
    if (t === E.GeomAbs_Plane.value) {
      type = "plane";
      const pln = surf.Plane();
      const loc = pln.Location();
      const a = axisOf(pln);
      params = { kind: "plane", origin: pointOf(loc), normal: a.dir };
      keep(pln, loc);
    } else if (t === E.GeomAbs_Cylinder.value) {
      type = "cylinder";
      const cyl = surf.Cylinder();
      const a = axisOf(cyl);
      params = { kind: "cylinder", radius: cyl.Radius(), axisLocation: a.loc, axisDirection: a.dir };
      keep(cyl);
    } else if (t === E.GeomAbs_Cone.value) {
      type = "cone";
      const cone = surf.Cone();
      const a = axisOf(cone);
      const apex = cone.Apex();
      params = {
        kind: "cone",
        axisLocation: a.loc,
        axisDirection: a.dir,
        refRadius: cone.RefRadius(),
        apex: pointOf(apex),
        // Radians -> degrees, sign preserved (see SurfaceParams' doc).
        semiAngleDeg: cone.SemiAngle() * (180 / Math.PI),
      };
      keep(cone, apex);
    } else if (t === E.GeomAbs_Sphere.value) {
      type = "sphere";
      const sph = surf.Sphere();
      const loc = sph.Location();
      params = { kind: "sphere", center: pointOf(loc), radius: sph.Radius() };
      keep(sph, loc);
    } else if (t === E.GeomAbs_Torus.value) {
      type = "torus";
      const tor = surf.Torus();
      const a = axisOf(tor);
      params = {
        kind: "torus",
        axisLocation: a.loc,
        axisDirection: a.dir,
        majorRadius: tor.MajorRadius(),
        minorRadius: tor.MinorRadius(),
      };
      keep(tor);
    }
  } catch {
    // A parameter read failed; the classification stands on its own.
    params = null;
  }
  return { type, params };
}

/**
 * The (point, normal) of a planar face, or null if the face is not planar.
 *
 * A projection of {@link faceSurfaceInfo} — deliberately not a second reader,
 * so a plane's normal can never disagree with `surfaceParams`. Consumers:
 * `mateShape` below, and `entityFacts.ts`'s `measureExact` planar face-pair
 * branch.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function facePlane(oc: any, face: any, cleanup: Array<{ delete(): void }>): { pt: Vec3; nl: Vec3 } | null {
  try {
    const { params } = faceSurfaceInfo(oc, face, cleanup);
    return params?.kind === "plane" ? { pt: params.origin, nl: params.normal } : null;
  } catch {
    return null;
  }
}

/** The solid that contains `face` plus the remaining solids, or null if none. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function owningSolid(oc: any, shape: any, face: any, cleanup: Array<{ delete(): void }>): { owner: any; others: any[] } | null {
  const solids = collectSolids(oc, shape, cleanup);
  for (const s of solids) {
    const exp = new oc.TopExp_Explorer_2(s.solid, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    cleanup.push(exp);
    for (; exp.More(); exp.Next()) {
      const f = oc.TopoDS.Face_1(exp.Current());
      cleanup.push(f);
      if (f.IsSame(face)) {
        return { owner: s.solid, others: solids.filter((x) => x !== s).map((x) => x.solid) };
      }
    }
  }
  return null;
}

/**
 * Resolves an `edge-N` id back to its live edge — a thin wrapper around
 * `edgeEnumeration.ts`'s shared `enumerateEdges`, which is also what
 * `meshExtract.ts`'s `extractEdges` calls to assign `edge-N` ids in the first
 * place. Both paths now call the SAME enumerator, so a picked edge id is
 * guaranteed to resolve to the right live edge — see that module's doc
 * comment for why the two used to be independent, hand-duplicated copies and
 * why that was a latent id-corruption hazard.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function collectEdges(oc: any, shape: any, cleanup: Array<{ delete(): void }>): any[] {
  return enumerateEdges(oc, shape, cleanup).map((e) => e.edge);
}

/** Enumerates solids in deterministic explorer order, tagged `solid-N`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function collectSolids(oc: any, shape: any, cleanup: Array<{ delete(): void }>): Array<{ id: string; solid: any }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Array<{ id: string; solid: any }> = [];
  const exp = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_SOLID,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE
  );
  cleanup.push(exp);
  let i = 0;
  for (; exp.More(); exp.Next()) {
    const solid = oc.TopoDS.Solid_1(exp.Current());
    cleanup.push(solid);
    out.push({ id: `solid-${i++}`, solid });
  }
  return out;
}

/**
 * Enumerates unique vertices in the SAME order `extractVertices`
 * (`src/meshExtract.ts`) assigns `point-N` ids: `HashCode`+`IsSame` de-dup,
 * unconditional over the whole shape (no solid-ownership split, unlike faces).
 * Unlike `collectFaces`/`collectEdges`, this has no other caller today — points
 * are never resolved as edit-op operands — but the Gmsh parts-correlation
 * pipeline (`src/gmshPartsMap.ts`) needs it to resolve a part's `point-N` ids
 * back to live vertices for physical-group/sizing-field creation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function collectVertices(oc: any, shape: any, cleanup: Array<{ delete(): void }>): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  const seen = new Map<number, Array<{ IsSame(o: unknown): boolean }>>();
  const exp = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_VERTEX,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE
  );
  cleanup.push(exp);
  for (; exp.More(); exp.Next()) {
    const vertex = oc.TopoDS.Vertex_1(exp.Current());
    const hash = vertex.HashCode(HASH_UPPER);
    const bucket = seen.get(hash);
    if (bucket && bucket.some((v) => v.IsSame(vertex))) { vertex.delete(); continue; }
    cleanup.push(vertex);
    if (bucket) bucket.push(vertex); else seen.set(hash, [vertex]);
    out.push(vertex);
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function vec(oc: any, v: Vec3): any { return new oc.gp_Vec_4(v[0], v[1], v[2]); }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pnt(oc: any, v: Vec3): any { return new oc.gp_Pnt_3(v[0], v[1], v[2]); }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dir(oc: any, v: Vec3): any { return new oc.gp_Dir_4(v[0], v[1], v[2]); }
