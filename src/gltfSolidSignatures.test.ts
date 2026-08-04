import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractGltfSolidSignatures } from "./gltfSolidSignatures";

const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(__dirname, "..", "examples", "GLTF", name)));

describe("extractGltfSolidSignatures", () => {
  it.each(["cube.gltf", "cube.glb"])("a single unit cube (%s): one signature, volume 1", (name) => {
    const { signatures, diagonal } = extractGltfSolidSignatures(fixture(name));
    expect(signatures).toHaveLength(1);
    expect(signatures[0].id).toBe("solid-0");
    expect(signatures[0].volume).toBeCloseTo(1, 4);
    expect(signatures[0].centre[0]).toBeCloseTo(0, 6);
    expect(diagonal).toBeCloseTo(Math.sqrt(3), 5);
  });

  it("two instanced nodes resolve to two independent signatures", () => {
    const { signatures } = extractGltfSolidSignatures(fixture("two-boxes.gltf"));
    expect(signatures).toHaveLength(2);
    const centres = signatures.map((s) => s.centre[0]).sort((a, b) => a - b);
    expect(centres[0]).toBeCloseTo(-5, 5);
    expect(centres[1]).toBeCloseTo(5, 5);
    for (const signature of signatures) expect(signature.volume).toBeCloseTo(1, 4);
  });

  it("degrades gracefully (empty signatures) for a document with no meshes", () => {
    const empty = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, scenes: [{ nodes: [] }], scene: 0, nodes: [] }));
    const { signatures, diagonal } = extractGltfSolidSignatures(empty);
    expect(signatures).toEqual([]);
    expect(diagonal).toBe(0);
  });
});
