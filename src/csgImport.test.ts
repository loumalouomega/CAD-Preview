import { describe, it, expect } from "vitest";
import { parseCsg, resolveSegments, DEFAULT_USE_MAX_FN } from "./csgImport";

describe("resolveSegments", () => {
  it("honours explicit $fn", () => {
    expect(resolveSegments(5, 10, undefined, undefined)).toBe(10);
  });
  it("applies the $fa/$fs rule when $fn is 0", () => {
    // r=5: max(5, ceil(360/12)=30, ceil(2π·5/2)=16) = 30
    expect(resolveSegments(5, 0, 12, 2)).toBe(30);
  });
  it("falls back to OpenSCAD defaults when omitted", () => {
    expect(resolveSegments(5, undefined, undefined, undefined)).toBe(30);
  });
  it("floors degenerate radius at 5", () => {
    expect(resolveSegments(0, undefined, undefined, undefined)).toBe(5);
  });
});

describe("parseCsg", () => {
  it("parses an empty file to no roots plus a warning", () => {
    const r = parseCsg("");
    expect(r.roots).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("parses a cube with center=false", () => {
    const r = parseCsg(`cube(size = [10, 20, 30], center = false);`);
    expect(r.warnings).toEqual([]);
    expect(r.roots).toHaveLength(1);
    expect(r.roots[0].name).toBe("cube");
    expect(r.roots[0].params).toMatchObject({ size: [10, 20, 30], center: false });
  });

  it("parses nested booleans with children", () => {
    const r = parseCsg(`
      group() {
        difference() {
          cube(size = [10, 10, 10], center = true);
          sphere($fn = 0, $fa = 12, $fs = 2, r = 5);
        }
      }
    `);
    expect(r.warnings).toEqual([]);
    expect(r.roots).toHaveLength(1);
    const diff = r.roots[0].children[0];
    expect(diff.name).toBe("difference");
    expect(diff.children.map((c) => c.name)).toEqual(["cube", "sphere"]);
  });

  it("parses a multmatrix into 16 flat numbers", () => {
    // Real .csg uses the positional form multmatrix([...]), no m= name.
    const r = parseCsg(`multmatrix([[1, 0, 0, 5], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) { cube(size = 10); }`);
    expect(r.warnings).toEqual([]);
    const m = r.roots[0].params["#0"];
    expect(Array.isArray(m) && (m as number[]).length).toBe(16);
    expect((m as number[])[3]).toBe(5);
    expect(r.roots[0].children[0].name).toBe("cube");
  });

  it("recovers polyhedron face boundaries in occurrence order", () => {
    const r = parseCsg(`
      polyhedron(points = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0.5,0.5,1]], faces = [[0,1,2,3],[0,1,4],[1,2,4],[2,3,4],[3,0,4]]);
    `);
    expect(r.roots).toHaveLength(1);
    expect(r.roots[0].faces).toEqual([[0, 1, 2, 3], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]]);
  });

  it("keeps two polyhedra faces separate", () => {
    const r = parseCsg(`
      group() {
        polyhedron(points = [[0,0,0],[1,0,0],[0,1,0],[0,0,1]], faces = [[0,1,2],[0,1,3],[1,2,3],[0,2,3]]);
        polyhedron(points = [[0,0,0],[2,0,0],[0,2,0],[0,0,2]], faces = [[0,2,1],[0,1,3],[1,2,3],[0,3,2]]);
      }
    `);
    expect(r.roots[0].children[0].faces).toHaveLength(4);
    expect(r.roots[0].children[1].faces).toHaveLength(4);
    expect(r.roots[0].children[0].faces?.[0]).toEqual([0, 1, 2]);
    expect(r.roots[0].children[1].faces?.[0]).toEqual([0, 2, 1]);
  });

  it("does not misalign face groups past a faceless polyhedron", () => {
    const r = parseCsg(`
      group() {
        polyhedron(points = [[0,0,0],[1,0,0],[0,1,0],[0,0,1]]);
        polyhedron(points = [[0,0,0],[2,0,0],[0,2,0],[0,0,2]], triangles = [[0,2,1],[0,1,3],[1,2,3],[0,3,2]]);
      }
    `);
    expect(r.roots[0].children[0].faces).toBeUndefined();
    expect(r.roots[0].children[1].faces?.[0]).toEqual([0, 2, 1]);
  });

  it("strips debug modifiers and records them", () => {
    const r = parseCsg(`#cube(size = 5); *sphere(r = 3);`);
    expect(r.roots).toHaveLength(2);
    expect(r.roots[0].modifier).toBe("#");
    expect(r.roots[1].modifier).toBe("*");
  });

  it("skips line and block comments", () => {
    const r = parseCsg(`// a comment\n/* multi\nline */\ncube(size = 2);`);
    expect(r.warnings).toEqual([]);
    expect(r.roots).toHaveLength(1);
  });

  it("parses rotate euler and axis forms", () => {
    const r = parseCsg(`rotate(a = [0, 0, 90]) { cube(size = 1); }\nrotate(a = 45, v = [0, 0, 1]) { cube(size = 1); }`);
    expect(r.roots).toHaveLength(2);
    expect(r.roots[0].params["a"]).toEqual([0, 0, 90]);
    expect(r.roots[1].params).toMatchObject({ a: 45, v: [0, 0, 1] });
  });

  it("echoes the effective useMaxFN", () => {
    expect(parseCsg(`cube(size = 1);`).useMaxFN).toBe(DEFAULT_USE_MAX_FN);
    expect(parseCsg(`cube(size = 1);`, { useMaxFN: 8 }).useMaxFN).toBe(8);
  });

  it("refuses oversized inputs", () => {
    const r = parseCsg(" ".repeat(11 * 1024 * 1024));
    expect(r.roots).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/10MB/);
  });

  it("tolerates a missing terminal semicolon", () => {
    const r = parseCsg(`cube(size = 1)`);
    expect(r.roots).toHaveLength(1);
  });
});
