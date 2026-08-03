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
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createKernelClient } from "./kernelClient";
import {
  describeCapabilities,
  loadModel,
  getMassProperties,
  inspectEntity,
  measureTool,
  measureExactTool,
  checkInterferenceTool,
  renderSnapshotTool,
  searchStandardPartsTool,
  downloadStandardPartTool,
  compareModelsTool,
  getState,
  applyEditOps,
  runParametricScriptTool,
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
  type ProgressCallback,
} from "./mcpTools";
import type { MeshOptions } from "./meshOptions";

// The bundle lives in dist/ next to the WASM binaries; getOcct/getGmsh read
// `<extensionPath>/dist/*.wasm`, so extensionPath is the bundle dir's parent
// (the repo root, or the installed extension dir). Overridable for unusual
// layouts.
const extensionPath = process.env.CAD_PREVIEW_ROOT ?? path.join(__dirname, "..");

// Every WASM-touching pipeline call now routes through a forked child
// process (roadmap "OCCT in a forked child process", Phase 0+1 — see
// CLAUDE.md) rather than calling occtService.ts/gmshService.ts/etc.
// directly: `createKernelClient` returns an object satisfying the exact same
// `Pipeline` shape `mcpTools.ts` already consumes, so `mcpTools.ts` itself
// needed zero changes. This gives the server two things it never had
// in-process — a hung/crashed WASM call can be killed without wedging the
// whole server, and a genuinely corrupted WASM heap (not just a cleanly
// thrown, regex-detected abort) can no longer poison a later, unrelated
// call, since the next call after a dead child transparently respawns a
// fresh one.
const ctx: ToolContext = {
  extensionPath,
  pipeline: createKernelClient(extensionPath),
};

const server = new McpServer({ name: "cad-preview", version: "1.0.0" });

type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ToolContent[]; isError?: boolean };

/** A tool result may carry `images` (base64 PNGs) alongside its JSON facts —
 * `render_snapshot` is the only producer today, but this is general-purpose:
 * any future image-returning tool follows the same shape. `wrap()` emits one
 * text block (images summarized as `[{label, mimeType}]`, base64 omitted so
 * the JSON payload doesn't double the response size) plus one `{type:
 * "image"}` content block per image — the SDK's `CallToolResultSchema`
 * already supports an image content type (`@modelcontextprotocol/sdk`
 * 1.29.0's `ImageContentSchema`). */
interface WithImages {
  images?: Array<{ label: string; mimeType: string; dataBase64: string }>;
}

function hasImages(result: unknown): result is WithImages {
  return typeof result === "object" && result !== null && Array.isArray((result as WithImages).images);
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Wraps a handler: JSON result → text content block (+ image blocks for a
 * result carrying `images`), thrown Error → isError. The handler's second
 * parameter is a progress-report callback — a no-op unless the calling MCP
 * client opted in via `_meta.progressToken` on its `tools/call` request
 * (`extra.sendNotification`/`extra._meta.progressToken`, the exact pattern
 * the SDK's own `examples/server/progressExample.js` demonstrates). */
function wrap<A>(
  handler: (args: A, onProgress: ProgressCallback) => Promise<unknown> | unknown
): (args: A, extra: ToolExtra) => Promise<ToolResult> {
  return async (args: A, extra: ToolExtra) => {
    const onProgress: ProgressCallback = (p) => {
      const token = extra?._meta?.progressToken;
      if (token === undefined) return;
      void extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: p.progress, total: p.total, message: p.message },
      });
    };
    try {
      const result = await handler(args, onProgress);
      const content: ToolContent[] = [];
      if (hasImages(result)) {
        const { images, ...rest } = result;
        content.push({ type: "text", text: JSON.stringify({ ...rest, images: images?.map((i) => ({ label: i.label, mimeType: i.mimeType })) }, null, 2) });
        for (const img of images ?? []) content.push({ type: "image", data: img.dataBase64, mimeType: img.mimeType });
      } else {
        content.push({ type: "text", text: JSON.stringify(result, null, 2) });
      }
      return { content };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  };
}

const modelPath = z.string().describe("Absolute path to the CAD model file");
// Deliberately loose op/options schemas: validateEditOp / validateMeshOptions
// are the real (tolerant, always-current) gates — duplicating the 44-kind op
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
  // No inputSchema means the SDK calls this with a single `extra` arg (no
  // `args`), an arity `wrap()` doesn't model (it always expects `(args,
  // onProgress)`) — and describe_capabilities is instant/pure, so a
  // progress callback would be meaningless here anyway. Inline instead.
  async () => ({ content: [{ type: "text" as const, text: JSON.stringify(describeCapabilities(), null, 2) }] })
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
  "inspect",
  {
    description:
      "Facts only (see describe_capabilities' verdictConventions): bounding box, bbox-center (NOT the mass centroid — use get_mass_properties for that), area/length, and — for a planar face — its normal and surface type, for one entity id. B-rep sources only headless.",
    inputSchema: {
      path: modelPath,
      entityId: z.string().describe("solid-N / face-N / edge-N / point-N id from load_model's inventory"),
    },
  },
  wrap((args: { path: string; entityId: string }) => inspectEntity(ctx, args))
);

server.registerTool(
  "measure",
  {
    description:
      "Facts only: straight-line distance between two entities' bbox centers, plus (if `axis` is given) the signed component of that displacement along it — 'is this hole 25mm from that edge' class questions. B-rep sources only headless.",
    inputSchema: {
      path: modelPath,
      from: z.string().describe("solid-N / face-N / edge-N / point-N id"),
      to: z.string().describe("solid-N / face-N / edge-N / point-N id"),
      axis: z
        .tuple([z.number(), z.number(), z.number()])
        .optional()
        .describe("Direction vector for the signed axis component; need not be unit length"),
    },
  },
  wrap((args: { path: string; from: string; to: string; axis?: [number, number, number] }) => measureTool(ctx, args))
);

server.registerTool(
  "measure_exact",
  {
    description:
      "Exact B-rep-precision measurement via live OCCT geometry (BRepExtrema_DistShapeShape for distance, BRepGProp for edge length, the edge's own curve for radius) — not an approximation, unlike `measure`'s bbox-centre distance or the interactive viewer's triangulated Measure tool. kind='distance' needs entityIdB (any entity combination: point/edge/face/solid) and returns the true nearest points found, not either entity's centre. kind='edgeLength' needs entityIdA to be an edge. kind='radius' needs entityIdA to be a circular edge (throws a clear error otherwise — never a meaningless best-fit number). B-rep sources only headless.",
    inputSchema: {
      path: modelPath,
      kind: z.enum(["distance", "edgeLength", "radius"]),
      entityIdA: z.string().describe("solid-N / face-N / edge-N / point-N id"),
      entityIdB: z.string().optional().describe("solid-N / face-N / edge-N / point-N id — required for kind='distance'"),
    },
  },
  wrap((args: { path: string; kind: "distance" | "edgeLength" | "radius"; entityIdA: string; entityIdB?: string }) =>
    measureExactTool(ctx, args)
  )
);

server.registerTool(
  "check_interference",
  {
    description:
      "Interference / clash detection: reports the overlap volume (if any) between two operands via a real BRepAlgoAPI_Common_3 intersection — read-only, never mutates the model. Each operand is EITHER a list of solid-N ids (a/b, multiple ids are compounded together, same as the boolean edit op's own a/b) OR a Part name (partA/partB, resolved to that Part's own assigned volumes) — give exactly one of the two per operand. hasOverlap is true only for a genuine, non-degenerate volume overlap (two solids merely touching at a face/edge/point report hasOverlap:false). B-rep sources only headless.",
    inputSchema: {
      path: modelPath,
      a: z.array(z.string()).optional().describe("Operand A: solid-N id(s), compounded together if more than one"),
      b: z.array(z.string()).optional().describe("Operand B: solid-N id(s), compounded together if more than one"),
      partA: z.string().optional().describe("Operand A: a Part name, resolved to its assigned volumes (mutually exclusive with 'a')"),
      partB: z.string().optional().describe("Operand B: a Part name, resolved to its assigned volumes (mutually exclusive with 'b')"),
    },
  },
  wrap((args: { path: string; a?: string[]; b?: string[]; partA?: string; partB?: string }) => checkInterferenceTool(ctx, args))
);

server.registerTool(
  "render_snapshot",
  {
    description:
      "Facts only, via images (see describe_capabilities' verdictConventions): 4 labelled PNGs (two opposed isometrics + top + front) of the current model with sidecar edits replayed, exactly as load_model sees it. Visual review is diagnostic, not authoritative — convert any concern into an inspect/measure check before treating it as validated; don't loop on repeated snapshots, only re-render after a change to visible geometry. REQUIRES Playwright + a Chromium binary in this environment (`npx playwright install chromium`) — call it and check `supported`; not guaranteed available everywhere (see doc/mcp-server.md). B-rep sources only.",
    inputSchema: {
      path: modelPath,
      focus: z.array(z.string()).optional().describe("Entity ids — isolate the view to only these"),
      hide: z.array(z.string()).optional().describe("Entity ids — force-hide these"),
      displayMode: z.enum(["shaded", "wireframe"]).optional().describe("Applies to the whole 4-image packet"),
    },
  },
  wrap(
    (args: { path: string; focus?: string[]; hide?: string[]; displayMode?: "shaded" | "wireframe" }) =>
      renderSnapshotTool(ctx, args)
  )
);

server.registerTool(
  "search_standard_parts",
  {
    description:
      "Facts only (see describe_capabilities' verdictConventions): faceted search over the hosted step.parts catalog (fasteners, bearings, connectors, extrusions, ...) — off-the-shelf STEP parts. A network/API failure returns supported:false and is INCONCLUSIVE, never \"no matching parts\" — don't report a part as unavailable unless the API was reachable and returned zero candidates. Each result carries pageUrl/apiUrl/stepUrl/sha256 for provenance.",
    inputSchema: {
      q: z.string().optional().describe("Fuzzy text search across name/description/tags/attributes"),
      tag: z.array(z.string()).optional().describe("Repeatable tag filter (OR within, AND across filter types)"),
      category: z.array(z.string()).optional().describe("Repeatable category filter"),
      family: z.array(z.string()).optional().describe("Repeatable family filter"),
      standard: z.array(z.string()).optional().describe("Repeatable standard-designation filter (e.g. ISO 4017)"),
      page: z.number().int().min(1).optional().describe("1-based page number, default 1"),
      pageSize: z.number().int().min(1).max(500).optional().describe("Results per page, default 100, max 500"),
    },
  },
  wrap(
    (args: {
      q?: string;
      tag?: string[];
      category?: string[];
      family?: string[];
      standard?: string[];
      page?: number;
      pageSize?: number;
    }) => searchStandardPartsTool(ctx, args)
  )
);

server.registerTool(
  "download_standard_part",
  {
    description:
      "Downloads one step.parts part's STEP file to outputPath, verifying it against the part record's sha256 when one is on record (see the returned verifiedChecksum/sha256 fields). The result is an ordinary STEP file the existing pipeline opens normally — no new format support needed. supported:false on any network failure (inconclusive, not \"part unavailable\") — see describe_capabilities' verdictConventions.",
    inputSchema: {
      id: z.string().describe("Part id from search_standard_parts' results"),
      outputPath: z.string().describe("Destination .step/.stp file path"),
    },
  },
  wrap((args: { id: string; outputPath: string }) => downloadStandardPartTool(ctx, args))
);

server.registerTool(
  "compare_models",
  {
    description:
      "Diff two models solid-by-solid, matched by bounding-box-centroid proximity + volume similarity — reports added/removed/matched solids, with each match's raw centre displacement and volume delta (never a black-box moved/unchanged verdict) so you can judge match confidence yourself. STEP/IGES/BREP (edits baked in) and STL/OBJ/PLY (raw file bytes, edits NOT baked in) are supported headless, in any combination; glTF and meshio-only formats return supported: false. Optional includeSnapshots (default false) additionally renders each B-rep side's whole-model before/after PNGs (render_snapshot's own DEFAULT_VIEWS engine) as image content blocks — costs up to two headless browser launches and up to 8 images, opt in only when you actually want to look at the geometry.",
    inputSchema: { pathA: modelPath, pathB: modelPath, includeSnapshots: z.boolean().optional().describe("Also render before/after PNG snapshots for any B-rep side (default false)") },
  },
  wrap((args: { pathA: string; pathB: string; includeSnapshots?: boolean }) => compareModelsTool(ctx, args))
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
  "run_parametric_script",
  {
    description:
      "Compiles a declarative parametric script into ops and appends them via the same path as apply_edit_ops — NOT a general scripting language (no code execution, no I/O). script = {variables?: [{name,expr}], steps: [...]}, each step exactly one of: {op: <EditOp>} (identical to one apply_edit_ops entry, exprs stay live) or {repeat: {times: number|expr, indexVar: string, body: [<EditOp>, ...]}} (expands body `times` times, indexVar bound to the 0-based iteration; body ops' exprs may reference indexVar/document variables/script variables via the same expression syntax set_variables uses, e.g. a bolt circle: exprs:{\"center[0]\":\"R*cos(i*360/N)\",\"center[1]\":\"R*sin(i*360/N)\"} — repeat-generated ops are fully baked to concrete numbers on output, exprs stripped). Returns a per-step accept/reject report and, for B-rep sources, the post-replay entity inventory. Use dryRun to compile/validate without persisting. See describe_capabilities.",
    inputSchema: {
      path: modelPath,
      script: z.looseObject({}).describe("{variables?: [{name,expr}], steps: [{op:...} | {repeat:{times,indexVar,body}}]}"),
      dryRun: z.boolean().optional(),
    },
  },
  wrap((args: { path: string; script: Record<string, unknown>; dryRun?: boolean }) => runParametricScriptTool(ctx, args))
);

server.registerTool(
  "remove_edit_op",
  {
    description:
      "Remove one op from anywhere in the stack by 0-based index (like the panel's per-row ✕). For a B-rep source with Parts, attempts the same best-effort entity-id rebinding apply_edit_ops gets (a removed topology-changing op re-tessellates everything after it) — reported in warnings.",
    inputSchema: { path: modelPath, index: z.number().int().describe("0-based index into the op stack") },
  },
  wrap((args: { path: string; index: number }) => removeEditOp(ctx, args))
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
      "Generate a finite-element mesh of the model with Gmsh (edits baked in for B-rep sources; raw file bytes for .stl) and return statistics only (node/element counts, per-part element groups, timing, a minSICN quality summary, and — for a 3D mesh with elements scoring below 0.2 — a worstElements count). Nothing is written to disk — use export_mesh for that. Emits notifications/progress at start and completion if you set _meta.progressToken — Gmsh itself has no mid-call progress hook, so this is start/done signaling only, not a genuine percentage.",
    inputSchema: { path: modelPath, options: meshOptionsOverride },
  },
  wrap((args: { path: string; options?: Record<string, unknown> }, onProgress) =>
    generateMeshTool(ctx, { path: args.path, options: args.options as Partial<MeshOptions> | undefined }, onProgress)
  )
);

server.registerTool(
  "export_mesh",
  {
    description:
      "Generate a mesh and write it to outputPath in the given format (format ids from describe_capabilities: mdpaElements, mdpaGeometries, msh, msh2, geoUnrolled, vtk, unv, inp, bdf, su2, mesh, stl, diff, off). geoUnrolled also writes a required .xao companion beside the output for B-rep sources. Optional unit (mm|cm|m|in|ft, default mm) applies a real geometric scale to the meshed geometry BEFORE Gmsh ever sees it (mirroring export_brep's unit param), with sizeMin/sizeMax and any per-part meshSize proportionally rescaled to match — generate_mesh (and the interactive Generate button) always stay native mm; this only affects export_mesh's written file. Emits notifications/progress at start and completion if you set _meta.progressToken (start/done only — see generate_mesh's note).",
    inputSchema: {
      path: modelPath,
      format: z.string().describe("Mesh export format id"),
      outputPath: z.string().describe("Destination file path (must not be the CAD source)"),
      options: meshOptionsOverride,
      unit: z.string().optional().describe("Export unit: mm | cm | m | in | ft (default mm, no conversion)"),
    },
  },
  wrap(
    (
      args: { path: string; format: string; outputPath: string; options?: Record<string, unknown>; unit?: string },
      onProgress
    ) => exportMeshTool(ctx, { ...args, options: args.options as Partial<MeshOptions> | undefined }, onProgress)
  )
);

server.registerTool(
  "export_brep",
  {
    description:
      "Export a B-rep source to another B-rep format (step/iges/brep, excluding the source's own format) with all sidecar edits baked in, written to outputPath. Mesh-format targets (STL/OBJ/PLY/glTF) are webview-only and unavailable headless. Optional unit (mm|cm|m|in|ft, default mm) applies a real geometric scale to the exported file's coordinates and, for step/iges targets, correctly relabels the file's own declared header unit to match — this is unit CONVERSION, not the source's own declared unit; the live model and every other tool always stay in mm regardless of this parameter.",
    inputSchema: {
      path: modelPath,
      targetFormat: z.string().describe("step | iges | brep"),
      outputPath: z.string().describe("Destination file path (must not be the CAD source)"),
      unit: z.string().optional().describe("Export unit: mm | cm | m | in | ft (default mm, no conversion)"),
    },
  },
  wrap((args: { path: string; targetFormat: string; outputPath: string; unit?: string }) => exportBRepTool(ctx, args))
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
