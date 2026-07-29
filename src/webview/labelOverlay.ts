/**
 * Composites a small top-left text label onto a copy of a canvas — used by
 * `Viewer.captureLabeledScreenshotBase64` to burn a view name (e.g. "TOP",
 * "ISO-A") into each PNG the headless `render_snapshot` MCP tool returns, so
 * an agent (or a human skimming the packet) can tell the views apart without
 * relying on image order. Plain Canvas2D, no Three.js dependency — kept as
 * its own module for the same reason `orientationCube.ts` isolates its own
 * canvas-drawing code: it must NEVER run at module load / import time (no
 * jsdom/canvas polyfill in this repo's vitest config — `geometryBuilder.ts`'s
 * lazily-built `dotTexture()` hit this exact trap once already, see
 * CLAUDE.md's Points section). `drawLabel` is only ever called from inside
 * `Viewer.captureLabeledScreenshotBase64`, itself only reachable via a real
 * `renderViewRequest` message — never at import time.
 */
export function drawLabel(source: HTMLCanvasElement, label: string): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext("2d");
  if (!ctx) return source;

  ctx.drawImage(source, 0, 0);

  const padding = 8;
  const fontSize = Math.max(14, Math.round(source.height * 0.03));
  ctx.font = `bold ${fontSize}px sans-serif`;
  const metrics = ctx.measureText(label);
  const boxWidth = metrics.width + padding * 2;
  const boxHeight = fontSize + padding * 2;

  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fillRect(0, 0, boxWidth, boxHeight);

  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(label, padding, boxHeight / 2);

  return out;
}
