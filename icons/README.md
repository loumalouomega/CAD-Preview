# Edits panel op icons — TikZ sources

One standalone TikZ file per Edits-panel operation button (`tikz/<PanelOpId>.tex`),
matching the `PanelOpId` keys in
[`src/webview/opCatalog.ts`](../src/webview/opCatalog.ts) and the placeholders in
[`src/webview/opIcons.ts`](../src/webview/opIcons.ts) 1:1 — 46 files, one per icon.
Each is a small, self-contained line-art drawing (`\documentclass[tikz,border=2mm]
{standalone}`) meant to compile to its own PNG. Rendered previews are committed
at `png/<id>.png` (600 DPI) — regenerate them after editing a `.tex` source.

## Building the PNGs

Requires a TeX distribution (TeX Live, MacTeX, MiKTeX — anything providing
`pdflatex` with the `standalone` and `tikz` packages) plus `pdftoppm`
(from `poppler-utils`; `apt install poppler-utils` / `brew install poppler`).

```bash
cd icons
make            # builds png/<id>.png for every tikz/<id>.tex, at 600 DPI
make clean       # removes build/ and png/
```

No `pdftoppm`? Swap the recipe's second line in `Makefile` for ImageMagick instead:

```
convert -density 600 $(BUILDDIR)/$*.pdf $(PNGDIR)/$*.png
```

To rebuild a single icon: `make png/addBox.png` (or just run `pdflatex` /
`pdftoppm` directly on that one file).

## Editing a design

Each file is independent — open it, tweak the `tikzpicture`, recompile. Keep the
existing `line width=1.3pt, line cap=round, line join=round, >=Stealth, x=1mm,y=1mm`
options on the `tikzpicture` so the new icon stays visually consistent (stroke
weight, unit scale) with the rest of the set. Canvas coordinates run roughly
-13..13 in both axes for a ~26mm working area; `standalone`'s `border=2mm` adds a
small uniform margin automatically, so there's no need to hand-tune a bounding box.

## Wiring PNGs into the extension (not done yet)

`src/webview/opIcons.ts` currently renders `OP_ICONS[id]` as the **text content**
of a `<span class="op-icon">` (unicode glyph placeholders). Swapping in these
PNGs requires a follow-up code change — e.g. bundling `icons/png/*.png` into
`media/`, changing `opIcons.ts`'s value type to an image path, and having
`editsPanel.ts` set the icon `<span>`'s `background-image` (or replace it with
an `<img>`) instead of `textContent`. That's a deliberate follow-up, not bundled
with this asset generation, since it touches how the panel renders and what
ships in the packaged `.vsix`.
