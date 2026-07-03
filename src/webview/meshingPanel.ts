import type { MeshOptions } from "../meshOptions";
import { MESH_EXPORT_FORMATS, type MeshExportFormatId } from "../meshExportFormats";

/** Success readout: the generated mesh's element counts. */
export interface MeshingStats {
  nodeCount: number;
  elementCount: number;
}

/** Failure readout: a human-readable error message from the host. */
export interface MeshingError {
  error: string;
}

export interface MeshingPanelCallbacks {
  /** A form control changed; the wiring merges the patch into the model and re-generates/persists. */
  onOptionsChange: (patch: Partial<MeshOptions>) => void;
  onGenerate: () => void;
  /** Export in the format currently picked in the format `<select>`. */
  onExport: (format: MeshExportFormatId) => void;
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
 * Renders the meshing options form (dimension, element size, algorithm choice,
 * element order, optimize) plus Generate/Export-format-`<select>`+Export/Clear
 * controls and a stats/error readout. The export format picker is a single
 * `<select>` populated from `MESH_EXPORT_FORMATS` (`meshExportFormats.ts`)
 * rather than one button per format — that list only grows over time, and a
 * dedicated button per Gmsh output format doesn't scale in a sidebar panel.
 * DOM-only — no business logic, no `prompt()`/`alert()` (VS Code webviews
 * block them; see `partsPanel.ts` for the established inline-`<input>`
 * convention this codebase uses instead).
 */
export class MeshingPanel {
  private readonly body: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly progressEl: HTMLElement;
  private readonly generateBtn: HTMLButtonElement;
  private readonly exportFormatSelect: HTMLSelectElement;
  private readonly exportBtn: HTMLButtonElement;
  private readonly clearBtn: HTMLButtonElement;

  private readonly dimensionSelect: HTMLSelectElement;
  private readonly sizeMinInput: HTMLInputElement;
  private readonly sizeMaxInput: HTMLInputElement;
  private readonly algorithm2DSelect: HTMLSelectElement;
  private readonly algorithm3DSelect: HTMLSelectElement;
  private readonly elementOrderSelect: HTMLSelectElement;
  private readonly optimizeCheckbox: HTMLInputElement;

  constructor(
    private readonly panel: HTMLElement,
    private readonly cb: MeshingPanelCallbacks
  ) {
    this.body = panel.querySelector("#meshing-body")!;
    this.statusEl = panel.querySelector("#meshing-status")!;
    this.progressEl = panel.querySelector("#meshing-progress")!;
    this.generateBtn = panel.querySelector("#meshing-generate")!;
    this.exportFormatSelect = panel.querySelector("#meshing-export-format")!;
    this.exportBtn = panel.querySelector("#meshing-export")!;
    this.clearBtn = panel.querySelector("#meshing-clear")!;

    for (const format of MESH_EXPORT_FORMATS) {
      const opt = document.createElement("option");
      opt.value = format.id;
      opt.textContent = format.label;
      this.exportFormatSelect.appendChild(opt);
    }

    this.generateBtn.addEventListener("click", () => cb.onGenerate());
    this.exportBtn.addEventListener("click", () => cb.onExport(this.exportFormatSelect.value as MeshExportFormatId));
    this.clearBtn.addEventListener("click", () => cb.onClear());

    const form = document.createElement("div");
    form.className = "meshing-form";

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
    this.sizeMaxInput.addEventListener("change", () => {
      cb.onOptionsChange({ sizeMax: Number(this.sizeMaxInput.value) || 0 });
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

    this.body.appendChild(form);
  }

  /** Rebuilds the form controls to reflect `options`, and the stats/error readout. */
  render(options: MeshOptions, status?: MeshingStats | MeshingError): void {
    this.dimensionSelect.value = String(options.dimension);
    this.sizeMinInput.value = String(options.sizeMin);
    this.sizeMaxInput.value = String(options.sizeMax);
    this.setSelectValue(this.algorithm2DSelect, options.algorithm2D);
    this.setSelectValue(this.algorithm3DSelect, options.algorithm3D);
    this.elementOrderSelect.value = String(options.elementOrder);
    this.optimizeCheckbox.checked = options.optimize;

    this.statusEl.classList.remove("meshing-status-error");
    if (!status) {
      this.statusEl.textContent = "";
    } else if ("error" in status) {
      this.statusEl.textContent = status.error;
      this.statusEl.classList.add("meshing-status-error");
    } else {
      this.statusEl.textContent = `Nodes: ${status.nodeCount} · Elements: ${status.elementCount}`;
    }
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
