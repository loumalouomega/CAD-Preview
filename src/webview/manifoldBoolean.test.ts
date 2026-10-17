import { describe, it, expect, beforeAll } from "vitest";
import * as THREE from "three";
import { applyEditsMesh } from "./meshEdits";
import { setManifoldEngine, manifoldReady } from "./manifoldBoolean";
import { initManifoldNode } from "./manifoldNode";
import type { OpOutcome } from "../editOps";

/** Free (1 use) and over-used (3+) undirected edges of a welded triangle soup. */
function edgeCensus(geo: THREE.BufferGeometry): { free: number; nonManifold: number; volume: number } {
  const pos = geo.getAttribute("position");
  const idx = geo.getIndex();
  const count = idx ? idx.count : pos.count;
  const ids = new Map<string, number>();
  const id = (i: number): number => {
    const k = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    let v = ids.get(k);
    if (v === undefined) { v = ids.size; ids.set(k, v); }
    return v;
  };
  const edges = new Map<string, number>();
  let volume = 0;
  const p = (i: number) => new THREE.Vector3().fromBufferAttribute(pos, i);
  for (let t = 0; t < count; t += 3) {
    const i = [0, 1, 2].map((o) => (idx ? idx.getX(t + o) : t + o));
    const w = i.map(id);
    for (let e = 0; e < 3; e++) {
      const a = w[e], b = w[(e + 1) % 3];
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
    volume += p(i[0]).dot(p(i[1]).cross(p(i[2]))) / 6;
  }
  let free = 0, nonManifold = 0;
  for (const n of edges.values()) { if (n === 1) free++; else if (n > 2) nonManifold++; }
  return { free, nonManifold, volume };
}

function root(): THREE.Group {
  const g = new THREE.Group();
  const cube = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10));
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 14, 64));
  g.add(cube, cyl);
  let i = 0;
  g.traverse((o) => { o.userData.groupId = `node-${i++}`; });
  return g;
}
const meshes = (r: THREE.Object3D): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  r.traverse((o) => { if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh); });
  return out;
};
const subtract = [{ op: "boolean" as const, kind: "subtract" as const, a: ["node-1"], b: ["node-2"] }];

describe("manifold mesh booleans", () => {
  beforeAll(async () => {
    expect(await initManifoldNode()).toBe(true);
  });

  it("cube minus a through-cylinder is closed, manifold, and has the analytic volume", () => {
    expect(manifoldReady()).toBe(true);
    const r = root();
    const outcomes: OpOutcome[] = [];
    applyEditsMesh(r, subtract, outcomes);
    expect(outcomes[0].applied).toBe(true);
    const [m] = meshes(r);
    const c = edgeCensus(m.geometry);
    expect(c.free).toBe(0);
    expect(c.nonManifold).toBe(0);
    // 1000 minus the 64-gon prism through the cube: area = 0.5*n*r^2*sin(2π/n) times height 10.
    const prism = 0.5 * 64 * 4 * Math.sin((2 * Math.PI) / 64) * 10;
    expect(c.volume).toBeCloseTo(1000 - prism, 2);
  });

  it("a counterbored hole through manifold stays closed", () => {
    const r = new THREE.Group();
    r.add(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10)));
    r.traverse((o) => { o.userData.groupId = "node-1"; });
    applyEditsMesh(r, [{
      op: "addCounterboreHole", targets: ["node-1"], position: [0, 5, 0], axis: [0, -1, 0], radius: 1, depth: 6, cbRadius: 2, cbDepth: 2,
    } as never]);
    const c = edgeCensus(meshes(r)[0].geometry);
    expect(c.free).toBe(0);
    expect(c.volume).toBeLessThan(1000);
  });

  it("CONTROL: the three-bvh-csg fallback leaves this same subtract open", async () => {
    setManifoldEngine(null);
    try {
      const r = root();
      applyEditsMesh(r, subtract);
      const c = edgeCensus(meshes(r)[0].geometry);
      expect(c.free + c.nonManifold).toBeGreaterThan(0);
    } finally {
      await initManifoldNode(); // restore for later tests in this file
    }
  });

  it("an open (non-manifold) operand falls back with a message instead of throwing", async () => {
    await initManifoldNode();
    const r = root();
    const open = meshes(r)[0];
    const idx = open.geometry.index!;
    open.geometry.setIndex(Array.from(idx.array).slice(0, idx.count - 3)); // drop one triangle
    const messages: string[] = [];
    const outcomes: OpOutcome[] = [];
    applyEditsMesh(r, subtract, outcomes, (m) => messages.push(m));
    expect(outcomes[0].applied).toBe(true);
    expect(messages.some((m) => /manifold boolean unavailable/.test(m))).toBe(true);
  });
});
