# Roadmap

Candidate features for future CAD-Preview releases, prioritized by value versus effort given what the extension already ships: an OCCT kernel, a Gmsh kernel, a meshio++ kernel and an fTetWild kernel live in the extension host (in a forked child process) — a fifth, MMG, is proposed below but not bundled — a full picking/selection pipeline in the webview, a six-sidecar persistence model, and an MCP server mirroring the pipeline headless. Many high-value features are cheap precisely because that infrastructure exists.

This page is aspirational, not a release commitment — items may be re-ordered, re-scoped, or dropped. Effort is a rough order of magnitude including implementation, documentation and focused verification: **S** (a day or two), **M** (roughly a week), **L** (multi-week). Estimates assume the stated dependencies hold; a short wiring change can still require substantial verification.

**Planning review: 2026-09-24** (meshing-library review added; previous review 2026-09-16). Existing implementation references were checked against the repository where noted; new candidates remain proposals, not promises of kernel support. This is a prioritized backlog, not a schedule for a particular version.

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

All four gaps have since shipped: narrow-passage preflight (`analyze_passages` / the Passages panel), the mesh size and memory budget preview (`estimate_mesh_budget` / the FE Mesh readout), the CAD-to-mesh deviation map (`measure_mesh_deviation` / Deviation), and mesh-aware tessellation export (`export_tessellated_stl` / Export ▸ STL ▸ Mesh-aware). See `CLAUDE.md` for each.

## Meshing library review — 2026-09-24 {#meshing-library-review}

Meshing today is *generate* (Gmsh, fTetWild) plus *repair* (fTetWild, meshio++ ops). Nothing here remeshes an existing FE mesh: coarsening/refining it under a geometric error bound, improving element quality in place, or adapting it to a field. This review covers the libraries that could fill that gap, with the licence of each. It also covers capabilities that are already in the bundled binaries but have never been called.

The MMG evidence comes from the sibling project [VSCode-MDPA-Preview](https://github.com/loumalouomega/VSCode-MDPA-Preview). It has shipped remeshing through [`@loumalouomega/mmg-wasm`](https://github.com/loumalouomega/MMG-WASM) 0.1.0: MMG 5.8.0, one ~1.1 MB `mmg-core.wasm` holding mmg2d, mmgs and mmg3d, with dual ESM/CJS builds and no pthreads. That is a working product elsewhere, not evidence in *this* pipeline — the kernel worker, IPC marshalling, Parts correlation and stdout purity are all untested here. That is why the MMG items below are probe-gated rather than Tier 1.

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

## Open items

### Suggested implementation sequence

| Wave | Outcome | Start with | Exit signal |
| --- | --- | --- | --- |
| Admitted work | Ship probe-passed kernel ideas | Unify same-domain faces | The Tier 1 item's done-when met |
| Exploration | Decide which kernel ideas deserve implementation | The surface, edge, boundary-layer and takeoff probes in that order, each run with `npm run probe` | Analytic or independently checked results, with failure cases and timing, each probe's write-up filed where the section says |
| Meshing | Decide whether to remesh existing meshes, and with which library | The MMG core probe, then the coarsening comparison (meshio++ against MMG), then Gmsh optimisation | Both MMG probes filed with measured timings, and the licence/packaging tasks known before any MMG code merges |

These are outcome groupings, not release numbers. Independent small items can ship between waves; a failed probe must not block unrelated work.

### Tier 1 — admitted by a passed probe

*Admission: the feasibility probe passed and its call shapes are recorded in `CLAUDE.md`; what remains is product work with a firm estimate.*

#### Unify same-domain faces as an edit op

- **Evidence (probed with the B-rep validity report, opencascade.js 1.1.1):** `new oc.ShapeUpgrade_UnifySameDomain_2(shape, true, true, false)` → `Build()` → `Shape()` merged two fused 10 mm boxes from 10 faces / 20 edges to 6 / 12 with the volume unchanged (2000.0000000000005 both sides); on a box with one fillet it correctly changed nothing (7 faces before and after, volume 997.853981147513 both sides). `_1()` + `Initialize(shape, true, true, false)` is the fallback form.
- **First useful increment (M):** a `unifySameDomain` edit op — B-rep only, topology-changing (every downstream `face-N`/`edge-N` renumbers, so Parts and annotations go through the existing rebind), explicit and undoable, never an automatic consequence of a failed `check_brep_health`. Needs a panel button, which means a TikZ icon through the `icons/` pipeline (`pdflatex` + `pdftocairo`), an `OP_PARAM_DOCS` entry, the generic `produced` bucket role, and a `mcp:smoke` assertion on the fused-box face count and volume.
- **Done when:** the fused-box fixture drops 10 → 6 faces through `apply_edit_ops` at an unchanged volume, and a Part on one of the merged faces is rebound or reported dropped, never silently repointed.

### Probe-gated — establish feasibility before estimating

*Admission: a specific hypothesis with a discriminating experiment. Each probe below is a small, self-contained piece of work with a firm **S** estimate of its own; the phases under "If admitted" are what ships if the probe passes, tagged provisionally. A method that accepts arguments but changes nothing is a failed probe.*

**Probe protocol.** Every probe write-up records: the installed artifact version (`opencascade.js` 1.1.1, `@loumalouomega/gmsh-wasm` 0.3.0 and `@meshioplusplus/wasm` 16.7.0 at the time of writing; `@loumalouomega/mmg-wasm` 0.1.0 for the MMG probes, which install it first), the fixture path, the exact call shapes that worked — overload suffix and argument count, because there is no `.d.ts` for OCCT and signatures are found by enumerating a prototype and trying suffixes, the same way every other OCCT call site here was found — the output facts, cleanup behaviour (`.delete()` in `finally`, a kernel reset after a deliberate abort), and wall-clock timing on the largest fixture that fits. MEMFS paths stay at 10 characters or fewer; the 11+ cliff silently corrupts STEP writes.

**Where a result goes.** *Pass:* the item's "If admitted" phases move into Tier 1 with firm estimates, and the probe's call shapes move to `CLAUDE.md` as the feature's verified facts. *Fail:* the item moves to Non-goals — Kernel-blocked for a dead binding, Rejected scope for a product judgement — with the exact calls that failed and what would change our mind. *Partial:* the item stays here, narrowed to the surviving hypothesis, with the negative half recorded under Non-goals.

**Order, and why.**

| Order | Item | Needs | Why here |
| --- | --- | --- | --- |
| 1 | Open-profile surface output | — | Exercises the free-face invariant every `face-N` operand depends on; structurally cheap |
| 2 | MMG remeshing of FE meshes | `@loumalouomega/mmg-wasm` installed as a devDependency for the probe | Opens a whole capability class (remeshing), and two later rows reuse its loader |
| 3 | Hausdorff-bounded surface coarsening | the MMG core loader; meshio++ already bundled | Fixes a known defect (a degenerate heal after auto-decimate), and may need no new dependency at all |
| 4 | Gmsh mesh optimisation | — | Already in the binary; cheap; directly improves every generated mesh |
| 5 | Small-detail edge suppression | screenshot pipeline | Webview-side and independent; the risk is judgement, not bindings |
| 6 | Anisotropic boundary layers | a `$Elements` walker | The largest Gmsh probe, and the first live exercise of `dimension: 2` |
| 7 | Structured meshing per Part | the same `$Elements` walker | Exact element counts make the probe discriminating; shares the walker with row 6 |
| 8 | Metric-driven adaptive remeshing | a passed MMG core probe | Depends on row 2's result; highest value of the MMG items but the most moving parts |
| 9 | JS mesh-size callback | — | Only needed if a sizing source outgrows Gmsh's declarative fields |
| 10 | Loft takeoff by resampled intermediates | — | Lowest-value geometry probe; the measurement design is the hard part |
| 11 | METIS partitioning for Kratos MPI export | — | Lowest-value meshing probe; no user has asked for partitioned output yet |
| 12 | Build and bundle an OpenSCAD WASM port | Emscripten toolchain (`emsdk`); the relicense is already done | Largest item here (a from-scratch build); independent of every other row, and the shipped binary path keeps `.scad` working meanwhile |

Every probe runs through the committed harness — `npm run probe -- <entry.ts>`, with the skeleton, protocol and scratch convention in [`scripts/probe/README.md`](https://github.com/loumalouomega/CAD-Preview/blob/master/scripts/probe/README.md).

Only row 8 depends on another row's *result*: adaptive remeshing needs the MMG core probe to pass. Every other failed probe blocks nothing after it. Row 3 still produces a result if MMG fails, because its meshio++ half stands alone.

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

#### MMG remeshing of FE meshes

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

#### Hausdorff-bounded surface coarsening for the heal ceiling

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

#### Metric-driven adaptive remeshing from a field

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

#### Gmsh mesh optimisation (Netgen and high-order)

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

#### Structured (transfinite) meshing per Part

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

#### JS mesh-size callback

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

#### METIS partitioning for Kratos MPI export

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

#### Build and bundle an OpenSCAD WASM port

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
