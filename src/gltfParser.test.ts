import { describe, it, expect } from "vitest";
import { parseGltf, listExternalBufferUris, resolveExternalBuffers } from "./gltfParser";
import { connectedComponents, volumeOfTriangles, boundsOfTriangles } from "./meshComponents";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Fixture builders — every fixture is emitted in BOTH containers (a `.gltf`
// with a base64 `data:` buffer and a real binary `.glb`), so the whole matrix
// below runs twice through `it.each` and GLB coverage costs nothing extra.

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
function u8(values: number[]): Uint8Array {
  return new Uint8Array(values);
}
function u16(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setUint16(i * 2, v, true));
  return out;
}
function u32(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setUint32(i * 4, v, true));
  return out;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function buildGlb(jsonText: string, bin: Uint8Array): Uint8Array {
  const jsonBytes = new TextEncoder().encode(jsonText);
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const jsonChunk = concat(jsonBytes, new Uint8Array(jsonPad).fill(0x20));
  const binChunk = concat(bin, new Uint8Array(binPad));
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

export type Container = "gltf" | "glb";

/** Encodes a document + its single binary buffer as either container. */
function encode(doc: any, bin: Uint8Array, container: Container): Uint8Array {
  const clone = JSON.parse(JSON.stringify(doc));
  if (Array.isArray(clone.buffers) && clone.buffers.length > 0) {
    clone.buffers[0] =
      container === "gltf"
        ? { byteLength: bin.length, uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString("base64")}` }
        : { byteLength: bin.length };
  }
  if (container === "glb") return buildGlb(JSON.stringify(clone), bin);
  return new TextEncoder().encode(JSON.stringify(clone));
}

const CONTAINERS: Container[] = ["gltf", "glb"];

/** A unit cube at the origin corner — volume exactly 1, 8 shared vertices. */
const CUBE_VERTICES = [
  0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
  0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
];
const CUBE_FACES = [
  0, 3, 2, 0, 2, 1, // z = 0
  4, 5, 6, 4, 6, 7, // z = 1
  0, 1, 5, 0, 5, 4, // y = 0
  1, 2, 6, 1, 6, 5, // x = 1
  2, 3, 7, 2, 7, 6, // y = 1
  3, 0, 4, 3, 4, 7, // x = 0
];

/** Expands indexed vertices into an unindexed position list, the way a real
 * exporter's per-material primitive split does (duplicating seam vertices). */
function expand(vertices: number[], faces: number[]): number[] {
  const out: number[] = [];
  for (const index of faces) out.push(vertices[index * 3], vertices[index * 3 + 1], vertices[index * 3 + 2]);
  return out;
}

/** The simplest valid document: one indexed triangle. */
function triangleDoc(): { doc: any; bin: Uint8Array } {
  const positions = f32([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = u16([0, 1, 2]);
  return {
    doc: {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.length },
        { buffer: 0, byteOffset: positions.length, byteLength: indices.length },
      ],
      buffers: [{}],
    },
    bin: concat(positions, indices),
  };
}

function triangleCount(mesh: { indices: Uint32Array }): number {
  return mesh.indices.length / 3;
}
function allTriangles(mesh: { indices: Uint32Array }): number[] {
  return Array.from({ length: mesh.indices.length / 3 }, (_, i) => i);
}

// ---------------------------------------------------------------------------

describe.each(CONTAINERS)("parseGltf (%s container)", (container) => {
  it("parses a minimal indexed triangle", () => {
    const { doc, bin } = triangleDoc();
    const mesh = parseGltf(encode(doc, bin, container));
    expect(triangleCount(mesh)).toBe(1);
    expect(mesh.positions.length / 3).toBe(3);
  });

  it("parses a non-indexed primitive", () => {
    const { doc, bin } = triangleDoc();
    delete doc.meshes[0].primitives[0].indices;
    expect(triangleCount(parseGltf(encode(doc, bin, container)))).toBe(1);
  });

  it.each([
    ["uint8", 5121, u8([0, 1, 2])],
    ["uint16", 5123, u16([0, 1, 2])],
    ["uint32", 5125, u32([0, 1, 2])],
  ])("reads %s indices", (_label, componentType, indexBytes) => {
    const positions = f32([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const doc = {
      asset: { version: "2.0" },
      scenes: [{ nodes: [0] }],
      scene: 0,
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 1, componentType, count: 3, type: "SCALAR" },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.length },
        { buffer: 0, byteOffset: positions.length, byteLength: indexBytes.length },
      ],
      buffers: [{}],
    };
    expect(triangleCount(parseGltf(encode(doc, concat(positions, indexBytes), container)))).toBe(1);
  });

  it("honours bufferView.byteStride for an interleaved POSITION/NORMAL buffer", () => {
    // Six floats per vertex: xyz then a normal that must be stepped over.
    const interleaved = f32([
      0, 0, 0, 9, 9, 9,
      2, 0, 0, 9, 9, 9,
      0, 2, 0, 9, 9, 9,
    ]);
    const indices = u16([0, 1, 2]);
    const doc = {
      asset: { version: "2.0" },
      scenes: [{ nodes: [0] }],
      scene: 0,
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
      accessors: [
        { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 0, byteOffset: 12, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: interleaved.length, byteStride: 24 },
        { buffer: 0, byteOffset: interleaved.length, byteLength: indices.length },
      ],
      buffers: [{}],
    };
    const mesh = parseGltf(encode(doc, concat(interleaved, indices), container));
    const bounds = boundsOfTriangles(mesh.positions, mesh.indices, allTriangles(mesh))!;
    // The stray 9s would blow the bounds wide open if the stride were ignored.
    expect(bounds.max).toEqual([2, 2, 0]);
  });

  it("decodes correctly when the whole file sits at a non-4-byte-aligned offset", () => {
    // Node's fs.readFileSync returns a POOLED Buffer whose byteOffset is
    // arbitrary, so a Float32Array view over buffer+offset would throw. This
    // fixture locks in the DataView-only reads.
    const { doc, bin } = triangleDoc();
    const flat = encode(doc, bin, container);
    const shifted = new Uint8Array(new ArrayBuffer(flat.length + 1), 1, flat.length);
    shifted.set(flat);
    expect(shifted.byteOffset % 4).not.toBe(0);
    expect(triangleCount(parseGltf(shifted))).toBe(1);
  });

  it("applies the normalized-integer mapping to quantized positions", () => {
    const positions = i16([0, 0, 0, 32767, 0, 0, 0, 32767, 0]);
    const indices = u16([0, 1, 2]);
    const doc = {
      asset: { version: "2.0" },
      extensionsUsed: ["KHR_mesh_quantization"],
      scenes: [{ nodes: [0] }],
      scene: 0,
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      accessors: [
        { bufferView: 0, componentType: 5122, normalized: true, count: 3, type: "VEC3" },
        { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.length },
        { buffer: 0, byteOffset: positions.length, byteLength: indices.length },
      ],
      buffers: [{}],
    };
    const mesh = parseGltf(encode(doc, concat(positions, indices), container));
    const bounds = boundsOfTriangles(mesh.positions, mesh.indices, allTriangles(mesh))!;
    expect(bounds.max[0]).toBeCloseTo(1, 5);
    expect(bounds.max[1]).toBeCloseTo(1, 5);
  });

  it("applies a sparse accessor over a dense base", () => {
    const positions = f32([0, 0, 0, 1, 0, 0, 0, 0, 0]);
    const sparseIndices = u16([2]);
    const sparseValues = f32([0, 5, 0]);
    const indices = u16([0, 1, 2]);
    const bin = concat(positions, sparseIndices, sparseValues, indices);
    const doc = {
      asset: { version: "2.0" },
      scenes: [{ nodes: [0] }],
      scene: 0,
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      accessors: [
        {
          bufferView: 0, componentType: 5126, count: 3, type: "VEC3",
          sparse: { count: 1, indices: { bufferView: 1, componentType: 5123 }, values: { bufferView: 2 } },
        },
        { bufferView: 3, componentType: 5123, count: 3, type: "SCALAR" },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.length },
        { buffer: 0, byteOffset: positions.length, byteLength: sparseIndices.length },
        { buffer: 0, byteOffset: positions.length + sparseIndices.length, byteLength: sparseValues.length },
        { buffer: 0, byteOffset: positions.length + sparseIndices.length + sparseValues.length, byteLength: indices.length },
      ],
      buffers: [{}],
    };
    const mesh = parseGltf(encode(doc, bin, container));
    const bounds = boundsOfTriangles(mesh.positions, mesh.indices, allTriangles(mesh))!;
    expect(bounds.max[1]).toBeCloseTo(5, 5);
  });

  it("applies a sparse accessor with no base bufferView (all-zero base)", () => {
    const sparseIndices = u16([1, 2]);
    const sparseValues = f32([3, 0, 0, 0, 3, 0]);
    const indices = u16([0, 1, 2]);
    const bin = concat(sparseIndices, sparseValues, indices);
    const doc = {
      asset: { version: "2.0" },
      scenes: [{ nodes: [0] }],
      scene: 0,
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      accessors: [
        {
          componentType: 5126, count: 3, type: "VEC3",
          sparse: { count: 2, indices: { bufferView: 0, componentType: 5123 }, values: { bufferView: 1 } },
        },
        { bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: sparseIndices.length },
        { buffer: 0, byteOffset: sparseIndices.length, byteLength: sparseValues.length },
        { buffer: 0, byteOffset: sparseIndices.length + sparseValues.length, byteLength: indices.length },
      ],
      buffers: [{}],
    };
    const mesh = parseGltf(encode(doc, bin, container));
    const bounds = boundsOfTriangles(mesh.positions, mesh.indices, allTriangles(mesh))!;
    expect(bounds.min).toEqual([0, 0, 0]);
    expect(bounds.max).toEqual([3, 3, 0]);
  });

  it("applies a node matrix", () => {
    const { doc, bin } = triangleDoc();
    doc.nodes[0].matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1];
    const mesh = parseGltf(encode(doc, bin, container));
    const bounds = boundsOfTriangles(mesh.positions, mesh.indices, allTriangles(mesh))!;
    expect(bounds.min[0]).toBeCloseTo(10, 5);
  });

  it("applies node translation/rotation/scale", () => {
    const { doc, bin } = triangleDoc();
    doc.nodes[0].translation = [0, 0, 4];
    doc.nodes[0].scale = [2, 2, 2];
    const mesh = parseGltf(encode(doc, bin, container));
    const bounds = boundsOfTriangles(mesh.positions, mesh.indices, allTriangles(mesh))!;
    expect(bounds.max[0]).toBeCloseTo(2, 5);
    expect(bounds.min[2]).toBeCloseTo(4, 5);
  });

  it("composes nested parent/child transforms", () => {
    const { doc, bin } = triangleDoc();
    doc.nodes = [
      { children: [1], translation: [10, 0, 0] },
      { mesh: 0, translation: [5, 0, 0] },
    ];
    doc.scenes = [{ nodes: [0] }];
    const mesh = parseGltf(encode(doc, bin, container));
    const bounds = boundsOfTriangles(mesh.positions, mesh.indices, allTriangles(mesh))!;
    expect(bounds.min[0]).toBeCloseTo(15, 5);
  });

  it("flips triangle winding for a mirrored node", () => {
    const { doc, bin } = triangleDoc();
    const upright = parseGltf(encode(doc, bin, container));
    doc.nodes[0].scale = [-1, 1, 1];
    const mirrored = parseGltf(encode(doc, bin, container));
    // Same triangle count, but the index order is reversed relative to the
    // vertex positions — checked via the raw winding of the single triangle.
    expect(triangleCount(mirrored)).toBe(1);
    const windingOf = (m: { positions: Float32Array; indices: Uint32Array }) => {
      const p = (i: number) => [m.positions[m.indices[i] * 3], m.positions[m.indices[i] * 3 + 1]];
      const [ax, ay] = p(0), [bx, by] = p(1), [cx, cy] = p(2);
      return Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
    };
    // Mirroring X alone would flip the signed area; the winding flip cancels it.
    expect(windingOf(mirrored)).toBe(windingOf(upright));
  });

  it("emits one instance per node referencing the same mesh", () => {
    const { doc, bin } = triangleDoc();
    doc.nodes = [{ mesh: 0 }, { mesh: 0, translation: [100, 0, 0] }];
    doc.scenes = [{ nodes: [0, 1] }];
    const mesh = parseGltf(encode(doc, bin, container));
    expect(triangleCount(mesh)).toBe(2);
    expect(connectedComponents(mesh.indices).length).toBe(2);
  });

  it("welds a cube split across two primitives into one solid", () => {
    // The per-material split every real exporter produces: two primitives,
    // each with its OWN positions, duplicating the vertices along the seam.
    const halfA = f32(expand(CUBE_VERTICES, CUBE_FACES.slice(0, 18)));
    const halfB = f32(expand(CUBE_VERTICES, CUBE_FACES.slice(18)));
    const doc = {
      asset: { version: "2.0" },
      scenes: [{ nodes: [0] }],
      scene: 0,
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }, { attributes: { POSITION: 1 } }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 18, type: "VEC3" },
        { bufferView: 1, componentType: 5126, count: 18, type: "VEC3" },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: halfA.length },
        { buffer: 0, byteOffset: halfA.length, byteLength: halfB.length },
      ],
      buffers: [{}],
    };
    const mesh = parseGltf(encode(doc, concat(halfA, halfB), container));
    expect(triangleCount(mesh)).toBe(12);
    expect(mesh.positions.length / 3).toBe(8); // welded back down to 8 corners
    expect(connectedComponents(mesh.indices).length).toBe(1);
    expect(volumeOfTriangles(mesh.positions, mesh.indices, allTriangles(mesh))).toBeCloseTo(1, 6);
  });

  it("triangulates TRIANGLE_STRIP and TRIANGLE_FAN, and skips point/line modes", () => {
    const positions = f32([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
    const indices = u16([0, 1, 2, 3]);
    const make = (mode: number) => ({
      asset: { version: "2.0" },
      scenes: [{ nodes: [0] }],
      scene: 0,
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 4, type: "VEC3" },
        { bufferView: 1, componentType: 5123, count: 4, type: "SCALAR" },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.length },
        { buffer: 0, byteOffset: positions.length, byteLength: indices.length },
      ],
      buffers: [{}],
    });
    const bin = concat(positions, indices);
    expect(triangleCount(parseGltf(encode(make(5), bin, container)))).toBe(2); // strip
    expect(triangleCount(parseGltf(encode(make(6), bin, container)))).toBe(2); // fan
    expect(triangleCount(parseGltf(encode(make(0), bin, container)))).toBe(0); // points
    expect(triangleCount(parseGltf(encode(make(1), bin, container)))).toBe(0); // lines
  });

  it("terminates on a cyclic node graph", () => {
    const { doc, bin } = triangleDoc();
    doc.nodes = [{ mesh: 0, children: [1] }, { children: [0] }];
    doc.scenes = [{ nodes: [0] }];
    expect(triangleCount(parseGltf(encode(doc, bin, container)))).toBe(1);
  });

  it("returns an empty mesh for a document with no meshes", () => {
    const doc = { asset: { version: "2.0" }, scenes: [{ nodes: [] }], scene: 0, nodes: [], buffers: [] as any[] };
    const mesh = parseGltf(encode(doc, new Uint8Array(0), container));
    expect(mesh.positions.length).toBe(0);
    expect(mesh.indices.length).toBe(0);
  });
});

describe("parseGltf extension gating", () => {
  it("throws for a required Draco extension, naming it", () => {
    const { doc, bin } = triangleDoc();
    doc.extensionsRequired = ["KHR_draco_mesh_compression"];
    expect(() => parseGltf(encode(doc, bin, "gltf"))).toThrow(/KHR_draco_mesh_compression/);
  });

  it("throws for a required meshopt extension", () => {
    const { doc, bin } = triangleDoc();
    doc.extensionsRequired = ["EXT_meshopt_compression"];
    expect(() => parseGltf(encode(doc, bin, "gltf"))).toThrow(/EXT_meshopt_compression/);
  });

  it("throws when a primitive itself carries a compression extension", () => {
    const { doc, bin } = triangleDoc();
    doc.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: { bufferView: 0, attributes: {} } };
    expect(() => parseGltf(encode(doc, bin, "gltf"))).toThrow(/KHR_draco_mesh_compression/);
  });

  it("does NOT throw for geometry-irrelevant required extensions", () => {
    const { doc, bin } = triangleDoc();
    doc.extensionsRequired = ["KHR_materials_unlit", "KHR_texture_transform"];
    expect(triangleCount(parseGltf(encode(doc, bin, "gltf")))).toBe(1);
  });
});

describe("external buffers", () => {
  function externalDoc(): { doc: any; bin: Uint8Array } {
    const { doc, bin } = triangleDoc();
    doc.buffers = [{ byteLength: bin.length, uri: "scene.bin" }];
    return { doc, bin };
  }
  // The `encode` helper rewrites buffers[0]; these fixtures bypass it.
  const asGltf = (doc: any) => new TextEncoder().encode(JSON.stringify(doc));

  it("lists external buffer URIs", () => {
    const { doc } = externalDoc();
    expect(listExternalBufferUris(asGltf(doc))).toEqual(["scene.bin"]);
  });

  it("does not list embedded data: buffers", () => {
    const { doc, bin } = triangleDoc();
    expect(listExternalBufferUris(encode(doc, bin, "gltf"))).toEqual([]);
  });

  it("throws, naming the URI, when a needed external buffer was not supplied", () => {
    const { doc } = externalDoc();
    expect(() => parseGltf(asGltf(doc))).toThrow(/scene\.bin/);
  });

  it("parses once the external buffer is supplied", () => {
    const { doc, bin } = externalDoc();
    expect(triangleCount(parseGltf(asGltf(doc), { "scene.bin": bin }))).toBe(1);
  });

  it("refuses to read unsafe URIs and never calls the reader for them", async () => {
    const doc: any = {
      asset: { version: "2.0" },
      buffers: [
        { uri: "../secret.bin" },
        { uri: "/etc/passwd" },
        { uri: "https://evil.example/x.bin" },
        { uri: "sub/ok.bin" },
      ],
    };
    const asked: string[] = [];
    const resolved = await resolveExternalBuffers(asGltf(doc), async (uri) => {
      asked.push(uri);
      return new Uint8Array([1]);
    });
    expect(asked).toEqual(["sub/ok.bin"]);
    expect(Object.keys(resolved)).toEqual(["sub/ok.bin"]);
  });

  it("refuses a URI-encoded traversal", async () => {
    const doc: any = { asset: { version: "2.0" }, buffers: [{ uri: "%2e%2e/secret.bin" }] };
    const asked: string[] = [];
    await resolveExternalBuffers(asGltf(doc), async (uri) => {
      asked.push(uri);
      return undefined;
    });
    expect(asked).toEqual([]);
  });
});

describe("parseGltf rejection of non-glTF content", () => {
  it("throws for arbitrary bytes", () => {
    expect(() => parseGltf(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(/Not a glTF file/);
  });

  it("throws for JSON with no asset property", () => {
    expect(() => parseGltf(new TextEncoder().encode("{}"))).toThrow(/Not a glTF file/);
  });

  it("throws for a GLB with an unsupported version", () => {
    const glb = buildGlb(JSON.stringify({ asset: { version: "2.0" } }), new Uint8Array(0));
    new DataView(glb.buffer).setUint32(4, 1, true);
    expect(() => parseGltf(glb)).toThrow(/GLB version/);
  });

  it("throws for a GLB whose chunk runs past the end of the file", () => {
    const glb = buildGlb(JSON.stringify({ asset: { version: "2.0" } }), new Uint8Array(0));
    new DataView(glb.buffer).setUint32(12, 10_000, true);
    expect(() => parseGltf(glb)).toThrow(/Malformed GLB/);
  });
});
