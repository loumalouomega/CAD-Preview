import { validateEditOp, type EditOp } from "./editOps";
import type { ConstructionPlane } from "./protocol";

export function resolvePlaneRefs(
  ops: EditOp[],
  planes: readonly ConstructionPlane[],
): { ops: EditOp[]; issues: string[] } {
  const issues: string[] = [];
  const resolved = ops.map((op, index) => {
    const planeId = (op as unknown as Record<string, unknown>).planeId as string | undefined;
    if (!planeId || typeof planeId !== "string") return op;
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
