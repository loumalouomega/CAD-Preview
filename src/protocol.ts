import type { CadFormat } from "./fileRouter";
import type { EditOp } from "./editOps";
import type { ParamVariable } from "./editVariables";
import type { MeshOptions } from "./meshOptions";
import type { MeshExportFormatId } from "./meshExportFormats";
import type { ViewerDefaults } from "./viewerDefaults";
import type { MassProperties } from "./massProperties";
import type { QualitySummary } from "./meshQuality";
import type { DisplayUnit } from "./lengthUnits";
import type { EntityFacts, ExactMeasureKind, ExactMeasureResult } from "./entityFacts";
import type { DisplayMode } from "./webview/displayMode";
import type { ClipPlaneState } from "./webview/clipping";
import type { PaneLayoutId } from "./webview/viewerPanes";
import type { StandardPart } from "./stepPartsService";
import type { MeshHealthReport } from "./meshHeal";
import type { MeshRegionFit } from "./meshRegionFit";
import type { AnnotatedTolerance } from "./toleranceBand";

export type { EditOp } from "./editOps";
export type { ParamVariable } from "./editVariables";

/** A node in the model component tree sent from host → webview. */
export interface TreeNode {
  id: string;
  label: string;
  faceCount?: number;
  children?: TreeNode[];
}

/** One face's geometry encoded as base64 strings for JSON-safe transfer. */
export interface EncodedMesh {
  positions: string; // base64 Float32Array
  indices: string;   // base64 Uint32Array
  groupId: string;   // parent solid id this face belongs to
  faceId: string;    // stable per-face entity id (e.g. "face-3")
}

/** One edge's polyline encoded as base64 for JSON-safe transfer. */
export interface EncodedEdge {
  positions: string; // base64 Float32Array — consecutive points form a polyline
  edgeId: string;    // stable per-edge entity id (e.g. "edge-12")
  /** `true` for a tangent patch-seam continuation rather than a real feature
   * edge (roadmap "Display-edge classification, as a flag", closed) — the
   * webview decides what to do with this (e.g. a "Hide smooth edges" toggle),
   * never the host: dropping an edge server-side would renumber `edge-N`. */
  smooth: boolean;
}

/** One vertex's position encoded as base64 for JSON-safe transfer. */
export interface EncodedPoint {
  position: string; // base64 Float32Array, length 3 (x, y, z) — same encoding convention as meshes/edges
  pointId: string;  // stable per-point entity id (e.g. "point-4")
}

/** The kind of geometric entity a part assignment refers to. */
export type EntityType = "volume" | "surface" | "line" | "point";

/**
 * A user-defined named part (FEM sub-model-part / group). Holds the ids of the
 * entities assigned to it, split by kind. Persisted in the JSON sidecar.
 */
export interface Part {
  name: string;
  color: string;       // CSS hex, e.g. "#ff8800"
  volumes: string[];   // solid ids
  surfaces: string[];  // face ids
  lines: string[];     // edge ids
  points: string[];    // point (vertex) ids
  meshSize?: number;   // optional Gmsh target element size for local refinement
}

/** Which measurement is being taken — shared between the webview's
 * `MeasurementState` and a persisted `Annotation`'s `tool` field, so the two
 * can never drift apart. */
export type MeasureTool = "distance" | "edgeLength" | "angle" | "radius";

/**
 * A persisted, topology-anchored measurement (roadmap "Persisted,
 * topology-anchored annotations", closed) — a "pinned" measurement result
 * that survives closing the file, unlike the session-only Measure tool
 * overlay it's created from. Structurally shaped as an `EntityIdBag`
 * (`volumes`/`surfaces`/`lines`/`points`, same as `Part`) purely so
 * `src/entityRebind.ts`'s `remapPartEntityIds` — already generic over that
 * shape — can rebind an annotation's anchor(s) across topology-changing edits
 * with ZERO new matching code; almost every annotation populates only one of
 * the four arrays with one id (occasionally two ids for "distance"/"angle",
 * which pick two entities), never all four.
 *
 * `text`/`anchorPoint`/`linePoints` are a FROZEN snapshot of the measurement
 * result at pin time, not live-recomputed on every redisplay — the same
 * "freeze rather than silently drift" tradeoff `paramExpr.ts`'s variable
 * evaluator and `explodePreview.ts`'s cached base already make elsewhere in
 * this codebase. What DOES stay live is whether the annotation is
 * "detached": `src/webview/annotationsModel.ts`'s consumer checks whether
 * `volumes`/`surfaces`/`lines`/`points` still resolve to real entities in the
 * currently-loaded model — an id that a topology-changing edit's rebinding
 * pass couldn't confidently match is dropped from these arrays (the same
 * graceful-degradation contract `Part`'s ids already have), so "detached"
 * falls out for free as "none of this annotation's anchor ids resolve"
 * rather than needing a separate boolean flag to keep in sync.
 */
/** One saved macro, as the Macros panel displays it. A macro's own `variables`
 * block IS its parameter list — there is no separate parameter schema. */
export interface MacroSummary {
  name: string;
  description: string | null;
  parameters: { name: string; expr: string }[];
}

export interface Annotation {
  id: string; // stable id, client-generated at pin time (e.g. "ann-<ts>-<rand>")
  tool: MeasureTool;
  label?: string; // optional user note
  text: string; // frozen readout, e.g. "12.5 mm" or "42.1°"
  anchorPoint: [number, number, number]; // frozen world-space label position
  linePoints: [number, number, number][]; // frozen world-space overlay line points (0 or 2)
  volumes: string[]; // anchored solid ids
  surfaces: string[]; // anchored face ids
  lines: string[]; // anchored edge ids
  points: string[]; // anchored point (vertex) ids
  /**
   * Optional tolerance band (roadmap "Tolerance-band fact checks"), recorded
   * at pin time from the Measure panel's inline fields. `measured` is the raw
   * numeric measurement frozen alongside the band, so the in/out-of-band
   * colour can be re-derived on redisplay without parsing the formatted
   * `text` back into a number. Facts only — the within/outside judgment is
   * rendered by the viewer, never stored.
   */
  tolerance?: AnnotatedTolerance;
}

/**
 * A named construction plane, persisted to `<model>.planes.json`.
 *
 * **Stores resolved vectors, never a live face reference.** The roadmap's own
 * recommendation, and the same convention `align`'s `to` coordinate set: a
 * plane derived from `face-12` keeps that face's plane, not a pointer to it.
 * This is what keeps planes entirely out of `entityRebind.ts` — unlike
 * `face-N`, a plane is never renumbered by replay, and a live reference would
 * need rebinding on every topology-changing op for a feature whose whole value
 * is that it stays put.
 *
 * `derivedFrom` is display-only provenance ("face-12", "3 points"). It is
 * deliberately never resolved back to geometry.
 */
export interface ConstructionPlane {
  id: string; // "plane-N"
  name: string; // user-editable
  point: [number, number, number]; // a point ON the plane
  normal: [number, number, number]; // unit
  derivedFrom?: string;
}

/**
 * Per-pane camera state — the subset of {@link ViewState} that varies per pane
 * in a split-view layout (roadmap "Split view", Phase 2). Direction + up are
 * the same normalized vectors `ViewState` already persists; orthographic is
 * per-pane like direction. Display mode and clip plane stay global (one value
 * for the whole document, stored in `ViewState` itself), matching Phase 1's
 * scoping that only camera state is per-pane.
 */
export interface PaneViewState {
  viewDirection: [number, number, number];
  cameraUp: [number, number, number];
  orthographic: boolean;
}

/**
 * Persisted view state (roadmap "View-state persistence", closed) — camera
 * orientation, display mode, ortho/perspective, and clip plane, so reopening
 * a document restores the last view instead of always resetting to the
 * hardcoded isometric. Deliberately does NOT include explode preview state
 * (session/interaction-only by design — see `src/webview/explodePreview.ts`)
 * nor raw camera position/target/distance: `Viewer.frame(direction)` already
 * auto-derives both from the model's current bounding box, so persisting just
 * a normalized direction + up vector is sufficient and survives edits that
 * change the model's extents.
 *
 * Phase 2 (roadmap "Split view", Phase 2) adds optional split-view layout +
 * per-pane camera states. `layout` defaults to `"1x1"` when absent (an older
 * sidecar or a session that never entered split view); `panes` holds one
 * {@link PaneViewState} per pane of that layout, row-major, and is only
 * meaningful when `layout !== "1x1"`. A sidecar without these fields restores
 * as before — `view` alone is the focused/single-pane state in both
 * directions, so version-compatibility needs no bump.
 */
export interface ViewState {
  /** Camera direction (target → camera), as consumed by `Viewer.frame`/`setViewDirection`. */
  viewDirection: [number, number, number];
  cameraUp: [number, number, number];
  orthographic: boolean;
  displayMode: DisplayMode;
  /** `null` when clipping is off. See {@link ClipPlaneState} for why an
   * arbitrary `normal` is stored BESIDE the axis preset rather than instead
   * of it. */
  clip: ClipPlaneState | null;
  /** Split-view layout — absent/`"1x1"` means single pane. See {@link PaneViewState}. */
  layout?: PaneLayoutId;
  /** Per-pane camera states, one per pane of {@link ViewState.layout}, row-major. */
  panes?: PaneViewState[];
}

/** Messages sent from the extension host to the webview. */
export type HostToWebview =
  | {
      type: "geometry";
      meshes: EncodedMesh[];
      edges: EncodedEdge[];
      points: EncodedPoint[];
      /** Per-op replay outcomes (see `editOps.ts`'s `OpOutcome`) for the
       * B-rep path — lets the Edits history mark an op that gracefully
       * skipped instead of silently showing an unchanged model.
       * Absent for mesh sources (their replay is client-side, in
       * `rebuildMeshModel`, which reports outcomes directly). */
      opOutcomes?: import("./editOps").OpOutcome[];
      /**
       * When `false`, the viewer must always re-frame the new model, even if
       * its bounds would otherwise be considered contained by the last framing
       * (roadmap "Render on demand"). A genuine file load / file swap must
       * always show the new file framed, even when it happens to be smaller
       * than the document it replaced — without this hint a contained swap
       * would silently keep the old framing and look mis-framed. Absent/`true`
       * (the edit-driven rebuild path) is containment-eligible.
       */
      autoFit?: boolean;
    }
  | {
      type: "tree";
      root: TreeNode;
      /** The source file's declared length unit (e.g. `"INCH"`, `"MILLIMETRE"`),
       * detected by a plain-text scan: `src/stepUnits.ts` for STEP's
       * `DATA` section, `src/igesUnits.ts` for IGES's fixed-position Global-
       * section unit flag (both return the same canonical name vocabulary) —
       * `undefined` for BREP (no unit metadata at all) or a source file with
       * no unit declaration/an unrecognized one. Informational only: OCCT's
       * STEP/IGES readers already auto-convert every shape to one internal
       * cascade unit (millimetres) regardless of this value, so geometry is
       * always already consistent — this only tells the webview what to
       * default its display-unit selector to. See `src/webview/units.ts`. */
      sourceUnit?: string;
    }
  | { type: "loadUrl"; url: string; format: CadFormat }
  | {
      type: "loadMeshBytes";
      /** The document's actual source format (e.g. `"vtk"`, `"med"`) — for the
       * Components tree root label only. The bytes themselves are always an
       * STL boundary surface (`src/meshioService.ts`'s `convertToStlBoundary`)
       * fed through the same STL loader a native `.stl` open uses. */
      sourceFormat: CadFormat;
      dataBase64: string; // base64 STL bytes
      /** Read-only visibility into named regions / point / cell / field data
       * arrays the source file declares (`src/meshioService.ts`'s
       * `readMeshioMetadata` — a cheap `readMetadata()` call, best-effort,
       * empty on any failure) — informational only, NOT auto-converted into
       * Parts or any other geometry; see CLAUDE.md's "meshio++ integration"
       * section for why. Omitted (not just empty) when nothing was found, so
       * a status line only ever appears when there is something to say. */
      meshioMetadata?: {
        regions: Array<{ name: string; kind: string; numEntries: number }>;
        pointDataNames: string[];
        cellDataNames: string[];
        fieldDataNames: string[];
        /**
         * Per-array facts (meshio++ `dataInfo`) for the point/cell arrays
         * above, when the host could read them. Additive and optional: an
         * older payload without it still renders, the picker just falls back
         * to offering every name and discovering a non-scalar after the click.
         *
         * Present only when the source actually declares data arrays — it
         * costs a full `readMesh`, which a document with no fields should not
         * pay on open.
         */
        arrays?: Array<{
          name: string;
          location: "point" | "cell";
          numComponents: number;
          min: number;
          max: number;
          numNan: number;
          consistent: boolean;
        }>;
      };
      /** Per-boundary-triangle region correlation (`src/meshioService.ts`'s
       * `convertToStlBoundaryWithRegions`) — present whenever the source's
       * `kind: "cell"` regions could be safely correlated to the STL
       * boundary triangles above (currently: pure-triangle boundaries only,
       * see that function's doc comment). Sent on EVERY open where
       * correlation succeeds, not just the first import that auto-creates
       * Parts from it (see `provider.ts`'s `handleMeshio`) — the webview
       * needs it every time to reproduce the identical region-aware facet
       * split those Parts' `node-0/face-K` ids were computed against, or the
       * ids would stop resolving to anything on reopen. `regionNames[i]` is
       * a name; `triangleRegionIndex` (base64 `Int32Array`, one entry per
       * STL triangle in `dataBase64`, same order) is an index into
       * `regionNames`, or `-1` if that triangle wasn't covered by any
       * region. */
      regionAssignment?: {
        regionNames: string[];
        triangleRegionIndex: string; // base64 Int32Array
      };
    }
  | { type: "parts"; parts: Part[] }
  | { type: "annotations"; annotations: Annotation[] }
  /** Full replacement of the document's construction planes — sent on the
   * `ready` handshake and whenever `<model>.planes.json` changes externally.
   * Applied silently by `PlanesModel.load()` (no `onChange` echo), the same
   * contract `"parts"`/`"annotations"` rely on to avoid a write loop. */
  | { type: "planes"; planes: ConstructionPlane[] }
  | { type: "edits"; ops: EditOp[]; variables: ParamVariable[] }
  | { type: "status"; text: string }
  | { type: "error"; message: string }
  | { type: "editError"; message: string }
  | {
      type: "exportMesh";
      requestId: string;
      format: CadFormat;
      /** Real geometric unit conversion (not the display-unit selector) —
       * `undefined`/`"mm"` means no scaling, matching the model's native
       * cascade unit. See `src/webview/meshExporters.ts`'s `exportModel`. */
      unit?: DisplayUnit;
    }
  | { type: "meshingOptions"; options: MeshOptions }
  | { type: "viewState"; view: ViewState | null }
  | {
      type: "meshingResult";
      positions: string;
      indices: string;
      /** True element-edge line segments (base64 `Uint32Array` index pairs) for
       * the wireframe — quad perimeters for hexes, triangle edges for tets. */
      edges: string;
      nodeCount: number;
      elementCount: number;
      elementGroups: MeshElementGroup[];
      /** Wall-clock duration of the generate call, for the panel's status line. */
      elapsedMs: number;
      /** Per-element quality summary (min/mean/histogram) — `undefined` if it
       * couldn't be computed (e.g. a 1D mesh); see
       * `computeQualityAndWorstElements` in `src/gmshService.ts` for the
       * verified `getElementQualities` call shape. */
      quality?: QualitySummary;
      /** A highlight overlay of the worst-quality elements' own boundary —
       * `undefined` for a non-3D generate, or when nothing scored below the
       * quality threshold. See `WorstElementsOverlay` in `src/gmshService.ts`. */
      worstElements?: {
        indices: string; // base64 Uint32Array — triangle indices into `positions` above
        threshold: number;
        shownCount: number;
        belowThresholdCount: number;
      };
    }
  | { type: "meshingError"; message: string }
  | ({ type: "viewerDefaults" } & ViewerDefaults)
  | { type: "screenshotRequest"; requestId: string }
  | {
      type: "standardPartsSearchResult";
      requestId: string;
      items: StandardPart[];
      page: number;
      totalPages: number;
      total: number;
    }
  | { type: "standardPartsSearchError"; requestId: string; message: string }
  /** `path: null` means the user dismissed the save dialog — a quiet no-op,
   * not an error (never posted through `standardPartsInsertError`). */
  | { type: "standardPartsInsertResult"; requestId: string; path: string | null }
  | { type: "standardPartsInsertError"; requestId: string; message: string }
  /** No `requestId` — unlike the request/response pairs above, only one SVG
   * import can plausibly be in flight at a time (a modal file-open dialog
   * blocks further requests), so there's nothing to disambiguate. */
  | { type: "importSvgResult"; text: string }
  | { type: "importSvgError"; message: string }
  | { type: "importDxfResult"; text: string }
  | { type: "importDxfError"; message: string }
  | { type: "massPropertiesResult"; requestId: string; properties: MassProperties }
  | { type: "massPropertiesError"; requestId: string; message: string }
  /** Analytic classification of one entity, for the inspector card. Carries
   * `EntityFacts` verbatim from the existing `getEntityFacts` pipeline
   * function — the card is a new protocol pair over existing kernel surface,
   * not new geometry work. B-rep sources only (a mesh has no analytic
   * surface type), so the host answers with `entityFactsError` otherwise. */
  /** The saved-macro library for this document's folder. Sent unprompted on
   *  `ready` and after every macro save/delete, so the panel never has to ask. */
  | { type: "macros"; macros: MacroSummary[] }
  /** Compiled macro ops, to be pushed onto the webview's own op stack — so a
   *  macro is undoable and removable op-by-op like any hand-applied edit,
   *  with no special "macro" state for undo/redo to reason about. */
  | { type: "macroApplyOps"; ops: EditOp[] }
  | { type: "entityFactsResult"; requestId: string; facts: EntityFacts }
  | { type: "entityFactsError"; requestId: string; message: string }
  | { type: "measureExactResult"; requestId: string; result: ExactMeasureResult }
  | { type: "measureExactError"; requestId: string; message: string }
  | { type: "meshHealResult"; requestId: string; report: MeshHealthReport }
  | { type: "meshHealError"; requestId: string; message: string }
  | { type: "fitRegionResult"; requestId: string; fit: MeshRegionFit }
  | { type: "fitRegionError"; requestId: string; message: string }
  /** Live operation preview result — the same encoded payload `"geometry"`
   * carries, but for the speculative ops+draft replay. The webview builds a
   * detached group from it (never `viewer.setModel`) and tints it by intent;
   * `opOutcomes` lets the overlay degrade to nothing when the draft op
   * gracefully skipped, with the reason available for the status line. */
  | {
      type: "opPreviewResult";
      requestId: string;
      meshes: EncodedMesh[];
      edges: EncodedEdge[];
      points: EncodedPoint[];
      opOutcomes?: import("./editOps").OpOutcome[];
    }
  | { type: "opPreviewError"; requestId: string; message: string }
  | {
      type: "colorFieldResult";
      requestId: string;
      /** One value per triangle CORNER (base64 `Float32Array`), same order
       * as the currently-loaded model's own triangle soup (see
       * `src/meshioService.ts`'s `readMeshioFieldValues`). */
      values: string;
      min: number;
      max: number;
    }
  | { type: "colorFieldError"; requestId: string; message: string }
  | {
      type: "renderViewRequest";
      /** Deliberately separate from `screenshotRequest`'s requestId
        * namespace/round trip (`src/renderService.ts`'s headless multi-view
        * capture, not the interactive single-view Screenshot feature) —
        * carries camera/visibility/display-mode fields that feature has no
        * reason to. */
      requestId: string;
      /** Camera direction (target → camera), as consumed by
        * `Viewer.setViewDirection`. */
      direction: [number, number, number];
      /** Explicit camera up vector — required in practice for a near-vertical
        * `direction` (e.g. a top view) to avoid a gimbal-lock-like flip;
        * optional otherwise (defaults to `[0,1,0]`). */
      up?: [number, number, number];
      /** Burned into the returned PNG (top-left corner). */
      label: string;
      /** Entity ids to isolate to (only these are shown); omitted/empty means
        * no isolation. */
      focus?: Array<{ entityType: EntityType; entityId: string }>;
      /** Entity ids to force-hide. */
      hide?: Array<{ entityType: EntityType; entityId: string }>;
      wireframe?: boolean;
      /** World-space box to frame INSTEAD of the whole model
       *  (`screenshot_shape`). Framing only — must never drive the
       *  model-scoped pick threshold / helper scales. */
      frameBox?: { min: [number, number, number]; max: [number, number, number] };
    }
  | { type: "linkedCamera"; camera: LinkedCameraState }
  | { type: "camerasLinked"; enabled: boolean };

/**
 * Minimal camera triple shared across tabs via the host relay (roadmap "Split
 * view", Phase 3). Deliberately only direction/up/orthographic — layout,
 * display mode and clip stay independent per document. Receiver reframes from
 * its own bbox via `frameFromDirection`/`setCameraUp`/`setOrthographic`.
 */
export interface LinkedCameraState {
  viewDirection: [number, number, number];
  cameraUp: [number, number, number];
  orthographic: boolean;
}

/** One contiguous run of triangles in `meshingResult.indices` belonging to a
 * single part (or, for `name === null`, the trailing ungrouped/default run). */
export interface MeshElementGroup {
  name: string | null;
  color: string | null;
  indexStart: number;
  indexCount: number;
}

/** Messages sent from the webview to the extension host. */
export type WebviewToHost =
  | { type: "ready" }
  | { type: "log"; message: string }
  | { type: "partsChanged"; parts: Part[] }
  | { type: "annotationsChanged"; annotations: Annotation[] }
  | { type: "planesChanged"; planes: ConstructionPlane[] }
  | { type: "editsChanged"; ops: EditOp[]; variables: ParamVariable[] }
  | { type: "viewChanged"; view: ViewState }
  | { type: "openFile" }
  | { type: "openPath"; path: string }
  | { type: "saveSidecars" }
  | { type: "exportRequest" }
  | { type: "savePreprocessRequest" }
  | { type: "loadPreprocessRequest" }
  | { type: "exportResult"; requestId: string; data: string; binary: boolean }
  | { type: "exportError"; requestId: string; message: string }
  | { type: "meshingChanged"; options: MeshOptions }
  | { type: "meshingGenerate"; options: MeshOptions; stl?: string }
  | { type: "meshingExport"; target: MeshExportFormatId; options: MeshOptions; stl?: string; unit?: DisplayUnit }
  | { type: "screenshotButtonClicked" }
  | { type: "promoteToBrepButtonClicked" }
  | { type: "repairMeshButtonClicked" }
  | { type: "screenshotResult"; requestId: string; data: string }
  | { type: "screenshotError"; requestId: string; message: string }
  | { type: "massPropertiesRequest"; requestId: string; entityId: string | null }
  /** Inspector card: classify the entity the user just selected. */
  /** Run a saved macro, appending its compiled ops to the edit history. */
  | { type: "macroRun"; name: string; parameters: Record<string, string> }
  /** Save the current op stack as a macro; the host prompts for a name. */
  | { type: "macroSaveCurrent" }
  | { type: "macroDelete"; name: string }
  | { type: "entityFactsRequest"; requestId: string; entityId: string }
  | { type: "standardPartsSearchRequest"; requestId: string; q: string; page?: number }
  | { type: "standardPartsInsertRequest"; requestId: string; id: string; suggestedName: string }
  | { type: "importSvgRequest" }
  | { type: "importDxfRequest" }
  /** File ▸ Export Silhouette SVG/DXF… — like `exportRequest`, the host owns
   * the whole flow from here (view quick-pick → unit quick-pick → save dialog),
   * so there is nothing to correlate and no result message: success/failure come
   * back through the generic `status`/`error` messages. */
  | { type: "exportSvgRequest" }
  | { type: "exportDxfRequest" }
  /** File ▸ Export Technical Drawing… — the hidden-line counterpart of the two
   *  silhouette exports; the host owns the view/unit picks and the save dialog. */
  | { type: "exportDrawingRequest" }
  /** Live operation preview (roadmap item, closed): the webview's open Edits
   * form changed — replay the current ops PLUS this not-yet-committed draft
   * op and post the resulting geometry back for a tinted overlay. The webview
   * builds `op` through the exact same builder the Apply button uses, so
   * preview and commit can never disagree; the host treats it as purely
   * speculative (separate cache key, nothing persisted, no sidecar write).
   * Never posted for mesh sources — their preview is entirely client-side. */
  | {
      type: "opPreviewRequest";
      requestId: string;
      op: import("./editOps").EditOp;
    }
  | {
      type: "measureExactRequest";
      requestId: string;
      kind: ExactMeasureKind;
      entityIdA: string;
      /** Required for `kind: "distance"`, absent otherwise. */
      entityIdB?: string;
    }
  | { type: "renderViewResult"; requestId: string; data: string }
  | { type: "renderViewError"; requestId: string; message: string }
  | { type: "colorFieldRequest"; requestId: string; field: string; kind: "point" | "cell" }
  | { type: "meshHealRequest"; requestId: string }
  | { type: "fitRegionRequest"; requestId: string; point: [number, number, number] }
  | { type: "setCamerasLinked"; enabled: boolean };

/** Encode a typed array to a base64 string for postMessage transport. */
export function encodeBuffer(arr: Float32Array | Uint32Array | Int32Array): string {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString("base64");
}
