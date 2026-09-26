/**
 * A pure invariant on a meshio++ boundary extraction, and the failure it
 * exists to prevent.
 *
 * **The defect this catches.** `convertToStlBoundary` falls back to
 * `extractSurface(readMesh(...))` when the native `convertSurface` converter
 * refuses a deck. That extraction is trusted unconditionally — nothing
 * compares the surface it produced against the mesh it came from. On
 * meshio++ 16.21.0, the foreign EnSight fixture in `examples/EnSight/` is read
 * correctly (9 points, 4 cells, extent 2x1x1) and then extracted to **4 points
 * at a unit box**: the 2-unit x extent is silently discarded. End to end the
 * file opens and displays a unit cube, with no warning, and the compatibility
 * corpus passes — its `remesh` check only fails when `elementCount` is 0.
 *
 * **Why an extent check is the right invariant.** A boundary surface is built
 * from the mesh's OWN points; extraction selects a subset of cells and
 * linearizes them, it never moves or invents a vertex. Mid-edge nodes of a
 * quadratic cell lie on the edge between two corners, so linearizing them
 * cannot push the extent outward either. Consequently the boundary's bounding
 * box must **equal** the source mesh's on every axis — and a vertex achieving
 * a min or max on some axis necessarily lies on the convex hull, hence on the
 * surface, so nothing is legitimately dropped.
 *
 * Measured across every committed meshio fixture, a correct extraction gives a
 * span ratio of exactly 1.000 on all three axes (`MED/single-hex.med`,
 * `MED/two-material-tets.med`, `MED/two-region-hexes.med`,
 * `MED/vector-field-tets.med`, `MDPA/gapped-ids.mdpa`, `GiD/two-tets.post.msh`).
 * The one failure, `EnSight/simple.case`, is 0.500. So the tolerance below is
 * set by that measurement rather than guessed.
 *
 * Counts cannot express this: a collapsed extraction still returns
 * well-formed, correctly-shaped, non-empty cells. Only the extent shows it.
 */

/** Relative slack allowed on each axis. Every correct extraction measured is
 *  exactly 1.000, so this only absorbs float noise from linearization — it is
 *  deliberately far tighter than the 0.5 a real collapse shows. */
export const BOUNDARY_EXTENT_TOLERANCE = 1e-6;

/** Below this, an axis is treated as degenerate (flat in that direction) and
 *  skipped: a zero source span makes the ratio 0/0 and says nothing. */
const DEGENERATE_SPAN = 1e-12;

export interface Extent {
  min: [number, number, number];
  max: [number, number, number];
}

/** Axis-aligned bounds over a flat row-major coordinate array. */
export function extentOf(points: ArrayLike<number>, dim: number): Extent | null {
  if (!points || dim !== 3 || points.length < 3) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < points.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = points[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}

export interface ExtentMismatch {
  axis: 0 | 1 | 2;
  sourceSpan: number;
  boundarySpan: number;
  ratio: number;
}

/**
 * Every axis on which `boundary` is meaningfully SMALLER than `source`.
 *
 * Asymmetric on purpose. A boundary cannot legitimately exceed its source, so
 * only the "too small" direction is a correctness failure worth refusing the
 * import over; an over-large extent is not something this check claims to
 * diagnose. Degenerate source axes are skipped rather than reported.
 */
export function boundaryExtentMismatches(
  source: Extent,
  boundary: Extent,
  tolerance = BOUNDARY_EXTENT_TOLERANCE
): ExtentMismatch[] {
  const out: ExtentMismatch[] = [];
  for (let a = 0; a < 3; a++) {
    const axis = a as 0 | 1 | 2;
    const sourceSpan = source.max[a] - source.min[a];
    if (!(sourceSpan > DEGENERATE_SPAN)) continue;
    const boundarySpan = boundary.max[a] - boundary.min[a];
    const ratio = boundarySpan / sourceSpan;
    if (ratio < 1 - tolerance) out.push({ axis, sourceSpan, boundarySpan, ratio });
  }
  return out;
}

const AXIS = ["x", "y", "z"];

/**
 * A refusal message naming the format, the axis, and both spans — the three
 * things needed to tell a real defect from a legitimately thin model.
 */
export function describeExtentMismatch(
  meshioFormat: string,
  mismatches: readonly ExtentMismatch[]
): string {
  const parts = mismatches.map(
    (m) => `${AXIS[m.axis]}: boundary spans ${m.boundarySpan} but the source spans ${m.sourceSpan} (ratio ${m.ratio.toFixed(3)})`
  );
  return (
    `meshio import error: the ${meshioFormat} boundary surface lost part of the geometry — ` +
    `${parts.join("; ")}. The file's nodes were read but the surface extracted from them does not ` +
    `cover them, so the model would display incorrectly. This is a defect in the ${meshioFormat} ` +
    `reader or its surface extraction, not in the file.`
  );
}
