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
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createKernelClient } from "./kernelClient";
import {
  describeCapabilities,
  OP_PARAM_DOCS,
  allOpKinds,
  loadModel,
  getMassProperties,
  generateBomTool,
  inspectEntity,
  measureTool,
  measureExactTool,
  checkToleranceTool,
  checkInterferenceTool,
  checkInterferenceAllTool,
  renderSnapshotTool,
  renderOpsPrefixTool,
  hitTestTool,
  screenshotShapeTool,
  type SnapshotView,
  listParametricScripts,
  listStandardHoleSizes,
  listWorkspaceModels,
  searchStandardPartsTool,
  downloadStandardPartTool,
  compareModelsTool,
  checkMeshHealthTool,
  recognizePrimitivesTool,
  transformMeshTool,
  promoteMeshToBrepTool,
  repairMeshTool,
  exportSvgSilhouetteTool,
  exportTechnicalDrawingTool,
  getState,
  applyEditOps,
  runParametricScriptTool,
  removeEditOp,
  runSavedScript,
  saveParametricScript,
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
import { HOLE_STANDARDS } from "./holeStandards";
import { NAMED_VIEW_NAMES } from "./viewDirections";
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

const INSTRUCTIONS = [
  "CAD-Preview — headless CAD modeling via sidecar-persisted edit ops.",
  "Every path/outputPath is absolute. The CAD source file is never written — edits, parts, annotations and mesh options live in sidecars next to it (<model>.edits.json etc.) and are replayed on open in VS Code.",
  "Tools report facts (numbers, entity inventories, images, warnings) — you render the verdict. A supported:false response or a tool/network failure is need-more-info, never a silent pass or fail.",
  "Call describe_capabilities first (or read cad-preview://capabilities) for the full op catalog with per-kind parameter docs, B-rep-only/topology-changing flags, entity-id scheme and headless limitations. Prefer the resource if your client auto-attaches it. Pass ops as raw JSON with an op kind field — they are validated by the same tolerant gate the extension uses.",
  "render_snapshot images (and compare_models includeSnapshots ones) are diagnostic, not authoritative — convert a visual concern into an inspect/measure check before treating anything as validated.",
].join(" ");

const server = new McpServer({ name: "cad-preview", version: "1.0.0" }, { instructions: INSTRUCTIONS });

server.registerResource(
  "capabilities",
  "cad-preview://capabilities",
  {
    title: "CAD-Preview capabilities",
    description: "Full op catalog with per-kind parameter docs, entity-id scheme and headless limitations. Same content as the describe_capabilities tool, same source.",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(describeCapabilities(), null, 2) }],
  })
);

server.registerResource(
  "op",
  new ResourceTemplate("cad-preview://op/{kind}", {
    list: async () => ({
      resources: allOpKinds().map((kind) => ({
        uri: `cad-preview://op/${kind}`,
        name: kind,
        description: OP_PARAM_DOCS[kind as keyof typeof OP_PARAM_DOCS] ?? kind,
        mimeType: "application/json",
      })),
    }),
  }),
  {
    title: "CAD-Preview op",
    description: "Parameters for one EditOp kind. Same source as describe_capabilities.",
    mimeType: "application/json",
  },
  async (uri, { kind }) => {
    const caps = describeCapabilities();
    const op = (caps.ops as Array<{ op: string }>).find((o) => o.op === kind);
    if (!op) throw new Error(`Unknown op kind: ${kind} (see cad-preview://capabilities for the full catalog)`);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(op, null, 2) }] };
  }
);

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
  "generate_bom",
  {
    description:
      "One bill-of-materials row per Part: name, entity counts, and volume/area (SUM of member solids' individual volumes — sum-of-parts procurement convention, NOT a combined-solid volume; overlapping members count their overlap twice). Also returns `bom`, a ready-to-paste tab-separated string with a header row for spreadsheet handoff. Facts only — unresolvable ids are reported per row (unresolvedIds) and in warnings, never silently dropped; an empty parts sidecar returns zero rows with a warning. Read-only. B-rep sources only headless.",
    inputSchema: { path: modelPath },
  },
  wrap((args: { path: string }) => generateBomTool(ctx, args))
);

server.registerTool(
  "inspect",
  {
    description:
      "Facts only (see describe_capabilities' verdictConventions): bounding box, bbox-center (NOT the mass centroid — use get_mass_properties for that), area/length, surface/curve classification, and the underlying ANALYTIC PARAMETERS for one entity id — a cylinder's radius and axis, a cone's half-angle (degrees, signed: positive means the radius grows along the axis) with its apex and reference radius, a sphere's centre and radius, a torus's major/minor radii. Points and directions are in world coordinates, lengths in the file's own units. `surfaceParams.axisLocation` is a point ON the axis, not the face's centre and not necessarily within its extent — use bbox/center for where the face is. B-rep sources only headless.",
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
      "Exact B-rep-precision measurement via live OCCT geometry (BRepExtrema_DistShapeShape for distance, BRepGProp for edge length, the edge's own curve for radius) — not an approximation, unlike `measure`'s bbox-centre distance or the interactive viewer's triangulated Measure tool. kind='distance' needs entityIdB (any entity combination: point/edge/face/solid) and returns the true minimum distance plus the realizing points where it lands, centreDistance (bbox-centre-to-bbox-centre, what `measure` reports), and — for two planar faces — angleDeg between their normals and parallelDistance (perpendicular plane-to-plane gap) when the planes are parallel; `primary` names which value most likely answers 'how far apart are these' for that pair ('parallel' for two parallel planar faces, else 'min') — a fact about which quantity fits the geometry, never a judgment of it. There is NO maximum-distance field: probed and genuinely unavailable in this WASM build. kind='edgeLength' needs entityIdA to be an edge. kind='radius' needs entityIdA to be a circular edge (throws a clear error otherwise — never a meaningless best-fit number). B-rep sources only headless.",
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
  "check_tolerance",
  {
    description:
      "Tolerance-band fact check on top of an exact measurement: runs the SAME exact measurement measure_exact performs (B-rep precision, same kind/entityId rules), then reports the measured value alongside deviation = measured − nominal and withinTolerance (true when −toleranceMinus ≤ deviation ≤ tolerancePlus). toleranceMinus defaults to tolerancePlus (symmetric ±) when omitted. withinTolerance is a FACT about where the value sits relative to the band you supplied — never a pass/fail verdict; you render the judgment. No new geometry is computed and nothing is persisted.",
    inputSchema: {
      path: modelPath,
      kind: z.enum(["distance", "edgeLength", "radius"]),
      entityIdA: z.string().describe("solid-N / face-N / edge-N / point-N id"),
      entityIdB: z.string().optional().describe("solid-N / face-N / edge-N / point-N id — required for kind='distance'"),
      nominal: z.number().describe("Nominal (target) value, same unit as the measurement (mm for distance/edgeLength/radius)"),
      tolerancePlus: z.number().describe("Allowed deviation above nominal (≥ 0)"),
      toleranceMinus: z
        .number()
        .optional()
        .describe("Allowed deviation below nominal (≥ 0); omitted = symmetric ± with tolerancePlus"),
    },
  },
  wrap((args: { path: string; kind: "distance" | "edgeLength" | "radius"; entityIdA: string; entityIdB?: string; nominal: number; tolerancePlus: number; toleranceMinus?: number }) =>
    checkToleranceTool(ctx, args)
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
  "check_interference_all",
  {
    description:
      "Facts only (see describe_capabilities' verdictConventions): assembly-wide interference check — runs the same exact BRepAlgoAPI_Common_3 overlap test over EVERY pair of Parts in one call, with a cheap bounding-box pre-filter (strictly-disjoint pairs are reported without paying for a boolean; screenedByBbox:true marks those). Each row: {partA, partB, hasOverlap, overlapVolume} plus unresolved id lists. parts omitted = every Part in the sidecar; unknown/empty parts are skipped with warnings. hasOverlap is only true for a genuine non-degenerate volume overlap (merely-touching solids report false). Cost is O(n^2) pairs worst case. Read-only, never mutates the model. B-rep sources only headless.",
    inputSchema: {
      path: modelPath,
      parts: z.array(z.string()).optional().describe("Part names to compare pairwise (default: every Part in the sidecar)"),
    },
  },
  wrap((args: { path: string; parts?: string[] }) => checkInterferenceAllTool(ctx, args))
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
      view: z
        .discriminatedUnion("kind", [
          z.object({ kind: z.literal("named"), name: z.string().describe(`One of: ${NAMED_VIEW_NAMES.join(", ")} (or the aliases iso/iso-a/iso-b)`) }),
          z.object({ kind: z.literal("current") }),
          z.object({ kind: z.literal("orbit-from-current"), azimuthDeg: z.number(), elevationDeg: z.number() }),
          z.object({
            kind: z.literal("look-from"),
            direction: z.tuple([z.number(), z.number(), z.number()]).describe("Target -> camera; need not be normalized"),
            up: z.tuple([z.number(), z.number(), z.number()]).optional(),
          }),
        ])
        .optional()
        .describe(
          "ONE camera instead of the default 4-view packet. `current`/`orbit-from-current` read the view state you left the interactive viewer in — that sidecar stores an orientation, not a pose, so `current` means the same direction re-framed on the model. Unknown names and a missing view state warn and fall back to the default packet. Omit for the default 4 views."
        ),
      composite: z
        .boolean()
        .optional()
        .describe("Stitch the views into ONE labelled grid image instead of returning them separately — same total pixels as a single view, so it costs one image's worth of attention rather than four."),
    },
  },
  wrap(
    (args: {
      path: string;
      focus?: string[];
      hide?: string[];
      displayMode?: "shaded" | "wireframe";
      view?: SnapshotView;
      composite?: boolean;
    }) => renderSnapshotTool(ctx, args)
  )
);

server.registerTool(
  "render_ops_prefix",
  {
    description:
      "Render the model AS OF op N — read-only bisection for 'the finished model is wrong and I don't know which step broke it'. Replays only ops[0..throughIndex] (0-based, inclusive; -1 = the base shape before any op) through the same stateless pipeline load_model uses and returns that prefix's entity inventory; PERSISTS NOTHING (the sidecar op stack is untouched). Optional render:true adds render_snapshot's 4-view PNG packet of the PREFIX model as image content blocks (same Playwright/Chromium prerequisite and supported:false degradation). Workflow: snapshot the middle index, look, halve again — two or three snapshots localize the culprit faster than re-reading the whole op list. Each prefix length pays a full replay (no incremental reuse across differing lengths), so this is a click-to-jump tool, not a scrubber. B-rep sources only headless.",
    inputSchema: {
      path: modelPath,
      throughIndex: z
        .number()
        .int()
        .describe("Last applied op to include, 0-based (-1 = base shape with no ops applied)"),
      render: z.boolean().optional().describe("Also render the prefix model's 4-view PNG packet (default false)"),
    },
  },
  wrap((args: { path: string; throughIndex: number; render?: boolean }) => renderOpsPrefixTool(ctx, args))
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
  "transform_mesh",
  {
    description:
      "Run a declarative list of meshio++ mesh operations over a meshio-readable source and write the result to a new file. ONE tool for the whole family rather than one per operation (the same shape run_parametric_script uses): pass `ops` as an ordered array of {op, ...params} and get a per-step report back saying which steps actually did something. Operations: clean (weld/drop degenerate+duplicate cells), decimate (quadric edge-collapse; `ratio` = fraction of faces to KEEP, surface meshes only), smooth (`method` taubin|laplacian, `iterations`), subdivide, refine (`levels`), agglomerate (`targetGroupSize`), convertCells (`mode` linearize|simplexify|elevate — simplexify splits quads/hexes into triangles/tets). A step that cannot run is reported with applied:false and its reason, and the pipeline continues. The CAD source is never modified. B-rep and mesh-parser (stl/obj/ply/gltf) sources return supported:false — a B-rep has exact geometry and should be edited with apply_edit_ops instead.",
    inputSchema: {
      path: modelPath,
      ops: z
        .array(z.record(z.string(), z.unknown()))
        .describe('Ordered operations, e.g. [{"op":"clean"},{"op":"decimate","ratio":0.25}]'),
      outputPath: z.string().describe("Destination file path; its extension selects the output format"),
    },
  },
  wrap((args: { path: string; ops: unknown[]; outputPath: string }) => transformMeshTool(ctx, args))
);

server.registerTool(
  "check_mesh_health",
  {
    description:
      "Mesh -> B-rep promotion, diagnostic-first (Phase 1: read-only report, no promotion). For an STL/OBJ/PLY/glTF source, reports per connected component: free/non-manifold edge counts, degenerate face count, the BRepBuilderAPI_Sewing tolerance-ladder rung actually required to close the shape into a solid (null if it never closed even at the loosest rung), and the resulting healed area/volume delta vs. the raw mesh. Never mutates or persists anything, and there is still no path from a triangle mesh into fillet/chamfer/measure_exact/get_mass_properties/export_brep (BREP_ONLY_OPS unchanged) — a null requiredTolerance or a large volumeDeltaPct/areaDeltaPct is a fact for you to judge, not a computed pass/fail. B-rep sources return supported:false (nothing to heal); meshio-only formats return supported:false (no host-side triangle-soup parser). Refuses a mesh above 50000 triangles with an actionable error (it builds one OCCT face per triangle) -- most likely to bite on glTF, a rendering format whose files are routinely far larger than hand-authored STL/OBJ/PLY.",
    inputSchema: { path: modelPath },
  },
  wrap((args: { path: string }) => checkMeshHealthTool(ctx, args))
);

server.registerTool(
  "recognize_primitives",
  {
    description:
      "Per-solid primitive recognition, FACTS ONLY (see describe_capabilities' verdictConventions): for each solid, the face inventory by surface type, a candidate primitive (box/sphere/cylinder/cone/torus) when the inventory matches a signature exactly, and the FIT RESIDUAL — the largest deviation between the solid's real tessellated boundary and that idealized primitive, in the file's units, plus `fitResidualFrac` as a fraction of the solid's bbox diagonal. A candidate is a HYPOTHESIS, not a verdict: a small residual means the solid closely resembles that primitive; you decide whether it IS one. `candidate: null` means no signature matched (a filleted box has an extra face, so it is honestly not a box) — the inventory is still reported and is useful on its own. Emits no ops and changes nothing. B-rep sources only headless: a mesh source has no analytic surface to classify.",
    inputSchema: { path: modelPath },
  },
  wrap((args: { path: string }) => recognizePrimitivesTool(ctx, args))
);

server.registerTool(
  "promote_mesh_to_brep",
  {
    description:
      "Mesh -> B-rep promotion, Phase 2: sews a healed STL/OBJ/PLY/glTF mesh into a brand-new STEP/IGES/BREP file at outputPath (default targetFormat 'step') via the same writer pipeline export_brep uses. This is a ONE-SHOT EXPORT, not an in-place reclassification -- the original mesh source is left completely untouched; the written file is an ordinary, fully-editable B-rep document from the moment it exists (fillet/chamfer/measure_exact/get_mass_properties/further export_brep all just work on it -- open it with load_model to confirm). A component that never closes (even at the loosest sewing tolerance) is skipped and reported in skippedComponents/warnings, never silently dropped or forced into an invalid solid; if NO component closes, the call fails -- run check_mesh_health first to see why. Never requires a prior check_mesh_health call (fully standalone), but running one first is recommended. Optional unit (mm/cm/m/in/ft, default mm) applies the same real geometric scale export_brep's unit param does. B-rep sources return an error (nothing to promote); meshio-only formats return an error (no host-side triangle-soup parser).",
    inputSchema: {
      path: modelPath,
      outputPath: z.string().describe("Absolute path to write the new B-rep file to (must not be the source path)"),
      targetFormat: z.enum(["step", "iges", "brep"]).optional().describe("Output format (default: step)"),
      unit: z.string().optional().describe("Export unit: mm | cm | m | in | ft (default mm, no conversion)"),
    },
  },
  wrap((args: { path: string; outputPath: string; targetFormat?: string; unit?: string }) => promoteMeshToBrepTool(ctx, args))
);

server.registerTool(
  "repair_mesh",
  {
    description:
      "Repairs a dirty STL/OBJ/PLY/glTF mesh (holes, self-intersections, non-manifold edges -- exactly what check_mesh_health diagnoses) into a NEW watertight STL file at outputPath, via fTetWild: tetrahedralizes the mesh, then takes the resulting volume mesh's own boundary -- watertight and manifold BY CONSTRUCTION regardless of how broken the input was, since fTetWild is built specifically to survive that input class where Gmsh's own classifySurfaces path throws or silently produces no elements (see generate_mesh's engine:'ftetwild' option). This is a ONE-SHOT EXPORT, not an in-place reclassification -- the original mesh source is left completely untouched. The natural next step is re-running check_mesh_health or promote_mesh_to_brep on the repaired output, which now typically closes where the original could not. B-rep sources return an error (nothing to repair); meshio-only formats return an error (no host-side triangle-soup parser). No triangle-count ceiling is imposed (unlike check_mesh_health/promote_mesh_to_brep's 50000-triangle cap, a property of their different, per-triangle OCCT sewing approach) -- a very large or very slow mesh may hit this server's own per-call timeout instead.",
    inputSchema: {
      path: modelPath,
      outputPath: z.string().describe("Absolute path to write the repaired STL file to (must not be the source path)"),
    },
  },
  wrap((args: { path: string; outputPath: string }) => repairMeshTool(ctx, args))
);

server.registerTool(
  "export_technical_drawing",
  {
    description:
      "Write a 2D TECHNICAL DRAWING to .svg or .dxf: feature edges with hidden-line removal — visible runs solid, occluded runs dashed (SVG) or on a HIDDEN layer (DXF). Unlike export_svg_silhouette, which draws an outline only, this also draws interior feature edges and shows what is behind them. Single orthographic view, no dimensions. Works for B-rep AND mesh sources: the visibility test runs on tessellated triangles and calls no OCCT hidden-line API (that family is unavailable in this build), so it is not limited to B-rep. Treat it as a review/illustration artifact — use measure/measure_exact for any dimension you need to be sure of.",
    inputSchema: {
      path: modelPath,
      outputPath: z.string().describe("Absolute path to write (.svg or .dxf)"),
      view: z.string().optional().describe(`Named view: ${NAMED_VIEW_NAMES.join(", ")}. Unknown names warn and fall back to FRONT.`),
      direction: z.tuple([z.number(), z.number(), z.number()]).optional().describe("Explicit view direction (model → camera); wins over `view`"),
      up: z.tuple([z.number(), z.number(), z.number()]).optional(),
      unit: z.string().optional().describe("Output unit (mm/cm/m/in/ft); a real coordinate scale, default mm"),
      strokeWidth: z.number().optional(),
      tessellationQuality: z.string().optional().describe('B-rep only: draft/standard/fine. Default "fine" — the drawing IS the tessellation, and a coarser one also raises the angle below which a face join reads as tangent.'),
      creaseAngleDeg: z
        .number()
        .optional()
        .describe("Mesh sources only: dihedral angle above which an interior edge is drawn. Default 35°, chosen to clear a coarse STL cylinder's own facet angle. Too low turns the drawing into a wireframe (which is warned about)."),
      format: z.enum(["svg", "dxf"]).optional(),
    },
  },
  wrap(
    (args: {
      path: string;
      outputPath: string;
      view?: string;
      direction?: [number, number, number];
      up?: [number, number, number];
      unit?: string;
      strokeWidth?: number;
      tessellationQuality?: string;
      creaseAngleDeg?: number;
      format?: "svg" | "dxf";
    }) => exportTechnicalDrawingTool(ctx, args)
  )
);

server.registerTool(
  "export_svg_silhouette",
  {
    description:
      "Write a 2D OUTLINE (silhouette) of a model to an .svg or .dxf file. OUTLINE ONLY -- there is NO hidden-line removal here (use export_technical_drawing for that), so this is NOT a dimensioned 2D technical drawing: back-facing geometry is not drawn, but neither are interior feature edges that don't lie on a silhouette. (OCCT's hidden-line machinery is entirely unavailable in this WASM build; HLRAppli_ReflectLines was probed and produced a strictly worse drawing.) Supports every source with host-side geometry: STEP/IGES/BREP (edits baked in, outline derived from the tessellation) and STL/OBJ/PLY/glTF (raw file bytes, edits NOT baked in); meshio-only formats return an error. Pick a named view (FRONT/BACK/TOP/BOTTOM/LEFT/RIGHT/ISO, matching render_snapshot's directions) or pass an explicit direction vector. 1 output unit = 1 model unit, so the output prints 1:1; the optional unit param (mm/cm/m/in/ft) applies the same real geometric scale export_brep's does. Output format is \"svg\" (default) or \"dxf\" — DXF chains silhouette segments into LWPOLYLINEs (with bulges for arcs where detected) plus singleton LINEs.",
    inputSchema: {
      path: modelPath,
      outputPath: z.string().describe("Absolute path to write the .svg/.dxf to (must not be the source path)"),
      view: z.string().optional().describe("Named view: FRONT | BACK | TOP | BOTTOM | LEFT | RIGHT | ISO (default FRONT)"),
      direction: z.array(z.number()).optional().describe("Explicit view direction [x,y,z] (model -> camera); overrides view"),
      up: z.array(z.number()).optional().describe("Explicit up vector [x,y,z]"),
      unit: z.string().optional().describe("Output unit: mm | cm | m | in | ft (default mm, no conversion)"),
      strokeWidth: z.number().optional().describe("SVG only: stroke width in output units (default: proportional to the drawing's size)"),
      tessellationQuality: z.string().optional().describe("B-rep sources only: draft | standard | fine (default fine)"),
      format: z.enum(["svg", "dxf"]).optional().describe("Output format: svg (default) or dxf"),
    },
  },
  wrap((args: { path: string; outputPath: string; view?: string; direction?: number[]; up?: number[]; unit?: string; strokeWidth?: number; tessellationQuality?: string; format?: string }) =>
    exportSvgSilhouetteTool(ctx, args)
  )
);

server.registerTool(
  "list_workspace_models",
  {
    description:
      "Stateless discovery: given a folder, return every CAD file routeFile() recognizes beneath it (depth-capped walk; .git and node_modules are never scanned), each with its detected format/strategy and which companion sidecars (.edits.json/.parts.json/.annotations.json/.mesh.json/.view.json/.geo) currently exist beside it. Caps are reported via truncated + warnings — the list is never quietly partial. Purely additive over load_model's own routing rules: use it to discover what's in a project before calling explicit-path tools; every other tool stays fully path-explicit (this server has no open-document state).",
    inputSchema: {
      root: z.string().describe("Absolute path to the folder to scan"),
    },
  },
  wrap((args: { root: string }) => listWorkspaceModels(args))
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

const libraryPath = z.string().describe("Absolute path to the script-library JSON file (you name it; it is created on first save)");

server.registerTool(
  "save_parametric_script",
  {
    description:
      "Save a named, parameterized script to a reusable library file so you don't re-derive the same bolt-pattern logic every session. The script is the exact same {variables?, steps} document run_parametric_script takes, and its own `variables` block IS its parameter list — there is no separate parameter schema. REFUSES to save a script that compiles to no ops, so a broken macro never enters the library silently. Pass overwrite:true to replace an existing name. Touches no model and no geometry.",
    inputSchema: {
      libraryPath,
      name: z.string().describe("Unique name within the library; how run_saved_script refers to it"),
      script: z.looseObject({}).describe("{variables?: [{name, expr}], steps: [...]} — identical to run_parametric_script's `script`"),
      description: z.string().optional().describe("Free text shown by list_parametric_scripts"),
      overwrite: z.boolean().optional().describe("Replace an existing script of the same name (default false: a name collision is an error)"),
    },
  },
  wrap((args: { libraryPath: string; name: string; script: Record<string, unknown>; description?: string; overwrite?: boolean }) =>
    saveParametricScript(args)
  )
);

server.registerTool(
  "list_parametric_scripts",
  {
    description:
      "List the saved scripts in a library file with their descriptions and declared parameters (name + default expression), so you can discover what is available without reading the raw JSON. A missing or empty library reads as empty with a warning, never an error.",
    inputSchema: { libraryPath },
  },
  wrap((args: { libraryPath: string }) => listParametricScripts(args))
);

server.registerTool(
  "run_saved_script",
  {
    description:
      "Run a saved script from a library against a model, optionally overriding its declared parameters by name (e.g. {radius: 30, count: 8}). Goes through the exact same compile/validate/bake/persist path as run_parametric_script — same B-rep-only op gate, same entity rebinding, same response — differing only in where the script came from. An override naming no declared parameter is warned about, not fatal.",
    inputSchema: {
      libraryPath,
      name: z.string().describe("The saved script's name, as reported by list_parametric_scripts"),
      path: modelPath,
      parameters: z
        .record(z.string(), z.union([z.number(), z.string()]))
        .optional()
        .describe("Per-parameter overrides by name; a number or an expression string. Unknown names are ignored with a warning."),
      dryRun: z.boolean().optional().describe("Compile and report without persisting"),
    },
  },
  wrap(
    (args: { libraryPath: string; name: string; path: string; parameters?: Record<string, number | string>; dryRun?: boolean }) =>
      runSavedScript(ctx, args)
  )
);

server.registerTool(
  "screenshot_shape",
  {
    description:
      "Photograph ONE entity, framed to fill the image — the usual next step after inspect returns something surprising. ISOLATES the entity by default: a face framed at its own scale otherwise puts the camera inside the parent solid, so the image would be interior geometry or an occluded face. Pass context:true to keep the whole model visible (warned, since the entity may then be hidden). Defaults to an isometric, because a planar face seen along its own plane is a line. Facts only, via images (see describe_capabilities' verdictConventions). Requires Playwright + Chromium; check `supported`. B-rep sources only.",
    inputSchema: {
      path: modelPath,
      entityId: z.string().describe("solid-N / face-N / edge-N / point-N, from load_model or inspect"),
      view: z
        .discriminatedUnion("kind", [
          z.object({ kind: z.literal("named"), name: z.string() }),
          z.object({ kind: z.literal("current") }),
          z.object({ kind: z.literal("orbit-from-current"), azimuthDeg: z.number(), elevationDeg: z.number() }),
          z.object({
            kind: z.literal("look-from"),
            direction: z.tuple([z.number(), z.number(), z.number()]),
            up: z.tuple([z.number(), z.number(), z.number()]).optional(),
          }),
        ])
        .optional()
        .describe("Camera to frame the entity from; defaults to an isometric"),
      context: z.boolean().optional().describe("Keep the whole model visible instead of isolating the entity"),
      displayMode: z.enum(["shaded", "wireframe"]).optional(),
    },
  },
  wrap(
    (args: {
      path: string;
      entityId: string;
      view?: SnapshotView;
      context?: boolean;
      displayMode?: "shaded" | "wireframe";
    }) => screenshotShapeTool(ctx, args)
  )
);

server.registerTool(
  "hit_test",
  {
    description:
      "Fire rays at the model and report which entity each one strikes, with the world-space hit point, the distance along the ray, and (for a face) its outward normal. The inverse of render_snapshot: use it to name the entity behind something you spotted in an image, or to answer 'what is directly above (x, y)?' by firing straight down. Pass MANY rays in one call — parsing and replaying the model dominates the cost and is paid once. Needs no browser, so unlike render_snapshot it never degrades to supported:false. B-rep sources only. Facts only (see describe_capabilities' verdictConventions).",
    inputSchema: {
      path: modelPath,
      rays: z
        .array(z.object({ origin: z.tuple([z.number(), z.number(), z.number()]), direction: z.tuple([z.number(), z.number(), z.number()]) }))
        .describe("Rays in world space; `direction` need not be normalized"),
      mode: z
        .enum(["volume", "surface", "line", "point", "any"])
        .optional()
        .describe('Which entity kind to report. "volume" resolves a face hit up to its owning solid. Default "any" (nearest of face/edge/point).'),
      focus: z.array(z.string()).optional().describe("Only these entity ids (or solid ids) are hittable"),
      hide: z.array(z.string()).optional().describe("These entity ids (or solid ids) are ignored — useful to see what is behind a face"),
      tolerance: z
        .number()
        .optional()
        .describe("How near a ray must pass an edge/point to hit it, in model units. Default: 1% of the model's bbox diagonal (faces need no tolerance)."),
    },
  },
  wrap(
    (args: {
      path: string;
      rays: { origin: [number, number, number]; direction: [number, number, number] }[];
      mode?: "volume" | "surface" | "line" | "point" | "any";
      focus?: string[];
      hide?: string[];
      tolerance?: number;
    }) => hitTestTool(ctx, args)
  )
);

server.registerTool(
  "list_standard_hole_sizes",
  {
    description:
      "Standard tapped/threaded hole sizes (ISO metric coarse/fine, Unified UNC/UNF) so you don't have to hard-code a pitch table. Facts only (see describe_capabilities' verdictConventions): each designation reports a tapDrillDiameter (for a hole that will be TAPPED with this thread) AND a clearanceDiameter (for a hole this size of bolt PASSES THROUGH) — which one applies depends on your intent, and this tool does not choose. Every diameter is in MILLIMETRES, imperial designations included, because mm is the unit every edit op consumes; *Radius fields are pre-halved to drop straight into addHole/addCounterboreHole/addCountersinkHole's `radius`. Omit both params to list everything. No model is read and no geometry is touched.",
    inputSchema: {
      standard: z
        .string()
        .optional()
        .describe(`One of: ${HOLE_STANDARDS.join(", ")}. Unrecognized values warn and list every standard.`),
      designation: z
        .string()
        .optional()
        .describe('A single size, e.g. "M6", "M10x1.25", "1/4-20" (case- and space-insensitive). Adds depthPresets for that size.'),
    },
  },
  wrap((args: { standard?: string; designation?: string }) => listStandardHoleSizes(args))
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
