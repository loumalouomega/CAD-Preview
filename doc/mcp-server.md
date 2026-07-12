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
for unusual layouts.

## Tools

Every tool takes an absolute `path` to the model file, and every result carries a
`warnings` array reporting graceful degradations. Call `describe_capabilities`
first — it returns the full op catalog with per-kind parameter documentation.

| Tool | What it does |
| ---- | ------------ |
| `describe_capabilities` | Op catalog (all edit-op kinds + parameter docs + B-rep-only/topology-changing flags), entity-id scheme, export target matrix, mesh export formats, mesh option defaults, headless limitations. |
| `load_model` | Load the model (sidecar edits replayed) and return the component tree, entity-id inventory (`solid-N`/`face-N`/`edge-N`/`point-N` — the ids used as op operands and part members), bounding box, and sidecar summary. |
| `get_state` | The sidecar state without loading geometry: edit-op stack (indexed, described), variables (evaluated), parts, mesh options. |
| `apply_edit_ops` | Validate and append raw `EditOp` JSON objects to the op stack; per-op accept/reject report; for B-rep sources returns the post-replay entity inventory. `dryRun` validates without persisting. |
| `remove_edit_op` | Remove one op by 0-based index (the panel's per-row ✕ equivalent). |
| `set_variables` | Replace the named parametric variables (`L = 20`) and re-resolve every op expression — geometry rebuilds from the new values on next load/mesh. |
| `set_part` | Create/update/remove a named part grouping entity ids; optional per-part `meshSize` for local refinement. |
| `set_mesh_options` | Merge fields into the persisted mesh options (also regenerates the one-way `<model>.geo` script). |
| `generate_mesh` | Run Gmsh and return statistics only (node/element counts, element groups, timing) — nothing written. |
| `export_mesh` | Generate and write the mesh in any registered format (`mdpaElements`, `mdpaGeometries`, `msh`, `msh2`, `geoUnrolled`, `vtk`, `unv`, `inp`, `bdf`, `su2`, `mesh`, `stl`, `diff`, `off`). `geoUnrolled` also writes the required `.xao` companion beside the output for B-rep sources. |
| `export_brep` | Export a B-rep source to another B-rep format (STEP/IGES/BREP) with all edits baked in. |

Edit ops are passed as **raw JSON** (e.g.
`{"op": "addBox", "center": [0,0,0], "size": [20,10,5]}`) and validated by the
same tolerant gate the extension uses (`validateEditOp`) — so every op kind the
extension gains is automatically available to agents, and a malformed op is
rejected with a reason rather than crashing anything. Numeric fields may bind to
variables via the op's `exprs` map (`{"exprs": {"size[0]": "L"}}`).

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

## Headless capability matrix

| Source format | Load/inventory | Edit ops | Mesh | Export |
| ------------- | -------------- | -------- | ---- | ------ |
| `.step`/`.stp`, `.iges`/`.igs`, `.brep` | ✅ full | ✅ full (baked into mesh/export) | ✅ | ✅ B-rep targets |
| `.stl` | route info only | sidecar-only¹ | ✅ raw file bytes² | ❌ webview-only |
| `.obj`, `.ply`, `.gltf`/`.glb` | route info only | sidecar-only¹ | ❌ webview-only | ❌ webview-only |

¹ Mesh-legal ops (transforms, booleans, holes, primitives, explode) are validated
and persisted, but the mesh edit engine is Three.js in the webview — they replay
when the file is opened in VS Code, not headless. B-rep-only ops are rejected.

² Edits are **not** baked into the meshed geometry for `.stl` (the extension bakes
them by serializing the webview's displayed scene); the raw file is meshed and a
warning is reported. Parts can't become physical groups for mesh sources; a single
part's `meshSize` acts as a one-off global size override.

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
  JSON-RPC against `examples/STP/bull.stp` (build → load → edit → mesh →
  export `.msh` + `.geo_unrolled`/`.xao` + `.brep`), asserting the source file
  stays byte-identical.
