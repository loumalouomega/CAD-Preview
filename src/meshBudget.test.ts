import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { estimateMeshBudget, budgetWarning, formatBytes, formatCountRange } from "./meshBudget";

const calibration = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "scripts", "perf", "mesh-budget-calibration.json"), "utf8")
) as { rows: Array<{ name: string; V: number; A: number; dim: 2 | 3; order: 1 | 2; shape: "simplex" | "subdivided"; h: number; el: number; nodes: number }> };
const BBOX: Record<string, [number, number, number]> = {
  block: [3, 4, 5],
  bull: [161.29, 35.04, 84.04],
  angle1: [50.8, 50.8, 50.8],
};

describe("estimateMeshBudget — predicted vs actual (the recorded Gmsh corpus)", () => {
  for (const r of calibration.rows) {
    it(`${r.name} ${r.dim}D order ${r.order} ${r.shape} h=${r.h}: actual ${r.el} el lies inside the reported range`, () => {
      const b = estimateMeshBudget({
        volume: r.V,
        area: r.A,
        bboxSize: BBOX[r.name],
        sizeMax: r.h,
        dimension: r.dim,
        elementOrder: r.order,
        elementShape: r.shape,
      });
      expect(b.status).toBe("ok");
      expect(r.el).toBeGreaterThanOrEqual(b.elements.low);
      expect(r.el).toBeLessThanOrEqual(b.elements.high);
      expect(r.nodes).toBeGreaterThanOrEqual(b.nodes.low * 0.95);
      expect(r.nodes).toBeLessThanOrEqual(b.nodes.high * 1.05);
    });
  }
});

describe("estimateMeshBudget — scaling behaviour", () => {
  const base = { volume: 1e6, area: 6e4, bboxSize: [100, 100, 100] as [number, number, number], elementShape: "simplex" as const };
  it("halving the size grows a volume-dominated 3D mesh ~8× and a 2D mesh ~4×", () => {
    const a = estimateMeshBudget({ ...base, sizeMax: 2, dimension: 3 }).elements.mid;
    const b = estimateMeshBudget({ ...base, sizeMax: 1, dimension: 3 }).elements.mid;
    expect(b / a).toBeGreaterThan(7);
    expect(b / a).toBeLessThanOrEqual(8);
    const c = estimateMeshBudget({ ...base, sizeMax: 2, dimension: 2 }).elements.mid;
    const d = estimateMeshBudget({ ...base, sizeMax: 1, dimension: 2 }).elements.mid;
    expect(d / c).toBeGreaterThan(3.5);
    expect(d / c).toBeLessThanOrEqual(4);
  });
  it("is unit-invariant: the same part expressed ×25.4 larger with a ×25.4 size gives the same counts", () => {
    const k = 25.4;
    const a = estimateMeshBudget({ ...base, sizeMax: 3, dimension: 3 });
    const b = estimateMeshBudget({ volume: base.volume * k ** 3, area: base.area * k ** 2, bboxSize: [100 * k, 100 * k, 100 * k], sizeMax: 3 * k, dimension: 3 });
    expect(b.elements).toEqual(a.elements);
  });
});

describe("estimateMeshBudget — honesty", () => {
  it("an open (non-watertight) 3D volume is unavailable, not a guess", () => {
    const b = estimateMeshBudget({ volume: null, area: 10, bboxSize: [1, 1, 1], sizeMax: 0.1, dimension: 3 });
    expect(b.status).toBe("unavailable");
    expect(b.reason).toMatch(/not a closed volume/);
  });
  it("the unbounded sizeMax sentinel is unavailable", () => {
    expect(estimateMeshBudget({ bboxSize: [1, 1, 1], sizeMax: 1e22, dimension: 3 }).status).toBe("unavailable");
  });
  it("a coarse size, local sizing, hex-dominant and fTetWild are all flagged, never calibrated", () => {
    const coarse = estimateMeshBudget({ volume: 60, area: 94, bboxSize: [3, 4, 5], sizeMax: 1, dimension: 3 });
    expect(coarse.confidence).toBe("rough");
    expect(coarse.elements.high).toBeGreaterThanOrEqual(1282); // the real, 2.6×-over coarse block run
    expect(estimateMeshBudget({ volume: 1e6, area: 6e4, bboxSize: [100, 100, 100], sizeMax: 2, dimension: 3, localSizing: true }).confidence).toBe("uncertain");
    expect(estimateMeshBudget({ volume: 1e6, area: 6e4, bboxSize: [100, 100, 100], sizeMax: 2, dimension: 3, elementShape: "hexDominant" }).confidence).toBe("uncertain");
    expect(estimateMeshBudget({ volume: 1e6, area: 6e4, bboxSize: [100, 100, 100], sizeMax: 2, dimension: 3, engine: "ftetwild" }).confidence).toBe("uncertain");
  });
  it("falls back to the bounding box with a stated assumption when facts are missing", () => {
    const b = estimateMeshBudget({ bboxSize: [10, 10, 10], sizeMax: 1, dimension: 3 });
    expect(b.basis).toBe("bbox");
    expect(b.assumptions.join(" ")).toMatch(/bounding box/);
  });
});

describe("budgetWarning / formatting", () => {
  const b = estimateMeshBudget({ volume: 1e6, area: 6e4, bboxSize: [100, 100, 100], sizeMax: 1, dimension: 3 });
  it("warns above and near a budget, stays quiet within or without one", () => {
    expect(budgetWarning(b, 1000)).toMatch(/above your 1k-element budget/);
    expect(budgetWarning(b, b.elements.mid)).toMatch(/may exceed/);
    expect(budgetWarning(b, b.elements.high * 2)).toBeNull();
    expect(budgetWarning(b, undefined)).toBeNull();
  });
  it("formats counts and bytes compactly", () => {
    expect(formatCountRange({ low: 1200, high: 3_400_000 })).toBe("1.2k–3.4M");
    expect(formatBytes(2_500_000)).toBe("2.5 MB");
  });
});
