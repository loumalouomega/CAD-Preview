import { extractIdentifiers } from "./paramExpr";

/** One op whose `exprs` reference a variable. */
export interface UsedByOp {
  /** Index in the full op list (the history row number minus one). */
  opIndex: number;
  /** The op kind, for the row label. */
  op: string;
  /** Field paths (`length`, `size[1]`) whose expression references the variable. */
  fields: string[];
}

/** Everything that references one variable. */
export interface VariableUsage {
  ops: UsedByOp[];
  /** Total referencing op fields — the number the delete button's tooltip quotes. */
  fieldCount: number;
  /** Names of OTHER variables whose expression references this one. */
  variables: string[];
}

export const EMPTY_USAGE: VariableUsage = { ops: [], fieldCount: 0, variables: [] };

/**
 * Who references each variable, keyed by variable name. Pure and DOM-free:
 * references are *names* stored in an op's `exprs` annotation and in other
 * variables' expressions, so unlike entity ids they are never positional.
 * A variable absent from the map is unused.
 */
export function collectVariableUsage(
  ops: ReadonlyArray<{ op: string; exprs?: Record<string, string> }>,
  vars: ReadonlyArray<{ name: string; expr: string }>
): Map<string, VariableUsage> {
  const usage = new Map<string, VariableUsage>();
  const entry = (name: string): VariableUsage => {
    let u = usage.get(name);
    if (!u) usage.set(name, (u = { ops: [], fieldCount: 0, variables: [] }));
    return u;
  };
  ops.forEach((op, opIndex) => {
    const perVar = new Map<string, string[]>();
    for (const [path, expr] of Object.entries(op.exprs ?? {})) {
      for (const ident of extractIdentifiers(expr)) {
        const fields = perVar.get(ident);
        if (fields) fields.push(path);
        else perVar.set(ident, [path]);
      }
    }
    for (const [name, fields] of perVar) {
      const u = entry(name);
      u.ops.push({ opIndex, op: op.op, fields });
      u.fieldCount += fields.length;
    }
  });
  for (const v of vars) {
    for (const ident of extractIdentifiers(v.expr)) {
      if (ident === v.name) continue;
      const u = entry(ident);
      if (!u.variables.includes(v.name)) u.variables.push(v.name);
    }
  }
  return usage;
}

/** "2 edit fields and 1 variable" — one sentence shared by the delete tooltip and the Used-by label. */
export function usageSummary(u: VariableUsage): string {
  const parts: string[] = [];
  if (u.fieldCount > 0) parts.push(`${u.fieldCount} edit field${u.fieldCount === 1 ? "" : "s"}`);
  if (u.variables.length > 0) parts.push(`${u.variables.length} variable${u.variables.length === 1 ? "" : "s"}`);
  return parts.join(" and ");
}

/** The delete button's tooltip; the Used-by disclosure quotes the same summary. */
export function deleteTooltip(u: VariableUsage): string {
  if (u.fieldCount === 0 && u.variables.length === 0) return "Delete variable";
  const freeze = u.fieldCount > 0 ? " — they will freeze at their current values" : "";
  return `Delete variable (referenced by ${usageSummary(u)}${freeze})`;
}
