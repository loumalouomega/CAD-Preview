import * as THREE from "three";
import { Viewer } from "./viewer";
import { loadMeshFromUrl } from "./meshLoaders";
import { buildGroupFromEncoded } from "./geometryBuilder";
import { TreePanel } from "./treePanel";
import type { HostToWebview, WebviewToHost, TreeNode } from "../protocol";

declare function acquireVsCodeApi(): { postMessage(msg: WebviewToHost): void };

const vscode = acquireVsCodeApi();
const post = (msg: WebviewToHost) => vscode.postMessage(msg);

const app = document.getElementById("app")!;
const statusEl = document.getElementById("status")!;
const panelEl = document.getElementById("tree-panel")!;
const toggleBtn = document.getElementById("tree-toggle") as HTMLButtonElement;

const viewer = new Viewer(app);
const treePanel = new TreePanel(panelEl, (id) => {
  viewer.highlightGroup(id);
});

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.style.display = text ? "block" : "none";
  statusEl.classList.toggle("error", isError);
}

function showTree(root: TreeNode): void {
  treePanel.render(root);
  toggleBtn.style.display = "";
  // Notify the renderer that #app may have resized.
  window.dispatchEvent(new Event("resize"));
}

document.getElementById("fit")?.addEventListener("click", () => viewer.fitView());
document.getElementById("grid")?.addEventListener("click", () => viewer.toggleGrid());
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

window.addEventListener("message", async (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case "geometry":
      try {
        setStatus("Building geometry…");
        const group = buildGroupFromEncoded(msg.meshes);
        viewer.setModel(group);
        setStatus("");
      } catch (err) {
        setStatus(`Failed to build geometry: ${(err as Error).message}`, true);
      }
      break;

    case "tree":
      showTree(msg.root);
      break;

    case "loadUrl":
      try {
        setStatus("Loading model…");
        const object = await loadMeshFromUrl(msg.url, msg.format);
        tagGroupIds(object);
        viewer.setModel(object);
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
  }
});

/** Tag each Object3D with its uuid as groupId so highlightGroup works. */
function tagGroupIds(obj: THREE.Object3D): void {
  obj.userData.groupId = obj.uuid;
  for (const child of obj.children) tagGroupIds(child);
}

/** Build a TreeNode from an Object3D hierarchy (for Three.js-loaded formats). */
function extractObjectTree(obj: THREE.Object3D, rootLabel: string): TreeNode {
  function toNode(o: THREE.Object3D): TreeNode {
    const label = o.name || (o instanceof THREE.Mesh ? "Mesh" : "Group");
    const children = o.children
      .filter((c) => c instanceof THREE.Mesh || c instanceof THREE.Group)
      .map(toNode);
    return { id: o.uuid, label, children: children.length > 0 ? children : undefined };
  }
  return { id: "root", label: rootLabel, children: obj.children.map(toNode) };
}

function hasMultipleNodes(root: TreeNode): boolean {
  return (root.children?.length ?? 0) > 0;
}

post({ type: "ready" });
