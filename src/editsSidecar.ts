import { validateEditOp, type EditOp } from "./editOps";
import { validateVariables, evaluateVariables, resolveEditOps, type ParamVariable } from "./editVariables";

/**
 * Pure (vscode-free) parse/serialize for the edits sidecar `<model>.edits.json`
 * — unit-testable. Mirrors `partsSidecar.ts`. The sidecar holds the ordered,
 * replayable op-list plus the named parametric variables; the source CAD file
 * is never modified.
 */

export const EDITS_SIDECAR_VERSION = 1;

interface EditsSidecarFile {
  version: number;
  source: string;
  /** Named parametric variables; omitted when empty (pre-parametric files simply lack it). */
  variables?: ParamVariable[];
  /**
   * Tier 0 save-in-place watermark: the file on disk is already
   * `base ∘ ops[0..bakedThrough]`, so replay starts after it. Omitted when 0
   * so pre-watermark documents keep their exact previous output.
   */
  bakedThrough?: number;
  ops: EditOp[];
}

export interface ParsedEdits {
  ops: EditOp[];
  variables: ParamVariable[];
  /** Count of leading ops already baked into the saved source file. 0 = none. */
  bakedThrough: number;
}

/**
 * Parses + validates sidecar JSON into clean ops + variables. Tolerant:
 * malformed ops/variables are dropped (via {@link validateEditOp} /
 * {@link validateVariables}) rather than throwing, so a hand-edited or
 * partially-corrupt sidecar never blocks opening the model. Op order is
 * preserved — replay depends on it. Ops are re-resolved against the variables
 * here (one of exactly two resolution sites, with the webview's
 * resolve-on-read), which heals stale cached numbers in a hand-edited sidecar.
 */
export function parseEditsJson(text: string): ParsedEdits {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ops: [], variables: [], bakedThrough: 0 };
  }
  const file = data as Partial<EditsSidecarFile> | null;
  const variables = validateVariables(file?.variables);
  const rawOps = file?.ops;
  if (!Array.isArray(rawOps)) return { ops: [], variables, bakedThrough: 0 };

  const ops: EditOp[] = [];
  for (const raw of rawOps) {
    const op = validateEditOp(raw);
    if (op) ops.push(op);
  }
  const bakedRaw = file?.bakedThrough;
  const bakedThrough =
    typeof bakedRaw === "number" && Number.isInteger(bakedRaw)
      ? Math.min(Math.max(bakedRaw, 0), ops.length)
      : 0;
  const { values } = evaluateVariables(variables);
  return { ops: resolveEditOps(ops, values).ops, variables, bakedThrough };
}

/** Serializes ops + variables to the sidecar JSON text (pretty-printed, trailing
 * newline). `variables` is emitted only when non-empty so pre-parametric
 * documents keep their exact previous output; `bakedThrough` only when > 0. */
export function serializeEditsJson(sourceName: string, ops: EditOp[], variables: ParamVariable[] = [], bakedThrough = 0): string {
  const file: EditsSidecarFile = { version: EDITS_SIDECAR_VERSION, source: sourceName, ops };
  if (variables.length > 0) file.variables = variables;
  if (Number.isInteger(bakedThrough) && bakedThrough > 0) file.bakedThrough = Math.min(bakedThrough, ops.length);
  return JSON.stringify(file, null, 2) + "\n";
}

/**
 * Tier 0 save-in-place: the ops actually replayed against the source bytes.
 * The file on disk already contains `ops[0..bakedThrough]`, so only the tail
 * is replayed. Identity (same reference) when there is nothing baked, so
 * callers pay nothing on pre-watermark documents.
 */
export function replayTail(ops: EditOp[], bakedThrough = 0): EditOp[] {
  if (!Number.isInteger(bakedThrough) || bakedThrough <= 0) return ops;
  if (bakedThrough >= ops.length) return [];
  return ops.slice(bakedThrough);
}
