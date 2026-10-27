/**
 * Hand-written Kratos MDPA (`.mdpa`) ASCII serializer. Pure and vscode/WASM-free
 * so it unit-tests headless, mirroring `partsSidecar.ts`/`editOps.ts`/
 * `meshOptionsSidecar.ts`'s "pure logic module" convention — the WASM-dependent
 * extraction of `MdpaMesh` from a live gmsh model lives in `gmshService.ts`.
 *
 * MDPA has no off-the-shelf writer in any of this project's dependencies (unlike
 * every other mesh export format, which routes through Gmsh's own `gmsh.write()`)
 * — see `doc/gmsh-integration.md`'s "Kratos MDPA" section for the full spec
 * citations (block syntax, node ordering) this module was built against.
 *
 * Handles the full cell catalogue of {@link MdpaCellKind} — linear and quadratic
 * tetrahedra, hexahedra, prisms, pyramids (volume) and triangles, quadrilaterals
 * (surface) — via the shared `gmshElementTypes.ts` table, which supplies each
 * kind's Kratos block names and node counts. Callers must pass cells whose
 * `nodeTags` are already in **Kratos node order** (`gmshService.ts` applies the
 * gmsh→Kratos permutation during extraction).
 */

import {
  MDPA_KIND_INFO,
  VOLUME_KIND_ORDER,
  SURFACE_KIND_ORDER,
  LINE_KIND_ORDER,
  signedVolume,
  type MdpaCellKind,
} from "./gmshElementTypes";
import { DEFAULT_MPC_VARIABLES, type MpcConstraint } from "./hangingConstraints";

export type MdpaMode = "elements" | "geometries";

export interface MdpaNode {
  /** Opaque source id (e.g. a gmsh node tag) — need not be 1-based or contiguous. */
  tag: number;
  x: number;
  y: number;
  z: number;
}

/** One finite element / condition / geometry. `nodeTags` are source node tags in
 *  **Kratos** node order (length must equal `MDPA_KIND_INFO[kind].numNodes`). */
export interface MdpaCell {
  kind: MdpaCellKind;
  nodeTags: number[];
}

/** One named region (from a CAD-Preview `Part`) to emit as a Kratos SubModelPart. */
export interface MdpaGroup {
  name: string;
  /** Indices into {@link MdpaMesh.volumeCells}. */
  volumeCellIndices: number[];
  /** Indices into {@link MdpaMesh.surfaceCells}. */
  surfaceCellIndices: number[];
  /** Node tags from the part's own point/curve selections, beyond what its
   * cells already reference — see the node-consistency rule below. */
  extraNodeTags: number[];
}

export interface MdpaMesh {
  /** Topological mesh dimension; defaults to 3 for existing callers. */
  dimension?: 2 | 3;
  nodes: MdpaNode[];
  /** Domain cells (2D or 3D) → `Elements` (elements mode) or volume `Geometries` (geometries mode). */
  volumeCells: MdpaCell[];
  /** Boundary cells (1D or 2D) → `Conditions` (elements mode) or surface `Geometries` (geometries mode). */
  surfaceCells: MdpaCell[];
  /** Flat — this codebase's `Part[]` has no nesting concept. */
  groups: MdpaGroup[];
  /** Hanging-node multi-point constraints (node TAGS, like `nodeTags`): written
   * as `LinearMasterSlaveConstraint` blocks after the cells and listed in a
   * `HangingNodes` SubModelPart plus every Part that holds all their nodes. */
  constraints?: MpcConstraint[];
  /** Variables each constraint is tied on (one block per variable and master
   * count). Defaults to the three displacement components. */
  constraintVariables?: readonly string[];
}

/** Name of the SubModelPart that owns every generated constraint. */
export const HANGING_NODES_PART = "HangingNodes";

interface Coord {
  x: number;
  y: number;
  z: number;
}

/**
 * Serializes `mesh` to MDPA ASCII text. `"elements"` writes one `Element*`
 * block per volume kind (each cell carrying a `prop_id`, always `0` — this
 * codebase has no material/property data) under a `Begin Properties 0` block,
 * plus one `Condition*` block per surface kind; `"geometries"` writes
 * `Geometries` blocks instead (no property id) which, per Kratos's single
 * `Geometries` container, **share one id space** across every kind.
 *
 * Deterministic: node ids by source `tag` ascending; cell ids by each cell's
 * own (renumbered) node-id tuple ascending within a kind, kinds emitted in the
 * fixed {@link VOLUME_KIND_ORDER}/{@link SURFACE_KIND_ORDER} — so output is
 * byte-identical for the same mesh regardless of the generator's internal (not
 * contractually ordered) enumeration. An empty kind omits its block entirely.
 *
 * `onWarning` (optional) receives a message when a non-tetrahedral cell is found
 * with a negative signed volume — such cells are emitted unchanged (there is no
 * simple safe re-ordering for a hex/prism/pyramid); tetrahedra are silently
 * re-oriented instead.
 */
export function writeMdpa(mesh: MdpaMesh, mode: MdpaMode, onWarning?: (msg: string) => void): string {
  const { nodeIdOf, sortedNodes } = buildNodeIdMap(mesh.nodes);
  const coordOf = (id: number): Coord => sortedNodes[id - 1];

  // Resolve every cell to Kratos-ordered, oriented output node ids.
  const volumeResolved = mesh.volumeCells.map((c) =>
    orientCell(c.kind, c.nodeTags.map((tag) => nodeIdOf.get(tag)!), coordOf, onWarning)
  );
  const surfaceResolved = mesh.surfaceCells.map((c) => c.nodeTags.map((tag) => nodeIdOf.get(tag)!));

  // Assign ids. Elements/Conditions have separate id spaces; Geometries share one.
  const volumes = assignBlocks(
    mesh.volumeCells.map((c, i) => ({ kind: c.kind, ids: volumeResolved[i], originalIndex: i })),
    mesh.dimension === 2 ? SURFACE_KIND_ORDER : VOLUME_KIND_ORDER,
    1
  );
  const surfaceStart = mode === "geometries" ? volumes.nextId : 1;
  const surfaces = assignBlocks(
    mesh.surfaceCells.map((c, i) => ({ kind: c.kind, ids: surfaceResolved[i], originalIndex: i })),
    mesh.dimension === 2 ? LINE_KIND_ORDER : SURFACE_KIND_ORDER,
    surfaceStart
  );

  const lines: string[] = [
    "// File generated by CAD-Preview — Kratos MDPA export",
    mode === "elements" ? "// Mode: Elements + Conditions" : "// Mode: Geometries",
    "",
  ];
  if (mode === "elements") lines.push("Begin Properties 0", "End Properties", "");
  lines.push(...writeNodesBlock(sortedNodes), "");

  if (mode === "elements") {
    for (const block of volumes.blocks) {
      const name = mesh.dimension === 2 ? `Element2D${MDPA_KIND_INFO[block.kind].numNodes}N` : MDPA_KIND_INFO[block.kind].elementName!;
      lines.push(...writeCellBlock("Elements", name, block.entries, true), "");
    }
    for (const block of surfaces.blocks) {
      const name = MDPA_KIND_INFO[block.kind].conditionName!;
      lines.push(...writeCellBlock("Conditions", name, block.entries, true), "");
    }
  } else {
    for (const block of [...volumes.blocks, ...surfaces.blocks]) {
      const name = mesh.dimension === 2 ? MDPA_KIND_INFO[block.kind].geometryName.replace("3D", "2D") : MDPA_KIND_INFO[block.kind].geometryName;
      lines.push(...writeCellBlock("Geometries", name, block.entries, false), "");
    }
  }

  // Kratos resolves a constraint's node ids when the block is read and a
  // SubModelPartConstraints list when its part is read, so both come after the
  // nodes/cells and the constraints before the SubModelParts.
  const mpc = buildMpcRows(mesh, nodeIdOf);
  if (mpc) lines.push(...mpc.lines, "");

  const usedNames = new Set<string>();
  for (const group of mesh.groups) {
    const nodeIds = groupNodeIds(group, nodeIdOf, volumeResolved, surfaceResolved);
    const owned = mpc ? mpc.idsHeldBy(new Set(nodeIds)) : undefined;
    lines.push(
      ...writeSubModelPartBlock(group, mode, nodeIds, volumes.idOf, surfaces.idOf, usedNames, owned)
    );
  }
  if (mpc) lines.push(...writeHangingNodesPart(mpc, usedNames));

  return lines.join("\n").trimEnd() + "\n";
}

/** Sorts by source tag ascending and assigns dense 1-based output ids. */
function buildNodeIdMap(nodes: MdpaNode[]): { nodeIdOf: Map<number, number>; sortedNodes: MdpaNode[] } {
  const sortedNodes = [...nodes].sort((a, b) => a.tag - b.tag);
  const nodeIdOf = new Map<number, number>();
  sortedNodes.forEach((n, i) => nodeIdOf.set(n.tag, i + 1));
  return { nodeIdOf, sortedNodes };
}

const TET4_FLIP = [0, 1, 3, 2];
const TET10_FLIP = [0, 1, 3, 2, 4, 8, 7, 6, 5, 9];

/**
 * Ensures a cell has a positive Jacobian. Tetrahedra with a negative signed
 * volume are re-oriented by the appropriate corner/mid-edge swap (`TET*_FLIP`) —
 * a well-defined correction. Other volume kinds have no simple safe flip; an
 * inverted one is emitted unchanged and `onWarning` is called. Surface cells and
 * correctly-oriented cells pass through untouched.
 */
function orientCell(
  kind: MdpaCellKind,
  ids: number[],
  coordOf: (id: number) => Coord,
  onWarning?: (msg: string) => void
): number[] {
  const info = MDPA_KIND_INFO[kind];
  const corners = ids.slice(0, info.numCorners).map(coordOf);
  const vol = signedVolume(kind, corners);
  if (vol >= 0) return ids;
  if (kind === "tet4") return TET4_FLIP.map((i) => ids[i]);
  if (kind === "tet10") return TET10_FLIP.map((i) => ids[i]);
  onWarning?.(`Emitting an inverted ${kind} cell (negative signed volume) unchanged — no safe re-orientation.`);
  return ids;
}

/** Lexicographic sort key over an id tuple, zero-padded so numeric order and
 * string order agree (plain `.join()` would sort "10" before "9"). */
function canonicalCellKey(ids: readonly number[]): string {
  return ids.map((id) => id.toString().padStart(12, "0")).join("_");
}

interface CellEntry {
  id: number;
  ids: number[];
}
interface KindBlock {
  kind: MdpaCellKind;
  entries: CellEntry[];
}

/**
 * Buckets cells by kind (in `kindOrder`), assigns dense output ids from
 * `startId` continuously across the kinds, sorting within each kind by
 * {@link canonicalCellKey} — the deterministic half of {@link writeMdpa}'s
 * contract. Returns the ordered non-empty blocks, a per-original-index id map
 * (for SubModelPart cross-referencing), and the next free id.
 */
function assignBlocks(
  cells: Array<{ kind: MdpaCellKind; ids: number[]; originalIndex: number }>,
  kindOrder: readonly MdpaCellKind[],
  startId: number
): { blocks: KindBlock[]; idOf: Map<number, number>; nextId: number } {
  const byKind = new Map<MdpaCellKind, Array<{ ids: number[]; originalIndex: number }>>();
  for (const c of cells) {
    let bucket = byKind.get(c.kind);
    if (!bucket) byKind.set(c.kind, (bucket = []));
    bucket.push({ ids: c.ids, originalIndex: c.originalIndex });
  }

  const blocks: KindBlock[] = [];
  const idOf = new Map<number, number>();
  let nextId = startId;
  for (const kind of kindOrder) {
    const bucket = byKind.get(kind);
    if (!bucket || bucket.length === 0) continue;
    bucket.sort((a, b) => {
      const ka = canonicalCellKey(a.ids);
      const kb = canonicalCellKey(b.ids);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const entries: CellEntry[] = bucket.map((c) => {
      const id = nextId++;
      idOf.set(c.originalIndex, id);
      return { id, ids: c.ids };
    });
    blocks.push({ kind, entries });
  }
  return { blocks, idOf, nextId };
}

/** Scientific notation, full round-trip precision. */
function formatCoord(v: number): string {
  return v.toExponential();
}

function writeNodesBlock(sortedNodes: MdpaNode[]): string[] {
  const out = ["Begin Nodes"];
  sortedNodes.forEach((n, i) => out.push(`${i + 1} ${formatCoord(n.x)} ${formatCoord(n.y)} ${formatCoord(n.z)}`));
  out.push("End Nodes");
  return out;
}

/** Writes one `Begin <blockKeyword> <name> ... End <blockKeyword>` block. */
function writeCellBlock(
  blockKeyword: "Elements" | "Conditions" | "Geometries",
  name: string,
  entries: CellEntry[],
  withPropertyId: boolean
): string[] {
  const out = [`Begin ${blockKeyword} ${name}`];
  for (const { id, ids } of entries) {
    const conn = ids.join(" ");
    out.push(withPropertyId ? `${id} 0 ${conn}` : `${id} ${conn}`);
  }
  out.push(`End ${blockKeyword}`);
  return out;
}

/** Every node a group's SubModelPart must list: its explicit point/curve nodes
 * plus all nodes (incl. mid-side) of its cells — the node-consistency rule. */
function groupNodeIds(
  group: MdpaGroup,
  nodeIdOf: Map<number, number>,
  volumeResolved: number[][],
  surfaceResolved: number[][]
): number[] {
  const nodeIdSet = new Set<number>();
  for (const tag of group.extraNodeTags) {
    const id = nodeIdOf.get(tag);
    if (id !== undefined) nodeIdSet.add(id);
  }
  for (const i of group.volumeCellIndices) for (const id of volumeResolved[i]) nodeIdSet.add(id);
  for (const i of group.surfaceCellIndices) for (const id of surfaceResolved[i]) nodeIdSet.add(id);
  return [...nodeIdSet].sort((a, b) => a - b);
}

function writeSubModelPartBlock(
  group: MdpaGroup,
  mode: MdpaMode,
  nodeIds: number[],
  volumeIdOf: Map<number, number>,
  surfaceIdOf: Map<number, number>,
  usedNames: Set<string>,
  constraintIds?: number[]
): string[] {
  const name = sanitizeSubModelPartName(group.name, usedNames);
  const out = [`Begin SubModelPart ${name}`];

  const elementIds = group.volumeCellIndices.map((i) => volumeIdOf.get(i)!).sort((a, b) => a - b);
  const conditionIds = group.surfaceCellIndices.map((i) => surfaceIdOf.get(i)!).sort((a, b) => a - b);

  out.push("    Begin SubModelPartNodes");
  for (const id of nodeIds) out.push(`    ${id}`);
  out.push("    End SubModelPartNodes");

  if (mode === "elements") {
    out.push("    Begin SubModelPartElements");
    for (const id of elementIds) out.push(`    ${id}`);
    out.push("    End SubModelPartElements");

    out.push("    Begin SubModelPartConditions");
    for (const id of conditionIds) out.push(`    ${id}`);
    out.push("    End SubModelPartConditions");
  } else {
    // All kinds share one Geometries id space, so a group's geometry ids are the
    // union of its volume + surface cell ids.
    const geometryIds = [...elementIds, ...conditionIds].sort((a, b) => a - b);
    out.push("    Begin SubModelPartGeometries");
    for (const id of geometryIds) out.push(`    ${id}`);
    out.push("    End SubModelPartGeometries");
  }

  // Only when this part holds whole constraints: a mesh without any keeps the
  // exact bytes it always had.
  if (constraintIds && constraintIds.length > 0) {
    out.push("    Begin SubModelPartConstraints");
    for (const id of constraintIds) out.push(`    ${id}`);
    out.push("    End SubModelPartConstraints");
  }

  out.push("End SubModelPart");
  return out;
}

/** A float column as Kratos files spell it: `0.0`, `0.5`, shortest round trip
 * (no precision cut — the weights of one constraint must still sum to 1). */
function constraintNum(x: number): string {
  if (!Number.isFinite(x)) return "0.0";
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

interface MpcRows {
  lines: string[];
  /** Ids of the constraints whose slave AND masters are all in `nodeIds`. */
  idsHeldBy(nodeIds: ReadonlySet<number>): number[];
  /** Every constraint id and the nodes (output ids) it names. */
  all: Array<{ id: number; nodes: number[] }>;
}

/**
 * The `Begin Constraints` blocks for `mesh.constraints`, or undefined when there
 * are none. One block per variable and per master count — Kratos fixes the dof
 * count from the header (slave variable plus one per master, so the variable is
 * repeated) and every row must match it. Ids run 1..n across all blocks; rows
 * are ordered by slave output id so the text is deterministic.
 */
function buildMpcRows(mesh: MdpaMesh, nodeIdOf: Map<number, number>): MpcRows | undefined {
  const constraints = mesh.constraints ?? [];
  if (constraints.length === 0) return undefined;
  const variables = mesh.constraintVariables?.length ? mesh.constraintVariables : DEFAULT_MPC_VARIABLES;
  const resolved = constraints
    .map((c) => ({
      slave: nodeIdOf.get(c.slave)!,
      masters: c.masters.map((m, i) => ({ id: nodeIdOf.get(m)!, w: c.weights[i] })).sort((a, b) => a.id - b.id),
    }))
    .sort((a, b) => a.slave - b.slave);
  const counts = [...new Set(resolved.map((c) => c.masters.length))].sort((a, b) => a - b);
  const lines: string[] = [];
  const all: MpcRows["all"] = [];
  let next = 0;
  for (const variable of variables) {
    for (const count of counts) {
      const header = ["Begin Constraints LinearMasterSlaveConstraint", ...Array.from({ length: 1 + count }, () => variable)].join(" ");
      lines.push(header);
      for (const c of resolved.filter((r) => r.masters.length === count)) {
        const id = ++next;
        const weights = c.masters.map((m) => constraintNum(m.w)).join(", ");
        lines.push(`  ${id} 0.0 [${weights}] ${c.slave} ${c.masters.map((m) => m.id).join(" ")}`);
        all.push({ id, nodes: [c.slave, ...c.masters.map((m) => m.id)] });
      }
      lines.push("End Constraints", "");
    }
  }
  lines.pop(); // the caller appends the separating blank line
  return {
    lines,
    all,
    idsHeldBy: (nodeIds) => all.filter((c) => c.nodes.every((n) => nodeIds.has(n))).map((c) => c.id),
  };
}

/** The `HangingNodes` SubModelPart: every constraint and the nodes they name. */
function writeHangingNodesPart(mpc: MpcRows, usedNames: Set<string>): string[] {
  const name = sanitizeSubModelPartName(HANGING_NODES_PART, usedNames);
  const nodes = [...new Set(mpc.all.flatMap((c) => c.nodes))].sort((a, b) => a - b);
  const out = [`Begin SubModelPart ${name}`, "    Begin SubModelPartNodes"];
  for (const id of nodes) out.push(`    ${id}`);
  out.push("    End SubModelPartNodes", "    Begin SubModelPartConstraints");
  for (const c of mpc.all) out.push(`    ${c.id}`);
  out.push("    End SubModelPartConstraints", "End SubModelPart");
  return out;
}

/** Replaces anything but `[A-Za-z0-9_]` with `_`, prefixes a name that doesn't
 * start with a letter/underscore with `Part_`, and guarantees uniqueness among
 * siblings via a `_2`, `_3`, … numeric suffix. */
function sanitizeSubModelPartName(name: string, used: Set<string>): string {
  let base = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (base === "" || !/^[A-Za-z_]/.test(base)) base = `Part_${base}`;

  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix++;
  }
  used.add(candidate);
  return candidate;
}
