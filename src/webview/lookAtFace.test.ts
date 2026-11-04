import { describe, it, expect } from "vitest";
import { lookAtFaceDirection } from "./lookAtFace";

describe("lookAtFaceDirection", () => {
  it("normalises and keeps the sign when the camera is on that side", () => {
    expect(lookAtFaceDirection([0, 0, 2], [0, 0.2, 1])).toEqual([0, 0, 1]);
  });
  it("flips a normal that points away from the camera so the face is seen from the front", () => {
    expect(lookAtFaceDirection([0, 0, -1], [0.3, 0.3, 1])).toEqual([0, 0, 1]);
    expect(lookAtFaceDirection([1, 0, 0], [-1, 0, 0])).toEqual([-1, 0, 0]);
  });
  it("refuses a zero or non-finite normal", () => {
    expect(lookAtFaceDirection([0, 0, 0], [0, 0, 1])).toBeNull();
    expect(lookAtFaceDirection([NaN, 0, 1], [0, 0, 1])).toBeNull();
  });
});
