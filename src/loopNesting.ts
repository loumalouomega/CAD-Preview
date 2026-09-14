/**
 * Pure 2D loop nesting — roadmap "3D text via outline import". Groups closed
 * loops into regions (one outer boundary plus its depth-1 holes) by even-odd
 * containment depth, so the letter "O" becomes one region with one counter and
 * an island inside a counter starts a region of its own.
 *
 * Shared by both halves of the feature so they can never disagree about what
 * a hole is: `mcpTools.ts`'s `import_svg` groups imported SVG loops with it,
 * and `occtOperations.ts`'s multi-loop `addSurfaceFromLines` uses it to refuse
 * anything that isn't exactly one outer loop plus holes.
 *
 * No OCCT, no THREE, no DOM — unit-tested headless in `loopNesting.test.ts`.
 */

export type Loop2d = readonly (readonly [number, number])[];

export interface LoopRegion {
  /** Index of the region's outer boundary in the input list. */
  outer: number;
  /** Indices of the loops that are holes in that outer (depth exactly 1). */
  holes: number[];
}

/** Shoelace signed area; positive for a counter-clockwise loop. */
export function signedArea2d(loop: Loop2d): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i];
    const [x2, y2] = loop[(i + 1) % loop.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Even-odd ray-cast point-in-polygon. Boundary points are unspecified. */
export function pointInPolygon(pt: readonly [number, number], loop: Loop2d): boolean {
  const [px, py] = pt;
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i];
    const [xj, yj] = loop[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Depth of each loop: the number of other loops that contain it. A loop is
 * tested by its first vertex, which suffices for non-crossing loops (the
 * well-formed case — crossing outlines have no meaningful nesting anyway).
 * Degenerate loops (fewer than 3 points or zero area) get depth -1 and are
 * never part of a region.
 */
export function loopDepths(loops: readonly Loop2d[]): number[] {
  const areas = loops.map((l) => Math.abs(signedArea2d(l)));
  return loops.map((loop, i) => {
    if (loop.length < 3 || !(areas[i] > 0)) return -1;
    let depth = 0;
    for (let j = 0; j < loops.length; j++) {
      if (j === i || loops[j].length < 3 || !(areas[j] > areas[i])) continue;
      if (pointInPolygon(loop[0], loops[j])) depth++;
    }
    return depth;
  });
}

/**
 * Groups loops into regions: every even-depth loop is an outer, and every
 * odd-depth loop is a hole of its NEAREST container (the smallest-area
 * containing loop, which is necessarily one depth shallower). Regions come
 * back in input order of their outer loop. Degenerate loops are dropped.
 */
export function nestLoops(loops: readonly Loop2d[]): LoopRegion[] {
  const depths = loopDepths(loops);
  const areas = loops.map((l) => Math.abs(signedArea2d(l)));
  const regions: LoopRegion[] = [];
  const regionByOuter = new Map<number, LoopRegion>();
  for (let i = 0; i < loops.length; i++) {
    if (depths[i] >= 0 && depths[i] % 2 === 0) {
      const r: LoopRegion = { outer: i, holes: [] };
      regions.push(r);
      regionByOuter.set(i, r);
    }
  }
  for (let i = 0; i < loops.length; i++) {
    if (depths[i] < 0 || depths[i] % 2 === 0) continue;
    let best = -1;
    for (let j = 0; j < loops.length; j++) {
      if (j === i || depths[j] !== depths[i] - 1 || !(areas[j] > areas[i])) continue;
      if (!pointInPolygon(loops[i][0], loops[j])) continue;
      if (best < 0 || areas[j] < areas[best]) best = j;
    }
    if (best >= 0) regionByOuter.get(best)?.holes.push(i);
  }
  return regions;
}
