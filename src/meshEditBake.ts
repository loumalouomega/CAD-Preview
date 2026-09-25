/**
 * Headless mesh-edit replay (roadmap "Headless mesh-edit replay").
 *
 * Mesh edits used to replay only in the webview, so every headless consumer
 * (`generate_mesh`, `export_mesh`, `compare_models`, `save_model`) saw the raw
 * file. This runs the SAME engine the webview runs — `applyEditsMesh` over the
 * SAME loader output (`meshObject.ts`), serialized by the SAME exporters
 * (`meshExporters.ts`) — inside the kernel worker, so an edit baked headlessly
 * is byte-for-byte the geometry the viewer displays.
 *
 * Runs in the kernel worker (a Node process with no DOM). The two browser
 * globals three's code touches are polyfilled lazily, never at import:
 * `requestAnimationFrame` here (PLYExporter chunks its work through it) and
 * `ProgressEvent` inside `parseGltfObject` (GLTFLoader constructs one).
 * The facet split (`splitMeshesIntoFacets`) is deliberately skipped — it only
 * changes display/entity grouping, not geometry, and the webview also exports
 * from the unsplit edited model.
 */

import type * as THREE from "three";
import type { EditOp, OpOutcome } from "./editOps";
import type { GltfExternalBuffers } from "./gltfParser";
import { applyEditsMesh } from "./webview/meshEdits";
import { parseMeshObject, parseGltfObject, tagMeshEntities } from "./webview/meshObject";
import { exportModel } from "./webview/meshExporters";

export type BakeSourceFormat = "stl" | "obj" | "ply" | "gltf";
export type BakeTargetFormat = "stl" | "obj" | "ply";

export interface MeshEditBakeResult {
  /** The edited model, serialized in `target` format (STL is binary). */
  bytes: Uint8Array;
  /** One outcome per op, the same shape the webview reports. */
  outcomes: OpOutcome[];
  /** Messages the engine reported (e.g. the dense-mesh CSG guard). */
  messages: string[];
}

function installNodePolyfills(): void {
  const g = globalThis as {
    requestAnimationFrame?: (cb: () => void) => unknown;
  };
  g.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);
}

/**
 * Loads `bytes` as the webview would, tags `node-N` ids, applies `ops`, and
 * serializes the result as `target`. Throws when the source can't be loaded
 * (e.g. a glTF with a required compression extension) — callers fall back to
 * the raw file with a warning. A single op that can't apply is NOT a throw:
 * it is recorded in `outcomes`, exactly as in the viewer.
 */
export async function bakeMeshEdits(
  bytes: Uint8Array,
  format: BakeSourceFormat,
  ops: EditOp[],
  target: BakeTargetFormat,
  externalBuffers?: GltfExternalBuffers
): Promise<MeshEditBakeResult> {
  installNodePolyfills();
  const root: THREE.Object3D =
    format === "gltf" ? await parseGltfObject(bytes, externalBuffers) : parseMeshObject(bytes, format);
  tagMeshEntities(root);
  const outcomes: OpOutcome[] = [];
  const messages: string[] = [];
  applyEditsMesh(root, ops, outcomes, (msg) => messages.push(msg));
  root.updateMatrixWorld(true);
  const exported = await exportModel(root, target);
  const out = exported.binary ? base64ToBytes(exported.data) : new TextEncoder().encode(exported.data);
  return { bytes: out, outcomes, messages };
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
