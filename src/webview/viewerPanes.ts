/**
 * Pure pane-layout math for the split-view feature (roadmap "Split view —
 * multiple synchronized viewports over one document", Phase 1) — the
 * DOM-free, unit-testable half, following the `clipping.ts`/`cameraControls.ts`
 * precedent of extracting the math so only the three.js application lives in
 * `viewer.ts`.
 *
 * A "pane" is a rectangular region of the single WebGL canvas, drawn via
 * `renderer.setViewport`/`setScissor`/`setScissorTest` — there is still exactly
 * one renderer, one canvas, and one scene (the invariant `orientationCube.ts`
 * established: a second WebGL context fails in some environments). All
 * coordinates here are CSS pixels (the same space `getBoundingClientRect()`
 * reports); conversion to the renderer's bottom-left-origin GL convention is
 * {@link glViewportForPane}.
 */

export type PaneLayoutId = "1x1" | "1x2" | "2x1" | "2x2";

/**
 * A pane's rectangle in CSS pixels, TOP-LEFT origin (DOM convention — the
 * same space `PointerEvent.clientX/clientY` and
 * `Element.getBoundingClientRect()` live in).
 */
export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const PANE_LAYOUTS: readonly PaneLayoutId[] = ["1x1", "1x2", "2x1", "2x2"];

/** Number of panes a layout produces. */
export function paneCount(layout: PaneLayoutId): number {
  if (layout === "2x2") return 4;
  if (layout === "1x2" || layout === "2x1") return 2;
  return 1;
}

/**
 * Computes every pane's rect for `layout` over a `cssWidth × cssHeight`
 * canvas. Rects are ordered row-major (0 = top-left, 1 = top-right,
 * 2 = bottom-left, 3 = bottom-right — the reading order every pane-index
 * consumer in `viewer.ts` uses). The split point rounds, and the last
 * row/column absorbs the remainder, so the rects always tile the canvas
 * exactly: no gaps, no overlaps, integer edges even for odd pixel counts.
 */
export function computePaneRects(layout: PaneLayoutId, cssWidth: number, cssHeight: number): PaneRect[] {
  if (layout === "1x1") {
    return [{ x: 0, y: 0, width: cssWidth, height: cssHeight }];
  }
  if (layout === "1x2") {
    // Two side-by-side columns (vertical split) — row-major: left, right.
    const leftW = Math.round(cssWidth / 2);
    const rightW = cssWidth - leftW;
    return [
      { x: 0, y: 0, width: leftW, height: cssHeight },
      { x: leftW, y: 0, width: rightW, height: cssHeight },
    ];
  }
  if (layout === "2x1") {
    // Two stacked rows (horizontal split) — row-major: top, bottom.
    const topH = Math.round(cssHeight / 2);
    const bottomH = cssHeight - topH;
    return [
      { x: 0, y: 0, width: cssWidth, height: topH },
      { x: 0, y: topH, width: cssWidth, height: bottomH },
    ];
  }
  const leftW = Math.round(cssWidth / 2);
  const topH = Math.round(cssHeight / 2);
  const rightW = cssWidth - leftW;
  const bottomH = cssHeight - topH;
  return [
    { x: 0, y: 0, width: leftW, height: topH },
    { x: leftW, y: 0, width: rightW, height: topH },
    { x: 0, y: topH, width: leftW, height: bottomH },
    { x: leftW, y: topH, width: rightW, height: bottomH },
  ];
}

/**
 * Index of the pane containing the canvas-relative CSS point, or `-1` if the
 * point lies outside every pane (including on the canvas's right/bottom outer
 * edge, which no rect owns — matching how a full-canvas NDC of exactly +1 is
 * the boundary). A point on a shared internal boundary belongs to exactly one
 * pane (the right/bottom neighbor is exclusive), so a click can never pick
 * two panes.
 */
export function paneAtPoint(rects: PaneRect[], cssX: number, cssY: number): number {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (cssX >= r.x && cssX < r.x + r.width && cssY >= r.y && cssY < r.y + r.height) return i;
  }
  return -1;
}

/**
 * NDC (-1..1, +Y up) for a canvas-relative CSS point within `rect`'s pane —
 * the pane-relative equivalent of the full-canvas math `onSelectPointerUp`
 * used before split view existed. Feeds `Raycaster.setFromCamera`, whose NDC
 * is relative to whatever viewport the camera's projection covers.
 */
export function ndcInPane(rect: PaneRect, cssX: number, cssY: number): { x: number; y: number } {
  return {
    x: ((cssX - rect.x) / rect.width) * 2 - 1,
    y: 1 - ((cssY - rect.y) / rect.height) * 2,
  };
}

/**
 * Converts a top-left-origin CSS rect to the bottom-left-origin GL viewport
 * rect `renderer.setViewport`/`setScissor` (and `TransformControls.viewport`,
 * which documents the same convention) expect. `cssHeight` is the full
 * canvas height the rect is measured from.
 */
export function glViewportForPane(
  rect: PaneRect,
  cssHeight: number
): { x: number; y: number; width: number; height: number } {
  return { x: rect.x, y: cssHeight - rect.y - rect.height, width: rect.width, height: rect.height };
}
