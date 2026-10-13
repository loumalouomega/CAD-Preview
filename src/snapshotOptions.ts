/**
 * Display-mode and section-plane options for the headless snapshot tools
 * (`render_snapshot`, `screenshot_shape`) — roadmap "Section plane and display
 * presets for render_snapshot".
 *
 * Pure and three.js-free on purpose: `mcpTools.ts` must not value-import
 * `webview/clipping.ts` (its top-level `import * as THREE` would land three.js
 * in the MCP bundle), so the one piece of maths it needs — normalising a
 * normal and picking the dominant axis the way `clipping.ts`'s `dominantAxis`
 * does — is reproduced here and pinned against it by `snapshotOptions.test.ts`.
 */
import { isDisplayMode, type DisplayMode } from "./webview/displayMode";
import type { ClipPlaneState, ClipAxis } from "./webview/clipping";

/** The caller-facing clip shape: an axis preset XOR an explicit normal. */
export interface SnapshotClipInput {
  axis?: ClipAxis;
  normal?: [number, number, number];
  /** Cut position as a fraction of the model's extent along the plane normal,
   *  `-1` (min side) … `1` (max side). Same meaning as `ViewState.clip`. */
  offsetFrac: number;
}

export interface ResolvedSnapshotDisplay {
  /** Left `undefined` when the caller did not ask, so the pipeline's opts stay
   *  byte-identical for every existing call. */
  displayMode?: DisplayMode;
  /** The legacy flag, kept so `displayMode: "wireframe"` reaches the harness
   *  exactly as it always did. */
  wireframe?: true;
  clip?: ClipPlaneState;
}

function dominantAxisOf(n: [number, number, number]): ClipAxis {
  const [x, y, z] = n.map(Math.abs);
  if (x >= y && x >= z) return "x";
  return y >= z ? "y" : "z";
}

/**
 * Validates and normalises the snapshot tools' `displayMode` and `clip`.
 *
 * A bad `clip` THROWS: it is unambiguous caller-input-shape misuse (both or
 * neither of axis/normal, a zero or non-finite vector, an offset outside
 * [-1, 1]), and quietly rendering an unclipped model would look exactly like
 * a section that cut nothing. An unrecognised `displayMode` warns and is
 * ignored instead — the zod enum already rejects it over the wire, so this
 * only guards direct callers, and "shaded" is a safe, visible fallback.
 */
export function resolveSnapshotDisplay(
  displayMode: string | undefined,
  clip: SnapshotClipInput | undefined,
  warnings: string[]
): ResolvedSnapshotDisplay {
  const out: ResolvedSnapshotDisplay = {};

  if (displayMode !== undefined) {
    if (isDisplayMode(displayMode)) {
      out.displayMode = displayMode;
      if (displayMode === "wireframe") out.wireframe = true;
    } else {
      warnings.push(`displayMode ${JSON.stringify(displayMode)} is not one of shaded/wireframe/xray/hiddenLines/flat — rendering shaded instead.`);
    }
  }

  if (clip !== undefined) {
    const { axis, normal, offsetFrac } = clip;
    if (axis !== undefined && normal !== undefined) {
      throw new Error("clip: give either `axis` or `normal`, not both.");
    }
    if (axis === undefined && normal === undefined) {
      throw new Error("clip: give `axis` (x|y|z) or an explicit `normal`.");
    }
    if (!Number.isFinite(offsetFrac) || offsetFrac < -1 || offsetFrac > 1) {
      throw new Error(`clip: offsetFrac must be a finite number in [-1, 1] (got ${String(offsetFrac)}).`);
    }
    if (axis !== undefined) {
      if (axis !== "x" && axis !== "y" && axis !== "z") throw new Error(`clip: axis must be x, y or z (got ${JSON.stringify(axis)}).`);
      out.clip = { axis, offsetFrac };
    } else {
      const n = normal as [number, number, number];
      if (!Array.isArray(n) || n.length !== 3 || !n.every(Number.isFinite)) {
        throw new Error("clip: normal must be three finite numbers.");
      }
      const len = Math.hypot(n[0], n[1], n[2]);
      if (len < 1e-9) throw new Error("clip: normal must be non-zero.");
      const unit: [number, number, number] = [n[0] / len, n[1] / len, n[2] / len];
      // `axis` is always written beside `normal` — see ClipPlaneState's note.
      out.clip = { axis: dominantAxisOf(unit), offsetFrac, normal: unit };
    }
  }

  return out;
}
