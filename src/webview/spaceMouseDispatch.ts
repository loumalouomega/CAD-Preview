/**
 * SpaceMouse → camera dispatch (roadmap Tier 2 item 2, Phase 1).
 *
 * Pure and DOM/THREE-free: maps a raw device motion event onto the
 * minimal viewer interface below, so it unit-tests headless with a fake
 * viewer (no DOM, no renderer — same convention as `cameraControls.ts`).
 * `main.ts`'s `"spacemouse"` handler is a thin timestamp + state wrapper
 * around {@link applySpaceMouseInput}.
 *
 * Rate model: the host forwards one message per HID report, so the event
 * rate is device-driven, not frame-driven. Deltas scale by the time since
 * the previous event (clamped), making feel independent of report rate —
 * there is deliberately no animation-frame loop change (render-on-demand
 * stays intact: a zero-velocity event issues zero viewer calls, hence
 * zero frames). Per-second speeds are constants flagged tune-on-hardware
 * (no SpaceMouse hardware exists in this environment).
 */

import { motionToVelocity, type SpaceMouseMotion } from "../spaceMouseReports";

/** The only viewer surface SpaceMouse input needs. */
export interface SpaceMouseViewTarget {
  rotateView(azimuthDeg: number, polarDeg: number): void;
  panView(dxFrac: number, dyFrac: number): void;
  zoomView(factor: number): void;
  fitView(): void;
  resetView(): void;
}

/** Framed-extent fractions per second at full deflection. */
export const SPACEMOUSE_PAN_PER_SEC = 0.5;
/** Degrees per second at full deflection. */
export const SPACEMOUSE_ORBIT_DEG_PER_SEC = 90;
/** Zoom doublings per second at full deflection (exponential). */
export const SPACEMOUSE_ZOOM_DOUBLINGS_PER_SEC = 1.5;

/** Button-bit conventions (model-dependent assumption — flagged). */
export const SPACEMOUSE_BUTTON_FIT = 0x01;
export const SPACEMOUSE_BUTTON_RESET = 0x02;

/** dt clamp bounds (ms): below is timer noise, above is a sleep/resume gap. */
const DT_MIN_MS = 1;
const DT_MAX_MS = 100;

export interface SpaceMouseSpeeds {
  panPerSec: number;
  orbitDegPerSec: number;
  zoomDoublingsPerSec: number;
}

export const DEFAULT_SPACEMOUSE_SPEEDS: SpaceMouseSpeeds = {
  panPerSec: SPACEMOUSE_PAN_PER_SEC,
  orbitDegPerSec: SPACEMOUSE_ORBIT_DEG_PER_SEC,
  zoomDoublingsPerSec: SPACEMOUSE_ZOOM_DOUBLINGS_PER_SEC,
};

/**
 * Apply one motion event. Issues viewer calls ONLY for nonzero channels
 * (a resting puck must not wake the render loop) and returns the button
 * mask to thread as `lastButtons` into the next call — rising edges drive
 * Fit/Reset, levels do nothing (holding a button must not re-fit 60×/s).
 */
export function applySpaceMouseInput(
  target: SpaceMouseViewTarget,
  motion: SpaceMouseMotion,
  buttons: number | undefined,
  lastButtons: number,
  dtMs: number,
  speeds: SpaceMouseSpeeds = DEFAULT_SPACEMOUSE_SPEEDS
): number {
  const dtSec = Math.max(DT_MIN_MS, Math.min(DT_MAX_MS, dtMs)) / 1000;
  const v = motionToVelocity(motion);
  if (v.panX !== 0 || v.panY !== 0) {
    target.panView(v.panX * speeds.panPerSec * dtSec, v.panY * speeds.panPerSec * dtSec);
  }
  if (v.zoom !== 0) {
    target.zoomView(Math.pow(2, (-v.zoom * speeds.zoomDoublingsPerSec * dtSec)));
  }
  if (v.orbitAz !== 0 || v.orbitPol !== 0) {
    target.rotateView(v.orbitAz * speeds.orbitDegPerSec * dtSec, v.orbitPol * speeds.orbitDegPerSec * dtSec);
  }
  const mask = buttons ?? 0;
  const risen = mask & ~lastButtons;
  if ((risen & SPACEMOUSE_BUTTON_FIT) !== 0) {
    target.fitView();
  }
  if ((risen & SPACEMOUSE_BUTTON_RESET) !== 0) {
    target.resetView();
  }
  return mask;
}
