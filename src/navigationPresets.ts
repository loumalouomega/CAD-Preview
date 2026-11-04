/**
 * Mouse-navigation presets (roadmap "Navigation upgrades"). One table drives
 * every preset; the viewer translates the action names into `OrbitControls`'
 * `mouseButtons`. Pure and three-free so it unit-tests headless.
 *
 * `OrbitControls` swaps rotate and pan when Shift/Ctrl/Meta is held, which is
 * exactly Fusion's "middle-drag pans, Shift+middle-drag orbits".
 *
 * Not yet offered (see the roadmap): an OpenSCAD preset (its mapping equals
 * Default) and a Touchpad preset (two-finger pan and pinch zoom need wheel
 * gesture handling).
 */
export type NavigationPreset = "default" | "fusion";
export type MouseAction = "rotate" | "dolly" | "pan" | "none";

export interface MouseMapping {
  left: MouseAction;
  middle: MouseAction;
  right: MouseAction;
}

export const NAVIGATION_PRESETS: Readonly<Record<NavigationPreset, MouseMapping>> = {
  // Left orbits, wheel-button zooms, right pans (this extension's long-standing mapping).
  default: { left: "rotate", middle: "dolly", right: "pan" },
  // Fusion: the left button is left free for selection; middle pans, Shift+middle orbits.
  fusion: { left: "none", middle: "pan", right: "none" },
};

export const NAVIGATION_PRESET_IDS = Object.keys(NAVIGATION_PRESETS) as NavigationPreset[];

export function normalizeNavigationPreset(raw: unknown): NavigationPreset {
  return typeof raw === "string" && (NAVIGATION_PRESET_IDS as string[]).includes(raw) ? (raw as NavigationPreset) : "default";
}
