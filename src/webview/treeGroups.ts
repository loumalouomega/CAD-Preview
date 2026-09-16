import type { TreeNode } from "../protocol";

/**
 * Assembly-group descendant resolution (roadmap Tier 1 "Assembly-tree group
 * rows are inert").
 *
 * XCAF assembly trees nest synthetic `"Assembly N"` group nodes above real
 * `solid-N` leaves. The Three.js scene only knows leaf `groupId`s, so a group
 * row's select/eye-toggle must expand to its descendant leaves first. Pure
 * and DOM-free so it unit-tests headless, same split as `treeFilter.ts`.
 */

/** Depth-first search for the node with `id` under `nodes`. */
function findNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const found = findNode(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

/** Collect every leaf id under `node` (a leaf is a node with no children). */
function collectLeaves(node: TreeNode, out: string[]): void {
  if (!node.children || node.children.length === 0) {
    out.push(node.id);
    return;
  }
  for (const child of node.children) collectLeaves(child, out);
}

/**
 * Expand a tree row id to the leaf `solid-N` ids it represents: `[id]` for a
 * leaf, every descendant leaf for a group, `[]` when `id` is not in the tree.
 */
export function descendantLeafIds(rootChildren: TreeNode[], id: string): string[] {
  const node = findNode(rootChildren, id);
  if (!node) return [];
  const out: string[] = [];
  collectLeaves(node, out);
  return out;
}

/** True when `id` names a group node (has at least one child). */
export function isGroupNode(rootChildren: TreeNode[], id: string): boolean {
  const node = findNode(rootChildren, id);
  return !!node && !!node.children && node.children.length > 0;
}
