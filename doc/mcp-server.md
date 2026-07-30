# MCP Server

CAD-Preview ships a standalone [Model Context Protocol](https://modelcontextprotocol.io)
server (`dist/mcp-server.js`) so AI agents — Claude Code, or any MCP client — can
load CAD models, apply edit operations, manage parts and parametric variables, and
generate/export finite-element meshes **headless**, with no VS Code involved.

It reuses the exact same host pipeline the extension runs (OCCT via
`opencascade.js`, Gmsh via `@loumalouomega/gmsh-wasm`) and persists to the exact
same sidecar files — so an agent's edits appear in the extension the next time the
file is opened, and vice versa.

## Prerequisites

```bash
npm install
npm run build   # produces dist/mcp-server.js + the two WASM binaries beside it
```

## Prerequisites for render_snapshot

`render_snapshot` needs Playwright's Chromium binary, which is **not** part
of `npm install`/`npm run build` above — it's a separate, optional download:

```bash
npx playwright install chromium
```

This works in a repo checkout, CI, or an agent sandbox that can run the
command once, but it is **not guaranteed present for a `.vsix`-installed end
user** — Playwright is a devDependency and `.vscodeignore` excludes
`node_modules/**` from the packaged extension with no carve-out for it. Every
other tool in this server works with no such requirement. `render_snapshot`
detects Playwright/Chromium's absence itself and returns
`{supported: false, warnings: [...]}` rather than crashing — call the tool
and check `supported`, don't assume availability.

## Network dependency: search_standard_parts / download_standard_part

These two tools call the hosted [step.parts](https://www.step.parts) REST
API (`api.step.parts`) — the **only** external network dependency anywhere
in this extension/server; every other tool is fully offline. No API key is
required. Both tools are opt-in by construction (nothing calls this API
except an agent explicitly invoking one of these two tools) and degrade
gracefully: a network/DNS failure or non-2xx response returns `{supported:
false, warnings: [...]}` rather than throwing, and per step.parts' own
error semantics, that failure is **inconclusive** — never report a part as
"unavailable" unless the API was reachable and genuinely returned no
candidates.

## Registering with an MCP client

With Claude Code:

```bash
claude mcp add cad-preview -- node /absolute/path/to/CAD-Preview/dist/mcp-server.js
```

or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "cad-preview": {
      "command": "node",
      "args": ["/absolute/path/to/CAD-Preview/dist/mcp-server.js"]
    }
  }
}
```

The server locates the WASM binaries relative to its own bundle
(`<bundle dir>/../dist/*.wasm`, i.e. the repo root or an installed extension
directory works as-is); set the `CAD_PREVIEW_ROOT` environment variable to point
at a directory containing `dist/opencascade.wasm.wasm` + `dist/gmsh-core.wasm`
for unusual layouts. The third WASM module, `@meshioplusplus/wasm`, is **not**
copied into `dist/` (unlike the other two) — it's loaded straight from
`node_modules/@meshioplusplus/wasm/` at runtime (a dynamic `import()`, since
it's ESM-only — see `meshioService.ts`), so `node_modules` must be present
alongside `dist/mcp-server.js` for meshio-only formats (VTK/MED/CGNS/Exodus/
XDMF/MDPA) to work; everything else in this server works without it.

## Tools

Every tool takes an absolute `path` to the model file, and every result carries a
`warnings` array reporting graceful degradations. Call `describe_capabilities`
first — it returns the full op catalog with per-kind parameter documentation.

| Tool | What it does |
| ---- | ------------ |
| `describe_capabilities` | Op catalog (all edit-op kinds + parameter docs + B-rep-only/topology-changing flags), entity-id scheme, export target matrix, mesh export formats, mesh option defaults, headless limitations. |
| `load_model` | Load the model (sidecar edits replayed) and return the component tree, entity-id inventory (`solid-N`/`face-N`/`edge-N`/`point-N` — the ids used as op operands and part members), bounding box, and sidecar summary. |
| `get_mass_properties` | Volume, surface area, length, center of mass, and moments of inertia (about the centroid) for the whole model or one entity — B-rep sources only headless (OCCT `BRepGProp`); mesh formats return `supported: false`. All lengths/areas/volumes are in the model's internal cascade unit (millimetres — OCCT's STEP reader auto-converts every shape to it regardless of the source file's declared unit, e.g. inches); this tool never applies the extension's webview-only display-unit selector, so a caller wanting a different unit converts the raw mm-based numbers itself. |
| `inspect` | Per-entity facts for one `solid-N`/`face-N`/`edge-N`/`point-N` id: bounding box, bbox-center (**not** `get_mass_properties`' mass-weighted centroid — they differ for an asymmetric shape), area/length, and — for a planar face — its normal and surface type (`plane`/`cylinder`/`cone`/`sphere`/`torus`/`other`). B-rep sources only headless. |
| `measure` | Straight-line distance between two entities' bbox centers, plus (with an optional `axis` vector) the signed component of that displacement along it. B-rep sources only headless. |
| `render_snapshot` | 4 labelled PNGs of the current model (sidecar edits replayed) — two opposed isometrics + top + front, optional `focus`/`hide` by entity id, optional `displayMode` (shaded/wireframe) for the whole packet. B-rep sources only, and **requires Playwright + a Chromium binary in this environment** — see "Prerequisites for render_snapshot" below; check the response's `supported` field rather than assuming availability. |
| `search_standard_parts` | Faceted search over the hosted [step.parts](https://www.step.parts) catalog (fasteners, bearings, connectors, extrusions, ...) — `q` fuzzy text + `tag`/`category`/`family`/`standard` filters + pagination. **Network call** — `supported: false` on any API/network failure (inconclusive, never "no matching parts"). |
| `download_standard_part` | Downloads one step.parts part's STEP file to `outputPath`, verifying it against the part's recorded `sha256` if present (`verifiedChecksum` in the result). The file is an ordinary STEP file — opens through the normal pipeline. **Network call**, same graceful-failure convention as `search_standard_parts`. |
| `compare_models` | Diff two B-rep models solid-by-solid, matched by bounding-box-centroid proximity + volume similarity — reports added/removed/matched solids with each match's raw centre displacement and volume delta (never a black-box moved/unchanged verdict). B-rep sources only headless; mesh formats return `supported: false`. |
| `get_state` | The sidecar state without loading geometry: edit-op stack (indexed, described), variables (evaluated), parts, mesh options. |
| `apply_edit_ops` | Validate and append raw `EditOp` JSON objects to the op stack; per-op accept/reject report; for B-rep sources returns the post-replay entity inventory. `dryRun` validates without persisting. |
| `run_parametric_script` | Compiles a declarative `{variables?, steps}` script (each step is one op, or one flat `repeat` loop expanding a template op-list with the loop index available to `exprs`) into ops and appends them via the same path as `apply_edit_ops` — NOT a general scripting language, no code execution. See "Parametric scripts" below. |
| `remove_edit_op` | Remove one op by 0-based index (the panel's per-row ✕ equivalent). |
| `set_variables` | Replace the named parametric variables (`L = 20`) and re-resolve every op expression — geometry rebuilds from the new values on next load/mesh. |
| `set_part` | Create/update/remove a named part grouping entity ids; optional per-part `meshSize` for local refinement. |
| `set_mesh_options` | Merge fields into the persisted mesh options (also regenerates the one-way `<model>.geo` script). |
| `generate_mesh` | Run Gmsh and return statistics only (node/element counts, element groups, timing, an optional element-quality summary, and — for a 3D mesh with elements below quality 0.2 — a worst-element count) — nothing written. |
| `export_mesh` | Generate and write the mesh in any registered format (`mdpaElements`, `mdpaGeometries`, `msh`, `msh2`, `geoUnrolled`, `vtk`, `med`, `cgns`, `xdmf`, `unv`, `inp`, `bdf`, `su2`, `mesh`, `stl`, `diff`, `off`). `geoUnrolled` also writes the required `.xao` companion beside the output for B-rep sources; `xdmf` similarly writes a required `.h5` companion (both bridged through meshio++, since this Gmsh build can't write MED/CGNS/XDMF itself — see `doc/gmsh-integration.md`'s "The meshio++ bridge"). |
| `export_brep` | Export a B-rep source to another B-rep format (STEP/IGES/BREP) with all edits baked in. |
| `save_preprocess` | Bundle the CAD source plus whichever of its `.parts.json`/`.edits.json`/`.mesh.json`/`.geo` sidecars currently exist into a single `.zip` archive. Mirrors the extension's File ▸ Save Preprocess…. |
| `load_preprocess` | Restore a `.zip` from `save_preprocess` (or the extension's File ▸ Save Preprocess…) to a new CAD file path plus its matching sidecar filenames. Mirrors the extension's File ▸ Load Preprocess…. |

Edit ops are passed as **raw JSON** (e.g.
`{"op": "addBox", "center": [0,0,0], "size": [20,10,5]}`) and validated by the
same tolerant gate the extension uses (`validateEditOp`) — so every op kind the
extension gains is automatically available to agents, and a malformed op is
rejected with a reason rather than crashing anything. Numeric fields may bind to
variables via the op's `exprs` map (`{"exprs": {"size[0]": "L"}}`).

## Parametric scripts

`run_parametric_script` is NOT a general-purpose scripting language — no code
execution, no I/O — just a compiler from a small declarative document into the
same `EditOp[]` shape `apply_edit_ops` accepts. A script is:

```json
{
  "variables": [{ "name": "R", "expr": "10" }, { "name": "N", "expr": "6" }],
  "steps": [
    {
      "repeat": {
        "times": "N",
        "indexVar": "i",
        "body": [
          {
            "op": "addCylinder",
            "center": [0, 0, 0],
            "axis": [0, 0, 1],
            "radius": 2,
            "height": 5,
            "exprs": { "center[0]": "R*cos(i*360/N)", "center[1]": "R*sin(i*360/N)" }
          }
        ]
      }
    }
  ]
}
```

This compiles to `N` (here 6) `addCylinder` ops arranged in a bolt circle of
radius `R` — a classic "loops/patterns cost one script instead of N tool
calls" case. Every step is exactly one of:

- `{"op": <EditOp>}` — a single op, identical to one `apply_edit_ops` entry
  (`exprs` stays live for future parametric edits, exactly as usual).
- `{"repeat": {"times", "indexVar", "body"}}` — expands `body` (an array of
  raw ops) `times` times (a number, or an expression string evaluated once
  against document + script variables); `indexVar` names the 0-based loop
  index for that expansion. Body ops may reference the loop index, script
  variables, and the document's own persisted variables (`set_variables`)
  in their `exprs`, using the exact same expression syntax (`sin`/`cos`/
  `tan` in degrees, `sqrt`, arithmetic) op fields already use elsewhere.

**Repeat-generated ops are fully baked** — every `exprs`-bound field is
resolved to a concrete number and `exprs` is then stripped from the compiled
op (a loop-index expression would be meaningless on a future replay, since
no document variable named `"i"` exists to resolve it against). If a value
should stay live/editable later, give it a real document variable via
`set_variables` and reference it from a plain (non-repeated) `op` step
instead — that DOES stay live, same as any `apply_edit_ops` call.

Script variables (the top-level `variables` array) are compile-time-only —
never persisted, and separate from the document's own variable table; a
script variable shadows a same-named document variable for that one compile
only. Safety caps (200 steps, 1000 iterations per repeat, 5000 total
compiled ops) return `truncated: true` rather than silently dropping
anything — check `issues` for what was cut. Every malformed step (an
invalid op, a bad `indexVar`, a `times` expression that fails to evaluate) is
skipped with a reason in the per-step `report`, never crashes the whole
compile — same graceful-degradation convention as `apply_edit_ops`. `dryRun`
compiles and reports without persisting.

## The sidecar contract

The server never writes the CAD source file (every output path is guarded).
State persists to the same sidecars the extension reads on open:

| File | Contents |
| ---- | -------- |
| `<model>.edits.json` | Ordered, replayable edit-op list + parametric variables |
| `<model>.parts.json` | Named parts (entity-id groups, colours, mesh sizes) |
| `<model>.mesh.json` | Mesh-generation options |
| `<model>.geo` | Generated (one-way) Gmsh script for the current options |

This makes the workflow bidirectional: ask an agent to model something, then open
the file in VS Code to inspect it — or set up parts interactively and let the
agent mesh and export.

`save_preprocess`/`load_preprocess` package/restore the CAD source plus
whichever of these four sidecars exist on disk as a single portable `.zip` — a
missing sidecar (e.g. mesh options never set) is simply omitted from the
archive, never an error. The `.geo` script inside the archive is never
restored verbatim on `load_preprocess`; the mesh options sidecar (if any) is
re-written through the normal options path instead, which regenerates `.geo`
fresh — same one-way-generation rule as every other write path.

## Headless capability matrix

| Source format | Load/inventory | Edit ops | Mesh | Export |
| ------------- | -------------- | -------- | ---- | ------ |
| `.step`/`.stp`, `.iges`/`.igs`, `.brep` | ✅ full | ✅ full (baked into mesh/export) | ✅ | ✅ B-rep targets |
| `.stl` | route info only | sidecar-only¹ | ✅ raw file bytes² | ❌ webview-only |
| `.vtk`/`.vtu`/`.med`/`.cgns`/`.exo`(`.e`)/`.xdmf`/`.mdpa` (meshio++) | route info only | sidecar-only¹ | ✅ host-side STL-boundary conversion² ³ | ❌ webview-only |
| `.obj`, `.ply`, `.gltf`/`.glb` | route info only | sidecar-only¹ | ❌ webview-only | ❌ webview-only |

¹ Mesh-legal ops (transforms, booleans, holes, primitives, explode) are validated
and persisted, but the mesh edit engine is Three.js in the webview — they replay
when the file is opened in VS Code, not headless. B-rep-only ops are rejected.

² Edits are **not** baked into the meshed geometry for `.stl` or a meshio++-only
source (the extension bakes them by serializing the webview's displayed scene);
the raw file (its boundary surface, for meshio++) is meshed and a warning is
reported. Parts can't become physical groups for either; a single part's
`meshSize` acts as a one-off global size override.

³ Unlike `.obj`/`.ply`/`.gltf`, meshio++-only formats run entirely host-side
(`src/meshioService.ts`, no browser/webview needed) — genuinely *more*
headlessly capable than those three, since `convertToStlBoundary()` produces
the same STL bytes the extension itself would show, with zero webview
involvement.

`get_mass_properties`, `inspect`, `measure`, `render_snapshot`, and
`compare_models` aren't columns above since all are read-only and orthogonal
to the edit/mesh/export pipeline: B-rep sources get the full OCCT
`BRepGProp`/`bboxCenter`+`bboxDiagonal` computation (or, for
`render_snapshot`, a real headless render) for any of the three format
families; every mesh format (`.stl` included) returns `{supported: false}`
with a warning — mass properties are computed client-side in the webview's
Three.js scene (no headless equivalent), `inspect`/`measure` need host-side
B-rep topology that doesn't exist for a mesh source outside the webview, and
`compare_models` has no host-side geometry to derive solid centroids/volumes
from for a mesh source at all (nothing parses `.stl`/`.obj`/`.ply`/`.gltf`
outside the webview's Three.js loaders). `render_snapshot` additionally
returns `{supported: false}` when Playwright/Chromium aren't available in
this environment, independent of source format — see "Prerequisites for
render_snapshot" above. `search_standard_parts`/`download_standard_part`
aren't in the matrix at all for a different reason — they don't operate on
any open document/source format; they're a standalone catalog lookup that
happens to produce an ordinary STEP file the existing pipeline can then
open like any other.

## Verdict conventions

Every tool reports facts, not verdicts — rendering pass/fail/need-more-info
is the calling agent's job, not this server's. `describe_capabilities`'
`verdictConventions` field states this explicitly: a `supported: false`
response or a tool/network failure is **need-more-info**, never a silent
pass or fail; `render_snapshot`'s images are **diagnostic, not
authoritative** — convert a visual concern into an `inspect`/`measure` check
before treating anything as validated, and don't loop on repeated snapshots.

## Troubleshooting

- **The client reports protocol/parse errors** — something wrote to stdout.
  stdout is the JSON-RPC channel; the server rebinds `console.log/info/warn` to
  stderr before any WASM init, so a regression here means new code printed to
  `process.stdout` directly. `npm run mcp:smoke` catches this.
- **`ENOENT … opencascade.wasm.wasm`** — `dist/` isn't populated; run
  `npm run build`, or point `CAD_PREVIEW_ROOT` at a directory whose `dist/`
  contains both WASM binaries.
- **First tool call is slow** — the WASM kernels (~110 MB combined) initialize
  lazily on first use and are then memoized for the life of the process.

## Testing

- `npm test` covers the tool handlers and sidecar store with an injected fake
  pipeline (no WASM).
- `npm run mcp:smoke` runs the real end-to-end scenario over actual stdio
  JSON-RPC against `examples/STP/bull.stp` (build → load → edit → inspect/
  measure → compare_models → mesh → a hex-dominant generate/export (msh
  succeeds, Kratos MDPA rejects with a specific error) → export `.msh` +
  `.geo_unrolled`/`.xao` + `.brep` → render_snapshot →
  search_standard_parts/download_standard_part against the real step.parts
  API → `run_parametric_script` (a real bolt-circle, trig exprs over the
  loop index, verified against live OCCT geometry) → `save_preprocess` →
  `load_preprocess`), asserting the source file
  stays byte-identical and that the preprocess archive round-trips the
  source + edits sidecar into a fresh copy. `render_snapshot`'s assertions
  tolerate Chromium being absent in the smoke environment (see
  "Prerequisites for render_snapshot" above) — when it's installed, the
  test also checks the 4 returned images are real PNGs and that the raw
  JSON-RPC response carries 4 image content blocks. Similarly,
  search_standard_parts/download_standard_part tolerate the step.parts API
  being unreachable — when it is reachable, the test verifies a real
  sha256 checksum match on the downloaded file.
