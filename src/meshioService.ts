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
 * **`gmshMshText` MUST be Gmsh's LEGACY MSH 2.2 output (`gmsh.write()` to a
 * `.msh2`-extensioned path — `exportMeshFormat(..., "msh2")`), NOT the
 * modern MSH 4.1 default (`generateMesh()`'s own `.mshText`) — verified
 * against the live WASM.** Feeding MSH 4.1 text (which always includes a
 * `$Entities` section once any `Mesh.MeshSizeMax` option or comparable
 * setting is applied) into meshio++'s `convert(..., {inFormat: "gmsh"})`
 * throws `"Gmsh $Entities not supported by the C++ reader"` — this reader
 * only understands the older MSH 2.2 schema. Switching the bridge input to
 * MSH 2.2 text fixes CGNS/XDMF/VTK immediately.
 *
 * **MED needs a second, MED-specific workaround, verified against the live
 * WASM**: even from valid MSH 2.2 text, `convert(..., {outFormat: "med"})`
 * throws `"MED: gmsh physical groups handled by Python fallback"` — this
 * build's MED writer defers to Python (unavailable in WASM) for ANY mesh
 * whose `cell_data` carries gmsh's own `"gmsh:physical"`/`"gmsh:geometrical"`
 * tags, which `readMesh(..., "gmsh")` ALWAYS attaches (confirmed: the error
 * persists even after `dataDrop`-ing every cell_data array from the parsed
 * `Mesh` object — the check isn't really about the *content*, since a
 * dropped-but-still-referenced data array still trips it). The fix:
 * `readMesh()` the MSH 2.2 text, then hand-build a **brand-new plain object
 * literal** containing only `{points, dim, cells}` — no `cell_data`,
 * `point_data`, or `field_data` keys at all, not even empty ones — and
 * `writeMesh()` THAT to MED. This drops any point/cell scalar field data
 * (CAD-Preview's generated FE meshes never carry any today, so this is a
 * theoretical loss, not an observed regression) but writes cleanly. CGNS/
 * XDMF/VTK do **not** need this workaround — plain `convert()` already works
 * for them once the MSH 2.2 fix above is applied.
 *
 * **Known separate limitation, verified against the live WASM, not silently
 * ignored**: CGNS export of a PURE-SURFACE mesh (triangle/quad only, no
 * volume elements — i.e. every 2D-dimension FE-mesh generate) produces a
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
  gmshMsh2Text: string,
  outMeshioFormat: string
): Promise<{ bytes: Uint8Array; companion?: { name: string; bytes: Uint8Array } }> {
  const m = await getMeshio();
  const inPath = "/in.msh";
  const outPath = `/out.${outMeshioFormat}`;
  const companionPath = "/out.h5";
  m.FS.writeFile(inPath, Buffer.from(gmshMsh2Text, "utf8"));
  try {
    if (outMeshioFormat === "med") {
      const mesh = m.readMesh(inPath, "gmsh");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cells = (mesh.cells as any[]).map((c) => ({ type: c.type, data: c.data, nodesPerCell: c.nodesPerCell }));
      const freshMesh = { points: mesh.points, dim: mesh.dim, cells };
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
