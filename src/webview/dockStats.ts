/**
 * Text for the dock's status row: entity counts, FE-mesh stats, and the live
 * cursor position.
 *
 * Pure and DOM-free so the wording is unit-testable apart from the elements that
 * display it (this project's vitest config has no jsdom). Everything here is a
 * FACT about the loaded document, never a verdict — the same convention the MCP
 * tools follow — so nothing is coloured or labelled good/bad.
 */

import { convertLength, type DisplayUnit } from "./units";

/**
 * Grouped digits with a FIXED locale. `toLocaleString()` with no argument follows
 * the host machine's locale, which would make the same document read "1,248" for
 * one user and "1.248" for another — and make a test that compares text depend on
 * where it runs.
 */
const GROUPED = new Intl.NumberFormat("en-US");

function count(n: number, singular: string, plural: string): string {
  return `${GROUPED.format(n)} ${n === 1 ? singular : plural}`;
}

export interface EntityCounts {
  faces: number;
  edges: number;
  points: number;
}

/**
 * "36 faces · 98 edges · 64 points".
 *
 * Deliberately NO solid count. The `geometry` message groups faces by `groupId`,
 * but the free-face pass emits one extra group for sketch faces that belong to no
 * solid, so counting distinct groups would over-report "solids" by one for any
 * document containing a 2D sketch. A number that is sometimes off by one is worse
 * than no number.
 */
export function formatEntityCounts(c: EntityCounts): string {
  return [count(c.faces, "face", "faces"), count(c.edges, "edge", "edges"), count(c.points, "point", "points")].join(
    " · "
  );
}

export interface MeshStats {
  nodes: number;
  elements: number;
  /** Worst element quality (minSICN, 0..1). Absent when the mesher returned none. */
  minQuality?: number;
}

/**
 * "mesh 51,200 el · min SICN 0.412" — the status bar's short form.
 *
 * Elements and the worst quality only: the bar has room for one clause, and those
 * are the two numbers that say how heavy and how sound the mesh is. The quality
 * figure is the minimum only — `renderQuality` in the FE Mesh panel already draws
 * the full histogram, and a second renderer in a one-line strip would be a
 * guaranteed-to-drift duplicate of it.
 */
export function formatMeshStats(m: MeshStats): string {
  const parts = [`mesh ${GROUPED.format(m.elements)} el`];
  if (typeof m.minQuality === "number" && Number.isFinite(m.minQuality)) {
    parts.push(`min SICN ${m.minQuality.toFixed(3)}`);
  }
  return parts.join(" · ");
}

/** "12,480 nodes · 51,200 elements · min SICN 0.412" — the same facts spelled out,
 * for the status bar item's tooltip (the node count lives only here). */
export function formatMeshStatsLong(m: MeshStats): string {
  const parts = [count(m.nodes, "node", "nodes"), count(m.elements, "element", "elements")];
  if (typeof m.minQuality === "number" && Number.isFinite(m.minQuality)) {
    parts.push(`min SICN ${m.minQuality.toFixed(3)}`);
  }
  return parts.join(" · ");
}

/**
 * "1,248 el" — the FE Mesh section header's short form of the mesh stat. Elements
 * only: the header has room for one number, and the element count is the one that
 * says how heavy the mesh is. The full nodes/elements/quality line lives in the
 * status bar.
 */
export function formatMeshHeaderStat(m: MeshStats): string {
  return `${GROUPED.format(m.elements)} el`;
}

/** "3 unsaved edits" for the document chip; "" when there are none. */
export function unsavedEditsLabel(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  return count(Math.floor(n), "unsaved edit", "unsaved edits");
}

/**
 * "x 142.06  y -18.40  z 27.00 mm", or "" when there is no point.
 *
 * `mmPoint` is in the model's OWN frame, in millimetres (the cascade unit) — the
 * caller converts a world-space hit into that frame first, because a Z-up file
 * rotates the model root and a raw world coordinate would then be wrong. It is
 * converted to the display unit here, so the Units dropdown drives this readout
 * the same way it drives Mass Properties and Measurement.
 *
 * Two decimals: this is a hover readout of a triangulated surface, and a third
 * decimal only showed tessellation noise. Plain hyphen-minus rather than U+2212:
 * a coordinate is something people copy into other tools, and a typographic minus
 * does not parse there.
 */
export function formatCursor(mmPoint: readonly [number, number, number] | null, unit: DisplayUnit): string {
  if (!mmPoint) return "";
  if (!mmPoint.every((v) => Number.isFinite(v))) return "";
  const [x, y, z] = mmPoint.map((v) => convertLength(v, unit));
  // `-0.00` reads as a sign error; collapse it.
  const fmt = (v: number) => (Object.is(v, -0) || Math.abs(v) < 0.005 ? 0 : v).toFixed(2);
  return `x ${fmt(x)}  y ${fmt(y)}  z ${fmt(z)} ${unit}`;
}
