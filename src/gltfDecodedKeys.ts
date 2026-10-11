/**
 * Naming and packing for pre-decoded compressed glTF geometry.
 *
 * `parseGltf` is synchronous and is called from a dozen sites in three
 * processes, while the Draco decoder is WebAssembly that only exists in the
 * kernel worker. So the decode happens ahead of time (`gltfDecode.ts`, in the
 * worker) and its results travel in the SAME `GltfExternalBuffers` map every
 * caller already resolves and passes along, under reserved keys. This module is
 * the one place those keys are spelled, so the writer (`gltfDecode.ts`), the
 * reader (`gltfParser.ts`) and the document rewriter (`gltfInflate.ts`) cannot
 * drift.
 *
 * A `decoded:` key can never collide with a real sibling file: it carries a URI
 * scheme, and `isSafeRelativePath` already refuses any scheme-bearing URI, so
 * `resolveExternalBuffers` would never have read one from disk.
 *
 * Pure and dependency-free (no Node `Buffer`, no THREE) — it is imported by the
 * webview-bundled `meshObject.ts` via `gltfInflate.ts`.
 */

export const DRACO_EXTENSION = "KHR_draco_mesh_compression";
export const MESHOPT_EXTENSION = "EXT_meshopt_compression";

export const DECODED_PREFIX = "decoded:";

/** True for a key written by the decode step rather than read from disk. */
export function isDecodedKey(key: string): boolean {
  return key.startsWith(DECODED_PREFIX);
}

/** `part` is `positions` (little-endian float32 xyz) or `indices` (little-endian
 * uint32 triangle list) of the Draco primitive `meshes[mesh].primitives[prim]`. */
export function dracoKey(mesh: number, prim: number, part: "positions" | "indices"): string {
  return `${DECODED_PREFIX}draco:${mesh}/${prim}:${part}`;
}

/** The decompressed bytes of `bufferViews[view]` — `count * byteStride` long,
 * addressed from offset 0 (the view's own `byteOffset` describes the compressed
 * source, not these bytes). */
export function meshoptKey(view: number): string {
  return `${DECODED_PREFIX}meshopt:${view}`;
}

/** Little-endian float32 bytes, independent of the host's endianness. */
export function packFloat32(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i], true);
  return out;
}

/** Little-endian uint32 bytes. */
export function packUint32(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) view.setUint32(i * 4, values[i], true);
  return out;
}

/** Reads packed float32 bytes without assuming the array's `byteOffset` is
 * 4-aligned (IPC and `Buffer` pooling both produce unaligned views). */
export function unpackFloat32(bytes: Uint8Array): Float64Array {
  const count = Math.floor(bytes.byteLength / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

export function unpackUint32(bytes: Uint8Array): Uint32Array {
  const count = Math.floor(bytes.byteLength / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getUint32(i * 4, true);
  return out;
}
