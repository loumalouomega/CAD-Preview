/**
 * Pure dimension-glyph math: extension-line positioning, arrowhead/witness-mark
 * computation, and numeric-value placement — no DOM, no Three.js (imported only
 * in the runtime `measurementOverlay.ts` consumer). Unit-testable headless,
 * matching the `measurement.ts`/`measurementState.ts` conventions of this
 * codebase.
 *
 * All angles are in degrees; all vectors are `[x,y,z]` tuples.  Values are
 * formatted with `toPrecision(6)` so a 10 mm edge shows as `"10"` and a
 * 0.034 mm edge shows as `"0.034"` — no fixed‑decimal formatter that would
 * quantise to one or two digits.
 *
 * The glyph layout follows the same visual conventions as mainstream CAD
 * packages: extension lines stop short of the model edge by a gap proportional
 * to the model's bbox diagonal, arrowheads are symmetric 60° / 10° spikes, and
 * the value label is centred above the measurement segment with a short
 * vertical offset.
 */
export type Vec3 = [number, number, number];

/** Gap between extension-line endpoint and the model surface, as a factor of the bbox diagonal. */
const DEFAULT_GAP_FACTOR = 0.02;

/**
 * Compute the 2D-projected positions of extension lines for a measurement,
 * given the world-space pick positions and the model's bbox diagonal (for
 * gap scaling).  The returned object can be consumed by `measurementOverlay.ts`
 * to draw sprites/lines.
 *
 * @param p0 first pick position (world space)
 * @param p1 second pick position (world space)
 * @param bboxDiagonal the model's bounding‑box diagonal, used to scale the gap
 * @returns {extensionLine0, extensionLine1, gap} — positions offset from each
 * pick, and the gap used (for possible per‑measurement overrides)
 */
export function computeExtensionLinePositions(
  p0: [number, number, number],
  p1: [number, number, number],
  bboxDiagonal: number,
): {
  extensionLine0: [number, number, number];
  extensionLine1: [number, number, number];
  gap: number;
} {
  const gap = Math.max(1e-3, bboxDiagonal * DEFAULT_GAP_FACTOR);

  // Project to 2D by discarding z (the measurement plane is XY; z offset is
  // handled by the canvas depthTest:false rendering).  The extension lines
  // simply stop short of the model edge.
  const dir = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  const safeLen = len > 0 ? len : 1;

  // Unit direction, dropping z for the 2D projection
  const ux = dir[0] / safeLen;
  const uy = dir[1] / safeLen;

  // Offset each endpoint away from the segment by the gap distance
  const ex0 = [p0[0] - ux * gap, p0[1] - uy * gap, p0[2]] as [number, number, number];
  const ex1 = [p1[0] + ux * gap, p1[1] + uy * gap, p1[2]] as [number, number, number];

  return { extensionLine0: ex0, extensionLine1: ex1, gap };
}

/**
 * Compute symmetric arrowhead vertices for a measurement segment, given the
 * segment direction and a tip-to-base length.  The arrowhead is an isosceles
 * triangle with a 60° total angle at the tip; the two side edges fan out at
 * 30° from the segment direction.
 *
 * @param p0 start point
 * @param p1 end point
 * @param tipLength distance from tip to arrowhead base (along the segment)
 * @returns { p: [number, number]; cp: [number, number]; cn: [number, number] } —
 * three arrowhead vertex positions in 2D (z dropped), ordered tip‑first‑clockwise
 */
export function computeArrowheadVertices(
  p0: [number, number, number],
  p1: [number, number, number],
  tipLength: number,
): { p: [number, number]; cp: [number, number]; cn: [number, number] } {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const segLen = Math.hypot(dx, dy);
  const safeSegLen = segLen > 0 ? segLen : 1;

  // Tip position (slightly inward from p1 so the arrow doesn't overshoot)
  const tipX = p1[0] - (dx / safeSegLen) * tipLength;
  const tipY = p1[1] - (dy / safeSegLen) * tipLength;

  // Perpendicular direction (rotated 90° CCW)
  const px = -dy / safeSegLen;
  const py = dx / safeSegLen;

  // Arrowhead half-angle is 30° (total 60°)
  const ha = (Math.PI / 180) * 30;
  const cosHa = Math.cos(ha);
  const sinHa = Math.sin(ha);

  // Base vertices: from tip, go sideways ±30° at tipLength distance
  const cpX = tipX + px * tipLength * cosHa - py * tipLength * sinHa;
  const cpY = tipY + py * tipLength * cosHa + px * tipLength * sinHa;
  const cnX = tipX + px * tipLength * cosHa + py * tipLength * sinHa;
  const cnY = tipY + py * tipLength * cosHa - px * tipLength * sinHa;

  return { p: [tipX, tipY], cp: [cpX, cpY], cn: [cnX, cnY] };
}

/**
 * Compute a witness‑mark gap for an angular measurement: a short perpendicular
 * line at each pick point that the value label can "rest" on, keeping the
 * label from overlapping the measurement segment.
 *
 * @param p0 first pick position
 * @param p1 second pick position
 * @param gap factor of the model bbox diagonal (same scale as extension lines)
 * @returns witness0, witness1 — 2D offset positions from each pick (as [x,y,z] tuples for compatibility)
 */
export function computeWitnessMarks(
  p0: [number, number, number],
  p1: [number, number, number],
  gap: number,
): { witness0: [number, number, number]; witness1: [number, number, number] } {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const segLen = Math.hypot(dx, dy);
  const safeSegLen = segLen > 0 ? segLen : 1;

  // Unit direction (2D, dropping z)
  const ux = dx / safeSegLen;
  const uy = dy / safeSegLen;

  // Perpendicular unit (90° CCW)
  const px = -uy;
  const py = ux;

  // Offset each pick point perpendicular to the segment by the gap distance
  const witness0 = [p0[0] + px * gap, p0[1] + py * gap, p0[2]] as [number, number, number];
  const witness1 = [p1[0] - px * gap, p1[1] - py * gap, p1[2]] as [number, number, number];

  return { witness0, witness1 };
}

/**
 * Format a numeric value for display in a measurement label, using enough
 * significant digits to stay readable across scales (1e-4 → "0.0001", 10 → "10",
 * 1000 → "1000") without a fixed‑decimal formatter that would quantise
 * inconveniently.
 *
 * @param value the numeric value (may be negative)
 * @returns a plain string suitable for `CanvasTexture.fillText`
 */
export function formatMeasureValue(value: number): string {
  // `toPrecision(6)` gives 6 significant figures; for values < 1e-4 it may
  // produce exponential notation which we want to avoid for a label, so cap
  // the magnitude and fall back to a fixed‑precision string.
  if (isNaN(value) || !isFinite(value)) return "-";
  if (Math.abs(value) < 1e-4) return value.toFixed(4);
  if (Math.abs(value) >= 1e6) return value.toExponential(3);
  return value.toPrecision(6);
}

/**
 * Position a numeric label above a measurement segment, given the segment
 * endpoints and the previously computed extension‑line/gap geometry.  The
 * returned 2D position (x, y, z dropped) can be used as the canvas text
 * baseline for `makeMeasureLabelSprite`.
 *
 * @param p0 first pick position (world space)
 * @param p1 second pick position (world space)
 * @param bboxDiagonal model bbox diagonal, used for gap scaling
 * @returns {labelPos: [number, number]} — 2D position for the label baseline,
 * and {gap, arrowHead} for the overlay consumer
 */
export function computeLabelPosition(
  p0: Vec3,
  p1: Vec3,
  bboxDiagonal: number,
): {
  labelPos: [number, number];
  gap: number;
} {
  const { extensionLine0, extensionLine1, gap } = computeExtensionLinePositions(
    p0,
    p1,
    bboxDiagonal,
  );

  // Midpoint between the two extension-line endpoints, elevated slightly above
  // the segment so the label doesn't sit on the model surface
  const midX = (extensionLine0[0] + extensionLine1[0]) / 2;
  const midY = (extensionLine0[1] + extensionLine1[1]) / 2;
  const labelPos = [midX, midY + gap * 0.5]; // small vertical offset
  return { labelPos: labelPos as [number, number], gap };
}