# Icon sources

This directory holds two independent TikZ-drawn icon sets for CAD-Preview.
Both follow the same visual language (`line width=1.3pt, line cap=round,
line join=round, >=Stealth, x=1mm,y=1mm` on the `tikzpicture`, canvas
coordinates roughly -13..13), but they're built and wired very differently —
see whichever section applies before editing.

| | `tikz/` (Edits panel) | `tikz-ui/` (toolbar/panels) |
|---|---|---|
| Count | 46, one per `PanelOpId` | 17, one per toolbar/panel icon |
| Output format | PNG (flat, fixed gray/black) | inline SVG (`currentColor`-based) |
| Wired into the running extension? | **No** — still unicode-glyph placeholders in `opIcons.ts` | **Yes** — replaces the emoji that used to be there |
| Theme-adaptive? | No (fixed colors) | Yes (tracks VS Code light/dark via `currentColor`) |

## `tikz/` — Edits panel op icons (46, PNG, not yet wired)

One standalone TikZ file per Edits-panel operation button (`tikz/<PanelOpId>.tex`),
matching the `PanelOpId` keys in
[`src/webview/opCatalog.ts`](../src/webview/opCatalog.ts) and the placeholders in
[`src/webview/opIcons.ts`](../src/webview/opIcons.ts) 1:1. Each compiles to its
own PNG; previews are committed at `png/<id>.png` (600 DPI).

```bash
cd icons
make            # builds png/<id>.png for every tikz/<id>.tex, at 600 DPI
make clean      # removes build/ and png/
```

No `pdftoppm`? Swap the recipe's second line in `Makefile` for ImageMagick instead:
`convert -density 600 $(BUILDDIR)/$*.pdf $(PNGDIR)/$*.png`.

To rebuild a single icon: `make png/addBox.png` (or run `pdflatex`/`pdftoppm`
directly on that one file).

**Wiring PNGs into the extension is a deliberate, not-yet-done follow-up** —
`opIcons.ts` currently renders `OP_ICONS[id]` as the text content of a
`<span class="op-icon">` (unicode glyph placeholders). Doing so would need
bundling `icons/png/*.png` into `media/`, changing `opIcons.ts`'s value type
to an image path, and `editsPanel.ts` setting the icon `<span>`'s
`background-image` (or an `<img>`) instead of `textContent`.

## `tikz-ui/` — toolbar/panel icons (17, SVG, wired in)

One TikZ file per toolbar/panel icon (`tikz-ui/<id>.tex`), matching the
`ToolbarIconId` keys in the **generated, committed** module
[`../src/toolbarIcons.ts`](../src/toolbarIcons.ts) — which is what
`provider.ts`, `partsPanel.ts`, and `meshingPanel.ts` actually import and
render. These replaced the toolbar's plain-color emoji (📤🔍🕸️🌳🔬🖱️📍🧊◼️📏▶,
plus ⚠/✕) — see `docs/superpowers/specs/2026-07-06-toolbar-icons-design.md`
for the full design rationale. The `home` / `open` / `save` / `saveAs` icons
back the top **File** menu (Open / Save / Save As); `export` is reused there too.

Pipeline: `pdflatex` → `pdftocairo -svg` (both already needed for the `tikz/`
set above; no extra dependency) → `build-toolbar-icons.mjs` post-processes
the raw SVG and emits `src/toolbarIcons.ts`:
- strips the XML prolog and fixed `width`/`height` (keeps `viewBox`, so CSS
  controls the rendered size — see `.toolbar-icon` in `media/viewer.css`)
- literal black (`rgb(0%, 0%, 0%)`) stroke/fill → `currentColor`, so the icon
  tracks whatever `color` the surrounding element has (which is already
  theme-aware) instead of being stuck black
- literal gray shading fills (from a TikZ `gray!N` fill) → `currentColor` at
  a proportional `fill-opacity` — `N`% gray becomes `(100-N)/100` opacity, so
  relative shading between an icon's own faces (e.g. `volume`'s front/top/side)
  is preserved rather than flattened to one constant

```bash
cd icons
make ui         # tikz-ui/*.tex → svg-ui/*.svg (needs pdflatex + pdftocairo)
make ts         # (re-)runs `make ui`, then regenerates ../src/toolbarIcons.ts
node build-toolbar-icons.mjs   # re-run codegen alone, no LaTeX needed,
                                # as long as svg-ui/*.svg is already current
```

`svg-ui/*.svg` previews are committed for exactly that last case — anyone can
regenerate `toolbarIcons.ts` from them with plain Node, no TeX install needed,
unless they're also changing a `.tex` source's actual drawing.

**Never hand-edit `src/toolbarIcons.ts`** — it's regenerated wholesale by
`make ts` and any manual edit will be silently lost next time someone runs it.
To change an icon: edit its `tikz-ui/<id>.tex`, run `make ts`, done.

To add a new toolbar icon: create `tikz-ui/<newId>.tex`, run `make ts` (the
script picks up every `.svg` in `svg-ui/` automatically — no id list to
update by hand), then import `TOOLBAR_ICONS.newId` where you need it.
`src/toolbarIcons.test.ts` enforces the generated file's invariants (valid
non-empty SVG, no stray hardcoded `width`/`height`, no literal black, no
duplicate `fill-opacity`) — run `npm test` after regenerating.
