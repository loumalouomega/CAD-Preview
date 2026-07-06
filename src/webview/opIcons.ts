/**
 * Icon placeholders for the Edits panel's op buttons — ONE ENTRY PER OP BUTTON.
 *
 * ✏️ EDIT THIS FILE to swap in real icons. Each value is rendered as the text
 * content of the button's `<span class="op-icon">`, so any short string works:
 * an emoji, a unicode glyph, or (after adjusting `editsPanel.ts` to set
 * innerHTML/classes instead of textContent) an inline-SVG string or icon-font
 * class. The current values are deliberate placeholders.
 *
 * Keys are `PanelOpId`s from `opCatalog.ts`; the `Record` type makes a missing
 * icon a compile error, and `opCatalog.test.ts` re-checks completeness at
 * runtime.
 */
import type { PanelOpId } from "./opCatalog";

export const OP_ICONS: Record<PanelOpId, string> = {
  // EDIT — transform
  translate: "✥",
  rotate: "⟳",
  scale: "⤢",
  mirror: "⇌",
  // EDIT — boolean
  booleanUnion: "∪",
  booleanSubtract: "∖",
  booleanIntersect: "∩",
  // EDIT — refine
  fillet: "◜",
  chamfer: "◣",
  // EDIT — features
  extrude: "⇧",
  revolve: "↻",
  sweep: "↝",
  loft: "≋",
  // EDIT — modify
  shell: "▣",
  splitByPlane: "⧄",
  section: "⊟",
  // EDIT — assembly
  explode: "✸",
  mate: "⧉",
  // GEOMETRY 2D — wireframe
  addPoint: "•",
  addLine: "─",
  addArc: "⌒",
  // GEOMETRY 2D — curves
  addPolyline: "〣",
  addThreePointArc: "◠",
  addSpline: "∿",
  addBezier: "﹏",
  addEllipseArc: "◝",
  addHelix: "⌇",
  // GEOMETRY 2D — sketch profiles
  addCircleProfile: "○",
  addRectangleProfile: "▭",
  addPolygonProfile: "⬡",
  addEllipseProfile: "⬭",
  addRoundedRectangleProfile: "▢",
  addSlotProfile: "⬮",
  addTrapezoidProfile: "⏢",
  // GEOMETRY 2D — build
  buildSurface: "⌗",
  // GEOMETRY 3D — primitives
  addBox: "▧",
  addSphere: "●",
  addCylinder: "⌭",
  addCone: "△",
  addTorus: "◎",
  addPrism: "⬣",
  addWedge: "◺",
  // GEOMETRY 3D — holes
  addHole: "⊙",
  addCounterboreHole: "⊚",
  addCountersinkHole: "⊛",
  // GEOMETRY 3D — build
  buildVolume: "⬢",
};

/** Fallback if an id is ever missing at runtime (kept for safety; the Record
 * type should make this unreachable). */
export const DEFAULT_OP_ICON = "▫";
