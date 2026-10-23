/**
 * The shared, kernel-agnostic mesh-generation options model. Pure and
 * vscode-free so it unit-tests headless and is imported by both the host
 * (GMSH) and any panel wiring. Mirrors the shape of `editOps.ts`, but unlike
 * `EditOp` this is a single flat options bag rather than a discriminated
 * union, so {@link validateMeshOptions} clamps/defaults individually invalid
 * fields rather than rejecting the whole object — the object itself is only
 * rejected outright when `raw` isn't an object at all.
 */

import type { Part } from "./protocol";

/**
 * The element *geometry* to generate. `"simplex"` is Gmsh's native
 * triangles/tetrahedra; `"subdivided"` recombines into all-quadrilateral (2D)
 * / all-hexahedral (3D) cells. `"hexDominant"` (3D only) is the RTree
 * hex-tet hybrid recombiner (`Mesh.Algorithm3D = 9` + `Mesh.Recombine3DAll =
 * 1`) — non-functional in the gmsh-wasm build this codebase used to bundle
 * (every variant probed produced pure tetrahedra or threw), but confirmed
 * working after the 0.3.0 upgrade (see the "Meshing (GMSH-JS)" section of
 * CLAUDE.md for the wasm32-stack-overflow root cause that fix addressed, and
 * "Hex-dominant FE meshing" for this option's own verification trail — a
 * mesh in this mode always contains a third gmsh element type, 140
 * ("trihedron", a tet/hex transition connector), whose node geometry cannot
 * be verified against this WASM build (`getElementProperties(140)` throws) —
 * every consumer of raw element types treats it as an unmapped type and
 * skips it gracefully, EXCEPT Kratos MDPA export, which has no geometry to
 * represent it at all and rejects a hex-dominant mesh outright with an
 * actionable error). See `doc/gmsh-integration.md`'s "Element shapes".
 */
export type MeshElementShape = "simplex" | "subdivided" | "hexDominant";

/**
 * Which volume mesher `generateMesh`/`exportMeshFormat`/`exportMdpa` use for
 * a mesh-format ("skin mesh") source. `"gmsh"` (the default) is the existing
 * `classifySurfaces`/`createGeometry`/`addSurfaceLoop`/`addVolume` path —
 * fast, but needs a watertight/manifold/well-oriented boundary. `"ftetwild"`
 * is `src/ftetwildService.ts`'s fTetWild tetrahedralizer — built specifically
 * to survive the dirty triangle soups (holes, self-intersections,
 * non-manifold edges) that make the Gmsh path throw "STL classification
 * produced no surfaces" or worse. Meaningless for a B-rep source (Gmsh
 * already has exact geometry there — nothing to be robust against) or for
 * `dimension !== 3` (fTetWild is a volume mesher only); both degrade to
 * `"gmsh"` with a warning rather than erroring — see `populateMeshedModel`'s
 * doc comment in `gmshService.ts`. `"octree"` is `src/octreeService.ts`'s
 * meshio++ octree: a conforming hex-dominant volume (hexahedra, pyramids and
 * tetrahedra) built from the tessellated skin of EITHER source kind. It has
 * no face correlation, so Parts and physical groups are not preserved, and
 * Gmsh-only options are refused by name — see `gmshService.ts`'s
 * `octreeUnsupportedOptions`.
 */
export type MeshEngine = "gmsh" | "ftetwild" | "octree" | "octreemesh";

/** Outputs of meshio++ 17.13's `octreeMesh` (`engine: "octreemesh"`). The
 * castellated output has hanging nodes and surrogate boundary faces, which no
 * downstream reader here accepts as a conforming mesh, so it is NOT offered. */
export type OctreeMeshOutput = "tet" | "hex";
export const OCTREE_MESH_OUTPUTS: readonly OctreeMeshOutput[] = ["tet", "hex"];

/** Deepest `octreeMeshLevels` offered (leaf edge = maxSize / 2^levels). */
export const OCTREE_MESH_LEVELS_LIMIT = 4;

/** Deepest `octreeMaxLevel` offered. Cell count grows roughly 4x per level on a
 * surface, so level 6 is already a very large mesh; meshio++'s own `maxCells`
 * guard ends anything past it with a plain error. */
export const OCTREE_MAX_LEVEL_LIMIT = 6;

/** Facts an octree generate reports (the type is here, not in `octreeService.ts`,
 * because the webview and the handoff manifest import it and that module
 * pulls in WASM services). Parts are never preserved by this engine. */
export interface OctreeStats {
  maxLevel: number;
  snap: boolean;
  numLeaves: number;
  numHanging: number;
  finestLevel: number;
  numSnapped: number;
  numRefused: number;
  elementMix: { hexahedra: number; pyramids: number; tetrahedra: number };
}

/** Facts an `engine: "octreemesh"` generate reports — the subset of meshio++'s
 * `OctreeMeshResult` that says how good the mesh is. Parts are never preserved. */
export interface OctreeMeshStats {
  output: OctreeMeshOutput;
  /** Resolved leaf-edge bounds, in the skin's own units (mm). */
  maxSize: number;
  minSize: number;
  numLeaves: number;
  numTetrahedra: number;
  numHexahedra: number;
  numInverted: number;
  /** Degrees; 0 for an all-hex output. */
  minDihedral: number;
  maxDihedral: number;
  minScaledJacobian: number;
  /** Two-sided distance between the output boundary and the skin. */
  hausdorffToSkin: number;
  numFeatureChains: number;
  numFeatureChainsMissed: number;
  numWarpRefused: number;
  /** meshio++'s own warnings, verbatim. */
  warnings: string[];
}

/** One-line readout of an octreemesh generate for the panel status line. */
export function octreeMeshSummary(stats: OctreeMeshStats): string {
  const cells = stats.output === "tet" ? `${stats.numTetrahedra} tet` : `${stats.numHexahedra} hex`;
  const dihedral = stats.output === "tet" ? ` · dihedral ${stats.minDihedral.toFixed(1)}°–${stats.maxDihedral.toFixed(1)}°` : "";
  const features = stats.numFeatureChains > 0 ? ` · features ${stats.numFeatureChains - stats.numFeatureChainsMissed}/${stats.numFeatureChains}` : "";
  return `Octree-mesh ${stats.output}: ${cells} · min Jacobian ${stats.minScaledJacobian.toFixed(2)}${dihedral}${features} · ${stats.numInverted} inverted · Parts not preserved`;
}

/** One-line readout of an octree generate for the panel status line. */
export function octreeSummary(stats: OctreeStats): string {
  const { hexahedra, pyramids, tetrahedra } = stats.elementMix;
  const snaps = stats.snap
    ? `snapped ${stats.numSnapped}${stats.numRefused > 0 ? `, refused ${stats.numRefused}` : ""}`
    : "snap off";
  return `Octree L${stats.maxLevel}: ${hexahedra} hex · ${pyramids} pyramid · ${tetrahedra} tet · ${snaps} · Parts not preserved`;
}

/** Post-generate optimisation pass — see `MeshOptions.optimize`. */
export type MeshOptimizeMode = "none" | "default" | "netgen" | "highOrder";

export interface MeshOptions {
  dimension: 1 | 2 | 3;
  sizeMin: number;
  sizeMax: number;
  algorithm2D: number; // Mesh.Algorithm
  algorithm3D: number; // Mesh.Algorithm3D
  elementOrder: 1 | 2;
  elementShape: MeshElementShape;
  /**
   * Post-generate mesh optimisation (probed live against
   * gmsh-wasm 0.3.0 on bull.stp — see `doc/gmsh-integration.md`): `"none"`
   * skips even the generate-time `Mesh.Optimize` flag; `"default"` is today's
   * behavior (generate-time flag only); `"netgen"` additionally runs
   * `model.mesh.optimize("Netgen")` (repeatable min/mean gain, but it refines
   * — +42% elements on the probe fixture — and it LINEARIZES a quadratic mesh
   * to tet4, warned about, never silent); `"highOrder"` runs
   * `optimize("HighOrderElastic")`, order-2 only (9 -> 4 invalid on the probe
   * fixture — an improvement, not a guarantee — and unprobed on linear
   * meshes, so a linear mesh warns and runs the default instead).
   * `"Relocate3D"` was probed and is deliberately NOT a mode: worst-element
   * minSICN came back bit-identical, i.e. a no-op on what matters.
   */
  optimize: MeshOptimizeMode;
  stlAngle: number; // classifySurfaces angle, degrees
  engine: MeshEngine;
  /** fTetWild's envelope size, as a fraction of the input's bounding-box
   * diagonal — smaller means more faithful to the input surface, and
   * slower. Only meaningful when `engine === "ftetwild"`. Gmsh's own
   * `idealEdgeLengthRel` equivalent is derived from `sizeMax` at call time
   * (see `populateMeshedModel`), not stored separately here, so the
   * existing size slider/presets keep working under either engine with no
   * new sizing UI. */
  ftetwildEpsRel: number;
  /** fTetWild: force the output boundary manifold. Only meaningful when
   * `engine === "ftetwild"`. */
  ftetwildManifoldSurface: boolean;
  /** fTetWild: coarsen the output after optimization (fewer, larger tets).
   * Only meaningful when `engine === "ftetwild"`. */
  ftetwildCoarsen: boolean;
  /** fTetWild: skip interior/exterior filtering and return the raw
   * tetrahedralization (convex-hull fill, not the part interior). Only
   * meaningful when `engine === "ftetwild"` — and almost never what a
   * meshing or repair caller wants; exposed strictly opt-in for inspection.
   * `numThreads` is deliberately NOT exposed: this repo always loads the
   * serial build, where it has no effect. */
  ftetwildDisableFiltering: boolean;
  /** Octree: deepest refinement level (1..{@link OCTREE_MAX_LEVEL_LIMIT}); the
   * root grid is split this many times near the skin. Only meaningful when
   * `engine === "octree"`. */
  octreeMaxLevel: number;
  /** Octree: move leaf nodes onto the skin (default on). Refused snaps are
   * counted and reported, never forced. Only meaningful when
   * `engine === "octree"`. */
  octreeSnap: boolean;
  /** Octree-mesh: `"tet"` = conforming graded tetrahedra fitted to the skin
   * (stuffing), `"hex"` = all-hexahedra by the octree dual. Only meaningful
   * when `engine === "octreemesh"`. */
  octreeMeshOutput: OctreeMeshOutput;
  /** Octree-mesh: largest leaf edge in mm; `0` = automatic (one eighth of the
   * skin's bounding-box diagonal). meshio++'s own default is far finer (a
   * 10 mm cube becomes 516k tets), so the engine never passes "unset". Only
   * meaningful when `engine === "octreemesh"`. */
  octreeMeshMaxSize: number;
  /** Octree-mesh: refinement levels below `maxSize` (smallest leaf edge =
   * maxSize / 2^levels), 1..{@link OCTREE_MESH_LEVELS_LIMIT}. Only meaningful
   * when `engine === "octreemesh"`. */
  octreeMeshLevels: number;
  /**
   * Conformal multi-body meshing: call
   * `gmsh.model.occ.fragment` over every imported solid before meshing, so
   * touching solids share interface nodes. Parts are resolved AFTER the
   * renumbering via the existing bbox-centre match, so physical groups survive.
   * Defaults on: single-solid output is identical with and without it (probe:
   * block.stp 381 nodes / 1282 elements either way), multi-solid goes from
   * duplicate interface nodes (44 dups on two touching boxes) to zero. Only
   * meaningful for a B-rep source with 2+ volumes; mesh sources ignore it.
   */
  conformal: boolean;
  /**
   * Periodic node matching (roadmap "Periodic meshing"; representative-volume-
   * element studies): each entry makes the `slave` Part's face mesh a copy of
   * the `master` Part's, offset by `translation` (master position − slave
   * position, native mm). Each Part must resolve to exactly one surface, B-rep
   * sources only. Probed on block.stp: every node on the slave face has a
   * partner at exactly the translation, for Delaunay, HXT and Frontal.
   */
  periodic?: PeriodicPair[];
  /**
   * View-driven sizing (roadmap "View-driven mesh sizing"): per-point target
   * sizes steering the background mesh through a list-based `SP` view +
   * `PostView` field, joined into the shared `Min` background. B-rep sources
   * only; mesh sources and the fTetWild engine ignore it with a warning.
   * Optional: absent means no view (byte-stable sidecar when unused).
   */
  sizeField?: SizeFieldSample[];
  /**
   * Advisory element budget (roadmap "Mesh size and memory budget preview"):
   * when the pre-generation estimate exceeds it the panel/tool WARNS — it
   * never blocks a generate. Optional: absent means no budget.
   */
  budgetElements?: number;
}

/** One periodic face pair, by Part name; see {@link MeshOptions.periodic}. */
export interface PeriodicPair {
  slave: string;
  master: string;
  translation: [number, number, number];
}

/** One view-driven sizing sample (roadmap "View-driven mesh sizing"): a target
 * element size at a model-space point. The mesher interpolates between samples
 * through a Gmsh list-based `SP` view + `PostView` background field, so a
 * caller can refine where `measure_mesh_deviation` reported the worst error
 * without touching Parts. Lengths are in the model's own unit (scaled by
 * {@link scaleMeshOptionsForUnit} for unit-converted exports, like every other
 * mesh length); `size` is a target edge length, not a certified bound. */
export interface SizeFieldSample {
  point: [number, number, number];
  size: number;
}

/** Maximum samples kept per generate — bounds the list-view payload
 * (`SP` carries 4 doubles per sample). Pure truncation (first N win) keeps
 * `validateMeshOptions` total: callers building a dense per-vertex field
 * should downsample first. */
export const MAX_SIZE_FIELD_SAMPLES = 20000;

/** Tolerant parse: non-objects and malformed entries are dropped, never the
 * whole list; an empty result is `undefined` (absent, byte-stable sidecar). */
export function validateSizeField(raw: unknown): SizeFieldSample[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SizeFieldSample[] = [];
  for (const e of raw) {
    if (out.length >= MAX_SIZE_FIELD_SAMPLES) break;
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const r = e as Record<string, unknown>;
    const p = r.point;
    const s = r.size;
    if (!Array.isArray(p) || p.length !== 3 || !p.every(isFiniteNumber)) continue;
    if (!isFiniteNumber(s) || s <= 0) continue;
    out.push({ point: [p[0], p[1], p[2]], size: s });
  }
  return out.length > 0 ? out : undefined;
}

/** Tolerant parse: bad entries are dropped, never the whole list. */
export function validatePeriodicPairs(raw: unknown): PeriodicPair[] {
  if (!Array.isArray(raw)) return [];
  const out: PeriodicPair[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    const t = r.translation;
    if (typeof r.slave !== "string" || !r.slave || typeof r.master !== "string" || !r.master || r.slave === r.master) continue;
    if (!Array.isArray(t) || t.length !== 3 || !t.every(isFiniteNumber)) continue;
    if (t[0] === 0 && t[1] === 0 && t[2] === 0) continue;
    out.push({ slave: r.slave, master: r.master, translation: [t[0], t[1], t[2]] });
  }
  return out;
}

/**
 * Structured (transfinite) meshing divisions for one `Part` (roadmap "Structured meshing per Part"):
 * every meshed edge of the part's entities gets exactly this many nodes, so
 * a regular region meshes as an exact mapped grid instead of unstructured
 * tets. A count, not a length — unit conversion never touches it.
 */
export interface MeshStructured {
  divisions: number; // nodes per edge (>= 2; 2 degenerates to one element per edge)
}

/**
 * Validates one raw value into a clean {@link MeshStructured}, or `undefined`
 * — all-or-nothing like {@link validateMeshGrading} (a fractional or sub-2
 * count has no sensible reading), same tolerant-parse convention: a `Part`
 * with an invalid value keeps everything except the structuring.
 */
export function validateMeshStructured(raw: unknown): MeshStructured | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const divisions = (raw as Record<string, unknown>).divisions;
  if (typeof divisions !== "number" || !Number.isInteger(divisions) || divisions < 2) return undefined;
  return { divisions };
}

/**
 * Anisotropic boundary layer hugging a `Part`'s wall curves on a **2-D** mesh
 * (roadmap "Anisotropic boundary layers"): a Gmsh `BoundaryLayer` field — rows
 * of thin elements whose height grows geometrically from `wallSize` by
 * `growthRatio` until `thickness` is spent. All three lengths are in the
 * model's own unit (see {@link scalePartsMeshSizeForUnit}); `growthRatio` is
 * dimensionless. `quads` (default on) recombines the layer rows into
 * quadrilaterals, the usual wall treatment.
 */
export interface MeshBoundaryLayer {
  wallSize: number;
  growthRatio: number;
  thickness: number;
  quads: boolean;
}

/**
 * Validates one raw value into a clean {@link MeshBoundaryLayer}, or
 * `undefined` — all-or-nothing like {@link validateMeshGrading}. A
 * `thickness` below `wallSize` would leave zero layers, and a `growthRatio`
 * below 1 would shrink them, so neither has a sensible reading.
 */
export function validateMeshBoundaryLayer(raw: unknown): MeshBoundaryLayer | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const { wallSize, growthRatio, thickness } = o;
  if (
    !isFiniteNumber(wallSize) ||
    !isFiniteNumber(growthRatio) ||
    !isFiniteNumber(thickness) ||
    wallSize <= 0 ||
    growthRatio < 1 ||
    thickness < wallSize
  ) {
    return undefined;
  }
  return { wallSize, growthRatio, thickness, quads: o.quads !== false };
}

/**
 * Why a 2-D algorithm cannot carry a boundary layer, or `null` when it can.
 * Measured on gmsh-wasm 0.3.0 and 0.4.0 (`scripts/probe/examples/gmsh-boundary-layer.ts`'s
 * algorithm matrix): Automatic (2), Delaunay (5), Frontal-Delaunay (6) and
 * Frontal-Delaunay for Quads (8) grade the wall with or without recombination, and MeshAdapt (1)
 * does without it; but MeshAdapt **with** `Mesh.RecombineAll` aborts the WASM module ("table
 * index is out of bounds"), Packing of Parallelograms (9) aborts it on every run, BAMG (7) throws,
 * and "Initial mesh only" (3) / Quasi-structured quad (11) silently ignore the layer. So the
 * generate is refused up front rather than produced without the requested layer or left to abort.
 */
export function boundaryLayerAlgorithmProblem(algorithm2D: number, recombineAll: boolean): string | null {
  if (algorithm2D === 2 || algorithm2D === 5 || algorithm2D === 6 || algorithm2D === 8) return null;
  if (algorithm2D === 1) {
    return recombineAll
      ? "MeshAdapt (1) with quadrilateral recombination aborts the mesher when a boundary layer is present — pick Frontal-Delaunay (6), Delaunay (5), Automatic (2) or Frontal-Delaunay for Quads (8)."
      : null;
  }
  return `Mesh algorithm ${algorithm2D} cannot carry a boundary layer (BAMG fails, Packing of Parallelograms aborts, and Initial-mesh / Quasi-structured ignore it) — pick Frontal-Delaunay (6), Delaunay (5), Automatic (2) or Frontal-Delaunay for Quads (8).`;
}

/**
 * The geometric-series plan of a boundary layer: how many rows fit in
 * `thickness`, the height of the last row and the thickness they actually add
 * up to. Row k (from 0) is `wallSize * growthRatio^k` high, so n rows total
 * `wallSize * (r^n - 1) / (r - 1)` (or `n * wallSize` when `r === 1`). Pure
 * and analytic — the preflight number a caller sees before meshing, and the
 * figure a generate's achieved row count is compared against.
 */
export function boundaryLayerPlan(bl: MeshBoundaryLayer): { layers: number; lastHeight: number; totalThickness: number } {
  const { wallSize: h, growthRatio: r, thickness: t } = bl;
  // The tiny epsilon keeps an exact fit (e.g. 0.05 * (1.2^3 - 1) / 0.2 = 0.182) from
  // dropping a row to floating-point noise.
  const layers =
    r === 1 ? Math.floor(t / h + 1e-9) : Math.floor(Math.log(1 + (t * (r - 1)) / h) / Math.log(r) + 1e-9);
  const total = r === 1 ? layers * h : (h * (Math.pow(r, layers) - 1)) / (r - 1);
  return { layers, lastHeight: h * Math.pow(r, Math.max(0, layers - 1)), totalThickness: total };
}

/**
 * Distance-graded sizing anchored on a `Part` (roadmap "Boundary-layer and
 * distance-threshold mesh sizing", Phase 1) — a Gmsh `Distance` + `Threshold`
 * field pair (`gmshSizingFields.ts`'s `addDistanceThresholdField`): elements
 * stay at `sizeAtWall` within `distNear` of the part's own entities, grow
 * linearly out to `sizeFar` at `distFar`, and stay at `sizeFar` beyond that.
 * All four fields are in the model's own length unit (mm for a native
 * document); see `scalePartsMeshSizeForUnit` for unit-converted exports.
 */
export interface MeshGrading {
  sizeAtWall: number;
  sizeFar: number;
  distNear: number;
  distFar: number;
}

/**
 * Validates one raw value into a clean {@link MeshGrading}, or `undefined` if
 * `raw` isn't a well-formed band — all-or-nothing (unlike {@link
 * validateMeshOptions}'s per-field clamping), since a partially-valid grading
 * band has no sensible "fall back to the default" reading the way a single
 * numeric option does. The tolerant-parse convention this codebase uses
 * elsewhere for a malformed *annotation* (a bad `tolerance` on an
 * `Annotation`, a bad `selector` on a `Part`): drop the annotation, keep the
 * entity it's attached to — so a `Part` with an invalid `meshGrading` still
 * parses, just without grading.
 */
export function validateMeshGrading(raw: unknown): MeshGrading | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const { sizeAtWall, sizeFar, distNear, distFar } = o;
  if (
    !isFiniteNumber(sizeAtWall) ||
    !isFiniteNumber(sizeFar) ||
    !isFiniteNumber(distNear) ||
    !isFiniteNumber(distFar) ||
    sizeAtWall <= 0 ||
    sizeFar < sizeAtWall ||
    distNear < 0 ||
    distFar <= distNear
  ) {
    return undefined;
  }
  return { sizeAtWall, sizeFar, distNear, distFar };
}

/**
 * Gmsh's "unbounded" sentinel for `Mesh.MeshSizeMax`. A `sizeMax` equal to
 * this means "no explicit target size yet" — the webview seeds a real,
 * bbox-derived default in its place once the model's extents are known (see
 * `syncMeshSizeSeed` in `src/webview/main.ts`), and the panel must never
 * display the raw `1e+22`.
 */
export const SIZE_MAX_SENTINEL = 1e22;

export const DEFAULT_MESH_OPTIONS: MeshOptions = {
  dimension: 3,
  sizeMin: 0,
  sizeMax: SIZE_MAX_SENTINEL,
  algorithm2D: 6 /* Frontal-Delaunay */,
  algorithm3D: 1 /* Delaunay — Gmsh's own default; see the "Meshing (GMSH-JS)" section of CLAUDE.md for why this was Frontal (4) before gmsh-wasm 0.3.0 */,
  elementOrder: 1,
  elementShape: "simplex",
  optimize: "default",
  stlAngle: 40,
  engine: "gmsh",
  ftetwildEpsRel: 1e-3, // fTetWild's own default
  ftetwildManifoldSurface: false,
  ftetwildCoarsen: false,
  ftetwildDisableFiltering: false,
  octreeMaxLevel: 4, // block.stp at level 4: 3522 cells, exactly its volume (probe)
  octreeSnap: true,
  octreeMeshOutput: "tet",
  octreeMeshMaxSize: 0,
  octreeMeshLevels: 2, // cube.stl at maxSize 2, levels 2: 44 832 tets, min dihedral 35° (probe)
  conformal: true,
};

/**
 * Maps an {@link MeshElementShape} to the Gmsh recombination/subdivision/
 * algorithm option values, given the mesh `dimension`. Shared by
 * `gmshService.ts`'s `loadGeometryAndApplyOptions` (live meshing) and
 * `meshOptionsSidecar.ts`'s `generateGeoScript` (the emitted `.geo`), so the
 * two can never drift.
 *
 * The recipe is **dimension-dependent and verified against the live gmsh-wasm
 * build** (see `doc/gmsh-integration.md`): 2D quads come out cleanest from
 * Blossom recombination (`RecombineAll`), while 3D hexes require the
 * subdivision algorithm (`SubdivisionAlgorithm = 2`) — the 3D `RecombineAll`
 * path throws "Cannot use frontal 3D algorithm with quadrangles on boundary".
 * `"hexDominant"` is 3D-only and mutually exclusive with the other two
 * fields' mechanism entirely — it sets `recombine3DAll` instead, and
 * `algorithm3DOverride` (RTree, id 9) takes priority over whatever
 * `MeshOptions.algorithm3D` the user separately selected, since RTree is a
 * requirement of this mode, not a suggestion (a 2D request or any other
 * shape leaves `algorithm3DOverride: null`, letting the caller's own
 * `algorithm3D` field apply unchanged). All fields are always returned
 * (never left implicit) because the gmsh singleton persists options across
 * `clear()`, so a prior run's values must be overwritten every time.
 */
export function gmshShapeOptions(
  shape: MeshElementShape,
  dimension: 1 | 2 | 3
): { recombineAll: number; subdivisionAlgorithm: number; recombine3DAll: number; algorithm3DOverride: number | null } {
  if (shape === "hexDominant" && dimension === 3) {
    return { recombineAll: 0, subdivisionAlgorithm: 0, recombine3DAll: 1, algorithm3DOverride: 9 };
  }
  if (shape === "subdivided") {
    if (dimension === 3) return { recombineAll: 0, subdivisionAlgorithm: 2, recombine3DAll: 0, algorithm3DOverride: null };
    if (dimension === 2) return { recombineAll: 1, subdivisionAlgorithm: 0, recombine3DAll: 0, algorithm3DOverride: null };
  }
  return { recombineAll: 0, subdivisionAlgorithm: 0, recombine3DAll: 0, algorithm3DOverride: null };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Validates one raw object into a clean {@link MeshOptions}, or `null` if
 * `raw` isn't an object at all. This is the single tolerance gate for mesh
 * options: individually invalid fields fall back to the matching
 * {@link DEFAULT_MESH_OPTIONS} field rather than rejecting the whole object,
 * so a hand-edited or partially-corrupt sidecar degrades gracefully instead
 * of blocking meshing.
 */
export function validateMeshOptions(raw: unknown): MeshOptions | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const dimension: MeshOptions["dimension"] =
    o.dimension === 1 || o.dimension === 2 || o.dimension === 3 ? o.dimension : DEFAULT_MESH_OPTIONS.dimension;

  const elementOrder: MeshOptions["elementOrder"] =
    o.elementOrder === 1 || o.elementOrder === 2 ? o.elementOrder : DEFAULT_MESH_OPTIONS.elementOrder;

  const elementShape: MeshOptions["elementShape"] =
    o.elementShape === "simplex" || o.elementShape === "subdivided" || o.elementShape === "hexDominant"
      ? o.elementShape
      : DEFAULT_MESH_OPTIONS.elementShape;

  const sizeMinRaw = isFiniteNumber(o.sizeMin) && o.sizeMin >= 0 ? o.sizeMin : DEFAULT_MESH_OPTIONS.sizeMin;
  const sizeMaxRaw = isFiniteNumber(o.sizeMax) && o.sizeMax >= 0 ? o.sizeMax : DEFAULT_MESH_OPTIONS.sizeMax;
  // The pair must be internally consistent; if not, fall back to the default pair.
  const sizeValid = sizeMinRaw <= sizeMaxRaw;
  const sizeMin = sizeValid ? sizeMinRaw : DEFAULT_MESH_OPTIONS.sizeMin;
  const sizeMax = sizeValid ? sizeMaxRaw : DEFAULT_MESH_OPTIONS.sizeMax;

  const algorithm2D = isFiniteNumber(o.algorithm2D) ? o.algorithm2D : DEFAULT_MESH_OPTIONS.algorithm2D;
  const algorithm3D = isFiniteNumber(o.algorithm3D) ? o.algorithm3D : DEFAULT_MESH_OPTIONS.algorithm3D;

  // Backward-compatible: the pre-enum boolean parses as default/none, so
  // every existing sidecar, preset and MCP caller keeps working unchanged.
  const optimize: MeshOptions["optimize"] =
    o.optimize === true
      ? "default"
      : o.optimize === false
        ? "none"
        : o.optimize === "none" || o.optimize === "default" || o.optimize === "netgen" || o.optimize === "highOrder"
          ? o.optimize
          : DEFAULT_MESH_OPTIONS.optimize;

  const stlAngle =
    isFiniteNumber(o.stlAngle) && o.stlAngle > 0 && o.stlAngle < 180 ? o.stlAngle : DEFAULT_MESH_OPTIONS.stlAngle;

  const engine: MeshOptions["engine"] = o.engine === "gmsh" || o.engine === "ftetwild" || o.engine === "octree" || o.engine === "octreemesh" ? o.engine : DEFAULT_MESH_OPTIONS.engine;

  const ftetwildEpsRel =
    isFiniteNumber(o.ftetwildEpsRel) && o.ftetwildEpsRel > 0
      ? o.ftetwildEpsRel
      : DEFAULT_MESH_OPTIONS.ftetwildEpsRel;

  const ftetwildManifoldSurface =
    typeof o.ftetwildManifoldSurface === "boolean" ? o.ftetwildManifoldSurface : DEFAULT_MESH_OPTIONS.ftetwildManifoldSurface;
  const ftetwildCoarsen =
    typeof o.ftetwildCoarsen === "boolean" ? o.ftetwildCoarsen : DEFAULT_MESH_OPTIONS.ftetwildCoarsen;
  const ftetwildDisableFiltering =
    typeof o.ftetwildDisableFiltering === "boolean" ? o.ftetwildDisableFiltering : DEFAULT_MESH_OPTIONS.ftetwildDisableFiltering;

  const octreeMaxLevel =
    isFiniteNumber(o.octreeMaxLevel) && o.octreeMaxLevel >= 1
      ? Math.min(OCTREE_MAX_LEVEL_LIMIT, Math.round(o.octreeMaxLevel))
      : DEFAULT_MESH_OPTIONS.octreeMaxLevel;
  const octreeSnap = typeof o.octreeSnap === "boolean" ? o.octreeSnap : DEFAULT_MESH_OPTIONS.octreeSnap;

  const octreeMeshOutput: OctreeMeshOutput = OCTREE_MESH_OUTPUTS.includes(o.octreeMeshOutput as OctreeMeshOutput)
    ? (o.octreeMeshOutput as OctreeMeshOutput)
    : DEFAULT_MESH_OPTIONS.octreeMeshOutput;
  const octreeMeshMaxSize =
    isFiniteNumber(o.octreeMeshMaxSize) && o.octreeMeshMaxSize > 0 ? o.octreeMeshMaxSize : DEFAULT_MESH_OPTIONS.octreeMeshMaxSize;
  const octreeMeshLevels =
    isFiniteNumber(o.octreeMeshLevels) && o.octreeMeshLevels >= 1
      ? Math.min(OCTREE_MESH_LEVELS_LIMIT, Math.round(o.octreeMeshLevels))
      : DEFAULT_MESH_OPTIONS.octreeMeshLevels;

  const conformal = typeof o.conformal === "boolean" ? o.conformal : DEFAULT_MESH_OPTIONS.conformal;

  const out: MeshOptions = {
    dimension,
    sizeMin,
    sizeMax,
    algorithm2D,
    algorithm3D,
    elementOrder,
    elementShape,
    optimize,
    stlAngle,
    engine,
    ftetwildEpsRel,
    ftetwildManifoldSurface,
    ftetwildCoarsen,
    ftetwildDisableFiltering,
    octreeMaxLevel,
    octreeSnap,
    octreeMeshOutput,
    octreeMeshMaxSize,
    octreeMeshLevels,
    conformal,
  };
  // Optional and omitted when absent, so an untouched sidecar stays byte-stable.
  if (isFiniteNumber(o.budgetElements) && o.budgetElements >= 1) out.budgetElements = Math.round(o.budgetElements);
  const periodic = validatePeriodicPairs(o.periodic);
  if (periodic.length > 0) out.periodic = periodic;
  const sizeField = validateSizeField(o.sizeField);
  if (sizeField !== undefined) out.sizeField = sizeField;
  return out;
}

/**
 * STL/mesh-format sources can't get true part-preserving physical groups (see
 * `gmshPartsMap.ts`'s doc comment — Gmsh's STL reclassification pipeline
 * produces brand-new surface/volume tags with zero correlation to any
 * original id), but a narrow sizing-only degrade is still useful: if exactly
 * one part has `meshSize` set, apply it as a one-off `sizeMin`/`sizeMax`
 * override for this generate/export call only (never persisted — the caller
 * must not write the result back to the `.mesh.json` sidecar). Zero or more
 * than one part with `meshSize` set is ambiguous (which part's size should
 * win for a single merged STL volume?) — silently falls back to `options`
 * unchanged.
 */
export function applyStlPartSizeOverride(options: MeshOptions, parts: Part[]): MeshOptions {
  const withSize = parts.filter((p) => p.meshSize != null);
  if (withSize.length !== 1) return options;
  const size = withSize[0].meshSize as number;
  return { ...options, sizeMin: size, sizeMax: size };
}

/**
 * Rescales `sizeMin`/`sizeMax` by `factor` for a unit-converted Gmsh-format
 * export (the FE Mesh panel's Export flow only — interactive **Generate**
 * always stays native mm, since its overlay is display-only and has no
 * exported file whose numbers need to mean anything to an external tool; see
 * CLAUDE.md's meshing-unit-conversion section). `factor` is
 * `unitScaleFactor(unit)` from `lengthUnits.ts` (mm → target-unit); it must
 * be the SAME factor used to scale the geometry the caller feeds Gmsh
 * (`exportBRep`'s `unit` param for B-rep sources, `scaleStlBytes` for
 * STL ones) — a size target left in raw mm while the geometry is now
 * inch-scaled would apply as a wildly wrong relative density (the exact bug
 * this feature closes). Never persisted — the caller must not write the
 * result back to the `.mesh.json` sidecar. `SIZE_MAX_SENTINEL` is left
 * untouched: it's a "no explicit size yet" flag, not a real mm value, and
 * stays effectively unbounded at any scale anyway.
 */
export function scaleMeshOptionsForUnit(options: MeshOptions, factor: number): MeshOptions {
  if (factor === 1) return options;
  return {
    ...options,
    sizeMin: options.sizeMin * factor,
    sizeMax: options.sizeMax === SIZE_MAX_SENTINEL ? SIZE_MAX_SENTINEL : options.sizeMax * factor,
    ...(options.periodic
      ? {
          periodic: options.periodic.map((p) => ({
            ...p,
            translation: p.translation.map((v) => v * factor) as PeriodicPair["translation"],
          })),
        }
      : {}),
    ...(options.sizeField
      ? {
          sizeField: options.sizeField.map((s) => ({
            point: s.point.map((v) => v * factor) as SizeFieldSample["point"],
            size: s.size * factor,
          })),
        }
      : {}),
  };
}

/**
 * The `Part[]`-side sibling of {@link scaleMeshOptionsForUnit} — rescales
 * every part's own `meshSize` (mm), every length in its `meshGrading`
 * band (all four fields are lengths in the same unit) and the `wallSize` /
 * `thickness` of its `meshBoundaryLayer` (the growth ratio is dimensionless)
 * by the same `factor`,
 * for the same unit-converted-export-only, never-persisted reason. A part
 * with neither set is left untouched.
 */
export function scalePartsMeshSizeForUnit(parts: Part[], factor: number): Part[] {
  if (factor === 1) return parts;
  return parts.map((p) => {
    if (p.meshSize == null && p.meshGrading == null && p.meshBoundaryLayer == null) return p;
    return {
      ...p,
      meshSize: p.meshSize != null ? p.meshSize * factor : p.meshSize,
      meshBoundaryLayer:
        p.meshBoundaryLayer != null
          ? { ...p.meshBoundaryLayer, wallSize: p.meshBoundaryLayer.wallSize * factor, thickness: p.meshBoundaryLayer.thickness * factor }
          : p.meshBoundaryLayer,
      meshGrading:
        p.meshGrading != null
          ? {
              sizeAtWall: p.meshGrading.sizeAtWall * factor,
              sizeFar: p.meshGrading.sizeFar * factor,
              distNear: p.meshGrading.distNear * factor,
              distFar: p.meshGrading.distFar * factor,
            }
          : p.meshGrading,
    };
  });
}
