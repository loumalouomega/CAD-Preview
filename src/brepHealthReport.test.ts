import { describe, expect, it } from "vitest";
import { capFreeBoundaries, capIssues, MAX_REPORTED_FREE_BOUNDARIES, MAX_REPORTED_ISSUES, statusNameTable, statusNames, summarizeBrepHealth, type BrepHealthReport } from "./brepHealthReport";

const ENUM = {
  values: {},
  BRepCheck_NoError: { value: 0 },
  BRepCheck_FreeEdge: { value: 13 },
  BRepCheck_NotClosed: { value: 28 },
  notAStatus: { value: 99 },
};

describe("brepHealthReport", () => {
  it("builds a value→name table from the bound enum", () => {
    const t = statusNameTable(ENUM);
    expect(t[0]).toBe("NoError");
    expect(t[28]).toBe("NotClosed");
    expect(t[99]).toBeUndefined();
  });

  it("drops NoError, de-duplicates, keeps unknowns as #n", () => {
    const t = statusNameTable(ENUM);
    expect(statusNames([0, 28, 13, 28, 0, 42], t)).toEqual(["NotClosed", "FreeEdge", "#42"]);
    expect(statusNames([0, 0], t)).toEqual([]);
  });

  it("caps the issue list", () => {
    const many = Array.from({ length: MAX_REPORTED_ISSUES + 5 }, (_, i) => ({ id: `edge-${i}`, statuses: [], valid: false }));
    expect(capIssues(many)).toHaveLength(MAX_REPORTED_ISSUES);
    expect(capIssues(many.slice(0, 3))).toHaveLength(3);
  });

  it("summarizes facts, never a pass/fail of its own", () => {
    const base: BrepHealthReport = { valid: true, counters: null, openBoundaryEdgeCount: 0, freeBoundaries: null, freeBoundaryCount: null, solids: [], issues: [], issueCount: 0, analyzedSubshapes: 1, elapsedMs: 1 };
    expect(summarizeBrepHealth(base)).toBe("valid per BRepCheck");
    expect(summarizeBrepHealth({ ...base, valid: false, issueCount: 5, openBoundaryEdgeCount: 4 })).toBe(
      "INVALID per BRepCheck · 5 subshape issue(s) · 4 open-boundary edge(s)"
    );
    expect(
      summarizeBrepHealth({
        ...base,
        openBoundaryEdgeCount: 48,
        freeBoundaries: [{ closed: true, edgeCount: 4, length: 8 }, { closed: false, edgeCount: 2, length: 3 }],
        freeBoundaryCount: 2,
        solids: [{ solidId: "solid-0", valid: true, shellCount: 1, openShellCount: 0, openBoundaryEdgeCount: 0, signedVolume: -5 }],
      })
    ).toBe("valid per BRepCheck · 48 open-boundary edge(s) · 2 free boundaries (1 closed) · 1 reversed solid(s)");
  });

  it("caps free boundaries with closed wires first", () => {
    const wires = Array.from({ length: MAX_REPORTED_FREE_BOUNDARIES + 5 }, (_, i) => ({ closed: i % 2 === 1, edgeCount: 1, length: i }));
    const capped = capFreeBoundaries(wires);
    expect(capped).toHaveLength(MAX_REPORTED_FREE_BOUNDARIES);
    expect(capped[0].closed).toBe(true);
    expect(capFreeBoundaries(wires.slice(0, 2)).map((w) => w.closed)).toEqual([true, false]);
  });
});
