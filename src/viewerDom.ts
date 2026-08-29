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
    <div id="file-menu-wrap" class="tb-menu-wrap">
      <button id="file-menu" class="tb-menu" title="File menu" aria-haspopup="true" aria-expanded="false">${icon("home")} File ▾</button>
      <div id="file-dropdown" class="tb-dropdown hidden" role="menu">
        <button id="menu-open" role="menuitem" title="Open a CAD/mesh file">${icon("open")} Open…</button>
        <button id="menu-save" role="menuitem" title="Save parts/edits/mesh sidecars now">${icon("save")} Save</button>
        <button id="menu-saveas" role="menuitem" title="Export the model to a new file/format">${icon("saveAs")} Save As…</button>
        <button id="menu-export" role="menuitem" title="Export the model to a new file/format">${icon("export")} Export…</button>
        <button id="menu-save-preprocess" role="menuitem" title="Bundle the CAD file + edits/parts/mesh sidecars into a single .zip">${icon("save")} Save Preprocess…</button>
        <button id="menu-load-preprocess" role="menuitem" title="Restore a CAD file + its sidecars from a .zip and open it">${icon("open")} Load Preprocess…</button>
        <div class="tb-sep"></div>
        <button id="menu-import-svg" role="menuitem" title="Import an SVG file's paths as standalone sketch polylines (Vol/Surf mode → Extrude to build a solid)">${icon("open")} Import SVG…</button>
        <button id="menu-import-dxf" role="menuitem" title="Import a DXF file's entities as standalone sketch primitives (lines, arcs, circles, polylines, splines — pick in Vol/Surf/Line mode, extrude to build a solid)">${icon("open")} Import DXF…</button>
        <button id="menu-export-svg" role="menuitem" title="Export a 2D outline (silhouette) of the model as an SVG drawing — outline only, no hidden-line removal">${icon("export")} Export Silhouette SVG…</button>
        <button id="menu-export-dxf" role="menuitem" title="Export a 2D outline (silhouette) of the model as a DXF drawing — chained polylines (LWPOLYLINE with bulges for arcs) plus singletons as LINEs, outline only">${icon("export")} Export Silhouette DXF…</button>
        <button id="menu-export-drawing" role="menuitem" title="Export a 2D technical drawing — feature edges with hidden-line removal, occluded runs dashed">${icon("export")} Export Technical Drawing…</button>
      </div>
    </div>
  </div>
  <div id="layout">
    <div id="side">
      <div id="tree-panel">
        <div id="tree-header">
          <span id="tree-title">Components</span>
          <input id="tree-filter" type="search" placeholder="Filter…" title="Filter components by name">
          <button id="tree-close" title="Close panel">${icon("close")}</button>
        </div>
        <div id="tree-body"></div>
      </div>
      <div id="parts-panel">
        <div id="parts-header">
          <span id="parts-title">Parts</span>
          <div id="parts-header-actions">
            <button id="parts-isolate" title="Isolate the selected part (show only it)">${icon("isolate")} Isolate</button>
            <button id="parts-new" title="New part">${icon("add")} New</button>
          </div>
        </div>
        <div id="parts-body"></div>
      </div>
      <div id="edits-panel">
        <div id="edits-header">
          <span id="edits-title">Edits</span>
          <div id="edits-actions">
            <button id="edits-undo" title="Undo last edit" disabled>${icon("undo")}</button>
            <button id="edits-redo" title="Redo edit" disabled>${icon("redo")}</button>
            <button id="edits-clear" title="Clear all edits" disabled>${icon("clear")} Clear</button>
          </div>
        </div>
        <div id="edits-scroll">
          <div id="variables-section">
            <div id="variables-header">
              <span id="variables-title">Variables</span>
              <button id="variables-add" title="New variable">${icon("add")} New</button>
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
            <select id="meshing-export-unit" class="meshing-export-select" title="Export unit (geometric scale — mm is native, no conversion)"></select>
            <button id="meshing-export" title="Export mesh">${icon("export")} Export</button>
            <button id="meshing-clear" title="Clear generated mesh">${icon("clear")} Clear</button>
            <button id="meshing-worst-toggle" title="Highlight worst-quality elements" hidden>${icon("warning")} Worst</button>
          </div>
        </div>
        <div id="meshing-progress"></div>
        <div id="meshing-body"></div>
        <div id="meshing-status"></div>
        <div id="meshing-quality"></div>
      </div>
      <div id="mass-panel">
        <div id="mass-header">
          <span id="mass-title">Mass Properties</span>
          <button id="mass-refresh" title="Compute for the current selection, or the whole model if nothing is selected">${icon("generate")} Compute</button>
        </div>
        <div id="mass-body"></div>
      </div>
      <div id="mesh-health-panel" hidden>
        <div id="mesh-health-header">
          <span id="mesh-health-title">Mesh Health</span>
          <div id="mesh-health-actions">
            <button id="mesh-health-check" title="Read-only diagnostic: checks whether this mesh could be closed into a valid B-rep solid, and at what tolerance/cost — does not promote or change anything">${icon("generate")} Check Healability</button>
            <button id="mesh-health-promote" title="Sew this mesh into a solid and save it as a brand-new STEP/IGES/BREP file — the original mesh file is left untouched" disabled>${icon("export")} Promote to B-rep…</button>
            <button id="mesh-health-repair" title="Tetrahedralize this mesh with fTetWild and save its watertight boundary as a brand-new STL file — for a component that would not close above; the original mesh file is left untouched" disabled>Repair (robust)…</button>
          </div>
        </div>
        <div id="mesh-health-body"></div>
      </div>
      <div id="macros-panel">
        <div id="macros-header">
          <span id="macros-title">Macros</span>
          <button id="macros-save" title="Save the current edit history as a reusable, parameterized macro">${icon("save")} Save current</button>
        </div>
        <div id="macros-body"></div>
      </div>
      <div id="standard-parts-panel">
        <div id="standard-parts-header">
          <span id="standard-parts-title">Standard Parts</span>
        </div>
        <div id="standard-parts-search-row">
          <input id="standard-parts-query" type="search" placeholder="Search step.parts…" title="Search the step.parts catalog (e.g. &quot;M6 hex bolt&quot;)">
          <button id="standard-parts-search-btn" title="Search">Search</button>
        </div>
        <div id="standard-parts-body"></div>
        <div id="standard-parts-status"></div>
      </div>
    </div>
    <div id="app">
      <canvas id="markup-canvas"></canvas>
      <!-- Split-view pane separators — pure visual dividers over the single
           WebGL canvas (pointer-events:none), shown only while a 2×2 layout
           is active. Below the markup canvas so annotations draw over them. -->
      <div id="pane-divider-v" class="pane-divider hidden"></div>
      <div id="pane-divider-h" class="pane-divider hidden"></div>
      <!-- Hover "teach" tooltip: the entity id under the cursor and which ops
           MENTION it. Cursor-anchored, so it lives inside #app (whose box the
           canvas shares) and is pointer-events:none — it must never eat a
           click meant for the geometry beneath it. -->
      <div id="hover-tip" class="hidden"></div>
      <!-- Inspector card: analytic classification of the SELECTED entity.
           Selection-driven rather than hover-driven because it costs a host
           round trip, and getEntityFacts has no shape cache — every call
           re-reads the source bytes and replays the whole op list. -->
      <div id="inspector-card" class="hidden"></div>
      <!-- Selection-groups context menu: right-click an entity to select
           everything like it. Reuses the query-filter predicates rather than
           inventing a second vocabulary; the clicked entity supplies the
           argument the filter form would make you type. -->
      <div id="context-menu" class="tb-dropdown hidden" role="menu"></div>
    </div>
  </div>
  <div id="toolbar">
    <button id="fit" title="Fit to view">${icon("fit")} Fit</button>
    <button id="tree-toggle" title="Toggle component tree" style="display:none">${icon("tree")} Tree</button>
    <button id="meshing-toggle" title="Toggle FE mesh overlay">${icon("feMesh")} FE Mesh</button>
    <div class="tb-menu-wrap">
      <button id="view-menu" class="tb-menu" title="View options" aria-haspopup="true" aria-expanded="false">${icon("view")} View ▾</button>
      <div id="view-dropdown" class="tb-dropdown hidden" role="menu">
        <button id="grid" role="menuitemcheckbox" aria-checked="false" title="Toggle the grid and axis helpers">${icon("grid")} Grid</button>
        <button id="edges" role="menuitemcheckbox" aria-checked="true" title="Toggle edge visibility">${icon("edges")} Edges</button>
        <button id="hide-smooth-edges" role="menuitemcheckbox" aria-checked="false" title="Hide tangent patch-seam edges (e.g. between adjacent NURBS patches of one curved surface), keeping genuine feature edges">${icon("edges")} Hide smooth edges</button>
        <div class="tb-sep"></div>
        <button id="snap-grid" role="menuitemcheckbox" aria-checked="false" title="Snap Transform Gizmo drags to a grid spacing">${icon("grid")} Snap to grid</button>
        <button id="snap-points" role="menuitemcheckbox" aria-checked="false" title="Snap Transform Gizmo drags to nearby existing points">${icon("point")} Snap to points</button>
        <div class="tb-sep"></div>
        <div id="layout-group" class="tb-row" title="Pane layout — one view or a split of independent cameras over the same scene">
          <button class="layout-btn active" data-layout="1x1" title="Single view — one camera over the whole canvas">${icon("layout1x1")} 1×1</button>
          <button class="layout-btn" data-layout="1x2" title="Two side-by-side columns — two independent cameras, vertical split">${icon("layout1x2")} 1×2</button>
          <button class="layout-btn" data-layout="2x1" title="Two stacked rows — two independent cameras, horizontal split">${icon("layout2x1")} 2×1</button>
          <button class="layout-btn" data-layout="2x2" title="Quad — four independent cameras on a 2×2 grid">${icon("layout2x2")} 2×2</button>
        </div>
        <div class="tb-sep"></div>
        <button id="link-cameras" role="menuitemcheckbox" aria-checked="false" title="Share camera orientation across all open CAD Preview tabs">${icon("view")} Link cameras across tabs</button>
        <div class="tb-sep"></div>
        <button id="screenshot" role="menuitem" title="Save the current view as a PNG">${icon("screenshot")} Screenshot…</button>
      </div>
    </div>
    <div class="tb-menu-wrap">
      <button id="select-menu" class="tb-menu" title="Pick entities in the view to assign to a part" aria-haspopup="true" aria-expanded="false">${icon("select")} Select ▾</button>
      <div id="select-dropdown" class="tb-dropdown hidden" role="menu">
        <button id="sel-toggle" role="menuitemcheckbox" aria-checked="false" title="Toggle selection mode">${icon("select")} Selection mode</button>
        <div id="select-group" class="tb-row" title="What a click picks">
          <button class="sel-mode" data-mode="point" title="Pick points (vertices)">${icon("point")} Point</button>
          <button class="sel-mode" data-mode="volume" title="Pick volumes (solids)">${icon("volume")} Vol</button>
          <button class="sel-mode active" data-mode="surface" title="Pick surfaces (faces)">${icon("surface")} Surf</button>
          <button class="sel-mode" data-mode="line" title="Pick lines (edges)">${icon("line")} Line</button>
        </div>
        <div class="tb-sep"></div>
        <div id="filter-group" class="tb-filter" title="Geometric filter — select entities by shape predicates">
          <div class="tb-row">
            <select id="filter-pred" title="Filter predicate"></select>
            <input id="filter-arg" type="text" inputmode="decimal" placeholder="value" title="Threshold / count for the selected filter">
          </div>
          <div class="tb-row">
            <label class="tb-check" for="filter-exclude-smooth" title="When set, edge filters skip tangent seam edges (patch seams on what is logically one curved surface)">
              <input type="checkbox" id="filter-exclude-smooth"> No seams
            </label>
            <button id="filter-replace" title="Replace the current selection with the filtered result">Select</button>
            <button id="filter-add" title="Add the filtered result to the current selection">Add</button>
          </div>
        </div>
      </div>
    </div>
    <div class="tb-menu-wrap">
      <button id="measure-menu" class="tb-menu" title="Measure distances, lengths, angles, and radii" aria-haspopup="true" aria-expanded="false">${icon("measure")} Measure ▾</button>
      <div id="measure-dropdown" class="tb-dropdown hidden" role="menu">
        <button id="measure-toggle" role="menuitemcheckbox" aria-checked="false" title="Toggle measure mode">${icon("measure")} Measure mode</button>
        <div id="measure-tool" class="tb-row" title="Measurement tool">
          <button class="measure-tool-btn active" data-tool="distance" title="Distance between two picks">${icon("distance")} Distance</button>
          <button class="measure-tool-btn" data-tool="edgeLength" title="Length of a picked edge">${icon("edgeLength")} Length</button>
          <button class="measure-tool-btn" data-tool="angle" title="Angle between two picks">${icon("angle")} Angle</button>
          <button class="measure-tool-btn" data-tool="radius" title="Radius of a picked arc">${icon("radius")} Radius</button>
        </div>
        <div class="tb-sep"></div>
        <button id="measure-clear" role="menuitem" title="Clear current measurement">${icon("clear")} Clear measurement</button>
        <div class="tb-sep"></div>
        <div id="annotations-list" title="Pinned measurements — persisted, and re-anchored across edits"></div>
      </div>
    </div>
    <div class="tb-menu-wrap">
      <button id="markup-menu" class="tb-menu" title="Draw review annotations over the 3D view" aria-haspopup="true" aria-expanded="false">${icon("markup")} Markup ▾</button>
      <div id="markup-dropdown" class="tb-dropdown hidden" role="menu">
        <button id="markup-toggle" role="menuitemcheckbox" aria-checked="false" title="Toggle markup mode">${icon("markup")} Markup mode</button>
        <div id="markup-tool" class="tb-row" title="Markup tool">
          <button class="markup-tool-btn active" data-tool="freehand" title="Freehand">${icon("freehand")}</button>
          <button class="markup-tool-btn" data-tool="line" title="Line">${icon("line")}</button>
          <button class="markup-tool-btn" data-tool="arrow" title="Arrow">${icon("arrow")}</button>
          <button class="markup-tool-btn" data-tool="rectangle" title="Rectangle">${icon("rectangle")}</button>
          <button class="markup-tool-btn" data-tool="circle" title="Circle">${icon("circle")}</button>
          <button class="markup-tool-btn" data-tool="eraser" title="Eraser">${icon("eraser")}</button>
        </div>
        <label class="tb-field" for="markup-color">Colour
          <input type="color" id="markup-color" title="Stroke colour" value="#ff3b30">
        </label>
        <div class="tb-sep"></div>
        <button id="markup-undo" role="menuitem" title="Undo last stroke">${icon("undo")} Undo</button>
        <button id="markup-redo" role="menuitem" title="Redo">${icon("redo")} Redo</button>
        <button id="markup-clear" role="menuitem" title="Clear all annotations">${icon("clear")} Clear</button>
      </div>
    </div>
  </div>
  <div id="measure-readout-row">
    <span id="measure-readout"></span>
    <button id="measure-exact-btn" title="Recompute at exact B-rep precision (a host round trip, vs. the instant triangulated approximation above)" hidden>${icon("generate")} Exact</button>
    <span id="measure-tol-group" hidden>
      <label class="measure-tol-field">nom <input type="text" inputmode="decimal" id="measure-tol-nominal" placeholder="nominal" title="Nominal value for a tolerance band on the pinned annotation (same unit as the readout; leave blank to pin without a band)"></label>
      <label class="measure-tol-field">+ <input type="text" inputmode="decimal" id="measure-tol-plus" placeholder="+" title="Allowed deviation above nominal (defaults symmetric when − is blank)"></label>
      <label class="measure-tol-field">− <input type="text" inputmode="decimal" id="measure-tol-minus" placeholder="−" title="Allowed deviation below nominal (blank = same as +)"></label>
    </span>
    <button id="measure-pin-btn" title="Pin this measurement as a persisted annotation — survives closing the file, re-anchored across edits" hidden>${icon("save")} Pin</button>
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
    <div class="vc-group">
      <span class="vc-label">Clip</span>
      <div class="vc-segments">
        <button class="clip-axis active" data-axis="x">X</button>
        <button class="clip-axis" data-axis="y">Y</button>
        <button class="clip-axis" data-axis="z">Z</button>
        <button class="clip-axis" id="clip-custom" hidden title="Custom clip normal">N</button>
      </div>
      <div class="vc-row">
        <button id="clip-from-face" title="Clip along the selected planar face">Face</button>
        <button id="clip-from-points" title="Clip through three selected points">3 Pts</button>
      </div>
      <input type="range" id="clip-offset" class="meshing-slider" min="-100" max="100" value="0" title="Clip plane offset along the active normal">
      <button id="clip-toggle" title="Toggle clipping">Off</button>
    </div>
    <div class="vc-group">
      <span class="vc-label">Appearance</span>
      <div class="vc-row">
        <input type="color" id="vc-background" title="Background colour" value="#1e1e1e">
        <input type="range" id="vc-opacity" class="meshing-slider" min="0" max="100" value="100" title="Model opacity">
        <button id="vc-ortho" title="Toggle orthographic/perspective projection">Persp</button>
      </div>
      <div class="vc-row">
        <label for="vc-unit" class="vc-label">Units</label>
        <select id="vc-unit" title="Display unit for measurements and mass properties">
          <option value="mm">mm</option>
          <option value="cm">cm</option>
          <option value="m">m</option>
          <option value="in">in</option>
          <option value="ft">ft</option>
        </select>
      </div>
      <div class="vc-row">
        <label for="vc-grid-size" class="vc-label">Grid size</label>
        <input type="text" inputmode="decimal" id="vc-grid-size" class="vc-num" value="1" title="Grid snap spacing, in the model's own units (mm unless the file declares otherwise)">
      </div>
    </div>
    <div class="vc-group" id="vc-colorfield-group" hidden>
      <span class="vc-label">Colour by field</span>
      <div class="vc-row">
        <select id="vc-colorfield-select" title="Colour the model by a scalar field declared in the source file">
          <option value="">None</option>
        </select>
      </div>
      <div class="vc-row" id="vc-colorfield-legend" hidden>
        <div id="vc-colorfield-gradient"></div>
        <span id="vc-colorfield-min"></span>
        <span id="vc-colorfield-max"></span>
      </div>
    </div>
    <div class="vc-group">
      <span class="vc-label">Display</span>
      <div class="vc-segments" id="display-mode-group">
        <button class="display-mode-btn active" data-mode="shaded" title="Shaded — normal lit faces">${icon("shaded")} Shaded</button>
        <button class="display-mode-btn" data-mode="wireframe" title="Wireframe — faces rendered as a mesh of lines">${icon("wireframe")} Wire</button>
        <button class="display-mode-btn" data-mode="xray" title="X-Ray — translucent faces, edges visible through them">${icon("xray")} X-Ray</button>
        <button class="display-mode-btn" data-mode="hiddenLines" title="Hidden Lines — occluded edges shown faintly through solids">${icon("hiddenLines")} Hidden</button>
        <button class="display-mode-btn" data-mode="flat" title="Flat — unlit constant-colour faces, no shading gradient">${icon("flat")} Flat</button>
      </div>
    </div>
    </div>
  </div>
  <div id="status">Loading…</div>`;
}
