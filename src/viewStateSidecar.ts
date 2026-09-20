import type { PaneViewState, ViewBookmark, ViewState } from "./protocol";
// TYPE-ONLY, and that is load-bearing: `webview/clipping.ts` has a top-level
// `import * as THREE from "three"`, so turning this into a value import (e.g.
// to share `CLIP_AXES`) would pull three.js into the extension-host bundle.
import type { ClipAxis } from "./webview/clipping";
import { DISPLAY_MODES } from "./webview/displayMode";
import { PANE_LAYOUTS, paneCount, type PaneLayoutId } from "./webview/viewerPanes";
// Value import, and safe: `collapsiblePanels.ts` is pure data + pure functions
// with no DOM access at module scope and no three.js import, the same reason
// `displayMode`/`viewerPanes` above can be imported by value from the host.
import { sanitizeCollapsedPanels } from "./webview/collapsiblePanels";
import { clampSidebarWidth, SIDEBAR_DEFAULT_PX } from "./webview/sidebarResizer";

/** Pure (vscode-free) parse/serialize for the view-state sidecar — unit-testable. */

export const VIEW_STATE_SIDECAR_VERSION = 1;

interface SidecarFile {
  version: number;
  source: string;
  view: ViewState;
  layout?: unknown;
  panes?: unknown;
  collapsedPanels?: unknown;
  sidebarWidth?: unknown;
  bookmarks?: unknown;
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
    clip = parseClipState(r.clip);
  }

  const base: ViewState = { viewDirection, cameraUp, orthographic, displayMode, clip };

  // Collapsed sidebar sections — additive and tolerant, like `layout`/`panes`.
  // This MUST be folded in before the `layout === "1x1"` early return below,
  // or a single-pane sidecar (the overwhelmingly common case) would silently
  // drop it. `sanitizeCollapsedPanels` filters a hand-edited or
  // written-by-a-newer-build list down to ids this build actually knows.
  const collapsedPanels = sanitizeCollapsedPanels(file?.collapsedPanels);
  if (collapsedPanels.length > 0) base.collapsedPanels = collapsedPanels;

  // Sidebar width — same additive sibling, same fold-before-the-1x1-early-
  // return requirement. `clampSidebarWidth` returns null for a non-number, so
  // a hand-edited `"220px"` or `"wide"` restores the default instead of
  // poisoning the layout.
  const sidebarWidth = clampSidebarWidth(file?.sidebarWidth);
  if (sidebarWidth !== null) base.sidebarWidth = sidebarWidth;

  // Named view bookmarks — same additive top-level sibling, same
  // fold-before-the-1x1-early-return requirement as `collapsedPanels` above.
  const bookmarks = sanitizeBookmarks(file?.bookmarks);
  if (bookmarks.length > 0) base.bookmarks = bookmarks;

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

/**
 * Parses one clip state (the `view.clip` field or a bookmark's `clip`).
 * Factored out of the inline `view.clip` parse so bookmarks share the exact
 * same tolerant rule — the two can never drift into accepting different
 * shapes. Behavior byte-for-byte identical to the inline version it replaces:
 * a bad `axis` drops the whole clip; a bad `normal` degrades only itself
 * (normalized on read); `offsetFrac` clamped to [-1, 1].
 */
function parseClipState(raw: unknown): ViewState["clip"] {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<NonNullable<ViewState["clip"]>>;
  if (
    typeof c.axis !== "string" ||
    !(CLIP_AXES as readonly string[]).includes(c.axis) ||
    typeof c.offsetFrac !== "number" ||
    !Number.isFinite(c.offsetFrac)
  ) {
    return null;
  }
  const clip: NonNullable<ViewState["clip"]> = {
    axis: c.axis as ClipAxis,
    offsetFrac: Math.max(-1, Math.min(1, c.offsetFrac)),
  };
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
  return clip;
}

/** Maximum bookmark name length — the macro library's `MAX_NAME_LENGTH` precedent. */
const MAX_BOOKMARK_NAME_LENGTH = 120;
/** Guard against a pathological file; bookmarks are small by nature. */
const MAX_BOOKMARKS = 100;

/**
 * Tolerant parse for the top-level `bookmarks` array — same per-entry-drop
 * discipline as `parsePlanesJson`: a malformed entry is dropped individually
 * rather than rejecting the whole sidecar. Folded into `base` BEFORE the
 * `layout === "1x1"` early return, or single-pane sidecars (the overwhelmingly
 * common case) would silently drop it — the same trap `collapsedPanels`' own
 * comment documents. Duplicate names keep the first entry.
 */
export function sanitizeBookmarks(raw: unknown): ViewBookmark[] {
  if (!Array.isArray(raw)) return [];
  const out: ViewBookmark[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= MAX_BOOKMARKS) break;
    if (!entry || typeof entry !== "object") continue;
    const b = entry as Partial<ViewBookmark>;
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (name === "" || name.length > MAX_BOOKMARK_NAME_LENGTH || seen.has(name)) continue;
    const viewDirection = asVec3(b.viewDirection);
    const cameraUp = asVec3(b.cameraUp);
    // A bookmark that can't orient a camera is useless — drop the entry, not
    // the file (unlike `view` itself, which rejects the whole record, since
    // there is no camera at all without it).
    if (!viewDirection || !cameraUp) continue;
    if (viewDirection.every((c) => c === 0) || cameraUp.every((c) => c === 0)) continue;
    const displayMode =
      typeof b.displayMode === "string" && (DISPLAY_MODES as readonly string[]).includes(b.displayMode)
        ? (b.displayMode as ViewBookmark["displayMode"])
        : "shaded";
    seen.add(name);
    out.push({
      name,
      viewDirection,
      cameraUp,
      orthographic: b.orthographic === true,
      displayMode,
      clip: parseClipState(b.clip),
    });
  }
  return out;
}

/** Serializes view state to the sidecar JSON text (pretty-printed, trailing newline). */
export function serializeViewStateJson(sourceName: string, view: ViewState): string {
  const { layout, panes, collapsedPanels, sidebarWidth, bookmarks, ...viewCore } = view;
  const file: SidecarFile & { view: Omit<ViewState, "layout" | "panes" | "collapsedPanels" | "sidebarWidth" | "bookmarks"> } = {
    version: VIEW_STATE_SIDECAR_VERSION,
    source: sourceName,
    view: viewCore,
  };
  if (layout && layout !== "1x1") {
    (file as SidecarFile).layout = layout;
    if (panes && panes.length > 0) (file as SidecarFile).panes = panes;
  }
  // A top-level sibling of `view`, not a field inside it — the destructure
  // above is what keeps the two halves agreeing about where it lives.
  if (collapsedPanels && collapsedPanels.length > 0) {
    (file as SidecarFile).collapsedPanels = collapsedPanels;
  }
  // Omitted at the 220 default (and only there): a user who dragged back to
  // exactly the pre-resizer width, or never resized, writes a sidecar
  // byte-identical to the untouched one.
  if (sidebarWidth !== undefined && sidebarWidth !== SIDEBAR_DEFAULT_PX) {
    (file as SidecarFile).sidebarWidth = sidebarWidth;
  }
  // Omitted when empty: a document with no bookmarks writes a sidecar
  // byte-identical to the pre-bookmarks shape.
  if (bookmarks && bookmarks.length > 0) {
    (file as SidecarFile).bookmarks = bookmarks;
  }
  return JSON.stringify(file, null, 2) + "\n";
}
