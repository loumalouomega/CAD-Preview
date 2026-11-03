import { validateEditOp, type EditOp } from "./editOps";
import { validateVariables, evaluateVariables, resolveEditOps, type ParamVariable } from "./editVariables";
import { validateConfigurationState, effectiveVariables, type Configuration, type ConfigurationState } from "./configurations";

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
  /** Named configurations (design table); omitted when empty. Additive: older files lack it. */
  configurations?: Configuration[];
  /** The applied configuration's name; omitted when none. */
  activeConfiguration?: string;
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
  /** Named configurations (sparse variable overrides). Absent on a file that has none. */
  configurations?: Configuration[];
  /** Name of the applied configuration, if it names one of `configurations`. */
  activeConfiguration?: string | null;
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
  const config = validateConfigurationState(file?.configurations, file?.activeConfiguration);
  const configFields = config.configurations.length > 0 ? { configurations: config.configurations, activeConfiguration: config.activeConfiguration } : {};
  const rawOps = file?.ops;
  if (!Array.isArray(rawOps)) return { ops: [], variables, ...configFields, bakedThrough: 0 };

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
  // Base caches heal first; the ops are then resolved against the ACTIVE
  // configuration's overlay (clones), so the stored base variables never take
  // a configuration's values.
  const base = evaluateVariables(variables);
  const values = config.activeConfiguration ? evaluateVariables(effectiveVariables(variables, config).variables).values : base.values;
  return { ops: resolveEditOps(ops, values).ops, variables, ...configFields, bakedThrough };
}

/** Serializes ops + variables to the sidecar JSON text (pretty-printed, trailing
 * newline). `variables` is emitted only when non-empty so pre-parametric
 * documents keep their exact previous output; `bakedThrough` only when > 0. */
export function serializeEditsJson(
  sourceName: string,
  ops: EditOp[],
  variables: ParamVariable[] = [],
  bakedThrough = 0,
  configState?: Partial<ConfigurationState> | null
): string {
  const file: EditsSidecarFile = { version: EDITS_SIDECAR_VERSION, source: sourceName, ops };
  if (variables.length > 0) file.variables = variables;
  const config = validateConfigurationState(configState?.configurations, configState?.activeConfiguration);
  if (config.configurations.length > 0) {
    file.configurations = config.configurations;
    if (config.activeConfiguration) file.activeConfiguration = config.activeConfiguration;
  }
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

/** True when `next` is `prev` with one or more ops appended and nothing else
 * changed — what the edits watcher sees when another writer (an agent calling
 * `apply_edit_ops`) adds to the stack. Compared by JSON so a reordered or
 * edited prefix is not mistaken for an append. */
export function isExternalAppend(prev: readonly EditOp[], next: readonly EditOp[]): boolean {
  if (next.length <= prev.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (JSON.stringify(prev[i]) !== JSON.stringify(next[i])) return false;
  }
  return true;
}
