# Roadmap

Candidate features for future CAD-Preview releases, prioritized by value versus effort given what the extension already ships: an OCCT kernel, a Gmsh kernel, a meshio++ kernel and an fTetWild kernel live in the extension host (in a forked child process), a full picking/selection pipeline in the webview, a six-sidecar persistence model, and an MCP server mirroring the pipeline headless. Many high-value features are cheap precisely because that infrastructure exists.

This page is aspirational, not a release commitment — items may be re-ordered, re-scoped, or dropped. Effort is a rough order of magnitude including implementation, documentation and focused verification: **S** (a day or two), **M** (roughly a week), **L** (multi-week). Estimates assume the stated dependencies hold; a short wiring change can still require substantial verification.

**Planning review: 2026-09-16.** Existing implementation references were checked against the repository where noted; new candidates remain proposals, not promises of kernel support. This is a prioritized backlog, not a schedule for a particular version.

Everything previously shipped is tracked in `CHANGELOG.md`, and `CLAUDE.md` has a per-feature section with the verified implementation details for anything currently in the codebase — this page is for what's **not** built yet, plus the Non-goals that record why a direction was rejected so it isn't re-proposed.

## How this file works

- **Tiers are ordered, and the order is the recommendation.** Each tier states an *admission criterion*; an item that doesn't meet it belongs in a different tier or in Non-goals, not at the top because it sounds exciting. An empty tier is removed from the file entirely rather than kept as a placeholder.
- **A closed item is removed from this list entirely**, not struck through — its write-up moves to `CLAUDE.md` (a per-feature section with the verified implementation details) and its history stays in git. **Numbering is not stable across closes**, so never reference an item by number from code or another document — reference it by name.
- **Probe-gated items are hypotheses, not implementation-ready work.** Evidence may be a binding-manifest entry, an upstream API, or a proposed geometric construction. Green in `node_modules/opencascade.js/dist/Supported APIs.md` is **necessary but not sufficient** — both the STEP-unit and the IGES-writer findings started green and only resolved (one negative, one positive) under a real probe, and `HLRAppli_ReflectLines` was green, functional, *and still the wrong tool*. Each probe carries a firm **S** estimate of its own; the implementation phases listed under an item's *If admitted* are conditional, tagged provisionally, and re-estimated once the probe establishes useful output, failure behaviour and cost.
- **Non-goals are not one thing.** They are split into three groups below because each has a different revival rule, and each group says plainly **what would change our mind**. A rejection nobody re-checks is how a capability stays "permanently out of reach" long after it stopped being — four entries in this file were found stale exactly that way.
- **An item that corresponds to a known GitHub issue names it inline.** The issue is the request and discussion thread; this file is the proposed scope. Reconcile disagreements against current code and the issue before implementation; neither document automatically overrides a newer decision.
- **Use feature names and heading links, not ordinal item numbers.** Each candidate states its first useful increment, dependencies or decisions, and evidence needed to close it. New features belong here only when they have a concrete user workflow and an observable completion criterion.
- **Shared capabilities must reach both consumers.** A new headless-capable operation includes MCP schemas/capabilities and sidecar compatibility; a purely visual interaction can remain webview-only. Reuse the existing pipeline and registries rather than adding parallel implementations.

Several past items were identified by comparing against [SketchForge-3D](https://github.com/Formsmith746/SketchForge-3D), a browser-based direct-manipulation CAD editor over the same OCCT kernel, and [FluidCAD](https://github.com/nkarasiak/fluidcad). Their *capability* gaps transferred well; most of their *interaction* model deliberately did not — see Non-goals.

## Magnusim review — 2026-09-21

Reviewed the implementation at `af8d059`, including mesher adapters, CAD diagnostics and their callers; no Magnusim kernel/solver execution was performed. The concrete opportunities are below. In particular, [refinement catalog](https://github.com/Lilmill2000/Magnusim/blob/af8d05945d3b65cd9daf220554cb08ab0392da2d/magnusim-web/python/cfddesk/project/mesh_refinements.py) contains settings-only entries: its region/extrusion menu is not evidence of implemented volume refinement. Existing Parts sizing, distance grading, Gmsh hex-dominant meshing, fTetWild and `compare_mesh_refinement` already ship here and are not new work.

| Implementation inspected | Transferable gap in CAD-Preview |
| --- | --- |
| [`measure_radial_gaps` / `check_passage_cells`](https://github.com/Lilmill2000/Magnusim/blob/af8d05945d3b65cd9daf220554cb08ab0392da2d/magnusim-web/python/cfddesk/cad/gaps.py) and [passage checks](https://github.com/Lilmill2000/Magnusim/blob/af8d05945d3b65cd9daf220554cb08ab0392da2d/magnusim-web/python/cfddesk/cad/passage.py) | Measure resolvable small features before starting a mesh; distinguish actual gap width from an area-equivalent diameter. |
| [`estimate_cell_count_range`](https://github.com/Lilmill2000/Magnusim/blob/af8d05945d3b65cd9daf220554cb08ab0392da2d/magnusim-web/python/cfddesk/cad/volume.py) | Preview the cost of size choices; adapt its rough estimate to our mesher rather than copying a hex-cell formula. |
| [`prove_cad_adherence`](https://github.com/Lilmill2000/Magnusim/blob/af8d05945d3b65cd9daf220554cb08ab0392da2d/magnusim-web/python/cfddesk/mesh/cad_adherence.py) | Quantify geometric fidelity independently of element quality. Its sampled, one-way distances and filtered outliers are not a certified Hausdorff bound. |
| [`stl_deflection_for_bc` / `verify_stl_chordal_deviation`](https://github.com/Lilmill2000/Magnusim/blob/af8d05945d3b65cd9daf220554cb08ab0392da2d/magnusim-web/python/cfddesk/cad/stl_quality.py) | Tie exported tessellation tolerances to downstream mesh size and verify sampled error. |

## Open items

### Suggested implementation sequence

| Wave | Outcome | Start with | Exit signal |
| --- | --- | --- | --- |
| Baseline | Installed, locked and documented kernel versions agree | The meshio++ upgrade pass | Full smoke and perf runs against the new artifact, with flipped assertions recorded |
| Correctness | The view and saved state tell the same story | Bounded clash work (clip visibility and save/reopen coverage closed) | Targeted tests catch the documented failure, including recovery paths |
| Everyday use | Less typing and fewer navigation steps | Zoom to selection; sidebar usability; named-plane profiles | Complete workflows on both a small part and a multi-body model |
| Preparation and handoff | Repeatable meshing and review output | Mesh presets; drawing settings; batch export | Reopenable outputs with explicit settings and per-file results |
| Exploration | Decide which kernel ideas deserve implementation | The probe harness, then B-rep validity; surface, edge, boundary-layer and takeoff probes in that order | Analytic or independently checked results, with failure cases and timing, each probe's write-up filed where the section says |

These are outcome groupings, not release numbers. Independent small items can ship between waves; a failed probe must not block unrelated work.

### Tier 0 — Keep the verified baseline current

*Admission: recurring maintenance where drift silently invalidates verification already recorded in `CLAUDE.md`. Nothing here adds a feature; each item restores the guarantee that what is documented is what ships. Ahead of Tier 1 because every later item inherits whatever kernel behaviour this tier leaves stale.*

#### Keep meshio++ up to date (**S–M**, dependency + verification)

- **Current drift (measured 2026-09-20):** `package.json`/`package-lock.json` pin `@meshioplusplus/wasm` at `^10.21.1`; the development checkout's `node_modules` still holds **10.20.2** (an `npm install` was never re-run after the last bump — the same lockfile-versus-installed gap that left 9.9.0 in place when dependabot had already moved the manifest to 10.0.0); `npm view` reports **13.0.0** as latest, so majors 11, 12 and 13 have never been evaluated. The upstream source checkout is tagged v14.0.0.
- **First increment:** `npm install` to make the checkout match the lockfile, then a reviewed bump to the latest published release. Read the upstream changelog entries for every version skipped (v11.2.0–v11.6.0 were the WASM-parity tiers, so new bindings are likely; v13.0.0's "Breaking" fallback change and v14.0.0's ABI change are Python-shim and C++-header changes that should not reach the WASM surface, but confirm rather than assume).
- **Re-verify against the installed artifact, not the git checkout** (which can be ahead or behind the published tarball): still `"type": "module"` with no `exports` map, so the dynamic `import()` stays mandatory; `resolveVariant()` still returns the threaded build under Node, so `{ variant: "seq" }` stays load-bearing; glue stdio still routes through `console.log`/`console.error` with no raw fd writes (stdout is the MCP JSON-RPC channel); the glue still self-locates its `.wasm` through `import.meta.url`, so the four-file `.vscodeignore` carve-out must still match the published `files` array; the `cell_data["surface:parent_cell"]` provenance name, `extractSurface`/`convertCells`/`readMesh`/`readMetadata`/`dataInfo` signatures and `Float64Array` marshalling across `kernelIpc.ts` are unchanged. Record the packaged `.wasm` size delta.
- **Known upstream limitations to re-check, in both directions:** the XDMF Mixed-topology reimport failure and the writers that embed no provenance (`med`/`cgns`/`xdmf`/`hmf`/`wkt`) are pinned by smoke assertions that are meant to flip when upstream fixes them — a flip is a finding to record and re-scope, not a regression to suppress. Then check whether newly published capability (WASM-parity bindings, transient/partitioned reads) is worth a follow-up item; adopt nothing speculatively in the bump itself.
- **Done when:** the installed, locked and latest-compatible versions agree; `tsc`, `npm test`, `npm run build`, `npm run mcp:smoke` and `npm run perf` pass against them; a packaged VSIX contains exactly the runtime files the loader resolves; every intentionally flipped assertion and every changed invariant is recorded in `CLAUDE.md`'s meshio++ section with the version it was verified at; and the release checklist includes `npm outdated @meshioplusplus/wasm` so this drift is caught at the next tag instead of the next incident. The corpus item in Tier 1 ("Dependency and format compatibility corpus") is what makes each future pass cheaper; this item is the recurring action itself and should not wait for it.

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

#### Narrow-gap and passage resolution preflight (**M–L**, geometry analysis + shared sizing)

- **Current gap:** `gmshSizingFields.ts` applies per-Part sizes and distance grading, but does not compare them with a measured passage width. A mesh can have acceptable element quality while failing to resolve a small channel.
- **First increment:** use existing analytic cylinder/plane recognition to find coaxial cylindrical gaps and annular openings; allow a user-measured width for other passages. Report the relevant face pair, width, requested local size and estimated cells across it. Offer an explicit **Apply local size** action setting `h <= width / targetCells` through the existing Parts/`Min` composition. Require axial overlap and expose geometric tolerances; merely coaxial, disjoint cylinders are not a flow passage.
- **Evidence:** Magnusim's `measure_radial_gaps` compares radii; `check_passage_cells` compares size with an area-equivalent opening diameter. Do not label the latter as minimum width: a long narrow slot can have a large equivalent diameter. General medial-axis/thickness analysis is a separate project. The current `tools/generate_cfmesh_standard.py` caller stops before case generation when its passage check fails; use an advisory report here until the chosen geometric width is reliable enough for a blocking rule.
- **Done when:** annulus, thin slot, disjoint coaxial cylinders and scaled-unit fixtures give the expected diagnoses; applying a suggestion changes only chosen Parts and survives reopen. Show requested resolution as an estimate until an actual mesh confirms it. **MCP:** read-only resolution report plus explicit sizing mutation with the same parameters.

#### Mesh size and memory budget preview (**M**, shared estimator + UI/MCP)

- **Current gap:** `MeshOptions` provides sizes and `compare_mesh_refinement` measures completed meshes; neither is a cheap pre-generation resource estimate.
- **First increment:** display estimated element/node counts and memory range as global size, order, dimension and local sizing change. Start with uniform simplex meshes using volume/area and calibration from existing refinement-comparison results; show the assumptions and confidence. Treat local grading, boundary layers and hex-dominant output as uncertain until calibrated, and keep a user-set advisory budget.
- **Evidence:** Magnusim's `estimate_cell_count` uses volume divided by finest hex-cell size cubed, with a heuristic lower band. That formula and its 0.55 band cannot be presented as a Gmsh tetrahedron bound. Include host/WASM/viewport copies in the memory model, not just connectivity bytes.
- **Done when:** halving uniform size yields the expected dimensional growth trend, units do not change the estimate, and a small fixture corpus records predicted versus actual counts and peak memory. Invalid/open volume geometry returns unavailable instead of a misleading budget. **MCP:** a read-only estimate and actual-versus-estimated data in mesh generation reports.

#### CAD-to-mesh deviation map (**L**, shared geometric analysis)

- **Current gap:** `gmshService.ts` reports element quality; it does not show whether a well-shaped mesh flattened a fillet, bridged a gap or lost a small feature.
- **First increment:** sample CAD faces/edges and measure distance to the exported mesh boundary, returning maximum, percentiles, coverage and per-region failures against an absolute tolerance. Start with the existing CAD tessellation as an explicitly approximate reference and a triangle acceleration structure; exact OCCT projection needs a separate binding probe. Add reverse mesh-boundary-to-reference sampling so extra surfaces are also visible. Render an error overlay and link results into **Preparation report bundle** and **Simulation handoff manifest and boundary coverage**.
- **Evidence:** Magnusim's `cad_adherence.py` separates edge and face checks; its face path measures to the boundary surface rather than only vertices. Report raw and filtered statistics with excluded sample counts; filtering distant samples must not hide a missing region. Sampling is an estimate, not a mathematical maximum-distance guarantee.
- **Done when:** an unchanged planar surface, a coarse cylinder, an omitted face and an extraneous surface produce distinguishable results; sampled density/tolerance are recorded and cancellation releases buffers. **MCP:** same numerical report and optional deviation-mesh export; overlay styling remains visual.

#### Mesh-aware surface tessellation export (**M–L**, export options + fidelity check)

- **Current gap:** volume meshing and surface export have separate accuracy controls; a fine downstream volume mesh cannot recover curvature already lost in a coarse STL.
- **First increment:** for B-rep-to-STL handoffs, accept a target downstream cell size and a chordal-error fraction, derive absolute linear deflection, retain an angular limit, and preview triangle count. Persist these as export/preset options without changing viewport tessellation. Include units, requested tolerance and measured sampled error in the preparation report. Bound triangle growth and allow cancellation.
- **Evidence:** Magnusim's `stl_quality.py` derives deflection from the finest local cell size and distinguishes requested deflection from sampled CAD distance. Transfer that relationship, not an unconditional guarantee from the mesher's input option.
- **Done when:** coarse/fine exports of a sphere/cylinder show decreasing sampled chordal error, a planar patch is not needlessly over-refined, and mm-to-m conversion preserves the physical tolerance. Clearly identify this as a surface-export concern; direct B-rep Gmsh meshing remains its existing path. **MCP:** expose the same export tolerance options and report.

#### Simulation handoff manifest and boundary coverage (**M–L**, shared export + MCP)

- **User goal:** take a prepared CAD mesh into a simulation setup without reconstructing which named regions came from which geometry revision.
- **First increment:** optionally write a versioned JSON manifest beside an existing mesh export: source/replay fingerprint, effective units and scale, meshing options and engine version, output paths, named Parts and their exported group IDs, dimensions and counts. Report empty/unresolved Parts, unassigned boundary entities and overlaps; whether an overlap is invalid belongs to the downstream problemtype. Keep solver-specific material and boundary-condition authoring downstream.
- **Dependencies:** build on the current Parts-to-Gmsh mapping and writer contracts. Coordinate the schema with the consumer before coupling a KKSS study navigator to it; do not introduce a seventh autosaved document sidecar merely for an export receipt. Stable names plus source revision identify assignments; positional face IDs alone cannot survive arbitrary topology edits.
- **Done when:** re-reading an MDPA export agrees with the manifest's SubModelParts and counts, a known unit conversion is recorded once, and remeshing or geometry edits produce a detectable revision change. Missing or ambiguous mappings remain visible rather than silently transferring conditions. MCP mesh export returns the same manifest/report and supports explicit output paths.

#### Preparation report bundle (**M**, shared pipeline)

- **User goal:** share the evidence behind a mesh or manufacturing handoff, not just the exported file.
- **Scope:** JSON plus readable HTML containing selected existing facts: source identity, effective options, replay warnings, health/quality results, BOM/hole table and optional snapshots. Link to existing exports rather than inventing a new geometry format.
- **Done when:** unavailable checks remain explicitly unavailable, partial/skipped checks are visible, units and raw-versus-edited geometry are identified, and a report opens without network access. Rendered images remain diagnostic; they are not a validity certificate.

#### Dependency and format compatibility corpus (**M**, maintenance)

- **Motivation:** past WASM upgrades changed winding, stdout routing, companion handling and supported cell layouts; a clean install alone does not establish compatibility.
- **Scope:** a compact, version-recorded set of import/export round trips and analytic checks for each adopted kernel capability, including compound extensions and mixed cells. Supplement writer-generated fixtures with independently authored files where licensing permits. Re-check the packaged VSIX's runtime files, not only `node_modules` in the development checkout.
- **Done when:** dependency upgrades exercise the known failure cases, distinguish fixed upstream limitations from regressions, and record artifact versions. Keep expensive/variable timing checks separate from deterministic correctness gates.

### Probe-gated — establish feasibility before estimating

*Admission: a specific hypothesis with a discriminating experiment. Each probe below is a small, self-contained piece of work with a firm **S** estimate of its own; the phases under "If admitted" are what ships if the probe passes, tagged provisionally. A method that accepts arguments but changes nothing is a failed probe.*

**Probe protocol.** Every probe write-up records: the installed artifact version (`opencascade.js` 1.1.1 and `@loumalouomega/gmsh-wasm` 0.3.0 at the time of writing), the fixture path, the exact call shapes that worked — overload suffix and argument count, because there is no `.d.ts` for OCCT and signatures are found by enumerating a prototype and trying suffixes, the same way every other OCCT call site here was found — the output facts, cleanup behaviour (`.delete()` in `finally`, a kernel reset after a deliberate abort), and wall-clock timing on the largest fixture that fits. MEMFS paths stay at 10 characters or fewer; the 11+ cliff silently corrupts STEP writes.

**Where a result goes.** *Pass:* the item's "If admitted" phases move into Tier 1 with firm estimates, and the probe's call shapes move to `CLAUDE.md` as the feature's verified facts. *Fail:* the item moves to Non-goals — Kernel-blocked for a dead binding, Rejected scope for a product judgement — with the exact calls that failed and what would change our mind. *Partial:* the item stays here, narrowed to the surviving hypothesis, with the negative half recorded under Non-goals.

**Order, and why.**

| Order | Item | Needs | Why here |
| --- | --- | --- | --- |
| 1 | Probe harness | — | Every other row hand-copies the same esbuild recipe today |
| 2 | B-rep validity report | harness | Cheapest, largest reuse (mirrors `check_mesh_health`), and may explain the known Gmsh PLC failures |
| 3 | Open-profile surface output | harness | Exercises the same free-face invariant the validity item reads; structurally cheap |
| 4 | Small-detail edge suppression | harness, screenshot pipeline | Webview-side and independent; the risk is judgement, not bindings |
| 5 | Anisotropic boundary layers | harness, a `$Elements` walker | The largest probe, and the first live exercise of `dimension: 2` |
| 6 | Loft takeoff by resampled intermediates | harness | Lowest value; the measurement design is the hard part |

None depends on another row's *result*, only on the harness — a failed probe never blocks a later one.

#### Probe harness (**S**, prerequisite)

- **Gap:** every live-WASM finding recorded in this repo — `draft`'s five-argument `Add`, `BRepExtrema_DistanceSS`'s missing `Perform`, the IGES unit-writer false negative, fTetWild's winding — came from a throwaway esbuild bundle that was never committed, and `doc/development.md` has no section on obtaining a live `oc` or `gmsh` handle in a scratch script. The recipe exists only inside `scripts/screenshots/make-fixtures.mjs`.
- **Scope:** `scripts/probe/run.mjs <entry.ts>` using that script's esbuild config verbatim — `platform: node`, `format: cjs`, the `wasmPathPlugin`, the `import.meta.url` banner, and an `external` list kept in sync with `esbuild.mjs`'s own arrays (it already fell behind once and broke `docs:screenshots` with a top-level-await error) — spawning `process.execPath` **without** clearing `ELECTRON_RUN_AS_NODE`, so it runs under the Flatpak recipe too. `extensionPath` is `process.cwd()` and `dist/*.wasm` must exist, so the runner chains `node esbuild.mjs` first. One committed example entry opens `examples/STP/bull.stp` through `readShape`, prints face and edge counts (36 and 98, known), and shows the `.delete()`-in-`finally` skeleton plus `resetOcct()`/`resetGmsh()` on abort. A `scripts/probe/README.md` states the protocol above and where write-ups go; scratch entries under `scripts/probe/scratch/` are git-ignored; `.vscodeignore` excludes the directory.
- **Done when:** a new probe needs no copied esbuild config, the example runs under plain Node and under the Electron-as-Node recipe, `npm run build` is unaffected, and `doc/development.md` links the README.

#### B-rep validity report

- **Hypothesis:** `BRepCheck_Analyzer` returns per-subshape statuses — not only a whole-shape boolean — for imported STEP/IGES/BREP geometry, and `ShapeAnalysis_ShapeContents`/`ShapeAnalysis_FreeBounds` add counters a report can print as facts.
- **Evidence today:** `BRepCheck_Analyzer`, `BRepCheck_Result`, `BRepCheck_Shell/Solid/Face`, `ShapeAnalysis_ShapeContents/Shell/Wire/FreeBounds/CheckSmallFace`, `ShapeUpgrade_UnifySameDomain` and `BRepAlgoAPI_Check` are all green in the manifest; `BOPAlgo_ArgumentAnalyzer` is red. The binary exports `BRepCheck_Analyzer` unsuffixed and `BRepCheck_Result_1..3`, `ShapeUpgrade_UnifySameDomain_1..3`. The only prior use was a rejection as a *closure test* on a freshly-sewn shell, where `NbFreeEdges()` won; it has never been called on imported geometry. `ShapeFix_Shape/Shell/Wireframe` throw or lack `.Perform`; only `ShapeFix_Solid` works. `TopExp.MapShapesAndAncestors` is unreachable (its map type is absent from the binary), so subshape bookkeeping uses the `HashCode(1<<30)` + `IsSame` bucket idiom.
- **Probe (S):**
  1. Enumerate the prototype of `new oc.BRepCheck_Analyzer(shape)`; if the unsuffixed ctor throws, try `_1` with `(shape, true)`. Find `IsValid` (whole-shape and per-subshape overloads), `Result(sub)`, and on the result `Status`/`StatusOnShape`; record which `BRepCheck_Status` members are readable symbolically.
  2. Fixtures, in this order: `bull.stp` (healthy control); `cubsomcy.stp`, the shell-typed twin of `cubcylso.stp` (`examples/README.md` documents the pair); `block.stp` and `daratech.stp`, which both trip Gmsh's `PLC Error` during 3D meshing — the report should either flag them or say "valid per BRepCheck", and either is a finding; and a promoted `holed-cube.stl`, a deliberately open input. For each: whole-shape verdict, per-subshape status list keyed by `solid-N`/`face-N`/`edge-N`, `ShapeAnalysis_ShapeContents.Perform` counters (free versus shared edges, shells, solids), `ShapeAnalysis_FreeBounds` on the shell.
  3. Discriminator: the shell twin reports free edges above zero and no closed solid; the solid twin reports zero. A per-subshape status must name at least one *specific* face or edge on the open input. A bare boolean is a failed probe.
  4. Separately, `ShapeUpgrade_UnifySameDomain` on a box with one fillet: face count before and after, volume unchanged to 1e-9. Recorded as its own finding, never as this item's admission.
  5. Time the analyzer on `turbine.stp` (2.3 MB) and record whether `IsValid` is cheap enough for a panel that runs on open or only for an explicit action.
- **Decision gate:** *pass* — per-subshape statuses readable and reproducible on the shell/solid pair. *Fail* — a whole-shape boolean only, or statuses that don't discriminate the pair → Kernel-blocked, with the ctor and `Result` calls tried. *Partial* — counters work, statuses don't → narrow to a counters-only report.
- **If admitted:** Phase 1 (**M**) — `checkBrepHealth(extensionPath, bytes, format, ops)` in a new `src/brepHealth.ts` returning a facts-only report shaped like `MeshHealthReport` (per solid: closed or not, free-edge count, per-subshape status list, `null` for anything the analyzer could not compute), wired through the four-touch-point `Pipeline` pattern; a `check_brep_health` MCP tool whose gate inverts `check_mesh_health`'s (mesh sources get `supported: false`); a "B-rep Health" sidebar section mirroring Mesh Health's request/result trio; a `describe_capabilities` limitation entry. Phase 2 (**M**, its own probe) — `unify_same_domain` as an explicit, undoable edit op, never an automatic consequence of a failed check.
- **Out of scope:** repair. `ShapeFix_*` is three-quarters dead in this build and this item is read-only by design.

#### Open-profile surface output

- **Hypothesis:** prisming an open wire directly with `BRepPrimAPI_MakePrism_1` — the already-verified call shape, applied to the wire instead of a face — yields a ruled *surface* the existing free-face pass displays and enumerates with stable `face-N` ids, with no new kernel binding.
- **Evidence today:** the refusal is `openProfileNeedsThin` in `occtOperations.ts`, reached from `profileFaceFor`, `regionFacesFor` and the loft branch. Everything downstream is more permissive than that refusal implies: `featureModel` appends whatever `buildFeatureSolid` returns with no `TopAbs_SOLID` check (the same five `BRep_Builder` lines `addSurfaceFromLines` uses); `tessellateByGroup`'s free-face pass already groups un-owned faces as "Sketches" and `collectFaces` mirrors it; `computeMassProperties` already returns `volume: null` for a `face-N`; `STEPControl_AsIs` writes shells. The two real blockers are `finishThin`/`orientPositiveVolume`, which rejects a near-zero-volume result (a surface path must bypass it), and the id scheme — `solid-N`/`face-N`/`edge-N`/`point-N`, no `shell-N`.
- **Probe (S):**
  1. On `block.stp`, append an `addLine` (one segment) and an open three-point `addPolyline`; resolve their edges through `collectEdges` into a wire; `BRepPrimAPI_MakePrism_1(wire, vec, false, true).Shape()`.
  2. Assert `ShapeType()` is a shell (or a compound of faces), face count equals segment count, `surfacePropertiesAdaptive` area equals the sum of segment length × extrude length to 1e-9, and a `BRepBuilderAPI_Sewing` pass reports `2·segments + 2` free edges — an open sheet by construction.
  3. Append the result to the model compound exactly as `featureModel` would; run `tessellateByGroup` and `collectFaces` and assert the new faces land in "Sketches" at the same contiguous `face-N` positions in both — the invariant every `face-N` operand depends on.
  4. Export to STEP at `/o.step`, re-read, and repeat step 2 on the reread shape; run `computeMassProperties` on one new face and assert `volume: null` with a matching `area`.
  5. Then revolve the same open wire through `BRepPrimAPI_MakeRevol_1`: area equals Pappus (arc length × 2π × centroid radius) for a full sweep.
- **Decision gate:** *pass* — analytic area, stable ids, a clean STEP round trip. *Fail* — the wire prism is refused, or the free-face pass and `collectFaces` disagree on the new faces' positions → Kernel-blocked (the wire prism specifically), with the refusal recorded.
- **If admitted:** Phase 1 (**S**) — `extrude` and `revolve` accept an open profile without `thin` and produce a surface: the op outcome and bucket record the generic `produced` role, `finishThin` is bypassed, `featureModel` is unchanged, the faces are ordinary free faces (no new id kind), and consumers that need a closed volume (`addVolumeFromSurfaces`, mass volume) refuse them by name. The panel hint and `OP_PARAM_DOCS` say "surface, not solid". Phase 2 (**M**, only if a real need appears) — `sweep`/`loft` surfaces and a `shell-N` entity id; deferred deliberately, since that id touches `entityIdScheme`, the picker, rebinding and every sidecar reader.
- **Out of scope:** any change to `collectFaces`'s claiming algorithm — the probe verifies the new faces fit it as-is.

#### Loft takeoff by resampled intermediates

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

#### Anisotropic boundary layers for 2D Gmsh meshes

- **Magnusim-inspired scope refinement:** if the existing probe passes, accept layer count, first-layer height and growth ratio with a computed total thickness and explicit units. Report incompatible/excessive thickness and unresolved wall selections before meshing, then report achieved layers and quality afterward. Persist the effective settings with the existing mesh options and expose them through MCP. Reuse the current distance-sizing controls; these inputs do not establish support for 3D inflation. Include an analytic geometric-series check and a narrow-gap fixture in acceptance.

- **Hypothesis:** the bundled gmsh-wasm 0.3.0 builds a working `BoundaryLayer` field — thin, ratio-graded quads hugging a chosen curve — through `field.add("BoundaryLayer")` + `setAsBoundaryLayer`, and it composes with the existing `Min` background field rather than replacing it.
- **Evidence today:** string presence only, but more of it than the earlier wording admitted. `setAsBoundaryLayer(tag)` and `geo.extrudeBoundaryLayer(dimTags, numElements?, heights?, recombine?, second?, viewIndex?)` are both in `dist/gmsh.d.ts` with `unsupported: false` in the binding descriptor; the binary's string pool registers `BoundaryLayerField` in the field factory and carries the option names `CurvesList`, `PointsList`, `FanPointsList`, `FanPointsSizesList`, `ExcludedSurfacesList`, `SizeFar`, `Thickness`, `Ratio`, `AnisoMax`, `BetaLaw`, `NumExactLayers`, `Quads`, plus the runtime diagnostics "Different boundary layers cannot touch each other" and "Impossible boundary layer configuration". Nothing has called any of it. The shipped `Distance`+`Threshold`+`Min` composition owns the single `setAsBackgroundMesh` call (`gmshSizingFields.ts`); a boundary layer is set through a *different* call, which is exactly what makes coexistence a question rather than a known. Two adjacent facts, stated plainly: no committed test runs `dimension: 2` live, and `CLAUDE.md`'s claim that a 3D layer "needs `geo.extrudeBoundaryLayer`, which OCC-imported sources can't use" is an inference from the type surface (`extrudeBoundaryLayer` lives on `model.geo` with no `model.occ` twin), not a probe result.
- **Probe (S):**
  1. *Isolated, native gmsh:* `occ.addRectangle(0, 0, 0, 10, 4)` → `synchronize` → `field.add("BoundaryLayer")` → `setNumbers` of `CurvesList` to the bottom edge, `setNumber` for the wall size 0.05 (try `hwall_n`, then `Size`), `Ratio` 1.2, `Thickness` 0.5, `Quads` 1, `FanPointsList` the two bottom corners → `setAsBoundaryLayer(tag)` → `Mesh.Algorithm = 6` → `generate(2)`. Assert the two rejection strings above never fire, then through `getElements(2)`: quads present (Gmsh type 3), the nearest node row at y ≈ 0.05, successive rows growing by ≈1.2, and more elements than the plain mesh. This needs a walker over `getElements`'s per-type arrays — new code; the smoke script only parses `$Nodes` today.
  2. *Composition:* add a `Distance`+`Threshold` background through `setBackgroundMin` beside the layer and confirm both effects survive one generate; then two layers on touching curves, expecting the documented "cannot touch" diagnostic.
  3. *Through the real pipeline:* append `addRectangleProfile` to a copy of `block.stp` (it lands as `face-6`), assign a curve-scoped Part, and `generate_mesh` at `dimension: 2` — the first live `dimension: 2` run in the repo — verifying the `edge-N` to `(1, tag)` bbox correlation `gmshPartsMap.ts` would rely on.
  4. *Cheap, recorded:* `option.getNumber("Mesh.BoundaryLayerFanElements")` round-trips; `geo.extrudeBoundaryLayer` on an OCC-imported surface, to prove or refute the 3D claim instead of keeping the inference.
- **Decision gate:** *pass* — graded quads with the asserted wall size and ratio, composing with the background field. *Fail* — triangles only, a no-op, or a throw → Kernel-blocked with the option names and diagnostics recorded. *Partial* — works alone but replaces the background field → keep here, narrowed to "layer or grading, not both".
- **If admitted:** Phase 1 (**M**) — `Part.meshBoundaryLayer { wallSize, growthRatio, thickness, quads }` for curve-scoped Parts on 2D generates: a third `if (part.meshBoundaryLayer != null)` branch in `applyPartsToGmshModel` beside `meshSize` and `meshGrading`, a `validateMeshBoundaryLayer` gate, every length scaled by `scalePartsMeshSizeForUnit`, a `set_part` parameter, a panel row, and a `.geo` script comment. Phase 2 (**L**, its own probe, only if step 4 passes) — 3D layers through `extrudeBoundaryLayer`.
- **Out of scope:** 3D layers on OCC-imported solids unless step 4 proves the route; STL sources (no entity correlation, the same rule physical groups follow).

#### Optional small-detail edge suppression

- **Hypothesis:** a per-edge `detail` flag — both adjacent faces small relative to the model — hides post-treatment clutter (fillet-band seams, cosmetic chamfers) on real assemblies without hiding drilled-hole rims or thin features.
- **Evidence today:** the `smooth` flag is the exact plumbing template: `EdgeLine`/`EncodedEdge.smooth`, `buildEdgeLine`'s `userData`, `Viewer.applyEdgeVisibility` as the single visibility writer, the `#hide-smooth-edges` menu item, and `applyLineFilter`'s seam exclusion. No per-face facts travel to the webview (`FaceMesh` is id plus buffers), but host-side `collectAllEntitySignatures` already computes every face's area in `face-N` order, `faceSurfaceInfo` gives the surface type, and `bboxDiagonal` is the codebase's relative-scale denominator. What is missing is evidence, not bindings: no fixture demonstrates the clutter, and "small" has no validated threshold.
- **Probe (S):**
  1. Host-side, on `bull.stp`, `4pinplug.stp`, `gear.stp` and `as1_pe.stp`: for every edge with exactly two adjacent faces (`buildEdgeFaceAdjacency`), compute `min(areaA, areaB) / bboxDiagonal²` and both surface types; mark `detail` at τ ∈ {1e-4, 1e-3, 1e-2}.
  2. Count, per fixture and τ, the edges hidden, and of those how many belong to a cylindrical face (the drilled-hole proxy) or to a face whose own bbox spans more than 10 % of the model (a thin sheet — small area, large extent).
  3. Render each τ through the screenshot harness with the flag applied and inspect the images at two zoom levels — a count is not evidence that the drawing reads correctly.
- **Decision gate:** *pass* — some τ hides at least 30 % of fillet-band seams on two or more fixtures while hiding no cylindrical hole rim and no large-extent face's edges. *Fail* — every τ that removes clutter also removes a hole rim → Rejected scope, with the tables kept.
- **If admitted:** Phase 1 (**S**) — `detail: boolean` beside `smooth` on the wire format (never a filter: `edge-N` enumeration untouched), a `#hide-detail-edges` View item through `applyEdgeVisibility`, opt-in, the threshold a `cadPreview.*` setting defaulting to the probe's τ; and fix the documented "edge visibility does not survive a model rebuild" limitation for *both* flags in the same change, since a second toggle would double that bug's surface.
- **Out of scope:** any default-on suppression; area alone as the criterion — surface type and extent are part of the test.

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
