/**
 * Hand-authored line icons for the sidebar, status bar and dock chrome.
 *
 * NOT generated. The toolbar/op icon sets come from the TikZ pipeline
 * (icons/tikz-ui → toolbarIcons.ts); these are simple 24-unit stroke glyphs in
 * the lucide style the chrome redesign calls for, written by hand because that
 * pipeline needs pdflatex. Kept in a separate module so the generated file stays
 * generated and its own test keeps asserting exactly its own id list.
 *
 * Same contract as `toolbarIcons.ts`: `currentColor` only, a `viewBox`, and no
 * width/height on the root, so CSS sizes the glyph and the button's `color`
 * tints it in every VS Code theme. `vscode`-free and DOM-free, so both the static
 * markup (`viewerDom.ts`) and the webview panels import it directly.
 */

const OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const g = (body: string): string => `${OPEN}${body}</svg>`;

export const UI_GLYPHS = {
  chevronDown: g('<path d="m6 9 6 6 6-6"/>'),
  chevronRight: g('<path d="m9 6 6 6-6 6"/>'),
  search: g('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>'),
  eye: g('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: g(
    '<path d="M9.9 5.2A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.9"/><path d="M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/>'
  ),
  copy: g('<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a2 2 0 0 1 2-2h11"/>'),
  trash: g(
    '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'
  ),
  layers: g('<path d="m12 2 10 5-10 5L2 7Z"/><path d="m2 12 10 5 10-5"/><path d="m2 17 10 5 10-5"/>'),
  rotateCcw: g('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  move: g(
    '<path d="M12 2v20"/><path d="M2 12h20"/><path d="m9 5 3-3 3 3"/><path d="m9 19 3 3 3-3"/><path d="m5 9-3 3 3 3"/><path d="m19 9 3 3-3 3"/>'
  ),
  zoomIn: g('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/><path d="M11 8v6"/><path d="M8 11h6"/>'),
  zoomOut: g('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/><path d="M8 11h6"/>'),
  cube: g('<path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>'),
  box: g('<path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="M12 13v8"/><path d="m3 8 9 5 9-5"/>'),
  plus: g('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  play: g('<path d="M7 4v16l13-8Z" fill="currentColor"/>'),
  download: g('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
  target: g('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>'),
  maximize: g('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
  home: g('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9v11a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9"/>'),
  gitFork: g(
    '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 7v10"/><path d="M6 12h6a4 4 0 0 0 4-4V7"/>'
  ),
  grid3: g('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>'),
  pointer: g('<path d="M4 3l7 17 2.5-7.5L21 10Z"/>'),
  ruler: g(
    '<path d="M21.3 15.3 8.7 2.7a1 1 0 0 0-1.4 0L2.7 7.3a1 1 0 0 0 0 1.4l12.6 12.6a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4Z"/><path d="m7.5 10.5 2-2"/><path d="m10.5 13.5 2-2"/><path d="m13.5 16.5 2-2"/>'
  ),
  pencil: g('<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>'),
  undo: g('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  redo: g('<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>'),
} as const;

export type UiGlyphId = keyof typeof UI_GLYPHS;

/** `<span class="ui-glyph">` wrapping one glyph — the markup every caller uses. */
export function glyph(id: UiGlyphId): string {
  return `<span class="ui-glyph">${UI_GLYPHS[id]}</span>`;
}
