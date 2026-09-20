# Roadmap

Candidate features for future CAD-Preview releases, prioritized by value versus effort given what the extension already ships: an OCCT kernel, a Gmsh kernel, a meshio++ kernel and an fTetWild kernel live in the extension host (in a forked child process), a full picking/selection pipeline in the webview, a six-sidecar persistence model, and an MCP server mirroring the pipeline headless. Many high-value features are cheap precisely because that infrastructure exists.

This page is aspirational, not a release commitment — items may be re-ordered, re-scoped, or dropped. Effort is a rough order of magnitude including implementation, documentation and focused verification: **S** (a day or two), **M** (roughly a week), **L** (multi-week). Estimates assume the stated dependencies hold; a short wiring change can still require substantial verification.

**Planning review: 2026-09-16.** Existing implementation references were checked against the repository where noted; new candidates remain proposals, not promises of kernel support. This is a prioritized backlog, not a schedule for a particular version.

Everything previously shipped is tracked in `CHANGELOG.md`, and `CLAUDE.md` has a per-feature section with the verified implementation details for anything currently in the codebase — this page is for what's **not** built yet, plus the Non-goals that record why a direction was rejected so it isn't re-proposed.

## How this file works

- **Tiers are ordered, and the order is the recommendation.** Each tier states an *admission criterion*; an item that doesn't meet it belongs in a different tier or in Non-goals, not at the top because it sounds exciting. An empty tier is removed from the file entirely rather than kept as a placeholder.
- **A closed item is removed from this list entirely**, not struck through — its write-up moves to `CLAUDE.md` (a per-feature section with the verified implementation details) and its history stays in git. **Numbering is not stable across closes**, so never reference an item by number from code or another document — reference it by name.
- **Probe-gated items are hypotheses, not implementation-ready work.** Evidence may be a binding-manifest entry, an upstream API, or a proposed geometric construction. Green in `node_modules/opencascade.js/dist/Supported APIs.md` is **necessary but not sufficient** — both the STEP-unit and the IGES-writer findings started green and only resolved (one negative, one positive) under a real probe, and `HLRAppli_ReflectLines` was green, functional, *and still the wrong tool*. Do not estimate implementation until the named probe establishes useful output, failure behaviour and cost.
- **Non-goals are not one thing.** They are split into three groups below because each has a different revival rule, and each group says plainly **what would change our mind**. A rejection nobody re-checks is how a capability stays "permanently out of reach" long after it stopped being — four entries in this file were found stale exactly that way.
- **An item that corresponds to a known GitHub issue names it inline.** The issue is the request and discussion thread; this file is the proposed scope. Reconcile disagreements against current code and the issue before implementation; neither document automatically overrides a newer decision.
- **Use feature names and heading links, not ordinal item numbers.** Each candidate states its first useful increment, dependencies or decisions, and evidence needed to close it. New features belong here only when they have a concrete user workflow and an observable completion criterion.
- **Shared capabilities must reach both consumers.** A new headless-capable operation includes MCP schemas/capabilities and sidecar compatibility; a purely visual interaction can remain webview-only. Reuse the existing pipeline and registries rather than adding parallel implementations.

Several past items were identified by comparing against [SketchForge-3D](https://github.com/Formsmith746/SketchForge-3D), a browser-based direct-manipulation CAD editor over the same OCCT kernel, and [FluidCAD](https://github.com/nkarasiak/fluidcad). Their *capability* gaps transferred well; most of their *interaction* model deliberately did not — see Non-goals.

## Open items

### Suggested implementation sequence

| Wave | Outcome | Start with | Exit signal |
| --- | --- | --- | --- |
| Correctness | The view and saved state tell the same story | Bounded clash work (clip visibility and save/reopen coverage closed) | Targeted tests catch the documented failure, including recovery paths |
| Everyday use | Less typing and fewer navigation steps | Zoom to selection; sidebar usability; named-plane profiles | Complete workflows on both a small part and a multi-body model |
| Preparation and handoff | Repeatable meshing and review output | Mesh presets; drawing settings; batch export | Reopenable outputs with explicit settings and per-file results |
| Exploration | Decide which kernel ideas deserve implementation | B-rep health first; then surface and boundary-layer probes | Analytic or independently checked results, with failure cases and timing |

These are outcome groupings, not release numbers. Independent small items can ship between waves; a failed probe must not block unrelated work.

### Tier 1 — Complete preparation and review workflows

*Admission: a useful extension of shipped infrastructure that spans several modules or needs a product decision. These are new candidates; implement a vertical slice before expanding the option surface.*

#### Document-scoped jobs and cancellation (**M–L**, host + MCP)

- **Motivation:** `kernelClient.ts` serializes requests through a shared worker; `cancelCurrent()` kills whichever job is running, which may belong to another document.
- **Phases:** attach an owner and request identity to queued work; remove a cancelled queued job before dispatch; kill only a matching active job; then expose queued/running/cancelled state and configurable operation timeouts. Preserve lazy spawning and automatic cold-cache recovery.
- **Done when:** cancelling tab B cannot interrupt tab A, queued cancelled work never starts, worker exit settles promises once, and the next request succeeds after cancellation or timeout. MCP cancellation should use the same job identity rather than a separate implementation.

#### Explicit external-change conflict handling (**M–L**, persistence)

- **Motivation:** watchers reconcile external edits, but reconciliation is not a merge protocol between a pending local debounce and another writer. The standalone MCP server also cannot inspect VS Code's dirty buffers.
- **First increment:** detect a disk revision changing since the last read before a sidecar write; retain local state and offer reload or an explicitly chosen overwrite, with a readable summary. Distinguish an external source replacement from an ordinary sidecar change.
- **Design dependency:** specify comparison/write race guarantees honestly. Content fingerprints alone are not an atomic cross-process transaction; stronger guarantees may require shared locking or an explicit protocol.
- **Done when:** a reproducible local-edit/external-write race surfaces a conflict instead of silently discarding either version. No automatic merge of geometry-op lists or positional entity ids.

#### Drawing-sheet settings and reusable templates (**M**, UI + shared serializer)

- **Gap:** `export_drawing_sheet` supports more options than the interactive format/paper quick-picks expose.
- **First increment:** expose view selection, first/third-angle projection, standard or explicit scale, and title in a compact form; add a reusable template for those settings. Continue using `drawingSheet.ts` for both serializers.
- **Done when:** UI and MCP produce equivalent layouts from identical settings, dimensions appear once in the best view, unsupported/overflowing layouts warn, and printed SVG/DXF scale is checked against a known-length fixture. Section/detail views are a separate geometry problem, not implied by this settings work.

#### Batch export with per-file results (**M–L**, host + MCP)

- **User goal:** hand off a folder of models or several chosen files without repeating the same export dialogue.
- **First increment:** sequential B-rep-to-B-rep conversion and drawing export through existing headless-capable paths; explicit destination directory and naming policy; collision handling and cancellation; per-file success/failure report. Expand to other targets only where the pipeline can actually produce them headlessly.
- **Done when:** one bad file does not discard other results, no input is overwritten by default, companion files retain correct names/references, and the report states which edits were baked. Do not implement this by repeatedly opening hidden custom editors.

#### Preparation report bundle (**M**, shared pipeline)

- **User goal:** share the evidence behind a mesh or manufacturing handoff, not just the exported file.
- **Scope:** JSON plus readable HTML containing selected existing facts: source identity, effective options, replay warnings, health/quality results, BOM/hole table and optional snapshots. Link to existing exports rather than inventing a new geometry format.
- **Done when:** unavailable checks remain explicitly unavailable, partial/skipped checks are visible, units and raw-versus-edited geometry are identified, and a report opens without network access. Rendered images remain diagnostic; they are not a validity certificate.

#### Dependency and format compatibility corpus (**M**, maintenance)

- **Motivation:** past WASM upgrades changed winding, stdout routing, companion handling and supported cell layouts; a clean install alone does not establish compatibility.
- **Scope:** a compact, version-recorded set of import/export round trips and analytic checks for each adopted kernel capability, including compound extensions and mixed cells. Supplement writer-generated fixtures with independently authored files where licensing permits. Re-check the packaged VSIX's runtime files, not only `node_modules` in the development checkout.
- **Done when:** dependency upgrades exercise the known failure cases, distinguish fixed upstream limitations from regressions, and record artifact versions. Keep expensive/variable timing checks separate from deterministic correctness gates.

### Probe-gated — establish feasibility before estimating

*Admission: a specific hypothesis with a discriminating experiment. Record the installed artifact version, fixture, exact calls, output facts, cleanup behaviour and timing. A method that accepts arguments but changes nothing is a failed probe.*

#### B-rep validity report

- **Question:** can `BRepCheck_Analyzer` or `ShapeAnalysis_ShapeContents` expose useful diagnostics for imported solids, shells and faces? A previous rejection of `BRepCheck_Analyzer` for a closure test does not establish that it is unusable for validity.
- **Probe:** a known-valid solid, an intentional open shell, and a deliberately malformed shape; determine which statuses and subshape references are accessible. An open shell can be valid as a shell while unsuitable as a closed solid, so report those facts separately.
- **Admission to implementation:** actionable, reproducible status coverage with an honest “unknown” path. Begin read-only, parallel to `check_mesh_health`; `ShapeUpgrade_UnifySameDomain` and repair belong to a later, separately verified operation, not an automatic consequence of a failed check.

#### Open-profile surface output

- **Question:** can an open profile without `thin` produce a useful surface through the shipped sweep-family builders?
- **Probe:** extrude a line and a bent wire; check nonzero area, expected bounds, orientation, export/reopen and free-face enumeration. Only then try revolve/sweep. Building a shell is not the same contract as the current solid-producing `featureModel` path.
- **Admission to implementation:** define surface versus solid output explicitly, preserve face/edge id consistency and refuse volume-only operations on the result. Start with surface extrusion rather than promising all four feature builders at once.

#### Loft takeoff by resampled intermediates

- **Question:** can the shipped guide-rail fallback's intermediate-section technique approximate takeoff control without the blocked kernel condition API?
- **Probe:** vary a near-end section offset on straight, curved and asymmetric fixtures; measure the resulting tangent change, endpoint preservation and self-intersections. Check sensitivity to station spacing and whether `ThruSections` smooths away the intended change.
- **Admission to implementation:** measurable, repeatable steering with published approximation limits. Never label the result as satisfying an exact tangent/curvature constraint; the kernel route remains blocked below.

#### Anisotropic boundary layers for 2D Gmsh meshes

- **Question:** does the installed gmsh-wasm build support a working `BoundaryLayer` field, including `setAsBoundaryLayer`, rather than merely exposing names?
- **Probe:** on a simple 2D domain, exercise wall size, growth ratio, thickness, quads and corner fans along a chosen curve. Inspect actual element connectivity, near-wall thickness and growth, not just the element count; repeat with the existing Distance/Threshold and Constant fields enabled.
- **Admission to implementation:** a verified recipe, clear unsupported combinations and non-overlapping layer behaviour. Scope to 2D; this does not establish a 3D boundary-layer route for OCC-imported geometry.

#### Optional small-detail edge suppression

- **Question:** can a display-only classifier reduce clutter without hiding important small holes or thin features?
- **Probe:** compare candidate relative-face-area measures on mixed-scale assemblies, fillets, small drilled holes and tiny standalone parts. Review rendered output at several zoom levels; a small area alone is not evidence of an unimportant edge.
- **Admission to implementation:** opt-in threshold and reversible display flag, with original `edge-N` enumeration untouched. Reuse smooth-edge visibility plumbing only after the classifier earns it; no default suppression based on an unvalidated heuristic.

## Definition of done

- **Behaviour:** complete the stated workflow, including cancellation, stale replies, empty input and reopen where relevant. A successful API return or non-empty file is not enough.
- **Evidence:** pure math gets analytic fixtures; kernel changes get live-WASM checks; webview changes get real-bundle interaction/render assertions; save/watch flows get the real host where feasible. State any remaining manual verification gap precisely.
- **Compatibility:** preserve source-write confirmation, deterministic entity-id rules, tolerant sidecar parsing and lazy host-only kernels. New bundled dependencies require a GPL-compatibility check.
- **Documentation:** update affected protocol, API, format and getting-started references together. Regenerate screenshots for viewer markup/panel changes and visually inspect a full 3D shot. Add a changelog entry when releasing a new version.
- **Closure:** remove the completed scope from this backlog, record verified implementation details in `CLAUDE.md`, and retain only a genuinely separate, scoped follow-up. An unverified branch is not closed merely because the happy path shipped.

## Non-goals / known constraints

Three groups, three different revival rules. Each says what would change our mind.

### Architectural invariants

*Not revivable as stated. These are design decisions enforced structurally rather than by convention — but "enforced structurally" is a claim about the code, not a licence to stop re-reading it, which is how the entry below came to be promoted.*

- **OCCT in the webview** — the kernel stays in the extension host; the webview runs only Three.js. Since the kernel-worker work this is *stronger* than the invariant requires: OCCT, Gmsh, meshio++ and fTetWild all run in a forked child process (`src/kernelWorker.ts`), one process further from the webview than the rule demands.

- **No silent CAD-source writes.** Explicit save-in-place already ships through the editable custom editor and headless `save_model`; this is not a read-only application. Sidecar autosave and external-change reconciliation must not silently bake edits into the source. Preserve the confirmed-save contract, `bakedThrough` replay watermark and backup/recovery behaviour. The six sidecars retain state that has no home in the source format; see `CLAUDE.md` for the implementation history.

### Kernel-blocked

*Revivable only by a new OCCT WASM build, or by a genuinely new idea that routes around the kernel — as the hidden-line item below actually did. Every entry records its probe so it isn't re-run.*

- **Hidden-line removal through OCCT's own `HLRBRep_*` family.** Every class is red in this build: `HLRBRep_Algo`, `HLRBRep_PolyAlgo`, `HLRBRep_HLRToShape`, `HLRBRep_PolyHLRToShape`. `HLRAlgo_Projector` is green but is a low-level internal only reachable through them.

  **The narrow survivor, `HLRAppli_ReflectLines`, was probed and is not the way in either — and it is this file's canonical example of green-but-useless.** The binding genuinely works: the unsuffixed constructor takes a `TopoDS_Shape`, and `SetAxes`/`Perform`/`GetResult` are all bound and functional (249 ms on `bull.stp`, returning a non-null compound this codebase's own `enumerateEdges` reads as 25 edges). It was rejected on the *drawing*, which is only visible by looking at it: rendered side by side against a tessellation-derived silhouette of the same view, `GetResult()` produced the outer boundary and a few fragments while missing the part's circular holes and interior cutout entirely. `GetResult()` returns reflect lines only; sharp feature edges live behind `GetCompoundOf3dEdges(type, …)`, whose `type` argument is an `HLRBRep_TypeOfResultingEdge` — from the entirely-red family above — so calling it throws. The one filter that would make the kernel path competitive is unreachable.

  **What routed around it, and what that leaves.** `export_svg_silhouette` (`src/silhouetteEdges.ts`) and then `export_technical_drawing` (`src/hiddenLineRemoval.ts`) both ship on triangle adjacency, calling no OCCT hidden-line API at all — so hidden-line *drawings*, visible edges solid and occluded runs dashed, exist today for B-rep **and** mesh sources alike, which the kernel path never could have handled. A local sibling project, HCAD, independently arrived at the same shape.

  **Correction, recorded because this entry was stale for a while:** it used to say dimensions were also out of scope. They are not. `exportTechnicalDrawingTool` is a one-line wrapper over `exportSvgSilhouetteTool`, which reads `<model>.annotations.json` unconditionally, projects every pinned measurement through the export's own view basis, and returns `dimensionCount` — in SVG *and* on DXF's own `DIMENSIONS` layer, tolerance bands included. **A second correction, since closed in full:** this entry also used to name multi-view sheet layout as what remained unshipped. That has since closed too — `export_drawing_sheet`/File ▸ Export Drawing Sheet… place several views on one sheet at a shared scale with a title block, first- or third-angle projection (see `CLAUDE.md`'s "Multi-view drawing sheets"). Nothing is currently tracked as unshipped from this Non-goal.

- **Glyph → `TopoDS_Shape` via OCCT fonts.** Every `Font_*` class is red: `Font_BRepFont`, `Font_BRepTextBuilder`, `Font_FTFont`, `Font_FTLibrary`, `Font_FontMgr`, `Font_SystemFont`, `Font_TextFormatter`. There is no path from a font file to a shape inside this build.

  **Narrowed twice, and this entry used to overstate itself.** It was titled "3D text, engraving, and embossing" — but engraving and embossing **ship**, as `wrap`'s `emboss`/`engrave` variants, and have nothing to do with fonts. And the text half is not kernel-blocked either, only *font*-blocked: outlines that arrive as SVG paths become ordinary sketch geometry — "3D text via outline import" (the Tier 1 item this entry used to point at) has since closed in full: `svgImport.ts` now composes ancestor `transform`s (so a real "convert text to outlines" export, typically wrapped in `<g transform="...">` groups, lands correctly), `addSurfaceFromLines` accepts several disjoint loops forming one outer boundary plus its holes (a letter with a counter, e.g. an "O", builds as one holed face), `wrap` develops a holed profile onto a cylinder/cone (each hole cut out of the shell), and `import_svg` exposes the whole pipeline headlessly. Nothing is currently tracked as unshipped from this Non-goal.

- **Loft start/end (takeoff) conditions.** `BRepOffsetAPI_ThruSections` exposes no condition API — of its bound knobs only `SetSmoothing` moves geometry (`SetContinuity`/`SetParType`/`SetMaxDegree`/`SetCriteriumWeight` are accepted but byte-identical everywhere tried, so only smoothing is exposed) — and the pipe-shell conditions have no reachable consumer: `BRepOffsetAPI_MakePipeShell`'s `SetMode_4(wire)` returns `false` even for the spine itself, and `BRepFill_FaceAndOrder_2`/`EdgeFaceAndOrder_2` exist as signatures with no sweep to attach them to. Out of scope is only the *constraint*; steering a loft along a rail already ships via the resampled-intermediate `guides` fallback, which is a different feature, not a silent substitution. The [takeoff approximation probe](#loft-takeoff-by-resampled-intermediates) above explores a separate route, not a revival of this dead API.

### Rejected scope

*Revivable only under a different framing — the objection is to what the feature would make this tool, not to whether it could be built. Narrower alternatives are identified below; some already ship.*

- **Interactive sketching with geometric constraints** — rejected, not deferred. It is the single clearest "this is a modeling application now" feature, and CAD-Preview is a preview/inspect/prepare tool. More concretely: the numeric profile and curve forms are **not** a degraded mouse — they accept parametric variable expressions (`L*2`, `R*cos(i*360/N)`) that a click-to-place tool cannot express, so replacing them with drawing would trade away a distinguishing capability for a familiar one. The argument has only got stronger: no constraint solver exists anywhere in the codebase (the sole `constraint` hit is `mate`'s doc comment), while the expression-driven sketch vocabulary has kept growing to sixteen creation ops. Worth noting that SketchForge, a dedicated sketch application, still has no constraint solver either — building this would mean shipping the weak two-thirds of the feature.

  **What survived the reframing:** authoring a profile *on a named construction plane* rather than in world coordinates ("Author profiles on a `plane-N`", Tier 1). That is a coordinate-frame convenience over machinery that already exists, and it does not put a solver anywhere.

- **Reference-image tracing underlay** — rejected for the current preparation workflow. It would introduce image placement, calibration and tracing interactions without a sketch-authoring workflow to consume them. Tracing in a vector editor and importing through `svgImport.ts`/`dxfImport.ts` already yields editable geometry. Revisit only for a concrete calibrated inspection use case that does not require a constraint-based sketcher. This is a scope decision, not a CSP or “no image assets” invariant: data images are already allowed, and standard-parts thumbnails serve a different workflow.

- **Parametric part generators as kernel primitives (involute gears, thread forms, springs)** — rejected as *kernel geometry*. Standard parts are something this tool should mostly *source*, not author: `search_standard_parts`/`download_standard_part` fetch real, verified geometry from step.parts as ordinary STEP files the existing pipeline opens, and the interactive sidebar does the same. Authoring an involute tooth-flank generator in `occtOperations.ts` is modeling-application scope.

  **What survived the reframing:** the same shapes as *macros* — closed as the "bundled starter macro library" item (`spring`, `bolt-circle-flange`, `hex-bolt` in `macros/starter-library.json`, served when `libraryPath` is omitted). `addHelix` + `sweep` + `repeat` loops + degree trig already express a spring and a thread profile with no new kernel code — the gap was data and a path resolver, not geometry, and step.parts will not hand you a spring at *your* wire diameter anyway.

- **Bundling `openscad-wasm`** — rejected (was path (c) of the closed OpenSCAD item). Technically attractive but a GPL-3.0-or-later one-way door: CGAL is GPLv3+/LGPLv3+ with no GPLv2 option and Manifold is Apache-2.0 (FSF-held GPLv2-incompatible), and it costs ~8–14 MB plus ~8 MB more for `text()`. The shipped alternative — shelling out to a user-installed binary (mere aggregation, not linking) — covers `.scad` with zero bundled megabytes and no license propagation. Revisit only if the external binary stops being a viable dependency. That path's loose end — the `openscad` invocation never having run against a real binary — was closed by a live-binary run (OpenSCAD 2021.01, verified in `src/scadService.ts`'s header), which also caught and fixed a real relative-path argv defect.
