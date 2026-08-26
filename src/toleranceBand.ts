/**
 * Pure tolerance-band arithmetic (roadmap item "Tolerance-band fact checks on
 * exact measurements") — shared by the headless MCP `check_tolerance` tool and
 * the webview's toleranced-pin rendering so the two can never drift. No
 * imports at all: host-safe and webview-safe alike.
 *
 * Framing discipline, per this codebase's `verdictConventions`: the computed
 * `withinTolerance` boolean is a FACT about where the measured value sits
 * relative to the caller-supplied band — never phrased as a pass/fail verdict
 * in any tool description or UI copy. The consumer (agent or human) renders
 * the judgment.
 */

export interface ToleranceBand {
  /** Nominal (target) value, same unit as the measurement being checked. */
  nominal: number;
  /** Allowed deviation above nominal (≥ 0). */
  plus: number;
  /** Allowed deviation below nominal (≥ 0); symmetric ± when equal to `plus`. */
  minus: number;
}

/** A {@link ToleranceBand} carrying the frozen raw numeric measurement it was
 * evaluated against at pin time — what an `Annotation` persists, so the
 * in/out-of-band colour can be re-derived on redisplay without parsing the
 * formatted measurement text back into a number. */
export interface AnnotatedTolerance extends ToleranceBand {
  /** Raw numeric measurement frozen at pin time (mm for length tools,
   * degrees for angle). */
  measured: number;
}

export interface ToleranceEvaluation {
  /** `measured − nominal` — signed; negative means below nominal. */
  deviation: number;
  /** True when `−minus ≤ deviation ≤ plus`. A FACT, not a verdict. */
  withinTolerance: boolean;
}

/**
 * Evaluates `measured` against the band. Returns `null` (never throws, never
 * fabricates a comparison) when any input is non-finite — callers decide
 * whether that means rejecting the request (the MCP tool validates up front)
 * or skipping the decoration (the webview renderer).
 */
export function evaluateToleranceBand(measured: number, band: ToleranceBand): ToleranceEvaluation | null {
  const values = [measured, band.nominal, band.plus, band.minus];
  if (!values.every((v) => Number.isFinite(v))) return null;
  const deviation = measured - band.nominal;
  return { deviation, withinTolerance: deviation <= band.plus && deviation >= -band.minus };
}

/** `"±0.05"` for a symmetric band, `"+0.1/−0.05"` for an asymmetric one. */
export function formatToleranceBand(band: ToleranceBand): string {
  if (band.plus === band.minus) return `±${Number(band.plus.toPrecision(6))}`;
  return `+${Number(band.plus.toPrecision(6))}/−${Number(band.minus.toPrecision(6))}`;
}

/**
 * Composes a toleranced pin's label text from its frozen measurement text and
 * band — e.g. `"12.5 mm [10 ±0.05]"`. The measured fact (`text`) stays first
 * and verbatim; the band is decoration appended after it. Returns `text`
 * unchanged for a missing/malformed band, so every existing annotation
 * renders exactly as before.
 */
export function annotatedLabelText(text: string, tolerance?: Partial<AnnotatedTolerance>): string {
  if (!tolerance) return text;
  const { nominal, plus, minus } = tolerance;
  if (nominal === undefined || plus === undefined || minus === undefined) return text;
  if (![nominal, plus, minus].every((v) => typeof v === "number" && Number.isFinite(v))) return text;
  return `${text} [${Number(nominal.toPrecision(6))} ${formatToleranceBand({ nominal, plus, minus })}]`;
}
