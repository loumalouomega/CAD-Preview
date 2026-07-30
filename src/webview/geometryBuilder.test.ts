import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { buildWorstElementsHighlight } from "./geometryBuilder";

/** Same base64 encoding convention `protocol.ts`'s `encodeBuffer` uses on the
 * host side, inlined here so this test stays self-contained. */
function encode(arr: Float32Array | Uint32Array): string {
  return Buffer.from(arr.buffer).toString("base64");
}

describe("buildWorstElementsHighlight", () => {
  it("returns null for an empty index buffer (nothing below threshold)", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const overlay = buildWorstElementsHighlight(encode(positions), encode(new Uint32Array(0)));
    expect(overlay).toBeNull();
  });

  it("builds a ghost mesh through the depth buffer for a non-empty selection", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint32Array([0, 1, 2]);
    const overlay = buildWorstElementsHighlight(encode(positions), encode(indices));

    expect(overlay).toBeInstanceOf(THREE.Group);
    const mesh = overlay!.children[0] as THREE.Mesh;
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(mesh.userData.entityType).toBe("mesh"); // excluded from picking/parts-colouring
    expect(mesh.geometry.getIndex()!.array).toEqual(indices);
    expect(mesh.geometry.getAttribute("position").array).toEqual(positions);

    const material = mesh.material as THREE.MeshBasicMaterial;
    // The actual fix for "invisible when interior": paints through occluding
    // geometry regardless of true 3D depth, same technique as the Hidden
    // Lines ghost-line overlay in viewer.ts.
    expect(material.depthTest).toBe(false);
    expect(material.depthWrite).toBe(false);
    expect(material.transparent).toBe(true);
  });
});
