/**
 * Compressed glTF: the Draco and meshopt fixtures must parse to exactly the
 * mesh the uncompressed cube does. `examples/GLTF/cube-draco.glb` and
 * `cube-meshopt.glb` are generated from `cube.gltf` by
 * `scripts/gltf-fixtures/make-compressed.mjs`, so "the same mesh" is a real
 * claim: a decoder that dropped faces, reordered winding or lost a corner
 * would change the volume, the triangle multiset or the bounds.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { decodeGltfGeometry } from "./gltfDecode";
import { gltfCompression, listExternalBufferUris, parseGltf, resolveExternalBuffers, loadGltfDocument } from "./gltfParser";
import { boundsOfTriangles, connectedComponents, volumeOfTriangles, type WeldedMesh } from "./meshComponents";
import { inflateGltfDocument } from "./gltfInflate";
import { dracoKey, isDecodedKey, meshoptKey } from "./gltfDecodedKeys";

const ROOT = path.resolve(__dirname, "..");
const read = (name: string) => new Uint8Array(fs.readFileSync(path.join(ROOT, "examples", "GLTF", name)));

/** Position-quantized, winding- and order-invariant triangle keys. */
function triangleKeys(mesh: WeldedMesh): string[] {
  const q = (v: number) => Math.round(v * 1e4);
  const keys: string[] = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const corners = [0, 1, 2].map((c) => {
      const p = mesh.indices[t + c] * 3;
      return `${q(mesh.positions[p])},${q(mesh.positions[p + 1])},${q(mesh.positions[p + 2])}`;
    });
    keys.push(corners.sort().join("|"));
  }
  return keys.sort();
}

function facts(mesh: WeldedMesh) {
  const all = connectedComponents(mesh.indices).flat();
  return {
    triangles: mesh.indices.length / 3,
    volume: volumeOfTriangles(mesh.positions, mesh.indices, all),
    bounds: boundsOfTriangles(mesh.positions, mesh.indices, all),
    keys: triangleKeys(mesh),
  };
}

async function parseCompressed(name: string): Promise<WeldedMesh> {
  const bytes = read(name);
  const external = await resolveExternalBuffers(bytes, async () => undefined, (b, e) => decodeGltfGeometry(ROOT, b, e));
  return parseGltf(bytes, external);
}

const reference = facts(parseGltf(read("cube.glb")));

describe("compressed glTF fixtures", () => {
  it("are detected as compressed", () => {
    expect(gltfCompression(read("cube-draco.glb"))).toEqual({ draco: true, meshopt: false });
    expect(gltfCompression(read("cube-meshopt.glb"))).toEqual({ draco: false, meshopt: true });
    expect(gltfCompression(read("cube.glb"))).toEqual({ draco: false, meshopt: false });
  });

  it.each(["cube-draco.glb", "cube-meshopt.glb"])("%s decodes to the uncompressed cube", async (name) => {
    const got = facts(await parseCompressed(name));
    expect(got.triangles).toBe(12);
    expect(got.volume).toBeCloseTo(1, 5);
    expect(got.volume).toBeCloseTo(reference.volume, 6);
    expect(got.keys).toEqual(reference.keys);
    for (let axis = 0; axis < 3; axis++) {
      expect(got.bounds!.min[axis]).toBeCloseTo(-0.5, 5);
      expect(got.bounds!.max[axis]).toBeCloseTo(0.5, 5);
    }
  });

  it("an uncompressed file decodes to nothing and never loads a decoder", async () => {
    expect(await decodeGltfGeometry(ROOT, read("cube.glb"))).toEqual({});
  });

  it("writes only reserved decoded: keys, which can never be read from disk", async () => {
    const draco = await decodeGltfGeometry(ROOT, read("cube-draco.glb"));
    expect(Object.keys(draco).sort()).toEqual([dracoKey(0, 0, "indices"), dracoKey(0, 0, "positions")].sort());
    const meshopt = await decodeGltfGeometry(ROOT, read("cube-meshopt.glb"));
    expect(Object.keys(meshopt).sort()).toEqual([meshoptKey(0), meshoptKey(1)]);
    for (const key of [...Object.keys(draco), ...Object.keys(meshopt)]) expect(isDecodedKey(key)).toBe(true);
    // `listExternalBufferUris` reports only real sibling files.
    expect(listExternalBufferUris(read("cube-draco.glb"))).toEqual([]);
    expect(listExternalBufferUris(read("cube-meshopt.glb"))).toEqual([]);
  });

  it.each(["cube-draco.glb", "cube-meshopt.glb"])("%s is refused, naming the cause, when no decoded entries are supplied", (name) => {
    expect(() => parseGltf(read(name))).toThrow(/requires the .* extension.*decoded geometry was not supplied/s);
  });

  it("a Draco primitive that is NOT required and not decoded does not throw", () => {
    // An uncompressed fallback is legal when the extension is only "used", so
    // the parser reads the plain accessors instead of refusing the file. (This
    // fixture's accessors have no bufferView, i.e. they read as zeros.)
    const { json } = loadGltfDocument(read("cube-draco.glb"));
    delete json.extensionsRequired;
    expect(() => parseGltf(new TextEncoder().encode(JSON.stringify(json)))).not.toThrow();
  });
});

describe("inflateGltfDocument", () => {
  it.each(["cube-draco.glb", "cube-meshopt.glb"])("%s becomes a plain glTF that parseGltf reads without decoded entries", async (name) => {
    const bytes = read(name);
    const decoded = await decodeGltfGeometry(ROOT, bytes);
    const { json } = loadGltfDocument(bytes);
    expect(inflateGltfDocument(json, decoded)).toBe(true);
    expect(json.extensionsRequired).toBeUndefined();
    expect(JSON.stringify(json)).not.toMatch(/KHR_draco_mesh_compression|EXT_meshopt_compression/);
    const inflated = new TextEncoder().encode(JSON.stringify(json));
    expect(facts(parseGltf(inflated)).keys).toEqual(reference.keys);
  });

  it("leaves a compressed element with no decoded entry untouched", () => {
    const { json } = loadGltfDocument(read("cube-draco.glb"));
    expect(inflateGltfDocument(json, {})).toBe(false);
    expect(json.extensionsRequired).toEqual(["KHR_draco_mesh_compression"]);
  });
});
