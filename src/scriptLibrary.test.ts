import { describe, expect, it } from "vitest";
import {
  SCRIPT_LIBRARY_VERSION,
  mergeScriptOverrides,
  parseScriptLibraryJson,
  scriptParameters,
  serializeScriptLibraryJson,
  type ScriptLibrary,
} from "./scriptLibrary";

const boltCircle = {
  variables: [
    { name: "R", expr: "20" },
    { name: "N", expr: "4" },
  ],
  steps: [{ repeat: { times: "N", indexVar: "i", body: [{ op: "addCylinder" }] } }],
};

const library: ScriptLibrary = {
  "bolt-circle": { name: "bolt-circle", description: "A ring of holes", script: boltCircle },
};

describe("serialize / parse round trip", () => {
  it("round-trips a library unchanged", () => {
    expect(parseScriptLibraryJson(serializeScriptLibraryJson(library))).toEqual(library);
  });

  it("writes the version and a trailing newline, like every other sidecar", () => {
    const text = serializeScriptLibraryJson(library);
    expect(JSON.parse(text).version).toBe(SCRIPT_LIBRARY_VERSION);
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("parseScriptLibraryJson", () => {
  it("returns an empty library rather than throwing on junk", () => {
    expect(parseScriptLibraryJson("")).toEqual({});
    expect(parseScriptLibraryJson("not json at all")).toEqual({});
    expect(parseScriptLibraryJson("null")).toEqual({});
    expect(parseScriptLibraryJson("[]")).toEqual({});
    expect(parseScriptLibraryJson('{"version":1}')).toEqual({});
    expect(parseScriptLibraryJson('{"version":1,"scripts":[]}')).toEqual({});
  });

  it("drops a malformed entry but keeps its healthy siblings", () => {
    // The whole point of the tolerant convention: one bad hand-edit must not
    // cost you the rest of your macros.
    const text = JSON.stringify({
      version: 1,
      scripts: {
        good: { name: "good", script: { steps: [] } },
        noScript: { name: "noScript" },
        scriptIsArray: { name: "scriptIsArray", script: [] },
        scriptIsString: { name: "scriptIsString", script: "steps" },
        nullEntry: null,
      },
    });
    expect(Object.keys(parseScriptLibraryJson(text))).toEqual(["good"]);
  });

  it("falls back to the object key when the entry has no usable name", () => {
    const text = JSON.stringify({ version: 1, scripts: { "from-key": { script: { steps: [] } } } });
    expect(parseScriptLibraryJson(text)["from-key"].name).toBe("from-key");
  });

  it("prefers the entry's own name field over its key", () => {
    const text = JSON.stringify({ version: 1, scripts: { stale: { name: "real", script: { steps: [] } } } });
    const lib = parseScriptLibraryJson(text);
    expect(Object.keys(lib)).toEqual(["real"]);
  });

  it("drops an entry whose name is unusable in every source", () => {
    const text = JSON.stringify({ version: 1, scripts: { "   ": { script: { steps: [] } } } });
    expect(parseScriptLibraryJson(text)).toEqual({});
  });

  it("keeps a description only when it is a string", () => {
    const text = JSON.stringify({
      version: 1,
      scripts: {
        a: { name: "a", description: "kept", script: { steps: [] } },
        b: { name: "b", description: 42, script: { steps: [] } },
      },
    });
    const lib = parseScriptLibraryJson(text);
    expect(lib.a.description).toBe("kept");
    expect(lib.b.description).toBeUndefined();
  });

  it("does not validate the script body — that is compileParametricScript's job", () => {
    // Storing a script whose steps are nonsense must still round-trip, so the
    // error surfaces at run time with a real per-step report rather than the
    // macro silently vanishing from the library.
    const text = JSON.stringify({ version: 1, scripts: { x: { name: "x", script: { steps: "nonsense" } } } });
    expect(parseScriptLibraryJson(text).x.script).toEqual({ steps: "nonsense" });
  });
});

describe("scriptParameters", () => {
  it("reads the script's own variables block as its parameter list", () => {
    expect(scriptParameters(boltCircle)).toEqual([
      { name: "R", expr: "20" },
      { name: "N", expr: "4" },
    ]);
  });

  it("returns nothing for a script with no variables, or a malformed one", () => {
    expect(scriptParameters({ steps: [] })).toEqual([]);
    expect(scriptParameters({ variables: "R" })).toEqual([]);
    expect(scriptParameters({ variables: [null, 3, { name: "ok", expr: "1" }, { name: "noExpr" }] })).toEqual([
      { name: "ok", expr: "1" },
    ]);
  });
});

describe("mergeScriptOverrides", () => {
  it("replaces a declared variable's expression by name", () => {
    const { script, unknownNames } = mergeScriptOverrides(boltCircle, { R: 35 });
    expect(script.variables).toEqual([
      { name: "R", expr: "35", value: 0 },
      { name: "N", expr: "4", value: 0 },
    ]);
    expect(unknownNames).toEqual([]);
  });

  it("writes a numeric override as a literal string, so it flows through the normal expression path", () => {
    const { script } = mergeScriptOverrides(boltCircle, { N: 8 });
    const vars = script.variables as { name: string; expr: string }[];
    expect(vars.find((v) => v.name === "N")!.expr).toBe("8");
  });

  it("accepts an expression override, not just a number", () => {
    const { script } = mergeScriptOverrides(boltCircle, { R: "N*3" });
    const vars = script.variables as { name: string; expr: string }[];
    expect(vars.find((v) => v.name === "R")!.expr).toBe("N*3");
  });

  it("reports an undeclared override instead of inventing the variable", () => {
    // Inventing it would shadow a document variable of the same name for this
    // compile — a surprising thing to do on a typo.
    const { script, unknownNames } = mergeScriptOverrides(boltCircle, { RADIUS: 35 });
    expect(unknownNames).toEqual(["RADIUS"]);
    expect(script.variables).toEqual([
      { name: "R", expr: "20", value: 0 },
      { name: "N", expr: "4", value: 0 },
    ]);
  });

  it("never mutates the stored script", () => {
    const stored = { variables: [{ name: "R", expr: "20" }], steps: [] };
    mergeScriptOverrides(stored, { R: 99 });
    expect(stored.variables).toEqual([{ name: "R", expr: "20" }]);
  });

  it("passes the script through untouched when there is nothing to override", () => {
    expect(mergeScriptOverrides(boltCircle, undefined).script).toEqual(boltCircle);
    expect(mergeScriptOverrides(boltCircle, {}).script).toEqual(boltCircle);
  });

  it("drops a malformed declared variable during an override pass", () => {
    const messy = { variables: [{ name: "R", expr: "1" }, null, { name: "bad" }], steps: [] };
    const { script } = mergeScriptOverrides(messy as Record<string, unknown>, { R: 2 });
    expect(script.variables).toEqual([{ name: "R", expr: "2", value: 0 }]);
  });
});
