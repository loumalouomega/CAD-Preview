/**
 * `hit_test` — the missing inverse of `render_snapshot`.
 *
 * An agent could go from an entity id to a picture, but never from something it
 * saw in a picture back to an entity id. This closes that loop: fire a ray, get
 * the entity it strikes, plus where and (for a face) which way that surface
 * points — enough to aim the next snapshot at it.
 *
 * Host-side, with **no browser**: `loadBRep` gives the same tessellation the
 * webview would raycast, so there is no reason to pay a Chromium launch, and
 * unlike a harness-based implementation this has no `supported: false` path at
 * all. See `rayPick.ts` for the fuller rationale.
 */

import { loadBRep } from "./occtService";
import type { BRepFormat } from "./entityFacts";
import type { EditOp } from "./editOps";
import { rayPick, type PickEntityType, type RayHit, type Vec3 } from "./rayPick";
import { TESSELLATION_PRESETS, type TessellationParams } from "./tessellationQuality";

export interface HitTestRay {
  origin: Vec3;
  direction: Vec3;
}

export interface HitTestOptions {
  mode?: PickEntityType | "any";
  focus?: string[];
  hide?: string[];
  /**
   * Edge/point pick tolerance in model units. Defaults to 1% of the model's
   * bounding-box diagonal — the same proportional-to-model-size convention the
   * interactive viewer's own `pickThreshold` uses, so a hit test behaves the
   * same on a 5 mm screw and a 3 m frame.
   */
  tolerance?: number;
  quality?: TessellationParams;
}

export interface HitTestResult {
  /** One entry per input ray, in order; `null` where the ray struck nothing. */
  hits: (RayHit | null)[];
  /** The tolerance actually used, so a caller can see what "near" meant. */
  tolerance: number;
}

/**
 * Picks each ray against the model with `ops` replayed.
 *
 * Takes a LIST of rays deliberately: parsing and replaying the model is by far
 * the dominant cost, and answering ten rays in one call pays it once. A single
 * ray is just a list of one.
 */
export async function hitTest(
  extensionPath: string,
  bytes: Uint8Array,
  format: BRepFormat,
  ops: EditOp[],
  rays: HitTestRay[],
  options: HitTestOptions = {}
): Promise<HitTestResult> {
  const loaded = await loadBRep(extensionPath, bytes, format, ops, options.quality ?? TESSELLATION_PRESETS.standard);

  const geometry = {
    groups: loaded.groups.map((g) => ({
      id: g.id,
      faces: g.faces.map((f) => ({ faceId: f.faceId, buffers: f.buffers })),
    })),
    edges: loaded.edges.map((e) => ({ edgeId: e.edgeId, positions: e.positions })),
    points: loaded.points.map((p) => ({ pointId: p.pointId, position: p.position })),
  };

  const tolerance = options.tolerance ?? defaultTolerance(geometry);
  const hits = rays.map((ray) =>
    rayPick(geometry, ray.origin, ray.direction, {
      mode: options.mode,
      focus: options.focus,
      hide: options.hide,
      tolerance,
    })
  );
  return { hits, tolerance };
}

/** 1% of the model's bbox diagonal; `0` for an empty model (nothing to hit). */
function defaultTolerance(geometry: {
  groups: { faces: { buffers: { positions: Float32Array } }[] }[];
}): number {
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const group of geometry.groups) {
    for (const face of group.faces) {
      const p = face.buffers.positions;
      for (let i = 0; i + 2 < p.length; i += 3) {
        for (let axis = 0; axis < 3; axis++) {
          if (p[i + axis] < min[axis]) min[axis] = p[i + axis];
          if (p[i + axis] > max[axis]) max[axis] = p[i + axis];
        }
      }
    }
  }
  if (!Number.isFinite(min[0])) return 0;
  const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  return diagonal * 0.01;
}
