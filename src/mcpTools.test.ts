import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  describeCapabilities,
  allOpKinds,
  OP_PARAM_DOCS,
  loadModel,
  getState,
  applyEditOps,
  removeEditOp,
  setVariables,
  setPart,
  setMeshOptions,
  generateMeshTool,
  exportMeshTool,
  exportBRepTool,
  rewriteGeoMerge,
  type Pipeline,
  type ToolContext,
} from "./mcpTools";
import { readEdits, readParts, editsSidecarPath, geoScriptPath } from "./mcpSidecars";
import { MESH_EXPORT_FORMATS } from "./meshExportFormats";
import { BREP_ONLY_OPS, TOPOLOGY_CHANGING_OPS } from "./editOps";
import { DEFAULT_MESH_OPTIONS } from "./meshOptions";
import type { BRepResult } from "./occtService";
import type { MeshResult } from "./gmshService";

let dir: string;
let stpModel: string;
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

function fakePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    loadBRep: vi.fn(async () => FAKE_BREP_RESULT),
    exportBRep: vi.fn(async () => new Uint8Array([1, 2, 3])),
    generateMesh: vi.fn(async () => FAKE_MESH_RESULT),
    exportMeshFormat: vi.fn(async () => "vtk-content"),
    exportMdpa: vi.fn(async () => "Begin Nodes\nEnd Nodes\n"),
    exportGeoUnrolled: vi.fn(async () => ({ text: 'Merge "/out.geo_unrolled.xao";\n', xao: new Uint8Array([9]) })),
    ...overrides,
  } as Pipeline;
}

function ctx(pipeline: Pipeline = fakePipeline()): ToolContext {
  return { pipeline, extensionPath: dir };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-tools-"));
  stpModel = path.join(dir, "model.stp");
  stlModel = path.join(dir, "model.stl");
  objModel = path.join(dir, "model.obj");
  await fs.writeFile(stpModel, "ISO-10303-21;", "utf8");
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
