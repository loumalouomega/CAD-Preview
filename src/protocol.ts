import type { CadFormat } from "./fileRouter";

/** A node in the model component tree sent from host → webview. */
export interface TreeNode {
  id: string;
  label: string;
  faceCount?: number;
  children?: TreeNode[];
}

/** One solid/group's geometry encoded as base64 strings for JSON-safe transfer. */
export interface EncodedMesh {
  positions: string; // base64 Float32Array
  indices: string;   // base64 Uint32Array
  groupId: string;   // which tree node this face buffer belongs to
}

/** Messages sent from the extension host to the webview. */
export type HostToWebview =
  | { type: "geometry"; meshes: EncodedMesh[] }
  | { type: "tree"; root: TreeNode }
  | { type: "loadUrl"; url: string; format: CadFormat }
  | { type: "status"; text: string }
  | { type: "error"; message: string }
  | { type: "exportMesh"; requestId: string; format: CadFormat };

/** Messages sent from the webview to the extension host. */
export type WebviewToHost =
  | { type: "ready" }
  | { type: "log"; message: string }
  | { type: "exportRequest" }
  | { type: "exportResult"; requestId: string; data: string; binary: boolean }
  | { type: "exportError"; requestId: string; message: string };

/** Encode a typed array to a base64 string for postMessage transport. */
export function encodeBuffer(arr: Float32Array | Uint32Array): string {
  return Buffer.from(arr.buffer).toString("base64");
}
