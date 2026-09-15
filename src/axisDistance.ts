import type { Vec3 } from "./editOps";

/** Shortest distance between infinite lines, not finite cylinder surfaces.
 * Directions within 1e-12 radians of parallel use the parallel limit. */
export function axisDistance(a: Vec3, u: Vec3, b: Vec3, v: Vec3): number {
  const normalize = (x: Vec3): Vec3 => {
    const length = Math.hypot(...x);
    if (!Number.isFinite(length) || length === 0) throw new Error("Axis direction must be finite and nonzero");
    return x.map(n => n / length) as Vec3;
  };
  const cross = (x: Vec3, y: Vec3): Vec3 => [x[1]*y[2]-x[2]*y[1], x[2]*y[0]-x[0]*y[2], x[0]*y[1]-x[1]*y[0]];
  const delta = b.map((n, i) => n - a[i]) as Vec3;
  if (!delta.every(Number.isFinite)) throw new Error("Axis locations must be finite");
  const direction = normalize(u);
  const normal = cross(direction, normalize(v));
  const length = Math.hypot(...normal);
  return length <= 1e-12 ? Math.hypot(...cross(delta, direction))
    : Math.abs(delta.reduce((sum, n, i) => sum + n * normal[i], 0)) / length;
}
