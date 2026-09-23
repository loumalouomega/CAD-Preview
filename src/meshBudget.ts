/**
 * Mesh size and memory budget preview (roadmap "Mesh size and memory budget
 * preview") — a cheap, pre-generation estimate of element/node counts and a
 * memory range for the FE Mesh panel and `estimate_mesh_budget`. Pure (no
 * vscode, no WASM, no THREE): host and webview share it.
 *
 * The model is EMPIRICAL, not a formula copied from elsewhere. Gmsh's
 * `elementCount` counts every dimension's elements (`Mesh.SaveAll` keeps the
 * boundary triangles, lines and points), so a volume-only formula undercounts
 * at coarse sizes. Least-squares over real Gmsh 0.3.0 runs on three committed
 * fixtures (block/bull/angle1, sizes spanning ~8×; raw rows in
 * `scripts/perf/mesh-budget-calibration.json`):
 *
 *   3D: elements ≈ a·V/h³ + b·A/h²      2D: elements ≈ a·A/h² + b·√A/h
 *
 * fits every row within 0.83–1.24×, so the band below is ×0.8–×1.25. Nodes
 * are a measured ratio per element. The ONE regime outside the band: a size
 * approaching the part's smallest dimension (block at h ≈ its 3 mm side ran
 * 2.6× over) — reported as low confidence with a widened upper bound, never
 * silently. Local Part sizing/grading, hex-dominant output and fTetWild are
 * uncalibrated and say so.
 *
 * Memory is an order-of-magnitude range, stated as such: per-element bytes for
 * the kernel's own mesh, the MSH text the pipeline builds (measured per
 * element above), and the host/viewport overlay copies.
 */
import type { MeshElementShape, MeshEngine } from "./meshOptions";

export interface MeshBudgetInput {
  /** Closed volume in mm³ (null/undefined when unknown or not watertight). */
  volume?: number | null;
  /** Surface area in mm². */
  area?: number | null;
  /** Bounding-box extents in mm — the fallback when volume/area are unknown. */
  bboxSize: [number, number, number];
  /** Target (max) element size in mm. */
  sizeMax: number;
  dimension: 1 | 2 | 3;
  elementOrder?: 1 | 2;
  elementShape?: MeshElementShape;
  engine?: MeshEngine;
  /** Any Part carries meshSize/meshGrading (local refinement). */
  localSizing?: boolean;
}

export type BudgetConfidence = "calibrated" | "rough" | "uncertain";

export interface MeshBudget {
  status: "ok" | "unavailable";
  reason?: string;
  elements: { low: number; high: number; mid: number };
  nodes: { low: number; high: number };
  memoryBytes: { low: number; high: number };
  basis: "volume+area" | "area" | "bbox";
  confidence: BudgetConfidence;
  assumptions: string[];
}

/** Least-squares coefficients (see the module comment). */
const COEF = {
  "3/simplex": { a: 3.967, b: 2.738, nodesPerEl: [0.207, 0.322] },
  "3/subdivided": { a: 15.868, b: 10.954, nodesPerEl: [1.149, 1.306] },
  "2/simplex": { a: 2.447, b: 10.536, nodesPerEl: [0.496, 0.502] },
  "2/subdivided": { a: 1.193, b: 5.14, nodesPerEl: [0.972, 1.004] },
} as const;
/** Quadratic elements add mid-side nodes; measured node ratios for order 2. */
const ORDER2_NODES = { 3: [1.505, 1.936], 2: [1.996, 2.002] } as const;
const BAND = [0.8, 1.25] as const;
/** Bytes per element: kernel mesh + MSH text (measured 40–190/el) + host/viewport copies. */
const BYTES_PER_ELEMENT = { 1: [350, 900], 2: [700, 1800] } as const;

const EMPTY: Omit<MeshBudget, "status" | "reason" | "assumptions"> = {
  elements: { low: 0, high: 0, mid: 0 },
  nodes: { low: 0, high: 0 },
  memoryBytes: { low: 0, high: 0 },
  basis: "bbox",
  confidence: "uncertain",
};

export function estimateMeshBudget(input: MeshBudgetInput): MeshBudget {
  const h = input.sizeMax;
  const order = input.elementOrder ?? 1;
  const shape = input.elementShape ?? "simplex";
  const assumptions: string[] = [];
  if (!(Number.isFinite(h) && h > 0 && h < 1e20)) {
    return { ...EMPTY, status: "unavailable", reason: "No explicit target size yet (sizeMax is unbounded).", assumptions };
  }
  const [x, y, z] = input.bboxSize;
  if (![x, y, z].every((v) => Number.isFinite(v) && v >= 0) || x + y + z === 0) {
    return { ...EMPTY, status: "unavailable", reason: "The model has no extent to estimate from.", assumptions };
  }
  let confidence: BudgetConfidence = "calibrated";
  const downgrade = (to: BudgetConfidence) => {
    if (to === "uncertain" || (to === "rough" && confidence === "calibrated")) confidence = to;
  };

  let mid: number;
  let basis: MeshBudget["basis"];
  const dim = input.dimension;
  if (dim === 1) {
    mid = Math.hypot(x, y, z) / h;
    basis = "bbox";
    downgrade("rough");
    assumptions.push("1D: segments along the bounding-box diagonal.");
  } else {
    const key = `${dim}/${shape === "subdivided" ? "subdivided" : "simplex"}` as keyof typeof COEF;
    const c = COEF[key];
    let area = input.area ?? null;
    let volume = input.volume ?? null;
    if (!(area !== null && Number.isFinite(area) && area > 0)) {
      area = 2 * (x * y + y * z + z * x);
      downgrade("rough");
      assumptions.push("Surface area unknown — using the bounding box's (overestimates non-boxy parts).");
    }
    if (dim === 3) {
      if (!(volume !== null && Number.isFinite(volume) && volume > 0)) {
        if (input.volume === null) {
          return {
            ...EMPTY,
            status: "unavailable",
            reason: "The geometry is not a closed volume — a 3D element count cannot be estimated for it.",
            assumptions,
          };
        }
        volume = x * y * z;
        downgrade("rough");
        assumptions.push("Volume unknown — using the bounding box's (overestimates non-boxy parts).");
      }
      mid = c.a * (volume / h ** 3) + c.b * (area / h ** 2);
      basis = input.volume ? "volume+area" : "bbox";
    } else {
      mid = c.a * (area / h ** 2) + c.b * (Math.sqrt(area) / h);
      basis = input.area ? "area" : "bbox";
    }
    // Outside the calibrated regime: the target size approaches the part's
    // smallest dimension, where boundary/feature constraints dominate.
    const minDim = Math.min(...[x, y, z].filter((v) => v > 0));
    if (h > minDim / 4) {
      downgrade("rough");
      assumptions.push(`Target size ${fmt(h)} mm is coarse relative to the part's smallest extent (${fmt(minDim)} mm) — counts can run several times higher.`);
    }
  }

  if (shape === "hexDominant") {
    downgrade("uncertain");
    assumptions.push("Hex-dominant output is uncalibrated (mixed tet/hex/transition elements).");
  }
  if ((input.engine ?? "gmsh") === "ftetwild") {
    downgrade("uncertain");
    assumptions.push("fTetWild sizes by its own edge-length rule — uncalibrated here.");
  }
  if (input.localSizing) {
    downgrade("uncertain");
    assumptions.push("Part sizing/grading refines locally — the uniform estimate is a lower bound.");
  }

  const coarse = assumptions.some((a) => a.includes("coarse relative"));
  const lowFactor = BAND[0];
  const highFactor = confidence === "calibrated" ? BAND[1] : coarse || input.localSizing ? 3 : 2;
  const elements = { low: Math.round(mid * lowFactor), high: Math.round(mid * highFactor), mid: Math.round(mid) };

  let npe: readonly number[];
  if (dim === 1) npe = [1, 1];
  else if (order === 2) npe = ORDER2_NODES[dim];
  else npe = COEF[`${dim}/${shape === "subdivided" ? "subdivided" : "simplex"}` as keyof typeof COEF].nodesPerEl;
  const nodes = { low: Math.round(elements.low * npe[0]), high: Math.round(elements.high * npe[1]) };
  const bpe = BYTES_PER_ELEMENT[order];
  const memoryBytes = { low: Math.round(elements.low * bpe[0]), high: Math.round(elements.high * bpe[1]) };
  assumptions.push("Memory is an order-of-magnitude range (kernel mesh + MSH text + host/viewport copies), not a measurement.");
  return { status: "ok", elements, nodes, memoryBytes, basis, confidence, assumptions };
}

/** Advisory budget check — never blocks; `null` when within budget or no budget set. */
export function budgetWarning(budget: MeshBudget, budgetElements: number | undefined): string | null {
  if (budget.status !== "ok" || !budgetElements || !(budgetElements > 0)) return null;
  if (budget.elements.low > budgetElements) {
    return `Estimated ${formatCountRange(budget.elements)} elements — above your ${formatCount(budgetElements)}-element budget.`;
  }
  if (budget.elements.high > budgetElements) {
    return `Estimated ${formatCountRange(budget.elements)} elements — may exceed your ${formatCount(budgetElements)}-element budget.`;
  }
  return null;
}

function fmt(n: number): string {
  return String(Number(n.toPrecision(3)));
}

export function formatCount(n: number): string {
  if (n >= 1e6) return `${trim(n / 1e6)}M`;
  if (n >= 1e3) return `${trim(n / 1e3)}k`;
  return `${Math.round(n)}`;
}

export function formatCountRange(r: { low: number; high: number }): string {
  return `${formatCount(r.low)}–${formatCount(r.high)}`;
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${trim(n / 1e9)} GB`;
  if (n >= 1e6) return `${trim(n / 1e6)} MB`;
  if (n >= 1e3) return `${trim(n / 1e3)} kB`;
  return `${Math.round(n)} B`;
}

function trim(v: number): string {
  return v >= 100 ? String(Math.round(v)) : String(Number(v.toFixed(1)));
}
