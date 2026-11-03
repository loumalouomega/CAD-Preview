/**
 * Configurations (design table) — pure, vscode-free, DOM-free.
 *
 * A configuration is a NAME plus a sparse map from variable name to an
 * expression override. The active one is overlaid onto the document variables
 * BEFORE the existing resolve-on-read, so stored ops (and their `exprs`) never
 * change: the same op list yields an M6 or an M8 depending only on which
 * configuration is applied. Variables are the only thing a configuration
 * changes — never Parts, mesh options or layers.
 *
 * Stored additively in `<model>.edits.json` (`configurations`,
 * `activeConfiguration`); a sidecar without them behaves exactly as before.
 */
import { evaluateVariables, type ParamVariable } from "./editVariables";
import { isValidVariableName } from "./paramExpr";

export interface Configuration {
  name: string;
  /** Sparse: variable name → expression replacing that variable's own `expr`. */
  overrides: Record<string, string>;
}

export interface ConfigurationState {
  configurations: Configuration[];
  /** Name of the applied configuration, or null for "use the variables as written". */
  activeConfiguration: string | null;
}

export const EMPTY_CONFIGURATION_STATE: ConfigurationState = { configurations: [], activeConfiguration: null };

export const MAX_CONFIGURATIONS = 64;
export const MAX_CONFIGURATION_NAME_LENGTH = 64;
const MAX_OVERRIDE_EXPR_LENGTH = 256;

/** A usable configuration name: trimmed, non-empty, bounded, no control characters. */
export function normalizeConfigurationName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name === "" || name.length > MAX_CONFIGURATION_NAME_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/**
 * Tolerance gate for a raw `configurations` array (sidecar or message): drops
 * entries with a bad/duplicate name (first wins) and individual overrides whose
 * variable name or expression is not a bounded string. Never throws.
 */
export function validateConfigurations(raw: unknown): Configuration[] {
  if (!Array.isArray(raw)) return [];
  const out: Configuration[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_CONFIGURATIONS) break;
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const name = normalizeConfigurationName(c.name);
    if (name === null || seen.has(name)) continue;
    const overrides: Record<string, string> = Object.create(null) as Record<string, string>;
    if (c.overrides && typeof c.overrides === "object" && !Array.isArray(c.overrides)) {
      for (const [key, expr] of Object.entries(c.overrides as Record<string, unknown>)) {
        if (!isValidVariableName(key)) continue;
        if (typeof expr !== "string" || expr.trim() === "" || expr.length > MAX_OVERRIDE_EXPR_LENGTH) continue;
        overrides[key] = expr;
      }
    }
    seen.add(name);
    out.push({ name, overrides: { ...overrides } });
  }
  return out;
}

/** Validates the pair; an `activeConfiguration` that names nothing becomes null. */
export function validateConfigurationState(rawConfigurations: unknown, rawActive: unknown): ConfigurationState {
  const configurations = validateConfigurations(rawConfigurations);
  const active = normalizeConfigurationName(rawActive);
  return {
    configurations,
    activeConfiguration: active !== null && configurations.some((c) => c.name === active) ? active : null,
  };
}

export function findConfiguration(state: ConfigurationState, name: string | null | undefined): Configuration | null {
  if (name == null) return null;
  return state.configurations.find((c) => c.name === name) ?? null;
}

/**
 * The variables with `config`'s overrides applied. Returns CLONES, so the
 * evaluation that follows (which writes each variable's cached `value`) never
 * touches the stored base variables. An override for a variable that does not
 * exist is ignored (it may come back through undo). A null configuration
 * returns the clones unchanged.
 */
export function applyConfiguration(variables: readonly ParamVariable[], config: Configuration | null): ParamVariable[] {
  return variables.map((v) => {
    const clone: ParamVariable = { ...v };
    const override = config ? config.overrides[v.name] : undefined;
    if (typeof override === "string") clone.expr = override;
    return clone;
  });
}

/**
 * The variables the document should be resolved with: the active configuration
 * (or `override`, when a caller evaluates a named one without changing the
 * stored selection) overlaid on the base variables. `unknown` is set when the
 * requested name does not exist, so a caller can refuse or warn instead of
 * silently using the base values.
 */
export function effectiveVariables(
  variables: readonly ParamVariable[],
  state: ConfigurationState,
  override?: string | null
): { variables: ParamVariable[]; configuration: string | null; unknown: boolean } {
  const wanted = override === undefined ? state.activeConfiguration : override;
  if (wanted === null) return { variables: applyConfiguration(variables, null), configuration: null, unknown: false };
  const config = findConfiguration(state, wanted);
  if (!config) return { variables: applyConfiguration(variables, null), configuration: null, unknown: true };
  return { variables: applyConfiguration(variables, config), configuration: config.name, unknown: false };
}

/** Evaluates the effective variables (clones): values by name + per-variable errors. */
export function evaluateEffective(
  variables: readonly ParamVariable[],
  state: ConfigurationState,
  override?: string | null
): { variables: ParamVariable[]; values: Record<string, number>; errors: Map<string, string>; configuration: string | null; unknown: boolean } {
  const eff = effectiveVariables(variables, state, override);
  const { values, errors } = evaluateVariables(eff.variables);
  return { variables: eff.variables, values, errors, configuration: eff.configuration, unknown: eff.unknown };
}

// ---------------------------------------------------------------------------
// Pure state mutations (used by the webview model and the MCP tool). Every one
// returns a NEW state and never throws; `error` carries the refusal text.
// ---------------------------------------------------------------------------

export type ConfigurationResult = { state: ConfigurationState; error?: string };

export function addConfiguration(state: ConfigurationState, rawName: string, copyFrom?: string): ConfigurationResult {
  const name = normalizeConfigurationName(rawName);
  if (name === null) return { state, error: `A configuration name must be 1-${MAX_CONFIGURATION_NAME_LENGTH} printable characters.` };
  if (findConfiguration(state, name)) return { state, error: `A configuration named "${name}" already exists.` };
  if (state.configurations.length >= MAX_CONFIGURATIONS) return { state, error: `At most ${MAX_CONFIGURATIONS} configurations.` };
  const source = copyFrom ? findConfiguration(state, copyFrom) : null;
  return {
    state: {
      ...state,
      configurations: [...state.configurations, { name, overrides: source ? { ...source.overrides } : {} }],
    },
  };
}

export function renameConfiguration(state: ConfigurationState, from: string, rawTo: string): ConfigurationResult {
  const to = normalizeConfigurationName(rawTo);
  if (!findConfiguration(state, from)) return { state, error: `No configuration named "${from}".` };
  if (to === null) return { state, error: `A configuration name must be 1-${MAX_CONFIGURATION_NAME_LENGTH} printable characters.` };
  if (to !== from && findConfiguration(state, to)) return { state, error: `A configuration named "${to}" already exists.` };
  return {
    state: {
      configurations: state.configurations.map((c) => (c.name === from ? { ...c, name: to } : c)),
      activeConfiguration: state.activeConfiguration === from ? to : state.activeConfiguration,
    },
  };
}

export function removeConfiguration(state: ConfigurationState, name: string): ConfigurationResult {
  if (!findConfiguration(state, name)) return { state, error: `No configuration named "${name}".` };
  return {
    state: {
      configurations: state.configurations.filter((c) => c.name !== name),
      activeConfiguration: state.activeConfiguration === name ? null : state.activeConfiguration,
    },
  };
}

/** Select the applied configuration (null = base variables). */
export function activateConfiguration(state: ConfigurationState, name: string | null): ConfigurationResult {
  if (name !== null && !findConfiguration(state, name)) return { state, error: `No configuration named "${name}".` };
  return { state: { ...state, activeConfiguration: name } };
}

/**
 * Set (or, with an empty/blank expression, clear) one cell. A cell that equals
 * the variable's own expression is stored as no override, keeping the map
 * sparse.
 */
export function setConfigurationCell(
  state: ConfigurationState,
  name: string,
  variable: string,
  expr: string,
  baseExpr?: string
): ConfigurationResult {
  if (!findConfiguration(state, name)) return { state, error: `No configuration named "${name}".` };
  if (!isValidVariableName(variable)) return { state, error: `"${variable}" is not a valid variable name.` };
  const trimmed = expr.trim();
  if (trimmed.length > MAX_OVERRIDE_EXPR_LENGTH) return { state, error: "That expression is too long." };
  const clear = trimmed === "" || (baseExpr !== undefined && trimmed === baseExpr.trim());
  return {
    state: {
      ...state,
      configurations: state.configurations.map((c) => {
        if (c.name !== name) return c;
        const overrides = { ...c.overrides };
        if (clear) delete overrides[variable];
        else overrides[variable] = trimmed;
        return { ...c, overrides };
      }),
    },
  };
}

/** Variable renamed: carry every configuration's override across. */
export function renameVariableInConfigurations(state: ConfigurationState, from: string, to: string): ConfigurationState {
  if (from === to) return state;
  return {
    ...state,
    configurations: state.configurations.map((c) => {
      if (!(from in c.overrides)) return c;
      const overrides = { ...c.overrides };
      overrides[to] = overrides[from];
      delete overrides[from];
      return { ...c, overrides };
    }),
  };
}

// ---------------------------------------------------------------------------
// Config Table rows (what the grid renders) and file naming.
// ---------------------------------------------------------------------------

export interface ConfigTableCell {
  variable: string;
  /** The override expression, or null when the cell inherits the variable's own. */
  override: string | null;
  /** The expression that is in force for this cell. */
  expr: string;
  /** Evaluated value (the frozen last-good cache when `error` is set). */
  value: number;
  error?: string;
}

export interface ConfigTableRow {
  /** null = the base variables as written (the "Base" row). */
  name: string | null;
  active: boolean;
  cells: ConfigTableCell[];
}

/**
 * The grid: a Base row plus one row per configuration, one cell per variable.
 * Each row is evaluated on cloned variables, so a failing cell freezes at the
 * variable's cached value and never throws.
 */
export function configurationTable(variables: readonly ParamVariable[], state: ConfigurationState): ConfigTableRow[] {
  const rows: ConfigTableRow[] = [];
  const build = (config: Configuration | null): ConfigTableRow => {
    const eff = applyConfiguration(variables, config);
    const { errors } = evaluateVariables(eff);
    return {
      name: config ? config.name : null,
      active: (config ? config.name : null) === state.activeConfiguration,
      cells: eff.map((v) => {
        const override = config && typeof config.overrides[v.name] === "string" ? config.overrides[v.name] : null;
        const error = errors.get(v.name);
        return { variable: v.name, override, expr: v.expr, value: v.value, ...(error ? { error } : {}) };
      }),
    };
  };
  rows.push(build(null));
  for (const c of state.configurations) rows.push(build(c));
  return rows;
}

/** A configuration name as a file-name fragment: separators and awkward characters become `_`. */
export function configurationFileSlug(name: string): string {
  const slug = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  return slug === "" ? "config" : slug;
}

/** Tools that accept the optional `configuration` parameter (evaluated without changing the stored selection). Read-only exports and meshing. */
export const CONFIGURATION_PARAM_TOOLS: readonly string[] = [
  "export_brep",
  "export_mesh",
  "generate_mesh",
  "export_tessellated_stl",
  "estimate_mesh_budget",
  "export_technical_drawing",
  "export_drawing_sheet",
  "get_mass_properties",
  "load_model",
  "render_snapshot",
  "screenshot_shape",
];
