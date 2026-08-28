import { describe, it, expect } from "vitest";
import { MESH_EXPORT_FORMATS, meshExportFormat, companionSaveName } from "./meshExportFormats";

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

  it("gid is via: meshio, with a compound extension and a sibling companion", () => {
    const gid = meshExportFormat("gid");
    expect(gid?.via).toBe("meshio");
    expect(gid?.extension).toBe("post.msh");
    expect(gid?.companion).toEqual({ extension: "post.res", linkage: "sibling" });
  });

  it("xdmf declares its .h5 companion as a referenced one, not a sibling", () => {
    // The distinction drives whether the primary's own bytes get rewritten.
    expect(meshExportFormat("xdmf")?.companion).toEqual({ extension: "h5", linkage: "referenced" });
  });

  it("only the formats that genuinely emit a second file declare a companion", () => {
    // Via meshExportFormat (the wide MeshExportFormat type) rather than the
    // `as const` literals, whose per-entry shapes omit the optional field.
    for (const { id } of MESH_EXPORT_FORMATS) {
      if (id === "xdmf" || id === "gid") continue;
      expect(meshExportFormat(id)!.companion).toBeUndefined();
    }
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

describe("companionSaveName", () => {
  const gid = meshExportFormat("gid")!;
  const xdmf = meshExportFormat("xdmf")!;

  it("strips a COMPOUND extension to find the stem", () => {
    // The trap this function exists for: a last-dot-only strip leaves the stem
    // as "beam.post" and produces "beam.post.post.res".
    expect(companionSaveName("beam.post.msh", gid)).toBe("beam.post.res");
  });

  it("strips a simple extension to find the stem", () => {
    expect(companionSaveName("result.xdmf", xdmf)).toBe("result.h5");
  });

  it("preserves dots that belong to the stem itself", () => {
    expect(companionSaveName("rev1.2.post.msh", gid)).toBe("rev1.2.post.res");
    expect(companionSaveName("rev1.2.xdmf", xdmf)).toBe("rev1.2.h5");
  });

  it("matches the format's extension case-insensitively", () => {
    expect(companionSaveName("BEAM.POST.MSH", gid)).toBe("BEAM.post.res");
  });

  it("falls back to a last-segment strip when the chosen name lacks the expected extension", () => {
    // A save dialog never forces an extension, so this must degrade sanely
    // rather than produce a doubled or empty stem.
    expect(companionSaveName("beam.dat", gid)).toBe("beam.post.res");
  });

  it("returns undefined for a format with no companion", () => {
    expect(companionSaveName("out.med", meshExportFormat("med")!)).toBeUndefined();
    expect(companionSaveName("out.msh", meshExportFormat("msh")!)).toBeUndefined();
  });
});
