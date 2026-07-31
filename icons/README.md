# Icon sources

This directory holds three independent TikZ-drawn icon sets for CAD-Preview. The two panel/toolbar sets follow the same visual language (`line width=1.3pt, line cap=round, line join=round, >=Stealth, x=1mm,y=1mm` on the `tikzpicture`, canvas coordinates roughly -13..13) **and the same currentColor SVG pipeline** (`svgIconPostProcess.mjs`, shared by both generator scripts); the extension icon is a separate, full-color design built and wired very differently — see whichever section applies before editing.

|  | `tikz/` (Edits panel) | `tikz-ui/` (toolbar/panels) | `tikz-icon/` (extension icon) |
| --- | --- | --- | --- |
| Count | 46, one per `PanelOpId` | 41, one per toolbar/panel icon | 1 |
| Output format | inline SVG (`currentColor`-based) | inline SVG (`currentColor`-based) | PNG (fixed teal/white, 512x512) |
| Wired into the running extension? | **Yes** — `src/webview/opIcons.ts` | **Yes** — replaces the emoji that used to be there | **Yes** — `package.json`'s `"icon"` field |
| Theme-adaptive? | Yes (tracks VS Code light/dark via `currentColor`) | Yes (tracks VS Code light/dark via `currentColor`) | No (fixed teal-on-white/transparent) |

## `tikz/` — Edits panel op icons (46, SVG, wired in)

One standalone TikZ file per Edits-panel operation button (`tikz/<PanelOpId>.tex`), matching the `PanelOpId` keys in [`src/webview/opCatalog.ts`](../src/webview/opCatalog.ts) and the **generated, committed** module [`../src/webview/opIcons.ts`](../src/webview/opIcons.ts) 1:1 — which is what `editsPanel.ts` actually imports and renders (via `innerHTML`, not `textContent` — an op icon is inline SVG markup, not a text glyph). This set originally shipped as flat-color PNG previews with no wiring; it now goes through the exact same `svgIconPostProcess.mjs` pipeline as `tikz-ui/` below, just into its own `svg-ops/` output directory and its own generator script (`build-op-icons.mjs`) — kept separate from `build-toolbar-icons.mjs` because `opIcons.ts`'s generated type is `Record<PanelOpId, string>` (imported from `opCatalog.ts`) rather than a self-contained union, so a missing/extra id is a `tsc` error, not just a runtime completeness check.

```bash
cd icons
make ops        # tikz/*.tex → svg-ops/*.svg (needs pdflatex + pdftocairo)
make ops-ts     # (re-)runs `make ops`, then regenerates ../src/webview/opIcons.ts
node build-op-icons.mjs   # re-run codegen alone, no LaTeX needed,
                          # as long as svg-ops/*.svg is already current
```

`svg-ops/*.svg` previews are committed for exactly that last case. To change an icon: edit its `tikz/<id>.tex`, run `make ops-ts`, done — never hand-edit `src/webview/opIcons.ts` (regenerated wholesale, any manual edit is silently lost next time someone runs it). Adding a new op icon means also adding its id to `PanelOpId` in `opCatalog.ts` first — the generator's `Record` type turns a mismatch into a compile error rather than a silent gap.

**Because these icons live on a small (~30px) button with only a `--vscode-button-secondaryBackground` background behind them, not a fixed white page, a few of the original 46 sources needed real fixes, not just a pipeline swap** — the same "only fills get gray→currentColor, strokes never do" rule `tikz-ui/`'s README section below documents was violated in two ways that only mattered once real theming was wired in:

- **Bare `\draw[gray]` strokes** (14 files: de-emphasized outlines, ghost/ reference lines) stayed literally mid-gray in every theme instead of tracking `currentColor`. Fixed the same way `tikz-ui/isolate.tex` already did: drop the stroke color, keep (or add) `dashed` for de-emphasis instead.
- **`\fill[white]` "erase" hacks** (5 files — the three hole ops, the torus, and boolean subtract) used to punch a visual hole by painting literal white over a filled shape. Against this button's real (non-white, theme-dependent) background, that showed as a solid white blob instead of empty space. Fixed with a genuine even-odd compound path instead (`\fill[gray!N, even odd rule] (outer) (hole);`, tracing the hole as a single non-self-overlapping polygon when two sub-holes would otherwise overlap and double-cancel), which leaves the hole area transparent — for boolean subtract specifically (two circles that only partially overlap, not one fully containing the other), the same trick is applied to a *clip* instead of a fill: `\pgfseteorule` + `\clip (circleA) (circleB);` clips to "A xor B", and filling A inside that clip yields exactly the "A minus B" crescent with the excluded lens left genuinely transparent. (Note: `\clip[even odd rule] (...)` and `\path[clip, even odd rule] (...)` both error — `"Extra options not allowed for clipping path command"` — in this TikZ version; the low-level `\pgfseteorule` call before a plain `\clip` is what actually works.)

## `tikz-ui/` — toolbar/panel icons (41, SVG, wired in)

One TikZ file per toolbar/panel icon (`tikz-ui/<id>.tex`), matching the `ToolbarIconId` keys in the **generated, committed** module [`../src/toolbarIcons.ts`](../src/toolbarIcons.ts) — which is what `provider.ts`, `partsPanel.ts`, and `meshingPanel.ts` actually import and render. These replaced every plain-color emoji and unicode-glyph placeholder the UI used to render (📤🔍🕸️🌳🔬🖱️📍🧊◼️📏▶ ▦ 📐 📷 ✎ ⊙ ＋ ↶ ↷, plus ⚠/✕) — see `docs/superpowers/specs/2026-07-06-toolbar-icons-design.md` for the original design rationale. Roughly by area:

| Icons | Where they're used |
| --- | --- |
| `home` `open` `save` `saveAs` `export` | the top **File ▾** menu |
| `fit` `tree` `feMesh` | the always-visible toolbar buttons |
| `view` `grid` `edges` `screenshot` | the toolbar's **View ▾** menu |
| `select` `point` `volume` `surface` `line` | **Select ▾** (trigger + pick modes) |
| `measure` `distance` `edgeLength` `angle` `radius` | **Measure ▾** (trigger + tools) |
| `markup` `freehand` `arrow` `rectangle` `circle` `eraser` | **Markup ▾** (trigger + tools; the Line tool reuses `line`) |
| `shaded` `wireframe` `xray` `hiddenLines` `flat` | the view-controls **Display** group |
| `undo` `redo` `add` `isolate` `clear` `generate` `close` `warning` | Parts/Edits/FE&nbsp;Mesh panel buttons |

**Only fills get the gray→`currentColor` treatment, never strokes** (see the pipeline notes below), so shade an icon with `fill=gray!N` — a `gray!N` *stroke* would survive into the SVG as a literal gray and stay that colour in both themes. Where an icon needs a de-emphasised outline, use `dashed` (as `isolate` does) rather than a lighter stroke colour.

Two design notes learned from rendering the set at its real 1em size, worth keeping in mind for new icons: a `>=Stealth` arrow tip on an `arc` is essentially invisible at that scale (`undo`/`redo` use an explicit filled triangle instead), and cube-based glyphs need a *fill* difference, not just an edge-style difference, to stay distinguishable (`edges`/`xray`/`hiddenLines`/ `flat`/`wireframe` are five variants of the same isometric cube).

Pipeline: `pdflatex` → `pdftocairo -svg` (both already needed for the `tikz/` set above; no extra dependency) → `build-toolbar-icons.mjs` post-processes the raw SVG and emits `src/toolbarIcons.ts`:

- strips the XML prolog and fixed `width`/`height` (keeps `viewBox`, so CSS controls the rendered size — see `.toolbar-icon` in `media/viewer.css`)
- literal black (`rgb(0%, 0%, 0%)`) stroke/fill → `currentColor`, so the icon tracks whatever `color` the surrounding element has (which is already theme-aware) instead of being stuck black
- literal gray shading fills (from a TikZ `gray!N` fill) → `currentColor` at a proportional `fill-opacity` — `N`% gray becomes `(100-N)/100` opacity, so relative shading between an icon's own faces (e.g. `volume`'s front/top/side) is preserved rather than flattened to one constant

```bash
cd icons
make ui         # tikz-ui/*.tex → svg-ui/*.svg (needs pdflatex + pdftocairo)
make ts         # (re-)runs `make ui`, then regenerates ../src/toolbarIcons.ts
node build-toolbar-icons.mjs   # re-run codegen alone, no LaTeX needed,
                                # as long as svg-ui/*.svg is already current
```

`svg-ui/*.svg` previews are committed for exactly that last case — anyone can regenerate `toolbarIcons.ts` from them with plain Node, no TeX install needed, unless they're also changing a `.tex` source's actual drawing.

**Never hand-edit `src/toolbarIcons.ts`** — it's regenerated wholesale by `make ts` and any manual edit will be silently lost next time someone runs it. To change an icon: edit its `tikz-ui/<id>.tex`, run `make ts`, done.

To add a new toolbar icon: create `tikz-ui/<newId>.tex`, run `make ts` (the script picks up every `.svg` in `svg-ui/` automatically — no id list to update by hand), then import `TOOLBAR_ICONS.newId` where you need it. `src/toolbarIcons.test.ts` enforces the generated file's invariants (valid non-empty SVG, no stray hardcoded `width`/`height`, no literal black, no duplicate `fill-opacity`) — run `npm test` after regenerating.

## `tikz-icon/` — extension icon (`images/icon.png` / `icon_transparency.png`)

The marketplace logo is a separate, full-color TikZ source — `tikz-icon/icon.tex` — rendered straight to PNG rather than through the `currentColor` SVG pipeline above (it's a fixed teal-on-white/transparent bitmap, not a theme-adaptive toolbar glyph). It shares its cube geometry and build pipeline with the sibling project [MDPA-Preview](../../VSCode-MDPA-Preview/icons/tikz-icon/icon.tex): the same isometric L-tromino of three unit cubes in cabinet projection — two plain hexahedra on top and one tetrahedralized cube (bottom-right, split into 6 tets by fanning its three visible-face diagonals from one shared vertex) — a nod to hex-dominant meshing with local tet refinement.

The two logos diverge only in the badge over the tet-meshed cube: MDPA-Preview draws a magnifier (a *preview* of mesh detail); CAD-Preview draws a **drafting compass** instead — the classic tool for striking circles/arcs on a drawing board, a more fitting nod for an extension that reads/edits B-rep CAD geometry than a magnifying glass would be. The needle leg plants on a point, the pencil leg trails a shallow crescent arc, both over the same opaque white contrast disc trick MDPA's lens uses (legible against both the teal mesh and the white/transparent page).

```bash
cd icons
make icon       # tikz-icon/icon.tex → PDF → 512x512 PNGs, needs pdflatex + pdftocairo
```

`make icon` writes both `../images/icon.png` (white background) and `../images/icon_transparency.png` (transparent) — the only difference is `pdftocairo`'s `-transparent` flag. Note `-transparent` is a *coverage* mask, not true per-pixel alpha: any fill-opacity blending (e.g. the compass badge's translucent disc) is flattened against white first, and only pixels no shape ever touched stay transparent — so the badge still shows as a faint flattened patch if `icon_transparency.png` is composited onto a non-white background. This matches MDPA-Preview's own shipped `icon_transparency.png`, not a bug specific to this file.

To change the logo: edit `tikz-icon/icon.tex`, run `make icon`, and commit the two regenerated PNGs (there's no checked-in SVG intermediate for this one, unlike the toolbar icons — the PDF build artifacts live in the gitignored `build-icon/`). `package.json`'s `"icon"` field points at `images/icon.png`; `icon_transparency.png` isn't referenced by the manifest but is kept for parity with MDPA-Preview and any future use that needs a transparent asset.
