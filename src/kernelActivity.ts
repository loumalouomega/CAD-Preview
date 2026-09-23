/**
 * Which WASM kernels have actually been used — the status bar's "OCCT ready ·
 * Gmsh ready" line.
 *
 * Pure (no vscode, no child process), so the rules are unit-testable apart from
 * the client that feeds them. The kernels load lazily and live in a forked child,
 * so "ready" cannot be read off any flag: it is INFERRED from calls. A kernel is
 * `ready` only after a call that needs it has SUCCEEDED in the worker, and `idle`
 * again whenever the child dies (the next call respawns it cold). A document that
 * never touches a kernel — a plain mesh open — legitimately reads "idle", which
 * is the lazy-WASM invariant showing through, not a fault.
 *
 * `KERNELS_BY_FUNCTION` is typed over the real `DocumentPipeline` key set, so a
 * new pipeline function is a compile error until someone says which kernels it
 * touches. Each entry is the set the function DEFINITELY touches — never a guess
 * upward: under-reporting leaves a kernel "idle", over-reporting would claim a
 * load that did not happen. (That is why `generateMesh` lists only Gmsh: whether
 * fTetWild also ran depends on the options, and `repairMesh` is the one call that
 * always uses it.)
 */

import type { DocumentPipeline } from "./kernelClient";

export type Kernel = "occt" | "gmsh" | "meshio" | "ftetwild";
export type KernelPhase = "idle" | "loading" | "ready";
export type KernelState = Record<Kernel, KernelPhase>;

export const KERNEL_LABELS: Record<Kernel, string> = {
  occt: "OCCT",
  gmsh: "Gmsh",
  meshio: "meshio++",
  ftetwild: "fTetWild",
};

/** Display order: the two everyday kernels first. */
export const KERNEL_ORDER: readonly Kernel[] = ["occt", "gmsh", "meshio", "ftetwild"];

const O: Kernel[] = ["occt"];
const G: Kernel[] = ["gmsh"];
const M: Kernel[] = ["meshio"];
const NONE: Kernel[] = [];

export const KERNELS_BY_FUNCTION: Record<keyof DocumentPipeline, readonly Kernel[]> = {
  loadBRep: O,
  exportBRep: O,
  generateMesh: G,
  getGmshVersion: G,
  exportMeshFormat: G,
  exportMdpa: G,
  exportGeoUnrolled: G,
  computeMassProperties: O,
  computeBom: O,
  computeHoleTable: O,
  getEntityFacts: O,
  hitTest: O,
  measureEntities: O,
  measureExact: O,
  checkInterference: O,
  checkInterferenceAll: O,
  rebindPartsAcrossOps: O,
  rebindPartsAcrossSave: O,
  resolveBucketSelector: O,
  synthesizeSelector: O,
  resolvePartSelectors: O,
  // Browser render + an in-process B-rep load; no separate WASM kernel of its own.
  renderSnapshot: O,
  isRenderAvailable: NONE,
  searchStandardParts: NONE,
  downloadStandardPart: NONE,
  compareModels: O,
  convertToStlBoundary: M,
  convertToStlBoundaryWithRegions: M,
  convertFoamCaseToStlBoundary: M,
  exportViaMeshio: M,
  readMeshioMetadata: M,
  readMeshioDataInfo: M,
  readMeshioProvenance: M,
  decimateStlBoundary: M,
  runMeshioOps: M,
  loadBRepCachedForDocument: O,
  disposeBRepCacheForDocument: NONE,
  readMeshioFieldValues: M,
  checkMeshHealth: O,
  recognizePrimitives: O,
  fitMeshRegion: NONE, // pure TypeScript over triangles — no WASM at all
  promoteMeshToBrep: O,
  repairMesh: ["ftetwild", "gmsh"],
  exportSvgSilhouette: O,
  exportDrawingSheet: O,
  buildPrimitivesFile: O,
};

export function kernelsFor(fn: string): readonly Kernel[] {
  return (KERNELS_BY_FUNCTION as Record<string, readonly Kernel[] | undefined>)[fn] ?? NONE;
}

export function initialKernelState(): KernelState {
  return { occt: "idle", gmsh: "idle", meshio: "idle", ftetwild: "idle" };
}

export type KernelEvent =
  | { type: "start"; fn: string }
  | { type: "success"; fn: string }
  | { type: "failure"; fn: string }
  /** The child exited, was killed (cancel/watchdog) or crashed — every kernel is gone with it. */
  | { type: "reset" };

/**
 * Pure reducer. Returns the SAME object when nothing changed so callers can
 * cheaply skip a broadcast (`next === prev`).
 */
export function reduceKernelState(prev: KernelState, ev: KernelEvent): KernelState {
  if (ev.type === "reset") {
    return KERNEL_ORDER.every((k) => prev[k] === "idle") ? prev : initialKernelState();
  }
  const touched = kernelsFor(ev.fn);
  let next: KernelState | null = null;
  for (const k of touched) {
    let phase: KernelPhase = prev[k];
    if (ev.type === "start") {
      // Never demote a kernel that is already warm just because another call started.
      if (prev[k] === "idle") phase = "loading";
    } else if (ev.type === "success") {
      phase = "ready";
    } else if (prev[k] === "loading") {
      // A failed call that was the one loading it leaves it cold again.
      phase = "idle";
    }
    if (phase !== prev[k]) (next ??= { ...prev })[k] = phase;
  }
  return next ?? prev;
}

/**
 * The status bar's text and colour bucket for a state.
 *   - nothing active → "Kernels idle"
 *   - otherwise "OCCT ready · Gmsh loading…", listing only the non-idle kernels
 */
export function describeKernelState(state: KernelState): { text: string; tone: "idle" | "loading" | "ready" } {
  const active = KERNEL_ORDER.filter((k) => state[k] !== "idle");
  if (active.length === 0) return { text: "Kernels idle", tone: "idle" };
  const text = active.map((k) => `${KERNEL_LABELS[k]} ${state[k] === "ready" ? "ready" : "loading…"}`).join(" · ");
  return { text, tone: active.some((k) => state[k] === "loading") ? "loading" : "ready" };
}
