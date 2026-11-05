/**
 * Turns the exact facts of the currently selected faces into a rule-defined
 * Part selector (`plane`, `box` or `surfaceType` + `radius` leaves from
 * `selectorPredicate.ts`). Pure and DOM/OCCT-free so the Parts panel — a
 * DOM-only class — stays a thin caller. The result is an ordinary scene
 * selector, re-evaluated by the host after every replay.
 */

import type { SceneSelector } from "./selectorQuery";
import type { FacePredicate } from "./selectorPredicate";
import type { SurfaceType, SurfaceParams } from "./entityFacts";

type Vec3 = [number, number, number];

/** The slice of `EntityFacts` a rule reads. */
export interface RuleFaceFacts {
  entityId: string;
  bbox: { min: Vec3; max: Vec3; diagonal: number } | null;
  normal: Vec3 | null;
  planeOrigin: Vec3 | null;
  surfaceType: SurfaceType | null;
  surfaceParams: SurfaceParams | null;
}

export type RuleKind = "plane" | "box" | "type";
export type RuleResult = { ok: true; query: SceneSelector; summary: string } | { ok: false; reason: string };

const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function radiusOf(p: SurfaceParams | null): number | null {
  if (!p) return null;
  switch (p.kind) {
    case "cylinder":
    case "sphere": return p.radius;
    case "torus": return p.majorRadius;
    case "cone": return p.refRadius;
    default: return null;
  }
}

/** Build a rule from the selected faces, or say precisely why none fits. */
export function ruleFromFaceFacts(faces: RuleFaceFacts[], kind: RuleKind): RuleResult {
  if (faces.length === 0) return { ok: false, reason: "Select at least one face first." };
  const scene = (leaf: FacePredicate): SceneSelector => ({ version: 1, source: { kind: "scene", filter: leaf } });

  if (kind === "plane") {
    const first = faces[0];
    if (!first.normal || !first.planeOrigin) return { ok: false, reason: `${first.entityId} is not a planar face.` };
    for (const f of faces) {
      if (!f.normal || !f.planeOrigin) return { ok: false, reason: `${f.entityId} is not a planar face.` };
      const parallel = Math.abs(Math.abs(dot(f.normal, first.normal)) - 1) < 1e-6;
      const offset = Math.abs(dot([f.planeOrigin[0] - first.planeOrigin[0], f.planeOrigin[1] - first.planeOrigin[1], f.planeOrigin[2] - first.planeOrigin[2]], first.normal));
      const tol = Math.max(1e-3 * (f.bbox?.diagonal ?? 1), 1e-6);
      if (!parallel || offset > tol) return { ok: false, reason: `${f.entityId} does not lie on the same plane as ${first.entityId}.` };
    }
    return {
      ok: true,
      query: scene({ kind: "plane", point: [...first.planeOrigin] as Vec3, normal: [...first.normal] as Vec3 }),
      summary: `on the plane through (${first.planeOrigin.map(fmt).join(", ")}) with normal (${first.normal.map(fmt).join(", ")})`,
    };
  }

  if (kind === "box") {
    const boxes = faces.map((f) => f.bbox);
    if (boxes.some((b) => !b)) return { ok: false, reason: "A selected face has no bounding box." };
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const b of boxes as Array<{ min: Vec3; max: Vec3 }>) {
      for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], b.min[i]); max[i] = Math.max(max[i], b.max[i]); }
    }
    return {
      ok: true,
      query: scene({ kind: "box", min: [...min] as Vec3, max: [...max] as Vec3, mode: "inside" }),
      summary: `inside the box (${min.map(fmt).join(", ")}) – (${max.map(fmt).join(", ")})`,
    };
  }

  const type = faces[0].surfaceType;
  if (!type || type === "plane" || type === "other") {
    return { ok: false, reason: `${faces[0].entityId} has no analytic radius — use Plane or Box for a ${type ?? "unknown"} face.` };
  }
  const radius = radiusOf(faces[0].surfaceParams);
  if (radius === null) return { ok: false, reason: `${faces[0].entityId} reports no radius.` };
  for (const f of faces) {
    const r = radiusOf(f.surfaceParams);
    if (f.surfaceType !== type || r === null || Math.abs(r - radius) > Math.max(1e-3 * radius, 1e-6)) {
      return { ok: false, reason: `${f.entityId} is not a ${type} of radius ${fmt(radius)} like ${faces[0].entityId}.` };
    }
  }
  return { ok: true, query: scene({ kind: "surfaceType", type, radius }), summary: `${type} faces of radius ${fmt(radius)}` };
}

/** One-line description of a stored rule for the Parts row, or null when the Part has none. */
export function describeRule(selector: unknown): string | null {
  const s = selector as { source?: { kind?: string; filter?: unknown } } | undefined;
  if (!s || s.source?.kind !== "scene" || s.source.filter === undefined) return null;
  const leaves = (Array.isArray(s.source.filter) ? s.source.filter : [s.source.filter]) as Array<Record<string, unknown>>;
  const parts = leaves.map((l) => {
    if (l.kind === "plane") return `plane (${(l.point as number[]).map(fmt).join(", ")})`;
    if (l.kind === "box") return "box";
    if (l.kind === "surfaceType") return `${l.type}${l.radius !== undefined ? ` r=${fmt(l.radius as number)}` : ""}`;
    return String(l.kind);
  });
  return parts.join(" + ");
}
