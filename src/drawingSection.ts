/**
 * Section geometry for drawing sheets — pure, vscode/OCCT/THREE-free.
 *
 * A section is the intersection of the source triangle mesh with a plane. The
 * sheet needs three things from that cut, and this module computes all three
 * from the SAME triangles the view already draws:
 *
 * 1. the retained half-space (`clipTrianglesToPlane`), so the section view is a
 *    real view of the model behind the cut, not a separate silhouette;
 * 2. the cut boundary (`buildCutLoops`), the line where triangles cross the
 *    plane, chained into closed loops; and
 * 3. 45° hatching inside those loops (`hatchLoops`).
 *
 * Everything is in the source's own millimetres. The sheet layout scales these
 * rows with the view exactly like its visible/hidden runs, and the hatch
 * spacing is applied in SHEET millimetres by `drawingSheet.ts` after the scale
 * is known — a hatch that grew with the model would stop looking like a
 * drafting hatch on a large part.
 */

import type { Vec3 } from "./svgSilhouette";

export type Pt2 = [number, number];
export type Segment2 = [Pt2, Pt2];

export interface SectionPlane {
  /** A point on the cutting plane. */
  origin: Vec3;
  /** Plane normal. Normalized internally. */
  normal: Vec3;
  /**
   * Keep the positive-normal side and look from -normal instead of the
   * default (keep the negative side, look from +normal).
   */
  flip?: boolean;
}

/** One caller-named section, before the host resolves its view direction. */
export interface SectionSpec extends SectionPlane {
  /** Stable id used in SVG ids, DXF text and the report. */
  id: string;
  /** Drawn label, e.g. `A—A`; defaults to `id`. */
  label?: string;
  /**
   * Parent view: the existing sheet view the cutting-plane mark is drawn in.
   * The section itself is drawn looking along the plane normal (face-on to
   * the cut) — `flip` chooses which side is kept and viewed — not in the
   * parent's direction.
   */
  view: string;
}

export interface ClippedSectionMesh {
  /** Welded positions, including intersection vertices. */
  positions: Float32Array;
  indices: Uint32Array;
  /** Per-triangle source face id, carried through clipping. */
  triangleFace?: Uint32Array;
  /** Cut segments in 3D (the triangle/plane intersection). */
  cutSegments: Array<[Vec3, Vec3]>;
  /** True when the plane crossed at least one triangle. */
  crossed: boolean;
}

export interface CutLoopChain {
  points: Vec3[];
  closed: boolean;
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 0];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function keyFor(p: Vec3, scale: number): string {
  const f = (n: number): string => String(Math.round(n * scale));
  return `${f(p[0])},${f(p[1])},${f(p[2])}`;
}

/**
 * Clips a triangle mesh to one side of a plane and returns the cut segments.
 *
 * **Why not split every triangle with a generic polygon clipper and be done?**
 * The retained half-space must remain a welded indexed mesh: the hidden-line
 * engine's edge adjacency is what makes crease selection and occlusion work.
 * New intersection vertices are therefore deduplicated by position (the same
 * shared edge produces the same point in both adjacent triangles), and each
 * clipped triangle keeps its source face id. A plane that misses the mesh
 * returns the original triangles untouched with `crossed: false`; callers
 * refuse that section by name rather than drawing an unexplained empty view.
 */
export function clipTrianglesToPlane(
  positions: Float32Array,
  indices: Uint32Array,
  triangleFace: Uint32Array | undefined,
  plane: SectionPlane
): ClippedSectionMesh {
  const n = normalize(plane.normal);
  if (n.every((v) => v === 0)) throw new Error("A section plane needs a non-zero normal.");
  const sign = plane.flip ? 1 : -1;
  const signed = (p: Vec3): number => sign * dot([p[0] - plane.origin[0], p[1] - plane.origin[1], p[2] - plane.origin[2]], n);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
    minZ = Math.min(minZ, positions[i + 2]); maxZ = Math.max(maxZ, positions[i + 2]);
  }
  const diag = Number.isFinite(minX) ? Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) : 0;
  const eps = Math.max(1e-9, diag * 1e-9);
  const weldScale = 1 / Math.max(1e-9, diag * 1e-7);
  const sourceVertex = (i: number): Vec3 => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];

  const out: number[] = [];
  const outIndices: number[] = [];
  const outFace: number[] = [];
  const vertexIndex = new Map<string, number>();
  const addVertex = (p: Vec3): number => {
    const key = keyFor(p, weldScale);
    const existing = vertexIndex.get(key);
    if (existing !== undefined) return existing;
    const idx = out.length / 3;
    out.push(p[0], p[1], p[2]);
    vertexIndex.set(key, idx);
    return idx;
  };

  const cutSegments: Array<[Vec3, Vec3]> = [];
  const cutSeen = new Set<string>();
  const triangleCount = Math.floor(indices.length / 3);
  let crossed = false;

  for (let t = 0; t < triangleCount; t++) {
    const ids = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
    const ps = ids.map(sourceVertex);
    const ds = ps.map(signed);
    // Whole triangle on the kept side (including coplanar): retain it as-is.
    if (ds.every((d) => d >= -eps)) {
      outIndices.push(addVertex(ps[0]), addVertex(ps[1]), addVertex(ps[2]));
      if (triangleFace) outFace.push(triangleFace[t] ?? 0);
      continue;
    }
    // Whole triangle on the dropped side.
    if (ds.every((d) => d <= eps)) continue;

    // Sutherland–Hodgman against the kept half-space. Intersections along a
    // shared edge are the same 3D point in both adjacent triangles, and
    // `addVertex`'s spatial key welds them.
    const poly: Vec3[] = [];
    let crossings = 0;
    for (let i = 0; i < 3; i++) {
      const a = ps[i], b = ps[(i + 1) % 3];
      const da = ds[i], db = ds[(i + 1) % 3];
      if (da >= -eps) poly.push(a);
      if ((da > eps && db < -eps) || (da < -eps && db > eps)) {
        const tt = da / (da - db);
        const p = lerp(a, b, tt);
        poly.push(p);
        crossings++;
      }
    }
    if (crossings > 0) crossed = true;
    if (poly.length < 3) continue;
    // Intersections for the cut line are the crossing points only, not every
    // polygon vertex that happens to lie on the plane.
    const intersections: Vec3[] = [];
    for (let i = 0; i < 3; i++) {
      const a = ps[i], b = ps[(i + 1) % 3];
      const da = ds[i], db = ds[(i + 1) % 3];
      if ((da > eps && db < -eps) || (da < -eps && db > eps)) {
        intersections.push(lerp(a, b, da / (da - db)));
      }
    }
    if (intersections.length === 2) {
      const [a, b] = intersections;
      const ka = keyFor(a, weldScale), kb = keyFor(b, weldScale);
      const sk = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      if (ka !== kb && !cutSeen.has(sk)) {
        cutSeen.add(sk);
        cutSegments.push([a, b]);
      }
    }
    const face = triangleFace?.[t] ?? 0;
    for (let i = 1; i + 1 < poly.length; i++) {
      outIndices.push(addVertex(poly[0]), addVertex(poly[i]), addVertex(poly[i + 1]));
      if (triangleFace) outFace.push(face);
    }
  }

  return {
    positions: new Float32Array(out),
    indices: new Uint32Array(outIndices),
    ...(triangleFace ? { triangleFace: new Uint32Array(outFace) } : {}),
    cutSegments,
    crossed,
  };
}

/**
 * Chains cut segments into loops. Endpoints are welded first (the same
 * relative tolerance the clipper uses), because adjacent triangles compute
 * their shared intersection from opposite edge directions and can differ in
 * the last few bits.
 *
 * Closed loops are what hatching needs; open chains are still returned so a
 * section through an open shell draws its boundary instead of pretending the
 * cut failed.
 */
export function buildCutLoops(segments: ReadonlyArray<readonly [Vec3, Vec3]>, tolerance: number): CutLoopChain[] {
  if (segments.length === 0) return [];
  const scale = 1 / Math.max(1e-9, tolerance);
  type Edge = { a: string; b: string; pa: Vec3; pb: Vec3; used: boolean };
  const edges: Edge[] = [];
  const byPoint = new Map<string, number[]>();
  const add = (key: string, index: number): void => {
    const arr = byPoint.get(key);
    if (arr) arr.push(index);
    else byPoint.set(key, [index]);
  };
  for (const [a, b] of segments) {
    const ka = keyFor(a, scale), kb = keyFor(b, scale);
    if (ka === kb) continue;
    const idx = edges.length;
    edges.push({ a: ka, b: kb, pa: a, pb: b, used: false });
    add(ka, idx);
    add(kb, idx);
  }
  const chains: CutLoopChain[] = [];
  for (let start = 0; start < edges.length; start++) {
    if (edges[start].used) continue;
    const first = edges[start];
    first.used = true;
    const points: Vec3[] = [first.pa, first.pb];
    let tailKey = first.b;
    let closed = tailKey === first.a;
    // Extend at the tail. A cut through a manifold surface has degree two at
    // every interior point, so this greedy walk is unambiguous in practice.
    for (let guard = 0; guard < edges.length + 1 && !closed; guard++) {
      const next = (byPoint.get(tailKey) ?? []).find((i) => !edges[i].used);
      if (next === undefined) break;
      const e = edges[next];
      e.used = true;
      if (e.a === tailKey) {
        points.push(e.pb);
        tailKey = e.b;
      } else {
        points.push(e.pa);
        tailKey = e.a;
      }
      closed = tailKey === first.a;
    }
    if (closed && points.length > 3) points.pop(); // the repeated start is implicit
    chains.push({ points, closed });
  }
  return chains;
}

/** Shoelace area of a closed 2D loop (absolute). */
export function loopArea(loop: ReadonlyArray<Pt2>): number {
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) / 2;
}

export interface HatchOptions {
  /** Hatch line angle in the SHEET's Y-down frame. */
  angleDeg?: number;
  /** Distance between hatch lines in SHEET millimetres. */
  spacing?: number;
  /** Safety cap; a degenerate loop must not emit millions of lines. */
  maxLines?: number;
}

/**
 * Hatching clipped to one or more closed loops.
 *
 * The loops are treated as one even-odd region (outer boundary plus holes):
 * a hatch line's intersections with every loop are sorted together and paired,
 * so a pocket cut out of a wall leaves an unhatched island. No clipping path
 * or CAD HATCH entity is needed in either writer — every emitted segment is
 * already inside the material.
 */
export function hatchLoops(loops: ReadonlyArray<ReadonlyArray<Pt2>>, options: HatchOptions = {}): Segment2[] {
  const valid = loops.filter((l) => l.length >= 3);
  if (valid.length === 0) return [];
  const angle = ((options.angleDeg ?? 45) * Math.PI) / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const spacing = options.spacing ?? 1.5;
  if (!(spacing > 0)) return [];
  const maxLines = options.maxLines ?? 4000;

  let minV = Infinity, maxV = -Infinity;
  for (const loop of valid) {
    for (const [x, y] of loop) {
      const v = -x * sin + y * cos;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
  }
  if (!Number.isFinite(minV) || !Number.isFinite(maxV)) return [];
  const out: Segment2[] = [];
  let emitted = 0;
  // Offset by half a spacing so a symmetric part does not get a hatch line
  // exactly on its symmetry boundary.
  for (let v = minV + spacing / 2; v <= maxV && emitted < maxLines; v += spacing) {
    const us: number[] = [];
    for (const loop of valid) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        const va = -a[0] * sin + a[1] * cos;
        const vb = -b[0] * sin + b[1] * cos;
        if ((va <= v && vb > v) || (vb <= v && va > v)) {
          const t = (v - va) / (vb - va);
          const x = a[0] + (b[0] - a[0]) * t;
          const y = a[1] + (b[1] - a[1]) * t;
          us.push(x * cos + y * sin);
        }
      }
    }
    us.sort((a, b) => a - b);
    for (let i = 0; i + 1 < us.length; i += 2) {
      const u0 = us[i], u1 = us[i + 1];
      if (u1 - u0 <= 1e-9) continue;
      out.push([
        [u0 * cos - v * sin, u0 * sin + v * cos],
        [u1 * cos - v * sin, u1 * sin + v * cos],
      ]);
      emitted++;
      if (emitted >= maxLines) break;
    }
  }
  return out;
}

export interface SectionMark {
  label: string;
  segments: Segment2[];
  arrows: Segment2[];
  labelAt: Pt2;
}

/**
 * The cutting-plane line and arrowheads drawn in a PARENT view.
 *
 * The line is the section plane intersected with a plane parallel to the
 * parent's projection plane. It is extended to the parent drawing's bounds so
 * it visibly crosses the whole view; if the section plane is face-on to the
 * parent (no edge-on line exists), this returns `null` and the caller warns
 * rather than drawing a misleading mark.
 */
export function cuttingPlaneMark(
  plane: SectionPlane,
  parentBasis: { right: Vec3; up: Vec3; forward: Vec3 },
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  label: string
): SectionMark | null {
  const n = normalize(plane.normal);
  const dir = cross(n, parentBasis.forward);
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (!(len > 1e-9)) return null;
  const unit: Vec3 = [dir[0] / len, dir[1] / len, dir[2] / len];
  const project = (p: Vec3): Pt2 => [
    dot(p, parentBasis.right),
    -dot(p, parentBasis.up),
  ];
  const a = project(plane.origin);
  const b = project([plane.origin[0] + unit[0], plane.origin[1] + unit[1], plane.origin[2] + unit[2]]);
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const dl = Math.hypot(dx, dy);
  if (!(dl > 1e-9)) return null;

  // Extend the infinite line through a/b to the parent bounds, with a small
  // overrun so the arrowheads sit outside the drawn outline.
  const pad = Math.max(2, Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 0.03);
  const minX = bounds.minX - pad, maxX = bounds.maxX + pad;
  const minY = bounds.minY - pad, maxY = bounds.maxY + pad;
  const ts: number[] = [];
  const tx = (x: number): number => (x - a[0]) / (dx / dl);
  const ty = (y: number): number => (y - a[1]) / (dy / dl);
  if (Math.abs(dx) > 1e-12) {
    for (const x of [minX, maxX]) {
      const t = tx(x);
      const y = a[1] + (dy / dl) * t;
      if (t >= -1e6 && t <= 1e6 && y >= minY && y <= maxY) ts.push(t);
    }
  }
  if (Math.abs(dy) > 1e-12) {
    for (const y of [minY, maxY]) {
      const t = ty(y);
      const x = a[0] + (dx / dl) * t;
      if (t >= -1e6 && t <= 1e6 && x >= minX && x <= maxX) ts.push(t);
    }
  }
  if (ts.length < 2) return null;
  ts.sort((p, q) => p - q);
  const t0 = ts[0], t1 = ts[ts.length - 1];
  const p0: Pt2 = [a[0] + (dx / dl) * t0, a[1] + (dy / dl) * t0];
  const p1: Pt2 = [a[0] + (dx / dl) * t1, a[1] + (dy / dl) * t1];

  // Arrow direction is the section's viewing direction projected into the
  // parent view; fall back to the line normal when it is edge-on (a section
  // viewed exactly along the parent's own direction).
  const viewDir: Vec3 = plane.flip ? [-n[0], -n[1], -n[2]] : n;
  const projectedView: Pt2 = [dot(viewDir, parentBasis.right), -dot(viewDir, parentBasis.up)];
  const pv = Math.hypot(projectedView[0], projectedView[1]);
  const arrow: Pt2 = pv > 1e-9
    ? [projectedView[0] / pv, projectedView[1] / pv]
    : [-dy / dl, dx / dl];
  const arrowSize = Math.max(3, Math.min(8, Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 0.04));
  const wing = 0.45;
  const head = (tip: Pt2, dir2: Pt2): Segment2[] => {
    const back: Pt2 = [tip[0] - dir2[0] * arrowSize, tip[1] - dir2[1] * arrowSize];
    const nx = -dir2[1], ny = dir2[0];
    const w1: Pt2 = [back[0] + nx * arrowSize * wing, back[1] + ny * arrowSize * wing];
    const w2: Pt2 = [back[0] - nx * arrowSize * wing, back[1] - ny * arrowSize * wing];
    return [[tip, w1], [tip, w2]];
  };
  const arrows = [...head(p0, arrow), ...head(p1, arrow)];
  const mid: Pt2 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  const nx = -dy / dl, ny = dx / dl;
  const labelAt: Pt2 = [mid[0] + nx * (arrowSize * 1.6), mid[1] + ny * (arrowSize * 1.6)];
  return { label, segments: [[p0, p1]], arrows, labelAt };
}
