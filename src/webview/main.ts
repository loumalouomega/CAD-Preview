import * as THREE from "three";
import { Viewer } from "./viewer";
import { refreshPalette } from "./palette";
import { buildEntityReferenceIndex } from "./opCatalog";
import { hoverContent, inspectorContent } from "./entityExplain";
import { MacrosPanel } from "./macrosPanel";
import { selectionGroupsFor } from "./selectionGroups";
import { loadMeshFromUrl } from "./meshLoaders";
import { COMPARABLE_MESH_FORMATS, type CadFormat, type MeshParseFormat } from "../fileRouter";
import { exportModel } from "./meshExporters";
import { buildGroupFromEncoded, buildFEMesh, buildWorstElementsHighlight, buildColorFieldOverlay } from "./geometryBuilder";
import { viridisCssGradientStops } from "./colorMap";
import { splitMeshesIntoFacets } from "./meshFacets";
import { parseSvgPaths } from "../svgImport";
import { parseDxf } from "../dxfImport";
import { TreePanel } from "./treePanel";
import { PartsModel } from "./partsModel";
import { PartsPanel } from "./partsPanel";
import { AnnotationsModel } from "./annotationsModel";
import { PlanesModel } from "./planesModel";
import { TOOLBAR_ICONS } from "../toolbarIcons";
import { EditsModel } from "./editsModel";
import { EditsPanel, type TransformDraft, type FeatureDraft, type ModifyDraft, type PrimitiveDraft, type HoleDraft, type ProfileDraft, type WireframeDraft, type AlignDraft, type PatternDraft } from "./editsPanel";
import { OpPreviewScheduler } from "./opPreviewScheduler";
import type { PanelOpId } from "./opCatalog";
import { VariablesModel } from "./variablesModel";
import { VariablesPanel } from "./variablesPanel";
import { evaluateVariables, resolveEditOps } from "../editVariables";
import { resolvePlaneRefs } from "../planeRefs";
import { extractIdentifiers } from "../paramExpr";
import { annotatedLabelText, evaluateToleranceBand, type AnnotatedTolerance } from "../toleranceBand";
import { MeshingModel } from "./meshingModel";
import { MeshingPanel } from "./meshingPanel";
import { MassPropertiesPanel, type MassPropertiesDisplay } from "./massPropertiesPanel";
import { MeshHealthPanel } from "./meshHealthPanel";
import { RegionFitPanel } from "./regionFitPanel";
import { fitConstructionPlane, fitOpForKind, fitStoreWarning } from "../fitMapping";
import { validateEditOp, GUIDE_KINDS } from "../editOps";
import { StandardPartsPanel } from "./standardPartsPanel";
import type { StandardPart } from "../stepPartsService";
import { computeMeshMassProperties } from "./meshMassProperties";
import { targetSizeForPreset } from "./meshSizeHeuristics";
import { SIZE_MAX_SENTINEL } from "../meshOptions";
import type { MeshSizePreset } from "../viewerDefaults";
import { applyEditsMesh } from "./meshEdits";
import { SelectionSet, type SelectedEntity } from "./selection";
import { VisibilityState } from "./visibilityState";
import { collectTargets } from "./picking";
import {
  FACE_FILTERS,
  LINE_FILTERS,
  applyFaceFilter,
  applyLineFilter,
  type FaceFilterId,
  type LineFilterId,
} from "./selectFilters";
import { captureExplodeBase, applyExplodePreview, resetExplodePreview, type ExplodeBase } from "./explodePreview";
import { applyTranslateDelta, applyRotateDelta, applyScaleDelta, quaternionToAxisAngle, snapTranslateDelta, nearestSnapPoint, type TransformBase } from "./gizmoTransform";
import {
  planeForClip,
  orientTowardBulk,
  planeFromThreePoints,
  dominantAxis,
  type ClipAxis,
  type ClipPlaneState,
} from "./clipping";
import { MeasurementState, type MeasureTool, type MeasurementPick } from "./measurementState";
import { pointDistance, polylineLength, angleBetweenVectors, circleRadiusFromArcPoints, type Vec3 } from "./measurement";
import { convertLength, convertLengthBasedProperties, displayUnitFromUnitName, type DisplayUnit, type LengthBasedProperties } from "./units";
import type { EntityFacts, ExactMeasureKind } from "../entityFacts";
import { isDisplayMode, type DisplayMode } from "./displayMode";
import { MarkupModel, type MarkupStroke, type MarkupTool, type Point } from "./markupModel";
import { redrawAll } from "./markupCanvas";
import { setupDropdown } from "./dropdownMenu";
import type { HostToWebview, WebviewToHost, TreeNode, EntityType, EditOp, ViewState, Annotation } from "../protocol";
import type { OpOutcome } from "../editOps";

declare function acquireVsCodeApi(): { postMessage(msg: WebviewToHost): void };

const vscode = acquireVsCodeApi();
const post = (msg: WebviewToHost) => vscode.postMessage(msg);

/** Mirrors `geometryBuilder.ts`'s local `decodeF32`/`decodeU32` — this
 * module's own base64 decode for `loadMeshBytes.regionAssignment`'s
 * `Int32Array` (see `protocol.ts`'s `encodeBuffer`). */
function decodeI32(b64: string): Int32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int32Array(bytes.buffer);
}

const app = document.getElementById("app")!;
const statusEl = document.getElementById("status")!;
const sideEl = document.getElementById("side")!;
const panelEl = document.getElementById("tree-panel")!;
const toggleBtn = document.getElementById("tree-toggle") as HTMLButtonElement;

// Resolve the CSS palette BEFORE the Viewer is constructed — its constructor
// builds the background, lights and grid from it, and every material built
// during the first model load reads it too.
refreshPalette();

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

// ── Persisted, topology-anchored annotations (pinned measurements) ───────
// A small list under the Measure ▾ panel — see `Annotation`'s doc comment in
// protocol.ts. "Detached" is computed here, not stored: an annotation whose
// anchor entities don't currently resolve in the loaded model (removed, or a
// mesh-format edit with no rebind engine) shows struck-through with its
// "Show" action disabled, rather than displaying a now-meaningless overlay.
function renderAnnotationsList(): void {
  const container = document.getElementById("annotations-list");
  if (!container) return;
  container.innerHTML = "";
  for (const a of annotationsModel.list()) {
    const entities = AnnotationsModel.entitiesOf(a);
    const detached = entities.length === 0 || !entities.some((e) => viewer.hasEntity(e.entityType, e.entityId));
    // The band decoration + in/out-of-band colour are derived at render time
    // from the annotation's frozen facts — never stored.
    const evaluation = a.tolerance ? evaluateToleranceBand(a.tolerance.measured, a.tolerance) : null;
    const outOfBand = evaluation !== null && !evaluation.withinTolerance;
    const displayText = annotatedLabelText(a.text, a.tolerance);
    const label = a.label ? `${a.label}: ${displayText}` : displayText;

    const row = document.createElement("div");
    row.className = detached ? "annotation-row detached" : "annotation-row";

    const text = document.createElement("span");
    text.className = outOfBand ? "annotation-row-text annotation-out-of-tolerance" : "annotation-row-text";
    text.textContent = outOfBand ? `${label} — outside tolerance` : label;
    text.title = detached
      ? "Detached — the anchored entity no longer resolves (removed, or couldn't be re-matched across an edit)."
      : label;
    row.appendChild(text);

    const showBtn = document.createElement("button");
    showBtn.textContent = "Show";
    showBtn.title = "Re-display this measurement's overlay";
    showBtn.disabled = detached;
    showBtn.addEventListener("click", () => {
      viewer.showMeasurementOverlay(
        a.linePoints.map((p) => new THREE.Vector3(...p)),
        new THREE.Vector3(...a.anchorPoint),
        displayText,
        { tone: outOfBand ? "fail" : "normal" }
      );
      setMeasureReadout(label);
    });
    row.appendChild(showBtn);

    const delBtn = document.createElement("button");
    delBtn.innerHTML = TOOLBAR_ICONS.close;
    delBtn.title = "Delete this annotation";
    delBtn.addEventListener("click", () => annotationsModel.remove(a.id));
    row.appendChild(delBtn);

    container.appendChild(row);
  }
}

const annotationsModel = new AnnotationsModel(() => {
  post({ type: "annotationsChanged", annotations: annotationsModel.list() });
  renderAnnotationsList();
});

// ── Named construction planes ────────────────────────────────────────────
// A plane stores RESOLVED vectors, never a live face reference, so nothing
// here participates in entity rebinding: a plane is not renumbered by replay
// the way `face-N` is, which is the whole point of naming one.
const planesModel = new PlanesModel(() => {
  post({ type: "planesChanged", planes: planesModel.list() });
  renderPlanesList();
});

/** Set by `setupClippingControls`, which owns the clip state this reads and writes. */
let planesClipHandle: { applyDerivedPlane(n: THREE.Vector3, p: THREE.Vector3, label: string): void; getState(): ClipState } | null = null;

function renderPlanesList(): void {
  refreshMidplanePickers(); // the midplane creator's pickers must never offer a stale plane
  try { (editsPanel as unknown as { setPlanes: (p: unknown[]) => void })?.setPlanes?.(planesModel.list()); } catch {}
  const container = document.getElementById("planes-list");
  if (!container) return;
  container.innerHTML = "";
  for (const plane of planesModel.list()) {
    const row = document.createElement("div");
    row.className = "plane-row";

    const name = document.createElement("span");
    name.className = "plane-row-name";
    name.textContent = plane.name;
    const fmt = (v: readonly number[]) => v.map((n) => n.toFixed(3)).join(", ");
    name.title = `point (${fmt(plane.point)}) · normal (${fmt(plane.normal)})${
      plane.derivedFrom ? ` · from ${plane.derivedFrom}` : ""
    }`;
    row.appendChild(name);

    const use = document.createElement("button");
    use.textContent = "Use";
    use.title = "Clip along this plane";
    use.addEventListener("click", () => {
      if (!planesClipHandle) return;
      planesClipHandle.applyDerivedPlane(
        new THREE.Vector3(...plane.normal),
        new THREE.Vector3(...plane.point),
        plane.name
      );
    });
    row.appendChild(use);

    const rename = document.createElement("button");
    rename.textContent = "✎";
    rename.title = "Rename";
    rename.addEventListener("click", () => {
      // VS Code webviews block prompt(); rename inline, same as the Parts panel.
      const input = document.createElement("input");
      input.type = "text";
      input.value = plane.name;
      input.className = "plane-row-rename";
      const commit = () => planesModel.rename(plane.id, input.value);
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") renderPlanesList();
      });
      row.replaceChild(input, name);
      input.focus();
      input.select();
    });
    row.appendChild(rename);

    const del = document.createElement("button");
    del.innerHTML = TOOLBAR_ICONS.close;
    del.title = "Delete this plane";
    del.addEventListener("click", () => planesModel.remove(plane.id));
    row.appendChild(del);

    container.appendChild(row);
  }
}

/** Parses "1, 2, 3" into a vector, or null — deliberately tolerant of spacing. */
function parseVecField(text: string): [number, number, number] | null {
  const parts = text.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return [parts[0], parts[1], parts[2]];
}

/** Keeps the midplane creator's two plane `<select>`s in step with the saved
 * planes (called from `renderPlanesList`, so a plane added/deleted while the
 * picker row is open never offers a stale id). */
function refreshMidplanePickers(): void {
  const midA = document.getElementById("plane-mid-a") as HTMLSelectElement | null;
  const midB = document.getElementById("plane-mid-b") as HTMLSelectElement | null;
  if (!midA || !midB) return;
  const planes = planesModel.list();
  for (const sel of [midA, midB]) {
    sel.innerHTML = "";
    for (const p of planes) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
  }
}

function setupPlanesControls(): void {
  const saveBtn = document.getElementById("plane-save");
  const addBtn = document.getElementById("plane-add");
  const entry = document.getElementById("plane-entry");
  const pointField = document.getElementById("plane-entry-point") as HTMLInputElement | null;
  const normalField = document.getElementById("plane-entry-normal") as HTMLInputElement | null;
  const okBtn = document.getElementById("plane-entry-ok");

  saveBtn?.addEventListener("click", () => {
    const state = planesClipHandle?.getState();
    if (!state) {
      setStatus("Turn clipping on first — there is no plane to save.", true);
      return;
    }
    const box = viewer.getModel() ? new THREE.Box3().setFromObject(viewer.getModel()!) : null;
    if (!box) {
      setStatus("No model to derive a plane from.", true);
      return;
    }
    // Re-derive the SAME plane the clip is currently showing, through the very
    // function that built it, so a saved plane and the live clip can never
    // disagree about what "this plane" means.
    const plane = planeForClip(state, box);
    const point = plane.normal.clone().multiplyScalar(-plane.constant);
    planesModel.add({
      name: `Plane ${planesModel.size + 1}`,
      point: [point.x, point.y, point.z],
      normal: [plane.normal.x, plane.normal.y, plane.normal.z],
      derivedFrom: "clip plane",
    });
    setStatus("Saved the current clip plane.");
  });

  addBtn?.addEventListener("click", () => {
    if (!entry) return;
    entry.hidden = !entry.hidden;
    if (!entry.hidden) pointField?.focus();
  });

  okBtn?.addEventListener("click", () => {
    const point = parseVecField(pointField?.value ?? "");
    const normal = parseVecField(normalField?.value ?? "");
    if (!point || !normal) {
      setStatus("Enter both a point and a normal as three comma-separated numbers.", true);
      return;
    }
    if (Math.hypot(...normal) < 1e-12) {
      setStatus("That normal is zero-length — it describes no plane.", true);
      return;
    }
    planesModel.add({ name: `Plane ${planesModel.size + 1}`, point, normal, derivedFrom: "entered" });
    if (pointField) pointField.value = "";
    if (normalField) normalField.value = "";
    if (entry) entry.hidden = true;
    setStatus("Added a construction plane.");
  });

  // ── Midplane creator (roadmap item 10's "midplane references" half) ──────
  // Computes client-side over the two picked saved planes — the same math and
  // validation `set_plane`'s `midplaneOf` applies headlessly — and stores a
  // RESOLVED plane, per the planes sidecar's "resolved vectors, never a live
  // reference" convention.
  const midToggle = document.getElementById("plane-mid-toggle");
  const midRow = document.getElementById("plane-mid");
  const midA = document.getElementById("plane-mid-a") as HTMLSelectElement | null;
  const midB = document.getElementById("plane-mid-b") as HTMLSelectElement | null;
  const midOk = document.getElementById("plane-mid-ok");

  midToggle?.addEventListener("click", () => {
    if (!midRow) return;
    midRow.hidden = !midRow.hidden;
    refreshMidplanePickers();
  });

  midOk?.addEventListener("click", () => {
    const planes = planesModel.list();
    const a = planes.find((p) => p.id === midA?.value);
    const b = planes.find((p) => p.id === midB?.value);
    if (!a || !b) {
      setStatus("Pick two saved planes to build a midplane between.", true);
      return;
    }
    const dot = a.normal[0]*b.normal[0] + a.normal[1]*b.normal[1] + a.normal[2]*b.normal[2];
    if (Math.abs(Math.abs(dot) - 1) > 1e-6) {
      setStatus("Midplane requires parallel plane normals.", true);
      return;
    }
    const nb: [number, number, number] = dot < 0 ? [-b.normal[0], -b.normal[1], -b.normal[2]] : b.normal;
    const n: [number, number, number] = a.normal;
    const da = a.point[0]*n[0] + a.point[1]*n[1] + a.point[2]*n[2];
    const db = b.point[0]*n[0] + b.point[1]*n[1] + b.point[2]*n[2];
    const midD = (da + db) / 2;
    const point: [number, number, number] = [a.point[0] + n[0]*(midD - da), a.point[1] + n[1]*(midD - da), a.point[2] + n[2]*(midD - da)];
    planesModel.add({ name: `Plane ${planesModel.size + 1}`, point, normal: n, derivedFrom: `midplane ${a.id}–${b.id}` });
    if (midRow) midRow.hidden = true;
    setStatus(`Added the midplane of ${a.name} and ${b.name}.`);
  });
}

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

/** The op list with every expression re-evaluated against the current variables, then plane ids. */
function currentResolvedOps(): { ops: EditOp[]; issues: string[] } {
  const { values } = evaluateVariables(variablesModel.list());
  const { ops: variableResolved, issues: variableIssues } = resolveEditOps(editsModel.list(), values);
  const { ops, issues: planeIssues } = resolvePlaneRefs(variableResolved, planesModel.list());
  return { ops, issues: [...variableIssues, ...planeIssues] };
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
  // The one choke point every op-list change funnels through — sidecar
  // hydration, a user edit, an undo/redo/jump, and an external reconciliation.
  // Rebuilding the hover tooltip's reverse index here (rather than per hover
  // event) is what keeps `EditsModel.list()`'s deep clone off the pointermove
  // path.
  rebuildEntityRefIndex();
  const { values, errors } = evaluateVariables(variablesModel.list());
  const { ops: variableResolved } = resolveEditOps(editsModel.list(), values);
  const { ops } = resolvePlaneRefs(variableResolved, planesModel.list());
  editsPanel.setVariables(values);
  editsPanel.setPlanes(planesModel.list());
  // Pending (redo-buffer) ops ride along in chronological order so the history
  // renders as a full clickable timeline (op-history scrubbing, roadmap Tier
  // 2 item 1). They are NOT resolved here: they aren't applied yet, and the
  // resolve-on-read contract re-evaluates them at every future consumption
  // point anyway.
  editsPanel.render(ops, editsModel.canUndo, editsModel.canRedo, lastOpOutcomes, editsModel.redoList(), lastOpBuckets);
  variablesPanel.render(variablesModel.list(), values, errors, variableUsage());
}

/** The most recent replay's per-op outcomes (see `editOps.ts`'s
 * `OpOutcome`) — set by the B-rep `"geometry"` handler and by
 * `rebuildMeshModel()` for mesh sources, consumed by `renderEditsUi()` so the
 * Edits history can mark an op that gracefully skipped instead of silently
 * showing an unchanged model. Cleared whenever a genuinely new model loads
 * before its fresh outcomes arrive (the geometry post always carries them). */
let lastOpOutcomes: OpOutcome[] | null = null;
/** The most recent replay's per-op produced-face classification buckets (see
 * `src/opBuckets.ts`) — set by the B-rep `"geometry"` handler, cleared by
 * `rebuildMeshModel()` (mesh sources have no B-rep buckets). Consumed by
 * `renderEditsUi()` so history rows can show +N chips. */
let lastOpBuckets: import("../opBuckets").OpBucket[] | null = null;
/** Guide-entity ids from the last B-rep `geometry` post — construction
 * geometry the feature ops (extrude/revolve/sweep/loft/buildSurface/
 * buildVolume) refuse as operands, mirrored host-side by the same rule. */
const guideEntityIds: Set<string> = new Set();

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
  if (model) {
    resetExplodePreview(explodePreviewBases);
    viewer.requestRender();
  }
  explodePreviewBases = null;
}

// ── Transform Gizmo (roadmap "Transform gizmo", closed) ──────────────────
// Three.js's own `TransformControls` (viewer.ts's thin wrapper) drives a
// LIVE PREVIEW of the currently-open translate/rotate/scale form — dragging
// never itself pushes an edit op; Apply is still the only thing that does
// (the same non-negotiable invariant `explodePreview.ts`'s slider already
// established, and reused here on purpose rather than a second write path
// that would bypass `EditsModel`'s push/undo/redo/remove contract).

type GizmoMode = "translate" | "rotate" | "scale";

/** One targeted volume's pristine transform, captured once per drag
 * (not per frame) — every `objectChange` recomputes from THIS, never from
 * the object's own already-dragged-this-frame state, matching
 * `explodePreview.ts`'s never-compound-onto-the-previous-frame discipline. */
interface GizmoTarget extends TransformBase {
  object: THREE.Object3D;
}

/** Which transform-kind form (if any) is currently open — `null` when no
 * form, or a non-transform form, is open. Set by `EditsPanelCallbacks.
 * onFormChanged`. */
let gizmoMode: GizmoMode | null = null;
/** Non-null only WHILE a drag is in progress (set on `dragging-changed`
 * true, cleared on Apply/cancel) — `null` between drags, even though the
 * live-previewed positions remain displayed until Apply or a form/selection
 * change discards them. */
let gizmoTargets: GizmoTarget[] | null = null;

// ── Grid/entity snapping (roadmap "Grid and entity snapping", closed) ────
// Session-only, like every other Appearance-group control (opacity,
// background, edge visibility) — never persisted. Wired from
// `setupViewMenu()`/`setupAppearanceControls()`; read from the gizmo's
// `onChange` handler below. Entity-point snap takes priority over grid
// snap PER TARGET when both are enabled and a close point is found for
// that specific target — grid snap still applies to any target that
// point-snap didn't resolve.
let snapToGridEnabled = false;
let snapToPointsEnabled = false;
let gridSnapSize = 1;

/** Every `point-N` entity's live world position currently in the model —
 * the entity-point snap candidate set. `point-N` sprites are the ONLY
 * individually-tagged, always-fully-populated point entities (FE-mesh
 * overlay vertices are display-only and excluded from picking already;
 * edge/face-mesh vertices were never separately tagged entities at all) —
 * see CLAUDE.md's "Bottom-up wireframe modeling" section.
 *
 * `traverseVisible`, not `traverse` — same load-bearing reason as
 * `picking.ts`'s collectors: a snap candidate is an implicit pick target,
 * and a hidden Part's points must not attract gizmo drags either (three's
 * Raycaster ignores `.visible`; this traversal must not). */
function collectSnapPoints(): THREE.Vector3[] {
  return [...collectPointEntities().values()];
}

/**
 * Every visible `point-N` entity, by id, in WORLD space — shared by gizmo
 * snapping and Clip ▸ 3 Pts.
 *
 * **`getWorldPosition`, not `.position`.** This used to read the local
 * position while being described as world-space; the two diverge whenever an
 * ancestor carries a transform, which for these sprites means during an
 * explode preview (the preview moves the top-level `groupId` groups). Identical
 * whenever no ancestor transform exists, so this is a strict improvement — but
 * it does change where a gizmo drag snaps mid-explode-preview, which is a real
 * if narrow behaviour change rather than a pure refactor.
 */
function collectPointEntities(): Map<string, THREE.Vector3> {
  const points = new Map<string, THREE.Vector3>();
  viewer.getModel()?.traverseVisible((o) => {
    if (o instanceof THREE.Sprite && o.userData.entityType === "point") {
      points.set(String(o.userData.entityId), o.getWorldPosition(new THREE.Vector3()));
    }
  });
  return points;
}

function gizmoModeForForm(id: PanelOpId | null): GizmoMode | null {
  return id === "translate" || id === "rotate" || id === "scale" ? id : null;
}

/** Resolves a `solid-N`/`node-N` id to its live top-level `Object3D` — the
 * same single-level (not deep) traversal `explodePreview.ts`'s own
 * `captureExplodeBase` already uses, since a volume's whole transform lives
 * on this one top-level, `groupId`-tagged node regardless of source format. */
function resolveVolumeObject(id: string): THREE.Object3D | null {
  return viewer.getModel()?.children.find((c) => c.userData.groupId === id) ?? null;
}

/** Re-attaches the gizmo at the CURRENT selection's combined bbox centre, or
 * detaches it when there's nothing (compatible) selected. Safe to call at
 * any time EXCEPT mid-drag (a drag must never have its attach target yanked
 * out from under it) — callers gate on `!viewer.isGizmoDragging()`.
 * Unconditionally discards any uncommitted preview first: this is also the
 * SELECTION-change entry point (not just the form-change one, which already
 * cancels via `updateGizmoForForm`), so a leftover live-dragged transform on
 * a since-deselected target must never be left stranded — same "switching
 * away discards the preview" rule `explodePreview.ts`'s form-switch cancel
 * already established, just also triggered by a selection change here. */
function refreshGizmoAttachment(): void {
  cancelGizmoPreview();
  if (!gizmoMode || viewer.isGizmoDragging()) return;
  const objects = selectedVolumes().map(resolveVolumeObject).filter((o): o is THREE.Object3D => o !== null);
  if (objects.length === 0) {
    viewer.detachTransformGizmo();
    return;
  }
  const box = new THREE.Box3();
  for (const o of objects) box.union(new THREE.Box3().setFromObject(o));
  viewer.attachTransformGizmo(box.getCenter(new THREE.Vector3()), gizmoMode);
}

/** Restores every currently-tracked target to its pristine (pre-drag) base
 * and clears gizmo drag state — called both when the user leaves the form
 * without applying (via `onFormChanged`/selection change) and right before
 * a real op-stack commit, exactly mirroring `cancelExplodePreview` above and
 * for the identical reason: the eventual model rebuild alone isn't
 * synchronous enough (a B-rep edit is an async host round trip) to be
 * trusted to supersede a stale live-dragged position without a visible
 * flash of wrong geometry in between. */
function cancelGizmoPreview(): void {
  if (gizmoTargets) {
    for (const t of gizmoTargets) {
      t.object.position.copy(t.basePosition);
      t.object.quaternion.copy(t.baseQuaternion);
      t.object.scale.copy(t.baseScale);
    }
    viewer.requestRender();
  }
  gizmoTargets = null;
}

/** Called whenever the Edits panel's open form changes — attaches/detaches/
 * retargets the gizmo for translate/rotate/scale, or hides it for every
 * other form (including no form at all). */
function updateGizmoForForm(id: PanelOpId | null): void {
  gizmoMode = gizmoModeForForm(id);
  if (!gizmoMode) {
    cancelGizmoPreview();
    viewer.detachTransformGizmo();
    return;
  }
  refreshGizmoAttachment(); // also discards any preview from the PREVIOUS form/mode
}

viewer.setGizmoHandlers(
  () => {
    // Fires continuously while dragging ("objectChange"). `gizmoTargets` is
    // guaranteed non-null here (set on drag-start, just below) — Three.js
    // never fires this event outside an active drag.
    if (!gizmoTargets || !gizmoMode) return;
    const d = viewer.getGizmoDelta();
    // Grid snap rounds the SHARED delta once (before the per-target loop) so
    // a multi-target drag still moves as one rigid group — see
    // `snapTranslateDelta`'s doc comment for why this must NOT be computed
    // per-target. Entity-point snap is the opposite: it's inherently a
    // per-object precision operation (aligning THIS object's resulting
    // position onto some nearby existing point), so it's resolved inside
    // the loop below, once per target, and — when it finds a candidate —
    // wins over the grid-snapped position for that one target only.
    if (gizmoMode === "translate" && snapToGridEnabled) {
      d.positionDelta.copy(snapTranslateDelta(d.positionDelta, gridSnapSize));
    }
    const snapCandidates = gizmoMode === "translate" && snapToPointsEnabled ? collectSnapPoints() : null;
    const snapTolerance = (viewer.getModelExtents()?.diagonal ?? 0) * 0.01;
    for (const t of gizmoTargets) {
      if (gizmoMode === "translate") {
        const result = applyTranslateDelta(t, d);
        const snapped = snapCandidates ? nearestSnapPoint(result.position, snapCandidates, snapTolerance) : null;
        t.object.position.copy(snapped ?? result.position);
      } else if (gizmoMode === "rotate") {
        const r = applyRotateDelta(t, d);
        t.object.position.copy(r.position);
        t.object.quaternion.copy(r.quaternion);
      } else {
        const s = applyScaleDelta(t, d);
        t.object.position.copy(s.position);
        t.object.scale.copy(s.scale);
      }
    }
    viewer.requestRender();
    // Push the live-dragged values into the open form's fields — the answer
    // to "what happens when a drag overwrites a field the user had typed an
    // expression into" (see `EditsPanel.setVecField`'s doc comment): the
    // drag wins, silently, same as the user typing over it by hand. Reflects
    // the GRID-snapped delta when grid snap is active; deliberately does NOT
    // try to reflect entity-point snap in the form (that's inherently a
    // per-target adjustment with no single shared "delta" left to show when
    // multiple targets each snapped to a different nearby point).
    if (gizmoMode === "translate") {
      editsPanel.setVecField("vec", [d.positionDelta.x, d.positionDelta.y, d.positionDelta.z]);
    } else if (gizmoMode === "rotate") {
      const { axis, angleRad } = quaternionToAxisAngle(d.quaternionDelta);
      editsPanel.setVecField("axisPoint", [d.pivot.x, d.pivot.y, d.pivot.z]);
      editsPanel.setVecField("axisDir", [axis.x, axis.y, axis.z]);
      editsPanel.setNumField("angleDeg", (angleRad * 180) / Math.PI);
    } else {
      editsPanel.setVecField("center", [d.pivot.x, d.pivot.y, d.pivot.z]);
      editsPanel.setVecField("factors", [d.scaleDelta.x, d.scaleDelta.y, d.scaleDelta.z]);
    }
  },
  (dragging) => {
    if (dragging) {
      // Drag start: capture a FRESH pristine base from wherever targets
      // currently sit — usually their true pristine position, but starting
      // a SECOND drag after a first one (without clicking Apply in between)
      // deliberately captures from the already-previewed position, letting
      // successive drags compose/refine before committing.
      const objects = selectedVolumes().map(resolveVolumeObject).filter((o): o is THREE.Object3D => o !== null);
      gizmoTargets = objects.map((object) => ({
        object, basePosition: object.position.clone(), baseQuaternion: object.quaternion.clone(), baseScale: object.scale.clone(),
      }));
    }
    // Drag end: deliberately leave the preview showing — Apply is still the
    // only thing that pushes an op. `gizmoTargets` stays non-null so a
    // second drag (see above) or Apply's own read of the form fields both
    // still have something to work from.
  }
);

const editsPanel = new EditsPanel(document.getElementById("edits-panel")!, {
  onUndo: () => editsModel.undo(),
  onRedo: () => editsModel.redo(),
  onClear: () => editsModel.clear(),
  onRemoveOp: (index) => editsModel.remove(index),
  // One splice + one onChange/editsChanged/re-tessellate round trip per
  // click — never a looped undo()/redo() sequence (op-history scrubbing).
  onJumpTo: (index) => editsModel.jumpTo(index),
  // Transient highlight of a history-row bucket chip's faces (roadmap
  // "Selector synthesis" Phase 1) — goes through `renderSelection` directly,
  // never into the SelectionSet, so moving on restores the real selection by
  // re-running `renderHighlight()` (the selection-groups context menu's
  // hover-preview precedent). Bucket ids are all faces in Phase 1.
  onHighlightBucket: (ids) => {
    if (!ids || ids.length === 0) { renderHighlight(); return; }
    viewer.renderSelection(ids.map((entityId) => ({ entityType: "surface" as const, entityId })));
  },
  onApplyTransform: (draft) => {
    const id = draft.kind === "translate" ? "translate" : draft.kind === "rotate" ? "rotate" : draft.kind === "scale" ? "scale" : "mirror";
    const resolved = buildOpForPanel(id, draft);
    if (resolved.error || !resolved.op) { setStatus(resolved.error ?? "Cannot apply this transform.", true); return; }
    cancelGizmoPreview(); // discard the live preview — the real op replay rebuilds everything
    cancelOpPreview();
    editsModel.push(resolved.op);
    setStatus("");
  },
  onCaptureBooleanA: () => {
    booleanA = selectedVolumes();
    if (booleanA.length === 0) setStatus("Select volumes for operand A before Set A.", true);
    // Capturing A changes the boolean form's preview inputs — refresh it.
    scheduleOpPreview();
    return booleanA.length;
  },
  onApplyBoolean: (kind) => {
    const resolved = buildOpForPanel(kind === "union" ? "booleanUnion" : kind === "subtract" ? "booleanSubtract" : "booleanIntersect", {});
    if (resolved.error || !resolved.op) { setStatus(resolved.error ?? "Cannot apply this boolean.", true); return; }
    cancelOpPreview();
    editsModel.push(resolved.op);
    booleanA = [];
    selection.clear();
    renderHighlight();
    setStatus("");
  },
  onApplyFillet: (kind, amount, exprs) => {
    const resolved = buildOpForPanel(kind, { amount, exprs: exprs?.amount ? { amount: exprs.amount } : undefined });
    if (resolved.error || !resolved.op) { setStatus(resolved.error ?? "Cannot apply.", true); return; }
    cancelOpPreview();
    editsModel.push(resolved.op);
    setStatus("");
  },
  onApplyFeature: (draft) => {
    const resolved = buildOpForPanel(draft.kind, draft);
    if (resolved.error || !resolved.op) { setStatus(resolved.error ?? "Cannot apply this feature.", true); return; }
    cancelOpPreview();
    editsModel.push(resolved.op);
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
    viewer.requestRender();
  },
  onExplodePreviewCancel: cancelExplodePreview,
  onApplyMate: () => {
    const resolved = buildOpForPanel("mate", {});
    if (resolved.error || !resolved.op) { setStatus(resolved.error ?? "Cannot mate.", true); return; }
    cancelOpPreview();
    editsModel.push(resolved.op);
    setStatus("");
  },
  onApplyAlign: (draft) => {
    const resolved = buildOpForPanel("align", draft);
    if (resolved.error || !resolved.op) { setStatus(resolved.error ?? "Cannot align.", true); return; }
    cancelOpPreview();
    editsModel.push(resolved.op);
    setStatus("");
  },
  onApplyPattern: (draft) => {
    const resolved = buildOpForPanel(draft.kind, draft);
    if (resolved.error || !resolved.op) { setStatus(resolved.error ?? "Cannot apply this pattern.", true); return; }
    cancelOpPreview();
    editsModel.push(resolved.op);
    setStatus("");
  },
  onApplyModify: (draft) => {
    // Shell takes its opening faces from the Surf selection; split/section take
    // their target volumes from the Vol selection. B-rep only.
    const resolved = buildOpForPanel(draft.kind, draft);
    if (resolved.error || !resolved.op) { setStatus(resolved.error ?? "Cannot apply this modify op.", true); return; }
    cancelOpPreview();
    editsModel.push(resolved.op);
    setStatus("");
  },
  onApplyPrimitive: (draft) => {
    const resolved = buildOpForPanel(draft.kind, draft);
    if (resolved.error || !resolved.op) { setStatus(resolved.error ?? "Cannot add this primitive.", true); return; }
    cancelOpPreview();
    editsModel.push(resolved.op);
    setStatus("");
  },
  onApplyHole: (draft) => {
    const resolved = buildOpForPanel(draft.kind, draft);
    if (resolved.error || !resolved.op) { setStatus(resolved.error ?? "Cannot cut this hole.", true); return; }
    cancelOpPreview();
    editsModel.push(resolved.op);
    setStatus("");
  },
  onApplyProfile: (draft) => {
    // 2D profiles are self-contained placements — no selection/operand needed.
    const resolved = buildOpForPanel(draft.kind, draft);
    if (resolved.error || !resolved.op) { setStatus(resolved.error ?? "Cannot sketch this profile.", true); return; }
    cancelOpPreview();
    editsModel.push(resolved.op);
    setStatus("");
  },
  onApplyWireframe: (draft) => {
    const resolved = buildOpForPanel(draft.kind, draft);
    if (resolved.error || !resolved.op) { setStatus(resolved.error ?? "Cannot add this curve.", true); return; }
    cancelOpPreview();
    editsModel.push(resolved.op);
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
    const guideEdge = edges.find((e) => guideEntityIds.has(e));
    if (guideEdge) { setStatus(`${guideEdge} is guide (construction) geometry — guides are excluded from surface resolution.`, true); return; }
    editsModel.push({ op: "addSurfaceFromLines", edges });
    setStatus("");
  },
  onBuildVolumeFromSurfaces: () => {
    const faces = selection.list().filter((e) => e.entityType === "surface").map((e) => e.entityId);
    if (faces.length < 4) {
      setStatus("Select 4+ surfaces (Surf mode) forming a closed shell.", true);
      return;
    }
    const guideFace = faces.find((f) => guideEntityIds.has(f));
    if (guideFace) { setStatus(`${guideFace} is guide (construction) geometry — guides are excluded from volume resolution.`, true); return; }
    editsModel.push({ op: "addVolumeFromSurfaces", faces });
    setStatus("");
  },
  onBuildEdgeSlot: (width: number) => {
    const edges = selection.list().filter((e) => e.entityType === "line").map((e) => e.entityId);
    if (edges.length !== 1) { setStatus("Select exactly one edge (Line mode) for the slot.", true); return; }
    if (!(width > 0)) { setStatus("Slot width must be positive.", true); return; }
    editsModel.push({ op: "addEdgeSlot", edge: edges[0], width });
    setStatus("");
  },
  onFormChanged: updateGizmoForForm,
  onPreviewDraftChanged: () => scheduleOpPreview(),
  onPreviewCancel: () => cancelOpPreview()
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
  onExport: async (format, unit) => {
    post({ type: "meshingExport", target: format, options: meshingModel.get(), stl: await currentStlIfMeshSource(), unit });
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

// ── Standard parts (step.parts search/insert) ────────────────────────────
// Search requestId is stale-guarded like every other request/response round
// trip here; insert requestId maps to the part id so the settling response
// can re-enable the right row's Insert button (searches/inserts are
// otherwise independent — a fresh search never cancels an in-flight insert).
let standardPartsSearchRequestId: string | null = null;
const standardPartsInsertRequests = new Map<string, string>(); // requestId -> part id

// ── Colour by scalar field (meshio++ sources only) ──────────────────────────
// Region NAMES arrive unconditionally in `meshioMetadata`; the field's actual
// VALUES are fetched on demand (`colorFieldRequest`/`colorFieldResult`) only
// once the user picks one, so an unused field's data never crosses postMessage.
let availableColorFields: { pointDataNames: string[]; cellDataNames: string[] } | null = null;
let colorFieldRequestId: string | null = null;

/** Populates (and shows/hides) the "Colour by field" selector from the
 * source file's declared point/cell data array names — called once per
 * `loadMeshBytes` (never for a native mesh open, which has no meshio
 * metadata at all, so the group stays hidden). */
type ColorFieldArrayInfo = {
  name: string;
  location: "point" | "cell";
  numComponents: number;
  min: number;
  max: number;
  numNan: number;
  consistent: boolean;
};

/**
 * Populates the colour-by-field picker.
 *
 * **A field that cannot be coloured is disabled here, with the reason in its
 * label and tooltip** — rather than being offered and failing after the click.
 * Previously every declared array became an enabled option, and a
 * multi-component one only failed once the host had read the whole file and run
 * a full `readMesh` + `extractSurface`; the user saw the dropdown snap back to
 * "None" after a delay. `arrays` (meshio++ `dataInfo`) carries `numComponents`
 * up front. It is optional: without it the picker behaves exactly as before,
 * so an older host payload still works.
 */
function applyAvailableColorFields(
  fields: { pointDataNames: string[]; cellDataNames: string[]; arrays?: ColorFieldArrayInfo[] } | undefined
): void {
  availableColorFields = fields && fields.pointDataNames.length + fields.cellDataNames.length > 0 ? fields : null;
  const group = document.getElementById("vc-colorfield-group");
  const sel = document.getElementById("vc-colorfield-select") as HTMLSelectElement | null;
  if (!group || !sel) return;
  group.hidden = availableColorFields === null;
  sel.innerHTML = '<option value="">None</option>';
  if (!availableColorFields) return;

  const infoFor = (name: string, location: "point" | "cell"): ColorFieldArrayInfo | undefined =>
    fields?.arrays?.find((a) => a.name === name && a.location === location);

  const addOption = (name: string, location: "point" | "cell"): void => {
    const opt = document.createElement("option");
    opt.value = `${location}:${name}`;
    const info = infoFor(name, location);
    if (info && info.numComponents !== 1) {
      opt.disabled = true;
      opt.textContent = `${name} (${location}) — ${info.numComponents} components`;
      opt.title = `Not colourable: a colour ramp maps one scalar per entity, and this array has ${info.numComponents} components each.`;
    } else {
      opt.textContent = `${name} (${location})`;
      // Range up front, before any values are fetched.
      if (info) opt.title = `Range ${formatMeasure(info.min)} … ${formatMeasure(info.max)}${info.numNan > 0 ? ` · ${info.numNan} NaN` : ""}`;
    }
    sel.appendChild(opt);
  };

  for (const name of availableColorFields.pointDataNames) addOption(name, "point");
  for (const name of availableColorFields.cellDataNames) addOption(name, "cell");
}

/** Resets the selector to "None", hides the legend, and clears any active
 * overlay — called whenever the underlying geometry can no longer be
 * trusted to match the field values' triangle correlation (a fresh model
 * load, or any edit applied — see `readMeshioFieldValues`'s doc comment:
 * values are correlated against the PRISTINE import, which a topology-
 * changing mesh edit invalidates the same way it does `importedRegionInfo`). */
function resetColorFieldSelection(): void {
  colorFieldRequestId = null;
  const sel = document.getElementById("vc-colorfield-select") as HTMLSelectElement | null;
  if (sel) sel.value = "";
  const legend = document.getElementById("vc-colorfield-legend");
  if (legend) legend.hidden = true;
  viewer.setColorFieldOverlay(null);
}

function setupColorFieldControls(): void {
  const sel = document.getElementById("vc-colorfield-select") as HTMLSelectElement | null;
  sel?.addEventListener("change", () => {
    const value = sel.value;
    if (!value) {
      resetColorFieldSelection();
      return;
    }
    // Fixed-length prefix, not "split on first colon" — a field name from
    // the source file could itself contain a colon (meshio's own convention
    // for e.g. "surface:parent_cell"-style provenance keys).
    const kind: "point" | "cell" = value.startsWith("point:") ? "point" : "cell";
    const field = value.slice(kind.length + 1);
    const requestId = `${Date.now()}-${Math.random()}`;
    colorFieldRequestId = requestId;
    post({ type: "colorFieldRequest", requestId, field, kind });
  });
}

// ── Display unit (session-only presentation layer, never persisted) ────────
// Everything computed host/client-side is already in one internal unit
// (millimetres — OCCT's STEP reader auto-converts every shape to its cascade
// unit at read time, verified against the live WASM; see
// `src/stepUnits.ts`'s doc comment). This only rescales what Mass Properties/
// Measurement *display*; nothing stored is ever rescaled.
let currentDisplayUnit: DisplayUnit = "mm";
let lastRawMassProperties:
  | (LengthBasedProperties & { momentsOfInertia: MassPropertiesDisplay["momentsOfInertia"]; watertight?: boolean | null })
  | null = null;

/** Sets the display unit, syncs the `<select>`, and live-rescales the
 * currently-shown Mass Properties result (if any) — measurements already on
 * screen are not retroactively rescaled, matching every other Stage-2
 * appearance control's "affects what's rendered from now on" precedent. */
function setDisplayUnit(unit: DisplayUnit): void {
  currentDisplayUnit = unit;
  const sel = document.getElementById("vc-unit") as HTMLSelectElement | null;
  if (sel) sel.value = unit;
  if (lastRawMassProperties)
    massPropertiesPanel.render(
      convertLengthBasedProperties(lastRawMassProperties, unit) as MassPropertiesDisplay,
      unit
    );
}

/** Caches the raw (mm) result and renders it converted to `currentDisplayUnit`. */
function renderMassProperties(
  raw: LengthBasedProperties & { momentsOfInertia: MassPropertiesDisplay["momentsOfInertia"]; watertight?: boolean | null }
): void {
  lastRawMassProperties = raw;
  massPropertiesPanel.render(
    convertLengthBasedProperties(raw, currentDisplayUnit) as MassPropertiesDisplay,
    currentDisplayUnit
  );
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

// ── Mesh Health (roadmap "Mesh -> B-rep promotion", both phases closed) ────
// Eligible only for a NATIVE stl/obj/ply/gltf file on disk — the same
// COMPARABLE_MESH_FORMATS gate check_mesh_health/promote_mesh_to_brep's MCP
// tools apply. A meshio-converted document (`loadMeshBytes`, already-
// triangulated but not itself one of those FILES) stays ineligible.
let meshHealthEligibleFormat: MeshParseFormat | null = null;
let meshHealRequestId: string | null = null;

const macrosPanel = new MacrosPanel(document.getElementById("macros-panel")!, {
  onRun: (name, parameters) => post({ type: "macroRun", name, parameters }),
  onSaveCurrent: () => post({ type: "macroSaveCurrent" }),
  onDelete: (name) => post({ type: "macroDelete", name }),
});

const meshHealthPanel = new MeshHealthPanel(document.getElementById("mesh-health-panel")!, {
  onCheck: () => {
    if (!meshHealthEligibleFormat) return;
    const requestId = `${Date.now()}-${Math.random()}`;
    meshHealRequestId = requestId;
    meshHealthPanel.renderMessage("Checking…");
    post({ type: "meshHealRequest", requestId });
  },
  onPromote: () => {
    if (!meshHealthEligibleFormat) return;
    post({ type: "promoteToBrepButtonClicked" });
  },
  onRepair: () => {
    if (!meshHealthEligibleFormat) return;
    post({ type: "repairMeshButtonClicked" });
  },
});

function setMeshHealthEligibility(format: MeshParseFormat | null): void {
  meshHealthEligibleFormat = format;
  meshHealthPanel.setEligible(format !== null);
  regionFitPanel.setEligible(format !== null);
}

let regionFitRequestId: string | null = null;
let lastRegionFit: import("../fitMapping").MeshRegionFit | null = null;

const regionFitPanel = new RegionFitPanel(document.getElementById("region-fit-panel")!, {
  onPickSeed: () => {
    if (!meshHealthEligibleFormat) return;
    regionFitPanel.setPickArmed(true);
    setStatus("Click a surface to pick the fit seed…");
    viewer.setFitSeedPickHandler((point) => {
      viewer.setFitSeedPickHandler(null);
      regionFitPanel.setPickArmed(false);
      const requestId = `${Date.now()}-${Math.random()}`;
      regionFitRequestId = requestId;
      lastRegionFit = null;
      regionFitPanel.renderMessage("Fitting…");
      post({ type: "fitRegionRequest", requestId, point: [point.x, point.y, point.z] });
    });
  },
  onSavePlane: () => {
    if (!lastRegionFit) return;
    const plane = fitConstructionPlane(lastRegionFit);
    if (!plane) {
      setStatus("No plane fit to save.", true);
      return;
    }
    const w = fitStoreWarning(lastRegionFit, "plane");
    if (w) setStatus(w);
    planesModel.add(plane);
  },
  onAddCylinder: () => {
    if (!lastRegionFit) return;
    const op = fitOpForKind(lastRegionFit, "cylinder");
    if (!op) {
      setStatus("No cylinder fit to add.", true);
      return;
    }
    const validated = validateEditOp(op);
    if (!validated) {
      setStatus("Fitted cylinder produced an invalid op.", true);
      return;
    }
    const w = fitStoreWarning(lastRegionFit, "cylinder");
    if (w) setStatus(w);
    editsModel.push(validated);
  },
  onAddSphere: () => {
    if (!lastRegionFit) return;
    const op = fitOpForKind(lastRegionFit, "sphere");
    if (!op) {
      setStatus("No sphere fit to add.", true);
      return;
    }
    const validated = validateEditOp(op);
    if (!validated) {
      setStatus("Fitted sphere produced an invalid op.", true);
      return;
    }
    const w = fitStoreWarning(lastRegionFit, "sphere");
    if (w) setStatus(w);
    editsModel.push(validated);
  },
});

const standardPartsPanel = new StandardPartsPanel(document.getElementById("standard-parts-panel")!, {
  onSearch: (q: string) => {
    const requestId = `${Date.now()}-${Math.random()}`;
    standardPartsSearchRequestId = requestId;
    post({ type: "standardPartsSearchRequest", requestId, q });
  },
  onInsert: (part: StandardPart) => {
    const requestId = `${Date.now()}-${Math.random()}`;
    standardPartsInsertRequests.set(requestId, part.id);
    const ext = part.stepUrl.toLowerCase().endsWith(".stp") ? "stp" : "step";
    post({ type: "standardPartsInsertRequest", requestId, id: part.id, suggestedName: `${part.id}.${ext}` });
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
  const { volume, area, volumeCentroid, areaCentroid, watertight } = computeMeshMassProperties(meshes);
  renderMassProperties({
    volume: isClosedTarget ? volume : null,
    area,
    length: null,
    centerOfMass: isClosedTarget ? volumeCentroid : areaCentroid,
    momentsOfInertia: null,
    watertight: isClosedTarget ? watertight : null,
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

/**
 * Keeps the 3D scene in step with VS Code's active theme.
 *
 * VS Code signals a theme change by rewriting `<body>`'s class
 * (`vscode-light`/`vscode-dark`/`vscode-high-contrast*`) and the `--vscode-*`
 * custom properties — there is no message for it, so a `MutationObserver` is
 * the detection, and no host round trip is involved at all.
 *
 * `applyTheme()` re-reads the palette and handles the surfaces with no other
 * re-apply path (background, lights, grid, overlays, ghost lines, clip cap);
 * `refreshColors()` then re-themes faces/edges/points/selection through the
 * existing colour path — which is what leaves per-Part swatches untouched.
 * This is the same "a material-affecting change must be followed by
 * refreshColors()" contract `setDisplayMode()` already documents.
 */
function setupThemeReactivity(): void {
  const observer = new MutationObserver(() => {
    viewer.applyTheme();
    refreshColors();
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["class", "data-vscode-theme-kind"],
  });
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
  refreshGizmoAttachment(); // no-op unless a translate/rotate/scale form is open
  clippingControls?.reflectSelection(); // Clip ▸ Face / 3 Pts gate on the selection
  // A selection change re-aims every selection-dependent op (boolean B,
  // fillet edges, feature profiles, mate faces, build-surface loops) — cancel
  // the stale preview and reschedule from the still-open form. Roadmap trap
  // #2: without this, switching selection strands an orphaned preview built
  // from operands that no longer exist. The gizmo forms never schedule a
  // preview at all (the Transform Gizmo IS their live preview), so this is a
  // cheap no-op while one of those is open.
  if (opPreviewEligible()) {
    opPreviewScheduler.cancel();
    viewer.setOpPreview(null);
    scheduleOpPreview();
  }
}

// ── Live operation preview (roadmap item, closed) ─────────────────────────
// One debounced speculative replay of [...currentOps, draftOp] rendered as a
// translucent intent-tinted stand-in for the model. The webview owns ALL of
// it: nothing here ever touches EditsModel or posts anything but the
// read-only opPreviewRequest — a preview must never enter the op stack
// (roadmap trap #1: it would become undoable/persistable/wrong).

const OP_PREVIEW_DEBOUNCE_MS = 250;
let opPreviewRequestId = 0;
const opPreviewScheduler = new OpPreviewScheduler<{ id: PanelOpId; draft: Record<string, unknown> }>(runOpPreview, OP_PREVIEW_DEBOUNCE_MS);

/** The panel forms whose live preview this engine renders. Deliberately NOT
 * previewed: `"explode"` (its own slider preview owns that op) and
 * `"translate"`/`"rotate"`/`"scale"` (the Transform Gizmo already previews
 * them by dragging — stacking a second preview under the gizmo's hidden-model
 * window would fight it). Everything else previews uniformly. */
function opPreviewEligible(): boolean {
  const open = editsPanel.openOpId();
  return open !== null && open !== "explode" && open !== "translate" && open !== "rotate" && open !== "scale";
}

/** Intent colour for a previewed op kind — green adds material, red removes
 * it, blue marks wire/reference-only results; transforms/fillet/chamfer stay
 * neutral (per-band fillet colouring explicitly deferred per the roadmap). */
/** The thin-wall fields of a sweep-family draft, or nothing when it isn't thin. */
function thinOf(d: Record<string, unknown>): { thin?: number; thinOuter?: number } {
  const thin = d.thin;
  if (typeof thin !== "number" || !(thin > 0)) return {};
  const outer = d.thinOuter;
  return typeof outer === "number" && outer > 0 ? { thin, thinOuter: outer } : { thin };
}

function tintForPanelOp(id: PanelOpId): "add" | "cut" | "ref" | undefined {
  switch (id) {
    case "booleanUnion":
    case "addBox":
    case "addSphere":
    case "addCylinder":
    case "addCone":
    case "addTorus":
    case "addPrism":
    case "addWedge":
    case "extrude":
    case "revolve":
    case "sweep":
    case "loft":
    case "patternLinear":
    case "patternCircular":
      return "add";
    case "booleanSubtract":
    case "booleanIntersect":
    case "addHole":
    case "addCounterboreHole":
    case "addCountersinkHole":
    case "shell":
    case "splitByPlane":
      return "cut";
    case "addCircleProfile":
    case "addRectangleProfile":
    case "addPolygonProfile":
    case "addEllipseProfile":
    case "addRoundedRectangleProfile":
    case "addSlotProfile":
    case "addTrapezoidProfile":
    case "addPoint":
    case "addLine":
    case "addArc":
    case "addPolyline":
    case "addThreePointArc":
    case "addSpline":
    case "addBezier":
    case "addEllipseArc":
    case "addHelix":
    case "section":
    case "buildSurface":
    case "buildVolume":
    case "edgeSlot":
      return "ref";
    default:
      return undefined; // mirror, draft, align, fillet, chamfer — neutral
  }
}

/**
 * THE single draft→EditOp mapping, shared verbatim by every Apply button AND
 * by the live preview — the structural guarantee that a preview can never
 * disagree with what Apply would commit (same guards, same field reads, same
 * construction). Each Apply callback below is a thin shell around this:
 * resolve → surface the error → push. Returns `{error}` (never throws) when
 * an operand selection is missing/invalid or a client-side guard fails;
 * `validateEditOp` remains the authoritative gate downstream either way.
 */
function buildOpForPanel(id: PanelOpId, rawDraft: Record<string, unknown>): { op?: EditOp; error?: string } {
  const res = buildOpForPanelCore(id, rawDraft);
  // Construction-geometry flag: the panel's generic `guide` checkbox rides
  // every guide-kind draft (see `editsPanel.applyButtonDraft`) — copied onto
  // the resolved op here so BOTH the Apply push and the live preview carry
  // it, exactly like `exprs` above.
  if (res.op && (rawDraft as Record<string, any>).guide === true && GUIDE_KINDS.has(res.op.op)) {
    (res.op as unknown as Record<string, unknown>).guide = true;
  }
  return res;
}

function buildOpForPanelCore(id: PanelOpId, rawDraft: Record<string, unknown>): { op?: EditOp; error?: string } {
  const d = rawDraft as Record<string, any> & { exprs?: Record<string, string> };
  const withExprs = (op: EditOp): EditOp => {
    if (d.exprs && Object.keys(d.exprs).length > 0) op.exprs = d.exprs;
    return op;
  };
  const selVolumes = selectedVolumes();
  const selFaces = selection.list().filter((e) => e.entityType === "surface").map((e) => e.entityId);
  const selEdges = selection.list().filter((e) => e.entityType === "line").map((e) => e.entityId);

  switch (id) {
    // ── transforms ──
    case "translate": {
      if (selVolumes.length === 0) return { error: "Select one or more volumes (Vol mode) before applying a transform." };
      return { op: withExprs({ op: "translate", targets: selVolumes, vec: d.vec }) };
    }
    case "rotate": {
      if (selVolumes.length === 0) return { error: "Select one or more volumes (Vol mode) before applying a transform." };
      return { op: withExprs({ op: "rotate", targets: selVolumes, axisPoint: d.axisPoint, axisDir: d.axisDir, angleDeg: d.angleDeg }) };
    }
    case "scale": {
      if (selVolumes.length === 0) return { error: "Select one or more volumes (Vol mode) before applying a transform." };
      return { op: withExprs({ op: "scale", targets: selVolumes, center: d.center, factors: d.factors }) };
    }
    case "mirror": {
      if (selVolumes.length === 0) return { error: "Select one or more volumes (Vol mode) before applying a transform." };
      const op: any = { op: "mirror", targets: selVolumes, planePoint: d.planePoint, planeNormal: d.planeNormal };
      if (d.planeId) op.planeId = d.planeId;
      return { op: withExprs(op) };
    }

    // ── booleans (A captured via Set A, B = live Vol selection) ──
    case "booleanUnion":
    case "booleanSubtract":
    case "booleanIntersect": {
      const kind = id === "booleanUnion" ? "union" : id === "booleanSubtract" ? "subtract" : "intersect";
      if (booleanA.length === 0) return { error: "Set operand A first (select volumes → Set A)." };
      if (selVolumes.length === 0) return { error: "Select operand B volumes before applying." };
      if (selVolumes.some((v) => booleanA.includes(v))) return { error: "Operands A and B must be different volumes." };
      return { op: { op: "boolean", kind, a: booleanA, b: selVolumes } };
    }

    // ── refine ──
    case "fillet":
    case "chamfer": {
      if (selEdges.length === 0) return { error: `Select one or more edges (Line mode) before applying a ${id}.` };
      if (d.amount <= 0) return { error: "Enter a positive radius / setback." };
      const op: EditOp = id === "fillet"
        ? { op: "fillet", edges: selEdges, radius: d.amount }
        : { op: "chamfer", edges: selEdges, distance: d.amount };
      if (d.exprs?.amount) op.exprs = { [id === "fillet" ? "radius" : "distance"]: d.exprs.amount };
      return { op };
    }

    // ── feature modeling ──
    case "extrude":
      if (!selFaces[0]) return { error: "Select a profile face (Surf mode) to extrude." };
      if (guideEntityIds.has(selFaces[0])) return { error: `${selFaces[0]} is guide (construction) geometry — guides are excluded from feature profiles.` };
      return { op: withExprs({ op: "extrude", profile: selFaces[0], dir: d.dir, length: d.length, ...thinOf(d) }) };
    case "revolve":
      if (!selFaces[0]) return { error: "Select a profile face (Surf mode) to revolve." };
      if (guideEntityIds.has(selFaces[0])) return { error: `${selFaces[0]} is guide (construction) geometry — guides are excluded from feature profiles.` };
      return { op: withExprs({ op: "revolve", profile: selFaces[0], axisPoint: d.axisPoint, axisDir: d.axisDir, angleDeg: d.angleDeg, ...thinOf(d) }) };
    case "sweep":
      if (!selFaces[0] || !selEdges[0]) return { error: "Select a profile face and a path edge for sweep." };
      if (guideEntityIds.has(selFaces[0])) return { error: `${selFaces[0]} is guide (construction) geometry — guides are excluded from feature profiles.` };
      return { op: withExprs({ op: "sweep", profile: selFaces[0], path: selEdges[0], ...thinOf(d) }) };
    case "loft":
      if (selFaces.length < 2) return { error: "Select 2+ profile faces (Surf mode) to loft." };
      if (selFaces.some((f) => guideEntityIds.has(f))) return { error: "Guide (construction) faces are excluded from loft profiles." };
      return { op: withExprs({ op: "loft", profiles: selFaces, ...thinOf(d) }) };

    // ── assembly ──
    case "mate":
      if (selFaces.length < 2) return { error: "Select two faces (Surf mode): face A first, then face B, to mate." };
      return { op: { op: "mate", faceA: selFaces[0], faceB: selFaces[1] } };
    case "align":
      if (selVolumes.length === 0) return { error: "Select one or more volumes (Vol mode) before aligning." };
      return { op: withExprs({ op: "align", targets: selVolumes, axis: d.axis, extent: d.extent, to: d.to }) };
    case "patternLinear":
    case "patternCircular": {
      if (selVolumes.length === 0) return { error: "Select one or more volumes (Vol mode) before patterning." };
      if (!Number.isInteger(d.count) || d.count < 2) return { error: "Count must be an integer ≥ 2." };
      if (id === "patternLinear") {
        if (!d.direction.some((v: number) => v !== 0)) return { error: "Direction must be non-zero." };
        if (d.spacing === 0) return { error: "Spacing must be non-zero." };
        return { op: withExprs({ op: "patternLinear", targets: selVolumes, direction: d.direction, spacing: d.spacing, count: d.count }) };
      }
      if (!d.axisDir.some((v: number) => v !== 0)) return { error: "Axis must be non-zero." };
      return { op: withExprs({ op: "patternCircular", targets: selVolumes, axisPoint: d.axisPoint, axisDir: d.axisDir, angleDeg: d.angleDeg, count: d.count }) };
    }

    // ── modify ──
    case "shell": {
      if (selFaces.length === 0) return { error: "Select the opening face(s) (Surf mode) before shelling." };
      if (d.thickness === 0) return { error: "Thickness must be non-zero." };
      return { op: withExprs({ op: "shell", thickness: d.thickness, openingFaces: selFaces }) };
    }
    case "draft": {
      if (selFaces.length === 0) return { error: "Select the face(s) to draft (Surf mode)." };
      if (!d.angleDeg || d.angleDeg <= 0 || d.angleDeg >= 90) return { error: "Draft angle must be between 0° and 90°." };
      const draft: any = { op: "draft", faces: selFaces, angleDeg: d.angleDeg };
      if (d.planeId) { draft.planeId = d.planeId; draft.planePoint = d.planePoint as Vec3; draft.planeNormal = d.planeNormal as Vec3; }
      else if (d.planePoint && d.planeNormal) { draft.planePoint = d.planePoint as Vec3; draft.planeNormal = d.planeNormal as Vec3; }
      return { op: withExprs(draft) };
    }
    case "splitByPlane": {
      if (selVolumes.length === 0) return { error: "Select one or more volumes (Vol mode) to split." };
      if (!d.planeId && !d.planeNormal.some((v: number) => v !== 0)) return { error: "Plane normal must be non-zero." };
      const op: any = { op: "splitByPlane", targets: selVolumes, planePoint: d.planePoint, planeNormal: d.planeNormal, keep: d.keep };
      if (d.planeId) op.planeId = d.planeId;
      return { op: withExprs(op) };
    }
    case "section": {
      if (selVolumes.length === 0) return { error: "Select one or more volumes (Vol mode) to section." };
      if (!d.planeId && !d.planeNormal.some((v: number) => v !== 0)) return { error: "Plane normal must be non-zero." };
      const op: any = { op: "section", targets: selVolumes, planePoint: d.planePoint, planeNormal: d.planeNormal };
      if (d.planeId) op.planeId = d.planeId;
      return { op: withExprs(op) };
    }

    // ── holes ──
    case "addHole":
    case "addCounterboreHole":
    case "addCountersinkHole": {
      if (selVolumes.length === 0) return { error: "Select one or more volumes (Vol mode) to cut the hole into." };
      if (d.radius <= 0 || d.depth <= 0) return { error: "Radius and depth must be positive." };
      if (id === "addCounterboreHole") {
        if (d.cbRadius <= d.radius) return { error: "Counterbore radius must exceed the hole radius." };
        if (d.cbDepth <= 0 || d.cbDepth >= d.depth) return { error: "Counterbore depth must satisfy 0 < depth < hole depth." };
        return { op: withExprs({ op: id, targets: selVolumes, position: d.position, axis: d.axis, radius: d.radius, depth: d.depth, cbRadius: d.cbRadius, cbDepth: d.cbDepth }) };
      }
      if (id === "addCountersinkHole") {
        if (d.csRadius <= d.radius) return { error: "Countersink radius must exceed the hole radius." };
        if (d.csAngleDeg <= 0 || d.csAngleDeg >= 180) return { error: "Countersink angle must be between 0° and 180°." };
        return { op: withExprs({ op: id, targets: selVolumes, position: d.position, axis: d.axis, radius: d.radius, depth: d.depth, csRadius: d.csRadius, csAngleDeg: d.csAngleDeg }) };
      }
      return { op: withExprs({ op: id, targets: selVolumes, position: d.position, axis: d.axis, radius: d.radius, depth: d.depth }) };
    }

    // ── 2D profiles ──
    case "addCircleProfile":
      if (d.radius <= 0) return { error: "Circle radius must be positive." };
      return { op: withExprs({ op: id, center: d.center, normal: d.normal, radius: d.radius }) };
    case "addRectangleProfile":
      if (d.width <= 0 || d.height <= 0) return { error: "Width and height must be positive." };
      if (!nonParallel(d.normal, d.up)) return { error: "Up must not be parallel to Normal." };
      return { op: withExprs({ op: id, center: d.center, normal: d.normal, up: d.up, width: d.width, height: d.height }) };
    case "addPolygonProfile":
      if (d.radius <= 0) return { error: "Radius must be positive." };
      if (!Number.isInteger(d.sides) || d.sides < 3) return { error: "Sides must be an integer ≥ 3." };
      if (!nonParallel(d.normal, d.up)) return { error: "Up must not be parallel to Normal." };
      return { op: withExprs({ op: id, center: d.center, normal: d.normal, up: d.up, radius: d.radius, sides: d.sides }) };
    case "addEllipseProfile":
      if (d.radiusX <= 0 || d.radiusY <= 0) return { error: "Both radii must be positive." };
      if (!nonParallel(d.normal, d.up)) return { error: "Up must not be parallel to Normal." };
      return { op: withExprs({ op: id, center: d.center, normal: d.normal, up: d.up, radiusX: d.radiusX, radiusY: d.radiusY }) };
    case "addRoundedRectangleProfile":
      if (d.width <= 0 || d.height <= 0) return { error: "Width and height must be positive." };
      if (d.cornerRadius <= 0 || 2 * d.cornerRadius >= Math.min(d.width, d.height)) return { error: "Corner radius must satisfy 0 < 2·r < min(width, height)." };
      if (!nonParallel(d.normal, d.up)) return { error: "Up must not be parallel to Normal." };
      return { op: withExprs({ op: id, center: d.center, normal: d.normal, up: d.up, width: d.width, height: d.height, cornerRadius: d.cornerRadius }) };
    case "addSlotProfile":
      if (d.width <= 0 || d.length <= d.width) return { error: "Slot needs length > width > 0." };
      if (!nonParallel(d.normal, d.up)) return { error: "Up must not be parallel to Normal." };
      return { op: withExprs({ op: id, center: d.center, normal: d.normal, up: d.up, length: d.length, width: d.width }) };
    case "addTrapezoidProfile":
      if (d.bottomWidth <= 0 || d.topWidth <= 0 || d.height <= 0) return { error: "Trapezoid widths and height must be positive." };
      if (!nonParallel(d.normal, d.up)) return { error: "Up must not be parallel to Normal." };
      return { op: withExprs({ op: id, center: d.center, normal: d.normal, up: d.up, bottomWidth: d.bottomWidth, topWidth: d.topWidth, height: d.height }) };

    // ── wireframe curves/points ──
    case "addPoint":
      return { op: withExprs({ op: id, position: d.position }) };
    case "addLine":
      if (d.start.every((v: number, i: number) => v === d.end[i])) return { error: "Start and end must differ." };
      return { op: withExprs({ op: id, start: d.start, end: d.end }) };
    case "addArc":
      if (d.radius <= 0) return { error: "Arc radius must be positive." };
      if (d.startAngleDeg === d.endAngleDeg) return { error: "Start and end angle must differ." };
      return { op: withExprs({ op: id, center: d.center, normal: d.normal, radius: d.radius, startAngleDeg: d.startAngleDeg, endAngleDeg: d.endAngleDeg }) };
    case "addPolyline": {
      const min = d.closed ? 3 : 2;
      if (d.points.length < min) return { error: `A ${d.closed ? "closed " : ""}polyline needs ${min}+ points.` };
      if (hasRepeatedConsecutive(d.points)) return { error: "Consecutive points must differ." };
      return { op: withExprs({ op: id, points: d.points, closed: d.closed }) };
    }
    case "addThreePointArc": {
      const same = (a: number[], b: number[]) => a.every((v, i) => v === b[i]);
      if (same(d.p1, d.p2) || same(d.p2, d.p3) || same(d.p1, d.p3)) return { error: "The three points must be distinct." };
      return { op: withExprs({ op: id, p1: d.p1, p2: d.p2, p3: d.p3 }) };
    }
    case "addSpline":
      if (d.points.length < 2) return { error: "A spline needs 2+ points." };
      if (hasRepeatedConsecutive(d.points)) return { error: "Consecutive points must differ." };
      return { op: withExprs({ op: id, points: d.points }) };
    case "addBezier":
      if (d.controlPoints.length < 2) return { error: "A Bézier needs 2+ control points." };
      return { op: withExprs({ op: id, controlPoints: d.controlPoints }) };
    case "addEllipseArc":
      if (d.radiusX <= 0 || d.radiusY <= 0) return { error: "Both radii must be positive." };
      if (!nonParallel(d.normal, d.up)) return { error: "Up must not be parallel to Normal." };
      if (d.startAngleDeg === d.endAngleDeg) return { error: "Start and end angle must differ." };
      return { op: withExprs({ op: id, center: d.center, normal: d.normal, up: d.up, radiusX: d.radiusX, radiusY: d.radiusY, startAngleDeg: d.startAngleDeg, endAngleDeg: d.endAngleDeg }) };
    case "addHelix":
      if (d.radius <= 0 || d.pitch <= 0 || d.turns <= 0) return { error: "Helix radius, pitch, and turns must all be positive." };
      return { op: withExprs({ op: id, center: d.center, axis: d.axis, radius: d.radius, pitch: d.pitch, turns: d.turns }) };

    // ── primitives (guards transcribed from onApplyPrimitive's cases) ──
    case "addBox": {
      if (d.size.some((v: number) => v <= 0)) return { error: "Box sizes must all be positive." };
      return { op: withExprs({ op: id, center: d.center, size: d.size }) };
    }
    case "addSphere":
      if (d.radius <= 0) return { error: "Sphere radius must be positive." };
      return { op: withExprs({ op: id, center: d.center, radius: d.radius }) };
    case "addCylinder":
      if (d.radius <= 0 || d.height <= 0) return { error: "Cylinder radius and height must be positive." };
      return { op: withExprs({ op: id, center: d.center, axis: d.axis, radius: d.radius, height: d.height }) };
    case "addCone":
      if (!(d.radius1 > 0 || d.radius2 > 0)) return { error: "At least one cone radius must be positive." };
      if (d.height <= 0) return { error: "Height must be positive." };
      return { op: withExprs({ op: id, center: d.center, axis: d.axis, radius1: d.radius1, radius2: d.radius2, height: d.height }) };
    case "addTorus":
      if (d.majorRadius <= 0 || d.minorRadius <= 0 || d.minorRadius >= d.majorRadius) return { error: "Torus needs 0 < minor radius < major radius." };
      return { op: withExprs({ op: id, center: d.center, axis: d.axis, majorRadius: d.majorRadius, minorRadius: d.minorRadius }) };
    case "addPrism":
      if (d.radius <= 0 || d.height <= 0) return { error: "Radius and height must be positive." };
      if (!Number.isInteger(d.sides) || d.sides < 3) return { error: "Sides must be an integer ≥ 3." };
      return { op: withExprs({ op: id, center: d.center, axis: d.axis, radius: d.radius, sides: d.sides, height: d.height }) };
    case "addWedge":
      if (d.dx <= 0 || d.dy <= 0 || d.dz <= 0) return { error: "Wedge sizes must be positive." };
      if (d.ltx < 0) return { error: "Top X extent must be ≥ 0." };
      if (!nonParallel(d.axis, d.up)) return { error: "Up must not be parallel to Axis." };
      return { op: withExprs({ op: id, center: d.center, axis: d.axis, up: d.up, dx: d.dx, dy: d.dy, dz: d.dz, ltx: d.ltx }) };

    // ── build from selection ──
    case "buildSurface":
      if (selEdges.length < 3) return { error: "Select 3+ lines (Line mode) forming a closed loop." };
      if (selEdges.some((e) => guideEntityIds.has(e))) return { error: "Guide (construction) edges are excluded from surface resolution." };
      return { op: { op: "addSurfaceFromLines", edges: selEdges } };
    case "buildVolume":
      if (selFaces.length < 4) return { error: "Select 4+ surfaces (Surf mode) forming a closed shell." };
      if (selFaces.some((f) => guideEntityIds.has(f))) return { error: "Guide (construction) faces are excluded from volume resolution." };
      return { op: { op: "addVolumeFromSurfaces", faces: selFaces } };

    default:
      return { error: "This op has no live preview." };
  }
}

/** Reads the open form's CURRENT draft through the panel (the same readers
 * Apply uses) and schedules a debounced preview run. No-op when no
 * previewable form is open or the draft's expressions currently fail to
 * evaluate (`currentDraft()` returns null — skip silently, never flash the
 * inline Apply-time error mid-typing). */
function scheduleOpPreview(): void {
  if (!opPreviewEligible()) return;
  const current = editsPanel.currentDraft();
  if (!current) {
    viewer.setOpPreview(null);
    return;
  }
  opPreviewScheduler.schedule(current);
}

/** Cancels any pending/in-flight preview and clears the overlay. */
function cancelOpPreview(): void {
  opPreviewScheduler.cancel();
  viewer.setOpPreview(null);
}

/** The scheduler's runner: resolve → validate → replay speculatively. Mesh
 * sources stay entirely client-side (applyEditsMesh over a fresh pristine
 * clone — the host round trip would need an STL snapshot for zero benefit);
 * B-rep sources post `opPreviewRequest` and render from `opPreviewResult`. */
async function runOpPreview(entry: { id: PanelOpId; draft: Record<string, unknown> }, generation: number): Promise<void> {
  const resolved = buildOpForPanel(entry.id, entry.draft);
  if (resolved.error || !resolved.op) {
    viewer.setOpPreview(null);
    setStatus(resolved.error ?? "Cannot preview this op.", true);
    return;
  }
  const clean = validateEditOp(resolved.op);
  if (!clean) {
    viewer.setOpPreview(null);
    setStatus("The drafted operation is invalid and cannot be previewed.", true);
    return;
  }
  const tint = tintForPanelOp(entry.id);
  if (sourceKind === "mesh") {
    if (!pristineMesh) return;
    const clone = pristineMesh.clone(true);
    applyEditsMesh(clone, [...currentResolvedOps().ops, clean]);
    viewer.setOpPreview(clone, tint);
    return;
  }
  const requestId = `oppreview-${++opPreviewRequestId}`;
  pendingOpPreviewGeneration.set(requestId, generation);
  post({ type: "opPreviewRequest", requestId, op: clean });
}

/** Generation guard for in-flight preview requests: a response is rendered
 * only if its request was the latest scheduled run AND no cancel has fired
 * since (form switch / selection change / Apply / model rebuild all bump the
 * scheduler's generation via `cancel()`). */
const pendingOpPreviewGeneration = new Map<string, number>();

function handleOpPreviewResult(msg: Extract<HostToWebview, { type: "opPreviewResult" }>): void {
  const gen = pendingOpPreviewGeneration.get(msg.requestId);
  pendingOpPreviewGeneration.delete(msg.requestId);
  if (gen === undefined || !opPreviewScheduler.isCurrent(gen)) return; // stale — silently discarded
  const draftOutcome = msg.opOutcomes?.[msg.opOutcomes.length - 1];
  if (draftOutcome && !draftOutcome.applied) {
    viewer.setOpPreview(null);
    setStatus(`Preview skipped: ${draftOutcome.diagnostic ?? "the operation produced no change"}${draftOutcome.hint ? ` — ${draftOutcome.hint}` : ""}`, true);
    return;
  }
  viewer.setOpPreview(buildGroupFromEncoded(msg.meshes, msg.edges, msg.points), tintForPanelOp(editsPanel.openOpId() as PanelOpId));
}

// The pristine, tagged-but-unedited loaded object for mesh formats. Mesh edits
// are non-destructive: every edit rebuilds the displayed model from this clone so
// the op-list replays cleanly (B-rep replay happens in the host instead).
let pristineMesh: THREE.Object3D | null = null;

/** The raw triangle-soup position array `readMeshioFieldValues`' per-corner
 * `values` are correlated against — always `pristineMesh` itself for a
 * meshio import (a single, unsplit `THREE.Mesh`, never a `Group`; see
 * `splitMeshesIntoFacets`'s "Root-is-mesh" case), so this is only ever
 * called while a colour-field request is meaningful (see
 * `resetColorFieldSelection`'s gating). `null` when there's nothing to
 * colour (no pristine mesh yet, or it's a multi-object hierarchy — never
 * true for a meshio import, but checked defensively). */
function pristineMeshPositions(): Float32Array | null {
  if (!(pristineMesh instanceof THREE.Mesh)) return null;
  const attr = pristineMesh.geometry.getAttribute("position");
  return attr ? (attr.array as Float32Array) : null;
}

// Per-triangle region correlation for a meshio++-imported document (see
// `protocol.ts`'s `loadMeshBytes.regionAssignment` doc comment) — set by
// `loadMeshObjectFromUrl` on every load, `null` for a native (non-meshio)
// open. Only ever fed into `splitMeshesIntoFacets` while the edit-op list is
// EMPTY (see `rebuildMeshModel` below): it indexes `pristineMesh`'s ORIGINAL
// triangle order, which a topology-changing mesh edit (boolean/hole/
// primitive-add) invalidates — reapplying it to a since-edited geometry
// would silently misassign regions to unrelated triangles. This mirrors
// `provider.ts`'s `handleMeshio`, which only ever auto-creates Parts from
// the pristine, freshly-imported geometry too, so the ids this produces stay
// correct as long as both sides agree on "pristine, no edits yet".
let importedRegionInfo: { triangleRegion: Int32Array } | null = null;

/** Rebuilds the displayed mesh model: clone pristine → apply resolved ops → facet-split. */
function rebuildMeshModel(opts?: { autoFit?: boolean }): void {
  if (!pristineMesh) return;
  const ops = currentResolvedOps().ops;
  const outcomes: OpOutcome[] = [];
  const edited = applyEditsMesh(pristineMesh.clone(), ops, outcomes, setStatus);
  lastOpOutcomes = outcomes; // mesh sources report their own replay outcomes (no host round trip)
  lastOpBuckets = null; // produced-face classification is B-rep only (no host replay for meshes)
  const model = splitMeshesIntoFacets(edited, ops.length === 0 ? importedRegionInfo?.triangleRegion : undefined);
  viewer.setModel(model, opts);
  cancelOpPreview(); // setModel() already cleared the overlay; this also kills any pending/in-flight preview request
  explodePreviewBases = null; // stale references to the just-replaced model's objects
  gizmoTargets = null; // ditto — a fresh drag re-resolves targets from the new model
  viewer.detachTransformGizmo();
  hideInspectorCard(); // its facts describe the pre-edit shape, and ids may have been renumbered
  hideHoverTip();
  resetColorFieldSelection(); // any edit invalidates the field values' triangle correlation, same as importedRegionInfo above
  refreshColors();
  renderAnnotationsList(); // detached status may have changed
  // Edits can change the bounding box; keep the FE Mesh panel's element-count
  // estimate honest. (B-rep sources get the equivalent via the re-posted
  // `geometry` message after each edit.)
  meshingPanel.setModelExtents(viewer.getModelExtents());
  applyInitialViewIfNeeded(); // no-op after the document's first load; see its doc comment
  renderEditsUi(); // re-render with THIS replay's outcome markers (syncEdits rendered before they existed)
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
    requestEntityFacts(result.entityId);
  },
  () => {
    previewPartIndex = null;
    selection.clear();
    renderHighlight();
    hideInspectorCard();
  }
);

// ── Explain the geometry under the cursor ─────────────────────────────────
// Two affordances over one pick path, split by COST, not by preference:
// hovering is pure webview and instant, while the inspector card needs a host
// round trip and `getEntityFacts` has no shape cache (every call re-reads the
// source bytes and replays the whole op list). So hover drives the tooltip and
// SELECTION drives the card — a hover-driven round trip would re-parse the
// model on every mouse move.

const hoverTipEl = document.getElementById("hover-tip");
const inspectorEl = document.getElementById("inspector-card");

/** `entityId -> 1-based op positions mentioning it`. Rebuilt on op-list change,
 * never per hover event: `EditsModel.list()` deep-clones the whole list. */
let entityRefIndex = new Map<string, number[]>();
function rebuildEntityRefIndex(): void {
  entityRefIndex = buildEntityReferenceIndex(editsModel.list());
}

function hideHoverTip(): void {
  hoverTipEl?.classList.add("hidden");
}

function showHoverTip(entityId: string, x: number, y: number): void {
  if (!hoverTipEl) return;
  const { id, ops } = hoverContent(entityId, entityRefIndex.get(entityId));
  hoverTipEl.textContent = "";
  const idEl = document.createElement("span");
  idEl.className = "hover-id";
  idEl.textContent = id;
  const opsEl = document.createElement("span");
  opsEl.className = "hover-ops";
  opsEl.textContent = `\n${ops}`;
  hoverTipEl.append(idEl, opsEl);
  hoverTipEl.classList.remove("hidden");

  // Keep the tip inside #app: near the right/bottom edge, flip it to the other
  // side of the cursor rather than letting it overflow the viewport.
  const host = hoverTipEl.parentElement;
  const hostW = host?.clientWidth ?? 0;
  const hostH = host?.clientHeight ?? 0;
  const w = hoverTipEl.offsetWidth;
  const h = hoverTipEl.offsetHeight;
  const left = x + 14 + w > hostW ? Math.max(0, x - 14 - w) : x + 14;
  const top = y + 14 + h > hostH ? Math.max(0, y - 14 - h) : y + 14;
  hoverTipEl.style.left = `${left}px`;
  hoverTipEl.style.top = `${top}px`;
}

let lastHoverPointer = { x: 0, y: 0 };
document.getElementById("app")?.addEventListener("pointermove", (e) => {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  lastHoverPointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
});

viewer.setEntityHoverHandler((result) => {
  if (!result) {
    hideHoverTip();
    return;
  }
  showHoverTip(result.entityId, lastHoverPointer.x, lastHoverPointer.y);
});

function hideInspectorCard(): void {
  entityFactsRequestId = null; // a newer/cleared selection supersedes any in-flight reply
  inspectorEl?.classList.add("hidden");
}

/** Latched so a slow reply for a superseded selection is discarded — the same
 * requestId stale-response idiom `massPropertiesRequest`/`measureExactRequest`
 * already use. */
let entityFactsRequestId: string | null = null;

function requestEntityFacts(entityId: string): void {
  if (!inspectorEl) return;
  // Mesh sources have no analytic surface type at all; the host would only
  // answer with an error, so don't ask.
  if (sourceKind !== "brep") {
    hideInspectorCard();
    return;
  }
  const requestId = `${Date.now()}-${Math.random()}`;
  entityFactsRequestId = requestId;
  renderInspectorCard(entityId, null);
  post({ type: "entityFactsRequest", requestId, entityId });
}

/** `facts === null` renders the pending state, keeping the card's position
 * stable instead of having it appear only once the round trip lands. */
function renderInspectorCard(entityId: string, facts: EntityFacts | null, error?: string): void {
  if (!inspectorEl) return;
  inspectorEl.textContent = "";

  const title = document.createElement("div");
  title.className = "insp-title";
  const name = document.createElement("span");
  const id = document.createElement("span");
  id.className = "insp-id";
  id.textContent = entityId;
  title.append(name, id);
  inspectorEl.append(title);

  if (error) {
    name.textContent = "Unavailable";
    const note = document.createElement("div");
    note.className = "insp-note";
    note.textContent = error;
    inspectorEl.append(note);
  } else if (!facts) {
    name.textContent = "Inspecting…";
  } else {
    const content = inspectorContent(facts);
    name.textContent = content.title;
    for (const row of content.rows) {
      const line = document.createElement("div");
      line.className = "insp-row";
      const k = document.createElement("span");
      k.className = "insp-key";
      k.textContent = row.key;
      const v = document.createElement("span");
      v.className = "insp-val";
      v.textContent = row.value;
      line.append(k, v);
      inspectorEl.append(line);
    }
  }
  inspectorEl.classList.remove("hidden");
}

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
      syncFilterUi();
    });
  }

  // ── Geometric selection filters (roadmap Tier 2 item 1, Phase 1) ──────────
  // One registry-driven predicate dropdown + numeric field + seam toggle, run
  // against `collectTargets(viewer.getModel(), selectMode)` and bulk-injected
  // into `SelectionSet`. Pure predicates live in `selectFilters.ts`.
  const filterGroup = document.getElementById("filter-group") as HTMLElement | null;
  const filterPred = document.getElementById("filter-pred") as HTMLSelectElement | null;
  const filterArg = document.getElementById("filter-arg") as HTMLInputElement | null;
  const filterExcludeSmooth = document.getElementById("filter-exclude-smooth") as HTMLInputElement | null;
  const filterReplace = document.getElementById("filter-replace") as HTMLButtonElement | null;
  const filterAdd = document.getElementById("filter-add") as HTMLButtonElement | null;

  const filterSupportsMode = (m: EntityType) => m === "surface" || m === "line";

  // Keep the predicate dropdown in sync with the active pick mode — the
  // option list is registry-driven (`FACE_FILTERS`/`LINE_FILTERS`), so this
  // populates the `<select>` whenever the mode changes (including the
  // `setSelectableModes` mesh-source path, via the exposed `__syncFilterUi`).
  let lastFilterMode: EntityType | null = null;
  const syncFilterUi = () => {
    if (filterPred && lastFilterMode !== selectMode) {
      const wantLine = selectMode === "line";
      const wantSurface = selectMode === "surface";
      const opts = wantLine ? LINE_FILTERS : wantSurface ? FACE_FILTERS : [];
      const prevVal = filterPred.value;
      filterPred.innerHTML = "";
      for (const o of opts) {
        const el = document.createElement("option");
        el.value = o.id;
        el.textContent = o.label;
        filterPred.appendChild(el);
      }
      // Preserve previous selection if it still exists in the new mode.
      if (opts.some((o) => o.id === prevVal)) filterPred.value = prevVal;
      lastFilterMode = selectMode;
    }
    const supported = filterSupportsMode(selectMode);
    const opts = selectMode === "line" ? LINE_FILTERS : selectMode === "surface" ? FACE_FILTERS : [];
    const cur = filterPred ? (opts.find((o) => o.id === filterPred.value) ?? opts[0]) : undefined;
    const needsArg = cur ? cur.argKind !== "none" : false;
    if (filterPred) filterPred.disabled = !supported;
    if (filterArg) {
      filterArg.disabled = !supported || !needsArg;
      filterArg.placeholder = needsArg ? (cur?.argKind === "count" ? "N" : "value") : "—";
    }
    if (filterExcludeSmooth) filterExcludeSmooth.disabled = selectMode !== "line";
    if (filterReplace) filterReplace.disabled = !supported;
    if (filterAdd) filterAdd.disabled = !supported;
    if (filterGroup) filterGroup.style.opacity = supported ? "" : "0.45";
  };

  const runFilter = (replace: boolean) => {
    const model = viewer.getModel();
    if (!model) {
      setStatus("No model loaded.", true);
      return;
    }
    if (!filterSupportsMode(selectMode)) {
      setStatus(`Filters are not available in ${selectMode} mode — switch to Surf or Line.`, true);
      return;
    }
    if (!filterPred) return;
    const filterId = filterPred.value;
    const argRaw = filterArg?.value.trim() ?? "";
    const cur =
      (selectMode === "line" ? (LINE_FILTERS as readonly { id: string; argKind: string }[]) : (FACE_FILTERS as readonly { id: string; argKind: string }[])).find(
        (o) => o.id === filterId
      ) ?? null;
    let arg = 0;
    if (cur && cur.argKind !== "none") {
      if (argRaw === "") {
        setStatus(cur.argKind === "count" ? "Enter a count N (e.g. 5)." : "Enter a threshold value.", true);
        return;
      }
      arg = Number(argRaw);
      if (!Number.isFinite(arg)) {
        setStatus(`"${argRaw}" is not a number.`, true);
        return;
      }
      if (cur.argKind === "count" && (!Number.isInteger(arg) || arg <= 0)) {
        setStatus("Count must be a positive integer.", true);
        return;
      }
    }
    const targets = collectTargets(model, selectMode);
    const excludeSmooth = !!filterExcludeSmooth?.checked;
    const result =
      selectMode === "line"
        ? applyLineFilter(targets, filterId as LineFilterId, arg, excludeSmooth)
        : applyFaceFilter(targets, filterId as FaceFilterId, arg);
    if (replace) selection.clear();
    for (const e of result) selection.add(e);
    renderHighlight();
    setStatus(result.length === 0 ? "Filter matched nothing." : `Filter matched ${result.length} of ${targets.length} ${selectMode === "line" ? "edges" : "faces"}.`);
  };

  filterPred?.addEventListener("change", syncFilterUi);
  filterReplace?.addEventListener("click", () => runFilter(true));
  filterAdd?.addEventListener("click", () => runFilter(false));

  // Expose the sync helper so `setSelectableModes` (outside this closure) can
  // keep the filter form's disabled state in sync when mesh sources restrict
  // the available pick modes.
  (globalThis as unknown as { __syncFilterUi?: () => void }).__syncFilterUi = syncFilterUi;
  syncFilterUi();

  // ── Selection-groups context menu ───────────────────────────────────────
  // The same predicates as the filter form above, reached by right-click
  // instead of by composing a query — and the clicked entity supplies the
  // argument the form makes you type. Lives inside this closure because it
  // needs `selectMode`/`selecting` and the same bulk-inject path `runFilter`
  // uses; that is also why `runFilter` was never lifted out.
  const ctxMenu = document.getElementById("context-menu");
  let previewingGroup = false;

  const closeMenu = (): void => {
    ctxMenu?.classList.add("hidden");
    if (previewingGroup) {
      previewingGroup = false;
      renderHighlight(); // drop the hover preview, restore the real selection
    }
  };

  // Registered ONCE, not per open: adding it inside the open handler would
  // accumulate a listener on every right-click.
  ctxMenu?.addEventListener("pointerleave", () => {
    if (previewingGroup) {
      previewingGroup = false;
      renderHighlight();
    }
  });

  const applyGroup = (entities: SelectedEntity[], replace: boolean): void => {
    previewingGroup = false; // this IS the commit; renderHighlight below is authoritative
    if (replace) selection.clear();
    for (const e of entities) selection.add(e);
    renderHighlight();
    setStatus(`Selected ${entities.length} ${selectMode === "line" ? "edges" : "faces"}.`);
  };

  viewer.setContextMenuHandler((result, cssX, cssY) => {
    if (!ctxMenu) return;
    closeMenu();
    const model = viewer.getModel();
    if (!model || !selecting) return;

    const groups = selectionGroupsFor(collectTargets(model, selectMode), selectMode, result.entityId);
    ctxMenu.textContent = "";

    if (groups.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ctx-empty";
      // Volume/point have no predicate vocabulary — the same gate the filter
      // form applies. Say which case it is rather than showing a blank menu.
      empty.textContent =
        selectMode === "surface" || selectMode === "line"
          ? "No groups match beyond this one."
          : "Selection groups apply to Surf and Line modes.";
      ctxMenu.append(empty);
    } else {
      for (const g of groups) {
        const btn = document.createElement("button");
        btn.setAttribute("role", "menuitem");
        btn.textContent = g.label;
        const count = document.createElement("span");
        count.className = "ctx-count";
        count.textContent = `${g.entities.length}`;
        btn.append(count);
        // Hovering previews exactly what clicking would select — drawn through
        // renderSelection directly, never into the SelectionSet, so moving away
        // restores the real selection with no bookkeeping to undo.
        btn.addEventListener("pointerenter", () => {
          previewingGroup = true;
          viewer.renderSelection(g.entities);
        });
        btn.addEventListener("click", (e) => {
          applyGroup(g.entities, !e.shiftKey); // shift-click unions, as elsewhere
          closeMenu();
        });
        ctxMenu.append(btn);
      }
    }

    ctxMenu.classList.remove("hidden");
    // Keep it inside #app: flip to the other side of the cursor near an edge.
    const host = ctxMenu.parentElement;
    const left = cssX + ctxMenu.offsetWidth > (host?.clientWidth ?? 0) ? Math.max(0, cssX - ctxMenu.offsetWidth) : cssX;
    const top = cssY + ctxMenu.offsetHeight > (host?.clientHeight ?? 0) ? Math.max(0, cssY - ctxMenu.offsetHeight) : cssY;
    ctxMenu.style.left = `${left}px`;
    ctxMenu.style.top = `${top}px`;
  });

  // Capture phase, mirroring `dropdownMenu.ts`'s own dismissal discipline: the
  // click that closes the ctxMenu must not also reach the canvas underneath and
  // change the selection.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!ctxMenu || ctxMenu.classList.contains("hidden")) return;
      if (ctxMenu.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    },
    true
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });
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
  // Keep the geometric filter form's disabled state in sync when mesh
  // sources restrict the available pick modes (the filter UI lives inside
  // `setupSelectionControls`'s closure, so bounce through the exposed sync).
  (globalThis as unknown as { __syncFilterUi?: () => void }).__syncFilterUi?.();
}

// ── Measurement toolbar (distance/edge length/angle/radius) ────────────────
// Entirely webview-side, display-only overlay — never an edit op, never
// persisted to any sidecar, never a host round trip.

interface MeasurementResult {
  text: string;
  /** Raw numeric measurement in the readout's own unit (mm for length tools,
   * degrees for angle) — what a tolerance-bearing pin freezes as
   * `tolerance.measured`, so the in/out-of-band colour can be re-derived on
   * redisplay without parsing the formatted `text` back into a number. */
  value: number;
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
    const value = pointDistance(a.point, b.point);
    return { text: formatMeasureLength(value), value, anchor: midpoint(a.point, b.point), linePoints: [a.point, b.point] };
  }
  if (tool === "edgeLength") {
    const [a] = picks;
    if (!a?.polyline) return null;
    const value = polylineLength(a.polyline);
    return { text: `L = ${formatMeasureLength(value)}`, value, anchor: a.point, linePoints: [] };
  }
  if (tool === "angle") {
    const [a, b] = picks;
    if (!a?.direction || !b?.direction) return null;
    const deg = angleBetweenVectors(a.direction, b.direction);
    if (Number.isNaN(deg)) return null;
    return { text: `${formatMeasure(deg)}°`, value: deg, anchor: midpoint(a.point, b.point), linePoints: [a.point, b.point] };
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
    return r === null ? null : { text: `R = ${formatMeasureLength(r)}`, value: r, anchor: a.point, linePoints: [] };
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

/** Maps a `MeasureTool` to its exact-measurement counterpart, or `null` for
 * `"angle"` — `measureExact` (`entityFacts.ts`) has no "angle between two
 * picks" host analogue, only distance/edgeLength/radius. */
function exactMeasureKindFor(tool: MeasureTool): ExactMeasureKind | null {
  return tool === "angle" ? null : tool;
}

/** The most recently completed measurement's tool + resolved picks + result —
 * the source both `#measure-exact-btn` (a `measureExactRequest`, `tool`+
 * `picks` only) and `#measure-pin-btn` (a new {@link Annotation}, needs
 * `result` too) build from. `null` whenever there's no current result to act
 * on (mode just turned on, tool switched, Clear pressed, or the pick set
 * didn't resolve to entity ids). */
let lastMeasurement: { tool: MeasureTool; picks: MeasurementPick[]; result: MeasurementResult } | null = null;
let measureExactRequestId: string | null = null;

/** Shows/hides `#measure-pin-btn` — available whenever there's a completed
 * measurement with at least one resolved entity id, on ANY source kind
 * (unlike `#measure-exact-btn`, which is B-rep only). The tolerance-band
 * fields ride along: they're only meaningful when there's something to pin. */
function refreshPinButton(): void {
  const btn = document.getElementById("measure-pin-btn") as HTMLButtonElement | null;
  if (!btn) return;
  const available = !!lastMeasurement?.picks.some((p) => p.entityId);
  btn.hidden = !available;
  btn.disabled = !available;
  const tolGroup = document.getElementById("measure-tol-group");
  if (tolGroup) tolGroup.hidden = !available;
}

/**
 * Reads one tolerance field as a finite number; `null` when blank or
 * unparseable — the same tolerant-input convention every other numeric
 * webview field uses (bad keystrokes fall back to "not provided", never
 * throw).
 */
function readTolField(id: string): number | null {
  const raw = (document.getElementById(id) as HTMLInputElement | null)?.value?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reads the three inline tolerance fields next to 📌 Pin into an
 * {@link AnnotatedTolerance}. A band needs at least Nominal AND +; − defaults
 * to + (symmetric ±). Returns `{ band: undefined, incomplete: true }` when
 * only Nominal was filled so the caller can say so instead of silently
 * ignoring the user's intent.
 */
function readToleranceFields(): { band?: AnnotatedTolerance; incomplete: boolean } {
  const nominal = readTolField("measure-tol-nominal");
  if (nominal === null) return { incomplete: false };
  const plus = readTolField("measure-tol-plus");
  if (plus === null || plus < 0) {
    return { incomplete: true };
  }
  const minus = readTolField("measure-tol-minus") ?? plus;
  if (minus < 0 || !lastMeasurement) return { incomplete: true };
  return { band: { nominal, plus, minus, measured: lastMeasurement.result.value }, incomplete: false };
}

let annotationIdCounter = 0;

/** Builds a new {@link Annotation} from the most recently completed
 * measurement — anchors are bucketed by entity kind exactly like
 * `PartsModel.assign`, since an `Annotation` reuses the identical
 * `EntityIdBag` shape. */
function annotationFromLastMeasurement(): Annotation | null {
  if (!lastMeasurement) return null;
  const { tool, picks, result } = lastMeasurement;
  const volumes: string[] = [];
  const surfaces: string[] = [];
  const lines: string[] = [];
  const points: string[] = [];
  for (const p of picks) {
    if (!p.entityId || !p.entityType) continue;
    const bucket = p.entityType === "volume" ? volumes : p.entityType === "surface" ? surfaces : p.entityType === "line" ? lines : points;
    if (!bucket.includes(p.entityId)) bucket.push(p.entityId);
  }
  if (volumes.length + surfaces.length + lines.length + points.length === 0) return null;
  annotationIdCounter++;
  return {
    id: `ann-${Date.now()}-${annotationIdCounter}`,
    tool,
    text: result.text,
    anchorPoint: result.anchor,
    linePoints: result.linePoints,
    volumes,
    surfaces,
    lines,
    points,
    tolerance: readToleranceFields().band,
  };
}

/** Shows/hides and enables/disables `#measure-exact-btn` based on whether
 * the current measurement could plausibly be refined: a B-rep source, a
 * tool with an exact counterpart, and picks that actually resolved to real
 * entity ids (a measurement can complete from a raw point-in-space pick with
 * no `entityId` in principle, though every current tool always picks a real
 * entity in practice). */
function refreshExactButton(): void {
  const btn = document.getElementById("measure-exact-btn") as HTMLButtonElement | null;
  if (!btn) return;
  const kind = lastMeasurement ? exactMeasureKindFor(lastMeasurement.tool) : null;
  const entityIdA = lastMeasurement?.picks[0]?.entityId;
  const entityIdB = lastMeasurement?.picks[1]?.entityId;
  const available = sourceKind === "brep" && kind !== null && !!entityIdA && (kind !== "distance" || !!entityIdB);
  btn.hidden = !available;
  btn.disabled = !available;
}

function setupMeasureControls(): void {
  const menu = setupDropdown("measure-menu", "measure-dropdown");
  const toggle = document.getElementById("measure-toggle");
  const toolBtns = [...document.querySelectorAll<HTMLButtonElement>(".measure-tool-btn")];
  const clearBtn = document.getElementById("measure-clear");
  const exactBtn = document.getElementById("measure-exact-btn") as HTMLButtonElement | null;
  const pinBtn = document.getElementById("measure-pin-btn") as HTMLButtonElement | null;
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
    const tool = measurementState.getTool();
    const result = computeMeasurementResult(tool, picks);
    if (!result) {
      viewer.clearMeasurementOverlay();
      setMeasureReadout("Couldn't compute a result for that pick — try a different entity.", true);
      lastMeasurement = null;
      refreshExactButton();
      refreshPinButton();
      return;
    }
    viewer.showMeasurementOverlay(
      result.linePoints.map((p) => new THREE.Vector3(...p)),
      new THREE.Vector3(...result.anchor),
      result.text
    );
    setMeasureReadout(result.text);
    lastMeasurement = { tool, picks, result };
    refreshExactButton();
    refreshPinButton();
  });

  toggle?.addEventListener("click", () => {
    measuring = !measuring;
    toggle.classList.toggle("active", measuring);
    toggle.setAttribute("aria-checked", String(measuring));
    viewer.setMeasureMode(measuring);
    measurementState.clear();
    viewer.clearMeasurementOverlay();
    setMeasureReadout(measuring ? "Pick a point…" : "");
    lastMeasurement = null;
    refreshExactButton();
    refreshPinButton();
    reflect();
  });

  for (const btn of toolBtns) {
    btn.addEventListener("click", () => {
      measurementState.setTool(btn.dataset.tool as MeasureTool);
      for (const b of toolBtns) b.classList.toggle("active", b === btn);
      viewer.clearMeasurementOverlay();
      setMeasureReadout(measuring ? "Pick a point…" : "");
      lastMeasurement = null;
      refreshExactButton();
      refreshPinButton();
      reflect();
    });
  }

  clearBtn?.addEventListener("click", () => {
    measurementState.clear();
    viewer.clearMeasurementOverlay();
    setMeasureReadout("");
    lastMeasurement = null;
    refreshExactButton();
    refreshPinButton();
  });

  pinBtn?.addEventListener("click", () => {
    const annotation = annotationFromLastMeasurement();
    if (!annotation) return;
    // A half-filled band (Nominal without +) still pins — but says so rather
    // than silently dropping the user's intent.
    const { incomplete } = readToleranceFields();
    annotationsModel.push(annotation);
    setStatus(incomplete && !annotation.tolerance ? "Pinned without a tolerance band — fill Nominal and +" : "Pinned measurement");
  });

  exactBtn?.addEventListener("click", () => {
    if (!lastMeasurement) return;
    const kind = exactMeasureKindFor(lastMeasurement.tool);
    const entityIdA = lastMeasurement.picks[0]?.entityId;
    const entityIdB = lastMeasurement.picks[1]?.entityId ?? undefined;
    if (!kind || !entityIdA) return;
    const requestId = `${Date.now()}-${Math.random()}`;
    measureExactRequestId = requestId;
    exactBtn.disabled = true;
    setMeasureReadout(`${document.getElementById("measure-readout")?.textContent ?? ""} · computing exact…`);
    post({ type: "measureExactRequest", requestId, kind, entityIdA, entityIdB });
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
/**
 * Converts an imported SVG's `<path>` elements into standalone `addPolyline`
 * ops (roadmap "SVG import → profile ops", closed) — genuinely no new
 * kernel surface, since `addPolyline` already exists exactly for "straight
 * edges through points in order." One op per subpath (a single `<path
 * d="...">` with a hole, e.g. a letter "O", parses into TWO subpaths and
 * becomes two separate `addPolyline` ops — matching how `Build → Surface`
 * already treats each closed loop as its own entity to select later).
 *
 * Placement: SVG's Y axis points DOWN; every other coordinate this codebase
 * ever shows the user (view axes, typed op fields, …) is Y-up, so Y is
 * negated on the way in — an unflipped import would look correct in a flat
 * top-down view but mirrored in every other orientation. Imports flat into
 * the XY plane at z=0, 1 SVG user unit = 1mm (this codebase's cascade
 * unit) — a deliberate, simple default matching how Inkscape/Illustrator
 * "trace outline" exports are typically already sized for downstream CAD
 * use; a poorly-scaled source can be fixed afterward with the EXISTING
 * `scale` op, same as any other placement adjustment.
 *
 * Degenerate subpaths (fewer than 2 points; fewer than 3 for a closed one,
 * or a closed one whose first/last point are exactly equal after the Y
 * flip) are silently skipped rather than pushing an op `validateEditOp`
 * would reject anyway — same graceful-degradation rule as every other
 * import path in this codebase.
 */
function importSvgPaths(svgText: string): void {
  if (sourceKind === "mesh") {
    // addPolyline is BREP_ONLY_OPS (meshes have no sketch/exact topology) —
    // same scope as every other wireframe/2D-profile op in this codebase.
    // Caught here, before pushing anything, rather than letting the ops
    // silently no-op in `applyEditsMesh`'s BREP_ONLY_OPS skip — a user
    // importing an SVG deserves to know why nothing appeared.
    setStatus("SVG import builds sketch polylines, which are B-rep only — open a STEP/IGES/BREP file to use it.", true);
    return;
  }
  const subpaths = parseSvgPaths(svgText);
  let imported = 0;
  for (const sub of subpaths) {
    const points: [number, number, number][] = sub.points.map(([x, y]) => [x, -y, 0]);
    if (points.length < 2) continue;
    if (sub.closed && (points.length < 3 || pointsEqual(points[0], points[points.length - 1]))) continue;
    editsModel.push({ op: "addPolyline", points, closed: sub.closed });
    imported++;
  }
  if (imported === 0) {
    setStatus("No usable paths found in that SVG (no <path> elements, or every one was degenerate).", true);
    return;
  }
  setStatus(`Imported ${imported} path${imported === 1 ? "" : "s"} from SVG as sketch polylines.`);
}

function pointsEqual(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * Converts a DXF file's entities into standalone sketch ops (roadmap Tier 2
 * #1 Phase 1). `parseDxf` already returns validated `EditOp`s (one per
 * LINE/CIRCLE/ARC, per-vertex arcs/lines for LWPOLYLINE/POLYLINE with bulges,
 * otherwise a single closed/open addPolyline/spline) — this just pushes them.
 * Flat XY at z=0, Y-up native, 1 DXF unit = 1mm, same as SVG placement but
 * without the Y-negation (DXF is already Y-up).
 */
function importDxfPaths(dxfText: string): void {
  if (sourceKind === "mesh") {
    setStatus("DXF import builds sketch primitives, which are B-rep only — open a STEP/IGES/BREP file to use it.", true);
    return;
  }
  const { ops, warnings } = parseDxf(dxfText);
  if (ops.length === 0) {
    // Surface parse warnings (e.g. no ENTITIES) if any, otherwise generic
    const hint = warnings[0] ?? "No usable entities found (supported: LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC, SPLINE).";
    setStatus(hint, true);
    return;
  }
  for (const op of ops) editsModel.push(op);
  const suffix = warnings.length > 0 ? ` (${warnings.join("; ")})` : "";
  setStatus(`Imported ${ops.length} entit${ops.length === 1 ? "y" : "ies"} from DXF as sketch primitives.${suffix}`);
}

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
  item("menu-import-svg", () => post({ type: "importSvgRequest" }));
  item("menu-import-dxf", () => post({ type: "importDxfRequest" }));
  item("menu-export-svg", () => post({ type: "exportSvgRequest" }));
  item("menu-export-dxf", () => post({ type: "exportDxfRequest" }));
  item("menu-export-drawing", () => post({ type: "exportDrawingRequest" }));
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

  // Grid/entity snapping (roadmap "Grid and entity snapping", closed) —
  // session-only booleans read by the Transform Gizmo's `onChange` handler
  // above; clicks inside this dropdown don't close it (established "flip a
  // mode, keep the panel open" convention this menu already follows).
  const snapGridBtn = document.getElementById("snap-grid");
  snapGridBtn?.addEventListener("click", () => {
    snapToGridEnabled = !snapToGridEnabled;
    snapGridBtn.setAttribute("aria-checked", String(snapToGridEnabled));
  });
  const snapPointsBtn = document.getElementById("snap-points");
  snapPointsBtn?.addEventListener("click", () => {
    snapToPointsEnabled = !snapToPointsEnabled;
    snapPointsBtn.setAttribute("aria-checked", String(snapToPointsEnabled));
  });

  // Split view (roadmap "Split view", Phase 2) — the View ▾ layout picker:
  // four mutually-exclusive pane layouts over one scene (one renderer, one
  // canvas — panes are scissored viewports). Only camera state is per-pane;
  // everything else (display mode, clip plane, selection, overlays) stays
  // global. The active button mirrors the current layout; a layout change
  // also updates the pane dividers and persists via `scheduleViewSave`.
  for (const btn of document.querySelectorAll<HTMLButtonElement>("#layout-group .layout-btn")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.layout as ReturnType<typeof viewer.getPaneLayout>;
      if (!next || next === viewer.getPaneLayout()) return;
      viewer.setPaneLayout(next);
      reflectLayoutPicker(next);
      setPaneDividersForLayout(next);
      // A layout change is a user view change — persist it. `viewer`'s
      // `onViewChanged` may not fire for this (the kept pane's camera didn't
      // move), so call explicitly rather than relying on the change event.
      scheduleViewSave();
    });
  }
  reflectLayoutPicker(viewer.getPaneLayout());

  const linkBtn = document.getElementById("link-cameras");
  linkBtn?.addEventListener("click", () => {
    const enabled = linkBtn.getAttribute("aria-checked") !== "true";
    // Optimistic reflect — authoritative state comes back via `camerasLinked`.
    linkBtn.setAttribute("aria-checked", String(enabled));
    post({ type: "setCamerasLinked", enabled });
  });

  // #edges is owned by setupAppearanceControls() — it holds the visibility
  // flag; this only reflects it. Screenshot is one-shot, so it dismisses.
  document.getElementById("screenshot")?.addEventListener("click", () => menu?.close());
}

/** Syncs the picker's `.active` class to `layout` — called from the picker
 * click handler and from `applyViewState`'s restore path. */
function reflectLayoutPicker(layout: string): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>("#layout-group .layout-btn")) {
    btn.classList.toggle("active", btn.dataset.layout === layout);
  }
}

/** Shows/hides the two thin DOM dividers between split-view panes — pure
 * visual separators over the single canvas (pointer-events: none; the panes
 * they delineate share that one canvas, so there is nothing to hit-test).
 * `1×2` shows only the vertical divider, `2×1` only the horizontal, `2×2`
 * both, `1×1` neither. Kept as a named export helper so `applyViewState`'s
 * restore path can also sync dividers without re-dispatching a picker click. */
function setPaneDividersForLayout(layout: string): void {
  document.getElementById("pane-divider-v")?.classList.toggle("hidden", layout !== "1x2" && layout !== "2x2");
  document.getElementById("pane-divider-h")?.classList.toggle("hidden", layout !== "2x1" && layout !== "2x2");
}
/** Backwards-compat alias for older call sites/tests that used the boolean form. */
function setPaneDividersVisible(visible: boolean): void {
  setPaneDividersForLayout(visible ? "2x2" : "1x1");
}

/**
 * Drop a CAD/mesh file onto the viewer to open it. `dragover` must call
 * `preventDefault()` or the browser never fires `drop`. Whether the dropped
 * `File` exposes a real filesystem path (`.path`, a legacy, non-standard
 * Electron extension to the DOM `File` object) is VS Code/Electron-version
 * dependent — **Electron 32 (Aug 2024) removed it outright** in favor of
 * `webUtils.getPathForFile()`, which needs a preload/Node context a webview's
 * content script never has, so `path` reads `undefined` on any VS Code build
 * from roughly mid-2025 onward (VS Code moved to Electron 34 around its Feb
 * 2025 insiders milestone). When it isn't there, fall back to the plain
 * `{type:"openFile"}` message (opens the normal dialog) rather than silently
 * doing nothing — this fallback is the realistic path on a modern install,
 * not just a defensive edge case. See CLAUDE.md for the full trail.
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

/** Handle returned by {@link setupAppearanceControls} so persisted view state
 * (roadmap "View-state persistence", closed) can restore ortho/display-mode
 * through the SAME code the user's own toolbar clicks use — one place that
 * drives the viewer call, the button state, and (via `scheduleViewSave()`
 * inside the click handlers themselves) the autosave, instead of restore and
 * click duplicating that logic and risking drift. */
interface AppearanceControlsHandle {
  applyOrtho(enabled: boolean): void;
  /** Re-reads the focused pane's projection state onto the button's
   * label/active class WITHOUT changing it — used when the focused pane
   * changes (split view), since projection is per-pane and the new focus may
   * carry the opposite mode even though the user clicked no projection
   * control. */
  reflectOrtho(): void;
  applyDisplayMode(mode: DisplayMode): void;
}

/**
 * Appearance controls: Edges toolbar toggle (discrete on/off, like Wireframe/
 * Grid), background swatch + opacity slider (continuous, `#view-controls`'
 * "Appearance" group). Edges/background/opacity stay session-only — never
 * persisted, mirroring `setWireframe`/`toggleGrid`'s "always wins once set"
 * precedent. Ortho and Display mode ARE persisted (see `ViewState`); their
 * `apply*` methods are shared between the user's own click and
 * `applyInitialViewIfNeeded`'s restoration.
 */
function setupAppearanceControls(): AppearanceControlsHandle {
  let edgesVisible = true;
  const edgesBtn = document.getElementById("edges");
  edgesBtn?.addEventListener("click", () => {
    edgesVisible = !edgesVisible;
    viewer.setEdgesVisible(edgesVisible);
    // Drives the tick on the View ▾ menu's checkable item.
    edgesBtn.setAttribute("aria-checked", String(edgesVisible));
  });

  // Roadmap "Display-edge classification, as a flag", closed — declutters
  // tangent NURBS-patch-seam edges while leaving genuine feature edges
  // alone. Defaults to unchecked/shown (`smoothEdgesShown = true`), matching
  // every pre-existing document's current look.
  let smoothEdgesShown = true;
  const hideSmoothEdgesBtn = document.getElementById("hide-smooth-edges");
  hideSmoothEdgesBtn?.addEventListener("click", () => {
    smoothEdgesShown = !smoothEdgesShown;
    viewer.setSmoothEdgesVisible(smoothEdgesShown);
    hideSmoothEdgesBtn.setAttribute("aria-checked", String(!smoothEdgesShown));
  });

  document.getElementById("vc-background")?.addEventListener("input", (e) => {
    viewer.setBackground((e.target as HTMLInputElement).value);
  });

  document.getElementById("vc-opacity")?.addEventListener("input", (e) => {
    viewer.setOpacity(Number((e.target as HTMLInputElement).value) / 100);
  });

  const orthoBtn = document.getElementById("vc-ortho");
  const reflectOrtho = () => {
    if (orthoBtn) {
      orthoBtn.textContent = viewer.isOrthographic() ? "Ortho" : "Persp";
      orthoBtn.classList.toggle("active", viewer.isOrthographic());
    }
  };
  const applyOrtho = (enabled: boolean) => {
    viewer.setOrthographic(enabled);
    reflectOrtho();
  };
  orthoBtn?.addEventListener("click", () => {
    applyOrtho(!viewer.isOrthographic());
    scheduleViewSave();
  });
  document.getElementById("vc-unit")?.addEventListener("change", (e) => {
    setDisplayUnit((e.target as HTMLSelectElement).value as DisplayUnit);
  });

  // Grid snap spacing (roadmap "Grid and entity snapping", closed) — a
  // plain number, not a parametric-expression field like the Edits panel's
  // op params, so a non-positive/unparsable value just falls back to
  // `gridSnapSize`'s last-good value (same tolerant-input spirit as every
  // other session-only Appearance control, no error toast for a bad keystroke).
  document.getElementById("vc-grid-size")?.addEventListener("input", (e) => {
    const n = Number((e.target as HTMLInputElement).value);
    if (Number.isFinite(n) && n > 0) gridSnapSize = n;
  });

  // Display mode replaces the old standalone Wireframe toolbar toggle —
  // Shaded/Wireframe are two of five mutually exclusive states now (see
  // src/webview/displayMode.ts). A material-affecting switch (Flat swaps the
  // active material instance) needs colours/selection re-applied afterward —
  // refreshColors() already does both, the same contract setModel() relies on.
  const modeBtns = [...document.querySelectorAll<HTMLButtonElement>(".display-mode-btn")];
  const applyDisplayMode = (mode: DisplayMode) => {
    viewer.setDisplayMode(mode);
    refreshColors();
    for (const b of modeBtns) b.classList.toggle("active", b.dataset.mode === mode);
  };
  for (const btn of modeBtns) {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode ?? "";
      if (!isDisplayMode(mode)) return;
      applyDisplayMode(mode);
      scheduleViewSave();
    });
  }

  return { applyOrtho, reflectOrtho, applyDisplayMode };
}

/** `null` clip state means clipping is off (mirrors `ViewState.clip`). */
type ClipState = ClipPlaneState | null;

/** Handle returned by {@link setupClippingControls}, letting persisted view
 * state restore the clip plane through the same code the toolbar uses, and
 * letting the view-state save gather the clip plane's current settings
 * (`clipAxis`/`clipEnabled`/`offsetFrac` are this function's own closure
 * state, with no other way to read them from outside). */
interface ClippingControlsHandle {
  applyState(state: ClipState): void;
  getState(): ClipState;
  /** Enables/disables the two derive buttons for the current selection.
   * Called from `renderHighlight()`, the single choke point every selection
   * mutation already funnels through. */
  reflectSelection(): void;
  /** Applies a plane derived from picked geometry: orients it toward the bulk
   * of the model, stores it as the custom normal, and turns clipping on. */
  applyDerivedPlane(normal: THREE.Vector3, throughPoint: THREE.Vector3, label: string): void;
}

/**
 * Live clipping/section plane — display-only, distinct from the `section`
 * edit op. Every slider `input` applies immediately (no commit-gating, unlike
 * the meshing size slider). Persisted (roadmap "View-state persistence",
 * closed) as `{axis, offsetFrac}` — the offset is a FRACTION of the model's
 * current bbox (`planeForAxis`'s own convention), which is what makes it
 * meaningful to restore against a possibly-different-sized model on reopen,
 * unlike a raw plane constant.
 */
function setupClippingControls(): ClippingControlsHandle {
  let clipAxis: ClipAxis = "x";
  let clipEnabled = false;
  /** The custom normal, or `null` while an axis preset is active. Kept even
   * while a preset is selected, so the `N` segment can switch back to it
   * without the user re-picking the geometry. */
  let customNormal: THREE.Vector3 | null = null;
  let customLabel = "";
  let usingCustom = false;
  /**
   * The source of truth for the cut position. The slider is a VIEW of this,
   * not the other way round: its integer -100..100 range quantizes to 0.01,
   * which used to silently round `offsetFrac` on every restore (0.333 → 0.33,
   * rewriting the sidecar). Harmless for a hand-dragged axis clip; a real
   * correctness problem for "clip exactly at this face", where 0.5% of the
   * bbox extent is enough to leave a visible sliver of the face behind.
   */
  let offsetFrac = 0;

  const allSegments = [...document.querySelectorAll<HTMLButtonElement>(".clip-axis")];
  const customBtn = document.getElementById("clip-custom") as HTMLButtonElement | null;
  const axisBtns = allSegments.filter((b) => b.dataset.axis !== undefined);
  const offsetSlider = document.getElementById("clip-offset") as HTMLInputElement | null;
  const toggleBtn = document.getElementById("clip-toggle");
  const faceBtn = document.getElementById("clip-from-face") as HTMLButtonElement | null;
  const pointsBtn = document.getElementById("clip-from-points") as HTMLButtonElement | null;

  const modelBox = (): THREE.Box3 | null => {
    const model = viewer.getModel();
    if (!model) return null;
    const box = new THREE.Box3().setFromObject(model);
    return box.isEmpty() ? null : box;
  };

  const currentState = (): ClipPlaneState => ({
    axis: clipAxis,
    offsetFrac,
    ...(usingCustom && customNormal ? { normal: customNormal.toArray() as [number, number, number] } : {}),
  });

  const applyClip = () => {
    const box = clipEnabled ? modelBox() : null;
    viewer.setClippingPlane(box ? planeForClip(currentState(), box) : null);
  };

  /** Keeps the four segments, the slider and the toggle showing the truth. */
  const reflectUi = () => {
    axisBtns.forEach((b) => b.classList.toggle("active", !usingCustom && b.dataset.axis === clipAxis));
    if (customBtn) {
      customBtn.hidden = customNormal === null;
      customBtn.classList.toggle("active", usingCustom);
      if (customNormal) {
        const n = customNormal.toArray().map((c) => c.toFixed(3)).join(", ");
        customBtn.title = customLabel ? `Custom normal (${n}) — from ${customLabel}` : `Custom normal (${n})`;
      }
    }
    if (offsetSlider) offsetSlider.value = String(Math.round(offsetFrac * 100));
    if (toggleBtn) {
      toggleBtn.classList.toggle("active", clipEnabled);
      toggleBtn.textContent = clipEnabled ? "On" : "Off";
    }
  };

  for (const btn of axisBtns) {
    btn.addEventListener("click", () => {
      clipAxis = btn.dataset.axis as ClipAxis;
      usingCustom = false;
      reflectUi();
      applyClip();
      scheduleViewSave();
    });
  }
  // Re-selects the stored custom normal, so X/Y/Z/N is a genuine four-way
  // control — flip to an axis, look at something, flip back without re-picking.
  customBtn?.addEventListener("click", () => {
    if (!customNormal) return;
    usingCustom = true;
    reflectUi();
    applyClip();
    scheduleViewSave();
  });
  offsetSlider?.addEventListener("change", scheduleViewSave); // commit on release, not every drag tick
  offsetSlider?.addEventListener("input", () => {
    offsetFrac = Number(offsetSlider.value) / 100;
    applyClip();
  });
  toggleBtn?.addEventListener("click", () => {
    clipEnabled = !clipEnabled;
    reflectUi();
    applyClip();
    scheduleViewSave();
  });

  const applyDerivedPlane = (normal: THREE.Vector3, throughPoint: THREE.Vector3, label: string) => {
    const box = modelBox();
    if (!box) {
      setStatus("No model to clip.", true);
      return;
    }
    // Orient toward the bulk, or a face's own outward normal would keep the
    // EMPTY half and the model would appear to vanish.
    const oriented = orientTowardBulk(normal, throughPoint, box);
    customNormal = oriented.normal;
    customLabel = label;
    usingCustom = true;
    clipAxis = dominantAxis(oriented.normal);
    offsetFrac = oriented.offsetFrac;
    // Turning clipping on is part of the action: clicking "Face" while clipping
    // is off and seeing nothing happen is a bug-shaped experience.
    clipEnabled = true;
    reflectUi();
    applyClip();
    scheduleViewSave();
    setStatus(
      offsetFrac <= -0.999
        ? `Clip normal from ${label} — drag the offset slider to cut.`
        : `Clipping along ${label}.`
    );
  };

  const reflectSelection = () => {
    const picked = selection.list();
    const faces = picked.filter((e) => e.entityType === "surface");
    const points = picked.filter((e) => e.entityType === "point");
    if (faceBtn) {
      // Mesh sources have no analytic surface, so the host can only answer the
      // facts request with an error — don't offer the button at all.
      const ok = sourceKind === "brep" && faces.length === 1 && picked.length === 1;
      faceBtn.disabled = !ok;
      faceBtn.title = ok
        ? `Clip along ${faces[0].entityId}`
        : sourceKind === "brep"
          ? "Select exactly one planar face to clip along it"
          : "Clipping along a face needs a B-rep source";
    }
    if (pointsBtn) {
      // Self-gating for mesh sources: they build no `point-N` sprites at all.
      const ok = points.length === 3 && picked.length === 3;
      pointsBtn.disabled = !ok;
      pointsBtn.title = ok ? "Clip through the three selected points" : "Select exactly three points";
    }
  };

  faceBtn?.addEventListener("click", () => requestClipFromFace());
  pointsBtn?.addEventListener("click", () => applyClipFromPoints());
  reflectSelection();

  const applyState = (state: ClipState) => {
    clipEnabled = state !== null;
    if (state) {
      clipAxis = state.axis;
      offsetFrac = state.offsetFrac;
      if (state.normal) {
        customNormal = new THREE.Vector3(...state.normal);
        customLabel = customLabel || "the saved view";
        usingCustom = true;
      } else {
        usingCustom = false;
      }
    }
    reflectUi();
    applyClip();
  };
  const getState = (): ClipState => (clipEnabled ? currentState() : null);

  return { applyState, getState, reflectSelection, applyDerivedPlane };
}

/**
 * Clip ▸ Face. Issues its OWN `entityFactsRequest` rather than reusing whatever
 * the inspector card last fetched: group/query selection never calls
 * `requestEntityFacts` at all, so that cache is empty or stale for a face
 * selected that way, and reusing it would also race a click that lands before
 * an in-flight reply. The two request-id latches are independent, so neither
 * consumer can steal the other's response.
 */
let clipFaceFactsRequestId: string | null = null;

function requestClipFromFace(): void {
  const face = selection.list().find((e) => e.entityType === "surface");
  if (!face) return;
  clipFaceFactsRequestId = `clipface-${Date.now()}-${Math.random()}`;
  post({ type: "entityFactsRequest", requestId: clipFaceFactsRequestId, entityId: face.entityId });
}

/** Applies a clip plane from a completed Clip ▸ Face round trip. */
function applyClipFromFaceFacts(facts: EntityFacts): void {
  // `EntityFacts` sets BOTH of these only for a planar face, so this one check
  // covers every non-planar surface type.
  if (!facts.normal || !facts.planeOrigin) {
    setStatus(
      `${facts.entityId} is ${facts.surfaceType ? `a ${facts.surfaceType} face` : "not planar"} — pick a planar face.`,
      true
    );
    return;
  }
  // `planeOrigin` genuinely lies ON the face's plane; `center` is the bbox
  // centre, which for an annular or concave face need not.
  clippingControls?.applyDerivedPlane(
    new THREE.Vector3(...facts.normal),
    new THREE.Vector3(...facts.planeOrigin),
    facts.entityId
  );
}

/** Clip ▸ 3 Pts — entirely webview-side; the sprite positions are already here. */
function applyClipFromPoints(): void {
  const ids = selection.list().filter((e) => e.entityType === "point");
  if (ids.length !== 3) return;
  const byId = collectPointEntities();
  const pts = ids.map((e) => byId.get(e.entityId));
  if (pts.some((p) => !p)) {
    setStatus("Those points are no longer in the model.", true);
    return;
  }
  const [a, b, c] = pts as THREE.Vector3[];
  const plane = planeFromThreePoints(a, b, c);
  if (!plane) {
    setStatus("Those three points are collinear — no plane.", true);
    return;
  }
  clippingControls?.applyDerivedPlane(plane.normal, plane.point, `${ids.map((e) => e.entityId).join(", ")}`);
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

// Hoisted out of the try block below (mirroring `meshingToggle`/`worstToggle`
// further down) so `applyInitialViewIfNeeded`/`scheduleViewSave` — called
// from the top-level `message` handler, not from inside the try — can reach
// them. `null` if `setupAppearanceControls`/`setupClippingControls` threw;
// both call sites below already tolerate that (`?.`).
let appearanceControls: AppearanceControlsHandle | null = null;
let clippingControls: ClippingControlsHandle | null = null;

try {
  setupViewControls();
  setupViewMenu();
  setupSelectionControls();
  setupMeasureControls();
  setupFileMenu();
  setupDragAndDrop();
  appearanceControls = setupAppearanceControls();
  clippingControls = setupClippingControls();
  // The Planes panel drives the clip through the SAME handle the Face/3 Pts
  // buttons use, so "Use this plane" and a derived clip cannot diverge into
  // two implementations.
  planesClipHandle = clippingControls;
  setupPlanesControls();
  setupMarkupControls();
  setupColorFieldControls();
  setupThemeReactivity();
  // Split view: when the focused pane changes (a click in another pane), UI
  // that mirrors FOCUSED-pane state must re-read it — projection is per-pane,
  // so the Persp/Ortho button can need the other label even though the user
  // clicked no projection control.
  viewer.onFocusChanged(() => appearanceControls?.reflectOrtho());
} catch (err) {
  const message = `View controls failed to initialize: ${(err as Error).message}`;
  console.error(message, err);
  post({ type: "log", message });
}

// ── View-state persistence (roadmap "View-state persistence", closed) ──────
// Camera direction/up, ortho/perspective, display mode, and clip plane
// restored on first load instead of always resetting to the hardcoded
// isometric — `explode` state is deliberately NOT included here (it's a
// session-only interaction preview by design, see `explodePreview.ts`; the
// COMMITTED `explode` edit op already persists correctly via `.edits.json`).
//
// `pendingViewState` starts `undefined` ("the `viewState` sidecar message
// hasn't arrived yet") and becomes `ViewState | null` once it has (`null` =
// no sidecar exists for this document yet). `applyInitialViewIfNeeded` is
// called from every handler that could complete the "both geometry AND
// viewState have arrived" condition — the `geometry`/`viewState` cases below
// and `rebuildMeshModel()` — mirroring `syncMeshSizeSeed()`'s "whichever
// lands last performs the actual application" idiom, since the two messages
// have no deterministic arrival order (both roundtrip through the same
// `ready` handler in `provider.ts` but via independent async reads).
let pendingViewState: ViewState | null | undefined;
let hasAppliedInitialView = false;

/** Applies a full `ViewState` to the viewer + Appearance/Clip controls — the
 * one place that does so, shared by the initial restoration below and by a
 * post-initial external-change reconciliation of `.view.json` (`case
 * "viewState":`, when `hasAppliedInitialView` is already true).
 *
 * Phase 2: `layout` + per-pane `panes` are applied first — the layout switch
 * itself is pane-management only (no model needed), then each pane's camera
 * direction/up/ortho is restored via the per-pane Viewer API. When no per-pane
 * state is present (old sidecar, single-pane session) the original
 * focused-pane-only path runs as before. Global display mode + clip stay
 * once, not per pane. */
function applyViewState(state: ViewState): void {
  const layout = state.layout ?? "1x1";
  if (layout !== viewer.getPaneLayout()) viewer.setPaneLayout(layout as ReturnType<typeof viewer.getPaneLayout>);
  reflectLayoutPicker(layout);
  setPaneDividersForLayout(layout);
  if (layout !== "1x1" && state.panes && state.panes.length > 0) {
    // Per-pane camera states — `viewStateSidecar` already padded/truncated to
    // `paneCount(layout)`, but be defensive against a hand-edited sidecar.
    const n = Math.min(state.panes.length, viewer.getPaneViewStates().length);
    for (let i = 0; i < n; i++) viewer.applyPaneCameraState(i, state.panes[i]);
    // A per-pane ortho toggle doesn't go through the Appearance button's
    // `applyOrtho` path, so re-sync the button to the (still focused) pane 0.
    appearanceControls?.reflectOrtho();
  } else {
    viewer.setCameraUp(new THREE.Vector3(...state.cameraUp));
    if (state.orthographic !== viewer.isOrthographic()) appearanceControls?.applyOrtho(state.orthographic);
    viewer.frameFromDirection(new THREE.Vector3(...state.viewDirection));
  }
  appearanceControls?.applyDisplayMode(state.displayMode);
  clippingControls?.applyState(state.clip);
}

function applyInitialViewIfNeeded(): void {
  if (hasAppliedInitialView) return;
  if (pendingViewState === undefined) return;
  if (!viewer.getModel()) return;
  if (pendingViewState) applyViewState(pendingViewState);
  else viewer.resetView();
  // Set AFTER applying: `applyViewState`/`resetView` above both end in
  // `controls.update()`, which synchronously fires `onViewChanged` below —
  // gating on this flag being true (not yet, during this call) is what keeps
  // merely OPENING a file from immediately creating a `.view.json` it never
  // had, the same "opening ≠ a user change" rule `syncMeshSizeSeed()`'s
  // `load()`-not-`update()` choice already establishes for mesh options.
  hasAppliedInitialView = true;
}

const VIEW_SAVE_DEBOUNCE_MS = 500;
let viewSaveTimer: ReturnType<typeof setTimeout> | undefined;

/** While applying a linked camera from another tab, suppress the echo that
 * would otherwise relay it back (roadmap "Split view", Phase 3). */
let applyingLinkedCamera = false;

function applyLinkedCamera(camera: import("../protocol").LinkedCameraState): void {
  if (viewSaveTimer) clearTimeout(viewSaveTimer);
  applyingLinkedCamera = true;
  try {
    viewer.setCameraUp(new THREE.Vector3(...camera.cameraUp));
    if (camera.orthographic !== viewer.isOrthographic()) {
      appearanceControls?.applyOrtho(camera.orthographic);
    }
    viewer.frameFromDirection(new THREE.Vector3(...camera.viewDirection));
    appearanceControls?.reflectOrtho();
  } finally {
    applyingLinkedCamera = false;
  }
}

/** Debounced autosave, called from every user-facing view change (camera
 * orbit/pan/zoom/fit/reset, the orientation gizmo, ortho/display-mode
 * buttons, the clip controls, and — since Phase 2 — a layout change or any
 * per-pane camera move). */
function scheduleViewSave(): void {
  if (!hasAppliedInitialView || applyingLinkedCamera) return;
  if (viewSaveTimer) clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(() => {
    const dir = viewer.getViewDirection();
    const up = viewer.getCameraUp();
    const view: ViewState = {
      viewDirection: [dir.x, dir.y, dir.z],
      cameraUp: [up.x, up.y, up.z],
      orthographic: viewer.isOrthographic(),
      displayMode: viewer.getDisplayMode(),
      clip: clippingControls?.getState() ?? null,
    };
    const layout = viewer.getPaneLayout();
    if (layout !== "1x1") {
      view.layout = layout;
      view.panes = viewer.getPaneViewStates();
    }
    post({ type: "viewChanged", view });
  }, VIEW_SAVE_DEBOUNCE_MS);
}

try {
  // Covers orbit/pan/zoom drags, the stepped rotate/pan/zoom toolbar buttons,
  // Fit/Reset, and the orientation gizmo — every one of them funnels through
  // `Viewer`'s internal `controls.update()`, so this single hook is enough;
  // see `onViewChanged`'s doc comment in `viewer.ts`.
  viewer.onViewChanged(scheduleViewSave);
} catch (err) {
  const message = `View-state autosave failed to initialize: ${(err as Error).message}`;
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
        viewer.setModel(group, { autoFit: msg.autoFit });
        cancelOpPreview(); // setModel() cleared the overlay; kill any pending/in-flight preview too
        explodePreviewBases = null; // stale references to the just-replaced model's objects
        gizmoTargets = null; // ditto — a fresh drag re-resolves targets from the new model
        lastRawMassProperties = null; // stale — refers to the just-replaced model
        lastMeasurement = null; // stale entity ids — refer to the just-replaced model
        hideInspectorCard(); // ditto — its facts describe the just-replaced shape
        hideHoverTip();
        lastOpOutcomes = msg.opOutcomes ?? null; // fresh replay outcomes for the Edits history markers
        lastOpBuckets = msg.opBuckets ?? null; // fresh produced-face classification for the Edits history chips
        guideEntityIds.clear();
        for (const id of msg.guideIds ?? []) guideEntityIds.add(id); // construction geometry: dimmed, refused as feature operands
        viewer.setGuideIds(msg.guideIds ?? []);
        setMeshHealthEligibility(null); // B-rep sources have nothing to heal
        viewer.setFitSeedPickHandler(null);
        lastRegionFit = null;
        regionFitRequestId = null;
        clearMarkupOverlay?.();
        refreshColors();
        renderAnnotationsList(); // detached status may have changed for the new model
        renderEditsUi(); // re-render the history with the fresh per-op outcome markers
        setSelectableModes(["volume", "surface", "line", "point"]);
        editsPanel.setBRepOnly(true); // fillet/chamfer available for B-rep
        sourceKind = "brep";
        refreshExactButton();
        refreshPinButton();
        meshingPanel.setSourceKind("brep");
        meshingPanel.setModelExtents(viewer.getModelExtents());
        syncMeshSizeSeed();
        applyInitialViewIfNeeded();
        showSidebar();
        setStatus("");
      } catch (err) {
        setStatus(`Failed to build geometry: ${(err as Error).message}`, true);
      }
      break;

    case "tree":
      setDisplayUnit(displayUnitFromUnitName(msg.sourceUnit) ?? "mm");
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

    case "planes":
      // Silent hydration, same contract as "parts"/"annotations".
      planesModel.load(msg.planes);
      renderPlanesList();
      if (editsModel.list().some((o) => (o as unknown as Record<string, unknown>).planeId)) {
        renderEditsUi();
        if (pristineMesh) rebuildMeshModel();
      }
      break;

    case "annotations":
      // Silent hydration (initial load, external reconciliation, or a
      // host-side rebind after a topology-changing edit) — does not echo
      // back as a write, same contract as "parts"/"edits".
      annotationsModel.load(msg.annotations);
      renderAnnotationsList();
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
      setMeshHealthEligibility(COMPARABLE_MESH_FORMATS.has(msg.format) ? (msg.format as MeshParseFormat) : null);
      viewer.setFitSeedPickHandler(null);
      lastRegionFit = null;
      regionFitRequestId = null;
      await loadMeshObjectFromUrl(msg.url, msg.format, msg.format.toUpperCase());
      break;

    case "loadMeshBytes":
      // A meshio-converted STL boundary is not itself a real .stl/.obj/.ply
      // file on disk (the actual source is VTK/MED/CGNS/Exodus/XDMF/MDPA) —
      // check_mesh_health's MCP tool would reject that source's real path
      // the same way, so the panel stays ineligible here too.
      setMeshHealthEligibility(null);
      viewer.setFitSeedPickHandler(null);
      lastRegionFit = null;
      regionFitRequestId = null;
      // Host-converted bytes (meshio++-imported document — VTK/MED/CGNS/
      // Exodus/XDMF/MDPA — funneled into an STL boundary surface via
      // `convertToStlBoundary`/`convertToStlBoundaryWithRegions`; see
      // `src/meshioService.ts`). Fed through the exact same STL-loading path
      // a native `.stl` open uses, via a `blob:` object URL instead of a
      // `vscode-webview://` fetch — base64-over-postMessage rather than a
      // `data:` URL, the same proven pattern `geometry` already uses for
      // large buffers, sidestepping any webview CSP/size-limit uncertainty
      // around `data:` URLs.
      try {
        const bytes = Uint8Array.from(atob(msg.dataBase64), (c) => c.charCodeAt(0));
        const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "model/stl" }));
        const regionInfo = msg.regionAssignment
          ? { triangleRegion: decodeI32(msg.regionAssignment.triangleRegionIndex) }
          : null;
        try {
          await loadMeshObjectFromUrl(blobUrl, "stl", msg.sourceFormat.toUpperCase(), regionInfo);
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
        // Region names that correlated to boundary triangles (`regionAssignment`
        // present) became Parts host-side — see `provider.ts`'s `handleMeshio`
        // and CLAUDE.md's "meshio++ integration" section. Point/cell data array
        // names populate the "Colour by field" selector below (values fetched
        // on demand, only once picked); `fieldDataNames` (whole-mesh, not
        // spatially varying) stays purely informational — nothing to colour by.
        // Set AFTER the load above so `loadMeshObjectFromUrl`'s own
        // "Loading model…" → "" status sequence can't race with and clear this one.
        applyAvailableColorFields(msg.meshioMetadata);
        if (msg.meshioMetadata) {
          const bits: string[] = [];
          if (msg.meshioMetadata.regions.length > 0) {
            const names = msg.meshioMetadata.regions.map((r) => r.name).join(", ");
            bits.push(
              msg.regionAssignment
                ? `${msg.meshioMetadata.regions.length} region(s): ${names} (see Parts)`
                : `${msg.meshioMetadata.regions.length} region(s): ${names} — not imported as Parts/geometry`
            );
          }
          const colorableNames = [...msg.meshioMetadata.pointDataNames, ...msg.meshioMetadata.cellDataNames];
          if (colorableNames.length > 0) bits.push(`data: ${colorableNames.join(", ")} (see "Colour by field")`);
          if (msg.meshioMetadata.fieldDataNames.length > 0) bits.push(`field data: ${msg.meshioMetadata.fieldDataNames.join(", ")} — not imported`);
          if (bits.length > 0) setStatus(`Source file also declares ${bits.join(" · ")}.`);
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

    case "viewState":
      // Initial hydration (or a reconciled external change to `.view.json`) —
      // `null` means no sidecar exists yet for this document. Applied once
      // geometry has also arrived; see `applyInitialViewIfNeeded`. A reload
      // AFTER the initial apply (external-change reconciliation) re-applies
      // it directly instead — going back through `applyInitialViewIfNeeded`
      // would no-op on its `hasAppliedInitialView` guard.
      pendingViewState = msg.view;
      if (hasAppliedInitialView) {
        if (msg.view) applyViewState(msg.view);
      } else {
        applyInitialViewIfNeeded();
      }
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
        if (msg.frameBox) {
        // Fill the frame with one entity rather than the whole model. Uses
        // frameBox (not setViewDirection, which keeps the current distance).
        viewer.frameBox(
          new THREE.Box3(new THREE.Vector3(...msg.frameBox.min), new THREE.Vector3(...msg.frameBox.max)),
          new THREE.Vector3(...msg.direction)
        );
      } else {
        viewer.setViewDirection(new THREE.Vector3(...msg.direction));
      }
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

    case "macros":
      macrosPanel.render(msg.macros);
      break;

    case "macroApplyOps":
      // Straight onto the op stack, so the macro's ops are undoable and
      // removable one by one exactly like hand-applied edits.
      for (const op of msg.ops) editsModel.push(op);
      break;

    case "entityFactsResult":
      // Clip ▸ Face shares this round trip with the inspector card, latched on
      // its own request id — checked first so a clip reply is never mistaken
      // for a card reply, and vice versa.
      if (msg.requestId === clipFaceFactsRequestId) {
        clipFaceFactsRequestId = null;
        applyClipFromFaceFacts(msg.facts);
        break;
      }
      if (msg.requestId !== entityFactsRequestId) break; // stale — a newer selection superseded it
      renderInspectorCard(msg.facts.entityId, msg.facts);
      break;

    case "entityFactsError":
      if (msg.requestId === clipFaceFactsRequestId) {
        clipFaceFactsRequestId = null;
        setStatus(msg.message, true);
        break;
      }
      if (msg.requestId !== entityFactsRequestId) break;
      // Keep the card, showing why — silently vanishing would read as a bug.
      renderInspectorCard(selection.list()[0]?.entityId ?? "", null, msg.message);
      break;

    case "standardPartsSearchResult":
      if (msg.requestId !== standardPartsSearchRequestId) break; // stale — a newer search superseded it
      standardPartsPanel.renderResults(msg.items, msg.total);
      break;

    case "standardPartsSearchError":
      if (msg.requestId !== standardPartsSearchRequestId) break;
      standardPartsPanel.renderError(msg.message);
      break;

    case "standardPartsInsertResult": {
      const id = standardPartsInsertRequests.get(msg.requestId);
      standardPartsInsertRequests.delete(msg.requestId);
      if (!id) break;
      standardPartsPanel.onInsertSettled(id);
      if (msg.path) standardPartsPanel.setStatus(`Inserted → ${msg.path}`);
      break;
    }

    case "standardPartsInsertError": {
      const id = standardPartsInsertRequests.get(msg.requestId);
      standardPartsInsertRequests.delete(msg.requestId);
      if (id) standardPartsPanel.onInsertSettled(id);
      standardPartsPanel.setStatus(msg.message, true);
      break;
    }

    case "importSvgResult":
      importSvgPaths(msg.text);
      break;

    case "importSvgError":
      setStatus(`SVG import failed: ${msg.message}`, true);
      break;

    case "importDxfResult":
      importDxfPaths(msg.text);
      break;

    case "importDxfError":
      setStatus(`DXF import failed: ${msg.message}`, true);
      break;

    case "measureExactResult": {
      if (msg.requestId !== measureExactRequestId) break; // stale — a newer request/Clear superseded it
      const label = msg.result.kind === "distance" ? "D" : msg.result.kind === "edgeLength" ? "L" : "R";
      setMeasureReadout(`${label}_exact = ${formatMeasureLength(msg.result.value)}`);
      (document.getElementById("measure-exact-btn") as HTMLButtonElement | null)?.removeAttribute("disabled");
      break;
    }

    case "measureExactError":
      if (msg.requestId !== measureExactRequestId) break;
      setMeasureReadout(msg.message, true);
      (document.getElementById("measure-exact-btn") as HTMLButtonElement | null)?.removeAttribute("disabled");
      break;

    case "meshHealResult":
      if (msg.requestId !== meshHealRequestId) break; // stale — a newer check/load superseded it
      meshHealthPanel.render(msg.report);
      break;

    case "meshHealError":
      if (msg.requestId !== meshHealRequestId) break;
      meshHealthPanel.renderMessage(msg.message, true);
      break;

    case "fitRegionResult":
      if (msg.requestId !== regionFitRequestId) break;
      lastRegionFit = msg.fit;
      regionFitPanel.render(msg.fit);
      break;

    case "fitRegionError":
      if (msg.requestId !== regionFitRequestId) break;
      regionFitPanel.renderMessage(msg.message, true);
      break;

    case "opPreviewResult":
      handleOpPreviewResult(msg);
      break;

    case "opPreviewError": {
      const gen = pendingOpPreviewGeneration.get(msg.requestId);
      pendingOpPreviewGeneration.delete(msg.requestId);
      if (gen === undefined || !opPreviewScheduler.isCurrent(gen)) break; // stale
      viewer.setOpPreview(null);
      setStatus(`Preview unavailable: ${msg.message}`, true);
      break;
    }

    case "colorFieldResult": {
      if (msg.requestId !== colorFieldRequestId) break; // stale — a newer selection/Clear/edit superseded it
      const positions = pristineMeshPositions();
      if (!positions) break; // model was replaced/cleared while the request was in flight
      viewer.setColorFieldOverlay(buildColorFieldOverlay(positions, msg.values, msg.min, msg.max));
      const legend = document.getElementById("vc-colorfield-legend");
      const gradient = document.getElementById("vc-colorfield-gradient");
      const minEl = document.getElementById("vc-colorfield-min");
      const maxEl = document.getElementById("vc-colorfield-max");
      if (gradient) gradient.style.background = `linear-gradient(to right, ${viridisCssGradientStops()})`;
      // Plain formatting, no length-unit suffix/conversion — a scalar field
      // (temperature, stress, …) has no length dimension, unlike Measurement's
      // own `formatMeasureLength`.
      if (minEl) minEl.textContent = formatMeasure(msg.min);
      if (maxEl) maxEl.textContent = formatMeasure(msg.max);
      if (legend) legend.hidden = false;
      break;
    }

    case "colorFieldError": {
      if (msg.requestId !== colorFieldRequestId) break;
      // Clear the overlay and legend, not just the <select>. Previously this
      // only reset the dropdown, so after a failed pick the viewport kept
      // showing the PREVIOUS field's colours and its legend range while the
      // dropdown read "None" — the colours on screen no longer corresponded to
      // anything selected, which is worse than showing nothing.
      resetColorFieldSelection();
      setStatus(msg.message, true);
      break;
    }

    case "linkedCamera":
      if (hasAppliedInitialView) applyLinkedCamera(msg.camera);
      break;

    case "camerasLinked":
      document.getElementById("link-cameras")?.setAttribute("aria-checked", String(msg.enabled));
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
 * format for a meshio-imported document, not always `"STL"`). `regionInfo`
 * is only ever passed by the `"loadMeshBytes"` path (see `importedRegionInfo`'s
 * doc comment); explicitly `null` for `"loadUrl"` so a meshio import followed
 * by opening a plain native file in the same session can't leak stale region
 * data into unrelated geometry.
 */
async function loadMeshObjectFromUrl(
  url: string,
  loaderFormat: CadFormat,
  treeLabel: string,
  regionInfo: { triangleRegion: Int32Array } | null = null
): Promise<void> {
  try {
    setStatus("Loading model…");
    setDisplayUnit("mm"); // mesh sources carry no unit metadata
    lastRawMassProperties = null; // stale — refers to the just-replaced model
    clearMarkupOverlay?.();
    importedRegionInfo = regionInfo;
    // Reset here (not just on an edit) so a native mesh open — which never
    // sends `meshioMetadata` — doesn't leave a stale field list/selection
    // from a hypothetically earlier load; `case "loadMeshBytes"` immediately
    // repopulates this via `applyAvailableColorFields` when applicable.
    resetColorFieldSelection();
    applyAvailableColorFields(undefined);
    const object = await loadMeshFromUrl(url, loaderFormat);
    tagMeshEntities(object);
    // Build the Components tree from the original hierarchy (before the mesh
    // is split into facets, so the tree lists whole objects, not facets).
    const root = extractObjectTree(object, treeLabel);
    // Cache the pristine object; the displayed model is rebuilt from it with
    // the current edits applied (no-op when there are none).
    pristineMesh = object;
    rebuildMeshModel({ autoFit: false });
    // Meshes have facet "surfaces" and whole-object "volumes", but no edges.
    setSelectableModes(["volume", "surface"]);
    editsPanel.setBRepOnly(false); // fillet/chamfer need exact topology (B-rep)
    sourceKind = "mesh";
    lastMeasurement = null; // stale entity ids — refer to the just-replaced model; also hides #measure-exact-btn (mesh sources can't use it)
    refreshExactButton();
    refreshPinButton();
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
