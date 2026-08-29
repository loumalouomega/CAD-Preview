/**
 * Content for the hover tooltip and the geometry inspector card — what to say
 * about the entity under the cursor, and about the one that is selected.
 *
 * Pure and DOM-free so the field-selection logic is unit-testable headless;
 * `main.ts` owns the elements. This is the interesting half: the card must show
 * **only the fields that apply to the classification** (radius for a cylinder,
 * area for a plane) rather than a grid of mostly-blank rows.
 */

import type { EntityFacts, CurveType, SurfaceType } from "../entityFacts";

/** One label/value line on the inspector card. */
export interface InspectorRow {
  key: string;
  value: string;
}

export interface InspectorContent {
  /** Human-readable classification, e.g. "Cylindrical face" or "Circular edge". */
  title: string;
  /** The entity id, shown monospace beside the title. */
  entityId: string;
  rows: InspectorRow[];
}

const SURFACE_LABEL: Record<SurfaceType, string> = {
  plane: "Planar face",
  cylinder: "Cylindrical face",
  cone: "Conical face",
  sphere: "Spherical face",
  torus: "Toroidal face",
  other: "Face",
};

const CURVE_LABEL: Record<CurveType, string> = {
  line: "Straight edge",
  circle: "Circular edge",
  ellipse: "Elliptical edge",
  hyperbola: "Hyperbolic edge",
  parabola: "Parabolic edge",
  bezier: "Bezier edge",
  bspline: "B-spline edge",
  other: "Edge",
};

/** Formats a length-like scalar compactly, without pretending to more precision
 * than the number carries. */
export function num(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e7)) return v.toExponential(3);
  return String(Number(v.toFixed(a < 1 ? 5 : 3)));
}

const vec = (v: readonly number[]): string => v.map(num).join(", ");

/**
 * Chooses the card's title and rows for one entity.
 *
 * Deliberately omits a field the classification does not give meaning to:
 * an edge has no area, a non-planar face has no single normal, a point has
 * neither. `EntityFacts` already returns `null` for those, and this is where
 * that null becomes "don't show the row" rather than "show a blank".
 */
export function inspectorContent(facts: EntityFacts): InspectorContent {
  const rows: InspectorRow[] = [];

  let title: string;
  switch (facts.kind) {
    case "face":
      title = SURFACE_LABEL[facts.surfaceType ?? "other"];
      break;
    case "edge":
      title = CURVE_LABEL[facts.curveType ?? "other"];
      break;
    case "solid":
      title = "Solid";
      break;
    case "point":
      title = "Vertex";
      break;
  }

  if (facts.area !== null) rows.push({ key: facts.kind === "solid" ? "Surface area" : "Area", value: num(facts.area) });
  if (facts.length !== null) rows.push({ key: "Length", value: num(facts.length) });

  // A planar face is the only kind with a single meaningful normal, and the
  // only one where a plane origin exists to pair with it.
  if (facts.normal !== null) rows.push({ key: "Normal", value: vec(facts.normal) });
  if (facts.planeOrigin !== null) rows.push({ key: "On plane", value: vec(facts.planeOrigin) });

  // The analytic parameters, per classification. The `plane` variant is
  // deliberately absent: its origin/normal are already rendered above, and
  // duplicating them here would show every planar face two identical pairs.
  //
  // `if (facts.surfaceParams)` rather than `!== null` on purpose — the webview
  // test harness hand-builds `entityFactsResult` payloads, so an older or
  // partial object arriving with the field simply missing must render, not throw.
  if (facts.surfaceParams) {
    const p = facts.surfaceParams;
    switch (p.kind) {
      case "cylinder":
        rows.push({ key: "Radius", value: num(p.radius) });
        rows.push({ key: "Axis", value: vec(p.axisDirection) });
        rows.push({ key: "Axis through", value: vec(p.axisLocation) });
        break;
      case "cone":
        rows.push({ key: "Radius at axis pt", value: num(p.refRadius) });
        rows.push({ key: "Half angle", value: `${num(p.semiAngleDeg)}°` });
        rows.push({ key: "Apex", value: vec(p.apex) });
        rows.push({ key: "Axis", value: vec(p.axisDirection) });
        rows.push({ key: "Axis through", value: vec(p.axisLocation) });
        break;
      case "sphere":
        rows.push({ key: "Radius", value: num(p.radius) });
        rows.push({ key: "Sphere centre", value: vec(p.center) });
        break;
      case "torus":
        rows.push({ key: "Major radius", value: num(p.majorRadius) });
        rows.push({ key: "Minor radius", value: num(p.minorRadius) });
        rows.push({ key: "Axis", value: vec(p.axisDirection) });
        rows.push({ key: "Axis through", value: vec(p.axisLocation) });
        break;
      case "plane":
        break;
    }
  }

  rows.push({ key: "Centre", value: vec(facts.center) });
  if (facts.bbox !== null && facts.kind !== "point") {
    // A vertex's bbox is degenerate — its diagonal is always 0, which is noise.
    rows.push({ key: "Bbox diag", value: num(facts.bbox.diagonal) });
  }

  return { title, entityId: facts.entityId, rows };
}

/**
 * The hover tooltip's two lines: the entity's id, and which ops mention it.
 *
 * **"Mentions", never "acts on".** Entity ids are positional — `face-12` is an
 * index into the shape as it exists at that point in the op list — so the same
 * string in two ops can denote different topology once an intervening op
 * renumbers. Saying "used by" would be a claim this cannot support; see
 * CLAUDE.md's entity-id-drift discussion.
 */
export function hoverContent(entityId: string, opPositions: readonly number[] | undefined): {
  id: string;
  ops: string;
} {
  if (!opPositions || opPositions.length === 0) {
    return { id: entityId, ops: "not mentioned by any op" };
  }
  const list = opPositions.join(", ");
  const noun = opPositions.length === 1 ? "op" : "ops";
  return { id: entityId, ops: `mentioned by ${noun} ${list}` };
}
