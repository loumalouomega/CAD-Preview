// meshio++ WASM module (`@meshioplusplus/wasm`) — the third host-side WASM
// singleton alongside OCCT (occtService.ts) and Gmsh (gmshService.ts), used to
// import mesh-only formats (VTK/MED/CGNS/Exodus/XDMF/MDPA/OpenFOAM) as
// viewable documents and to export generated FE meshes to formats Gmsh's own
// writers cannot produce (MED, CGNS).
//
// UNLIKE gmsh-wasm/opencascade.js, this package is loaded with a DYNAMIC
// `await import(...)`, not a static top-of-file `import` — verified against
// the live package (`node_modules/@meshioplusplus/wasm/package.json`):
// `"type": "module"`, `"main": "./src/index.mjs"`, no `"exports"` map and no
// `require` condition at all. gmsh-wasm's static-import-stays-external
// pattern works there specifically because it's DUAL CJS/ESM (a real
// `dist/gmsh-core.cjs` for Node's "require" condition to resolve); this
// package has no such condition, so `require("@meshioplusplus/wasm")` in this
// CJS-bundled extension host throws `ERR_REQUIRE_ESM`. A dynamic `import()`
// of an external module is left as a literal runtime `import()` by esbuild's
// "cjs" output format, and Node's CJS modules are allowed to `await
// import(...)` an ESM package at runtime — so this is required, not a stylistic
// choice. Must stay `external` in esbuild.mjs for the same two reasons
// gmsh-wasm must (see that file's comment): nothing statically imports its
// `.wasm`, and its threaded variant's Emscripten pthread pool has the exact
// same eager-worker-spawn risk gmsh's does if ever bundled.
//
// Loaded with `{ variant: "seq" }` explicitly — NEVER "auto" (the default).
// `resolveVariant()` in the package's own wrapper picks the threaded ("mt")
// build whenever `typeof crossOriginIsolated === "undefined"`, which is
// ALWAYS true under Node — so "auto" always picks the pthread build here,
// eagerly spawning ~8 `worker_threads.Worker`s at load, structurally the same
// hang/crash risk already discovered and fixed once for gmsh's own worker
// pool (see gmshService.ts's comment). Forcing "seq" avoids that risk
// entirely; the sequential build is plenty fast for the file sizes this
// feature deals with.
//
// Console output goes through `console.log`/`console.error` by default
// (confirmed against the live package's built glue,
// `dist/meshioplusplus_wasm.mjs`) — like OCCT, unlike gmsh 0.2.0's raw-fd
// writes — so `mcpServer.ts`'s existing top-of-file stdout rebinding already
// covers it; no new suppression code is needed here.
//
// Re-confirmed against the 10.9.0 glue on the dependency bump: still exactly
// one console.log + one console.error, zero raw fd writes.

import * as fs from "node:fs";
import * as path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MeshioApi = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _meshioPromise: Promise<MeshioApi> | null = null;

/**
 * Returns the meshio++ WASM module, initializing it lazily on first call.
 *
 * A REJECTED init is deliberately NOT memoized — the whole async IIFE is
 * wrapped in a `.catch` that un-caches `_meshioPromise` before rethrowing,
 * same fix `getOcct`/`getGmsh` need. Without it, even a transient failure
 * (e.g. a momentary dynamic-`import()` resolution error) would poison every
 * later `getMeshio()` call in this process forever.
 */
export function getMeshio(): Promise<MeshioApi> {
  if (!_meshioPromise) {
    _meshioPromise = (async () => {
      const { loadMeshioPlusPlus } = await import("@meshioplusplus/wasm");
      return loadMeshioPlusPlus({}, { variant: "seq" });
    })().catch((err) => {
      _meshioPromise = null;
      throw err;
    });
  }
  return _meshioPromise;
}

/** Resets the singleton — called by `wrapMeshioFault` after a WASM abort, and
 * from tests. */
export function resetMeshio(): void {
  _meshioPromise = null;
}

/**
 * Emscripten aborts surface as opaque `RuntimeError`s — same vocabulary
 * `gmshService.ts`'s `isWasmAbort` / `occtService.ts`'s `isOcctWasmAbort`
 * recognize, kept as its own local copy per this codebase's convention of
 * each kernel's fault handling staying self-contained in its own service file.
 */
function isMeshioWasmAbort(message: string): boolean {
  return /out of bounds|abort|RuntimeError|unreachable|null function|table index/i.test(message);
}

/**
 * Resets the singleton if `err` looks like a WASM abort, and reports whether
 * it did — used both by `wrapMeshioFault` (functions that rethrow) and
 * directly by the three functions in this file that are documented to
 * degrade gracefully instead of throwing (`readMeshioMetadata`,
 * `convertToStlBoundaryWithRegions`, `readMeshioFieldValues`). Those
 * functions' own "never throws" contract must NOT change — but silently
 * swallowing an abort with no reset would be worse than a thrown error: the
 * singleton stays corrupt, and every later call in the same window would
 * ALSO silently degrade, with no user-visible sign anything is wrong.
 */
function resetMeshioIfAbort(err: unknown): boolean {
  const raw = ((err as Error)?.message ?? String(err)).trim();
  if (!isMeshioWasmAbort(raw)) return false;
  resetMeshio();
  return true;
}

/**
 * Every meshio++-touching entry point that rethrows wraps its body's `catch`
 * with this — same pattern as `occtService.ts`'s `wrapOcctFault`. A WASM
 * abort mid-operation leaves the module instance permanently corrupt, so this
 * resets the singleton to force a fresh one on the next call instead of
 * leaving every later meshio++ call in the same window failing with the same
 * opaque message. A non-abort error passes through unchanged.
 */
function wrapMeshioFault(err: unknown): Error {
  if (!resetMeshioIfAbort(err)) return err instanceof Error ? err : new Error(String(err));
  const raw = ((err as Error)?.message ?? String(err)).trim();
  return new Error(`meshio++ crashed (${raw || "WASM abort"}) — the kernel has been reset; try the operation again.`);
}

/** One sibling file a multi-file format's reader needs beside the primary —
 * see `meshioCompanions.ts` for how a caller discovers which ones. */
export interface MeshioCompanion {
  /** The sibling's own basename (e.g. `"model.h5"`, `"mesh.ele"`) — the
   * EXACT name the primary file's reader will look it up by, whether that's
   * a static stem convention (tetgen/triangle/ensight) or the primary
   * file's own content (XDMF's `<DataItem>` references). */
  name: string;
  bytes: Uint8Array;
}

/**
 * Stages `sourceBytes` (and every companion) into meshio++'s MEMFS for one
 * call, and returns the primary's path plus the full list of paths written
 * (for `unstageMeshioSource` to clean up in `finally`).
 *
 * **Fixes a real, verified import defect**: every entry point below used to
 * write ONLY the primary's bytes, under a synthetic renamed path
 * (`/in.<meshioFormat>`) — so a multi-file source (most concretely, the
 * `.xdmf` + `.h5` pair `exportViaMeshio()` itself produces) could never be
 * read back. Confirmed live against the WASM: reading a written `.xdmf`
 * with its `.h5` sibling deleted throws `HDF5: could not open file
 * /model.h5` — HDF5 companion resolution is relative to the READING file's
 * own MEMFS directory, and (separately confirmed) so is a stem-convention
 * reader's sibling lookup (tetgen `.node`→`.ele`, etc.). A flat MEMFS root
 * is that directory for every file staged here, so no subdirectory
 * juggling is needed for either convention — the primary keeps its
 * synthetic path when `sourceName` is omitted (preserving every existing
 * caller's behavior byte-for-byte) or its real basename when given one
 * (required for a stem-convention format, whose reader discovers its
 * sibling by swapping the PRIMARY's own extension); every companion is
 * always written under its own real/referenced basename, never renamed.
 *
 * **Fixes ONLY the missing-companion failure, not every XDMF re-import** —
 * a SEPARATE, pre-existing meshio++ 10.14.0 bug means an XDMF whose mesh
 * mixes cell types (points/lines/triangles/tets — exactly what this
 * codebase's own `generate_mesh` always produces, since `Mesh.SaveAll=1` is
 * forced unconditionally) still fails to re-import, with a DIFFERENT error
 * (`"XDMF: unknown mixed topology index"`) than the one this function
 * fixes. Verified these are two independent, ordered failures, not one
 * masking the other: the same Mixed-topology fixture with its `.h5` deleted
 * fails with the ORIGINAL `"HDF5: could not open file"` error instead — the
 * companion lookup this function performs runs first and succeeds; only
 * then does meshio++'s own topology parsing fail. See
 * `doc/gmsh-integration.md`'s "The meshio++ bridge" section.
 */
function stageMeshioSource(
  m: MeshioApi,
  sourceBytes: Uint8Array,
  meshioFormat: string,
  sourceName: string | undefined,
  companions: readonly MeshioCompanion[] | undefined
): { primaryPath: string; allPaths: string[] } {
  const primaryPath = `/${sourceName || `in.${meshioFormat}`}`;
  const allPaths = [primaryPath];
  m.FS.writeFile(primaryPath, sourceBytes);
  for (const companion of companions ?? []) {
    const path = `/${companion.name}`;
    m.FS.writeFile(path, companion.bytes);
    allPaths.push(path);
  }
  return { primaryPath, allPaths };
}

/** Unlinks every MEMFS path `stageMeshioSource` wrote, plus any extra
 * output/scratch paths a caller also wants cleaned up — each unlink is
 * independently best-effort (a path that was never written, e.g. because an
 * earlier step threw, is silently skipped), matching every other
 * `try{unlink}catch{}` cleanup already in this file. */
function unstageMeshioSource(m: MeshioApi, paths: readonly string[], extra: readonly string[] = []): void {
  for (const path of [...paths, ...extra]) {
    try { m.FS.unlink(path); } catch { /* ignore */ }
  }
}

/**
 * Converts `sourceBytes` (a `meshioFormat`-format file) to an ASCII STL
 * boundary surface — the "funnel every meshio-only import through STL"
 * design that lets a meshio-imported document inherit the entire existing
 * mesh (Three.js) pipeline for free: facet splitting, parts, every
 * mesh-legal edit op, export, mass properties, measurement. Uses
 * `convertSurface` (not `readMesh` → build STL by hand), which stays inside
 * meshio++'s C++ core and auto-extracts the boundary skin of a volume mesh —
 * confirmed against the live WASM on a hand-built tetrahedron: `convert`ing
 * to MED/CGNS/Exodus/XDMF and then `convertSurface`-ing each back to STL all
 * produced the same correct 4-facet boundary (one per tet face). Trades away
 * format-native richness (regions, point/cell scalar data, multi-material
 * grouping) for a small, low-risk v1 — an explicit scope decision, not an
 * oversight; see CLAUDE.md's "meshio++ integration" section.
 *
 * `sourceName`/`companions` are optional, additive parameters (every
 * pre-existing call site omitting them keeps today's exact behavior —
 * a synthetic `/in.<meshioFormat>` path, no companions) — see
 * `stageMeshioSource`'s doc comment for why they exist and what they fix.
 */
export async function convertToStlBoundary(
  sourceBytes: Uint8Array,
  meshioFormat: string,
  sourceName?: string,
  companions?: readonly MeshioCompanion[]
): Promise<Uint8Array> {
  const m = await getMeshio();
  const { primaryPath, allPaths } = stageMeshioSource(m, sourceBytes, meshioFormat, sourceName, companions);
  const outPath = "/out.stl";
  try {
    m.convertSurface(primaryPath, outPath, { inFormat: meshioFormat, outFormat: "stl" });
    return m.FS.readFile(outPath);
  } catch (err) {
    throw wrapMeshioFault(err);
  } finally {
    unstageMeshioSource(m, allPaths, [outPath]);
  }
}

export interface MeshioRegionSummary {
  name: string;
  /** `"point"` | `"cell"` | `"side"` — see `@meshioplusplus/wasm`'s `Region.kind`. */
  kind: string;
  numEntries: number;
}

export interface MeshioMetadataSummary {
  regions: MeshioRegionSummary[];
  pointDataNames: string[];
  cellDataNames: string[];
  fieldDataNames: string[];
}

/**
 * Cheap, read-only visibility into what a meshio-only source file ACTUALLY
 * declares — region names (gmsh physical groups, Abaqus NSET/ELSET/SURFACE,
 * Exodus blocks/sets, MED families, Kratos SubModelParts) and named point/
 * cell/field data arrays — via `readMetadata()`, which `@meshioplusplus/wasm`
 * documents as loading a file's *shape* without its heavy geometry/data
 * arrays. **Deliberately informational only, not (yet) wired into the import
 * pipeline**: `convertToStlBoundary()` above still funnels every meshio-only
 * import through a plain STL boundary conversion with none of this attached
 * — see CLAUDE.md's "meshio++ integration" section for why turning this into
 * auto-created Parts is real, larger future work (the mechanism —
 * `extractSurface(mesh, true)`'s `cell_data["surface:parent_cell"]`
 * provenance array, correlated against each `kind: "cell"` region's
 * `entries` — was verified feasible against a synthetic hand-built mesh, but
 * needs real diverse-format fixtures to validate a full triangle-to-region
 * correlation before it would be safe to ship). Never throws: a malformed or
 * genuinely unreadable file degrades to every field empty, since this is
 * pure supplementary information and must never block or fail an import
 * `convertToStlBoundary` might otherwise handle fine.
 *
 * `sourceName`/`companions` are the same optional, additive pair every
 * other entry point in this file now takes — see `stageMeshioSource`.
 */
export async function readMeshioMetadata(
  sourceBytes: Uint8Array,
  meshioFormat: string,
  sourceName?: string,
  companions?: readonly MeshioCompanion[]
): Promise<MeshioMetadataSummary> {
  const empty: MeshioMetadataSummary = { regions: [], pointDataNames: [], cellDataNames: [], fieldDataNames: [] };
  try {
    const m = await getMeshio();
    const { primaryPath, allPaths } = stageMeshioSource(m, sourceBytes, meshioFormat, sourceName, companions);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const meta = m.readMetadata(primaryPath, meshioFormat) as any;
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        regions: (meta.regions ?? []).map((r: any) => ({ name: r.name, kind: r.kind, numEntries: r.numEntries })),
        pointDataNames: meta.pointDataNames ?? [],
        cellDataNames: meta.cellDataNames ?? [],
        fieldDataNames: meta.fieldDataNames ?? [],
      };
    } finally {
      unstageMeshioSource(m, allPaths);
    }
  } catch (err) {
    resetMeshioIfAbort(err);
    return empty;
  }
}

export interface MeshioRegionAssignment {
  /** Names of every `kind: "cell"` region that correlated to ≥1 boundary triangle. */
  regionNames: string[];
  /** One entry per triangle in the STL bytes returned alongside this (same
   * order), an index into {@link regionNames}, or `-1` if that triangle's
   * parent cell isn't covered by any `kind: "cell"` region. */
  triangleRegion: Int32Array;
}

export interface MeshioBoundaryResult {
  stlBytes: Uint8Array;
  /** Present only when the source declares ≥1 `kind: "cell"` region AND the
   * extracted boundary is pure triangles/quads (see
   * {@link convertToStlBoundaryWithRegions}'s doc comment for the full gate). */
  regions?: MeshioRegionAssignment;
}

/**
 * Like {@link convertToStlBoundary}, but additionally correlates the file's
 * declared `kind: "cell"` regions to the boundary triangles it returns — the
 * mechanism the roadmap's "auto-converting regions into Parts" item
 * identified but left unshipped, now verified against the live WASM (not
 * just a synthetic mesh): `readMesh()` a full `Mesh` (not the cheap
 * `readMetadata()`), `extractSurface(mesh, recordParentIds=true)`, and
 * read `cell_data["surface:parent_cell"]` — confirmed via a real probe
 * against `examples/MED/two-material-tets.med` (this repo's own permanent
 * fixture) to give each boundary triangle the **global, block-major** index
 * of its original parent cell, exactly matching what `Region.entries` (for
 * `kind: "cell"`) indexes — so membership is a plain `Set.has()` test, no
 * block-offset bookkeeping needed.
 *
 * **Builds the STL directly from `extractSurface`'s own boundary mesh**
 * (its `points`/`cells`), NOT from `convertSurface`'s separate file-to-file
 * output — even though a probe on the same fixture showed the two produce
 * byte-identical triangle geometry/order (meshio++'s C++ core very likely
 * shares one boundary-extraction routine under both entry points), relying
 * on that incidental match across two independently-callable APIs is
 * exactly the risk CLAUDE.md's "meshio++ integration" section already
 * flagged. Building STL bytes from the SAME mesh object the correlation was
 * computed against makes the geometry/region-index correspondence correct
 * by construction, not by assumption.
 *
 * **Gated to the tetrahedral/triangular case only, by design.** If the
 * extracted boundary contains anything other than plain `"triangle"`
 * (3-node) cell blocks — e.g. quads from a hexahedral volume, or a
 * higher-order block — this falls back to the plain, already-verified
 * {@link convertToStlBoundary} with no region correlation at all (`regions`
 * omitted), rather than risk a subtly-wrong triangulation for cell types no
 * fixture has validated yet (see CLAUDE.md: "needs real diverse-format
 * fixtures... before it would be safe to ship" — the triangle-only case is
 * what got validated). Same fallback for: no `kind: "cell"` regions at all,
 * `readMesh`/`extractSurface` throwing, or the correlation coming back
 * empty. Never throws — errors degrade to the plain STL boundary, since a
 * failed region correlation must never block an import `convertToStlBoundary`
 * alone would otherwise handle fine.
 *
 * `sourceName`/`companions` are the same optional, additive pair every
 * other entry point in this file now takes — see `stageMeshioSource`.
 */
export async function convertToStlBoundaryWithRegions(
  sourceBytes: Uint8Array,
  meshioFormat: string,
  sourceName?: string,
  companions?: readonly MeshioCompanion[]
): Promise<MeshioBoundaryResult> {
  const fallback = async (): Promise<MeshioBoundaryResult> => ({
    stlBytes: await convertToStlBoundary(sourceBytes, meshioFormat, sourceName, companions),
  });
  try {
    const m = await getMeshio();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mesh: any;
    const { primaryPath, allPaths } = stageMeshioSource(m, sourceBytes, meshioFormat, sourceName, companions);
    try {
      mesh = m.readMesh(primaryPath, meshioFormat);
    } finally {
      unstageMeshioSource(m, allPaths);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cellRegions = ((mesh.regions ?? []) as any[]).filter((r) => r.kind === "cell");
    if (cellRegions.length === 0) return fallback();

    const boundary = m.extractSurface(mesh, true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocks = boundary.cells as any[];
    if (blocks.length === 0 || blocks.some((b) => b.type !== "triangle" || b.nodesPerCell !== 3)) return fallback();
    const parentCellBlocks: Float64Array[] | undefined = boundary.cell_data?.["surface:parent_cell"];
    if (!parentCellBlocks) return fallback();

    const regionSets = cellRegions.map((r) => ({
      name: r.name as string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ids: new Set<number>(Array.from(r.entries as any as Iterable<number>)),
    }));
    const regionNames = regionSets.map((r) => r.name);

    const pts: Float64Array = boundary.points;
    const dim: number = boundary.dim;
    const triangleRegion: number[] = [];
    const lines: string[] = ["solid meshio"];
    for (let b = 0; b < blocks.length; b++) {
      const block = blocks[b];
      const parentIds = parentCellBlocks[b];
      const n: number = block.nodesPerCell;
      const triCount = block.data.length / n;
      for (let t = 0; t < triCount; t++) {
        const i0 = block.data[t * n], i1 = block.data[t * n + 1], i2 = block.data[t * n + 2];
        const v0: [number, number, number] = [pts[i0 * dim], pts[i0 * dim + 1], pts[i0 * dim + 2]];
        const v1: [number, number, number] = [pts[i1 * dim], pts[i1 * dim + 1], pts[i1 * dim + 2]];
        const v2: [number, number, number] = [pts[i2 * dim], pts[i2 * dim + 1], pts[i2 * dim + 2]];
        const ux = v1[0] - v0[0], uy = v1[1] - v0[1], uz = v1[2] - v0[2];
        const wx = v2[0] - v0[0], wy = v2[1] - v0[1], wz = v2[2] - v0[2];
        let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        lines.push(
          `facet normal ${nx} ${ny} ${nz}`,
          "outer loop",
          `vertex ${v0[0]} ${v0[1]} ${v0[2]}`,
          `vertex ${v1[0]} ${v1[1]} ${v1[2]}`,
          `vertex ${v2[0]} ${v2[1]} ${v2[2]}`,
          "endloop",
          "endfacet"
        );

        const parentId = parentIds ? parentIds[t] : undefined;
        let regionIdx = -1;
        if (parentId !== undefined) {
          for (let r = 0; r < regionSets.length; r++) {
            if (regionSets[r].ids.has(parentId)) { regionIdx = r; break; }
          }
        }
        triangleRegion.push(regionIdx);
      }
    }
    lines.push("endsolid meshio");
    if (!triangleRegion.some((r) => r !== -1)) return fallback(); // nothing actually resolved to a region
    return {
      stlBytes: Buffer.from(lines.join("\n"), "utf8"),
      regions: { regionNames, triangleRegion: Int32Array.from(triangleRegion) },
    };
  } catch (err) {
    resetMeshioIfAbort(err);
    return fallback();
  }
}

export interface MeshioFieldValues {
  /** One value per triangle CORNER, in the SAME file order as
   * `convertToStlBoundaryWithRegions`'s STL bytes (one entry per vertex of
   * the non-indexed triangle soup) — ready to become a `THREE.js` vertex-
   * colour attribute with no further reordering. */
  values: Float32Array;
  min: number;
  max: number;
}

/**
 * Reads one named scalar field's VALUES (not just its name — see
 * `readMeshioMetadata` above for that) for the "colour by scalar field"
 * roadmap item, correlated onto the SAME boundary triangle soup
 * `convertToStlBoundaryWithRegions` produces (verified deterministic: the
 * same `readMesh` → `extractSurface` call sequence on the same bytes always
 * yields byte-identical boundary geometry/order). Returns `null` (never
 * throws) when the field doesn't exist, isn't a plain scalar (a
 * multi-component vector/tensor field isn't colour-mappable without a
 * component-selection UI this feature doesn't have), or the boundary isn't
 * pure triangles — same graceful-degradation convention as every other
 * meshio path in this codebase.
 *
 * **`kind: "point"` needs no correlation math at all — verified against the
 * live WASM, a genuinely surprising simplification.** `extractSurface`
 * already subsets AND reorders `point_data` to match its own output
 * `points` array: probed with a deliberately-interior point (excluded from
 * every boundary face) carrying a distinctive value, and `boundary.
 * point_data[field]` came back with that value correctly DROPPED and the
 * remaining values correctly re-indexed to the 4 real boundary points, not
 * just naively truncated to the first N. So `boundary.point_data[field]`
 * is read directly, then expanded from per-POINT to per-CORNER by indexing
 * through each triangle's own point indices (`block.data`).
 *
 * **`kind: "cell"` reuses the exact `cell_data["surface:parent_cell"]`
 * provenance array `convertToStlBoundaryWithRegions` already established**
 * for region correlation: the ORIGINAL mesh's `cell_data[field]` (one array
 * per original cell block) is flattened into one global, block-major array
 * — the same indexing convention `Region.entries` (`kind: "cell"`) already
 * uses — then each boundary triangle's parent-cell value is looked up and
 * broadcast to its 3 corners (a cell-data field is constant across a whole
 * original cell, hence across every boundary face descended from it).
 *
 * `sourceName`/`companions` are the same optional, additive pair every
 * other entry point in this file now takes — see `stageMeshioSource`.
 */
export async function readMeshioFieldValues(
  sourceBytes: Uint8Array,
  meshioFormat: string,
  fieldName: string,
  kind: "point" | "cell",
  sourceName?: string,
  companions?: readonly MeshioCompanion[]
): Promise<MeshioFieldValues | null> {
  try {
    const m = await getMeshio();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mesh: any;
    const { primaryPath, allPaths } = stageMeshioSource(m, sourceBytes, meshioFormat, sourceName, companions);
    try {
      mesh = m.readMesh(primaryPath, meshioFormat);
    } finally {
      unstageMeshioSource(m, allPaths);
    }

    const boundary = m.extractSurface(mesh, true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocks = boundary.cells as any[];
    if (blocks.length === 0 || blocks.some((b) => b.type !== "triangle" || b.nodesPerCell !== 3)) return null;

    const perCorner: number[] = [];
    if (kind === "point") {
      const arr: Float64Array | undefined = boundary.point_data?.[fieldName];
      if (!arr) return null;
      if ((boundary.point_data_components?.[fieldName] ?? 1) !== 1) return null; // not a plain scalar
      for (const block of blocks) {
        for (let i = 0; i < block.data.length; i++) perCorner.push(arr[block.data[i]]);
      }
    } else {
      const cellArrBlocks: Float64Array[] | undefined = mesh.cell_data?.[fieldName];
      const parentCellBlocks: Float64Array[] | undefined = boundary.cell_data?.["surface:parent_cell"];
      if (!cellArrBlocks || !parentCellBlocks) return null;
      if ((mesh.cell_data_components?.[fieldName] ?? 1) !== 1) return null; // not a plain scalar
      const flat: number[] = [];
      for (const blockArr of cellArrBlocks) for (let i = 0; i < blockArr.length; i++) flat.push(blockArr[i]);
      for (let b = 0; b < blocks.length; b++) {
        const n: number = blocks[b].nodesPerCell;
        const triCount = blocks[b].data.length / n;
        const parentIds = parentCellBlocks[b];
        for (let t = 0; t < triCount; t++) {
          const v = flat[parentIds[t]];
          perCorner.push(v, v, v);
        }
      }
    }
    if (perCorner.length === 0) return null;
    let min = Infinity, max = -Infinity;
    for (const v of perCorner) { if (v < min) min = v; if (v > max) max = v; }
    return { values: Float32Array.from(perCorner), min, max };
  } catch (err) {
    resetMeshioIfAbort(err);
    return null;
  }
}

/**
 * OpenFOAM polyMesh import — the one meshio format that is NOT a single file.
 * A `.foam` document is an (usually empty) marker file — the ParaView
 * convention — whose real mesh lives in sibling files
 * (`points`/`faces`/`owner`/`neighbour`/`boundary`) under
 * `<marker's parent>/constant/polyMesh/`. meshio++'s C++ reader resolves that
 * directory itself via `std::filesystem`, so unlike every other format in
 * this file (bytes-in → STL-out), the whole case must be staged into MEMFS at
 * the same relative layout before `convertSurface` can read it. This function
 * takes the MARKER'S REAL FILESYSTEM PATH (a plain string, so it crosses the
 * kernel-worker IPC boundary untouched), locates and copies the polyMesh
 * siblings itself, converts to an ASCII STL boundary, and cleans up.
 *
 * Directory resolution mirrors meshio++'s own `_resolve_polymesh` for the two
 * forms a marker-file open can encounter: `<parent>/constant/polyMesh` (the
 * real case layout), then `<parent>/polyMesh` (a bare polyMesh directory kept
 * beside the marker). A missing directory throws a clear, actionable error —
 * an application error (not a WASM abort), thrown BEFORE any WASM work so it
 * cannot corrupt the singleton.
 *
 * Deliberately geometry-only: meshio++'s OpenFOAM reader reads no point/cell/
 * field data arrays (time-directory field files like `U`/`p`/`T` are not read)
 * and carries patch names through a C++ side-channel struct (`OpenFoamInfo`)
 * that is not surfaced to the JS binding — so there are no regions to
 * correlate (`convertToStlBoundaryWithRegions`'s machinery has nothing to
 * consume) and no metadata to report (`readMeshioMetadata`'s shape is
 * structurally empty for this format; call sites skip both rather than pay a
 * staging round trip for a guaranteed-empty answer).
 *
 * Throws on failure (unlike this file's graceful-degradation readers): a
 * malformed case must surface as a load error naming what's wrong, exactly
 * like every other unparseable source format.
 */
export async function convertFoamCaseToStlBoundary(markerPath: string): Promise<Uint8Array> {
  // 1. Locate the polyMesh directory beside the marker on the REAL filesystem.
  const parent = path.dirname(path.resolve(markerPath));
  let polyMeshDir: string | null = null;
  for (const candidate of [path.join(parent, "constant", "polyMesh"), path.join(parent, "polyMesh")]) {
    try {
      if ((await fs.promises.stat(candidate)).isDirectory()) { polyMeshDir = candidate; break; }
    } catch { /* try the next candidate */ }
  }
  if (!polyMeshDir) {
    throw new Error(
      "OpenFOAM case error: no constant/polyMesh directory found beside the .foam marker — " +
      `${path.basename(markerPath)} is a marker file; the mesh must live in its sibling constant/polyMesh/ (${parent}).`
    );
  }

  const m = await getMeshio();
  const caseRoot = "/foamcase";
  const markerMemPath = `${caseRoot}/case.foam`;
  const stagedFiles: string[] = [];
  const rmTree = (p: string): void => {
    try { m.FS.unlink(p); } catch { /* ignore */ }
    try { m.FS.rmdir(p); } catch { /* ignore */ }
  };
  try {
    // 2. Stage <case>/constant/polyMesh/* into MEMFS. FS.mkdir creates one
    // level at a time (no -p semantics), so each level is attempted and its
    // already-exists failure ignored.
    for (const dir of [caseRoot, `${caseRoot}/constant`, `${caseRoot}/constant/polyMesh`]) {
      try { m.FS.mkdir(dir); } catch { /* exists or fatal — writeFile below will say which */ }
    }
    // The marker itself is content-free by convention; copy whatever bytes the
    // real file has anyway so the staged case mirrors the source on disk.
    m.FS.writeFile(markerMemPath, new Uint8Array(await fs.promises.readFile(markerPath)));
    stagedFiles.push(markerMemPath);
    const entries = await fs.promises.readdir(polyMeshDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const memPath = `${caseRoot}/constant/polyMesh/${entry.name}`;
      m.FS.writeFile(memPath, new Uint8Array(await fs.promises.readFile(path.join(polyMeshDir, entry.name))));
      stagedFiles.push(memPath);
    }
    if (stagedFiles.length === 1) {
      throw new Error(
        `OpenFOAM case error: ${polyMeshDir} contains no files — expected points/faces/owner/neighbour/boundary.`
      );
    }

    // 3. Convert. Deliberately NOT `m.convertSurface`: that call linearizes
    // higher-ORDER cells (tri6→tri3) but does NOT split multi-node boundary
    // FACES — and meshio++'s STL writer then silently emits zero facets for a
    // quad-only boundary (verified live against a single-hex case: extractSurface
    // returns one `quad` block, convertSurface's STL is `solid endsolid`). Hex-
    // dominant meshes are THE typical OpenFOAM content, so an all-quad boundary
    // is the common case, not an edge case. Instead: readMesh + extractSurface +
    // fan-triangulate every boundary face here — the same hand-built-STL shape
    // `convertToStlBoundaryWithRegions` uses, generalized from its
    // triangle-only fast path to arbitrary polygons.
    let mesh;
    try {
      mesh = m.readMesh(markerMemPath, "openfoam");
    } catch (err) {
      throw wrapMeshioFault(err);
    }
    const boundary = m.extractSurface(mesh, false);
    const stl = boundaryTrianglesToAsciiStl(boundary.points, boundary.dim, boundary.cells);
    if (!stl) {
      throw new Error(
        "OpenFOAM case error: the mesh produced an empty boundary — no faces to display."
      );
    }
    return stl;
  } finally {
    for (const p of stagedFiles) rmTree(p);
    rmTree(`${caseRoot}/constant/polyMesh`);
    rmTree(`${caseRoot}/constant`);
    rmTree(caseRoot);
  }
}

/**
 * Builds ASCII STL bytes from a meshio++ boundary mesh, fan-triangulating every
 * polygonal face (`triangle`, `quad`, ragged `polygon*`) about its first vertex.
 * Returns `null` when no triangle came out. Normals are recomputed from the
 * post-triangulation winding via cross product — never trusted from the source,
 * the same convention `scaleStlBytes` established. Accepts exactly the two
 * `CellBlock` shapes a SURFACE boundary can contain (rectangular + CSR polygon);
 * a polyhedron block on a boundary is structurally unexpected and throws rather
 * than silently dropping faces.
 */
function boundaryTrianglesToAsciiStl(
  points: Float64Array,
  dim: number,
  cells: unknown[]
): Uint8Array | null {
  const lines: string[] = ["solid meshio"];
  let count = 0;
  const emitTriangle = (i0: number, i1: number, i2: number): void => {
    const v0 = [points[i0 * dim], points[i0 * dim + 1], points[i0 * dim + 2]];
    const v1 = [points[i1 * dim], points[i1 * dim + 1], points[i1 * dim + 2]];
    const v2 = [points[i2 * dim], points[i2 * dim + 1], points[i2 * dim + 2]];
    const ux = v1[0] - v0[0], uy = v1[1] - v0[1], uz = v1[2] - v0[2];
    const wx = v2[0] - v0[0], wy = v2[1] - v0[1], wz = v2[2] - v0[2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) return; // degenerate triangle — skip, never emit NaN normals
    nx /= len; ny /= len; nz /= len;
    lines.push(
      `facet normal ${nx} ${ny} ${nz}`,
      "outer loop",
      `vertex ${v0[0]} ${v0[1]} ${v0[2]}`,
      `vertex ${v1[0]} ${v1[1]} ${v1[2]}`,
      `vertex ${v2[0]} ${v2[1]} ${v2[2]}`,
      "endloop",
      "endfacet"
    );
    count++;
  };
  for (const block of cells) {
    const b = block as { type?: string; data?: Int32Array; nodesPerCell?: number; rowOffsets?: Int32Array };
    const data = b.data;
    if (!data) throw new Error(`OpenFOAM case error: unexpected boundary block "${b.type}" (no connectivity).`);
    if (b.rowOffsets) {
      // Ragged polygon block (CSR): fan-triangulate each variable-length row.
      const rows = b.rowOffsets.length - 1;
      for (let c = 0; c < rows; c++) {
        const start = b.rowOffsets[c], end = b.rowOffsets[c + 1];
        for (let i = start + 1; i + 1 < end; i++) {
          emitTriangle(data[start], data[i], data[i + 1]);
        }
      }
    } else if (typeof b.nodesPerCell === "number") {
      const n = b.nodesPerCell;
      const cellCount = data.length / n;
      if (n < 3 || !Number.isInteger(cellCount)) {
        throw new Error(`OpenFOAM case error: unexpected boundary block "${b.type}" (${n} nodes/cell).`);
      }
      for (let c = 0; c < cellCount; c++) {
        for (let i = 1; i + 1 < n; i++) {
          emitTriangle(data[c * n], data[c * n + i], data[c * n + i + 1]);
        }
      }
    } else {
      throw new Error(`OpenFOAM case error: unexpected boundary block "${b.type}".`);
    }
  }
  lines.push("endsolid meshio");
  return count > 0 ? Buffer.from(lines.join("\n"), "utf8") : null;
}

/**
 * Re-encodes an already-generated Gmsh mesh into a format Gmsh's own writers
 * can't produce — MED and CGNS are the roadmap's explicit motivating case
 * (`doc/gmsh-integration.md` documents both as unsupported in the bundled
 * gmsh-wasm build: "compiled without CGNS/MED support"). Bridges the two
 * independent WASM modules' virtual filesystems via a plain
 * `Buffer`/`Uint8Array` round trip — no browser, no shared memory, just
 * read-bytes-from-one/write-bytes-to-other.
 *
 * **`gmshMshText` is Gmsh's modern MSH 4.1 output — `generateMesh()`'s own
 * `mshText` — since `@meshioplusplus/wasm` 9.7.0.** Before 9.7.0 the C++
 * reader threw `"Gmsh $Entities not supported by the C++ reader"` on every
 * real 4.1 file, so this bridge had to route through a legacy MSH 2.2
 * re-export (`exportMeshFormat(..., "msh2")`). 9.7.0 parses `$Entities`
 * natively and — the load-bearing part — resolves physical-group membership
 * from it, so a 4.1 read now yields **named `regions`** (one per physical
 * group, i.e. per CAD-Preview part) that 2.2 never carried. The 2.2 detour
 * is gone.
 *
 * **Every format, MED included, is now a plain `convert()` call — since
 * `@meshioplusplus/wasm` 9.8.0.** Two gaps this bridge used to work around
 * were both closed upstream in 9.8.0 (re-verified against the live WASM with
 * a real Gmsh-generated 4.1 file carrying named volume + surface physical
 * groups, not just unit-tested): `write_med` now bridges
 * `cell_data["gmsh:physical"]` to MED families natively in C++ instead of
 * throwing `"MED: gmsh physical groups handled by Python fallback"`, and it
 * now consolidates MSH 4.1's per-*entity* cell blocks into one section per
 * type itself instead of throwing `"MED files cannot have two sections of
 * the same cell type"` — so the old `readMesh` → `merge([mesh])` →
 * rebuild-without-`cell_data` → `writeMesh` two-step (which needed the
 * `merge` purely to satisfy that same-type-block restriction) is gone. A box
 * with `MyVolume`/`MySurface` physical groups round-trips both region names
 * through a direct `convert(..., {outFormat: "med"})` with no special-casing.
 *
 * **The pure-surface CGNS read-back gap is also closed in 9.8.0** — CGNS was
 * rewritten from a private tetrahedra-only encoding (whose writer emitted
 * only the first `tetra` block it found, so any 2D-dimension FE-mesh
 * generate wrote a file this same WASM's own reader rejected with
 * `"HDF5: missing dataset ' data'"`) to a genuine CGNS/SIDS-compliant
 * unstructured-mesh subset, one section per cell block. Re-verified against
 * a real Gmsh 2D-dimension generate: the CGNS round-trips clean.
 *
 * **XDMF writes an HDF5 companion file, like `.geo_unrolled`'s `.xao`
 * companion** — confirmed against the live WASM: `convert(..., "/out.xdmf",
 * ...)` also writes `/out.h5` (same basename, swapped extension) and the
 * `.xdmf` XML's `<DataItem>` elements reference it by that bare filename
 * (e.g. `out.h5:/data0`). `bytes`/`companion` are returned separately (not
 * concatenated) so the caller can write both under the *chosen save
 * filename's* basename and rewrite the embedded reference to match —
 * `provider.ts`'s `meshingExport` handler does this the same way it already
 * rewrites `.geo_unrolled`'s `Merge "...xao"` stub.
 */

export async function exportViaMeshio(
  gmshMshText: string,
  outMeshioFormat: string
): Promise<{ bytes: Uint8Array; companion?: { name: string; bytes: Uint8Array } }> {
  const m = await getMeshio();
  const inPath = "/in.msh";
  const outPath = `/out.${outMeshioFormat}`;
  const companionPath = "/out.h5";
  m.FS.writeFile(inPath, Buffer.from(gmshMshText, "utf8"));
  try {
    m.convert(inPath, outPath, { inFormat: "gmsh", outFormat: outMeshioFormat });
    const bytes = m.FS.readFile(outPath);
    if (outMeshioFormat !== "xdmf") return { bytes };
    try {
      return { bytes, companion: { name: "out.h5", bytes: m.FS.readFile(companionPath) } };
    } catch {
      return { bytes }; // the "Binary"/"XML" data formats have no HDF companion — only "HDF" does
    }
  } catch (err) {
    throw wrapMeshioFault(err);
  } finally {
    try { m.FS.unlink(inPath); } catch { /* ignore */ }
    try { m.FS.unlink(outPath); } catch { /* ignore */ }
    try { m.FS.unlink(companionPath); } catch { /* ignore */ }
  }
}
