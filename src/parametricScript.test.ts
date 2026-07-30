import { describe, it, expect } from "vitest";
import { compileParametricScript } from "./parametricScript";

describe("compileParametricScript", () => {
  it("compiles a plain op step exactly like apply_edit_ops would validate it", () => {
    const result = compileParametricScript(
      { steps: [{ op: { op: "addBox", center: [0, 0, 0], size: [1, 1, 1] } }] },
      {}
    );
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0].op).toBe("addBox");
    expect(result.report).toEqual([{ index: 0, kind: "op", applied: 1, rejected: 0, reasons: [] }]);
  });

  it("rejects a malformed op without throwing, reports the reason", () => {
    const result = compileParametricScript({ steps: [{ op: { op: "addBox" } }] }, {});
    expect(result.ops).toHaveLength(0);
    expect(result.report[0]).toMatchObject({ kind: "op", applied: 0, rejected: 1 });
  });

  it("a plain op step's exprs pass through untouched (stay live)", () => {
    const result = compileParametricScript(
      {
        steps: [
          { op: { op: "addBox", center: [0, 0, 0], size: [20, 10, 5], exprs: { "size[0]": "L" } } },
        ],
      },
      { L: 20 }
    );
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0].exprs).toEqual({ "size[0]": "L" });
  });

  it("expands a repeat block `times` times, binding indexVar", () => {
    const result = compileParametricScript(
      {
        steps: [
          {
            repeat: {
              times: 3,
              indexVar: "i",
              body: [{ op: "addBox", center: [0, 0, 0], size: [1, 1, 1], exprs: { "center[0]": "i * 10" } }],
            },
          },
        ],
      },
      {}
    );
    expect(result.ops).toHaveLength(3);
    expect(result.ops.map((o: any) => o.center[0])).toEqual([0, 10, 20]);
    expect(result.report[0]).toMatchObject({ kind: "repeat", applied: 3, rejected: 0 });
  });

  it("repeat-generated ops have exprs stripped (fully baked)", () => {
    const result = compileParametricScript(
      {
        steps: [
          {
            repeat: {
              times: 2,
              indexVar: "i",
              body: [{ op: "addBox", center: [0, 0, 0], size: [1, 1, 1], exprs: { "center[0]": "i * 10" } }],
            },
          },
        ],
      },
      {}
    );
    for (const op of result.ops) expect(op.exprs).toBeUndefined();
  });

  it("a bolt-circle repeat (trig exprs over the loop index and script variables)", () => {
    const result = compileParametricScript(
      {
        variables: [
          { name: "R", expr: "10", value: 0 },
          { name: "N", expr: "4", value: 0 },
        ],
        steps: [
          {
            repeat: {
              times: "N",
              indexVar: "i",
              body: [
                {
                  op: "addCylinder",
                  center: [0, 0, 0],
                  axis: [0, 0, 1],
                  radius: 1,
                  height: 5,
                  exprs: { "center[0]": "R*cos(i*360/N)", "center[1]": "R*sin(i*360/N)" },
                },
              ],
            },
          },
        ],
      },
      {}
    );
    const ops = result.ops as unknown as Array<{ center: [number, number, number] }>;
    expect(ops).toHaveLength(4);
    // i=0 -> angle 0 -> (R, 0)
    expect(ops[0].center[0]).toBeCloseTo(10, 5);
    expect(ops[0].center[1]).toBeCloseTo(0, 5);
    // i=1 -> angle 90 -> (0, R)
    expect(ops[1].center[0]).toBeCloseTo(0, 5);
    expect(ops[1].center[1]).toBeCloseTo(10, 5);
  });

  it("times as an expression referencing a document variable (not just script variables)", () => {
    const result = compileParametricScript(
      { steps: [{ repeat: { times: "N", indexVar: "i", body: [{ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] }] } }] },
      { N: 5 }
    );
    expect(result.ops).toHaveLength(5);
  });

  it("script variables shadow document variables of the same name", () => {
    const result = compileParametricScript(
      {
        variables: [{ name: "N", expr: "2", value: 0 }],
        steps: [{ repeat: { times: "N", indexVar: "i", body: [{ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] }] } }],
      },
      { N: 100 }
    );
    expect(result.ops).toHaveLength(2); // script's N=2 wins over the document's N=100
  });

  it("clamps times to the safety cap and never produces a negative count", () => {
    const tooMany = compileParametricScript(
      { steps: [{ repeat: { times: 10000, indexVar: "i", body: [{ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] }] } }] },
      {}
    );
    expect(tooMany.ops.length).toBeLessThanOrEqual(1000);

    const negative = compileParametricScript(
      { steps: [{ repeat: { times: -5, indexVar: "i", body: [{ op: "addBox", center: [0, 0, 0], size: [1, 1, 1] }] } }] },
      {}
    );
    expect(negative.ops).toHaveLength(0);
  });

  it("rejects a repeat with an invalid indexVar name, without crashing", () => {
    const result = compileParametricScript(
      { steps: [{ repeat: { times: 3, indexVar: "not a valid name!", body: [] } }] },
      {}
    );
    expect(result.ops).toHaveLength(0);
    expect(result.report[0]).toMatchObject({ kind: "repeat", rejected: 1 });
  });

  it("rejects a repeat whose times expression fails to evaluate", () => {
    const result = compileParametricScript(
      { steps: [{ repeat: { times: "undefinedVar * 2", indexVar: "i", body: [] } }] },
      {}
    );
    expect(result.ops).toHaveLength(0);
    expect(result.report[0].reasons[0]).toMatch(/times/);
  });

  it("a bad op inside a repeat body is skipped, other iterations still run", () => {
    const result = compileParametricScript(
      {
        steps: [
          {
            repeat: {
              times: 2,
              indexVar: "i",
              body: [{ op: "addBox" /* missing required fields */ }],
            },
          },
        ],
      },
      {}
    );
    expect(result.ops).toHaveLength(0);
    expect(result.report[0]).toMatchObject({ kind: "repeat", applied: 0, rejected: 2 });
  });

  it("a step with neither op nor repeat is rejected", () => {
    const result = compileParametricScript({ steps: [{}] }, {});
    expect(result.report[0]).toMatchObject({ kind: "invalid", rejected: 1 });
  });

  it("gracefully handles a non-object script", () => {
    expect(compileParametricScript(null, {}).ops).toEqual([]);
    expect(compileParametricScript("nope", {}).ops).toEqual([]);
    expect(compileParametricScript(42, {}).issues.length).toBeGreaterThan(0);
  });

  it("gracefully handles a missing/non-array steps field", () => {
    const result = compileParametricScript({}, {});
    expect(result.ops).toEqual([]);
    expect(result.report).toEqual([]);
  });

  it("truncates and flags scripts with more than the max step count", () => {
    const steps = Array.from({ length: 250 }, () => ({ op: { op: "addBox", center: [0, 0, 0], size: [1, 1, 1] } }));
    const result = compileParametricScript({ steps }, {});
    expect(result.truncated).toBe(true);
    expect(result.report.length).toBe(200);
    expect(result.issues.some((i) => i.includes("200"))).toBe(true);
  });
});
