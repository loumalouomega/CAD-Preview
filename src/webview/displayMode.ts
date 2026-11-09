/**
 * The view-controls Display Mode selector's states — pure data, DOM/Three.js
 * free, imported by both `viewer.ts` (behavior) and `main.ts`/`viewerDom.ts`
 * (the button-group UI) so the two never drift. Replaces the old standalone
 * Wireframe toolbar toggle: Shaded/Wireframe are now two of six mutually
 * exclusive modes (`Viewer.setWireframe()` itself still exists as the
 * lower-level primitive `render_snapshot`'s per-call `wireframe` override
 * uses — see `renderService.ts` — display mode just drives it internally too).
 */
export type DisplayMode = "shaded" | "wireframe" | "xray" | "hiddenLines" | "flat" | "geometry" | "zebra";

export const DISPLAY_MODES: readonly DisplayMode[] = ["shaded", "wireframe", "xray", "hiddenLines", "flat", "geometry", "zebra"];

/** Zebra-stripe settings (ViewState.zebra): stripe count along the reflection
 *  vector's projection on `axis`. Pure data, shared by viewer, UI and sidecar. */
export type ZebraAxis = "x" | "y" | "z";
export interface ZebraSettings { count: number; axis: ZebraAxis }
export const ZEBRA_DEFAULT: ZebraSettings = { count: 8, axis: "y" };
export const ZEBRA_COUNT_RANGE = { min: 2, max: 40 } as const;

/** Tolerant parse: anything unusable yields `undefined` (field is optional). */
export function parseZebra(v: unknown): ZebraSettings | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { count, axis } = v as Record<string, unknown>;
  if (typeof count !== "number" || !Number.isFinite(count)) return undefined;
  if (axis !== "x" && axis !== "y" && axis !== "z") return undefined;
  return {
    count: Math.min(ZEBRA_COUNT_RANGE.max, Math.max(ZEBRA_COUNT_RANGE.min, Math.round(count))),
    axis,
  };
}

export const DISPLAY_MODE_LABELS: Record<DisplayMode, string> = {
  shaded: "Shaded",
  wireframe: "Wireframe",
  xray: "X-Ray",
  hiddenLines: "Hidden Lines",
  flat: "Flat",
  geometry: "Geometry",
  zebra: "Zebra",
};

export function isDisplayMode(value: string): value is DisplayMode {
  return (DISPLAY_MODES as string[]).includes(value);
}
