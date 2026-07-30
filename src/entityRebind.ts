/**
 * Pure entity-id rebinding heuristic — closes the "entity-id drift" gap
 * CLAUDE.md's Geometry editing section documents: a topology-changing op
 * (boolean, fillet, feature modeling, a wireframe surface/volume build, …)
 * re-tessellates into fresh `face-N`/`edge-N`/`solid-N`/`point-N` ids, so a
 * `Part` referencing the OLD ids would previously drop them on the next
 * reload (gracefully, by the tolerant sidecar parser — that fallback still
 * exists and still fires whenever this heuristic can't find a confident
 * match). vscode/OCCT-free — mirrors `src/modelDiff.ts`'s pure/impure split
 * (`src/entityFacts.ts`'s `collectAllEntitySignatures`/`rebindPartsAcrossOps`
 * is the OCCT-touching half that feeds this), generalizing that file's
 * greedy nearest-neighbor bipartite matching from solids-only to
 * solid/face/edge/point, matched independently **within each kind** (a face
 * never matches an edge, etc.).
 */

export type Vec3 = [number, number, number];
export type RebindKind = "solid" | "face" | "edge" | "point";

export interface EntitySignature {
  id: string; // e.g. "face-3"
  kind: RebindKind;
  centre: Vec3;
  /** Area (solid boundary/face), length (edge), or `0` (point — a location
   * has no size to compare, so points match on `centre` distance alone). */
  measure: number;
}

export interface EntityRebindMatch {
  oldId: string;
  newId: string;
  centreDistance: number;
  measureDeltaPct: number;
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function measureDeltaPct(a: number, b: number): number {
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return (Math.abs(a - b) / denom) * 100;
}

/**
 * Greedy nearest-neighbor bipartite matching by centroid distance (primary)
 * with `measure` as a tie-breaker, capped by `toleranceAbs` — the exact
 * `diffSolids` (`modelDiff.ts`) algorithm, generalized to run independently
 * per `kind` so a face can never match an edge. An entity in `oldSigs`/
 * `newSigs` with no candidate within tolerance is simply absent from the
 * result (the caller — `remapPartEntityIds` — treats an unmatched old id as
 * "drop it", the same tolerant-degradation the sidecar parser already does
 * for a genuinely-unresolvable id).
 */
export function rebindEntities(
  oldSigs: EntitySignature[],
  newSigs: EntitySignature[],
  toleranceAbs: number
): EntityRebindMatch[] {
  const matches: EntityRebindMatch[] = [];
  const kinds: RebindKind[] = ["solid", "face", "edge", "point"];
  for (const kind of kinds) {
    const a = oldSigs.filter((s) => s.kind === kind);
    const b = newSigs.filter((s) => s.kind === kind);
    const candidates: Array<{ i: number; j: number; centreDistance: number; measureDeltaPct: number }> = [];
    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < b.length; j++) {
        const centreDistance = distance(a[i].centre, b[j].centre);
        if (centreDistance > toleranceAbs) continue;
        candidates.push({ i, j, centreDistance, measureDeltaPct: measureDeltaPct(a[i].measure, b[j].measure) });
      }
    }
    candidates.sort((x, y) => x.centreDistance - y.centreDistance || x.measureDeltaPct - y.measureDeltaPct);

    const matchedA = new Set<number>();
    const matchedB = new Set<number>();
    for (const c of candidates) {
      if (matchedA.has(c.i) || matchedB.has(c.j)) continue;
      matchedA.add(c.i);
      matchedB.add(c.j);
      matches.push({ oldId: a[c.i].id, newId: b[c.j].id, centreDistance: c.centreDistance, measureDeltaPct: c.measureDeltaPct });
    }
  }
  return matches;
}

export interface RemapResult<T> {
  parts: T[];
  reboundCount: number;
  droppedCount: number;
}

// A minimal structural type — avoids importing `Part` from `./protocol` so
// this file stays framework-agnostic; any object with these four string-id
// arrays qualifies (the real `Part` type satisfies this trivially).
export interface EntityIdBag {
  volumes: string[];
  surfaces: string[];
  lines: string[];
  points: string[];
}

/**
 * Rewrites every part's `volumes`/`surfaces`/`lines`/`points` id through
 * `idMap` (built from `rebindEntities`' matches: `oldId -> newId`). An id
 * with no entry in `idMap` (no confident geometric match found) is dropped —
 * identical in effect to what the tolerant sidecar parser already does for
 * an unresolvable id on reload, just applied proactively instead of only on
 * the next reopen. An id that maps to itself (unchanged by the op — the
 * common case for anything not near the edit) isn't counted as "rebound",
 * only genuinely-changed ids are.
 */
export function remapPartEntityIds<T extends EntityIdBag>(parts: T[], idMap: Map<string, string>): RemapResult<T> {
  let reboundCount = 0;
  let droppedCount = 0;
  const remapField = (ids: string[]): string[] => {
    const out: string[] = [];
    for (const id of ids) {
      const mapped = idMap.get(id);
      if (mapped === undefined) {
        droppedCount++;
        continue;
      }
      if (mapped !== id) reboundCount++;
      out.push(mapped);
    }
    return out;
  };
  const parts2 = parts.map((p) => ({
    ...p,
    volumes: remapField(p.volumes),
    surfaces: remapField(p.surfaces),
    lines: remapField(p.lines),
    points: remapField(p.points),
  }));
  return { parts: parts2, reboundCount, droppedCount };
}
