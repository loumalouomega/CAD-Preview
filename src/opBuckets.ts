/**
 * Build-time classification buckets — roadmap item 7 ("Selector synthesis")
 * Phase 1, closed. Every topology-changing edit op records, at the moment it
 * runs, which `face-N` ids it produced and what role each plays, so the
 * Edits history can show "this extrude produced: end cap face-13, side walls
 * face-14…17" and Phase 2's selector ladder has a per-op namespace that is
 * stable under renumbering in a way positional ids alone are not.
 *
 * Pure and vscode/OCCT/THREE-free: this module holds only the record shape,
 * the per-kind role vocabulary, and display helpers. The OCCT-touching half
 * (the before/after face diff and the role classification) lives in
 * `occtOperations.ts`'s `collectBucketForOp` — same pure/impure split as
 * `entityRebind.ts`/`entityFacts.ts`.
 *
 * **Ids are recorded relative to the model state AT that op's own step** and
 * are never re-resolved by later replays — a later topology-changing op can
 * renumber them (this is the honest staleness trade-off; the record carries
 * no live references, so nothing can silently point at the wrong geometry).
 * An accessor that needs current-model ids re-derives them by prefix replay
 * (Phase 2's job), it does not trust these ids against a newer shape.
 */

export type OpRole =
  | "startCap"
  | "endCap"
  | "side"
  | "band"
  | "inner"
  | "wall"
  | "cutFace"
  | "sectionFace"
  | "copies"
  | "body"
  | "produced";

/** One op's classification: the op's 0-based index in the replayed list, its
 * kind, and a role → face-id map. `roles` is a plain JSON object (never a
 * Map) so the record crosses `kernelIpc.ts`'s generic marshal and the
 * webview postMessage channel untouched. */
export interface OpBucket {
  op: number;
  kind: string;
  roles: Record<string, string[]>;
}

/**
 * Which single role name the produced-face diff gets for each op kind — the
 * per-op functions' role knowledge distilled to a table. Kinds absent from
 * this table (and from the `extrude` special case) degrade to the generic
 * `"produced"` role — never a fabricated role name. `startCap` (and, for
 * extrude, `endCap`) is assigned by identity/geometry in the collector, not
 * from this table.
 */
export const PRODUCED_ROLE: Record<string, string> = {
  fillet: "band",
  chamfer: "band",
  draft: "band",
  shell: "inner",
  addHole: "wall",
  addCounterboreHole: "wall",
  addCountersinkHole: "wall",
  drill: "wall",
  splitByPlane: "cutFace",
  section: "sectionFace",
  patternLinear: "copies",
  patternCircular: "copies",
  addEdgeSlot: "body",
  addSurfaceFromLines: "body",
  addVolumeFromSurfaces: "body",
  addBox: "body",
  addSphere: "body",
  addCylinder: "body",
  addCone: "body",
  addTorus: "body",
  addPrism: "body",
  addWedge: "body",
  addCircleProfile: "body",
  addRectangleProfile: "body",
  addPolygonProfile: "body",
  addEllipseProfile: "body",
  addRoundedRectangleProfile: "body",
  addSlotProfile: "body",
  addTrapezoidProfile: "body",
  boolean: "produced",
  revolve: "produced",
  sweep: "produced",
  loft: "produced",
  // A fused rib's new faces are the wall's outer/inner sides above the
  // support surface (the embedded part vanishes into the solid) — "side",
  // the same walls an extrude names, not a new role.
  rib: "side",
  // A wrap's shell reads as one new body (standalone) or as merged faces
  // (emboss/engrave) — "body", the same role every primitive names.
  wrap: "body",
};

/** Human-readable role labels for the Edits-history chips (webview). */
export const ROLE_LABELS: Record<string, string> = {
  startCap: "start cap",
  endCap: "end cap",
  side: "side walls",
  band: "band",
  inner: "inner faces",
  wall: "hole wall",
  cutFace: "cut face",
  sectionFace: "section face",
  copies: "pattern copies",
  body: "new body",
  produced: "produced",
};

/** `"end cap ×1, side walls ×4"` — the chip text an Edits-history row shows.
 * Roles render in this fixed order (not key order) so the same op always
 * reads the same. Empty roles list → empty string. */
export function bucketSummary(roles: Record<string, string[]>): string {
  const order = Object.keys(ROLE_LABELS);
  const parts: string[] = [];
  for (const role of order) {
    const ids = roles[role];
    if (!ids || ids.length === 0) continue;
    parts.push(`${ROLE_LABELS[role]} ×${ids.length}`);
  }
  return parts.join(", ");
}
