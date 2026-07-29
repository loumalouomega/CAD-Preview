import { describe, it, expect } from "vitest";
import { detectStepLengthUnit, stepUnitLabel } from "./stepUnits";

describe("detectStepLengthUnit", () => {
  it("returns undefined when there is no unit context at all", () => {
    expect(detectStepLengthUnit("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;")).toBeUndefined();
  });

  it("detects a plain SI millimetre unit", () => {
    const text = `
      #115=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
      #125=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#115))REPRESENTATION_CONTEXT('',''));
    `;
    expect(detectStepLengthUnit(text)).toBe("MILLIMETRE");
  });

  it("detects a plain SI centimetre unit with no prefix-dot ambiguity", () => {
    const text = `
      #10=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.CENTI.,.METRE.));
      #20=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#10))REPRESENTATION_CONTEXT('',''));
    `;
    expect(detectStepLengthUnit(text)).toBe("CENTIMETRE");
  });

  it("prefers the conversion-based unit assigned by GLOBAL_UNIT_ASSIGNED_CONTEXT over an intermediate SI basis unit", () => {
    // Mirrors bull.stp's real shape: #115 is the CENTIMETRE basis the INCH
    // conversion factor is defined against, but #121 (INCH) is what's
    // actually assigned to the representation context.
    const text = `
      #115=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.CENTI.,.METRE.));
      #121=(CONVERSION_BASED_UNIT('INCH',#117)LENGTH_UNIT()NAMED_UNIT(#116));
      #125=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#101,#107,#121))REPRESENTATION_CONTEXT('',''));
    `;
    expect(detectStepLengthUnit(text)).toBe("INCH");
  });

  it("falls back to scanning every LENGTH_UNIT() entity when there is no GLOBAL_UNIT_ASSIGNED_CONTEXT", () => {
    const text = `#121=(CONVERSION_BASED_UNIT('FOOT',#117)LENGTH_UNIT()NAMED_UNIT(#116));`;
    expect(detectStepLengthUnit(text)).toBe("FOOT");
  });

  it("handles a unit entity split across multiple lines", () => {
    const text = `
      #121=(
        CONVERSION_BASED_UNIT('INCH',#117)
        LENGTH_UNIT()
        NAMED_UNIT(#116)
      );
      #125=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#121))REPRESENTATION_CONTEXT('',''));
    `;
    expect(detectStepLengthUnit(text)).toBe("INCH");
  });

  it("returns undefined when GLOBAL_UNIT_ASSIGNED_CONTEXT ids don't resolve to any LENGTH_UNIT entity", () => {
    const text = `
      #125=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#999))REPRESENTATION_CONTEXT('',''));
    `;
    expect(detectStepLengthUnit(text)).toBeUndefined();
  });
});

describe("stepUnitLabel", () => {
  it("maps known STEP unit names to short labels", () => {
    expect(stepUnitLabel("MILLIMETRE")).toBe("mm");
    expect(stepUnitLabel("CENTIMETRE")).toBe("cm");
    expect(stepUnitLabel("METRE")).toBe("m");
    expect(stepUnitLabel("INCH")).toBe("in");
    expect(stepUnitLabel("FOOT")).toBe("ft");
  });

  it("passes through an unrecognized unit name as-is", () => {
    expect(stepUnitLabel("PARSEC")).toBe("PARSEC");
  });
});
