import { describe, it, expect } from "vitest";
import { declaresMultiAxis } from "./hidDescriptor";

// Fixtures ported from SindriCAD's spacemouse.rs tests.
const SPACEMOUSE_DESC = [
  0x05, 0x01, // Usage Page (Generic Desktop)
  0x09, 0x08, // Usage (Multi-axis Controller)
  0xa1, 0x01, // Collection (Application)
  0xa1, 0x00, //   Collection (Physical)
  0x85, 0x01, //     Report ID (1)
  0x09, 0x30, //     Usage (X)
  0x09, 0x31, //     Usage (Y)
  0xc0, 0xc0,
];

// A bog-standard boot mouse — what an MX Anywhere 3s presents.
const MOUSE_DESC = [
  0x05, 0x01, // Usage Page (Generic Desktop)
  0x09, 0x02, // Usage (Mouse)
  0xa1, 0x01, // Collection (Application)
  0x09, 0x01, //   Usage (Pointer)
  0xa1, 0x00, //   Collection (Physical)
  0x05, 0x09, //     Usage Page (Button)
  0x19, 0x01, //     Usage Minimum (1)
  0x29, 0x03, //     Usage Maximum (3)
  0x05, 0x01, //     Usage Page (Generic Desktop)
  0x09, 0x30, //     Usage (X)
  0x09, 0x31, //     Usage (Y)
  0x09, 0x38, //     Usage (Wheel)
  0xc0, 0xc0,
];

describe("declaresMultiAxis", () => {
  it("recognises a 3D mouse descriptor", () => {
    expect(declaresMultiAxis(SPACEMOUSE_DESC)).toBe(true);
  });

  it("rejects a mouse descriptor", () => {
    expect(declaresMultiAxis(MOUSE_DESC)).toBe(false);
  });

  it("does not mistake usage 0x08 on another page for multi-axis", () => {
    // Under the Button page, 0x08 is button 8 — same class of mistake as
    // trusting the vendor id.
    expect(declaresMultiAxis([0x05, 0x09, 0x09, 0x08])).toBe(false);
  });

  it("honours the extended-usage page override", () => {
    expect(declaresMultiAxis([0x0b, 0x08, 0x00, 0x01, 0x00])).toBe(true);
    expect(declaresMultiAxis([0x0b, 0x08, 0x00, 0x09, 0x00])).toBe(false);
  });

  it("proves nothing from a truncated descriptor", () => {
    expect(declaresMultiAxis([0x05])).toBe(false);
    expect(declaresMultiAxis([0x05, 0x01, 0x09])).toBe(false);
    expect(declaresMultiAxis([])).toBe(false);
    expect(declaresMultiAxis([0xfe])).toBe(false);
  });

  it("does not desync on a four-byte item", () => {
    // Size field 3 means FOUR bytes; reading it literally would desync the
    // walk and miss everything after.
    expect(declaresMultiAxis([0x27, 0xff, 0xff, 0x00, 0x00, 0x05, 0x01, 0x09, 0x08])).toBe(true);
  });

  it("skips long items", () => {
    expect(declaresMultiAxis([0xfe, 0x02, 0x00, 0xaa, 0xbb, 0x05, 0x01, 0x09, 0x08])).toBe(true);
  });

  it("accepts Uint8Array input", () => {
    expect(declaresMultiAxis(new Uint8Array(SPACEMOUSE_DESC))).toBe(true);
  });
});
