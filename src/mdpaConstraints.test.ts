import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { dropInterfaceFacets, mdpaConstraintSummary, parseMdpaConstraintLinks, stripMdpaConstraints } from "./mdpaConstraints";
import { writeMdpa, type MdpaMesh } from "./mdpaWriter";

const FIXTURE = fs.readFileSync(path.join(__dirname, "..", "examples", "MDPA", "hanging-two-level.mdpa"));
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("stripMdpaConstraints", () => {
  it("returns the SAME bytes for a file with no constraints", () => {
    const plain = new TextEncoder().encode("Begin Nodes\n1 0 0 0\nEnd Nodes\n");
    expect(stripMdpaConstraints(plain)).toBe(plain);
  });

  it("removes every Constraints block and SubModelPartConstraints list, keeping the rest", () => {
    const out = text(stripMdpaConstraints(FIXTURE));
    expect(out).not.toMatch(/Constraints/);
    expect(out).not.toContain("LinearMasterSlaveConstraint");
    expect(out).toContain("Begin Nodes");
    expect(out).toContain("Begin Elements Element3D8N");
    expect(out).toContain("Begin SubModelPart HangingNodes");
    // The nodes and elements survive verbatim.
    const between = (s: string, a: string, b: string) => s.slice(s.indexOf(a), s.indexOf(b) + b.length);
    expect(between(out, "Begin Nodes", "End Nodes")).toBe(between(text(FIXTURE), "Begin Nodes", "End Nodes"));
    expect(between(out, "Begin Elements", "End Elements")).toBe(between(text(FIXTURE), "Begin Elements", "End Elements"));
  });

  it("preserves CRLF line endings", () => {
    const crlf = new TextEncoder().encode("Begin Nodes\r\n1 0 0 0\r\nEnd Nodes\r\nBegin Constraints LinearMasterSlaveConstraint A A A\r\n1 0.0 [0.5, 0.5] 1 1 1\r\nEnd Constraints\r\n");
    expect(text(stripMdpaConstraints(crlf))).toBe("Begin Nodes\r\n1 0 0 0\r\nEnd Nodes\r\n");
  });
});

describe("parseMdpaConstraintLinks", () => {
  it("returns undefined for a file with no Constraints block", () => {
    expect(parseMdpaConstraintLinks("Begin Nodes\n1 0 0 0\nEnd Nodes\n")).toBeUndefined();
  });

  it("reads the two-level fixture: 5 slaves, 12 distinct links, three variables, 15 rows", () => {
    const links = parseMdpaConstraintLinks(text(FIXTURE))!;
    expect(links.slaveCount).toBe(5);
    expect(links.constraintCount).toBe(15); // 5 ties × DISPLACEMENT_X/Y/Z
    expect(links.variables).toEqual(["DISPLACEMENT_X", "DISPLACEMENT_Y", "DISPLACEMENT_Z"]);
    // 4 edge nodes × 2 masters + 1 face node × 4 masters; the Y and Z rows repeat the same ties.
    expect(links.indices.length / 2).toBe(12);
    expect(links.skippedRows).toBe(0);
    expect(links.missingNodes).toBe(0);
    expect(links.truncated).toBe(0);
  });

  it("puts each segment between the slave's and the master's file coordinates", () => {
    const links = parseMdpaConstraintLinks(text(FIXTURE))!;
    const p = (i: number) => [links.points[i * 3], links.points[i * 3 + 1], links.points[i * 3 + 2]];
    // Slave 11 = (2,1,0) is tied to 2 = (2,0,0) and 3 = (2,2,0): its segments are the unit-length edge halves.
    const segs: number[][][] = [];
    for (let s = 0; s < links.indices.length; s += 2) segs.push([p(links.indices[s]), p(links.indices[s + 1])]);
    const first = segs.filter(([a]) => a[0] === 2 && a[1] === 1 && a[2] === 0);
    expect(first.map(([, b]) => b.join(","))).toEqual(["2,0,0", "2,2,0"]);
  });

  it("reads back exactly what mdpaWriter wrote", () => {
    const mesh: MdpaMesh = {
      nodes: [
        { tag: 10, x: 0, y: 0, z: 0 },
        { tag: 20, x: 4, y: 0, z: 0 },
        { tag: 30, x: 1, y: 0, z: 0 },
        { tag: 40, x: 0, y: 3, z: 0 },
      ],
      volumeCells: [{ kind: "tet4", nodeTags: [10, 20, 40, 30] }],
      surfaceCells: [],
      groups: [],
      constraints: [{ slave: 30, masters: [10, 20], weights: [0.75, 0.25] }],
      constraintVariables: ["TEMPERATURE"],
    };
    const links = parseMdpaConstraintLinks(writeMdpa(mesh, "elements"))!;
    expect(links.variables).toEqual(["TEMPERATURE"]);
    expect(links.constraintCount).toBe(1);
    expect(links.indices.length / 2).toBe(2);
    // Output node ids are 1..4 by tag order; the slave (tag 30 → id 3) sits at (1,0,0).
    expect(Array.from(links.points.slice(0, 3))).toEqual([1, 0, 0]);
  });

  it("counts rows it cannot read instead of guessing, and names them", () => {
    const src = [
      "Begin Nodes", "1 0 0 0", "2 1 0 0", "3 2 0 0", "End Nodes",
      "Begin Constraints LinearMasterSlaveConstraint A A A",
      "1 0.0 [0.5, 0.5] 2 1 3",
      "2 0.0 [0.5, 0.5] 2 1", // one id short: no slave column left
      "garbage",
      "End Constraints",
      "Begin Constraints SomeOtherConstraint A A",
      "9 0.0 [1.0] 2 1",
      "End Constraints",
    ].join("\n");
    const links = parseMdpaConstraintLinks(src)!;
    expect(links.constraintCount).toBe(1);
    expect(links.skippedRows).toBe(3); // two bad rows + the unsupported block's row
    expect(links.notes.join(" ")).toMatch(/SomeOtherConstraint|other than LinearMasterSlaveConstraint/);
    expect(links.notes.join(" ")).toMatch(/2 constraint row|do not fit/);
  });

  it("reports a link to a node that is not in Begin Nodes", () => {
    const src = ["Begin Nodes", "1 0 0 0", "2 1 0 0", "End Nodes", "Begin Constraints LinearMasterSlaveConstraint A A A", "1 0.0 [0.5, 0.5] 2 1 99", "End Constraints"].join("\n");
    const links = parseMdpaConstraintLinks(src)!;
    expect(links.missingNodes).toBe(1);
    expect(links.indices.length / 2).toBe(1);
  });

  it("caps the drawn links and counts the rest as truncated", () => {
    const links = parseMdpaConstraintLinks(text(FIXTURE), 5)!;
    expect(links.indices.length / 2).toBe(5);
    expect(links.truncated).toBe(7);
  });
});

describe("mdpaConstraintSummary", () => {
  it("is one line with the counts, variables and anything skipped", () => {
    const links = parseMdpaConstraintLinks(text(FIXTURE))!;
    expect(mdpaConstraintSummary(links)).toBe("15 constraints on 5 slave nodes (DISPLACEMENT_X, DISPLACEMENT_Y, DISPLACEMENT_Z)");
    expect(mdpaConstraintSummary({ constraintCount: 1, slaveCount: 1, variables: [], skippedRows: 2, truncated: 4 })).toBe("1 constraint on 1 slave node · 2 row(s) skipped · 4 link(s) not drawn");
  });
});

describe("dropInterfaceFacets", () => {
  type P = [number, number, number];
  const facet = (a: P, b: P, c: P) =>
    `  facet normal 0 0 0\n    outer loop\n${[a, b, c].map((p) => `      vertex ${p.join(" ")}`).join("\n")}\n    endloop\n  endfacet`;
  /** The unit squares tiling the x = 2 plane over y,z in [0,2], two facets each. */
  const wall = (cells: Array<[number, number, number]>): string[] =>
    cells.flatMap(([x, y, z]) => [facet([x, y, z], [x, y + 1, z], [x, y + 1, z + 1]), facet([x, y, z], [x, y + 1, z + 1], [x, y, z + 1])]);
  const stlOf = (facets: string[]) => `solid m\n${facets.join("\n")}\nendsolid m\n`;
  const count = (stl: string) => (stl.match(/endfacet/g) ?? []).length;

  it("drops the coarse face and the facets inside it, and nothing else", () => {
    const links = parseMdpaConstraintLinks(text(FIXTURE))!;
    expect(links.interfaceQuads).toHaveLength(12); // one face-centre hanging node (slave 15)
    const interior = [
      facet([2, 0, 0], [2, 2, 0], [2, 2, 2]), facet([2, 0, 0], [2, 2, 2], [2, 0, 2]), // the coarse face
      ...wall([[2, 0, 0], [2, 1, 0], [2, 0, 1], [2, 1, 1]]), // the four fine faces
    ];
    const outside = [
      facet([0, 0, 0], [0, 2, 0], [0, 2, 2]), // a true boundary facet on x = 0
      facet([2, 2, 0], [2, 3, 0], [2, 3, 1]), // on the x = 2 plane but beyond the face (y > 2)
      facet([3, 0, 0], [3, 1, 0], [3, 1, 1]), // a fine side wall
    ];
    const r = dropInterfaceFacets(stlOf([...interior, ...outside]), links.interfaceQuads);
    expect(r.dropped).toBe(10);
    expect(count(r.stl)).toBe(3);
    expect(r.keep.slice(0, 10).every((k) => !k)).toBe(true);
    expect(r.keep.slice(10)).toEqual([true, true, true]);
    expect(r.stl.startsWith("solid m")).toBe(true);
    expect(r.stl.trimEnd().endsWith("endsolid m")).toBe(true);
  });

  it("is a no-op without quads (same string back)", () => {
    const stl = stlOf(wall([[2, 0, 0]]));
    const r = dropInterfaceFacets(stl, []);
    expect(r.stl).toBe(stl);
    expect(r.dropped).toBe(0);
  });

  it("takes the quad's corners in any order (a writer sorts masters by node id)", () => {
    const stl = stlOf(wall([[2, 0, 0], [2, 1, 0], [2, 0, 1], [2, 1, 1]]));
    const scrambled = [2, 0, 0, 2, 2, 2, 2, 2, 0, 2, 0, 2];
    expect(dropInterfaceFacets(stl, scrambled).dropped).toBe(8);
  });
});
