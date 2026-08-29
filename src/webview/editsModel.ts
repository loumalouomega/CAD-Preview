import type { EditOp } from "../editOps";

/**
 * In-webview op-stack for the replayable edit list. Pure data + operations (no
 * DOM), mirroring {@link PartsModel}. Owns both the applied list and a redo
 * buffer; the host stays dumb and just persists / re-tessellates whatever list
 * this produces.
 *
 * Every mutation ({@link push}/{@link undo}/{@link redo}/{@link clear}/
 * {@link remove}) fires `onChange`, which the wiring uses to post
 * `editsChanged`, persist the sidecar, and request a re-apply. {@link load}
 * replaces the list WITHOUT firing — it is the initial load from disk and
 * must not echo straight back as a write.
 */
export class EditsModel {
  private ops: EditOp[] = [];
  private redoBuffer: EditOp[] = [];

  constructor(private readonly onChange: () => void) {}

  /** Replaces the op-list from a freshly-loaded sidecar (does not fire onChange). */
  load(ops: EditOp[]): void {
    this.ops = ops.map(clone);
    this.redoBuffer = [];
  }

  /** The applied ops, in order. */
  list(): EditOp[] {
    return this.ops.map(clone);
  }

  /**
   * The undone-but-recoverable ops in CHRONOLOGICAL order (the order they
   * would re-apply) — i.e. the redo buffer reversed, since {@link undo}
   * pushes onto the buffer's end and {@link redo} pops from it. Cloned like
   * {@link list}. This is the order the Edits panel renders pending rows in
   * and the order its timeline indices address.
   */
  redoList(): EditOp[] {
    return [...this.redoBuffer].reverse().map(clone);
  }

  get size(): number {
    return this.ops.length;
  }

  get canUndo(): boolean {
    return this.ops.length > 0;
  }

  get canRedo(): boolean {
    return this.redoBuffer.length > 0;
  }

  /** Appends a new op; clears the redo buffer (a new branch). */
  push(op: EditOp): void {
    this.ops.push(clone(op));
    this.redoBuffer = [];
    this.onChange();
  }

  /** Pops the last op onto the redo buffer. */
  undo(): void {
    const op = this.ops.pop();
    if (!op) return;
    this.redoBuffer.push(op);
    this.onChange();
  }

  /** Re-applies the most recently undone op. */
  redo(): void {
    const op = this.redoBuffer.pop();
    if (!op) return;
    this.ops.push(op);
    this.onChange();
  }

  /** Removes every op (the redo buffer too). */
  clear(): void {
    if (this.ops.length === 0 && this.redoBuffer.length === 0) return;
    this.ops = [];
    this.redoBuffer = [];
    this.onChange();
  }

  /**
   * Removes a single op at `index` from anywhere in the applied list (unlike
   * {@link undo}, which only pops the last one). Clears the redo buffer, same
   * as {@link push} — a deliberate edit like this abandons any pending redo
   * rather than leaving it to replay against a list it was never undone from.
   * Topology-changing ops after the removed one may reassign ids on reload —
   * same accepted "entity-id drift" risk as undo/redo already carries.
   */
  remove(index: number): void {
    if (index < 0 || index >= this.ops.length) return;
    this.ops.splice(index, 1);
    this.redoBuffer = [];
    this.onChange();
  }

  /**
   * Moves the stack boundary straight to timeline position `index` in ONE
   * splice — the op-history-scrubbing primitive (roadmap Tier 2 item 1).
   * `index` addresses the full chronological timeline: applied ops at
   * `0..ops.length-1`, then pending-redo ops after them in {@link redoList}
   * order. Jumping to position k makes the model state "after op k applied":
   * clicking an applied row rolls back past it, clicking a pending row
   * re-applies through it.
   *
   * This splices the boundary between the two arrays directly and fires ONE
   * `onChange` at the end — never a loop of {@link undo}/{@link redo} calls,
   * which would fire one `onChange`/`editsChanged`/autosave/re-tessellate
   * round trip PER STEP for a single click. Redo-buffer ORDER is preserved in
   * both directions, so ↶/↷ keep working correctly after any jump:
   * demoting ops onto the buffer's FRONT reversed puts the chronologically-
   * first demoted op where {@link redo} will pop it first; promoting ops off
   * the buffer's END reversed re-applies them in exactly the order repeated
   * {@link redo} calls would have. A jump that changes nothing (the last
   * applied row) is a no-op with no `onChange`, matching every other
   * mutation's no-op discipline.
   */
  jumpTo(index: number): void {
    const n = this.ops.length;
    const r = this.redoBuffer.length;
    if (index < 0 || index >= n + r) return;
    const target = index + 1; // applied count after jumping to timeline position `index`
    if (target === n) return;
    if (target < n) {
      const demoted = this.ops.splice(target);
      this.redoBuffer = [...demoted.reverse(), ...this.redoBuffer];
    } else {
      const restored = this.redoBuffer.splice(this.redoBuffer.length - (target - n)).reverse();
      this.ops.push(...restored);
    }
    this.onChange();
  }
}

function clone(op: EditOp): EditOp {
  // Ops are plain JSON-serializable values; a structured clone keeps nested
  // tuples/arrays from aliasing across the model boundary.
  return JSON.parse(JSON.stringify(op)) as EditOp;
}
