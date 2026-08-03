import type { ViewState } from "./protocol";
import type { ClipAxis } from "./webview/clipping";
import { DISPLAY_MODES } from "./webview/displayMode";

/** Pure (vscode-free) parse/serialize for the view-state sidecar — unit-testable. */

export const VIEW_STATE_SIDECAR_VERSION = 1;

interface SidecarFile {
  version: number;
  source: string;
  view: ViewState;
}

const CLIP_AXES: readonly ClipAxis[] = ["x", "y", "z"];

function asVec3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, z] = value;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

/**
 * Parses + validates sidecar JSON into a clean `ViewState`, or `null` when the
 * sidecar is missing/malformed/absent (meaning: no persisted view — the
 * caller should apply its own default, e.g. the hardcoded isometric).
 * Tolerant like every other sidecar parser in this codebase: an individually
 * invalid field falls back to a safe default rather than rejecting the whole
 * record, EXCEPT `viewDirection`/`cameraUp` — a missing or degenerate
 * (zero-length) vector can't orient a camera at all, so those two reject the
 * whole record rather than risk feeding NaN/zero into `frame()`/`setCameraUp()`.
 */
export function parseViewStateJson(text: string): ViewState | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const raw = (data as Partial<SidecarFile> | null)?.view;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ViewState>;

  const viewDirection = asVec3(r.viewDirection);
  const cameraUp = asVec3(r.cameraUp);
  if (!viewDirection || !cameraUp) return null;
  if (viewDirection.every((c) => c === 0) || cameraUp.every((c) => c === 0)) return null;

  const displayMode = typeof r.displayMode === "string" && (DISPLAY_MODES as readonly string[]).includes(r.displayMode)
    ? (r.displayMode as ViewState["displayMode"])
    : "shaded";
  const orthographic = r.orthographic === true;

  let clip: ViewState["clip"] = null;
  if (r.clip && typeof r.clip === "object") {
    const c = r.clip as Partial<NonNullable<ViewState["clip"]>>;
    if (
      typeof c.axis === "string" &&
      (CLIP_AXES as readonly string[]).includes(c.axis) &&
      typeof c.offsetFrac === "number" &&
      Number.isFinite(c.offsetFrac)
    ) {
      clip = { axis: c.axis as ClipAxis, offsetFrac: Math.max(-1, Math.min(1, c.offsetFrac)) };
    }
  }

  return { viewDirection, cameraUp, orthographic, displayMode, clip };
}

/** Serializes view state to the sidecar JSON text (pretty-printed, trailing newline). */
export function serializeViewStateJson(sourceName: string, view: ViewState): string {
  const file: SidecarFile = { version: VIEW_STATE_SIDECAR_VERSION, source: sourceName, view };
  return JSON.stringify(file, null, 2) + "\n";
}
