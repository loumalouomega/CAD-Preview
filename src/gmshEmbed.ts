import type { Vec3 } from "./editOps";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GmshApi = any;

/**
 * A user-placed point or straight line that a Part references but that is not
 * part of any face — i.e. free wireframe geometry produced by the `addPoint` /
 * `addLine` / `addPolyline` edit ops. Coordinates are in the model space of the
 * STEP bytes Gmsh was handed.
 */
export type FreeEntitySpec =
  | { id: string; kind: "point"; at: Vec3 }
  | { id: string; kind: "line"; from: Vec3; to: Vec3 };

export interface FreeEntityResult {
  /** Free-entity id (`point-N` / `edge-N`) -> the Gmsh tag just created. */
  tags: Map<string, number>;
}

/**
 * Creates free points/curves directly in Gmsh's in-memory OCC model, so the
 * mesher produces nodes exactly on them (roadmap "Embedded points and curves").
 *
 * **Why this exists at all, when the STEP bytes already contain the geometry —
 * measured, not assumed.** The B-rep meshing input is always a STEP re-export
 * (`resolveMeshInput` / `resolveMeshInputHeadless` -> `exportBRep(...,"step")`
 * -> `gmsh.model.occ.importShapes`). `examples/STP/block.stp` + one `addPoint`
 * + one `addLine` was exported and re-imported: OCCT's own reader recovers all
 * of it (11 vertices / 13 edges, the added point at `point-8` and the line at
 * `edge-12`, the same indices the viewer assigns) and the written STEP really
 * does contain a `VERTEX_POINT` and a curve set — but **Gmsh's OCC importer
 * drops both**: dim-0/dim-1 entity counts came back 8/12, byte-identical to the
 * plain-box control. So the entities have to be created here.
 *
 * **`gmsh.model.mesh.embed` is deliberately NOT used, although it is bound and
 * works.** Probed on the same fixture, all three arms generating in 2D at
 * `sizeMax 0.7`:
 *
 * | arm                             | nodes | node on point | nodes on line | minSICN |
 * | ------------------------------- | ----- | ------------- | -------------- | -------- |
 * | plain box (control)             | 302   | 0.0625 away   | 0              | 0.84038  |
 * | free entities added, NO embed   | 309   | 0 (exact)     | 6 (exact)      | 0.84038  |
 * | free entities added, WITH embed | 308   | 0 (exact)     | 6 (exact)      | 0.75074  |
 *
 * Gmsh meshes every model entity in its own right, so a free 0D entity becomes
 * a node and a free 1D entity gets its own 1-D mesh whose nodes the surface
 * mesher respects — the point and the curve are honoured with *no* `embed`
 * call and **identical quality to the control**. `getEmbedded(2, face)` stays
 * empty in that arm, confirming nothing was actually embedded. Calling
 * `embed` forces the surrounding surface mesh to conform to the embedded 1-D
 * mesh instead, which measurably degrades it (0.840 -> 0.751), and in 3D
 * embedding a point that lies ON a face into the *volume* produces an
 * ill-shaped tetrahedron outright (`minSICN` exactly 0, with Gmsh's own
 * "ill-shaped tets are still in the mesh" warning). A point strictly INSIDE a
 * volume also needs no embed (control 0.4496 away -> 0 exact, quality 0.3236
 * vs the control's 0.3067). So this module's whole job is the entity
 * creation; embedding is not merely unnecessary here, it is the worse tool.
 *
 * **One `occ.synchronize()` per batch, and it is safe to call a second time.**
 * `loadGeometryAndApplyOptions` already synchronized once, right after
 * `importShapes`, and by the time this runs a Part's physical groups may
 * already hold surface/curve/point tags. Probed: across the second
 * synchronize every pre-existing tag in dims 0-3 is unchanged and the new
 * entities are strictly APPENDED (dim-0 `+[9,10,11]`, dim-1 `+[13]`), with
 * `getBoundingBox`-based checks confirming a pre-existing physical group still
 * holds all 7 of its nodes and a pre-existing vertex group still holds its 1.
 *
 * **No synchronize at all when there is nothing to create** — a document whose
 * Parts reference only real model geometry never pays the second call.
 */
export function addFreeEntitiesToGmshModel(
  gmsh: GmshApi,
  specs: FreeEntitySpec[]
): FreeEntityResult {
  const tags = new Map<string, number>();
  if (specs.length === 0) return { tags };

  for (const spec of specs) {
    if (spec.kind === "point") {
      tags.set(spec.id, gmsh.model.occ.addPoint(spec.at[0], spec.at[1], spec.at[2]));
    } else {
      // A Gmsh line needs both endpoints as model points of their own. These
      // are additional dim-0 entities with no physical group — they exist only
      // to carry the curve.
      const from = gmsh.model.occ.addPoint(spec.from[0], spec.from[1], spec.from[2]);
      const to = gmsh.model.occ.addPoint(spec.to[0], spec.to[1], spec.to[2]);
      tags.set(spec.id, gmsh.model.occ.addLine(from, to));
    }
  }
  gmsh.model.occ.synchronize();
  return { tags };
}
