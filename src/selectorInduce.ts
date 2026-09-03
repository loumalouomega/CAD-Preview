/**
 * Constant-free-first induction for re-executable selector queries — roadmap
 * item 1 ("Selector synthesis"), the last functional piece: turn a picked
 * face set into a `SelectorQuery` (bucket + induced layer) that re-executes
 * to exactly that set.
 *
 * Pure and vscode/OCCT/THREE-free (same split as `selectorPredicate.ts`):
 * the inducer searches over `FilterableFace[]` facts headlessly — no WASM —
 * and every accepted candidate is *executed* via the same
 * `applyFaceFilter`/`rankFaces` the resolvers use, kept only on exact-set
 * equality with the picked set. The live-kernel half of the roadmap's oracle
 * rule (re-execute through `resolveBucketSelector`, accept only on exact set
 * with `centreDistance ~ 0`) belongs to the `synthesize_selector` caller, not
 * this module — same pure/impure split as `entityRebind.ts`/`entityFacts.ts`.
 *
 * Ordering is the feature: candidates are tried constant-free-first —
 * qualitative/datum leaves (`planar`, `surfaceType`, axis-snapped `normal`,
 * `rank`) before the exact picked normal, area literals dead last — because a
 * qualitative predicate survives the dimension edits that silently break a
 * literal. `selectionGroups.ts`'s fixed menu is the cautionary tale: it
 * builds `areaGte(clickedArea)`, the exact over-fitted form this ordering
 * demotes (pinned by test). Search is greedy set-cover with restarts for the
 * multi-leaf case (openers = top-3 single leaves by gain, extend by best
 * gain); single-leaf/rank forms are tried first in preference order, so the
 * common singleton case never pays for the loop.
 */

import {
  SELECTOR_DIRECTION_TOLERANCE_DEG,
  applyFaceFilter,
  rankFaces,
  type FacePredicate,
  type FilterableFace,
  type SelectorRank,
} from "./selectorPredicate";
import type { SelectorQuery } from "./selectorQuery";
import type { OpRole } from "./opBuckets";
import type { Vec3 } from "./editOps";

/** Axis-snapped direction candidates — the datum-relative form of "same
 * facing" (`selectionGroups.ts`'s `facesWithNormalLike` is the webview-side
 * precedent). Tried before the exact picked normal: an axis survives edits
 * that rotate/shear a face off its authored direction, a literal cannot. */
const AXES: Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

const SURFACE_TYPE_ORDER = ["plane", "cylinder", "cone", "sphere", "torus", "other"] as const;

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** Executes a candidate induced layer headlessly — the pure half of the
 * oracle rule. Rank applies after filter (resolve-then-filter, the same
 * load-bearing order `resolveBucketSelector` uses). */
export function executeInducedLayer(
  universe: FilterableFace[],
  filter: FacePredicate | FacePredicate[] | undefined,
  rank: SelectorRank | undefined
): string[] {
  let survivors = filter !== undefined ? applyFaceFilter(universe, filter) : [...universe];
  if (rank !== undefined) survivors = rankFaces(survivors, rank);
  return survivors.map((f) => f.id);
}

function exactMatch(universe: FilterableFace[], targetIds: Set<string>, filter?: FacePredicate | FacePredicate[], rank?: SelectorRank): boolean {
  return setsEqual(new Set(executeInducedLayer(universe, filter, rank)), targetIds);
}

/** Gain of adding `leaf` to the current cover: newly covered targets minus
 * newly covered non-targets. The greedy criterion; ties break
 * constant-free-first via enumeration order (callers pass leaves ordered). */
function gain(universe: FilterableFace[], targetIds: Set<string>, covered: Set<string>, leaf: FacePredicate): number {
  let g = 0;
  for (const f of universe) {
    if (covered.has(f.id)) continue;
    if (applyFaceFilter([f], leaf).length !== 1) continue;
    g += targetIds.has(f.id) ? 1 : -1;
  }
  return g;
}

export interface InduceInput {
  op: number;
  role: OpRole;
  /** Resolved bucket ids' current-shape facts (the search universe). */
  universe: FilterableFace[];
  /** Picked subset to name — must be non-empty and within `universe`. */
  targets: string[];
}

/**
 * Synthesizes a bucket-anchored `SelectorQuery` naming exactly `targets`,
 * or `null` when no enumerated candidate executes to exactly that set (never
 * a guess — the caller surfaces the honest-null, same as an unresolvable
 * bucket). Preference order, first exact execution wins:
 * bare bucket (targets span the universe) → single constant-free leaf →
 * rank alone → exact picked normal → constant-free pairs (greedy + 3
 * restarts) → leaf+rank → area literals last.
 */
export function induceSelector(input: InduceInput): SelectorQuery | null {
  const { op, role, universe, targets } = input;
  const targetSet = new Set(targets);
  if (targetSet.size === 0 || universe.length === 0) return null;
  const universeIds = new Set(universe.map((f) => f.id));
  for (const id of targetSet) if (!universeIds.has(id)) return null;

  const base = { kind: "bucket" as const, op, role };
  // Bare bucket: the picked set IS the universe — nothing to induce.
  if (setsEqual(targetSet, universeIds)) {
    return { version: 1, source: { ...base } };
  }

  const byId = new Map(universe.map((f) => [f.id, f]));
  const firstTarget = byId.get(targets[0]);

  // Ordered candidate leaves, constant-free-first. Surface types present in
  // the universe (fixed type order, not universe order — deterministic).
  const presentTypes = SURFACE_TYPE_ORDER.filter((t) => universe.some((f) => f.surfaceType === t));
  const singleLeaves: FacePredicate[] = [
    { kind: "planar" },
    ...presentTypes.map((type) => ({ kind: "surfaceType" as const, type })),
  ];
  // Snapped axes the first target faces within tolerance — datum-relative,
  // before the exact literal below.
  if (firstTarget?.normal) {
    const nLen = Math.hypot(firstTarget.normal[0], firstTarget.normal[1], firstTarget.normal[2]);
    if (nLen > 0) {
      const cosTol = Math.cos((SELECTOR_DIRECTION_TOLERANCE_DEG * Math.PI) / 180);
      for (const axis of AXES) {
        if (dot(firstTarget.normal, axis) / nLen >= cosTol - 1e-9) {
          singleLeaves.push({ kind: "normal" as const, dir: [...axis] as Vec3 });
        }
      }
    }
  }
  // Ranks (count, not coordinate — ordered with the constant-free forms).
  const ranks: SelectorRank[] = [];
  for (const order of ["max", "min"] as const) {
    for (let n = 1; n <= universe.length; n++) ranks.push({ by: "area", order, n });
  }
  // Exact picked normal: valid fallback, ordered after every qualitative form.
  const exactNormal: FacePredicate | null =
    firstTarget?.normal && Math.hypot(firstTarget.normal[0], firstTarget.normal[1], firstTarget.normal[2]) > 0
      ? { kind: "normal", dir: [...firstTarget.normal] as Vec3 }
      : null;
  // Area literals at the first target's own value: parity-only, dead last.
  const literals: FacePredicate[] =
    firstTarget?.area !== null && firstTarget?.area !== undefined
      ? [
          { kind: "areaGte", value: firstTarget.area },
          { kind: "areaLte", value: firstTarget.area },
        ]
      : [];

  // Phase 1: single leaves, then ranks, then the exact normal — first exact win.
  for (const leaf of singleLeaves) {
    if (exactMatch(universe, targetSet, leaf)) {
      return { version: 1, source: { ...base, filter: leaf } };
    }
  }
  for (const rank of ranks) {
    if (exactMatch(universe, targetSet, undefined, rank)) {
      return { version: 1, source: { ...base, rank } };
    }
  }
  if (exactNormal && exactMatch(universe, targetSet, exactNormal)) {
    return { version: 1, source: { ...base, filter: exactNormal } };
  }

  // Phase 2: pairs with restarts. Intersecting only ever REMOVES faces, so
  // "extend by uncovered gain" would be the wrong criterion for the trimmer
  // (a trimmer that drops an already-covered non-target scores nothing under
  // it). Instead: openers = top-3 single leaves by gain, and for each, try
  // every pool leaf as the trimmer — first exact intersection wins, openers
  // in scored order and trimmers in constant-free-first pool order. Area
  // literals join the pool here (as trimmers, never openers-first — the
  // scored order keeps them last), since a literal trim is legitimate parity
  // even though a literal opener would be over-fitted.
  const pairPool: FacePredicate[] = [...singleLeaves, ...(exactNormal ? [exactNormal] : []), ...literals];
  const scored = pairPool
    .map((leaf, order) => ({ leaf, order, g: gain(universe, targetSet, new Set(), leaf) }))
    .sort((a, b) => b.g - a.g || a.order - b.order)
    .slice(0, 3);
  for (const { leaf: opener } of scored) {
    const openerSet = new Set(applyFaceFilter(universe, opener).map((f) => f.id));
    if (setsEqual(openerSet, targetSet)) {
      return { version: 1, source: { ...base, filter: opener } };
    }
    for (const trimmer of pairPool) {
      const pair: FacePredicate[] = [opener, trimmer];
      if (exactMatch(universe, targetSet, pair)) {
        return { version: 1, source: { ...base, filter: pair } };
      }
      // Leaf-pair + rank: the narrowest form before lone literals.
      for (const rank of ranks) {
        if (exactMatch(universe, targetSet, pair, rank)) {
          return { version: 1, source: { ...base, filter: pair, rank } };
        }
      }
    }
  }

  // Phase 3: single leaf + rank.
  for (const leaf of singleLeaves) {
    for (const rank of ranks) {
      if (exactMatch(universe, targetSet, leaf, rank)) {
        return { version: 1, source: { ...base, filter: leaf, rank } };
      }
    }
  }

  // Phase 4: area literals, alone and under a rank — parity only, dead last.
  for (const leaf of literals) {
    if (exactMatch(universe, targetSet, leaf)) {
      return { version: 1, source: { ...base, filter: leaf } };
    }
    for (const rank of ranks) {
      if (exactMatch(universe, targetSet, leaf, rank)) {
        return { version: 1, source: { ...base, filter: leaf, rank } };
      }
    }
  }

  return null;
}
