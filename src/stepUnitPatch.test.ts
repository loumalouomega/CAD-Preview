import { describe, it, expect } from "vitest";
import { patchStepUnitDeclaration } from "./stepUnitPatch";
import { detectStepLengthUnit } from "./stepUnits";

// Mirrors the exact shape OCCT's own STEPControl_Writer emits — verified
// against the live WASM (see stepUnitPatch.ts's doc comment) — a single
// bare-mm LENGTH_UNIT entity referenced from both a GLOBAL_UNIT_ASSIGNED_CONTEXT
// and a paired UNCERTAINTY_MEASURE_WITH_UNIT.
const SINGLE_CONTEXT = `ISO-10303-21;
HEADER;
ENDSEC;
DATA;
#24 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );
#25 = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );
#26 = ( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() );
#27 = UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(2.E-03),#24,
  'DISTANCE_ACCURACY_VALUE','');
#28 = (GEOMETRIC_REPRESENTATION_CONTEXT(3)
  GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#27)) GLOBAL_UNIT_ASSIGNED_CONTEXT(
  (#24,#25,#26)) REPRESENTATION_CONTEXT('Context #1',
  '3D Context with UNIT and UNCERTAINTY') );
ENDSEC;
END-ISO-10303-21;`;

// Mirrors bull.stp's real OCCT-written output: multiple independent
// representation contexts, each with its own private bare-mm entity.
function multiContext(ids: [number, number, number, number][]): string {
  const blocks = ids
    .map(
      ([mm, ang, solid, unc]) => `#${mm} = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );
#${ang} = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );
#${solid} = ( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() );
#${unc} = UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(2.E-03),#${mm},
  'DISTANCE_ACCURACY_VALUE','');
#${unc + 1} = (GEOMETRIC_REPRESENTATION_CONTEXT(3)
  GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT(
  (#${mm},#${ang},#${solid})) REPRESENTATION_CONTEXT('Context #1',
  '3D Context with UNIT and UNCERTAINTY') );`
    )
    .join("\n");
  return `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n${blocks}\nENDSEC;\nEND-ISO-10303-21;`;
}

describe("patchStepUnitDeclaration", () => {
  it("returns the text unchanged for mm (already correct, OCCT's own native output)", () => {
    expect(patchStepUnitDeclaration(SINGLE_CONTEXT, "mm")).toBe(SINGLE_CONTEXT);
  });

  it("relabels a bare-mm entity to centimetres in place, same entity id", () => {
    const patched = patchStepUnitDeclaration(SINGLE_CONTEXT, "cm");
    expect(patched).toContain("#24 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.CENTI.,.METRE.) )");
    expect(detectStepLengthUnit(patched)).toBe("CENTIMETRE");
    // Existing references are untouched — same id, now correctly relabeled.
    expect(patched).toContain("GLOBAL_UNIT_ASSIGNED_CONTEXT(\n  (#24,#25,#26))");
  });

  it("relabels a bare-mm entity to a bare-`$` metre unit in place", () => {
    const patched = patchStepUnitDeclaration(SINGLE_CONTEXT, "m");
    expect(patched).toContain("#24 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($,.METRE.) )");
    expect(detectStepLengthUnit(patched)).toBe("METRE");
  });

  it("appends a shared CONVERSION_BASED_UNIT and redirects both references for inches", () => {
    const patched = patchStepUnitDeclaration(SINGLE_CONTEXT, "in");
    expect(detectStepLengthUnit(patched)).toBe("INCH");
    // The original bare-mm entity's own definition is untouched — reused as the
    // conversion basis.
    expect(patched).toContain("#24 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );");
    // A new, higher-numbered entity carries the actual conversion.
    expect(patched).toMatch(/CONVERSION_BASED_UNIT\('INCH',#\d+\)/);
    expect(patched).toContain("LENGTH_MEASURE(25.4)");
    // Both the GLOBAL_UNIT_ASSIGNED_CONTEXT and UNCERTAINTY_MEASURE_WITH_UNIT
    // references were redirected away from #24.
    expect(patched).not.toMatch(/GLOBAL_UNIT_ASSIGNED_CONTEXT\(\s*\(#24,/);
    expect(patched).not.toMatch(/UNCERTAINTY_MEASURE_WITH_UNIT\(LENGTH_MEASURE\(2\.E-03\),#24,/);
  });

  it("uses a 304.8 factor and the FOOT name for feet", () => {
    const patched = patchStepUnitDeclaration(SINGLE_CONTEXT, "ft");
    expect(detectStepLengthUnit(patched)).toBe("FOOT");
    expect(patched).toMatch(/CONVERSION_BASED_UNIT\('FOOT',#\d+\)/);
    expect(patched).toContain("LENGTH_MEASURE(304.8)");
  });

  it("redirects every context's mm entity when OCCT wrote multiple independent representation contexts", () => {
    const text = multiContext([
      [24, 25, 26, 27],
      [3557, 3558, 3559, 3560],
      [3591, 3592, 3593, 3594],
    ]);
    const patched = patchStepUnitDeclaration(text, "in");
    // Every context's own GLOBAL_UNIT_ASSIGNED_CONTEXT/UNCERTAINTY reference
    // was redirected off its own private mm entity.
    for (const mmId of [24, 3557, 3591]) {
      expect(patched).not.toMatch(new RegExp(`GLOBAL_UNIT_ASSIGNED_CONTEXT\\(\\s*\\(#${mmId},`));
      expect(patched).not.toMatch(new RegExp(`UNCERTAINTY_MEASURE_WITH_UNIT\\(LENGTH_MEASURE\\(2\\.E-03\\),#${mmId},`));
    }
    // Exactly one shared conversion unit was appended, not one per context.
    const conversionMatches = patched.match(/CONVERSION_BASED_UNIT\('INCH',#\d+\)/g);
    expect(conversionMatches).toHaveLength(1);
    expect(detectStepLengthUnit(patched)).toBe("INCH");
  });

  it("leaves text with no OCCT-shaped bare-mm entity untouched (defensive no-op)", () => {
    const text = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;";
    expect(patchStepUnitDeclaration(text, "in")).toBe(text);
  });
});
