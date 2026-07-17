# Icon sources

This directory holds three independent TikZ-drawn icon sets for CAD-Preview.
The two panel/toolbar sets follow the same visual language (`line width=1.3pt,
line cap=round, line join=round, >=Stealth, x=1mm,y=1mm` on the `tikzpicture`,
canvas coordinates roughly -13..13); the extension icon is a separate,
full-color design. They're built and wired very differently — see whichever
section applies before editing.

| | `tikz/` (Edits panel) | `tikz-ui/` (toolbar/panels) | `tikz-icon/` (extension icon) |
|---|---|---|---|
| Count | 46, one per `PanelOpId` | 17, one per toolbar/panel icon | 1 |
| Output format | PNG (flat, fixed gray/black) | inline SVG (`currentColor`-based) | PNG (fixed teal/white, 512x512) |
| Wired into the running extension? | **No** — still unicode-glyph placeholders in `opIcons.ts` | **Yes** — replaces the emoji that used to be there | **Yes** — `package.json`'s `"icon"` field |
| Theme-adaptive? | No (fixed colors) | Yes (tracks VS Code light/dark via `currentColor`) | No (fixed teal-on-white/transparent) |

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

## `tikz-icon/` — extension icon (`images/icon.png` / `icon_transparency.png`)

The marketplace logo is a separate, full-color TikZ source — `tikz-icon/icon.tex`
— rendered straight to PNG rather than through the `currentColor` SVG pipeline
above (it's a fixed teal-on-white/transparent bitmap, not a theme-adaptive
toolbar glyph). It shares its cube geometry and build pipeline with the
sibling project [MDPA-Preview](../../VSCode-MDPA-Preview/icons/tikz-icon/icon.tex):
the same isometric L-tromino of three unit cubes in cabinet projection — two
plain hexahedra on top and one tetrahedralized cube (bottom-right, split into
6 tets by fanning its three visible-face diagonals from one shared vertex) —
a nod to hex-dominant meshing with local tet refinement.

The two logos diverge only in the badge over the tet-meshed cube: MDPA-Preview
draws a magnifier (a *preview* of mesh detail); CAD-Preview draws a
**drafting compass** instead — the classic tool for striking circles/arcs on a
drawing board, a more fitting nod for an extension that reads/edits B-rep CAD
geometry than a magnifying glass would be. The needle leg plants on a point,
the pencil leg trails a shallow crescent arc, both over the same opaque white
contrast disc trick MDPA's lens uses (legible against both the teal mesh and
the white/transparent page).

```bash
cd icons
make icon       # tikz-icon/icon.tex → PDF → 512x512 PNGs, needs pdflatex + pdftocairo
```

`make icon` writes both `../images/icon.png` (white background) and
`../images/icon_transparency.png` (transparent) — the only difference is
`pdftocairo`'s `-transparent` flag. Note `-transparent` is a *coverage* mask,
not true per-pixel alpha: any fill-opacity blending (e.g. the compass badge's
translucent disc) is flattened against white first, and only pixels no shape
ever touched stay transparent — so the badge still shows as a faint flattened
patch if `icon_transparency.png` is composited onto a non-white background.
This matches MDPA-Preview's own shipped `icon_transparency.png`, not a bug
specific to this file.

To change the logo: edit `tikz-icon/icon.tex`, run `make icon`, and commit the
two regenerated PNGs (there's no checked-in SVG intermediate for this one,
unlike the toolbar icons — the PDF build artifacts live in the gitignored
`build-icon/`). `package.json`'s `"icon"` field points at `images/icon.png`;
`icon_transparency.png` isn't referenced by the manifest but is kept for
parity with MDPA-Preview and any future use that needs a transparent asset.
