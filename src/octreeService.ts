import { getMeshio, wrapMeshioFault } from "./meshioService";
import { getOcct, readShape, wrapOcctFault } from "./occtService";
import { tessellateByGroup } from "./meshExtract";
import { TESSELLATION_PRESETS } from "./tessellationQuality";
import { weldTriangleSoup, weldedMeshToStlBytes } from "./meshComponents";
import type { OctreeStats, OctreeTransition } from "./meshOptions";

export type { OctreeStats };

// meshio++ `octree` as a third volume engine (`MeshOptions.engine: "octree"`):
// a tessellated skin goes in, a conforming hex-dominant volume (hexahedra,
// pyramids and tetrahedra) comes out. It runs on the meshio++ singleton
// (`getMeshio`), so a WASM abort resets THAT kernel through `wrapMeshioFault`
// — no new singleton, no new `Pipeline` function. `gmshService.ts`'s
// `populateMeshedModel` merges the MSH 4.1 text this module builds, exactly
// as it does for fTetWild, so every downstream reader works unchanged.
//
// Fixed on purpose (probe `scripts/probe/examples/meshio-octree.ts`):
// `transition` is `"templates"` (conforming hex/pyramid/tet) or `"hanging"`
// (all hexahedra, hanging nodes left in place — tied by MPCs downstream, see
// `hangingConstraints.ts`; probe `meshio-octree-hanging.ts`) — `"polyhedra"`
// emits `polyhedron` blocks the MDPA writer refuses; `balance: "face"`,
// `fill: "inside"`. **Never call
// `extractSkin` on the result**: it faults ("memory access out of bounds") on
// a level-5 bull mesh. Node order already matches Gmsh's reference cells
// (probe `meshio-octree-orientation.ts`: every hex/pyramid/tet of block.stp
// and bull.stp has positive Jacobian in Gmsh's convention), so no reorder.

export interface OctreeParams {
  /** Deepest refinement level (root cells split `maxLevel` times near the skin). */
  maxLevel: number;
  /** Move leaf nodes onto the skin; refused snaps are counted, never forced.
   * Ignored under `transition: "hanging"` (see {@link octreeEffectiveSnap}). */
  snap: boolean;
  /** Default `"templates"`. */
  transition?: OctreeTransition;
}

/**
 * The snap an octree run actually applies. A snapped hanging node leaves its
 * parent edge or face, so its constraint no longer reproduces a linear field
 * (probe: `bull.stp` at level 6 loses 95 of 3038 nodes to the geometric
 * recovery and the rest reproduce only to ~1e-8, against 1e-14 unsnapped) —
 * the hanging transition therefore always runs unsnapped.
 */
export function octreeEffectiveSnap(params: Pick<OctreeParams, "snap" | "transition">): boolean {
  return params.transition === "hanging" ? false : params.snap;
}

/** One cell block of an octree result, in meshio++'s own vocabulary. */
export interface OctreeBlock {
  type: string;
  data: ArrayLike<number | bigint>;
}


export interface OctreeResult {
  mshText: string;
  stats: OctreeStats;
}

/** meshio++ cell type -> [Gmsh element type, nodes per cell, mix key]. */
const OCTREE_CELLS: Record<string, { gmshType: number; nodes: number; mix: keyof OctreeStats["elementMix"] }> = {
  tetra: { gmshType: 4, nodes: 4, mix: "tetrahedra" },
  hexahedron: { gmshType: 5, nodes: 8, mix: "hexahedra" },
  pyramid: { gmshType: 7, nodes: 5, mix: "pyramids" },
};

/**
 * Serializes an octree mesh to ASCII MSH 4.1 — pure, WASM-free. One element
 * block per cell class, ALL on the one volume entity (dim 3, tag 1): an MSH
 * file with no `$Entities` section only lets `gmsh.merge` create entity 1, so
 * a block on entity 2 fails with "Unknown entity 2 of dimension 3" (verified
 * live). Node and element tags are 1-based and sequential across blocks. A block of a type the
 * `templates` transition does not produce (`polyhedron`, 2-D cells) throws:
 * silently dropping it would hand back a mesh with a hole in it.
 */
export function octreeToMsh41(points: ArrayLike<number>, blocks: readonly OctreeBlock[]): string {
  const nodeCount = Math.floor(points.length / 3);
  const used = blocks.filter((b) => b.data.length > 0);
  for (const b of used) {
    if (!OCTREE_CELLS[b.type]) {
      throw new Error(
        `octree produced a "${b.type}" block, which the "templates" and "hanging" transitions never emit — refusing to drop it silently.`
      );
    }
  }
  const lines: string[] = ["$MeshFormat", "4.1 0 8", "$EndMeshFormat", "$Nodes"];
  if (nodeCount > 0) {
    lines.push(`1 ${nodeCount} 1 ${nodeCount}`);
    lines.push(`3 1 0 ${nodeCount}`);
    for (let i = 1; i <= nodeCount; i++) lines.push(String(i));
    for (let i = 0; i < nodeCount; i++) lines.push(`${points[i * 3]} ${points[i * 3 + 1]} ${points[i * 3 + 2]}`);
  } else {
    lines.push("0 0 0 0");
  }
  lines.push("$EndNodes", "$Elements");
  const perBlock = used.map((b) => Math.floor(b.data.length / OCTREE_CELLS[b.type].nodes));
  const total = perBlock.reduce((a, c) => a + c, 0);
  if (total > 0) {
    lines.push(`${used.length} ${total} 1 ${total}`);
    let next = 1;
    used.forEach((b, k) => {
      const { gmshType, nodes } = OCTREE_CELLS[b.type];
      lines.push(`3 1 ${gmshType} ${perBlock[k]}`);
      for (let c = 0; c < perBlock[k]; c++) {
        const row: number[] = [next++];
        // meshio++ ≥ 11.2 hands integer arrays back as BigInt64Array.
        for (let j = 0; j < nodes; j++) row.push(Number(b.data[c * nodes + j]) + 1);
        lines.push(row.join(" "));
      }
    });
  } else {
    lines.push("0 0 0 0");
  }
  lines.push("$EndElements", "");
  return lines.join("\n");
}

/** Counts each supported cell class of an octree result. */
export function octreeElementMix(blocks: readonly OctreeBlock[]): OctreeStats["elementMix"] {
  const mix = { hexahedra: 0, pyramids: 0, tetrahedra: 0 };
  for (const b of blocks) {
    const cell = OCTREE_CELLS[b.type];
    if (cell) mix[cell.mix] += Math.floor(b.data.length / cell.nodes);
  }
  return mix;
}

/**
 * Runs meshio++'s `octree` over an STL skin and returns the MSH 4.1 text plus
 * the facts the report carries. Throws a plain error for an empty/degenerate
 * skin or a tree beyond meshio++'s own `maxCells` (neither resets the kernel);
 * a WASM abort resets the meshio++ singleton via `wrapMeshioFault`.
 */
export async function octreeMesh(stlBytes: Uint8Array, params: OctreeParams): Promise<OctreeResult> {
  const m = await getMeshio();
  const transition: OctreeTransition = params.transition ?? "templates";
  const snap = octreeEffectiveSnap(params);
  // ≤10-char MEMFS path, like every other staged meshio++ file.
  const path = "/oct.stl";
  m.FS.writeFile(path, stlBytes);
  try {
    const skin = m.readMesh(path, "stl");
    const r = m.octree(
      skin, null, 0, params.maxLevel, null, undefined, undefined, 3, undefined,
      "face", "inside", undefined, undefined, undefined, undefined, undefined, transition, snap
    );
    const blocks = r.mesh.cells as OctreeBlock[];
    const elementMix = octreeElementMix(blocks);
    if (elementMix.hexahedra + elementMix.pyramids + elementMix.tetrahedra === 0) {
      throw new Error(
        "octree produced no cells — the skin may be open, degenerate or smaller than one leaf at this level; try a higher maxLevel or check the mesh's health."
      );
    }
    return {
      mshText: octreeToMsh41(r.mesh.points as ArrayLike<number>, blocks),
      stats: {
        maxLevel: params.maxLevel,
        snap,
        transition,
        numLeaves: r.numLeaves,
        numHanging: r.numHanging,
        finestLevel: r.finestLevel,
        numSnapped: r.numSnapped,
        numRefused: r.numRefused,
        elementMix,
      },
    };
  } catch (err) {
    throw wrapMeshioFault(err);
  } finally {
    try {
      m.FS.unlink(path);
    } catch {
      /* ignore */
    }
  }
}

/**
 * The octree's skin for a B-rep source: the STEP bytes `exportBRep` produced
 * (edits already applied), tessellated with the `fine` preset on host OCCT and
 * welded into an STL — the probe's route. Per-file OCCT objects are deleted in
 * reverse in `finally`; an OCCT abort resets that singleton via `wrapOcctFault`.
 */
export async function brepSkinStlBytes(extensionPath: string, stepBytes: Uint8Array): Promise<Uint8Array> {
  const oc = await getOcct(extensionPath);
  const tmp = "/oc.step";
  oc.FS.writeFile(tmp, stepBytes);
  const cleanup: Array<{ delete(): void }> = [];
  try {
    const shape = readShape(oc, tmp, "step", cleanup);
    const soup: number[] = [];
    for (const g of tessellateByGroup(oc, shape, TESSELLATION_PRESETS.fine)) {
      for (const f of g.faces) {
        const p = f.buffers.positions;
        const ix = f.buffers.indices;
        for (let t = 0; t < ix.length; t++) soup.push(p[ix[t] * 3], p[ix[t] * 3 + 1], p[ix[t] * 3 + 2]);
      }
    }
    if (soup.length === 0) throw new Error("octree: the B-rep tessellated to no triangles.");
    return weldedMeshToStlBytes(weldTriangleSoup(new Float32Array(soup)));
  } catch (err) {
    throw wrapOcctFault(err);
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try {
        cleanup[i].delete();
      } catch {
        /* ignore */
      }
    }
    try {
      oc.FS.unlink(tmp);
    } catch {
      /* ignore */
    }
  }
}
