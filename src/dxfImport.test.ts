import { describe, it, expect } from "vitest";
import { parseDxf, parseDxfRawEntities } from "./dxfImport";

function dxf(...lines: string[]): string {
  return lines.join("\n");
}

function entitiesSection(...entityLines: string[]): string {
  return dxf(
    "0", "SECTION",
    "2", "ENTITIES",
    ...entityLines,
    "0", "ENDSEC",
    "0", "EOF"
  );
}

describe("dxfImport", () => {
  it("parses a LINE into addLine", () => {
    const text = entitiesSection("0","LINE","8","0","10","0","20","0","30","0","11","10","21","0","31","0");
    const { ops } = parseDxf(text);
    expect(ops).toEqual([{ op: "addLine", start: [0,0,0], end: [10,0,0] }]);
  });

  it("skips degenerate LINE (zero length)", () => {
    const text = entitiesSection("0","LINE","10","5","20","5","30","0","11","5","21","5","31","0");
    expect(parseDxf(text).ops).toEqual([]);
  });

  it("parses CIRCLE into addCircleProfile", () => {
    const text = entitiesSection("0","CIRCLE","10","2","20","3","30","0","40","5");
    const { ops } = parseDxf(text);
    expect(ops).toEqual([{ op:"addCircleProfile", center:[2,3,0], normal:[0,0,1], radius:5 }]);
  });

  it("parses ARC into addArc", () => {
    const text = entitiesSection("0","ARC","10","0","20","0","30","0","40","5","50","0","51","90");
    const { ops } = parseDxf(text);
    expect(ops).toEqual([{ op:"addArc", center:[0,0,0], normal:[0,0,1], radius:5, startAngleDeg:0, endAngleDeg:90 }]);
  });

  it("skips ARC with equal start/end angle", () => {
    const text = entitiesSection("0","ARC","10","0","20","0","40","5","50","30","51","30");
    expect(parseDxf(text).ops).toEqual([]);
  });

  it("parses LWPOLYLINE straight closed into one addPolyline", () => {
    const text = entitiesSection("0","LWPOLYLINE","70","1","10","0","20","0","10","10","20","0","10","10","20","10","10","0","20","10");
    const { ops } = parseDxf(text);
    expect(ops.length).toBe(1);
    expect(ops[0]).toMatchObject({ op:"addPolyline", closed:true });
    const poly = ops[0] as { op:"addPolyline"; points:[number,number,number][]; closed:boolean };
    expect(poly.points).toEqual([[0,0,0],[10,0,0],[10,10,0],[0,10,0]]);
  });

  it("parses LWPOLYLINE straight open into one addPolyline", () => {
    const text = entitiesSection("0","LWPOLYLINE","70","0","10","0","20","0","10","10","20","0","10","10","20","10");
    const { ops } = parseDxf(text);
    expect(ops).toEqual([{ op:"addPolyline", points:[[0,0,0],[10,0,0],[10,10,0]], closed:false }]);
  });

  it("parses LWPOLYLINE with bulge into addLine + addArc per segment", () => {
    // 4-vertex open polyline: segment 0-1 bulge 1 (semicircle), 1-2 straight, 2-3 bulge 0.5
    const text = entitiesSection(
      "0","LWPOLYLINE","70","0",
      "10","0","20","0","42","1",
      "10","10","20","0","42","0",
      "10","10","20","10","42","0.5",
      "10","20","20","10"
    );
    const { ops } = parseDxf(text);
    expect(ops.length).toBe(3);
    expect(ops[0].op).toBe("addArc");
    expect(ops[1].op).toBe("addLine");
    expect(ops[2].op).toBe("addArc");
    const arc0 = ops[0] as { op:"addArc"; radius:number };
    expect(arc0.radius).toBeCloseTo(5, 5);
  });

  it("handles LWPOLYLINE bulge=1 semicircle radius = chord/2", () => {
    const text = entitiesSection("0","LWPOLYLINE","70","0","10","0","20","0","42","1","10","10","20","0");
    const { ops } = parseDxf(text);
    expect(ops.length).toBe(1);
    const arc = ops[0] as { op:"addArc"; radius:number; center:[number,number,number] };
    expect(arc.radius).toBeCloseTo(5, 5);
    expect(arc.center[0]).toBeCloseTo(5, 5);
  });

  it("skips degenerate LWPOLYLINE with <2 distinct vertices", () => {
    const text = entitiesSection("0","LWPOLYLINE","70","0","10","0","20","0","10","0","20","0");
    expect(parseDxf(text).ops).toEqual([]);
  });

  it("parses POLYLINE with VERTEX/SEQEND", () => {
    const text = entitiesSection(
      "0","POLYLINE","70","0",
      "0","VERTEX","10","0","20","0","30","0",
      "0","VERTEX","10","10","20","0","30","0",
      "0","VERTEX","10","5","20","8","30","0",
      "0","SEQEND"
    );
    const { ops } = parseDxf(text);
    expect(ops.length).toBe(1);
    expect(ops[0]).toMatchObject({ op:"addPolyline", closed:false });
  });

  it("parses POLYLINE with VERTEX bulge into arcs", () => {
    const text = entitiesSection(
      "0","POLYLINE","70","0",
      "0","VERTEX","10","0","20","0","42","1",
      "0","VERTEX","10","10","20","0","42","0",
      "0","SEQEND"
    );
    const { ops } = parseDxf(text);
    expect(ops[0].op).toBe("addArc");
  });

  it("parses SPLINE control points into addSpline", () => {
    const text = entitiesSection(
      "0","SPLINE","70","8","71","3","10","0","20","0","30","0","10","5","20","5","30","0","10","10","20","0","30","0"
    );
    const { ops } = parseDxf(text);
    expect(ops).toEqual([{ op:"addSpline", points:[[0,0,0],[5,5,0],[10,0,0]] }]);
  });

  it("skips SPLINE with <2 points", () => {
    const text = entitiesSection("0","SPLINE","10","0","20","0","30","0");
    expect(parseDxf(text).ops).toEqual([]);
  });

  it("ignores INSERT and other unsupported entities", () => {
    const text = entitiesSection("0","INSERT","2","BLOCK1","10","0","20","0","0","TEXT","10","0","20","0","1","hello","0","LINE","10","0","20","0","11","1","21","0");
    const { ops } = parseDxf(text);
    expect(ops).toEqual([{ op:"addLine", start:[0,0,0], end:[1,0,0] }]);
  });

  it("handles HEADER before ENTITIES", () => {
    const text = dxf(
      "0","SECTION","2","HEADER","9","$ACADVER","1","AC1009",
      "0","ENDSEC",
      "0","SECTION","2","ENTITIES","0","LINE","10","0","20","0","11","1","21","1","0","ENDSEC","0","EOF"
    );
    const { ops } = parseDxf(text);
    expect(ops.length).toBe(1);
    expect(ops[0]).toMatchObject({ op:"addLine" });
  });

  it("returns no ops for empty ENTITIES", () => {
    const text = entitiesSection();
    expect(parseDxf(text).ops).toEqual([]);
  });

  it("handles bare entities without SECTION wrappers (minimal DXF)", () => {
    const text = dxf("0","LINE","10","0","20","0","11","2","21","2");
    const { ops } = parseDxf(text);
    expect(ops.length).toBe(1);
  });

  it("parses multiple entity types in one file", () => {
    const text = entitiesSection(
      "0","LINE","10","0","20","0","11","5","21","0",
      "0","CIRCLE","10","0","20","0","40","3",
      "0","ARC","10","1","20","1","40","2","50","0","51","180"
    );
    const { ops } = parseDxf(text);
    expect(ops.map(o=>o.op)).toEqual(["addLine","addCircleProfile","addArc"]);
  });

  it("handles LWPOLYLINE duplicate closing vertex when closed", () => {
    // Closed square where last vertex duplicates first — should still be 4 distinct points
    const text = entitiesSection(
      "0","LWPOLYLINE","70","1","10","0","20","0","10","10","20","0","10","10","20","10","10","0","20","10","10","0","20","0"
    );
    const { ops } = parseDxf(text);
    expect(ops.length).toBe(1);
    const poly = ops[0] as { points:[number,number,number][] };
    expect(poly.points.length).toBe(4);
  });

  it("parseDxfRawEntities returns raw entity list", () => {
    const text = entitiesSection("0","LINE","10","0","20","0","11","1","21","1");
    const raw = parseDxfRawEntities(text);
    expect(raw.some(r=>r.type==="LINE")).toBe(true);
  });

  it("Y coordinates are not negated (Y-up native, unlike SVG)", () => {
    const text = entitiesSection("0","LINE","10","0","20","5","11","10","21","5");
    const { ops } = parseDxf(text);
    const line = ops[0] as { op:"addLine"; start:[number,number,number] };
    expect(line.start[1]).toBe(5);
  });
});
