import * as vscode from "vscode";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { routeFile } from "./fileRouter";
import { showDrawingSheetForm } from "./drawingSheetForm";
import { resolveSheetSettings, type ResolvedSheetSettings, type SheetSettingsInput } from "./sheetSettings";
import {
  USER_SHEET_TEMPLATES_FILE,
  bundledSheetTemplatesPath,
  mergeSheetTemplates,
  parseSheetTemplatesJson,
  serializeSheetTemplatesJson,
} from "./sheetTemplates";
import {
  SIDECAR_KIND_LABELS,
  SidecarRevisionTracker,
  fingerprint,
  summarizeConflict,
  type ConflictSides,
  type SidecarKind,
} from "./sidecarRevision";
import { createKernelClient, DEFAULT_TIMEOUT_MS, JobCancelledError, type KernelClient, type ScopedPipeline } from "./kernelClient";
import { normalizeTessellationQuality, tessellationParamsFor } from "./tessellationQuality";
import { detectStepLengthUnit } from "./stepUnits";
import { detectIgesLengthUnit } from "./igesUnits";
import { buildPartsFromMeshioRegions } from "./meshioRegionParts";
import { buildMeshProvenanceNotes } from "./meshProvenanceNotes";
import { meshioCompanionCandidates } from "./meshioCompanions";
import type { MeshioCompanion } from "./meshioService";
import {
  encodeBuffer,
  type HostToWebview,
  type WebviewToHost,
  type Part,
  type Annotation,
  type ConstructionPlane,
  type MeshPresetSummary,
  type ViewState,
  type SelectorSynthesizeResultEntry,
} from "./protocol";
import type { CadFormat, FileRoute, MeshParseFormat } from "./fileRouter";
import { COMPARABLE_MESH_FORMATS, ambiguityCaveatFor, matchExtension } from "./fileRouter";
import { resolveEffectiveSource } from "./scadService";
import { connectSpaceMouse, disconnectSpaceMouse } from "./spaceMouse";
import { isMeshioFieldFailure, describeMeshioFieldFailure, isHealableSizeError, AUTO_DECIMATE_TARGET_TRIANGLES, stlBytesForHeal } from "./meshioService";
import { validateMeshioOpSpec } from "./meshioOps";
import { SVG_VIEWS } from "./svgSilhouette";
import type { CompareSource } from "./modelDiffHost";
import { resolveExternalBuffers, type GltfExternalBuffers } from "./gltfParser";
import { exportTargetsFor, EXPORT_EXTENSION, EXPORT_LABEL, UNIT_CONVERTIBLE_FORMATS, MESH_SAVE_IN_PLACE_FORMATS } from "./exportTargets";
import { readParts, writeParts, sidecarUri } from "./partsStore";
import { readAnnotations, writeAnnotations, annotationsSidecarUri } from "./annotationsStore";
import { readPlanes, writePlanes, planesSidecarUri } from "./planesStore";
import { readEdits, writeEdits, editsSidecarUri } from "./editsStore";
import { assertNotDirty } from "./dirtyGuard";
import type { EditOp, EditOpKind } from "./editOps";
import { validateEditOp } from "./editOps";
import type { ParamVariable } from "./editVariables";
import { resolvePlaneRefs } from "./planeRefs";
import { readMeshOptions, writeMeshOptions, writeGeoScript, meshOptionsSidecarUri, geoScriptUri } from "./meshOptionsStore";
import { readViewState, writeViewState, viewStateSidecarUri } from "./viewStateStore";
import { writeCustomBackup, restoreCustomBackup } from "./customBackup";
import type { MeshGenerationInput } from "./gmshService";
import type { MeshioMetadataSummary } from "./meshioService";
import { meshExportFormat, companionSaveName, MESH_EXPORT_FORMATS, type MeshExportFormatId } from "./meshExportFormats";
import { SIZE_MAX_SENTINEL, applyStlPartSizeOverride, scaleMeshOptionsForUnit, scalePartsMeshSizeForUnit } from "./meshOptions";
import type { MeshOptions } from "./meshOptions";
import { viewerBodyHtml } from "./viewerDom";
import { normalizeViewerDefaults } from "./viewerDefaults";
import { buildPreprocessZip, readPreprocessZip } from "./preprocessArchive";
import { parsePartsJson } from "./partsSidecar";
import { parseAnnotationsJson } from "./annotationsSidecar";
import { parsePlanesJson } from "./planesSidecar";
import { parseEditsJson, replayTail } from "./editsSidecar";
import { parseMeshJson } from "./meshOptionsSidecar";
import { DISPLAY_UNITS, UNIT_LABELS, displayUnitFromUnitName, unitScaleFactor, type DisplayUnit } from "./lengthUnits";
import { scaleStlBytes } from "./stlParser";
import { isMeshSourceRoute, resolveMeshSourceInput } from "./meshSourceInput";
import { runMeshSweep, validateSweepSizes, sweepOutputName, SWEEP_NOTE } from "./meshSweep";
import { getNonce } from "./nonce";
import { showLatestWhatsNew } from "./whatsNew";
import { runCompareModelsCommand } from "./modelComparePanel";
import { runBatchExportCommand } from "./batchExportCommand";
import { runPrepReportCommand } from "./prepReportCommand";
import { buildExportHandoffManifest } from "./mcpTools";
import { HANDOFF_MANIFEST_SUFFIX, serializeHandoffManifest } from "./handoffManifest";
import { mergeScriptOverrides, parseScriptLibraryJson, scriptParameters, serializeScriptLibraryJson } from "./scriptLibrary";
import { bundledMacrosPath, mergeScriptLibraries } from "./starterMacros";
import {
  bundledMeshPresetsPath,
  effectivePresetOptions,
  mergePresetLibraries,
  parseMeshPresetsJson,
  serializeMeshPresetsJson,
} from "./meshPresets";
import { emitPrimitiveOps } from "./primitiveEmit";
import { compileParametricScript } from "./parametricScript";
import { evaluateVariables } from "./editVariables";
import { fetchThumbnail, ThumbCache } from "./standardPartsThumbs";
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

/** Parallel thumbnail fetches per page (roadmap Tier 1 "Standard-parts
 * thumbnails") — bounded so one 20-result page cannot open 20 connections
 * at once; failures resolve individually to absent (text fallback). */
const THUMB_FETCH_CONCURRENCY = 4;

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

interface MeshingJobScope {
  documentKey: string;
  requestId: string;
  owner: string;
  controller: AbortController;
  state: "running" | "cancelling";
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
  /** File ▸ Export Drawing Sheet… (several views, shared scale, title block). */
  exportSheet(): void;
  /** Generate and export an FE mesh (format + unit quick-picks, then a save dialog). */
  exportMesh(): void;
  /** Frame the webview's transient selection in the focused pane
   * (roadmap Tier 1 "Zoom to selection") — fire-and-forget. */
  zoomToSelection(): void;
  /** Post a message to this session's webview — the registry entry for the
   * linked-cameras relay (roadmap "Split view", Phase 3). */
  post(msg: HostToWebview): void;
}

/** Editable custom document (Tier 0 Phase 2): the URI plus nothing — all
 * mutable state (op list, parts, watermark, …) lives in the per-document
 * `resolveCustomEditor` closure, reached via the savers map below. */
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
export class CadPreviewProvider implements vscode.CustomEditorProvider<CadDocument> {
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

  /**
   * Tier 0 Phase 2 — dirty tracking. Firing this event marks the editor dirty;
   * VS Code clears it when `saveCustomDocument`/`revertCustomDocument`
   * completes. Only `CustomDocumentContentChangeEvent` is ever fired (never
   * `CustomDocumentEditEvent` — the webview owns the undo stack, and the API
   * requires one kind or the other, never mixed). Dirty means exactly one
   * thing: the op list has an unbaked tail for a source that can bake it
   * (`currentEdits.length > currentBakedThrough` on step/iges/brep for B-rep,
   * and on stl/obj/ply for mesh save-in-place — Tier 0 Phase 3) —
   * sidecar-only changes never dirty the document (they're covered by the
   * ~500 ms autosave plus the explicit File-Save flush).
   */
  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<CadDocument>>();
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  /** Per-document save/revert closures for `saveCustomDocument`/`revertCustomDocument`
   * (they mutate `resolveCustomEditor` state no class method can reach).
   * Registered at the end of `resolveCustomEditor`, removed on dispose alongside the session entry below.
   * `markDirty` fires the dirty event exactly like a webview `editsChanged`
   * would — the suite uses it because it cannot push ops through the webview,
   * and a dirty tab is also what keeps VS Code from auto-closing the editor
   * when the save's rename-overwrite briefly reads as a file delete. */
  private readonly documentSavers = new Map<
    string,
    {
      save: () => Promise<void>;
      revert: () => Promise<void>;
      markDirty: () => void;
      receive: (msg: WebviewToHost) => Promise<void>;
    }
  >();

  /**
   * The live provider instance, for the Test-only `testSaveDocument` /
   * `testRevertDocument` seam below. Set in `register()` — there is exactly
   * one provider per extension-host process.
   */
  private static lastProvider: CadPreviewProvider | undefined;

  /**
   * Test-only: serializes the webview's `exportMesh` round trip without a
   * webview. The integration VS Code runs with software/no WebGL, so no
   * Three.js scene exists to serialize and a mesh save can never complete
   * there — the round trip itself is covered by `test:webview`'s
   * mesh-exporter cases instead. When set, `bakeMeshToSource` writes these
   * bytes (keyed by the source format) and exercises the REAL remainder of
   * the save: modal, `.bak`, tmp+rename, watcher guard, watermark, reload.
   * `undefined` (production, and every non-mesh-save test) keeps the
   * webview round trip. Never set outside the integration suite.
   */
  public static testExportMeshStub: ((format: string) => Uint8Array | undefined) | undefined;

  /** Test-only: invokes the real `saveDocumentSource` join for an open document. */
  public static async testSaveDocument(uri: vscode.Uri): Promise<void> {
    const savers = CadPreviewProvider.lastProvider?.documentSavers.get(uri.toString());
    if (!savers) throw new Error(`No open CAD Preview session for ${uri.fsPath} — open the document first.`);
    await savers.save();
  }

  /**
   * Test-only: invokes the real `saveCustomDocumentAs` copy for an open
   * document. The workbench's own Save As dialog is native UI the modal stubs
   * cannot intercept, so the suite calls the copy join directly — the dialog
   * itself is not what's under test.
   */
  public static async testSaveDocumentAs(uri: vscode.Uri, destination: vscode.Uri): Promise<void> {
    const provider = CadPreviewProvider.lastProvider;
    if (!provider) throw new Error("No live provider — open a document first.");
    await provider.saveCustomDocumentAs(new CadDocument(uri), destination);
  }

  /**
   * Test-only: marks the document dirty, exactly as a webview `editsChanged`
   * post would. Beyond fidelity (a real save always runs on a dirty tab), a
   * dirty tab is what keeps VS Code from auto-closing the editor when the
   * save's temp-sibling rename-overwrite momentarily reads as a file delete —
   * a clean tab vanishes mid-save and every later post throws
   * "Webview is disposed".
   */
  public static markDirtyDocument(uri: vscode.Uri): void {
    const savers = CadPreviewProvider.lastProvider?.documentSavers.get(uri.toString());
    if (!savers) throw new Error(`No open CAD Preview session for ${uri.fsPath} — open the document first.`);
    savers.markDirty();
  }

  /** Test-only: delivers `msg` to the document's real webview-message
   * handler, exactly as if its webview had posted it (the suite cannot post
   * into a webview itself). */
  public static async simulateWebviewMessage(uri: vscode.Uri, msg: WebviewToHost): Promise<void> {
    const savers = CadPreviewProvider.lastProvider?.documentSavers.get(uri.toString());
    if (!savers) throw new Error(`No open CAD Preview session for ${uri.fsPath} — open the document first.`);
    await savers.receive(msg);
  }

  /** Test-only: invokes the real `revertToSavePoint` join for an open document. */
  public static async testRevertDocument(uri: vscode.Uri): Promise<void> {
    const savers = CadPreviewProvider.lastProvider?.documentSavers.get(uri.toString());
    if (!savers) throw new Error(`No open CAD Preview session for ${uri.fsPath} — open the document first.`);
    await savers.revert();
  }

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

  /** The last drawing-sheet settings used this session (pre-fills the form). */
  private lastSheetSettings: SheetSettingsInput | undefined;

  /** Per-document owner-scoped views of `pipeline`, keyed by `uri.toString()`. */
  private readonly scopedPipelines = new Map<string, ScopedPipeline>();
  private readonly meshingJobScope = new AsyncLocalStorage<MeshingJobScope>();
  private readonly meshingJobs = new Map<string, MeshingJobScope>();

  /** The owner-scoped pipeline for one document (memoized; dropped on dispose). */
  private docPipeline(uri: vscode.Uri): ScopedPipeline {
    const key = uri.toString();
    const meshJob = this.meshingJobScope.getStore();
    if (meshJob?.documentKey === key) {
      return this.pipeline.withJob({ owner: meshJob.owner, signal: meshJob.controller.signal, timeoutMs: kernelTimeoutMs() });
    }
    let scoped = this.scopedPipelines.get(key);
    if (!scoped) {
      scoped = this.pipeline.withJob({ owner: key, timeoutMs: kernelTimeoutMs() });
      this.scopedPipelines.set(key, scoped);
    }
    return scoped;
  }

  private meshingJobKey(uri: vscode.Uri, requestId: string): string {
    return `${uri.toString()}\0${requestId}`;
  }

  private async runMeshingJob<T>(uri: vscode.Uri, requestId: string, post: (msg: HostToWebview) => void, action: () => Promise<T>): Promise<T> {
    if (!requestId.trim()) throw new Error("Meshing jobs require a request id.");
    const documentKey = uri.toString();
    const key = this.meshingJobKey(uri, requestId);
    if (this.meshingJobs.has(key)) throw new Error(`Meshing request ${requestId} is already active for this document.`);
    const job: MeshingJobScope = {
      documentKey,
      requestId,
      owner: `mesh:${documentKey}:${requestId}`,
      controller: new AbortController(),
      state: "running",
    };
    this.meshingJobs.set(key, job);
    try {
      return await this.meshingJobScope.run(job, action);
    } finally {
      if (this.meshingJobs.get(key) === job) this.meshingJobs.delete(key);
      try { post({ type: "meshingJobSettled", requestId }); } catch { /* The editor may have closed while the kernel call settled. */ }
    }
  }

  private cancelMeshingJob(uri: vscode.Uri, requestId: string): MeshingJobScope | undefined {
    const job = this.meshingJobs.get(this.meshingJobKey(uri, requestId));
    if (!job || job.state === "cancelling") return job;
    job.state = "cancelling";
    job.controller.abort(new JobCancelledError("meshing job"));
    this.pipeline.cancel({ owner: job.owner });
    return job;
  }

  private assertMeshingJobActive(): void {
    const job = this.meshingJobScope.getStore();
    if (job?.controller.signal.aborted) throw new JobCancelledError("meshing job");
  }

  /**
   * Thumbnail bytes by `pngUrl`, shared across every open document (the
   * catalog is document-independent). Session-scoped by construction —
   * nothing persists it. Only successful fetches are stored; failures are
   * retried next time rather than negatively cached.
   */
  private readonly thumbsCache = new ThumbCache();

  constructor(private readonly context: vscode.ExtensionContext) {
    // Assigned in the constructor body, not a field initializer, so there is
    // no ambiguity about running after the `context` parameter property is
    // set (field initializers and parameter-property assignment ordering is
    // a real TS subtlety not worth relying on here).
    this.pipeline = createKernelClient(this.context.extensionPath);
    // One child serves every open document, so its readiness is one fact for
    // all of them: fan every change out to every session's status bar.
    this.pipeline.onKernelState((state) => {
      for (const s of this.sessions.values()) s.post({ type: "kernelStatus", state });
    });
  }

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new CadPreviewProvider(context);
    CadPreviewProvider.lastProvider = provider;
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
      vscode.commands.registerCommand("cad-preview.exportSheet", withSession((s) => s.exportSheet())),
      vscode.commands.registerCommand("cad-preview.exportMesh", withSession((s) => s.exportMesh())),
      vscode.commands.registerCommand("cad-preview.zoomToSelection", withSession((s) => s.zoomToSelection())),
      vscode.commands.registerCommand("cad-preview.compareModels", () =>
        void runCompareModelsCommand(this.context, this.pipeline, this.activeSession?.uri)
      ),
      // Session-free, like compareModels: runs the batch over files on disk,
      // never through (or opening) an editor.
      // Uses the focused tab when there is one (flushing its sidecars first so
      // the report reads what the user sees), otherwise asks for a file.
      vscode.commands.registerCommand("cad-preview.prepReport", () =>
        runPrepReportCommand(this.context, this.pipeline, this.activeSession?.uri, async () => {
          await this.activeSession?.save();
        }).then(undefined, (err) => vscode.window.showErrorMessage(`Preparation report failed: ${(err as Error)?.message ?? err}`))
      ),
      vscode.commands.registerCommand("cad-preview.batchExport", () =>
        runBatchExportCommand(this.context, this.pipeline).then(undefined, (err) =>
          vscode.window.showErrorMessage(`Batch export failed: ${(err as Error)?.message ?? err}`)
        )
      ),
      // SpaceMouse 6DOF input — deliberately NOT
      // `withSession`: the device is global, not per-tab; motion events
      // route to whichever session is focused at event time (or drop when
      // none is). Connect is explicit opt-in only — never auto-started from
      // `activate()`, mirroring the lazy-WASM rule.
      vscode.commands.registerCommand("cad-preview.spaceMouseConnect", () =>
        void (async () => {
          try {
            const { name, note } = await connectSpaceMouse((motion, buttons) => {
              this.activeSession?.post({ type: "spacemouse", motion, buttons });
            });
            void vscode.window.showInformationMessage(
              `SpaceMouse connected: ${name}${note ? ` — ${note}` : ""}`
            );
          } catch (err) {
            void vscode.window.showErrorMessage(`SpaceMouse: ${(err as Error).message}`);
          }
        })()
      ),
      vscode.commands.registerCommand("cad-preview.spaceMouseDisconnect", () => {
        disconnectSpaceMouse();
        void vscode.window.showInformationMessage("SpaceMouse disconnected.");
      }),
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
          "stl", "obj", "ply", "gltf", "glb", "step", "stp", "iges", "igs", "brep", "csg", "scad",
          "vtk", "vtu", "med", "cgns", "exo", "e", "xdmf", "mdpa", "foam",
          "msh", "msh2", "inp", "unv", "su2", "mesh", "bdf",
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
    * Consequence, now that `exportTargetsFor` offers a B-rep source its own
    * format for save-in-place: Export… offers BREP (save in place) first,
    * then STEP/IGES + every mesh target.
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

  openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<CadDocument> {
    return (async () => {
      // Hot-exit restore: a backupId means VS Code kept a snapshot past the
      // last session — copy it back over the workspace files first, fail-open
      // (a corrupt snapshot must never block opening the document).
      if (openContext?.backupId) {
        await restoreCustomBackup(openContext.backupId, uri).then(undefined, () => undefined);
      }
      const document = new CadDocument(uri);
      return document;
    })();
  }

  /**
   * Tier 0 Phase 2 — Ctrl+S / Save All / auto-save entry point. VS Code
   * clears the dirty flag when this completes. Flushes the sidecars (they
   * become part of the save rather than the whole of it) and bakes any
   * unbaked tail for a B-rep source that can bake it.
   */
  async saveCustomDocument(document: CadDocument): Promise<void> {
    const savers = this.documentSavers.get(document.uri.toString());
    if (!savers) return; // session gone (disposed mid-save) — nothing reachable to persist
    await savers.save();
  }

  /**
   * Tier 0 Phase 2 — `File: Revert File` entry point (not git revert).
   * Drops the op list back to the last saved watermark and re-reads the
   * sidecars from disk, so every editor instance shows the saved state.
   */
  async revertCustomDocument(document: CadDocument): Promise<void> {
    const savers = this.documentSavers.get(document.uri.toString());
    if (!savers) return;
    await savers.revert();
  }

  /**
   * Tier 0 Phase 2 — same-format copy (Save As), not a bake. Copies the
   * source bytes plus whichever sidecars exist to `destination`, watermark
   * verbatim — so the copy replays consistently from the moment it exists.
   * No format conversion (that's Export's job): the destination must route
   * to the same format as the source. VS Code opens the copy itself as a
   * non-dirty editor.
   */
  async saveCustomDocumentAs(document: CadDocument, destination: vscode.Uri): Promise<void> {
    const sourceRoute = routeFile(document.uri.fsPath);
    const destRoute = routeFile(destination.fsPath);
    if (!sourceRoute || !destRoute || sourceRoute.format !== destRoute.format) {
      throw new Error("Save As keeps the source format — convert with File ▸ Export… instead.");
    }
    const fs = vscode.workspace.fs;
    await fs.writeFile(destination, await fs.readFile(document.uri));
    // Sidecar suffix = sidecar path minus the source path (e.g. ".edits.json"),
    // so the copy lands beside the DESTINATION (`copy.stp.edits.json`), not
    // under the source's basename.
    for (const sidecar of this.sidecarUrisFor(document.uri)) {
      try {
        const bytes = await fs.readFile(sidecar);
        const suffix = sidecar.path.slice(document.uri.path.length);
        await fs.writeFile(destination.with({ path: `${destination.path}${suffix}` }), bytes);
      } catch {
        /* sidecar absent — nothing to copy */
      }
    }
  }

  /**
   * Tier 0 Phase 2 — hot-exit snapshot. VS Code calls this ~1s after the
   * last `onDidChangeCustomDocument` fire (never with auto-save on) and
   * hands `backupId` back to `openCustomDocument` after a restart.
   */
  async backupCustomDocument(
    document: CadDocument,
    context: vscode.CustomDocumentBackupContext
  ): Promise<vscode.CustomDocumentBackup> {
    return writeCustomBackup(document.uri, this.sidecarUrisFor(document.uri), context.destination);
  }

  /** Fires the dirty event for `document` (Tier 0 Phase 2 — see the emitter's doc comment). */
  private fireDirty(document: CadDocument): void {
    this._onDidChangeCustomDocument.fire({ document });
  }

  /** The six sidecars (+ generated `.geo`) beside a model, for backup/copy flows. */
  private sidecarUrisFor(modelUri: vscode.Uri): vscode.Uri[] {
    return [
      editsSidecarUri(modelUri),
      sidecarUri(modelUri),
      annotationsSidecarUri(modelUri),
      planesSidecarUri(modelUri),
      meshOptionsSidecarUri(modelUri),
      geoScriptUri(modelUri),
      viewStateSidecarUri(modelUri),
    ];
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

    let panelDisposed = false;
    webviewPanel.onDidDispose(() => {
      panelDisposed = true;
    });
    const post = (msg: HostToWebview): Thenable<boolean> => {
      CadPreviewProvider.postedEmitter.fire(msg); // test-only observer; see the emitter's doc comment
      // Kernel work can settle after the tab closed (a cancelled job's
      // rejection, a slow export) — posting then would throw "Webview is
      // disposed" into an unhandled rejection. There is nobody to tell.
      if (panelDisposed) return Promise.resolve(false);
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
    // Roadmap "Document-scoped jobs and cancellation": every kernel call this
    // document makes carries its own owner, so this tab's Cancel (or closing
    // it) can never interrupt another tab's running job.
    const docPipeline = this.docPipeline(document.uri);
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
    // Tier 0 save-in-place watermark: the file on disk already contains
    // `currentEdits[0..currentBakedThrough]`, so every kernel replay consumes
    // only the tail (`replayTail`). 0 on pre-watermark documents. Adopted from
    // the sidecar on `ready`, set to `currentEdits.length` by an in-place
    // save, persisted on every edits write.
    let currentBakedThrough = 0;

    // Whether this document carries unsaved edits: an unbaked op tail on a source
    // this build can write back (Tier 0 Phase 2+3 — step/iges/brep via OCCT,
    // stl/obj/ply via the webview exporter). Sidecar-only changes never count
    // (autosave covers them); meshio/CAD-text sources never fire (nothing bakes
    // for them); glTF never fires (its exporter only emits binary `.glb`).
    //
    // ONE predicate, read by both consumers — VS Code's dirty event and the
    // menubar's document chip — so the two cannot drift into different ideas of
    // "unsaved". They still differ at two moments, by design (at open with a
    // pre-existing unbaked tail; after undoing back to the save point) — see the
    // `documentInfo` doc comment in protocol.ts. The chip answers "does the source
    // file contain what I am looking at?", which is a different question from
    // VS Code's "has anything changed since the last save event?".
    const isDocumentDirty = (): boolean =>
      !!route &&
      currentEdits.length > currentBakedThrough &&
      ((route.strategy === "occt" && BREP_FORMATS.has(route.format)) ||
        (route.strategy === "three" && MESH_SAVE_IN_PLACE_FORMATS.has(route.format)));
    // The chip's count. Derived from the SAME predicate so "dirty" and "N unsaved
    // edits" can never disagree (a format that cannot bake reports 0, not the
    // length of a tail nothing will ever write).
    const unsavedEditCount = (): number => (isDocumentDirty() ? currentEdits.length - currentBakedThrough : 0);

    // Tells the webview's document chip which file this is and whether it has
    // unsaved edits. DEDUPLICATED against the last value actually posted, so it is
    // safe — and intended — to call at every point the op list or watermark can
    // change without thinking about whether this particular call is redundant.
    // That is the whole reason it exists as a syncing function rather than six
    // hand-placed posts: the transitions are scattered (ready, editsChanged, both
    // bakes, revert, external reconcile), and a forgotten one would leave the chip
    // lying about the document's state.
    let lastDocumentInfo = "";
    const syncDocumentInfo = (): void => {
      const info = {
        type: "documentInfo" as const,
        name: path.basename(document.uri.fsPath),
        path: document.uri.fsPath,
        format: route?.format ?? null,
        dirty: isDocumentDirty(),
        unsavedEdits: unsavedEditCount(),
      };
      const serialized = JSON.stringify(info);
      if (serialized === lastDocumentInfo) return;
      lastDocumentInfo = serialized;
      post(info);
    };

    // Every place the host tells the webview about the op list ALSO settles the
    // watermark, i.e. can flip `dirty`. Routing them through one helper is what
    // makes "post edits, forget to resync the chip" unrepresentable.
    const postEdits = (): void => {
      post({ type: "edits", ops: currentEdits, variables: currentVariables, bakedThrough: currentBakedThrough });
      syncDocumentInfo();
    };
    // Set around our own in-place source write so the source-file watcher
    // below skips exactly one self-event instead of "reloading" what we just
    // saved. One-shot: consumed by the next watcher firing.
    let expectOwnSourceSave = false;
    // One-deep `<model>.bak` per session, written on the first in-place save.
    let madeSourceBackupThisSession = false;
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
    /** The last search this document's webview rendered (`requestId` + each
     * item's `pngUrl` by part id) — thumbnail requests are validated against
     * it, so a stale page's ids can never resolve (the webview only ever
     * echoes back what this host sent it, but the check is one line). */
    let lastPartsSearch: { requestId: string; pngById: Map<string, string> } | null = null;

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
          writeEdits(document.uri, currentEdits, currentVariables, currentBakedThrough),
          ...(currentMeshOptions
            ? [writeMeshOptions(document.uri, currentMeshOptions), writeGeoScript(document.uri, currentMeshOptions)]
            : []),
          ...(currentViewState ? [writeViewState(document.uri, currentViewState)] : []),
        ]);
        // An explicit Save is the "chosen overwrite" for any held conflict.
        for (const kind of Object.keys(sidecarUriFor) as SidecarKind[]) {
          revisions.noteSynced(kind, await diskFingerprint(kind));
          revisions.resolve(kind);
        }
        post({ type: "status", text: "Saved" });
      } catch (err) {
        post({ type: "error", message: `Save failed: ${(err as Error).message}` });
      }
    };

    /**
     * Tier 0 Phase 2 — the shared source-bake used by both the Export-menu
     * save-in-place (`performSaveInPlace`, always confirmed) and
     * `saveCustomDocument` (Ctrl+S: confirmed only until the session's first
     * bake created the `.bak` — afterwards the dirty dot + explicit keypress
     * IS the confirmation). Returns true when bytes were baked.
     *
     * Safety, in order: (1) modal confirmation per policy; (2) write to a
     * temp sibling + atomic-ish rename, so a crash mid-write cannot truncate
     * the original; (3) a one-deep `<model>.bak` on the first save of the
     * session; (4) the `bakedThrough` watermark set to the full list length
     * and flushed immediately (clearing the pending debounce first, so a
     * stale-watermark write cannot land after it); (5) the source watcher
     * skips exactly one self-event via `expectOwnSourceSave`; (6) a two-byte
     * save-time rebind (`rebindPartsAcrossSave`: pre-save bytes + full ops vs
     * post-save bytes + new tail) so Part/annotation highlights track the
     * renumbered file instead of merely warning about it.
     *
     * Op-list semantics: the file becomes `base ∘ ops[0..n]` and the sidecar
     * KEEPS the full list with the baked prefix marked — replay starts after
     * the watermark (see `loadModel`'s tail slice).
     */
    const bakeTailToSource = async (confirmPolicy: "always" | "first"): Promise<boolean> => {
      if (!route || route.strategy !== "occt") return false;
      const fileName = document.uri.path.slice(document.uri.path.lastIndexOf("/") + 1);
      if (route.format !== "step" && route.format !== "iges" && route.format !== "brep") {
        post({ type: "error", message: `Saving ${fileName} in place is only supported STEP→STEP, IGES→IGES and BREP→BREP in this version.` });
        return false;
      }
      if (currentEdits.length < currentBakedThrough) {
        post({ type: "error", message: "The op list changed below the save point — close and reopen the file to work from the saved state." });
        return false;
      }
      // Fail fast BEFORE the kernel bake and before any source write: a dirty
      // edits sidecar would refuse the watermark write below, after the source
      // was already rewritten — forcing the rollback path. `writeEdits` throws
      // the identical error; this only moves it earlier, where it is free.
      try {
        assertNotDirty(editsSidecarUri(document.uri));
      } catch (err) {
        post({ type: "error", message: `Save in place failed: ${(err as Error).message}` });
        return false;
      }
      const tail = replayTail(currentEdits, currentBakedThrough);
      try {
        const scadWarnings: string[] = [];
        const src = await this.readOcctSource(document.uri, route.format, scadWarnings);
        for (const w of scadWarnings) post({ type: "status", text: w });
        // Save at the file's own declared unit (a parameter, not new work —
        // the display selector already detects it): an INCH-declared STEP
        // stays INCH-declared, geometrically identical on reopen.
        const saveUnit = this.detectSourceDisplayUnit(src.bytes, route.format);
        const needsConfirm = confirmPolicy === "always" || !madeSourceBackupThisSession;
        if (needsConfirm) {
          const confirm = await vscode.window.showWarningMessage(
            `Save ${tail.length} edit op(s) into ${fileName} itself? The file is re-emitted, not patched: entity numbering and authoring metadata are not preserved, and per-part colour is not carried over. Assembly structure and part names survive. This cannot be undone past the save point.`,
            { modal: true },
            "Save in place",
            "Cancel"
          );
          if (confirm !== "Save in place") return false;
        }
        const baked = await docPipeline.exportBRep(
          this.context.extensionPath,
          src.bytes,
          src.format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
          route.format as Extract<CadFormat, "step" | "iges" | "brep">,
          tail,
          saveUnit,
          true,
          currentParts
        );
        if (!madeSourceBackupThisSession) {
          await vscode.workspace.fs.copy(document.uri, document.uri.with({ path: `${document.uri.path}.bak` }), { overwrite: true });
          madeSourceBackupThisSession = true;
        }
        const baseName = fileName.replace(/\.[^.]+$/, "");
        const tmpUri = vscode.Uri.joinPath(document.uri, "..", `${baseName}.save-tmp.${EXPORT_EXTENSION[route.format as CadFormat]}`);
        try {
          await vscode.workspace.fs.writeFile(tmpUri, baked);
          expectOwnSourceSave = true;
          await vscode.workspace.fs.rename(tmpUri, document.uri, { overwrite: true });
        } catch (err) {
          expectOwnSourceSave = false;
          await vscode.workspace.fs.delete(tmpUri).then(undefined, () => undefined);
          throw err;
        }
        if (editsSaveTimer) clearTimeout(editsSaveTimer);
        // The source on disk is already rewritten at this point; the watermark
        // has NOT landed yet. If `writeEdits` throws here the pair disagrees
        // (baked file, stale sidecar) and the next open would double-apply the
        // tail — so roll the source back to the pre-save bytes (`src.bytes`,
        // read before the bake) and report loudly instead of claiming a save.
        // The in-memory watermark is restored first, so a failed save never
        // leaves this session believing it is saved either.
        const watermarkBefore = currentBakedThrough;
        currentBakedThrough = currentEdits.length;
        try {
          await writeEdits(document.uri, currentEdits, currentVariables, currentBakedThrough);
        } catch (wmErr) {
          currentBakedThrough = watermarkBefore;
          try {
            expectOwnSourceSave = true;
            await vscode.workspace.fs.writeFile(document.uri, src.bytes);
          } catch {
            expectOwnSourceSave = false;
          }
          post({
            type: "error",
            message: `Save in place failed: the watermark write failed (${(wmErr as Error).message}) — the source file was restored to its pre-save bytes; close any dirty sidecar tab and save again.`,
          });
          return false;
        }
        // Two-byte save-time rebind: pre-save bytes + full op list vs the
        // freshly-baked bytes + (now empty) tail. On a real change persist +
        // post exactly like `rebindPartsOnChange`; on failure say so loudly
        // rather than claiming verified highlights.
        try {
          const newBytes = await vscode.workspace.fs.readFile(document.uri);
          const rebindResult = await docPipeline.rebindPartsAcrossSave(
            this.context.extensionPath,
            src.bytes,
            src.format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
            currentEdits,
            newBytes,
            route.format as Extract<CadFormat, "step" | "iges" | "brep">,
            replayTail(currentEdits, currentBakedThrough),
            currentParts,
            currentAnnotations
          );
          if (rebindResult.parts !== currentParts) {
            currentParts = rebindResult.parts;
            await writeParts(document.uri, currentParts);
            post({ type: "parts", parts: currentParts });
          }
          if (rebindResult.annotations !== currentAnnotations) {
            currentAnnotations = rebindResult.annotations;
            await writeAnnotations(document.uri, currentAnnotations);
            post({ type: "annotations", annotations: currentAnnotations });
          }
        } catch (err) {
          post({ type: "error", message: `Could not rebind entity ids across the save: ${(err as Error).message}` });
          post({
            type: "status",
            text: "Part/annotation highlights were assigned against the pre-save geometry — verify them; re-assign anything that looks shifted.",
          });
        }
        post({ type: "status", text: `Saved in place to ${fileName} (${tail.length} op(s) baked)` });
        // The watermark just moved to the end of the op list, so the document is
        // now clean. This bake path does not post `edits` (unlike the mesh one),
        // so `postEdits` never runs for it — sync the chip here.
        syncDocumentInfo();
        loadModel(true);
        return true;
      } catch (err) {
        post({ type: "error", message: `Save in place failed: ${(err as Error).message}` });
        return false;
      }
    };

    /**
     * Tier 0 Phase 1 — same-format save-in-place (STEP→STEP, IGES→IGES,
     * BREP→BREP) from the Export flow. Runs INSTEAD of the export when the
     * user picks the source's own format (see `handleExport`); always
     * confirmed (the Export flow keeps its Phase-1 modal).
     */
    const performSaveInPlace = async (targetFormat: CadFormat): Promise<void> => {
      if (!route) return;
      if (targetFormat !== route.format) return;
      if (route.strategy === "occt") {
        await bakeTailToSource("always");
        return;
      }
      // Tier 0 Phase 3 — same-format mesh save-in-place (STL→STL, OBJ→OBJ,
      // PLY→PLY) from the Export flow. Serializes the currently displayed
      // (edited) model via the webview, then writes it back over the source
      // through the same temp-sibling + rename + one-deep `.bak` + watcher
      // guard as the B-rep bake above. glTF never reaches here (excluded from
      // `MESH_SAVE_IN_PLACE_FORMATS` — its exporter only emits binary `.glb`).
      if (route.strategy === "three" && MESH_SAVE_IN_PLACE_FORMATS.has(route.format)) {
        await bakeMeshToSource("always");
      }
    };

    /**
     * Tier 0 Phase 3 — mesh save-in-place body (STL/OBJ/PLY only). The
     * displayed model already includes the unbaked tail (mesh edits replay in
     * the webview), so saving serializes it via the `exportMesh` round trip
     * at native mm and writes it over the source. The sidecar KEEPS the full
     * op list with the watermark set — the webview's `rebuildMeshModel`
     * replays only the tail after the save point, so history is preserved
     * exactly like the B-rep bake (not cleared). Mesh Parts reference
     * `node-N` ids by traversal order over the single root mesh, which this
     * serialization preserves, so no rebind pass is needed (unlike B-rep's
     * two-byte `rebindPartsAcrossSave`).
     */
    const bakeMeshToSource = async (confirmPolicy: "always" | "first"): Promise<boolean> => {
      if (!route || route.strategy !== "three" || !MESH_SAVE_IN_PLACE_FORMATS.has(route.format)) return false;
      const fileName = document.uri.path.slice(document.uri.path.lastIndexOf("/") + 1);
      if (currentEdits.length < currentBakedThrough) {
        post({ type: "error", message: "The op list changed below the save point — close and reopen the file to work from the saved state." });
        return false;
      }
      // Fail fast BEFORE the webview serialization and before any source
      // write — same reason as `bakeTailToSource`'s pre-check above.
      try {
        assertNotDirty(editsSidecarUri(document.uri));
      } catch (err) {
        post({ type: "error", message: `Save in place failed: ${(err as Error).message}` });
        return false;
      }
      const tailLength = currentEdits.length - currentBakedThrough;
      try {
        const needsConfirm = confirmPolicy === "always" || !madeSourceBackupThisSession;
        if (needsConfirm) {
          const confirm = await vscode.window.showWarningMessage(
            `Save ${tailLength} edit op(s) into ${fileName} itself? The file is re-emitted from the displayed model, not patched: facet structure and authoring metadata are not preserved. This cannot be undone past the save point.`,
            { modal: true },
            "Save in place",
            "Cancel"
          );
          if (confirm !== "Save in place") return false;
        }
        // Test-only stub (see `testExportMeshStub`): the integration host has
        // no WebGL scene to serialize, so the suite supplies the bytes and the
        // REAL remainder of the save below is what gets exercised.
        const stubBytes = CadPreviewProvider.testExportMeshStub?.(route.format);
        let bytes: Uint8Array;
        if (stubBytes !== undefined) {
          bytes = stubBytes;
        } else {
          const requestId = `${Date.now()}-${Math.random()}`;
          const result = await new Promise<{ data: string; binary: boolean }>((resolve, reject) => {
            pending.set(requestId, { resolve, reject });
            post({ type: "exportMesh", requestId, format: route.format, unit: "mm" });
          });
          bytes = result.binary ? Buffer.from(result.data, "base64") : Buffer.from(result.data, "utf8");
        }
        // Pre-save bytes for the watermark-failure rollback below. The B-rep
        // bake reuses its `src.bytes` for this; a mesh source has no
        // equivalent already in hand, so it reads them here (before `.bak`,
        // before the rename — after either, they are gone).
        const preSaveBytes = await vscode.workspace.fs.readFile(document.uri);
        if (!madeSourceBackupThisSession) {
          await vscode.workspace.fs.copy(document.uri, document.uri.with({ path: `${document.uri.path}.bak` }), { overwrite: true });
          madeSourceBackupThisSession = true;
        }
        const baseName = fileName.replace(/\.[^.]+$/, "");
        const tmpUri = vscode.Uri.joinPath(document.uri, "..", `${baseName}.save-tmp.${EXPORT_EXTENSION[route.format as CadFormat]}`);
        try {
          await vscode.workspace.fs.writeFile(tmpUri, bytes);
          expectOwnSourceSave = true;
          await vscode.workspace.fs.rename(tmpUri, document.uri, { overwrite: true });
        } catch (err) {
          expectOwnSourceSave = false;
          await vscode.workspace.fs.delete(tmpUri).then(undefined, () => undefined);
          throw err;
        }
        if (editsSaveTimer) clearTimeout(editsSaveTimer);
        // Same source-first/watermark-second hazard as the B-rep bake: roll
        // the source back to `preSaveBytes` when the watermark write throws,
        // so the pair agrees again instead of double-applying on reopen.
        const watermarkBefore = currentBakedThrough;
        currentBakedThrough = currentEdits.length;
        try {
          await writeEdits(document.uri, currentEdits, currentVariables, currentBakedThrough);
        } catch (wmErr) {
          currentBakedThrough = watermarkBefore;
          try {
            expectOwnSourceSave = true;
            await vscode.workspace.fs.writeFile(document.uri, preSaveBytes);
          } catch {
            expectOwnSourceSave = false;
          }
          post({
            type: "error",
            message: `Save in place failed: the watermark write failed (${(wmErr as Error).message}) — the source file was restored to its pre-save bytes; close any dirty sidecar tab and save again.`,
          });
          return false;
        }
        postEdits();
        post({ type: "status", text: `Saved in place to ${fileName} (${tailLength} op(s) baked)` });
        loadModel(true);
        return true;
      } catch (err) {
        post({ type: "error", message: `Save in place failed: ${(err as Error).message}` });
        return false;
      }
    };

    /**
     * Tier 0 Phase 2 — `saveCustomDocument` body (Ctrl+S / Save All /
     * auto-save): sidecars flush as PART of the save, then any unbaked tail
     * bakes for a source that can bake it (B-rep via `bakeTailToSource`,
     * STL/OBJ/PLY via `bakeMeshToSource` — Tier 0 Phase 3; meshio/CAD-text
     * sources flush sidecars only).
     */
    const saveDocumentSource = async (): Promise<void> => {
      await flushSidecars();
      if (currentEdits.length <= currentBakedThrough) return;
      if (route && route.strategy === "occt") {
        await bakeTailToSource("first");
      } else if (route && route.strategy === "three" && MESH_SAVE_IN_PLACE_FORMATS.has(route.format)) {
        await bakeMeshToSource("first");
      }
    };

    /**
     * Tier 0 Phase 2 — `revertCustomDocument` body (`File: Revert File`):
     * drops the op list back to the last saved watermark and re-reads the
     * sidecars from disk, so every editor instance shows the saved state.
     * Debounce timers are cleared first (a pending autosave must not land
     * after the revert), and the truncated list is persisted so the next
     * open agrees with what's on screen.
     */
    const revertToSavePoint = async (): Promise<void> => {
      if (partsSaveTimer) clearTimeout(partsSaveTimer);
      if (annotationsSaveTimer) clearTimeout(annotationsSaveTimer);
      if (planesSaveTimer) clearTimeout(planesSaveTimer);
      if (editsSaveTimer) clearTimeout(editsSaveTimer);
      if (meshSaveTimer) clearTimeout(meshSaveTimer);
      if (viewSaveTimer) clearTimeout(viewSaveTimer);
      const [parsed, parts, annotations, planes] = await Promise.all([
        readEdits(document.uri),
        readParts(document.uri),
        readAnnotations(document.uri),
        readPlanes(document.uri),
      ]);
      currentBakedThrough = parsed.bakedThrough;
      currentEdits = parsed.ops.slice(0, parsed.bakedThrough);
      currentVariables = parsed.variables;
      currentParts = parts;
      currentAnnotations = annotations;
      currentPlanes = planes;
      await writeEdits(document.uri, currentEdits, currentVariables, currentBakedThrough);
      postEdits();
      post({ type: "parts", parts: currentParts });
      post({ type: "annotations", annotations: currentAnnotations });
      post({ type: "planes", planes: currentPlanes });
      currentMeshOptions = await this.sendMeshOptions(document.uri, post);
      const view = await readViewState(document.uri);
      currentViewState = view ?? undefined;
      post({ type: "viewState", view });
      loadModel(true);
      post({ type: "status", text: "Reverted to the last save." });
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
        const format = route.format as Extract<CadFormat, "step" | "iges" | "brep" | "csg" | "scad">;
        const generation = ++brepLoadGeneration.current;
        const autoFit = !showProgress;
        // Tier 0: replay only the unbaked tail — the baked prefix already
        // lives in the file on disk.
        const resolvedEdits = resolvePlaneRefs(replayTail(currentEdits, currentBakedThrough), currentPlanes).ops;
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
                // Genuine interruption, scoped to THIS document (roadmap
                // "Document-scoped jobs and cancellation"): this tab's queued
                // jobs are dropped unsent and its running job — only if it is
                // this tab's — is killed. Another tab's running job is never
                // touched. The generation bump above still discards a result
                // that raced the cancel.
                docPipeline.cancel();
              });
              await this.handleBRep(document.uri, format, post, resolvedEdits, documentKey, generation, brepLoadGeneration, autoFit, progress, currentBakedThrough, currentEdits.slice(0, currentBakedThrough).map((o) => o.op));
            }
          );
        } else {
          void this.handleBRep(document.uri, format, post, resolvedEdits, documentKey, generation, brepLoadGeneration, autoFit, undefined, currentBakedThrough, currentEdits.slice(0, currentBakedThrough).map((o) => o.op));
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
      // Tier 0: both lists replay against the current (possibly baked) bytes,
      // so both are tailed identically — the diff stays meaningful.
      const previousTail = replayTail(previousOps, currentBakedThrough);
      const newTail = replayTail(newOps, currentBakedThrough);
      if (JSON.stringify(previousTail) === JSON.stringify(newTail)) return;
      try {
        const scadWarnings: string[] = [];
        const src = await this.readOcctSource(document.uri, route.format, scadWarnings);
        for (const w of scadWarnings) post({ type: "status", text: w });
        const bytes = src.bytes;
        const format = src.format;
        // Stored selectors resolve FIRST (authoritative — a query that hits
        // is exact by construction) and the heuristic rebind pass runs on the
        // result, so a query-covered part never also gets geometrically
        // remapped underneath its own resolution. Selector warnings surface
        // on the status line; the parts message below carries the final ids.
        const selected = await docPipeline.resolvePartSelectors(
          this.context.extensionPath,
          bytes,
          format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
          newTail,
          currentParts
        );
        if (selected.parts !== currentParts) currentParts = selected.parts;
        for (const warning of selected.warnings) post({ type: "status", text: warning });
        const result = await docPipeline.rebindPartsAcrossOps(
          this.context.extensionPath,
          bytes,
          format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
          previousTail,
          newTail,
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
      * too). The CAD source file used to be the one exception (unconditional
      * reload — "this extension NEVER writes it"). Since Tier 0 Phase 1
      * (same-format save-in-place) that is no longer true: our own save sets
      * `expectOwnSourceSave`, consumed once by the watcher above. A genuine
      * external change still reloads unconditionally — no content comparison,
      * just reload.
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

    // Roadmap "Explicit external-change conflict handling": an external write
    // that lands while THIS editor has an unsaved (debounce-pending) change
    // to the same sidecar is a conflict — neither version is silently
    // discarded. See `sidecarRevision.ts` for the rules and their honest
    // limits (detection, not a cross-process transaction).
    const revisions = new SidecarRevisionTracker();
    const sidecarUriFor: Record<SidecarKind, vscode.Uri> = {
      edits: editsSidecarUri(document.uri),
      parts: sidecarUri(document.uri),
      planes: planesSidecarUri(document.uri),
      annotations: annotationsSidecarUri(document.uri),
      mesh: meshOptionsSidecarUri(document.uri),
    };
    const saveTimerOf: Record<SidecarKind, () => void> = {
      edits: () => editsSaveTimer && clearTimeout(editsSaveTimer),
      parts: () => partsSaveTimer && clearTimeout(partsSaveTimer),
      planes: () => planesSaveTimer && clearTimeout(planesSaveTimer),
      annotations: () => annotationsSaveTimer && clearTimeout(annotationsSaveTimer),
      mesh: () => meshSaveTimer && clearTimeout(meshSaveTimer),
    };
    const diskFingerprint = async (kind: SidecarKind): Promise<string> => {
      try {
        return fingerprint(await vscode.workspace.fs.readFile(sidecarUriFor[kind]));
      } catch {
        return fingerprint(null);
      }
    };
    // Seed the known revisions from what is on disk at open (the `ready`
    // hydration reads the same files).
    for (const kind of Object.keys(sidecarUriFor) as SidecarKind[]) {
      void diskFingerprint(kind).then((fp) => {
        if (revisions.knownRevision(kind) === undefined) revisions.noteSynced(kind, fp);
      });
    }
    /** Per kind: read the disk version and return an `adopt` thunk, or `null`
     * when disk already matches this editor (an echo of our own write). */
    type SidecarCheck = () => Promise<{ adopt: () => void; sides: ConflictSides } | null>;
    const checks = new Map<SidecarKind, SidecarCheck>();
    const openConflicts = new Set<SidecarKind>();
    const fileName = path.basename(document.uri.fsPath);

    /** Writes local state now, bypassing the conflict gate (an explicit overwrite). */
    const writeLocal = async (kind: SidecarKind): Promise<void> => {
      if (kind === "edits") await writeEdits(document.uri, currentEdits, currentVariables, currentBakedThrough);
      else if (kind === "parts") await writeParts(document.uri, currentParts);
      else if (kind === "planes") await writePlanes(document.uri, currentPlanes);
      else if (kind === "annotations") await writeAnnotations(document.uri, currentAnnotations);
      else if (currentMeshOptions) {
        await writeMeshOptions(document.uri, currentMeshOptions);
        await writeGeoScript(document.uri, currentMeshOptions);
      }
      revisions.noteSynced(kind, await diskFingerprint(kind));
      revisions.resolve(kind);
    };

    const raiseConflict = async (kind: SidecarKind, sides: ConflictSides): Promise<void> => {
      revisions.pause(kind);
      saveTimerOf[kind]();
      if (openConflicts.has(kind)) return;
      openConflicts.add(kind);
      const label = SIDECAR_KIND_LABELS[kind];
      post({ type: "status", text: `${label}: external change conflicts with unsaved changes — autosave paused` });
      try {
        const choice = await vscode.window.showWarningMessage(
          summarizeConflict(kind, fileName, sides),
          {},
          "Reload from disk",
          "Keep mine (overwrite)"
        );
        if (choice === "Reload from disk") {
          const fresh = await checks.get(kind)?.();
          fresh?.adopt();
          revisions.noteSynced(kind, await diskFingerprint(kind));
          revisions.resolve(kind);
          post({ type: "status", text: `${label} reloaded from disk` });
        } else if (choice === "Keep mine (overwrite)") {
          await writeLocal(kind);
          post({ type: "status", text: `${label}: disk overwritten with this editor's version` });
        } else {
          post({
            type: "status",
            text: `${label}: autosave paused until the conflict is resolved — File ▸ Save overwrites the disk version`,
          });
        }
      } catch (err) {
        post({ type: "error", message: `Could not resolve the ${label.toLowerCase()} conflict: ${(err as Error).message}` });
      } finally {
        openConflicts.delete(kind);
      }
    };

    /** Debounced-autosave body for `kind`: checks disk against the known
     * revision first; a moved disk (or a paused kind) raises the conflict
     * instead of overwriting. */
    const guardedAutosave = async (kind: SidecarKind): Promise<void> => {
      const fp = await diskFingerprint(kind);
      if (!revisions.canWrite(kind, fp)) {
        const fresh = await checks.get(kind)?.();
        if (!fresh) {
          // Disk content equals ours after all (e.g. a formatting-only rewrite) — adopt the revision.
          revisions.noteSynced(kind, fp);
          if (!revisions.isPaused(kind)) return void (await writeLocal(kind));
          return;
        }
        void raiseConflict(kind, fresh.sides);
        return;
      }
      await writeLocal(kind);
    };

    const watchSidecar = (kind: SidecarKind, check: SidecarCheck): void => {
      checks.set(kind, check);
      watchForExternalChange(sidecarUriFor[kind], () => {
        void (async () => {
          const fp = await diskFingerprint(kind);
          const fresh = await check();
          const verdict = revisions.classifyDiskChange(kind, fresh === null);
          if (verdict === "echo") {
            revisions.noteSynced(kind, fp);
            return;
          }
          if (verdict === "conflict") {
            void raiseConflict(kind, fresh!.sides);
            return;
          }
          fresh!.adopt();
          revisions.noteSynced(kind, fp);
        })();
      });
    };

    watchForExternalChange(document.uri, () => {
      if (!route) return;
      // Tier 0: our own in-place save fires this watcher too — skip exactly
      // one event rather than "reloading" what we just wrote.
      if (expectOwnSourceSave) {
        expectOwnSourceSave = false;
        return;
      }
      if (!isDocumentDirty()) {
        post({ type: "status", text: "File changed on disk — reloading…" });
        loadModel(true);
        return;
      }
      // An external source replacement while unbaked edits are pending: the
      // edits sidecar survives either way, but replaying the tail over a
      // different base is the user's call, not ours.
      void (async () => {
        const choice = await vscode.window.showWarningMessage(
          `${fileName} was replaced on disk while it has ${unsavedEditCount()} unsaved edit(s). Reload the new file (your edits are kept in the sidecar and replayed over it)?`,
          {},
          "Reload",
          "Keep editing"
        );
        if (choice === "Reload") {
          post({ type: "status", text: "File changed on disk — reloading…" });
          loadModel(true);
        } else {
          post({ type: "status", text: "Source changed on disk — still showing the previous version; reopen to load it" });
        }
      })();
    });

    watchSidecar("edits", async () => {
      const parsed = await readEdits(document.uri);
      const { ops: resolvedOps } = resolvePlaneRefs(parsed.ops, currentPlanes);
      if (JSON.stringify(resolvedOps) === JSON.stringify(currentEdits) && JSON.stringify(parsed.variables) === JSON.stringify(currentVariables)) {
        return null;
      }
      return {
        sides: { local: currentEdits.length, disk: resolvedOps.length },
        adopt: () => {
          const previousOps = currentEdits;
          currentEdits = resolvedOps;
          currentVariables = parsed.variables;
          // Tier 0: an external writer (only this extension's own save-in-place
          // sets it today) may have moved the watermark — adopt it so the tail
          // slice below stays aligned with the file on disk.
          currentBakedThrough = parsed.bakedThrough;
          if (route && route.strategy === "occt") {
            loadModel();
            void rebindPartsOnChange(previousOps, currentEdits);
          }
          postEdits();
          post({ type: "status", text: "Edits updated externally" });
        },
      };
    });

    watchSidecar("parts", async () => {
      const parts = await readParts(document.uri);
      if (JSON.stringify(parts) === JSON.stringify(currentParts)) return null;
      return {
        sides: { local: currentParts.length, disk: parts.length },
        adopt: () => {
          currentParts = parts;
          post({ type: "parts", parts: currentParts });
          post({ type: "status", text: "Parts updated externally" });
        },
      };
    });

    watchSidecar("planes", async () => {
      const planes = await readPlanes(document.uri);
      if (JSON.stringify(planes) === JSON.stringify(currentPlanes)) return null;
      return {
        sides: { local: currentPlanes.length, disk: planes.length },
        adopt: () => {
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
            postEdits();
          }
        },
      };
    });

    watchSidecar("annotations", async () => {
      const annotations = await readAnnotations(document.uri);
      if (JSON.stringify(annotations) === JSON.stringify(currentAnnotations)) return null;
      return {
        sides: { local: currentAnnotations.length, disk: annotations.length },
        adopt: () => {
          currentAnnotations = annotations;
          post({ type: "annotations", annotations: currentAnnotations });
          post({ type: "status", text: "Annotations updated externally" });
        },
      };
    });

    watchSidecar("mesh", async () => {
      const options = await readMeshOptions(document.uri);
      if (JSON.stringify(options) === JSON.stringify(currentMeshOptions)) return null;
      return {
        sides: { local: null, disk: null },
        adopt: () => {
          currentMeshOptions = options;
          post({ type: "meshingOptions", options });
          post({ type: "status", text: "Mesh options updated externally" });
        },
      };
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
      // Drop this tab's queued/running kernel work first — nothing will read it.
      docPipeline.cancel();
      for (const job of this.meshingJobs.values()) {
        if (job.documentKey === documentKey) this.cancelMeshingJob(document.uri, job.requestId);
      }
      this.scopedPipelines.delete(documentKey);
      void this.pipeline.disposeBRepCacheForDocument(documentKey);
      void this.pipeline.disposeBRepCacheForDocument(`${documentKey}::oppreview`);
    });

    // Track this editor as the active one while it is focused, so the
    // File-menu commands/keybindings can reach it.
    const session: EditorSession = {
      uri: document.uri,
      export: () => {
        if (route) this.handleExport(document.uri, route, post, pending, currentEdits, currentParts, currentBakedThrough, (f) => performSaveInPlace(f));
      },
      save: flushSidecars,
      savePreprocess: () => {
        void flushSidecars().then(() => this.handleSavePreprocess(document.uri, post));
      },
      screenshot: () => {
        void this.handleScreenshot(document.uri, post, pending);
      },
      exportSvg: () => {
        if (route) void this.handleExportSvg(document.uri, route, post, currentEdits, currentViewState, "svg", currentAnnotations, false, currentBakedThrough);
      },
      exportMesh: () => {
        void this.handleExportMesh(document.uri, route, currentEdits, currentMeshOptions, post, currentBakedThrough);
      },
      zoomToSelection: () => {
        post({ type: "zoomToSelection" });
      },
      exportDxf: () => {
        if (route) void this.handleExportSvg(document.uri, route, post, currentEdits, currentViewState, "dxf", currentAnnotations, false, currentBakedThrough);
      },
      exportDrawing: () => {
        if (route) void this.handleExportSvg(document.uri, route, post, currentEdits, currentViewState, "svg", currentAnnotations, true, currentBakedThrough);
      },
      exportSheet: () => {
        if (route) void this.handleExportSheet(document.uri, route, post, currentEdits, currentAnnotations, currentBakedThrough);
      },
      post,
    };
    this.sessions.set(documentKey, session);
    // Tier 0 Phase 2 — save/revert entry points for `saveCustomDocument` /
    // `revertCustomDocument` (they mutate closure state no class method can
    // reach). Removed on dispose alongside the session entry below.
    this.documentSavers.set(documentKey, {
      save: saveDocumentSource,
      revert: revertToSavePoint,
      markDirty: () => this.fireDirty(document),
      receive: (msg) => handleWebviewMessage(msg),
    });
    const track = () => {
      if (webviewPanel.active) this.activeSession = session;
    };
    track();
    webviewPanel.onDidChangeViewState(track);
    webviewPanel.onDidDispose(() => {
      if (this.activeSession === session) this.activeSession = undefined;
      this.sessions.delete(documentKey);
      this.documentSavers.delete(documentKey);
    });

    let handleWebviewMessage: (msg: WebviewToHost) => Promise<void> = async () => {};
    webviewPanel.webview.onDidReceiveMessage(handleWebviewMessage = async (msg: WebviewToHost) => {
      if (msg.type === "ready") {
        post({ type: "kernelStatus", state: this.pipeline.kernelState() });
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
        currentBakedThrough = parsed.bakedThrough;
        currentPlanes = planesInitial;
        loadModel(true);
        postEdits();
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
                const scadWarnings: string[] = [];
                const src = await this.readOcctSource(document.uri, route.format, scadWarnings);
                for (const w of scadWarnings) post({ type: "status", text: w });
                const bytes = src.bytes;
                const format = src.format;
                const selected = await docPipeline.resolvePartSelectors(
                  this.context.extensionPath,
                  bytes,
                  format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
                  replayTail(currentEdits, currentBakedThrough),
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
        void this.sendMeshPresets(document.uri, post);
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
        revisions.markLocalPending("parts");
        partsSaveTimer = setTimeout(() => {
          void guardedAutosave("parts").then(
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
        revisions.markLocalPending("annotations");
        annotationsSaveTimer = setTimeout(() => {
          void guardedAutosave("annotations").then(
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
        revisions.markLocalPending("planes");
        planesSaveTimer = setTimeout(() => {
          void guardedAutosave("planes").then(
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
        // Tier 0 Phase 2+3 — dirty tracking: an unbaked tail on a source
        // that can bake it marks the editor dirty (VS Code clears it when a
        // save/revert completes). The predicate is `isDocumentDirty` (defined
        // with the watermark above) — shared with the menubar's document chip.
        if (isDocumentDirty()) {
          this.fireDirty(document);
        }
        // The chip is synced on EVERY edit, not only when dirty: undoing back to
        // the save point makes the tail empty, which must clear the chip's dot —
        // and for a mesh source nothing else posts to the webview on this path
        // (mesh edits are applied client-side), so this is the only place that
        // would notice. VS Code's own tab dot stays lit in that case until a
        // save/revert; the chip is the accurate one.
        syncDocumentInfo();
        // Debounced sidecar autosave (separate timer/file from parts).
        if (editsSaveTimer) clearTimeout(editsSaveTimer);
        revisions.markLocalPending("edits");
        editsSaveTimer = setTimeout(() => {
          void guardedAutosave("edits").then(
            undefined,
            (err) => post({ type: "error", message: `Could not save edits: ${(err as Error).message}` })
          );
        }, PARTS_SAVE_DEBOUNCE_MS);
        // B-rep edits are applied in the host, so re-tessellate immediately. Mesh
        // edits are applied in the webview itself, which already updated the view.
        if (route && route.strategy === "occt") {
          // Tier 0: undo/remove crossing the save point cannot be honored —
          // the baked prefix lives in the file itself now. Past the point the
          // view simply shows the saved state (tail replay is empty there);
          // a change WITHIN the baked prefix would misalign the tail, so say
          // so loudly rather than rendering a confidently-wrong model. Full
          // refusal (undo-past-save) is Phase 2 editor-contract work.
          if (
            currentBakedThrough > 0 &&
            JSON.stringify(previousOps.slice(0, currentBakedThrough)) !==
              JSON.stringify(currentEdits.slice(0, Math.min(currentBakedThrough, currentEdits.length)))
          ) {
            post({
              type: "error",
              message: `That edit touches ops already saved into ${document.uri.path.slice(document.uri.path.lastIndexOf("/") + 1)} itself — close and reopen the file to work from the saved state.`,
            });
          }
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
        revisions.markLocalPending("mesh");
        meshSaveTimer = setTimeout(() => {
          void guardedAutosave("mesh").then(
            undefined,
            (err) => post({ type: "error", message: `Could not save mesh options: ${(err as Error).message}` })
          );
        }, PARTS_SAVE_DEBOUNCE_MS);
        return;
      }

      if (msg.type === "meshDeviationRequest") {
        try {
          if (!route) throw new Error("Unsupported file type.");
          const input = await this.resolveMeshInput(document.uri, route, currentEdits, msg.stl, "mm", currentBakedThrough);
          if (!input) throw new Error("No mesh geometry available: missing STL data.");
          const { parts, options } = await this.resolveMeshPartsAndOptions(document.uri, input, msg.options);
          let reference: Parameters<KernelClient["measureMeshDeviation"]>[1];
          if (route.strategy === "occt") {
            const src = await this.readOcctSource(document.uri, route.format, []);
            reference = {
              kind: "brep",
              bytes: src.bytes,
              format: src.format as "step" | "iges" | "brep" | "csg",
              ops: replayTail(currentEdits, currentBakedThrough),
            };
          } else if (input.kind === "stl") {
            reference = { kind: "stl", stlBytes: input.stlBytes };
          } else {
            throw new Error("No reference surface available for this source.");
          }
          const result = await docPipeline.measureMeshDeviation(this.context.extensionPath, reference, input, options, parts, {
            tolerance: msg.tolerance,
            perCorner: true,
          });
          for (const w of result.warnings) post({ type: "status", text: w });
          const corners = result.corners!;
          post({
            type: "meshDeviationResult",
            requestId: msg.requestId,
            report: result.report,
            positions: encodeBuffer(corners.positions),
            distances: encodeBuffer(corners.distances),
            // The overlay colours mesh vertices by THEIR distance to the
            // reference, so the ramp tops out at the largest of those.
            max: Math.max(msg.tolerance, ...Array.from(corners.distances).slice(0, 1_000_000).filter(Number.isFinite)),
          });
        } catch (err) {
          post({ type: "meshDeviationError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "meshingGenerate") {
        try {
          await this.runMeshingJob(document.uri, msg.requestId, post, async () => {
            const input = await this.resolveMeshInput(document.uri, route, currentEdits, msg.stl, "mm", currentBakedThrough);
            if (!input) throw new Error("No mesh geometry available: missing STL data.");
            const { parts, options } = await this.resolveMeshPartsAndOptions(document.uri, input, msg.options);
            const startedAt = Date.now();
            const result = await this.docPipeline(document.uri).generateMesh(this.context.extensionPath, input, options, parts);
            this.assertMeshingJobActive();
            post({
              type: "meshingResult",
              requestId: msg.requestId,
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
          });
        } catch (err) {
          post({ type: "meshingError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }

      /**
       * FE Mesh panel's refinement sweep (roadmap Tier 1 "Parity gaps"): the
       * interactive half of `compare_mesh_refinement`. One input resolution
       * for the whole sweep, then the SAME `runMeshSweep` loop the tool runs,
       * so rows cannot disagree. Runs under the meshing job owner, so the
       * panel's Cancel stops it. The document's options are never written.
       */
      if (msg.type === "meshSweepRequest") {
        try {
          const sizes = validateSweepSizes(msg.sizes);
          let outDir: vscode.Uri | undefined;
          if (msg.writeOutputs) {
            const picked = await vscode.window.showOpenDialog({
              canSelectFolders: true,
              canSelectFiles: false,
              canSelectMany: false,
              defaultUri: vscode.Uri.joinPath(document.uri, ".."),
              openLabel: "Write sweep meshes here",
            });
            if (!picked || picked.length === 0) {
              post({ type: "meshSweepError", requestId: msg.requestId, message: "No output folder chosen — sweep not run." });
              return;
            }
            outDir = picked[0];
          }
          await this.runMeshingJob(document.uri, msg.requestId, post, async () => {
            const input = await this.resolveMeshInput(document.uri, route, currentEdits, msg.stl, "mm", currentBakedThrough);
            if (!input) throw new Error("No mesh geometry available: missing STL data.");
            // Every run overrides sizeMin/sizeMax, so the panel's own sizes are inert here.
            const { parts, options } = await this.resolveMeshPartsAndOptions(document.uri, input, msg.options);
            const warnings: string[] = [];
            const pipeline = this.docPipeline(document.uri);
            const baseName = document.uri.path.slice(document.uri.path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
            const runs = await runMeshSweep(
              sizes,
              options,
              (runOptions) => pipeline.generateMesh(this.context.extensionPath, input, runOptions, parts),
              {
                warnings,
                writeOutputs: outDir
                  ? async (size, _o, result) => {
                      this.assertMeshingJobActive();
                      const target = vscode.Uri.joinPath(outDir!, sweepOutputName(baseName, size, "msh"));
                      await vscode.workspace.fs.writeFile(target, Buffer.from(result.mshText, "utf8"));
                      return [target.fsPath];
                    }
                  : undefined,
                onRunStart: (i, size) => post({ type: "status", text: `Sweep: meshing at size ${size} (${i + 1}/${sizes.length})…` }),
              }
            );
            this.assertMeshingJobActive();
            post({
              type: "meshSweepResult",
              requestId: msg.requestId,
              runs,
              warnings,
              note: SWEEP_NOTE,
              outputDir: outDir ? outDir.fsPath : null,
            });
          });
        } catch (err) {
          post({ type: "meshSweepError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "meshingCancel") {
        const job = this.cancelMeshingJob(document.uri, msg.requestId);
        if (job) post({ type: "status", text: "Cancelling meshing job…" });
        return;
      }

      if (msg.type === "meshingExport") {
        await this.runMeshExport(document.uri, route, currentEdits, msg.target, msg.options, msg.stl, msg.unit ?? "mm", post, currentBakedThrough, msg.manifest === true, msg.requestId);
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
        if (route) this.handleExport(document.uri, route, post, pending, currentEdits, currentParts, currentBakedThrough, (f) => performSaveInPlace(f));
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
          const scadWarnings: string[] = [];
          const src = await this.readOcctSource(document.uri, route.format, scadWarnings);
          for (const w of scadWarnings) post({ type: "status", text: w });
          const bytes = src.bytes;
          const format = src.format;
          const properties = await docPipeline.computeMassProperties(
            this.context.extensionPath,
            bytes,
            format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
            replayTail(currentEdits, currentBakedThrough),
            msg.entityId
          );
          post({ type: "massPropertiesResult", requestId: msg.requestId, properties });
        } catch (err) {
          post({ type: "massPropertiesError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }

      /**
       * Parts-section "Copy BOM" button (roadmap Tier 1 "BOM Copy button"): one
       * row per Part over a single parse/replay — the same `computeBom` call
       * shape `generateBomTool` uses headless (existing kernel surface, no new
       * geometry work). B-rep sources only: a mesh source has no per-part rows
       * to compute. An empty parts sidecar returns zero rows (not an error —
       * same convention as `generate_bom`); the button stays disabled in that
       * case, so this is a backstop, never the primary UX.
       */
      if (msg.type === "bomRequest") {
        try {
          if (!route || route.strategy !== "occt") {
            throw new Error("BOM rows are computed for B-rep sources on the host; mesh sources have no per-part rows to compute.");
          }
          const parts = await readParts(document.uri);
          if (parts.length === 0) {
            post({ type: "bomResult", requestId: msg.requestId, rows: [], warnings: ["No parts defined on this document."] });
            return;
          }
          const scadWarnings: string[] = [];
          const src = await this.readOcctSource(document.uri, route.format, scadWarnings);
          for (const w of scadWarnings) post({ type: "status", text: w });
          const result = await docPipeline.computeBom(
            this.context.extensionPath,
            src.bytes,
            src.format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
            replayTail(currentEdits, currentBakedThrough),
            parts
          );
          post({ type: "bomResult", requestId: msg.requestId, rows: result.rows, warnings: [...scadWarnings, ...result.warnings] });
        } catch (err) {
          post({ type: "bomError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }

      /**
       * Parts-section "Copy hole table" button (roadmap Tier 1 "Parity
       * gaps"): the interactive half of `generate_hole_table`, over the same
       * `computeHoleTable` pipeline key and the same tail replay. B-rep only.
       */
      if (msg.type === "holeTableRequest") {
        try {
          if (!route || route.strategy !== "occt") {
            throw new Error("Hole tables enumerate analytic B-rep cylinder faces; mesh sources have none.");
          }
          const scadWarnings: string[] = [];
          const src = await this.readOcctSource(document.uri, route.format, scadWarnings);
          for (const w of scadWarnings) post({ type: "status", text: w });
          const result = await docPipeline.computeHoleTable(
            this.context.extensionPath,
            src.bytes,
            src.format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
            replayTail(currentEdits, currentBakedThrough)
          );
          post({ type: "holeTableResult", requestId: msg.requestId, rows: result.rows, warnings: [...scadWarnings, ...result.warnings] });
        } catch (err) {
          post({ type: "holeTableError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }

      /**
       * Clash panel (roadmap Tier 1 "Clash panel"): Part-vs-Part interference
       * over the existing `checkInterference` kernel function — the same
       * request/response shape as `massPropertiesRequest` above, over existing
       * kernel surface. Part-name resolution lives here (the pipeline function
       * itself stays Part-ignorant — the same split `checkInterferenceTool`
       * in `mcpTools.ts` establishes headless). B-rep sources only: a mesh
       * has no exact B-rep boolean geometry for `BRepAlgoAPI_Common_3`.
       */
      if (msg.type === "clashCheckRequest") {
        try {
          if (!route || route.strategy !== "occt") {
            throw new Error("Clash detection needs a B-rep source; mesh sources have no exact boolean geometry to intersect.");
          }
          // Mirror `checkInterferenceTool`'s `resolveOperand`: volumes only
          // (interference is a solid-only concept); unknown/empty degrades to
          // a warning, never a throw.
          const warnings: string[] = [];
          const resolveOperand = async (label: "A" | "B", partName: string): Promise<string[]> => {
            const parts = await readParts(document.uri);
            const part = parts.find((p) => p.name === partName);
            if (!part) {
              warnings.push(`Part "${partName}" (operand ${label}) not found.`);
              return [];
            }
            if (part.volumes.length === 0) {
              warnings.push(`Part "${partName}" (operand ${label}) has no assigned solids (volumes).`);
            }
            return part.volumes;
          };
          const [idsA, idsB] = await Promise.all([
            resolveOperand("A", msg.partA),
            resolveOperand("B", msg.partB),
          ]);
          if (idsA.length === 0 || idsB.length === 0) {
            for (const w of warnings) post({ type: "status", text: w });
            post({ type: "clashCheckResult", requestId: msg.requestId, result: { hasOverlap: false, overlapVolume: 0, unresolvedA: [], unresolvedB: [] } });
            return;
          }
          const scadWarnings: string[] = [];
          const src = await this.readOcctSource(document.uri, route.format, scadWarnings);
          for (const w of scadWarnings) post({ type: "status", text: w });
          const bytes = src.bytes;
          const format = src.format;
          const result = await docPipeline.checkInterference(
            this.context.extensionPath,
            bytes,
            format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
            replayTail(currentEdits, currentBakedThrough),
            idsA,
            idsB
          );
          for (const w of warnings) post({ type: "status", text: w });
          if (result.unresolvedA.length > 0) post({ type: "status", text: `Operand A: unresolved id(s) ${result.unresolvedA.join(", ")}.` });
          if (result.unresolvedB.length > 0) post({ type: "status", text: `Operand B: unresolved id(s) ${result.unresolvedB.join(", ")}.` });
          post({ type: "clashCheckResult", requestId: msg.requestId, result });
        } catch (err) {
          post({ type: "clashCheckError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }

      /**
       * Clash panel, all-pairs variant over `checkInterferenceAll` (one
       * parse/replay total, AABB-pre-filtered — mirror
       * `checkInterferenceAllTool`'s selection: every Part with volumes).
       * The `pairs.length !== C(n,2)` contract guard the tool layer owns
       * headless applies here too — a future pipeline change fails loudly
       * instead of mislabelling rows.
       */
      if (msg.type === "clashCheckAllRequest") {
        try {
          if (!route || route.strategy !== "occt") {
            throw new Error("Clash detection needs a B-rep source; mesh sources have no exact boolean geometry to intersect.");
          }
          const parts = await readParts(document.uri);
          const usable = parts.filter((p) => p.volumes.length > 0);
          if (usable.length < 2) {
            throw new Error(
              usable.length === 0
                ? "No Parts with assigned solids — assign solids to at least two Parts first."
                : "Only one Part has assigned solids — at least two are needed to check for clashes."
            );
          }
          const scadWarnings: string[] = [];
          const src = await this.readOcctSource(document.uri, route.format, scadWarnings);
          for (const w of scadWarnings) post({ type: "status", text: w });
          const bytes = src.bytes;
          const format = src.format;
          const result = await docPipeline.checkInterferenceAll(
            this.context.extensionPath,
            bytes,
            format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
            replayTail(currentEdits, currentBakedThrough),
            usable.map((p) => p.volumes),
            msg.maxPairs !== undefined || msg.maxBooleans !== undefined
              ? { maxPairs: msg.maxPairs, maxBooleans: msg.maxBooleans }
              : undefined
          );
          const expected = (usable.length * (usable.length - 1)) / 2;
          if (result.pairs.length !== expected) {
            throw new Error(`Interference pipeline returned ${result.pairs.length} pair(s) for ${usable.length} part(s) — expected ${expected}.`);
          }
          for (const w of result.warnings) post({ type: "status", text: w });
          // Name pairs in the kernel's `i<j` enumeration order (the same
          // naming loop `checkInterferenceAllTool` owns headless).
          const named: Array<(typeof result.pairs)[number] & { partA: string; partB: string }> = [];
          for (let x = 0, n = 0; x < usable.length; x++) {
            for (let y = x + 1; y < usable.length; y++, n++) {
              named.push({ ...result.pairs[n], partA: usable[x].name, partB: usable[y].name });
            }
          }
          post({
            type: "clashCheckAllResult",
            requestId: msg.requestId,
            pairs: named,
            warnings: result.warnings,
            totalPairs: result.totalPairs,
            checkedPairs: result.checkedPairs,
            screenedPairs: result.screenedPairs,
            partial: result.uncheckedCount > 0,
          });
        } catch (err) {
          post({ type: "clashCheckAllError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "macroRun") {
        try {
          const libraryPath = macroLibraryPath(document.uri);
          const library = parseScriptLibraryJson(await readTextFile(libraryPath));
          const bundled = parseScriptLibraryJson(await readTextFile(bundledMacrosPath(this.context.extensionPath)));
          // Caller-owned entries shadow bundled starters of the same name —
          // the same merge (and precedence) `sendMacros` displays, so Run and
          // the panel list can never disagree about which script a name means.
          const { merged } = mergeScriptLibraries(bundled, library);
          const entry = merged[msg.name];
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
          if (!Object.prototype.hasOwnProperty.call(library, msg.name)) {
            // Either a bundled starter (read-only — the panel hides its
            // Delete button, so this is a backstop, not a normal path) or a
            // name that was never saved here at all.
            const bundled = parseScriptLibraryJson(await readTextFile(bundledMacrosPath(this.context.extensionPath)));
            if (Object.prototype.hasOwnProperty.call(bundled, msg.name)) {
              throw new Error(`"${msg.name}" is a bundled starter macro and cannot be deleted — save your own macro under a different name to override it.`);
            }
            throw new Error(`No saved macro named "${msg.name}".`);
          }
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

      if (msg.type === "meshPresetApply") {
        try {
          const library = parseMeshPresetsJson(await readTextFile(meshPresetLibraryPath(document.uri)));
          const bundled = parseMeshPresetsJson(
            await readTextFile(bundledMeshPresetsPath(this.context.extensionPath))
          );
          // Same merge (and precedence) `sendMeshPresets` displays, so Apply
          // and the panel list can never disagree about what a name means.
          const { merged } = mergePresetLibraries(bundled, library);
          const entry = merged[msg.name];
          if (!entry) throw new Error(`No saved mesh preset named "${msg.name}".`);
          const { options, warnings } = effectivePresetOptions(entry);
          // The `set_mesh_options` write exactly: `.mesh.json` + regenerated
          // `.geo`, kept in the session closure so a later Save flushes the
          // applied values rather than stale ones.
          currentMeshOptions = options;
          await Promise.all([writeMeshOptions(document.uri, options), writeGeoScript(document.uri, options)]);
          post({ type: "meshingOptions", options });
          const suffix = warnings.length > 0 ? ` (${warnings.join(" ")})` : "";
          post({ type: "status", text: `Applied mesh preset "${msg.name}".${suffix}` });
        } catch (err) {
          post({ type: "error", message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "meshPresetSaveCurrent") {
        try {
          const name = await vscode.window.showInputBox({
            title: "Save meshing preset",
            prompt: "Name for this preset (current FE Mesh options, stored in mm)",
            placeHolder: "my-coarse",
            validateInput: (v) => (v.trim() === "" ? "A name is required" : null),
          });
          if (name === undefined) return; // dismissed — a quiet no-op
          const trimmed = name.trim();
          // Current options are mm-native, so the preset is stored at
          // `unit: "mm"` — conversion on a later apply is then a no-op, and
          // the stored numbers always match what the panel showed.
          const options = currentMeshOptions ?? (await readMeshOptions(document.uri));
          const libraryPath = meshPresetLibraryPath(document.uri);
          const library = parseMeshPresetsJson(await readTextFile(libraryPath));
          const existed = Object.prototype.hasOwnProperty.call(library, trimmed);
          library[trimmed] = {
            name: trimmed,
            description: `Saved from current options`,
            unit: "mm",
            engine: options.engine,
            options,
          };
          await vscode.workspace.fs.writeFile(
            vscode.Uri.file(libraryPath),
            Buffer.from(serializeMeshPresetsJson(library), "utf8")
          );
          await this.sendMeshPresets(document.uri, post);
          post({ type: "status", text: `Saved mesh preset "${trimmed}"${existed ? " (replaced existing)." : "."}` });
        } catch (err) {
          post({ type: "error", message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "meshPresetDelete") {
        try {
          const libraryPath = meshPresetLibraryPath(document.uri);
          const library = parseMeshPresetsJson(await readTextFile(libraryPath));
          if (!Object.prototype.hasOwnProperty.call(library, msg.name)) {
            // Either a bundled starter (read-only — the panel hides its
            // Delete button, so this is a backstop, not a normal path) or a
            // name that was never saved here at all.
            const bundled = parseMeshPresetsJson(
              await readTextFile(bundledMeshPresetsPath(this.context.extensionPath))
            );
            if (Object.prototype.hasOwnProperty.call(bundled, msg.name)) {
              throw new Error(`"${msg.name}" is a bundled starter preset and cannot be deleted — save your own preset under a different name to override it.`);
            }
            throw new Error(`No saved mesh preset named "${msg.name}".`);
          }
          delete library[msg.name];
          await vscode.workspace.fs.writeFile(
            vscode.Uri.file(libraryPath),
            Buffer.from(serializeMeshPresetsJson(library), "utf8")
          );
          await this.sendMeshPresets(document.uri, post);
          post({ type: "status", text: `Deleted mesh preset "${msg.name}".` });
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
          const scadWarnings: string[] = [];
          const src = await this.readOcctSource(document.uri, route.format, scadWarnings);
          for (const w of scadWarnings) post({ type: "status", text: w });
          const bytes = src.bytes;
          const format = src.format;
          const facts = await docPipeline.getEntityFacts(
            this.context.extensionPath,
            bytes,
            format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
            replayTail(currentEdits, currentBakedThrough),
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
          const scadWarnings: string[] = [];
          const src = await this.readOcctSource(document.uri, route.format, scadWarnings);
          for (const w of scadWarnings) post({ type: "status", text: w });
          const bytes = src.bytes;
          const format = src.format;
          const results: SelectorSynthesizeResultEntry[] = [];
          // Tier 0: the webview addresses buckets by FULL-history row (the
          // geometry post rebases kernel indices for display); the kernel
          // replays the tail, so translate back to replay-list-relative here.
          const tailEdits = replayTail(currentEdits, currentBakedThrough);
          const replayOp = msg.op - currentBakedThrough;
          for (const entityId of msg.entityIds) {
            try {
              if (!Number.isInteger(replayOp) || replayOp < 0 || replayOp >= tailEdits.length) {
                throw new Error(`Bucket op ${msg.op} is inside the baked prefix — it cannot be re-synthesized without rewriting the source file.`);
              }
              const r = await docPipeline.synthesizeSelector(
                this.context.extensionPath,
                bytes,
                format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
                tailEdits,
                replayOp,
                msg.role,
                entityId
              );
              // The kind tag is stamped here from the producing op itself —
              // server-derived (the `set_part` precedent), never caller-supplied.
              results.push({ entityId, query: r.query, kind: r.query ? tailEdits[replayOp]?.op ?? null : null, reason: r.reason });
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
          const result = await docPipeline.searchStandardParts({ q: msg.q, page: msg.page, pageSize: 20 });
          if (!result.available) throw new Error(result.reason);
          lastPartsSearch = {
            requestId: msg.requestId,
            pngById: new Map(result.value.items.map((i) => [i.id, i.pngUrl ?? ""])),
          };
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

      if (msg.type === "standardPartsThumbsRequest") {
        // Fire-and-forget (roadmap Tier 1 "Standard-parts thumbnails"): fetch
        // this rendered page's thumbnails with bounded concurrency and post
        // back only the successes — failures stay absent (text fallback),
        // never an error. Must not hold the message loop: search/insert
        // round trips behind a slow image fetch would read as a hung panel.
        void (async () => {
          const seen = lastPartsSearch;
          if (!seen || seen.requestId !== msg.searchId) return; // stale page
          const ids = msg.ids.filter((id) => seen.pngById.has(id)).slice(0, 25);
          const thumbs: Array<{ id: string; dataUrl: string }> = [];
          for (let i = 0; i < ids.length; i += THUMB_FETCH_CONCURRENCY) {
            const batch = ids.slice(i, i + THUMB_FETCH_CONCURRENCY);
            const results = await Promise.all(
              batch.map(async (id) => {
                const url = seen.pngById.get(id) ?? "";
                if (!url) return null;
                const hit = this.thumbsCache.get(url);
                if (hit) return { id, dataUrl: hit };
                const dataUrl = await fetchThumbnail(url);
                if (!dataUrl) return null; // never cached, never posted
                this.thumbsCache.set(url, dataUrl);
                return { id, dataUrl };
              })
            );
            for (const r of results) if (r) thumbs.push(r);
          }
          if (thumbs.length === 0) return;
          post({ type: "standardPartsThumbsResult", searchId: msg.searchId, thumbs });
        })().catch(() => {
          // Belt-and-suspenders: `fetchThumbnail` never throws and the cache
          // never throws, but a floating promise must never take down the
          // handler. Silence is correct here — text fallback already covers it.
        });
        return;
      }

      if (msg.type === "standardPartsInsertRequest") {
        try {
          const downloaded = await docPipeline.downloadStandardPart(msg.id);
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
        if (route) void this.handleExportSvg(document.uri, route, post, currentEdits, currentViewState, "svg", currentAnnotations, false, currentBakedThrough);
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
        if (route) void this.handleExportSvg(document.uri, route, post, currentEdits, currentViewState, "dxf", currentAnnotations, false, currentBakedThrough);
        return;
      }

      if (msg.type === "exportDrawingRequest") {
        if (route) void this.handleExportSvg(document.uri, route, post, currentEdits, currentViewState, "svg", currentAnnotations, true, currentBakedThrough);
        return;
      }

      if (msg.type === "exportSheetRequest") {
        if (route) void this.handleExportSheet(document.uri, route, post, currentEdits, currentAnnotations, currentBakedThrough);
        return;
      }

      if (msg.type === "measureExactRequest") {
        try {
          if (!route || route.strategy !== "occt") {
            throw new Error("Exact measurement requires a B-rep source; mesh sources have no host-side geometry to re-derive it from.");
          }
          const scadWarnings: string[] = [];
          const src = await this.readOcctSource(document.uri, route.format, scadWarnings);
          for (const w of scadWarnings) post({ type: "status", text: w });
          const bytes = src.bytes;
          const format = src.format;
          const result = await docPipeline.measureExact(
            this.context.extensionPath,
            bytes,
            format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
            replayTail(currentEdits, currentBakedThrough),
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
        void this.handleOpPreview(document.uri, route, post, replayTail(currentEdits, currentBakedThrough), documentKey, msg.requestId, msg.op);
        return;
      }

      if (msg.type === "colorFieldRequest") {
        try {
          if (!route || route.strategy !== "meshio") {
            throw new Error("Colour-by-field is only available for meshio++-imported sources (VTK/MED/CGNS/Exodus/XDMF/MDPA).");
          }
          const bytes = await vscode.workspace.fs.readFile(document.uri);
          const result = await docPipeline.readMeshioFieldValues(bytes, route.format, msg.field, msg.kind);
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
          const sourceFormat = route.format as MeshParseFormat;
          const external = await resolveGltfBuffersFor(document.uri, route.format, bytes);
          try {
            const report = await docPipeline.checkMeshHealth(
              this.context.extensionPath,
              bytes,
              sourceFormat,
              external
            );
            post({ type: "meshHealResult", requestId: msg.requestId, report });
          } catch (err) {
            // Same `autoDecimate` opt-in as check_mesh_health's MCP tool:
            // only a size refusal is decimation-shaped; anything else
            // (corrupt file, unparseable content) rethrows untouched. The
            // funnel + predicate live in `meshioService.ts` (pure, no OCCT)
            // rather than `meshHeal.ts` — see `AUTO_DECIMATE_TARGET_TRIANGLES`.
            if (!msg.autoDecimate || !isHealableSizeError(err)) throw err;
            const forHeal = stlBytesForHeal(bytes, sourceFormat, external);
            const ratio = Math.min(1, AUTO_DECIMATE_TARGET_TRIANGLES / forHeal.fromTriangles);
            const decimated = await docPipeline.decimateStlBoundary(forHeal.stlBytes, ratio);
            const report = await docPipeline.checkMeshHealth(this.context.extensionPath, decimated.bytes, "stl");
            post({
              type: "meshHealResult",
              requestId: msg.requestId,
              report: {
                ...report,
                decimated: { fromTriangles: decimated.fromTriangles, toTriangles: decimated.toTriangles, ratio },
              },
            });
          }
        } catch (err) {
          post({ type: "meshHealError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "meshioOpsRequest") {
        try {
          if (!route || route.strategy !== "meshio") {
            throw new Error("Mesh operations require a meshio++-imported source (VTK/MED/CGNS/Exodus/XDMF/MDPA/Gmsh/Abaqus/UNV/SU2/Medit/GiD).");
          }
          if (route.format === "openfoam") {
            throw new Error("Mesh operations are not available for OpenFOAM case markers — open the converted mesh instead.");
          }
          const specs = (msg.ops ?? []).map((o) => validateMeshioOpSpec(o));
          if (specs.length === 0 || specs.some((s) => s === null)) {
            throw new Error("Unknown mesh operation — pick one of clean/decimate/smooth/subdivide/refine/agglomerate/convertCells.");
          }
          const report = await this.handleMeshioOps(document.uri, route, specs.map((s) => s!), post);
          if (report) post({ type: "meshioOpsResult", requestId: msg.requestId, steps: report.steps, warnings: report.warnings });
          // A dismissed save dialog is a quiet no-op (no result post), mirroring every other save flow here.
        } catch (err) {
          post({ type: "meshioOpsError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "fitRegionRequest") {
        try {
          if (!route || route.strategy !== "three") {
            throw new Error("Region fitting requires an STL/OBJ/PLY/glTF source.");
          }
          const bytes = await vscode.workspace.fs.readFile(document.uri);
          const fit = await docPipeline.fitMeshRegion(
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

      /**
       * Primitives panel (Tier 1 "Primitive-recognition panel"): read-only
       * per-solid report over the existing `recognizePrimitives` kernel
       * function — the same request/response shape as `massPropertiesRequest`
       * above, over existing kernel surface. B-rep sources only: a mesh has
       * no analytic surface type, so this answers with
       * `primitiveRecognizeError` otherwise.
       */
      if (msg.type === "primitiveRecognizeRequest") {
        try {
          if (!route || route.strategy !== "occt") {
            throw new Error("Primitive recognition needs a B-rep source; mesh sources have no analytic surfaces to classify.");
          }
          const scadWarnings: string[] = [];
          const src = await this.readOcctSource(document.uri, route.format, scadWarnings);
          for (const w of scadWarnings) post({ type: "status", text: w });
          const report = await docPipeline.recognizePrimitives(
            this.context.extensionPath,
            src.bytes,
            src.format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
            replayTail(currentEdits, currentBakedThrough)
          );
          post({ type: "primitiveRecognizeResult", requestId: msg.requestId, report });
        } catch (err) {
          post({ type: "primitiveRecognizeError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "brepHealthRequest") {
        try {
          if (!route || route.strategy !== "occt") {
            throw new Error("B-rep Health needs a B-rep source; use Mesh Health for a mesh.");
          }
          const scadWarnings: string[] = [];
          const src = await this.readOcctSource(document.uri, route.format, scadWarnings);
          for (const w of scadWarnings) post({ type: "status", text: w });
          const report = await docPipeline.checkBrepHealth(
            this.context.extensionPath,
            src.bytes,
            src.format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
            replayTail(currentEdits, currentBakedThrough)
          );
          post({ type: "brepHealthResult", requestId: msg.requestId, report });
        } catch (err) {
          post({ type: "brepHealthError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "passagesRequest") {
        try {
          if (!route || route.strategy !== "occt") {
            throw new Error("Passage analysis needs a B-rep source; a mesh has no analytic cylinders or planes to measure.");
          }
          const scadWarnings: string[] = [];
          const src = await this.readOcctSource(document.uri, route.format, scadWarnings);
          for (const w of scadWarnings) post({ type: "status", text: w });
          const options = currentMeshOptions ?? (await readMeshOptions(document.uri));
          const sizeMax = options.sizeMax >= SIZE_MAX_SENTINEL ? null : options.sizeMax;
          const report = await docPipeline.analyzePassages(
            this.context.extensionPath,
            src.bytes,
            src.format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
            replayTail(currentEdits, currentBakedThrough),
            { targetCells: msg.targetCells, sizeMax, parts: currentParts }
          );
          post({ type: "passagesResult", requestId: msg.requestId, report, sizeMax });
        } catch (err) {
          post({ type: "passagesError", requestId: msg.requestId, message: (err as Error).message });
        }
        return;
      }

      if (msg.type === "decomposeExportClicked") {
        if (route) void this.handleDecomposeExport(document.uri, route, post, replayTail(currentEdits, currentBakedThrough), currentVariables);
        return;
      }

      if (msg.type === "decomposeSaveMacroClicked") {
        if (route) void this.handleDecomposeSaveMacro(document.uri, route, post, replayTail(currentEdits, currentBakedThrough), currentVariables);
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
    /**
     * `.scad`-aware source reader for every occt path below (OpenSCAD support,
     * path (b)): reads bytes and converts `.scad` to `.csg`
     * via the user-installed openscad binary (`cadPreview.openscadBinary`
     * setting, `OPENSCAD_BINARY` env fallback), so downstream only ever sees
     * step/iges/brep/csg. Conversion chatter accumulates into `warnings`
     * (each caller status-posts them); a missing binary throws
     * ScadUnavailableError, which every caller's EXISTING catch already
     * posts — its message IS the install hint, so no per-site mapping.
     */
    private async readOcctSource(
      uri: vscode.Uri,
      format: CadFormat,
      warnings: string[]
    ): Promise<{ bytes: Uint8Array; format: CadFormat }> {
      const binary = vscode.workspace.getConfiguration("cadPreview").get<string>("openscadBinary") ?? undefined;
      return resolveEffectiveSource({
        modelPath: uri.fsPath,
        format,
        readBytes: async () => vscode.workspace.fs.readFile(uri),
        warnings,
        binary,
      });
    }

    private async handleBRep(
     uri: vscode.Uri,
     format: Extract<CadFormat, "step" | "iges" | "brep" | "csg" | "scad">,
    post: (msg: HostToWebview) => void,
    ops: EditOp[] = [],
    documentKey: string,
    generation: number,
    genHolder: { current: number },
    autoFit = true,
    progress?: vscode.Progress<{ message?: string }>,
    /**
     * Tier 0: how many leading ops of the document's FULL history are already
     * baked into the file. `ops` above is the replay tail, so the kernel's
     * `opOutcomes`/`opBuckets` indices are tail-relative — rebased below onto
     * full-history rows so the Edits panel's ⚠ marks and `+N` chips land on
     * the right rows. 0 on pre-watermark documents (identity rebase).
     * `bakedKinds` carries those leading ops' kinds for the padding outcomes.
     */
    bakedThrough = 0,
    bakedKinds: EditOpKind[] = []
  ): Promise<void> {
    try {
      post({ type: "status", text: `Loading ${format.toUpperCase()} kernel…` });
      progress?.report({ message: `Loading ${format.toUpperCase()} kernel…` });
      // `.scad` converts to `.csg` bytes first (user-installed openscad
      // binary) — everything below only ever sees step/iges/brep/csg.
      // A missing binary throws ScadUnavailableError, which the catch below
      // posts as the error message (it IS the install hint).
      const scadWarnings: string[] = [];
      const src = await this.readOcctSource(uri, format, scadWarnings);
      const bytes = src.bytes;
      const effectiveFormat = src.format;
      post({ type: "status", text: `Tessellating ${format.toUpperCase()}…` });
      progress?.report({ message: `Tessellating ${format.toUpperCase()}…` });
      // Re-read fresh on every call (cheap) rather than cached at document-open
      // time — a mid-session settings change should take effect on the NEXT
      // edit without needing to reopen the tab, same as every other
      // `cadPreview.*` setting's "always re-read" convention.
      const quality = normalizeTessellationQuality(
        vscode.workspace.getConfiguration("cadPreview").get("tessellationQuality")
      );
      const result = await this.docPipeline(uri).loadBRepCachedForDocument(
        documentKey,
        this.context.extensionPath,
        bytes,
        effectiveFormat as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
        ops,
        tessellationParamsFor(quality)
      );
      if (generation !== genHolder.current) return; // superseded or cancelled — see doc comment above
      post({ type: "status", text: "Rendering…" });
      progress?.report({ message: "Rendering…" });
      const { groups, edges, points, tree, opOutcomes, opBuckets, guideIds, queryWarnings, warnings } = result;
      // A frozen operand query replays on its cached ids — the user must know
      // the query was not honored rather than staring at unchanged geometry.
      // `.csg` parse/build warnings ride the same channel (a skipped hull()
      // or a faceted-cylinder approximation must never be silent).
      for (const w of queryWarnings ?? []) post({ type: "status", text: w });
      for (const w of warnings ?? []) post({ type: "status", text: w });
      for (const w of scadWarnings) post({ type: "status", text: w });
      // Tier 0 rebase (see `bakedThrough` param): tail-relative kernel indices
      // back onto full-history rows. Baked rows applied by definition (they
      // are in the file), so they pad as applied — never as skipped.
      const rebasedOutcomes: typeof opOutcomes = bakedThrough > 0
        ? [
            ...bakedKinds.slice(0, bakedThrough).map((kind, index) => ({ index, kind, applied: true as const })),
            ...opOutcomes.map((o) => ({ ...o, index: o.index + bakedThrough })),
          ]
        : opOutcomes;
      const rebasedBuckets = bakedThrough > 0 ? opBuckets.map((b) => ({ ...b, op: b.op + bakedThrough })) : opBuckets;
      post({
        type: "geometry",
        autoFit,
        opOutcomes: rebasedOutcomes,
        guideIds,
        opBuckets: rebasedBuckets,
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
      const text = effectiveFormat === "step" || effectiveFormat === "iges" ? Buffer.from(bytes).toString("latin1") : undefined;
      const sourceUnit = effectiveFormat === "step" ? detectStepLengthUnit(text!) : effectiveFormat === "iges" ? detectIgesLengthUnit(text!) : undefined;
      post({ type: "tree", root: tree, sourceUnit });
    } catch (err) {
      if (generation !== genHolder.current) return; // superseded or cancelled — see doc comment above
      if (err instanceof JobCancelledError) return; // this document's kernel work was cancelled (Cancel, or the tab closed)
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
      const scadWarnings: string[] = [];
      const src = await this.readOcctSource(uri, route.format, scadWarnings);
      for (const w of scadWarnings) post({ type: "status", text: w });
      const bytes = src.bytes;
      const format = src.format;
      const quality = normalizeTessellationQuality(
        vscode.workspace.getConfiguration("cadPreview").get("tessellationQuality")
      );
      const result = await this.docPipeline(uri).loadBRepCachedForDocument(
        `${documentKey}::oppreview`,
        this.context.extensionPath,
        bytes,
        format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
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
        // Roadmap Tier 1 "Per-band operation-preview colouring": the draft
        // op's own bucket (replay-tail-relative, like opOutcomes above — the
        // webview translates to full-history numbering for any legend text).
        opBuckets: result.opBuckets,
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
      const [boundary, metadata, provenance, existingParts] = await Promise.all([
        // OpenFOAM is the one format that is NOT a single file — a `.foam`
        // marker's real mesh lives in sibling files under
        // `<parent>/constant/polyMesh/`, staged into meshio++'s MEMFS by
        // `convertFoamCaseToStlBoundary` itself (it takes the marker's path,
        // not bytes). Its reader also surfaces no regions/data to JS (patch
        // names ride an unexposed C++ side-channel), so the region
        // correlation below cannot fire for it by construction.
        isFoam
          ? this.docPipeline(uri).convertFoamCaseToStlBoundary(uri.fsPath).then((stlBytes) => ({ stlBytes, regions: undefined }))
          : this.docPipeline(uri).convertToStlBoundaryWithRegions(bytes!, format, basename, companions!),
        isFoam ? EMPTY_MESHIO_METADATA : this.docPipeline(uri).readMeshioMetadata(bytes!, format, basename, companions!),
        // Provenance block, if the file carries one — never throws, so a
        // file without one simply yields nothing here. Geometry-only by
        // construction for OpenFOAM (see above), so it is skipped there
        // rather than staged for a guaranteed-empty answer.
        isFoam ? null : this.docPipeline(uri).readMeshioProvenance(bytes!, format, basename, companions!),
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
        ? await this.docPipeline(uri).readMeshioDataInfo(bytes!, format, basename, companions!)
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
      if (provenance) {
        post({ type: "status", text: `Provenance: ${provenance.lines.join(" | ")}` });
      }
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
    const bundled = parseScriptLibraryJson(await readTextFile(bundledMacrosPath(this.context.extensionPath)));
    const { merged } = mergeScriptLibraries(bundled, library);
    const owned = new Set(Object.keys(library));
    const macros = Object.values(merged)
      .map((entry) => ({
        name: entry.name,
        description: entry.description ?? null,
        parameters: scriptParameters(entry.script),
        // A caller-owned entry shadows a bundled starter of the same name —
        // the merged row is theirs (deletable), never the read-only starter.
        readOnly: !owned.has(entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    post({ type: "macros", macros });
  }

  /**
   * Posts the saved meshing-preset list for this document's folder.
   *
   * The library lives beside the model as `cad-preview-mesh-presets.json`,
   * shared by every model in that folder — the same file the MCP preset tools
   * take as an explicit `libraryPath`, so a preset saved here is directly
   * appliable by an agent and vice versa (the `sendMacros` precedent).
   * A missing library reads as empty, never an error.
   */
  private async sendMeshPresets(uri: vscode.Uri, post: (msg: HostToWebview) => void): Promise<void> {
    const library = parseMeshPresetsJson(await readTextFile(meshPresetLibraryPath(uri)));
    const bundled = parseMeshPresetsJson(await readTextFile(bundledMeshPresetsPath(this.context.extensionPath)));
    const { merged } = mergePresetLibraries(bundled, library);
    const owned = new Set(Object.keys(library));
    const presets: MeshPresetSummary[] = Object.values(merged)
      .map((entry) => ({
        name: entry.name,
        description: entry.description ?? null,
        unit: entry.unit,
        engine: entry.engine,
        // A caller-owned entry shadows a bundled starter of the same name —
        // the merged row is theirs (deletable), never the read-only starter.
        readOnly: !owned.has(entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    post({ type: "meshingPresets", presets });
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
    unit: DisplayUnit = "mm",
    /** Tier 0: leading baked-op count — the meshing STEP re-export replays the tail. */
    bakedThrough = 0
  ): Promise<MeshGenerationInput | undefined> {
    if (route && route.strategy === "occt") {
      // Conversion chatter is deliberately dropped here (not status-posted):
      // the document's own load path already surfaced the identical warnings
      // on open and re-surfaces them on every edit reload — repeating them on
      // every meshing call would be pure spam for a condition that hasn't
      // changed. A missing binary still throws and surfaces via the caller's
      // catch, same as every other load failure.
      const src = await this.readOcctSource(uri, route.format, []);
      const sourceBytes = src.bytes;
      // labelStepUnit: false — Gmsh's own STEP importer reinterprets a
      // correctly-labeled header and would undo this scale entirely (verified
      // against the live WASM); this intermediate file is meshing input only,
      // never shown to the user, so it stays at the OCCT-native "mm" label
      // while its geometry is still genuinely scaled. See exportBRep's doc
      // comment for the full write-up.
      const stepBytes = await this.docPipeline(uri).exportBRep(
        this.context.extensionPath,
        sourceBytes,
        src.format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
        "step",
        replayTail(ops, bakedThrough),
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
    parts: Part[] = [],
    /**
     * Tier 0 Phase 1: how many leading ops of `ops` are already baked into
     * the file. The B-rep `getBytes` below replays the tail only.
     */
    bakedThrough = 0,
    /**
     * Tier 0 Phase 1: same-format B-rep pick handler. When present and the
     * user picks the source's own B-rep format, this runs INSTEAD of the
     * export flow (save-in-place needs session state — watermark, watcher
     * guard, backup flag — that lives in the caller's closure, not here).
     */
    onSaveInPlace?: (targetFormat: CadFormat) => Promise<void>
  ): Promise<void> {
    // Tier 0 Phase 1+3: a B-rep source may target its OWN format (STEP-from-STEP
    // save-in-place), as may an STL/OBJ/PLY mesh source (mesh save-in-place).
    // glTF/meshio/CAD-text sources keep the exclusion (no same-format writer).
    const targets = exportTargetsFor(
      route,
      route.strategy === "occt" || (route.strategy === "three" && MESH_SAVE_IN_PLACE_FORMATS.has(route.format))
    );
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
    // Tier 0 Phase 1+3: same-format pick is a save-in-place, not an export —
    // a confirmed write back to the open document (temp sibling + rename,
    // one-deep .bak, bakedThrough watermark). Cross-format picks keep the
    // export flow below. Without a session callback (no open document owns
    // this call) it cannot run — refuse rather than silently exporting over
    // the source.
    if (
      targetFormat === route.format &&
      (BREP_FORMATS.has(targetFormat) || MESH_SAVE_IN_PLACE_FORMATS.has(targetFormat))
    ) {
      if (onSaveInPlace) {
        await onSaveInPlace(targetFormat);
      } else {
        post({ type: "error", message: "Saving in place needs an open document session." });
      }
      return;
    }
    // Every B-rep/mesh target this codebase can export to can now honestly
    // represent a converted unit — see UNIT_CONVERTIBLE_FORMATS' doc comment.
    const unit = UNIT_CONVERTIBLE_FORMATS.has(targetFormat) ? await this.pickExportUnit() : "mm";

    // Roadmap "Mesh-aware surface tessellation export": an STL from a B-rep
    // can be tessellated host-side at a tolerance tied to the downstream
    // cell size instead of the viewport's display density.
    if (targetFormat === "stl" && route.strategy === "occt") {
      const request = await this.pickMeshAwareTessellation(unit);
      if (request === null) return; // cancelled a required prompt
      if (request !== "viewport") {
        await this.exportMeshAwareStl(uri, route, post, replayTail(ops, bakedThrough), request, unit);
        return;
      }
    }

    await this.promptSaveAndWrite(uri, EXPORT_EXTENSION[targetFormat], EXPORT_LABEL[targetFormat], async (_saveUri) => {
      if (BREP_FORMATS.has(targetFormat)) {
        const scadWarnings: string[] = [];
        const src = await this.readOcctSource(uri, route.format, scadWarnings);
        for (const w of scadWarnings) post({ type: "status", text: w });
        const sourceBytes = src.bytes;
        return this.docPipeline(uri).exportBRep(
          this.context.extensionPath,
          sourceBytes,
          src.format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
          targetFormat as Extract<CadFormat, "step" | "iges" | "brep">,
          replayTail(ops, bakedThrough),
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
  private async pickMeshAwareTessellation(
    unit: DisplayUnit
  ): Promise<"viewport" | { targetCellSize: number; chordalFraction: number } | null> {
    const mode = await vscode.window.showQuickPick(
      [
        { label: "As displayed", description: "the viewport's tessellation", value: "viewport" as const },
        {
          label: "Mesh-aware…",
          description: "tolerance derived from a downstream cell size",
          value: "meshAware" as const,
        },
      ],
      { placeHolder: "STL tessellation…" }
    );
    // Optional step, like the unit pick: Escape keeps the viewport path.
    if (!mode || mode.value === "viewport") return "viewport";
    const positive = (v: string, max = Infinity) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 && n <= max ? null : `Enter a positive number${max < Infinity ? ` up to ${max}` : ""}.`;
    };
    const size = await vscode.window.showInputBox({
      prompt: `Downstream volume-mesh cell size (${unit})`,
      placeHolder: "e.g. 2",
      validateInput: (v) => positive(v),
    });
    if (size === undefined) return null;
    const fraction = await vscode.window.showInputBox({
      prompt: "Chordal error as a fraction of the cell size",
      value: "0.1",
      validateInput: (v) => positive(v, 1),
    });
    if (fraction === undefined) return null;
    return { targetCellSize: Number(size), chordalFraction: Number(fraction) };
  }

  private async exportMeshAwareStl(
    uri: vscode.Uri,
    route: FileRoute,
    post: (msg: HostToWebview) => void,
    ops: EditOp[],
    request: { targetCellSize: number; chordalFraction: number },
    unit: DisplayUnit
  ): Promise<void> {
    const warnings: string[] = [];
    const src = await this.readOcctSource(uri, route.format, warnings);
    for (const w of warnings) post({ type: "status", text: w });
    const format = src.format as "step" | "iges" | "brep" | "csg";
    const pipeline = this.docPipeline(uri);
    try {
      const preview = await pipeline.exportTessellatedStl(this.context.extensionPath, src.bytes, format, ops, {
        ...request,
        unit,
        dryRun: true,
      });
      post({
        type: "status",
        text: `Mesh-aware STL: ${preview.triangleCount.toLocaleString("en-US")} triangles at ${preview.requestedChordal.toPrecision(3)} ${unit} chordal tolerance`,
      });
    } catch (err) {
      post({ type: "error", message: (err as Error).message });
      return;
    }
    let summary = "";
    await this.promptSaveAndWrite(
      uri,
      "stl",
      "STL",
      async () => {
        const result = await pipeline.exportTessellatedStl(this.context.extensionPath, src.bytes, format, ops, { ...request, unit });
        const m = result.measured;
        summary = m
          ? ` — sampled chordal error max ${m.max.toPrecision(3)} ${unit} (p95 ${m.p95.toPrecision(3)}, ${m.samples} samples; requested ${result.requestedChordal.toPrecision(3)})`
          : "";
        for (const w of result.warnings) post({ type: "status", text: w });
        return result.stl ?? new Uint8Array();
      },
      post
    );
    if (summary) post({ type: "status", text: `Mesh-aware STL written${summary}` });
  }

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
   * Tier 0 Phase 1: the file's own declared unit as a `DisplayUnit`
   * (`"mm"` when the format carries no unit metadata or declares an
   * unrecognized one) — the same `detectStepLengthUnit`/
   * `detectIgesLengthUnit` text scan `handleBRep` already uses for the
   * display selector. Saving in place at the detected unit keeps the
   * declaration stable across the save (geometrically identical either way,
   * since a correctly-labelled header round-trips to the same real-world
   * size — but the file visibly changing INCH→mm would be a surprise).
   */
  private detectSourceDisplayUnit(bytes: Uint8Array, format: CadFormat): DisplayUnit {
    if (format !== "step" && format !== "iges") return "mm";
    const text = Buffer.from(bytes).toString("latin1");
    const declared = format === "step" ? detectStepLengthUnit(text) : detectIgesLengthUnit(text);
    return displayUnitFromUnitName(declared) ?? "mm";
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
        const result = await this.docPipeline(uri).promoteMeshToBrep(
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
        const result = await this.docPipeline(uri).repairMesh(
          this.context.extensionPath,
          sourceBytes,
          meshFormat,
          await resolveGltfBuffersFor(uri, meshFormat, sourceBytes),
          await readMeshOptions(uri)
        );
        return result.stlBytes;
      },
      post
    );
  }

  /**
   * Primitives panel (Tier 1 "Primitive-recognition panel") — the interactive
   * half of `decompose_to_primitives`. Deliberately a ONE-SHOT EXPORT
   * (recognize each solid, emit parametric creation ops, write them as a
   * brand-new STEP/IGES/BREP file the user opens separately), not an in-place
   * reclassification of THIS document — the same export model
   * `handlePromoteToBrep` follows, and `decompose_to_primitives`' own
   * headless contract. Mirrors `handlePromoteToBrep`'s exact structure
   * (format quick-pick over the same `BREP_FORMATS`, the existing
   * `pickExportUnit()`, the shared `promptSaveAndWrite()`) with the emission
   * (`emitPrimitiveOps`, same call shape `decomposeToPrimitivesTool` uses
   * headless, including collision-renaming against the document's own
   * variables) computed fresh here rather than trusting a client snapshot.
   * A document with zero recognized solids posts an explanatory error rather
   * than writing an empty file.
   */
  private async handleDecomposeExport(
    uri: vscode.Uri,
    route: FileRoute,
    post: (msg: HostToWebview) => void,
    ops: EditOp[],
    variables: ParamVariable[]
  ): Promise<void> {
    if (route.strategy !== "occt") {
      post({ type: "error", message: "Primitive export needs a B-rep source; mesh sources have no analytic surfaces to classify." });
      return;
    }
    const picked = await vscode.window.showQuickPick(
      [...BREP_FORMATS].map((format) => ({
        label: EXPORT_LABEL[format],
        description: `.${EXPORT_EXTENSION[format]}`,
        format: format as Extract<CadFormat, "step" | "iges" | "brep">,
      })),
      { placeHolder: "Export recognized primitives as…" }
    );
    if (!picked) return;

    const unit = await this.pickExportUnit();

    await this.promptSaveAndWrite(
      uri,
      EXPORT_EXTENSION[picked.format],
      EXPORT_LABEL[picked.format],
      async (_saveUri) => {
        const scadWarnings: string[] = [];
        const src = await this.readOcctSource(uri, route.format, scadWarnings);
        for (const w of scadWarnings) post({ type: "status", text: w });
        const report = await this.docPipeline(uri).recognizePrimitives(
          this.context.extensionPath,
          src.bytes,
          src.format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
          ops
        );
        const emission = emitPrimitiveOps(report, {
          existingVariableNames: variables.map((v) => v.name),
        });
        if (emission.ops.length === 0) {
          throw new Error("No primitives recognized — nothing to export.");
        }
        const build = await this.docPipeline(uri).buildPrimitivesFile(
          this.context.extensionPath,
          emission.ops,
          picked.format,
          unit
        );
        for (const w of [...emission.warnings, ...build.warnings]) post({ type: "status", text: w });
        return build.bytes;
      },
      post
    );
  }

  /**
   * Primitives panel, Save-macro variant — the same emission as
   * `handleDecomposeExport`, saved as a reusable parameterized macro into
   * this document's folder `cad-preview-macros.json` (the same file
   * `macroSaveCurrent` and the MCP `save_parametric_script` tool write, so a
   * macro recorded here is directly runnable by an agent and vice versa)
   * instead of a B-rep file. The emitted script is dry-compiled against its
   * own declared defaults before saving (the `save_parametric_script`
   * precedent) so a broken macro never enters the library silently.
   */
  private async handleDecomposeSaveMacro(
    uri: vscode.Uri,
    route: FileRoute,
    post: (msg: HostToWebview) => void,
    ops: EditOp[],
    variables: ParamVariable[]
  ): Promise<void> {
    try {
      if (route.strategy !== "occt") {
        throw new Error("Primitive macros need a B-rep source; mesh sources have no analytic surfaces to classify.");
      }
      const scadWarnings: string[] = [];
      const src = await this.readOcctSource(uri, route.format, scadWarnings);
      for (const w of scadWarnings) post({ type: "status", text: w });
      const report = await this.docPipeline(uri).recognizePrimitives(
        this.context.extensionPath,
        src.bytes,
        src.format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
        ops
      );
      const emission = emitPrimitiveOps(report, {
        existingVariableNames: variables.map((v) => v.name),
      });
      if (emission.ops.length === 0) {
        throw new Error("No primitives recognized — nothing to save.");
      }
      const name = await vscode.window.showInputBox({
        title: "Save primitives as macro",
        prompt: `Name for this macro (${emission.ops.length} op(s), ${emission.variables.length} variable(s))`,
        placeHolder: "recognized-primitives",
        validateInput: (v) => (v.trim() === "" ? "A name is required" : null),
      });
      if (name === undefined) return; // dismissed — a quiet no-op
      const trimmed = name.trim();
      const scriptDoc: Record<string, unknown> = {
        variables: emission.variables,
        steps: emission.ops.map((op) => ({ op })),
      };
      const probe = compileParametricScript(scriptDoc, {});
      if (probe.ops.length === 0) throw new Error(`Refusing to save "${trimmed}": the emitted script compiled to no ops.`);
      const libraryPath = macroLibraryPath(uri);
      const library = parseScriptLibraryJson(await readTextFile(libraryPath));
      const existed = Object.prototype.hasOwnProperty.call(library, trimmed);
      library[trimmed] = { name: trimmed, script: scriptDoc };
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(libraryPath),
        Buffer.from(serializeScriptLibraryJson(library), "utf8")
      );
      await this.sendMacros(uri, post);
      post({ type: "status", text: `Saved macro "${trimmed}"${existed ? " (replaced existing)." : "."}` });
    } catch (err) {
      post({ type: "error", message: (err as Error).message });
    }
  }

  /**
   * Mesh-operations panel (roadmap Tier 1 "Mesh-operations panel for meshio
   * sources") — runs one validated meshio++ operation over the current
   * meshio++-imported source and writes the result to a NEW file at a
   * save-dialog-chosen path (the export model, like `transform_mesh`'s
   * `outputPath` — the source is never modified). Mirrors `handleRepairMesh`'s
   * structure via the shared `promptSaveAndWrite`, but keeps the source's own
   * extension (including the compound `.post.msh`) so the output stays in the
   * same format family the user opened. Returns the per-step report for the
   * `meshioOpsResult` post, or `null` when the save dialog was dismissed (a
   * quiet no-op, never an error). A step that cannot run is reported and
   * skipped by `runMeshioOps` itself, never silent — those warnings surface
   * both in the result post and as status lines.
   */
  private async handleMeshioOps(
    uri: vscode.Uri,
    route: FileRoute,
    ops: import("./meshioOps").MeshioOpSpec[],
    post: (msg: HostToWebview) => void
  ): Promise<{ steps: Array<{ op: string; applied: boolean; detail: string }>; warnings: string[] } | null> {
    const extKey = matchExtension(uri.fsPath) ?? route.format;
    // The save-dialog filter takes a bare extension; the compound GiD key
    // (`post.msh`) is not one — fall back to the route format there.
    const ext = extKey.includes(".") ? route.format : extKey;
    let report: { steps: Array<{ op: string; applied: boolean; detail: string }>; warnings: string[] } | null = null;
    await this.promptSaveAndWrite(
      uri,
      ext,
      `${route.format.toUpperCase()} Mesh`,
      async (_saveUri) => {
        const basename = uri.path.slice(uri.path.lastIndexOf("/") + 1);
        const sourceBytes = await vscode.workspace.fs.readFile(uri);
        const companions = await resolveMeshioCompanionsFor(uri, basename, route.format, sourceBytes);
        const result = await this.docPipeline(uri).runMeshioOps(
          sourceBytes,
          route.format,
          ops as Parameters<typeof this.pipeline.runMeshioOps>[2],
          ext,
          basename,
          companions
        );
        report = { steps: result.steps, warnings: result.warnings };
        for (const step of result.steps) {
          post({ type: "status", text: `Mesh op ${step.op}: ${step.applied ? step.detail : `skipped — ${step.detail}`}` });
        }
        for (const warning of result.warnings) post({ type: "status", text: warning });
        return result.bytes;
      },
      post
    );
    return report;
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
    hiddenLines = false,
    /** Tier 0: leading baked-op count — the brep `CompareSource` replays the tail. */
    bakedThrough = 0
  ): Promise<void> {
    if (route.strategy !== "occt" && !COMPARABLE_MESH_FORMATS.has(route.format)) {
      const label = format.toUpperCase();
      post({ type: "error", message: `Silhouette ${label} export requires a STEP/IGES/BREP/CSG/SCAD or STL/OBJ/PLY/glTF source.` });
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
        const scadWarnings: string[] = [];
        const src = await this.readOcctSource(uri, route.format, scadWarnings);
        for (const w of scadWarnings) post({ type: "status", text: w });
        const bytes = src.bytes;
        const source: CompareSource =
          route.strategy === "occt"
            ? { kind: "brep", bytes, format: src.format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">, ops: replayTail(ops, bakedThrough) }
            : route.format === "gltf"
              ? { kind: "gltf", bytes, externalBuffers: await resolveGltfBuffersFor(uri, route.format, bytes) }
              : { kind: route.format as "stl" | "obj" | "ply", bytes };
        const result = await this.docPipeline(uri).exportSvgSilhouette(this.context.extensionPath, source, {
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
   * File ▸ Export Drawing Sheet… and `cad-preview.exportSheet` (roadmap
   * "Multi-view sheet layout"): front/top/right/iso on one sheet with a title
   * block, first-angle projection.
   *
   * Same structure as {@link handleExportSvg}, with a format and a paper pick
   * in place of the view pick, and deliberately NO unit pick: a sheet's scale
   * is a real drawn-to-actual ratio, which a coordinate conversion would
   * silently falsify. Escape on either pick cancels.
   */
  private async handleExportSheet(
    uri: vscode.Uri,
    route: FileRoute,
    post: (msg: HostToWebview) => void,
    ops: EditOp[],
    annotations: Annotation[],
    bakedThrough: number
  ): Promise<void> {
    if (route.strategy !== "occt" && !COMPARABLE_MESH_FORMATS.has(route.format)) {
      post({ type: "error", message: "Drawing sheet export requires a STEP/IGES/BREP/CSG/SCAD or STL/OBJ/PLY/glTF source." });
      return;
    }

    const name = uri.path.slice(uri.path.lastIndexOf("/") + 1);
    const libraryPath = sheetTemplateLibraryPath(uri);
    const mergedTemplates = async () => {
      const bundled = parseSheetTemplatesJson(await readTextFile(bundledSheetTemplatesPath(this.context.extensionPath)));
      const user = parseSheetTemplatesJson(await readTextFile(libraryPath));
      const { merged } = mergeSheetTemplates(bundled, user);
      return Object.values(merged).map((t) => ({ ...t, readOnly: !(t.name in user) }));
    };
    // Roadmap "Drawing-sheet settings and reusable templates": one form for
    // every setting, resolved by the SAME `resolveSheetSettings` the
    // export_drawing_sheet MCP tool uses — identical settings, identical sheet.
    const input = await showDrawingSheetForm({
      defaultTitle: name,
      initial: this.lastSheetSettings,
      templates: mergedTemplates,
      saveTemplate: async (settings) => {
        const templateName = (await vscode.window.showInputBox({ prompt: "Template name", placeHolder: "e.g. company-a3" }))?.trim();
        if (!templateName) return undefined;
        const library = parseSheetTemplatesJson(await readTextFile(libraryPath));
        library[templateName] = { ...settings, name: templateName };
        await vscode.workspace.fs.writeFile(vscode.Uri.file(libraryPath), Buffer.from(serializeSheetTemplatesJson(library), "utf8"));
        return templateName;
      },
    });
    if (!input) return;
    this.lastSheetSettings = input;
    let settings: ResolvedSheetSettings;
    try {
      settings = resolveSheetSettings(input, undefined, { title: name });
    } catch (err) {
      post({ type: "error", message: (err as Error).message });
      return;
    }
    for (const w of settings.warnings) post({ type: "status", text: w });
    const format = settings.format;
    await this.promptSaveAndWrite(
      uri,
      format,
      format === "dxf" ? "DXF Drawing" : "SVG Drawing",
      async () => {
        const scadWarnings: string[] = [];
        const src = await this.readOcctSource(uri, route.format, scadWarnings);
        for (const w of scadWarnings) post({ type: "status", text: w });
        const bytes = src.bytes;
        const source: CompareSource =
          route.strategy === "occt"
            ? { kind: "brep", bytes, format: src.format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">, ops: replayTail(ops, bakedThrough) }
            : route.format === "gltf"
              ? { kind: "gltf", bytes, externalBuffers: await resolveGltfBuffersFor(uri, route.format, bytes) }
              : { kind: route.format as "stl" | "obj" | "ply", bytes };
        const result = await this.docPipeline(uri).exportDrawingSheet(this.context.extensionPath, source, {
          views: settings.views,
          format,
          paper: settings.paper,
          projection: settings.projection,
          scale: settings.scale,
          annotations,
          title: settings.title,
          fields: settings.fields,
          date: new Date().toISOString().slice(0, 10),
        });
        for (const warning of result.warnings) post({ type: "status", text: warning });
        post({ type: "status", text: `Drawing sheet: ${result.views.length} views at ${result.scaleLabel}` });
        return Buffer.from(result.content, "utf8");
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
    post: (msg: HostToWebview) => void,
    /** Tier 0: leading baked-op count — the meshing STEP re-export replays the tail. */
    bakedThrough = 0,
    /** Also write `<output>.handoff.json` beside the saved mesh (roadmap "Simulation handoff manifest and boundary coverage"). */
    manifest = false,
    requestId: string = randomUUID()
  ): Promise<void> {
    await this.runMeshingJob(uri, requestId, post, async () => {
      // Every file this export writes (primary first), for the manifest.
      const writtenFiles: Array<{ uri: vscode.Uri; bytes: Uint8Array }> = [];
      const captured =
        (fn: (saveUri: vscode.Uri) => Promise<Uint8Array>) =>
        async (saveUri: vscode.Uri): Promise<Uint8Array> => {
          const bytes = await fn(saveUri);
          writtenFiles.unshift({ uri: saveUri, bytes });
          return bytes;
        };
      const writeCompanion = async (companionUri: vscode.Uri, bytes: Uint8Array) => {
        this.assertMeshingJobActive();
        await vscode.workspace.fs.writeFile(companionUri, bytes);
        writtenFiles.push({ uri: companionUri, bytes });
      };
      try {
        const input = await this.resolveMeshInput(uri, route, ops, stl, unit, bakedThrough);
        if (!input) {
          throw new Error("No mesh geometry available: missing STL data.");
        }
        const { parts, options } = await this.resolveMeshPartsAndOptions(uri, input, meshOptions, unit);
        if (target === "msh") {
          const result = await this.docPipeline(uri).generateMesh(this.context.extensionPath, input, options, parts);
          await this.promptSaveAndWrite(
            uri,
            "msh",
            "GMSH Mesh",
            captured(async () => Buffer.from(result.mshText, "utf8")),
            post
          );
        } else if (target === "geoUnrolled") {
          const geo = await this.docPipeline(uri).exportGeoUnrolled(this.context.extensionPath, input, options, parts);
          await this.promptSaveAndWrite(
            uri,
            "geo_unrolled",
            "GMSH Unrolled Geometry",
            captured(async (saveUri) => {
              if (!geo.xao) return Buffer.from(geo.text, "utf8");
              // B-rep geometry can't be textually unrolled — gmsh.write() emitted a
              // `Merge "<memfs path>.xao";` stub. Write the real content (the XAO
              // companion) as a sibling of the saved file and fix the reference up
              // to a relative name so it actually resolves when reopened.
              const saveName = saveUri.path.slice(saveUri.path.lastIndexOf("/") + 1);
              const xaoName = `${saveName}.xao`;
              const xaoUri = vscode.Uri.joinPath(saveUri, "..", xaoName);
              await writeCompanion(xaoUri, geo.xao);
              const fixedText = geo.text.replace(/Merge "[^"]*\.xao";/, `Merge "${xaoName}";`);
              return Buffer.from(fixedText, "utf8");
            }),
            post
          );
        } else if (target === "mdpaElements" || target === "mdpaGeometries") {
          // Kratos MDPA is hand-serialized (no gmsh.write() support at all — see
          // exportMdpa's doc comment), unlike every other format below.
          const format = meshExportFormat(target)!;
          const text = await this.docPipeline(uri).exportMdpa(
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
            captured(async () => Buffer.from(text, "utf8")),
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
          const meshed = await this.docPipeline(uri).generateMesh(this.context.extensionPath, input, options, parts);
          const sourceName = uri.path.slice(uri.path.lastIndexOf("/") + 1);
          const { bytes, companion } = await this.docPipeline(uri).exportViaMeshio(meshed.mshText, target, {
            extension: format.extension,
            companionExtension: format.companion?.extension,
            // Omitted rather than fabricated if the document somehow has no
            // route — an unknown origin is better left unrecorded than
            // recorded as a guess.
            source: route ? { name: sourceName, format: route.format } : undefined,
            notes: buildMeshProvenanceNotes({
              engineUsed: meshed.engineUsed,
              dimension: options.dimension,
              sizeMin: options.sizeMin,
              sizeMax: options.sizeMax,
              elementShape: options.elementShape,
              elementOrder: options.elementOrder,
              unit,
              inputKind: input.kind,
              editOpCount: ops.length,
            }),
          });
          await this.promptSaveAndWrite(
            uri,
            format.extension,
            format.filterLabel,
            captured(async (saveUri) => {
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
              await writeCompanion(companionUri, companion.bytes);
              if (format.companion?.linkage === "sibling") return Buffer.from(bytes);
              const fixedText = Buffer.from(bytes).toString("utf8").split(companion.name).join(companionName);
              return Buffer.from(fixedText, "utf8");
            }),
            post
          );
        } else {
          // Every other registered format (VTK/UNV/Abaqus/Nastran/SU2/etc.) — a
          // plain generate-then-write with no companion file, see `exportMeshFormat`.
          const format = meshExportFormat(target);
          if (!format) throw new Error(`Unknown mesh export format: ${target}`);
          const text = await this.docPipeline(uri).exportMeshFormat(this.context.extensionPath, input, options, parts, target);
          await this.promptSaveAndWrite(
            uri,
            format.extension,
            format.filterLabel,
            captured(async () => Buffer.from(text, "utf8")),
            post
          );
        }
        if (manifest && writtenFiles.length > 0 && route) {
          this.assertMeshingJobActive();
          const onDisk = await readEdits(uri);
          const handoff = await buildExportHandoffManifest(
            { pipeline: this.docPipeline(uri), extensionPath: this.context.extensionPath },
            uri.fsPath,
            route,
            input,
            options,
            parts,
            target,
            writtenFiles.map((f) => ({ path: f.uri.fsPath, bytes: f.bytes })),
            unit,
            ops.length !== onDisk.ops.length
              ? ["The edits sidecar on disk differed from the open document at export time (an autosave was pending) — the recorded edit fingerprint is the on-disk one."]
              : []
          );
          const manifestUri = vscode.Uri.file(`${writtenFiles[0].uri.fsPath}${HANDOFF_MANIFEST_SUFFIX}`);
          await vscode.workspace.fs.writeFile(manifestUri, Buffer.from(serializeHandoffManifest(handoff), "utf8"));
          const cov = handoff.coverage;
          post({
            type: "status",
            text: `Handoff manifest written — ${handoff.parts.length} Part(s)${cov.unresolvedParts.length ? `, unresolved: ${cov.unresolvedParts.join(", ")}` : ""}${cov.emptyParts.length ? `, empty: ${cov.emptyParts.join(", ")}` : ""}, ${cov.unassignedSurfaceCount} surface(s) in no group.`,
          });
        }
      } catch (err) {
        post({ type: "error", message: this.meshingJobScope.getStore()?.controller.signal.aborted ? "Meshing export cancelled." : `Export failed: ${(err as Error).message}` });
      }
    });
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
   * **Mesh-format sources too** (roadmap Tier 1 "Parity gaps"): STL/OBJ/PLY/
   * glTF and the meshio++ formats resolve host-side through the same
   * `meshSourceInput.ts` resolver `export_mesh` uses, instead of needing the
   * webview's serialized STL. Pending mesh edits are NOT baked in (they replay
   * only in the webview) — said as a status line, never silently. The panel's
   * own Export button still sends the displayed (edited) geometry.
   */
  private async handleExportMesh(
    uri: vscode.Uri,
    route: FileRoute | undefined,
    ops: EditOp[],
    meshOptions: MeshOptions | undefined,
    post: (msg: HostToWebview) => void,
    /** Tier 0: leading baked-op count — the meshing STEP re-export replays the tail. */
    bakedThrough = 0
  ): Promise<void> {
    if (!route) return;
    // A mesh-format source has no OCCT shape to re-export: resolve its STL
    // host-side (native mm — runMeshExport applies the unit), before any
    // quick-pick, so an unreadable file fails before asking anything.
    let stl: string | undefined;
    if (route.strategy !== "occt") {
      if (!isMeshSourceRoute(route)) {
        post({ type: "status", text: `FE mesh export is not available for ${route.format} sources.` });
        return;
      }
      const warnings: string[] = [];
      try {
        const pipeline = this.docPipeline(uri);
        const basename = uri.path.slice(uri.path.lastIndexOf("/") + 1);
        const input = await resolveMeshSourceInput(
          route,
          uri.fsPath,
          Math.max(0, ops.length - bakedThrough),
          {
            readBytes: async () => vscode.workspace.fs.readFile(uri),
            resolveGltfBuffers: (bytes) => resolveGltfBuffersFor(uri, route.format, bytes),
            resolveMeshioCompanions: (bytes) => resolveMeshioCompanionsFor(uri, basename, route.format, bytes),
            convertToStlBoundary: (bytes, format, name, companions) => pipeline.convertToStlBoundary(bytes, format, name, companions),
            convertFoamCaseToStlBoundary: (markerPath) => pipeline.convertFoamCaseToStlBoundary(markerPath),
          },
          warnings
        );
        if (input.kind !== "stl") return;
        stl = Buffer.from(input.stlBytes).toString("base64");
      } catch (err) {
        post({ type: "error", message: `Export failed: ${(err as Error).message}` });
        return;
      }
      for (const w of warnings) post({ type: "status", text: w });
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
    await this.runMeshExport(uri, route, ops, picked.id as MeshExportFormatId, options, stl, unit, post, bakedThrough);
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
      this.assertMeshingJobActive();
      const bytes = await getBytes(saveUri);
      this.assertMeshingJobActive();
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
        await writeEdits(destUri, parsed.ops, parsed.variables, parsed.bakedThrough);
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
/** `cadPreview.kernelTimeoutMinutes` as milliseconds (clamped; the kernel
 * client's own default when unset or invalid). */
function kernelTimeoutMs(): number {
  const minutes = vscode.workspace.getConfiguration("cadPreview").get<number>("kernelTimeoutMinutes");
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.round(Math.min(120, Math.max(0.1, minutes)) * 60_000);
}

function macroLibraryPath(modelUri: vscode.Uri): string {
  return path.join(path.dirname(modelUri.fsPath), "cad-preview-macros.json");
}

/**
 * The folder-level user meshing-preset library (roadmap Tier 1 "Reusable
 * meshing presets") — beside the model as `cad-preview-mesh-presets.json`,
 * shared by every model in that folder.
 *
 * A folder-level path rather than a per-model one because a preset is
 * reusable BY DEFINITION — tying it to one document would defeat the point —
 * and an explicit filename rather than a hidden convention so it can be
 * checked into a project alongside its models, and named directly to the MCP
 * preset tools' `libraryPath` (the `macroLibraryPath` precedent verbatim).
 */
/** The folder-level sheet-template library beside the model (shared by every model in the folder). */
function sheetTemplateLibraryPath(modelUri: vscode.Uri): string {
  return path.join(path.dirname(modelUri.fsPath), USER_SHEET_TEMPLATES_FILE);
}

function meshPresetLibraryPath(modelUri: vscode.Uri): string {
  return path.join(path.dirname(modelUri.fsPath), "cad-preview-mesh-presets.json");
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
