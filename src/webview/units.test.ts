import { describe, it, expect } from "vitest";
import { convertLength, convertArea, convertVolume, displayUnitFromUnitName, convertLengthBasedProperties } from "./units";

describe("convertLength/convertArea/convertVolume", () => {
  it("mm is the identity", () => {
    expect(convertLength(25.4, "mm")).toBeCloseTo(25.4);
    expect(convertArea(100, "mm")).toBeCloseTo(100);
    expect(convertVolume(1000, "mm")).toBeCloseTo(1000);
  });

  it("converts length to cm/m/in/ft", () => {
    expect(convertLength(10, "cm")).toBeCloseTo(1);
    expect(convertLength(1000, "m")).toBeCloseTo(1);
    expect(convertLength(25.4, "in")).toBeCloseTo(1);
    expect(convertLength(304.8, "ft")).toBeCloseTo(1);
  });

  it("converts area by the factor squared", () => {
    // 1 in = 25.4 mm, so 1 in^2 = 645.16 mm^2
    expect(convertArea(645.16, "in")).toBeCloseTo(1, 4);
  });

  it("converts volume by the factor cubed", () => {
    // 1 in = 25.4 mm, so 1 in^3 = 16387.064 mm^3
    expect(convertVolume(16387.064, "in")).toBeCloseTo(1, 3);
  });
});

describe("displayUnitFromUnitName", () => {
  it("maps recognized STEP unit names", () => {
    expect(displayUnitFromUnitName("MILLIMETRE")).toBe("mm");
    expect(displayUnitFromUnitName("CENTIMETRE")).toBe("cm");
    expect(displayUnitFromUnitName("METRE")).toBe("m");
    expect(displayUnitFromUnitName("INCH")).toBe("in");
    expect(displayUnitFromUnitName("FOOT")).toBe("ft");
  });

  it("returns undefined for an unrecognized or missing unit name", () => {
    expect(displayUnitFromUnitName("PARSEC")).toBeUndefined();
    expect(displayUnitFromUnitName(undefined)).toBeUndefined();
  });
});

describe("convertLengthBasedProperties", () => {
  it("converts volume/area/length/centerOfMass and leaves everything else untouched", () => {
    const props = {
      volume: 16387.064,
      area: 645.16,
      length: 25.4,
      centerOfMass: [25.4, 50.8, 0] as [number, number, number],
      momentsOfInertia: { ixx: 123, iyy: 456, izz: 789 },
    };
    const converted = convertLengthBasedProperties(props, "in");
    expect(converted.volume).toBeCloseTo(1, 3);
    expect(converted.area).toBeCloseTo(1, 4);
    expect(converted.length).toBeCloseTo(1);
    expect(converted.centerOfMass![0]).toBeCloseTo(1);
    expect(converted.centerOfMass![1]).toBeCloseTo(2);
    // Untouched fields pass through unchanged.
    expect(converted.momentsOfInertia).toEqual(props.momentsOfInertia);
  });

  it("passes through null fields as null", () => {
    const converted = convertLengthBasedProperties({ volume: null, area: null, length: null, centerOfMass: null }, "cm");
    expect(converted).toEqual({ volume: null, area: null, length: null, centerOfMass: null });
  });
});
