/**
 * Re-executable selector queries — roadmap item 1 ("Selector synthesis"),
 * ladder rung 1: whole-bucket queries.
 *
 * Phase 1 (closed) records per-op classification buckets (`opBuckets.ts`):
 * which `face-N` ids each topology-changing op produced, valid against the
 * model state AT that op's own step. Rung 1 makes that record re-executable:
 * `{version: 1, source: {kind: "bucket", op, role}}` names "the faces op N
 * produced in role R" without baking in positional ids, so a later replay can
 * re-derive the CURRENT ids by geometric match instead of trusting stale ones.
 *
 * Pure and vscode/OCCT/THREE-free (same split as `opBuckets.ts`/
 * `entityRebind.ts`): this module holds the query shape, the tolerant gate,
 * the bindability check, and the bucket-id extraction helper. The OCCT-
 * touching half (prefix replay + `rebindEntities` match + oracle compare)
 * lives in `entityFacts.ts`'s `resolveBucketSelector` — same pure/impure
 * split as `entityRebind.ts`/`entityFacts.ts`.
 *
 * Scope discipline (roadmap): the query language stays a small predicate AST
 * persisted as JSON, resolved by a tolerant gate — NOT a new expression
 * language and NOT executable code (same call as `paramExpr.ts`, which
 * rejected `eval()` on CSP grounds). Later rungs (induced predicate,
 * scene-wide predicate, bucket indices) grow this union; rung 1 is the
 * bucket source only.
 */

import { ROLE_LABELS, type OpBucket, type OpRole } from "./opBuckets";
import type { EditOp } from "./editOps";

/** Rung-1 query: "the faces op N produced in role R". */
export interface BucketSelector {
  version: 1;
  source: { kind: "bucket"; op: number; role: OpRole };
}

/** Union grows in later rungs; rung 1 has the single bucket source. */
export type SelectorQuery = BucketSelector;

/** Caps mirroring `sanitizeExprs`' self-healing discipline (no silent unbounded input). */
export const MAX_SELECTOR_OP_INDEX = 10000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidRole(role: unknown): role is OpRole {
  return typeof role === "string" && role in ROLE_LABELS;
}

/**
 * Tolerant structural gate — mirrors `validateEditOp`'s "drop, never crash"
 * rule: malformed input returns `null` (callers surface a diagnostic), never
 * throws. Unknown future fields are ignored so a v1 reader degrades gracefully
 * on additive growth.
 */
export function validateSelectorQuery(raw: unknown): SelectorQuery | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== 1) return null;
  const source = raw.source;
  if (!isRecord(source)) return null;
  if (source.kind !== "bucket") return null;
  const op = source.op;
  if (typeof op !== "number" || !Number.isInteger(op) || op < 0 || op > MAX_SELECTOR_OP_INDEX) return null;
  if (!isValidRole(source.role)) return null;
  return { version: 1, source: { kind: "bucket", op, role: source.role } };
}

/**
 * Bindability gate — the roadmap's correctness rule carried over verbatim: a
 * pick whose producing op was a pattern instance cannot be safely named,
 * because the name would be ambiguous across instances. A bucket query whose
 * producing op is `patternLinear`/`patternCircular` is refused (resolved only
 * via a future scene-wide predicate rung), as is a query pointing past the
 * end of the op list. Getting this wrong would silently resolve to the wrong
 * instance — the misleading-false-result failure mode this file gates other
 * items behind a report for.
 */
export function isBindableSelector(ops: EditOp[], query: SelectorQuery): boolean {
  const opIndex = query.source.op;
  if (opIndex < 0 || opIndex >= ops.length) return false;
  const kind = ops[opIndex].op;
  if (kind === "patternLinear" || kind === "patternCircular") return false;
  return true;
}

/**
 * Extracts the recorded (step-local) ids for a bucket query from a replay's
 * `opBuckets` — the reference set the kernel matcher fingerprints. Returns
 * `[]` when the op produced no bucket or the role is absent (an op that
 * gracefully skipped records no bucket; a wireframe op records none) — the
 * caller treats that as "nothing to resolve", never a fabricated match.
 */
export function bucketReferenceIds(buckets: OpBucket[], query: SelectorQuery): string[] {
  const bucket = buckets.find((b) => b.op === query.source.op);
  if (!bucket) return [];
  return [...(bucket.roles[query.source.role] ?? [])];
}
