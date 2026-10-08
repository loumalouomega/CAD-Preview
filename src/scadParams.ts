/**
 * OpenSCAD Customizer parameters — a pure reader and an override validator.
 *
 * OpenSCAD's Customizer treats the top-level `name = literal;` assignments that
 * come BEFORE the first `module` / `function` definition as the model's
 * parameters, with metadata carried in comments:
 *
 *   [Dimensions] as a block comment   group header (a [Hidden] group is not shown)
 *   // Wall thickness            description (the comment line above)
 *   wall = 2;      // [0.5:0.5:10]   range [min:step:max] or [min:max]
 *   style = "round"; // [round, square:Square corners]   option list (value:label)
 *
 * Reading this is what lets a caller (an agent today) re-run a `.scad` file at
 * different dimensions through `openscad -D name=value` WITHOUT editing the
 * source — the one SCADarina capability (a parameter form over the real
 * OpenSCAD) that fits this extension's "source is never written" model.
 *
 * Deliberately a line scanner, not a parser for the OpenSCAD language: the
 * Customizer itself only honours single-line literal assignments, so anything
 * else (an expression, a multi-line vector, a nested vector) is not a parameter
 * and is skipped rather than guessed at. Pure and dependency-free so it
 * unit-tests headless, like `svgImport.ts` / `dxfImport.ts`.
 */

/** A value `-D` can carry: number, boolean, string, or a flat vector of numbers/strings. */
export type ScadValue = number | boolean | string | Array<number | string>;

export type ScadParamKind = "number" | "boolean" | "string" | "vector";

export interface ScadParamOption {
  value: number | string;
  label?: string;
}

export interface ScadParameter {
  name: string;
  kind: ScadParamKind;
  /** The literal default, parsed. */
  default: ScadValue;
  /** `[Group]` header in force at the assignment ("" before any header). */
  group: string;
  /** True inside a `[Hidden]` group — present in the source, not for editing. */
  hidden: boolean;
  /** The `//` comment line directly above the assignment, if any. */
  description?: string;
  /** From a `[min:max]` / `[min:step:max]` annotation (numbers only). */
  min?: number;
  max?: number;
  step?: number;
  /** From a `[a, b, c]` / `[a:Label, ...]` annotation. */
  options?: ScadParamOption[];
  /** 1-based source line, for pointing a caller at the assignment. */
  line: number;
}

const NUM = String.raw`-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;
const STR = String.raw`"(?:[^"\\]|\\.)*"`;
const NAME = String.raw`[A-Za-z_$][A-Za-z0-9_$]*`;

const ASSIGN = new RegExp(String.raw`^\s*(${NAME})\s*=\s*(${STR}|\[[^\]\[]*\]|true|false|${NUM})\s*;\s*(?://\s*(.*))?$`);
const GROUP = /^\s*\/\*\s*\[\s*([^\]]*?)\s*\]\s*\*\/\s*$/;
const STOP = /^\s*(?:module|function)\b/;
const NUM_ONLY = new RegExp(`^${NUM}$`);

/** Unquotes an OpenSCAD string literal (the JSON escapes are the same subset it supports). */
function unquote(lit: string): string {
  try {
    return JSON.parse(lit) as string;
  } catch {
    return lit.slice(1, -1);
  }
}

function parseElement(raw: string): number | string | undefined {
  const t = raw.trim();
  if (NUM_ONLY.test(t)) return Number(t);
  if (new RegExp(`^${STR}$`).test(t)) return unquote(t);
  return undefined;
}

function parseLiteral(rhs: string): { kind: ScadParamKind; value: ScadValue } | undefined {
  if (rhs === "true" || rhs === "false") return { kind: "boolean", value: rhs === "true" };
  if (NUM_ONLY.test(rhs)) return { kind: "number", value: Number(rhs) };
  if (rhs.startsWith('"')) return { kind: "string", value: unquote(rhs) };
  if (rhs.startsWith("[")) {
    const inner = rhs.slice(1, -1).trim();
    if (inner === "") return { kind: "vector", value: [] };
    // Split on commas outside quotes.
    const parts = inner.match(new RegExp(`${STR}|[^,]+`, "g")) ?? [];
    const out: Array<number | string> = [];
    for (const p of parts) {
      const v = parseElement(p);
      if (v === undefined) return undefined;
      out.push(v);
    }
    return { kind: "vector", value: out };
  }
  return undefined;
}

/**
 * Reads a trailing `// [..]` annotation. `[min:max]` and `[min:step:max]` are
 * ranges (numbers only); a comma list is an option list, each entry
 * `value` or `value:label`. Returns `{}` for a plain comment or anything
 * malformed — an annotation is advisory, never a reason to drop the parameter.
 */
function parseAnnotation(
  comment: string | undefined,
  kind: ScadParamKind
): { min?: number; max?: number; step?: number; options?: ScadParamOption[] } {
  const m = comment?.trim().match(/^\[(.*)\]\s*$/);
  if (!m) return {};
  const body = m[1].trim();
  if (kind === "number" && !body.includes(",")) {
    const bits = body.split(":").map((s) => s.trim());
    if ((bits.length === 2 || bits.length === 3) && bits.every((b) => NUM_ONLY.test(b))) {
      const nums = bits.map(Number);
      return bits.length === 2 ? { min: nums[0], max: nums[1] } : { min: nums[0], step: nums[1], max: nums[2] };
    }
  }
  if (kind !== "number" && kind !== "string") return {};
  const options: ScadParamOption[] = [];
  for (const entry of body.split(",")) {
    const [rawValue, ...labelBits] = entry.split(":");
    const valueText = rawValue.trim();
    if (valueText === "") continue;
    const value: number | string = kind === "number" ? (NUM_ONLY.test(valueText) ? Number(valueText) : NaN) : valueText.replace(/^"(.*)"$/, "$1");
    if (typeof value === "number" && Number.isNaN(value)) return {};
    const label = labelBits.join(":").trim();
    options.push(label === "" ? { value } : { value, label });
  }
  return options.length > 0 ? { options } : {};
}

/**
 * Reads the Customizer parameters out of `.scad` source text. Never throws:
 * a file with none yields `[]`. Scanning stops at the first `module` /
 * `function` line, matching where OpenSCAD itself stops looking.
 */
export function parseScadParameters(text: string): ScadParameter[] {
  const out: ScadParameter[] = [];
  const lines = text.split(/\r?\n/);
  let group = "";
  let prevComment: string | undefined;
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (STOP.test(line)) break;
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      prevComment = undefined;
      continue;
    }
    const g = line.match(GROUP);
    if (g) {
      group = g[1];
      prevComment = undefined;
      continue;
    }
    if (/^\s*\/\*/.test(line) && !line.includes("*/")) {
      inBlockComment = true;
      prevComment = undefined;
      continue;
    }
    const slash = line.match(/^\s*\/\/\s?(.*)$/);
    if (slash) {
      prevComment = slash[1].trim();
      continue;
    }
    const a = line.match(ASSIGN);
    if (a) {
      const lit = parseLiteral(a[2]);
      if (lit) {
        const param: ScadParameter = {
          name: a[1],
          kind: lit.kind,
          default: lit.value,
          group,
          hidden: group.toLowerCase() === "hidden",
          line: i + 1,
          ...parseAnnotation(a[3], lit.kind),
        };
        if (prevComment) param.description = prevComment;
        out.push(param);
      }
    }
    prevComment = undefined;
  }
  return out;
}

/** True for a name `-D` may legally assign (identifiers and `$`-specials). */
export function isValidScadName(name: string): boolean {
  return new RegExp(`^${NAME}$`).test(name);
}

/**
 * Renders a value as the OpenSCAD expression `-D name=<expr>` expects.
 * Strings use JSON quoting (the escapes OpenSCAD accepts); non-finite numbers
 * are rejected by the caller before this point.
 */
export function formatScadValue(value: ScadValue): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  return `[${value.map((v) => (typeof v === "number" ? String(v) : JSON.stringify(v))).join(", ")}]`;
}

export interface ScadOverrideResult {
  /** Overrides that passed validation, ready for `-D`. */
  defines: Record<string, ScadValue>;
  /** Everything reported-and-dropped or applied-with-a-note. */
  warnings: string[];
}

function sameKind(param: ScadParameter, value: unknown): boolean {
  switch (param.kind) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "vector":
      return (
        Array.isArray(value) &&
        value.every((v) => (typeof v === "number" && Number.isFinite(v)) || typeof v === "string") &&
        (param.default as unknown[]).length === value.length
      );
  }
}

/**
 * Validates caller overrides against the file's parameters. An override that
 * names an unknown variable or has the wrong type is reported and NOT applied
 * (a typo must never silently become a different model — the same rule the
 * macro library's parameter merge follows); an out-of-range or off-list value
 * is applied with a note, since OpenSCAD itself does not clamp. `$`-specials
 * (`$fn`, `$fa`, `$fs`) are accepted without being declared, as they are real
 * top-level knobs the Customizer never lists.
 */
export function validateScadOverrides(params: ScadParameter[], overrides: Record<string, unknown>): ScadOverrideResult {
  const byName = new Map(params.map((p) => [p.name, p]));
  const defines: Record<string, ScadValue> = {};
  const warnings: string[] = [];
  for (const [name, raw] of Object.entries(overrides)) {
    if (!isValidScadName(name)) {
      warnings.push(`Override "${name}" ignored: not a valid OpenSCAD variable name.`);
      continue;
    }
    const param = byName.get(name);
    if (!param) {
      if (name.startsWith("$") && (typeof raw === "number" || typeof raw === "boolean") && (typeof raw !== "number" || Number.isFinite(raw))) {
        defines[name] = raw;
      } else {
        warnings.push(`Override "${name}" ignored: not a Customizer parameter of this file (see list_scad_parameters).`);
      }
      continue;
    }
    if (!sameKind(param, raw)) {
      warnings.push(`Override "${name}" ignored: expected a ${param.kind}${param.kind === "vector" ? ` of ${(param.default as unknown[]).length}` : ""}.`);
      continue;
    }
    const value = raw as ScadValue;
    defines[name] = value;
    if (typeof value === "number") {
      if (param.min !== undefined && value < param.min) warnings.push(`Override "${name}" = ${value} is below the declared minimum ${param.min}; applied as given.`);
      if (param.max !== undefined && value > param.max) warnings.push(`Override "${name}" = ${value} is above the declared maximum ${param.max}; applied as given.`);
    }
    if (param.options && (typeof value === "number" || typeof value === "string") && !param.options.some((o) => o.value === value)) {
      warnings.push(`Override "${name}" = ${JSON.stringify(value)} is not one of the declared options; applied as given.`);
    }
  }
  return { defines, warnings };
}
