/**
 * Least-squares fits of a plane, sphere, and cylinder to a point set
 * (roadmap item 9).
 *
 * Pure and dependency-free, matching every other pure mesh module here — and
 * necessarily hand-rolled: there is no eigensolver, covariance builder, or
 * linear solver anywhere in this repo, and no matrix library in the host
 * dependency set.
 *
 * **Every fit here is unbounded** — an infinite plane, a whole sphere, an
 * infinite cylinder. The caller clips them to the region's own extent before
 * measuring a residual, because `primitiveSdf.ts`'s `Primitive` describes
 * bounded solids (its cylinder has a `base` and a finite `height`), and an
 * unclipped axis would report every point beyond the caps as deviation.
 */

export type Vec3 = [number, number, number];
export type Mat3 = [number, number, number, number, number, number, number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export function normalize(v: Vec3): Vec3 | null {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(n) || n < 1e-12) return null;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** Arithmetic mean of the points, or `null` for an empty set. */
export function centroid(points: readonly Vec3[]): Vec3 | null {
  if (points.length === 0) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
    z += p[2];
  }
  const n = points.length;
  return [x / n, y / n, z / n];
}

/** Covariance of the points about their own centroid, row-major. */
export function covariance(points: readonly Vec3[], about: Vec3): Mat3 {
  const m: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of points) {
    const d = sub(p, about);
    m[0] += d[0] * d[0];
    m[1] += d[0] * d[1];
    m[2] += d[0] * d[2];
    m[4] += d[1] * d[1];
    m[5] += d[1] * d[2];
    m[8] += d[2] * d[2];
  }
  m[3] = m[1];
  m[6] = m[2];
  m[7] = m[5];
  return m;
}

export interface Eigen {
  /** Ascending by eigenvalue, so `[0]` is the smallest. */
  values: [number, number, number];
  /** Unit eigenvectors, in the same order as `values`. */
  vectors: [Vec3, Vec3, Vec3];
}

/**
 * Eigen-decomposition of a 3×3 SYMMETRIC matrix by the cyclic Jacobi method.
 *
 * Symmetric-only is the whole reason this is short: Jacobi zeroes one
 * off-diagonal pair per rotation and converges unconditionally for a real
 * symmetric matrix, with no pivoting or deflation. Every matrix this module
 * feeds it is a covariance, which is symmetric by construction.
 *
 * Results are sorted ascending, because every consumer here wants the
 * SMALLEST eigenvector: the plane normal is the direction of least variance,
 * and a cylinder's axis is the direction of least variance of its normals.
 */
export function symmetricEigen(matrix: Mat3): Eigen {
  const a = [
    [matrix[0], matrix[1], matrix[2]],
    [matrix[3], matrix[4], matrix[5]],
    [matrix[6], matrix[7], matrix[8]],
  ];
  // Accumulated rotations — columns end up as the eigenvectors.
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let sweep = 0; sweep < 64; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-16) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = a[p][q];
      if (Math.abs(apq) < 1e-20) continue;
      // Rotation angle that annihilates a[p][q].
      const theta = (a[q][q] - a[p][p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k];
        const aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p];
        const vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }

  const pairs: { value: number; vector: Vec3 }[] = [0, 1, 2].map((i) => ({
    value: a[i][i],
    vector: normalize([v[0][i], v[1][i], v[2][i]]) ?? [0, 0, 1],
  }));
  pairs.sort((x, y) => x.value - y.value);
  return {
    values: [pairs[0].value, pairs[1].value, pairs[2].value],
    vectors: [pairs[0].vector, pairs[1].vector, pairs[2].vector],
  };
}

/**
 * Solves a small dense linear system by Gaussian elimination with partial
 * pivoting, or `null` if it is singular. Used by both Kasa fits.
 */
export function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    out[i] = m[i][n] / m[i][i];
    if (!Number.isFinite(out[i])) return null;
  }
  return out;
}

export interface PlaneFit {
  point: Vec3;
  normal: Vec3;
}

/**
 * Best-fit plane by point PCA: the centroid, and the direction of LEAST
 * variance as the normal.
 *
 * Needs three non-collinear points; collinear or coincident input yields
 * `null` rather than an arbitrary normal from a degenerate covariance.
 */
export function fitPlane(points: readonly Vec3[]): PlaneFit | null {
  if (points.length < 3) return null;
  const c = centroid(points);
  if (!c) return null;
  const eig = symmetricEigen(covariance(points, c));
  // Collinear input leaves TWO near-zero eigenvalues, so the normal is not
  // determined. Compare against the largest, so the test is scale-free.
  const spread = eig.values[2];
  if (spread < 1e-20 || eig.values[1] / spread < 1e-12) return null;
  return { point: c, normal: eig.vectors[0] };
}

export interface SphereFit {
  center: Vec3;
  radius: number;
}

/**
 * Best-fit sphere by the Kasa method — algebraic least squares on
 * `x²+y²+z² = 2ax + 2by + 2cz + d`, which is LINEAR in `(a,b,c,d)`.
 *
 * Kasa minimizes algebraic rather than geometric distance, so it is biased
 * when the points cover only a small cap of the sphere. That is acceptable
 * here precisely because the fit is published alongside its geometric residual
 * — a biased fit shows up as a large residual rather than as a confident wrong
 * answer.
 */
export function fitSphere(points: readonly Vec3[]): SphereFit | null {
  if (points.length < 4) return null;
  const c0 = centroid(points);
  if (!c0) return null;
  // Solve in centroid-local coordinates: the normal equations are far better
  // conditioned when the points are not far from the origin.
  const m = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const rhs = [0, 0, 0, 0];
  for (const p of points) {
    const x = p[0] - c0[0];
    const y = p[1] - c0[1];
    const z = p[2] - c0[2];
    const row = [2 * x, 2 * y, 2 * z, 1];
    const val = x * x + y * y + z * z;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) m[i][j] += row[i] * row[j];
      rhs[i] += row[i] * val;
    }
  }
  const sol = solveLinear(m, rhs);
  if (!sol) return null;
  const [a, b, c, d] = sol;
  const r2 = d + a * a + b * b + c * c;
  if (!(r2 > 0)) return null;
  return { center: [a + c0[0], b + c0[1], c + c0[2]], radius: Math.sqrt(r2) };
}

export interface CylinderFit {
  /** A point on the axis. */
  point: Vec3;
  /** Unit axis direction. */
  axis: Vec3;
  radius: number;
}

/**
 * Best-fit infinite cylinder.
 *
 * **The axis comes from the covariance of the region's NORMALS, not its
 * points.** Every normal of a cylinder is perpendicular to its axis, so the
 * normals span the plane perpendicular to it and their direction of least
 * variance IS the axis. Fitting the axis from the points instead would give
 * the direction of greatest extent, which is only the axis for a long thin
 * patch and is wrong for a short wide one.
 *
 * With the axis known, the points project onto the perpendicular plane and the
 * problem reduces to the 2D circle fit — the same Kasa formulation as the
 * sphere, one dimension down.
 *
 * Returns `null` when the normals do not determine an axis (a flat region's
 * normals are all parallel, so their covariance is degenerate — which is the
 * honest answer: a plane is not a cylinder of any radius).
 */
export function fitCylinder(points: readonly Vec3[], normals: readonly Vec3[]): CylinderFit | null {
  if (points.length < 6 || normals.length < 3) return null;
  const nCentre: Vec3 = [0, 0, 0];
  const eig = symmetricEigen(covariance(normals, nCentre));
  // A flat region's normals are all the same direction: two eigenvalues are
  // ~0, so the smallest eigenvector is arbitrary. Require the middle one to be
  // a real fraction of the largest before trusting the axis.
  const spread = eig.values[2];
  if (spread < 1e-20 || eig.values[1] / spread < 1e-6) return null;
  const axis = eig.vectors[0];

  // An orthonormal basis of the plane perpendicular to the axis.
  const helper: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(axis, helper));
  if (!u) return null;
  const v = cross(axis, u);

  const c0 = centroid(points);
  if (!c0) return null;
  const flat: [number, number][] = points.map((p) => {
    const d = sub(p, c0);
    return [dot(d, u), dot(d, v)];
  });

  // Kasa circle: x²+y² = 2ax + 2by + c.
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const rhs = [0, 0, 0];
  for (const [x, y] of flat) {
    const row = [2 * x, 2 * y, 1];
    const val = x * x + y * y;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) m[i][j] += row[i] * row[j];
      rhs[i] += row[i] * val;
    }
  }
  const sol = solveLinear(m, rhs);
  if (!sol) return null;
  const [a, b, c] = sol;
  const r2 = c + a * a + b * b;
  if (!(r2 > 0)) return null;

  const point: Vec3 = [
    c0[0] + u[0] * a + v[0] * b,
    c0[1] + u[1] * a + v[1] * b,
    c0[2] + u[2] * a + v[2] * b,
  ];
  return { point, axis, radius: Math.sqrt(r2) };
}

/**
 * The axial extent of `points` along `axis` measured from `point`, as
 * `[min, max]` — what turns an infinite fitted cylinder into the bounded one
 * `primitiveSdf.ts`'s `Primitive` describes.
 */
export function axialExtent(points: readonly Vec3[], point: Vec3, axis: Vec3): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    const t = dot(sub(p, point), axis);
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return [lo, hi];
}
