import type { EditOp, ExprMap, Vec3, OpOutcome } from "../editOps";
import { GUIDE_KINDS } from "../editOps";
import type { ConstructionPlane } from "../protocol";
import type { OpBucket } from "../opBuckets";
import { bucketSummary } from "../opBuckets";
import { evalExpr } from "../paramExpr";
import { OP_CATALOG, describeOp, type CatalogCategory, type PanelOpId } from "./opCatalog";
import { QUERYABLE_PANEL_FORMS } from "./opCatalog";
import { OP_ICONS } from "./opIcons";
import { allHoleSizes, depthPresetsFor, findHoleSize } from "../holeStandards";
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
  | { kind: "mirror"; planePoint: Vec3; planeNormal: Vec3; planeId?: string }
) & { exprs?: ExprMap };

export type BooleanKind = "union" | "subtract" | "intersect";

/** A feature-modeling op minus its profile/path operands (the wiring supplies those
 * from the selected faces/edges before pushing to the op-stack). */
export type FeatureDraft = (
  | { kind: "extrude"; dir: Vec3; length: number }
  | { kind: "revolve"; axisPoint: Vec3; axisDir: Vec3; angleDeg: number }
  | { kind: "sweep" }
  | { kind: "loft"; smoothing?: boolean }
  | { kind: "rib"; dir: Vec3; blendRadius: number }
) & { exprs?: ExprMap; thin?: number; thinOuter?: number };

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
) & { exprs?: ExprMap; guide?: boolean };

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
) & { exprs?: ExprMap; guide?: boolean };

/** A modify-op draft minus its selection operands: shell's `openingFaces` come
 * from the selected surfaces, split/section `targets` from the selected
 * volumes (the wiring injects both). B-rep only. */
export type ModifyDraft = (
  | { kind: "shell"; thickness: number }
  | { kind: "draft"; angleDeg: number; planePoint?: Vec3; planeNormal?: Vec3; planeId?: string }
  | { kind: "splitByPlane"; planePoint: Vec3; planeNormal: Vec3; planeId?: string; keep: "both" | "positive" | "negative" }
  | { kind: "section"; planePoint: Vec3; planeNormal: Vec3; planeId?: string }
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
  /** Jump the op stack straight to timeline position `index` in one splice
   * (op-history scrubbing, roadmap Tier 2 item 1): applied rows roll the
   * model back past them, pending-redo rows re-apply through them. Wired
   * straight to `EditsModel.jumpTo`. */
  onJumpTo: (index: number) => void;
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
  /** Capture the selected edge as the sweep path; returns its id, or null when
   * nothing suitable is selected. Needed because a sweep's profile and its path
   * are BOTH edge picks once open-wire profiles exist. */
  onCaptureSweepPath: () => string | null;
  /** Forget the captured sweep path (back to "the one selected edge is the path"). */
  onClearSweepPath: () => void;
  /** Capture the selected face as the rib terminator; returns its id, or null
   * when nothing suitable is selected. The spine (edges) and the terminator
   * (face) live in different pick modes, but capturing keeps the terminator
   * stable across selection changes, like the sweep path. */
  onCaptureRibTerminator: () => string | null;
  /** Forget the captured rib terminator (a rib cannot apply without one). */
  onClearRibTerminator: () => void;
  /** Capture the current selection as one more loft section; returns the new count. */
  onCaptureLoftSection: () => number;
  /** Forget every captured loft section (back to "the selected faces are the sections"). */
  onClearLoftSections: () => void;
  /** Capture the selected face as the extrude terminator; returns its id, or
   * null when nothing suitable is selected. Needed because the profile and
   * the terminator are BOTH face picks — a flat Surf-mode selection cannot
   * express which face terminates. */
  onCaptureTerminator: () => string | null;
  /** Forget the captured terminator (back to "Length extrudes by the typed amount"). */
  onClearTerminator: () => void;
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
  /** Build a stadium slot face from the currently-selected edge (Line mode, B-rep only). */
  onBuildEdgeSlot: (width: number) => void;
  /** Fired whenever the open param form changes (a different op button
   * clicked, or the form collapsed — `null`). Lets `main.ts` show/hide/
   * retarget the Transform Gizmo for `"translate"`/`"rotate"`/`"scale"`
   * without this panel needing to know the gizmo exists. */
  onFormChanged: (id: PanelOpId | null) => void;
  /** A field in the open op form changed (or the form just opened) — the live
   * operation preview re-reads {@link EditsPanel.currentDraft} and schedules a
   * debounced preview. Fired from one delegated listener on `#edits-params`
   * (plus the point-list add/remove buttons, whose clicks change the draft
   * without an `input` event); never fired for the Explode form, which keeps
   * its own slider preview. */
  onPreviewDraftChanged: () => void;
  /** The open form went away (op switched or collapsed) — any in-flight or
   * pending preview is discarded. Fired BEFORE the replacement form renders,
   * so a stale preview can never outlive the form it came from. */
  onPreviewCancel: () => void;
  /** Transiently highlights a bucket chip's face ids in the viewport (roadmap
   * "Selector synthesis" Phase 1) — `null` clears the highlight and restores
   * the real selection's rendering. The ids are `face-N` strings; the wiring
   * maps them to `{entityType: "surface"}` entities. */
  onHighlightBucket: (ids: string[] | null) => void;
  /** Induce a stored operand query for the currently-selected faces against
   * the given producing op's `role` bucket (the "pin as query" row in
   * `QUERYABLE_PANEL_FORMS` forms). The wiring reads the live selection,
   * posts `selectorSynthesizeRequest`, and stages the result as pending for
   * the open form — attached at Apply only while the selection still names
   * the same faces. Takes raw bucket coordinates, never a draft. */
  onSynthesizeQuery: (op: number, role: string) => void;
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
  /** The op whose history-row bucket chip is currently highlighted in the
   * viewport (click-toggle). Reset on every render — a model rebuild already
   * restores the real selection's rendering via `refreshColors()`. */
  private activeBucketOp: number | null = null;
  /** Panel-local mirror of the captured boolean-A count (display only; the ids
   * themselves live in the wiring). Survives form re-renders. */
  private booleanACount = 0;
  private sweepPath: string | null = null;

  private loftSectionCount = 0;

  private terminator: string | null = null;

  private ribTerminator: string | null = null;
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

  private planesList: ConstructionPlane[] = [];
  setPlanes(planes: ConstructionPlane[]): void {
    this.planesList = [...planes];
  }

  private readPlaneId(): string | undefined {
    const sel = this.paramsEl.querySelector<HTMLSelectElement>("select[data-name=\"planeId\"]");
    const v = sel?.value?.trim();
    return v ? v : undefined;
  }

  private planeSelectField(): HTMLElement {
    const row = document.createElement("label");
    row.className = "compose-field";
    const span = document.createElement("span");
    span.className = "compose-label";
    span.textContent = "Plane";
    row.appendChild(span);
    const select = document.createElement("select");
    select.className = "compose-select";
    select.dataset.name = "planeId";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "Custom (typed vectors)";
    select.appendChild(none);
    for (const p of this.planesList) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      opt.title = `point (${p.point.join(", ")}) · normal (${p.normal.join(", ")})${p.derivedFrom ? ` · from ${p.derivedFrom}` : ""}`;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      const id = select.value;
      const plane = this.planesList.find((x) => x.id === id);
      const pointInputs = this.paramsEl.querySelectorAll<HTMLInputElement>("input[data-name=\"planePoint\"]");
      const normalInputs = this.paramsEl.querySelectorAll<HTMLInputElement>("input[data-name=\"planeNormal\"]");
      const disable = !!plane;
      pointInputs.forEach((el) => { el.disabled = disable; });
      normalInputs.forEach((el) => { el.disabled = disable; });
      if (plane) {
        this.setVecField("planePoint", plane.point as Vec3);
        this.setVecField("planeNormal", plane.normal as Vec3);
      }
      if (this.draftReader) this.cb.onPreviewDraftChanged();
    });
    row.appendChild(select);
    return row;
  }

  /**
   * Buckets the open form's query row can induce from — refreshed from every
   * `geometry` message (the wiring calls this with the fresh `opBuckets`),
   * since each replay renumbers the faces a bucket names. Buckets with no
   * roles offer nothing to pin against and are dropped here, not in the row.
   */
  private queryBuckets: OpBucket[] = [];
  setQueryBuckets(buckets: OpBucket[]): void {
    this.queryBuckets = buckets.filter((b) => Object.keys(b.roles ?? {}).length > 0);
    this.refreshQueryRow();
  }

  /** Repopulates a query row's selects (the open form's, or a freshly-built
   * one passed directly): buckets in arrival order, roles of the selected
   * bucket, previous choices preserved when still present. */
  private refreshQueryRow(row?: Element | null): void {
    if (!this.activeOp || !QUERYABLE_PANEL_FORMS.has(this.activeOp)) return;
    const target = row ?? this.paramsEl.querySelector(".compose-query-row");
    if (!target) return;
    const bucketSel = target.querySelector<HTMLSelectElement>("select[data-name=\"queryBucket\"]");
    const roleSel = target.querySelector<HTMLSelectElement>("select[data-name=\"queryRole\"]");
    if (!bucketSel || !roleSel) return;
    const prevBucket = bucketSel.value;
    bucketSel.innerHTML = "";
    for (const b of this.queryBuckets) {
      const opt = document.createElement("option");
      opt.value = String(b.op);
      opt.textContent = `op ${b.op} (${b.kind})`;
      bucketSel.appendChild(opt);
    }
    if (this.queryBuckets.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "no produced faces yet";
      bucketSel.appendChild(opt);
    } else if ([...bucketSel.options].some((o) => o.value === prevBucket)) {
      bucketSel.value = prevBucket;
    }
    this.refreshQueryRoles(target);
  }

  private refreshQueryRoles(row?: Element | null): void {
    const target = row ?? this.paramsEl.querySelector(".compose-query-row");
    const bucketSel = target?.querySelector<HTMLSelectElement>("select[data-name=\"queryBucket\"]");
    const roleSel = target?.querySelector<HTMLSelectElement>("select[data-name=\"queryRole\"]");
    if (!bucketSel || !roleSel) return;
    const bucket = this.queryBuckets.find((b) => String(b.op) === bucketSel.value);
    const prevRole = roleSel.value;
    roleSel.innerHTML = "";
    for (const role of Object.keys(bucket?.roles ?? {})) {
      const opt = document.createElement("option");
      opt.value = role;
      opt.textContent = role;
      roleSel.appendChild(opt);
    }
    if ([...roleSel.options].some((o) => o.value === prevRole)) roleSel.value = prevRole;
  }

  /**
   * The "pin selection as query" row for face-operand forms (`extrude`,
   * `revolve`, `shell`, `draft` — see `QUERYABLE_PANEL_FORMS`): a producing-
   * bucket picker plus a Synthesize button. The panel owns only the bucket
   * coordinates; the wiring reads the live selection, runs the host round
   * trip, and stages the result — the row itself never sees entity ids, which
   * is what keeps it from duplicating `buildOpForPanel`'s operand mapping.
   */
  private queryRow(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "compose-query-row";
    const label = document.createElement("span");
    label.className = "compose-label";
    label.textContent = "Pin query";
    label.title = "Name the selected face as a stored operand query against a produced-faces bucket, so the reference survives renumbering by later edits. Face operands only; select exactly one face.";
    wrap.appendChild(label);
    const bucketSel = document.createElement("select");
    bucketSel.className = "compose-select";
    bucketSel.dataset.name = "queryBucket";
    bucketSel.title = "Producing op whose bucket names the selected face";
    wrap.appendChild(bucketSel);
    const roleSel = document.createElement("select");
    roleSel.className = "compose-select";
    roleSel.dataset.name = "queryRole";
    roleSel.title = "Bucket role the selected face was produced under";
    wrap.appendChild(roleSel);
    bucketSel.addEventListener("change", () => this.refreshQueryRoles());
    const btn = document.createElement("button");
    btn.className = "compose-apply";
    btn.textContent = "Synthesize";
    btn.title = "Induce a query naming the selected face against this bucket (host round trip)";
    btn.addEventListener("click", () => {
      // An empty bucket picker (no produced faces yet) must refuse locally —
      // `Number("")` is 0, which would post a doomed round trip for op 0.
      if (bucketSel.value === "" || roleSel.value === "") return;
      const op = Number(bucketSel.value);
      if (!Number.isInteger(op)) return;
      this.cb.onSynthesizeQuery(op, roleSel.value);
    });
    wrap.appendChild(btn);
    const result = document.createElement("div");
    result.className = "compose-query-result";
    result.dataset.name = "queryResult";
    wrap.appendChild(result);
    this.refreshQueryRow(wrap);
    return wrap;
  }

  /** Renders the synthesize outcome into the open form's query row: the staged
   * query summary, or the kernel's honest refusal. Cleared whenever the form
   * re-renders (a fresh row starts blank — the staged query itself lives in
   * the wiring's pending state, not here). */
  showQueryResult(text: string, isError = false): void {
    const el = this.paramsEl.querySelector("[data-name=\"queryResult\"]");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("error", isError);
  }

  /** Disables the Synthesize button while a round trip is in flight, so a
   * second click can't interleave two inductions for the same row. */
  setQueryBusy(busy: boolean): void {
    const row = this.paramsEl.querySelector(".compose-query-row");
    const btn = row?.querySelector<HTMLButtonElement>("button");
    if (!btn) return;
    btn.disabled = busy;
    btn.textContent = busy ? "Synthesizing…" : "Synthesize";
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
   * Renders the op-history timeline: the applied ops, then — when the redo
   * buffer is non-empty — its ops as additional, visually dimmed pending rows
   * with continued numbering (op-history scrubbing, roadmap Tier 2 item 1).
   * Every row (applied or pending) is clickable and jumps the stack straight
   * to that point in one splice via `onJumpTo`; the ✕ remove button still
   * works per applied row (it stops propagation so removing never also
   * jumps). The optional `opOutcomes` (the most recent replay's per-op
   * results — see `editOps.ts`'s `OpOutcome`) marks an op that gracefully
   * skipped: its row gets a ⚠ marker (tooltip = diagnostic + hint) and a
   * dimmed style, so "the model just didn't change" is at least visible
   * WHERE it happened rather than silent. Rows with no matching outcome
   * render unmarked (e.g. before any replay has run).
   *
   * `redoOps` must be in CHRONOLOGICAL order (`EditsModel.redoList()`), i.e.
   * the order the pending ops would re-apply — matching the timeline indices
   * `onJumpTo` receives.
   *
   * `opBuckets` (roadmap "Selector synthesis" Phase 1 — the most recent
   * replay's per-op produced-face classification, see `src/opBuckets.ts`)
   * gives applied rows a `+N` chip: title = the role summary
   * (`bucketSummary`) plus the recorded ids, click = transiently highlight
   * those faces via `onHighlightBucket` (click again to clear). The ids are
   * valid against the model state at their own op's step — later ops may
   * have renumbered them — so the chip tooltip says so.
   */
  render(ops: EditOp[], canUndo: boolean, canRedo: boolean, opOutcomes?: OpOutcome[] | null, redoOps?: EditOp[], opBuckets?: OpBucket[] | null): void {
    this.undoBtn.disabled = !canUndo;
    this.redoBtn.disabled = !canRedo;
    this.clearBtn.disabled = ops.length === 0 && (redoOps?.length ?? 0) === 0;

    const outcomeOf = new Map((opOutcomes ?? []).map((o) => [o.index, o]));
    const bucketOf = new Map((opBuckets ?? []).map((b) => [b.op, b]));
    // A re-render resets the chip toggle — most render triggers coincide with
    // a model rebuild + `refreshColors()`, which already restores the real
    // selection's rendering.
    this.activeBucketOp = null;

    this.body.innerHTML = "";
    if (ops.length === 0 && (redoOps?.length ?? 0) === 0) {
      const empty = document.createElement("div");
      empty.className = "edits-empty";
      empty.textContent = "No edits — the source file is shown unchanged.";
      this.body.appendChild(empty);
      return;
    }

    const ol = document.createElement("ol");
    ol.className = "edits-list";
    const row = (
      op: EditOp,
      i: number,
      opts: { pending: boolean; outcome?: OpOutcome; bucket?: OpBucket }
    ): void => {
      const li = document.createElement("li");
      li.className = opts.pending ? "edit-row edit-row-pending" : "edit-row";
      // Any row click scrubs the timeline to that point. Applied rows roll
      // back past themselves; pending rows re-apply through them. Clicking
      // the LAST applied row is a natural no-op inside jumpTo.
      li.title = opts.pending ? "Click to re-apply through this step" : "";
      li.addEventListener("click", () => this.cb.onJumpTo(i));
      const outcome = opts.outcome;
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
      li.appendChild(idx);
      li.appendChild(label);
      if (!opts.pending) {
        const del = document.createElement("button");
        del.className = "edit-remove";
        del.innerHTML = TOOLBAR_ICONS.close;
        del.title = "Remove this edit";
        del.addEventListener("click", (e) => {
          e.stopPropagation(); // removing must not also jump to this row's position
          this.cb.onRemoveOp(i);
        });
        // A skipped op's warning marker sits between the label and the remove
        // button so it can't be mistaken for a row-level action.
        if (outcome && !outcome.applied) {
          const warn = document.createElement("span");
          warn.className = "edit-skip-warning";
          warn.textContent = "⚠";
          li.appendChild(warn);
        }
        const bucket = opts.bucket;
        if (bucket) {
          const allIds = Object.values(bucket.roles).flat();
          const chip = document.createElement("button");
          chip.className = "edit-bucket";
          chip.textContent = `+${allIds.length}`;
          const summary = bucketSummary(bucket.roles);
          chip.title = `Produced: ${summary}\n(${allIds.join(", ")})\nIds are as of this op's own step — later edits may renumber them. Click to highlight.`;
          chip.addEventListener("click", (e) => {
            e.stopPropagation(); // highlighting must not also jump to this row
            if (this.activeBucketOp === bucket.op) {
              this.activeBucketOp = null;
              chip.classList.remove("active");
              this.cb.onHighlightBucket(null);
            } else {
              // Only one chip highlights at a time — clear any previous one's
              // visual state directly (rows aren't re-rendered on a click).
              for (const el of this.body.querySelectorAll(".edit-bucket.active")) el.classList.remove("active");
              this.activeBucketOp = bucket.op;
              chip.classList.add("active");
              this.cb.onHighlightBucket(allIds);
            }
          });
          li.appendChild(chip);
        }
        li.appendChild(del);
      } else {
        const redoMark = document.createElement("span");
        redoMark.className = "edit-pending-mark";
        redoMark.textContent = "↷";
        li.appendChild(redoMark);
      }
      ol.appendChild(li);
    };
    ops.forEach((op, i) => row(op, i, { pending: false, outcome: outcomeOf.get(i), bucket: bucketOf.get(i) }));
    (redoOps ?? []).forEach((op, k) => row(op, ops.length + k, { pending: true }));
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

    // Live-preview trigger: ONE delegated listener for every field in every
    // form (never per-field wiring). Point-list add/remove buttons change the
    // draft without an `input` event, so they get a click hook too.
    this.paramsEl.addEventListener("input", () => {
      if (this.draftReader) this.cb.onPreviewDraftChanged();
    });
    this.paramsEl.addEventListener("click", (e) => {
      const t = e.target as HTMLElement | null;
      if (this.draftReader && t?.closest(".point-add, .point-remove")) this.cb.onPreviewDraftChanged();
    });

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
    // nothing was previewing. Fired BEFORE the replacement form renders, and
    // before the explode-preview cancel, so nothing stale survives either.
    this.cb.onPreviewCancel();
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
    this.pendingApplyRow = null;
    const id = this.activeOp;
    if (!id) return;

    switch (id) {
      // ── EDIT · transform ──
      case "translate":
        f.appendChild(this.vecField("vec", "Δ", [0, 0, 0]));
        this.applyButtonDraft("Apply", "Apply to the selected volumes", (): TransformDraft => ({ kind: "translate", vec: this.readVec("vec") }), (d) => this.cb.onApplyTransform(d));
        break;
      case "rotate":
        f.appendChild(this.vecField("axisPoint", "Point", [0, 0, 0]));
        f.appendChild(this.vecField("axisDir", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("angleDeg", "Angle°", 90));
        this.applyButtonDraft("Apply", "Apply to the selected volumes", (): TransformDraft => ({
            kind: "rotate", axisPoint: this.readVec("axisPoint"),
            axisDir: this.readVec("axisDir"), angleDeg: this.readNum("angleDeg"),
          }), (d) => this.cb.onApplyTransform(d));
        break;
      case "scale":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("factors", "Scale", [1, 1, 1]));
        this.applyButtonDraft("Apply", "Apply to the selected volumes", (): TransformDraft => ({
            kind: "scale", center: this.readVec("center"), factors: this.readVec("factors"),
          }), (d) => this.cb.onApplyTransform(d));
        break;
      case "mirror":
        f.appendChild(this.planeSelectField());
        f.appendChild(this.vecField("planePoint", "Point", [0, 0, 0]));
        f.appendChild(this.vecField("planeNormal", "Normal", [1, 0, 0]));
        this.applyButtonDraft("Apply", "Apply to the selected volumes", (): TransformDraft => {
            const planeId = this.readPlaneId();
            const draft: TransformDraft = { kind: "mirror", planePoint: this.readVec("planePoint"), planeNormal: this.readVec("planeNormal") } as TransformDraft;
            if (planeId) (draft as any).planeId = planeId;
            return draft;
          }, (d) => this.cb.onApplyTransform(d));
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
        this.applyButtonDraft("Apply", "Apply to the selected edges (Line mode)", (): { kind: "fillet"; amount: number } => ({ kind: "fillet", amount: this.readNum("amount") }), (d) => this.cb.onApplyFillet(d.kind, d.amount));
        break;
      case "chamfer":
        f.appendChild(this.hint("Bevels the selected edges (Line mode)"));
        f.appendChild(this.numField("amount", "Setback", 1));
        this.applyButtonDraft("Apply", "Apply to the selected edges (Line mode)", (): { kind: "chamfer"; amount: number } => ({ kind: "chamfer", amount: this.readNum("amount") }), (d) => this.cb.onApplyFillet(d.kind, d.amount));
        break;

      // ── EDIT · features ──
      case "extrude":
        f.appendChild(this.hint("Profile = selected face (Surf mode), or selected edges (Line mode)"));
        f.appendChild(this.vecField("dir", "Dir", [0, 0, 1]));
        f.appendChild(this.numField("length", "Length", 10));
        f.appendChild(this.terminatorRow());
        this.thinFields(f);
        f.appendChild(this.queryRow());
        this.applyButtonDraft("Apply", "Build the feature from the selected face", (): FeatureDraft => ({ kind: "extrude", dir: this.readVec("dir"), length: this.readNum("length"), ...this.readThin() }), (d) => this.cb.onApplyFeature(d));
        break;
      case "revolve":
        f.appendChild(this.hint("Profile = selected face (Surf mode), or selected edges (Line mode)"));
        f.appendChild(this.vecField("axisPoint", "Point", [0, 0, 0]));
        f.appendChild(this.vecField("axisDir", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("angleDeg", "Angle°", 360));
        this.thinFields(f);
        f.appendChild(this.queryRow());
        this.applyButtonDraft("Apply", "Build the feature from the selected face", (): FeatureDraft => ({
            kind: "revolve", axisPoint: this.readVec("axisPoint"),
            axisDir: this.readVec("axisDir"), angleDeg: this.readNum("angleDeg"), ...this.readThin(),
          }), (d) => this.cb.onApplyFeature(d));
        break;
      case "sweep":
        f.appendChild(this.hint("Profile = selected face · path = selected edge. For an edge profile, capture the path first."));
        f.appendChild(this.sweepPathRow());
        this.thinFields(f);
        this.applyButtonDraft("Apply", "Build the feature from the selected profile + path", (): FeatureDraft => ({ kind: "sweep", ...this.readThin() }), (d) => this.cb.onApplyFeature(d));
        break;
      case "loft":
        f.appendChild(this.hint("Profiles = 2+ selected faces, or capture one section at a time"));
        f.appendChild(this.loftSectionRow());
        f.appendChild(this.boolField("smoothing", "Smooth", false));
        this.thinFields(f);
        this.applyButtonDraft("Apply", "Build the feature from the loft sections", (): FeatureDraft => ({ kind: "loft", ...(this.readBool("smoothing") ? { smoothing: true as const } : {}), ...this.readThin() }), (d) => this.cb.onApplyFeature(d));
        break;
      case "rib":
        f.appendChild(this.hint("Spine = selected open wire (Line mode) · terminator = captured face"));
        f.appendChild(this.vecField("dir", "Dir", [0, 0, 1]));
        f.appendChild(this.numField("thin", "Wall", 2));
        f.appendChild(this.numField("blendRadius", "Blend", 0));
        f.appendChild(this.hint("Wall is required (a rib without thickness encloses nothing). Blend 0 = fuse only."));
        f.appendChild(this.ribTerminatorRow());
        this.applyButtonDraft("Apply", "Build the rib from the selected spine edges", (): FeatureDraft => ({ kind: "rib", dir: this.readVec("dir"), blendRadius: this.readNum("blendRadius"), ...this.readThin() }), (d) => this.cb.onApplyFeature(d));
        break;

      // ── EDIT · modify ──
      case "shell":
        f.appendChild(this.hint("Hollows the solids owning the selected faces; the faces become openings (Surf mode)"));
        f.appendChild(this.numField("thickness", "Thickness", -1));
        f.appendChild(this.hint("Negative = walls grow inward (hollow); positive = outward"));
        f.appendChild(this.queryRow());
        this.applyButtonDraft("Apply", "Shell the solids owning the selected opening faces", (): ModifyDraft => ({ kind: "shell", thickness: this.readNum("thickness") }), (d) => this.cb.onApplyModify(d));
        break;
      case "draft":
        f.appendChild(this.hint("Tapers the selected faces (Surf mode) by the angle around the neutral plane"));
        f.appendChild(this.numField("angleDeg", "Angle°", 5));
        f.appendChild(this.hint("Leave Point/Normal at 0 to use each face's own plane — or pick a saved plane"));
        f.appendChild(this.planeSelectField());
        f.appendChild(this.vecField("planePoint", "Point", [0, 0, 0]));
        f.appendChild(this.vecField("planeNormal", "Normal", [0, 0, 0]));
        f.appendChild(this.queryRow());
        this.applyButtonDraft("Apply", "Draft the selected faces", (): ModifyDraft => {
          const planeId = this.readPlaneId();
          if (planeId) {
            return { kind: "draft", angleDeg: this.readNum("angleDeg"), planeId, planePoint: this.readVec("planePoint"), planeNormal: this.readVec("planeNormal") } as ModifyDraft;
          }
          const planePoint = this.readVec("planePoint");
          const planeNormal = this.readVec("planeNormal");
          const isZero = (v: Vec3) => v[0] === 0 && v[1] === 0 && v[2] === 0;
          const draft: ModifyDraft = { kind: "draft", angleDeg: this.readNum("angleDeg") } as ModifyDraft;
          if (!isZero(planePoint) && !isZero(planeNormal)) { (draft as any).planePoint = planePoint; (draft as any).planeNormal = planeNormal; }
          return draft;
        }, (d) => this.cb.onApplyModify(d));
        break;
      case "splitByPlane":
        f.appendChild(this.hint("Splits the selected volumes (Vol mode) by the plane"));
        f.appendChild(this.planeSelectField());
        f.appendChild(this.vecField("planePoint", "Point", [0, 0, 0]));
        f.appendChild(this.vecField("planeNormal", "Normal", [0, 0, 1]));
        f.appendChild(this.enumField("keep", "Keep", [
          ["both", "Both"], ["positive", "Normal side"], ["negative", "Other side"],
        ], "both"));
        this.applyButtonDraft("Apply", "Split the selected volumes by the plane", (): ModifyDraft => {
            const planeId = this.readPlaneId();
            const draft: ModifyDraft = {
              kind: "splitByPlane", planePoint: this.readVec("planePoint"),
              planeNormal: this.readVec("planeNormal"),
              keep: this.readEnum("keep", "both") as "both" | "positive" | "negative",
            } as ModifyDraft;
            if (planeId) (draft as any).planeId = planeId;
            return draft;
          }, (d) => this.cb.onApplyModify(d));
        break;
      case "section":
        f.appendChild(this.hint("Adds the planar cross-section of the selected volumes (Vol mode) as a sketch face"));
        f.appendChild(this.planeSelectField());
        f.appendChild(this.vecField("planePoint", "Point", [0, 0, 0]));
        f.appendChild(this.vecField("planeNormal", "Normal", [0, 0, 1]));
        this.applyButtonDraft("Apply", "Add the cross-section face (the solids stay untouched)", (): ModifyDraft => {
            const planeId = this.readPlaneId();
            const draft: ModifyDraft = {
              kind: "section", planePoint: this.readVec("planePoint"), planeNormal: this.readVec("planeNormal"),
            } as ModifyDraft;
            if (planeId) (draft as any).planeId = planeId;
            return draft;
          }, (d) => this.cb.onApplyModify(d));
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
        this.applyButtonDraft("Apply", "Align the first selected face onto the second", () => ({}), () => this.cb.onApplyMate());
        break;
      case "align":
        f.appendChild(this.hint("Moves the selected volumes (Vol mode) along an axis to an absolute coordinate"));
        f.appendChild(this.enumField("axis", "Axis", [["x", "X"], ["y", "Y"], ["z", "Z"]], "z"));
        f.appendChild(this.enumField("extent", "Extent", [
          ["min", "Min"], ["center", "Center"], ["max", "Max"],
        ], "min"));
        f.appendChild(this.numField("to", "To", 0));
        this.applyButtonDraft("Apply", "Align the selected volumes", (): AlignDraft => ({
            axis: this.readEnum("axis", "z") as "x" | "y" | "z",
            extent: this.readEnum("extent", "min") as "min" | "center" | "max",
            to: this.readNum("to"),
          }), (d) => this.cb.onApplyAlign(d));
        break;
      case "patternLinear":
        f.appendChild(this.hint("Arrays the selected volumes (Vol mode) along a direction"));
        f.appendChild(this.vecField("direction", "Dir", [1, 0, 0]));
        f.appendChild(this.numField("spacing", "Spacing", 10));
        f.appendChild(this.numField("count", "Count", 3));
        this.applyButtonDraft("Apply", "Pattern the selected volumes", (): PatternDraft => ({
            kind: "patternLinear", direction: this.readVec("direction"),
            spacing: this.readNum("spacing"), count: this.readNum("count"),
          }), (d) => this.cb.onApplyPattern(d));
        break;
      case "patternCircular":
        f.appendChild(this.hint("Arrays the selected volumes (Vol mode) around an axis"));
        f.appendChild(this.vecField("axisPoint", "Point", [0, 0, 0]));
        f.appendChild(this.vecField("axisDir", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("angleDeg", "Angle°", 60));
        f.appendChild(this.numField("count", "Count", 6));
        this.applyButtonDraft("Apply", "Pattern the selected volumes", (): PatternDraft => ({
            kind: "patternCircular", axisPoint: this.readVec("axisPoint"),
            axisDir: this.readVec("axisDir"), angleDeg: this.readNum("angleDeg"),
            count: this.readNum("count"),
          }), (d) => this.cb.onApplyPattern(d));
        break;

      // ── GEOMETRY 2D · wireframe ──
      case "addPoint":
        f.appendChild(this.vecField("position", "Position", [0, 0, 0]));
        this.applyButtonDraft("Add", "Add a new standalone point (no selection needed)", (): WireframeDraft => ({ kind: "addPoint", position: this.readVec("position") }), (d) => this.cb.onApplyWireframe(d));
        break;
      case "addLine":
        f.appendChild(this.vecField("start", "Start", [0, 0, 0]));
        f.appendChild(this.vecField("end", "End", [10, 0, 0]));
        this.applyButtonDraft("Add", "Add a new standalone line (no selection needed)", (): WireframeDraft => ({ kind: "addLine", start: this.readVec("start"), end: this.readVec("end") }), (d) => this.cb.onApplyWireframe(d));
        break;
      case "addArc":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("normal", "Normal", [0, 0, 1]));
        f.appendChild(this.numField("radius", "Radius", 5));
        f.appendChild(this.numField("startAngleDeg", "Start°", 0));
        f.appendChild(this.numField("endAngleDeg", "End°", 180));
        this.applyButtonDraft("Add", "Add a new standalone arc (no selection needed)", (): WireframeDraft => ({
            kind: "addArc", center: this.readVec("center"), normal: this.readVec("normal"),
            radius: this.readNum("radius"), startAngleDeg: this.readNum("startAngleDeg"),
            endAngleDeg: this.readNum("endAngleDeg"),
          }), (d) => this.cb.onApplyWireframe(d));
        break;

      // ── GEOMETRY 2D · curves ──
      case "addPolyline":
        f.appendChild(this.pointListField("points", "Points", [[0, 0, 0], [10, 0, 0], [10, 10, 0]], 2));
        f.appendChild(this.boolField("closed", "Closed", false));
        this.applyButtonDraft("Add", "Add a new standalone polyline (no selection needed)", (): WireframeDraft => ({
            kind: "addPolyline", points: this.readPoints("points"), closed: this.readBool("closed"),
          }), (d) => this.cb.onApplyWireframe(d));
        break;
      case "addThreePointArc":
        f.appendChild(this.vecField("p1", "Start", [0, 0, 0]));
        f.appendChild(this.vecField("p2", "Through", [5, 5, 0]));
        f.appendChild(this.vecField("p3", "End", [10, 0, 0]));
        this.applyButtonDraft("Add", "Add a circular arc through the three points (no selection needed)", (): WireframeDraft => ({
            kind: "addThreePointArc", p1: this.readVec("p1"), p2: this.readVec("p2"), p3: this.readVec("p3"),
          }), (d) => this.cb.onApplyWireframe(d));
        break;
      case "addSpline":
        f.appendChild(this.hint("Smooth curve through the points (endpoint-exact fit)"));
        f.appendChild(this.pointListField("points", "Points", [[0, 0, 0], [5, 5, 0], [10, 0, 0]], 2));
        this.applyButtonDraft("Add", "Add a new standalone spline (no selection needed)", (): WireframeDraft => ({ kind: "addSpline", points: this.readPoints("points") }), (d) => this.cb.onApplyWireframe(d));
        break;
      case "addBezier":
        f.appendChild(this.hint("Passes through the first and last control point only"));
        f.appendChild(this.pointListField("controlPoints", "Ctrl pts", [[0, 0, 0], [5, 10, 0], [10, 0, 0]], 2));
        this.applyButtonDraft("Add", "Add a new standalone Bézier curve (no selection needed)", (): WireframeDraft => ({ kind: "addBezier", controlPoints: this.readPoints("controlPoints") }), (d) => this.cb.onApplyWireframe(d));
        break;
      case "addEllipseArc":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("normal", "Normal", [0, 0, 1]));
        f.appendChild(this.vecField("up", "Up", [1, 0, 0]));
        f.appendChild(this.numField("radiusX", "Radius X", 8));
        f.appendChild(this.numField("radiusY", "Radius Y", 5));
        f.appendChild(this.numField("startAngleDeg", "Start°", 0));
        f.appendChild(this.numField("endAngleDeg", "End°", 180));
        this.applyButtonDraft("Add", "Add a new standalone elliptical arc (no selection needed)", (): WireframeDraft => ({
            kind: "addEllipseArc", center: this.readVec("center"), normal: this.readVec("normal"),
            up: this.readVec("up"), radiusX: this.readNum("radiusX"), radiusY: this.readNum("radiusY"),
            startAngleDeg: this.readNum("startAngleDeg"), endAngleDeg: this.readNum("endAngleDeg"),
          }), (d) => this.cb.onApplyWireframe(d));
        break;
      case "addHelix":
        f.appendChild(this.vecField("center", "Base", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("radius", "Radius", 5));
        f.appendChild(this.numField("pitch", "Pitch", 3));
        f.appendChild(this.numField("turns", "Turns", 3));
        this.applyButtonDraft("Add", "Add a new standalone helix (no selection needed)", (): WireframeDraft => ({
            kind: "addHelix", center: this.readVec("center"), axis: this.readVec("axis"),
            radius: this.readNum("radius"), pitch: this.readNum("pitch"), turns: this.readNum("turns"),
          }), (d) => this.cb.onApplyWireframe(d));
        break;

      // ── GEOMETRY 2D · sketch profiles ──
      case "addCircleProfile":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("normal", "Normal", [0, 0, 1]));
        f.appendChild(this.numField("radius", "Radius", 5));
        this.applyButtonDraft("Sketch", SKETCH_TITLE, (): ProfileDraft => ({
            kind: "addCircleProfile", center: this.readVec("center"),
            normal: this.readVec("normal"), radius: this.readNum("radius"),
          }), (d) => this.cb.onApplyProfile(d));
        break;
      case "addRectangleProfile":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("normal", "Normal", [0, 0, 1]));
        f.appendChild(this.vecField("up", "Up", [1, 0, 0]));
        f.appendChild(this.numField("width", "Width", 10));
        f.appendChild(this.numField("height", "Height", 6));
        this.applyButtonDraft("Sketch", SKETCH_TITLE, (): ProfileDraft => ({
            kind: "addRectangleProfile", center: this.readVec("center"), normal: this.readVec("normal"),
            up: this.readVec("up"), width: this.readNum("width"), height: this.readNum("height"),
          }), (d) => this.cb.onApplyProfile(d));
        break;
      case "addPolygonProfile":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("normal", "Normal", [0, 0, 1]));
        f.appendChild(this.vecField("up", "Up", [1, 0, 0]));
        f.appendChild(this.numField("radius", "Radius", 5));
        f.appendChild(this.numField("sides", "Sides", 6));
        this.applyButtonDraft("Sketch", SKETCH_TITLE, (): ProfileDraft => ({
            kind: "addPolygonProfile", center: this.readVec("center"), normal: this.readVec("normal"),
            up: this.readVec("up"), radius: this.readNum("radius"), sides: this.readNum("sides"),
          }), (d) => this.cb.onApplyProfile(d));
        break;
      case "addEllipseProfile":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("normal", "Normal", [0, 0, 1]));
        f.appendChild(this.vecField("up", "Up", [1, 0, 0]));
        f.appendChild(this.numField("radiusX", "Radius X", 8));
        f.appendChild(this.numField("radiusY", "Radius Y", 5));
        this.applyButtonDraft("Sketch", SKETCH_TITLE, (): ProfileDraft => ({
            kind: "addEllipseProfile", center: this.readVec("center"), normal: this.readVec("normal"),
            up: this.readVec("up"), radiusX: this.readNum("radiusX"), radiusY: this.readNum("radiusY"),
          }), (d) => this.cb.onApplyProfile(d));
        break;
      case "addRoundedRectangleProfile":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("normal", "Normal", [0, 0, 1]));
        f.appendChild(this.vecField("up", "Up", [1, 0, 0]));
        f.appendChild(this.numField("width", "Width", 10));
        f.appendChild(this.numField("height", "Height", 6));
        f.appendChild(this.numField("cornerRadius", "Corner r", 1));
        this.applyButtonDraft("Sketch", SKETCH_TITLE, (): ProfileDraft => ({
            kind: "addRoundedRectangleProfile", center: this.readVec("center"), normal: this.readVec("normal"),
            up: this.readVec("up"), width: this.readNum("width"), height: this.readNum("height"),
            cornerRadius: this.readNum("cornerRadius"),
          }), (d) => this.cb.onApplyProfile(d));
        break;
      case "addSlotProfile":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("normal", "Normal", [0, 0, 1]));
        f.appendChild(this.vecField("up", "Up", [1, 0, 0]));
        f.appendChild(this.numField("length", "Length", 12));
        f.appendChild(this.numField("width", "Width", 4));
        this.applyButtonDraft("Sketch", SKETCH_TITLE, (): ProfileDraft => ({
            kind: "addSlotProfile", center: this.readVec("center"), normal: this.readVec("normal"),
            up: this.readVec("up"), length: this.readNum("length"), width: this.readNum("width"),
          }), (d) => this.cb.onApplyProfile(d));
        break;
      case "addTrapezoidProfile":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("normal", "Normal", [0, 0, 1]));
        f.appendChild(this.vecField("up", "Up", [1, 0, 0]));
        f.appendChild(this.numField("bottomWidth", "Bottom w", 10));
        f.appendChild(this.numField("topWidth", "Top w", 6));
        f.appendChild(this.numField("height", "Height", 5));
        this.applyButtonDraft("Sketch", SKETCH_TITLE, (): ProfileDraft => ({
            kind: "addTrapezoidProfile", center: this.readVec("center"), normal: this.readVec("normal"),
            up: this.readVec("up"), bottomWidth: this.readNum("bottomWidth"),
            topWidth: this.readNum("topWidth"), height: this.readNum("height"),
          }), (d) => this.cb.onApplyProfile(d));
        break;

      // ── GEOMETRY 2D/3D · build from selection ──
      case "buildSurface":
        f.appendChild(this.hint("Select 3+ lines forming a closed loop (Line mode)"));
        this.applyButtonDraft("Build", "Build a flat face from the selected lines", () => ({}), () => this.cb.onBuildSurfaceFromLines());
        break;
      case "buildVolume":
        f.appendChild(this.hint("Select 4+ surfaces forming a closed shell (Surf mode)"));
        this.applyButtonDraft("Build", "Build a solid by sewing the selected surfaces", () => ({}), () => this.cb.onBuildVolumeFromSurfaces());
        break;
      case "edgeSlot":
        f.appendChild(this.hint("Select one edge (Line mode) to slot around"));
        f.appendChild(this.numField("width", "Width", 2));
        this.applyButtonDraft("Build", "Build a stadium slot around the selected edge", () => ({}) as any, () => {
          const width = this.readNum("width");
          this.cb.onBuildEdgeSlot(width);
        });
        break;

      // ── GEOMETRY 3D · primitives ──
      case "addBox":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("size", "Size", [10, 10, 10]));
        this.applyButtonDraft("Add", ADD_TITLE, (): PrimitiveDraft => ({ kind: "addBox", center: this.readVec("center"), size: this.readVec("size") }), (d) => this.cb.onApplyPrimitive(d));
        break;
      case "addSphere":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.numField("radius", "Radius", 5));
        this.applyButtonDraft("Add", ADD_TITLE, (): PrimitiveDraft => ({ kind: "addSphere", center: this.readVec("center"), radius: this.readNum("radius") }), (d) => this.cb.onApplyPrimitive(d));
        break;
      case "addCylinder":
        f.appendChild(this.vecField("center", "Base", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("radius", "Radius", 5));
        f.appendChild(this.numField("height", "Height", 10));
        this.applyButtonDraft("Add", ADD_TITLE, (): PrimitiveDraft => ({
            kind: "addCylinder", center: this.readVec("center"), axis: this.readVec("axis"),
            radius: this.readNum("radius"), height: this.readNum("height"),
          }), (d) => this.cb.onApplyPrimitive(d));
        break;
      case "addCone":
        f.appendChild(this.vecField("center", "Base", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("radius1", "Base r", 5));
        f.appendChild(this.numField("radius2", "Top r", 0));
        f.appendChild(this.numField("height", "Height", 10));
        this.applyButtonDraft("Add", ADD_TITLE, (): PrimitiveDraft => ({
            kind: "addCone", center: this.readVec("center"), axis: this.readVec("axis"),
            radius1: this.readNum("radius1"), radius2: this.readNum("radius2"), height: this.readNum("height"),
          }), (d) => this.cb.onApplyPrimitive(d));
        break;
      case "addTorus":
        f.appendChild(this.vecField("center", "Center", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("majorRadius", "Major r", 10));
        f.appendChild(this.numField("minorRadius", "Minor r", 2));
        this.applyButtonDraft("Add", ADD_TITLE, (): PrimitiveDraft => ({
            kind: "addTorus", center: this.readVec("center"), axis: this.readVec("axis"),
            majorRadius: this.readNum("majorRadius"), minorRadius: this.readNum("minorRadius"),
          }), (d) => this.cb.onApplyPrimitive(d));
        break;
      case "addPrism":
        f.appendChild(this.vecField("center", "Base", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, 1]));
        f.appendChild(this.numField("radius", "Radius", 5));
        f.appendChild(this.numField("sides", "Sides", 6));
        f.appendChild(this.numField("height", "Height", 10));
        this.applyButtonDraft("Add", ADD_TITLE, (): PrimitiveDraft => ({
            kind: "addPrism", center: this.readVec("center"), axis: this.readVec("axis"),
            radius: this.readNum("radius"), sides: this.readNum("sides"), height: this.readNum("height"),
          }), (d) => this.cb.onApplyPrimitive(d));
        break;
      case "addWedge":
        f.appendChild(this.vecField("center", "Base ctr", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, 1]));
        f.appendChild(this.vecField("up", "Up", [1, 0, 0]));
        f.appendChild(this.numField("dx", "Size X", 10));
        f.appendChild(this.numField("dy", "Size Y", 6));
        f.appendChild(this.numField("dz", "Height", 4));
        f.appendChild(this.numField("ltx", "Top X", 3));
        this.applyButtonDraft("Add", ADD_TITLE, (): PrimitiveDraft => ({
            kind: "addWedge", center: this.readVec("center"), axis: this.readVec("axis"),
            up: this.readVec("up"), dx: this.readNum("dx"), dy: this.readNum("dy"),
            dz: this.readNum("dz"), ltx: this.readNum("ltx"),
          }), (d) => this.cb.onApplyPrimitive(d));
        break;

      // ── GEOMETRY 3D · holes (subtractive — need selected target volumes) ──
      case "addHole":
        f.appendChild(this.hint("Cuts into the selected volumes (Vol mode)"));
        f.appendChild(this.holeStandardField());
        f.appendChild(this.vecField("position", "Mouth", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, -1]));
        f.appendChild(this.numField("radius", "Radius", 2));
        f.appendChild(this.numField("depth", "Depth", 10));
        this.applyButtonDraft("Cut", HOLE_TITLE, (): HoleDraft => ({
            kind: "addHole", position: this.readVec("position"), axis: this.readVec("axis"),
            radius: this.readNum("radius"), depth: this.readNum("depth"),
          }), (d) => this.cb.onApplyHole(d));
        break;
      case "addCounterboreHole":
        f.appendChild(this.hint("Cuts into the selected volumes (Vol mode)"));
        f.appendChild(this.holeStandardField());
        f.appendChild(this.vecField("position", "Mouth", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, -1]));
        f.appendChild(this.numField("radius", "Radius", 2));
        f.appendChild(this.numField("depth", "Depth", 10));
        f.appendChild(this.numField("cbRadius", "Bore r", 4));
        f.appendChild(this.numField("cbDepth", "Bore d", 3));
        this.applyButtonDraft("Cut", HOLE_TITLE, (): HoleDraft => ({
            kind: "addCounterboreHole", position: this.readVec("position"), axis: this.readVec("axis"),
            radius: this.readNum("radius"), depth: this.readNum("depth"),
            cbRadius: this.readNum("cbRadius"), cbDepth: this.readNum("cbDepth"),
          }), (d) => this.cb.onApplyHole(d));
        break;
      case "addCountersinkHole":
        f.appendChild(this.hint("Cuts into the selected volumes (Vol mode)"));
        f.appendChild(this.holeStandardField());
        f.appendChild(this.vecField("position", "Mouth", [0, 0, 0]));
        f.appendChild(this.vecField("axis", "Axis", [0, 0, -1]));
        f.appendChild(this.numField("radius", "Radius", 2));
        f.appendChild(this.numField("depth", "Depth", 10));
        f.appendChild(this.numField("csRadius", "Sink r", 4));
        f.appendChild(this.numField("csAngleDeg", "Angle°", 90));
        this.applyButtonDraft("Cut", HOLE_TITLE, (): HoleDraft => ({
            kind: "addCountersinkHole", position: this.readVec("position"), axis: this.readVec("axis"),
            radius: this.readNum("radius"), depth: this.readNum("depth"),
            csRadius: this.readNum("csRadius"), csAngleDeg: this.readNum("csAngleDeg"),
          }), (d) => this.cb.onApplyHole(d));
        break;
    }
    // Construction-geometry checkbox for every guide kind (2D profile + curve
    // creation): one generic field, read by `applyButtonDraft`'s wrapped
    // reader on both the Apply and preview paths. `guide` marks the built
    // entity reference-only — rendered dimmed and excluded from feature
    // profile resolution (roadmap item 10).
    if (id && GUIDE_KINDS.has(id as never)) f.appendChild(this.boolField("guide", "Construction (guide)", false));
    // The form's Apply row, registered by `applyButtonDraft` during the
    // switch above — appended here, after every param row, so no form can
    // silently render without its commit button (see its doc comment).
    if (this.pendingApplyRow) {
      f.appendChild(this.pendingApplyRow);
      this.pendingApplyRow = null;
    }
    // A freshly-opened form previews immediately from its default field
    // values — opening "Box" shows the default box before anything is typed.
    if (this.draftReader) this.cb.onPreviewDraftChanged();
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
    // The boolean form has no fields of its own — its draft is the captured-A
    // state plus the live selection, both read by the wiring's preview
    // builder. Registered so selection changes (not field input) refresh it.
    this.draftReader = () => ({});
  }

  // ── Field helpers ────────────────────────────────────────────────────────

  /**
   * The open form's draft reader, registered by {@link applyButtonDraft}
   * (and the boolean form): returns the SAME draft object the Apply button
   * would push, reading the live field values. `null` when no previewable
   * form is open (nothing open, or the Explode form, which keeps its own
   * slider preview and deliberately registers nothing).
   */
  private draftReader: (() => unknown) | null = null;

  /** The currently-open op button's id, or `null` when no form is open — the
   * preview engine's eligibility check and tint lookup read this. */
  openOpId(): PanelOpId | null {
    return this.activeOp;
  }

  /**
   * The open form's current draft, for the live operation preview. Re-reads
   * the fields fresh on every call (the same readers the Apply button uses,
   * so a preview can never disagree with what Apply would commit). Returns
   * `null` when nothing is previewable or any expression field currently
   * fails to evaluate — mid-edit invalid expressions skip the preview
   * silently rather than flashing the inline error the APPLY click shows.
   */
  currentDraft(): { id: PanelOpId; draft: Record<string, unknown> } | null {
    const reader = this.draftReader;
    const id = this.activeOp;
    if (!reader || id === null) return null;
    this.pendingExprs = {};
    this.pendingErrors = [];
    let draft: Record<string, unknown> = {} as Record<string, unknown>;
    try {
      draft = reader() as Record<string, unknown>;
    } finally {
      // Drain whatever this read collected — a preview read never leaves
      // state behind for the next APPLY click, and vice versa.
      const errors = this.pendingErrors;
      const exprs = { ...this.pendingExprs };
      this.pendingErrors = [];
      this.pendingExprs = {};
      if (errors.length > 0) return null;
      if (exprs && Object.keys(exprs).length > 0) draft = { ...draft, exprs };
    }
    return { id, draft };
  }

  /**
   * Creates the form's Apply button, appends it to the form (at the end of
   * `renderParams`, so it always lands after every param row), AND registers
   * its draft literal as the live-preview reader. The draft literal is the
   * EXACT object the Apply click pushes — read fresh from the fields on every
   * preview tick and on every Apply — which is what makes a preview
   * structurally incapable of drifting from what Apply would commit.
   *
   * The button is appended centrally (not at each call site) because an
   * earlier refactor dropped the `f.appendChild(...)` wrapper from every call
   * site at once, silently leaving every form without an Apply button — a
   * whole class of "dead surface" no test caught, since nothing ever asserted
   * the button exists. Centralizing the append makes that unrepeatable: a
   * form that registers a draft reader always renders its commit button.
   */
  private applyButtonDraft<D>(label: string, title: string, read: () => D, apply: (d: D) => void): void {
    // Construction-geometry checkbox: guide-kind forms get one generic
    // `guide` field appended after their params (see `renderParams`), read
    // here at the single seam BOTH the Apply click and the live preview
    // flow through — so a preview can never disagree with what Apply
    // commits, the same guarantee `applyButtonDraft` already gives.
    const wrappedRead = (): D => {
      const draft = read() as Record<string, unknown>;
      if (this.activeOp && GUIDE_KINDS.has(this.activeOp as never)) draft.guide = this.readBool("guide");
      return draft as D;
    };
    this.draftReader = wrappedRead as () => unknown;
    this.pendingApplyRow = this.applyButton(label, title, () => apply(wrappedRead()));
  }

  /** The Apply row the current form registered (appended centrally at the end
   * of `renderParams`). Reset on every render so a form without one (boolean,
   * explode) can never inherit the previous form's button. */
  private pendingApplyRow: HTMLElement | null = null;

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

  /**
   * Forgets the sweep path / loft sections and redraws the open form, so the
   * displayed capture state can't outlive the ids it names — those are
   * renumbered by the very op that just applied. Mirrors `renderBooleanForm`'s
   * own reset of `booleanACount` on Apply.
   */
  resetFeatureCaptures(): void {
    this.sweepPath = null;
    this.loftSectionCount = 0;
    this.terminator = null;
    this.ribTerminator = null;
    if (this.activeOp === "sweep" || this.activeOp === "loft" || this.activeOp === "extrude" || this.activeOp === "rib") this.renderParams();
  }

  /**
   * Extrude's optional terminator capture. The profile and the terminator are
   * both Surf-mode face picks, so one flat selection cannot express which
   * face terminates — capturing first disambiguates, exactly as `Set path`
   * does for sweep. With nothing captured, Length extrudes by the typed
   * amount, as before.
   */
  private terminatorRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "compose-row";
    const status = document.createElement("span");
    status.className = "compose-bool-a";
    const render = () => { status.textContent = this.terminator ? `to: ${this.terminator}` : "to: —"; };
    render();
    const set = document.createElement("button");
    set.className = "compose-apply";
    set.textContent = "Set terminator";
    set.title = "Capture the selected face as the up-to-face terminator, freeing the rest of the selection to be the profile";
    set.addEventListener("click", () => {
      this.terminator = this.cb.onCaptureTerminator();
      render();
      this.cb.onPreviewDraftChanged();
    });
    const clear = document.createElement("button");
    clear.className = "compose-apply";
    clear.textContent = "Clear";
    clear.title = "Forget the captured terminator";
    clear.addEventListener("click", () => {
      this.cb.onClearTerminator();
      this.terminator = null;
      render();
      this.cb.onPreviewDraftChanged();
    });
    row.appendChild(set);
    row.appendChild(clear);
    row.appendChild(status);
    return row;
  }

  /**
   * Sweep's optional path capture. A sweep's profile and its path are both
   * edge picks now that an open wire can be a profile, so the two cannot be
   * told apart from one flat Line-mode selection — capturing the path first
   * disambiguates, exactly as `Set A` does for a boolean's two volume sets.
   * With nothing captured, the form behaves as it always did: the selected
   * face is the profile and the selected edge is the path.
   */
  private sweepPathRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "compose-row";
    const status = document.createElement("span");
    status.className = "compose-bool-a";
    const render = () => { status.textContent = this.sweepPath ? `path: ${this.sweepPath}` : "path: —"; };
    render();
    const set = document.createElement("button");
    set.className = "compose-apply";
    set.textContent = "Set path";
    set.title = "Capture the selected edge as the sweep path, freeing the rest of the selection to be the profile";
    set.addEventListener("click", () => {
      this.sweepPath = this.cb.onCaptureSweepPath();
      render();
      this.cb.onPreviewDraftChanged();
    });
    const clear = document.createElement("button");
    clear.className = "compose-apply";
    clear.textContent = "Clear";
    clear.title = "Forget the captured path";
    clear.addEventListener("click", () => {
      this.cb.onClearSweepPath();
      this.sweepPath = null;
      render();
      this.cb.onPreviewDraftChanged();
    });
    row.appendChild(set);
    row.appendChild(clear);
    row.appendChild(status);
    return row;
  }

  /**
   * Rib's required terminator capture — a rib cannot apply without one (there
   * is no length to fall back on, unlike extrude's optional terminator).
   */
  private ribTerminatorRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "compose-row";
    const status = document.createElement("span");
    status.className = "compose-bool-a";
    const render = () => { status.textContent = this.ribTerminator ? `to: ${this.ribTerminator}` : "to: —"; };
    render();
    const set = document.createElement("button");
    set.className = "compose-apply";
    set.textContent = "Set terminator";
    set.title = "Capture the selected face as the rib terminator";
    set.addEventListener("click", () => {
      this.ribTerminator = this.cb.onCaptureRibTerminator();
      render();
      this.cb.onPreviewDraftChanged();
    });
    const clear = document.createElement("button");
    clear.className = "compose-apply";
    clear.textContent = "Clear";
    clear.title = "Forget the captured terminator";
    clear.addEventListener("click", () => {
      this.cb.onClearRibTerminator();
      this.ribTerminator = null;
      render();
      this.cb.onPreviewDraftChanged();
    });
    row.appendChild(set);
    row.appendChild(clear);
    row.appendChild(status);
    return row;
  }

  /**
   * Loft's optional per-section capture — the only way to give it OPEN
   * sections, since each one is a set of edges and a single flat selection
   * cannot express "these edges are section 1, those are section 2".
   * With nothing captured, the selected faces are the sections, as before.
   */
  private loftSectionRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "compose-row";
    const status = document.createElement("span");
    status.className = "compose-bool-a";
    const render = () => { status.textContent = this.loftSectionCount > 0 ? `sections: ${this.loftSectionCount}` : "sections: —"; };
    render();
    const add = document.createElement("button");
    add.className = "compose-apply";
    add.textContent = "Add section";
    add.title = "Capture the current selection (a face, or a set of edges) as one loft section";
    add.addEventListener("click", () => {
      this.loftSectionCount = this.cb.onCaptureLoftSection();
      render();
      this.cb.onPreviewDraftChanged();
    });
    const clear = document.createElement("button");
    clear.className = "compose-apply";
    clear.textContent = "Clear";
    clear.title = "Forget every captured section";
    clear.addEventListener("click", () => {
      this.cb.onClearLoftSections();
      this.loftSectionCount = 0;
      render();
      this.cb.onPreviewDraftChanged();
    });
    row.appendChild(add);
    row.appendChild(clear);
    row.appendChild(status);
    return row;
  }

  /**
   * The shared thin-wall fields for the four sweep-family forms. `Wall` = 0 is
   * the sentinel for "not thin" (the same leave-it-at-the-default convention
   * `draft`'s Point/Normal use), so an untouched form builds today's filled
   * solid exactly as before.
   */
  private thinFields(f: HTMLElement): void {
    f.appendChild(this.numField("thin", "Wall", 0));
    f.appendChild(this.numField("thinOuter", "Outward", 0));
    f.appendChild(this.hint("Wall 0 = solid. Outward = how much of the wall sits outside the profile (0 = all inward)."));
  }

  /** Reads the thin fields, omitting them entirely when Wall is 0/absent. */
  private readThin(): { thin?: number; thinOuter?: number } {
    const thin = this.readNum("thin");
    if (!Number.isFinite(thin) || thin <= 0) return {};
    const thinOuter = this.readNum("thinOuter");
    return Number.isFinite(thinOuter) && thinOuter > 0 ? { thin, thinOuter } : { thin };
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
   * A designation picker for the three hole ops (roadmap "Hole Wizard").
   *
   * Deliberately fills the EXISTING `radius`/`depth` number fields via
   * {@link setNumField} rather than introducing a new field type or a new draft
   * shape — the ops are entirely unchanged and remain plain numbers. Picking a
   * designation is a convenience that types for you; the fields stay editable
   * afterwards, and an expression typed into them still wins at Apply time.
   *
   * Offers both a tapped and a clearance option per size, because which is
   * wanted depends on intent and `holeStandards.ts` deliberately does not
   * guess (see its own doc comment).
   */
  private holeStandardField(): HTMLElement {
    const row = document.createElement("label");
    row.className = "compose-field";
    const span = document.createElement("span");
    span.className = "compose-label";
    span.textContent = "Standard";
    row.appendChild(span);

    const select = document.createElement("select");
    select.className = "compose-select";
    select.id = "hole-standard-select";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "Custom…";
    select.appendChild(none);

    for (const size of allHoleSizes()) {
      for (const fit of ["tap", "clearance"] as const) {
        const opt = document.createElement("option");
        const d = fit === "tap" ? size.tapDrillDiameter : size.clearanceDiameter;
        opt.value = `${size.designation}|${fit}`;
        opt.textContent = `${size.designation} ${fit === "tap" ? "tapped" : "clearance"} (⌀${d} mm)`;
        select.appendChild(opt);
      }
    }

    select.addEventListener("change", () => {
      const [designation, fit] = select.value.split("|");
      if (!designation) return;
      const size = findHoleSize(designation);
      if (!size) return;
      const diameter = fit === "tap" ? size.tapDrillDiameter : size.clearanceDiameter;
      this.setNumField("radius", diameter / 2);
      // A tapped hole gets a sensible blind depth too (1.5x diameter, the
      // typical steel rule); a clearance hole's depth depends on the stock,
      // not the thread, so it is left alone.
      if (fit === "tap") this.setNumField("depth", depthPresetsFor(size)[1].depth);
    });

    row.appendChild(select);
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
