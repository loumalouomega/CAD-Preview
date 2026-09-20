import { describe, it, expect } from "vitest";
import { formatEntityCounts, formatMeshStats, formatCursor } from "./dockStats";

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
  it("reports nodes, elements and the worst element", () => {
    expect(formatMeshStats({ nodes: 12480, elements: 51200, minQuality: 0.4123 })).toBe(
      "12,480 nodes · 51,200 elements · min SICN 0.412"
    );
  });

  it("omits the quality when the mesher returned none, rather than printing NaN or 0", () => {
    expect(formatMeshStats({ nodes: 10, elements: 4 })).toBe("10 nodes · 4 elements");
    expect(formatMeshStats({ nodes: 10, elements: 4, minQuality: Number.NaN })).toBe("10 nodes · 4 elements");
    expect(formatMeshStats({ nodes: 10, elements: 4, minQuality: Number.POSITIVE_INFINITY })).toBe("10 nodes · 4 elements");
  });

  it("keeps a genuine zero quality — a degenerate element is a fact, not an absence", () => {
    expect(formatMeshStats({ nodes: 4, elements: 1, minQuality: 0 })).toBe("4 nodes · 1 element · min SICN 0.000");
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

  it("prints millimetres as-is with three decimals and the unit", () => {
    expect(formatCursor([142.06, -18.4, 27], "mm")).toBe("X 142.060  Y -18.400  Z 27.000 mm");
  });

  it("converts to the display unit — the Units dropdown drives this readout too", () => {
    // 25.4 mm is exactly one inch.
    expect(formatCursor([25.4, 50.8, 0], "in")).toBe("X 1.000  Y 2.000  Z 0.000 in");
    expect(formatCursor([1000, 0, 0], "m")).toBe("X 1.000  Y 0.000  Z 0.000 m");
  });

  it("never prints a negative zero", () => {
    expect(formatCursor([-0, -0.0001, 0], "mm")).toBe("X 0.000  Y 0.000  Z 0.000 mm");
  });

  it("uses a plain hyphen-minus, which pastes into other tools", () => {
    const out = formatCursor([-1, 0, 0], "mm");
    expect(out).toContain("-1.000");
    expect(out).not.toContain("−");
  });
});
