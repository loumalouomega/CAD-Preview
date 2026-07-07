import * as THREE from "three";
import { Viewer } from "./viewer";
import { loadMeshFromUrl } from "./meshLoaders";
import { exportModel } from "./meshExporters";
import { buildGroupFromEncoded, buildFEMesh } from "./geometryBuilder";
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
import { defaultTargetSize } from "./meshSizeHeuristics";
import { SIZE_MAX_SENTINEL } from "../meshOptions";
import { applyEditsMesh } from "./meshEdits";
import { SelectionSet, type SelectedEntity } from "./selection";
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
const treePanel = new TreePanel(panelEl, (id) => {
  viewer.highlightGroup(id);
});

// ── Parts / selection state ──────────────────────────────────────────────
const selection = new SelectionSet();
let previewPartIndex: number | null = null;

const partsModel = new PartsModel(() => {
  // Fired on every parts mutation: persist, recolour, re-render (both the
  // Parts panel and the FE Mesh panel's mirrored "Part sizes" rows).
  post({ type: "partsChanged", parts: partsModel.list() });
  refreshColors();
  partsPanel.render(partsModel.list());
  meshingPanel.renderParts(partsModel.list());
});

const partsPanel = new PartsPanel(document.getElementById("parts-panel")!, {
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
});

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
    const op: EditOp = { op: "explode", factor };
    if (exprs) op.exprs = exprs;
    editsModel.push(op);
    setStatus("");
  },
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
    // Same toggle-truthfulness invariant as `meshingResult`/`meshingError`
    // below: Clear disposes the overlay, so the toggle must stop claiming "on".
    meshingEnabled = false;
    meshingToggle?.classList.remove("active");
    meshingPanel.render(meshingModel.get());
  },
});

/**
 * Seeds a bbox-derived default target size while `sizeMax` is still the
 * "unbounded" sentinel. Called from the `geometry`, `loadUrl`, AND
 * `meshingOptions` handlers — model geometry and the options sidecar arrive
 * in no deterministic order (B-rep tessellation is async), so whichever lands
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
  meshingModel.load({ ...meshingModel.get(), sizeMax: defaultTargetSize(extents.diagonal) });
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
  const toggle = document.getElementById("sel-toggle");
  const modeBtns = [...document.querySelectorAll<HTMLButtonElement>(".sel-mode")];
  const apply = () => viewer.setSelectionMode(selecting ? selectMode : null);
  toggle?.addEventListener("click", () => {
    selecting = !selecting;
    toggle.classList.toggle("active", selecting);
    apply();
  });
  for (const btn of modeBtns) {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      selectMode = btn.dataset.mode as EntityType;
      modeBtns.forEach((b) => b.classList.toggle("active", b === btn));
      if (selecting) apply();
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

document.getElementById("fit")?.addEventListener("click", () => viewer.fitView());
document.getElementById("grid")?.addEventListener("click", () => viewer.toggleGrid());
document.getElementById("export")?.addEventListener("click", () => post({ type: "exportRequest" }));
document.getElementById("tree-close")?.addEventListener("click", () => {
  treePanel.hide();
  window.dispatchEvent(new Event("resize"));
});
document.getElementById("tree-toggle")?.addEventListener("click", () => {
  treePanel.toggle();
  window.dispatchEvent(new Event("resize"));
});

let wireframe = false;
document.getElementById("wireframe")?.addEventListener("click", () => {
  wireframe = !wireframe;
  viewer.setWireframe(wireframe);
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

try {
  setupViewControls();
  setupSelectionControls();
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
        refreshColors();
        setSelectableModes(["volume", "surface", "line", "point"]);
        editsPanel.setBRepOnly(true); // fillet/chamfer available for B-rep
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
      showTree(msg.root);
      break;

    case "parts":
      partsModel.load(msg.parts);
      refreshColors();
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
      try {
        setStatus("Loading model…");
        const object = await loadMeshFromUrl(msg.url, msg.format);
        tagMeshEntities(object);
        // Build the Components tree from the original hierarchy (before the mesh
        // is split into facets, so the tree lists whole objects, not facets).
        const root = extractObjectTree(object, msg.format.toUpperCase());
        // Cache the pristine object; the displayed model is rebuilt from it with
        // the current edits applied (no-op when there are none).
        pristineMesh = object;
        rebuildMeshModel();
        // Meshes have facet "surfaces" and whole-object "volumes", but no edges.
        setSelectableModes(["volume", "surface"]);
        editsPanel.setBRepOnly(false); // fillet/chamfer need exact topology (B-rep)
        meshingPanel.setSourceKind("mesh");
        meshingPanel.setModelExtents(viewer.getModelExtents());
        syncMeshSizeSeed();
        showSidebar();
        setStatus("");
        if (hasMultipleNodes(root)) showTree(root);
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
        const { data, binary } = await exportModel(model, msg.format);
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
      meshingPanel.render(meshingModel.get(), {
        nodeCount: msg.nodeCount,
        elementCount: msg.elementCount,
        elapsedMs: msg.elapsedMs,
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
