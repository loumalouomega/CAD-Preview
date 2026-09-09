/**
 * Tests for src/meshProvenanceNotes.ts — the pure conversion-chain note
 * builder both meshio export call sites share.
 */
import { describe, it, expect } from "vitest";
import { buildMeshProvenanceNotes, type MeshProvenanceFacts } from "./meshProvenanceNotes";

const BASE: MeshProvenanceFacts = {
  engineUsed: "gmsh",
  dimension: 3,
  sizeMin: 0,
  sizeMax: 4.2,
  elementShape: "simplex",
  elementOrder: 1,
  unit: "mm",
  inputKind: "brep",
  editOpCount: 2,
};

describe("buildMeshProvenanceNotes", () => {
  it("records the engine that actually ran, the sizes, the shape, the unit, and the baked edits", () => {
    const notes = buildMeshProvenanceNotes(BASE);
    const byCat = Object.fromEntries(notes.map((n) => [n.category, n.detail]));
    expect(byCat["meshing-engine"]).toBe("gmsh");
    expect(byCat["mesh-size"]).toBe("sizeMin=0 sizeMax=4.2");
    expect(byCat["mesh-shape"]).toBe("dimension=3 shape=simplex order=1");
    expect(byCat["export-unit"]).toBe("mm");
    expect(byCat["edits-baked"]).toMatch(/2 edit op\(s\) baked/);
    expect(byCat["exported-by"]).toMatch(/CAD Preview/);
  });

  it("renders the unbounded sizeMax sentinel as auto, never 1e+22", () => {
    const notes = buildMeshProvenanceNotes({ ...BASE, sizeMax: 1e22 });
    expect(notes.find((n) => n.category === "mesh-size")!.detail).toBe("sizeMin=0 sizeMax=auto");
  });

  it("reports raw mesh bytes (edits NOT baked) for a non-brep input", () => {
    const notes = buildMeshProvenanceNotes({ ...BASE, inputKind: "stl", editOpCount: 3 });
    // Even with ops in the sidecar, an STL mesh never bakes them headless —
    // the note must not claim otherwise.
    expect(notes.find((n) => n.category === "edits-baked")!.detail).toMatch(/NOT baked/);
  });

  it("reflects a fallback engine and converted unit honestly", () => {
    const notes = buildMeshProvenanceNotes({ ...BASE, engineUsed: "gmsh", unit: "in", elementOrder: 2 });
    const byCat = Object.fromEntries(notes.map((n) => [n.category, n.detail]));
    expect(byCat["export-unit"]).toBe("in");
    expect(byCat["mesh-shape"]).toMatch(/order=2/);
  });
});
