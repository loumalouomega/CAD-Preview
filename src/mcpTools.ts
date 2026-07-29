/**
 * MCP tool handlers — the headless counterpart of `provider.ts`'s message
 * handlers, callable from the stdio server entry (`mcpServer.ts`) and from
 * unit tests. Deliberately MCP-SDK-free and WASM-free: everything OCCT/Gmsh
 * goes through the injected {@link Pipeline}, so vitest can exercise every
 * handler with fakes (the real `occtService`/`gmshService` `.wasm` imports
 * only resolve under esbuild's wasm-path plugin, never under vitest).
 * Only `import type` from those two modules is allowed here.
 *
 * State model: stateless per call. Every handler re-reads the model file +
 * sidecars fresh and writes sidecars back — the sidecars are the single
 * source of truth the VS Code extension already respects on reopen, and the
 * WASM modules are memoized module singletons, so statelessness costs one
 * file read. The CAD source file is never written (`assertNotSourcePath`).
 */
import * as fs from "fs/promises";
import * as path from "path";
import {
  validateEditOp,
  BREP_ONLY_OPS,
  TOPOLOGY_CHANGING_OPS,
  type EditOp,
  type EditOpKind,
} from "./editOps";
import { evaluateVariables, resolveEditOps, validateVariables, type ParamVariable } from "./editVariables";
import { routeFile, type CadFormat, type FileRoute } from "./fileRouter";
import { exportTargetsFor, EXPORT_EXTENSION } from "./exportTargets";
import {
  DEFAULT_MESH_OPTIONS,
  SIZE_MAX_SENTINEL,
  validateMeshOptions,
  applyStlPartSizeOverride,
  type MeshOptions,
} from "./meshOptions";
import { MESH_EXPORT_FORMATS, meshExportFormat } from "./meshExportFormats";
import { allCatalogEntries, describeOp } from "./webview/opCatalog";
import type { Part } from "./protocol";
import type { loadBRep, exportBRep, BRepResult } from "./occtService";
import type { computeMassProperties, MassProperties } from "./massProperties";
import type { compareModels } from "./modelDiffHost";
import type { ModelDiff } from "./modelDiff";
import type { convertToStlBoundary, exportViaMeshio } from "./meshioService";
import type {
  generateMesh,
  exportMeshFormat,
  exportMdpa,
  exportGeoUnrolled,
  MeshGenerationInput,
} from "./gmshService";
import {
  readEdits,
  writeEdits,
  readParts,
  writeParts,
  readMeshOptions,
  writeMeshOptions,
  assertNotSourcePath,
  editsSidecarPath,
  partsSidecarPath,
  meshOptionsSidecarPath,
  geoScriptPath,
} from "./mcpSidecars";
import { buildPreprocessZip, readPreprocessZip } from "./preprocessArchive";
import { parsePartsJson } from "./partsSidecar";
import { parseEditsJson } from "./editsSidecar";
import { parseMeshJson } from "./meshOptionsSidecar";

type BRepFormat = Extract<CadFormat, "step" | "iges" | "brep">;

/** The WASM-backed pipeline functions, injected so tests can fake them. */
export interface Pipeline {
  loadBRep: typeof loadBRep;
  exportBRep: typeof exportBRep;
  generateMesh: typeof generateMesh;
  exportMeshFormat: typeof exportMeshFormat;
  exportMdpa: typeof exportMdpa;
  exportGeoUnrolled: typeof exportGeoUnrolled;
  computeMassProperties: typeof computeMassProperties;
  compareModels: typeof compareModels;
  convertToStlBoundary: typeof convertToStlBoundary;
  exportViaMeshio: typeof exportViaMeshio;
}

export interface ToolContext {
  pipeline: Pipeline;
  /** Directory containing `dist/opencascade.wasm.wasm` + `dist/gmsh-core.wasm`. */
  extensionPath: string;
}

/**
 * One-line JSON-shape documentation per op kind, surfaced by
 * `describe_capabilities` so an agent can author raw `EditOp` objects without
 * reading `editOps.ts`. Keys are locked against the op catalog by
 * `mcpTools.test.ts` — a new op kind fails the test until documented here.
 */
export const OP_PARAM_DOCS: Record<EditOpKind, string> = {
  translate: '{targets: id[], vec: [x,y,z]}',
  rotate: '{targets: id[], axisPoint: [x,y,z], axisDir: [x,y,z], angleDeg: n}',
  scale: '{targets: id[], center: [x,y,z], factors: [sx,sy,sz]}',
  mirror: '{targets: id[], planePoint: [x,y,z], planeNormal: [x,y,z]}',
  boolean: '{kind: "union"|"subtract"|"intersect", a: solidId[], b: solidId[]}',
  fillet: '{edges: edgeId[], radius: n>0}',
  chamfer: '{edges: edgeId[], distance: n>0}',
  extrude: '{profile: faceId, dir: [x,y,z], length: n>0}',
  revolve: '{profile: faceId, axisPoint: [x,y,z], axisDir: [x,y,z], angleDeg: n}',
  sweep: '{profile: faceId, path: edgeId}',
  loft: '{profiles: faceId[] (>=2)}',
  explode: '{factor: n}',
  mate: '{faceA: faceId, faceB: faceId (both planar)}',
  shell: '{thickness: n!=0 (negative hollows inward), openingFaces: faceId[] (>=1)}',
  splitByPlane: '{targets: solidId[], planePoint: [x,y,z], planeNormal: [x,y,z], keep: "both"|"positive"|"negative"}',
  section: '{targets: solidId[], planePoint: [x,y,z], planeNormal: [x,y,z]}',
  addBox: '{center: [x,y,z], size: [dx,dy,dz] (full extents)}',
  addSphere: '{center: [x,y,z], radius: n>0}',
  addCylinder: '{center: [x,y,z] (base), axis: [x,y,z], radius: n>0, height: n>0}',
  addCone: '{center: [x,y,z] (base), axis: [x,y,z], radius1: n>0, radius2: n>=0 (0 = apex), height: n>0}',
  addTorus: '{center: [x,y,z], axis: [x,y,z], majorRadius: n>0, minorRadius: n>0 (< majorRadius)}',
  addPrism: '{center: [x,y,z] (base), axis: [x,y,z], radius: n>0 (circumradius), sides: int>=3, height: n>0}',
  addWedge: '{center: [x,y,z], axis: [x,y,z], up: [x,y,z], dx: n>0, dy: n>0, dz: n>0, ltx: n>=0}',
  addHole: '{targets: solidId[], position: [x,y,z] (mouth), axis: [x,y,z] (into material), radius: n>0, depth: n>0}',
  addCounterboreHole:
    '{targets: solidId[], position: [x,y,z], axis: [x,y,z], radius: n>0, depth: n>0, cbRadius: n>radius, cbDepth: n<depth}',
  addCountersinkHole:
    '{targets: solidId[], position: [x,y,z], axis: [x,y,z], radius: n>0, depth: n>0, csRadius: n>radius, csAngleDeg: 0<n<180}',
  addCircleProfile: '{center: [x,y,z], normal: [x,y,z], radius: n>0}',
  addRectangleProfile: '{center: [x,y,z], normal: [x,y,z], up: [x,y,z], width: n>0, height: n>0}',
  addPolygonProfile: '{center: [x,y,z], normal: [x,y,z], up: [x,y,z], radius: n>0, sides: int>=3}',
  addEllipseProfile: '{center: [x,y,z], normal: [x,y,z], up: [x,y,z], radiusX: n>0, radiusY: n>0}',
  addRoundedRectangleProfile:
    '{center: [x,y,z], normal: [x,y,z], up: [x,y,z], width: n>0, height: n>0, cornerRadius: 0<2r<min(w,h)}',
  addSlotProfile: '{center: [x,y,z], normal: [x,y,z], up: [x,y,z], length: n (> width), width: n>0}',
  addTrapezoidProfile:
    '{center: [x,y,z], normal: [x,y,z], up: [x,y,z], bottomWidth: n>0, topWidth: n>0, height: n>0}',
  addPoint: '{position: [x,y,z]}',
  addLine: '{start: [x,y,z], end: [x,y,z]}',
  addArc: '{center: [x,y,z], normal: [x,y,z], radius: n>0, startAngleDeg: n, endAngleDeg: n (CCW about normal)}',
  addPolyline: '{points: [x,y,z][] (>=2; >=3 when closed), closed: boolean}',
  addThreePointArc: '{p1: [x,y,z], p2: [x,y,z], p3: [x,y,z] (non-collinear)}',
  addSpline: '{points: [x,y,z][] (>=2; approximating fit, endpoint-exact)}',
  addBezier: '{controlPoints: [x,y,z][] (>=2)}',
  addEllipseArc:
    '{center: [x,y,z], normal: [x,y,z], up: [x,y,z], radiusX: n>0, radiusY: n>0, startAngleDeg: n, endAngleDeg: n}',
  addHelix: '{center: [x,y,z] (base), axis: [x,y,z], radius: n>0, pitch: n>0, turns: n>0}',
  addSurfaceFromLines: '{edges: edgeId[] (must connect into a closed loop)}',
  addVolumeFromSurfaces: '{faces: faceId[] (must sew into a closed shell)}',
};

/** All op kinds, derived from the panel catalog (which `opCatalog.test.ts`
 * already locks to cover every `EditOpKind`). */
export function allOpKinds(): EditOpKind[] {
  const kinds = new Set<EditOpKind>();
  for (const entry of allCatalogEntries()) for (const k of entry.kinds) kinds.add(k);
  return [...kinds];
}

// ---------------------------------------------------------------------------
// describe_capabilities

export function describeCapabilities() {
  const ops = allOpKinds().map((kind) => ({
    op: kind,
    params: OP_PARAM_DOCS[kind],
    brepOnly: BREP_ONLY_OPS.has(kind),
    topologyChanging: TOPOLOGY_CHANGING_OPS.has(kind),
  }));
  return {
    ops,
    opNotes: [
      "Pass ops as raw JSON objects with an `op` kind field; they are validated by the same tolerant gate the extension uses (malformed ops are rejected with a reason, never crash).",
      "Any numeric field may carry a parametric expression via `exprs`, e.g. {op: \"addBox\", size: [20,10,5], exprs: {\"size[0]\": \"L\"}} — see set_variables.",
      "brepOnly ops are rejected for mesh-format sources (STL/OBJ/PLY/glTF). topologyChanging ops reassign face-N/edge-N ids on replay.",
      "Angles are degrees. Vec3s are [x,y,z] arrays.",
    ],
    entityIdScheme:
      "Stable, deterministic ids assigned by the read pipeline: solid-N (volumes), face-N (surfaces), edge-N (lines), point-N (vertices) for B-rep sources; node-N / node-N/face-K for mesh sources (webview-assigned). Topology-changing ops renumber face/edge ids — re-run load_model after applying them.",
    brepExportTargets: {
      description: "export_brep targets per source format (the source's own format is excluded, matching the extension's Export menu). Mesh targets (stl/obj/ply/gltf) are webview-only and not available headless.",
      step: exportTargetsFor({ strategy: "occt", format: "step" }).filter(isBRepFormat),
      iges: exportTargetsFor({ strategy: "occt", format: "iges" }).filter(isBRepFormat),
      brep: exportTargetsFor({ strategy: "occt", format: "brep" }).filter(isBRepFormat),
    },
    meshExportFormats: MESH_EXPORT_FORMATS.map((f) => ({ id: f.id, label: f.label, extension: f.extension })),
    meshOptions: {
      defaults: DEFAULT_MESH_OPTIONS,
      notes: [
        `sizeMax = ${SIZE_MAX_SENTINEL} is the "unbounded" sentinel (no explicit target size); set a real value for predictable element counts.`,
        'elementShape "simplex" = triangles/tetrahedra, "subdivided" = all-quad/all-hex. elementOrder 2 adds mid-side nodes (quadratic).',
        "algorithm3D defaults to 1 (Delaunay, Gmsh's own default) — a wasm32 stack-overflow that used to make it hang/produce an empty mesh on re-imported CAD was fixed upstream in gmsh-wasm 0.3.0. Frontal (4) and HXT (10) remain valid alternatives.",
        "A part's meshSize gives local refinement (B-rep sources only).",
      ],
    },
    headlessLimitations: [
      "get_mass_properties (volume/area/length, center of mass, moments of inertia via OCCT BRepGProp) is B-rep sources only headless; mesh formats compute the equivalent client-side in the webview.",
      "compare_models (bounding-box-centroid + volume solid matching between two files) is B-rep sources only headless for the same reason — mesh formats have no host-side geometry to derive centroids/volumes from without a webview.",
      "B-rep sources (.step/.stp/.iges/.igs/.brep): full pipeline — load, edit, mesh, export.",
      ".stl sources: meshable from the raw file bytes; edit ops are NOT baked into the meshed geometry headless (they replay in the webview only), and parts cannot become physical groups.",
      ".obj/.ply/.gltf/.glb sources: not meshable or exportable headless (the extension serializes them via the webview's Three.js); edit ops can still be written to the sidecar for the extension to replay.",
      ".vtk/.vtu/.med/.cgns/.exo(.e)/.xdmf/.mdpa sources (meshio++): meshable headless from the raw file bytes (converted host-side to an STL boundary surface, no webview needed — more capable than .obj/.ply/.gltf here); edit ops are NOT baked into the meshed geometry headless (they replay in the webview only), same as .stl. Not exportable headless (export_mesh targets a source-agnostic generated FE mesh, not the source document itself).",
      "The CAD source file is never written; edits/parts/mesh options persist to <model>.edits.json / .parts.json / .mesh.json sidecars the extension reads on open.",
    ],
  };
}

function isBRepFormat(f: CadFormat): f is BRepFormat {
  return f === "step" || f === "iges" || f === "brep";
}

// ---------------------------------------------------------------------------
// Shared helpers

function requireRoute(modelPath: string): FileRoute {
  const route = routeFile(modelPath);
  if (!route) {
    throw new Error(
      `Unsupported file extension: ${path.basename(modelPath)} (supported: step/stp, iges/igs, brep, stl, obj, ply, gltf, glb, vtk, vtu, med, cgns, exo/e, xdmf, mdpa)`
    );
  }
  return route;
}

async function readModelBytes(modelPath: string): Promise<Uint8Array> {
  return new Uint8Array(await fs.readFile(modelPath));
}

interface Bbox {
  min: [number, number, number];
  max: [number, number, number];
  diagonal: number;
}

/** Bounding box over every tessellated face/edge/point position triple. */
function bboxOf(result: BRepResult): Bbox | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const accumulate = (positions: ArrayLike<number>) => {
    for (let i = 0; i + 2 < positions.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = positions[i + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
  };
  for (const group of result.groups) for (const face of group.faces) accumulate(face.buffers.positions);
  for (const edge of result.edges) accumulate(edge.positions);
  for (const point of result.points) accumulate(point.position);
  if (!Number.isFinite(min[0])) return null;
  const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  return { min, max, diagonal };
}

/** The agent-facing summary of a tessellated model (no geometry buffers). */
function entitySummary(result: BRepResult) {
  return {
    tree: result.tree,
    solids: result.groups.map((g) => ({
      id: g.id,
      label: g.label,
      faceIds: g.faces.map((f) => f.faceId),
    })),
    edgeCount: result.edges.length,
    edgeIds: result.edges.length > 0 ? `${result.edges[0].edgeId} … ${result.edges[result.edges.length - 1].edgeId}` : null,
    pointCount: result.points.length,
    bbox: bboxOf(result),
  };
}

async function sidecarSummary(modelPath: string) {
  const { ops, variables } = await readEdits(modelPath);
  const parts = await readParts(modelPath);
  return {
    editOpCount: ops.length,
    variables: variables.map((v) => ({ name: v.name, expr: v.expr, value: v.value })),
    parts: parts.map((p) => p.name),
  };
}

// ---------------------------------------------------------------------------
// load_model

export async function loadModel(ctx: ToolContext, params: { path: string }) {
  const modelPath = params.path;
  const route = requireRoute(modelPath);
  const sidecars = await sidecarSummary(modelPath);

  if (route.strategy !== "occt") {
    return {
      format: route.format,
      strategy: route.strategy,
      tree: null,
      solids: null,
      edgeCount: null,
      edgeIds: null,
      pointCount: null,
      bbox: null,
      sidecars,
      warnings: [
        `${route.format} is a mesh-format source: headless tessellation/entity inventory is B-rep-only. ` +
          "Mesh-legal edit ops can still be applied (they replay when the file is opened in VS Code)" +
          (route.format === "stl" || route.strategy === "meshio"
            ? `, and the ${route.format === "stl" ? "raw STL" : "file's boundary surface (via meshio++)"} is meshable via generate_mesh.`
            : "."),
      ],
    };
  }

  const { ops } = await readEdits(modelPath);
  const bytes = await readModelBytes(modelPath);
  const result = await ctx.pipeline.loadBRep(ctx.extensionPath, bytes, route.format as BRepFormat, ops);
  return {
    format: route.format,
    strategy: route.strategy,
    ...entitySummary(result),
    sidecars,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// get_mass_properties

export async function getMassProperties(
  ctx: ToolContext,
  params: { path: string; entityId?: string }
): Promise<{ format: CadFormat; entityId: string; supported: boolean; warnings: string[] } & Partial<MassProperties>> {
  const modelPath = params.path;
  const route = requireRoute(modelPath);
  const entityId = params.entityId ?? null;

  if (route.strategy !== "occt") {
    return {
      format: route.format,
      entityId: entityId ?? "whole-model",
      supported: false,
      warnings: [
        `${route.format} is a mesh-format source: mass properties are computed client-side in the webview's Three.js scene, not available headless.`,
      ],
    };
  }

  const { ops } = await readEdits(modelPath);
  const bytes = await readModelBytes(modelPath);
  const properties = await ctx.pipeline.computeMassProperties(
    ctx.extensionPath,
    bytes,
    route.format as BRepFormat,
    ops,
    entityId
  );
  return {
    format: route.format,
    entityId: entityId ?? "whole-model",
    supported: true,
    ...properties,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// compare_models

/**
 * Diffs two B-rep models solid-by-solid via `modelDiffHost.ts`'s
 * `compareModels()` — bounding-box-centroid + volume matching, the same
 * heuristic `explodeSolids`/`gmshPartsMap.ts` already use elsewhere. Mirrors
 * `get_mass_properties`'s B-rep-only gate: mesh-format sources return
 * `supported: false` with a warning rather than throwing, since neither file
 * has an OCCT shape to independently re-derive centroids/volumes from
 * headlessly (STL/OBJ/PLY/glTF geometry only exists once parsed by the
 * webview's Three.js loaders — no host-side equivalent here).
 */
export async function compareModelsTool(
  ctx: ToolContext,
  params: { pathA: string; pathB: string }
): Promise<{ formatA: CadFormat; formatB: CadFormat; supported: boolean; warnings: string[]; diff?: ModelDiff }> {
  const routeA = requireRoute(params.pathA);
  const routeB = requireRoute(params.pathB);

  if (routeA.strategy !== "occt" || routeB.strategy !== "occt") {
    return {
      formatA: routeA.format,
      formatB: routeB.format,
      supported: false,
      warnings: [
        "compare_models only supports STEP/IGES/BREP sources headlessly — mesh formats have no host-side geometry to independently derive solid centroids/volumes from without a webview.",
      ],
    };
  }

  const [{ ops: opsA }, { ops: opsB }, bytesA, bytesB] = await Promise.all([
    readEdits(params.pathA),
    readEdits(params.pathB),
    readModelBytes(params.pathA),
    readModelBytes(params.pathB),
  ]);

  const diff = await ctx.pipeline.compareModels(
    ctx.extensionPath,
    bytesA,
    routeA.format as BRepFormat,
    opsA,
    bytesB,
    routeB.format as BRepFormat,
    opsB
  );

  return { formatA: routeA.format, formatB: routeB.format, supported: true, warnings: [], diff };
}

// ---------------------------------------------------------------------------
// get_state

export async function getState(params: { path: string }) {
  const modelPath = params.path;
  requireRoute(modelPath);
  const { ops, variables } = await readEdits(modelPath);
  const parts = await readParts(modelPath);
  const meshOptions = await readMeshOptions(modelPath);
  const { errors } = evaluateVariables(variables);
  return {
    edits: ops.map((op, index) => ({ index, op: op.op, description: describeOp(op), json: op })),
    variables: variables.map((v) => ({
      name: v.name,
      expr: v.expr,
      value: v.value,
      error: errors.get(v.name) ?? null,
    })),
    parts,
    meshOptions,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// apply_edit_ops

export async function applyEditOps(
  ctx: ToolContext,
  params: { path: string; ops: unknown[]; dryRun?: boolean }
) {
  const modelPath = params.path;
  const route = requireRoute(modelPath);
  const warnings: string[] = [];

  const report: Array<{ accepted: boolean; op?: EditOpKind; description?: string; reason?: string }> = [];
  const accepted: EditOp[] = [];
  for (const raw of params.ops) {
    const op = validateEditOp(raw);
    if (!op) {
      const kind = raw && typeof raw === "object" ? (raw as { op?: unknown }).op : undefined;
      report.push({
        accepted: false,
        reason:
          `Malformed or invalid op${typeof kind === "string" ? ` (${kind})` : ""} — ` +
          "check describe_capabilities for the expected fields and invariants.",
      });
      continue;
    }
    if (route.strategy === "three" && BREP_ONLY_OPS.has(op.op)) {
      report.push({
        accepted: false,
        op: op.op,
        reason: `${op.op} is B-rep only; ${route.format} sources have no exact topology for it.`,
      });
      continue;
    }
    accepted.push(op);
    report.push({ accepted: true, op: op.op, description: describeOp(op) });
  }

  if (route.strategy === "three" && accepted.length > 0) {
    warnings.push(
      "Mesh-format source: accepted ops are persisted to the sidecar but cannot be executed or previewed headless — they replay when the file is opened in VS Code."
    );
  }

  const current = await readEdits(modelPath);
  const newOps = [...current.ops, ...accepted];
  if (!params.dryRun && accepted.length > 0) {
    await writeEdits(modelPath, newOps, current.variables);
  }

  let model = null;
  if (!params.dryRun && accepted.length > 0 && route.strategy === "occt") {
    // Re-tessellate so the agent sees the post-replay entity inventory —
    // topology-changing ops renumber face-N/edge-N ids.
    const bytes = await readModelBytes(modelPath);
    const result = await ctx.pipeline.loadBRep(ctx.extensionPath, bytes, route.format as BRepFormat, newOps);
    model = entitySummary(result);
  }

  return {
    applied: params.dryRun ? 0 : accepted.length,
    rejected: report.filter((r) => !r.accepted).length,
    dryRun: params.dryRun === true,
    report,
    stackLength: params.dryRun ? current.ops.length : newOps.length,
    model,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// remove_edit_op

export async function removeEditOp(params: { path: string; index: number }) {
  const modelPath = params.path;
  requireRoute(modelPath);
  const current = await readEdits(modelPath);
  if (!Number.isInteger(params.index) || params.index < 0 || params.index >= current.ops.length) {
    throw new Error(`Index ${params.index} out of range — the op stack has ${current.ops.length} entries (0-based).`);
  }
  const [removed] = current.ops.splice(params.index, 1);
  await writeEdits(modelPath, current.ops, current.variables);
  return {
    removed: describeOp(removed),
    stackLength: current.ops.length,
    warnings: TOPOLOGY_CHANGING_OPS.has(removed.op)
      ? ["Removed a topology-changing op: face-N/edge-N ids referenced by later ops or parts may no longer resolve (they degrade gracefully — unresolved operands are skipped)."]
      : [],
  };
}

// ---------------------------------------------------------------------------
// set_variables

export async function setVariables(params: { path: string; variables: Array<{ name: string; expr: string }> }) {
  const modelPath = params.path;
  requireRoute(modelPath);
  const current = await readEdits(modelPath);
  const previous = new Map(current.variables.map((v) => [v.name, v.value]));

  // Keep each carried-over variable's cached value so a failing expr freezes
  // at its last-good number, same as the webview's VariablesModel.
  const candidate = params.variables.map((v) => ({
    name: v.name,
    expr: v.expr,
    value: previous.get(v.name) ?? 0,
  }));
  const variables = validateVariables(candidate);
  const droppedCount = candidate.length - variables.length;

  const { values, errors } = evaluateVariables(variables);
  const { ops, issues } = resolveEditOps(current.ops, values);
  await writeEdits(modelPath, ops, variables);

  const warnings: string[] = [...issues];
  if (droppedCount > 0) {
    warnings.push(`${droppedCount} variable(s) dropped (invalid/duplicate name or oversized expression).`);
  }
  return {
    variables: variables.map((v) => ({
      name: v.name,
      expr: v.expr,
      value: v.value,
      error: errors.get(v.name) ?? null,
    })),
    resolvedOpCount: ops.length,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// set_part

const PART_COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#42d4f4", "#f032e6", "#bfef45"];

export async function setPart(params: {
  path: string;
  name: string;
  remove?: boolean;
  color?: string;
  volumes?: string[];
  surfaces?: string[];
  lines?: string[];
  points?: string[];
  meshSize?: number | null;
}) {
  const modelPath = params.path;
  const route = requireRoute(modelPath);
  const parts = await readParts(modelPath);
  const index = parts.findIndex((p) => p.name === params.name);
  const warnings: string[] = [];

  if (params.remove) {
    if (index === -1) throw new Error(`No part named "${params.name}".`);
    parts.splice(index, 1);
    await writeParts(modelPath, parts);
    return { parts: parts.map((p) => p.name), warnings };
  }

  const existing: Part | undefined = parts[index];
  const part: Part = {
    name: params.name,
    color: params.color ?? existing?.color ?? PART_COLORS[parts.length % PART_COLORS.length],
    volumes: params.volumes ?? existing?.volumes ?? [],
    surfaces: params.surfaces ?? existing?.surfaces ?? [],
    lines: params.lines ?? existing?.lines ?? [],
    points: params.points ?? existing?.points ?? [],
    meshSize:
      params.meshSize === null
        ? undefined
        : typeof params.meshSize === "number" && Number.isFinite(params.meshSize) && params.meshSize > 0
          ? params.meshSize
          : existing?.meshSize,
  };
  if (typeof params.meshSize === "number" && !(Number.isFinite(params.meshSize) && params.meshSize > 0)) {
    warnings.push("meshSize must be a positive number — ignored.");
  }
  if (index === -1) parts.push(part);
  else parts[index] = part;
  await writeParts(modelPath, parts);

  warnings.push(
    "Entity ids are not validated headless; unresolved ids are dropped gracefully when the model is loaded/meshed. Use load_model's inventory for valid ids."
  );
  if (route.strategy === "three") {
    warnings.push(
      "Mesh-format source: parts cannot become Gmsh physical groups; a single part's meshSize acts as a one-off global size override when meshing."
    );
  }
  return { parts: parts.map((p) => ({ name: p.name, color: p.color, meshSize: p.meshSize ?? null })), warnings };
}

// ---------------------------------------------------------------------------
// set_mesh_options

export async function setMeshOptions(params: { path: string; options: Partial<MeshOptions> }) {
  const modelPath = params.path;
  requireRoute(modelPath);
  if (!params.options || typeof params.options !== "object") {
    throw new Error("options must be an object of MeshOptions fields — see describe_capabilities.");
  }
  const current = await readMeshOptions(modelPath);
  const merged = validateMeshOptions({ ...current, ...params.options });
  if (!merged) throw new Error("options must be an object of MeshOptions fields.");
  await writeMeshOptions(modelPath, merged);

  const warnings: string[] = [];
  for (const key of Object.keys(params.options)) {
    if (!(key in DEFAULT_MESH_OPTIONS)) warnings.push(`Unknown option "${key}" ignored.`);
    else if (JSON.stringify((merged as unknown as Record<string, unknown>)[key]) !== JSON.stringify((params.options as Record<string, unknown>)[key])) {
      warnings.push(`Option "${key}" was invalid or inconsistent and fell back to ${JSON.stringify((merged as unknown as Record<string, unknown>)[key])}.`);
    }
  }
  return { options: merged, geoScriptRegenerated: true, warnings };
}

// ---------------------------------------------------------------------------
// generate_mesh / export_mesh shared input resolution (mirrors provider.ts's
// resolveMeshInput + resolveMeshPartsAndOptions)

async function resolveMeshInputHeadless(
  ctx: ToolContext,
  modelPath: string,
  route: FileRoute,
  warnings: string[]
): Promise<MeshGenerationInput> {
  if (route.strategy === "occt") {
    const { ops } = await readEdits(modelPath);
    const sourceBytes = await readModelBytes(modelPath);
    const stepBytes = await ctx.pipeline.exportBRep(
      ctx.extensionPath,
      sourceBytes,
      route.format as BRepFormat,
      "step",
      ops
    );
    return { kind: "brep", stepBytes };
  }
  if (route.format === "stl") {
    const { ops } = await readEdits(modelPath);
    if (ops.length > 0) {
      warnings.push(
        `${ops.length} edit op(s) exist but are NOT baked into the meshed geometry — STL edits replay in the webview only; the raw file bytes are meshed.`
      );
    }
    return { kind: "stl", stlBytes: await readModelBytes(modelPath) };
  }
  if (route.strategy === "meshio") {
    // Unlike STL/OBJ/PLY/glTF, meshio++ (`src/meshioService.ts`) runs entirely
    // host-side — no webview needed — so these formats are MORE headlessly
    // capable than the other mesh formats: converted to an STL boundary
    // surface (the same funnel-through-STL design the extension itself uses)
    // and meshed exactly like a native `.stl`.
    const { ops } = await readEdits(modelPath);
    if (ops.length > 0) {
      warnings.push(
        `${ops.length} edit op(s) exist but are NOT baked into the meshed geometry — ${route.format} edits replay in the webview only; the raw file's boundary surface is meshed.`
      );
    }
    const bytes = await readModelBytes(modelPath);
    const stlBytes = await ctx.pipeline.convertToStlBoundary(bytes, route.format);
    return { kind: "stl", stlBytes };
  }
  throw new Error(
    `${route.format} sources cannot be meshed headless — the extension serializes them to STL via the webview's Three.js scene. Convert to STL first (e.g. via the extension's Export).`
  );
}

async function resolveMeshPartsAndOptionsHeadless(
  modelPath: string,
  input: MeshGenerationInput,
  options: MeshOptions,
  warnings: string[]
): Promise<{ parts: Part[]; options: MeshOptions }> {
  const parts = await readParts(modelPath);
  if (input.kind === "brep") return { parts, options };
  const overridden = applyStlPartSizeOverride(options, parts);
  if (overridden !== options) {
    warnings.push(
      `Applied the single sized part's meshSize (${overridden.sizeMax}) as a one-off global size override (STL sources get no per-entity sizing).`
    );
  } else if (parts.filter((p) => p.meshSize != null).length > 1) {
    warnings.push("Multiple parts have meshSize set — ambiguous for an STL source, so all are ignored.");
  }
  return { parts: [], options: overridden };
}

async function effectiveMeshOptions(modelPath: string, override: Partial<MeshOptions> | undefined): Promise<MeshOptions> {
  const stored = await readMeshOptions(modelPath);
  if (!override) return stored;
  const merged = validateMeshOptions({ ...stored, ...override });
  if (!merged) throw new Error("options must be an object of MeshOptions fields.");
  return merged;
}

// ---------------------------------------------------------------------------
// generate_mesh

export async function generateMeshTool(
  ctx: ToolContext,
  params: { path: string; options?: Partial<MeshOptions> }
) {
  const modelPath = params.path;
  const route = requireRoute(modelPath);
  const warnings: string[] = [];

  const input = await resolveMeshInputHeadless(ctx, modelPath, route, warnings);
  const base = await effectiveMeshOptions(modelPath, params.options);
  const { parts, options } = await resolveMeshPartsAndOptionsHeadless(modelPath, input, base, warnings);
  if (options.sizeMax === SIZE_MAX_SENTINEL) {
    warnings.push(
      "sizeMax is unset (unbounded sentinel) — Gmsh picks element sizes from the geometry alone; set a real sizeMax for predictable refinement."
    );
  }

  const started = Date.now();
  const result = await ctx.pipeline.generateMesh(ctx.extensionPath, input, options, parts);
  return {
    nodeCount: result.nodeCount,
    elementCount: result.elementCount,
    elapsedMs: Date.now() - started,
    elementGroups: result.elementGroups.map((g) => ({ name: g.name, color: g.color })),
    quality: result.quality ?? null,
    options,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// export_mesh

/** Rewrites the `.geo_unrolled` XAO Merge stub to the sibling companion's name
 * (same regex as provider.ts's meshingExport geoUnrolled branch). */
export function rewriteGeoMerge(text: string, xaoName: string): string {
  return text.replace(/Merge "[^"]*\.xao";/, `Merge "${xaoName}";`);
}

export async function exportMeshTool(
  ctx: ToolContext,
  params: { path: string; format: string; outputPath: string; options?: Partial<MeshOptions> }
) {
  const modelPath = params.path;
  const route = requireRoute(modelPath);
  const format = meshExportFormat(params.format);
  if (!format) {
    throw new Error(
      `Unknown mesh export format "${params.format}" — valid ids: ${MESH_EXPORT_FORMATS.map((f) => f.id).join(", ")}.`
    );
  }
  const outputPath = path.resolve(params.outputPath);
  assertNotSourcePath(modelPath, outputPath);
  const warnings: string[] = [];

  const input = await resolveMeshInputHeadless(ctx, modelPath, route, warnings);
  const base = await effectiveMeshOptions(modelPath, params.options);
  const { parts, options } = await resolveMeshPartsAndOptionsHeadless(modelPath, input, base, warnings);

  const written: string[] = [];
  if (format.id === "msh") {
    const result = await ctx.pipeline.generateMesh(ctx.extensionPath, input, options, parts);
    await fs.writeFile(outputPath, result.mshText, "utf8");
    written.push(outputPath);
  } else if (format.id === "geoUnrolled") {
    const geo = await ctx.pipeline.exportGeoUnrolled(ctx.extensionPath, input, options, parts);
    if (geo.xao) {
      // B-rep geometry can't be textually unrolled — write the XAO companion
      // as a sibling and point the Merge stub at it (see provider.ts).
      const xaoName = `${path.basename(outputPath)}.xao`;
      const xaoPath = path.join(path.dirname(outputPath), xaoName);
      assertNotSourcePath(modelPath, xaoPath);
      await fs.writeFile(xaoPath, geo.xao);
      await fs.writeFile(outputPath, rewriteGeoMerge(geo.text, xaoName), "utf8");
      written.push(outputPath, xaoPath);
      warnings.push(
        "The .geo_unrolled references its .xao companion (OCC geometry can't unroll to text) — keep the two files together."
      );
    } else {
      await fs.writeFile(outputPath, geo.text, "utf8");
      written.push(outputPath);
    }
  } else if (format.id === "mdpaElements" || format.id === "mdpaGeometries") {
    const text = await ctx.pipeline.exportMdpa(
      ctx.extensionPath,
      input,
      options,
      parts,
      format.id === "mdpaElements" ? "elements" : "geometries"
    );
    await fs.writeFile(outputPath, text, "utf8");
    written.push(outputPath);
  } else if (format.id === "med" || format.id === "cgns" || format.id === "xdmf") {
    // meshio++ bridge — see meshExportFormats.ts's doc comment (no CGNS/MED
    // writer in this gmsh-wasm build) and provider.ts's mirrored branch.
    // exportViaMeshio takes generateMesh()'s own MSH 4.1 mshText directly
    // (meshio++ 9.7.0 reads 4.1 natively — see its doc comment).
    const meshed = await ctx.pipeline.generateMesh(ctx.extensionPath, input, options, parts);
    const { bytes, companion } = await ctx.pipeline.exportViaMeshio(meshed.mshText, format.id);
    if (!companion) {
      await fs.writeFile(outputPath, bytes);
      written.push(outputPath);
    } else {
      // xdmf's embedded <DataItem> references are rewritten to match the
      // companion's real filename — same "write beside + fix the reference"
      // pattern as .geo_unrolled's .xao companion.
      const h5Name = `${path.basename(outputPath).replace(/\.[^.]+$/, "")}.h5`;
      const h5Path = path.join(path.dirname(outputPath), h5Name);
      assertNotSourcePath(modelPath, h5Path);
      const fixedText = Buffer.from(bytes).toString("utf8").split(companion.name).join(h5Name);
      await fs.writeFile(outputPath, fixedText, "utf8");
      await fs.writeFile(h5Path, companion.bytes);
      written.push(outputPath, h5Path);
      warnings.push("The .xdmf references its .h5 companion (HDF5 data) — keep the two files together.");
    }
  } else {
    const text = await ctx.pipeline.exportMeshFormat(
      ctx.extensionPath,
      input,
      options,
      parts,
      format.id as Parameters<typeof exportMeshFormat>[4]
    );
    await fs.writeFile(outputPath, text, "utf8");
    written.push(outputPath);
  }

  const sizes = await Promise.all(written.map(async (p) => ({ path: p, bytes: (await fs.stat(p)).size })));
  return { format: format.id, written: sizes, warnings };
}

// ---------------------------------------------------------------------------
// export_brep

export async function exportBRepTool(
  ctx: ToolContext,
  params: { path: string; targetFormat: string; outputPath: string }
) {
  const modelPath = params.path;
  const route = requireRoute(modelPath);
  if (route.strategy !== "occt") {
    throw new Error(
      `${route.format} sources have no B-rep to export. Mesh→mesh export (STL/OBJ/PLY/glTF) is webview-only — use the extension's Export.`
    );
  }
  const target = params.targetFormat as CadFormat;
  const targets = exportTargetsFor(route);
  if (!isBRepFormat(target) || !targets.includes(target)) {
    const valid = targets.filter(isBRepFormat);
    throw new Error(
      `Invalid target "${params.targetFormat}" for a ${route.format} source — valid: ${valid.join(", ")}. ` +
        "(Mesh targets are webview-only; the source's own format is excluded, matching the extension's Export menu.)"
    );
  }
  const outputPath = path.resolve(params.outputPath);
  assertNotSourcePath(modelPath, outputPath);

  const { ops } = await readEdits(modelPath);
  const sourceBytes = await readModelBytes(modelPath);
  const bytes = await ctx.pipeline.exportBRep(
    ctx.extensionPath,
    sourceBytes,
    route.format as BRepFormat,
    target,
    ops
  );
  await fs.writeFile(outputPath, bytes);
  return {
    written: outputPath,
    bytes: bytes.byteLength,
    extension: EXPORT_EXTENSION[target],
    editsBaked: ops.length,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// save_preprocess / load_preprocess (headless counterpart of provider.ts's
// File ▸ Save/Load Preprocess…, sharing the same pure preprocessArchive.ts)

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

export async function savePreprocessTool(params: { path: string; outputPath: string }) {
  const modelPath = params.path;
  requireRoute(modelPath);
  const outputPath = path.resolve(params.outputPath);
  assertNotSourcePath(modelPath, outputPath);

  const sourceName = path.basename(modelPath);
  const [source, parts, edits, meshOptions, geo] = await Promise.all([
    readModelBytes(modelPath),
    readOptionalFile(partsSidecarPath(modelPath)),
    readOptionalFile(editsSidecarPath(modelPath)),
    readOptionalFile(meshOptionsSidecarPath(modelPath)),
    readOptionalFile(geoScriptPath(modelPath)),
  ]);

  const zipBytes = buildPreprocessZip({ sourceName, source, parts, edits, meshOptions, geo });
  await fs.writeFile(outputPath, zipBytes);
  return {
    written: outputPath,
    bytes: zipBytes.byteLength,
    included: {
      source: sourceName,
      parts: parts !== undefined,
      edits: edits !== undefined,
      meshOptions: meshOptions !== undefined,
      geo: geo !== undefined,
    },
    warnings: [],
  };
}

export async function loadPreprocessTool(params: { zipPath: string; outputPath: string }) {
  const zipPath = path.resolve(params.zipPath);
  const outputPath = path.resolve(params.outputPath);
  if (zipPath === outputPath) {
    throw new Error("outputPath must be different from zipPath.");
  }
  requireRoute(outputPath);

  const zipBytes = new Uint8Array(await fs.readFile(zipPath));
  const contents = readPreprocessZip(zipBytes);

  await fs.writeFile(outputPath, contents.source);
  if (contents.parts !== undefined) {
    await writeParts(outputPath, parsePartsJson(contents.parts));
  }
  if (contents.edits !== undefined) {
    const parsed = parseEditsJson(contents.edits);
    await writeEdits(outputPath, parsed.ops, parsed.variables);
  }
  if (contents.meshOptions !== undefined) {
    // mcpSidecars' writeMeshOptions writes <out>.mesh.json AND regenerates the
    // one-way <out>.geo script in one call — the archive's own raw .geo text
    // (if any) is intentionally not restored verbatim, same rule as every
    // other options write path.
    await writeMeshOptions(outputPath, parseMeshJson(contents.meshOptions));
  }

  return {
    written: outputPath,
    manifestSource: contents.manifest.source,
    restored: {
      parts: contents.parts !== undefined,
      edits: contents.edits !== undefined,
      meshOptions: contents.meshOptions !== undefined,
    },
    warnings: [],
  };
}
