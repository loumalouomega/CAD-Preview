import { describe, it, expect } from "vitest";
import { formatEntityCounts, formatMeshStats, formatMeshStatsLong, formatMeshHeaderStat, formatCursor, unsavedEditsLabel } from "./dockStats";

describe("formatEntityCounts", () => {
  it("reads as a plain list of facts", () => {
    expect(formatEntityCounts({ faces: 36, edges: 98, points: 64 })).toBe("36 faces · 98 edges · 64 points");
  });

  it("uses the singular for exactly one, so 1 face never reads '1 faces'", () => {
    expect(formatEntityCounts({ faces: 1, edges: 1, points: 1 })).toBe("1 face · 1 edge · 1 point");
  });

  it("keeps zero plural — a wireframe-only document has '0 faces'", () => {
    expect(formatEntityCounts({ faces: 0, edges: 12, points: 8 })).toBe("0 faces · 12 edges · 8 points");
  });

  it("groups thousands with a fixed locale, so the text does not depend on the host machine", () => {
    // `toLocaleString()` with no argument would print "12.480" in de-DE.
    expect(formatEntityCounts({ faces: 12480, edges: 1000, points: 999 })).toBe("12,480 faces · 1,000 edges · 999 points");
  });

  it("reports no solid count — the free-face 'Sketches' group would make it off by one", () => {
    expect(formatEntityCounts({ faces: 6, edges: 12, points: 8 })).not.toMatch(/solid/i);
  });
});

describe("formatMeshStats", () => {
  it("is the short form: elements and the worst element", () => {
    expect(formatMeshStats({ nodes: 12480, elements: 51200, minQuality: 0.4123 })).toBe("mesh 51,200 el · min SICN 0.412");
  });

  it("omits the quality when the mesher returned none, rather than printing NaN or 0", () => {
    expect(formatMeshStats({ nodes: 10, elements: 4 })).toBe("mesh 4 el");
    expect(formatMeshStats({ nodes: 10, elements: 4, minQuality: Number.NaN })).toBe("mesh 4 el");
    expect(formatMeshStats({ nodes: 10, elements: 4, minQuality: Number.POSITIVE_INFINITY })).toBe("mesh 4 el");
  });

  it("keeps a genuine zero quality — a degenerate element is a fact, not an absence", () => {
    expect(formatMeshStats({ nodes: 4, elements: 1, minQuality: 0 })).toBe("mesh 1 el · min SICN 0.000");
  });
});

describe("formatMeshStatsLong", () => {
  it("spells the facts out, node count included — the tooltip's form", () => {
    expect(formatMeshStatsLong({ nodes: 12480, elements: 51200, minQuality: 0.4123 })).toBe(
      "12,480 nodes · 51,200 elements · min SICN 0.412"
    );
    expect(formatMeshStatsLong({ nodes: 10, elements: 4 })).toBe("10 nodes · 4 elements");
    expect(formatMeshStatsLong({ nodes: 4, elements: 1, minQuality: 0 })).toBe("4 nodes · 1 element · min SICN 0.000");
  });
});

describe("formatCursor", () => {
  it("is empty when there is no point — the readout collapses instead of showing stale numbers", () => {
    expect(formatCursor(null, "mm")).toBe("");
  });

  it("is empty for a non-finite coordinate rather than printing NaN", () => {
    expect(formatCursor([1, Number.NaN, 3], "mm")).toBe("");
    expect(formatCursor([Number.POSITIVE_INFINITY, 0, 0], "mm")).toBe("");
  });

  it("prints millimetres as-is with two decimals and the unit", () => {
    expect(formatCursor([142.06, -18.4, 27], "mm")).toBe("x 142.06  y -18.40  z 27.00 mm");
  });

  it("converts to the display unit — the Units dropdown drives this readout too", () => {
    // 25.4 mm is exactly one inch.
    expect(formatCursor([25.4, 50.8, 0], "in")).toBe("x 1.00  y 2.00  z 0.00 in");
    expect(formatCursor([1000, 0, 0], "m")).toBe("x 1.00  y 0.00  z 0.00 m");
  });

  it("never prints a negative zero", () => {
    expect(formatCursor([-0, -0.0001, 0], "mm")).toBe("x 0.00  y 0.00  z 0.00 mm");
  });

  it("uses a plain hyphen-minus, which pastes into other tools", () => {
    const out = formatCursor([-1, 0, 0], "mm");
    expect(out).toContain("-1.00");
    expect(out).not.toContain("−");
  });
});

describe("formatMeshHeaderStat", () => {
  it("shows the element count only, grouped with a fixed locale", () => {
    expect(formatMeshHeaderStat({ nodes: 400, elements: 1248, minQuality: 0.41 })).toBe("1,248 el");
    expect(formatMeshHeaderStat({ nodes: 4, elements: 1 })).toBe("1 el");
  });
});

describe("unsavedEditsLabel", () => {
  it("counts, with the right plural", () => {
    expect(unsavedEditsLabel(1)).toBe("1 unsaved edit");
    expect(unsavedEditsLabel(3)).toBe("3 unsaved edits");
  });

  it("is empty when clean, or for a value that is not a positive count", () => {
    expect(unsavedEditsLabel(0)).toBe("");
    expect(unsavedEditsLabel(-2)).toBe("");
    expect(unsavedEditsLabel(Number.NaN)).toBe("");
    // A payload from an older host has no field at all.
    expect(unsavedEditsLabel(undefined as unknown as number)).toBe("");
  });
});
