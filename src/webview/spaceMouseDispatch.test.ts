import { describe, it, expect, vi } from "vitest";
import {
  applySpaceMouseInput,
  DEFAULT_SPACEMOUSE_SPEEDS,
  type SpaceMouseViewTarget,
} from "./spaceMouseDispatch";

function fakeViewer(): SpaceMouseViewTarget & {
  calls: Array<{ method: string; args: number[] }>;
} {
  const calls: Array<{ method: string; args: number[] }> = [];
  return {
    calls,
    rotateView: (...args: number[]) => void calls.push({ method: "rotateView", args }),
    panView: (...args: number[]) => void calls.push({ method: "panView", args }),
    zoomView: (...args: number[]) => void calls.push({ method: "zoomView", args }),
    fitView: () => void calls.push({ method: "fitView", args: [] }),
    resetView: () => void calls.push({ method: "resetView", args: [] }),
  };
}

const REST = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };

describe("applySpaceMouseInput", () => {
  it("issues zero viewer calls for a resting puck (render-on-demand stays asleep)", () => {
    const viewer = fakeViewer();
    const next = applySpaceMouseInput(viewer, REST, 0, 0, 16);
    expect(viewer.calls).toEqual([]);
    expect(next).toBe(0);
  });

  it("maps full-deflection translation to pan at the configured speed", () => {
    const viewer = fakeViewer();
    applySpaceMouseInput(viewer, { ...REST, tx: 350, ty: -350 }, 0, 0, 100, DEFAULT_SPACEMOUSE_SPEEDS);
    expect(viewer.calls).toEqual([
      { method: "panView", args: [0.05, -0.05] },
    ]);
  });

  it("maps push to an exponential zoom-in (factor < 1)", () => {
    const viewer = fakeViewer();
    applySpaceMouseInput(viewer, { ...REST, tz: 350 }, 0, 0, 100, DEFAULT_SPACEMOUSE_SPEEDS);
    expect(viewer.calls).toHaveLength(1);
    expect(viewer.calls[0].method).toBe("zoomView");
    expect(viewer.calls[0].args[0]).toBeLessThan(1);
    expect(viewer.calls[0].args[0]).toBeCloseTo(Math.pow(2, -0.15), 10);
  });

  it("maps tilt to orbit in degrees", () => {
    const viewer = fakeViewer();
    applySpaceMouseInput(viewer, { ...REST, rx: 350, ry: 350 }, 0, 0, 100, DEFAULT_SPACEMOUSE_SPEEDS);
    expect(viewer.calls).toEqual([{ method: "rotateView", args: [9, 9] }]);
  });

  it("scales by dt and clamps it", () => {
    const fast = fakeViewer();
    applySpaceMouseInput(fast, { ...REST, tx: 350 }, 0, 0, 0, DEFAULT_SPACEMOUSE_SPEEDS);
    // dt clamps to 1ms, not 0 — a tiny but nonzero step, never NaN.
    expect(fast.calls).toEqual([{ method: "panView", args: [0.0005, 0] }]);
    const slow = fakeViewer();
    applySpaceMouseInput(slow, { ...REST, tx: 350 }, 0, 0, 10000, DEFAULT_SPACEMOUSE_SPEEDS);
    // dt clamps to 100ms — a sleep/resume gap never flings the camera.
    expect(slow.calls).toEqual([{ method: "panView", args: [0.05, 0] }]);
  });

  it("fires Fit/Reset on button rising edges only, returning the mask to thread", () => {
    const viewer = fakeViewer();
    expect(applySpaceMouseInput(viewer, REST, 0x01, 0, 16)).toBe(0x01);
    expect(applySpaceMouseInput(viewer, REST, 0x01, 0x01, 16)).toBe(0x01);
    expect(applySpaceMouseInput(viewer, REST, 0x03, 0x01, 16)).toBe(0x03);
    expect(viewer.calls).toEqual([
      { method: "fitView", args: [] },
      { method: "resetView", args: [] },
    ]);
  });

  it("treats missing buttons as no buttons", () => {
    const viewer = fakeViewer();
    expect(applySpaceMouseInput(viewer, REST, undefined, 0x01, 16)).toBe(0);
    expect(viewer.calls).toEqual([]);
  });

  it("applies a custom speed table", () => {
    const viewer = fakeViewer();
    applySpaceMouseInput(
      viewer,
      { ...REST, tx: 350 },
      0,
      0,
      100,
      { panPerSec: 2, orbitDegPerSec: 90, zoomDoublingsPerSec: 1.5 }
    );
    expect(viewer.calls).toEqual([{ method: "panView", args: [0.2, 0] }]);
  });
});
