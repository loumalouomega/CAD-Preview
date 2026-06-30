import type { EditOp, Vec3 } from "../editOps";

/** A transform op without its `targets` — the panel collects params; the wiring
 * injects the selected entity ids before pushing it to the op-stack. */
export type TransformDraft =
  | { kind: "translate"; vec: Vec3 }
  | { kind: "rotate"; axisPoint: Vec3; axisDir: Vec3; angleDeg: number }
  | { kind: "scale"; center: Vec3; factors: Vec3 }
  | { kind: "mirror"; planePoint: Vec3; planeNormal: Vec3 };

export interface EditsPanelCallbacks {
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  /** Apply a transform to the current selection (the wiring supplies targets). */
  onApplyTransform: (draft: TransformDraft) => void;
}

/**
 * Renders the replayable edit op-stack: a transform composer (M1), an
 * Undo/Redo/Clear control row, and the ordered list of applied ops with a short
 * human summary each. Op-creation forms are added per milestone; the composer
 * here covers translate/rotate/scale/mirror. Numeric inputs are used throughout
 * (VS Code webviews block `prompt()`).
 */
export class EditsPanel {
  private readonly body: HTMLElement;
  private readonly compose: HTMLElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;
  private readonly clearBtn: HTMLButtonElement;
  private kind: TransformDraft["kind"] = "translate";

  constructor(
    private readonly panel: HTMLElement,
    private readonly cb: EditsPanelCallbacks
  ) {
    this.body = panel.querySelector("#edits-body")!;
    this.compose = panel.querySelector("#edits-compose")!;
    this.undoBtn = panel.querySelector("#edits-undo")!;
    this.redoBtn = panel.querySelector("#edits-redo")!;
    this.clearBtn = panel.querySelector("#edits-clear")!;
    this.undoBtn.addEventListener("click", () => cb.onUndo());
    this.redoBtn.addEventListener("click", () => cb.onRedo());
    this.clearBtn.addEventListener("click", () => cb.onClear());
    this.buildComposer();
  }

  render(ops: EditOp[], canUndo: boolean, canRedo: boolean): void {
    this.undoBtn.disabled = !canUndo;
    this.redoBtn.disabled = !canRedo;
    this.clearBtn.disabled = ops.length === 0;

    this.body.innerHTML = "";
    if (ops.length === 0) {
      const empty = document.createElement("div");
      empty.className = "edits-empty";
      empty.textContent = "No edits — the source file is shown unchanged.";
      this.body.appendChild(empty);
      return;
    }

    const ol = document.createElement("ol");
    ol.className = "edits-list";
    ops.forEach((op, i) => {
      const li = document.createElement("li");
      li.className = "edit-row";
      const idx = document.createElement("span");
      idx.className = "edit-index";
      idx.textContent = `${i + 1}.`;
      const label = document.createElement("span");
      label.className = "edit-label";
      label.textContent = describeOp(op);
      li.appendChild(idx);
      li.appendChild(label);
      ol.appendChild(li);
    });
    this.body.appendChild(ol);
  }

  // ── Transform composer ──────────────────────────────────────────────────

  private buildComposer(): void {
    const kindRow = document.createElement("div");
    kindRow.className = "compose-row";
    const select = document.createElement("select");
    select.className = "compose-kind";
    for (const [value, text] of [
      ["translate", "Move"], ["rotate", "Rotate"], ["scale", "Scale"], ["mirror", "Mirror"],
    ] as const) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      this.kind = select.value as TransformDraft["kind"];
      this.renderFields();
    });
    kindRow.appendChild(select);

    const apply = document.createElement("button");
    apply.className = "compose-apply";
    apply.textContent = "Apply";
    apply.title = "Apply to the selected volumes";
    apply.addEventListener("click", () => this.emit());
    kindRow.appendChild(apply);

    const fields = document.createElement("div");
    fields.className = "compose-fields";
    fields.id = "compose-fields";

    this.compose.appendChild(kindRow);
    this.compose.appendChild(fields);
    this.renderFields();
  }

  private fields(): HTMLElement {
    return this.compose.querySelector("#compose-fields")!;
  }

  private renderFields(): void {
    const f = this.fields();
    f.innerHTML = "";
    switch (this.kind) {
      case "translate":
        f.appendChild(this.vecField("vec", "Δ", [0, 0, 0]));
        break;
      case "rotate":
        f.appendChild(this.vecField("axisPoint", "Point", [0, 0, 0]));
        f.appendChild(this.vecField("axisDir", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("angleDeg", "Angle°", 90));
        break;
      case "scale":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("factors", "Scale", [1, 1, 1]));
        break;
      case "mirror":
        f.appendChild(this.vecField("planePoint", "Point", [0, 0, 0]));
        f.appendChild(this.vecField("planeNormal", "Normal", [1, 0, 0]));
        break;
    }
  }

  private vecField(name: string, label: string, def: Vec3): HTMLElement {
    const row = document.createElement("label");
    row.className = "compose-field";
    const span = document.createElement("span");
    span.className = "compose-label";
    span.textContent = label;
    row.appendChild(span);
    for (let i = 0; i < 3; i++) {
      const input = document.createElement("input");
      input.type = "number";
      input.step = "any";
      input.className = "compose-num";
      input.dataset.name = name;
      input.dataset.i = String(i);
      input.value = String(def[i]);
      row.appendChild(input);
    }
    return row;
  }

  private numField(name: string, label: string, def: number): HTMLElement {
    const row = document.createElement("label");
    row.className = "compose-field";
    const span = document.createElement("span");
    span.className = "compose-label";
    span.textContent = label;
    row.appendChild(span);
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.className = "compose-num";
    input.dataset.name = name;
    input.value = String(def);
    row.appendChild(input);
    return row;
  }

  private readVec(name: string): Vec3 {
    const inputs = this.fields().querySelectorAll<HTMLInputElement>(`input[data-name="${name}"]`);
    const v: number[] = [0, 0, 0];
    inputs.forEach((inp) => { v[Number(inp.dataset.i)] = Number(inp.value) || 0; });
    return [v[0], v[1], v[2]];
  }

  private readNum(name: string): number {
    const inp = this.fields().querySelector<HTMLInputElement>(`input[data-name="${name}"]`);
    return inp ? Number(inp.value) || 0 : 0;
  }

  private emit(): void {
    let draft: TransformDraft;
    switch (this.kind) {
      case "translate": draft = { kind: "translate", vec: this.readVec("vec") }; break;
      case "rotate": draft = {
        kind: "rotate", axisPoint: this.readVec("axisPoint"),
        axisDir: this.readVec("axisDir"), angleDeg: this.readNum("angleDeg"),
      }; break;
      case "scale": draft = {
        kind: "scale", center: this.readVec("center"), factors: this.readVec("factors"),
      }; break;
      case "mirror": draft = {
        kind: "mirror", planePoint: this.readVec("planePoint"), planeNormal: this.readVec("planeNormal"),
      }; break;
    }
    this.cb.onApplyTransform(draft);
  }
}

/** A short, human-readable one-line summary of an op for the panel list. */
export function describeOp(op: EditOp): string {
  switch (op.op) {
    case "translate": return `Move ${op.targets.length} (${op.vec.join(", ")})`;
    case "rotate": return `Rotate ${op.targets.length} ${op.angleDeg}°`;
    case "scale": return `Scale ${op.targets.length} (${op.factors.join(", ")})`;
    case "mirror": return `Mirror ${op.targets.length}`;
    case "boolean": return `${cap(op.kind)} ${op.a.length}↔${op.b.length}`;
    case "fillet": return `Fillet ${op.edges.length} r=${op.radius}`;
    case "chamfer": return `Chamfer ${op.edges.length} d=${op.distance}`;
    case "extrude": return `Extrude ${op.profile} ×${op.length}`;
    case "revolve": return `Revolve ${op.profile} ${op.angleDeg}°`;
    case "sweep": return `Sweep ${op.profile} → ${op.path}`;
    case "loft": return `Loft ${op.profiles.length} profiles`;
    case "explode": return `Explode ×${op.factor}`;
    case "mate": return `Mate ${op.faceA} → ${op.faceB}`;
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
