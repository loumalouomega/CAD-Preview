import { beforeEach, describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ initialize: vi.fn(), read: vi.fn(() => new Uint8Array([1])) }));
vi.mock("node:module", () => ({ createRequire: () => () => mocked.initialize }));
vi.mock("node:fs", () => ({ readFileSync: mocked.read }));
vi.mock("./runtimePackage", () => ({ resolveRuntimePackage: () => "/mmg.cjs" }));
import { getMmg, remeshMmg, resetMmg, wrapMmgFault, type MmgMesh } from "./mmgService";

const input = (): MmgMesh => ({ positions: Float64Array.from([0,0,0, 1,0,0, 0,1,0, 0,0,1]), triangles: new Int32Array(), triangleRefs: new Int32Array(), tetrahedra: Int32Array.from([1,2,3,4]), tetraRefs: Int32Array.from([2]) });
function fake() {
  const api = { init: vi.fn(() => ({ mesh: 1, met: 2 })), free: vi.fn(), setIparameter: vi.fn(), setDparameter: vi.fn(),
    setMeshSize: vi.fn(), setVertices: vi.fn(), setTetrahedra: vi.fn(), setTriangles: vi.fn(), remesh: vi.fn(() => 0),
    getMeshSize: vi.fn(() => ({ np: 4, ne: 1, nt: 0 })), getVertices: vi.fn(() => ({ vertices: input().positions })),
    getTetrahedra: vi.fn(() => ({ tetra: input().tetrahedra, refs: input().tetraRefs })),
    IPARAM_mem: 1, IPARAM_verbose: 2, DPARAM_hausd: 3, DPARAM_hmin: 4, DPARAM_hmax: 5, DPARAM_hgrad: 6 };
  return { mmg3d: api, mmgs: api, MMG5_LOWFAILURE: 1, module: { HEAPU8: new Uint8Array(16) } };
}

beforeEach(() => { vi.clearAllMocks(); resetMmg(); mocked.initialize.mockResolvedValue(fake()); });
describe("MMG lazy singleton", () => {
  it("does not initialise until used, then memoises", async () => {
    expect(mocked.initialize).not.toHaveBeenCalled();
    await Promise.all([getMmg("/extension"), getMmg("/extension")]);
    expect(mocked.initialize).toHaveBeenCalledTimes(1);
    expect(mocked.read).toHaveBeenCalledWith("/extension/dist/mmg-core.wasm");
    expect(mocked.initialize).toHaveBeenCalledWith(expect.objectContaining({ print: expect.any(Function), printErr: expect.any(Function), wasmBinary: expect.any(Uint8Array) }));
  });
  it("un-caches a rejected factory", async () => {
    mocked.initialize.mockRejectedValueOnce(new Error("initialisation failed"));
    await expect(getMmg("/x")).rejects.toThrow();
    await getMmg("/x");
    expect(mocked.initialize).toHaveBeenCalledTimes(2);
  });
  it("resets on STRONGFAILURE and abort, not an ordinary validation error", async () => {
    await getMmg("/x");
    const ordinary = new Error("invalid input");
    expect(wrapMmgFault(ordinary)).toBe(ordinary);
    await getMmg("/x");
    expect(mocked.initialize).toHaveBeenCalledTimes(1);
    expect(wrapMmgFault(new Error("MMG5_STRONGFAILURE")).message).toMatch(/reset/);
    await getMmg("/x");
    expect(mocked.initialize).toHaveBeenCalledTimes(2);
    wrapMmgFault(new WebAssembly.RuntimeError("unreachable"));
    await getMmg("/x");
    expect(mocked.initialize).toHaveBeenCalledTimes(3);
  });
});
describe("MMG worker operation", () => {
  it("sets memory BEFORE allocation, applies relative hausd and frees handles", async () => {
    const mmg = fake(); mocked.initialize.mockResolvedValue(mmg);
    const result = await remeshMmg("/x", input(), { hmax: 0.5 });
    const api = mmg.mmg3d;
    expect(api.setIparameter).toHaveBeenCalledWith(1, 2, api.IPARAM_mem, 128);
    expect(api.setIparameter.mock.invocationCallOrder[0]).toBeLessThan(api.setMeshSize.mock.invocationCallOrder[0]);
    expect(result.report.hausd).toBeCloseTo(Math.sqrt(3) * 0.005);
    expect(api.free).toHaveBeenCalledTimes(1);
  });
  it("reports LOWFAILURE explicitly", async () => {
    const mmg = fake(); mmg.mmg3d.remesh.mockReturnValue(1); mocked.initialize.mockResolvedValue(mmg);
    expect((await remeshMmg("/x", input(), { hausd: 0.1, hausdRelative: false })).report).toMatchObject({ lowFailure: true, hausd: 0.1 });
  });
  it("frees on failure, resets, then serves a healthy next call", async () => {
    const mmg = fake(); mmg.mmg3d.remesh.mockImplementationOnce(() => { throw new Error("MMG5_STRONGFAILURE"); }); mocked.initialize.mockResolvedValue(mmg);
    await expect(remeshMmg("/x", input())).rejects.toThrow(/reset/);
    expect(mmg.mmg3d.free).toHaveBeenCalledTimes(1);
    await remeshMmg("/x", input());
    expect(mocked.initialize).toHaveBeenCalledTimes(2);
  });
  it("rejects empty harvests, non-finite coordinates and bad indices", async () => {
    const mmg = fake(); mmg.mmg3d.getMeshSize.mockReturnValue({ np: 0, ne: 0, nt: 0 }); mocked.initialize.mockResolvedValue(mmg);
    await expect(remeshMmg("/x", input())).rejects.toThrow(/empty harvest/);
    expect(mmg.mmg3d.free).toHaveBeenCalledTimes(1);
    const bad = input(); bad.positions[0] = NaN;
    await expect(remeshMmg("/x", bad)).rejects.toThrow(/finite/);
    bad.positions[0] = 0; bad.tetrahedra[0] = 99;
    await expect(remeshMmg("/x", bad)).rejects.toThrow(/index/);
  });
  it("rejects overflow of a relative hausd before loading WASM", async () => {
    await expect(remeshMmg("/x", input(), { hausd: Number.MAX_VALUE })).rejects.toThrow(/effective hausd/);
    expect(mocked.initialize).not.toHaveBeenCalled();
  });
});
