import { describe, expect, it } from "vitest";
import { DETERMINISTIC_STEP_TIMESTAMP, normalizeStepForDeterminism, stepHasNonFiniteNumber } from "./deterministicHeader";

const header = (ts: string) =>
  `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Open CASCADE Model'),'2;1');\nFILE_NAME('Open CASCADE Shape Model','${ts}',('Author'),(\n    'Open CASCADE'),'Open CASCADE STEP processor 7.4','Open CASCADE 7.4'\n  ,'Unknown');\nENDSEC;\nDATA;\n`;

const assembly = (counter: number, nauoStart: number) =>
  `#7 = PRODUCT('Open CASCADE STEP translator 7.4 ${counter}',\n  'Open CASCADE STEP translator 7.4 ${counter}','',(#8));\n` +
  `#3565 = PRODUCT('Open CASCADE STEP translator 7.4 ${counter}.1',\n  'Open CASCADE STEP translator 7.4 ${counter}.1','',(#3566));\n` +
  `#3572 = NEXT_ASSEMBLY_USAGE_OCCURRENCE('${nauoStart}','','',#5,#3563,$);\n` +
  `#3621 = NEXT_ASSEMBLY_USAGE_OCCURRENCE('${nauoStart + 1}','','',#3576,#3612,$);\n` +
  `#3642 = PRODUCT('Open CASCADE STEP translator 7.4 ${counter}.2.2',\n  'Open CASCADE STEP translator 7.4 ${counter}.2.2','',(#3643));\n`;

describe("normalizeStepForDeterminism", () => {
  it("makes two exports of one model, one process-counter apart, byte-identical", () => {
    const first = header("2026-10-13T19:00:49") + assembly(1, 1);
    const second = header("2026-10-13T19:00:51") + assembly(2, 5);
    expect(first).not.toBe(second);
    expect(normalizeStepForDeterminism(first)).toBe(normalizeStepForDeterminism(second));
  });

  it("fixes the timestamp to a constant of the same length", () => {
    const out = normalizeStepForDeterminism(header("2026-10-13T19:00:49"));
    expect(out).toContain(`'${DETERMINISTIC_STEP_TIMESTAMP}'`);
    expect(out.length).toBe(header("2026-10-13T19:00:49").length);
  });

  it("changes only the translator counter, keeping the assembly position", () => {
    const out = normalizeStepForDeterminism(assembly(7, 1));
    expect(out).toContain("translator 7.4 1',");
    expect(out).toContain("translator 7.4 1.1'");
    expect(out).toContain("translator 7.4 1.2.2'");
    expect(out).not.toContain("7.4 7");
  });

  it("renumbers occurrence ids sequentially in file order", () => {
    const out = normalizeStepForDeterminism(assembly(3, 40));
    const ids = [...out.matchAll(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\('(\d+)'/g)].map((m) => m[1]);
    expect(ids).toEqual(["1", "2"]);
  });

  it("removes OCCT's counter-dependent line wrapping from the statements it rewrites", () => {
    // Measured: the same occurrence line is wrapped before `);` in one export
    // and not in the next, purely because a longer id crossed the column limit.
    const wrapped = "#4031 = NEXT_ASSEMBLY_USAGE_OCCURRENCE('16','=>[0:1:1:7]','',#5,#4022,$\n  );\n#4032 = PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#4024));\n";
    const flat = "#4031 = NEXT_ASSEMBLY_USAGE_OCCURRENCE('6','=>[0:1:1:7]','',#5,#4022,$);\n#4032 = PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#4024));\n";
    expect(normalizeStepForDeterminism(wrapped)).toBe(normalizeStepForDeterminism(flat));
  });

  it("leaves wrapping of statements without a moving field alone", () => {
    const text = "#9 = ADVANCED_FACE('',(#10,\n  #11),#12,.T.);\n";
    expect(normalizeStepForDeterminism(text)).toBe(text);
  });

  it("is idempotent", () => {
    const once = normalizeStepForDeterminism(header("2026-10-13T19:00:49") + assembly(9, 17));
    expect(normalizeStepForDeterminism(once)).toBe(once);
  });

  it("leaves a named-Part (XCAF) file's product names alone", () => {
    const text = header("2026-10-13T19:00:49") + "#7 = PRODUCT('Body','Body','',(#8));\n";
    expect(normalizeStepForDeterminism(text)).toBe(header(DETERMINISTIC_STEP_TIMESTAMP) + "#7 = PRODUCT('Body','Body','',(#8));\n");
  });

  it("rewrites only the timestamp and counters, leaving geometry and length untouched", () => {
    const foreign = "FILE_NAME('x.stp','1999-02-12T14:55:45',('a'),('b'),'p','o','');\n#1 = CARTESIAN_POINT('',(1.,2.,3.));\n";
    // A foreign FILE_NAME timestamp has the same shape, so it IS rewritten —
    // callers apply this only to files this extension just wrote. Everything
    // else, including geometry, must be byte-identical.
    const out = normalizeStepForDeterminism(foreign);
    expect(out).toContain("CARTESIAN_POINT('',(1.,2.,3.))");
    expect(out.length).toBe(foreign.length);
  });

  it("returns text without any of the fields unchanged", () => {
    const text = "ISO-10303-21;\nDATA;\n#1 = CARTESIAN_POINT('',(0.,0.,0.));\nENDSEC;\n";
    expect(normalizeStepForDeterminism(text)).toBe(text);
  });
});

describe("stepHasNonFiniteNumber", () => {
  it("finds the observed -NAN knot", () => {
    expect(stepHasNonFiniteNumber("  .F.,(2,2),(          -NAN,1.),.PIECEWISE_BEZIER_KNOTS.);")).toBe(true);
    expect(stepHasNonFiniteNumber("#1 = CARTESIAN_POINT('',(NAN,0.,1.));")).toBe(true);
  });
  it("ignores ordinary numbers and names that merely contain the letters", () => {
    expect(stepHasNonFiniteNumber("  .F.,(2,2),(0.,1.),.PIECEWISE_BEZIER_KNOTS.);")).toBe(false);
    expect(stepHasNonFiniteNumber("#7 = PRODUCT('BANANA','BANANA','',(#8));")).toBe(false);
  });
});
