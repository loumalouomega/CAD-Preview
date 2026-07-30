import * as THREE from "three";
import { Viewer } from "./viewer";
import { loadMeshFromUrl } from "./meshLoaders";
import type { CadFormat } from "../fileRouter";
import { exportModel } from "./meshExporters";
import { buildGroupFromEncoded, buildFEMesh, buildWorstElementsHighlight } from "./geometryBuilder";
import { splitMeshesIntoFacets } from "./meshFacets";
import { TreePanel } from "./treePanel";
import { PartsModel } from "./partsModel";
import { PartsPanel } from "./partsPanel";
import { EditsModel } from "./editsModel";
import { EditsPanel } from "./editsPanel";
import { VariablesModel } from "./variablesModel";
import { VariablesPanel } from "./variablesPanel";
import { evaluateVariables, resolveEditOps } from "../editVariables";
import { extractIdentifiers } from "../paramExpr";
import { MeshingModel } from "./meshingModel";
import { MeshingPanel } from "./meshingPanel";
import { MassPropertiesPanel, type MassPropertiesDisplay } from "./massPropertiesPanel";
import { computeMeshMassProperties } from "./meshMassProperties";
import { targetSizeForPreset } from "./meshSizeHeuristics";
import { SIZE_MAX_SENTINEL } from "../meshOptions";
import type { MeshSizePreset } from "../viewerDefaults";
import { applyEditsMesh } from "./meshEdits";
import { SelectionSet, type SelectedEntity } from "./selection";
import { VisibilityState } from "./visibilityState";
import { captureExplodeBase, applyExplodePreview, resetExplodePreview, type ExplodeBase } from "./explodePreview";
import { planeForAxis, type ClipAxis } from "./clipping";
import { MeasurementState, type MeasureTool, type MeasurementPick } from "./measurementState";
import { pointDistance, polylineLength, angleBetweenVectors, circleRadiusFromArcPoints, type Vec3 } from "./measurement";
import { convertLength, convertLengthBasedProperties, displayUnitFromStepName, type DisplayUnit, type LengthBasedProperties } from "./units";
import { isDisplayMode } from "./displayMode";
import { MarkupModel, type MarkupStroke, type MarkupTool, type Point } from "./markupModel";
import { redrawAll } from "./markupCanvas";
import { setupDropdown } from "./dropdownMenu";
import type { HostToWebview, WebviewToHost, TreeNode, EntityType, EditOp } from "../protocol";

declare function acquireVsCodeApi(): { postMessage(msg: WebviewToHost): void };

const vscode = acquireVsCodeApi();
const post = (msg: WebviewToHost) => vscode.postMessage(msg);

const app = document.getElementById("app")!;
const statusEl = document.getElementById("status")!;
const sideEl = document.getElementById("side")!;
const panelEl = document.getElementById("tree-panel")!;
const toggleBtn = document.getElementById("tree-toggle") as HTMLButtonElement;

const viewer = new Viewer(app);

// ── Visibility (Parts hide/isolate, Tree per-node hide) ─────────────────────
// Transient, session-only, never persisted — see visibilityState.ts.
const visibilityState = new VisibilityState();

const treePanel = new TreePanel(
  panelEl,
  (id) => {
    viewer.highlightGroup(id);
  },
  (id) => {
    visibilityState.toggleTreeGroupHidden(id);
    viewer.setGroupVisible(id, !visibilityState.isTreeGroupHidden(id));
    treePanel.refreshVisibility();
  },
  visibilityState
);

document.getElementById("tree-filter")?.addEventListener("input", (e) => {
  treePanel.filter((e.target as HTMLInputElement).value);
});

// ── Parts / selection state ──────────────────────────────────────────────
const selection = new SelectionSet();
let previewPartIndex: number | null = null;

const partsModel = new PartsModel(() => {
  // Fired on every parts mutation: persist, recolour, re-render (both the
  // Parts panel and the FE Mesh panel's mirrored "Part sizes" rows).
  post({ type: "partsChanged", parts: partsModel.list() });
  visibilityState.onPartCountChanged(partsModel.size);
  refreshColors(); // also re-applies visibility state, see refreshColors()
  partsPanel.render(partsModel.list());
  meshingPanel.renderParts(partsModel.list());
});

const partsPanel = new PartsPanel(
  document.getElementById("parts-panel")!,
  {
    onCreate: () => partsModel.create(),
    onAssign: (index) => {
      partsModel.assign(index, selection.list());
      selection.clear();
      previewPartIndex = null;
      renderHighlight();
    },
    onRemovePart: (index) => partsModel.remove(index),
    onRename: (index, name) => partsModel.rename(index, name),
    onRecolor: (index, color) => partsModel.recolor(index, color),
    onMeshSize: (index, size) => partsModel.setMeshSize(index, size),
    onRemoveEntity: (index, type, id) => partsModel.removeEntity(index, type, id),
    onSelectPart: (index) => {
      previewPartIndex = index;
      renderHighlight();
    },
    onToggleVisible: (index) => {
      visibilityState.toggleHiddenPart(index);
      applyVisibilityState();
      partsPanel.render(partsModel.list());
    },
    onToggleIsolate: (index) => {
      visibilityState.toggleIsolatedPart(index);
      applyVisibilityState();
      partsPanel.render(partsModel.list());
    },
  },
  visibilityState
);

// ── Edits (replayable op-stack) + parametric variables ───────────────────
// The webview owns the op-stack; the host persists it and (for B-rep) re-applies
// it via OCCT. Mesh edits are replayed locally by rebuilding from the pristine
// loaded object (see rebuildMeshModel).
//
// Resolution is on-read: `currentResolvedOps()` re-evaluates every op's
// expression annotations against the current variable values at every
// consumption point (post to host, panel render, mesh rebuild), so stale
// numbers are structurally impossible — including for ops sitting in the
// undo/redo buffers, which no eager patch pass could reach. The host receives
// only already-resolved ops.
const editsModel = new EditsModel(syncEdits);
const variablesModel = new VariablesModel(syncEdits);

/** The op list with every expression re-evaluated against the current variables. */
function currentResolvedOps(): { ops: EditOp[]; issues: string[] } {
  const { values } = evaluateVariables(variablesModel.list());
  return resolveEditOps(editsModel.list(), values);
}

/** How many op-expression fields reference each variable (for delete warnings). */
function variableUsage(): Map<string, number> {
  const usage = new Map<string, number>();
  for (const op of editsModel.list()) {
    for (const expr of Object.values(op.exprs ?? {})) {
      for (const ident of extractIdentifiers(expr)) {
        usage.set(ident, (usage.get(ident) ?? 0) + 1);
      }
    }
  }
  return usage;
}

/** Re-renders the Edits + Variables panels from the models (no host post). */
function renderEditsUi(): void {
  const { values, errors } = evaluateVariables(variablesModel.list());
  const { ops } = resolveEditOps(editsModel.list(), values);
  editsPanel.setVariables(values);
  editsPanel.render(ops, editsModel.canUndo, editsModel.canRedo);
  variablesPanel.render(variablesModel.list(), values, errors, variableUsage());
}

/** Fired on every op-stack or variable mutation: resolve, persist, re-display. */
function syncEdits(): void {
  const { ops, issues } = currentResolvedOps();
  post({ type: "editsChanged", ops, variables: variablesModel.list() });
  renderEditsUi();
  // Ops whose expressions can't resolve keep their last-good values — surface
  // the first problem without blocking the rest of the replay.
  if (issues.length > 0) setStatus(issues[0], true);
  if (pristineMesh) rebuildMeshModel();
}

const variablesPanel = new VariablesPanel(document.getElementById("variables-section")!, {
  onAdd: () => variablesModel.add(),
  onRename: (index, name) => variablesModel.rename(index, name),
  onSetExpr: (index, expr) => variablesModel.setExpr(index, expr),
  onRemove: (index) => variablesModel.remove(index),
});

/** Captured boolean operand A (volume ids); operand B is the live selection. */
let booleanA: string[] = [];
const selectedVolumes = (): string[] =>
  selection.list().filter((e) => e.entityType === "volume").map((e) => e.entityId);

/** Explode's live-preview state — `null` when no preview is in progress.
 * Captured lazily on the first slider `input` event (see `onExplodePreview`
 * below) so a session always starts from a fresh, pristine base. */
let explodePreviewBases: ExplodeBase[] | null = null;

/** Set by `setupMarkupControls()` once the Markup overlay is wired up;
 * called on every genuinely new model load (`case "geometry":`,
 * `loadMeshObjectFromUrl()`) — unlike the mesh/measurement overlays, markup
 * strokes aren't geometrically stale (they're plain screen-space pixels with
 * no reference to the model at all), but leaving them plastered over a
 * totally different part is confusing more often than useful, so a fresh
 * model load clears them, same as opening a new document resets every other
 * session-only display state. */
let clearMarkupOverlay: (() => void) | null = null;

/** Restores any in-progress Explode preview to its pristine positions and
 * clears the session — called both when the user leaves the Explode form
 * without applying, and right before the real op-stack commit (which
 * rebuilds everything from the authoritative op-list anyway). */
function cancelExplodePreview(): void {
  if (!explodePreviewBases) return;
  const model = viewer.getModel();
  if (model) resetExplodePreview(explodePreviewBases);
  explodePreviewBases = null;
}

const editsPanel = new EditsPanel(document.getElementById("edits-panel")!, {
  onUndo: () => editsModel.undo(),
  onRedo: () => editsModel.redo(),
  onClear: () => editsModel.clear(),
  onRemoveOp: (index) => editsModel.remove(index),
  onApplyTransform: (draft) => {
    // Transforms act on whole volumes. Use the selected volume ids; require at
    // least one so an edit is never silently a no-op.
    const targets = selectedVolumes();
    if (targets.length === 0) {
      setStatus("Select one or more volumes (Vol mode) before applying a transform.", true);
      return;
    }
    let op: EditOp;
    switch (draft.kind) {
      case "translate": op = { op: "translate", targets, vec: draft.vec }; break;
      case "rotate": op = { op: "rotate", targets, axisPoint: draft.axisPoint, axisDir: draft.axisDir, angleDeg: draft.angleDeg }; break;
      case "scale": op = { op: "scale", targets, center: draft.center, factors: draft.factors }; break;
      case "mirror": op = { op: "mirror", targets, planePoint: draft.planePoint, planeNormal: draft.planeNormal }; break;
    }
    if (draft.exprs) op.exprs = draft.exprs;
    editsModel.push(op);
    setStatus("");
  },
  onCaptureBooleanA: () => {
    booleanA = selectedVolumes();
    if (booleanA.length === 0) setStatus("Select volumes for operand A before Set A.", true);
    return booleanA.length;
  },
  onApplyBoolean: (kind) => {
    const b = selectedVolumes();
    if (booleanA.length === 0) { setStatus("Set operand A first (select volumes → Set A).", true); return; }
    if (b.length === 0) { setStatus("Select operand B volumes before applying.", true); return; }
    if (b.some((id) => booleanA.includes(id))) {
      setStatus("Operands A and B must be different volumes.", true);
      return;
    }
    editsModel.push({ op: "boolean", kind, a: booleanA, b });
    booleanA = [];
    selection.clear();
    renderHighlight();
    setStatus("");
  },
  onApplyFillet: (kind, amount, exprs) => {
    // Fillet/chamfer act on selected edges (Line mode), B-rep only.
    const edges = selection.list().filter((e) => e.entityType === "line").map((e) => e.entityId);
    if (edges.length === 0) {
      setStatus("Select one or more edges (Line mode) before applying a fillet/chamfer.", true);
      return;
    }
    if (amount <= 0) { setStatus("Enter a positive radius / setback.", true); return; }
    const op: EditOp =
      kind === "fillet" ? { op: "fillet", edges, radius: amount } : { op: "chamfer", edges, distance: amount };
    // The panel's shared field is named `amount`; remap onto the op's real field.
    if (exprs?.amount) op.exprs = { [kind === "fillet" ? "radius" : "distance"]: exprs.amount };
    editsModel.push(op);
    setStatus("");
  },
  onApplyFeature: (draft) => {
    // Feature modeling builds a new body from selected profile faces (Surf mode)
    // and, for sweep, a path edge (Line mode). B-rep only.
    const faces = selection.list().filter((e) => e.entityType === "surface").map((e) => e.entityId);
    const edges = selection.list().filter((e) => e.entityType === "line").map((e) => e.entityId);
    let op: EditOp | null = null;
    switch (draft.kind) {
      case "extrude":
        if (!faces[0]) { setStatus("Select a profile face (Surf mode) to extrude.", true); return; }
        op = { op: "extrude", profile: faces[0], dir: draft.dir, length: draft.length };
        break;
      case "revolve":
        if (!faces[0]) { setStatus("Select a profile face (Surf mode) to revolve.", true); return; }
        op = { op: "revolve", profile: faces[0], axisPoint: draft.axisPoint, axisDir: draft.axisDir, angleDeg: draft.angleDeg };
        break;
      case "sweep":
        if (!faces[0] || !edges[0]) { setStatus("Select a profile face and a path edge for sweep.", true); return; }
        op = { op: "sweep", profile: faces[0], path: edges[0] };
        break;
      case "loft":
        if (faces.length < 2) { setStatus("Select 2+ profile faces (Surf mode) to loft.", true); return; }
        op = { op: "loft", profiles: faces };
        break;
    }
    if (draft.exprs) op.exprs = draft.exprs;
    editsModel.push(op);
    setStatus("");
  },
  onApplyExplode: (factor, exprs) => {
    cancelExplodePreview(); // discard the live preview — the real op replay rebuilds everything
    const op: EditOp = { op: "explode", factor };
    if (exprs) op.exprs = exprs;
    editsModel.push(op);
    setStatus("");
  },
  onExplodePreview: (factor) => {
    const model = viewer.getModel();
    if (!model) return;
    if (!explodePreviewBases) explodePreviewBases = captureExplodeBase(model);
    applyExplodePreview(explodePreviewBases, factor);
  },
  onExplodePreviewCancel: cancelExplodePreview,
  onApplyMate: () => {
    // Mate aligns the first selected face onto the second (Surf mode), B-rep only.
    const faces = selection.list().filter((e) => e.entityType === "surface").map((e) => e.entityId);
    if (faces.length < 2) {
      setStatus("Select two faces (Surf mode): face A first, then face B, to mate.", true);
      return;
    }
    editsModel.push({ op: "mate", faceA: faces[0], faceB: faces[1] });
    setStatus("");
  },
  onApplyModify: (draft) => {
    // Shell takes its opening faces from the Surf selection; split/section take
    // their target volumes from the Vol selection. B-rep only.
    let op: EditOp;
    switch (draft.kind) {
      case "shell": {
        const openingFaces = selection.list().filter((e) => e.entityType === "surface").map((e) => e.entityId);
        if (openingFaces.length === 0) {
          setStatus("Select the opening face(s) (Surf mode) before shelling.", true);
          return;
        }
        if (draft.thickness === 0) { setStatus("Thickness must be non-zero.", true); return; }
        op = { op: "shell", thickness: draft.thickness, openingFaces };
        break;
      }
      case "splitByPlane": {
        const targets = selectedVolumes();
        if (targets.length === 0) { setStatus("Select one or more volumes (Vol mode) to split.", true); return; }
        if (!draft.planeNormal.some((v) => v !== 0)) { setStatus("Plane normal must be non-zero.", true); return; }
        op = {
          op: "splitByPlane", targets, planePoint: draft.planePoint,
          planeNormal: draft.planeNormal, keep: draft.keep,
        };
        break;
      }
      case "section": {
        const targets = selectedVolumes();
        if (targets.length === 0) { setStatus("Select one or more volumes (Vol mode) to section.", true); return; }
        if (!draft.planeNormal.some((v) => v !== 0)) { setStatus("Plane normal must be non-zero.", true); return; }
        op = { op: "section", targets, planePoint: draft.planePoint, planeNormal: draft.planeNormal };
        break;
      }
    }
    if (draft.exprs) op.exprs = draft.exprs;
    editsModel.push(op);
    setStatus("");
  },
  onApplyPrimitive: (draft) => {
    // Primitives are self-contained placements — no selection/operand needed.
    // A light client-side guard avoids silently pushing an op that
    // validateEditOp would later drop on reload (non-positive dimensions).
    let op: EditOp;
    switch (draft.kind) {
      case "addBox":
        if (draft.size.some((s) => s <= 0)) { setStatus("Box size must be positive.", true); return; }
        op = { op: "addBox", center: draft.center, size: draft.size };
        break;
      case "addSphere":
        if (draft.radius <= 0) { setStatus("Sphere radius must be positive.", true); return; }
        op = { op: "addSphere", center: draft.center, radius: draft.radius };
        break;
      case "addCylinder":
        if (draft.radius <= 0 || draft.height <= 0) { setStatus("Radius and height must be positive.", true); return; }
        op = { op: "addCylinder", center: draft.center, axis: draft.axis, radius: draft.radius, height: draft.height };
        break;
      case "addCone":
        if (draft.radius1 <= 0 && draft.radius2 <= 0) { setStatus("At least one cone radius must be positive.", true); return; }
        if (draft.height <= 0) { setStatus("Height must be positive.", true); return; }
        op = {
          op: "addCone", center: draft.center, axis: draft.axis,
          radius1: draft.radius1, radius2: draft.radius2, height: draft.height,
        };
        break;
      case "addTorus":
        if (draft.majorRadius <= 0 || draft.minorRadius <= 0 || draft.minorRadius >= draft.majorRadius) {
          setStatus("Torus needs 0 < minor radius < major radius.", true);
          return;
        }
        op = {
          op: "addTorus", center: draft.center, axis: draft.axis,
          majorRadius: draft.majorRadius, minorRadius: draft.minorRadius,
        };
        break;
      case "addPrism":
        if (draft.radius <= 0 || draft.height <= 0) { setStatus("Radius and height must be positive.", true); return; }
        if (!Number.isInteger(draft.sides) || draft.sides < 3) { setStatus("Sides must be an integer ≥ 3.", true); return; }
        op = {
          op: "addPrism", center: draft.center, axis: draft.axis,
          radius: draft.radius, sides: draft.sides, height: draft.height,
        };
        break;
      case "addWedge":
        if (draft.dx <= 0 || draft.dy <= 0 || draft.dz <= 0) { setStatus("Wedge sizes must be positive.", true); return; }
        if (draft.ltx < 0) { setStatus("Top X extent must be ≥ 0.", true); return; }
        if (!nonParallel(draft.axis, draft.up)) { setStatus("Up must not be parallel to Axis.", true); return; }
        op = {
          op: "addWedge", center: draft.center, axis: draft.axis, up: draft.up,
          dx: draft.dx, dy: draft.dy, dz: draft.dz, ltx: draft.ltx,
        };
        break;
    }
    if (draft.exprs) op.exprs = draft.exprs;
    editsModel.push(op);
    setStatus("");
  },
  onApplyHole: (draft) => {
    // Holes are subtractive: they cut into the selected volumes, so a target
    // selection is required (unlike the self-contained primitives above).
    const targets = selectedVolumes();
    if (targets.length === 0) {
      setStatus("Select one or more volumes (Vol mode) to cut the hole into.", true);
      return;
    }
    if (draft.radius <= 0 || draft.depth <= 0) { setStatus("Radius and depth must be positive.", true); return; }
    let op: EditOp;
    switch (draft.kind) {
      case "addHole":
        op = { op: "addHole", targets, position: draft.position, axis: draft.axis, radius: draft.radius, depth: draft.depth };
        break;
      case "addCounterboreHole":
        if (draft.cbRadius <= draft.radius) { setStatus("Counterbore radius must exceed the hole radius.", true); return; }
        if (draft.cbDepth <= 0 || draft.cbDepth >= draft.depth) { setStatus("Counterbore depth must satisfy 0 < depth < hole depth.", true); return; }
        op = {
          op: "addCounterboreHole", targets, position: draft.position, axis: draft.axis,
          radius: draft.radius, depth: draft.depth, cbRadius: draft.cbRadius, cbDepth: draft.cbDepth,
        };
        break;
      case "addCountersinkHole":
        if (draft.csRadius <= draft.radius) { setStatus("Countersink radius must exceed the hole radius.", true); return; }
        if (draft.csAngleDeg <= 0 || draft.csAngleDeg >= 180) { setStatus("Countersink angle must be between 0° and 180°.", true); return; }
        op = {
          op: "addCountersinkHole", targets, position: draft.position, axis: draft.axis,
          radius: draft.radius, depth: draft.depth, csRadius: draft.csRadius, csAngleDeg: draft.csAngleDeg,
        };
        break;
    }
    if (draft.exprs) op.exprs = draft.exprs;
    editsModel.push(op);
    setStatus("");
  },
  onApplyProfile: (draft) => {
    // 2D profiles are self-contained placements — no selection/operand needed.
    // Sketched now, picked (Surf mode) and used as an extrude/revolve/sweep/loft
    // profile later. A light client-side guard mirrors validateEditOp's checks.
    let op: EditOp;
    switch (draft.kind) {
      case "addCircleProfile":
        if (draft.radius <= 0) { setStatus("Circle radius must be positive.", true); return; }
        op = { op: "addCircleProfile", center: draft.center, normal: draft.normal, radius: draft.radius };
        break;
      case "addRectangleProfile":
        if (draft.width <= 0 || draft.height <= 0) { setStatus("Width and height must be positive.", true); return; }
        if (!nonParallel(draft.normal, draft.up)) { setStatus("Up must not be parallel to Normal.", true); return; }
        op = {
          op: "addRectangleProfile", center: draft.center, normal: draft.normal,
          up: draft.up, width: draft.width, height: draft.height,
        };
        break;
      case "addPolygonProfile":
        if (draft.radius <= 0) { setStatus("Radius must be positive.", true); return; }
        if (!Number.isInteger(draft.sides) || draft.sides < 3) { setStatus("Sides must be an integer ≥ 3.", true); return; }
        if (!nonParallel(draft.normal, draft.up)) { setStatus("Up must not be parallel to Normal.", true); return; }
        op = {
          op: "addPolygonProfile", center: draft.center, normal: draft.normal,
          up: draft.up, radius: draft.radius, sides: draft.sides,
        };
        break;
      case "addEllipseProfile":
        if (draft.radiusX <= 0 || draft.radiusY <= 0) { setStatus("Both radii must be positive.", true); return; }
        if (!nonParallel(draft.normal, draft.up)) { setStatus("Up must not be parallel to Normal.", true); return; }
        op = {
          op: "addEllipseProfile", center: draft.center, normal: draft.normal,
          up: draft.up, radiusX: draft.radiusX, radiusY: draft.radiusY,
        };
        break;
      case "addRoundedRectangleProfile":
        if (draft.width <= 0 || draft.height <= 0) { setStatus("Width and height must be positive.", true); return; }
        if (draft.cornerRadius <= 0 || 2 * draft.cornerRadius >= Math.min(draft.width, draft.height)) {
          setStatus("Corner radius must satisfy 0 < 2·r < min(width, height).", true);
          return;
        }
        if (!nonParallel(draft.normal, draft.up)) { setStatus("Up must not be parallel to Normal.", true); return; }
        op = {
          op: "addRoundedRectangleProfile", center: draft.center, normal: draft.normal,
          up: draft.up, width: draft.width, height: draft.height, cornerRadius: draft.cornerRadius,
        };
        break;
      case "addSlotProfile":
        if (draft.width <= 0 || draft.length <= draft.width) {
          setStatus("Slot needs length > width > 0.", true);
          return;
        }
        if (!nonParallel(draft.normal, draft.up)) { setStatus("Up must not be parallel to Normal.", true); return; }
        op = {
          op: "addSlotProfile", center: draft.center, normal: draft.normal,
          up: draft.up, length: draft.length, width: draft.width,
        };
        break;
      case "addTrapezoidProfile":
        if (draft.bottomWidth <= 0 || draft.topWidth <= 0 || draft.height <= 0) {
          setStatus("Trapezoid widths and height must be positive.", true);
          return;
        }
        if (!nonParallel(draft.normal, draft.up)) { setStatus("Up must not be parallel to Normal.", true); return; }
        op = {
          op: "addTrapezoidProfile", center: draft.center, normal: draft.normal,
          up: draft.up, bottomWidth: draft.bottomWidth, topWidth: draft.topWidth, height: draft.height,
        };
        break;
    }
    if (draft.exprs) op.exprs = draft.exprs;
    editsModel.push(op);
    setStatus("");
  },
  onApplyWireframe: (draft) => {
    // Point/Line/Arc are self-contained placements — no selection needed.
    let op: EditOp;
    switch (draft.kind) {
      case "addPoint":
        op = { op: "addPoint", position: draft.position };
        break;
      case "addLine":
        if (draft.start.every((v, i) => v === draft.end[i])) {
          setStatus("Start and end must differ.", true);
          return;
        }
        op = { op: "addLine", start: draft.start, end: draft.end };
        break;
      case "addArc":
        if (draft.radius <= 0) { setStatus("Arc radius must be positive.", true); return; }
        if (draft.startAngleDeg === draft.endAngleDeg) { setStatus("Start and end angle must differ.", true); return; }
        op = {
          op: "addArc", center: draft.center, normal: draft.normal, radius: draft.radius,
          startAngleDeg: draft.startAngleDeg, endAngleDeg: draft.endAngleDeg,
        };
        break;
      case "addPolyline": {
        const min = draft.closed ? 3 : 2;
        if (draft.points.length < min) { setStatus(`A ${draft.closed ? "closed " : ""}polyline needs ${min}+ points.`, true); return; }
        if (hasRepeatedConsecutive(draft.points)) { setStatus("Consecutive points must differ.", true); return; }
        op = { op: "addPolyline", points: draft.points, closed: draft.closed };
        break;
      }
      case "addThreePointArc": {
        const { p1, p2, p3 } = draft;
        const same = (a: number[], b: number[]) => a.every((v, i) => v === b[i]);
        if (same(p1, p2) || same(p2, p3) || same(p1, p3)) { setStatus("The three points must be distinct.", true); return; }
        op = { op: "addThreePointArc", p1, p2, p3 };
        break;
      }
      case "addSpline":
        if (draft.points.length < 2) { setStatus("A spline needs 2+ points.", true); return; }
        if (hasRepeatedConsecutive(draft.points)) { setStatus("Consecutive points must differ.", true); return; }
        op = { op: "addSpline", points: draft.points };
        break;
      case "addBezier":
        if (draft.controlPoints.length < 2) { setStatus("A Bézier needs 2+ control points.", true); return; }
        op = { op: "addBezier", controlPoints: draft.controlPoints };
        break;
      case "addEllipseArc":
        if (draft.radiusX <= 0 || draft.radiusY <= 0) { setStatus("Both radii must be positive.", true); return; }
        if (!nonParallel(draft.normal, draft.up)) { setStatus("Up must not be parallel to Normal.", true); return; }
        if (draft.startAngleDeg === draft.endAngleDeg) { setStatus("Start and end angle must differ.", true); return; }
        op = {
          op: "addEllipseArc", center: draft.center, normal: draft.normal, up: draft.up,
          radiusX: draft.radiusX, radiusY: draft.radiusY,
          startAngleDeg: draft.startAngleDeg, endAngleDeg: draft.endAngleDeg,
        };
        break;
      case "addHelix":
        if (draft.radius <= 0 || draft.pitch <= 0 || draft.turns <= 0) {
          setStatus("Helix radius, pitch, and turns must all be positive.", true);
          return;
        }
        op = {
          op: "addHelix", center: draft.center, axis: draft.axis,
          radius: draft.radius, pitch: draft.pitch, turns: draft.turns,
        };
        break;
    }
    if (draft.exprs) op.exprs = draft.exprs;
    editsModel.push(op);
    setStatus("");
  },
  onBuildSurfaceFromLines: () => {
    // Reads the live selection directly — Line mode must already be active with
    // the loop's edges picked. Host resolves ids fresh, so no capture step needed.
    const edges = selection.list().filter((e) => e.entityType === "line").map((e) => e.entityId);
    if (edges.length < 3) {
      setStatus("Select 3+ lines (Line mode) forming a closed loop.", true);
      return;
    }
    editsModel.push({ op: "addSurfaceFromLines", edges });
    setStatus("");
  },
  onBuildVolumeFromSurfaces: () => {
    const faces = selection.list().filter((e) => e.entityType === "surface").map((e) => e.entityId);
    if (faces.length < 4) {
      setStatus("Select 4+ surfaces (Surf mode) forming a closed shell.", true);
      return;
    }
    editsModel.push({ op: "addVolumeFromSurfaces", faces });
    setStatus("");
  },
});

// ── Meshing (GMSH FE-mesh generation) ────────────────────────────────────
// The webview owns the options bag + panel; the host runs GMSH and posts back
// a result/error. Mesh-source documents (pristineMesh !== null) must supply
// an `stl` snapshot of the currently displayed model since the host has no
// other way to get triangulated geometry for them — B-rep documents don't
// need one, the host re-exports STEP itself from the live OCCT shape.
const meshingModel = new MeshingModel(() => {
  post({ type: "meshingChanged", options: meshingModel.get() });
  // Options changed but nothing has been (re)generated yet — clear the stale
  // stats/error readout rather than showing a result for the old options.
  meshingPanel.render(meshingModel.get());
});

/** Snapshot of the displayed model as base64 STL, for mesh-source documents only. */
async function currentStlIfMeshSource(): Promise<string | undefined> {
  if (!pristineMesh) return undefined;
  const model = viewer.getModel();
  if (!model) return undefined;
  return (await exportModel(model, "stl")).data;
}

const meshingPanel = new MeshingPanel(document.getElementById("meshing-panel")!, {
  onOptionsChange: (patch) => meshingModel.update(patch),
  // Same store the Parts panel edits — one Part.meshSize, two mirrored inputs.
  onPartMeshSize: (index, size) => partsModel.setMeshSize(index, size),
  onGenerate: async () => {
    meshingPanel.setBusy(true);
    post({ type: "meshingGenerate", options: meshingModel.get(), stl: await currentStlIfMeshSource() });
  },
  onExport: async (format) => {
    post({ type: "meshingExport", target: format, options: meshingModel.get(), stl: await currentStlIfMeshSource() });
  },
  onClear: () => {
    viewer.setMeshOverlay(null);
    viewer.setWorstElementsOverlay(null);
    // Same toggle-truthfulness invariant as `meshingResult`/`meshingError`
    // below: Clear disposes the overlay, so the toggle must stop claiming "on".
    meshingEnabled = false;
    meshingToggle?.classList.remove("active");
    worstElementsShown = false;
    worstToggle?.classList.remove("active");
    if (worstToggle) worstToggle.hidden = true;
    meshingPanel.render(meshingModel.get());
  },
});

// ── Mass properties ──────────────────────────────────────────────────────
// B-rep sources round-trip through the host (OCCT `BRepGProp`); mesh sources
// compute entirely client-side (pure Three.js triangle math, no WASM
// dependency) — see `computeAndRenderMeshMassProperties` below.
let sourceKind: "brep" | "mesh" | null = null;
let massPropertiesRequestId: string | null = null;

// ── Display unit (session-only presentation layer, never persisted) ────────
// Everything computed host/client-side is already in one internal unit
// (millimetres — OCCT's STEP reader auto-converts every shape to its cascade
// unit at read time, verified against the live WASM; see
// `src/stepUnits.ts`'s doc comment). This only rescales what Mass Properties/
// Measurement *display*; nothing stored is ever rescaled.
let currentDisplayUnit: DisplayUnit = "mm";
let lastRawMassProperties: (LengthBasedProperties & { momentsOfInertia: MassPropertiesDisplay["momentsOfInertia"] }) | null = null;

/** Sets the display unit, syncs the `<select>`, and live-rescales the
 * currently-shown Mass Properties result (if any) — measurements already on
 * screen are not retroactively rescaled, matching every other Stage-2
 * appearance control's "affects what's rendered from now on" precedent. */
function setDisplayUnit(unit: DisplayUnit): void {
  currentDisplayUnit = unit;
  const sel = document.getElementById("vc-unit") as HTMLSelectElement | null;
  if (sel) sel.value = unit;
  if (lastRawMassProperties) massPropertiesPanel.render(convertLengthBasedProperties(lastRawMassProperties, unit), unit);
}

/** Caches the raw (mm) result and renders it converted to `currentDisplayUnit`. */
function renderMassProperties(raw: LengthBasedProperties & { momentsOfInertia: MassPropertiesDisplay["momentsOfInertia"] }): void {
  lastRawMassProperties = raw;
  massPropertiesPanel.render(convertLengthBasedProperties(raw, currentDisplayUnit), currentDisplayUnit);
}

const massPropertiesPanel = new MassPropertiesPanel(document.getElementById("mass-panel")!, {
  onRefresh: () => {
    const list = selection.list();
    if (list.length > 1) {
      massPropertiesPanel.renderMessage("Select exactly one entity, or none for the whole model.", true);
      return;
    }
    const target = list[0] ?? null;
    if (sourceKind === "mesh") {
      computeAndRenderMeshMassProperties(target);
      return;
    }
    const requestId = `${Date.now()}-${Math.random()}`;
    massPropertiesRequestId = requestId;
    massPropertiesPanel.renderMessage("Computing…");
    post({ type: "massPropertiesRequest", requestId, entityId: target ? target.entityId : null });
  },
});

/**
 * Mesh-source mass properties: resolves `target` to the matching facet
 * `THREE.Mesh`(es) in the currently displayed model and sums them via
 * `computeMeshMassProperties` — entirely in the webview, no host round trip
 * (mesh sources have no OCCT shape to query). A `null` target means the whole
 * model; only a single open facet ("surface") lacks a meaningful volume, so
 * only that case suppresses `volume`/uses the area-weighted centroid.
 */
function computeAndRenderMeshMassProperties(target: SelectedEntity | null): void {
  const model = viewer.getModel();
  if (!model) {
    massPropertiesPanel.renderMessage("No model loaded.", true);
    return;
  }
  if (target && target.entityType !== "volume" && target.entityType !== "surface") {
    massPropertiesPanel.renderMessage("Mass properties aren't available for this entity type.", true);
    return;
  }

  const meshes: THREE.Mesh[] = [];
  model.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o.userData.entityType !== "surface") return;
    if (!target) meshes.push(o);
    else if (target.entityType === "volume" && o.userData.groupId === target.entityId) meshes.push(o);
    else if (target.entityType === "surface" && o.userData.entityId === target.entityId) meshes.push(o);
  });
  if (meshes.length === 0) {
    massPropertiesPanel.renderMessage("Nothing to measure for this selection.", true);
    return;
  }

  const isClosedTarget = target === null || target.entityType === "volume";
  const { volume, area, volumeCentroid, areaCentroid } = computeMeshMassProperties(meshes);
  renderMassProperties({
    volume: isClosedTarget ? volume : null,
    area,
    length: null,
    centerOfMass: isClosedTarget ? volumeCentroid : areaCentroid,
    momentsOfInertia: null,
  });
}

/**
 * The `cadPreview.defaultMeshSizePreset` setting, hydrated by the
 * `viewerDefaults` handler below (arrives in no deterministic order relative
 * to `geometry`/`loadUrl`/`meshingOptions`, same as the rest of the seed
 * inputs) and consumed by `syncMeshSizeSeed`. `"medium"` reproduces the
 * pre-setting behavior exactly (`PRESET_DIVISORS.medium === DEFAULT_SIZE_DIVISOR`).
 */
let meshSizePreset: MeshSizePreset = "medium";

/**
 * Seeds a bbox-derived default target size (scaled by {@link meshSizePreset})
 * while `sizeMax` is still the "unbounded" sentinel. Called from the
 * `geometry`, `loadUrl`, `meshingOptions`, AND `viewerDefaults` handlers —
 * model geometry, the options sidecar, and the preset setting all arrive in
 * no deterministic order (B-rep tessellation is async), so whichever lands
 * last completes the seed. A persisted user value (≠ sentinel) always wins,
 * and once seeded the repeat calls (e.g. re-tessellation after each B-rep
 * edit) are no-ops. Deliberately uses `load()` (which does NOT fire onChange)
 * rather than `update()`: merely OPENING a file must never post
 * `meshingChanged` and create `.mesh.json`/`.geo` sidecars the user never
 * asked for — the seeded value only persists after a real user change.
 */
function syncMeshSizeSeed(): void {
  const extents = viewer.getModelExtents();
  if (!extents) return;
  if (meshingModel.get().sizeMax !== SIZE_MAX_SENTINEL) return;
  meshingModel.load({ ...meshingModel.get(), sizeMax: targetSizeForPreset(extents.diagonal, meshSizePreset) });
  meshingPanel.render(meshingModel.get());
}

/** True when any two consecutive points coincide (a degenerate polyline/spline segment). */
function hasRepeatedConsecutive(points: Array<[number, number, number]>): boolean {
  for (let i = 1; i < points.length; i++) {
    if (points[i].every((v, k) => v === points[i - 1][k])) return true;
  }
  return false;
}

/** True when `a` and `b` are not (anti-)parallel — their cross product is non-zero. */
function nonParallel(a: [number, number, number], b: [number, number, number]): boolean {
  const cx = a[1] * b[2] - a[2] * b[1];
  const cy = a[2] * b[0] - a[0] * b[2];
  const cz = a[0] * b[1] - a[1] * b[0];
  return cx * cx + cy * cy + cz * cz > 0;
}

/** Applies persistent per-part colours, then re-draws the active highlight. */
function refreshColors(): void {
  viewer.setEntityColors(partsModel.colorMap());
  renderHighlight();
  applyVisibilityState();
}

/** Re-applies both the Parts hide/isolate state and the Tree per-node hide
 * state to the (possibly freshly rebuilt) model — new `THREE.Object3D`s from
 * a model reload start fully visible, so this must run on every model
 * rebuild, not just when visibility itself changes. Called from
 * `refreshColors()`, which every model-rebuild/parts-change path already
 * calls, so a single hook here covers every call site. */
function applyVisibilityState(): void {
  const parts = partsModel.list();
  const hidden = visibilityState.hiddenPartIndices().flatMap((i) => partsModel.entitiesOf(i));
  const isolated = visibilityState.isolatedPartIndex();
  const isolatedEntities = isolated !== null && isolated < parts.length ? partsModel.entitiesOf(isolated) : null;
  viewer.applyPartVisibility(hidden, isolatedEntities);
  for (const groupId of visibilityState.hiddenTreeGroupIds()) viewer.setGroupVisible(groupId, false);
}

/** Draws either the previewed part's entities or the working selection. */
function renderHighlight(): void {
  const entities: SelectedEntity[] =
    previewPartIndex !== null ? partsModel.entitiesOf(previewPartIndex) : selection.list();
  viewer.renderSelection(entities);
}

// The pristine, tagged-but-unedited loaded object for mesh formats. Mesh edits
// are non-destructive: every edit rebuilds the displayed model from this clone so
// the op-list replays cleanly (B-rep replay happens in the host instead).
let pristineMesh: THREE.Object3D | null = null;

/** Rebuilds the displayed mesh model: clone pristine → apply resolved ops → facet-split. */
function rebuildMeshModel(): void {
  if (!pristineMesh) return;
  const edited = applyEditsMesh(pristineMesh.clone(), currentResolvedOps().ops);
  const model = splitMeshesIntoFacets(edited);
  viewer.setModel(model);
  explodePreviewBases = null; // stale references to the just-replaced model's objects
  refreshColors();
  // Edits can change the bounding box; keep the FE Mesh panel's element-count
  // estimate honest. (B-rep sources get the equivalent via the re-posted
  // `geometry` message after each edit.)
  meshingPanel.setModelExtents(viewer.getModelExtents());
}

function showSidebar(): void {
  sideEl.classList.add("visible");
  window.dispatchEvent(new Event("resize"));
}

viewer.setEntityPickHandler(
  (result, additive) => {
    previewPartIndex = null;
    if (additive) {
      selection.toggle(result);
    } else {
      selection.clear();
      selection.add(result);
    }
    renderHighlight();
  },
  () => {
    previewPartIndex = null;
    selection.clear();
    renderHighlight();
  }
);

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.style.display = text ? "block" : "none";
  statusEl.classList.toggle("error", isError);
}

function showTree(root: TreeNode): void {
  treePanel.render(root);
  toggleBtn.style.display = "";
  showSidebar();
}

// ── Selection-mode toolbar ────────────────────────────────────────────────
let selectMode: EntityType = "surface";
let selecting = false;
function setupSelectionControls(): void {
  const menu = setupDropdown("select-menu", "select-dropdown");
  const toggle = document.getElementById("sel-toggle");
  const modeBtns = [...document.querySelectorAll<HTMLButtonElement>(".sel-mode")];
  const apply = () => viewer.setSelectionMode(selecting ? selectMode : null);
  // The trigger mirrors the mode toggle so the collapsed toolbar still shows
  // that selection mode is live, and names the current pick mode in its title.
  const reflect = () => {
    menu?.trigger.classList.toggle("active", selecting);
    if (menu) {
      const label = modeBtns.find((b) => b.classList.contains("active"))?.dataset.mode ?? selectMode;
      menu.trigger.title = selecting
        ? `Selection mode: on — picking ${label}s`
        : "Pick entities in the view to assign to a part";
    }
  };
  toggle?.addEventListener("click", () => {
    selecting = !selecting;
    toggle.classList.toggle("active", selecting);
    toggle.setAttribute("aria-checked", String(selecting));
    apply();
    reflect();
  });
  for (const btn of modeBtns) {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      selectMode = btn.dataset.mode as EntityType;
      modeBtns.forEach((b) => b.classList.toggle("active", b === btn));
      if (selecting) apply();
      reflect();
    });
  }
}

/** Restricts pickable entity kinds (mesh formats expose only whole "volumes"). */
function setSelectableModes(modes: EntityType[]): void {
  const allowed = new Set(modes);
  let active: HTMLButtonElement | null = null;
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".sel-mode")) {
    const ok = allowed.has(btn.dataset.mode as EntityType);
    btn.disabled = !ok;
    if (ok && (active === null || btn.dataset.mode === selectMode)) active = btn;
  }
  if (active) {
    selectMode = active.dataset.mode as EntityType;
    document.querySelectorAll(".sel-mode").forEach((b) => b.classList.toggle("active", b === active));
    if (selecting) viewer.setSelectionMode(selectMode);
  }
}

// ── Measurement toolbar (distance/edge length/angle/radius) ────────────────
// Entirely webview-side, display-only overlay — never an edit op, never
// persisted to any sidecar, never a host round trip.

interface MeasurementResult {
  text: string;
  anchor: Vec3;
  /** 2 points to connect with a line (distance/angle), or none (edgeLength/radius). */
  linePoints: Vec3[];
}

function polylinePointAt(flat: Float32Array, i: number): Vec3 {
  return [flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]];
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function formatMeasure(n: number): string {
  return Number.isFinite(n) ? String(Number(n.toPrecision(5))) : "—";
}

/** Formats a raw millimetre length, converted to `currentDisplayUnit` with its suffix. */
function formatMeasureLength(mmValue: number): string {
  return `${formatMeasure(convertLength(mmValue, currentDisplayUnit))} ${currentDisplayUnit}`;
}

/** Dispatches the completed pick set to the matching pure math in `measurement.ts`.
 * Distance/edgeLength/radius are length-dimensioned and rescale with the
 * current display unit; angle (in degrees) never does. */
function computeMeasurementResult(tool: MeasureTool, picks: MeasurementPick[]): MeasurementResult | null {
  if (tool === "distance") {
    const [a, b] = picks;
    if (!a || !b) return null;
    return { text: formatMeasureLength(pointDistance(a.point, b.point)), anchor: midpoint(a.point, b.point), linePoints: [a.point, b.point] };
  }
  if (tool === "edgeLength") {
    const [a] = picks;
    if (!a?.polyline) return null;
    return { text: `L = ${formatMeasureLength(polylineLength(a.polyline))}`, anchor: a.point, linePoints: [] };
  }
  if (tool === "angle") {
    const [a, b] = picks;
    if (!a?.direction || !b?.direction) return null;
    const deg = angleBetweenVectors(a.direction, b.direction);
    if (Number.isNaN(deg)) return null;
    return { text: `${formatMeasure(deg)}°`, anchor: midpoint(a.point, b.point), linePoints: [a.point, b.point] };
  }
  if (tool === "radius") {
    const [a] = picks;
    if (!a?.polyline || a.polyline.length < 9) return null;
    const n = a.polyline.length / 3;
    const r = circleRadiusFromArcPoints(
      polylinePointAt(a.polyline, 0),
      polylinePointAt(a.polyline, Math.floor(n / 2)),
      polylinePointAt(a.polyline, n - 1)
    );
    return r === null ? null : { text: `R = ${formatMeasureLength(r)}`, anchor: a.point, linePoints: [] };
  }
  return null;
}

const measurementState = new MeasurementState();

function setMeasureReadout(text: string, isError = false): void {
  const el = document.getElementById("measure-readout");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("measure-readout-error", isError);
}

function setupMeasureControls(): void {
  const menu = setupDropdown("measure-menu", "measure-dropdown");
  const toggle = document.getElementById("measure-toggle");
  const toolBtns = [...document.querySelectorAll<HTMLButtonElement>(".measure-tool-btn")];
  const clearBtn = document.getElementById("measure-clear");
  let measuring = false;

  const reflect = () => {
    if (!menu) return;
    menu.trigger.classList.toggle("active", measuring);
    const label = toolBtns.find((b) => b.classList.contains("active"))?.textContent?.trim() ?? "";
    menu.trigger.title = measuring
      ? `Measure mode: on — ${label}`
      : "Measure distances, lengths, angles, and radii";
  };

  viewer.setOnMeasurePick((pick) => {
    const { done, picks } = measurementState.addPick(pick);
    if (!done) {
      viewer.showMeasurementMarker(new THREE.Vector3(...pick.point));
      setMeasureReadout("Pick another point…");
      return;
    }
    const result = computeMeasurementResult(measurementState.getTool(), picks);
    if (!result) {
      viewer.clearMeasurementOverlay();
      setMeasureReadout("Couldn't compute a result for that pick — try a different entity.", true);
      return;
    }
    viewer.showMeasurementOverlay(
      result.linePoints.map((p) => new THREE.Vector3(...p)),
      new THREE.Vector3(...result.anchor),
      result.text
    );
    setMeasureReadout(result.text);
  });

  toggle?.addEventListener("click", () => {
    measuring = !measuring;
    toggle.classList.toggle("active", measuring);
    toggle.setAttribute("aria-checked", String(measuring));
    viewer.setMeasureMode(measuring);
    measurementState.clear();
    viewer.clearMeasurementOverlay();
    setMeasureReadout(measuring ? "Pick a point…" : "");
    reflect();
  });

  for (const btn of toolBtns) {
    btn.addEventListener("click", () => {
      measurementState.setTool(btn.dataset.tool as MeasureTool);
      for (const b of toolBtns) b.classList.toggle("active", b === btn);
      viewer.clearMeasurementOverlay();
      setMeasureReadout(measuring ? "Pick a point…" : "");
      reflect();
    });
  }

  clearBtn?.addEventListener("click", () => {
    measurementState.clear();
    viewer.clearMeasurementOverlay();
    setMeasureReadout("");
  });
}

document.getElementById("fit")?.addEventListener("click", () => viewer.fitView());
// #grid lives in the View ▾ menu now — setupViewMenu() owns it, so it can keep
// the menu item's `aria-checked` tick in sync with the real grid state.
document.getElementById("screenshot")?.addEventListener("click", () => post({ type: "screenshotButtonClicked" }));
document.getElementById("tree-close")?.addEventListener("click", () => {
  treePanel.hide();
  window.dispatchEvent(new Event("resize"));
});
document.getElementById("tree-toggle")?.addEventListener("click", () => {
  treePanel.toggle();
  window.dispatchEvent(new Event("resize"));
});

// ── View-manipulation control panel ──────────────────────────────────────
// Wire the panel inside a guard so a failure here can never block the `ready`
// handshake below, or the host never sends the model and the webview stays blank.
function setupViewControls(): void {
  const panel = document.getElementById("view-controls");
  const toggle = document.getElementById("vc-toggle");
  toggle?.addEventListener("click", () => {
    const collapsed = panel?.classList.toggle("collapsed") ?? false;
    toggle.textContent = collapsed ? "⌃" : "⌄";
    toggle.title = collapsed ? "Show controls" : "Hide controls";
  });

  let rotateStep = 45;
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".seg-btn")) {
    btn.addEventListener("click", () => {
      rotateStep = Number(btn.dataset.step);
      document.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  }

  const on = (id: string, handler: () => void) =>
    document.getElementById(id)?.addEventListener("click", handler);

  on("rot-left", () => viewer.rotateView(rotateStep, 0));
  on("rot-right", () => viewer.rotateView(-rotateStep, 0));
  on("rot-up", () => viewer.rotateView(0, -rotateStep));
  on("rot-down", () => viewer.rotateView(0, rotateStep));
  on("pan-left", () => viewer.panView(0.15, 0));
  on("pan-right", () => viewer.panView(-0.15, 0));
  on("pan-up", () => viewer.panView(0, 0.15));
  on("pan-down", () => viewer.panView(0, -0.15));
  on("zoom-in", () => viewer.zoomView(0.8));
  on("zoom-out", () => viewer.zoomView(1.25));
  on("view-fit", () => viewer.fitView());
  on("view-reset", () => viewer.resetView());
}

// ── File menu (top menu bar) ──────────────────────────────────────────────
// A "File ▾" dropdown with Open / Save / Save As / Export. Save flushes the
// sidecars (the CAD file is read-only); Save As and Export both reuse the
// existing export flow. Wired inside the same guard as the view controls so a
// failure here can never block the `ready` handshake below.
function setupFileMenu(): void {
  const menu = setupDropdown("file-menu", "file-dropdown");
  if (!menu) return;

  const item = (id: string, msg: () => void) =>
    document.getElementById(id)?.addEventListener("click", () => {
      menu.close();
      msg();
    });

  item("menu-open", () => post({ type: "openFile" }));
  item("menu-save", () => post({ type: "saveSidecars" }));
  item("menu-saveas", () => post({ type: "exportRequest" }));
  item("menu-export", () => post({ type: "exportRequest" }));
  item("menu-save-preprocess", () => post({ type: "savePreprocessRequest" }));
  item("menu-load-preprocess", () => post({ type: "loadPreprocessRequest" }));
}

/**
 * The toolbar's View ▾ menu: the Grid and Edges display toggles plus the
 * one-shot Screenshot action. Grid/Edges are `menuitemcheckbox`es whose
 * `aria-checked` drives the tick in the menu (see `viewer.css`), so both need
 * their real current state — Grid's comes back from `toggleGrid()` because the
 * initial value is seeded from the `cadPreview.showGridAndAxesOnOpen` setting
 * via `applyDefaults()`, not assumed on.
 */
function setupViewMenu(): void {
  const menu = setupDropdown("view-menu", "view-dropdown");

  const grid = document.getElementById("grid");
  grid?.addEventListener("click", () => {
    grid.setAttribute("aria-checked", String(viewer.toggleGrid()));
  });
  grid?.setAttribute("aria-checked", String(viewer.isGridVisible()));

  // #edges is owned by setupAppearanceControls() — it holds the visibility
  // flag; this only reflects it. Screenshot is one-shot, so it dismisses.
  document.getElementById("screenshot")?.addEventListener("click", () => menu?.close());
}

/**
 * Drop a CAD/mesh file onto the viewer to open it. `dragover` must call
 * `preventDefault()` or the browser never fires `drop`. Whether the dropped
 * `File` exposes a real filesystem path (`.path`, a legacy Electron
 * extension to the standard `File` object) is VS Code/Electron-version
 * dependent — when it isn't there, fall back to the plain `{type:"openFile"}`
 * message (opens the normal dialog) rather than silently doing nothing.
 */
function setupDragAndDrop(): void {
  app.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  app.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    const path = (file as (File & { path?: string }) | undefined)?.path;
    if (path) post({ type: "openPath", path });
    else post({ type: "openFile" });
  });
}

/**
 * Appearance controls: Edges toolbar toggle (discrete on/off, like Wireframe/
 * Grid), background swatch + opacity slider (continuous, `#view-controls`'
 * "Appearance" group). All session-only — never persisted, mirroring
 * `setWireframe`/`toggleGrid`'s "always wins once set" precedent.
 */
function setupAppearanceControls(): void {
  let edgesVisible = true;
  const edgesBtn = document.getElementById("edges");
  edgesBtn?.addEventListener("click", () => {
    edgesVisible = !edgesVisible;
    viewer.setEdgesVisible(edgesVisible);
    // Drives the tick on the View ▾ menu's checkable item.
    edgesBtn.setAttribute("aria-checked", String(edgesVisible));
  });

  document.getElementById("vc-background")?.addEventListener("input", (e) => {
    viewer.setBackground((e.target as HTMLInputElement).value);
  });

  document.getElementById("vc-opacity")?.addEventListener("input", (e) => {
    viewer.setOpacity(Number((e.target as HTMLInputElement).value) / 100);
  });

  let ortho = false;
  const orthoBtn = document.getElementById("vc-ortho");
  orthoBtn?.addEventListener("click", () => {
    ortho = !ortho;
    viewer.setOrthographic(ortho);
    orthoBtn.textContent = ortho ? "Ortho" : "Persp";
    orthoBtn.classList.toggle("active", ortho);
  });

  document.getElementById("vc-unit")?.addEventListener("change", (e) => {
    setDisplayUnit((e.target as HTMLSelectElement).value as DisplayUnit);
  });

  // Display mode replaces the old standalone Wireframe toolbar toggle —
  // Shaded/Wireframe are two of five mutually exclusive states now (see
  // src/webview/displayMode.ts). A material-affecting switch (Flat swaps the
  // active material instance) needs colours/selection re-applied afterward —
  // refreshColors() already does both, the same contract setModel() relies on.
  const modeBtns = [...document.querySelectorAll<HTMLButtonElement>(".display-mode-btn")];
  for (const btn of modeBtns) {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode ?? "";
      if (!isDisplayMode(mode)) return;
      viewer.setDisplayMode(mode);
      refreshColors();
      for (const b of modeBtns) b.classList.toggle("active", b === btn);
    });
  }
}

/**
 * Live clipping/section plane — display-only, distinct from the `section`
 * edit op. Every slider `input` applies immediately (no commit-gating, unlike
 * the meshing size slider — there's nothing to persist here).
 */
function setupClippingControls(): void {
  let clipAxis: ClipAxis = "x";
  let clipEnabled = false;
  const axisBtns = [...document.querySelectorAll<HTMLButtonElement>(".clip-axis")];
  const offsetSlider = document.getElementById("clip-offset") as HTMLInputElement | null;
  const toggleBtn = document.getElementById("clip-toggle");

  const applyClip = () => {
    if (!clipEnabled || !offsetSlider) {
      viewer.setClippingPlane(null);
      return;
    }
    const model = viewer.getModel();
    const box = model ? new THREE.Box3().setFromObject(model) : null;
    if (!box || box.isEmpty()) {
      viewer.setClippingPlane(null);
      return;
    }
    viewer.setClippingPlane(planeForAxis(clipAxis, Number(offsetSlider.value) / 100, box));
  };

  for (const btn of axisBtns) {
    btn.addEventListener("click", () => {
      clipAxis = btn.dataset.axis as ClipAxis;
      axisBtns.forEach((b) => b.classList.toggle("active", b === btn));
      applyClip();
    });
  }
  offsetSlider?.addEventListener("input", applyClip);
  toggleBtn?.addEventListener("click", () => {
    clipEnabled = !clipEnabled;
    toggleBtn.classList.toggle("active", clipEnabled);
    toggleBtn.textContent = clipEnabled ? "On" : "Off";
    applyClip();
  });
}

/**
 * Markup annotation overlay: freehand/line/arrow/rectangle/circle strokes on
 * a transparent `<canvas>` stacked over the 3D view (`#markup-canvas`, see
 * `viewerDom.ts`), composited into Screenshot exports by `Viewer` (see
 * `canvasComposite.ts`). Session-only, never persisted — same rule as every
 * other display-only feature (explode preview, clip plane, measurement).
 * The canvas is `pointer-events:none` until markup mode is toggled on, so it
 * never interferes with orbiting/picking while inactive.
 */
function setupMarkupControls(): void {
  const canvas = document.getElementById("markup-canvas") as HTMLCanvasElement | null;
  const toggleBtn = document.getElementById("markup-toggle");
  const toolBtns = [...document.querySelectorAll<HTMLButtonElement>(".markup-tool-btn")];
  const colorInput = document.getElementById("markup-color") as HTMLInputElement | null;
  if (!canvas || !toggleBtn || toolBtns.length === 0 || !colorInput) return;

  const menu = setupDropdown("markup-menu", "markup-dropdown");
  const model = new MarkupModel();
  let active = false;
  let drawing = false;
  let tool: MarkupTool = "freehand";
  let current: Point[] = [];

  const reflect = () => {
    if (!menu) return;
    menu.trigger.classList.toggle("active", active);
    menu.trigger.title = active
      ? `Markup mode: on — ${tool}`
      : "Draw review annotations over the 3D view";
  };

  function resizeCanvas(): void {
    const rect = canvas!.getBoundingClientRect();
    canvas!.width = Math.max(1, Math.round(rect.width));
    canvas!.height = Math.max(1, Math.round(rect.height));
    redraw();
  }
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  function redraw(preview?: MarkupStroke): void {
    redrawAll(canvas!, model.list(), preview);
  }

  function currentTool(): MarkupTool {
    return tool;
  }

  for (const btn of toolBtns) {
    btn.addEventListener("click", () => {
      tool = btn.dataset.tool as MarkupTool;
      for (const b of toolBtns) b.classList.toggle("active", b === btn);
      reflect();
    });
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (!active) return;
    const pt: Point = { x: e.offsetX, y: e.offsetY };
    if (currentTool() === "eraser") {
      if (model.eraseAt(pt)) redraw();
      return;
    }
    drawing = true;
    current = [pt];
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!active || !drawing) return;
    const tool = currentTool();
    if (tool === "eraser") return;
    const pt: Point = { x: e.offsetX, y: e.offsetY };
    if (tool === "freehand") current.push(pt);
    else current[1] = pt; // line/arrow/rectangle/circle: live-preview the second point only
    redraw({ tool, color: colorInput!.value, points: current });
  });
  canvas.addEventListener("pointerup", () => {
    if (!active || !drawing) return;
    drawing = false;
    const tool = currentTool();
    if (tool !== "eraser" && current.length >= 2) {
      model.push({ tool, color: colorInput!.value, points: [...current] });
    }
    current = [];
    redraw();
  });

  toggleBtn.addEventListener("click", () => {
    active = !active;
    canvas.style.pointerEvents = active ? "auto" : "none";
    toggleBtn.classList.toggle("active", active);
    toggleBtn.setAttribute("aria-checked", String(active));
    reflect();
  });
  document.getElementById("markup-undo")?.addEventListener("click", () => {
    model.undo();
    redraw();
  });
  document.getElementById("markup-redo")?.addEventListener("click", () => {
    model.redo();
    redraw();
  });
  document.getElementById("markup-clear")?.addEventListener("click", () => {
    model.clear();
    redraw();
  });

  clearMarkupOverlay = () => {
    model.clear();
    redraw();
  };

  viewer.setMarkupCanvas(canvas);
}

try {
  setupViewControls();
  setupViewMenu();
  setupSelectionControls();
  setupMeasureControls();
  setupFileMenu();
  setupDragAndDrop();
  setupAppearanceControls();
  setupClippingControls();
  setupMarkupControls();
} catch (err) {
  const message = `View controls failed to initialize: ${(err as Error).message}`;
  console.error(message, err);
  post({ type: "log", message });
}

// ── Meshing toolbar toggle ────────────────────────────────────────────────
// Toggling only controls whether the generated overlay is shown; the panel
// itself is always present in the sidebar. A separate try/catch from the view
// controls above, per the same invariant: a throw here must never block the
// `ready` handshake / model loading below.
// `meshingToggle` is hoisted out of the try block (mirroring `meshingEnabled`)
// so the `meshingResult` handler below can also reflect "a mesh is currently
// displayed" on the button, keeping the toggle's visual state truthful instead
// of only ever being flipped by the click handler itself.
let meshingEnabled = false;
let meshingToggle: HTMLElement | null = null;
// Mirrors `meshingEnabled`/`meshingToggle` above, for the worst-quality-
// elements highlight overlay — a separate on/off state since a user may want
// the FE mesh shown without the (visually loud) highlight, or vice versa.
let worstElementsShown = false;
let worstToggle: HTMLElement | null = null;
try {
  meshingToggle = document.getElementById("meshing-toggle");
  meshingToggle?.addEventListener("click", () => {
    meshingEnabled = !meshingEnabled;
    meshingToggle?.classList.toggle("active", meshingEnabled);
    // Show/hide in place (keeps the generated overlay alive) rather than
    // `setMeshOverlay(null)`, which disposes it — otherwise toggling off then
    // back on left the mesh gone until the next Generate. A no-op if nothing
    // has been generated yet.
    viewer.setMeshOverlayVisible(meshingEnabled);
  });

  worstToggle = document.getElementById("meshing-worst-toggle");
  worstToggle?.addEventListener("click", () => {
    worstElementsShown = !worstElementsShown;
    worstToggle?.classList.toggle("active", worstElementsShown);
    viewer.setWorstElementsOverlayVisible(worstElementsShown);
  });
} catch (err) {
  const message = `Meshing controls failed to initialize: ${(err as Error).message}`;
  console.error(message, err);
  post({ type: "log", message });
}

window.addEventListener("unload", () => {
  viewer.dispose();
});

window.addEventListener("message", async (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case "geometry":
      try {
        setStatus("Building geometry…");
        const group = buildGroupFromEncoded(msg.meshes, msg.edges, msg.points);
        viewer.setModel(group);
        explodePreviewBases = null; // stale references to the just-replaced model's objects
        lastRawMassProperties = null; // stale — refers to the just-replaced model
        clearMarkupOverlay?.();
        refreshColors();
        setSelectableModes(["volume", "surface", "line", "point"]);
        editsPanel.setBRepOnly(true); // fillet/chamfer available for B-rep
        sourceKind = "brep";
        meshingPanel.setSourceKind("brep");
        meshingPanel.setModelExtents(viewer.getModelExtents());
        syncMeshSizeSeed();
        showSidebar();
        setStatus("");
      } catch (err) {
        setStatus(`Failed to build geometry: ${(err as Error).message}`, true);
      }
      break;

    case "tree":
      setDisplayUnit(displayUnitFromStepName(msg.sourceUnit) ?? "mm");
      showTree(msg.root);
      break;

    case "parts":
      partsModel.load(msg.parts);
      visibilityState.onPartCountChanged(partsModel.size);
      refreshColors(); // also re-applies visibility state, see refreshColors()
      partsPanel.render(partsModel.list());
      meshingPanel.renderParts(partsModel.list());
      showSidebar();
      break;

    case "edits":
      // Hydrate the op-stack + variables from the sidecar (does not echo back
      // as a write — both `load`s deliberately skip onChange).
      variablesModel.load(msg.variables);
      editsModel.load(msg.ops);
      renderEditsUi();
      // B-rep arrives already-tessellated with these ops; mesh replays locally.
      if (pristineMesh) rebuildMeshModel();
      showSidebar();
      break;

    case "loadUrl":
      await loadMeshObjectFromUrl(msg.url, msg.format, msg.format.toUpperCase());
      break;

    case "loadMeshBytes":
      // Host-converted bytes (meshio++-imported document — VTK/MED/CGNS/
      // Exodus/XDMF/MDPA — funneled through `convertToStlBoundary()` into an
      // STL boundary surface; see `src/meshioService.ts`). Fed through the
      // exact same STL-loading path a native `.stl` open uses, via a `blob:`
      // object URL instead of a `vscode-webview://` fetch — base64-over-
      // postMessage rather than a `data:` URL, the same proven pattern
      // `geometry` already uses for large buffers, sidestepping any webview
      // CSP/size-limit uncertainty around `data:` URLs.
      try {
        const bytes = Uint8Array.from(atob(msg.dataBase64), (c) => c.charCodeAt(0));
        const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "model/stl" }));
        try {
          await loadMeshObjectFromUrl(blobUrl, "stl", msg.sourceFormat.toUpperCase());
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
      } catch (err) {
        setStatus(`Failed to load model: ${(err as Error).message}`, true);
      }
      break;

    case "status":
      setStatus(msg.text);
      break;

    case "error":
      setStatus(msg.message, true);
      break;

    case "editError":
      setStatus(msg.message, true);
      break;

    case "exportMesh":
      try {
        const model = viewer.getModel();
        if (!model) throw new Error("No model loaded");
        const { data, binary } = await exportModel(model, msg.format, msg.unit);
        post({ type: "exportResult", requestId: msg.requestId, data, binary });
      } catch (err) {
        post({ type: "exportError", requestId: msg.requestId, message: (err as Error).message });
      }
      break;

    case "meshingOptions":
      // Initial hydration from the host (or the reloaded sidecar) — does not echo back as a write.
      meshingModel.load(msg.options);
      syncMeshSizeSeed();
      meshingPanel.render(meshingModel.get());
      break;

    case "viewerDefaults":
      // Cross-document settings — only ever initial state; per-document sidecar
      // values and runtime toggles (the toolbar Grid button) always win once set.
      meshSizePreset = msg.meshSizePreset;
      viewer.applyDefaults(msg);
      syncMeshSizeSeed();
      {
        const bg = document.getElementById("vc-background") as HTMLInputElement | null;
        if (bg) bg.value = msg.background;
      }
      break;

    case "screenshotRequest":
      try {
        viewer.render(); // force a fresh frame right before capture (no persistent preserveDrawingBuffer)
        const data = viewer.captureScreenshotBase64();
        post({ type: "screenshotResult", requestId: msg.requestId, data });
      } catch (err) {
        post({ type: "screenshotError", requestId: msg.requestId, message: (err as Error).message });
      }
      break;

    case "renderViewRequest":
      // Every renderViewRequest this feature ever sends targets a
      // disposable, harness-only headless page (src/renderService.ts) —
      // never a live interactive session — so mutating camera-up/wireframe/
      // visibility here needs no state restoration afterward.
      try {
        viewer.setCameraUp(new THREE.Vector3(...(msg.up ?? [0, 1, 0])));
        viewer.setViewDirection(new THREE.Vector3(...msg.direction));
        if (msg.focus || msg.hide) {
          viewer.applyPartVisibility(msg.hide ?? [], msg.focus?.length ? msg.focus : null);
        }
        if (msg.wireframe !== undefined) viewer.setWireframe(msg.wireframe);
        viewer.render();
        const data = viewer.captureLabeledScreenshotBase64(msg.label);
        post({ type: "renderViewResult", requestId: msg.requestId, data });
      } catch (err) {
        post({ type: "renderViewError", requestId: msg.requestId, message: (err as Error).message });
      }
      break;

    case "massPropertiesResult":
      if (msg.requestId !== massPropertiesRequestId) break; // stale — a newer refresh superseded it
      renderMassProperties(msg.properties);
      break;

    case "massPropertiesError":
      if (msg.requestId !== massPropertiesRequestId) break;
      massPropertiesPanel.renderMessage(msg.message, true);
      break;

    case "meshingResult":
      meshingPanel.setBusy(false);
      viewer.setMeshOverlay(buildFEMesh(msg.positions, msg.indices, msg.edges, msg.elementGroups));
      // A successful generate always results in a visible overlay, so bring the
      // toggle's state in sync here (rather than optimistically in `onGenerate`,
      // before the async round-trip even completes) — that way a failed generate
      // never leaves the toggle falsely claiming "on" for content that was never
      // displayed (see `meshingError` below, which deliberately leaves state alone).
      meshingEnabled = true;
      meshingToggle?.classList.add("active");
      // Worst-elements highlight: a fresh `setWorstElementsOverlay` every
      // generate (disposes any stale one from the previous result), and —
      // unlike the base FE-mesh toggle, which just needs to reflect reality —
      // auto-SHOWN when present, same "surface a warning by default" framing
      // as the large-mesh warning banner above: finding bad elements is
      // presented as an alert, not a hidden feature the user has to discover.
      viewer.setWorstElementsOverlay(
        msg.worstElements ? buildWorstElementsHighlight(msg.positions, msg.worstElements.indices) : null
      );
      worstElementsShown = msg.worstElements != null;
      worstToggle?.classList.toggle("active", worstElementsShown);
      if (worstToggle) {
        worstToggle.hidden = !msg.worstElements;
        if (msg.worstElements) {
          worstToggle.title = `Highlight worst-quality elements — ${msg.worstElements.belowThresholdCount} below quality ${msg.worstElements.threshold.toFixed(2)}`;
        }
      }
      viewer.setWorstElementsOverlayVisible(worstElementsShown);
      meshingPanel.render(meshingModel.get(), {
        nodeCount: msg.nodeCount,
        elementCount: msg.elementCount,
        elapsedMs: msg.elapsedMs,
        quality: msg.quality,
        worstElements: msg.worstElements,
      });
      break;

    case "meshingError":
      // Nothing new was displayed on failure — leave `meshingEnabled`/the toggle's
      // state exactly as it was (whatever overlay, if any, was already shown stays).
      meshingPanel.setBusy(false);
      meshingPanel.render(meshingModel.get(), { error: msg.message });
      break;
  }
});

/**
 * Shared load path for both `"loadUrl"` (a `vscode-webview://` fetch of a
 * native STL/OBJ/PLY/glTF file) and `"loadMeshBytes"` (a `blob:` URL wrapping
 * host-converted bytes for a meshio++-imported document, always `"stl"`
 * format regardless of the original file's format — see the `case
 * "loadMeshBytes"` handler). `loaderFormat` picks the Three.js loader;
 * `treeLabel` is what the Components tree root shows (the *original* source
 * format for a meshio-imported document, not always `"STL"`).
 */
async function loadMeshObjectFromUrl(url: string, loaderFormat: CadFormat, treeLabel: string): Promise<void> {
  try {
    setStatus("Loading model…");
    setDisplayUnit("mm"); // mesh sources carry no unit metadata
    lastRawMassProperties = null; // stale — refers to the just-replaced model
    clearMarkupOverlay?.();
    const object = await loadMeshFromUrl(url, loaderFormat);
    tagMeshEntities(object);
    // Build the Components tree from the original hierarchy (before the mesh
    // is split into facets, so the tree lists whole objects, not facets).
    const root = extractObjectTree(object, treeLabel);
    // Cache the pristine object; the displayed model is rebuilt from it with
    // the current edits applied (no-op when there are none).
    pristineMesh = object;
    rebuildMeshModel();
    // Meshes have facet "surfaces" and whole-object "volumes", but no edges.
    setSelectableModes(["volume", "surface"]);
    editsPanel.setBRepOnly(false); // fillet/chamfer need exact topology (B-rep)
    sourceKind = "mesh";
    meshingPanel.setSourceKind("mesh");
    meshingPanel.setModelExtents(viewer.getModelExtents());
    syncMeshSizeSeed();
    showSidebar();
    setStatus("");
    if (hasMultipleNodes(root)) showTree(root);
  } catch (err) {
    setStatus(`Failed to load model: ${(err as Error).message}`, true);
  }
}

/**
 * Tags a Three.js-loaded model with STABLE ids (traversal order, not uuid) so
 * part assignments round-trip across reopen. Each object's id becomes its
 * `groupId`; a mesh's id is its volume id, carried onto the facet group built by
 * `splitMeshesIntoFacets`. The shared id keeps the Components tree highlight
 * working.
 */
function tagMeshEntities(obj: THREE.Object3D): void {
  let i = 0;
  obj.traverse((o) => {
    o.userData.groupId = `node-${i++}`;
  });
}

/** Build a TreeNode from an Object3D hierarchy (for Three.js-loaded formats). */
function extractObjectTree(obj: THREE.Object3D, rootLabel: string): TreeNode {
  function toNode(o: THREE.Object3D): TreeNode {
    const label = o.name || (o instanceof THREE.Mesh ? "Mesh" : "Group");
    const children = o.children
      .filter((c) => c instanceof THREE.Mesh || c instanceof THREE.Group)
      .map(toNode);
    return { id: o.userData.groupId as string, label, children: children.length > 0 ? children : undefined };
  }
  return { id: "root", label: rootLabel, children: obj.children.map(toNode) };
}

function hasMultipleNodes(root: TreeNode): boolean {
  return (root.children?.length ?? 0) > 0;
}

post({ type: "ready" });
