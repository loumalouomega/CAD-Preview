import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  describeCapabilities,
  allOpKinds,
  OP_PARAM_DOCS,
  loadModel,
  getMassProperties,
  compareModelsTool,
  getState,
  applyEditOps,
  runParametricScriptTool,
  removeEditOp,
  setVariables,
  setPart,
  setMeshOptions,
  inspectEntity,
  measureTool,
  renderSnapshotTool,
  searchStandardPartsTool,
  downloadStandardPartTool,
  generateMeshTool,
  exportMeshTool,
  exportBRepTool,
  rewriteGeoMerge,
  savePreprocessTool,
  loadPreprocessTool,
  type Pipeline,
  type ToolContext,
} from "./mcpTools";
import { readEdits, readParts, editsSidecarPath, geoScriptPath, partsSidecarPath } from "./mcpSidecars";
import { MESH_EXPORT_FORMATS } from "./meshExportFormats";
import { BREP_ONLY_OPS, TOPOLOGY_CHANGING_OPS } from "./editOps";
import { DEFAULT_MESH_OPTIONS } from "./meshOptions";
import type { BRepResult } from "./occtService";
import type { MeshResult } from "./gmshService";
import type { MassProperties } from "./massProperties";
import type { EntityFacts, MeasureResult } from "./entityFacts";
import type { RenderResult } from "./renderService";
import type { PartSearchResult, DownloadedPart } from "./stepPartsService";
import type { ModelDiff } from "./modelDiff";

let dir: string;
let stpModel: string;
let stpModel2: string;
let stlModel: string;
let objModel: string;

const FAKE_BREP_RESULT: BRepResult = {
  groups: [
    {
      id: "solid-0",
      label: "Solid 1",
      faceCount: 2,
      faces: [
        { faceId: "face-0", buffers: { positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]), normals: new Float32Array(), indices: new Uint32Array([0, 1, 2]) } },
        { faceId: "face-1", buffers: { positions: new Float32Array([0, 0, 5]), normals: new Float32Array(), indices: new Uint32Array() } },
      ],
    },
  ],
  edges: [{ edgeId: "edge-0", positions: new Float32Array([0, 0, 0, 1, 0, 0]) }],
  points: [{ pointId: "point-0", position: [0, 0, 0] }],
  tree: { id: "root", label: "STEP", children: [{ id: "solid-0", label: "Solid 1", faceCount: 2 }] },
};

const FAKE_MESH_RESULT: MeshResult = {
  positions: new Float32Array(),
  indices: new Uint32Array(),
  edges: new Uint32Array(),
  elementGroups: [{ name: null, color: null, indexStart: 0, indexCount: 0 }],
  nodeCount: 42,
  elementCount: 99,
  mshText: "$MeshFormat\n4.1 0 8\n$EndMeshFormat\n",
};

const FAKE_MASS_PROPERTIES: MassProperties = {
  volume: 24,
  area: 52,
  length: null,
  centerOfMass: [1, 1.5, 2],
  momentsOfInertia: { ixx: 50, iyy: 40, izz: 26, ixy: 0, ixz: 0, iyz: 0 },
};

const FAKE_ENTITY_FACTS: EntityFacts = {
  entityId: "solid-0",
  kind: "solid",
  bbox: { min: [0, 0, 0], max: [1, 1, 5], diagonal: Math.hypot(1, 1, 5) },
  center: [0.5, 0.5, 2.5],
  area: 52,
  length: null,
  normal: null,
  surfaceType: null,
};

const FAKE_MEASURE_RESULT: MeasureResult = {
  from: "solid-0",
  to: "solid-1",
  fromPoint: [0, 0, 0],
  toPoint: [3, 4, 0],
  distance: 5,
  delta: [3, 4, 0],
};

const FAKE_RENDER_RESULT: RenderResult = {
  supported: true,
  images: [
    { label: "ISO-A", mimeType: "image/png", dataBase64: "aXNvLWE=" },
    { label: "ISO-B", mimeType: "image/png", dataBase64: "aXNvLWI=" },
    { label: "TOP", mimeType: "image/png", dataBase64: "dG9w" },
    { label: "FRONT", mimeType: "image/png", dataBase64: "ZnJvbnQ=" },
  ],
};

const FAKE_PART_SEARCH_RESULT: PartSearchResult = {
  items: [
    {
      id: "iso4017_hex_head_cap_screw_m6x25",
      name: "ISO 4017 hex head cap screw, M6 x 25",
      description: "ISO 4017, hex head cap screw, M6 x 25.",
      category: "fastener",
      tags: ["screw", "bolt"],
      aliases: [],
      attributes: { thread: "M6" },
      stepUrl: "https://media.githubusercontent.com/media/example/part.step",
      glbUrl: "https://example.com/part.glb",
      pngUrl: "https://example.com/part.png",
      byteSize: 1234,
      sha256: null,
      pageUrl: "https://www.step.parts/parts/iso4017_hex_head_cap_screw_m6x25",
      apiUrl: "https://api.step.parts/v1/parts/iso4017_hex_head_cap_screw_m6x25",
    },
  ],
  page: 1,
  pageSize: 100,
  total: 1,
  totalPages: 1,
  hasNextPage: false,
  hasPreviousPage: false,
  facets: { tags: [], categories: [], families: [], standards: [] },
};

const FAKE_DOWNLOADED_PART: DownloadedPart = {
  id: "iso4017_hex_head_cap_screw_m6x25",
  bytes: new TextEncoder().encode("ISO-10303-21;"),
  sha256: "abc123",
  verifiedChecksum: true,
  stepUrl: "https://media.githubusercontent.com/media/example/part.step",
  pageUrl: "https://www.step.parts/parts/iso4017_hex_head_cap_screw_m6x25",
};

const FAKE_MODEL_DIFF: ModelDiff = {
  added: [],
  removed: [],
  matched: [{ a: { id: "solid-0", centre: [0, 0, 0], diagonal: 10, volume: 24 }, b: { id: "solid-0", centre: [0, 0, 0], diagonal: 10, volume: 24 }, centreDistance: 0, volumeDeltaPct: 0 }],
};

function fakePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    loadBRep: vi.fn(async () => FAKE_BREP_RESULT),
    exportBRep: vi.fn(async () => new Uint8Array([1, 2, 3])),
    generateMesh: vi.fn(async () => FAKE_MESH_RESULT),
    exportMeshFormat: vi.fn(async () => "vtk-content"),
    exportMdpa: vi.fn(async () => "Begin Nodes\nEnd Nodes\n"),
    exportGeoUnrolled: vi.fn(async () => ({ text: 'Merge "/out.geo_unrolled.xao";\n', xao: new Uint8Array([9]) })),
    computeMassProperties: vi.fn(async () => FAKE_MASS_PROPERTIES),
    getEntityFacts: vi.fn(async () => FAKE_ENTITY_FACTS),
    measureEntities: vi.fn(async () => FAKE_MEASURE_RESULT),
    renderSnapshot: vi.fn(async () => FAKE_RENDER_RESULT),
    isRenderAvailable: vi.fn(async () => ({ available: true })),
    searchStandardParts: vi.fn(async () => ({ available: true, value: FAKE_PART_SEARCH_RESULT })),
    downloadStandardPart: vi.fn(async () => ({ available: true, value: FAKE_DOWNLOADED_PART })),
    compareModels: vi.fn(async () => FAKE_MODEL_DIFF),
    convertToStlBoundary: vi.fn(async () => new TextEncoder().encode("solid x\nendsolid x\n")),
    exportViaMeshio: vi.fn(async () => ({ bytes: new TextEncoder().encode("fake-meshio-bytes") })),
    ...overrides,
  } as Pipeline;
}

function ctx(pipeline: Pipeline = fakePipeline()): ToolContext {
  return { pipeline, extensionPath: dir };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-tools-"));
  stpModel = path.join(dir, "model.stp");
  stpModel2 = path.join(dir, "model2.stp");
  stlModel = path.join(dir, "model.stl");
  objModel = path.join(dir, "model.obj");
  await fs.writeFile(stpModel, "ISO-10303-21;", "utf8");
  await fs.writeFile(stpModel2, "ISO-10303-21;", "utf8");
  await fs.writeFile(stlModel, "solid x\nendsolid x\n", "utf8");
  await fs.writeFile(objModel, "v 0 0 0\n", "utf8");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("describe_capabilities", () => {
  it("covers every EditOpKind with param docs and correct flags", () => {
    const caps = describeCapabilities();
    const kinds = allOpKinds();
    expect(new Set(caps.ops.map((o) => o.op))).toEqual(new Set(kinds));
    for (const entry of caps.ops) {
      expect(OP_PARAM_DOCS[entry.op], `params for ${entry.op}`).toBeTruthy();
      expect(entry.brepOnly).toBe(BREP_ONLY_OPS.has(entry.op));
      expect(entry.topologyChanging).toBe(TOPOLOGY_CHANGING_OPS.has(entry.op));
    }
  });

  it("has no OP_PARAM_DOCS keys outside the live op kinds", () => {
    const kinds = new Set<string>(allOpKinds());
    for (const key of Object.keys(OP_PARAM_DOCS)) {
      expect(kinds.has(key), `stale OP_PARAM_DOCS key ${key}`).toBe(true);
    }
  });

  it("lists every registered mesh export format", () => {
    const caps = describeCapabilities();
    expect(caps.meshExportFormats.map((f) => f.id)).toEqual(MESH_EXPORT_FORMATS.map((f) => f.id));
    expect(caps.meshOptions.defaults).toEqual(DEFAULT_MESH_OPTIONS);
  });

  it("excludes the source's own format and mesh targets from brep export targets", () => {
    const caps = describeCapabilities();
    expect(caps.brepExportTargets.step).toEqual(["iges", "brep"]);
    expect(caps.brepExportTargets.brep).toEqual(["step", "iges"]);
  });
});

describe("load_model", () => {
  it("loads a B-rep source with entity inventory and bbox", async () => {
    const c = ctx();
    const result = await loadModel(c, { path: stpModel });
    expect(c.pipeline.loadBRep).toHaveBeenCalledWith(dir, expect.any(Uint8Array), "step", []);
    expect(result.solids).toEqual([{ id: "solid-0", label: "Solid 1", faceIds: ["face-0", "face-1"] }]);
    expect(result.bbox).toEqual({ min: [0, 0, 0], max: [1, 1, 5], diagonal: Math.hypot(1, 1, 5) });
    expect(result.edgeCount).toBe(1);
  });

  it("replays sidecar ops on load", async () => {
    const c = ctx();
    await applyEditOps(c, { path: stpModel, ops: [{ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] }] });
    await loadModel(c, { path: stpModel });
    const lastCall = vi.mocked(c.pipeline.loadBRep).mock.lastCall!;
    expect(lastCall[3]).toEqual([{ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] }]);
  });

  it("returns route info + limitation warning for mesh sources without touching WASM", async () => {
    const c = ctx();
    const result = await loadModel(c, { path: stlModel });
    expect(c.pipeline.loadBRep).not.toHaveBeenCalled();
    expect(result.warnings[0]).toMatch(/mesh-format/i);
  });

  it("rejects unsupported extensions", async () => {
    await expect(loadModel(ctx(), { path: path.join(dir, "x.txt") })).rejects.toThrow(/unsupported/i);
  });

  it("notes meshio++ sources ARE meshable headless, unlike obj/ply/gltf", async () => {
    const c = ctx();
    const vtkModel = path.join(dir, "model.vtk");
    await fs.writeFile(vtkModel, "not real vtk content", "utf8");
    const vtkResult = await loadModel(c, { path: vtkModel });
    expect(vtkResult.warnings[0]).toMatch(/meshable via generate_mesh/i);

    const objResult = await loadModel(c, { path: objModel });
    expect(objResult.warnings[0]).not.toMatch(/meshable via generate_mesh/i);
  });
});

describe("get_mass_properties", () => {
  it("computes whole-model mass properties for a B-rep source", async () => {
    const c = ctx();
    const result = await getMassProperties(c, { path: stpModel });
    expect(c.pipeline.computeMassProperties).toHaveBeenCalledWith(dir, expect.any(Uint8Array), "step", [], null);
    expect(result).toMatchObject({ supported: true, entityId: "whole-model", volume: 24, area: 52 });
  });

  it("passes a resolved entityId through to the pipeline", async () => {
    const c = ctx();
    const result = await getMassProperties(c, { path: stpModel, entityId: "solid-0" });
    expect(c.pipeline.computeMassProperties).toHaveBeenCalledWith(dir, expect.any(Uint8Array), "step", [], "solid-0");
    expect(result.entityId).toBe("solid-0");
  });

  it("replays sidecar ops before computing", async () => {
    const c = ctx();
    await applyEditOps(c, { path: stpModel, ops: [{ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] }] });
    await getMassProperties(c, { path: stpModel });
    const lastCall = vi.mocked(c.pipeline.computeMassProperties).mock.lastCall!;
    expect(lastCall[3]).toEqual([{ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] }]);
  });

  it("returns supported: false with a warning for mesh sources, without touching WASM", async () => {
    const c = ctx();
    const result = await getMassProperties(c, { path: stlModel });
    expect(c.pipeline.computeMassProperties).not.toHaveBeenCalled();
    expect(result.supported).toBe(false);
    expect(result.warnings[0]).toMatch(/client-side/i);
  });

  it("rejects unsupported extensions", async () => {
    await expect(getMassProperties(ctx(), { path: path.join(dir, "x.txt") })).rejects.toThrow(/unsupported/i);
  });
});

describe("inspect", () => {
  it("resolves entity facts for a B-rep source", async () => {
    const c = ctx();
    const result = await inspectEntity(c, { path: stpModel, entityId: "solid-0" });
    expect(c.pipeline.getEntityFacts).toHaveBeenCalledWith(dir, expect.any(Uint8Array), "step", [], "solid-0");
    expect(result).toMatchObject({ supported: true, entityId: "solid-0", kind: "solid", area: 52 });
  });

  it("replays sidecar ops before resolving", async () => {
    const c = ctx();
    await applyEditOps(c, { path: stpModel, ops: [{ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] }] });
    await inspectEntity(c, { path: stpModel, entityId: "solid-0" });
    const lastCall = vi.mocked(c.pipeline.getEntityFacts).mock.lastCall!;
    expect(lastCall[3]).toEqual([{ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] }]);
  });

  it("returns supported: false with a warning for mesh sources, without touching WASM", async () => {
    const c = ctx();
    const result = await inspectEntity(c, { path: stlModel, entityId: "node-0" });
    expect(c.pipeline.getEntityFacts).not.toHaveBeenCalled();
    expect(result.supported).toBe(false);
    expect(result.warnings[0]).toMatch(/headless/i);
  });
});

describe("measure", () => {
  it("measures the distance between two entities for a B-rep source", async () => {
    const c = ctx();
    const result = await measureTool(c, { path: stpModel, from: "solid-0", to: "solid-1" });
    expect(c.pipeline.measureEntities).toHaveBeenCalledWith(
      dir,
      expect.any(Uint8Array),
      "step",
      [],
      "solid-0",
      "solid-1",
      undefined
    );
    expect(result).toMatchObject({ supported: true, distance: 5 });
  });

  it("passes an optional axis through to the pipeline", async () => {
    const c = ctx();
    await measureTool(c, { path: stpModel, from: "solid-0", to: "solid-1", axis: [1, 0, 0] });
    const lastCall = vi.mocked(c.pipeline.measureEntities).mock.lastCall!;
    expect(lastCall[6]).toEqual([1, 0, 0]);
  });

  it("returns supported: false with a warning for mesh sources, without touching WASM", async () => {
    const c = ctx();
    const result = await measureTool(c, { path: stlModel, from: "node-0", to: "node-1" });
    expect(c.pipeline.measureEntities).not.toHaveBeenCalled();
    expect(result.supported).toBe(false);
    expect(result.warnings[0]).toMatch(/headless/i);
  });
});

describe("render_snapshot", () => {
  it("returns the pipeline's images for a B-rep source when the renderer is available", async () => {
    const c = ctx();
    const result = await renderSnapshotTool(c, { path: stpModel });
    expect(c.pipeline.isRenderAvailable).toHaveBeenCalled();
    expect(c.pipeline.renderSnapshot).toHaveBeenCalledWith(dir, expect.any(Uint8Array), "step", [], {
      focus: undefined,
      hide: undefined,
      wireframe: undefined,
    });
    expect(result.supported).toBe(true);
    expect(result.images).toHaveLength(4);
  });

  it("maps displayMode: wireframe to the pipeline's wireframe flag", async () => {
    const c = ctx();
    await renderSnapshotTool(c, { path: stpModel, displayMode: "wireframe" });
    const lastCall = vi.mocked(c.pipeline.renderSnapshot).mock.lastCall!;
    expect(lastCall[4].wireframe).toBe(true);
  });

  it("returns supported: false without calling the pipeline when the renderer is unavailable", async () => {
    const c = ctx(fakePipeline({ isRenderAvailable: vi.fn(async () => ({ available: false, reason: "no chromium" })) }));
    const result = await renderSnapshotTool(c, { path: stpModel });
    expect(c.pipeline.renderSnapshot).not.toHaveBeenCalled();
    expect(result).toEqual({ supported: false, images: [], warnings: ["no chromium"] });
  });

  it("returns supported: false with a warning for mesh sources, without checking availability", async () => {
    const c = ctx();
    const result = await renderSnapshotTool(c, { path: stlModel });
    expect(c.pipeline.isRenderAvailable).not.toHaveBeenCalled();
    expect(c.pipeline.renderSnapshot).not.toHaveBeenCalled();
    expect(result.supported).toBe(false);
    expect(result.warnings[0]).toMatch(/mesh-format/i);
  });
});

describe("search_standard_parts", () => {
  it("returns the pipeline's search result when the API is reachable", async () => {
    const c = ctx();
    const result = await searchStandardPartsTool(c, { q: "bolt" });
    expect(c.pipeline.searchStandardParts).toHaveBeenCalledWith({ q: "bolt" });
    expect(result.supported).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("returns supported: false with a warning on a network/API failure, never throws", async () => {
    const c = ctx(
      fakePipeline({ searchStandardParts: vi.fn(async () => ({ available: false as const, reason: "step.parts API unreachable (timeout)." })) })
    );
    const result = await searchStandardPartsTool(c, { q: "bolt" });
    expect(result.supported).toBe(false);
    expect(result.warnings[0]).toMatch(/unreachable/i);
    expect(result.items).toBeUndefined();
  });
});

describe("download_standard_part", () => {
  it("writes the downloaded STEP bytes and reports provenance/checksum status", async () => {
    const c = ctx();
    const out = path.join(dir, "part.step");
    const result = await downloadStandardPartTool(c, { id: "iso4017_hex_head_cap_screw_m6x25", outputPath: out });
    expect(c.pipeline.downloadStandardPart).toHaveBeenCalledWith("iso4017_hex_head_cap_screw_m6x25");
    expect(result.supported).toBe(true);
    expect(result.written).toBe(out);
    expect(result.verifiedChecksum).toBe(true);
    expect(await fs.readFile(out, "utf8")).toBe("ISO-10303-21;");
    expect(result.warnings).toEqual([]);
  });

  it("warns (but still succeeds) when the part has no recorded checksum", async () => {
    const c = ctx(
      fakePipeline({
        downloadStandardPart: vi.fn(async () => ({
          available: true as const,
          value: { ...FAKE_DOWNLOADED_PART, sha256: null, verifiedChecksum: false },
        })),
      })
    );
    const result = await downloadStandardPartTool(c, { id: "x", outputPath: path.join(dir, "x.step") });
    expect(result.supported).toBe(true);
    expect(result.warnings[0]).toMatch(/no recorded sha256/i);
  });

  it("warns when the downloaded bytes fail checksum verification", async () => {
    const c = ctx(
      fakePipeline({
        downloadStandardPart: vi.fn(async () => ({
          available: true as const,
          value: { ...FAKE_DOWNLOADED_PART, verifiedChecksum: false },
        })),
      })
    );
    const result = await downloadStandardPartTool(c, { id: "x", outputPath: path.join(dir, "x2.step") });
    expect(result.supported).toBe(true);
    expect(result.warnings[0]).toMatch(/do NOT match/);
  });

  it("returns supported: false without writing anything on a network/API failure", async () => {
    const c = ctx(
      fakePipeline({ downloadStandardPart: vi.fn(async () => ({ available: false as const, reason: "step.parts API unreachable." })) })
    );
    const out = path.join(dir, "unreached.step");
    const result = await downloadStandardPartTool(c, { id: "x", outputPath: out });
    expect(result.supported).toBe(false);
    expect(result.warnings[0]).toMatch(/unreachable/i);
    await expect(fs.access(out)).rejects.toThrow();
  });
});

describe("compare_models", () => {
  it("diffs two B-rep sources via the pipeline", async () => {
    const c = ctx();
    const result = await compareModelsTool(c, { pathA: stpModel, pathB: stpModel2 });
    expect(c.pipeline.compareModels).toHaveBeenCalledWith(dir, expect.any(Uint8Array), "step", [], expect.any(Uint8Array), "step", []);
    expect(result).toEqual({ formatA: "step", formatB: "step", supported: true, warnings: [], diff: FAKE_MODEL_DIFF });
  });

  it("replays each side's sidecar ops before comparing", async () => {
    const c = ctx();
    await applyEditOps(c, { path: stpModel2, ops: [{ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] }] });
    await compareModelsTool(c, { pathA: stpModel, pathB: stpModel2 });
    const lastCall = vi.mocked(c.pipeline.compareModels).mock.lastCall!;
    expect(lastCall[3]).toEqual([]); // A has no ops
    expect(lastCall[6]).toEqual([{ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] }]); // B does
  });

  it("returns supported: false with a warning when either side is a mesh source, without touching WASM", async () => {
    const c = ctx();
    const result = await compareModelsTool(c, { pathA: stpModel, pathB: stlModel });
    expect(c.pipeline.compareModels).not.toHaveBeenCalled();
    expect(result.supported).toBe(false);
    expect(result.diff).toBeUndefined();
    expect(result.warnings[0]).toMatch(/mesh format/i);
  });

  it("rejects unsupported extensions on either path", async () => {
    await expect(compareModelsTool(ctx(), { pathA: path.join(dir, "x.txt"), pathB: stpModel2 })).rejects.toThrow(/unsupported/i);
    await expect(compareModelsTool(ctx(), { pathA: stpModel, pathB: path.join(dir, "x.txt") })).rejects.toThrow(/unsupported/i);
  });
});

describe("apply_edit_ops", () => {
  it("appends valid ops and reports rejects with reasons", async () => {
    const result = await applyEditOps(ctx(), {
      path: stpModel,
      ops: [
        { op: "addBox", center: [0, 0, 0], size: [1, 2, 3] },
        { op: "addBox", center: [0, 0, 0] }, // missing size
        { op: "noSuchOp" },
      ],
    });
    expect(result.applied).toBe(1);
    expect(result.rejected).toBe(2);
    expect(result.report[0].accepted).toBe(true);
    expect(result.report[1].reason).toMatch(/malformed|invalid/i);
    expect(result.stackLength).toBe(1);
    expect(result.model).not.toBeNull();
    expect((await readEdits(stpModel)).ops).toHaveLength(1);
  });

  it("rejects BREP_ONLY_OPS for mesh-format sources but persists mesh-legal ops with a warning", async () => {
    const c = ctx();
    const result = await applyEditOps(c, {
      path: stlModel,
      ops: [
        { op: "addWedge", center: [0, 0, 0], axis: [0, 0, 1], up: [1, 0, 0], dx: 1, dy: 1, dz: 1, ltx: 0 },
        { op: "translate", targets: ["node-0"], vec: [1, 0, 0] },
      ],
    });
    expect(result.report[0]).toMatchObject({ accepted: false, op: "addWedge" });
    expect(result.report[0].reason).toMatch(/B-rep only/);
    expect(result.report[1].accepted).toBe(true);
    expect(result.warnings[0]).toMatch(/cannot be executed .* headless/i);
    expect(result.model).toBeNull(); // no headless tessellation for meshes
    expect(c.pipeline.loadBRep).not.toHaveBeenCalled();
    expect((await readEdits(stlModel)).ops).toHaveLength(1);
  });

  it("dryRun validates without writing", async () => {
    const result = await applyEditOps(ctx(), {
      path: stpModel,
      ops: [{ op: "addSphere", center: [0, 0, 0], radius: 2 }],
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.applied).toBe(0);
    expect(result.report[0].accepted).toBe(true);
    await expect(fs.access(editsSidecarPath(stpModel))).rejects.toThrow();
  });
});

describe("run_parametric_script", () => {
  it("compiles a bolt-circle repeat and appends the baked ops", async () => {
    const c = ctx();
    const result = await runParametricScriptTool(c, {
      path: stpModel,
      script: {
        variables: [
          { name: "R", expr: "10" },
          { name: "N", expr: "4" },
        ],
        steps: [
          {
            repeat: {
              times: "N",
              indexVar: "i",
              body: [
                {
                  op: "addCylinder",
                  center: [0, 0, 0],
                  axis: [0, 0, 1],
                  radius: 1,
                  height: 5,
                  exprs: { "center[0]": "R*cos(i*360/N)", "center[1]": "R*sin(i*360/N)" },
                },
              ],
            },
          },
        ],
      },
    });
    expect(result.applied).toBe(4);
    expect(result.rejected).toBe(0);
    expect(result.stackLength).toBe(4);
    expect(result.model).not.toBeNull();
    const persisted = (await readEdits(stpModel)).ops;
    expect(persisted).toHaveLength(4);
    expect(persisted.every((op: any) => op.exprs === undefined)).toBe(true);
  });

  it("a plain op step's exprs stay live in the persisted sidecar", async () => {
    const result = await runParametricScriptTool(ctx(), {
      path: stpModel,
      script: {
        steps: [{ op: { op: "addBox", center: [0, 0, 0], size: [20, 10, 5], exprs: { "size[0]": "L" } } }],
      },
    });
    expect(result.applied).toBe(1);
    const persisted = (await readEdits(stpModel)).ops;
    expect(persisted[0].exprs).toEqual({ "size[0]": "L" });
  });

  it("rejects BREP_ONLY_OPS compiled for a mesh-format source but persists mesh-legal ones", async () => {
    const result = await runParametricScriptTool(ctx(), {
      path: stlModel,
      script: {
        steps: [
          { op: { op: "addWedge", center: [0, 0, 0], axis: [0, 0, 1], up: [1, 0, 0], dx: 1, dy: 1, dz: 1, ltx: 0 } },
          { op: { op: "translate", targets: ["node-0"], vec: [1, 0, 0] } },
        ],
      },
    });
    expect(result.applied).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.warnings.some((w: string) => /B-rep only/.test(w))).toBe(true);
    expect((await readEdits(stlModel)).ops).toHaveLength(1);
  });

  it("dryRun compiles and reports without persisting", async () => {
    const result = await runParametricScriptTool(ctx(), {
      path: stpModel,
      script: { steps: [{ op: { op: "addSphere", center: [0, 0, 0], radius: 2 } }] },
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.applied).toBe(0);
    expect(result.report[0]).toMatchObject({ kind: "op", applied: 1 });
    await expect(fs.access(editsSidecarPath(stpModel))).rejects.toThrow();
  });

  it("surfaces per-step rejection reasons without throwing", async () => {
    const result = await runParametricScriptTool(ctx(), {
      path: stpModel,
      script: { steps: [{ op: { op: "addBox" } }, { repeat: { times: 2, indexVar: "not valid!", body: [] } }] },
    });
    expect(result.applied).toBe(0);
    expect(result.rejected).toBe(2);
    expect(result.report).toHaveLength(2);
  });
});

describe("remove_edit_op", () => {
  it("removes by index and rejects out-of-range", async () => {
    const c = ctx();
    await applyEditOps(c, {
      path: stpModel,
      ops: [
        { op: "addBox", center: [0, 0, 0], size: [1, 1, 1] },
        { op: "addSphere", center: [0, 0, 0], radius: 2 },
      ],
    });
    const result = await removeEditOp({ path: stpModel, index: 0 });
    expect(result.stackLength).toBe(1);
    const remaining = await readEdits(stpModel);
    expect(remaining.ops[0].op).toBe("addSphere");
    await expect(removeEditOp({ path: stpModel, index: 5 })).rejects.toThrow(/out of range/i);
  });
});

describe("set_variables", () => {
  it("evaluates top-down and re-resolves op expression caches", async () => {
    const c = ctx();
    await applyEditOps(c, {
      path: stpModel,
      ops: [{ op: "addBox", center: [0, 0, 0], size: [1, 1, 1], exprs: { "size[0]": "L" } }],
    });
    const result = await setVariables({
      path: stpModel,
      variables: [
        { name: "L", expr: "20" },
        { name: "W", expr: "L/2" },
      ],
    });
    expect(result.variables).toEqual([
      { name: "L", expr: "20", value: 20, error: null },
      { name: "W", expr: "L/2", value: 10, error: null },
    ]);
    const { ops } = await readEdits(stpModel);
    expect((ops[0] as { size: number[] }).size[0]).toBe(20);
  });

  it("reports a forward reference as an error and freezes the value", async () => {
    const result = await setVariables({
      path: stpModel,
      variables: [
        { name: "A", expr: "B+1" },
        { name: "B", expr: "5" },
      ],
    });
    expect(result.variables[0].error).toBeTruthy();
    expect(result.variables[0].value).toBe(0); // frozen at the (fresh) cache
    expect(result.variables[1].value).toBe(5);
  });
});

describe("set_part", () => {
  it("upserts, updates, and removes parts", async () => {
    await setPart({ path: stpModel, name: "Inlet", surfaces: ["face-0"], meshSize: 0.5 });
    await setPart({ path: stpModel, name: "Inlet", meshSize: 0.25 });
    let parts = await readParts(stpModel);
    expect(parts).toHaveLength(1);
    expect(parts[0].surfaces).toEqual(["face-0"]); // kept from the first call
    expect(parts[0].meshSize).toBe(0.25);
    await setPart({ path: stpModel, name: "Inlet", remove: true });
    parts = await readParts(stpModel);
    expect(parts).toHaveLength(0);
    await expect(setPart({ path: stpModel, name: "Inlet", remove: true })).rejects.toThrow(/no part/i);
  });

  it("clears meshSize with null and warns on invalid meshSize", async () => {
    await setPart({ path: stpModel, name: "P", meshSize: 1 });
    await setPart({ path: stpModel, name: "P", meshSize: null });
    expect((await readParts(stpModel))[0].meshSize).toBeUndefined();
    const result = await setPart({ path: stpModel, name: "P", meshSize: -3 });
    expect(result.warnings[0]).toMatch(/positive/);
  });
});

describe("set_mesh_options", () => {
  it("merges, validates, persists, and regenerates the .geo script", async () => {
    const result = await setMeshOptions({ path: stpModel, options: { dimension: 2, sizeMax: 4 } });
    expect(result.options.dimension).toBe(2);
    expect(result.options.sizeMax).toBe(4);
    const geo = await fs.readFile(geoScriptPath(stpModel), "utf8");
    expect(geo).toContain("Mesh 2;");
    expect(geo).toContain("Mesh.MeshSizeMax = 4;");
  });

  it("warns when a field falls back to its default", async () => {
    const result = await setMeshOptions({ path: stpModel, options: { dimension: 7 as never } });
    expect(result.options.dimension).toBe(DEFAULT_MESH_OPTIONS.dimension);
    expect(result.warnings.some((w) => w.includes("dimension"))).toBe(true);
  });
});

describe("generate_mesh", () => {
  it("bakes edits to STEP bytes for B-rep sources and returns stats only", async () => {
    const c = ctx();
    await applyEditOps(c, { path: stpModel, ops: [{ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] }] });
    const result = await generateMeshTool(c, { path: stpModel, options: { sizeMax: 2 } });
    expect(c.pipeline.exportBRep).toHaveBeenCalledWith(dir, expect.any(Uint8Array), "step", "step", [
      { op: "addBox", center: [0, 0, 0], size: [1, 1, 1] },
    ]);
    const genCall = vi.mocked(c.pipeline.generateMesh).mock.lastCall!;
    expect(genCall[1]).toEqual({ kind: "brep", stepBytes: new Uint8Array([1, 2, 3]) });
    expect(genCall[2].sizeMax).toBe(2);
    expect(result.nodeCount).toBe(42);
    expect(result.elementCount).toBe(99);
    expect(result).not.toHaveProperty("positions");
    expect(result.quality).toBeNull(); // FAKE_MESH_RESULT has no quality field
  });

  it("surfaces the pipeline's quality summary when present", async () => {
    const c = ctx(
      fakePipeline({
        generateMesh: vi.fn(async () => ({
          ...FAKE_MESH_RESULT,
          quality: { min: 0.2, mean: 0.7, histogram: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
        })),
      })
    );
    const result = await generateMeshTool(c, { path: stpModel });
    expect(result.quality).toEqual({ min: 0.2, mean: 0.7, histogram: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
  });

  it("surfaces worst-element counts (not the index buffer) when present", async () => {
    const c = ctx(
      fakePipeline({
        generateMesh: vi.fn(async () => ({
          ...FAKE_MESH_RESULT,
          worstElements: { indices: new Uint32Array([0, 1, 2]), threshold: 0.2, shownCount: 5, belowThresholdCount: 7 },
        })),
      })
    );
    const result = await generateMeshTool(c, { path: stpModel });
    expect(result.worstElements).toEqual({ threshold: 0.2, shownCount: 5, belowThresholdCount: 7 });
    expect(result.worstElements).not.toHaveProperty("indices"); // display geometry, not agent-useful
  });

  it("worstElements is null when absent (a clean mesh, or a non-3D generate)", async () => {
    const c = ctx();
    const result = await generateMeshTool(c, { path: stpModel });
    expect(result.worstElements).toBeNull();
  });

  it("meshes raw STL bytes with the single-part size override and drops parts", async () => {
    const c = ctx();
    await setPart({ path: stlModel, name: "Only", meshSize: 0.5 });
    await applyEditOps(c, { path: stlModel, ops: [{ op: "translate", targets: ["node-0"], vec: [1, 0, 0] }] });
    const result = await generateMeshTool(c, { path: stlModel });
    const genCall = vi.mocked(c.pipeline.generateMesh).mock.lastCall!;
    expect(genCall[1].kind).toBe("stl");
    expect(genCall[2].sizeMin).toBe(0.5);
    expect(genCall[2].sizeMax).toBe(0.5);
    expect(genCall[3]).toEqual([]); // parts dropped for STL
    expect(result.warnings.some((w) => w.includes("NOT baked"))).toBe(true);
    expect(c.pipeline.exportBRep).not.toHaveBeenCalled();
  });

  it("rejects obj/ply/gltf sources with a clear message", async () => {
    await expect(generateMeshTool(ctx(), { path: objModel })).rejects.toThrow(/webview/i);
  });

  it("meshes meshio++-only sources via a host-side STL boundary conversion, with no webview involved", async () => {
    const c = ctx();
    const vtkModel = path.join(dir, "model.vtk");
    await fs.writeFile(vtkModel, "not real vtk content, mocked pipeline doesn't parse it", "utf8");
    await applyEditOps(c, { path: vtkModel, ops: [{ op: "translate", targets: ["node-0"], vec: [1, 0, 0] }] });
    const result = await generateMeshTool(c, { path: vtkModel });
    expect(c.pipeline.convertToStlBoundary).toHaveBeenCalledWith(expect.any(Uint8Array), "vtk");
    const genCall = vi.mocked(c.pipeline.generateMesh).mock.lastCall!;
    expect(genCall[1].kind).toBe("stl");
    expect(result.warnings.some((w) => w.includes("NOT baked"))).toBe(true);
    expect(c.pipeline.exportBRep).not.toHaveBeenCalled();
  });

  it("reports start (0) then done (1) progress when a callback is given", async () => {
    const c = ctx();
    const onProgress = vi.fn();
    await generateMeshTool(c, { path: stpModel }, onProgress);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls[0][0]).toMatchObject({ progress: 0, total: 1 });
    expect(onProgress.mock.calls[1][0]).toMatchObject({ progress: 1, total: 1 });
  });
});

describe("export_mesh", () => {
  it("routes msh through generateMesh's mshText", async () => {
    const c = ctx();
    const out = path.join(dir, "out.msh");
    const result = await exportMeshTool(c, { path: stpModel, format: "msh", outputPath: out });
    expect(await fs.readFile(out, "utf8")).toBe(FAKE_MESH_RESULT.mshText);
    expect(result.written.map((w) => w.path)).toEqual([out]);
  });

  it("writes the XAO companion and rewrites the Merge stub for geoUnrolled", async () => {
    const out = path.join(dir, "out.geo_unrolled");
    const result = await exportMeshTool(ctx(), { path: stpModel, format: "geoUnrolled", outputPath: out });
    expect(await fs.readFile(out, "utf8")).toBe('Merge "out.geo_unrolled.xao";\n');
    expect(new Uint8Array(await fs.readFile(`${out}.xao`))).toEqual(new Uint8Array([9]));
    expect(result.written.map((w) => w.path)).toEqual([out, `${out}.xao`]);
  });

  it("writes geoUnrolled without a companion when xao is null (STL path)", async () => {
    const pipeline = fakePipeline({
      exportGeoUnrolled: vi.fn(async () => ({ text: "// inline geo\n", xao: null })),
    });
    const out = path.join(dir, "out.geo_unrolled");
    const result = await exportMeshTool(ctx(pipeline), { path: stlModel, format: "geoUnrolled", outputPath: out });
    expect(result.written).toHaveLength(1);
    await expect(fs.access(`${out}.xao`)).rejects.toThrow();
  });

  it("routes mdpa modes through exportMdpa and generic ids through exportMeshFormat", async () => {
    const c = ctx();
    await exportMeshTool(c, { path: stpModel, format: "mdpaGeometries", outputPath: path.join(dir, "o.mdpa") });
    expect(vi.mocked(c.pipeline.exportMdpa).mock.lastCall![4]).toBe("geometries");
    await exportMeshTool(c, { path: stpModel, format: "vtk", outputPath: path.join(dir, "o.vtk") });
    expect(vi.mocked(c.pipeline.exportMeshFormat).mock.lastCall![4]).toBe("vtk");
    expect(await fs.readFile(path.join(dir, "o.vtk"), "utf8")).toBe("vtk-content");
  });

  it("rejects unknown formats and refuses to overwrite the source", async () => {
    await expect(
      exportMeshTool(ctx(), { path: stpModel, format: "docx", outputPath: path.join(dir, "o.docx") })
    ).rejects.toThrow(/unknown mesh export format/i);
    await expect(
      exportMeshTool(ctx(), { path: stpModel, format: "msh", outputPath: stpModel })
    ).rejects.toThrow(/source/i);
  });

  it("bridges med/cgns through meshio with no companion file, fed generateMesh's MSH 4.1 text", async () => {
    const c = ctx();
    const out = path.join(dir, "out.med");
    const result = await exportMeshTool(c, { path: stpModel, format: "med", outputPath: out });
    // meshio++ 9.7.0 reads MSH 4.1 natively — the bridge takes generateMesh's
    // own mshText directly, no legacy msh2 re-export detour.
    expect(vi.mocked(c.pipeline.exportViaMeshio).mock.lastCall).toEqual([FAKE_MESH_RESULT.mshText, "med"]);
    expect(c.pipeline.exportMeshFormat).not.toHaveBeenCalled();
    expect(await fs.readFile(out, "utf8")).toBe("fake-meshio-bytes");
    expect(result.written.map((w) => w.path)).toEqual([out]);
  });

  it("writes the HDF5 companion and rewrites embedded references for xdmf", async () => {
    const pipeline = fakePipeline({
      exportViaMeshio: vi.fn(async () => ({
        bytes: new TextEncoder().encode('<DataItem Format="HDF">out.h5:/data0</DataItem>'),
        companion: { name: "out.h5", bytes: new Uint8Array([1, 2, 3]) },
      })),
    });
    const out = path.join(dir, "result.xdmf");
    const result = await exportMeshTool(ctx(pipeline), { path: stpModel, format: "xdmf", outputPath: out });
    const text = await fs.readFile(out, "utf8");
    expect(text).toBe('<DataItem Format="HDF">result.h5:/data0</DataItem>');
    const h5Path = path.join(dir, "result.h5");
    expect(new Uint8Array(await fs.readFile(h5Path))).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.written.map((w) => w.path)).toEqual([out, h5Path]);
    expect(result.warnings.some((w) => w.includes("companion"))).toBe(true);
  });

  it("reports start (0) then done (1) progress when a callback is given", async () => {
    const c = ctx();
    const onProgress = vi.fn();
    const out = path.join(dir, "progress.msh");
    await exportMeshTool(c, { path: stpModel, format: "msh", outputPath: out }, onProgress);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls[0][0]).toMatchObject({ progress: 0, total: 1 });
    expect(onProgress.mock.calls[1][0]).toMatchObject({ progress: 1, total: 1 });
  });
});

describe("export_brep", () => {
  it("exports with edits baked and refuses same-format/mesh/source-overwrite targets", async () => {
    const c = ctx();
    await applyEditOps(c, { path: stpModel, ops: [{ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] }] });
    const out = path.join(dir, "out.brep");
    const result = await exportBRepTool(c, { path: stpModel, targetFormat: "brep", outputPath: out });
    expect(result.editsBaked).toBe(1);
    expect(new Uint8Array(await fs.readFile(out))).toEqual(new Uint8Array([1, 2, 3]));

    await expect(exportBRepTool(c, { path: stpModel, targetFormat: "step", outputPath: out })).rejects.toThrow(
      /invalid target/i
    );
    await expect(exportBRepTool(c, { path: stpModel, targetFormat: "stl", outputPath: out })).rejects.toThrow(
      /invalid target/i
    );
    await expect(exportBRepTool(c, { path: stlModel, targetFormat: "step", outputPath: out })).rejects.toThrow(
      /no B-rep/i
    );
    await expect(exportBRepTool(c, { path: stpModel, targetFormat: "brep", outputPath: stpModel })).rejects.toThrow(
      /source/i
    );
  });
});

describe("get_state", () => {
  it("returns edits with descriptions, variables, parts, and mesh options without WASM", async () => {
    const c = ctx();
    await applyEditOps(c, { path: stpModel, ops: [{ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] }] });
    await setPart({ path: stpModel, name: "P", volumes: ["solid-0"] });
    const state = await getState({ path: stpModel });
    expect(state.edits[0].description).toMatch(/box/i);
    expect(state.parts[0].name).toBe("P");
    expect(state.meshOptions).toEqual(DEFAULT_MESH_OPTIONS);
  });
});

describe("rewriteGeoMerge", () => {
  it("rewrites the MEMFS stub to the sibling name", () => {
    expect(rewriteGeoMerge('Merge "/out.geo_unrolled.xao";\n', "model.geo_unrolled.xao")).toBe(
      'Merge "model.geo_unrolled.xao";\n'
    );
    expect(rewriteGeoMerge("// no merge\n", "x.xao")).toBe("// no merge\n");
  });
});

describe("save_preprocess", () => {
  it("bundles the source + whichever sidecars exist, omitting the rest", async () => {
    await applyEditOps(ctx(), { path: stpModel, ops: [{ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] }] });
    await setPart({ path: stpModel, name: "P", volumes: ["solid-0"] });
    // Mesh options sidecar deliberately never written for this model.

    const zipOut = path.join(dir, "model.preprocess.zip");
    const result = await savePreprocessTool({ path: stpModel, outputPath: zipOut });

    expect(result.included).toEqual({ source: "model.stp", parts: true, edits: true, meshOptions: false, geo: false });
    expect((await fs.stat(zipOut)).size).toBeGreaterThan(0);
  });

  it("refuses to write the archive over the CAD source file", async () => {
    await expect(savePreprocessTool({ path: stpModel, outputPath: stpModel })).rejects.toThrow(/source/i);
  });
});

describe("load_preprocess", () => {
  it("round-trips the source + edits + parts sidecars to a new location", async () => {
    await applyEditOps(ctx(), { path: stpModel, ops: [{ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] }] });
    await setPart({ path: stpModel, name: "P", volumes: ["solid-0"] });
    const zipOut = path.join(dir, "model.preprocess.zip");
    await savePreprocessTool({ path: stpModel, outputPath: zipOut });

    const restored = path.join(dir, "restored.stp");
    const result = await loadPreprocessTool({ zipPath: zipOut, outputPath: restored });

    expect(result.manifestSource).toBe("model.stp");
    expect(result.restored).toEqual({ parts: true, edits: true, meshOptions: false });
    expect(await fs.readFile(restored, "utf8")).toBe(await fs.readFile(stpModel, "utf8"));

    const restoredEdits = await readEdits(restored);
    expect(restoredEdits.ops).toEqual([{ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] }]);
    const restoredParts = await readParts(restored);
    expect(restoredParts[0].name).toBe("P");
    await expect(fs.access(partsSidecarPath(restored))).resolves.toBeUndefined();
    await expect(fs.access(editsSidecarPath(restored))).resolves.toBeUndefined();
  });

  it("refuses when zipPath and outputPath are the same file", async () => {
    const zipOut = path.join(dir, "model.preprocess.zip");
    await savePreprocessTool({ path: stpModel, outputPath: zipOut });
    await expect(loadPreprocessTool({ zipPath: zipOut, outputPath: zipOut })).rejects.toThrow(/different/i);
  });

  it("rejects an outputPath with an unsupported extension", async () => {
    const zipOut = path.join(dir, "model.preprocess.zip");
    await savePreprocessTool({ path: stpModel, outputPath: zipOut });
    await expect(
      loadPreprocessTool({ zipPath: zipOut, outputPath: path.join(dir, "restored.txt") })
    ).rejects.toThrow(/unsupported/i);
  });
});
