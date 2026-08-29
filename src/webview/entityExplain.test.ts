import { describe, expect, it } from "vitest";
import { inspectorContent, hoverContent, num } from "./entityExplain";
import type { EntityFacts } from "../entityFacts";

const base: EntityFacts = {
  entityId: "face-3",
  kind: "face",
  bbox: { min: [0, 0, 0], max: [1, 1, 1], diagonal: Math.sqrt(3) },
  center: [0.5, 0.5, 0.5],
  area: null,
  length: null,
  normal: null,
  planeOrigin: null,
  surfaceType: null,
  surfaceParams: null,
  curveType: null,
};

const keys = (f: EntityFacts) => inspectorContent(f).rows.map((r) => r.key);

describe("inspectorContent", () => {
  it("names the analytic classification, not just the entity kind", () => {
    expect(inspectorContent({ ...base, surfaceType: "cylinder" }).title).toBe("Cylindrical face");
    expect(inspectorContent({ ...base, surfaceType: "torus" }).title).toBe("Toroidal face");
    expect(inspectorContent({ ...base, kind: "edge", curveType: "circle" }).title).toBe("Circular edge");
    expect(inspectorContent({ ...base, kind: "edge", curveType: "line" }).title).toBe("Straight edge");
    expect(inspectorContent({ ...base, kind: "solid" }).title).toBe("Solid");
    expect(inspectorContent({ ...base, kind: "point" }).title).toBe("Vertex");
  });

  it("falls back to a generic title when the classification is unknown", () => {
    expect(inspectorContent(base).title).toBe("Face");
    expect(inspectorContent({ ...base, kind: "edge" }).title).toBe("Edge");
  });

  it("shows normal and plane origin ONLY for a planar face", () => {
    const planar = { ...base, surfaceType: "plane" as const, normal: [0, 0, 1] as [number, number, number], planeOrigin: [0, 0, 5] as [number, number, number], area: 4 };
    expect(keys(planar)).toContain("Normal");
    expect(keys(planar)).toContain("On plane");

    // A cylinder has no single normal — EntityFacts returns null, and that
    // must render as an absent row, not a blank one.
    const curved = { ...base, surfaceType: "cylinder" as const, area: 4 };
    expect(keys(curved)).not.toContain("Normal");
    expect(keys(curved)).not.toContain("On plane");
  });

  it("shows length for an edge and area for a face, never both", () => {
    const edge = { ...base, kind: "edge" as const, curveType: "line" as const, length: 10 };
    expect(keys(edge)).toContain("Length");
    expect(keys(edge)).not.toContain("Area");

    const face = { ...base, surfaceType: "plane" as const, area: 25 };
    expect(keys(face)).toContain("Area");
    expect(keys(face)).not.toContain("Length");
  });

  it("labels a solid's area as surface area, distinguishing it from a face's", () => {
    expect(keys({ ...base, kind: "solid", area: 6 })).toContain("Surface area");
    expect(keys({ ...base, surfaceType: "plane", area: 6 })).toContain("Area");
  });

  it("omits a vertex's degenerate bbox diagonal", () => {
    // Always 0 for a point — a row that can only ever say "0" is noise.
    expect(keys({ ...base, kind: "point", bbox: { min: [1, 2, 3], max: [1, 2, 3], diagonal: 0 } }))
      .not.toContain("Bbox diag");
    expect(keys({ ...base, kind: "solid" })).toContain("Bbox diag");
  });

  it("always carries the entity id through for the card header", () => {
    expect(inspectorContent({ ...base, entityId: "edge-42", kind: "edge" }).entityId).toBe("edge-42");
  });
});

describe("num", () => {
  it("trims trailing precision rather than printing float noise", () => {
    expect(num(0.1 + 0.2)).toBe("0.3");
    expect(num(1000)).toBe("1000");
  });

  it("switches to exponential only at the extremes", () => {
    expect(num(1e-9)).toBe("1.000e-9");
    expect(num(1e9)).toBe("1.000e+9");
    expect(num(0)).toBe("0");
  });

  it("never prints NaN or Infinity as a number", () => {
    expect(num(NaN)).toBe("—");
    expect(num(Infinity)).toBe("—");
  });
});

describe("hoverContent", () => {
  it("says MENTIONS, not acts on — ids are positional and can be renumbered", () => {
    expect(hoverContent("face-3", [2, 5]).ops).toBe("mentioned by ops 2, 5");
    expect(hoverContent("face-3", [2]).ops).toBe("mentioned by op 2");
  });

  it("is explicit when nothing references the entity", () => {
    expect(hoverContent("face-3", []).ops).toBe("not mentioned by any op");
    expect(hoverContent("face-3", undefined).ops).toBe("not mentioned by any op");
  });

  it("passes the id through verbatim", () => {
    expect(hoverContent("edge-11", [1]).id).toBe("edge-11");
  });
});

describe("inspectorContent — analytic surface parameters", () => {
  it("shows a cylinder's radius and axis, and still no normal", () => {
    const k = keys({
      ...base,
      surfaceType: "cylinder",
      surfaceParams: { kind: "cylinder", radius: 3, axisLocation: [1, 2, 3], axisDirection: [0, 0, 1] },
    });
    expect(k).toContain("Radius");
    expect(k).toContain("Axis");
    expect(k).toContain("Axis through");
    // A cylinder has no single normal — the row must stay absent.
    expect(k).not.toContain("Normal");
  });

  it("shows a cone's half angle in degrees, with its apex", () => {
    const rows = inspectorContent({
      ...base,
      surfaceType: "cone",
      surfaceParams: {
        kind: "cone",
        axisLocation: [0, 0, 0],
        axisDirection: [0, 0, 1],
        refRadius: 5,
        apex: [0, 0, 6.5],
        semiAngleDeg: -36.8699,
      },
    }).rows;
    const half = rows.find((r) => r.key === "Half angle");
    expect(half?.value.endsWith("°")).toBe(true);
    // The sign is what says which way the cone opens — it must survive.
    expect(half?.value.startsWith("-")).toBe(true);
    expect(rows.map((r) => r.key)).toContain("Apex");
  });

  it("distinguishes a sphere's own centre from the bbox centre", () => {
    const rows = inspectorContent({
      ...base,
      surfaceType: "sphere",
      surfaceParams: { kind: "sphere", center: [9, 9, 9], radius: 2.5 },
    }).rows;
    expect(rows.find((r) => r.key === "Sphere centre")?.value).toContain("9");
    // Both rows exist and mean different things for a partial spherical face.
    expect(rows.find((r) => r.key === "Centre")?.value).toContain("0.5");
  });

  it("shows both torus radii", () => {
    const k = keys({
      ...base,
      surfaceType: "torus",
      surfaceParams: { kind: "torus", axisLocation: [0, 0, 0], axisDirection: [0, 0, 1], majorRadius: 10, minorRadius: 2 },
    });
    expect(k).toContain("Major radius");
    expect(k).toContain("Minor radius");
  });

  it("does NOT duplicate a plane's origin and normal", () => {
    // normal/planeOrigin already render these; the `plane` variant is
    // deliberately absent from the params switch. Without that, every planar
    // face would show two identical pairs.
    const k = keys({
      ...base,
      surfaceType: "plane",
      normal: [0, 0, 1],
      planeOrigin: [0, 0, 5],
      surfaceParams: { kind: "plane", origin: [0, 0, 5], normal: [0, 0, 1] },
    });
    expect(k.filter((x) => x === "Normal")).toHaveLength(1);
    expect(k.filter((x) => x === "On plane")).toHaveLength(1);
  });

  it("tolerates the field being absent entirely, rather than throwing", () => {
    // The webview harness hand-builds these payloads; an older or partial
    // object must render, not crash the card.
    const partial = { ...base, surfaceType: "cylinder" as const };
    delete (partial as { surfaceParams?: unknown }).surfaceParams;
    expect(() => inspectorContent(partial as EntityFacts)).not.toThrow();
  });
});
