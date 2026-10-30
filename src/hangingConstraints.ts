/**
 * Hanging nodes of an all-hexahedra octree and the multi-point constraints (MPCs)
 * that tie them to their parent corners. Pure: no vscode/WASM/DOM, so the
 * webview, the host and the MCP server share one implementation.
 *
 * A graded octree whose fine leaves meet a coarse neighbour (`transition:
 * "hanging"`) has nodes that sit in the middle of a coarse hexahedron's edge or
 * on its face without being one of its corners. meshio++ reports only how MANY
 * there are (`numHanging`), never their parents, so the parents are recovered
 * from the geometry: a node lying on a hexahedron edge is the `(1-t, t)` mix of
 * its two end nodes, a node on a quadrilateral face the bilinear mix of its four
 * corners. A linear field is therefore reproduced exactly at every hanging node
 * — {@link patchTestMaxError} measures that, and it is what the tests assert.
 *
 * Chains (a parent that is itself hanging) are resolved to END masters by
 * composing the weights; a cycle is refused by name rather than written. The
 * same algorithm ships in VSCode-MDPA-Preview (`src/parser/hangingNodes.ts`),
 * which reads these constraints back.
 */

/** One node of the mesh, by its (opaque, source) tag. */
export interface MpcNode {
  tag: number;
  x: number;
  y: number;
  z: number;
}

/** `slave` is a linear combination of `masters`: u(slave) = Σ weights[i] · u(masters[i]). */
export interface MpcConstraint {
  slave: number;
  /** Master node tags, ascending, duplicates merged. */
  masters: number[];
  /** One weight per master; they sum to 1. */
  weights: number[];
}

export interface HangingResult {
  constraints: MpcConstraint[];
  /** Hexahedra examined. */
  cellsChecked: number;
  /** Nodes that were hanging only through another hanging node. */
  chained: number;
  /** Corner-tag rings of the cell faces that carry a face-centre hanging node
   * (the coarse side of a coarse/fine interface) — input of
   * {@link hangingInterfaceFilter}. */
  hostFaces: number[][];
}

/** Hexahedron edges / faces by corner index (Kratos `Hexahedra3D8` = VTK order). */
const HEX_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];
const HEX_FACE_RINGS: ReadonlyArray<readonly number[]> = [
  [0, 3, 2, 1],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [1, 2, 6, 5],
  [2, 3, 7, 6],
  [3, 0, 4, 7],
];

type Vec = [number, number, number];

function gridKey(i: number, j: number, k: number): string {
  return `${i},${j},${k}`;
}

/** Point-to-segment: distance and the parameter along it. */
function onSegment(p: Vec, a: Vec, b: Vec): { dist: number; t: number } {
  const ab: Vec = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  if (len2 === 0) return { dist: Infinity, t: 0 };
  const t = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / len2;
  return { dist: Math.hypot(p[0] - (a[0] + t * ab[0]), p[1] - (a[1] + t * ab[1]), p[2] - (a[2] + t * ab[2])), t };
}

/**
 * Bilinear coordinates of `p` on the quadrilateral `c` (corners in ring order),
 * or undefined when it is off the face by more than `tol` or on its boundary.
 */
function onQuad(p: Vec, c: Vec[], tol: number): { u: number; v: number } | undefined {
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let u = 0.5;
  let v = 0.5;
  for (let it = 0; it < 30; it++) {
    const w = [(1 - u) * (1 - v), u * (1 - v), u * v, (1 - u) * v];
    const x = [0, 1, 2].map((d) => w[0] * c[0][d] + w[1] * c[1][d] + w[2] * c[2][d] + w[3] * c[3][d]);
    const r = [x[0] - p[0], x[1] - p[1], x[2] - p[2]];
    const xu = [0, 1, 2].map((d) => (1 - v) * (c[1][d] - c[0][d]) + v * (c[2][d] - c[3][d]));
    const xv = [0, 1, 2].map((d) => (1 - u) * (c[3][d] - c[0][d]) + u * (c[2][d] - c[1][d]));
    // Least-squares 2x2 normal equations (the face is a surface in 3-space).
    const a11 = dot(xu, xu);
    const a12 = dot(xu, xv);
    const a22 = dot(xv, xv);
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-300) return undefined;
    const b1 = -dot(xu, r);
    const b2 = -dot(xv, r);
    const du = (b1 * a22 - b2 * a12) / det;
    const dv = (a11 * b2 - a12 * b1) / det;
    u += du;
    v += dv;
    if (Math.abs(du) + Math.abs(dv) < 1e-13) break;
  }
  const w = [(1 - u) * (1 - v), u * (1 - v), u * v, (1 - u) * v];
  const x = [0, 1, 2].map((d) => w[0] * c[0][d] + w[1] * c[1][d] + w[2] * c[2][d] + w[3] * c[3][d]);
  if (Math.hypot(x[0] - p[0], x[1] - p[1], x[2] - p[2]) > tol) return undefined;
  const eps = 1e-9;
  if (u < eps || u > 1 - eps || v < eps || v > 1 - eps) return undefined;
  return { u, v };
}

interface Found {
  node: number;
  masters: number[];
  weights: number[];
  on: "edge" | "face";
  /** The hosting cell face's corner tags, for a face hit. */
  ring?: number[];
}

/**
 * Finds every node that lies in the interior of an edge or face of a hexahedron
 * without being one of its corners, and the end-master constraint that ties it.
 * `hexes` are 8-corner tag arrays in Kratos/VTK hexahedron order. A cell that
 * names an unknown tag is skipped.
 */
export function findHangingConstraints(nodes: readonly MpcNode[], hexes: ReadonlyArray<readonly number[]>): HangingResult {
  const index = new Map<number, number>();
  nodes.forEach((n, i) => index.set(n.tag, i));
  const P = (tag: number): Vec => {
    const n = nodes[index.get(tag)!];
    return [n.x, n.y, n.z];
  };
  const cells = hexes.filter((h) => h.length === 8 && h.every((t) => index.has(t)));
  if (cells.length === 0 || nodes.length === 0) return { constraints: [], cellsChecked: 0, chained: 0, hostFaces: [] };

  // Grid cell size: the mean edge length, so a cell's box touches few grid cells.
  let sum = 0;
  let count = 0;
  for (const cell of cells) {
    for (const [a, b] of HEX_EDGES) {
      const pa = P(cell[a]);
      const pb = P(cell[b]);
      sum += Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
      count++;
    }
  }
  const size = Math.max(sum / Math.max(count, 1), 1e-12);
  const grid = new Map<string, number[]>();
  nodes.forEach((n, i) => {
    const key = gridKey(Math.floor(n.x / size), Math.floor(n.y / size), Math.floor(n.z / size));
    const list = grid.get(key);
    if (list) list.push(i);
    else grid.set(key, [i]);
  });

  const found = new Map<number, Found>();
  for (const cell of cells) {
    const corners = cell.map(P);
    const lo: Vec = [Infinity, Infinity, Infinity];
    const hi: Vec = [-Infinity, -Infinity, -Infinity];
    for (const p of corners) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], p[d]); hi[d] = Math.max(hi[d], p[d]); }
    let shortest = Infinity;
    for (const [a, b] of HEX_EDGES) {
      shortest = Math.min(shortest, Math.hypot(corners[a][0] - corners[b][0], corners[a][1] - corners[b][1], corners[a][2] - corners[b][2]));
    }
    const tol = Math.max(shortest * 1e-6, 1e-12);
    const cornerSet = new Set(cell);
    const i0 = lo.map((v) => Math.floor((v - tol) / size));
    const i1 = hi.map((v) => Math.floor((v + tol) / size));
    for (let i = i0[0]; i <= i1[0]; i++) for (let j = i0[1]; j <= i1[1]; j++) for (let k = i0[2]; k <= i1[2]; k++) {
      for (const ni of grid.get(gridKey(i, j, k)) ?? []) {
        const n = nodes[ni];
        if (cornerSet.has(n.tag)) continue;
        const p: Vec = [n.x, n.y, n.z];
        if (p.some((v, d) => v < lo[d] - tol || v > hi[d] + tol)) continue;
        // Edges first: the tighter relation wins over a face that happens to contain it.
        let hit: Found | undefined;
        for (const [a, b] of HEX_EDGES) {
          const { dist, t } = onSegment(p, corners[a], corners[b]);
          if (dist <= tol && t > 1e-9 && t < 1 - 1e-9) {
            hit = { node: n.tag, masters: [cell[a], cell[b]], weights: [1 - t, t], on: "edge" };
            break;
          }
        }
        if (!hit) {
          for (const face of HEX_FACE_RINGS) {
            const uv = onQuad(p, face.map((c) => corners[c]), tol);
            if (uv) {
              const { u, v } = uv;
              hit = {
                node: n.tag,
                masters: face.map((c) => cell[c]),
                weights: [(1 - u) * (1 - v), u * (1 - v), u * v, (1 - u) * v],
                on: "face",
                ring: face.map((c) => cell[c]),
              };
              break;
            }
          }
        }
        if (!hit) continue;
        const prev = found.get(n.tag);
        if (!prev || (prev.on === "face" && hit.on === "edge")) found.set(n.tag, hit);
      }
    }
  }

  // Resolve chains: a master that is itself hanging is replaced by its own masters.
  const resolved = new Map<number, { masters: number[]; weights: number[] }>();
  let chained = 0;
  const resolve = (tag: number, stack: Set<number>): { masters: number[]; weights: number[] } => {
    const done = resolved.get(tag);
    if (done) return done;
    const h = found.get(tag)!;
    if (stack.has(tag)) throw new Error(`Hanging nodes form a cycle through node ${tag}; cannot tie them to end masters.`);
    stack.add(tag);
    const acc = new Map<number, number>();
    let viaChain = false;
    h.masters.forEach((m, i) => {
      if (found.has(m)) {
        viaChain = true;
        const r = resolve(m, stack);
        r.masters.forEach((mm, j) => acc.set(mm, (acc.get(mm) ?? 0) + h.weights[i] * r.weights[j]));
      } else acc.set(m, (acc.get(m) ?? 0) + h.weights[i]);
    });
    stack.delete(tag);
    if (viaChain) chained++;
    const masters = [...acc.keys()].sort((a, b) => a - b);
    const out = { masters, weights: masters.map((m) => acc.get(m)!) };
    resolved.set(tag, out);
    return out;
  };
  const constraints: MpcConstraint[] = [];
  for (const tag of [...found.keys()].sort((a, b) => a - b)) {
    const r = resolve(tag, new Set());
    constraints.push({ slave: tag, masters: r.masters, weights: r.weights });
  }
  const hostFaces = [...found.values()].filter((h) => h.on === "face").map((h) => h.ring!);
  return { constraints, cellsChecked: cells.length, chained, hostFaces };
}

/**
 * The largest error with which the constraints reproduce a linear field: an
 * affine field `f(x) = a·x + b` is imposed on the END masters and read at every
 * slave. Exact (round-off) for an undistorted octree; a snapped or otherwise
 * moved hanging node shows up here.
 */
export function patchTestMaxError(constraints: readonly MpcConstraint[], nodes: readonly MpcNode[]): number {
  const at = new Map<number, MpcNode>();
  for (const n of nodes) at.set(n.tag, n);
  const a = [0.7, -1.3, 2.1];
  const b = 0.45;
  const f = (n: MpcNode) => a[0] * n.x + a[1] * n.y + a[2] * n.z + b;
  let worst = 0;
  for (const c of constraints) {
    const slave = at.get(c.slave);
    if (!slave) continue;
    let value = 0;
    c.masters.forEach((m, i) => {
      const node = at.get(m);
      if (node) value += c.weights[i] * f(node);
    });
    worst = Math.max(worst, Math.abs(value - f(slave)));
  }
  return worst;
}

/**
 * A predicate over the boundary rings `boundaryFaceRings` keeps (faces seen by
 * exactly one cell): true for a ring that is NOT a real boundary but one side of
 * a coarse/fine interface. Without it a coarse face and its four fine
 * neighbours never match each other's corner key, so all five would be drawn —
 * and exported as boundary — inside the model.
 *
 * Coarse side: a ring that hosts a face-centre hanging node (a 1-irregular
 * octree always has one on a face that meets four finer faces). Fine side: a
 * ring whose every node is a corner of that host or hangs on it (its END
 * masters are corners of the host).
 */
export function hangingInterfaceFilter(result: Pick<HangingResult, "constraints" | "hostFaces">): (ring: readonly number[]) => boolean {
  if (result.hostFaces.length === 0) return () => false;
  const key = (ring: readonly number[]) => [...ring].sort((a, b) => a - b).join("_");
  const hostKeys = new Set(result.hostFaces.map(key));
  const mastersOf = new Map<number, readonly number[]>();
  for (const c of result.constraints) mastersOf.set(c.slave, c.masters);
  // Hosts reachable from a corner node, to avoid testing every host per ring.
  const hostsByCorner = new Map<number, Set<number>[]>();
  for (const ring of result.hostFaces) {
    const corners = new Set(ring);
    for (const t of ring) {
      const list = hostsByCorner.get(t);
      if (list) list.push(corners);
      else hostsByCorner.set(t, [corners]);
    }
  }
  return (ring) => {
    if (hostKeys.has(key(ring))) return true;
    let anchored = false;
    const candidates: Set<number>[] = [];
    for (const t of ring) {
      const masters = mastersOf.get(t);
      for (const m of masters ?? [t]) for (const host of hostsByCorner.get(m) ?? []) if (!candidates.includes(host)) candidates.push(host);
      if (masters) anchored = true;
    }
    if (!anchored) return false; // no hanging node: nothing to cover
    return candidates.some((host) => ring.every((t) => host.has(t) || (mastersOf.get(t)?.every((m) => host.has(m)) ?? false)));
  };
}

/** Slave→master segments as index pairs into the caller's position table. */
export interface MpcLinks {
  /** `[slave, master, slave, master, …]` position indices. */
  indices: Uint32Array;
  /** Segments dropped by the cap. */
  truncated: number;
}

/** Cap on drawn segments; a bull-sized octree has far fewer, this bounds a pathological one. */
export const MAX_MPC_LINKS = 200_000;

export function buildMpcLinks(
  constraints: readonly MpcConstraint[],
  tagToIndex: ReadonlyMap<number, number>,
  limit = MAX_MPC_LINKS
): MpcLinks {
  const out: number[] = [];
  let total = 0;
  for (const c of constraints) {
    const s = tagToIndex.get(c.slave);
    if (s === undefined) continue;
    for (const m of c.masters) {
      const mi = tagToIndex.get(m);
      if (mi === undefined) continue;
      total++;
      if (out.length / 2 < limit) out.push(s, mi);
    }
  }
  return { indices: Uint32Array.from(out), truncated: total - out.length / 2 };
}

/** Counts a constraint set reports (the same numbers the panel, MCP and manifest quote). */
export interface MpcFacts {
  /** Hanging nodes, one slave each. */
  hangingNodes: number;
  /** Constraint rows written: hanging nodes × tied variables. */
  constraints: number;
  /** Hanging nodes tied through another hanging node (resolved to end masters). */
  chained: number;
  variables: string[];
}

export function mpcFacts(result: Pick<HangingResult, "constraints" | "chained">, variables: readonly string[]): MpcFacts {
  return {
    hangingNodes: result.constraints.length,
    constraints: result.constraints.length * variables.length,
    chained: result.chained,
    variables: [...variables],
  };
}

/** Default variables a hanging node is tied on (Kratos needs one per block). */
export const DEFAULT_MPC_VARIABLES: readonly string[] = ["DISPLACEMENT_X", "DISPLACEMENT_Y", "DISPLACEMENT_Z"];
