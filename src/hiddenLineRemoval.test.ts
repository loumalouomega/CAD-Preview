import { describe, expect, it } from "vitest";
import { hiddenLineDrawing, type ScreenBasis, type Segment2 } from "./hiddenLineRemoval";
import { weldTriangleSoup } from "./meshComponents";
import { viewBasis } from "./svgSilhouette";

/** Axis-aligned box as a triangle soup, outward-wound. */
function boxSoup(lo: [number, number, number], hi: [number, number, number]): number[] {
  const [x0, y0, z0] = lo;
  const [x1, y1, z1] = hi;
  const v: [number, number, number][] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [
    [0, 3, 2], [0, 2, 1], // z = z0
    [4, 5, 6], [4, 6, 7], // z = z1
    [0, 1, 5], [0, 5, 4], // y = y0
    [1, 2, 6], [1, 6, 5], // x = x1
    [2, 3, 7], [2, 7, 6], // y = y1
    [3, 0, 4], [3, 4, 7], // x = x0
  ];
  const soup: number[] = [];
  for (const f of faces) for (const i of f) soup.push(...v[i]);
  return soup;
}

const unitCube = () => weldTriangleSoup(new Float32Array(boxSoup([0, 0, 0], [1, 1, 1])));

const basisFor = (dir: [number, number, number], up?: [number, number, number]): ScreenBasis =>
  viewBasis(dir, up) as ScreenBasis;

const len = (s: Segment2): number => Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);
const totalLength = (list: Segment2[]): number => list.reduce((n, s) => n + len(s), 0);

describe("hiddenLineDrawing — the isometric cube", () => {
  // THE canonical hidden-line fixture. Viewed along [1,1,1] a cube shows 12
  // feature edges: 6 form the hexagonal outline, 3 run from the near corner
  // (1,1,1), and the 3 at the far corner (0,0,0) are hidden behind it.
  const result = () => hiddenLineDrawing(unitCube(), basisFor([1, 1, 1]));

  it("finds exactly the cube's 12 edges — the coplanar face diagonals are not creases", () => {
    expect(result().featureEdgeCount).toBe(12);
  });

  it("splits them 9 visible / 3 hidden", () => {
    const r = result();
    expect(r.visible).toHaveLength(9);
    expect(r.hidden).toHaveLength(3);
  });

  it("leaves every edge WHOLE — no fragments", () => {
    // Much stronger than the counts above, and the assertion that actually
    // catches a bad epsilon or a misplaced run boundary: a drawing fragmented
    // into 40 slivers still yields plausible-looking totals, but here every
    // segment must be a full cube edge (length 1) rather than a piece of one.
    const r = result();
    for (const s of [...r.visible, ...r.hidden]) {
      expect(len(s)).toBeGreaterThan(0.5);
    }
    // 12 whole edges, each of unit 3D length, projected.
    // 4 decimals, not 6: the fixture is a Float32Array, so the projected
    // lengths carry ~1e-7 relative representation error.
    expect(totalLength(r.visible) + totalLength(r.hidden)).toBeCloseTo(12 * len(r.visible[0]), 4);
  });

  it("hides the three edges at the FAR corner, not the near one", () => {
    // Identity, and specifically DIRECTION. Two earlier attempts were too weak:
    // asserting only that three hidden segments share a point passes under a
    // fully inverted depth test (three edges meet at the near corner too), and
    // asserting *which* shared point fails because in isometric the near and
    // far corners differ by (1,1,1) — parallel to the view — so they project to
    // the very same screen point. The discriminator is the OTHER end of each
    // edge: the far corner's neighbours project opposite the near corner's.
    const r = result();
    const basis = basisFor([1, 1, 1]);
    const projectCentred = (p: [number, number, number]): [number, number] => [
      p[0] * basis.right[0] + p[1] * basis.right[1] + p[2] * basis.right[2],
      -(p[0] * basis.up[0] + p[1] * basis.up[1] + p[2] * basis.up[2]),
    ];
    // Cube corners are ±0.5 once centred. Neighbours of the far corner (0,0,0):
    const farNeighbours = [
      projectCentred([0.5, -0.5, -0.5]),
      projectCentred([-0.5, 0.5, -0.5]),
      projectCentred([-0.5, -0.5, 0.5]),
    ];
    const near = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-4;
    const hitsAFarNeighbour = (s: Segment2) => s.some((q) => farNeighbours.some((f) => near(q, f)));

    expect(r.hidden.filter(hitsAFarNeighbour), "every hidden edge runs to a far-corner neighbour").toHaveLength(3);
    // And the inverse: no VISIBLE edge runs between the shared corner point and
    // a far neighbour, which is what an inverted depth test would produce.
    const sharedCorner = projectCentred([-0.5, -0.5, -0.5]);
    const isFarSpoke = (s: Segment2) =>
      s.some((q) => near(q, sharedCorner)) && hitsAFarNeighbour(s);
    expect(r.visible.filter(isFarSpoke), "no visible edge is a far-corner spoke").toHaveLength(0);
  });

  it("reports no warnings for clean geometry", () => {
    expect(result().warnings).toEqual([]);
  });
});

describe("hiddenLineDrawing — a face-on cube", () => {
  it("hides the whole back face behind the front one", () => {
    // Viewed down -Z the front and back faces project exactly on top of each
    // other: 4 visible, 4 hidden, and the 4 side edges project to points and
    // are dropped.
    const r = hiddenLineDrawing(unitCube(), basisFor([0, 0, 1]));
    expect(r.visible).toHaveLength(4);
    expect(r.hidden).toHaveLength(4);
  });
});

describe("hiddenLineDrawing — partial occlusion", () => {
  // The case the cube CANNOT catch: every cube edge is all-or-nothing, so a
  // bug that makes the module all-or-nothing sails through it.
  //
  // A back plate spans x in [0,10]; a front bar covers x >= 4. Viewed down +Z,
  // the plate's top-front edge must split at exactly x = 4.
  function twoBoxes() {
    const soup = [...boxSoup([0, 0, 0], [10, 10, 1]), ...boxSoup([4, -5, 2], [20, 5, 3])];
    return weldTriangleSoup(new Float32Array(soup));
  }

  it("splits one edge into both a visible and a hidden run, at the right place", () => {
    const r = hiddenLineDrawing(twoBoxes(), basisFor([0, 0, 1]));
    // Screen coordinates are CENTRED on the model bbox, so they are world x
    // minus the combined centre — assert on the split's position within the
    // run pair rather than on absolute coordinates.
    const horizontal = (s: Segment2) => Math.abs(s[0][1] - s[1][1]) < 1e-6;
    const spanOf = (s: Segment2): [number, number] => [Math.min(s[0][0], s[1][0]), Math.max(s[0][0], s[1][0])];

    // Find a visible run and a hidden run that are collinear (same screen y)
    // and meet end-to-end — the two halves of one split edge.
    let found: { vis: [number, number]; hid: [number, number] } | null = null;
    for (const v of r.visible.filter(horizontal)) {
      for (const h of r.hidden.filter(horizontal)) {
        if (Math.abs(v[0][1] - h[0][1]) > 1e-6) continue;
        const vs = spanOf(v);
        const hs = spanOf(h);
        if (Math.abs(vs[1] - hs[0]) < 1e-4 && Math.abs(vs[1] - vs[0] - 4) < 1e-3) {
          found = { vis: vs, hid: hs };
        }
      }
    }
    expect(found, "a visible run meeting a hidden run end-to-end").not.toBeNull();
    // The plate spans 10 and the bar covers the last 6 of it.
    expect(found!.vis[1] - found!.vis[0]).toBeCloseTo(4, 3);
    expect(found!.hid[1] - found!.hid[0]).toBeCloseTo(6, 3);
  });
});

describe("hiddenLineDrawing — self-occlusion", () => {
  it("does not hide an edge behind its OWN adjacent faces, even with no epsilon", () => {
    // Every feature edge lies exactly on the surface, so its two adjacent
    // triangles interpolate to the same depth along it. With a normal epsilon
    // that margin (exactly 0) is already not "in front", so the epsilon masks
    // this case — set it to 0 to actually exercise the adjacency exclusion,
    // without which every edge would read as hidden.
    const r = hiddenLineDrawing(unitCube(), basisFor([1, 1, 1]), { depthEpsilon: 0 });
    expect(r.visible).toHaveLength(9);
    expect(r.hidden).toHaveLength(3);
  });
});

describe("hiddenLineDrawing — coplanar geometry", () => {
  it("hides nothing when everything is at the same depth", () => {
    // Two quads sharing an edge in z=0, viewed straight on: every depth
    // comparison is exactly equal. Catches an epsilon sign error and a
    // >= vs > slip, both of which the cube passes.
    const soup = [
      0, 0, 0, 1, 0, 0, 1, 1, 0,
      0, 0, 0, 1, 1, 0, 0, 1, 0,
      1, 0, 0, 2, 0, 0, 2, 1, 0,
      1, 0, 0, 2, 1, 0, 1, 1, 0,
    ];
    const r = hiddenLineDrawing(weldTriangleSoup(new Float32Array(soup)), basisFor([0, 0, 1]));
    expect(r.hidden).toEqual([]);
    expect(r.visible.length).toBeGreaterThan(0);
  });
});

describe("hiddenLineDrawing — degenerate input", () => {
  it("returns empty for an empty mesh rather than throwing", () => {
    const r = hiddenLineDrawing({ positions: new Float32Array(), indices: new Uint32Array() }, basisFor([0, 0, 1]));
    expect(r).toMatchObject({ visible: [], hidden: [], featureEdgeCount: 0 });
  });

  it("survives non-finite coordinates, and says so", () => {
    const soup = [...boxSoup([0, 0, 0], [1, 1, 1]), NaN, 0, 0, 1, NaN, 0, 0, 0, NaN];
    const r = hiddenLineDrawing(weldTriangleSoup(new Float32Array(soup)), basisFor([1, 1, 1]));
    expect(r.warnings.some((w) => /non-finite/.test(w))).toBe(true);
    expect([...r.visible, ...r.hidden].every((s) => s.flat().every(Number.isFinite))).toBe(true);
  });

  it("emits no zero-length segments", () => {
    // A stray zero-length run renders as a dot under a round line cap.
    for (const dir of [[0, 0, 1], [1, 1, 1], [1, 0, 0], [0.3, 0.9, -0.2]] as [number, number, number][]) {
      const r = hiddenLineDrawing(unitCube(), basisFor(dir));
      for (const s of [...r.visible, ...r.hidden]) expect(len(s)).toBeGreaterThan(0);
    }
  });
});

describe("hiddenLineDrawing — crease classification", () => {
  it("warns when creases explode into a wireframe", () => {
    // A crease angle below the mesh's own facet angle turns every interior edge
    // into a drawn line — a dense but well-formed, and completely wrong,
    // drawing. It must not be silent. Needs a mesh big enough for the check to
    // apply at all: a cube is legitimately 12/18 crease, which is why the
    // guard has a minimum-size gate.
    const segments = 40;
    const soup: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const [x0, y0] = [Math.cos(a0), Math.sin(a0)];
      const [x1, y1] = [Math.cos(a1), Math.sin(a1)];
      soup.push(x0, y0, 0, x1, y1, 0, x1, y1, 1);
      soup.push(x0, y0, 0, x1, y1, 1, x0, y0, 1);
    }
    const mesh = weldTriangleSoup(new Float32Array(soup));
    const r = hiddenLineDrawing(mesh, basisFor([1, 1, 1]), { creaseAngleDeg: 1 });
    expect(r.warnings.some((w) => /wireframe/.test(w))).toBe(true);
  });

  it("stays quiet at a sane threshold on the same mesh", () => {
    // The control: without it the warning above would pass even if it fired
    // unconditionally.
    const segments = 40;
    const soup: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const [x0, y0] = [Math.cos(a0), Math.sin(a0)];
      const [x1, y1] = [Math.cos(a1), Math.sin(a1)];
      soup.push(x0, y0, 0, x1, y1, 0, x1, y1, 1);
      soup.push(x0, y0, 0, x1, y1, 1, x0, y0, 1);
    }
    const mesh = weldTriangleSoup(new Float32Array(soup));
    const r = hiddenLineDrawing(mesh, basisFor([1, 1, 1]));
    expect(r.warnings).toEqual([]);
  });

  it("uses face ids to suppress facet edges INSIDE one curved face", () => {
    // The real value of face ids, and the disaster they prevent: a coarsely
    // tessellated cylinder's facet boundaries have a genuine dihedral angle,
    // so an angle threshold below it draws every one of them and the drawing
    // becomes a wireframe. Face ids know those facets are one face.
    const segments = 8;
    const soup: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const [x0, y0] = [Math.cos(a0), Math.sin(a0)];
      const [x1, y1] = [Math.cos(a1), Math.sin(a1)];
      // Two triangles per lateral facet.
      soup.push(x0, y0, 0, x1, y1, 0, x1, y1, 1);
      soup.push(x0, y0, 0, x1, y1, 1, x0, y0, 1);
    }
    const mesh = weldTriangleSoup(new Float32Array(soup));
    // 8 segments => 45 degree facets. A 20 degree threshold draws every one.
    const byAngle = hiddenLineDrawing(mesh, basisFor([1, 1, 1]), { creaseAngleDeg: 20 });
    const byFace = hiddenLineDrawing(
      { ...mesh, triangleFace: new Uint32Array(segments * 2).fill(0) },
      basisFor([1, 1, 1])
    );
    expect(byAngle.featureEdgeCount).toBeGreaterThan(byFace.featureEdgeCount);
  });
});
