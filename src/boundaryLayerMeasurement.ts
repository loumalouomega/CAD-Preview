/**
 * Read-back measurement for `Part.meshBoundaryLayer` — the difference between
 * the analytic row count the panel promises and the rows Gmsh actually
 * produced. Pure (no Gmsh, DOM or vscode imports) so the sampling rules are
 * unit-testable; `gmshService.ts` supplies the wall polylines and the generated
 * node coordinates.
 *
 * A wall is sampled at evenly spaced stations along each of its polylines. A
 * node belongs to a station when its projection falls inside that station's
 * along-wall window and its perpendicular distance is inside the requested
 * layer stack. The achieved row count is how many of the analytic cumulative
 * row heights have a node within a fraction of the wall size; the wall's
 * minimum and median are taken over those stations, and coverage is the
 * fraction of stations with at least one layer row.
 *
 * The measurement is deliberately conservative: a plain mesh whose nodes
 * happen to sit at one analytic row height can score one row, but it cannot
 * score the full stack, and a dropped layer scores 0 on every station. It
 * never claims a row that the generated nodes do not contain.
 */

import { boundaryLayerPlan, type MeshBoundaryLayer } from "./meshOptions";

export interface BoundaryLayerWall {
  /** The owning Part's name, echoed back in the result. */
  part: string;
  layer: MeshBoundaryLayer;
  /**
   * Ordered 3-D polylines in the model's own coordinates. A Part can name
   * several edges (for example a wall split by a rebuilt profile), so the
   * measurement accepts more than one and samples each.
   */
  polylines: Array<Array<readonly [number, number, number]>>;
}

export interface BoundaryLayerAchieved {
  part: string;
  /** The analytic count from `boundaryLayerPlan`. */
  plannedRows: number;
  /** Rows found at the worst sampled station. */
  achievedMin: number;
  /** Rows found at the median sampled station. */
  achievedMedian: number;
  /** Fraction (0..1) of sampled stations with at least one layer row. */
  coverage: number;
  /** Number of stations the minimum, median and coverage are over. */
  stations: number;
}

const DEFAULT_STATIONS = 9;
const EPS = 1e-12;

/**
 * Measures every wall that has a layer. `coords` is the flattened generated
 * node coordinate array from `gmsh.model.mesh.getNodes()` (x, y, z per node).
 * Walls without a usable polyline report zero rows and zero coverage rather
 * than being silently omitted.
 */
export function measureBoundaryLayerRows(
  walls: readonly BoundaryLayerWall[],
  coords: ArrayLike<number>,
  stationsPerPolyline = DEFAULT_STATIONS
): BoundaryLayerAchieved[] {
  const nodes = finiteNodes(coords);
  return walls.map((wall) => {
    const plan = boundaryLayerPlan(wall.layer);
    const expected = cumulativeRows(wall.layer, plan.layers);
    const tolerance = Math.max(wall.layer.wallSize * 0.2, 1e-9);
    const counts: number[] = [];
    for (const polyline of wall.polylines) {
      if (polyline.length < 2) continue;
      const stations = Math.max(2, Math.floor(stationsPerPolyline));
      const length = polylineLength(polyline);
      if (!(length > EPS)) continue;
      const distances: number[][] = Array.from({ length: stations }, () => []);
      for (const node of nodes) {
        const nearest = nearestOnPolyline(node, polyline);
        if (!nearest || nearest.distance <= 1e-9 || nearest.distance > wall.layer.thickness * 1.05 + tolerance) continue;
        const station = Math.min(stations - 1, Math.max(0, Math.floor((nearest.along / length) * stations)));
        distances[station].push(nearest.distance);
      }
      for (const rowDistances of distances) counts.push(countRows(rowDistances, expected, tolerance));
    }
    if (counts.length === 0) {
      return { part: wall.part, plannedRows: plan.layers, achievedMin: 0, achievedMedian: 0, coverage: 0, stations: 0 };
    }
    const achievedMin = Math.min(...counts);
    const covered = counts.filter((n) => n > 0).length;
    return {
      part: wall.part,
      plannedRows: plan.layers,
      achievedMin,
      achievedMedian: median(counts),
      coverage: covered / counts.length,
      stations: counts.length,
    };
  });
}

/** The analytic cumulative heights at which row boundaries sit. */
export function cumulativeRows(layer: MeshBoundaryLayer, rows: number): number[] {
  const out: number[] = [];
  let height = layer.wallSize;
  let total = 0;
  for (let i = 0; i < rows; i++) {
    total += height;
    out.push(total);
    height *= layer.growthRatio;
  }
  return out;
}

interface Node3 {
  x: number;
  y: number;
  z: number;
}

function finiteNodes(coords: ArrayLike<number>): Node3[] {
  const out: Node3[] = [];
  for (let i = 0; i + 2 < coords.length; i += 3) {
    const x = coords[i];
    const y = coords[i + 1];
    const z = coords[i + 2];
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) out.push({ x, y, z });
  }
  return out;
}

function polylineLength(points: ReadonlyArray<readonly [number, number, number]>): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += segmentLength(points[i - 1], points[i]);
  return length;
}

function segmentLength(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

function nearestOnPolyline(
  node: Node3,
  points: ReadonlyArray<readonly [number, number, number]>
): { along: number; distance: number } | null {
  let best: { along: number; distance: number } | null = null;
  let cumulative = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const abz = b[2] - a[2];
    const len2 = abx * abx + aby * aby + abz * abz;
    const len = Math.sqrt(len2);
    if (!(len > EPS)) continue;
    const t = Math.max(0, Math.min(1, ((node.x - a[0]) * abx + (node.y - a[1]) * aby + (node.z - a[2]) * abz) / len2));
    const cx = a[0] + t * abx;
    const cy = a[1] + t * aby;
    const cz = a[2] + t * abz;
    const distance = Math.hypot(node.x - cx, node.y - cy, node.z - cz);
    if (!best || distance < best.distance) best = { along: cumulative + t * len, distance };
    cumulative += len;
  }
  return best;
}

function countRows(distances: readonly number[], expected: readonly number[], tolerance: number): number {
  let count = 0;
  for (const height of expected) {
    if (distances.some((d) => Math.abs(d - height) <= tolerance)) count++;
  }
  return count;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
