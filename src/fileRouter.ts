/**
 * Maps a file to the pipeline used to render it.
 *
 * - `occt`: B-rep formats parsed + tessellated by OpenCascade.js in the extension host.
 * - `three`: already-triangulated mesh formats loaded by native Three.js loaders.
 * - `meshio`: formats meshio++ (`src/meshioService.ts`) reads that neither of the
 *   above can — the host converts them to an STL boundary surface
 *   (`convertToStlBoundary`) and the webview loads that via the same STL
 *   loader a native `.stl` open uses (see `protocol.ts`'s `loadMeshBytes`).
 */
export type RenderStrategy = "occt" | "three" | "meshio";

export type CadFormat =
  | "step" | "iges" | "brep" | "csg" | "scad" | "stl" | "obj" | "ply" | "gltf"
  | "vtk" | "vtu" | "med" | "cgns" | "exodus" | "xdmf" | "mdpa"
  | "openfoam"
  | "gmsh" | "abaqus" | "unv" | "su2" | "medit"
  | "gid";

/** `CadFormat` members routed through meshio++ — kept as one list so every
 * place that needs to enumerate them (package.json's generation, docs) has a
 * single source of truth to check against.
 *
 * `openfoam` was added for the polyMesh case-directory reader (see
 * `EXTENSION_MAP`'s `foam` entry below). `gmsh`/`abaqus`/`unv`/`su2`/`medit`
 * were added alongside the original seven — closing a real export/import
 * asymmetry: CAD-Preview's own FE Mesh panel already WRITES
 * `.msh`/`.inp`/`.unv`/`.su2`/`.mesh` (via `gmsh.write()`, see
 * `meshExportFormats.ts`), but until now had no way to re-OPEN any of them.
 * Each was verified end-to-end against the live WASM, not just assumed from
 * meshio++'s format table: `gmsh.write()` a real tetrahedralized box to each
 * extension, then `meshioService.getMeshio()`'s `readMesh(path,
 * meshioFormat)` on the result — all five round-tripped with the correct
 * point/cell counts. Two formats gmsh ALSO writes were tried and REJECTED
 * after the same live check: `.bdf` (Nastran) round-trips through meshio++'s
 * own reader as `"Not a meshio++-C++ Nastran file"`, and `.off` as
 * `"Expected the first line to be 'OFF'"` — gmsh's writer output for both
 * isn't shaped the way meshio++'s reader for the same nominal format
 * expects, so neither is claimed as an import format here (a real, narrower
 * finding than "meshio++ can't read OFF/Nastran" — it may well read a
 * DIFFERENT tool's output for either format correctly; this codebase simply
 * has no fixture to verify that, and CLAUDE.md's own discipline is to claim
 * only what was actually checked).
 *
 * `gid` (GiD postprocess) came with the 10.20.2 bump and is the first entry
 * here whose extension is COMPOUND (`.post.msh`) — see `EXTENSION_MAP` and
 * `matchExtension` for why that forced longest-suffix-first resolution, and
 * `meshExportFormats.ts` for its export side (it is both an import format and
 * an export target, unlike `openfoam`).
 */
export const MESHIO_FORMATS: readonly CadFormat[] = [
  "vtk", "vtu", "med", "cgns", "exodus", "xdmf", "mdpa", "openfoam",
  "gmsh", "abaqus", "unv", "su2", "medit", "gid",
];

/**
 * Extensions whose format cannot be determined from the extension alone,
 * mapped to a plain, human-readable caveat — `.msh` is Gmsh's own MSH format
 * (this codebase's own FE Mesh panel output, and `routeFile`'s preferred
 * default) but is also used by ANSYS and FreeFem meshes; `.inp` is Abaqus
 * (likewise this codebase's own output, likewise preferred) but also
 * ANSYS's APDL command-file `.inp`. `routeFile` stays synchronous and
 * unconditional (never blocking, never WASM-dependent, per its own
 * invariant) and always resolves to the PREFERRED format — there is
 * deliberately no content-sniffing disambiguation here: meshio++ can read
 * `ansys`/`freefem`/`ansysinp`, but this codebase has no real
 * ANSYS/FreeFem-authored fixture to verify that read against, so claiming
 * support for them would be an unverified promise, not a checked one (see
 * CLAUDE.md's "verify against the live WASM, never assume" discipline). A
 * consumer holding the actual bytes (`provider.ts`'s `handleMeshio`,
 * `mcpTools.ts`'s `loadModel`) surfaces this map's caveat as a warning
 * rather than silently guessing — an ANSYS `.msh` still opens, but as a
 * (likely wrong) Gmsh parse, with the user told why.
 */
export const AMBIGUOUS_MESHIO_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["msh", "Assumed to be a Gmsh mesh (this extension's own FE Mesh export format) — an ANSYS or FreeFem .msh file will not parse correctly."],
  ["inp", "Assumed to be an Abaqus input file (this extension's own FE Mesh export format) — an ANSYS APDL .inp file will not parse correctly."],
]);

/** The mesh formats with a pure host-side triangle parser (`stlParser.ts`,
 * `objParser.ts`, `plyParser.ts`, `gltfParser.ts`) — i.e. the ones whose
 * geometry the host can derive on its own, with no webview and no OCCT. */
export type MeshParseFormat = "stl" | "obj" | "ply" | "gltf";

/**
 * The mesh formats every host-side geometry consumer accepts: `compare_models`
 * (centroid/volume signatures), `check_mesh_health`, and `promote_mesh_to_brep`.
 *
 * This used to be declared TWICE — once in `mcpTools.ts` and once in
 * `modelComparePanel.ts` — with a comment justifying the duplication as "the
 * two files don't otherwise share an import". That premise stopped being true
 * (both already import `routeFile` from this module), and the copies were a
 * live drift hazard: adding glTF meant widening two sets and nine separate
 * `as "stl" | "obj" | "ply"` casts, two of which were runtime string
 * comparisons TypeScript could not have flagged. One declaration here, with
 * `MeshParseFormat` as the matching type, removes both problems.
 */
export const COMPARABLE_MESH_FORMATS: ReadonlySet<CadFormat> = new Set<CadFormat>(["stl", "obj", "ply", "gltf"]);

export interface FileRoute {
  strategy: RenderStrategy;
  format: CadFormat;
}

const EXTENSION_MAP: Record<string, FileRoute> = {
  step: { strategy: "occt", format: "step" },
  stp: { strategy: "occt", format: "step" },
  iges: { strategy: "occt", format: "iges" },
  igs: { strategy: "occt", format: "iges" },
  brep: { strategy: "occt", format: "brep" },
  // OpenSCAD `.csg` (roadmap Tier 2 item 2, path (a), closed): the fully
  // evaluated model as text — parsed by `csgImport.ts` (pure) and built
  // kernel-side by `csgModel.ts` into an opaque base shape (like a STEP
  // import, not an op history). OCCT strategy, never a meshio format.
  csg: { strategy: "occt", format: "csg" },
  // OpenSCAD `.scad` (roadmap Tier 2 item 2, path (b), closed): evaluated by
  // a user-installed `openscad` binary into `.csg` text (`src/scadService.ts`,
  // host-side so relative use/include/import resolve), then the shipped
  // `.csg` pipeline takes over — downstream only ever sees format "csg".
  // OCCT strategy: nothing may treat it as mesh.
  scad: { strategy: "occt", format: "scad" },
  stl: { strategy: "three", format: "stl" },
  obj: { strategy: "three", format: "obj" },
  ply: { strategy: "three", format: "ply" },
  gltf: { strategy: "three", format: "gltf" },
  glb: { strategy: "three", format: "gltf" },
  vtk: { strategy: "meshio", format: "vtk" },
  vtu: { strategy: "meshio", format: "vtu" },
  med: { strategy: "meshio", format: "med" },
  cgns: { strategy: "meshio", format: "cgns" },
  exo: { strategy: "meshio", format: "exodus" },
  e: { strategy: "meshio", format: "exodus" },
  xdmf: { strategy: "meshio", format: "xdmf" },
  mdpa: { strategy: "meshio", format: "mdpa" },
  // OpenFOAM polyMesh. A `.foam` file is an (usually empty) marker file — the
  // ParaView convention — whose sibling `<parent>/constant/polyMesh/` holds
  // the real mesh (`points`, `faces`, `owner`, `neighbour`, `boundary`).
  // meshio++'s reader resolves that directory itself, so the meshio route
  // stages the whole case into its MEMFS before reading (see
  // `meshioService.ts`'s foam staging).
  foam: { strategy: "meshio", format: "openfoam" },
  msh: { strategy: "meshio", format: "gmsh" },
  msh2: { strategy: "meshio", format: "gmsh" }, // meshio++'s gmsh reader auto-detects the MSH schema version (2.2 vs 4.1) from the file's own header — verified live, no separate format name needed.
  inp: { strategy: "meshio", format: "abaqus" },
  unv: { strategy: "meshio", format: "unv" },
  su2: { strategy: "meshio", format: "su2" },
  mesh: { strategy: "meshio", format: "medit" },
  // GiD postprocess (meshio++ 10.18.0 write / 10.19.0 read). A COMPOUND
  // extension, and the reason `routeFile` matches the longest suffix first —
  // `.post.msh` ends in `.msh`, which is registered to Gmsh two lines above, so
  // a last-dot-only lookup would silently resolve every GiD file to a Gmsh
  // parse. Only the geometry file is routed: the `.post.res` sibling holds
  // results, is discovered by stem convention (`meshioCompanions.ts`), and is
  // deliberately NOT independently openable. The `binary`/`hdf5` flavours
  // (`.post.bin`/`.post.h5`) are not registered — meshio++ reads them, but this
  // codebase has no fixture verifying either, and CLAUDE.md's discipline is to
  // claim only what was actually checked.
  "post.msh": { strategy: "meshio", format: "gid" },
};

/**
 * Returns the render route for a file path, or `undefined` if the extension is
 * unsupported.
 *
 * **Longest matching suffix wins**, which a single-extension lookup could not
 * express: GiD's `.post.msh` (see `EXTENSION_MAP`) ends in `.msh`, which is
 * registered to a DIFFERENT format (Gmsh), so a last-dot-only reader resolves
 * every GiD file to a Gmsh parse that then fails. This is precisely the bug
 * meshio++ itself had to fix in its own `resolve_format` in 10.18.0 ("`.post.msh`
 * previously resolved to `.msh`"), and the fix here is the same shape: walk the
 * basename's dots left to right, so the FIRST candidate tried is the longest
 * suffix and the last is the bare final extension.
 *
 * Behavior-preserving for every single-extension file, which is what every
 * other registered extension is: `model.stl` tries only `stl`; `my.backup.stl`
 * tries `backup.stl` (unregistered) then `stl`, landing exactly where the old
 * last-dot-only lookup did. The switch from scanning the whole path to scanning
 * the basename is a strict improvement on the same principle — a directory
 * component's dot (`/my.dir/model`) can no longer be mistaken for the file's own
 * extension.
 */
export function routeFile(filePath: string): FileRoute | undefined {
  const ext = matchExtension(filePath);
  return ext === undefined ? undefined : EXTENSION_MAP[ext];
}

/**
 * Every registered extension key (including the compound `post.msh`), for
 * callers that need the set rather than one lookup — the Models activity-bar
 * view builds its file-watcher glob from this instead of hand-copying the
 * table a second time (the open-file dialog's filter list in `provider.ts`
 * predates this and stays as-is).
 */
export const ROUTED_EXTENSIONS: readonly string[] = Object.keys(EXTENSION_MAP);

/**
 * Returns the `EXTENSION_MAP` key `routeFile` matches for `filePath` — the
 * longest registered suffix of its basename — or `undefined` if none is
 * registered. Exported so an extension-keyed lookup elsewhere resolves the
 * SAME key the route did, rather than re-deriving one with its own (last-dot-
 * only, and therefore compound-extension-blind) slicing.
 */
export function matchExtension(filePath: string): string | undefined {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const basename = filePath.slice(slash + 1).toLowerCase();
  for (let dot = basename.indexOf("."); dot !== -1; dot = basename.indexOf(".", dot + 1)) {
    if (dot === basename.length - 1) break; // a trailing dot names no extension
    const candidate = basename.slice(dot + 1);
    if (EXTENSION_MAP[candidate]) return candidate;
  }
  return undefined;
}

/**
 * The plain-language caveat for a path whose format cannot be determined from
 * its extension alone, or `undefined` when there is none.
 *
 * Keyed off {@link matchExtension}, NOT a caller's own last-dot slice — that
 * distinction is load-bearing now that a compound extension exists: a
 * `.post.msh` routes to `gid`, so it must NOT inherit `.msh`'s "assumed to be a
 * Gmsh mesh" caveat, which a bare last-dot lookup would hand it.
 */
export function ambiguityCaveatFor(filePath: string): string | undefined {
  const ext = matchExtension(filePath);
  return ext === undefined ? undefined : AMBIGUOUS_MESHIO_EXTENSIONS.get(ext);
}
