import { Viewer } from "./viewer";
import { loadMeshFromUrl } from "./meshLoaders";
import type { HostToWebview, WebviewToHost } from "../protocol";

declare function acquireVsCodeApi(): { postMessage(msg: WebviewToHost): void };

const vscode = acquireVsCodeApi();
const post = (msg: WebviewToHost) => vscode.postMessage(msg);

const app = document.getElementById("app")!;
const statusEl = document.getElementById("status")!;
const viewer = new Viewer(app);

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.style.display = text ? "block" : "none";
  statusEl.classList.toggle("error", isError);
}

document.getElementById("fit")?.addEventListener("click", () => viewer.fitView());
document.getElementById("grid")?.addEventListener("click", () => viewer.toggleGrid());
let wireframe = false;
document.getElementById("wireframe")?.addEventListener("click", () => {
  wireframe = !wireframe;
  viewer.setWireframe(wireframe);
});

window.addEventListener("message", async (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case "loadUrl":
      try {
        setStatus("Loading model…");
        const object = await loadMeshFromUrl(msg.url, msg.format);
        viewer.setModel(object);
        setStatus("");
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

post({ type: "ready" });
