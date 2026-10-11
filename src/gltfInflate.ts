/**
 * Rewrites a Draco/meshopt-compressed glTF JSON document into an equivalent
 * UNCOMPRESSED one, using the pre-decoded entries `gltfDecode.ts` produced.
 *
 * Why this exists: `parseGltf` consumes the decoded entries directly, but the
 * headless mesh-edit bake (`meshObject.ts` `parseGltfObject`) runs three's
 * `GLTFLoader`, whose own Draco support is a Blob Worker + DOM `DRACOLoader`
 * that does not exist in a Node child. Rewriting the document so the loader
 * never sees a compression extension avoids wiring decoders into it at all,
 * and guarantees the bake edits exactly the geometry `parseGltf` and the
 * compare / health tools read.
 *
 * Geometry-only, like `parseGltf`: a Draco primitive keeps its `POSITION` and
 * triangle indices and drops every other attribute (the compressed accessors
 * describe counts only; materials and textures are already stripped by the
 * caller, and normals are recomputed by `meshFromGeometry`).
 *
 * Pure (no DOM, THREE or Node `Buffer`), mutating `doc` in place.
 */

import {
  DRACO_EXTENSION,
  MESHOPT_EXTENSION,
  dracoKey,
  meshoptKey,
} from "./gltfDecodedKeys";

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function dataUri(bytes: Uint8Array): string {
  return `data:application/octet-stream;base64,${toBase64(bytes)}`;
}

function appendBuffer(doc: Doc, bytes: Uint8Array): number {
  if (!Array.isArray(doc.buffers)) doc.buffers = [];
  doc.buffers.push({ byteLength: bytes.byteLength, uri: dataUri(bytes) });
  return doc.buffers.length - 1;
}

function appendBufferView(doc: Doc, view: Doc): number {
  if (!Array.isArray(doc.bufferViews)) doc.bufferViews = [];
  doc.bufferViews.push(view);
  return doc.bufferViews.length - 1;
}

function appendAccessor(doc: Doc, accessor: Doc): number {
  if (!Array.isArray(doc.accessors)) doc.accessors = [];
  doc.accessors.push(accessor);
  return doc.accessors.length - 1;
}

function dropExtension(holder: Doc, name: string): void {
  if (!holder.extensions) return;
  delete holder.extensions[name];
  if (Object.keys(holder.extensions).length === 0) delete holder.extensions;
}

/**
 * Returns true when anything was rewritten. A compressed element with NO
 * decoded entry is left untouched (so a loader then reports it as it always
 * did) rather than half-rewritten.
 */
export function inflateGltfDocument(doc: Doc, decoded: Record<string, Uint8Array | undefined>): boolean {
  let changed = false;

  // Meshopt: re-point each decoded bufferView at a new plain buffer.
  if (Array.isArray(doc.bufferViews)) {
    const count = doc.bufferViews.length; // views appended below are never meshopt
    for (let index = 0; index < count; index++) {
      const view = doc.bufferViews[index];
      if (!view?.extensions?.[MESHOPT_EXTENSION]) continue;
      const bytes = decoded[meshoptKey(index)];
      if (!bytes) continue;
      view.buffer = appendBuffer(doc, bytes);
      view.byteOffset = 0;
      view.byteLength = bytes.byteLength;
      dropExtension(view, MESHOPT_EXTENSION);
      changed = true;
    }
  }

  // Draco: replace each decoded primitive's attributes with plain accessors.
  if (Array.isArray(doc.meshes)) {
    doc.meshes.forEach((mesh: Doc, meshIndex: number) => {
      if (!Array.isArray(mesh?.primitives)) return;
      mesh.primitives.forEach((primitive: Doc, primitiveIndex: number) => {
        if (!primitive?.extensions?.[DRACO_EXTENSION]) return;
        const positions = decoded[dracoKey(meshIndex, primitiveIndex, "positions")];
        const indices = decoded[dracoKey(meshIndex, primitiveIndex, "indices")];
        if (!positions || !indices) return;

        const positionBuffer = appendBuffer(doc, positions);
        const positionView = appendBufferView(doc, { buffer: positionBuffer, byteOffset: 0, byteLength: positions.byteLength });
        const positionAccessor = appendAccessor(doc, {
          bufferView: positionView,
          componentType: 5126,
          count: Math.floor(positions.byteLength / 12),
          type: "VEC3",
        });
        const indexBuffer = appendBuffer(doc, indices);
        const indexView = appendBufferView(doc, { buffer: indexBuffer, byteOffset: 0, byteLength: indices.byteLength });
        const indexAccessor = appendAccessor(doc, {
          bufferView: indexView,
          componentType: 5125,
          count: Math.floor(indices.byteLength / 4),
          type: "SCALAR",
        });

        primitive.attributes = { POSITION: positionAccessor };
        primitive.indices = indexAccessor;
        // Decoded faces are always a triangle list, whatever the declared mode.
        delete primitive.mode;
        dropExtension(primitive, DRACO_EXTENSION);
        changed = true;
      });
    });
  }

  if (changed) {
    // A meshopt fallback buffer only exists to be addressed by the compressed
    // views; once every view is inflated it describes nothing.
    if (!hasRemaining(doc, MESHOPT_EXTENSION) && Array.isArray(doc.buffers)) {
      for (const buffer of doc.buffers) if (buffer?.extensions?.[MESHOPT_EXTENSION]) dropExtension(buffer, MESHOPT_EXTENSION);
    }
    for (const key of ["extensionsUsed", "extensionsRequired"] as const) {
      if (!Array.isArray(doc[key])) continue;
      doc[key] = doc[key].filter((name: string) => {
        // Keep the declaration only for a scheme something still uses.
        if (name === DRACO_EXTENSION || name === MESHOPT_EXTENSION) return hasRemaining(doc, name);
        return true;
      });
      if (doc[key].length === 0) delete doc[key];
    }
  }
  return changed;
}

/** True when some primitive / bufferView STILL carries the extension — i.e. it
 * was not decoded — so the document must keep declaring it. */
function hasRemaining(doc: Doc, name: string): boolean {
  if (name === DRACO_EXTENSION) {
    return (doc.meshes ?? []).some((m: Doc) => (m?.primitives ?? []).some((p: Doc) => p?.extensions?.[name]));
  }
  return (doc.bufferViews ?? []).some((v: Doc) => v?.extensions?.[name]);
}
