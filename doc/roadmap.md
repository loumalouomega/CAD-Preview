# Roadmap

Candidate features for future CAD-Preview releases, prioritized by value versus effort given what the extension already ships:

- **Six WASM kernels in the extension host,** all in one forked child process (`src/kernelWorker.ts`):
  - OCCT, through `opencascade.js`
  - Gmsh
  - meshio++
  - fTetWild
  - MMG
  - OpenSCAD, through the bundled OpenSCAD WASM (a user-installed `openscad` binary is the fallback, not a prerequisite)
- **The rest of the pipeline:** a full picking/selection pipeline in the webview, a seven-sidecar persistence model, and an MCP server mirroring the pipeline headless.

Many high-value features are cheap precisely because that infrastructure exists.

This page is aspirational, not a release commitment — items may be re-ordered, re-scoped, or dropped. Effort is a rough order of magnitude including implementation, documentation and focused verification: **S** (a day or two), **M** (roughly a week), **L** (multi-week). Estimates assume the stated dependencies hold; a short wiring change can still require substantial verification.

**Planning review: 2026-09-24.** Three sources fed this review:

- **Repository:** deferred work and verification gaps, read from `CLAUDE.md` and `doc/`.
- **Outside the repo:** GitHub issues, the sibling KKSS and VSCode-MDPA-Preview roadmaps, and npm currency.
- **Kernel binaries:** every OCCT and Gmsh capability that is bound but never called.

Existing implementation references were checked against the repository where noted. New candidates remain proposals, not promises of kernel support. The previous review was 2026-09-16.

**Extended 2026-10-08.** This is an extension, not a planning review, so nothing was re-ranked. Layers (since shipped; see `CLAUDE.md`'s "Layers, distinct from Parts") was added as 2.8 and [multilingual user interface](#multilingual-user-interface) as 5.2. Task IDs in sections 2 and 4 were made continuous, so each section counts from 1 with no gaps. The former IDs of closed Meshing items (4.2, 4.4, 4.7 and 4.9) are no longer used, because the same numbers now belong to open items; those items are cited by name.

**Extended 2026-10-09.** Extension, not a planning review. The lower command bar for manual geometry ops was added as 2.1, top of Ready product work; the eleven existing section-2 items shifted to 2.2–2.12 with anchors unchanged, so name-based links survive. Its command table and examples were then extended in place for approval. "Define lines, arcs and curves from preexisting points" was added as 2.0, above 2.1, as the section's top priority — deliberately out of the gapless 1..N sequence; it has since shipped and left this list (`CLAUDE.md`'s `point-N` references section), so section 2 again started at 2.1. The lower command bar has since shipped too (`CLAUDE.md`'s "Lower command bar" section), leaving the list; section 2 was renumbered from 2.1.

**Extended 2026-10-09.** Extension, not a planning review. The coincident-point prompt (since shipped and removed; see `CLAUDE.md`'s "Coincident points") was added as 2.13 and a GiD-style geometry structure view (since shipped and removed) as 2.14, at the end of Ready product work; nothing was re-ranked.

**Extended 2026-10-12.** Extension, not a planning review: nothing was re-ranked, and every new item is appended at the end of its section so existing IDs and anchors are unchanged. Two outside projects were compared — [ReOpenSCAD](https://github.com/Matvey-Kuk/reopenscad) and [text-to-cad](https://github.com/earthtojake/text-to-cad) — and the [agent-CAD comparison](#agent-cad-comparison) below records what each feature became here. Added: 1.3 (OpenSCAD diagnostics), 2.12–2.24 (OpenSCAD include tracking, `color()` Parts, snapshot sections, clearance checks, material density, quotable references, MCP registration, MCP revision guard and agent-edit marking (both since shipped and removed), printability facts, draft analysis, hole callouts, reproducible exports), 3.12 (planar-facet promotion), 5.3 (MCP App inline preview) and 6.3 (kinematic mates). Evidence addenda went to 2.1 and 3.3, and four rejections to Non-goals.

**Extended 2026-10-19.** Extension, not a planning review: nothing was re-ranked and no ID changed. `@loumalouomega/gmsh-wasm` 0.4.0 shipped; it is the **same Gmsh commit** (`29726e7`, OCC 7.8.1) as 0.3.0 plus a `view.*` namespace, so every Gmsh-behaviour entry below was re-run on it rather than assumed, and the results are filed on the entries. The one that flipped: [Anisotropic boundary layers](/gmsh-integration#anisotropic-boundary-layers) (formerly 4.3). Its recorded blocker — the layer voided by a `Min` background — **does not reproduce**: on 0.3.0 and 0.4.0 alike a layer coexists with a `Distance`+`Threshold`+`Min` background in either call order (`scripts/probe/examples/gmsh-boundary-layer.ts`). The earlier probe's setup was never committed, so why it failed is unknown; the feature has shipped as `Part.meshBoundaryLayer` and left this list. Still blocked and unchanged on 0.4.0: pre-mesh healing, type-140 closure, `Relocate3D`, KaHIP (meshio++ 17.7.0 still builds without it). The new `view.*` namespace passed its probe as a sizing route and is added at the end of Ready product work as 2.18 (View-driven mesh sizing); the hand-authored Nastran decks for 1.2 found and fixed two silent-geometry defects in the shared meshio import path; and imprint and split faces (formerly 3.1) passed its probe and moved to Ready product work as 2.19; and planar-facet merging before promotion (formerly 3.12) passed its probe and **shipped** as `mergeFacets` (a 19 200-triangle faceted cube 49.9 s → about 1 s at the same volume; 270 000 triangles in 5.5 s), so it left the list.

**Closed 2026-10-19.** Extension, not a planning review: nothing was re-ranked. 2.18 (View-driven mesh sizing) shipped as `MeshOptions.sizeField` (see `doc/gmsh-integration.md#view-driven-sizing`) and 2.19 (Split a face into regions) shipped as the `splitFace` op; both left this list. The meshing half of 2.19 (a Part on one half yields a physical group holding only that half's triangles) is covered by the `test:integration` splitFace replay and the `gmshPartsMap.ts` bbox-centre correlation, with full live verification left to CI.

**Extended 2026-10-20.** Extension, not a planning review: nothing was re-ranked and no open ID changed. Added: 1.4 (recoverable B-rep source saves), 1.6 (close the dependency-watch issue when the tree is current), 2.20 (section views on drawing sheets), 2.21 (meshio sources in host-side geometry analysis), 2.22 (achieved boundary-layer rows), 3.13 (variable-radius fillets) and 4.10 (octree hex-dominant meshing). 3.13 and 4.10 are probes; the rest reuse shipped machinery or close an operational gap. 1.5 is deliberately not reused: code comments and tests cite it for the shipped recoverable mesh save. `@meshioplusplus/wasm` 17.8.0, published later on 2026-10-19 than that week's dependency-watch run, adds the `octree` operation 4.10 probes; it is not installed yet. 1.4 shipped on 2026-10-20 (`src/saveRecovery.ts`, `SAVE_IN_PLACE_FORMATS`, the interactive and headless B-rep save paths, and the STEP/IGES/BREP recovery cases) and left this list; its invariants are in `CLAUDE.md` and its write-up in `CHANGELOG.md`. 2.22 shipped on 2026-10-20 (`boundaryLayerMeasurement.ts`, the generate/panel/handoff read-back, and the shortfall warning) and left this list. 2.21 shipped on 2026-10-20 (`meshioBoundarySide.ts`; `compare_models`, `get_mass_properties` and `measure` now read the meshio++ boundary surface as `surfaceDerived`) and left this list. 2.20 shipped on 2026-10-20 (`drawingSection.ts`; `export_drawing_sheet` and the sheet form take `sections`/`viewSections`, with the cut loops hatched on a `SECTION` layer) and left this list. `@meshioplusplus/wasm` 17.8.0 was adopted the same day for the 4.10 probe (compat 78/78, `mcp:smoke` green). 1.6 shipped on 2026-10-20: two live `workflow_dispatch` runs closed #92 with the dated comment (`state_reason: "completed"`) and confirmed the second run is a `current` no-op; its invariants (match by title + marker, close only that issue) live in `scripts/dependency-watch.mjs` with unit cover. 3.13 passed its probe (`Add_3(R1, R2, edge)`; `radius2` implementation queued) and 4.10 passed its probe (box exactly 60, bull converging inside 5%; `engine: "octree"` implementation queued).

**Closed 2026-10-20.** Extension, not a planning review: nothing was re-ranked and no open ID changed. The OpenSCAD WASM port (6.2) **shipped** on 2026-10-20 — `@loumalouomega/openscad-wasm` 0.3.1 (Manifold backend by default) evaluates `.scad` in the kernel worker, with the installed `openscad` binary kept as the fallback for declined constructs — and left this list; the write-up is in `CHANGELOG.md` (3.26.0) and the invariants are in `CLAUDE.md`. Two probes passed and moved into Ready product work with firm estimates: variable-radius fillets (3.13 → 2.23, `radius2`) and the octree hex-dominant engine (4.10 → 2.24, `engine: "octree"`).

**Closed 2026-10-21.** Extension, not a planning review: nothing was re-ranked and no open ID changed. 2.24 (Octree hex-dominant meshing engine) **shipped** as `MeshOptions.engine: "octree"` and left this list; the write-up is in `CHANGELOG.md` and the invariants (positional call, `templates` only, one-entity MSH merge, no `extractSkin`, orientation already matches Gmsh) are in `CLAUDE.md`. Deliberately not in the first increment, and not re-queued: boundary layers on the octree, sizing-field/curvature refinement, 2-D quadtree meshing and Part preservation.

**Extended 2026-10-21.** Extension, not a planning review: nothing was re-ranked and no existing open ID changed. The verification-debt burn-down (1.1) took its **second** increment: fourteen registry entries closed and the baseline dropped 61 → 47 — six of them because the harnesses already proved them (five were marked `test-written`, a covering test that had never been seen green, and one had a covering case all along) and eight through new cases, seven in `test:integration` and one in `test:webview`. The harness gained a `showInputBox` stub (the provider has six text prompts, none of them reachable before) and a way to measure a sub-millimetre preview change. One item was added, 2.25 (the entity-point snap must reach the committed op): writing the end-to-end case showed the snap reaching the **preview** only, so Apply commits the raw delta and the model lands off the vertex — the case pins that behaviour so a fix flips it loudly. Every new assertion was bug-injected before it was trusted. The verification-debt entry's own text was stale (it still described the first increment as the next one, and an unresolved count of 55 that had been 61 for a week); it now matches the tree.

**Closed 2026-10-22 (variable-radius fillets).** Extension, not a planning review: nothing was re-ranked. 2.23 shipped as `FilletOp.radius2` (`variableFilletLaws`; the Fillet form's End radius field; single edge or a connected chain interpolated by length; oversized radii refused before the kernel call) and left this list. Two facts from the build are in `CLAUDE.md`: R1 sits at the curve's first parameter, not the explorer's first vertex, and OCC bounding boxes need a 1e-4 floor to tell a planar face from a thick one.

**Closed 2026-10-22.** Extension, not a planning review: nothing was re-ranked. 2.25 (The entity-point snap must reach the committed op) shipped: for exactly one target the Move form now carries the snapped delta (`snapped - base`), so Apply commits the position the preview showed; a multi-target drag stays preview-only and says so in the form hint and `OP_PARAM_DOCS`. The `gizmo-point-snap` case now pins the snapped commit (and its registry `closedBy` title moved with it), while the grid-snap behaviour is unchanged.

**Closed 2026-10-25.** Extension, not a planning review: nothing was re-ranked and no other open ID changed. The shared UI design system item (formerly 2.2) shipped on this side and left the list: keyboard view snaps (`1`–`6`, `i`), the label-only renames Clip → "Cut Plane" and BACK → "REAR" (the `clip` view-state key, protocol messages and the `back` named view are unchanged), and `npm run ui:drift`, an informational CI step diffing the `--ui-*` tokens and icon ids against VSCode-MDPA-Preview's `webview/design-system.css` and `src/toolbarIcons.ts`. The sibling repository's half (its stale licence line, its own copy of the key order) is its to do.

**Closed 2026-10-25 (B-rep repair probe).** Extension, not a planning review: nothing was re-ranked. The B-rep repair probe (formerly 3.2) **failed its decision gate** and left the list; the facts are under Kernel-blocked and `CLAUDE.md`'s dead-API list. Remaining probe IDs were not renumbered.

**Closed 2026-10-25 (profile probes).** Extension, not a planning review: the open-profile surface probe (formerly 3.4) and the profile fillet/chamfer probe (formerly 3.7) both **passed** and moved to Ready product work; the open-profile surface item has since shipped, and the fillet/chamfer item is now 2.4. Remaining probe IDs were not renumbered.

**Closed 2026-10-25 (Round Corner panel form).** Extension, not a planning review: the panel form for `filletProfile` (formerly 2.4) shipped as Build from selection ▸ **Round Corner** and left the list.

**Closed 2026-10-25 (N-sided surface filling).** Extension, not a planning review: the `BRepOffsetAPI_MakeFilling` probe (formerly 3.5) **passed** and the `addSurfaceFilling` op shipped (Build from selection ▸ Fill Surface) in the same change; it left the list. Remaining probe IDs were not renumbered.

Everything previously shipped is tracked in `CHANGELOG.md`, and `CLAUDE.md` holds the invariants, traps and verified kernel facts that a future change could break (not per-feature history, which lives in git) — this page is for what's **not** built yet, plus the Non-goals that record why a direction was rejected so it isn't re-proposed.

## How this file works

- **Sections are ordered, and the order is the recommendation.** Each section states an *admission criterion*; an item that doesn't meet it belongs in a different section or in Non-goals, not at the top because it sounds exciting. An empty section is removed from the file entirely rather than kept as a placeholder.
  - **1. Upkeep and defects:** no design question, only work. (Called "Tier 0" in older changelog and `CLAUDE.md` text.)
  - **2. Ready product work:** no kernel unknown remains, whether because a probe passed or because the work only reuses shipped machinery. The estimate is firm. (Called "Tier 1" in older text.)
  - **3–5. Probe-gated:** a hypothesis with a discriminating experiment, grouped by area — geometry, meshing and platform.
  - **6. Strategic:** multi-phase bets that gate other items or reopen Non-goals.
- **Each item carries an area tag** — *Geometry*, *Meshing*, *Formats*, *Drawings*, *Parity*, *Platform* or *Ecosystem* — so the file can be read by area as well as by tier.
- **A closed item is removed from this list entirely**, not struck through — only what a future change could break (invariants, traps, verified call shapes) moves to `CLAUDE.md`; the write-up and verification narrative stay in the commit message, `CHANGELOG.md` and git. **Every item has a task ID `S.N`** (section, then position within it — `1.1`, `2.3`, `2.11`), shown in its heading and in the order tables, so a task can be named in an issue, a commit or a conversation. **IDs are renumbered at each planning review**, when items close and sections shift, so an ID is only meaningful against the review date at the top of this page. Positions within a section run without gaps after each renumbering. Code and other documents therefore still cite an item by **name** (the `docRoadmapRefs` gate enforces this), and headings keep an explicit `{#anchor}` so name-based links survive the numbering.
- **Probe-gated items are hypotheses, not implementation-ready work.** Evidence may be a binding-manifest entry, an upstream API, or a proposed geometric construction. Green in `node_modules/opencascade.js/dist/Supported APIs.md` is **necessary but not sufficient** — both the STEP-unit and the IGES-writer findings started green and only resolved (one negative, one positive) under a real probe, and `HLRAppli_ReflectLines` was green, functional, *and still the wrong tool*. Each probe carries a firm **S** estimate of its own; the implementation phases listed under an item's *If admitted* are conditional, tagged provisionally, and re-estimated once the probe establishes useful output, failure behaviour and cost.
- **Non-goals are not one thing.** They are split into three groups below because each has a different revival rule, and each group says plainly **what would change our mind**. A rejection nobody re-checks is how a capability stays "permanently out of reach" long after it stopped being — four entries in this file were found stale exactly that way.
- **An item that corresponds to a known GitHub issue names it inline.** The issue is the request and discussion thread; this file is the proposed scope. Reconcile disagreements against current code and the issue before implementation; neither document automatically overrides a newer decision.
- **Cite by feature name and heading link from outside this file; use the task ID inside it.** Each candidate states its first useful increment, dependencies or decisions, and evidence needed to close it. New features belong here only when they have a concrete user workflow and an observable completion criterion.
- **Shared capabilities must reach both consumers.** A new headless-capable operation includes MCP schemas/capabilities and sidecar compatibility; a purely visual interaction can remain webview-only. Reuse the existing pipeline and registries rather than adding parallel implementations.
- **Cross-repo items say which repository owns each half.** Several items below exist because KKSS (which embeds this repository as its `cad/` submodule) or VSCode-MDPA-Preview asked for them. Only this repository's half is scoped here; the other half is named so that it is not forgotten.

Several past items were identified by comparing against [SketchForge-3D](https://github.com/Formsmith746/SketchForge-3D), a browser-based direct-manipulation CAD editor over the same OCCT kernel, and [FluidCAD](https://github.com/nkarasiak/fluidcad). Their *capability* gaps transferred well; most of their *interaction* model deliberately did not — see Non-goals. The same holds for the two agent-oriented projects in the [agent-CAD comparison](#agent-cad-comparison): their agent contracts and analysis facts transfer; their manufacturing hand-offs and their language reimplementation do not.

## Reviews

Dated reviews that produced the items below. A review stays here while any item it produced is still open; once all of its items have closed, it shrinks to a pointer.

### Magnusim review — 2026-09-21

Closed. All four transferable gaps it found have shipped: narrow-passage preflight (`analyze_passages`), the mesh size and memory budget preview (`estimate_mesh_budget`), the CAD-to-mesh deviation map (`measure_mesh_deviation`) and mesh-aware tessellation export (`export_tessellated_stl`). The review of [Magnusim](https://github.com/Lilmill2000/Magnusim) at `af8d059`, and the implementation details of each feature, are in `CLAUDE.md`.

### Meshing library review — 2026-09-24 {#meshing-library-review}

At the review date, meshing was *generate* (Gmsh, fTetWild) plus *repair*
(fTetWild, meshio++ ops). Ordinary MMG triangle/tetra remeshing has since
shipped (see `CLAUDE.md`); automatic quality improvement and field-driven
adaptation remain separate, unimplemented scope. This review also covers capabilities already
in bundled binaries but never called.

The initial MMG evidence came from [VSCode-MDPA-Preview](https://github.com/loumalouomega/VSCode-MDPA-Preview)
and [`@loumalouomega/mmg-wasm`](https://github.com/loumalouomega/MMG-WASM) 0.1.0
(MMG 5.8.0, dual ESM/CJS, no pthreads). The shipped integration exercises CAD-Preview's
own worker, IPC, Parts, stdio and packaged runtime rather than treating another
product's integration as evidence. Other MMG features below remain probe-gated.

**Licence decision, recorded:** MMG is LGPL-3.0-or-later, which is directly compatible with CAD-Preview's own `GPL-3.0-or-later` (relicensed from `GPL-2.0-or-later` on 2026-09-24 for the OpenSCAD WASM port, which shipped on 2026-10-20 — see the README's "Licensing" section). We accept the dependency. It will ship the way meshio++ and fTetWild do: an `external` package loaded from its own `.wasm` file (separately replaceable, as LGPL §4 expects), a `.vscodeignore` carve-out, and its own README "Licensing" attribution.

| Library / capability | Licence | In the VSIX today? | What it adds | Outcome |
| --- | --- | --- | --- | --- |
| MMG — mmg3d / mmgs / mmg2d (`@loumalouomega/mmg-wasm`) | LGPL-3.0-or-later | Yes; mmg3d/mmgs exposed | Ordinary reference-preserving volume/surface remeshing (`hausd`/`hmin`/`hmax`/`hgrad`); metric/local-size/level-set APIs are not product features yet | Shipped (see `CLAUDE.md` and `doc/gmsh-integration.md#mmg-remeshing`), plus Hausdorff-bounded surface coarsening (the `autoDecimate` backend of Mesh Health and Promote) and metric-driven adaptive remeshing (shipped as **Adapt to field** on remesh) |
| meshio++ 16.7.0 surface `remesh` (clustering), `estimateError` (ZZ), `interpolate` / `conservativeInterpolate`, `sampleDistance` | MIT | Yes, never called | A licence-free surface remesher to measure MMG against; an error estimator to drive adaptation; mass-preserving field transfer across a remesh | Baseline in the coarsening probe; the field-transfer half of adaptive remeshing |
| Gmsh `mesh.optimize` (`"Netgen"`, `"HighOrder"`, `"HighOrderElastic"`, …) | GPL-2.0-or-later (Netgen linked in) | Yes; `optimize()` called via the `optimize` enum | Quality optimisation after generate; untangling curved quadratic elements | Shipped as `MeshOptions.optimize` (`none`/`default`/`netgen`/`highOrder`) — repeatable Netgen gain plus a partial HighOrderElastic untangle; `Relocate3D` probed a bit-identical no-op and is not offered (see `doc/gmsh-integration.md#mesh-optimisation`) |
| Gmsh `setTransfiniteCurve/Surface/Volume/Automatic` + `setRecombine` | GPL-2.0-or-later | Yes; transfinite constraints applied via `Part.meshStructured` | Structured, mapped hex/quad meshes on regular regions | Shipped as `Part.meshStructured { divisions }` — exact mapped grids with a loud refuse on non-regular regions; `setTransfiniteAutomatic` accepts nothing on the surveyed fixture (see `doc/gmsh-integration.md#structured-meshing-per-part`) |
| Gmsh `setSizeCallback` | GPL-2.0-or-later | Declared green in 0.3.0, never called | Sizing from a JS function, e.g. a sampled deviation or error field | Probed and recorded: the callback works (16 658 calls on the probe fixture) and **nothing ships on it** — no sizing source here outgrows Gmsh's declarative fields |
| Gmsh `partition` / `unpartition` (METIS linked in) | GPL-2.0-or-later | Yes, never called | Domain decomposition for distributed solvers | Shipped through meshio++ and KaHIP: [Partitioned MDPA](./gmsh-integration.md#partitioned-mdpa) |
| TetGen | AGPL-3.0 | No | Constrained Delaunay tets | Rejected — see [Other meshing kernels](#rejected-scope) |
| CGAL Mesh_3 / Polygon_mesh_processing remeshing | GPL-3.0-or-later | No | Implicit-domain meshing, isotropic surface remeshing | Not pursued (licence-compatible, but no WASM build and covered by MMG / meshio++) — see [Other meshing kernels](#rejected-scope) |
| ParMmg | LGPL-3.0-or-later | No | Parallel (MPI) MMG | Rejected — see [Other meshing kernels](#rejected-scope) |

Known MMG facts that the sibling project established the hard way, and which the probes must re-verify rather than assume:

- **Default `hausd`:** MMG's default is an absolute 0.01, which is catastrophic on large domains — a level-set run there took 464 s and then failed. The default must be relative: VSCode-MDPA-Preview uses 0.5 % of the bbox diagonal.
- **Stdout:** `print`/`printErr` are fixed at `initialize`, so logging has to go through a mutable listener. For the MCP server this is a correctness issue, not cosmetics: any stray write to fd 1 corrupts JSON-RPC.
- **Table sizes first:** the `IPARAM_numberOfLocalParam` / `numberOfMat` / `numberOfLSBaseReferences` sizes must be set before their entries are, or the call throws.
- **Multi-material maps:** a map that misses a domain reference ends in STRONGFAILURE.
- **Return codes:** entry points return SUCCESS or LOWFAILURE, and throw only on STRONGFAILURE. An empty harvest (`np <= 0`) must be treated as a failure explicitly.
- **Renumbering:** MMG renumbers every node and entity. Per-cell integer references survive, and they are the only handle for carrying Parts across a remesh. Point/cell data does not survive and must be remapped.
- **Data path:** in-memory typed arrays (`setVertices`, `setTetrahedra`, … then `get*`), so the fixed MEMFS-path cliff that bites OCCT does not apply.

**meshio++ operations recorded as available, deliberately not adopted** (16.23–16.27). `hausdorffDistance` is now used, but only as a test-time oracle for the deviation map (`scripts/probe/examples/deviation-vs-hausdorff.ts`; see `CLAUDE.md`). `edit_regions` would introduce a second, parallel concept to `Part`, which is a JSON sidecar over CAD entity ids — the exact divergence `src/entityRebind.ts` exists to prevent, and mesh regions have no viewer-side representation at all. `match_periodic_nodes`, `resample_sequence` and `blend_steps` are periodic- and transient-solver workflows; this tool exports to solvers but does not run them or hold result series, so none has a user workflow here that meets this file's bar for a new item. Recorded so a future review does not re-derive the triage, not as a standing invitation.

**meshio++ 16.32–16.42 surface, triaged.** Adopted: `segment` + `fitPrimitives` (the `segment_mesh_surface` tool) and the software `render`/`renderPng` (stl/obj/ply/gltf `render_snapshot`, `engine: "meshio-software"`). Reviewed and **not adopted**: `tessellate` — probed on the 10-node `box-fixed-field.bdf` tets, whose straight edges make it a pure 8× subdivision with the same boundary (`convertSurface` already linearizes), and no committed fixture has curved quadratic cells to show a gain; revisit with a real curved quadratic mesh. The `MfemInfo`/`CadJsonInfo` NURBS side channels — `mfem` and Kratos CAD JSON are not routed formats here, so there is no import path to hang them on; adopting them means adding the formats first. `surfaceBuffersOps` — returns typed arrays for vtk.js; the viewer is Three.js and the STL boundary already serves it.

**meshio++ 16.43–17.2 surface (the FULL artifact), triaged.** Adopted: the FULL WASM artifact as the only staged pair (OpenCASCADE 7.6.3, zstd/lz4/bzip2 — commit "Load meshio++ 17.2.0's FULL artifact"); `fitCad` end to end as `fit_mesh_to_cad` + the Mesh Health panel's "Fit to CAD…" button, with every 16.43–17.2 recogniser riding along (variable-radius fillets, blends beside freeform faces, general helical threads, vertex blends, chamfers, conic blends, tapered and variable-pitch threads — all counted in the tool's report); the zstd/lz4 VTK XML codecs and bzip2 libMesh (committed fixtures + corpus rows); libMesh `.xda`/`.xdr` routing + `.xda` export; Kratos CAD JSON routing and the `iga_sample`/`iga_refine`/`iga_evaluate` tools over its NURBS side channel (16.43.0's isogeometric layer). **meshio++ 17.3.0's binary writers (PR #163) adopted as imports + FE-mesh exports where the writer accepts the bridge's real FE-mesh input and round-trips: Tecplot `.plt`, FEBio `.xplt`, Medit binary `.meshb`, Marc `.t19`, Abaqus results `.fil`, Ansys `.rst`, LS-DYNA `.d3plot`** (upstream-named refusals for the rest: no TecIO/ADIOS2 in this build for szplt/vtx; neuroglancer keeps no connectivity; no `.h5` route for nastran_h5; no lzma — the published pipeline whitelist lacks it). Reviewed and **not adopted**: **STEP/IGES reading through meshio++** — the document pipeline stays OCCT (B-rep ops, BRepCheck, fillets all need real OCCT handles meshio++ does not expose); the meshio++ STEP read is used only for its `format: "cad_json"` NURBS side channel (`iga_*` sources). **meshio++'s own `gltf` reader (17.1.0)** — the host-side `gltfParser.ts` (cross-validated against three.js, Draco/meshopt included) already serves the four parser formats, and the pipeline is geometry-only, so the reader's regions/point-data extras have no consumer. **`mfem` NURBS meshes** — still not routed (no fixture, no user path); the `iga_*` tools refuse a non-`cad_json` side channel by name. **`tessellate` (isoparametric curved-cell tessellation, 16.42)** — the revisit condition from the paragraph above is now reachable (refined `.cad.json` models store real `quad9` cells), but the viewer's linearized rendering is still correct for preview and no workflow asks for curved-cell display; revisit if a use appears. **`nastran_op2` and `lsdyna_binout` writers** and **`full_mt`** (the threaded flavour) — no consumer here at the time; the sequential build is deliberate (see CLAUDE.md's meshio++ invariant). `nastran_op2` has since been adopted (its 17.4.0 writer coincided with this build's OP2 *reader* making exports re-openable — see the 17.4–17.7 paragraph below).

**meshio++ 17.4–17.7 surface, triaged (the 17.7.0 bump, 2026-10-19).** Adopted: **the `nastran_op2` result writer (PR #164, CVISC dampers #165) as an import + FE-mesh export**, reversing the 16.43–17.2 triage above — at 17.2.0 the writer did not exist, and the adoption's real gate was that this build now also READS OP2, so an exported file re-opens. Verified live to the same two-step bar as the 17.3.0 writers (probe `scripts/probe/examples/op2-writer.ts`): the SaveAll-shaped pipeline mesh (vertex/line/triangle/tetra) wrote 95 KB and read back through the build's own OP2 reader with every cell class intact — blocks merged per type (the results-file convention) with `nastran:card/eid/pid/c1/c2` cell data attached; fixture `examples/Nastran/two-tets.op2` (`gen-1740-fixtures.mjs`); corpus rows `export-nastran-op2` + `load-op2-fixture` (78/78). Reviewed and **not adopted**: **`lsdyna_binout`** (same PR) — still no consumer workflow; **17.6.0's marc_t19/xplt series writes** (#166/#167) — result-sequence features for remeshing increments and per-node surface variables, and this exporter writes single-increment meshes. Everything else in 17.4–17.7 is writer-side for result formats already routed or deliberately unclaimed; the type declarations are byte-identical from 17.3.0 through 17.7.0 (verified by tarball diff), so no API surface changed.

**meshio++ 17.8.0 surface, triaged (2026-10-20).** The release adds `octree` and its conforming transitions (upstream `doc/octree.md`). It is adopted as the engine behind `MeshOptions.engine: "octree"` (`doc/gmsh-integration.md#octree-engine`): `transition: "templates"` yields hexahedra, pyramids and tetrahedra — classes meshio++'s MDPA writer already covers — so it routes around the blocked type-140 connector instead of reviving it. `snap`, `balance` and `fill: "inside"` are part of that probe; the rest of the octree options (curvature, feature-angle and size-array refinement, 2-D quadtree) are not in the first increment. Adopted 2026-10-20 for the 4.10 probe (compat 78/78, `compat:vsix` clean, `mcp:smoke` green); the probe passed and the engine shipped on 2026-10-21.

**meshio++ 17.22–17.23 surface, triaged (2026-10-29, the 17.23.0 bump).** The tarball diff against 17.21.0 adds options to `meshCadSurface` and `octreeMesh`, eight operations and ~20 mesh generators; the existing corpus (83/83), `npm test` and the typings were green on the bump alone. Adopted: **`meshCadSurface` `quads` (`dominant`/`all`), `quadPairs` and `untangle`** as `mesh_cad_surface` parameters (`block.stp` at size 1: 24 triangles + 114 quads dominant, 128 quads all, closed; quad9 at order 2; STL refused by name since it holds no quads), with `reparamConditionNumber` no longer restricted to order 1; **`octreeMesh` `hexGrading`** as `MeshOptions.octreeMeshHexGrading` (`block.stp` hex 856 uniform vs 601 graded; omitted from the sidecar when uniform); **`checkConformity`** as the `check_mesh_conformity` tool (facts: hanging nodes, T-junctions, partial overlaps, unwelded facets). Probed (`scripts/probe/examples/meshio-1723.ts`) and **not adopted**: `tetrahedralize` — `hasNetgen()` is false in the WASM build, so only the octree backend runs and it does not keep the surface triangles (`boundaryPreserved: false`, Hausdorff 0.71 on `bull.stp`, min dihedral 2.7°), duplicating `engine: "octreemesh"`; `extrude`/`revolve` — they sweep a 2-D profile mesh and refuse a closed B-rep skin (`face parallel to the direction` / `crosses the axis`), and no workflow here has a profile mesh; `mirror` — the Mirror edit op already covers B-rep and mesh sources, and the meshio++ result is a mesh-only reflection; `errorSize` — its input is `estimateError`'s indicator, whose adaptive route is already `adaptField`; `projectToCad` and the 3-D `boundaryLayer` (prism layers over a surface, `block.stp` → 756 wedges, `bull.stp` min scaled Jacobian 0.016 with 113 shrunk points) — both ran, but each needs its own panel/tool design and a reference check (CAD-snapped points against OCCT; layer quality against Kratos), so they are candidates for a follow-up rather than a quiet addition; the generators, as before; `hasMmg()` is false in this build.

**meshio++ 17.14–17.21 surface, triaged (2026-10-26, the 17.21.0 bump).** The tarball diff against 17.13.0 is confined to `meshCadSurface`: every other export (137) and `availableFormats()` are byte-identical, so no new format or operation exists to route. Adopted: all of the new `meshCadSurface` options and report fields as `mesh_cad_surface` parameters, and the mesher itself as `MeshOptions.engine: "meshcad"` (`doc/gmsh-integration.md#meshcad-engine`) — a kernel-free B-rep surface engine through the same Gmsh merge seam as the octrees. Probe-confirmed (`scripts/probe/examples/meshio-meshcad-1721.ts`): meshio++'s STEP read is in millimetres like host OCCT, `triangle6`/`triangle10` already follow Gmsh's node order, the `gmsh` writer's binary MSH cannot be merged by Gmsh's WASM, and `lopCorners` can leave more refinement unfinished than the default on `bull.stp`. Not adopted: the `background` size-field mesh (needs a mesh as an option value, no file route), and mapping `Part.meshSize` onto `faceSizes` (meshio++'s 0-based face order against the host's `face-N` is unproven, so the engine stays Part-blind). Not a replacement for the Gmsh engine: no volume, no Parts.

**meshio++ 17.9–17.13 surface, triaged (2026-10-23, the 17.13.0 bump).** Adopted: **`octreeMesh`** as `MeshOptions.engine: "octreemesh"` (graded conforming tetrahedra or all-hexahedra fitted to the tessellated skin, `doc/gmsh-integration.md#octreemesh-engine`; the castellated output is deliberately not offered — hanging nodes); **`meshCadSurface`** as the `mesh_cad_surface` tool (a B-rep → watertight conforming surface mesh with no CAD kernel: `block.stp` closes with 0 open edges at exactly 60, `bull.stp`'s 36 faces in ~100 ms); `segment`'s `method: "primitive"` and **`refinePatches`** as `segment_mesh_surface`'s `method`/`refine`; `fitCad`'s `backend` (native = kernel-free, no volume or B-rep check), `mergeFaces`, **`refineSegmentation`** (on a tessellated `bull.stp`: explained area 52 % → 97 %, volume ratio 0.955 → 1.0004, max deviation 1.75 → 0.144), `freeformMode` and `faceDeviation` as `fit_mesh_to_cad` options with the new report fields. Probe-confirmed and recorded, not built: **KaHIP** now links into the FULL artifact (passes its gate on the tetrahedra alone; since shipped as the partitioned MDPA export, `doc/gmsh-integration.md#partitioned-mdpa`). Not adopted: the thirteen mesh **generators** (`rectangle`, `box`, `disk`, `uvSphere`, `icosaSphere`, `cylinder`, `referenceTriangle`, `ngon`, `annulus`, `lshape`, `plateWithHole`, `honeycomb`, `referenceCells`) — they build test fixtures, not CAD-derived meshes, and no workflow here consumes them; `fitCad`'s `freeformGeneral`/`snapJunctions`/`extendSurfaces`/`sewTolerance` and the network/layout freeform tuning (`extraordinaryVertex`, `localRefine`, `layoutTargetPatchSize`, …) — expert knobs with no measured benefit on the fixtures; `octreeMesh`'s `cleaving` conformity, `sizeArray` and `gapCells` sizing (the engine ships `maxSize` + `levels` only, so a `sizeField` request is still refused by name — mapping a view-driven field onto `sizeArray` is a candidate follow-up).

### Kernel capability review — 2026-09-24 {#kernel-capability-review}

This review lists every capability that is **bound in a shipped kernel but never called** from `src/`, and asks which of them would serve a real workflow. "Bound" means green in the OCCT manifest (`node_modules/opencascade.js/dist/Supported APIs.md`), or declared in gmsh-wasm's `dist/gmsh.d.ts`. That is necessary but not sufficient. The following have been proven broken despite being green, and should not be re-probed:

| Proven broken despite being green | What happened | Recorded in |
| --- | --- | --- |
| `ShapeFix_Shape`, `ShapeFix_Shell`, `ShapeFix_Wireframe` | Only `ShapeFix_Solid` works | `src/meshHeal.ts` |
| `ShapeFix_Face`, `ShapeFix_Wire`, `ShapeFix_FixSmallFace` | Construct and run, but clear no real finding (see Kernel-blocked) | `scripts/probe/examples/occt-shapefix.ts` |
| `BRepAlgoAPI_Section` | No accessible constructor | `src/occtOperations.ts` |
| `BRepExtrema_DistanceSS` in maximum mode | Constructs, but never computes | `src/entityFacts.ts` (`measureExact`) |
| `BRepOffsetAPI_DraftAngle.Build()` | Throws on real geometry | `src/occtOperations.ts` (`draftFaces`) |

**The OCCT build is old.** The installed `opencascade.js` 1.1.1 references OCCT `V7_4_0`. Its 2.0 beta dates from 2023 and has seen no release since. The bundled gmsh-wasm 0.3.0 statically links OCC 7.8.1 (its `General.BuildInfo`). So one extension carries two OCCT versions three minor releases apart, and the kernel-blocked Non-goals below are blocked by the older one. The [self-built OCCT WASM](#self-built-occt-wasm) strategic item addresses this.

**OCCT: bound, never called, and worth a probe.**

| Classes | Would enable | Item |
| --- | --- | --- |
| `BRepExtrema_SelfIntersection`, `ShapeAnalysis_FreeBounds` | Self-intersection and free-boundary facts in the validity report | [More facts in the B-rep validity report](#more-facts-in-the-b-rep-validity-report) |
| `BRepOffsetAPI_MakeFilling` | An N-sided, non-planar surface from boundary edges | N-sided surface filling (shipped as `addSurfaceFilling`) |
| `ChFi2d_FilletAPI`, `ChFi2d_ChamferAPI` | Rounding and chamfering sketch-profile corners before extrusion | Fillets and chamfers on 2D profiles (shipped) |
| `BRepProj_Projection` | Projecting a curve onto a face | Shipped as `splitFace.projectDir` |
| `STEPCAFControl_GDTProperty`, `XCAFDoc_DimTolTool`, `XCAFDoc_LayerTool`, `XCAFDoc_MaterialTool`, `XCAFPrs_DocumentExplorer` | Reading STEP AP242 PMI, layers and materials, plus a second route to colours that bypasses the dead `XCAFDoc_ColorTool` getter | [Read PMI, layers and materials from STEP](#read-pmi-layers-and-materials-from-step) |
| `VrmlAPI_Writer` | B-rep → VRML export, the one extra B-rep writer in the binding | [VRML export](#vrml-export) |

**Gmsh: declared, never called, and worth a probe.** The table below is for `model.occ` and `model.mesh`. `model.mesh.embed` was in this table and has been **removed** — it was probed and shipped, but deliberately not used: Gmsh meshes a free 0D/1D model entity in its own right, so the node lands exactly without it, while calling `embed` measurably degrades the surrounding mesh (2-D minSICN 0.840 → 0.751) and produces an ill-shaped tetrahedron outright when a point on a face is embedded in a volume. A sixth "green but the wrong tool" finding alongside OCCT's; the numbers and the shipped alternative (create the entities in Gmsh's model via `model.occ.addPoint` / `addLine`) are in `CLAUDE.md` and `doc/gmsh-integration.md`. Two more parts of the binding are unused:

- **`plugin.run` and `onelab`:** unused. gmsh-wasm 0.4.0 added the `view.*` namespace (`addModelData`, `getModelData`, `probe`, `write`, …), so a plugin's output no longer needs a written `.pos` file; nothing here calls it yet.
- **`model.occ.*` modelling calls** (`fuse`, `fillet`, …): deliberately unused, since OCCT owns modelling here.
- **`model.occ.fragment` was likewise removed from the table below** — probed, passed, and shipped as the default-on `conformal` mesh option (touching solids share interface nodes; Parts resolve after the renumbering; see `doc/gmsh-integration.md#conformal-multi-body-meshing`). `model.mesh.optimize` is now also called (shipped as the `optimize` enum); only `Relocate3D` was probed a no-op and is not offered.
- **`model.mesh.setCompound` was removed from the table below** — probed and *failed*: on `bull.stp`, compounding the four smooth-linked face groups ([4, 3, 2, 2] faces, all 36 faces correlated, physical group intact, valid `.msh`) repeatably *lowered* minimum quality (minSICN 0.0269 → 0.0104, bit-identical across three runs; mean 0.7289 → 0.7157) instead of raising it. The binding works; the quality promise does not. See Rejected scope.
- **The table below is gone: every row it held has closed.** `model.occ.healShapes` / `removeAllDuplicates` were probed and *rejected* (they delete `daratech.stp`'s only volume — see Rejected scope), `model.mesh.setPeriodic` shipped as `MeshOptions.periodic`, and `model.mesh.getJacobians` shipped as `QualitySummary.invalidElements` (order-2 only — exact coincidence with `minSICN <= 0` on every measured fixture, so independent certification rather than broader detection; see `doc/gmsh-integration.md`). Nothing in `model.occ` or `model.mesh` is left worth a probe on this list.

**Red in the manifest, so out of reach until the OCCT build changes:**

- `BOPAlgo_*` (all of it, including `CellsBuilder`, `MakePeriodic`, `ArgumentAnalyzer`)
- `Geom2dAPI_*`
- `IGESCAFControl_*` (so IGES names and colours cannot be read)
- `BinXCAFDrivers`
- `XCAFDoc_GeomTolerance`

These are recorded under [Kernel-blocked](#kernel-blocked).

### Ecosystem review — 2026-09-24 {#ecosystem-review}

CAD-Preview is embedded in [KKSS](https://github.com/loumalouomega/KKSS) as its `cad/` submodule, and shares design patterns with [VSCode-MDPA-Preview](https://github.com/loumalouomega/VSCode-MDPA-Preview). Their roadmaps and `CLAUDE.md` files record what they need from this repository:

| Ask | From | Status here |
| --- | --- | --- |
| Every new capability reachable through this repository's MCP server, since that is the only way the KKSS assistant sees it | KKSS roadmap | Already a house rule ("Shared capabilities must reach both consumers" above) |
| A small, reproducible structural example that a geometry-to-results tutorial can reuse | KKSS roadmap | [Canonical worked example](#canonical-worked-example-for-the-simulation-tutorial) (the page ships; the cross-repo check remains) |
| Performance baselines covering more than the OCCT and Gmsh paths | KKSS roadmap | Shipped; see `CLAUDE.md` |
| One UI vocabulary across both extensions: view snaps 1–6 and `i`, and the "Cut Plane" / "REAR" renames | VSCode-MDPA-Preview `doc/ui-design-system.md` | Shipped here (`viewShortcuts.ts`, label-only renames, `npm run ui:drift`); the sibling's own half is its to do |
| A scheduled job that compares dependency pins with npm | VSCode-MDPA-Preview roadmap | Shipped; see `CLAUDE.md` |
| Consume CAD's mesh handoff manifest | VSCode-MDPA-Preview roadmap | Already shipped on this side (`export_mesh {manifest: true}`); the consuming half is theirs |

Two stale lines found in the sibling repositories are theirs to fix, not ours:

- **KKSS roadmap:** it lists the Magnusim preflight items as pending, but they shipped.
- **VSCode-MDPA-Preview's `doc/ui-design-system.md`:** it still describes this repository as `GPL-2.0-or-later`.

The repository has **no open GitHub issue**: #35 "OpenSCAD" — the last one — closed on 2026-09-26, and the port it asked for shipped on 2026-10-20.

### Agent-CAD comparison — 2026-10-12 {#agent-cad-comparison}

Two projects built for AI agents were read for this extension:

- **[ReOpenSCAD](https://github.com/Matvey-Kuk/reopenscad)** (GPL-3.0-or-later). A from-scratch Rust reimplementation of the OpenSCAD language with its own exact polyhedral CSG kernel — no OpenSCAD binary, no OpenSCAD WASM — behind a browser workbench and an HTTP MCP server. Its eight tools include `update_workspace_code` (revision-guarded, byte-range edits), `check_intersections` (clearance tolerance, depth, location), `list_workspace_objects` and `get_supported_scad`. It also serves a `ui://` MCP-App inline viewer.
- **[text-to-cad](https://github.com/earthtojake/text-to-cad)** (MIT, read at v0.7.21). build123d over OCP, packaged as twelve agent skills plus a viewer-bridge MCP server (`cad_show`, `cad_view`, `cad_screenshot`). Its fact-only, three-valued-verdict conventions were mined earlier and are already house rules here (`describe_capabilities`' `verdictConventions`). One correction to that earlier mining: text-to-cad has since **removed** its `inspect` CLI in favour of a geometry library (`closest_points`, `overlap_volume`, `mass_properties`, `is_sound`); the conventions survive, the tool shape does not.

| Source feature | From | Status here |
| --- | --- | --- |
| OpenSCAD evaluation | ReOpenSCAD (own interpreter) | The bundled OpenSCAD WASM ships (`.scad` via `@loumalouomega/openscad-wasm`, the installed `openscad` binary as the fallback); [reimplementing the language](#rejected-scope) is rejected |
| Customizer parameters | ReOpenSCAD (sliders that rewrite the source) | Shipped both halves: headless `list_scad_parameters` / `convert_scad` with `-D` overrides, and the interactive Customizer section (`.scad` only, validated `-D` Apply + Reset, `<model>.scad-params.json` replayed on every conversion; the source is never written) |
| Problems tab with line numbers | ReOpenSCAD | Shipped as OpenSCAD diagnostics: stderr is parsed into `{severity, message, file?, line?}` and capped by severity |
| Compile memo keyed on source + quality | ReOpenSCAD | Shipped, keyed on the source **and every file openscad's `-d` dependency list names** (plus binary, backend, `-D` set, library paths); an edited `use`/`include`/`import()` target also reloads an open document |
| Per-object listing with colour | ReOpenSCAD | Shipped: `color()` becomes one Part per distinct colour on first open of a `.csg`/`.scad` (innermost `color()` wins; a boolean keeps a colour only if its operands shared it) |
| `get_supported_scad` coverage dictionary | ReOpenSCAD | Shipped inside OpenSCAD diagnostics (skipped `.csg` importer notes join the structured list as severity `warning`; the node name is in the message text, not a separate field) |
| `check_intersections` with clearance tolerance; `closest_points` | Both | Shipped: `check_interference(_all)` take an optional `minClearance` and report the exact gap, the two nearest points and `withinClearance` for every non-overlapping pair (the Clash panel has a Clearance field) |
| `expectedRevision` edits, HTTP 409 on conflict | ReOpenSCAD | Shipped as the MCP revision guard: `get_state` returns a `revisions` fingerprint per sidecar, eleven write tools accept an optional `expectedRevision` and return their new `revision`, and a stale one is refused with code `stale-revision` carrying `currentRevision` (serialised per model and sidecar in-process; not a cross-process lock) |
| Highlighting AI-made edits | ReOpenSCAD | Shipped: appended rows carry a transient `external` badge and their faces flash once (webview memory only; pure appends only) |
| Agent-readable busy errors ("retry, do not edit"); closed vocabularies | Both | Shipped as coded MCP errors: `isError` results carry `structuredContent {code, message, hint?, retryable}`, and an undeclared parameter produces a warning naming the nearest real key (warn-only; strict mode deferred) |
| "Connect AI" setup snippets; one-install plugin | Both | Shipped: VS Code lists the server through an MCP server-definition provider, and **CAD Preview: Connect an agent…** copies a per-client snippet (Claude Code, `.mcp.json`, Claude Desktop, Cursor, VS Code, Windsurf, Codex) with the installed path filled in |
| `ui://` MCP-App inline viewer | Both | [MCP App inline preview](#mcp-app-inline-preview) (probe) |
| `cad_view` returns the user's selection as quotable refs | text-to-cad | Shipped: Copy reference quotes `file#id`, facts, the op count and a stored query (`CLAUDE.md`'s Selection bullet) |
| Snapshot presets (xray, hidden-line) and section mode | text-to-cad | Shipped: `render_snapshot` / `screenshot_shape` take all five display modes and an optional section `clip` (the viewer's own clip plane, solid cap included) |
| `mass_properties` with density | text-to-cad | Shipped: `Part.density` gives BOM mass and a per-solid `massGrams` (mass-weighted centre and density-weighted inertia remain out) |
| dfam-check (overhangs, wall thickness, support, orientations, plate fit) | text-to-cad, ReOpenSCAD (plates) | Shipped as `check_printability` (overhang area, sampled wall thickness, support-volume upper bound, plate fit; unmeasured rules listed as not checked) and the Advanced ▸ Analysis **Printability** panel with an overhang colour overlay |
| dfm draft and undercuts | text-to-cad | Shipped: `check_draft` and the Draft panel |
| Engineering-drawing hole callouts, CENTER layer | text-to-cad | Shipped: `holeCallouts` on `export_drawing_sheet`, the Export Sheet form and templates |
| Byte-deterministic writers (mesh formats, manifest) | text-to-cad | Shipped — see `CLAUDE.md`'s "Reproducible exports" |
| Per-solid signed-volume check | text-to-cad | Addendum to [More facts in the B-rep validity report](#more-facts-in-the-b-rep-validity-report) |
| 3MF export with colour | Both | Shipped: Part and file colours are written per triangle as `basematerials`, and a 3MF's own colours (and declared unit) show on load |
| STEP from a mesh with merged coplanar faces | ReOpenSCAD | Shipped as `promote_mesh_to_brep` `mergeFacets` and the Mesh Health panel's **Merge facets** checkbox: one planar face per near-coplanar facet, kept only where genuinely flat |
| Kinematic mates, poses, animation | text-to-cad | [Kinematic mates and pose-swept clearance](#kinematic-mates-and-pose-sweeps) (strategic) |
| step.parts sourcing with checksum | text-to-cad | Already shipped (`search_standard_parts` / `download_standard_part`) |
| DXF output, sheet templates, three-view sheets | text-to-cad | Already shipped (`export_drawing_sheet`, DXF layers) |
| Slicing, printer hand-off, supplier ordering, URDF/SDF | text-to-cad | [Rejected](#rejected-scope) |
| Hosted shared workspaces, HTTP transport, in-browser editor | ReOpenSCAD | [Rejected](#rejected-scope) |

### What the GPL-3.0 relicense unlocks {#relicense-unlocks}

CAD-Preview moved from `GPL-2.0-or-later` to `GPL-3.0-or-later` on 2026-09-24. Besides the OpenSCAD port it was made for, this admits Apache-2.0 dependencies: under GPLv2 they were incompatible, and under GPLv3 they are compatible. One of them serves an open item directly (the other, `draco3d`, shipped with compressed glTF):

| Dependency | Licence | Use | Item |
| --- | --- | --- | --- |
| [`manifold-3d`](https://www.npmjs.com/package/manifold-3d) 3.5.3 | Apache-2.0 | Mesh booleans and holes whose output is guaranteed manifold, unlike `three-bvh-csg`'s (shipped; `three-bvh-csg` remains the fallback) | — |

It does **not** admit AGPL code, so TetGen stays rejected. Every new bundled dependency still gets the licence check the Definition of done asks for.

## Open items

### Suggested implementation sequence

| Wave | Outcome | Start with | Exit signal |
| --- | --- | --- | --- |
| Upkeep | The base stays current and trustworthy | Done: the dependency watch, "Verify the dependency watch on GitHub", has run — it published issue #84 and re-dispatching reported `unchanged`. The verification-debt gate has shipped and **24 claims are closed** (the ten webview ones, the first ten host-side ones, and the fourteen of the second host-side increment — six of which the harnesses already proved); the host-side halves (1.1) are next again, now with only look-and-feel claims left in the registry; recoverable B-rep saves (1.4) shipped and left the list; the dependency-watch close-out (1.6) shipped and left the list too — two live `workflow_dispatch` runs closed #92 with the dated comment and the second run was a `current` no-op | The verification debt count keeps falling by closure |
| Parity | Everything an agent can do, a user can do, and the reverse | Done: headless mesh-edit replay closed the last listed gap (as did the hole-table, refinement-sweep, free-text-note and mesh-source FE-export gaps). Justified remainders: meshio `inspect` (compare/mass/measure now read its boundary surface; `inspect` itself stays B-rep/mesh-parser only), `promote_mesh_to_brep` and `repair_mesh` read the raw file (their ids and outputs are defined over it; `save_model` bakes first), and glTF has no own-format save (its exporter emits only `.glb`) | Headless tools see the same edited mesh the viewer shows, or each remaining difference is justified |
| Meshing probes | Decide on remeshing and on conformal assemblies | MMG core probe is closed with a partial outcome: volume/surface/transport work, unconditional optimisation failed. MMG remeshing has shipped: shared service, MCP tool and panel with real-pipeline screenshots and packaged-runtime verification. Conformal multi-body meshing and Gmsh mesh optimisation have shipped, each with probe-measured results and a decision. Manifold mesh booleans have shipped, and so have periodic face pairs; pre-mesh healing and the hex-dominant MDPA split were probed and rejected (see Non-goals), and the size callback works but nothing ships on it. Structured meshing per Part has shipped as `Part.meshStructured` with exact-count smoke coverage. Metric-driven adaptive remeshing has shipped as **Adapt to field** on remesh (scalar metric; the tensor metric was probed and not worth shipping). Hausdorff-bounded surface coarsening has shipped as the `autoDecimate` backend (mmgs; the earlier negative result was a mis-scaled `hausd`). Anisotropic 2-D boundary layers have shipped as `Part.meshBoundaryLayer` (the recorded blocker did not reproduce). Achieved rows are now measured from the generated nodes (`boundaryLayerMeasurement.ts`; generate result, panel Layer row and handoff manifest, with a shortfall warning), closing 2.22. View-driven mesh sizing has shipped as `MeshOptions.sizeField` (list-based `SP` view + `PostView` field, `bull.stp` worst deviation 3.3× down at 11.7× elements, Parts and physical groups survive, no view left behind). The octree hex-dominant engine shipped as `engine: "octree"` (3522 cells enclosing exactly 60 on `block.stp`, MDPA with all three cell classes). KaHIP-partitioned Kratos MDPA export has shipped as `MeshOptions.mdpaRanks` (`doc/gmsh-integration.md#partitioned-mdpa`: one file per rank, global ids, an interface-node SubModelPart; `bull.stp` at 4 ranks cuts 108 interface nodes against the space-filling curve's 297). Nothing is left in this wave | Each probe filed with measured results and a decision |
| Geometry probes | Decide which never-called OCCT capabilities become ops | B-rep repair probed and **failed** (no `ShapeFix_*` fixer clears a real finding; see Kernel-blocked) and left the list; the face-region split passed its probe, shipped as the `splitFace` op, and left the list; variable-radius fillets passed theirs and shipped as `FilletOp.radius2` (see `CLAUDE.md`'s Fillet/chamfer call shapes) | Each probe filed with measured results and a decision |
| Agent ergonomics | An agent can tell a retryable failure from a model error, and two writers cannot silently clobber each other | Done: OpenSCAD diagnostics (document-derived OpenSCAD text now reaches an agent only inside untrusted-text markers), coded MCP errors (a failure carries a code and `retryable`; an undeclared parameter is warned about) and the MCP revision guard (a stale `expectedRevision` is refused with `stale-revision`). Mark agent-made edits has shipped too. Next: the Upkeep items (1.1, 1.2) and the remaining Ready product work | An agent's change is visible and refusable |
| Strategic | Remove the kernel ceiling | The self-built OCCT WASM probe (6.1) | The existing test suites pass unchanged against the new build |

These are outcome groupings, not release numbers. Independent small items can ship between waves; a failed probe must not block unrelated work.

### 1. Upkeep and defects {#tier-0-—-upkeep-and-defects}

*Admission: the work is known and has no design question. These items keep the base current, honest and cheap to verify; they rank first because every other item depends on them.*

#### 1.1 Verification-debt burn-down {#verification-debt-burn-down}

*Area: Platform.*

- **Done so far:** the gate shipped — `src/verificationGaps.ts`, run by `npm test`, over `scripts/verification-gaps/registry.json` and a checked-in baseline. The registry is the single list of unverified claims (it no longer needs a marker in `CLAUDE.md`), and its baseline ratchets the unresolved count so debt cannot grow silently; an entry closes only by naming harness test titles that literally exist, so rewording cannot close it and renaming the test re-opens it. Ten claims moved from F5-only into `npm run test:webview` (641 → 747 checks): real transform-gizmo drags (translate/rotate/scale, preview-only, discard on leaving the form, grid snap), and the Mesh Health, Region fit, Macros, Mass Properties, Pin + tolerance, colour-by-field and linked-camera panels. Writing the Region fit case found and fixed a real defect: Pick seed did nothing unless Selection mode was on. The full account, including what this does **not** claim, is in the pre-trim `CLAUDE.md` (`git show eb454bc:CLAUDE.md`, "Verification-debt burn-down").
- **Mesh-target export join: closed.** Two `test:integration` cases (STL and glTF Binary through the real webview) were seen green in CI on PR #90; the baseline dropped 56 → 55.
- **First host-side increment: done.** The ten host-side entries with the highest data-loss or write-path risk went into `test:integration` on 2026-10-19 (`0b3f86f`), and the baseline dropped 71 → 61. The second increment followed on 2026-10-21: **six entries the harnesses already proved were closed on their first green CI run** — five of them were marked `test-written` (a covering test existed and had never been seen green; the first green run closed them) and one (`svg-silhouette-export`) had a covering case all along — and **eight new cases** took the next eight host-side entries, seven in `test:integration` and one in `test:webview`. The baseline is now **47**.
- **What the second increment cost and bought.** The harness gained a `showInputBox` stub (`test/integration/suite/modalStubs.ts`): the provider has six text prompts — the macro name, the meshing-preset name, the drawing-sheet template name, the "save primitives as macro" name, and the STL-tessellation size/fraction pair — and none of them was reachable before. The webview harness gained a way to measure a *sub-millimetre* preview change (the entity-point snap's largest correction is 1% of the model diagonal, which at the default framing is a pixel or two against ~150 000 drawn ones). Every new assertion was bug-injected before it was trusted: a no-op sidecar write, a skipped library write, a dropped clearance validation, a removed bundled-starter refusal and a snap that never applies each turned the suite red.
- **Still open (47 unresolved entries):**
  - **The host halves** of nearly every panel — quick-picks, save dialogs, `provider.ts` handlers — are what `test:webview` structurally cannot reach. They belong in `test:integration`, using the modal stubs and Test seams already there. What remains is the *feel* of a panel and the parts of a flow the stubs still cannot reach.
  - **The remainder is mostly look-and-feel.** What is left in the registry is dominated by claims no harness can assert — how a panel reads in the light and high-contrast themes, how a toast feels, how a render looks after a recovery. Those are the F5 checklist, and each one says so in its own text.
- **Next increment (M):** take the next host-side entries — the ones whose claim is still a behaviour rather than a look — into `test:integration`, one case per entry, then lower the baseline by exactly as many as were closed. The rule the second increment followed is the one to keep: **rewrite an entry's claim to the part a harness can decide, then close it by a test that decides exactly that part, and leave the residual in the note.** An entry closed by rewording is the failure this gate exists to prevent.
- **Done when:** the unresolved count keeps falling **by closure** (not by rewording); the export-join entry has already closed on its first green CI run, and so have the six entries of the second increment.

#### 1.2 Nastran bulk-deck import {#nastran-bulk-deck-import}

*Area: Formats. Effort: S (needs one external file).*

- **Done so far:** meshio++'s Nastran reader was originally believed to reject this extension's own Gmsh-written deck (`Not a meshio++-C++ Nastran file`); that refusal no longer occurs on any supported meshio++. The geometry is now pinned rather than inferred from counts: `examples/Nastran/block-tets.bdf` (Gmsh output, no `BEGIN BULK`, so the read-side normalization is load-bearing) reads to 60 boundary facets spanning exactly 3×4×5 at volume 60, and three **hand-authored** decks — `box-fixed-field.bdf` (8-column, with executive and case control, solver cards, and 10-node `CTETRA` with `+` continuation lines), `box-free-field.bdf` (comma-separated) and `box-large-field.bdf` (`GRID*` 16-column) — all read to a 2×3×4 box of volume 24. `scripts/probe/examples/nastran-deck.ts` pins the reader-level extent and volume; `mcp:smoke` exports each as `.msh` and pins the extent and summed tetrahedron volume from the mesh itself; `npm run compat` has a `load` row per deck. (An earlier version of this item said `mcp:smoke` already asserted volume 60. It did not — no headless tool reports a bounding box or mass for a meshio-only source — and the assertion now exists.)
- **Covered since (2026-10-19):** hand-authored `box-hex.bdf` (two 8-node `CHEXA`), `box-wedge.bdf` (two 6-node `CPENTA`) and `plate-shell.bdf` (two `CQUAD4` plus a `CTRIA3`, area 15) now join the probe, the `mcp:smoke` volume pins and the corpus. They are exactly the "right counts, wrong mesh" class this item feared, and they found two real defects in the shared meshio import path, both fixed: the native surface converter keeps only the triangular boundary faces, so the wedge box read as volume 8 instead of 24 (any wedge, pyramid or hex-plus-tet mesh from any format was affected, and the extent check could not see it); and a shell-only deck's boundary extraction returned its free edges, so the plate was refused.
- **What is left:** the decks follow the Nastran reference's card layout but were **not emitted by a Nastran tool** (none is available to this project). Still unexercised: `CBAR`/`CROD`, higher-order `CHEXA`/`CPENTA`, and anything a real tool writes that a hand-authored deck does not.
- **First useful increment (S):** commit one real tool-emitted deck (a user-contributed or openly licensed one, with its provenance recorded) and add it to the probe, the smoke volume pins and the corpus. If meshio++ reads it with the right extent and volume, this item closes with no product code; if not, the gap is a genuine reader limitation and moves to the probe-gated section, scoped to the card coverage meshio++ actually has.
- **Done when:** a deck emitted by a real Nastran-family tool loads, meshes and matches an independently known volume. Do not infer solver cards or follow `INCLUDE` files.

### 2. Ready product work {#tier-1-—-ready-product-work}

*Admission: no kernel unknown remains. Either a probe passed and its call shapes are in `CLAUDE.md`, or the work only reuses shipped machinery. The estimate is firm.*

#### 2.3 Canonical worked example for the simulation tutorial {#canonical-worked-example-for-the-simulation-tutorial}

*Area: Ecosystem. Effort: S.*

- **Done so far:** [A cantilever beam](/tutorials/cantilever) — a 100 × 10 × 10 box, `FixedEnd` and `LoadFace` Parts, an optional steel density, and an MDPA export with a handoff manifest. `mcp:smoke` pins it on the live kernel: the beam's volume is exactly 10 000 mm³, and every node of each `SubModelPart` sits exactly on its end plane (x = −50 / +50).
- **What is left (S):** the cross-repository check — open the exported `.mdpa` in VSCode-MDPA-Preview and confirm both SubModelParts populate. It needs that extension and is not exercised from this repository.
- **Done when:** that check passes, and KKSS's tutorial links to the page.

### Probe-gated — establish feasibility before estimating

*Admission: a specific hypothesis with a discriminating experiment. Each probe below is a small, self-contained piece of work with a firm **S** estimate of its own; the phases under "If admitted" are what ships if the probe passes, tagged provisionally. A method that accepts arguments but changes nothing is a failed probe.*

**Probe protocol.** Every probe write-up records:

- **Installed artifact versions.** At the time of writing: `opencascade.js` 1.1.1, `@loumalouomega/gmsh-wasm` 0.4.0 (Gmsh `5.0.0-git-29726e7`, the same commit as 0.3.0; it adds only the `view` namespace) and `@meshioplusplus/wasm` 17.23.0 (adopted 2026-10-29; was 17.21.0 from 2026-10-26; was 17.8.0 when adopted 2026-10-20 for the 4.10 probe; the MMG probes install `@loumalouomega/mmg-wasm` 0.1.0 first).
- **The fixture path.**
- **The exact call shapes that worked:** overload suffix and argument count. There is no `.d.ts` for OCCT, so signatures are found by enumerating a prototype and trying suffixes, the same way every other OCCT call site here was found.
- **The output facts.**
- **Cleanup behaviour:** `.delete()` in `finally`, and a kernel reset after a deliberate abort.
- **Wall-clock timing** on the largest fixture that fits.

MEMFS paths stay at 10 characters or fewer; the 11+ cliff silently corrupts STEP writes. Every probe runs through the committed harness — `npm run probe -- <entry.ts>`, with the skeleton, protocol and scratch convention in [`scripts/probe/README.md`](https://github.com/loumalouomega/CAD-Preview/blob/master/scripts/probe/README.md).

**Where a result goes.**

- **Pass:** the item's "If admitted" phases move into section 2 with firm estimates, and the probe's call shapes move to `CLAUDE.md` as the feature's verified facts.
- **Fail:** the item moves to Non-goals, with the exact calls that failed and what would change our mind. It goes under Kernel-blocked for a dead binding, or Rejected scope for a product judgement.
- **Partial:** the item stays here, narrowed to the surviving hypothesis, with the negative half recorded under Non-goals.

Probes are grouped by area. Each group has its own order table. The order is the recommendation within that group, and the groups can proceed in parallel.

#### 3. Geometry and B-rep probes {#geometry-and-b-rep-probes}

| ID | Item | Needs | Why here |
| --- | --- | --- | --- |
| 3.6 | Read PMI, layers and materials from STEP | — | May also reopen colours through a different API than the dead one |
| 3.8 | Small-detail edge suppression | screenshot pipeline | Webview-side and independent; the risk is judgement, not bindings |
| 3.10 | Loft takeoff by resampled intermediates | — | The measurement design is the hard part |
| 3.11 | VRML export | — | Cheap but low value |

None of these depends on another's result.

##### 3.6 Read PMI, layers and materials from STEP {#read-pmi-layers-and-materials-from-step}

*Area: Formats.*

- **Hypothesis:** from an AP242 STEP file, `STEPCAFControl_GDTProperty` with `XCAFDoc_DimTolTool` can read dimensions and tolerances, and `XCAFDoc_LayerTool` / `XCAFDoc_MaterialTool` can read layer and material assignments. `XCAFPrs_DocumentExplorer` with `XCAFPrs_Style` can read colours without the `XCAFDoc_ColorTool` getter that is recorded as dead. All of these are green and never called.
- **Evidence today:**
  - The XCAF read path already parses STEP into a document for assembly structure (`src/xcafTree.ts`).
  - Names and colours are recorded as unreadable, because `TCollection_ExtendedString` cannot become a JS string and `ColorTool.GetColor` never worked.
  - PMI, layers and materials have never been tried.
- **Probe (S):**
  1. Find or author an AP242 fixture with PMI and a coloured face. NIST publishes public test models; licensing must be checked before committing one.
  2. Count the dimension and tolerance labels.
  3. Walk the document with `XCAFPrs_DocumentExplorer` and try reading one face's style colour.
  4. Read the layer and material labels. Record which values reach JS, and in what form.
- **Decision gate:**
  - **Pass:** any of the four reaches JS as usable data.
  - **Partial:** counts are readable but values are not, which is the same string wall. Record it, keep only what works, and add the rest to Kernel-blocked.
- **If admitted (M):**
  - Imported PMI becomes read-only annotations.
  - Layers and materials become Parts.
  - Colours become per-face display colours.

  Each ships with its own verification.

##### 3.8 Optional small-detail edge suppression {#optional-small-detail-edge-suppression}

*Area: Geometry.*

- **Hypothesis:** a per-edge `detail` flag — both adjacent faces small relative to the model — hides post-treatment clutter (fillet-band seams, cosmetic chamfers) on real assemblies without hiding drilled-hole rims or thin features.
- **Evidence today:** the `smooth` flag is the exact plumbing template: `EdgeLine`/`EncodedEdge.smooth`, `buildEdgeLine`'s `userData`, `Viewer.applyEdgeVisibility` as the single visibility writer, the `#hide-smooth-edges` menu item, and `applyLineFilter`'s seam exclusion. No per-face facts travel to the webview (`FaceMesh` is id plus buffers), but host-side `collectAllEntitySignatures` already computes every face's area in `face-N` order, `faceSurfaceInfo` gives the surface type, and `bboxDiagonal` is the codebase's relative-scale denominator. What is missing is evidence, not bindings: no fixture demonstrates the clutter, and "small" has no validated threshold.
- **Probe (S):**
  1. Host-side, on `bull.stp`, `4pinplug.stp`, `gear.stp` and `as1_pe.stp`: for every edge with exactly two adjacent faces (`buildEdgeFaceAdjacency`), compute `min(areaA, areaB) / bboxDiagonal²` and both surface types; mark `detail` at τ ∈ {1e-4, 1e-3, 1e-2}.
  2. Count, per fixture and τ, the edges hidden, and of those how many belong to a cylindrical face (the drilled-hole proxy) or to a face whose own bbox spans more than 10 % of the model (a thin sheet — small area, large extent).
  3. Render each τ through the screenshot harness with the flag applied and inspect the images at two zoom levels — a count is not evidence that the drawing reads correctly.
- **Decision gate:** *pass* — some τ hides at least 30 % of fillet-band seams on two or more fixtures while hiding no cylindrical hole rim and no large-extent face's edges. *Fail* — every τ that removes clutter also removes a hole rim → Rejected scope, with the tables kept.
- **If admitted:** Phase 1 (**S**) — `detail: boolean` beside `smooth` on the wire format (never a filter: `edge-N` enumeration untouched), a `#hide-detail-edges` View item through `applyEdgeVisibility`, opt-in, the threshold a `cadPreview.*` setting defaulting to the probe's τ; and fix the documented "edge visibility does not survive a model rebuild" limitation for *both* flags in the same change, since a second toggle would double that bug's surface.
- **Out of scope:** any default-on suppression; area alone as the criterion — surface type and extent are part of the test.

##### 3.10 Loft takeoff by resampled intermediates {#loft-takeoff-by-resampled-intermediates}

*Area: Geometry.*

- **Hypothesis:** inserting one extra near-end station, displaced along the section plane's normal by a signed magnitude, measurably changes the loft surface's takeoff angle at that section, and `ThruSections` keeps the change rather than smoothing it away.
- **Evidence today:** the shipped `guides` fallback (`resampledGuideWires`) places `GUIDE_STATIONS = 6` intermediates at t = k/7 — never at t = 0 or 1 — each an M-gon (128 ≤ M ≤ 512) built by pointwise lerp plus a rigid chord-deviation offset, lofted through `ThruSections(true, false, 1e-6)` with `IsDone` as the only gate. Its steering signal on the smoke fixture is +0.83 % of volume (4139.06 against 4105.01), the same order as `SetSmoothing`'s own −0.711 % — so **volume cannot be this probe's measurement**. The fixed station spacing also misses an interior rail corner by ≈1.09 units on that fixture, recorded in the smoke script. The kernel route stays a Non-goal; this is an untested idea, not a probed finding.
- **Probe (S):**
  1. Reuse the smoke fixture (`block.stp` plus two circle profiles at z = 0 and z = 20). Build the wire list directly, not through the op: the two originals plus one extra station at t = 0.05 whose loop is the lerp offset along the start section's normal by δ ∈ {0, 0.5, 1, 2}; loft with the shipped `ThruSections` arguments.
  2. Measure the takeoff: on the lateral face nearest the start section, evaluate the surface normal through `BRepAdaptor_Surface_2` + `GeomLProp_SLProps_1` at several u along v ≈ 0 and compute the angle between the v-tangent and the section plane; compare δ = 0 against each δ > 0. Record that the start wire is byte-identical (it must be — the originals are returned at both ends).
  3. Integrity: zero free edges after sewing and a finite, positive volume for every δ; a self-intersecting result fails the row.
  4. Repeat with an offset-circle pair, an asymmetric pair (circle to rectangle), and 6 versus 12 stations, to find where the effect saturates or `ThruSections` averages it away.
- **Decision gate:** *pass* — a monotonic, repeatable tangent change of at least 5° across δ with no self-intersection, on all three fixtures. *Fail* — the change sits inside measurement noise or is non-monotonic → Kernel-blocked beside the takeoff-conditions entry, with the numbers. *Partial* — works on straight pairs only → keep here, narrowed.
- **If admitted:** Phase 1 (**M**) — `takeoff?: { startDeg?, endDeg? }` on `loft`, implemented as one extra station per end, labelled "approximate takeoff" in the panel, `OP_PARAM_DOCS` and the docs, with the probe's published sensitivity limits. Never labelled as an exact tangent or curvature constraint.
- **Out of scope:** any `MakePipeShell` revival — `SetMode_4` returns `false` even for the spine, recorded under Non-goals.

##### 3.11 VRML export {#vrml-export}

*Area: Formats.*

- **Hypothesis:** `VrmlAPI_Writer`, green and never mentioned anywhere else in this repository, writes a B-rep to a `.wrl` file that other VRML readers open.
- **Evidence today:**
  - `.wrl` is not an export target.
  - three's `VRMLLoader` can read the result back, which makes round-trip checking cheap.
  - Gmsh can also write `.wrl`, but only for meshes.
- **Probe (S):**
  1. Write `bull.stp` and confirm the file loads in three's `VRMLLoader`.
  2. Compare the triangle count with the viewer's own tessellation.
- **Decision gate:**
  - **Pass:** a readable file.
  - **Fail:** recorded.
- **If admitted (S):** a VRML export target for B-rep sources. Low value: VRML is legacy, and glTF already covers display exchange.

#### 5. Platform probes {#platform-probes}

##### 5.1 Per-document kernel isolation {#per-document-kernel-isolation}

*Area: Platform.*

- **Hypothesis:** one kernel worker per open document, instead of one shared worker, fits in memory for a realistic number of open tabs. It would remove the two costs `CLAUDE.md` records as accepted trade-offs.
- **Evidence today:**
  - Every open document shares one forked kernel worker.
  - A crash, a watchdog kill or a user cancel therefore discards every document's cached shape, and a cancel can interrupt another document's running call.
  - Document-scoped jobs made cancellation owner-aware, but a *kill* is still process-wide.
- **Probe (S):**
  1. Measure resident memory of one idle worker after OCCT, Gmsh and meshio++ have each been used once.
  2. Measure four workers, each holding one of the four perf fixtures.
  3. Measure startup cost per worker.
  4. Record the numbers against a stated ceiling. As a starting proposal, 1.5 GB for four documents, to be confirmed with the maintainer.
- **Decision gate:**
  - **Pass:** within the ceiling. A pool capped at N workers, with the shared worker as overflow, becomes the design.
  - **Fail:** recorded. The shared worker stays, and the trade-off is re-stated with numbers.
- **If admitted (M):** `kernelClient.ts` maps each owner to a worker, and the watchdog and cancel paths kill only the owning worker.

##### 5.2 Multilingual user interface {#multilingual-user-interface}

*Area: Platform.*

- **Hypothesis:** the interface can be translated, and numbers localised, without changing any machine-readable contract. Those contracts are the sidecar JSON, the expression grammar, the MCP outputs and the format writers. VS Code's own mechanisms can carry the host half: `package.nls.<locale>.json` for manifest strings and `vscode.l10n` bundles for runtime strings.
- **Evidence today:**
  - User-facing text is English literal throughout: about 165 status and notification call sites in `src/` (tests excluded), plus the static markup in `src/viewerDom.ts` and the panel classes.
  - `package.json` has no `%key%` references and no `package.nls*.json`, so even command titles and setting descriptions are English-only.
  - Numbers are where the difficulty lies. `src/paramExpr.ts` treats `,` as the separator between function arguments (`paramExpr.ts:154`), so a decimal comma cannot be admitted naively inside an expression.
  - The locale has already bitten once: the Part-size fields moved from `type="number"` to `type="text"`, because a number input renders through the OS locale, so `4.0231` read `4,0231` on a Spanish machine.
  - Five files pin `en-US` explicitly (`tessellationExport.ts`, `provider.ts`, `dockStats.ts`, `entityExplain.ts` and `meshingPanel.ts`). A locale switch has to decide, file by file, whether each pin is a contract or a formatting choice.
- **Probe (S):**
  1. *Grammar.* List every place a comma is significant: function arguments in `paramExpr.ts`, and any list-valued field. Then test whether a decimal comma can be admitted in a plain numeric field only, parsed before the expression grammar and rejected inside an expression with a message that names the rule. Unit-test that `.`-decimal input is unchanged, and that `1,5` in a numeric field reads as 1.5 under the chosen rule.
  2. *Platform localisation.* In `test:integration`, launch the test VS Code with `--locale=es` and throwaway `package.nls.es.json` and `l10n/bundle.l10n.es.json` files. Assert that a manifest title and a host notification both resolve to their Spanish text.
  3. *Catalogue cost.* Move the status and notification strings and the static `viewerDom.ts` labels into a throwaway catalogue with one extra locale. Record the gzip growth of `media/viewer.js` and `dist/extension.js`, and confirm `test:webview` passes with the locale forced. As a starting proposal, a ceiling of 10 % growth of the viewer bundle per locale, to be confirmed with the maintainer.
  4. *Contract boundary.* Confirm from `describe_capabilities` and the sidecar parsers that no machine-readable key is derived from display text.
- **Probe progress (2026-10-23):**
  - **Step 1, grammar: done.** `src/localeNumber.ts` (`normalizeDecimalComma`) admits a decimal comma only where the whole field text is one number (`1,5` → `1.5`, a comma is never a thousands separator, so `1,234` → `1.234`), leaves `max(1,5)` untouched and rejects a bare comma inside an expression (`1,5+2`) with a message naming the rule. Unit-tested and bug-injected; it is not yet wired into any input field, so no behaviour changed.
  - **Step 3, catalogue cost: measured (2026-10-23).** A throwaway Spanish-sized table (each string plus ~14 %) of the 250 static `viewerDom.ts` text nodes and titles went into the viewer bundle, and the 23 literal `show*Message` strings into the extension bundle. Gzip grew from 805 976 to 812 646 B for `media/viewer.js` (+6 670 B, +0.83 %) and from 411 805 to 412 707 B for `dist/extension.js` (+902 B). That is far under the 10 % ceiling per locale. It does not yet cover the strings built inside the panel classes (likely several times the markup count) or interpolated messages, so expect roughly 3–5 % per locale for a complete catalogue — still inside the ceiling. Not committed; `test:webview` with a forced locale needs Phase 1's lookup and was not run.
  - **Step 2, `--locale=es`: not run.** The sandbox cannot download VS Code (proxy 403), so `test:integration` cannot launch here. Run it in CI or locally.
  - **Step 4, contract boundary: done.** Op kinds and panel ids are ASCII identifiers and the stored op JSON keeps its `op` kind, never `describeOp`'s display text (pinned in `opCatalog.test.ts`). The decimal-comma rule is now applied in the edit-op numeric fields (`parseNumeric`) and covered by a `test:webview` case that was bug-injected.
  - **Gate so far: Partial pending step 2.** Display localisation plus the decimal-comma rule is viable; `--locale=es` platform resolution still needs a CI run. The `en-US` pins: `tessellationExport.ts` (agent-read error text, contract, keep), `threeMf.ts` `xml:lang` (format contract, keep), `provider.ts`, `dockStats.ts`, `entityExplain.ts`, `meshingPanel.ts` (formatting choices, decided in Phase 2).
- **Decision gate:**
  - **Pass:** one unambiguous number-input rule, platform localisation resolves, and growth stays inside the ceiling.
  - **Partial:** no safe input rule → localise display only, keep `.`-decimal input with a visible hint, and record that as the decision. Localised display alone is still a product.
  - **Fail:** platform localisation does not resolve under `--locale` → webview catalogue only, manifest strings stay English, recorded here.
- **If admitted (L, provisional; each phase is verified on its own):**
  - **Phase 1 (M):** externalise every string into one English-source catalogue. A structural gate in `npm test` fails on a key used in source but missing from the catalogue, in the style of the documentation coverage gate. The English build must not change: `test:webview` stays green, and regenerated screenshots show no unintended text change.
  - **Phase 2 (S–M):** locale-aware number and unit display through `Intl.NumberFormat`, using the rule the probe chose. Plurals go through `Intl.PluralRules`, never string concatenation. Each of the five pinned `en-US` files is decided explicitly.
  - **Phase 3 (M):** manifest strings through `package.nls.<locale>.json`, host notifications through `vscode.l10n`, and the first translated locale. Which language comes first is the maintainer's decision. The phase includes a translator workflow and an English fallback for missing keys.
  - **Phase 4 (L, a separate decision):** documentation localisation through VitePress locales. Not part of Phases 1–3.
- **Out of scope:**
  - MCP tool descriptions, error text and output keys stay English. An agent consumes the contract, and translating the contract would mean a second surface to test.
  - Right-to-left layout.
  - Machine translation of shipped strings without a reviewer.
  - Locale-dependent sidecar or export formats. Every file this extension writes keeps `.` decimals.
- **Done when:** a second locale passes `test:webview` and `test:integration` with its own catalogue; the gate reports zero missing keys for that locale; English screenshots are unchanged apart from intentional text edits; and each of the five pinned `en-US` files has a recorded decision.

##### 5.3 Inline 3D preview as an MCP App resource {#mcp-app-inline-preview}

*Area: Platform, Ecosystem.*

- **Hypothesis:** an MCP App resource — a `ui://cad-preview/…` resource of type `text/html` carrying a quantised mesh and a minimal viewer — renders an interactive 3D preview inline in hosts that support MCP Apps (Claude Desktop, VS Code), instead of the four static PNGs `render_snapshot` returns today.
- **Evidence today:**
  - Both projects in the [agent-CAD comparison](#agent-cad-comparison) ship one. ReOpenSCAD's `ui://reopenscad/workspace/{id}` page embeds the mesh inline in a compact quantised form, because the page cannot fetch; text-to-cad's `cad_show` mounts a viewer card and its `cad_view`/`cad_screenshot` take the returned view token.
  - Here, an agent sees geometry only as PNGs (`render_snapshot`, which also needs Playwright and Chromium and reports `supported: false` without them) or as numbers.
  - Unknowns: whether the pinned `@modelcontextprotocol/sdk` can declare the resource and the tool-result link; which hosts actually render it; and how large a page `bull.stp` produces.
- **Probe (S):**
  1. Serve a resource with `bull.stp`'s welded triangles quantised to uint16 against its bounding box, plus a hand-written WebGL viewer (no three.js — the page must be self-contained), and link it from a tool result.
  2. Open it in two hosts and record which render it, and what CSP each applies.
  3. Record the page size for `bull.stp` and `turbine.stp`, against a starting ceiling of 2 MB to be confirmed with the maintainer.
  4. Confirm stdout stays pure JSON-RPC (`mcp:smoke`).
- **Decision gate:**
  - **Pass:** at least one host renders it within the ceiling → admitted.
  - **Fail:** no host renders it, or the SDK cannot declare it → recorded; PNGs remain the answer.
- **If admitted (M):** a `preview` resource offered beside `render_snapshot` (not replacing it — the PNGs are what an agent can *look at*), with a size cap that falls back to the images.
- **Out of scope:** reporting the user's camera or selection back to the agent through the page (the shipped Copy reference is the cheap version).

### 6. Strategic — multi-phase bets {#strategic-—-multi-phase-bets}

*Admission: an L-sized, multi-phase effort that gates other items or reopens Non-goals. Each starts with its own probe, and nothing below it is estimated until that probe reports.*

#### 6.1 Self-built OCCT WASM {#self-built-occt-wasm}

*Area: Platform.*

- **Hypothesis:** a WASM build of OCCT 7.8, built by this project the way `@loumalouomega/gmsh-wasm`, `mmg-wasm` and `float-tetwild-wasm` were, can replace `opencascade.js` 1.1.1 with this codebase's call shapes unchanged. Its bindings list would be chosen for this codebase, and that could make kernel-blocked APIs reachable.
- **Evidence today:**
  - **The pin is old and alone.** `opencascade.js` 1.1.1 references OCCT `V7_4_0`, and its 2.0 beta has had no release since 2023. The Gmsh binary in the same extension already carries OCC 7.8.1.
  - **Most Kernel-blocked Non-goals are binding gaps in this particular build**, not limits of OCCT:
    - `HLRBRep_*` is entirely red;
    - `Font_*` is entirely red;
    - `TCollection_ExtendedString` cannot become a JS string, which blocks XCAF names;
    - `XCAFDoc_ColorTool.GetColor` has no reachable argument shape;
    - `IMeshTools_Parameters` is unbound;
    - `GeomAPI_Interpolate` and all of `BOPAlgo_*` are red;
    - `BRepOffsetAPI_MakePipeShell`'s `SetMode_4` returns `false`.
  - **The call surface is known.** Every OCCT call this codebase makes has its overload suffix and argument count recorded in `CLAUDE.md`, and the committed probe harness can replay them.
  - **The regression net exists:** `npm run mcp:smoke`, `npm run compat`, `npm run perf`, and the unit tests that exercise OCCT through the kernel worker.
- **Probe (M):**
  1. Build OCCT 7.8 to WASM with Emscripten. Generate embind bindings for exactly the classes and overloads this codebase calls, keeping the suffix naming.
  2. Swap it in behind the existing `getOcct()` singleton, then run `mcp:smoke`, `compat` and `perf` unchanged. Record every failing call.
  3. Measure the `.wasm` size against the current binary.
  4. Add the kernel-blocked classes listed above, one at a time. Re-run each recorded probe, the HLR and `ColorTool` ones first.
- **Decision gate:**
  - **Pass:** the suites pass with call shapes unchanged, the build is no larger, and at least two kernel-blocked probes flip.
  - **Partial:** the suites pass but nothing flips. Adopt it for currency alone, and keep the Non-goals.
  - **Fail:** the build or the suites fail → stay on 1.1.1. Record the blockers, and re-check the upstream 2.x line yearly.
- **If admitted (L):**
  - Publish `@loumalouomega/occt-wasm` and switch the dependency. The licence is LGPL-2.1 with the OCCT exception, and the attribution stays as it is today.
  - Then re-open each Kernel-blocked Non-goal as a probe in its own right.
- **Out of scope:** changing any op's behaviour during the swap. The first milestone is identical output.

#### 6.3 Kinematic mates, named poses and pose-swept clearance {#kinematic-mates-and-pose-sweeps}

*Area: Geometry.*

- **Hypothesis:** revolute and slider joints between Parts, with limits and named poses, let the existing interference and clearance checks run across a motion range instead of at the one pose a file happens to be saved in.
- **Evidence today:**
  - Assembly support stops at static placement: `mate` aligns two faces once, and `explode` previews a spread. Nothing records that a lid rotates about a hinge axis between 0° and 110°.
  - text-to-cad models this directly — `revolute`, `slider`, `cylindrical` and `fastened` mates with required limits on anything that moves, couplings, and named poses — and its own validation guide says a static clearance check "proves only that pose".
  - The checking half is already here: `check_interference_all` and its `minClearance` near-miss reporting run on whatever geometry they are given. What is missing is a way to put a Part at a pose without rewriting the op list.
- **Probe (M — a design question as much as a kernel one):**
  1. **Scope.** Decide with the maintainer whether this is assembly *checking* (in scope: preparing a model for analysis) or assembly *authoring* (a modelling application, which the Non-goals reject). The answer bounds everything below.
  2. **Storage.** Joints and poses are neither geometry nor display state. Decide whether they are an eighth sidecar or ride the parts sidecar, and how they survive `entityRebind.ts` when the axis references a face.
  3. **Evaluation.** Prototype a pose as a rigid transform applied to one Part's solids after the op-list replay (`BRepBuilderAPI_Transform_2`, the verified call shape), and sample a hinge at N angles through `checkInterferenceAll`. Record the cost per sample on a real assembly.
- **Decision gate:**
  - **Pass:** a checking-only scope is agreed, the storage fits the sidecar rules, and a sweep of 20 poses costs less than the kernel watchdog on the largest assembly fixture.
  - **Fail:** recorded under Rejected scope with the scope answer.
- **If admitted (L, provisional):** joints and poses in the chosen sidecar, a `pose` parameter on the analysis tools, a sweep option reporting the first colliding pose, and a pose picker in the viewer.
- **Out of scope:** URDF/SDF export; animation authoring or video export; joint couplings and solvers.

## Definition of done

- **Behaviour:** complete the stated workflow, including cancellation, stale replies, empty input and reopen where relevant. A successful API return or non-empty file is not enough.
- **Evidence:** pure math gets analytic fixtures; kernel changes get live-WASM checks; webview changes get real-bundle interaction/render assertions; save/watch flows get the real host where feasible. State any remaining manual verification gap precisely.
- **Compatibility:** preserve source-write confirmation, deterministic entity-id rules, tolerant sidecar parsing and lazy host-only kernels. New bundled dependencies require a GPL-compatibility check.
- **Parity:** name the item's MCP tool (or `supported: false` shape) and its interactive surface, or say why one side is deliberately absent. A capability reachable from only one side is a gap the next review will list.
- **Documentation:** update affected protocol, API, format and getting-started references together. Regenerate screenshots for viewer markup/panel changes and visually inspect a full 3D shot. Add a changelog entry when releasing a new version.
- **Known limitations:** re-read `doc/getting-started.md`'s Known limitations list whenever a release touches one of its entries. Two entries were found stale in the 2026-09-24 review (hidden-line removal, and where tessellation runs).
- **Closure:** remove the completed scope from this backlog, record only the invariants and traps in `CLAUDE.md`, and retain only a genuinely separate, scoped follow-up. An unverified branch is not closed merely because the happy path shipped.

## Non-goals / known constraints

Three groups, three different revival rules. Each says what would change our mind.

### Architectural invariants

*Not revivable as stated. These are design decisions enforced structurally rather than by convention — but "enforced structurally" is a claim about the code, not a licence to stop re-reading it, which is how the entry below came to be promoted.*

- **OCCT in the webview** — the kernel stays in the extension host; the webview runs only Three.js. Since the kernel-worker work this is *stronger* than the invariant requires: OCCT, Gmsh, meshio++ and fTetWild all run in a forked child process (`src/kernelWorker.ts`), one process further from the webview than the rule demands.

- **No silent CAD-source writes.** Explicit save-in-place already ships through the editable custom editor and headless `save_model`; this is not a read-only application. Sidecar autosave and external-change reconciliation must not silently bake edits into the source. Preserve the confirmed-save contract, `bakedThrough` replay watermark and backup/recovery behaviour. The seven sidecars retain state that has no home in the source format; see `CLAUDE.md` for the implementation history.

### Kernel-blocked

*Revivable only by a new OCCT WASM build, or by a genuinely new idea that routes around the kernel — as the hidden-line item below actually did. Every entry records its probe so it isn't re-run.*

**Every entry here is re-opened by the [Self-built OCCT WASM](#self-built-occt-wasm) item if it passes.** These are binding gaps in `opencascade.js` 1.1.1 (OCCT `V7_4_0`), not limits of OCCT itself, and that item's probe re-checks each one against a newer build.

- **Whole families red in the current manifest.** Nothing in them is reachable today, so no feature is proposed on top of them:
  - `BOPAlgo_*`: including `CellsBuilder`, `MakePeriodic`, `ArgumentAnalyzer` and `RemoveFeatures`.
  - `Geom2dAPI_*`: 2D interpolation, intersection and projection.
  - `IGESCAFControl_*`: so IGES names and colours cannot be read.
  - `BinXCAFDrivers`.
  - `XCAFDoc_GeomTolerance`: so GD&T is readable at most in part; see the [PMI probe](#read-pmi-layers-and-materials-from-step).

  Recorded by the [kernel capability review](#kernel-capability-review).

- **`ShapeFix_Face` / `ShapeFix_Wire` / `ShapeFix_FixSmallFace` / `ShapeFix_FixSmallSolid` (B-rep repair).** Probed live (opencascade.js 1.1.1, 2026-10-25, `scripts/probe/examples/occt-shapefix.ts`). Call shapes: `ShapeFix_Face_2(face)` → `Perform()` → `Face()`; `ShapeFix_Wire_2(wire, face, prec)` → `Perform()`; `ShapeFix_FixSmallFace` and `ShapeFix_FixSmallSolid` have **no `_N` constructors, only the plain `new`** (`FixSmallFace`: `Init(shape)`/`Perform()`/`FixShape()`; `FixSmallSolid.Remove` takes 2 arguments). Results: on `daratech.stp` all five faces `check_brep_health` flags (`face-13/54/58/70/71`, `UnorientableShape`) stay invalid — `ShapeFix_Face.Perform()` returns `false` on each, `ShapeFix_Wire` reports nothing fixed, volume unchanged; fixing every face changes one face and still leaves five bad. On `piston.stp` `ShapeFix_FixSmallFace` leaves the 48 open-boundary edges and the face count untouched (`ShapeFix_Face` likewise). Control `bull.stp` is unchanged by every fixer (volume equal to 1e-8 relative, `FixSmallFace` BREP text identical), so the fixers are safe but inert here. `FixSmallSolid` was only constructed (no fixture contains a small solid). **Revive only** with a fixture where a fixer demonstrably clears a `check_brep_health` finding, or a build that binds `ShapeFix_Shell`/`ShapeFix_Shape`; `check_brep_health` stays facts-only.
- **`BRepExtrema_SelfIntersection` (face self-intersection).** Probed live (opencascade.js 1.1.1, 2026-10-25, `scripts/probe/examples/occt-brep-health-facts.ts`): the prototype is empty and both `_1(tol)` and `_2(shape, tol)` constructors throw `Cannot construct … due to unbound types: 25BRepExtrema_ElementFilter`, so a box with a face pushed through the opposite face cannot be tested. `check_brep_health` therefore reports no self-intersection fact. **Revive only** with a build that binds `BRepExtrema_ElementFilter` (the self-built OCCT probe re-checks it).
- **Hidden-line removal through OCCT's own `HLRBRep_*` family.** Every class is red in this build: `HLRBRep_Algo`, `HLRBRep_PolyAlgo`, `HLRBRep_HLRToShape`, `HLRBRep_PolyHLRToShape`. `HLRAlgo_Projector` is green but is a low-level internal only reachable through them.

  **The narrow survivor, `HLRAppli_ReflectLines`, was probed and is not the way in either — and it is this file's canonical example of green-but-useless.** The binding genuinely works: the unsuffixed constructor takes a `TopoDS_Shape`, and `SetAxes`/`Perform`/`GetResult` are all bound and functional (249 ms on `bull.stp`, returning a non-null compound this codebase's own `enumerateEdges` reads as 25 edges). It was rejected on the *drawing*, which is only visible by looking at it: rendered side by side against a tessellation-derived silhouette of the same view, `GetResult()` produced the outer boundary and a few fragments while missing the part's circular holes and interior cutout entirely. `GetResult()` returns reflect lines only; sharp feature edges live behind `GetCompoundOf3dEdges(type, …)`, whose `type` argument is an `HLRBRep_TypeOfResultingEdge` — from the entirely-red family above — so calling it throws. The one filter that would make the kernel path competitive is unreachable.

  **What routed around it, and what that leaves.** `export_svg_silhouette` (`src/silhouetteEdges.ts`) and then `export_technical_drawing` (`src/hiddenLineRemoval.ts`) both ship on triangle adjacency, calling no OCCT hidden-line API at all — so hidden-line *drawings*, visible edges solid and occluded runs dashed, exist today for B-rep **and** mesh sources alike, which the kernel path never could have handled. A local sibling project, HCAD, independently arrived at the same shape.

  **Correction, recorded because this entry was stale for a while:** it used to say dimensions were also out of scope. They are not. `exportTechnicalDrawingTool` is a one-line wrapper over `exportSvgSilhouetteTool`, which reads `<model>.annotations.json` unconditionally, projects every pinned measurement through the export's own view basis, and returns `dimensionCount` — in SVG *and* on DXF's own `DIMENSIONS` layer, tolerance bands included. **A second correction, since closed in full:** this entry also used to name multi-view sheet layout as what remained unshipped. That has since closed too — `export_drawing_sheet`/File ▸ Export Drawing Sheet… place several views on one sheet at a shared scale with a title block, first- or third-angle projection (see `CLAUDE.md`'s "Multi-view drawing sheets"). Nothing is currently tracked as unshipped from this Non-goal.

- **Glyph → `TopoDS_Shape` via OCCT fonts.** Every `Font_*` class is red: `Font_BRepFont`, `Font_BRepTextBuilder`, `Font_FTFont`, `Font_FTLibrary`, `Font_FontMgr`, `Font_SystemFont`, `Font_TextFormatter`. There is no path from a font file to a shape inside this build.

  **Narrowed twice, and this entry used to overstate itself.** It was titled "3D text, engraving, and embossing" — but engraving and embossing **ship**, as `wrap`'s `emboss`/`engrave` variants, and have nothing to do with fonts. And the text half is not kernel-blocked either, only *font*-blocked: outlines that arrive as SVG paths become ordinary sketch geometry — "3D text via outline import" (the ready-product-work item this entry used to point at) has since closed in full: `svgImport.ts` now composes ancestor `transform`s (so a real "convert text to outlines" export, typically wrapped in `<g transform="...">` groups, lands correctly), `addSurfaceFromLines` accepts several disjoint loops forming one outer boundary plus its holes (a letter with a counter, e.g. an "O", builds as one holed face), `wrap` develops a holed profile onto a cylinder/cone (each hole cut out of the shell), and `import_svg` exposes the whole pipeline headlessly. Nothing is currently tracked as unshipped from this Non-goal.

- **Loft start/end (takeoff) conditions.** `BRepOffsetAPI_ThruSections` exposes no condition API — of its bound knobs only `SetSmoothing` moves geometry (`SetContinuity`/`SetParType`/`SetMaxDegree`/`SetCriteriumWeight` are accepted but byte-identical everywhere tried, so only smoothing is exposed) — and the pipe-shell conditions have no reachable consumer: `BRepOffsetAPI_MakePipeShell`'s `SetMode_4(wire)` returns `false` even for the spine itself, and `BRepFill_FaceAndOrder_2`/`EdgeFaceAndOrder_2` exist as signatures with no sweep to attach them to. Out of scope is only the *constraint*; steering a loft along a rail already ships via the resampled-intermediate `guides` fallback, which is a different feature, not a silent substitution. The [takeoff approximation probe](#loft-takeoff-by-resampled-intermediates) above explores a separate route, not a revival of this dead API.

### What a new gmsh-wasm build must supply {#gmsh-wasm-upstream}

*Maintainer checklist for `@loumalouomega/gmsh-wasm` (0.4.0, Gmsh `5.0.0-git-29726e7`, OCC 7.8.1 — the same Gmsh commit as 0.3.0). Every item is a blocked or rejected entry elsewhere in this file whose "revive only" condition is a change to the Gmsh WASM build, collected so the work can be done in one pass. Nothing here can be fixed from this repository: the probes below only show whether a new build clears the gate.*

**Do first, for every item: reproduce against a native Gmsh built from the same commit** (`29726e7`, same OCC) with the same script. If native Gmsh shows the same behaviour, it is Gmsh's, not the WASM build's, and the fix is a newer upstream commit or an upstream issue. If native differs, the bug is in the Emscripten build (flags, a missing option, a stubbed dependency).

| Priority | What is required | Why we need it | Gate that a new build must pass |
| --- | --- | --- | --- |
| 1 | **A usable 3D boundary layer on OCC-imported solids.** Either a `model.occ` twin of `geo.extrudeBoundaryLayer` (the typings have none), or confirmation that the `geo` version accepts an OCC-imported surface and yields prismatic layers that mesh with the volume. Today it accepts the surface and returns entities, but nothing shows the volume mesh uses them. | 3-D boundary layers: the shipped 2-D `Part.meshBoundaryLayer` does not extend to 3-D without it (a 3-D generate ignores the layer with a warning). | On `block.stp`, extruding one face yields wedge/hex layers of the requested heights, `generate(3)` produces a conformal tet + prism mesh with no volume loss (sum equals 60), and the Part physical groups survive. |
| 2 | **Documented, closing type-140 geometry.** `getElementProperties(140)` throws, so the node layout of the hex-dominant trihedron connector cannot be confirmed; no reading of the 4-node cells closes the model volume (60 → 60.73 / 63.4). | Lets [hex-dominant Kratos MDPA export](#kernel-blocked) revive, and lets `Recombine3DAll` meshes be exported at all. | `getElementProperties(140)` returns a name, dimension and node count; on `block.stp` (`Algorithm3D` 9, `Recombine3DAll`, size 1) tets + hexes + 140-cells sum to the model volume within 1e-6 with consistent orientation. |
| 3 | **`occ.healShapes` that does not delete a volume.** On `daratech.stp` it removes the only volume (1 → 0) instead of repairing the "segment and facet intersect" defect that stops 3D meshing. | A cheap pre-mesh repair for dirty STEP, in place of routing everything through fTetWild. | `daratech.stp` after `removeAllDuplicates` + `healShapes` still has 1 volume and meshes to its true volume; `block.stp` keeps 6 faces and volume 60. |
| 4 | **An `optimize("Relocate3D")` that changes the mesh.** The call is accepted and is bit-identical to no optimisation (minSICN 0.027591537627954913 on `bull.stp` both runs), while Netgen and HighOrderElastic move it. Likely a stubbed or unreachable pass in the build. | A third optimisation mode for the `optimize` enum. | `bull.stp` at the smoke-test size: worst-element minSICN and mean both increase, on two runs. |
| 5 | **`mesh.setCompound` that raises minimum quality.** It is accepted but lowered minSICN on `bull.stp` (0.0269 → 0.0104). Probably Gmsh behaviour rather than the build; reproduce natively first. | A "merge smooth patches" meshing option. | A fixture where compounding raises minimum quality with Parts intact (the `bull.stp` harness in `gmsh-section4.ts`). |

**Requirements that must not regress in any new build** (each is load-bearing in `CLAUDE.md`):

- `General.BuildInfo` keeps listing `BoundaryLayers`, METIS (`partition` works), and OCC; add the build commit so the roadmap can name it.
- The CJS entry loads through `createRequire` with `wasmBinary`; no top-level `await` in the ESM chain (the extension bundles as CJS).
- `print` / `printErr` must be injectable (the default writes to fd 1, the MCP JSON-RPC channel).
- Single-threaded operation must remain enforceable: `General.NumThreads` and `Mesh.MaxNumThreads1D/2D/3D` set to 1 and read back (the extension throws if they are not).
- The binary stays a plain file next to the package (it is staged into `dist/gmsh-core.wasm`) and its licence stays GPL-compatible.

**Not a Gmsh build change, listed so it is not mistaken for one:** graph partitioning for per-rank MDPA export. It moved to meshio++ and KaHIP and has shipped (see [Partitioned MDPA](./gmsh-integration.md#partitioned-mdpa)); Gmsh's METIS `partition` passed its mechanism probe but renumbers entities and writes `$PartitionedEntities`, which no reader here consumes, so it was not used.

**When a new build is published:** bump the dependency (`npm ci`, then `npm outdated` for the kernel packages), re-run `scripts/probe/examples/gmsh-section4.ts`, `gmsh-boundary-layer.ts` and `gmsh-relocate3d.ts`, file a dated result under each item above, and only then move an item out of Non-goals.

**Re-run on 0.4.0, 2026-10-19** (`Packaged by: gmsh-wasm-0.4.0 (gmsh-commit 29726e7…)` — the same Gmsh commit as 0.3.0, so a changed Gmsh behaviour was not expected):

- **Boundary layers** — flipped, but not by the build: 0.3.0 and 0.4.0 give identical results, and both compose a layer with a `Distance`+`Threshold`+`Min` background in either call order (the shipped `Part.meshBoundaryLayer`). Not shipped: 3-D layers (row 1 above).
- **Type 140** — unchanged: `getElementProperties(140)` still throws, and a hex-dominant `block.stp` still yields types `[4, 5, 140]`.
- **`healShapes`** — unchanged: `block.stp` keeps 6 faces and volume 60, `daratech.stp` still goes 1 volume → 0 (175 faces unchanged) and "meshes" to 0 tets.
- **`Relocate3D`** — unchanged: on `bull.stp` (diagonal / 15, Algorithm3D 1) the worst-element minSICN is bit-identical before and after (0.010410970049001995, two runs, mean +0.0019) while the `Netgen` control moves it (min 0.0398, mean 0.7553).
- **`setCompound`** — not re-run: it needs the smooth-linked face-group harness, which was never committed, and the Gmsh commit is unchanged.
- **Periodic pairs and the size callback** — still work (`gmsh-section4.ts`: 75 of 75 nodes matched; 16 658 callback calls).

### Rejected scope

*Revivable only under a different framing — the objection is to what the feature would make this tool, not to whether it could be built. Narrower alternatives are identified below; some already ship.*

- **MMG `optim` as an unconditional quality improvement or automatic post-Generate pass.** The MMG core probe (0.1.0 / MMG 5.8.0, 2026-10-06) used `mmg3d.setIparameter(mesh,met,IPARAM_optim,1)` then `remesh(mesh,met)` on fTetWild output of `examples/STL/holed-cube.stl`. Gmsh independently measured minSICN falling **0.427485 → 0.271894**, then **0.345839 → 0.322069**; the repeat also changed **9,503 → 24,322 tets**. The binding works, but the quality-improvement promise does not. **What survives:** ordinary reference-preserving volume and surface remeshing (shipped; see `doc/gmsh-integration.md#mmg-remeshing`), without this guarantee. **Revive only** for a different explicit strategy that passes independent quality and geometry checks on the motivating fixture; do not silently substitute MMG's own metric for the Gmsh minSICN gate.

- **Gmsh `optimize("Relocate3D")` as a mesh optimisation mode.** Probed live (gmsh-wasm 0.3.0, `bull.stp` at the smoke-test size, two full runs): worst-element minSICN came back bit-identical (0.027591537627954913 both runs, mean +0.0017) — a no-op on what matters, while Netgen and HighOrderElastic measurably move the same numbers (shipped as the `optimize` enum; see `doc/gmsh-integration.md#mesh-optimisation`). **Revive only** with a measured min/mean gain on the same fixture from a newer Gmsh build. Re-checked 2026-10-19 on gmsh-wasm 0.4.0 (same Gmsh commit): still a no-op on the worst element (`scripts/probe/examples/gmsh-relocate3d.ts`).

- **Compound meshing across sliver faces (`model.mesh.setCompound`).** Probed live (gmsh-wasm 0.3.0, `bull.stp` at the smoke-test size, three full runs, bit-identical): compounding the four smooth-linked face groups ([4, 3, 2, 2] faces from 9 smooth edges; all 36 faces bbox-correlated; Part physical group intact; valid `.msh`) repeatably *lowered* minimum quality (minSICN 0.0269 → 0.0104; mean 0.7289 → 0.7157; sub-0.2 count 31 → 30; elements 1700 → 1650) instead of raising it. The binding works — accepted without a throw — but the quality promise is backwards, so there is no "Merge smooth patches" option to offer. **Revive only** with a real fixture where compounding measurably raises minimum quality with Parts intact, on the same harness.

- **Interactive sketching with geometric constraints** — rejected, not deferred. It is the single clearest "this is a modeling application now" feature, and CAD-Preview is a preview/inspect/prepare tool. More concretely: the numeric profile and curve forms are **not** a degraded mouse — they accept parametric variable expressions (`L*2`, `R*cos(i*360/N)`) that a click-to-place tool cannot express, so replacing them with drawing would trade away a distinguishing capability for a familiar one. The argument has only got stronger: no constraint solver exists anywhere in the codebase (the sole `constraint` hit is `mate`'s doc comment), while the expression-driven sketch vocabulary has kept growing to sixteen creation ops. Worth noting that SketchForge, a dedicated sketch application, still has no constraint solver either — building this would mean shipping the weak two-thirds of the feature.

  **What survived the reframing:** authoring a profile *on a named construction plane* rather than in world coordinates (shipped as "Author profiles on a named construction plane" — see `CLAUDE.md`). That is a coordinate-frame convenience over machinery that already exists, and it does not put a solver anywhere.

- **Reference-image tracing underlay** — rejected for the current preparation workflow. It would introduce image placement, calibration and tracing interactions without a sketch-authoring workflow to consume them. Tracing in a vector editor and importing through `svgImport.ts`/`dxfImport.ts` already yields editable geometry. Revisit only for a concrete calibrated inspection use case that does not require a constraint-based sketcher. This is a scope decision, not a CSP or “no image assets” invariant: data images are already allowed, and standard-parts thumbnails serve a different workflow.

- **Parametric part generators as kernel primitives (involute gears, thread forms, springs)** — rejected as *kernel geometry*. Standard parts are something this tool should mostly *source*, not author: `search_standard_parts`/`download_standard_part` fetch real, verified geometry from step.parts as ordinary STEP files the existing pipeline opens, and the interactive sidebar does the same. Authoring an involute tooth-flank generator in `occtOperations.ts` is modeling-application scope.

  **What survived the reframing:** the same shapes as *macros* — closed as the "bundled starter macro library" item (`spring`, `bolt-circle-flange`, `hex-bolt` in `macros/starter-library.json`, served when `libraryPath` is omitted). `addHelix` + `sweep` + `repeat` loops + degree trig already express a spring and a thread profile with no new kernel code — the gap was data and a path resolver, not geometry, and step.parts will not hand you a spring at *your* wire diameter anyway.

- **Other meshing kernels: TetGen, CGAL meshers, ParMmg, standalone Netgen** — rejected, recorded so they are not proposed again. The [meshing library review](#meshing-library-review) covers what is proposed instead.
  - **TetGen** is AGPL-3.0: a stronger copyleft than anything bundled so far. It adds nothing fTetWild (robust tets from dirty input) and Gmsh (constrained Delaunay, which already uses tetgen-derived boundary recovery) do not already cover.
  - **CGAL's Mesh_3 and Polygon_mesh_processing remeshers** are GPL-3.0-or-later — no longer a licence barrier now that CAD-Preview is itself `GPL-3.0-or-later`, so this is *not pursued* rather than *blocked*. There is no standalone WASM build of them, and their capabilities are covered by MMG (isotropic surface remeshing) and meshio++'s clustering `remesh`. (The shipped OpenSCAD WASM build does statically link CGAL internally; that does not expose CGAL's meshers to JS.)
  - **ParMmg** is MMG over MPI. A single-process WASM worker has no MPI, and the meshes this extension handles fit a sequential MMG.
  - **A standalone Netgen** would duplicate the copy already linked into the bundled Gmsh, which is reachable through the shipped `optimize: "netgen"` mode (see `doc/gmsh-integration.md#mesh-optimisation`).

  **What would change our mind:**
  - For TetGen: a relicensing decision to AGPL-3.0-or-later made for other reasons (its licence is a stronger copyleft than the project's own `GPL-3.0-or-later`).
  - For CGAL: a concrete capability MMG and meshio++ demonstrably cannot supply, plus a WASM build to consume — its licence no longer blocks it.
  - For ParMmg: a real mesh that sequential MMG cannot handle within the kernel watchdog.
  - For Netgen: a capability the shipped in-Gmsh Netgen demonstrably lacks that a standalone build supplies (the bundled copy passed its probe: repeatable min/mean gain on `bull.stp`).

- **Reimplementing the OpenSCAD language** — rejected, recorded from the [agent-CAD comparison](#agent-cad-comparison). ReOpenSCAD rewrote the lexer, parser, evaluator and CSG kernel from scratch to avoid OpenSCAD's code entirely. The cost is fidelity: no `import()`, `surface()` or `roof()`, no user library paths (so no BOSL2), one built-in stroke font, and a sampled fallback mesher with its own "will not match OpenSCAD" warning. This extension evaluates `.scad` through the real OpenSCAD engine — the bundled WASM port first, the installed `openscad` binary as the fallback — so the install is optional and the engine is not reimplemented. **Revive only** if both the WASM path and the binary path are ruled out.

- **Hosted, shared workspaces and an HTTP MCP transport** — rejected. ReOpenSCAD serves its MCP over HTTP, with the workspace URL itself granting edit access. This extension's MCP server is a local stdio process that reads and writes files the user already owns; a network listener would be a new attack surface with nothing local to gain. What survives: registering the server with VS Code (shipped — the MCP server-definition provider and the **Connect an agent…** snippets) and copyable client snippets. **Revive only** for a concrete embedding request that cannot spawn a process (for example, a KKSS deployment that runs the server remotely), with authentication designed in from the start.

- **Slicing, printer hand-off, supplier ordering and robot-description export** — rejected. text-to-cad ships skills that slice with OrcaSlicer, open Bambu Studio, preflight a SendCutSend order and write URDF/SDF. These are manufacturing and robotics execution, outside a tool for previewing, inspecting and preparing models. What survives is the fact-only analysis these skills start from: the printability facts report (shipped as `check_printability` and the Advanced ▸ Analysis **Printability** panel) and draft and undercut analysis (shipped as `check_draft` and the **Draft** panel). **Revive only** if a downstream tool needs a file format this extension cannot already export (3MF is tracked separately).

- **An in-viewer OpenSCAD editor with live re-evaluation** — rejected. ReOpenSCAD's workbench is a text area with syntax highlighting and live preview; here, VS Code is the editor and the viewer opens beside it. What survives: the Customizer panel (shipped), include tracking (shipped) so a saved edit reloads promptly, and structured diagnostics (shipped). **Revive only** if the side-by-side workflow turns out to be unworkable in practice.

- **Gmsh `occ.healShapes` as a pre-mesh repair for imported B-reps.** Probed live (gmsh-wasm 0.3.0, 2026-10-17): on `block.stp` it is harmless but changes the mesh (1 282 → 1 247 tets, same volume 60, 6 faces before and after); on `daratech.stp` — the model that fails 3D meshing with `PLC Error: A segment and a facet intersect` — `removeAllDuplicates` + `healShapes` **deletes the volume** (1 volume → 0, 175 faces unchanged), so "meshing succeeds" is an empty mesh (0 tets). fTetWild remains the answer for dirty input. **Revive only** with a newer Gmsh build where a healed `daratech.stp` meshes to its true volume. Re-checked 2026-10-19 on gmsh-wasm 0.4.0 (same Gmsh commit): `daratech.stp` still goes 1 volume → 0.

- **Hex-dominant (gmsh type 140) Kratos MDPA export.** Probed live (gmsh-wasm 0.3.0, 2026-10-17, `block.stp`, `Algorithm3D` 9 + `Recombine3DAll`, size 1): the mesh holds tet4 (26.22 volume), hex8 (33.31, all consistently oriented) and 4-node type-140 cells. The 140 cells' faces all mate with tet/140 faces and each hex quad is covered by exactly two of their triangles, so they look like tetrahedra — but no reading of them closes the volume to the model's 60: as tets with signed volume they sum to +1.20 (60.73 total), by absolute value 3.85 (63.4 total), and their orientations are mixed (2.52 positive, 1.33 negative). A conformal export (140 as tets, hexes cut into 12 tets about a centroid, quads split along the neighbours' diagonal) was built and measured at volume 63.48 with 384 faces shared by three or more cells, so it was reverted. `getElementProperties(140)` still throws, so the node layout cannot be confirmed. The explicit refusal in `collectCells` stays. **Revive only** with documented type-140 geometry (a newer Gmsh, or the element's node layout from upstream) that closes the volume. Re-checked 2026-10-19 on gmsh-wasm 0.4.0 (same Gmsh commit): `getElementProperties(140)` still throws.
