import { validateEditOp, type EditOp } from "./editOps";
import type { ConstructionPlane } from "./protocol";
import { profilePlacementFromPlane } from "./planeFrame";

const PROFILE_WITH_PLANE_OPS: ReadonlySet<string> = new Set([
  "addCircleProfile",
  "addRectangleProfile",
  "addPolygonProfile",
]);

export function resolvePlaneRefs(
  ops: EditOp[],
  planes: readonly ConstructionPlane[],
): { ops: EditOp[]; issues: string[] } {
  const issues: string[] = [];
  const resolved = ops.map((op, index) => {
    const planeId = (op as unknown as Record<string, unknown>).planeId as string | undefined;
    if (!planeId || typeof planeId !== "string") return op;
    if (PROFILE_WITH_PLANE_OPS.has(op.op)) return resolveProfilePlane(op, index, planeId, planes, issues);
    const plane = planes.find((p) => p.id === planeId);
    if (!plane) {
      const hasCache = (op as unknown as Record<string, unknown>).planePoint !== undefined
        && (op as unknown as Record<string, unknown>).planeNormal !== undefined;
      if (hasCache) {
        issues.push(`edit ${index + 1} (${op.op}): plane ${planeId} not found — keeping last position`);
      } else {
        issues.push(`edit ${index + 1} (${op.op}): plane ${planeId} not found — the op has no cached plane and will be skipped at replay`);
      }
      return op;
    }
    const clone = JSON.parse(JSON.stringify(op)) as EditOp;
    (clone as unknown as Record<string, unknown>).planePoint = [...plane.point] as [number, number, number];
    (clone as unknown as Record<string, unknown>).planeNormal = [...plane.normal] as [number, number, number];
    const revalidated = validateEditOp(clone);
    if (!revalidated) {
      issues.push(`edit ${index + 1} (${op.op}): resolved plane ${planeId} produced invalid values — keeping previous values`);
      return op;
    }
    return revalidated;
  });
  return { ops: resolved, issues };
}

/**
 * Resolves a plane-authored profile (`addCircleProfile`/`addRectangleProfile`/
 * `addPolygonProfile` with `planeId`): placement comes from the plane frame
 * plus the op's own `offsetU`/`offsetV`/`rotationDeg`, overwriting the cached
 * `center`/`normal`/`up`. A missing plane freezes last-good caches (the same
 * convention as the planePoint/planeNormal branch above — changing a plane
 * moves everything referencing it; deleting one freezes placement): with a
 * complete cache the op still replays, without one it skips gracefully at
 * replay (`addProfile` names the plane). Re-validation keeps a resolved
 * placement that violates a cross-field rule from ever reaching the kernel.
 */
function resolveProfilePlane(
  op: EditOp,
  index: number,
  planeId: string,
  planes: readonly ConstructionPlane[],
  issues: string[],
): EditOp {
  const raw = op as unknown as Record<string, unknown>;
  const plane = planes.find((p) => p.id === planeId);
  const hasCache = raw.center !== undefined && raw.normal !== undefined;
  if (!plane) {
    if (hasCache) {
      issues.push(`edit ${index + 1} (${op.op}): plane ${planeId} not found — keeping last position`);
    } else {
      issues.push(`edit ${index + 1} (${op.op}): plane ${planeId} not found — the op has no cached placement and will be skipped at replay`);
    }
    return op;
  }
  const offsetU = typeof raw.offsetU === "number" ? raw.offsetU : 0;
  const offsetV = typeof raw.offsetV === "number" ? raw.offsetV : 0;
  const rotationDeg = typeof raw.rotationDeg === "number" ? raw.rotationDeg : 0;
  const placement = profilePlacementFromPlane(plane, offsetU, offsetV, rotationDeg);
  if (!placement) {
    issues.push(`edit ${index + 1} (${op.op}): plane ${planeId} has a degenerate frame — keeping previous values`);
    return op;
  }
  const clone = JSON.parse(JSON.stringify(op)) as unknown as Record<string, unknown>;
  clone.center = [...placement.center] as [number, number, number];
  clone.normal = [...placement.normal] as [number, number, number];
  if (op.op === "addRectangleProfile" || op.op === "addPolygonProfile") {
    clone.up = [...placement.up] as [number, number, number];
  }
  const revalidated = validateEditOp(clone);
  if (!revalidated) {
    issues.push(`edit ${index + 1} (${op.op}): resolved plane ${planeId} produced invalid values — keeping previous values`);
    return op;
  }
  return revalidated;
}
