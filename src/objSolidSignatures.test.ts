import { describe, it, expect } from "vitest";
import { extractObjSolidSignatures } from "./objSolidSignatures";

/** A quad-faced box OBJ, matching `stlSolidSignatures.test.ts`'s box-STL
 * builder in spirit — winding doesn't matter here since `volumeOfTriangles`
 * takes the absolute value, so this stays simple (no cross-product check). */
function boxObjText(min: [number, number, number], max: [number, number, number]): string {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v: Array<[number, number, number]> = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  let text = v.map(([x, y, z]) => `v ${x} ${y} ${z}`).join("\n") + "\n";
  const faces = [
    [1, 4, 3, 2],
    [5, 6, 7, 8],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 4, 8, 7],
    [4, 1, 5, 8],
  ];
  text += faces.map((f) => `f ${f.join(" ")}`).join("\n") + "\n";
  return text;
}

describe("extractObjSolidSignatures", () => {
  it("a single unit box: one signature, volume 1, centred bbox", () => {
    const bytes = new TextEncoder().encode(boxObjText([0, 0, 0], [1, 1, 1]));
    const { signatures, diagonal } = extractObjSolidSignatures(bytes);
    expect(signatures).toHaveLength(1);
    expect(signatures[0].id).toBe("solid-0");
    expect(signatures[0].volume).toBeCloseTo(1, 4);
    expect(signatures[0].centre).toEqual([0.5, 0.5, 0.5]);
    expect(diagonal).toBeCloseTo(Math.sqrt(3), 5);
  });

  it("two disjoint boxes in one file: two signatures with independent vertex indexing", () => {
    const a = boxObjText([0, 0, 0], [1, 1, 1]);
    // Second box's `v`/`f` lines must offset their vertex indices by the
    // first box's 8 vertices — real multi-object OBJ exporters always do
    // this (one shared, monotonically-increasing vertex list per file).
    const bBase = boxObjText([10, 0, 0], [12, 2, 2]); // 2x2x2, volume 8
    const bOffset = bBase.replace(/f (\d+) (\d+) (\d+) (\d+)/g, (_m, w, x, y, z) =>
      `f ${Number(w) + 8} ${Number(x) + 8} ${Number(y) + 8} ${Number(z) + 8}`
    );
    const bytes = new TextEncoder().encode(a + bOffset);
    const { signatures, diagonal } = extractObjSolidSignatures(bytes);

    expect(signatures).toHaveLength(2);
    const vols = signatures.map((s) => s.volume).sort((x, y) => x - y);
    expect(vols[0]).toBeCloseTo(1, 4);
    expect(vols[1]).toBeCloseTo(8, 4);
    expect(diagonal).toBeCloseTo(Math.hypot(12, 2, 2), 4);
  });

  it("degrades gracefully (empty signatures) for content with no faces, never throws", () => {
    const { signatures, diagonal } = extractObjSolidSignatures(new TextEncoder().encode("# just a comment\n"));
    expect(signatures).toEqual([]);
    expect(diagonal).toBe(0);
  });
});
