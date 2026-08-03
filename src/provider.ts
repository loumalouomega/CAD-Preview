import * as vscode from "vscode";
import { routeFile } from "./fileRouter";
import { loadBRepCached, disposeBRepCache, exportBRep, type BRepCacheEntry } from "./occtService";
import { normalizeTessellationQuality, tessellationParamsFor } from "./tessellationQuality";
import { detectStepLengthUnit } from "./stepUnits";
import { detectIgesLengthUnit } from "./igesUnits";
import { convertToStlBoundaryWithRegions, exportViaMeshio, readMeshioMetadata, readMeshioFieldValues } from "./meshioService";
import { buildPartsFromMeshioRegions } from "./meshioRegionParts";
import { encodeBuffer, type HostToWebview, type WebviewToHost, type Part, type ViewState } from "./protocol";
import type { CadFormat, FileRoute } from "./fileRouter";
import { exportTargetsFor, EXPORT_EXTENSION, EXPORT_LABEL, UNIT_CONVERTIBLE_FORMATS } from "./exportTargets";
import { readParts, writeParts, sidecarUri } from "./partsStore";
import { readEdits, writeEdits, editsSidecarUri } from "./editsStore";
import type { EditOp } from "./editOps";
import type { ParamVariable } from "./editVariables";
import { readMeshOptions, writeMeshOptions, writeGeoScript, meshOptionsSidecarUri, geoScriptUri } from "./meshOptionsStore";
import { readViewState, writeViewState, viewStateSidecarUri } from "./viewStateStore";
import { generateMesh, exportGeoUnrolled, exportMeshFormat, exportMdpa, type MeshGenerationInput } from "./gmshService";
import { meshExportFormat } from "./meshExportFormats";
import { applyStlPartSizeOverride, scaleMeshOptionsForUnit, scalePartsMeshSizeForUnit } from "./meshOptions";
import type { MeshOptions } from "./meshOptions";
import { viewerBodyHtml } from "./viewerDom";
import { normalizeViewerDefaults } from "./viewerDefaults";
import { computeMassProperties } from "./massProperties";
import { measureExact, rebindPartsAcrossOps } from "./entityFacts";
import { buildPreprocessZip, readPreprocessZip } from "./preprocessArchive";
import { parsePartsJson } from "./partsSidecar";
import { parseEditsJson } from "./editsSidecar";
import { parseMeshJson } from "./meshOptionsSidecar";
import { DISPLAY_UNITS, UNIT_LABELS, unitScaleFactor, type DisplayUnit } from "./lengthUnits";
import { scaleStlBytes } from "./stlParser";
import { getNonce } from "./nonce";
import { showLatestWhatsNew } from "./whatsNew";
import { runCompareModelsCommand } from "./modelComparePanel";

/** Debounce window for autosaving the parts/edits/mesh-options sidecars after changes. */
const PARTS_SAVE_DEBOUNCE_MS = 500;
/** Settle window for the external-change file watchers below — short enough
 * to reconcile promptly, long enough to avoid reading a file mid-write by
 * another process. */
const EXTERNAL_CHANGE_DEBOUNCE_MS = 300;

const BREP_FORMATS: ReadonlySet<CadFormat> = new Set(["step", "iges", "brep"]);

interface PendingExport {
  resolve: (result: { data: string; binary: boolean }) => void;
  reject: (err: Error) => void;
}

/**
 * Handle to the currently-focused CAD-Preview editor, so the VS Code
 * commands/keybindings (which carry no per-document context) can drive the
 * same actions as the in-webview File menu.
 */
interface EditorSession {
  readonly uri: vscode.Uri;
  /** Export the model (quick-pick + save dialog) — shared by Save As and Export. */
  export(): void;
  /** Immediately flush the parts/edits/mesh sidecars (bypassing the debounce). */
  save(): Promise<void>;
  /** Flushes sidecars, then packages the source + whichever sidecars exist into a `.zip`. */
  savePreprocess(): void;
  /** Save the current 3D view as a PNG (save dialog). */
  screenshot(): void;
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

  /** The focused editor, tracked so commands/keybindings can reach it. */
  private activeSession?: EditorSession;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new CadPreviewProvider(context);
    const editorDisposable = vscode.window.registerCustomEditorProvider(
      CadPreviewProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
    return vscode.Disposable.from(editorDisposable, ...provider.registerCommands());
  }

  /**
   * Registers the File-menu commands. `open` and `whatsNew` are standalone
   * (host-only, no focused editor needed); the others delegate to whichever
   * editor is focused (`activeSession`) so the keybindings and Command
   * Palette entries mirror the in-webview File menu.
   */
  private registerCommands(): vscode.Disposable[] {
    const withSession = (fn: (s: EditorSession) => void) => () => {
      if (this.activeSession) fn(this.activeSession);
    };
    return [
      vscode.commands.registerCommand("cad-preview.open", () => void this.openFileDialog()),
      vscode.commands.registerCommand("cad-preview.save", withSession((s) => void s.save())),
      vscode.commands.registerCommand("cad-preview.saveAs", withSession((s) => s.export())),
      vscode.commands.registerCommand("cad-preview.export", withSession((s) => s.export())),
      vscode.commands.registerCommand("cad-preview.savePreprocess", withSession((s) => s.savePreprocess())),
      vscode.commands.registerCommand("cad-preview.loadPreprocess", () => void this.loadPreprocessDialog()),
      vscode.commands.registerCommand("cad-preview.whatsNew", () => void showLatestWhatsNew(this.context)),
      vscode.commands.registerCommand("cad-preview.screenshot", withSession((s) => s.screenshot())),
      vscode.commands.registerCommand("cad-preview.compareModels", () =>
        void runCompareModelsCommand(this.context, this.activeSession?.uri)
      ),
    ];
  }

  /** Shows an open dialog and hands the chosen file to this custom editor. */
  private async openFileDialog(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Open in CAD Preview",
      filters: {
        "CAD / Mesh": [
          "stl", "obj", "ply", "gltf", "glb", "step", "stp", "iges", "igs", "brep",
          "vtk", "vtu", "med", "cgns", "exo", "e", "xdmf", "mdpa",
        ],
      },
    });
    if (uris?.[0]) {
      await vscode.commands.executeCommand("vscode.openWith", uris[0], CadPreviewProvider.viewType);
    }
  }

  /** Opens a file dropped onto the viewer (drag-and-drop) at an already-known path. */
  private async openPathInEditor(path: string): Promise<void> {
    await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.file(path), CadPreviewProvider.viewType);
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
    let viewSaveTimer: ReturnType<typeof setTimeout> | undefined;
    // Live OCCT parse+replay cache for THIS document (roadmap "Base-shape
    // caching and incremental replay", closed) — see `loadBRepCached`'s doc
    // comment in `occtService.ts` for the reuse rules. Held as a plain
    // mutable holder (not a closure `let` `handleBRep` could reassign
    // directly, since `handleBRep` is a class method, not itself inside this
    // closure) so both `handleBRep` and this constructor's `onDidDispose`
    // below can reach the SAME, current entry.
    const brepCache: { current: BRepCacheEntry | undefined } = { current: undefined };

    // The live edit op-list + parametric variables. Loaded from the sidecar on
    // `ready`, updated on every `editsChanged`. Ops arrive from the webview
    // already resolved against the variables (resolve-on-read), so they are
    // threaded as-is into the B-rep load + export; the variables are only
    // persisted and echoed back. The source CAD file is never modified.
    let currentEdits: EditOp[] = [];
    let currentVariables: ParamVariable[] = [];
    // Latest parts / mesh options received from the webview, retained so the
    // File-menu "Save" can flush all three sidecars immediately. The webview
    // re-sends these on every change, so these copies are always current.
    let currentParts: Part[] = [];
    let currentMeshOptions: MeshOptions | undefined;
    // The last view state received from the webview (or read from the
    // sidecar), retained for the same "Save flushes everything" reason as
    // `currentMeshOptions` — `undefined` until the webview's first
    // `viewChanged` post (camera move, display-mode/ortho/clip change), so a
    // Save before any of those simply has nothing new to write for this one
    // sidecar, matching `currentMeshOptions`'s own convention.
    let currentViewState: ViewState | undefined;

    /** Immediately writes the parts/edits/mesh/view sidecars, bypassing the debounce. */
    const flushSidecars = async (): Promise<void> => {
      if (partsSaveTimer) clearTimeout(partsSaveTimer);
      if (editsSaveTimer) clearTimeout(editsSaveTimer);
      if (meshSaveTimer) clearTimeout(meshSaveTimer);
      if (viewSaveTimer) clearTimeout(viewSaveTimer);
      try {
        await Promise.all([
          writeParts(document.uri, currentParts),
          writeEdits(document.uri, currentEdits, currentVariables),
          ...(currentMeshOptions
            ? [writeMeshOptions(document.uri, currentMeshOptions), writeGeoScript(document.uri, currentMeshOptions)]
            : []),
          ...(currentViewState ? [writeViewState(document.uri, currentViewState)] : []),
        ]);
        post({ type: "status", text: "Saved" });
      } catch (err) {
        post({ type: "error", message: `Save failed: ${(err as Error).message}` });
      }
    };

    /** (Re)tessellates a B-rep source with the current edits, (re)loads a mesh, or (re)converts a meshio-only source. */
    const loadModel = () => {
      if (!route) return;
      if (route.strategy === "three") {
        const url = webviewPanel.webview.asWebviewUri(document.uri).toString();
        post({ type: "loadUrl", url, format: route.format });
      } else if (route.strategy === "meshio") {
        // handleMeshio owns the parts round trip for this route (it may
        // auto-create Parts from region data) — keep currentParts in sync so
        // an immediate Save (before any user edit) doesn't flush a stale `[]`
        // over what was just written; see its doc comment.
        void this.handleMeshio(document.uri, route.format, post).then((parts) => {
          currentParts = parts;
        });
      } else {
        void this.handleBRep(
          document.uri,
          route.format as Extract<CadFormat, "step" | "iges" | "brep">,
          post,
          currentEdits,
          brepCache
        );
      }
    };

    /**
     * Best-effort entity-id rebinding after ANY op-stack change — append,
     * `remove(index)`, undo, redo, or Clear (roadmap "Extend entity-id
     * rebinding to `remove_edit_op` (and undo/redo)", closed; previously
     * append-only — see `entityFacts.ts`'s `rebindPartsAcrossOps` for the
     * general unwind/rewind algorithm this now delegates the whole
     * `previousOps -> newOps` diff to, rather than pre-filtering to an
     * appended suffix here). No cheap "does the diff even contain a
     * topology-changing op" pre-check is needed here before calling in: the
     * OCCT WASM singleton is memoized (a repeat `getOcct()` call is
     * essentially free), and `rebindPartsAcrossOps` itself bails before any
     * real replay work when the two op lists are identical or a given step
     * turns out non-topology-changing — this wrapper only needs to skip the
     * obviously-pointless cases (no route, no Parts, or truly no change at
     * all). Persists the parts sidecar immediately (not debounced — this is
     * host-initiated and correctness-critical, unlike the user-typed
     * `partsChanged` autosave) and posts a fresh `"parts"` message so the
     * webview's `PartsModel.load()` (silent, no `onChange` echo — same
     * contract `"edits"`'s hydration already relies on) picks up the new ids
     * and `refreshColors()` recolours, exactly like the initial `ready`
     * hydration's own `"parts"` message.
     */
    const rebindPartsOnChange = async (previousOps: EditOp[], newOps: EditOp[]): Promise<void> => {
      if (!route || route.strategy !== "occt") return;
      if (currentParts.length === 0) return;
      if (JSON.stringify(previousOps) === JSON.stringify(newOps)) return;
      try {
        const bytes = await vscode.workspace.fs.readFile(document.uri);
        const result = await rebindPartsAcrossOps(
          this.context.extensionPath,
          bytes,
          route.format as Extract<CadFormat, "step" | "iges" | "brep">,
          previousOps,
          newOps,
          currentParts
        );
        if (result.parts === currentParts) return; // nothing topology-changing resolved, or nothing to remap
        currentParts = result.parts;
        await writeParts(document.uri, currentParts);
        post({ type: "parts", parts: currentParts });
      } catch (err) {
        post({ type: "error", message: `Could not rebind part entity ids: ${(err as Error).message}` });
      }
    };

    /**
     * External-change reconciliation (roadmap "Sidecar and source
     * external-change reconciliation", closed). Without this, an MCP agent's
     * `apply_edit_ops`/`set_part`/`set_mesh_options` write to a sidecar while
     * this SAME document is ALSO open interactively is silently overwritten
     * by the next debounced webview autosave — there are no file watchers
     * anywhere else in this codebase, and `.edits.json`/`.parts.json`/
     * `.mesh.json` are otherwise only ever read once, in the `ready` handler
     * above. Same gap for the source CAD file itself (a
     * `download_standard_part` overwrite, a `git checkout`, an external
     * editor save).
     *
     * Content-comparison, not raw-event suppression: this extension's own
     * debounced writes ALSO fire these watchers, but by the time a write
     * lands on disk the in-memory `current*` state already equals what was
     * written, so the comparison below finds no difference and no-ops — this
     * is what makes the design safe against feedback loops with no "was this
     * my own write" flag/timestamp bookkeeping (and, transitively, safe
     * against `handleMeshio`'s and `rebindPartsOnChange`'s own occasional
     * `.parts.json` writes triggering a redundant-but-harmless reaction here
     * too). The CAD source file is the one exception: this extension NEVER
     * writes it (the read-only invariant), so any change to it is
     * unconditionally external — no comparison needed, just reload.
     *
     * A short debounce per watched file (not the longer autosave one) avoids
     * reacting to a file mid-write by another process; `readEdits`/
     * `readParts`/`readMeshOptions` already tolerate a transiently-malformed
     * file by degrading to their existing defaults, same as on any other
     * read, so a read that races an in-progress write is never worse than
     * "reconcile again once the write finishes and the watcher fires again".
     */
    const watcherDisposables: vscode.Disposable[] = [];
    const watchForExternalChange = (uri: vscode.Uri, onSettled: () => void): void => {
      const basename = uri.path.slice(uri.path.lastIndexOf("/") + 1);
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(fileDir, basename));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const debounced = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(onSettled, EXTERNAL_CHANGE_DEBOUNCE_MS);
      };
      watcher.onDidChange(debounced);
      watcher.onDidCreate(debounced);
      watcherDisposables.push(watcher, { dispose: () => { if (timer) clearTimeout(timer); } });
    };

    watchForExternalChange(document.uri, () => {
      if (!route) return;
      post({ type: "status", text: "File changed on disk — reloading…" });
      loadModel();
    });

    watchForExternalChange(editsSidecarUri(document.uri), () => {
      void (async () => {
        const parsed = await readEdits(document.uri);
        if (JSON.stringify(parsed.ops) === JSON.stringify(currentEdits) && JSON.stringify(parsed.variables) === JSON.stringify(currentVariables)) {
          return;
        }
        const previousOps = currentEdits;
        currentEdits = parsed.ops;
        currentVariables = parsed.variables;
        if (route && route.strategy === "occt") {
          loadModel();
          void rebindPartsOnChange(previousOps, currentEdits);
        }
        post({ type: "edits", ops: currentEdits, variables: currentVariables });
        post({ type: "status", text: "Edits updated externally" });
      })();
    });

    watchForExternalChange(sidecarUri(document.uri), () => {
      void (async () => {
        const parts = await readParts(document.uri);
        if (JSON.stringify(parts) === JSON.stringify(currentParts)) return;
        currentParts = parts;
        post({ type: "parts", parts: currentParts });
        post({ type: "status", text: "Parts updated externally" });
      })();
    });

    watchForExternalChange(meshOptionsSidecarUri(document.uri), () => {
      void (async () => {
        const options = await readMeshOptions(document.uri);
        if (JSON.stringify(options) === JSON.stringify(currentMeshOptions)) return;
        currentMeshOptions = options;
        post({ type: "meshingOptions", options });
        post({ type: "status", text: "Mesh options updated externally" });
      })();
    });

    watchForExternalChange(viewStateSidecarUri(document.uri), () => {
      void (async () => {
        const view = await readViewState(document.uri);
        if (JSON.stringify(view) === JSON.stringify(currentViewState ?? null)) return;
        currentViewState = view ?? undefined;
        post({ type: "viewState", view });
        post({ type: "status", text: "View updated externally" });
      })();
    });

    webviewPanel.onDidDispose(() => {
      for (const d of watcherDisposables) d.dispose();
      if (brepCache.current) disposeBRepCache(brepCache.current);
    });

    // Track this editor as the active one while it is focused, so the
    // File-menu commands/keybindings can reach it.
    const session: EditorSession = {
      uri: document.uri,
      export: () => {
        if (route) this.handleExport(document.uri, route, post, pending, currentEdits);
      },
      save: flushSidecars,
      savePreprocess: () => {
        void flushSidecars().then(() => this.handleSavePreprocess(document.uri, post));
      },
      screenshot: () => {
        void this.handleScreenshot(document.uri, post, pending);
      },
    };
    const track = () => {
      if (webviewPanel.active) this.activeSession = session;
    };
    track();
    webviewPanel.onDidChangeViewState(track);
    webviewPanel.onDidDispose(() => {
      if (this.activeSession === session) this.activeSession = undefined;
    });

    webviewPanel.webview.onDidReceiveMessage(async (msg: WebviewToHost) => {
      if (msg.type === "ready") {
        if (!route) {
          post({ type: "error", message: `Unsupported file type: ${document.uri.fsPath}` });
          return;
        }
        // Load edits before the model so a B-rep source is tessellated already-edited.
        const parsed = await readEdits(document.uri);
        currentEdits = parsed.ops;
        currentVariables = parsed.variables;
        loadModel();
        post({ type: "edits", ops: currentEdits, variables: currentVariables });
        // The meshio route's own handleMeshio() (above) owns the parts round
        // trip for that route instead (it may need to auto-create Parts from
        // region data first) — calling both would double-post "parts".
        if (!route || route.strategy !== "meshio") {
          void this.sendParts(document.uri, post).then((parts) => {
            currentParts = parts;
          });
        }
        void this.sendMeshOptions(document.uri, post).then((options) => {
          currentMeshOptions = options;
        });
        void readViewState(document.uri).then((view) => {
          currentViewState = view ?? undefined;
          post({ type: "viewState", view });
        });
        this.sendViewerDefaults(post);
        return;
      }

      if (msg.type === "partsChanged") {
        // Debounced autosave; the CAD file itself is never written, only the sidecar.
        const parts: Part[] = msg.parts;
        currentParts = parts;
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
        const previousOps = currentEdits;
        currentEdits = msg.ops;
        currentVariables = msg.variables;
        // Debounced sidecar autosave (separate timer/file from parts).
        if (editsSaveTimer) clearTimeout(editsSaveTimer);
        editsSaveTimer = setTimeout(() => {
          void writeEdits(document.uri, currentEdits, currentVariables).then(
            undefined,
            (err) => post({ type: "error", message: `Could not save edits: ${(err as Error).message}` })
          );
        }, PARTS_SAVE_DEBOUNCE_MS);
        // B-rep edits are applied in the host, so re-tessellate immediately. Mesh
        // edits are applied in the webview itself, which already updated the view.
        if (route && route.strategy === "occt") {
          loadModel();
          void rebindPartsOnChange(previousOps, currentEdits);
        }
        return;
      }

      if (msg.type === "viewChanged") {
        currentViewState = msg.view;
        // Debounced sidecar autosave (separate timer/file from parts/edits/mesh).
        if (viewSaveTimer) clearTimeout(viewSaveTimer);
        viewSaveTimer = setTimeout(() => {
          void writeViewState(document.uri, msg.view).then(
            undefined,
            (err) => post({ type: "error", message: `Could not save view state: ${(err as Error).message}` })
          );
        }, PARTS_SAVE_DEBOUNCE_MS);
        return;
      }

      if (msg.type === "meshingChanged") {
        const options = msg.options;
        currentMeshOptions = options;
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
            edges: encodeBuffer(result.edges),
            elementGroups: result.elementGroups,
            nodeCount: result.nodeCount,
            elementCount: result.elementCount,
            elapsedMs: Date.now() - startedAt,
            quality: result.quality,
            worstElements: result.worstElements && {
              indices: encodeBuffer(result.worstElements.indices),
              threshold: result.worstElements.threshold,
              shownCount: result.worstElements.shownCount,
              belowThresholdCount: result.worstElements.belowThresholdCount,
            },
          });
        } catch (err) {
          post({ type: "meshingError", message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "meshingExport") {
        try {
          const unit = msg.unit ?? "mm";
          const input = await this.resolveMeshInput(document.uri, route, currentEdits, msg.stl, unit);
          if (!input) {
            post({ type: "meshingError", message: "No mesh geometry available: missing STL data." });
            return;
          }
          const { parts, options } = await this.resolveMeshPartsAndOptions(document.uri, input, msg.options, unit);
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
          } else if (msg.target === "med" || msg.target === "cgns" || msg.target === "xdmf") {
            // meshio++ bridge — Gmsh's own writers can't produce these (no
            // CGNS/MED support in this build); re-encode via
            // `meshioService.ts`'s exportViaMeshio(), fed generateMesh()'s
            // own MSH 4.1 mshText directly (meshio++ 9.7.0 reads 4.1
            // natively, physical groups included — see exportViaMeshio's doc
            // comment; before 9.7.0 this needed a legacy MSH 2.2 detour).
            // See `meshExportFormats.ts`'s doc comment for the MED/CGNS caveats.
            const format = meshExportFormat(msg.target)!;
            const meshed = await generateMesh(this.context.extensionPath, input, options, parts);
            const { bytes, companion } = await exportViaMeshio(meshed.mshText, msg.target);
            await this.promptSaveAndWrite(
              document.uri,
              format.extension,
              format.filterLabel,
              async (saveUri) => {
                if (!companion) return Buffer.from(bytes);
                // xdmf's HDF5 companion — same "write beside the chosen save
                // path + rewrite the embedded reference" pattern geoUnrolled's
                // .xao companion uses just below.
                const saveName = saveUri.path.slice(saveUri.path.lastIndexOf("/") + 1);
                const h5Name = saveName.replace(/\.[^.]+$/, ".h5");
                const h5Uri = vscode.Uri.joinPath(saveUri, "..", h5Name);
                await vscode.workspace.fs.writeFile(h5Uri, companion.bytes);
                const fixedText = Buffer.from(bytes).toString("utf8").split(companion.name).join(h5Name);
                return Buffer.from(fixedText, "utf8");
              },
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

      if (msg.type === "openFile") {
        void this.openFileDialog();
        return;
      }

      if (msg.type === "openPath") {
        void this.openPathInEditor(msg.path);
        return;
      }

      if (msg.type === "saveSidecars") {
        void flushSidecars();
        return;
      }

      if (msg.type === "exportRequest") {
        if (route) this.handleExport(document.uri, route, post, pending, currentEdits);
        return;
      }

      if (msg.type === "savePreprocessRequest") {
        void flushSidecars().then(() => this.handleSavePreprocess(document.uri, post));
        return;
      }

      if (msg.type === "loadPreprocessRequest") {
        void this.loadPreprocessDialog();
        return;
      }

      if (msg.type === "exportResult" || msg.type === "exportError") {
        const p = pending.get(msg.requestId);
        if (!p) return;
        pending.delete(msg.requestId);
        if (msg.type === "exportResult") p.resolve(msg);
        else p.reject(new Error(msg.message));
        return;
      }

      if (msg.type === "screenshotButtonClicked") {
        void this.handleScreenshot(document.uri, post, pending);
        return;
      }

      if (msg.type === "screenshotResult" || msg.type === "screenshotError") {
        const p = pending.get(msg.requestId);
        if (!p) return;
        pending.delete(msg.requestId);
        if (msg.type === "screenshotResult") p.resolve({ data: msg.data, binary: true });
        else p.reject(new Error(msg.message));
        return;
      }

      if (msg.type === "massPropertiesRequest") {
        try {
          if (!route || route.strategy !== "occt") {
            throw new Error("Mass properties are computed for B-rep sources on the host; mesh sources compute this client-side.");
          }
          const bytes = await vscode.workspace.fs.readFile(document.uri);
          const properties = await computeMassProperties(
            this.context.extensionPath,
            bytes,
            route.format as Extract<CadFormat, "step" | "iges" | "brep">,
            currentEdits,
            msg.entityId
          );
          post({ type: "massPropertiesResult", requestId: msg.requestId, properties });
        } catch (err) {
          post({ type: "massPropertiesError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "measureExactRequest") {
        try {
          if (!route || route.strategy !== "occt") {
            throw new Error("Exact measurement requires a B-rep source; mesh sources have no host-side geometry to re-derive it from.");
          }
          const bytes = await vscode.workspace.fs.readFile(document.uri);
          const result = await measureExact(
            this.context.extensionPath,
            bytes,
            route.format as Extract<CadFormat, "step" | "iges" | "brep">,
            currentEdits,
            msg.kind,
            msg.entityIdA,
            msg.entityIdB
          );
          post({ type: "measureExactResult", requestId: msg.requestId, result });
        } catch (err) {
          post({ type: "measureExactError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "colorFieldRequest") {
        try {
          if (!route || route.strategy !== "meshio") {
            throw new Error("Colour-by-field is only available for meshio++-imported sources (VTK/MED/CGNS/Exodus/XDMF/MDPA).");
          }
          const bytes = await vscode.workspace.fs.readFile(document.uri);
          const result = await readMeshioFieldValues(bytes, route.format, msg.field, msg.kind);
          if (!result) throw new Error(`Field "${msg.field}" not found, not a plain scalar, or the boundary isn't pure triangles.`);
          post({ type: "colorFieldResult", requestId: msg.requestId, values: encodeBuffer(result.values), min: result.min, max: result.max });
        } catch (err) {
          post({ type: "colorFieldError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }
    });

    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);
  }

  /**
   * `cache` is a per-document holder (`brepCache` in `resolveCustomEditor`),
   * mutated in place: `loadBRepCached` reuses `cache.current` when possible
   * (skipping the STEP/IGES/BREP parse, and — for a pure op-list append —
   * the full replay too), and this method always writes the fresh entry it
   * returns back into `cache.current` for the next call. On any error, the
   * held entry is dropped (not reused, not explicitly disposed — see
   * `loadBRepCached`'s doc comment for why a thrown call must not attempt to
   * free its own stale handles) so the NEXT call starts from a clean parse.
   */
  private async handleBRep(
    uri: vscode.Uri,
    format: Extract<CadFormat, "step" | "iges" | "brep">,
    post: (msg: HostToWebview) => void,
    ops: EditOp[] = [],
    cache: { current: BRepCacheEntry | undefined }
  ): Promise<void> {
    try {
      post({ type: "status", text: `Loading ${format.toUpperCase()} kernel…` });
      const bytes = await vscode.workspace.fs.readFile(uri);
      post({ type: "status", text: `Tessellating ${format.toUpperCase()}…` });
      // Re-read fresh on every call (cheap) rather than cached at document-open
      // time — a mid-session settings change should take effect on the NEXT
      // edit without needing to reopen the tab, same as every other
      // `cadPreview.*` setting's "always re-read" convention.
      const quality = normalizeTessellationQuality(
        vscode.workspace.getConfiguration("cadPreview").get("tessellationQuality")
      );
      const { result, cache: nextCache } = await loadBRepCached(
        this.context.extensionPath,
        bytes,
        format,
        ops,
        cache.current,
        tessellationParamsFor(quality)
      );
      cache.current = nextCache;
      const { groups, edges, points, tree } = result;
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
      const text = format === "step" || format === "iges" ? Buffer.from(bytes).toString("latin1") : undefined;
      const sourceUnit = format === "step" ? detectStepLengthUnit(text!) : format === "iges" ? detectIgesLengthUnit(text!) : undefined;
      post({ type: "tree", root: tree, sourceUnit });
    } catch (err) {
      // Drop (never reuse) whatever cache entry was held — see
      // `loadBRepCached`'s doc comment on why a thrown call doesn't already
      // dispose its own stale state; the next `handleBRep` call starts from
      // a clean parse regardless of whether this was a real WASM abort or an
      // ordinary error (e.g. an unreadable file).
      cache.current = undefined;
      post({ type: "error", message: `${format.toUpperCase()} error: ${(err as Error).message}` });
    }
  }

  /**
   * meshio++-only formats (VTK/MED/CGNS/Exodus/XDMF/MDPA) — converts the raw
   * file to an STL boundary surface and posts it as `loadMeshBytes`, letting
   * the webview treat it exactly like a native `.stl` open. See
   * `src/meshioService.ts` for why this funnel-through-STL design was chosen
   * over host-side tessellation into `EncodedMesh` groups.
   *
   * Also owns the parts round trip for this route (unlike every other route,
   * which gets it from the generic `sendParts` call in the `"ready"`
   * handler — see that call site): `convertToStlBoundaryWithRegions` may
   * correlate the file's own regions to the boundary triangles, and when the
   * parts sidecar is still empty (a fresh import, never one that already has
   * user-authored Parts — same "never clobber existing Parts" rule the
   * B-rep entity-rebinding feature already established), auto-creates one
   * Part per region via `buildPartsFromMeshioRegions` and persists it
   * immediately, so a reopen doesn't need to recompute the correlation. The
   * per-triangle `regionAssignment` is sent on EVERY open where correlation
   * succeeds (not just the one that auto-created Parts) — the webview needs
   * it every time to reproduce the identical region-aware facet split those
   * `node-0/face-K` ids were computed against, see `protocol.ts`'s doc
   * comment. Returns the parts actually in effect so the caller can keep
   * `currentParts` in sync.
   */
  private async handleMeshio(uri: vscode.Uri, format: CadFormat, post: (msg: HostToWebview) => void): Promise<Part[]> {
    try {
      post({ type: "status", text: `Loading ${format.toUpperCase()}…` });
      const bytes = await vscode.workspace.fs.readFile(uri);
      const [boundary, metadata, existingParts] = await Promise.all([
        convertToStlBoundaryWithRegions(bytes, format),
        readMeshioMetadata(bytes, format),
        readParts(uri),
      ]);
      let parts = existingParts;
      if (boundary.regions && existingParts.length === 0) {
        const built = buildPartsFromMeshioRegions(boundary.stlBytes, boundary.regions);
        if (built.length > 0) {
          parts = built;
          try {
            await writeParts(uri, parts);
          } catch {
            // Best-effort persist — the webview still gets these Parts for
            // this session even if the sidecar write failed; a later user
            // edit's own autosave will retry.
          }
        }
      }
      const hasMetadata =
        metadata.regions.length > 0 ||
        metadata.pointDataNames.length > 0 ||
        metadata.cellDataNames.length > 0 ||
        metadata.fieldDataNames.length > 0;
      post({
        type: "loadMeshBytes",
        sourceFormat: format,
        dataBase64: Buffer.from(boundary.stlBytes).toString("base64"),
        meshioMetadata: hasMetadata ? metadata : undefined,
        regionAssignment: boundary.regions
          ? { regionNames: boundary.regions.regionNames, triangleRegionIndex: encodeBuffer(boundary.regions.triangleRegion) }
          : undefined,
      });
      post({ type: "parts", parts });
      return parts;
    } catch (err) {
      post({ type: "error", message: `${format.toUpperCase()} error: ${(err as Error).message}` });
      return [];
    }
  }

  /** Loads the parts sidecar (if any), sends it to the webview, and returns
   * it so the caller can keep `currentParts` in sync (see its call site). */
  private async sendParts(uri: vscode.Uri, post: (msg: HostToWebview) => void): Promise<Part[]> {
    try {
      const parts = await readParts(uri);
      post({ type: "parts", parts });
      return parts;
    } catch {
      post({ type: "parts", parts: [] });
      return [];
    }
  }

  /** Loads the mesh-options sidecar (if any), sends it to the webview, and
   * returns it so the caller can keep `currentMeshOptions` in sync — same
   * pattern as `sendParts` above. */
  private async sendMeshOptions(uri: vscode.Uri, post: (msg: HostToWebview) => void): Promise<MeshOptions> {
    const options = await readMeshOptions(uri);
    post({ type: "meshingOptions", options });
    return options;
  }

  /**
   * Sends the cross-document `cadPreview.*` settings (background, grid/axes
   * visibility, up-axis, mesh-size preset) as the webview's initial state.
   * These are only ever defaults for a newly opened document — a persisted
   * per-document sidecar value (e.g. an already-saved `.mesh.json` size) or a
   * runtime toggle (the toolbar Grid button) always wins once set.
   */
  private sendViewerDefaults(post: (msg: HostToWebview) => void): void {
    const cfg = vscode.workspace.getConfiguration("cadPreview");
    const defaults = normalizeViewerDefaults({
      background: cfg.get("background"),
      meshSizePreset: cfg.get("defaultMeshSizePreset"),
      showGridAndAxes: cfg.get("showGridAndAxesOnOpen"),
      upAxis: cfg.get("upAxis"),
    });
    post({ type: "viewerDefaults", ...defaults });
  }

  /**
   * Resolves the geometry `generateMesh`/`exportGeoUnrolled` need, per the
   * document's route: B-rep sources are re-exported to STEP (via the existing
   * `exportBRep`, so live edits are reflected); mesh sources need the webview's
   * already-triangulated data, passed in as base64 `stl`. Returns `undefined`
   * when a mesh-format document has no `stl` payload — callers should treat
   * that as a graceful "nothing to mesh yet", not a thrown error.
   *
   * `unit` defaults to `"mm"` (native, no conversion) — the interactive
   * **Generate** call site always passes `"mm"` explicitly, since its overlay
   * is display-only with no exported file whose numbers need to mean
   * anything externally. Only the FE Mesh panel's **Export** flow passes a
   * real unit: B-rep sources get it via `exportBRep`'s existing `unit`
   * param (the same geometric-scale mechanism the model Export command
   * already uses — see `UNIT_CONVERTIBLE_FORMATS`), and STL sources get it
   * via the new `scaleStlBytes` (`stlParser.ts`). The caller is responsible
   * for proportionally rescaling `MeshOptions.sizeMin`/`sizeMax` (and any
   * per-part `meshSize`) by the same factor — see `scaleMeshOptionsForUnit`/
   * `scalePartsMeshSizeForUnit` in `meshOptions.ts` — or the resulting mesh
   * density won't match what was asked for.
   */
  private async resolveMeshInput(
    uri: vscode.Uri,
    route: FileRoute | undefined,
    ops: EditOp[],
    stl: string | undefined,
    unit: DisplayUnit = "mm"
  ): Promise<MeshGenerationInput | undefined> {
    if (route && route.strategy === "occt") {
      const sourceBytes = await vscode.workspace.fs.readFile(uri);
      // labelStepUnit: false — Gmsh's own STEP importer reinterprets a
      // correctly-labeled header and would undo this scale entirely (verified
      // against the live WASM); this intermediate file is meshing input only,
      // never shown to the user, so it stays at the OCCT-native "mm" label
      // while its geometry is still genuinely scaled. See exportBRep's doc
      // comment for the full write-up.
      const stepBytes = await exportBRep(
        this.context.extensionPath,
        sourceBytes,
        route.format as Extract<CadFormat, "step" | "iges" | "brep">,
        "step",
        ops,
        unit,
        false
      );
      return { kind: "brep", stepBytes };
    }

    if (!stl) return undefined;
    const stlBytes = Buffer.from(stl, "base64");
    const factor = unitScaleFactor(unit);
    return { kind: "stl", stlBytes: factor === 1 ? stlBytes : scaleStlBytes(stlBytes, factor) };
  }

  /**
   * Reads the parts sidecar and shapes it per `input`'s kind: B-rep sources
   * pass `parts` straight through to `generateMesh`/`exportGeoUnrolled` (which
   * turn them into physical groups + per-part sizing fields); STL/mesh
   * sources can't get true physical groups (see `gmshPartsMap.ts`), so `parts`
   * is dropped ([]) and `options` instead gets `applyStlPartSizeOverride`'s
   * one-off sizing degrade for just this call — never persisted back to the
   * `.mesh.json` sidecar. `unit` (default `"mm"`, matching `resolveMeshInput`'s
   * default) applies `scaleMeshOptionsForUnit`/`scalePartsMeshSizeForUnit`
   * LAST, after the STL override above, so a single sized STL part's raw mm
   * `meshSize` is correctly carried into the target unit's numeric space too
   * — not just the B-rep per-part case.
   */
  private async resolveMeshPartsAndOptions(
    uri: vscode.Uri,
    input: MeshGenerationInput,
    options: MeshOptions,
    unit: DisplayUnit = "mm"
  ): Promise<{ parts: Part[]; options: MeshOptions }> {
    const rawParts = await readParts(uri);
    const { parts, options: sized } =
      input.kind === "brep" ? { parts: rawParts, options } : { parts: [], options: applyStlPartSizeOverride(options, rawParts) };
    const factor = unitScaleFactor(unit);
    return { parts: scalePartsMeshSizeForUnit(parts, factor), options: scaleMeshOptionsForUnit(sized, factor) };
  }

  /**
   * Prompts for a target format, an optional unit conversion, and a
   * destination, then writes the export. B-rep targets are written directly
   * via OCCT; mesh targets are serialized in the webview (which already holds
   * the triangulated Three.js model) and relayed back.
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
    // Every B-rep/mesh target this codebase can export to can now honestly
    // represent a converted unit — see UNIT_CONVERTIBLE_FORMATS' doc comment.
    const unit = UNIT_CONVERTIBLE_FORMATS.has(targetFormat) ? await this.pickExportUnit() : "mm";

    await this.promptSaveAndWrite(uri, EXPORT_EXTENSION[targetFormat], EXPORT_LABEL[targetFormat], async (_saveUri) => {
      if (BREP_FORMATS.has(targetFormat)) {
        const sourceBytes = await vscode.workspace.fs.readFile(uri);
        return exportBRep(
          this.context.extensionPath,
          sourceBytes,
          route.format as Extract<CadFormat, "step" | "iges" | "brep">,
          targetFormat as Extract<CadFormat, "step" | "iges" | "brep">,
          ops,
          unit
        );
      }

      const requestId = `${Date.now()}-${Math.random()}`;
      const result = await new Promise<{ data: string; binary: boolean }>((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        post({ type: "exportMesh", requestId, format: targetFormat, unit });
      });
      return result.binary ? Buffer.from(result.data, "base64") : Buffer.from(result.data, "utf8");
    }, post);
  }

  /**
   * Real unit conversion on export — a geometric scale applied to the
   * exported file's coordinates, distinct from the webview's display-unit
   * selector (which only rescales what a number looks like, never geometry —
   * see `src/webview/units.ts`). Shown as its own quick-pick step after the
   * format is chosen, defaulting to `"mm"` (native, no conversion — the
   * codebase's one internal cascade unit) both as the first/pre-highlighted
   * item AND on Escape: this step is a nice-to-have on top of the primary
   * "export the model" action, so declining it must never cancel the export
   * itself the way declining the format pick does.
   */
  private async pickExportUnit(): Promise<DisplayUnit> {
    const picked = await vscode.window.showQuickPick(
      DISPLAY_UNITS.map((unit) => ({
        label: unit === "mm" ? "Native (mm) — no conversion" : UNIT_LABELS[unit],
        unit,
      })),
      { placeHolder: "Export unit…" }
    );
    return picked?.unit ?? "mm";
  }

  /**
   * Saves the current 3D view as a PNG. Mirrors `handleExport`'s mesh-target
   * branch exactly (a `screenshotRequest`/`screenshotResult` round trip
   * through the same `pending` map), minus the format `showQuickPick` — the
   * format is always PNG.
   */
  private async handleScreenshot(
    uri: vscode.Uri,
    post: (msg: HostToWebview) => void,
    pending: Map<string, PendingExport>
  ): Promise<void> {
    await this.promptSaveAndWrite(
      uri,
      "png",
      "PNG Image",
      async () => {
        const requestId = `${Date.now()}-${Math.random()}`;
        const result = await new Promise<{ data: string; binary: boolean }>((resolve, reject) => {
          pending.set(requestId, { resolve, reject });
          post({ type: "screenshotRequest", requestId });
        });
        return Buffer.from(result.data, "base64");
      },
      post
    );
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

  /**
   * Packages the CAD source plus whichever of its parts/edits/mesh-options/geo
   * sidecars exist on disk into a single `.zip` (File ▸ Save Preprocess…).
   * Callers must flush pending debounced sidecar writes first (see the two
   * call sites) so the archive reflects the latest in-memory state, not a
   * stale on-disk one; which sidecars are included is otherwise purely
   * file-existence-driven — a sidecar that was never created (e.g. no
   * meshing options ever set) is simply omitted, never a hard error.
   */
  private async handleSavePreprocess(uri: vscode.Uri, post: (msg: HostToWebview) => void): Promise<void> {
    const sourceName = uri.path.slice(uri.path.lastIndexOf("/") + 1);
    const baseName = sourceName.replace(/\.[^.]+$/, "");
    const defaultUri = vscode.Uri.joinPath(uri, "..", `${baseName}.preprocess.zip`);

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { "Preprocess Archive": ["zip"] },
    });
    if (!saveUri) return;

    try {
      const readOptional = async (sidecar: vscode.Uri): Promise<string | undefined> => {
        try {
          return Buffer.from(await vscode.workspace.fs.readFile(sidecar)).toString("utf8");
        } catch {
          return undefined;
        }
      };
      const [source, parts, edits, meshOptions, geo] = await Promise.all([
        vscode.workspace.fs.readFile(uri),
        readOptional(sidecarUri(uri)),
        readOptional(editsSidecarUri(uri)),
        readOptional(meshOptionsSidecarUri(uri)),
        readOptional(geoScriptUri(uri)),
      ]);
      const zipBytes = buildPreprocessZip({ sourceName, source, parts, edits, meshOptions, geo });
      await vscode.workspace.fs.writeFile(saveUri, zipBytes);
      post({ type: "status", text: `Saved preprocess archive to ${saveUri.fsPath}` });
    } catch (err) {
      post({ type: "error", message: `Save preprocess failed: ${(err as Error).message}` });
    }
  }

  /**
   * Restores a `.zip` built by `handleSavePreprocess` (File ▸ Load Preprocess…):
   * prompts for the archive, then for a destination path for the restored CAD
   * file (defaulting to the archive's own manifest filename beside the
   * archive), writes the source bytes and whichever sidecars the archive
   * contains, and opens the result. Host-only, like `openFileDialog` — it
   * needs no already-open editor, so errors surface via `showErrorMessage`
   * rather than a webview `post`. The `.geo` script is deliberately NOT
   * restored verbatim from the archive; mesh options are re-written through
   * `writeMeshOptions`/`writeGeoScript` so the one-way-generated script stays
   * in lockstep with the (re-validated) options, same as every other write path.
   */
  private async loadPreprocessDialog(): Promise<void> {
    const zipUris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Load Preprocess Archive",
      filters: { "Preprocess Archive": ["zip"] },
    });
    const zipUri = zipUris?.[0];
    if (!zipUri) return;

    try {
      const zipBytes = await vscode.workspace.fs.readFile(zipUri);
      const contents = readPreprocessZip(zipBytes);

      const ext = contents.manifest.source.slice(contents.manifest.source.lastIndexOf(".") + 1);
      const destUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(zipUri, "..", contents.manifest.source),
        saveLabel: "Restore To",
        filters: { "CAD / Mesh": [ext] },
      });
      if (!destUri) return;

      await vscode.workspace.fs.writeFile(destUri, contents.source);
      if (contents.parts !== undefined) {
        await writeParts(destUri, parsePartsJson(contents.parts));
      }
      if (contents.edits !== undefined) {
        const parsed = parseEditsJson(contents.edits);
        await writeEdits(destUri, parsed.ops, parsed.variables);
      }
      if (contents.meshOptions !== undefined) {
        const options = parseMeshJson(contents.meshOptions);
        await writeMeshOptions(destUri, options);
        await writeGeoScript(destUri, options);
      }

      await vscode.commands.executeCommand("vscode.openWith", destUri, CadPreviewProvider.viewType);
    } catch (err) {
      void vscode.window.showErrorMessage(`Load preprocess failed: ${(err as Error).message}`);
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
  ${viewerBodyHtml()}
  <script nonce="${nonce}" src="${viewerUri}"></script>
</body>
</html>`;
  }
}
