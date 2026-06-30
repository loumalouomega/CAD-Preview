import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { exportModel, arrayBufferToBase64 } from "./meshExporters";

// PLYExporter chunks its work through requestAnimationFrame, which only exists in a
// browser/webview — polyfill it so the (otherwise pure) PLY export path is testable
// in Node too.
(globalThis as { requestAnimationFrame?: (cb: () => void) => void }).requestAnimationFrame ??=
  (cb) => setTimeout(cb, 0);

function makeTriangleMesh(): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)
  );
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
}

// GLTFExporter's binary (.glb) path uses the browser-only FileReader/Blob APIs, so
// it isn't exercised here — covered by the manual F5 verification instead, same as
// the network-fetch path in meshLoaders.test.ts.
describe("exportModel", () => {
  it("exports STL as base64-encoded binary", async () => {
    const result = await exportModel(makeTriangleMesh(), "stl");
    expect(result.binary).toBe(true);
    const bytes = Uint8Array.from(Buffer.from(result.data, "base64"));
    expect(bytes.length).toBeGreaterThan(80); // header + at least one triangle
    expect(Buffer.from(bytes.slice(0, 5)).toString("ascii")).not.toBe("solid"); // binary, not ASCII
  });

  it("exports OBJ as text", async () => {
    const result = await exportModel(makeTriangleMesh(), "obj");
    expect(result.binary).toBe(false);
    expect(result.data).toContain("v 0 0 0");
  });

  it("exports PLY as ASCII text", async () => {
    const result = await exportModel(makeTriangleMesh(), "ply");
    expect(result.binary).toBe(false);
    expect(result.data).toContain("ply");
    expect(result.data).toContain("element vertex");
  });

  it("rejects unsupported formats", async () => {
    await expect(exportModel(makeTriangleMesh(), "step")).rejects.toThrow();
  });
});

describe("arrayBufferToBase64", () => {
  it("round-trips bytes through base64", () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255]);
    const encoded = arrayBufferToBase64(bytes.buffer);
    const decoded = Uint8Array.from(Buffer.from(encoded, "base64"));
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });
});
