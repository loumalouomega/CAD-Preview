// Prism (wedge) layers over a closed triangle surface — meshio++ 17.23
// `boundaryLayer` (3-D). NOT the Gmsh 2-D `Part.meshBoundaryLayer` field.
//
// Two callers share this module:
//  * the `grow_prism_layers` tool / Surface-tools panel row: a CAD file or a
//    closed surface mesh in, a NEW layered mesh file out (`growPrismLayersModel`);
//  * the `meshcad` FE-mesh engine's `MeshOptions.prismLayers` post-pass
//    (`meshcadService.ts` calls `buildPrismCall` / `summarizePrismLayers` and
//    serializes the wedges with `wedgesToMsh41`).
//
// Verified live (probe `scripts/probe/examples/meshio-prism-project.ts`,
// meshio++ 17.23.0): the result holds one `wedge` block plus TWO triangle
// blocks (the base skin and the outer cap); wedges are positively oriented in
// Gmsh's prism node order (no permutation); the total thickness is the
// geometric series `firstHeight·(growth^n − 1)/(growth − 1)`.

import { getMeshio, wrapMeshioFault } from "./meshioService";
import { buildMeshCadCall, readCadInfo, type RawMeshCadResult } from "./meshCadSurface";
import { clean } from "./untrustedText";
import type { MeshPrismLayers, PrismLayersStats } from "./meshOptions";

export type PrismCollapse = "points" | "layers";

/** MeshOptions-level request: the subset the FE-mesh route exposes. */
export type PrismLayersSpec = MeshPrismLayers;

/** Full tool-level options. */
export interface PrismLayersOptions extends Partial<PrismLayersSpec> {
  collisionFraction?: number;
  smoothIterations?: number;
  maxShrink?: number;
  normalSmoothIterations?: number;
  frontCheck?: boolean;
}

export const PRISM_MAX_LAYERS = 1000; // = PRISM_LAYERS_LIMIT in meshOptions.ts
export const PRISM_DEFAULT_LAYERS = 3;
export const PRISM_DEFAULT_GROWTH = 1.2;

export interface PrismLayersReport extends PrismLayersStats {
  numHexahedra: number;
  numNotVisible: number;
}

/** Planned total thickness of a layer stack (pure). */
export function plannedPrismThickness(firstHeight: number, numLayers: number, growth: number): number {
  if (growth === 1) return firstHeight * numLayers;
  return (firstHeight * (Math.pow(growth, numLayers) - 1)) / (growth - 1);
}

function finiteIn(name: string, v: unknown, lo: number, hi: number, loExclusive = false): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v > hi || (loExclusive ? v <= lo : v < lo)) {
    throw new Error(`${name} must be a number ${loExclusive ? ">" : "≥"} ${lo} and ≤ ${hi} (got ${String(v)})`);
  }
  return v;
}

function intIn(name: string, v: unknown, lo: number, hi: number): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new Error(`${name} must be an integer from ${lo} to ${hi} (got ${String(v)})`);
  return v;
}

/**
 * Pure: validates the options and builds the `boundaryLayer` call, forwarding
 * only the keys that were given (a default call stays minimal and reproducible).
 * `firstHeight` is required; everything out of range throws a plain message.
 */
export function buildPrismCall(options: PrismLayersOptions): { call: Record<string, unknown>; firstHeight: number; numLayers: number; growth: number } {
  const firstHeight = finiteIn("firstHeight", options.firstHeight, 0, Number.MAX_VALUE, true);
  if (firstHeight === undefined) throw new Error("firstHeight is required (the first layer's thickness, a positive length in model units).");
  const numLayers = intIn("numLayers", options.numLayers, 1, PRISM_MAX_LAYERS);
  const growth = finiteIn("growth", options.growth, 1, 10);
  const collisionFraction = finiteIn("collisionFraction", options.collisionFraction, 0, 1, true);
  const smoothIterations = intIn("smoothIterations", options.smoothIterations, 0, 1000);
  const maxShrink = intIn("maxShrink", options.maxShrink, 0, 64);
  const normalSmoothIterations = intIn("normalSmoothIterations", options.normalSmoothIterations, 0, 1000);
  if (options.collapse !== undefined && options.collapse !== "points" && options.collapse !== "layers") {
    throw new Error(`collapse must be "points" or "layers" (got ${String(options.collapse)})`);
  }
  const call: Record<string, unknown> = { firstHeight };
  const set = (k: string, v: unknown): void => {
    if (v !== undefined) call[k] = v;
  };
  set("numLayers", numLayers);
  set("growth", growth);
  set("reverse", options.reverse);
  set("collisionFraction", collisionFraction);
  set("smoothIterations", smoothIterations);
  set("maxShrink", maxShrink);
  set("collapse", options.collapse);
  set("normalSmoothIterations", normalSmoothIterations);
  set("frontCheck", options.frontCheck);
  return { call, firstHeight, numLayers: numLayers ?? PRISM_DEFAULT_LAYERS, growth: growth ?? PRISM_DEFAULT_GROWTH };
}

/** Pure: the facts of a `boundaryLayer` result, with shortfall warnings. */
export function summarizePrismLayers(r: Record<string, unknown>, planned: { firstHeight: number; numLayers: number; growth: number }): PrismLayersReport {
  const n = (k: string): number => Number(r[k] ?? 0);
  const warnings: string[] = (Array.isArray(r.warnings) ? (r.warnings as unknown[]) : []).map((w) => clean(String(w)));
  const report: PrismLayersReport = {
    numCells: n("numCells"),
    numWedges: n("numWedges"),
    numHexahedra: n("numHexahedra"),
    numPyramids: n("numPyramids"),
    numTetrahedra: n("numTetrahedra"),
    numShrunk: n("numShrunk"),
    numCollapsed: n("numCollapsed"),
    numNotVisible: n("numNotVisible"),
    numFewerLayers: n("numFewerLayers"),
    numFrontCrossings: n("numFrontCrossings"),
    minScaledJacobian: n("minScaledJacobian"),
    minThickness: n("minThickness"),
    maxThickness: n("maxThickness"),
    plannedThickness: plannedPrismThickness(planned.firstHeight, planned.numLayers, planned.growth),
    capClosed: r.capClosed === true,
    warnings,
  };
  const short: string[] = [];
  if (report.numShrunk > 0) short.push(`${report.numShrunk} point(s) grew a thinner stack than planned`);
  if (report.numCollapsed > 0) short.push(`${report.numCollapsed} point(s) collapsed to the surface`);
  if (report.numFewerLayers > 0) short.push(`${report.numFewerLayers} point(s) grew fewer layers`);
  if (report.numFrontCrossings > 0) short.push(`${report.numFrontCrossings} last-layer face pair(s) cross or touch`);
  if (short.length > 0) {
    warnings.push(`Prism layers fell short of the plan (${report.plannedThickness.toPrecision(4)} total): ${short.join("; ")}. The reported thickness range is ${report.minThickness.toPrecision(4)}–${report.maxThickness.toPrecision(4)}.`);
  }
  if (report.numWedges > 0 && report.minScaledJacobian <= 0) {
    warnings.push(`The least scaled Jacobian of a layer cell is ${report.minScaledJacobian.toPrecision(3)} (not positive) — the mesh has inverted or degenerate cells.`);
  }
  if (!report.capClosed) warnings.push("The outer cap is not a closed surface.");
  return report;
}

interface Block {
  type: string;
  data: ArrayLike<number | bigint>;
}

/**
 * Serializes ONLY the wedge block(s) of a `boundaryLayer` result to ASCII MSH
 * 4.1 on the one volume entity (dim 3, tag 1) — pure, WASM-free. Same shape as
 * `octreeToMsh41` (an MSH with no `$Entities` only lets `gmsh.merge` create
 * entity 1). The cap and base triangles are dropped on purpose: boundary faces
 * are derived from the volume cells downstream. Pyramids/tetrahedra (points
 * that could not grow) are kept with their own Gmsh types so the layer shell
 * stays closed.
 */
const PRISM_CELLS: Record<string, { gmshType: number; nodes: number }> = {
  wedge: { gmshType: 6, nodes: 6 },
  pyramid: { gmshType: 7, nodes: 5 },
  tetra: { gmshType: 4, nodes: 4 },
  hexahedron: { gmshType: 5, nodes: 8 },
};

export function wedgesToMsh41(points: ArrayLike<number>, blocks: readonly Block[]): string {
  const nodeCount = Math.floor(points.length / 3);
  const used = blocks.filter((b) => PRISM_CELLS[b.type] && b.data.length > 0);
  const lines: string[] = ["$MeshFormat", "4.1 0 8", "$EndMeshFormat", "$Nodes"];
  if (nodeCount > 0) {
    lines.push(`1 ${nodeCount} 1 ${nodeCount}`, `3 1 0 ${nodeCount}`);
    for (let i = 1; i <= nodeCount; i++) lines.push(String(i));
    for (let i = 0; i < nodeCount; i++) lines.push(`${points[i * 3]} ${points[i * 3 + 1]} ${points[i * 3 + 2]}`);
  } else {
    lines.push("0 0 0 0");
  }
  lines.push("$EndNodes", "$Elements");
  const per = used.map((b) => Math.floor(b.data.length / PRISM_CELLS[b.type].nodes));
  const total = per.reduce((a, c) => a + c, 0);
  if (total > 0) {
    lines.push(`${used.length} ${total} 1 ${total}`);
    let next = 1;
    used.forEach((b, k) => {
      const { gmshType, nodes } = PRISM_CELLS[b.type];
      lines.push(`3 1 ${gmshType} ${per[k]}`);
      for (let c = 0; c < per[k]; c++) {
        const row: number[] = [next++];
        for (let j = 0; j < nodes; j++) row.push(Number(b.data[c * nodes + j]) + 1); // BigInt64Array-safe
        lines.push(row.join(" "));
      }
    });
  } else {
    lines.push("0 0 0 0");
  }
  lines.push("$EndElements", "");
  return lines.join("\n");
}

/** Writable layered-mesh formats (they hold wedge cells): extension → meshio++ format. */
export const PRISM_LAYER_FORMATS: Readonly<Record<string, string>> = {
  ".vtk": "vtk",
  ".vtu": "vtu",
  ".msh": "gmsh",
};

export type PrismSurfaceSource =
  | { kind: "cad"; bytes: Uint8Array; meshioFormat: string; targetSize: number }
  | { kind: "mesh"; bytes: Uint8Array; meshioFormat: string };

export interface PrismLayersResult {
  outputBytes: Uint8Array;
  report: PrismLayersReport;
  /** Triangles of the source surface that was layered. */
  numSurfaceTriangles: number;
}

const IN_PATH = "/pl-in.dat";
const OUT_PATH = "/pl-out.dat";

/**
 * Grows prism layers over a CAD file's exact surface (meshCadSurface at
 * `targetSize`, in one worker call so no mesh crosses IPC) or over a closed
 * triangle mesh file, and returns the whole layered mesh (wedges + base + cap)
 * in `outputExtension`'s format. A source that is not a closed triangle skin
 * fails with meshio++'s own message.
 */
export async function growPrismLayersModel(source: PrismSurfaceSource, outputExtension: string, options: PrismLayersOptions): Promise<PrismLayersResult> {
  const writerFormat = PRISM_LAYER_FORMATS[outputExtension.toLowerCase()];
  if (!writerFormat) throw new Error(`Unsupported output extension "${outputExtension}" — layered meshes hold wedges, so use ${Object.keys(PRISM_LAYER_FORMATS).join(", ")}.`);
  const { call, firstHeight, numLayers, growth } = buildPrismCall(options);
  const m = await getMeshio();
  try {
    m.FS.writeFile(IN_PATH, source.bytes);
    let skin: unknown;
    if (source.kind === "cad") {
      const info = readCadInfo(m, IN_PATH, source.meshioFormat);
      const { call: surfaceCall } = buildMeshCadCall({ targetSize: source.targetSize, edges: false }, null);
      skin = (m.meshCadSurface(info as never, surfaceCall as never) as unknown as RawMeshCadResult).mesh;
    } else {
      skin = m.readMesh(IN_PATH, source.meshioFormat);
    }
    const tris = ((skin as { cells: Block[] }).cells.find((b) => b.type === "triangle")?.data.length ?? 0) / 3;
    if (!(tris > 0)) throw new Error("The surface has no triangle cells to grow layers from.");
    const r = (m as unknown as { boundaryLayer(mesh: unknown, o: unknown): Record<string, unknown> & { mesh: unknown } }).boundaryLayer(skin, call);
    m.writeMesh(OUT_PATH, r.mesh as never, writerFormat);
    return {
      outputBytes: new Uint8Array(m.FS.readFile(OUT_PATH)),
      report: summarizePrismLayers(r, { firstHeight, numLayers, growth }),
      numSurfaceTriangles: tris,
    };
  } catch (err) {
    throw wrapMeshioFault(err);
  } finally {
    for (const p of [IN_PATH, OUT_PATH]) {
      try {
        m.FS.unlink(p);
      } catch {
        /* ignore */
      }
    }
  }
}
