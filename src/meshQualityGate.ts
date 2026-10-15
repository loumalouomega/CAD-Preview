/**
 * Pure shape of the meshio++ quality gate (`checkQuality`) result.
 *
 * The threshold is the CALLER's: a specification text such as
 * `"scaled_jacobian >= 0.2; aspect_ratio <= 5 @ 1%"`. This module only
 * normalises what meshio++ reports into plain facts — per-check violation
 * counts, the violating fraction, the worst value and its cell — and flags a
 * check that evaluated no cell (`vacuous`), so "passed" can never hide a
 * threshold that applied to nothing. No PASS/FAIL wording is invented here
 * (see `verdictConventions`); `passed` is meshio++'s own comparison against
 * the caller's numbers.
 */

export interface QualityGateCheck {
  /** The clause as meshio++ echoes it, e.g. `scaled_jacobian >= 0.2`. */
  name: string;
  metric: string;
  /** Lower bound of the clause, or null when it has none. */
  min: number | null;
  /** Upper bound of the clause, or null when it has none. */
  max: number | null;
  /** The allowed violating fraction (`@ 1%` → 0.01). */
  maxFraction: number;
  /** Cells the metric applied to (e.g. a volume metric skips surface cells). */
  evaluated: number;
  violations: number;
  fraction: number;
  /** Worst value over the evaluated cells, or null when none was evaluated. */
  worst: number | null;
  /** meshio++ cell index of the worst value (−1 → null). */
  worstCell: number | null;
  passed: boolean;
  /** True when no cell was evaluated: the clause's `passed` is vacuous. */
  vacuous: boolean;
}

export interface QualityGateResult {
  passed: boolean;
  numCells: number;
  numInverted: number;
  numDegenerate: number;
  checks: QualityGateCheck[];
  /** Number of checks that evaluated no cell. */
  vacuousChecks: number;
  /** meshio++'s printed report. */
  summary: string;
}

const finiteOrNull = (v: unknown): number | null => {
  const n = typeof v === "bigint" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const count = (v: unknown): number => finiteOrNull(v) ?? 0;

/** Normalises a raw `m.checkQuality(...)` return value. */
export function normalizeQualityGate(raw: any): QualityGateResult {
  const checks: QualityGateCheck[] = (Array.isArray(raw?.checks) ? raw.checks : []).map((c: any) => {
    const evaluated = count(c.evaluated);
    const cell = finiteOrNull(c.worstCell);
    return {
      name: String(c.name ?? ""),
      metric: String(c.metric ?? ""),
      min: finiteOrNull(c.min),
      max: finiteOrNull(c.max),
      maxFraction: count(c.maxFraction),
      evaluated,
      violations: count(c.violations),
      fraction: count(c.fraction),
      worst: evaluated > 0 ? finiteOrNull(c.worst) : null,
      worstCell: cell !== null && cell >= 0 ? cell : null,
      passed: !!c.passed,
      vacuous: evaluated === 0,
    };
  });
  return {
    passed: !!raw?.passed,
    numCells: count(raw?.numCells),
    numInverted: count(raw?.numInverted),
    numDegenerate: count(raw?.numDegenerate),
    checks,
    vacuousChecks: checks.filter((c) => c.vacuous).length,
    summary: String(raw?.summary ?? ""),
  };
}

/** One display line per check for the panel / tool text. */
export function describeGateCheck(c: QualityGateCheck): string {
  if (c.vacuous) return `${c.name}: applies to no cell (vacuous)`;
  const pct = (c.fraction * 100).toFixed(c.fraction > 0 && c.fraction < 0.01 ? 2 : 1);
  const worst = c.worst === null ? "" : `, worst ${Number(c.worst.toPrecision(4))}${c.worstCell === null ? "" : ` at cell ${c.worstCell}`}`;
  return `${c.name}: ${c.violations} of ${c.evaluated} cells violate (${pct}%)${worst}`;
}
