import { describe, it, expect } from "vitest";
import { stemCompanionCandidates, extractXdmfHdfReferences, meshioCompanionCandidates } from "./meshioCompanions";

describe("stemCompanionCandidates", () => {
  it("returns the tetgen sibling for a .node primary", () => {
    expect(stemCompanionCandidates("mesh.node", "tetgen")).toEqual(["mesh.ele"]);
  });

  it("returns the tetgen sibling for an .ele primary", () => {
    expect(stemCompanionCandidates("mesh.ele", "tetgen")).toEqual(["mesh.node"]);
  });

  it("returns every triangle sibling except the primary's own extension", () => {
    expect(stemCompanionCandidates("mesh.node", "triangle").sort()).toEqual(["mesh.ele", "mesh.poly"]);
  });

  it("returns the ensight sibling for a .case primary", () => {
    expect(stemCompanionCandidates("model.case", "ensight")).toEqual(["model.geo"]);
  });

  it("preserves the stem exactly, including embedded dots", () => {
    expect(stemCompanionCandidates("v1.2.node", "tetgen")).toEqual(["v1.2.ele"]);
  });

  it("returns the GiD results sibling for a .post.msh primary", () => {
    // The `.post` segment travels inside the stem — only the final segment is
    // swapped, which is exactly GiD's own convention.
    expect(stemCompanionCandidates("beam.post.msh", "gid")).toEqual(["beam.post.res"]);
  });

  it("returns the GiD geometry sibling for a .post.res primary", () => {
    expect(stemCompanionCandidates("beam.post.res", "gid")).toEqual(["beam.post.msh"]);
  });

  it("returns [] for a format with no stem-sibling convention", () => {
    expect(stemCompanionCandidates("model.vtk", "vtk")).toEqual([]);
    expect(stemCompanionCandidates("model.xdmf", "xdmf")).toEqual([]);
  });

  it("treats a primary with no extension as having nothing to exclude, offering every sibling extension", () => {
    expect(stemCompanionCandidates("mesh", "tetgen").sort()).toEqual(["mesh.ele", "mesh.node"]);
  });
});

describe("extractXdmfHdfReferences", () => {
  it("extracts a bare HDF filename from a single DataItem", () => {
    const xml = `<Xdmf><DataItem Format="HDF" Dimensions="4 3">model.h5:/points</DataItem></Xdmf>`;
    expect(extractXdmfHdfReferences(xml)).toEqual(["model.h5"]);
  });

  it("deduplicates repeated references to the same file", () => {
    const xml = `
      <DataItem Format="HDF">model.h5:/points</DataItem>
      <DataItem Format="HDF">model.h5:/cells</DataItem>
    `;
    expect(extractXdmfHdfReferences(xml)).toEqual(["model.h5"]);
  });

  it("collects multiple distinct companion files", () => {
    const xml = `
      <DataItem Format="HDF">geom.h5:/points</DataItem>
      <DataItem Format="HDF">data.h5:/temperature</DataItem>
    `;
    expect(extractXdmfHdfReferences(xml).sort()).toEqual(["data.h5", "geom.h5"]);
  });

  it("strips a directory component, keeping only the basename", () => {
    const xml = `<DataItem Format="HDF">sub/dir/model.h5:/points</DataItem>`;
    expect(extractXdmfHdfReferences(xml)).toEqual(["model.h5"]);
  });

  it("ignores DataItem elements using XML/Binary format (no HDF companion needed)", () => {
    const xml = `<DataItem Format="XML" Dimensions="3">1 2 3</DataItem>`;
    expect(extractXdmfHdfReferences(xml)).toEqual([]);
  });

  it("returns [] for a document with no DataItem elements at all", () => {
    expect(extractXdmfHdfReferences("<Xdmf><Domain/></Xdmf>")).toEqual([]);
  });

  it("is case-insensitive on the Format=\"HDF\" attribute value casing variance seen across writers", () => {
    const xml = `<DataItem format="HDF" >model.h5:/x</DataItem>`;
    expect(extractXdmfHdfReferences(xml)).toEqual(["model.h5"]);
  });
});

describe("meshioCompanionCandidates", () => {
  it("dispatches to extractXdmfHdfReferences for xdmf, given decoded text", () => {
    const xml = `<DataItem Format="HDF">out.h5:/data0</DataItem>`;
    expect(meshioCompanionCandidates("model.xdmf", "xdmf", xml)).toEqual(["out.h5"]);
  });

  it("returns [] for xdmf when no text was given (never crashes on a missing decode)", () => {
    expect(meshioCompanionCandidates("model.xdmf", "xdmf")).toEqual([]);
  });

  it("dispatches to stemCompanionCandidates for a stem-convention format, ignoring any text argument", () => {
    expect(meshioCompanionCandidates("mesh.node", "tetgen", "irrelevant")).toEqual(["mesh.ele"]);
  });

  it("returns [] for an ordinary single-file format", () => {
    expect(meshioCompanionCandidates("model.med", "med")).toEqual([]);
  });
});
