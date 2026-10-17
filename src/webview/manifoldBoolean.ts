/**
 * Mesh booleans through `manifold-3d` (roadmap "Manifold mesh booleans").
 *
 * The engine is a module-level slot filled by an async init (`manifoldBrowser.ts`
 * in the webview, `manifoldNode.ts` in the kernel worker) because `applyEditsMesh`
 * is synchronous. Until a slot is filled, or when manifold refuses an operand,
 * callers fall back to `three-bvh-csg` — the output of which is NOT guaranteed
 * closed (probe: 34–907 free edges on a plain subtract), so manifold is
 * preferred whenever it can take the input.
 *
 * Pure three + manifold: no DOM and no vscode, so the kernel worker may import it.
 */
import * as THREE from "three";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Manifold, ManifoldToplevel } from "manifold-3d/manifold";

let engine: ManifoldToplevel | null = null;

export function setManifoldEngine(module: ManifoldToplevel | null): void {
  engine = module;
}

export function manifoldReady(): boolean {
  return engine !== null;
}

/** Thrown when an operand cannot be taken by manifold; the caller falls back. */
export class ManifoldRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifoldRefused";
  }
}

export type ManifoldOp = "union" | "subtract" | "intersect";

/** An operand: geometry plus the world matrix baked in before the boolean. */
export interface BooleanOperand {
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
}

/** Crease angle used to rebuild normals on the result (a sphere stays smooth, a cube stays sharp). */
const CREASE_ANGLE = Math.PI / 6;

/**
 * Welds a triangle soup into an indexed mesh in world space and hands it to
 * manifold. Throws {@link ManifoldRefused} for an open / non-manifold /
 * inside-out operand — manifold's own constructor rejects those, which is the
 * clean input contract the probe found.
 */
function toManifold(m: ManifoldToplevel, operand: BooleanOperand): Manifold {
  const pos = operand.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!pos || pos.count === 0) throw new ManifoldRefused("operand has no geometry");
  const index = operand.geometry.getIndex();
  const triCount = Math.floor((index ? index.count : pos.count) / 3);
  const v = new THREE.Vector3();
  const bounds = new THREE.Box3();
  const world = new Float64Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(operand.matrix);
    world[3 * i] = v.x; world[3 * i + 1] = v.y; world[3 * i + 2] = v.z;
    bounds.expandByPoint(v);
  }
  const diagonal = bounds.getSize(v).length();
  const quantum = Math.max(diagonal, 1e-9) * 1e-7;
  const welded = new Map<string, number>();
  const remap = new Uint32Array(pos.count);
  const verts: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(world[3 * i] / quantum)},${Math.round(world[3 * i + 1] / quantum)},${Math.round(world[3 * i + 2] / quantum)}`;
    let id = welded.get(key);
    if (id === undefined) {
      id = verts.length / 3;
      welded.set(key, id);
      verts.push(world[3 * i], world[3 * i + 1], world[3 * i + 2]);
    }
    remap[i] = id;
  }
  const tris: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const a = remap[index ? index.getX(3 * t) : 3 * t];
    const b = remap[index ? index.getX(3 * t + 1) : 3 * t + 1];
    const c = remap[index ? index.getX(3 * t + 2) : 3 * t + 2];
    if (a === b || b === c || a === c) continue; // collapsed by the weld
    tris.push(a, b, c);
  }
  if (tris.length === 0) throw new ManifoldRefused("operand has no triangles");
  let result: Manifold;
  try {
    result = new m.Manifold(new m.Mesh({ numProp: 3, vertProperties: new Float32Array(verts), triVerts: new Uint32Array(tris) }));
  } catch (error) {
    throw new ManifoldRefused(`operand is not a closed manifold mesh (${(error as Error).message})`);
  }
  // An open mesh does not always throw: manifold can come back in an error
  // state with zero volume instead (a single missing triangle does).
  const status = result.status();
  if (status !== "NoError") {
    result.delete();
    throw new ManifoldRefused(`operand is not a closed manifold mesh (${status})`);
  }
  if (!(result.volume() > 0)) {
    result.delete();
    throw new ManifoldRefused("operand is inside-out or empty");
  }
  return result;
}

/** Converts a manifold result back to a flat/creased BufferGeometry. */
function fromManifold(result: Manifold): THREE.BufferGeometry {
  const mesh = result.getMesh();
  const stride = mesh.numProp;
  const positions = new Float32Array((mesh.vertProperties.length / stride) * 3);
  for (let i = 0, n = mesh.vertProperties.length / stride; i < n; i++) {
    positions[3 * i] = mesh.vertProperties[i * stride];
    positions[3 * i + 1] = mesh.vertProperties[i * stride + 1];
    positions[3 * i + 2] = mesh.vertProperties[i * stride + 2];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.triVerts), 1));
  return toCreasedNormals(geometry.toNonIndexed(), CREASE_ANGLE);
}

/**
 * `first <op> rest[0] <op> rest[1] …` in world space, applied left to right
 * (a hole with a counterbore subtracts two tools in sequence). Always closed
 * and manifold on success. Throws {@link ManifoldRefused} when manifold is not
 * initialised or cannot take an operand; every handle is freed either way.
 */
export function manifoldCombine(first: BooleanOperand, rest: BooleanOperand[], op: ManifoldOp): THREE.BufferGeometry {
  const m = engine;
  if (!m) throw new ManifoldRefused("manifold is not initialised");
  const owned: Manifold[] = [];
  try {
    let acc = toManifold(m, first);
    owned.push(acc);
    for (const operand of rest) {
      const other = toManifold(m, operand);
      owned.push(other);
      acc = op === "union" ? acc.add(other) : op === "subtract" ? acc.subtract(other) : acc.intersect(other);
      owned.push(acc);
    }
    return fromManifold(acc);
  } finally {
    for (let i = owned.length - 1; i >= 0; i--) {
      try { owned[i].delete(); } catch { /* already freed */ }
    }
  }
}
