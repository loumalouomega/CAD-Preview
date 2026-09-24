/**
 * Pure half of the B-rep validity report (no OCCT, no vscode, no DOM) — the
 * report shape plus the small bookkeeping the kernel half needs, kept here so
 * it unit-tests headless and the webview can import the types without pulling
 * in the kernel's module graph.
 *
 * Every field is a FACT from OCCT's own checkers, never a pass/fail verdict of
 * ours (`verdictConventions`): `BRepCheck_Analyzer` for validity and named
 * statuses, `ShapeAnalysis_ShapeContents` for counters, `ShapeAnalysis_Shell`
 * for open-boundary edges.
 */

/** One subshape the analyzer judged invalid, or that carries a non-NoError
 * status. `id` is `solid-N`/`face-N`/`edge-N` (the same positional ids every
 * other tool uses) or a report-local `shell-N` — shells have no entity id
 * anywhere else in this codebase, so `shell-N` is NOT an operand id. */
export interface BrepSubshapeIssue {
  id: string;
  /** `BRepCheck_Status` member names without the `BRepCheck_` prefix
   * (`"UnorientableShape"`, `"NotClosed"`, …). Can be empty: OCCT sometimes
   * marks a parent invalid only because a child is, with no status of its own. */
  statuses: string[];
  /** `BRepCheck_Analyzer.IsValid(sub)`. */
  valid: boolean;
}

export interface BrepSolidHealth {
  solidId: string;
  /** `IsValid(solid)` — covers the solid's whole subshape tree. */
  valid: boolean;
  shellCount: number;
  /** Shells of this solid carrying the `NotClosed` status. */
  openShellCount: number;
  /** Edges bounding exactly one face of this solid's shells
   * (`ShapeAnalysis_Shell.FreeEdges`) — 0 for a closed solid. */
  openBoundaryEdgeCount: number | null;
}

export interface BrepHealthCounters {
  solids: number;
  shells: number;
  faces: number;
  edges: number;
  /** `NbFreeEdges`: edges belonging to no face at all (wireframe debris) —
   * NOT open-boundary edges, which `openBoundaryEdgeCount` reports. */
  looseEdges: number;
  /** `NbFreeFaces`: faces belonging to no shell. */
  looseFaces: number;
  looseWires: number;
  solidsWithVoids: number;
}

export interface BrepHealthReport {
  /** `BRepCheck_Analyzer.IsValid()` over the whole (edited) shape. */
  valid: boolean;
  counters: BrepHealthCounters | null;
  /** Open-boundary edges over every shell in the shape. */
  openBoundaryEdgeCount: number | null;
  solids: BrepSolidHealth[];
  /** At most `MAX_REPORTED_ISSUES`, in solid → shell → face → edge order. */
  issues: BrepSubshapeIssue[];
  /** Total issues found, before capping. */
  issueCount: number;
  /** Subshapes checked (solids + shells + faces + edges). */
  analyzedSubshapes: number;
  elapsedMs: number;
}

/** Cap on `issues` — a badly broken import can flag thousands of edges, and a
 * report is for reading. `issueCount` still carries the true total. */
export const MAX_REPORTED_ISSUES = 200;

/** Builds the `value → name` table from the bound `BRepCheck_Status` enum
 * object (its members are `{value}` objects keyed `BRepCheck_<Name>`). */
export function statusNameTable(enumObj: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const [key, member] of Object.entries(enumObj)) {
    if (!key.startsWith("BRepCheck_")) continue;
    const v = (member as { value?: unknown })?.value;
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) names[v] = key.slice("BRepCheck_".length);
  }
  return names;
}

/** Maps raw status values to names, dropping `NoError`, de-duplicating, and
 * keeping first-seen order. An unknown value surfaces as `#<n>`, never dropped. */
export function statusNames(values: number[], table: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const name = table[v] ?? `#${v}`;
    if (name === "NoError" || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** Keeps the first `MAX_REPORTED_ISSUES`. */
export function capIssues(issues: BrepSubshapeIssue[]): BrepSubshapeIssue[] {
  return issues.length > MAX_REPORTED_ISSUES ? issues.slice(0, MAX_REPORTED_ISSUES) : issues;
}

/** One-line fact summary for status lines and MCP warnings. */
export function summarizeBrepHealth(r: BrepHealthReport): string {
  const parts = [r.valid ? "valid per BRepCheck" : "INVALID per BRepCheck"];
  if (r.issueCount > 0) parts.push(`${r.issueCount} subshape issue(s)`);
  if (r.openBoundaryEdgeCount != null && r.openBoundaryEdgeCount > 0) parts.push(`${r.openBoundaryEdgeCount} open-boundary edge(s)`);
  return parts.join(" · ");
}
