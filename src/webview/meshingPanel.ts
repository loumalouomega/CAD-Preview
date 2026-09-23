import { SIZE_MAX_SENTINEL, DEFAULT_MESH_OPTIONS, validateMeshGrading, type MeshOptions, type MeshGrading } from "../meshOptions";
import type { QualitySummary } from "../meshQuality";
import { TOOLBAR_ICONS } from "../toolbarIcons";
import { MESH_EXPORT_FORMATS, type MeshExportFormatId } from "../meshExportFormats";
import { DISPLAY_UNITS, UNIT_LABELS, type DisplayUnit } from "../lengthUnits";
import type { Part, MeshPresetSummary } from "../protocol";
import { MESHIO_OP_IDS, MESHIO_OP_LABELS, type MeshioOpId, type MeshioOpSpec } from "../meshioOps";
import {
  LARGE_ELEMENT_COUNT,
  PRESET_DIVISORS,
  defaultTargetSize,
  estimateElementCount,
  formatCount,
  formatSize,
  sizeToSlider,
  sliderToSize,
} from "./meshSizeHeuristics";

/** The displayed model's bounding-box dimensions, from `Viewer.getModelExtents()`. */
export interface ModelExtents {
  size: [number, number, number];
  diagonal: number;
}

/** Success readout: the generated mesh's element counts (+ wall-clock time). */
export interface MeshingStats {
  nodeCount: number;
  elementCount: number;
  elapsedMs?: number;
  /** Per-element quality summary (min/mean/histogram) — omitted if it
   * couldn't be computed for this generate (e.g. a 1D mesh). */
  quality?: QualitySummary;
  /** The worst-quality-elements highlight overlay's stats — omitted for a
   * non-3D generate, or when nothing scored below the quality threshold. */
  worstElements?: { threshold: number; shownCount: number; belowThresholdCount: number };
}

/** Failure readout: a human-readable error message from the host. */
export interface MeshingError {
  error: string;
}

export interface MeshingPanelCallbacks {
  /** A form control changed; the wiring merges the patch into the model and re-generates/persists. */
  onOptionsChange: (patch: Partial<MeshOptions>) => void;
  /** A part's target mesh size changed in the "Part sizes" section (`undefined` = inherit global). */
  onPartMeshSize: (index: number, size: number | undefined) => void;
  /** A part's distance-graded sizing band changed in the "Part sizes" section
   * (`undefined` = clear it). Only called with a well-formed band or
   * `undefined` — an invalid band is caught and shown inline, never
   * forwarded. */
  onPartMeshGrading: (index: number, grading: MeshGrading | undefined) => void;
  onGenerate: () => void;
  onCancel: (requestId: string) => void;
  /** Export in the format/unit currently picked in the two `<select>`s. `unit`
   * is a real geometric scale applied before Gmsh ever sees the geometry
   * (mirroring the model Export command's own unit conversion) — "mm" is
   * native/no-op. */
  onExport: (format: MeshExportFormatId, unit: DisplayUnit) => void;
  onClear: () => void;
  /** Apply a saved meshing preset by name (host resolves the merged library,
   * converts units, and writes `.mesh.json` — settings only, no generate). */
  onPresetApply: (name: string) => void;
  /** Save the current options as a preset; the host prompts for a name. */
  onPresetSaveCurrent: () => void;
  onPresetDelete: (name: string) => void;
  /** Run one meshio++ mesh operation over the current meshio++-imported
   * source (a new file via the host's save flow — the source is never
   * modified). The wiring posts `meshioOpsRequest` and renders the per-step
   * report from `meshioOpsResult`. */
  onMeshOps: (ops: MeshioOpSpec[]) => void;
}

/** Curated, well-known GMSH 2D algorithm ids (`Mesh.Algorithm`) — not exhaustive. */
const ALGORITHM_2D: Array<[number, string]> = [
  [1, "MeshAdapt"],
  [5, "Delaunay"],
  [6, "Frontal-Delaunay"],
];

/** Curated, well-known GMSH 3D algorithm ids (`Mesh.Algorithm3D`) — not exhaustive. */
const ALGORITHM_3D: Array<[number, string]> = [
  [1, "Delaunay"],
  [4, "Frontal"],
  [10, "HXT"],
];

/**
 * Renders the meshing controls: a primary coarser→finer element-size slider
 * (log-scale over the model's bounding-box diagonal, with Coarse/Medium/Fine
 * presets and a live size + estimated-element-count readout), a "Part sizes"
 * section mirroring the Parts panel's per-part size inputs, and a collapsed
 * "Advanced settings" section holding the raw GMSH options (dimension, size
 * min/max, algorithm choice, element order, optimize, STL angle) — plus
 * Generate/Export-format-`<select>`+Export-unit-`<select>`+Export/Clear
 * controls, a large-mesh warning, and a stats/error readout. The export
 * format picker is a single `<select>` populated from `MESH_EXPORT_FORMATS`
 * (`meshExportFormats.ts`) rather than one button per format — that list only
 * grows over time, and a dedicated button per Gmsh output format doesn't
 * scale in a sidebar panel. The export unit picker (`DISPLAY_UNITS`,
 * `lengthUnits.ts`) is a real geometric scale applied before Gmsh sees the
 * geometry — mirrors the model Export command's own unit picker, defaults to
 * "mm" (native, no conversion), and is entirely separate from the view-
 * controls Units dropdown (display-only, never touches geometry). DOM-only —
 * no business logic (all size math is `meshSizeHeuristics.ts`),
 * no `prompt()`/`alert()` (VS Code webviews block them; see `partsPanel.ts`
 * for the established inline-`<input>` convention this codebase uses instead).
 */
export class MeshingPanel {
  private readonly body: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly qualityEl: HTMLElement;
  private readonly progressEl: HTMLElement;
  private readonly generateBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly exportFormatSelect: HTMLSelectElement;
  private readonly exportUnitSelect: HTMLSelectElement;
  private readonly exportBtn: HTMLButtonElement;
  private readonly clearBtn: HTMLButtonElement;

  private readonly warningEl: HTMLElement;
  private readonly sizeSlider: HTMLInputElement;
  private readonly sliderReadout: HTMLElement;
  /** Coarse / Medium / Fine, kept so the one nearest the current size can read as selected. */
  private readonly presetButtons: Array<{ key: keyof typeof PRESET_DIVISORS; el: HTMLButtonElement }> = [];
  private readonly partsSection: HTMLElement;
  private readonly partsBody: HTMLElement;

  private readonly engineSelect: HTMLSelectElement;
  private readonly dimensionSelect: HTMLSelectElement;
  private readonly sizeMinInput: HTMLInputElement;
  private readonly sizeMaxInput: HTMLInputElement;
  private readonly algorithm2DSelect: HTMLSelectElement;
  private readonly algorithm3DSelect: HTMLSelectElement;
  private readonly elementOrderSelect: HTMLSelectElement;
  private readonly elementShapeSelect: HTMLSelectElement;
  private readonly optimizeCheckbox: HTMLInputElement;
  private readonly stlAngleInput: HTMLInputElement;
  private readonly ftetwildEpsRelInput: HTMLInputElement;
  private readonly ftetwildManifoldSurfaceCheckbox: HTMLInputElement;
  private readonly ftetwildCoarsenCheckbox: HTMLInputElement;
  private readonly ftetwildDisableFilteringCheckbox: HTMLInputElement;

  /** Mesh-ops section (meshio++ sources only) — one operation per Run. */
  private readonly meshOpsSection: HTMLElement;
  private readonly meshOpsSelect: HTMLSelectElement;
  private readonly meshOpsRatio: HTMLInputElement;
  private readonly meshOpsMethod: HTMLSelectElement;
  private readonly meshOpsIterations: HTMLInputElement;
  private readonly meshOpsLevels: HTMLInputElement;
  private readonly meshOpsTargetGroupSize: HTMLInputElement;
  private readonly meshOpsMode: HTMLSelectElement;
  private readonly meshOpsRun: HTMLButtonElement;
  private readonly meshOpsStatus: HTMLElement;

  private readonly presetSelect: HTMLSelectElement;
  private readonly presetApplyBtn: HTMLButtonElement;
  private readonly presetSaveBtn: HTMLButtonElement;
  private readonly presetDeleteBtn: HTMLButtonElement;
  private presets: MeshPresetSummary[] = [];

  /** Model bounding box, pushed by the wiring after each model load. */
  private extents: ModelExtents | null = null;
  /** Options as of the last `render()` — the slider/estimate math needs them between renders. */
  private lastOptions: MeshOptions | null = null;

  constructor(
    private readonly panel: HTMLElement,
    private readonly cb: MeshingPanelCallbacks
  ) {
    this.body = panel.querySelector("#meshing-body")!;
    this.statusEl = panel.querySelector("#meshing-status")!;
    this.qualityEl = panel.querySelector("#meshing-quality")!;
    this.progressEl = panel.querySelector("#meshing-progress")!;
    this.generateBtn = panel.querySelector("#meshing-generate")!;
    this.cancelBtn = panel.querySelector("#meshing-cancel")!;
    this.exportFormatSelect = panel.querySelector("#meshing-export-format")!;
    this.exportUnitSelect = panel.querySelector("#meshing-export-unit")!;
    this.exportBtn = panel.querySelector("#meshing-export")!;
    this.clearBtn = panel.querySelector("#meshing-clear")!;
    // The static markup puts the action rows at the top of the body. The export row
    // belongs at the END (it acts on the result of everything above it), so it is
    // lifted out here and re-appended after the last section further down.
    const exportRow = panel.querySelector<HTMLElement>("#meshing-export-row");
    if (exportRow) exportRow.remove();

    for (const format of MESH_EXPORT_FORMATS) {
      const opt = document.createElement("option");
      opt.value = format.id;
      opt.textContent = format.label;
      this.exportFormatSelect.appendChild(opt);
    }

    // "mm" first/default — native cascade unit, no conversion, matching the
    // model Export command's own unit picker's default.
    for (const unit of DISPLAY_UNITS) {
      const opt = document.createElement("option");
      opt.value = unit;
      opt.textContent = unit;
      opt.title = UNIT_LABELS[unit];
      this.exportUnitSelect.appendChild(opt);
    }

    this.generateBtn.addEventListener("click", () => cb.onGenerate());
    this.cancelBtn.addEventListener("click", () => {
      const requestId = this.cancelBtn.dataset.requestId;
      if (requestId) cb.onCancel(requestId);
    });
    this.exportBtn.addEventListener("click", () =>
      cb.onExport(this.exportFormatSelect.value as MeshExportFormatId, this.exportUnitSelect.value as DisplayUnit)
    );
    this.clearBtn.addEventListener("click", () => cb.onClear());

    // ── Large-mesh warning (above everything, visible regardless of collapse) ──
    this.warningEl = document.createElement("div");
    this.warningEl.id = "meshing-warning";
    this.warningEl.hidden = true;
    this.body.appendChild(this.warningEl);

    // ── Primary size control: presets + coarser→finer slider + readout ──
    const sizeSection = document.createElement("div");
    sizeSection.className = "meshing-size";

    const presetRow = document.createElement("div");
    presetRow.className = "meshing-preset-row";
    for (const key of ["coarse", "medium", "fine"] as const) {
      const btn = document.createElement("button");
      btn.className = "meshing-preset";
      btn.textContent = key.charAt(0).toUpperCase() + key.slice(1);
      btn.title = `Set element size to model diagonal / ${PRESET_DIVISORS[key]}`;
      btn.addEventListener("click", () => {
        if (!this.extents) return;
        this.commitSizeMax(this.extents.diagonal / PRESET_DIVISORS[key]);
      });
      presetRow.appendChild(btn);
      this.presetButtons.push({ key, el: btn });
    }
    sizeSection.appendChild(presetRow);

    const sliderRow = document.createElement("div");
    sliderRow.className = "meshing-slider-row";
    const coarserLabel = document.createElement("span");
    coarserLabel.className = "meshing-slider-end";
    coarserLabel.textContent = "Coarser";
    sliderRow.appendChild(coarserLabel);

    this.sizeSlider = document.createElement("input");
    this.sizeSlider.type = "range";
    this.sizeSlider.className = "meshing-slider";
    this.sizeSlider.min = "0";
    this.sizeSlider.max = "1000";
    this.sizeSlider.step = "1";
    this.sizeSlider.disabled = true;
    // Mid-drag: refresh the readout/warning locally only. The commit (and the
    // resulting `meshingChanged` message + sidecar write) happens on release
    // ("change"), so dragging never spams the host.
    this.sizeSlider.addEventListener("input", () => {
      if (!this.extents) return;
      this.refreshSizeReadout(sliderToSize(Number(this.sizeSlider.value) / 1000, this.extents.diagonal));
    });
    this.sizeSlider.addEventListener("change", () => {
      if (!this.extents) return;
      this.commitSizeMax(sliderToSize(Number(this.sizeSlider.value) / 1000, this.extents.diagonal));
    });
    sliderRow.appendChild(this.sizeSlider);

    const finerLabel = document.createElement("span");
    finerLabel.className = "meshing-slider-end";
    finerLabel.textContent = "Finer";
    sliderRow.appendChild(finerLabel);
    sizeSection.appendChild(sliderRow);

    // "Element size            12.9 mm" — label left, value right, ABOVE the slider
    // (CSS `order` puts it there; the DOM keeps the original sequence). The value
    // element is `sliderReadout`, so every existing write to it lands in the right
    // place.
    const readoutRow = document.createElement("div");
    readoutRow.className = "meshing-readout-row";
    const readoutLabel = document.createElement("span");
    readoutLabel.className = "meshing-readout-label";
    readoutLabel.textContent = "Element size";
    readoutRow.appendChild(readoutLabel);
    this.sliderReadout = document.createElement("span");
    this.sliderReadout.className = "meshing-slider-readout ui-num";
    this.sliderReadout.textContent = "—";
    readoutRow.appendChild(this.sliderReadout);
    sizeSection.appendChild(readoutRow);

    this.body.appendChild(sizeSection);

    // ── Engine (a first-class choice, not an "advanced" knob — placed above
    // the collapsed Advanced settings section, right below the primary size
    // control it composes with) ──
    const engineSection = document.createElement("div");
    engineSection.className = "meshing-form";
    this.engineSelect = this.select(engineSection, "Engine", [
      ["gmsh", "Gmsh (default)"],
      ["ftetwild", "fTetWild (robust)"],
    ]);
    this.engineSelect.title =
      "Gmsh is fast but needs a watertight/manifold/well-oriented boundary. " +
      "fTetWild survives dirty triangle meshes (holes, self-intersections, non-manifold edges) " +
      "that make Gmsh's own STL reclassification throw or silently produce no elements — " +
      "only for a mesh-format 3D source; a B-rep source or a non-3D dimension falls back to Gmsh.";
    this.engineSelect.addEventListener("change", () => {
      cb.onOptionsChange({ engine: this.engineSelect.value as MeshOptions["engine"] });
    });
    // Engine and Preset sit side by side (two columns, label above each select) —
    // both are one-line choices, and stacking them full-width cost a whole screen
    // row each. CSS lays out `.meshing-pair`; the DOM order is engine, then preset.
    const pair = document.createElement("div");
    pair.className = "meshing-pair";
    pair.appendChild(engineSection);
    this.body.appendChild(pair);

    // ── Saved presets (named, reusable option bundles) ──
    // A `<select>` over the merged (user + bundled-starter) library the host
    // posts, plus Apply / Save-current / Delete. Applying writes the preset's
    // options (unit-converted) as the document's settings — never generates.
    // Bundled starters are read-only: runnable, but with the Delete button
    // hidden (the host's `meshPresetDelete` refusal is only the backstop) —
    // the `macrosPanel.ts` precedent.
    const presetSection = document.createElement("div");
    presetSection.className = "meshing-section";
    const presetHeader = document.createElement("div");
    presetHeader.className = "meshing-section-title";
    presetHeader.textContent = "Saved presets";
    presetHeader.title = "Named, reusable meshing options (global settings only — Part sizing stays in the document)";
    presetSection.appendChild(presetHeader);
    const presetForm = document.createElement("div");
    presetForm.className = "meshing-form";
    this.presetSelect = this.select(presetForm, "Preset", []);
    this.presetSelect.id = "meshing-preset-select";
    this.presetSelect.title = "A saved preset — sizes convert from its authored unit on apply; names describe density intent, never a quality guarantee";
    const presetBtnRow = document.createElement("div");
    presetBtnRow.className = "meshing-field meshing-preset-actions";
    this.presetApplyBtn = document.createElement("button");
    this.presetApplyBtn.type = "button";
    this.presetApplyBtn.textContent = "Apply";
    this.presetApplyBtn.title = "Apply the selected preset as the document's meshing options (settings only — nothing is generated)";
    this.presetApplyBtn.addEventListener("click", () => {
      if (this.presetSelect.value) cb.onPresetApply(this.presetSelect.value);
    });
    presetBtnRow.appendChild(this.presetApplyBtn);
    this.presetSaveBtn = document.createElement("button");
    this.presetSaveBtn.type = "button";
    this.presetSaveBtn.textContent = "Save…";
    this.presetSaveBtn.title = "Save the current options as a new preset (prompts for a name)";
    this.presetSaveBtn.addEventListener("click", () => cb.onPresetSaveCurrent());
    presetBtnRow.appendChild(this.presetSaveBtn);
    this.presetDeleteBtn = document.createElement("button");
    this.presetDeleteBtn.type = "button";
    this.presetDeleteBtn.textContent = "Delete";
    this.presetDeleteBtn.title = "Delete the selected preset (bundled starters cannot be deleted)";
    this.presetDeleteBtn.addEventListener("click", () => {
      if (this.presetSelect.value) cb.onPresetDelete(this.presetSelect.value);
    });
    presetBtnRow.appendChild(this.presetDeleteBtn);
    presetForm.appendChild(presetBtnRow);
    presetSection.appendChild(presetForm);
    pair.appendChild(presetSection);
    this.presetSelect.addEventListener("change", () => this.syncPresetButtons());
    // Pre-hydration state (before the host's `meshingPresets` post arrives):
    // an explicit placeholder rather than an empty box, with Apply disabled
    // and Delete hidden — `renderPresets` replaces all of this on arrival.
    const presetPlaceholder = document.createElement("option");
    presetPlaceholder.value = "";
    presetPlaceholder.textContent = "No saved presets";
    this.presetSelect.appendChild(presetPlaceholder);
    this.syncPresetButtons();

    // ── Part sizes (mirrors the Parts panel's per-part size inputs) ──
    this.partsSection = document.createElement("div");
    this.partsSection.className = "meshing-section";
    this.partsSection.id = "meshing-part-sizes";
    this.partsSection.hidden = true;
    const partsHeader = document.createElement("div");
    partsHeader.className = "meshing-section-title";
    partsHeader.textContent = "Part sizes";
    partsHeader.title = "Per-part target element size — blank inherits the global size";
    this.partsSection.appendChild(partsHeader);
    this.partsBody = document.createElement("div");
    this.partsBody.className = "meshing-section-body";
    this.partsSection.appendChild(this.partsBody);
    this.body.appendChild(this.partsSection);

    // ── Advanced settings (collapsed by default) ──
    const advSection = document.createElement("div");
    advSection.className = "meshing-section collapsed";
    const advToggle = document.createElement("button");
    advToggle.className = "meshing-section-header";
    advToggle.type = "button";
    const advChevron = document.createElement("span");
    advChevron.className = "meshing-section-chevron";
    advChevron.textContent = "▸";
    advToggle.appendChild(advChevron);
    advToggle.appendChild(document.createTextNode("Advanced settings"));
    advToggle.addEventListener("click", () => {
      const collapsed = advSection.classList.toggle("collapsed");
      advChevron.textContent = collapsed ? "▸" : "▾";
    });
    advSection.appendChild(advToggle);

    const form = document.createElement("div");
    form.className = "meshing-form meshing-section-body";

    this.dimensionSelect = this.select(form, "Dimension", [
      ["1", "1D"],
      ["2", "2D"],
      ["3", "3D"],
    ]);
    this.dimensionSelect.addEventListener("change", () => {
      cb.onOptionsChange({ dimension: Number(this.dimensionSelect.value) as MeshOptions["dimension"] });
    });

    this.sizeMinInput = this.numberField(form, "Size min", 0);
    this.sizeMinInput.addEventListener("change", () => {
      cb.onOptionsChange({ sizeMin: Number(this.sizeMinInput.value) || 0 });
    });

    this.sizeMaxInput = this.numberField(form, "Size max", 0);
    this.sizeMaxInput.placeholder = "auto";
    this.sizeMaxInput.addEventListener("change", () => {
      const raw = this.sizeMaxInput.value.trim();
      if (raw === "") {
        // Cleared: back to "auto" — the bbox-derived default when the model's
        // extents are known, else the sentinel (re-seeded once they arrive).
        this.commitSizeMax(this.extents ? defaultTargetSize(this.extents.diagonal) : SIZE_MAX_SENTINEL);
        return;
      }
      this.commitSizeMax(Number(raw) || 0);
    });

    this.algorithm2DSelect = this.select(
      form,
      "2D algorithm",
      ALGORITHM_2D.map(([id, name]) => [String(id), `${name} (${id})`])
    );
    this.algorithm2DSelect.addEventListener("change", () => {
      cb.onOptionsChange({ algorithm2D: Number(this.algorithm2DSelect.value) });
    });

    this.algorithm3DSelect = this.select(
      form,
      "3D algorithm",
      ALGORITHM_3D.map(([id, name]) => [String(id), `${name} (${id})`])
    );
    this.algorithm3DSelect.addEventListener("change", () => {
      cb.onOptionsChange({ algorithm3D: Number(this.algorithm3DSelect.value) });
    });

    this.elementShapeSelect = this.select(form, "Element shape", [
      ["simplex", "Triangles / Tetrahedra"],
      ["subdivided", "Quads / Hexahedra"],
      ["hexDominant", "Hex-Dominant (3D)"],
    ]);
    this.elementShapeSelect.title =
      "Quads/Hexahedra recombines the mesh into quadrilaterals (2D) or hexahedra (3D). " +
      "Hex-Dominant (3D only) is a mixed tet/hex mesh via GMSH's RTree recombiner — not exportable to Kratos MDPA.";
    this.elementShapeSelect.addEventListener("change", () => {
      cb.onOptionsChange({ elementShape: this.elementShapeSelect.value as MeshOptions["elementShape"] });
    });

    this.elementOrderSelect = this.select(form, "Element order", [
      ["1", "Linear (1)"],
      ["2", "Quadratic (2)"],
    ]);
    this.elementOrderSelect.addEventListener("change", () => {
      cb.onOptionsChange({ elementOrder: Number(this.elementOrderSelect.value) as MeshOptions["elementOrder"] });
    });

    const optimizeRow = document.createElement("label");
    optimizeRow.className = "meshing-field meshing-checkbox";
    const optimizeLabel = document.createElement("span");
    optimizeLabel.className = "meshing-label";
    optimizeLabel.textContent = "Optimize";
    optimizeRow.appendChild(optimizeLabel);
    this.optimizeCheckbox = document.createElement("input");
    this.optimizeCheckbox.type = "checkbox";
    this.optimizeCheckbox.addEventListener("change", () => {
      cb.onOptionsChange({ optimize: this.optimizeCheckbox.checked });
    });
    optimizeRow.appendChild(this.optimizeCheckbox);
    form.appendChild(optimizeRow);

    this.stlAngleInput = this.numberField(form, "STL angle (°)", 40);
    this.stlAngleInput.title = "Only used by engine: Gmsh (classifySurfaces' angle threshold) — ignored under fTetWild.";
    this.stlAngleInput.addEventListener("change", () => {
      cb.onOptionsChange({ stlAngle: Number(this.stlAngleInput.value) || 0 });
    });

    this.ftetwildEpsRelInput = this.numberField(form, "fTetWild envelope (eps)", DEFAULT_MESH_OPTIONS.ftetwildEpsRel);
    this.ftetwildEpsRelInput.title =
      "fTetWild's envelope size, as a fraction of the model's bounding-box diagonal — smaller stays " +
      "closer to the input surface (slower); only used by engine: fTetWild.";
    this.ftetwildEpsRelInput.step = "0.0001";
    this.ftetwildEpsRelInput.addEventListener("change", () => {
      const raw = Number(this.ftetwildEpsRelInput.value);
      cb.onOptionsChange({ ftetwildEpsRel: raw > 0 ? raw : DEFAULT_MESH_OPTIONS.ftetwildEpsRel });
    });

    this.ftetwildManifoldSurfaceCheckbox = this.checkboxField(form, "fTetWild manifold surface",
      "Force the tetrahedralization's boundary manifold — the repair path's own contract. Only used by engine: fTetWild.");
    this.ftetwildManifoldSurfaceCheckbox.addEventListener("change", () => {
      cb.onOptionsChange({ ftetwildManifoldSurface: this.ftetwildManifoldSurfaceCheckbox.checked });
    });

    this.ftetwildCoarsenCheckbox = this.checkboxField(form, "fTetWild coarsen",
      "Coarsen the output after optimization (fewer, larger tets). Only used by engine: fTetWild.");
    this.ftetwildCoarsenCheckbox.addEventListener("change", () => {
      cb.onOptionsChange({ ftetwildCoarsen: this.ftetwildCoarsenCheckbox.checked });
    });

    this.ftetwildDisableFilteringCheckbox = this.checkboxField(form, "fTetWild no interior filter",
      "Skip interior/exterior filtering and return the raw tetrahedralization — a convex-hull fill, NOT the part " +
      "interior. Inspection only; never what meshing or repair wants. Only used by engine: fTetWild.");
    this.ftetwildDisableFilteringCheckbox.addEventListener("change", () => {
      cb.onOptionsChange({ ftetwildDisableFiltering: this.ftetwildDisableFilteringCheckbox.checked });
    });

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "meshing-reset";
    resetBtn.textContent = "Reset to defaults";
    resetBtn.title = "Restore every meshing option to its default value.";
    resetBtn.addEventListener("click", () => {
      // A full options object passed as a patch resets every field. Re-seed
      // sizeMax from the model's bbox instead of leaving the "unbounded"
      // sentinel, so the slider stays usable right after a reset.
      const patch: MeshOptions = { ...DEFAULT_MESH_OPTIONS };
      if (this.extents) patch.sizeMax = defaultTargetSize(this.extents.diagonal);
      cb.onOptionsChange(patch);
    });
    form.appendChild(resetBtn);

    advSection.appendChild(form);
    this.body.appendChild(advSection);

    // ── Mesh ops (meshio++ sources only — hidden otherwise) ──
    // One declarative operation per Run (clean/decimate/smooth/subdivide/
    // refine/agglomerate/convertCells), mirroring `transform_mesh`'s own op
    // family but as single interactive steps: the host runs it via the same
    // `runMeshioOps` pipeline entry and writes a NEW file (the export model —
    // the source is never modified), reporting per-step applied/skipped.
    this.meshOpsSection = document.createElement("div");
    this.meshOpsSection.className = "meshing-section";
    this.meshOpsSection.id = "meshing-meshops";
    this.meshOpsSection.hidden = true;
    const opsHeader = document.createElement("div");
    opsHeader.className = "meshing-section-title";
    opsHeader.textContent = "Mesh ops";
    opsHeader.title = "Clean, decimate, smooth or convert the imported mesh (meshio++ sources only) — writes a new file";
    this.meshOpsSection.appendChild(opsHeader);
    const opsForm = document.createElement("div");
    opsForm.className = "meshing-form";
    this.meshOpsSelect = this.select(
      opsForm,
      "Operation",
      MESHIO_OP_IDS.map((id) => [id, MESHIO_OP_LABELS[id]])
    );
    this.meshOpsRatio = this.numberField(opsForm, "Keep ratio", 0.5);
    this.meshOpsRatio.title = "Decimate: fraction of faces to KEEP, in (0, 1]";
    this.meshOpsRatio.step = "0.05";
    this.meshOpsRatio.max = "1";
    this.meshOpsMethod = this.select(opsForm, "Method", [
      ["taubin", "Taubin (shrink-free)"],
      ["laplacian", "Laplacian"],
    ]);
    this.meshOpsIterations = this.numberField(opsForm, "Iterations", 1);
    this.meshOpsIterations.min = "1";
    this.meshOpsIterations.step = "1";
    this.meshOpsLevels = this.numberField(opsForm, "Levels", 1);
    this.meshOpsLevels.min = "1";
    this.meshOpsLevels.step = "1";
    this.meshOpsTargetGroupSize = this.numberField(opsForm, "Group size", 4);
    this.meshOpsTargetGroupSize.min = "1";
    this.meshOpsTargetGroupSize.step = "1";
    this.meshOpsMode = this.select(opsForm, "Mode", [
      ["simplexify", "simplexify (quads/hexes → triangles/tets)"],
      ["linearize", "linearize (higher-order → linear)"],
      ["elevate", "elevate (linear → higher-order)"],
    ]);
    const opsRunRow = document.createElement("div");
    opsRunRow.className = "meshing-field";
    this.meshOpsRun = document.createElement("button");
    this.meshOpsRun.type = "button";
    this.meshOpsRun.id = "meshing-ops-run";
    this.meshOpsRun.textContent = "Run op…";
    this.meshOpsRun.title = "Run the selected operation — prompts for a save location for the result";
    this.meshOpsRun.addEventListener("click", () => {
      const op = this.meshOpsSelect.value as MeshioOpId;
      const spec: MeshioOpSpec = { op };
      if (op === "decimate") {
        const ratio = Number(this.meshOpsRatio.value);
        if (!(ratio > 0 && ratio <= 1)) {
          this.renderMeshOpsStatus("Keep ratio must be in (0, 1].", true);
          return;
        }
        spec.ratio = ratio;
      } else if (op === "smooth") {
        spec.method = this.meshOpsMethod.value;
        spec.iterations = Math.max(1, Math.floor(Number(this.meshOpsIterations.value) || 1));
      } else if (op === "refine") {
        spec.levels = Math.max(1, Math.floor(Number(this.meshOpsLevels.value) || 1));
      } else if (op === "agglomerate") {
        spec.targetGroupSize = Math.max(1, Math.floor(Number(this.meshOpsTargetGroupSize.value) || 4));
      } else if (op === "convertCells") {
        spec.mode = this.meshOpsMode.value;
      }
      this.renderMeshOpsStatus("Running…", false);
      this.meshOpsRun.disabled = true;
      cb.onMeshOps([spec]);
    });
    opsRunRow.appendChild(this.meshOpsRun);
    opsForm.appendChild(opsRunRow);
    this.meshOpsStatus = document.createElement("div");
    this.meshOpsStatus.className = "meshing-status";
    this.meshOpsStatus.id = "meshing-ops-status";
    opsForm.appendChild(this.meshOpsStatus);
    this.meshOpsSection.appendChild(opsForm);
    this.body.appendChild(this.meshOpsSection);

    // ── Export row (format · unit · Export) — LAST in the body. It acts on the
    // result of every option above it (Part sizes, Advanced settings), so it
    // closes the panel the way the design mockup has it, rather than sitting
    // between the options and their advanced half. ──
    if (exportRow) this.body.appendChild(exportRow);
    this.meshOpsSelect.addEventListener("change", () => this.syncMeshOpsParams());
    this.syncMeshOpsParams();
  }

  /**
   * Rebuilds the "Saved presets" picker from the host-posted library —
   * called on `ready` hydration and after every preset save/delete (the
   * `renderParts` precedent: full rebuild, host owns the data). Keeps the
   * current selection when it still exists.
   */
  renderPresets(presets: MeshPresetSummary[]): void {
    this.presets = presets;
    const current = this.presetSelect.value;
    this.presetSelect.textContent = "";
    if (presets.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No saved presets";
      this.presetSelect.appendChild(opt);
    }
    for (const p of presets) {
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.readOnly ? `${p.name} (built-in)` : p.name;
      opt.title = `${p.description ?? p.name} — sizes in ${p.unit}, engine ${p.engine}`;
      this.presetSelect.appendChild(opt);
    }
    if (presets.some((p) => p.name === current)) this.presetSelect.value = current;
    this.syncPresetButtons();
  }

  /** Apply/Delete enable only with a real selection; Delete hides entirely
   * for a bundled starter (read-only) rather than disabling in place. */
  private syncPresetButtons(): void {
    const selected = this.presets.find((p) => p.name === this.presetSelect.value);
    this.presetApplyBtn.disabled = !selected;
    this.presetDeleteBtn.disabled = !selected;
    this.presetDeleteBtn.hidden = !selected || selected.readOnly === true;
  }

  /** Rebuilds the form controls to reflect `options`, and the stats/error readout. */
  render(options: MeshOptions, status?: MeshingStats | MeshingError): void {
    this.lastOptions = options;
    this.engineSelect.value = options.engine;
    this.dimensionSelect.value = String(options.dimension);
    this.sizeMinInput.value = String(options.sizeMin);
    // Never display the raw 1e+22 sentinel — show an empty "auto" field until
    // a real (user-set or bbox-seeded) size exists.
    this.sizeMaxInput.value = options.sizeMax === SIZE_MAX_SENTINEL ? "" : String(options.sizeMax);
    this.setSelectValue(this.algorithm2DSelect, options.algorithm2D);
    this.setSelectValue(this.algorithm3DSelect, options.algorithm3D);
    this.elementOrderSelect.value = String(options.elementOrder);
    // Hex-Dominant is 3D-only (gmshShapeOptions degrades it to plain simplex
    // options outside 3D — never invalid, just meaningless — so disabling the
    // option is a UX nicety, not a correctness requirement).
    const hexDominantOpt = this.elementShapeSelect.querySelector<HTMLOptionElement>('option[value="hexDominant"]');
    if (hexDominantOpt) hexDominantOpt.disabled = options.dimension !== 3;
    this.elementShapeSelect.value = options.elementShape;
    this.optimizeCheckbox.checked = options.optimize;
    this.stlAngleInput.value = String(options.stlAngle);
    this.ftetwildEpsRelInput.value = String(options.ftetwildEpsRel);
    this.ftetwildManifoldSurfaceCheckbox.checked = options.ftetwildManifoldSurface;
    this.ftetwildCoarsenCheckbox.checked = options.ftetwildCoarsen;
    this.ftetwildDisableFilteringCheckbox.checked = options.ftetwildDisableFiltering;

    // fTetWild ignores sizeMin/algorithm2D/algorithm3D/elementOrder/
    // elementShape/stlAngle entirely (see gmshService.ts's populateMeshedModel
    // doc comment) — greyed, not hidden, so switching back to Gmsh doesn't
    // need re-entering them. A UX nicety only: `effectiveEngine`'s own
    // downgrade + `validateMeshOptions` already make every combination safe
    // regardless of what this panel currently disables.
    const ftetwild = options.engine === "ftetwild";
    this.sizeMinInput.disabled = ftetwild;
    this.algorithm2DSelect.disabled = ftetwild;
    this.algorithm3DSelect.disabled = ftetwild;
    this.elementOrderSelect.disabled = ftetwild;
    this.elementShapeSelect.disabled = ftetwild;
    this.stlAngleInput.disabled = ftetwild;
    this.ftetwildEpsRelInput.disabled = !ftetwild;
    this.ftetwildManifoldSurfaceCheckbox.disabled = !ftetwild;
    this.ftetwildCoarsenCheckbox.disabled = !ftetwild;
    this.ftetwildDisableFilteringCheckbox.disabled = !ftetwild;

    this.syncSlider();

    this.statusEl.classList.remove("meshing-status-error");
    if (!status) {
      this.statusEl.textContent = "";
      this.renderQuality(undefined, undefined);
    } else if ("error" in status) {
      this.statusEl.textContent = status.error;
      this.statusEl.classList.add("meshing-status-error");
      this.renderQuality(undefined, undefined);
    } else {
      const elapsed = status.elapsedMs != null ? ` · ${formatElapsed(status.elapsedMs)}` : "";
      this.statusEl.textContent = `Nodes: ${status.nodeCount} · Elements: ${status.elementCount}${elapsed}`;
      this.renderQuality(status.quality, status.worstElements);
    }
  }

  /** Renders the per-element quality summary as a min/mean line plus a
   * compact text histogram, plus (when a highlight overlay was built) a line
   * reporting how many worst-quality elements it covers — cleared (no row)
   * when `quality` is `undefined` (nothing generated yet, an error, or a mesh
   * dimension quality couldn't be computed for). Uses `textContent`, not
   * `innerHTML`, for the same defensive-against-injection reason every other
   * panel readout does. The actual on/off toggle for the highlight overlay
   * lives outside this panel, in `main.ts`'s `#meshing-worst-toggle` wiring —
   * same precedent as `#meshing-toggle` itself (a host-driven on/off state
   * that must survive across `render()` calls, unlike this readout text which
   * is rebuilt fresh every time). */
  private renderQuality(
    quality: QualitySummary | undefined,
    worstElements: { threshold: number; shownCount: number; belowThresholdCount: number } | undefined
  ): void {
    this.qualityEl.innerHTML = "";
    if (!quality) return;
    const summary = document.createElement("div");
    summary.className = "meshing-quality-summary";
    summary.textContent = `Quality (minSICN) — min: ${quality.min.toFixed(3)} · mean: ${quality.mean.toFixed(3)}`;
    this.qualityEl.appendChild(summary);

    const total = quality.histogram.reduce((a, b) => a + b, 0);
    const bars = document.createElement("div");
    bars.className = "meshing-quality-histogram";
    quality.histogram.forEach((count, i) => {
      const bar = document.createElement("div");
      bar.className = "meshing-quality-bar";
      const pct = total > 0 ? (count / total) * 100 : 0;
      bar.style.height = `${Math.max(2, pct)}%`;
      bar.title = `[${(i / quality.histogram.length).toFixed(1)}, ${((i + 1) / quality.histogram.length).toFixed(1)}): ${count} element${count === 1 ? "" : "s"}`;
      bars.appendChild(bar);
    });
    this.qualityEl.appendChild(bars);

    if (worstElements) {
      const note = document.createElement("div");
      note.className = "meshing-quality-worst";
      const shown =
        worstElements.shownCount < worstElements.belowThresholdCount
          ? `showing worst ${worstElements.shownCount} of ${worstElements.belowThresholdCount}`
          : `${worstElements.shownCount}`;
      note.textContent = `⚠ ${worstElements.belowThresholdCount} element${worstElements.belowThresholdCount === 1 ? "" : "s"} below quality ${worstElements.threshold.toFixed(2)} (${shown})`;
      this.qualityEl.appendChild(note);
    }
  }

  /**
   * Stores the displayed model's bounding box (from `Viewer.getModelExtents()`)
   * and re-syncs the slider/readout/warning against it. Until extents exist the
   * slider is disabled — the wiring seeds a bbox-derived default size and calls
   * this on every model load.
   */
  setModelExtents(extents: ModelExtents | null): void {
    this.extents = extents;
    this.syncSlider();
  }

  /**
   * Enables/disables the mesh-source-only controls: the STL angle only feeds
   * `classifySurfaces` on the STL reclassification path, so it's disabled (not
   * hidden) for B-rep documents — mirrors `editsPanel.setBRepOnly`.
   */
  setSourceKind(kind: "brep" | "mesh"): void {
    this.stlAngleInput.disabled = kind === "brep";
    this.stlAngleInput.title =
      kind === "brep" ? "Only used for mesh/STL sources" : "Surface-classification angle for mesh/STL sources";
  }

  /**
   * Shows/hides the Mesh-ops section — visible only for a meshio++-imported
   * source (VTK/MED/CGNS/…), never for B-rep or native-mesh documents (those
   * have no meshio++ mesh model to operate on). Called by the wiring on every
   * model load alongside `setSourceKind`.
   */
  setMeshioOpsAvailable(enabled: boolean): void {
    this.meshOpsSection.hidden = !enabled;
    if (!enabled) {
      this.meshOpsRun.disabled = false;
      this.meshOpsStatus.textContent = "";
      this.meshOpsStatus.classList.remove("meshing-status-error");
    }
  }

  /** Shows only the parameter rows the selected operation actually reads. */
  private syncMeshOpsParams(): void {
    const op = this.meshOpsSelect.value as MeshioOpId;
    const show = (el: HTMLElement, visible: boolean): void => {
      (el.closest("label") ?? el).toggleAttribute("hidden", !visible);
    };
    show(this.meshOpsRatio, op === "decimate");
    show(this.meshOpsMethod, op === "smooth");
    show(this.meshOpsIterations, op === "smooth");
    show(this.meshOpsLevels, op === "refine");
    show(this.meshOpsTargetGroupSize, op === "agglomerate");
    show(this.meshOpsMode, op === "convertCells");
  }

  /**
   * Renders the mesh-ops outcome: re-enables Run and shows the kernel's own
   * per-step detail (or the error). Called by the wiring's
   * `meshioOpsResult`/`meshioOpsError` handlers — the save-dialog completion
   * itself already surfaces through the generic status bar.
   */
  renderMeshOpsResult(steps: Array<{ op: string; applied: boolean; detail: string }>, warnings: string[]): void {
    this.meshOpsRun.disabled = false;
    const lines = steps.map((s) => `${s.op}: ${s.applied ? s.detail : `skipped — ${s.detail}`}`);
    for (const w of warnings) lines.push(w);
    this.renderMeshOpsStatus(lines.join(" · ") || "Done.", false);
  }

  renderMeshOpsStatus(text: string, isError: boolean): void {
    this.meshOpsRun.disabled = isError ? false : this.meshOpsRun.disabled;
    if (!isError && text !== "Running…") this.meshOpsRun.disabled = false;
    this.meshOpsStatus.textContent = text;
    this.meshOpsStatus.classList.toggle("meshing-status-error", isError);
  }

  /**
   * Rebuilds the "Part sizes" rows — the same `Part.meshSize` the Parts panel
   * edits, mirrored here so meshing-related sizing lives next to the other
   * meshing controls. Hidden while no parts exist.
   */
  renderParts(parts: Part[]): void {
    this.partsSection.hidden = parts.length === 0;
    this.partsBody.textContent = "";
    parts.forEach((part, index) => {
      const row = document.createElement("div");
      row.className = "meshing-part-row";

      const dot = document.createElement("span");
      dot.className = "meshing-part-dot";
      dot.style.backgroundColor = part.color;
      row.appendChild(dot);

      const name = document.createElement("span");
      name.className = "meshing-part-name";
      name.textContent = part.name;
      name.title = part.name;
      row.appendChild(name);

      const input = document.createElement("input");
      // A text field with a decimal keypad hint (the Edits panel's convention), not
      // `type="number"`: a number input renders its value through the OS locale, so
      // 4.0231 read "4,0231" on a Spanish machine — and it cannot show a rounded
      // value while keeping the exact one. Shown to 3 significant figures like the
      // slider readout; the exact stored value rides along in the tooltip and is
      // only replaced when the user commits an edit (`change` never fires for an
      // untouched field, so display rounding cannot rewrite the sidecar).
      input.type = "text";
      input.inputMode = "decimal";
      input.className = "meshing-num meshing-part-size";
      input.title =
        part.meshSize != null
          ? `Target mesh size for this part: ${part.meshSize} (blank = inherit global)`
          : "Target mesh size for this part (blank = inherit global)";
      input.placeholder = "global";
      input.value = part.meshSize != null ? formatSize(part.meshSize) : "";
      input.addEventListener("change", () => {
        const raw = input.value.trim();
        const n = raw === "" ? undefined : Number(raw);
        this.cb.onPartMeshSize(index, n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined);
      });
      row.appendChild(input);

      const gradeToggle = document.createElement("button");
      gradeToggle.type = "button";
      gradeToggle.className = "meshing-part-grade-toggle";
      gradeToggle.textContent = "Grade";
      gradeToggle.title = "Distance-graded sizing anchored on this part (B-rep sources only)";
      // `.active` is a plain visual indicator that a band is SET, independent
      // of whether the row is currently expanded — the row itself always
      // starts collapsed (below), matching the "Advanced settings" section's
      // own collapsed-by-default convention. `#side` clips overflow rather
      // than scrolling (`overflow: hidden`), so auto-expanding this row for
      // every part that happens to have a band set risks pushing the
      // sidebar's OTHER flex:1 panels (Parts, Edits) past their squeeze
      // point — a real, live-caught layout regression, not a hypothetical.
      gradeToggle.setAttribute("aria-expanded", "false");
      gradeToggle.classList.toggle("active", part.meshGrading != null);
      row.appendChild(gradeToggle);

      this.partsBody.appendChild(row);

      const gradingRow = this.buildPartGradingRow(index, part.meshGrading);
      gradingRow.hidden = true;
      this.partsBody.appendChild(gradingRow);

      gradeToggle.addEventListener("click", () => {
        const nowHidden = !gradingRow.hidden;
        gradingRow.hidden = nowHidden;
        gradeToggle.setAttribute("aria-expanded", String(!nowHidden));
      });
    });
  }

  /**
   * Builds the (initially hidden) grading-band row for one part: four
   * number inputs (wall size / far size / near dist / far dist) plus an
   * inline error line. Committing any field validates the WHOLE band
   * through {@link validateMeshGrading} and only calls back on success;
   * clearing all four fields calls back with `undefined` to remove the
   * band. An invalid band is never forwarded — it shows inline instead,
   * leaving the last-good `meshGrading` (if any) untouched host-side.
   */
  private buildPartGradingRow(index: number, initial: MeshGrading | undefined): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "meshing-part-grading";

    const field = (label: string, title: string, value: number | undefined) => {
      const wrap = document.createElement("label");
      wrap.className = "meshing-part-grading-field";
      const span = document.createElement("span");
      span.textContent = label;
      wrap.appendChild(span);
      const inp = document.createElement("input");
      inp.type = "number";
      inp.className = "meshing-num";
      inp.title = title;
      inp.min = "0";
      inp.step = "any";
      inp.value = value != null ? String(value) : "";
      wrap.appendChild(inp);
      row.appendChild(wrap);
      return inp;
    };

    const wallInput = field("Wall", "Element size at/within the near distance", initial?.sizeAtWall);
    const farInput = field("Far", "Element size at/beyond the far distance", initial?.sizeFar);
    const nearInput = field("Near dist", "Distance kept at the wall size", initial?.distNear);
    const farDistInput = field("Far dist", "Distance where the size reaches the far value", initial?.distFar);

    const error = document.createElement("span");
    error.className = "meshing-part-grading-error";
    row.appendChild(error);

    const commit = () => {
      const raws = [wallInput.value.trim(), farInput.value.trim(), nearInput.value.trim(), farDistInput.value.trim()];
      if (raws.every((r) => r === "")) {
        error.textContent = "";
        this.cb.onPartMeshGrading(index, undefined);
        return;
      }
      const candidate = {
        sizeAtWall: Number(raws[0]),
        sizeFar: Number(raws[1]),
        distNear: Number(raws[2]),
        distFar: Number(raws[3]),
      };
      const valid = validateMeshGrading(candidate);
      if (!valid) {
        error.textContent = "Needs wall > 0, far ≥ wall, near ≥ 0, far dist > near dist.";
        return;
      }
      error.textContent = "";
      this.cb.onPartMeshGrading(index, valid);
    };
    for (const inp of [wallInput, farInput, nearInput, farDistInput]) inp.addEventListener("change", commit);

    return row;
  }

  /**
   * Toggles the busy state for a `Generate` round-trip: disables the button
   * (so a slow WASM call can't be re-triggered while it's already running) and
   * shows the indeterminate `#meshing-progress` bar, since GMSH's `generate()`
   * is a single opaque call with no fractional progress to report.
   */
  setBusy(busy: boolean, requestId?: string, message = "Generating…"): void {
    this.generateBtn.disabled = busy;
    this.exportBtn.disabled = busy;
    this.cancelBtn.disabled = !busy || !requestId;
    if (busy && requestId) this.cancelBtn.dataset.requestId = requestId;
    else delete this.cancelBtn.dataset.requestId;
    this.progressEl.classList.toggle("active", busy);
    if (busy) {
      this.statusEl.classList.remove("meshing-status-error");
      this.statusEl.textContent = message;
    }
  }

  /**
   * Commits a new global target size, guarding pair consistency: if the new
   * `sizeMax` would drop below the current `sizeMin`, reset `sizeMin` to 0 in
   * the same patch — otherwise `validateMeshOptions`' pair rule would silently
   * reset BOTH sizes to defaults on the next sidecar reload.
   */
  private commitSizeMax(sizeMax: number): void {
    const sizeMin = this.lastOptions?.sizeMin ?? 0;
    this.cb.onOptionsChange(sizeMax < sizeMin ? { sizeMax, sizeMin: 0 } : { sizeMax });
  }

  /** Re-positions the slider and refreshes the readout/warning from current state. */
  private syncSlider(): void {
    const options = this.lastOptions;
    const hasSize = options != null && options.sizeMax !== SIZE_MAX_SENTINEL;
    this.sizeSlider.disabled = !this.extents || !hasSize;
    if (this.extents && hasSize) {
      this.sizeSlider.value = String(Math.round(sizeToSlider(options.sizeMax, this.extents.diagonal) * 1000));
    }
    this.refreshSizeReadout(hasSize ? options.sizeMax : null);
    this.markActivePreset(hasSize ? options.sizeMax : null);
  }

  /**
   * Lights the Coarse/Medium/Fine button whose size the current `sizeMax` matches
   * (within 2% — the presets are `diagonal / N`, and a value that went through the
   * slider's 0.1% steps or a round trip through the sidecar will not be bit-equal).
   * A size between presets lights none: a segmented control that always shows one
   * selected would claim a preset the size was never set to.
   */
  private markActivePreset(size: number | null): void {
    for (const { key, el } of this.presetButtons) {
      const target = this.extents ? this.extents.diagonal / PRESET_DIVISORS[key] : NaN;
      const on = size !== null && Number.isFinite(target) && Math.abs(size - target) <= target * 0.02;
      el.classList.toggle("active", on);
      el.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  /** Updates the size + estimated-element-count readout and the large-mesh warning. */
  private refreshSizeReadout(size: number | null): void {
    if (size == null) {
      this.sliderReadout.textContent = "—";
      this.warningEl.hidden = true;
      return;
    }
    if (!this.extents) {
      // Always millimetres — Gmsh's internal cascade unit, regardless of the
      // view-controls Appearance group's display-unit selector (a display-only
      // rescale of Mass Properties/Measurement; mesh-size options are never
      // rescaled, see `src/webview/units.ts`'s doc comment).
      this.sliderReadout.textContent = `${formatSize(size)} mm`;
      this.warningEl.hidden = true;
      return;
    }
    const dimension = this.lastOptions?.dimension ?? 3;
    const shape = this.lastOptions?.elementShape ?? "simplex";
    const estimate = estimateElementCount(this.extents.size, size, dimension, shape);
    this.sliderReadout.textContent = `${formatSize(size)} mm · ${formatCount(estimate)} el`;
    this.sliderReadout.title = `Estimated element count: ${formatCount(estimate)}`;
    if (estimate > LARGE_ELEMENT_COUNT) {
      this.warningEl.innerHTML = `<span class="toolbar-icon">${TOOLBAR_ICONS.warning}</span> Estimated ${formatCount(estimate)} elements — generation may be slow or run out of memory.`;
      this.warningEl.hidden = false;
    } else {
      this.warningEl.hidden = true;
    }
  }

  /**
   * Sets a `<select>`'s value, tolerating values that aren't in the curated
   * option list (e.g. `MeshOptions.algorithm2D`/`algorithm3D` accept any finite
   * GMSH algorithm id per `validateMeshOptions`, but `ALGORITHM_2D`/`ALGORITHM_3D`
   * above only list the well-known ones). Assigning `.value` to a number with no
   * matching `<option>` is a silent no-op in the DOM — the select falls back to
   * displaying whatever option happens to be first, while the real model state
   * still holds the true value. Detect that failed assignment (the standard way:
   * compare `.value` after attempting the set) and, if it happened, append a
   * one-off `<option>` for the exact value before retrying, so the dropdown
   * always displays what's actually selected.
   */
  private setSelectValue(select: HTMLSelectElement, value: number): void {
    const target = String(value);
    select.value = target;
    if (select.value !== target) {
      const opt = document.createElement("option");
      opt.value = target;
      opt.textContent = `Custom (${value})`;
      select.appendChild(opt);
      select.value = target;
    }
  }

  private select(parent: HTMLElement, label: string, options: Array<[string, string]>): HTMLSelectElement {
    const row = document.createElement("label");
    row.className = "meshing-field";
    const span = document.createElement("span");
    span.className = "meshing-label";
    span.textContent = label;
    row.appendChild(span);

    const select = document.createElement("select");
    select.className = "meshing-select";
    for (const [value, text] of options) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      select.appendChild(opt);
    }
    row.appendChild(select);
    parent.appendChild(row);
    return select;
  }

  private numberField(parent: HTMLElement, label: string, def: number): HTMLInputElement {
    const row = document.createElement("label");
    row.className = "meshing-field";
    const span = document.createElement("span");
    span.className = "meshing-label";
    span.textContent = label;
    row.appendChild(span);

    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.min = "0";
    input.className = "meshing-num";
    input.value = String(def);
    row.appendChild(input);
    parent.appendChild(row);
    return input;
  }

  private checkboxField(parent: HTMLElement, label: string, title: string): HTMLInputElement {
    const row = document.createElement("label");
    row.className = "meshing-field meshing-checkbox";
    const span = document.createElement("span");
    span.className = "meshing-label";
    span.textContent = label;
    row.appendChild(span);

    const input = document.createElement("input");
    input.type = "checkbox";
    input.title = title;
    row.appendChild(input);
    parent.appendChild(row);
    return input;
  }
}

/** "850 ms" under a second, else one-decimal seconds ("3.2 s"). */
function formatElapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
