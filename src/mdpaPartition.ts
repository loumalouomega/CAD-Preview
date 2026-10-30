/**
 * Pure planning for a partitioned Kratos MDPA export (one `.mdpa` per MPI rank).
 * vscode/WASM-free so it unit-tests headless: the meshio++ call that produces
 * the per-cell labels lives in `meshioService.ts` (`partitionVolumeCells`), the
 * orchestration in `gmshService.ts` (`exportMdpaPartitioned`).
 *
 * Only the DOMAIN cells (`MdpaMesh.volumeCells`) are handed to the partitioner.
 * A graph partitioner given the whole `Mesh.SaveAll` mesh — vertex, line and
 * triangle blocks beside the tetrahedra — partitions the graph of all those
 * cells and comes back ~1.8× unbalanced with empty parts (measured, KaHIP on
 * `bull.stp`), so balance is also reported over domain cells alone.
 *
 * Node and cell ids stay GLOBAL: they are assigned once over the whole mesh by
 * `writeMdpa` and each rank file is a filtered view of that numbering, so
 * "node 417" names the same node in every file that lists it.
 *
 * The layout is NOT Kratos' native pre-partitioned one (`CommunicatorData`,
 * `NEIGHBOURS_INDICES`, `LOCAL_MESH`/`GHOST_MESH`/`INTERFACE_MESH`): each rank
 * file is a plain MDPA holding its own cells plus an `InterfaceNodes`
 * SubModelPart, and the neighbour lists live in the manifest.
 */

import { MDPA_KIND_INFO, cellBoundaryRings, type MdpaCellKind } from "./gmshElementTypes";
import type { MdpaPartitionMethod } from "./meshOptions";
import { writeMdpa, mdpaNodeIds, type MdpaMesh, type MdpaMode, type MdpaRankView } from "./mdpaWriter";

/** Seed handed to KaHIP so the same mesh always partitions the same way. */
export const MDPA_PARTITION_SEED = 1;

const MESHIO_CELL_TYPE: Readonly<Partial<Record<MdpaCellKind, string>>> = {
  tet4: "tetra",
  tet10: "tetra",
  pyramid5: "pyramid",
  pyramid13: "pyramid",
  prism6: "wedge",
  prism15: "wedge",
  hex8: "hexahedron",
  hex20: "hexahedron",
  hex27: "hexahedron",
  tri3: "triangle",
  tri6: "triangle",
  quad4: "quad",
  quad8: "quad",
  quad9: "quad",
};

/** One homogeneous block of the mesh handed to meshio++ (corner nodes only). */
export interface PartitionInputBlock {
  type: string;
  nodesPerCell: number;
  data: Int32Array;
  /** Index into `MdpaMesh.volumeCells` of each cell in this block, in order. */
  cellIndices: number[];
}

export interface PartitionInput {
  points: Float64Array;
  blocks: PartitionInputBlock[];
}

/**
 * The domain cells as a plain meshio++-shaped mesh. Quadratic cells contribute
 * their corners only: the partition is a property of the cell graph, and the
 * mid-side nodes follow their cell.
 */
export function buildPartitionInput(mesh: MdpaMesh): PartitionInput {
  const index = new Map<number, number>();
  const points = new Float64Array(mesh.nodes.length * 3);
  mesh.nodes.forEach((n, i) => {
    index.set(n.tag, i);
    points[i * 3] = n.x;
    points[i * 3 + 1] = n.y;
    points[i * 3 + 2] = n.z;
  });
  const byType = new Map<string, { nodesPerCell: number; data: number[]; cellIndices: number[] }>();
  mesh.volumeCells.forEach((cell, i) => {
    const type = MESHIO_CELL_TYPE[cell.kind];
    if (!type) throw new Error(`Partitioned MDPA export: no meshio++ cell type for a ${cell.kind} domain cell.`);
    const corners = MDPA_KIND_INFO[cell.kind].numCorners;
    let block = byType.get(type);
    if (!block) byType.set(type, (block = { nodesPerCell: corners, data: [], cellIndices: [] }));
    for (let c = 0; c < corners; c++) block.data.push(index.get(cell.nodeTags[c])!);
    block.cellIndices.push(i);
  });
  const blocks = [...byType].map(([type, b]) => ({
    type,
    nodesPerCell: b.nodesPerCell,
    data: Int32Array.from(b.data),
    cellIndices: b.cellIndices,
  }));
  return { points, blocks };
}

/** Folds meshio++'s block-aligned labels back to one rank per `volumeCells` entry. */
export function cellRankFromLabels(input: PartitionInput, labels: ReadonlyArray<ArrayLike<number>>, cellCount: number, ranks: number): number[] {
  if (labels.length !== input.blocks.length) {
    throw new Error(`Partitioner returned ${labels.length} label blocks for ${input.blocks.length} cell blocks.`);
  }
  const cellRank = new Array<number>(cellCount).fill(-1);
  input.blocks.forEach((block, b) => {
    if (labels[b].length !== block.cellIndices.length) {
      throw new Error(`Partitioner returned ${labels[b].length} labels for ${block.cellIndices.length} ${block.type} cells.`);
    }
    block.cellIndices.forEach((cellIndex, k) => {
      const rank = Number(labels[b][k]);
      if (!Number.isInteger(rank) || rank < 0 || rank >= ranks) throw new Error(`Partitioner returned rank ${rank} for ${ranks} ranks.`);
      cellRank[cellIndex] = rank;
    });
  });
  return cellRank;
}

export interface PartitionPlan {
  ranks: number;
  /** Rank of each `MdpaMesh.volumeCells` entry. */
  cellRank: number[];
  /** Rank of each `MdpaMesh.surfaceCells` entry (its parent domain cell's). */
  surfaceRank: number[];
  /** Per rank: the node TAGS it shares with at least one other rank. */
  interfaceNodeTags: Set<number>[];
  /** Per node tag: every rank whose domain cells use it. */
  nodeRanks: Map<number, Set<number>>;
  /** Boundary cells with no parent domain cell, parked on a rank holding all their nodes (or 0). */
  orphanSurfaceCells: number;
}

const tagKey = (tags: readonly number[]): string => [...tags].sort((a, b) => a - b).join(",");

/**
 * Derives everything a rank file needs from the domain labels: which rank owns
 * each boundary cell and which nodes sit on a rank interface. A boundary cell
 * follows its parent domain cell (matched by the sorted corner tags of a face,
 * or of an edge in 2-D; the lowest-index parent when two cells share it), so a
 * face on a rank interface lands in exactly one file.
 */
export function planPartition(mesh: MdpaMesh, cellRank: number[], ranks: number): PartitionPlan {
  const nodeRanks = new Map<number, Set<number>>();
  const faceOwner = new Map<string, number>();
  mesh.volumeCells.forEach((cell, i) => {
    const rank = cellRank[i];
    for (const tag of cell.nodeTags) {
      let set = nodeRanks.get(tag);
      if (!set) nodeRanks.set(tag, (set = new Set()));
      set.add(rank);
    }
    for (const ring of cellBoundaryRings(cell.kind)) {
      const key = tagKey(ring.map((j) => cell.nodeTags[j]));
      if (!faceOwner.has(key)) faceOwner.set(key, i);
    }
  });

  let orphanSurfaceCells = 0;
  const surfaceRank = mesh.surfaceCells.map((cell) => {
    const corners = cell.nodeTags.slice(0, MDPA_KIND_INFO[cell.kind].numCorners);
    const parent = faceOwner.get(tagKey(corners));
    if (parent !== undefined) return cellRank[parent];
    orphanSurfaceCells++;
    for (let r = 0; r < ranks; r++) if (corners.every((t) => nodeRanks.get(t)?.has(r))) return r;
    return 0;
  });

  const interfaceNodeTags: Set<number>[] = Array.from({ length: ranks }, () => new Set<number>());
  for (const [tag, set] of nodeRanks) {
    if (set.size > 1) for (const r of set) interfaceNodeTags[r].add(tag);
  }
  return { ranks, cellRank, surfaceRank, interfaceNodeTags, nodeRanks, orphanSurfaceCells };
}

/** One rank's row in the manifest: counts, and who it shares nodes with (output node ids). */
export interface PartitionRankReport {
  rank: number;
  file: string;
  volumeCells: number;
  surfaceCells: number;
  nodes: number;
  interfaceNodes: number;
  neighbours: Array<{ rank: number; sharedNodeIds: number[] }>;
}

/** Facts about one partitioned export. No verdict: the caller decides what balance is good enough. */
export interface PartitionReport {
  ranks: number;
  /** What was asked for. */
  method: MdpaPartitionMethod;
  /** What actually partitioned (`auto` resolves to KaHIP when linked, else SFC). */
  methodUsed: "kahip" | "sfc";
  seed: number;
  volumeCells: number;
  /** Largest rank's domain-cell count over the mean. 1 is perfect. */
  balanceMaxOverMean: number;
  /** Ranks that received no domain cell (their file is empty). */
  emptyRanks: number[];
  /** Nodes used by more than one rank, and their share of all domain nodes. */
  interfaceNodes: number;
  interfaceFraction: number;
  orphanSurfaceCells: number;
  perRank: PartitionRankReport[];
}

/** Stem + `_<rank>.mdpa`: Kratos' own per-rank suffix convention. */
export function rankFileName(stem: string, rank: number): string {
  return `${stem}_${rank}.mdpa`;
}

export function partitionReport(
  mesh: MdpaMesh,
  plan: PartitionPlan,
  info: { method: MdpaPartitionMethod; methodUsed: "kahip" | "sfc"; seed: number; stem: string }
): PartitionReport {
  const ids = mdpaNodeIds(mesh.nodes);
  const volumeCounts = new Array<number>(plan.ranks).fill(0);
  for (const r of plan.cellRank) volumeCounts[r]++;
  const surfaceCounts = new Array<number>(plan.ranks).fill(0);
  for (const r of plan.surfaceRank) surfaceCounts[r]++;
  const rankNodes = new Array<number>(plan.ranks).fill(0);
  for (const set of plan.nodeRanks.values()) for (const r of set) rankNodes[r]++;

  const shared = Array.from({ length: plan.ranks }, () => new Map<number, number[]>());
  for (const [tag, set] of plan.nodeRanks) {
    if (set.size < 2) continue;
    const id = ids.get(tag)!;
    for (const a of set) {
      for (const b of set) {
        if (a === b) continue;
        let list = shared[a].get(b);
        if (!list) shared[a].set(b, (list = []));
        list.push(id);
      }
    }
  }
  const perRank: PartitionRankReport[] = volumeCounts.map((volumeCells, rank) => ({
    rank,
    file: rankFileName(info.stem, rank),
    volumeCells,
    surfaceCells: surfaceCounts[rank],
    nodes: rankNodes[rank],
    interfaceNodes: plan.interfaceNodeTags[rank].size,
    neighbours: [...shared[rank]]
      .sort((x, y) => x[0] - y[0])
      .map(([neighbour, list]) => ({ rank: neighbour, sharedNodeIds: list.sort((x, y) => x - y) })),
  }));
  const total = volumeCounts.reduce((a, b) => a + b, 0);
  const mean = total / plan.ranks;
  const sharedNodes = [...plan.nodeRanks.values()].filter((s) => s.size > 1).length;
  return {
    ranks: plan.ranks,
    method: info.method,
    methodUsed: info.methodUsed,
    seed: info.seed,
    volumeCells: total,
    balanceMaxOverMean: mean > 0 ? Math.max(...volumeCounts) / mean : 0,
    emptyRanks: volumeCounts.flatMap((n, r) => (n === 0 ? [r] : [])),
    interfaceNodes: sharedNodes,
    interfaceFraction: plan.nodeRanks.size > 0 ? sharedNodes / plan.nodeRanks.size : 0,
    orphanSurfaceCells: plan.orphanSurfaceCells,
    perRank,
  };
}

/** The writer's view of one rank. */
export function rankView(plan: PartitionPlan, rank: number): MdpaRankView {
  return {
    rank,
    ranks: plan.ranks,
    cellRank: plan.cellRank,
    surfaceRank: plan.surfaceRank,
    interfaceNodeTags: plan.interfaceNodeTags[rank],
  };
}

/** One MDPA text per rank, global ids throughout. */
export function writePartitionedMdpa(mesh: MdpaMesh, mode: MdpaMode, plan: PartitionPlan, onWarning?: (msg: string) => void): string[] {
  return Array.from({ length: plan.ranks }, (_, rank) => writeMdpa(mesh, mode, onWarning, rankView(plan, rank)));
}

export const HANGING_PARTITION_REFUSAL =
  'A partitioned MDPA export cannot carry hanging-node constraints: a constraint ties nodes the partition would place on different ranks. Export with octreeTransition "templates", or export a single file (mdpaRanks 1).';

/**
 * Refusals decided once the domain mesh exists: a request this path can never
 * honour is named, not ignored. Returns the message, or undefined when the
 * export may go.
 */
export function partitionRefusal(mesh: Pick<MdpaMesh, "volumeCells" | "constraints">, ranks: number): string | undefined {
  if (ranks <= 1) return undefined;
  if ((mesh.constraints?.length ?? 0) > 0) return HANGING_PARTITION_REFUSAL;
  const n = mesh.volumeCells.length;
  if (ranks > n) return `Cannot partition ${n} domain cell${n === 1 ? "" : "s"} into ${ranks} ranks — ask for at most ${n}.`;
  return undefined;
}

/** Manifest file name beside the rank files: `<stem>.partition.json`. */
export function partitionManifestName(stem: string): string {
  return `${stem}.partition.json`;
}

/** Said in the manifest and in every export result: the layout is not Kratos' own pre-partitioned one. */
export const PARTITION_LAYOUT_NOTE =
  "Each rank file is a plain MDPA with global node and cell ids and an InterfaceNodes SubModelPart; it does not carry Kratos' CommunicatorData (NEIGHBOURS_INDICES / LOCAL_MESH / GHOST_MESH / INTERFACE_MESH) blocks. The neighbour lists are in this manifest. No Kratos reader has been run against these files.";

/** The `<stem>.partition.json` text. Facts only; the reader decides what balance is good enough. */
export function partitionManifestJson(report: PartitionReport, info: { source: string; format: string }): string {
  return JSON.stringify({ version: 1, source: info.source, format: info.format, layout: PARTITION_LAYOUT_NOTE, ...report }, null, 2) + "\n";
}

/** Things worth saying to the caller about one split. */
export function partitionWarnings(report: PartitionReport): string[] {
  const out: string[] = [];
  if (report.emptyRanks.length > 0) {
    out.push(`Rank${report.emptyRanks.length === 1 ? "" : "s"} ${report.emptyRanks.join(", ")} received no domain cell, so ${report.emptyRanks.length === 1 ? "its file is" : "their files are"} empty — ask for fewer ranks.`);
  }
  if (report.orphanSurfaceCells > 0) {
    out.push(`${report.orphanSurfaceCells} boundary cell${report.orphanSurfaceCells === 1 ? "" : "s"} had no parent domain cell and was placed on a rank holding all its nodes.`);
  }
  return out;
}
