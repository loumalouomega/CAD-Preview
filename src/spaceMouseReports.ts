/**
 * SpaceMouse HID input-report parsing + velocity mapping (roadmap Tier 2
 * item 2, Phase-0 probe — hardware-free, unit-tested).
 *
 * Pure and dependency-free: parses the raw report Buffers `node-hid`
 * delivers via `device.on("data")` into normalized velocities. Report
 * layout ported from SindriCAD's `spacemouse.rs` `stream()` (measured on a
 * real SpaceNavigator — report IDs, offsets, and little-endian i16 axes):
 * - report ID 1: translation axes at bytes 1/3/5; rotation at 7/9/11 when
 *   the report is ≥ 13 bytes (newer devices pack both in one report).
 * - report ID 2: rotation axes at bytes 1/3/5 (older devices split the
 *   two triplets across IDs 1 and 2 — hence the merge below).
 * - report ID 3: button bitmask, bytes 1..4 little-endian.
 * - anything else: ignored.
 *
 * Older split-report devices motivate the stateful merge: this module keeps
 * no state itself (pure functions over an explicit previous state, matching
 * this codebase's preference for testable functions over stateful objects),
 * but Phase 1 must thread one `{t, r}` triple through successive reports so
 * a rotation-only report doesn't zero the last-known translation.
 *
 * SIGN CONVENTIONS ARE UNVERIFIED (flagged per-field below): no SpaceMouse
 * hardware exists in this environment, so which physical direction each
 * sign means is assumed from the 3Dconnexion convention (push = +tz, right
 * = +tx, up = +ty, tilt/roll positive per right-hand rule) and MUST be
 * confirmed on hardware before release — every sign below is one boolean
 * flip in Phase 1 if wrong. Magnitudes are hardware-independent by
 * construction: this module only deadzones + normalizes to [-1, 1];
 * per-second speeds belong to Phase 1 (which multiplies by frame dt),
 * so no fake physics is baked in here.
 */

/** Raw device units: signed 16-bit per axis, full deflection ≈ ±350. */
export interface SpaceMouseMotion {
  tx: number;
  ty: number;
  tz: number;
  rx: number;
  ry: number;
  rz: number;
}

/** Last-known triplets, threaded through successive reports (see above). */
export interface SpaceMouseTriplets {
  t: [number, number, number];
  r: [number, number, number];
}

export const ZERO_TRIPLETS: SpaceMouseTriplets = {
  t: [0, 0, 0],
  r: [0, 0, 0],
};

export interface ParsedSpaceMouseReport {
  t: [number, number, number];
  r: [number, number, number];
  /** Present only on report ID 3. Opaque bitmask — Phase 1 maps bits. */
  buttons?: number;
}

function axisAt(buf: readonly number[] | Uint8Array, i: number, n: number): number {
  if (i + 1 >= n) return 0;
  const raw = buf[i] | (buf[i + 1] << 8);
  // Sign-extend the 16-bit little-endian value.
  return raw & 0x8000 ? raw - 0x10000 : raw;
}

/**
 * Parse one input report, merging split translation/rotation triplets
 * across the previous state. Short/truncated buffers degrade to zeros for
 * the missing axes (never throw, never guess) — same "truncated proves
 * nothing" discipline as `hidDescriptor.ts`.
 */
export function parseSpaceMouseReport(
  bytes: readonly number[] | Uint8Array,
  prev: SpaceMouseTriplets = ZERO_TRIPLETS
): ParsedSpaceMouseReport {
  const n = bytes.length;
  if (n === 0) return { t: [...prev.t] as [number, number, number], r: [...prev.r] as [number, number, number] };
  const id = bytes[0];
  if (id === 1) {
    const t: [number, number, number] = [axisAt(bytes, 1, n), axisAt(bytes, 3, n), axisAt(bytes, 5, n)];
    const r: [number, number, number] =
      n >= 13 ? [axisAt(bytes, 7, n), axisAt(bytes, 9, n), axisAt(bytes, 11, n)] : [...prev.r] as [number, number, number];
    return { t, r };
  }
  if (id === 2) {
    return {
      t: [...prev.t] as [number, number, number],
      r: [axisAt(bytes, 1, n), axisAt(bytes, 3, n), axisAt(bytes, 5, n)],
    };
  }
  if (id === 3) {
    let mask = 0;
    for (let k = 1; k < Math.min(n, 5); k++) {
      mask |= bytes[k] << (8 * (k - 1));
    }
    return { t: [...prev.t] as [number, number, number], r: [...prev.r] as [number, number, number], buttons: mask >>> 0 };
  }
  return { t: [...prev.t] as [number, number, number], r: [...prev.r] as [number, number, number] };
}

/**
 * Normalized per-event velocity in [-1, 1] per channel, 0 inside the
 * deadzone. Full device deflection (≈ ±350) maps to ±1; beyond clamps
 * (never extrapolates).
 */
export interface SpaceMouseVelocity {
  panX: number;
  panY: number;
  zoom: number;
  orbitAz: number;
  orbitPol: number;
}

/** Raw deflection below this reads as rest (device noise floor). */
export const SPACEMOUSE_DEADZONE = 8;
/** Raw deflection that maps to full velocity. */
export const SPACEMOUSE_MAX_DEFLECTION = 350;

function channel(v: number, deadzone: number, max: number): number {
  if (Math.abs(v) < deadzone) return 0;
  return Math.max(-1, Math.min(1, v / max));
}

/**
 * Map raw triplets to camera velocity channels. SIGN ASSUMPTIONS
 * (unverified, see module doc): +tx pans right, +ty pans up, +tz pushes
 * into the scene (zoom in), +ry orbits right, +rx tilts up. `rz` (twist
 * about the view axis) is DELIBERATELY unmapped — OrbitControls has no
 * roll axis, so there is no honest target for it; document, don't fake.
 * Phase 1 multiplies these [-1, 1] channels by per-second speeds and
 * frame dt before calling `Viewer.panView`/`zoomView`/`rotateView`.
 */
export function motionToVelocity(
  m: SpaceMouseMotion,
  deadzone: number = SPACEMOUSE_DEADZONE,
  max: number = SPACEMOUSE_MAX_DEFLECTION
): SpaceMouseVelocity {
  return {
    panX: channel(m.tx, deadzone, max),
    panY: channel(m.ty, deadzone, max),
    zoom: channel(m.tz, deadzone, max),
    orbitAz: channel(m.ry, deadzone, max),
    orbitPol: channel(m.rx, deadzone, max),
  };
}
