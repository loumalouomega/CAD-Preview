import type { EditOp, Vec3 } from "../editOps";

/** A transform op without its `targets` — the panel collects params; the wiring
 * injects the selected entity ids before pushing it to the op-stack. */
export type TransformDraft =
  | { kind: "translate"; vec: Vec3 }
  | { kind: "rotate"; axisPoint: Vec3; axisDir: Vec3; angleDeg: number }
  | { kind: "scale"; center: Vec3; factors: Vec3 }
  | { kind: "mirror"; planePoint: Vec3; planeNormal: Vec3 };

export type BooleanKind = "union" | "subtract" | "intersect";

/** A feature-modeling op minus its profile/path operands (the wiring supplies those
 * from the selected faces/edges before pushing to the op-stack). */
export type FeatureDraft =
  | { kind: "extrude"; dir: Vec3; length: number }
  | { kind: "revolve"; axisPoint: Vec3; axisDir: Vec3; angleDeg: number }
  | { kind: "sweep" }
  | { kind: "loft" };

/** A primitive-creation draft — self-contained (no selection needed), pushed
 * straight to an `EditOp` by the wiring. */
export type PrimitiveDraft =
  | { kind: "addBox"; center: Vec3; size: Vec3 }
  | { kind: "addSphere"; center: Vec3; radius: number }
  | { kind: "addCylinder"; center: Vec3; axis: Vec3; radius: number; height: number }
  | { kind: "addCone"; center: Vec3; axis: Vec3; radius1: number; radius2: number; height: number }
  | { kind: "addTorus"; center: Vec3; axis: Vec3; majorRadius: number; minorRadius: number }
  | { kind: "addPrism"; center: Vec3; axis: Vec3; radius: number; sides: number; height: number };

/** A 2D profile draft — self-contained (no selection needed), builds a standalone
 * flat face you can later pick (Surf mode) as a profile for Extrude/Revolve/
 * Sweep/Loft. B-rep only (meshes have no sketch/exact topology). */
export type ProfileDraft =
  | { kind: "addCircleProfile"; center: Vec3; normal: Vec3; radius: number }
  | { kind: "addRectangleProfile"; center: Vec3; normal: Vec3; up: Vec3; width: number; height: number }
  | { kind: "addPolygonProfile"; center: Vec3; normal: Vec3; up: Vec3; radius: number; sides: number };

export interface EditsPanelCallbacks {
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  /** Apply a transform to the current selection (the wiring supplies targets). */
  onApplyTransform: (draft: TransformDraft) => void;
  /** Capture the current selection as boolean operand A; returns its size. */
  onCaptureBooleanA: () => number;
  /** Apply a boolean of captured-A against the current selection (operand B). */
  onApplyBoolean: (kind: BooleanKind) => void;
  /** Apply a fillet/chamfer of the given amount to the selected edges (B-rep only). */
  onApplyFillet: (kind: "fillet" | "chamfer", amount: number) => void;
  /** Apply a feature-modeling op; operands come from the selected faces/edges (B-rep only). */
  onApplyFeature: (draft: FeatureDraft) => void;
  /** Explode the assembly: spread bodies radially by `factor` (all formats). */
  onApplyExplode: (factor: number) => void;
  /** Mate: align the first selected face onto the second (B-rep only). */
  onApplyMate: () => void;
  /** Add a new primitive body at the given placement (no selection needed; all formats). */
  onApplyPrimitive: (draft: PrimitiveDraft) => void;
  /** Add a new standalone flat profile face (no selection needed; B-rep only). */
  onApplyProfile: (draft: ProfileDraft) => void;
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
  private featureKind: FeatureDraft["kind"] = "extrude";
  private primitiveKind: PrimitiveDraft["kind"] = "addBox";
  private profileKind: ProfileDraft["kind"] = "addCircleProfile";
  /** B-rep-only sections (fillet/chamfer, feature modeling, 2D profiles); disabled for mesh sources. */
  private brepOnlyEls: HTMLElement[] = [];

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
    this.buildBooleanComposer();
    this.buildFilletComposer();
    this.buildProfileComposer();
    this.buildFeatureComposer();
    this.buildPrimitiveComposer();
    this.buildAssemblyComposer();
  }

  // ── Assembly composer (explode all formats; mate B-rep only) ─────────────

  private buildAssemblyComposer(): void {
    const row = document.createElement("div");
    row.className = "compose-row compose-assembly";

    const label = document.createElement("span");
    label.className = "compose-label";
    label.textContent = "Explode";
    row.appendChild(label);

    const factor = document.createElement("input");
    factor.type = "number";
    factor.step = "any";
    factor.min = "0";
    factor.className = "compose-num";
    factor.value = "1";
    factor.title = "Spread factor (0 = none)";
    row.appendChild(factor);

    const explode = document.createElement("button");
    explode.className = "compose-apply";
    explode.textContent = "Apply";
    explode.title = "Spread the bodies radially from the model centre";
    explode.addEventListener("click", () => this.cb.onApplyExplode(Number(factor.value) || 0));
    row.appendChild(explode);
    this.compose.appendChild(row);

    const mateRow = document.createElement("div");
    mateRow.className = "compose-row compose-mate";
    const mateLabel = document.createElement("span");
    mateLabel.className = "compose-label";
    mateLabel.textContent = "Mate";
    mateRow.appendChild(mateLabel);
    const mateHint = document.createElement("span");
    mateHint.className = "compose-hint";
    mateHint.textContent = "Select face A then B";
    mateRow.appendChild(mateHint);
    const mate = document.createElement("button");
    mate.className = "compose-apply";
    mate.textContent = "Apply";
    mate.title = "Align the first selected face onto the second";
    mate.addEventListener("click", () => this.cb.onApplyMate());
    mateRow.appendChild(mate);
    this.compose.appendChild(mateRow);
    this.brepOnlyEls.push(mateRow);
  }

  /** Enables/disables the B-rep-only sections (fillet/chamfer) for mesh sources. */
  setBRepOnly(enabled: boolean): void {
    for (const el of this.brepOnlyEls) {
      el.classList.toggle("disabled", !enabled);
      el.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
        "button, input, select"
      ).forEach((c) => { c.disabled = !enabled; });
    }
  }

  // ── Fillet / chamfer composer (selected edges, B-rep only) ───────────────

  private buildFilletComposer(): void {
    const row = document.createElement("div");
    row.className = "compose-row compose-feature";

    const select = document.createElement("select");
    select.className = "compose-kind";
    for (const [value, text] of [["fillet", "Fillet"], ["chamfer", "Chamfer"]] as const) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      select.appendChild(opt);
    }
    row.appendChild(select);

    const amount = document.createElement("input");
    amount.type = "number";
    amount.step = "any";
    amount.min = "0";
    amount.className = "compose-num";
    amount.value = "1";
    amount.title = "Fillet radius / chamfer setback";
    row.appendChild(amount);

    const apply = document.createElement("button");
    apply.className = "compose-apply";
    apply.textContent = "Apply";
    apply.title = "Apply to the selected edges (Line mode)";
    apply.addEventListener("click", () => {
      this.cb.onApplyFillet(select.value as "fillet" | "chamfer", Number(amount.value) || 0);
    });
    row.appendChild(apply);

    this.compose.appendChild(row);
    this.brepOnlyEls.push(row);
  }

  // ── 2D profile composer (no selection needed — self-contained; B-rep only) ─

  private buildProfileComposer(): void {
    const wrap = document.createElement("div");
    wrap.className = "compose-profile";

    const kindRow = document.createElement("div");
    kindRow.className = "compose-row";
    const select = document.createElement("select");
    select.className = "compose-kind";
    for (const [value, text] of [
      ["addCircleProfile", "Circle"], ["addRectangleProfile", "Rectangle"], ["addPolygonProfile", "Polygon"],
    ] as const) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      this.profileKind = select.value as ProfileDraft["kind"];
      this.renderProfileFields();
    });
    kindRow.appendChild(select);

    const apply = document.createElement("button");
    apply.className = "compose-apply";
    apply.textContent = "Sketch";
    apply.title = "Add a new flat profile face at this placement (pick it later in Surf mode as an Extrude/Revolve/Sweep/Loft profile)";
    apply.addEventListener("click", () => this.emitProfile());
    kindRow.appendChild(apply);

    const fields = document.createElement("div");
    fields.className = "compose-fields";
    fields.id = "profile-fields";

    wrap.appendChild(kindRow);
    wrap.appendChild(fields);
    this.compose.appendChild(wrap);
    this.brepOnlyEls.push(wrap);
    this.renderProfileFields();
  }

  private profileFields(): HTMLElement {
    return this.compose.querySelector("#profile-fields")!;
  }

  private renderProfileFields(): void {
    const f = this.profileFields();
    f.innerHTML = "";
    switch (this.profileKind) {
      case "addCircleProfile":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("normal", "Normal", [0, 0, 1]));
        f.appendChild(this.numField("radius", "Radius", 5));
        break;
      case "addRectangleProfile":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("normal", "Normal", [0, 0, 1]));
        f.appendChild(this.vecField("up", "Up", [1, 0, 0]));
        f.appendChild(this.numField("width", "Width", 10));
        f.appendChild(this.numField("height", "Height", 6));
        break;
      case "addPolygonProfile":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("normal", "Normal", [0, 0, 1]));
        f.appendChild(this.vecField("up", "Up", [1, 0, 0]));
        f.appendChild(this.numField("radius", "Radius", 5));
        f.appendChild(this.numField("sides", "Sides", 6));
        break;
    }
  }

  private emitProfile(): void {
    const f = this.profileFields();
    let draft: ProfileDraft;
    switch (this.profileKind) {
      case "addCircleProfile":
        draft = {
          kind: "addCircleProfile", center: this.readVec("center", f),
          normal: this.readVec("normal", f), radius: this.readNum("radius", f),
        };
        break;
      case "addRectangleProfile":
        draft = {
          kind: "addRectangleProfile", center: this.readVec("center", f), normal: this.readVec("normal", f),
          up: this.readVec("up", f), width: this.readNum("width", f), height: this.readNum("height", f),
        };
        break;
      case "addPolygonProfile":
        draft = {
          kind: "addPolygonProfile", center: this.readVec("center", f), normal: this.readVec("normal", f),
          up: this.readVec("up", f), radius: this.readNum("radius", f), sides: this.readNum("sides", f),
        };
        break;
    }
    this.cb.onApplyProfile(draft);
  }

  // ── Feature-modeling composer (selected faces/edges, B-rep only) ─────────

  private buildFeatureComposer(): void {
    const wrap = document.createElement("div");
    wrap.className = "compose-feature";

    const kindRow = document.createElement("div");
    kindRow.className = "compose-row";
    const select = document.createElement("select");
    select.className = "compose-kind";
    for (const [value, text] of [
      ["extrude", "Extrude"], ["revolve", "Revolve"], ["sweep", "Sweep"], ["loft", "Loft"],
    ] as const) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      this.featureKind = select.value as FeatureDraft["kind"];
      this.renderFeatureFields();
    });
    kindRow.appendChild(select);

    const apply = document.createElement("button");
    apply.className = "compose-apply";
    apply.textContent = "Apply";
    apply.title = "Build the feature from the selected face(s) / edge";
    apply.addEventListener("click", () => this.emitFeature());
    kindRow.appendChild(apply);

    const fields = document.createElement("div");
    fields.className = "compose-fields";
    fields.id = "feature-fields";

    wrap.appendChild(kindRow);
    wrap.appendChild(fields);
    this.compose.appendChild(wrap);
    this.brepOnlyEls.push(wrap);
    this.renderFeatureFields();
  }

  private featureFields(): HTMLElement {
    return this.compose.querySelector("#feature-fields")!;
  }

  private renderFeatureFields(): void {
    const f = this.featureFields();
    f.innerHTML = "";
    switch (this.featureKind) {
      case "extrude":
        f.appendChild(this.vecField("dir", "Dir", [0, 0, 1]));
        f.appendChild(this.numField("length", "Length", 10));
        break;
      case "revolve":
        f.appendChild(this.vecField("axisPoint", "Point", [0, 0, 0]));
        f.appendChild(this.vecField("axisDir", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("angleDeg", "Angle°", 360));
        break;
      case "sweep":
        f.appendChild(featureHint("Profile = selected face · path = selected edge"));
        break;
      case "loft":
        f.appendChild(featureHint("Profiles = 2+ selected faces"));
        break;
    }
  }

  private emitFeature(): void {
    const f = this.featureFields();
    let draft: FeatureDraft;
    switch (this.featureKind) {
      case "extrude":
        draft = { kind: "extrude", dir: this.readVec("dir", f), length: this.readNum("length", f) };
        break;
      case "revolve":
        draft = {
          kind: "revolve", axisPoint: this.readVec("axisPoint", f),
          axisDir: this.readVec("axisDir", f), angleDeg: this.readNum("angleDeg", f),
        };
        break;
      case "sweep": draft = { kind: "sweep" }; break;
      case "loft": draft = { kind: "loft" }; break;
    }
    this.cb.onApplyFeature(draft);
  }

  // ── Primitive composer (no selection needed — self-contained placement) ──

  private buildPrimitiveComposer(): void {
    const wrap = document.createElement("div");
    wrap.className = "compose-primitive";

    const kindRow = document.createElement("div");
    kindRow.className = "compose-row";
    const select = document.createElement("select");
    select.className = "compose-kind";
    for (const [value, text] of [
      ["addBox", "Box"], ["addSphere", "Sphere"], ["addCylinder", "Cylinder"],
      ["addCone", "Cone"], ["addTorus", "Torus"], ["addPrism", "Prism"],
    ] as const) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      this.primitiveKind = select.value as PrimitiveDraft["kind"];
      this.renderPrimitiveFields();
    });
    kindRow.appendChild(select);

    const apply = document.createElement("button");
    apply.className = "compose-apply";
    apply.textContent = "Add";
    apply.title = "Add a new primitive body at this placement (no selection needed)";
    apply.addEventListener("click", () => this.emitPrimitive());
    kindRow.appendChild(apply);

    const fields = document.createElement("div");
    fields.className = "compose-fields";
    fields.id = "primitive-fields";

    wrap.appendChild(kindRow);
    wrap.appendChild(fields);
    this.compose.appendChild(wrap);
    // Deliberately NOT pushed into brepOnlyEls — primitives work on every format.
    this.renderPrimitiveFields();
  }

  private primitiveFields(): HTMLElement {
    return this.compose.querySelector("#primitive-fields")!;
  }

  private renderPrimitiveFields(): void {
    const f = this.primitiveFields();
    f.innerHTML = "";
    switch (this.primitiveKind) {
      case "addBox":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("size", "Size", [10, 10, 10]));
        break;
      case "addSphere":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.numField("radius", "Radius", 5));
        break;
      case "addCylinder":
        f.appendChild(this.vecField("center", "Base", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("radius", "Radius", 5));
        f.appendChild(this.numField("height", "Height", 10));
        break;
      case "addCone":
        f.appendChild(this.vecField("center", "Base", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("radius1", "Base r", 5));
        f.appendChild(this.numField("radius2", "Top r", 0));
        f.appendChild(this.numField("height", "Height", 10));
        break;
      case "addTorus":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("majorRadius", "Major r", 10));
        f.appendChild(this.numField("minorRadius", "Minor r", 2));
        break;
      case "addPrism":
        f.appendChild(this.vecField("center", "Base", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("radius", "Radius", 5));
        f.appendChild(this.numField("sides", "Sides", 6));
        f.appendChild(this.numField("height", "Height", 10));
        break;
    }
  }

  private emitPrimitive(): void {
    const f = this.primitiveFields();
    let draft: PrimitiveDraft;
    switch (this.primitiveKind) {
      case "addBox":
        draft = { kind: "addBox", center: this.readVec("center", f), size: this.readVec("size", f) };
        break;
      case "addSphere":
        draft = { kind: "addSphere", center: this.readVec("center", f), radius: this.readNum("radius", f) };
        break;
      case "addCylinder":
        draft = {
          kind: "addCylinder", center: this.readVec("center", f), axis: this.readVec("axis", f),
          radius: this.readNum("radius", f), height: this.readNum("height", f),
        };
        break;
      case "addCone":
        draft = {
          kind: "addCone", center: this.readVec("center", f), axis: this.readVec("axis", f),
          radius1: this.readNum("radius1", f), radius2: this.readNum("radius2", f), height: this.readNum("height", f),
        };
        break;
      case "addTorus":
        draft = {
          kind: "addTorus", center: this.readVec("center", f), axis: this.readVec("axis", f),
          majorRadius: this.readNum("majorRadius", f), minorRadius: this.readNum("minorRadius", f),
        };
        break;
      case "addPrism":
        draft = {
          kind: "addPrism", center: this.readVec("center", f), axis: this.readVec("axis", f),
          radius: this.readNum("radius", f), sides: this.readNum("sides", f), height: this.readNum("height", f),
        };
        break;
    }
    this.cb.onApplyPrimitive(draft);
  }

  // ── Boolean composer (operand A captured, B = live selection) ────────────

  private buildBooleanComposer(): void {
    const row = document.createElement("div");
    row.className = "compose-row compose-bool";

    const select = document.createElement("select");
    select.className = "compose-kind";
    for (const [value, text] of [
      ["union", "Unite"], ["subtract", "Subtract"], ["intersect", "Intersect"],
    ] as const) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      select.appendChild(opt);
    }
    row.appendChild(select);

    const status = document.createElement("span");
    status.className = "compose-bool-a";
    status.textContent = "A: —";

    const setA = document.createElement("button");
    setA.className = "compose-apply";
    setA.textContent = "Set A";
    setA.title = "Capture the selected volumes as boolean operand A";
    setA.addEventListener("click", () => {
      const n = this.cb.onCaptureBooleanA();
      status.textContent = n > 0 ? `A: ${n}` : "A: —";
    });
    row.appendChild(setA);

    const apply = document.createElement("button");
    apply.className = "compose-apply";
    apply.textContent = "Apply";
    apply.title = "Apply the boolean: captured A against the current selection (B)";
    apply.addEventListener("click", () => {
      this.cb.onApplyBoolean(select.value as BooleanKind);
      status.textContent = "A: —";
    });
    row.appendChild(apply);

    this.compose.appendChild(row);
    this.compose.appendChild(status);
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

  private readVec(name: string, scope: HTMLElement = this.fields()): Vec3 {
    const inputs = scope.querySelectorAll<HTMLInputElement>(`input[data-name="${name}"]`);
    const v: number[] = [0, 0, 0];
    inputs.forEach((inp) => { v[Number(inp.dataset.i)] = Number(inp.value) || 0; });
    return [v[0], v[1], v[2]];
  }

  private readNum(name: string, scope: HTMLElement = this.fields()): number {
    const inp = scope.querySelector<HTMLInputElement>(`input[data-name="${name}"]`);
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

/** A small grey hint line for composers that take their operands from the selection. */
function featureHint(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "compose-hint";
  el.textContent = text;
  return el;
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
    case "addBox": return `+ Box ${op.size.join("×")}`;
    case "addSphere": return `+ Sphere r=${op.radius}`;
    case "addCylinder": return `+ Cylinder r=${op.radius} h=${op.height}`;
    case "addCone": return `+ Cone r1=${op.radius1} r2=${op.radius2} h=${op.height}`;
    case "addTorus": return `+ Torus R=${op.majorRadius} r=${op.minorRadius}`;
    case "addPrism": return `+ ${op.sides}-gon Prism r=${op.radius} h=${op.height}`;
    case "addCircleProfile": return `⌗ Circle sketch r=${op.radius}`;
    case "addRectangleProfile": return `⌗ Rectangle sketch ${op.width}×${op.height}`;
    case "addPolygonProfile": return `⌗ ${op.sides}-gon sketch r=${op.radius}`;
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
