import { describe, expect, it } from "vitest";
import {
  describeKernelState,
  initialKernelState,
  kernelsFor,
  reduceKernelState,
  KERNELS_BY_FUNCTION,
} from "./kernelActivity";

const step = (s: ReturnType<typeof initialKernelState>, type: "start" | "success" | "failure", fn: string) =>
  reduceKernelState(s, { type, fn });

describe("kernelsFor", () => {
  it("maps a function to the kernels it definitely touches", () => {
    expect(kernelsFor("loadBRepCachedForDocument")).toEqual(["occt"]);
    expect(kernelsFor("generateMesh")).toEqual(["gmsh"]);
    expect(kernelsFor("repairMesh")).toEqual(["ftetwild", "gmsh"]);
  });

  it("is empty for a function that loads no WASM, and for an unknown name", () => {
    expect(kernelsFor("fitMeshRegion")).toEqual([]);
    expect(kernelsFor("searchStandardParts")).toEqual([]);
    expect(kernelsFor("nope")).toEqual([]);
  });

  it("covers every pipeline function exactly once (the typed table has no gaps)", () => {
    expect(Object.keys(KERNELS_BY_FUNCTION).length).toBeGreaterThan(40);
  });
});

describe("reduceKernelState", () => {
  it("idle → loading on start → ready on success", () => {
    let s = initialKernelState();
    s = step(s, "start", "loadBRepCachedForDocument");
    expect(s.occt).toBe("loading");
    s = step(s, "success", "loadBRepCachedForDocument");
    expect(s.occt).toBe("ready");
    expect(s.gmsh).toBe("idle");
  });

  it("a failed first call returns the kernel it was loading to idle", () => {
    let s = step(initialKernelState(), "start", "generateMesh");
    s = step(s, "failure", "generateMesh");
    expect(s.gmsh).toBe("idle");
  });

  it("a failure never demotes a kernel that was already ready", () => {
    let s = step(step(initialKernelState(), "start", "loadBRep"), "success", "loadBRep");
    s = step(step(s, "start", "exportBRep"), "failure", "exportBRep");
    expect(s.occt).toBe("ready");
  });

  it("starting a call never demotes a warm kernel to loading", () => {
    let s = step(step(initialKernelState(), "start", "loadBRep"), "success", "loadBRep");
    s = step(s, "start", "loadBRep");
    expect(s.occt).toBe("ready");
  });

  it("a reset (child killed or crashed) makes every kernel idle", () => {
    let s = step(step(initialKernelState(), "start", "repairMesh"), "success", "repairMesh");
    expect(s.ftetwild).toBe("ready");
    s = reduceKernelState(s, { type: "reset" });
    expect(s).toEqual(initialKernelState());
  });

  it("returns the SAME object when nothing changed, so callers can skip a broadcast", () => {
    const s = initialKernelState();
    expect(reduceKernelState(s, { type: "reset" })).toBe(s);
    expect(reduceKernelState(s, { type: "start", fn: "searchStandardParts" })).toBe(s);
    const warm = step(step(s, "start", "loadBRep"), "success", "loadBRep");
    expect(step(warm, "success", "loadBRep")).toBe(warm);
  });
});

describe("describeKernelState", () => {
  it("says idle when nothing has been used — the lazy-WASM invariant, not a fault", () => {
    expect(describeKernelState(initialKernelState())).toEqual({ text: "Kernels idle", tone: "idle" });
  });

  it("lists only non-idle kernels, in a fixed order, with a loading tone while one loads", () => {
    let s = step(step(initialKernelState(), "start", "loadBRep"), "success", "loadBRep");
    s = step(s, "start", "generateMesh");
    expect(describeKernelState(s)).toEqual({ text: "OCCT ready · Gmsh loading…", tone: "loading" });
    s = step(s, "success", "generateMesh");
    expect(describeKernelState(s)).toEqual({ text: "OCCT ready · Gmsh ready", tone: "ready" });
  });
});
