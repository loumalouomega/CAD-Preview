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
import { gmshShapeOptions, type MeshOptions } from "./meshOptions";
import { summarizeQuality, type QualitySummary } from "./meshQuality";
import type { Part, MeshElementGroup } from "./protocol";
import { applyPartsToGmshModel, type PartGroupInfo, type PartGroupMaps } from "./gmshPartsMap";
import { meshExportFormat, type MeshExportFormatId } from "./meshExportFormats";
import { writeMdpa, type MdpaMesh, type MdpaMode, type MdpaNode, type MdpaCell, type MdpaGroup } from "./mdpaWriter";
import {
  GMSH_ELEMENT_TYPES,
  MDPA_KIND_INFO,
  surfaceTriangles,
  boundaryTriangles,
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
    }).then((gmsh) => {
      gmsh.initialize();
      return gmsh;
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
  return /out of bounds|abort|RuntimeError|unreachable|null function|table index/i.test(message);
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
   * against the live WASM; see `computeMeshQuality`'s doc comment). */
  quality?: QualitySummary;
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
  gmsh.option.setNumber("Mesh.Algorithm3D", options.algorithm3D);
  gmsh.option.setNumber("Mesh.ElementOrder", options.elementOrder);
  // Element geometry (simplex vs. quad/hex subdivision). Both option values are
  // set every time — the gmsh singleton persists options across `clear()`, so a
  // prior run's shape must be overwritten, not left implicit. See
  // `gmshShapeOptions` for the dimension-dependent, WASM-verified recipe.
  const shape = gmshShapeOptions(options.elementShape, options.dimension);
  gmsh.option.setNumber("Mesh.RecombineAll", shape.recombineAll);
  gmsh.option.setNumber("Mesh.SubdivisionAlgorithm", shape.subdivisionAlgorithm);
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
    const loaded = await loadGeometryAndApplyOptions(extensionPath, gmsh, input, options, parts);
    tmpPath = loaded.tmpPath;

    runMeshGenerate(gmsh, options);

    const nodes = gmsh.model.mesh.getNodes() as { nodeTags: number[]; coord: number[] };
    const { positions, tagToIndex } = buildPositions(nodes);

    const { indices, elementGroups } = buildIndices(gmsh, options.dimension, tagToIndex, loaded.groupMaps);
    const edges = buildEdges(gmsh, options.dimension, tagToIndex);

    gmsh.write(outPath);
    const mshText = gmsh.FS.readFile(outPath, { encoding: "utf8" }) as string;

    return {
      positions,
      indices,
      edges,
      elementGroups,
      nodeCount: nodes.nodeTags.length,
      elementCount: countElements(gmsh, options.dimension),
      mshText,
      quality: computeMeshQuality(gmsh, options.dimension),
    };
  } finally {
    if (tmpPath) {
      try { gmsh.FS.unlink(tmpPath); } catch { /* ignore */ }
    }
    try { gmsh.FS.unlink(outPath); } catch { /* ignore */ }
  }
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
 */
export async function exportGeoUnrolled(
  extensionPath: string,
  input: MeshGenerationInput,
  options: MeshOptions,
  parts: Part[] = []
): Promise<GeoExportResult> {
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
    const loaded = await loadGeometryAndApplyOptions(extensionPath, gmsh, input, options, parts);
    tmpPath = loaded.tmpPath;

    runMeshGenerate(gmsh, options);
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
    const loaded = await loadGeometryAndApplyOptions(extensionPath, gmsh, input, options, parts);
    tmpPath = loaded.tmpPath;

    runMeshGenerate(gmsh, options);
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
 *   each volume's own boundary. See {@link boundaryTriangles}.
 */
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

function buildIndices(
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
  if (!groupMaps || groupMaps.volumeTagToPart.size === 0) {
    const boundaryTris = extractBoundaryFaces(gmsh, undefined, tagToIndex);
    return {
      indices: new Uint32Array(boundaryTris),
      elementGroups:
        boundaryTris.length > 0 ? [{ name: null, color: null, indexStart: 0, indexCount: boundaryTris.length }] : [],
    };
  }

  const out: number[] = [];
  const elementGroups: MeshElementGroup[] = [];
  const claimedTags = new Set<number>();
  for (const { info, tags } of groupTagsByPart(groupMaps.volumeTagToPart)) {
    const start = out.length;
    for (const tag of tags) {
      claimedTags.add(tag);
      out.push(...extractBoundaryFaces(gmsh, tag, tagToIndex));
    }
    if (out.length > start) {
      elementGroups.push({ name: info.name, color: info.color, indexStart: start, indexCount: out.length - start });
    }
  }

  const allVolumes = (gmsh.model.getEntities(3).dimTags as number[]) ?? [];
  const start = out.length;
  for (let i = 0; i < allVolumes.length; i += 2) {
    const tag = allVolumes[i + 1];
    if (claimedTags.has(tag)) continue;
    out.push(...extractBoundaryFaces(gmsh, tag, tagToIndex));
  }
  if (out.length > start) {
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

/**
 * Per-element quality summary over the mesh's top-dimension elements, via
 * Gmsh's own `getElementQualities` — no host-side geometry math needed.
 *
 * **Verified against the live WASM** (brute-force probing, the usual
 * convention — see CLAUDE.md): `gmsh.model.mesh.getElements(dim, -1)` (dim,
 * ALL entities) returns a plain OBJECT `{elementTypes, elementTags,
 * nodeTags}` — NOT the tuple/array shape some Gmsh JS API docs imply —
 * where `elementTags` is one array PER element type, so callers must flatten
 * across types (same pattern `countElements` above already uses).
 * `gmsh.model.mesh.getElementQualities(tags: number[], qualityType: string)`
 * accepts a plain JS number array (also confirmed accepting a typed array,
 * but a plain array is simplest) and returns `{elementsQuality: number[]}`,
 * one value per input tag IN THE SAME ORDER — confirmed with `"minSICN"`
 * (Signed Inverse Condition Number, ~[-1, 1], 1 = perfect, <= 0 = degenerate/
 * inverted) on a synthetic box mesh; `"minSJ"`/`"gamma"`/`"minSIGE"`/
 * `"volume"` are also accepted quality-type strings, an invalid string
 * throws `"Unknown quality name '...'"`. One anomalous run during
 * verification returned an EMPTY `elementsQuality` array for a full-size,
 * otherwise-valid call (never reproduced across 5+ follow-up runs with
 * identical inputs) — defensively treated as "quality unavailable" (`return
 * undefined`) rather than trusted blindly, matching this codebase's
 * graceful-skip convention for every other WASM-call edge case.
 */
function computeMeshQuality(gmsh: GmshApi, dimension: MeshOptions["dimension"]): QualitySummary | undefined {
  const dim = dimension === 1 ? 1 : dimension;
  try {
    const els = gmsh.model.mesh.getElements(dim, -1) as { elementTags: number[][] };
    const tags: number[] = ([] as number[]).concat(...els.elementTags);
    if (tags.length === 0) return undefined;
    const result = gmsh.model.mesh.getElementQualities(tags, "minSICN") as { elementsQuality: number[] };
    const values = result.elementsQuality;
    if (!Array.isArray(values) || values.length !== tags.length) return undefined;
    return summarizeQuality(values);
  } catch {
    return undefined;
  }
}
