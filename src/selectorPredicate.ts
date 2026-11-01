/**
 * Induced face predicates for re-executable selector queries — the "Selector synthesis"
 * feature, ladder rung 2: "bucket plus an induced predicate".
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

/** A box limit per axis; `null` = unbounded on that side (a blank limit). */
export type BoxLimit = [number | null, number | null, number | null];

export type FacePredicate =
  | { kind: "planar" }
  | { kind: "surfaceType"; type: SurfaceType; radius?: number; tol?: number }
  /** Rule: the face's bounding box lies inside / overlaps the box (limits per axis, `null` = unbounded). */
  | { kind: "box"; min: BoxLimit; max: BoxLimit; mode: "inside" | "intersects"; tol?: number }
  /** Rule: a planar face on the plane through `point` with normal `normal` (either orientation). */
  | { kind: "plane"; point: Vec3; normal: Vec3; tol?: number }
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
  /** Axis-aligned bounding box (rule leaves `box`); absent = those leaves do not match. */
  bbox?: { min: Vec3; max: Vec3 } | null;
  /** A point on a planar face's plane (rule leaf `plane`). */
  planeOrigin?: Vec3 | null;
  /** Cylinder / sphere radius, torus major radius, cone reference radius (rule leaf `surfaceType` + `radius`). */
  radius?: number | null;
}

/**
 * Model-scale context for rule leaves whose tolerance is relative: a leaf's own
 * `tol` (model units) wins, otherwise `1e-3 × diagonal` — the same constant the
 * Part rebinder uses, so a rule and a rebind agree on "the same place". Without a
 * context the fallback is 1e-6 (exact-fixture tests).
 */
export interface FilterContext {
  diagonal: number;
}

/** Default relative tolerance of rule leaves (shared by value with `entityRebind`'s `1e-3 × bboxDiagonal`). */
export const RULE_TOLERANCE_FRACTION = 1e-3;

function tolOf(own: number | undefined, ctx: FilterContext | undefined): number {
  if (own !== undefined) return own;
  return ctx ? Math.max(RULE_TOLERANCE_FRACTION * ctx.diagonal, 1e-6) : 1e-6;
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

/** `undefined` = absent (fine), `null` = present but invalid, number = valid. */
function validTol(v: unknown): number | undefined | null {
  if (v === undefined) return undefined;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function validBoxLimit(v: unknown): BoxLimit | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  if (!v.every((c) => c === null || (typeof c === "number" && Number.isFinite(c)))) return null;
  return [...v] as BoxLimit;
}

/** Structural gate for one predicate leaf — mirrors `validateSelectorQuery`'s
 * "drop, never crash" rule: malformed input returns `null`, never throws. */
export function validateFacePredicate(raw: unknown): FacePredicate | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case "planar":
      return { kind: "planar" };
    case "surfaceType": {
      if (typeof r.type !== "string") return null;
      if (!["plane", "cylinder", "cone", "sphere", "torus", "other"].includes(r.type)) return null;
      if (r.radius === undefined && r.tol === undefined) return { kind: "surfaceType", type: r.type as SurfaceType };
      if (typeof r.radius !== "number" || !Number.isFinite(r.radius) || r.radius <= 0) return null;
      const tol = validTol(r.tol);
      if (tol === null) return null;
      return { kind: "surfaceType", type: r.type as SurfaceType, radius: r.radius, ...(tol !== undefined ? { tol } : {}) };
    }
    case "box": {
      const min = validBoxLimit(r.min);
      const max = validBoxLimit(r.max);
      if (!min || !max) return null;
      if (r.mode !== "inside" && r.mode !== "intersects") return null;
      for (let i = 0; i < 3; i++) {
        if (min[i] !== null && max[i] !== null && (min[i] as number) > (max[i] as number)) return null;
      }
      // A box with every limit open names the whole model, never a meant rule.
      if (min.every((v) => v === null) && max.every((v) => v === null)) return null;
      const tol = validTol(r.tol);
      if (tol === null) return null;
      return { kind: "box", min, max, mode: r.mode, ...(tol !== undefined ? { tol } : {}) };
    }
    case "plane": {
      if (!isFiniteVec3(r.point) || !isFiniteVec3(r.normal) || norm(r.normal) <= 0) return null;
      const tol = validTol(r.tol);
      if (tol === null) return null;
      return { kind: "plane", point: [...r.point] as Vec3, normal: [...r.normal] as Vec3, ...(tol !== undefined ? { tol } : {}) };
    }
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
export function matchesFacePredicate(face: FilterableFace, predicate: FacePredicate, ctx?: FilterContext): boolean {
  switch (predicate.kind) {
    case "planar":
      return face.surfaceType === "plane";
    case "surfaceType":
      if (face.surfaceType !== predicate.type) return false;
      if (predicate.radius === undefined) return true;
      return face.radius != null && Math.abs(face.radius - predicate.radius) <= tolOf(predicate.tol, ctx);
    case "box": {
      if (!face.bbox) return false;
      const t = tolOf(predicate.tol, ctx);
      for (let i = 0; i < 3; i++) {
        const lo = predicate.min[i];
        const hi = predicate.max[i];
        const fmin = face.bbox.min[i];
        const fmax = face.bbox.max[i];
        if (predicate.mode === "inside") {
          if (lo !== null && fmin < lo - t) return false;
          if (hi !== null && fmax > hi + t) return false;
        } else {
          if (lo !== null && fmax < lo - t) return false;
          if (hi !== null && fmin > hi + t) return false;
        }
      }
      return true;
    }
    case "plane": {
      if (face.surfaceType !== "plane" || !face.normal || !face.planeOrigin) return false;
      const nLen = norm(face.normal);
      const dLen = norm(predicate.normal);
      if (nLen <= 0 || dLen <= 0) return false;
      const cosTol = Math.cos((SELECTOR_DIRECTION_TOLERANCE_DEG * Math.PI) / 180);
      // Parallel in EITHER orientation: a face's outward normal flips with its orientation, the plane does not.
      if (Math.abs(dot(face.normal, predicate.normal)) / (nLen * dLen) < cosTol - 1e-9) return false;
      const d = [
        face.planeOrigin[0] - predicate.point[0],
        face.planeOrigin[1] - predicate.point[1],
        face.planeOrigin[2] - predicate.point[2],
      ] as Vec3;
      return Math.abs(dot(d, predicate.normal)) / dLen <= tolOf(predicate.tol, ctx);
    }
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
export function filterFaces(faces: FilterableFace[], predicate: FacePredicate, ctx?: FilterContext): FilterableFace[] {
  return faces.filter((f) => matchesFacePredicate(f, predicate, ctx));
}

/** Applies an induced filter layer — one leaf or an AND-conjunction — to a
 * face list. Shared by the bucket and scene resolvers so the two cannot
 * disagree on conjunction semantics. */
export function applyFaceFilter(
  faces: FilterableFace[],
  filter: FacePredicate | FacePredicate[],
  ctx?: FilterContext
): FilterableFace[] {
  const leaves = Array.isArray(filter) ? filter : [filter];
  return faces.filter((f) => leaves.every((leaf) => matchesFacePredicate(f, leaf, ctx)));
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
