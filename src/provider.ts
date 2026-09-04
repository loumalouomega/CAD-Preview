import * as vscode from "vscode";
import { routeFile } from "./fileRouter";
import { createKernelClient, type KernelClient } from "./kernelClient";
import { normalizeTessellationQuality, tessellationParamsFor } from "./tessellationQuality";
import { detectStepLengthUnit } from "./stepUnits";
import { detectIgesLengthUnit } from "./igesUnits";
import { buildPartsFromMeshioRegions } from "./meshioRegionParts";
import { meshioCompanionCandidates } from "./meshioCompanions";
import type { MeshioCompanion } from "./meshioService";
import {
  encodeBuffer,
  type HostToWebview,
  type WebviewToHost,
  type Part,
  type Annotation,
  type ConstructionPlane,
  type ViewState,
  type SelectorSynthesizeResultEntry,
} from "./protocol";
import type { CadFormat, FileRoute, MeshParseFormat } from "./fileRouter";
import { COMPARABLE_MESH_FORMATS, ambiguityCaveatFor } from "./fileRouter";
import { isMeshioFieldFailure, describeMeshioFieldFailure } from "./meshioService";
import { SVG_VIEWS } from "./svgSilhouette";
import type { CompareSource } from "./modelDiffHost";
import { resolveExternalBuffers, type GltfExternalBuffers } from "./gltfParser";
import { exportTargetsFor, EXPORT_EXTENSION, EXPORT_LABEL, UNIT_CONVERTIBLE_FORMATS } from "./exportTargets";
import { readParts, writeParts, sidecarUri } from "./partsStore";
import { readAnnotations, writeAnnotations, annotationsSidecarUri } from "./annotationsStore";
import { readPlanes, writePlanes, planesSidecarUri } from "./planesStore";
import { readEdits, writeEdits, editsSidecarUri } from "./editsStore";
import type { EditOp } from "./editOps";
import { validateEditOp } from "./editOps";
import type { ParamVariable } from "./editVariables";
import { resolvePlaneRefs } from "./planeRefs";
import { readMeshOptions, writeMeshOptions, writeGeoScript, meshOptionsSidecarUri } from "./meshOptionsStore";
import { readViewState, writeViewState, viewStateSidecarUri } from "./viewStateStore";
import type { MeshGenerationInput } from "./gmshService";
import type { MeshioMetadataSummary } from "./meshioService";
import { meshExportFormat, companionSaveName, MESH_EXPORT_FORMATS, type MeshExportFormatId } from "./meshExportFormats";
import { applyStlPartSizeOverride, scaleMeshOptionsForUnit, scalePartsMeshSizeForUnit } from "./meshOptions";
import type { MeshOptions } from "./meshOptions";
import { viewerBodyHtml } from "./viewerDom";
import { normalizeViewerDefaults } from "./viewerDefaults";
import { buildPreprocessZip, readPreprocessZip } from "./preprocessArchive";
import { parsePartsJson } from "./partsSidecar";
import { parseAnnotationsJson } from "./annotationsSidecar";
import { parsePlanesJson } from "./planesSidecar";
import { parseEditsJson } from "./editsSidecar";
import { parseMeshJson } from "./meshOptionsSidecar";
import { DISPLAY_UNITS, UNIT_LABELS, unitScaleFactor, type DisplayUnit } from "./lengthUnits";
import { scaleStlBytes } from "./stlParser";
import { getNonce } from "./nonce";
import { showLatestWhatsNew } from "./whatsNew";
import { runCompareModelsCommand } from "./modelComparePanel";
import { mergeScriptOverrides, parseScriptLibraryJson, scriptParameters, serializeScriptLibraryJson } from "./scriptLibrary";
import { compileParametricScript } from "./parametricScript";
import { evaluateVariables } from "./editVariables";
import * as path from "path";

/** Debounce window for autosaving the parts/edits/mesh-options sidecars after changes. */
const PARTS_SAVE_DEBOUNCE_MS = 500;

/** The guaranteed-empty metadata an OpenFOAM import always reports — meshio++'s
 * OpenFOAM reader surfaces no regions and no point/cell/field data to JS (patch
 * names ride an unexposed C++ side-channel struct), so `handleMeshio` skips the
 * `readMeshioMetadata` round trip entirely for that format rather than staging
 * the whole case into MEMFS a second time for a structurally empty answer. */
const EMPTY_MESHIO_METADATA: MeshioMetadataSummary = { regions: [], pointDataNames: [], cellDataNames: [], fieldDataNames: [] };
/** Settle window for the external-change file watchers below — short enough
 * to reconcile promptly, long enough to avoid reading a file mid-write by
 * another process. */
const EXTERNAL_CHANGE_DEBOUNCE_MS = 300;

const BREP_FORMATS: ReadonlySet<CadFormat> = new Set(["step", "iges", "brep"]);

/**
 * Reads a `.gltf`'s sibling `.bin` buffers, when the source is glTF at all.
 *
 * `gltfParser.ts` deliberately has no I/O capability (it stays pure so it
 * unit-tests and runs unchanged in the kernel worker), so whichever caller
 * has one resolves the buffers and passes them in; `resolveExternalBuffers`
 * itself refuses anything that isn't a plain relative path beside the model.
 * Returns `undefined` for every other format, and for a `.glb` or a `.gltf`
 * with embedded `data:` buffers there is simply nothing to read.
 */
async function resolveGltfBuffersFor(uri: vscode.Uri, format: CadFormat, bytes: Uint8Array): Promise<GltfExternalBuffers | undefined> {
  if (format !== "gltf") return undefined;
  return resolveExternalBuffers(bytes, async (relative) => {
    try {
      return await vscode.workspace.fs.readFile(vscode.Uri.joinPath(uri, "..", relative));
    } catch {
      return undefined;
    }
  });
}

/**
 * Reads whatever sibling files a meshio++ multi-file/companion format needs
 * beside `uri` — the same "candidate list is pure, disk I/O is per-consumer"
 * split `resolveGltfBuffersFor` above already established for glTF's
 * external buffers. `meshioCompanionCandidates` (pure, `meshioCompanions.ts`)
 * decides WHICH basenames to look for; a missing one is silently skipped
 * (`try { readFile } catch { undefined }`, filtered out below) — a
 * self-contained source (an XDMF using the "XML"/"Binary" data formats, or
 * any single-file format) correctly yields `[]` with no wasted round trip.
 */
async function resolveMeshioCompanionsFor(uri: vscode.Uri, basename: string, meshioFormat: string, bytes: Uint8Array): Promise<MeshioCompanion[]> {
  const primaryText = meshioFormat === "xdmf" ? Buffer.from(bytes).toString("utf8") : undefined;
  const candidates = meshioCompanionCandidates(basename, meshioFormat, primaryText);
  if (candidates.length === 0) return [];
  const resolved = await Promise.all(
    candidates.map(async (name): Promise<MeshioCompanion | undefined> => {
      try {
        return { name, bytes: await vscode.workspace.fs.readFile(vscode.Uri.joinPath(uri, "..", name)) };
      } catch {
        return undefined;
      }
    })
  );
  return resolved.filter((c): c is MeshioCompanion => c !== undefined);
}

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
  /** Export a 2D outline (silhouette) of the model as an SVG drawing. */
  exportSvg(): void;
  /** Export a 2D outline (silhouette) of the model as a DXF drawing. */
  exportDxf(): void;
  /** File ▸ Export Technical Drawing… (hidden-line removal). */
  exportDrawing(): void;
  /** Generate and export an FE mesh (format + unit quick-picks, then a save dialog). */
  exportMesh(): void;
  /** Post a message to this session's webview — the registry entry for the
   * linked-cameras relay (roadmap "Split view", Phase 3). */
  post(msg: HostToWebview): void;
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

  /**
   * Fires for every host→webview message, so the integration suite can observe
   * flows whose only effect is a `postMessage`.
   *
   * This exists for exactly one reason: the six external-change file watchers
   * (`watchForExternalChange` below) reconcile by posting to the webview and
   * nothing else — no return value, no disk write, no output channel, and the
   * callbacks are fire-and-forget — so without this they are unobservable and
   * therefore untestable from the host side.
   *
   * **Inert in production.** `extension.ts` only surfaces it when
   * `context.extensionMode === vscode.ExtensionMode.Test`; nothing subscribes
   * otherwise, and an `EventEmitter` with no listeners costs a function call
   * per posted message. It is deliberately NOT part of the extension's public
   * API surface.
   */
  private static readonly postedEmitter = new vscode.EventEmitter<HostToWebview>();
  public static readonly onDidPostMessage = CadPreviewProvider.postedEmitter.event;

  /** The focused editor, tracked so commands/keybindings can reach it. */
  private activeSession?: EditorSession;

  /** Every open editor session, keyed by `uri.toString()` — the host relay
   * for linked cameras (roadmap "Split view", Phase 3). Two webviews cannot
   * talk to each other, so `viewChanged` fans out through this registry;
   * `activeSession` stays the single "which tab has focus" router for
   * keybindings, independent of this. */
  private readonly sessions = new Map<string, EditorSession>();

  /** Provider-level linked-cameras flag — one on/off for all open tabs
   * (roadmap "Split view", Phase 3). Session-only, not persisted. */
  private camerasLinked = false;

  /**
   * The one kernel-worker child process (+ its request queue) for this whole
   * extension-host instance (roadmap "OCCT in a forked child process",
   * Phase 2+3 — see CLAUDE.md) — created once here, NOT per-document, since
   * the underlying child is itself shared across every open document (same
   * "one child per parent process" design Phase 0+1 already established for
   * the MCP server). Every kernel call in this file goes through it instead
   * of importing `occtService.ts`/`gmshService.ts`/etc. directly.
   */
  private readonly pipeline: KernelClient;

  constructor(private readonly context: vscode.ExtensionContext) {
    // Assigned in the constructor body, not a field initializer, so there is
    // no ambiguity about running after the `context` parameter property is
    // set (field initializers and parameter-property assignment ordering is
    // a real TS subtlety not worth relying on here).
    this.pipeline = createKernelClient(this.context.extensionPath);
  }

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
      // Deliberately NOT `withSession` — like `open`/`loadPreprocess`, this
      // creates a document and so must work with no CAD tab focused.
      vscode.commands.registerCommand("cad-preview.new", () => void this.newBlankModelDialog()),
      vscode.commands.registerCommand("cad-preview.save", withSession((s) => void s.save())),
      vscode.commands.registerCommand("cad-preview.saveAs", withSession((s) => s.export())),
      vscode.commands.registerCommand("cad-preview.export", withSession((s) => s.export())),
      vscode.commands.registerCommand("cad-preview.savePreprocess", withSession((s) => s.savePreprocess())),
      vscode.commands.registerCommand("cad-preview.loadPreprocess", () => void this.loadPreprocessDialog()),
      vscode.commands.registerCommand("cad-preview.whatsNew", () => void showLatestWhatsNew(this.context)),
      vscode.commands.registerCommand("cad-preview.screenshot", withSession((s) => s.screenshot())),
      vscode.commands.registerCommand("cad-preview.exportSvg", withSession((s) => s.exportSvg())),
      vscode.commands.registerCommand("cad-preview.exportDxf", withSession((s) => s.exportDxf())),
      vscode.commands.registerCommand("cad-preview.exportDrawing", withSession((s) => s.exportDrawing())),
      vscode.commands.registerCommand("cad-preview.exportMesh", withSession((s) => s.exportMesh())),
      vscode.commands.registerCommand("cad-preview.compareModels", () =>
        void runCompareModelsCommand(this.context, this.pipeline, this.activeSession?.uri)
      ),
    ];
  }

  /** Shows an open dialog and hands the chosen file to this custom editor. */
  private async openFileDialog(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Open in CAD Preview",
      filters: {
        // Mirrors `fileRouter.ts`'s EXTENSION_MAP. VS Code matches these against
        // the final dot-segment only, so GiD's compound `post.msh` is covered by
        // the plain `msh` entry — a separate "post.msh" entry would never match.
        "CAD / Mesh": [
          "stl", "obj", "ply", "gltf", "glb", "step", "stp", "iges", "igs", "brep",
          "vtk", "vtu", "med", "cgns", "exo", "e", "xdmf", "mdpa", "foam",
          "msh", "msh2", "inp", "unv", "su2", "mesh",
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

  /**
   * File ▸ New Blank Model… — creates an empty B-rep document and opens it,
   * so the Edits panel's creation ops (Box/Sphere/…, 2D sketches, wireframe
   * points/lines/arcs → Surface → Volume) can be used from scratch rather
   * than only on top of someone else's model. Those ops already need no
   * existing operands (`occtOperations.addPrimitive` appends into
   * `compound(existing + new)`, and "existing" being empty is fine); the only
   * thing missing was a document to start from.
   *
   * **The source file is an EMPTY COMPOUND and stays that way.** Everything
   * the user authors lives in the replayable `<file>.brep.edits.json`
   * op-list, exactly as it does for an edited `bull.stp` — the read-only-CAD
   * invariant is untouched. Writing the file here does not bend it either:
   * creation happens BEFORE any editor session exists, precisely like
   * `loadPreprocessDialog` and `handlePromoteToBrep` already do.
   *
   * **`.brep`, not `.step`**, even though a probe confirmed all three writers
   * accept an empty compound: BREP is OCCT's own native serialization, it
   * carries no unit header to declare for geometry that isn't there yet, and
   * it skips `handleBRep`'s STEP/IGES `latin1` unit-detection path entirely.
   * Consequence, since `exportTargetsFor` excludes a document's own format:
   * Export… offers STEP/IGES + every mesh target, but not BREP.
   *
   * Host-only and session-free, like `openFileDialog`/`loadPreprocessDialog`
   * — it must work with no CAD tab focused at all.
   */
  private async newBlankModelDialog(): Promise<void> {
    try {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const destUri = await vscode.window.showSaveDialog({
        defaultUri: folder ? vscode.Uri.joinPath(folder, "untitled.brep") : undefined,
        saveLabel: "Create",
        filters: { "CAD (B-rep)": ["brep"] },
      });
      if (!destUri) return;

      // The dialog's filter is advisory on some platforms, so verify the
      // extension actually routes — the same cross-check, and the same
      // reasoning, as `loadPreprocessDialog`'s.
      const route = routeFile(destUri.path);
      if (!route || route.strategy !== "occt" || route.format !== "brep") {
        void vscode.window.showErrorMessage(
          `A blank model must be created as a .brep file — "${destUri.path.slice(destUri.path.lastIndexOf("/") + 1)}" is not one.`
        );
        return;
      }

      // Refuse to overwrite. Blanking an existing model would leave its own
      // `.edits.json` replaying against an empty base — geometry that looks
      // plausible and is silently wrong, which is the failure mode this
      // codebase rejects features over. VS Code's own overwrite prompt reads
      // as routine and is easy to click through, so this refuses explicitly
      // and names the fix, per the `dirtyGuard`/`assertNotSourcePath`
      // convention.
      let exists = true;
      try {
        await vscode.workspace.fs.stat(destUri);
      } catch {
        exists = false;
      }
      if (exists) {
        void vscode.window.showErrorMessage(
          `"${destUri.path.slice(destUri.path.lastIndexOf("/") + 1)}" already exists. New Blank Model only creates new files — use File ▸ Open… to open the existing one.`
        );
        return;
      }

      // Reuses the pipeline function `decompose_to_primitives` already goes
      // through; an empty op list is a supported input (see its doc comment).
      const built = await this.pipeline.buildPrimitivesFile(this.context.extensionPath, [], "brep", "mm");
      await vscode.workspace.fs.writeFile(destUri, built.bytes);

      void vscode.window.showInformationMessage(
        "Blank model created. Build it with the Edits panel — your geometry is stored beside it in the .edits.json sidecar, so keep the pair together, or use File ▸ Export… / Save Preprocess… to produce a standalone file."
      );

      await vscode.commands.executeCommand("vscode.openWith", destUri, CadPreviewProvider.viewType);
    } catch (err) {
      void vscode.window.showErrorMessage(`New blank model failed: ${(err as Error).message}`);
    }
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

    const post = (msg: HostToWebview) => {
      CadPreviewProvider.postedEmitter.fire(msg); // test-only observer; see the emitter's doc comment
      return webviewPanel.webview.postMessage(msg);
    };
    const pending = new Map<string, PendingExport>();
    let partsSaveTimer: ReturnType<typeof setTimeout> | undefined;
    let annotationsSaveTimer: ReturnType<typeof setTimeout> | undefined;
    let planesSaveTimer: ReturnType<typeof setTimeout> | undefined;
    let editsSaveTimer: ReturnType<typeof setTimeout> | undefined;
    let meshSaveTimer: ReturnType<typeof setTimeout> | undefined;
    let viewSaveTimer: ReturnType<typeof setTimeout> | undefined;
    // The document's OCCT parse+replay cache (roadmap "Base-shape caching
    // and incremental replay", closed) now lives INSIDE the kernel-worker
    // child (`loadBRepCachedForDocument`'s own doc comment in
    // `kernelClient.ts`/`kernelWorker.ts` has the reuse rules — Phase 2 of
    // "OCCT in a forked child process" moved it there, since a live OCCT
    // handle can never cross the IPC boundary). All this closure needs is a
    // stable key identifying the document to the child — the URI string —
    // used by both `handleBRep` and this method's `onDidDispose` below.
    const documentKey = document.uri.toString();
    // Progress reporting and cancellation (roadmap item, closed — see
    // CLAUDE.md's "Progress reporting and cancellation" section for the full
    // scoping rationale). `loadModel()` can be called again (a newer edit, an
    // external reload) before a prior `handleBRep` call has finished — there
    // is no `await` chain linking them, so without this counter whichever
    // call's `loadBRepCached` happens to resolve LAST would win and could
    // clobber a fresher, already-displayed result with a stale one. Bumped
    // once per `handleBRep` invocation (a fresh "generation"); a captured
    // generation that no longer matches `.current` by the time the async work
    // resolves means either a NEWER load started (silently discard — that
    // newer call will post its own result) or the user clicked Cancel on the
    // progress notification (also silently discard — the cancellation
    // handler already posted its own "Cancelled" status). Either way this is
    // the maximally-honest cancellation this synchronous-WASM pipeline can
    // offer without forking OCCT into a child process (roadmap item "OCCT in
    // a forked child process", not attempted this session): the actual OCCT
    // computation always runs to completion, "cancel" only ever suppresses
    // applying its result.
    const brepLoadGeneration: { current: number } = { current: 0 };

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
    // Persisted, topology-anchored measurements (roadmap "Persisted,
    // topology-anchored annotations", closed) — same "retained for Save to
    // flush" reason as `currentParts`.
    let currentAnnotations: Annotation[] = [];
    // Named construction planes (roadmap "Reusable construction planes") —
    // same "retained for Save to flush" reason as `currentParts`. Deliberately
    // NOT rebound across topology changes: a plane stores resolved vectors,
    // never a live face reference, so replay never renumbers it.
    let currentPlanes: ConstructionPlane[] = [];
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
      if (annotationsSaveTimer) clearTimeout(annotationsSaveTimer);
      if (planesSaveTimer) clearTimeout(planesSaveTimer);
      if (editsSaveTimer) clearTimeout(editsSaveTimer);
      if (meshSaveTimer) clearTimeout(meshSaveTimer);
      if (viewSaveTimer) clearTimeout(viewSaveTimer);
      try {
        await Promise.all([
          writeParts(document.uri, currentParts),
          writeAnnotations(document.uri, currentAnnotations),
          writePlanes(document.uri, currentPlanes),
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

    /**
     * (Re)tessellates a B-rep source with the current edits, (re)loads a
     * mesh, or (re)converts a meshio-only source.
     *
     * `showProgress` opts a B-rep load into a native, cancellable
     * `vscode.window.withProgress` notification — reserved for the two call
     * sites where a load is genuinely likely to be slow with a cold cache
     * (the document's initial open, and a full external-file reload): a
     * routine `editsChanged`/external-edits-sidecar-change re-tessellation
     * almost always hits the base-shape cache (roadmap "Base-shape caching
     * and incremental replay", closed) and completes in tens of
     * milliseconds, so popping a notification on every keystroke-driven edit
     * would be pure noise, not a helpful signal. The stale-result-discard
     * safety net below (via `brepLoadGeneration`) applies to EVERY call
     * regardless of `showProgress`, since the underlying race it closes can
     * happen on any of the four call sites, not just the slow ones.
     */
    const loadModel = (showProgress = false) => {
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
        const format = route.format as Extract<CadFormat, "step" | "iges" | "brep">;
        const generation = ++brepLoadGeneration.current;
        const autoFit = !showProgress;
        const resolvedEdits = resolvePlaneRefs(currentEdits, currentPlanes).ops;
        if (showProgress) {
          void vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `CAD Preview: Loading ${format.toUpperCase()}…`,
              cancellable: true,
            },
            async (progress, token) => {
              token.onCancellationRequested(() => {
                // Supersede this in-flight call (the discard-the-result half
                // of cancellation — still needed regardless of the line
                // below, since the kernel-worker child is shared across
                // every open document: killing it can only ever interrupt
                // whichever ONE call is truly executing right now, so a
                // request that was merely QUEUED behind another document's
                // in-flight call needs this generation bump to still be
                // discarded once it eventually DOES run against the
                // respawned child).
                brepLoadGeneration.current++;
                post({ type: "status", text: "Cancelled" });
                // Roadmap "OCCT in a forked child process", Phase 3: genuine
                // interruption, not just a discarded result — kills the
                // shared kernel-worker child. See this.pipeline's own doc
                // comment on the one sharp edge this has: if some OTHER
                // document's call happens to be the one truly executing at
                // this exact moment (this document's own call was merely
                // queued behind it), that other call is interrupted too, not
                // just this one — an accepted trade-off of one shared child.
                this.pipeline.cancelCurrent();
              });
              await this.handleBRep(document.uri, format, post, resolvedEdits, documentKey, generation, brepLoadGeneration, autoFit, progress);
            }
          );
        } else {
          void this.handleBRep(document.uri, format, post, resolvedEdits, documentKey, generation, brepLoadGeneration, autoFit);
        }
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
     * hydration's own `"parts"` message. Also rebinds `currentAnnotations`
     * through the SAME shape-diff pass (`rebindPartsAcrossOps`'s optional 7th
     * parameter, reusing the identical `idMap` at zero extra OCCT cost) and
     * persists+posts `"annotations"` on the same terms — see `Annotation`'s
     * doc comment in `protocol.ts` for why it can reuse `Part`'s exact
     * id-remapping machinery.
     */
    const rebindPartsOnChange = async (previousOps: EditOp[], newOps: EditOp[]): Promise<void> => {
      if (!route || route.strategy !== "occt") return;
      if (currentParts.length === 0 && currentAnnotations.length === 0) return;
      if (JSON.stringify(previousOps) === JSON.stringify(newOps)) return;
      try {
        const bytes = await vscode.workspace.fs.readFile(document.uri);
        // Stored selectors resolve FIRST (authoritative — a query that hits
        // is exact by construction) and the heuristic rebind pass runs on the
        // result, so a query-covered part never also gets geometrically
        // remapped underneath its own resolution. Selector warnings surface
        // on the status line; the parts message below carries the final ids.
        const selected = await this.pipeline.resolvePartSelectors(
          this.context.extensionPath,
          bytes,
          route.format as Extract<CadFormat, "step" | "iges" | "brep">,
          newOps,
          currentParts
        );
        if (selected.parts !== currentParts) currentParts = selected.parts;
        for (const warning of selected.warnings) post({ type: "status", text: warning });
        const result = await this.pipeline.rebindPartsAcrossOps(
          this.context.extensionPath,
          bytes,
          route.format as Extract<CadFormat, "step" | "iges" | "brep">,
          previousOps,
          newOps,
          currentParts,
          currentAnnotations
        );
        if (result.parts !== currentParts) {
          currentParts = result.parts;
          await writeParts(document.uri, currentParts);
          post({ type: "parts", parts: currentParts });
        }
        if (result.annotations !== currentAnnotations) {
          currentAnnotations = result.annotations;
          await writeAnnotations(document.uri, currentAnnotations);
          post({ type: "annotations", annotations: currentAnnotations });
        }
      } catch (err) {
        post({ type: "error", message: `Could not rebind entity ids: ${(err as Error).message}` });
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
      loadModel(true);
    });

    watchForExternalChange(editsSidecarUri(document.uri), () => {
      void (async () => {
        const parsed = await readEdits(document.uri);
        const { ops: resolvedOps } = resolvePlaneRefs(parsed.ops, currentPlanes);
        if (JSON.stringify(resolvedOps) === JSON.stringify(currentEdits) && JSON.stringify(parsed.variables) === JSON.stringify(currentVariables)) {
          return;
        }
        const previousOps = currentEdits;
        currentEdits = resolvedOps;
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

    watchForExternalChange(planesSidecarUri(document.uri), () => {
      void (async () => {
        const planes = await readPlanes(document.uri);
        if (JSON.stringify(planes) === JSON.stringify(currentPlanes)) return;
        currentPlanes = planes;
        post({ type: "planes", planes: currentPlanes });
        post({ type: "status", text: "Construction planes updated externally" });
        const { ops: resolvedOps } = resolvePlaneRefs(currentEdits, currentPlanes);
        if (JSON.stringify(resolvedOps) !== JSON.stringify(currentEdits)) {
          const previousOps = currentEdits;
          currentEdits = resolvedOps;
          if (route && route.strategy === "occt") {
            loadModel();
            void rebindPartsOnChange(previousOps, currentEdits);
          }
          post({ type: "edits", ops: currentEdits, variables: currentVariables });
        }
      })();
    });
    watchForExternalChange(annotationsSidecarUri(document.uri), () => {
      void (async () => {
        const annotations = await readAnnotations(document.uri);
        if (JSON.stringify(annotations) === JSON.stringify(currentAnnotations)) return;
        currentAnnotations = annotations;
        post({ type: "annotations", annotations: currentAnnotations });
        post({ type: "status", text: "Annotations updated externally" });
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
      // Fire-and-forget — nothing depends on this settling before the tab
      // finishes closing (matches every other fire-and-forget cleanup in
      // this method); frees this document's cached OCCT handles inside the
      // shared kernel-worker child, plus the live-operation-preview's
      // separate `::oppreview` entry (same key prefix + suffix convention
      // `handleOpPreview` replays under).
      void this.pipeline.disposeBRepCacheForDocument(documentKey);
      void this.pipeline.disposeBRepCacheForDocument(`${documentKey}::oppreview`);
    });

    // Track this editor as the active one while it is focused, so the
    // File-menu commands/keybindings can reach it.
    const session: EditorSession = {
      uri: document.uri,
      export: () => {
        if (route) this.handleExport(document.uri, route, post, pending, currentEdits, currentParts);
      },
      save: flushSidecars,
      savePreprocess: () => {
        void flushSidecars().then(() => this.handleSavePreprocess(document.uri, post));
      },
      screenshot: () => {
        void this.handleScreenshot(document.uri, post, pending);
      },
      exportSvg: () => {
        if (route) void this.handleExportSvg(document.uri, route, post, currentEdits, currentViewState, "svg", currentAnnotations);
      },
      exportMesh: () => {
        void this.handleExportMesh(document.uri, route, currentEdits, currentMeshOptions, post);
      },
      exportDxf: () => {
        if (route) void this.handleExportSvg(document.uri, route, post, currentEdits, currentViewState, "dxf", currentAnnotations);
      },
      exportDrawing: () => {
        if (route) void this.handleExportSvg(document.uri, route, post, currentEdits, currentViewState, "svg", currentAnnotations, true);
      },
      post,
    };
    this.sessions.set(documentKey, session);
    const track = () => {
      if (webviewPanel.active) this.activeSession = session;
    };
    track();
    webviewPanel.onDidChangeViewState(track);
    webviewPanel.onDidDispose(() => {
      if (this.activeSession === session) this.activeSession = undefined;
      this.sessions.delete(documentKey);
    });

    webviewPanel.webview.onDidReceiveMessage(async (msg: WebviewToHost) => {
      if (msg.type === "ready") {
        if (!route) {
          post({ type: "error", message: `Unsupported file type: ${document.uri.fsPath}` });
          return;
        }
        // Load edits before the model so a B-rep source is tessellated already-edited.
        // Planes are loaded alongside edits so any `planeId` can be resolved
        // before the first tessellation (otherwise a `planeId`-only op would
        // have no cached vectors to fall back on).
        const [parsed, planesInitial] = await Promise.all([readEdits(document.uri), readPlanes(document.uri)]);
        const { ops: resolvedEdits } = resolvePlaneRefs(parsed.ops, planesInitial);
        currentEdits = resolvedEdits;
        currentVariables = parsed.variables;
        currentPlanes = planesInitial;
        loadModel(true);
        post({ type: "edits", ops: currentEdits, variables: currentVariables });
        post({ type: "planes", planes: currentPlanes });
        // The meshio route's own handleMeshio() (above) owns the parts round
        // trip for that route instead (it may need to auto-create Parts from
        // region data first) — calling both would double-post "parts".
        if (!route || route.strategy !== "meshio") {
          void this.sendParts(document.uri, post).then(async (parts) => {
            currentParts = parts;
            // Heal a stale selector cache on open (a part whose query still
            // hits keeps its stored ids; anything else freezes with a status
            // line, same terms as the edit-driven path below). Gated inside
            // resolvePartSelectors to docs carrying no selector at all.
            if (route?.strategy === "occt" && currentParts.some((p) => p.selector !== undefined)) {
              try {
                const bytes = await vscode.workspace.fs.readFile(document.uri);
                const selected = await this.pipeline.resolvePartSelectors(
                  this.context.extensionPath,
                  bytes,
                  route.format as Extract<CadFormat, "step" | "iges" | "brep">,
                  currentEdits,
                  currentParts
                );
                if (selected.parts !== currentParts) {
                  currentParts = selected.parts;
                  await writeParts(document.uri, currentParts);
                  post({ type: "parts", parts: currentParts });
                }
                for (const warning of selected.warnings) post({ type: "status", text: warning });
              } catch (err) {
                post({ type: "error", message: `Could not resolve stored selectors: ${(err as Error).message}` });
              }
            }
          });
        }
        void readAnnotations(document.uri).then((annotations) => {
          currentAnnotations = annotations;
          post({ type: "annotations", annotations: currentAnnotations });
        });
        void this.sendMeshOptions(document.uri, post).then((options) => {
          currentMeshOptions = options;
        });
        void readViewState(document.uri).then((view) => {
          currentViewState = view ?? undefined;
          post({ type: "viewState", view });
        });
        this.sendViewerDefaults(post);
        void this.sendMacros(document.uri, post);
        if (this.camerasLinked) {
          post({ type: "camerasLinked", enabled: true });
        }
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

      if (msg.type === "annotationsChanged") {
        // Debounced autosave, own timer — mirrors partsChanged.
        const annotations: Annotation[] = msg.annotations;
        currentAnnotations = annotations;
        if (annotationsSaveTimer) clearTimeout(annotationsSaveTimer);
        annotationsSaveTimer = setTimeout(() => {
          void writeAnnotations(document.uri, annotations).then(
            undefined,
            (err) => post({ type: "error", message: `Could not save annotations: ${(err as Error).message}` })
          );
        }, PARTS_SAVE_DEBOUNCE_MS);
        return;
      }

      if (msg.type === "planesChanged") {
        // Debounced autosave, own timer — mirrors partsChanged.
        const planes: ConstructionPlane[] = msg.planes;
        currentPlanes = planes;
        if (planesSaveTimer) clearTimeout(planesSaveTimer);
        planesSaveTimer = setTimeout(() => {
          void writePlanes(document.uri, planes).then(
            undefined,
            (err) => post({ type: "error", message: `Could not save construction planes: ${(err as Error).message}` })
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
        if (this.camerasLinked) {
          const camera = {
            viewDirection: msg.view.viewDirection,
            cameraUp: msg.view.cameraUp,
            orthographic: msg.view.orthographic,
          };
          for (const [key, s] of this.sessions) {
            if (key === documentKey) continue;
            s.post({ type: "linkedCamera", camera });
          }
        }
        return;
      }

      if (msg.type === "setCamerasLinked") {
        this.camerasLinked = msg.enabled;
        for (const s of this.sessions.values()) {
          s.post({ type: "camerasLinked", enabled: msg.enabled });
        }
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
          const result = await this.pipeline.generateMesh(this.context.extensionPath, input, options, parts);
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
        await this.runMeshExport(document.uri, route, currentEdits, msg.target, msg.options, msg.stl, msg.unit ?? "mm", post);
        return;
      }

      if (msg.type === "openFile") {
        void this.openFileDialog();
        return;
      }

      // Like `openFile`, this ignores `route` — it creates a document rather
      // than acting on this one.
      if (msg.type === "newBlank") {
        void this.newBlankModelDialog();
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
        if (route) this.handleExport(document.uri, route, post, pending, currentEdits, currentParts);
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

      if (msg.type === "promoteToBrepButtonClicked") {
        if (route) void this.handlePromoteToBrep(document.uri, route, post);
        return;
      }

      if (msg.type === "repairMeshButtonClicked") {
        if (route) void this.handleRepairMesh(document.uri, route, post);
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
          const properties = await this.pipeline.computeMassProperties(
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

      if (msg.type === "macroRun") {
        try {
          const libraryPath = macroLibraryPath(document.uri);
          const library = parseScriptLibraryJson(await readTextFile(libraryPath));
          const entry = library[msg.name];
          if (!entry) throw new Error(`No saved macro named "${msg.name}".`);

          const { script, unknownNames } = mergeScriptOverrides(entry.script, msg.parameters);
          const { values } = evaluateVariables(currentVariables);
          const compiled = compileParametricScript(script, values);
          if (compiled.ops.length === 0) {
            throw new Error(compiled.issues[0] ?? `"${msg.name}" compiled to no ops.`);
          }
          // Straight onto the webview's own op stack, so a macro is undoable,
          // inspectable in the history and removable op-by-op exactly like a
          // hand-applied edit — no special "macro" state for undo to reason about.
          post({ type: "macroApplyOps", ops: compiled.ops });
          const skipped = unknownNames.length > 0 ? ` (ignored unknown parameter(s): ${unknownNames.join(", ")})` : "";
          post({ type: "status", text: `Ran "${msg.name}" — ${compiled.ops.length} op(s)${skipped}.` });
        } catch (err) {
          post({ type: "error", message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "macroSaveCurrent") {
        try {
          if (currentEdits.length === 0) {
            throw new Error("Nothing to save — apply some edits first.");
          }
          const name = await vscode.window.showInputBox({
            title: "Save macro",
            prompt: `Name for this macro (${currentEdits.length} op(s))`,
            placeHolder: "bolt-circle",
            validateInput: (v) => (v.trim() === "" ? "A name is required" : null),
          });
          if (name === undefined) return; // dismissed — a quiet no-op

          const libraryPath = macroLibraryPath(document.uri);
          const library = parseScriptLibraryJson(await readTextFile(libraryPath));
          // The op list IS the recording: "record" is a selection over edits
          // already applied, not a live capture session. The document's own
          // variables come along as the macro's parameters.
          library[name.trim()] = {
            name: name.trim(),
            description: `Recorded from ${currentEdits.length} op(s)`,
            script: {
              variables: currentVariables.map((v) => ({ name: v.name, expr: v.expr })),
              steps: currentEdits.map((op) => ({ op })),
            },
          };
          await vscode.workspace.fs.writeFile(
            vscode.Uri.file(libraryPath),
            Buffer.from(serializeScriptLibraryJson(library), "utf8")
          );
          await this.sendMacros(document.uri, post);
          post({ type: "status", text: `Saved macro "${name.trim()}".` });
        } catch (err) {
          post({ type: "error", message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "macroDelete") {
        try {
          const libraryPath = macroLibraryPath(document.uri);
          const library = parseScriptLibraryJson(await readTextFile(libraryPath));
          delete library[msg.name];
          await vscode.workspace.fs.writeFile(
            vscode.Uri.file(libraryPath),
            Buffer.from(serializeScriptLibraryJson(library), "utf8")
          );
          await this.sendMacros(document.uri, post);
          post({ type: "status", text: `Deleted macro "${msg.name}".` });
        } catch (err) {
          post({ type: "error", message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "entityFactsRequest") {
        try {
          if (!route || route.strategy !== "occt") {
            throw new Error("Geometry classification requires a B-rep source; a mesh has no analytic surface type.");
          }
          const bytes = await vscode.workspace.fs.readFile(document.uri);
          const facts = await this.pipeline.getEntityFacts(
            this.context.extensionPath,
            bytes,
            route.format as Extract<CadFormat, "step" | "iges" | "brep">,
            currentEdits,
            msg.entityId
          );
          post({ type: "entityFactsResult", requestId: msg.requestId, facts });
        } catch (err) {
          post({ type: "entityFactsError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "selectorSynthesizeRequest") {
        try {
          if (!route || route.strategy !== "occt") {
            throw new Error("Pinning an operand as a query requires a B-rep source; mesh sources have no produced-face classification to induce from.");
          }
          if (msg.entityIds.length === 0 || msg.entityIds.length > 25) {
            throw new Error(`Cannot synthesize queries for ${msg.entityIds.length} entities — pick between 1 and 25.`);
          }
          const bytes = await vscode.workspace.fs.readFile(document.uri);
          const format = route.format as Extract<CadFormat, "step" | "iges" | "brep">;
          const results: SelectorSynthesizeResultEntry[] = [];
          for (const entityId of msg.entityIds) {
            try {
              const r = await this.pipeline.synthesizeSelector(
                this.context.extensionPath,
                bytes,
                format,
                currentEdits,
                msg.op,
                msg.role,
                entityId
              );
              // The kind tag is stamped here from the producing op itself —
              // server-derived (the `set_part` precedent), never caller-supplied.
              results.push({ entityId, query: r.query, kind: r.query ? currentEdits[msg.op]?.op ?? null : null, reason: r.reason });
            } catch (err) {
              results.push({ entityId, query: null, kind: null, reason: (err as Error).message });
            }
          }
          post({ type: "selectorSynthesizeResult", requestId: msg.requestId, results });
        } catch (err) {
          post({ type: "selectorSynthesizeError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "standardPartsSearchRequest") {
        try {
          const result = await this.pipeline.searchStandardParts({ q: msg.q, page: msg.page, pageSize: 20 });
          if (!result.available) throw new Error(result.reason);
          post({
            type: "standardPartsSearchResult",
            requestId: msg.requestId,
            items: result.value.items,
            page: result.value.page,
            totalPages: result.value.totalPages,
            total: result.value.total,
          });
        } catch (err) {
          post({ type: "standardPartsSearchError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "standardPartsInsertRequest") {
        try {
          const downloaded = await this.pipeline.downloadStandardPart(msg.id);
          if (!downloaded.available) throw new Error(downloaded.reason);
          const defaultUri = vscode.Uri.joinPath(document.uri, "..", msg.suggestedName);
          const saveUri = await vscode.window.showSaveDialog({ defaultUri, filters: { "STEP files": ["step", "stp"] } });
          if (!saveUri) {
            post({ type: "standardPartsInsertResult", requestId: msg.requestId, path: null });
            return;
          }
          await vscode.workspace.fs.writeFile(saveUri, downloaded.value.bytes);
          post({ type: "standardPartsInsertResult", requestId: msg.requestId, path: saveUri.fsPath });
          await this.openPathInEditor(saveUri.fsPath);
        } catch (err) {
          post({ type: "standardPartsInsertError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "importSvgRequest") {
        try {
          const svgUris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: "Import SVG",
            filters: { "SVG files": ["svg"] },
          });
          const svgUri = svgUris?.[0];
          if (!svgUri) return; // dialog dismissed — a quiet no-op, not an error
          const bytes = await vscode.workspace.fs.readFile(svgUri);
          post({ type: "importSvgResult", text: Buffer.from(bytes).toString("utf8") });
        } catch (err) {
          post({ type: "importSvgError", message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "exportSvgRequest") {
        if (route) void this.handleExportSvg(document.uri, route, post, currentEdits, currentViewState, "svg", currentAnnotations);
        return;
      }

      if (msg.type === "importDxfRequest") {
        try {
          const dxfUris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: "Import DXF",
            filters: { "DXF files": ["dxf"] },
          });
          const dxfUri = dxfUris?.[0];
          if (!dxfUri) return;
          const bytes = await vscode.workspace.fs.readFile(dxfUri);
          post({ type: "importDxfResult", text: Buffer.from(bytes).toString("utf8") });
        } catch (err) {
          post({ type: "importDxfError", message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "exportDxfRequest") {
        if (route) void this.handleExportSvg(document.uri, route, post, currentEdits, currentViewState, "dxf", currentAnnotations);
        return;
      }

      if (msg.type === "exportDrawingRequest") {
        if (route) void this.handleExportSvg(document.uri, route, post, currentEdits, currentViewState, "svg", currentAnnotations, true);
        return;
      }

      if (msg.type === "measureExactRequest") {
        try {
          if (!route || route.strategy !== "occt") {
            throw new Error("Exact measurement requires a B-rep source; mesh sources have no host-side geometry to re-derive it from.");
          }
          const bytes = await vscode.workspace.fs.readFile(document.uri);
          const result = await this.pipeline.measureExact(
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

      if (msg.type === "opPreviewRequest") {
        void this.handleOpPreview(document.uri, route, post, currentEdits, documentKey, msg.requestId, msg.op);
        return;
      }

      if (msg.type === "colorFieldRequest") {
        try {
          if (!route || route.strategy !== "meshio") {
            throw new Error("Colour-by-field is only available for meshio++-imported sources (VTK/MED/CGNS/Exodus/XDMF/MDPA).");
          }
          const bytes = await vscode.workspace.fs.readFile(document.uri);
          const result = await this.pipeline.readMeshioFieldValues(bytes, route.format, msg.field, msg.kind);
          // The failure now carries WHY, so the user gets the one real cause
          // instead of the three-way disjunction this used to guess at.
          if (isMeshioFieldFailure(result)) throw new Error(describeMeshioFieldFailure(result.reason, msg.field));
          post({ type: "colorFieldResult", requestId: msg.requestId, values: encodeBuffer(result.values), min: result.min, max: result.max });
        } catch (err) {
          post({ type: "colorFieldError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "meshHealRequest") {
        try {
          if (!route || route.strategy !== "three") {
            throw new Error("Mesh healability check requires an STL/OBJ/PLY/glTF source.");
          }
          const bytes = await vscode.workspace.fs.readFile(document.uri);
          const report = await this.pipeline.checkMeshHealth(
            this.context.extensionPath,
            bytes,
            route.format as MeshParseFormat,
            await resolveGltfBuffersFor(document.uri, route.format, bytes)
          );
          post({ type: "meshHealResult", requestId: msg.requestId, report });
        } catch (err) {
          post({ type: "meshHealError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "fitRegionRequest") {
        try {
          if (!route || route.strategy !== "three") {
            throw new Error("Region fitting requires an STL/OBJ/PLY/glTF source.");
          }
          const bytes = await vscode.workspace.fs.readFile(document.uri);
          const fit = await this.pipeline.fitMeshRegion(
            bytes,
            route.format as MeshParseFormat,
            msg.point,
            {},
            await resolveGltfBuffersFor(document.uri, route.format, bytes)
          );
          post({ type: "fitRegionResult", requestId: msg.requestId, fit });
        } catch (err) {
          post({ type: "fitRegionError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }
    });

    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);
  }

  /**
   * `documentKey` identifies this document to the kernel-worker child's own
   * cache (roadmap "Base-shape caching and incremental replay", closed, now
   * living entirely inside the child as of "OCCT in a forked child process"
   * Phase 2 — see `kernelClient.ts`'s `DocumentPipeline.
   * loadBRepCachedForDocument` doc comment for the reuse rules; this method
   * no longer sees or manages a `BRepCacheEntry` at all, since live OCCT
   * handles can never cross the IPC boundary).
   *
   * `generation`/`genHolder` implement the stale-result-discard safety net
   * documented on `brepLoadGeneration` in `resolveCustomEditor` — every
   * `return`/`post` past the `loadBRepCachedForDocument` await first checks
   * `generation === genHolder.current`, and silently does nothing (no post)
   * when it doesn't: a newer `loadModel()` call has since started, or the
   * user cancelled via `progress`'s notification (whose
   * `onCancellationRequested` handler already bumped `genHolder.current`,
   * posted its own "Cancelled" status, and killed the shared kernel-worker
   * child — this method must not post a second, possibly-conflicting
   * status/result after that). `progress` is present only for the two call
   * sites that opt into a native progress notification (see `loadModel`'s
   * doc comment) — every `progress.report` call is additionally guarded by
   * `progress &&` since it's `undefined` on a routine, no-notification edit
   * re-tessellation.
   */
   private async handleBRep(
    uri: vscode.Uri,
    format: Extract<CadFormat, "step" | "iges" | "brep">,
    post: (msg: HostToWebview) => void,
    ops: EditOp[] = [],
    documentKey: string,
    generation: number,
    genHolder: { current: number },
    autoFit = true,
    progress?: vscode.Progress<{ message?: string }>
  ): Promise<void> {
    try {
      post({ type: "status", text: `Loading ${format.toUpperCase()} kernel…` });
      progress?.report({ message: `Loading ${format.toUpperCase()} kernel…` });
      const bytes = await vscode.workspace.fs.readFile(uri);
      post({ type: "status", text: `Tessellating ${format.toUpperCase()}…` });
      progress?.report({ message: `Tessellating ${format.toUpperCase()}…` });
      // Re-read fresh on every call (cheap) rather than cached at document-open
      // time — a mid-session settings change should take effect on the NEXT
      // edit without needing to reopen the tab, same as every other
      // `cadPreview.*` setting's "always re-read" convention.
      const quality = normalizeTessellationQuality(
        vscode.workspace.getConfiguration("cadPreview").get("tessellationQuality")
      );
      const result = await this.pipeline.loadBRepCachedForDocument(
        documentKey,
        this.context.extensionPath,
        bytes,
        format,
        ops,
        tessellationParamsFor(quality)
      );
      if (generation !== genHolder.current) return; // superseded or cancelled — see doc comment above
      post({ type: "status", text: "Rendering…" });
      progress?.report({ message: "Rendering…" });
      const { groups, edges, points, tree, opOutcomes, opBuckets, guideIds, queryWarnings } = result;
      // A frozen operand query replays on its cached ids — the user must know
      // the query was not honored rather than staring at unchanged geometry.
      for (const w of queryWarnings ?? []) post({ type: "status", text: w });
      post({
        type: "geometry",
        autoFit,
        opOutcomes,
        guideIds,
        opBuckets,
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
          smooth: e.smooth,
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
      if (generation !== genHolder.current) return; // superseded or cancelled — see doc comment above
      // No cache to drop here anymore — the kernel-worker child owns its own
      // cache entry for `documentKey` entirely internally
      // (`loadBRepCachedForDocument`'s doc comment covers what happens to it
      // on a thrown error there), so this method has nothing left to clean
      // up on failure beyond reporting it.
      post({ type: "error", message: `${format.toUpperCase()} error: ${(err as Error).message}` });
    }
  }

  /**
   * Live operation preview (roadmap item, closed) — replays the document's
   * current ops PLUS the webview's not-yet-committed draft op and posts the
   * resulting geometry back as `opPreviewResult`, for a tinted overlay in
   * front of the unchanged model. Purely speculative, on every axis:
   *
   * - **Separate cache key** (`documentKey + "::oppreview"`): the preview's
   *   replays never evict or interleave with the real document's
   *   `loadBRepCachedForDocument` entry; both live independently inside the
   *   kernel-worker child. The preview entry is disposed alongside the real
   *   one when the tab closes (see `onDidDispose`).
   * - **Nothing is persisted** — no sidecar write, no op-stack mutation; the
   *   draft op exists only inside this replay. The CAD file stays read-only.
   * - **B-rep sources only** — mesh sources never send this request at all;
   *   their preview is entirely client-side (`applyEditsMesh` over a clone of
   *   the pristine mesh). The gate here is defensive: an unexpected sender
   *   gets a clear `opPreviewError`, never a silent misroute.
   * - The draft op re-runs through `validateEditOp` host-side (the single
   *   tolerance gate — the webview already validated its own copy, but this
   *   module trusts no wire input), and a rejected op is reported back rather
   *   than replayed.
   *
   * Stale-result discarding is the WEBVIEW's job here (requestId + generation
   * guard around typing bursts — see main.ts's scheduler), so unlike
   * `handleBRep` there is no `brepLoadGeneration` check: whichever request
   * the webview still considers current renders, and it ignores the rest.
   */
  private async handleOpPreview(
    uri: vscode.Uri,
    route: FileRoute | undefined,
    post: (msg: HostToWebview) => void,
    ops: EditOp[],
    documentKey: string,
    requestId: string,
    draftOp: EditOp
  ): Promise<void> {
    try {
      if (!route || route.strategy !== "occt") {
        throw new Error("Live preview requires a B-rep source; mesh sources preview client-side and never send this request.");
      }
      const clean = validateEditOp(draftOp);
      if (!clean) throw new Error("The drafted operation is invalid and cannot be previewed.");
      const planesForPreview = await readPlanes(uri).catch(() => [] as ConstructionPlane[]);
      const resolvedDraft = resolvePlaneRefs([clean], planesForPreview).ops[0] ?? clean;
      const resolvedOps = resolvePlaneRefs(ops, planesForPreview).ops;
      const bytes = await vscode.workspace.fs.readFile(uri);
      const quality = normalizeTessellationQuality(
        vscode.workspace.getConfiguration("cadPreview").get("tessellationQuality")
      );
      const result = await this.pipeline.loadBRepCachedForDocument(
        `${documentKey}::oppreview`,
        this.context.extensionPath,
        bytes,
        route.format as Extract<CadFormat, "step" | "iges" | "brep">,
        [...resolvedOps, resolvedDraft],
        tessellationParamsFor(quality)
      );
      post({
        type: "opPreviewResult",
        requestId,
        meshes: result.groups.flatMap((g) =>
          g.faces.map((f) => ({
            positions: encodeBuffer(f.buffers.positions),
            indices: encodeBuffer(f.buffers.indices),
            groupId: g.id,
            faceId: f.faceId,
          }))
        ),
        edges: result.edges.map((e) => ({
          positions: encodeBuffer(e.positions),
          edgeId: e.edgeId,
          smooth: e.smooth,
        })),
        points: result.points.map((p) => ({
          position: encodeBuffer(new Float32Array(p.position)),
          pointId: p.pointId,
        })),
        opOutcomes: result.opOutcomes,
      });
    } catch (err) {
      post({ type: "opPreviewError", requestId, message: (err as Error).message });
    }
  }

  /**
   * meshio++-only formats (VTK/MED/CGNS/Exodus/XDMF/MDPA/OpenFOAM) — converts
   * the raw file to an STL boundary surface and posts it as `loadMeshBytes`,
   * letting the webview treat it exactly like a native `.stl` open. See
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
      const isFoam = format === "openfoam";
      const basename = uri.path.slice(uri.path.lastIndexOf("/") + 1);
      if (!isFoam) {
        const ambiguityCaveat = ambiguityCaveatFor(basename);
        if (ambiguityCaveat) post({ type: "status", text: ambiguityCaveat });
      }
      const bytes = isFoam ? undefined : await vscode.workspace.fs.readFile(uri);
      const companions = isFoam ? undefined : await resolveMeshioCompanionsFor(uri, basename, format, bytes!);
      const [boundary, metadata, existingParts] = await Promise.all([
        // OpenFOAM is the one format that is NOT a single file — a `.foam`
        // marker's real mesh lives in sibling files under
        // `<parent>/constant/polyMesh/`, staged into meshio++'s MEMFS by
        // `convertFoamCaseToStlBoundary` itself (it takes the marker's path,
        // not bytes). Its reader also surfaces no regions/data to JS (patch
        // names ride an unexposed C++ side-channel), so the region
        // correlation below cannot fire for it by construction.
        isFoam
          ? this.pipeline.convertFoamCaseToStlBoundary(uri.fsPath).then((stlBytes) => ({ stlBytes, regions: undefined }))
          : this.pipeline.convertToStlBoundaryWithRegions(bytes!, format, basename, companions!),
        isFoam ? EMPTY_MESHIO_METADATA : this.pipeline.readMeshioMetadata(bytes!, format, basename, companions!),
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
      // Per-array facts, ONLY when the source declares point/cell arrays.
      // `dataInfo` needs a full `readMesh`, so a document with no fields must
      // not pay for one — and a document that has them would have paid the
      // same read on the first colour-by-field click anyway. Never throws.
      const hasDataArrays = metadata.pointDataNames.length > 0 || metadata.cellDataNames.length > 0;
      const arrays = hasDataArrays && !isFoam
        ? await this.pipeline.readMeshioDataInfo(bytes!, format, basename, companions!)
        : [];
      post({
        type: "loadMeshBytes",
        sourceFormat: format,
        dataBase64: Buffer.from(boundary.stlBytes).toString("base64"),
        meshioMetadata: hasMetadata ? { ...metadata, arrays: arrays.length > 0 ? arrays : undefined } : undefined,
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
  /**
   * Posts the saved-macro list for this document's folder.
   *
   * The library lives beside the model as `cad-preview-macros.json`, shared by
   * every model in that folder — the same file the MCP tools take as an
   * explicit `libraryPath`, so a macro recorded here is directly runnable by an
   * agent and vice versa. A missing library reads as empty, never an error.
   */
  private async sendMacros(uri: vscode.Uri, post: (msg: HostToWebview) => void): Promise<void> {
    const library = parseScriptLibraryJson(await readTextFile(macroLibraryPath(uri)));
    const macros = Object.values(library)
      .map((entry) => ({
        name: entry.name,
        description: entry.description ?? null,
        parameters: scriptParameters(entry.script),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    post({ type: "macros", macros });
  }

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
      const stepBytes = await this.pipeline.exportBRep(
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
    ops: EditOp[] = [],
    parts: Part[] = []
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
        return this.pipeline.exportBRep(
          this.context.extensionPath,
          sourceBytes,
          route.format as Extract<CadFormat, "step" | "iges" | "brep">,
          targetFormat as Extract<CadFormat, "step" | "iges" | "brep">,
          ops,
          unit,
          true,
          parts
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
   * "Mesh → B-rep promotion" (roadmap item, closed), Phase 2 — the Mesh
   * Health panel's "Promote to B-rep…" button. Deliberately a ONE-SHOT
   * EXPORT (sew the mesh into a solid, write it as a brand-new STEP/IGES/
   * BREP file the user opens separately), not an in-place reclassification
   * of THIS document — see CLAUDE.md's "Mesh → B-rep promotion" section for
   * why. Mirrors `handleExport`'s exact structure (format quick-pick over
   * the same `BREP_FORMATS`, the existing `pickExportUnit()`, the shared
   * `promptSaveAndWrite()` for the save dialog + write + status/error
   * posting) with a new `getBytes` callback calling
   * `this.pipeline.promoteMeshToBrep` instead of `exportBRep`. Known,
   * accepted simplification: `promptSaveAndWrite`'s own generic "Exported
   * to …" status message is reused as-is — a component that was skipped
   * (never closed) is NOT separately called out here in the interactive
   * flow, since the user already saw that in the Mesh Health panel's report
   * before clicking Promote; the MCP tool's `skippedComponents`/`warnings`
   * fields remain the authoritative, always-surfaced signal for headless
   * callers.
   */
  private async handlePromoteToBrep(uri: vscode.Uri, route: FileRoute, post: (msg: HostToWebview) => void): Promise<void> {
    if (route.strategy !== "three") {
      post({ type: "error", message: "Promote to B-rep requires an STL/OBJ/PLY/glTF source." });
      return;
    }
    const meshFormat = route.format as MeshParseFormat;

    const picked = await vscode.window.showQuickPick(
      [...BREP_FORMATS].map((format) => ({
        label: EXPORT_LABEL[format],
        description: `.${EXPORT_EXTENSION[format]}`,
        format: format as Extract<CadFormat, "step" | "iges" | "brep">,
      })),
      { placeHolder: "Promote to B-rep as…" }
    );
    if (!picked) return;

    const unit = await this.pickExportUnit();

    await this.promptSaveAndWrite(
      uri,
      EXPORT_EXTENSION[picked.format],
      EXPORT_LABEL[picked.format],
      async (_saveUri) => {
        const sourceBytes = await vscode.workspace.fs.readFile(uri);
        const result = await this.pipeline.promoteMeshToBrep(
          this.context.extensionPath,
          sourceBytes,
          meshFormat,
          picked.format,
          unit,
          await resolveGltfBuffersFor(uri, meshFormat, sourceBytes)
        );
        return result.bytes;
      },
      post
    );
  }

  /**
   * "Robust volumetric meshing from a skin mesh", Phase 3 (roadmap item,
   * closed) — the Mesh Health panel's **Repair (robust)** button. Writes a
   * NEW watertight STL file at a save-dialog-chosen path by tetrahedralizing
   * the source mesh with fTetWild and taking the resulting volume mesh's own
   * boundary — watertight/manifold by construction regardless of how broken
   * the input was, closing the exact gap `check_mesh_health`'s report
   * surfaces and `promote_mesh_to_brep` then fails on. Mirrors
   * `handlePromoteToBrep`'s structure but simpler — always an STL, no
   * format/unit quick-picks — and the natural next step is re-running Check
   * Healability / Promote to B-rep on the repaired output (not automated
   * here; the user reviews the repair first, same "review before acting on
   * it" precedent every other Mesh Health action follows).
   */
  private async handleRepairMesh(uri: vscode.Uri, route: FileRoute, post: (msg: HostToWebview) => void): Promise<void> {
    if (route.strategy !== "three") {
      post({ type: "error", message: "Repair (robust) requires an STL/OBJ/PLY/glTF source." });
      return;
    }
    const meshFormat = route.format as MeshParseFormat;

    await this.promptSaveAndWrite(
      uri,
      "stl",
      "STL",
      async (_saveUri) => {
        const sourceBytes = await vscode.workspace.fs.readFile(uri);
        const result = await this.pipeline.repairMesh(
          this.context.extensionPath,
          sourceBytes,
          meshFormat,
          await resolveGltfBuffersFor(uri, meshFormat, sourceBytes)
        );
        return result.stlBytes;
      },
      post
    );
  }

  /**
   * "SVG silhouette export" (roadmap item, closed) — File ▸ Export Silhouette
   * SVG… and the `cad-preview.exportSvg` command.
   *
   * Mirrors `handlePromoteToBrep`'s structure (quick-picks, then the shared
   * `promptSaveAndWrite`), with one addition: a view quick-pick whose first
   * entry is **Current view**, taken from `currentViewState` — the same
   * `viewChanged`-tracked state the `.view.json` sidecar already persists, so
   * "draw it the way I'm looking at it" needs no new protocol message at all.
   *
   * Escape on the VIEW pick cancels the export (it's the primary choice),
   * unlike `pickExportUnit`'s Escape, which deliberately falls through to mm
   * rather than cancelling.
   *
   * Deliberately NOT folded into `handleExport`/`CadFormat`: an `"svg"` format
   * member would ripple through `EXPORT_EXTENSION`/`EXPORT_LABEL`/
   * `exportTargetsFor`/`fileRouter.ts` and — worst — into `package.json`'s
   * `customEditors.selector`, which would make VS Code try to OPEN `.svg`
   * files in the 3D viewer, colliding head-on with Import SVG…. `handleScreenshot`
   * is the established precedent for an output format that isn't a `CadFormat`.
   */
  private async handleExportSvg(
    uri: vscode.Uri,
    route: FileRoute,
    post: (msg: HostToWebview) => void,
    ops: EditOp[],
    viewState: ViewState | undefined,
    format: "svg" | "dxf" = "svg",
    annotations: Annotation[] = [],
    /** Produce a technical DRAWING (hidden-line removal) rather than an
     * outline. Shares this whole view/unit/save flow deliberately — the only
     * difference is what the pipeline draws. */
    hiddenLines = false
  ): Promise<void> {
    if (route.strategy !== "occt" && !COMPARABLE_MESH_FORMATS.has(route.format)) {
      const label = format.toUpperCase();
      post({ type: "error", message: `Silhouette ${label} export requires a STEP/IGES/BREP or STL/OBJ/PLY/glTF source.` });
      return;
    }

    type ViewChoice = { label: string; description?: string; direction: [number, number, number]; up?: [number, number, number] };
    const choices: ViewChoice[] = [];
    if (viewState) {
      choices.push({
        label: "Current view",
        description: "as shown in the 3D view",
        direction: viewState.viewDirection,
        up: viewState.cameraUp,
      });
    }
    for (const [name, view] of Object.entries(SVG_VIEWS)) {
      choices.push({ label: name.charAt(0) + name.slice(1).toLowerCase(), description: `[${view.direction.join(", ")}]`, ...view });
    }

    const picked = await vscode.window.showQuickPick(choices, { placeHolder: "Silhouette view…" });
    if (!picked) return; // the primary choice — Escape cancels the export

    const unit = await this.pickExportUnit();
    const ext = format;
    const filterLabel = format === "dxf" ? "DXF Drawing" : "SVG Drawing";

    await this.promptSaveAndWrite(
      uri,
      ext,
      filterLabel,
      async () => {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const source: CompareSource =
          route.strategy === "occt"
            ? { kind: "brep", bytes, format: route.format as Extract<CadFormat, "step" | "iges" | "brep">, ops }
            : route.format === "gltf"
              ? { kind: "gltf", bytes, externalBuffers: await resolveGltfBuffersFor(uri, route.format, bytes) }
              : { kind: route.format as "stl" | "obj" | "ply", bytes };
        const result = await this.pipeline.exportSvgSilhouette(this.context.extensionPath, source, {
          direction: picked.direction,
          up: picked.up,
          unit,
          title: `${uri.path.slice(uri.path.lastIndexOf("/") + 1)} — ${picked.label}`,
          format,
          annotations,
          hiddenLines,
        });
        for (const warning of result.warnings) post({ type: "status", text: warning });
        const content = format === "dxf" ? (result.dxf ?? result.svg) : result.svg;
        return Buffer.from(content, "utf8");
      },
      post
    );
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
   * The FE-mesh export pipeline, shared by the webview's Export button (the
   * `meshingExport` message) and the `cad-preview.exportMesh` command.
   *
   * Extracted so the command is not a second copy of the
   * generate → `via` dispatch → `promptSaveAndWrite` chain. `stl` is the
   * webview-serialized geometry, needed ONLY for mesh-format sources: for a
   * B-rep source `resolveMeshInput` re-exports the live OCCT shape itself and
   * ignores this argument entirely, which is what lets the command call in with
   * `undefined`.
   */
  private async runMeshExport(
    uri: vscode.Uri,
    route: FileRoute | undefined,
    ops: EditOp[],
    target: MeshExportFormatId,
    meshOptions: MeshOptions,
    stl: string | undefined,
    unit: DisplayUnit,
    post: (msg: HostToWebview) => void
  ): Promise<void> {
      try {
        const input = await this.resolveMeshInput(uri, route, ops, stl, unit);
        if (!input) {
          post({ type: "meshingError", message: "No mesh geometry available: missing STL data." });
          return;
        }
        const { parts, options } = await this.resolveMeshPartsAndOptions(uri, input, meshOptions, unit);
        if (target === "msh") {
          const result = await this.pipeline.generateMesh(this.context.extensionPath, input, options, parts);
          await this.promptSaveAndWrite(
            uri,
            "msh",
            "GMSH Mesh",
            async () => Buffer.from(result.mshText, "utf8"),
            post
          );
        } else if (target === "geoUnrolled") {
          const geo = await this.pipeline.exportGeoUnrolled(this.context.extensionPath, input, options, parts);
          await this.promptSaveAndWrite(
            uri,
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
        } else if (target === "mdpaElements" || target === "mdpaGeometries") {
          // Kratos MDPA is hand-serialized (no gmsh.write() support at all — see
          // exportMdpa's doc comment), unlike every other format below.
          const format = meshExportFormat(target)!;
          const text = await this.pipeline.exportMdpa(
            this.context.extensionPath,
            input,
            options,
            parts,
            target === "mdpaElements" ? "elements" : "geometries"
          );
          await this.promptSaveAndWrite(
            uri,
            format.extension,
            format.filterLabel,
            async () => Buffer.from(text, "utf8"),
            post
          );
        } else if (meshExportFormat(target)?.via === "meshio") {
          // meshio++ bridge — registry-driven (`meshExportFormats.ts`'s
          // `via` field), covering every id Gmsh's own writers can't
          // produce (originally just MED/CGNS/XDMF, now also VTU/HMF/AVS
          // UCD/Mphtxt/Netgen/FLAC3D/WKT/Flux — see that file's doc
          // comment for the live-WASM verification each addition needed).
          // Re-encodes via `meshioService.ts`'s exportViaMeshio(), fed
          // generateMesh()'s own MSH 4.1 mshText directly (meshio++ 9.7.0+
          // reads 4.1 natively, physical groups included — see
          // exportViaMeshio's doc comment).
          const format = meshExportFormat(target)!;
          const meshed = await this.pipeline.generateMesh(this.context.extensionPath, input, options, parts);
          const sourceName = uri.path.slice(uri.path.lastIndexOf("/") + 1);
          const { bytes, companion } = await this.pipeline.exportViaMeshio(meshed.mshText, target, {
            extension: format.extension,
            companionExtension: format.companion?.extension,
            // Omitted rather than fabricated if the document somehow has no
            // route — an unknown origin is better left unrecorded than
            // recorded as a guess.
            source: route ? { name: sourceName, format: route.format } : undefined,
          });
          await this.promptSaveAndWrite(
            uri,
            format.extension,
            format.filterLabel,
            async (saveUri) => {
              if (!companion) return Buffer.from(bytes);
              // Companion file — written beside the chosen save path under
              // the matching stem. Whether the primary also needs editing is
              // the registry's `linkage` call, not a per-format branch here:
              // XDMF names its `.h5` in its own <DataItem> elements, so that
              // reference is rewritten to the real saved name; GiD's
              // `.post.res` is found by stem convention alone, so its primary
              // must be left byte-for-byte untouched.
              const saveName = saveUri.path.slice(saveUri.path.lastIndexOf("/") + 1);
              const companionName = companionSaveName(saveName, format)!;
              const companionUri = vscode.Uri.joinPath(saveUri, "..", companionName);
              await vscode.workspace.fs.writeFile(companionUri, companion.bytes);
              if (format.companion?.linkage === "sibling") return Buffer.from(bytes);
              const fixedText = Buffer.from(bytes).toString("utf8").split(companion.name).join(companionName);
              return Buffer.from(fixedText, "utf8");
            },
            post
          );
        } else {
          // Every other registered format (VTK/UNV/Abaqus/Nastran/SU2/etc.) — a
          // plain generate-then-write with no companion file, see `exportMeshFormat`.
          const format = meshExportFormat(target);
          if (!format) throw new Error(`Unknown mesh export format: ${target}`);
          const text = await this.pipeline.exportMeshFormat(this.context.extensionPath, input, options, parts, target);
          await this.promptSaveAndWrite(
            uri,
            format.extension,
            format.filterLabel,
            async () => Buffer.from(text, "utf8"),
            post
          );
        }
      } catch (err) {
        post({ type: "error", message: `Export failed: ${(err as Error).message}` });
      }
  }

  /**
   * `cad-preview.exportMesh` — generate and export an FE mesh from the focused
   * document.
   *
   * Fills a real command-coverage gap: Export, Export Silhouette SVG/DXF,
   * Screenshot and Save/Load Preprocess all have commands, but FE-mesh export
   * was reachable only by clicking the FE Mesh panel's own Export button. That
   * also made it the one export flow the integration suite could not reach,
   * since a test cannot post into a webview.
   *
   * **B-rep sources only.** A mesh-format source's geometry lives in the
   * webview (the panel's button sends it as a serialized STL), and the host has
   * no mesh engine of its own on this path — so rather than fail opaquely, say
   * which control to use. (`mcpTools.ts`'s `resolveMeshInputHeadless` does
   * resolve mesh sources host-side; reusing it here needs that resolver lifted
   * out of the MCP layer, which is a separate refactor.)
   */
  private async handleExportMesh(
    uri: vscode.Uri,
    route: FileRoute | undefined,
    ops: EditOp[],
    meshOptions: MeshOptions | undefined,
    post: (msg: HostToWebview) => void
  ): Promise<void> {
    if (!route || route.strategy !== "occt") {
      post({
        type: "status",
        text: "FE mesh export from the Command Palette needs a B-rep source (STEP/IGES/BREP) — use the FE Mesh panel's Export button for this document.",
      });
      return;
    }
    const picked = await vscode.window.showQuickPick(
      MESH_EXPORT_FORMATS.map((f) => ({ label: f.label, id: f.id })),
      { placeHolder: "Export FE mesh as…" }
    );
    if (!picked) return;
    const unit = await this.pickExportUnit();
    // The closure copy is kept in sync (hydrated on `ready`, updated on every
    // `meshingChanged`), but a document whose panel was never touched may not
    // have one yet — fall back to the sidecar, same source the panel reads.
    const options = meshOptions ?? (await readMeshOptions(uri));
    await this.runMeshExport(uri, route, ops, picked.id as MeshExportFormatId, options, undefined, unit, post);
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
   * Packages the CAD source plus whichever of its parts/planes/annotations/edits/
   * mesh-options sidecars exist on disk into a single `.zip` (File ▸ Save
   * Preprocess…), with a per-entry SHA-256 checksum recorded in the manifest
   * (roadmap "Archive integrity", closed). Callers must flush pending
   * debounced sidecar writes first (see the two call sites) so the archive
   * reflects the latest in-memory state, not a stale on-disk one; which
   * sidecars are included is otherwise purely file-existence-driven — a
   * sidecar that was never created (e.g. no meshing options ever set) is
   * simply omitted, never a hard error. The generated `.geo` script is
   * deliberately NOT packaged — see `buildPreprocessZip`'s doc comment.
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
      const [source, parts, annotations, planes, edits, meshOptions] = await Promise.all([
        vscode.workspace.fs.readFile(uri),
        readOptional(sidecarUri(uri)),
        readOptional(annotationsSidecarUri(uri)),
        readOptional(planesSidecarUri(uri)),
        readOptional(editsSidecarUri(uri)),
        readOptional(meshOptionsSidecarUri(uri)),
      ]);
      const zipBytes = buildPreprocessZip({ sourceName, source, parts, annotations, planes, edits, meshOptions });
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
   * rather than a webview `post`. `readPreprocessZip` itself already rejects
   * a corrupted/tampered archive (checksum mismatch) or one requiring a
   * newer reader before this method ever runs (roadmap "Archive integrity",
   * closed). The `.geo` script is not restored verbatim (it's no longer
   * even packaged); mesh options are re-written through
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

      // The save dialog's filter is advisory, not enforced by every OS — a
      // user can still type/pick a different extension (roadmap "Archive
      // integrity", closed: restoring a STEP archive to `restored.stl` used
      // to succeed silently). Reject a genuine pipeline mismatch rather than
      // writing bytes the destination's own extension can't actually open;
      // aliases of the same format (`.stp`/`.step`) still compare equal,
      // since routeFile() maps both to the same FileRoute.format.
      const sourceRoute = routeFile(contents.manifest.source);
      const destRoute = routeFile(destUri.path);
      if (!destRoute || !sourceRoute || destRoute.format !== sourceRoute.format) {
        void vscode.window.showErrorMessage(
          `Cannot restore "${contents.manifest.source}" (${sourceRoute?.format ?? "unrecognized"}) to "${destUri.path.slice(destUri.path.lastIndexOf("/") + 1)}" (${destRoute?.format ?? "unrecognized"}) — the destination file extension doesn't match the archive's source format.`
        );
        return;
      }

      await vscode.workspace.fs.writeFile(destUri, contents.source);
      if (contents.parts !== undefined) {
        await writeParts(destUri, parsePartsJson(contents.parts));
      }
      if (contents.planes !== undefined) {
        await writePlanes(destUri, parsePlanesJson(contents.planes));
      }
      if (contents.annotations !== undefined) {
        await writeAnnotations(destUri, parseAnnotationsJson(contents.annotations));
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

/**
 * The saved-macro library beside a model: `cad-preview-macros.json` in the
 * model's own folder, shared by every model there.
 *
 * A folder-level path rather than a per-model one because a macro is reusable
 * BY DEFINITION — tying it to one document would defeat the point — and an
 * explicit filename rather than a hidden convention so it can be checked into a
 * project alongside its models, and named directly to the MCP tools'
 * `libraryPath`.
 */
function macroLibraryPath(modelUri: vscode.Uri): string {
  return path.join(path.dirname(modelUri.fsPath), "cad-preview-macros.json");
}

/** Reads a text file, or `""` when it is missing/unreadable — the same
 * bare-catch tolerance every sidecar read in this codebase uses. */
async function readTextFile(filePath: string): Promise<string> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return "";
  }
}
