import * as THREE from "three";
import { bucketSummary, type OpBucket } from "../opBuckets";

/**
 * Per-band operation-preview colouring (the same-named roadmap feature) — the pure half.
 * The draft op's own bucket comes back on `opPreviewResult.opBuckets` with
 * a replay-tail-relative `op` index (the same convention `opOutcomes`
 * already uses: the replay list is `[...tailOps, draft]`, so the draft is
 * always the LAST entry). Missing/empty bucket (skipped op,
 * non-topology-changing op, mesh path) means no per-band data — the caller
 * falls back to today's uniform intent tint (the neutral fallback).
 *
 * Pure and vscode/OCCT/THREE-free, unit-tested (the `opBuckets.ts` split).
 */
export type PreviewTintName = "green" | "red" | "blue" | "highlighted";

/** The draft op's own bucket, or null when there is nothing to band. */
export function draftBucketFor(buckets: OpBucket[] | undefined, replayLength: number): OpBucket | null {
  if (!buckets || replayLength <= 0) return null;
  const found = buckets.find((b) => b.op === replayLength - 1);
  if (!found) return null;
  const ids = Object.values(found.roles ?? {}).flat();
  return ids.length > 0 ? found : null;
}

/** Every face id the bucket classifies — the membership set for tinting. */
export function bandFaceIds(bucket: OpBucket): Set<string> {
  return new Set(Object.values(bucket.roles ?? {}).flat());
}

/**
 * Status-line legend for a per-band preview, e.g.
 * `"Preview op 5 — green: end cap ×1, side walls ×4; grey: retained"`.
 * `fullOpOneBased` is the 1-based FULL-history op number
 * (`savePoint + replayLength`) — never the raw replay-tail index, which
 * would name the wrong row after a same-format save-in-place.
 */
export function previewBandLegend(
  bucket: OpBucket,
  fullOpOneBased: number,
  tint: PreviewTintName
): string {
  const summary = bucketSummary(bucket.roles);
  const bandWord = tint === "highlighted" ? "highlighted" : tint;
  return `Preview op ${fullOpOneBased} — ${bandWord}: ${summary}; grey: retained`;
}

/** Display word for an intent tint (`setOpPreview`'s `"add" | "cut" | "ref"`). */
export function tintDisplayName(tint: "add" | "cut" | "ref" | undefined): PreviewTintName {
  return tint === "add" ? "green" : tint === "cut" ? "red" : tint === "ref" ? "blue" : "highlighted";
}

export const PREVIEW_TINTS = { add: 0x2fbf4f, cut: 0xe23b3b, ref: 0x3b82f6 } as const;
/** Desaturated context grey for retained (non-band) preview faces. */
export const PREVIEW_CONTEXT_GREY = 0x8a8f98;
/** Opacity factors, composed through each material's `baseOpacity` (never a
 * raw assignment — the one-writer convention `highlightGroup` established). */
export const PREVIEW_BAND_OPACITY = 0.75;
export const PREVIEW_CONTEXT_OPACITY = 0.45;

/**
 * Applies the intent tint + translucency to a preview group's face
 * materials. Faces in `bandFaceIds` keep the full-strength treatment;
 * everything else recedes to grey at higher transparency. A null/empty set
 * reproduces the pre-per-band uniform treatment exactly (the neutral
 * fallback). Edges/points are untouched — buckets classify faces only.
 *
 * Pure THREE math (colour lerp, opacity factors) — no renderer or DOM, so
 * this is unit-testable headless with real materials; `Viewer.setOpPreview`
 * is the thin caller that owns scene add/remove/dispose.
 */
export function applyPreviewTint(
  obj: THREE.Object3D,
  tint: "add" | "cut" | "ref" | undefined,
  bandFaceIds: Set<string> | null
): void {
  const target = tint ? new THREE.Color(PREVIEW_TINTS[tint]) : null;
  const grey = new THREE.Color(PREVIEW_CONTEXT_GREY);
  obj.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const inBand =
      !bandFaceIds || bandFaceIds.size === 0
        ? true
        : typeof o.userData.entityId === "string" && bandFaceIds.has(o.userData.entityId);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats as THREE.MeshStandardMaterial[]) {
      // Color lerp toward the intent colour; no tint leaves the geometry's
      // own colours untouched (neutral band).
      if (inBand) {
        if (target) m.color.lerp(target, 0.65);
      } else {
        m.color.lerp(grey, 0.55);
      }
      const base = (m.userData.baseOpacity as number | undefined) ?? 1;
      m.opacity = base * (inBand ? PREVIEW_BAND_OPACITY : PREVIEW_CONTEXT_OPACITY);
      m.transparent = true;
      m.needsUpdate = true;
    }
  });
}
