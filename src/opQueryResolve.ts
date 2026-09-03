/**
 * Host-side resolution of per-op stored operand queries (roadmap "Selector
 * synthesis", op-operand persistence — Phase B). `editOps.ts` validates the
 * `targetQueries` annotation; this module turns it into concrete ids at
 * replay time.
 *
 * **Resolution is fused into a sequential fold, not a map.** Op N's operands
 * are consumed against `shape(ops[0..N-1])`, and earlier ops may carry
 * queries too — so each op's queries resolve against the fold shape AFTER
 * every earlier op (with its own resolution) has applied. A parallel
 * `ops.map(resolve)` would resolve later queries against never-applied
 * geometry.
 *
 * Bucket-query mechanics per field: the reference set is the recorded bucket
 * at the producing op's own step, re-derived by replaying the base shape
 * through the resolved `ops[0..K]` (never trusting ids cached in the op) and
 * matched to the CURRENT fold shape via the shared `rebindEntities`
 * nearest-neighbour match at the usual `1e-3·bboxDiagonal` tolerance — the
 * same machinery `rebindPartsAcrossOps` uses. Guards, each freezing the
 * field to its cached ids with a warning rather than guessing: producing
 * index out of range or not BEFORE the consuming op (a forward reference
 * names geometry that does not exist yet), kind-tag mismatch (the stored
 * `op` now addresses a different op kind — the Phase-A splice guard),
 * pattern-instance producers, no bucket recorded, unresolved references, an
 * induced layer selecting nothing, and scalar slots (`SCALAR_OPERAND_FIELDS`)
 * whose query resolves to something other than exactly one id.
 *
 * Cost is gated: callers check `hasTargetQueries(ops)` first, so documents
 * without queries pay nothing. A document WITH queries pays this pass (one
 * fold plus one prefix replay per bucket query) AND the caller's real replay
 * — accepted for v1, stated so nobody mistakes it for a hot-path regression.
 *
 * Freeze semantics are replay-only: the sidecar keeps its queries and cached
 * ids untouched (the host never rewrites op caches during load — unlike
 * `Part.selector`, resolution has no persistence pass; the query is the
 * source of truth and re-resolves on every load). A frozen field loses its
 * query IN THE REPLAY COPY ONLY (re-running a just-failed resolution on
 * every later consumer of this list would fail identically forever) and the
 * op replays on its cached ids; the returned warnings carry every freeze
 * reason so the freeze is never silent.
 *
 * Imports point one way: `occtOperations`/`editOps`/`selectorQuery`/
 * `entityRebind` — never `occtService` (which calls THIS module) and never
 * `entityFacts` (which imports `occtService`), keeping the graph acyclic.
 * The shallow face-fact read below mirrors `entityFacts.ts`'s private
 * `faceFilterableFacts` for exactly that reason; the predicate/rank
 * application mirrors `selectorPredicate.ts` over the shallow shape — both
 * kept in lockstep by the smoke suite, since neither can be imported here.
 */

import {
  applyEditsBRep,
  applyOneOp,
  bboxDiagonal,
  collectFaces,
  faceSurfaceInfo,
} from "./occtOperations";
import { surfacePropertiesAdaptive } from "./brepGProp";
import { bucketReferenceIds, isBindableSelector, type SelectorQuery } from "./selectorQuery";
import { rebindEntities, type EntityRebindMatch, type EntitySignature } from "./entityRebind";
import { SCALAR_OPERAND_FIELDS, type EditOp } from "./editOps";
import type { OpBucket } from "./opBuckets";

export interface OpQueryResolution {
  /** Ops with every resolvable query replaced by concrete ids and every
   * frozen query stripped; the input array is returned UNCHANGED (same
   * reference) when there was nothing to change, so callers can cheaply
   * detect "nothing to do". */
  ops: EditOp[];
  /** One warning per frozen field, naming op/field/reason — surfaced by the
   * callers (load_model warnings, provider status line) so a freeze is never
   * silent. */
  warnings: string[];
}

/**
 * Face-signature subset for the matcher — `collectFaces` order IS the
 * `face-N` id (the established enumeration contract), so index = id.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function faceSignatures(oc: any, shape: any, cleanup: Array<{ delete(): void }>): EntitySignature[] {
  const out: EntitySignature[] = [];
  const faces = collectFaces(oc, shape, cleanup);
  faces.forEach((face, i) => {
    const centreProps = new oc.GProp_GProps_1();
    cleanup.push(centreProps);
    // `bboxCenter`'s exact bounding-box-centre convention (the shared
    // `EntitySignature.centre` semantic), via the same helper every other
    // signature producer in this codebase uses.
    const centre = bboxCentreOf(oc, face, cleanup);
    void centreProps;
    const areaProps = new oc.GProp_GProps_1();
    cleanup.push(areaProps);
    surfacePropertiesAdaptive(oc, face, areaProps);
    out.push({ id: `face-${i}`, kind: "face", centre, measure: areaProps.Mass() });
  });
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bboxCentreOf(oc: any, handle: any, cleanup: Array<{ delete(): void }>): [number, number, number] {
  const box = new oc.Bnd_Box_1();
  cleanup.push(box);
  oc.BRepBndLib.Add(handle, box, true);
  const mn = box.CornerMin();
  const mx = box.CornerMax();
  cleanup.push(mn, mx);
  return [(mn.X() + mx.X()) / 2, (mn.Y() + mx.Y()) / 2, (mn.Z() + mx.Z()) / 2];
}

/** Shallow mirror of `entityFacts.ts`'s private `faceFilterableFacts` — see
 * the module doc for why it cannot be imported. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function faceFilterableFactsShallow(
  oc: any,
  shape: any,
  ids: string[],
  cleanup: Array<{ delete(): void }>
): ShallowFact[] {
  const faces = collectFaces(oc, shape, cleanup);
  const out: ShallowFact[] = [];
  for (const id of ids) {
    const m = /^face-(\d+)$/.exec(id);
    if (!m) continue;
    const face = faces[parseInt(m[1], 10)];
    if (!face) continue;
    const info = faceSurfaceInfo(oc, face, cleanup);
    const props = new oc.GProp_GProps_1();
    cleanup.push(props);
    surfacePropertiesAdaptive(oc, face, props);
    out.push({
      id,
      area: props.Mass(),
      surfaceType: info.type,
      normal: info.params?.kind === "plane" ? (info.params.normal as [number, number, number]) : null,
    });
  }
  return out;
}

type ShallowFact = { id: string; area: number; surfaceType: string; normal: [number, number, number] | null };

/**
 * Resolves `ops`' operand queries against live geometry, sequentially (see
 * the module doc). `baseShape` must be the ORIGINAL file's base shape — on a
 * cached append-replay the fold base is the previous shape, which is why the
 * caller (`occtService`) skips append-reuse entirely for query documents.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveOpOperandQueries(oc: any, baseShape: any, ops: EditOp[], cleanup: Array<{ delete(): void }>): OpQueryResolution {
  const warnings: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current = baseShape;
  const resolved: EditOp[] = [];
  let changed = false;

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const queries = op.targetQueries;
    if (!queries) {
      current = applyOneOp(oc, current, op, cleanup, () => undefined);
      resolved.push(op);
      continue;
    }
    const kinds = op.targetQueryKinds ?? {};
    const clean: Record<string, unknown> = { ...(op as unknown as Record<string, unknown>) };
    let anyFrozen = false;

    for (const [field, query] of Object.entries(queries)) {
      const freeze = (reason: string): void => {
        anyFrozen = true;
        warnings.push(`op ${i} (${op.op}) field "${field}": query frozen to cached ids — ${reason}`);
      };
      if (query.source.kind === "scene") {
        // Scene: filter/rank over the CURRENT fold shape's faces.
        const allIds = collectFaces(oc, current, cleanup).map((_: unknown, n: number) => `face-${n}`);
        const facts = faceFilterableFactsShallow(oc, current, allIds, cleanup);
        let ids = selectShallow(facts, query);
        if (!scalarOk(field, ids)) { freeze(`resolved to ${ids.length} ids, a scalar slot needs exactly 1`); continue; }
        clean[field] = scalarOrArray(field, ids);
        changed = true;
        continue;
      }
      // Bucket query guards, in fail-fast order.
      const k = query.source.op;
      if (k >= i) { freeze(`producing op ${k} is not before this op — a forward reference names geometry that does not exist yet`); continue; }
      if (kinds[field] !== undefined && resolved[k].op !== kinds[field]) {
        freeze(`stored tag "${kinds[field]}" does not match the op now at index ${k} ("${resolved[k].op}") — the list changed under it`);
        continue;
      }
      if (!isBindableSelector(resolved, query)) {
        freeze("producing op is a pattern instance (ambiguous across instances)");
        continue;
      }
      // Reference set: the bucket recorded at step k of the RESOLVED prefix.
      const prefixCleanup: Array<{ delete(): void }> = [];
      try {
        const prefixBuckets: OpBucket[] = [];
        const prefixShape = applyEditsBRep(oc, baseShape, resolved.slice(0, k + 1), prefixCleanup, undefined, undefined, prefixBuckets);
        const refIds = bucketReferenceIds(prefixBuckets, query);
        if (refIds.length === 0) { freeze(`producing op ${k} recorded no "${query.source.role}" faces`); continue; }
        const refSet = new Set(refIds);
        const refSigs = faceSignatures(oc, prefixShape, prefixCleanup).filter((s) => refSet.has(s.id));
        const curSigs = faceSignatures(oc, current, cleanup);
        const toleranceAbs = Math.max(1e-3 * bboxDiagonal(oc, current, cleanup), 1e-6);
        const matches: EntityRebindMatch[] = rebindEntities(refSigs, curSigs, toleranceAbs);
        const matchedOld = new Set(matches.map((m) => m.oldId));
        if (refIds.some((id) => !matchedOld.has(id))) { freeze("a reference face has no confident match in the current shape"); continue; }
        let ids = matches.map((m) => m.newId);
        const { filter, rank } = query.source;
        if (filter !== undefined || rank !== undefined) {
          const facts = faceFilterableFactsShallow(oc, current, ids, cleanup);
          const byId = new Set(facts.map((f) => f.id));
          ids = ids.filter((id) => byId.has(id));
          ids = selectShallow(facts, query);
          if (ids.length === 0) { freeze("the induced layer currently selects nothing"); continue; }
        }
        if (!scalarOk(field, ids)) { freeze(`resolved to ${ids.length} ids, a scalar slot needs exactly 1`); continue; }
        clean[field] = scalarOrArray(field, ids);
        changed = true;
      } finally {
        for (let d = prefixCleanup.length - 1; d >= 0; d--) {
          try { prefixCleanup[d].delete(); } catch { /* ignore */ }
        }
      }
    }

    if (anyFrozen || changed) {
      // Every query is stripped from the replay copy — resolved fields now
      // carry concrete ids, frozen fields fall back to their caches; either
      // way the query annotation has no further role IN THIS LIST. The
      // SIDECAR keeps everything.
      delete clean.targetQueries;
      delete clean.targetQueryKinds;
    }
    const resolvedOp = clean as unknown as EditOp;
    resolved.push(resolvedOp);
    current = applyOneOp(oc, current, resolvedOp, cleanup, () => undefined);
  }

  return { ops: changed || warnings.length > 0 ? resolved : ops, warnings };
}

// --- small local helpers (kept beside the resolver; pure) -------------------

function scalarOk(field: string, ids: string[]): boolean {
  return SCALAR_OPERAND_FIELDS.has(field) ? ids.length === 1 : ids.length > 0;
}

function scalarOrArray(field: string, ids: string[]): unknown {
  return SCALAR_OPERAND_FIELDS.has(field) ? ids[0] : ids;
}

/** Structural mirror of `selectorPredicate.ts`'s filter+rank application
 * over the shallow fact shape (see the module doc for why it is mirrored
 * rather than imported). Only validated query shapes arrive here. */
function selectShallow(facts: ShallowFact[], query: SelectorQuery): string[] {
  if (query.source.kind !== "bucket" && query.source.kind !== "scene") return [];
  const { filter, rank } = query.source;
  let survivors = facts;
  if (filter !== undefined) {
    const leaves = Array.isArray(filter) ? filter : [filter];
    survivors = survivors.filter((f) =>
      (leaves as Array<Record<string, unknown>>).every((leaf) => {
        switch (leaf.kind) {
          case "planar": return f.surfaceType === "plane";
          case "surfaceType": return f.surfaceType === leaf.type;
          case "normal": {
            if (!f.normal) return false;
            const dir = leaf.dir as [number, number, number];
            const dot = f.normal[0] * dir[0] + f.normal[1] * dir[1] + f.normal[2] * dir[2];
            const nLen = Math.hypot(f.normal[0], f.normal[1], f.normal[2]);
            const dLen = Math.hypot(dir[0], dir[1], dir[2]);
            if (nLen <= 0 || dLen <= 0) return false;
            const tolDeg = (leaf.toleranceDeg as number | undefined) ?? 5;
            return dot / (nLen * dLen) >= Math.cos((tolDeg * Math.PI) / 180) - 1e-9;
          }
          case "areaGte": return f.area >= (leaf.value as number) - 1e-9;
          case "areaLte": return f.area <= (leaf.value as number) + 1e-9;
          default: return false;
        }
      })
    );
  }
  if (rank !== undefined) {
    const suffixOf = (id: string): number => {
      const m = /^face-(\d+)$/.exec(id);
      return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
    };
    const sorted = [...survivors].sort((a, b) => {
      if (a.area !== b.area) return rank.order === "max" ? b.area - a.area : a.area - b.area;
      return suffixOf(a.id) - suffixOf(b.id);
    });
    survivors = sorted.slice(0, rank.n);
  }
  return survivors.map((f) => f.id);
}
