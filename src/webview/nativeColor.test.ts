import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  applyNativeColor,
  cloneNativeColor,
  copyNativeColor,
  isNativeColor,
  markNativeColor,
  nativeBaseHex,
} from "./nativeColor";

const vertexColoured = () => {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true });
  markNativeColor(m);
  return m;
};

describe("nativeColor", () => {
  it("only reports materials that were marked", () => {
    expect(isNativeColor(new THREE.MeshStandardMaterial())).toBe(false);
    expect(isNativeColor(vertexColoured())).toBe(true);
    expect(isNativeColor(null)).toBe(false);
  });

  it("a Part colour replaces vertex colours instead of multiplying them", () => {
    const m = vertexColoured();
    applyNativeColor(m, 0xff8000);
    expect(m.vertexColors).toBe(false);
    expect(m.color.getHex()).toBe(new THREE.Color(0xff8000).getHex());
  });

  it("removing the Part colour restores the native look", () => {
    const m = vertexColoured();
    applyNativeColor(m, 0xff8000);
    applyNativeColor(m, undefined);
    expect(m.vertexColors).toBe(true);
    expect(m.color.getHex()).toBe(0xffffff);
  });

  it("restores a flat file colour and a diffuse map", () => {
    const tex = new THREE.Texture();
    const m = new THREE.MeshStandardMaterial({ color: 0x336699, map: tex });
    markNativeColor(m);
    applyNativeColor(m, 0x00ff00);
    expect(m.map).toBeNull();
    applyNativeColor(m, undefined);
    expect(m.map).toBe(tex);
    expect(m.color.getHex()).toBe(0x336699);
  });

  it("flags needsUpdate only when a shader-affecting flag flips", () => {
    const m = vertexColoured();
    const before = m.version;
    applyNativeColor(m, undefined); // already native: nothing flips
    expect(m.version).toBe(before);
    applyNativeColor(m, 0x123456); // vertexColors true → false
    expect(m.version).toBeGreaterThan(before);
    const mid = m.version;
    applyNativeColor(m, 0x654321); // colour change only
    expect(m.version).toBe(mid);
  });

  it("leaves an unmarked material alone", () => {
    const m = new THREE.MeshStandardMaterial({ color: 0x112233 });
    applyNativeColor(m, 0xffffff);
    expect(m.color.getHex()).toBe(0x112233);
  });

  it("nativeBaseHex is white when the colour comes from vertices or a texture", () => {
    expect(nativeBaseHex(vertexColoured())).toBe(0xffffff);
    const flat = new THREE.MeshStandardMaterial({ color: 0x336699 });
    markNativeColor(flat);
    expect(nativeBaseHex(flat)).toBe(0x336699);
    expect(nativeBaseHex(new THREE.MeshStandardMaterial())).toBe(0xffffff);
  });

  it("clones and copies carry the stash (a Material.clone() alone would lose it)", () => {
    const m = vertexColoured();
    expect(isNativeColor(m.clone())).toBe(false);
    const c = cloneNativeColor(m);
    expect(c).not.toBe(m);
    expect(isNativeColor(c)).toBe(true);
    applyNativeColor(c, 0x445566);
    applyNativeColor(c, undefined);
    expect(c.vertexColors).toBe(true);
    // an independent copy: repainting the clone never touches the original
    expect(m.vertexColors).toBe(true);
    const basic = new THREE.MeshBasicMaterial();
    copyNativeColor(m, basic);
    expect(isNativeColor(basic)).toBe(true);
  });
});
