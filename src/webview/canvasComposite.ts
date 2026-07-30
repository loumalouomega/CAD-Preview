/**
 * Merges an overlay canvas (the Markup annotation layer) on top of a copy of
 * a base canvas (the WebGL render) into one flattened canvas, for the
 * Screenshot feature — `Viewer.captureScreenshotBase64()`/
 * `captureLabeledScreenshotBase64()` both call this before reading pixels.
 * Plain Canvas2D, no Three.js. `overlay` may be a different backing
 * resolution than `base` (the interactive markup canvas is sized in CSS
 * pixels, `base` — the WebGL renderer's canvas — in device pixels); the
 * 5-argument `drawImage` form stretch-fits it to `base`'s size regardless,
 * so no devicePixelRatio bookkeeping is needed here. Only ever called at
 * runtime (never at module load), same discipline as `labelOverlay.ts`'s
 * `drawLabel`.
 */
export function compositeCanvas(base: HTMLCanvasElement, overlay: HTMLCanvasElement | null): HTMLCanvasElement {
  if (!overlay) return base;
  const out = document.createElement("canvas");
  out.width = base.width;
  out.height = base.height;
  const ctx = out.getContext("2d");
  if (!ctx) return base;
  ctx.drawImage(base, 0, 0);
  ctx.drawImage(overlay, 0, 0, out.width, out.height);
  return out;
}
