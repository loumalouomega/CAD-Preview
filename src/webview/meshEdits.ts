import * as THREE from "three";
import { Evaluator, Brush, ADDITION, SUBTRACTION, INTERSECTION } from "three-bvh-csg";
import { BREP_ONLY_OPS, type EditOp, type Vec3, type OpOutcome } from "../editOps";
import { makeFaceMaterial } from "./geometryBuilder";

/** Single shared CSG evaluator (cheap to keep; avoids re-alloc per boolean). */
const csg = new Evaluator();

/** Above this many combined triangles, a `three-bvh-csg` boolean/hole would
 * likely freeze the webview's main thread — degrade to a status message
 * instead. Tuned empirically against THIS codebase's `Evaluator` (not a
 * number borrowed from a different boolean engine); see `doc/roadmap.md`'s
 * Tier 2 item 1 note on why the threshold must come from local timing. */
export const MESH_CSG_MAX_TRIANGLES = 150_000;

/** Triangle count of a mesh's geometry (indexed or non-indexed). 0 if none. */
export function meshTriangleCount(mesh: THREE.Object3D | null | undefined): number {
  const geo = (mesh as THREE.Mesh | null | undefined)?.geometry as
    | THREE.BufferGeometry
    | undefined;
  if (!geo) return 0;
  const pos = geo.attributes.position as THREE.BufferAttribute | undefined;
  if (!pos) return 0;
  const idx = geo.index;
  return (idx ? idx.count : pos.count) / 3;
}

/**
 * Webview-side (Three.js) edit engine for mesh formats (STL/OBJ/PLY/glTF), which
 * have no OCCT shape in the host. Folds the replayable op-list over the loaded
 * `THREE.Object3D` so mesh edits are replayed on every open, mirroring how the
 * host folds ops over a B-rep shape.
 *
 * Targets are resolved by the same stable `node-N` ids `tagMeshEntities assigns`
 * (traversal order). Transforms apply a `THREE.Matrix4` to each target's local
 * matrix — the caller always passes a *pristine* clone so ops replay cleanly.
 * Feature-modeling ops are {@link BREP_ONLY_OPS} (meshes have no sketch/exact
 * topology) and are skipped here; the panel disables them for mesh files.
 *
 * When `outcomes` is given, one {@link OpOutcome} is pushed per op — the
 * webview-side half of the "a failed edit op is indistinguishable from one
 * that did nothing" fix (the host's `applyEditsBRep` is the other half).
 * Unlike the host, there is no shared shape handle to identity-compare against,
 * so each dispatch site reports explicitly.
 */
export function applyEditsMesh(
  root: THREE.Object3D,
  ops: EditOp[],
  outcomes?: OpOutcome[],
  report?: (msg: string) => void
): THREE.Object3D {
  // Counts only `addX` ops seen so far in THIS fold pass, so `prim-{K}` ids are
  // deterministic by op-list position and stable across repeated replays of the
  // same list (independent of whether a given primitive's mesh build succeeds).
  const ctx = { primCount: 0, patternCount: 0 };
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    const outcome: OpOutcome = { index, kind: op.op, applied: true };
    // First `fail` call wins for this op.
    const fail: (diagnostic: string, hint?: string) => void = (diagnostic, hint) => {
      if (!outcome.applied) return;
      outcome.applied = false;
      outcome.diagnostic = diagnostic;
      if (hint) outcome.hint = hint;
    };
    applyOneOpMesh(root, op, fail, ctx, report);
    outcomes?.push(outcome);
  }
  return root;
}

/** The fold-pass id counters (`prim-{K}` / `pattern-{K}`), owned by one
 * {@link applyEditsMesh} call — never module state, so repeated replays of
 * the same list stay deterministic. */
interface MeshFoldCtx {
  primCount: number;
  patternCount: number;
}

/** One op's dispatch for the mesh engine. */
function applyOneOpMesh(
  root: THREE.Object3D,
  op: EditOp,
  fail: (diagnostic: string, hint?: string) => void,
  ctx: MeshFoldCtx,
  report?: (msg: string) => void
): void {
  if ((op as any).midplaneFaces) { fail(`midplaneFaces requires a B-rep source with analytic faces`); return; }
  if ((op as any).midaxisOf) { fail(`midaxisOf requires a B-rep source with analytic faces`); return; }
  if (BREP_ONLY_OPS.has(op.op)) {
    fail(`${op.op} is B-rep only — triangle meshes have no sketch/exact topology for it`);
    return; // not meaningful on a triangle mesh
  }
  if (op.op === "boolean") {
    if (!applyMeshBoolean(root, op, fail, report)) {
      // Dense guard already called `fail`+`report` inside; first-wins makes
      // this second `fail` a no-op in that case, and the correct diagnostic
      // for the unresolved-operand case otherwise.
      fail("operand A/B node ids did not resolve to meshes", "re-check node-N ids — load_model/get_state lists them");
    }
    return;
  }
  if (op.op === "explode") {
    applyMeshExplode(root, op.factor); // spreads whatever nodes exist; always applies
    return;
  }
  if (op.op === "align") {
    if (!applyMeshAlign(root, op)) {
      fail("no target moved", "target node-N ids may not resolve, or every target is already at the requested coordinate");
    }
    return;
  }
  if (op.op === "patternLinear" || op.op === "patternCircular") {
    const result = applyMeshPattern(root, op, ctx.patternCount);
    ctx.patternCount = result.nextId;
    if (!result.applied) fail("no copies were added", "target node-N ids may not resolve, or count is 1 (a pattern's count INCLUDES the original)");
    return;
  }
  // Holes MUST dispatch before the `add*` primitive branch below (their op
  // names also start with "add") — they subtract from an existing target and
  // never produce a `prim-{K}` body, so they don't touch `primCount` either.
  if (op.op === "addHole" || op.op === "addCounterboreHole" || op.op === "addCountersinkHole") {
    if (!applyMeshHole(root, op, fail, report)) {
      fail("target node id did not resolve to a mesh", "re-check node-N ids — load_model/get_state lists them");
    }
    return;
  }
  if (op.op.startsWith("add")) {
    const mesh = buildPrimitiveMesh(op);
    if (mesh) {
      mesh.userData.groupId = `prim-${ctx.primCount}`;
      root.add(mesh);
    }
    ctx.primCount++;
    return;
  }
  const m = transformMatrixForOp(op);
  if (!m) {
    fail(`op kind "${op.op}" has no mesh equivalent`);
    return; // anything else is a no-op on a mesh
  }
  const targetIds = transformTargets(op);
  const targets = resolveMeshTargets(root, targetIds);
  if (targets.length === 0 && targetIds.length > 0) {
    fail(
      `none of the target ids (${targetIds.join(", ")}) resolve`,
      "re-check node-N ids — load_model/get_state lists them"
    );
    return;
  }
  for (const target of targets) {
    // Local matrices of mesh roots are identity, so a world-space op matrix
    // applies correctly. applyMatrix4 premultiplies + re-decomposes.
    target.applyMatrix4(m);
  }
}

/**
 * Mesh boolean via `three-bvh-csg`. Resolves operand A/B to their first mesh
 * (the typical 1-vs-1 case), evaluates the CSG, and replaces both operands in the
 * tree with the single result mesh (tagged with A's node id so it stays pickable
 * and colourable). Unresolved operands are skipped (returns false), mirroring the
 * host's graceful boolean. Topology changes re-id facets on the next split —
 * accepted id drift.
 */
function applyMeshBoolean(
  root: THREE.Object3D,
  op: Extract<EditOp, { op: "boolean" }>,
  fail?: (diagnostic: string, hint?: string) => void,
  report?: (msg: string) => void
): boolean {
  const aMesh = firstMesh(resolveMeshTargets(root, op.a));
  const bMesh = firstMesh(resolveMeshTargets(root, op.b));
  if (!aMesh || !bMesh) return false;
  const denseTotal = meshTriangleCount(aMesh) + meshTriangleCount(bMesh);
  if (denseTotal > MESH_CSG_MAX_TRIANGLES) {
    const msg = "mesh too dense for a boolean here — try Promote to B-rep first";
    fail?.(msg, "convert via Mesh Health → Promote to B-rep… and re-apply the boolean");
    report?.(msg);
    return false;
  }

  const brushA = new Brush(aMesh.geometry);
  aMesh.updateWorldMatrix(true, false);
  brushA.matrix.copy(aMesh.matrixWorld);
  brushA.matrixAutoUpdate = false;
  const brushB = new Brush(bMesh.geometry);
  bMesh.updateWorldMatrix(true, false);
  brushB.matrix.copy(bMesh.matrixWorld);
  brushB.matrixAutoUpdate = false;

  const operation =
    op.kind === "union" ? ADDITION : op.kind === "subtract" ? SUBTRACTION : INTERSECTION;
  const result = csg.evaluate(brushA, brushB, operation);

  const out = new THREE.Mesh(result.geometry, aMesh.material);
  out.userData.groupId = op.a[0]; // keep a stable id for tagging/colouring

  // Remove both operands (and any extra resolved targets) then attach the result.
  for (const o of [...resolveMeshTargets(root, op.a), ...resolveMeshTargets(root, op.b)]) {
    o.parent?.remove(o);
  }
  root.add(out);
  return true;
}

/**
 * Mesh hole (plain / counterbored / countersunk) via `three-bvh-csg`: subtracts
 * a cylinder tool brush — plus, for the mouth feature, a second wider cylinder
 * (counterbore) or a cone (countersink) as a second sequential SUBTRACTION —
 * from the first mesh of the resolved targets, then replaces the target with
 * the result (tagged with the target's node id, mirroring
 * {@link applyMeshBoolean}). Tool placement reuses {@link baseAlignedMatrix}:
 * the mouth sits at `position`, drilled along `axis` into the material.
 * Unresolved targets are skipped.
 */
function applyMeshHole(
  root: THREE.Object3D,
  op: Extract<EditOp, { op: "addHole" | "addCounterboreHole" | "addCountersinkHole" }>,
  fail?: (diagnostic: string, hint?: string) => void,
  report?: (msg: string) => void
): boolean {
  const targetMesh = firstMesh(resolveMeshTargets(root, op.targets));
  if (!targetMesh) return false;
  // Holes subtract a small tool (32-segment cylinder/cone) from one target, so
  // only the target's own density matters — the tool is negligible either way.
  if (meshTriangleCount(targetMesh) > MESH_CSG_MAX_TRIANGLES) {
    const msg = "mesh too dense for a hole here — try Promote to B-rep first";
    fail?.(msg, "convert via Mesh Health → Promote to B-rep… and re-apply the hole");
    report?.(msg);
    return false;
  }

  const toolBrush = (geo: THREE.BufferGeometry, height: number): Brush => {
    const b = new Brush(geo);
    b.matrix.copy(baseAlignedMatrix(op.position, op.axis, height));
    b.matrixAutoUpdate = false;
    return b;
  };
  const tools: Brush[] = [
    toolBrush(new THREE.CylinderGeometry(op.radius, op.radius, op.depth, 32), op.depth),
  ];
  if (op.op === "addCounterboreHole") {
    tools.push(toolBrush(new THREE.CylinderGeometry(op.cbRadius, op.cbRadius, op.cbDepth, 32), op.cbDepth));
  } else if (op.op === "addCountersinkHole") {
    // Cone from csRadius at the surface down to the hole radius; local +Y is
    // the TOP in CylinderGeometry(rTop, rBottom, …), and baseAlignedMatrix puts
    // the local −Y end (the wide csRadius base) at `position`.
    const coneDepth = (op.csRadius - op.radius) / Math.tan((op.csAngleDeg * Math.PI) / 360);
    tools.push(toolBrush(new THREE.CylinderGeometry(op.radius, op.csRadius, coneDepth, 32), coneDepth));
  }

  const targetBrush = new Brush(targetMesh.geometry);
  targetMesh.updateWorldMatrix(true, false);
  targetBrush.matrix.copy(targetMesh.matrixWorld);
  targetBrush.matrixAutoUpdate = false;

  let result = targetBrush;
  for (const tool of tools) result = csg.evaluate(result, tool, SUBTRACTION);

  const out = new THREE.Mesh(result.geometry, targetMesh.material);
  out.userData.groupId = op.targets[0]; // keep a stable id for tagging/colouring
  for (const o of resolveMeshTargets(root, op.targets)) o.parent?.remove(o);
  root.add(out);
  return true;
}

/**
 * Mesh **explode**: spreads each top-level node radially from the model centre by
 * `factor` (mirrors the host's `explodeSolids`). Each child is translated by
 * `(childCentre − modelCentre) · factor` using `THREE.Box3` world bounds.
 */
function applyMeshExplode(root: THREE.Object3D, factor: number): void {
  const whole = new THREE.Box3().setFromObject(root);
  if (whole.isEmpty()) return;
  const c = whole.getCenter(new THREE.Vector3());
  for (const child of [...root.children]) {
    const b = new THREE.Box3().setFromObject(child);
    if (b.isEmpty()) continue;
    const off = b.getCenter(new THREE.Vector3()).sub(c).multiplyScalar(factor);
    child.applyMatrix4(new THREE.Matrix4().makeTranslation(off.x, off.y, off.z));
  }
}

/** Translates each targeted object along `op.axis` so its OWN world-space bbox
 * `op.extent` (min/center/max — `THREE.Box3.min`/`.max` index by the SAME
 * `"x"|"y"|"z"` keys `op.axis` already uses) lands at `op.to`, mirroring
 * `occtOperations.ts`'s `alignSolids` (always independent per target, no
 * "whole selection as one rigid group" shortcut). A target already at the
 * target coordinate (`|delta| < 1e-9`) is left untouched. Returns whether any
 * target actually moved. */
function applyMeshAlign(root: THREE.Object3D, op: Extract<EditOp, { op: "align" }>): boolean {
  const idx = op.axis === "x" ? 0 : op.axis === "y" ? 1 : 2;
  let moved = 0;
  for (const target of resolveMeshTargets(root, op.targets)) {
    const box = new THREE.Box3().setFromObject(target);
    if (box.isEmpty()) continue;
    const current = op.extent === "min" ? box.min[op.axis] : op.extent === "max" ? box.max[op.axis] : (box.min[op.axis] + box.max[op.axis]) / 2;
    const delta = op.to - current;
    if (Math.abs(delta) < 1e-9) continue;
    moved++;
    const v: Vec3 = [0, 0, 0];
    v[idx] = delta;
    target.applyMatrix4(new THREE.Matrix4().makeTranslation(...v));
  }
  return moved > 0;
}

/**
 * Linear/circular array: for each resolved target, clones it (`Object3D.clone
 * (true)` — geometry/materials shared by reference, only the transform is
 * independent) `op.count - 1` times, applying an increasing offset to each
 * copy while leaving the ORIGINAL untouched — mirroring `occtOperations.ts`'s
 * `patternSolids` "keep original + append copies" shape. Each clone gets a
 * fresh `pattern-{K}` id (`nextId`, threaded through by the caller so ids
 * stay unique and deterministic across the whole op-list fold, the same
 * discipline `primCount` already uses for `addX` ops). Returns the updated
 * counter.
 */
function applyMeshPattern(
  root: THREE.Object3D,
  op: Extract<EditOp, { op: "patternLinear" | "patternCircular" }>,
  nextId: number
): { nextId: number; applied: boolean } {
  const transformAt: (k: number) => THREE.Matrix4 =
    op.op === "patternLinear"
      ? (() => {
          const dir = new THREE.Vector3(...op.direction);
          if (dir.lengthSq() === 0) return () => new THREE.Matrix4();
          dir.normalize();
          return (k: number) => new THREE.Matrix4().makeTranslation(dir.x * op.spacing * k, dir.y * op.spacing * k, dir.z * op.spacing * k);
        })()
      : (() => {
          const axis = new THREE.Vector3(...(op as any).axisDir);
          if (!axis || axis.lengthSq() === 0) return () => new THREE.Matrix4();
          axis.normalize();
          return (k: number) => conjugateAboutPoint(new THREE.Matrix4().makeRotationAxis(axis, ((op as any).angleDeg * k * Math.PI) / 180), (op as any).axisPoint);
        })();

  let added = 0;
  for (const target of resolveMeshTargets(root, op.targets)) {
    for (let k = 1; k < op.count; k++) {
      const clone = target.clone(true);
      clone.applyMatrix4(transformAt(k));
      clone.userData.groupId = `pattern-${nextId++}`;
      root.add(clone);
      added++;
    }
  }
  return { nextId, applied: added > 0 };
}

/**
 * Primitive creation: builds a brand-new `THREE.Mesh` from op parameters (no
 * existing geometry read). Since `applyEditsMesh` always folds over a *fresh
 * clone* of the pristine loaded object (see `rebuildMeshModel` in `main.ts`),
 * primitives don't pre-exist in that clone — this constructs-and-attaches them on
 * every single replay, mirroring the host's `addPrimitive`/`buildPrimitiveSolid`
 * append pattern. Reuses `makeFaceMaterial()` so primitives look identical to
 * every other surface (parts colouring overrides it the same way either way).
 * Canonical Three.js orientations: `CylinderGeometry`/`ConeGeometry` are
 * vertically centred on local +Y; `TorusGeometry`'s ring lies in the local
 * XY-plane with its hole axis along local +Z. Both are rotated to the op's
 * `axis` via `Quaternion.setFromUnitVectors`, then translated into place.
 */
function buildPrimitiveMesh(op: EditOp): THREE.Mesh | null {
  switch (op.op) {
    case "addBox": {
      const geo = new THREE.BoxGeometry(op.size[0], op.size[1], op.size[2]);
      const mesh = new THREE.Mesh(geo, makeFaceMaterial());
      mesh.applyMatrix4(new THREE.Matrix4().makeTranslation(...op.center));
      return mesh;
    }
    case "addSphere": {
      const geo = new THREE.SphereGeometry(op.radius, 32, 24);
      const mesh = new THREE.Mesh(geo, makeFaceMaterial());
      mesh.applyMatrix4(new THREE.Matrix4().makeTranslation(...op.center));
      return mesh;
    }
    case "addCylinder": {
      const geo = new THREE.CylinderGeometry(op.radius, op.radius, op.height, 32);
      const mesh = new THREE.Mesh(geo, makeFaceMaterial());
      mesh.applyMatrix4(baseAlignedMatrix(op.center, op.axis, op.height));
      return mesh;
    }
    case "addCone": {
      // Three's CylinderGeometry(radiusTop, radiusBottom, ...): local +Y is TOP.
      // Our op has radius1 = base, radius2 = top, matching the OCCT convention.
      const geo = new THREE.CylinderGeometry(op.radius2, op.radius1, op.height, 32);
      const mesh = new THREE.Mesh(geo, makeFaceMaterial());
      mesh.applyMatrix4(baseAlignedMatrix(op.center, op.axis, op.height));
      return mesh;
    }
    case "addTorus": {
      const geo = new THREE.TorusGeometry(op.majorRadius, op.minorRadius, 16, 48);
      const mesh = new THREE.Mesh(geo, makeFaceMaterial());
      mesh.applyMatrix4(centerAlignedMatrix(op.center, op.axis));
      return mesh;
    }
    case "addPrism": {
      const effR = op.circumscribed ? op.radius / Math.cos(Math.PI / op.sides) : op.radius;
      const geo = new THREE.CylinderGeometry(effR, effR, op.height, op.sides);
      const mesh = new THREE.Mesh(geo, makeFaceMaterial());
      mesh.applyMatrix4(baseAlignedMatrix(op.center, op.axis, op.height));
      return mesh;
    }
    default:
      return null;
  }
}

const CANONICAL_Y = new THREE.Vector3(0, 1, 0);
const CANONICAL_Z = new THREE.Vector3(0, 0, 1);
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

/**
 * World matrix for a +Y-canonical, vertically-centred geometry (Cylinder/Cone)
 * whose BASE (local Y = −height/2) must land at `center`, extruded along `axis`.
 * Rotates canonical +Y onto `axis` first, then translates by `+height/2` along
 * the (now-rotated) axis so the base — not the centre — lands on `center`.
 */
function baseAlignedMatrix(center: Vec3, axis: Vec3, height: number): THREE.Matrix4 {
  const axisVec = new THREE.Vector3(...axis);
  if (axisVec.lengthSq() === 0) axisVec.set(0, 1, 0); else axisVec.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(CANONICAL_Y, axisVec);
  const pos = new THREE.Vector3(...center).addScaledVector(axisVec, height / 2);
  return new THREE.Matrix4().compose(pos, q, UNIT_SCALE);
}

/**
 * World matrix for a +Z-canonical, centre-symmetric geometry (Torus) whose
 * CENTRE lands at `center`, ring normal rotated from canonical +Z onto `axis`.
 */
function centerAlignedMatrix(center: Vec3, axis: Vec3): THREE.Matrix4 {
  const axisVec = new THREE.Vector3(...axis);
  if (axisVec.lengthSq() === 0) axisVec.set(0, 0, 1); else axisVec.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(CANONICAL_Z, axisVec);
  return new THREE.Matrix4().compose(new THREE.Vector3(...center), q, UNIT_SCALE);
}

/** The first `THREE.Mesh` among `objs` or their descendants. */
function firstMesh(objs: THREE.Object3D[]): THREE.Mesh | null {
  for (const o of objs) {
    let found: THREE.Mesh | null = null;
    o.traverse((c) => { if (!found && (c as THREE.Mesh).isMesh) found = c as THREE.Mesh; });
    if (found) return found;
  }
  return null;
}

/** The target ids of a transform op (empty for ops that have no `targets`). */
function transformTargets(op: EditOp): string[] {
  switch (op.op) {
    case "translate":
    case "rotate":
    case "scale":
    case "mirror":
      return op.targets;
    default:
      return [];
  }
}

/**
 * The world-space `THREE.Matrix4` for a transform op, or null if the op is not a
 * (mesh-supported) transform. Pure — unit-tested headless.
 */
export function transformMatrixForOp(op: EditOp): THREE.Matrix4 | null {
  switch (op.op) {
    case "translate":
      return new THREE.Matrix4().makeTranslation(op.vec[0], op.vec[1], op.vec[2]);
    case "rotate": {
      const axis = new THREE.Vector3(...op.axisDir);
      if (axis.lengthSq() === 0) return new THREE.Matrix4();
      axis.normalize();
      const r = new THREE.Matrix4().makeRotationAxis(axis, (op.angleDeg * Math.PI) / 180);
      return conjugateAboutPoint(r, op.axisPoint);
    }
    case "scale": {
      const s = new THREE.Matrix4().makeScale(op.factors[0], op.factors[1], op.factors[2]);
      return conjugateAboutPoint(s, op.center);
    }
    case "mirror": {
      if ((op as any).midplaneFaces) return null;
      const n = new THREE.Vector3(...((op as any).planeNormal ?? [0,0,0]));
      if (n.lengthSq() === 0) return new THREE.Matrix4();
      n.normalize();
      // Householder reflection R = I − 2·n·nᵀ across the plane through the origin.
      const [x, y, z] = [n.x, n.y, n.z];
      const r = new THREE.Matrix4().set(
        1 - 2 * x * x, -2 * x * y, -2 * x * z, 0,
        -2 * x * y, 1 - 2 * y * y, -2 * y * z, 0,
        -2 * x * z, -2 * y * z, 1 - 2 * z * z, 0,
        0, 0, 0, 1
      );
      return conjugateAboutPoint(r, (op as any).planePoint);
    }
    default:
      return null;
  }
}

/** Returns T(p) · M · T(−p): applies M about the point `p` instead of the origin. */
function conjugateAboutPoint(m: THREE.Matrix4, p: Vec3): THREE.Matrix4 {
  const toP = new THREE.Matrix4().makeTranslation(p[0], p[1], p[2]);
  const fromP = new THREE.Matrix4().makeTranslation(-p[0], -p[1], -p[2]);
  return toP.multiply(m).multiply(fromP);
}

/** Resolves the sub-objects whose `groupId` (node id) is in `ids`. */
export function resolveMeshTargets(root: THREE.Object3D, ids: string[]): THREE.Object3D[] {
  const want = new Set(ids);
  const found: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (want.has(o.userData.groupId as string)) found.push(o);
  });
  return found;
}
