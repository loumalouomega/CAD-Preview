TEXDIR := tikz
BUILDDIR := build
PNGDIR := png
DPI := 600

TEX := $(wildcard $(TEXDIR)/*.tex)
PNG := $(patsubst $(TEXDIR)/%.tex,$(PNGDIR)/%.png,$(TEX))

.PHONY: all clean
all: $(PNG)

$(PNGDIR)/%.png: $(TEXDIR)/%.tex
	@mkdir -p $(BUILDDIR) $(PNGDIR)
	pdflatex -interaction=nonstopmode -halt-on-error -output-directory=$(BUILDDIR) $< >/dev/null
	pdftoppm -png -r $(DPI) -singlefile $(BUILDDIR)/$*.pdf $(PNGDIR)/$*

clean:
	rm -rf $(BUILDDIR) $(PNGDIR)
