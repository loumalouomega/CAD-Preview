import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { meshFromGeometry } from "./viewer";

// Verifies the real STL parsing pipeline on the example fixture (the network
// fetch in loadMeshFromUrl is exercised by the manual / integration tests).
describe("STL pipeline", () => {
  it("parses the example cube into a renderable mesh", () => {
    const path = fileURLToPath(new URL("../../examples/STL/cube.stl", import.meta.url));
    const data = readFileSync(path, "utf8");

    const geometry = new STLLoader().parse(data);
    const mesh = meshFromGeometry(geometry);

    const positions = mesh.geometry.getAttribute("position");
    expect(positions.count).toBe(36); // 12 triangles * 3 vertices
    expect(mesh.geometry.getAttribute("normal")).toBeDefined();

    const box = new THREE.Box3().setFromObject(mesh);
    expect(box.isEmpty()).toBe(false);
  });
});
