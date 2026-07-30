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

Everything previously shipped is tracked in `CHANGELOG.md`, and `CLAUDE.md`
has a per-feature section with the verified implementation details for
anything currently in the codebase — this page is for what's **not** built
yet, only.

## Queued

Every item below is a **known, documented limitation** of something that
already ships — each was consciously scoped out at the time, with the reason
recorded in `CLAUDE.md`. None is a bug.

### Tier 2 — extending shipped features

1. **Unit conversion on export** (**M**). Units handling is deliberately
   presentation-only today. Converting on export means a real geometric scale
   transform applied before every writer (STEP/IGES/BREP via OCCT, STL/OBJ/PLY/
   glTF via Three.js, and the Gmsh mesh formats) — a separate, larger change
   than the display-unit selector was.
2. **Unit detection for IGES** (**S**). STEP's declared unit is detected by a
   plain-text scan of `GLOBAL_UNIT_ASSIGNED_CONTEXT`. IGES stores its unit flag
   in a positional Global-section field — a different enough format that it was
   skipped for a presentation-only feature. (BREP has no unit metadata at all;
   nothing to do there.)
3. **Mesh-source model comparison** (**L**). `compare_models` is B-rep-only:
   mesh formats have no host-side shape to query, and there is no host-side
   mesh parser anywhere in the codebase. Would need a webview round trip or a
   new host-side parser.
4. **Exact-precision measurement** (**M**). Distances are computed client-side
   against the triangulated approximation (tied to the 0.1 tessellation
   deflection). `BRepExtrema_DistShapeShape` in the host would give exact B-rep
   precision, at the cost of a round trip per measurement.
5. **Entity-id rebinding after topology-changing ops** (**L**). Booleans,
   fillets, and feature modeling re-tessellate into fresh `face-N`/`edge-N`
   ids, so existing *part* assignments referencing them are dropped on reload
   (gracefully, by the tolerant sidecar parser). A geometric rebinding pass
   could preserve them; the matching heuristics are the hard part.

### Tier 3 — upstream-dependent

6. **Richer meshio++ import** (**M**, partly upstream). Imported VTK/MED/CGNS/
   Exodus/XDMF/MDPA files funnel through meshio++'s STL-boundary writer, so
   region names, scalar point/cell data, and multi-material grouping are lost —
   only geometry survives. Preserving them needs a genuinely different import
   path, not just a flag.
7. **Confirm Kratos MDPA block names** (**S**, needs Kratos-dev input). The
   geometry block names are certain; the newer kinds' `Element*`/`Condition*`
   names are best-guess transcriptions. `"elements"` mode already pre-flights
   an actionable error for any kind whose name is unknown, so the guard is in
   place — this is a verification task, not new code.

### Verification debt

8. **Confirm drag-and-drop's true-path branch** (**S**). `setupDragAndDrop()`
   reads `File.path` (a legacy Electron extension) and falls back to the Open
   dialog when it's absent, so the feature always works — but the true-path
   branch has never been exercised against a real Extension Development Host.
   If it turns out never to fire, the fallback-only behaviour is still correct
   and only the docs need correcting.

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
