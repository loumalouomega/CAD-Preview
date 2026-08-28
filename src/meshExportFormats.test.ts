import { describe, it, expect } from "vitest";
import { MESH_EXPORT_FORMATS, meshExportFormat } from "./meshExportFormats";

describe("MESH_EXPORT_FORMATS", () => {
  it("has no duplicate ids", () => {
    const ids = MESH_EXPORT_FORMATS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry has a non-empty label, extension, filterLabel, and a valid via", () => {
    for (const f of MESH_EXPORT_FORMATS) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.extension.length).toBeGreaterThan(0);
      expect(f.filterLabel.length).toBeGreaterThan(0);
      expect(["gmsh", "mdpa", "meshio"]).toContain(f.via);
    }
  });

  it("mdpaElements is listed first, keeping it the default-selected export", () => {
    expect(MESH_EXPORT_FORMATS[0].id).toBe("mdpaElements");
  });

  it("the two Kratos MDPA ids are via: mdpa", () => {
    expect(meshExportFormat("mdpaElements")?.via).toBe("mdpa");
    expect(meshExportFormat("mdpaGeometries")?.via).toBe("mdpa");
  });

  it("med/cgns/xdmf are via: meshio (the original bridge formats)", () => {
    expect(meshExportFormat("med")?.via).toBe("meshio");
    expect(meshExportFormat("cgns")?.via).toBe("meshio");
    expect(meshExportFormat("xdmf")?.via).toBe("meshio");
  });

  it("the 8 new meshio-only writer formats are via: meshio, each with a distinct extension", () => {
    const newMeshioIds = ["vtu", "hmf", "avsucd", "mphtxt", "netgen", "flac3d", "wkt", "flux"];
    for (const id of newMeshioIds) {
      expect(meshExportFormat(id)?.via).toBe("meshio");
    }
    const extensions = newMeshioIds.map((id) => meshExportFormat(id)!.extension);
    expect(new Set(extensions).size).toBe(extensions.length);
  });

  it("the plain gmsh.write()-based formats are via: gmsh", () => {
    for (const id of ["msh", "msh2", "geoUnrolled", "vtk", "unv", "inp", "bdf", "su2", "mesh", "stl", "diff", "off"]) {
      expect(meshExportFormat(id)?.via).toBe("gmsh");
    }
  });

  it("meshExportFormat returns undefined for an unknown id", () => {
    expect(meshExportFormat("not-a-real-format")).toBeUndefined();
  });
});
