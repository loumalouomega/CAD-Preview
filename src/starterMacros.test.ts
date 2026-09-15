import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { compileParametricScript } from "./parametricScript";
import { parseScriptLibraryJson } from "./scriptLibrary";
import { BUNDLED_MACROS_FILE, bundledMacrosPath, mergeScriptLibraries } from "./starterMacros";

const REPO_MACROS = path.join(__dirname, "..", "macros", BUNDLED_MACROS_FILE);

describe("bundledMacrosPath", () => {
  it("resolves under dist/macros like the WASM binaries resolve under dist/", () => {
    expect(bundledMacrosPath("/ext")).toBe("/ext/dist/macros/starter-library.json");
  });
});

describe("mergeScriptLibraries", () => {
  it("unions both sides with the caller winning collisions, reported not silent", () => {
    const { merged, collisions } = mergeScriptLibraries(
      { spring: { name: "spring", script: {} }, flange: { name: "flange", script: {} } },
      { spring: { name: "spring", script: { steps: [] } } }
    );
    expect(Object.keys(merged).sort()).toEqual(["flange", "spring"]);
    expect(merged.spring.script).toEqual({ steps: [] });
    expect(collisions).toEqual(["spring"]);
  });

  it("merges two empty libraries to empty with no collisions", () => {
    expect(mergeScriptLibraries({}, {})).toEqual({ merged: {}, collisions: [] });
  });
});

describe("the shipped starter library", () => {
  const text = fs.readFileSync(REPO_MACROS, "utf8");
  const library = parseScriptLibraryJson(text);

  it("parses to exactly the three documented starters", () => {
    expect(Object.keys(library).sort()).toEqual(["bolt-circle-flange", "hex-bolt", "spring"]);
  });

  it("every starter compiles standalone to a non-empty op list with no rejections", () => {
    for (const [name, entry] of Object.entries(library)) {
      const compiled = compileParametricScript(entry.script, {});
      const rejected = compiled.report.reduce((n, r) => n + r.rejected, 0);
      expect(
        { ops: compiled.ops.length, rejected, truncated: compiled.truncated, issues: compiled.issues },
        `${name} must compile cleanly`
      ).toEqual({ ops: expect.any(Number), rejected: 0, truncated: false, issues: [] });
      expect(compiled.ops.length).toBeGreaterThan(0);
    }
  });

  it("spring wires the circle to the helix (face-0, edge-1 on a blank base)", () => {
    const compiled = compileParametricScript(library.spring.script, {});
    expect(compiled.ops.map((o) => o.op)).toEqual(["addCircleProfile", "addHelix", "sweep"]);
    const sweep = compiled.ops[2] as { profile?: string; path?: string };
    expect(sweep.profile).toBe("face-0");
    expect(sweep.path).toBe("edge-1");
  });

  it("every starter declares its parameters via its variables block (no separate schema)", () => {
    const params = (name: string) =>
      ((library[name].script as Record<string, unknown>).variables as Array<{ name: string }>)?.map((v) => v.name);
    expect(params("spring")).toEqual(["R", "W", "P", "N"]);
    expect(params("bolt-circle-flange")).toEqual(["R", "N"]);
    expect(params("hex-bolt")).toEqual(["headR", "headH", "shaftR", "shaftL"]);
  });
});
