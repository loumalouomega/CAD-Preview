import type { MarkupStroke } from "./markupModel";

/**
 * Canvas2D rendering for the Markup overlay — DOM-touching, only ever called
 * at runtime (never at module load), same discipline
 * `geometryBuilder.ts`'s lazily-built `dotTexture()` established for canvas
 * work in this codebase. Not realistically unit-testable under this repo's
 * vitest setup (no jsdom/canvas polyfill) — verified only via manual F5.
 */

const STROKE_WIDTH = 3;

/** Draws one stroke in its final (committed or live-preview) shape. */
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: MarkupStroke): void {
  const pts = stroke.points;
  if (pts.length === 0) return;
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = STROKE_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (stroke.tool === "freehand") {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    return;
  }
  if (pts.length < 2) return; // line/arrow/rectangle/circle all need a second point
  const [a, b] = pts;

  if (stroke.tool === "line") {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    return;
  }
  if (stroke.tool === "arrow") {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const headLen = 10 + STROKE_WIDTH;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - headLen * Math.cos(angle - Math.PI / 6), b.y - headLen * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - headLen * Math.cos(angle + Math.PI / 6), b.y - headLen * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
    return;
  }
  if (stroke.tool === "rectangle") {
    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    return;
  }
  // circle: a = center, b = a point on the edge
  const radius = Math.hypot(b.x - a.x, b.y - a.y);
  ctx.beginPath();
  ctx.arc(a.x, a.y, radius, 0, Math.PI * 2);
  ctx.stroke();
}

/** Clears `canvas` and redraws every stroke in order, then (if given) the
 * in-progress live-preview stroke on top. */
export function redrawAll(canvas: HTMLCanvasElement, strokes: readonly MarkupStroke[], preview?: MarkupStroke): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const s of strokes) drawStroke(ctx, s);
  if (preview) drawStroke(ctx, preview);
}
