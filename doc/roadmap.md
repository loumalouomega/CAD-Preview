# Roadmap

Candidate features for future CAD-Preview releases, prioritized by value versus effort given what the extension already ships: an OCCT kernel, a Gmsh kernel, and a meshio++ kernel live in the extension host, a full picking/selection pipeline in the webview, a sidecar persistence model, and an MCP server mirroring the pipeline headless. Many high-value features are cheap precisely because that infrastructure exists.

This page is aspirational, not a commitment — items may be re-ordered, re-scoped, or dropped. Effort is a rough order of magnitude: **S** (a day or two), **M** (roughly a week), **L** (multi-week).

Everything previously shipped is tracked in `CHANGELOG.md`, and `CLAUDE.md` has a per-feature section with the verified implementation details for anything currently in the codebase — this page is for what's **not** built yet, only.

## Queued

Every item below either closes a **known, documented limitation** of something that already ships, or is a natural next step identified while building the features above — none is a bug, and the reasoning for each is recorded in `CLAUDE.md` (existing items) or below (new ones).

The remaining item is deliberately **not** actionable right now (evaluated and scoped out on purpose) — everything else queued as of the previous pass has shipped, including the STEP/IGES unit-conversion item this list used to carry (closed — see CLAUDE.md's Export section for the STEP text-patch mechanism and the IGES writer-constructor fix). New candidates get added here as they're identified.

### Tier 1 — extending shipped features

1. **glTF support for `compare_models`** (**M–L**, evaluated and deliberately scoped out, not merely postponed). STL/OBJ/PLY are all now supported via dedicated host-side parsers (`stlParser.ts`/`objParser.ts`/ `plyParser.ts`, all backed by `meshComponents.ts`) — OBJ (plain, already- indexed text) and PLY (a well-specified ASCII/binary format, linearly decodable via one shared header parser) both turned out tractable to hand-roll correctly and validate thoroughly with real fixtures. glTF is a different order of complexity: accessor decoding across 5 component types with an optional `normalized` flag, sparse-accessor overlays, interleaved `bufferView` byte-stride handling, and full scene-graph TRS/matrix composition down to each mesh primitive — with no realistic way to validate a hand-rolled implementation against real-world exporter variety the way the other two formats' fixtures could be validated. Shipping a plausible-looking-but-subtly-wrong parser would risk exactly the "misleading false match" failure mode Compare Models' own design was built to avoid — see CLAUDE.md's "Model comparison" section for the full reasoning.

## Non-goals / known constraints

- **Writing the CAD source file** — never. The read-only invariant (sidecar persistence, export-only baking) is architectural, not a missing feature.
- **OCCT in the webview** — the kernel stays in the extension host; the webview runs only Three.js (architecture invariant).
- **G-code preview** — considered (text-to-cad ships a strong implementation: layer scrubbing, feature-type coloring, adaptive decimation) and rejected: 3D-printing-oriented, outside this extension's CAD/FEM domain.
- **URDF/SDF robotics rendering** — considered (joint articulation, FK, MoveIt2 integration in text-to-cad) and rejected for the same reason.
