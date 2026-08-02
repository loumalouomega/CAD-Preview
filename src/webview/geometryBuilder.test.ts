import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { buildWorstElementsHighlight, buildColorFieldOverlay } from "./geometryBuilder";
import { valueToColor } from "./colorMap";

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

describe("buildColorFieldOverlay", () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]); // one triangle
  const encode = (arr: Float32Array) => Buffer.from(arr.buffer).toString("base64");

  it("builds a vertex-coloured mesh sharing the base positions", () => {
    const values = new Float32Array([0, 5, 10]); // one value per corner
    const overlay = buildColorFieldOverlay(positions, encode(values), 0, 10);

    expect(overlay).toBeInstanceOf(THREE.Group);
    const mesh = overlay.children[0] as THREE.Mesh;
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(mesh.userData.entityType).toBe("mesh"); // excluded from picking/parts-colouring
    expect(mesh.geometry.getAttribute("position").array).toEqual(positions);

    const material = mesh.material as THREE.MeshBasicMaterial;
    expect(material.vertexColors).toBe(true);
  });

  it("colours each corner via valueToColor(value, min, max), matching colorMap.ts exactly", () => {
    const values = new Float32Array([0, 5, 10]);
    const overlay = buildColorFieldOverlay(positions, encode(values), 0, 10);
    const mesh = overlay.children[0] as THREE.Mesh;
    const colors = mesh.geometry.getAttribute("color").array as Float32Array;

    for (let i = 0; i < 3; i++) {
      const [r, g, b] = valueToColor(values[i], 0, 10);
      expect(colors[i * 3]).toBeCloseTo(r, 5);
      expect(colors[i * 3 + 1]).toBeCloseTo(g, 5);
      expect(colors[i * 3 + 2]).toBeCloseTo(b, 5);
    }
  });

  it("does not mutate the caller's basePositions array (geometry gets its own copy)", () => {
    const original = positions.slice();
    const values = new Float32Array([0, 5, 10]);
    buildColorFieldOverlay(positions, encode(values), 0, 10);
    expect(positions).toEqual(original);
  });

  it("tolerates a values array shorter than the position count (defensive, never throws)", () => {
    const values = new Float32Array([0]); // only 1 of 3 corners
    expect(() => buildColorFieldOverlay(positions, encode(values), 0, 10)).not.toThrow();
  });
});
