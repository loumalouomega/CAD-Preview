# Extension Host API

The extension host is a Node.js process. These modules run there — never in the webview.

## Module Index

| Module | Responsibility |
| --- | --- |
| `src/extension.ts` | VS Code extension entry point |
| `src/provider.ts` | Custom editor provider, webview lifecycle |
| `src/fileRouter.ts` | Map file extensions to render strategy; also the single declaration of `COMPARABLE_MESH_FORMATS` / `MeshParseFormat` (the mesh formats with a pure host-side triangle parser) |
| `src/exportTargets.ts` | Map a `FileRoute` to its compatible export formats |
| `src/occtService.ts` | Lazy WASM singleton, B-rep parsing + tessellation + export (op-list aware) |
| `src/occtOperations.ts` | Host-side OCCT edit engine — folds the op-list over a `TopoDS_Shape`, reporting one `OpOutcome` per op (a gracefully-skipped op calls a `fail(diagnostic, hint)` callback at its skip site instead of silently returning the unmodified shape) |
| `src/brepGProp.ts` | The single shared adaptive (`eps`-driven) `BRepGProp` integration wrappers — `volumePropertiesAdaptive`/`surfacePropertiesAdaptive` at `MASS_INTEGRATION_EPS = 1e-3` — replacing the under-integrating fixed-order overloads at every call site (vscode/WASM-free, pure) |
| `src/massProperties.ts` | Volume/area/length/CoG/inertia for a B-rep shape via OCCT `BRepGProp`, plus per-Part BOM rows (`computeBom`) over the same call shapes (vscode-free) |
| `src/entityFacts.ts` | Per-entity geometric facts (`inspect`), bbox-centre distance (`measure`), exact OCCT-precision distance/edge-length/radius (`measure_exact`), interference/clash overlap volume (`check_interference` + assembly-wide `check_interference_all`), whole-bucket selector resolution (`resolveBucketSelector`, rung 1 of Selector synthesis), and bulk entity fingerprinting + orchestration for entity-id rebinding for a B-rep shape (vscode-free) |
| `src/bomExport.ts` | Pure BOM row shape + tab-separated serializer (`bomTsv`) — split from `massProperties.ts` so MCP tool code can import it without dragging the WASM graph into tests |
| `src/entityRebind.ts` | Pure entity-id rebinding heuristic (bipartite nearest-neighbor matching, generalized from `modelDiff.ts`'s solid matcher to solid/face/edge/point) + `Part`-id remapping (vscode/OCCT-free, unit-tested) |
| `src/opBuckets.ts` | Build-time classification-bucket record shape + per-kind role vocabulary + display helpers (vscode/OCCT/THREE-free, unit-tested) — the OCCT half lives in `occtOperations.ts`'s `collectBucketForOp` |
| `src/selectorQuery.ts` | Re-executable selector queries (Selector-synthesis ladder, rungs 1–3): `BucketSelector` (rung-2 optional `filter`/`rank`) + `SceneSelector` (no bucket anchor; at least one of `filter`/`rank` required — a bare scene query names the whole model and is rejected), tolerant `validateSelectorQuery` gate (a malformed induced layer fails the whole query, never a half-understood predicate), `isBindableSelector` (pattern-instance producers refuse for buckets; vacuous-true for scene — matching across all copies dissolves the ambiguity), and `bucketReferenceIds` extraction (vscode/OCCT/THREE-free, unit-tested) |
| `src/selectorInduce.ts` | Constant-free-first induction (Selector synthesis): `induceSelector` turns a picked face set into the `SelectorQuery` re-executing to exactly that set — bare bucket when targets span the universe, else single qualitative leaves, rank, exact normal, greedy pairs with restarts, leaf+rank, area literals dead last; `executeInducedLayer` is the headless re-execution check (vscode/OCCT/THREE-free, unit-tested) |
| `resolvePartSelectors` (`entityFacts.ts`) | Part-level selector persistence (Phase A): re-resolves every part's stored `selector` against the current op list — one full replay shared by all parts plus one prefix replay per distinct bucket op — and overwrites `surfaces` only on an oracle-clean result (zero unresolved reference ids, non-empty surviving set), freezing the cache with a warning otherwise; the stored `selectorOpKind` must match the current op's kind or the part freezes rather than resolving against the wrong op |
| `resolveOpOperandQueries` (`opQueryResolve.ts`) | Op-operand query persistence (Phase B, the final Selector-synthesis piece): resolves `EditOp.targetQueries` host-side at replay, **fused into a sequential fold** (op N resolves against `shape(ops[0..N-1])` with earlier queries already resolved — a parallel map would resolve later queries against never-applied geometry). Bucket queries re-derive the producing op's recorded faces by prefix replay and re-match them via the shared `rebindEntities` machinery; scene queries filter/rank the whole current model. Guards freeze the field to its cached ids (query stripped from the replay copy, sidecar untouched) with a named warning: forward references, kind-tag mismatch, pattern producers, no bucket, unresolved/empty, scalar slots needing exactly one. Import graph is deliberately acyclic — never imports `occtService`/`entityFacts`; the face-fact read and predicate application are shallow local mirrors kept in lockstep by the smoke suite. `occtService` gates on `hasTargetQueries(ops)` (query-free documents pay nothing) and skips append-reuse for query documents (a query's producing index addresses the full list; the suffix fold's base is the previous shape) |
| `src/selectorPredicate.ts` | Induced face predicates + top-N rank for rung 2: `FacePredicate` leaves (planar, surfaceType, normal, area thresholds) over a minimal `FilterableFace`, `rankFaces` with deterministic `face-N` tie-break and null-areas-last, tolerant validators (vscode/OCCT/THREE-free, unit-tested — mirrors the `selectFilters.ts` registry vocabulary by value, since that module is THREE-dependent) |
| `src/xcafTree.ts` | XCAF assembly-hierarchy read (`readXcafAssembly`, OCCT-touching) + pure correlation against the real `solid-N` list (`correlateAssemblyTree`, unit-tested) |
| `src/xcafWrite.ts` | XCAF assembly-hierarchy + per-part-name STEP write (`buildXcafDocumentForExport`, OCCT-touching) + the read-side fallback (`readXcafFallbackShape`) for this build's AP242 document-wrapper quirk; `namesForSolids` is pure and unit-tested |
| `src/stepUnits.ts` | Pure text scan of a STEP file's `DATA` section for its declared length unit (vscode/OCCT-free, unit-tested) |
| `src/igesUnits.ts` | Sibling scanner for IGES's fixed-width Global-section unit flag — same purpose, different (positional, not named-entity) format (vscode/OCCT-free, unit-tested) |
| `src/lengthUnits.ts` | Shared `DisplayUnit` type + mm scale-factor table + `displayUnitFromUnitName` — backs both the webview's display-unit selector and unit-conversion-on-export (vscode/DOM/THREE-free) |
| `src/tessellationQuality.ts` | `draft`/`standard`/`fine` B-rep tessellation presets + `normalizeTessellationQuality` tolerance gate, backing `cadPreview.tessellationQuality` (vscode-free) |
| `src/meshExtract.ts` | Extract WebGL geometry (faces + edges) from OCCT shapes |
| `src/viewerDefaults.ts` | The `cadPreview.*` settings bag + `normalizeViewerDefaults` tolerance gate (vscode-free) |
| `src/partsStore.ts` | Read/write the `<model>.parts.json` sidecar (vscode fs) |
| `src/dirtyGuard.ts` | Refuses a sidecar write that would discard unsaved editor changes (fails open) |
| `src/viewDirections.ts` | The shared named-view vocabulary (6 cardinal + 8 isometric octants), aliases, and orbit math (pure, unit-tested) |
| `src/rayPick.ts` | Pure ray→entity picking over the tessellation (Möller–Trumbore faces, closest-approach edges/points; unit-tested) |
| `src/hiddenLineRemoval.ts` | Exact triangle-based hidden-line removal: feature edges split into visible and occluded 2D runs (pure, unit-tested) |
| `src/hitTestService.ts` | `hit_test`'s host-side pipeline function: loadBRep + rayPick, no browser |
| `src/scriptLibrary.ts` | Saved-script (macro) library parse/serialize + parameter-override merge (pure, unit-tested) |
| `src/holeStandards.ts` | ISO metric / UNC / UNF tapped-hole and clearance sizes (pure, unit-tested) |
| `src/partsSidecar.ts` | Pure parse/serialize for the parts sidecar (vscode-free, unit-tested) |
| `src/annotationsStore.ts` | Read/write the `<model>.annotations.json` sidecar (vscode fs) — pinned measurements |
| `src/annotationsSidecar.ts` | Pure parse/serialize for the annotations sidecar (vscode-free, unit-tested) |
| `src/planesStore.ts` | Read/write the `<model>.planes.json` sidecar (vscode fs) — named construction planes |
| `src/planesSidecar.ts` | Pure parse/serialize for the planes sidecar (vscode-free, unit-tested) |
| `src/editOps.ts` | The `EditOp` union + `validateEditOp` tolerance gate + the `OpOutcome`/`OutcomeFail` per-op replay-outcome types shared by both edit engines (vscode-free) |
| `src/svgImport.ts` | Pure SVG `<path d>` parser (regex extraction + a hand-written command interpreter covering M/L/H/V/C/S/Q/T/A/Z) into flattened polyline subpaths, feeding `addPolyline` ops — shared between the extension and webview bundles like `editOps.ts`/`protocol.ts` (vscode/DOM-free, unit-tested) |
| `src/csgImport.ts` | Pure OpenSCAD `.csg` parser (tokenizer + recursive-descent statements into a `CsgNode` AST, with a dedicated pre-scan recovering polyhedron `faces=[[..]]` boundaries that nested-vector flattening would lose) plus the `$fn`/`$fa`/`$fs` segment-count rule — the parse half of `.csg` import, shared kernel-side only (vscode/DOM/OCCT-free, unit-tested) |
| `src/csgModel.ts` | Kernel-side `.csg` geometry builder: walks `csgImport.ts`'s AST with live OCCT handles into one opaque base compound (like a STEP import, not an op history) — verified primitives/booleans, one uniform `gp_GTrsf` path for every transform node, sewn + closure-checked polyhedra (runs in the kernel worker) |
| `src/scadService.ts` | Host-side `.scad` → `.csg` conversion via a user-installed `openscad` binary (`execFile` argv, never a shell; `cwd` = source dir; temp output always removed; 120s kill) plus the `resolveEffectiveSource` choke every call site uses — downstream only ever sees `csg` (node builtins only, vscode/WASM-free, stub-binary-tested) |
| `src/dxfImport.ts` | Pure DXF model-space `ENTITIES` parser (group-code/value line-pair scan; `LINE`/`LWPOLYLINE`+bulge/`POLYLINE`/`CIRCLE`/`ARC`/`SPLINE`) feeding the existing `addLine`/`addPolyline`/`addCircleProfile`/`addArc`/`addSpline` ops — same pure/shared-bundle convention as `svgImport.ts`, Y-up native, flat at z=0 (vscode/DOM-free, unit-tested) |
| `src/dxfSilhouette.ts` | Pure DXF writer for silhouette export over the SAME segment list `svgSilhouette.ts` serializes (imports its `viewBasis`; chained runs → `LWPOLYLINE`s, singletons → `LINE`s), selected by `exportSvgSilhouetteRequest`'s format pick |
| `src/editsStore.ts` | Read/write the `<model>.edits.json` sidecar (vscode fs) |
| `src/editsSidecar.ts` | Pure parse/serialize for the edits sidecar (vscode-free, unit-tested) |
| `src/paramExpr.ts` | Parametric expression evaluator + `exprs` field-path addressing (vscode/DOM-free, unit-tested) |
| `src/editVariables.ts` | `ParamVariable` validate/evaluate + `resolveEditOps` op resolver (vscode/DOM-free, unit-tested) |
| `src/gmshService.ts` | Lazy GMSH-wasm singleton, FE mesh generation + `.geo_unrolled` export |
| `src/meshQuality.ts` | Pure per-element quality summary math (min/mean/histogram) (vscode/WASM-free, unit-tested) |
| `src/gmshElementTypes.ts` | Single source of truth for gmsh element types: stride/faces/Kratos mapping + pure overlay-triangulation helpers (vscode/WASM-free, unit-tested) |
| `src/mdpaWriter.ts` | Pure Kratos MDPA serializer over the generic `MdpaCell` catalogue (vscode/WASM-free, unit-tested) |
| `src/meshOptions.ts` | The `MeshOptions` bag + `validateMeshOptions` tolerance gate + `gmshShapeOptions` (vscode-free) |
| `src/meshOptionsStore.ts` | Read/write the `<model>.mesh.json` sidecar + generated `<model>.geo` (vscode fs) |
| `src/meshOptionsSidecar.ts` | Pure parse/serialize for the mesh-options sidecar + `.geo` script generation (vscode-free, unit-tested) |
| `src/viewStateStore.ts` | Read/write the `<model>.view.json` sidecar (vscode fs) |
| `src/viewStateSidecar.ts` | Pure parse/serialize for the view-state sidecar (vscode-free, unit-tested) |
| `src/protocol.ts` | Shared message types and buffer encoding |
| `src/spaceMouse.ts` | Host-side SpaceMouse 6DOF reader (roadmap Tier 2 item 2): lazy `require("node-hid")`, usage-page-ranked discovery, report streaming with 3s reconnect, forwards raw motion to the active session (extension host only) |
| `src/spaceMouseRank.ts` | Pure HID discovery ranking — multi-axis usage outranks vendor, mouse/keyboard decoys rejected, vendor-only matches UNPROVEN (vscode/DOM/HID-free, unit-tested) |
| `src/hidDescriptor.ts` | Pure HID report-descriptor walker answering "declares multi-axis?" (vscode/DOM/HID-free, unit-tested) |
| `src/toolbarIcons.ts` | **Generated** — monochrome, `currentColor`-based toolbar/panel icons (vscode-free) |
| `src/nonce.ts` | Shared CSP script-nonce generator, used by every webview HTML builder |
| `src/changelogParser.ts` | Pure `CHANGELOG.md` parser + markdown→HTML renderer for the What's New panel (vscode-free, unit-tested) |
| `src/whatsNew.ts` | Version-upgrade check (`context.globalState`) + the standalone "What's New" webview panel |
| `src/modelDiff.ts` | Pure bounding-box-centroid + volume solid-matching heuristic for Compare Models (vscode/OCCT-free, unit-tested) |
| `src/modelDiffHost.ts` | Dispatches `CompareSource` (B-rep via OCCT, or STL/OBJ/PLY/glTF via their pure parsers) per side to signature extraction + `compareModels()`, feeding `modelDiff.ts`'s matcher |
| `src/modelComparePanel.ts` | Standalone "Compare Models" webview panel + the `cad-preview.compareModels` command flow |
| `src/stlParser.ts` | Pure host-side STL parser (binary + ASCII, auto-detected) into a flat triangle soup (vscode/OCCT/THREE-free, unit-tested) |
| `src/meshComponents.ts` | Pure triangle-soup helpers: vertex welding, connected-component ("solid") segmentation, bbox, area, signed volume, and the shared `edgeKey` (vscode/OCCT/THREE-free, unit-tested) |
| `src/stlSolidSignatures.ts` | Wires `stlParser.ts` + `meshComponents.ts` into `SolidSignature[]` for Compare Models' STL side (pure, unit-tested) |
| `src/objParser.ts` | Pure host-side OBJ parser (already shared-vertex indexed — no welding needed) into a flat indexed mesh (vscode/OCCT/THREE-free, unit-tested) |
| `src/objSolidSignatures.ts` | Wires `objParser.ts` + `meshComponents.ts` into `SolidSignature[]` for Compare Models' OBJ side (pure, unit-tested) |
| `src/plyParser.ts` | Pure host-side PLY parser (ASCII + both binary endiannesses, one shared header parser) into a flat indexed mesh (vscode/OCCT/THREE-free, unit-tested) |
| `src/plySolidSignatures.ts` | Wires `plyParser.ts` + `meshComponents.ts` into `SolidSignature[]` for Compare Models' PLY side (pure, unit-tested) |
| `src/gltfParser.ts` | Pure host-side glTF 2.0 / GLB parser (geometry only — node world matrices applied, then welded) into a flat indexed mesh (vscode/OCCT/THREE-free, unit-tested **and cross-validated against three.js's own `GLTFLoader`**) |
| `src/gltfSolidSignatures.ts` | Wires `gltfParser.ts` + `meshComponents.ts` into `SolidSignature[]` for Compare Models' glTF side (pure, unit-tested) |
| `src/silhouetteEdges.ts` | Pure silhouette-edge extraction from a welded indexed mesh, given a view direction (vscode/OCCT/THREE-free, unit-tested) |
| `src/svgSilhouette.ts` | Pure orthographic projection + SVG serialization — the codebase's first runtime SVG *writer* (vscode/OCCT/THREE-free, unit-tested) |
| `src/svgSilhouetteHost.ts` | OCCT-touching orchestrator for silhouette SVG export: any `CompareSource` → triangles → `silhouetteEdges` → `svgSilhouette` (runs in the kernel worker) |
| `src/stepPartsService.ts` | `searchStandardParts`/`downloadStandardPart` over the hosted [step.parts](https://www.step.parts) REST API — this extension's only external network dependency; a `{available: false, reason}` result on any network/API failure, never a thrown error. Shared by the `search_standard_parts`/`download_standard_part` MCP tools AND the interactive Standard Parts sidebar panel (`provider.ts`'s `standardPartsSearchRequest`/`standardPartsInsertRequest` handlers) — one HTTP client, two call sites |
| `src/mcpServer.ts` | Standalone stdio MCP server entry (own `dist/mcp-server.js` bundle, not part of the extension) |
| `src/mcpTools.ts` | MCP tool handlers over the headless pipeline (MCP-SDK/WASM-free, unit-tested) — including stateless discovery (`list_workspace_models`) and read-only prefix replay (`render_ops_prefix`) |
| `src/mcpSidecars.ts` | Node-fs sidecar store for the MCP server — mirrors the `*Store.ts` wrappers and owns every companion-file path derivation incl. `<model>.view.json` (vscode-free, unit-tested) |

---

## `src/extension.ts`

Entry point for VS Code extension activation.

```typescript
export function activate(context: vscode.ExtensionContext): void
export function deactivate(): void
```

`activate` calls `CadPreviewProvider.register(context)`, then fires `maybeShowWhatsNew(context)` (see `src/whatsNew.ts` below) without awaiting it — a fire-and-forget check that must never delay or block activation. `deactivate` is a no-op (resources are disposed with the webview panels via VS Code's disposable system).

---

## `src/whatsNew.ts` and `src/changelogParser.ts`

Shows a "What's New" webview panel after a version upgrade, so users notice what changed instead of silently getting a new build.

```typescript
// changelogParser.ts (pure)
export interface ChangelogEntry { version: string; date: string; bodyMarkdown: string }
export function parseChangelog(text: string): ChangelogEntry[]
export function compareVersions(a: string, b: string): number
export function entriesSince(entries: readonly ChangelogEntry[], lastVersion: string): ChangelogEntry[]
export function renderEntryHtml(entry: ChangelogEntry): string

// whatsNew.ts (vscode-dependent)
export async function maybeShowWhatsNew(context: vscode.ExtensionContext): Promise<void>
export async function showLatestWhatsNew(context: vscode.ExtensionContext): Promise<void>
export function showWhatsNewPanel(context, version, entries: readonly ChangelogEntry[]): void
```

- `maybeShowWhatsNew` runs once per `activate()`. It compares `context.extension.packageJSON.version` against the version stashed in `context.globalState` under `"cadPreview.lastVersion"` (this project's first use of `globalState`/`workspaceState` — everything else persists via sidecar files instead). On a fresh install (no stored value) it silently records the current version and shows nothing — there's nothing to diff against yet. On an upgrade, it reads and parses the repo-root `CHANGELOG.md` (already shipped in the packaged `.vsix` — nothing in `.vscodeignore` excludes it) and shows every entry newer than the last-seen version, falling back to just the latest entry if none qualify (e.g. the stored version predates everything still in the file). A same version or a downgrade just updates the stored value, silently. Every failure path (missing/corrupt `CHANGELOG.md`, anything else) is swallowed — this check must never throw out of `activate()`.
- `showLatestWhatsNew` backs the manual `cad-preview.whatsNew` command (registered in `provider.ts`, standalone like `cad-preview.open`) — it always shows the **full** changelog, not just what's new since last seen.
- `showWhatsNewPanel` was the first standalone `vscode.window.createWebviewPanel` in this extension (`src/modelComparePanel.ts`, below, is the second) — every other webview goes through `CustomReadonlyEditorProvider`. It opens in `vscode.ViewColumn.Beside` (never `Active`), so it can never contend with a CAD file's own custom-editor tab for the same slot when both open around the same time. It builds its own small nonce-gated CSP HTML string (shares `getNonce()` from `src/nonce.ts` with `provider.ts`'s `getHtml`, styled entirely with `var(--vscode-*)` theme variables, no external stylesheet needed) and never touches `CHANGELOG.md` — this feature only ever reads it.

---

## `src/modelDiff.ts`, `src/modelDiffHost.ts`, `src/modelComparePanel.ts`, and the mesh-format parser quartet

"Compare Models" (`doc/roadmap.md`'s P3 #13) resolves the roadmap's own open design question — "how do two documents share one custom-editor architecture" — by not needing a new architecture at all: `provider.ts` already supports N independently-open documents (confirmed: `resolveCustomEditor` has no Map-keyed singleton, just N independent per-call closures), and VS Code's Custom Editor API already lets a user place two `cad-preview.mesh` tabs side by side. What was actually missing was the *diff computation*, which this group adds as a host-only feature with no new `Viewer` work — originally B-rep only, since extended to STL (roadmap "Mesh-source model comparison", closed), then OBJ/PLY (roadmap item, closed), and finally glTF/GLB (roadmap item, closed) via four parallel host-side parsers (`src/stlParser.ts`/`src/objParser.ts`/`src/plyParser.ts`/`src/gltfParser.ts`, each paired with its own `*SolidSignatures.ts` wiring module, all pure) sharing one geometry toolkit, `src/meshComponents.ts`. **The meshio-only formats (VTK/VTU/MED/CGNS/Exodus/XDMF/MDPA/OpenFOAM) are now the only unsupported family** — meshio++'s WASM module converts them to a boundary surface for display but never hands a triangle array back to JS.

```typescript
// modelDiff.ts (pure)
interface SolidSignature { id: string; centre: Vec3; diagonal: number; volume: number }
interface SolidMatch { a: SolidSignature; b: SolidSignature; centreDistance: number; volumeDeltaPct: number }
interface ModelDiff { added: SolidSignature[]; removed: SolidSignature[]; matched: SolidMatch[] }
function diffSolids(a: SolidSignature[], b: SolidSignature[], toleranceAbs: number): ModelDiff

// modelDiffHost.ts
type CompareSource =
  | { kind: "brep"; bytes: Uint8Array; format: BRepFormat; ops: EditOp[] }
  | { kind: "stl"; bytes: Uint8Array }
  | { kind: "obj"; bytes: Uint8Array }
  | { kind: "ply"; bytes: Uint8Array }
  | { kind: "gltf"; bytes: Uint8Array; externalBuffers?: GltfExternalBuffers }
async function compareModels(extensionPath: string, a: CompareSource, b: CompareSource, toleranceFrac = 1e-3): Promise<ModelDiff>

// modelComparePanel.ts
async function runCompareModelsCommand(context: vscode.ExtensionContext, defaultUri?: vscode.Uri): Promise<void>

// stlParser.ts / meshComponents.ts / stlSolidSignatures.ts (all pure)
function parseStl(bytes: Uint8Array): Float32Array   // flat, ungrouped triangle soup — 9 floats/triangle
function scaleStlBytes(bytes: Uint8Array, factor: number): Uint8Array   // rescales + re-serializes as ASCII STL
function weldTriangleSoup(soup: Float32Array, epsilon = 1e-5): { positions: Float32Array; indices: Uint32Array }
function connectedComponents(indices: Uint32Array): number[][]   // one triangle-index array per "solid"
function boundsOfTriangles(positions, indices, triangles: number[]): { min: Vec3; max: Vec3 } | undefined
function volumeOfTriangles(positions, indices, triangles: number[]): number
function extractStlSolidSignatures(bytes: Uint8Array): { signatures: SolidSignature[]; diagonal: number }

// objParser.ts / objSolidSignatures.ts (both pure — no weldTriangleSoup step, OBJ is already indexed)
function parseObj(bytes: Uint8Array): { positions: Float32Array; indices: Uint32Array }
function extractObjSolidSignatures(bytes: Uint8Array): { signatures: SolidSignature[]; diagonal: number }

// plyParser.ts / plySolidSignatures.ts (both pure — no weldTriangleSoup step, PLY is already indexed)
function parsePly(bytes: Uint8Array): { positions: Float32Array; indices: Uint32Array }
function extractPlySolidSignatures(bytes: Uint8Array): { signatures: SolidSignature[]; diagonal: number }

// gltfParser.ts / gltfSolidSignatures.ts (both pure — welded, unlike OBJ/PLY: see below)
type GltfExternalBuffers = Record<string, Uint8Array>   // sibling .bin files keyed by their raw `buffers[].uri`
function listExternalBufferUris(bytes: Uint8Array): string[]   // what a caller must read from beside the model
function parseGltf(bytes: Uint8Array, external: GltfExternalBuffers = {}): WeldedMesh
function extractGltfSolidSignatures(bytes: Uint8Array, external?: GltfExternalBuffers): { signatures: SolidSignature[]; diagonal: number }
```

- `diffSolids` is a greedy nearest-neighbor bipartite match by centroid distance (primary) with volume as a tie-breaker, capped by `toleranceAbs`. **It never collapses a match into a binary moved/unchanged verdict** — every `SolidMatch` carries its raw `centreDistance`/`volumeDeltaPct`, so the panel and the MCP tool can show the heuristic's actual confidence instead of hiding it behind a guess. This is the concrete answer to the roadmap's other open question ("how to present the diff without misleading false matches"). Needs zero changes for any mesh format — it only ever sees plain `SolidSignature[]`, indifferent to which extractor produced them.
- `compareModels(extensionPath, a, b, toleranceFrac?)` takes a `CompareSource` per side and dispatches: `{kind: "brep", ...}` goes through `extractBrepSolidSignatures` (module-private — reads the file independently via the existing `readShape()`, no shared state, no webview; resolves each solid's signature via the already-shared `collectSolids`/`bboxCenter`/(the **exported**, previously module-private) `bboxDiagonal` from `occtOperations.ts`, plus a volume via the same adaptive `BRepGProp` call shape (`src/brepGProp.ts`'s `volumePropertiesAdaptive`) every other volume site uses); `{kind: "stl"/"obj"/"ply", ...}` each go through their own `extract*SolidSignatures` (all pure, synchronous, no WASM handles to clean up). Any side can be any kind, in any combination. `toleranceFrac` (default `1e-3`) is multiplied by the **larger** of the two models' whole-shape diagonals to get the absolute centroid-distance tolerance — mirroring `gmshPartsMap.ts`'s existing tolerance-fraction convention.
- **The STL trio, verified against a real file (`examples/STL/cube.stl`, a 10×10×10 cube) via `npm run mcp:smoke`, not just unit-tested:**
  - `parseStl` auto-detects binary vs. ASCII by exact expected-size match (`84 + declaredTriangleCount * 50`) against the binary header's own triangle count — NOT by sniffing the header text for `"solid"`, the classic trap (a binary file's free-form 80-byte header may itself start with that word; a unit test builds a binary fixture with exactly that trap baked into its header to confirm detection isn't fooled).
  - `scaleStlBytes(bytes, factor)` (added for the FE Mesh panel's Gmsh-export unit conversion, not Compare Models — see CLAUDE.md's Meshing section) is the host-side STL vertex scaler this file's earlier history flagged as missing: parses via `parseStl`, multiplies every coordinate by `factor`, and re-serializes as ASCII STL — facet normals are always **recomputed** from the (post-scale) triangle winding via a cross product, never trusted from the input file, matching `parseStl`'s own "recomputed elsewhere, never trusted from the file" convention (a uniform scale can't flip winding, so this is equivalent to scaling stored normals, just simpler).
  - `weldTriangleSoup` dedups STL's unindexed, vertex-per-triangle-instance format via a quantized-position hash — the same technique the webview's `meshFacets.ts`'s `canonOf` already uses for the identical problem.
  - `connectedComponents` is a plain edge-adjacency-map + BFS flood-fill with **no** angle gate (any two triangles sharing an edge are the same component) — the scaffolding is the same shape as `meshFacets.ts`'s `segmentCoplanarFacets`, which solves the *opposite* problem (splitting one solid into flat faces by gating the flood-fill on face-normal angle).
  - `volumeOfTriangles` is the signed-tetrahedra-vs-origin sum, the same formula `gmshElementTypes.ts`'s `signedVolume` and the webview's `meshMassProperties.ts` already use elsewhere in this codebase — verified against a unit box (volume 1) and, as a deliberate cross-engine check, the *same* 2×3×4 box (volume 24) `CLAUDE.md`'s `BRepGProp` verification already used, confirming both engines agree.
  - `extractStlSolidSignatures` wires the above into `SolidSignature[]`, ids `solid-0`/`solid-1`/… by first-encountered-triangle order.
- **The OBJ/PLY pair, verified against real files (`examples/OBJ/cube.obj`, `examples/PLY/cube.ply` — both a real unit cube) via `npm run mcp:smoke`:** neither needs a `weldTriangleSoup()` step — both formats already hand over shared-vertex indices natively (OBJ's `f` lines, PLY's `vertex_indices` list property), so `parseObj`/`parsePly` build the indexed mesh directly and `objSolidSignatures.ts`/`plySolidSignatures.ts` otherwise mirror `stlSolidSignatures.ts` exactly. `parsePly` additionally handles PLY's two binary encodings (`binary_little_endian`/`binary_big_endian`, auto- detected from the header's `format` line) over one shared header parser — the header/body byte boundary is found by decoding the WHOLE buffer as `latin1` first (1 byte = 1 char, so a `latin1` char index IS the real byte offset, safe even though the body itself may be binary) and locating the newline after `end_header`; every declared `property` this codebase doesn't care about (normals, colour, …) is still correctly consumed by byte-width so the read cursor stays in sync for the next record. See CLAUDE.md's "Model comparison" section for the full verification trail.
- `runCompareModelsCommand` backs the standalone `cad-preview.compareModels` command (registered in `provider.ts` like `cad-preview.open`/`whatsNew`, passing `this.activeSession?.uri` as `defaultUri` so a focused tab's file is offered as "A" automatically). It picks two files via `showOpenDialog` (`COMPARE_FILTER`: STEP/IGES/BREP/STL/OBJ/PLY/glTF/GLB), rejects up front with a clear `showErrorMessage` if either resolved file is neither `FileRoute.strategy === "occt"` nor one of the comparable mesh formats (`COMPARABLE_MESH_FORMATS = {stl, obj, ply, gltf}`, imported from `fileRouter.ts` — only the meshio formats still have no host-side geometry to independently re-derive centroids/volumes from), reads each file's `.edits.json` sidecar via the existing `readEdits()` — for a B-rep source this bakes the edits in (consistent with how everything else in this codebase treats "the model" as base+edits); for a mesh-format source edits can NOT be baked in (no host-side mesh edit engine exists), so a pending-ops warning naming the actual format is collected instead and shown as a `⚠` banner in the report — and renders the result via `showModelDiffPanel` (a second standalone `vscode.window.createWebviewPanel`, `enableScripts: false`, static HTML tables, no script/nonce needed since there's no interactivity beyond closing the tab).
- **The glTF parser is the one that welds, and the one with a cross-validation test.** Unlike `parseObj`/`parsePly`, `parseGltf` runs `weldTriangleSoup` on its output — required, not an optimization: every primitive and every node instance is its own independent index space, and exporters routinely split one watertight solid across several primitives (one per material) with duplicated vertices along the seam, so without welding a per-material-split cube would report six open sheets with no volume instead of one closed solid — precisely the confidently-wrong answer Compare Models exists to avoid. The accepted consequence is identical to STL's: a "solid" is a connected component, so two objects positioned to touch merge into one. What made hand-rolling this defensible at all (it was previously scoped out for exactly this risk) is `src/gltfParser.crossvalidation.test.ts`, which checks every fixture's parsed geometry against **three.js's own `GLTFLoader`** rather than against hand-computed expectations. Scope is geometry only — `POSITION` and indices, transformed by each node's world matrix; materials, textures, cameras, skins, animations, and morph targets are ignored. Two inputs are rejected outright with a clear error rather than silently mis-parsed: a file whose `extensionsRequired` names `KHR_draco_mesh_compression` or `EXT_meshopt_compression` (a deny-list, deliberately not an allow-list against `extensionsUsed` — nearly every real file declares geometry-irrelevant `KHR_materials_*`/`KHR_texture_transform`/… extensions this parser handles perfectly by ignoring, and `KHR_mesh_quantization` is genuinely supported), and an unreadable sibling buffer. External `.bin` buffers are the caller's job to supply: `listExternalBufferUris(bytes)` names what `parseGltf` will need, and both `provider.ts` and `mcpTools.ts` resolve them relative to the model file.
- **meshio-only formats (VTK/VTU/MED/CGNS/Exodus/XDMF/MDPA/OpenFOAM) remain the sole unsupported family**, because meshio++'s WASM module never exposes a triangle array back to JS. A compare against one of these isn't attempted at all (a clear rejection message, not a crash) — see `mcpTools.ts`'s `compareModelsTool` for the identical gate on the MCP side.
- **No merged 3D scene in v1** — `Viewer` is hard-wired to one `model: THREE.Object3D | null` (`setModel()` replaces, never adds); hosting two models simultaneously in one view would need real new `Viewer`/protocol work for comparatively little payoff over a text report, so this stage ships the report only. Side-by-side *visual* comparison already works today by opening both files in separate tabs and using VS Code's native split-editor UI — no code change needed for that.

---

## `src/silhouetteEdges.ts`, `src/svgSilhouette.ts`, and `src/svgSilhouetteHost.ts`

Silhouette SVG export (roadmap item, closed) — a 2D **outline drawing** of any source with host-side geometry, reached from **File ▸ Export Silhouette SVG…** / the `cad-preview.exportSvg` command (`provider.ts`'s `handleExportSvg`, via the `exportSvgRequest` protocol message) and from the MCP server's `export_svg_silhouette` tool. Same pure-core / thin-OCCT-shell split as the Compare Models group above, and it reuses that group's `CompareSource` union verbatim rather than inventing a parallel one.

```typescript
// silhouetteEdges.ts (pure)
function silhouetteEdges(positions: Float32Array, indices: Uint32Array, direction: Vec3): Array<[number, number]>

// svgSilhouette.ts (pure)
interface ViewBasis { right: Vec3; up: Vec3; forward: Vec3 }
interface ViewSpec { direction: Vec3; up?: Vec3 }
interface SvgOptions { strokeWidth?: number; marginFrac?: number; stroke?: string; title?: string }
interface SvgResult { svg: string; segmentCount: number }
const SVG_VIEWS: Record<string, { direction: [number, number, number]; up?: [number, number, number] }>
function viewBasis(direction: Vec3, up: Vec3 = [0, 1, 0]): ViewBasis
function silhouetteSvg(positions: Float32Array, edges: Array<[number, number]>, view: ViewSpec, options?: SvgOptions): SvgResult
function polylinesSvg(polylines: Float32Array[], view: ViewSpec, options?: SvgOptions): SvgResult
function scalePositions(positions: Float32Array, factor: number): Float32Array

// svgSilhouetteHost.ts (OCCT-touching; runs in the kernel worker)
interface SvgSilhouetteOptions { direction: Vec3; up?: Vec3; unit?: DisplayUnit; strokeWidth?: number; title?: string; quality?: TessellationQuality }
interface SvgSilhouetteResult { svg: string; segmentCount: number; triangleCount: number; warnings: string[] }
async function exportSvgSilhouette(extensionPath: string, source: CompareSource, options: SvgSilhouetteOptions): Promise<SvgSilhouetteResult>
```

- **`silhouetteEdges`** is the whole algorithm, and it needs no kernel at all. An edge is kept when its two adjacent triangles **disagree** about facing the viewer (the silhouette proper), when exactly one triangle references it (an open boundary — this is what lets an unclosed STL/glTF still draw as something sensible rather than nothing), or when 3+ triangles do (non-manifold, always a genuine feature of the geometry — the same judgement `meshTopology.ts` already applies). `direction` follows this codebase's own `ViewState.viewDirection` convention (model → camera), so a triangle is front-facing when its normal has a positive dot product with it; a triangle exactly edge-on (`dot === 0`) counts as back-facing, which is deterministic rather than arbitrary and puts exactly one silhouette line along a cylinder's tangent instead of zero or two. It shares `meshComponents.ts`'s **`edgeKey`** and its edge→triangle adjacency scaffolding — `edgeKey` was module-private to `meshTopology.ts` before this; it now lives in `meshComponents.ts` (the geometry toolkit both files already depend on) and `meshTopology.ts` imports it from there, so the two adjacency builders can't drift.
- **Known limitation, documented rather than fixed:** the facing test assumes consistent triangle winding across the mesh. A mixed-winding mesh (some triangles clockwise, some counter-clockwise, as some exporters and hand-edited files produce) reports spurious interior edges, because the test flips with the winding. There is no cheap, reliable way to repair winding for an arbitrary open mesh, so the honest thing is to say so — the output is a review/illustration artifact, not a certified drawing.
- **`svgSilhouette.ts` is this codebase's first runtime SVG *writer*.** `svgImport.ts` *reads* SVG paths and `toolbarIcons.ts`/`opIcons.ts` embed markup generated offline by the TikZ pipeline, but nothing produced SVG at runtime before. The output is deliberately minimal — one `<path>`, no `<style>`, no script, no external references — so it embeds anywhere and matches this codebase's asset-free posture. **1 SVG user unit = 1 model unit**, with the document's physical `width`/`height` in millimetres, so a drawing exported from a native (mm) model prints 1:1. `strokeWidth` defaults to `max(width, height) / 500` so lines stay proportionate at any model scale and in any converted unit. `polylinesSvg` is the sibling entry point for already-computed polylines (same projection/serialization, different input shape).
- **`exportSvgSilhouette`** dispatches per `CompareSource.kind`: a B-rep source is read via the existing `readShape()`, has its ops replayed via `applyEditsBRep` (edits baked in, consistent with every other B-rep path), is tessellated via `tessellateByGroup`, and is then **welded** — the weld is required, not an optimization, because `tessellateByGroup` returns one independent index space per face, so without it every face boundary looks like an open-boundary edge and the "silhouette" degenerates into a full wireframe of every face in the model. An STL/OBJ/PLY/glTF source goes straight through the matching pure parser on the raw file bytes (edits **not** baked in — no host-side mesh edit engine exists). Unit conversion is a real coordinate scale applied via `scalePositions` before projection, using `lengthUnits.ts`'s `unitScaleFactor`, exactly like every other export. `quality` defaults to **`"fine"`** rather than `"standard"` for B-rep sources: the silhouette's smoothness *is* the tessellation's resolution here, with no shading or normals to hide faceting the way a rendered view does.
- **`HLRAppli_ReflectLines` was probed against the live WASM and deliberately not used.** The roadmap listed it as the one surviving door to a kernel-computed outline (every `HLRBRep_*` class is red in this build), and it does genuinely work — the unsuffixed constructor takes a `TopoDS_Shape`, `SetAxes`/`Perform`/`GetResult` are all bound and functional (249 ms on `examples/STP/bull.stp`, returning a non-null compound this codebase's own `enumerateEdges` reads as 25 edges). It was rejected because **the resulting drawing is worse**, which is only visible by looking at it: rendered side by side against the tessellation silhouette for the same view, `GetResult()` produced the outer boundary and a few fragments while missing the part's circular holes and interior cutout entirely, where the tessellation path drew all of them. `GetResult()` returns reflect lines only; the sharp feature edges live behind `GetCompoundOf3dEdges(type, …)`, whose `type` argument is an `HLRBRep_TypeOfResultingEdge` from the entirely-red `HLRBRep_*` family — calling it throws. So the one filter that would make the kernel path competitive is unreachable: the familiar "green in the manifest is necessary but not sufficient" pattern. The tessellation path also works for STL/OBJ/PLY/glTF, which ReflectLines never could, and needs no WASM at all for those.
- **There is no hidden-line removal, and the docs say so everywhere this surfaces.** Back-facing geometry isn't drawn, but neither are interior feature edges that don't lie on a silhouette — see the MCP tool description, `doc/mcp-server.md`, `doc/file-formats.md`, and `doc/getting-started.md`, all of which carry the same framing.
- **Wired through the kernel worker like every other OCCT-touching function** — added to `mcpTools.ts`'s `Pipeline` interface, `kernelWorker.ts`'s typed `handlers` dispatch table, and `kernelClient.ts`'s `callKernel`-backed object literal (the same 4-touch-point pattern `checkMeshHealth`/`promoteMeshToBrep` established).

---

## `src/viewerDefaults.ts`

The cross-document defaults sourced from the `cadPreview.*` VS Code settings (`contributes.configuration` in `package.json`) — pure and `vscode`-free (mirrors `meshOptions.ts`'s parse-vs-store split).

```typescript
type MeshSizePreset = 'coarse' | 'medium' | 'fine'
type UpAxis = 'y' | 'z'

interface ViewerDefaults {
  background: string          // CSS hex color
  meshSizePreset: MeshSizePreset
  showGridAndAxes: boolean
  upAxis: UpAxis
}

const DEFAULT_VIEWER_DEFAULTS: ViewerDefaults
function normalizeViewerDefaults(raw: unknown): ViewerDefaults
```

`normalizeViewerDefaults` is the single tolerance gate, same clamp-per-field style as `validateMeshOptions` — each field individually falls back to its default rather than rejecting the whole object. `provider.ts`'s `sendViewerDefaults` reads `workspace.getConfiguration("cadPreview")`, passes it through this function, and posts the result as a `viewerDefaults` message in the `ready` handshake. These are **defaults only** — a persisted per-document `.mesh.json` value or the toolbar Grid toggle always wins once set; see [Webview API](./webview-api.md)'s `Viewer.applyDefaults`.

---

## `src/massProperties.ts`

Volume/area/length + center-of-mass + moments-of-inertia for a B-rep shape, via OCCT `BRepGProp` — a new OCCT surface for this codebase (no prior `BRepGProp`/`GProp_GProps` usage anywhere). `vscode`-free (usable from both `provider.ts` and `mcpTools.ts`), following `occtService.ts`'s read-parse-cleanup skeleton.

```typescript
interface MomentsOfInertia { ixx: number; iyy: number; izz: number; ixy: number; ixz: number; iyz: number }

interface MassProperties {
  volume: number | null        // whole model or a solid-N only — never face-N/edge-N
  area: number | null          // whole model, a solid-N (boundary area), or a face-N
  length: number | null        // a single edge-N only
  centerOfMass: [number, number, number] | null
  momentsOfInertia: MomentsOfInertia | null   // about the CENTROID, not the origin
}

async function computeMassProperties(
  extensionPath: string,
  bytes: Uint8Array,
  format: 'step' | 'iges' | 'brep',
  ops: EditOp[],
  entityId: string | null   // null = whole model; "solid-N"/"face-N"/"edge-N" = one entity
): Promise<MassProperties>
```

Re-parses `bytes` and replays `ops` fresh on every call — like every other B-rep read path in this codebase, there is no shape/session cache. Resolves `entityId` via the **already-shared** `collectSolids`/`collectFaces`/ `collectEdges` (`occtOperations.ts`) — the same id-resolution helpers every edit op already uses. Volume is only ever computed for the whole model or a `solid-N` (guaranteed closed by `collectSolids`'s `TopAbs_SOLID` explorer) — never for `face-N`/`edge-N` — sidestepping the documented open-shell "plausible-looking but wrong" `VolumeProperties` trap noted in `occtOperations.ts`'s sewing-verification comment.

**OCCT `BRepGProp` API, verified against the live WASM** (brute-force overload/arg-count probing, the same convention as every other OCCT call recorded in `CLAUDE.md`): `new oc.GProp_GProps_1()` is the *only* accessible constructor (the unsuffixed `GProp_GProps` has none). Volume and boundary-area integration go through **`src/brepGProp.ts`'s adaptive wrappers** — `VolumeProperties2(shape, props, eps, onlyClosed, skipShared)` / `SurfaceProperties2(shape, props, eps, skipShared)` at `MASS_INTEGRATION_EPS = 1e-3` — NOT the fixed-order `_1` forms, which under-integrate B-spline-trimmed faces (the embind-renamed adaptive variants exist because plain-overload names collide on `Standard_Real Eps`; probed live: both work, the 2×3×4 box still integrates to exactly 24 / area 52, and `bull.stp` shows a real +0.015% volume delta vs fixed-order — see `brepGProp.ts`'s doc comment for the numbers and why all sites were swapped uniformly). `oc.BRepGProp.LinearProperties(shape, props, skipShared, ?)` is **unsuffixed** but still needs exactly 4 args in this binding — and must only ever be called on a single already-resolved `TopoDS_Edge`, never the whole shape (over a whole B-rep shape it double-counts every edge shared by two faces). `props.Mass()` holds volume/area/length depending which `*Properties` call ran; `props.CentreOfMass()` returns a `gp_Pnt`-like handle (`.X()/.Y()/.Z()`, needs `.delete()`); `props.MatrixOfInertia()` returns a `gp_Mat`-like handle (`.Value(r, c)`, 1-based, needs `.delete()`) — verified numerically equal to the standard box inertia formula computed **about the centroid** (e.g. `Ixx = 50` for the same box, matching `(1/12)·24·(3²+4²)`), not about the origin.

`provider.ts` handles `massPropertiesRequest` for B-rep sources only (mesh sources compute the equivalent client-side in the webview — see [Webview API](./webview-api.md)); `mcpTools.ts`'s `get_mass_properties` follows the identical B-rep-only gate, returning `{supported: false}` with a warning for mesh formats.

**`computeBom(extensionPath, bytes, format, ops, parts: Part[])`** (roadmap "BOM export from Parts", closed) is the loop-and-tabulate sibling: one row per Part over a single parse/replay, summing member solids' volumes and areas through the exact adaptive call shapes above. Volumes are deliberately **sum-of-parts** — two overlapping members each count in full (the BOM/procurement convention: each instance is material you'd order), which also avoids a per-part boolean entirely; it is NOT the combined-solid volume, and the smoke test pins that distinction analytically (two overlapping 1000-unit boxes row at exactly 2000). A part resolving to zero solids gets `volume`/`area` `null` plus per-row `unresolvedIds`; nothing throws. The pure row shape (`BomRow`) and the tab-separated serializer (`bomTsv`, header + 4-decimal display rounding, empty cell for an unmeasurable value) live in **`src/bomExport.ts`**, split out for the same reason as every other pure/impure pair here: `mcpTools.ts` must stay importable under vitest with no `.wasm` anywhere in its graph, and it needs `bomTsv` as a VALUE while only `massProperties.ts` may host OCCT calls.

---

## `src/entityFacts.ts`

Three B-rep-only, `vscode`-free functions sharing one private `resolveEntity()` id-resolver (`solid-N`/`face-N`/`edge-N`/`point-N`, via the already-shared `collectSolids`/`collectFaces`/`collectEdges`/`collectVertices` from `occtOperations.ts`) and the same read-parse-cleanup skeleton every other B-rep read path in this codebase follows — re-parse `bytes`, replay `ops`, resolve, compute, `.delete()` every handle in reverse order, `unlink` the MEMFS temp file. Backs the `inspect`/`measure`/`measure_exact` MCP tools (`mcpTools.ts`) and, for `measure_exact` only, the interactive webview's "⟟ Exact" measurement button (`measureExactRequest`, see [Protocol](./protocol.md) and [Webview API](./webview-api.md)).

```typescript
type SurfaceType = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'other'

interface EntityFacts {
  entityId: string
  kind: 'solid' | 'face' | 'edge' | 'point'
  bbox: { min: Vec3; max: Vec3; diagonal: number } | null
  center: Vec3       // bounding-box centre, NOT the mass centroid
  area: number | null    // solid: boundary area; face: its own area; null otherwise
  length: number | null  // edge only
  normal: Vec3 | null       // planar face only
  planeOrigin: Vec3 | null  // planar face only — OCCT's own plane origin (gp_Pln.Location()), a point ON the plane; usable as planePoint for section/splitByPlane/mirror
  surfaceType: SurfaceType | null   // face only
  surfaceParams: SurfaceParams | null  // face only; null for surfaceType "other"
  curveType: CurveType | null       // edge only
}

async function getEntityFacts(
  extensionPath: string, bytes: Uint8Array, format: BRepFormat,
  ops: EditOp[], entityId: string
): Promise<EntityFacts>

interface MeasureResult {
  from: string; to: string; fromPoint: Vec3; toPoint: Vec3
  distance: number; delta: Vec3          // toPoint - fromPoint
  axis?: Vec3; axisComponent?: number    // delta · normalize(axis), only when axis given
}

async function measureEntities(
  extensionPath: string, bytes: Uint8Array, format: BRepFormat,
  ops: EditOp[], from: string, to: string, axis?: Vec3
): Promise<MeasureResult>

type ExactMeasureKind = 'distance' | 'edgeLength' | 'radius'   // no "angle" — see below

interface ExactMeasureResult {
  kind: ExactMeasureKind
  value: number
  fromPoint?: Vec3; toPoint?: Vec3   // "distance" only — OCCT's actual nearest points, not a centre/endpoint
  centreDistance?: number            // "distance" only — bbox-centre-to-bbox-centre (what measure reports)
  parallelDistance?: number          // two planar faces only, planes parallel — perpendicular plane-to-plane gap
  angleDeg?: number                  // two planar faces only — angle between outward normals, [0, 180]
  primary?: 'min' | 'parallel'       // which reported value most likely answers "how far apart" for this pair
}

async function measureExact(
  extensionPath: string, bytes: Uint8Array, format: BRepFormat, ops: EditOp[],
  kind: ExactMeasureKind, entityIdA: string, entityIdB?: string
): Promise<ExactMeasureResult>
```

**`getEntityFacts`/`measureEntities`** are both deliberately bbox-centre-based (`bboxCenter`, `occtOperations.ts`) — for an asymmetric shape this is a *different* point than `get_mass_properties`' area/volume-weighted `centerOfMass`; use `inspect`/`measure` for "where roughly is X" and `get_mass_properties` when the mass-weighted centroid itself is the thing being asked about. `EntityFacts.surfaceType`'s `GeomAbs_SurfaceType` mapping was verified against the live WASM the same way `massProperties.ts`'s `BRepGProp` calls were — see the type's doc comment in `entityFacts.ts` for the full brute-force-probing trail (`GeomAbs_Plane=0` … `GeomAbs_Torus=4`, confirmed by building one of each primitive and reading `BRepAdaptor_Surface_2(face,true).GetType().value`). **`EntityFacts.surfaceParams`** (roadmap item 8 Phase 1) carries the analytic parameters behind `surfaceType`, which the same OCCT call already computed and discarded: a discriminated union over `plane`/`cylinder`/`cone`/`sphere`/`torus` giving radius + axis, cone half-angle (**degrees, signed** — positive means the radius grows along `axisDirection`) with its apex and reference radius, sphere centre, and torus major/minor radii. All in WORLD coordinates of the post-replay shape and the file's own length units, verified live under translation and rotation. `axisLocation` is a point ON the axis and nothing more — not the face's centre, not necessarily inside its extent. `normal`/`planeOrigin` are projections of the `plane` variant read from the SAME adaptor (see `faceSurfaceInfo` in `occtOperations.ts`, which `facePlane` is now a three-line projection of), so they cannot disagree; nothing populates them for a curved face, because Clip ▸ Face gates on them and would otherwise cut on a meaningless plane. **`EntityFacts.curveType`** (roadmap "Explain the geometry under the cursor") is its edge-side counterpart — `"line" | "circle" | "ellipse" | "hyperbola" | "parabola" | "bezier" | "bspline" | "other"`, from `BRepAdaptor_Curve_2(edge).GetType()`. That is the SAME call `measureExact`'s `"radius"` kind already exercises against the live WASM, so it needed no new probing; it is a new field on an existing function, not new kernel surface. Verified in `npm run mcp:smoke`: a cylinder rim whose exact radius `measure_exact` just resolved classifies as `"circle"`, a `bull.stp` edge as `"bspline"`, and the two tools agree about which edges are circular.

**`measureExact`** is the opt-in true-OCCT-precision sibling to the always- available, instant, but only *approximate* triangulated measurement (client- side, `src/webview/measurement.ts`, tied to `meshExtract.ts`'s 0.1 tessellation deflection) — a host round trip an agent or the interactive Measure tool's "⟟ Exact" button opts into per pick, not the default. Every call shape below is **verified against the live WASM**, not assumed from upstream OCCT docs (same brute-force overload-probing convention as every other OCCT call in this codebase):

- **`kind: "distance"`** — the true minimum distance between two arbitrary entities (point/edge/face/solid, any combination) via `BRepExtrema_DistShapeShape`. Only 3 constructor overloads exist in this binding (`_1` 0-arg, `_2` 4-arg, `_3` 5-arg); calling `_2`/`_3` directly with just `(shape1, shape2)` throws an argument-count error (their real params include `Extrema_ExtFlag`/`Extrema_ExtAlgo` enums this codebase never needed to guess the values of), so `measureExact` instead constructs with `_1()` and calls `.LoadS1(shape)` → `.LoadS2(shape)` → `.Perform()` — confirmed end-to-end on a real box-vs-cylinder pair, returning a genuine geometric distance and nearest points matching hand-computed geometry. `.IsDone()` gates a real result; `.PointOnShape1(1)`/`.PointOnShape2(1)` (solution 1 of potentially several equidistant ones — this feature only ever wants "a" nearest-point pair) return the actual nearest points OCCT found, not either entity's centre or an endpoint.
- **`kind: "edgeLength"`** — reuses `getEntityFacts`'s already-verified single-edge `BRepGProp.LinearProperties` call shape.
- **`kind: "radius"`** — only valid for an edge whose underlying curve is a true circle: `BRepAdaptor_Curve_2(edge).GetType()` compared **symbolically** against `oc.GeomAbs_CurveType.GeomAbs_Circle.value` (never a hardcoded numeric literal), then `.Circle().Radius()`. Verified end-to-end: a `addCylinder(radius: 3, ...)` primitive's rim edge, re-measured through `apply_edit_ops` → `measure_exact`, resolved to exactly `3`; a non-circular edge throws a clear, actionable error instead of a meaningless best-fit number. There is deliberately no `"angle"` kind — `BRepExtrema_DistShapeShape` has no exact-angle analogue, so `src/webview/main.ts`'s `exactMeasureKindFor()` maps the Measure tool's `"angle"` mode to `null` and the "⟟ Exact" button never appears for it.

`provider.ts` handles `measureExactRequest` for B-rep sources only (there is no client-side/webview computation to fall back to — the button itself is hidden for mesh sources, see [Webview API](./webview-api.md)); `mcpTools.ts`'s `measure_exact` follows the identical B-rep-only gate.

```typescript
interface InterferenceResult {
  hasOverlap: boolean; overlapVolume: number
  unresolvedA: string[]; unresolvedB: string[]
}

async function checkInterference(
  extensionPath: string, bytes: Uint8Array, format: BRepFormat, ops: EditOp[],
  a: string[], b: string[]
): Promise<InterferenceResult>
```

**`checkInterference`** (roadmap "Interference / clash detection", closed) — read-only, never mutates or persists anything: intersects two solid sets and reports the overlap volume, reusing two already-verified call shapes wholesale rather than probing anything new. `a`/`b` are `solid-N` id arrays, compounded via `occtOperations.ts`'s newly-exported `combineSolids` (the exact same "compound the operand's solids together first" helper the `boolean` edit op's own `booleanSolids` already uses internally — promoted from module-private to exported specifically for this function). The intersection itself is `new oc.BRepAlgoAPI_Common_3(shapeA, shapeB)` → `.IsDone()` → `.Shape()`, the identical `"intersect"`-kind call shape `booleanSolids` already exercises; the resulting volume uses this file's own `volumeOf` (the same adaptive `BRepGProp` call shape via `src/brepGProp.ts` that `get_mass_properties` uses). An id that doesn't resolve is dropped and reported in `unresolvedA`/`unresolvedB` rather than thrown; if that leaves either side with zero resolved solids, or the boolean doesn't complete, the result is a clean `hasOverlap: false`/`overlapVolume: 0` — the same graceful-skip convention `booleanSolids` itself already follows on replay. A degenerate (near-zero-volume) intersection — two solids that only touch at a shared face/edge/point — also reports `hasOverlap: false` (a `1e-9` volume threshold, not a bare `> 0` check, since floating-point boolean results on a touching pair rarely land at exactly zero). **Verified end-to-end against the live WASM, not just unit-tested** (`npm run mcp:smoke`): two boxes with a known analytical overlap volume of exactly 700 (a 10×10×10 box at the origin intersected with a 10×10×10 box offset 3 units along X) resolved to `699.9999999999999` — floating-point-exact — while a disjoint pair and a face-touching pair both correctly resolved to `hasOverlap: false`.

`mcpTools.ts`'s `checkInterferenceTool` layers Part-name operand resolution on top — `a`/`b` (raw `solid-N` ids) or `partA`/`partB` (a Part name, resolved via `readParts()` to that Part's own `volumes` array) — `entityFacts.ts`'s `checkInterference` itself stays entirely ignorant of Parts, id-array-in, matching every other `collectSolids`-based function in this file. Exactly one of `a`/`partA` must be given per operand (thrown as a validation error otherwise, not a graceful `supported: false` — unambiguous misuse, not a legitimately-absent id); an unknown Part name or one with no assigned volumes degrades to a `warnings` entry and a clean "no overlap" result, never a throw.

**`checkInterferenceAll(extensionPath, bytes, format, ops, groups: string[][])`** (roadmap "Assembly-wide interference check across all Parts", closed) is the assembly-wide sibling: EVERY pair of the caller's groups in one call — **one parse/replay total**, not C(n,2) re-parses of the existing per-call function (the roadmap's literal "loop the unmodified checkInterference" wording was deliberately improved on here; same kernel surface, one shared parse). Built-in from the start because two independent projects converged on it: each group's extent is the union of its member solids' `bboxExtent`s (`occtOperations.ts`, promoted from module-private to exported for exactly this caller), computed once per solid and cached across groups, and a pair whose extents are STRICTLY separated on any axis is reported without paying for a boolean (`screenedByBbox: true` — a fact about how the answer was derived). Touching AABBs are deliberately NOT screened: they go to the real boolean so a merely-touching pair still resolves to `hasOverlap: false` exactly as authoritatively as the single-pair path. The kernel calls are byte-identical to `checkInterference`'s (`combineSolids` + `BRepAlgoAPI_Common_3` + adaptive volume + the `1e-9` gate); unresolved ids and empty groups degrade to per-group warnings plus no-overlap rows, never throws. No caller-visible cap yet — cost is O(n²) booleans worst case, cut by the pre-filter to only geometrically-plausible pairs; the tool layer (`checkInterferenceAllTool`) owns Part-name resolution (omitted `parts` = every sidecar Part; unknown/empty parts skipped with warnings) and guards the pipeline contract by throwing if the returned pair count doesn't equal C(n,2) rather than silently mislabeling rows.

**MAX distance was probed and is genuinely unavailable in this WASM build** — recorded so neither path is re-proposed (the fourth instance of this codebase's "green in the manifest is necessary but not sufficient" pattern): `BRepExtrema_DistanceSS` is green, but its usable 7-arg constructor `(S1, S2, Bnd_Box, Bnd_Box, dst, Extrema_ExtFlag, Extrema_ExtAlgo)` only ever constructs an object that never computes (no `Perform` method exists on the prototype chain; `IsDone()` stays false and `DistValue()` echoes the `dst` early-exit hint verbatim, filled bounding boxes or not), and its other overloads need `BRepExtrema_ShapeType`, which is NOT bound; meanwhile `DistShapeShape_2(S1, S2, extFlag, extAlgo)` accepts the (bound!) `Extrema_ExtFlag_MAX` silently but ignores it — always returns the minimum. `measureExact` therefore reports the exact minimum plus the additive context fields above (`centreDistance`, and for two planar faces `angleDeg`/`parallelDistance` with `primary` naming which value fits the pair's geometry — facts, never verdicts; parallelism tolerance is a `1e-6` cosine).

`provider.ts` handles `colorFieldRequest` for meshio++-imported sources only (`route.strategy === "meshio"`, else posts `colorFieldError`) — reads the source bytes fresh and calls `meshioService.ts`'s `readMeshioFieldValues()`, posting `colorFieldResult` (base64 `Float32Array` values + min/max) or `colorFieldError` (field not found/not scalar/non-triangle boundary). No MCP tool — this is a display-only feature webview-side (same "no headless equivalent" precedent as Display Modes/Markup/Measurement).

**Entity-id rebinding — the bulk fingerprinting + orchestration half.** Two more exports, added for the "entity-id drift" roadmap item (closed):

```typescript
function collectAllEntitySignatures(oc: any, shape: any, cleanup): EntitySignature[]

interface RebindStats { considered: number; rebound: number; dropped: number }

async function rebindPartsAcrossOps(
  extensionPath: string, bytes: Uint8Array, format: BRepFormat,
  oldOps: EditOp[], newOps: EditOp[], parts: Part[], annotations?: Annotation[]
): Promise<{ parts: Part[]; annotations: Annotation[]; stats: RebindStats; annotationStats: RebindStats }>
```

`collectAllEntitySignatures` is the bulk sibling of `resolveEntity` (this file's private single-id resolver): instead of resolving ONE caller-given id, it enumerates EVERY solid/face/edge/point in `shape` via the already-shared `collectSolids`/`collectFaces`/`collectEdges`/ `collectVertices` (`occtOperations.ts`) — in the SAME deterministic order that assigns `solid-N`/`face-N`/`edge-N`/`point-N` ids elsewhere, so an array index here IS the id — and fingerprints each (`bboxCenter` + area/volume via `src/brepGProp.ts`'s adaptive wrappers (`SurfaceProperties2`/`VolumeProperties2`), length via the unsuffixed `LinearProperties`, matching `massProperties.ts`'s current call shapes; a point's `measure` is always `0`, read via `oc.BRep_Tool.Pnt`).

`rebindPartsAcrossOps` is the orchestrator `apply_edit_ops`/`run_parametric_script`/`remove_edit_op`/`provider.ts`'s `editsChanged` handler all call. **It now takes the full `oldOps`/`newOps` lists** (generalized from an earlier append-only `opsBefore`/delta signature, roadmap item closed — see CLAUDE.md's "Entity-id drift" section for the discovered-bug history) and dispatches on how they relate:

- **Pure append** (`oldOps` is a prefix of `newOps`) or **pure trailing truncation** (`newOps` is a prefix of `oldOps` — covers undo, Clear, and `remove_edit_op` on the LAST index): steps **incrementally**, one changed op at a time. For each topology-changing op (`TOPOLOGY_CHANGING_OPS`, `editOps.ts`) at the boundary, it builds the shape immediately BEFORE and AFTER that one op — two fully independent `readShape`+`applyEditsBRep` replays with their own `cleanup` arrays, no shared shape reuse across the boundary (matching this codebase's standing "no shape/session cache" discipline) — fingerprints both sides, matches them via `entityRebind.ts`'s `rebindEntities()` (tolerance `1e-3 * bboxDiagonal(shapeAfter)`, the same tolerance-fraction convention `gmshPartsMap.ts`/`modelDiff.ts` established), and remaps `parts` via `remapPartEntityIds()` — iteratively, so a list already remapped by op N feeds op N+1.
- **Any other change shape** (most notably `remove_edit_op` at a non-last index): does **one direct fingerprint-and-match** between `shape(oldOps)` and `shape(newOps)` as replayed wholesale, with no intermediate per-op stepping at all. This path exists because the naive "always step incrementally" approach has a real blind spot for a middle removal: unwinding from the raw end of `oldOps` toward the common prefix can pop an op that sits AFTER the one actually being removed, making an entity that's identical in both the real before- and after-shapes briefly and artificially "not exist" in an intermediate replay — which the matcher then (correctly, given what it's shown) treats as a genuine deletion. Diffing the two real shapes directly has no such artificial gap. Caught live via `npm run mcp:smoke` before this path existed (see CLAUDE.md for the exact repro) and fixed by adding this dispatch, not by making the incremental matcher itself smarter.

Non-topology-changing ops are skipped entirely in both paths (their ids are already stable, so a shape-diff would be pure waste). Short-circuits to the ORIGINAL `parts`/`annotations` references when both are empty or `oldOps`/`newOps` are unchanged or contain no topology-changing difference, letting callers cheaply detect "nothing to do" — but a genuinely-run pass that finds zero actual changes for a NON-empty list still returns a fresh array (`remapPartEntityIds` always `.map()`s), a deliberate correctness-first tradeoff, not a bug.

**`annotations` (roadmap "Persisted, topology-anchored annotations", closed) is an optional 7th parameter, defaulting to `[]`.** An `Annotation` (`src/protocol.ts`) is structurally an `EntityIdBag` too (same `volumes`/`surfaces`/`lines`/`points: string[]` shape as `Part`), so it's rebound through the SAME `remapPartEntityIds` call and the SAME computed `idMap` inside each step — no second shape-diff, no new matching code. Every pre-existing call site (all 4, across `provider.ts` and `mcpTools.ts`) compiles and behaves unchanged, since the new parameter defaults and the two new return fields are simply unused by old callers. One subtlety fixed during this work: `diffAndRemap` now skips calling `remapPartEntityIds` at all when the respective list (`currentParts`/`currentAnnotations`) is already empty — `[].map(...)` always returns a NEW array, which would otherwise flip the caller-visible `result.parts === parts` reference-equality check to "changed" for no real reason whenever only one of the two lists was non-empty.

---

## `src/meshRegionGrow.ts`, `src/primitiveFit.ts`, and `src/meshRegionFit.ts`

Mesh-side region fitting (roadmap item 9) — `fit_mesh_region`. All three are pure and **dependency-free**, and the whole path is **WASM-free** (no `getOcct`), so it preserves the "opening a pure-mesh file must never load the WASM" invariant.

- **`meshRegionGrow.ts`** — `growRegion(positions, indices, seedTriangle, {angleDeg, maxTriangles})` → `{triangles, capped}`, a seeded dihedral-gated flood fill copying `connectedComponents`' discipline. Plus `nearestTriangleToPoint` (centroid distance — documented as a *seed* resolver, not a containment test), `regionPoints`, and `regionNormals`. Deliberately NOT `meshFacets.ts`'s `segmentCoplanarFacets`: that is global segmentation with no cap, is not THREE-free, and its 15° tolerance is tuned to split flat faces where this needs to walk across a curve.
- **`primitiveFit.ts`** — `symmetricEigen` (3×3 cyclic Jacobi, ascending, since every consumer wants the *smallest* eigenvector), `solveLinear`, `fitPlane` (point PCA), `fitSphere` (Kasa), `fitCylinder` (axis from the covariance of the **normals**, then a 2D Kasa circle), and `axialExtent`. None of this existed anywhere in the repo before — there is no matrix library in the host dependency set, so it is hand-rolled like every other pure module.
- **`meshRegionFit.ts`** — the orchestrator: `parseToWeldedMesh` → resolve seed → grow → fit all three → residual via `maxDeviation`. Publishes every candidate with its own residual rather than picking a winner, so a caller can disagree. `simplestOf(candidates)` is exported and pure — the published rule (simplest shape first, then a residual threshold) applied over exactly the numbers the result carries, so `simplestRule`'s "recompute it yourself" claim is verifiable rather than aspirational.

`primitiveSdf.ts`'s `Primitive` union gained a `plane` variant for this — its one unbounded member. A fitted cylinder is infinite and must be clipped to the region's axial extent before its residual means anything.

## `src/primitiveSdf.ts`, `src/primitiveRecognition.ts`, and `src/primitiveReport.ts`

Per-solid primitive recognition (roadmap item 8 Phase 2) — `recognize_primitives`. Split three ways along this codebase's usual pure/impure line:

- **`primitiveSdf.ts`** (pure, no OCCT/THREE) — `Primitive` (box/sphere/cylinder/cone/torus), `signedDistance(point, prim)`, `maxDeviation(points, prim)`. Hand-rolled rather than an OCCT extrema query because **this build has no maximum-distance query at all** (`BRepExtrema_DistanceSS` constructs but never computes; `Extrema_ExtFlag_MAX` is accepted then ignored — see `entityFacts.ts`'s `measureExact` doc). Every primitive has a closed-form SDF, so the residual is exact arithmetic with no kernel call, and unit-testable headless. `maxDeviation` takes `Math.abs` (a point inside the ideal primitive deviates just as much as one outside) and returns `null` for an empty set rather than `0`, so an uncomputable residual can never read as a perfect fit.
- **`primitiveRecognition.ts`** (pure) — `inventoryOf(faces)` and `recognizePrimitive(faces)` over the `SurfaceParams` Phase 1 reads off each face. Every signature requires an **exact** face count, so a filleted box reports `null` rather than passing as a box; box recognition groups six normals into three mutually perpendicular antiparallel pairs and derives the frame from them, with no world-axis assumption. `center` follows the codebase's own op convention — geometric centre for box/sphere/torus, **base** centre for cylinder/cone — matching `addBox`/`addSphere` vs `addCylinder`/`addCone`.
- **`primitiveReport.ts`** (OCCT-touching) — `recognizePrimitives(extensionPath, bytes, format, ops)`, one parse/replay for the whole model, same prologue as `computeBom`. Explores each solid's own handle for its faces (the global `collectFaces` list is contiguous per solid but discards which solid contributed which), so report face ids are **local** (`local-N`); a caller wanting a global `face-N` uses `inspect`. Boundary points for the residual come from `tessellateByGroup`, i.e. the same tessellation the viewer displays — note its trailing free-face group is labelled `solid-N` for an N `collectSolids` never produces, so the report indexes real solids only.

`fitResidual` is the analogue of `ComponentHealthReport.requiredTolerance`: a number the caller judges, never a pass/fail. A candidate with a large residual resembles that primitive; it is not declared to be one.

## `src/entityRebind.ts`

The pure matching algorithm `rebindPartsAcrossOps` above delegates to — vscode/OCCT-free, unit-tested, mirroring `modelDiff.ts`'s pure/impure split (that file's `diffSolids` is this one's direct ancestor, generalized from solids-only to solid/face/edge/point).

```typescript
type RebindKind = 'solid' | 'face' | 'edge' | 'point'

interface EntitySignature { id: string; kind: RebindKind; centre: Vec3; measure: number }
interface EntityRebindMatch { oldId: string; newId: string; centreDistance: number; measureDeltaPct: number }

function rebindEntities(oldSigs: EntitySignature[], newSigs: EntitySignature[], toleranceAbs: number): EntityRebindMatch[]

interface EntityIdBag { volumes: string[]; surfaces: string[]; lines: string[]; points: string[] }
interface RemapResult<T> { parts: T[]; reboundCount: number; droppedCount: number }

function remapPartEntityIds<T extends EntityIdBag>(parts: T[], idMap: Map<string, string>): RemapResult<T>
```

`rebindEntities` runs the SAME greedy nearest-neighbor bipartite matching `diffSolids` established (centroid distance primary, `measure` as tie-breaker, capped by `toleranceAbs`) but **independently per `kind`**, so a face can never match an edge even if their centres coincide — `measure` is area for solid/face, length for edge, and always `0` for point (a location has no size to compare, so points match on centre distance alone). An entity with no candidate within tolerance is simply absent from the result — the caller's job to decide what "unmatched" means (here, drop).

`remapPartEntityIds` takes a **structural** `EntityIdBag` type (not `Part` itself) so this file stays framework-agnostic — `Part` (`protocol.ts`) satisfies it trivially. Rewrites every id present in `idMap`, drops any that isn't (no confident geometric match — same graceful degradation the sidecar parser's unresolved-id handling already applies), and counts only ids that map to a **different** string as "rebound" (an id matched to itself, the common case for anything untouched by the op, isn't counted — it was never actually lost). Never mutates its input.

---

## `src/xcafTree.ts`

XCAF (Extended CAF) assembly-structure reading for STEP sources (roadmap "XCAF read — assembly structure", closed) — see CLAUDE.md's own section for the full write-up, including a real transform-composition bug caught and fixed via live-WASM verification. Split into an OCCT-touching read half and a pure correlation half, mirroring `entityFacts.ts`/`entityRebind.ts`'s own split just above.

```typescript
interface XcafLeafSignature { id: string; centre: Vec3; volume: number }
interface XcafAssemblyInfo { tree: TreeNode; sigs: XcafLeafSignature[] }

function readXcafAssembly(oc: any, filePath: string): XcafAssemblyInfo | null

function correlateAssemblyTree(info: XcafAssemblyInfo, currentSolids: XcafLeafSignature[]): TreeNode | null
```

**`readXcafAssembly`** does an entirely independent `STEPCAFControl_Reader` parse of `filePath` (which must still be on MEMFS — callers own writing/unlinking it, same convention as `readShape`'s `tmpName`). Walks the document's `ShapesLabel` via `TDF_ChildIterator`, recursing through assembly-type component/reference labels (resolved via `XCAFDoc_ShapeTool.GetReferredShape`) down to simple-shape leaves, accumulating each level's own `TopLoc_Location` (`.Multiplied()`) to pass DOWN to children — but applying only that ANCESTOR-accumulated location (not the leaf's own, which `GetShape_2` already baked in) via `.Moved()` when computing a leaf's final world-space fingerprint, since `.Moved()` COMPOSES with a shape's existing location rather than replacing it (the exact bug this item's verification caught and fixed — see CLAUDE.md). Returns a `TreeNode` tree with SYNTHETIC leaf ids (`xcaf-leaf-N`) plus a parallel `XcafLeafSignature[]` (bbox centre + volume per leaf, in the same synthetic-id space) — never the real `solid-N` ids, which this function has no way to know (that's `TopExp_Explorer` order over the UNRELATED plain-reader shape). Returns `null` on ANY failure (no XCAF structure, a parse error, an unbound API) — always a best-effort enhancement, never required.

**`correlateAssemblyTree`** is pure (no OCCT calls) — matches `info.sigs` against the REAL, current `solid-N` fingerprints via `src/entityRebind.ts`'s existing `rebindEntities` (reused as-is, `kind: "solid"` on both sides), then relabels every tree leaf from its synthetic id to the matched real id. Requires a **clean 1:1 bijection** (every synthetic leaf matched, every real solid claimed, nothing left over) or returns `null` — a topology-changing edit since `readXcafAssembly` was cached changes the real solid count/positions in ways this function has no way to reconcile, and a partially-correlated tree would be worse than the flat fallback. Cheap enough to re-run on every `loadBRep`/`loadBRepCached` call even though `readXcafAssembly` itself is cached (see `occtService.ts`'s `BRepCacheEntry.assemblyTreeCache` above).

---

## `src/csgImport.ts` and `src/csgModel.ts`

OpenSCAD `.csg` import (roadmap Tier 2 item 2, path (a), closed) — see CLAUDE.md's own section for the full write-up, including the mid-session pivot from op-lowering to an opaque base and the probe trail. Split into a pure parser half and a kernel-side builder half, mirroring `entityFacts.ts`/`entityRebind.ts`'s own split.

```typescript
// csgImport.ts (pure — no vscode/DOM/OCCT, headless-tested in csgImport.test.ts)
interface CsgNode { name: string; modifier: string | null; params: Record<string, CsgValue>; children: CsgNode[]; faces?: number[][] }
type CsgValue = number | boolean | string | number[] | null
interface CsgParseResult { roots: CsgNode[]; warnings: string[]; useMaxFN: number }
function parseCsg(text: string, options?: CsgParseOptions): CsgParseResult
function resolveSegments(r: number, fn?: number, fa?: number, fs?: number): number

// csgModel.ts (kernel-side — takes a live `oc`, every handle into `cleanup`)
function buildCsgShape(oc: any, roots: CsgNode[], parserWarnings: string[], useMaxFN: number, cleanup: Cleanup, warnings: string[]): Shape
```

- **`parseCsg`** tokenizes (identifiers, numbers, strings, punctuation; `//` and `/* */` comments; `%`/`#`/`!`/`*` debug-modifier prefixes) and recursive-descents into `CsgNode`s — named (`name = value`) and positional (`#0`, `#1`) params, `{...}` child blocks, `;` terminals. Nested vectors flatten (fine for points/vectors); polyhedron `faces=[[..],[..]]` boundaries are recovered separately by `extractPolyhedronFaces` (a dedicated regex over the raw text, keyed by `polyhedron(` occurrence order) because flattening loses them. Refuses empty input and inputs over 10MB with a warning and no roots.
- **`resolveSegments`** reimplements OpenSCAD's own `$fn` rule (`$fn > 0` wins, else `max(5, ceil(360/fa), ceil(2πr/fs))` with `$fa=12`/`$fs=2` defaults).
- **`buildCsgShape`** walks the AST with live handles and returns one compound (possibly empty — the blank-model empty-shape guard downstream handles that). Primitives use the exact verified suffixes `occtOperations.ts` uses (`MakeBox_3` two corners, `MakeSphere_5`, `MakeCylinder_3`, `MakeCone_3`); faceted cylinders (`n <= useMaxFN`) build an N-gon prism in-loop (the `addPrism` recipe, first vertex at +X like OpenSCAD); polyhedra fan-triangulate, sew at `1e-6`, gate on `NbFreeEdges() == 0`, and flip-if-negative (the `orientPositiveVolume` rule); booleans use the `_3` ctors + `IsDone()` gate over compounded operands (the `booleanSolids` skeleton). EVERY transform node (`multmatrix`/`translate`/`rotate`/`scale`/`mirror`) goes through one path — `gp_GTrsf_1` + `BRepBuilderAPI_GTransform_2` — so shear needs no decomposition and float-noisy axes need no snap. Skipped constructs (`hull`/`minkowski`/`text()`/2D/extrude-wrappers/unknown) drop the whole subtree with a warning; `*` disables, `!` warns transparent, `%`/`#`/`color`/`render`/`group` are transparent.
- **Reached through one choke point**: `occtService.ts`'s `readShape()` takes an untyped `format: string`, so a single `"csg"` branch (MEMFS bytes → UTF-8 → `parseCsg` → `buildCsgShape`, warnings into an optional out-param) serves `loadBRep`/`loadBRepCached`/`exportBRep`/mass properties/entity facts/diff/silhouette with zero per-caller changes. `BRepResult`/`BRepCacheEntry` carry additive `warnings` so the append-reuse path still reports without rebuilding.

## `src/scadService.ts`

OpenSCAD `.scad` import (roadmap Tier 2 item 2, path (b), closed) — see CLAUDE.md's own section. Host-side by constraint: `.scad` `use`/`include`/`import` resolve relative to the source file, but the kernel worker only ever receives marshalled bytes, so converting there would silently break every multi-file model. Converts on the real path and hands the shipped `.csg` pipeline converted bytes.

```typescript
// scadService.ts (host-side — node:child_process/fs/os/path only, vscode/WASM-free, stub-binary-tested)
class ScadUnavailableError extends Error  // missing binary ONLY — callers map to {supported:false}
function resolveOpenscadBinary(explicit?: string): string  // setting → OPENSCAD_BINARY env → "openscad"; "" counts as unset
function isOpenscadAvailable(binary?: string): Promise<{ available: boolean; reason?: string }>
function convertScadToCsg(sourcePath: string, opts?: { binary?: string; timeoutMs?: number }): Promise<{ csgBytes: Uint8Array; warnings: string[] }>
function resolveEffectiveSource(opts: { modelPath: string; format: CadFormat; readBytes: () => Promise<Uint8Array>; warnings: string[]; binary?: string; timeoutMs?: number }): Promise<{ bytes: Uint8Array; format: CadFormat }>
```

- **`convertScadToCsg`** runs `openscad -o <tmp>/model.csg <real path>` (`-o` extension selects the CSG exporter — per FreeCAD's documented architecture, unverified against a live binary here) with `cwd = dirname(sourcePath)` on the real file (never a temp copy — copying would break relative references with no error to catch it). Output goes to an `mkdtemp` dir always `rm`'d in a `finally`, success or failure. Non-zero exit throws with the stderr tail; timeout (`SCAD_CONVERT_TIMEOUT_MS` = 120s, the sandbox backstop for evaluated-code hangs) kills the child and says so; empty/missing output is a failure, never an empty model. Success-with-stderr becomes capped `openscad: …` warnings.
- **Two failure rules, mirroring `renderService.ts`**: absent binary (including TOCTOU at convert time) → `ScadUnavailableError`, mapped to `{supported: false}` + install hint at every entry point — except tools with no `supported` field (`generate_mesh`/`export_mesh`/`export_brep`/silhouette), which throw the hint as a clear error instead. Present-but-failing binary → thrown plain `Error`.
- **Wiring is one helper per side**: `resolveEffectiveSource()` (non-scad passes through byte-identical) backs `readOcctSource()` in `mcpTools.ts` (each occt tool maps `{ok:false}` to its own `supported:false` shape; mutation-path tools persist sidecars even when the replay preview is skipped) and `provider.ts`'s private `readOcctSource()` (existing catches post the message — it IS the hint) plus `modelComparePanel.ts`'s `resolveCompareSource`. Meshing/export request paths that cannot degrade throw the hint instead. One incidental fix: the File ▸ Open dialog never listed `.csg` — it now lists both.

---

## `src/provider.ts`

### `CadPreviewProvider`

Implements `vscode.CustomReadonlyEditorProvider<CadDocument>`.

```typescript
class CadPreviewProvider implements vscode.CustomReadonlyEditorProvider<CadDocument> {
  static readonly viewType = 'cad-preview.mesh'
  static register(context: vscode.ExtensionContext): vscode.Disposable
  openCustomDocument(uri: vscode.Uri, ...): Promise<CadDocument>
  resolveCustomEditor(document: CadDocument, webviewPanel: vscode.WebviewPanel, ...): Promise<void>
}
```

**`register(context)`** — Registers the provider with VS Code. Called once from `activate()`. Returns a `Disposable` pushed onto `context.subscriptions`.

**`openCustomDocument(uri)`** — Creates a lightweight `CadDocument` wrapper around the URI. The document is read-only (no `backup`, no `revert`).

**`resolveCustomEditor(document, webviewPanel)`** — The main handler called whenever a supported file is opened:

1. Sets the webview options (`enableScripts: true`, `localResourceRoots`).
2. Sets `webviewPanel.webview.html` to the result of `getHtml()`.
3. Registers a `webviewPanel.webview.onDidReceiveMessage` listener (a per-panel `pending: Map<string, { resolve; reject }>` correlates export/screenshot round-trips, and separate per-panel debounce timers batch parts/annotations/edits/mesh-options sidecar writes) that handles `"ready"`, `"partsChanged"`, `"annotationsChanged"`, `"editsChanged"`, `"meshingChanged"`, `"meshingGenerate"`, `"meshingExport"`, `"exportRequest"`, `"exportResult"`, `"exportError"`, `"screenshotButtonClicked"`, `"screenshotResult"`, `"screenshotError"`, `"massPropertiesRequest"`, `"measureExactRequest"`, `"colorFieldRequest"`, `"standardPartsSearchRequest"`, `"standardPartsInsertRequest"`, `"importSvgRequest"`, `"openFile"`, and `"openPath"`.
4. On `"ready"`: reads the edits sidecar, calls `routeFile()`, dispatches to `handleBRep()` (which applies the loaded edits) or posts `"loadUrl"`, then posts `"edits"` and calls `sendParts()`/`sendMeshOptions()`/`sendViewerDefaults()`, plus an inline `readAnnotations(document.uri).then(...)` that posts `"annotations"` (no dedicated `sendAnnotations()` method — the meshio route has no equivalent "may need to auto-create" complication `sendParts()`/`handleMeshio()` have, so a plain read-and-post inline is sufficient).
5. On `"partsChanged"`: debounces (~500 ms) then `writeParts()` to the sidecar. The CAD file is never written.
6. On `"annotationsChanged"` (roadmap "Persisted, topology-anchored annotations", closed): debounces (~500 ms, its own timer separate from parts/edits/mesh) then `writeAnnotations()` to the `<model>.annotations.json` sidecar. The CAD file is never written.
7. On `"editsChanged"`: debounces (~500 ms, its own timer) then `writeEdits()`; for B-rep sources also re-tessellates immediately with the new op-list AND calls `rebindPartsOnChange()` (see below) to best-effort geometrically rebind any Parts AND annotations affected by a topology-changing op-list change (append, undo/redo, or a middle removal — see below).
8. On `"meshingChanged"`: debounces (~500 ms, its own timer) then writes **both** `writeMeshOptions()` and `writeGeoScript()`.
9. On `"meshingGenerate"`/`"meshingExport"`: resolves the mesh input via `resolveMeshInput()` (re-exports STEP for B-rep sources; uses the message's `stl` field for mesh sources; `"meshingExport"`'s optional `unit` field — a real geometric scale, `"mm"`-default — threads through to it and to `resolveMeshPartsAndOptions()`'s matching `MeshOptions`/`Part[]` rescale) and calls `generateMesh()`/`exportGeoUnrolled()`, posting `"meshingResult"`/`"meshingError"` (Generate) or writing the file via `promptSaveAndWrite()` (Export).
10. On `"exportRequest"`: dispatches to `handleExport()`.
11. On `"exportResult"`/`"exportError"`: resolves/rejects the matching entry in `pending` by `requestId`.
12. On `"screenshotButtonClicked"`: dispatches to `handleScreenshot()` — the same method the `cad-preview.screenshot` command drives via `EditorSession.screenshot()`, so there's exactly one code path regardless of trigger surface.
13. On `"screenshotResult"`/`"screenshotError"`: resolves/rejects the matching `pending` entry, same as `exportResult`/`exportError`.
14. On `"massPropertiesRequest"`: B-rep sources only (`route.strategy === "occt"`, else posts `"massPropertiesError"` with an explanatory message); calls `computeMassProperties()` (`src/massProperties.ts`) and posts `"massPropertiesResult"`/`"massPropertiesError"`. No caching — re-reads and re-parses the source on every call, consistent with the rest of this file.
15. On `"openPath"` (a file dropped onto the viewer canvas, with a real filesystem path exposed): calls `openPathInEditor(msg.path)` — the exact same `vscode.commands.executeCommand("vscode.openWith", ...)` call `openFileDialog()` makes, just from an already-known `Uri.file(path)` rather than a fresh `showOpenDialog()` result.
15b. On `"newBlank"` (File ▸ New Blank Model…): calls `newBlankModelDialog()`. Like `"openFile"`, the handler ignores `route` entirely — it creates a document rather than acting on this one.
16. On `"standardPartsSearchRequest"`: calls `searchStandardParts()` (`src/stepPartsService.ts`) and posts `"standardPartsSearchResult"`/`"standardPartsSearchError"` — a `{available: false}` result is thrown as an `Error` inside the handler's own `try`, converted to `"standardPartsSearchError"` by the same `catch` every other request handler uses.
17. On `"standardPartsInsertRequest"`: calls `downloadStandardPart()`, shows a `showSaveDialog()` defaulting to `<part-id>.step`/`.stp` next to the current document, writes the bytes, and opens the result via `openPathInEditor()`. A dismissed dialog posts `"standardPartsInsertResult"` with `path: null` — a quiet no-op, never `"standardPartsInsertError"`.
18. On `"importSvgRequest"`: shows a `showOpenDialog()` filtered to `.svg`, reads the picked file as UTF-8 text (no parsing host-side — parsing happens in the webview via `src/svgImport.ts`'s `parseSvgPaths()`, since the resulting ops need to be pushed onto `EditsModel` there anyway), and posts `"importSvgResult"`. A dismissed dialog is a quiet no-op (posts neither message).
19. On `"importDxfRequest"`: the identical flow for `.dxf` (`showOpenDialog` filtered to `.dxf`, raw text posted back as `"importDxfResult"`, parsed webview-side by `src/dxfImport.ts`).

**`loadModel(showProgress = false)`** — A `const` closure inside `resolveCustomEditor` (per-document, like `flushSidecars` below), dispatching on `route.strategy`: `"three"` posts `"loadUrl"`; `"meshio"` calls `handleMeshio()`; otherwise (`"occt"`) bumps the per-document `brepLoadGeneration` counter and calls `handleBRep()` — wrapped in a cancellable `vscode.window.withProgress()` notification when `showProgress` is `true` (roadmap "Progress reporting and cancellation", closed as stage-boundary only — see CLAUDE.md). Only the `"ready"` handler and the source-file external-change watcher pass `true`; the `"editsChanged"` handler and the `.edits.json` external-change watcher call it bare (`false`), since a routine edit re-tessellation usually hits the base-shape cache and completes in tens of milliseconds — a native notification on every edit would be noise, not signal.

**`handleBRep(uri, format, post, ops, cache, generation, genHolder, progress?)`** — Private method, called once per `loadModel()` invocation. Calls `loadBRepCached()` (roadmap "Base-shape caching and incremental replay", closed — see `occtService.ts`'s section below) with the current edit op-list AND the per-document `cache` holder (`resolveCustomEditor`'s `brepCache`, `{current: BRepCacheEntry | undefined}`), writing the returned entry back into `cache.current` on success so the NEXT call can reuse it; posts `"status"` progress messages (and, when `progress` is supplied, mirrors each one via `progress.report()` for the native notification), then posts `"geometry"` (faces + edges + points) + `"tree"` messages. For a `"step"` source, also calls `detectStepLengthUnit()` (`src/stepUnits.ts`); for `"iges"`, `detectIgesLengthUnit()` (`src/igesUnits.ts`) — over the raw bytes, including the result as `"tree"`'s optional `sourceUnit` field (`undefined` for BREP, which has no unit metadata at all, or an undeclared/unrecognized-unit STEP or IGES file). Before writing `cache.current` or posting anything past the `loadBRepCached` await (including inside the `catch` block), checks `generation === genHolder.current` and silently returns if not — either a NEWER `loadModel()` call has since started (superseding this one) or the user clicked the progress notification's Cancel button (whose handler already bumped `genHolder.current` and posted its own "Cancelled" status). This is the maximally-honest cancellation this synchronous-WASM pipeline can offer without forking OCCT into a child process: the computation itself always runs to completion, only its result is ever discarded. On a genuine (non-superseded) failure, posts `"error"` AND sets `cache.current = undefined` (never reused after an error — see `loadBRepCached`'s doc comment for why). `resolveCustomEditor`'s `onDidDispose` disposes `brepCache.current` (via `disposeBRepCache()`) alongside the file-watcher cleanup already registered there.

**`rebindPartsOnChange(previousOps, newOps)`** (renamed from `rebindPartsOnAppend`, roadmap item closed — generalized beyond append-only) — A `const` closure inside `resolveCustomEditor` (per-document, like `flushSidecars`/`loadModel` above), not a class method. Called from the `"editsChanged"` handler with the op list as of the PREVIOUS message and the just-received one. Gates only on the document having Parts OR annotations and `previousOps`/`newOps` actually differing (`JSON.stringify` inequality) — no longer requires a strict append-prefix match, since `entityFacts.ts`'s `rebindPartsAcrossOps()` now handles append, undo/redo/Clear (pure truncation), and a middle removal (e.g. `remove_edit_op` from the webview's own op-list ✕ button) all correctly on its own (see that function's doc above for the incremental-vs-direct-match dispatch). Calls `rebindPartsAcrossOps()` with the full `previousOps`/`newOps` lists AND `currentAnnotations`; independently, on a real change to `result.parts` (`!== currentParts`) updates `currentParts` + writes + posts `"parts"`, and on a real change to `result.annotations` (`!== currentAnnotations`, roadmap "Persisted, topology-anchored annotations", closed) updates `currentAnnotations` + writes `<model>.annotations.json` + posts `"annotations"` — both immediately (not the debounced `partsChanged`/`annotationsChanged` timers — host-initiated and correctness-critical), so the webview's `PartsModel.load()`/`AnnotationsModel.load()` (both silent, no `onChange` echo) pick up the new ids — the exact mechanism the initial `ready` hydration's own `"parts"`/`"annotations"` messages already use, so no webview-side code changes were needed beyond the new model itself. Posts `"error"` on failure rather than throwing.

**`handleMeshio(uri, format, post)`** — Private method, `loadModel()`'s sibling branch for `route.strategy === "meshio"` (VTK/VTU/MED/CGNS/Exodus/XDMF/MDPA/OpenFOAM/Gmsh Mesh/Abaqus/I-DEAS Universal/SU2/INRIA Medit). For OpenFOAM it calls `convertFoamCaseToStlBoundary(uri.fsPath)` with the marker's path instead of reading bytes, and posts guaranteed-empty metadata (see CLAUDE.md's "meshio++ dependency currency + OpenFOAM import" section) — so neither region correlation nor auto-Parts can fire for that format. Otherwise it computes the basename + extension, posts a one-line status caveat when the extension is in `fileRouter.ts`'s `AMBIGUOUS_MESHIO_EXTENSIONS` (`.msh`/`.inp`), reads the raw file bytes, resolves whatever companion files the source needs via `resolveMeshioCompanionsFor()`, then in parallel: `convertToStlBoundaryWithRegions(bytes, format, basename, companions)` (region-correlated STL, falling back to the plain boundary when correlation isn't possible), `readMeshioMetadata(bytes, format, basename, companions)`, and `readParts()` (the existing sidecar). When the source's regions correlated AND the sidecar is still empty, calls `src/meshioRegionParts.ts`'s `buildPartsFromMeshioRegions()` and, if it found any, persists them via `writeParts()` immediately. Posts `"loadMeshBytes"` (`sourceFormat` + base64 STL bytes + an optional `meshioMetadata` + an optional `regionAssignment`, sent whenever correlation succeeded regardless of whether Parts were freshly created — the webview needs it every open to reproduce matching facet ids) — no `"geometry"`/`"tree"` messages, since the webview builds its own component tree from the loaded `THREE.Object3D` hierarchy exactly like a native `.stl` open. Then posts `"parts"` itself (the parts actually in effect — auto-created or the pre-existing sidecar), returning that same array so the `"ready"` handler's caller can keep the closure's `currentParts` in sync (see `sendParts` below — this route deliberately does NOT also call the generic one, to avoid double-posting `"parts"`). Posts `"error"` on failure (a malformed source file, an unsupported meshio conversion, etc.).

**`sendParts(uri, post)`** — Private method. Reads the parts sidecar via `readParts()`, posts a `"parts"` message (empty array when no sidecar exists), and returns the parts it sent — the `"ready"` handler assigns this onto the closure's `currentParts` (skipped for the `"meshio"` route, which `handleMeshio` above already handles) so an immediate Save, before any user edit, flushes the sidecar's actual current content rather than a stale empty array.

**`sendMeshOptions(uri, post)`** — Private method. Reads the mesh-options sidecar via `readMeshOptions()` and posts a `"meshingOptions"` message (`DEFAULT_MESH_OPTIONS` when no sidecar exists).

**`sendViewerDefaults(post)`** — Private method. Reads `workspace.getConfiguration("cadPreview")`, passes it through `normalizeViewerDefaults()` (`src/viewerDefaults.ts`), and posts a `"viewerDefaults"` message — synchronous, no `await`, since it's a pure settings read.

**`resolveMeshInput(uri, route, ops, stl, unit = "mm")`** — Private method. Builds the `MeshGenerationInput` `generateMesh`/`exportGeoUnrolled` need: for a B-rep document, re-exports the source to STEP via the existing `exportBRep()` (so live edits are reflected), passing `unitScaleFactor(unit)` as its `scaleFactor` arg; for a mesh document, decodes the caller-supplied base64 `stl` field and, when `unit !== "mm"`, rescales it via the new `scaleStlBytes()` (`src/stlParser.ts`). Returns `undefined` when a mesh document has no `stl` payload yet — callers treat this as a graceful "nothing to mesh", posting `"meshingError"` rather than throwing. `unit` defaults to `"mm"` (native, no conversion); the `"meshingGenerate"` call site always omits it (Generate's overlay is display-only, with no exported file to convert), while `"meshingExport"` passes the message's own optional `unit` field — see the `resolveMeshPartsAndOptions` entry just below for the matching `MeshOptions`/`Part[]` rescale, and CLAUDE.md's Meshing section for the full write-up.

**`resolveMeshPartsAndOptions(uri, input, options, unit = "mm")`** — Private method. Reads the parts sidecar and shapes it per `input.kind`: B-rep sources pass `parts` straight through; STL/mesh sources drop `parts` (`[]`, no true physical-group correlation — see `gmshPartsMap.ts`) and instead apply `applyStlPartSizeOverride()`'s one-off single-sized-part degrade. **Then**, regardless of kind, applies `scaleMeshOptionsForUnit()`/ `scalePartsMeshSizeForUnit()` (`src/meshOptions.ts`) with `unitScaleFactor(unit)` — last, so a single sized STL part's raw-mm override is itself correctly carried into the target unit's numeric space too, not just the B-rep per-part case. A `factor` of `1` (the `"mm"` default) is a no-op returning the same object/array references.

**`handleExport(uri, route, post, pending)`** — Private method. The whole Export flow (triggered by **File ▸ Export… / Save As…**):

1. `exportTargetsFor(route)` → `vscode.window.showQuickPick()` of compatible formats; bails if cancelled.
2. `vscode.window.showSaveDialog()` defaulting to the source's folder + new extension (`EXPORT_EXTENSION`); bails if cancelled.
3. If the target is a B-rep format (STEP/IGES/BREP): reads the source bytes and calls `exportBRep()` directly — no webview round-trip. If the target is a mesh format (STL/OBJ/PLY/glTF): registers a `requestId` in `pending`, posts `"exportMesh"`, and awaits the promise that the `onDidReceiveMessage` handler resolves/rejects when the webview replies.
4. Decodes the result (base64 or UTF-8, per the `binary` flag) and writes it with `vscode.workspace.fs.writeFile()`. Posts `"status"` on success, `"error"` on failure.

**`handleScreenshot(uri, post, pending)`** — Private method. Saves the current 3D view as a PNG (**File ▸ Screenshot**, the toolbar's **View ▾ → Screenshot…** item, or the `cad-preview.screenshot` command). Mirrors `handleExport`'s mesh-target branch exactly — reuses the same `pending` map and `promptSaveAndWrite()` helper, registers a `requestId`, posts `"screenshotRequest"`, and awaits the webview's `"screenshotResult"`/`"screenshotError"` reply — minus the format `showQuickPick` (always PNG).

**`newBlankModelDialog()`** — Private method. Creates an **empty B-rep document** and opens it, so the Edits panel's creation ops (primitives, 2D sketch profiles, wireframe points/lines/arcs → Surface → Volume) can be used from scratch rather than only on top of an existing model. Reached three ways, all one code path: **File ▸ New Blank Model…** (the `newBlank` protocol message), the `cad-preview.new` command, and the Models view's welcome link.

Host-only and session-free, registered alongside `cad-preview.open`/`cad-preview.loadPreprocess` rather than through `withSession` — it must work with no CAD tab focused. The flow mirrors `loadPreprocessDialog()`'s "save dialog → write → `vscode.openWith`" shape:

1. `showSaveDialog()` defaulting to `untitled.brep` in the first workspace folder, filtered to `.brep`.
2. The same `routeFile()` cross-check `loadPreprocessDialog` uses — the dialog filter is advisory on some platforms, so a destination that doesn't route to `{strategy: "occt", format: "brep"}` is refused.
3. **Refuses an existing target.** Blanking an existing model would leave its own `.edits.json` replaying against an empty base — geometry that looks plausible and is silently wrong. VS Code's own overwrite prompt reads as routine and is easy to click through, so this refuses explicitly and names **File ▸ Open…** as the fix, per the `dirtyGuard`/`assertNotSourcePath` convention.
4. `pipeline.buildPrimitivesFile(extensionPath, [], "brep", "mm")` → `workspace.fs.writeFile()`. An empty op list is a supported input to that function (see `src/primitiveWrite.ts`); no new kernel plumbing was needed, since `buildPrimitivesFile` was already a `Pipeline` key.
5. A one-shot `showInformationMessage` noting that the geometry lives in the `.edits.json` sidecar, then `vscode.openWith`.

**`.brep`, not `.step`.** A live probe confirmed all three B-rep writers accept an empty compound (192 / 1661 / 648 bytes), so this is a preference rather than a constraint — but BREP is OCCT's native serialization, carries no unit header to declare for geometry that isn't there yet, and skips `handleBRep`'s STEP/IGES `latin1` unit-detection path entirely. Consequence, since `exportTargetsFor` excludes a document's own format: a blank document's Export… offers STEP/IGES plus every mesh target, but not BREP.

**`getHtml(webview, extensionUri)`** — Private method. Generates the full webview HTML with:

- A strict CSP nonce.
- The compiled `media/viewer.js` bundle (IIFE).
- The `media/viewer.css` stylesheet.
- Static toolbar HTML: the always-visible `#fit`, `#tree-toggle`, and `#meshing-toggle` buttons, plus four `.tb-menu-wrap` dropdowns — `#view-menu`/`#view-dropdown` (`#grid`, `#edges`, `#screenshot`), `#select-menu`/`#select-dropdown` (`#sel-toggle` + the `#select-group` pick-mode row), `#measure-menu`/`#measure-dropdown` (`#measure-toggle`, the `#measure-tool` button row, `#measure-clear`), and `#markup-menu`/`#markup-dropdown` (`#markup-toggle`, the `#markup-tool` button row, `#markup-color`, `#markup-undo`/`#markup-redo`/`#markup-clear`). `#measure-readout` is a sibling of `#toolbar`, not a child, so a long measurement result can't stretch the right-anchored strip. Every button's icon comes from `TOOLBAR_ICONS` (see below), via a local `icon(id)` helper that wraps the markup in `<span class="toolbar-icon">`. No standalone `#wireframe` toolbar button — Wireframe is one of five Display mode states (`#display-mode-group`, in `#view-controls`'s Appearance area).
- A `#markup-canvas` element inside `#app`, a scene sibling of the WebGL canvas (see `doc/webview-api.md`'s `markupModel.ts`/`markupCanvas.ts` section) — a transparent, click-through-by-default overlay for the Markup annotation feature.
- Static view-controls panel HTML (`#view-controls`, `#vc-toggle`, including the `#display-mode-group` Display mode segmented buttons).
- Sidebar (`#side`) containing the tree panel (`#tree-panel`), the Parts panel (`#parts-panel`), the Edits panel (`#edits-panel`), the FE Mesh panel (`#meshing-panel`), and the Mass Properties panel (`#mass-panel`).
- Status/error overlay divs.

---

## `src/toolbarIcons.ts`

**Generated — never hand-edit.** Regenerate with `cd icons && make ts` after changing a source drawing in `icons/tikz-ui/*.tex` (see `icons/README.md` for the full pipeline). Exports:

```typescript
export type ToolbarIconId = "close" | "export" | "feMesh" | "fit" | "generate"
  | "line" | "point" | "select" | "surface" | "tree" | "volume" | "warning" | "wireframe";
export const TOOLBAR_ICONS: Record<ToolbarIconId, string>; // raw <svg>...</svg> markup
```

These replaced the toolbar/panel's plain-color emoji (📤🔍🕸️🌳🔬🖱️📍🧊◼️📏▶, plus ⚠/✕) with monochrome icons that track VS Code's theme. Each value is inline SVG using `currentColor` for strokes/solid fills and `currentColor` + `fill-opacity` for shaded regions (instead of hardcoded colors), generated by `icons/build-toolbar-icons.mjs` from `pdftocairo -svg` output — see that script's header comment for the exact color-substitution rules. The module is plain data with **no `vscode` or DOM dependency**, so it's imported directly by both this file (`provider.ts`, building static HTML host-side) and the webview-side `partsPanel.ts` (delete/remove buttons) and `meshingPanel.ts` (the large-mesh warning line) — see `doc/webview-api.md`. Consumers wrap the markup in `<span class="toolbar-icon">` (`media/viewer.css` sizes it to `1em` and deliberately sets no color of its own, so it inherits whatever `color` the surrounding button/text already has). Chevrons, plain arrows, and the zoom `−`/`+` are deliberately NOT covered — they already render as clean monochrome glyphs in every renderer, unlike real emoji. `src/toolbarIcons.test.ts` enforces the generated file's invariants (valid non-empty SVG per id, no leftover hardcoded `width`/`height`, no literal black, no duplicate `fill-opacity` on one path).

---

## `src/fileRouter.ts`

Maps file extensions to a render strategy and canonical format identifier.

### Types

```typescript
type RenderStrategy = 'occt' | 'three' | 'meshio'
type CadFormat =
  | 'step' | 'iges' | 'brep' | 'stl' | 'obj' | 'ply' | 'gltf'
  | 'vtk' | 'vtu' | 'med' | 'cgns' | 'exodus' | 'xdmf' | 'mdpa'
  | 'openfoam'
  | 'gmsh' | 'abaqus' | 'unv' | 'su2' | 'medit'
interface FileRoute { strategy: RenderStrategy; format: CadFormat }
const MESHIO_FORMATS: readonly CadFormat[]  // the 13 meshio-routed CadFormat members, one source of truth
const AMBIGUOUS_MESHIO_EXTENSIONS: ReadonlyMap<string, string>  // extension -> caveat message; "msh" (also ANSYS/FreeFem) and "inp" (also ANSYS APDL) default to this codebase's own Gmsh/Abaqus output, surfaced as a status/warning on open
type MeshParseFormat = 'stl' | 'obj' | 'ply' | 'gltf'
const COMPARABLE_MESH_FORMATS: ReadonlySet<CadFormat>  // = {stl, obj, ply, gltf}
```

`MeshParseFormat`/`COMPARABLE_MESH_FORMATS` name the mesh formats with a **pure host-side triangle parser** (`stlParser.ts`, `objParser.ts`, `plyParser.ts`, `gltfParser.ts`) — i.e. the ones whose geometry the host can derive on its own, with no webview and no OCCT. Every host-side geometry consumer gates on this one set: `compare_models`, `check_mesh_health`, `promote_mesh_to_brep`, and silhouette SVG export, plus the interactive Compare Models / Mesh Health / Export Silhouette SVG flows.

> **This set used to be declared twice**, once in `mcpTools.ts` and once in `modelComparePanel.ts`, with a comment justifying the duplication as "the two files don't otherwise share an import". That premise had stopped being true (both already import `routeFile` from here), and the copies were a live drift hazard: adding glTF meant widening two sets and nine separate `as "stl" | "obj" | "ply"` casts, two of which were runtime string comparisons TypeScript could not have flagged. The single declaration here, with `MeshParseFormat` as the matching type, removes both problems.

`"meshio"` formats have no Three.js loader and aren't B-rep — the host converts them to an STL boundary surface via `src/meshioService.ts`'s `convertToStlBoundary()` and the webview loads that through the same STL loader a native `.stl` open uses (see `protocol.ts`'s `loadMeshBytes` and `doc/file-formats.md`'s "meshio++ Bridge Formats" section).

### Function

```typescript
function routeFile(filePath: string): FileRoute | undefined
```

Returns `undefined` for unrecognized extensions (the extension never opens those files because `contributes.customEditors` filters them first, so `undefined` is a safety fallback).

**Extension map:**

| Extension       | strategy | format   |
| --------------- | -------- | -------- |
| `.step`, `.stp` | `occt`   | `step`   |
| `.iges`, `.igs` | `occt`   | `iges`   |
| `.brep`         | `occt`   | `brep`   |
| `.stl`          | `three`  | `stl`    |
| `.obj`          | `three`  | `obj`    |
| `.ply`          | `three`  | `ply`    |
| `.gltf`, `.glb` | `three`  | `gltf`   |
| `.vtk`          | `meshio` | `vtk`    |
| `.vtu`          | `meshio` | `vtu`    |
| `.med`          | `meshio` | `med`    |
| `.cgns`         | `meshio` | `cgns`   |
| `.exo`, `.e`    | `meshio` | `exodus` |
| `.xdmf`         | `meshio` | `xdmf`   |
| `.mdpa`         | `meshio` | `mdpa`   |
| `.foam`         | `meshio` | `openfoam` |
| `.msh`, `.msh2` | `meshio` | `gmsh`   |
| `.inp`          | `meshio` | `abaqus` |
| `.unv`          | `meshio` | `unv`    |
| `.su2`          | `meshio` | `su2`    |
| `.mesh`         | `meshio` | `medit`  |

---

## `src/meshioService.ts`

The meshio++ WASM module (`@meshioplusplus/wasm`) — the third host-side WASM singleton alongside OCCT (`occtService.ts`) and Gmsh (`gmshService.ts`), used to import mesh-only formats (see the table above) as viewable documents and to export generated FE meshes to formats Gmsh's own writers can't produce (MED, CGNS, and — a format Gmsh doesn't even recognize as an extension — XDMF). Full write-up, including the non-obvious verified-against-the-live-WASM gotchas (why it must load via a *dynamic* `import()` unlike gmsh-wasm's static one, and the MED-specific merge+strip step that preserves named groups), lives in `doc/gmsh-integration.md`'s "The meshio++ bridge" section — this entry is deliberately brief to avoid the two docs drifting out of sync.

```typescript
function getMeshio(): Promise<MeshioApi>
function resetMeshio(): void

interface MeshioCompanion { name: string; bytes: Uint8Array }
async function convertToStlBoundary(
  sourceBytes: Uint8Array,
  meshioFormat: string,
  sourceName?: string,
  companions?: readonly MeshioCompanion[]
): Promise<Uint8Array>
async function convertFoamCaseToStlBoundary(markerPath: string): Promise<Uint8Array>
async function exportViaMeshio(
  gmshMshText: string,
  outMeshioFormat: string
): Promise<{ bytes: Uint8Array; companion?: { name: string; bytes: Uint8Array } }>

interface MeshioRegionSummary { name: string; kind: string; numEntries: number }
interface MeshioMetadataSummary {
  regions: MeshioRegionSummary[]
  pointDataNames: string[]; cellDataNames: string[]; fieldDataNames: string[]
}
async function readMeshioMetadata(
  sourceBytes: Uint8Array,
  meshioFormat: string,
  sourceName?: string,
  companions?: readonly MeshioCompanion[]
): Promise<MeshioMetadataSummary>

interface MeshioRegionAssignment { regionNames: string[]; triangleRegion: Int32Array }
interface MeshioBoundaryResult { stlBytes: Uint8Array; regions?: MeshioRegionAssignment }
async function convertToStlBoundaryWithRegions(
  sourceBytes: Uint8Array,
  meshioFormat: string,
  sourceName?: string,
  companions?: readonly MeshioCompanion[]
): Promise<MeshioBoundaryResult>

interface MeshioFieldValues { values: Float32Array; min: number; max: number }
async function readMeshioFieldValues(
  sourceBytes: Uint8Array,
  meshioFormat: string,
  fieldName: string,
  kind: "point" | "cell",
  sourceName?: string,
  companions?: readonly MeshioCompanion[]
): Promise<MeshioFieldValues | null>
```

`getMeshio()` always loads with `{ variant: "seq" }` — never `"auto"`, which would pick the threaded (pthread) build under Node every time (verified: the package's own `resolveVariant()` treats `crossOriginIsolated === undefined`, always true under Node, as "pick threaded"), eagerly spawning worker threads with the same hang/crash risk gmsh-wasm's own worker pool already taught this codebase to avoid. `convertToStlBoundary()` powers document import (`provider.ts`'s `handleMeshio`) for every meshio format except OpenFOAM; **`convertFoamCaseToStlBoundary(markerPath)`** handles `.foam`, the one format that is not a single file — a `.foam` marker's real mesh lives in sibling files under `<parent>/constant/polyMesh/`, so it takes the marker's filesystem PATH (not bytes), stages the whole case into meshio++'s virtual filesystem itself (mirroring upstream's `_resolve_polymesh`: `<parent>/constant/polyMesh`, then bare `<parent>/polyMesh`), and hand-builds the STL by fan-triangulating every boundary face — meshio++'s own STL writer silently emits zero facets for a quad-only boundary, and hex-dominant meshes are THE typical OpenFOAM content. Geometry-only by construction (patch names ride an unexposed C++ side-channel struct; no point/cell/field data is read at all), so call sites skip `readMeshioMetadata` and region correlation for it entirely rather than stage the case twice. Throws on failure (a missing polyMesh directory is a clear application error thrown before any WASM work); verified end-to-end via the mcp-smoke OpenFOAM block (`examples/OpenFOAM/hex-case`). `exportViaMeshio()` powers the FE Mesh panel's meshio-bridged export options (`provider.ts`'s `meshingExport` handler and `mcpTools.ts`'s `exportMeshTool`, dispatched via `meshExportFormats.ts`'s `via` field) — its input is `generateMesh()`'s own modern MSH 4.1 `mshText` (readable by meshio++ since 9.7.0, physical groups included; before that a legacy MSH 2.2 detour was required — see `doc/gmsh-integration.md` for the history). MED exports preserve parts/physical groups as **named MED groups** via the merge+regions path documented there.

**`sourceName`/`companions` are optional, additive parameters every entry point now takes** (roadmap "Format coverage", closed — see CLAUDE.md's "meshio++ integration" section) — every pre-existing call site omitting them keeps its exact prior behavior (a synthetic `/in.<meshioFormat>` MEMFS path, no companion staged). A private `stageMeshioSource`/`unstageMeshioSource` pair writes the primary under its real basename (when given one) and every companion under ITS OWN real/referenced basename, flat in MEMFS root — this is what fixes a real, verified defect: a multi-file source (most concretely, the `.xdmf`+`.h5` pair `exportViaMeshio()` itself produces) previously could never be read back at all (`HDF5: could not open file`), since only the primary's bytes were ever staged. `src/meshioCompanions.ts` (pure) supplies the "which companion basenames to look for" half; `provider.ts`'s `resolveMeshioCompanionsFor`/`mcpTools.ts`'s `resolveMeshioCompanions` do the actual disk I/O, mirroring `resolveGltfBuffers`' existing precedent for glTF's external `.bin` buffers.

`readMeshioMetadata()` is a cheap, read-only sibling to `convertToStlBoundary()` — via `readMetadata()` (explicitly documented as loading a file's shape without its heavy geometry/ data arrays), it reports the region names and point/cell/field data array names a source file declares. Never throws (a malformed/unreadable file degrades to every field empty — this is purely supplementary information, must never block or fail an import `convertToStlBoundary` would otherwise handle fine). Used for the metadata-only status line/warning; the actual region→Parts correlation below is a separate function.

`convertToStlBoundaryWithRegions()` (roadmap "Richer meshio++ import", closed) is what actually turns a region into a Part. It `readMesh()`s the full `Mesh` (not the cheap `readMetadata()`) and calls `extractSurface(mesh, recordParentIds=true)`, whose `cell_data["surface:parent_cell"]` gives each boundary triangle the global, block-major index of its original parent cell — exactly what a `kind: "cell"` `Region.entries` indexes, so membership is a plain `Set.has()` test. Builds the returned STL bytes directly from `extractSurface`'s own boundary mesh (not from a second `convertSurface` call) so the geometry/region-index correspondence is correct by construction, not by an assumed match between two independently-callable APIs. Falls back to the plain `convertToStlBoundary()` result (`regions` omitted) whenever the boundary isn't pure `"triangle"` blocks (e.g. a hexahedral volume's quad boundary), there are no `kind: "cell"` regions, or nothing correlates — never throws. `provider.ts`'s `handleMeshio()` (interactively) and `mcpTools.ts`'s `loadModel()` (headlessly, via the injected `Pipeline`) both call it and, when the parts sidecar is still empty, feed the result to `src/meshioRegionParts.ts`'s `buildPartsFromMeshioRegions()` to auto-create one Part per region. See CLAUDE.md's "meshio++ integration" section for the full write-up.

`readMeshioFieldValues()` (roadmap "Colour-by-scalar-field for meshio++ imports", closed) reads one named field's actual VALUES, on demand — called only once the webview's "Colour by field" selector picks a field (`provider.ts`'s `colorFieldRequest` handler), not eagerly like `readMeshioMetadata()`. Reuses the identical `readMesh()` → `extractSurface(mesh, recordParentIds=true)` sequence as `convertToStlBoundaryWithRegions()`, so its output correlates onto the same boundary triangle soup (verified deterministic — identical input bytes always produce byte-identical boundary geometry/order). `kind: "point"` needs no correlation math at all: `extractSurface` already subsets AND reorders `point_data` to match its own output `points` (verified with a deliberately interior point excluded from the boundary — its value is correctly dropped, not just truncated), so `boundary.point_data[fieldName]` is read directly and expanded from per-point to per-corner via each triangle's own point indices. `kind: "cell"` reuses `cell_data["surface:parent_cell"]` exactly as region correlation does: the original mesh's `cell_data[fieldName]` is flattened block-major and each triangle's parent-cell value is broadcast to its 3 corners. Returns `null` (never throws) for a missing field, a non-scalar (multi-component) field, or a non-pure-triangle boundary.

## `src/meshioCompanions.ts`

Pure (vscode/WASM-free), unit-tested. `extractXdmfHdfReferences(xdmfText: string): string[]` scans an XDMF document's `Format="HDF"` `<DataItem>` elements for referenced `.h5` filenames (a plain regex — this codebase has no XML parser available headless, the same constraint `svgImport.ts` documents for its own inbound parser). `stemCompanionCandidates(basename: string, meshioFormat: string): string[]` returns the sibling basenames a stem-convention format's reader would need (tetgen/triangle/ensight — wired into the registry, but not yet used by any registered format). `meshioCompanionCandidates(basename, meshioFormat, xdmfText?)` dispatches between the two — the one function `provider.ts`/`mcpTools.ts` actually call before doing the disk I/O to fetch whatever it names.

## `src/meshioRegionParts.ts`

```typescript
function buildPartsFromMeshioRegions(stlBytes: Uint8Array, regions: MeshioRegionAssignment): Part[]
```

Pure and WASM-free (only `stlParser.ts`'s `parseStl` + `src/webview/meshFacets.ts`'s `segmentCoplanarFacets`, both already DOM/WASM-free) — the one implementation `provider.ts` and `mcpTools.ts` both call, so the interactive extension and headless MCP path can't drift. Parses `stlBytes` into a `THREE.BufferGeometry`, runs `segmentCoplanarFacets` region-gated (its optional `triangleRegion` parameter — see `src/webview/meshFacets.ts`'s doc comment — never merges two triangles from different regions, even if coplanar), and builds one `Part` per region owning ≥1 facet, ids `node-0/face-K` (`node-0` because a meshio import always yields exactly one root mesh — verified via `tagMeshEntities`'s traversal-order id assignment). Returns `[]` (never throws) when the STL/region pairing doesn't line up, or region-aware segmentation collapses to ≤1 or `> MAX_FACETS` facets — mirroring `buildMeshFacetGroup`'s own "keep the mesh whole" rule, since in that case no per-region ids would exist to reference anyway.

## `src/exportTargets.ts`

Maps a `FileRoute` to the formats it can be exported to, and the file extension/label to use for each. Pure functions, unit-tested in `src/exportTargets.test.ts`.

```typescript
function exportTargetsFor(route: FileRoute): CadFormat[]
```

B-rep sources (`route.strategy === "occt"`) return the other two B-rep formats plus all four mesh formats. Mesh sources (`route.strategy === "three"`) return the other mesh formats only. The source's own format is always excluded.

```typescript
const EXPORT_EXTENSION: Record<CadFormat, string>  // e.g. gltf → "glb"
const EXPORT_LABEL: Record<CadFormat, string>       // e.g. gltf → "glTF Binary"
```

Used by `provider.ts`'s `handleExport()` to build the quick-pick items and the save dialog's default filename/filter.

```typescript
const UNIT_CONVERTIBLE_FORMATS: ReadonlySet<CadFormat>  // {"step", "iges", "brep", "stl", "obj", "ply", "gltf"}
```

The gate for unit-conversion-on-export — now every B-rep/mesh export target. `"step"`/`"iges"` were originally excluded (both declare a length unit in their own header that must match the geometry's actual scale, and this OCCT WASM build has no writer-level API to set it directly), but each now has a verified, working fix: STEP via a text patch of the writer's output (`src/stepUnitPatch.ts`), IGES via its alternate unit-aware writer constructor (`IGESControl_Writer_2`, which turned out to genuinely work — the original "couldn't be read back to verify" finding was a false negative caused by an over-long MEMFS path, not a real limitation). `"brep"` has no unit metadata to mismatch; the mesh formats enforce none either. `provider.ts`'s `handleExport` and `mcpTools.ts`'s `exportBRepTool` both gate on this set — see `exportBRep`'s `unit` param below for the full write-up.

---

## `src/occtService.ts`

Manages the OpenCascade.js WASM singleton and performs B-rep parsing and tessellation.

### Types

```typescript
interface BRepResult {
  groups: SolidGroup[]   // from meshExtract.ts (faces, grouped by solid)
  edges: EdgeLine[]      // from meshExtract.ts (deduped edge polylines)
  points: PointEntity[]  // from meshExtract.ts (every vertex in the shape)
  tree: TreeNode         // from protocol.ts
  opOutcomes: OpOutcome[]            // per-op replay results (editOps.ts)
  guideIds: string[]                 // construction-geometry ids (guide: true ops)
  opBuckets: OpBucket[]              // per-op produced-face classification (opBuckets.ts)
}
```

`opBuckets` (roadmap "Selector synthesis" Phase 1): one `{op, kind, roles}` entry per topology-changing op that produced faces — the mechanism is `occtOperations.ts`'s `collectBucketForOp()`, a before/after face-set diff (`HashCode` bucket + `IsSame`) run at each op boundary of the `applyEditsBRep()` fold, gated on `TOPOLOGY_CHANGING_OPS` (rigid transforms' `copy=true` rebuilds every TShape, so an ungated diff would report the whole model as "produced"). Roles: `extrude`/`revolve` record `startCap` via the profile face's `Copy=false` identity reuse (live-verified `IsSame`), `extrude` additionally splits `endCap` (farthest along the extrusion direction) from `side`; every other kind names its whole produced set from `opBuckets.ts`'s `PRODUCED_ROLE` (`band`/`inner`/`wall`/`cutFace`/`sectionFace`/`copies`/`body`, generic `produced` otherwise). **Recorded ids describe the model state at that op's own step** — later topology-changing ops renumber them; re-resolution against the current shape is `entityFacts.ts`'s `resolveBucketSelector()` (ladder rungs 1–3: the bucket path replays the prefix to re-derive the reference ids, replays the full list, matches via the same `rebindEntities` + `1e-3·bboxDiagonal` tolerance rebinding uses — the returned `matches` are the oracle — then an optional induced `filter` (single leaf or AND-list) / `rank` narrows the survivors by exact current-shape facts read AFTER the match, so the oracle always describes exactly the returned ids; the scene path skips the anchor entirely and resolves the induced layer over whole-model facts in a single full replay, returning no matches — the facts are the oracle; surfaced headless as `resolve_selector`). Recorded roles include REBUILT faces, not just brand-new ones (verified live: one box-edge fillet reports 5 faces — 1 new cylinder + 4 rebuilt adjacent planes); those rebuilt faces drift positionally exactly like new ones, which is the point. Wireframe ops and face-less ops (`addPoint`) record nothing; a gracefully-skipped op produces no bucket. The cached path merges prefix+suffix buckets on incremental append exactly like `opOutcomes`.

### Functions

```typescript
function getOcct(extensionPath: string): Promise<any>
```

Returns the memoized OCCT module. Initializes it on the first call by reading `dist/opencascade.wasm.wasm` and calling the raw Emscripten factory. Subsequent calls return the cached promise immediately.

```typescript
function resetOcct(): void
```

Resets the singleton to `null`. Used in tests and hot-reload scenarios. **Not safe to call while a tessellation is in progress.**

```typescript
async function loadBRep(
  extensionPath: string,
  bytes: Uint8Array,
  format: CadFormat,
  ops?: EditOp[],                    // replayable edit op-list (default [])
  quality?: TessellationParams       // default: TESSELLATION_PRESETS.standard
): Promise<BRepResult>
```

High-level, STATELESS entry point — always re-reads and re-parses from scratch. Calls `getOcct()`, writes the file bytes to the OCCT virtual filesystem, calls `readShape()` to parse, calls `readXcafAssembly()` (`src/xcafTree.ts`, STEP only — roadmap "XCAF read — assembly structure", closed) against the SAME still-on-MEMFS file while `readShape`'s `finally` hasn't unlinked it yet, applies the edit op-list via `applyEditsBRep()` (`src/occtOperations.ts`), then calls `tessellateByGroup()` to extract faces, `extractEdges()` to extract deduped edge polylines, `extractVertices()` to extract every vertex in the shape, and `buildTree()` to build the component hierarchy (nested assembly structure when `readXcafAssembly()` succeeded AND cleanly correlates, else the original flat per-solid list — see `buildTree` below). With an empty `ops` this is the original read-only path; the source bytes are never modified. The returned `BRepResult.opOutcomes` (roadmap "A failed edit op is indistinguishable from one that did nothing", closed) carries one `{index, kind, applied, diagnostic?, hint?}` entry per replayed op — a gracefully-skipped op reports `applied: false` with a reason instead of silently changing nothing; `mcpTools.ts` surfaces these as warnings/report fields. `quality` (roadmap "Configurable tessellation quality", closed — `src/tessellationQuality.ts`) is threaded straight into `tessellateByGroup()`'s deflection args; every existing caller omits it (implicit `"standard"`, byte-for-byte the original hardcoded 0.1/0.5 constants), so this is a purely additive, backward-compatible parameter. Called by `mcpTools.ts` (deliberately kept stateless-per-call — see the MCP server section below) and `renderService.ts`; `provider.ts` calls `loadBRepCached` instead (below), NOT this function directly, for its `editsChanged` hot path. The result also carries `guideIds: string[]` — the ids of entities created by `guide: true` (construction-geometry) ops, resolved by identity-matching the replay's collected handles against the id enumerations.

```typescript
interface BRepCacheEntry { /* opaque outside occtService.ts — pass it straight back in */ }

async function loadBRepCached(
  extensionPath: string,
  bytes: Uint8Array,
  format: CadFormat,
  ops: EditOp[],
  previous: BRepCacheEntry | undefined,
  quality?: TessellationParams       // default: TESSELLATION_PRESETS.standard
): Promise<{ result: BRepResult; cache: BRepCacheEntry }>

function disposeBRepCache(cache: BRepCacheEntry): void
```

The caching counterpart of `loadBRep` (roadmap "Base-shape caching and incremental replay", closed) — for `provider.ts`'s per-document, per-`editsChanged` hot path only; `mcpTools.ts` never calls this. Reuses the parsed base shape across calls whenever `bytes`+`format` match `previous` (byte-for-byte comparison, not a hash), and additionally reuses `previous`'s fully-replayed shape when `ops` is a pure append of `previous.ops` — replaying only the new suffix. Any other change (undo, a non-append edit, a variable re-resolving numeric fields) falls back to a full replay of `ops` from the (still-reused, if bytes match) base shape. **Reused fields are aliased by reference** — `disposeBRepCache` must only ever be called on the single, latest entry a caller currently holds, never on an entry that's already been superseded by a later `loadBRepCached` call's return value (doing so frees the SAME live handles the newer entry still references — a real `"Cannot pass deleted object as a pointer"` OCCT crash this was verified against, not a hypothetical). On failure, no handle from the failed call is freed (an abort may leave the WASM heap in an undefined state) — the caller must drop its held reference rather than reuse or dispose it; the underlying orphaned OCCT module becomes GC-eligible once unreferenced. Cache validity across a `resetOcct()`-triggered abort recovery is checked by `===` identity against the CURRENT `getOcct()` resolution, not a separate counter. `quality` is entirely orthogonal to the cache's reuse decisions — tessellation is never cached (see below), so a quality change between two calls with identical `bytes`/`ops` still reuses `baseShape`/`shape` and simply re-tessellates them at the new density. See CLAUDE.md's own sections for the full reuse-rule writeup, the measured ~35× base-shape-cache speedup on a large fixture, and the tessellation-quality live-WASM probing trail (including why edge deflection stays fixed).

`BRepCacheEntry` also carries `assemblyTreeCache: XcafAssemblyInfo | null` (roadmap "XCAF read — assembly structure", closed) — computed alongside `baseShape` under the exact same `baseReusable` gate (a `readXcafAssembly()` call is a genuinely expensive second full-file parse, so an interactive edit that reuses the base shape never re-pays it), then passed into `buildTree()` on every call regardless of whether IT was recomputed this call.

```typescript
function readShape(
  oc: any,
  filePath: string,
  format: CadFormat,
  cleanup: { delete(): void }[]
): any  // TopoDS_Shape
```

Exported (used by both `loadBRep` and `exportBRep`). Selects the appropriate OCCT reader class and calls it. Pushes every handle it creates onto `cleanup` so they're deleted in the caller's `finally` block. The BREP branch's 4th `BRepTools.Read_2` arg is a `Handle_Message_ProgressIndicator` — *not* `Message_ProgressRange`, which isn't a real constructor in this OCCT build and throws immediately.

```typescript
function buildTree(
  oc: any,
  format: CadFormat,
  groups: SolidGroup[],
  shape: unknown,
  assemblyTreeCache: XcafAssemblyInfo | null
): TreeNode
```

Builds a `TreeNode` tree — the flat per-solid list this function always returned before the closed "XCAF read — assembly structure" roadmap item, UNLESS `assemblyTreeCache` is non-null AND `src/xcafTree.ts`'s `correlateAssemblyTree()` can cleanly match its cached, synthetic-id leaves against the CURRENT `shape`'s actual `solid-N` list (via `collectSolids()` + per-solid bbox-centre/volume fingerprints, `occtOperations.ts`) — in which case it returns the real nested assembly hierarchy instead, with each leaf's `faceCount`/label copied over from `groups` (`attachFaceCounts()`, a private helper) so every leaf row is indistinguishable from the flat tree's own row for that same solid. Falls through to the flat tree on ANY correlation failure — non-STEP source, no genuine assembly structure, a topology-changing edit that changed the solid count/positions since `assemblyTreeCache` was computed, or any thrown exception — always degrading gracefully, never blocking model load. See `src/xcafTree.ts` below and CLAUDE.md's "XCAF read — assembly structure" section for the full write-up (including a real transform-composition bug caught and fixed via live-WASM verification).

```typescript
async function exportBRep(
  extensionPath: string,
  bytes: Uint8Array,
  sourceFormat: "step" | "iges" | "brep",
  targetFormat: "step" | "iges" | "brep",
  ops?: EditOp[],            // replayable edit op-list (default [])
  unit?: DisplayUnit,        // unit-conversion-on-export target (default "mm", no-op)
  labelStepUnit?: boolean    // relabel the STEP header too (default true) — see below
): Promise<Uint8Array>
```

Re-parses `bytes` with `readShape()`, applies the edit op-list via `applyEditsBRep()`, and writes the resulting `TopoDS_Shape` out as `targetFormat` via the `writeShape()` helper, returning the output file's bytes (read back from the OCCT virtual filesystem) — so **Export bakes the edits in**. Cleans up every handle — reader/writer/shape/progress-indicator — in a `finally`, plus `oc.FS.unlink()` on both the input and output virtual paths, same discipline as `loadBRep`.

`unit` (default `"mm"`, i.e. no-op) is the SINGLE unit-conversion-on-export param (replacing an earlier raw `scaleFactor: number`) — the in-memory model and every other caller of `exportBRep` (`compare_models`, mass properties) always pass the default and stay in the native mm cascade unit. It's genuinely three different mechanisms per `targetFormat`, all dispatched inside `exportBRep`/`writeShape` rather than pushed onto the caller:

- **`"brep"`**: `occtOperations.ts`'s `scaleShapeForExport(oc, shape, unitScaleFactor(unit), cleanup)` only — a uniform scale about the **origin**, right after edits and before the writer. No header to fix.
- **`"step"`**: the same `scaleShapeForExport` scale, THEN — when `labelStepUnit` is `true` — `src/stepUnitPatch.ts`'s `patchStepUnitDeclaration(text, unit)` rewrites the writer's raw output text afterward — this OCCT WASM build has no writer-level STEP unit API at all (re-confirmed via the full real-OCCT init sequence, not just the plain default writer), so the geometry is scaled first (making every raw number in the file, including the writer's own auto-computed tolerance, already correct) and only the header LABEL needs a text-only fix.
- **`"iges"`**: `scaleShapeForExport` is **never** applied — `writeShape` instead picks `IGESControl_Writer_2(igesUnitName(unit), 0)` (`src/lengthUnits.ts`'s `igesUnitName`) instead of the plain `_1` default whenever `unit !== "mm"`, and that writer overload scales the geometry internally itself; pre-scaling would double-convert.

`provider.ts`'s `handleExport` and `mcpTools.ts`'s `exportBRepTool` both show/accept a unit for every `UNIT_CONVERTIBLE_FORMATS`-listed target (`exportTargets.ts`) — now every B-rep/mesh export target, STEP/IGES included.

**`labelStepUnit` (default `true`) exists ONLY for meshing input, and defaults to the WRONG value for that one caller on purpose (opt-out, not opt-in) — a real regression caught while verifying this feature, not a preemptive design.** `provider.ts`'s `resolveMeshInput` and `mcpTools.ts`'s `resolveMeshInputHeadless` (which re-export a B-rep source to an intermediate STEP for Gmsh, never shown to the user) both explicitly pass `false`. Verified against the live WASM (`gmsh.model.occ.importShapes` + `gmsh.model.getBoundingBox` on a correctly-scaled-AND-labeled `unit:"in"` STEP file): Gmsh's own STEP importer DOES reinterpret the declared unit and silently converts the geometry back to its original (larger) size — completely undoing the scale, while `MeshOptions.sizeMin`/`sizeMax` stay at the separately-rescaled (smaller) values, producing a far-too-fine mesh. Passing `false` keeps the meshing-input STEP's header at the OCCT-native `"mm"` label while its geometry is still genuinely scaled — exactly the behavior this codebase already had before STEP header-patching existed, so callers that forget this parameter get the OLD (correct, for their purpose) behavior back, not a new failure mode.

```typescript
export function writeShape(
  oc: any,
  shape: any,
  filePath: string,
  format: "step" | "iges" | "brep",
  cleanup: { delete(): void }[],
  unit?: DisplayUnit,         // only affects the "iges" branch (default "mm")
  parts?: Part[]              // STEP only — named-solid XCAF export
): void
```

Exported (was module-private) so `src/meshHeal.ts`'s `promoteMeshToBrep` — "Mesh → B-rep promotion" Phase 2 — can write an in-memory promoted shape (sewn from a healed mesh, never read from a source file) through the exact same writer paths, with no behavior change to the function itself. See CLAUDE.md's "Mesh → B-rep promotion" section for the full write-up, including a live-WASM-caught MEMFS path-length bug this reuse surfaced (a >11-character output path silently corrupted the write despite the writer reporting success — fixed by using a short path, mirroring `exportBRep`'s own `/o.${format}` convention).

Internal helper called by `exportBRep`. Per-format writer calls, verified against the live WASM build (the `_1`-suffixed overloads take a C++ `ostream`/`istream` that isn't bound in this build and throw `UnboundTypeError` — always use the path-based overload instead):

- **step**: `new oc.STEPControl_Writer_1()` → `.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true)` → check `IFSelect_RetDone` → `.Write(filePath)` → check status again. Always writes bare millimetres — `exportBRep` patches the header text afterward when `unit !== "mm"`.
- **iges**: `unit === "mm"` → `new oc.IGESControl_Writer_1()`; otherwise `new oc.IGESControl_Writer_2(igesUnitName(unit), 0)` (verified end-to-end against the live WASM: for all five `DisplayUnit`s, the written file's declared unit AND its geometry scale are both correct — round-tripped through this codebase's own `readShape` to recover the source model's exact bounding box). Either way: `.AddShape(shape)` → `.ComputeModel()` → `.Write_2(filePath, false)` (boolean return).
- **brep**: `oc.BRepTools.Write_2(shape, filePath, new oc.Handle_Message_ProgressIndicator_1())` (boolean return).

---

## `src/stepUnitPatch.ts`

Pure, vscode/OCCT-free text surgery — `patchStepUnitDeclaration(stepText: string, unit: DisplayUnit): string` — rewrites a freshly-OCCT-written STEP file's textual unit declaration to match geometry that `exportBRep` already scaled before the writer ran. `unit === "mm"` is a no-op (OCCT's writer already emits millimetres).

Otherwise: finds every occurrence of OCCT's exact bare-mm entity text (`#N = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );`) — a single compound-shape write can emit several independent ones, one per representation context, each referenced from its own `GLOBAL_UNIT_ASSIGNED_CONTEXT` tuple AND a paired `UNCERTAINTY_MEASURE_WITH_UNIT`. For `"cm"`/`"m"`, each found entity's `SI_UNIT(...)` clause is relabeled in place (same id, e.g. `SI_UNIT($,.METRE.)` for `"m"` — the bare-`$`-no-prefix form). For `"in"`/`"ft"`, one shared `CONVERSION_BASED_UNIT` (+ its `DIMENSIONAL_EXPONENTS` and `LENGTH_MEASURE_WITH_UNIT` conversion-factor entities, at fresh ids beyond the file's existing max) is appended before the DATA section's closing `ENDSEC;`, reusing the first found mm entity as the conversion basis; every context's two references are then redirected to the new entity (the reused base entity's own definition line is left untouched). `src/stepUnitPatch.test.ts` covers all five units plus a synthetic multi-context fixture (mirroring `bull.stp`'s real 5-block output) confirming every context gets redirected and only one shared conversion entity is appended, not one per context.

---

## `src/occtOperations.ts`

The host-side OCCT **edit engine**. Folds the replayable op-list over a freshly-read `TopoDS_Shape` and returns the edited shape, which `loadBRep`/`exportBRep` then tessellate / write exactly as for an unedited file. The webview never sees OCCT.

```typescript
function applyEditsBRep(
  oc: any,
  baseShape: any,            // TopoDS_Shape
  ops: EditOp[],
  cleanup: { delete(): void }[]
): any                       // TopoDS_Shape (edited)
```

Reduces `ops` over `baseShape`. Every wrapped handle it creates is pushed onto `cleanup` (freed in the caller's `finally`); the **returned** shape is *not* deleted here — the caller owns its lifetime. Unimplemented ops are skipped, so a sidecar authored against a newer build never hard-fails an older one.

**Transforms (M1)** are applied by `transformSolids()`, which respects the same deterministic `solid-N` explorer order the read pipeline uses: when every solid is targeted (or the shape has no solids) the whole shape is transformed; otherwise a new `TopoDS_Compound` is assembled from the transformed targets plus the untouched rest. The `gp_Trsf`/`gp_GTrsf` suffix details are recorded in `CLAUDE.md` (verified against the live WASM).

```typescript
function scaleShapeForExport(oc: any, shape: any, factor: number, cleanup: { delete(): void }[]): any  // TopoDS_Shape (scaled)
```

Exported (unlike the op-transform helpers above, which stay private) for `exportBRep()`'s unit-conversion-on-export feature — see [`src/occtService.ts`](#src-occtservicets) below. A uniform `gp_Trsf.SetScale` + `BRepBuilderAPI_Transform` about the **origin** (not a centroid or an op-supplied `center`), since unit conversion means "multiply every coordinate by this factor," not "resize around a point."

**Booleans (M2)** are applied by `booleanSolids()` via `BRepAlgoAPI_{Fuse,Cut, Common}_3(s1, s2).Shape()` (the progress-range arg is optional/unbound). Each operand shape is built from its `solid-N` set (a compound when more than one); the operands are replaced by the single boolean result and the untargeted solids are preserved in a rebuilt compound. An op with unresolved operands or `IsDone()===false` is skipped.

**Fillet/chamfer (M3)** are applied by `filletEdges()` via `BRepFilletAPI_MakeFillet` / `BRepFilletAPI_MakeChamfer` + `.Add_2(amount, edge)` → `.Shape()`. Edge `edge-N` ids are resolved by `collectEdges()`, which replicates `extractEdges`' exact de-dup + discretization-validity ordering so the picked ids map to the right live edges. A fillet whose edges don't resolve or whose `.Shape()` throws / `IsDone()` is false is skipped.

**Feature modeling (M4)** is applied by `featureModel()`/`buildFeatureSolid()` — extrude (`MakePrism_1`), revolve (`MakeRevol_1`), sweep (`MakePipe_1`), loft (`ThruSections`). Profile `face-N` ids are resolved by `collectFaces()` in the same global solid→face order `tessellateByGroup` assigns; the resulting solid is **appended** as a new body (`compound(existing + new)`), never cutting/fusing the source. Operands that don't resolve or builders that throw are skipped. `extrude`/`revolve`/`sweep` take an optional region `pick` (`regionFacesFor()` over `wiresOfFace()` explorer-order wires: `0` = outer boundary matched by `OuterWire`+`IsSame`, `1..N` = inner loops; omitted/`"outer"` = face as modeled, `"all"`/`0…` = outer boundary filled, without-`0` = island faces fused via `combineSolids`); an explicit `pick` refuses `thin`, and `loft`/`rib` reject `pick` at validation. **Drill** (`drillCut()`, same entry point) builds one region prism per picked region and `Cut_3`s the fused tool from the targets, replacing them alongside untargeted solids (the `cutHole` skeleton). Extrude takes `length` XOR `upToFace`: the terminator form derives the length as profile-plane→terminator-plane distance along `dir` (`extrudeLengthUpToFace`, pure plane math over `faceSurfaceInfo` — `BRepAlgoAPI_Section` was probed and is unusable in this build, see CLAUDE.md), then runs the identical prism builder, so thin/bucket/start-cap behavior is shared, not duplicated. Miss (terminator behind/coplanar), parallel direction, non-planar profile/terminator, and guide terminators each skip with a specific diagnostic. Loft takes an optional strict-boolean `smoothing` through the shared `loftWires()` choke point (plain, open-band, and outer/inner-thin paths alike): the only `ThruSections` knob with a measured effect in this build (probed: -0.711% on a progressively-twisted 4-section fixture; `SetContinuity`/`SetParType`/`SetMaxDegree`/`SetCriteriumWeight` are accepted but byte-identical everywhere tried, so only smoothing is exposed) — omitted/`false` replays exactly like the pre-smoothing builder. **Rib** (`ribFused`, same `featureModel` entry point but returning the full fused shape instead of an appendable body): open spine wire → `profileFaceFor` band → prism at terminator distance + one-thin embed each side (the embed turns a coplanar touch, which fails `Fuse_3`, into a penetrating overlap) → `Fuse_3` against the **solids only** (`splitSolidsAndDebris` — loose sketch edges in the operand make the fuse return `IsDone() === false`, probed; debris carries over untouched) → junction blend at `blendRadius` (default `thin/4`, `0` = fuse only) over `ribJunctionEdges` (support-plane + lateral-to-spine footprint, `thin/2` bound — a full-thin bound admits the support's own boundary edges and poisons the combined fillet, probed; `Edge_1`/`Vertex_1` casts required throughout). Blend failure skips the whole op with a naming diagnostic (set `blendRadius: 0` for fuse-only).

**Assembly (M5):** `explodeSolids()` spreads each solid from the model bbox centre by `factor` (all formats; mesh path in `meshEdits.applyMeshExplode`). `mateShape()` aligns planar `faceA` onto `faceB` via `gp_Trsf.SetDisplacement` of `gp_Ax3` frames (face planes from `BRepAdaptor_Surface_2`), moving the solid `owningSolid()` finds for `faceA`. Non-planar faces / unresolved ids / failed displacement are skipped.

**Primitive creation (M6)** is applied by `addPrimitive()`/`buildPrimitiveSolid()` — the one op family with **no existing operands**: it builds a new solid from parameters alone and appends it (`compound(existing + new)`, same non-destructive pattern as `featureModel`), and unlike M3/M4/M5's B-rep-only ops, it also runs on the mesh engine (`meshEdits.buildPrimitiveMesh`) — see `src/webview/meshEdits.ts` below. `BRepPrimAPI_MakeBox_3`/`MakeSphere_5`/`MakeCylinder_3`/`MakeCone_3`/`MakeTorus_5` build the five direct-primitive shapes from a `gp_Pnt_3`/`gp_Ax2_3` placement; the N-gon prism has no OCCT primitive, so it's built by hand (`planeBasis()` computes two JS-side perpendicular unit vectors, N points are placed around them, then `buildFlatFace()` — `BRepBuilderAPI_MakeWire_1`/`MakeFace_15` — makes the base face, then the already-verified `MakePrism_1` extrudes it). A primitive whose builder throws is skipped.

**2D profile sketches (M7)** are applied by `addProfile()`/`buildProfileFace()` — like primitives, no existing operands, but the appended body is a bare **`TopoDS_Face`** (no thickness), meant to be picked (Surf mode) and fed into `extrude`/`revolve`/`sweep`/`loft` as the `profile` operand afterward. B-rep only (`BREP_ONLY_OPS`). Circle uses `gp_Circ_2(gp_Ax2_3(pnt, normal), radius)` → `BRepBuilderAPI_MakeEdge_8(circ)` → wire → face; rectangle/polygon reuse the same `buildFlatFace()` helper the N-gon prism uses, with corners computed via `inPlaneBasis(normal, up)` — unlike `planeBasis()`, this derives the in-plane `u` axis from the op's explicit `up` vector (projected off `normal`, normalized) so orientation is user-controlled, not arbitrary.

**This required extending the tessellation pipeline itself.** `tessellateByGroup` (`src/meshExtract.ts`) used to only extract faces belonging to a solid; a bare face appended into the model compound would be silently invisible. It now also runs a free-face pass — after tessellating each solid, it claims every face it touched (`HashCode` bucket + `IsSame`, the same de-dup technique `extractEdges` already uses for edges) and then walks the whole shape's faces once more, surfacing anything not claimed as an extra `"Sketches"` group. **`collectFaces()`/`addFreeFacesOf()` in this file duplicate that exact algorithm** so `face-N` ids resolve to the same live face on both the read/display path and the edit-resolution path — if the two ever drift out of lockstep, a `face-N` picked in the view will silently target the wrong face. Verified end-to-end against the live WASM, not assumed: a compound of a solid + a free face splits into exactly the expected claimed/free counts, and `addCircleProfile` immediately followed by `extrude` on the predicted `face-N` resolves to the exact face OCCT just built. Extruding a profile **consumes** it — `MakePrism_1`'s `Copy=false` reuses the source face as the new solid's base cap, so no duplicate face is left behind in `"Sketches"` afterward. A profile whose builder throws is skipped.

**Bottom-up wireframe modeling (M8)** — `addWireframePrimitive()` (point/line/arc), `addSurfaceFromLines()`, and `addVolumeFromSurfaces()` — is B-rep only (`BREP_ONLY_OPS`), all five ops. Point/line/arc follow the same append pattern as every other creation op: `BRepBuilderAPI_MakeVertex(pnt)` (unsuffixed — this class, like `BRepBuilderAPI_Sewing` below, has no `_N` overloads in this binding), the already-verified `BRepBuilderAPI_MakeEdge_3(pnt, pnt)` for lines, and the already-verified `gp_Circ_2` trimmed via `BRepBuilderAPI_MakeEdge_9(circ, alpha1, alpha2)` for arcs (radians; found among the 35 `MakeEdge` overloads). Neither points nor edges built this way are resolved as operands by anything else — `addLine`/ `addArc` take typed `Vec3` coordinates, not entity-id references, so there is **no `collectVertices()`** in this file.

`addSurfaceFromLines()` resolves `edge-N` ids via the **existing** `collectEdges()` (unchanged), assembles them with `BRepBuilderAPI_MakeWire_1` + `.Add_1()` per edge — verified to auto-connect edges added in shuffled order via their shared vertices — then `BRepBuilderAPI_MakeFace_15(wire, true)`. `.IsDone()` catches genuinely disconnected edges but **not** an "almost closed" open chain (no reliable closed-loop check was found in this binding — `BRepTools.IsReallyClosed`/ `DetectClosedness` need args this binding doesn't expose usefully, and `ShapeAnalysis_Wire.CheckClosed` didn't distinguish closed from open in testing); an open chain may still produce a best-effort face, which is harmless. The resulting face flows through the existing free-face pass with no further changes.

`addVolumeFromSurfaces()` resolves `face-N` ids via the **existing** `collectFaces()` (which already includes the M7 free-face pass, so an M8b-built surface is selectable here too), sews them with `new BRepBuilderAPI_Sewing(tolerance, true, true, true, false)` (5 required params, no shorter overload) → `.Add(face)` per face → `.Perform(new Handle_Message_ProgressIndicator_1())` → `.SewedShape()`, pulls the `TopAbs_SHELL` via `TopoDS.Shell_1`. The closure check is **`sew.NbFreeEdges()`** — `0` for a properly closed shell, `>0` for an open one — found only after `.IsNull()`, sign/magnitude of `BRepGProp.VolumeProperties`, and `BRepBuilderAPI_MakeSolid` all gave misleading non-error results on an open shell. `BRepBuilderAPI_MakeSolid_3(shell)` builds the final solid. **Sewing does not consume its input faces** (unlike extrude's `Copy=false`) — the source faces remain visible in `"Sketches"` after a successful volume build; left as-is rather than suppressed (would need excluding specific faces from the compound rebuild, extra complexity for a cosmetic concern). Any op with unresolved operands, a builder throw, or (surface/volume specifically) a structurally invalid selection is skipped.

**Extended sketch profiles (M9)** widen `buildProfileFace()` with ellipse (`gp_Elips_2(gp_Ax2_2(pnt, normal, xdir), major, minor)` → `MakeEdge_12` — the `gp_Ax2_2` overload pins the major axis to an explicit in-plane X; when `radiusY > radiusX` the basis rotates 90° and the radii swap, since `gp_Elips` requires major ≥ minor), rounded rectangle and slot (mixed straight edges + quarter/half-circle corner arcs via the shared `cornerArcEdge()` — explicit-X `gp_Ax2_2` + the already-verified `gp_Circ_2`/`MakeEdge_9` — assembled by `faceFromEdges()`), and trapezoid (4 computed corners → the existing `buildFlatFace()`). All flow through the same free-face pass; verified end-to-end (exact bboxes, tilted planes, radii-swap path, extrude-consumes).

**Wedge + holes (M10):** `buildPrimitiveSolid()` gains `addWedge` — `BRepPrimAPI_MakeWedge_2(gp_Ax2_2(origin, axis, u), dx, dy, dz, ltx)`, where the Ax2 location is the wedge's local origin corner, so it's offset by −dx/2·u −dy/2·v to make the op's `center` the base-rectangle centre (B-rep only; no Three.js wedge). The hole family is applied by `cutHole()`/`buildHoleTool()`: a cylinder (plus a fused wider mouth cylinder for counterbore, or a mouth cone for countersink — cone depth derived from the included angle) subtracted from the resolved targets via the verified `Cut_3`, rebuilt with untargeted solids preserved (the `booleanSolids` skeleton). Holes run on **both engines** (`meshEdits.applyMeshHole` mirrors it with CSG). Verified: through/blind/ counterbore/countersink volumes all match analytic expectations.

**Curves (M11)** extend `buildWireframePrimitive()`: polyline (a wire of verified `MakeEdge_3` segments — each segment gets its own pickable `edge-N`), three-point arc (`GC_MakeArcOfCircle_4(p1, p2, p3)`; `IsDone()` false for a collinear triple), spline (`GeomAPI_PointsToBSpline_2(TColgp_Array1OfPnt_2, 3, 8, GeomAbs_C2, 1e-6)` — an approximating, endpoint-exact fit; `GeomAPI_Interpolate` is **not bound** in this build), Bézier (`Geom_BezierCurve_1(arr)`), ellipse arc (trimmed `MakeEdge_13(elips, a1, a2)`, with a −90° angle shift when the radii swap so trim angles stay measured from `up`), and helix (a 2D segment in the (angle, height) parameter space of a `Geom_CylindricalSurface_1`, `MakeEdge_30(h2dcurve, hsurface)`, then `BRepLib.BuildCurves3d_2(edge)` builds the real 3D curve). Geom-handle curves become edges via the shared `edgeFromCurveHandle()` (`Handle_Geom_Curve_2` + `MakeEdge_24`).

**Modify ops (M12)**, all B-rep only: `shellSolids()` hollows the solid(s) owning the selected opening faces via `BRepOffsetAPI_MakeThickSolid_1()` + `MakeThickSolidByJoin(solid, TopTools_ListOfShape, offset, tol, BRepOffset_Skin, false, false, GeomAbs_Arc, false)` — 9 args, no progress arg; **an empty closing list does NOT hollow** (it yields the plain offset solid), which is why the op requires ≥1 opening face and derives each face's owning solid itself. `splitSolidsByPlane()` is a **half-space cut with zero new bindings**: an axis-aligned box spanning the negative side of z=0 (10× bbox diagonal) is moved onto the split plane with the mate-verified `SetDisplacement`, then `positive → Cut_3`, `negative → Common_3`, `both → compound of both`. `sectionSolids()` intersects a large `buildFlatFace()` plane with the targets via `Common_3` (verified to return exactly the trimmed cross-section face) and **appends** the result non-destructively — it lands under `"Sketches"` via the free-face pass, pickable like any sketch; a plane that misses appends nothing. `draftFaces()` tapers selected faces via `BRepOffsetAPI_DraftAngle_2(shape)` (the **only working ctor** — the plain one is unbound, `_1` wants >1 params) → `Add(face, gp_Dir, angleRad, gp_Pln_2(Ax3), true)` (a 5-arg overload deduced from embind's type errors, confirmed live) → `Build()` → `Shape()`. The neutral plane is the op's optional `planePoint`/`planeNormal` pair, falling back to the drafted face's OWN plane via `facePlane()` when omitted (improving on FluidCAD's hardcoded bbox-min-Z neutral plane). **`Build()` is kernel-broken in this WASM build** — it reliably throws an un-decodable `Standard_Failure` on real geometry across fresh processes, so the op degrades to an honest graceful skip naming the kernel limitation (the bindings are kept exactly as verified, so a future build that fixes `Build()` needs no code change); see `CLAUDE.md`'s item-10 section for the probing trail. The three plane-bearing modify ops additionally accept **`midplaneFaces: [faceId, faceId]`** — two planar, parallel faces resolved via `facePlane()`, the op acting on the plane halfway between them (plane-offset average, so sign-flipped normals cancel); XOR with the inline vectors, validated structurally, graceful-skip with a diagnostic otherwise.

**Align and pattern (M13)**, neither B-rep only — both also run on the mesh engine (`meshEdits.applyMeshAlign`/`applyMeshPattern`). `alignSolids()` translates each targeted solid, **independently**, along one axis so its OWN bbox `extent` (min/center/max, via the new private `bboxExtent()` helper — `Bnd_Box`/`CornerMin`/`CornerMax`, filling the one gap `bboxCenter`/`bboxDiagonal` didn't already cover) lands on the absolute coordinate `to` — deliberately does **not** reuse `transformSolids()`'s "whole shape as one unit when every solid is targeted" fast path, since that would compute the delta from the COMBINED bbox rather than each solid's own, silently changing behavior based on how many solids happen to be selected. `patternSolids()` (the shared engine behind `patternLinear()`/`patternCircular()`) is a genuinely new hybrid: it resolves `targets` via `collectSolids()` like the transform ops, but **appends** `count - 1` transformed COPIES (`BRepBuilderAPI_Transform_2(shape, trsf, /*copy=*/true)`, the same already-verified rigid-transform call `transformSolids()`'s own `rigid()` helper uses) into a rebuilt compound alongside the untouched originals — the first op to need both "keep the original" (like a transform) AND "append new geometry" (like a primitive) in the same call. `count` includes the original (so `count - 1` new solids are appended), matching how most CAD pattern tools count "instances." `patternCircular()` additionally accepts **`midaxisOf: [idA, idB]`** — two cylindrical faces (axes via `faceSurfaceInfo()`'s cylinder branch) or two parallel straight edges (`edgeDirection`/`edgeMidpoint` over their endpoints), the pattern rotating about the axis halfway between; mixed face/edge pairs and non-parallel axes refuse with a diagnostic. The mesh engine refuses both reference fields (`midplaneFaces`/`midaxisOf`) with a clear diagnostic — it has no analytic faces; inline vectors remain the mesh route.

**Edge slots and construction geometry (item-10 additions to the creation families)**: `addEdgeSlot()` (B-rep only, appended under "Sketches") builds a stadium face around an existing `edge-N` — width across, length = edge length + width — oriented by the edge's adjacent face's plane when one resolves (via the shared `buildEdgeFaceAdjacency()`; fallback `[0,0,1]`). **Construction geometry**: the 16 profile/curve creation kinds accept `guide: true` (validated by the exported `GUIDE_KINDS` set in the `validateEditOp` wrapper); when set, `addProfile()`/`addWireframePrimitive()` record the built handles into an optional `GuideCollector` threaded through `applyEditsBRep()` (a polyline records its wire's per-segment edges, not the wire), `loadBRep()`/`loadBRepCached()` identity-match them against the `face-N`/`edge-N`/`point-N` enumerations via `HashCode`-bucket + `IsSame` (`collectGuideIds()`), and `BRepResult` gains `guideIds: string[]`. `featureModel()`/`addSurfaceFromLines()`/`addVolumeFromSurfaces()` refuse guide operands with a `guide` diagnostic — the "excluded from profile resolution" half of the contract — while guides stay rendered (dimmed webview-side), pickable, and measurable. The cached path stores the guide collector in `BRepCacheEntry` and merges prefix+suffix on incremental append, exactly like `opOutcomes`.

---

## `src/editOps.ts`, `src/editsStore.ts`, `src/editsSidecar.ts`

The edit-operation model and its sidecar, mirroring the parts trio.

`src/editOps.ts` is **vscode-free** and holds the `EditOp` discriminated union plus:

```typescript
type ExprMap = Record<string, string>                    // field path → expression string
function validateEditOp(raw: unknown): EditOp | null   // single tolerance gate
const TOPOLOGY_CHANGING_OPS: ReadonlySet<EditOp["op"]>  // re-id faces/edges on reload
const BREP_ONLY_OPS: ReadonlySet<EditOp["op"]>          // disabled for mesh files
```

Every `EditOp` may carry an optional parametric annotation `exprs?: ExprMap` (see [File Formats](./file-formats.md#parametric-variables)); `validateEditOp` sanitizes it against the already-validated op (only keys addressing a finite numeric slot, only syntactically valid expressions, size-capped) and carries it onto the clean op.

`src/editsSidecar.ts` is **vscode-free** (unit-tested): `parseEditsJson(text)` returns `{ ops, variables }` — it runs every op through `validateEditOp` and the variables through `validateVariables`, then **re-resolves** the ops' expressions against the variables (`resolveEditOps`), healing stale cached numbers in a hand-edited sidecar. `serializeEditsJson(sourceName, ops, variables)` is version-stamped with a trailing newline; `variables` is omitted when empty.

`src/editsStore.ts` wraps them with VS Code filesystem access: `editsSidecarUri()` (`<model>.edits.json`), `readEdits()` (tolerant — empty lists on missing/unreadable), and `writeEdits(uri, ops, variables)` (writes only the sidecar; the CAD file is never touched).

---

## `src/paramExpr.ts`, `src/editVariables.ts`

The parametric layer — both **vscode/DOM-free** (unit-tested), imported by the host (sidecar parsing) and the webview (input parsing, resolve-on-read).

`src/paramExpr.ts` is a hand-written recursive-descent expression evaluator (webview CSP blocks `eval()`): numbers, variable identifiers, `+ - * / ^`, unary minus, parentheses, `sqrt/abs/min/max/floor/ceil/round/sin/cos/tan` (degrees) and `pi`. Plus field-path addressing for `exprs` keys:

```typescript
function evalExpr(src: string, vars: Record<string, number>): { ok: true; value: number } | { ok: false; error: string }
function parseExprSyntax(src: string): boolean       // unknown identifiers allowed
function extractIdentifiers(src: string): string[]
function isValidVariableName(s: string): boolean
function parseFieldPath(path: string): (string | number)[] | null  // "size[1]", "points[2][0]"
function getNumericField(op: unknown, path: FieldPath): number | null
function setNumericField(op: unknown, path: FieldPath, v: number): boolean  // only into finite-number slots
```

`src/editVariables.ts` holds `ParamVariable` (`{name, expr, value}` — `value` is the cached last-good evaluation) and:

```typescript
function validateVariables(raw: unknown): ParamVariable[]  // tolerance gate (names, dupes, size caps)
function evaluateVariables(vars: ParamVariable[]): { values: Record<string, number>; errors: Map<string, string> }
function resolveEditOps(ops: EditOp[], values: Record<string, number>): { ops: EditOp[]; issues: string[] }
```

`evaluateVariables` runs in list order against earlier-defined names only (derived variables work, cycles are unrepresentable); a failing variable keeps its cached `value`. `resolveEditOps` clones each annotated op, patches the addressed fields, and re-runs `validateEditOp` on the result — an op whose resolved values violate a cross-field invariant is kept at its previous values (issue recorded, replay never hard-fails). Resolution runs at exactly two sites: `parseEditsJson` (host) and the webview's resolve-on-read (`currentResolvedOps` in `src/webview/main.ts`) — the host otherwise receives already-resolved ops and never evaluates expressions at runtime.

---

## `src/gmshService.ts`

Manages the GMSH-wasm singleton (a **second**, independent Emscripten module from OCCT's) and performs finite-element mesh generation. See [GMSH Integration](./gmsh-integration.md) for the full write-up (input paths, options, sidecars, protocol messages, and known WASM-build limitations); this section covers the module's API surface only.

### Types

```typescript
type MeshGenerationInput =
  | { kind: "brep"; stepBytes: Uint8Array }
  | { kind: "stl"; stlBytes: Uint8Array }

interface MeshResult {
  positions: Float32Array   // boundary triangulation vertices
  indices: Uint32Array      // boundary triangulation indices (0-based)
  edges: Uint32Array        // true element-edge line segments (index pairs) for the wireframe
  elementGroups: MeshElementGroup[]  // per-part colour ranges into `indices`
  nodeCount: number         // full mesh node count
  elementCount: number      // full mesh element count
  mshText: string           // raw .msh file contents
  quality?: QualitySummary  // per-element quality summary — see computeQualityAndWorstElements below
  worstElements?: WorstElementsOverlay  // worst-quality-elements highlight — 3D generates only
}

interface WorstElementsOverlay {
  indices: Uint32Array      // triangle indices into the SAME `positions` buffer as MeshResult.indices
  threshold: number         // the minSICN cutoff used to select "worst" elements
  shownCount: number        // elements actually included in `indices` — capped at MAX_WORST_ELEMENTS
  belowThresholdCount: number  // total elements below `threshold` found (>= shownCount if capped)
}
```

### Functions

```typescript
function getGmsh(extensionPath: string): Promise<GmshApi>
```

Returns the memoized GMSH-wasm module, mirroring `getOcct`'s lazy-init discipline: never called from `activate()`, initialized on the first call to `generateMesh`/ `exportGeoUnrolled`/`exportMeshFormat` (i.e. the first time the user clicks **▶ Generate** or **📤 Export** — never on file open). Reads `dist/gmsh-core.wasm` and passes it as `wasmBinary` to the raw Emscripten factory (the same reason as OCCT: passing `wasmBinary` explicitly avoids Node's `fetch()` fallback, which cannot resolve a filesystem path), then calls the module's own `gmsh.initialize()` exactly once and memoizes the resolved promise. Subsequent mesh generations reuse this singleton — per-generation state is reset with `gmsh.clear()` + `gmsh.model.add(...)` inside `loadGeometryAndApplyOptions` (private), never a second `gmsh.initialize()`.

```typescript
function resetGmsh(): void
```

Resets the singleton (and the internal model-name counter) to its initial state. Used by tests and for future hot-reload support.

```typescript
async function generateMesh(
  extensionPath: string,
  input: MeshGenerationInput,
  options: MeshOptions,
  parts: Part[] = []
): Promise<MeshResult>
```

Loads `input`'s geometry into a fresh GMSH model, applies `options` (`Mesh. MeshSizeMin/Max`, `Mesh.Algorithm`, `Mesh.Algorithm3D`, `Mesh.ElementOrder`, `Mesh. RecombineAll`, `Mesh.SubdivisionAlgorithm`, `Mesh.Optimize`), calls `gmsh.model.mesh.generate(options.dimension)`, and reads the result back. For `dimension === 3` the returned `positions`/`indices` are the volume mesh's **boundary surface**, derived by enumerating each 3D cell's boundary faces (tetrahedra, hexahedra, prisms, pyramids — via the shared `src/gmshElementTypes.ts` table) keyed by *sorted corner* node tags so a face shared by two cells collides to the same key, keeping only faces that occur exactly once (quad faces triangulate into two); for `dimension === 2` the generated surface elements (triangles or recombined quads) are used directly; for `dimension === 1` there is no triangle to display and both buffers are empty. Writes `/out.msh` to GMSH's MEMFS and reads it back as `mshText`. Cleans up (`FS.unlink`) both the input and output MEMFS paths in a `finally`, mirroring `occtService.ts`'s handle-cleanup discipline (though here the "handles" are MEMFS files, not Emscripten object handles — GMSH-wasm's JS API doesn't expose C++ object lifetimes the way OCCT's bindings do). Also calls the private `computeQualityAndWorstElements()` and includes its result as `quality`/`worstElements`.

```typescript
function computeQualityAndWorstElements(
  gmsh: GmshApi,
  dimension: MeshOptions['dimension'],
  tagToIndex: Map<number, number>
): { quality?: QualitySummary; worstElements?: WorstElementsOverlay }
```

Per-element quality summary over the mesh's top-dimension elements, via Gmsh's own `getElementQualities` — no host-side geometry math needed — PLUS, for a 3D generate only, a highlight overlay of the worst-quality elements' own boundary (computed together, not as two separate `getElements`/ `getElementQualities` passes, since both need the same per-element type/nodeTags/quality correlation). **Verified against the live WASM** (the usual brute-force-probing convention): `gmsh.model.mesh.getElements(dim, -1)` (all entities at `dim`) returns a plain **object** `{elementTypes, elementTags, nodeTags}` — NOT a tuple, despite some Gmsh API references implying one — where `elementTags`/`nodeTags` are one array **per element type**, so callers flatten across types (same pattern `countElements()` already uses) to correlate against `getElementQualities`'s flat result. `gmsh.model.mesh.getElementQualities(tags: number[], qualityType: string)` accepts a plain JS number array and returns `{elementsQuality: number[]}`, one value per input tag in the same order as the flattened `elementTags`; verified with `"minSICN"` (Signed Inverse Condition Number, ≈[-1, 1], 1 = perfect, ≤ 0 = degenerate/inverted) — `"minSJ"`/`"gamma"`/ `"minSIGE"`/`"volume"` are also accepted quality-type strings, an invalid string throws `"Unknown quality name '...'"`. **One anomalous verification run** returned an empty `elementsQuality` array for an otherwise-valid, full-size call (never reproduced across 5+ identical follow-up runs, including full end-to-end runs via `npm run mcp:smoke` against real multi-solid geometry) — `computeQualityAndWorstElements` defensively checks the returned array's length matches the input and returns `{}` (quality/ worstElements both omitted, not crashed) rather than trusting it blindly, matching this codebase's graceful-skip convention for every other WASM edge case.

**Worst-element selection** (`dimension === 3` only — a 2D mesh's elements ARE the displayed surface already, so there's no "interior, invisible" problem to solve there): every element scoring below `WORST_ELEMENT_QUALITY_THRESHOLD` (`0.2`), sorted worst-first and capped at `MAX_WORST_ELEMENTS` (`2000`, never a silent truncation — `belowThresholdCount` vs `shownCount` reports both). Each kept element's own complete face set is triangulated via the SAME `boundaryTriangles()` (`gmshElementTypes.ts`) the main overlay's boundary uses — but fed ONLY the worst elements as input, so a face shared between two adjacent bad elements dedups away (an interior seam within the highlighted cluster) while a face adjacent to a good (unselected) neighbor stays (the cluster's true outer surface). This sidesteps the tet→boundary-face correlation problem entirely: rather than projecting bad *interior* elements onto the mesh's outer boundary, the highlight is the bad elements' own real geometry, rendered through the model via a depth-test-disabled "ghost" material in the webview (`geometryBuilder.ts`'s `buildWorstElementsHighlight`, mirroring the Hidden Lines display mode's ghost-line technique — see [Webview API](./webview-api.md)) — so it stays visible no matter how deeply buried, with no clip plane or cutaway needed. Unit-tested in `gmshService.test.ts` against a fake `GmshApi` (dedup across two adjacent bad tets, no dedup against a good neighbor, and the cap/priority behavior with 2002 elements). **A trivial box mesh with GMSH's own default 3D algorithm hung indefinitely during verification** (confirmed: 27+ minutes of pure CPU with no progress, on geometry simple enough to mesh in milliseconds), against `@loumalouomega/gmsh-wasm` 0.2.x — this codebase's then-forced `Mesh.Algorithm3D = 4` (Frontal) default avoided it entirely, extending that documented limitation from "OCC-imported geometry" to, apparently, this WASM build's default 3D algorithm more broadly. **Fixed upstream in 0.3.0** (root cause: a wasm32 stack-overflow in Gmsh's tetgen-derived 3D boundary recovery, not an algorithm-correctness bug — see the "Meshing (GMSH-JS)" section of `CLAUDE.md`) — re-verified against the live 0.3.0 WASM, Delaunay now completes in well under a second on comparably simple geometry, no hang. The default mesh options now set `Mesh.Algorithm3D = 1` (Delaunay, Gmsh's own default) again; Frontal remains fully selectable and correct, it's just no longer forced.

```typescript
async function exportGeoUnrolled(
  extensionPath: string,
  input: MeshGenerationInput,
  options: MeshOptions
): Promise<string>
```

Same geometry-import + options setup as `generateMesh` (via the shared private `loadGeometryAndApplyOptions`), but calls `gmsh.write("/out.geo_unrolled")` instead of meshing, and returns the resulting text — lets the FE Mesh panel's export `<select>`/**📤 Export** offer a `.geo_unrolled` target without a second `getGmsh`/import round trip. Note this is **not** the same file as the autogenerated `<model>.geo` sidecar (see `meshOptionsSidecar.ts` below) — GMSH-JS has no API to emit a clean, parametric `.geo` script from in-memory state, only this fully-expanded "unrolled" form.

```typescript
async function exportMeshFormat(
  extensionPath: string,
  input: MeshGenerationInput,
  options: MeshOptions,
  parts: Part[],
  formatId: Exclude<MeshExportFormatId, "msh" | "geoUnrolled">
): Promise<string>
```

The generic sibling of `generateMesh`/`exportGeoUnrolled` covering every other format in `src/meshExportFormats.ts`'s `MESH_EXPORT_FORMATS` registry (VTK, I-DEAS Universal, Abaqus, Nastran, SU2, INRIA Medit, STL, Diffpack, OFF, and the legacy MSH v2 writer). Unlike `.geo_unrolled`, none of these formats have a companion file to handle — `gmsh.write()` dispatches purely by the output path's extension, so this is a thin `loadGeometryAndApplyOptions` → `mesh.generate(options.dimension)` → `gmsh.write("/out.<extension>")` → read-back-as-text. CGNS and MED are recognized by Gmsh's writer-dispatch table but throw `"...compiled without CGNS support"`/`"...must be compiled with MED support..."` in this WASM build (both need HDF5-backed libs not linked in) — excluded from the registry entirely rather than offered as a format that always fails; see [GMSH Integration](./gmsh-integration.md) for the full per-format probe results against the live WASM build.

**Two input paths, both converging on the shared options step:**

- **B-rep** (`kind: "brep"`) — `stepBytes` are written to GMSH's MEMFS as `/model.step`, then `gmsh.model.occ.importShapes(tmpPath)` + `gmsh.model.occ.synchronize()` load them.
- **STL** (`kind: "stl"`) — `stlBytes` are written as `/model.stl`, then `gmsh.merge(tmpPath)` + `gmsh.model.mesh.classifySurfaces(...)` + `gmsh.model.mesh.createGeometry()` reclassify the raw triangle soup into parametric surfaces, and `gmsh.model.geo.addSurfaceLoop`/`addVolume`/ `synchronize` declare a volume so a 3D mesh can be generated from a format that otherwise has no volume topology.

`src/provider.ts`'s `resolveMeshInput` decides which input a given document produces: B-rep documents call the existing `exportBRep()` to get `stepBytes` (so live, unsaved edits are baked in the same way normal Export does); mesh documents have no B-rep to re-export, so the *webview* serializes its currently displayed model to STL and sends it up as a base64 `stl` field on the `meshingGenerate`/`meshingExport` message.

---

## `src/meshExtract.ts`

Extracts WebGL-ready geometry buffers from an OCCT shape.

### Types

```typescript
interface GeometryBuffers {
  positions: Float32Array   // XYZ vertex positions
  normals: Float32Array     // XYZ vertex normals (currently unused by the webview material)
  indices: Uint32Array      // Triangle indices (0-based)
}

interface FaceMesh {
  faceId: string            // stable per-face entity id ("face-N")
  buffers: GeometryBuffers
}

interface EdgeLine {
  edgeId: string            // stable per-edge entity id ("edge-N")
  positions: Float32Array   // consecutive xyz points; pairs form polyline segments
  smooth: boolean           // tangent patch-seam continuation, not a real feature edge
}

interface PointEntity {
  pointId: string            // stable per-vertex entity id ("point-N")
  position: [number, number, number]
}

interface SolidGroup {
  id: string
  label: string
  faceCount: number
  faces: FaceMesh[]
}
```

Duck-typed interfaces for OCCT objects (so unit tests can mock them without WASM):

```typescript
interface OcctPoint { X(): number; Y(): number; Z(): number }
interface OcctTriangle { Get(): [number, number, number] }
interface OcctPolyTriangulation {
  NbNodes(): number
  NbTriangles(): number
  Node(i: number): OcctPoint
  Triangle(i: number): OcctTriangle
}
interface OcctTrsf { /* transform methods */ }
interface OcctDiscretizer { NbPoints(): number; Value(i: number): OcctPoint }
```

### Functions

```typescript
function extractFaceGeometry(
  tri: OcctPolyTriangulation,
  trsf: OcctTrsf,
  isReversed: boolean
): GeometryBuffers
```

Extracts vertices and triangles from a single OCCT face's triangulation. Applies the face's location transform. If `isReversed` is true, swaps triangle winding order so face normals point outward. OCCT uses 1-based indexing; this function converts to 0-based for WebGL.

```typescript
function tessellateByGroup(
  oc: any,
  shape: any,
  quality?: TessellationParams   // default: TESSELLATION_PRESETS.standard (linear 0.1, angular 0.5 rad)
): SolidGroup[]
```

Tessellates the entire `TopoDS_Shape`. Uses `BRepMesh_IncrementalMesh_2(shape, quality.linearDeflection, false, quality.angularDeflectionRad, true)` — `isRelative` is always `false`, `isInParallel` is always `true` (roadmap "Configurable tessellation quality", closed — verified live against the real WASM to be both hang-free and ~2× faster on a large model, so it's unconditional, not a setting). Explores solids via `TopExp_Explorer`, then within each solid explores faces and calls `extractFaceGeometry`. Returns one `SolidGroup` per solid, each face tagged with a stable global `faceId` (deterministic explorer order).

When solids exist, it also runs a **free-face pass** (`extractFreeFaces`): every face touched while processing a solid is "claimed" into a `HashCode`-bucketed map (via `extractFacesFromShape`'s optional `claim` parameter — the claimed face handles are pushed into `tessellateByGroup`'s own long-lived `cleanup`, not the per-call one, so they outlive the comparison), then the whole shape's faces are walked once more and anything not claimed (`IsSame` check) becomes an extra `"Sketches"` group. This surfaces standalone 2D profile faces added via `addCircleProfile`/`addRectangleProfile`/`addPolygonProfile` (`src/occtOperations.ts`), which would otherwise be silently dropped — without it, a bare `TopoDS_Face` mixed into the compound never gets tessellated or a `faceId`. **`occtOperations.ts`'s `collectFaces` duplicates this exact algorithm** so `face-N` ids resolve consistently between the read/display path and the edit-resolution path; see that file's docs above for why keeping the two in lockstep matters. `triangulateFace` factors out the per-face triangulation logic shared by the solid pass, the no-solids fallback, and the free-face pass.

```typescript
function extractEdges(oc: any, shape: any): EdgeLine[]
```

Explores every `TopoDS_Edge`, de-duplicating shared edges by `HashCode` bucket + `IsSame` (this OCCT build does **not** bind `TopTools_IndexedMapOfShape`), then discretizes each unique edge to a polyline via `BRepAdaptor_Curve_2` + `GCPnts_UniformDeflection_2` (both verified against the live WASM). The first appearance in explorer order fixes the stable `edgeId`. Calls `edgeEnumeration.ts`'s `enumerateEdges()` (unchanged) then `classifyEdgeSmoothness()` (below) to compute each edge's `smooth` flag, zipping the two parallel arrays together — `edge-N` assignment stays entirely `enumerateEdges`'s business.

```typescript
function classifyEdgeSmoothness(
  oc: any,
  shape: any,
  edges: EnumeratedEdge[],   // already enumerated by enumerateEdges — same order, never reordered
  cleanup: { delete(): void }[]
): boolean[]                 // parallel to `edges`
```

`src/edgeEnumeration.ts` (roadmap "Display-edge classification, as a flag", closed). For each edge with exactly 2 adjacent faces (a free/boundary edge or a non-manifold edge shared by 3+ faces is never classified `smooth` — always a genuine feature), computes the dihedral angle between the two faces' surface normals AT the shared edge; below `1.0°` (a constant close to, but independently re-derived from, SketchForge-3D's own 0.75° — see this function's own doc comment for the real-fixture data behind the choice), the edge is a tangent patch-seam continuation, not a real feature. Face adjacency is a SEPARATE, face-driven `HashCode`+`IsSame` bucket pass (walking every face's own edges) — deliberately independent of `enumerateEdges`'s own shape-level `TopAbs_EDGE` explorer, since the two traversals are not guaranteed to visit edges in the same order; results are correlated back to `enumerateEdges`'s edges by `IsSame` identity, never by assumed ordering. **Verified live against the real WASM, not assumed:** `TopTools_IndexedDataMapOfShapeListOfShape` and `TopExp.MapShapesAndAncestors` (the "proper" OCCT adjacency tools) are both confirmed unbound in this build, hence the hand-rolled bucket map; a box's 12 edges each showed the expected 90° dihedral angle; `bull.stp` showed a real, meaningful split — 9 of 96 two-face edges under 1° (genuine patch seams), the rest ranging 30°–180° (genuine features), with a clean gap between the two clusters. The per-face-pair normal is evaluated via `BRepAdaptor_Curve2d_2(edge, face)`'s 2D pcurve → `GeomLProp_SLProps_1(surface, u, v, 1, tol)` → `.Normal()` — **not** by projecting the edge's 3D midpoint onto the face (`GeomAPI_ProjectPointOnSurf`'s own `Parameters`/`LowerDistanceParameters` UV accessors are confirmed unbound: `"null function or function signature mismatch"`).

```typescript
function polylineFromDiscretizer(disc: OcctDiscretizer): Float32Array
```

Pure helper (unit-tested) that packs a discretizer's points into a flat xyz array, deleting each `gp_Pnt` handle it reads.

```typescript
function extractVertices(oc: any, shape: any): PointEntity[]
```

Explores every `TopoDS_VERTEX` in the whole shape (`TopExp_Explorer_2(shape, TopAbs_VERTEX, TopAbs_SHAPE)`), de-duplicating by `HashCode` bucket + `IsSame` (same technique as `extractEdges`). Unlike face/edge extraction there is no claim/free distinction and no discretization filter — a vertex is always exactly one point. Runs unconditionally over the whole shape (original geometry's corners **and** any user-added standalone points), since nothing downstream ever resolves a `point-N` id back to a live vertex — point extraction is purely for display.

**Memory discipline:** Every OCCT handle created in these functions is pushed onto a local `cleanup[]` array. A `try/finally` block deletes them in reverse order regardless of success or failure. In `extractEdges`, deduped edge handles are kept alive in `cleanup` until the end so later `IsSame` comparisons stay valid.

```typescript
function tessellateShape(oc: any, shape: any): GeometryBuffers[]
```

Legacy flat tessellation (no grouping). Kept for test compatibility. Returns one `GeometryBuffers` per face.

---

## `src/partsStore.ts` and `src/partsSidecar.ts`

Persist user-defined parts in a `<model>.parts.json` sidecar beside the CAD file. The CAD file is never written — only the sidecar — so the editor stays read-only.

`src/partsSidecar.ts` is **vscode-free** (so it unit-tests under vitest):

```typescript
function parsePartsJson(text: string): Part[]          // tolerant: returns [] on bad input
function serializePartsJson(sourceName: string, parts: Part[]): string
```

`src/partsStore.ts` wraps them with VS Code filesystem access:

```typescript
function sidecarUri(modelUri: vscode.Uri): vscode.Uri  // <model>.parts.json
async function readParts(modelUri): Promise<Part[]>     // [] if missing/unreadable
async function writeParts(modelUri, parts): Promise<void>
```

`provider.ts` calls `readParts()` on open (posts a `parts` message) and, on each debounced `partsChanged` message (~500 ms), `writeParts()`.

## `src/annotationsStore.ts` and `src/annotationsSidecar.ts`

The sibling pair for persisted, topology-anchored measurements (roadmap "Persisted, topology-anchored annotations", closed) — structurally identical to `partsStore.ts`/`partsSidecar.ts` above, right down to the tolerant-parse-drops-malformed-entries convention.

```typescript
// annotationsSidecar.ts (vscode-free)
function parseAnnotationsJson(text: string): Annotation[]          // tolerant: returns [] on bad input
function serializeAnnotationsJson(sourceName: string, annotations: Annotation[]): string

// annotationsStore.ts (VS Code fs)
function annotationsSidecarUri(modelUri: vscode.Uri): vscode.Uri  // <model>.annotations.json
async function readAnnotations(modelUri): Promise<Annotation[]>    // [] if missing/unreadable
async function writeAnnotations(modelUri, annotations): Promise<void>
```

`provider.ts` calls `readAnnotations()` on open (posts an `annotations` message) and, on each debounced `annotationsChanged` message (~500 ms, its own timer), `writeAnnotations()`. Also rebound (alongside Parts) by `rebindPartsOnChange()` on any topology-changing edit — see `entityFacts.ts`'s `rebindPartsAcrossOps` above.

**Gotcha, from a real defect:** `annotationsSidecar.ts` and `annotationsModel.ts` each build an `Annotation` field by field. `AnnotationsModel`'s private `clone` once omitted `tolerance`, and since it runs on BOTH `push` and `list`, a pinned band was dropped before it could be persisted and the render path's `a.tolerance` was always `undefined` — the whole tolerance feature was inert with every test green. Any field added to `Annotation` must be copied in all of them.

---

## `src/planesStore.ts` and `src/planesSidecar.ts`

The sixth sidecar pair — named construction planes (roadmap "A named, persisted construction-plane entity", Phase 3 closed) — structurally identical to the parts/annotations pairs.

```typescript
// planesSidecar.ts (vscode-free)
function parsePlanesJson(text: string): ConstructionPlane[]        // tolerant: returns [] on bad input
function serializePlanesJson(sourceName: string, planes: ConstructionPlane[]): string
function nextPlaneId(planes: readonly ConstructionPlane[]): string // highest N + 1; never reuses

// planesStore.ts (VS Code fs)
function planesSidecarUri(modelUri: vscode.Uri): vscode.Uri        // <model>.planes.json
async function readPlanes(modelUri): Promise<ConstructionPlane[]>   // [] if missing/unreadable
async function writePlanes(modelUri, planes): Promise<void>         // assertNotDirty first
```

**A plane stores resolved vectors, not entity ids, so it is the one geometry-referencing sidecar that takes no part in entity rebinding** — `rebindPartsOnChange()` does not touch it, by design. Two tolerance rules worth knowing: `normal` is normalized on read (a hand-edited `[0, 0, 10]` is usable), and a zero-length normal drops that plane, since it describes no plane at all and would divide by zero downstream.

The webview counterpart is `src/webview/planesModel.ts` (`PlanesModel`), mirroring `PartsModel`/`AnnotationsModel`'s silent-`load()` / firing-mutation contract. It re-implements the never-reuse id rule rather than importing `nextPlaneId`, to stay free of the sidecar's parse/serialize surface; both copies are separately tested.

---

## `src/meshOptions.ts`, `src/meshOptionsStore.ts`, `src/meshOptionsSidecar.ts`

The FE-mesh options model and its sidecar pair, mirroring the parts/edits trios (see [GMSH Integration](./gmsh-integration.md) for the feature-level write-up).

`src/meshOptions.ts` is **vscode-free** and holds the flat `MeshOptions` bag plus:

```typescript
const DEFAULT_MESH_OPTIONS: MeshOptions
function validateMeshOptions(raw: unknown): MeshOptions | null   // single tolerance gate
function applyStlPartSizeOverride(options: MeshOptions, parts: Part[]): MeshOptions
function scaleMeshOptionsForUnit(options: MeshOptions, factor: number): MeshOptions
function scalePartsMeshSizeForUnit(parts: Part[], factor: number): Part[]
```

Unlike `EditOp`'s validator, `validateMeshOptions` clamps/defaults **individual** invalid fields to the matching `DEFAULT_MESH_OPTIONS` field rather than rejecting the whole object — `raw` is only rejected outright (returns `null`) when it isn't an object at all. `sizeMin`/`sizeMax` are validated as a pair: if `sizeMin > sizeMax` after individually clamping each, both fall back to the defaults together rather than leaving an inconsistent pair.

`applyStlPartSizeOverride` is STL/mesh sources' one-off sizing degrade (they can't get true per-entity physical groups): when *exactly one* part has `meshSize` set, it overrides `sizeMin`/`sizeMax` to that value for the one generate/export call only (never persisted). `scaleMeshOptionsForUnit`/ `scalePartsMeshSizeForUnit` (added for the FE Mesh panel's Gmsh-export unit conversion) rescale `sizeMin`/`sizeMax`/`meshSize` by a `unitScaleFactor()` result, for the same never-persisted, this-call-only reason — both are identity (same-reference) no-ops at `factor === 1`, and `scaleMeshOptionsForUnit` leaves `SIZE_MAX_SENTINEL` untouched (a flag, not a real mm value). See `provider.ts`'s `resolveMeshPartsAndOptions` above for how the three compose on one call.

`src/meshOptionsSidecar.ts` is **vscode-free** (unit-tested):

```typescript
function parseMeshJson(text: string): MeshOptions          // tolerant: DEFAULT_MESH_OPTIONS on any failure
function serializeMeshJson(sourceName: string, options: MeshOptions): string
function generateGeoScript(sourceName: string, options: MeshOptions): string
```

`generateGeoScript` templates a `.geo` Gmsh script directly from the `MeshOptions` JSON (`Merge "<source>"` + one `Mesh.*` assignment per field + a trailing `Mesh <dimension>;`) — this exists because GMSH-JS itself has no API to emit a clean, parametric `.geo` file from in-memory model state (only the fully-expanded `.geo_unrolled` form via `gmsh.write()`, see `gmshService.ts` above). The generated file's own header comment states it is auto-generated; **hand-edits to `<model>.geo` are never read back by the extension** — it is regenerated wholesale from the sidecar on every options change.

`src/meshOptionsStore.ts` wraps them with VS Code filesystem access:

```typescript
function meshOptionsSidecarUri(modelUri: vscode.Uri): vscode.Uri  // <model>.mesh.json
async function readMeshOptions(modelUri): Promise<MeshOptions>     // DEFAULT_MESH_OPTIONS if missing/unreadable
async function writeMeshOptions(modelUri, options): Promise<void>
function geoScriptUri(modelUri: vscode.Uri): vscode.Uri            // <model>.geo
async function writeGeoScript(modelUri, options): Promise<void>
```

`provider.ts` calls `readMeshOptions()` on `ready` (posts a `meshingOptions` message) and, on each debounced `meshingChanged` message (~500 ms, its own timer separate from parts/edits), calls **both** `writeMeshOptions()` and `writeGeoScript()` — the sidecar and the generated script are always kept in sync with each other. Neither the CAD file nor any other sidecar is touched.

---

## `src/viewStateStore.ts`, `src/viewStateSidecar.ts`

A fourth parts/edits/mesh-options-style sidecar pair for the persisted camera/display/clip state (roadmap "View-state persistence", closed — see the [View State Sidecar](./file-formats.md#view-state-sidecar-modelviewjson) format reference and CLAUDE.md's writeup for the full mechanism).

`src/viewStateSidecar.ts` is **vscode-free** (unit-tested):

```typescript
function parseViewStateJson(text: string): ViewState | null   // null = no sidecar / malformed / no persisted view
function serializeViewStateJson(sourceName: string, view: ViewState): string
```

Tolerant like the other three sidecars, with one stricter rule: `viewDirection`/`cameraUp` reject the WHOLE record (not just that field) when missing or degenerate (all-zero) — a camera can't be oriented by either, unlike every other field, which individually falls back to a safe default (an unrecognized `displayMode` → `"shaded"`, a malformed `clip` → `null`).

`src/viewStateStore.ts` wraps it with VS Code filesystem access, mirroring `partsStore.ts` exactly:

```typescript
function viewStateSidecarUri(modelUri: vscode.Uri): vscode.Uri     // <model>.view.json
async function readViewState(modelUri): Promise<ViewState | null>  // null if missing/unreadable/malformed
async function writeViewState(modelUri, view): Promise<void>
```

`provider.ts` calls `readViewState()` on `ready` (posts a `viewState` message, right after `meshingOptions`) and, on each debounced `viewChanged` message (~500 ms, its own timer separate from parts/edits/mesh), calls `writeViewState()`. It also participates in the same `watchForExternalChange` mechanism the other sidecars use, so an external write to `<model>.view.json` (another tab on the same document, a hand edit) is reconciled live — see `provider.ts`'s `watchForExternalChange` and CLAUDE.md's "Sidecar and source external-change reconciliation" writeup. `<model>.annotations.json` (roadmap "Persisted, topology-anchored annotations", closed) gets a sibling watcher, right after the parts one — same content-comparison-then-post pattern (`readAnnotations()`, compare via `JSON.stringify`, reassign `currentAnnotations`, post `"annotations"` + a `"status"` line) — bringing the total to six watchers: the CAD source file itself (unconditional reload, no comparison) plus five sidecars (edits, parts, annotations, mesh options, view state).

---

## `src/protocol.ts`

Defines the host ↔ webview message contract. See [Host ↔ Webview Protocol](./protocol.md) for the full reference.

### Buffer Encoding

```typescript
function encodeBuffer(arr: Float32Array | Uint32Array): string
```

Encodes a typed array as a base64 string for safe `postMessage` transport. Uses `Buffer.from(arr.buffer).toString('base64')` (Node.js `Buffer` — host-side only).

The corresponding decode helpers (`decodeF32`, `decodeU32`) live in `src/webview/geometryBuilder.ts` and use browser `atob`.

---

## `src/mcpServer.ts`, `src/mcpTools.ts`, `src/mcpSidecars.ts`

The standalone MCP server — a third esbuild bundle (`dist/mcp-server.js`) that exposes the same headless pipeline (`loadBRep`/`exportBRep`/`generateMesh`/ `exportMeshFormat`/`exportMdpa`/`exportGeoUnrolled`/`computeMassProperties`) to AI agents over stdio JSON-RPC, with no VS Code involved.

- **`mcpServer.ts`** is the entry: it rebinds `console.log/info/warn/debug` to stderr *before anything else* (the Emscripten WASM modules print through `console.log`, and stdout is the JSON-RPC channel), resolves `extensionPath` (`CAD_PREVIEW_ROOT` env var or the bundle dir's parent), and registers the fourteen tools with the `@modelcontextprotocol/sdk` `McpServer` + `StdioServerTransport`.
- **`mcpTools.ts`** holds the tool handlers as plain async functions over an injected `Pipeline` object (defaulting to the real OCCT/Gmsh functions in the server, faked in `mcpTools.test.ts` — the `.wasm` imports only resolve under esbuild's plugin, never vitest). Ops arrive as raw JSON gated by `validateEditOp`; results are stats/summaries, never geometry buffers.
- **`mcpSidecars.ts`** is the node-fs counterpart of `editsStore.ts`/ `partsStore.ts`/`annotationsStore.ts`/`meshOptionsStore.ts` over the same pure `*Sidecar.ts` parsers — byte-compatible with what `provider.ts` reads on reopen — plus the `assertNotSourcePath` guard enforcing the CAD-file-is-never-written invariant. `readAnnotations`/`writeAnnotations` are plain sidecar I/O (not part of the `Pipeline` interface — that interface holds only WASM/OCCT/Gmsh/network-touching functions vitest must fake; `rebindPartsAcrossOps` IS in `Pipeline` since it re-derives ids from live geometry).

See [MCP Server](./mcp-server.md) for registration, the tool reference, and the headless capability matrix.
