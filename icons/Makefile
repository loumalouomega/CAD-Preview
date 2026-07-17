# ── Edits-panel op icons: tikz/*.tex → png/*.png (flat-color previews, not
#    currently wired into the running extension) ──────────────────────────
TEXDIR := tikz
BUILDDIR := build
PNGDIR := png
DPI := 600

TEX := $(wildcard $(TEXDIR)/*.tex)
PNG := $(patsubst $(TEXDIR)/%.tex,$(PNGDIR)/%.png,$(TEX))

# ── Toolbar/panel icons: tikz-ui/*.tex → svg-ui/*.svg → src/toolbarIcons.ts
#    (monochrome, currentColor-based, actually wired into the extension) ──
UI_TEXDIR := tikz-ui
UI_BUILDDIR := build-ui
UI_SVGDIR := svg-ui

UI_TEX := $(wildcard $(UI_TEXDIR)/*.tex)
UI_SVG := $(patsubst $(UI_TEXDIR)/%.tex,$(UI_SVGDIR)/%.svg,$(UI_TEX))

# ── Extension icon (the marketplace logo): tikz-icon/icon.tex → PDF →
#    ../images/icon.png (white bg) + icon_transparency.png (transparent),
#    both 512x512. Needs pdflatex + pdftocairo (poppler); `-transparent`
#    is the only difference between the two renders. ──
ICON_BUILDDIR := build-icon

.PHONY: all ui ts icon clean
all: $(PNG)
ui: $(UI_SVG)

$(PNGDIR)/%.png: $(TEXDIR)/%.tex
	@mkdir -p $(BUILDDIR) $(PNGDIR)
	pdflatex -interaction=nonstopmode -halt-on-error -output-directory=$(BUILDDIR) $< >/dev/null
	pdftoppm -png -r $(DPI) -singlefile $(BUILDDIR)/$*.pdf $(PNGDIR)/$*

$(UI_SVGDIR)/%.svg: $(UI_TEXDIR)/%.tex
	@mkdir -p $(UI_BUILDDIR) $(UI_SVGDIR)
	pdflatex -interaction=nonstopmode -halt-on-error -output-directory=$(UI_BUILDDIR) $< >/dev/null
	pdftocairo -svg $(UI_BUILDDIR)/$*.pdf $(UI_SVGDIR)/$*.svg

# Regenerates ../src/toolbarIcons.ts from svg-ui/*.svg — run after `make ui`
# whenever a tikz-ui/*.tex source changes. Pure Node, no LaTeX needed as long
# as svg-ui/*.svg is already up to date (it's committed for exactly this).
ts: ui
	node build-toolbar-icons.mjs

icon:
	@mkdir -p $(ICON_BUILDDIR)
	pdflatex -interaction=nonstopmode -halt-on-error -output-directory=$(ICON_BUILDDIR) tikz-icon/icon.tex >/dev/null
	pdftocairo -png -singlefile -transparent -scale-to 512 $(ICON_BUILDDIR)/icon.pdf $(ICON_BUILDDIR)/icon_transparency
	pdftocairo -png -singlefile -scale-to 512 $(ICON_BUILDDIR)/icon.pdf $(ICON_BUILDDIR)/icon
	cp $(ICON_BUILDDIR)/icon_transparency.png ../images/icon_transparency.png
	cp $(ICON_BUILDDIR)/icon.png ../images/icon.png

clean:
	rm -rf $(BUILDDIR) $(PNGDIR) $(UI_BUILDDIR) $(UI_SVGDIR) $(ICON_BUILDDIR)
