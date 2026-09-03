/**
 * Induced face predicates for re-executable selector queries — roadmap item 1
 * ("Selector synthesis"), ladder rung 2: "bucket plus an induced predicate".
 *
 * Rung 1 (`selectorQuery.ts`) names "the faces op N produced in role R" as a
 * set. Rung 2 narrows that set without baking in positional ids or numeric
 * coordinates: "op 3's `endCap` face with the largest area", "the planar
 * faces of op 0's `body`". The induced layer carries no numeric constant of
 * its own (a rank, a threshold direction, a surface kind) — the
 * constant-free-first preference the roadmap names as the single most
 * transferable idea stays intact; only `areaGte`/`areaLte` carry a literal,
 * and those exist for parity with the closed query-filter registry, not as
 * the recommended form.
 *
 * Pure and vscode/OCCT/THREE-free (same split as `selectorQuery.ts`): leaves
 * evaluate over a minimal `FilterableFace` interface — NOT `EntityFacts`
 * directly, so this unit-tests headless against hand-built fixtures and stays
 * decoupled from kernel types. The vocabulary mirrors the closed
 * `src/webview/selectFilters.ts` registry (`FACE_FILTERS`) leaf-for-leaf
 * where a host-side exact field exists; it deliberately does NOT cover
 * edge-direction/smoothness (no `EntityFacts` field — those need live-WASM
 * probes first, a later rung). `selectFilters.ts` is THREE-dependent and
 * cannot be imported here; the tolerance constant is shared by VALUE with a
 * pointer back, and the match conventions (`dot >= cos(tol) − 1e-9`,
 * `±1e-9` area epsilon) are copied verbatim so the two can never silently
 * disagree on what "planar" or "area ≥ X" means.
 */

import type { SurfaceType } from "./entityFacts";
import type { Vec3 } from "./editOps";

/** Shared by value with `selectFilters.ts`'s `DEFAULT_DIRECTION_TOLERANCE_DEG`
 * (that module is THREE-dependent and cannot be imported here). */
export const SELECTOR_DIRECTION_TOLERANCE_DEG = 5;

/** Rank cap, mirroring `MAX_SELECTOR_OP_INDEX`'s no-silent-unbounded-input rule. */
export const MAX_RANK_N = 1000;

export type FacePredicate =
  | { kind: "planar" }
  | { kind: "surfaceType"; type: SurfaceType }
  | { kind: "normal"; dir: Vec3; toleranceDeg?: number }
  | { kind: "areaGte"; value: number }
  | { kind: "areaLte"; value: number };

export type SelectorRank = { by: "area"; order: "max" | "min"; n: number };

/** Minimal face facts a predicate leaf reads — satisfied by a projection of
 * `EntityFacts` (see `entityFacts.ts`'s `resolveBucketSelector`), never the
 * whole kernel type, so this stays unit-testable with hand-built fixtures. */
export interface FilterableFace {
  id: string;
  area: number | null;
  surfaceType: SurfaceType | null;
  normal: Vec3 | null;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function norm(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function isFiniteVec3(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((c) => typeof c === "number" && Number.isFinite(c))
  );
}

/** Structural gate for one predicate leaf — mirrors `validateSelectorQuery`'s
 * "drop, never crash" rule: malformed input returns `null`, never throws. */
export function validateFacePredicate(raw: unknown): FacePredicate | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case "planar":
      return { kind: "planar" };
    case "surfaceType":
      if (typeof r.type !== "string") return null;
      if (!["plane", "cylinder", "cone", "sphere", "torus", "other"].includes(r.type)) return null;
      return { kind: "surfaceType", type: r.type as SurfaceType };
    case "normal": {
      if (!isFiniteVec3(r.dir)) return null;
      if (norm(r.dir) <= 0) return null;
      if (r.toleranceDeg !== undefined) {
        if (typeof r.toleranceDeg !== "number" || !Number.isFinite(r.toleranceDeg)) return null;
        if (r.toleranceDeg <= 0 || r.toleranceDeg > 90) return null;
      }
      return r.toleranceDeg === undefined
        ? { kind: "normal", dir: [...r.dir] as Vec3 }
        : { kind: "normal", dir: [...r.dir] as Vec3, toleranceDeg: r.toleranceDeg };
    }
    case "areaGte":
    case "areaLte":
      if (typeof r.value !== "number" || !Number.isFinite(r.value)) return null;
      return { kind: r.kind, value: r.value };
    default:
      return null;
  }
}

/** Structural gate for a rank — `n` is a positive int capped at `MAX_RANK_N`;
 * `n <= 0`/non-integer/non-finite returns `null` (an empty selection is a
 * runtime honest-empty, never a validation shape — validation only rejects
 * what cannot be meant). */
export function validateSelectorRank(raw: unknown): SelectorRank | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.by !== "area") return null;
  if (r.order !== "max" && r.order !== "min") return null;
  if (typeof r.n !== "number" || !Number.isInteger(r.n) || r.n <= 0 || r.n > MAX_RANK_N) return null;
  return { by: "area", order: r.order, n: r.n };
}

/**
 * Single-predicate evaluator over one face's facts. A face missing the
 * field a leaf needs (`area: null`, `normal: null` on a curved face) is
 * NO-MATCH — the honest rule: the webview's tessellated mean-normal would
 * match a curved face here, but the host's exact `normal` is null for one,
 * so matching would be a fabrication. Documented beside the field, not hidden.
 */
export function matchesFacePredicate(face: FilterableFace, predicate: FacePredicate): boolean {
  switch (predicate.kind) {
    case "planar":
      return face.surfaceType === "plane";
    case "surfaceType":
      return face.surfaceType === predicate.type;
    case "normal": {
      if (!face.normal) return false;
      const nLen = norm(face.normal);
      const dLen = norm(predicate.dir);
      if (nLen <= 0 || dLen <= 0) return false;
      const cosTol = Math.cos(((predicate.toleranceDeg ?? SELECTOR_DIRECTION_TOLERANCE_DEG) * Math.PI) / 180);
      return dot(face.normal, predicate.dir) / (nLen * dLen) >= cosTol - 1e-9;
    }
    case "areaGte":
      return face.area !== null && face.area >= predicate.value - 1e-9;
    case "areaLte":
      return face.area !== null && face.area <= predicate.value + 1e-9;
  }
}

/** Applies one predicate to a face list, preserving input order. */
export function filterFaces(faces: FilterableFace[], predicate: FacePredicate): FilterableFace[] {
  return faces.filter((f) => matchesFacePredicate(f, predicate));
}

/**
 * Top-N selection by area — the host-side `largestN`/`smallestN`. Faces with
 * `area: null` sort LAST in either order (unknown size is never "largest");
 * ties break on the numeric `face-N` suffix so the result is deterministic
 * regardless of input order (the webview registry specifies no tie-break;
 * rung 2 states ours). `n >= len` returns all; callers guarantee `n >= 1`
 * via `validateSelectorRank`.
 */
export function rankFaces(faces: FilterableFace[], rank: SelectorRank): FilterableFace[] {
  const areaOf = (f: FilterableFace): number =>
    f.area === null ? (rank.order === "max" ? -Infinity : Infinity) : f.area;
  const suffixOf = (id: string): number => {
    const m = /^face-(\d+)$/.exec(id);
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  };
  const sorted = [...faces].sort((a, b) => {
    const d = rank.order === "max" ? areaOf(b) - areaOf(a) : areaOf(a) - areaOf(b);
    if (d !== 0 && Number.isFinite(d)) return d;
    // -Infinity/Infinity deltas (null areas) and exact ties: deterministic id order.
    if (areaOf(a) !== areaOf(b)) return areaOf(a) < areaOf(b) ? (rank.order === "max" ? 1 : -1) : rank.order === "max" ? -1 : 1;
    return suffixOf(a.id) - suffixOf(b.id);
  });
  return sorted.slice(0, rank.n);
}
