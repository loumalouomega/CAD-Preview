/**
 * Pure solid-matching heuristic for "Compare Models" — vscode/OCCT-free
 * (mirrors `src/massProperties.ts`'s host-module convention, but this half
 * has no WASM dependency at all). Matches solids between two B-rep models by
 * bounding-box-centroid proximity + volume, the same `bboxCenter`/
 * `bboxDiagonal`-based heuristic `explodeSolids`/`gmshPartsMap.ts` already use
 * elsewhere in this codebase — see `src/modelDiffHost.ts` for the OCCT-side
 * signature extraction that feeds this.
 *
 * Deliberately never collapses a match into a binary "moved"/"unchanged"
 * verdict: every match reports its raw `centreDistance`/`volumeDeltaPct`, so
 * the caller (the panel, the MCP tool) can show the heuristic's confidence
 * directly instead of hiding it behind a guess — this is how this feature
 * avoids the "misleading false matches" trap `doc/roadmap.md` calls out.
 */

export type Vec3 = [number, number, number];

export interface SolidSignature {
  id: string;
  centre: Vec3;
  diagonal: number;
  volume: number;
}

export interface SolidMatch {
  a: SolidSignature;
  b: SolidSignature;
  centreDistance: number;
  volumeDeltaPct: number;
}

export interface ModelDiff {
  added: SolidSignature[];
  removed: SolidSignature[];
  matched: SolidMatch[];
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function volumeDeltaPct(a: number, b: number): number {
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return (Math.abs(a - b) / denom) * 100;
}

/**
 * Greedy nearest-neighbor bipartite matching by centroid distance (primary)
 * with volume as a tie-breaker, capped by `toleranceAbs` (an absolute
 * distance, in the model's own length unit — the caller derives this from
 * the whole model's bounding-box diagonal, e.g. `1e-3 * diagonal`, matching
 * `gmshPartsMap.ts`'s existing tolerance-fraction convention). A solid in
 * `a`/`b` with no candidate within tolerance falls out as removed/added.
 */
export function diffSolids(a: SolidSignature[], b: SolidSignature[], toleranceAbs: number): ModelDiff {
  const candidates: Array<{ i: number; j: number; centreDistance: number; volumeDeltaPct: number }> = [];
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const centreDistance = distance(a[i].centre, b[j].centre);
      if (centreDistance > toleranceAbs) continue;
      candidates.push({ i, j, centreDistance, volumeDeltaPct: volumeDeltaPct(a[i].volume, b[j].volume) });
    }
  }
  candidates.sort((x, y) => x.centreDistance - y.centreDistance || x.volumeDeltaPct - y.volumeDeltaPct);

  const matchedA = new Set<number>();
  const matchedB = new Set<number>();
  const matched: SolidMatch[] = [];
  for (const c of candidates) {
    if (matchedA.has(c.i) || matchedB.has(c.j)) continue;
    matchedA.add(c.i);
    matchedB.add(c.j);
    matched.push({ a: a[c.i], b: b[c.j], centreDistance: c.centreDistance, volumeDeltaPct: c.volumeDeltaPct });
  }

  const removed = a.filter((_, i) => !matchedA.has(i));
  const added = b.filter((_, j) => !matchedB.has(j));
  return { added, removed, matched };
}
