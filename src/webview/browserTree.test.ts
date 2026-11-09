import { describe, it, expect } from "vitest";
import { buildBrowser, filterBrowser, splitSketches, collapseAll, expandAll, parseRowId, type BrowserInputs } from "./browserTree";

const inputs = (over: Partial<BrowserInputs> = {}): BrowserInputs => ({
  document: { name: "bracket.step", format: "STEP", unit: "mm", unsavedEdits: 0 },
  bookmarkNames: ["Front", "Detail"],
  planes: [{ id: "plane-1", name: "Mid" }],
  gridVisible: true,
  bodies: [
    { id: "solid-0", label: "Base", faceCount: 6, hidden: false, color: "#336699" },
    { id: "solid-1", label: "Lug", faceCount: 8, hidden: true },
  ],
  sketches: { id: "solid-2", hidden: false, faceCount: 1, guide: false },
  ops: [
    { label: "Box", suppressed: false, baked: true, guide: false },
    { label: "Fillet", suppressed: true, baked: false, guide: false, folder: "Finish" },
  ],
  parts: [{ name: "Body", color: "#ff0000", hidden: false }],
  layers: [
    { id: "layer-1", name: "Hidden", color: "#00ff00", visible: false },
    { id: "layer-2", name: "Shown", color: "#0000ff", visible: true },
  ],
  ...over,
});

const group = (g: ReturnType<typeof buildBrowser>, id: string) => g.find((x) => x.id === id)!;

describe("buildBrowser", () => {
  it("emits the eight groups in order", () => {
    expect(buildBrowser(inputs()).map((g) => g.id)).toEqual(["document", "views", "origin", "bodies", "sketches", "features", "parts", "layers"]);
  });

  it("reflects body, part and layer visibility on the eyes and aggregates the group eye", () => {
    const g = buildBrowser(inputs());
    expect(group(g, "bodies").rows.map((r) => r.eye)).toEqual(["on", "off"]);
    expect(group(g, "bodies").eye).toBe("mixed");
    expect(group(g, "layers").rows.map((r) => r.eye)).toEqual(["off", "on"]);
    expect(group(g, "parts").eye).toBe("on");
    expect(group(g, "document").eye).toBeNull();
    expect(group(g, "views").eye).toBeNull();
  });

  it("gives a Part colour to the body, and none when no Part lists it", () => {
    const rows = group(buildBrowser(inputs()), "bodies").rows;
    expect(rows[0].color).toBe("#336699");
    expect(rows[1].color).toBeUndefined();
  });

  it("a baked feature has no eye (cannot be suppressed); a suppressed one is dimmed and off", () => {
    const rows = group(buildBrowser(inputs()), "features").rows;
    expect(rows[0]).toMatchObject({ id: "op:0", eye: null, detail: "baked" });
    expect(rows[1]).toMatchObject({ id: "op:1", eye: "off", muted: true, detail: "Finish" });
  });

  it("shows unsaved edits and no Sketches row when the model has none", () => {
    const g = buildBrowser(inputs({ sketches: null, document: { name: "", format: null, unit: "in", unsavedEdits: 3 } }));
    expect(group(g, "sketches").rows).toEqual([]);
    expect(group(g, "document").rows.map((r) => [r.label, r.detail])).toEqual([["Untitled", undefined], ["Display unit", "in"], ["Unsaved edits", "3"]]);
  });

  it("dims guide-only Sketches and labels them", () => {
    const r = group(buildBrowser(inputs({ sketches: { id: "solid-2", hidden: true, guide: true } })), "sketches").rows[0];
    expect(r).toMatchObject({ label: "Sketches (guide)", eye: "off", muted: true });
  });

  it("Origin carries the axes/grid eye plus one row per construction plane", () => {
    const rows = group(buildBrowser(inputs({ gridVisible: false })), "origin").rows;
    expect(rows.map((r) => [r.id, r.eye])).toEqual([["origin:grid", "off"], ["plane:plane-1", null]]);
  });
});

describe("splitSketches", () => {
  it("separates the synthetic Sketches leaf from real bodies", () => {
    const { bodies, sketches } = splitSketches([{ label: "A" }, { label: "Sketches" }, { label: "B" }]);
    expect(bodies.map((b) => b.label)).toEqual(["A", "B"]);
    expect(sketches?.label).toBe("Sketches");
    expect(splitSketches([{ label: "A" }]).sketches).toBeNull();
  });
});

describe("filterBrowser", () => {
  const groups = buildBrowser(inputs());
  it("a blank query returns everything", () => {
    expect(filterBrowser(groups, "  ")).toBe(groups);
  });
  it("keeps only matching rows, case-insensitively, and drops empty groups", () => {
    const out = filterBrowser(groups, "FILL");
    expect(out.map((g) => g.id)).toEqual(["features"]);
    expect(out[0].rows.map((r) => r.label)).toEqual(["Fillet"]);
  });
  it("a matching group title keeps all its rows", () => {
    const out = filterBrowser(groups, "layers");
    expect(out).toHaveLength(1);
    expect(out[0].rows).toHaveLength(2);
  });
  it("matches the detail text too", () => {
    expect(filterBrowser(groups, "baked")[0].rows.map((r) => r.id)).toEqual(["op:0"]);
  });
});

describe("expand/collapse and ids", () => {
  it("collapseAll lists every group, expandAll none", () => {
    expect(collapseAll(buildBrowser(inputs())).size).toBe(8);
    expect(expandAll().size).toBe(0);
  });
  it("parseRowId splits kind and key, tolerating colons in the key", () => {
    expect(parseRowId("body:solid-0")).toEqual({ kind: "body", key: "solid-0" });
    expect(parseRowId("plane:a:b")).toEqual({ kind: "plane", key: "a:b" });
    expect(parseRowId("nocolon")).toBeNull();
    expect(parseRowId(":x")).toBeNull();
    expect(parseRowId("x:")).toBeNull();
  });
});
