import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { remeshMeshTool, type Pipeline, type ToolContext } from "./mcpTools";

let dir: string, ctx: ToolContext;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmg-tool-"));
  fs.writeFileSync(path.join(dir, "source.med"), "source");
  fs.writeFileSync(path.join(dir, "source.stp"), "STEP source");
  ctx = { extensionPath: dir, pipeline: {
    remeshMesh: vi.fn(async () => ({ bytes: Buffer.from("remeshed"), report: { module: "mmg3d", inputCells: 2, outputCells: 37 }, regionNames: [], warnings: ["fields dropped"] })),
    convertToStlBoundaryWithRegions: vi.fn(async () => ({ stlBytes: Buffer.from("solid empty\nendsolid empty") })),
    exportBRep: vi.fn(async () => Buffer.from("meshing STEP")),
    generateMesh: vi.fn(async () => ({ mshText: "MSH mesh", warnings: [] })),
  } as unknown as Pipeline };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("remesh_mesh orchestration", () => {
  it("writes only a new MED file and a compatible Parts sidecar", async () => {
    const source = path.join(dir, "source.med"), out = path.join(dir, "new.med");
    const result = await remeshMeshTool(ctx, { path: source, outputPath: out, options: { hmax: 0.6 } });
    expect(fs.readFileSync(source, "utf8")).toBe("source");
    expect(fs.readFileSync(out, "utf8")).toBe("remeshed");
    expect(JSON.parse(fs.readFileSync(out + ".parts.json", "utf8")).parts).toEqual([]);
    expect(result.warnings).toContain("fields dropped");
    expect(ctx.pipeline.remeshMesh).toHaveBeenCalledWith(dir, expect.any(Uint8Array), "med", { hmax: 0.6 }, "source.med", expect.any(Array));
  });
  it("generated mode uses edited generation input and mesh options", async () => {
    const source = path.join(dir, "source.stp");
    const edits = [{ op: "translate", targets: ["solid-0"], vec: [1, 0, 0] }];
    fs.writeFileSync(source + ".edits.json", JSON.stringify({ version: 1, ops: edits }));
    await remeshMeshTool(ctx, { path: source, source: "generated", outputPath: path.join(dir, "generated.med"), meshOptions: { sizeMax: 2 } });
    expect(ctx.pipeline.generateMesh).toHaveBeenCalledWith(dir, { kind: "brep", stepBytes: expect.any(Uint8Array) }, expect.objectContaining({ sizeMax: 2 }), []);
    expect(ctx.pipeline.exportBRep).toHaveBeenCalledWith(dir, expect.any(Uint8Array), "step", "step", edits, "mm", false);
    expect(ctx.pipeline.remeshMesh).toHaveBeenCalledWith(dir, expect.any(Uint8Array), "gmsh", {}, undefined, undefined);
    expect(fs.readFileSync(source, "utf8")).toBe("STEP source");
  });
  it("refuses source overwrites, wrong extensions, unrecognised options and wrong routes", async () => {
    const source = path.join(dir, "source.med");
    for (const params of [
      { path: source, outputPath: source }, { path: source, outputPath: path.join(dir, "x.stl") },
      { path: source, outputPath: path.join(dir, "x.med"), options: { optimOnly: true } },
      { path: path.join(dir, "source.stp"), outputPath: path.join(dir, "x.med") },
    ]) await expect(remeshMeshTool(ctx, params as Parameters<typeof remeshMeshTool>[1])).rejects.toThrow();
    expect(ctx.pipeline.remeshMesh).not.toHaveBeenCalled();
  });
  it("does not write output after a kernel failure", async () => {
    vi.mocked(ctx.pipeline.remeshMesh).mockRejectedValueOnce(new Error("MMG strong failure"));
    const out = path.join(dir, "x.med");
    await expect(remeshMeshTool(ctx, { path: path.join(dir, "source.med"), outputPath: out })).rejects.toThrow(/strong failure/);
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(out + ".parts.json")).toBe(false);
  });
  it("refuses existing output, sidecars and aliases without touching them", async () => {
    const source = path.join(dir, "source.med"), out = path.join(dir, "existing.med");
    fs.symlinkSync(source, out);
    await expect(remeshMeshTool(ctx, { path: source, outputPath: out })).rejects.toThrow(/unused/);
    expect(fs.readFileSync(source, "utf8")).toBe("source");
    const fresh = path.join(dir, "fresh.med");
    fs.writeFileSync(fresh + ".parts.json", "user metadata");
    await expect(remeshMeshTool(ctx, { path: source, outputPath: fresh })).rejects.toThrow(/unused/);
    expect(fs.readFileSync(fresh + ".parts.json", "utf8")).toBe("user metadata");
    expect(ctx.pipeline.remeshMesh).not.toHaveBeenCalled();
  });
  it("does not overwrite a Parts sidecar created while the kernel ran", async () => {
    const out = path.join(dir, "raced.med");
    vi.mocked(ctx.pipeline.convertToStlBoundaryWithRegions).mockImplementationOnce(async () => {
      fs.writeFileSync(out + ".parts.json", "user metadata");
      return { stlBytes: Buffer.from("solid empty\nendsolid empty") };
    });
    await expect(remeshMeshTool(ctx, { path: path.join(dir, "source.med"), outputPath: out })).rejects.toThrow();
    expect(fs.readFileSync(out + ".parts.json", "utf8")).toBe("user metadata");
  });
});
