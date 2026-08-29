import * as fs from "fs";
import * as path from "path";
// The gmsh-wasm package's default export is an async emscripten-style factory,
// mirroring opencascade.js's raw factory shape (see occtService.ts) — pass the
// wasm binary explicitly rather than letting it try to fetch() a filesystem path.
//
// IMPORTANT: this package must stay `external` in esbuild.mjs — NEVER bundled
// into dist/extension.js — and must be shipped as real files under
// node_modules/ in the packaged .vsix (see the `!node_modules/...` carve-out
// in .vscodeignore). Two independent reasons, both verified against the live
// WASM build:
//  1. A bundled copy resolves esbuild's static `import` to the package's
//     "import" condition (./dist/gmsh.mjs), whose pthread-worker bootstrap
//     uses a top-level `await import('worker_threads')` that the "cjs" output
//     format this bundle is built with cannot represent (build fails).
//  2. Far worse, if that's dodged some other way (e.g. a literal `require()`
//     forcing the "require" condition so it CAN be bundled): gmsh's Emscripten
//     pthread pool spawns Node `worker_threads.Worker`s *eagerly*, right at
//     `gmsh.initialize()` — confirmed 4 workers spawned immediately, before
//     any mesh generation call. Each worker re-executes whatever file it
//     believes is its own script (`_scriptName`, effectively `__filename` of
//     the bundle gmsh-core.cjs's code ends up in). If that file is the WHOLE
//     bundled dist/extension.js, every worker re-runs the entire VS Code
//     extension from scratch and immediately crashes on `require("vscode")`
//     (that global only exists inside the real extension host process, not a
//     plain worker_thread) — the main thread then blocks forever waiting for
//     a pthread pool that can never come up. This is the actual cause of
//     "Generate never finishes": not a slow/broken mesher, a dead worker pool.
//     Keeping the package external means `_scriptName` resolves to the real,
//     standalone, vscode-free `node_modules/@loumalouomega/gmsh-wasm/dist/
//     gmsh-core.cjs`, so its workers start cleanly.
// A plain external `import` is enough — no `createRequire`/literal-`require`
// trickery needed: esbuild leaves an external import as a real `require()` in
// the "cjs" output, which Node resolves at actual runtime (honoring the
// package's "require" export condition), sidestepping both problems above.
import initialize from "@loumalouomega/gmsh-wasm";
import { gmshShapeOptions, SIZE_MAX_SENTINEL, DEFAULT_MESH_OPTIONS, type MeshOptions, type MeshEngine } from "./meshOptions";
import { summarizeQuality, type QualitySummary } from "./meshQuality";
import type { Part, MeshElementGroup } from "./protocol";
import { applyPartsToGmshModel, type PartGroupInfo, type PartGroupMaps } from "./gmshPartsMap";
import { meshExportFormat, type MeshExportFormatId } from "./meshExportFormats";
import { writeMdpa, type MdpaMesh, type MdpaMode, type MdpaNode, type MdpaCell, type MdpaGroup } from "./mdpaWriter";
import { parseToWeldedMesh } from "./meshHeal";
import { boundsOfTriangles, boundsDiagonal, weldedMeshToStlBytes } from "./meshComponents";
import { tetrahedralize, tetsToMsh41 } from "./ftetwildService";
import type { MeshParseFormat } from "./fileRouter";
import type { GltfExternalBuffers } from "./gltfParser";
import {
  GMSH_ELEMENT_TYPES,
  MDPA_KIND_INFO,
  surfaceTriangles,
  boundaryTriangles,
  boundaryFaceRings,
  triangulateRing,
  faceRingKey,
  surfaceElementRings,
  surfaceEdges,
  boundaryEdges,
  type GmshElementsResult,
} from "./gmshElementTypes";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GmshApi = any;

let _gmshPromise: Promise<GmshApi> | null = null;
let _modelCounter = 0;

/**
 * Returns the GMSH-wasm module, initializing it lazily on first call and
 * memoizing the resolved promise as a module singleton — same discipline as
 * `getOcct` in occtService.ts. `gmsh.initialize()` (the C API's own init, distinct
 * from the module factory above) is started here too, exactly once per process
 * lifetime; subsequent `generateMesh`/`exportGeoUnrolled` calls reset state via
 * `gmsh.clear()` + `gmsh.model.add(...)` instead of re-initializing.
 *
 * A REJECTED init is deliberately NOT memoized (the `.catch` below un-caches
 * it before rethrowing) — the same fix `getOcct` needed: without it, a single
 * transient init failure would poison every later `getGmsh()` call in this
 * process forever, since `_gmshPromise` would keep resolving to the same
 * rejection.
 */
export function getGmsh(extensionPath: string): Promise<GmshApi> {
  if (!_gmshPromise) {
    const wasmPath = path.join(extensionPath, "dist", "gmsh-core.wasm");
    const wasmBinary = fs.readFileSync(wasmPath);
    // gmsh-wasm 0.2.0's Node default for `print`/`printErr` writes straight to
    // fd 1/2 via `fs.writeSync` (verified against the live build), bypassing
    // console.log/console.error entirely — 0.1.x used console.log, which
    // mcpServer.ts's top-of-file console rebinding could intercept, but this
    // new default writes to stdout directly and corrupts the MCP JSON-RPC
    // stream the instant a model generates. Route both through console.error
    // so mcpServer.ts's rebinding (or, in the extension host, plain stderr)
    // still applies regardless of which stream gmsh's own default would use.
    _gmshPromise = initialize({
      wasmBinary,
      print: (...args: unknown[]) => console.error(...args),
      printErr: (...args: unknown[]) => console.error(...args),
    })
      .then((gmsh) => {
        gmsh.initialize();
        return gmsh;
      })
      .catch((err) => {
        _gmshPromise = null;
        throw err;
      });
  }
  return _gmshPromise;
}

/** Resets the singleton — used by tests and for future hot-reload support. */
export function resetGmsh(): void {
  _gmshPromise = null;
  _modelCounter = 0;
}

/** Emscripten aborts (out-of-bounds access, unreachable, null function pointer,
 * heap exhaustion) surface as opaque `RuntimeError`s. Recognize them so they can
 * be turned into an actionable message instead of the raw "memory access out of
 * bounds" that reaches the panel today. */
function isWasmAbort(message: string): boolean {
  return /out of bounds|abort|RuntimeError|unreachable|null function|table index|function table/i.test(message);
}

/**
 * Wraps `gmsh.model.mesh.generate` so an internal gmsh WASM crash becomes an
 * actionable error rather than a bare "memory access out of bounds". Two things
 * matter here: (1) an aborted Emscripten instance is **corrupt** — every later
 * call would keep throwing — so we discard the singleton (`resetGmsh()`) to force
 * a fresh module on the next attempt; (2) the message hints at the most common
 * cause: the 3D Delaunay algorithm's documented boundary-recovery crash on
 * imported CAD geometry in this build (which is why Frontal is the default). We
 * do NOT hard-block the option combination — Delaunay meshes many models fine,
 * and a crash can equally come from too fine a size (heap exhaustion), so there
 * is no reliable static "incompatible" matrix to gate on.
 */
function runMeshGenerate(gmsh: GmshApi, options: MeshOptions): void {
  try {
    gmsh.model.mesh.generate(options.dimension);
  } catch (err) {
    const raw = ((err as Error)?.message ?? String(err)).trim();
    if (!isWasmAbort(raw)) throw err;
    resetGmsh();
    const hint =
      options.dimension === 3 && options.algorithm3D === 1
        ? " The 3D Delaunay algorithm is known to crash on imported CAD geometry in this build — switch the 3D algorithm to Frontal (4) in Advanced settings."
        : " Try a coarser Size max, a different meshing algorithm, or linear (order 1) elements.";
    throw new Error(`Gmsh crashed while meshing (${raw || "WASM abort"}).${hint}`);
  }
}

export type MeshGenerationInput =
  | { kind: "brep"; stepBytes: Uint8Array }
  | { kind: "stl"; stlBytes: Uint8Array };

export interface MeshResult {
  positions: Float32Array;
  indices: Uint32Array;
  /** True element-edge line segments (index pairs) for the wireframe — quad
   * perimeters for hexes, triangle edges for tets — so the overlay shows the
   * actual element shape, not the triangulated fill's diagonals. */
  edges: Uint32Array;
  elementGroups: MeshElementGroup[];
  nodeCount: number;
  elementCount: number;
  mshText: string;
  /** Per-element quality summary (min/mean/histogram) over the mesh's
   * top-dimension elements (tets/hexes for a 3D generate, tris/quads for 2D) —
   * `undefined` if quality couldn't be computed (e.g. a 1D mesh, or the one
   * anomalous-empty-result case observed while verifying `getElementQualities`
   * against the live WASM; see `computeQualityAndWorstElements`'s doc comment). */
  quality?: QualitySummary;
  /** A highlight overlay of the worst-quality elements' own boundary — see
   * `WorstElementsOverlay`. Only ever set for a 3D generate; `undefined` when
   * nothing scored below the quality threshold (a good mesh) or quality
   * couldn't be computed at all. */
  worstElements?: WorstElementsOverlay;
  /** Which volume mesher actually ran — see `MeshOptions.engine`/
   * `effectiveEngine`. May differ from what was REQUESTED: `"ftetwild"` is
   * only honored for a 3D mesh-format source, so a B-rep source or a
   * non-3D `dimension` silently (but visibly, via `warnings` below) falls
   * back to `"gmsh"`. */
  engineUsed: MeshEngine;
  /** Non-fatal, worth-surfacing notes — currently only an engine-fallback
   * explanation (see `engineUsed` above); empty when nothing was downgraded. */
  warnings: string[];
}

/** A highlight overlay of the mesh's worst-quality elements, closing the
 * roadmap gap where bad tets are frequently *interior* and invisible in the
 * boundary-only FE overlay — see `computeQualityAndWorstElements`. */
export interface WorstElementsOverlay {
  /** Triangle indices into the SAME `positions` buffer as `MeshResult.indices`
   * — the worst-quality elements' own full boundary (every face of the
   * selected elements, not deduped against the rest of the mesh — only faces
   * shared between two selected elements dedup away). */
  indices: Uint32Array;
  /** The `minSICN` quality cutoff used to select "worst" elements. */
  threshold: number;
  /** Elements actually included in `indices` — capped at `MAX_WORST_ELEMENTS`,
   * prioritizing the lowest-quality elements first. */
  shownCount: number;
  /** Total elements below `threshold` found — may exceed `shownCount` if the
   * cap was hit (never a silent truncation; the caller can report both). */
  belowThresholdCount: number;
}

/**
 * Resets model state (`clear()` + fresh `model.add(...)`, never a second
 * `gmsh.initialize()`), writes `input`'s bytes to MEMFS, and builds the GMSH
 * geometry + applies `options` — shared by `generateMesh` and
 * `exportGeoUnrolled`, which then diverge (mesh+read-back vs. write .geo_unrolled).
 * The caller owns unlinking the MEMFS temp file it's given back, in its own
 * try/finally.
 *
 * `parts` (B-rep input only — ignored for STL, see `applyPartsToGmshModel`'s
 * doc comment for why) are turned into Gmsh physical groups + an optional
 * per-part background sizing field right after `occ.synchronize()`, so both
 * `.msh`/`.geo_unrolled` output and `mesh.generate()` itself see them.
 */
async function loadGeometryAndApplyOptions(
  extensionPath: string,
  gmsh: GmshApi,
  input: MeshGenerationInput,
  options: MeshOptions,
  parts: Part[]
): Promise<{ tmpPath: string; groupMaps: PartGroupMaps | null }> {
  gmsh.clear();
  gmsh.model.add(`model-${++_modelCounter}`);

  const tmpPath = input.kind === "brep" ? "/model.step" : "/model.stl";
  gmsh.FS.writeFile(tmpPath, input.kind === "brep" ? input.stepBytes : input.stlBytes);

  let groupMaps: PartGroupMaps | null = null;
  if (input.kind === "brep") {
    gmsh.model.occ.importShapes(tmpPath);
    gmsh.model.occ.synchronize();
    groupMaps = await applyPartsToGmshModel(extensionPath, gmsh, input.stepBytes, parts);
  } else {
    gmsh.merge(tmpPath);
    gmsh.model.mesh.classifySurfaces((options.stlAngle ?? 40) * (Math.PI / 180));
    gmsh.model.mesh.createGeometry();
    const surfaces = gmsh.model.getEntities(2).dimTags as number[];
    const surfaceTags: number[] = [];
    for (let i = 0; i < surfaces.length; i += 2) surfaceTags.push(surfaces[i + 1]);
    if (surfaceTags.length === 0) {
      throw new Error("STL classification produced no surfaces — the mesh may not be a valid closed solid");
    }
    const loopTag = gmsh.model.geo.addSurfaceLoop(surfaceTags);
    gmsh.model.geo.addVolume([loopTag]);
    gmsh.model.geo.synchronize();
  }

  gmsh.option.setNumber("Mesh.MeshSizeMin", options.sizeMin);
  gmsh.option.setNumber("Mesh.MeshSizeMax", options.sizeMax);
  gmsh.option.setNumber("Mesh.Algorithm", options.algorithm2D);
  // Element geometry (simplex vs. quad/hex subdivision vs. hex-dominant RTree).
  // All option values are set every time — the gmsh singleton persists options
  // across `clear()`, so a prior run's shape must be overwritten, not left
  // implicit. See `gmshShapeOptions` for the dimension-dependent, WASM-verified
  // recipe. `algorithm3DOverride` (hex-dominant's RTree, id 9) wins over the
  // user's own `algorithm3D` selection when set — RTree is a requirement of
  // that mode, not a suggestion.
  const shape = gmshShapeOptions(options.elementShape, options.dimension);
  gmsh.option.setNumber("Mesh.Algorithm3D", shape.algorithm3DOverride ?? options.algorithm3D);
  gmsh.option.setNumber("Mesh.ElementOrder", options.elementOrder);
  gmsh.option.setNumber("Mesh.RecombineAll", shape.recombineAll);
  gmsh.option.setNumber("Mesh.SubdivisionAlgorithm", shape.subdivisionAlgorithm);
  gmsh.option.setNumber("Mesh.Recombine3DAll", shape.recombine3DAll);
  gmsh.option.setNumber("Mesh.Optimize", options.optimize ? 1 : 0);
  // Gmsh's default (0) writes only elements belonging to a physical group once
  // ANY physical group exists in the model — i.e. the instant one part has a
  // resolved entity, `gmsh.write()` would silently drop every other
  // entity's elements from .msh/.geo_unrolled output. Physical groups here are
  // purely an additional tag on top of the full mesh, never a filter, so this
  // must always be 1 regardless of whether `parts` is empty.
  gmsh.option.setNumber("Mesh.SaveAll", 1);

  return { tmpPath, groupMaps };
}

/**
 * Resolves `options.engine` down to what will ACTUALLY run, downgrading to
 * `"gmsh"` (with an explanatory warning, never silently) for the two cases
 * fTetWild can't meaningfully help with: a B-rep source (already exact
 * geometry — nothing to be robust against) and a non-3D `dimension`
 * (fTetWild is a volume mesher only). `"gmsh"` itself is never downgraded —
 * it's always valid.
 */
function effectiveEngine(input: MeshGenerationInput, options: MeshOptions): { engine: MeshEngine; warnings: string[] } {
  if (options.engine !== "ftetwild") return { engine: "gmsh", warnings: [] };
  if (input.kind === "brep") {
    return {
      engine: "gmsh",
      warnings: [
        'Engine "ftetwild" was requested but this is a B-rep source with exact geometry — fTetWild only helps with dirty triangle meshes, so Gmsh was used instead.',
      ],
    };
  }
  if (options.dimension !== 3) {
    return {
      engine: "gmsh",
      warnings: [
        `Engine "ftetwild" was requested but dimension is ${options.dimension} — fTetWild only produces 3D tetrahedral volume meshes, so Gmsh was used instead.`,
      ],
    };
  }
  return { engine: "ftetwild", warnings: [] };
}

/**
 * Populates `gmsh`'s CURRENT model with a finished volume mesh, dispatching
 * on `options.engine` (as resolved by {@link effectiveEngine}) — the single
 * seam every meshing/export entry point below (`generateMesh`,
 * `exportMeshFormat`, `exportMdpa`) shares, so the fTetWild alternative
 * reuses every existing downstream read-back path (`buildIndices`/
 * `buildEdges`/`gmsh.write()`/`extractMdpaMesh`/
 * `computeQualityAndWorstElements`) completely unchanged — see CLAUDE.md's
 * fTetWild section for the full design.
 *
 * `"gmsh"` is byte-for-byte the original `loadGeometryAndApplyOptions` +
 * `runMeshGenerate` sequence this function replaces at each call site.
 *
 * `"ftetwild"` (mesh-format 3D sources only, per `effectiveEngine`'s gate)
 * instead: parses the raw STL bytes into a welded triangle soup
 * (`parseToWeldedMesh`, entirely host-side, no WASM — the exact input shape
 * `check_mesh_health`/`promote_mesh_to_brep` already use for the identical
 * four dirty-mesh formats), tetrahedralizes it (`ftetwildService.ts`'s
 * `tetrahedralize`, which survives the holes/self-intersections/
 * non-manifold edges that make Gmsh's own `classifySurfaces` throw
 * "STL classification produced no surfaces"), serializes the raw result to
 * MSH 4.1 text (`tetsToMsh41`), and `gmsh.merge()`s it into the SAME gmsh
 * model `generateMesh` would otherwise have used directly — verified live:
 * this creates a genuine queryable 3D discrete-volume entity (`getEntities
 * (3)`), not a dead end; `getElements`/`getNodes`/`getElementQualities`/
 * `gmsh.write()` all resolve correctly against it.
 *
 * `idealEdgeLengthRel` (fTetWild's own target-edge-length knob, a FRACTION
 * of the input's own bbox diagonal) is derived from `options.sizeMax` (an
 * ABSOLUTE size) rather than stored as its own field, so the existing size
 * slider/Coarse-Medium-Fine presets keep working unchanged under either
 * engine — `SIZE_MAX_SENTINEL` (no explicit size chosen yet) falls back to
 * fTetWild's own default (`0.05`), which not coincidentally equals what
 * `syncMeshSizeSeed`'s own `diagonal/20` bbox-derived seed already produces.
 *
 * `parts` are silently unused under `"ftetwild"`, same as Gmsh's own STL
 * path already does (`groupMaps` stays `null` either way) — Gmsh's STL
 * reclassification has no part correlation to begin with (see
 * `gmshPartsMap.ts`'s doc comment), and an externally-tetrahedralized mesh
 * has none for the identical reason.
 */
async function populateMeshedModel(
  extensionPath: string,
  gmsh: GmshApi,
  input: MeshGenerationInput,
  options: MeshOptions,
  parts: Part[]
): Promise<{ tmpPath: string | null; groupMaps: PartGroupMaps | null; engineUsed: MeshEngine; warnings: string[] }> {
  const { engine, warnings } = effectiveEngine(input, options);

  if (engine === "gmsh") {
    const loaded = await loadGeometryAndApplyOptions(extensionPath, gmsh, input, options, parts);
    runMeshGenerate(gmsh, options);
    return { tmpPath: loaded.tmpPath, groupMaps: loaded.groupMaps, engineUsed: "gmsh", warnings };
  }

  // engine === "ftetwild" — effectiveEngine only returns this for input.kind
  // === "stl" (mesh-format) at dimension 3.
  const stlInput = input as Extract<MeshGenerationInput, { kind: "stl" }>;
  gmsh.clear();
  gmsh.model.add(`model-${++_modelCounter}`);

  const welded = parseToWeldedMesh(stlInput.stlBytes, "stl");
  const allTriangles = Array.from({ length: Math.floor(welded.indices.length / 3) }, (_, i) => i);
  const bounds = boundsOfTriangles(welded.positions, welded.indices, allTriangles);
  const diagonal = bounds ? boundsDiagonal(bounds) : 0;
  const idealEdgeLengthRel =
    options.sizeMax === SIZE_MAX_SENTINEL || !(diagonal > 0) ? 0.05 : Math.min(1, options.sizeMax / diagonal);

  const { vertices, tets } = await tetrahedralize(welded, {
    epsRel: options.ftetwildEpsRel,
    idealEdgeLengthRel,
  });
  const mshText = tetsToMsh41(vertices, tets);

  // Short MEMFS path — this build's OCCT module has a documented undocumented
  // path-length cliff (see meshHeal.ts's writeShape callers); unconfirmed but
  // untested for this gmsh-wasm build, so kept short defensively.
  const tmpPath = "/i.msh";
  gmsh.FS.writeFile(tmpPath, mshText);
  gmsh.merge(tmpPath);
  // Same reasoning as loadGeometryAndApplyOptions's own Mesh.SaveAll — moot
  // today since `groupMaps` is always null here (no physical groups can
  // exist), but set for consistency/future-proofing at negligible cost.
  gmsh.option.setNumber("Mesh.SaveAll", 1);

  return { tmpPath, groupMaps: null, engineUsed: "ftetwild", warnings };
}

/**
 * Generates a mesh from `input` per `options` and returns node/element counts
 * plus a display-ready boundary triangulation (`positions`/`indices`) alongside
 * the raw `.msh` text. For `dimension === 3` the boundary triangles are derived
 * from the tetrahedra (faces appearing in exactly one tet); for `dimension ===
 * 2` the generated triangles are used directly; for `dimension === 1` there is
 * no triangle to display, so `positions`/`indices` are returned empty.
 */
export async function generateMesh(
  extensionPath: string,
  input: MeshGenerationInput,
  options: MeshOptions,
  parts: Part[] = []
): Promise<MeshResult> {
  const gmsh = await getGmsh(extensionPath);

  const outPath = "/out.msh";
  let tmpPath: string | null = null;
  try {
    const loaded = await populateMeshedModel(extensionPath, gmsh, input, options, parts);
    tmpPath = loaded.tmpPath;

    const nodes = gmsh.model.mesh.getNodes() as { nodeTags: number[]; coord: number[] };
    const { positions, tagToIndex } = buildPositions(nodes);

    const { indices, elementGroups } = buildIndices(gmsh, options.dimension, tagToIndex, loaded.groupMaps);
    const edges = buildEdges(gmsh, options.dimension, tagToIndex);

    gmsh.write(outPath);
    const mshText = gmsh.FS.readFile(outPath, { encoding: "utf8" }) as string;

    const { quality, worstElements } = computeQualityAndWorstElements(gmsh, options.dimension, tagToIndex);

    return {
      positions,
      indices,
      edges,
      elementGroups,
      nodeCount: nodes.nodeTags.length,
      elementCount: countElements(gmsh, options.dimension),
      mshText,
      quality,
      worstElements,
      engineUsed: loaded.engineUsed,
      warnings: loaded.warnings,
    };
  } finally {
    if (tmpPath) {
      try { gmsh.FS.unlink(tmpPath); } catch { /* ignore */ }
    }
    try { gmsh.FS.unlink(outPath); } catch { /* ignore */ }
  }
}

export interface RepairMeshResult {
  /** ASCII STL bytes of the repaired (watertight, manifold) surface. */
  stlBytes: Uint8Array;
  nodeCount: number;
  elementCount: number;
}

/**
 * Repairs a dirty triangle mesh (holes, self-intersections, non-manifold
 * edges — exactly what `check_mesh_health` already diagnoses and
 * `promote_mesh_to_brep` then fails to close) into a watertight surface, by
 * tetrahedralizing it with fTetWild and taking the resulting volume mesh's
 * own boundary. A tet mesh's boundary is watertight and manifold BY
 * CONSTRUCTION regardless of how broken the input was — holes close,
 * self-intersections resolve, and fTetWild's own winding-number-based
 * interior classification handles the rest (see `ftetwildService.ts`). This
 * closes roadmap item "Robust volumetric meshing from a skin mesh"'s own
 * Phase 1 shape ("repair, then reuse the existing mesher") without either of
 * its originally-scoped blockers (an unmerged meshio++ SDF branch, or a
 * nonexistent WASM build of MMG).
 *
 * Deliberately reuses `generateMesh` wholesale rather than re-implementing
 * boundary extraction: a 3D `engine: "ftetwild"` generate's own
 * `positions`/`indices` output already IS the tet mesh's boundary
 * triangulation (`buildIndices`'s existing `extractBoundaryFaces` →
 * `boundaryTriangles` path, completely unchanged) — there is nothing else
 * to build. The repaired result is handed back as ASCII STL bytes (via
 * `weldedMeshToStlBytes`), the same shape `check_mesh_health`/
 * `promote_mesh_to_brep` already accept, so a caller's natural next step —
 * re-running either of those on the repaired bytes — needs no new plumbing.
 *
 * No triangle-count ceiling is imposed here — unlike `meshHeal.ts`'s
 * `MAX_HEALABLE_TRIANGLES` (a property of the per-triangle OCCT sewing
 * pipeline specifically, one face per triangle), fTetWild's own cost profile
 * is different and unmeasured at scale; the kernel-worker's existing 5-minute
 * watchdog (`kernelClient.ts`) is the backstop for now.
 */
export async function repairMesh(
  extensionPath: string,
  bytes: Uint8Array,
  format: MeshParseFormat,
  external?: GltfExternalBuffers
): Promise<RepairMeshResult> {
  const welded = parseToWeldedMesh(bytes, format, external);
  const stlBytes = weldedMeshToStlBytes(welded);
  const result = await generateMesh(
    extensionPath,
    { kind: "stl", stlBytes },
    { ...DEFAULT_MESH_OPTIONS, engine: "ftetwild", dimension: 3 },
    []
  );
  const repairedStlBytes = weldedMeshToStlBytes({ positions: result.positions, indices: result.indices });
  return { stlBytes: repairedStlBytes, nodeCount: result.nodeCount, elementCount: result.elementCount };
}

export interface GeoExportResult {
  text: string;
  /**
   * The companion XAO file Gmsh writes alongside `.geo_unrolled` output for
   * OCC-imported (B-rep) geometry — `null` for a pure GEO-kernel model (the
   * STL path), which unrolls fully inline with no companion needed.
   */
  xao: Uint8Array | null;
}

/**
 * Same geometry-import + options setup as `generateMesh`, but writes the
 * model's unrolled `.geo` script instead of meshing — lets Export offer a
 * `.geo_unrolled` target without a second host round trip.
 *
 * OCC B-rep geometry (the STEP re-export every B-rep source goes through) has
 * no native textual GEO representation, so for that path `gmsh.write()` emits
 * a single `Merge "<xao>";` stub referencing a companion XAO file (Gmsh's own
 * OCC-preserving exchange format — it round-trips the shapes, physical
 * groups, and mesh-size fields) that it writes alongside `outPath` in MEMFS.
 * That XAO file is the actual content; `text` alone is a dangling reference
 * to a MEMFS-only path the caller must resolve — see `xao` above. The STL
 * path (GEO-kernel `addSurfaceLoop`/`addVolume`) has no such companion since
 * it unrolls to real Point/Curve/Surface/Volume commands inline.
 *
 * Deliberately does NOT go through `populateMeshedModel` — `engine:
 * "ftetwild"` throws here rather than silently falling back to Gmsh's own
 * geometry import: a `.geo_unrolled` script represents GEOMETRY (Gmsh's own
 * import/classification of it), not a mesh, and fTetWild never runs a Gmsh
 * geometry step at all — there is nothing meaningful to unroll for the mesh
 * it would have produced. `effectiveEngine`'s own B-rep/non-3D downgrades
 * still apply first, so this only actually throws for a genuine
 * 3D-mesh-format request, the one case `.geo_unrolled` export doesn't even
 * make sense to offer for an fTetWild-meshed document.
 */
export async function exportGeoUnrolled(
  extensionPath: string,
  input: MeshGenerationInput,
  options: MeshOptions,
  parts: Part[] = []
): Promise<GeoExportResult> {
  const { engine } = effectiveEngine(input, options);
  if (engine === "ftetwild") {
    throw new Error(
      '.geo_unrolled export is not available under engine "ftetwild" — it represents Gmsh\'s own geometry import, and fTetWild never runs one. Export a mesh format (e.g. .msh) instead, or switch the engine to "gmsh".'
    );
  }

  const gmsh = await getGmsh(extensionPath);

  const outPath = "/out.geo_unrolled";
  const xaoPath = `${outPath}.xao`;
  let tmpPath: string | null = null;
  try {
    const loaded = await loadGeometryAndApplyOptions(extensionPath, gmsh, input, options, parts);
    tmpPath = loaded.tmpPath;

    gmsh.write(outPath);
    const text = gmsh.FS.readFile(outPath, { encoding: "utf8" }) as string;

    let xao: Uint8Array | null = null;
    try {
      xao = gmsh.FS.readFile(xaoPath) as Uint8Array;
    } catch {
      // no companion — a GEO-kernel-only model unrolled fully inline.
    }

    return { text, xao };
  } finally {
    if (tmpPath) {
      try { gmsh.FS.unlink(tmpPath); } catch { /* ignore */ }
    }
    try { gmsh.FS.unlink(outPath); } catch { /* ignore */ }
    try { gmsh.FS.unlink(xaoPath); } catch { /* ignore */ }
  }
}

/**
 * Meshes `input` per `options`/`parts` (same geometry+options setup as
 * `generateMesh`) and writes the result in any of the other mesh formats
 * Gmsh's `gmsh.write()` supports besides `.msh`/`.geo_unrolled` — see
 * `meshExportFormats.ts` for the registry and which formats were actually
 * confirmed working against this WASM build. `gmsh.write()` dispatches purely
 * by the output path's extension, so this is a thin, format-agnostic
 * generate-then-write, unlike `.geo_unrolled`'s bespoke XAO-companion
 * handling above (none of these formats have an equivalent companion file).
 * `formatId` must not be `"msh"`/`"geoUnrolled"`/`"mdpaElements"`/
 * `"mdpaGeometries"` — those have their own dedicated functions and are never
 * routed through this one (MDPA in particular isn't a Gmsh writer format at
 * all — see `exportMdpa` below).
 */
export async function exportMeshFormat(
  extensionPath: string,
  input: MeshGenerationInput,
  options: MeshOptions,
  parts: Part[],
  formatId: Exclude<MeshExportFormatId, "msh" | "geoUnrolled" | "mdpaElements" | "mdpaGeometries">
): Promise<string> {
  const format = meshExportFormat(formatId);
  if (!format) throw new Error(`Unknown mesh export format: ${formatId}`);

  const gmsh = await getGmsh(extensionPath);
  const outPath = `/out.${format.extension}`;
  let tmpPath: string | null = null;
  try {
    const loaded = await populateMeshedModel(extensionPath, gmsh, input, options, parts);
    tmpPath = loaded.tmpPath;

    gmsh.write(outPath);
    return gmsh.FS.readFile(outPath, { encoding: "utf8" }) as string;
  } finally {
    if (tmpPath) {
      try { gmsh.FS.unlink(tmpPath); } catch { /* ignore */ }
    }
    try { gmsh.FS.unlink(outPath); } catch { /* ignore */ }
  }
}

/**
 * Meshes `input` per `options`/`parts` and hand-serializes the result as
 * Kratos MDPA text via `mdpaWriter.ts`'s pure `writeMdpa()`. Unlike every
 * other export format in this file, MDPA has no `gmsh.write()` support at
 * all — there is no MEMFS write/read-back round trip here; `extractMdpaMesh`
 * reads nodes/elements directly off the live model instead.
 *
 * Supports linear and quadratic simplex/hex/prism/pyramid/quad cells (see
 * `gmshElementTypes.ts`). In `"elements"` mode, some Kratos `Element`/
 * `Condition` names for the newer kinds are not yet confirmed — a pre-flight
 * throws with an actionable message (use `"geometries"` mode, whose names are
 * certain) if the generated mesh contains such a kind.
 */
export async function exportMdpa(
  extensionPath: string,
  input: MeshGenerationInput,
  options: MeshOptions,
  parts: Part[],
  mode: MdpaMode
): Promise<string> {
  const gmsh = await getGmsh(extensionPath);
  let tmpPath: string | null = null;
  try {
    const loaded = await populateMeshedModel(extensionPath, gmsh, input, options, parts);
    tmpPath = loaded.tmpPath;

    const mesh = extractMdpaMesh(gmsh, loaded.groupMaps);

    if (mode === "elements") {
      for (const cell of mesh.volumeCells) {
        if (MDPA_KIND_INFO[cell.kind].elementName === null) {
          throw new Error(
            `Kratos MDPA "Elements" mode has no confirmed Element name for a ${cell.kind} cell. ` +
              'Export in "Geometries" mode instead (its geometry names are certain).'
          );
        }
      }
      for (const cell of mesh.surfaceCells) {
        if (MDPA_KIND_INFO[cell.kind].conditionName === null) {
          throw new Error(
            `Kratos MDPA "Elements" mode has no confirmed Condition name for a ${cell.kind} cell. ` +
              'Export in "Geometries" mode instead (its geometry names are certain).'
          );
        }
      }
    }

    return writeMdpa(mesh, mode, (msg) => console.warn(`[CAD-Preview MDPA] ${msg}`));
  } finally {
    if (tmpPath) {
      try { gmsh.FS.unlink(tmpPath); } catch { /* ignore */ }
    }
  }
}

/**
 * Pulls the live gmsh model's mesh, plus `groupMaps`' part groupings, into the
 * plain gmsh-free `MdpaMesh` shape `writeMdpa` consumes. Must run after
 * `mesh.generate()`. Loops per-entity-tag (like `extractBoundaryFaces`/
 * `appendTriangles2D` above) rather than one whole-model `getElements(dim)`
 * call, since each cell's owning volume/surface tag is needed to resolve which
 * part it belongs to. Every element type is resolved through the shared
 * `gmshElementTypes.ts` table — its `permutation` reorders each cell's nodes
 * into Kratos order (and truncates complete order-2 prisms/pyramids to Kratos's
 * shorter geometry). A genuinely unmapped element type throws an actionable
 * error (graceful defensive backstop).
 */
function extractMdpaMesh(gmsh: GmshApi, groupMaps: PartGroupMaps | null): MdpaMesh {
  const nodesRaw = gmsh.model.mesh.getNodes() as { nodeTags: number[]; coord: number[] };
  const nodes: MdpaNode[] = nodesRaw.nodeTags.map((tag, i) => ({
    tag,
    x: nodesRaw.coord[i * 3],
    y: nodesRaw.coord[i * 3 + 1],
    z: nodesRaw.coord[i * 3 + 2],
  }));

  const volumeCells: MdpaCell[] = [];
  const cellVolumeTag: number[] = [];
  collectCells(gmsh, 3, volumeCells, cellVolumeTag);

  const surfaceCells: MdpaCell[] = [];
  const cellSurfaceTag: number[] = [];
  collectCells(gmsh, 2, surfaceCells, cellSurfaceTag);

  const groups: MdpaGroup[] = [];
  if (groupMaps) {
    for (const bucket of groupPartsAcrossDims(groupMaps)) {
      const volumeTagSet = new Set(bucket.volumeTags);
      const surfaceTagSet = new Set(bucket.surfaceTags);
      const volumeCellIndices: number[] = [];
      cellVolumeTag.forEach((vTag, idx) => {
        if (volumeTagSet.has(vTag)) volumeCellIndices.push(idx);
      });
      const surfaceCellIndices: number[] = [];
      cellSurfaceTag.forEach((sTag, idx) => {
        if (surfaceTagSet.has(sTag)) surfaceCellIndices.push(idx);
      });

      const extraNodeTags: number[] = [];
      for (const pointTag of bucket.pointTags) {
        const pn = gmsh.model.mesh.getNodes(0, pointTag) as { nodeTags: number[] };
        extraNodeTags.push(...pn.nodeTags);
      }
      for (const curveTag of bucket.curveTags) {
        const cn = gmsh.model.mesh.getNodes(1, curveTag, true) as { nodeTags: number[] };
        extraNodeTags.push(...cn.nodeTags);
      }

      groups.push({ name: bucket.info.name, volumeCellIndices, surfaceCellIndices, extraNodeTags });
    }
  }

  return { nodes, volumeCells, surfaceCells, groups };
}

/** Walks every `dim`-D entity, resolving each element through the shared
 * `gmshElementTypes.ts` table into a Kratos-ordered {@link MdpaCell}, and
 * records each cell's owning entity tag in the parallel `ownerTags` array. */
function collectCells(gmsh: GmshApi, dim: 2 | 3, out: MdpaCell[], ownerTags: number[]): void {
  const entities = (gmsh.model.getEntities(dim).dimTags as number[]) ?? [];
  for (let i = 0; i < entities.length; i += 2) {
    const tag = entities[i + 1];
    const els = gmsh.model.mesh.getElements(dim, tag) as { elementTypes: number[]; nodeTags: number[][] };
    for (let t = 0; t < els.elementTypes.length; t++) {
      const type = els.elementTypes[t];
      const info = GMSH_ELEMENT_TYPES.get(type);
      if (!info || info.dim !== dim) {
        // Type 140 ("trihedron") is the tet/hex transition connector a
        // hexDominant (RTree) mesh always contains alongside plain tets/hexes
        // — its node geometry can't be verified against this WASM build
        // (`getElementProperties(140)` throws), so it has no `MdpaCellKind`
        // at all and can never be represented in Kratos MDPA output. Give
        // this specific, expected case an actionable message instead of the
        // generic "unsupported type" one below.
        if (type === 140) {
          throw new Error(
            "Kratos MDPA export does not support hex-dominant meshes: gmsh element type 140 " +
              "(the tet/hex transition connector RTree recombination always produces) has no " +
              "Kratos geometry equivalent. Export a different format (e.g. .msh or .vtk), or " +
              "regenerate with a non-hex-dominant element shape."
          );
        }
        throw new Error(
          `Kratos MDPA export: unsupported ${dim}D gmsh element type (${type}) in entity ${tag}. ` +
            "Adjust the mesh options and try again."
        );
      }
      const tagsForType = els.nodeTags[t];
      for (let n = 0; n + info.numNodes <= tagsForType.length; n += info.numNodes) {
        out.push({ kind: info.mdpa.kind, nodeTags: info.mdpa.permutation.map((p) => tagsForType[n + p]) });
        ownerTags.push(tag);
      }
    }
  }
}

/** 4-map generalization of {@link groupTagsByPart} below — buckets a part's
 * volume/surface/curve/point tags together by `PartGroupInfo` object
 * identity (the same `info` object `applyPartsToGmshModel` reuses across all
 * four of `groupMaps`' maps for one part — see its doc comment), preserving
 * first-encountered order. */
function groupPartsAcrossDims(maps: PartGroupMaps): Array<{
  info: PartGroupInfo;
  volumeTags: number[];
  surfaceTags: number[];
  curveTags: number[];
  pointTags: number[];
}> {
  const order: PartGroupInfo[] = [];
  const byInfo = new Map<
    PartGroupInfo,
    { volumeTags: number[]; surfaceTags: number[]; curveTags: number[]; pointTags: number[] }
  >();
  const ensure = (info: PartGroupInfo) => {
    let bucket = byInfo.get(info);
    if (!bucket) {
      bucket = { volumeTags: [], surfaceTags: [], curveTags: [], pointTags: [] };
      byInfo.set(info, bucket);
      order.push(info);
    }
    return bucket;
  };
  for (const [tag, info] of maps.volumeTagToPart) ensure(info).volumeTags.push(tag);
  for (const [tag, info] of maps.surfaceTagToPart) ensure(info).surfaceTags.push(tag);
  for (const [tag, info] of maps.curveTagToPart) ensure(info).curveTags.push(tag);
  for (const [tag, info] of maps.pointTagToPart) ensure(info).pointTags.push(tag);
  return order.map((info) => ({ info, ...byInfo.get(info)! }));
}

/**
 * Compacts GMSH's (1-based, possibly non-contiguous) node tags into a dense
 * `positions` Float32Array plus a tag→array-index map, so downstream index
 * buffers can be plain 0-based indices into `positions` rather than raw tags.
 */
function buildPositions(nodes: { nodeTags: number[]; coord: number[] }): {
  positions: Float32Array;
  tagToIndex: Map<number, number>;
} {
  const { nodeTags, coord } = nodes;
  const positions = new Float32Array(nodeTags.length * 3);
  const tagToIndex = new Map<number, number>();
  for (let i = 0; i < nodeTags.length; i++) {
    tagToIndex.set(nodeTags[i], i);
    positions[i * 3] = coord[i * 3];
    positions[i * 3 + 1] = coord[i * 3 + 1];
    positions[i * 3 + 2] = coord[i * 3 + 2];
  }
  return { positions, tagToIndex };
}

/**
 * Builds the overlay's **wireframe** line-index buffer: the true element edges
 * (quad perimeters for hexes/quads, triangle edges for tets/tris), NOT the
 * triangulated fill's diagonals. Ungrouped (a single-colour wireframe), so it
 * uses one whole-model `getElements(dim)` call rather than the per-part loops
 * `buildIndices` needs. Empty for `dimension === 1`.
 */
function buildEdges(
  gmsh: GmshApi,
  dimension: MeshOptions["dimension"],
  tagToIndex: Map<number, number>
): Uint32Array {
  if (dimension === 1) return new Uint32Array(0);
  const els = gmsh.model.mesh.getElements(dimension) as GmshElementsResult;
  const edges = dimension === 3 ? boundaryEdges(els, tagToIndex) : surfaceEdges(els, tagToIndex);
  return new Uint32Array(edges);
}

/**
 * Builds the display triangulation's index buffer for the given mesh
 * `dimension`, plus `elementGroups`: a contiguous, gap-free partition of the
 * returned `indices` into per-part ranges (when `groupMaps` resolved any
 * part's entities) followed by one trailing ungrouped range (`name`/`color`
 * both `null`) for anything not claimed by a part. With `groupMaps === null`
 * (no parts, or an STL source) this degrades to the original single-range,
 * single-global-`getElements`-call behavior.
 *
 * - `1`: no triangle exists for a line mesh; return an empty buffer.
 * - `2`: the generated surface elements (triangles AND recombined quads, linear
 *   or quadratic) are already the surface — their corner triangulation is
 *   remapped to compacted indices directly, per surface entity when grouping
 *   (see `gmshElementTypes.ts`'s {@link surfaceTriangles}).
 * - `3`: derive the boundary surface from the volume mesh by enumerating each
 *   3D cell's boundary faces (tetrahedra, hexahedra, prisms, pyramids), keying
 *   each face by its *corner* node tags *sorted* (an order-independent identity,
 *   with mid-side nodes excluded so order-1/order-2 faces dedup identically),
 *   and keeping only faces that occur in exactly one cell — a face shared by two
 *   cells is interior and both copies drop. Quad faces triangulate into two
 *   triangles. When grouping, this runs per-volume (`getElements(3, tag)` scoped
 *   to one volume) — correct even for two touching part-volumes, since Gmsh tags
 *   each cell by its single owning volume, so a shared face is independently
 *   each volume's own boundary. See {@link boundaryTriangles}. A face that also
 *   matches a **surface**-scoped part's own 2D boundary mesh (by the same
 *   sorted-corner-tag key) routes to that part's group instead of its owning
 *   volume's — see `buildIndices3D`'s `surfaceFaceKeyToPart` for the
 *   correlation this needs, since a tet-boundary face on its own carries no
 *   link back to the B-rep surface it came from.
 *
 * Exported (only, same as `computeQualityAndWorstElements` below) so
 * `gmshService.test.ts` can unit-test the grouping logic against a fake,
 * minimal `GmshApi` object — every other function here needs the real WASM
 * module and is exercised only via `npm run mcp:smoke`.
 */
export function buildIndices(
  gmsh: GmshApi,
  dimension: MeshOptions["dimension"],
  tagToIndex: Map<number, number>,
  groupMaps: PartGroupMaps | null
): { indices: Uint32Array; elementGroups: MeshElementGroup[] } {
  if (dimension === 1) {
    return { indices: new Uint32Array(0), elementGroups: [] };
  }
  if (dimension === 2) {
    return buildIndices2D(gmsh, tagToIndex, groupMaps);
  }
  return buildIndices3D(gmsh, tagToIndex, groupMaps);
}

function buildIndices2D(
  gmsh: GmshApi,
  tagToIndex: Map<number, number>,
  groupMaps: PartGroupMaps | null
): { indices: Uint32Array; elementGroups: MeshElementGroup[] } {
  if (!groupMaps || groupMaps.surfaceTagToPart.size === 0) {
    const out: number[] = [];
    appendTriangles2D(gmsh, undefined, tagToIndex, out);
    return {
      indices: new Uint32Array(out),
      elementGroups: out.length > 0 ? [{ name: null, color: null, indexStart: 0, indexCount: out.length }] : [],
    };
  }

  const out: number[] = [];
  const elementGroups: MeshElementGroup[] = [];
  const claimedTags = new Set<number>();
  for (const { info, tags } of groupTagsByPart(groupMaps.surfaceTagToPart)) {
    const start = out.length;
    for (const tag of tags) {
      claimedTags.add(tag);
      appendTriangles2D(gmsh, tag, tagToIndex, out);
    }
    if (out.length > start) {
      elementGroups.push({ name: info.name, color: info.color, indexStart: start, indexCount: out.length - start });
    }
  }

  const allSurfaces = (gmsh.model.getEntities(2).dimTags as number[]) ?? [];
  const start = out.length;
  for (let i = 0; i < allSurfaces.length; i += 2) {
    const tag = allSurfaces[i + 1];
    if (claimedTags.has(tag)) continue;
    appendTriangles2D(gmsh, tag, tagToIndex, out);
  }
  if (out.length > start) {
    elementGroups.push({ name: null, color: null, indexStart: start, indexCount: out.length - start });
  }

  return { indices: new Uint32Array(out), elementGroups };
}

/** Appends one surface entity's (or, with `tag === undefined`, every surface
 * entity's) corner triangulation, remapped via `tagToIndex`, onto `out`. Handles
 * every 2D element kind (triangles AND recombined quadrilaterals, linear or
 * quadratic) via the shared `gmshElementTypes.ts` table — see
 * {@link surfaceTriangles}. */
function appendTriangles2D(gmsh: GmshApi, tag: number | undefined, tagToIndex: Map<number, number>, out: number[]): void {
  const els = gmsh.model.mesh.getElements(2, tag) as GmshElementsResult;
  out.push(...surfaceTriangles(els, tagToIndex));
}

function buildIndices3D(
  gmsh: GmshApi,
  tagToIndex: Map<number, number>,
  groupMaps: PartGroupMaps | null
): { indices: Uint32Array; elementGroups: MeshElementGroup[] } {
  if (!groupMaps || (groupMaps.volumeTagToPart.size === 0 && groupMaps.surfaceTagToPart.size === 0)) {
    const boundaryTris = extractBoundaryFaces(gmsh, undefined, tagToIndex);
    return {
      indices: new Uint32Array(boundaryTris),
      elementGroups:
        boundaryTris.length > 0 ? [{ name: null, color: null, indexStart: 0, indexCount: boundaryTris.length }] : [],
    };
  }

  // A tet-boundary face carries only its owning *volume*'s tag, with no link
  // back to the B-rep surface it came from — so a surface-scoped part (as
  // opposed to a volume-scoped one) would otherwise never get its own overlay
  // colour range for a 3D generate. Resolved here via the 2D surface mesh Gmsh
  // generates as part of building the volume mesh (still live in the model
  // after `mesh.generate(3)`, same node tags as the volume boundary it seeded):
  // each surface-scoped part's boundary faces are identified by their sorted
  // corner-tag key, the same key `boundaryFaceRings` already uses to dedup
  // interior tet/hex faces.
  const surfaceFaceKeyToPart = new Map<string, PartGroupInfo>();
  for (const [tag, info] of groupMaps.surfaceTagToPart) {
    const els = gmsh.model.mesh.getElements(2, tag) as GmshElementsResult;
    for (const ring of surfaceElementRings(els)) surfaceFaceKeyToPart.set(faceRingKey(ring), info);
  }

  // Group precedence, in a stable id-independent order: existing volume-scoped
  // parts first (unchanged from before this fix), then any surface-scoped part
  // not already reachable through one (the new case) — a face resolves to its
  // surface-scoped part even when its owning volume also belongs to a
  // (different) volume-scoped part, since the surface assignment is the more
  // specific one.
  const groupOrder: PartGroupInfo[] = groupTagsByPart(groupMaps.volumeTagToPart).map((g) => g.info);
  for (const { info } of groupTagsByPart(groupMaps.surfaceTagToPart)) {
    if (!groupOrder.includes(info)) groupOrder.push(info);
  }
  const buckets = new Map<PartGroupInfo, number[]>(groupOrder.map((info) => [info, []]));
  const ungrouped: number[] = [];

  const allVolumes = (gmsh.model.getEntities(3).dimTags as number[]) ?? [];
  for (let i = 0; i < allVolumes.length; i += 2) {
    const tag = allVolumes[i + 1];
    const volumePart = groupMaps.volumeTagToPart.get(tag) ?? null;
    const els = gmsh.model.mesh.getElements(3, tag) as GmshElementsResult;
    for (const ring of boundaryFaceRings(els)) {
      const target = surfaceFaceKeyToPart.get(faceRingKey(ring)) ?? volumePart;
      const dest = target ? buckets.get(target)! : ungrouped;
      for (const tri of triangulateRing(ring, tagToIndex)) dest.push(...tri);
    }
  }

  const out: number[] = [];
  const elementGroups: MeshElementGroup[] = [];
  for (const info of groupOrder) {
    const tris = buckets.get(info)!;
    if (tris.length === 0) continue;
    const start = out.length;
    out.push(...tris);
    elementGroups.push({ name: info.name, color: info.color, indexStart: start, indexCount: out.length - start });
  }
  if (ungrouped.length > 0) {
    const start = out.length;
    out.push(...ungrouped);
    elementGroups.push({ name: null, color: null, indexStart: start, indexCount: out.length - start });
  }

  return { indices: new Uint32Array(out), elementGroups };
}

/** The boundary triangles of one volume's (or, with `tag === undefined`, every
 * volume's) own 3D cells — handles tetrahedra AND recombined hexahedra (plus
 * prisms/pyramids and any quadratic variant) via the shared `gmshElementTypes.ts`
 * table's per-cell boundary-face decomposition and corner-key shared-face dedup.
 * See {@link boundaryTriangles}. */
function extractBoundaryFaces(gmsh: GmshApi, tag: number | undefined, tagToIndex: Map<number, number>): number[] {
  const els = gmsh.model.mesh.getElements(3, tag) as GmshElementsResult;
  return boundaryTriangles(els, tagToIndex);
}

/** Groups a tag->part map into per-part tag buckets, ordered by each part's
 * first-encountered tag (stable regardless of the source map's key order). */
function groupTagsByPart(map: Map<number, PartGroupInfo>): Array<{ info: PartGroupInfo; tags: number[] }> {
  const order: PartGroupInfo[] = [];
  const buckets = new Map<PartGroupInfo, number[]>();
  for (const [tag, info] of map) {
    let bucket = buckets.get(info);
    if (!bucket) {
      bucket = [];
      buckets.set(info, bucket);
      order.push(info);
    }
    bucket.push(tag);
  }
  return order.map((info) => ({ info, tags: buckets.get(info)! }));
}

/** Total element count across all element types for `getElements(dim)`. */
function countElements(gmsh: GmshApi, dimension: MeshOptions["dimension"]): number {
  const dim = dimension === 1 ? 1 : dimension;
  const els = gmsh.model.mesh.getElements(dim) as { elementTags: number[][] };
  let total = 0;
  for (const tags of els.elementTags) total += tags.length;
  return total;
}

/** The `minSICN` quality cutoff below which an element counts as "worst" for
 * `computeQualityAndWorstElements`'s highlight overlay — the boundary between
 * the two lowest histogram buckets (`summarizeQuality`'s `[0, 0.2)` range),
 * matching the "needs improvement" range Gmsh's own optimizer log output
 * flags in practice (see `npm run mcp:smoke`'s console output, which reports
 * separate `0.00 < quality < 0.10`/`0.10 < quality < 0.20` buckets). */
export const WORST_ELEMENT_QUALITY_THRESHOLD = 0.2;

/** Hard cap on how many worst-quality elements' geometry gets built into the
 * highlight overlay, prioritizing the lowest-quality elements first — bounds
 * the postMessage payload for a large, uniformly poor-quality mesh. Never a
 * silent truncation: `WorstElementsOverlay.belowThresholdCount` reports the
 * true total regardless of whether it exceeds `shownCount`. */
export const MAX_WORST_ELEMENTS = 2000;

/**
 * Per-element quality summary over the mesh's top-dimension elements, via
 * Gmsh's own `getElementQualities` — no host-side geometry math needed —
 * PLUS, for a 3D generate only, a highlight overlay of the worst-quality
 * elements' own boundary (`WorstElementsOverlay`). Computed together, not as
 * two separate `getElements`/`getElementQualities` passes, since both need
 * the same per-element type/nodeTags/quality correlation.
 *
 * **Verified against the live WASM** (brute-force probing, the usual
 * convention — see CLAUDE.md): `gmsh.model.mesh.getElements(dim, -1)` (dim,
 * ALL entities) returns a plain OBJECT `{elementTypes, elementTags,
 * nodeTags}` — NOT the tuple/array shape some Gmsh JS API docs imply —
 * where `elementTags`/`nodeTags` are one array PER element type, so callers
 * must flatten across types (same pattern `countElements` above already
 * uses) to correlate against `getElementQualities`'s flat result.
 * `gmsh.model.mesh.getElementQualities(tags: number[], qualityType: string)`
 * accepts a plain JS number array (also confirmed accepting a typed array,
 * but a plain array is simplest) and returns `{elementsQuality: number[]}`,
 * one value per input tag IN THE SAME ORDER as the flattened `elementTags` —
 * confirmed with `"minSICN"` (Signed Inverse Condition Number, ~[-1, 1], 1 =
 * perfect, <= 0 = degenerate/inverted) on a synthetic box mesh; `"minSJ"`/
 * `"gamma"`/`"minSIGE"`/`"volume"` are also accepted quality-type strings, an
 * invalid string throws `"Unknown quality name '...'"`. One anomalous run
 * during verification returned an EMPTY `elementsQuality` array for a
 * full-size, otherwise-valid call (never reproduced across 5+ follow-up runs
 * with identical inputs) — defensively treated as "quality unavailable"
 * (`return {}`) rather than trusted blindly, matching this codebase's
 * graceful-skip convention for every other WASM-call edge case.
 *
 * Worst-element selection (`dimension === 3` only — a 2D mesh's elements ARE
 * the displayed surface already, so there's no "interior, invisible" problem
 * to solve there): every element scoring below `WORST_ELEMENT_QUALITY_THRESHOLD`,
 * sorted worst-first and capped at `MAX_WORST_ELEMENTS`. Each kept element's
 * own complete face set is triangulated via the SAME `boundaryTriangles()`
 * the main overlay's boundary uses — but fed ONLY the worst elements as
 * input, so a face shared between two adjacent bad elements dedups away (an
 * interior seam within the highlighted cluster, exactly like an interior
 * tet-tet face dedups away for the whole-mesh boundary) while a face
 * adjacent to a good (unselected) neighbor stays — the cluster's true outer
 * surface. This sidesteps the tet→boundary-face correlation problem the
 * roadmap flagged as the hard part: rather than trying to project bad
 * *interior* elements onto the mesh's outer boundary, the highlight is the
 * bad elements' own real geometry, rendered through the model via a
 * depth-test-disabled "ghost" material in the webview (`geometryBuilder.ts`'s
 * `buildWorstElementsHighlight`, mirroring `viewer.ts`'s existing Hidden
 * Lines ghost-line technique) — so it stays visible no matter how deeply
 * buried, with no clip plane or cutaway needed.
 */
export function computeQualityAndWorstElements(
  gmsh: GmshApi,
  dimension: MeshOptions["dimension"],
  tagToIndex: Map<number, number>
): { quality?: QualitySummary; worstElements?: WorstElementsOverlay } {
  const dim = dimension === 1 ? 1 : dimension;
  try {
    const els = gmsh.model.mesh.getElements(dim, -1) as GmshElementsResult & { elementTags: number[][] };
    const tags: number[] = ([] as number[]).concat(...els.elementTags);
    if (tags.length === 0) return {};
    const result = gmsh.model.mesh.getElementQualities(tags, "minSICN") as { elementsQuality: number[] };
    const values = result.elementsQuality;
    if (!Array.isArray(values) || values.length !== tags.length) return {};
    const quality = summarizeQuality(values);
    if (dimension !== 3) return { quality };

    const worst: Array<{ type: number; nodeTags: number[]; quality: number }> = [];
    let cursor = 0;
    for (let t = 0; t < els.elementTypes.length; t++) {
      const info = GMSH_ELEMENT_TYPES.get(els.elementTypes[t]);
      const count = els.elementTags[t].length;
      if (info) {
        const nodeTagsForType = els.nodeTags[t];
        for (let i = 0; i < count; i++) {
          const q = values[cursor + i];
          if (q < WORST_ELEMENT_QUALITY_THRESHOLD) {
            worst.push({
              type: els.elementTypes[t],
              nodeTags: nodeTagsForType.slice(i * info.numNodes, (i + 1) * info.numNodes),
              quality: q,
            });
          }
        }
      }
      cursor += count;
    }
    if (worst.length === 0) return { quality };

    worst.sort((a, b) => a.quality - b.quality);
    const belowThresholdCount = worst.length;
    const kept = worst.slice(0, MAX_WORST_ELEMENTS);

    // Re-bucket the kept elements back into `boundaryTriangles`'s per-type
    // input shape (one flat nodeTags run per type) so its existing
    // interior-face dedup applies across the whole kept subset, not just
    // within a single type.
    const byType = new Map<number, number[]>();
    for (const el of kept) byType.set(el.type, [...(byType.get(el.type) ?? []), ...el.nodeTags]);
    const bucketed: GmshElementsResult = { elementTypes: [...byType.keys()], nodeTags: [...byType.values()] };
    const indices = new Uint32Array(boundaryTriangles(bucketed, tagToIndex));

    return {
      quality,
      worstElements: {
        indices,
        threshold: WORST_ELEMENT_QUALITY_THRESHOLD,
        shownCount: kept.length,
        belowThresholdCount,
      },
    };
  } catch {
    return {};
  }
}
