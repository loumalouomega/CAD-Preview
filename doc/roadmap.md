# Roadmap

Candidate features for future CAD-Preview releases, prioritized by value versus effort given what the extension already ships:

- **Five WASM kernels in the extension host,** all in one forked child process (`src/kernelWorker.ts`):
  - OCCT, through `opencascade.js`
  - Gmsh
  - meshio++
  - fTetWild
  - a user-installed OpenSCAD binary for `.scad`
- **Two more proposed below:** MMG and a self-built OpenSCAD WASM.
- **The rest of the pipeline:** a full picking/selection pipeline in the webview, a six-sidecar persistence model, and an MCP server mirroring the pipeline headless.

Many high-value features are cheap precisely because that infrastructure exists.

This page is aspirational, not a release commitment — items may be re-ordered, re-scoped, or dropped. Effort is a rough order of magnitude including implementation, documentation and focused verification: **S** (a day or two), **M** (roughly a week), **L** (multi-week). Estimates assume the stated dependencies hold; a short wiring change can still require substantial verification.

**Planning review: 2026-09-24.** Three sources fed this review:

- **Repository:** deferred work and verification gaps, read from `CLAUDE.md` and `doc/`.
- **Outside the repo:** GitHub issues, the sibling KKSS and VSCode-MDPA-Preview roadmaps, and npm currency.
- **Kernel binaries:** every OCCT and Gmsh capability that is bound but never called.

Existing implementation references were checked against the repository where noted. New candidates remain proposals, not promises of kernel support. The previous review was 2026-09-16.

Everything previously shipped is tracked in `CHANGELOG.md`, and `CLAUDE.md` has a per-feature section with the verified implementation details for anything currently in the codebase — this page is for what's **not** built yet, plus the Non-goals that record why a direction was rejected so it isn't re-proposed.

## How this file works

- **Sections are ordered, and the order is the recommendation.** Each section states an *admission criterion*; an item that doesn't meet it belongs in a different section or in Non-goals, not at the top because it sounds exciting. An empty section is removed from the file entirely rather than kept as a placeholder.
  - **1. Upkeep and defects:** no design question, only work. (Called "Tier 0" in older changelog and `CLAUDE.md` text.)
  - **2. Ready product work:** no kernel unknown remains, whether because a probe passed or because the work only reuses shipped machinery. The estimate is firm. (Called "Tier 1" in older text.)
  - **3–5. Probe-gated:** a hypothesis with a discriminating experiment, grouped by area — geometry, meshing and platform.
  - **6. Strategic:** multi-phase bets that gate other items or reopen Non-goals.
- **Each item carries an area tag** — *Geometry*, *Meshing*, *Formats*, *Drawings*, *Parity*, *Platform* or *Ecosystem* — so the file can be read by area as well as by tier.
- **A closed item is removed from this list entirely**, not struck through — its write-up moves to `CLAUDE.md` (a per-feature section with the verified implementation details) and its history stays in git. **Every item has a task ID `S.N`** (section, then position within it — `1.1`, `2.3`, `4.10`), shown in its heading and in the order tables, so a task can be named in an issue, a commit or a conversation. **IDs are renumbered at each planning review**, when items close and sections shift, so an ID is only meaningful against the review date at the top of this page. Code and other documents therefore still cite an item by **name** (the `docRoadmapRefs` gate enforces this), and headings keep an explicit `{#anchor}` so name-based links survive the numbering.
- **Probe-gated items are hypotheses, not implementation-ready work.** Evidence may be a binding-manifest entry, an upstream API, or a proposed geometric construction. Green in `node_modules/opencascade.js/dist/Supported APIs.md` is **necessary but not sufficient** — both the STEP-unit and the IGES-writer findings started green and only resolved (one negative, one positive) under a real probe, and `HLRAppli_ReflectLines` was green, functional, *and still the wrong tool*. Each probe carries a firm **S** estimate of its own; the implementation phases listed under an item's *If admitted* are conditional, tagged provisionally, and re-estimated once the probe establishes useful output, failure behaviour and cost.
- **Non-goals are not one thing.** They are split into three groups below because each has a different revival rule, and each group says plainly **what would change our mind**. A rejection nobody re-checks is how a capability stays "permanently out of reach" long after it stopped being — four entries in this file were found stale exactly that way.
- **An item that corresponds to a known GitHub issue names it inline.** The issue is the request and discussion thread; this file is the proposed scope. Reconcile disagreements against current code and the issue before implementation; neither document automatically overrides a newer decision.
- **Cite by feature name and heading link from outside this file; use the task ID inside it.** Each candidate states its first useful increment, dependencies or decisions, and evidence needed to close it. New features belong here only when they have a concrete user workflow and an observable completion criterion.
- **Shared capabilities must reach both consumers.** A new headless-capable operation includes MCP schemas/capabilities and sidecar compatibility; a purely visual interaction can remain webview-only. Reuse the existing pipeline and registries rather than adding parallel implementations.
- **Cross-repo items say which repository owns each half.** Several items below exist because KKSS (which embeds this repository as its `cad/` submodule) or VSCode-MDPA-Preview asked for them. Only this repository's half is scoped here; the other half is named so that it is not forgotten.

Several past items were identified by comparing against [SketchForge-3D](https://github.com/Formsmith746/SketchForge-3D), a browser-based direct-manipulation CAD editor over the same OCCT kernel, and [FluidCAD](https://github.com/nkarasiak/fluidcad). Their *capability* gaps transferred well; most of their *interaction* model deliberately did not — see Non-goals.

## Reviews

Dated reviews that produced the items below. A review stays here while any item it produced is still open; once all of its items have closed, it shrinks to a pointer.

### Magnusim review — 2026-09-21

Closed. All four transferable gaps it found have shipped: narrow-passage preflight (`analyze_passages`), the mesh size and memory budget preview (`estimate_mesh_budget`), the CAD-to-mesh deviation map (`measure_mesh_deviation`) and mesh-aware tessellation export (`export_tessellated_stl`). The review of [Magnusim](https://github.com/Lilmill2000/Magnusim) at `af8d059`, and the implementation details of each feature, are in `CLAUDE.md`.

### Meshing library review — 2026-09-24 {#meshing-library-review}

Meshing today is *generate* (Gmsh, fTetWild) plus *repair* (fTetWild, meshio++ ops). Nothing here remeshes an existing FE mesh: coarsening/refining it under a geometric error bound, improving element quality in place, or adapting it to a field. This review covers the libraries that could fill that gap, with the licence of each. It also covers capabilities that are already in the bundled binaries but have never been called.

The MMG evidence comes from the sibling project [VSCode-MDPA-Preview](https://github.com/loumalouomega/VSCode-MDPA-Preview). It has shipped remeshing through [`@loumalouomega/mmg-wasm`](https://github.com/loumalouomega/MMG-WASM) 0.1.0: MMG 5.8.0, one ~1.1 MB `mmg-core.wasm` holding mmg2d, mmgs and mmg3d, with dual ESM/CJS builds and no pthreads. That is a working product elsewhere, not evidence in *this* pipeline — the kernel worker, IPC marshalling, Parts correlation and stdout purity are all untested here. That is why the MMG items below are probe-gated rather than ready product work (section 2).

**Licence decision, recorded:** MMG is LGPL-3.0-or-later, which is directly compatible with CAD-Preview's own `GPL-3.0-or-later` (relicensed from `GPL-2.0-or-later` on 2026-09-24 for the [OpenSCAD WASM port](#build-and-bundle-an-openscad-wasm-port) — see the README's "Licensing" section). We accept the dependency. It will ship the way meshio++ and fTetWild do: an `external` package loaded from its own `.wasm` file (separately replaceable, as LGPL §4 expects), a `.vscodeignore` carve-out, and its own README "Licensing" attribution.

| Library / capability | Licence | In the VSIX today? | What it adds | Outcome |
| --- | --- | --- | --- | --- |
| MMG — mmg3d / mmgs / mmg2d (`@loumalouomega/mmg-wasm`) | LGPL-3.0-or-later | No | Remeshing and optimisation of an existing tet or surface mesh under a Hausdorff bound (`hausd`/`hmin`/`hmax`/`hgrad`); scalar and tensor metrics; per-reference local sizes; frozen entities; level-set discretisation | [MMG remeshing of FE meshes](#mmg-remeshing-of-fe-meshes), [Hausdorff-bounded surface coarsening](#hausdorff-bounded-surface-coarsening-for-the-heal-ceiling), [Metric-driven adaptive remeshing](#metric-driven-adaptive-remeshing-from-a-field) |
| meshio++ 16.7.0 surface `remesh` (clustering), `estimateError` (ZZ), `interpolate` / `conservativeInterpolate`, `sampleDistance` | MIT | Yes, never called | A licence-free surface remesher to measure MMG against; an error estimator to drive adaptation; mass-preserving field transfer across a remesh | Baseline in the coarsening probe; the field-transfer half of adaptive remeshing |
| Gmsh `mesh.optimize` (`"Netgen"`, `"HighOrder"`, `"HighOrderElastic"`, …) | GPL-2.0-or-later (Netgen linked in) | Yes, never called | Quality optimisation after generate; untangling curved quadratic elements | [Gmsh mesh optimisation](#gmsh-mesh-optimisation-netgen-and-high-order) |
| Gmsh `setTransfiniteCurve/Surface/Volume/Automatic` + `setRecombine` | GPL-2.0-or-later | Yes, never called | Structured, mapped hex/quad meshes on regular regions | [Structured meshing per Part](#structured-transfinite-meshing-per-part) |
| Gmsh `setSizeCallback` | GPL-2.0-or-later | Declared green in 0.3.0, never called | Sizing from a JS function, e.g. a sampled deviation or error field | [JS mesh-size callback](#js-mesh-size-callback) |
| Gmsh `partition` / `unpartition` (METIS linked in) | GPL-2.0-or-later | Yes, never called | Domain decomposition for distributed solvers | [METIS partitioning for Kratos MPI export](#metis-partitioning-for-kratos-mpi-export) |
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

### Kernel capability review — 2026-09-24 {#kernel-capability-review}

This review lists every capability that is **bound in a shipped kernel but never called** from `src/`, and asks which of them would serve a real workflow. "Bound" means green in the OCCT manifest (`node_modules/opencascade.js/dist/Supported APIs.md`), or declared in gmsh-wasm's `dist/gmsh.d.ts`. That is necessary but not sufficient. The following have been proven broken despite being green, and should not be re-probed:

| Proven broken despite being green | What happened | Recorded in |
| --- | --- | --- |
| `ShapeFix_Shape`, `ShapeFix_Shell`, `ShapeFix_Wireframe` | Only `ShapeFix_Solid` works | `src/meshHeal.ts` |
| `BRepAlgoAPI_Section` | No accessible constructor | `src/occtOperations.ts` |
| `BRepExtrema_DistanceSS` in maximum mode | Constructs, but never computes | `src/entityFacts.ts` (`measureExact`) |
| `BRepOffsetAPI_DraftAngle.Build()` | Throws on real geometry | `src/occtOperations.ts` (`draftFaces`) |

**The OCCT build is old.** The installed `opencascade.js` 1.1.1 references OCCT `V7_4_0`. Its 2.0 beta dates from 2023 and has seen no release since. The bundled gmsh-wasm 0.3.0 statically links OCC 7.8.1 (its `General.BuildInfo`). So one extension carries two OCCT versions three minor releases apart, and the kernel-blocked Non-goals below are blocked by the older one. The [self-built OCCT WASM](#self-built-occt-wasm) strategic item addresses this.

**OCCT: bound, never called, and worth a probe.**

| Classes | Would enable | Item |
| --- | --- | --- |
| `BRepFeat_SplitShape`, `BRepAlgoAPI_Splitter` | Imprinting a curve or plane onto a face, so a Part can target a sub-region for a boundary condition | [Imprint and split faces](#imprint-and-split-faces-for-boundary-condition-regions) |
| `ShapeFix_Face`, `ShapeFix_Wire`, `ShapeFix_FixSmallFace`, `ShapeFix_FixSmallSolid` | An explicit repair step after `check_brep_health` | [B-rep repair as an explicit op](#b-rep-repair-as-an-explicit-op) |
| `BRepExtrema_SelfIntersection`, `ShapeAnalysis_FreeBounds` | Self-intersection and free-boundary facts in the validity report | [More facts in the B-rep validity report](#more-facts-in-the-b-rep-validity-report) |
| `BRepOffsetAPI_MakeFilling` | An N-sided, non-planar surface from boundary edges | [N-sided surface filling](#n-sided-surface-filling) |
| `ChFi2d_FilletAPI`, `ChFi2d_ChamferAPI` | Rounding and chamfering sketch-profile corners before extrusion | [Fillets and chamfers on 2D profiles](#fillets-and-chamfers-on-2d-profiles) |
| `BRepProj_Projection` | Projecting a curve onto a face | [Project a curve onto a face](#project-a-curve-onto-a-face) |
| `STEPCAFControl_GDTProperty`, `XCAFDoc_DimTolTool`, `XCAFDoc_LayerTool`, `XCAFDoc_MaterialTool`, `XCAFPrs_DocumentExplorer` | Reading STEP AP242 PMI, layers and materials, plus a second route to colours that bypasses the dead `XCAFDoc_ColorTool` getter | [Read PMI, layers and materials from STEP](#read-pmi-layers-and-materials-from-step) |
| `VrmlAPI_Writer` | B-rep → VRML export, the one extra B-rep writer in the binding | [VRML export](#vrml-export) |

**Gmsh: declared, never called, and worth a probe.** The table below is for `model.occ` and `model.mesh`. Two more parts of the binding are unused:

- **`plugin.run` and `onelab`:** unused. There is no `view.*` namespace in this binding, so a plugin's output could only be reached through a written `.pos` file.
- **`model.occ.*` modelling calls** (`fuse`, `fillet`, …): deliberately unused, since OCCT owns modelling here.

| Calls | Would enable | Item |
| --- | --- | --- |
| `model.occ.fragment` | Conformal meshes across touching solids (shared interface nodes) | [Conformal multi-body meshing](#conformal-multi-body-meshing) |
| `model.mesh.setCompound` | Meshing across the sliver faces and patch seams of dirty STEP files as if they were one face | [Compound meshing across sliver faces](#compound-meshing-across-sliver-faces) |
| `model.occ.healShapes`, `model.occ.removeAllDuplicates` | An optional healing pass before meshing | [Pre-mesh healing](#pre-mesh-healing) |
| `model.mesh.embed` | Forcing mesh nodes at load or sensor points, or along a curve inside a face | [Embedded points and curves](#embedded-points-and-curves) |
| `model.mesh.setPeriodic` | Periodic meshes for representative-volume-element studies | [Periodic meshing](#periodic-meshing) |
| `model.mesh.getJacobians` | Jacobian-based validity for curved (order 2) elements, which `minSICN` alone does not certify | [Jacobian validity for high-order meshes](#jacobian-validity-for-high-order-meshes) |

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
| A meshio++ loader with a directory fallback, and fTetWild staged into `dist/` behind a CJS-safe loader. KKSS works around both today with its own `cadMeshioLoader.ts` and `cadFtetwildLoader.ts`. | KKSS `CLAUDE.md` | [Upstream the packaging workarounds KKSS carries](#upstream-the-packaging-workarounds-kkss-carries) |
| Every new capability reachable through this repository's MCP server, since that is the only way the KKSS assistant sees it | KKSS roadmap | Already a house rule ("Shared capabilities must reach both consumers" above) |
| A small, reproducible structural example that a geometry-to-results tutorial can reuse | KKSS roadmap | [Canonical worked example](#canonical-worked-example-for-the-simulation-tutorial) |
| Performance baselines covering more than the OCCT and Gmsh paths | KKSS roadmap | [Perf harness coverage](#perf-harness-coverage-for-meshio-and-openscad-loads) |
| One UI vocabulary across both extensions: view snaps 1–6 and `i` proposed for upstreaming, and "Cut Plane" / "REAR" renames pending | VSCode-MDPA-Preview `doc/ui-design-system.md` | [Shared UI design system](#shared-ui-design-system-with-vscode-mdpa-preview) |
| A scheduled job that compares dependency pins with npm | VSCode-MDPA-Preview roadmap | [Dependency currency](#dependency-currency) |
| Consume CAD's mesh handoff manifest | VSCode-MDPA-Preview roadmap | Already shipped on this side (`export_mesh {manifest: true}`); the consuming half is theirs |

Two stale lines found in the sibling repositories are theirs to fix, not ours:

- **KKSS roadmap:** it lists the Magnusim preflight items as pending, but they shipped.
- **VSCode-MDPA-Preview's `doc/ui-design-system.md`:** it still describes this repository as `GPL-2.0-or-later`.

The only open GitHub issue, #35 "OpenSCAD", is covered by the [OpenSCAD WASM port](#build-and-bundle-an-openscad-wasm-port).

### What the GPL-3.0 relicense unlocks {#relicense-unlocks}

CAD-Preview moved from `GPL-2.0-or-later` to `GPL-3.0-or-later` on 2026-09-24. Besides the OpenSCAD port it was made for, this admits Apache-2.0 dependencies: under GPLv2 they were incompatible, and under GPLv3 they are compatible. Two of them serve open items directly:

| Dependency | Licence | Use | Item |
| --- | --- | --- | --- |
| [`manifold-3d`](https://www.npmjs.com/package/manifold-3d) 3.5.3 | Apache-2.0 | Mesh booleans whose output is guaranteed manifold, unlike `three-bvh-csg`'s | [Manifold mesh booleans](#manifold-mesh-booleans) |
| [`draco3d`](https://www.npmjs.com/package/draco3d) 1.5.7 | Apache-2.0 | Decoding Draco-compressed glTF host-side, which `gltfParser.ts` rejects today | [Mesh display fidelity](#mesh-display-fidelity-obj-materials-ply-colours-compressed-gltf) |

It does **not** admit AGPL code, so TetGen stays rejected. Every new bundled dependency still gets the licence check the Definition of done asks for.

## Open items

### Suggested implementation sequence

| Wave | Outcome | Start with | Exit signal |
| --- | --- | --- | --- |
| Upkeep | The base stays current and trustworthy | Dependency currency (1.1), then the KKSS packaging workarounds (1.2) | Both 1.1 and 1.2 done; the verification debt count has started falling |
| Parity | Everything an agent can do, a user can do, and the reverse | Headless mesh-edit replay, 2.1 (the hole-table, refinement-sweep, free-text-note and mesh-source FE-export gaps are closed) | Headless tools see the same edited mesh the viewer shows, or each remaining difference is justified |
| Meshing probes | Decide on remeshing and on conformal assemblies | The MMG core probe (4.1), then conformal multi-body meshing (4.2), then Gmsh optimisation (4.4) | Each probe filed with measured results and a decision |
| Geometry probes | Decide which never-called OCCT capabilities become ops | Imprint and split faces (3.1), then B-rep repair (3.2) | Each probe filed with measured results and a decision |
| Strategic | Remove the kernel ceiling | The self-built OCCT WASM probe (6.1) | The existing test suites pass unchanged against the new build |

These are outcome groupings, not release numbers. Independent small items can ship between waves; a failed probe must not block unrelated work.

### 1. Upkeep and defects {#tier-0-—-upkeep-and-defects}

*Admission: the work is known and has no design question. These items keep the base current, honest and cheap to verify; they rank first because every other item depends on them.*

#### 1.1 Dependency currency {#dependency-currency}

*Area: Platform.*

- **Evidence:**
  - Two pins trail npm: `@meshioplusplus/wasm` is at 16.7.0 against 16.9.0, and `@modelcontextprotocol/sdk` at 1.30.0 against 1.30.1.
  - Every other runtime dependency is current.
  - meshio++ bumps are known to carry silent-failure risk: the 10.21 → 16.7 bump found integer arrays arriving as `BigInt64Array` and an upstream metadata regression, both documented in `CLAUDE.md`.
  - VSCode-MDPA-Preview already runs a scheduled CI job that compares its pins against npm.
- **First useful increment (S):**
  - Bump both packages.
  - Re-run the meshio++ checklist from `CLAUDE.md`:
    - the loader invariants (no `exports` map, `{ variant: "seq" }` still load-bearing, stdio routing, `.vscodeignore` file list);
    - `LOSSY_METADATA_FORMATS`;
    - `npm run compat`, `npm run compat:vsix` and `npm run mcp:smoke`.
  - Add a weekly workflow that runs `npm outdated` for the WASM kernels plus `three` and the MCP SDK, and opens an issue when a pin trails.
- **Done when:** both bumps land with the checklist recorded in `CLAUDE.md`, and the scheduled job has opened (or had nothing to open) at least once.

#### 1.2 Upstream the packaging workarounds KKSS carries {#upstream-the-packaging-workarounds-kkss-carries}

*Area: Ecosystem.*

- **Evidence:** KKSS's `CLAUDE.md` records three places where this repository's build does not survive being embedded:
  - `meshioService.ts` does a bare `await import("@meshioplusplus/wasm")` with no fallback, so a packaged app without `node_modules` fails. KKSS ships `cadMeshioLoader.ts` to work around it.
  - fTetWild is not staged into `dist/`.
  - fTetWild's ESM with top-level await breaks CJS consumers. KKSS ships `cadFtetwildLoader.ts` for this and the previous point.
- **First useful increment (S):**
  - Give `getMeshio()` and `getFtetwild()` an ordered list of locations: package resolution first, then a directory next to the bundle.
  - Stage both packages under `dist/` in `esbuild.mjs` the way the OCCT and Gmsh binaries already are.
  - Extend `scripts/compat/vsix-check.mjs` so the staged files are required.
- **Done when:** KKSS can delete both loader shims after a submodule bump, and `npm run compat:vsix` passes.

#### 1.3 Verification-debt burn-down {#verification-debt-burn-down}

*Area: Platform.*

- **Evidence:**
  - `CLAUDE.md` marks about forty features "Verification gap, stated plainly" or "F5-only": exercised only by hand in an Extension Development Host, if at all.
  - Several of them touch the source-write path (save-in-place, revert, hot-exit restore), where a regression costs user data.
  - Both automated harnesses exist and already cover similar ground: `npm run test:webview` drives the real viewer bundle, and `npm run test:integration` drives a real VS Code.
- **First useful increment (M):** move the ten highest-risk features into those harnesses:
  - save-in-place and revert for B-rep and mesh sources;
  - the transform gizmo;
  - the live operation preview;
  - the drawing-sheet settings form;
  - the Clash, Primitives and Mesh-ops panels;
  - the join between mesh-target export and the save dialog;
  - SVG and DXF import.

  Then add a check to `npm test` that counts the "Verification gap" notes in `CLAUDE.md` and fails when the count rises without a matching entry in a small allowlist file that states why.
- **Done when:** the count has fallen by ten, and a new unverified feature cannot land silently.

#### 1.4 Perf harness coverage for meshio and OpenSCAD loads {#perf-harness-coverage-for-meshio-and-openscad-loads}

*Area: Platform.*

- **Evidence:** `npm run perf` benchmarks only the B-rep load and Gmsh mesh paths (`scripts/perf/baseline.json`). The meshio++ load path and the `.csg` path are unmeasured, so a regression in either would only surface as a user report. KKSS's roadmap points at this harness as its model.
- **First useful increment (S):**
  - Add one meshio++ fixture (`examples/MED/two-region-hexes.med`) and one OpenSCAD fixture (`examples/OpenSCAD/bracket.csg`) to the benchmark list.
  - Capture their baselines with `--update-baseline` in a reviewed change.
- **Done when:** both appear in `baseline.json`, and a deliberately slowed build flags them.

### 2. Ready product work {#tier-1-—-ready-product-work}

*Admission: no kernel unknown remains. Either a probe passed and its call shapes are in `CLAUDE.md`, or the work only reuses shipped machinery. The estimate is firm.*

#### 2.1 Headless mesh-edit replay {#headless-mesh-edit-replay}

*Area: Parity.*

- **Evidence:**
  - Mesh edits (transforms, booleans, holes, primitives, patterns) replay only in the webview, because `src/webview/meshEdits.ts` runs on Three.js objects. As a result, headless `generate_mesh`, `export_mesh`, `compare_models` and `save_model` all see the raw file, not the edited model, and each warns about it.
  - `meshEdits.ts` has no DOM dependency: `meshEdits.test.ts` already runs it under Node, `three-bvh-csg` included.
  - The host already parses all four mesh formats into triangles (`parseToWeldedMesh`).
- **First useful increment (M):**
  - Build a Three.js scene from the host-side parse.
  - Run `applyEditsMesh` in the kernel worker, behind a new `Pipeline` key.
  - Serialise the result with the same exporters the webview uses, which still need the `requestAnimationFrame` polyfill `meshExporters.test.ts` applies.
  - Use that bake in `generate_mesh`, `export_mesh`, `compare_models` and a mesh-source `save_model`.
  - glTF needs the `ProgressEvent` polyfill the glTF cross-validation test already uses.
- **Done when:** an edited STL meshes headlessly with its edit applied (a translated cube's mesh bbox moves), and `save_model` accepts STL/OBJ/PLY sources.

#### 2.2 Post geometry before the XCAF assembly tree {#post-geometry-before-the-xcaf-assembly-tree}

*Area: Platform.*

- **Evidence:** reading a STEP file's assembly structure is a second full parse (`src/xcafTree.ts`), and it roughly doubled STEP load time — `turbine.stp` went from about 7.0 s to 13.6 s in `npm run perf`. The tree only feeds the Components panel, yet today the geometry waits for it.
- **First useful increment (S–M):**
  - Split the load so the geometry message goes out as soon as tessellation finishes. The tree follows in a second message when the XCAF parse completes.
  - The Components panel shows the flat solid list until then, which is exactly what it shows when correlation fails today.
  - Base-shape caching is unaffected: the tree cache already lives beside the base shape.
- **Done when:** first geometry on `turbine.stp` arrives at roughly the pre-XCAF time, the tree still arrives, and `npm run perf` records both numbers.

#### 2.3 Tessellation quality for `render_snapshot` {#tessellation-quality-for-render-snapshot}

*Area: Parity.*

- **Evidence:** the `cadPreview.tessellationQuality` setting reaches the viewer but not the headless renderer. `CLAUDE.md` names this a future item. `loadBRep` already takes a quality argument.
- **First useful increment (S):** add an optional `quality` (`draft` / `standard` / `fine`) to `render_snapshot`, `screenshot_shape` and `render_ops_prefix`, defaulting to today's behaviour.
- **Done when:** a `fine` render of a curved part has visibly more triangles in the picture, and omitting the parameter changes nothing.

#### 2.4 Cancel a mesh refinement sweep mid-run {#cancel-a-mesh-refinement-sweep-mid-run}

*Area: Meshing.*

- **Evidence:**
  - `compare_mesh_refinement` runs up to eight sequential meshes, and `CLAUDE.md` records that it cannot be cancelled mid-sweep.
  - Document-scoped jobs have since given every MCP request an owner and an abort signal (`jobScope` in `mcpServer.ts`), so the building block now exists.
- **First useful increment (S):**
  - Check the signal between runs, and pass it to each run's kernel call.
  - A cancelled sweep returns the completed rows with `cancelled: true`, never a partial row presented as complete.
- **Done when:** cancelling after the first run returns exactly one row and leaves no kernel work queued.

#### 2.5 Mesh display fidelity: OBJ materials, PLY colours, compressed glTF {#mesh-display-fidelity-obj-materials-ply-colours-compressed-gltf}

*Area: Formats.*

- **Evidence:** `doc/file-formats.md` and the Known limitations list record three gaps.
  - **OBJ:** loads without its `.mtl` materials.
  - **PLY:** loads without its vertex colours.
  - **Compressed glTF:** a glTF that requires Draco or meshopt compression is refused host-side by `gltfParser.ts`. It also has no decoder in the webview.
  - **What's already there:** three ships `MTLLoader` and `DRACOLoader`. `PLYLoader` already produces a colour attribute, which the viewer ignores. `draco3d` is Apache-2.0 and now licence-compatible (see [What the GPL-3.0 relicense unlocks](#relicense-unlocks)).
- **First useful increment:**
  - **OBJ materials (S):** load `.mtl` through `asWebviewUri`, with the same sibling-file rule glTF external buffers already follow.
  - **PLY colours (S):** render the colour attribute when it is present.
  - **Compressed glTF (M):**
    - Serve the Draco decoder files from `dist/` under the existing CSP.
    - Decode host-side with `draco3d`, so Compare Models, Mesh Health and Promote accept the file too. `meshopt` follows the same pattern.
- **Done when:** each has a committed fixture that renders correctly in `test:webview`, and the compressed fixture passes `check_mesh_health`.

#### 2.6 More mesh formats through three's bundled loaders {#more-mesh-formats-through-three-s-bundled-loaders}

*Area: Formats.*

- **Evidence:**
  - three already ships loaders the viewer never uses: `3MFLoader`, `AMFLoader`, `VRMLLoader`, `ColladaLoader`, `FBXLoader` and `USDZLoader`.
  - 3MF is the standard 3D-printing format and is the most asked-for of these. Its loader's one dependency, `fflate`, is already bundled.
  - `three-3mf-exporter` (MIT) writes it.
- **First useful increment (S–M):**
  - Route `.3mf` as a mesh source (router, `customEditors` selector, open-dialog filter). Add it as an Export target through `three-3mf-exporter`.
  - The other five loaders follow one at a time, each with a fixture.
  - Every new format states its host-side status plainly: display-only unless a host parser is added. Compare Models, Mesh Health and headless meshing refuse it by name, the way meshio-only formats are refused today.
- **Done when:** a committed `.3mf` fixture opens, edits, exports back to `.3mf`, and reopens with the same triangle count.

#### 2.7 Shared UI design system with VSCode-MDPA-Preview {#shared-ui-design-system-with-vscode-mdpa-preview}

*Area: Ecosystem.*

- **Evidence:**
  - VSCode-MDPA-Preview's `doc/ui-design-system.md` maps both extensions' vocabularies.
  - It proposes upstreaming its view snaps (keys 1–6 for the six faces, `i` for isometric) into this repository.
  - It leaves two renames pending: Clip → "Cut Plane", and the orientation cube's BACK → "REAR".
  - This repository's chrome passes already use `--ui-*` metric tokens beside the theme colours, which is the part both extensions could share.
- **First useful increment (M):**
  - Adopt the view snaps. They go through the existing named-view vocabulary in `viewDirections.ts`, so they need no new camera code.
  - Decide the two renames with the maintainer of both repositories, and apply the decision here.
  - Add a drift-check script that compares the shared token block and icon names between the two repositories and prints the differences.
- **Done when:** the snaps work in both extensions, the renames are settled, and the drift check runs in this repository's CI.
- **Other repository's half:** the matching change in VSCode-MDPA-Preview, and its stale licence line.

#### 2.8 Canonical worked example for the simulation tutorial {#canonical-worked-example-for-the-simulation-tutorial}

*Area: Ecosystem.*

- **Evidence:**
  - KKSS's roadmap plans a geometry-to-results tutorial built around one small, reproducible structural example. It wants to reuse a fixture from this repository rather than invent geometry.
  - This repository's own tutorials (`doc/tutorials/`) are executable: `npm test` compiles their op lists, and `mcp:smoke` pins the bracket tutorial.
- **First useful increment (S):**
  - A cantilever-beam tutorial: a box, a fixed-end Part, a loaded-face Part, a mesh preset, and an MDPA export with a handoff manifest.
  - Pin it in `mcp:smoke` with analytic volume and exact Part membership, like the bracket tutorial.
- **Done when:** the page builds, its op list compiles under `npm test`, and the exported MDPA opens in VSCode-MDPA-Preview with both SubModelParts populated.

#### 2.9 Unify same-domain faces as an edit op {#unify-same-domain-faces-as-an-edit-op}

*Area: Geometry.*

- **Evidence (probed with the B-rep validity report, opencascade.js 1.1.1):** `new oc.ShapeUpgrade_UnifySameDomain_2(shape, true, true, false)` → `Build()` → `Shape()` merged two fused 10 mm boxes from 10 faces / 20 edges to 6 / 12 with the volume unchanged (2000.0000000000005 both sides); on a box with one fillet it correctly changed nothing (7 faces before and after, volume 997.853981147513 both sides). `_1()` + `Initialize(shape, true, true, false)` is the fallback form.
- **First useful increment (M):** a `unifySameDomain` edit op — B-rep only, topology-changing (every downstream `face-N`/`edge-N` renumbers, so Parts and annotations go through the existing rebind), explicit and undoable, never an automatic consequence of a failed `check_brep_health`. Needs a panel button, which means a TikZ icon through the `icons/` pipeline (`pdflatex` + `pdftocairo`), an `OP_PARAM_DOCS` entry, the generic `produced` bucket role, and a `mcp:smoke` assertion on the fused-box face count and volume.
- **Done when:** the fused-box fixture drops 10 → 6 faces through `apply_edit_ops` at an unchanged volume, and a Part on one of the merged faces is rebound or reported dropped, never silently repointed.

### Probe-gated — establish feasibility before estimating

*Admission: a specific hypothesis with a discriminating experiment. Each probe below is a small, self-contained piece of work with a firm **S** estimate of its own; the phases under "If admitted" are what ships if the probe passes, tagged provisionally. A method that accepts arguments but changes nothing is a failed probe.*

**Probe protocol.** Every probe write-up records:

- **Installed artifact versions.** At the time of writing: `opencascade.js` 1.1.1, `@loumalouomega/gmsh-wasm` 0.3.0 and `@meshioplusplus/wasm` 16.7.0; the MMG probes install `@loumalouomega/mmg-wasm` 0.1.0 first.
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
| 3.1 | Imprint and split faces for boundary-condition regions | — | Highest FE value: today a boundary condition can only target a whole face |
| 3.2 | B-rep repair as an explicit op | the shipped validity report | Turns `check_brep_health`'s findings into something the user can act on |
| 3.3 | More facts in the B-rep validity report | — | Cheap, read-only, and it sharpens the repair probe's before/after |
| 3.4 | Open-profile surface output | — | Exercises the free-face invariant every `face-N` operand depends on; structurally cheap |
| 3.5 | N-sided surface filling | — | Closes the gap `addSurfaceFromLines` leaves for non-planar boundaries |
| 3.6 | Read PMI, layers and materials from STEP | — | May also reopen colours through a different API than the dead one |
| 3.7 | Fillets and chamfers on 2D profiles | — | Small, self-contained, and it removes a common reason to hand-edit profiles |
| 3.8 | Small-detail edge suppression | screenshot pipeline | Webview-side and independent; the risk is judgement, not bindings |
| 3.9 | Project a curve onto a face | — | Useful mostly as an input to other features |
| 3.10 | Loft takeoff by resampled intermediates | — | The measurement design is the hard part |
| 3.11 | VRML export | — | Cheap but low value; last on purpose |

None of these depends on another's result.

##### 3.1 Imprint and split faces for boundary-condition regions {#imprint-and-split-faces-for-boundary-condition-regions}

*Area: Geometry.*

- **Hypothesis:** `BRepFeat_SplitShape` or `BRepAlgoAPI_Splitter` (both green, never called) can split one face of a solid along a curve or plane. The result is a solid with more faces and the same volume, and each new face is an ordinary `face-N` that a Part can target.
- **Evidence today:**
  - A boundary condition applies to a whole face. The only ways to address part of a face are to remodel it, or to use `splitByPlane`, which cuts the solid into pieces rather than the face into regions.
  - Gmsh physical groups follow faces, so the face split carries through to the FE mesh with no meshing change.
  - `BRepAlgoAPI_Section` is recorded as broken, so the splitting tool itself has to come from edges or a plane face, not from a section result.
- **Probe (S):**
  1. On `examples/STP/block.stp`, split the top face with a line across its middle through `BRepFeat_SplitShape`: `Add(edge, face)`, then `Build()`.
  2. Assert that the face count rises by exactly one and the volume is unchanged to 1e-9, and that the two new faces' areas sum to the original.
  3. Repeat with `BRepAlgoAPI_Splitter` using a plane face as the tool, and compare.
  4. Generate a mesh with a Part on one half. Assert that its physical group holds only that half's triangles.
- **Decision gate:**
  - **Pass:** exact areas, and a working physical group.
  - **Fail:** both classes throw or split nothing → Kernel-blocked, with the calls recorded.
- **If admitted (M):**
  - A `splitFace` edit op (B-rep only, topology-changing, `face-N` renumbering handled by the existing rebind), taking a face and either edges or a plane.
  - A panel form, an `OP_PARAM_DOCS` entry, and a TikZ icon.
- **Out of scope:** imprinting one solid's footprint onto another; that is a boolean-family feature.

##### 3.2 B-rep repair as an explicit op {#b-rep-repair-as-an-explicit-op}

*Area: Geometry.*

- **Hypothesis:** of the `ShapeFix_*` family, `ShapeFix_Face`, `ShapeFix_Wire`, `ShapeFix_FixSmallFace` and `ShapeFix_FixSmallSolid` (green, never called) fix the problems `check_brep_health` reports on real fixtures. They do this without the failures recorded for `ShapeFix_Shape` / `Shell` / `Wireframe`.
- **Evidence today:**
  - `check_brep_health` reports facts and repairs nothing.
  - On `examples/STP/daratech.stp` it names five faces flagged `UnorientableShape`; `examples/STP/piston.stp` is seven open shells with 48 open-boundary edges.
  - Only `ShapeFix_Solid` is known to work.
- **Probe (S):**
  1. Apply `ShapeFix_Face` to each of daratech's five flagged faces, then re-run the validity report on the result. Record whether the five findings clear and whether the volume moves.
  2. Apply `ShapeFix_Wire` and `ShapeFix_FixSmallFace` to piston's shells, and report the open-edge count before and after.
  3. Confirm that `bull.stp`, which is valid, comes out byte-identical through each fixer.
- **Decision gate:**
  - **Pass:** at least one fixer clears real findings without changing a valid shape.
  - **Fail:** no fixer changes anything, or valid shapes change → Kernel-blocked beside the existing `ShapeFix_*` note.
- **If admitted (M):**
  - A `repairBrep` edit op: explicit, undoable, never automatic.
  - A **Repair** button in the B-rep Health panel that proposes it.
  - The report before and after, shown side by side.
- **Out of scope:** sewing an open shell into a solid; the mesh-to-B-rep promotion already covers the closable case.

##### 3.3 More facts in the B-rep validity report {#more-facts-in-the-b-rep-validity-report}

*Area: Geometry.*

- **Hypothesis:** `BRepExtrema_SelfIntersection` detects self-intersecting faces, and `ShapeAnalysis_FreeBounds` returns open boundaries as closed or open wires. Both are green and never called, and both can join `check_brep_health`'s report as facts.
- **Evidence today:** the report detects open-boundary edges (through `ShapeAnalysis_Shell`), but not their grouping into holes, and it cannot see self-intersection at all.
- **Probe (S):**
  1. Build a deliberately self-intersecting solid by translating one face of a box through the opposite face. Confirm `BRepExtrema_SelfIntersection` reports the overlapping face pair, and that a clean box reports none.
  2. On `piston.stp`, confirm `ShapeAnalysis_FreeBounds` groups the 48 open edges into closed wires (holes), and report their count and lengths.
  3. Record timing on `turbine.stp`, since the report is already about 9 s there.
- **Decision gate:**
  - **Pass:** correct detections, and timing acceptable for an explicit action.
  - **Fail:** no detection, or runaway time → recorded, with the report unchanged.
- **If admitted (S):** two more fact fields in `check_brep_health` and the panel. Self-intersection is opt-in if timing demands it.

##### 3.4 Open-profile surface output {#open-profile-surface-output}

*Area: Geometry.*

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

##### 3.5 N-sided surface filling {#n-sided-surface-filling}

*Area: Geometry.*

- **Hypothesis:** `BRepOffsetAPI_MakeFilling` (green, never called) builds a smooth, non-planar face bounded by three or more picked edges.
- **Evidence today:**
  - `addSurfaceFromLines` builds planar faces only, and refuses non-coplanar loops by name.
  - Closing a curved gap, or skinning between existing edges, has no op today.
- **Probe (S):**
  1. Fill a four-edge boundary taken from a cylinder's side, and check the face lies on the cylinder to a stated tolerance by sampling points.
  2. Fill a three-edge non-planar triangle.
  3. Confirm the new face can be sewn to the neighbouring faces into a closed shell, so `addVolumeFromSurfaces` can use it.
- **Decision gate:**
  - **Pass:** faces within tolerance that sew closed.
  - **Fail:** no face, or no closure.
- **If admitted (M):** an `addSurfaceFilling` op beside `addSurfaceFromLines`, taking edge ids, with a guide-aware refusal like the other profile-building ops.

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

##### 3.7 Fillets and chamfers on 2D profiles {#fillets-and-chamfers-on-2d-profiles}

*Area: Geometry.*

- **Hypothesis:** `ChFi2d_FilletAPI` and `ChFi2d_ChamferAPI` (green, never called) round or chamfer the corners of a planar wire, so a profile can be rounded before it is extruded.
- **Evidence today:** rounding a profile's corners is done today by filleting the extruded solid's edges afterwards. That costs an extra topology-changing op, and it is fragile once more features follow.
- **Probe (S):**
  1. Fillet one corner of a 10 × 6 rectangle profile at radius 1. Assert the area drops by exactly (1 − π/4).
  2. Chamfer one corner at 1, and assert the area drops by exactly 0.5.
  3. Confirm the result is still one closed wire that `extrude` accepts.
- **Decision gate:**
  - **Pass:** exact areas.
  - **Fail:** the calls are rejected.
- **If admitted (S–M):** an optional corner-radius or corner-chamfer field on the rectangle and polygon profile ops, plus a `filletProfile` op for arbitrary polylines.

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

##### 3.9 Project a curve onto a face {#project-a-curve-onto-a-face}

*Area: Geometry.*

- **Hypothesis:** `BRepProj_Projection` (green, never called) projects an edge or wire onto a face along a direction, giving edges that lie on that face.
- **Evidence today:** `wrap` develops a sketch onto a cylinder or cone. Placing a path on an arbitrary face, for engraving, a split line or a sweep path, has no op today.
- **Probe (S):**
  1. Project a straight line onto a sphere, and check every sampled point lies on the sphere to 1e-6.
  2. Project a circle onto a cylinder along its axis.
  3. Use the projected edges as the splitting tool in the [imprint and split faces](#imprint-and-split-faces-for-boundary-condition-regions) probe.
- **Decision gate:**
  - **Pass:** on-surface edges that the split probe accepts.
  - **Fail:** recorded.
- **If admitted (M):** a `projectCurve` op producing guide-able edges, most useful as input to the split-face op.

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
- **If admitted (S):** a VRML export target for B-rep sources. Low value, and ranked last for that reason: VRML is legacy, and glTF already covers display exchange.

#### 4. Meshing probes {#meshing-probes}

| ID | Item | Needs | Why here |
| --- | --- | --- | --- |
| 4.1 | MMG remeshing of FE meshes | `@loumalouomega/mmg-wasm` installed as a devDependency for the probe | Opens a whole capability class (remeshing), and two later rows reuse its loader |
| 4.2 | Conformal multi-body meshing | — | Assemblies are the common case for FE input, and the fix is already in the binary |
| 4.3 | Hausdorff-bounded surface coarsening | the MMG core loader; meshio++ already bundled | Fixes a known defect (a degenerate heal after auto-decimate), and may need no new dependency at all |
| 4.4 | Gmsh mesh optimisation | — | Already in the binary; cheap; directly improves every generated mesh |
| 4.5 | Compound meshing across sliver faces | — | Dirty STEP input is the norm; cheap once the conformal probe's walker exists |
| 4.6 | Manifold mesh booleans | `manifold-3d` installed for the probe | Replaces the one mesh operation that can produce non-manifold output |
| 4.7 | Jacobian validity for high-order meshes | — | Order-2 meshes ship today with no validity check beyond `minSICN` |
| 4.8 | Anisotropic boundary layers | a `$Elements` walker | The largest Gmsh probe, and the first live exercise of `dimension: 2` |
| 4.9 | Structured meshing per Part | the same `$Elements` walker | Exact element counts make the probe discriminating; shares the walker with 4.8 |
| 4.10 | Metric-driven adaptive remeshing | a passed MMG core probe | Depends on 4.1's result; highest value of the MMG items but the most moving parts |
| 4.11 | Embedded points and curves | — | Small; useful for load and sensor locations |
| 4.12 | Pre-mesh healing | — | Worth measuring against fTetWild before building any UI |
| 4.13 | Hex-dominant MDPA export | — | Closes a documented refusal; may end in Kernel-blocked |
| 4.14 | Periodic meshing | — | Niche (representative-volume-element studies) |
| 4.15 | JS mesh-size callback | — | Only needed if a sizing source outgrows Gmsh's declarative fields |
| 4.16 | METIS partitioning for Kratos MPI export | — | Lowest value; no user has asked for partitioned output yet |

Only 4.10 depends on another item's *result*: adaptive remeshing needs the MMG core probe (4.1) to pass. 4.3 still produces a result if MMG fails, because its meshio++ half stands alone.

##### 4.1 MMG remeshing of FE meshes {#mmg-remeshing-of-fe-meshes}

*Area: Meshing.*

- **Hypothesis:** `@loumalouomega/mmg-wasm` can load as a fifth lazy singleton inside `src/kernelWorker.ts` and remesh a tetrahedral or triangular mesh already in this pipeline, under a relative Hausdorff bound, with these guarantees:
  - named regions (our Parts) survive through MMG's per-cell references;
  - nothing reaches stdout;
  - a STRONGFAILURE resets the kernel instead of poisoning it.
- **Evidence today:**
  - **From VSCode-MDPA-Preview** (see the review above): MMG remeshing ships there, with all three modules, typed-array I/O, per-reference local parameters and frozen entities.
  - **Here:** the gap is real. `transform_mesh` offers clean/decimate/smooth/subdivide/refine, and `repair_mesh` offers fTetWild, but nothing remeshes to a target size or error bound. Refining with meshio++'s `refine` only splits elements; it never coarsens or relocates.
  - **Region bridge:** `convertToStlBoundaryWithRegions` and `buildPartsFromMeshioRegions` already turn meshio regions into `node-0/face-K` Parts. MMG references are the matching integer handle.
  - **Loading and packaging:** the kernel-worker `Pipeline` pattern (interface, dispatch, client, `kernelActivity` classification) and the `wrapXFault` / `resetX` / `isXWasmAbort` convention are ready to copy.
  - **What differs from meshio++:**
    - the package is dual ESM/CJS, so the CJS build must be aliased (`import.meta.url` is undefined in our CJS bundles, the same trap gmsh-wasm had);
    - it takes `wasmBinary`, so a copy into `dist/` works, unlike meshio++.
- **Probe (S):**
  1. **Load and stdout.** Load through a `getMmg()` singleton that passes `wasmBinary`, `print` and `printErr`. Run one remesh inside `npm run probe`, then again through a throwaway `dist/mcp-server.js` build. Assert zero bytes on fd 1 (the `mcp:smoke` stdout discipline).
  2. **Region survival (mmg3d).** Remesh `examples/MED/two-material-tets.med`:
     - `hausd` = 0.5 % of the bbox diagonal;
     - `hmax` = half the current mean edge;
     - pass the two material references as cell refs;
     - assert both references are present in the output;
     - assert every output tet lies inside the input's bbox;
     - assert total volume is conserved to 1e-6 relative (a remesh of a polyhedral domain must not change its volume beyond the Hausdorff budget).
  3. **Quality optimisation.** Run `optim` on the fTetWild output of `examples/STL/holed-cube.stl`. Compare minSICN before and after through Gmsh's `getElementQualities`, after `gmsh.merge()` of the result (the fTetWild hand-off route). It must not fall.
  4. **Surface (mmgs).** Coarsen `examples/STL/large-sphere-100k.stl` to `hausd` = 1e-2. Record the triangle count, and check that the maximum vertex-to-sphere distance stays within `hausd`.
  5. **Failures.**
     - Provoke a STRONGFAILURE: a multi-material map missing one reference. Assert a thrown error, a reset singleton, and a successful next call.
     - Assert an empty harvest is reported as an error.
  6. **Timing.** Record wall-clock timing for each step, and memory growth across 20 repeated remeshes.
- **Decision gate:**
  - **Pass:** all six steps hold.
  - **Fail on stdout or loading:** Kernel-blocked, with the failing call recorded.
  - **Partial (mmgs works, mmg3d does not, or the reverse):** keep the item, narrowed to the working module.
- **If admitted:**
  - **Phase 1 (M): a `remesh_mesh` MCP tool plus a **Remesh (MMG)** action in the FE Mesh panel's Mesh ops section**, for meshio sources and for a generated mesh.
    - **Options:** `hausd` (relative by default), `hmin`, `hmax`, `hgrad`, `optimOnly`.
    - **Result:** a new file, never the source (the `repair_mesh` precedent). Parts are carried through references.
    - **Point/cell data:** dropped with a warning until the adaptive item lands.
    - **Licence and packaging tasks:** the package stays in `WASM_EXTERNALS`; add a `.vscodeignore` carve-out; add a README "Licensing" paragraph stating LGPL-3.0-or-later and what that means for the combined work; add LICENSE attribution; `npm run compat:vsix` must list the new files.
  - **Phase 2 (M): an optional MMG optimisation pass after Generate** (Gmsh or fTetWild output). It is gated behind a `MeshOptions` field, so existing documents mesh byte-identically.
- **Out of scope:**
  - Lagrangian `move` (it needs MMG's elasticity library, which the WASM build lacks).
  - Hexahedral, pyramid and quadratic input (MMG rejects them; say so, rather than silently linearising).
  - ParMmg.

##### 4.2 Conformal multi-body meshing {#conformal-multi-body-meshing}

*Area: Meshing.*

- **Hypothesis:** calling `gmsh.model.occ.fragment` over every imported solid, before meshing, makes touching solids share interface nodes. Its returned map, from old `(dim, tag)` pairs to new ones, is enough to carry Part physical groups through the renumbering.
- **Evidence today:**
  - `loadGeometryAndApplyOptions` calls `importShapes` and meshes the result as is.
  - Nothing fragments the compound, so two solids that touch are expected to mesh independently, with duplicate, non-coincident nodes on the shared face. That is unusable for a structural assembly.
  - `fragment` is declared in `dist/gmsh.d.ts` and has never been called.
  - Parts are resolved to Gmsh tags by bounding-box centre matching in `gmshPartsMap.ts`, which must run *after* any renumbering.
- **Probe (S):**
  1. Mesh two touching boxes (a new two-box fixture, faces coincident) without `fragment`, and count the nodes on the shared plane that coincide within 1e-9. Expect none shared.
  2. Repeat with `fragment`, and expect every interface node shared.
  3. Run it on `examples/STP/as1_pe.stp` and record the node and element counts, plus timing.
  4. Assign a Part to one box's face and confirm its physical group survives, resolved after fragmentation.
  5. Confirm that a single-solid model gives identical output with and without `fragment`.
- **Decision gate:**
  - **Pass:** shared nodes on the interface, Parts intact, and single solids unaffected.
  - **Fail:** recorded, with the counts.
- **If admitted (M):**
  - A `conformal` mesh option. It defaults on for multi-solid B-rep sources and is recorded in the handoff manifest.
  - Parts are resolved after fragmentation.
  - Kratos MDPA output keeps one SubModelPart per body.
- **Out of scope:** contact pairs or tied interfaces; those are solver-side choices.

##### 4.3 Hausdorff-bounded surface coarsening for the heal ceiling {#hausdorff-bounded-surface-coarsening-for-the-heal-ceiling}

*Area: Meshing.*

- **Hypothesis:** a Hausdorff-bounded surface remesh — mmgs, or meshio++'s own clustering `remesh` — reduces `large-sphere-100k.stl` to about 1 000 triangles. The result closes and heals to a *positive* volume near the sphere's, unlike the shipped QEM decimation, which heals to exactly 0.
- **Evidence today:** the auto-decimate item (see `CLAUDE.md`) records that decimation introduces non-manifold edges and slivers. On the 1k sphere it sews at 1e-6 yet solidifies to volume 0, so `promote_mesh_to_brep {autoDecimate}` refuses with a degenerate-heal error. The smoke suite pins that refusal on purpose, as the revisit signal. meshio++ 16.7.0's `remesh` offers isotropic, quadric or anisotropic clustering with explicit repair passes. It reports `numIsolatedClusters` and `numNonManifoldVertices` separately, which is exactly the diagnostic this probe needs.
- **Probe (S):**
  1. Run three candidates on `large-sphere-100k.stl` at a target of about 1 000 triangles:
     - the shipped `decimateStlBoundary`;
     - meshio++ `remesh(mesh, 1000, …, "isotropic", …, preserveBoundary=true)`;
     - mmgs with `hausd` = 1e-2 × the diagonal.
  2. Score each through the unchanged `checkMeshHealth` on:
     - free and non-manifold edges;
     - `inconsistentPairCount`;
     - healed volume against 4/3·π·10³ = 4188.79 (the fixture is a radius-10 sphere at the origin);
     - wall-clock time.
  3. Repeat at 5 000 triangles to find where sewing cost dominates. The auto-decimate write-up found 5k already past the 300 s watchdog.
- **Decision gate:**
  - **Pass:** at least one candidate heals to within 2 % of the analytic volume with zero non-manifold edges.
  - **Fail:** every candidate heals degenerately. Record the numbers and keep the pinned refusal.
- **If admitted (S):** auto-decimate's backend switches to the winning candidate. Its `decimated` report names the method and the Hausdorff bound. The `mcp:smoke` degenerate assertions flip to a successful promote, as the auto-decimate write-up anticipated. If meshio++ wins, this item needs **no** MMG dependency — state that outcome explicitly instead of bundling MMG for it.
- **Out of scope:** raising `MAX_HEALABLE_TRIANGLES`; the per-triangle sewing cost is the real limit.

##### 4.4 Gmsh mesh optimisation (Netgen and high-order) {#gmsh-mesh-optimisation-netgen-and-high-order}

*Area: Meshing.*

- **Hypothesis:** `gmsh.model.mesh.optimize(method)` — present in the bundled 0.3.0 binding, with Netgen linked in — raises minimum quality on generated tet meshes (`"Netgen"`, `"Relocate3D"`). It also untangles invalid curved quadratic elements (`"HighOrder"`, `"HighOrderElastic"`), and it is neither a no-op nor a crash.
- **Evidence today:**
  - `optimize(` is declared in `dist/gmsh.d.ts`. The only optimisation we set is `MeshOptions.optimize`, which today maps to Gmsh's generate-time `Mesh.Optimize` flag.
  - An order-2 generate of a curved model can produce negative Jacobians. `summarizeQuality` would show them as ≤ 0 minSICN, but nothing fixes them.
  - `README.md`'s licensing notes record that Netgen is linked into this Gmsh build; no call has ever reached it.
- **Probe (S):**
  1. Generate `examples/STP/bull.stp` in 3D at the smoke-test size. Record minSICN and mean quality, then call `optimize("Netgen")` and `optimize("Relocate3D")` separately, recording quality, element count and time for each.
  2. Generate at `elementOrder: 2`, count elements with negative minSICN, then call `optimize("HighOrderElastic")` and recount.
  3. Confirm `gmsh.write()` still produces a valid `.msh`, and that the physical groups from Parts survive optimisation.
- **Decision gate:**
  - **Pass:** a measurable, repeatable quality gain with physical groups intact.
  - **Fail:** a no-op, a throw or an abort → Kernel-blocked, with the method name.
- **If admitted (S):**
  - `MeshOptions.optimize` becomes an enum (`none` / `default` / `netgen` / `highOrder`). It stays backward-compatible: the existing boolean parses as `default`/`none`.
  - The option is threaded into `generateGeoScript` as `Mesh.OptimizeNetgen` / `Mesh.HighOrderOptimize` lines.
  - The panel greys it out under fTetWild. That is the same rule every other Gmsh-only field follows, so `meshPresets`' `inapplicablePresetFields` needs the field added.

##### 4.5 Compound meshing across sliver faces {#compound-meshing-across-sliver-faces}

*Area: Meshing.*

- **Hypothesis:** `gmsh.model.mesh.setCompound(2, faceTags)`, declared and never called, meshes a group of small or sliver faces as one surface. This removes the tiny elements that patch seams in imported STEP files force today.
- **Evidence today:**
  - Imported STEP files often split one smooth surface into many patches. The display-edge work already detects such seams (`smooth` edges).
  - Gmsh respects every patch boundary, so a seam forces nodes along it, and sliver patches force tiny elements.
  - The worst-element overlay and the quality histogram show the result, but nothing addresses it.
- **Probe (S):**
  1. Pick a model with smooth seams: `bull.stp` has nine by the smooth-edge classifier.
  2. Group the faces on each side of every smooth seam and call `setCompound`.
  3. Compare against a plain generate: minimum quality, element count, and the number of elements under the 0.2 worst-element threshold.
  4. Confirm that a Part on one of the merged faces still gets its triangles.
- **Decision gate:**
  - **Pass:** measurably better minimum quality with Parts intact.
  - **Fail, or Parts are lost:** recorded.
- **If admitted (M):** an opt-in "Merge smooth patches" mesh option, driven by the existing smooth-edge classification.

##### 4.6 Manifold mesh booleans {#manifold-mesh-booleans}

*Area: Meshing.*

- **Hypothesis:** [`manifold-3d`](https://www.npmjs.com/package/manifold-3d) (Apache-2.0, now licence-compatible) performs mesh booleans and holes on STL/OBJ/PLY/glTF sources, with output that is always closed and manifold. It does this at speeds comparable to `three-bvh-csg`.
- **Evidence today:**
  - Mesh booleans and holes use `three-bvh-csg` in the webview, which makes no manifold guarantee.
  - A 150 000-triangle guard refuses dense inputs.
  - Non-manifold output is what later breaks Mesh Health and Promote to B-rep.
- **Probe (S):**
  1. Subtract a cylinder from `cube.stl` with both engines.
  2. Run `check_mesh_health` on each result: free edges, non-manifold edges, and whether it closes at the tightest sewing tolerance.
  3. Time both on `large-sphere-100k.stl` minus a box.
  4. Confirm `manifold-3d` loads in the webview under the CSP and bundles without a build change. It is a WASM module, so it might instead belong in the kernel worker.
- **Decision gate:**
  - **Pass:** manifold output, and time at most twice `three-bvh-csg`'s.
  - **Fail:** recorded.
- **If admitted (M):**
  - `manifold-3d` becomes the mesh boolean engine, with `three-bvh-csg` as the fallback.
  - The dense-mesh guard is re-measured.
  - README Licensing gains the Apache-2.0 attribution.

##### 4.7 Jacobian validity for high-order meshes {#jacobian-validity-for-high-order-meshes}

*Area: Meshing.*

- **Hypothesis:** `gmsh.model.mesh.getJacobians`, declared and never called, returns per-element Jacobian determinants. A negative determinant flags an inverted curved element that `minSICN` does not catch.
- **Evidence today:**
  - Quadratic meshes (`elementOrder: 2`) ship with the same quality summary as linear ones.
  - Curving mid-side nodes onto a curved surface can invert an element near a tight fillet, and nothing checks for it.
- **Probe (S):**
  1. Generate `bull.stp` at order 2 with a coarse size, and count elements with any negative Jacobian determinant.
  2. Confirm a linear mesh reports none.
  3. If [Gmsh mesh optimisation](#gmsh-mesh-optimisation-netgen-and-high-order) is admitted, confirm its high-order optimiser clears them.
- **Decision gate:**
  - **Pass:** negative determinants detected where expected.
  - **Fail:** the call throws or returns nothing usable.
- **If admitted (S):** an "invalid elements" count in the quality summary for order-2 meshes, fed into the worst-element overlay.

##### 4.8 Anisotropic boundary layers for 2D Gmsh meshes {#anisotropic-boundary-layers-for-2d-gmsh-meshes}

*Area: Meshing.*

- **Magnusim-inspired scope refinement:** if the existing probe passes, accept layer count, first-layer height and growth ratio with a computed total thickness and explicit units. Report incompatible/excessive thickness and unresolved wall selections before meshing, then report achieved layers and quality afterward. Persist the effective settings with the existing mesh options and expose them through MCP. Reuse the current distance-sizing controls; these inputs do not establish support for 3D inflation. Include an analytic geometric-series check and a narrow-gap fixture in acceptance.

- **Hypothesis:** the bundled gmsh-wasm 0.3.0 builds a working `BoundaryLayer` field — thin, ratio-graded quads hugging a chosen curve — through `field.add("BoundaryLayer")` + `setAsBoundaryLayer`, and it composes with the existing `Min` background field rather than replacing it.
- **Evidence today:** string presence only, but more of it than the earlier wording admitted. `setAsBoundaryLayer(tag)` and `geo.extrudeBoundaryLayer(dimTags, numElements?, heights?, recombine?, second?, viewIndex?)` are both in `dist/gmsh.d.ts` with `unsupported: false` in the binding descriptor; the binary's string pool registers `BoundaryLayerField` in the field factory and carries the option names `CurvesList`, `PointsList`, `FanPointsList`, `FanPointsSizesList`, `ExcludedSurfacesList`, `SizeFar`, `Thickness`, `Ratio`, `AnisoMax`, `BetaLaw`, `NumExactLayers`, `Quads`, plus the runtime diagnostics "Different boundary layers cannot touch each other" and "Impossible boundary layer configuration". The runtime agrees: `option.getString("General.BuildInfo")`, read through the probe harness, lists `BoundaryLayers` among the build options of the shipped 0.3.0 binary (Gmsh `5.0.0-git-29726e7`, OCC 7.8.1). That says the feature was compiled in, not that it works. Nothing has called the field itself. The shipped `Distance`+`Threshold`+`Min` composition owns the single `setAsBackgroundMesh` call (`gmshSizingFields.ts`); a boundary layer is set through a *different* call, which is exactly what makes coexistence a question rather than a known. Two adjacent facts, stated plainly: no committed test runs `dimension: 2` live, and `CLAUDE.md`'s claim that a 3D layer "needs `geo.extrudeBoundaryLayer`, which OCC-imported sources can't use" is an inference from the type surface (`extrudeBoundaryLayer` lives on `model.geo` with no `model.occ` twin), not a probe result.
- **Probe (S):**
  1. *Isolated, native gmsh:* `occ.addRectangle(0, 0, 0, 10, 4)` → `synchronize` → `field.add("BoundaryLayer")` → `setNumbers` of `CurvesList` to the bottom edge, `setNumber` for the wall size 0.05 (try `hwall_n`, then `Size`), `Ratio` 1.2, `Thickness` 0.5, `Quads` 1, `FanPointsList` the two bottom corners → `setAsBoundaryLayer(tag)` → `Mesh.Algorithm = 6` → `generate(2)`. Assert the two rejection strings above never fire, then through `getElements(2)`: quads present (Gmsh type 3), the nearest node row at y ≈ 0.05, successive rows growing by ≈1.2, and more elements than the plain mesh. This needs a walker over `getElements`'s per-type arrays — new code; the smoke script only parses `$Nodes` today.
  2. *Composition:* add a `Distance`+`Threshold` background through `setBackgroundMin` beside the layer and confirm both effects survive one generate; then two layers on touching curves, expecting the documented "cannot touch" diagnostic.
  3. *Through the real pipeline:* append `addRectangleProfile` to a copy of `block.stp` (it lands as `face-6`), assign a curve-scoped Part, and `generate_mesh` at `dimension: 2` — the first live `dimension: 2` run in the repo — verifying the `edge-N` to `(1, tag)` bbox correlation `gmshPartsMap.ts` would rely on.
  4. *Cheap, recorded:* `option.getNumber("Mesh.BoundaryLayerFanElements")` round-trips; `geo.extrudeBoundaryLayer` on an OCC-imported surface, to prove or refute the 3D claim instead of keeping the inference.
- **Decision gate:** *pass* — graded quads with the asserted wall size and ratio, composing with the background field. *Fail* — triangles only, a no-op, or a throw → Kernel-blocked with the option names and diagnostics recorded. *Partial* — works alone but replaces the background field → keep here, narrowed to "layer or grading, not both".
- **If admitted:** Phase 1 (**M**) — `Part.meshBoundaryLayer { wallSize, growthRatio, thickness, quads }` for curve-scoped Parts on 2D generates: a third `if (part.meshBoundaryLayer != null)` branch in `applyPartsToGmshModel` beside `meshSize` and `meshGrading`, a `validateMeshBoundaryLayer` gate, every length scaled by `scalePartsMeshSizeForUnit`, a `set_part` parameter, a panel row, and a `.geo` script comment. Phase 2 (**L**, its own probe, only if step 4 passes) — 3D layers through `extrudeBoundaryLayer`.
- **Out of scope:** 3D layers on OCC-imported solids unless step 4 proves the route; STL sources (no entity correlation, the same rule physical groups follow).
- **Not a substitute:** MMG's per-reference local sizes ([MMG remeshing of FE meshes](#mmg-remeshing-of-fe-meshes)) refine isotropically near a wall. They do not build stacked, ratio-graded layers, so a passed MMG probe does not close this item.

##### 4.9 Structured (transfinite) meshing per Part {#structured-transfinite-meshing-per-part}

*Area: Meshing.*

- **Hypothesis:** `setTransfiniteCurve` / `setTransfiniteSurface` / `setTransfiniteVolume`, plus `setRecombine`, produce exact mapped hex meshes on B-rep regions that admit them. `setTransfiniteAutomatic` finds such regions on its own on a multi-block model.
- **Evidence today:**
  - All of these calls are declared in the bundled binding and have never been called.
  - The shipped `elementShape: "subdivided"` produces all-hex meshes, but by splitting tets. They are unstructured and of lower quality than a mapped mesh.
  - Part-scoped Gmsh settings already have a home: `applyPartsToGmshModel` resolves Part ids to Gmsh tags for `meshSize` and `meshGrading`.
- **Probe (S):**
  1. On `examples/STP/block.stp` (3 × 4 × 5), set transfinite curves with n nodes per edge, set the surfaces and the volume, recombine, then generate in 3D. Assert exactly (n−1)³ hexahedra (Gmsh type 5) and zero tets, using the same `$Elements` walker the boundary-layer probe needs.
  2. Call `setTransfiniteAutomatic` on `examples/STP/angle1.stp`, and record which volumes it accepts.
  3. On a non-mappable region, check that the failure mode is a clean throw or a fallback, never a hang.
- **Decision gate:**
  - **Pass:** exact counts on `block.stp`, plus a defined failure on non-mappable regions.
  - **Fail:** wrong counts, or a hang.
- **If admitted (M):**
  - A `Part.meshStructured { divisions }` field beside `meshSize` and `meshGrading`, for B-rep sources only (the same rule as physical groups).
  - It gets its own branch in `applyPartsToGmshModel`, a validation gate, a `set_part` parameter and an FE Mesh row.
  - Unit conversion does not touch `divisions`, which is a count, not a length.
  - `mdpaWriter`'s `Hexahedra3D8` path already covers the output.

##### 4.10 Metric-driven adaptive remeshing from a field {#metric-driven-adaptive-remeshing-from-a-field}

*Area: Meshing.*

- **Hypothesis:** a remesh driven by a size map derived from a field — an error estimate, or a user-picked colour-by-field scalar — refines where the field varies and coarsens where it does not. Point/cell data can then be carried onto the new mesh with a measured conservation error.
- **Evidence today:**
  - **Error estimate:** meshio++ `estimateError` (the Zienkiewicz–Zhu estimator, with `none`/`absolute`/`fraction`/`dorfler` marking) is bundled and uncalled.
  - **Field transfer:** `conservativeInterpolate` keeps ∑value·measure equal over the shared region, a property plain `interpolate` lacks.
  - **Metrics:** MMG accepts scalar (`setScalarSols`) and tensor (`setTensorSols`, 6 doubles per node) metrics. VSCode-MDPA-Preview builds tensors from a field's Hessian.
  - **Field plumbing:** already exists for display: `readMeshioDataInfo` and `readMeshioFieldValues` feed colour-by-field.
- **Probe (S, requires the MMG core probe to pass):**
  1. On `examples/MED/two-material-tets.med`, attach a synthetic point field f = exp(−|x − c|²/σ²).
  2. Build a scalar size map h = clamp(h₀ / (1 + α·|∇f|)) from `estimateError`'s cell indicator, then remesh through mmg3d.
  3. Assert that element density near `c` is at least 3× density far from it.
  4. Transfer f with `conservativeInterpolate`, and assert ∑f·measure is preserved to 1e-6 relative.
  5. Repeat with a tensor metric, and record whether anisotropy measurably lowers the element count at equal interpolation error.
- **Decision gate:**
  - **Pass:** the density ratio holds and the conservation check holds.
  - **Partial:** scalar metrics work but tensor metrics do not. Admit the scalar path only.
- **If admitted (M):** an `adapt_mesh` MCP tool plus a panel action. The metric source is `estimateError`, a named scalar field or a Part's region. Fields are transferred conservatively, and the achieved density and conservation error are reported. The result is a new file.
- **Out of scope:**
  - Level-set discretisation (MMG `-ls`, cutting a mesh along an isosurface into two materials). It is a separate workflow with its own reference rules (MMG reserves references 2/3), and it waits for a concrete request.
  - Solver coupling. Adaptation is a single, user-triggered pass, never a loop.

##### 4.11 Embedded points and curves {#embedded-points-and-curves}

*Area: Meshing.*

- **Hypothesis:** `gmsh.model.mesh.embed`, declared and never called, forces a mesh node at a point or along a curve inside a face or volume. A load or sensor location then lands exactly on a node.
- **Evidence today:**
  - Point Parts (`point-N`) become physical groups, but only when the point is a vertex of the model.
  - Standalone `addPoint` geometry is free, and is not guaranteed a node.
- **Probe (S):**
  1. Add a point in the middle of `block.stp`'s top face.
  2. Mesh with and without `embed`, and assert a node lies at the point to 1e-9 only with it.
  3. Repeat for a line embedded in the face.
- **Decision gate:**
  - **Pass:** exact node placement.
  - **Fail:** recorded.
- **If admitted (S–M):** free points and lines assigned to a Part are embedded automatically, and their physical group holds the embedded nodes.

##### 4.12 Pre-mesh healing {#pre-mesh-healing}

*Area: Meshing.*

- **Hypothesis:** `gmsh.model.occ.healShapes` and `removeAllDuplicates` (declared, never called) fix enough imported-geometry defects that a B-rep which fails to mesh today meshes afterwards.
- **Evidence today:**
  - `daratech.stp` fails 3D meshing with a Gmsh PLC error; the perf harness had to exclude it.
  - fTetWild is the current answer for dirty input, but it applies only to triangle meshes and loses Part correlation.
- **Probe (S):**
  1. Mesh `daratech.stp` and `block.stp` with and without healing, and record which succeed.
  2. For each success, record the change in face count and volume.
- **Decision gate:**
  - **Pass:** a previously failing model meshes with an unchanged volume.
  - **Fail:** recorded. fTetWild remains the answer.
- **If admitted (S):** an opt-in `heal` mesh option recorded in the handoff manifest.

##### 4.13 Hex-dominant MDPA export {#hex-dominant-mdpa-export}

*Area: Meshing.*

- **Hypothesis:** the Gmsh type-140 elements that hex-dominant meshing emits can be split into existing Kratos element types, pyramids or tetrahedra, without breaking conformity. Kratos MDPA export would then accept hex-dominant meshes instead of refusing them.
- **Evidence today:**
  - `collectCells` in `gmshService.ts` refuses type 140 with an actionable message.
  - `getElementProperties(140)` throws in this build, so the element's node layout has to be read from `getElements` output.
- **Probe (S):**
  1. Generate a hex-dominant mesh of `block.stp`.
  2. Read the type-140 elements' node counts and positions, and determine their shape from the positions.
  3. Attempt a split into pyramids or tetrahedra, and check that the total volume is conserved and no face is left unmatched.
- **Decision gate:**
  - **Pass:** conservative, conforming splits.
  - **Fail:** the shape is ambiguous → Kernel-blocked, and the refusal stays.
- **If admitted (S–M):** MDPA export splits type 140 and says so in its warnings and in the handoff manifest.

##### 4.14 Periodic meshing {#periodic-meshing}

*Area: Meshing.*

- **Hypothesis:** `gmsh.model.mesh.setPeriodic`, declared and never called, produces matching node layouts on opposite faces of a box, as representative-volume-element homogenisation needs.
- **Evidence today:** no periodic constraint exists, and matching opposite faces by hand is not possible.
- **Probe (S):**
  1. Mesh `block.stp` with the ±x faces periodic under a translation.
  2. Assert that every node on one face has a partner on the other at exactly the translation.
- **Decision gate:**
  - **Pass:** exact pairs.
  - **Fail:** recorded.
- **If admitted (M):** a periodic-pair mesh option between two Parts, with the node pairs written to the MDPA as a SubModelPart pair.

##### 4.15 JS mesh-size callback {#js-mesh-size-callback}

*Area: Meshing.*

- **Hypothesis:** the `setSizeCallback((dim, tag, x, y, z, lc) => number)` declared in gmsh-wasm 0.3.0 actually marshals a JS function into Gmsh's per-vertex sizing loop. `doc/gmsh-integration.md` records it as green in the manifest but never called.
- **Evidence today:** field-based sizing (Constant, Distance+Threshold, Min) covers every shipped feature. A callback would let a *sampled* quantity drive sizing without translating it into fields — for example, the deviation map's per-vertex distances, or an error indicator on a previous mesh.
- **Probe (S):**
  1. Register a callback returning `lc = 0.1 + 0.2·(z − zmin)/(zmax − zmin)` on `block.stp`, and generate.
  2. Check that edge lengths grow monotonically in z, within a 20 % band.
  3. Measure how many callback invocations occur and their total cost, since each call crosses the WASM boundary.
  4. Confirm `removeSizeCallback` restores field-only behaviour in the same singleton.
- **Decision gate:**
  - **Pass:** the gradient appears and the per-call overhead is tolerable at the smoke-test size.
  - **Fail:** a throw, an abort or no effect → Kernel-blocked, with the finding recorded in `doc/gmsh-integration.md` too.
- **If admitted:** no feature by itself. This probe is an enabler, recorded so a future sizing source can choose it knowingly. The known cost is stated: a callback is not declarative, so it cannot round-trip through `.geo`, `.geo_unrolled` or the `.mesh.json` sidecar.

##### 4.16 METIS partitioning for Kratos MPI export {#metis-partitioning-for-kratos-mpi-export}

*Area: Meshing.*

- **Hypothesis:** `gmsh.model.mesh.partition(n)` (METIS is linked in) partitions a generated mesh. The partition entities read back cleanly enough to write one MDPA file per rank, each with its interface nodes identified.
- **Evidence today:**
  - `partition` / `unpartition` are declared in the binding.
  - `README.md`'s licensing notes record that METIS is linked into this Gmsh build.
  - `mdpaWriter.ts` writes a single serial file.
  - Kratos's own MPI workflow usually partitions at load time (its `metis_partitioning` process), so the value here is unproven.
- **Probe (S):**
  1. Generate `bull.stp`, partition into 4, then read back `getPartitions` and partition entities.
  2. Assert that every element belongs to exactly one partition, and that the partition element counts sum to the total.
  3. Record the balance ratio (largest partition / mean).
- **Decision gate:**
  - **Pass:** a consistent, balanced partition.
  - **Rejected scope regardless of the probe:** the case where Kratos users confirm load-time partitioning is what they use. Record that and stop.
- **If admitted (M):** partitioned MDPA export, one file per rank, with SubModelParts preserved per rank. This is the lowest-value meshing item, so it is listed last.

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

#### 6.2 Build and bundle an OpenSCAD WASM port {#build-and-bundle-an-openscad-wasm-port}

*Area: Formats. Issue: #35 "OpenSCAD".*

- **Decision recorded (2026-09-24):** this was the "Bundling `openscad-wasm`" Non-goal, rejected purely on licensing grounds — a real OpenSCAD build links CGAL (GPLv3-or-later / LGPLv3-or-later, no GPLv2 option) and/or Manifold (Apache-2.0, which the FSF treats as GPLv3-compatible but not GPLv2-compatible), so bundling it forces a `GPL-3.0-or-later` floor. The maintainer chose to take that step: CAD-Preview was relicensed from `GPL-2.0-or-later` to `GPL-3.0-or-later` ahead of the artifact existing (see the README's "Licensing" section), so the licence is no longer the blocker. What remains is engineering: there is nothing safe to bundle yet.
- **Hypothesis:** OpenSCAD's C++ core (GPL-2.0-or-later, confirmed against upstream's `COPYING`) plus a CGAL and/or Manifold geometry backend cross-compiles, through Emscripten, to a single WebAssembly module that evaluates `.scad` (and the `.csg` this codebase already imports) from Node with no `openscad` binary on `PATH` — the same recipe already proven by `@loumalouomega/gmsh-wasm`, `mmg-wasm` and `float-tetwild-wasm`.
- **Evidence today:**
  - **No usable artifact exists.** The only `openscad-wasm` on npm (publisher `20lives`, v0.0.4, ~500 weekly downloads) was downloaded and inspected: a single 14 MB `openscad.js` with **no LICENSE file, no repository, no author and no copyright or attribution notices**, self-labelled `"license": "GPL-2.0"` — a label that cannot be right for a build that links CGAL or Manifold, and, independently of what the underlying licence is, redistributing GPL code with its notices stripped is itself non-compliant. It is not bundle-able whatever its true licence turns out to be.
  - **Upstream publishes nothing reusable.** `openscad/openscad-playground` builds a WASM binary for its own hosted page ("The build system fetches a prebuilt OpenSCAD web WASM binary") and publishes no npm package for it. Its README states the Manifold backend is the default.
  - **The shipped alternative works and stays.** `.scad` already opens through a user-installed `openscad` binary (`src/scadService.ts`, verified live against OpenSCAD 2021.01, converting to the `.csg` that `csgImport.ts`/`csgModel.ts` build). This item is additive: it removes the "install OpenSCAD first" step and pins the version, and it does not retire the binary path.
- **Probe (M — larger than this file's usual S probes: it is a build, not an API check):**
  1. **Build.** From upstream OpenSCAD source, use `openscad-playground`'s own build recipe as the starting point to produce a single-threaded Emscripten module (the `{ threads: false }` choice fTetWild and meshio++ already force). Try Manifold as the only geometry backend first — a smaller dependency set (Apache-2.0 alone) than carrying CGAL too; record whether that build path is viable.
  2. **Size.** Record the real `.wasm` size with and without `text()` and font support. Prior estimate to replace with a measurement: ~8–14 MB base, ~8 MB more for `text()`.
  3. **Correctness.** Evaluate every `examples/OpenSCAD/*.scad` fixture and compare the emitted CSG with what `scadService.ts`'s binary path produces for the same input (booleans, `linear_extrude`, `rotate_extrude`, `polygon`, `polyhedron`, and one `text()` case); then confirm the analytic volumes `mcp:smoke` already pins (`bracket.csg` 5228.88, `extrude.csg`) still hold end to end.
  4. **Loading.** Confirm it loads under this repo's own constraints: `esbuild.mjs`'s CJS bundling with the `import.meta.url` handling, the `wasmBinary` versus self-locating question, and stdout purity in the MCP server (`mcp:smoke` fails on any stray write to fd 1).
  5. **Kernel behaviour.** A forced abort must be classified by the fifth `isXWasmAbort` vocabulary and reset the singleton; a `.scad` that recurses or loops must hit the kernel worker's watchdog rather than hang.
  6. **Compliance.** Produce and ship a correct `LICENSE`, `NOTICE` and third-party attribution with the published package, plus a corresponding-source offer or pointer. This is a hard requirement, not polish — the existing npm package fails exactly here.
  7. **Timing.** Compare wall-clock against the binary path on the largest existing OpenSCAD fixture.
- **Decision gate:**
  - **Pass:** a correct, reasonably sized artifact with complete licence material, matching the binary path's output on every fixture.
  - **Fail:** it does not cross-compile cleanly, or size or timing is unacceptable → the binary path remains the answer. The item returns to Non-goals with the concrete build failure recorded, which is a materially different reason from the original licence-only rejection.
- **If admitted:**
  - **Phase 1 (M):** publish the artifact under the maintainer's own scope (`@loumalouomega/openscad-wasm`, following the gmsh-wasm / mmg-wasm precedent), add a lazy-singleton `scadWasmService.ts` to `kernelWorker.ts` through the standard four-touch-point `Pipeline` pattern, and have `resolveEffectiveSource` prefer it, falling back to the binary when the WASM path cannot handle a construct.
  - **Phase 2 (S):** README "Licensing" attribution, the `WASM_EXTERNALS` / `.vscodeignore` / `compat:vsix` packaging entries, and `doc/file-formats.md`, `doc/mcp-server.md` and `doc/getting-started.md` updates (the "install OpenSCAD" hint becomes the fallback message).
- **Out of scope:** retiring the binary path; a live OpenSCAD editor or customizer UI; anything that makes `.scad` evaluation asynchronous outside the kernel worker.

## Definition of done

- **Behaviour:** complete the stated workflow, including cancellation, stale replies, empty input and reopen where relevant. A successful API return or non-empty file is not enough.
- **Evidence:** pure math gets analytic fixtures; kernel changes get live-WASM checks; webview changes get real-bundle interaction/render assertions; save/watch flows get the real host where feasible. State any remaining manual verification gap precisely.
- **Compatibility:** preserve source-write confirmation, deterministic entity-id rules, tolerant sidecar parsing and lazy host-only kernels. New bundled dependencies require a GPL-compatibility check.
- **Parity:** name the item's MCP tool (or `supported: false` shape) and its interactive surface, or say why one side is deliberately absent. A capability reachable from only one side is a gap the next review will list.
- **Documentation:** update affected protocol, API, format and getting-started references together. Regenerate screenshots for viewer markup/panel changes and visually inspect a full 3D shot. Add a changelog entry when releasing a new version.
- **Known limitations:** re-read `doc/getting-started.md`'s Known limitations list whenever a release touches one of its entries. Two entries were found stale in the 2026-09-24 review (hidden-line removal, and where tessellation runs).
- **Closure:** remove the completed scope from this backlog, record verified implementation details in `CLAUDE.md`, and retain only a genuinely separate, scoped follow-up. An unverified branch is not closed merely because the happy path shipped.

## Non-goals / known constraints

Three groups, three different revival rules. Each says what would change our mind.

### Architectural invariants

*Not revivable as stated. These are design decisions enforced structurally rather than by convention — but "enforced structurally" is a claim about the code, not a licence to stop re-reading it, which is how the entry below came to be promoted.*

- **OCCT in the webview** — the kernel stays in the extension host; the webview runs only Three.js. Since the kernel-worker work this is *stronger* than the invariant requires: OCCT, Gmsh, meshio++ and fTetWild all run in a forked child process (`src/kernelWorker.ts`), one process further from the webview than the rule demands.

- **No silent CAD-source writes.** Explicit save-in-place already ships through the editable custom editor and headless `save_model`; this is not a read-only application. Sidecar autosave and external-change reconciliation must not silently bake edits into the source. Preserve the confirmed-save contract, `bakedThrough` replay watermark and backup/recovery behaviour. The six sidecars retain state that has no home in the source format; see `CLAUDE.md` for the implementation history.

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

- **Hidden-line removal through OCCT's own `HLRBRep_*` family.** Every class is red in this build: `HLRBRep_Algo`, `HLRBRep_PolyAlgo`, `HLRBRep_HLRToShape`, `HLRBRep_PolyHLRToShape`. `HLRAlgo_Projector` is green but is a low-level internal only reachable through them.

  **The narrow survivor, `HLRAppli_ReflectLines`, was probed and is not the way in either — and it is this file's canonical example of green-but-useless.** The binding genuinely works: the unsuffixed constructor takes a `TopoDS_Shape`, and `SetAxes`/`Perform`/`GetResult` are all bound and functional (249 ms on `bull.stp`, returning a non-null compound this codebase's own `enumerateEdges` reads as 25 edges). It was rejected on the *drawing*, which is only visible by looking at it: rendered side by side against a tessellation-derived silhouette of the same view, `GetResult()` produced the outer boundary and a few fragments while missing the part's circular holes and interior cutout entirely. `GetResult()` returns reflect lines only; sharp feature edges live behind `GetCompoundOf3dEdges(type, …)`, whose `type` argument is an `HLRBRep_TypeOfResultingEdge` — from the entirely-red family above — so calling it throws. The one filter that would make the kernel path competitive is unreachable.

  **What routed around it, and what that leaves.** `export_svg_silhouette` (`src/silhouetteEdges.ts`) and then `export_technical_drawing` (`src/hiddenLineRemoval.ts`) both ship on triangle adjacency, calling no OCCT hidden-line API at all — so hidden-line *drawings*, visible edges solid and occluded runs dashed, exist today for B-rep **and** mesh sources alike, which the kernel path never could have handled. A local sibling project, HCAD, independently arrived at the same shape.

  **Correction, recorded because this entry was stale for a while:** it used to say dimensions were also out of scope. They are not. `exportTechnicalDrawingTool` is a one-line wrapper over `exportSvgSilhouetteTool`, which reads `<model>.annotations.json` unconditionally, projects every pinned measurement through the export's own view basis, and returns `dimensionCount` — in SVG *and* on DXF's own `DIMENSIONS` layer, tolerance bands included. **A second correction, since closed in full:** this entry also used to name multi-view sheet layout as what remained unshipped. That has since closed too — `export_drawing_sheet`/File ▸ Export Drawing Sheet… place several views on one sheet at a shared scale with a title block, first- or third-angle projection (see `CLAUDE.md`'s "Multi-view drawing sheets"). Nothing is currently tracked as unshipped from this Non-goal.

- **Glyph → `TopoDS_Shape` via OCCT fonts.** Every `Font_*` class is red: `Font_BRepFont`, `Font_BRepTextBuilder`, `Font_FTFont`, `Font_FTLibrary`, `Font_FontMgr`, `Font_SystemFont`, `Font_TextFormatter`. There is no path from a font file to a shape inside this build.

  **Narrowed twice, and this entry used to overstate itself.** It was titled "3D text, engraving, and embossing" — but engraving and embossing **ship**, as `wrap`'s `emboss`/`engrave` variants, and have nothing to do with fonts. And the text half is not kernel-blocked either, only *font*-blocked: outlines that arrive as SVG paths become ordinary sketch geometry — "3D text via outline import" (the ready-product-work item this entry used to point at) has since closed in full: `svgImport.ts` now composes ancestor `transform`s (so a real "convert text to outlines" export, typically wrapped in `<g transform="...">` groups, lands correctly), `addSurfaceFromLines` accepts several disjoint loops forming one outer boundary plus its holes (a letter with a counter, e.g. an "O", builds as one holed face), `wrap` develops a holed profile onto a cylinder/cone (each hole cut out of the shell), and `import_svg` exposes the whole pipeline headlessly. Nothing is currently tracked as unshipped from this Non-goal.

- **Loft start/end (takeoff) conditions.** `BRepOffsetAPI_ThruSections` exposes no condition API — of its bound knobs only `SetSmoothing` moves geometry (`SetContinuity`/`SetParType`/`SetMaxDegree`/`SetCriteriumWeight` are accepted but byte-identical everywhere tried, so only smoothing is exposed) — and the pipe-shell conditions have no reachable consumer: `BRepOffsetAPI_MakePipeShell`'s `SetMode_4(wire)` returns `false` even for the spine itself, and `BRepFill_FaceAndOrder_2`/`EdgeFaceAndOrder_2` exist as signatures with no sweep to attach them to. Out of scope is only the *constraint*; steering a loft along a rail already ships via the resampled-intermediate `guides` fallback, which is a different feature, not a silent substitution. The [takeoff approximation probe](#loft-takeoff-by-resampled-intermediates) above explores a separate route, not a revival of this dead API.

### Rejected scope

*Revivable only under a different framing — the objection is to what the feature would make this tool, not to whether it could be built. Narrower alternatives are identified below; some already ship.*

- **Interactive sketching with geometric constraints** — rejected, not deferred. It is the single clearest "this is a modeling application now" feature, and CAD-Preview is a preview/inspect/prepare tool. More concretely: the numeric profile and curve forms are **not** a degraded mouse — they accept parametric variable expressions (`L*2`, `R*cos(i*360/N)`) that a click-to-place tool cannot express, so replacing them with drawing would trade away a distinguishing capability for a familiar one. The argument has only got stronger: no constraint solver exists anywhere in the codebase (the sole `constraint` hit is `mate`'s doc comment), while the expression-driven sketch vocabulary has kept growing to sixteen creation ops. Worth noting that SketchForge, a dedicated sketch application, still has no constraint solver either — building this would mean shipping the weak two-thirds of the feature.

  **What survived the reframing:** authoring a profile *on a named construction plane* rather than in world coordinates (shipped as "Author profiles on a named construction plane" — see `CLAUDE.md`). That is a coordinate-frame convenience over machinery that already exists, and it does not put a solver anywhere.

- **Reference-image tracing underlay** — rejected for the current preparation workflow. It would introduce image placement, calibration and tracing interactions without a sketch-authoring workflow to consume them. Tracing in a vector editor and importing through `svgImport.ts`/`dxfImport.ts` already yields editable geometry. Revisit only for a concrete calibrated inspection use case that does not require a constraint-based sketcher. This is a scope decision, not a CSP or “no image assets” invariant: data images are already allowed, and standard-parts thumbnails serve a different workflow.

- **Parametric part generators as kernel primitives (involute gears, thread forms, springs)** — rejected as *kernel geometry*. Standard parts are something this tool should mostly *source*, not author: `search_standard_parts`/`download_standard_part` fetch real, verified geometry from step.parts as ordinary STEP files the existing pipeline opens, and the interactive sidebar does the same. Authoring an involute tooth-flank generator in `occtOperations.ts` is modeling-application scope.

  **What survived the reframing:** the same shapes as *macros* — closed as the "bundled starter macro library" item (`spring`, `bolt-circle-flange`, `hex-bolt` in `macros/starter-library.json`, served when `libraryPath` is omitted). `addHelix` + `sweep` + `repeat` loops + degree trig already express a spring and a thread profile with no new kernel code — the gap was data and a path resolver, not geometry, and step.parts will not hand you a spring at *your* wire diameter anyway.

- **Other meshing kernels: TetGen, CGAL meshers, ParMmg, standalone Netgen** — rejected, recorded so they are not proposed again. The [meshing library review](#meshing-library-review) covers what is proposed instead.
  - **TetGen** is AGPL-3.0: a stronger copyleft than anything bundled so far. It adds nothing fTetWild (robust tets from dirty input) and Gmsh (constrained Delaunay, which already uses tetgen-derived boundary recovery) do not already cover.
  - **CGAL's Mesh_3 and Polygon_mesh_processing remeshers** are GPL-3.0-or-later — no longer a licence barrier now that CAD-Preview is itself `GPL-3.0-or-later`, so this is *not pursued* rather than *blocked*. There is no standalone WASM build of them, and their capabilities are covered by MMG (isotropic surface remeshing) and meshio++'s clustering `remesh`. (A future OpenSCAD WASM build may statically link CGAL internally; that does not expose CGAL's meshers to JS.)
  - **ParMmg** is MMG over MPI. A single-process WASM worker has no MPI, and the meshes this extension handles fit a sequential MMG.
  - **A standalone Netgen** would duplicate the copy already linked into the bundled Gmsh, which is reachable through `optimize` ([Gmsh mesh optimisation](#gmsh-mesh-optimisation-netgen-and-high-order)).

  **What would change our mind:**
  - For TetGen: a relicensing decision to AGPL-3.0-or-later made for other reasons (its licence is a stronger copyleft than the project's own `GPL-3.0-or-later`).
  - For CGAL: a concrete capability MMG and meshio++ demonstrably cannot supply, plus a WASM build to consume — its licence no longer blocks it.
  - For ParMmg: a real mesh that sequential MMG cannot handle within the kernel watchdog.
  - For Netgen: Gmsh's `optimize("Netgen")` failing its probe while a standalone build demonstrably works.
