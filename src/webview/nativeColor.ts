/**
 * "This material carries its own colour" — the one seam between a mesh file's
 * colours (PLY vertex colours, OBJ `.mtl` `Kd`/`map_Kd`) and the viewer's
 * Part-colour pipeline (roadmap "Mesh display fidelity").
 *
 * Without it `Viewer.setEntityColors` writes the palette face colour (or a
 * Part colour) onto every surface material, which both hides a loader-supplied
 * colour and, for a vertex-coloured material, multiplies the vertex colours by
 * a grey instead of letting them show. A material is marked once, at load
 * (`markNativeColor`), stashing what it arrived with; `applyNativeColor` then
 * lets a Part colour override it and restores the stash when the Part colour
 * goes away.
 *
 * Pure three.js, no DOM at import or call time (headless-testable).
 */

import * as THREE from "three";

interface NativeStash {
  color: number;
  vertexColors: boolean;
  map: THREE.Texture | null;
}

/**
 * The stash lives in a WeakMap, NOT `material.userData`: `Material.clone()`
 * round-trips `userData` through JSON, which cannot carry a `Texture`, and the
 * facet split clones a native material once per facet. {@link cloneNativeColor}
 * is the clone that carries the stash across.
 */
const stashes = new WeakMap<THREE.Material, NativeStash>();

/** The materials this module can mark: both carry `color`, `vertexColors`, `map`. */
export type ColourableMaterial = THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;

/** Records the material's current colour/vertexColors/map as its native look. */
export function markNativeColor(mat: ColourableMaterial): void {
  stashes.set(mat, {
    color: mat.color.getHex(),
    vertexColors: mat.vertexColors,
    map: mat.map ?? null,
  });
}

/** Whether the material was marked by {@link markNativeColor}. */
export function isNativeColor(mat: THREE.Material | undefined | null): boolean {
  return !!mat && stashes.has(mat);
}

/** Copies the native stash from one material to another (standard → flat). */
export function copyNativeColor(from: THREE.Material, to: THREE.Material): void {
  const stash = stashes.get(from);
  if (stash) stashes.set(to, { ...stash });
}

/** `mat.clone()` that keeps the native stash (one per facet in the facet split). */
export function cloneNativeColor<T extends THREE.Material>(mat: T): T {
  const copy = mat.clone() as T;
  copyNativeColor(mat, copy);
  return copy;
}

/**
 * The colour a native material should be restored to by the selection
 * highlight's direct-swap fallback (Flat mode): white when the colour comes
 * from vertex colours or a texture (the material colour is then a multiplier),
 * otherwise the stashed flat colour.
 */
export function nativeBaseHex(mat: THREE.Material): number {
  const stash = stashes.get(mat);
  if (!stash) return 0xffffff;
  return stash.vertexColors || stash.map ? 0xffffff : stash.color;
}

/**
 * Applies a Part colour over a native material, or restores the native look.
 * A Part colour REPLACES the file colour (vertex colours and the texture are
 * switched off, not multiplied into it) so a Part always reads as its swatch.
 * `needsUpdate` is set only when a shader-affecting flag actually flipped.
 */
export function applyNativeColor(mat: ColourableMaterial, partHex: number | undefined): void {
  const stash = stashes.get(mat);
  if (!stash) return;
  const wantVertex = partHex === undefined ? stash.vertexColors : false;
  const wantMap = partHex === undefined ? stash.map : null;
  const changed = mat.vertexColors !== wantVertex || (mat.map ?? null) !== wantMap;
  mat.vertexColors = wantVertex;
  mat.map = wantMap;
  mat.color.setHex(partHex === undefined ? stash.color : partHex);
  if (changed) mat.needsUpdate = true;
}
