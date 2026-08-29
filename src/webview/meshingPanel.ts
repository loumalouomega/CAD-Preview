import { SIZE_MAX_SENTINEL, DEFAULT_MESH_OPTIONS, type MeshOptions } from "../meshOptions";
import type { QualitySummary } from "../meshQuality";
import { TOOLBAR_ICONS } from "../toolbarIcons";
import { MESH_EXPORT_FORMATS, type MeshExportFormatId } from "../meshExportFormats";
import { DISPLAY_UNITS, UNIT_LABELS, type DisplayUnit } from "../lengthUnits";
import type { Part } from "../protocol";
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
  onGenerate: () => void;
  /** Export in the format/unit currently picked in the two `<select>`s. `unit`
   * is a real geometric scale applied before Gmsh ever sees the geometry
   * (mirroring the model Export command's own unit conversion) — "mm" is
   * native/no-op. */
  onExport: (format: MeshExportFormatId, unit: DisplayUnit) => void;
  onClear: () => void;
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
  private readonly exportFormatSelect: HTMLSelectElement;
  private readonly exportUnitSelect: HTMLSelectElement;
  private readonly exportBtn: HTMLButtonElement;
  private readonly clearBtn: HTMLButtonElement;

  private readonly warningEl: HTMLElement;
  private readonly sizeSlider: HTMLInputElement;
  private readonly sliderReadout: HTMLElement;
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
    this.exportFormatSelect = panel.querySelector("#meshing-export-format")!;
    this.exportUnitSelect = panel.querySelector("#meshing-export-unit")!;
    this.exportBtn = panel.querySelector("#meshing-export")!;
    this.clearBtn = panel.querySelector("#meshing-clear")!;

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

    this.sliderReadout = document.createElement("div");
    this.sliderReadout.className = "meshing-slider-readout";
    this.sliderReadout.textContent = "—";
    sizeSection.appendChild(this.sliderReadout);

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
    this.body.appendChild(engineSection);

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
      input.type = "number";
      input.className = "meshing-num meshing-part-size";
      input.title = "Target mesh size for this part (blank = inherit global)";
      input.placeholder = "global";
      input.min = "0";
      input.step = "any";
      input.value = part.meshSize != null ? String(part.meshSize) : "";
      input.addEventListener("change", () => {
        const raw = input.value.trim();
        const n = raw === "" ? undefined : Number(raw);
        this.cb.onPartMeshSize(index, n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined);
      });
      row.appendChild(input);

      this.partsBody.appendChild(row);
    });
  }

  /**
   * Toggles the busy state for a `Generate` round-trip: disables the button
   * (so a slow WASM call can't be re-triggered while it's already running) and
   * shows the indeterminate `#meshing-progress` bar, since GMSH's `generate()`
   * is a single opaque call with no fractional progress to report.
   */
  setBusy(busy: boolean): void {
    this.generateBtn.disabled = busy;
    this.progressEl.classList.toggle("active", busy);
    if (busy) {
      this.statusEl.classList.remove("meshing-status-error");
      this.statusEl.textContent = "Generating…";
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
      this.sliderReadout.textContent = `Size: ${formatSize(size)} mm`;
      this.warningEl.hidden = true;
      return;
    }
    const dimension = this.lastOptions?.dimension ?? 3;
    const shape = this.lastOptions?.elementShape ?? "simplex";
    const estimate = estimateElementCount(this.extents.size, size, dimension, shape);
    this.sliderReadout.textContent = `Size: ${formatSize(size)} mm · ${formatCount(estimate)} elements`;
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
}

/** "850 ms" under a second, else one-decimal seconds ("3.2 s"). */
function formatElapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
