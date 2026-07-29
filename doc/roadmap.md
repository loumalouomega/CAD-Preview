# Roadmap

Candidate features for future CAD-Preview releases, prioritized by value versus
effort given what the extension already ships: an OCCT kernel, a Gmsh kernel,
and a meshio++ kernel live in the extension host, a full picking/selection
pipeline in the webview, a sidecar persistence model, and an MCP server
mirroring the pipeline headless. Many high-value features are cheap precisely
because that infrastructure exists.

This page is aspirational, not a commitment — items may be re-ordered, re-scoped,
or dropped. Effort is a rough order of magnitude: **S** (a day or two), **M**
(roughly a week), **L** (multi-week).

Everything previously listed here (mass properties, measurement tools,
screenshot, settings, clipping planes, FE mesh quality stats, per-part
isolate/hide + tree search, appearance controls incl. an orthographic camera,
drag-and-drop open, a live exploded-view slider, the meshio++ import/export
bridge, units handling, and model comparison) has shipped — see `CLAUDE.md`'s
per-feature sections for the verified implementation details and CHANGELOG.md
for release notes.

Several items below are adapted from ideas found in
[earthtojake/text-to-cad](https://github.com/earthtojake/text-to-cad)
(MIT-licensed), a CAD skills library whose agent-facing design — headless
visual feedback packets, deterministic inspect/measure verbs over stable
topology refs, standard-parts sourcing — maps well onto this extension's MCP
server, and whose browser viewer has a handful of display features worth
adopting. Notably, its viewer *lacks* measurement tools and model diffing —
two features CAD-Preview already ships — so those remain differentiators to
maintain, not gaps to close.

## P1 — Near-term: agent feedback for the MCP server

The MCP server exposes the full load/edit/mesh/export pipeline, but an agent
using it today is flying blind: there is no way to *see* the model it is
editing, and no measurement verbs to numerically verify an edit landed where
intended. Closing that feedback loop is the highest-value MCP work available.

### 1. `render_snapshot` MCP tool — headless visual feedback — M

A tool returning a multi-view PNG render packet of the current model (with
sidecar edits replayed, exactly as `load_model` sees it) so an agent can
visually check its work after every edit.

- **Packet recipe** (adopted from text-to-cad's snapshot-review policy, which
  is battle-tested for agent consumption): two *opposed* isometric views —
  so every face appears in at least one image by construction, not by
  suspicion — plus top and front orthographic views, with the camera name
  burned into each image so an agent can never confuse views. Optional
  per-call `focus`/`hide` lists taking the existing `solid-N` entity ids,
  and an optional display mode per view (shaded/wireframe) for
  interference-suspicion checks.
- **How:** generalize the existing `scripts/screenshots/` Playwright
  headless-Chromium harness — it already loads the *shipped*
  `media/viewer.js` against `viewerDom.ts`'s real DOM and captures PNGs of
  the real renderer — into a reusable host-side render service the MCP
  server can drive. Images return as MCP image content blocks.
- **Notes:** Playwright/Chromium is currently a devDependency; the tool must
  degrade gracefully when it's absent (a clear "renderer unavailable —
  install playwright" error, never a crash), or a decision is needed on
  bundling a lighter headless path. Ship the accompanying usage policy in
  the tool description itself: *visual review is diagnostic, not
  authoritative — convert every visual concern into a deterministic
  `measure` check (item 2) before treating anything as validated, and do
  not loop on snapshots; re-render only after a change to visible geometry.*

### 2. `inspect` / `measure` MCP tools — deterministic geometry checks — S–M

The numeric half of the feedback loop: let an agent verify dimensions,
clearances, and placements against the same stable entity ids
(`solid-N`/`face-N`/`edge-N`/`point-N`) it already uses as edit-op operands.

- **`measure`**: distance between two entity ids (center-to-center, or the
  component along a given axis) — covers "is the hole 25 mm from the edge"
  class questions after an edit.
- **Entity facts**: per-entity bbox, center, area/length, and (for planar
  faces) the normal — extending the inventory `load_model` already returns.
  Everything needed already exists and is live-WASM-verified:
  `collectSolids`/`collectFaces`/`collectEdges` + `bboxCenter`/
  `bboxDiagonal` (`src/occtOperations.ts`), the `BRepGProp` call shapes
  (`src/massProperties.ts`), and `facePlane` (already used by `mate`).
- Results are **facts only** — no pass/fail judgments baked into the tool
  (see item 3's conventions). All values in the cascade unit (mm), matching
  `get_mass_properties`'s documented convention.

### 3. MCP long-operation progress + verdict conventions — S

- Wire MCP progress notifications into `generate_mesh`/`export_mesh` — a
  long Gmsh run is currently one silent block; the protocol has native
  progress support the server doesn't use. (Gmsh's own `generate()` exposes
  no mid-call progress hook, so granularity is per-phase — geometry loaded /
  meshing / writing — not a percentage; that is still far better than
  silence for a multi-minute fine mesh.)
- Adopt fact-only/three-valued verdict conventions across tool descriptions
  (adapted from text-to-cad's validation discipline): tools report
  measurements and structured warnings; the *agent* renders verdicts as
  pass / fail / **need-more-info**, where missing evidence or a tool
  limitation must map to need-more-info, never silently to pass or fail —
  and a tool/network failure is never a negative result. Mostly a
  documentation/description change (`describe_capabilities` notes +
  `doc/mcp-server.md`), plus an audit that existing tools' `warnings`
  arrays actually distinguish "couldn't check" from "checked and absent."

## P2 — Mid-term: viewer depth

### 4. Display modes — M

Extend the current Wireframe/Edges toggles into a proper display-mode
selector (adapted from text-to-cad's 7-mode enum, curated to the modes that
earn their keep here):

- **Shaded** (current default), **Wireframe** (current toggle).
- **X-Ray** — transparent shaded faces + full-strength edges; the go-to mode
  for spotting internal cavities and hidden interference.
- **Hidden-lines-visible** — edges of occluded geometry rendered through
  solids (dashed or dimmed).
- **Flat/unlit** — `MeshBasicMaterial`-style constant color, no shading
  (the FE-mesh overlay already renders this way for good reason).

Builds on the existing one-material-per-face architecture and **must**
compose through the `material.userData.baseOpacity` convention (see
CLAUDE.md's P2 section) rather than writing `opacity` directly — X-Ray is
exactly the kind of second-writer that convention exists for. Session-only,
never persisted, like every other appearance control.

### 5. Markup/annotation overlay + composite screenshots — M

A 2D drawing overlay on top of the 3D view — freehand, line, arrow,
rectangle, circle, eraser, with undo/redo — for review annotations
("this boss", "gap here"), composited into the existing Screenshot feature
(WebGL canvas + overlay canvas merged into one PNG, as text-to-cad's
`screenshotCapture.js` does; CAD-Preview's `captureScreenshotBase64()` is
the natural seam).

- Strokes are screen-space, session-only, never persisted — same rule as
  every display-only feature; clearing/model reload discards them.
- Canvas creation must follow the `dotTexture()` lazy-build-on-first-call
  discipline (no module-scope `document.createElement("canvas")`) — this
  exact mistake has broken headless tests twice before (see CLAUDE.md).

### 6. Hex-dominant FE meshing — M

`@loumalouomega/gmsh-wasm` 0.3.0 fixed the wasm32 stack-overflow bug that used
to make the default 3D Delaunay algorithm hang/produce an empty mesh on
re-imported CAD geometry (root cause: Gmsh's tetgen-derived boundary recovery
recurses past Emscripten's 64 KiB default stack; fixed upstream by raising
`-sSTACK_SIZE`/`-sDEFAULT_PTHREAD_STACK_SIZE`). As a verified side effect, the
RTree hex-tet hybrid recombiner (`Mesh.Algorithm3D = 9` +
`Mesh.Recombine3DAll = 1`) now also produces valid meshes — previously
non-functional in this build (see `CLAUDE.md`'s "Meshing (GMSH-JS)" section
for the verification trail). This was a hard non-goal before; it's now
technically feasible, but not yet implemented.

- **Why:** a genuine gap versus other meshers — CAD-Preview currently offers
  only all-simplex (`Mesh.Algorithm3D` default) or all-subdivided (all-quad/
  all-hex via `SubdivisionAlgorithm`) element shapes, never a hex-dominant
  mix, which many FE workflows prefer for better element quality at lower
  count.
- **What it needs:** GMSH-JS's own docs mark the RTree path "experimental"
  (upstream Gmsh's own framing) and note the hybrid output mixes tet (type 4)
  and hex (type 5) elements stitched by **type-140 "trihedron" connector
  elements** at the tet/hex interface — a genuinely new element kind
  `gmshElementTypes.ts`'s table doesn't cover yet (only tet/hex/prism/pyramid
  today). Adding this cleanly needs: a new `"hexDominant"` `elementShape`
  value (`meshOptions.ts`'s `validateMeshOptions` currently rejects it),
  `gmshShapeOptions` wiring `Algorithm3D=9`+`Recombine3DAll=1`, a trihedron
  entry in `gmshElementTypes.ts` (stride/boundary-face decomposition/Kratos
  mapping — MDPA export has no Kratos geometry for a tet/hex transition
  element today, so that mapping needs real design work, not just a table
  row), and a UI option alongside the existing Triangles/Tetrahedra and
  Quads/Hexahedra choices.
- **Notes:** confirmed live against 0.3.0 on `examples/STP/block.stp` — a
  hex-dominant generate produced element types `[4, 5, 140]` (702 tets, 165
  hexes, 366 trihedron connectors), so the feature genuinely works end to
  end. But `gmsh.model.mesh.getElementProperties(140)` — the coordinate-
  matching method every other element kind's node permutation in
  `gmshElementTypes.ts` was derived from — **throws** (`"Size of basis
  incompatible with element type"`), so that verification method doesn't
  extend to the trihedron connector. Its node ordering/geometry would need a
  different source (Gmsh's own C++ element-type headers, or a from-scratch
  geometric derivation) before it could be added to the shared table with
  the same confidence every other row has.

## P3 — Exploratory: bigger bets

### 7. Standard-parts sourcing — step.parts integration — M

A `search_standard_parts` MCP tool (and optionally a Parts-panel-adjacent UI
surface) over the hosted [step.parts](https://www.step.parts) REST API
(`api.step.parts`) for off-the-shelf STEP parts — screws, bearings, motors,
connectors, extrusions.

- **API shape** (documented, with an OpenAPI spec at `/v1/openapi.json`):
  faceted search (`q` fuzzy tokens + category/family/standard/tag facets),
  per-part detail records with family-specific attributes (thread, length,
  bore, material), and a `stepUrl` + `sha256` for verified download.
- **Adopt its error semantics verbatim**: a network/DNS failure is
  *inconclusive* — never report a part as unavailable unless the API was
  reachable and returned no relevant candidates. Record provenance (part id
  + source URLs + checksum) with every download.
- **Constraint:** this would be the extension's first external network
  dependency — it must be strictly opt-in, degrade gracefully offline, and
  never block any existing feature. Downloaded parts land as ordinary STEP
  files the existing pipeline opens; no new rendering work.

### 8. Parametric script-as-source MCP tool — L

Exploratory: a tool that executes an agent-authored parametric script and
imports the result as the document's base geometry, complementing — not
replacing — the discrete edit-op stack.

- **Rationale** (text-to-cad's central architectural bet, which its agents
  use to good effect): for from-scratch parts, a durable, diffable,
  re-runnable source artifact beats replaying dozens of tool calls —
  "change wall thickness to 3 mm" becomes a text edit + regeneration,
  failures localize to one named feature, and loops/patterns (a bolt circle
  of N holes) cost one script instead of N calls. Discrete edit-ops remain
  strictly better for *imported* STEP/IGES with no generator — which is
  exactly the case CAD-Preview handles best today — so this is a hybrid,
  not a migration.
- **Open questions** (why this is P3): which language/engine — the edit-op
  JSON list is *already* a replayable parametric program with variables
  (`paramExpr.ts`), so a richer expression/loop layer over it may serve
  better than embedding a full CAD-as-code engine like build123d (which
  would drag in a Python runtime); sandboxing/execution limits for
  agent-authored code; and how a script and interactive edit-ops compose in
  one document without breaking the sidecar replay model.

## Non-goals / known constraints

- **Writing the CAD source file** — never. The read-only invariant (sidecar
  persistence, export-only baking) is architectural, not a missing feature.
- **OCCT in the webview** — the kernel stays in the extension host; the webview
  runs only Three.js (architecture invariant).
- **G-code preview** — considered (text-to-cad ships a strong implementation:
  layer scrubbing, feature-type coloring, adaptive decimation) and rejected:
  3D-printing-oriented, outside this extension's CAD/FEM domain.
- **URDF/SDF robotics rendering** — considered (joint articulation, FK,
  MoveIt2 integration in text-to-cad) and rejected for the same reason.
