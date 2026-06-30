import type { CadFormat } from "./fileRouter";

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

/** The kind of geometric entity a part assignment refers to. */
export type EntityType = "volume" | "surface" | "line";

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
}

/** Messages sent from the extension host to the webview. */
export type HostToWebview =
  | { type: "geometry"; meshes: EncodedMesh[]; edges: EncodedEdge[] }
  | { type: "tree"; root: TreeNode }
  | { type: "loadUrl"; url: string; format: CadFormat }
  | { type: "parts"; parts: Part[] }
  | { type: "status"; text: string }
  | { type: "error"; message: string }
  | { type: "exportMesh"; requestId: string; format: CadFormat };

/** Messages sent from the webview to the extension host. */
export type WebviewToHost =
  | { type: "ready" }
  | { type: "log"; message: string }
  | { type: "partsChanged"; parts: Part[] }
  | { type: "exportRequest" }
  | { type: "exportResult"; requestId: string; data: string; binary: boolean }
  | { type: "exportError"; requestId: string; message: string };

/** Encode a typed array to a base64 string for postMessage transport. */
export function encodeBuffer(arr: Float32Array | Uint32Array): string {
  return Buffer.from(arr.buffer).toString("base64");
}
