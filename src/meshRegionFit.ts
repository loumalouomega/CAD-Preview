/**
 * Fit a plane / cylinder / sphere to a region of a mesh (roadmap item 9).
 *
 * **Facts only — emits no ops and changes nothing.** Every candidate fit is
 * published with its own residual, and the caller decides which (if any) to
 * believe. This is the same gating item 8 Phase 2 was held to, for the same
 * reason: a wrongly-accepted fit that became a verdict would feed
 * `get_mass_properties`/`measure_exact` confidently-wrong numbers.
 *
 * **WASM-free.** No `getOcct` anywhere in this file — the region grow and all
 * three fits are pure TypeScript over triangles `parseToWeldedMesh` already
 * produces, so the standing "opening a pure-mesh file must never load the
 * WASM" invariant holds, exactly as `svgSilhouetteHost.ts`'s mesh path does.
 * There is also no triangle-count ceiling: `meshHeal.ts`'s 50 000 cap exists
 * only because it builds one OCCT face per triangle, which nothing here does.
 */

import { parseToWeldedMesh } from "./meshHeal";
import type { GltfExternalBuffers } from "./gltfParser";
import type { MeshParseFormat } from "./fileRouter";
import { boundsOfTriangles, boundsDiagonal, areaOfTriangles } from "./meshComponents";
import { analyzeMeshTopology } from "./meshTopology";
import {
  growRegion,
  nearestTriangleToPoint,
  regionPoints,
  regionNormals,
  DEFAULT_GROW_ANGLE_DEG,
} from "./meshRegionGrow";
import { fitPlane, fitSphere, fitCylinder, axialExtent, type Vec3 } from "./primitiveFit";
import { maxDeviation, type Primitive } from "./primitiveSdf";
import type { ConstructionPlane } from "./protocol";
import type { EditOp } from "./editOps";

/**
 * Below this residual-to-size ratio a fit is reported as `simplest`.
 *
 * Published as a constant, and the rule is stated in the result, so a caller
 * can recompute `simplest` from the per-candidate numbers rather than trusting
 * it. It is a convenience over facts, never a hidden judgment.
 */
export const SIMPLEST_FIT_RESIDUAL_FRAC = 1e-3;

/**
 * Candidate order, simplest first.
 *
 * **This ordering is what stops a flat region being reported as a sphere.** A
 * plane genuinely IS also fitted by an enormous sphere with a tiny residual —
 * picking a winner by residual alone would choose almost arbitrarily between
 * them. Preferring the simpler shape at equal quality is the documented
 * tie-break; publishing every candidate is what lets a caller disagree.
 */
export const FIT_SIMPLICITY_ORDER = ["plane", "cylinder", "sphere"] as const;
export type FitKind = (typeof FIT_SIMPLICITY_ORDER)[number];

export interface FitCandidate {
  kind: FitKind;
  primitive: Primitive;
  /** Largest deviation of the region's vertices from `primitive`, in the
   * file's own units. `null` when it could not be computed — never `0`. */
  residual: number | null;
  /** `residual` over the region's bbox diagonal — scale-free. */
  residualFrac: number | null;
}

export interface MeshRegionFit {
  seedTriangle: number;
  triangleCount: number;
  /** True when the grow stopped at its size cap rather than at a real edge, so
   * the region — and every fit over it — describes only part of a surface. */
  capped: boolean;
  regionArea: number;
  regionDiagonal: number;
  freeEdgeCount: number;
  nonManifoldEdgeCount: number;
  /** Simplest-first (plane, cylinder, sphere); a shape that could not be fitted
   * is absent rather than present with a meaningless primitive. */
  candidates: FitCandidate[];
  /** The first candidate whose `residualFrac` is under
   * {@link SIMPLEST_FIT_RESIDUAL_FRAC}, or `null` if none is. Derived purely
   * from the published numbers. */
  simplest: FitKind | null;
  simplestRule: string;
  warnings: string[];
}

/**
 * The simplest candidate whose fit is good enough, by
 * {@link FIT_SIMPLICITY_ORDER} then {@link SIMPLEST_FIT_RESIDUAL_FRAC}.
 *
 * Exported and pure so the rule this result advertises is independently
 * testable — and so a caller really can recompute it from the published
 * numbers, which is the claim `simplestRule` makes. It has to be its own
 * function to be tested at all: no fixture geometry produces two sub-threshold
 * candidates at once (a flat region has no sphere candidate, because the Kasa
 * normal equations are singular for coplanar points), so the ordering can only
 * be exercised over hand-built candidates.
 */
export function simplestOf(candidates: readonly FitCandidate[]): FitKind | null {
  for (const kind of FIT_SIMPLICITY_ORDER) {
    const c = candidates.find((x) => x.kind === kind);
    if (c && c.residualFrac !== null && c.residualFrac < SIMPLEST_FIT_RESIDUAL_FRAC) return kind;
  }
  return null;
}

export interface FitMeshRegionOptions {
  angleDeg?: number;
  maxTriangles?: number;
}

/**
 * Grows a region from the triangle nearest `seedPoint` and fits all three
 * shapes to it.
 *
 * The seed is a POINT rather than a triangle index because a clicked triangle
 * is not reachable anywhere in this codebase today — the webview's picking
 * discards the intersection and keeps only `{entityType, entityId}`, and
 * host-side `rayPick` carries no triangle index either. A point matches
 * `hit_test`'s existing vocabulary and needs no new plumbing.
 */
export async function fitMeshRegion(
  bytes: Uint8Array,
  format: MeshParseFormat,
  seedPoint: readonly [number, number, number],
  options: FitMeshRegionOptions = {},
  external?: GltfExternalBuffers
): Promise<MeshRegionFit> {
  // Async purely to satisfy the kernel-worker Handler contract every Pipeline
  // member shares — the work itself is synchronous and WASM-free.
  await Promise.resolve();
  const { positions, indices } = parseToWeldedMesh(bytes, format, external);
  const warnings: string[] = [];

  const seedTriangle = nearestTriangleToPoint(positions, indices, seedPoint);
  if (seedTriangle < 0) {
    return emptyFit(seedTriangle, ["The mesh has no triangles to fit."]);
  }

  const { triangles, capped } = growRegion(positions, indices, seedTriangle, {
    angleDeg: options.angleDeg ?? DEFAULT_GROW_ANGLE_DEG,
    maxTriangles: options.maxTriangles,
  });
  if (triangles.length === 0) {
    return emptyFit(seedTriangle, ["The seed resolved to no region."]);
  }
  if (triangles.length === 1) {
    // A degenerate seed (zero-area triangle — e.g. the pole of a UV-sphere
    // tessellation, where every meridian collapses to one point) has no normal,
    // so the dihedral gate correctly refuses every neighbour and the region
    // never grows. Correct, but it would otherwise look like a legitimate
    // one-triangle surface, so say which it is.
    warnings.push(
      "The region is a single triangle — the seed triangle may be degenerate (zero area), which has no normal for the dihedral gate to compare against. Try a seed away from a tessellation pole or seam."
    );
  }
  if (capped) {
    warnings.push(
      `The region hit its ${options.maxTriangles ?? "default"} triangle cap, so it covers only part of the surface — every fit below describes that part, not the whole.`
    );
  }

  const bounds = boundsOfTriangles(positions, indices, triangles);
  const regionDiagonal = bounds ? boundsDiagonal(bounds) : 0;
  const regionArea = areaOfTriangles(positions, indices, triangles);
  const topology = analyzeMeshTopology(positions, indices, triangles);

  const points = regionPoints(positions, indices, triangles);
  const normals = regionNormals(positions, indices, triangles);

  const candidates: FitCandidate[] = [];
  const add = (kind: FitKind, primitive: Primitive | null) => {
    if (!primitive) return;
    const residual = maxDeviation(points, primitive);
    candidates.push({
      kind,
      primitive,
      residual,
      residualFrac: residual !== null && regionDiagonal > 1e-12 ? residual / regionDiagonal : null,
    });
  };

  const plane = fitPlane(points);
  add("plane", plane ? { kind: "plane", point: plane.point, normal: plane.normal } : null);

  const cyl = fitCylinder(points, normals);
  if (cyl) {
    // The fit is an INFINITE cylinder; `Primitive`'s is bounded. Clip it to the
    // region's own axial extent, or every point past the caps would read as
    // deviation and the residual would describe the clipping, not the fit.
    const [lo, hi] = axialExtent(points, cyl.point, cyl.axis);
    const height = hi - lo;
    if (height > 1e-12) {
      const base: Vec3 = [
        cyl.point[0] + cyl.axis[0] * lo,
        cyl.point[1] + cyl.axis[1] * lo,
        cyl.point[2] + cyl.axis[2] * lo,
      ];
      add("cylinder", { kind: "cylinder", base, axis: cyl.axis, radius: cyl.radius, height });
    }
  } else {
    warnings.push(
      "No cylinder fit: the region's normals do not determine an axis (a flat region's normals are all parallel, which is the honest answer rather than a cylinder of arbitrary radius)."
    );
  }

  const sph = fitSphere(points);
  add("sphere", sph ? { kind: "sphere", center: sph.center, radius: sph.radius } : null);

  candidates.sort((a, b) => FIT_SIMPLICITY_ORDER.indexOf(a.kind) - FIT_SIMPLICITY_ORDER.indexOf(b.kind));
  const simplest = simplestOf(candidates);

  return {
    seedTriangle,
    triangleCount: triangles.length,
    capped,
    regionArea,
    regionDiagonal,
    freeEdgeCount: topology.freeEdgeCount,
    nonManifoldEdgeCount: topology.nonManifoldEdgeCount,
    candidates,
    simplest,
    simplestRule: `the first of ${FIT_SIMPLICITY_ORDER.join(" < ")} whose residualFrac < ${SIMPLEST_FIT_RESIDUAL_FRAC}`,
    warnings,
  };
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

function emptyFit(seedTriangle: number, warnings: string[]): MeshRegionFit {
  return {
    seedTriangle,
    triangleCount: 0,
    capped: false,
    regionArea: 0,
    regionDiagonal: 0,
    freeEdgeCount: 0,
    nonManifoldEdgeCount: 0,
    candidates: [],
    simplest: null,
    simplestRule: `the first of ${FIT_SIMPLICITY_ORDER.join(" < ")} whose residualFrac < ${SIMPLEST_FIT_RESIDUAL_FRAC}`,
    warnings,
  };
}
