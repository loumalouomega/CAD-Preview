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
import { MeshingModel } from "./meshingModel";
import { MeshingPanel } from "./meshingPanel";
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
  // Fired on every parts mutation: persist, recolour, re-render.
  post({ type: "partsChanged", parts: partsModel.list() });
  refreshColors();
  partsPanel.render(partsModel.list());
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
  onRemoveEntity: (index, type, id) => partsModel.removeEntity(index, type, id),
  onSelectPart: (index) => {
    previewPartIndex = index;
    renderHighlight();
  },
});

// ── Edits (replayable op-stack) ───────────────────────────────────────────
// The webview owns the op-stack; the host persists it and (for B-rep) re-applies
// it via OCCT. Mesh edits are replayed locally by rebuilding from the pristine
// loaded object (see rebuildMeshModel).
const editsModel = new EditsModel(() => {
  post({ type: "editsChanged", ops: editsModel.list() });
  editsPanel.render(editsModel.list(), editsModel.canUndo, editsModel.canRedo);
  if (pristineMesh) rebuildMeshModel();
});

/** Captured boolean operand A (volume ids); operand B is the live selection. */
let booleanA: string[] = [];
const selectedVolumes = (): string[] =>
  selection.list().filter((e) => e.entityType === "volume").map((e) => e.entityId);

const editsPanel = new EditsPanel(document.getElementById("edits-panel")!, {
  onUndo: () => editsModel.undo(),
  onRedo: () => editsModel.redo(),
  onClear: () => editsModel.clear(),
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
  onApplyFillet: (kind, amount) => {
    // Fillet/chamfer act on selected edges (Line mode), B-rep only.
    const edges = selection.list().filter((e) => e.entityType === "line").map((e) => e.entityId);
    if (edges.length === 0) {
      setStatus("Select one or more edges (Line mode) before applying a fillet/chamfer.", true);
      return;
    }
    if (amount <= 0) { setStatus("Enter a positive radius / setback.", true); return; }
    editsModel.push(
      kind === "fillet" ? { op: "fillet", edges, radius: amount } : { op: "chamfer", edges, distance: amount }
    );
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
    editsModel.push(op);
    setStatus("");
  },
  onApplyExplode: (factor) => {
    editsModel.push({ op: "explode", factor });
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
    }
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
    }
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
    }
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
  onGenerate: async () => {
    meshingPanel.setBusy(true);
    post({ type: "meshingGenerate", options: meshingModel.get(), stl: await currentStlIfMeshSource() });
  },
  onExportMsh: async () => {
    post({ type: "meshingExport", target: "msh", options: meshingModel.get(), stl: await currentStlIfMeshSource() });
  },
  onExportGeo: async () => {
    post({
      type: "meshingExport",
      target: "geoUnrolled",
      options: meshingModel.get(),
      stl: await currentStlIfMeshSource(),
    });
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

/** Rebuilds the displayed mesh model: clone pristine → apply ops → facet-split. */
function rebuildMeshModel(): void {
  if (!pristineMesh) return;
  const edited = applyEditsMesh(pristineMesh.clone(), editsModel.list());
  const model = splitMeshesIntoFacets(edited);
  viewer.setModel(model);
  refreshColors();
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
      showSidebar();
      break;

    case "edits":
      // Hydrate the op-stack from the sidecar (does not echo back as a write).
      editsModel.load(msg.ops);
      editsPanel.render(editsModel.list(), editsModel.canUndo, editsModel.canRedo);
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
      meshingPanel.render(meshingModel.get());
      break;

    case "meshingResult":
      meshingPanel.setBusy(false);
      viewer.setMeshOverlay(buildFEMesh(msg.positions, msg.indices));
      // A successful generate always results in a visible overlay, so bring the
      // toggle's state in sync here (rather than optimistically in `onGenerate`,
      // before the async round-trip even completes) — that way a failed generate
      // never leaves the toggle falsely claiming "on" for content that was never
      // displayed (see `meshingError` below, which deliberately leaves state alone).
      meshingEnabled = true;
      meshingToggle?.classList.add("active");
      meshingPanel.render(meshingModel.get(), { nodeCount: msg.nodeCount, elementCount: msg.elementCount });
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
