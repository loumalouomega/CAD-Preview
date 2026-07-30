# ── Toolbar/panel icons: tikz-ui/*.tex → svg-ui/*.svg → src/toolbarIcons.ts
#    (monochrome, currentColor-based, wired into the extension) ──
UI_TEXDIR := tikz-ui
UI_BUILDDIR := build-ui
UI_SVGDIR := svg-ui

UI_TEX := $(wildcard $(UI_TEXDIR)/*.tex)
UI_SVG := $(patsubst $(UI_TEXDIR)/%.tex,$(UI_SVGDIR)/%.svg,$(UI_TEX))

# ── Edits-panel op icons: tikz/*.tex → svg-ops/*.svg → src/webview/opIcons.ts
#    (same currentColor pipeline as tikz-ui above, wired into the extension —
#    this replaced an earlier tikz/*.tex → png/*.png preview pipeline that was
#    never wired in) ──
OPS_TEXDIR := tikz
OPS_BUILDDIR := build-ops
OPS_SVGDIR := svg-ops

OPS_TEX := $(wildcard $(OPS_TEXDIR)/*.tex)
OPS_SVG := $(patsubst $(OPS_TEXDIR)/%.tex,$(OPS_SVGDIR)/%.svg,$(OPS_TEX))

# ── Extension icon (the marketplace logo): tikz-icon/icon.tex → PDF →
#    ../images/icon.png (white bg) + icon_transparency.png (transparent),
#    both 512x512. Needs pdflatex + pdftocairo (poppler); `-transparent`
#    is the only difference between the two renders. ──
ICON_BUILDDIR := build-icon

.PHONY: ui ts ops ops-ts icon clean
ui: $(UI_SVG)
ops: $(OPS_SVG)

$(UI_SVGDIR)/%.svg: $(UI_TEXDIR)/%.tex
	@mkdir -p $(UI_BUILDDIR) $(UI_SVGDIR)
	pdflatex -interaction=nonstopmode -halt-on-error -output-directory=$(UI_BUILDDIR) $< >/dev/null
	pdftocairo -svg $(UI_BUILDDIR)/$*.pdf $(UI_SVGDIR)/$*.svg

$(OPS_SVGDIR)/%.svg: $(OPS_TEXDIR)/%.tex
	@mkdir -p $(OPS_BUILDDIR) $(OPS_SVGDIR)
	pdflatex -interaction=nonstopmode -halt-on-error -output-directory=$(OPS_BUILDDIR) $< >/dev/null
	pdftocairo -svg $(OPS_BUILDDIR)/$*.pdf $(OPS_SVGDIR)/$*.svg

# Regenerates ../src/toolbarIcons.ts from svg-ui/*.svg — run after `make ui`
# whenever a tikz-ui/*.tex source changes. Pure Node, no LaTeX needed as long
# as svg-ui/*.svg is already up to date (it's committed for exactly this).
ts: ui
	node build-toolbar-icons.mjs

# Regenerates ../src/webview/opIcons.ts from svg-ops/*.svg — same idea as
# `ts` above, for the Edits-panel op buttons.
ops-ts: ops
	node build-op-icons.mjs

icon:
	@mkdir -p $(ICON_BUILDDIR)
	pdflatex -interaction=nonstopmode -halt-on-error -output-directory=$(ICON_BUILDDIR) tikz-icon/icon.tex >/dev/null
	pdftocairo -png -singlefile -transparent -scale-to 512 $(ICON_BUILDDIR)/icon.pdf $(ICON_BUILDDIR)/icon_transparency
	pdftocairo -png -singlefile -scale-to 512 $(ICON_BUILDDIR)/icon.pdf $(ICON_BUILDDIR)/icon
	cp $(ICON_BUILDDIR)/icon_transparency.png ../images/icon_transparency.png
	cp $(ICON_BUILDDIR)/icon.png ../images/icon.png

clean:
	rm -rf $(UI_BUILDDIR) $(UI_SVGDIR) $(OPS_BUILDDIR) $(OPS_SVGDIR) $(ICON_BUILDDIR)
