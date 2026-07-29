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
 * **MED still needs a MED-specific two-step, re-verified against the live
 * 9.7.0 WASM** — but it's now a group-PRESERVING one, not group-dropping:
 * 1. Direct `convert(..., {outFormat: "med"})` still throws
 *    `"MED: gmsh physical groups handled by Python fallback"` whenever
 *    `cell_data` carries gmsh's `"gmsh:physical"` tags (which
 *    `readMesh(..., "gmsh")` always attaches), and additionally MED rejects
 *    MSH 4.1's per-*entity* cell blocks outright
 *    (`"MED files cannot have two sections of the same cell type"` — a unit
 *    box meshes into 27 blocks: 8 vertex + 12 line + 6 triangle + 1 tetra).
 * 2. The fix: `readMesh()` the 4.1 text, run it through **`merge([mesh])`**
 *    (meshio++'s own merge consolidates same-type blocks into one — MED's
 *    requirement — and remaps every region's block-major cell indices to
 *    the merged layout, verified: region entry counts survive exactly),
 *    then hand-build a **brand-new plain object** of only
 *    `{points, dim, cells, regions}` — no `cell_data`/`point_data`/
 *    `field_data` keys at all (dropping them is what dodges the
 *    Python-fallback throw; scalar field data is a theoretical loss only,
 *    CAD-Preview's generated meshes never carry any) — and `writeMesh()`
 *    THAT to MED. 9.6.0's MED writer synthesizes MED families from the
 *    regions, so **physical groups (CAD-Preview parts) now round-trip into
 *    MED as named groups** — verified: a box with `MyVolume`/`MySurface`
 *    physical groups wrote a MED whose read-back listed both regions with
 *    identical entry counts. Under 9.4.1 this path dropped all groups.
 * CGNS/XDMF/VTK need none of this — plain `convert()` works directly on
 * the 4.1 text.
 *
 * **Known separate limitation, RE-verified against the live 9.7.0 WASM,
 * still present**: CGNS export of a PURE-SURFACE mesh (triangle/quad only,
 * no volume elements — i.e. every 2D-dimension FE-mesh generate) produces a
 * file this same WASM build's own reader can't read back
 * (`"HDF5: missing dataset ' data'"`); volume (3D tet/hex) meshes are
 * unaffected, and MED/XDMF have no such gap at all. CAD-Preview still writes
 * the file (the failure is on *read*, not *write*) but the limitation is
 * documented here and in `doc/gmsh-integration.md`.
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
    if (outMeshioFormat === "med") {
      const parsed = m.readMesh(inPath, "gmsh");
      // merge([single mesh]) consolidates MSH 4.1's per-entity cell blocks
      // into one block per type (MED's hard requirement) and remaps the
      // named regions' cell indices onto the merged layout.
      const merged = m.merge([parsed]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cells = (merged.cells as any[]).map((c) => ({ type: c.type, data: c.data, nodesPerCell: c.nodesPerCell }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const regions = (merged.regions as any[]) ?? [];
      const freshMesh = {
        points: merged.points,
        dim: merged.dim,
        cells,
        ...(regions.length > 0 ? { regions } : {}),
      };
      m.writeMesh(outPath, freshMesh, "med");
      return { bytes: m.FS.readFile(outPath) };
    }

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
