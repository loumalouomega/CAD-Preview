/**
 * Keyboard view snaps: `1`–`6` for the six faces, `i` for isometric.
 *
 * Pure — maps a key press to a canonical name from `viewDirections.ts`, so the
 * webview needs no camera code of its own and the vocabulary cannot drift from
 * the snapshot/silhouette views.
 */

import { resolveNamedView, type ResolvedView } from "./viewDirections";

const KEY_TO_VIEW: Readonly<Record<string, string>> = Object.freeze({
  "1": "front",
  "2": "back",
  "3": "right",
  "4": "left",
  "5": "top",
  "6": "bottom",
  i: "iso-ftr",
});

export interface ViewKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** The view a key press snaps to, or `null` (no match, or a modified chord such as Ctrl+1). */
export function viewForKey(e: ViewKeyEvent): ResolvedView | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const name = KEY_TO_VIEW[e.key.toLowerCase()];
  return name ? resolveNamedView(name) : null;
}

/** Whether a key press aimed at `target` is typing into a text control and must not snap the view. */
export function isTextEntryTarget(target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
