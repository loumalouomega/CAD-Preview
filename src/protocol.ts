import type { CadFormat } from "./fileRouter";
import type { EditOp } from "./editOps";
import type { ParamVariable } from "./editVariables";
import type { MeshOptions } from "./meshOptions";
import type { MeshExportFormatId } from "./meshExportFormats";
import type { ViewerDefaults } from "./viewerDefaults";
import type { MassProperties } from "./massProperties";
import type { QualitySummary } from "./meshQuality";
import type { DisplayUnit } from "./lengthUnits";
import type { ExactMeasureKind, ExactMeasureResult } from "./entityFacts";

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

/** Messages sent from the extension host to the webview. */
export type HostToWebview =
  | { type: "geometry"; meshes: EncodedMesh[]; edges: EncodedEdge[]; points: EncodedPoint[] }
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
  | { type: "massPropertiesResult"; requestId: string; properties: MassProperties }
  | { type: "massPropertiesError"; requestId: string; message: string }
  | { type: "measureExactResult"; requestId: string; result: ExactMeasureResult }
  | { type: "measureExactError"; requestId: string; message: string }
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
    };

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
  | { type: "editsChanged"; ops: EditOp[]; variables: ParamVariable[] }
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
  | { type: "screenshotResult"; requestId: string; data: string }
  | { type: "screenshotError"; requestId: string; message: string }
  | { type: "massPropertiesRequest"; requestId: string; entityId: string | null }
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
  | { type: "colorFieldRequest"; requestId: string; field: string; kind: "point" | "cell" };

/** Encode a typed array to a base64 string for postMessage transport. */
export function encodeBuffer(arr: Float32Array | Uint32Array | Int32Array): string {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString("base64");
}
