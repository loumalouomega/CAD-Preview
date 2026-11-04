/**
 * Delete-with-dependents (roadmap "History timeline depth"): what would stop
 * resolving if the op at `index` were removed. Pure — the caller supplies the
 * ids the op produced (its `OpBucket` roles) and the ids Parts mention.
 *
 * Wording is "mentioned by", never "used by": entity ids are positional, so a
 * match is a textual reference, not a proven dependency.
 */
import type { EditOp } from "./editOps";

export interface OpDependents {
  /** Later op indices (0-based) whose stored JSON names an id the op produced. */
  laterOps: number[];
  /** Produced ids that a Part (or other id bag) currently lists. */
  partIds: string[];
  /** True when nothing was found. */
  none: boolean;
}

function collectStrings(value: unknown, out: Set<string>): void {
  if (typeof value === "string") out.add(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectStrings(v, out);
}

export function findOpDependents(ops: readonly EditOp[], index: number, producedIds: readonly string[], partIds: readonly string[] = []): OpDependents {
  const produced = new Set(producedIds);
  const laterOps: number[] = [];
  if (produced.size > 0) {
    for (let i = index + 1; i < ops.length; i++) {
      const strings = new Set<string>();
      collectStrings(ops[i], strings);
      for (const s of strings) {
        if (produced.has(s)) { laterOps.push(i); break; }
      }
    }
  }
  const parts = [...new Set(partIds.filter((id) => produced.has(id)))];
  return { laterOps, partIds: parts, none: laterOps.length === 0 && parts.length === 0 };
}

/** One-sentence summary for the inline confirm. */
export function describeDependents(d: OpDependents): string {
  const bits: string[] = [];
  if (d.laterOps.length) bits.push(`mentioned by op ${d.laterOps.map((i) => i + 1).join(", ")}`);
  if (d.partIds.length) bits.push(`${d.partIds.length} Part entity id${d.partIds.length === 1 ? "" : "s"}`);
  return bits.join("; ");
}
