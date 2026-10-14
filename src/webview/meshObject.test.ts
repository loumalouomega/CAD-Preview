import { describe, it, expect } from "vitest";
import * as THREE from "three";
import * as fs from "node:fs";
import * as path from "node:path";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { parseMeshObject, parseObjObject, tagMeshEntities, meshFromGeometry, convertColladaMaterials, applyDefaultMaterial } from "./meshObject";
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

describe("parseMeshObject", () => {
  it("throws for a format it has no loader for rather than returning undefined", () => {
    expect(() => parseMeshObject(new Uint8Array(4), "3mf" as unknown as "stl")).toThrow(/no loader for "3mf"/);
  });
});

describe("convertColladaMaterials", () => {
  const geo = () => new THREE.BoxGeometry(1, 1, 1);
  const mesh = (m: THREE.Material | THREE.Material[]) => new THREE.Mesh(geo(), m);
  const phong = (hex: number, name = "") => Object.assign(new THREE.MeshPhongMaterial({ color: hex }), { name });

  it("keeps a coloured file material as a native colour", () => {
    const g = new THREE.Group();
    g.add(mesh(phong(0xff0000, "red")));
    convertColladaMaterials(g);
    const m = (g.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(m.isMeshStandardMaterial).toBe(true);
    expect(m.color.getHex()).toBe(0xff0000);
    expect(isNativeColor(m)).toBe(true);
  });

  it("clears the loader's fallback and its invented plain-white default, so the palette look (and any Part colour) applies", () => {
    const fallback = Object.assign(new THREE.MeshBasicMaterial({ color: 0xff00ff }), { name: THREE.Loader.DEFAULT_MATERIAL_NAME });
    const g = new THREE.Group();
    g.add(mesh(fallback), mesh(new THREE.MeshPhongMaterial()));
    convertColladaMaterials(g);
    for (const c of g.children) expect((c as THREE.Mesh).material).toBeUndefined();
    applyDefaultMaterial(g);
    for (const c of g.children) {
      const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial;
      expect(m.color.getHex()).toBe(0xc0c4cc);
      expect(isNativeColor(m)).toBe(false);
    }
  });

  it("a NAMED white material is a real file colour and is kept (control for the white-default rule)", () => {
    const g = new THREE.Group();
    g.add(mesh(phong(0xffffff, "paper")));
    convertColladaMaterials(g);
    expect(isNativeColor((g.children[0] as THREE.Mesh).material as THREE.Material)).toBe(true);
  });

  it("keeps every slot of a multi-material mesh so group material indices stay valid", () => {
    const g = new THREE.Group();
    g.add(mesh([phong(0x00ff00, "green"), new THREE.MeshPhongMaterial()]));
    convertColladaMaterials(g);
    const mats = (g.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial[];
    expect(mats).toHaveLength(2);
    expect(isNativeColor(mats[0])).toBe(true);
    expect(mats[1].color.getHex()).toBe(0xc0c4cc);
    expect(isNativeColor(mats[1])).toBe(false);
  });
});
