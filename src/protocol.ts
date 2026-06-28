import type { CadFormat } from "./fileRouter";

/** One mesh's geometry encoded as base64 strings for JSON-safe transfer. */
export interface EncodedMesh {
  positions: string; // base64 Float32Array
  indices: string;   // base64 Uint32Array
}

/** Messages sent from the extension host to the webview. */
export type HostToWebview =
  | { type: "geometry"; meshes: EncodedMesh[] }
  | { type: "loadUrl"; url: string; format: CadFormat }
  | { type: "status"; text: string }
  | { type: "error"; message: string };

/** Messages sent from the webview to the extension host. */
export type WebviewToHost =
  | { type: "ready" }
  | { type: "log"; message: string };

/** Encode a typed array to a base64 string for postMessage transport. */
export function encodeBuffer(arr: Float32Array | Uint32Array): string {
  return Buffer.from(arr.buffer).toString("base64");
}
