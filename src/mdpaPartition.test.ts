import { describe, it, expect } from "vitest";
import {
  buildPartitionInput,
  cellRankFromLabels,
  planPartition,
  partitionReport,
  partitionRefusal,
  rankFileName,
  writePartitionedMdpa,
} from "./mdpaPartition";
import { writeMdpa, type MdpaMesh } from "./mdpaWriter";

/**
 * A row of four unit hexahedra along x (nodes at x = 0..4, tags offset by 100
 * so a tag is never mistaken for an output id), the quad at each end and the
 * interior quad at x = 2, and a Part per half of the row.
 */
function hexRow(): MdpaMesh {
  const nodes = [];
  const tag = (i: number, j: number, k: number): number => 100 + i + 5 * (j + 2 * k);
  for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) for (let i = 0; i <= 4; i++) nodes.push({ tag: tag(i, j, k), x: i, y: j, z: k });
  const hex = (i: number): number[] => [tag(i, 0, 0), tag(i + 1, 0, 0), tag(i + 1, 1, 0), tag(i, 1, 0), tag(i, 0, 1), tag(i + 1, 0, 1), tag(i + 1, 1, 1), tag(i, 1, 1)];
  const quadAt = (i: number): number[] => [tag(i, 0, 0), tag(i, 1, 0), tag(i, 1, 1), tag(i, 0, 1)];
  return {
    dimension: 3,
    nodes,
    volumeCells: [0, 1, 2, 3].map((i) => ({ kind: "hex8" as const, nodeTags: hex(i) })),
    surfaceCells: [0, 4, 2].map((i) => ({ kind: "quad4" as const, nodeTags: quadAt(i) })),
    groups: [
      { name: "Left", volumeCellIndices: [0, 1], surfaceCellIndices: [0], extraNodeTags: [] },
      { name: "Right", volumeCellIndices: [2, 3], surfaceCellIndices: [1], extraNodeTags: [] },
    ],
  };
}

const ids = (text: string, header: string): number[] => {
  const lines = text.split("\n").map((l) => l.trim());
  const out: number[] = [];
  for (let s = lines.findIndex((l) => l.startsWith(`Begin ${header}`)); s >= 0 && s < lines.length; s = lines.findIndex((l, i) => i > s && l.startsWith(`Begin ${header}`))) {
    for (let i = s + 1; !lines[i].startsWith("End "); i++) out.push(Number(lines[i].split(" ")[0]));
  }
  return out;
};
const nodeIds = (text: string): number[] => ids(text, "Nodes");
const subPart = (text: string, name: string, block: string): number[] => {
  const lines = text.split("\n").map((l) => l.trim());
  const s = lines.indexOf(`Begin SubModelPart ${name}`);
  if (s < 0) return [];
  const b = lines.indexOf(`Begin ${block}`, s);
  const e = lines.indexOf(`End ${block}`, b);
  return lines.slice(b + 1, e).map(Number);
};

describe("buildPartitionInput / cellRankFromLabels", () => {
  it("groups the domain cells by meshio++ type, corners only, and maps labels back", () => {
    const m: MdpaMesh = {
      nodes: [0, 1, 2, 3, 4, 5, 6].map((t) => ({ tag: t + 7, x: t, y: 0, z: 0 })),
      volumeCells: [
        { kind: "tet4", nodeTags: [7, 8, 9, 10] },
        { kind: "tet10", nodeTags: [7, 8, 9, 10, 11, 12, 13, 8, 9, 10] },
        { kind: "tet4", nodeTags: [8, 9, 10, 11] },
      ],
      surfaceCells: [],
      groups: [],
    };
    const input = buildPartitionInput(m);
    expect(input.blocks).toHaveLength(1);
    expect(input.blocks[0]).toMatchObject({ type: "tetra", nodesPerCell: 4, cellIndices: [0, 1, 2] });
    expect(Array.from(input.blocks[0].data)).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 1, 2, 3, 4]);
    expect(cellRankFromLabels(input, [Int32Array.from([1, 0, 1])], 3, 2)).toEqual([1, 0, 1]);
  });

  it("rejects labels that do not fit the blocks or the rank count", () => {
    const input = buildPartitionInput(hexRow());
    expect(() => cellRankFromLabels(input, [], 4, 2)).toThrow(/label blocks/);
    expect(() => cellRankFromLabels(input, [Int32Array.from([0, 0, 1])], 4, 2)).toThrow(/3 labels for 4/);
    expect(() => cellRankFromLabels(input, [Int32Array.from([0, 0, 1, 2])], 4, 2)).toThrow(/rank 2 for 2 ranks/);
  });
});

describe("planPartition", () => {
  const m = hexRow();
  const plan = planPartition(m, [0, 0, 1, 1], 2);

  it("sends a boundary cell to its parent's rank, an interior one to the lowest-index parent", () => {
    // quad at x=0 -> hex0 (rank 0), quad at x=4 -> hex3 (rank 1), quad at x=2 shared by hex1 and hex2 -> hex1.
    expect(plan.surfaceRank).toEqual([0, 1, 0]);
    expect(plan.orphanSurfaceCells).toBe(0);
  });

  it("finds exactly the four nodes of the x=2 face on both ranks' interface", () => {
    const tags = [...plan.interfaceNodeTags[0]].sort((a, b) => a - b);
    expect(tags).toEqual([102, 107, 112, 117]);
    expect([...plan.interfaceNodeTags[1]].sort((a, b) => a - b)).toEqual(tags);
  });

  it("reports facts: balance, counts and the shared node ids", () => {
    const r = partitionReport(m, plan, { method: "auto", methodUsed: "kahip", seed: 1, stem: "wall" });
    expect(r.balanceMaxOverMean).toBe(1);
    expect(r.emptyRanks).toEqual([]);
    expect(r.interfaceNodes).toBe(4);
    expect(r.interfaceFraction).toBeCloseTo(4 / 20);
    expect(r.perRank.map((p) => [p.volumeCells, p.surfaceCells, p.nodes, p.interfaceNodes])).toEqual([
      [2, 2, 12, 4],
      [2, 1, 12, 4],
    ]);
    expect(r.perRank[0].file).toBe("wall_0.mdpa");
    expect(r.perRank[0].neighbours).toEqual([{ rank: 1, sharedNodeIds: [3, 8, 13, 18] }]);
    expect(r.perRank[1].neighbours[0].rank).toBe(0);
  });

  it("parks a boundary cell with no parent on a rank holding all its nodes, and counts it", () => {
    const orphan: MdpaMesh = { ...m, surfaceCells: [{ kind: "quad4", nodeTags: [100, 102, 107, 105] }, { kind: "quad4", nodeTags: [102, 104, 109, 107] }] };
    const p = planPartition(orphan, [0, 0, 1, 1], 2);
    expect(p.orphanSurfaceCells).toBe(2);
    expect(p.surfaceRank).toEqual([0, 1]);
  });

  it("reports an empty rank", () => {
    const r = partitionReport(m, planPartition(m, [0, 0, 0, 0], 2), { method: "sfc", methodUsed: "sfc", seed: 1, stem: "x" });
    expect(r.emptyRanks).toEqual([1]);
    expect(r.interfaceNodes).toBe(0);
  });
});

describe("writePartitionedMdpa", () => {
  const m = hexRow();
  const plan = planPartition(m, [0, 0, 1, 1], 2);

  for (const mode of ["elements", "geometries"] as const) {
    it(`${mode}: every cell is written exactly once, with the ids of the unpartitioned file`, () => {
      const serial = writeMdpa(m, mode);
      const files = writePartitionedMdpa(m, mode, plan);
      expect(files).toHaveLength(2);
      const header = mode === "elements" ? "Elements" : "Geometries";
      const all = files.flatMap((f) => ids(f, header)).sort((a, b) => a - b);
      expect(all).toEqual(ids(serial, header).sort((a, b) => a - b));
      expect(new Set(all).size).toBe(all.length);
    });
  }

  it("keeps global node ids: the shared nodes carry the same id and coordinates in both files", () => {
    const [a, b] = writePartitionedMdpa(m, "elements", plan);
    const shared = nodeIds(a).filter((id) => nodeIds(b).includes(id));
    expect(shared).toEqual([3, 8, 13, 18]);
    const coordsOf = (text: string, id: number): string => text.split("\n").find((l) => l.startsWith(`${id} `) && l.includes("e+0"))!;
    for (const id of shared) expect(coordsOf(a, id)).toBe(coordsOf(b, id));
    // The union of the rank node sets is the whole node set.
    expect(new Set([...nodeIds(a), ...nodeIds(b)]).size).toBe(20);
    // Each file lists only the nodes its cells use (12 = 3 columns of 4).
    expect(nodeIds(a)).toHaveLength(12);
  });

  it("restricts each Part to the rank and lists the interface nodes", () => {
    const [a, b] = writePartitionedMdpa(m, "elements", plan);
    expect(subPart(a, "Left", "SubModelPartElements")).toEqual([1, 2]);
    expect(subPart(a, "Right", "SubModelPartElements")).toEqual([]);
    expect(a).not.toContain("SubModelPart Right");
    expect(b).not.toContain("SubModelPart Left");
    expect(subPart(b, "Right", "SubModelPartElements")).toEqual([3, 4]);
    expect(subPart(a, "InterfaceNodes", "SubModelPartNodes")).toEqual([3, 8, 13, 18]);
    expect(subPart(b, "InterfaceNodes", "SubModelPartNodes")).toEqual([3, 8, 13, 18]);
    expect(a).toContain("// Rank 0 of 2");
  });

  it("writes no InterfaceNodes part when the rank shares nothing", () => {
    const [a, b] = writePartitionedMdpa(m, "elements", planPartition(m, [0, 0, 0, 0], 2));
    expect(a).not.toContain("InterfaceNodes");
    expect(ids(b, "Elements")).toEqual([]);
  });

  it("a Part named InterfaceNodes keeps its name; the generated part is de-duplicated", () => {
    const clash: MdpaMesh = { ...m, groups: [{ name: "InterfaceNodes", volumeCellIndices: [0], surfaceCellIndices: [], extraNodeTags: [] }] };
    const [a] = writePartitionedMdpa(clash, "elements", plan);
    expect(a).toContain("Begin SubModelPart InterfaceNodes\n");
    expect(a).toContain("Begin SubModelPart InterfaceNodes_2\n");
  });

  it("a free point no cell uses stays in rank 0 only", () => {
    const free: MdpaMesh = { ...m, nodes: [...m.nodes, { tag: 999, x: 9, y: 9, z: 9 }] };
    const [a, b] = writePartitionedMdpa(free, "elements", planPartition(free, [0, 0, 1, 1], 2));
    expect(nodeIds(a)).toContain(21);
    expect(nodeIds(b)).not.toContain(21);
  });

  it("a 2-D mesh partitions with edge boundary cells", () => {
    const flat: MdpaMesh = {
      dimension: 2,
      nodes: [0, 1, 2, 3, 4, 5].map((t) => ({ tag: t, x: t % 3, y: Math.floor(t / 3), z: 0 })),
      volumeCells: [
        { kind: "quad4", nodeTags: [0, 1, 4, 3] },
        { kind: "quad4", nodeTags: [1, 2, 5, 4] },
      ],
      surfaceCells: [
        { kind: "line2", nodeTags: [0, 1] },
        { kind: "line2", nodeTags: [2, 5] },
        { kind: "line2", nodeTags: [1, 4] },
      ],
      groups: [],
    };
    const p = planPartition(flat, [0, 1], 2);
    expect(p.surfaceRank).toEqual([0, 1, 0]);
    expect([...p.interfaceNodeTags[0]].sort()).toEqual([1, 4]);
    const [a, b] = writePartitionedMdpa(flat, "elements", p);
    // Global ids follow sorted connectivity: (0,1)=1, (1,4)=2, (2,5)=3.
    expect(ids(a, "Conditions")).toEqual([1, 2]);
    expect(ids(b, "Conditions")).toEqual([3]);
  });

  it("refuses to partition a mesh that carries multi-point constraints", () => {
    const mpc: MdpaMesh = { ...m, constraints: [{ slave: 100, masters: [101, 102], weights: [0.5, 0.5] }] };
    expect(() => writePartitionedMdpa(mpc, "elements", plan)).toThrow(/multi-point constraints/);
  });
});

describe("partitionRefusal / rankFileName", () => {
  const m = hexRow();
  it("lets a single file and a feasible split through", () => {
    expect(partitionRefusal(m, 1)).toBeUndefined();
    expect(partitionRefusal(m, 4)).toBeUndefined();
  });
  it("names the two refusals", () => {
    expect(partitionRefusal(m, 5)).toMatch(/4 domain cells into 5 ranks/);
    expect(partitionRefusal({ ...m, constraints: [{ slave: 1, masters: [2], weights: [1] }] }, 2)).toMatch(/hanging-node constraints/);
  });
  it("uses Kratos' <stem>_<rank>.mdpa", () => {
    expect(rankFileName("beam", 3)).toBe("beam_3.mdpa");
  });
});
