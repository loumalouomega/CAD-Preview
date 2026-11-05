/**
 * Mouse-navigation presets (roadmap "Navigation upgrades"). One table drives
 * every preset; the viewer translates the action names into `OrbitControls`'
 * `mouseButtons`. Pure and three-free so it unit-tests headless.
 *
 * `OrbitControls` swaps rotate and pan when Shift/Ctrl/Meta is held, which is
 * exactly Fusion's "middle-drag pans, Shift+middle-drag orbits".
 *
 * Touchpad: a trackpad's two-finger scroll arrives as `wheel` events without
 * Ctrl, and a pinch arrives as `wheel` WITH `ctrlKey`. Under that preset a
 * plain wheel PANS and the Ctrl-wheel pinch still zooms (OrbitControls already
 * treats it so). A physical mouse wheel sends the same plain events, so it pans
 * too — the accepted trade-off, stated in the setting's description.
 *
 * Not offered (see the roadmap): an OpenSCAD preset — its mapping equals
 * Default, so it would be a name only.
 */
export type NavigationPreset = "default" | "fusion" | "touchpad";
export type WheelBehaviour = "zoom" | "pan";
export type MouseAction = "rotate" | "dolly" | "pan" | "none";

export interface MouseMapping {
  left: MouseAction;
  middle: MouseAction;
  right: MouseAction;
  /** What a plain (no Ctrl) wheel event does. A Ctrl-wheel always zooms (OrbitControls' pinch handling). */
  wheel?: WheelBehaviour;
}

/** The wheel behaviour of a preset ("zoom" unless it says otherwise). */
export function wheelBehaviourOf(preset: NavigationPreset): WheelBehaviour {
  return NAVIGATION_PRESETS[preset].wheel ?? "zoom";
}

const LINE_PX = 16;
const PAGE_PX = 400;

/**
 * Pixel deltas of a wheel event, whatever its `deltaMode` (0 pixel, 1 line, 2 page).
 * Pure: the caller passes `event.deltaX/deltaY/deltaMode`.
 */
export function wheelDeltaPixels(deltaX: number, deltaY: number, deltaMode: number): [number, number] {
  const k = deltaMode === 1 ? LINE_PX : deltaMode === 2 ? PAGE_PX : 1;
  return [deltaX * k, deltaY * k];
}

/**
 * Camera offset for a two-finger scroll: `right`/`up` in world units along the
 * camera's own axes. `worldHeight` is the world-space height visible at the
 * target (perspective: `2·distance·tan(fov/2)`; orthographic:
 * `(top − bottom) / zoom`) and `viewHeightPx` the pane's pixel height, so the
 * scene follows the fingers at 1:1 on screen. Scrolling "down" (positive
 * deltaY) moves the view down, i.e. the content moves up.
 */
export function wheelPanOffset(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
  worldHeight: number,
  viewHeightPx: number
): { right: number; up: number } {
  if (!(worldHeight > 0) || !(viewHeightPx > 0)) return { right: 0, up: 0 };
  const [px, py] = wheelDeltaPixels(deltaX, deltaY, deltaMode);
  const k = worldHeight / viewHeightPx;
  return { right: px * k, up: -py * k };
}

export const NAVIGATION_PRESETS: Readonly<Record<NavigationPreset, MouseMapping>> = {
  // Left orbits, wheel-button zooms, right pans (this extension's long-standing mapping).
  default: { left: "rotate", middle: "dolly", right: "pan" },
  // Fusion: the left button is left free for selection; middle pans, Shift+middle orbits.
  fusion: { left: "none", middle: "pan", right: "none" },
  // Touchpad: the default buttons, but a plain wheel (two-finger scroll) pans and a pinch (Ctrl-wheel) zooms.
  touchpad: { left: "rotate", middle: "pan", right: "pan", wheel: "pan" },
};

export const NAVIGATION_PRESET_IDS = Object.keys(NAVIGATION_PRESETS) as NavigationPreset[];

export function normalizeNavigationPreset(raw: unknown): NavigationPreset {
  return typeof raw === "string" && (NAVIGATION_PRESET_IDS as string[]).includes(raw) ? (raw as NavigationPreset) : "default";
}
