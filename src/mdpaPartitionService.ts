import { getMeshio, wrapMeshioFault } from "./meshioService";
import { MDPA_PARTITION_SEED, type PartitionInput } from "./mdpaPartition";
import type { MdpaPartitionMethod } from "./meshOptions";

// The meshio++ half of a partitioned MDPA export. It runs on the meshio++
// singleton, so a WASM abort resets THAT kernel through `wrapMeshioFault` and
// no new singleton exists. Call shape probed live (`scripts/probe/examples/
// mdpa-partition.ts`): `partitionLabels(mesh, nparts, method, imbalance, mode,
// seed)` returns one block-aligned `Int32Array` per cell block; a rectangular
// block needs `nodesPerCell`; asking for more parts than cells does NOT throw
// (it leaves parts empty), so the caller refuses that up front.

/** Allowed deviation from perfectly equal part sizes (KaHIP's `imbalance`). */
const PARTITION_IMBALANCE = 0.03;

export interface PartitionLabels {
  /** One array per input block, values in `[0, ranks)`. */
  labels: number[][];
  /** What partitioned: `auto` resolves to KaHIP when it is linked, else SFC. */
  methodUsed: "kahip" | "sfc";
}

/**
 * Labels every domain cell with a rank. Only the domain-cell blocks are passed:
 * KaHIP given the whole `Mesh.SaveAll` mesh partitions the graph of its vertex,
 * line and triangle blocks too and returns ~1.8x unbalanced parts.
 */
export async function partitionVolumeCells(input: PartitionInput, ranks: number, method: MdpaPartitionMethod): Promise<PartitionLabels> {
  try {
    const m = await getMeshio();
    const hasKahip = m.hasKahip();
    if (method === "kahip" && !hasKahip) {
      throw new Error("KaHIP is not linked into this meshio++ build — use partition method \"sfc\" or \"auto\".");
    }
    const methodUsed = method === "sfc" || (method === "auto" && !hasKahip) ? "sfc" : "kahip";
    const mesh = {
      points: input.points,
      dim: 3,
      cells: input.blocks.map((b) => ({ type: b.type, data: b.data, nodesPerCell: b.nodesPerCell })),
    };
    const raw = m.partitionLabels(mesh, ranks, methodUsed, PARTITION_IMBALANCE, "eco", MDPA_PARTITION_SEED) as ArrayLike<number | bigint>[];
    return { labels: raw.map((l) => Array.from(l as ArrayLike<number | bigint>, Number)), methodUsed };
  } catch (err) {
    throw wrapMeshioFault(err);
  }
}
