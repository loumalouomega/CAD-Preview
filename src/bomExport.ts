/**
 * Pure, vscode/WASM-free BOM serialization types (roadmap item "BOM export
 * from Parts", closed) — split out of `massProperties.ts` for the same reason
 * every other pure/impure pair in this codebase is split (`partsSidecar.ts`/
 * `partsStore.ts` et al): `mcpTools.ts` must stay importable under vitest
 * with no `.wasm` anywhere in its graph, and it needs {@link bomTsv} as a
 * VALUE, while `massProperties.ts` hosts the OCCT-touching {@link computeBom}
 * half. Kept here rather than duplicating the row shape in two files.
 */

export interface BomRow {
  name: string;
  color: string;
  /** Entity counts as AUTHORED on the part — surfaces/lines/points never
   * contribute to volume/area here; they are listed so the row is a complete
   * picture of what the part claims. */
  solidCount: number;
  surfaceCount: number;
  lineCount: number;
  pointCount: number;
  /** SUM of member solids' INDIVIDUAL volumes — deliberately sum-of-parts,
   * NOT the combined-solid volume: two overlapping members count their
   * overlap twice. That is the BOM/procurement convention (each instance is
   * material you'd order), and it avoids a per-part boolean entirely.
   * `null` when no member resolved to a real solid. */
  volume: number | null;
  area: number | null;
  /** `volumes` ids that didn't resolve in the current (post-edit-replay)
   * shape — same graceful drop-and-report convention as every other
   * unresolved-id path. */
  unresolvedIds: string[];
}

/**
 * Tab-separated BOM serialization — the ready-to-paste spreadsheet handoff
 * (the "Copy BOM" tab-separated convention this feature was mined from).
 * Numbers are rounded to 4 decimal places only HERE (display), never in
 * {@link BomRow} itself; an unmeasurable row leaves the numeric cell empty
 * rather than writing a misleading `0`.
 */
export function bomTsv(rows: BomRow[]): string {
  const fmt = (n: number | null): string => (n === null ? "" : String(Number(n.toFixed(4))));
  const header = ["Name", "Solids", "Surfaces", "Lines", "Points", "Volume_mm3", "Area_mm2", "Unresolved"];
  const lines = rows.map((r) =>
    [
      r.name,
      String(r.solidCount),
      String(r.surfaceCount),
      String(r.lineCount),
      String(r.pointCount),
      fmt(r.volume),
      fmt(r.area),
      r.unresolvedIds.join(","),
    ].join("\t")
  );
  return [header.join("\t"), ...lines].join("\n");
}
