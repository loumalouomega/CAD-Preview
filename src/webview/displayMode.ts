/**
 * The view-controls Display Mode selector's states — pure data, DOM/Three.js
 * free, imported by both `viewer.ts` (behavior) and `main.ts`/`viewerDom.ts`
 * (the button-group UI) so the two never drift. Replaces the old standalone
 * Wireframe toolbar toggle: Shaded/Wireframe are now two of five mutually
 * exclusive modes (`Viewer.setWireframe()` itself still exists as the
 * lower-level primitive `render_snapshot`'s per-call `wireframe` override
 * uses — see `renderService.ts` — display mode just drives it internally too).
 */
export type DisplayMode = "shaded" | "wireframe" | "xray" | "hiddenLines" | "flat";

export const DISPLAY_MODES: readonly DisplayMode[] = ["shaded", "wireframe", "xray", "hiddenLines", "flat"];

export const DISPLAY_MODE_LABELS: Record<DisplayMode, string> = {
  shaded: "Shaded",
  wireframe: "Wireframe",
  xray: "X-Ray",
  hiddenLines: "Hidden Lines",
  flat: "Flat",
};

export function isDisplayMode(value: string): value is DisplayMode {
  return (DISPLAY_MODES as string[]).includes(value);
}
