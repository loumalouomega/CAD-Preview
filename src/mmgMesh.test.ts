import { describe, expect, it } from "vitest";
import type { Mesh } from "@meshioplusplus/wasm";
import { prepareMmgMesh, harvestMmgMesh } from "./mmgMesh";
import { explicitTriangleRegions, triangleCoordinateKey } from "./meshioTriangleRegions";

const source = (): Mesh => ({ dim: 3, points: Float64Array.from([0,0,0, 1,0,0, 0,1,0, 0,0,1]),
  cells: [{ type: "tetra", nodesPerCell: 4, data: Int32Array.from([0,1,2,3]) }, { type: "triangle", nodesPerCell: 3, data: Int32Array.from([0,1,2]) }],
  regions: [{ name: "Material", kind: "cell", dim: 3, tag: 1, entries: Int32Array.from([0]) },
    { name: "Wall", kind: "cell", dim: 2, tag: 2, entries: Int32Array.from([1]) },
    { name: "Both", kind: "cell", dim: -1, tag: 3, entries: Int32Array.from([0,1]) }] });

describe("MMG region bridge", () => {
  it("round-trips overlapping block-major regions through combination refs", () => {
    const bridge = prepareMmgMesh(source());
    expect([...bridge.input.tetrahedra]).toEqual([1,2,3,4]);
    expect(bridge.input.tetraRefs[0]).not.toBe(bridge.input.triangleRefs[0]);
    const output = harvestMmgMesh(bridge.input, bridge);
    expect(output.regions).toEqual(source().regions);
  });
  it("refuses losing named regions instead of writing a silently ungrouped mesh", () => {
    const bridge = prepareMmgMesh(source());
    expect(() => harvestMmgMesh({ ...bridge.input, triangleRefs: Int32Array.from([1]) }, bridge)).toThrow(/lost a named triangle region/);
  });
  it("refuses unsupported cell types rather than linearising", () => {
    for (const type of ["hexahedron", "quad", "tetra10", "pyramid", "triangle6"]) expect(() => prepareMmgMesh({ ...source(), cells: [{ type, nodesPerCell: 4, data: Int32Array.from([0,1,2,3]) }] })).toThrow(/does not accept/);
  });
  it("warns when fields and point regions are dropped", () => {
    const mesh = source();
    mesh.point_data = { Temperature: Float64Array.from([1,2,3,4]) };
    mesh.regions!.push({ name: "Nodes", kind: "point", dim: 0, tag: 4, entries: Int32Array.from([0]) });
    const { warnings } = prepareMmgMesh(mesh);
    expect(warnings.join(" ")).toMatch(/data was dropped/);
    expect(warnings.join(" ")).toMatch(/Point\/side regions/);
  });
  it("rejects oversized bigint indices before narrowing and malformed coordinates", () => {
    const mesh = source();
    mesh.cells = [{ type: "tetra", nodesPerCell: 4, data: BigInt64Array.from([4294967296n, 1n, 2n, 3n]) as unknown as Int32Array }];
    expect(() => prepareMmgMesh(mesh)).toThrow(/index out of range/);
    expect(() => prepareMmgMesh({ ...source(), points: Float64Array.from([0, 1]) })).toThrow(/malformed point/);
  });
});

describe("explicit physical surface regions", () => {
  it("uses triangle groups even when volume parents belong to another group", () => {
    const mesh = source();
    const map = explicitTriangleRegions(mesh, mesh.regions!.map(r => ({ ids: new Set(r.entries) })));
    expect(map.get(triangleCoordinateKey(mesh.points, 3, [2,0,1]))).toBe(1);
  });
  it("matches exact coordinates after point renumbering and ignores a nearby facet", () => {
    const mesh = source();
    const map = explicitTriangleRegions(mesh, [{ ids: new Set([1]) }]);
    const renumbered = Float64Array.from([0,1,0, 0,0,0, 1,0,0]);
    expect(map.get(triangleCoordinateKey(renumbered, 3, [0,1,2]))).toBe(0);
    renumbered[0] = 0.001;
    expect(map.get(triangleCoordinateKey(renumbered, 3, [0,1,2]))).toBeUndefined();
  });
  it("counts ragged blocks when locating a later explicit triangle region", () => {
    const mesh = source();
    mesh.cells = [
      { type: "polyhedron", data: Int32Array.from([0, 1, 2]), faceOffsets: Int32Array.from([0, 3]), cellOffsets: Int32Array.from([0, 1]) },
      { type: "polygon", data: Int32Array.from([0, 1, 2, 0, 2, 3]), rowOffsets: Int32Array.from([0, 3, 6]) },
      mesh.cells[1],
    ];
    const map = explicitTriangleRegions(mesh, [{ ids: new Set([3]) }]);
    expect(map.get(triangleCoordinateKey(mesh.points, 3, [0, 1, 2]))).toBe(0);
  });
});
