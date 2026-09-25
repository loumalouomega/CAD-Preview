import { describe, it, expect } from "vitest";
import { sweepTsv, sweepOutputName, runMeshSweep, parseSweepSizes, validateSweepSizes, MAX_SWEEP_RUNS, type MeshSweepRun } from "./meshSweep";
import { DEFAULT_MESH_OPTIONS, type MeshOptions } from "./meshOptions";

const okRow: MeshSweepRun = {
  size: 2,
  status: "ok",
  nodeCount: 421,
  elementCount: 1893,
  elapsedMs: 3217,
  engineUsed: "gmsh",
  quality: { min: 0.043, mean: 0.71, histogram: [1, 2, 3] },
  outputPaths: ["/tmp/bull-size-2.msh"],
  error: null,
};

const errRow: MeshSweepRun = {
  size: 0.25,
  status: "error",
  nodeCount: null,
  elementCount: null,
  elapsedMs: null,
  engineUsed: null,
  quality: null,
  outputPaths: [],
  error: "Gmsh crashed while meshing (boom).",
};

describe("sweepTsv", () => {
  it("emits a header plus one tab-separated line per run", () => {
    const lines = sweepTsv([okRow, errRow]).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      "size_mm\tstatus\tnodes\telements\telapsed_ms\tengine\tquality_min\tquality_mean\toutputs\terror"
    );
    expect(lines[1]).toBe("2\tok\t421\t1893\t3217\tgmsh\t0.043\t0.71\t/tmp/bull-size-2.msh\t");
    expect(lines[2]).toBe("0.25\terror\t\t\t\t\t\t\t\tGmsh crashed while meshing (boom).");
  });

  it("rounds display numbers to 4 decimals without touching the row", () => {
    const lines = sweepTsv([{ ...okRow, size: 1 / 3, quality: { min: 0.123456, mean: 0.987654, histogram: [] } }]).split(
      "\n"
    );
    expect(lines[1].startsWith("0.3333\t")).toBe(true);
    expect(lines[1]).toContain("\t0.1235\t0.9877\t");
    expect(okRow.size).toBe(2);
  });

  it("joins multiple outputs with semicolons", () => {
    const lines = sweepTsv([{ ...okRow, outputPaths: ["/tmp/a.msh", "/tmp/a.msh.xao"] }]).split("\n");
    expect(lines[1]).toContain("/tmp/a.msh;/tmp/a.msh.xao\t");
  });
});

describe("sweepOutputName", () => {
  it("encodes the stem, size, and extension with no directory", () => {
    expect(sweepOutputName("bull", 2, "msh")).toBe("bull-size-2.msh");
    expect(sweepOutputName("bull.stp", 0.5, "msh")).toBe("bull.stp-size-0.5.msh");
  });
});

describe("runMeshSweep (shared by compare_mesh_refinement and the FE Mesh panel)", () => {
  const fakeResult = (o: MeshOptions) => ({
    nodeCount: Math.round(100 / o.sizeMax),
    elementCount: Math.round(400 / o.sizeMax),
    engineUsed: "gmsh" as const,
    quality: { min: 0.3, mean: 0.7, histogram: [] },
    warnings: [`w${o.sizeMax}`],
  });

  it("meshes each size uniformly over the same base options, in order", async () => {
    const seen: MeshOptions[] = [];
    const warnings: string[] = [];
    const runs = await runMeshSweep([4, 2], { ...DEFAULT_MESH_OPTIONS, dimension: 2 }, async (o) => {
      seen.push(o);
      return fakeResult(o);
    }, { warnings });
    expect(seen.map((o) => [o.sizeMin, o.sizeMax, o.dimension])).toEqual([[4, 4, 2], [2, 2, 2]]);
    expect(runs.map((r) => [r.size, r.status, r.nodeCount, r.elementCount])).toEqual([[4, "ok", 25, 100], [2, "ok", 50, 200]]);
    expect(warnings).toEqual(["w4", "w2"]);
  });

  it("turns a failed generate or output write into a row, never a thrown sweep", async () => {
    const runs = await runMeshSweep(
      [3, 2, 1],
      DEFAULT_MESH_OPTIONS,
      async (o) => {
        if (o.sizeMax === 2) throw new Error("PLC Error");
        return fakeResult(o);
      },
      {
        warnings: [],
        writeOutputs: async (size) => {
          if (size === 1) throw new Error("disk full");
          return [`/out-${size}.msh`];
        },
      }
    );
    expect(runs.map((r) => [r.status, r.error, r.outputPaths])).toEqual([
      ["ok", null, ["/out-3.msh"]],
      ["error", "PLC Error", []],
      ["error", "disk full", []],
    ]);
  });
});

describe("parseSweepSizes / validateSweepSizes", () => {
  it("accepts commas, spaces and semicolons", () => {
    expect(parseSweepSizes(" 4, 2 1;0.5 ")).toEqual([4, 2, 1, 0.5]);
  });
  it("refuses empty, non-numeric, non-positive and over-cap input", () => {
    expect(() => parseSweepSizes("  ")).toThrow(/Enter one or more/);
    expect(() => parseSweepSizes("4, x")).toThrow(/"x" is not a number/);
    expect(() => parseSweepSizes("4, 0")).toThrow(/finite positive/);
    expect(() => validateSweepSizes(Array.from({ length: MAX_SWEEP_RUNS + 1 }, () => 1))).toThrow(/capped at/);
  });
});
