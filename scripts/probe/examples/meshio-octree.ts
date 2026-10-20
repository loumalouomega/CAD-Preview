/** Roadmap 4.10 probe: octree hex-dominant meshing (PASSED 2026-10-20, meshio++ 17.8.0).
 * Run: npm run probe -- scripts/probe/examples/meshio-octree.ts --run
 * Diagnostics are JSON on stderr. Exit 0 means the probe completed, not that the gate passed.
 *
 * 1. Tessellate examples/STP/block.stp (3x4x5, volume 60) and run `octree`
 *    with fill 'inside', transition 'templates', balance 'face', snap true
 *    at maxLevel 3 and 4; write MDPA.
 * 2. Check: every cell is a hexahedron/pyramid/tetrahedron, no face is shared
 *    by more than two cells, all volumes positive, total volume ~60, and
 *    every boundary node lies on the skin within one leaf size.
 * 3. Repeat on bull.stp coarse; record leaf/cell counts, hex share, time,
 *    memory, numSnapped/numRefused, and the B-rep volume match.
 * 4. One open square (fill 'surface'), one .stl mesh source (fill 'inside'),
 *    and one coarse 'polyhedra' case (to confirm MDPA cannot take it).
 */
import * as fs from "fs";
import { getOcct } from "../../../src/occtService";
import { readShape } from "../../../src/occtService";
import { tessellateByGroup } from "../../../src/meshExtract";
import { TESSELLATION_PRESETS } from "../../../src/tessellationQuality";
import { weldTriangleSoup, weldedMeshToStlBytes } from "../../../src/meshComponents";
import { volumePropertiesAdaptive } from "../../../src/brepGProp";
import { getMeshio } from "../../../src/meshioService";
import { kernelVersions } from "../../../src/kernelVersions";

console.log = console.error.bind(console);
type Oc = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Del = { delete(): void };

const HEX_FACES = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
const PYR_FACES = [[0, 1, 2, 3], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]];
const TET_FACES = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]];

function sub(a: number[], b: number[]): number[] { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: number[], b: number[]): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

function tetVol(a: number[], b: number[], c: number[], d: number[]): number {
  return dot(sub(a, d), cross(sub(b, d), sub(c, d))) / 6;
}

/** Cell volume by centroid fan with per-face orientation normalized: each
 * ring is wound so its Newell normal points away from the cell centroid, so
 * the result is convention-independent (meshio/VTK/hex orderings differ in
 * which quads wind inward). Returns the positive volume. */
function cellVolume(pts: ArrayLike<number>, ids: number[], faces: number[][]): number {
  const c = [0, 0, 0];
  for (const id of ids) { c[0] += pts[id * 3]; c[1] += pts[id * 3 + 1]; c[2] += pts[id * 3 + 2]; }
  c[0] /= ids.length; c[1] /= ids.length; c[2] /= ids.length;
  const P = (id: number): number[] => [pts[id * 3], pts[id * 3 + 1], pts[id * 3 + 2]];
  let v = 0;
  for (const f of faces) {
    let ring = f.map(P);
    // Newell normal of the ring.
    const n = [0, 0, 0];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const fc = [0, 0, 0];
    for (const p of ring) { fc[0] += p[0]; fc[1] += p[1]; fc[2] += p[2]; }
    const out = [fc[0] / ring.length - c[0], fc[1] / ring.length - c[1], fc[2] / ring.length - c[2]];
    if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) ring = [...ring].reverse();
    for (let i = 1; i + 1 < ring.length; i++) v += tetVol(c, ring[0], ring[i], ring[i + 1]);
  }
  return Math.abs(v);
}

function facesOf(type: string, data: ArrayLike<number>, k: number): { ids: number[]; faces: number[][] } {
  const ids: number[] = [];
  if (type === "hexahedron") { for (let i = 0; i < 8; i++) ids.push(Number(data[k * 8 + i])); return { ids, faces: HEX_FACES }; }
  if (type === "pyramid") { for (let i = 0; i < 5; i++) ids.push(Number(data[k * 5 + i])); return { ids, faces: PYR_FACES }; }
  if (type === "tetra") { for (let i = 0; i < 4; i++) ids.push(Number(data[k * 4 + i])); return { ids, faces: TET_FACES }; }
  return { ids: [], faces: [] };
}

function newellNormal(ring: number[][]): number[] {
  const n = [0, 0, 0];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

/** Order a face's nodes into a geometric ring (any stored order accepted). */
function orderRing(nodes: number[][]): number[][] {
  if (nodes.length <= 3) return nodes;
  const n = newellNormal(nodes);
  const nl = Math.hypot(n[0], n[1], n[2]);
  if (!(nl > 0)) return nodes;
  const nn = [n[0] / nl, n[1] / nl, n[2] / nl];
  const helper = Math.abs(nn[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = [helper[1] * nn[2] - helper[2] * nn[1], helper[2] * nn[0] - helper[0] * nn[2], helper[0] * nn[1] - helper[1] * nn[0]];
  const ul = Math.hypot(u[0], u[1], u[2]);
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v = [nn[1] * u[2] - nn[2] * u[1], nn[2] * u[0] - nn[0] * u[2], nn[0] * u[1] - nn[1] * u[0]];
  const c = [0, 0, 0];
  for (const p of nodes) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  c[0] /= nodes.length; c[1] /= nodes.length; c[2] /= nodes.length;
  return [...nodes].sort((p, q) =>
    Math.atan2(dot(sub(p, c), v), dot(sub(p, c), u)) - Math.atan2(dot(sub(q, c), v), dot(sub(q, c), u)));
}

/** Mesh-enclosed volume by regular-grid parity sampling: no face orientation
 * needed anywhere (ray crossings work on unoriented triangles), so concave
 * geometry cannot fool it. Deterministic grid; the two triangulations of a
 * warped quad differ only in a measure-zero sliver.
 */
function parityVolume(
  tris: Array<[number[], number[], number[]]>,
  bbox: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
  nx: number,
  ny: number,
  nz: number
): { inside: number; total: number; volume: number } {
  const dir = [1, 0.000001, 0.000002];
  const parity = (q: number[]): boolean => {
    let hits = 0;
    for (const [a, b, c] of tris) {
      const e1 = sub(b, a), e2 = sub(c, a);
      const pv = cross(dir, e2);
      const det = dot(e1, pv);
      if (Math.abs(det) < 1e-18) continue;
      const inv = 1 / det;
      const tv = sub(q, a);
      const u = dot(tv, pv) * inv;
      if (u < -1e-9 || u > 1 + 1e-9) continue;
      const qv = cross(tv, e1);
      const v = dot(dir, qv) * inv;
      if (v < -1e-9 || u + v > 1 + 1e-9) continue;
      if (dot(e2, qv) * inv > 1e-9) hits++;
    }
    return hits % 2 === 1;
  };
  let inside = 0;
  const total = nx * ny * nz;
  for (let i = 0; i < nx; i++) {
    const x = bbox.minX + ((i + 0.5) / nx) * (bbox.maxX - bbox.minX);
    for (let j = 0; j < ny; j++) {
      const y = bbox.minY + ((j + 0.5) / ny) * (bbox.maxY - bbox.minY);
      for (let k = 0; k < nz; k++) {
        const z = bbox.minZ + ((k + 0.5) / nz) * (bbox.maxZ - bbox.minZ);
        if (parity([x, y, z])) inside++;
      }
    }
  }
  const bbVol = (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY) * (bbox.maxZ - bbox.minZ);
  return { inside, total, volume: (inside / total) * bbVol };
}

/** Ray-cast parity of point q against skin triangles (odd = inside). */
function parityInside(q: number[], positions: Float32Array, indices: Uint32Array): boolean {
  // +x ray; count crossings with a jittered direction guard.
  let hits = 0;
  const triCount = indices.length / 3;
  for (let t = 0; t < triCount; t++) {
    const a = [positions[indices[t * 3] * 3], positions[indices[t * 3] * 3 + 1], positions[indices[t * 3] * 3 + 2]];
    const b = [positions[indices[t * 3 + 1] * 3], positions[indices[t * 3 + 1] * 3 + 1], positions[indices[t * 3 + 1] * 3 + 2]];
    const c = [positions[indices[t * 3 + 2] * 3], positions[indices[t * 3 + 2] * 3 + 1], positions[indices[t * 3 + 2] * 3 + 2]];
    // Möller–Trumbore with direction (1, 1e-9, 2e-9)-ish to avoid edge hits.
    const dir = [1, 0.000001, 0.000002];
    const e1 = sub(b, a), e2 = sub(c, a);
    const p = cross(dir, e2);
    const det = dot(e1, p);
    if (Math.abs(det) < 1e-18) continue;
    const inv = 1 / det;
    const tvec = sub(q, a);
    const u = dot(tvec, p) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const qv = cross(tvec, e1);
    const v = dot(dir, qv) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const tt = dot(e2, qv) * inv;
    if (tt > 1e-9) hits++;
  }
  return hits % 2 === 1;
}
function pointToTri(p: number[], a: number[], b: number[], c: number[]): number {
  // Closest point on triangle (Real-Time Collision Detection), squared distance.
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return dot(ap, ap);
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dot(bp, bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const q = [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v];
    return dot(sub(p, q), sub(p, q));
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dot(cp, cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const q = [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w];
    return dot(sub(p, q), sub(p, q));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const q = [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w];
    return dot(sub(p, q), sub(p, q));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  const q = [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
  return dot(sub(p, q), sub(p, q));
}

async function skinFromStep(oc: Oc, m: any, stepPath: string, cleanup: Del[]): Promise<{ skin: any; brepVolume: number; skinTriangles: number }> {
  oc.FS.writeFile("/s.stp", fs.readFileSync(stepPath));
  const shape = readShape(oc, "/s.stp", "step", cleanup);
  const vp = new oc.GProp_GProps_1(); cleanup.push(vp);
  volumePropertiesAdaptive(oc, shape, vp);
  const brepVolume = vp.Mass();
  const groups = tessellateByGroup(oc, shape, TESSELLATION_PRESETS.fine);
  const soup: number[] = [];
  for (const g of groups) {
    for (const f of g.faces) {
      const p = f.buffers.positions, ix = f.buffers.indices;
      for (let t = 0; t < ix.length; t += 3) {
        for (let k = 0; k < 3; k++) {
          const v = ix[t + k];
          soup.push(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
        }
      }
    }
  }
  const welded = weldTriangleSoup(new Float32Array(soup));
  const stl = weldedMeshToStlBytes(welded);
  m.FS.writeFile("/skin.stl", stl);
  const skin = m.readMesh("/skin.stl", "stl");
  m.FS.unlink("/skin.stl");
  try { oc.FS.unlink("/s.stp"); } catch { /* ignore */ }
  return { skin, brepVolume, skinTriangles: Math.floor(soup.length / 9) };
}

function skinTrianglesOf(skin: any): { positions: Float32Array; indices: Uint32Array } {
  const pos: number[] = [];
  const idx: number[] = [];
  const P = skin.points as ArrayLike<number>;
  for (let i = 0; i < P.length; i++) pos.push(Number(P[i]));
  let base = 0;
  for (const b of skin.cells as any[]) {
    if (b.type !== "triangle") continue;
    const d = b.data as ArrayLike<number>;
    for (let t = 0; t < d.length; t += 3) { idx.push(base + Number(d[t]), base + Number(d[t + 1]), base + Number(d[t + 2])); }
    base += Math.max(...Array.from({ length: d.length }, (_, i) => Number(d[i]))) + 1;
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

function checkVolumeMesh(m: any, vol: any, skin: any): Record<string, unknown> {
  const pts = vol.points as ArrayLike<number>;
  const P = (id: number): number[] => [Number(pts[id * 3]), Number(pts[id * 3 + 1]), Number(pts[id * 3 + 2])];
  const typeCounts: Record<string, number> = {};
  const faceUse = new Map<string, number>();
  const faceNodes = new Map<string, number[]>();
  let cells = 0;
  for (const b of vol.cells as any[]) {
    const type = b.type as string;
    const d = b.data as ArrayLike<number>;
    const per = type === "hexahedron" ? 8 : type === "pyramid" ? 5 : type === "tetra" ? 4 : 0;
    if (!per) { typeCounts[`other:${type}`] = (typeCounts[`other:${type}`] ?? 0) + d.length; continue; }
    const n = d.length / per;
    typeCounts[type] = (typeCounts[type] ?? 0) + n;
    for (let k = 0; k < n; k++) {
      const { ids, faces } = facesOf(type, d, k);
      cells++;
      for (const f of faces) {
        const key = f.map((j) => ids[j]).sort((x, y) => x - y).join(",");
        faceUse.set(key, (faceUse.get(key) ?? 0) + 1);
        if (!faceNodes.has(key)) faceNodes.set(key, f.map((j) => ids[j]));
      }
    }
  }
  let shared2 = 0, boundary1 = 0, overShared = 0;
  const boundaryNodes = new Set<number>();
  for (const [key, count] of faceUse) {
    if (count === 2) shared2++;
    else if (count === 1) { boundary1++; for (const id of faceNodes.get(key)!) boundaryNodes.add(id); }
    else overShared++;
  }
  // Max distance from a boundary node to the skin.
  const { positions, indices } = skinTrianglesOf(skin);
  const SP = (i: number): number[] => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  let maxSnapDist2 = 0;
  const triCount = indices.length / 3;
  for (const id of boundaryNodes) {
    const p = P(id);
    let best = Infinity;
    for (let t = 0; t < triCount; t++) {
      const dd = pointToTri(p, SP(indices[t * 3]), SP(indices[t * 3 + 1]), SP(indices[t * 3 + 2]));
      if (dd < best) best = dd;
      if (best === 0) break;
    }
    if (best > maxSnapDist2) maxSnapDist2 = best;
  }
  // Total volume by boundary flux over the sharing-analysis boundary faces
  // (no extractSkin: it faults with `memory access out of bounds` on some
  // meshes in this build). Rings are ordered geometrically and oriented
  // outward against a parity-verified interior point.
  const { positions: ipos, indices: iidx } = skinTrianglesOf(skin);
  let interior: number[] | null = null;
  {
    const avg = [0, 0, 0];
    const all = vol.points as ArrayLike<number>;
    const NN = all.length / 3;
    for (let i = 0; i < NN; i++) { avg[0] += Number(all[i * 3]); avg[1] += Number(all[i * 3 + 1]); avg[2] += Number(all[i * 3 + 2]); }
    avg[0] /= NN; avg[1] /= NN; avg[2] /= NN;
    if (parityInside(avg, ipos, iidx)) interior = avg;
  }
  let skinFaces = 0, minSkinFaceArea = Infinity, fluxTotal = 0;
  const boundaryTris: Array<[number[], number[], number[]]> = [];
  let bbMinX = Infinity, bbMinY = Infinity, bbMinZ = Infinity;
  let bbMaxX = -Infinity, bbMaxY = -Infinity, bbMaxZ = -Infinity;
  {
    const all = vol.points as ArrayLike<number>;
    for (let i = 0; i < all.length; i += 3) {
      const x = Number(all[i]), y = Number(all[i + 1]), z = Number(all[i + 2]);
      if (x < bbMinX) bbMinX = x; if (x > bbMaxX) bbMaxX = x;
      if (y < bbMinY) bbMinY = y; if (y > bbMaxY) bbMaxY = y;
      if (z < bbMinZ) bbMinZ = z; if (z > bbMaxZ) bbMaxZ = z;
    }
  }
  for (const [key, count] of faceUse) {
    if (count !== 1) continue;
    const nodes = (faceNodes.get(key) ?? []).map((id) => P(id));
    if (nodes.length < 3) continue;
    const ring = orderRing(nodes);
    const n = newellNormal(ring);
    const nl = Math.hypot(n[0], n[1], n[2]);
    const area = nl / 2;
    skinFaces++;
    if (area < minSkinFaceArea) minSkinFaceArea = area;
    // Parity triangles need no orientation at all.
    for (let i = 1; i + 1 < ring.length; i++) boundaryTris.push([ring[0], ring[i], ring[i + 1]]);
    if (interior && nl > 0) {
      const fc = [0, 0, 0];
      for (const q of ring) { fc[0] += q[0]; fc[1] += q[1]; fc[2] += q[2]; }
      fc[0] /= ring.length; fc[1] /= ring.length; fc[2] /= ring.length;
      const out = [fc[0] - interior[0], fc[1] - interior[1], fc[2] - interior[2]];
      let oriented = ring;
      if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) oriented = [...ring].reverse();
      for (let i = 1; i + 1 < oriented.length; i++) {
        fluxTotal += tetVol(interior, oriented[0], oriented[i], oriented[i + 1]);
      }
    }
  }
  // Orientation-free cross-check: regular-grid parity volume. Immune to the
  // concave-orientation trap the flux rule falls into; validates the flux on
  // convex cases and judges it on concave ones.
  let parityResult: Record<string, number> | null = null;
  if (boundaryTris.length > 0) {
    const ex = Math.max(1e-9, bbMaxX - bbMinX), ey = Math.max(1e-9, bbMaxY - bbMinY), ez = Math.max(1e-9, bbMaxZ - bbMinZ);
    const budget = 40000000 / boundaryTris.length;
    const total = Math.max(8000, Math.min(50000, Math.floor(budget)));
    const s = Math.cbrt(total / (ex * ey * ez));
    const nx = Math.max(4, Math.round(ex * s)), ny = Math.max(4, Math.round(ey * s)), nz = Math.max(4, Math.round(ez * s));
    const pv = parityVolume(boundaryTris,
      { minX: bbMinX, minY: bbMinY, minZ: bbMinZ, maxX: bbMaxX, maxY: bbMaxY, maxZ: bbMaxZ }, nx, ny, nz);
    parityResult = {
      samples: pv.total, inside: pv.inside,
      parityVolume: Math.round(pv.volume * 1000) / 1000,
    };
  }
  return {
    cells, typeCounts,
    fluxTotal: Math.round(-fluxTotal * 1000) / 1000,
    ...(parityResult ?? {}),
    interiorPointInside: interior !== null,
    skinFaces, minSkinFaceArea: Math.round(minSkinFaceArea * 1e9) / 1e9,
    facesSharedBy2: shared2, facesBoundary: boundary1, facesOverShared: overShared,
    boundaryNodes: boundaryNodes.size,
    maxBoundaryToSkin: Math.round(Math.sqrt(maxSnapDist2) * 10000) / 10000,
  };
}

async function main(): Promise<void> {
  const out: Record<string, unknown> = { versions: kernelVersions() };
  const oc: Oc = await getOcct(process.cwd());
  const cleanup: Del[] = [];
  try {
    const m: any = await getMeshio();
    const rss = (): number => Math.round(process.memoryUsage().rss / 1048576);

    for (const maxLevel of [3, 4]) {
      const row: Record<string, unknown> = { maxLevel };
      try {
        const t0 = Date.now();
        const rss0 = rss();
        const { skin, brepVolume, skinTriangles } = await skinFromStep(oc, m, "examples/STP/block.stp", cleanup);
        row.skinTriangles = skinTriangles;
        row.brepVolume = Math.round(brepVolume * 1000) / 1000;
        const r = m.octree(skin, null, 0, maxLevel, null, undefined, undefined, 3, undefined,
          "face", "inside", undefined, undefined, undefined, undefined, undefined, "templates", true);
        row.ms = Date.now() - t0;
        row.rssDeltaMb = rss() - rss0;
        row.numLeaves = r.numLeaves;
        row.numHanging = r.numHanging;
        row.finestLevel = r.finestLevel;
        row.rootSize = Math.round(r.rootSize * 1000) / 1000;
        row.numSnapped = r.numSnapped;
        row.numRefused = r.numRefused;
        Object.assign(row, checkVolumeMesh(m, r.mesh, skin));
        // MDPA round trip.
        m.writeMesh("/box.mdpa", r.mesh, "mdpa");
        const written = m.FS.readFile("/box.mdpa") as Uint8Array;
        row.mdpaBytes = written.length;
        const back = m.readMesh("/box.mdpa", "mdpa");
        row.mdpaCells = (back.cells as any[]).map((b) => [b.type, b.data.length]);
        m.FS.unlink("/box.mdpa");
      } catch (e) {
        row.error = String((e as Error)?.message ?? e).slice(0, 300);
      }
      out[`block_level${maxLevel}`] = row;
    }

    // bull.stp at maxLevel 3, 4 and 5: convergence story on curved skin.
    {
      const { skin: bullSkin, brepVolume: bullVol } = await skinFromStep(oc, m, "examples/STP/bull.stp", cleanup);
      out.bull_brepVolume = Math.round(bullVol * 1000) / 1000;
      for (const maxLevel of [3, 4, 5]) {
        const row: Record<string, unknown> = { maxLevel };
        try {
          const t0 = Date.now();
          const rss0 = rss();
          const r = m.octree(bullSkin, null, 0, maxLevel, null, undefined, undefined, 3, undefined,
            "face", "inside", undefined, undefined, undefined, undefined, undefined, "templates", true);
          row.ms = Date.now() - t0;
          row.rssDeltaMb = rss() - rss0;
          row.numLeaves = r.numLeaves;
          row.numHanging = r.numHanging;
          row.finestLevel = r.finestLevel;
          row.rootSize = Math.round(r.rootSize * 1000) / 1000;
          row.numSnapped = r.numSnapped;
          row.numRefused = r.numRefused;
          Object.assign(row, checkVolumeMesh(m, r.mesh, bullSkin));
        } catch (e) {
          row.error = String((e as Error)?.message ?? e).slice(0, 300);
        }
        out[`bull_level${maxLevel}`] = row;
      }
    }

    // Open square, fill surface.
    {
      const row: Record<string, unknown> = {};
      try {
        const stl = [
          "solid square",
          "facet normal 0 0 1", "outer loop", "vertex 0 0 0", "vertex 10 0 0", "vertex 10 10 0", "endloop", "endfacet",
          "facet normal 0 0 1", "outer loop", "vertex 0 0 0", "vertex 10 10 0", "vertex 0 10 0", "endloop", "endfacet",
          "endsolid square", "",
        ].join("\n");
        m.FS.writeFile("/sq.stl", stl);
        const skin = m.readMesh("/sq.stl", "stl");
        m.FS.unlink("/sq.stl");
        const r = m.octree(skin, null, 0, 3, null, undefined, undefined, 3, undefined,
          "face", "surface", undefined, undefined, undefined, undefined, undefined, "templates", true);
        row.numLeaves = r.numLeaves;
        row.numHanging = r.numHanging;
        row.numSnapped = r.numSnapped;
        row.numRefused = r.numRefused;
        row.cells = (r.mesh.cells as any[]).map((b) => [b.type, b.data.length]);
      } catch (e) {
        row.error = String((e as Error)?.message ?? e).slice(0, 300);
      }
      out.open_surface = row;
    }

    // STL mesh source, fill inside.
    {
      const row: Record<string, unknown> = {};
      try {
        m.FS.writeFile("/c.stl", fs.readFileSync("examples/STL/cube.stl"));
        const skin = m.readMesh("/c.stl", "stl");
        m.FS.unlink("/c.stl");
        const P = skin.points as ArrayLike<number>;
        let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < P.length; i += 3) {
          for (let k = 0; k < 3; k++) {
            const v = Number(P[i + k]);
            if (v < mn[k]) mn[k] = v;
            if (v > mx[k]) mx[k] = v;
          }
        }
        row.bboxVolume = Math.round((mx[0] - mn[0]) * (mx[1] - mn[1]) * (mx[2] - mn[2]) * 1000) / 1000;
        const r = m.octree(skin, null, 0, 3, null, undefined, undefined, 3, undefined,
          "face", "inside", undefined, undefined, undefined, undefined, undefined, "templates", true);
        row.numLeaves = r.numLeaves;
        row.numHanging = r.numHanging;
        row.numSnapped = r.numSnapped;
        row.numRefused = r.numRefused;
        Object.assign(row, checkVolumeMesh(m, r.mesh, skin));
      } catch (e) {
        row.error = String((e as Error)?.message ?? e).slice(0, 300);
      }
      out.stl_source = row;
    }

    // Coarse polyhedra transition: confirm it is not MDPA-representable.
    {
      const row: Record<string, unknown> = {};
      try {
        const { skin } = await skinFromStep(oc, m, "examples/STP/block.stp", cleanup);
        const r = m.octree(skin, null, 0, 4, null, undefined, undefined, 3, undefined,
          "face", "inside", undefined, undefined, undefined, undefined, undefined, "polyhedra", true);
        row.cells = (r.mesh.cells as any[]).map((b) => [b.type, b.data.length]);
        try {
          m.writeMesh("/poly.mdpa", r.mesh, "mdpa");
          const written = m.FS.readFile("/poly.mdpa") as Uint8Array;
          row.mdpaBytes = written.length;
          m.FS.unlink("/poly.mdpa");
        } catch (e) {
          row.mdpaError = String((e as Error)?.message ?? e).slice(0, 300);
        }
      } catch (e) {
        row.error = String((e as Error)?.message ?? e).slice(0, 300);
      }
      out.polyhedra = row;
    }
  } catch (e) {
    out.fatal = String((e as Error)?.message ?? e).slice(0, 300);
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) { try { cleanup[i].delete(); } catch { /* ignore */ } }
  }
  console.error(JSON.stringify(out, null, 2));
}

main().then(
  () => process.exit(0),
  () => process.exit(0)
);
