/**
 * Cross-validation of `gltfParser.ts` against three.js's own `GLTFLoader` —
 * the reference implementation, and the same loader the webview already uses
 * to DISPLAY a glTF file.
 *
 * This is the file that made hand-rolling a glTF parser defensible at all.
 * glTF was previously excluded from Compare Models specifically because there
 * was "no realistic way to validate a hand-rolled implementation against
 * real-world exporter variety" — a subtly-wrong parser reporting plausible
 * but wrong centroids/volumes is worse than an honest rejection. Running the
 * whole fixture matrix through the reference loader closes that gap.
 *
 * Kept in its own file, deliberately: `gltfParser.test.ts` stays framework-
 * free and fast, and the quarantine is visible in the filename. Precedent
 * exists in both directions — `webview/meshLoaders.test.ts` imports `three`
 * and a loader; `webview/meshExporters.test.ts` polyfills a browser-only
 * global at the top of the file with a comment explaining why.
 */

// GLTFLoader constructs a ProgressEvent for its onProgress callback — a DOM
// API with no Node equivalent, and this repo's vitest config has no jsdom.
// Same polyfill-in-the-test convention meshExporters.test.ts uses for
// requestAnimationFrame; the module under test stays DOM-free.
(globalThis as { ProgressEvent?: unknown }).ProgressEvent ??= class ProgressEvent {
  constructor(public type: string, _init?: unknown) {}
};

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { parseGltf } from "./gltfParser";
import {
  weldTriangleSoup,
  connectedComponents,
  volumeOfTriangles,
  areaOfTriangles,
  boundsOfTriangles,
  type WeldedMesh,
} from "./meshComponents";

/* eslint-disable @typescript-eslint/no-explicit-any */

// --- fixture encoding (self-contained, matching this repo's one-file-per-test convention)

function f32(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setFloat32(i * 4, v, true));
  return out;
}
function i16(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setInt16(i * 2, v, true));
  return out;
}
function u16(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setUint16(i * 2, v, true));
  return out;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function buildGlb(jsonText: string, bin: Uint8Array): Uint8Array {
  const jsonBytes = new TextEncoder().encode(jsonText);
  const jsonChunk = concat(jsonBytes, new Uint8Array((4 - (jsonBytes.length % 4)) % 4).fill(0x20));
  const binChunk = concat(bin, new Uint8Array((4 - (bin.length % 4)) % 4));
  const total = 12 + 8 + jsonChunk.length + (bin.length > 0 ? 8 + binChunk.length : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonChunk.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonChunk, 20);
  if (bin.length > 0) {
    const at = 20 + jsonChunk.length;
    view.setUint32(at, binChunk.length, true);
    view.setUint32(at + 4, 0x004e4942, true);
    out.set(binChunk, at + 8);
  }
  return out;
}

type Container = "gltf" | "glb";

function encode(doc: any, bin: Uint8Array, container: Container): Uint8Array {
  const clone = JSON.parse(JSON.stringify(doc));
  if (Array.isArray(clone.buffers) && clone.buffers.length > 0) {
    clone.buffers[0] =
      container === "gltf"
        ? { byteLength: bin.length, uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString("base64")}` }
        : { byteLength: bin.length };
  }
  return container === "glb" ? buildGlb(JSON.stringify(clone), bin) : new TextEncoder().encode(JSON.stringify(clone));
}

// --- the oracle

/**
 * Removes every material/texture/image/sampler reference. Geometry is
 * completely unaffected by this, and it is REQUIRED for any file that carries
 * textures: GLTFLoader's texture path reaches for browser globals (`self`)
 * that don't exist in Node, so a textured file otherwise fails to parse here
 * with "self is not defined" even though its geometry decodes fine.
 */
function stripMaterials(doc: any): any {
  const clone = JSON.parse(JSON.stringify(doc));
  delete clone.materials;
  delete clone.textures;
  delete clone.images;
  delete clone.samplers;
  for (const mesh of clone.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) delete primitive.material;
  }
  return clone;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Parses with three's GLTFLoader and reduces the result to the same normal
 * form `parseGltf` returns — world-space triangles welded with THIS repo's
 * own `weldTriangleSoup`, so both sides are directly comparable. */
async function oracle(bytes: Uint8Array): Promise<WeldedMesh> {
  const isGlb = bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === 0x46546c67;
  const input: string | ArrayBuffer = isGlb ? toArrayBuffer(bytes) : Buffer.from(bytes).toString("utf8");

  const gltf = await new Promise<any>((resolve, reject) => {
    new GLTFLoader().parse(input as any, "", resolve, reject);
  });
  gltf.scene.updateMatrixWorld(true);

  const soup: number[] = [];
  const vertex = new THREE.Vector3();
  gltf.scene.traverse((object: any) => {
    if (!object.isMesh) return;
    const geometry = object.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute("position");
    if (!position) return;
    const index = geometry.getIndex();
    const count = index ? index.count : position.count;
    for (let i = 0; i < count; i++) {
      const vi = index ? index.getX(i) : i;
      vertex.set(position.getX(vi), position.getY(vi), position.getZ(vi)).applyMatrix4(object.matrixWorld);
      soup.push(vertex.x, vertex.y, vertex.z);
    }
  });
  return weldTriangleSoup(new Float32Array(soup));
}

// --- comparison, invariant to what may LEGITIMATELY differ

const QUANT = 1e4;
function q(n: number): number {
  return Math.round(n * QUANT);
}

/**
 * A triangle multiset key: each triangle's three vertex positions, quantized
 * and sorted WITHIN the triangle, then the whole list sorted. Deliberately
 * blind to both vertex emission order and winding — three does not flip
 * winding for a mirrored node (it flips `material.side` at render time
 * instead), and neither loader guarantees primitive/node emission order.
 * Winding itself is asserted in the pure `gltfParser.test.ts`.
 */
function triangleKeys(mesh: WeldedMesh): string[] {
  const keys: string[] = [];
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    const corners: string[] = [];
    for (let c = 0; c < 3; c++) {
      const p = mesh.indices[t * 3 + c] * 3;
      corners.push(`${q(mesh.positions[p])},${q(mesh.positions[p + 1])},${q(mesh.positions[p + 2])}`);
    }
    keys.push(corners.sort().join("|"));
  }
  return keys.sort();
}

function all(mesh: WeldedMesh): number[] {
  return Array.from({ length: mesh.indices.length / 3 }, (_, i) => i);
}

async function expectMatchesOracle(bytes: Uint8Array): Promise<void> {
  const mine = parseGltf(bytes);
  const theirs = await oracle(bytes);

  // Without this the whole comparison could pass vacuously — two parsers that
  // both silently produced nothing would agree perfectly.
  expect(mine.indices.length).toBeGreaterThan(0);

  expect(mine.indices.length / 3).toBe(theirs.indices.length / 3);
  expect(triangleKeys(mine)).toEqual(triangleKeys(theirs));
  expect(connectedComponents(mine.indices).length).toBe(connectedComponents(theirs.indices).length);

  const mineAll = all(mine);
  const theirsAll = all(theirs);
  const volume = volumeOfTriangles(theirs.positions, theirs.indices, theirsAll);
  const area = areaOfTriangles(theirs.positions, theirs.indices, theirsAll);
  expect(volumeOfTriangles(mine.positions, mine.indices, mineAll)).toBeCloseTo(volume, 4);
  expect(areaOfTriangles(mine.positions, mine.indices, mineAll)).toBeCloseTo(area, 4);

  const mineBounds = boundsOfTriangles(mine.positions, mine.indices, mineAll);
  const theirsBounds = boundsOfTriangles(theirs.positions, theirs.indices, theirsAll);
  if (theirsBounds) {
    for (let axis = 0; axis < 3; axis++) {
      expect(mineBounds!.min[axis]).toBeCloseTo(theirsBounds.min[axis], 5);
      expect(mineBounds!.max[axis]).toBeCloseTo(theirsBounds.max[axis], 5);
    }
  }
}

// --- the fixture matrix (the same decision points gltfParser.test.ts covers)

const CUBE_VERTICES = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
const CUBE_FACES = [
  0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
  1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
];
function expand(vertices: number[], faces: number[]): number[] {
  const out: number[] = [];
  for (const i of faces) out.push(vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]);
  return out;
}

function base(nodes: any[], meshes: any[], accessors: any[], bufferViews: any[]): any {
  return { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i).filter((i) => nodes[i]?.__root !== false) }], nodes, meshes, accessors, bufferViews, buffers: [{}] };
}

function triangleFixture(nodePatch: any = {}): { doc: any; bin: Uint8Array } {
  const positions = f32([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = u16([0, 1, 2]);
  return {
    doc: base(
      [{ mesh: 0, ...nodePatch }],
      [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
      ],
      [
        { buffer: 0, byteOffset: 0, byteLength: positions.length },
        { buffer: 0, byteOffset: positions.length, byteLength: indices.length },
      ]
    ),
    bin: concat(positions, indices),
  };
}

const FIXTURES: Array<{ name: string; build: () => { doc: any; bin: Uint8Array } }> = [
  { name: "indexed triangle", build: () => triangleFixture() },
  {
    name: "non-indexed triangle",
    build: () => {
      const { doc, bin } = triangleFixture();
      delete doc.meshes[0].primitives[0].indices;
      return { doc, bin };
    },
  },
  { name: "node matrix", build: () => triangleFixture({ matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, -3, 2, 1] }) },
  {
    name: "node TRS",
    build: () => triangleFixture({ translation: [1, 2, 3], rotation: [0, 0, 0.3826834, 0.9238795], scale: [2, 2, 2] }),
  },
  {
    name: "mirrored node (winding differs, geometry must not)",
    build: () => triangleFixture({ scale: [-1, 1, 1] }),
  },
  {
    name: "nested parent/child transforms",
    build: () => {
      const { doc, bin } = triangleFixture();
      doc.nodes = [{ children: [1], translation: [10, 0, 0], rotation: [0.7071068, 0, 0, 0.7071068] }, { mesh: 0, translation: [5, 1, 0] }];
      doc.scenes = [{ nodes: [0] }];
      return { doc, bin };
    },
  },
  {
    name: "one mesh instanced by two nodes",
    build: () => {
      const { doc, bin } = triangleFixture();
      doc.nodes = [{ mesh: 0 }, { mesh: 0, translation: [100, 0, 0] }];
      doc.scenes = [{ nodes: [0, 1] }];
      return { doc, bin };
    },
  },
  {
    name: "interleaved byteStride",
    build: () => {
      const interleaved = f32([0, 0, 0, 9, 9, 9, 2, 0, 0, 9, 9, 9, 0, 2, 0, 9, 9, 9]);
      const indices = u16([0, 1, 2]);
      return {
        doc: base(
          [{ mesh: 0 }],
          [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
          [
            { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3" },
            { bufferView: 0, byteOffset: 12, componentType: 5126, count: 3, type: "VEC3" },
            { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
          ],
          [
            { buffer: 0, byteOffset: 0, byteLength: interleaved.length, byteStride: 24 },
            { buffer: 0, byteOffset: interleaved.length, byteLength: indices.length },
          ]
        ),
        bin: concat(interleaved, indices),
      };
    },
  },
  {
    name: "normalized SHORT positions",
    build: () => {
      const positions = i16([0, 0, 0, 32767, 0, 0, 0, 32767, 0]);
      const indices = u16([0, 1, 2]);
      return {
        doc: base(
          [{ mesh: 0 }],
          [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
          [
            { bufferView: 0, componentType: 5122, normalized: true, count: 3, type: "VEC3" },
            { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
          ],
          [
            { buffer: 0, byteOffset: 0, byteLength: positions.length },
            { buffer: 0, byteOffset: positions.length, byteLength: indices.length },
          ]
        ),
        bin: concat(positions, indices),
      };
    },
  },
  {
    name: "sparse accessor over a dense base",
    build: () => {
      const positions = f32([0, 0, 0, 1, 0, 0, 0, 0, 0]);
      const sparseIndices = u16([2]);
      const sparseValues = f32([0, 5, 0]);
      const indices = u16([0, 1, 2]);
      const offsets = [0, positions.length, positions.length + sparseIndices.length, positions.length + sparseIndices.length + sparseValues.length];
      return {
        doc: base(
          [{ mesh: 0 }],
          [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
          [
            {
              bufferView: 0, componentType: 5126, count: 3, type: "VEC3",
              sparse: { count: 1, indices: { bufferView: 1, componentType: 5123 }, values: { bufferView: 2 } },
            },
            { bufferView: 3, componentType: 5123, count: 3, type: "SCALAR" },
          ],
          [
            { buffer: 0, byteOffset: offsets[0], byteLength: positions.length },
            { buffer: 0, byteOffset: offsets[1], byteLength: sparseIndices.length },
            { buffer: 0, byteOffset: offsets[2], byteLength: sparseValues.length },
            { buffer: 0, byteOffset: offsets[3], byteLength: indices.length },
          ]
        ),
        bin: concat(positions, sparseIndices, sparseValues, indices),
      };
    },
  },
  {
    name: "cube split across two primitives (per-material export)",
    build: () => {
      const halfA = f32(expand(CUBE_VERTICES, CUBE_FACES.slice(0, 18)));
      const halfB = f32(expand(CUBE_VERTICES, CUBE_FACES.slice(18)));
      return {
        doc: base(
          [{ mesh: 0 }],
          [{ primitives: [{ attributes: { POSITION: 0 } }, { attributes: { POSITION: 1 } }] }],
          [
            { bufferView: 0, componentType: 5126, count: 18, type: "VEC3" },
            { bufferView: 1, componentType: 5126, count: 18, type: "VEC3" },
          ],
          [
            { buffer: 0, byteOffset: 0, byteLength: halfA.length },
            { buffer: 0, byteOffset: halfA.length, byteLength: halfB.length },
          ]
        ),
        bin: concat(halfA, halfB),
      };
    },
  },
  {
    name: "TRIANGLE_STRIP",
    build: () => {
      const positions = f32([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
      const indices = u16([0, 1, 2, 3]);
      return {
        doc: base(
          [{ mesh: 0 }],
          [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 5 }] }],
          [
            { bufferView: 0, componentType: 5126, count: 4, type: "VEC3" },
            { bufferView: 1, componentType: 5123, count: 4, type: "SCALAR" },
          ],
          [
            { buffer: 0, byteOffset: 0, byteLength: positions.length },
            { buffer: 0, byteOffset: positions.length, byteLength: indices.length },
          ]
        ),
        bin: concat(positions, indices),
      };
    },
  },
  {
    name: "TRIANGLE_FAN",
    build: () => {
      const positions = f32([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
      const indices = u16([0, 1, 2, 3]);
      return {
        doc: base(
          [{ mesh: 0 }],
          [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 6 }] }],
          [
            { bufferView: 0, componentType: 5126, count: 4, type: "VEC3" },
            { bufferView: 1, componentType: 5123, count: 4, type: "SCALAR" },
          ],
          [
            { buffer: 0, byteOffset: 0, byteLength: positions.length },
            { buffer: 0, byteOffset: positions.length, byteLength: indices.length },
          ]
        ),
        bin: concat(positions, indices),
      };
    },
  },
];

describe.each<Container>(["gltf", "glb"])("gltfParser vs three's GLTFLoader (%s)", (container) => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))("agrees on: %s", async (_name, fixture) => {
    const { doc, bin } = fixture.build();
    await expectMatchesOracle(encode(stripMaterials(doc), bin, container));
  });
});

describe("gltfParser vs three's GLTFLoader (real fixtures on disk)", () => {
  const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(__dirname, "..", "examples", "GLTF", name)));

  it.each(["cube.gltf", "cube.glb", "two-boxes.gltf"])("agrees on examples/GLTF/%s", async (name) => {
    await expectMatchesOracle(fixture(name));
  });

  it.each(["cube.gltf", "cube.glb"])("reports the analytically-known unit cube for %s", (name) => {
    const mesh = parseGltf(fixture(name));
    expect(mesh.positions.length / 3).toBe(8);
    expect(mesh.indices.length / 3).toBe(12);
    expect(connectedComponents(mesh.indices).length).toBe(1);
    expect(volumeOfTriangles(mesh.positions, mesh.indices, all(mesh))).toBeCloseTo(1, 6);
  });

  it("resolves two-boxes.gltf's node translations into two separate solids", () => {
    const mesh = parseGltf(fixture("two-boxes.gltf"));
    const components = connectedComponents(mesh.indices);
    expect(components.length).toBe(2);
    const centres = components
      .map((c) => boundsOfTriangles(mesh.positions, mesh.indices, c)!)
      .map((b) => (b.min[0] + b.max[0]) / 2)
      .sort((a, b) => a - b);
    expect(centres[0]).toBeCloseTo(-5, 5);
    expect(centres[1]).toBeCloseTo(5, 5);
  });
});
