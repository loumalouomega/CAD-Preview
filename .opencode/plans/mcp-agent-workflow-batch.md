# Plan: MCP agent-workflow batch — roadmap items 15, 16, 17, 20, 21

Approved by user ("Yes, execute the plan"). All five items are Tier 3 MCP ergonomics; none touch
the webview or `provider.ts`, so everything is verifiable in this environment via unit tests +
`npm run mcp:smoke` + `npm run perf`.

## Research findings already confirmed

- `ExactMeasureResult` already returns min-distance realizing points (`fromPoint`/`toPoint`,
  entityFacts.ts:379-388). Item 21's genuinely new piece is **max distance**.
  `BRepExtrema_ShapeShape` is NOT green; **`BRepExtrema_DistanceSS` IS green** (Supported APIs.md
  line 850) — probe its call shape live before trusting it (expect LoadS1/LoadS2/Perform/Value/
  PointOnShape1/2 mirror of DistShapeShape, verified not assumed).
- `bboxExtent` is module-private at occtOperations.ts:1869 → export it (precedent:
  combineSolids/facePlane/bboxCenter promotions).
- Items 15/20 need NO new `Pipeline` keys. Items 16/17 add 2 keys via the 4-touch-point pattern:
  implement in host module → `Pipeline` interface (mcpTools.ts) → typed dispatch entry
  (kernelWorker.ts handlers) → callKernel object-literal entry (kernelClient.ts).
- Smoke script asserts `tools.length === 26` (run.mjs:221) → becomes **30**.
- Sidecar set for item 15: `.edits.json`, `.parts.json`, `.annotations.json`, `.mesh.json`,
  `.view.json` (`<model>.view.json`, viewStateStore.ts), `.geo`.
- Test conventions: real temp dirs in `mcpTools.test.ts` (`beforeEach` mkdtemp), fake pipeline
  factory at line 293.

## Implementation order & details

### 1. Item 15 — `list_workspace_models` (no pipeline change)
- `mcpSidecars.ts`: add `viewStateSidecarPath(modelPath)` returning `` `${modelPath}.view.json` ``.
- New handler `listWorkspaceModels(params: {root})` in `mcpTools.ts` (fs/routeFile only, like
  `getState`; takes no ctx.pipeline).
- Caps: `LIST_WALK_MAX_DEPTH = 6`, `LIST_WALK_MAX_FILES = 2000` (cap on scanned files); skip
  `.git`/`node_modules`; every cap hit or unreadable dir reported via `warnings` + `truncated`
  flag — never silent.
- Response: `{root, scannedFiles, modelCount, truncated, models: [{path (absolute), format,
  strategy, sidecars: {edits, parts, annotations, meshOptions, viewState, geoScript}}], warnings}`
  sorted by path; sidecar existence via `fs.stat` on mcpSidecars path derivations.
- Unit tests: temp-dir tree — recognized/unrecognized extensions, nested depth, sidecar flags,
  skip-dirs, file-count cap trip, nonexistent root throws.

### 2. Item 16 — `check_interference_all`
- Export `bboxExtent` from `occtOperations.ts`.
- New `checkInterferenceAll(extensionPath, bytes, format, ops, groups: string[][]):
  Promise<{pairs: Array<{a: string[], b: string[], hasOverlap, overlapVolume, unresolvedA,
  unresolvedB, screenedByBbox?}>, warnings}>` in `entityFacts.ts`:
  - ONE parse/replay (not C(n,2) re-parses — deliberate improvement over the roadmap's literal
    "loop the unmodified checkInterference" wording; same kernel surface: combineSolids +
    `BRepAlgoAPI_Common_3` + adaptive volumeOf + `>1e-9` touching-only gate, all unchanged);
  - resolve all ids once via collectSolids/byId map; per-group AABB = union of member
    `bboxExtent`s; AABB interval-reject each pair before any boolean (HCAD/SindriCAD-converged
    pre-filter); rejected pairs get `hasOverlap:false, overlapVolume:0, screenedByBbox:true`
    (fact, not verdict).
- Tool `checkInterferenceAllTool(ctx, {path, parts?: string[]})`: B-rep-only gate; Part names →
  `volumes` arrays resolved HERE (tool layer owns Part resolution per checkInterferenceTool's
  convention); omitted `parts` = every Part in the sidecar; unknown name / empty volumes →
  warnings, group skipped; <2 usable groups → rows:[] + warning. No caller-visible cap yet
  (roadmap defers it); O(n²) worst case stated in tool description.
- Pipeline key name: `checkInterferenceAll` (all 4 touch points).
- Unit tests (fake pipeline): pair enumeration C(n,2), part-name resolution, unknown/empty-part
  warnings. Smoke: extend existing 4-box fixture — all-parts run finds exactly the one ~700
  overlap pair; disjoint/touching pairs screened or false.

### 3. Item 17 — `generate_bom`
- `massProperties.ts`: new `computeBom(extensionPath, bytes, format, ops, parts: Part[]):
  Promise<BomRow[]>` — one parse/replay; per part sums member solids' volume + area
  (**sum-of-parts** semantics, documented vs combined-volume difference); counts unresolved ids
  per row. `BomRow = {name, color, volumeCount/surfaceCount/lineCount/pointCount, volume, area,
  unresolvedVolumeIds}`.
- Pure `bomTsv(rows): string` beside it (WASM-free, unit-tested) — tab-separated, header row
  (`Name\tSolids\tFaces\tEdges\tPoints\tVolume\tArea\tUnresolved`), matching HCAD's "Copy BOM"
  tab-separated convention cited by the roadmap.
- Tool `generateBomTool(ctx, {path})`: reads parts sidecar; empty → `{rows: [], bom: "", warnings:
  ["no parts defined…"]}` (facts not errors); passes `Part[]` straight through pipeline.
- Pipeline key: `computeBom` (4 touch points).
- Unit tests: bomTsv formatting (escaping not needed—TSV of numbers/names; still assert header +
  column alignment); fake-pipeline row mapping; smoke reuses the fixture's existing set_part
  assignments, asserting per-part volumes match analytically-known box volumes and TSV round-trips.

### 4. Item 20 — `render_ops_prefix` (read-only bisection)
- Tool-only orchestration in `mcpTools.ts` over EXISTING keys (`loadBRep`, `isRenderAvailable`,
  `renderSnapshot`). Params `{path, throughIndex: number, render?: boolean}`.
- Read edits sidecar; validate `throughIndex ∈ [-1, ops.length-1]` (−1 = base shape, no ops);
  prefix = `ops.slice(0, throughIndex+1)`; NEVER writes any sidecar.
- Response: `{format, strategy, throughIndex, totalOpCount, persisted: false, model:
  entitySummary(result), images?, warnings}` where warnings include `opOutcomeWarnings(prefix
  replay)`; `render: true` probes availability once → renderSnapshot(bytes, format, prefix) →
  images (Chromium-absent degrades to warning; wrap()'s images mechanism carries them).
- Unit tests: index validation errors; read-only guarantee (sidecar bytes unchanged after call);
  images pass-through with fake pipeline.
- Smoke: after the existing 3-op sequence, call at each prefix length asserting solid counts;
  read back `.edits.json` before/after and assert byte-identical; render branch tolerated absent
  like render_snapshot coverage.

### 5. Item 21 — richer `measure_exact` (probe FIRST)
- Probe step: throwaway script vs live WASM pinning `BRepExtrema_DistanceSS`'s constructor
  overloads/call shape on known geometry (box: max = space diagonal between opposite corners).
  Probe failure → drop max-fields, ship rest, record finding in CLAUDE.md.
- Additive optional `ExactMeasureResult` fields: `maxValue/maxFromPoint/maxToPoint`;
  `centreDistance` (bbox centres); for two planar faces `parallelDistance` (|Δpt·n̂| when normals
  parallel within tol) + `angleDeg` (face-normal angle); `primary: "min"|"max"|"parallel"`
  naming the headline value — facts only, never a verdict. `axisDistance` DEFERRED to item 25
  Phase 1 (cylinder accessors unprobed). OP_PARAM_DOCS untouched (no new op kind).
- measure_exact tool description updated; interactive webview unaffected (additive optional
  fields).
- Smoke extends cylinder-radius checks: box-fixture max-distance assertions incl. realizing
  points at predicted corners; parallel-face parallelDistance exact; perpendicular angleDeg=90;
  primary present.

### 6. Registration
`mcpServer.ts`: register `list_workspace_models`, `check_interference_all`, `generate_bom`,
`render_ops_prefix` (zod schemas mirroring existing style; descriptions lead with facts-only
framing). Update `measure_exact` description. Update smoke `tools.length` 26→30.

### 7. Verification ladder
`npx vitest run` → `npm run build` → `npm run mcp:smoke` → `npm run perf` (sanity vs baseline).

### 8. Docs & bookkeeping (CLAUDE.md sync rules)
- `doc/mcp-server.md`: 4 new tool-table rows; `measure_exact` row update; Testing section scenario
  text; capability-matrix note if needed (all four tools are read-only/orthogonal or B-rep-gated
  as documented inline).
- `describeCapabilities()`: headlessLimitations entries (interference_all O(n²)/B-rep-only;
  render_ops_prefix non-persisting; list_workspace_models stateless discovery).
- `doc/roadmap.md`: remove items 13..23 members that closed (15,16,17,20,21); renumber remaining
  Tier 3 items consecutively AND all later tiers shift down by 5 (24→19 … 35→30); fix EVERY
  cross-reference (items citing "item 20", "item 25", "item 27", "item 28", "item 31(c)/33",
  "item 32", "item 34/35", "items 5/7" etc.).
- `CLAUDE.md`: new section(s) documenting the five closed items with verified implementation
  details (per convention), including the DistanceSS probe result and the parse-once interference
  loop decision.
- No CHANGELOG entry (version bump is a separate release step).
