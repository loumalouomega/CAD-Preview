import { describe, it, expect } from "vitest";
import { extractStlSolidSignatures } from "./stlSolidSignatures";

/** Same self-verifying (cross-product/centroid-checked) box-soup builder as
 * `meshComponents.test.ts`, serialized to ASCII STL text (the simplest
 * format `parseStl` accepts) rather than a raw Float32Array. */
function boxStlText(min: [number, number, number], max: [number, number, number], name = "box"): string {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const center: [number, number, number] = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const corners: Record<string, [number, number, number]> = {
    "000": [x0, y0, z0], "100": [x1, y0, z0], "110": [x1, y1, z0], "010": [x0, y1, z0],
    "001": [x0, y0, z1], "101": [x1, y0, z1], "111": [x1, y1, z1], "011": [x0, y1, z1],
  };
  const faces: Array<[string, string, string, string]> = [
    ["000", "100", "110", "010"],
    ["001", "101", "111", "011"],
    ["000", "100", "101", "001"],
    ["010", "110", "111", "011"],
    ["000", "010", "011", "001"],
    ["100", "110", "111", "101"],
  ];
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let text = `solid ${name}\n`;
  const addTri = (a: number[], b: number[], c: number[]) => {
    const normal = cross(sub(b, a), sub(c, a));
    const faceCenter = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const outward = dot(normal, sub(faceCenter, center));
    const [p0, p1, p2] = outward >= 0 ? [a, b, c] : [a, c, b];
    text += `facet normal 0 0 0\nouter loop\n`;
    for (const p of [p0, p1, p2]) text += `vertex ${p[0]} ${p[1]} ${p[2]}\n`;
    text += `endloop\nendfacet\n`;
  };
  for (const [k0, k1, k2, k3] of faces) {
    const [a, b, c, d] = [corners[k0], corners[k1], corners[k2], corners[k3]];
    addTri(a, b, c);
    addTri(a, c, d);
  }
  text += `endsolid ${name}\n`;
  return text;
}

describe("extractStlSolidSignatures", () => {
  it("a single unit box: one signature, volume 1, centred bbox", () => {
    const bytes = new TextEncoder().encode(boxStlText([0, 0, 0], [1, 1, 1]));
    const { signatures, diagonal } = extractStlSolidSignatures(bytes);
    expect(signatures).toHaveLength(1);
    expect(signatures[0].id).toBe("solid-0");
    expect(signatures[0].volume).toBeCloseTo(1, 4);
    expect(signatures[0].centre).toEqual([0.5, 0.5, 0.5]);
    expect(diagonal).toBeCloseTo(Math.sqrt(3), 5);
  });

  it("two disjoint boxes: two signatures, deterministic ids, each with its own bbox/volume, whole-model diagonal spans both", () => {
    const textA = boxStlText([0, 0, 0], [1, 1, 1], "a");
    const textB = boxStlText([10, 0, 0], [12, 2, 2], "b"); // a 2x2x2 box, volume 8
    const bytes = new TextEncoder().encode(textA + textB);
    const { signatures, diagonal } = extractStlSolidSignatures(bytes);

    expect(signatures).toHaveLength(2);
    const vols = signatures.map((s) => s.volume).sort((a, b) => a - b);
    expect(vols[0]).toBeCloseTo(1, 4);
    expect(vols[1]).toBeCloseTo(8, 4);
    // Whole-model bbox spans x:[0,12], y:[0,2], z:[0,2] -> diagonal = sqrt(12^2+2^2+2^2)
    expect(diagonal).toBeCloseTo(Math.hypot(12, 2, 2), 4);
  });

  it("degrades gracefully (empty signatures) for unparseable/empty input, never throws", () => {
    const { signatures, diagonal } = extractStlSolidSignatures(new Uint8Array(0));
    expect(signatures).toEqual([]);
    expect(diagonal).toBe(0);
  });
});
