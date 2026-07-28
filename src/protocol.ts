import type { CadFormat } from "./fileRouter";
import type { EditOp } from "./editOps";
import type { ParamVariable } from "./editVariables";
import type { MeshOptions } from "./meshOptions";
import type { MeshExportFormatId } from "./meshExportFormats";
import type { ViewerDefaults } from "./viewerDefaults";
import type { MassProperties } from "./massProperties";
import type { QualitySummary } from "./meshQuality";

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
  | { type: "tree"; root: TreeNode }
  | { type: "loadUrl"; url: string; format: CadFormat }
  | { type: "parts"; parts: Part[] }
  | { type: "edits"; ops: EditOp[]; variables: ParamVariable[] }
  | { type: "status"; text: string }
  | { type: "error"; message: string }
  | { type: "editError"; message: string }
  | { type: "exportMesh"; requestId: string; format: CadFormat }
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
       * couldn't be computed (e.g. a 1D mesh); see `computeMeshQuality` in
       * `src/gmshService.ts` for the verified `getElementQualities` call shape. */
      quality?: QualitySummary;
    }
  | { type: "meshingError"; message: string }
  | ({ type: "viewerDefaults" } & ViewerDefaults)
  | { type: "screenshotRequest"; requestId: string }
  | { type: "massPropertiesResult"; requestId: string; properties: MassProperties }
  | { type: "massPropertiesError"; requestId: string; message: string };

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
  | { type: "meshingExport"; target: MeshExportFormatId; options: MeshOptions; stl?: string }
  | { type: "screenshotButtonClicked" }
  | { type: "screenshotResult"; requestId: string; data: string }
  | { type: "screenshotError"; requestId: string; message: string }
  | { type: "massPropertiesRequest"; requestId: string; entityId: string | null };

/** Encode a typed array to a base64 string for postMessage transport. */
export function encodeBuffer(arr: Float32Array | Uint32Array): string {
  return Buffer.from(arr.buffer).toString("base64");
}
