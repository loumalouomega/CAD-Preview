import { describe, it, expect } from "vitest";
import { correlateAssemblyTree, type XcafAssemblyInfo, type XcafLeafSignature } from "./xcafTree";
import type { TreeNode } from "./protocol";

function leaf(id: string, centre: [number, number, number], volume = 10): XcafLeafSignature {
  return { id, centre, volume };
}

describe("correlateAssemblyTree", () => {
  it("relabels a flat single-leaf tree to the matching real solid id", () => {
    const info: XcafAssemblyInfo = {
      tree: { id: "root", label: "root", children: [{ id: "xcaf-leaf-1", label: "Component 1" }] },
      sigs: [leaf("xcaf-leaf-1", [0, 0, 0])],
    };
    const result = correlateAssemblyTree(info, [{ id: "solid-0", centre: [0, 0, 0], volume: 10 }]);
    expect(result).toEqual({ id: "root", label: "root", children: [{ id: "solid-0", label: "Component 1" }] });
  });

  it("relabels a nested assembly tree, preserving group structure", () => {
    const info: XcafAssemblyInfo = {
      tree: {
        id: "root",
        label: "root",
        children: [
          {
            id: "xcaf-asm-1",
            label: "Assembly 1",
            children: [
              { id: "xcaf-leaf-1", label: "Component 1" },
              { id: "xcaf-leaf-2", label: "Component 2" },
            ],
          },
        ],
      },
      sigs: [leaf("xcaf-leaf-1", [0, 0, 0]), leaf("xcaf-leaf-2", [10, 0, 0])],
    };
    const current = [
      { id: "solid-0", centre: [0, 0, 0] as [number, number, number], volume: 10 },
      { id: "solid-1", centre: [10, 0, 0] as [number, number, number], volume: 10 },
    ];
    const result = correlateAssemblyTree(info, current);
    expect(result).toEqual({
      id: "root",
      label: "root",
      children: [
        {
          id: "xcaf-asm-1",
          label: "Assembly 1",
          children: [
            { id: "solid-0", label: "Component 1" },
            { id: "solid-1", label: "Component 2" },
          ],
        },
      ],
    });
  });

  it("returns null when the solid counts differ (a topology-changing edit was applied)", () => {
    const info: XcafAssemblyInfo = {
      tree: { id: "root", label: "root", children: [{ id: "xcaf-leaf-1", label: "Component 1" }] },
      sigs: [leaf("xcaf-leaf-1", [0, 0, 0])],
    };
    const current = [
      { id: "solid-0", centre: [0, 0, 0] as [number, number, number], volume: 10 },
      { id: "solid-1", centre: [50, 0, 0] as [number, number, number], volume: 5 }, // e.g. an added primitive
    ];
    expect(correlateAssemblyTree(info, current)).toBeNull();
  });

  it("returns null when a leaf has no confident geometric match (not a clean bijection)", () => {
    const info: XcafAssemblyInfo = {
      tree: { id: "root", label: "root", children: [{ id: "xcaf-leaf-1", label: "Component 1" }] },
      sigs: [leaf("xcaf-leaf-1", [0, 0, 0])],
    };
    // Same count, but the current solid has moved far away — no confident match within tolerance.
    const current = [{ id: "solid-0", centre: [10000, 10000, 10000] as [number, number, number], volume: 10 }];
    expect(correlateAssemblyTree(info, current)).toBeNull();
  });

  it("drops an empty group node whose leaves all failed to correlate, and returns null if nothing survives", () => {
    const info: XcafAssemblyInfo = {
      tree: {
        id: "root",
        label: "root",
        children: [{ id: "xcaf-asm-1", label: "Assembly 1", children: [{ id: "xcaf-leaf-1", label: "Component 1" }] }],
      },
      sigs: [leaf("xcaf-leaf-1", [0, 0, 0])],
    };
    const current = [{ id: "solid-0", centre: [10000, 10000, 10000] as [number, number, number], volume: 10 }];
    expect(correlateAssemblyTree(info, current)).toBeNull();
  });

  it("real-shaped example: 3 solids, one nested group of 2", () => {
    const info: XcafAssemblyInfo = {
      tree: {
        id: "root",
        label: "root",
        children: [
          { id: "xcaf-leaf-1", label: "Component 1" },
          {
            id: "xcaf-asm-1",
            label: "Assembly 1",
            children: [
              { id: "xcaf-leaf-2", label: "Component 2" },
              { id: "xcaf-leaf-3", label: "Component 3" },
            ],
          },
        ],
      },
      sigs: [leaf("xcaf-leaf-1", [-100, 0, 0], 500), leaf("xcaf-leaf-2", [0, 0, 0], 10), leaf("xcaf-leaf-3", [10, 0, 0], 10)],
    };
    // Real solid order need not match xcaf leaf order — correlation is by geometry, not position in the array.
    const current = [
      { id: "solid-0", centre: [10, 0, 0] as [number, number, number], volume: 10 },
      { id: "solid-1", centre: [-100, 0, 0] as [number, number, number], volume: 500 },
      { id: "solid-2", centre: [0, 0, 0] as [number, number, number], volume: 10 },
    ];
    const result = correlateAssemblyTree(info, current);
    expect(result).toEqual({
      id: "root",
      label: "root",
      children: [
        { id: "solid-1", label: "Component 1" },
        {
          id: "xcaf-asm-1",
          label: "Assembly 1",
          children: [
            { id: "solid-2", label: "Component 2" },
            { id: "solid-0", label: "Component 3" },
          ],
        },
      ],
    });
  });

  it("does not mutate the input XcafAssemblyInfo's tree", () => {
    const originalTree: TreeNode = { id: "root", label: "root", children: [{ id: "xcaf-leaf-1", label: "Component 1" }] };
    const info: XcafAssemblyInfo = { tree: originalTree, sigs: [leaf("xcaf-leaf-1", [0, 0, 0])] };
    correlateAssemblyTree(info, [{ id: "solid-0", centre: [0, 0, 0], volume: 10 }]);
    expect(originalTree.children![0].id).toBe("xcaf-leaf-1");
  });
});
