import type { MeshGrading } from "./meshOptions";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GmshApi = any;

/**
 * Pure wrappers over `gmsh.model.mesh.field.*` for the two per-Part sizing
 * mechanisms `gmshPartsMap.ts`'s `applyPartsToGmshModel` composes: a flat
 * `Constant` field (`Part.meshSize`, unchanged from before this module
 * existed — moved here verbatim, no behavior change) and a `Distance` +
 * `Threshold` pair (`Part.meshGrading`, roadmap "Boundary-layer and
 * distance-threshold mesh sizing", Phase 1). Kept in their own module (not
 * folded into `gmshPartsMap.ts`) so the field-composition logic is
 * unit-testable against a recording fake with no OCCT/entity-resolution
 * involved at all — `gmshPartsMap.ts` stays the one place that resolves
 * `face-N`/`edge-N`/`solid-N`/`point-N` ids to Gmsh tags.
 *
 * Every function here takes already-resolved Gmsh tags, grouped by
 * dimension exactly like `gmshPartsMap.ts` already groups them
 * (`volTags`/`surfTags`/`curveTags`/`pointTags`) — no id parsing, no OCCT.
 */

interface EntityTagsByDim {
  volTags: number[];
  surfTags: number[];
  curveTags: number[];
  pointTags: number[];
}

/**
 * `Part.meshSize`: a flat `Constant` field confined to the part's own
 * entities (`VIn` = the target size; `VOut` is deliberately left at Gmsh's
 * own unbounded default — see `gmshPartsMap.ts`'s original doc comment).
 * Returns the new field's tag, or `null` if none of the four tag lists is
 * non-empty (nothing to anchor the field on).
 */
export function addConstantField(gmsh: GmshApi, tags: EntityTagsByDim, size: number): number | null {
  const { volTags, surfTags, curveTags, pointTags } = tags;
  if (volTags.length === 0 && surfTags.length === 0 && curveTags.length === 0 && pointTags.length === 0) return null;
  const fieldTag = gmsh.model.mesh.field.add("Constant");
  if (volTags.length > 0) gmsh.model.mesh.field.setNumbers(fieldTag, "VolumesList", volTags);
  if (surfTags.length > 0) gmsh.model.mesh.field.setNumbers(fieldTag, "SurfacesList", surfTags);
  if (curveTags.length > 0) gmsh.model.mesh.field.setNumbers(fieldTag, "CurvesList", curveTags);
  if (pointTags.length > 0) gmsh.model.mesh.field.setNumbers(fieldTag, "PointsList", pointTags);
  gmsh.model.mesh.field.setNumber(fieldTag, "VIn", size);
  return fieldTag;
}

/**
 * `Part.meshGrading`: a `Distance` field measuring distance from the part's
 * own entities, feeding a `Threshold` field that maps that distance to an
 * element size — `sizeAtWall` within `distNear`, growing linearly to
 * `sizeFar` at `distFar`, and staying at `sizeFar` beyond it. Verified
 * against the live gmsh-wasm 0.3.0 build (see CLAUDE.md's "Distance-graded
 * sizing" section): `Distance`'s `PointsList`/`CurvesList`/`SurfacesList` +
 * `Sampling`, then `Threshold`'s `InField`/`SizeMin`/`SizeMax`/`DistMin`/
 * `DistMax`, produces a clean, monotonic node-density gradient with no
 * global `Mesh.MeshSizeExtendFromBoundary`/`FromPoints`/`FromCurvature`
 * option needed.
 *
 * **A `Distance` field cannot target a volume** — only points, curves and
 * surfaces — so `volTags` are converted to their boundary surfaces via
 * `gmsh.model.getBoundary([3, t, 3, t, ...], /*combined*\/ true, false,
 * false)` first (verified live: on a single solid this returns exactly its
 * boundary faces, signed by outward/inward orientation, which `Math.abs` here
 * discards since a `SurfacesList` tag is unsigned). Returns the new
 * `Threshold` field's tag, or `null` if there is nothing to measure distance
 * from at all (no volumes/surfaces/curves/points resolved).
 */
export function addDistanceThresholdField(gmsh: GmshApi, tags: EntityTagsByDim, grading: MeshGrading): number | null {
  const { volTags, surfTags, curveTags, pointTags } = tags;

  const boundaryFaceTags = volTags.length > 0 ? boundaryFacesOfVolumes(gmsh, volTags) : [];
  const distanceSurfTags = mergeUnique(surfTags, boundaryFaceTags);

  if (distanceSurfTags.length === 0 && curveTags.length === 0 && pointTags.length === 0) return null;

  const distTag = gmsh.model.mesh.field.add("Distance");
  if (pointTags.length > 0) gmsh.model.mesh.field.setNumbers(distTag, "PointsList", pointTags);
  if (curveTags.length > 0) gmsh.model.mesh.field.setNumbers(distTag, "CurvesList", curveTags);
  if (distanceSurfTags.length > 0) gmsh.model.mesh.field.setNumbers(distTag, "SurfacesList", distanceSurfTags);
  gmsh.model.mesh.field.setNumber(distTag, "Sampling", 20);

  const threshTag = gmsh.model.mesh.field.add("Threshold");
  gmsh.model.mesh.field.setNumber(threshTag, "InField", distTag);
  gmsh.model.mesh.field.setNumber(threshTag, "SizeMin", grading.sizeAtWall);
  gmsh.model.mesh.field.setNumber(threshTag, "SizeMax", grading.sizeFar);
  gmsh.model.mesh.field.setNumber(threshTag, "DistMin", grading.distNear);
  gmsh.model.mesh.field.setNumber(threshTag, "DistMax", grading.distFar);
  return threshTag;
}

/** `gmsh.model.getBoundary` on a set of volume tags, returning the unique
 * (unsigned) boundary surface tags. `combined: true` merges shared internal
 * faces between adjacent volumes away, matching what a Distance field over
 * "the outside of this group of solids" wants. */
function boundaryFacesOfVolumes(gmsh: GmshApi, volTags: number[]): number[] {
  const dimTagsIn: number[] = [];
  for (const t of volTags) dimTagsIn.push(3, t);
  const boundary = gmsh.model.getBoundary(dimTagsIn, true, false, false) as { outDimTags: number[] };
  const faceTags: number[] = [];
  for (let i = 0; i < boundary.outDimTags.length; i += 2) {
    if (boundary.outDimTags[i] === 2) faceTags.push(Math.abs(boundary.outDimTags[i + 1]));
  }
  return mergeUnique(faceTags, []);
}

function mergeUnique(a: number[], b: number[]): number[] {
  return Array.from(new Set([...a, ...b]));
}

/**
 * Combines every part's sizing field(s) into ONE background mesh field via
 * `Min` (Gmsh only supports a single active background field, so a second
 * `setAsBackgroundMesh` call would silently REPLACE, not add to, the first —
 * every field created by `addConstantField`/`addDistanceThresholdField` must
 * be composed here in one call). A no-op when `fieldTags` is empty (nothing
 * was sized), leaving Gmsh's own default `Mesh.MeshSizeMin`/`Max`-driven
 * sizing untouched.
 */
export function setBackgroundMin(gmsh: GmshApi, fieldTags: number[]): void {
  if (fieldTags.length === 0) return;
  const minTag = gmsh.model.mesh.field.add("Min");
  gmsh.model.mesh.field.setNumbers(minTag, "FieldsList", fieldTags);
  gmsh.model.mesh.field.setAsBackgroundMesh(minTag);
}
