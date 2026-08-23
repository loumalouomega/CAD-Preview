import type { EditOp, ExprMap, Vec3, OpOutcome } from "../editOps";
import { evalExpr } from "../paramExpr";
import { OP_CATALOG, describeOp, type CatalogCategory, type PanelOpId } from "./opCatalog";
import { OP_ICONS } from "./opIcons";
import { TOOLBAR_ICONS } from "../toolbarIcons";

// Re-exported for compatibility — `describeOp` now lives in the pure, headless-
// testable opCatalog module.
export { describeOp };

/** A transform op without its `targets` — the panel collects params; the wiring
 * injects the selected entity ids before pushing it to the op-stack.
 *
 * Every draft may carry an `exprs` annotation (field path → expression string)
 * for numeric fields the user typed as expressions over the document's
 * variables — the panel evaluates them for the numeric values and the wiring
 * copies `exprs` onto the pushed op so the binding survives. */
export type TransformDraft = (
  | { kind: "translate"; vec: Vec3 }
  | { kind: "rotate"; axisPoint: Vec3; axisDir: Vec3; angleDeg: number }
  | { kind: "scale"; center: Vec3; factors: Vec3 }
  | { kind: "mirror"; planePoint: Vec3; planeNormal: Vec3 }
) & { exprs?: ExprMap };

export type BooleanKind = "union" | "subtract" | "intersect";

/** A feature-modeling op minus its profile/path operands (the wiring supplies those
 * from the selected faces/edges before pushing to the op-stack). */
export type FeatureDraft = (
  | { kind: "extrude"; dir: Vec3; length: number }
  | { kind: "revolve"; axisPoint: Vec3; axisDir: Vec3; angleDeg: number }
  | { kind: "sweep" }
  | { kind: "loft" }
) & { exprs?: ExprMap };

/** A primitive-creation draft — self-contained (no selection needed), pushed
 * straight to an `EditOp` by the wiring. */
export type PrimitiveDraft = (
  | { kind: "addBox"; center: Vec3; size: Vec3 }
  | { kind: "addSphere"; center: Vec3; radius: number }
  | { kind: "addCylinder"; center: Vec3; axis: Vec3; radius: number; height: number }
  | { kind: "addCone"; center: Vec3; axis: Vec3; radius1: number; radius2: number; height: number }
  | { kind: "addTorus"; center: Vec3; axis: Vec3; majorRadius: number; minorRadius: number }
  | { kind: "addPrism"; center: Vec3; axis: Vec3; radius: number; sides: number; height: number }
  | { kind: "addWedge"; center: Vec3; axis: Vec3; up: Vec3; dx: number; dy: number; dz: number; ltx: number }
) & { exprs?: ExprMap };

/** A hole draft minus its `targets` (the wiring injects the selected volumes) —
 * subtractive, cut into existing bodies. Works on every format (mesh CSG too). */
export type HoleDraft = (
  | { kind: "addHole"; position: Vec3; axis: Vec3; radius: number; depth: number }
  | { kind: "addCounterboreHole"; position: Vec3; axis: Vec3; radius: number; depth: number; cbRadius: number; cbDepth: number }
  | { kind: "addCountersinkHole"; position: Vec3; axis: Vec3; radius: number; depth: number; csRadius: number; csAngleDeg: number }
) & { exprs?: ExprMap };

/** A 2D profile draft — self-contained (no selection needed), builds a standalone
 * flat face you can later pick (Surf mode) as a profile for Extrude/Revolve/
 * Sweep/Loft. B-rep only (meshes have no sketch/exact topology). */
export type ProfileDraft = (
  | { kind: "addCircleProfile"; center: Vec3; normal: Vec3; radius: number }
  | { kind: "addRectangleProfile"; center: Vec3; normal: Vec3; up: Vec3; width: number; height: number }
  | { kind: "addPolygonProfile"; center: Vec3; normal: Vec3; up: Vec3; radius: number; sides: number }
  | { kind: "addEllipseProfile"; center: Vec3; normal: Vec3; up: Vec3; radiusX: number; radiusY: number }
  | { kind: "addRoundedRectangleProfile"; center: Vec3; normal: Vec3; up: Vec3; width: number; height: number; cornerRadius: number }
  | { kind: "addSlotProfile"; center: Vec3; normal: Vec3; up: Vec3; length: number; width: number }
  | { kind: "addTrapezoidProfile"; center: Vec3; normal: Vec3; up: Vec3; bottomWidth: number; topWidth: number; height: number }
) & { exprs?: ExprMap };

/** A wireframe-primitive draft — self-contained (no selection needed), builds a
 * standalone point/line/arc. B-rep only (meshes have no sketch/exact topology). */
export type WireframeDraft = (
  | { kind: "addPoint"; position: Vec3 }
  | { kind: "addLine"; start: Vec3; end: Vec3 }
  | { kind: "addArc"; center: Vec3; normal: Vec3; radius: number; startAngleDeg: number; endAngleDeg: number }
  | { kind: "addPolyline"; points: Vec3[]; closed: boolean }
  | { kind: "addThreePointArc"; p1: Vec3; p2: Vec3; p3: Vec3 }
  | { kind: "addSpline"; points: Vec3[] }
  | { kind: "addBezier"; controlPoints: Vec3[] }
  | { kind: "addEllipseArc"; center: Vec3; normal: Vec3; up: Vec3; radiusX: number; radiusY: number; startAngleDeg: number; endAngleDeg: number }
  | { kind: "addHelix"; center: Vec3; axis: Vec3; radius: number; pitch: number; turns: number }
) & { exprs?: ExprMap };

/** A modify-op draft minus its selection operands: shell's `openingFaces` come
 * from the selected surfaces, split/section `targets` from the selected
 * volumes (the wiring injects both). B-rep only. */
export type ModifyDraft = (
  | { kind: "shell"; thickness: number }
  | { kind: "splitByPlane"; planePoint: Vec3; planeNormal: Vec3; keep: "both" | "positive" | "negative" }
  | { kind: "section"; planePoint: Vec3; planeNormal: Vec3 }
) & { exprs?: ExprMap };

/** Align draft minus its `targets` (the wiring injects the selected volumes) —
 * a pure rigid move, like translate, so it works on every format. */
export type AlignDraft = { axis: "x" | "y" | "z"; extent: "min" | "center" | "max"; to: number } & { exprs?: ExprMap };

/** A linear/circular pattern draft minus its `targets` (the wiring injects the
 * selected volumes) — pure rigid transforms, so both work on every format. */
export type PatternDraft = (
  | { kind: "patternLinear"; direction: Vec3; spacing: number; count: number }
  | { kind: "patternCircular"; axisPoint: Vec3; axisDir: Vec3; angleDeg: number; count: number }
) & { exprs?: ExprMap };

export interface EditsPanelCallbacks {
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  /** Remove a single op from anywhere in the history list (not just the last one). */
  onRemoveOp: (index: number) => void;
  /** Apply a transform to the current selection (the wiring supplies targets). */
  onApplyTransform: (draft: TransformDraft) => void;
  /** Capture the current selection as boolean operand A; returns its size. */
  onCaptureBooleanA: () => number;
  /** Apply a boolean of captured-A against the current selection (operand B). */
  onApplyBoolean: (kind: BooleanKind) => void;
  /** Apply a fillet/chamfer of the given amount to the selected edges (B-rep only).
   * `exprs` (if any) keys the amount as `"amount"` — the wiring remaps it to the
   * op's real field name (`radius`/`distance`). */
  onApplyFillet: (kind: "fillet" | "chamfer", amount: number, exprs?: ExprMap) => void;
  /** Apply a feature-modeling op; operands come from the selected faces/edges (B-rep only). */
  onApplyFeature: (draft: FeatureDraft) => void;
  /** Explode the assembly: spread bodies radially by `factor` (all formats). */
  onApplyExplode: (factor: number, exprs?: ExprMap) => void;
  /** Live-preview drag of the Explode slider — moves the already-displayed
   * model directly, no host round-trip, no edit op. */
  onExplodePreview: (factor: number) => void;
  /** Discards any in-progress Explode preview (leaving the form / switching
   * ops) without committing it as an edit op. */
  onExplodePreviewCancel: () => void;
  /** Mate: align the first selected face onto the second (B-rep only). */
  onApplyMate: () => void;
  /** Align the selected volumes' bbox extent along an axis to an absolute
   * coordinate (the wiring supplies targets; all formats). */
  onApplyAlign: (draft: AlignDraft) => void;
  /** Linear/circular array of the selected volumes (the wiring supplies
   * targets; all formats). */
  onApplyPattern: (draft: PatternDraft) => void;
  /** Apply a modify op (shell/split/section); operands come from the selection (B-rep only). */
  onApplyModify: (draft: ModifyDraft) => void;
  /** Add a new primitive body at the given placement (no selection needed; all formats). */
  onApplyPrimitive: (draft: PrimitiveDraft) => void;
  /** Cut a hole into the selected volumes (the wiring supplies targets; all formats). */
  onApplyHole: (draft: HoleDraft) => void;
  /** Add a new standalone flat profile face (no selection needed; B-rep only). */
  onApplyProfile: (draft: ProfileDraft) => void;
  /** Add a new standalone point/line/arc (no selection needed; B-rep only). */
  onApplyWireframe: (draft: WireframeDraft) => void;
  /** Build a flat face from the currently-selected lines (Line mode, B-rep only). */
  onBuildSurfaceFromLines: () => void;
  /** Build a solid by sewing the currently-selected surfaces (Surf mode, B-rep only). */
  onBuildVolumeFromSurfaces: () => void;
  /** Fired whenever the open param form changes (a different op button
   * clicked, or the form collapsed — `null`). Lets `main.ts` show/hide/
   * retarget the Transform Gizmo for `"translate"`/`"rotate"`/`"scale"`
   * without this panel needing to know the gizmo exists. */
  onFormChanged: (id: PanelOpId | null) => void;
}

type TabId = "geometry" | "edit";
type SubtabId = "2d" | "3d";

/**
 * The Edits panel: two top-level tabs — GEOMETRY (creation ops, split into
 * 2D / 3D subtabs) and EDIT (modification ops, one categorized list) — each a
 * grid of icon op-buttons (`OP_CATALOG` drives the structure, `OP_ICONS` the
 * placeholder glyphs). Clicking an op button opens its parameter form in the
 * single shared `#edits-params` area below the grid; clicking it again
 * collapses the form. The shared undo/redo/Clear header and the single op-
 * history list are unchanged — there is only one op stack regardless of which
 * tab an op came from. Inline inputs are used throughout (VS Code webviews
 * block `prompt()`).
 *
 * Numeric fields accept expressions over the document's variables (`L*2`): the
 * field readers ({@link readNum}/{@link readVec}/{@link rowVec}) evaluate them
 * against {@link setVariables}' values and side-collect the raw strings into
 * `pendingExprs`; the callbacks are wrapped once in the constructor
 * ({@link wrapCallbacks}) to attach the collected map to the outgoing draft —
 * or abort the apply with an inline error if any expression failed — so the
 * ~40 per-op apply closures stay untouched.
 */

/** Rounds to 6 decimal places — used only for display when the Transform
 * Gizmo pushes a live-dragged value into a field, so a float's long tail
 * doesn't render as visual noise in the input. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export class EditsPanel {
  private readonly body: HTMLElement;
  private readonly compose: HTMLElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;
  private readonly clearBtn: HTMLButtonElement;

  private activeTab: TabId = "geometry";
  private activeSubtab: SubtabId = "2d";
  private activeOp: PanelOpId | null = null;
  /** Panel-local mirror of the captured boolean-A count (display only; the ids
   * themselves live in the wiring). Survives form re-renders. */
  private booleanACount = 0;

  private readonly tabButtons = new Map<TabId, HTMLButtonElement>();
  private readonly subtabButtons = new Map<SubtabId, HTMLButtonElement>();
  private readonly tabContents = new Map<string, HTMLElement>(); // "geometry:2d" | "geometry:3d" | "edit"
  private readonly opButtons = new Map<PanelOpId, HTMLButtonElement>();
  private subtabRow!: HTMLElement;
  private paramsEl!: HTMLElement;

  /** B-rep-only controls (per-op buttons + the whole 2D subtab); disabled for mesh sources. */
  private brepOnlyEls: HTMLElement[] = [];
  private brepOnlyIds = new Set<PanelOpId>();

  /** Evaluated variable name → value map for expression fields (see setVariables). */
  private variableValues: Record<string, number> = {};
  /** Expressions collected by the field readers during the current apply click. */
  private pendingExprs: ExprMap = {};
  /** Evaluation failures collected during the current apply click (abort the apply). */
  private pendingErrors: string[] = [];

  private readonly cb: EditsPanelCallbacks;

  constructor(
    private readonly panel: HTMLElement,
    cb: EditsPanelCallbacks
  ) {
    this.cb = this.wrapCallbacks(cb);
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

  /** Updates the evaluated variable values expression fields resolve against.
   * The wiring calls this on load and after every variable change. */
  setVariables(values: Record<string, number>): void {
    this.variableValues = values;
  }

  /**
   * Wraps the draft-carrying callbacks so every apply click transparently
   * attaches the expressions collected by the field readers (or aborts with an
   * inline error when one failed). `onApplyFillet`/`onApplyExplode` take bare
   * numbers instead of a draft, so their exprs travel as an extra argument.
   */
  private wrapCallbacks(cb: EditsPanelCallbacks): EditsPanelCallbacks {
    const withExprs = <T extends { exprs?: ExprMap }>(apply: (draft: T) => void) => (draft: T): void => {
      const exprs = this.finishRead();
      if (exprs === null) return;
      apply(exprs ? { ...draft, exprs } : draft);
    };
    return {
      ...cb,
      onApplyTransform: withExprs(cb.onApplyTransform),
      onApplyFeature: withExprs(cb.onApplyFeature),
      onApplyModify: withExprs(cb.onApplyModify),
      onApplyPrimitive: withExprs(cb.onApplyPrimitive),
      onApplyHole: withExprs(cb.onApplyHole),
      onApplyProfile: withExprs(cb.onApplyProfile),
      onApplyWireframe: withExprs(cb.onApplyWireframe),
      onApplyFillet: (kind, amount) => {
        const exprs = this.finishRead();
        if (exprs !== null) cb.onApplyFillet(kind, amount, exprs);
      },
      onApplyExplode: (factor) => {
        const exprs = this.finishRead();
        if (exprs !== null) cb.onApplyExplode(factor, exprs);
      },
    };
  }

  /**
   * Drains the expression state collected since the last apply click: `null`
   * aborts the apply (an expression failed to evaluate — shown inline),
   * `undefined` means all fields were plain numbers, else the exprs map.
   */
  private finishRead(): ExprMap | null | undefined {
    const errors = this.pendingErrors;
    const exprs = this.pendingExprs;
    this.pendingErrors = [];
    this.pendingExprs = {};
    const msgEl = this.paramsEl.querySelector(".expr-error-msg");
    if (errors.length > 0) {
      const el = msgEl ?? this.paramsEl.appendChild(document.createElement("div"));
      el.className = "expr-error-msg";
      el.textContent = errors[0];
      return null;
    }
    msgEl?.remove();
    return Object.keys(exprs).length > 0 ? exprs : undefined;
  }

  /**
   * One numeric input's value: a plain number parses directly; anything else is
   * evaluated as an expression over the current variables, recording the raw
   * string under `path` in `pendingExprs` (or the failure in `pendingErrors`).
   */
  private parseNumeric(raw: string, path: string): number {
    const trimmed = raw.trim();
    if (trimmed === "") return 0;
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
    const r = evalExpr(trimmed, this.variableValues);
    if (r.ok) {
      this.pendingExprs[path] = trimmed;
      return r.value;
    }
    this.pendingErrors.push(`${path}: ${r.error}`);
    return 0;
  }

  /**
   * Renders the applied op history. The optional `opOutcomes` (the most recent
   * replay's per-op results — see `editOps.ts`'s `OpOutcome`) marks an op that
   * gracefully skipped: its row gets a ⚠ marker (tooltip = diagnostic + hint)
   * and a dimmed style, so "the model just didn't change" is at least visible
   * WHERE it happened rather than silent. Rows with no matching outcome render
   * unmarked (e.g. before any replay has run).
   */
  render(ops: EditOp[], canUndo: boolean, canRedo: boolean, opOutcomes?: OpOutcome[] | null): void {
    this.undoBtn.disabled = !canUndo;
    this.redoBtn.disabled = !canRedo;
    this.clearBtn.disabled = ops.length === 0;

    const outcomeOf = new Map((opOutcomes ?? []).map((o) => [o.index, o]));

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
      const outcome = outcomeOf.get(i);
      if (outcome && !outcome.applied) {
        li.classList.add("edit-row-skipped");
        li.title = `Did not apply — ${outcome.diagnostic ?? "no reason recorded"}${outcome.hint ? `\nHint: ${outcome.hint}` : ""}`;
      }
      const idx = document.createElement("span");
      idx.className = "edit-index";
      idx.textContent = `${i + 1}.`;
      const label = document.createElement("span");
      label.className = "edit-label";
      label.textContent = describeOp(op);
      const del = document.createElement("button");
      del.className = "edit-remove";
      del.innerHTML = TOOLBAR_ICONS.close;
      del.title = "Remove this edit";
      del.addEventListener("click", () => this.cb.onRemoveOp(i));
      li.appendChild(idx);
      li.appendChild(label);
      // A skipped op's warning marker sits between the label and the remove
      // button so it can't be mistaken for a row-level action.
      if (outcome && !outcome.applied) {
        const warn = document.createElement("span");
        warn.className = "edit-skip-warning";
        warn.textContent = "⚠";
        li.appendChild(warn);
      }
      li.appendChild(del);
      ol.appendChild(li);
    });
    this.body.appendChild(ol);
  }

  /** Enables/disables the B-rep-only controls (whole 2D subtab + individual
   * op buttons) for mesh sources. Re-parenting into tabs is safe: elements are
   * held by reference. */
  setBRepOnly(enabled: boolean): void {
    for (const el of this.brepOnlyEls) {
      el.classList.toggle("disabled", !enabled);
      if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
        el.disabled = !enabled;
      }
      el.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
        "button, input, select"
      ).forEach((c) => { c.disabled = !enabled; });
    }
    const subtab2d = this.subtabButtons.get("2d");
    if (subtab2d) {
      subtab2d.title = enabled ? "" : "Requires a B-rep source (STEP/IGES/BREP)";
    }
    if (!enabled) {
      // Never leave a B-rep-only form open, or the greyed 2D subtab active,
      // when a mesh source loads.
      if (this.activeOp && this.brepOnlyIds.has(this.activeOp)) {
        this.selectOp(null);
      }
      if (this.activeTab === "geometry" && this.activeSubtab === "2d") {
        this.activeSubtab = "3d";
        this.updateTabVisibility();
      }
    }
  }

  // ── Tab / grid construction ───────────────────────────────────────────────

  private buildComposer(): void {
    // Top-level GEOMETRY | EDIT tabs.
    const tabs = document.createElement("div");
    tabs.className = "edits-tabs";
    for (const [id, label] of [["geometry", "Geometry"], ["edit", "Edit"]] as const) {
      const btn = document.createElement("button");
      btn.className = "edits-tab";
      btn.textContent = label;
      btn.addEventListener("click", () => {
        this.activeTab = id;
        this.selectOp(null);
        this.updateTabVisibility();
      });
      this.tabButtons.set(id, btn);
      tabs.appendChild(btn);
    }
    this.compose.appendChild(tabs);

    // 2D | 3D subtabs (GEOMETRY only).
    this.subtabRow = document.createElement("div");
    this.subtabRow.className = "edits-subtabs";
    for (const [id, label] of [["2d", "2D"], ["3d", "3D"]] as const) {
      const btn = document.createElement("button");
      btn.className = "edits-subtab";
      btn.textContent = label;
      btn.addEventListener("click", () => {
        this.activeSubtab = id;
        this.selectOp(null);
        this.updateTabVisibility();
      });
      this.subtabButtons.set(id, btn);
      this.subtabRow.appendChild(btn);
    }
    this.compose.appendChild(this.subtabRow);
    // Every 2D op is B-rep only, so the subtab itself greys out for meshes.
    this.brepOnlyEls.push(this.subtabButtons.get("2d")!);

    // Tab contents (op-button grids).
    this.tabContents.set("geometry:2d", this.buildTabContent(OP_CATALOG.geometry2d));
    this.tabContents.set("geometry:3d", this.buildTabContent(OP_CATALOG.geometry3d));
    this.tabContents.set("edit", this.buildTabContent(OP_CATALOG.edit));
    for (const el of this.tabContents.values()) this.compose.appendChild(el);

    // Single shared parameter-form area.
    this.paramsEl = document.createElement("div");
    this.paramsEl.id = "edits-params";
    this.compose.appendChild(this.paramsEl);

    this.updateTabVisibility();
  }

  private buildTabContent(categories: CatalogCategory[]): HTMLElement {
    const content = document.createElement("div");
    content.className = "edits-tab-content";
    for (const cat of categories) {
      const title = document.createElement("div");
      title.className = "op-cat-title";
      title.textContent = cat.title;
      content.appendChild(title);

      const grid = document.createElement("div");
      grid.className = "op-grid";
      for (const entry of cat.ops) {
        const btn = document.createElement("button");
        btn.className = "op-btn";
        const icon = document.createElement("span");
        icon.className = "op-icon";
        icon.innerHTML = OP_ICONS[entry.id];
        const name = document.createElement("span");
        name.className = "op-name";
        name.textContent = entry.label;
        btn.appendChild(icon);
        btn.appendChild(name);
        btn.addEventListener("click", () => this.selectOp(this.activeOp === entry.id ? null : entry.id));
        this.opButtons.set(entry.id, btn);
        if (entry.brepOnly) {
          this.brepOnlyEls.push(btn);
          this.brepOnlyIds.add(entry.id);
        }
        grid.appendChild(btn);
      }
      content.appendChild(grid);
    }
    return content;
  }

  private updateTabVisibility(): void {
    for (const [id, btn] of this.tabButtons) btn.classList.toggle("active", id === this.activeTab);
    this.subtabRow.style.display = this.activeTab === "geometry" ? "" : "none";
    for (const [id, btn] of this.subtabButtons) btn.classList.toggle("active", id === this.activeSubtab);
    const activeKey = this.activeTab === "geometry" ? `geometry:${this.activeSubtab}` : "edit";
    for (const [key, el] of this.tabContents) el.style.display = key === activeKey ? "" : "none";
  }

  private selectOp(id: PanelOpId | null): void {
    // Leaving a form (switching ops, or collapsing) discards any in-progress
    // live preview rather than leaving it stacked/orphaned — a no-op if
    // nothing was previewing.
    this.cb.onExplodePreviewCancel();
    this.activeOp = id;
    for (const [opId, btn] of this.opButtons) btn.classList.toggle("active", opId === id);
    this.renderParams();
    this.cb.onFormChanged(id);
  }

  // ── Parameter forms (one per op button, rendered into #edits-params) ──────

  private renderParams(): void {
    const f = this.paramsEl;
    f.innerHTML = "";
    const id = this.activeOp;
    if (!id) return;

    switch (id) {
      // ── EDIT · transform ──
      case "translate":
        f.appendChild(this.vecField("vec", "Δ", [0, 0, 0]));
        f.appendChild(this.applyButton("Apply", "Apply to the selected volumes", () =>
          this.cb.onApplyTransform({ kind: "translate", vec: this.readVec("vec") })));
        break;
      case "rotate":
        f.appendChild(this.vecField("axisPoint", "Point", [0, 0, 0]));
        f.appendChild(this.vecField("axisDir", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("angleDeg", "Angle°", 90));
        f.appendChild(this.applyButton("Apply", "Apply to the selected volumes", () =>
          this.cb.onApplyTransform({
            kind: "rotate", axisPoint: this.readVec("axisPoint"),
            axisDir: this.readVec("axisDir"), angleDeg: this.readNum("angleDeg"),
          })));
        break;
      case "scale":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("factors", "Scale", [1, 1, 1]));
        f.appendChild(this.applyButton("Apply", "Apply to the selected volumes", () =>
          this.cb.onApplyTransform({
            kind: "scale", center: this.readVec("center"), factors: this.readVec("factors"),
          })));
        break;
      case "mirror":
        f.appendChild(this.vecField("planePoint", "Point", [0, 0, 0]));
        f.appendChild(this.vecField("planeNormal", "Normal", [1, 0, 0]));
        f.appendChild(this.applyButton("Apply", "Apply to the selected volumes", () =>
          this.cb.onApplyTransform({
            kind: "mirror", planePoint: this.readVec("planePoint"), planeNormal: this.readVec("planeNormal"),
          })));
        break;

      // ── EDIT · boolean (Set A two-step; B = live selection) ──
      case "booleanUnion":
      case "booleanSubtract":
      case "booleanIntersect":
        this.renderBooleanForm(
          id === "booleanUnion" ? "union" : id === "booleanSubtract" ? "subtract" : "intersect");
        break;

      // ── EDIT · refine ──
      case "fillet":
        f.appendChild(this.hint("Rounds the selected edges (Line mode)"));
        f.appendChild(this.numField("amount", "Radius", 1));
        f.appendChild(this.applyButton("Apply", "Apply to the selected edges (Line mode)", () =>
          this.cb.onApplyFillet("fillet", this.readNum("amount"))));
        break;
      case "chamfer":
        f.appendChild(this.hint("Bevels the selected edges (Line mode)"));
        f.appendChild(this.numField("amount", "Setback", 1));
        f.appendChild(this.applyButton("Apply", "Apply to the selected edges (Line mode)", () =>
          this.cb.onApplyFillet("chamfer", this.readNum("amount"))));
        break;

      // ── EDIT · features ──
      case "extrude":
        f.appendChild(this.hint("Profile = selected face (Surf mode)"));
        f.appendChild(this.vecField("dir", "Dir", [0, 0, 1]));
        f.appendChild(this.numField("length", "Length", 10));
        f.appendChild(this.applyButton("Apply", "Build the feature from the selected face", () =>
          this.cb.onApplyFeature({ kind: "extrude", dir: this.readVec("dir"), length: this.readNum("length") })));
        break;
      case "revolve":
        f.appendChild(this.hint("Profile = selected face (Surf mode)"));
        f.appendChild(this.vecField("axisPoint", "Point", [0, 0, 0]));
        f.appendChild(this.vecField("axisDir", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("angleDeg", "Angle°", 360));
        f.appendChild(this.applyButton("Apply", "Build the feature from the selected face", () =>
          this.cb.onApplyFeature({
            kind: "revolve", axisPoint: this.readVec("axisPoint"),
            axisDir: this.readVec("axisDir"), angleDeg: this.readNum("angleDeg"),
          })));
        break;
      case "sweep":
        f.appendChild(this.hint("Profile = selected face · path = selected edge"));
        f.appendChild(this.applyButton("Apply", "Build the feature from the selected face + edge", () =>
          this.cb.onApplyFeature({ kind: "sweep" })));
        break;
      case "loft":
        f.appendChild(this.hint("Profiles = 2+ selected faces"));
        f.appendChild(this.applyButton("Apply", "Build the feature from the selected faces", () =>
          this.cb.onApplyFeature({ kind: "loft" })));
        break;

      // ── EDIT · modify ──
      case "shell":
        f.appendChild(this.hint("Hollows the solids owning the selected faces; the faces become openings (Surf mode)"));
        f.appendChild(this.numField("thickness", "Thickness", -1));
        f.appendChild(this.hint("Negative = walls grow inward (hollow); positive = outward"));
        f.appendChild(this.applyButton("Apply", "Shell the solids owning the selected opening faces", () =>
          this.cb.onApplyModify({ kind: "shell", thickness: this.readNum("thickness") })));
        break;
      case "splitByPlane":
        f.appendChild(this.hint("Splits the selected volumes (Vol mode) by the plane"));
        f.appendChild(this.vecField("planePoint", "Point", [0, 0, 0]));
        f.appendChild(this.vecField("planeNormal", "Normal", [0, 0, 1]));
        f.appendChild(this.enumField("keep", "Keep", [
          ["both", "Both"], ["positive", "Normal side"], ["negative", "Other side"],
        ], "both"));
        f.appendChild(this.applyButton("Apply", "Split the selected volumes by the plane", () =>
          this.cb.onApplyModify({
            kind: "splitByPlane", planePoint: this.readVec("planePoint"),
            planeNormal: this.readVec("planeNormal"),
            keep: this.readEnum("keep", "both") as "both" | "positive" | "negative",
          })));
        break;
      case "section":
        f.appendChild(this.hint("Adds the planar cross-section of the selected volumes (Vol mode) as a sketch face"));
        f.appendChild(this.vecField("planePoint", "Point", [0, 0, 0]));
        f.appendChild(this.vecField("planeNormal", "Normal", [0, 0, 1]));
        f.appendChild(this.applyButton("Apply", "Add the cross-section face (the solids stay untouched)", () =>
          this.cb.onApplyModify({
            kind: "section", planePoint: this.readVec("planePoint"), planeNormal: this.readVec("planeNormal"),
          })));
        break;

      // ── EDIT · assembly ──
      case "explode":
        f.appendChild(this.numField("factor", "Factor", 1));
        f.appendChild(this.explodeSliderField());
        f.appendChild(this.applyButton("Apply", "Spread the bodies radially from the model centre", () =>
          this.cb.onApplyExplode(this.readNum("factor"))));
        break;
      case "mate":
        f.appendChild(this.hint("Select face A then B (Surf mode)"));
        f.appendChild(this.applyButton("Apply", "Align the first selected face onto the second", () =>
          this.cb.onApplyMate()));
        break;
      case "align":
        f.appendChild(this.hint("Moves the selected volumes (Vol mode) along an axis to an absolute coordinate"));
        f.appendChild(this.enumField("axis", "Axis", [["x", "X"], ["y", "Y"], ["z", "Z"]], "z"));
        f.appendChild(this.enumField("extent", "Extent", [
          ["min", "Min"], ["center", "Center"], ["max", "Max"],
        ], "min"));
        f.appendChild(this.numField("to", "To", 0));
        f.appendChild(this.applyButton("Apply", "Align the selected volumes", () =>
          this.cb.onApplyAlign({
            axis: this.readEnum("axis", "z") as "x" | "y" | "z",
            extent: this.readEnum("extent", "min") as "min" | "center" | "max",
            to: this.readNum("to"),
          })));
        break;
      case "patternLinear":
        f.appendChild(this.hint("Arrays the selected volumes (Vol mode) along a direction"));
        f.appendChild(this.vecField("direction", "Dir", [1, 0, 0]));
        f.appendChild(this.numField("spacing", "Spacing", 10));
        f.appendChild(this.numField("count", "Count", 3));
        f.appendChild(this.applyButton("Apply", "Pattern the selected volumes", () =>
          this.cb.onApplyPattern({
            kind: "patternLinear", direction: this.readVec("direction"),
            spacing: this.readNum("spacing"), count: this.readNum("count"),
          })));
        break;
      case "patternCircular":
        f.appendChild(this.hint("Arrays the selected volumes (Vol mode) around an axis"));
        f.appendChild(this.vecField("axisPoint", "Point", [0, 0, 0]));
        f.appendChild(this.vecField("axisDir", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("angleDeg", "Angle°", 60));
        f.appendChild(this.numField("count", "Count", 6));
        f.appendChild(this.applyButton("Apply", "Pattern the selected volumes", () =>
          this.cb.onApplyPattern({
            kind: "patternCircular", axisPoint: this.readVec("axisPoint"),
            axisDir: this.readVec("axisDir"), angleDeg: this.readNum("angleDeg"),
            count: this.readNum("count"),
          })));
        break;

      // ── GEOMETRY 2D · wireframe ──
      case "addPoint":
        f.appendChild(this.vecField("position", "Position", [0, 0, 0]));
        f.appendChild(this.applyButton("Add", "Add a new standalone point (no selection needed)", () =>
          this.cb.onApplyWireframe({ kind: "addPoint", position: this.readVec("position") })));
        break;
      case "addLine":
        f.appendChild(this.vecField("start", "Start", [0, 0, 0]));
        f.appendChild(this.vecField("end", "End", [10, 0, 0]));
        f.appendChild(this.applyButton("Add", "Add a new standalone line (no selection needed)", () =>
          this.cb.onApplyWireframe({ kind: "addLine", start: this.readVec("start"), end: this.readVec("end") })));
        break;
      case "addArc":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("normal", "Normal", [0, 0, 1]));
        f.appendChild(this.numField("radius", "Radius", 5));
        f.appendChild(this.numField("startAngleDeg", "Start°", 0));
        f.appendChild(this.numField("endAngleDeg", "End°", 180));
        f.appendChild(this.applyButton("Add", "Add a new standalone arc (no selection needed)", () =>
          this.cb.onApplyWireframe({
            kind: "addArc", center: this.readVec("center"), normal: this.readVec("normal"),
            radius: this.readNum("radius"), startAngleDeg: this.readNum("startAngleDeg"),
            endAngleDeg: this.readNum("endAngleDeg"),
          })));
        break;

      // ── GEOMETRY 2D · curves ──
      case "addPolyline":
        f.appendChild(this.pointListField("points", "Points", [[0, 0, 0], [10, 0, 0], [10, 10, 0]], 2));
        f.appendChild(this.boolField("closed", "Closed", false));
        f.appendChild(this.applyButton("Add", "Add a new standalone polyline (no selection needed)", () =>
          this.cb.onApplyWireframe({
            kind: "addPolyline", points: this.readPoints("points"), closed: this.readBool("closed"),
          })));
        break;
      case "addThreePointArc":
        f.appendChild(this.vecField("p1", "Start", [0, 0, 0]));
        f.appendChild(this.vecField("p2", "Through", [5, 5, 0]));
        f.appendChild(this.vecField("p3", "End", [10, 0, 0]));
        f.appendChild(this.applyButton("Add", "Add a circular arc through the three points (no selection needed)", () =>
          this.cb.onApplyWireframe({
            kind: "addThreePointArc", p1: this.readVec("p1"), p2: this.readVec("p2"), p3: this.readVec("p3"),
          })));
        break;
      case "addSpline":
        f.appendChild(this.hint("Smooth curve through the points (endpoint-exact fit)"));
        f.appendChild(this.pointListField("points", "Points", [[0, 0, 0], [5, 5, 0], [10, 0, 0]], 2));
        f.appendChild(this.applyButton("Add", "Add a new standalone spline (no selection needed)", () =>
          this.cb.onApplyWireframe({ kind: "addSpline", points: this.readPoints("points") })));
        break;
      case "addBezier":
        f.appendChild(this.hint("Passes through the first and last control point only"));
        f.appendChild(this.pointListField("controlPoints", "Ctrl pts", [[0, 0, 0], [5, 10, 0], [10, 0, 0]], 2));
        f.appendChild(this.applyButton("Add", "Add a new standalone Bézier curve (no selection needed)", () =>
          this.cb.onApplyWireframe({ kind: "addBezier", controlPoints: this.readPoints("controlPoints") })));
        break;
      case "addEllipseArc":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("normal", "Normal", [0, 0, 1]));
        f.appendChild(this.vecField("up", "Up", [1, 0, 0]));
        f.appendChild(this.numField("radiusX", "Radius X", 8));
        f.appendChild(this.numField("radiusY", "Radius Y", 5));
        f.appendChild(this.numField("startAngleDeg", "Start°", 0));
        f.appendChild(this.numField("endAngleDeg", "End°", 180));
        f.appendChild(this.applyButton("Add", "Add a new standalone elliptical arc (no selection needed)", () =>
          this.cb.onApplyWireframe({
            kind: "addEllipseArc", center: this.readVec("center"), normal: this.readVec("normal"),
            up: this.readVec("up"), radiusX: this.readNum("radiusX"), radiusY: this.readNum("radiusY"),
            startAngleDeg: this.readNum("startAngleDeg"), endAngleDeg: this.readNum("endAngleDeg"),
          })));
        break;
      case "addHelix":
        f.appendChild(this.vecField("center", "Base", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("radius", "Radius", 5));
        f.appendChild(this.numField("pitch", "Pitch", 3));
        f.appendChild(this.numField("turns", "Turns", 3));
        f.appendChild(this.applyButton("Add", "Add a new standalone helix (no selection needed)", () =>
          this.cb.onApplyWireframe({
            kind: "addHelix", center: this.readVec("center"), axis: this.readVec("axis"),
            radius: this.readNum("radius"), pitch: this.readNum("pitch"), turns: this.readNum("turns"),
          })));
        break;

      // ── GEOMETRY 2D · sketch profiles ──
      case "addCircleProfile":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("normal", "Normal", [0, 0, 1]));
        f.appendChild(this.numField("radius", "Radius", 5));
        f.appendChild(this.applyButton("Sketch", SKETCH_TITLE, () =>
          this.cb.onApplyProfile({
            kind: "addCircleProfile", center: this.readVec("center"),
            normal: this.readVec("normal"), radius: this.readNum("radius"),
          })));
        break;
      case "addRectangleProfile":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("normal", "Normal", [0, 0, 1]));
        f.appendChild(this.vecField("up", "Up", [1, 0, 0]));
        f.appendChild(this.numField("width", "Width", 10));
        f.appendChild(this.numField("height", "Height", 6));
        f.appendChild(this.applyButton("Sketch", SKETCH_TITLE, () =>
          this.cb.onApplyProfile({
            kind: "addRectangleProfile", center: this.readVec("center"), normal: this.readVec("normal"),
            up: this.readVec("up"), width: this.readNum("width"), height: this.readNum("height"),
          })));
        break;
      case "addPolygonProfile":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("normal", "Normal", [0, 0, 1]));
        f.appendChild(this.vecField("up", "Up", [1, 0, 0]));
        f.appendChild(this.numField("radius", "Radius", 5));
        f.appendChild(this.numField("sides", "Sides", 6));
        f.appendChild(this.applyButton("Sketch", SKETCH_TITLE, () =>
          this.cb.onApplyProfile({
            kind: "addPolygonProfile", center: this.readVec("center"), normal: this.readVec("normal"),
            up: this.readVec("up"), radius: this.readNum("radius"), sides: this.readNum("sides"),
          })));
        break;
      case "addEllipseProfile":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("normal", "Normal", [0, 0, 1]));
        f.appendChild(this.vecField("up", "Up", [1, 0, 0]));
        f.appendChild(this.numField("radiusX", "Radius X", 8));
        f.appendChild(this.numField("radiusY", "Radius Y", 5));
        f.appendChild(this.applyButton("Sketch", SKETCH_TITLE, () =>
          this.cb.onApplyProfile({
            kind: "addEllipseProfile", center: this.readVec("center"), normal: this.readVec("normal"),
            up: this.readVec("up"), radiusX: this.readNum("radiusX"), radiusY: this.readNum("radiusY"),
          })));
        break;
      case "addRoundedRectangleProfile":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("normal", "Normal", [0, 0, 1]));
        f.appendChild(this.vecField("up", "Up", [1, 0, 0]));
        f.appendChild(this.numField("width", "Width", 10));
        f.appendChild(this.numField("height", "Height", 6));
        f.appendChild(this.numField("cornerRadius", "Corner r", 1));
        f.appendChild(this.applyButton("Sketch", SKETCH_TITLE, () =>
          this.cb.onApplyProfile({
            kind: "addRoundedRectangleProfile", center: this.readVec("center"), normal: this.readVec("normal"),
            up: this.readVec("up"), width: this.readNum("width"), height: this.readNum("height"),
            cornerRadius: this.readNum("cornerRadius"),
          })));
        break;
      case "addSlotProfile":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("normal", "Normal", [0, 0, 1]));
        f.appendChild(this.vecField("up", "Up", [1, 0, 0]));
        f.appendChild(this.numField("length", "Length", 12));
        f.appendChild(this.numField("width", "Width", 4));
        f.appendChild(this.applyButton("Sketch", SKETCH_TITLE, () =>
          this.cb.onApplyProfile({
            kind: "addSlotProfile", center: this.readVec("center"), normal: this.readVec("normal"),
            up: this.readVec("up"), length: this.readNum("length"), width: this.readNum("width"),
          })));
        break;
      case "addTrapezoidProfile":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("normal", "Normal", [0, 0, 1]));
        f.appendChild(this.vecField("up", "Up", [1, 0, 0]));
        f.appendChild(this.numField("bottomWidth", "Bottom w", 10));
        f.appendChild(this.numField("topWidth", "Top w", 6));
        f.appendChild(this.numField("height", "Height", 5));
        f.appendChild(this.applyButton("Sketch", SKETCH_TITLE, () =>
          this.cb.onApplyProfile({
            kind: "addTrapezoidProfile", center: this.readVec("center"), normal: this.readVec("normal"),
            up: this.readVec("up"), bottomWidth: this.readNum("bottomWidth"),
            topWidth: this.readNum("topWidth"), height: this.readNum("height"),
          })));
        break;

      // ── GEOMETRY 2D/3D · build from selection ──
      case "buildSurface":
        f.appendChild(this.hint("Select 3+ lines forming a closed loop (Line mode)"));
        f.appendChild(this.applyButton("Build", "Build a flat face from the selected lines", () =>
          this.cb.onBuildSurfaceFromLines()));
        break;
      case "buildVolume":
        f.appendChild(this.hint("Select 4+ surfaces forming a closed shell (Surf mode)"));
        f.appendChild(this.applyButton("Build", "Build a solid by sewing the selected surfaces", () =>
          this.cb.onBuildVolumeFromSurfaces()));
        break;

      // ── GEOMETRY 3D · primitives ──
      case "addBox":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("size", "Size", [10, 10, 10]));
        f.appendChild(this.applyButton("Add", ADD_TITLE, () =>
          this.cb.onApplyPrimitive({ kind: "addBox", center: this.readVec("center"), size: this.readVec("size") })));
        break;
      case "addSphere":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.numField("radius", "Radius", 5));
        f.appendChild(this.applyButton("Add", ADD_TITLE, () =>
          this.cb.onApplyPrimitive({ kind: "addSphere", center: this.readVec("center"), radius: this.readNum("radius") })));
        break;
      case "addCylinder":
        f.appendChild(this.vecField("center", "Base", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("radius", "Radius", 5));
        f.appendChild(this.numField("height", "Height", 10));
        f.appendChild(this.applyButton("Add", ADD_TITLE, () =>
          this.cb.onApplyPrimitive({
            kind: "addCylinder", center: this.readVec("center"), axis: this.readVec("axis"),
            radius: this.readNum("radius"), height: this.readNum("height"),
          })));
        break;
      case "addCone":
        f.appendChild(this.vecField("center", "Base", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("radius1", "Base r", 5));
        f.appendChild(this.numField("radius2", "Top r", 0));
        f.appendChild(this.numField("height", "Height", 10));
        f.appendChild(this.applyButton("Add", ADD_TITLE, () =>
          this.cb.onApplyPrimitive({
            kind: "addCone", center: this.readVec("center"), axis: this.readVec("axis"),
            radius1: this.readNum("radius1"), radius2: this.readNum("radius2"), height: this.readNum("height"),
          })));
        break;
      case "addTorus":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("majorRadius", "Major r", 10));
        f.appendChild(this.numField("minorRadius", "Minor r", 2));
        f.appendChild(this.applyButton("Add", ADD_TITLE, () =>
          this.cb.onApplyPrimitive({
            kind: "addTorus", center: this.readVec("center"), axis: this.readVec("axis"),
            majorRadius: this.readNum("majorRadius"), minorRadius: this.readNum("minorRadius"),
          })));
        break;
      case "addPrism":
        f.appendChild(this.vecField("center", "Base", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("radius", "Radius", 5));
        f.appendChild(this.numField("sides", "Sides", 6));
        f.appendChild(this.numField("height", "Height", 10));
        f.appendChild(this.applyButton("Add", ADD_TITLE, () =>
          this.cb.onApplyPrimitive({
            kind: "addPrism", center: this.readVec("center"), axis: this.readVec("axis"),
            radius: this.readNum("radius"), sides: this.readNum("sides"), height: this.readNum("height"),
          })));
        break;
      case "addWedge":
        f.appendChild(this.vecField("center", "Base ctr", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, 1]));
        f.appendChild(this.vecField("up", "Up", [1, 0, 0]));
        f.appendChild(this.numField("dx", "Size X", 10));
        f.appendChild(this.numField("dy", "Size Y", 6));
        f.appendChild(this.numField("dz", "Height", 4));
        f.appendChild(this.numField("ltx", "Top X", 3));
        f.appendChild(this.applyButton("Add", ADD_TITLE, () =>
          this.cb.onApplyPrimitive({
            kind: "addWedge", center: this.readVec("center"), axis: this.readVec("axis"),
            up: this.readVec("up"), dx: this.readNum("dx"), dy: this.readNum("dy"),
            dz: this.readNum("dz"), ltx: this.readNum("ltx"),
          })));
        break;

      // ── GEOMETRY 3D · holes (subtractive — need selected target volumes) ──
      case "addHole":
        f.appendChild(this.hint("Cuts into the selected volumes (Vol mode)"));
        f.appendChild(this.vecField("position", "Mouth", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, -1]));
        f.appendChild(this.numField("radius", "Radius", 2));
        f.appendChild(this.numField("depth", "Depth", 10));
        f.appendChild(this.applyButton("Cut", HOLE_TITLE, () =>
          this.cb.onApplyHole({
            kind: "addHole", position: this.readVec("position"), axis: this.readVec("axis"),
            radius: this.readNum("radius"), depth: this.readNum("depth"),
          })));
        break;
      case "addCounterboreHole":
        f.appendChild(this.hint("Cuts into the selected volumes (Vol mode)"));
        f.appendChild(this.vecField("position", "Mouth", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, -1]));
        f.appendChild(this.numField("radius", "Radius", 2));
        f.appendChild(this.numField("depth", "Depth", 10));
        f.appendChild(this.numField("cbRadius", "Bore r", 4));
        f.appendChild(this.numField("cbDepth", "Bore d", 3));
        f.appendChild(this.applyButton("Cut", HOLE_TITLE, () =>
          this.cb.onApplyHole({
            kind: "addCounterboreHole", position: this.readVec("position"), axis: this.readVec("axis"),
            radius: this.readNum("radius"), depth: this.readNum("depth"),
            cbRadius: this.readNum("cbRadius"), cbDepth: this.readNum("cbDepth"),
          })));
        break;
      case "addCountersinkHole":
        f.appendChild(this.hint("Cuts into the selected volumes (Vol mode)"));
        f.appendChild(this.vecField("position", "Mouth", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, -1]));
        f.appendChild(this.numField("radius", "Radius", 2));
        f.appendChild(this.numField("depth", "Depth", 10));
        f.appendChild(this.numField("csRadius", "Sink r", 4));
        f.appendChild(this.numField("csAngleDeg", "Angle°", 90));
        f.appendChild(this.applyButton("Cut", HOLE_TITLE, () =>
          this.cb.onApplyHole({
            kind: "addCountersinkHole", position: this.readVec("position"), axis: this.readVec("axis"),
            radius: this.readNum("radius"), depth: this.readNum("depth"),
            csRadius: this.readNum("csRadius"), csAngleDeg: this.readNum("csAngleDeg"),
          })));
        break;
    }
  }

  private renderBooleanForm(kind: BooleanKind): void {
    const f = this.paramsEl;
    f.appendChild(this.hint("Select volumes → Set A, then select B and Apply"));

    const status = document.createElement("span");
    status.className = "compose-bool-a";
    const renderStatus = () => {
      status.textContent = this.booleanACount > 0 ? `A: ${this.booleanACount}` : "A: —";
    };
    renderStatus();

    const row = document.createElement("div");
    row.className = "compose-row";
    const setA = document.createElement("button");
    setA.className = "compose-apply";
    setA.textContent = "Set A";
    setA.title = "Capture the selected volumes as boolean operand A";
    setA.addEventListener("click", () => {
      this.booleanACount = this.cb.onCaptureBooleanA();
      renderStatus();
    });
    row.appendChild(setA);

    const apply = document.createElement("button");
    apply.className = "compose-apply";
    apply.textContent = "Apply";
    apply.title = "Apply the boolean: captured A against the current selection (B)";
    apply.addEventListener("click", () => {
      this.cb.onApplyBoolean(kind);
      this.booleanACount = 0;
      renderStatus();
    });
    row.appendChild(apply);

    f.appendChild(row);
    f.appendChild(status);
  }

  // ── Field helpers ────────────────────────────────────────────────────────

  private applyButton(label: string, title: string, onClick: () => void): HTMLElement {
    const row = document.createElement("div");
    row.className = "compose-row";
    const btn = document.createElement("button");
    btn.className = "compose-apply";
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener("click", onClick);
    row.appendChild(btn);
    return row;
  }

  private hint(text: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "compose-hint";
    el.textContent = text;
    return el;
  }

  private vecField(name: string, label: string, def: Vec3): HTMLElement {
    const row = document.createElement("label");
    row.className = "compose-field";
    const span = document.createElement("span");
    span.className = "compose-label";
    span.textContent = label;
    row.appendChild(span);
    for (let i = 0; i < 3; i++) {
      const input = this.numericInput();
      input.dataset.name = name;
      input.dataset.i = String(i);
      input.value = String(def[i]);
      row.appendChild(input);
    }
    return row;
  }

  /** A numeric-or-expression input: text (not `type=number`) so variable
   * expressions like `L*2` are typable; the readers evaluate them. */
  private numericInput(): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.className = "compose-num";
    return input;
  }

  private numField(name: string, label: string, def: number): HTMLElement {
    const row = document.createElement("label");
    row.className = "compose-field";
    const span = document.createElement("span");
    span.className = "compose-label";
    span.textContent = label;
    row.appendChild(span);
    const input = this.numericInput();
    input.dataset.name = name;
    input.value = String(def);
    row.appendChild(input);
    return row;
  }

  /**
   * Live-pushes a value from an external source (the Transform Gizmo drag,
   * `main.ts`) into a currently-rendered `vecField`/`numField`'s inputs — a
   * no-op if that field isn't in the currently-open form (e.g. the user
   * switched op forms mid-drag). Writing a plain numeric string is what
   * clears any expression the field previously held: `parseNumeric` only
   * ever reads `.value` fresh at Apply time and re-evaluates it then, so a
   * literal number here simply parses as a literal number — no separate
   * `pendingExprs` bookkeeping needs touching. This is the answer to "what
   * happens when a drag overwrites a field the user had typed an expression
   * into": the drag wins, silently, same as typing over the field by hand.
   */
  setVecField(name: string, value: Vec3): void {
    const inputs = this.paramsEl.querySelectorAll<HTMLInputElement>(`input[data-name="${name}"]`);
    inputs.forEach((input) => {
      const i = Number(input.dataset.i);
      if (Number.isInteger(i) && i >= 0 && i < 3) input.value = String(round6(value[i]));
    });
  }

  /** See {@link setVecField}. */
  setNumField(name: string, value: number): void {
    const input = this.paramsEl.querySelector<HTMLInputElement>(`input[data-name="${name}"]`);
    if (input) input.value = String(round6(value));
  }

  /**
   * Explode's live-preview slider — unlike every other op's plain numeric
   * field, dragging this moves the ALREADY-DISPLAYED model directly (via
   * `onExplodePreview`, no host round-trip, no edit op) while keeping the
   * `factor` number field in sync so Apply commits whatever was last
   * previewed. Range is 0–300 mapped to a factor of 0–3.0 (a step of 0.01).
   */
  private explodeSliderField(): HTMLElement {
    const row = document.createElement("div");
    row.className = "compose-row explode-slider-row";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "meshing-slider";
    slider.min = "0";
    slider.max = "300";
    slider.step = "1";
    slider.value = "100";
    slider.title = "Drag to preview the explode factor live";
    slider.addEventListener("input", () => {
      const factor = Number(slider.value) / 100;
      const numInput = this.paramsEl.querySelector<HTMLInputElement>('input[data-name="factor"]');
      if (numInput) numInput.value = String(factor);
      this.cb.onExplodePreview(factor);
    });
    row.appendChild(slider);
    return row;
  }

  /**
   * A dynamic, ordered list of Vec3 rows for variable-point curves (polyline/
   * spline/bezier): each `.point-row` is a vec triple + a `−` remove button
   * (disabled at `min` rows); a trailing `+ Add point` button appends a row
   * seeded from the last row's values. {@link readPoints} walks the rows in
   * DOM order at emit time, so no renumbering is ever needed.
   */
  private pointListField(name: string, label: string, initial: Vec3[], min: number): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "point-list";
    wrap.dataset.name = name;

    const head = document.createElement("div");
    head.className = "compose-field";
    const span = document.createElement("span");
    span.className = "compose-label";
    span.textContent = label;
    head.appendChild(span);
    wrap.appendChild(head);

    const rows = document.createElement("div");
    rows.className = "point-rows";
    wrap.appendChild(rows);

    const updateRemoveState = () => {
      const disable = rows.children.length <= min;
      rows.querySelectorAll<HTMLButtonElement>(".point-remove").forEach((b) => { b.disabled = disable; });
    };

    // Rows hold raw strings so expression text survives the seed-from-last-row copy.
    const addRow = (val: [string, string, string]) => {
      const row = document.createElement("div");
      row.className = "point-row";
      for (let i = 0; i < 3; i++) {
        const input = this.numericInput();
        input.dataset.i = String(i);
        input.value = val[i];
        row.appendChild(input);
      }
      const remove = document.createElement("button");
      remove.className = "point-remove";
      remove.textContent = "−";
      remove.title = "Remove this point";
      remove.addEventListener("click", () => {
        row.remove();
        updateRemoveState();
      });
      row.appendChild(remove);
      rows.appendChild(row);
      updateRemoveState();
    };
    for (const p of initial) addRow([String(p[0]), String(p[1]), String(p[2])]);

    const add = document.createElement("button");
    add.className = "point-add";
    add.textContent = "+ Add point";
    add.addEventListener("click", () => {
      const last = rows.lastElementChild;
      const seed: [string, string, string] = ["0", "0", "0"];
      last?.querySelectorAll<HTMLInputElement>("input").forEach((inp) => {
        seed[Number(inp.dataset.i)] = inp.value;
      });
      addRow(seed);
    });
    wrap.appendChild(add);
    return wrap;
  }

  /** The points of a {@link pointListField}, in current DOM (display) order —
   * which is exactly the emitted op's `points` order, so the expression paths
   * `name[row][i]` recorded here line up with the final array. */
  private readPoints(name: string): Vec3[] {
    const wrap = this.paramsEl.querySelector<HTMLElement>(`.point-list[data-name="${name}"]`);
    if (!wrap) return [];
    return Array.from(wrap.querySelectorAll<HTMLElement>(".point-row"))
      .map((row, r) => this.rowVec(row, `${name}[${r}]`));
  }

  private rowVec(row: HTMLElement, pathPrefix: string): Vec3 {
    const v: number[] = [0, 0, 0];
    row.querySelectorAll<HTMLInputElement>("input").forEach((inp) => {
      const i = Number(inp.dataset.i);
      v[i] = this.parseNumeric(inp.value, `${pathPrefix}[${i}]`);
    });
    return [v[0], v[1], v[2]];
  }

  private enumField(name: string, label: string, options: ReadonlyArray<readonly [string, string]>, def: string): HTMLElement {
    const row = document.createElement("label");
    row.className = "compose-field";
    const span = document.createElement("span");
    span.className = "compose-label";
    span.textContent = label;
    row.appendChild(span);
    const select = document.createElement("select");
    select.className = "compose-select";
    select.dataset.name = name;
    for (const [value, text] of options) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      select.appendChild(opt);
    }
    select.value = def;
    row.appendChild(select);
    return row;
  }

  private readEnum(name: string, def: string): string {
    const sel = this.paramsEl.querySelector<HTMLSelectElement>(`select[data-name="${name}"]`);
    return sel ? sel.value : def;
  }

  private boolField(name: string, label: string, def: boolean): HTMLElement {
    const row = document.createElement("label");
    row.className = "compose-field";
    const span = document.createElement("span");
    span.className = "compose-label";
    span.textContent = label;
    row.appendChild(span);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.name = name;
    input.checked = def;
    row.appendChild(input);
    return row;
  }

  private readBool(name: string): boolean {
    const inp = this.paramsEl.querySelector<HTMLInputElement>(`input[data-name="${name}"][type="checkbox"]`);
    return inp ? inp.checked : false;
  }

  private readVec(name: string): Vec3 {
    const inputs = this.paramsEl.querySelectorAll<HTMLInputElement>(`input[data-name="${name}"]`);
    const v: number[] = [0, 0, 0];
    inputs.forEach((inp) => {
      const i = Number(inp.dataset.i);
      v[i] = this.parseNumeric(inp.value, `${name}[${i}]`);
    });
    return [v[0], v[1], v[2]];
  }

  private readNum(name: string): number {
    const inp = this.paramsEl.querySelector<HTMLInputElement>(`input[data-name="${name}"]`);
    return inp ? this.parseNumeric(inp.value, name) : 0;
  }
}

const ADD_TITLE = "Add a new primitive body at this placement (no selection needed)";
const HOLE_TITLE = "Cut the hole into the selected volumes (Vol mode)";
const SKETCH_TITLE =
  "Add a new flat profile face at this placement (pick it later in Surf mode as an Extrude/Revolve/Sweep/Loft profile)";
