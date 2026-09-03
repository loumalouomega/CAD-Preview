import type { Primitive } from "./primitiveSdf";
import type { ConstructionPlane } from "./protocol";
import type { EditOp } from "./editOps";

export type Vec3 = [number, number, number];

export const SIMPLEST_FIT_RESIDUAL_FRAC = 1e-3;

export const FIT_SIMPLICITY_ORDER = ["plane", "cylinder", "sphere"] as const;
export type FitKind = (typeof FIT_SIMPLICITY_ORDER)[number];

export interface FitCandidate {
  kind: FitKind;
  primitive: Primitive;
  residual: number | null;
  residualFrac: number | null;
}

export interface MeshRegionFit {
  seedTriangle: number;
  triangleCount: number;
  capped: boolean;
  regionArea: number;
  regionDiagonal: number;
  freeEdgeCount: number;
  nonManifoldEdgeCount: number;
  candidates: FitCandidate[];
  simplest: FitKind | null;
  simplestRule: string;
  warnings: string[];
}

export function simplestOf(candidates: readonly FitCandidate[]): FitKind | null {
  for (const kind of FIT_SIMPLICITY_ORDER) {
    const c = candidates.find((x) => x.kind === kind);
    if (c && c.residualFrac !== null && c.residualFrac < SIMPLEST_FIT_RESIDUAL_FRAC) return kind;
  }
  return null;
}

export const FIT_DERIVED_FROM = "mesh region fit";

function findCandidate(fit: MeshRegionFit, kind: FitKind): FitCandidate | undefined {
  return fit.candidates.find((c) => c.kind === kind);
}

export function fitPlaneData(fit: MeshRegionFit): { point: Vec3; normal: Vec3 } | null {
  const c = findCandidate(fit, "plane");
  if (!c || c.primitive.kind !== "plane") return null;
  return { point: c.primitive.point, normal: c.primitive.normal };
}

export function fitOpForKind(fit: MeshRegionFit, kind: "cylinder" | "sphere"): EditOp | null {
  const c = findCandidate(fit, kind);
  if (!c) return null;
  if (kind === "cylinder" && c.primitive.kind === "cylinder") {
    return { op: "addCylinder", center: c.primitive.base, axis: c.primitive.axis, radius: c.primitive.radius, height: c.primitive.height };
  }
  if (kind === "sphere" && c.primitive.kind === "sphere") {
    return { op: "addSphere", center: c.primitive.center, radius: c.primitive.radius };
  }
  return null;
}

export function fitConstructionPlane(fit: MeshRegionFit, name?: string): Omit<ConstructionPlane, "id"> | null {
  const d = fitPlaneData(fit);
  if (!d) return null;
  return { name: name ?? "Fitted plane", point: d.point, normal: d.normal, derivedFrom: FIT_DERIVED_FROM };
}

export function fitStoreWarning(fit: MeshRegionFit, kind: FitKind): string | null {
  const c = findCandidate(fit, kind);
  if (!c) return null;
  if (c.residualFrac === null) return `Storing a ${kind} fit whose residual could not be computed — quality is unknown.`;
  if (c.residualFrac >= SIMPLEST_FIT_RESIDUAL_FRAC) {
    return `Storing a ${kind} fit whose residualFrac ${c.residualFrac.toExponential(2)} is above the published ${SIMPLEST_FIT_RESIDUAL_FRAC} bar (${c.residual !== null ? `residual ${c.residual.toExponential(2)}` : "no residual"} over diagonal ${fit.regionDiagonal.toExponential(2)}).`;
  }
  return null;
}
