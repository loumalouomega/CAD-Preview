import type { PaneViewState, ViewState } from "./protocol";
// TYPE-ONLY, and that is load-bearing: `webview/clipping.ts` has a top-level
// `import * as THREE from "three"`, so turning this into a value import (e.g.
// to share `CLIP_AXES`) would pull three.js into the extension-host bundle.
import type { ClipAxis } from "./webview/clipping";
import { DISPLAY_MODES } from "./webview/displayMode";
import { PANE_LAYOUTS, paneCount, type PaneLayoutId } from "./webview/viewerPanes";

/** Pure (vscode-free) parse/serialize for the view-state sidecar — unit-testable. */

export const VIEW_STATE_SIDECAR_VERSION = 1;

interface SidecarFile {
  version: number;
  source: string;
  view: ViewState;
  layout?: unknown;
  panes?: unknown;
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
 *
 * Phase 2 (roadmap "Split view", Phase 2): optional `layout` + `panes` are
 * additive siblings of `view` at the file's top level. An older sidecar
 * without them restores as single-pane; an unknown `layout` value falls back
 * to `"1x1"` and `panes` is ignored. Each pane entry is validated like `view`'s
 * camera fields; an invalid entry falls back to `view`'s own direction/up/ortho
 * for that pane. A short/long `panes` array is padded/truncated to
 * `paneCount(layout)`.
 */
export function parseViewStateJson(text: string): ViewState | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const file = data as Partial<SidecarFile> | null;
  const raw = file?.view;
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
      // A bad `normal` degrades only ITSELF, leaving the axis-form clip intact —
      // deliberately unlike a bad `axis`, which still drops the whole `clip`
      // (the pre-existing behaviour, locked by this module's own tests and left
      // exactly as it was). Normalized on read so every consumer downstream can
      // assume a unit vector.
      const n = asVec3(c.normal);
      if (n) {
        const len = Math.hypot(n[0], n[1], n[2]);
        if (len > 1e-9) clip.normal = [n[0] / len, n[1] / len, n[2] / len];
      }
    }
  }

  const base: ViewState = { viewDirection, cameraUp, orthographic, displayMode, clip };

  // Optional split-view layout — purely additive, tolerant.
  const rawLayout = file?.layout;
  const layoutValid = typeof rawLayout === "string" && (PANE_LAYOUTS as readonly string[]).includes(rawLayout);
  const layout = layoutValid ? (rawLayout as PaneLayoutId) : undefined;
  if (!layout || layout === "1x1") return base;
  const count = paneCount(layout);
  const rawPanes = file?.panes;
  const panes: PaneViewState[] = [];
  for (let i = 0; i < count; i++) {
    const entry = Array.isArray(rawPanes) ? (rawPanes[i] as Partial<PaneViewState> | undefined) : undefined;
    let vd = entry ? asVec3(entry.viewDirection) : null;
    let up = entry ? asVec3(entry.cameraUp) : null;
    const ortho = entry?.orthographic === true;
    const vdDegenerate = !vd || vd.every((c) => c === 0);
    const upDegenerate = !up || up.every((c) => c === 0);
    if (vdDegenerate) vd = viewDirection;
    if (upDegenerate) up = cameraUp;
    // If the entry's orthographic wasn't a boolean, fall back to entry-validated vd/up but base's ortho? No — fall back to base orthographic per tolerant entry.
    // We already set ortho above as (=== true); an invalid (non-boolean) orthographic falls back to base.orthographic.
    const entryOrtho = typeof entry?.orthographic === "boolean" ? ortho : orthographic;
    panes.push({ viewDirection: vd!, cameraUp: up!, orthographic: entryOrtho });
  }
  return { ...base, layout, panes };
}

/** Serializes view state to the sidecar JSON text (pretty-printed, trailing newline). */
export function serializeViewStateJson(sourceName: string, view: ViewState): string {
  const { layout, panes, ...viewCore } = view;
  const file: SidecarFile & { view: Omit<ViewState, "layout" | "panes"> } = {
    version: VIEW_STATE_SIDECAR_VERSION,
    source: sourceName,
    view: viewCore,
  };
  if (layout && layout !== "1x1") {
    (file as SidecarFile).layout = layout;
    if (panes && panes.length > 0) (file as SidecarFile).panes = panes;
  }
  return JSON.stringify(file, null, 2) + "\n";
}
