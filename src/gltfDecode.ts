/**
 * Kernel-worker half of compressed-glTF support: expands `KHR_draco_mesh_compression`
 * primitives and `EXT_meshopt_compression` bufferViews into the reserved
 * `decoded:` entries `parseGltf` consumes (see `gltfDecodedKeys.ts` for why the
 * decode is a separate async step rather than part of the synchronous parser).
 *
 * Only the geometry the tools read is decoded: for Draco, `POSITION` and the
 * triangle list; for meshopt, the bufferViews that a primitive's `POSITION` or
 * `indices` accessor reads. Colours, normals and UVs stay compressed and
 * unused, exactly as `parseGltf` ignores them for uncompressed files.
 *
 * Both decoders are WebAssembly, so they live here in the kernel worker and
 * never in the extension host. Each is initialised lazily on the first
 * compressed file — an uncompressed glTF never loads either (the lazy-WASM
 * invariant) — and un-cached on a rejected init, like the other kernels.
 *
 * Draco's wasm is read from `dist/draco/node/` and handed in as `wasmBinary`
 * (the same Node fetch-path lesson as OCCT: the emscripten loader cannot
 * resolve its own file once bundled). Meshopt's decoder embeds its wasm.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import createDracoDecoderModule from "draco3d/draco_decoder_nodejs";
import { MeshoptDecoder } from "meshoptimizer/decoder";
import { gltfCompression, loadGltfDocument, type GltfExternalBuffers } from "./gltfParser";
import { DRACO_EXTENSION, MESHOPT_EXTENSION, dracoKey, meshoptKey, packFloat32, packUint32 } from "./gltfDecodedKeys";

/* eslint-disable @typescript-eslint/no-explicit-any */

let _dracoPromise: Promise<any> | null = null;

/** The staged decoder wasm, falling back to the installed package for a
 * development / unit-test tree that has not run the build's staging step. */
function dracoWasmPath(extensionPath: string): string {
  const staged = path.join(extensionPath, "dist", "draco", "node", "draco_decoder.wasm");
  if (fs.existsSync(staged)) return staged;
  return path.join(extensionPath, "node_modules", "draco3d", "draco_decoder.wasm");
}

/** Lazy, memoised, un-cached on failure. */
function getDraco(extensionPath: string): Promise<any> {
  if (!_dracoPromise) {
    const wasmBinary = fs.readFileSync(dracoWasmPath(extensionPath));
    _dracoPromise = createDracoDecoderModule({ wasmBinary }).catch((err: unknown) => {
      _dracoPromise = null;
      throw err;
    });
  }
  return _dracoPromise;
}

/** Drops the Draco singleton so the next call re-initialises it. */
export function resetDraco(): void {
  _dracoPromise = null;
}

function isWasmAbort(message: string): boolean {
  return /out of bounds|abort|RuntimeError|unreachable|null function|table index|function table|funcref table|wasmtable|signature mismatch/i.test(message) || /^\d+$/.test(message);
}

function wrapDecodeFault(err: unknown): Error {
  const raw = ((err as Error)?.message ?? String(err)).trim();
  if (!isWasmAbort(raw)) return err instanceof Error ? err : new Error(raw);
  resetDraco();
  return new Error(`The glTF decoder crashed (${raw || "WASM abort"}) — it has been reset; try the operation again.`);
}

interface DecodedPrimitive {
  positions: Uint8Array;
  indices: Uint8Array;
}

/** Decodes one Draco-compressed mesh. Throws a plain Error naming the cause
 * for anything that is not a triangle mesh. */
function decodeDracoPrimitive(draco: any, source: Uint8Array, positionAttributeId: number): DecodedPrimitive {
  const decoder = new draco.Decoder();
  const buffer = new draco.DecoderBuffer();
  let mesh: any;
  try {
    buffer.Init(new Int8Array(source.buffer, source.byteOffset, source.byteLength), source.byteLength);
    if (decoder.GetEncodedGeometryType(buffer) !== draco.TRIANGULAR_MESH) {
      throw new Error("a Draco primitive is not a triangle mesh");
    }
    mesh = new draco.Mesh();
    const status = decoder.DecodeBufferToMesh(buffer, mesh);
    if (!status.ok() || mesh.ptr === 0) throw new Error(`Draco could not decode a primitive: ${status.error_msg()}`);

    const attribute = decoder.GetAttributeByUniqueId(mesh, positionAttributeId);
    if (!attribute || attribute.ptr === 0) throw new Error("a Draco primitive has no POSITION attribute");
    const pointCount = mesh.num_points();
    const floats = new draco.DracoFloat32Array();
    let positions: Float32Array;
    try {
      if (!decoder.GetAttributeFloatForAllPoints(mesh, attribute, floats)) {
        throw new Error("Draco could not read the POSITION attribute as floats");
      }
      positions = new Float32Array(floats.size());
      for (let i = 0; i < positions.length; i++) positions[i] = floats.GetValue(i);
    } finally {
      draco.destroy(floats);
    }
    if (positions.length !== pointCount * 3) throw new Error("a Draco POSITION attribute is not a 3-component attribute");

    const faceCount = mesh.num_faces();
    const indices = new Uint32Array(faceCount * 3);
    const face = new draco.DracoInt32Array();
    try {
      for (let f = 0; f < faceCount; f++) {
        decoder.GetFaceFromMesh(mesh, f, face);
        indices[f * 3] = face.GetValue(0);
        indices[f * 3 + 1] = face.GetValue(1);
        indices[f * 3 + 2] = face.GetValue(2);
      }
    } finally {
      draco.destroy(face);
    }
    return { positions: packFloat32(positions), indices: packUint32(indices) };
  } finally {
    if (mesh) draco.destroy(mesh);
    draco.destroy(buffer);
    draco.destroy(decoder);
  }
}

/**
 * Returns ONLY the new `decoded:` entries; the caller merges them into its
 * external-buffer map (`resolveExternalBuffers(bytes, read, decode)` does).
 * A file with no compression returns `{}` without touching either decoder.
 *
 * A decode failure throws: a compressed file whose geometry cannot be decoded
 * must say so rather than parse as empty. A source buffer that is simply not
 * available (an unsupplied sibling `.bin`) is skipped, so `parseGltf` reports
 * the missing file by name as it does for any uncompressed file.
 */
export async function decodeGltfGeometry(
  extensionPath: string,
  bytes: Uint8Array,
  external: GltfExternalBuffers = {}
): Promise<GltfExternalBuffers> {
  const compression = gltfCompression(bytes);
  const out: GltfExternalBuffers = {};
  if (!compression.draco && !compression.meshopt) return out;

  const { json, buffers } = loadGltfDocument(bytes, external);
  const bufferViews: any[] = Array.isArray(json.bufferViews) ? json.bufferViews : [];
  const accessors: any[] = Array.isArray(json.accessors) ? json.accessors : [];
  const meshes: any[] = Array.isArray(json.meshes) ? json.meshes : [];

  try {
    if (compression.meshopt) {
      // Only the views a primitive's POSITION or indices accessor reads.
      const wanted = new Set<number>();
      for (const mesh of meshes) {
        for (const primitive of mesh?.primitives ?? []) {
          for (const accessorIndex of [primitive?.attributes?.POSITION, primitive?.indices]) {
            if (accessorIndex === undefined) continue;
            const viewIndex = accessors[accessorIndex]?.bufferView;
            if (Number.isInteger(viewIndex) && bufferViews[viewIndex]?.extensions?.[MESHOPT_EXTENSION]) wanted.add(viewIndex);
          }
        }
      }
      if (wanted.size > 0) {
        await MeshoptDecoder.ready;
        for (const viewIndex of wanted) {
          const ext = bufferViews[viewIndex].extensions[MESHOPT_EXTENSION];
          const source = buffers[Number(ext.buffer) || 0];
          if (!source) continue;
          const count = Number(ext.count);
          const size = Number(ext.byteStride);
          if (!Number.isInteger(count) || !Number.isInteger(size) || count <= 0 || size <= 0) {
            throw new Error(`bufferView ${viewIndex} has an invalid ${MESHOPT_EXTENSION} count/byteStride`);
          }
          const start = Number(ext.byteOffset) || 0;
          const compressed = source.subarray(start, start + (Number(ext.byteLength) || 0));
          const target = new Uint8Array(count * size);
          MeshoptDecoder.decodeGltfBuffer(target, count, size, compressed, String(ext.mode), ext.filter ? String(ext.filter) : undefined);
          out[meshoptKey(viewIndex)] = target;
        }
      }
    }

    if (compression.draco) {
      let draco: any;
      for (let m = 0; m < meshes.length; m++) {
        const primitives: any[] = Array.isArray(meshes[m]?.primitives) ? meshes[m].primitives : [];
        for (let p = 0; p < primitives.length; p++) {
          const ext = primitives[p]?.extensions?.[DRACO_EXTENSION];
          if (!ext) continue;
          const view = bufferViews[ext.bufferView];
          const source = view ? buffers[Number(view.buffer) || 0] : undefined;
          if (!view || !source) continue;
          const positionId = ext.attributes?.POSITION;
          if (!Number.isInteger(positionId)) throw new Error("a Draco primitive does not name its POSITION attribute");
          draco ??= await getDraco(extensionPath);
          const start = Number(view.byteOffset) || 0;
          const decoded = decodeDracoPrimitive(draco, source.subarray(start, start + (Number(view.byteLength) || 0)), positionId);
          out[dracoKey(m, p, "positions")] = decoded.positions;
          out[dracoKey(m, p, "indices")] = decoded.indices;
        }
      }
    }
  } catch (err) {
    throw wrapDecodeFault(err);
  }
  return out;
}
