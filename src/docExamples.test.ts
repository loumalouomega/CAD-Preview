import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { EXAMPLE_FENCE, extractDocExamples, parseDocExample, readDocExamples } from "./docExamples";
import { compileParametricScript } from "./parametricScript";
import { explainEditOpRejection } from "./mcpTools";

// `__dirname`-relative, matching `gltfParser.crossvalidation.test.ts`'s own way
// of reaching a repo-root sibling directory from a test in `src/`.
const DOC_ROOT = path.join(__dirname, "..", "doc");

describe("extractDocExamples", () => {
  it("pulls only parametric-fenced blocks, with 1-based opening-fence lines", () => {
    const md = [
      "# Title",                       // 1
      "",                              // 2
      "```json",                       // 3
      '{ "ignored": true }',           // 4
      "```",                           // 5
      "",                              // 6
      "```" + EXAMPLE_FENCE,           // 7
      "[]",                            // 8
      "```",                           // 9
    ].join("\n");
    const found = extractDocExamples("a.md", md);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: "a.md", line: 7, source: "[]" });
  });

  it("is case-insensitive on the info string and handles an indented fence", () => {
    const md = ["- item:", "", "  ```Parametric", "  []", "  ```"].join("\n");
    const found = extractDocExamples("a.md", md);
    expect(found).toHaveLength(1);
    // The block's own indent is stripped so the body parses as JSON.
    expect(found[0].source).toBe("[]");
  });

  it("ignores an unterminated fence rather than throwing", () => {
    expect(extractDocExamples("a.md", "```" + EXAMPLE_FENCE + "\n[]")).toEqual([]);
  });

  it("does not treat a fenced block that merely mentions the language as a block", () => {
    expect(extractDocExamples("a.md", "```json\n```" + EXAMPLE_FENCE + "\n```")).toEqual([]);
  });
});

describe("parseDocExample", () => {
  it("wraps a bare op array into a {steps} script", () => {
    const r = parseDocExample('[{"op":"addBox","center":[0,0,0],"size":[1,1,1]}]');
    expect(r).toEqual({ script: { steps: [{ op: { op: "addBox", center: [0, 0, 0], size: [1, 1, 1] } }] } });
  });

  it("passes a {variables, steps} document through unchanged", () => {
    const r = parseDocExample('{"variables":[],"steps":[]}');
    expect(r).toEqual({ script: { variables: [], steps: [] } });
  });

  it("reports a problem instead of throwing for bad JSON or a wrong shape", () => {
    expect(parseDocExample("{nope}")).toHaveProperty("problem", expect.stringContaining("not valid JSON"));
    expect(parseDocExample('{"ops":[]}')).toHaveProperty("problem", expect.stringContaining("no `steps` array"));
    expect(parseDocExample('"a string"')).toHaveProperty("problem", expect.stringContaining("got string"));
  });
});

/**
 * The gate itself: every ```parametric block committed under `doc/` must
 * compile. This is what catches the three documented rot classes — a syntax
 * error in an example, an example naming an op kind or field that no longer
 * exists, and a block that compiles but produces nothing.
 *
 * Compile-only by design: `validateEditOp` checks an entity id's *shape*, not
 * that `edge-12` resolves against real geometry. Ids in the tutorials are
 * confirmed against the live kernel once, at authoring time.
 */
describe("doc examples compile", () => {
  const examples = readDocExamples(DOC_ROOT);

  it("finds at least one example to check", () => {
    expect(examples.length, "no ```" + EXAMPLE_FENCE + " blocks found under doc/ — has the fence been renamed?").toBeGreaterThan(0);
  });

  it.each(examples.map((e) => [`${e.file}:${e.line}`, e] as const))("%s", (where, example) => {
    const parsed = parseDocExample(example.source);
    expect("problem" in parsed ? `${where} — ${parsed.problem}` : null).toBeNull();
    if ("problem" in parsed) return;

    const compiled = compileParametricScript(parsed.script, {});

    // `parametricScript`'s own reason for a bad op is the generic "invalid op";
    // `explainEditOpRejection` rewrites it into a message quoting that kind's
    // expected parameter shape, so a failure here says what to fix.
    const failures: string[] = [];
    compiled.report.forEach((step, i) => {
      if (step.rejected === 0) return;
      const raw = stepOpsOf(parsed.script, i);
      // A plain step's reason is `"invalid op"`; a repeat step's is
      // `"iteration N: invalid op"` — enrich both.
      // A repeat step reports one reason PER ITERATION, so a single bad op in
      // a `times: 6` loop yields six identical messages — dedupe after
      // stripping the iteration prefix so the failure stays readable.
      const detail = [
        ...new Set(
          step.reasons.map((reason) => {
            const m = /^(?:iteration \d+: )?(.*)$/.exec(reason);
            const body = m ? m[1] : reason;
            return body === "invalid op" && raw.length > 0 ? explainEditOpRejection(raw[0]) : body;
          })
        ),
      ].join("; ");
      failures.push(`step ${step.index + 1} (${step.kind}): ${detail}`);
    });

    expect(failures, `${where} — ${failures.join(" | ")}`).toEqual([]);
    expect(compiled.issues, `${where} — ${compiled.issues.join(" | ")}`).toEqual([]);
    expect(compiled.truncated, `${where} — hit a compile cap`).toBe(false);
    expect(compiled.ops.length, `${where} — compiled to zero ops`).toBeGreaterThan(0);
  });
});

/** The raw op objects a given step contributes, for the enriched message. */
function stepOpsOf(script: unknown, index: number): unknown[] {
  const steps = (script as { steps?: unknown[] }).steps;
  const step = Array.isArray(steps) ? (steps[index] as { op?: unknown; repeat?: { body?: unknown[] } }) : undefined;
  if (!step) return [];
  if (step.op !== undefined) return [step.op];
  if (Array.isArray(step.repeat?.body)) return step.repeat.body;
  return [];
}
