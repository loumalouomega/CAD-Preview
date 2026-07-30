import { describe, it, expect } from "vitest";
import { detectIgesLengthUnit, igesUnitLabel } from "./igesUnits";

/** Pads `content` to 72 columns and appends the `G` section identifier +
 * 7-digit sequence number, mirroring real fixed-width IGES card images. */
function gLine(content: string, seq: number): string {
  const padded = content.length >= 72 ? content.slice(0, 72) : content.padEnd(72, " ");
  return `${padded}G${String(seq).padStart(7, "0")}`;
}

describe("detectIgesLengthUnit", () => {
  it("returns undefined when there's no Global section at all", () => {
    expect(detectIgesLengthUnit("just some text\nwith no IGES structure")).toBeUndefined();
  });

  it("detects millimetres (unit flag 2) from a real OCCT-written IGES file's exact Global section", () => {
    // Captured byte-for-byte from a live export_brep(targetFormat: "iges") run
    // against examples/STP/bull.stp — including the real column-padding this
    // parser's trailing-whitespace-trim exists to handle.
    const text = [
      ",,31HOpen CASCADE IGES processor 7.4,13HFilename.iges,                  G0000001",
      "16HOpen CASCADE 7.4,31HOpen CASCADE IGES processor 7.4,32,308,15,308,15,G0000002",
      ",1.,2,2HMM,1,0.01,15H20260730.183948,0.0026726,158.75,,,11,0,           G0000003",
      "15H20260730.183948,;                                                    G0000004",
    ].join("\n");
    expect(detectIgesLengthUnit(text)).toBe("MILLIMETRE");
  });

  it("maps every unit flag this UI offers a DisplayUnit for", () => {
    const cases: Array<[number, string]> = [
      [1, "INCH"],
      [2, "MILLIMETRE"],
      [4, "FOOT"],
      [6, "METRE"],
      [10, "CENTIMETRE"],
    ];
    for (const [flag, expected] of cases) {
      // Minimal synthetic Global section: params 1-13 blank/placeholder, param 14 = flag.
      const record = `,,,,,,,,,,,,,${flag},2HXX,;`;
      const text = gLine(record, 1);
      expect(detectIgesLengthUnit(text)).toBe(expected);
    }
  });

  it("returns undefined for a flag not among the five units this UI offers", () => {
    // 5 = MILE, a real IGES unit flag but not one of mm/cm/m/in/ft.
    const record = `,,,,,,,,,,,,,5,4HMILE,;`;
    const text = gLine(record, 1);
    expect(detectIgesLengthUnit(text)).toBeUndefined();
  });

  it("returns undefined for a non-numeric or missing unit flag, never throws", () => {
    expect(detectIgesLengthUnit(gLine(",,,,,,,,,,,,,,2HXX,;", 1))).toBeUndefined(); // flag slot empty
    expect(detectIgesLengthUnit(gLine(",1,2,3", 1))).toBeUndefined(); // record far too short
  });

  it("reassembles a Global section split across multiple G lines with mid-field line breaks", () => {
    // Hollerith string content itself broken across the line boundary ("Hello
    // World" is 11 characters — the "11H" length prefix must count correctly
    // across the two physical lines it's split over).
    const lines = [gLine(",,11HHello Worl", 1), gLine("d,,,,,,,,,,,2,2HMM,;", 2)].join("\n");
    expect(detectIgesLengthUnit(lines)).toBe("MILLIMETRE");
  });
});

describe("igesUnitLabel", () => {
  it("maps known unit names to short labels, same vocabulary as stepUnitLabel", () => {
    expect(igesUnitLabel("MILLIMETRE")).toBe("mm");
    expect(igesUnitLabel("INCH")).toBe("in");
    expect(igesUnitLabel("FOOT")).toBe("ft");
  });

  it("passes through an unrecognized unit name as-is", () => {
    expect(igesUnitLabel("PARSEC")).toBe("PARSEC");
  });
});
