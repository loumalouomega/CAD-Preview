/**
 * Re-executable selector queries — roadmap item 1 ("Selector synthesis"),
 * ladder rungs 1–2: whole-bucket queries plus an induced predicate layer.
 *
 * Phase 1 (closed) records per-op classification buckets (`opBuckets.ts`):
 * which `face-N` ids each topology-changing op produced, valid against the
 * model state AT that op's own step. Rung 1 makes that record re-executable:
 * `{version: 1, source: {kind: "bucket", op, role}}` names "the faces op N
 * produced in role R" without baking in positional ids, so a later replay can
 * re-derive the CURRENT ids by geometric match instead of trusting stale ones.
 * Rung 2 narrows that set without baking in coordinates: an optional
 * `filter` (a `FacePredicate` from `selectorPredicate.ts` — planar, surface
 * type, normal direction, area thresholds) plus an optional `rank` (top-N by
 * area), e.g. "op 3's `endCap` face with the largest area".
 *
 * Pure and vscode/OCCT/THREE-free (same split as `opBuckets.ts`/
 * `entityRebind.ts`): this module holds the query shape, the tolerant gate,
 * the bindability check, and the bucket-id extraction helper. The OCCT-
 * touching half (prefix replay + `rebindEntities` match + oracle compare +
 * current-shape fact fetch for the induced layer) lives in `entityFacts.ts`'s
 * `resolveBucketSelector` — same pure/impure split as
 * `entityRebind.ts`/`entityFacts.ts`.
 *
 * Scope discipline (roadmap): the query language stays a small predicate AST
 * persisted as JSON, resolved by a tolerant gate — NOT a new expression
 * language and NOT executable code (same call as `paramExpr.ts`, which
 * rejected `eval()` on CSP grounds). Later rungs (scene-wide predicate,
 * bucket indices) grow this union; edge-direction/smoothness leaves need
 * live-WASM probes first and are out of rung 2 (no host field exists).
 */

import { ROLE_LABELS, type OpBucket, type OpRole } from "./opBuckets";
import { validateFacePredicate, validateSelectorRank, type FacePredicate, type SelectorRank } from "./selectorPredicate";
import type { EditOp } from "./editOps";

/** Rung-1 query: "the faces op N produced in role R", optionally narrowed by
 * a rung-2 induced `filter` and/or `rank` (both evaluated against the CURRENT
 * shape's exact facts, never the prefix shape's — see `resolveBucketSelector`). */
export interface BucketSelector {
  version: 1;
  source: { kind: "bucket"; op: number; role: OpRole; filter?: FacePredicate; rank?: SelectorRank };
}

/** Union grows in later rungs; rungs 1–2 share the single bucket source. */
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
  // Rung-2 induced layer — both fields optional; a malformed layer fails the
  // WHOLE query (a half-understood predicate is worse than a rejection, the
  // same whole-op rule `validateEditOpCore` applies to a bad core field
  // rather than `sanitizeExprs`' drop-the-entry rule).
  let filter: FacePredicate | undefined;
  if (source.filter !== undefined) {
    const parsed = validateFacePredicate(source.filter);
    if (!parsed) return null;
    filter = parsed;
  }
  let rank: SelectorRank | undefined;
  if (source.rank !== undefined) {
    const parsed = validateSelectorRank(source.rank);
    if (!parsed) return null;
    rank = parsed;
  }
  return {
    version: 1,
    source: {
      kind: "bucket",
      op,
      role: source.role,
      ...(filter ? { filter } : {}),
      ...(rank ? { rank } : {}),
    },
  };
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
