/**
 * History reorder (roadmap "History timeline depth"): moving one op to a new
 * position in the op list. Pure and vscode/DOM-free — the webview's drag handler
 * and the MCP `move_edit_op` tool share this one decision.
 *
 * Entity ids are positional (`face-N`, `solid-N`), so moving an op can silently
 * repoint every later id. The check therefore refuses what it can PROVE is
 * unsafe, and says why; everything it allows is still a geometry change the
 * caller must replay and show:
 *
 *  1. nothing inside the saved prefix (`bakedThrough`) may move or be crossed;
 *  2. no stored bucket query (`targetQueries[*].source.op`, or one a Part holds,
 *     passed as `externalRefs`) may name an op in the affected span — those
 *     queries are valid only against that op's own state, which the move changes;
 *  3. the mover and a crossed op may not both be topology-changing — their
 *     positional ids (`face-N`, `point-N`, the solid order) would renumber under
 *     each other.
 *
 * Rigid transforms, holes' siblings and other non-renumbering ops therefore move
 * freely among themselves and across features; any other crossing is refused.
 */
import { TOPOLOGY_CHANGING_OPS, type EditOp, type EditOpKind } from "./editOps";

export interface OpMovePlan {
  ok: true;
  /** The reordered list (new array; ops are the same objects, untouched). */
  ops: EditOp[];
  /** `mapping[oldIndex] === newIndex` for every op — what index-keyed lists (configurations' suppressed) must follow. */
  mapping: number[];
}

export interface OpMoveRefusal {
  ok: false;
  reason: string;
}

/** Op indices the op's stored per-field queries name (bucket sources only). */
export function bucketRefsOf(op: EditOp): number[] {
  const out: number[] = [];
  for (const q of Object.values(op.targetQueries ?? {})) {
    const src = (q as { source?: { kind?: string; op?: unknown } } | undefined)?.source;
    if (src?.kind === "bucket" && typeof src.op === "number" && Number.isInteger(src.op)) out.push(src.op);
  }
  return out;
}

const changesTopology = (op: EditOp): boolean => TOPOLOGY_CHANGING_OPS.has(op.op as EditOpKind);

/**
 * Plans moving `ops[from]` so it ends up at index `to`. Returns the new list and
 * the old→new index mapping, or the named reason it is refused.
 *
 * @param externalRefs op indices named by stored queries outside the op list (Parts' `selector.source.op`).
 */
export function planOpMove(
  ops: readonly EditOp[],
  from: number,
  to: number,
  bakedThrough = 0,
  externalRefs: Iterable<number> = []
): OpMovePlan | OpMoveRefusal {
  const n = ops.length;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= n || to >= n) {
    return { ok: false, reason: `Move ${from} → ${to} is out of range — the op stack has ${n} entries (0-based).` };
  }
  if (from === to) return { ok: false, reason: "Nothing to move: the op is already at that position." };
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  if (lo < bakedThrough) {
    return { ok: false, reason: `Ops 0..${bakedThrough - 1} are already saved into the file itself — an op cannot be moved into or across them.` };
  }

  const pinned = new Set<number>(externalRefs);
  for (const op of ops) for (const ref of bucketRefsOf(op)) if (ref >= lo && ref <= hi) pinned.add(ref);
  for (let i = lo; i <= hi; i++) {
    if (pinned.has(i)) {
      return { ok: false, reason: `A stored selector query names op ${i + 1}; its faces are valid only against that op's own state, which this move would change. Remove or re-pin the query first.` };
    }
  }

  const mover = ops[from];
  if (changesTopology(mover)) {
    for (let i = lo; i <= hi; i++) {
      if (i === from) continue;
      if (changesTopology(ops[i])) {
        return {
          ok: false,
          reason: `Op ${from + 1} (${mover.op}) and op ${i + 1} (${ops[i].op}) both reshape the model, so their positional ids (face-N, edge-N, point-N, solid order) would renumber under each other.`,
        };
      }
    }
  }

  const order = ops.map((_, i) => i);
  order.splice(from, 1);
  order.splice(to, 0, from);
  const mapping = new Array<number>(n);
  order.forEach((oldIndex, newIndex) => { mapping[oldIndex] = newIndex; });
  return { ok: true, ops: order.map((i) => ops[i]), mapping };
}

/** Follows an index-keyed list (a configuration's `suppressed`) through a move's old→new mapping. */
export function remapIndices(indices: readonly number[], mapping: readonly number[]): number[] {
  return indices.map((i) => (i >= 0 && i < mapping.length ? mapping[i] : i)).sort((a, b) => a - b);
}
