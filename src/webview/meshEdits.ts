import * as THREE from "three";
import { Evaluator, Brush, ADDITION, SUBTRACTION, INTERSECTION } from "three-bvh-csg";
import { BREP_ONLY_OPS, type EditOp, type Vec3 } from "../editOps";

/** Single shared CSG evaluator (cheap to keep; avoids re-alloc per boolean). */
const csg = new Evaluator();

/**
 * Webview-side (Three.js) edit engine for mesh formats (STL/OBJ/PLY/glTF), which
 * have no OCCT shape in the host. Folds the replayable op-list over the loaded
 * `THREE.Object3D` so mesh edits are replayed on every open, mirroring how the
 * host folds ops over a B-rep shape.
 *
 * Targets are resolved by the same stable `node-N` ids `tagMeshEntities` assigns
 * (traversal order). Transforms apply a `THREE.Matrix4` to each target's local
 * matrix — the caller always passes a *pristine* clone so ops replay cleanly.
 * Feature-modeling ops are {@link BREP_ONLY_OPS} (meshes have no sketch/exact
 * topology) and are skipped here; the panel disables them for mesh files.
 */
export function applyEditsMesh(root: THREE.Object3D, ops: EditOp[]): THREE.Object3D {
  for (const op of ops) {
    if (BREP_ONLY_OPS.has(op.op)) continue; // not meaningful on a triangle mesh
    if (op.op === "boolean") { applyMeshBoolean(root, op); continue; }
    if (op.op === "explode") { applyMeshExplode(root, op.factor); continue; }
    const m = transformMatrixForOp(op);
    if (!m) continue; // anything else is a no-op on a mesh
    for (const target of resolveMeshTargets(root, transformTargets(op))) {
      // Local matrices of mesh roots are identity, so a world-space op matrix
      // applies correctly. applyMatrix4 premultiplies + re-decomposes.
      target.applyMatrix4(m);
    }
  }
  return root;
}

/**
 * Mesh boolean via `three-bvh-csg`. Resolves operand A/B to their first mesh
 * (the typical 1-vs-1 case), evaluates the CSG, and replaces both operands in the
 * tree with the single result mesh (tagged with A's node id so it stays pickable
 * and colourable). Unresolved operands are skipped, mirroring the host's graceful
 * boolean. Topology changes re-id facets on the next split — accepted id drift.
 */
function applyMeshBoolean(root: THREE.Object3D, op: Extract<EditOp, { op: "boolean" }>): void {
  const aMesh = firstMesh(resolveMeshTargets(root, op.a));
  const bMesh = firstMesh(resolveMeshTargets(root, op.b));
  if (!aMesh || !bMesh) return;

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
      const n = new THREE.Vector3(...op.planeNormal);
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
      return conjugateAboutPoint(r, op.planePoint);
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
