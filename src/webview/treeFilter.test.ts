import { describe, it, expect } from "vitest";
import { filterTree } from "./treeFilter";
import type { TreeNode } from "../protocol";

const tree: TreeNode[] = [
  {
    id: "root",
    label: "STEP Assembly",
    children: [
      { id: "solid-0", label: "Inlet Pipe" },
      { id: "solid-1", label: "Outlet Pipe" },
      { id: "solid-2", label: "Housing" },
    ],
  },
];

describe("filterTree", () => {
  it("returns every id when the query is empty or blank", () => {
    const all = new Set(["root", "solid-0", "solid-1", "solid-2"]);
    expect(filterTree(tree, "")).toEqual(all);
    expect(filterTree(tree, "   ")).toEqual(all);
  });

  it("matches on a case-insensitive label substring", () => {
    const kept = filterTree(tree, "pipe");
    expect(kept.has("solid-0")).toBe(true);
    expect(kept.has("solid-1")).toBe(true);
    expect(kept.has("solid-2")).toBe(false);
  });

  it("includes ancestor ids so a nested match stays reachable", () => {
    const kept = filterTree(tree, "housing");
    expect(kept.has("solid-2")).toBe(true);
    expect(kept.has("root")).toBe(true); // ancestor of the match
    expect(kept.has("solid-0")).toBe(false);
  });

  it("returns an empty set when nothing matches", () => {
    expect(filterTree(tree, "nonexistent")).toEqual(new Set());
  });

  it("keeps a parent whose own label matches even with no matching children", () => {
    const kept = filterTree(tree, "assembly");
    expect(kept.has("root")).toBe(true);
    expect(kept.has("solid-0")).toBe(false);
  });
});
