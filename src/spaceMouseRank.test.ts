import { describe, it, expect } from "vitest";
import {
  rankSpaceMouseCandidate,
  isKnownSpaceMouseVendor,
  UNPROVEN,
} from "./spaceMouseRank";

describe("rankSpaceMouseCandidate", () => {
  // Vectors ported from SindriCAD's spacemouse.rs tests (real ids read off
  // a hidapi enumeration probe on the author's machine).
  const SPACENAV = 0x046d; // 046d:c626 "SpaceNavigator", enumerates usage 1/8
  const CONNEXION = 0x256f;
  const UNKNOWN = 0x3367;

  it("ranks a declared 6DOF device above everything", () => {
    const spacenav = rankSpaceMouseCandidate(SPACENAV, 0x01, 0x08);
    expect(spacenav).not.toBeNull();
    expect(spacenav!).toBeGreaterThan(rankSpaceMouseCandidate(CONNEXION, 0x00, 0x00)!);
    expect(spacenav!).toBeGreaterThan(UNPROVEN);
  });

  it("never opens a Logitech mouse or keyboard (the vendor-id collision bug)", () => {
    expect(rankSpaceMouseCandidate(SPACENAV, 0x01, 0x02)).toBeNull();
    expect(rankSpaceMouseCandidate(SPACENAV, 0x01, 0x06)).toBeNull();
  });

  it("rejects a known non-multi-axis usage even from our vendors", () => {
    expect(rankSpaceMouseCandidate(SPACENAV, 0xff00, 0x01)).toBeNull(); // HID++ collection
    expect(rankSpaceMouseCandidate(CONNEXION, 0xff00, 0x01)).toBeNull(); // vendor collection
    expect(rankSpaceMouseCandidate(SPACENAV, 0x0c, 0x01)).toBeNull(); // consumer control
  });

  it("still accepts an unknown vendor's 3D mouse (ranking, not filtering)", () => {
    expect(rankSpaceMouseCandidate(UNKNOWN, 0x01, 0x08)).not.toBeNull();
  });

  it("keeps the vendor fallback as UNPROVEN when usage is unpopulated", () => {
    expect(rankSpaceMouseCandidate(CONNEXION, 0x00, 0x00)).toBe(UNPROVEN);
    expect(rankSpaceMouseCandidate(UNKNOWN, 0x00, 0x00)).toBeNull();
  });

  it("ignores unrelated hardware", () => {
    expect(rankSpaceMouseCandidate(0x1b1c, 0x0c, 0x01)).toBeNull(); // Corsair consumer control
    expect(rankSpaceMouseCandidate(0x3434, 0x01, 0x06)).toBeNull(); // Keychron keyboard
  });

  it("prefers a known vendor over an unknown one at equal usage", () => {
    const known = rankSpaceMouseCandidate(CONNEXION, 0x01, 0x08)!;
    const unknown = rankSpaceMouseCandidate(UNKNOWN, 0x01, 0x08)!;
    expect(known).toBeGreaterThan(unknown);
  });
});

describe("isKnownSpaceMouseVendor", () => {
  it("covers both 3Dconnexion generations", () => {
    expect(isKnownSpaceMouseVendor(0x256f)).toBe(true);
    expect(isKnownSpaceMouseVendor(0x046d)).toBe(true);
    expect(isKnownSpaceMouseVendor(0x046d)).toBe(true);
    expect(isKnownSpaceMouseVendor(0x1234)).toBe(false);
  });
});
