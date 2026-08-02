// meshio++ WASM module (`@meshioplusplus/wasm`) — the third host-side WASM
// singleton alongside OCCT (occtService.ts) and Gmsh (gmshService.ts), used to
// import mesh-only formats (VTK/MED/CGNS/Exodus/XDMF/MDPA) as viewable
// documents and to export generated FE meshes to formats Gmsh's own writers
// cannot produce (MED, CGNS).
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MeshioApi = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _meshioPromise: Promise<MeshioApi> | null = null;

/** Returns the meshio++ WASM module, initializing it lazily on first call. */
export function getMeshio(): Promise<MeshioApi> {
  if (!_meshioPromise) {
    _meshioPromise = (async () => {
      const { loadMeshioPlusPlus } = await import("@meshioplusplus/wasm");
      return loadMeshioPlusPlus({}, { variant: "seq" });
    })();
  }
  return _meshioPromise;
}

/** Resets the singleton — used by tests and for future hot-reload support. */
export function resetMeshio(): void {
  _meshioPromise = null;
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
 */
export async function convertToStlBoundary(sourceBytes: Uint8Array, meshioFormat: string): Promise<Uint8Array> {
  const m = await getMeshio();
  const inPath = `/in.${meshioFormat}`;
  const outPath = "/out.stl";
  m.FS.writeFile(inPath, sourceBytes);
  try {
    m.convertSurface(inPath, outPath, { inFormat: meshioFormat, outFormat: "stl" });
    return m.FS.readFile(outPath);
  } finally {
    try { m.FS.unlink(inPath); } catch { /* ignore */ }
    try { m.FS.unlink(outPath); } catch { /* ignore */ }
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
 */
export async function readMeshioMetadata(sourceBytes: Uint8Array, meshioFormat: string): Promise<MeshioMetadataSummary> {
  const empty: MeshioMetadataSummary = { regions: [], pointDataNames: [], cellDataNames: [], fieldDataNames: [] };
  try {
    const m = await getMeshio();
    const inPath = `/meta.${meshioFormat}`;
    m.FS.writeFile(inPath, sourceBytes);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const meta = m.readMetadata(inPath, meshioFormat) as any;
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        regions: (meta.regions ?? []).map((r: any) => ({ name: r.name, kind: r.kind, numEntries: r.numEntries })),
        pointDataNames: meta.pointDataNames ?? [],
        cellDataNames: meta.cellDataNames ?? [],
        fieldDataNames: meta.fieldDataNames ?? [],
      };
    } finally {
      try { m.FS.unlink(inPath); } catch { /* ignore */ }
    }
  } catch {
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
 */
export async function convertToStlBoundaryWithRegions(
  sourceBytes: Uint8Array,
  meshioFormat: string
): Promise<MeshioBoundaryResult> {
  const fallback = async (): Promise<MeshioBoundaryResult> => ({ stlBytes: await convertToStlBoundary(sourceBytes, meshioFormat) });
  try {
    const m = await getMeshio();
    const inPath = `/regions-in.${meshioFormat}`;
    m.FS.writeFile(inPath, sourceBytes);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mesh: any;
    try {
      mesh = m.readMesh(inPath, meshioFormat);
    } finally {
      try { m.FS.unlink(inPath); } catch { /* ignore */ }
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
  } catch {
    return fallback();
  }
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
  } finally {
    try { m.FS.unlink(inPath); } catch { /* ignore */ }
    try { m.FS.unlink(outPath); } catch { /* ignore */ }
    try { m.FS.unlink(companionPath); } catch { /* ignore */ }
  }
}
