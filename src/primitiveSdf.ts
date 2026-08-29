/**
 * Signed distance functions for the five primitive solids, and the max
 * deviation of a point set from one.
 *
 * **Why this is hand-rolled rather than an OCCT query.** The recognition
 * report (roadmap item 8 Phase 2) needs the MAXIMUM deviation between a
 * candidate primitive and the real solid's boundary, and this WASM build has
 * no maximum-distance query at all: `BRepExtrema_DistanceSS` constructs but
 * never computes, `BRepExtrema_ShapeType` is unbound, and
 * `Extrema_ExtFlag_MAX` is accepted then silently ignored (all recorded in
 * `entityFacts.ts`'s `measureExact` doc). Every primitive here has a
 * closed-form SDF, so the deviation is exact arithmetic with no kernel call —
 * which also makes it unit-testable headless.
 *
 * **Why the deviation is measured against the whole solid, not per face.** A
 * face that genuinely IS a `Geom_CylindricalSurface` has its tessellation
 * nodes on that cylinder BY CONSTRUCTION, so a per-face residual is always
 * ~0 and answers nothing. Measuring the whole boundary against the idealized
 * primitive is what catches the interesting cases — a box with one filleted
 * edge, a cylinder with a chamfered rim.
 *
 * Sign convention: negative inside, positive outside, zero on the surface.
 * Callers take `Math.abs`, since a point that is inside is just as much a
 * deviation as one outside.
 *
 * Lengths are in whatever units the caller's points are in — this module
 * never scales anything.
 */

export type Vec3 = [number, number, number];

/**
 * An idealized primitive, in world coordinates.
 *
 * `axis` is a unit direction; `center` means the geometric centre for box and
 * sphere, and the **base** centre for cylinder and cone — matching the
 * convention this codebase's own `addX` ops already use (`addBox`/`addSphere`
 * take the centre, `addCylinder`/`addCone` take the base), so a candidate can
 * be handed to those ops later without a coordinate conversion trap.
 */
export type Primitive =
  /** An INFINITE plane — the one unbounded member of this union, added for the
   * mesh-region fitting in `primitiveFit.ts`. Its signed distance is the
   * perpendicular offset, negative on the side the normal points away from. It
   * never arises from B-rep primitive recognition, which only ever produces
   * bounded solids. */
  | { kind: "plane"; point: Vec3; normal: Vec3 }
  | { kind: "box"; center: Vec3; size: Vec3; xAxis: Vec3; yAxis: Vec3; zAxis: Vec3 }
  | { kind: "sphere"; center: Vec3; radius: number }
  | { kind: "cylinder"; base: Vec3; axis: Vec3; radius: number; height: number }
  | { kind: "cone"; base: Vec3; axis: Vec3; radius1: number; radius2: number; height: number }
  | { kind: "torus"; center: Vec3; axis: Vec3; majorRadius: number; minorRadius: number };

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** Unit-length copy, or `null` for a degenerate vector. */
export function normalize(v: Vec3): Vec3 | null {
  const n = len(v);
  if (!Number.isFinite(n) || n < 1e-12) return null;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/**
 * 2D SDF of an axis-aligned rectangle centred at the origin — the shared
 * kernel of the cylinder and cone cases once a point is reduced to its
 * (radial, axial) coordinates. Standard formulation: outside distance from the
 * clamped corner, inside distance from the nearest edge.
 */
function sdRect2(px: number, py: number, hx: number, hy: number): number {
  const dx = Math.abs(px) - hx;
  const dy = Math.abs(py) - hy;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside;
}

/** Signed distance from `p` to `prim`'s boundary — negative inside. */
export function signedDistance(p: Vec3, prim: Primitive): number {
  switch (prim.kind) {
    case "plane":
      return dot(sub(p, prim.point), prim.normal);

    case "sphere":
      return len(sub(p, prim.center)) - prim.radius;

    case "box": {
      // Into the box's own frame, then the standard 3D box SDF.
      const d = sub(p, prim.center);
      const local: Vec3 = [dot(d, prim.xAxis), dot(d, prim.yAxis), dot(d, prim.zAxis)];
      const q: Vec3 = [
        Math.abs(local[0]) - prim.size[0] / 2,
        Math.abs(local[1]) - prim.size[1] / 2,
        Math.abs(local[2]) - prim.size[2] / 2,
      ];
      const outside = Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0));
      const inside = Math.min(Math.max(q[0], Math.max(q[1], q[2])), 0);
      return outside + inside;
    }

    case "cylinder": {
      // Reduce to (radial, axial) about the axis through `base`, then the
      // rectangle SDF — a capped cylinder is a rectangle revolved.
      const d = sub(p, prim.base);
      const axial = dot(d, prim.axis);
      const radial = len([
        d[0] - prim.axis[0] * axial,
        d[1] - prim.axis[1] * axial,
        d[2] - prim.axis[2] * axial,
      ]);
      // Rectangle centred at half height, so shift the axial coordinate.
      return sdRect2(radial, axial - prim.height / 2, prim.radius, prim.height / 2);
    }

    case "cone": {
      // A truncated cone (radius1 at the base, radius2 at the top) is a
      // trapezoid revolved. Exact distance to a trapezoid is fiddly, so this
      // takes the max of the three half-space distances (lateral, base cap,
      // top cap) — exact outside the lateral extent and a conservative
      // UNDER-estimate only in the corner regions, which is the safe
      // direction for a residual: it never overstates the deviation.
      const d = sub(p, prim.base);
      const axial = dot(d, prim.axis);
      const radial = len([
        d[0] - prim.axis[0] * axial,
        d[1] - prim.axis[1] * axial,
        d[2] - prim.axis[2] * axial,
      ]);
      const h = prim.height;
      const dr = prim.radius2 - prim.radius1;
      const slant = Math.hypot(h, dr);
      if (slant < 1e-12) return sdRect2(radial, axial - h / 2, prim.radius1, h / 2);
      // Signed distance to the infinite lateral surface: the line through
      // (radius1, 0) and (radius2, h) in the (radial, axial) half-plane.
      const lateral = (h * (radial - prim.radius1) - dr * axial) / slant;
      const caps = Math.abs(axial - h / 2) - h / 2;
      return Math.max(lateral, caps);
    }

    case "torus": {
      // Distance in the (distance-from-axis, along-axis) half-plane to the
      // circle of radius `majorRadius`, minus the tube radius.
      const d = sub(p, prim.center);
      const axial = dot(d, prim.axis);
      const radial = len([
        d[0] - prim.axis[0] * axial,
        d[1] - prim.axis[1] * axial,
        d[2] - prim.axis[2] * axial,
      ]);
      return Math.hypot(radial - prim.majorRadius, axial) - prim.minorRadius;
    }
  }
}

/**
 * The largest |signed distance| from any of `points` to `prim`'s boundary, or
 * `null` for an empty set or any non-finite input.
 *
 * `null` rather than `0` for the empty case, deliberately: the caller reports
 * a residual it could not compute as `null`, never as a perfect fit — the same
 * rule `checkMeshHealth` follows for a component that never closed.
 */
export function maxDeviation(points: readonly Vec3[], prim: Primitive): number | null {
  if (points.length === 0) return null;
  let worst = 0;
  for (const p of points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) return null;
    const d = Math.abs(signedDistance(p, prim));
    if (!Number.isFinite(d)) return null;
    if (d > worst) worst = d;
  }
  return worst;
}
