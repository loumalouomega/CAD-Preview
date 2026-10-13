import { describe, expect, it } from "vitest";
import { DETERMINISTIC_MESH_TIMESTAMP, normalizeMeshExport } from "./deterministicMesh";

const bytes = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));
const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");

describe("normalizeMeshExport", () => {
  it("fixes the Gmsh model-name counter in a legacy VTK title line, and nothing else", () => {
    const a = bytes("# vtk DataFile Version 2.0\nmodel-11, Created by Gmsh 5.0.0-git-29726e7 \nASCII\nmodel-11 appears in data? no\n");
    const out = text(normalizeMeshExport("vtk", "primary", a));
    expect(out).toContain("\nmodel-1, Created by Gmsh 5.0.0-git-29726e7 \n");
    // only the title line is touched
    expect(out).toContain("model-11 appears in data? no");
    const b = bytes("# vtk DataFile Version 2.0\nmodel-12, Created by Gmsh 5.0.0-git-29726e7 \nASCII\nmodel-11 appears in data? no\n");
    expect(normalizeMeshExport("vtk", "primary", a)).toEqual(normalizeMeshExport("vtk", "primary", b));
  });

  it("fixes the XAO geometry name written beside a B-rep .geo_unrolled", () => {
    const xao = (n: number) => bytes(`<?xml version="1.0"?>\n<XAO>\n  <geometry name="model-${n}">\n  </geometry>\n</XAO>\n`);
    expect(normalizeMeshExport("geoUnrolled", "xao", xao(9))).toEqual(normalizeMeshExport("geoUnrolled", "xao", xao(10)));
    expect(text(normalizeMeshExport("geoUnrolled", "xao", xao(9)))).toContain('<geometry name="model-1">');
  });

  it.each([
    ["vtu", "primary", "Timestamp: "],
    ["avsucd", "primary", "# Timestamp: "],
    ["mphtxt", "primary", "# Timestamp: "],
    ["netgen", "primary", "# Timestamp: "],
    ["flac3d", "primary", "* Timestamp: "],
    ["flux", "primary", " Timestamp: "],
    ["gid", "primary", "# meshio++_3: Timestamp: "],
    ["gid", "companion", "# meshio++_3: Timestamp: "],
  ])("rewrites the meshio++ provenance timestamp of %s (%s) to a same-length fixed instant", (id, role, lead) => {
    const a = bytes(`header\n${lead}2026-10-13T21:22:57Z\nbody 2026-10-13T21:22:57Z untouched\n`);
    const b = bytes(`header\n${lead}2027-01-02T03:04:05Z\nbody 2026-10-13T21:22:57Z untouched\n`);
    const na = normalizeMeshExport(id, role, a);
    expect(na).toEqual(normalizeMeshExport(id, role, b));
    expect(na.length).toBe(a.length);
    expect(text(na)).toContain(`${lead}${DETERMINISTIC_MESH_TIMESTAMP}\n`);
    expect(text(na)).toContain("body 2026-10-13T21:22:57Z untouched");
  });

  it("is idempotent", () => {
    const a = bytes("x\n# Timestamp: 2026-10-13T21:22:57Z\n");
    const once = normalizeMeshExport("avsucd", "primary", a);
    expect(normalizeMeshExport("avsucd", "primary", once)).toEqual(once);
  });

  it("returns formats that were measured stable (and unknown ids) unchanged — the same array", () => {
    const a = bytes("Timestamp: 2026-10-13T21:22:57Z model-3, Created by Gmsh\n");
    for (const id of ["msh", "msh2", "mdpaElements", "mdpaGeometries", "unv", "inp", "bdf", "su2", "mesh", "stl", "diff", "off", "wkt", "nonsense"]) {
      expect(normalizeMeshExport(id, "primary", a)).toBe(a);
    }
  });

  it("never edits a binary container (HDF5-backed formats are made reproducible at the source)", () => {
    const hdf = new Uint8Array([0x89, 0x48, 0x44, 0x46, 0, 0, ...Buffer.from("Timestamp: 2026-10-13T21:22:57Z")]);
    for (const id of ["med", "cgns", "xdmf", "hmf", "vtu"]) expect(normalizeMeshExport(id, "companion", hdf)).toBe(hdf);
  });
});
