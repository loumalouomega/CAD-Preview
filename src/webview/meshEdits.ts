import * as THREE from "three";
import { BREP_ONLY_OPS, type EditOp, type Vec3 } from "../editOps";

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
    const m = transformMatrixForOp(op);
    if (!m) continue; // booleans (M2) handled separately; everything else no-op here
    for (const target of resolveMeshTargets(root, transformTargets(op))) {
      // Local matrices of mesh roots are identity, so a world-space op matrix
      // applies correctly. applyMatrix4 premultiplies + re-decomposes.
      target.applyMatrix4(m);
    }
  }
  return root;
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
