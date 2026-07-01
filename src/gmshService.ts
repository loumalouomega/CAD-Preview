import * as fs from "fs";
import * as path from "path";
// The gmsh-wasm package's default export is an async emscripten-style factory,
// mirroring opencascade.js's raw factory shape (see occtService.ts) — pass the
// wasm binary explicitly rather than letting it try to fetch() a filesystem path.
import initialize from "@loumalouomega/gmsh-wasm";
import type { MeshOptions } from "./meshOptions";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GmshApi = any;

let _gmshPromise: Promise<GmshApi> | null = null;
let _modelCounter = 0;

/**
 * Returns the GMSH-wasm module, initializing it lazily on first call and
 * memoizing the resolved promise as a module singleton — same discipline as
 * `getOcct` in occtService.ts. `gmsh.initialize()` (the C API's own init, distinct
 * from the module factory above) is started here too, exactly once per process
 * lifetime; subsequent `generateMesh`/`exportGeoUnrolled` calls reset state via
 * `gmsh.clear()` + `gmsh.model.add(...)` instead of re-initializing.
 */
export function getGmsh(extensionPath: string): Promise<GmshApi> {
  if (!_gmshPromise) {
    const wasmPath = path.join(extensionPath, "dist", "gmsh-core.wasm");
    const wasmBinary = fs.readFileSync(wasmPath);
    _gmshPromise = initialize({ wasmBinary }).then((gmsh) => {
      gmsh.initialize();
      return gmsh;
    });
  }
  return _gmshPromise;
}

/** Resets the singleton — used by tests and for future hot-reload support. */
export function resetGmsh(): void {
  _gmshPromise = null;
  _modelCounter = 0;
}

export type MeshGenerationInput =
  | { kind: "brep"; stepBytes: Uint8Array }
  | { kind: "stl"; stlBytes: Uint8Array };

export interface MeshResult {
  positions: Float32Array;
  indices: Uint32Array;
  nodeCount: number;
  elementCount: number;
  mshText: string;
}

/**
 * Resets model state (`clear()` + fresh `model.add(...)`, never a second
 * `gmsh.initialize()`), writes `input`'s bytes to MEMFS, and builds the GMSH
 * geometry + applies `options` — shared by `generateMesh` and
 * `exportGeoUnrolled`, which then diverge (mesh+read-back vs. write .geo_unrolled).
 * The caller owns unlinking the MEMFS temp file it's given back, in its own
 * try/finally.
 */
function loadGeometryAndApplyOptions(gmsh: GmshApi, input: MeshGenerationInput, options: MeshOptions): string {
  gmsh.clear();
  gmsh.model.add(`model-${++_modelCounter}`);

  const tmpPath = input.kind === "brep" ? "/model.step" : "/model.stl";
  gmsh.FS.writeFile(tmpPath, input.kind === "brep" ? input.stepBytes : input.stlBytes);

  if (input.kind === "brep") {
    gmsh.model.occ.importShapes(tmpPath);
    gmsh.model.occ.synchronize();
  } else {
    gmsh.merge(tmpPath);
    gmsh.model.mesh.classifySurfaces((options.stlAngle ?? 40) * (Math.PI / 180));
    gmsh.model.mesh.createGeometry();
    const surfaces = gmsh.model.getEntities(2).dimTags as number[];
    const surfaceTags: number[] = [];
    for (let i = 0; i < surfaces.length; i += 2) surfaceTags.push(surfaces[i + 1]);
    const loopTag = gmsh.model.geo.addSurfaceLoop(surfaceTags);
    gmsh.model.geo.addVolume([loopTag]);
    gmsh.model.geo.synchronize();
  }

  gmsh.option.setNumber("Mesh.MeshSizeMin", options.sizeMin);
  gmsh.option.setNumber("Mesh.MeshSizeMax", options.sizeMax);
  gmsh.option.setNumber("Mesh.Algorithm", options.algorithm2D);
  gmsh.option.setNumber("Mesh.Algorithm3D", options.algorithm3D);
  gmsh.option.setNumber("Mesh.ElementOrder", options.elementOrder);
  gmsh.option.setNumber("Mesh.Optimize", options.optimize ? 1 : 0);

  return tmpPath;
}

/**
 * Generates a mesh from `input` per `options` and returns node/element counts
 * plus a display-ready boundary triangulation (`positions`/`indices`) alongside
 * the raw `.msh` text. For `dimension === 3` the boundary triangles are derived
 * from the tetrahedra (faces appearing in exactly one tet); for `dimension ===
 * 2` the generated triangles are used directly; for `dimension === 1` there is
 * no triangle to display, so `positions`/`indices` are returned empty.
 */
export async function generateMesh(
  extensionPath: string,
  input: MeshGenerationInput,
  options: MeshOptions
): Promise<MeshResult> {
  const gmsh = await getGmsh(extensionPath);

  const outPath = "/out.msh";
  let tmpPath: string | null = null;
  try {
    tmpPath = loadGeometryAndApplyOptions(gmsh, input, options);

    gmsh.model.mesh.generate(options.dimension);

    const nodes = gmsh.model.mesh.getNodes() as { nodeTags: number[]; coord: number[] };
    const { positions, tagToIndex } = buildPositions(nodes);

    const indices = buildIndices(gmsh, options.dimension, tagToIndex);

    gmsh.write(outPath);
    const mshText = gmsh.FS.readFile(outPath, { encoding: "utf8" }) as string;

    return {
      positions,
      indices,
      nodeCount: nodes.nodeTags.length,
      elementCount: countElements(gmsh, options.dimension),
      mshText,
    };
  } finally {
    if (tmpPath) {
      try { gmsh.FS.unlink(tmpPath); } catch { /* ignore */ }
    }
    try { gmsh.FS.unlink(outPath); } catch { /* ignore */ }
  }
}

/**
 * Same geometry-import + options setup as `generateMesh`, but writes the
 * model's unrolled `.geo` script instead of meshing — lets Export offer a
 * `.geo_unrolled` target without a second host round trip.
 */
export async function exportGeoUnrolled(
  extensionPath: string,
  input: MeshGenerationInput,
  options: MeshOptions
): Promise<string> {
  const gmsh = await getGmsh(extensionPath);

  const outPath = "/out.geo_unrolled";
  let tmpPath: string | null = null;
  try {
    tmpPath = loadGeometryAndApplyOptions(gmsh, input, options);

    gmsh.write(outPath);
    return gmsh.FS.readFile(outPath, { encoding: "utf8" }) as string;
  } finally {
    if (tmpPath) {
      try { gmsh.FS.unlink(tmpPath); } catch { /* ignore */ }
    }
    try { gmsh.FS.unlink(outPath); } catch { /* ignore */ }
  }
}

/**
 * Compacts GMSH's (1-based, possibly non-contiguous) node tags into a dense
 * `positions` Float32Array plus a tag→array-index map, so downstream index
 * buffers can be plain 0-based indices into `positions` rather than raw tags.
 */
function buildPositions(nodes: { nodeTags: number[]; coord: number[] }): {
  positions: Float32Array;
  tagToIndex: Map<number, number>;
} {
  const { nodeTags, coord } = nodes;
  const positions = new Float32Array(nodeTags.length * 3);
  const tagToIndex = new Map<number, number>();
  for (let i = 0; i < nodeTags.length; i++) {
    tagToIndex.set(nodeTags[i], i);
    positions[i * 3] = coord[i * 3];
    positions[i * 3 + 1] = coord[i * 3 + 1];
    positions[i * 3 + 2] = coord[i * 3 + 2];
  }
  return { positions, tagToIndex };
}

/**
 * Builds the display triangulation's index buffer for the given mesh
 * `dimension`:
 * - `1`: no triangle exists for a line mesh; return an empty buffer.
 * - `2`: the generated type-2 (3-node triangle) elements are already the
 *   surface triangulation — remap their node tags to compacted indices directly.
 * - `3`: derive the boundary surface from the volume mesh by enumerating each
 *   tetrahedron's 4 triangular faces (by node tags), keying each face by its
 *   3 node tags *sorted* (an order-independent identity so a face shared by
 *   two adjacent tets collides to the same key regardless of which tet's local
 *   winding produced it), and keeping only faces that occur in exactly one
 *   tet — a face shared by two tets is interior and both copies are dropped.
 *   The kept triangle's *unsorted* (original) winding from its owning tet's
 *   local face definition is preserved in the output so normals stay outward.
 */
function buildIndices(gmsh: GmshApi, dimension: MeshOptions["dimension"], tagToIndex: Map<number, number>): Uint32Array {
  if (dimension === 1) {
    return new Uint32Array(0);
  }

  if (dimension === 2) {
    const els = gmsh.model.mesh.getElements(2) as { elementTypes: number[]; nodeTags: number[][] };
    const triType = els.elementTypes.indexOf(2); // 2 == 3-node triangle
    if (triType < 0) return new Uint32Array(0);
    const triNodeTags = els.nodeTags[triType];
    const out = new Uint32Array(triNodeTags.length);
    for (let i = 0; i < triNodeTags.length; i++) {
      out[i] = tagToIndex.get(triNodeTags[i]) ?? 0;
    }
    return out;
  }

  // dimension === 3: extract the boundary triangles of the tetrahedral mesh.
  const els = gmsh.model.mesh.getElements(3) as { elementTypes: number[]; nodeTags: number[][] };
  const tetType = els.elementTypes.indexOf(4); // 4 == 4-node tetrahedron
  if (tetType < 0) return new Uint32Array(0);
  const tetNodeTags = els.nodeTags[tetType];

  // The 4 triangular faces of a tet [a, b, c, d], each face's local winding
  // chosen so that, for a positively-oriented tet, all 4 faces' normals point
  // outward (standard tet face enumeration).
  const FACES = [
    [0, 1, 2],
    [0, 1, 3],
    [1, 2, 3],
    [0, 2, 3],
  ];

  // key (sorted tags, order-independent) -> { winding (original tags), seenCount }
  const faceMap = new Map<string, { winding: [number, number, number]; count: number }>();

  const numTets = tetNodeTags.length / 4;
  for (let t = 0; t < numTets; t++) {
    const base = t * 4;
    const tet = [tetNodeTags[base], tetNodeTags[base + 1], tetNodeTags[base + 2], tetNodeTags[base + 3]];
    for (const [i0, i1, i2] of FACES) {
      const a = tet[i0];
      const b = tet[i1];
      const c = tet[i2];
      const sorted = [a, b, c].sort((x, y) => x - y);
      const key = `${sorted[0]}_${sorted[1]}_${sorted[2]}`;
      const existing = faceMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        faceMap.set(key, { winding: [a, b, c], count: 1 });
      }
    }
  }

  const boundaryTris: number[] = [];
  for (const { winding, count } of faceMap.values()) {
    if (count === 1) {
      boundaryTris.push(
        tagToIndex.get(winding[0]) ?? 0,
        tagToIndex.get(winding[1]) ?? 0,
        tagToIndex.get(winding[2]) ?? 0
      );
    }
  }
  return new Uint32Array(boundaryTris);
}

/** Total element count across all element types for `getElements(dim)`. */
function countElements(gmsh: GmshApi, dimension: MeshOptions["dimension"]): number {
  const dim = dimension === 1 ? 1 : dimension;
  const els = gmsh.model.mesh.getElements(dim) as { elementTags: number[][] };
  let total = 0;
  for (const tags of els.elementTags) total += tags.length;
  return total;
}
