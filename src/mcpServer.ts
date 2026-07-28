/**
 * Standalone stdio MCP server exposing the extension's headless pipeline —
 * load/edit/mesh/export CAD models with no VS Code. Bundled by esbuild to
 * `dist/mcp-server.js` (see `esbuild.mjs`'s `mcpConfig`); register it with
 * an MCP client via `node dist/mcp-server.js`. See `doc/mcp-server.md`.
 */

// stdout IS the JSON-RPC channel: both Emscripten WASM modules (OCCT, Gmsh)
// print through console.log/info/warn by default, which would corrupt the
// protocol stream the instant a model loads. Rebind them to stderr BEFORE
// anything can initialize a WASM factory. StdioServerTransport writes to
// process.stdout directly, so it is unaffected.
/* eslint-disable no-console */
console.log = console.error.bind(console);
console.info = console.error.bind(console);
console.warn = console.error.bind(console);
console.debug = console.error.bind(console);
/* eslint-enable no-console */

import * as path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadBRep, exportBRep } from "./occtService";
import { generateMesh, exportMeshFormat, exportMdpa, exportGeoUnrolled } from "./gmshService";
import { computeMassProperties } from "./massProperties";
import {
  describeCapabilities,
  loadModel,
  getMassProperties,
  getState,
  applyEditOps,
  removeEditOp,
  setVariables,
  setPart,
  setMeshOptions,
  generateMeshTool,
  exportMeshTool,
  exportBRepTool,
  savePreprocessTool,
  loadPreprocessTool,
  type ToolContext,
} from "./mcpTools";
import type { MeshOptions } from "./meshOptions";

// The bundle lives in dist/ next to the WASM binaries; getOcct/getGmsh read
// `<extensionPath>/dist/*.wasm`, so extensionPath is the bundle dir's parent
// (the repo root, or the installed extension dir). Overridable for unusual
// layouts.
const extensionPath = process.env.CAD_PREVIEW_ROOT ?? path.join(__dirname, "..");

const ctx: ToolContext = {
  extensionPath,
  pipeline: { loadBRep, exportBRep, generateMesh, exportMeshFormat, exportMdpa, exportGeoUnrolled, computeMassProperties },
};

const server = new McpServer({ name: "cad-preview", version: "1.0.0" });

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Wraps a handler: JSON result → text content block, thrown Error → isError. */
function wrap<A>(handler: (args: A) => Promise<unknown> | unknown): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      const result = await handler(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  };
}

const modelPath = z.string().describe("Absolute path to the CAD model file");
// Deliberately loose op/options schemas: validateEditOp / validateMeshOptions
// are the real (tolerant, always-current) gates — duplicating the 43-kind op
// union in zod would drift against src/editOps.ts.
const rawOps = z
  .array(z.looseObject({ op: z.string() }))
  .describe("Raw EditOp objects — see describe_capabilities for each kind's fields");
const meshOptionsOverride = z
  .looseObject({})
  .optional()
  .describe("Partial MeshOptions override for this call only (not persisted)");

server.registerTool(
  "describe_capabilities",
  {
    description:
      "The op catalog (all edit-op kinds with parameter docs and B-rep-only/topology-changing flags), entity-id scheme, export target matrix, mesh export formats, mesh option defaults, and headless limitations. Call this first.",
  },
  wrap(() => describeCapabilities())
);

server.registerTool(
  "load_model",
  {
    description:
      "Load a CAD model (with its sidecar edits replayed) and return its component tree, entity-id inventory (solid/face/edge/point ids for use as op operands), bounding box, and sidecar summary. B-rep sources (.step/.stp/.iges/.igs/.brep) get the full inventory; mesh formats return route info only.",
    inputSchema: { path: modelPath },
  },
  wrap((args: { path: string }) => loadModel(ctx, args))
);

server.registerTool(
  "get_mass_properties",
  {
    description:
      "Volume, surface area, length, center of mass, and moments of inertia (about the centroid) for the whole model or one entity — B-rep sources only headless (OCCT BRepGProp); mesh formats return supported: false (compute client-side in the webview instead).",
    inputSchema: {
      path: modelPath,
      entityId: z
        .string()
        .optional()
        .describe("solid-N / face-N / edge-N id from load_model's inventory; omit for the whole model"),
    },
  },
  wrap((args: { path: string; entityId?: string }) => getMassProperties(ctx, args))
);

server.registerTool(
  "get_state",
  {
    description:
      "Read the model's sidecar state without loading geometry: the edit-op stack (indexed, with descriptions), parametric variables (with evaluated values), parts, and mesh options.",
    inputSchema: { path: modelPath },
  },
  wrap((args: { path: string }) => getState(args))
);

server.registerTool(
  "apply_edit_ops",
  {
    description:
      "Validate and append edit operations to the model's op stack (persisted to <model>.edits.json — the CAD file itself is never written; the VS Code extension replays the same sidecar). Returns a per-op accept/reject report and, for B-rep sources, the post-replay entity inventory (topology-changing ops renumber face/edge ids). Use dryRun to validate without persisting.",
    inputSchema: { path: modelPath, ops: rawOps, dryRun: z.boolean().optional() },
  },
  wrap((args: { path: string; ops: Array<Record<string, unknown>>; dryRun?: boolean }) => applyEditOps(ctx, args))
);

server.registerTool(
  "remove_edit_op",
  {
    description: "Remove one op from anywhere in the stack by 0-based index (like the panel's per-row ✕).",
    inputSchema: { path: modelPath, index: z.number().int().describe("0-based index into the op stack") },
  },
  wrap((args: { path: string; index: number }) => removeEditOp(args))
);

server.registerTool(
  "set_variables",
  {
    description:
      "Replace the model's named parametric variables (e.g. L = 20) and re-resolve every op expression against them — geometry rebuilds from the new values on the next load/mesh. A variable's expression may reference only variables defined above it in the list. Op fields bind to variables via each op's `exprs` map.",
    inputSchema: {
      path: modelPath,
      variables: z.array(z.object({ name: z.string(), expr: z.string() })).describe("Full ordered variable list"),
    },
  },
  wrap((args: { path: string; variables: Array<{ name: string; expr: string }> }) => setVariables(args))
);

server.registerTool(
  "set_part",
  {
    description:
      "Create, update, or remove a named part (FEM sub-model-part) grouping entity ids from load_model's inventory. Parts drive per-part colours, Gmsh physical groups in mesh exports (B-rep sources), and optional per-part meshSize refinement. Omitted fields keep their current values; meshSize: null clears it.",
    inputSchema: {
      path: modelPath,
      name: z.string().describe("Part name (the upsert key)"),
      remove: z.boolean().optional().describe("Remove the part instead of upserting"),
      color: z.string().optional().describe("CSS hex colour, e.g. #ff8800"),
      volumes: z.array(z.string()).optional().describe("solid-N ids"),
      surfaces: z.array(z.string()).optional().describe("face-N ids"),
      lines: z.array(z.string()).optional().describe("edge-N ids"),
      points: z.array(z.string()).optional().describe("point-N ids"),
      meshSize: z.number().nullable().optional().describe("Target element size for local refinement; null clears"),
    },
  },
  wrap(
    (args: {
      path: string;
      name: string;
      remove?: boolean;
      color?: string;
      volumes?: string[];
      surfaces?: string[];
      lines?: string[];
      points?: string[];
      meshSize?: number | null;
    }) => setPart(args)
  )
);

server.registerTool(
  "set_mesh_options",
  {
    description:
      "Merge fields into the persisted mesh-generation options (<model>.mesh.json; also regenerates the one-way <model>.geo script). Invalid fields fall back to defaults with a warning. See describe_capabilities for the fields and defaults.",
    inputSchema: { path: modelPath, options: z.looseObject({}).describe("Partial MeshOptions") },
  },
  wrap((args: { path: string; options: Record<string, unknown> }) =>
    setMeshOptions({ path: args.path, options: args.options as Partial<MeshOptions> })
  )
);

server.registerTool(
  "generate_mesh",
  {
    description:
      "Generate a finite-element mesh of the model with Gmsh (edits baked in for B-rep sources; raw file bytes for .stl) and return statistics only (node/element counts, per-part element groups, timing). Nothing is written to disk — use export_mesh for that.",
    inputSchema: { path: modelPath, options: meshOptionsOverride },
  },
  wrap((args: { path: string; options?: Record<string, unknown> }) =>
    generateMeshTool(ctx, { path: args.path, options: args.options as Partial<MeshOptions> | undefined })
  )
);

server.registerTool(
  "export_mesh",
  {
    description:
      "Generate a mesh and write it to outputPath in the given format (format ids from describe_capabilities: mdpaElements, mdpaGeometries, msh, msh2, geoUnrolled, vtk, unv, inp, bdf, su2, mesh, stl, diff, off). geoUnrolled also writes a required .xao companion beside the output for B-rep sources.",
    inputSchema: {
      path: modelPath,
      format: z.string().describe("Mesh export format id"),
      outputPath: z.string().describe("Destination file path (must not be the CAD source)"),
      options: meshOptionsOverride,
    },
  },
  wrap((args: { path: string; format: string; outputPath: string; options?: Record<string, unknown> }) =>
    exportMeshTool(ctx, { ...args, options: args.options as Partial<MeshOptions> | undefined })
  )
);

server.registerTool(
  "export_brep",
  {
    description:
      "Export a B-rep source to another B-rep format (step/iges/brep, excluding the source's own format) with all sidecar edits baked in, written to outputPath. Mesh-format targets (STL/OBJ/PLY/glTF) are webview-only and unavailable headless.",
    inputSchema: {
      path: modelPath,
      targetFormat: z.string().describe("step | iges | brep"),
      outputPath: z.string().describe("Destination file path (must not be the CAD source)"),
    },
  },
  wrap((args: { path: string; targetFormat: string; outputPath: string }) => exportBRepTool(ctx, args))
);

server.registerTool(
  "save_preprocess",
  {
    description:
      "Package the CAD source file plus its edits/parts/mesh-options sidecars (whichever currently exist on disk) into a single portable .zip archive at outputPath. Mirrors the extension's File ▸ Save Preprocess…",
    inputSchema: {
      path: modelPath,
      outputPath: z.string().describe("Destination .zip path (must not be the CAD source)"),
    },
  },
  wrap((args: { path: string; outputPath: string }) => savePreprocessTool(args))
);

server.registerTool(
  "load_preprocess",
  {
    description:
      "Restore a CAD source file + its edits/parts/mesh-options sidecars from a .zip built by save_preprocess (or the extension's File ▸ Save Preprocess…), writing them to outputPath (and its matching sidecar filenames). Mirrors the extension's File ▸ Load Preprocess…",
    inputSchema: {
      zipPath: z.string().describe("Path to the .preprocess.zip archive"),
      outputPath: z.string().describe("Destination path for the restored CAD file (sidecars are written alongside it)"),
    },
  },
  wrap((args: { zipPath: string; outputPath: string }) => loadPreprocessTool(args))
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error(`cad-preview MCP server ready (extensionPath: ${extensionPath})`);
}

main().catch((err) => {
  console.error("cad-preview MCP server failed to start:", err);
  process.exit(1);
});
