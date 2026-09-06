import { describe, it, expect } from "vitest";
import {
  parseSpaceMouseReport,
  motionToVelocity,
  ZERO_TRIPLETS,
  SPACEMOUSE_DEADZONE,
  SPACEMOUSE_MAX_DEFLECTION,
} from "./spaceMouseReports";

function i16Pair(v: number): [number, number] {
  const u = v < 0 ? v + 0x10000 : v;
  return [u & 0xff, (u >> 8) & 0xff];
}

function report1(t: [number, number, number], r?: [number, number, number]): number[] {
  const out = [1, ...i16Pair(t[0]), ...i16Pair(t[1]), ...i16Pair(t[2])];
  if (r) out.push(...i16Pair(r[0]), ...i16Pair(r[1]), ...i16Pair(r[2]));
  return out;
}

describe("parseSpaceMouseReport", () => {
  it("parses a translation-only report, keeping previous rotation", () => {
    const prev = { t: [0, 0, 0] as [number, number, number], r: [10, 20, 30] as [number, number, number] };
    const parsed = parseSpaceMouseReport(report1([100, -200, 300]), prev);
    expect(parsed.t).toEqual([100, -200, 300]);
    expect(parsed.r).toEqual([10, 20, 30]);
    expect(parsed.buttons).toBeUndefined();
  });

  it("parses a packed translation+rotation report", () => {
    const parsed = parseSpaceMouseReport(report1([1, 2, 3], [4, 5, 6]));
    expect(parsed.t).toEqual([1, 2, 3]);
    expect(parsed.r).toEqual([4, 5, 6]);
  });

  it("parses a rotation-only report, keeping previous translation", () => {
    const first = parseSpaceMouseReport(report1([100, 200, 300]));
    const second = parseSpaceMouseReport([2, ...i16Pair(7), ...i16Pair(8), ...i16Pair(9)], first);
    expect(second.t).toEqual([100, 200, 300]);
    expect(second.r).toEqual([7, 8, 9]);
  });

  it("parses a button bitmask little-endian", () => {
    const parsed = parseSpaceMouseReport([3, 0x05, 0x01, 0x00, 0x00], ZERO_TRIPLETS);
    expect(parsed.buttons).toBe(0x0105);
    expect(parsed.t).toEqual([0, 0, 0]);
  });

  it("ignores unknown report ids, preserving state", () => {
    const prev = { t: [1, 2, 3] as [number, number, number], r: [4, 5, 6] as [number, number, number] };
    const parsed = parseSpaceMouseReport([9, 1, 2, 3], prev);
    expect(parsed.t).toEqual([1, 2, 3]);
    expect(parsed.r).toEqual([4, 5, 6]);
    expect(parsed.buttons).toBeUndefined();
  });

  it("degrades truncated buffers to zeros, never throws", () => {
    expect(parseSpaceMouseReport([], ZERO_TRIPLETS).t).toEqual([0, 0, 0]);
    // A lone data byte cannot form an i16 (needs bytes i AND i+1) — zero it.
    expect(parseSpaceMouseReport([1, 0x10], ZERO_TRIPLETS).t).toEqual([0, 0, 0]);
    expect(parseSpaceMouseReport([1, 0x10, 0x00], ZERO_TRIPLETS).t).toEqual([0x10, 0, 0]);
    expect(parseSpaceMouseReport([2], ZERO_TRIPLETS).r).toEqual([0, 0, 0]);
  });

  it("sign-extends negative axes", () => {
    const parsed = parseSpaceMouseReport(report1([-1, -350, 32767]));
    expect(parsed.t).toEqual([-1, -350, 32767]);
  });
});

describe("motionToVelocity", () => {
  it("zeroes everything inside the deadzone", () => {
    const v = motionToVelocity(
      { tx: SPACEMOUSE_DEADZONE - 1, ty: -(SPACEMOUSE_DEADZONE - 1), tz: 0, rx: 0, ry: 0, rz: 999 },
      SPACEMOUSE_DEADZONE,
      SPACEMOUSE_MAX_DEFLECTION
    );
    // rz is unmapped regardless of magnitude (no roll axis on OrbitControls).
    expect(v).toEqual({ panX: 0, panY: 0, zoom: 0, orbitAz: 0, orbitPol: 0 });
  });

  it("normalizes full deflection to ±1 and clamps beyond", () => {
    const v = motionToVelocity(
      { tx: 350, ty: -350, tz: 1000, rx: -1000, ry: 175, rz: 0 },
      SPACEMOUSE_DEADZONE,
      SPACEMOUSE_MAX_DEFLECTION
    );
    expect(v.panX).toBe(1);
    expect(v.panY).toBe(-1);
    expect(v.zoom).toBe(1);
    expect(v.orbitPol).toBe(-1);
    expect(v.orbitAz).toBeCloseTo(0.5, 10);
  });

  it("maps channels per the documented (unverified) sign convention", () => {
    // +tx→pan right, +ty→pan up, +tz→zoom in, +ry→orbit right, +rx→tilt up.
    const v = motionToVelocity({ tx: 100, ty: 100, tz: 100, rx: 100, ry: 100, rz: 100 });
    expect(v.panX).toBeGreaterThan(0);
    expect(v.panY).toBeGreaterThan(0);
    expect(v.zoom).toBeGreaterThan(0);
    expect(v.orbitAz).toBeGreaterThan(0);
    expect(v.orbitPol).toBeGreaterThan(0);
  });
});
