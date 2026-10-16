import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseProcessLimits, resolvePlate, resolveProcess } from "./processLimits";

const bundled = parseProcessLimits(fs.readFileSync(path.join(__dirname, "..", "process-limits", "starter-limits.json"), "utf8"));

describe("bundled process limits", () => {
  it("parses every shipped row and every row states its source", () => {
    expect(Object.keys(bundled.processes).sort()).toEqual(["fdm", "mjf", "sla", "sls"]);
    for (const p of Object.values(bundled.processes)) expect(p.source.length).toBeGreaterThan(10);
    for (const p of Object.values(bundled.plates)) expect(p.source.length).toBeGreaterThan(5);
    expect(Object.keys(bundled.plates)).toContain("prusa-mk4");
  });
  it("FDM has both limits; powder-bed rows have no overhang limit", () => {
    expect(bundled.processes.fdm).toMatchObject({ minWallMm: 0.8, maxOverhangDeg: 45 });
    expect(bundled.processes.sls.maxOverhangDeg).toBeUndefined();
  });
});

describe("parseProcessLimits", () => {
  it("drops bad rows, never the file", () => {
    const lib = parseProcessLimits(JSON.stringify({ processes: { ok: { minWallMm: 1, source: "s" }, nosource: { minWallMm: 1 }, neg: { minWallMm: -1, source: "s" }, empty: { source: "s" } }, plates: { p: { x: 1, y: 2, z: 3, source: "s" }, bad: { x: 0, y: 1, z: 1, source: "s" } } }));
    expect(Object.keys(lib.processes)).toEqual(["ok"]);
    expect(Object.keys(lib.plates)).toEqual(["p"]);
    expect(parseProcessLimits("not json")).toEqual({ processes: {}, plates: {} });
  });
});

describe("resolveProcess / resolvePlate", () => {
  it("resolves by name case-insensitively and rejects an unknown name naming the choices", () => {
    expect(resolveProcess("FDM", bundled)?.name).toBe("fdm");
    expect(() => resolveProcess("laser", bundled)).toThrow(/Unknown process "laser".*fdm/);
    expect(resolvePlate("Prusa-MK4", bundled)).toEqual({ x: 250, y: 210, z: 220 });
    expect(() => resolvePlate("nope", bundled)).toThrow(/Unknown build plate/);
  });
  it("inline numbers win, default their basis, and are validated", () => {
    expect(resolveProcess({ minWallMm: 1.2 }, bundled)).toEqual({ name: "custom", minWallMm: 1.2, source: "caller-supplied" });
    expect(() => resolveProcess({}, bundled)).toThrow(/needs minWallMm/);
    expect(() => resolveProcess({ maxOverhangDeg: 90 }, bundled)).toThrow(/between 0 and 90/);
    expect(() => resolvePlate({ x: 1, y: 0, z: 1 }, bundled)).toThrow(/positive/);
    expect(resolveProcess(undefined, bundled)).toBeUndefined();
  });
});
