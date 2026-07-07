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
}

function clone(op: EditOp): EditOp {
  // Ops are plain JSON-serializable values; a structured clone keeps nested
  // tuples/arrays from aliasing across the model boundary.
  return JSON.parse(JSON.stringify(op)) as EditOp;
}
