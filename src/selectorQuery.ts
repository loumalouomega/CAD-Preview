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

/** Induced filter layer, shared by both query sources: one predicate or an
 * AND-conjunction of several (e.g. planar AND area ≥ X). A list reads as an
 * intersection — every leaf must match — so callers express conjunctions
 * without a second round trip. */
export type FaceFilter = FacePredicate | FacePredicate[];

/** Cap on conjunction length, mirroring `MAX_RANK_N`'s no-silent-unbounded-input rule. */
export const MAX_FILTER_LEAVES = 8;

/** Rung-1 query: "the faces op N produced in role R", optionally narrowed by
 * a rung-2 induced `filter` and/or `rank` (both evaluated against the CURRENT
 * shape's exact facts, never the prefix shape's — see `resolveBucketSelector`). */
export interface BucketSelector {
  version: 1;
  source: { kind: "bucket"; op: number; role: OpRole; filter?: FaceFilter; rank?: SelectorRank };
}

/** Rung-3 query: the same induced layer with NO bucket anchor — "all planar
 * faces", "the largest planar face in the model" — resolved against the whole
 * current shape in a single replay. At least one of `filter`/`rank` is
 * required: a bare scene query names the entire model, which is never a meant
 * selection (the same refuse-rather-than-return-everything judgment as the
 * rung-2 whole-bucket-fallback rule). */
export interface SceneSelector {
  version: 1;
  source: { kind: "scene"; filter?: FaceFilter; rank?: SelectorRank };
}

/** Union grows in later rungs (bucket indices); the scene source dissolves
 * rung 1's pattern-instance problem rather than solving it — it returns all
 * matching faces across every copy instead of naming an instance. */
export type SelectorQuery = BucketSelector | SceneSelector;

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
/** Validates the rung-2/3 induced layer shared by both sources. A malformed
 * layer fails the WHOLE query (a half-understood predicate is worse than a
 * rejection — the same whole-op rule `validateEditOpCore` applies to a bad
 * core field rather than `sanitizeExprs`' drop-the-entry rule). */
function validateInducedLayer(source: Record<string, unknown>): { filter?: FaceFilter; rank?: SelectorRank } | null {
  let filter: FaceFilter | undefined;
  if (source.filter !== undefined) {
    if (Array.isArray(source.filter)) {
      if (source.filter.length === 0 || source.filter.length > MAX_FILTER_LEAVES) return null;
      const leaves: FacePredicate[] = [];
      for (const leaf of source.filter) {
        const parsed = validateFacePredicate(leaf);
        if (!parsed) return null;
        leaves.push(parsed);
      }
      filter = leaves;
    } else {
      const parsed = validateFacePredicate(source.filter);
      if (!parsed) return null;
      filter = parsed;
    }
  }
  let rank: SelectorRank | undefined;
  if (source.rank !== undefined) {
    const parsed = validateSelectorRank(source.rank);
    if (!parsed) return null;
    rank = parsed;
  }
  return { ...(filter ? { filter } : {}), ...(rank ? { rank } : {}) };
}

export function validateSelectorQuery(raw: unknown): SelectorQuery | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== 1) return null;
  const source = raw.source;
  if (!isRecord(source)) return null;
  if (source.kind === "scene") {
    const layer = validateInducedLayer(source);
    if (!layer) return null;
    // A bare scene query names the entire model — never a meant selection.
    if (layer.filter === undefined && layer.rank === undefined) return null;
    return { version: 1, source: { kind: "scene", ...layer } };
  }
  if (source.kind !== "bucket") return null;
  const op = source.op;
  if (typeof op !== "number" || !Number.isInteger(op) || op < 0 || op > MAX_SELECTOR_OP_INDEX) return null;
  if (!isValidRole(source.role)) return null;
  const layer = validateInducedLayer(source);
  if (!layer) return null;
  return {
    version: 1,
    source: {
      kind: "bucket",
      op,
      role: source.role,
      ...layer,
    },
  };
}

/**
 * Bindability gate — the roadmap's correctness rule carried over verbatim: a
 * pick whose producing op was a pattern instance cannot be safely named,
 * because the name would be ambiguous across instances. A bucket query whose
 * producing op is `patternLinear`/`patternCircular` is refused (resolvable
 * via the scene-wide rung instead, which returns matches across all copies
 * rather than naming one), as is a query pointing past the end of the op
 * list. A scene query has no producing op, so the gate is vacuous for it —
 * always bindable. Getting the bucket case wrong would silently resolve to
 * the wrong instance — the misleading-false-result failure mode this file
 * gates other items behind a report for.
 */
export function isBindableSelector(ops: EditOp[], query: SelectorQuery): boolean {
  if (query.source.kind !== "bucket") return true;
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
  const source = query.source;
  if (source.kind !== "bucket") return [];
  const bucket = buckets.find((b) => b.op === source.op);
  if (!bucket) return [];
  return [...(bucket.roles[source.role] ?? [])];
}
