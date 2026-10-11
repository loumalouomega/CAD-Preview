// Regenerates examples/GLTF/cube-draco.glb and cube-meshopt.glb from the
// committed uncompressed examples/GLTF/cube.gltf, using the Draco and
// meshoptimizer ENCODERS (both ship inside their npm packages, which are
// already dependencies for the decode side).
//
//   node scripts/gltf-fixtures/make-compressed.mjs
//
// Neither fixture is hand-edited; if one needs to change, change this script
// and regenerate. The cube has its eight corners at the extremes of its own
// bounding box, so quantisation (16-bit Draco positions) reproduces them to
// well under 1e-6 and both fixtures keep the source cube's volume of exactly 1.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MeshoptEncoder } from "meshoptimizer/encoder";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(ROOT, "examples", "GLTF");

// ---- the source cube: 8 float32 positions + 36 uint16 indices ----------
const source = JSON.parse(fs.readFileSync(path.join(OUT, "cube.gltf"), "utf8"));
const raw = Buffer.from(source.buffers[0].uri.split(",")[1], "base64");
const positionBytes = new Uint8Array(raw.subarray(0, 96));
const indexBytes = new Uint8Array(raw.subarray(96, 96 + 72));
const positions = new Float32Array(positionBytes.buffer.slice(0, 96));
const indices16 = new Uint16Array(indexBytes.buffer.slice(0, 72));
const indices32 = Uint32Array.from(indices16);

const pad4 = (n) => (4 - (n % 4)) % 4;

function glb(json, bin) {
  const jsonText = JSON.stringify(json);
  const jsonBytes = Buffer.concat([Buffer.from(jsonText, "utf8"), Buffer.alloc(pad4(Buffer.byteLength(jsonText)), 0x20)]);
  const binBytes = Buffer.concat([Buffer.from(bin), Buffer.alloc(pad4(bin.byteLength), 0)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + binBytes.length, 8);
  const chunk = (type, body) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(body.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, body]);
  };
  return Buffer.concat([header, chunk(0x4e4f534a, jsonBytes), chunk(0x004e4942, binBytes)]);
}

// ---- Draco --------------------------------------------------------------
async function makeDraco() {
  const dir = path.join(ROOT, "node_modules", "draco3d");
  const encoder = await require(path.join(dir, "draco_encoder_nodejs.js"))({
    wasmBinary: fs.readFileSync(path.join(dir, "draco_encoder.wasm")),
  });
  const builder = new encoder.MeshBuilder();
  const mesh = new encoder.Mesh();
  builder.AddFacesToMesh(mesh, indices32.length / 3, indices32);
  const attributeId = builder.AddFloatAttributeToMesh(mesh, encoder.POSITION, positions.length / 3, 3, positions);
  const enc = new encoder.Encoder();
  enc.SetAttributeQuantization(encoder.POSITION, 16);
  enc.SetEncodingMethod(encoder.MESH_EDGEBREAKER_ENCODING);
  const out = new encoder.DracoInt8Array();
  const size = enc.EncodeMeshToDracoBuffer(mesh, out);
  if (size <= 0) throw new Error("Draco encode failed");
  const compressed = new Uint8Array(size);
  for (let i = 0; i < size; i++) compressed[i] = out.GetValue(i);

  const json = {
    asset: { version: "2.0", generator: "scripts/gltf-fixtures/make-compressed.mjs (draco3d)" },
    extensionsUsed: ["KHR_draco_mesh_compression"],
    extensionsRequired: ["KHR_draco_mesh_compression"],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0 },
        indices: 1,
        extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: attributeId } } },
      }],
    }],
    accessors: [
      { componentType: 5126, count: 8, type: "VEC3", min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { componentType: 5123, count: 36, type: "SCALAR" },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: compressed.byteLength }],
    buffers: [{ byteLength: compressed.byteLength }],
  };
  fs.writeFileSync(path.join(OUT, "cube-draco.glb"), glb(json, compressed));
  console.log(`cube-draco.glb   ${compressed.byteLength} B compressed geometry`);
}

// ---- meshopt ------------------------------------------------------------
async function makeMeshopt() {
  await MeshoptEncoder.ready;
  const vertices = MeshoptEncoder.encodeGltfBuffer(positionBytes, 8, 12, "ATTRIBUTES");
  const triangles = MeshoptEncoder.encodeGltfBuffer(indexBytes, 36, 2, "TRIANGLES");
  const vertexPad = pad4(vertices.byteLength);
  const bin = Buffer.concat([Buffer.from(vertices), Buffer.alloc(vertexPad), Buffer.from(triangles)]);
  const indexOffset = vertices.byteLength + vertexPad;

  const json = {
    asset: { version: "2.0", generator: "scripts/gltf-fixtures/make-compressed.mjs (meshoptimizer)" },
    extensionsUsed: ["EXT_meshopt_compression"],
    extensionsRequired: ["EXT_meshopt_compression"],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3", min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5123, count: 36, type: "SCALAR" },
    ],
    // Buffer 0 holds the compressed streams; buffer 1 is the (empty) fallback
    // the views nominally address, as gltfpack writes it.
    bufferViews: [
      {
        buffer: 1, byteOffset: 0, byteLength: 96, byteStride: 12,
        extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: vertices.byteLength, byteStride: 12, count: 8, mode: "ATTRIBUTES" } },
      },
      {
        buffer: 1, byteOffset: 96, byteLength: 72,
        extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: indexOffset, byteLength: triangles.byteLength, byteStride: 2, count: 36, mode: "TRIANGLES" } },
      },
    ],
    buffers: [
      { byteLength: bin.byteLength },
      { byteLength: 168, extensions: { EXT_meshopt_compression: { fallback: true } } },
    ],
  };
  fs.writeFileSync(path.join(OUT, "cube-meshopt.glb"), glb(json, bin));
  console.log(`cube-meshopt.glb ${vertices.byteLength + triangles.byteLength} B compressed geometry`);
}

await makeDraco();
await makeMeshopt();
