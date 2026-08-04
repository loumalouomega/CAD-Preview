# Roadmap

Candidate features for future CAD-Preview releases, prioritized by value versus effort given what the extension already ships: an OCCT kernel, a Gmsh kernel, and a meshio++ kernel live in the extension host, a full picking/selection pipeline in the webview, a sidecar persistence model, and an MCP server mirroring the pipeline headless. Many high-value features are cheap precisely because that infrastructure exists.

This page is aspirational, not a commitment — items may be re-ordered, re-scoped, or dropped. Effort is a rough order of magnitude: **S** (a day or two), **M** (roughly a week), **L** (multi-week).

Everything previously shipped is tracked in `CHANGELOG.md`, and `CLAUDE.md` has a per-feature section with the verified implementation details for anything currently in the codebase — this page is for what's **not** built yet, only.

## How this file works

- **Tiers are ordered, and the order is the recommendation.** Each tier states an *admission criterion*; an item that doesn't meet it belongs in a lower tier or in Non-goals, not at the top because it sounds exciting. A tier's heading and admission criterion stay in the file even when it's momentarily empty (see Tier 1 below) — the taxonomy is stable even when nothing currently occupies it.
- **A closed item is removed from this list entirely**, not struck through — its write-up moves to `CLAUDE.md` (a per-feature section with the verified implementation details) and its history stays in git. Numbering is renumbered to stay consecutive whenever an item closes, so a reference like "item 5" always means the file's current 5th item, not a fossil of one that shipped.
- **Items marked *needs live-WASM verification* are listed on the strength of the binding manifest alone.** Green in `node_modules/opencascade.js/dist/Supported APIs.md` is **necessary but not sufficient** — both the STEP-unit and the IGES-writer findings started green and only resolved (one negative, one positive) under a real probe. No such item may be *estimated* until it has been probed against the live build; each one names its probe below.
- Most items close a **known, documented limitation** of something that already ships, or are a natural next step identified while building it. A rare one is **defect-shaped** — describing behavior that loses data, corrupts state, or is a security hole rather than merely lacking a feature. Those belong in Tier 1 regardless of effort size, queued here rather than filed separately because the fix and the feature are usually the same work.

Several items below were identified by comparing against [SketchForge-3D](https://github.com/Formsmith746/SketchForge-3D), a browser-based direct-manipulation CAD editor over the same OCCT kernel. Its *capability* gaps transferred well; most of its *interaction* model deliberately did not — see Non-goals.

## Queued

### Tier 1 — Correctness and robustness of what already ships

*Admission: closes a way the current code can silently produce wrong output, lose user data, or strand a session. No new user-facing vocabulary.*

*(None currently queued — every defect-shaped item found so far (kernel fault recovery, the edge-enumerator drift hazard, sidecar external-change reconciliation, preprocess-archive hardening) has closed; see `CLAUDE.md`'s per-feature sections. A future defect-shaped finding always goes here first, regardless of size.)*

### Tier 2 — Fidelity and performance of the display pipeline

*Admission: makes what's already on screen more accurate or faster, without adding a new interaction model.*

*(None currently queued — XCAF assembly-structure read AND write have both closed; see `CLAUDE.md`'s "XCAF read — assembly structure" and "XCAF write — assembly structure and per-part names" sections. Product/component **names** remain kernel-blocked for READING in this OCCT WASM build (confirmed exhaustively) but now DO work for WRITING (per-solid `TDataStd_Name`, carried into the exported STEP's `PRODUCT` entities). Per-label **colors** are confirmed genuinely non-functional in BOTH directions — the write-side probe tried every `XCAFDoc_ColorTool.SetColor`/`Quantity_Color`/`Quantity_ColorRGBA` overload plus `STEPCAFControl_Controller.Init()`, all storing correctly in-memory but none reaching the written STEP text — so this is not "pending a fresh probe" anymore, it's a settled finding on both sides; a future OCCT/binding upgrade would need to be the trigger to revisit it, not another overload sweep.)*

### Tier 3 — Structural work (kernel isolation and interop)

*Admission: multi-week; changes an architectural boundary or adds a kernel capability. Each needs live-WASM verification before it can be **scoped** — being listed here is not an estimate.*

*(None currently queued — "Progress reporting and cancellation" closed, scoped down as its own text permitted (stage-boundary progress with stage-boundary, later superseded-in-part-by-real, cancellation); "OCCT in a forked child process" closed in full across all 4 phases; and "Mesh → B-rep promotion" closed across both phases (Phase 1's read-only heal-quality report, Phase 2's one-shot promote-to-a-new-file export). See `CLAUDE.md`'s "Progress reporting and cancellation", "OCCT/Gmsh/meshio++ in a forked child process", and "Mesh → B-rep promotion" sections for the full write-ups.)*

### Tier 4 — Interaction and interop conveniences

*Admission: closes a UI gap for a capability the pipeline already has, or adds a format on top of existing ops. Explicitly ranked below every Tier 1–3 item; nothing in this tier is a prerequisite for anything.*

*(None currently queued — Standard-parts browse/insert, Align/distribute/pattern, Transform gizmo, Grid/entity snapping, and SVG import → profile ops have all closed; see `CLAUDE.md`'s per-feature sections.)*

### Tier 5 — Evaluated, not actionable

1. **glTF support for `compare_models`** (**M–L**, evaluated and deliberately scoped out, not merely postponed). STL/OBJ/PLY are all now supported via dedicated host-side parsers (`stlParser.ts`/`objParser.ts`/ `plyParser.ts`, all backed by `meshComponents.ts`) — OBJ (plain, already- indexed text) and PLY (a well-specified ASCII/binary format, linearly decodable via one shared header parser) both turned out tractable to hand-roll correctly and validate thoroughly with real fixtures. glTF is a different order of complexity: accessor decoding across 5 component types with an optional `normalized` flag, sparse-accessor overlays, interleaved `bufferView` byte-stride handling, and full scene-graph TRS/matrix composition down to each mesh primitive — with no realistic way to validate a hand-rolled implementation against real-world exporter variety the way the other two formats' fixtures could be validated. Shipping a plausible-looking-but-subtly-wrong parser would risk exactly the "misleading false match" failure mode Compare Models' own design was built to avoid — see CLAUDE.md's "Model comparison" section for the full reasoning.

2. **SVG silhouette export** (**M**, blocked pending a probe). The obvious implementation is dead: every `HLRBRep_*` class is **red** in this build (see Non-goals). The one surviving door is `HLRAppli_ReflectLines`, which is green and produces an outline as a `TopoDS_Shape` — enough for a silhouette, not for a real drawing with hidden lines. Unscopable until someone probes its constructor and output usability; listed so the distinction between "silhouette" and "drawing" stays on record.

## Non-goals / known constraints

- **Writing the CAD source file** — never. The read-only invariant (sidecar persistence, export-only baking) is architectural, not a missing feature.
- **OCCT in the webview** — the kernel stays in the extension host; the webview runs only Three.js (architecture invariant).
- **G-code preview** — considered (text-to-cad ships a strong implementation: layer scrubbing, feature-type coloring, adaptive decimation) and rejected: 3D-printing-oriented, outside this extension's CAD/FEM domain.
- **URDF/SDF robotics rendering** — considered (joint articulation, FK, MoveIt2 integration in text-to-cad) and rejected for the same reason.
- **Interactive sketching with geometric constraints** — considered and rejected, not deferred. It is the single clearest "this is a modeling application now" feature, and CAD-Preview is a preview/inspect/prepare tool. More concretely: the numeric profile and curve forms are **not** a degraded mouse — they accept parametric variable expressions (`L*2`, `R*cos(i*360/N)`) that a click-to-place tool cannot express, so replacing them with drawing would trade away a distinguishing capability for a familiar one. Worth noting that SketchForge, a dedicated sketch application, still has no constraint solver either — building this would mean shipping the weak two-thirds of the feature.
- **Reference-image tracing underlay** — rejected. Its value is almost entirely to sketching, which is a non-goal above; and it would punch a hole in a real design property: every texture in the webview is a procedurally-drawn `CanvasTexture` (`geometryBuilder.ts`'s `dotTexture()`, `labelOverlay.ts`, the generated-SVG icon pipeline), a deliberately asset-free design driven by the webview's CSP. Injecting a user-supplied data-URL image trades that away for a workflow the tool doesn't have.
- **2D vector technical drawings via hidden-line removal** — **kernel-blocked, not deprioritized.** Every `HLRBRep_*` class is red in this OCCT WASM build: `HLRBRep_Algo`, `HLRBRep_PolyAlgo`, `HLRBRep_HLRToShape`, `HLRBRep_PolyHLRToShape`. `HLRAlgo_Projector` is green but is a low-level internal only reachable through them. Same class of finding as `Message_ProgressRange_1` and `Interface_Static.CVal` — recorded here so it isn't re-proposed. The narrow survivor, `HLRAppli_ReflectLines`, is queued as Tier 5 item 2.
- **3D text, engraving, and embossing** — **kernel-blocked.** `Font_BRepFont` and `Font_BRepTextBuilder` are both red in this build, so there is no path from a glyph to a `TopoDS_Shape`.
- **Parametric part generators (gears, threads, springs)** — rejected. Standard parts are something this tool should *source*, not *author*: `search_standard_parts`/`download_standard_part` already fetch real, verified geometry from step.parts as ordinary STEP files the existing pipeline opens (and, since the closed "Standard-parts browse and insert panel" item, so does the interactive sidebar). Authoring involute gear profiles is modeling-application scope.
