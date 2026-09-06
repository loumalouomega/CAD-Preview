/**
 * SpaceMouse-class 6DOF input, host side (roadmap Tier 2 item 2, Phase 1).
 *
 * The extension host is a plain Node.js process (not a browser sandbox),
 * so it reads the device directly via `node-hid` (MIT, NAPI) and forwards
 * parsed motion to the webview over the existing `postMessage` channel —
 * mirroring the OCCT-in-host / Three.js-in-webview split, with no
 * Tauri-style native shell. Discovery ranking, report parsing, and the
 * reconnect discipline are ported from SindriCAD's `spacemouse.rs`; see
 * `spaceMouseRank.ts` / `hidDescriptor.ts` / `spaceMouseReports.ts`.
 *
 * Lazy by construction: `node-hid` is `require()`d inside `connect()`,
 * never at import time (esbuild `external`, so the bundle never touches
 * it), and nothing here runs from `activate()` — only the explicit
 * Connect command starts the reader, so the extension activates and runs
 * fine where the package is absent, the platform is uncovered, or no
 * device exists. All `node-hid` async rejections are handled (its README
 * warns unhandled ones can crash the host).
 */

import { rankSpaceMouseCandidate, UNPROVEN } from "./spaceMouseRank";
import {
  parseSpaceMouseReport,
  ZERO_TRIPLETS,
  type SpaceMouseMotion,
  type SpaceMouseTriplets,
} from "./spaceMouseReports";
import type { Device as HidDeviceInfo } from "node-hid";

export type { SpaceMouseMotion };

export interface SpaceMouseConnectResult {
  /** Product string of the opened device (or "SpaceMouse" fallback). */
  name: string;
  /** Set when streaming on a vendor-only match without descriptor proof. */
  note?: string;
}

export interface SpaceMouseStatus {
  connected: boolean;
  name?: string;
  note?: string;
}

export type SpaceMouseMotionHandler = (motion: SpaceMouseMotion, buttons?: number) => void;

interface HidModule {
  devicesAsync: () => Promise<HidDeviceInfo[]>;
  HIDAsync: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    open(path: string): Promise<any>;
  };
}

function loadHid(): HidModule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("node-hid") as HidModule;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "MODULE_NOT_FOUND" || /cannot find module/i.test((err as Error)?.message ?? "")) {
      throw new Error(
        "SpaceMouse support is not installed for this platform (node-hid has no usable binary here) — " +
          "motion input is unavailable, everything else in the extension is unaffected."
      );
    }
    throw new Error(`SpaceMouse: failed to load the HID layer (${(err as Error)?.message ?? err}).`);
  }
}

function describe(d: HidDeviceInfo): string {
  const vid = (d.vendorId ?? 0).toString(16).padStart(4, "0");
  const pid = (d.productId ?? 0).toString(16).padStart(4, "0");
  return `${vid}:${pid} usage ${d.usagePage ?? 0}/${d.usage ?? 0} ${d.product ?? "?"}`;
}

function isLinux(): boolean {
  return typeof process !== "undefined" && process.platform === "linux";
}

const UDEV_HINT =
  "On Linux this usually means the udev rule is missing (enumeration needs only " +
  "the USB node; OPENING needs the hidraw node, which is root-only until the rule " +
  "lands) — install a rule targeting SUBSYSTEM==\"hidraw\" (not \"usb\") for your " +
  "device's vendor id, e.g. KERNEL==\"hidraw*\", ATTRS{idVendor}==\"256f\", " +
  "MODE=\"0660\", GROUP=\"input\", then reload udev and replug. A running " +
  "spacenavd (or vendor driver) holding the device also blocks direct access.";

const RECONNECT_MS = 3000;

let wanted = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let device: any | null = null;
let triplets: SpaceMouseTriplets = { ...ZERO_TRIPLETS, t: [...ZERO_TRIPLETS.t] as [number, number, number], r: [...ZERO_TRIPLETS.r] as [number, number, number] };
let activeName: string | undefined;
let activeNote: string | undefined;
let handler: SpaceMouseMotionHandler | null = null;
let hidCache: HidModule | null = null;

function hid(): HidModule {
  if (!hidCache) hidCache = loadHid();
  return hidCache;
}

function stopTimer(): void {
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
}

function closeDevice(): void {
  if (device) {
    try {
      device.removeAllListeners?.();
    } catch {
      /* ignore */
    }
    try {
      device.close();
    } catch {
      /* ignore */
    }
    device = null;
  }
  activeName = undefined;
  activeNote = undefined;
}

/**
 * Connect to the best-ranked SpaceMouse and start streaming motion to
 * `onMotion`. Resolves with the device name once streaming; throws a
 * human-readable Error when there is nothing to stream from (no device,
 * unloadable layer, unopenable device). Idempotent while connected.
 */
export async function connectSpaceMouse(onMotion: SpaceMouseMotionHandler): Promise<SpaceMouseConnectResult> {
  if (device) return { name: activeName ?? "SpaceMouse", note: activeNote };
  const api = hid();
  const infos = await api.devicesAsync();
  const ranked = infos
    .map((d) => ({ score: rankSpaceMouseCandidate(d.vendorId ?? 0, d.usagePage ?? 0, d.usage ?? 0), info: d }))
    .filter((e): e is { score: number; info: HidDeviceInfo } => e.score !== null)
    .sort((a, b) => b.score - a.score);
  // Never fall through to a lower rank when the best won't open (see
  // spaceMouseRank.ts): on Linux that signature means the udev rule is
  // missing, and quietly opening some other Logitech device instead is
  // precisely the bug the ranking exists to prevent.
  const best = ranked[0];
  if (!best) {
    throw new Error("No SpaceMouse detected — connect one and run CAD Preview: Connect SpaceMouse again.");
  }
  const name = best.info.product || "SpaceMouse";
  if (!best.info.path) {
    throw new Error(
      `Found "${name}" (${describe(best.info)}) but it exposes no openable device path — cannot stream from it.`
    );
  }
  let dev;
  try {
    dev = await api.HIDAsync.open(best.info.path);
  } catch (err) {
    const detail = (err as Error)?.message ?? String(err);
    throw new Error(
      `Found "${name}" (${describe(best.info)}) but could not open it: ${detail}.` +
        (isLinux() ? ` ${UDEV_HINT}` : "")
    );
  }
  let note: string | undefined;
  if (best.score <= UNPROVEN) {
    // Vendor-only match with no usage info, and node-hid exposes no
    // report-descriptor API to prove it (see hidDescriptor.ts) — stream
    // anyway with a loud note rather than regress a device that works,
    // exactly SindriCAD's Proof::Unavailable branch.
    note =
      `streaming "${name}" on its vendor id alone — its HID usage was unavailable during ` +
      `enumeration, so if the camera moves on its own, disconnect and report the device model`;
  }
  wanted = true;
  handler = onMotion;
  device = dev;
  activeName = name;
  activeNote = note;
  triplets = { t: [0, 0, 0], r: [0, 0, 0] };
  dev.on("data", (buf: Buffer) => {
    try {
      const parsed = parseSpaceMouseReport(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), triplets);
      triplets = { t: parsed.t, r: parsed.r };
      handler?.(
        { tx: parsed.t[0], ty: parsed.t[1], tz: parsed.t[2], rx: parsed.r[0], ry: parsed.r[1], rz: parsed.r[2] },
        parsed.buttons
      );
    } catch {
      /* a malformed report must never break the stream */
    }
  });
  dev.on("error", () => {
    // A read failure after a successful open is an unplug or transport
    // hiccup, not permissions — reconnect quietly.
    void onDeviceLost();
  });
  return { name, note };
}

async function onDeviceLost(): Promise<void> {
  closeDevice();
  if (!wanted) return;
  scheduleReconnect();
}

/** One reconnect attempt: re-rank (never reuse a stale path — the OS may
 * re-enumerate the device elsewhere after unplug/replug) and resume
 * streaming; on failure schedule the next attempt. Terminal only via
 * disconnectSpaceMouse(). */
function scheduleReconnect(): void {
  if (!wanted || reconnectTimer !== undefined) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    const onMotion = handler;
    if (!wanted || !onMotion) return;
    connectSpaceMouse(onMotion).catch(() => {
      // Still wanted but the device isn't back (or won't open) — stay
      // quiet and retry; a failure here is the normal no-device state.
      scheduleReconnect();
    });
  }, RECONNECT_MS);
}

/** Stop streaming and release the device. Safe to call when disconnected. */
export function disconnectSpaceMouse(): void {
  wanted = false;
  handler = null;
  stopTimer();
  closeDevice();
}

/** Snapshot for status reporting — never throws, never touches hardware. */
export function spaceMouseStatus(): SpaceMouseStatus {
  if (!device) return { connected: false };
  return { connected: true, name: activeName, note: activeNote };
}
