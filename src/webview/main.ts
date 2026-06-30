import * as THREE from "three";
import { Viewer } from "./viewer";
import { loadMeshFromUrl } from "./meshLoaders";
import { exportModel } from "./meshExporters";
import { buildGroupFromEncoded } from "./geometryBuilder";
import { TreePanel } from "./treePanel";
import { PartsModel } from "./partsModel";
import { PartsPanel } from "./partsPanel";
import { SelectionSet, type SelectedEntity } from "./selection";
import type { HostToWebview, WebviewToHost, TreeNode, EntityType } from "../protocol";

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

window.addEventListener("unload", () => {
  viewer.dispose();
});

window.addEventListener("message", async (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case "geometry":
      try {
        setStatus("Building geometry…");
        const group = buildGroupFromEncoded(msg.meshes, msg.edges);
        viewer.setModel(group);
        refreshColors();
        setSelectableModes(["volume", "surface", "line"]);
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

    case "loadUrl":
      try {
        setStatus("Loading model…");
        const object = await loadMeshFromUrl(msg.url, msg.format);
        tagMeshEntities(object);
        viewer.setModel(object);
        refreshColors();
        // Mesh formats have no face/edge topology — only whole-object volumes.
        setSelectableModes(["volume"]);
        showSidebar();
        setStatus("");
        // Build tree from the loaded Object3D hierarchy.
        const root = extractObjectTree(object, msg.format.toUpperCase());
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
  }
});

/**
 * Tags a Three.js-loaded model with STABLE ids (traversal order, not uuid) so
 * part assignments round-trip across reopen. Each `THREE.Mesh` becomes a
 * pickable whole-object "volume" entity; the id doubles as `groupId` so the
 * Components tree highlight keeps working.
 */
function tagMeshEntities(obj: THREE.Object3D): void {
  let i = 0;
  obj.traverse((o) => {
    const id = `node-${i++}`;
    o.userData.groupId = id;
    if (o instanceof THREE.Mesh) {
      o.userData.entityType = "surface";
      o.userData.entityId = id;
    }
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
