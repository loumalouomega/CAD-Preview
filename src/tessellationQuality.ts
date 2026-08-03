/**
 * Tessellation quality presets (roadmap "Configurable tessellation quality",
 * closed) — the linear/angular deflection pair fed to
 * `BRepMesh_IncrementalMesh_2` (`src/meshExtract.ts`) and the edge-polyline
 * deflection fed to `GCPnts_UniformDeflection_2` (`src/edgeEnumeration.ts`).
 * Pure and vscode-free so it unit-tests headless, mirroring
 * `viewerDefaults.ts`'s parse-vs-store split — `provider.ts` reads the raw
 * `cadPreview.tessellationQuality` setting and passes it through
 * {@link normalizeTessellationQuality} before using it.
 *
 * `"standard"` is BYTE-FOR-BYTE the previous hardcoded constants (linear
 * 0.1, angular 0.5 rad) and remains the default — an existing document with
 * no explicit choice re-tessellates identically to before this feature
 * existed. `"draft"`/`"fine"` are new, opt-in alternatives; the numbers
 * follow the same relative spacing SketchForge-3D's own draft/standard/fine
 * tiers use (roughly 2x coarser / 3x finer than standard), not copied
 * verbatim — SketchForge's own "standard" (linear 0.055) is finer than this
 * codebase's existing default, and changing the DEFAULT's actual density
 * would be a real behavior change for every existing document, not just a
 * new option.
 */

export type TessellationQuality = "draft" | "standard" | "fine";

export interface TessellationParams {
  linearDeflection: number;
  angularDeflectionRad: number;
}

export const TESSELLATION_PRESETS: Record<TessellationQuality, TessellationParams> = {
  draft: { linearDeflection: 0.2, angularDeflectionRad: 0.6 },
  standard: { linearDeflection: 0.1, angularDeflectionRad: 0.5 },
  fine: { linearDeflection: 0.03, angularDeflectionRad: 0.15 },
};

export const DEFAULT_TESSELLATION_QUALITY: TessellationQuality = "standard";

/** Tolerant validator, same style as `normalizeViewerDefaults`: an
 * unrecognized/missing value falls back to the default rather than throwing. */
export function normalizeTessellationQuality(raw: unknown): TessellationQuality {
  return raw === "draft" || raw === "standard" || raw === "fine" ? raw : DEFAULT_TESSELLATION_QUALITY;
}

export function tessellationParamsFor(quality: TessellationQuality): TessellationParams {
  return TESSELLATION_PRESETS[quality];
}
