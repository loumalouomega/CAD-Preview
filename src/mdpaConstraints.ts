/**
 * Multi-point constraints in a Kratos `.mdpa` file. Pure: no vscode/WASM/DOM.
 *
 * meshio++'s `mdpa` reader refuses a file with a `Begin Constraints` block
 * ("needs an MdpaInfo to be kept") and CAD-Preview has no use for the rows in
 * its boundary-surface funnel, so two things happen on open:
 *
 *  - {@link stripMdpaConstraints} removes the blocks from the bytes handed to
 *    meshio++ (the same single-staging-choke-point trick as `nastranDeck.ts`),
 *    so a constrained file opens like any other mesh; and
 *  - {@link parseMdpaConstraintLinks} reads the rows back from the ORIGINAL text
 *    and turns them into slave→master line geometry for the viewer, so the
 *    extension no longer silently drops them.
 *
 * Layout (Kratos `ModelPartIO::ReadConstraintsBlock`, and what `mdpaWriter.ts`
 * writes):
 *
 * ```
 * Begin Constraints LinearMasterSlaveConstraint DISPLACEMENT_X DISPLACEMENT_X DISPLACEMENT_X
 *   1 0.0 [0.5, 0.5] 11 2 3        // id constant [weights] slave master…
 * End Constraints
 * ```
 *
 * The trailing integer run is split FROM THE END: the last `weights.length` ids
 * are the masters and whatever precedes them is the slave column. A row that
 * does not fit is counted in `skippedRows` and named, never guessed at.
 */

import { MAX_MPC_LINKS } from "./hangingConstraints";

const BEGIN_CONSTRAINTS = /^\s*Begin\s+Constraints\b/;
const END_CONSTRAINTS = /^\s*End\s+Constraints\b/;
const BEGIN_SMP_CONSTRAINTS = /^\s*Begin\s+SubModelPartConstraints\b/;
const END_SMP_CONSTRAINTS = /^\s*End\s+SubModelPartConstraints\b/;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Cheap pre-check so a file without constraints is never re-encoded. */
function mentionsConstraints(text: string): boolean {
  return /^\s*Begin\s+(Constraints|SubModelPartConstraints)\b/m.test(text);
}

/**
 * The same bytes with every `Begin Constraints … End Constraints` block and
 * every `SubModelPartConstraints` list removed. A file with neither is returned
 * as the SAME instance (no copy, byte-identical). Line endings are preserved.
 */
export function stripMdpaConstraints(bytes: Uint8Array): Uint8Array {
  const text = decoder.decode(bytes);
  if (!mentionsConstraints(text)) return bytes;
  const kept: string[] = [];
  let skipUntil: RegExp | null = null;
  for (const line of text.split("\n")) {
    if (skipUntil) {
      if (skipUntil.test(line)) skipUntil = null;
      continue;
    }
    if (BEGIN_CONSTRAINTS.test(line)) {
      skipUntil = END_CONSTRAINTS;
      continue;
    }
    if (BEGIN_SMP_CONSTRAINTS.test(line)) {
      skipUntil = END_SMP_CONSTRAINTS;
      continue;
    }
    kept.push(line);
  }
  return encoder.encode(kept.join("\n"));
}

/** Slave→master segments of a file's linear constraints, in file coordinates. */
export interface MdpaConstraintLinks {
  /** Interleaved xyz of the distinct nodes the links touch. */
  points: Float32Array;
  /** `[a, b, a, b, …]` indices into `points`: one segment per distinct (slave, master) pair. */
  indices: Uint32Array;
  /** Linear constraint rows read (one per variable and slave — a three-variable tie counts three). */
  constraintCount: number;
  /** Distinct slave nodes. */
  slaveCount: number;
  /** Variables named in the block headers, first-seen order. */
  variables: string[];
  /** Segments beyond {@link MAX_MPC_LINKS} that are counted but not drawn. */
  truncated: number;
  /** Rows (or blocks) that do not fit the supported layout — named in `notes`. */
  skippedRows: number;
  /** Segments dropped because a node is not in `Begin Nodes`. */
  missingNodes: number;
  /** One line per kind of thing that was skipped. */
  notes: string[];
  /** The coarse faces that carry a face-centre hanging node (a slave tied to
   * FOUR masters): 12 numbers (four xyz corners) per face, deduplicated by
   * slave. meshio++'s boundary extraction cannot cancel a coarse face against
   * its four finer neighbours, so these are what {@link dropInterfaceFacets}
   * removes from the displayed boundary. */
  interfaceQuads: number[];
}

interface Row {
  slave: number;
  masters: number[];
}

/** Splits `id constant [w, …] ids…`; undefined when it does not fit. */
function parseRow(line: string): Row | undefined {
  const open = line.indexOf("[");
  const close = line.indexOf("]", open + 1);
  if (open < 0 || close < 0) return undefined;
  const head = line.slice(0, open).trim().split(/\s+/);
  if (head.length !== 2 || !/^[+-]?\d+$/.test(head[0]) || !Number.isFinite(Number(head[1]))) return undefined;
  const weights = line.slice(open + 1, close).split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (weights.length === 0 || weights.some((w) => !Number.isFinite(Number(w)))) return undefined;
  const tail = line.slice(close + 1).trim();
  if (!/^[+-]?\d+(\s+[+-]?\d+)*$/.test(tail)) return undefined;
  const ids = tail.split(/\s+/).map(Number);
  if (ids.length <= weights.length) return undefined;
  return { slave: ids[ids.length - weights.length - 1], masters: ids.slice(ids.length - weights.length) };
}

/**
 * Reads the linear constraints of an `.mdpa` and turns them into line geometry.
 * Returns `undefined` when the file declares no `Begin Constraints` block (the
 * common case — nothing is parsed twice). Never throws: unreadable rows and
 * non-`LinearMasterSlaveConstraint` blocks are counted in `skippedRows`.
 */
export function parseMdpaConstraintLinks(text: string, limit = MAX_MPC_LINKS): MdpaConstraintLinks | undefined {
  if (!/^\s*Begin\s+Constraints\b/m.test(text)) return undefined;
  const lines = text.split("\n");
  const rows: Row[] = [];
  const variables: string[] = [];
  const notes: string[] = [];
  let skippedRows = 0;
  let unsupportedBlocks = 0;
  let badRows = 0;
  let supported = false;
  let inConstraints = false;
  let inNodes = false;
  const nodeLines: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (line.length === 0) continue;
    if (inConstraints) {
      if (END_CONSTRAINTS.test(line)) {
        inConstraints = false;
        continue;
      }
      if (!supported) {
        skippedRows++;
        continue;
      }
      const row = parseRow(line);
      if (row) rows.push(row);
      else {
        skippedRows++;
        badRows++;
      }
      continue;
    }
    if (inNodes) {
      if (/^End\s+Nodes\b/.test(line)) inNodes = false;
      else nodeLines.push(line);
      continue;
    }
    if (/^Begin\s+Nodes\b/.test(line)) {
      inNodes = true;
      continue;
    }
    if (BEGIN_CONSTRAINTS.test(line)) {
      inConstraints = true;
      const words = line.split(/\s+/).slice(2); // after "Begin Constraints"
      supported = words[0] === "LinearMasterSlaveConstraint";
      if (supported) {
        for (const v of words.slice(1)) if (!variables.includes(v)) variables.push(v);
      } else {
        unsupportedBlocks++;
      }
    }
  }
  if (unsupportedBlocks > 0) notes.push(`${unsupportedBlocks} constraint block(s) of a kind other than LinearMasterSlaveConstraint are not drawn.`);
  if (badRows > 0) notes.push(`${badRows} constraint row(s) do not fit the "id constant [weights] slave masters…" layout and were skipped.`);

  // Only the nodes the rows name are kept, so a million-node file stays cheap.
  const needed = new Set<number>();
  for (const r of rows) {
    needed.add(r.slave);
    for (const m of r.masters) needed.add(m);
  }
  const coords = new Map<number, [number, number, number]>();
  for (const line of nodeLines) {
    const f = line.split(/\s+/);
    if (f.length < 4) continue;
    const id = Number(f[0]);
    if (needed.has(id)) coords.set(id, [Number(f[1]), Number(f[2]), Number(f[3])]);
  }

  const local = new Map<number, number>();
  const points: number[] = [];
  const at = (id: number): number | undefined => {
    const hit = local.get(id);
    if (hit !== undefined) return hit;
    const c = coords.get(id);
    if (!c) return undefined;
    const i = points.length / 3;
    points.push(c[0], c[1], c[2]);
    local.set(id, i);
    return i;
  };
  const seen = new Set<string>();
  const slaves = new Set<number>();
  const interfaceQuads: number[] = [];
  const indices: number[] = [];
  let truncated = 0;
  let missingNodes = 0;
  for (const r of rows) {
    if (!slaves.has(r.slave) && r.masters.length === 4) {
      const corners = r.masters.map((m) => coords.get(m));
      if (corners.every((c) => c !== undefined)) for (const c of corners) interfaceQuads.push(c![0], c![1], c![2]);
    }
    slaves.add(r.slave);
    for (const m of r.masters) {
      const key = `${r.slave}_${m}`;
      if (seen.has(key)) continue; // the same tie on the next variable
      seen.add(key);
      const a = at(r.slave);
      const b = at(m);
      if (a === undefined || b === undefined) {
        missingNodes++;
        continue;
      }
      if (indices.length / 2 >= limit) {
        truncated++;
        continue;
      }
      indices.push(a, b);
    }
  }
  if (missingNodes > 0) notes.push(`${missingNodes} slave→master link(s) name a node that is not in Begin Nodes and were not drawn.`);
  return {
    points: Float32Array.from(points),
    indices: Uint32Array.from(indices),
    constraintCount: rows.length,
    slaveCount: slaves.size,
    variables,
    truncated,
    skippedRows,
    missingNodes,
    notes,
    interfaceQuads,
  };
}

/** One-line status for an opened file: "12 constraints on 5 slave nodes (DISPLACEMENT_X, …)". */
export function mdpaConstraintSummary(links: Pick<MdpaConstraintLinks, "constraintCount" | "slaveCount" | "variables" | "skippedRows" | "truncated">): string {
  const base = `${links.constraintCount} constraint${links.constraintCount === 1 ? "" : "s"} on ${links.slaveCount} slave node${links.slaveCount === 1 ? "" : "s"}`;
  const vars = links.variables.length > 0 ? ` (${links.variables.slice(0, 3).join(", ")}${links.variables.length > 3 ? ", …" : ""})` : "";
  const skipped = links.skippedRows > 0 ? ` · ${links.skippedRows} row(s) skipped` : "";
  const cut = links.truncated > 0 ? ` · ${links.truncated} link(s) not drawn` : "";
  return base + vars + skipped + cut;
}

/** Product of facets and quads above which {@link dropInterfaceFacets} declines. */
const MAX_FACET_QUAD_PAIRS = 50_000_000;

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

interface Quad {
  ring: V3[];
  normal: V3;
  lo: V3;
  hi: V3;
  tol: number;
}

/** A quad from its four corners in ANY order: ring-ordered by angle about the centroid. */
function makeQuad(c: V3[]): Quad | undefined {
  const centre: V3 = [0, 1, 2].map((d) => (c[0][d] + c[1][d] + c[2][d] + c[3][d]) / 4) as V3;
  const normal0 = cross(sub(c[1], c[0]), sub(c[2], c[0]));
  const len = Math.hypot(...normal0);
  if (!(len > 0)) return undefined;
  // The first three corners can be collinear-ish only for a degenerate face; use the best pair.
  const normal = normal0.map((v) => v / len) as V3;
  const u0 = sub(c[0], centre);
  const ul = Math.hypot(...u0);
  if (!(ul > 0)) return undefined;
  const u = u0.map((v) => v / ul) as V3;
  const v = cross(normal, u);
  const ring = [...c].sort((a, b) => Math.atan2(dot(sub(a, centre), v), dot(sub(a, centre), u)) - Math.atan2(dot(sub(b, centre), v), dot(sub(b, centre), u)));
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of ring) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], p[d]); hi[d] = Math.max(hi[d], p[d]); }
  const tol = 1e-6 * Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  return { ring, normal, lo, hi, tol };
}

function insideQuad(p: V3, q: Quad): boolean {
  for (let d = 0; d < 3; d++) if (p[d] < q.lo[d] - q.tol || p[d] > q.hi[d] + q.tol) return false;
  if (Math.abs(dot(sub(p, q.ring[0]), q.normal)) > q.tol) return false; // off the face plane
  for (let i = 0; i < 4; i++) {
    const a = q.ring[i];
    const b = q.ring[(i + 1) % 4];
    if (dot(cross(sub(b, a), sub(p, a)), q.normal) < -q.tol * Math.hypot(...sub(b, a))) return false;
  }
  return true;
}

/**
 * Removes from an ASCII STL boundary the facets lying inside a coarse/fine
 * hanging-node interface. meshio++'s boundary extraction keys faces by their
 * corners, so a coarse face and its four finer neighbours never cancel and the
 * interface would be drawn as a wall inside the model. A facet is dropped when
 * all three of its vertices lie in (and on the plane of) one of `quads`; the
 * returned `keep` mask is parallel to the input facets so a per-facet array
 * (region assignment) can be filtered the same way. Declines (returns the input
 * unchanged, `declined: true`) beyond {@link MAX_FACET_QUAD_PAIRS} comparisons.
 */
export function dropInterfaceFacets(
  stl: string,
  interfaceQuads: ArrayLike<number>
): { stl: string; keep: boolean[]; dropped: number; declined: boolean } {
  const facets = [...stl.matchAll(/facet\s+normal[\s\S]*?endfacet/g)];
  const keepAll = facets.map(() => true);
  const quads: Quad[] = [];
  for (let i = 0; i + 12 <= interfaceQuads.length; i += 12) {
    const c = [0, 1, 2, 3].map((k) => [interfaceQuads[i + k * 3], interfaceQuads[i + k * 3 + 1], interfaceQuads[i + k * 3 + 2]] as V3);
    const q = makeQuad(c);
    if (q) quads.push(q);
  }
  if (quads.length === 0 || facets.length === 0) return { stl, keep: keepAll, dropped: 0, declined: false };
  if (facets.length * quads.length > MAX_FACET_QUAD_PAIRS) return { stl, keep: keepAll, dropped: 0, declined: true };
  const keep = facets.map((f) => {
    const verts = [...f[0].matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as V3);
    if (verts.length !== 3) return true;
    return !quads.some((q) => verts.every((p) => insideQuad(p, q)));
  });
  const dropped = keep.filter((k) => !k).length;
  if (dropped === 0) return { stl, keep, dropped: 0, declined: false };
  const first = facets[0].index!;
  const last = facets[facets.length - 1];
  const head = stl.slice(0, first);
  const tail = stl.slice(last.index! + last[0].length);
  const body = facets.filter((_, i) => keep[i]).map((f) => f[0]).join("\n  ");
  return { stl: `${head}${body}${tail}`, keep, dropped, declined: false };
}
