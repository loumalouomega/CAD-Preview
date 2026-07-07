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
  ops: EditOp[];
}

export interface ParsedEdits {
  ops: EditOp[];
  variables: ParamVariable[];
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
    return { ops: [], variables: [] };
  }
  const file = data as Partial<EditsSidecarFile> | null;
  const variables = validateVariables(file?.variables);
  const rawOps = file?.ops;
  if (!Array.isArray(rawOps)) return { ops: [], variables };

  const ops: EditOp[] = [];
  for (const raw of rawOps) {
    const op = validateEditOp(raw);
    if (op) ops.push(op);
  }
  const { values } = evaluateVariables(variables);
  return { ops: resolveEditOps(ops, values).ops, variables };
}

/** Serializes ops + variables to the sidecar JSON text (pretty-printed, trailing
 * newline). `variables` is emitted only when non-empty so pre-parametric
 * documents keep their exact previous output. */
export function serializeEditsJson(sourceName: string, ops: EditOp[], variables: ParamVariable[] = []): string {
  const file: EditsSidecarFile = { version: EDITS_SIDECAR_VERSION, source: sourceName, ops };
  if (variables.length > 0) file.variables = variables;
  return JSON.stringify(file, null, 2) + "\n";
}
