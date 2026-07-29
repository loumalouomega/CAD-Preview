/**
 * Pure data model for the Markup annotation overlay — freehand/line/arrow/
 * rectangle/circle strokes drawn over the 3D view for review notes ("this
 * boss", "gap here"), plus undo/redo. DOM-free (mirrors `explodePreview.ts`/
 * `editsModel.ts`'s pure-model convention) so it unit-tests headless;
 * `markupCanvas.ts` is the DOM-touching half that actually draws these onto
 * a `<canvas>`. Session-only — never persisted, never written to a sidecar.
 */

/** Canvas-space (CSS pixels) point. */
export interface Point {
  x: number;
  y: number;
}

/** All tools except `"eraser"` produce a stored, undoable stroke. */
export type DrawTool = "freehand" | "line" | "arrow" | "rectangle" | "circle";
export type MarkupTool = DrawTool | "eraser";

export interface MarkupStroke {
  tool: DrawTool;
  color: string;
  /** Freehand: every sampled point, in order. Line/arrow: `[start, end]`.
   * Rectangle: `[corner1, corner2]` (opposite corners). Circle: `[center, edge]`. */
  points: Point[];
}

const ERASE_HIT_DISTANCE_SQ = 12 * 12;

function distanceSq(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** True if `pt` lands within `ERASE_HIT_DISTANCE_SQ` of any of `stroke`'s
 * points — a coarse but simple hit test (good enough for an eraser cursor;
 * doesn't interpolate along segments between sparse points). */
function strokeHit(stroke: MarkupStroke, pt: Point): boolean {
  return stroke.points.some((p) => distanceSq(p, pt) <= ERASE_HIT_DISTANCE_SQ);
}

/**
 * Undo/redo stack of strokes. **The eraser is deliberately NOT part of the
 * undo/redo history** — `eraseAt()` removes whichever strokes it hits
 * immediately and permanently for this session, a simpler model than trying
 * to make an arbitrary (not necessarily most-recent) removal compose with a
 * linear undo/redo stack. `undo()`/`redo()` only ever add/remove the most
 * recently drawn stroke, exactly like `EditsModel`'s op stack.
 */
export class MarkupModel {
  private strokes: MarkupStroke[] = [];
  private redoStack: MarkupStroke[] = [];

  push(stroke: MarkupStroke): void {
    this.strokes.push(stroke);
    this.redoStack = [];
  }

  undo(): void {
    const s = this.strokes.pop();
    if (s) this.redoStack.push(s);
  }

  redo(): void {
    const s = this.redoStack.pop();
    if (s) this.strokes.push(s);
  }

  clear(): void {
    this.strokes = [];
    this.redoStack = [];
  }

  list(): readonly MarkupStroke[] {
    return this.strokes;
  }

  canUndo(): boolean {
    return this.strokes.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Removes every stroke with a point within the hit radius of `pt`.
   * Returns true if anything was removed (caller only needs to redraw then). */
  eraseAt(pt: Point): boolean {
    const before = this.strokes.length;
    this.strokes = this.strokes.filter((s) => !strokeHit(s, pt));
    return this.strokes.length !== before;
  }
}
