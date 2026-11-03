// Shared raw-`pdftocairo -svg`-output post-processing, used by both
// build-toolbar-icons.mjs (icons/svg-ui/*.svg -> ../src/toolbarIcons.ts) and
// build-op-icons.mjs (icons/svg-ops/*.svg -> ../src/webview/opIcons.ts) so
// the two generators can't drift on what "theme-adaptive" means:
//   - strips the XML prolog and the fixed width/height (viewBox stays, so
//     CSS controls the rendered size)
//   - literal black (`rgb(0%, 0%, 0%)`) stroke/fill -> `currentColor`, so the
//     icon's color follows the surrounding element's `color` (and therefore
//     VS Code's theme) instead of being stuck black
//   - literal gray shading fills (from a TikZ `gray!N` fill) -> `currentColor`
//     at a proportional `fill-opacity` (N% gray = (100-N)/100 opacity), so
//     shaded regions scale with the theme's foreground color instead of
//     staying a fixed gray, and relative shading between an icon's own faces
//     is preserved rather than flattened
//   - the ONE reserved accent colour, TikZ `blue` (`rgb(0%, 0%, 100%)`), as a
//     FILL -> `var(--ui-icon-accent, currentColor)`: the part of a two-tone
//     icon the command acts on. `blue!N` (a tint, mixed with white) keeps its
//     tint as a proportional `fill-opacity`, like `gray!N`. The custom property
//     is set from the VS Code button colour in media/viewer.css and is
//     `currentColor` in high-contrast themes, so those stay monochrome. Strokes
//     NEVER take the accent: draw the accent as a fill and outline it black.
export const ACCENT_FILL = "var(--ui-icon-accent, currentColor)";

export function postProcess(svg) {
  let out = svg
    .replace(/^<\?xml[^>]*\?>\s*/, "")
    .replace(/(<svg\b[^>]*?)\swidth="[^"]*"/, "$1")
    .replace(/(<svg\b[^>]*?)\sheight="[^"]*"/, "$1")
    .trim();

  // Pure black → currentColor (covers both `stroke="..."` and `fill="..."`).
  out = out.replace(/(stroke|fill)="rgb\(0%, 0%, 0%\)"/g, '$1="currentColor"');

  // Any other gray shade rgb(X%, X%, X%) → currentColor at proportional opacity.
  // pdftocairo always emits `fill="rgb(...)" fill-opacity="1"` as a pair, so
  // the match consumes both — otherwise the original `fill-opacity="1"` is
  // left trailing right after our replacement and silently wins over it.
  out = out.replace(/fill="rgb\((\d+(?:\.\d+)?)%, \1%, \1%\)" fill-opacity="1"/g, (_m, pct) => {
    const p = Number(pct);
    if (p === 0 || p === 100) return `fill="rgb(${pct}%, ${pct}%, ${pct}%)" fill-opacity="1"`; // pure black/white, untouched
    const opacity = ((100 - p) / 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
    return `fill="currentColor" fill-opacity="${opacity}"`;
  });

  // Accent: `blue` (R=G=p%, B=100%) -> the accent variable. p=0 is pure blue
  // (opacity 1); p=100 would be white, which is never an accent.
  out = out.replace(/fill="rgb\((\d+(?:\.\d+)?)%, \1%, 100%\)" fill-opacity="1"/g, (m, pct) => {
    const p = Number(pct);
    if (p === 100) return m;
    const opacity = ((100 - p) / 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
    return `fill="${ACCENT_FILL}" fill-opacity="${opacity}"`;
  });

  return out;
}
