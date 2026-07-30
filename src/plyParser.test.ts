import { describe, it, expect } from "vitest";
import { parsePly } from "./plyParser";
import { connectedComponents, volumeOfTriangles, boundsCenter, boundsOfTriangles } from "./meshComponents";

const UNIT_CUBE_VERTICES: Array<[number, number, number]> = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
const UNIT_CUBE_QUAD_FACES = [
  [0, 3, 2, 1],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [1, 2, 6, 5],
  [2, 3, 7, 6],
  [3, 0, 4, 7],
];

function asciiPlyCube(): Uint8Array {
  const header = [
    "ply",
    "format ascii 1.0",
    "comment made by objParser.test.ts",
    `element vertex ${UNIT_CUBE_VERTICES.length}`,
    "property float x",
    "property float y",
    "property float z",
    `element face ${UNIT_CUBE_QUAD_FACES.length}`,
    "property list uchar int vertex_indices",
    "end_header",
  ].join("\n");
  const body =
    UNIT_CUBE_VERTICES.map((v) => v.join(" ")).join("\n") +
    "\n" +
    UNIT_CUBE_QUAD_FACES.map((f) => `${f.length} ${f.join(" ")}`).join("\n") +
    "\n";
  return new TextEncoder().encode(header + "\n" + body);
}

/** Builds a real binary PLY (either endianness) with EXTRA per-vertex
 * properties (nx/ny/nz) interleaved before the position triple in file
 * order but declared AFTER x/y/z, exercising the "skip unknown properties
 * without losing byte alignment" path. */
function binaryPlyCube(little: boolean): Uint8Array {
  const header =
    `ply\nformat ${little ? "binary_little_endian" : "binary_big_endian"} 1.0\n` +
    `element vertex ${UNIT_CUBE_VERTICES.length}\n` +
    "property float x\nproperty float y\nproperty float z\n" +
    "property float nx\nproperty float ny\nproperty float nz\n" +
    `element face ${UNIT_CUBE_QUAD_FACES.length}\n` +
    "property list uchar int vertex_indices\n" +
    "end_header\n";
  const headerBytes = Buffer.from(header, "ascii");

  const vertexBytes = UNIT_CUBE_VERTICES.length * 6 * 4;
  const faceBytes = UNIT_CUBE_QUAD_FACES.reduce((n, f) => n + 1 + f.length * 4, 0);
  const body = Buffer.alloc(vertexBytes + faceBytes);
  let offset = 0;
  for (const [x, y, z] of UNIT_CUBE_VERTICES) {
    const record = [x, y, z, 0, 0, 1]; // fake normal, discarded by the parser
    for (const val of record) {
      little ? body.writeFloatLE(val, offset) : body.writeFloatBE(val, offset);
      offset += 4;
    }
  }
  for (const f of UNIT_CUBE_QUAD_FACES) {
    body.writeUInt8(f.length, offset);
    offset += 1;
    for (const idx of f) {
      little ? body.writeInt32LE(idx, offset) : body.writeInt32BE(idx, offset);
      offset += 4;
    }
  }
  return new Uint8Array(Buffer.concat([headerBytes, body]));
}

describe("parsePly", () => {
  it("parses an ASCII PLY: 8 vertices, 6 quad faces fan-triangulated into 12", () => {
    const { positions, indices } = parsePly(asciiPlyCube());
    expect(positions.length / 3).toBe(8);
    expect(indices.length / 3).toBe(12);
  });

  it("an ASCII cube resolves to one closed component with volume 1", () => {
    const { positions, indices } = parsePly(asciiPlyCube());
    const components = connectedComponents(indices);
    expect(components).toHaveLength(1);
    expect(volumeOfTriangles(positions, indices, components[0])).toBeCloseTo(1, 5);
    expect(boundsCenter(boundsOfTriangles(positions, indices, components[0])!)).toEqual([0.5, 0.5, 0.5]);
  });

  it("parses binary_little_endian, correctly skipping the extra nx/ny/nz properties", () => {
    const { positions, indices } = parsePly(binaryPlyCube(true));
    expect(positions.length / 3).toBe(8);
    expect(indices.length / 3).toBe(12);
    const components = connectedComponents(indices);
    expect(volumeOfTriangles(positions, indices, components[0])).toBeCloseTo(1, 5);
  });

  it("parses binary_big_endian identically", () => {
    const { positions, indices } = parsePly(binaryPlyCube(false));
    expect(positions.length / 3).toBe(8);
    const components = connectedComponents(indices);
    expect(volumeOfTriangles(positions, indices, components[0])).toBeCloseTo(1, 5);
  });

  it("little-endian and big-endian encodings of the same geometry parse to the same positions", () => {
    const le = parsePly(binaryPlyCube(true));
    const be = parsePly(binaryPlyCube(false));
    expect(Array.from(le.positions)).toEqual(Array.from(be.positions));
  });

  it("throws a clear error when the header has no end_header", () => {
    expect(() => parsePly(new TextEncoder().encode("not a ply file"))).toThrow(/end_header/);
  });

  it("degrades gracefully on a truncated binary body (never throws, returns what it could parse)", () => {
    const full = binaryPlyCube(true);
    const truncated = full.slice(0, full.length - 10); // cut off mid-face-data
    const { positions } = parsePly(truncated);
    expect(positions.length / 3).toBe(8); // all vertices were before the cut
  });
});
