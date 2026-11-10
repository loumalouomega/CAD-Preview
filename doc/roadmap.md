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

**Closed 2026-11-01 (1.7; 2.26 first increment; 2.30 stepping).** Extension, not a planning review: nothing was re-ranked. 1.7 (sidecar fields that arrived after the file was written) shipped as `LEGACY_MESH_DEFAULTS` (`conformal` → `false` for a sidecar that lacks it), with a panel/`generate_mesh` note and a drift-guard test; it left this list. No other sidecar was found with a behaviour-changing later-added field. 2.26 (unit-aware document variables) shipped in full: bracketed units plus advisory per-field dimension warnings on `apply_edit_ops`, `set_variables` and the Edits panel, and a deduced `unit` per variable in `get_state`.

**Extended 2026-10-31 (ElmerStudio review and Non-goal recovery).** Extension, not a planning review: nothing was re-ranked and no existing ID moved. The [ElmerStudio review](#elmerstudio-review) added unit-aware document variables (2.26), rule-defined Part membership (2.27, since shipped and removed), the parametric-curve profile (since shipped and removed), transport-agnostic 3D-mouse input (since shipped and removed) and [Part rename and delete events for embedders](#part-rename-and-delete-events) (5.4); a second pass over its picking code the same day added stepping through entities under the cursor (2.30, since shipped and removed), and a third pass over its model-format history added sidecar fields that arrived after the file was written (since shipped and removed). Four Non-goals were re-read against today's kernels (meshio++ 17.23.0 with `fitCad`, `checkConformity` and prism layers, Manifold, the OpenSCAD WASM) and re-opened as probes that route around the dead API rather than revive it: [sampled B-rep self-intersection](#sampled-brep-self-intersection) (3.14), [B-rep repair by refit](#brep-repair-by-refit) (3.15), [3D text through OpenSCAD](#text-through-openscad) (3.16) and [OpenSCAD library staging](#openscad-library-staging) (3.17); section 4 is recreated for [a volume behind the prism-layer shell](#volume-behind-prism-layers) (4.11) and [physics-calibrated size presets](#physics-calibrated-size-presets) (4.12). Each original Non-goal entry stays and points at its probe. Stale facts fixed in passing: the gmsh-wasm version in the kernel review, the meshio++ and `view.*` "never called" rows, two links to a closed validity-report item, and a hex-dominant link that pointed at the wrong Non-goal group.

**Closed 2026-11-03 (Parameters table).** Extension, not a planning review: nothing was re-ranked. 2.31 shipped (comment/favourite/reorder/filter/Unit selector, CSV/JSON import and export, apply-on-leave toggle, Model parameters with Promote to variable; `set_variables`/`get_state` carry `comment` and `favourite`) and left this list; the 2.32 and 2.34 numbers are unchanged. 2.32 (variable Used-by list and expression autocomplete) shipped next and left this list too.

**Closed 2026-11-03 (Command search).** Extension, not a planning review: nothing was re-ranked. 2.34 shipped (Ctrl+K / `/` command search over every op, toolbar action and panel; opt-in `cadPreview.singleKeyCommands` letter keys with Shift+R to repeat the last command) and left this list; the 2.35 number is unchanged.

**Closed 2026-11-03 (Configurations first increment).** Extension, not a planning review: nothing was re-ranked. 2.33 shipped its first increment: named configurations (sparse variable overrides plus `activeConfiguration`, additive in `.edits.json`), the Config Table under the Variables section, `set_configuration`, the `configuration` parameter on the export, meshing and mass tools, and a Batch Export mode (`configurations` / `allConfigurations`, and a Batch Export command prompt) that writes one file per configuration. The remaining phase, per-configuration feature suppression, shipped on 2026-11-05 and 2.33 left the list.

**Closed 2026-11-03 (Ribbon command strip).** Extension, not a planning review: nothing was re-ranked. 2.35 shipped (a View · Model · Inspect · Mesh · Export ribbon under the menu bar, generated from the op catalog plus a small table of non-op actions, with an overflow ▸ menu, a compact preference, a persisted tab and the Edits panel's button grid behind a toggle) and left this list; the 2.36 number is unchanged, and the two-tone icon set is now the one item left in the Interface depth theme.

**Closed 2026-11-03 (Two-tone icon set).** Extension, not a planning review: nothing was re-ranked. 2.36 shipped (a reserved TikZ `blue` fill maps to `--ui-icon-accent`, which follows the theme's button colour and collapses to `currentColor` in high contrast; 17 Model-tab op icons redrawn two-tone) and left this list; the 2.37 number is unchanged, and the Interface depth theme has no open items left. The remaining op icons and the toolbar icons stay one-tone until a later pass.

**Closed 2026-11-06 (History timeline depth; Feature form ergonomics).** Extension, not a planning review: nothing was re-ranked and no other open ID changed. 2.37 shipped its remainder: history **folders** (a display-only `folder` tag on each op, so it rides every existing sidecar path; grouped, collapsible rows in the Edits list; `set_edit_op_state` takes `folder`/`toIndex`) and **drag reorder** (`planOpMove`, shared by the row drag, Alt+↑/↓ and the new `move_edit_op` tool). The reorder check is stricter than the roadmap's "no reference crossing the move": entity ids are positional, so it also refuses two shape-changing ops crossing each other, a stored selector query naming an op in the span, and anything touching the saved prefix. 2.41 shipped its remainder: the operation form can be **docked** over the viewport (`ViewState.formsDocked`, the one node is moved, not copied). Both left this list.

**Extended 2026-11-01 (SolidCraft review).** Extension, not a planning review: nothing was re-ranked and no existing ID moved. The [SolidCraft review](#solidcraft-review) compared this extension's interface against a full parametric modeller's, and added fourteen items to Ready product work and four probes. The Ready product work items are the parameters table (2.31), configurations (2.33, since shipped and removed), command search and keyboard-first commands (2.34, since shipped and removed), a ribbon command strip (2.35, since shipped and removed), a two-tone icon set (2.36), history timeline depth (2.37, since shipped and removed), [a unified Browser tree](#unified-browser-tree) (2.38), navigation upgrades (2.39, since shipped and removed), zebra stripes and a centre-of-mass marker (2.40, since shipped and removed), feature form ergonomics (2.41, since shipped and removed), named materials in the Parts panel (2.42, since shipped and removed), an issue draft from a failure (2.43, since shipped and removed) and a welcome walkthrough with samples (2.44, since shipped and removed). The probes are [curvature, minimum radius and isocurve overlays](#curvature-and-isocurve-overlays) (3.18), [sheet-metal flat patterns of an imported part](#sheet-metal-flat-pattern) (3.19), [frame members along wireframe edges](#frame-members-along-edges) (3.20) and [on-canvas parameter handles](#on-canvas-parameter-handles) (5.5). Section 2 resumes at 2.31: 2.29 and 2.30 belonged to items that have shipped and left the list, and 2.30 is still cited for stepping through entities under the cursor, so neither number is reused. A new area tag, *Interface*, covers items whose main product is the webview's interaction design. One new Rejected-scope entry was added: a photoreal render workspace. The constraint-sketcher rejection was re-read against SolidCraft and stands.

**Extended 2026-11-10 (coverage and cross-extension review, Non-goal recovery).** Extension, not a planning review: nothing was re-ranked and no existing ID moved. The [coverage and cross-extension review](#coverage-and-cross-extension-review) read this repository at 3.41.0 beside VSCode-MDPA-Preview 5.38.0 and KKSS 2.36.0 and added two upkeep items ([stylesheet consolidation](#stylesheet-consolidation) 1.8, [reduced motion and keyboard paths](#reduced-motion-and-keyboard-audit) 1.9), nine Ready product work items (2.45–2.53), eight geometry probes (3.21–3.28), six meshing probes (4.13–4.18), six platform probes (5.6–5.11) and one strategic item ([constrained 2D sketches](#constrained-sketches), 6.4). Four Non-goals were re-read at the maintainer's request and re-opened by a route that was not available or not considered when they were written: interactive sketching with constraints (6.4), the gmsh-wasm checklist (4.18, a new build of the package this project's maintainer also maintains), the kernel-blocked facts (3.28, through the OpenCASCADE that meshio++'s full artifact links) and a narrow slice of the render workspace (5.11). Each Non-goal entry now says so. The same change removed three in-page links whose targets had shipped and left the file, and corrected the unresolved count in 1.1.

Everything previously shipped is tracked in `CHANGELOG.md`, and `CLAUDE.md` holds the invariants, traps and verified kernel facts that a future change could break (not per-feature history, which lives in git) — this page is for what's **not** built yet, plus the Non-goals that record why a direction was rejected so it isn't re-proposed.

## How this file works

- **Sections are ordered, and the order is the recommendation.** Each section states an *admission criterion*; an item that doesn't meet it belongs in a different section or in Non-goals, not at the top because it sounds exciting. An empty section is removed from the file entirely rather than kept as a placeholder.
  - **1. Upkeep and defects:** no design question, only work. (Called "Tier 0" in older changelog and `CLAUDE.md` text.)
  - **2. Ready product work:** no kernel unknown remains, whether because a probe passed or because the work only reuses shipped machinery. The estimate is firm. (Called "Tier 1" in older text.)
  - **3–5. Probe-gated:** a hypothesis with a discriminating experiment, grouped by area — geometry, meshing and platform.
  - **6. Strategic:** multi-phase bets that gate other items or reopen Non-goals.
- **Each item carries an area tag** — *Geometry*, *Meshing*, *Formats*, *Drawings*, *Parity*, *Interface*, *Platform* or *Ecosystem* — so the file can be read by area as well as by tier.
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
| meshio++ 16.7.0 surface `remesh` (clustering), `estimateError` (ZZ), `interpolate` / `conservativeInterpolate`, `sampleDistance` | MIT | Yes; `estimateError` and `conservativeInterpolate` are now called by **Adapt to field** (`meshioService.ts`), the rest still unused | A licence-free surface remesher to measure MMG against; an error estimator to drive adaptation; mass-preserving field transfer across a remesh | Baseline in the coarsening probe; the field-transfer half of adaptive remeshing |
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

**meshio++ 18.0.0 surface, triaged (2026-11-02, the 18.0.0 bump).** The tarball diff against 17.23.0 is purely additive in the typings, the corpus and `npm test` were green on the bump alone, and the format count is unchanged (read 80 / write 75). The FULL artifact now links **MMG 5.8** (LGPL-3.0-or-later) and **Netgen** (LGPL-2.1), so `hasMmg()`/`hasNetgen()` are true; ELAS is excluded upstream (GPL-3.0), so `move` always throws. Probed (`scripts/probe/examples/meshio-1800*.ts`). **Adopted:** `thickness`, `findIntersections` and `selectRegion` as `measure_mesh_thickness` / `find_mesh_intersections` / `select_mesh_region` (one `analyzeSurfaceMesh` pipeline function; the 10 mm cube reads 10 mm thick, a cube against a copy shifted by (5,5,5) meets in 18 triangle pairs / 6 segments, the plane z ≥ 5 selects its 2 top triangles); `tetToPoly` and `polyToTet` as `transform_mesh` / Mesh Ops operations (a 12-tet cube dual is 480 polyhedra + 120 polygons; VTU holds them, **MDPA refuses polyhedron blocks by name**, so the dual is not a Kratos route). **Probed and not adopted:** `tetrahedralize` with Netgen — it does keep the boundary (`boundaryPreserved: true`, Hausdorff 0) but **ignores `maxSize`/`maxVolume`/`grading`** (cube and `block.stp` stay 12 tets with one interior point whatever the size; `optimizeSteps: 0` gives 25 tets at min dihedral 1.7°) and **aborts the WASM module on `bull.stp`** (`memory access out of bounds`), so it is neither sizeable nor safe — fTetWild and the octree engines stay; `meshDomain` — runs (a unit square meshes to 64 triangles) but needs a 2-D boundary-line mesh as input, which no workflow here produces; `metricFromHessian` needs a row-major 9-component Hessian per point that nothing here produces. **Adopted afterwards as Mesh Ops / `transform_mesh` operations:** `adapt` (a 12-tet block adapts to 113 / 742 / 5 542 tets at `hsiz` 2 / 1 / 0.5), `discretizeLevelset` (a sphere level set gives 12 093 tets) and `optimizeVolume` (tet-only input, so the boundary blocks are dropped and reported; the report gives min dihedral before/after; the new `objective` is `worst` or `energy`). They are file-to-file operations on the imported mesh and do not touch the Parts-aware `remesh_mesh` path.

**meshio++ 19.0.0 surface, triaged (2026-11-07, the 19.0.0 bump).** The typings diff against 18.3.0 is one default flip and two additions; the artifacts are the same files. **Default flip:** `meshCadSurface` `modelTolerances` and `virtualFaces` are now on by default; the shipped `mesh_cad_surface` / `meshcad` calls forward only defined keys, so they follow upstream (probe `scripts/probe/examples/meshio-1900.ts`: `block.stp` at size 1 is 252 triangles with the options default, off or on). **Adopted:** `checkTetrahedra` as `check_tetrahedra` (a stuffed `block.stp` tet mesh reads valid with positive volumes; swapping two nodes of one tet reads exactly 1 inverted), and the `octreeMesh` volume-fix counters as `octreeMesh.volumeFix`. **Not shipped:** the `octreeMesh` tuning options (`volumeFix`, `zeroVolumeFactor`, `capFlatness`, `crossingMargin`, `crossingGap`) — the upstream defaults are kept and no measured case wants them changed.

**meshio++ 18.1.0 surface, adopted whole (2026-11-04, the 18.1.0 bump).** The tarball diff against 18.0.0 is 13 new methods and nothing else. Probed (`scripts/probe/examples/meshio-1810-surface.ts`): the call shapes below are verified, not read from the typings. `prepareMetric` needs hmin/hmax set to produce a non-degenerate field and 6 components in upper-triangular order; with the metric zero everywhere it throws "the metric is zero everywhere". `geodesicDistance` on a 12-triangle cube under-reads the exact corner-to-corner 22.36 (20.2); on the 3-times-refined cube it reads 22.00. `reconstructSurface` of the refined-cube point cloud leaves ~140 lattice nodes undefined and its hull volume is 1223 against 1000 — an approximation to quote with its `numUndefined`, not a reconstruction of the cube. `untangle` of an already clean mesh reports 0 sweeps and 0 moves. **Adopted:** `untangle`, `prepareMetric`, `morph`, `convexHull`, `delaunay2d`, `convertCoordinates`, `estimateNormals`, `reconstructSurface`, `geodesicDistance`, `parameterize`, `laplacianEigenmodes` as `transform_mesh` / Mesh Ops operations; `adjacency` + `writeGraph` as `mesh_adjacency`; `registerRigid` as `register_meshes`; `geodesicDistance` / `parameterize` / `laplacianEigenmodes` also as the read-only `analyze_surface_geometry`. **Not shipped:** a per-point result in the tool replies (the arrays go to a file through `transform_mesh`), an editor for the `sizeField`-style handoff of `prepareMetric` output into MMG (the metric is point data the caller names), and `register_meshes` for meshio sources with companion files.

**meshio++ 17.22–17.23 surface, triaged (2026-10-29, the 17.23.0 bump).** The tarball diff against 17.21.0 adds options to `meshCadSurface` and `octreeMesh`, eight operations and ~20 mesh generators; the existing corpus (83/83), `npm test` and the typings were green on the bump alone. Adopted: **`meshCadSurface` `quads` (`dominant`/`all`), `quadPairs` and `untangle`** as `mesh_cad_surface` parameters (`block.stp` at size 1: 24 triangles + 114 quads dominant, 128 quads all, closed; quad9 at order 2; STL refused by name since it holds no quads), with `reparamConditionNumber` no longer restricted to order 1; **`octreeMesh` `hexGrading`** as `MeshOptions.octreeMeshHexGrading` (`block.stp` hex 856 uniform vs 601 graded; omitted from the sidecar when uniform); **`checkConformity`** as the `check_mesh_conformity` tool (facts: hanging nodes, T-junctions, partial overlaps, unwelded facets). Probed (`scripts/probe/examples/meshio-1723.ts`) and **not adopted**: `tetrahedralize` — `hasNetgen()` is false in the WASM build, so only the octree backend runs and it does not keep the surface triangles (`boundaryPreserved: false`, Hausdorff 0.71 on `bull.stp`, min dihedral 2.7°), duplicating `engine: "octreemesh"`; `extrude`/`revolve` — they sweep a 2-D profile mesh and refuse a closed B-rep skin (`face parallel to the direction` / `crosses the axis`), and no workflow here has a profile mesh; `mirror` — the Mirror edit op already covers B-rep and mesh sources, and the meshio++ result is a mesh-only reflection; `errorSize` — its input is `estimateError`'s indicator, whose adaptive route is already `adaptField`; `projectToCad` and the 3-D `boundaryLayer` were first left as follow-ups and were then **adopted the same day** (see below). the generators, as before; `hasMmg()` is false in this build.

**meshio++ 17.23 follow-up, adopted (2026-10-29): `projectToCad` and prism layers.** `project_to_cad` and `grow_prism_layers` MCP tools, the Advanced ▸ **Surface Tools** panel (`surfaceToolRequest` / `surfaceToolResult`), and `MeshOptions.prismLayers` as a post-pass of `engine: "meshcad"` (`doc/gmsh-integration.md#prism-layers`). Probe `scripts/probe/examples/meshio-prism-project.ts`: an unperturbed `mesh_cad_surface` skin projects with ~1e-16 movement (128 points, 44 on edges, 8 corners) and a 0.02-size perturbation snaps back (max move 0.0128); the layer result is one `wedge` block plus two triangle blocks (base and cap), all wedges positive in Gmsh's prism order, thickness exactly the geometric series. Not done: meshing the interior behind the layers (the shell is the product — a tet fill would need a conforming inner-cap tetrahedralizer; `tetrahedralize` has no Netgen here), Parts/physical groups on the shell, and a solver read-back of the `Element3D6N` shell (recorded as `prism-layers-kratos` in the verification-gap registry).

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

**The OCCT build is old.** The installed `opencascade.js` 1.1.1 references OCCT `V7_4_0`. Its 2.0 beta dates from 2023 and has seen no release since. The bundled gmsh-wasm 0.4.0 (the same Gmsh commit as 0.3.0) statically links OCC 7.8.1 (its `General.BuildInfo`). So one extension carries two OCCT versions three minor releases apart, and the kernel-blocked Non-goals below are blocked by the older one. The [self-built OCCT WASM](#self-built-occt-wasm) strategic item addresses this.

**OCCT: bound, never called, and worth a probe.**

| Classes | Would enable | Item |
| --- | --- | --- |
| `BRepExtrema_SelfIntersection`, `ShapeAnalysis_FreeBounds` | Self-intersection and free-boundary facts in the validity report | Free boundaries shipped in `check_brep_health`; `BRepExtrema_SelfIntersection` is dead (see Kernel-blocked), so self-intersection is re-opened as [Sampled B-rep self-intersection](#sampled-brep-self-intersection) (probe) |
| `BRepOffsetAPI_MakeFilling` | An N-sided, non-planar surface from boundary edges | N-sided surface filling (shipped as `addSurfaceFilling`) |
| `ChFi2d_FilletAPI`, `ChFi2d_ChamferAPI` | Rounding and chamfering sketch-profile corners before extrusion | Fillets and chamfers on 2D profiles (shipped) |
| `BRepProj_Projection` | Projecting a curve onto a face | Shipped as `splitFace.projectDir` |
| `STEPCAFControl_GDTProperty`, `XCAFDoc_DimTolTool`, `XCAFDoc_LayerTool`, `XCAFDoc_MaterialTool`, `XCAFPrs_DocumentExplorer` | Reading STEP AP242 PMI, layers and materials, plus a second route to colours that bypasses the dead `XCAFDoc_ColorTool` getter | [Read PMI, layers and materials from STEP](#read-pmi-layers-and-materials-from-step) |
| `VrmlAPI_Writer` | B-rep → VRML export, the one extra B-rep writer in the binding | [VRML export](#vrml-export) |

**Gmsh: declared, never called, and worth a probe.** The table below is for `model.occ` and `model.mesh`. `model.mesh.embed` was in this table and has been **removed** — it was probed and shipped, but deliberately not used: Gmsh meshes a free 0D/1D model entity in its own right, so the node lands exactly without it, while calling `embed` measurably degrades the surrounding mesh (2-D minSICN 0.840 → 0.751) and produces an ill-shaped tetrahedron outright when a point on a face is embedded in a volume. A sixth "green but the wrong tool" finding alongside OCCT's; the numbers and the shipped alternative (create the entities in Gmsh's model via `model.occ.addPoint` / `addLine`) are in `CLAUDE.md` and `doc/gmsh-integration.md`. Two more parts of the binding are unused:

- **`plugin.run` and `onelab`:** unused. gmsh-wasm 0.4.0 added the `view.*` namespace (`addModelData`, `getModelData`, `probe`, `write`, …), so a plugin's output no longer needs a written `.pos` file. `view.add`/`view.addListData` are now called by `MeshOptions.sizeField` (`gmshSizingFields.ts`); `plugin.run` and `onelab` remain unused.
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
| Per-solid signed-volume check | text-to-cad | Shipped: `check_brep_health` reports the signed volume per solid |
| 3MF export with colour | Both | Shipped: Part and file colours are written per triangle as `basematerials`, and a 3MF's own colours (and declared unit) show on load |
| STEP from a mesh with merged coplanar faces | ReOpenSCAD | Shipped as `promote_mesh_to_brep` `mergeFacets` and the Mesh Health panel's **Merge facets** checkbox: one planar face per near-coplanar facet, kept only where genuinely flat |
| Kinematic mates, poses, animation | text-to-cad | [Kinematic mates and pose-swept clearance](#kinematic-mates-and-pose-sweeps) (strategic) |
| step.parts sourcing with checksum | text-to-cad | Already shipped (`search_standard_parts` / `download_standard_part`) |
| DXF output, sheet templates, three-view sheets | text-to-cad | Already shipped (`export_drawing_sheet`, DXF layers) |
| Slicing, printer hand-off, supplier ordering, URDF/SDF | text-to-cad | [Rejected](#rejected-scope) |
| Hosted shared workspaces, HTTP transport, in-browser editor | ReOpenSCAD | [Rejected](#rejected-scope) |

### ElmerStudio review — 2026-10-31 {#elmerstudio-review}

One project, read at source level (no Elmer run):

- **[ElmerStudio](https://github.com/loumalouomega/ElmerStudio)** (GPL-2.0-or-later, read at `b1be253`, 2026-10-30). A COMSOL-style Qt model builder for Elmer FEM: geometry through gmsh's OpenCASCADE, a Model Builder tree, unit-aware parameters, physics-controlled meshing, parametric sweeps and a results pipeline. Its geometry and meshing halves are the comparable ones; only ideas transfer, no code. The workflow and results halves are in the KKSS and VSCode-MDPA-Preview roadmaps.

| Source feature | From | Status here |
| --- | --- | --- |
| Unit-aware expressions `10[mm]`, `20[degC]` with deduced-unit warnings that never reject the value (`core/units.py`: `expr_dims`, `unit_warnings`) | ElmerStudio | Shipped: bracketed units plus advisory dimension warnings (`dimensionIssues`) |
| Parameters evaluated to a fixed point with named circular chains (`evaluate_parameters`, `_cycle_from`) | ElmerStudio | Already shipped in a stricter form: `editVariables.ts` allows references only to variables defined above, so a cycle is unrepresentable |
| Selections that follow geometry edits: signature = owner-relative box centre/extent + measure, matched under a score limit, lost entities flagged (`core/geometry.py`: `signature`, `match`, `remap_selections`) | ElmerStudio | Already shipped for id bags (`entityRebind.ts`, `rebindPartsAcrossOps`); the rule-defined half is Shipped: Parts ▸ Rule from the selection |
| Box Selections re-evaluated on every build and recorded per run (`_box_entities`, `meta["selections"]`) | ElmerStudio | Shipped: Parts ▸ Rule from the selection |
| Selecting boundaries by position in scripts (`geo.select("boundary", xmax=0)`) | ElmerStudio | Shipped: scene-selector Part rules in `set_part` |
| Parametric Curve + Convert to Solid | ElmerStudio | Shipped: `addParametricCurve` with `close: true` builds the face that `extrude`/`revolve` take, and Edits ▸ f(s) Curve is its form |
| Work planes (quick and face-parallel), 2D fillet/chamfer on clicked vertices, Form Union, Move/Copy/Rotate/Scale/Mirror/Array | ElmerStudio | Already shipped (construction planes, `filletProfile`, conformal meshing, the transform ops and `repeat`) |
| Physics-controlled mesh: nine size levels as fractions of the model, flow halving, acoustics at c/(5·f_max) (`core/meshing.py`: `SIZE_PRESETS`, `acoustic_hmax`) | ElmerStudio | [Physics-calibrated size presets](#physics-calibrated-size-presets) (4.12) |
| Maximum element growth rate as `Distance`+`MathEval` fields, h(d) = h + (g−1)·d (`grow_from`) | ElmerStudio | Partly shipped: the `meshcad` engine has `meshcadGrading`, and `Part.meshGrading` is a distance band (wall size → far size). The Gmsh engine has no growth-rate limit; it is a phase of [Physics-calibrated size presets](#physics-calibrated-size-presets) (4.12) |
| Mapped meshes with graded distributions (geometric, symmetric, reversed); ElmerGrid structured blocks with a refusal reason per non-axis-aligned edge | ElmerStudio | Mapped meshes shipped (`Part.meshStructured { divisions }`, with its loud refusal on non-regular regions); graded (non-uniform) divisions are a phase of [Physics-calibrated size presets](#physics-calibrated-size-presets) (4.12) |
| Boundary layers in 2D only (its own documented limit) | ElmerStudio | 2D shipped (`Part.meshBoundaryLayer`); 3D is [A volume behind the prism-layer shell](#volume-behind-prism-layers) (4.11) |
| Mesh statistics and a quality plot per domain (gmsh `minSICN`) | ElmerStudio | Already shipped (`QualitySummary`, Mesh Health, `check_mesh_quality`) |
| Identity pairs (mortar continuity) between touching domains | ElmerStudio | Covered differently: conformal multi-body meshing shares the interface nodes, and hanging-node MPCs ship for the octree engine |
| Model tree "Used By" links and delete-in-use warnings (`core/deps.py`) | ElmerStudio | [Part rename and delete events for embedders](#part-rename-and-delete-events) (5.4); the cross-mode report itself is KKSS's |
| Stepping through every face the view ray crosses (Up/Down, "k of n under the cursor"), hover coloured by add vs remove (`ui/graphics.py: candidates_at`, `cycle_candidate`) — second pass | ElmerStudio | Shipped: stepping and the add-vs-remove hover tint |
| Per-feature rebuild caching, face-parallel work planes, select-by-position — second pass | ElmerStudio | Already shipped here in stronger forms (the worker's base-shape/op-replay cache, Clip ▸ Face saved as a construction plane, Select-by-shape filters); ElmerStudio itself rebuilds from scratch on every build |
| `Prop.legacy`: a saved node that lacks a key gets the value that applied before the key existed, so a changed default never changes a saved model's results (`core/model.py`, commit `2b33ff6`) — third pass | ElmerStudio | Sidecar fields that arrived after the file was written (since shipped as `LEGACY_MESH_DEFAULTS`) |
| Remeshing a deformed domain while keeping every boundary's number, and moving chains re-spaced to the first mesh's grading (`core/remesh.py`) — third pass | ElmerStudio | Already shipped in the form that matters here: `remesh_mesh` keeps named regions and Parts; grading-preserving re-spacing has no consumer without a moving-boundary solver |
| Verifying a backend by solving the same model through two of them (`tests/test_nastran.py: test_same_model_as_elmer`) — third pass | ElmerStudio | Covered by `mcp:smoke`'s exact per-engine pins on `block.stp` (enclosed volume for the octree and octreemesh engines, triangle count and area for meshcad); no item |
| Sketching with geometric constraints | (not offered by ElmerStudio either — it uses numeric primitives) | [Rejected](#rejected-scope), unchanged |

### SolidCraft review — 2026-11-01 {#solidcraft-review}

One project, read from its documentation and a screenshot. Nothing was built or run.

- **[SolidCraft](https://github.com/tangency-labs/solidcraft)** (MIT OR Apache-2.0, read on 2026-11-01 from `README.md`, `ROADMAP.md`, `docs/features.md`, `docs/capabilities.md` and `ATTRIBUTION.md`, plus a v0.29.0 screenshot of its Parameters dialog over a sample plate). It is a parametric CAD application written in Rust, with an egui interface, sketch-constraint-timeline modelling, assemblies, sheet metal, plastics, weldments and a render workspace, and an MCP server and CLI that run the same commands as the desktop app.
- **What transfers is the interface, not the modelling scope.** Its window is a workspace-tab ribbon with labelled command groups (Sketch · Create · Modify · Arrange · Configure · Construct), a Browser tree (Document Settings, Named Views, Origin, Bodies, Sketches, Features, each row with a visibility eye), a clickable axis triad, a bottom navigation bar, a command search with shortcuts, and docked feature dialogs. Its Parameters dialog is the most directly useful piece. User parameters sit in a table of Name / Unit / Expression / Value / Comment with a favourite star, up/down reorder and delete; there is a Filter box, Import… / Export CSV… / Export JSON…, and an "apply each change as you leave its field" toggle. A **Model parameters** section lists every feature's dimensions by feature (`BASE ▸ d1 = width`).
- **Icons are a style reference only.** Its icons are original SolidCraft artwork under MIT OR Apache-2.0 (per `ATTRIBUTION.md`: a single-colour application set and a two-tone modelling set on a 64 grid), which would be GPL-3.0-compatible. The two-tone icon set (shipped) nevertheless redraws in this repository's own TikZ pipeline rather than vendoring them, so the icon build keeps one source format and needs no new attribution rows.
- **Scope rules unchanged.** The constraint sketcher, the render workspace and robot-description export stay out (see the last rows). Sheet metal, weldments and on-canvas handles were re-read against this tool's preparation workflow, and each is opened as a probe whose framing keeps it on the inspect/prepare side.

| Source feature | From | Status here |
| --- | --- | --- |
| Parameters dialog: Unit and Comment columns, favourite, reorder, filter, CSV/JSON import and export, apply-on-leave toggle | SolidCraft | Shipped (Parameters table) |
| Model parameters: every feature's dimensions listed by feature, each one able to reference a user parameter (`d1 = width`) | SolidCraft | Shipped (Parameters table, Model parameters) |
| `parameters.list_users`, the parameter graph, and expression autocomplete (arrow keys, Enter/Tab, Escape) | SolidCraft | Shipped (Variable "Used by" and autocomplete) |
| Configurations and the Config Table (rows of parameter values, ordered rules, per-row suppression) | SolidCraft | Shipped (2.33, since removed from the list) |
| Search commands (shortcut shown), single-letter command keys, Shift+R to repeat the last command | SolidCraft | Shipped (Command search) |
| Workspace-tab ribbon with labelled groups, toolbar overflow, a "hide ribbon labels" preference | SolidCraft | Shipped (Ribbon command strip) |
| Two-tone modelling icons on a 64 grid | SolidCraft | Shipped as a TikZ redraw (two-tone op icons; see `icons/README.md`) |
| Timeline: suppress, rename, feature folders, drag reorder with dependency checks, delete that lists dependents, hover highlights of modified faces | SolidCraft | Shipped (History timeline depth, 2.37, removed): suppress, rename, folders, drag reorder, delete with dependents, hover highlight. Already shipped before it: the jump rollback (click a history row), per-row delete, and click-to-highlight of produced faces |
| Browser tree (Document Settings, Named Views, Origin, Bodies, Sketches, Features; eye per row; Expand/Collapse All) | SolidCraft | [Unified Browser tree](#unified-browser-tree) (2.38). Already shipped in pieces: the Components tree, the Parts and Layers panels, and view bookmarks |
| Clickable X/Y/Z axis tips, 26 snapped standard and diagonal views, Normal to Selection, navigation presets (Touchpad, Fusion, OpenSCAD) | SolidCraft | Navigation upgrades (2.39, shipped and removed; an OpenSCAD preset is declined because its mapping equals Default) |
| Zebra analysis; centre of mass shown in the view | SolidCraft | Shipped (Zebra display mode and the centre-of-mass marker, 2.40, removed) |
| Curvature map and comb, isocurves, minimum radius, continuity | SolidCraft | [Curvature, minimum radius and isocurve overlays](#curvature-and-isocurve-overlays) (3.18, probe); continuity is out of that probe's scope |
| Feature dialogs docked on the right; collapsible header that keeps its values; OK/Cancel outside the scroll area | SolidCraft | Shipped (Feature form ergonomics, 2.41, removed): sticky Apply footer, collapsible header, optional docked placement. Already shipped before it: the live preview (an intent-coloured overlay, debounced) |
| Named appearances and material assignment | SolidCraft | Shipped (Named materials in the Parts panel, 2.42, removed); textures and PBR looks are not proposed |
| "Report a bug" in the header; Create Issue from a feature error as an editable draft; crash reports that are never sent automatically | SolidCraft | Issue draft from a failure (2.43, shipped and removed) |
| Start view with sample cards and recent items | SolidCraft | Welcome walkthrough and samples (2.44, shipped and removed). VS Code supplies recent files |
| Sheet metal: unfold, flat pattern, DXF and bend-table export | SolidCraft | [Sheet-metal flat pattern](#sheet-metal-flat-pattern) (3.19, probe), framed as unfolding an *imported* part; authoring flanges, hems and reliefs is not proposed |
| Weldments: frame members along a skeleton, from a profile library | SolidCraft | [Frame members along wireframe edges](#frame-members-along-edges) (3.20, probe) |
| On-canvas drag handles with value boxes (extrude distance, fillet radius, shell thickness, hole depth) | SolidCraft | [On-canvas parameter handles](#on-canvas-parameter-handles) (5.5, probe). Already shipped: the transform gizmo, which sets the precedent |
| Joints, motion studies, contact sets | SolidCraft | [Kinematic mates and pose-swept clearance](#kinematic-mates-and-pose-sweeps) (6.3), which now cites SolidCraft as evidence too |
| Plastic-part features (boss, lip, snap fit) | SolidCraft | Not an item. These are parametric shapes, so they belong to the starter macro library or a sourced OpenSCAD library ([OpenSCAD library staging](#openscad-library-staging), 3.17), not to kernel ops |
| Named Views, standard views (Ctrl+1–7), Fit, Home, view cube | SolidCraft | Already shipped: view bookmarks (View ▾ Save current view…), the orientation cube, keys `1`–`6` and `i`, and the view-controls dock |
| Interference, section, draft analysis, mass properties | SolidCraft | Already shipped: Clash (with clearance), Cut Plane with a solid cap, the Draft panel, Mass Properties |
| Selection filter, right-click menu, status and selection feedback | SolidCraft | Already shipped: Select ▾ filters, the context menu, the status bar and selection pill |
| Autosave, crash recovery, atomic saves | SolidCraft | Already shipped in this tool's shape: sidecar autosave, hot-exit backup, the save journal and temp-file-plus-rename source writes |
| Ctrl/Cmd +/− and 0 change the UI scale | SolidCraft | Not an item: VS Code's own zoom already scales the webview |
| Settings profiles; a Design Properties metadata dialog | SolidCraft | Not an item: VS Code settings profiles cover the first; the drawing-sheet title block and the handoff manifest already carry the metadata that has a consumer |
| Sketch with geometric constraints | SolidCraft | [Rejected](#rejected-scope), unchanged after re-reading: expression-driven profile forms remain the design |
| Render workspace (lights, environments, PBR materials, image export) | SolidCraft | [Rejected](#rejected-scope): photoreal rendering |
| URDF export, send to slicer | SolidCraft | [Rejected](#rejected-scope), unchanged |

### Coverage and cross-extension review — 2026-11-10 {#coverage-and-cross-extension-review}

Read this repository at 3.41.0 (`9afec8b`) together with VSCode-MDPA-Preview 5.38.0 and KKSS 2.36.0, asking what a geometry-preparation tool for simulation normally offers that is absent here, which shipped features stop at a limit recorded in a code comment or guide, and where the two extensions and the app present the same thing differently. A source and documentation review; no kernel probe was run for it, which is why most additions are probe-gated.

| Evidence | Opportunity and owner |
| --- | --- |
| `Part` (`src/protocol.ts`) carries a name, colour, entity ids, mesh controls and a density; `mdpaWriter.ts` writes one `Properties 0` because "this codebase has no material/property data"; the handoff manifest (`handoffManifest.ts`) carries Parts, units and hashes | CAD: [simulation intent on Parts](#simulation-intent-on-parts) (2.46). Mesh: its *problemtype forms pre-filled from the handoff manifest*. KKSS: the study store carries it. |
| `gmshSizingFields.ts` uses the Constant, Distance, Threshold, BoundaryLayer, PostView and Min fields only | CAD: [refinement regions](#refinement-regions) (2.45), [size field from a previous solution](#size-field-from-solution) (4.15). |
| No mid-surface, no automatic small-feature finder (the `defeature` op takes listed faces), no fluid-volume extraction, no contact-pair finder, no section properties, no symmetry cut | CAD: 3.21–3.26. Mesh consumes the pairs in its *structural contact authoring*. |
| Comments in `occtOperations.ts` and `editOps.ts` name five queued follow-ups (planar-only up-to-face, loft guides across three or more sections, straight-only `filletProfile`, single-edge `splitFace`, `drill` without up-to-face) | CAD: [queued kernel follow-ups](#queued-kernel-follow-ups) (3.27). |
| The Edits panel has Undo and Redo buttons (`editsPanel.ts` `onUndo`) and no keyboard binding; an embedder cannot list commands, route Undo, see the selection or know the focused panel | CAD: 2.47–2.49. Mesh: the same contracts. KKSS: its Edit menu, command palette and help key. |
| One cut plane (`ClipPlaneState` in `webview/clipping.ts`); construction planes but no named coordinate system; the Jacobian check covers ten-node tetrahedra only (`gmshService.ts`) | CAD: 2.50–2.52. |
| `media/viewer.css` has duplicated redesign sections (status bar, `.panel-chevron`, `.panel-icon`), per-panel field classes, three hard-coded tints and no `prefers-reduced-motion` rule; `scripts/ui-drift-check.mjs` informs and never fails | CAD: 1.8, 1.9, [one shared design layer](#shared-design-layer) (5.6). |
| No `webglcontextlost` handler, no instancing or level of detail (`doc/getting-started.md`: large assemblies are slow, no streaming), no committed visual baselines, no touch handling | CAD: 5.7–5.10. |
| Four Non-goals state a revival condition that now holds or can be tested | CAD: 3.28, 4.18, 5.11, 6.4. |

**Limits found during review:** the geometry probes name OCCT classes whose binding state in `opencascade.js` 1.1.1 was not re-checked here; each probe's first step is that check, and green in the manifest is still not sufficient. Solver-side meaning (which condition a role maps to, which element a section property feeds) stays with VSCode-MDPA-Preview: nothing here authors a boundary condition, a load or a solver setting.

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
| Meshing probes | Decide on remeshing and on conformal assemblies | MMG core probe is closed with a partial outcome: volume/surface/transport work, unconditional optimisation failed. MMG remeshing has shipped: shared service, MCP tool and panel with real-pipeline screenshots and packaged-runtime verification. Conformal multi-body meshing and Gmsh mesh optimisation have shipped, each with probe-measured results and a decision. Manifold mesh booleans have shipped, and so have periodic face pairs; pre-mesh healing and the hex-dominant MDPA split were probed and rejected (see Non-goals), and the size callback works but nothing ships on it. Structured meshing per Part has shipped as `Part.meshStructured` with exact-count smoke coverage. Metric-driven adaptive remeshing has shipped as **Adapt to field** on remesh (scalar metric; the tensor metric was probed and not worth shipping). Hausdorff-bounded surface coarsening has shipped as the `autoDecimate` backend (mmgs; the earlier negative result was a mis-scaled `hausd`). Anisotropic 2-D boundary layers have shipped as `Part.meshBoundaryLayer` (the recorded blocker did not reproduce). Achieved rows are now measured from the generated nodes (`boundaryLayerMeasurement.ts`; generate result, panel Layer row and handoff manifest, with a shortfall warning), closing 2.22. View-driven mesh sizing has shipped as `MeshOptions.sizeField` (list-based `SP` view + `PostView` field, `bull.stp` worst deviation 3.3× down at 11.7× elements, Parts and physical groups survive, no view left behind). The octree hex-dominant engine shipped as `engine: "octree"` (3522 cells enclosing exactly 60 on `block.stp`, MDPA with all three cell classes). KaHIP-partitioned Kratos MDPA export has shipped as `MeshOptions.mdpaRanks` (`doc/gmsh-integration.md#partitioned-mdpa`: one file per rank, global ids, an interface-node SubModelPart; `bull.stp` at 4 ranks cuts 108 interface nodes against the space-filling curve's 297). Nothing was left in this wave until 2026-10-31, which re-opened it with [a volume behind the prism-layer shell](#volume-behind-prism-layers) (4.11) and [physics-calibrated size presets](#physics-calibrated-size-presets) (4.12) | Each probe filed with measured results and a decision |
| Geometry probes | Decide which never-called OCCT capabilities become ops | B-rep repair probed and **failed** (no `ShapeFix_*` fixer clears a real finding; see Kernel-blocked) and left the list; the face-region split passed its probe, shipped as the `splitFace` op, and left the list; variable-radius fillets passed theirs and shipped as `FilletOp.radius2` (see `CLAUDE.md`'s Fillet/chamfer call shapes). Next (2026-10-31): the four route-around probes 3.14–3.17, each re-opening a Non-goal | Each probe filed with measured results and a decision |
| Agent ergonomics | An agent can tell a retryable failure from a model error, and two writers cannot silently clobber each other | Done: OpenSCAD diagnostics (document-derived OpenSCAD text now reaches an agent only inside untrusted-text markers), coded MCP errors (a failure carries a code and `retryable`; an undeclared parameter is warned about) and the MCP revision guard (a stale `expectedRevision` is refused with `stale-revision`). Mark agent-made edits has shipped too. Next: the Upkeep items (1.1, 1.2; sidecar later-added fields, formerly 1.7, shipped) and the remaining Ready product work | An agent's change is visible and refusable |
| Interface depth | The webview reads like a CAD application: parameters, commands and history are discoverable without opening the right panel first | From the [SolidCraft review](#solidcraft-review): the parameters table, variable "Used by" lists with autocomplete, command search and the ribbon and two-tone op icons (all shipped, so this theme has no open items left); the screenshots were regenerated for each | Each item's `test:webview` case is bug-injected and the screenshots are regenerated and inspected |
| Simulation hand-off | A decision made on the geometry reaches the case without being made twice | From the [coverage and cross-extension review](#coverage-and-cross-extension-review): simulation intent on Parts (2.46), refinement regions (2.45), named coordinate systems (2.50), then the probes that prepare an idealised model (3.21 mid-surface, 3.23 flow volume, 3.24 interface pairs) | A three-Part model exports to a case that preflights clean in VSCode-MDPA-Preview after one accepted suggestion |
| One product, three surfaces | The two extensions and KKSS share tokens, commands, Undo and help | Stylesheet consolidation (1.8), the embedder contracts (2.47, 2.48), then the shared design layer (5.6) | A token change lands in all three with one pull request each, and KKSS lists and runs this viewer's commands |
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
- **Still open (54 unresolved entries; the count was re-read 2026-11-10 from `scripts/verification-gaps/baseline.json`, which says `{"open": 54}`, so the "47" in the paragraphs above is the figure at the end of the second increment, before later features added entries):**
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

#### 1.8 Stylesheet consolidation and a gating drift check {#stylesheet-consolidation}

*Area: Interface, Platform. Effort: M.*

- **Evidence:** `media/viewer.css` (about 5,900 lines) carries the 3.0.0 redesign as overrides appended after the original rules, so the status bar, `.panel-chevron` and `.panel-icon` are each styled in two places and the later one wins by position; form fields are styled per panel (`.meshing-field`, `.surface-field`, `.tb-field`, `.compose-field`) where VSCode-MDPA-Preview and KKSS have one field recipe; three tints are literal colours (`.edits-form-tint-add`, `-cut`, `-ref`); section comments still cite retired tier names. `npm run ui:drift` compares the token set with the sibling extension's and only prints.
- **First useful increment (S):** merge each duplicated section into one rule set with no visual change, proven by the existing `test:webview` framing checks plus a before-and-after screenshot diff of the pipeline's captures; replace the three tints with theme variables.
- **Next increment (M):** one `.ui-field` recipe replacing the per-panel field classes; a style test like the sibling's `styleTokens.test.ts` (no literal font size or radius, no transition, colour only from theme variables); `ui:drift` fails CI on a token that differs without an entry in an allow-list that states why.
- **Done when:** no selector is defined twice for the same purpose, the style test and the drift check run in `npm test`, and the screenshots are regenerated and inspected. Feeds [one shared design layer](#shared-design-layer), which replaces the copies with a single source.

#### 1.9 Reduced motion and keyboard paths {#reduced-motion-and-keyboard-audit}

*Area: Interface. Effort: S.*

- **Evidence:** the stylesheet has seven high-contrast blocks and no `prefers-reduced-motion` rule; `viewerDom.ts` has accessible names throughout, but no test walks a whole task by keyboard, and the docked form, the ribbon overflow and the Browser tree arrived after the last pass.
- **First useful increment (S):** a reduced-motion block covering every animation and the camera transitions (a snap to a view becomes instantaneous); a `test:webview` case that completes open, select a face, apply a fillet, undo and export using the keyboard only, with focus visible at each step.
- **Done when:** that case passes in the dark, light and both high-contrast themes, every interactive element has an accessible name (asserted, not sampled), and the guide lists the keyboard path. KKSS runs its own axe pass over the embedded page; this item is the extension-side half.

### 2. Ready product work {#tier-1-—-ready-product-work}

*Admission: no kernel unknown remains. Either a probe passed and its call shapes are in `CLAUDE.md`, or the work only reuses shipped machinery. The estimate is firm.*

#### 2.3 Canonical worked example for the simulation tutorial {#canonical-worked-example-for-the-simulation-tutorial}

*Area: Ecosystem. Effort: S.*

- **Done so far:** [A cantilever beam](/tutorials/cantilever) — a 100 × 10 × 10 box, `FixedEnd` and `LoadFace` Parts, an optional steel density, and an MDPA export with a handoff manifest. `mcp:smoke` pins it on the live kernel: the beam's volume is exactly 10 000 mm³, and every node of each `SubModelPart` sits exactly on its end plane (x = −50 / +50).
- **What is left (S):** the cross-repository check — open the exported `.mdpa` in VSCode-MDPA-Preview and confirm both SubModelParts populate. It needs that extension and is not exercised from this repository.
- **Done when:** that check passes, and KKSS's tutorial links to the page.

#### 2.38 Browser tree follow-ups {#unified-browser-tree}

*Area: Interface. Effort: S.*

- **Shipped:** the Browser section (Document, Named Views, Origin, Bodies, Sketches, Features, Parts, Layers; per-row and per-group eyes; Expand/Collapse All; filter) as a view over the existing models, with its `test:webview` cases (hide a body from the Browser and the Components tree reflects it; restore a named view from the Browser and from View ▾ and reach the same camera).
- **What is left (S):**
  - **Document tessellation row:** tessellation quality is a host setting that never reaches the webview; it needs one new field on `viewerDefaults` or `documentInfo`.
  - **Origin visibility:** the viewer has one grid-and-axes flag, so the world axes and planes cannot be hidden individually; a construction plane has no eye.
  - **Sketch rows:** only the synthetic `Sketches` group is shown, as one row; the produced face and wire ids are not mapped to the op that made them, and guide geometry is not dimmed in the tree.
- **Done when:** each of those rows exists and is pinned by a `test:webview` case.

#### 2.45 Refinement regions: box, sphere and cylinder size fields {#refinement-regions}

*Area: Meshing. Effort: M.*

- **Workflow:** refine the mesh in a wake, around a notch or along a weld line that is not a face of the model. Today local size is tied to a Part (`meshSize`, `meshGrading`) or to sampled points (`sizeField`), so refining a region of space means inventing geometry for it.
- **Evidence:** `gmshSizingFields.ts` composes Constant, Distance, Threshold, BoundaryLayer and PostView fields under one Min field; Gmsh's Box, Ball and Cylinder fields take the same inside and outside sizes plus a transition thickness and need no geometry. Nothing about the pipeline changes: one more field kind joins the Min.
- **First useful increment (M):** a `refinementRegions` list in the mesh options sidecar (kind, placement in model units, size inside, transition thickness, optional name), validated like the other options; one Gmsh field per region; translucent gizmos in the viewport placed with the transform gizmo's own drag handles; the size estimate (`estimate_mesh_budget`) counts them; the engines that cannot honour a region (octree, fTetWild, meshcad) say so in the panel and in the tool reply instead of ignoring it.
- **Parity:** `set_mesh_options` and `generate_mesh` take the list; the handoff manifest records it with the other options; presets may carry regions.
- **Done when:** on `block.stp` a sphere region of half the global size yields a measured mean edge length inside it within 20 % of the request and unchanged outside the transition; a region wholly outside the model is reported and has no effect; a sidecar written before this item reads unchanged.

#### 2.46 Simulation intent on Parts {#simulation-intent-on-parts}

*Area: Ecosystem, Parity. Effort: M. Cross-repository: the consuming half is VSCode-MDPA-Preview's "problemtype forms pre-filled from the handoff manifest"; KKSS's study store carries the fields and marks a study stale when they change.*

- **Workflow:** a user names a Part `Inlet`, picks steel for another, and then has to say both again in the case builder, because only the name crosses. The decision was made where the geometry is; it should travel with it.
- **Evidence:** `Part` has `density` (used for mass and the bill of materials) and no other physical meaning; the named-materials picker fills that one number from an eleven-entry list (`materialDensity.ts`); `mdpaWriter.ts` writes every element with property id 0 under a single `Properties 0` block; the handoff manifest lists Parts with their groups and nothing about what they are for.
- **Scope, and what stays out:** this repository records *intent* as data and never interprets it. Three optional fields on a Part: `material` (a name, plus the property values that were shown when it was picked, so the receiving side can detect a mismatch), `role` (one of a short closed list: inlet, outlet, wall, symmetry, fixed, loaded, interface, contact-primary, contact-secondary, far-field, free), and `axes` (the name of a [local coordinate system](#named-local-coordinate-systems)). No boundary value, no load magnitude, no solver setting: those belong to the case builder.
- **First useful increment (S):** the three fields in the Parts sidecar and panel (a Role dropdown beside the material picker), `set_part` and `get_state`, and the handoff manifest under its v1 tolerance rule (unknown fields ignored by older readers).
- **Second increment (M):** the material list grows from densities to the property set the sibling's catalogue carries (elastic constants, conductivity, specific heat, expansion, viscosity), read from one shared data file so the two extensions cannot disagree, and the MDPA writer emits one `Properties` block per distinct material with the elements of each Part assigned to it, keeping `Properties 0` for Parts without one.
- **Done when:** a three-Part export (two materials, one role each) produces a manifest with those fields and an MDPA with two property ids; the sibling extension offers the matching assignments from it (its acceptance, checked there); a sidecar without the fields exports byte-identically to today.

#### 2.47 Undo and redo from the keyboard and from an embedder {#undo-redo-keyboard-and-embedder}

*Area: Interface, Platform. Effort: S.*

- **Evidence:** undo and redo exist as Edits-panel buttons (`editsPanel.ts`, `onUndo`) and as model operations; no key is bound, so Ctrl+Z in the viewport does nothing, and an embedding app has no message to send. KKSS's menu has no Undo for a CAD tab for this reason.
- **First useful increment (S):** Ctrl+Z and Ctrl+Shift+Z / Ctrl+Y in the viewport and panels (never inside a text field, which keeps its own undo), a host-to-webview `undo` / `redo` message pair, and a `historyState` event carrying whether each is possible and the label of the op it would affect. In VS Code the custom editor's own undo stack and this one must not both fire: decide which owns the keys there (the provider raises content-change, not edit, events today) and record the decision in `doc/protocol.md`.
- **Parity:** headless callers already have `remove_edit_op` and `set_edit_op_state`; no new tool.
- **Done when:** a `test:webview` case applies two ops, presses Ctrl+Z twice and Ctrl+Y once and reads the expected history; a test host drives the same through the messages; undo still cannot cross the save point and the refusal names it.

#### 2.48 Command catalogue, selection and focused-panel events for embedders {#embedder-command-and-selection-contracts}

*Area: Platform, Ecosystem. Effort: M. Cross-repository: VSCode-MDPA-Preview adds the same three contracts; KKSS consumes both for one command palette, assistant context and its help key.*

- **Evidence:** `commandSearch.ts` already holds every searchable command (`SearchItem`: ops, actions, panels) for Ctrl+K, but only the webview can read it; selection never leaves the webview except inside a request; KKSS records that its help key cannot tell which panel is in use.
- **First useful increment (M):** three additive, documented messages. `commandCatalogue` (on request): id, title, category, shortcut and current availability with a reason for each command, plus `runCommand {id}`. `selectionChanged` (debounced): entity kinds and counts, the Parts they belong to and a bounded id sample. `panelFocused`: a stable panel id from a list published in `doc/webview-api.md`. A fourth pair follows the same pattern for an embedder that shows this viewer beside another one: `cameraChanged` (position, target, up and projection in model units, debounced) and `setCamera`, the messages linked cameras already exchange between documents, made available to the host.
- **Parity:** none of this is a model capability, so no MCP tool; the catalogue ids are the names the MCP documentation uses where a command and a tool do the same thing.
- **Done when:** a test host lists every command Ctrl+K finds and runs one by id; selecting three faces of one Part emits one event naming that Part; opening the FE Mesh panel emits its id; an embedder that sends and listens for nothing sees today's behaviour.

#### 2.49 Keyboard shortcut map and cheat sheet {#keyboard-shortcut-map}

*Area: Interface. Effort: S.*

- **Evidence:** shortcuts are fixed: six contributed keybindings, the view snaps, and the single-letter commands behind `cadPreview.singleKeyCommands` (`singleKeyTable()` in `commandSearch.ts`). There is no in-product list, and the letters cannot be changed, which matters on non-US layouts and when an embedder already uses a key.
- **First useful increment (S):** a **Keyboard shortcuts** sheet (opened by `?` and from the command search) generated from `singleKeyTable()` and the action table, so it cannot drift; an optional `cadPreview.keymap` setting mapping command ids to keys, validated (unknown id, duplicate key) with the problem shown in the sheet.
- **Done when:** the sheet lists every bound command, a remapped key works and the old one does not, and a conflict is reported rather than silently resolved. The sibling extension's view snaps (`1`–`6`, `i`) are adopted here in the same change if both maintainers agree the letters, since its design document already names them as a candidate.

#### 2.50 Named local coordinate systems {#named-local-coordinate-systems}

*Area: Geometry, Ecosystem. Effort: S–M.*

- **Workflow:** a load along a bracket's own axis, a cylindrical boundary condition about a shaft, material axes of an orthotropic layup, results read in a rotated frame. All need an origin and three axes with a name, and the model has only construction planes.
- **Evidence:** `planeFrame.ts` already derives an origin and an orthonormal frame from a plane; `planesSidecar.ts` persists named planes; nothing exports them.
- **First useful increment (S):** a coordinate system is a named plane plus a type (Cartesian, cylindrical, spherical) and a choice of which plane axis is the system's first axis; created from a plane, from three picked points, or from a cylindrical face's axis; drawn as a triad; listed in the Browser tree.
- **Parity:** `set_plane` gains the type; `get_state` lists systems; measurements can report in a named system; the handoff manifest carries each system's origin and axes in export units, and a Part's `axes` field ([simulation intent](#simulation-intent-on-parts)) refers to one by name.
- **Done when:** a system built on a cylinder's axis reports a point's radius and angle correctly in `measure`; the manifest of an export scaled to metres carries the origin in metres; the sibling extension reads the axes for a cylindrical result transform (its acceptance).

#### 2.51 Several section planes and a section box {#section-planes-and-box}

*Area: Interface. Effort: M.*

- **Evidence:** `ClipPlaneState` (`webview/clipping.ts`) holds one plane with a stencil cap. Looking inside a corner of an assembly needs two or three, and isolating a region needs six.
- **First useful increment (M):** up to three simultaneous planes, each on an axis preset or a named construction plane, each with its own cap; a section box (six planes from one box gizmo); the cap coloured per Part so adjacent bodies are told apart; measurements snap to cap edges. The state rides the view sidecar and named views.
- **Parity:** `render_snapshot` accepts the same clip state, so an agent's picture can show an interior.
- **Done when:** three orthogonal planes show a capped corner on `as1_pe.stp` with each body's cap in its Part colour; a named view restores the planes; one plane behaves exactly as today.

#### 2.52 Quality gate for every element kind, reported per Part {#quality-gate-per-part}

*Area: Meshing. Effort: S–M.*

- **Evidence:** the Jacobian validity check covers ten-node tetrahedra only (`gmshService.ts`); the quality gate and its histogram describe the whole mesh, so a bad region is found by eye; VSCode-MDPA-Preview computes four different metrics for the same mesh.
- **First useful increment (S):** the validity check for every curved kind the mesher can emit (six-node triangles, eight- and nine-node quadrilaterals, twenty- and twenty-seven-node hexahedra, wedges and pyramids), evaluated at the integration points; the gate's metrics and histogram broken down by Part, with a "show worst elements" action that isolates them.
- **Next increment (M):** share the metric definitions (scaled Jacobian, skewness, warpage, radius ratio) with the sibling extension as one copied module with a drift test, so both report the same number for the same mesh.
- **Parity:** `check_mesh_quality` returns the per-Part table.
- **Done when:** a mesh with one deliberately inverted curved hexahedron fails the gate naming its Part and element; the same exported MDPA reports the same worst scaled Jacobian in both extensions.

#### 2.53 SVG `<use>` and `<text>`, and DXF arcs {#svg-use-and-dxf-arcs}

*Area: Formats. Effort: S.*

- **Evidence:** `svgImport.ts` reports `<use>` and `<text>` as unsupported, so a drawing exported with symbols loses every instance; `dxfSilhouette.ts` writes tessellated silhouettes as polylines with no arc detection, so a drawing of a hole is a 64-gon in the receiving CAD.
- **First useful increment (S):** resolve `<use>` (including nested references and its own transform) before path extraction, with a depth limit and a cycle check; `<text>` stays unsupported and the message points at "convert text to paths" and at [3D text through OpenSCAD](#text-through-openscad). On export, fit circular arcs to runs of silhouette segments within a stated tolerance and write them as DXF arcs or bulged polylines; a run that does not fit stays a polyline.
- **Done when:** an SVG with one symbol used six times imports six profiles; the drawing of a plate with four holes exports four circles whose radii match the model within the tolerance, checked by re-reading the DXF.

### Probe-gated — establish feasibility before estimating

*Admission: a specific hypothesis with a discriminating experiment. Each probe below is a small, self-contained piece of work with a firm **S** estimate of its own; the phases under "If admitted" are what ships if the probe passes, tagged provisionally. A method that accepts arguments but changes nothing is a failed probe.*

**Probe protocol.** Every probe write-up records:

- **Installed artifact versions.** At the time of writing: `opencascade.js` 1.1.1, `@loumalouomega/gmsh-wasm` 0.4.0 (Gmsh `5.0.0-git-29726e7`, the same commit as 0.3.0; it adds only the `view` namespace) and `@meshioplusplus/wasm` 19.0.0 (adopted 2026-11-07; was 18.3.0; 18.0.0 was adopted 2026-11-02; was 17.23.0 from 2026-10-29; was 17.21.0 from 2026-10-26; was 17.8.0 when adopted 2026-10-20 for the 4.10 probe; the MMG probes install `@loumalouomega/mmg-wasm` 0.1.0 first).
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
| 3.14 | Sampled B-rep self-intersection | — | Re-opens a Kernel-blocked entry by routing around it; facts only |
| 3.15 | B-rep repair by refit | full meshio++ artifact | Re-opens the ShapeFix entry; the decision gate is a real fixture |
| 3.16 | 3D text through OpenSCAD | — | Re-opens the font entry; first find out whether the WASM has a font |
| 3.17 | OpenSCAD library staging | — | Re-opens part generators as sourced libraries, not kernel primitives |
| 3.18 | Curvature, minimum radius and isocurve overlays | — | The curvature accessors have never been called; analytic fixtures decide it |
| 3.19 | Sheet-metal flat pattern of an imported part | — | Reuses `wrap`'s develop step; the bend detection is the unknown |
| 3.20 | Frame members along wireframe edges | — | Sweeps and booleans are verified; corner trims are the unknown |
| 3.21 | Mid-surface extraction | — | Shell models are the commonest idealisation this tool cannot prepare |
| 3.22 | Small-feature detection feeding `defeature` | — | The op exists; finding its input is the missing half |
| 3.23 | Flow-volume extraction | — | Booleans exist; the unknown is robustness on real imported solids |
| 3.24 | Contact and interface pair detection | — | Reuses the clash machinery; cross-repo, the sibling consumes the pairs |
| 3.25 | Section properties for profiles and frame members | 3.20 for the member half | Facts only; the profile half is independent |
| 3.26 | Symmetry detection and cut | — | Detection is the unknown; the cut is a shipped op |
| 3.27 | Queued kernel follow-ups | — | Five limits recorded in code comments, each a separate binding question |
| 3.28 | Kernel-blocked facts through meshio++'s OpenCASCADE | a meshio++ release | Re-opens Kernel-blocked entries without waiting for the self-built OCCT |

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

- **Probe passed (2026-11-01, `scripts/probe/examples/occt-vrml.ts` and `vrml-readback.ts`; opencascade.js 1.1.1):** `new oc.VrmlAPI_Writer()` then `writer.Write(shape, "/o.wrl", 2)` after `BRepMesh_IncrementalMesh_2(shape, 0.1, false, 0.5, true)` returns `true` and writes `#VRML V2.0 utf8` (the `_1`/`_2` suffixes and the static `VrmlAPI.Write` overloads do not exist). `block.stp`: 8 069 bytes, 6 `IndexedFaceSet`s; three's `VRMLLoader` reads it back as 6 meshes and exactly 12 triangles (the viewer's own count). `bull.stp`: 182 336 bytes in 110 ms, 36 face sets, read back as 36 meshes and 1 756 triangles against 1 854 coordIndex polygons (the loader drops degenerate ones; not yet reconciled with the viewer's tessellation).
- **If admitted (M, not S):** the writer is host-side OCCT, so it cannot ride the webview's mesh exporters. It needs a `wrl` B-rep export target through `exportBRep`/`writeShape` (unit scaling by the same `scaleShapeForExport` rule), `exportTargetsFor`, the headless `export_model` path, and an `mcp:smoke` round trip. Low value: VRML is legacy and glTF already covers display exchange, so this stays unscheduled.

##### 3.14 Sampled B-rep self-intersection {#sampled-brep-self-intersection}

*Area: Geometry.*

- **Hypothesis:** a self-intersecting B-rep is detectable, and locatable to its faces, from a fine tessellation, without `BRepExtrema_SelfIntersection` (dead: its element filter is unbound — see Kernel-blocked).
- **Evidence today:**
  - meshio++ 17.23.0's `checkConformity` reports partial overlaps and unwelded facets of a triangle set, and `check_mesh_conformity` already ships on it for FE meshes.
  - Manifold (shipped for mesh booleans) reports a non-manifold or self-intersecting input through its status.
  - The tessellation keeps `face-N` provenance per triangle, so a triangle pair can be named as a face pair.
- **Probe (S):**
  1. Build the probe fixture the dead-API probe could not test (a box with one face pushed through the opposite face) plus `bull.stp`, `daratech.stp` and `as1_pe.stp` as negatives.
  2. Tessellate at the viewer's chord tolerance and at 1/4 of it; run `checkConformity` on each, map intersecting triangle pairs back to face pairs, and drop pairs that share an edge in the B-rep topology.
  3. Record found face pairs, false positives on the negatives and timing.
- **Decision gate:** *pass* — the positive fixture reports its face pair at both tolerances and the negatives report none. *Fail* — a negative reports a pair at any tolerance → recorded beside the Kernel-blocked entry.
- **If admitted (S):** a `selfIntersection` fact in `check_brep_health`, labelled `sampled` with the tolerance used (never "proven free of self-intersection"), and a Mesh Health row.
- **Out of scope:** exact intersection curves, and any repair.

##### 3.15 B-rep repair by refit {#brep-repair-by-refit}

*Area: Geometry.*

- **Hypothesis:** a dirty STEP that `ShapeFix_*` cannot clear (`daratech.stp`, `piston`) can be replaced by a valid solid through tessellate → heal the triangle surface → fit analytic faces back with meshio++ `fitCad`, which sews and checks with the full artifact's OpenCASCADE.
- **Evidence today:**
  - `fit_mesh_to_cad` ships the last step (planes, cylinders, cones, spheres, tori, freeform B-splines; `faceDeviation` measures the result against the skin), and `repair_mesh` (fTetWild) plus MMG ship the healing step.
  - The ShapeFix probe failed on exactly these fixtures, with its findings recorded (see Kernel-blocked), so the gate has a ready-made baseline.
- **Probe (S):**
  1. `daratech.stp` and `piston`: tessellate, heal with `repair_mesh`, fit with `fit_mesh_to_cad`, and run `check_brep_health` on the result.
  2. Record findings before/after, `volumeRatio`, `maxDeviation`/skin deviation, face count, and which faces came back freeform rather than analytic.
- **Decision gate:** *pass* — `check_brep_health` clears the recorded findings on at least one fixture with the volume within 0.5 % and no freeform face where the source had an analytic one. *Partial* — valid but with freeform substitutions → admitted only as an explicit "rebuild solid from surface" export, never as "repair". *Fail* → recorded beside the ShapeFix entry.
- **If admitted (S–M):** a Mesh Health / B-rep Health action "Rebuild valid solid…", which writes a **new** STEP and reports the deviation; the source is never overwritten (the No-silent-CAD-source-writes invariant).
- **Out of scope:** preserving the source's face ids, names or colours.

##### 3.16 3D text through OpenSCAD {#text-through-openscad}

*Area: Geometry.*

- **Probe result (2026-11-01, `scripts/probe/examples/scad-text.ts`; `@loumalouomega/openscad-wasm`):** the package ships **no font** (its notices say so). Without a mounted font `text()` makes the render exit with status 1. With one mounted (`render(scad, {fonts: {"X.ttf": bytes}})`; an OFL face was used from disk and not bundled), `text("KKSS A", size=10)` evaluates in about 200 ms. **The `.csg` route cannot carry it:** `format: "csg"` writes the unevaluated `text(...)` node, which the `.csg` importer has no outline for. **The SVG route can:** `format: "svg"` on the 2D `text()` returns one `<path>` of 7 closed subpaths (6 contours reported for "KKSS A", counter of the A included), which is exactly what `svgImport.ts` and the multi-loop `addSurfaceFromLines` path already turn into holed faces.
- **Partial pass; stays here, narrowed:** text with counters is reachable as SVG outlines, so the whole feature is "render `text()` to SVG with a mounted font, then `import_svg`". What is not decided is the font: shipping one needs a choice (an OFL face is GPL-compatible as separate data, with its licence text beside the other notices) and a size budget in the VSIX. Until that choice is made, the SVG-outline import remains the supported route for text.
- **If admitted (S–M):** an `add_text` tool/macro that renders the SVG through the worker with the chosen bundled font and imports it, plus the font's licence notice. No kernel op, no system-font discovery.
- **Out of scope:** system-font discovery and text on curved paths.

##### 3.17 OpenSCAD library staging {#openscad-library-staging}

*Area: Geometry, Ecosystem.*

- **Hypothesis:** parametric part generators (gears, threads, springs) can be *sourced* rather than authored by staging a user-chosen OpenSCAD library such as BOSL2 into the WASM's MEMFS, if the 20-file / 1 MB staging caps are lifted for a declared library folder.
- **Evidence today:** the Rejected-scope entry on part generators rejects them as kernel geometry and keeps macros; the OpenSCAD WASM ships, and `CLAUDE.md` records that its staging caps decline large libraries, after which the binary fallback is used — so the capability exists today only for users with `openscad` installed.
- **Probe (S):**
  1. With `cadPreview.openscadLibraryPaths` pointing at a BOSL2 checkout, measure what `use <BOSL2/std.scad>` + one gear call stages (file count, bytes) and the WASM evaluation time.
  2. Try a lazy loader (stage on `use`/`include` resolution) against a raised cap.
- **Decision gate:** *pass* — a BOSL2 gear evaluates through WASM within the kernel watchdog with a bounded staging cost. *Fail* — recorded; the binary stays the route for large libraries.
- **If admitted (S):** a cap that applies per declared library folder, reported in diagnostics; the Rejected-scope entry gains the pointer.
- **Out of scope:** bundling any library in the VSIX.

##### 3.18 Curvature, minimum radius and isocurve overlays {#curvature-and-isocurve-overlays}

*Area: Geometry, Interface.*

- **Hypothesis:** OCCT's surface-property evaluator can give principal curvatures at every tessellation vertex of a B-rep face fast enough for an interactive colour overlay. The same pass yields minimum-radius facts (the smallest |1/κ| per face) and iso-parameter lines for display.
- **Evidence today:**
  - `GeomLProp_SLProps_1` is already constructed for edge pcurve normals (`CLAUDE.md`, face/curve classification). Its curvature accessors (`MaxCurvature`, `MinCurvature`, `MeanCurvature`, `GaussianCurvature`, `IsCurvatureDefined`) have never been called.
  - The Draft panel shows the overlay pattern: per-vertex scalars and a colour map in the webview.
  - SolidCraft lists curvature map, comb, isocurve and minimum-radius analyses.
- **Probe (S):**
  1. On `bull.stp` and a sphere-plus-cylinder fixture with known radii, evaluate the curvatures at each vertex's UV, as stored by the tessellation, and compare them with the analytic 1/r. Plane: 0. Cylinder: 1/r and 0. Sphere: 1/r twice. Tolerance 1e-6 relative.
  2. Time the pass on the largest perf fixture, against a starting budget of 1 s to be confirmed with the maintainer.
  3. Build an iso-U and iso-V curve on one face (`GeomAdaptor`/`Geom_Surface.UIso`/`VIso`, or sampled points in UV) and check that it lies on the surface.
  4. Record behaviour at singular points (the sphere poles), where the curvature may be undefined.
- **Decision gate:**
  - **Pass:** analytic match and within budget.
  - **Partial:** curvature works but iso-lines do not. Ship the map only.
  - **Fail:** recorded under Kernel-blocked with the failing call.
- **If admitted (S–M):** a Curvature panel in Advanced ▸ Analysis (Gaussian, mean, max and min colour maps, and a minimum-radius list per face with "select"), an iso-line display toggle, and a `check_curvature` facts tool (minimum radius per face, with `face-N` ids).
- **Out of scope:** curvature on mesh sources (a discrete estimate, which would be a separate item), the curvature comb on edges, and G2/G3 continuity verdicts.

##### 3.19 Sheet-metal flat pattern of an imported part {#sheet-metal-flat-pattern}

*Area: Geometry, Drawings.*

- **Hypothesis:** a constant-thickness B-rep built from planar faces joined by cylindrical bends, as any sheet-metal CAD exports to STEP, can be unfolded into a flat pattern with a K-factor bend allowance. The pattern would be emitted as DXF through the drawing writer. This is *preparing an existing part for manufacture*, not authoring sheet metal.
- **Evidence today:**
  - `wrap` already develops cylindrical and conical faces to the plane and back, and records the analytic parameters.
  - The DXF writer, with layers, is shipped (`drawingSheet.ts`).
  - `check_brep_health` and face classification (`BRepAdaptor_Surface_2(...).GetType()`) can tell planes from cylinders.
  - SolidCraft's sheet metal covers unfold, flat pattern, DXF and bend-table export.
- **Probe (S):**
  1. Build a test L-bracket and a U-channel with the existing ops: box, `shell` and fillets of the inner radius r with thickness t. Detect the "A-side" face set and the bends, where each bend is a pair of coaxial cylinders whose radii differ by t.
  2. Unfold. Each bend becomes a strip of width (r + K·t)·θ, and the flanges rotate rigidly about the bend lines (`BRepBuilderAPI_Transform_2`, the verified call shape).
  3. Compare the flat outline's length with the analytic flat length for K = 0.33 and K = 0.5 (±1e-6).
  4. Refuse with a reason: variable thickness, a non-cylindrical bend, or a pattern that overlaps itself.
- **Decision gate:**
  - **Pass:** analytic lengths on both fixtures, and clean refusals on a non-sheet part (`bull.stp`).
  - **Fail:** recorded under Rejected scope with the case that broke it.
- **If admitted (M):** an `unfold_sheet_metal` tool (facts: thickness, bend count, radii, angles, flat bounding box) with DXF output, bend lines on their own layer and a bend table. An Advanced ▸ Analysis panel that previews the flat pattern as a drawing.
- **Out of scope:** flanges, hems, reliefs, rips, refold, and sheet-metal rules as authoring features.

##### 3.20 Frame members along wireframe edges {#frame-members-along-edges}

*Area: Geometry.*

- **Hypothesis:** a weldment-style frame can be built from a skeleton of wireframe edges (`addLine`/`addPolyline`) by sweeping a standard profile along each edge and trimming where members meet. That needs no new kernel family: `sweep` with `profileEdges`, `addSurfaceFromLines` and booleans are all verified.
- **Evidence today:**
  - Sweep along an edge ships.
  - Standard-profile geometry would be data, as macros or a profile table, not code.
  - SolidCraft's weldments ship frame members and a profile library.
  - The unknown is the corner. Mitre and butt trims need a cutting half-space per joint, and a joint where three members meet is not a plane.
- **Probe (S):**
  1. On a closed 100 × 60 rectangle of lines, sweep a 20 × 20 × 2 square tube along each edge and mitre each corner with a bisector-plane `splitByPlane` cut.
  2. Fuse, then check the volume against the analytic frame volume (±1e-6 relative) and that `NbFreeEdges() === 0`.
  3. Repeat with butt joints: one member cut to the other's face.
  4. Try a three-member corner (a cube skeleton) and record what happens.
- **Decision gate:**
  - **Pass:** both two-member corner styles match analytically.
  - **Partial:** a three-member corner fails, so the probe ships two-member joints only, and refuses the rest with a fail diagnostic.
  - **Fail:** recorded under Rejected scope.
- **If admitted (M, provisional):** a `frameMembers` macro or op (`edgeIds`, profile name, orientation angle, corner style), a small profile table (square/rectangular tube, angle, channel) shipped like `mesh-presets/`, and a cut list in the BOM (length per member).
- **Out of scope:** weld beads, end caps and gussets as authoring features. Standard-profile sourcing beyond the bundled table goes through step.parts.

##### 3.21 Mid-surface extraction {#mid-surface-extraction}

*Area: Geometry.*

- **Hypothesis:** for a thin-walled solid whose walls are pairs of offset faces, a sheet body lying midway between each pair, trimmed and sewn at the junctions, can be built with bound OCCT calls, and the wall thickness measured for each sheet can travel to the solver as a shell property.
- **Evidence today:**
  - `measure_mesh_thickness` and the wall-thickness facts already find face pairs by ray casting on a tessellation.
  - `shell` and offset operations are bound and shipped; `addSurfaceFromLines` and the sewing ladder exist.
  - Nothing turns a solid into sheets: a plate, bracket or sheet-metal part must be meshed with solids, which needs several elements through the thickness or gives a wrong bending stiffness.
- **Probe (S):**
  1. On a flat plate, an L-bracket and a box-section tube, pair opposite faces by the existing thickness sampling and check the pairing is unambiguous.
  2. Build each mid-face by offsetting one face of the pair by half the measured thickness (`BRepOffsetAPI_MakeOffsetShape` or a face offset; confirm which is bound and returns a face), then extend and trim at T- and L-junctions.
  3. Sew, and compare the sheet's area with the mean of the two faces' areas.
- **Decision gate:** *pass* — the plate and the L-bracket give a connected sheet within 1 % area; ships for planar and cylindrical walls. *Partial* — sheets are correct but junctions are not joined; ships with the gaps reported and a manual extend. *Fail* — recorded with the failing call.
- **If admitted (M):** a `midSurface` op producing sheet bodies with a per-face thickness, a Part per distinct thickness, the thickness in the handoff manifest, and a 2-D mesh of the result. The sibling extension reads the thickness into shell Properties (cross-repository).
- **Out of scope:** variable-thickness walls, and solids that are not thin (the op refuses with the measured ratio).

##### 3.22 Small-feature detection feeding `defeature` {#small-feature-detection}

*Area: Geometry, Meshing.*

- **Hypothesis:** the faces that force a mesh far finer than the user asked for (small holes, narrow fillets and chamfers, slivers, short edges) can be found from facts the kernel already reports, ranked by how much they would cost in elements, and handed to the shipped `defeature` op as its face list.
- **Evidence today:**
  - `defeature` removes a list of faces the user picks one by one.
  - `recognize_primitives` classifies cylindrical, conical and toroidal faces with radii; `generate_hole_table` finds holes; `estimate_mesh_budget` prices a size.
  - `BOPAlgo_RemoveFeatures` is red in this build, so the removal itself stays with `defeature`'s current route.
- **Probe (S):**
  1. On `bull.stp` and `daratech.stp`, list candidate features: holes below a diameter, fillets below a radius, faces below an area, edges below a length, each threshold defaulting to a fraction of the requested mesh size.
  2. For each, estimate the element saving with the budget estimator.
  3. Apply `defeature` to the top candidates and record how many succeed.
- **Decision gate:** *pass* — at least two thirds of the proposed holes and fillets are removed cleanly on both models; ships as a **Find small features** panel with checkboxes. *Partial* — detection is reliable, removal is not; ships as a report that highlights and prices the features. *Fail* — recorded.
- **If admitted (S–M):** the panel, a `find_small_features` tool returning the ranked list, and an option on `generate_prep_report`.
- **Out of scope:** automatic removal without review.

##### 3.23 Flow-volume extraction {#flow-volume-extraction}

*Area: Geometry.*

- **Hypothesis:** the fluid region of a flow problem can be derived from the solid model with shipped booleans: for internal flow, the cavity enclosed by a solid once its openings are capped; for external flow, a box, cylinder or half-space enclosure minus the body, with the enclosure's faces named.
- **Evidence today:**
  - Boolean subtract, `addBox` and `addCylinder`, `addSurfaceFilling` (to cap an opening from its edge loop) and `addVolumeFromSurfaces` all ship.
  - `analyze_passages` already measures internal passages on a tessellation, which locates the openings.
  - The sibling extension's wind-tunnel wizard builds an enclosure around a *mesh*; nothing does it for a B-rep, where the result would mesh conformally with boundary layers on the body.
- **Probe (S):**
  1. External: on `bull.stp`, subtract the body from a box sized by upstream, downstream and lateral multiples of its bounding box; check one solid results and the body's faces are identifiable in it.
  2. Internal: on a pipe tee and a manifold, cap each opening with a filled face, build the solid from the inner faces plus caps, and compare its volume with the bounding solid minus the wall.
- **Decision gate:** *pass* — both succeed and the faces can be grouped automatically into inlet-candidate caps, walls and far field; ships. *Partial* — external only. *Fail* — recorded with the failing shape.
- **If admitted (M):** an **Extract flow volume** command producing a new body with Parts pre-created for the caps, the walls and the enclosure faces, their roles set through [simulation intent](#simulation-intent-on-parts).
- **Out of scope:** leak repair on models whose cavity is not closed (the report names the open edges and stops).

##### 3.24 Contact and interface pair detection {#contact-and-interface-pair-detection}

*Area: Geometry, Ecosystem. Cross-repository: VSCode-MDPA-Preview's structural contact authoring consumes the pairs.*

- **Hypothesis:** the face pairs of an assembly that touch, or lie within a tolerance of each other, can be listed from the clearance machinery already shipped, classified as coincident (candidates for tying or for a conformal shared face) or near (candidates for contact), and exported as paired Parts.
- **Evidence today:**
  - `check_interference_all` screens body pairs and computes clearance with a budget for large assemblies.
  - The `conformal` mesh option fragments touching bodies so they share nodes, which is right for bonded parts and wrong for parts that may separate.
  - Nothing reports *which faces* face each other, so a contact definition is assembled by picking.
- **Probe (S):**
  1. On `as1_pe.stp`, for each body pair within the tolerance, find the face pairs by distance and opposing normals (`BRepExtrema_DistShapeShape` per candidate pair, after a bounding-box screen).
  2. Record the count, the time under the existing budget, and how many pairs a person would accept.
- **Decision gate:** *pass* — the listed pairs match the visible interfaces with no more than a tenth spurious; ships. *Fail* — recorded.
- **If admitted (S–M):** an **Interfaces** table in the Clash panel (pair, gap, area, suggested kind), "create Parts" for a pair with the contact roles set, a `find_interfaces` tool, and a per-pair choice between a shared conformal face and separate matching faces at mesh time.
- **Out of scope:** contact formulation, friction and search settings (the case builder's).

##### 3.25 Section properties for profiles and frame members {#section-properties}

*Area: Geometry.*

- **Hypothesis:** area, centroid, second moments about the principal axes, the principal angle and a torsion estimate of a planar face can be computed from bound OCCT surface properties, and are exactly the numbers a beam element needs.
- **Evidence today:**
  - `get_mass_properties` reports volume properties; `GProp_GProps` over a face is the same family.
  - [Frame members along wireframe edges](#frame-members-along-edges) proposes solids swept along edges; a solver wants the edge and the section's numbers instead.
- **Probe (S):** compute the properties for a rectangle, a circle and an I-profile, compare with closed forms, and confirm surface inertia is reachable (`BRepGProp.SurfaceProperties` and `MatrixOfInertia`).
- **Decision gate:** *pass* — within 0.1 % of the closed forms; ships. *Fail* — recorded.
- **If admitted (S):** a **Section properties** row in Mass Properties for a selected planar face or profile, the same in `get_mass_properties`, and, with frame members, a 1-D export of member centrelines with a section table in the handoff manifest.
- **Out of scope:** warping constants and shear-centre calculation beyond thin-walled estimates, which are labelled as estimates.

##### 3.26 Symmetry detection and cut {#symmetry-detection-and-cut}

*Area: Geometry.*

- **Hypothesis:** mirror planes of a part can be proposed by testing the principal planes through its centre of mass (reflect, then compare volume of the common solid), and a confirmed plane cuts the model to a half or quarter with the cut faces named.
- **Evidence today:** `splitByPlane`, mass properties with principal axes, and boolean intersect all ship; halving a model today is manual, and the cut faces must be found and named by hand.
- **Probe (S):** on a symmetric bracket and on `bull.stp` (not symmetric), reflect about each principal plane, intersect with the original and compare volumes; record false positives and the time.
- **Decision gate:** *pass* — the symmetric part is detected and the asymmetric one is not, within a stated volume tolerance; ships. *Fail* — recorded; the manual cut remains.
- **If admitted (S):** **Find symmetry** in Analysis, **Cut to symmetric half** creating a Part named for the plane with the symmetry role, and the fraction of the full model recorded in the handoff manifest so integrated results can be scaled back.
- **Out of scope:** cyclic symmetry, which needs periodic meshing of the sector faces (the periodic pairs already ship and are the route for a later item).

##### 3.27 Queued kernel follow-ups {#queued-kernel-follow-ups}

*Area: Geometry.*

- **Hypothesis:** five limits recorded as follow-ups in code comments are each one binding question away from shipping.
- **Evidence today:**
  - Up-to-face extrusion accepts planar terminating faces only (`occtOperations.ts`, "curved faces are a queued follow-up").
  - Loft guides across three or more sections are deferred (`occtOperations.ts`).
  - `filletProfile` rounds corners between straight segments only.
  - `splitFace` takes one edge, not a wire or several edges.
  - `drill` has no up-to-face form (`editOps.ts`, "stays a follow-up").
- **Probe (S, one script per limit under `scripts/probe/examples/`):** for each, the smallest call that would lift it (a prism limited by a curved face through `BRepFeat_MakePrism` or a boolean with a half-space built from the face; a multi-section guide through the pipe-shell route already ruled out for takeoff, so confirm it fails here too before spending more; arc-to-line and arc-to-arc profile fillets through the 2-D fillet API; a wire fed to the face splitter).
- **Decision gate:** per limit, *pass* ships that limit's extension in the existing op with no new op kind; *fail* replaces the comment with a dated note naming the failing call.
- **If admitted (S each):** the op's validation, form and schema accept the wider input; `doc/op-coverage-allowlist.txt` and the op tables are unchanged because no kind is added.
- **Out of scope:** anything listed under Kernel-blocked.

##### 3.28 Kernel-blocked facts through meshio++'s OpenCASCADE {#facts-through-meshio-occ}

*Area: Geometry, Platform. Re-opens Kernel-blocked entries by a route that does not wait for the [self-built OCCT WASM](#self-built-occt-wasm).*

- **Hypothesis:** meshio++'s full artifact statically links a current OpenCASCADE for its STEP and IGES reads and for `fitCad`. A handful of narrow, purpose-built functions in that binding (not a general OCCT API) could return facts and shapes that `opencascade.js` 1.1.1 cannot: face self-intersection, shape healing, IGES and STEP names and colours, hidden-line edges.
- **Evidence today:**
  - Each of those is a Kernel-blocked entry whose probe failed on an unbound type or a red class, not on OCCT itself.
  - This extension already calls meshio++'s OpenCASCADE-backed functions (`fit_mesh_to_cad`, `mesh_cad_surface`, `project_to_cad`) and stages the full artifact.
  - meshio++ is maintained alongside this project, so a request for a specific function is practical.
- **Probe (S, mostly upstream):**
  1. Rank the blocked facts by user value: names and colours on IGES and STEP import first, then self-intersection for `check_brep_health`, then healing for dirty STEP that fails to mesh.
  2. Ask meshio++ for one function for the first (file bytes in, a tree of names, colours and layer names out) and measure it on the fixtures whose names are lost today.
  3. Check the cost: the full artifact is large and loaded lazily; a names-only read must not load it for every open.
- **Decision gate:** *pass* — names and colours arrive for IGES and for STEP entities where the current reader loses them; ships as a second pass that upgrades the tree, the way the deferred assembly tree does. *Fail* — recorded; the entry keeps pointing at the self-built kernel.
- **If admitted (S–M per fact):** the upgrade pass, then the self-intersection fact, then a heal-and-reimport route offered when meshing fails.
- **Out of scope:** exposing OpenCASCADE generally through meshio++, and moving modelling operations to it (two kernels editing one shape is the failure to avoid).

#### 4. Meshing probes {#meshing-probes}

| ID | Item | Needs | Why here |
| --- | --- | --- | --- |
| 4.11 | A volume behind the prism-layer shell | — | Re-opens 3D boundary layers (the gmsh-wasm checklist's first row) by a route that needs no new Gmsh build |
| 4.12 | Physics-calibrated size presets | mesh problemtype handoff | Decides whether a physics-derived size is worth a preset; cross-repo |
| 4.13 | Swept hexahedral meshes | — | A hexahedral route that avoids the rejected type-140 export |
| 4.14 | Embedded points and curves | — | Sensors and load points need mesh nodes where the user says |
| 4.15 | Size field from a previous solution | mesh adapt recipe | Closes the adapt loop on the geometry side; cross-repo |
| 4.16 | Looking inside a volume mesh | — | Rendering cost is the unknown |
| 4.17 | Triangles for display-only formats | meshio++ readers | Six formats can be viewed and nothing else |
| 4.18 | A newer gmsh-wasm build against the five gates | a gmsh-wasm release | Re-opens the gmsh-wasm checklist; the build is maintained alongside this project |

Section 4 was emptied and removed when its last probe closed; it is recreated here for the two items below, keeping the highest ID used (4.10) behind them.

##### 4.11 A volume behind the prism-layer shell {#volume-behind-prism-layers}

*Area: Meshing.*

- **Hypothesis:** a conformal 3D boundary-layer mesh (prisms on the wall, tetrahedra inside) can be produced without a new gmsh-wasm build, by meshing the volume enclosed by the inner cap of the shipped meshio++ prism layers with Gmsh's discrete-surface volume meshing, which keeps the given surface triangles as the boundary, and merging the two along that cap.
- **Evidence today:**
  - `MeshOptions.prismLayers` / `grow_prism_layers` (meshio++ 17.23.0, `meshcad` engine) ship the layer **shell** only; the meshio++ 17.23 follow-up in the [meshing library review](#meshing-library-review) records "Not done: meshing the interior behind the layers", because a tet fill needs a conforming inner-cap tetrahedralizer and meshio++ `tetrahedralize` has no Netgen in either artifact (`boundaryPreserved` is false).
  - The gmsh-wasm checklist's first row asks for an OCC-side `extrudeBoundaryLayer` and is unchanged on 0.4.0.
  - ElmerStudio documents the same gap ("boundary layers are meshed in 2D only") — 3D layers are the commonly missing piece, not a niche.
- **Probe (S):**
  1. `block.stp` and `bull.stp`: grow 3 layers, extract the inner cap as a closed triangle surface, mesh its interior with Gmsh (`classifySurfaces` + `createGeometry` + `generate(3)`) with surface remeshing off; as a control, record how far meshio++ `tetrahedralize` moves the cap (its `hausdorffToSurface`).
  2. Check that the cap nodes coincide (zero hanging nodes via `check_mesh_conformity`), that prism + tet volumes sum to the solid's volume within 1e-6 relative, and that Parts on the wall survive as Condition groups.
  3. Record minimum quality of both cell classes and timing.
- **Decision gate:** *pass* — one route gives a conformal, volume-exact mesh on both fixtures. *Fail* — recorded under the gmsh-wasm checklist row, which stays the only route.
- **If admitted (M):** `prismLayers` on the Gmsh engine's 3D path through the chosen route, MDPA/MED export of mixed prism + tet blocks, and the panel's Layer row for 3D.
- **Out of scope:** hexahedral cores and layer collapse at sharp concave corners beyond what meshio++ already reports.

##### 4.12 Physics-calibrated size presets {#physics-calibrated-size-presets}

*Area: Meshing, Ecosystem.*

- **Hypothesis:** a small set of named size presets derived from the physics the mesh is for — a wavelength rule (h ≤ λ/5 at the highest frequency), a wall rule (first size and growth for a target y⁺), and a model-relative ladder (extremely fine … extremely coarse) — gives better first meshes than one `size`, and can be handed in from the case rather than typed.
- **Evidence today:**
  - ElmerStudio's physics-controlled mesh (`core/meshing.py: SIZE_PRESETS`, nine levels as fractions of the largest side; flow halves sizes; acoustics uses c_min/(5·f_max)) and its maximum growth rate (`grow_from`, h(d) = h + (g−1)·d) are the model.
  - Here, `estimate_mesh_budget`, `Part.meshGrading` (a distance band), `meshcadGrading` (meshcad engine only) and saved mesh presets exist; nothing derives a size from physics, and the Gmsh engine has no growth-rate limit.
  - VSCode-MDPA-Preview already estimates time steps from the mesh and the case; the reverse direction (a size from the case) belongs to its problemtypes, and its roadmap tracks that half.
- **Probe (S):**
  1. On the cantilever and the wind-tunnel tutorial geometries, compare the ladder's "normal" level against the tutorials' hand-picked sizes (element count, minimum quality).
  2. Implement h(d) = h + (g−1)·d as a Gmsh `MathEval` over a `Distance` field from all walls and measure whether it changes element count and quality against the shipped `meshGrading` band on `bull.stp`.
  3. Define the handoff field (`recommendedSize`, `rule`, `source`) in the handoff manifest's v1 tolerance rules and check it round-trips.
- **Decision gate:** *pass* — the ladder matches or beats the hand-picked sizes and the growth field measurably changes the mesh. *Fail* — recorded; presets stay user-saved.
- **If admitted (M):** a "Size from physics…" preset source in the FE Mesh panel reading a `recommendedSize` the embedder (KKSS) hands in, the ladder as starter presets, `growthRate` on the Gmsh engine, and graded (non-uniform) `meshStructured` divisions.
- **Out of scope:** any automatic re-meshing loop; adaptation stays explicit (Adapt to field).

##### 4.13 Swept hexahedral meshes {#swept-hexahedral-meshes}

*Area: Meshing.*

- **Hypothesis:** a solid that is an extrusion or revolution of a face (a plate, a pipe, a shaft, a bracket of constant thickness) can be meshed with hexahedra or wedges by meshing the source face and sweeping it in layers, using element kinds the MDPA writer already handles, without the hex-dominant recombination whose connector cells were rejected.
- **Evidence today:**
  - `Part.meshStructured` gives transfinite meshes where the topology is a mapped block; most swept parts are not.
  - The MDPA writer handles hexahedra, wedges and their quadratic forms (the octree engines emit them).
  - Gmsh can extrude a surface mesh in layers, but its `geo` extrusion builds new geometry; whether a sweep can be constrained to an existing OCC volume is the unknown.
- **Probe (S):**
  1. Detect sweepable solids: two congruent end faces joined by faces ruled along one direction or about one axis (from the face classification already available).
  2. On `block.stp` and a drilled plate, mesh the source face with quadrilaterals, sweep in N layers by building the layered volume in the `geo` kernel from the meshed face, and compare the result's volume and boundary with the OCC solid.
  3. Confirm Part membership survives through boundary correlation, as it does for other engines.
- **Decision gate:** *pass* — volume within 1e-6, faces correlated, a valid MDPA of hexahedra and wedges; ships as a per-Part option. *Fail* — recorded; structured and octree meshes remain the hexahedral routes.
- **If admitted (M):** `Part.meshSwept {layers, grading}` with the detection result shown ("sweepable along z, 12.0 mm"), refusal with the reason for a solid that is not, and a smoke case with an exact element count.
- **Out of scope:** multi-sweep decomposition of general solids.

##### 4.14 Embedded points and curves {#embedded-points-and-curves}

*Area: Meshing.*

- **Hypothesis:** a point or curve of the model that is not a boundary of the meshed entity can be forced into the mesh (a node exactly at a sensor or load location, element edges along a weld line or a reinforcement) through Gmsh's embedding, and exported as a Part of nodes or line elements.
- **Evidence today:**
  - `addPoint`, `addLine` and curve ops create such geometry, and Parts can hold points and lines.
  - The sibling extension synthesises point-load conditions on nodes (`emitLoadConditions.ts`), so it needs a node where the load is.
  - Whether `mesh.embed` behaves with OCC entities after the conformal fragment step is unverified.
- **Probe (S):** embed a point and a straight edge in a face and in a volume of `block.stp`; check a node exists at the point within tolerance, edges follow the curve, and the Part's physical group is written.
- **Decision gate:** *pass* — both dimensions work with and without `conformal`; ships. *Partial* — surfaces only. *Fail* — recorded.
- **If admitted (S):** an **Embed in mesh** flag on a Part made of points or lines, validation that the entities lie on or in the target, and MDPA output as a SubModelPart of nodes or line conditions.
- **Out of scope:** embedded surfaces in volumes (interfaces are the [pair detection](#contact-and-interface-pair-detection) item's business).

##### 4.15 Size field from a previous solution {#size-field-from-solution}

*Area: Meshing, Ecosystem. Cross-repository: VSCode-MDPA-Preview's adaptive remeshing recipe writes the size map; KKSS's adaptive-refinement study drives the loop.*

- **Hypothesis:** a target-size map computed from a solved result (an error indicator or a Hessian metric) can drive a fresh mesh of the *geometry*, not only an adaptation of the old mesh, so curved boundaries stay on the CAD surface through every refinement cycle.
- **Evidence today:**
  - `sizeField` takes sampled points with sizes and the PostView field is already composed into the size computation.
  - MMG **Adapt to field** adapts an existing mesh, whose boundary is the previous mesh's facets.
  - The [physics-calibrated size presets](#physics-calibrated-size-presets) item brings sizes from the case; this brings them from its result.
- **Probe (S):** take a nodal size field on a coarse mesh of `block.stp` with a sphere of small sizes, feed it as a PostView background field, mesh the geometry, and measure the achieved sizes against the request inside and outside the sphere.
- **Decision gate:** *pass* — achieved mean edge length within 25 % of the request in both regions; ships. *Fail* — recorded; mesh adaptation stays the only loop.
- **If admitted (S–M):** `generate_mesh` and the panel accept a size-map file (a mesh with one nodal field, read through meshio++), bounded by the global minimum and maximum; the manifest records the map's hash so the embedder can tell which solution a mesh was adapted to.
- **Out of scope:** anisotropic maps (the tensor metric was probed for remeshing and not found worth shipping).

##### 4.16 Looking inside a volume mesh {#interior-mesh-inspection}

*Area: Meshing, Interface.*

- **Hypothesis:** after Generate, the cut plane can show the *elements* it crosses (whole cells, the "crinkle" cut) coloured by quality, cheaply enough to drag, so a bad interior region is found before export.
- **Evidence today:** the FE Mesh preview draws the boundary; the quality histogram counts bad elements without locating them; the cut plane clips triangles, not cells.
- **Probe (S):** for a one-million-tetrahedron mesh, build the set of cells crossed by a plane and their boundary faces in a worker; measure the time per plane move and the memory.
- **Decision gate:** *pass* — under 150 ms per move; ships as a toggle on the cut plane. *Partial* — on release only, not while dragging. *Fail* — recorded.
- **If admitted (M):** the crinkle cut, colour by a quality metric, and "isolate elements below a threshold" as a scatter of whole cells; shares the per-Part breakdown of the [quality gate](#quality-gate-per-part).
- **Out of scope:** editing elements.

##### 4.17 Triangles for display-only formats {#triangles-for-display-only-formats}

*Area: Formats, Parity.*

- **Hypothesis:** the six formats that open through three.js loaders only (3MF, Collada, AMF, USD, VRML, FBX) can also be reduced to triangles on the host, either by a meshio++ reader where one exists or by serialising the already-loaded scene from the webview, so measurement, mesh health, meshing and drawings stop refusing them.
- **Evidence today:**
  - `DISPLAY_ONLY_MESH_FORMATS` exists precisely to refuse those operations by name.
  - The viewer already serialises an edited STL back to the host for other mesh sources.
- **Probe (S):** list which of the six meshio++ reads at the current pin; for the rest, serialise the loaded scene (world transforms applied, units from the file) to STL bytes and run `check_mesh_health` on it.
- **Decision gate:** *pass* per format — the host result matches the displayed triangle count and bounding box; that format leaves the display-only list. *Fail* — it stays, with the reason recorded.
- **If admitted (S):** the route per format, and the headless tools read the same bytes (through meshio++ where it reads the format; otherwise the tool keeps answering `supported: false`, since no webview exists headless).
- **Out of scope:** materials, textures and animation.

##### 4.18 A newer gmsh-wasm build against the five gates {#newer-gmsh-wasm-build}

*Area: Meshing, Platform. Re-opens [what a new gmsh-wasm build must supply](#gmsh-wasm-upstream).*

- **Hypothesis:** the five blocked or rejected Gmsh behaviours were all measured on one Gmsh commit (`29726e7`, in both 0.3.0 and 0.4.0). `@loumalouomega/gmsh-wasm` is maintained alongside this project, so a build from a current Gmsh commit is a decision, not a dependency on someone else, and at least the build-side candidates (a stubbed `Relocate3D`, a missing boundary-layer path) may clear.
- **Evidence today:** the checklist's own first instruction, reproduce each item on a native Gmsh of the same commit, has not been recorded as done; without it nobody knows which rows are Gmsh's behaviour and which are the build's.
- **Probe (S for the triage, M for the build):**
  1. Run the five scripts' scenarios on a native Gmsh at `29726e7` and at the current release; file a three-column result (native old, native new, WASM) per row.
  2. For rows where native-new passes, build gmsh-wasm from that commit with the regression list in the checklist intact (single-thread enforcement, injectable print, the CJS entry, the build-info features).
  3. Re-run `gmsh-section4.ts`, `gmsh-boundary-layer.ts` and `gmsh-relocate3d.ts` on the new build.
- **Decision gate:** per row, *pass* moves it out of Non-goals into Ready product work with its gate's numbers; *fail on native too* turns the row into an upstream Gmsh issue link and it stays.
- **If admitted:** 3-D boundary layers on OCC solids (superseding the need for [a volume behind the prism-layer shell](#volume-behind-prism-layers) if it passes), a `Relocate3D` optimise mode, hex-dominant export if type 140 becomes describable.
- **Out of scope:** forking Gmsh.

#### 5. Platform probes {#platform-probes}

| ID | Item | Needs | Why here |
| --- | --- | --- | --- |
| 5.1 | Per-document kernel isolation | — | Memory is the only unknown |
| 5.2 | Multilingual user interface | CI with VS Code download | Partial; step 2 is the remaining gate |
| 5.3 | Inline 3D preview as an MCP App resource | two MCP-App hosts | Host support is the unknown |
| 5.4 | Part rename and delete events for embedders | — | Cross-repo; KKSS owns the report |
| 5.5 | On-canvas parameter handles | — | Preview latency is the only unknown |
| 5.6 | One design layer shared with VSCode-MDPA-Preview and KKSS | 1.8 | Three copies of the tokens exist; the mechanism is the decision |
| 5.7 | WebGL context-loss recovery | — | Reproduction is the hard part |
| 5.8 | Large-assembly rendering | — | Draw-call and memory budgets are the unknown |
| 5.9 | Visual-regression scenes | CI software rendering | Determinism under software GL is the unknown |
| 5.10 | Touch and pen input | a touch device | Cannot be judged without hardware |
| 5.11 | Presentation captures | — | A narrow, consumer-backed slice of a rejected workspace |


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

##### 5.4 Part rename and delete events for embedders {#part-rename-and-delete-events}

*Area: Platform, Ecosystem.*

- **Hypothesis:** an embedder can keep downstream references to Parts (a solver case's boundary conditions, saved monitors, sweep parameters) coherent if the host announces Part renames, deletions and membership changes as explicit events with stable Part ids, rather than leaving the embedder to diff exports.
- **Evidence today:**
  - KKSS keys a mesh case's boundary-condition assignments by SubModelPart path, i.e. by the Part *name* exported here; renaming a Part or deleting one silently orphans those assignments on the next export.
  - ElmerStudio's dependency graph (`core/deps.py`: "Used By" links, a warning before deleting a node in use, lost entities flagged) shows the user-facing half; KKSS's roadmap owns that report.
  - The handoff manifest already carries Part names and the source revision, so the receiving side can detect a change, but not distinguish a rename from a delete plus an add.
- **Probe (S):**
  1. Decide whether Parts already carry a stable internal id independent of their name (`partsSidecar.ts`); if not, define one and its migration rule for existing sidecars.
  2. Add a host-side `partsChanged {renamed: [{id, from, to}], deleted, added, membershipChanged}` event and record it in the handoff manifest's v1 tolerance rules.
  3. Check with KKSS's carry-over report that a rename keeps every assignment and a delete reports each orphan by name.
- **Decision gate:** *pass* — rename and delete are distinguishable end to end. *Fail* — recorded; the embedder falls back to name diffing.
- **If admitted (S):** the event, the manifest field, and `get_state` reporting Part ids.
- **Out of scope:** any knowledge of the embedder's case format here.

##### 5.5 On-canvas parameter handles {#on-canvas-parameter-handles}

*Area: Interface.*

- **Hypothesis:** a drag handle on the model edits *an existing op field or variable* (an extrude's length, a fillet's radius, a shell's thickness, a hole's depth, a pattern's spacing), with a value box beside it. It can stay responsive through the existing speculative-replay preview, without becoming a sketcher.
- **Evidence today:**
  - The transform gizmo is the precedent. It is a live preview on a geometry-free proxy, it stays in sync with the form fields, and only Apply commits.
  - The op preview is a speculative replay with its own `::oppreview` cache key, debounced about 250 ms.
  - SolidCraft ships handles with automatic join or cut for extrude, fillet, shell, hole depth, move, pattern spacing and revolve.
  - The unknown is latency. Every handle move is a kernel replay of the edited op and everything after it.
- **Probe (S):**
  1. For an extrude near the end of `bull.stp`'s history and one near the start, measure the preview round trip per drag step: worker replay, tessellation, post and render.
  2. Compare it against a budget of 100 ms per step for a "follows the mouse" feel, to be confirmed with the maintainer.
  3. Measure the coalesced rate (drop intermediate steps while a replay is in flight).
  4. Confirm cancellation on form switch and selection change still holds while a drag is in flight.
- **Decision gate:**
  - **Pass:** within budget at the end of the history. Handles ship for ops whose field is a length along a known axis.
  - **Partial:** within budget only near the end. Handles appear only on the last op, and earlier ops keep the form.
  - **Fail:** recorded. The value box alone ships (type a number on canvas) with the existing preview.
- **If admitted (M):** a handle per supported op form, bound to that form's field, so the field shows the value, the expression is preserved, and a field bound to a variable edits the variable with a confirmation. Snap to the grid step. Escape cancels.
- **Out of scope:** handles that create geometry, which would be sketching (see [Rejected scope](#rejected-scope)), and handles on ops below the save point.

##### 5.6 One design layer shared with VSCode-MDPA-Preview and KKSS {#shared-design-layer}

*Area: Interface, Platform, Ecosystem. Cross-repository: the sibling's roadmap carries the same item; KKSS consumes the result in `kkss-ui.css`.*

- **Hypothesis:** the metric tokens (`--ui-*`), the control recipes that exist in all three products under different class names, the line-glyph set (`uiGlyphs.ts`) and the style rules can live in one source that each product consumes, so a change is made once and a local divergence fails a test.
- **Evidence today:**
  - `media/viewer.css` defines the tokens; the sibling has `webview/design-system.css` and a design document whose hoisting proposal was never executed; KKSS re-exports this repository's `uiGlyphs.ts` and keeps its own token copy.
  - `scripts/ui-drift-check.mjs` already fetches and compares, informationally.
  - Three icon systems exist here (two TikZ-generated sets and the hand-drawn glyphs) and the two-tone treatment covers seventeen op icons.
- **Probe (S):** try both mechanisms on the tokens alone. (a) Generated copies: one canonical file, a script that writes each product's copy, and a test in each repository that fails when its copy differs. (b) A small versioned package consumed at build time. Measure what each costs on a token change that all three must pick up, including KKSS's submodule bump.
- **Decision gate:** choose the mechanism that makes a three-repository token change one pull request per repository with no manual copying; record why.
- **If admitted (M):** tokens, then recipes (button, icon button, field, segmented picker, section header, badge, toast, spinner), then glyphs; the remaining one-tone op and toolbar icons redrawn two-tone so the sets match; the glossary differences settled with the sibling (`Cut Plane` and `Clip`, `REAR` and `BACK`) and applied in both.
- **Out of scope:** the scene palette (`--cad-*`), which is this viewer's own, and any change to what a control does.

##### 5.7 WebGL context-loss recovery {#webgl-context-loss-recovery}

*Area: Platform.*

- **Hypothesis:** when the browser drops the WebGL context (a driver reset, a laptop switching GPUs, memory pressure with several large documents open) the viewer can restore the scene from data it still holds, without a reload and without losing the session's unsaved state.
- **Evidence today:** no `webglcontextlost` or `webglcontextrestored` handler exists in `src/webview` or `media`; the result of a loss is a blank viewport until the document is reopened. KKSS recovers a crashed view by reloading it, which a lost context does not trigger.
- **Probe (S):** force a loss with the `WEBGL_lose_context` extension in `test:webview`; confirm three.js restores its own resources; list what does not come back (the stencil cap, the picking targets, overlay canvases, the software-render path).
- **Decision gate:** *pass* — the scene, selection, cut plane and display mode are back after restore; ships with the test. *Partial* — a clear overlay with a Restore button that rebuilds from the last geometry message. *Fail* — recorded with the resource that cannot be rebuilt.
- **If admitted (S):** the handlers, a `contextLost` host message so an embedder can log it, and the test.
- **Out of scope:** recovering from a crashed renderer process, which the host owns.

##### 5.8 Large-assembly rendering {#large-assembly-rendering}

*Area: Platform.*

- **Hypothesis:** an assembly with thousands of bodies, many of them repeated instances, can stay interactive by drawing repeated components as instances, drawing small and distant bodies at reduced detail while the camera moves, and uploading geometry progressively.
- **Evidence today:**
  - `doc/getting-started.md` states that large assemblies are slow and nothing is streamed.
  - The XCAF structure is read, so which bodies are instances of one prototype is known, but each is tessellated and uploaded separately.
  - One kernel worker serves every document ([per-document kernel isolation](#per-document-kernel-isolation) addresses the kernel side, not the renderer).
- **Probe (S):** on the largest assembly in `examples/` and a synthetic 5,000-instance one, record draw calls, frame time while orbiting, upload time and memory; then prototype instancing for repeated prototypes and a bounding-box proxy during camera motion, and measure again.
- **Decision gate:** *pass* — the synthetic assembly orbits above 30 frames per second on integrated graphics with picking still exact; ships. *Partial* — instancing only. *Fail* — recorded with the measured ceiling, which goes in the guide.
- **If admitted (M):** instanced drawing with per-instance colour and visibility, motion-time proxies, progressive upload with the first frame shown early, and the measured limits in the guide.
- **Out of scope:** out-of-core geometry.

##### 5.9 Visual-regression scenes {#visual-regression-scenes}

*Area: Platform.*

- **Hypothesis:** a small set of committed reference renders, compared with a tolerance under software rendering, would catch the class of change the framing invariants cannot: a display mode that renders wrong, a cap that disappears, a theme whose contrast collapsed.
- **Evidence today:** `test:webview` asserts framing and state, not pixels; the sibling extension has `scripts/render-parity` with thirty-four scenes; the screenshot pipeline produces images nobody diffs.
- **Probe (S):** render five scenes (shaded, zebra, cut with cap, exploded, FE mesh preview) twice in CI's software renderer and once locally; measure the pixel difference between runs and across machines.
- **Decision gate:** *pass* — run-to-run difference below a tolerance that still catches a deliberately broken cap; ships as `npm run test:render`. *Fail* — recorded; pixels stay a manual check.
- **If admitted (S–M):** about twenty scenes covering each display mode and each theme, the comparison script, and an update command that requires a stated reason.
- **Out of scope:** comparing against the sibling extension's renders.

##### 5.10 Touch and pen input {#touch-and-pen-input}

*Area: Interface.*

- **Hypothesis:** orbit, pan, zoom and pick work on a touch screen and with a pen through pointer events, without a separate navigation mode: one finger orbits, two pan and pinch, a tap picks, a long press opens the context actions.
- **Evidence today:** navigation presets exist for mouse and touchpad (`cadPreview.navigationPreset`); nothing reads `pointerType`; KKSS's streamed-desktop deployment is reachable from tablets, where today's viewer cannot be orbited.
- **Probe (S):** with pointer-event simulation in `test:webview` and one real device, record what the current handlers do with touch input and what the smallest mapping change is.
- **Decision gate:** *pass* — the four gestures work on the device with the mouse paths unchanged; ships. *Fail* — recorded with the conflicting handler.
- **If admitted (S–M):** the gesture mapping, larger hit targets when the last pointer was touch, and a guide section.
- **Out of scope:** a touch-first layout.

##### 5.11 Presentation captures {#presentation-captures}

*Area: Interface. A narrow slice of the rejected render workspace, with consumers: documentation, KKSS's reports and an agent's replies.*

- **Hypothesis:** three things users want from a "render" can be had without a material model or a lighting editor: a turntable recording, a recording of the exploded view opening and of a configuration sweep, and one optional soft-shading mode (ambient occlusion with a ground shadow) for stills.
- **Evidence today:** screenshots and `render_snapshot` exist; the explode preview and configurations exist but only as still states; the sibling extension records WebM, GIF and PNG sequences from its own viewer.
- **Probe (S):** record a 120-frame turntable through the canvas at the viewport size and measure the time and file size; prototype screen-space ambient occlusion in the three.js pipeline and check it against the stencil cap, the selection outline and the two-tone display modes.
- **Decision gate:** *pass* for recording if a turntable encodes in under ten seconds; *pass* for soft shading only if it composes with every display mode without artefacts, otherwise it is dropped and the entry under Rejected scope stays as written.
- **If admitted (S–M):** **Record** in the View menu (turntable, explode, configuration sweep; WebM, GIF, PNG sequence, matching the sibling's formats), `render_snapshot` taking a `frames` count for a turntable, and the shading mode if it passed.
- **Out of scope:** materials, environments, lights and path tracing, which stay rejected.

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
  - SolidCraft (see the [SolidCraft review](#solidcraft-review)) ships joints with limits, as-built joints, rigid groups, motion links, contact sets and motion studies, which is the authoring side the scope question below must rule on.
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

#### 6.4 Constrained 2D sketches {#constrained-sketches}

*Area: Geometry, Interface. Re-opens "Interactive sketching with geometric constraints" from Rejected scope, at the maintainer's request (2026-11-10), under a framing that keeps what the rejection protected.*

- **Why it was rejected, and what changed:** the entry's objections were that a sketcher makes this a modelling application, that no constraint solver existed in the stack, and that click-to-place drawing would trade away the expression-driven forms. The first is a scope decision the maintainer has now reversed for KKSS's sake: a pre-processor whose users must leave it to draw a profile is missing its first step. The second is no longer true in principle: FreeCAD's planar constraint solver and SolveSpace's are both available as libraries under licences compatible with `GPL-3.0-or-later`, and WebAssembly builds of the first have been published. The third is a constraint on the design, not an obstacle: constraints are added **over** the existing profile and curve ops, whose numeric fields and expressions stay the source of truth.
- **Framing that must hold:** a sketch is a named group of the existing 2-D ops on one construction plane plus a list of constraints between their points and segments (coincident, horizontal, vertical, parallel, perpendicular, tangent, equal, distance, angle, radius). Solving writes numbers back into the ops' own fields; a field that holds an expression is treated as fixed, and a constraint that would change it is reported as a conflict. The replay kernel never sees a constraint: it replays the same ops as today, so a document with constraints opens identically in a build without the solver.
- **Probe (M):**
  1. Licence and packaging: confirm a solver's licence, its WebAssembly build's provenance and size, and that it runs in the kernel worker beside the other six kernels.
  2. Solve a rectangle with two dimensions, a slot (tangent arcs) and an over-constrained case; record solve time, the degrees-of-freedom report and how a conflict is named.
  3. Round trip: solve, write the fields, replay, and confirm the geometry equals the solved sketch.
  4. Interaction cost: prototype dragging one point with the solver in the loop and measure the latency against the budget the [on-canvas parameter handles](#on-canvas-parameter-handles) probe sets.
- **Decision gate:** *pass* — the three cases solve under 50 ms, conflicts are named, and the round trip is exact; phase 1 is admitted. *Partial* — solving works but dragging is too slow; constraints ship as a table without direct manipulation. *Fail* — recorded; the entry returns to Rejected scope with the measurements.
- **If admitted:**
  - **Phase 1 (M):** the constraint list in the edits sidecar (additive), a Constraints table in the sketch's form, a degrees-of-freedom readout, colouring of fully-, under- and over-constrained geometry, and tool parity (`apply_edit_ops` carries the constraints; a `solve_sketch` tool reports the solution and conflicts).
  - **Phase 2 (L):** click-to-place entity creation on the plane with inferred constraints, dragging, trim and extend, and a dimension tool that writes a variable.
  - **Phase 3:** the reference-image underlay, which the Rejected scope entry tied to the existence of a sketch workflow.
- **Out of scope:** 3-D sketches and constraints between sketches and model edges beyond projected reference geometry.

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

**Every entry here is re-opened by the [Self-built OCCT WASM](#self-built-occt-wasm) item if it passes, and, since 2026-11-10, the facts among them (names and colours, self-intersection, healing) by [kernel-blocked facts through meshio++'s OpenCASCADE](#facts-through-meshio-occ) (3.28), which needs no new OCCT build.** These are binding gaps in `opencascade.js` 1.1.1 (OCCT `V7_4_0`), not limits of OCCT itself, and that item's probe re-checks each one against a newer build.

- **Whole families red in the current manifest.** Nothing in them is reachable today, so no feature is proposed on top of them:
  - `BOPAlgo_*`: including `CellsBuilder`, `MakePeriodic`, `ArgumentAnalyzer` and `RemoveFeatures`.
  - `Geom2dAPI_*`: 2D interpolation, intersection and projection.
  - `IGESCAFControl_*`: so IGES names and colours cannot be read.
  - `BinXCAFDrivers`.
  - `XCAFDoc_GeomTolerance`: so GD&T is readable at most in part; see the [PMI probe](#read-pmi-layers-and-materials-from-step).

  Recorded by the [kernel capability review](#kernel-capability-review).

- **`ShapeFix_Face` / `ShapeFix_Wire` / `ShapeFix_FixSmallFace` / `ShapeFix_FixSmallSolid` (B-rep repair).** Probed live (opencascade.js 1.1.1, 2026-10-25, `scripts/probe/examples/occt-shapefix.ts`). Call shapes: `ShapeFix_Face_2(face)` → `Perform()` → `Face()`; `ShapeFix_Wire_2(wire, face, prec)` → `Perform()`; `ShapeFix_FixSmallFace` and `ShapeFix_FixSmallSolid` have **no `_N` constructors, only the plain `new`** (`FixSmallFace`: `Init(shape)`/`Perform()`/`FixShape()`; `FixSmallSolid.Remove` takes 2 arguments). Results: on `daratech.stp` all five faces `check_brep_health` flags (`face-13/54/58/70/71`, `UnorientableShape`) stay invalid — `ShapeFix_Face.Perform()` returns `false` on each, `ShapeFix_Wire` reports nothing fixed, volume unchanged; fixing every face changes one face and still leaves five bad. On `piston.stp` `ShapeFix_FixSmallFace` leaves the 48 open-boundary edges and the face count untouched (`ShapeFix_Face` likewise). Control `bull.stp` is unchanged by every fixer (volume equal to 1e-8 relative, `FixSmallFace` BREP text identical), so the fixers are safe but inert here. `FixSmallSolid` was only constructed (no fixture contains a small solid). **Revive only** with a fixture where a fixer demonstrably clears a `check_brep_health` finding, or a build that binds `ShapeFix_Shell`/`ShapeFix_Shape`; `check_brep_health` stays facts-only. **Re-opened 2026-10-31 as a probe that routes around these fixers rather than reviving them:** [B-rep repair by refit](#brep-repair-by-refit) (3.15).
- **`BRepExtrema_SelfIntersection` (face self-intersection).** Probed live (opencascade.js 1.1.1, 2026-10-25, `scripts/probe/examples/occt-brep-health-facts.ts`): the prototype is empty and both `_1(tol)` and `_2(shape, tol)` constructors throw `Cannot construct … due to unbound types: 25BRepExtrema_ElementFilter`, so a box with a face pushed through the opposite face cannot be tested. `check_brep_health` therefore reports no self-intersection fact. **Revive only** with a build that binds `BRepExtrema_ElementFilter` (the self-built OCCT probe re-checks it). **Re-opened 2026-10-31 as a sampled, triangle-based fact:** [Sampled B-rep self-intersection](#sampled-brep-self-intersection) (3.14); this entry stays the record of the dead exact API.
- **Hidden-line removal through OCCT's own `HLRBRep_*` family.** Every class is red in this build: `HLRBRep_Algo`, `HLRBRep_PolyAlgo`, `HLRBRep_HLRToShape`, `HLRBRep_PolyHLRToShape`. `HLRAlgo_Projector` is green but is a low-level internal only reachable through them.

  **The narrow survivor, `HLRAppli_ReflectLines`, was probed and is not the way in either — and it is this file's canonical example of green-but-useless.** The binding genuinely works: the unsuffixed constructor takes a `TopoDS_Shape`, and `SetAxes`/`Perform`/`GetResult` are all bound and functional (249 ms on `bull.stp`, returning a non-null compound this codebase's own `enumerateEdges` reads as 25 edges). It was rejected on the *drawing*, which is only visible by looking at it: rendered side by side against a tessellation-derived silhouette of the same view, `GetResult()` produced the outer boundary and a few fragments while missing the part's circular holes and interior cutout entirely. `GetResult()` returns reflect lines only; sharp feature edges live behind `GetCompoundOf3dEdges(type, …)`, whose `type` argument is an `HLRBRep_TypeOfResultingEdge` — from the entirely-red family above — so calling it throws. The one filter that would make the kernel path competitive is unreachable.

  **What routed around it, and what that leaves.** `export_svg_silhouette` (`src/silhouetteEdges.ts`) and then `export_technical_drawing` (`src/hiddenLineRemoval.ts`) both ship on triangle adjacency, calling no OCCT hidden-line API at all — so hidden-line *drawings*, visible edges solid and occluded runs dashed, exist today for B-rep **and** mesh sources alike, which the kernel path never could have handled. A local sibling project, HCAD, independently arrived at the same shape.

  **Correction, recorded because this entry was stale for a while:** it used to say dimensions were also out of scope. They are not. `exportTechnicalDrawingTool` is a one-line wrapper over `exportSvgSilhouetteTool`, which reads `<model>.annotations.json` unconditionally, projects every pinned measurement through the export's own view basis, and returns `dimensionCount` — in SVG *and* on DXF's own `DIMENSIONS` layer, tolerance bands included. **A second correction, since closed in full:** this entry also used to name multi-view sheet layout as what remained unshipped. That has since closed too — `export_drawing_sheet`/File ▸ Export Drawing Sheet… place several views on one sheet at a shared scale with a title block, first- or third-angle projection (see `CLAUDE.md`'s "Multi-view drawing sheets"). Nothing is currently tracked as unshipped from this Non-goal.

- **Glyph → `TopoDS_Shape` via OCCT fonts.** Every `Font_*` class is red: `Font_BRepFont`, `Font_BRepTextBuilder`, `Font_FTFont`, `Font_FTLibrary`, `Font_FontMgr`, `Font_SystemFont`, `Font_TextFormatter`. There is no path from a font file to a shape inside this build. **Re-opened 2026-10-31 by a different route:** [3D text through OpenSCAD](#text-through-openscad) (3.16), which needs a font inside the OpenSCAD WASM rather than OCCT's `Font_*` family.

  **Narrowed twice, and this entry used to overstate itself.** It was titled "3D text, engraving, and embossing" — but engraving and embossing **ship**, as `wrap`'s `emboss`/`engrave` variants, and have nothing to do with fonts. And the text half is not kernel-blocked either, only *font*-blocked: outlines that arrive as SVG paths become ordinary sketch geometry — "3D text via outline import" (the ready-product-work item this entry used to point at) has since closed in full: `svgImport.ts` now composes ancestor `transform`s (so a real "convert text to outlines" export, typically wrapped in `<g transform="...">` groups, lands correctly), `addSurfaceFromLines` accepts several disjoint loops forming one outer boundary plus its holes (a letter with a counter, e.g. an "O", builds as one holed face), `wrap` develops a holed profile onto a cylinder/cone (each hole cut out of the shell), and `import_svg` exposes the whole pipeline headlessly. Nothing is currently tracked as unshipped from this Non-goal.

- **Loft start/end (takeoff) conditions.** `BRepOffsetAPI_ThruSections` exposes no condition API — of its bound knobs only `SetSmoothing` moves geometry (`SetContinuity`/`SetParType`/`SetMaxDegree`/`SetCriteriumWeight` are accepted but byte-identical everywhere tried, so only smoothing is exposed) — and the pipe-shell conditions have no reachable consumer: `BRepOffsetAPI_MakePipeShell`'s `SetMode_4(wire)` returns `false` even for the spine itself, and `BRepFill_FaceAndOrder_2`/`EdgeFaceAndOrder_2` exist as signatures with no sweep to attach them to. Out of scope is only the *constraint*; steering a loft along a rail already ships via the resampled-intermediate `guides` fallback, which is a different feature, not a silent substitution. The [takeoff approximation probe](#loft-takeoff-by-resampled-intermediates) above explores a separate route, not a revival of this dead API.

### What a new gmsh-wasm build must supply {#gmsh-wasm-upstream}

**Re-opened 2026-11-10 as [a newer gmsh-wasm build against the five gates](#newer-gmsh-wasm-build) (4.18).** The table below is that item's gate list. What changed is not the measurements but the reading of them: both published builds wrap the same Gmsh commit, the native reproduction this section asks for first has not been recorded, and the package is maintained alongside this project, so producing the build is work that can be scheduled.

*Maintainer checklist for `@loumalouomega/gmsh-wasm` (0.4.0, Gmsh `5.0.0-git-29726e7`, OCC 7.8.1 — the same Gmsh commit as 0.3.0). Every item is a blocked or rejected entry elsewhere in this file whose "revive only" condition is a change to the Gmsh WASM build, collected so the work can be done in one pass. Nothing here can be fixed from this repository: the probes below only show whether a new build clears the gate.*

**Do first, for every item: reproduce against a native Gmsh built from the same commit** (`29726e7`, same OCC) with the same script. If native Gmsh shows the same behaviour, it is Gmsh's, not the WASM build's, and the fix is a newer upstream commit or an upstream issue. If native differs, the bug is in the Emscripten build (flags, a missing option, a stubbed dependency).

| Priority | What is required | Why we need it | Gate that a new build must pass |
| --- | --- | --- | --- |
| 1 | **A usable 3D boundary layer on OCC-imported solids.** Either a `model.occ` twin of `geo.extrudeBoundaryLayer` (the typings have none), or confirmation that the `geo` version accepts an OCC-imported surface and yields prismatic layers that mesh with the volume. Today it accepts the surface and returns entities, but nothing shows the volume mesh uses them. | 3-D boundary layers: the shipped 2-D `Part.meshBoundaryLayer` does not extend to 3-D without it (a 3-D generate ignores the layer with a warning). | On `block.stp`, extruding one face yields wedge/hex layers of the requested heights, `generate(3)` produces a conformal tet + prism mesh with no volume loss (sum equals 60), and the Part physical groups survive. |
| 2 | **Documented, closing type-140 geometry.** `getElementProperties(140)` throws, so the node layout of the hex-dominant trihedron connector cannot be confirmed; no reading of the 4-node cells closes the model volume (60 → 60.73 / 63.4). | Lets [hex-dominant Kratos MDPA export](#rejected-scope) revive, and lets `Recombine3DAll` meshes be exported at all. | `getElementProperties(140)` returns a name, dimension and node count; on `block.stp` (`Algorithm3D` 9, `Recombine3DAll`, size 1) tets + hexes + 140-cells sum to the model volume within 1e-6 with consistent orientation. |
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

- **Boundary layers** — flipped, but not by the build: 0.3.0 and 0.4.0 give identical results, and both compose a layer with a `Distance`+`Threshold`+`Min` background in either call order (the shipped `Part.meshBoundaryLayer`). Not shipped: 3-D layers (row 1 above). Re-opened 2026-10-31 by a route that needs no new build: [A volume behind the prism-layer shell](#volume-behind-prism-layers) (4.11).
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

- **Interactive sketching with geometric constraints** — **re-opened 2026-11-10 as [constrained 2D sketches](#constrained-sketches) (6.4)**, at the maintainer's request and under a framing that keeps the expression-driven forms as the source of truth; the text below is the original rejection, kept because that item's probe may send it back here. Originally: rejected, not deferred. It is the single clearest "this is a modeling application now" feature, and CAD-Preview is a preview/inspect/prepare tool. More concretely: the numeric profile and curve forms are **not** a degraded mouse — they accept parametric variable expressions (`L*2`, `R*cos(i*360/N)`) that a click-to-place tool cannot express, so replacing them with drawing would trade away a distinguishing capability for a familiar one. The argument has only got stronger: no constraint solver exists anywhere in the codebase (the sole `constraint` hit is `mate`'s doc comment), while the expression-driven sketch vocabulary has kept growing to sixteen creation ops. Worth noting that SketchForge, a dedicated sketch application, still has no constraint solver either — building this would mean shipping the weak two-thirds of the feature.

  **What survived the reframing:** authoring a profile *on a named construction plane* rather than in world coordinates (shipped as "Author profiles on a named construction plane" — see `CLAUDE.md`). That is a coordinate-frame convenience over machinery that already exists, and it does not put a solver anywhere.

- **Reference-image tracing underlay** — rejected for the current preparation workflow; **conditionally re-opened 2026-11-10** as phase 3 of [constrained 2D sketches](#constrained-sketches), since the stated objection was the absence of a sketch workflow to consume it. It would introduce image placement, calibration and tracing interactions without a sketch-authoring workflow to consume them. Tracing in a vector editor and importing through `svgImport.ts`/`dxfImport.ts` already yields editable geometry. Revisit only for a concrete calibrated inspection use case that does not require a constraint-based sketcher. This is a scope decision, not a CSP or “no image assets” invariant: data images are already allowed, and standard-parts thumbnails serve a different workflow.

- **Parametric part generators as kernel primitives (involute gears, thread forms, springs)** — rejected as *kernel geometry*. Standard parts are something this tool should mostly *source*, not author: `search_standard_parts`/`download_standard_part` fetch real, verified geometry from step.parts as ordinary STEP files the existing pipeline opens, and the interactive sidebar does the same. Authoring an involute tooth-flank generator in `occtOperations.ts` is modeling-application scope.

  **What survived the reframing:** the same shapes as *macros* — closed as the "bundled starter macro library" item (`spring`, `bolt-circle-flange`, `hex-bolt` in `macros/starter-library.json`, served when `libraryPath` is omitted). `addHelix` + `sweep` + `repeat` loops + degree trig already express a spring and a thread profile with no new kernel code — the gap was data and a path resolver, not geometry, and step.parts will not hand you a spring at *your* wire diameter anyway. **Re-opened 2026-10-31 as sourced libraries, not kernel primitives:** [OpenSCAD library staging](#openscad-library-staging) (3.17).

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

- **A photoreal render workspace (lights, environments, PBR materials, image export)** — rejected; **a narrow slice re-opened 2026-11-10** as [presentation captures](#presentation-captures) (5.11): recordings and one optional shading mode, with no material model. The workspace itself stays rejected, recorded from the [SolidCraft review](#solidcraft-review). SolidCraft ships one as its own workspace. Here the viewer's job is to show geometry truthfully for inspection: Part colours, the theme palette and the display modes. `render_snapshot` already gives an agent images. A renderer would add a second material model that meshing, export and the BOM never read. What survived is the Named materials picker in the Parts panel (shipped), which has a consumer in mass. **Revive only** for a concrete downstream consumer of rendered images that `render_snapshot`'s display modes cannot serve.

- **Hosted, shared workspaces and an HTTP MCP transport** — rejected. ReOpenSCAD serves its MCP over HTTP, with the workspace URL itself granting edit access. This extension's MCP server is a local stdio process that reads and writes files the user already owns; a network listener would be a new attack surface with nothing local to gain. What survives: registering the server with VS Code (shipped — the MCP server-definition provider and the **Connect an agent…** snippets) and copyable client snippets. **Revive only** for a concrete embedding request that cannot spawn a process (for example, a KKSS deployment that runs the server remotely), with authentication designed in from the start. **Status 2026-10-31:** the embedding case this entry anticipated (a KKSS deployment that cannot spawn the server locally) is served on the KKSS side — its bearer-token, Host-checked HTTP meta server re-exposes these tools over loopback — so nothing is owed here and the rejection stands.

- **Slicing, printer hand-off, supplier ordering and robot-description export** — rejected. text-to-cad ships skills that slice with OrcaSlicer, open Bambu Studio, preflight a SendCutSend order and write URDF/SDF. These are manufacturing and robotics execution, outside a tool for previewing, inspecting and preparing models. What survives is the fact-only analysis these skills start from: the printability facts report (shipped as `check_printability` and the Advanced ▸ Analysis **Printability** panel) and draft and undercut analysis (shipped as `check_draft` and the **Draft** panel). **Revive only** if a downstream tool needs a file format this extension cannot already export (3MF is tracked separately).

- **An in-viewer OpenSCAD editor with live re-evaluation** — rejected. ReOpenSCAD's workbench is a text area with syntax highlighting and live preview; here, VS Code is the editor and the viewer opens beside it. What survives: the Customizer panel (shipped), include tracking (shipped) so a saved edit reloads promptly, and structured diagnostics (shipped). **Revive only** if the side-by-side workflow turns out to be unworkable in practice.

- **Gmsh `occ.healShapes` as a pre-mesh repair for imported B-reps.** *Routes around it, added 2026-11-10:* healing through meshio++'s OpenCASCADE (3.28) and row 3 of the checklist through [a newer build](#newer-gmsh-wasm-build) (4.18). The entry as probed: Probed live (gmsh-wasm 0.3.0, 2026-10-17): on `block.stp` it is harmless but changes the mesh (1 282 → 1 247 tets, same volume 60, 6 faces before and after); on `daratech.stp` — the model that fails 3D meshing with `PLC Error: A segment and a facet intersect` — `removeAllDuplicates` + `healShapes` **deletes the volume** (1 volume → 0, 175 faces unchanged), so "meshing succeeds" is an empty mesh (0 tets). fTetWild remains the answer for dirty input. **Revive only** with a newer Gmsh build where a healed `daratech.stp` meshes to its true volume. Re-checked 2026-10-19 on gmsh-wasm 0.4.0 (same Gmsh commit): `daratech.stp` still goes 1 volume → 0.

- **Hex-dominant (gmsh type 140) Kratos MDPA export.** *Routes around it, added 2026-11-10:* [swept hexahedral meshes](#swept-hexahedral-meshes) (4.13) for sweepable solids, and row 2 of the gmsh-wasm checklist through [a newer build](#newer-gmsh-wasm-build) (4.18). The entry as probed: Probed live (gmsh-wasm 0.3.0, 2026-10-17, `block.stp`, `Algorithm3D` 9 + `Recombine3DAll`, size 1): the mesh holds tet4 (26.22 volume), hex8 (33.31, all consistently oriented) and 4-node type-140 cells. The 140 cells' faces all mate with tet/140 faces and each hex quad is covered by exactly two of their triangles, so they look like tetrahedra — but no reading of them closes the volume to the model's 60: as tets with signed volume they sum to +1.20 (60.73 total), by absolute value 3.85 (63.4 total), and their orientations are mixed (2.52 positive, 1.33 negative). A conformal export (140 as tets, hexes cut into 12 tets about a centroid, quads split along the neighbours' diagonal) was built and measured at volume 63.48 with 384 faces shared by three or more cells, so it was reverted. `getElementProperties(140)` still throws, so the node layout cannot be confirmed. The explicit refusal in `collectCells` stays. **Revive only** with documented type-140 geometry (a newer Gmsh, or the element's node layout from upstream) that closes the volume. Re-checked 2026-10-19 on gmsh-wasm 0.4.0 (same Gmsh commit): `getElementProperties(140)` still throws.
