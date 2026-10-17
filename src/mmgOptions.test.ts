import { describe, expect, it } from "vitest";
import { validateMmgOptions } from "./mmgOptions";

describe("MMG options", () => {
  it("keeps omission distinct from an explicit absolute bound", () => {
    expect(validateMmgOptions({})).toEqual({});
    expect(validateMmgOptions({ hausd: 0.01, hausdRelative: false, hgrad: 1 })).toEqual({ hausd: 0.01, hausdRelative: false, hgrad: 1 });
  });
  it("accepts a field to adapt to, with an optional strength, and rejects the nonsensical", () => {
    expect(validateMmgOptions({ adaptField: "Temperature", adaptStrength: 3 })).toEqual({ adaptField: "Temperature", adaptStrength: 3 });
    for (const value of [{ adaptField: "" }, { adaptField: 5 }, { adaptStrength: 3 }, { adaptField: "f", adaptStrength: 0 }, { adaptField: "f", adaptStrength: 5000 }]) expect(() => validateMmgOptions(value)).toThrow();
  });
  it("rejects invalid, unknown and contradictory options", () => {
    for (const value of [null, [], { hausd: NaN }, { hmax: Infinity }, { hmin: -1 }, { hgrad: 0.9 }, { hausdRelative: 1 }, { optimOnly: true }, { memoryMb: 1000 }, { hmin: 2, hmax: 1 }]) expect(() => validateMmgOptions(value)).toThrow();
  });
});
