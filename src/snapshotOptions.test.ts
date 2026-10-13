import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { resolveSnapshotDisplay } from "./snapshotOptions";
import { dominantAxis } from "./webview/clipping";

describe("resolveSnapshotDisplay", () => {
  it("returns nothing for no input, leaving the pipeline's opts unchanged", () => {
    const w: string[] = [];
    expect(resolveSnapshotDisplay(undefined, undefined, w)).toEqual({});
    expect(w).toEqual([]);
  });

  it("accepts every display mode and keeps the legacy wireframe flag only for wireframe", () => {
    for (const m of ["shaded", "xray", "hiddenLines", "flat"]) {
      expect(resolveSnapshotDisplay(m, undefined, [])).toEqual({ displayMode: m });
    }
    expect(resolveSnapshotDisplay("wireframe", undefined, [])).toEqual({ displayMode: "wireframe", wireframe: true });
  });

  it("warns and ignores an unrecognised display mode", () => {
    const w: string[] = [];
    expect(resolveSnapshotDisplay("sketchy", undefined, w)).toEqual({});
    expect(w[0]).toMatch(/"sketchy" is not one of/);
  });

  it("builds an axis clip", () => {
    expect(resolveSnapshotDisplay(undefined, { axis: "y", offsetFrac: 0.25 }, []).clip).toEqual({ axis: "y", offsetFrac: 0.25 });
  });

  it("normalises a normal clip and writes the dominant axis beside it", () => {
    const { clip } = resolveSnapshotDisplay(undefined, { normal: [0, 0, 4], offsetFrac: -0.5 }, []);
    expect(clip).toEqual({ axis: "z", offsetFrac: -0.5, normal: [0, 0, 1] });
  });

  it("agrees with clipping.ts's dominantAxis for tilted normals, including ties", () => {
    const normals: Array<[number, number, number]> = [
      [1, 1, 1],
      [0.2, 0.9, 0.1],
      [-3, 1, 2],
      [0, -1, -1],
      [0.1, 0.2, -0.95],
    ];
    for (const n of normals) {
      const { clip } = resolveSnapshotDisplay(undefined, { normal: n, offsetFrac: 0 }, []);
      expect(clip!.axis).toBe(dominantAxis(new THREE.Vector3(...n).normalize()));
    }
  });

  it("rejects ambiguous, missing, zero, non-finite and out-of-range clips", () => {
    const r = (c: Parameters<typeof resolveSnapshotDisplay>[1]) => () => resolveSnapshotDisplay(undefined, c, []);
    expect(r({ axis: "x", normal: [1, 0, 0], offsetFrac: 0 })).toThrow(/either `axis` or `normal`/);
    expect(r({ offsetFrac: 0 })).toThrow(/give `axis`/);
    expect(r({ normal: [0, 0, 0], offsetFrac: 0 })).toThrow(/non-zero/);
    expect(r({ normal: [NaN, 0, 1], offsetFrac: 0 })).toThrow(/finite/);
    expect(r({ axis: "x", offsetFrac: 1.01 })).toThrow(/\[-1, 1\]/);
    expect(r({ axis: "x", offsetFrac: NaN })).toThrow(/finite/);
  });
});
