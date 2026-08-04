/**
 * Pure host-side glTF 2.0 / GLB parser — vscode/OCCT/THREE-free, the fourth
 * member of the `stlParser.ts`/`objParser.ts`/`plyParser.ts` "no framework,
 * just bytes in, plain data out" family. ("Pure" here means framework-free,
 * not runtime-free: like its siblings it uses Node's `Buffer` for base64/UTF-8
 * decoding, so it runs in the extension host and the kernel worker, never in
 * the webview — the webview has three's own `GLTFLoader` for display.)
 *
 * Scope: **geometry only.** Every mesh primitive's `POSITION` attribute and
 * indices are read and transformed by its node's world matrix; materials,
 * textures, cameras, skins, animations, and morph targets are ignored
 * entirely (the bind pose is the geometry — consistent with the already-
 * documented "glTF animations are not played" limitation elsewhere).
 *
 * Unlike `objParser.ts`/`plyParser.ts`, this parser **welds** its output. Each
 * primitive and each node instance is its own independent index space, so a
 * single shared space is required before `connectedComponents()` can find
 * anything at all. Exporters routinely split one watertight solid across
 * several primitives (one per material) with duplicated vertices along the
 * seam; without welding, a per-material-split cube would report six open
 * sheets with no volume instead of one closed solid — precisely the
 * confidently-wrong answer Compare Models exists to avoid. The accepted
 * consequence is identical to STL's: a "solid" is a connected component, so
 * two objects positioned to touch merge into one.
 *
 * Validation note: this module's unit tests cross-check every fixture against
 * three.js's own `GLTFLoader` (see `gltfParser.crossvalidation.test.ts`),
 * which is what made hand-rolling this defensible — a subtly-wrong parser
 * producing plausible-but-wrong centroids/volumes would be worse than not
 * supporting the format at all.
 */

import { weldTriangleSoup, type WeldedMesh } from "./meshComponents";

export type { WeldedMesh };

/** Sibling buffer files (`buffers[i].uri` pointing at a relative path) keyed
 * by their raw URI as it appears in the glTF, supplied by a caller that has
 * filesystem access. */
export type GltfExternalBuffers = Record<string, Uint8Array>;

/** Geometry-affecting extensions this parser cannot decode. Deliberately a
 * DENY-list checked against `extensionsRequired`, never an allow-list against
 * `extensionsUsed`: almost every real-world file declares geometry-irrelevant
 * extensions (`KHR_materials_*`, `KHR_texture_transform`, `KHR_lights_punctual`,
 * …) that this parser handles perfectly by ignoring them, so an allow-list
 * would reject the large majority of valid input. `KHR_mesh_quantization` is
 * genuinely supported (see `normalized` handling below) and must not appear
 * here. */
const DENIED_GEOMETRY_EXTENSIONS = ["KHR_draco_mesh_compression", "EXT_meshopt_compression"];

const COMPONENT_SIZES: Record<number, number> = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};

const TYPE_COMPONENT_COUNTS: Record<string, number> = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
};

const GLB_MAGIC = 0x46546c67; // "glTF"
const GLB_CHUNK_JSON = 0x4e4f534a;
const GLB_CHUNK_BIN = 0x004e4942;

/* eslint-disable @typescript-eslint/no-explicit-any */
type GltfDocument = any;

interface Container {
  json: GltfDocument;
  /** The GLB BIN chunk, when present — the payload of a buffer with no `uri`. */
  bin?: Uint8Array;
}

/**
 * Splits raw bytes into the JSON document plus (for GLB) its binary chunk.
 * The container is detected from the BYTES, never from the file extension:
 * `fileRouter.ts` deliberately maps both `.gltf` and `.glb` to one `"gltf"`
 * format, so the route carries no container information at all.
 */
function parseContainer(bytes: Uint8Array): Container {
  if (bytes.length >= 12) {
    const head = new DataView(bytes.buffer, bytes.byteOffset, 12);
    if (head.getUint32(0, true) === GLB_MAGIC) {
      const version = head.getUint32(4, true);
      if (version !== 2) {
        throw new Error(`Unsupported GLB version ${version} — only glTF 2.0 binary files are supported.`);
      }
      let json: GltfDocument | undefined;
      let bin: Uint8Array | undefined;
      let cursor = 12;
      while (cursor + 8 <= bytes.length) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, 8);
        const chunkLength = view.getUint32(0, true);
        const chunkType = view.getUint32(4, true);
        const start = cursor + 8;
        const end = start + chunkLength;
        if (end > bytes.length) throw new Error("Malformed GLB: a chunk runs past the end of the file.");
        if (chunkType === GLB_CHUNK_JSON && json === undefined) {
          json = parseJsonDocument(bytes.subarray(start, end));
        } else if (chunkType === GLB_CHUNK_BIN && bin === undefined) {
          bin = bytes.subarray(start, end);
        }
        // Chunks are padded to a 4-byte boundary.
        cursor = end + ((4 - (chunkLength % 4)) % 4);
      }
      if (json === undefined) throw new Error("Malformed GLB: no JSON chunk found.");
      return { json, bin };
    }
  }
  return { json: parseJsonDocument(bytes) };
}

function parseJsonDocument(bytes: Uint8Array): GltfDocument {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("Not a glTF file: the content is neither binary GLB nor valid JSON.");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("Not a glTF file: the JSON root is not an object.");
  }
  if ((json as GltfDocument).asset === undefined) {
    throw new Error('Not a glTF file: the JSON has no "asset" property.');
  }
  return json as GltfDocument;
}

/**
 * Rejects any buffer URI that isn't a plain relative path beside the model.
 * A `.gltf` is untrusted input and this extension is read-only by design, so
 * a URI with a scheme (`http:`/`file:`/…), an absolute path, or a `..` segment
 * that escapes the model's own directory is never fetched — it is simply left
 * out of the resolved map, which makes `parseGltf` throw a clear "buffer was
 * not provided" error rather than silently reading something it shouldn't.
 */
function isSafeBufferUri(uri: string): boolean {
  if (uri.length === 0) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri)) return false; // any scheme, incl. data:/http:/file:
  if (uri.startsWith("/") || uri.startsWith("\\")) return false; // POSIX absolute
  if (/^[a-zA-Z]:[\\/]/.test(uri)) return false; // Windows drive-absolute
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    return false;
  }
  return !decoded.split(/[\\/]/).some((segment) => segment === "..");
}

function bufferUris(json: GltfDocument): string[] {
  const buffers = Array.isArray(json.buffers) ? json.buffers : [];
  const uris: string[] = [];
  for (const buffer of buffers) {
    const uri = buffer?.uri;
    if (typeof uri === "string" && !uri.startsWith("data:")) uris.push(uri);
  }
  return uris;
}

/**
 * The buffer URIs that are neither the GLB BIN chunk nor an embedded `data:`
 * URI — i.e. sibling files a caller with filesystem access must read. Exists
 * because the URIs are only discoverable by parsing the JSON, while reading
 * them requires an I/O capability this module deliberately doesn't have; the
 * two-phase list → read → `parseGltf(bytes, external)` flow is what keeps this
 * module fs/vscode-free. Re-parsing the JSON twice is negligible next to
 * accessor decoding.
 */
export function listExternalBufferUris(bytes: Uint8Array): string[] {
  return bufferUris(parseContainer(bytes).json);
}

/**
 * Reads every URI `listExternalBufferUris` reports via a caller-supplied
 * reader — `mcpTools.ts` passes a `node:fs` one, `modelComparePanel.ts` a
 * `vscode.workspace.fs` one. Unsafe URIs (see `isSafeBufferUri`) are skipped
 * without ever calling `read`, and a URI the reader can't resolve is simply
 * absent from the result.
 */
export async function resolveExternalBuffers(
  bytes: Uint8Array,
  read: (uri: string) => Promise<Uint8Array | undefined>
): Promise<GltfExternalBuffers> {
  const resolved: GltfExternalBuffers = {};
  for (const uri of listExternalBufferUris(bytes)) {
    if (!isSafeBufferUri(uri)) continue;
    const data = await read(uri);
    if (data) resolved[uri] = data;
  }
  return resolved;
}

/** Resolves every `buffers[i]` to its bytes, or to `undefined` when it's an
 * unavailable external sibling (only fatal if an accessor actually reads it). */
function resolveBuffers(json: GltfDocument, bin: Uint8Array | undefined, external: GltfExternalBuffers): Array<Uint8Array | undefined> {
  const buffers = Array.isArray(json.buffers) ? json.buffers : [];
  return buffers.map((buffer: GltfDocument, index: number) => {
    const uri = buffer?.uri;
    if (typeof uri !== "string") {
      // No URI: the GLB BIN chunk, which is only ever buffer 0.
      if (index === 0 && bin) return bin;
      return undefined;
    }
    if (uri.startsWith("data:")) {
      const comma = uri.indexOf(",");
      if (comma === -1 || !/;base64$/i.test(uri.slice(0, comma))) return undefined;
      try {
        return new Uint8Array(Buffer.from(uri.slice(comma + 1), "base64"));
      } catch {
        return undefined;
      }
    }
    return external[uri];
  });
}

function readComponent(view: DataView, offset: number, componentType: number): number {
  switch (componentType) {
    case 5120: return view.getInt8(offset);
    case 5121: return view.getUint8(offset);
    case 5122: return view.getInt16(offset, true);
    case 5123: return view.getUint16(offset, true);
    case 5125: return view.getUint32(offset, true);
    case 5126: return view.getFloat32(offset, true);
    default: return NaN;
  }
}

/** The glTF spec's normalized-integer → float mapping (KHR_mesh_quantization).
 * Float accessors ignore the flag. */
function normalizeComponent(value: number, componentType: number): number {
  switch (componentType) {
    case 5120: return Math.max(value / 127, -1);
    case 5121: return value / 255;
    case 5122: return Math.max(value / 32767, -1);
    case 5123: return value / 65535;
    case 5125: return value / 4294967295;
    default: return value;
  }
}

/**
 * Decodes one accessor into a flat `Float64Array` of `count * componentCount`
 * values, handling `byteStride` interleaving, `normalized`, and sparse
 * overlays. Returns `undefined` when the accessor is unusable (bad index,
 * unknown component type, an unavailable buffer).
 *
 * Every read goes through `DataView` with explicit little-endian, never a
 * typed-array view over the bufferView's byte offset: glTF only guarantees
 * 4-byte alignment relative to the *buffer*, so a `Float32Array` constructed
 * at an arbitrary `byteOffset` throws in V8. One unit-test fixture
 * deliberately places POSITION at a non-4-aligned absolute offset to keep
 * that from being "optimized" back into typed-array views later.
 */
function readAccessor(
  json: GltfDocument,
  buffers: Array<Uint8Array | undefined>,
  accessorIndex: number,
  missingBufferUris: Set<string>
): Float64Array | undefined {
  const accessors = Array.isArray(json.accessors) ? json.accessors : [];
  const accessor = accessors[accessorIndex];
  if (!accessor) return undefined;

  const componentSize = COMPONENT_SIZES[accessor.componentType];
  const componentCount = TYPE_COMPONENT_COUNTS[accessor.type];
  if (!componentSize || !componentCount) return undefined;

  const count = Number(accessor.count) || 0;
  const out = new Float64Array(count * componentCount);
  const normalized = accessor.normalized === true;

  const readInto = (
    target: Float64Array,
    bufferViewIndex: number | undefined,
    byteOffset: number,
    componentType: number,
    elements: number,
    components: number,
    applyNormalize: boolean
  ): boolean => {
    if (bufferViewIndex === undefined) return true; // legal: treated as all-zero
    const bufferViews = Array.isArray(json.bufferViews) ? json.bufferViews : [];
    const bufferView = bufferViews[bufferViewIndex];
    if (!bufferView) return false;
    const bufferIndex = Number(bufferView.buffer) || 0;
    const data = buffers[bufferIndex];
    if (!data) {
      const uri = json.buffers?.[bufferIndex]?.uri;
      if (typeof uri === "string" && !uri.startsWith("data:")) missingBufferUris.add(uri);
      return false;
    }
    const size = COMPONENT_SIZES[componentType];
    if (!size) return false;
    const stride = Number(bufferView.byteStride) || size * components;
    const base = (Number(bufferView.byteOffset) || 0) + byteOffset;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let e = 0; e < elements; e++) {
      const elementStart = base + e * stride;
      for (let c = 0; c < components; c++) {
        const at = elementStart + c * size;
        // Truncated accessor data degrades to what was readable, matching
        // plyParser.ts's truncated-binary-body convention.
        if (at + size > data.byteLength) return true;
        const raw = readComponent(view, at, componentType);
        target[e * components + c] = applyNormalize ? normalizeComponent(raw, componentType) : raw;
      }
    }
    return true;
  };

  if (!readInto(out, accessor.bufferView, Number(accessor.byteOffset) || 0, accessor.componentType, count, componentCount, normalized)) {
    return undefined;
  }

  const sparse = accessor.sparse;
  if (sparse && Number(sparse.count) > 0) {
    const sparseCount = Number(sparse.count);
    const indexValues = new Float64Array(sparseCount);
    const okIndices = readInto(
      indexValues,
      sparse.indices?.bufferView,
      Number(sparse.indices?.byteOffset) || 0,
      sparse.indices?.componentType,
      sparseCount,
      1,
      false
    );
    if (okIndices) {
      const values = new Float64Array(sparseCount * componentCount);
      const okValues = readInto(
        values,
        sparse.values?.bufferView,
        Number(sparse.values?.byteOffset) || 0,
        accessor.componentType,
        sparseCount,
        componentCount,
        normalized
      );
      if (okValues) {
        for (let s = 0; s < sparseCount; s++) {
          const target = indexValues[s];
          if (!Number.isFinite(target) || target < 0 || target >= count) continue;
          for (let c = 0; c < componentCount; c++) out[target * componentCount + c] = values[s * componentCount + c];
        }
      }
    }
  }

  return out;
}

type Mat4 = number[]; // column-major, 16 entries — glTF's own convention

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row] * b[col * 4] +
        a[4 + row] * b[col * 4 + 1] +
        a[8 + row] * b[col * 4 + 2] +
        a[12 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

/** `T · R · S` from a node's separate translation/rotation/scale properties —
 * the same composition order the glTF spec (and three.js's `Matrix4.compose`)
 * defines. */
function composeTrs(translation: number[], rotation: number[], scale: number[]): Mat4 {
  const [x, y, z, w] = rotation;
  const [sx, sy, sz] = scale;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    translation[0], translation[1], translation[2], 1,
  ];
}

function localMatrix(node: GltfDocument): Mat4 {
  if (Array.isArray(node?.matrix) && node.matrix.length === 16) return node.matrix.map(Number);
  const translation = Array.isArray(node?.translation) && node.translation.length === 3 ? node.translation.map(Number) : [0, 0, 0];
  const rotation = Array.isArray(node?.rotation) && node.rotation.length === 4 ? node.rotation.map(Number) : [0, 0, 0, 1];
  const scale = Array.isArray(node?.scale) && node.scale.length === 3 ? node.scale.map(Number) : [1, 1, 1];
  return composeTrs(translation, rotation, scale);
}

/** Determinant of the upper-left 3×3 — negative means the node mirrors, which
 * flips triangle winding. */
function upper3x3Determinant(m: Mat4): number {
  return (
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2])
  );
}

/** The root nodes to walk: the default scene's, else every node nobody claims
 * as a child, else (no nodes at all) nothing. Preferring the scene matches
 * what three's `GLTFLoader` does, which keeps the cross-validation honest. */
function rootNodeIndices(json: GltfDocument): number[] {
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const scenes = Array.isArray(json.scenes) ? json.scenes : [];
  const sceneIndex = Number.isInteger(json.scene) ? json.scene : 0;
  const scene = scenes[sceneIndex];
  if (scene && Array.isArray(scene.nodes)) return scene.nodes.map(Number).filter((i: number) => Number.isInteger(i));

  const claimed = new Set<number>();
  for (const node of nodes) {
    if (Array.isArray(node?.children)) for (const child of node.children) claimed.add(Number(child));
  }
  return nodes.map((_: unknown, i: number) => i).filter((i: number) => !claimed.has(i));
}

/**
 * Parses raw glTF (`.gltf` JSON) or GLB (`.glb` binary) bytes into a welded,
 * shared-vertex indexed mesh in world space, with every node's transform
 * already applied.
 *
 * Throws — rather than degrading — when the content isn't glTF at all (bad
 * magic/version, unparseable JSON, no `asset`), when a geometry-compressing
 * extension this parser can't decode is *required*, or when an external
 * buffer an accessor actually needs wasn't supplied. Those last two are a
 * deliberate, documented break with the sibling parsers' "malformed content
 * degrades silently" rule: returning a silently-empty or half-empty mesh
 * would feed Compare Models a confidently-wrong centroid and volume, which is
 * exactly the failure mode this feature was built to avoid. Everything a
 * caller genuinely can't act on — a primitive with no POSITION, an
 * out-of-range accessor/node index, a non-triangle draw mode, truncated
 * accessor data — is skipped silently as usual.
 */
export function parseGltf(bytes: Uint8Array, external: GltfExternalBuffers = {}): WeldedMesh {
  const { json, bin } = parseContainer(bytes);

  const required: string[] = Array.isArray(json.extensionsRequired) ? json.extensionsRequired : [];
  const deniedRequired = required.filter((name) => DENIED_GEOMETRY_EXTENSIONS.includes(name));
  if (deniedRequired.length > 0) {
    throw new Error(
      `glTF requires the ${deniedRequired.join(", ")} extension, which compresses the geometry into a form this parser cannot decode. Re-export the file without mesh compression.`
    );
  }
  if (required.includes("EXT_mesh_gpu_instancing")) {
    throw new Error("glTF requires the EXT_mesh_gpu_instancing extension, which this parser cannot decode. Re-export the file without GPU instancing.");
  }

  const buffers = resolveBuffers(json, bin, external);
  const meshes = Array.isArray(json.meshes) ? json.meshes : [];
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const missingBufferUris = new Set<string>();

  const soup: number[] = [];

  const emitMesh = (meshIndex: number, world: Mat4): void => {
    const mesh = meshes[meshIndex];
    if (!mesh || !Array.isArray(mesh.primitives)) return;
    const flipWinding = upper3x3Determinant(world) < 0;

    for (const primitive of mesh.primitives) {
      if (primitive?.extensions) {
        for (const name of DENIED_GEOMETRY_EXTENSIONS) {
          if (primitive.extensions[name]) {
            throw new Error(
              `glTF uses the ${name} extension on a mesh primitive, which compresses the geometry into a form this parser cannot decode. Re-export the file without mesh compression.`
            );
          }
        }
      }

      const mode = primitive?.mode ?? 4;
      if (mode !== 4 && mode !== 5 && mode !== 6) continue; // points/lines contribute no triangles
      const positionAccessor = primitive?.attributes?.POSITION;
      if (positionAccessor === undefined) continue;

      const positions = readAccessor(json, buffers, positionAccessor, missingBufferUris);
      if (!positions) continue;
      const vertexCount = Math.floor(positions.length / 3);
      if (vertexCount === 0) continue;

      let sequence: ArrayLike<number>;
      if (primitive.indices === undefined) {
        const generated = new Uint32Array(vertexCount);
        for (let i = 0; i < vertexCount; i++) generated[i] = i;
        sequence = generated;
      } else {
        const read = readAccessor(json, buffers, primitive.indices, missingBufferUris);
        if (!read) continue;
        sequence = read;
      }

      const pushTriangle = (a: number, b: number, c: number): void => {
        if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c)) return;
        if (a < 0 || b < 0 || c < 0 || a >= vertexCount || b >= vertexCount || c >= vertexCount) return;
        const order = flipWinding ? [a, c, b] : [a, b, c];
        for (const vertex of order) {
          const p = vertex * 3;
          const x = positions[p], y = positions[p + 1], z = positions[p + 2];
          soup.push(
            world[0] * x + world[4] * y + world[8] * z + world[12],
            world[1] * x + world[5] * y + world[9] * z + world[13],
            world[2] * x + world[6] * y + world[10] * z + world[14]
          );
        }
      };

      if (mode === 4) {
        for (let i = 0; i + 2 < sequence.length; i += 3) pushTriangle(sequence[i], sequence[i + 1], sequence[i + 2]);
      } else if (mode === 5) {
        // TRIANGLE_STRIP — every other triangle has reversed winding.
        for (let i = 2; i < sequence.length; i++) {
          if (i % 2 === 0) pushTriangle(sequence[i - 2], sequence[i - 1], sequence[i]);
          else pushTriangle(sequence[i - 1], sequence[i - 2], sequence[i]);
        }
      } else {
        // TRIANGLE_FAN
        for (let i = 2; i < sequence.length; i++) pushTriangle(sequence[0], sequence[i - 1], sequence[i]);
      }
    }
  };

  // A `visited` set on the recursion path is mandatory, not defensive: a
  // cyclic `nodes` array in an untrusted file would otherwise hang the
  // extension host or the MCP server outright.
  const walk = (nodeIndex: number, parentWorld: Mat4, path: Set<number>): void => {
    if (!Number.isInteger(nodeIndex) || path.has(nodeIndex)) return;
    const node = nodes[nodeIndex];
    if (!node) return;
    path.add(nodeIndex);
    const world = multiply(parentWorld, localMatrix(node));
    if (Number.isInteger(node.mesh)) emitMesh(node.mesh, world);
    if (Array.isArray(node.children)) for (const child of node.children) walk(Number(child), world, path);
    path.delete(nodeIndex);
  };

  const roots = rootNodeIndices(json);
  if (roots.length > 0) {
    for (const root of roots) walk(root, IDENTITY, new Set());
  } else if (nodes.length === 0) {
    // No node graph at all — fall back to every mesh at the origin.
    for (let i = 0; i < meshes.length; i++) emitMesh(i, IDENTITY);
  }

  // Deliberately unconditional, not gated on `soup.length === 0`: a file whose
  // OTHER primitives read fine would otherwise return a partial mesh, which is
  // the same confidently-wrong result as an empty one.
  if (missingBufferUris.size > 0) {
    throw new Error(
      `glTF references external buffer file(s) ${[...missingBufferUris].map((u) => `"${u}"`).join(", ")}, which were not provided — read them from beside the .gltf file and pass them via the external-buffers map.`
    );
  }

  return weldTriangleSoup(new Float32Array(soup));
}
