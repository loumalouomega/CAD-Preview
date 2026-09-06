/**
 * The op catalog: the single source of truth for how the Edits panel's
 * GEOMETRY / EDIT tabs are structured. Pure and DOM-free so it unit-tests
 * headless (`opCatalog.test.ts` cross-checks it against `BREP_ONLY_OPS` and
 * `OP_ICONS`).
 *
 * A `PanelOpId` is one op *button* in the panel — usually 1:1 with an
 * `EditOpKind`, but not always: the three booleans are separate buttons (each
 * with its own icon) over the single `boolean` op kind, and the two Build
 * buttons emit `addSurfaceFromLines`/`addVolumeFromSurfaces` from the live
 * selection. Each entry's `kinds` lists the EditOp kind(s) the button can
 * emit, which is what ties the catalog back to the op model in tests.
 */
import { BREP_ONLY_OPS, type EditOp, type EditOpKind } from "../editOps";

export type PanelOpId =
  // EDIT — transform
  | "translate" | "rotate" | "scale" | "mirror"
  // EDIT — boolean (three buttons over the one `boolean` op kind)
  | "booleanUnion" | "booleanSubtract" | "booleanIntersect"
  // EDIT — refine
  | "fillet" | "chamfer"
  // EDIT — features
  | "extrude" | "revolve" | "sweep" | "loft" | "rib" | "wrap"
  // EDIT — modify
  | "shell" | "draft" | "splitByPlane" | "section" | "drill"
  // EDIT — assembly
  | "explode" | "mate" | "align" | "patternLinear" | "patternCircular"
  // GEOMETRY 2D — wireframe
  | "addPoint" | "addLine" | "addArc"
  // GEOMETRY 2D — curves
  | "addPolyline" | "addThreePointArc" | "addSpline" | "addBezier" | "addEllipseArc" | "addHelix"
  // GEOMETRY 2D — sketch profiles
  | "addCircleProfile" | "addRectangleProfile" | "addPolygonProfile"
  | "addEllipseProfile" | "addRoundedRectangleProfile" | "addSlotProfile" | "addTrapezoidProfile"
  // GEOMETRY 2D — build from selection
  | "buildSurface" | "edgeSlot"
  // GEOMETRY 3D — primitives
  | "addBox" | "addSphere" | "addCylinder" | "addCone" | "addTorus" | "addPrism" | "addWedge"
  // GEOMETRY 3D — holes (subtractive: cut into the selected volumes)
  | "addHole" | "addCounterboreHole" | "addCountersinkHole"
  // GEOMETRY 3D — build from selection
  | "buildVolume";

export interface CatalogEntry {
  id: PanelOpId;
  /** Button label (short — renders under the icon in a 3-column grid). */
  label: string;
  /** Greyed out for mesh sources (STL/OBJ/PLY/glTF). Must agree with
   * `BREP_ONLY_OPS` over `kinds` — enforced by `opCatalog.test.ts`. */
  brepOnly: boolean;
  /** The EditOp kind(s) this button can emit (for catalog↔op-model tests). */
  kinds: EditOpKind[];
}

export interface CatalogCategory {
  title: string;
  ops: CatalogEntry[];
}

const entry = (id: PanelOpId, label: string, kinds: EditOpKind[]): CatalogEntry => ({
  id, label, kinds,
  brepOnly: kinds.every((k) => BREP_ONLY_OPS.has(k)),
});

/** Tab structure: GEOMETRY (2D / 3D subtabs) creates, EDIT modifies. */
export const OP_CATALOG: {
  geometry2d: CatalogCategory[];
  geometry3d: CatalogCategory[];
  edit: CatalogCategory[];
} = {
  geometry2d: [
    {
      title: "Wireframe",
      ops: [
        entry("addPoint", "Point", ["addPoint"]),
        entry("addLine", "Line", ["addLine"]),
        entry("addArc", "Arc", ["addArc"]),
      ],
    },
    {
      title: "Curves",
      ops: [
        entry("addPolyline", "Polyline", ["addPolyline"]),
        entry("addThreePointArc", "3-Pt Arc", ["addThreePointArc"]),
        entry("addSpline", "Spline", ["addSpline"]),
        entry("addBezier", "Bezier", ["addBezier"]),
        entry("addEllipseArc", "Ell. Arc", ["addEllipseArc"]),
        entry("addHelix", "Helix", ["addHelix"]),
      ],
    },
    {
      title: "Sketch profiles",
      ops: [
        entry("addCircleProfile", "Circle", ["addCircleProfile"]),
        entry("addRectangleProfile", "Rectangle", ["addRectangleProfile"]),
        entry("addPolygonProfile", "Polygon", ["addPolygonProfile"]),
        entry("addEllipseProfile", "Ellipse", ["addEllipseProfile"]),
        entry("addRoundedRectangleProfile", "Rounded", ["addRoundedRectangleProfile"]),
        entry("addSlotProfile", "Slot", ["addSlotProfile"]),
        entry("addTrapezoidProfile", "Trapezoid", ["addTrapezoidProfile"]),
      ],
    },
    {
      title: "Build from selection",
      ops: [entry("buildSurface", "Surface", ["addSurfaceFromLines"]), entry("edgeSlot", "Edge Slot", ["addEdgeSlot"])],
    },
  ],
  geometry3d: [
    {
      title: "Primitives",
      ops: [
        entry("addBox", "Box", ["addBox"]),
        entry("addSphere", "Sphere", ["addSphere"]),
        entry("addCylinder", "Cylinder", ["addCylinder"]),
        entry("addCone", "Cone", ["addCone"]),
        entry("addTorus", "Torus", ["addTorus"]),
        entry("addPrism", "Prism", ["addPrism"]),
        entry("addWedge", "Wedge", ["addWedge"]),
      ],
    },
    {
      title: "Holes",
      ops: [
        entry("addHole", "Hole", ["addHole"]),
        entry("addCounterboreHole", "C'bore", ["addCounterboreHole"]),
        entry("addCountersinkHole", "C'sink", ["addCountersinkHole"]),
      ],
    },
    {
      title: "Build from selection",
      ops: [entry("buildVolume", "Volume", ["addVolumeFromSurfaces"])],
    },
  ],
  edit: [
    {
      title: "Transform",
      ops: [
        entry("translate", "Move", ["translate"]),
        entry("rotate", "Rotate", ["rotate"]),
        entry("scale", "Scale", ["scale"]),
        entry("mirror", "Mirror", ["mirror"]),
      ],
    },
    {
      title: "Boolean",
      ops: [
        entry("booleanUnion", "Unite", ["boolean"]),
        entry("booleanSubtract", "Subtract", ["boolean"]),
        entry("booleanIntersect", "Intersect", ["boolean"]),
      ],
    },
    {
      title: "Refine",
      ops: [
        entry("fillet", "Fillet", ["fillet"]),
        entry("chamfer", "Chamfer", ["chamfer"]),
      ],
    },
    {
      title: "Features",
      ops: [
        entry("extrude", "Extrude", ["extrude"]),
        entry("revolve", "Revolve", ["revolve"]),
        entry("sweep", "Sweep", ["sweep"]),
        entry("loft", "Loft", ["loft"]),
        entry("rib", "Rib", ["rib"]),
        entry("wrap", "Wrap", ["wrap"]),
      ],
    },
    {
      title: "Modify",
      ops: [
        entry("shell", "Shell", ["shell"]),
        entry("draft", "Draft", ["draft"]),
        entry("splitByPlane", "Split", ["splitByPlane"]),
        entry("section", "Section", ["section"]),
        entry("drill", "Drill", ["drill"]),
      ],
    },
    {
      title: "Assembly",
      ops: [
        entry("explode", "Explode", ["explode"]),
        entry("mate", "Mate", ["mate"]),
        entry("align", "Align", ["align"]),
        entry("patternLinear", "Linear Pattern", ["patternLinear"]),
        entry("patternCircular", "Circular Pattern", ["patternCircular"]),
      ],
    },
  ],
};

/** Every catalog entry across all tabs, in display order. */
export function allCatalogEntries(): CatalogEntry[] {
  return [...OP_CATALOG.geometry2d, ...OP_CATALOG.geometry3d, ...OP_CATALOG.edit]
    .flatMap((cat) => cat.ops);
}

/** A short, human-readable one-line summary of an op for the panel's history
 * list. Parametric ops (with an `exprs` annotation) get a compact
 * `[field = expr, …]` suffix so the history reveals which numbers are
 * variable-driven rather than literal. */
export function describeOp(op: EditOp): string {
  const base = describeOpBase(op);
  if (!op.exprs) return base;
  const bindings = Object.entries(op.exprs).map(([k, v]) => `${k} = ${v}`).join(", ");
  return bindings ? `${base} [${bindings}]` : base;
}

/**
 * A sweep-family op's profile operand, in whichever of its two mutually
 * exclusive forms is present: the `face-N`, or the edges of its wire joined
 * with `+`.
 */
function profileLabel(op: { profile?: string; profileEdges?: string[] }): string {
  if (op.profile !== undefined) return op.profile;
  return op.profileEdges?.join("+") ?? "?";
}

/** Every entity id a single-profile operand mentions, in either form. */
function profileOperandIds(op: { profile?: string; profileEdges?: string[] }): string[] {
  if (op.profile !== undefined) return [op.profile];
  return [...(op.profileEdges ?? [])];
}

/** " thin=2" / " thin=2/1" for a thin-walled sweep-family op; "" otherwise. */
function thinLabel(op: { thin?: number; thinOuter?: number }): string {
  if (op.thin === undefined) return "";
  return op.thinOuter ? ` thin=${op.thin}/${op.thinOuter}` : ` thin=${op.thin}`;
}

function describeOpBase(op: EditOp): string {
  switch (op.op) {
    case "translate": return `Move ${op.targets.length} (${op.vec.join(", ")})`;
    case "rotate": return `Rotate ${op.targets.length} ${op.angleDeg}°`;
    case "scale": return `Scale ${op.targets.length} (${op.factors.join(", ")})`;
    case "mirror": return `Mirror ${op.targets.length}`;
    case "boolean": return `${cap(op.kind)} ${op.a.length}↔${op.b.length}`;
    case "fillet": return `Fillet ${op.edges.length} r=${op.radius}`;
    case "chamfer": {
      if (op.distance2 !== undefined) return `Chamfer ${op.edges.length} ${op.distance}×${op.distance2}`;
      if (op.angleDeg !== undefined) return `Chamfer ${op.edges.length} d=${op.distance} ${op.angleDeg}°`;
      return `Chamfer ${op.edges.length} d=${op.distance}`;
    }
    case "extrude": return (op as any).upToFace
      ? `Extrude ${profileLabel(op)} → ${(op as any).upToFace as string}${thinLabel(op)}`
      : `Extrude ${profileLabel(op)} ×${(op as any).length as number}${thinLabel(op)}`;
    case "rib": {
      const r = op as Extract<EditOp, { op: "rib" }>;
      return `Rib ${r.spineEdges.length} → ${r.upTo}${thinLabel(op)}`;
    }
    case "wrap": {
      const w = op as Extract<EditOp, { op: "wrap" }>;
      return `Wrap ${w.profile} → ${w.target} r=${w.radius} t=${w.thickness} (${w.variant})`;
    }
    case "revolve": return `Revolve ${profileLabel(op)} ${op.angleDeg}°${thinLabel(op)}`;
    case "sweep": return `Sweep ${profileLabel(op)} → ${op.path}${thinLabel(op)}`;
    case "loft": return `Loft ${(op.profiles ?? op.profileEdgeSets ?? []).length} profiles${(op as Extract<EditOp, { op: "loft" }>).smoothing ? " +smooth" : ""}${thinLabel(op)}`;
    case "explode": return `Explode ×${op.factor}`;
    case "mate": return `Mate ${op.faceA} → ${op.faceB}`;
    case "shell": return `▣ Shell t=${op.thickness} (${op.openingFaces.length} openings)`;
    case "draft": return `⬔ Draft ${op.faces.length} ${op.angleDeg}°`;
    case "splitByPlane": return `⧄ Split ${op.targets.length} (${op.keep})`;
    case "section": return `⊟ Section ${op.targets.length}`;
    case "drill": return `⦿ Drill ${op.targets.length} ${profileLabel(op)} ×${op.length}`;
    case "addBox": return `+ Box ${op.size.join("×")}`;
    case "addSphere": return `+ Sphere r=${op.radius}`;
    case "addCylinder": return `+ Cylinder r=${op.radius} h=${op.height}`;
    case "addCone": return `+ Cone r1=${op.radius1} r2=${op.radius2} h=${op.height}`;
    case "addTorus": return `+ Torus R=${op.majorRadius} r=${op.minorRadius}`;
    case "addPrism": return `+ ${op.sides}-gon Prism r=${op.radius} h=${op.height}`;
    case "addWedge": return `+ Wedge ${op.dx}×${op.dy}×${op.dz}`;
    case "addHole": return `◎ Hole r=${op.radius} d=${op.depth}`;
    case "addCounterboreHole": return `◎ C'bore r=${op.radius}/${op.cbRadius} d=${op.depth}`;
    case "addCountersinkHole": return `◎ C'sink r=${op.radius}/${op.csRadius} ${op.csAngleDeg}°`;
    case "addCircleProfile": return `⌗ Circle sketch r=${op.radius}`;
    case "addRectangleProfile": return `⌗ Rectangle sketch ${op.width}×${op.height}`;
    case "addPolygonProfile": return `⌗ ${op.sides}-gon sketch r=${op.radius}`;
    case "addEllipseProfile": return `⌗ Ellipse sketch ${op.radiusX}×${op.radiusY}`;
    case "addRoundedRectangleProfile": return `⌗ Rounded rect ${op.width}×${op.height} r=${op.cornerRadius}`;
    case "addSlotProfile": return `⌗ Slot sketch ${op.length}×${op.width}`;
    case "addTrapezoidProfile": return `⌗ Trapezoid sketch ${op.bottomWidth}/${op.topWidth}×${op.height}`;
    case "addPoint": return `• Point`;
    case "addLine": return `— Line`;
    case "addArc": return `⌒ Arc r=${op.radius} ${op.startAngleDeg}°→${op.endAngleDeg}°`;
    case "addPolyline": return `— Polyline ×${op.points.length}${op.closed ? " closed" : ""}`;
    case "addThreePointArc": return `⌒ 3-point arc`;
    case "addSpline": return `∿ Spline ×${op.points.length}`;
    case "addBezier": return `∿ Bezier ×${op.controlPoints.length}`;
    case "addEllipseArc": return `⌒ Ellipse arc ${op.radiusX}×${op.radiusY} ${op.startAngleDeg}°→${op.endAngleDeg}°`;
    case "addHelix": return `⌇ Helix r=${op.radius} p=${op.pitch} ×${op.turns}`;
    case "addSurfaceFromLines": return `⌗ Surface from ${op.edges.length} lines`;
    case "addVolumeFromSurfaces": return `⬢ Volume from ${op.faces.length} surfaces`;
    case "addEdgeSlot": return `▭ Edge slot w=${op.width}`;
    case "align": return `⇥ Align ${op.targets.length} ${op.axis}:${op.extent}→${op.to}`;
    case "patternLinear": return `⠿ Linear ×${op.count} (${op.direction.join(",")}) s=${op.spacing}`;
    case "patternCircular": return `⠿ Circular ×${op.count} ${op.angleDeg}°`;
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Every entity id an op names as an operand, in no particular order.
 *
 * **These are ids the op MENTIONS, not entities it provably acts on.** Ids are
 * positional (`face-12` is an index into the shape as it exists at that point
 * in the op list), so the same string in two ops can denote different topology
 * once an intervening op renumbers. Anything built on this must say "mentions",
 * never "acts on" — see CLAUDE.md's entity-id-drift discussion.
 *
 * Exhaustive `switch` with no `default`, deliberately mirroring
 * {@link describeOp}'s: a new `EditOpKind` becomes a compile error here rather
 * than silently reporting no references. The creation ops (`addBox`,
 * `addPolyline`, …) and `explode` genuinely take no ids — pure coordinates —
 * and return `[]`.
 */
export function referencedEntities(op: EditOp): string[] {
  switch (op.op) {
    case "translate":
    case "rotate":
    case "scale":
    case "align":
    case "patternLinear":
    case "patternCircular":
    case "addHole":
    case "addCounterboreHole":
    case "addCountersinkHole":
      return [...op.targets];
    case "drill":
      return [...op.targets, ...profileOperandIds(op)];
    case "mirror":
    case "splitByPlane":
    case "section": {
      const refs = [...(op as any).targets as string[]];
      if ((op as any).midplaneFaces) refs.push(...(op as any).midplaneFaces as string[]);
      if ((op as any).planeId) refs.push((op as any).planeId as string);
      return refs;
    }
    case "boolean":
      return [...op.a, ...op.b];
    case "fillet":
      return [...op.edges];
    case "chamfer":
      return op.face ? [...op.edges, op.face] : [...op.edges];
    case "addSurfaceFromLines":
      return [...op.edges];
    case "addVolumeFromSurfaces":
      return [...op.faces];
    case "rib":
      return [...op.spineEdges, op.upTo];
    case "wrap":
      return op.targets ? [op.profile, ...op.targets] : [op.profile];
    case "extrude":
      return [...profileOperandIds(op), ...((op as any).upToFace ? [(op as any).upToFace as string] : [])];
    case "revolve":
      return profileOperandIds(op);
    case "sweep":
      return [...profileOperandIds(op), op.path];
    case "loft":
      return op.profiles ? [...op.profiles] : (op.profileEdgeSets ?? []).flat();
    case "mate":
      return [op.faceA, op.faceB];
    case "shell":
      return [...op.openingFaces];
    case "draft": {
      const refs = [...op.faces];
      if ((op as any).planeId) refs.push((op as any).planeId as string);
      return refs;
    }
    case "explode":
    case "addBox":
    case "addSphere":
    case "addCylinder":
    case "addCone":
    case "addTorus":
    case "addPrism":
    case "addWedge":
    case "addCircleProfile":
    case "addRectangleProfile":
    case "addPolygonProfile":
    case "addEllipseProfile":
    case "addRoundedRectangleProfile":
    case "addSlotProfile":
    case "addTrapezoidProfile":
    case "addPoint":
    case "addLine":
    case "addArc":
    case "addPolyline":
    case "addThreePointArc":
    case "addSpline":
    case "addBezier":
    case "addEllipseArc":
    case "addHelix":
      return [];
    case "addEdgeSlot":
      return [op.edge];
  }
}

/**
 * `entityId -> 1-based op positions that mention it`, for the hover tooltip.
 *
 * Built once per op-list change rather than per hover event: `EditsModel.list()`
 * deep-clones on every call, so recomputing this inside a pointermove handler
 * would clone the whole op list on every mouse move.
 */
export function buildEntityReferenceIndex(ops: EditOp[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  ops.forEach((op, i) => {
    for (const id of referencedEntities(op)) {
      const at = index.get(id);
      if (at) at.push(i + 1);
      else index.set(id, [i + 1]);
    }
  });
  return index;
}

/**
 * Op buttons whose param form carries the "pin selection as query" row
 * (roadmap "Selector synthesis" follow-up: the interactive half of
 * op-operand persistence). Deliberately only the face-operand forms:
 * `synthesizeSelector`'s universe is `faceFilterableFacts` — buckets record
 * `face-N` ids and the predicate layer names faces — so an edge/volume pick
 * could never induce (the kernel answers an honest null, but offering the
 * row there would be a dead surface). Edge/volume predicates and joint
 * multi-entity induction each unlock more forms with a one-line change here.
 */
export const QUERYABLE_PANEL_FORMS: ReadonlySet<PanelOpId> = new Set([
  "extrude",
  "revolve",
  "shell",
  "draft",
]);
