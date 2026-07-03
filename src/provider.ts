import * as vscode from "vscode";
import { routeFile } from "./fileRouter";
import { loadBRep, exportBRep } from "./occtService";
import { encodeBuffer, type HostToWebview, type WebviewToHost, type Part } from "./protocol";
import type { CadFormat, FileRoute } from "./fileRouter";
import { exportTargetsFor, EXPORT_EXTENSION, EXPORT_LABEL } from "./exportTargets";
import { readParts, writeParts } from "./partsStore";
import { readEdits, writeEdits } from "./editsStore";
import type { EditOp } from "./editOps";
import { readMeshOptions, writeMeshOptions, writeGeoScript } from "./meshOptionsStore";
import { generateMesh, exportGeoUnrolled, exportMeshFormat, exportMdpa, type MeshGenerationInput } from "./gmshService";
import { meshExportFormat } from "./meshExportFormats";
import { applyStlPartSizeOverride } from "./meshOptions";
import type { MeshOptions } from "./meshOptions";

/** Debounce window for autosaving the parts/edits/mesh-options sidecars after changes. */
const PARTS_SAVE_DEBOUNCE_MS = 500;

const BREP_FORMATS: ReadonlySet<CadFormat> = new Set(["step", "iges", "brep"]);

interface PendingExport {
  resolve: (result: { data: string; binary: boolean }) => void;
  reject: (err: Error) => void;
}

/** Read-only custom document: previews hold no editable state beyond their URI. */
class CadDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {
    /* no resources to release */
  }
}

/**
 * Renders supported CAD/mesh files in a Three.js webview.
 *
 * For mesh formats the file is exposed to the webview via `asWebviewUri` and parsed
 * there by a native Three.js loader. (B-rep formats will be tessellated in the host
 * and sent as geometry buffers in a later milestone.)
 */
export class CadPreviewProvider implements vscode.CustomReadonlyEditorProvider<CadDocument> {
  public static readonly viewType = "cad-preview.mesh";

  constructor(private readonly context: vscode.ExtensionContext) {}

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      CadPreviewProvider.viewType,
      new CadPreviewProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  openCustomDocument(uri: vscode.Uri): CadDocument {
    return new CadDocument(uri);
  }

  async resolveCustomEditor(
    document: CadDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const route = routeFile(document.uri.fsPath);

    const fileDir = vscode.Uri.joinPath(document.uri, "..");
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri, fileDir],
    };

    const post = (msg: HostToWebview) => webviewPanel.webview.postMessage(msg);
    const pending = new Map<string, PendingExport>();
    let partsSaveTimer: ReturnType<typeof setTimeout> | undefined;
    let editsSaveTimer: ReturnType<typeof setTimeout> | undefined;
    let meshSaveTimer: ReturnType<typeof setTimeout> | undefined;

    // The live edit op-list. Loaded from the sidecar on `ready`, updated on every
    // `editsChanged`. Threaded into the B-rep load + export so the view and Export
    // both reflect the edits. The source CAD file is never modified.
    let currentEdits: EditOp[] = [];

    /** (Re)tessellates a B-rep source with the current edits, or (re)loads a mesh. */
    const loadModel = () => {
      if (!route) return;
      if (route.strategy === "three") {
        const url = webviewPanel.webview.asWebviewUri(document.uri).toString();
        post({ type: "loadUrl", url, format: route.format });
      } else {
        void this.handleBRep(
          document.uri,
          route.format as Extract<CadFormat, "step" | "iges" | "brep">,
          post,
          currentEdits
        );
      }
    };

    webviewPanel.webview.onDidReceiveMessage(async (msg: WebviewToHost) => {
      if (msg.type === "ready") {
        if (!route) {
          post({ type: "error", message: `Unsupported file type: ${document.uri.fsPath}` });
          return;
        }
        // Load edits before the model so a B-rep source is tessellated already-edited.
        currentEdits = await readEdits(document.uri);
        loadModel();
        post({ type: "edits", ops: currentEdits });
        void this.sendParts(document.uri, post);
        void this.sendMeshOptions(document.uri, post);
        return;
      }

      if (msg.type === "partsChanged") {
        // Debounced autosave; the CAD file itself is never written, only the sidecar.
        const parts: Part[] = msg.parts;
        if (partsSaveTimer) clearTimeout(partsSaveTimer);
        partsSaveTimer = setTimeout(() => {
          void writeParts(document.uri, parts).then(
            undefined,
            (err) => post({ type: "error", message: `Could not save parts: ${(err as Error).message}` })
          );
        }, PARTS_SAVE_DEBOUNCE_MS);
        return;
      }

      if (msg.type === "editsChanged") {
        currentEdits = msg.ops;
        // Debounced sidecar autosave (separate timer/file from parts).
        if (editsSaveTimer) clearTimeout(editsSaveTimer);
        editsSaveTimer = setTimeout(() => {
          void writeEdits(document.uri, currentEdits).then(
            undefined,
            (err) => post({ type: "error", message: `Could not save edits: ${(err as Error).message}` })
          );
        }, PARTS_SAVE_DEBOUNCE_MS);
        // B-rep edits are applied in the host, so re-tessellate immediately. Mesh
        // edits are applied in the webview itself, which already updated the view.
        if (route && route.strategy === "occt") loadModel();
        return;
      }

      if (msg.type === "meshingChanged") {
        const options = msg.options;
        // Debounced sidecar autosave (separate timer/files from parts and edits).
        if (meshSaveTimer) clearTimeout(meshSaveTimer);
        meshSaveTimer = setTimeout(() => {
          void Promise.all([writeMeshOptions(document.uri, options), writeGeoScript(document.uri, options)]).then(
            undefined,
            (err) => post({ type: "error", message: `Could not save mesh options: ${(err as Error).message}` })
          );
        }, PARTS_SAVE_DEBOUNCE_MS);
        return;
      }

      if (msg.type === "meshingGenerate") {
        try {
          const input = await this.resolveMeshInput(document.uri, route, currentEdits, msg.stl);
          if (!input) {
            post({ type: "meshingError", message: "No mesh geometry available: missing STL data." });
            return;
          }
          const { parts, options } = await this.resolveMeshPartsAndOptions(document.uri, input, msg.options);
          const startedAt = Date.now();
          const result = await generateMesh(this.context.extensionPath, input, options, parts);
          post({
            type: "meshingResult",
            positions: encodeBuffer(result.positions),
            indices: encodeBuffer(result.indices),
            elementGroups: result.elementGroups,
            nodeCount: result.nodeCount,
            elementCount: result.elementCount,
            elapsedMs: Date.now() - startedAt,
          });
        } catch (err) {
          post({ type: "meshingError", message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "meshingExport") {
        try {
          const input = await this.resolveMeshInput(document.uri, route, currentEdits, msg.stl);
          if (!input) {
            post({ type: "meshingError", message: "No mesh geometry available: missing STL data." });
            return;
          }
          const { parts, options } = await this.resolveMeshPartsAndOptions(document.uri, input, msg.options);
          if (msg.target === "msh") {
            const result = await generateMesh(this.context.extensionPath, input, options, parts);
            await this.promptSaveAndWrite(
              document.uri,
              "msh",
              "GMSH Mesh",
              async () => Buffer.from(result.mshText, "utf8"),
              post
            );
          } else if (msg.target === "geoUnrolled") {
            const geo = await exportGeoUnrolled(this.context.extensionPath, input, options, parts);
            await this.promptSaveAndWrite(
              document.uri,
              "geo_unrolled",
              "GMSH Unrolled Geometry",
              async (saveUri) => {
                if (!geo.xao) return Buffer.from(geo.text, "utf8");
                // B-rep geometry can't be textually unrolled — gmsh.write() emitted a
                // `Merge "<memfs path>.xao";` stub. Write the real content (the XAO
                // companion) as a sibling of the saved file and fix the reference up
                // to a relative name so it actually resolves when reopened.
                const saveName = saveUri.path.slice(saveUri.path.lastIndexOf("/") + 1);
                const xaoName = `${saveName}.xao`;
                const xaoUri = vscode.Uri.joinPath(saveUri, "..", xaoName);
                await vscode.workspace.fs.writeFile(xaoUri, geo.xao);
                const fixedText = geo.text.replace(/Merge "[^"]*\.xao";/, `Merge "${xaoName}";`);
                return Buffer.from(fixedText, "utf8");
              },
              post
            );
          } else if (msg.target === "mdpaElements" || msg.target === "mdpaGeometries") {
            // Kratos MDPA is hand-serialized (no gmsh.write() support at all — see
            // exportMdpa's doc comment), unlike every other format below.
            const format = meshExportFormat(msg.target)!;
            const text = await exportMdpa(
              this.context.extensionPath,
              input,
              options,
              parts,
              msg.target === "mdpaElements" ? "elements" : "geometries"
            );
            await this.promptSaveAndWrite(
              document.uri,
              format.extension,
              format.filterLabel,
              async () => Buffer.from(text, "utf8"),
              post
            );
          } else {
            // Every other registered format (VTK/UNV/Abaqus/Nastran/SU2/etc.) — a
            // plain generate-then-write with no companion file, see `exportMeshFormat`.
            const format = meshExportFormat(msg.target);
            if (!format) throw new Error(`Unknown mesh export format: ${msg.target}`);
            const text = await exportMeshFormat(this.context.extensionPath, input, options, parts, msg.target);
            await this.promptSaveAndWrite(
              document.uri,
              format.extension,
              format.filterLabel,
              async () => Buffer.from(text, "utf8"),
              post
            );
          }
        } catch (err) {
          post({ type: "error", message: `Export failed: ${(err as Error).message}` });
        }
        return;
      }

      if (msg.type === "exportRequest") {
        if (route) this.handleExport(document.uri, route, post, pending, currentEdits);
        return;
      }

      if (msg.type === "exportResult" || msg.type === "exportError") {
        const p = pending.get(msg.requestId);
        if (!p) return;
        pending.delete(msg.requestId);
        if (msg.type === "exportResult") p.resolve(msg);
        else p.reject(new Error(msg.message));
      }
    });

    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);
  }

  private async handleBRep(
    uri: vscode.Uri,
    format: Extract<CadFormat, "step" | "iges" | "brep">,
    post: (msg: HostToWebview) => void,
    ops: EditOp[] = []
  ): Promise<void> {
    try {
      post({ type: "status", text: `Loading ${format.toUpperCase()} kernel…` });
      const bytes = await vscode.workspace.fs.readFile(uri);
      post({ type: "status", text: `Tessellating ${format.toUpperCase()}…` });
      const { groups, edges, points, tree } = await loadBRep(this.context.extensionPath, bytes, format, ops);
      post({
        type: "geometry",
        meshes: groups.flatMap((g) =>
          g.faces.map((f) => ({
            positions: encodeBuffer(f.buffers.positions),
            indices: encodeBuffer(f.buffers.indices),
            groupId: g.id,
            faceId: f.faceId,
          }))
        ),
        edges: edges.map((e) => ({
          positions: encodeBuffer(e.positions),
          edgeId: e.edgeId,
        })),
        points: points.map((p) => ({
          position: encodeBuffer(new Float32Array(p.position)),
          pointId: p.pointId,
        })),
      });
      post({ type: "tree", root: tree });
    } catch (err) {
      post({ type: "error", message: `${format.toUpperCase()} error: ${(err as Error).message}` });
    }
  }

  /** Loads the parts sidecar (if any) and sends it to the webview. */
  private async sendParts(uri: vscode.Uri, post: (msg: HostToWebview) => void): Promise<void> {
    try {
      const parts = await readParts(uri);
      post({ type: "parts", parts });
    } catch {
      post({ type: "parts", parts: [] });
    }
  }

  /** Loads the mesh-options sidecar (if any) and sends it to the webview. */
  private async sendMeshOptions(uri: vscode.Uri, post: (msg: HostToWebview) => void): Promise<void> {
    const options = await readMeshOptions(uri);
    post({ type: "meshingOptions", options });
  }

  /**
   * Resolves the geometry `generateMesh`/`exportGeoUnrolled` need, per the
   * document's route: B-rep sources are re-exported to STEP (via the existing
   * `exportBRep`, so live edits are reflected); mesh sources need the webview's
   * already-triangulated data, passed in as base64 `stl`. Returns `undefined`
   * when a mesh-format document has no `stl` payload — callers should treat
   * that as a graceful "nothing to mesh yet", not a thrown error.
   */
  private async resolveMeshInput(
    uri: vscode.Uri,
    route: FileRoute | undefined,
    ops: EditOp[],
    stl: string | undefined
  ): Promise<MeshGenerationInput | undefined> {
    if (route && route.strategy === "occt") {
      const sourceBytes = await vscode.workspace.fs.readFile(uri);
      const stepBytes = await exportBRep(
        this.context.extensionPath,
        sourceBytes,
        route.format as Extract<CadFormat, "step" | "iges" | "brep">,
        "step",
        ops
      );
      return { kind: "brep", stepBytes };
    }

    if (!stl) return undefined;
    return { kind: "stl", stlBytes: Buffer.from(stl, "base64") };
  }

  /**
   * Reads the parts sidecar and shapes it per `input`'s kind: B-rep sources
   * pass `parts` straight through to `generateMesh`/`exportGeoUnrolled` (which
   * turn them into physical groups + per-part sizing fields); STL/mesh
   * sources can't get true physical groups (see `gmshPartsMap.ts`), so `parts`
   * is dropped ([]) and `options` instead gets `applyStlPartSizeOverride`'s
   * one-off sizing degrade for just this call — never persisted back to the
   * `.mesh.json` sidecar.
   */
  private async resolveMeshPartsAndOptions(
    uri: vscode.Uri,
    input: MeshGenerationInput,
    options: MeshOptions
  ): Promise<{ parts: Part[]; options: MeshOptions }> {
    const parts = await readParts(uri);
    if (input.kind === "brep") return { parts, options };
    return { parts: [], options: applyStlPartSizeOverride(options, parts) };
  }

  /**
   * Prompts for a target format and destination, then writes the export. B-rep
   * targets are written directly via OCCT; mesh targets are serialized in the
   * webview (which already holds the triangulated Three.js model) and relayed back.
   */
  private async handleExport(
    uri: vscode.Uri,
    route: FileRoute,
    post: (msg: HostToWebview) => void,
    pending: Map<string, PendingExport>,
    ops: EditOp[] = []
  ): Promise<void> {
    const targets = exportTargetsFor(route);
    if (targets.length === 0) return;

    const picked = await vscode.window.showQuickPick(
      targets.map((format) => ({
        label: EXPORT_LABEL[format],
        description: `.${EXPORT_EXTENSION[format]}`,
        format,
      })),
      { placeHolder: "Export model as…" }
    );
    if (!picked) return;

    const targetFormat = picked.format;

    await this.promptSaveAndWrite(uri, EXPORT_EXTENSION[targetFormat], EXPORT_LABEL[targetFormat], async (_saveUri) => {
      if (BREP_FORMATS.has(targetFormat)) {
        const sourceBytes = await vscode.workspace.fs.readFile(uri);
        return exportBRep(
          this.context.extensionPath,
          sourceBytes,
          route.format as Extract<CadFormat, "step" | "iges" | "brep">,
          targetFormat as Extract<CadFormat, "step" | "iges" | "brep">,
          ops
        );
      }

      const requestId = `${Date.now()}-${Math.random()}`;
      const result = await new Promise<{ data: string; binary: boolean }>((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        post({ type: "exportMesh", requestId, format: targetFormat });
      });
      return result.binary ? Buffer.from(result.data, "base64") : Buffer.from(result.data, "utf8");
    }, post);
  }

  /**
   * Shared save-dialog + write flow used by `handleExport` and `meshingExport`:
   * computes a default filename beside the source (`<baseName>.<ext>`), prompts
   * `showSaveDialog`, invokes `getBytes(saveUri)` to produce the file's contents
   * (the chosen `saveUri` is passed through so a caller needing to write a
   * sibling companion file — e.g. the `.geo_unrolled` export's XAO companion —
   * can derive its name/location from it), writes it, and posts a
   * `status`/`error` message — so the caller doesn't have to duplicate the
   * dialog/write/error-post boilerplate.
   */
  private async promptSaveAndWrite(
    uri: vscode.Uri,
    ext: string,
    filterLabel: string,
    getBytes: (saveUri: vscode.Uri) => Promise<Uint8Array>,
    post: (msg: HostToWebview) => void
  ): Promise<void> {
    const baseName = uri.path.slice(uri.path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
    const defaultUri = vscode.Uri.joinPath(uri, "..", `${baseName}.${ext}`);

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { [filterLabel]: [ext] },
    });
    if (!saveUri) return;

    try {
      const bytes = await getBytes(saveUri);
      await vscode.workspace.fs.writeFile(saveUri, bytes);
      post({ type: "status", text: `Exported to ${saveUri.fsPath}` });
    } catch (err) {
      post({ type: "error", message: `Export failed: ${(err as Error).message}` });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const viewerUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "viewer.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "viewer.css")
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `connect-src ${webview.cspSource} blob: data:`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>CAD Preview</title>
</head>
<body>
  <div id="layout">
    <div id="side">
      <div id="tree-panel">
        <div id="tree-header">
          <span id="tree-title">Components</span>
          <button id="tree-close" title="Close panel">✕</button>
        </div>
        <div id="tree-body"></div>
      </div>
      <div id="parts-panel">
        <div id="parts-header">
          <span id="parts-title">Parts</span>
          <button id="parts-new" title="New part">＋ New</button>
        </div>
        <div id="parts-body"></div>
      </div>
      <div id="edits-panel">
        <div id="edits-header">
          <span id="edits-title">Edits</span>
          <div id="edits-actions">
            <button id="edits-undo" title="Undo last edit" disabled>↶</button>
            <button id="edits-redo" title="Redo edit" disabled>↷</button>
            <button id="edits-clear" title="Clear all edits" disabled>Clear</button>
          </div>
        </div>
        <div id="edits-scroll">
          <div id="edits-compose"></div>
          <div id="edits-body"></div>
        </div>
      </div>
      <div id="meshing-panel">
        <div id="meshing-header">
          <span id="meshing-title">FE Mesh</span>
          <div id="meshing-actions">
            <button id="meshing-generate" title="Generate mesh">▶ Generate</button>
            <select id="meshing-export-format" class="meshing-export-select" title="Export format"></select>
            <button id="meshing-export" title="Export mesh">📤 Export</button>
            <button id="meshing-clear" title="Clear generated mesh">Clear</button>
          </div>
        </div>
        <div id="meshing-progress"></div>
        <div id="meshing-body"></div>
        <div id="meshing-status"></div>
      </div>
    </div>
    <div id="app"></div>
  </div>
  <div id="toolbar">
    <button id="fit" title="Fit to view">🔍 Fit</button>
    <button id="wireframe" title="Toggle wireframe">🕸️ Wireframe</button>
    <button id="grid" title="Toggle grid">▦ Grid</button>
    <button id="export" title="Export model">📤 Export</button>
    <button id="tree-toggle" title="Toggle component tree" style="display:none">🌳 Tree</button>
    <button id="meshing-toggle" title="Toggle FE mesh overlay">🔬 FE Mesh</button>
    <div id="select-group" title="Pick entities in the view to assign to a part">
      <button id="sel-toggle" title="Toggle selection mode">🖱️ Select</button>
      <button class="sel-mode" data-mode="point" title="Pick points (vertices)">📍 Point</button>
      <button class="sel-mode" data-mode="volume" title="Pick volumes (solids)">🧊 Vol</button>
      <button class="sel-mode active" data-mode="surface" title="Pick surfaces (faces)">◼️ Surf</button>
      <button class="sel-mode" data-mode="line" title="Pick lines (edges)">📏 Line</button>
    </div>
  </div>
  <div id="view-controls">
    <button id="vc-toggle" class="vc-collapse" title="Hide controls" aria-label="Hide controls">⌄</button>
    <div id="vc-body">
    <div class="vc-group">
      <span class="vc-label">Rotate</span>
      <div class="vc-segments">
        <button class="seg-btn" data-step="15">15°</button>
        <button class="seg-btn active" data-step="45">45°</button>
        <button class="seg-btn" data-step="90">90°</button>
      </div>
      <div class="vc-cross">
        <button id="rot-up" class="vc-arrow" style="grid-area:up" title="Rotate up">↑</button>
        <button id="rot-left" class="vc-arrow" style="grid-area:left" title="Rotate left">←</button>
        <button id="rot-right" class="vc-arrow" style="grid-area:right" title="Rotate right">→</button>
        <button id="rot-down" class="vc-arrow" style="grid-area:down" title="Rotate down">↓</button>
      </div>
    </div>
    <div class="vc-group">
      <span class="vc-label">Pan</span>
      <div class="vc-cross">
        <button id="pan-up" class="vc-arrow" style="grid-area:up" title="Pan up">↑</button>
        <button id="pan-left" class="vc-arrow" style="grid-area:left" title="Pan left">←</button>
        <button id="pan-right" class="vc-arrow" style="grid-area:right" title="Pan right">→</button>
        <button id="pan-down" class="vc-arrow" style="grid-area:down" title="Pan down">↓</button>
      </div>
    </div>
    <div class="vc-group">
      <span class="vc-label">Zoom</span>
      <div class="vc-row">
        <button id="zoom-in" class="vc-arrow" title="Zoom in">+</button>
        <button id="zoom-out" class="vc-arrow" title="Zoom out">−</button>
      </div>
    </div>
    <div class="vc-group">
      <span class="vc-label">View</span>
      <div class="vc-row">
        <button id="view-fit" title="Fit to view">Fit</button>
        <button id="view-reset" title="Reset to default view">Ctr</button>
      </div>
    </div>
    </div>
  </div>
  <div id="status">Loading…</div>
  <script nonce="${nonce}" src="${viewerUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
