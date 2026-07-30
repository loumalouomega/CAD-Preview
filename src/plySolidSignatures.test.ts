import { describe, it, expect } from "vitest";
import { extractPlySolidSignatures } from "./plySolidSignatures";

function boxPlyText(min: [number, number, number], max: [number, number, number]): string {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v: Array<[number, number, number]> = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  const header = [
    "ply",
    "format ascii 1.0",
    `element vertex ${v.length}`,
    "property float x",
    "property float y",
    "property float z",
    `element face ${faces.length}`,
    "property list uchar int vertex_indices",
    "end_header",
  ].join("\n");
  const body = v.map((p) => p.join(" ")).join("\n") + "\n" + faces.map((f) => `${f.length} ${f.join(" ")}`).join("\n") + "\n";
  return header + "\n" + body;
}

describe("extractPlySolidSignatures", () => {
  it("a single unit box: one signature, volume 1, centred bbox", () => {
    const bytes = new TextEncoder().encode(boxPlyText([0, 0, 0], [1, 1, 1]));
    const { signatures, diagonal } = extractPlySolidSignatures(bytes);
    expect(signatures).toHaveLength(1);
    expect(signatures[0].id).toBe("solid-0");
    expect(signatures[0].volume).toBeCloseTo(1, 4);
    expect(signatures[0].centre).toEqual([0.5, 0.5, 0.5]);
    expect(diagonal).toBeCloseTo(Math.sqrt(3), 5);
  });

  it("degrades gracefully (empty signatures) for a header with no face element", () => {
    const header = ["ply", "format ascii 1.0", "element vertex 0", "end_header", ""].join("\n");
    const { signatures, diagonal } = extractPlySolidSignatures(new TextEncoder().encode(header));
    expect(signatures).toEqual([]);
    expect(diagonal).toBe(0);
  });
});
