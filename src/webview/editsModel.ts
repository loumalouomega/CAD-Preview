import { MAX_OP_LABEL, type EditOp } from "../editOps";
import { planOpMove, type OpMoveRefusal } from "../reorderOps";

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
 *
 * Tier 0 Phase 2 — the save point: `bakedThrough` leading ops live in the
 * source file itself, so no mutation may cross it (the "you cannot undo past
 * a save" contract every editor already has). Mutations return `true` when
 * they changed state (and fired `onChange`), `false` when refused or a
 * no-op — callers show the save-point guidance on a refusal. `push`/`redo`
 * only ever touch the unbaked tail, so they stay always-legal.
 */
export class EditsModel {
  private ops: EditOp[] = [];
  private redoBuffer: EditOp[] = [];
  private bakedThrough = 0;

  /** Called after every successful {@link push} (the command bar echoes panel-built ops through it). */
  onPush: ((op: EditOp) => void) | null = null;

  constructor(private readonly onChange: () => void) {}

  /** Replaces the op-list from a freshly-loaded sidecar (does not fire onChange). */
  load(ops: EditOp[], bakedThrough = 0): void {
    this.ops = ops.map(clone);
    this.redoBuffer = [];
    this.bakedThrough = Math.min(Math.max(Math.floor(bakedThrough) || 0, 0), this.ops.length);
  }

  /** Leading ops already saved into the source file (refused as undo/remove/jump targets). */
  get savePoint(): number {
    return this.bakedThrough;
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
    return this.ops.length > this.bakedThrough;
  }

  get canRedo(): boolean {
    return this.redoBuffer.length > 0;
  }

  /** Appends a new op; clears the redo buffer (a new branch). Always legal. */
  push(op: EditOp): boolean {
    this.ops.push(clone(op));
    this.redoBuffer = [];
    this.onChange();
    this.onPush?.(clone(op));
    return true;
  }

  /** Pops the last op onto the redo buffer. Refused at/inside the save point. */
  undo(): boolean {
    if (this.ops.length <= this.bakedThrough) return false;
    const op = this.ops.pop();
    if (!op) return false;
    this.redoBuffer.push(op);
    this.onChange();
    return true;
  }

  /** Re-applies the most recently undone op. Always legal (tail only). */
  redo(): boolean {
    const op = this.redoBuffer.pop();
    if (!op) return false;
    this.ops.push(op);
    this.onChange();
    return true;
  }

  /** Removes every op (the redo buffer too). Refused past a save point. */
  clear(): boolean {
    if (this.ops.length === 0 && this.redoBuffer.length === 0) return false;
    if (this.bakedThrough > 0) return false;
    this.ops = [];
    this.redoBuffer = [];
    this.onChange();
    return true;
  }

  /**
   * Removes a single op at `index` from anywhere in the applied list (unlike
   * {@link undo}, which only pops the last one). Clears the redo buffer, same
   * as {@link push} — a deliberate edit like this abandons any pending redo
   * rather than leaving it to replay against a list it was never undone from.
   * Topology-changing ops after the removed one may reassign ids on reload —
   * same accepted "entity-id drift" risk as undo/redo already carries.
   * Refused inside the save point (and for out-of-range indices, as before).
   */
  remove(index: number): boolean {
    if (index < this.bakedThrough || index < 0 || index >= this.ops.length) return false;
    this.ops.splice(index, 1);
    this.redoBuffer = [];
    this.onChange();
    return true;
  }

  /**
   * Replaces the op at `index` in place (Parameters table: edit a field, or
   * promote it to a variable). Clears the redo buffer like {@link remove}.
   * Refused inside the save point and for out-of-range indices.
   */
  replaceAt(index: number, op: EditOp): boolean {
    if (index < this.bakedThrough || index < 0 || index >= this.ops.length) return false;
    this.ops[index] = clone(op);
    this.redoBuffer = [];
    this.onChange();
    return true;
  }

  /**
   * Suppress/unsuppress and/or relabel the op at `index` (roadmap "History
   * timeline depth"). `label: null` clears it. Refused inside the save point;
   * a call that changes nothing is a no-op with no `onChange`.
   */
  setState(index: number, state: { suppressed?: boolean; label?: string | null }): boolean {
    if (index < this.bakedThrough || index < 0 || index >= this.ops.length) return false;
    const next = clone(this.ops[index]);
    if (state.suppressed === true) next.suppressed = true;
    else if (state.suppressed === false) delete next.suppressed;
    if (state.label !== undefined) {
      const t = (state.label ?? "").trim().slice(0, MAX_OP_LABEL);
      if (t) next.label = t;
      else delete next.label;
    }
    if (JSON.stringify(next) === JSON.stringify(this.ops[index])) return false;
    this.ops[index] = next;
    this.redoBuffer = [];
    this.onChange();
    return true;
  }

  /**
   * Moves the op at `from` so it ends up at `to` (history drag). The decision is
   * `planOpMove`'s — baked prefix, stored selector queries (`externalRefs` adds
   * the ones Parts hold) and two shape-changing ops are refused with a reason.
   * Clears the redo buffer like {@link remove}; one `onChange`. Returns the old→new
   * index mapping so index-keyed lists (configurations) can follow.
   */
  move(from: number, to: number, externalRefs: Iterable<number> = []): { ok: true; mapping: number[] } | OpMoveRefusal {
    const plan = planOpMove(this.ops, from, to, this.bakedThrough, externalRefs);
    if (!plan.ok) return plan;
    this.ops = plan.ops.map(clone);
    this.redoBuffer = [];
    this.onChange();
    return { ok: true, mapping: plan.mapping };
  }

  /**
   * Puts ops `from..to` (inclusive) into the history folder `name`, or takes
   * them out with `null`/empty. Display only: replay never reads the tag. One
   * `onChange` for the whole range; refused inside the save point and for an
   * out-of-range or reversed range; a range that already matches is a no-op.
   */
  setFolder(from: number, to: number, name: string | null): boolean {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) return false;
    if (from < this.bakedThrough || from < 0 || to >= this.ops.length) return false;
    const t = (name ?? "").trim().slice(0, MAX_OP_LABEL);
    let changed = false;
    for (let i = from; i <= to; i++) {
      const next = clone(this.ops[i]);
      if (t) next.folder = t;
      else delete next.folder;
      if (JSON.stringify(next) !== JSON.stringify(this.ops[i])) {
        this.ops[i] = next;
        changed = true;
      }
    }
    if (!changed) return false;
    this.redoBuffer = [];
    this.onChange();
    return true;
  }

  /**
   * Moves the stack boundary straight to timeline position `index` in ONE
   * splice — the op-history-scrubbing primitive.
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
   * mutation's no-op discipline. A jump to at or inside the save point is
   * refused (`false`) — unbaking is revert's job, not the timeline's.
   */
  jumpTo(index: number): boolean {
    const n = this.ops.length;
    const r = this.redoBuffer.length;
    if (index < 0 || index >= n + r) return false;
    const target = index + 1; // applied count after jumping to timeline position `index`
    if (target === n) return false;
    if (target < this.bakedThrough) return false;
    if (target < n) {
      const demoted = this.ops.splice(target);
      this.redoBuffer = [...demoted.reverse(), ...this.redoBuffer];
    } else {
      const restored = this.redoBuffer.splice(this.redoBuffer.length - (target - n)).reverse();
      this.ops.push(...restored);
    }
    this.onChange();
    return true;
  }
}

function clone(op: EditOp): EditOp {
  // Ops are plain JSON-serializable values; a structured clone keeps nested
  // tuples/arrays from aliasing across the model boundary.
  return JSON.parse(JSON.stringify(op)) as EditOp;
}
