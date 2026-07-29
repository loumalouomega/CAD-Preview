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
bridge, units handling, model comparison, and the MCP server's agent-feedback
tools — `render_snapshot`, `inspect`/`measure`, progress notifications on
long mesh operations, and fact-only/verdict-conventions tool descriptions)
has shipped — see `CLAUDE.md`'s per-feature sections for the verified
implementation details and CHANGELOG.md for release notes.

Several items below are adapted from ideas found in
[earthtojake/text-to-cad](https://github.com/earthtojake/text-to-cad)
(MIT-licensed), a CAD skills library whose browser viewer has a handful of
display features worth adopting, and whose standard-parts sourcing design
maps well onto this extension's MCP server. Its headless visual-feedback and
deterministic inspect/measure conventions were already adopted (see above).
Notably, its viewer *lacks* measurement tools and model diffing — two
features CAD-Preview already ships — so those remain differentiators to
maintain, not gaps to close.

## P1 — Mid-term: viewer depth

### 1. Display modes — M

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

### 2. Markup/annotation overlay + composite screenshots — M

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

### 3. Hex-dominant FE meshing — M

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

## P2 — Exploratory: bigger bets

### 4. Standard-parts sourcing — step.parts integration — M

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

### 5. Parametric script-as-source MCP tool — L

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
