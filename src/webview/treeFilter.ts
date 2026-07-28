import type { TreeNode } from "../protocol";

/**
 * Returns the ids of every node that matches `query` (case-insensitive
 * substring of `label`) plus every ancestor id needed to keep a match
 * reachable when the tree is rendered filtered. Pure, no DOM — the
 * `TreePanel` render pass keeps a node (and expands it) iff its id is in
 * this set. An empty/blank `query` matches everything (no filter applied).
 *
 * Ancestor-inclusion (rather than tracking/restoring per-node collapse
 * state) is the simplest correct approach here: `TreePanel.render()` already
 * does a full rebuild on every call with no persisted collapse state, so
 * there is nothing to preserve — just decide, fresh, which ids survive.
 */
export function filterTree(nodes: TreeNode[], query: string): Set<string> {
  const q = query.trim().toLowerCase();
  const keep = new Set<string>();
  if (!q) {
    collectAll(nodes, keep);
    return keep;
  }
  for (const node of nodes) visit(node, q, [], keep);
  return keep;
}

function collectAll(nodes: TreeNode[], keep: Set<string>): void {
  for (const node of nodes) {
    keep.add(node.id);
    if (node.children) collectAll(node.children, keep);
  }
}

/** Returns true if `node` or any descendant matched (so callers can decide whether to keep an ancestor). */
function visit(node: TreeNode, query: string, ancestors: string[], keep: Set<string>): boolean {
  const selfMatch = node.label.toLowerCase().includes(query);
  const path = [...ancestors, node.id];
  let childMatch = false;
  for (const child of node.children ?? []) {
    if (visit(child, query, path, keep)) childMatch = true;
  }
  if (selfMatch || childMatch) {
    for (const id of path) keep.add(id);
    return true;
  }
  return false;
}
