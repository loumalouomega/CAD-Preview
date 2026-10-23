import { describe, it, expect } from "vitest";
import { octreeMeshSizes, OCTREE_MESH_AUTO_DIVISOR } from "./octreeMeshService";
import { octreeToMsh41 } from "./octreeService";

describe("octreeMeshSizes", () => {
  it("derives the largest leaf from the bbox diagonal when none is given", () => {
    const { maxSize, minSize } = octreeMeshSizes(80, 0, 2);
    expect(maxSize).toBe(80 / OCTREE_MESH_AUTO_DIVISOR);
    expect(minSize).toBe(maxSize / 4);
  });

  it("honors an explicit max size and halves it once per level", () => {
    expect(octreeMeshSizes(80, 2, 3)).toEqual({ maxSize: 2, minSize: 0.25 });
  });
});

describe("octreeToMsh41 with octree-mesh blocks", () => {
  it("writes a tet-only and a hex-only block on the one volume entity", () => {
    const tet = octreeToMsh41([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], [{ type: "tetra", data: [0, 1, 2, 3] }]);
    expect(tet).toContain("1 1 1 1\n3 1 4 1\n1 1 2 3 4\n");
    const pts = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
    const hex = octreeToMsh41(pts, [{ type: "hexahedron", data: [0, 1, 2, 3, 4, 5, 6, 7] }]);
    expect(hex).toContain("3 1 5 1\n1 1 2 3 4 5 6 7 8\n");
  });

  it("refuses a block class it cannot write rather than dropping it", () => {
    expect(() => octreeToMsh41([0, 0, 0], [{ type: "polyhedron", data: [0] }])).toThrow(/refusing to drop/);
  });
});
