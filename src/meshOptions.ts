/**
 * The shared, kernel-agnostic mesh-generation options model. Pure and
 * vscode-free so it unit-tests headless and is imported by both the host
 * (GMSH) and any panel wiring. Mirrors the shape of `editOps.ts`, but unlike
 * `EditOp` this is a single flat options bag rather than a discriminated
 * union, so {@link validateMeshOptions} clamps/defaults individually invalid
 * fields rather than rejecting the whole object — the object itself is only
 * rejected outright when `raw` isn't an object at all.
 */

import type { Part } from "./protocol";

export interface MeshOptions {
  dimension: 1 | 2 | 3;
  sizeMin: number;
  sizeMax: number;
  algorithm2D: number; // Mesh.Algorithm
  algorithm3D: number; // Mesh.Algorithm3D
  elementOrder: 1 | 2;
  optimize: boolean;
  stlAngle: number; // classifySurfaces angle, degrees
}

export const DEFAULT_MESH_OPTIONS: MeshOptions = {
  dimension: 3,
  sizeMin: 0,
  sizeMax: 1e22,
  algorithm2D: 6 /* Frontal-Delaunay */,
  algorithm3D: 4 /* Frontal */,
  elementOrder: 1,
  optimize: true,
  stlAngle: 40,
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Validates one raw object into a clean {@link MeshOptions}, or `null` if
 * `raw` isn't an object at all. This is the single tolerance gate for mesh
 * options: individually invalid fields fall back to the matching
 * {@link DEFAULT_MESH_OPTIONS} field rather than rejecting the whole object,
 * so a hand-edited or partially-corrupt sidecar degrades gracefully instead
 * of blocking meshing.
 */
export function validateMeshOptions(raw: unknown): MeshOptions | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const dimension: MeshOptions["dimension"] =
    o.dimension === 1 || o.dimension === 2 || o.dimension === 3 ? o.dimension : DEFAULT_MESH_OPTIONS.dimension;

  const elementOrder: MeshOptions["elementOrder"] =
    o.elementOrder === 1 || o.elementOrder === 2 ? o.elementOrder : DEFAULT_MESH_OPTIONS.elementOrder;

  const sizeMinRaw = isFiniteNumber(o.sizeMin) && o.sizeMin >= 0 ? o.sizeMin : DEFAULT_MESH_OPTIONS.sizeMin;
  const sizeMaxRaw = isFiniteNumber(o.sizeMax) && o.sizeMax >= 0 ? o.sizeMax : DEFAULT_MESH_OPTIONS.sizeMax;
  // The pair must be internally consistent; if not, fall back to the default pair.
  const sizeValid = sizeMinRaw <= sizeMaxRaw;
  const sizeMin = sizeValid ? sizeMinRaw : DEFAULT_MESH_OPTIONS.sizeMin;
  const sizeMax = sizeValid ? sizeMaxRaw : DEFAULT_MESH_OPTIONS.sizeMax;

  const algorithm2D = isFiniteNumber(o.algorithm2D) ? o.algorithm2D : DEFAULT_MESH_OPTIONS.algorithm2D;
  const algorithm3D = isFiniteNumber(o.algorithm3D) ? o.algorithm3D : DEFAULT_MESH_OPTIONS.algorithm3D;

  const optimize = typeof o.optimize === "boolean" ? o.optimize : DEFAULT_MESH_OPTIONS.optimize;

  const stlAngle =
    isFiniteNumber(o.stlAngle) && o.stlAngle > 0 && o.stlAngle < 180 ? o.stlAngle : DEFAULT_MESH_OPTIONS.stlAngle;

  return { dimension, sizeMin, sizeMax, algorithm2D, algorithm3D, elementOrder, optimize, stlAngle };
}

/**
 * STL/mesh-format sources can't get true part-preserving physical groups (see
 * `gmshPartsMap.ts`'s doc comment — Gmsh's STL reclassification pipeline
 * produces brand-new surface/volume tags with zero correlation to any
 * original id), but a narrow sizing-only degrade is still useful: if exactly
 * one part has `meshSize` set, apply it as a one-off `sizeMin`/`sizeMax`
 * override for this generate/export call only (never persisted — the caller
 * must not write the result back to the `.mesh.json` sidecar). Zero or more
 * than one part with `meshSize` set is ambiguous (which part's size should
 * win for a single merged STL volume?) — silently falls back to `options`
 * unchanged.
 */
export function applyStlPartSizeOverride(options: MeshOptions, parts: Part[]): MeshOptions {
  const withSize = parts.filter((p) => p.meshSize != null);
  if (withSize.length !== 1) return options;
  const size = withSize[0].meshSize as number;
  return { ...options, sizeMin: size, sizeMax: size };
}
