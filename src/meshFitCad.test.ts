import { describe, it, expect } from "vitest";
import { fitMeshToCad } from "./meshFitCad";

// These checks run before any WASM is touched (option validation precedes the
// parse and `getMeshio`), so they are exercisable under vitest.
describe("fitMeshToCad option validation (meshio++ 17.9+ knobs)", () => {
  const bytes = new Uint8Array(0);
  it("rejects an unknown backend by name", async () => {
    await expect(fitMeshToCad(bytes, "stl", { backend: "gpu" as never })).rejects.toThrow(/backend must be/);
  });
  it("rejects an unknown freeformMode by name", async () => {
    await expect(fitMeshToCad(bytes, "stl", { freeformMode: "wild" as never })).rejects.toThrow(/freeformMode must be/);
  });
  it("rejects an unknown segmentMethod by name", async () => {
    await expect(fitMeshToCad(bytes, "stl", { segmentMethod: "x" as never })).rejects.toThrow(/segmentMethod must be/);
  });
  it("refuses faceDeviation on the native backend, which has no OpenCASCADE to measure with", async () => {
    await expect(fitMeshToCad(bytes, "stl", { backend: "native", faceDeviation: true })).rejects.toThrow(/faceDeviation needs the OpenCASCADE backend/);
  });
});
