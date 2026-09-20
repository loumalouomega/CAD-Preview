import { describe, it, expect } from "vitest";
import { sweepTsv, sweepOutputName, type MeshSweepRun } from "./meshSweep";

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
