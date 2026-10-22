# Changelog

All notable changes to the "CAD Preview" extension are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project does not yet strictly follow Semantic Versioning (pre-1.0 releases moved fast and bundled multiple features per bump).

## [Unreleased]

### Added

- **Draft and undercut analysis (`check_draft` MCP tool).** Given a `pull` direction it reports, as facts, the walls with less than `minDraftDeg` of draft, the walls tilted away from the pull (or, with `twoSided`, each face judged against its own release side) and the faces shadowed along the pull (sampled rays, with the sample count and per-face fraction), naming `face-N` for B-rep and `facet-N` for mesh sources. Cap faces perpendicular to the pull are excluded, the projected area is included, and display-only/meshio-only formats return `supported: false`. The panel and colour field follow.
- **Hole callouts and centre marks on drawing sheets (`export_drawing_sheet` `holeCallouts: true`).** Every hole whose axis is a view's line of sight gets a centre cross, and each hole group (size, axis, through/blind) one leader callout — `4× Ø5 THRU`, `2× Ø5 ↧6` for a blind group — with the nearest standard designation appended when within 5 %. SVG carries a `CENTER` group per marked view; DXF a `CENTER` layer. B-rep sources only (a mesh source warns), default off so existing sheets stay byte-identical, and the result reports `holeMarkCount`. The Export Drawing Sheet form has a **Hole callouts** checkbox and sheet templates accept a `holeCallouts` key, resolved by the same `resolveSheetSettings` as the tool (explicit input beats the template).

## [3.27.0] - 2026-10-21

### Added

- **`engine: "octree"`: a hex-dominant volume mesher beside Gmsh and fTetWild.** meshio++ 17.8.0's `octree` turns the tessellated skin of any 3D source (a B-rep tessellated on host OCCT, or a mesh source as-is) into a conforming hexahedra + pyramids + tetrahedra volume (`transition: "templates"`, the only transition MDPA export accepts). New `MeshOptions.octreeMaxLevel` (1–6, default 4) and `octreeSnap` (default on); `generate_mesh` reports `octree {maxLevel, snap, numSnapped, numRefused, elementMix}`, the FE Mesh panel gets an "Octree (hex-dominant)" engine with those two fields and a status-line summary, and the handoff manifest records the facts. `block.stp` at level 4 meshes to 3522 cells (1372 hex / 542 pyramid / 1608 tet) enclosing exactly 60, every cell positively oriented in Gmsh's node order; `cube.stl` encloses exactly 1000; MDPA export writes all three cell classes. Parts and physical groups are not preserved (the engine has no face correlation) and Gmsh-only options are refused by name (`elementOrder: 2`, a non-simplex `elementShape`, `periodic`, `sizeField` throw; an optimizer pass and Part settings warn; `dimension !== 3` falls back to Gmsh). Refinement sweeps and `.geo_unrolled` export refuse the engine. See `doc/gmsh-integration.md#octree-engine`.

### Security

- **`vite` 6.4.3 → 6.4.5 closes the three `launch-editor` advisories the re-scan surfaced (GHSA-587h-7wmj-5pm high, GHSA-698v-4r3x-3vcv medium, GHSA-r825-w8mm-5pxw medium).** All three affect `vite` `<= 6.4.3` and are patched in **6.4.4**; the `vite` override moves `^6.4.3` → `^6.4.4` and the lockfile resolves 6.4.5. They are all in `launch-editor-middleware`, the helper behind vite's dev-server `/__open-in-editor` endpoint: `escapeCmdArgs()` omitted `%` escaping on Windows, the `fs.existsSync()` existence check could be bypassed on Windows, and an Editor CLI flag could be misinterpreted into arbitrary command execution for some editors. **Reachability:** `vite` is a **dev** dependency here — it enters only through `vitepress` (the docs site) and `vitest`, and `node_modules` is excluded from the `.vsix` — so none of the three is in a shipped extension, the extension-host bundle or the MCP-server bundle; the high one needs a Windows dev machine running the dev server against a crafted request. It is fixed anyway, for the same reason as every other advisory here: the lockfile pin was inside the vulnerable range, and that is a real supply-chain liability for anyone installing from source. **`npm audit` could not fix this one, and that is the trap the `fast-uri` advisory recorded in 3.11.0:** vite is not a direct dependency (vitepress 1.6.4 asks for `vite: ^5.4.14`), so `npm audit` reported "No fix available" and left the lockfile at 6.4.3 even though the patched release satisfied the manifest's own override — the override is what actually moves it. After this bump `npm audit` reports **0 vulnerabilities** and the Dependabot page has no open alert.
- **`hono` 4.13.7 → 4.13.13 closes the last open Dependabot alert (GHSA-5r4p-p66f-jhc7, moderate, CVSS 5.3) — and the same bug was live in the pinned adapter.** The advisory covers `hono` `>= 4.12.4, < 4.13.11`: `serveStatic` decoded the request path a *second* time after Hono had already decoded it for routing, so a crafted request could be routed as one path and served as another, skipping middleware mounted on that prefix (an auth check, say). The manifest's `hono` override moves `^4.13.7` → `^4.13.13` (4.13.11 is the patched release; 4.13.13 is the current 4.x), and the fix is the same guard in both packages — a request path that still contains `%` after the first decode is rejected, with `allowPercentInPath: true` as the opt-out. The **same** advisory class was live one level down: `@hono/node-server` `>= 1.19.10, < 2.1.3` (GHSA-rmxm-3fg6-px4f) shipped the vulnerable `serveStatic` of its own, and the manifest pinned 2.0.11 — inside the affected range — so the override moves `^2.0.11` → `^2.1.5`, the first line carrying the fix plus "serve only GET and HEAD" and an HTTP/2 stream-reset abort fix. 2.1.x widens the peer range to `hono: ^4 || ^5.0.0-0`; the manifest's own `hono` override keeps the tree on 4.13.13. **Reachability, measured rather than assumed:** `hono` enters this project only through `@modelcontextprotocol/sdk` → `@hono/node-server` (the SDK's Streamable-HTTP transport) and the SDK's own `hono` dependency — the extension host, the viewer and the six WASM kernels never import it, and nothing here mounts `serveStatic`. The shipped MCP server connects over **stdio** (`src/mcpServer.ts`), never the HTTP transport, so the vulnerable path was not reachable in a shipped configuration. It is fixed anyway: a lockfile pin inside the affected range is a real supply-chain liability for anyone installing from source, and the MCP server *can* be hosted over HTTP by a third party, who would then be running the vulnerable adapter. Verified against the new lockfile: `npm test` 3106/3106 (208 files), `mcp:smoke` green on the `hono` bump (the stdio transport it drives never touches `@hono/node-server`; that package's 2.1.3+ fix is a static-file middleware the shipped MCP server does not mount), and `npm audit` reports **0 vulnerabilities** — the last of them, the dev-only `vite`/`vitepress` pair, is closed by the `vite` bump above.

## [3.26.0] - 2026-10-20

### Added

- **OpenSCAD now evaluates in a bundled WASM build — no `openscad` install needed.** `.scad` sources are evaluated by the bundled [`@loumalouomega/openscad-wasm`](https://github.com/loumalouomega/openscad-wasm) 0.3.1 (OpenSCAD compiled to WebAssembly, Manifold backend by default) inside the kernel worker — `src/scadWasmService.ts`, the `convertScadViaWasm` Pipeline function — producing the same `.csg` bytes the binary path produced, so opening, editing, meshing, measuring and exporting a `.scad` file now work with nothing on `PATH`. The WASM output is byte-identical to the installed binary on every committed fixture (`minimal`, `parametric`, `colour-booleans`, `two-colour`, `include-main`) including `-D` overrides, and a runaway recursion is declined in ~65 ms with the kernel still usable afterwards. The user-installed `openscad` binary stays as the fallback and is used **only** for constructs the WASM path declines — an `import()`/`surface()` of a local mesh, a missing include, more than 20 staged files or 1 MB of staged source, or an unavailable WASM binary; every other WASM failure surfaces instead of silently retrying the binary. `cadPreview.openscadBinary` (headless twin `OPENSCAD_BINARY`) now configures that fallback only, and a `.scad` entry point returns `{supported: false}` with the install hint only when the WASM path declines *and* no binary is installed; `convert_scad` takes the same order. The Manifold engine also makes large boolean trees far faster than the CGAL default. Licence: GPL-3.0-or-later (OpenSCAD's GPL-2.0-or-later core plus the Apache-2.0 Manifold backend), compatible with this extension's own GPL-3.0-or-later — the README's "Licensing" section carries the attribution, the VSIX includes the package's own `LICENSE`, `NOTICE` and `THIRD_PARTY_NOTICES.md`, and the WASM binary ships separately replaceable at `dist/openscad-core.wasm`. Closes issue #35. `npm test` 3090/3090 (207 files), compat corpus 78/78, `compat:vsix` clean.
- **B-rep save-in-place is now recoverable after a process death.** Both the interactive `bakeTailToSource` and headless `saveModelTool` now open the same `<model>.save-journal.json` transaction used by recoverable mesh saves before overwriting a STEP/IGES/BREP source, and close it only after the `bakedThrough` watermark lands. `load_model` and the interactive `ready`/save paths repair a pending transaction before replaying any edit: a source holding the baked bytes gets its watermark advanced (no double-apply), a source that was never rewritten has its stale marker dropped, and a source matching neither is reported and left alone (headlessly) or offered a verified `.bak` restore interactively. The shared implementation is now `src/saveRecovery.ts`; `SAVE_IN_PLACE_FORMATS` keeps recovery and both save paths on one format set. A recovered B-rep save warns that Part/annotation/layer highlights may still need re-checking, since the save-time id rebind follows the watermark and is not repeated by recovery. Unit tests cover the STEP/IGES/BREP headless recovery and the `save_model` no-op; the integration suite stages the interactive completion for STEP, IGES and BREP.
- **Boundary-layer rows are measured after a 2-D generate, not just planned.** `boundaryLayerPlan` still shows the analytic stack, but `generate_mesh` now reads the generated nodes back against every wall Part's layer and reports `boundaryLayers`: planned rows, the achieved minimum and median over sampled wall stations, and the fraction of the wall covered. A shortfall adds a warning; the FE Mesh panel appends the numbers to the Part's Layer row and highlights a shortfall; `export_mesh` with a manifest records the same facts, so a layer that silently degenerated travels with the receipt. The measurement is pure (`boundaryLayerMeasurement.ts`), read-only, and 2-D only. Verified on the committed 10×4 rectangle: a 6-row plan reports 6/6 with full coverage, and halving the thickness reports the 3 rows Gmsh actually produced; a plain or unresolved wall reports 0 rather than the plan.
- **meshio-only sources now have host-side geometry facts.** `get_mass_properties`, `measure` and `compare_models` read the boundary surface meshio++ already extracts for display, welded into the same triangle mesh the STL path measures (`src/meshioBoundarySide.ts`). Results are marked `surfaceDerived`, report the correlated cell-region count and a boundary-closure flag, and withhold volume when that boundary is open; `compare_models` reports each side's source kind in `sides`, so a `.vtk`/`.med` side is never mistaken for the exact B-rep or the source's own volume cells. `inspect`, `check_mesh_health`, `promote_mesh_to_brep`, `repair_mesh` and silhouette export still refuse these formats because they need the source's triangle soup, and the interactive Compare Models command keeps its existing format filter. The new `examples/VTK/cube.vtk` fixture is compared against the unit OBJ cube (exact match, watertight, `surfaceDerived`) and a two-triangle open surface reports area/bbox with `volume: null`; an empty/unreadable boundary degrades to `supported: false`.
- **Drawing sheets grow full section views.** `export_drawing_sheet` (and the Export Drawing Sheet form, through the same resolver) takes `sections: [{id, label?, view, origin, normal, flip?}]` plus per-view `viewSections`: each named section keeps one half-space of the source tessellation, is drawn looking along the plane normal with its cut loops hatched at 45° on a `SECTION` layer/group, and marks the cutting plane with arrows and the label in the parent view; an in-place cut draws the clipped half-space in the view itself. The response reports each section's parent view, cut-loop count and hatch count. Verified on a 3×4×5 box with a 4×2×2 through pocket: the mid-pocket section reports its outer-plus-pocket loops hatched in SVG and DXF alike, an STL tessellated off the same B-rep agrees on the loops, a missing plane is refused by name, and a no-section sheet stays byte-identical. Sections and layer filters cannot be combined in this version.
- **Adopted `@meshioplusplus/wasm` 17.8.0 (pinned) for the octree probe.** Compat corpus 78/78, `compat:vsix` clean, `mcp:smoke` green. The release adds the `octree` operation probed by roadmap item 4.10 (box tessellation → conforming hex-dominant volume, exactly 60 at level 4; MDPA round-trips the hexahedra/pyramids/tetrahedra) and keeps KaHIP out of the WASM build (4.9 stays blocked).

### Fixed

- **The dependency watch closes its tracking issue when the tree is current.** `scripts/dependency-watch.mjs --publish` used to return `current` without touching an existing issue, so #92 still advertised meshio++ 16.31.0 → 16.40.0 while `package.json` was on 17.7.0. `publishReport` now finds the issue by title plus marker, posts a dated comment, and closes only that issue with `state_reason: "completed"`; unrelated issues are left alone. Unit tests cover the close, no-issue and unrelated-issue paths. The next publish should update #92 from its stale 16.31.0 → 16.40.0 row to 17.7.0 → 17.8.0; the close path becomes live after that bump.

## [3.25.0] - 2026-10-19

### Added

- **`splitFace` edit op: split one face into two regions for boundary conditions.** A B-rep-only, topology-changing op taking a `face-N` plus exactly one splitting form — connected `edgeIds` on the face, or a straight `[p1, p2]` segment built with `BRepBuilderAPI_MakeEdge_3` — applied through `BRepFeat_SplitShape_2` + `Add_3(edge, face)` + `Build()` + `Shape()`. Verified call shape on `examples/STP/block.stp` (3×4×5, top face z = 2.5, area 12, split along y = 0): 6 → 7 faces, 1 solid, volume 60 and surface area 94 unchanged, halves 6 + 6. An edge that misses the face or stops short of its boundary skips with a diagnostic (face-count guard, like `unifySameDomain`); `face-N`/`edge-N` renumbering goes through the existing rebind. Ships with the panel form (P1/P2), `buildOpForPanel`/`tintForPanelOp` wiring, `opCatalog.ts` button, `OP_PARAM_DOCS` entry, TikZ icon, command-bar support (`splitFace {"face":$sel,"points":[...]}`) and headless raw ops; each split half is a `face-N` a Part can name and the FE mesh carries as a physical group with no meshing change.
- **`MeshOptions.sizeField`: view-driven mesh sizing for B-rep sources.** A list of `{point, size}` samples steering the background mesh through a list-based `SP` view + `PostView` field joined into the shared `Min` background (`addPostViewField` in `gmshSizingFields.ts`), with the view removed after `generate()` so no view is left behind. Headless `generate_mesh`/`export_mesh` input; the FE Mesh panel round-trips it through the stored `.mesh.json` (no editor yet — the first driver is a caller loop over `measure_mesh_deviation`). Verified live on gmsh-wasm 0.4.0 (`examples/STP/bull.stp` at `sizeMax` = diagonal/20 = 9.13): control 2 735 tets, one pass with 400 samples at `sizeMax`/3 over the worst-deviation region 31 957 tets (11.7× growth, reported), forward worst 1.057 → 0.324 (3.3× down), p95 0.370 → 0.082 (4.5× down); a Part on `face-1` keeps its physical group and `getTags()` is empty after the run. Tolerant per-entry validation with a 20 000-sample cap (first N win); sizes follow the export unit like every other mesh length; `Mesh.SearchSizeFromPoints`/`ExtendFromBoundary`/`FromCurvature` are set explicitly every run (1/1/0 without a view, 0/0/0 with one) so a refined run cannot poison the next uniform one. Mesh sources and `engine: "ftetwild"` ignore it with a warning.

### Documented

- **Roadmap**: 2.18 (View-driven mesh sizing) and 2.19 (Split a face into regions) closed as shipped; the wave table now records both as shipped with the `sizeField`/`splitFace` numbers above. `doc/mcp-server.md` gains the `sizeField` sentence on `generate_mesh` and a `splitFace` bullet beside `unifySameDomain`.

## [3.24.0] - 2026-10-19

### Added

- **Nastran OP2 results (`.op2`) opens, and is a new FE-mesh export target.** meshio++ 17.4.0's result writer (PR #164, CVISC dampers in #165), adopted with the 17.7.0 bump and reversing the earlier "no consumer here" triage — at 17.2.0 the writer did not exist, and the adoption's real gate was that this build now also **reads** OP2, so an exported file re-opens. Verified live to the same two-step bar as the 17.3.0 result writers (probe `scripts/probe/examples/op2-writer.ts`): this pipeline's own SaveAll-shaped MSH 4.1 (vertex/line/triangle/tetra blocks) wrote 95 KB and read back through the build's own OP2 reader with every cell class intact — blocks merged per type (the results-file convention) with `nastran:card/eid/pid/c1/c2` cell data attached. Fixture `examples/Nastran/two-tets.op2` (meshio++'s own writer; `scripts/gen-1740-fixtures.mjs`, which also pins the read-back shape and the reader's cell-data columns); compat rows `export-nastran-op2` + `load-op2-fixture` (78/78). `lsdyna_binout` from the same PR stays unadopted — no consumer workflow.

### Changed

- **Kernel and dev packages bumped: meshio++ 17.3.0 → 17.7.0, manifold-3d 3.5.3 → 3.5.4 (the exact pin lifted), draco3d 1.5.7 → 1.5.9, playwright 1.64.1, vitest 5.0.5.** The meshio++ 17.4–17.7 delta is writer-side only: the type declarations and the loader are byte-identical from 17.3.0 through 17.7.0 (verified by tarball diff), so esbuild, `.vscodeignore`, `runtimeAssets.mjs` and `compat:vsix` need no change — only the WASM grew (FULL artifact +537 KB, +2.0 %). Verified against the new lockfile: `npm test` (204 files), `mcp:smoke` end to end, the webview suite's 1 081 checks (which exercise manifold-in-webview under the real CSP and the Draco decoders the glTF path uses) and the compat corpus 78/78 with `verifiedAt` refreshed to 17.7.0. manifold-3d 3.5.4's one change is upstream #1851 — WASM bindings under a Content-Security-Policy without `'unsafe-eval'` — exactly this webview's situation (`manifoldBrowser.ts` initializes under `'wasm-unsafe-eval'`-only CSP; any failure keeps the three-bvh-csg fallback). KaHIP remains uncompiled into every published build (the declarations are identical throughout; the roadmap's KaHIP blockers are re-checked on 17.7.0), and 17.6.0's marc_t19/xplt *series* writes are recorded as not adopted (this exporter writes single-increment meshes).

### Documented

- **Roadmap**: the 16.43–17.2 triage's OP2 entry points at its reversal; a new 17.4–17.7 triage paragraph records the adoption with the probe's numbers, the `lsdyna_binout`/series non-adoptions and the byte-identical-declarations fact; the KaHIP item is re-checked on 17.7.0. The format tables (README, `doc/index.md`, `doc/getting-started.md`, `doc/file-formats.md`, `doc/mcp-server.md`) gain the OP2 rows and the results-file family's layout facts.

## [3.23.0] - 2026-10-19

### Added

- **`Part.meshBoundaryLayer`: anisotropic boundary layers on 2-D Gmsh meshes.** A Part's `edge-N` walls can now carry `{wallSize, growthRatio, thickness, quads}`: a Gmsh `BoundaryLayer` field registered through its own `setAsBoundaryLayer` (never in the shared Min background list), on `dimension: 2` B-rep generates. `set_part`, the FE Mesh panel (Layer row with the analytic row-count plan), the parts sidecar and the unit-scaled export all carry it. The roadmap's recorded blocker ("a background size field voids the layer") does not reproduce: on gmsh-wasm 0.3.0 and 0.4.0 alike a layer coexists with a Distance+Threshold+Min background in either call order (`scripts/probe/examples/gmsh-boundary-layer.ts`). Measured on a 10×4 rectangle (wall 0.05, ratio 1.2, thickness 0.5): rows at y = 0.05, 0.11, 0.182, 0.268, 0.372, 0.4965 (exact 1.2 growth, the analytic 6 rows), 54 quads. Algorithm matrix: 2/5/6/8 grade the wall (1 only without recombination); MeshAdapt+recombine and Packing of Parallelograms abort the WASM module, BAMG throws, 3/11 silently drop the layer — those are refused up front. A 3-D generate ignores the layer with a warning.
- **`mergeFacets` on `promote_mesh_to_brep`: one planar face per near-coplanar facet.** Promotion built one OCCT face per triangle and sewed them, so cost scaled with triangle count (49.9 s for a 19 200-triangle faceted cube) and anything above 50 000 triangles was refused. With `mergeFacets` (MCP param, and the Mesh Health panel's **Merge facets** checkbox) near-coplanar triangles are grouped into facets (`meshFacetMerge.ts`) and built as one planar face each: outer loop plus holes through MakeFace + Add. Probe (`scripts/probe/examples/promote-merge-facets.ts`, identical volumes in every row): cube 12 triangles → 6 faces, 730 → 25 ms; 32-gon prism 34 faces at its analytic 780.3613; plate with a through-hole 10 faces, 336; 19 200-triangle cube 49 870 → ~700 ms; 270 000 triangles (above the old ceiling) 5.5 s. The angle alone is not the guard: a facet is merged only if every vertex is within 1e-5 × bbox diagonal of its best-fit plane AND its boundary is one CCW outer loop plus CW simple holes; anything else keeps its triangles, so a curved surface is never flattened (bug-injected: removing the planarity check turns the curved-chain test red). The 50 000 ceiling then applies to the faces left.
- **CHEXA, CPENTA and shell Nastran decks open.** Hand-authored `box-hex.bdf` (two CHEXA), `box-wedge.bdf` (two CPENTA) and `plate-shell.bdf` (two CQUAD4 + a CTRIA3, area 15) join the probe (`nastran-deck.ts`, now also pinning area), the `mcp:smoke` volume pins and the compat corpus (76/76 rows pass). They are the "right counts, wrong mesh" class the roadmap feared — and they found the two import defects below.

### Fixed

- **Two silent-geometry meshio import defects, found by the Nastran decks and affecting every meshio format, not only Nastran.** Native `convertSurface` writes only the TRIANGULAR boundary faces and silently drops quad ones: the two-wedge box read as volume 8 instead of 24 (4 facets instead of 12), and the extent guard cannot see it because the triangular end caps already touch every vertex — a mesh holding a hexahedron/wedge/pyramid/polyhedron cell now takes the extractSurface + simplexify route (`hasQuadFaceVolumeCells`). And `extractSurface` on a SHELL-ONLY mesh returns its free edges, so the plate was refused as "lost part of the geometry": shell-only meshes (`isSurfaceOnlyMesh`) are linearized in place like cad_json, and a convertSurface fragment that fails the extent check is discarded, not refused.

### Changed

- **`@loumalouomega/gmsh-wasm` bumped to 0.4.0** — the same Gmsh commit as 0.3.0 (29726e7, OCC 7.8.1; General.BuildInfo now names it) plus a `gmsh.view.*` namespace. The wasm filename and the `.cjs` entries are unchanged, so esbuild, `.vscodeignore` and `compat:vsix` need no change. Every Gmsh-gated roadmap item was re-run against 0.4.0 rather than assumed (see Documented): Relocate3D is still a no-op on the worst element (bull.stp minSICN 0.0104 before and after; the Netgen control moves it to 0.0398), healShapes still collapses daratech.stp from 1 volume to 0, and the new view namespace passed its probe — a list-based view (`addListData 'SS'`) attached through a PostView field steers a regeneration from CAD (21.0 / 3.2 / 2.1 tets per unit volume across three distance bands, near/far 10.0×, 76 ms, no abort, composing with a Constant field in the Min list); a model-based view is refused by Gmsh itself.
- **The Layer toggle appears only for parts that list edges.** A boundary layer grows along a part's wall edges, so its toggle (and the extra button that squeezed part names, "Contact faces" reading "Contac…") now appears only on a part with `edge-N` ids or one that already carries a layer so it can still be cleared. The webview case asserts exactly one toggle (on "Feature edges"); bug-injecting an always-on toggle turns it red (3 checks). `mesh-health.png` is regenerated for the new Merge facets checkbox.

### Documented

- **The gmsh-wasm 0.4.0 re-gate is recorded.** The roadmap closes planar-facet merging, boundary layers and the Nastran decks, queues two new Ready items (View-driven mesh sizing; Split a face into regions — the latter probed: BRepFeat_SplitShape_2 + Add and BRepAlgoAPI_Splitter with an edge tool take block.stp's top face 6 → 7 faces at unchanged volume 60 and area 94, halves 6 + 6) and renumbers the upstream checklist with dated results; KaHIP remains never compiled into meshio++ 17.6.0's published declarations. CLAUDE.md gains the verified view/PostView and face-split call shapes, the boundary-layer and meshio boundary traps, and the mergeFacets guard.

## [3.22.0] - 2026-10-18

### Changed

- **Auto-decimate now coarsens with mmgs under a Hausdorff bound, and the coarsened mesh heals.** `check_mesh_health` / `promote_mesh_to_brep` `autoDecimate` and the Mesh Health panel's **Auto-decimate** used meshio++'s quadric `decimate`, which closed `examples/STL/large-sphere-100k.stl` at 1 000 triangles but healed it to volume exactly 0, so promotion was refused. They now run mmgs (surface remeshing, already bundled for remeshing) with `hausd` bisected in log space until the triangle count reaches ~1 000: the sphere (99 904 → 810–870 triangles) closes at 1e-6, has no non-manifold edge and heals to within 1.7 % of 4/3·π·10³; a refined cube keeps its edges (24 triangles, volume exact); `bull.stp` tessellated (9 022 → ~850) heals closed. The `decimated` block of the report is now `{fromTriangles, toTriangles, ratio, method: "mmgs", hausd, hausdFraction, volumeDeltaPct}` (new fields: the Hausdorff bound in source units and as a fraction of the bounding-box diagonal, and the signed volume change against the raw mesh) and the panel and warnings state them. Pipeline function `decimateStlBoundary` is replaced by `coarsenStlBoundary`. The earlier "all three candidates fail" probe result was a mis-scaled input: mmgs `hausd` is absolute source units, and 1 % of the bounding-box diagonal (0.346 on the 34.6 diagonal) over-coarsens to 391 open triangles; meshio++ clustering `remesh` (17.3.0, isotropic/quadric/anisotropic, with extra repair passes) still never closes (38–40 free edges) and QEM `decimate` still heals to 0 (placement `endpoint` heals but keeps 18 non-manifold edges and drifts −2.5 %). Probes: `scripts/probe/examples/heal-coarsen.ts` (candidates) and `heal-coarsen-product.ts` (the shipped path).

### Documented

- **Partitioning probe, re-pointed at KaHIP in meshio++.** The roadmap item is now "KaHIP partitioning for Kratos MPI export". meshio++ 17.3.0's `partition` works with its SFC method (balance ≤ 1.14, but 5.7 % / 28.7 % / 38.5 % of nodes on the interface for 2 / 4 / 8 parts of `bull.stp`) and refuses `method: "kahip"` because the published build is not compiled with `-DMESHIOPLUSPLUS_WITH_KAHIP=ON`; those SFC numbers are the baseline KaHIP must beat (`scripts/probe/examples/meshio-partition.ts`). Gmsh's METIS `partition` also passes its mechanism probe (`gmsh-partition.ts`) and is kept as the fallback. Nothing ships. Boundary layers stay blocked on a new Gmsh build (`@loumalouomega/gmsh-wasm` is still 0.3.0); the roadmap now lists what that build must supply.

## [3.21.0] - 2026-10-17

### Added

- **Periodic meshing.** `MeshOptions.periodic` takes Part-name pairs (`slave`, `master`, `translation` in native mm) so the slave face's mesh is a copy of the master's, offset by the translation — for representative-volume-element studies. Each Part must resolve to exactly one surface, B-rep sources only; malformed entries are dropped, never the whole list. Probed live on block.stp (every slave node matched at exactly the translation for Delaunay, HXT and Frontal) with smoke coverage and docs.
- **Mesh booleans and holes run through manifold-3d.** Mesh `boolean`/`hole` edit ops now evaluate with manifold-3d (closed, manifold output), falling back to three-bvh-csg; initialized in the webview and the kernel worker, with `manifold.wasm` staged to `dist/manifold` and carved into the VSIX.
- **Field-driven adaptive remeshing.** `remesh_mesh` / FE Mesh → Remesh (MMG) gain `adaptField` + `adaptStrength`: the named scalar `point_data` array's ZZ error indicator drives a per-vertex target-size map (`h = base / (1 + α·e/ē)`) fed to mmg3d as a scalar metric, and the field is carried onto the new mesh with `conservativeInterpolate`. The response reports the adaptation facts (field, strength, base/min sizes, size range, ZZ global error, cells before/after, source/target conservation integrals and relative error). Linear tetrahedra only; other point/cell/field data is dropped with a warning.

### Fixed

- **Hole/boolean on a single-mesh source left the unedited mesh displayed and exported.** When the mesh is the document root, it is now edited in place instead of leaving the original on screen and in exports.

## [3.20.0] - 2026-10-16

### Added

- **meshio++ 17.3.0's binary writers, adopted as both imports and FE-mesh export targets (six new two-way formats).** meshio++ 17.3.0 (upstream PR #163, "write support for multiple binary formats") learned to write several solver-result formats; this release routes all of them whose writer accepts the bridge's actual FE-mesh input and round-trips: **Tecplot binary (`.plt`)**, **FEBio plot (`.xplt`)**, **INRIA Medit binary (`.meshb`)** (shares the routed `.mesh` reader under one format name), **MSC Marc post file (`.t19`)**, **Abaqus results (`.fil`)**, **Ansys MAPDL results (`.rst`, with a one-line ReStructuredText caveat like `.bdf`'s bitmap-font one)** and **LS-DYNA d3plot (`.d3plot`)**. Each was verified live before claiming: the writer ran on this pipeline's real `generateMesh()` MSH 4.1 (including `Mesh.SaveAll`'s 0-D vertex cells), the output re-read through meshio++'s own reader with the tetra/triangle/line classes intact, and the extension exports → re-opens → re-meshes each one (`compat` rows `export-*` + `load-*-fixture`, 73/73). Fixtures are the writers' own output (`examples/{Tecplot,FEBio,Medit,Marc,AbaqusFIL,AnsysRST,LsDyna}/two-tets.*`; regenerate with `scripts/gen-1730-fixtures.mjs`, which also pins the build's refusal of every rejected format). Layout facts, stated per family: the `.plt`/`.xplt`/`.meshb` writers keep the per-region block layout but drop the 0-D vertex-only blocks; the results-file writers keep every cell class but merge blocks of one cell type. Deliberately not adopted, upstream-named: **Tecplot SZL (`.szplt`)** (no TecIO in this build — `convert` refuses by name), **DOLFINx VTX (`.bp`)** (no ADIOS2), **neuroglancer** (vertex-only round trip — no connectivity), **`nastran_h5`** (writable, but a `.h5` route would collide with the XDMF companion convention), and the **lzma VTU codec** (the published build's pipeline whitelist is `'none', 'zlib', 'lz4', 'zstd', 'lzf'` — no meshio++-authored fixture is possible, so the read side stays unverified and unclaimed).

### Changed

- **meshio++ updated 17.2.0 → 17.3.0.** The published package's loader surface is byte-identical (`package.json`, `index.d.ts` and `src/index.mjs` — ESM-only, no `exports` map, the dynamic `import()` and the `{variant:"seq", full:true}` FULL-artifact load unchanged); only the compiled WASM grew (+558 KB, +2.1 %, OpenCASCADE/HDF5/CGNS/zstd/lz4/bzip2 codec facts re-verified live). Everything the previous release claimed keeps working: the zstd/lz4 VTU corpus rows, all four libMesh flavours, Kratos CAD JSON's IGA side channel.

### Fixed

- **`build3mf` normalizes the ZIP DOS timestamps after zipping (a pre-existing, machine-dependent red).** fflate encodes its `mtime` option through the `Date`'s LOCAL-time getters, so the fixed 2000-01-01 00:00 stamp wrote `0x0800` DOS time one timezone east of UTC and dated 1999-12-31 west of it — the committed `examples/3MF/cube.3mf` byte-equality test passed only on a UTC machine (CI) and failed on any UTC+ one. The byte-exact fixture now holds on every timezone: after `zipSync`, every local-file-header and central-directory time+date is overwritten with the intended fixed value by walking the archive header-by-header (a `PK\x01\x02` sequence inside a deflate stream can never be mistaken for a header). Reproduced under `TZ=Europe/Madrid` (6 differing bytes), fixed under any TZ.
- **Seven pre-existing harness rows that could never pass, repaired (fail-identically on published 17.2.0, verified in a worktree before touching).** Headless `load_model` of a mesh-format source carries no `meshEntities` (the inventory is B-rep-only), so the corpus rows `load-vtu-zstd`/`load-vtu-lz4`, the four `load-libmesh-*` rows and `load-cad-json` asserted a `triangles` property that does not exist on any artifact; they now use the established `{format, remesh}` row shape (generate_mesh over the file's own boundary — still failing loudly on a codec/format refusal). The `compat` runner's `EXTENSIONS` lacked `libmesh → .xda`, so `export-libmesh` wrote `out.libmesh` and failed on the extension itself; the smoke's codec/libMesh blocks pin decompressed geometry via `generate_mesh`, and its two `cad_json` load asserts now check the format (the `iga_*` block right after already pins the geometry analytically). With these, `npm run compat` is 73/73 and `mcp:smoke` runs end to end — the first time past the codec block since 17.2.0 shipped.

## [3.19.0] - 2026-10-16

### Added

- **Kratos CAD JSON (`.cad.json`) opens, and three IGA MCP tools read its exact NURBS.** The format holds a trimmed NURBS B-rep; the view shows its stored sampling linearized in place (the one bridge format whose cells ARE the surface — `convertSurface`/`extractSurface` would end at free edges). **`iga_sample`** reports the B-rep inventory and re-samples every face at any density; **`iga_refine`** refines exactly (degree elevation + knot insertion, geometry provably unchanged via the response's before/after patch facts) writing a new `.cad.json`; **`iga_evaluate`** evaluates one face at (u, v) with derivatives, unit normals and the inside-of-trimming-loops flag. A STEP/IGES source carries the same side channel in the full artifact, so the tools accept B-rep sources too (refine always writes CAD JSON). Fixture `examples/CadJson/cube.cad.json` (meshio++'s own `fitCad` solid of the STL cube; `scripts/gen-cadjson-fixtures.mjs`); smoke and corpus row `load-cad-json` pin it.
- **libMesh (`.xda`/`.xdr`) opens, and is a new FE-mesh export target.** Import routes four flavours — ASCII `.xda`, XDR-binary `.xdr`, and their gzip (`.xda.gz`) and bzip2 (`.xda.bz2`) compressed pairings (bzip2 needs the full artifact) — through the normal meshio++ bridge (fixtures `examples/libMesh/two-tets.*`, meshio++'s own writer output; `compat` rows `load-libmesh-*`; `.xdr.gz`/`.xdr.bz2` deliberately unclaimed). `export_mesh`/the FE Mesh panel gain **libMesh (.xda)** (`via: "meshio"`, plain ASCII decks — the compressed pairings are read-only here).
- **`fit_mesh_to_cad` MCP tool and a Mesh Health panel "Fit to CAD…" button.** Mesh → analytic CAD in one call: everything `segment_mesh_surface` runs (weld → `segment` → `fitPrimitives`) followed by meshio++'s `fitCad`, which replaces the patches with an exact B-rep — one trimmed plane/sphere/cylinder/cone/torus face per accepted patch plus rolling-ball fillets and blends, chamfers, vertex blends, threads (tapered and variable-pitch included) and freeform B-spline faces where no primitive fits — sewn and checked by the OpenCASCADE now linked into the full WASM artifact, written as a brand-new AP214 STEP file. The response is `fitCad`'s own report (valid B-rep check, volume/skin volume/ratio, Hausdorff deviation, face counts by kind and blend family, exact/approx edges) plus the segmentation's own fit counts; with `cadJsonPath` it also writes the solid's B-rep side channel for the IGA tools. Same gate as `segment_mesh_surface`; the skin must be closed and consistently wound (`check_mesh_health` reads the facts, `repair_mesh` rebuilds one). The panel button shares Promote's closed gate, saves via dialog (always STEP), and reports `N faces (…), volume ratio, max deviation` — flagging a solid that failed OpenCASCADE's own check even though it is written.

### Changed

- **meshio++ updated 16.42.0 → 17.2.0, staged and loaded as its FULL artifact** (`meshioplusplus_wasm_full`, sequential). The full pair is a strict superset of the lean one: OpenCASCADE 7.6.3 statically linked (STEP/IGES reading through meshio++ and the `fitCad` fit), the zstd and lz4 VTK XML block codecs — so zstd- and lz4-compressed `.vtu` files now open where the lean build refused naming the codec's build flag (fixtures `examples/VTKXML/`, corpus rows `load-vtu-zstd`/`load-vtu-lz4`) — and bzip2 (libMesh `.xda.bz2`/`.xdr.bz2`). The lean pair and both threaded (`_mt`) flavours are deliberately not shipped (`scripts/runtimeAssets.mjs` + `compat/vsix-check` enforce it); the package's `THIRD_PARTY_NOTICES.md` ships beside the artifact and README's Licensing covers the `MIT AND (LGPL-2.1-only WITH OCCT-exception-1.0)` expression and the upstream relinking route.

## [3.18.0] - 2026-10-16

### Added

- **Printability panel** (Advanced ▸ Analysis): the interactive half of `check_printability` — build direction, overhang limit, bundled process and plate, per-body sampled wall facts, per-direction overhang / plate contact / support upper bound, a "Not checked" list, and the overhang faces coloured in the view.
- **`check_printability` MCP tool.** Facts-only printability report over the welded triangles any source reduces to: body closure and volume, overhang area, plate contact and a support-volume upper bound for each of the six build directions, sampled wall thickness per body (inward rays), build-plate fit, a units-suspect flag, and every rule it cannot measure listed as `checked: false`. Optional bundled process limits (`fdm`, `sla`, `sls`, `mjf`) and build plates state their source and are starting points, not standards.
- **AMF (`.amf`) opens as a display-only, import-only mesh format** (plain XML or the zipped container) through three's `AMFLoader`: geometry, material and mesh colours (a Part colour still wins) and the declared unit seed the Units dropdown. The loader already scales to millimetres, so no extra scale is applied. Like Collada it exports to STL/OBJ/PLY/glTF/3MF and is refused by name by host-side tools.
- **VS Code registers the MCP server itself, and a snippet command covers other clients.** The extension contributes an MCP server-definition provider (launching `dist/mcp-server.js` with the editor's own Node, `ELECTRON_RUN_AS_NODE=1`), so VS Code agent mode lists it with no setup. **CAD Preview: Connect an agent…** copies a ready snippet for Claude Code, `.mcp.json`, Claude Desktop, Cursor, VS Code, Windsurf or Codex with the installed path filled in.
- **Copy reference** appends a stored query (`— query {…}`) for a face produced by the last topology-changing edit, so a pasted reference survives renumbering (`resolve_selector`).
- Curve ops (`addLine`, `addThreePointArc`, `addPolyline`, `addSpline`, `addBezier`) take `coincident: "reuse" | "independent"` for raw endpoints that land on an existing point: the coincidence is reported, **Collapse** shares the existing vertex (no twin `point-N`), and the Edits panel asks inline.

## [3.17.0] - 2026-10-15

### Changed

- **meshio++ updated 16.31.0 → 16.42.0.** API-additive; the format tables are unchanged and the existing import/export/analysis paths pass `npm test`, `mcp:smoke` and `npm run compat` unmodified.

### Added

- **`segment_mesh_surface` MCP tool.** Splits a mesh's whole surface into smooth patches and fits each with a plane/sphere/cylinder/cone/torus (meshio++ `segment` + `fitPrimitives`), facts only: per-patch fit type, residuals, raw parameters, adjacency. Mesh sources only.
- **`render_snapshot` for stl/obj/ply/gltf sources**, software-rendered by meshio++ with no Playwright/Chromium (`engine: "meshio-software"`, raw triangles, edit ops not baked).
- **`check_mesh_quality` MCP tool and FE Mesh quality gate.** Facts-only gate over the generated mesh against caller-supplied thresholds (per-clause evaluated/violations/fraction/worst cell, vacuous clauses flagged), exposed as an FE Mesh panel row beside the Gmsh minSICN summary.
- **`addPoint` coincident-point choice.** Records `coincident: reuse|independent`; the replay fold detects a point coinciding with an existing point-N and reports it as an informational note — reuse adds no entity yet counts as applied. The point form asks inline (Collapse / Keep independent).

- **Geometry display mode (roadmap 2.9).** A sixth Display mode shows the B-rep structure GiD-style: faint faces, through-solid edges, enlarged point markers, a bounding shell per solid in a stable colour, and a legend. Webview-only; selection is unchanged.

- **Per-Part material density (roadmap 2.14).** `Part.density` (g/cm³; `set_part` `density` or bundled `material` name, Parts-panel field) gives `generate_bom` Density/Mass columns and a total, and `get_mass_properties` a `massGrams` for a solid inside a Part with density. A Part without density is reported as missing, never zero.

### Fixed

- **Copy BOM tolerates rows without density/mass.** BOM rows from older payloads that omit the numeric cells render as empty cells instead of throwing on `toFixed` and aborting the copy.

### Documentation

- **Cantilever beam tutorial (roadmap 2.3, in-repo half).** End-to-end worked example with `mcp:smoke` coverage.

## [3.16.0] - 2026-10-14

### Added

- **3MF as a display-only mesh source and an export target (roadmap 2.1).** `.3mf` files open through meshio++ as import-only meshes; export produces `.3mf` as well. Colour rides both directions, and the Units dropdown is seeded from the file's unit metadata.
- **Collada (`.dae`) as a display-only, import-only mesh format (roadmap 2.1).** `.dae` files open as triangulated meshes with per-file units (metre/centimetre/millimetre/inch) honoured on import.
- **OpenSCAD include tracking, conversion cache and `color()` Parts (roadmap 2.10, 2.11).** `convert_scad` tracks `include`/`use` dependencies and caches conversions; `color()` blocks in `.scad` sources arrive as Parts. A Customizer panel exposes the file's top-level parameters.
- **`unifySameDomain` edit op (roadmap 2.4).** Merges same-domain faces in B-rep models, with a typed form and icon.
- **Snapshot display modes, section clip and clearance in interference checks (roadmap 2.12, 2.13).** Snapshots carry display modes and a section clip; `check_interference` reports clearance. `compare_models` accepts `tessellationQuality` for `includeSnapshots` with a per-side tessellation block (roadmap 2.21).
- **`tessellationQuality` on `hit_test` (roadmap 2.5).** The picking call takes an optional quality and reports the mesh it picked against.
- **Optimistic revision guard for MCP sidecar writes, agent-made edits marked in the viewer (roadmap 2.19).** Concurrent sidecar writes are guarded by revision; edits made by agents are flagged in the Edits panel.
- **Copy reference in the context menu (roadmap 2.15, first increment).** Right-click an entity to copy a quotable reference.
- **Reproducible exports.** Opt-in deterministic STEP and drawing-sheet exports (NaN STEP output is refused rather than written); `export_mesh` and the handoff manifest are deterministic. The deviation map is cross-checked against meshio++ `hausdorffDistance` (roadmap 2.7).
- **Hand-authored Nastran fixtures with pinned geometry (roadmap 1.2).** Fixed-, free- and large-field `.bdf` decks covering hand-written cards, not just this extension's own output.
- **`check_mesh_health` reports inconsistently wound edges** from meshio++ `featureEdges`.

### Fixed

- **Named-Part STEP export writing no geometry in multi-file mode.** The export now carries the part's geometry.
- **Kernel abort vocabulary recognizes the funcref table trap**, so the worker resets instead of staying poisoned.

### Documentation

- New formats, mesh tools and viewer features documented; screenshots regenerated.
- `CLAUDE.md` trimmed from ~1.2 MB to ~55 KB; the verification-gap registry is the source of truth.

## [3.15.0] - 2026-10-12

### Added

- **Structured OpenSCAD diagnostics (roadmap 1.3).** `openscad` stderr is parsed into structured diagnostics (`echo` / `warning` / `deprecated` / `error` with file and line), capped by severity so a warning is never pushed out by `echo()` chatter, with the overflow counted. Document-derived text reaches prose only inside untrusted-text markers. `convert_scad` and `load_model` return the structured list; the `.csg` importer's notes (skipped nodes, faceting) join it as warnings. Responses for non-`.scad` sources and quiet conversions are unchanged.
- **Coded MCP tool errors and unknown-parameter warnings (roadmap 2.19).** `isError` tool results now carry `structuredContent` (`code`, `message`, plus `hint`/`retryable` where applicable); the text block still leads with the original message. OpenSCAD failures get a `ScadConvertError` kind so a timeout is distinguishable from a rejection. An undeclared tool parameter warns (never throws) naming the nearest declared key, applied through a single `registerTool` wrapper instead of per-tool edits.

### Documentation

- **Roadmap extension pass (no re-ranking).** New agent-CAD comparison review plus ~25 appended items (OpenSCAD include tracking/conversion cache, `color()` as Parts, render section/display presets, interference clearance, per-Part density, quotable entity references, VS Code MCP registration, MCP revision guard, agent-edit marking, printability facts, draft/undercut analysis, hole callouts, reproducible exports; probes for planar-facet merging and MCP App inline preview; strategic kinematic mates), evidence addenda to 2.1/3.3, and four rejected-scope entries. Existing IDs and anchors unchanged.

## [3.14.0] - 2026-10-12

### Added

- **Point-N references on curve ops.** The eight curve ops accept point-N ids (bare or `{id, at}`), resolved in the replay fold with a strict policy (re-anchor by position with a warning, else skip with a diagnostic), written back headlessly, and bound in the curve forms via Use picked points.
- **Typed command bar.** `<command> [<json>]` input with `$sel` by field type, history, Tab completion, panel echo through `EditsModel.onPush`, and skipped-op reporting. `OP_PARAM_DOCS` and the rejection explainer moved to the pure `src/opCommands.ts` (`mcpTools.ts` re-exports it).
- **OBJ `.mtl` materials and PLY vertex colours (roadmap 2.1).** An OBJ's `.mtl` (`Kd` and `map_Kd`) and a PLY's vertex colours now render, survive the facet split, yield to a Part colour and return when it is removed, and keep working in Flat mode. MTL loading is webview-only so the headless bake's `node-N` ids are unchanged; the `isSafeRelativePath` rule is shared with glTF buffers.
- **Draco and meshopt compressed glTF (roadmap 2.1).** `KHR_draco_mesh_compression` and `EXT_meshopt_compression` are decoded in the kernel worker into reserved `decoded:` entries consumed by the synchronous glTF parser; the webview attaches `DRACOLoader`/`MeshoptDecoder` under an updated CSP. Adds Draco/meshopt fixtures, packaging, tests and docs.

### Changed

- **Post geometry before the XCAF assembly tree.** The interactive STEP path posts geometry with the flat tree first; a second `tree` message (`upgrade: true`) swaps in the nested hierarchy once `resolveAssemblyTreeForDocument` finishes. MCP `loadBRep` is unchanged.
- **Handle-free deferred XCAF resolve with one retry after an OCCT reset.** `solidSigs` fingerprints solids at load time so the deferred resolve job never touches live shape handles; the kernel worker retries a handler once after an OCCT abort reset.

### Fixed

- **Treat `function signature mismatch` as a WASM abort.** The kernel child could stay poisoned after a save-in-place because the bare V8 phrase matched none of the abort vocabulary, so no reset ever happened. All kernel services now match it, and kernel error stacks are logged when tracing is on.
- **Opt-in kernel job queue tracing.** `CAD_PREVIEW_KERNEL_TRACE=1` (set by the integration harness) logs enqueue/start/settle/cancel/spawn/exit to stderr so a stuck queue shows up in CI logs instead of as a silent timeout.

## [3.13.0] - 2026-10-09

### Added

- **Layers, distinct from Parts.** A named presentation/drawing layer (`<model>.layers.json`, the seventh sidecar) answers which entities are shown, locked or drawn together — never which form a finite-element sub-model. Each entity sits on at most one layer; unassigned entities sit on the implicit Default layer, which cannot be deleted. Membership rebinds across topology-changing edits through the same geometric pass Parts use (reported, never silently repointed); layer ids are allocated off a persisted counter so a deleted id is never recycled. A locked entity stays selectable for measurement but refuses as an edit operand and Transform Gizmo target, host and webview alike, with a named diagnostic. The Layers panel sits beside Parts (persisted visibility eye, lock button, assign-selection); headless parity is `list_layers` / `set_layer` / `assign_layer` plus `layers` in `get_state` (`tools/list` 71 → 74). Meshing and mass properties never read layers — a hidden layer is still meshed. The drawing exports take an optional `layers` filter (one output group per layer: SVG `<g>`, DXF `LAYER` table with ACI colours and collision prefixes; absent = every layer; B-rep only). Verified with unit tests (2607 passed), `mcp:smoke` fully green (1111 checks), Playwright webview suite (789 checks), real-VS-Code integration suite (287 checks), compat corpus (43 rows), and a regenerated `viewer-main.png`. Closes roadmap 2.8.

## [3.12.0] - 2026-10-08

### Added

- **Conformal multi-body meshing.** `MeshOptions.conformal` (default on) calls `gmsh.model.occ.fragment` over every imported solid before meshing, so touching solids share interface nodes instead of meshing independently with duplicate, non-coincident nodes on the shared face. Parts resolve after the renumbering, so physical groups and Kratos SubModelParts survive per body. Probed live on gmsh-wasm 0.3.0: two touching 10 mm boxes go from 44 duplicate interface-node pairs to 0 shared nodes at an unchanged element count; a single solid is identical with and without (block.stp 381 nodes / 1282 elements either way), so default-on is safe. `generate_mesh` reports `conformalApplied`, the handoff manifest records it, and the FE Mesh panel gains a **Conformal** checkbox (B-rep multi-solid only; greyed for mesh sources and under fTetWild, which ignore it). A failed fragment refuses with no mesh produced — retry with `conformal: false` — rather than certifying a mesh that is neither the requested conformal result nor a clean fallback.
- **Mesh optimisation modes.** `MeshOptions.optimize` moves from boolean to `"none"` / `"default"` / `"netgen"` / `"highOrder"` (pre-enum `true`/`false` still parse as `default`/`none`, so every existing sidecar, preset and MCP caller keeps working). `"none"` skips even the generate-time `Mesh.Optimize` flag; `"default"` is today's behavior; `"netgen"` additionally runs `model.mesh.optimize("Netgen")` and `"highOrder"` runs `optimize("HighOrderElastic")`, order-2 only. Probed live on bull.stp: Netgen gives a repeatable min/mean gain but refines (+42% elements on the fixture) and linearizes a quadratic mesh (tet10 → tet4, warned, never silent); HighOrderElastic drops Jacobian invalids 9 → 4 on the same fixture (an improvement, not a guarantee), while a linear mesh warns and runs the default instead since that path is unprobed. `Relocate3D` was probed bit-identical worst-element minSICN and is deliberately not offered. The FE Mesh panel's Optimize checkbox becomes a dropdown (Off / Default / Netgen / High-order elastic), presets treat `optimize` as a Gmsh-only field, and the `.geo` script notes a post-pass mode in a comment since `model.mesh.optimize()` has no script equivalent.
- **Jacobian validity for high-order meshes.** Order-2 volume meshes now also report `QualitySummary.invalidElements`: elements with a negative Jacobian determinant at any tet10 node via `gmsh.model.mesh.getJacobians(11, <10 interpolation nodes>, -1)`. Probed live: 9/9 coincidence with `minSICN <= 0` on bull.stp (20/20 on 4pinplug.stp, none on a linear mesh), so the count is independent analytic certification rather than broader detection, and it drops 9 → 4 alongside minSICN under `"highOrder"`. A `getJacobians` throw or length mismatch omits the field rather than failing the generate; non-tet10 quadratic types are out of scope. The FE Mesh panel shows it as `N invalid (Jacobian < 0)`; the worst-elements overlay is unchanged since its 0.2 threshold already covers invalids.
- **Structured meshing per Part.** A Part can carry `meshStructured: { divisions }` (integer ≥ 2 nodes per meshed edge, a count never unit-converted) via `set_part` or the FE Mesh panel's **Struct** row. The kernel applies transfinite constraints — `setTransfiniteCurve` on every curve of the part's entities (volumes pull in their boundary surfaces and those surfaces' bounding curves), plus `setTransfiniteSurface`/`setRecombine` per surface and `setTransfiniteVolume`/`setRecombine` per volume — and a kernel rejection throws naming the part, never a silent unstructured fallback. Probed live: a whole-solid box at 6 divisions is exactly (6−1)³ = 125 hexahedra with zero tets, coexisting with unstructured neighbours through pyramid transitions, and MDPA carries `Element3D8N`/`Hexahedra3D8` with a populated SubModelPart; a non-regular region (bull.stp) fails loudly instead of hanging.
- **OpenSCAD: backend, library paths and Customizer parameters.** `cadPreview.openscadBackend` (`auto`/`cgal`/`manifold`, headless twin `OPENSCAD_BACKEND`) passes `--backend=<engine>`; `auto` passes no flag so a stock OpenSCAD keeps working, and a rejected flag names itself in the error. `cadPreview.openscadLibraryPaths` (headless twin `OPENSCADPATH`) prepends folders such as BOSL2/MCAD for the conversion child only. `list_scad_parameters` reads a `.scad` file's Customizer parameters from its text (top-level `name = literal;` before the first module/function, with type, default, group, description and range — no binary needed), and `convert_scad` re-evaluates with validated `-D` overrides into a new `.csg`, leaving the source untouched; unknown names and wrong types are reported, not applied. Includes `examples/OpenSCAD/parametric.scad`. Manifold was verified only through stub binaries here (no OpenSCAD binary available) and is registered as a verification gap.

### Fixed

- **Mesh booleans and holes on real files no longer throw inside the CSG evaluator.** `three-bvh-csg` interpolates position/uv/normal across every operand, so a geometry missing any of the three throws an uncaught `TypeError` in `evaluate()` — and no loader or tessellator here writes `uv` (only three.js primitives carry it, which is exactly what every unit test built with, so the suite stayed green while every real-file boolean and hole threw). Geometries now get a zero `uv` on the way into each `Brush`; uv-carrying meshes keep their interpolated uvs and the result stays exporter-safe. Found live by the manifold-booleans probe.

### Security

- **`@modelcontextprotocol/sdk` 1.30.1 → 1.31.0 closes Dependabot alert GHSA-6qxp-vccf-f47h (high, CVSS 7.5).** The advisory covers SDK releases from 1.12.0 up to, but not including, 1.31.0: the SDK's OAuth client could send credentials to an authorization server chosen by the MCP server. The MCP server bundle does not include that client code, and 1.31.0 changes only the OAuth/auth modules and their examples, so the server's tools are unchanged. 1.31.0 is the smallest patched release; 1.32.x also changes the server core and is left for a separate pass. `npm audit` reports no vulnerabilities after the change.

## [3.11.0] - 2026-10-06

### Added

- **MMG remeshing for FE meshes.** **FE Mesh → Mesh ops · Remesh (MMG)** and the headless `remesh_mesh` MCP tool refine/coarsen a linear triangle/tetra mesh under MMG control parameters (`hausd` defaulting to 0.5% of the bbox diagonal, plus `hmin`/`hmax`/`hgrad`). Two input modes: the original meshio-readable FE file, or freshly generated edited geometry with current settings/Parts. Output is always a new `.med` file plus a rebound `.parts.json` sidecar; the source is never overwritten and existing outputs are refused. Named cell regions survive through integer references (including overlaps); Parts are rebuilt against new facet ids with matching colours/sizes. Result fields and point/side groups are dropped with warnings; hex/quad/pyramid/prism/quadratic input is refused rather than converted. This is ordinary remeshing, not an automatic quality optimiser or post-Generate pass. Verified with `npm run build` + `tsc` clean, unit 2516 passed, webview 758 checks, host integration 277 checks, compat corpus 41 rows, packaged-VSIX asset and isolated-runtime MMG checks, live product probe (material volumes preserved, sphere error within bound), `docs:build` clean, and real-pipeline screenshots (`mmg-remesh.png`, `mmg-remesh-result.png`). Closes former roadmap task 4.17 (PR #93).

## [3.10.1] - 2026-09-30

### Fixed

- **Mesh generation no longer leaves Gmsh's thread count to chance — and checks the pin rather than assuming it took.** Every Gmsh prepare (Generate, every export format, `.geo_unrolled`) now sets `General.NumThreads` and `Mesh.MaxNumThreads1D`/`2D`/`3D` to `1` and then **re-reads all four**, throwing `Could not enforce <key>=1` if any of them came back as something else. The read-back is the point: a cap that silently failed to apply is indistinguishable from no cap, which is the same failure mode as the dead worker pool this extension already had to fix once — a bundled gmsh spawns its Emscripten pthread pool eagerly at `initialize()` (4 workers, confirmed), and each one re-executed the bundle and died on `require("vscode")`, leaving the main thread to block forever on a pool that could never come up. That is fixed at the packaging layer (the package stays `external`, so its workers start on a real standalone file); this is the second, cheaper layer — nothing now depends on that packaging rule alone to keep meshing single-threaded, which is the same posture fTetWild already has by loading its serial WASM build (`{ threads: false }`) and OCCT has by running only inside the one serialized kernel-queue call. **No visible mesh change, and that is measured rather than assumed:** against the shipped `@loumalouomega/gmsh-wasm` 0.3.0 (Gmsh 5.0.0-git-29726e7) the defaults were *already* `General.NumThreads=1` with the three `Mesh.MaxNumThreads*` at `0` (Gmsh's "unbounded", which a `General.NumThreads=1` build never actually reaches). So the `0`s becoming an explicit `1` changes what is *verified*, not what is produced — confirmed by reverting the hunk, rebuilding, and diffing the whole 1039-check live harness run against the capped build: every Gmsh-path result is identical (`generate_mesh` 610 nodes / 1712 elements in all three runs, the sweep's size-encoded outputs unchanged, the OCCT promote/repair byte counts unchanged), and the only lines that differ are the ones that differ between any two runs of the *same* build — the harness's random tmpdir, timestamp-derived annotation ids, elapsed-ms, and **fTetWild's own counts** (2406 vs 2376 nodes for the same holed cube, across two runs of one unchanged build, so that variance is the tetrahedralizer's and predates this change). Two details worth keeping: the live WASM returns `{value: 1}` from `option.getNumber`, not a bare number (the read accepts both shapes), and `General.Cpu` does not exist in this build, so it is not part of the check. Verified with `npm run compile` and `npm run build` clean, `npm run mcp:smoke` fully green (**1039 checks**, including every generate/export path this cap sits in), `npx vitest run` at 2474/2474, and CI green end to end on the release commit (unit, docs, the Playwright webview suite, the real-VS-Code integration suite, and `.vsix` packaging with its runtime-file check).

### Known issues

- **`@modelcontextprotocol/sdk` is still behind (1.30.1 → 1.31.0)**, unchanged from 3.10.0 and still left for a separate pass so this release's diff keeps a single variable. `three` remains current at 0.186.1.
- **`npm audit` reports one moderate advisory the manifest's own override does not actually close.** `fast-uri` is flagged for `GHSA-hrr3-gc8f-f4qj` (inconsistent host case normalization via percent-encoded octets) over the range `3.0.0 - 3.1.7` — and `package.json` pins exactly `fast-uri: ^3.1.7`, so the installed 3.1.7 is *inside* the vulnerable range and the patched release (4.2.1) is a major bump away. It is transitive and dev-only (`@modelcontextprotocol/sdk` → `ajv` → `fast-uri`), reached through the MCP server's schema validation rather than through the viewer or the kernel, so it is not on the shipped mesh/preview path — worth fixing, but as a deliberate dependency decision rather than a blind `npm audit fix`, which would move a major version under a transitive path.

### Note for whoever verifies this next

- **The two failures this release originally recorded here were not real — they were a stale local `node_modules`.** A pre-`npm ci` tree was serving `@meshioplusplus/wasm` **10.21.1** against a lockfile pin of 16.27.0 (and `three` 0.185.1 against `^0.186.1`, `@modelcontextprotocol/sdk` 1.30.0 against `^1.30.1`), which produced two convincing-looking reds: `scripts/compat/runtime-packages.test.mjs`'s `instanceof BigInt64Array` assertions (10.21.1 predates the v11.2.0 change that made integer arrays cross the WASM boundary as bigints, so they correctly fail there) and an `mcp:smoke` stop on `generate_mesh` of an exported `.xdmf` with `XDMF: unknown mixed topology index`. **After `npm ci`, both are green** — 2474/2474 unit and the full 1039-check smoke run. Both also looked pre-existing because each was reproducible by reverting the release's own hunk, which is exactly the trap: a stale tree reproduces identically with and without your change, so "not caused by this change" is not the same claim as "present upstream". Worth remembering that `npx vitest run` and `npm run mcp:smoke` only mean something against the lockfile, and that CI, which runs `npm ci`, was the only signal that disagreed.

## [3.10.0] - 2026-09-29

### Fixed

- **Opening a `.bdf` Nastran deck this extension exported now works end to end.** `.bdf` has been routed as a Nastran bulk-data deck for a while, with the missing `BEGIN BULK` line added on read — but the deck this extension's own Gmsh export produces, `examples/Nastran/block-tets.bdf`, was then rejected by the mesh reader, so the file opened as a route you could select and nothing more. It is not a limitation any more, and the smoke test had been pinned to the *failure* string rather than to success, which is how a stale expectation survives a fix. A normalized deck now reads, converts to a 60-facet boundary spanning exactly 3×4×5 (the source model's own extents), meshes (1255 elements), and round-trips through an exported `.bdf` that reopens and re-meshes. The smoke test now asserts the analytic volume 3×4×5 = 60 instead of the absence of an error, because "did not throw" is the kind of check that passes just as happily on wrong geometry. **The one remaining caveat is unchanged:** every `.bdf` fixture here is this project's own output, so a deck written by a real Nastran tool — `GRID`/`CQUAD`/`CTETRA` cards, free- or small-field formatting, continuation lines, a solver section — is still unverified. That is recorded as the rest of the roadmap item, not as something this change claims.
- **meshio++ upgraded from 16.22.0 to 16.27.0.** Five releases of drift, verified against the published packages rather than a changelog: the loader rules this extension depends on are unchanged (it is still ESM-only with no `require` condition, so the load stays a dynamic `import()`; the sequential build is still the one selected; its console output still cannot reach the MCP server's JSON-RPC stream; the four files staged into the packaged extension are byte-for-byte the same set), and the mesh data behaves identically on every committed fixture — MED/MDPA/GiD/Nastran/OpenFOAM all still load, mesh and export exactly as before, the region→Parts correlation still reads the same parent-cell array, and the CAD-to-mesh colour-by-field path returns the same values. The EnSight boundary defect that keeps `.case` un-routed is unchanged at exactly half the source extent, and is still caught by the guard that refuses it rather than displaying a wrong model. The bundled sequential WASM grows 257 KB (+2.2%).

### Known issues

- **`@modelcontextprotocol/sdk` is behind (1.30.1 → 1.31.0), along with three dev-only packages.** The weekly dependency watch reports it and it is left for a separate pass, so this release's verification diff has exactly one variable. `three` is already current at 0.186.1 and needed nothing.

## [3.9.0] - 2026-09-29

### Added

- **A point or straight line you place in the model can be meshed on exactly.** The **Point / Line / Arc** tool appends standalone wireframe geometry that belongs to no face, and assigning one to a Part previously had no effect on the mesh: Gmsh's STEP importer drops such free geometry when it reads the exported file that is the meshing input, so the load or sensor location you picked landed somewhere inside an element and a solver had no node to attach to. A Part's free point or straight line is now created in the mesher's model directly, so a node lands **exactly** on it — and the Part's own group holds that node, which is what makes it reachable through the Part's Kratos `SubModelPart`, the block a solver reads to apply a boundary condition. It needs no new setting and no new tool: the existing Part assignment is the entire trigger, so ▶ Generate in the viewer and headless `generate_mesh` / `export_mesh` / `export_mdpa` all get it identically, and a Part on an *existing* vertex or edge is left completely untouched (same mesh, 381 nodes, with and without). A **curved** free edge cannot be expressed as a two-endpoint line, so it is reported by name in the generate/export warnings and the model meshes normally without it, rather than being quietly replaced by its chord — the one deliberate narrowing, since a wrong chord is a wrong mesh that looks right.

### Fixed

- **Dependabot alert for `ip-address`** (CVE-2026-101910, medium) resolved by a lockfile bump, 10.4.0 → 10.7.2. It is transitive — `@modelcontextprotocol/sdk` → `express-rate-limit` — so no manifest changed. Worth recording that it was never reachable in the shipped extension: neither the extension bundle nor the MCP-server bundle inlines it, and `node_modules` is excluded from the `.vsix`. Still fixed, because a lockfile pin below a patched version is a real supply-chain liability for anyone installing from source.

### Known issues

- `npm run mcp:smoke` still has one stale assertion, unchanged from 3.7.0: it expects a Nastran bulk-data limitation that meshio++ removed several releases ago, so it fails with "unexpected success". The compatibility corpus was updated for this; the smoke assertion was not. CI does not run this harness, which is why it went unnoticed. Everything else in that harness passes (633 checks), including the 17 new ones for the feature above. Because a failed assertion stops the run, the new block is deliberately placed before it.

## [3.8.0] - 2026-09-28

### Added

- **A mesh refinement sweep can be cancelled while it runs.** A sweep meshes one model at several sizes to compare meshing cost and element quality, and until now it could be started but not stopped: the kernel already cancelled in-flight work on both surfaces, but the sweep loop itself never checked for it, so a long sweep had to be waited out. The sweep section of the FE Mesh panel now has its own **Cancel** button. It is deliberately not wired through the panel's existing busy state, which would also have disabled Generate and Export for the sweep's duration — a behaviour change well beyond making a sweep cancellable. A sweep stopped part-way through a size reports that size as a failed row rather than pretending it completed, and the option to persist one run's options as the document default is skipped for a cancelled sweep, so a cancelled run can never silently apply whichever size happened to be in progress.
- **The headless render tools can trade speed for picture quality, and now report which they used.** The `draft`/`standard`/`fine` tessellation presets already existed as a VS Code setting, but they reached only the interactive viewer: an agent calling `render_snapshot`, `screenshot_shape` or `render_ops_prefix` always got the one default density, with no way to ask for more and no way to find out what it had. All three now take an optional `tessellationQuality`, and the response reports a `tessellation` block naming the quality actually used together with its deflections and the resulting triangle count — without which "does `fine` really give me a denser picture?" has no answer at the call site, since comparing image bytes would prove *a* difference rather than density. Omitting the parameter is indistinguishable from passing `standard`, which is the density every render has always used, so no existing call changes. An unrecognized value warns and falls back to `standard` rather than quietly rendering at a density nobody asked for. This deliberately does not follow the `cadPreview.tessellationQuality` setting, which is an interactive-viewer preference: an agent's render stays reproducible regardless of a user's editor settings. `compare_models`' optional snapshots are not covered by this yet.

### Known issues

- `npm run mcp:smoke` still has one stale assertion, unchanged from 3.7.0: it expects a Nastran bulk-data limitation that meshio++ removed several releases ago, so it fails with "unexpected success". The compatibility corpus was updated for this; the smoke assertion was not. CI does not run this harness, which is why it went unnoticed. Everything else in that harness passes (616 checks), including the new render-quality assertions.

## [3.7.1] - 2026-09-27

### Changed

- **meshio++ upgraded from 16.21.0 to 16.22.0.** No user-visible behavior change: the upstream release is documentation-only — its own changelog states that no reader, writer or operation output changes. The published package's JavaScript API surface and loader are byte-identical to 16.21.0, and every loading rule this extension depends on was re-verified live against both versions: it remains ESM-only (so the load stays a dynamic `import()`), the sequential build is still the one selected, its console output still cannot reach the MCP server's JSON-RPC stream, and the four files staged into the packaged extension are unchanged. The release's larger advertised format count is a correction of an undercounted claim, not new format support, so nothing new becomes importable.
- Two inaccuracies in this repository's own notes about meshio++ were corrected: the EnSight fixture's write-up claimed the native surface conversion throws on that deck (it does not — it succeeds and silently returns the wrong geometry, which is the more serious behaviour the accompanying guard exists to catch), and the recorded WASM size and integer-array behaviour were stale.

## [3.7.0] - 2026-09-26

### Added

- **Recoverable mesh save-in-place.** Saving a mesh source (STL, OBJ, PLY) writes the geometry and *then* advances the edit history's save watermark. A process that stopped between those two writes left the file baked while the history still said otherwise, so reopening replayed the same edit over geometry that already contained it. A `<model>.save-journal.json` transaction marker now makes that recoverable: on the next open the save is completed, discarded, or — if the file matches neither expected state — reported and never guessed. A source edited by something else in the meantime is left byte-identical unless you explicitly choose to restore the backup.
- **Performance benchmarks for meshio++ and OpenSCAD loads.** `npm run perf` measured only the B-rep load and mesh paths, so a regression in either of the other two loaders would surface only as a user report. Both are now benchmarked, with a per-family warm-up so each is measured at steady state rather than paying its first-call initialisation.
- **The dependency monitor is verified against GitHub.** It ran once by manual dispatch, opened its tracking issue, and re-running reported no change — confirming the marker-based lookup works against the real API and not just the test double.

### Changed

- **meshio++ upgraded from 16.16.0 to 16.21.0; Three.js from 0.186.0 to 0.186.1.** Kernel loading is unchanged in every audited respect. The new release adds deck writers, an EnSight Gold reader fix, and broad read-path speedups (up to 3.5× on some text formats).
- **A meshio import's boundary surface is now checked against the mesh it came from.** A boundary that silently lost part of a model's geometry would display a wrong model with nothing warning — and one format does exactly that, so its import is refused rather than shown wrong. The check is exact rather than heuristic, and none of the supported formats trip it.

### Fixed

- **Batch export no longer fails a whole batch on a kernel reset.** An OCCT memory-access abort resets the kernel worker, which respawns on the next call; the export now retries once, exactly as the other export paths already did. Ordinary errors are never retried, and a second abort is reported as a failure.
- A batch export that produced fewer files than expected now names which input failed and why, instead of only listing what reached disk.

### Known issues

- `npm run mcp:smoke` has one stale assertion: it still expects a Nastran bulk-data limitation that meshio++ removed two releases ago, so it fails with "unexpected success". The compatibility corpus was updated for this; the smoke assertion was not. CI does not run this harness, which is why it went unnoticed.

## [3.6.0] - 2026-09-26

### Added

- **Embedded kernel runtime loading.** meshio++ and fTetWild runtime files are staged beside the CJS bundles, and their loaders resolve either installed packages or the staged layout used by embedded applications.
- **Weekly dependency watch.** A scheduled workflow checks OCCT, Gmsh, meshio++, fTetWild, Three.js and the MCP SDK, and creates or updates one issue when versions trail npm.

### Changed

- **meshio++ upgraded from 16.7.0 to 16.16.0; MCP SDK upgraded from 1.30.0 to 1.30.1.** Compatibility checks retained MED, CGNS and GiD metadata fallbacks, while the new meshio++ release fixes mixed-topology XDMF remeshing.

## [3.5.0] - 2026-09-25

### Added

- **Headless mesh-edit replay.** Edits made to a mesh-format model (STL, OBJ, PLY, glTF, or a meshio++ import) used to replay only in the viewer, so every headless tool saw the raw file. They are now baked by the same engine the viewer uses, so `generate_mesh`, `export_mesh`, `compare_mesh_refinement`, `measure_mesh_deviation`, `compare_models`, the drawing tools and `CAD Preview: Export Mesh` all mesh, compare and draw the edited model. A translated cube's exported mesh now moves by the translation.
- **`save_model` accepts STL, OBJ and PLY sources.** It bakes the pending edits into the file in its own format, keeps a one-deep `<model>.bak`, and records the save point, exactly as it does for STEP, IGES and BREP. glTF is still refused, because its exporter only writes binary `.glb`.

### Changed

- Where these tools used to warn that pending mesh edits were "NOT baked in", they now report the facts: `Baked N of M pending mesh edit op(s)`, plus one line for each edit that could not apply, with its index, kind and reason. If the bake itself fails, meshing falls back to the raw file and says why; `save_model` throws before writing anything.
- Mesh loading is shared between the viewer and the kernel worker (`src/webview/meshObject.ts`), so `node-N` edit targets mean the same object in both.
- `doc/roadmap.md` task IDs were renumbered after the headless mesh-edit replay item closed (section 2 is now `2.1`–`2.8`); headings keep their anchors, so existing links are unchanged.

### Not yet baked

Mesh `inspect`, `get_mass_properties` and `measure` (their ids are defined over the raw file), `promote_mesh_to_brep`, `repair_mesh`, and the inspection sections of the preparation report still read the raw file, and their responses say so.

## [3.4.0] - 2026-09-25

### Added

- **Refinement sweep in the FE Mesh panel.** A collapsed **Refinement sweep** section meshes the same model at several explicit sizes and shows nodes, elements, time and quality per run, with a note that density and quality trends do not establish solver convergence. It can write one `.msh` per run into a folder you pick, and **Copy TSV** copies the table. The panel and the `compare_mesh_refinement` MCP tool now run the same loop.
- **Copy hole table.** A Parts-header button copies the hole schedule (`generate_hole_table`'s TSV) for B-rep sources.
- **Free-text notes.** Right-click a face, edge or point and choose **Pin note…** to pin a short note, saved with the other annotations and baked into drawings as a label. `pin_annotation` accepts notes too.
- **Export FE mesh from mesh-format sources.** `CAD Preview: Export Mesh` now works for STL, OBJ, PLY, glTF and meshio++ sources, not only B-rep ones.

### Changed

- **Roadmap tasks are numbered.** `doc/roadmap.md` gives every item a task ID (`1.1`, `2.3`, `4.10`) in its heading and in the order tables, and its sections are numbered 1–6. IDs are renumbered at each planning review, so code and other docs still cite items by name; every heading keeps an explicit anchor, so existing links are unchanged.
- The KKSS source build renders `render_snapshot` images from its bundled MCP worker.

### Fixed

- Planar (2D) Kratos MDPA export now writes surface cells as Elements and curve cells as Conditions, with line boundaries, instead of the 3D layout.

## [3.3.0] - 2026-09-24

### Added

- **B-rep health report.** A new `check_brep_health` MCP tool and a **B-rep Health** panel (Advanced ▸ Analysis) report OCCT's own validity checks over the edited model: per-solid, shell, face and edge statuses (for example `UnorientableShape`, `NotClosed`), open-boundary edges, and loose wireframe edges, each tied to the entity ids the rest of the tool uses. Hovering an issue row highlights it in the viewer. It is read-only and repairs nothing, and it is an explicit action rather than something run on open (the analyzer alone takes about 9 s on a 2.3 MB STEP file).
- **Nastran `.bdf` import.** Bulk-data decks open as a triangulated boundary through meshio++ (routed as the `nastran` format), including the Gmsh-style decks this extension itself exports, which carry no `BEGIN BULK` line and are normalised on read. `.bdf` is an ambiguous extension, so opening one shows a status note saying it is assumed to be a Nastran mesh.
- **Probe harness.** `npm run probe -- <entry.ts>` bundles a TypeScript entry against the real WASM kernels and runs it under Node, so live-kernel findings can be reproduced instead of living in throwaway scripts. The Node/CJS bundling recipe is now shared in `scripts/nodeBundleConfig.mjs` by the extension, MCP server, kernel worker, screenshot fixtures and the probe runner.

### Changed

- **Relicensed from `GPL-2.0-or-later` to `GPL-3.0-or-later`.** `LICENSE` now carries the verbatim GPLv3 text, and `package.json`, `package-lock.json`, the README's Licensing section, the docs footer and the PR template match. Nothing bundled today requires more than `GPL-2.0-or-later` (Gmsh's own licence is still compatible with either); the change is made ahead of the "Build and bundle an OpenSCAD WASM port" roadmap item, because a real OpenSCAD build links CGAL (GPLv3-or-later / LGPLv3-or-later) and/or Manifold (Apache-2.0, GPLv3- but not GPLv2-compatible), which forces a `GPL-3.0-or-later` floor. Doing it now avoids a second licence change when that dependency lands. Versions already released remain available under `GPL-2.0-or-later`.
- **meshio++ upgraded from 10.21.1 to 16.7.0.** Integer point and cell data arrays now arrive from the WASM as `BigInt64Array`, which would silently break region-to-Parts correlation and integer colour fields if left unconverted, so they are converted on read. meshio++'s new native header-only metadata scan under-reports regions and data arrays for MED, CGNS and GiD files, so those three read metadata from a full read instead.
- The mesh handoff manifest now states plainly whether boundary coverage was checked. Physical-group coverage is reported as unavailable for mesh-format sources, and manifest notes are reported as warnings.

### Fixed

- `getGmshVersion` always returned "Gmsh version unavailable", because gmsh-wasm returns `option.getString` as an object rather than a bare string; both shapes are now read. Nothing consumed it yet (handoff manifests use build-stamped package versions), so no exported output was ever wrong.

### Documentation

- `doc/roadmap.md` is restructured into upkeep, ready work, probe-gated items grouped by area, and strategic bets. It gains a meshing-library review (MMG remeshing, meshio++ field transfer, untapped Gmsh features), a kernel-capability review, an ecosystem review, a note on what the relicense unlocks, and about thirty new evidence-backed items; the OpenSCAD WASM port replaces the old "Bundling `openscad-wasm`" Non-goal, and the CGAL Non-goal is reworded since its licence reason no longer applies.
- Two stale entries in the Known limitations list are corrected: hidden-line removal exists through **Export Technical Drawing**, and tessellation runs in the forked kernel worker, not in the extension host.

## [3.2.0] - 2026-09-23

### Added

- **Owned FE-mesh jobs.** The webview assigns one request UUID per Generate/Export; the extension host and the standalone MCP server attach stable owner/request IDs to the serialized kernel queue. Cancelling removes only that owner's queued work or terminates only its active worker call.
- **Durable mesh execution receipts.** Queue-managed `export_mesh` writes an atomic, versioned receipt before dispatch and exposes owner-checked `cad_job_status` / `cad_job_cancel`. After a restart, a receipt with no live kernel record reports `uncertain` and is never replayed automatically.
- **Versioned mesh handoff manifests** produced by the mesh export path.

### Changed

- The FE Mesh panel's Cancel button is hidden when there is nothing to cancel, and the mesh action row stays usable in narrow panels.
- A cancelled mesh export no longer writes its output file.

### Fixed

- The packaged `.vsix` now contains only CAD runtime assets.

## [3.1.0] - 2026-09-23

Eleven items closed, all headless-side or additive, plus two correctness fixes to how the kernel and the sidecars behave under concurrent access — no sidecar schema changes, no breaking MCP changes.

### Added

- **Meshing preparation tools.**
  - **Mesh-aware surface tessellation export** (`export_tessellated_stl`, and Export ▸ STL ▸ *Mesh-aware…*): derives the B-rep tessellation's linear deflection from a downstream target cell size instead of the viewport, and reports the sampled chordal error against the requested tolerance.
  - **Mesh size and memory budget preview** (`estimate_mesh_budget`, and a readout in the FE Mesh panel): a calibrated element-count/memory estimate from real volume/area, before you generate.
  - **Narrow-gap and passage resolution preflight** (`analyze_passages`, and a Passages panel under Advanced ▸ Analysis): finds annular passages between coaxial cylinders and thin slots between facing planes, reports cells-across against the requested size, and can apply a suggested local size as a Part.
  - **CAD-to-mesh deviation map** (`measure_mesh_deviation`, and a *Deviation* button in FE Mesh): samples distance from the CAD tessellation to the generated mesh boundary in both directions, with per-face failures and an optional PLY export carrying the distance field.
- **Drawing-sheet settings and reusable templates.** Title block fields (author, drawing number, revision, material), a `template`/`libraryPath` pair on `export_drawing_sheet`, `save_sheet_template`/`list_sheet_templates`, and a small webview form replacing the sheet export's two quick-picks.
- **Batch export** (`batch_export`, and a *Batch Export…* command): exports many files to one target in one run, with a per-file result row — a bad file becomes a failed row, never an aborted batch — and a read-only report panel.
- **Simulation handoff manifest** (`export_mesh {manifest: true}`, a *Handoff manifest* checkbox in FE Mesh, and `check_handoff_manifest`): a receipt beside a mesh export recording the source and edit-history hashes, resolved Part→physical-group mapping, boundary coverage, Kratos SubModelPart sizes, and the kernel versions used, so a later call can tell whether the export has gone stale.
- **Preparation report bundle** (`generate_prep_report`, and a *Preparation Report…* command): a self-contained HTML (plus JSON) report assembling mass properties, BOM/hole table or mesh health, mesh quality, deviation, passage findings, budget-vs-actual, and the handoff manifest — each section filled by the same tool an agent would call directly.
- **Dependency and format compatibility corpus** (`npm run compat`): a table-driven suite covering every import format, every meshio export writer, and known upstream limitations, plus a packaged-extension content check (`npm run compat:vsix`) now run in CI.

### Changed

- **Kernel jobs are now scoped to their owner** (a document tab, an MCP request, or a batch run). Cancelling one no longer risks killing another's in-flight kernel call; a queued-but-not-yet-sent job is dropped without ever reaching the kernel. There's a per-call timeout and a `cadPreview.kernelTimeoutMinutes` setting.
- **External sidecar/source changes while you have unsaved local edits now prompt** ("Reload from disk" / "Keep mine") instead of silently overwriting whichever side wrote last. A source-file replacement with unsaved edits pending prompts the same way instead of reloading unconditionally.

### Fixed

- **`compat:vsix`'s first run found two packaging leaks**: `scripts/reinstall-local.sh` and roughly 1,200 stray `.opencode/**` files were being included in the packaged `.vsix`. Both are now excluded.

## [3.0.0] - 2026-09-21

A ground-up redesign of the viewer's chrome. No CAD, meshing, MCP or file-format behaviour changed — every sidecar, tool and export reads and writes exactly what it did in 2.7.0 — but nearly everything you look at is different, and one control moved (see **Changed**), which is why this is a major version. It also covers the `2.7.1` version bump that was never released.

### Added

- **Status bar.** A full-width strip along the bottom of the window: **kernel readiness** (`OCCT ready · Gmsh ready`), entity counts (`36 faces · 98 edges · 64 points`), the generated FE mesh (`mesh 10,000 el · min SICN 0.412` — hover it for the node count) and the live cursor position on the model (`x 110.18  y 31.75  z 51.29 mm`, following the Units dropdown). Kernel readiness is inferred from calls, so a document that never needs a WebAssembly kernel — a plain STL open, say — honestly reads `Kernels idle`; a kernel shows *ready* only after a call that needed it has succeeded, and goes back to idle if the worker is cancelled or restarts.
- **Document chip.** The menu bar shows the open file, a format badge and, when the document has edits not yet saved into the source file, a dot and the count (`3 unsaved edits`).
- **Selection pill.** Selecting an entity shows a one-line summary (`face-0 · planar · 8,119.27 mm²`) with the full fact rows behind a disclosure arrow.
- **An icon on every sidebar section**, and line glyphs on the toolbar, dock and section headers, all theme-adaptive.
- **Components search.** The filter box is behind a search button in the header; Escape closes it and clears the filter. Assembly rows show how many solids they hold.
- **Edits count badge** beside the section title, so the history length reads while the section is collapsed; the FE Mesh header shows the element count once a mesh exists.
- **Preset highlighting.** The Coarse / Medium / Fine button nearest the current element size reads as selected.

### Changed

- **The sidebar is reorganised.** The four sections that edit the document (Components, Parts, Edits, FE Mesh) stay at the top; the read-only analysis sections and the two library sections fold into one collapsible **Advanced** group. The default sidebar width grew from 220 to 272 px.
- **Parts rows are compact:** swatch, name, a `1 · 0 · 0` count and an eye. The assign (＋) and delete buttons appear when you hover or focus a row, and entity lists start collapsed. **A part's target mesh size is no longer edited in the Parts panel — use FE Mesh › Part sizes.** The stored value is unchanged.
- **FE Mesh layout.** A full-width Generate button; the element-size readout above the slider; presets as a segmented control; Engine and Preset side by side; and the export row (format · unit · Export) closing the panel. Part-size fields are plain text fields, so `4.0231` reads `4.02` rather than following the OS locale.
- **Toolbar and dock.** The toolbar was inheriting the browser's 16px font and is now sidebar-sized, with a divider between the plain buttons and the menus. The floating dock is one compact row with icon navigation, text-only display modes and the collapse control at its end; the controls used less often sit behind a **⋯** popover.
- **A selected face keeps its Part colour** with a subtle tint; it used to turn lilac because the accent glow was added at full strength.
- **Colours follow your VS Code theme** throughout the chrome; only the model's own colours come from the separate scene palette.

### Fixed

- **Three view-control elements rendered even when they should be hidden:** the construction-plane midplane row and the Colour-by-field group and legend. An author `display` rule beat the `hidden` attribute, so they showed for every document instead of only when applicable.

## [2.7.0] - 2026-09-20

### Added

- **Saved view bookmarks.** Named camera bookmarks (orientation, display mode, clip plane) persist per document in `<model>.view.json`; save, restore, replace, rename, and delete them from the View menu.
- **Reusable meshing presets.** Named `MeshOptions` bundles with explicit units and a pinned engine (`save_mesh_preset` / `list_mesh_presets` / `apply_mesh_preset` MCP tools plus a Saved presets section in the FE Mesh panel), backed by a bundled starter library (`mesh-presets/starter-presets.json`).
- **Measured mesh-refinement comparison.** New `compare_mesh_refinement` MCP tool meshes the same model at several explicit sizes and compares cost vs quality (nodes/elements, elapsed time, quality summary, TSV output) before choosing one via `applyIndex`.

## [2.6.0] - 2026-09-20

Closes the last two Tier 1 roadmap items: all of Tier 1 is now empty, so the tier is dropped from `doc/roadmap.md` per its own rule.

### Added

- **Resizable sidebar.** A drag handle (also a keyboard-operable `role="separator"` button: ArrowLeft/Right step, Home/End jump) resizes the sidebar between 176 and 420 px; the width persists per document in `<model>.view.json` (`sidebarWidth`, omitted at the 220 default so untouched sidecars stay byte-stable).
- **View-controls placement.** The floating control bar is centred over the 3D canvas instead of the whole editor pane (the old position covered the sidebar's bottom panels at ordinary window widths), capped to the app region with row-wrapping at narrow editor sizes.
- **Keyboard usability.** Dropdown menus gain roving ArrowUp/Down/Home/End navigation and Escape closes while returning focus to the trigger; every icon-only control gets a screen-reader `aria-label`; Parts/Variables/plane inline renames commit on Enter and cancel on Escape — which also fixed a real defect where the planes rename's Escape path committed the half-typed value anyway.
- **GitHub issue and PR templates** (closes #30). Bug/feature forms carry the contributing guide's fields (VS Code/extension/OS, format + size, repro steps, a non-confidential fixture) and a "what were you doing?" surface selector; the PR template mirrors the repo's verification and docs-sync conventions.
- **Roadmap-citation gate.** `npm test` now fails on a new bare-ordinal `roadmap item N` citation (`src/docRoadmapRefs.ts`); every existing positional citation was rewritten to carry the feature name.

### Changed

- **`decompose_to_primitives` tool description** now names the feature and issue #34 instead of a roadmap item number.
- **`mcp:smoke` hardening.** The defeature block's ambient WASM-abort-prone calls now go through the established `callWithCleanRetry` convention (a read-only no-op-reset variant for `load_model`).

## [2.5.0] - 2026-09-18

### Added

- **Standard-parts thumbnails.** Search results in the Standard Parts panel now show a 48 px thumbnail beside the part text, fetched lazily by the host and delivered as `data:` URLs. Text stays the fallback; the checksum-verified STEP download path is untouched.
- **Author profiles on a named construction plane.** Circle/rectangle/polygon profile forms gained a Plane picker: choose a `plane-N` and the sketch is placed from the plane plus in-plane offsets (and rotation for rectangle/polygon). Changing a plane moves everything referencing it; deleting one freezes last-good caches.
- **Per-band operation-preview colouring.** The draft op's own produced faces now read distinctly from retained context: two-tone per intent (bucket faces saturated, context desaturated grey) with a status-line legend.
- **Volume and point selection predicates.** `Select ▾` filters now cover all four pick modes: volumes (`Size ≥/≤`, `Center ±X/±Y/±Z`, `Largest/Smallest N` by bbox volume) and points (`Near XY/XZ/YZ`, `Near selection`, `In selection box`).
- **Zoom to selection.** `Select ▾` grew a Zoom to selection button plus a `cad-preview.zoomToSelection` command, framing the current selection in the focused pane.
- **Bounded assembly interference checks.** `check_interference_all` (and the Clash panel's Check-all) accept `maxPairs`/`maxBooleans` budgets; pairs past the budget return as `unchecked` placeholders that are never reported as clash-free.

### Changed

- **Minimum supported VS Code engine raised to `^1.137.0`** to match `@types/vscode`.
- **Dependency updates.** `three`, `three-mesh-bvh` 0.9.15, `zod` 4.6.5, plus dev-dependency refreshes.

## [2.4.0] - 2026-09-17

Closes two more Tier 1 roadmap items — clip-cap visibility tracking and save/reopen/recovery regression coverage — plus assembly-tree group rows and a generated SVG icon set.

### Added

- **Clip caps follow visibility.** Hiding or isolating a Part (or a Components-tree/assembly group) now rebuilds the stencil-buffer cross-section instead of leaving a stale cap painted; mesh/color overlay toggles ride the same coalesced path. Target collection uses `traverseVisible` so a hidden ancestor's whole subtree is excluded. Covered by new `clip V1–V3` pixel cases in `test:webview`.
- **Assembly-tree group rows select and hide their descendant solids.** Clicking or eye-toggling a synthetic `Assembly N` header expands to its descendant `solid-N` leaves instead of doing nothing.
- **Save, reopen and recovery regression coverage.** Twelve new integration cases in a real VS Code host drive the Ctrl+S join, modal cancellation, a second save (watermark `1→2`, one-deep `.bak`), reopen stability (with a forged-watermark double-apply control), Save As copy + cross-format refusal, revert-to-watermark, hot-exit backup round trip, source-write and watermark-write failure injection with rollback + retry, dirty-sidecar pre-check refusal, save-time Part/annotation rebinding, and STL save-in-place.
- **In-memory `vscode` stub for unit tests** (`src/vscodeStub.ts`, vitest-only alias) with headless `customBackup` coverage — no unit test had ever imported `vscode` before.

### Changed

- **Toolbar/panel icons are generated SVG** (theme-adaptive, `currentColor`-based) instead of hand-maintained sources.
- **Save hardening.** Both bake paths fail fast on a dirty edits sidecar before any write or modal, and roll the source back to its pre-save bytes when the watermark write throws after the source was rewritten — the pair agrees again instead of double-applying on reopen; the documented recovery is simply saving again.

## [2.3.0] - 2026-09-15

Closes the roadmap Tier 1 tier: headless mesh inspection, hole-to-hole axis distance, plus the hole table, starter macros, drawing sheets, SVG import, CSG extrudes, and distance-graded mesh sizing.

### Added

- **Multi-view drawing sheets.** File ▸ Export Drawing Sheet… and the MCP tool `export_drawing_sheet` place several views (default front/top/right/iso) on one SVG or DXF sheet at a shared scale, orthographically aligned per first-angle (ISO, default) or third-angle (ASME) projection, inside a frame with a title block. `paper: "fit"` sizes the sheet to the content at 1:1 (or an explicit `scale`); a named ISO paper size (A4–A0) picks the largest ISO 5455 standard scale that fits. A pinned annotation is drawn once, in whichever orthographic view shows it at true length.
- **Headless mesh mass properties, inspect and measure.** `get_mass_properties`, `inspect`, and `measure` now serve STL/OBJ/PLY/glTF headlessly via a shared triangle integration (volume/area/centroid/`watertight`, raw file coordinates) — no analytic parameters, no moments of inertia. `load_model` returns a `meshEntities` inventory with discoverable `mesh-component-N` / `mesh-triangle-N` / `mesh-vertex-N` ids (deliberately not the webview's `node-N` object ids) and warns when pending mesh edits are not baked in. `measure_exact` stays B-rep-only.
- **`axisDistance` on `measure_exact`.** For two cylindrical faces, the shortest infinite-axis separation (hole-to-hole spacing) is reported alongside the finite-surface clearance — pure vector math over the already-verified cylinder accessors, zero new kernel surface.
- **Hole table / feature schedule.** New `generate_hole_table` MCP tool: one row per (diameter, axis-direction) group of cylindrical faces with the nearest standard designation and signed delta, plus a TSV string for spreadsheet handoff.
- **Bundled starter macro library.** `macros/starter-library.json` ships `spring`, `bolt-circle-flange`, and `hex-bolt` parameterized starters, served when `libraryPath` is omitted; the interactive Macros panel lists the bundled rows read-only.
- **SVG import.** File ▸ Import SVG… and the `import_svg` MCP tool parse `<path>`/`<rect>`/`<circle>`/`<ellipse>`/`<line>`/`<polyline>`/`<polygon>` with full ancestor-transform composition into `addPolyline` ops; multi-loop selections build one holed face via `addSurfaceFromLines`.
- **OpenSCAD `.csg` extrude coverage.** `polygon`/`square`/`circle` profiles with `linear_extrude` (incl. centered, twist/scale refusals) and `rotate_extrude` (full/partial angles) now build instead of skipping with a warning.
- **Distance-graded mesh sizing anchored on a Part.** `Part.meshGrading` (`sizeAtWall`/`sizeFar`/`distNear`/`distFar`) drives a Gmsh `Distance`+`Threshold` field pair (B-rep sources only), composed with per-part `meshSize` under one `Min` background field.

### Fixed

- **Technical drawings with pinned annotations were misaligned.** `export_technical_drawing`'s hidden-line engine returned coordinates in a model-centred frame while the dimension-glyph renderer worked in world coordinates, so a pinned dimension's glyph was offset from the geometry it measured by the model's own bounding-box centre. Fixed as part of the multi-view sheet work, since a sheet needs every view in one shared frame to align them at all.
- **DXF technical drawings and silhouettes were mirrored vertically** when opened in a real (Y-up) CAD viewer — every coordinate was written with the wrong sign for DXF's Y-up convention.
- **A raw OCCT exception pointer (no message text at all) could escape the kernel-fault detector unwrapped**, leaving the WASM singleton corrupt with no reset and no actionable error. `isOcctWasmAbort`'s vocabulary (and its siblings in the Gmsh/meshio++/fTetWild services) now also recognizes a bare all-digit exception message.

## [2.2.0] - 2026-09-10

### Changed

- **Dependency updates.** `@meshioplusplus/wasm` 10.20.2 → 10.21.1, `vitest` 4.1.11 → 5.0.0, `@types/node` 26.4.0 → 26.5.0, `@types/vscode` 1.134.0 → 1.136.0, `playwright` 1.62.1 → 1.63.0. Minimum supported VS Code engine raised to `^1.136.0` to match `@types/vscode`.

There are no user-facing changes in this release.

## [2.1.0] - 2026-09-10

Closes Tier 0 in full (mesh save-in-place + headless `save_model`) and adds the interactive counterpart of primitive recognition/decomposition.

### Added

- **Tier 0 Phase 3 — mesh save-in-place + headless `save_model`.** STL/OBJ/PLY now offer their own format first in File ▸ Export… as a confirmed save-in-place (modal data-loss confirmation, temp sibling + rename, one-deep `<model>.bak`, `bakedThrough` watermark with history preserved; the webview's mesh replay consumes only the tail after the save point, so no double-apply; glTF stays excluded since its exporter only emits binary `.glb`). Headless gains a `save_model` MCP tool (STEP→STEP, IGES→IGES, BREP→BREP only — mesh/meshio/CAD-text refused): bakes the unbaked op tail into the source itself, keeps the full history with the watermark, leaves a `.bak`, and rebinds Part/annotation ids across the save. Every other writer still refuses the source via `assertNotSourcePath`.
- **Primitive-recognition panel.** The interactive counterpart of `recognize_primitives` / `decompose_to_primitives` (previously MCP-only): a new Primitives sidebar section classifies B-rep solids with candidate type + fit residual, applies the emitted variable-bound ops onto `EditsModel` (undoable op-by-op), and exports the result to STEP/IGES/BREP or saves the emission as a macro. Unrecognized solids report their face inventory with a reason — facts only, never a guess. Zero kernel work (both pipeline functions were already `Pipeline` keys).

### Fixed

- **Dependabot alerts for hono and js-yaml** resolved via overrides.
- **Roadmap item numbering** updated for clarity and consistency.

## [2.0.0] - 2026-09-09

The major bump marks Tier 0: documents are now genuinely editable — the read-only invariant is narrowed to "never written silently" (every source write stays an explicit, confirmed action). All four Tier 2 headless↔interactive symmetry items also close in this release.

### Added

- **Editable documents (Tier 0, Phases 1–2).** Picking the source's own STEP/IGES/BREP format in File ▸ Export… is now a confirmed write back to the open document, and `Ctrl+S` bakes the unbaked op tail into it. A `bakedThrough` watermark on the edits sidecar keeps the full history visible while replaying only the tail; undo/remove/jump refuse to cross the save point, `File: Revert File` drops back to the watermark, Save-As copies source + sidecars, and hot-exit backs up both. Part/annotation ids are rebound across the save via a two-byte replay. Headless is unchanged (`assertNotSourcePath` still refuses). Mesh-format in-place save stays a later phase.
- **Mesh-operations panel for meshio sources.** The FE Mesh panel grew a Mesh ops section driving the existing `runMeshioOps` pipeline entry (clean/decimate/smooth/subdivide/refine/agglomerate/convertCells, one per Run) over VTK/MED/CGNS/… sources, writing a new file in the source's own format. No new kernel surface.
- **`inspect_meshio_fields` MCP tool.** Headless per-array facts (name, point/cell location, component width, finite-only min/max, NaN count) for meshio++ sources — summaries only, never raw values; multi-component arrays report their width. Read-only.
- **`pin_annotation` MCP tool.** Headless create + delete over the annotations sidecar (fail-fast structure, accept-and-warn anchors incl. mesh `node-N` ids) — closes end-to-end headless dimensioned drawings via `export_technical_drawing`.
- **BOM "Copy" button.** Parts-header action copying one TSV row per part (via a new `bomRequest` round trip over the existing `computeBom` kernel surface), enabled only for B-rep sources with ≥1 part.
- **Clash panel.** Part-vs-Part interference checks (single pair + check-all over `checkInterference`/`checkInterferenceAll`) as a sidebar section over the `massPropertiesRequest` message shape. Zero kernel work.
- **Mesh auto-decimate.** `check_mesh_health`/`promote_mesh_to_brep` accept `autoDecimate` for meshes over the 50,000-triangle ceiling (meshio++ quadric edge-collapse to ~1,000 triangles, resampling stated in the response, never silent); degenerate heals are reported/skipped, never promoted as wrong solids.
- **Defeature op.** Remove a recognized feature (fillet band, chamfer) by face selection via `BRepAlgoAPI_Defeaturing`, healing the solid behind it — B-rep only, topology-changing.
- **Hex-boundary region correlation.** `convertToStlBoundaryWithRegions` triangulates quad boundaries (verified provenance-preserving) instead of bailing to the plain path, so hexahedral volumes keep their region→Parts correlation.

### Fixed

- **`repair_mesh` unit tests now cover the stored-options pipeline arg** (the 5th `repairMesh` parameter never made it into the assertions — the only CI failure on the release branch).
- **OpenSCAD `.scad` conversion resolves relative paths** (a live-binary run caught argv carrying a relative caller path while `cwd` was already the source dir, so every relative `load_model` failed to open the input).

## [1.13.0] - 2026-09-06

### Added

- **Wrap sketch onto cylinder/cone (`wrap` edit op).** Develops a flat sketch face onto an analytic cylinder or cone target (true surface development — length-preserving, not projection), then thickens it symmetrically along the surface normal. Three variants: **Standalone** appends the wrapped shell as a new solid, **Emboss** fuses it into the target volumes, **Engrave** cuts it out. Available in the Edits panel's feature composer, through `apply_edit_ops` / `run_parametric_script` for agents, and recorded in the op history with per-op replay outcomes and classification buckets like every other topology-changing op (B-rep only).
- **Loft guide rails (`guides` on the `loft` op).** A loft between two closed sections can now be steered by a guide-rail wire — captured in the Edits panel with **Set rail** on one or more Line-mode edges, or passed as `guides: edgeId[]` through `apply_edit_ops` / `run_parametric_script`. The rail's lateral deviation from its own endpoint chord offsets resampled intermediate sections, which are then lofted through the same `ThruSections` builder as an unsteered loft. This is deliberately **not** the kernel's own rail wiring — `BRepOffsetAPI_MakePipeShell`'s guide API is unreachable in the bundled OCCT WASM build — so it is named as a resampling fallback everywhere it appears (the op docs, the panel row, the history label's `+rail` suffix) rather than presented as a kernel feature. Scoped to exactly two closed sections and no wall thinning; the rail's edges are never consumed and stay in the model, like a sweep's path. B-rep only.

## [1.12.0] - 2026-09-06

### Added

- **New Blank Model button in the Models view toolbar.** The Models view title bar now offers **Open…**, **Refresh**, and **New Blank Model…** — starting an empty session no longer requires an empty workspace (the welcome-view link), the Command Palette, or the webview File menu. Both `cad-preview.open` and `cad-preview.new` also gained explicit toolbar icons (`$(folder-opened)` / `$(new-file)`), since title-bar buttons without icons don't render inline. The creation flow itself is unchanged (save-first `.brep`, refuses to overwrite).

## [1.11.0] - 2026-09-05

### Fixed

- **Integration suite (`npm run test:integration`) no longer fails in CI.** Two independent harness defects, both fixed without touching product code: the test VS Code now launches with `--enable-unsafe-swiftshader`, because CI's GPU-less xvfb box left the webview's three.js renderer without WebGL2 — the webview module died before posting `ready`, so the blank-model `geometry` assertion failed with an empty log (`saw []`) rather than a real error; and the test window now opens with a workspace folder plus a fresh per-run user-data dir, because a window starting with no workspace at all never delivers `updateWorkspaceFolders` to the extension host (the call returns `true` yet no event ever fires), which flaked the Models-view case, while the previously reused profile accumulated dead workspace roots across runs.

There are no user-facing changes in this release.

## [1.10.0] - 2026-09-04

### Added

- **New Blank Model — start with no source file.** **File ▾ → New Blank Model…**, the `CAD Preview: New Blank Model…` command, and a second button in the Models view's welcome all create an empty `.brep` document and open it, so the Edits panel's whole creation vocabulary (primitives, 2D sketch profiles, bottom-up wireframe modeling, booleans, fillets, patterns) can be used from scratch rather than only on top of an existing model. A blank document is an ordinary B-rep document whose source is an empty compound: everything you author lives in the replayable `<model>.brep.edits.json` op-list exactly as it does for an edited STEP, and the CAD file stays read-only. It refuses to overwrite an existing file rather than blanking a model whose edit history would then replay against nothing. Export bakes the geometry into a standalone file.
- **Collapsible sidebar sections.** Every sidebar section — Components, Parts, Edits, FE Mesh, Mass Properties, Mesh Health, Region fit, Macros, Standard Parts — now has a chevron in its header that collapses it to just that header, independently, so the panel can be reduced to what you are actually using. Collapsing one of the two space-filling panels (Parts, Edits) hands its space back to the rest. The layout is remembered per document in the existing `<model>.view.json` sidecar (`collapsedPanels`, a purely additive field — an older sidecar restores exactly as before, and an untouched one stays byte-stable).

### Fixed

- **The Mesh Health and Region fit panels were visible for every source format**, including B-rep files where they have nothing to show. Both panels carried an unconditional `display: flex` rule, which beats the `hidden` attribute's effect, so the source-format eligibility check that was supposed to hide them was inert. They now appear only for a native STL/OBJ/PLY/glTF source, as documented.
- **An empty shape no longer crashes the OCCT kernel.** Handing a shape with no sub-shapes to `BRepMesh_IncrementalMesh_2` aborted the whole WebAssembly instance — a hard fault, not a recoverable error — leaving every later operation in that session failing until the extension host restarted. Tessellation now returns an empty result for such a shape instead. Reachable from any edit that reduces a model to nothing (a boolean that cuts the last solid away, or undoing past the last op that produced geometry), as well as from the new blank documents above.
- **The Region fit and Standard Parts panel headers rendered unstyled** — neither matched any rule in the stylesheet. All nine sidebar headers now share one class instead of a hand-maintained id list that had already drifted.

## [1.9.2] - 2026-09-04

### Fixed

- **`package-lock.json` no longer pins a nonexistent `ipaddr.js@1.9.2`.** The v1.9.2 version bump was applied as a blanket `1.9.1` → `1.9.2` text replacement, which also rewrote the only other place that literal appeared in the lockfile: the `ipaddr.js` entry and `proxy-addr`'s pinned dependency on it. That version has never been published (the registry goes 1.9.0 → 1.9.1 → 2.0.0), so `npm ci` failed with a 404 for every consumer and every CI job. The entry is back at `1.9.1` — the version its unchanged integrity hash always described; no dependency actually changed.

There are no user-facing changes in this release.

## [1.9.1] - 2026-09-04

### Fixed

- **Release job no longer loses the whole release to a Marketplace outage.** v1.9.0's `vsce publish` step failed on a transient HTTP 503 from `marketplace.visualstudio.com`, and because that step sat upstream of "Create GitHub Release", the tag was left with no release and no `.vsix` attached even though the build itself was fully green. The publish step now retries with backoff (matching the existing precedent for `update.code.visualstudio.com`), the PAT is passed via the `VSCE_PAT` environment variable instead of a `-p` flag so it never appears in the child process's argv, and the release step runs unconditionally on non-cancellation so a Marketplace hiccup can no longer cost the GitHub release.
- **`package-lock.json`'s embedded root-package version brought back in sync** with `package.json` — it had silently lagged one release behind since the v1.9.0 bump.

This release republishes v1.9.0's full changelog (below) unchanged; v1.9.0 itself never reached the Marketplace.

## [1.9.0] - 2026-09-04

### Added

- **Selector synthesis — persist a re-executable query instead of a positional entity id.** New `resolve_selector` and `synthesize_selector` MCP tools plus `targetQueries`/`targetQueryKinds` op annotations: a bucket query re-derives its producing op's recorded faces and re-matches them geometrically on every replay, a scene query filters/ranks the whole current model, and stale indices freeze instead of repointing (kind-tag guard) rather than silently resolving to the wrong entity. Parts carry the same mechanism (`Part.selector`, resolved on open and after every op-list change), and the Edits panel's extrude/revolve/shell/draft forms gained a **Pin query** row that synthesizes a query for the selected face through the same kernel path. Mesh sources replay on cached ids (no query resolution without exact topology), and queries are refused inside `repeat` bodies.
- **Rib feature op.** `rib` builds a thin-walled rib from an open spine sketch: wall extruded along `dir` until it meets the planar terminator `upTo` (plus one wall-thickness of embed so the contact penetrates for fusing), fused into the surrounding solids with debris-tolerant operand splitting, and the wall↔body junction blended at `blendRadius` (`0` = fuse only). `thin` is required and symmetric (`thinOuter` must be absent or exactly half, since an open wire has no inside/outside).
- **Extrude up-to-face terminator.** `extrude` accepts `upToFace` (a planar face) instead of `length`: the extrusion runs from the profile plane to the terminator plane along `dir`, derived with plain plane math (miss/parallel/non-planar skips gracefully). Thin-wall handling, start-cap identity, and bucket roles behave identically for both forms.
- **Loft smoothing.** `loft` accepts an optional strict-boolean `smoothing` through the shared loft-wires choke point (plain, open-band, and outer/inner-thin paths alike) — the only `ThruSections` knob with a measured effect in this build (`-0.64%` on the progressively-twisted 4-section fixture; continuity/parametrization/max-degree settings are accepted by the kernel but change nothing, so they stay unexposed). Omitted/`false` replays exactly like before.
- **Region pick + drill.** `extrude`/`revolve`/`sweep` take an optional `pick` narrowing which enclosed regions of a multi-region profile are consumed — region `0` is the outer boundary, `1..N` its inner loops in order: omitted (or `"outer"`) keeps the face as modeled with holes preserved, `"all"` (or any list containing `0`) fills every hole, and a list without `0` builds each picked inner loop as a standalone island body. Out-of-range indices skip with a diagnostic naming the loop count; an explicit `pick` refuses `thin`, and `loft`/`rib` reject `pick` at validation. The new `drill` op cuts the same picked regions through target solids — one prism per region down an explicit `dir` × `length`, subtracted from the targets. B-rep only, with a Regions row on the extrude/revolve/sweep forms and a Drill composer in the panel's Modify category.
- **Models activity-bar view.** A CAD Preview icon in the lateral bar lists every CAD/mesh file in the open workspace folder(s) — same routing rules, depth cap, and `.git`/`node_modules` exclusions as the headless `list_workspace_models` tool, over `vscode.workspace.fs` so it also works on Remote/SSH. Click a file to open it in the 3D viewer; the title bar offers the same **Open…** dialog plus **Refresh**, and file create/delete refreshes the tree automatically. With no folder open, or no models found, the view shows an **Open CAD File…** button instead.
- **Per-step generated screenshots for the tutorials.** The docs pipeline now tessellates each tutorial's cumulative op-list prefixes from `block.stp` (fused and finished bracket, patterned tools and finished flange, sketch/extruded/shelled enclosure, plus the finished bracket meshed at the FEA page's own size) and captures one shot per step — every tutorial step finally shows its own part instead of reusing the generic panel screenshots.

### Changed

- **`npm run docs:build` now also runs in CI** (one step after unit tests): the VitePress build is the only dead-link check over `doc/**`, which previously waited for the push-to-master docs workflow — a broken intra-doc link reached `master` before anything noticed. Deploy still lives in `docs.yml`.
- **New doc-coverage gate in `npm test`.** Every live op kind must now be named somewhere in `doc/**` (exact backticked/quoted token or `"op"` value — bare prose doesn't count), no op-position snippet may claim a removed kind (the rename-catcher), and the committed `doc/op-coverage-allowlist.txt` must contain no rotted opt-out. Its first run found a real gap (`rib` was documented nowhere user-facing) rather than passing clean.

## [1.8.0] - 2026-09-03

### Added

- **Thin-walled features.** `extrude`/`revolve`/`sweep`/`loft` accept an optional `thin` (total wall thickness) to build a thin-walled body — a tube, a hollow of revolution, a walled sweep or loft — instead of a filled one, plus `thinOuter` for how much of that wall sits outside the profile boundary (`0`, the default, grows it entirely inward; `thinOuter === thin` entirely outward; anything between straddles the outline). The profile's outline is offset into a band before the ordinary builder runs, so the result is an ordinary solid in every other respect; unlike a plain feature, a thin one does **not** consume its profile sketch, so the sketch stays available to reuse. A profile that already has a hole is refused rather than silently losing it, and a wall thicker than the profile's own narrowest half-width is skipped with an explanatory diagnostic. Both fields are ordinary numeric op fields a parametric variable can drive.
- **Open-profile (wire) operands for the same four ops.** `extrude`/`revolve`/`sweep`/`loft` can now build from a set of picked **edges** (`profileEdges`/`profileEdgeSets`) as well as a sketch face — closing the "closed face profiles only" limitation thin-walled features shipped with. A closed edge selection behaves like the equivalent face; an **open** edge chain (an open polyline's own segments, for instance) requires `thin` and produces a walled body whose ends are rounded off, since an open profile encloses no area to fill. The interactive panel gained **Set path** (sweep) and **Add section**/**Clear** (loft) capture buttons so the profile-vs-path and per-section ambiguity that a wire operand introduces can be resolved by clicking, the same way boolean operand A is already captured.
- **Three new narrative tutorials** under `doc/tutorials/` — building an L-bracket (primitives, booleans, fillets, holes), a shelled enclosure from a 2D profile sketch (extrude + shell), and preparing a part for finite-element analysis (naming regions, mesh refinement, exporting to Kratos MDPA) — each with numbered steps and a compiled, gated "Full operation list" block.

### Fixed

- **Three transitive dependencies carrying published high/moderate-severity advisories** (`fast-uri`, `nanoid`, `qs`, pulled in via `ajv`/`postcss`/`express`) bumped to their patched versions via `package.json` overrides; none of the three ship in the packaged `.vsix` (they're build/dev-time only), so this closes the alerts without any runtime behavior change.

## [1.7.0] - 2026-08-29

### Added

- **Explain the geometry under the cursor.** Hovering a face/edge/vertex shows a tooltip with its id and which edit ops mention it; selecting one opens an inspector card with the facts that actually apply to that shape — a plane gets its normal and a point on it, a circular edge its radius, and a row that would be blank is simply absent rather than empty. Right-clicking an entity offers **selection groups** built from the same predicate vocabulary the Select ▾ filters use — "same facing", "planar faces", "area ≥ this" — with each row's match count shown up front, and any group that would match only the entity you clicked omitted as pointless.
- **A macro library — saved, named, parameterized scripts.** A parametric script (the existing `{variables, steps}` document with its `repeat` loop and expression evaluator) can now be saved under a name and re-run later with different parameter values: `save_parametric_script`, `list_parametric_scripts`, and `run_saved_script` over MCP, plus a **Macros** panel that can save the ops you have already applied and re-run them with edited parameters. A script's own `variables` block *is* its parameter list — there is no second schema — and a macro that compiles to no ops is refused at save time rather than failing later against a real model. Running one pushes its ops onto the normal edit stack, so a macro is undoable and removable op-by-op exactly like a hand edit.
- **Hole Wizard — standard tapped and clearance hole presets.** ISO metric coarse/fine and UNC/UNF sizes, available as `list_standard_hole_sizes` and as a designation dropdown on the three hole ops that fills the existing radius/depth fields. Every diameter is in millimetres (imperial designations included, with the inch size carried separately), and each designation reports **two** diameters — tap-drill and clearance — as facts rather than one recommendation, since which applies depends on intent.
- **Camera-aware snapshots, and `hit_test` — the pixel → entity loop closed.** `render_snapshot` gained a 14-view vocabulary (six cardinal plus all eight isometric octants), an orbit offset from any of them, and an optional composite that stitches the tiles into one image rather than spending several. `screenshot_shape` frames a single entity — isolating it by default, because a face framed at its own scale usually puts the camera inside the parent solid. `hit_test` fires rays and reports the entity struck, with the point and (for a face) its normal: the inverse of `render_snapshot`, which previously had no counterpart. It runs host-side with no browser at all, so unlike the render tools it has no unavailable path.
- **2D technical drawings with hidden-line removal** (`export_technical_drawing`, and **File ▾ ▸ Export Technical Drawing…**) — feature edges with occluded runs dashed, in SVG or DXF, for B-rep *and* mesh sources. Visibility is computed exactly rather than sampled: under orthographic projection both an edge's depth and an occluding triangle's plane-depth are affine in the edge parameter, so each crossing is solved in closed form — there is no sample spacing to tune and no thin occluder to step over. This works on tessellated triangles and calls no OCCT hidden-line API, which is why it exists at all: that kernel machinery is entirely unavailable in this WebAssembly build.
- **Tolerance-band checks on exact measurements.** A pinned measurement can carry a nominal and plus/minus allowances, rendered as a real dimension in the 3D view — arrowheads, witness lines, the value — and baked into SVG/DXF exports (on a separate `DIMENSIONS` layer in DXF). `check_tolerance` reports the measured value, the signed deviation, and whether it sits inside the band, as facts rather than a pass/fail verdict.
- **Arbitrary clip planes, derived from geometry you can see.** The Clip group is no longer limited to X/Y/Z: **Face** clips along a selected planar face and **3 Pts** through three selected points, with a fourth `N` segment that keeps the derived normal selectable so you can flip to an axis and back without re-picking. A face's own outward normal points away from the solid, so the plane is oriented to keep the model rather than discard it — for a face on the outside of a part nothing is cut until you drag, which then sweeps inward from that face. Custom normals persist to `<model>.view.json`.
- **Live operation preview** — the result of an in-progress edit is shown before you click Apply, coloured by intent (green additive, red subtractive, blue wire/reference), with per-operation cancellation. A preview never enters the op stack.
- **GiD postprocess import and export** (`.post.msh` with its `.post.res` companion), including the first compound-extension route — `.post.msh` ends in `.msh`, which belongs to Gmsh, so file-type matching now prefers the longest registered suffix.
- **meshio++ capability adoption, phases A–C.** `check_mesh_health` gained meshio++'s own surface diagnostics per component, including **inconsistent winding** — a signal the existing analyzer structurally cannot see, since it sorts each edge's endpoints before counting and so reads two oppositely-wound neighbours as a clean manifold edge. The colour-by-field picker now disables a non-colourable array up front with its component count, instead of failing after the click. And a new `transform_mesh` tool exposes clean/decimate/smooth/subdivide/refine/agglomerate/convertCells as one declarative op list, with each step that cannot run reported and skipped rather than silently dropped.
- **Analytic surface parameters, and a per-solid primitive recognition report.** `inspect` now returns `surfaceParams` for a curved face — a cylinder's radius and axis, a cone's signed half-angle with its apex, a sphere's centre and radius, a torus's major/minor radii — all in world coordinates, verified against faces this codebase built itself and against a filleted edge (the case that stands in for imported STEP). `recognize_primitives` reports, per solid, the face inventory by surface type, a candidate primitive only when that inventory matches a signature *exactly* (so a filleted box correctly reports no match, not a wrong one), and a residual against the idealized shape. Facts only — nothing is reclassified.
- **Fit a plane, cylinder, or sphere to a region of a mesh** (`fit_mesh_region`) — the mesh-side analogue of primitive recognition, for scans and other geometry with no analytic surfaces at all. Growing a region from a seed point (a dihedral-angle gate loose enough to walk across a tessellated curve, capped by size) and least-squares fitting all three shapes, each published with its own residual rather than a single winner — a flat region genuinely is also fitted by an enormous sphere, and the simpler shape only wins when it fits well enough on its own terms.
- **Named, persisted construction planes.** A clip plane (from an axis preset, a picked face, or three picked points) can now be saved under a name, or one entered numerically, and reused later — including after closing and reopening the file. A plane stores its resolved point and normal rather than a reference to the face it came from, so unlike Parts and pinned measurements it is never re-matched after an edit; it simply stays where it was put. `set_plane` lets an agent record one headlessly, e.g. from `inspect`'s own reported normal.

### Changed

- **Mass properties now use OCCT's adaptive integration** rather than the fixed-order overload, which under-integrates B-spline-trimmed faces. Volumes and areas shift by up to ~0.02% on curved models (a box is unchanged to floating point); every consumer — `get_mass_properties`, `compare_models`' deltas, `check_interference`, mesh-health volume deltas, assembly-tree fingerprints — is affected identically.
- **The viewer draws only when something changed.** Idle with a static model it renders zero frames, instead of redrawing continuously; and an edit-driven rebuild no longer re-frames the camera when the new geometry still fits within the previous view, so the model stops twitching on every edit.
- **3D scene colours follow the VS Code theme.** Faces, edges, points, the grid, the background, selection and measurement accents, the FE-mesh and hidden-line overlays all track light/dark/high-contrast, where previously every colour was a constant tuned for a dark theme. Per-Part colours you have chosen are never overwritten.
- **Sidecar writes refuse to clobber an unsaved editor buffer.** If a `.edits.json`/`.parts.json`/`.annotations.json`/`.mesh.json` is open with unsaved changes, the extension declines to overwrite it and says which file and what to do, instead of silently discarding your edits on the next autosave. The guard fails open — a broken guard must not also break saving.
- **A rejected edit op now explains itself.** `apply_edit_ops` and the parametric-script tools report why an op was rejected, quoting the expected parameter shape for that kind, and suggest the nearest real op kind for a misspelling — but only for a genuine near-miss, since a confidently wrong suggestion is worse than none.

### Fixed

- **Colour-by-field could leave the previous field's colours on screen.** A failed field pick reset only the dropdown, not the overlay or its legend, so the viewport kept showing stale colours under a legend reading "None". The failure message also guessed among three possible causes; it now names the actual one.
- **Region → Parts correlation was silently skipped for hexahedral meshes.** A hex volume's boundary is quads, which the correlation path required to be triangles, so a two-material hex mesh imported with no Parts at all. The boundary is now triangulated with its provenance preserved.
- **Tolerance bands on pinned measurements were silently inert.** A copy step used internally by the Saved-measurements list dropped the band before it could reach the sidecar, so nothing pinned with a tolerance ever actually persisted or rendered one, despite every automated test passing.
- **A sixth control-panel group could grow wide enough to cover the sidebar and swallow clicks there**, caught while adding the construction-planes UI. The new controls now nest inside the existing Clip group instead.

### Internal

- **Two automated test harnesses, closing a zero-coverage gap.** `npm run test:webview` asserts against the real shipped viewer bundle in headless Chromium (panels, picking, overlays, export serialization, idle-frame behaviour, and framing invariants that catch a blank or wildly misframed viewport); `npm run test:integration` runs a suite *inside* a real VS Code, covering extension activation, command registration, the export quick-pick/save-dialog flows, and the external-change file watchers. Both run in CI. Every webview feature's write-up previously ended with "not exercised in a real session" — much less is F5-only now.

## [1.5.1] - 2026-08-28

### Added

- **5 new importable formats, closing a real export/import asymmetry**: Gmsh Mesh (`.msh`/`.msh2`), Abaqus (`.inp`), I-DEAS Universal (`.unv`), SU2 (`.su2`), and INRIA Medit (`.mesh`). The FE Mesh panel already wrote all five via Gmsh's own writer, but there was no way to reopen any of them — each is now round-trip-verified against the live meshio++ WASM. `.msh`/`.inp` are ambiguous extensions (also used by ANSYS/FreeFem) — CAD Preview assumes its own output format and shows a one-line status caveat on open.
- **8 new mesh export formats** reachable from the FE Mesh panel's export dropdown and the `export_mesh` MCP tool, none of which Gmsh's bundled writer can produce at all: VTK XML Unstructured (`.vtu`), HDF Mesh Format (`.hmf`), AVS UCD (`.avs`), COMSOL Mphtxt (`.mphtxt`), Netgen (`.vol`), FLAC3D (`.f3grid`), Well-Known Text (`.wkt`), and Flux (`.pf3`) — all bridged through meshio++, the same way MED/CGNS/XDMF already were.

### Fixed

- **A `.xdmf` file exported by CAD Preview could never be reopened.** The host used to stage only a source file's own bytes into meshio++'s virtual filesystem, so an XDMF's `.h5` companion (needed by the default "HDF" data format) was never found on import, always failing with `HDF5: could not open file`. Opening an `.xdmf` now locates and stages its referenced `.h5` sibling automatically. (A separate, pre-existing meshio++ limitation was found while fixing this — an XDMF whose mesh mixes cell types, which this extension's own meshing always produces, still can't be re-meshed after reimport; the file opens normally, only re-meshing it fails, with a clear error. This is upstream meshio++ behavior, not something this extension controls.)

### Changed

- **`kernelIpc.ts`'s host↔worker IPC wire format hardened.** An unrecognized typed-array type crossing the boundary (e.g. a `Float64Array`, meshio++'s own native array type) used to silently mismarshal as a `Uint8Array` of the wrong length instead of failing loudly; it now throws a clear error at the boundary. `NaN`/`Infinity`/`-Infinity` values now round-trip correctly instead of silently becoming `null`.

## [1.5.0] - 2026-08-25

### Added

- **DXF import and export** — the 2D drawing interchange format the CAM/laser-cutting/AutoCAD audience actually uses, at both ends of the pipeline. **File ▾ ▸ Import DXF…** reads a `.dxf` file's model-space `LINE` / `LWPOLYLINE` (bulge arcs sampled) / `POLYLINE` / `CIRCLE` / `ARC` / `SPLINE` entities into the existing sketch edit ops (B-rep sources only; blocks/INSERT/TEXT/DIMENSION/HATCH and paper space are skipped), and a new **File ▾ ▸ Export Silhouette DXF…** writes the silhouette outline as minimal model-space `ENTITIES` (`LWPOLYLINE` chains + `LINE` singletons) over the exact same segment list the SVG exporter serializes — so an SVG and a DXF of one view are geometrically consistent. The `export_svg_silhouette` MCP tool gained an optional `format: "svg" | "dxf"` param (plus `chainCount`/`lineCount` in the response) rather than a second tool.
- **Split view with per-pane cameras.** View ▾ now offers 1×1 / 1×2 / 2×1 / 2×2 viewport layouts over one scene — each pane its own orbitable camera, the orientation cube and gizmo following focus, selection/display modes/clip planes shared across all panes. Layouts and each pane's camera persist to `<model>.view.json`, so reopening restores exactly what you left.
- **Linked cameras across tabs** (View ▾): when enabled, orbiting/zooming one open CAD Preview tab drives every other open tab's camera in real time.
- **Query-based selection filters** (Select ▾): select faces by direction, planarity, area threshold, or largest/smallest N; lines by axis alignment, length, or longest/shortest N — with a seam-exclusion toggle and Select/Add buttons, instead of clicking entities one by one.
- **OpenFOAM case import** (`.foam` marker files) via the meshio++ bridge, and Kratos MDPA files with non-sequential node ids now load correctly (meshio++ ≥ 9.13).
- **Op-history scrubbing**: the Edits panel's history is now click-to-jump — applied ops render normally and redo-buffer ops render as dimmed pending rows; clicking any row moves the stack straight to that point in one step.
- **Five new MCP tools for agent workflows.** `list_workspace_models` walks a directory for CAD files and reports which sidecars each already has (a stateless discovery step that needs no kernel call at all); `check_interference_all` checks every Part against every other in one parse rather than one call per pair, with an axis-aligned bounding-box pre-filter and a `screenedByBbox` flag on pairs it separated without a real boolean; `generate_bom` emits one row per Part with volume, area and centroid, as TSV or JSON — volumes are deliberately **sum-of-parts**, so overlapping members each count in full, matching procurement convention; `render_ops_prefix` renders the model as of op N without mutating the edits sidecar, for bisecting which op broke something; and `measure_exact` gained `centreDistance` plus, for two planar faces, the angle between their normals and — when parallel — the perpendicular gap, with a `primary` field naming which of the two fits the pair's geometry.
- **Named views for silhouette export and snapshots**, shared from one vocabulary so an SVG and a snapshot of "the same view" genuinely agree.

### Changed

- **Mesh mass properties now warn when a mesh source isn't watertight**, since the computed volume may not be meaningful for an open surface.
- **Picking ignores hidden geometry** — clicks no longer land on entities hidden via a Part's eye toggle, Isolate, or an active FE-mesh overlay.
- **Edit replay outcomes are visible**: an op that silently skipped during replay (unresolved operands after an id shift, a fillet radius too large, …) is now marked ⚠ in the Edits history with a diagnostic and hint, surfaced as warnings by the MCP tools instead of looking like a quiet no-op.
- **Dense-mesh safety guard**: Boolean/hole operations on a webview-side mesh above ~150 k combined triangles are refused with guidance to promote to B-rep first, instead of freezing the UI.
- **Faster picking on large meshes**: kept-whole meshes (organic scans above the facet limit) build a BVH acceleration structure, turning raycasting from milliseconds to near-zero per move.
- **Document-derived text is sanitized** — meshio region/data-array names quoted in status lines, MCP warnings, and auto-created Part names are stripped of control/bidi/format characters and truncated, so a hostile file can't smuggle instructions through them.
- **`inspect` now reports `planeOrigin` for planar faces** (the plane's own origin, usable directly as `planePoint` for Split/Section/Mirror), alongside the existing normal.
- **Mirror rejects a zero-length `planeNormal` up front** (sidecar parse, MCP, and parametric scripts) instead of silently skipping during replay.
- Dependency refreshes: `@meshioplusplus/wasm` 10.x (OpenFOAM reader/writer, MDPA id preservation), `js-yaml` 4.3.1, dev-dependency group bumps.

## [1.4.0] - 2026-08-04

### Added

- **SVG silhouette export.** A new **File ▾ ▸ Export Silhouette SVG…** (and the `CAD Preview: Export Silhouette SVG…` command, and the `export_svg_silhouette` MCP tool) writes a 2D outline of the model as a vector drawing — from the view you're currently looking at, or from a named view (Front/Back/Top/Bottom/Left/Right/Iso). Works for every source with host-side geometry: STEP/IGES/BREP with edits baked in, plus STL/OBJ/PLY/glTF. 1 SVG unit = 1 model unit, so it prints 1:1, and the same mm/cm/m/in/ft conversion every other export offers applies here too. **It is an outline, not a dimensioned technical drawing** — there is no hidden-line removal, so interior feature edges that don't lie on a silhouette aren't drawn. (OCCT's hidden-line machinery is entirely unavailable in this WebAssembly build; the one remaining alternative was probed against the live kernel and produced a visibly worse drawing, missing holes and cutouts the shipped approach draws correctly.)
- **Compare Models, mesh health, and Mesh → B-rep promotion now support glTF/GLB**, the last format that was still excluded. `CAD Preview: Compare Models…` (and `compare_models`) can now diff `.gltf`/`.glb` against any other supported format, `check_mesh_health` reports on them, and `promote_mesh_to_brep` turns one into a real STEP/IGES/BREP solid. This is a new host-side glTF parser, cross-validated in the test suite against three.js's own loader — the same loader the 3D view already uses to display these files — which is what made hand-rolling it defensible after it was previously ruled out for lack of a way to validate it.

### Changed

- **Mesh health and promotion now refuse a mesh above 50 000 triangles** with a clear message instead of grinding to a halt. Both build one CAD face per triangle, which was always a risk for a large mesh and becomes a likely one now that glTF — a rendering format whose files are routinely far larger than hand-authored STL/OBJ/PLY — is accepted.

## [1.3.0] - 2026-08-03

### Added

- **STEP assembly structure.** The Components tree now shows a STEP file's real nested assembly/component hierarchy — matching how the file's author organized it — instead of always flattening every solid into one list; a source with no real assembly structure still falls back to the flat list as before. STEP export now also carries per-part names into the exported file's `PRODUCT` entities (per-label colors remain unsupported — confirmed non-functional in both directions in this OCCT build).
- **Standard Parts panel.** Search the hosted [step.parts](https://www.step.parts) catalog (fasteners, bearings, connectors, extrusions, …) and insert a result as a new STEP document with one click, from a new sidebar section — previously only available to AI agents via the `search_standard_parts`/`download_standard_part` MCP tools.
- **Align and Linear/Circular Pattern** edit ops, in the Edits panel's Assembly category.
- **Transform Gizmo.** Move/Rotate/Scale now show a draggable 3D handle that live-previews the edit before you click Apply, with optional **Snap to grid** / **Snap to points** (View ▾).
- **Import SVG…** (File ▾) traces a `.svg` file's paths into B-rep sketch polylines, ready to build into a surface or extrude.
- **A cancellable progress notification** for slow STEP/IGES/BREP loads (first open, or reopening after an external change) — clicking Cancel stops the result from being applied. Routine edits stay on the lightweight toolbar status line, since they're normally near-instant.
- **OCCT, Gmsh, and meshio++ now run in a forked child process**, both in the extension and in the standalone MCP server. A hung or crashed kernel operation no longer wedges the whole extension/server — it's killed and a fresh one takes over automatically for the next operation — and Cancel now genuinely interrupts a slow load instead of only discarding its result once it eventually finishes.

## [1.2.0] - 2026-07-31

### Added

- **Unit conversion on export, now everywhere it can be done correctly** — BREP, STL, OBJ, PLY, and glTF exports (and, separately, the FE Mesh panel's own Gmsh-format export: `.msh`, Kratos MDPA, VTK, and the rest) can now be scaled to mm/cm/m/in/ft on the way out, a real geometric transform applied to the exported file's coordinates, not just a display change. STEP/IGES exports deliberately stay native mm — this OCCT WASM build has no verified way to set those formats' own declared header unit, and shipping a file whose header disagrees with its geometry would be worse than not offering the option.
- **IGES unit detection** — the view-controls Units dropdown now auto-detects and selects an opened IGES file's declared unit, the same way it already did for STEP.
- **Compare Models now supports STL, OBJ, and PLY**, in addition to STEP/IGES/BREP — `CAD Preview: Compare Models…` (and the `compare_models` MCP tool) can diff any combination of these formats against each other, via new host-side parsers (glTF remains unsupported: a correct parser needs meaningfully more surface area than the others, with no realistic way to validate it against real-world exporter variety).
- **Exact-precision measurement** — a new "⟟ Exact" button next to a completed Distance / Edge Length / Radius measurement recomputes it against the true OCCT geometry instead of the displayed triangulation; also available headless as the new `measure_exact` MCP tool.
- **Best-effort entity-id rebinding** — a Part assigned to a face or edge now usually keeps pointing at the right geometry after a Boolean, Fillet, or feature-modeling edit applied elsewhere in the model, instead of silently losing that reference the next time the file reloads.
- **meshio++ import visibility** — opening a VTK/MED/CGNS/Exodus/XDMF/MDPA file now shows a status line (and a `load_model` warning via MCP) naming any named regions and data arrays the source file declares. Still geometry-only — nothing is converted into Parts or colourable data yet — but no longer silent about what's actually in the file.

### Fixed

- The MCP server (and its `render_snapshot` tool) no longer crashes outright on Node.js < 20. A routine Playwright dependency update started calling `process.exit()` at import time on older Node versions — not a catchable exception — so the server now checks the Node version before ever attempting that import, degrading gracefully instead.

### Changed

- Bumped `@meshioplusplus/wasm` to 9.9.0.

## [1.1.3] - 2026-07-30

### Added

- **Toolbar dropdown menus.** The toolbar had grown to ~21 controls in one strip; it's now three always-visible buttons (**Fit**, **Tree**, **FE&nbsp;Mesh**) plus four dropdowns — **View ▾** (Grid, Edges, Screenshot), **Select ▾** (selection mode + Point/Vol/Surf/Line), **Measure ▾** (measure mode + Distance/Length/Angle/Radius + Clear), and **Markup ▾** (markup mode + the six drawing tools, colour, Undo/Redo/Clear). A trigger stays highlighted while its mode is active, so you can still tell at a glance that Measure or Markup is live once the panel has closed. Measurement results moved to their own line below the toolbar.
- **A complete icon set.** Every remaining emoji (`▦ 📐 📷 ✎`) and unicode placeholder (`⊙ ＋ ↶ ↷`) is now a generated, monochrome SVG icon that tracks the VS Code theme — 41 icons in total, covering the toolbar, both tool pickers, the five Display modes, and the Parts/Edits/Variables/FE&nbsp;Mesh panel buttons. The Edits panel's 46 op buttons (Move, Box, Fillet, Boolean Subtract, and so on) are now real icons too, replacing their unicode placeholders.
- **Display modes** — five mutually exclusive whole-model rendering modes (Shaded, Wireframe, X-Ray, Hidden Lines, Flat), replacing the old standalone Wireframe toggle.
- **Markup annotations** — draw freehand/line/arrow/rectangle/circle review notes over the 3D view, with undo/redo and an eraser. Session-only, and baked into Screenshot exports.
- **Measurement tools** — distance, edge length, angle, and radius, shown as a live overlay in the view.
- **Mass properties** — volume, surface area, centre of mass, and moments of inertia for the whole model or a selected solid/face/edge.
- **Screenshot** — save the current view as a PNG from the toolbar, the File menu, or the `CAD Preview: Screenshot to PNG…` command.
- **Settings** — cross-document defaults under **CAD Preview** in the Settings UI: `background`, `showGridAndAxesOnOpen`, `upAxis`, and `defaultMeshSizePreset`.
- **Visualization and UX depth** — drag-and-drop to open, per-part isolate/hide plus a Components-tree filter, a live exploded-view slider, background/opacity controls, live clipping/section planes, FE mesh quality statistics, and an orthographic/perspective camera toggle.
- **Capped clipping planes.** The live clip/section plane now shows a real solid cross-section at the cut face instead of a see-through hollow.
- **Units handling** — the declared unit of a STEP file is detected and shown, and a display-unit selector (mm/cm/m/in/ft) rescales mass-properties and measurement readouts. Presentation only; stored geometry is unchanged.
- **Model comparison** — `CAD Preview: Compare Models…` diffs two B-rep documents and reports matched/added/removed solids with the centre displacement and volume delta behind each match.
- **meshio++ integration** — VTK/VTU, MED, CGNS, Exodus, XDMF, and Kratos MDPA files open as viewable boundary surfaces, and generated FE meshes can be exported to MED, CGNS, and XDMF (formats Gmsh's own writers can't produce). Geometry only — region names and field data are not preserved.
- **Hex-dominant meshing** — a third element shape alongside simplex and subdivided, producing a mixed tet/hex mesh.
- **Save / Load Preprocess** — bundle a CAD file and its sidecars into a single `.zip` and restore it later.
- **New MCP tools for agents** — `inspect` and `measure` (fact-only entity queries), `render_snapshot` (headless multi-view images), `get_mass_properties`, `compare_models`, `search_standard_parts` / `download_standard_part` (fasteners, bearings, and more from [step.parts](https://www.step.parts)), and `run_parametric_script` for declarative, re-runnable part scripts.

### Changed

- Default 3D meshing algorithm is now Gmsh's own Delaunay, after the wasm-stack-overflow bug that forced the Frontal workaround was fixed upstream in `@loumalouomega/gmsh-wasm` 0.3.0. Existing documents keep whatever is already saved in their `.mesh.json`.
- Bumped `@meshioplusplus/wasm` to 9.8.0, which closes two upstream gaps this extension previously had to work around: exporting a generated mesh to MED now preserves part names directly (no more MED-specific two-step), and exporting a 2D-dimension mesh to CGNS now produces a file that reads back correctly (it used to round-trip cleanly only for 3D volume meshes).

### Fixed

- The **File ▾** menu could not be dismissed by clicking its own icon — the click closed and immediately reopened it.
- Clicking away from an open menu no longer also acts on whatever is underneath; with markup mode on, that click used to draw a stroke.
- The measurement pick marker rendered at a fixed 1 world-unit size — massive and out of proportion on small (e.g. mm-scale) models. It now scales with the model, matching the existing point-mode vertex markers.

## [1.0.5] - 2026-07-19

### Changed

- Dependency maintenance: bumped `actions/setup-node` and `softprops/action-gh-release`, and added `package.json` overrides for `vite`, `fast-uri`, and `@hono/node-server`.

## [1.0.4] - 2026-07-18

### Added

- A "What's New" panel that opens automatically the first time you use the extension after an update, summarizing everything that changed since the version you last had installed. It won't show again until the next update; reopen it anytime via **CAD Preview: Show What's New** in the Command Palette (which always shows the full changelog).

## [1.0.3] - 2026-07-17

### Changed

- Dependency maintenance: bumped `esbuild`, `typescript`, `@types/node`, `@vscode/vsce`, `three` / `@types/three`, `vitest`, `three-bvh-csg`, and several GitHub Actions (`upload-pages-artifact`, `deploy-pages`, `upload-artifact`, `dependency-review-action`, `checkout`) to their latest compatible versions.

## [1.0.2] - 2026-07-13

### Fixed

- Adjusted gmsh-wasm handling in the esbuild config and `.vscodeignore` so the packaged extension bundles it correctly.

## [1.0.1] - 2026-07-13

### Fixed

- Marked `ws` as external in the esbuild config and adjusted gmsh-wasm initialization to fix packaging/runtime issues introduced in 1.0.0.

## [1.0.0] - 2026-07-13

### Changed

- First stable 1.0 release. Version and dependency bump; adjusted gmsh-wasm loading in `gmshService.ts` and fixed the MCP server's reported version.

## [0.9.0] - 2026-07-13

### Added

- Save/preprocessing improvements around the sidecar save pipeline (Save, Save As, Export flows).

## [0.8.0] - 2026-07-12

### Added

- **MCP server**: a standalone stdio MCP server (`dist/mcp-server.js`) exposing the load/edit/mesh/export pipeline to AI agents with no VS Code required — load models, apply edit operations, generate meshes, and export, all headless.

## [0.7.5] - 2026-07-08

### Added

- New automated screenshot-generation pipeline for documentation (`npm run docs:screenshots`), rendering the real shipped viewer DOM against live OCCT/Gmsh output instead of hand-captured images.

## [0.7.4] - 2026-07-08

### Added

- Top **File** menu (Open / Save / Save As / Export) with matching commands and keybindings (`Ctrl+O`, `Ctrl+S`, `Ctrl+Shift+S`, `Ctrl+E`).

## [0.7.2] - 2026-07-07

### Added

- **Parametric variables**: named variables (e.g. `L = 20`) usable as expressions in edit-operation fields, with live re-resolution when a variable changes.
- Operation removal: a per-row control to remove a single op from the edit history without discarding everything applied after it.

## [0.7.0] - 2026-07-06

### Improved

- General meshing improvements to the GMSH-based FE meshing pipeline.

## [0.6.5] - 2026-07-06

### Added

- Redesigned Edits panel with **GEOMETRY** / **EDIT** top-level tabs (2D/3D subtabs under GEOMETRY) and 16 new modeling operations.
- Replaced emoji toolbar/panel icons with theme-adaptive, monochrome SVG icons that track VS Code's light/dark theme.

## [0.6.0] - 2026-07-03

### Added

- Meshing panel size controls (coarser→finer slider with bounding-box-derived default, Coarse/Medium/Fine presets) and a large-mesh warning.

## [0.5.6] - 2026-07-03

### Changed

- Meshing panel refinements: size controls and large-mesh warning follow-up.

## [0.5.5] - 2026-07-03

### Added

- VS Code Marketplace publishing step in the CI workflow.

### Fixed

- Documentation formatting corrections.

## [0.5.1] - 2026-07-03

### Added

- **FE meshing** via GMSH-WASM: generate finite-element meshes (nodes + triangles/tetrahedra) from the displayed model, shown as an overlay.
- Parts-preserving meshing (Gmsh physical groups) and multi-format mesh export, including Kratos MDPA.

## [0.4.0] - 2026-07-01

### Added

- **Non-destructive geometry editing**: transforms (move/rotate/scale/ mirror), booleans, fillet/chamfer, feature modeling (extrude/revolve/ sweep/loft), primitives, 2D profile sketches, and bottom-up wireframe modeling (points/lines/arcs → surfaces → volumes). Edits persist to a `<model>.edits.json` sidecar and are re-applied on every open; the source CAD file is never modified.

## [0.1.8] - 2026-06-30

### Added

- **Geometry parts**: assign volumes, surfaces, and lines to named parts by clicking in the view. Assignments persist to a `<model>.parts.json` sidecar.

## [0.1.5] - 2026-06-29

### Added

- View-manipulation panel (stepped rotate/pan/zoom, fit-to-view) and an orientation gizmo cube.
- VitePress-based documentation site.

## [0.1.2] - 2026-06-29

### Changed

- Updated the extension publisher id to `kratos-multiphysics`.

## [0.1.1] - 2026-06-29

### Added

- GitHub Actions workflow to build and package the extension (`.vsix`) for releases.

## [0.1.0] - 2026-06-29

### Added

- Initial release: read-only 3D preview for CAD and mesh files (STEP, IGES, BREP, STL, OBJ, PLY, glTF) inside a VS Code custom editor, using OpenCascade.js (OCCT WASM) in the extension host for B-rep formats and Three.js in the webview for rendering.

[3.27.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.26.0...v3.27.0
[3.26.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.25.0...v3.26.0
[3.25.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.24.0...v3.25.0
[3.24.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.23.0...v3.24.0
[3.23.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.22.0...v3.23.0
[3.22.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.21.0...v3.22.0
[3.17.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.16.0...v3.17.0
[3.16.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.15.0...v3.16.0
[3.15.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.14.0...v3.15.0
[3.14.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.13.0...v3.14.0
[3.13.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.12.0...v3.13.0
[3.12.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.11.0...v3.12.0
[3.11.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.10.1...v3.11.0
[3.10.1]: https://github.com/loumalouomega/CAD-Preview/compare/v3.10.0...v3.10.1
[3.10.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.9.0...v3.10.0
[3.9.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.8.0...v3.9.0
[3.8.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.7.1...v3.8.0
[3.7.1]: https://github.com/loumalouomega/CAD-Preview/compare/v3.7.0...v3.7.1
[3.7.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.6.0...v3.7.0
[3.6.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.5.0...v3.6.0
[3.5.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.4.0...v3.5.0
[3.4.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.3.0...v3.4.0
[3.3.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.2.0...v3.3.0
[3.2.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/loumalouomega/CAD-Preview/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/loumalouomega/CAD-Preview/compare/v2.7.0...v3.0.0
[2.7.0]: https://github.com/loumalouomega/CAD-Preview/compare/v2.6.0...v2.7.0
[2.6.0]: https://github.com/loumalouomega/CAD-Preview/compare/v2.5.0...v2.6.0
[2.5.0]: https://github.com/loumalouomega/CAD-Preview/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/loumalouomega/CAD-Preview/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/loumalouomega/CAD-Preview/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/loumalouomega/CAD-Preview/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/loumalouomega/CAD-Preview/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/loumalouomega/CAD-Preview/compare/v1.13.0...v2.0.0
[1.13.0]: https://github.com/loumalouomega/CAD-Preview/compare/v1.12.0...v1.13.0
[1.12.0]: https://github.com/loumalouomega/CAD-Preview/compare/v1.11.0...v1.12.0
[1.11.0]: https://github.com/loumalouomega/CAD-Preview/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/loumalouomega/CAD-Preview/compare/v1.9.2...v1.10.0
[1.9.2]: https://github.com/loumalouomega/CAD-Preview/compare/v1.9.1...v1.9.2
[1.9.1]: https://github.com/loumalouomega/CAD-Preview/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/loumalouomega/CAD-Preview/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/loumalouomega/CAD-Preview/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/loumalouomega/CAD-Preview/compare/v1.5.1...v1.7.0
[1.5.1]: https://github.com/loumalouomega/CAD-Preview/compare/v1.4.1...v1.5.1
[1.5.0]: https://github.com/loumalouomega/CAD-Preview/compare/v1.4.1...v1.5.0
[1.4.0]: https://github.com/loumalouomega/CAD-Preview/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/loumalouomega/CAD-Preview/compare/v1.2.6...v1.3.0
[1.2.0]: https://github.com/loumalouomega/CAD-Preview/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/loumalouomega/CAD-Preview/compare/v1.0.5...v1.1.3
[1.0.5]: https://github.com/loumalouomega/CAD-Preview/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/loumalouomega/CAD-Preview/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/loumalouomega/CAD-Preview/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/loumalouomega/CAD-Preview/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/loumalouomega/CAD-Preview/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/loumalouomega/CAD-Preview/compare/v0.9.0...v1.0.0
[0.9.0]: https://github.com/loumalouomega/CAD-Preview/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/loumalouomega/CAD-Preview/compare/v0.7.5...v0.8.0
[0.7.5]: https://github.com/loumalouomega/CAD-Preview/compare/v0.7.4...v0.7.5
[0.7.4]: https://github.com/loumalouomega/CAD-Preview/compare/v0.7.2...v0.7.4
[0.7.2]: https://github.com/loumalouomega/CAD-Preview/compare/v0.7.1...v0.7.2
[0.7.0]: https://github.com/loumalouomega/CAD-Preview/compare/v0.6.5...v0.7.0
[0.6.5]: https://github.com/loumalouomega/CAD-Preview/compare/v0.6.0...v0.6.5
[0.6.0]: https://github.com/loumalouomega/CAD-Preview/compare/v0.5.6...v0.6.0
[0.5.6]: https://github.com/loumalouomega/CAD-Preview/compare/v0.5.5...v0.5.6
[0.5.5]: https://github.com/loumalouomega/CAD-Preview/compare/v0.5.1...v0.5.5
[0.5.1]: https://github.com/loumalouomega/CAD-Preview/compare/v0.4.0...v0.5.1
[0.4.0]: https://github.com/loumalouomega/CAD-Preview/compare/v0.1.8...v0.4.0
[0.1.8]: https://github.com/loumalouomega/CAD-Preview/compare/v0.1.5...v0.1.8
[0.1.5]: https://github.com/loumalouomega/CAD-Preview/compare/v0.1.2...v0.1.5
[0.1.2]: https://github.com/loumalouomega/CAD-Preview/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/loumalouomega/CAD-Preview/compare/v0.1...v0.1.1
[0.1.0]: https://github.com/loumalouomega/CAD-Preview/releases/tag/v0.1
