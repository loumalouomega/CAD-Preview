import * as THREE from "three";

export type ClipAxis = "x" | "y" | "z";

/**
 * The persisted clip-plane state (a field of `ViewState`, so it round-trips
 * through `<model>.view.json`).
 *
 * **`axis` is always present, even when `normal` is set, and that is a
 * deliberate forward-compatibility choice rather than redundancy.** A
 * `.view.json` written by this build may be read by an OLDER installed build
 * (the extension auto-updates, and users have several machines). Had this been
 * a discriminated union — `{axis, offsetFrac} | {normal, offsetFrac}` — an old
 * build would fail its `typeof c.axis === "string"` check and silently degrade
 * the WHOLE clip to `null`, i.e. clipping would just switch itself off. With
 * `axis` always written, an old build ignores the unknown `normal` and restores
 * a sensible neighbouring clip along the custom normal's dominant axis.
 *
 * `axis` also does real work in this build: it is "which preset button is lit",
 * which would otherwise have to be recovered by fuzzy-comparing a float normal
 * against three unit vectors on every restore.
 */
export interface ClipPlaneState {
  /** Axis preset. Always present; see the note above. */
  axis: ClipAxis;
  /**
   * Position of the cut as a fraction of `box`'s extent **along the active
   * normal**: `-1` = the box's min-side support plane, `0` = through its
   * centre, `1` = the max side. Clamped to `[-1, 1]`.
   *
   * A fraction rather than a world coordinate so it stays meaningful when the
   * model's extents change (an edit, or reopening a resized model).
   */
  offsetFrac: number;
  /**
   * Optional explicit unit normal. When present it **wins over `axis`**; when
   * absent the plane is the `axis` preset, exactly as before this field existed.
   */
  normal?: [number, number, number];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Builds a world-space clipping plane perpendicular to `axis`, positioned at
 * a fractional offset across `box`'s extent along that axis: `-1` is the
 * box's min face, `0` its centre, `1` its max face (clamped to `[-1, 1]`).
 *
 * The plane's normal points in the POSITIVE `axis` direction. Three.js
 * clipping keeps geometry on the side the normal faces
 * (`plane.distanceToPoint(point) >= 0`) and clips away the opposite side —
 * so sweeping `offsetFrac` from `-1` toward `1` moves the cut plane from the
 * box's min face toward its max face, progressively clipping away more of
 * the model from the max-axis end (a `0` offset shows exactly the model's
 * negative-axis half).
 */
export function planeForAxis(axis: ClipAxis, offsetFrac: number, box: THREE.Box3): THREE.Plane {
  return planeForNormal(axisNormal(axis), offsetFrac, box);
}

/** The unit vector for an axis preset. */
function axisNormal(axis: ClipAxis): THREE.Vector3 {
  return new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
}

/**
 * How far `box` extends either side of its own centre along `normal` — the
 * AABB's support function, i.e. the half-width of the box's shadow when
 * projected onto the normal.
 *
 * `|h·n|` summed per component, because each half-extent contributes to the
 * projected width regardless of the sign of that component of the normal.
 */
function halfExtentAlong(normal: THREE.Vector3, box: THREE.Box3): number {
  const h = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  return Math.abs(h.x * normal.x) + Math.abs(h.y * normal.y) + Math.abs(h.z * normal.z);
}

/**
 * The general form of {@link planeForAxis}: a clipping plane with an arbitrary
 * `normal`, positioned at `offsetFrac` across `box`'s extent **along that
 * normal**. Same sweep semantics as the axis form — `-1` is the box's min-side
 * support plane, `0` passes through its centre, `1` the max side.
 *
 * **For a unit axis normal this reduces bit-for-bit to what `planeForAxis`
 * computed before it became a wrapper**, which is what lets the webview test
 * harness assert that an explicit `[1,0,0]` renders *pixel-identically* to the
 * `"x"` preset rather than merely closely. With `n = (1,0,0)`, `centre · n`
 * reduces to `c.x` and the half-extent sum to `h.x`, and `Box3.getCenter` /
 * `getSize` compute those as `(min+max)*0.5` / `(max-min)*0.5` — the same IEEE
 * operations as the original `(min+max)/2` / `(max-min)/2` (both `/2` and
 * `*0.5` are exact).
 *
 * Normalizes defensively: `THREE.Plane`'s constructor does NOT normalize, and
 * `clipCap.ts`'s `repositionClipCap` orients the cap quad with
 * `Quaternion.setFromUnitVectors`, which assumes a unit vector. A degenerate
 * (zero-length) normal falls back to +X rather than producing a NaN plane.
 */
export function planeForNormal(normal: THREE.Vector3, offsetFrac: number, box: THREE.Box3): THREE.Plane {
  const n = normal.clone();
  if (n.lengthSq() < 1e-20) n.set(1, 0, 0);
  else n.normalize();
  const t = clamp(offsetFrac, -1, 1);
  const mid = box.getCenter(new THREE.Vector3()).dot(n);
  const value = mid + t * halfExtentAlong(n, box);
  return new THREE.Plane(n, -value);
}

/**
 * The single entry point both the clip UI and view-state restore use, so the
 * "explicit normal wins over the axis preset" rule lives in exactly one place.
 */
export function planeForClip(state: ClipPlaneState, box: THREE.Box3): THREE.Plane {
  const normal = state.normal ? new THREE.Vector3(...state.normal) : axisNormal(state.axis);
  return planeForNormal(normal, state.offsetFrac, box);
}

/**
 * The inverse of {@link planeForNormal}'s offset math: where `point` falls on
 * the `[-1, 1]` sweep along `normal`. Clamped, and `0` for a box with no
 * extent along the normal (a flat model viewed edge-on) rather than dividing
 * by zero.
 */
export function offsetFracForPoint(normal: THREE.Vector3, point: THREE.Vector3, box: THREE.Box3): number {
  const n = normal.clone().normalize();
  const half = halfExtentAlong(n, box);
  if (half < 1e-12) return 0;
  const mid = box.getCenter(new THREE.Vector3()).dot(n);
  return clamp((point.dot(n) - mid) / half, -1, 1);
}

/**
 * Orients `normal` so the plane through `point` keeps the LARGER part of `box`,
 * returning the (possibly flipped) normal and the matching `offsetFrac`.
 *
 * **This exists to stop a derived plane from making the whole model vanish.** A
 * B-rep face's outward normal points *away* from the solid, so clipping at that
 * face with that normal keeps the empty outside half. Flipping to "inward"
 * instead would mean trusting OCCT's `TopAbs_REVERSED` orientation convention
 * (not verified anywhere in this codebase), and is meaningless for a plane
 * derived from three picked points, where the normal's sign is a function of
 * the arbitrary order the user happened to click them.
 *
 * So the rule is purely geometric: compute `t` for `+n`, and if it is positive,
 * negate both. Since `t(-n) = -t(n)` this always lands `t <= 0`, i.e. the plane
 * always keeps at least half the bounding box.
 *
 * The resulting behaviour reads correctly at both ends of the range: a face on
 * the box's extreme (a top or side face — the common case) gives exactly `-1`,
 * so the slider sits at its left end with nothing cut yet and dragging right
 * sweeps the cut inward *from that face*; an interior face (a pocket floor, a
 * rib) lands mid-range and cuts immediately.
 *
 * **A plane through the box's own centre is a genuine tie** — both orientations
 * keep exactly half, so the bulk rule has nothing to decide on, and the sign
 * would otherwise fall out of whichever order the user clicked three points in.
 * Caught by a click-order-independence test rather than reasoned about up
 * front. Broken canonically (first significant component positive) so the same
 * three points always produce the same cut, however they were picked.
 */
export function orientTowardBulk(
  normal: THREE.Vector3,
  point: THREE.Vector3,
  box: THREE.Box3
): { normal: THREE.Vector3; offsetFrac: number } {
  const n = normal.clone().normalize();
  const t = offsetFracForPoint(n, point, box);
  if (Math.abs(t) < 1e-9) return { normal: canonicalSign(n), offsetFrac: t };
  return t > 0 ? { normal: n.negate(), offsetFrac: -t } : { normal: n, offsetFrac: t };
}

/**
 * Negates `n` if needed so its first significant component is positive — an
 * arbitrary but stable choice, used only to break the exact tie in
 * {@link orientTowardBulk}.
 */
function canonicalSign(n: THREE.Vector3): THREE.Vector3 {
  for (const c of ["x", "y", "z"] as const) {
    if (Math.abs(n[c]) > 1e-9) return n[c] < 0 ? n.negate() : n;
  }
  return n;
}

/**
 * The plane through three points, or `null` if they are collinear (including
 * any two being coincident).
 *
 * **Collinearity is rejected before constructing anything, because three.js
 * fails silently here**: `Plane.setFromCoplanarPoints` on collinear input
 * yields a ZERO normal, not a NaN one, since `Vector3.normalize()` divides by
 * `length() || 1`. The result is a plausible-looking `Plane` that clips
 * nothing.
 *
 * The test is on the *normalized* edge vectors, so the threshold is a pure
 * angle (roughly 0.06°) and behaves identically on a 2 mm bracket and a 40 m
 * assembly — an absolute cross-product magnitude would scale with the model.
 */
export function planeFromThreePoints(
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3
): { normal: THREE.Vector3; point: THREE.Vector3 } | null {
  const u = b.clone().sub(a);
  const v = c.clone().sub(a);
  if (u.lengthSq() < 1e-20 || v.lengthSq() < 1e-20) return null;
  const cross = u.normalize().cross(v.normalize());
  if (cross.length() < 1e-3) return null;
  return { normal: cross.normalize(), point: a.clone() };
}

/**
 * The axis a custom normal points most nearly along — written beside `normal`
 * as `ClipPlaneState.axis` so an older build reading the sidecar restores a
 * sensible neighbouring clip rather than none. See {@link ClipPlaneState}.
 */
export function dominantAxis(normal: THREE.Vector3): ClipAxis {
  const x = Math.abs(normal.x);
  const y = Math.abs(normal.y);
  const z = Math.abs(normal.z);
  if (x >= y && x >= z) return "x";
  return y >= z ? "y" : "z";
}

/**
 * Where to centre a solid "cap" over `plane`'s cross-section through `box`,
 * and how large to make it — for the stencil-buffer clip-cap technique (see
 * `clipCap.ts`). Projects `box`'s own centre onto the plane, NOT the plane's
 * closest point to the world origin: a model far from the origin would put
 * that point (and therefore the cap) nowhere near the model. Sized to the
 * box's full 3D diagonal, which safely covers any 2D cross-section through
 * it regardless of where along the plane's own axes that cross-section sits.
 */
export function capCenterAndSize(plane: THREE.Plane, box: THREE.Box3): { center: THREE.Vector3; size: number } {
  const boxCenter = box.getCenter(new THREE.Vector3());
  const center = boxCenter.clone().addScaledVector(plane.normal, -plane.distanceToPoint(boxCenter));
  const size = box.getSize(new THREE.Vector3()).length();
  return { center, size };
}
