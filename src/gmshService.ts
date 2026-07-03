import * as fs from "fs";
import * as path from "path";
// The gmsh-wasm package's default export is an async emscripten-style factory,
// mirroring opencascade.js's raw factory shape (see occtService.ts) — pass the
// wasm binary explicitly rather than letting it try to fetch() a filesystem path.
import initialize from "@loumalouomega/gmsh-wasm";
import type { MeshOptions } from "./meshOptions";
import type { Part, MeshElementGroup } from "./protocol";
import { applyPartsToGmshModel, type PartGroupInfo, type PartGroupMaps } from "./gmshPartsMap";
import { meshExportFormat, type MeshExportFormatId } from "./meshExportFormats";
import { writeMdpa, type MdpaMesh, type MdpaMode, type MdpaNode, type MdpaTet, type MdpaTriangle, type MdpaGroup } from "./mdpaWriter";

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
    _gmshPromise = initialize({ wasmBinary }).then((gmsh) => {
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

export type MeshGenerationInput =
  | { kind: "brep"; stepBytes: Uint8Array }
  | { kind: "stl"; stlBytes: Uint8Array };

export interface MeshResult {
  positions: Float32Array;
  indices: Uint32Array;
  elementGroups: MeshElementGroup[];
  nodeCount: number;
  elementCount: number;
  mshText: string;
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

    gmsh.model.mesh.generate(options.dimension);

    const nodes = gmsh.model.mesh.getNodes() as { nodeTags: number[]; coord: number[] };
    const { positions, tagToIndex } = buildPositions(nodes);

    const { indices, elementGroups } = buildIndices(gmsh, options.dimension, tagToIndex, loaded.groupMaps);

    gmsh.write(outPath);
    const mshText = gmsh.FS.readFile(outPath, { encoding: "utf8" }) as string;

    return {
      positions,
      indices,
      elementGroups,
      nodeCount: nodes.nodeTags.length,
      elementCount: countElements(gmsh, options.dimension),
      mshText,
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

    gmsh.model.mesh.generate(options.dimension);
    gmsh.write(outPath);
    return gmsh.FS.readFile(outPath, { encoding: "utf8" }) as string;
  } finally {
    if (tmpPath) {
      try { gmsh.FS.unlink(tmpPath); } catch { /* ignore */ }
    }
    try { gmsh.FS.unlink(outPath); } catch { /* ignore */ }
  }
}

const MDPA_TET_TYPE = 4; // 4-node tetrahedron (same element-type id used throughout this file)
const MDPA_TRI_TYPE = 2; // 3-node triangle

/**
 * Meshes `input` per `options`/`parts` and hand-serializes the result as
 * Kratos MDPA text via `mdpaWriter.ts`'s pure `writeMdpa()`. Unlike every
 * other export format in this file, MDPA has no `gmsh.write()` support at
 * all — there is no MEMFS write/read-back round trip here; `extractMdpaMesh`
 * reads nodes/elements directly off the live model instead.
 */
export async function exportMdpa(
  extensionPath: string,
  input: MeshGenerationInput,
  options: MeshOptions,
  parts: Part[],
  mode: MdpaMode
): Promise<string> {
  if (options.elementOrder !== 1) {
    throw new Error(
      'Kratos MDPA export only supports linear (order 1) elements — Element3D4N/Tetrahedra3D4 and ' +
        'SurfaceCondition3D3N/Triangle3D3 are both 1st-order simplices. Set "Element order" to Linear ' +
        "in the FE Mesh panel and export again."
    );
  }

  const gmsh = await getGmsh(extensionPath);
  let tmpPath: string | null = null;
  try {
    const loaded = await loadGeometryAndApplyOptions(extensionPath, gmsh, input, options, parts);
    tmpPath = loaded.tmpPath;

    gmsh.model.mesh.generate(options.dimension);
    const mesh = extractMdpaMesh(gmsh, loaded.groupMaps);
    return writeMdpa(mesh, mode);
  } finally {
    if (tmpPath) {
      try { gmsh.FS.unlink(tmpPath); } catch { /* ignore */ }
    }
  }
}

/**
 * Pulls the live gmsh model's linear tet/triangle mesh, plus `groupMaps`'
 * part groupings, into the plain gmsh-free `MdpaMesh` shape `writeMdpa`
 * consumes. Must run after `mesh.generate()`. Loops per-entity-tag (like
 * `extractBoundaryFaces`/`appendTriangles2D` above) rather than one
 * whole-model `getElements(dim)` call, since each cell's owning
 * volume/surface tag is needed to resolve which part it belongs to. Throws
 * if any 3D element type other than the 4-node tet, or 2D type other than
 * the 3-node triangle, is found — a defensive backstop behind `exportMdpa`'s
 * `elementOrder` pre-flight check (that check alone doesn't cover every
 * conceivable non-simplex element a future option might enable).
 */
function extractMdpaMesh(gmsh: GmshApi, groupMaps: PartGroupMaps | null): MdpaMesh {
  const nodesRaw = gmsh.model.mesh.getNodes() as { nodeTags: number[]; coord: number[] };
  const nodes: MdpaNode[] = nodesRaw.nodeTags.map((tag, i) => ({
    tag,
    x: nodesRaw.coord[i * 3],
    y: nodesRaw.coord[i * 3 + 1],
    z: nodesRaw.coord[i * 3 + 2],
  }));

  const tets: MdpaTet[] = [];
  const tetVolumeTag: number[] = [];
  const volumeTags = (gmsh.model.getEntities(3).dimTags as number[]) ?? [];
  for (let i = 0; i < volumeTags.length; i += 2) {
    const tag = volumeTags[i + 1];
    const els = gmsh.model.mesh.getElements(3, tag) as { elementTypes: number[]; nodeTags: number[][] };
    for (let t = 0; t < els.elementTypes.length; t++) {
      const type = els.elementTypes[t];
      if (type !== MDPA_TET_TYPE) {
        throw new Error(
          `Kratos MDPA export only supports 4-node tetrahedra, but volume ${tag} contains an ` +
            `unsupported 3D element type (${type}). Adjust the mesh options and try again.`
        );
      }
      const tagsForType = els.nodeTags[t];
      for (let n = 0; n < tagsForType.length; n += 4) {
        tets.push({ nodeTags: [tagsForType[n], tagsForType[n + 1], tagsForType[n + 2], tagsForType[n + 3]] });
        tetVolumeTag.push(tag);
      }
    }
  }

  const triangles: MdpaTriangle[] = [];
  const triSurfaceTag: number[] = [];
  const surfaceTags = (gmsh.model.getEntities(2).dimTags as number[]) ?? [];
  for (let i = 0; i < surfaceTags.length; i += 2) {
    const tag = surfaceTags[i + 1];
    const els = gmsh.model.mesh.getElements(2, tag) as { elementTypes: number[]; nodeTags: number[][] };
    for (let t = 0; t < els.elementTypes.length; t++) {
      const type = els.elementTypes[t];
      if (type !== MDPA_TRI_TYPE) {
        throw new Error(
          `Kratos MDPA export only supports 3-node triangles, but surface ${tag} contains an ` +
            `unsupported 2D element type (${type}). Adjust the mesh options and try again.`
        );
      }
      const tagsForType = els.nodeTags[t];
      for (let n = 0; n < tagsForType.length; n += 3) {
        triangles.push({ nodeTags: [tagsForType[n], tagsForType[n + 1], tagsForType[n + 2]] });
        triSurfaceTag.push(tag);
      }
    }
  }

  const groups: MdpaGroup[] = [];
  if (groupMaps) {
    for (const bucket of groupPartsAcrossDims(groupMaps)) {
      const volumeTagSet = new Set(bucket.volumeTags);
      const surfaceTagSet = new Set(bucket.surfaceTags);
      const tetIndices: number[] = [];
      tetVolumeTag.forEach((vTag, idx) => {
        if (volumeTagSet.has(vTag)) tetIndices.push(idx);
      });
      const triangleIndices: number[] = [];
      triSurfaceTag.forEach((sTag, idx) => {
        if (surfaceTagSet.has(sTag)) triangleIndices.push(idx);
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

      groups.push({ name: bucket.info.name, tetIndices, triangleIndices, extraNodeTags });
    }
  }

  return { nodes, tets, triangles, groups };
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
 * - `2`: the generated type-2 (3-node triangle) elements are already the
 *   surface triangulation — remap their node tags to compacted indices
 *   directly, per surface entity when grouping.
 * - `3`: derive the boundary surface from the volume mesh by enumerating each
 *   tetrahedron's 4 triangular faces (by node tags), keying each face by its
 *   3 node tags *sorted* (an order-independent identity so a face shared by
 *   two adjacent tets collides to the same key regardless of which tet's local
 *   winding produced it), and keeping only faces that occur in exactly one
 *   tet — a face shared by two tets is interior and both copies are dropped.
 *   The kept triangle's *unsorted* (original) winding from its owning tet's
 *   local face definition is preserved in the output so normals stay outward.
 *   When grouping, this runs per-volume (`getElements(3, tag)` scoped to one
 *   volume's own tets) — correct even for two touching part-volumes, since
 *   Gmsh tags each tet by its single owning volume regardless of geometric
 *   adjacency, so a shared face is independently each volume's own boundary.
 */
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
 * entity's) type-2 triangle node tags, remapped via `tagToIndex`, onto `out`. */
function appendTriangles2D(gmsh: GmshApi, tag: number | undefined, tagToIndex: Map<number, number>, out: number[]): void {
  const els = gmsh.model.mesh.getElements(2, tag) as { elementTypes: number[]; nodeTags: number[][] };
  const triType = els.elementTypes.indexOf(2); // 2 == 3-node triangle
  if (triType < 0) return;
  const triNodeTags = els.nodeTags[triType];
  for (let i = 0; i < triNodeTags.length; i++) {
    out.push(tagToIndex.get(triNodeTags[i]) ?? 0);
  }
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

/** The boundary triangles of one volume's (or, with `tag === undefined`,
 * every volume's) own tetrahedra — see {@link buildIndices}'s doc comment for
 * the shared-face dedup algorithm. */
function extractBoundaryFaces(gmsh: GmshApi, tag: number | undefined, tagToIndex: Map<number, number>): number[] {
  const els = gmsh.model.mesh.getElements(3, tag) as { elementTypes: number[]; nodeTags: number[][] };
  const tetType = els.elementTypes.indexOf(4); // 4 == 4-node tetrahedron
  if (tetType < 0) return [];
  const tetNodeTags = els.nodeTags[tetType];

  // The 4 triangular faces of a tet [a, b, c, d], each face's local winding
  // chosen so that, for a positively-oriented tet, all 4 faces' normals point
  // outward (standard tet face enumeration).
  const FACES = [
    [0, 1, 2],
    [0, 1, 3],
    [1, 2, 3],
    [0, 2, 3],
  ];

  // key (sorted tags, order-independent) -> { winding (original tags), seenCount }
  const faceMap = new Map<string, { winding: [number, number, number]; count: number }>();

  const numTets = tetNodeTags.length / 4;
  for (let t = 0; t < numTets; t++) {
    const base = t * 4;
    const tet = [tetNodeTags[base], tetNodeTags[base + 1], tetNodeTags[base + 2], tetNodeTags[base + 3]];
    for (const [i0, i1, i2] of FACES) {
      const a = tet[i0];
      const b = tet[i1];
      const c = tet[i2];
      const sorted = [a, b, c].sort((x, y) => x - y);
      const key = `${sorted[0]}_${sorted[1]}_${sorted[2]}`;
      const existing = faceMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        faceMap.set(key, { winding: [a, b, c], count: 1 });
      }
    }
  }

  const boundaryTris: number[] = [];
  for (const { winding, count } of faceMap.values()) {
    if (count === 1) {
      boundaryTris.push(
        tagToIndex.get(winding[0]) ?? 0,
        tagToIndex.get(winding[1]) ?? 0,
        tagToIndex.get(winding[2]) ?? 0
      );
    }
  }
  return boundaryTris;
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
