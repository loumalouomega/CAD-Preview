/**
 * Hidden-line removal over a triangle mesh — the engine behind a 2D technical
 * drawing (visible edges solid, occluded edges dashed).
 *
 * **Why this exists at all, given the recorded Non-goal.** Every `HLRBRep_*`
 * class is red in this OCCT WASM build, and the one green survivor,
 * `HLRAppli_ReflectLines`, was probed and rejected on the quality of its
 * drawing. Neither finding is contradicted here: this module calls no B-rep
 * HLR API whatsoever. It works on the tessellated triangles this codebase
 * already has for every source — B-rep via `tessellateByGroup`, native for
 * STL/OBJ/PLY/glTF — so the kernel blocker simply does not apply to it.
 *
 * Pure: no vscode, no OCCT, no THREE. A sibling of `silhouetteEdges.ts`, whose
 * edge adjacency and triangle normals it reuses.
 *
 * **Exact, not sampled.** Under orthographic projection both the edge's depth
 * and an occluding triangle's plane-depth are *affine* in the edge parameter
 * `t`, so their difference has at most one root, solvable in closed form. That
 * makes the visible/hidden split exact rather than quantized to a sample
 * spacing — no stepped-over thin occluder, no misplaced run boundary, and no
 * sampling-density parameter to tune. It is also faster: one clip per candidate
 * triangle instead of one grid lookup per sample.
 */

import { buildEdgeAdjacency, triangleNormals, type MeshEdge } from "./silhouetteEdges";

export type Vec3 = readonly [number, number, number];

/** Screen basis, structurally identical to `svgSilhouette.ts`'s `ViewBasis`.
 * Declared locally rather than imported so this module keeps zero imports from
 * the writer — the dependency runs writer → engine, never back. */
export interface ScreenBasis {
  right: Vec3;
  up: Vec3;
  /** Normalized view direction (model → camera): larger dot = nearer. */
  forward: Vec3;
}

export type Point2 = [number, number];
export type Segment2 = [Point2, Point2];

export interface HiddenLineMesh {
  /** Welded, indexed. */
  positions: Float32Array;
  indices: Uint32Array;
  /**
   * Per-triangle owning-face id (B-rep only).
   *
   * When present, a crease is an edge whose two triangles belong to DIFFERENT
   * faces — exact, and independent of tessellation density. Without it the
   * crease test falls back to a dihedral-angle threshold, which is all a raw
   * mesh can support. See {@link hiddenLineDrawing}'s crease discussion.
   */
  triangleFace?: Uint32Array;
}

export interface HiddenLineOptions {
  /**
   * Dihedral angle above which an edge counts as a crease, for meshes with no
   * face ids. Default {@link DEFAULT_MESH_CREASE_ANGLE_DEG}.
   */
  creaseAngleDeg?: number;
  /**
   * For a B-rep, a cross-face edge whose dihedral is below this is treated as
   * tangent-continuous (a fillet running smoothly into a plane) and is not
   * drawn — drafting convention. Must exceed the tessellation's own angular
   * deflection, or tessellation noise reads as a real angle.
   */
  tangentAngleDeg?: number;
  /** Overrides the derived depth epsilon; see {@link hiddenLineDrawing}. */
  depthEpsilon?: number;
}

export interface HiddenLineResult {
  visible: Segment2[];
  hidden: Segment2[];
  /** Feature edges considered, before the visibility split. */
  featureEdgeCount: number;
  warnings: string[];
}

/**
 * Crease default for a source with no face ids.
 *
 * 35°, chosen against real exported meshes rather than picked round: a
 * 12-segment STL cylinder has 30° facets and a 10-segment one 36°, while
 * typical exporters emit 5–15°. 35° draws a 45° chamfer and everything sharper
 * while staying clear of a coarse cylinder's facets. Notably higher than
 * `meshFacets.ts`'s 15° coplanarity tolerance, which is tuned for a different
 * question (are these the same flat face?) and would produce a wireframe here.
 */
export const DEFAULT_MESH_CREASE_ANGLE_DEG = 35;

/** Fallback tangent threshold when the caller supplies no tessellation hint. */
export const DEFAULT_TANGENT_ANGLE_DEG = 13;

/**
 * Fraction of interior manifold edges above which the crease selection is
 * assumed to have degenerated into a wireframe.
 *
 * The crease-threshold failure mode is the nastiest one here because it looks
 * plausible: too low a threshold on a curved surface draws every tessellation
 * facet, and the result is a dense but perfectly well-formed drawing. This
 * turns that from silent into a warning.
 */
const CREASE_EXPLOSION_FRACTION = 0.35;
/**
 * Interior-edge count below which the explosion check is skipped entirely.
 *
 * A cube has 18 interior edges and 12 of them are genuine 90° creases — 67%,
 * far past any sane fraction. Simple polyhedra are legitimately almost all
 * crease, so the check only means anything on a mesh large enough to be
 * expected to contain smooth regions.
 */
const CREASE_EXPLOSION_MIN_EDGES = 64;

/** Relative epsilons. See the constructor comments at each use. */
const DEPTH_EPSILON_FRACTION = 1e-6;
const DEGENERATE_FRACTION = 1e-9;
/** Runs shorter than this fraction of the drawing are dropped — see below. */
const MIN_RUN_FRACTION = 1e-6;

/**
 * Splits a mesh's feature edges into visible and occluded 2D runs.
 *
 * Returns projected 2D segments ready for `svgSilhouette.ts`'s writer, in the
 * same Y-down convention `project()` uses there.
 */
export function hiddenLineDrawing(
  mesh: HiddenLineMesh,
  basis: ScreenBasis,
  options: HiddenLineOptions = {}
): HiddenLineResult {
  const { positions, indices, triangleFace } = mesh;
  const triangleCount = Math.floor(indices.length / 3);
  const warnings: string[] = [];
  if (triangleCount === 0) return { visible: [], hidden: [], featureEdgeCount: 0, warnings };

  const projected = projectVertices(positions, basis);
  const { x, y, depth, spanXY, spanDepth } = projected;

  // Depth epsilon, relative to what actually varies. Tied to the DEPTH range
  // primarily, but floored against the projected diagonal because a flat plate
  // viewed face-on has a depth range of zero and any purely depth-derived
  // epsilon would collapse to nothing.
  const epsilon = options.depthEpsilon ?? DEPTH_EPSILON_FRACTION * Math.max(spanDepth, spanXY);
  const degenerateTol = DEGENERATE_FRACTION * Math.max(spanXY, 1);
  const minRun = MIN_RUN_FRACTION * Math.max(spanXY, 1);

  const normals = triangleNormals(positions, indices);
  const edges = buildEdgeAdjacency(indices);
  const feature = selectFeatureEdges(edges, normals, triangleFace, options, warnings);

  const grid = buildTriangleGrid(indices, x, y, triangleCount, warnings);

  const visible: Segment2[] = [];
  const hidden: Segment2[] = [];

  for (const edge of feature) {
    const ax = x[edge.a];
    const ay = y[edge.a];
    const bx = x[edge.b];
    const by = y[edge.b];
    // An edge seen exactly end-on projects to a point. Dropping it is right:
    // it can only contribute a zero-length segment, which `stroke-linecap`
    // renders as a stray dot — and on an axis view of a tessellated cylinder
    // there can be thousands.
    if (Math.hypot(bx - ax, by - ay) <= degenerateTol) continue;
    // A non-finite endpoint would emit NaN coordinates into the drawing. The
    // occluder pass already drops such triangles; an edge OF one still has to
    // be dropped here, matching `silhouetteSvg`'s own `isFinitePoint` filter.
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) continue;

    const occluded = occludedIntervals(edge, projected, normals, indices, grid, basis, epsilon);
    emitRuns(edge, projected, occluded, minRun, visible, hidden);
  }

  return { visible, hidden, featureEdgeCount: feature.length, warnings };
}

interface Projected {
  x: Float64Array;
  y: Float64Array;
  depth: Float64Array;
  spanXY: number;
  spanDepth: number;
}

/**
 * Projects every vertex once to (x, y, depth).
 *
 * **Centred on the model's own bounding box first, and that is load-bearing.**
 * `positions` is a `Float32Array` whose relative precision is 2^-24 of the
 * COORDINATE MAGNITUDE, not of the model's size. A 10 mm part placed at world
 * x = 10000 (routine in a STEP assembly) carries ~6e-4 mm of representation
 * error per coordinate — 1e-4 of the part's own extent, which swamps the real
 * depth margins and produces speckled visible/hidden noise that reads as a
 * hatching style rather than a bug. Centring costs one pass and buys three
 * orders of magnitude.
 */
function projectVertices(positions: Float32Array, basis: ScreenBasis): Projected {
  const count = Math.floor(positions.length / 3);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
    if (pz < minZ) minZ = pz;
    if (pz > maxZ) maxZ = pz;
  }
  const cx = Number.isFinite(minX) ? (minX + maxX) / 2 : 0;
  const cy = Number.isFinite(minY) ? (minY + maxY) / 2 : 0;
  const cz = Number.isFinite(minZ) ? (minZ + maxZ) / 2 : 0;

  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const depth = new Float64Array(count);
  let loX = Infinity, hiX = -Infinity, loY = Infinity, hiY = -Infinity, loD = Infinity, hiD = -Infinity;
  for (let i = 0; i < count; i++) {
    const px = positions[i * 3] - cx;
    const py = positions[i * 3 + 1] - cy;
    const pz = positions[i * 3 + 2] - cz;
    // Y is negated to match `svgSilhouette.ts`'s `project()` (SVG grows down).
    const sx = px * basis.right[0] + py * basis.right[1] + pz * basis.right[2];
    const sy = -(px * basis.up[0] + py * basis.up[1] + pz * basis.up[2]);
    const sd = px * basis.forward[0] + py * basis.forward[1] + pz * basis.forward[2];
    x[i] = sx;
    y[i] = sy;
    depth[i] = sd;
    if (Number.isFinite(sx)) {
      if (sx < loX) loX = sx;
      if (sx > hiX) hiX = sx;
    }
    if (Number.isFinite(sy)) {
      if (sy < loY) loY = sy;
      if (sy > hiY) hiY = sy;
    }
    if (Number.isFinite(sd)) {
      if (sd < loD) loD = sd;
      if (sd > hiD) hiD = sd;
    }
  }
  const spanXY = Number.isFinite(loX) ? Math.hypot(hiX - loX, hiY - loY) : 0;
  const spanDepth = Number.isFinite(loD) ? hiD - loD : 0;
  return { x, y, depth, spanXY, spanDepth };
}

/**
 * Feature edges: silhouette ∪ open boundary ∪ non-manifold ∪ crease.
 *
 * Silhouette is NOT computed here from a facing test — an edge between two
 * triangles that disagree about facing is exactly an edge whose dihedral makes
 * it a crease from this view, and the depth test decides visibility anyway. So
 * both back-facing creases and silhouette edges are emitted; a back-side crease
 * on a closed solid must come out as a *hidden* line, not vanish. Filtering to
 * front-facing here would be correct for closed solids and wrong for open
 * shells.
 */
function selectFeatureEdges(
  edges: MeshEdge[],
  normals: Float32Array,
  triangleFace: Uint32Array | undefined,
  options: HiddenLineOptions,
  warnings: string[]
): MeshEdge[] {
  const creaseCos = Math.cos((options.creaseAngleDeg ?? DEFAULT_MESH_CREASE_ANGLE_DEG) * (Math.PI / 180));
  const tangentCos = Math.cos((options.tangentAngleDeg ?? DEFAULT_TANGENT_ANGLE_DEG) * (Math.PI / 180));

  const kept: MeshEdge[] = [];
  let interiorCount = 0;
  let creaseCount = 0;

  for (const edge of edges) {
    const { triangles } = edge;
    if (triangles.length !== 2) {
      // Open boundary (1) or non-manifold (3+) — always a genuine feature, the
      // same judgement `silhouetteEdges`/`meshTopology` already make.
      kept.push(edge);
      continue;
    }
    interiorCount++;

    const cos = normalCos(normals, triangles[0], triangles[1]);
    // A non-finite cos means a degenerate (zero-area) triangle; keeping the
    // edge is the safe choice — it may well be a real boundary.
    const isCrease =
      triangleFace !== undefined
        ? triangleFace[triangles[0]] !== triangleFace[triangles[1]] && !(cos > tangentCos)
        : !(cos > creaseCos);

    if (isCrease) {
      creaseCount++;
      kept.push(edge);
    }
  }

  // The crease-threshold disaster is silent by nature: too low a threshold on a
  // curved surface draws every tessellation facet and still produces a
  // well-formed drawing. Say so rather than let it pass as detail.
  // Gated on BOTH size and the absence of face ids, because neither alone is
  // right. A cube legitimately has 12 of its 18 interior edges as creases — a
  // simple polyhedron is *supposed* to be mostly creases, so the fraction alone
  // cries wolf on the most ordinary shape there is. And a B-rep with face ids
  // cannot explode at all, since face identity is exact rather than angular.
  const explosionPossible = triangleFace === undefined && interiorCount >= CREASE_EXPLOSION_MIN_EDGES;
  if (explosionPossible && creaseCount > CREASE_EXPLOSION_FRACTION * interiorCount) {
    warnings.push(
      `${creaseCount} of ${interiorCount} interior edges were classified as creases — the drawing may be a wireframe. ` +
        `A coarse tessellation, a mesh with inconsistent triangle winding, or too low a crease angle all cause this.`
    );
  }
  return kept;
}

/** Cosine of the angle between two triangles' normals, or NaN if degenerate.
 * Exported for `meshRegionGrow.ts`, whose dihedral gate needs the identical
 * test — including the deliberate absence of `abs()` below. */
export function normalCos(normals: Float32Array, t0: number, t1: number): number {
  const ax = normals[t0 * 3], ay = normals[t0 * 3 + 1], az = normals[t0 * 3 + 2];
  const bx = normals[t1 * 3], by = normals[t1 * 3 + 1], bz = normals[t1 * 3 + 2];
  const la = Math.hypot(ax, ay, az);
  const lb = Math.hypot(bx, by, bz);
  if (la === 0 || lb === 0) return NaN;
  // Deliberately NOT abs(): a flipped-winding neighbour reads as ~180° and the
  // explosion warning above catches it. Taking the absolute value would hide a
  // real winding problem while producing a subtly wrong drawing.
  return (ax * bx + ay * by + az * bz) / (la * lb);
}

interface TriangleGrid {
  cols: number;
  rows: number;
  minX: number;
  minY: number;
  cellW: number;
  cellH: number;
  cells: number[][];
  /** Triangles spanning too many cells to bucket; consulted on every query. */
  oversized: number[];
}

/**
 * Buckets triangles by their projected bounding box into a uniform 2D grid.
 *
 * Sized for ~2 triangles per cell and aspect-aware, so a long thin drawing does
 * not get square cells. A triangle spanning several cells is inserted into
 * each, which is fine at this density — except for the pathological case of one
 * huge triangle (an unrefined flat face, extremely common in STL), which alone
 * would span the entire grid. Those go in an `oversized` list instead, which
 * bounds total insertions.
 */
function buildTriangleGrid(
  indices: Uint32Array,
  x: Float64Array,
  y: Float64Array,
  triangleCount: number,
  warnings: string[]
): TriangleGrid {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue;
    if (x[i] < minX) minX = x[i];
    if (x[i] > maxX) maxX = x[i];
    if (y[i] < minY) minY = y[i];
    if (y[i] > maxY) maxY = y[i];
  }
  const width = Number.isFinite(minX) ? maxX - minX : 0;
  const height = Number.isFinite(minY) ? maxY - minY : 0;

  let cols = 1;
  let rows = 1;
  if (width > 0 && height > 0) {
    const target = Math.max(1, triangleCount / 2);
    cols = clampInt(Math.round(Math.sqrt((target * width) / height)), 1, 512);
    rows = clampInt(Math.round(Math.sqrt((target * height) / width)), 1, 512);
  }
  const cellW = cols > 0 && width > 0 ? width / cols : 1;
  const cellH = rows > 0 && height > 0 ? height / rows : 1;
  const cells: number[][] = Array.from({ length: cols * rows }, () => []);
  const oversized: number[] = [];
  const oversizedLimit = Math.max(64, Math.floor(cols * rows * 0.005));

  let skipped = 0;
  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
    const tx0 = x[i0], tx1 = x[i1], tx2 = x[i2];
    const ty0 = y[i0], ty1 = y[i1], ty2 = y[i2];
    if (
      !Number.isFinite(tx0) || !Number.isFinite(tx1) || !Number.isFinite(tx2) ||
      !Number.isFinite(ty0) || !Number.isFinite(ty1) || !Number.isFinite(ty2)
    ) {
      // A NaN vertex on an OCCLUDER silently makes every comparison against it
      // false, so the triangle never occludes anything and lines that should be
      // hidden quietly stay visible. Drop it explicitly and say so.
      skipped++;
      continue;
    }
    const loC = cellIndex(Math.min(tx0, tx1, tx2), minX, cellW, cols);
    const hiC = cellIndex(Math.max(tx0, tx1, tx2), minX, cellW, cols);
    const loR = cellIndex(Math.min(ty0, ty1, ty2), minY, cellH, rows);
    const hiR = cellIndex(Math.max(ty0, ty1, ty2), minY, cellH, rows);
    const span = (hiC - loC + 1) * (hiR - loR + 1);
    if (span > oversizedLimit) {
      oversized.push(t);
      continue;
    }
    for (let r = loR; r <= hiR; r++) {
      for (let c = loC; c <= hiC; c++) cells[r * cols + c].push(t);
    }
  }
  if (skipped > 0) {
    warnings.push(`${skipped} triangle(s) with non-finite coordinates were excluded from the visibility test.`);
  }
  return { cols, rows, minX, minY, cellW, cellH, cells, oversized };
}

function cellIndex(v: number, min: number, size: number, count: number): number {
  if (!(size > 0)) return 0;
  return clampInt(Math.floor((v - min) / size), 0, count - 1);
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.trunc(v)));
}

/**
 * The parameter intervals of `edge` that some triangle hides, merged.
 *
 * Both the edge's depth and a triangle's plane-depth are affine in `t`, so
 * their difference has at most one root — the interval where one is in front of
 * the other is solved exactly rather than sampled.
 */
function occludedIntervals(
  edge: MeshEdge,
  projected: Projected,
  normals: Float32Array,
  indices: Uint32Array,
  grid: TriangleGrid,
  basis: ScreenBasis,
  epsilon: number
): Array<[number, number]> {
  const { x, y, depth } = projected;
  const ax = x[edge.a], ay = y[edge.a], ad = depth[edge.a];
  const bx = x[edge.b], by = y[edge.b], bd = depth[edge.b];

  const intervals: Array<[number, number]> = [];
  const adjacent = new Set(edge.triangles);

  for (const t of candidateTriangles(grid, Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by))) {
    // A triangle sharing this edge can only touch it ALONG the edge — a planar
    // triangle's interior lies strictly on one side of the line through any of
    // its own edges, so it can never strictly contain a point of it. Excluding
    // them is therefore exact rather than a fudge.
    //
    // Measured, not assumed: with a normal epsilon this is REDUNDANT, because
    // the shared-edge depth margin is exactly 0 and `0 < -epsilon` is already
    // false — removing this line changes no test until `depthEpsilon` is set to
    // 0. It is kept because it is free, it skips two triangles per edge, and it
    // is what makes the epsilon a guard against float noise rather than the
    // thing holding self-occlusion back on its own.
    if (adjacent.has(t)) continue;
    const span = clipToTriangle(t, indices, x, y, ax, ay, bx, by);
    if (!span) continue;

    const nx = normals[t * 3], ny = normals[t * 3 + 1], nz = normals[t * 3 + 2];
    const nDotF = nx * basis.forward[0] + ny * basis.forward[1] + nz * basis.forward[2];
    const nLen = Math.hypot(nx, ny, nz);
    // Edge-on triangle: its projection has no area and the depth solve below
    // divides by ~0, producing ±Infinity or NaN. Either would be interpreted as
    // a confident answer. Skip it.
    if (!(nLen > 0) || Math.abs(nDotF) < 1e-9 * nLen) continue;

    const i0 = indices[t * 3];
    const d0 = depth[i0];
    // Plane through the triangle in screen space: depth at a screen point q is
    // (c - n·q) / (n·forward), with n·q built from the screen basis.
    const c = planeConstant(t, indices, x, y, depth, nx, ny, nz, basis, d0);
    const tri = { nx, ny, nz, nDotF, c };

    const [t0, t1] = span;
    const g0 = depthMargin(tri, x, y, ax, ay, bx, by, ad, bd, t0, basis);
    const g1 = depthMargin(tri, x, y, ax, ay, bx, by, ad, bd, t1, basis);

    // margin < -epsilon means the triangle is IN FRONT of the edge there.
    const hid0 = g0 < -epsilon;
    const hid1 = g1 < -epsilon;
    if (hid0 && hid1) {
      intervals.push([t0, t1]);
    } else if (hid0 !== hid1) {
      // Affine in t, so exactly one crossing — solve it rather than bisect.
      const root = t0 + ((g0 + epsilon) / (g0 - g1)) * (t1 - t0);
      const r = Math.min(t1, Math.max(t0, root));
      intervals.push(hid0 ? [t0, r] : [r, t1]);
    }
  }
  return mergeIntervals(intervals);
}

/** The triangle's plane constant, expressed for the screen-space depth solve. */
function planeConstant(
  t: number,
  indices: Uint32Array,
  x: Float64Array,
  y: Float64Array,
  depth: Float64Array,
  nx: number,
  ny: number,
  nz: number,
  basis: ScreenBasis,
  _d0: number
): number {
  const i0 = indices[t * 3];
  // Reconstruct the vertex in the world frame the normal lives in, from its
  // own screen coordinates — exact, and avoids carrying a second copy of the
  // centred world positions.
  const p = screenToWorld(x[i0], y[i0], depth[i0], basis);
  return nx * p[0] + ny * p[1] + nz * p[2];
}

function screenToWorld(sx: number, sy: number, sd: number, basis: ScreenBasis): Vec3 {
  // `sy` is stored negated (SVG Y-down), so undo that here.
  const uy = -sy;
  return [
    sx * basis.right[0] + uy * basis.up[0] + sd * basis.forward[0],
    sx * basis.right[1] + uy * basis.up[1] + sd * basis.forward[1],
    sx * basis.right[2] + uy * basis.up[2] + sd * basis.forward[2],
  ];
}

/** edgeDepth(t) − triangleDepth(t): positive means the edge is nearer. */
function depthMargin(
  tri: { nx: number; ny: number; nz: number; nDotF: number; c: number },
  _x: Float64Array,
  _y: Float64Array,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  ad: number,
  bd: number,
  t: number,
  basis: ScreenBasis
): number {
  const sx = ax + (bx - ax) * t;
  const sy = ay + (by - ay) * t;
  const edgeDepth = ad + (bd - ad) * t;
  // The screen point at depth 0, then solve the plane for its depth.
  const q = screenToWorld(sx, sy, 0, basis);
  const triDepth = (tri.c - (tri.nx * q[0] + tri.ny * q[1] + tri.nz * q[2])) / tri.nDotF;
  return edgeDepth - triDepth;
}

/** Clips the projected edge to a triangle's projected interior, or null. */
function clipToTriangle(
  t: number,
  indices: Uint32Array,
  x: Float64Array,
  y: Float64Array,
  ax: number,
  ay: number,
  bx: number,
  by: number
): [number, number] | null {
  const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
  const px = [x[i0], x[i1], x[i2]];
  const py = [y[i0], y[i1], y[i2]];
  // Signed area fixes the winding so all three half-plane tests share a sign.
  const area = (px[1] - px[0]) * (py[2] - py[0]) - (py[1] - py[0]) * (px[2] - px[0]);
  if (!(Math.abs(area) > 0)) return null;
  const s = area > 0 ? 1 : -1;

  let lo = 0;
  let hi = 1;
  for (let e = 0; e < 3; e++) {
    const x0 = px[e], y0 = py[e];
    const x1 = px[(e + 1) % 3], y1 = py[(e + 1) % 3];
    const ex = x1 - x0, ey = y1 - y0;
    // Inside is >= 0 after the winding fix.
    const f0 = s * (ex * (ay - y0) - ey * (ax - x0));
    const f1 = s * (ex * (by - y0) - ey * (bx - x0));
    const df = f1 - f0;
    if (Math.abs(df) < 1e-300) {
      if (f0 < 0) return null; // parallel and outside
      continue;
    }
    const cross = -f0 / df;
    if (df > 0) {
      if (cross > lo) lo = cross;
    } else {
      if (cross < hi) hi = cross;
    }
    if (lo >= hi) return null;
  }
  return lo < hi ? [lo, hi] : null;
}

function* candidateTriangles(grid: TriangleGrid, minX: number, minY: number, maxX: number, maxY: number): Generator<number> {
  const loC = cellIndex(minX, grid.minX, grid.cellW, grid.cols);
  const hiC = cellIndex(maxX, grid.minX, grid.cellW, grid.cols);
  const loR = cellIndex(minY, grid.minY, grid.cellH, grid.rows);
  const hiR = cellIndex(maxY, grid.minY, grid.cellH, grid.rows);
  const seen = new Set<number>();
  for (let r = loR; r <= hiR; r++) {
    for (let c = loC; c <= hiC; c++) {
      for (const t of grid.cells[r * grid.cols + c]) {
        if (!seen.has(t)) {
          seen.add(t);
          yield t;
        }
      }
    }
  }
  for (const t of grid.oversized) {
    if (!seen.has(t)) {
      seen.add(t);
      yield t;
    }
  }
}

function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  if (intervals.length <= 1) return intervals;
  intervals.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [intervals[0]];
  for (let i = 1; i < intervals.length; i++) {
    const last = out[out.length - 1];
    if (intervals[i][0] <= last[1]) {
      if (intervals[i][1] > last[1]) last[1] = intervals[i][1];
    } else {
      out.push(intervals[i]);
    }
  }
  return out;
}

/**
 * Emits the edge's occluded intervals as hidden segments and their complement
 * as visible ones.
 *
 * **Runs shorter than `minRun` are dropped, and that is required rather than
 * tidy.** An exact root can legitimately land at `t = 1 - 1e-16`, producing a
 * segment of that length; `serialize`'s coordinate rounding then collapses it
 * to a zero-length `M x y L x y`, which renders as a stray dot under a round
 * line cap.
 */
function emitRuns(
  edge: MeshEdge,
  projected: Projected,
  occluded: Array<[number, number]>,
  minRun: number,
  visible: Segment2[],
  hidden: Segment2[]
): void {
  const { x, y } = projected;
  const ax = x[edge.a], ay = y[edge.a];
  const bx = x[edge.b], by = y[edge.b];
  const length = Math.hypot(bx - ax, by - ay);
  const at = (t: number): Point2 => [ax + (bx - ax) * t, ay + (by - ay) * t];
  const push = (list: Segment2[], t0: number, t1: number): void => {
    if ((t1 - t0) * length <= minRun) return;
    list.push([at(t0), at(t1)]);
  };

  let cursor = 0;
  for (const [t0, t1] of occluded) {
    push(visible, cursor, Math.min(t0, 1));
    push(hidden, Math.max(t0, 0), Math.min(t1, 1));
    cursor = Math.max(cursor, t1);
  }
  push(visible, cursor, 1);
}
