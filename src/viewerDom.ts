import { TOOLBAR_ICONS } from "./toolbarIcons";

/** `<span>` wrapping a generated, currentColor-based toolbar icon (see toolbarIcons.ts). */
function icon(id: keyof typeof TOOLBAR_ICONS): string {
  return `<span class="toolbar-icon">${TOOLBAR_ICONS[id]}</span>`;
}

/**
 * The static webview body markup (menubar, side panels, 3D `#app` mount,
 * toolbar, view-controls, status). This is the single source of truth for the
 * viewer DOM: `provider.ts` wraps it with the nonce/CSP/`asWebviewUri` script +
 * style tags for the real extension, and the docs screenshot harness
 * (`scripts/screenshots/`) reuses it verbatim so generated screenshots can
 * never drift from the shipped UI.
 *
 * It is deliberately **`vscode`-free** — it depends only on `toolbarIcons.ts`
 * (also `vscode`-free) — so the Node/browser screenshot toolchain can import it
 * without pulling in the extension host.
 */
export function viewerBodyHtml(): string {
  return /* html */ `<div id="menubar">
    <div id="file-menu-wrap">
      <button id="file-menu" title="File menu" aria-haspopup="true" aria-expanded="false">${icon("home")} File ▾</button>
      <div id="file-dropdown" class="hidden" role="menu">
        <button id="menu-open" role="menuitem" title="Open a CAD/mesh file">${icon("open")} Open…</button>
        <button id="menu-save" role="menuitem" title="Save parts/edits/mesh sidecars now">${icon("save")} Save</button>
        <button id="menu-saveas" role="menuitem" title="Export the model to a new file/format">${icon("saveAs")} Save As…</button>
        <button id="menu-export" role="menuitem" title="Export the model to a new file/format">${icon("export")} Export…</button>
        <button id="menu-save-preprocess" role="menuitem" title="Bundle the CAD file + edits/parts/mesh sidecars into a single .zip">${icon("save")} Save Preprocess…</button>
        <button id="menu-load-preprocess" role="menuitem" title="Restore a CAD file + its sidecars from a .zip and open it">${icon("open")} Load Preprocess…</button>
      </div>
    </div>
  </div>
  <div id="layout">
    <div id="side">
      <div id="tree-panel">
        <div id="tree-header">
          <span id="tree-title">Components</span>
          <button id="tree-close" title="Close panel">${icon("close")}</button>
        </div>
        <div id="tree-body"></div>
      </div>
      <div id="parts-panel">
        <div id="parts-header">
          <span id="parts-title">Parts</span>
          <button id="parts-new" title="New part">＋ New</button>
        </div>
        <div id="parts-body"></div>
      </div>
      <div id="edits-panel">
        <div id="edits-header">
          <span id="edits-title">Edits</span>
          <div id="edits-actions">
            <button id="edits-undo" title="Undo last edit" disabled>↶</button>
            <button id="edits-redo" title="Redo edit" disabled>↷</button>
            <button id="edits-clear" title="Clear all edits" disabled>Clear</button>
          </div>
        </div>
        <div id="edits-scroll">
          <div id="variables-section">
            <div id="variables-header">
              <span id="variables-title">Variables</span>
              <button id="variables-add" title="New variable">＋ New</button>
            </div>
            <div id="variables-body"></div>
          </div>
          <div id="edits-compose"></div>
          <div id="edits-body"></div>
        </div>
      </div>
      <div id="meshing-panel">
        <div id="meshing-header">
          <span id="meshing-title">FE Mesh</span>
          <div id="meshing-actions">
            <button id="meshing-generate" title="Generate mesh">${icon("generate")} Generate</button>
            <select id="meshing-export-format" class="meshing-export-select" title="Export format"></select>
            <button id="meshing-export" title="Export mesh">${icon("export")} Export</button>
            <button id="meshing-clear" title="Clear generated mesh">Clear</button>
          </div>
        </div>
        <div id="meshing-progress"></div>
        <div id="meshing-body"></div>
        <div id="meshing-status"></div>
      </div>
    </div>
    <div id="app"></div>
  </div>
  <div id="toolbar">
    <button id="fit" title="Fit to view">${icon("fit")} Fit</button>
    <button id="wireframe" title="Toggle wireframe">${icon("wireframe")} Wireframe</button>
    <button id="grid" title="Toggle grid">▦ Grid</button>
    <button id="screenshot" title="Save the current view as a PNG">📷 Screenshot</button>
    <button id="tree-toggle" title="Toggle component tree" style="display:none">${icon("tree")} Tree</button>
    <button id="meshing-toggle" title="Toggle FE mesh overlay">${icon("feMesh")} FE Mesh</button>
    <div id="select-group" title="Pick entities in the view to assign to a part">
      <button id="sel-toggle" title="Toggle selection mode">${icon("select")} Select</button>
      <button class="sel-mode" data-mode="point" title="Pick points (vertices)">${icon("point")} Point</button>
      <button class="sel-mode" data-mode="volume" title="Pick volumes (solids)">${icon("volume")} Vol</button>
      <button class="sel-mode active" data-mode="surface" title="Pick surfaces (faces)">${icon("surface")} Surf</button>
      <button class="sel-mode" data-mode="line" title="Pick lines (edges)">${icon("line")} Line</button>
    </div>
  </div>
  <div id="view-controls">
    <button id="vc-toggle" class="vc-collapse" title="Hide controls" aria-label="Hide controls">⌄</button>
    <div id="vc-body">
    <div class="vc-group">
      <span class="vc-label">Rotate</span>
      <div class="vc-segments">
        <button class="seg-btn" data-step="15">15°</button>
        <button class="seg-btn active" data-step="45">45°</button>
        <button class="seg-btn" data-step="90">90°</button>
      </div>
      <div class="vc-cross">
        <button id="rot-up" class="vc-arrow" style="grid-area:up" title="Rotate up">↑</button>
        <button id="rot-left" class="vc-arrow" style="grid-area:left" title="Rotate left">←</button>
        <button id="rot-right" class="vc-arrow" style="grid-area:right" title="Rotate right">→</button>
        <button id="rot-down" class="vc-arrow" style="grid-area:down" title="Rotate down">↓</button>
      </div>
    </div>
    <div class="vc-group">
      <span class="vc-label">Pan</span>
      <div class="vc-cross">
        <button id="pan-up" class="vc-arrow" style="grid-area:up" title="Pan up">↑</button>
        <button id="pan-left" class="vc-arrow" style="grid-area:left" title="Pan left">←</button>
        <button id="pan-right" class="vc-arrow" style="grid-area:right" title="Pan right">→</button>
        <button id="pan-down" class="vc-arrow" style="grid-area:down" title="Pan down">↓</button>
      </div>
    </div>
    <div class="vc-group">
      <span class="vc-label">Zoom</span>
      <div class="vc-row">
        <button id="zoom-in" class="vc-arrow" title="Zoom in">+</button>
        <button id="zoom-out" class="vc-arrow" title="Zoom out">−</button>
      </div>
    </div>
    <div class="vc-group">
      <span class="vc-label">View</span>
      <div class="vc-row">
        <button id="view-fit" title="Fit to view">Fit</button>
        <button id="view-reset" title="Reset to default view">Ctr</button>
      </div>
    </div>
    </div>
  </div>
  <div id="status">Loading…</div>`;
}
