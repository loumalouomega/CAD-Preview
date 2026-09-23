/**
 * The one SHA-256 helper host modules share (preprocess archive checksums,
 * sidecar revisions, handoff manifests). Node's built-in `crypto` — never
 * imported by the webview bundle.
 */
import { createHash } from "crypto";

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
