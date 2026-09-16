import { describe, it, expect } from "vitest";
import type { TreeNode } from "../protocol";
import { descendantLeafIds, isGroupNode } from "./treeGroups";

const TREE: TreeNode[] = [
  {
    id: "asm-1",
    label: "Assembly 1",
    children: [
      { id: "solid-0", label: "Solid 1" },
      {
        id: "asm-2",
        label: "Assembly 2",
        children: [
          { id: "solid-1", label: "Solid 2" },
          { id: "solid-2", label: "Solid 3" },
        ],
      },
    ],
  },
  { id: "solid-3", label: "Solid 4" },
];

describe("treeGroups — descendantLeafIds", () => {
  it("passes a leaf through as itself", () => {
    expect(descendantLeafIds(TREE, "solid-0")).toEqual(["solid-0"]);
    expect(descendantLeafIds(TREE, "solid-3")).toEqual(["solid-3"]);
  });

  it("expands a nested group to every descendant leaf in order", () => {
    expect(descendantLeafIds(TREE, "asm-1")).toEqual(["solid-0", "solid-1", "solid-2"]);
    expect(descendantLeafIds(TREE, "asm-2")).toEqual(["solid-1", "solid-2"]);
  });

  it("returns [] for an unknown id", () => {
    expect(descendantLeafIds(TREE, "nope")).toEqual([]);
    expect(descendantLeafIds([], "asm-1")).toEqual([]);
  });
});

describe("treeGroups — isGroupNode", () => {
  it("distinguishes groups from leaves and unknown ids", () => {
    expect(isGroupNode(TREE, "asm-1")).toBe(true);
    expect(isGroupNode(TREE, "asm-2")).toBe(true);
    expect(isGroupNode(TREE, "solid-0")).toBe(false);
    expect(isGroupNode(TREE, "nope")).toBe(false);
  });
});
