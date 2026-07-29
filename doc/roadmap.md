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

Everything previously listed here has shipped — mass properties, measurement
tools, screenshot, settings, clipping planes, FE mesh quality stats, per-part
isolate/hide + tree search, appearance controls incl. an orthographic camera,
drag-and-drop open, a live exploded-view slider, the meshio++ import/export
bridge, units handling, model comparison, the MCP server's agent-feedback
tools (`render_snapshot`, `inspect`/`measure`, progress notifications on long
mesh operations, fact-only/verdict-conventions tool descriptions), the
Display Mode selector (Shaded/Wireframe/X-Ray/Hidden Lines/Flat), the Markup
annotation overlay with composite screenshots, Hex-Dominant FE meshing
(`elementShape: "hexDominant"`), step.parts standard-parts sourcing
(`search_standard_parts`/`download_standard_part`, MCP-tool-only, no
Parts-panel UI surface), and the parametric script-as-source MCP tool
(`run_parametric_script` — scoped as a script→ops **compiler that appends to
the existing edit-op stack**, not a separate document-base-geometry source;
see `CLAUDE.md` for why that scoping resolved the original open design
questions cleanly). See `CLAUDE.md`'s per-feature sections for the verified
implementation details and CHANGELOG.md for release notes.

Ideas from [earthtojake/text-to-cad](https://github.com/earthtojake/text-to-cad)
(MIT-licensed) shaped several of the shipped items above: headless
visual-feedback packets, deterministic inspect/measure conventions,
standard-parts sourcing, and the parametric-script rationale. Its viewer
notably *lacks* measurement tools and model diffing — two features
CAD-Preview already ships — so those remain differentiators to maintain.

No concrete items are queued right now — this page is aspirational and
gets repopulated as new ideas surface; see git history for prior tiers.

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
