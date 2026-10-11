import { describe, it, expect } from "vitest";
import * as THREE from "three";
import * as fs from "node:fs";
import * as path from "node:path";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { parseMeshObject, parseObjObject, tagMeshEntities, meshFromGeometry } from "./meshObject";
import { isNativeColor } from "./nativeColor";
import { objMaterialLibraries } from "./meshLoaders";

const EX = path.resolve(__dirname, "../../examples");
const text = (rel: string) => fs.readFileSync(path.join(EX, rel), "utf8");
const bytes = (rel: string) => new Uint8Array(fs.readFileSync(path.join(EX, rel)));

function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => { if (o instanceof THREE.Mesh) out.push(o); });
  return out;
}

function ids(root: THREE.Object3D): string[] {
  tagMeshEntities(root);
  const out: string[] = [];
  root.traverse((o) => out.push(o.userData.groupId as string));
  return out;
}

describe("PLY vertex colours", () => {
  it("a coloured PLY becomes a white vertex-coloured native material", () => {
    const [mesh] = meshes(parseMeshObject(bytes("PLY/colored-cube.ply"), "ply"));
    const mat = mesh.material as THREE.MeshStandardMaterial;
    expect(mesh.geometry.getAttribute("color")).toBeDefined();
    expect(mat.vertexColors).toBe(true);
    expect(mat.color.getHex()).toBe(0xffffff);
    expect(isNativeColor(mat)).toBe(true);
  });

  it("an uncoloured PLY keeps the palette material", () => {
    const [mesh] = meshes(parseMeshObject(bytes("PLY/cube.ply"), "ply"));
    const mat = mesh.material as THREE.MeshStandardMaterial;
    expect(mat.vertexColors).toBe(false);
    expect(isNativeColor(mat)).toBe(false);
  });

  it("meshFromGeometry marks only geometries that carry a colour attribute", () => {
    const plain = meshFromGeometry(new THREE.BoxGeometry(1, 1, 1));
    expect(isNativeColor(plain.material as THREE.Material)).toBe(false);
  });
});

describe("OBJ materials", () => {
  const creator = () => {
    const c = new MTLLoader().parse(text("OBJ/colored-cube.mtl"), "");
    c.preload();
    return c;
  };

  it("reads the mtllib names an OBJ declares", () => {
    expect(objMaterialLibraries(text("OBJ/colored-cube.obj"))).toEqual(["colored-cube.mtl"]);
    expect(objMaterialLibraries("v 0 0 0\n")).toEqual([]);
    expect(objMaterialLibraries("mtllib a.mtl b.mtl\r\nmtllib c.mtl\n")).toEqual(["a.mtl", "b.mtl", "c.mtl"]);
  });

  it("applies the .mtl diffuse colours as native standard materials", () => {
    const [mesh] = meshes(parseObjObject(text("OBJ/colored-cube.obj"), creator()));
    const mats = mesh.material as THREE.MeshStandardMaterial[];
    expect(Array.isArray(mats)).toBe(true);
    expect(mats.map((m) => m.name)).toEqual(["red", "blue"]);
    for (const m of mats) {
      expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
      expect(isNativeColor(m)).toBe(true);
      expect(m.transparent).toBe(false);
    }
    const [red, blue] = mats;
    expect(red.color.r).toBeGreaterThan(red.color.b);
    expect(blue.color.b).toBeGreaterThan(blue.color.r);
  });

  it("without a .mtl the materials stay un-native (today's behaviour)", () => {
    const [mesh] = meshes(parseObjObject(text("OBJ/colored-cube.obj")));
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      expect(isNativeColor(m)).toBe(false);
    }
  });

  it("the object hierarchy — and so every node-N id — is identical with and without the .mtl", () => {
    // The headless kernel-worker bake parses without materials; edit-op
    // targets must mean the same objects on both sides.
    const withMtl = ids(parseObjObject(text("OBJ/colored-cube.obj"), creator()));
    const without = ids(parseObjObject(text("OBJ/colored-cube.obj")));
    expect(withMtl).toEqual(without);
    expect(withMtl).toEqual(ids(parseMeshObject(bytes("OBJ/colored-cube.obj"), "obj")));
  });
});
