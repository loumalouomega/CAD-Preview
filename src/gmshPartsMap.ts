import type { Vec3 } from "./editOps";
import type { Part } from "./protocol";
import { getOcct, readShape, wrapOcctFault } from "./occtService";
import { resetGmsh } from "./gmshService";
import { collectFaces, collectSolids, collectVertices, bboxCenter } from "./occtOperations";
import { enumerateEdges } from "./edgeEnumeration";
import { addConstantField, addDistanceThresholdField, setBackgroundMin } from "./gmshSizingFields";
import { addFreeEntitiesToGmshModel, type FreeEntitySpec } from "./gmshEmbed";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GmshApi = any;

/** Fixed short MEMFS path — same 11-char STEP-path-length caveat as occtService.ts's
 * `exportBRep` applies here too; calls are sequential (never concurrent with
 * `loadBRep`/`exportBRep`'s own tmp files) so a fixed name is safe. */
const CORR_TMP_PATH = "/pm.step";

export interface PartGroupInfo {
  name: string;
  color: string;
}

/** Gmsh (dim,tag) -> owning part, one map per dimension — used by
 * `gmshService.ts`'s `buildIndices` to colour generated triangles by part. */
export interface PartGroupMaps {
  volumeTagToPart: Map<number, PartGroupInfo>;
  surfaceTagToPart: Map<number, PartGroupInfo>;
  curveTagToPart: Map<number, PartGroupInfo>;
  pointTagToPart: Map<number, PartGroupInfo>;
}

/**
 * Correlates each part's `face-N`/`edge-N`/`solid-N`/`point-N` ids to Gmsh
 * `(dim,tag)` entities already synchronized into `gmsh`'s in-memory model
 * (call this right after `gmsh.model.occ.importShapes(...)` +
 * `gmsh.model.occ.synchronize()` on the SAME `stepBytes`), creates one Gmsh
 * physical group per part per dimension it has resolved entities in, sets up
 * a per-part background sizing field for parts with `meshSize` and/or
 * `meshGrading` (see `gmshSizingFields.ts` for the field composition itself
 * — this function only resolves ids to tags and dispatches), and returns
 * tag -> part lookup maps.
 *
 * B-rep only — never call this for an STL-sourced `MeshGenerationInput`; Gmsh's
 * STL reclassification pipeline (`classifySurfaces`/`createGeometry`) produces
 * brand-new surface/volume tags with zero correlation to any original id.
 *
 * The correlation problem: `face-N`/`solid-N`/`edge-N`/`point-N` ids are
 * assigned by CAD-Preview's own OCCT (opencascade.js) walking `TopExp_Explorer`
 * order over the shape (`meshExtract.ts`/`occtOperations.ts`). Gmsh re-parses
 * the exported STEP bytes with its OWN, separate OCCT build baked into
 * gmsh-wasm — a different WASM module entirely, so no live shape object can be
 * shared and there is no guarantee its internal tags land in the same order
 * (`importShapes`'s `outDimTags` order is therefore NOT relied upon). Instead
 * this resolves the correspondence geometrically: each referenced OCCT
 * entity's bounding-box centre (the already-verified `bboxCenter` helper) is
 * matched against the nearest Gmsh entity of the same dimension (via
 * `gmsh.model.getBoundingBox`), within a tolerance relative to the whole
 * shape's bbox diagonal — accepted only if unambiguous (see `matchNearest`).
 * Unresolved/ambiguous entities are silently skipped, same graceful-
 * degradation convention as every other unresolved-id path in this codebase.
 *
 * The one exception to "silently skipped" is a Part's `point-N`/`edge-N` that
 * did not correlate because it is FREE wireframe geometry (an `addPoint` /
 * `addLine` / `addPolyline` op): Gmsh's OCC importer drops those from the
 * exported STEP, so there is nothing to match. They are instead created in
 * Gmsh's model directly via `gmshEmbed.ts`, which is what makes the mesher
 * put a node exactly on them. A curved free edge cannot be represented that
 * way and pushes a message onto `warnings` (an optional collector, the same
 * pattern `applyEditsBRep`'s `outcomes`/`opBuckets` use) rather than being
 * approximated.
 */
export async function applyPartsToGmshModel(
  extensionPath: string,
  gmsh: GmshApi,
  stepBytes: Uint8Array,
  parts: Part[],
  warnings?: string[]
): Promise<PartGroupMaps | null> {
  if (parts.length === 0) return null;

  const oc = await getOcct(extensionPath);
  oc.FS.writeFile(CORR_TMP_PATH, stepBytes);

  const cleanup: Array<{ delete(): void }> = [];
  try {
    const shape = readShape(oc, CORR_TMP_PATH, "step", cleanup);

    const faces = collectFaces(oc, shape, cleanup);
    // `enumerateEdges` rather than `collectEdges` (its `.map(e => e.edge)`)
    // so the per-edge discretized polyline is available below: a free
    // straight line discretizes to exactly two points, which is where the
    // Gmsh curve's endpoints come from — no extra OCCT call needed.
    const enumerated = enumerateEdges(oc, shape, cleanup);
    const edges = enumerated.map((e) => e.edge);
    const solidEntries = collectSolids(oc, shape, cleanup);
    const solids = solidEntries.map((s) => s.solid);
    const vertices = collectVertices(oc, shape, cleanup);

    const tol = Math.max(bboxDiagonal(oc, shape, cleanup) * 1e-3, 1e-6);
    const gmshCandidates = collectGmshCandidates(gmsh);

    const neededFaceIdx = new Set<number>();
    const neededEdgeIdx = new Set<number>();
    const neededSolidIdx = new Set<number>();
    const neededPointIdx = new Set<number>();
    for (const p of parts) {
      for (const id of p.surfaces) addIndex(neededFaceIdx, faceIndex(id));
      for (const id of p.lines) addIndex(neededEdgeIdx, edgeIndex(id));
      for (const id of p.volumes) addIndex(neededSolidIdx, solidIndex(id));
      for (const id of p.points) addIndex(neededPointIdx, pointIndex(id));
    }

    const faceIdToTag = new Map<string, number>();
    for (const i of neededFaceIdx) {
      const f = faces[i];
      if (!f) continue; // e.g. a stale id from before an edit-op reordered faces
      const tag = matchNearest(bboxCenter(oc, f, cleanup), gmshCandidates.get(2) ?? [], tol);
      if (tag !== null) faceIdToTag.set(`face-${i}`, tag);
    }
    const edgeIdToTag = new Map<string, number>();
    for (const i of neededEdgeIdx) {
      const e = edges[i];
      if (!e) continue;
      const tag = matchNearest(bboxCenter(oc, e, cleanup), gmshCandidates.get(1) ?? [], tol);
      if (tag !== null) edgeIdToTag.set(`edge-${i}`, tag);
    }
    const solidIdToTag = new Map<string, number>();
    for (const i of neededSolidIdx) {
      const s = solids[i];
      if (!s) continue; // e.g. the synthetic trailing "Sketches" pseudo-solid id
      const tag = matchNearest(bboxCenter(oc, s, cleanup), gmshCandidates.get(3) ?? [], tol);
      if (tag !== null) solidIdToTag.set(`solid-${i}`, tag);
    }
    const pointIdToTag = new Map<string, number>();
    for (const i of neededPointIdx) {
      const v = vertices[i];
      if (!v) continue;
      const pnt = oc.BRep_Tool.Pnt(v);
      const center: Vec3 = [pnt.X(), pnt.Y(), pnt.Z()];
      pnt.delete();
      const tag = matchNearest(center, gmshCandidates.get(0) ?? [], tol);
      if (tag !== null) pointIdToTag.set(`point-${i}`, tag);
    }

    // ---- Free entities (roadmap "Embedded points and curves").
    // A Part's `point-N`/`edge-N` that DID correlate above is real model
    // geometry and is left completely alone — that is what keeps a Part on an
    // existing vertex or edge unchanged. The ones that did NOT correlate are
    // free wireframe geometry from the `addPoint` / `addLine` / `addPolyline`
    // ops, which Gmsh's OCC importer drops from the exported STEP (measured —
    // see `gmshEmbed.ts`). Create those in the Gmsh model directly so the
    // mesher puts a node exactly on each: a load or sensor location then lands
    // on a real node instead of somewhere inside an element.
    const freeSpecs: FreeEntitySpec[] = [];
    for (const i of neededPointIdx) {
      const id = `point-${i}`;
      if (pointIdToTag.has(id)) continue;
      const v = vertices[i];
      if (!v) continue;
      const pnt = oc.BRep_Tool.Pnt(v);
      freeSpecs.push({ id, kind: "point", at: [pnt.X(), pnt.Y(), pnt.Z()] });
      pnt.delete();
    }
    for (const i of neededEdgeIdx) {
      const id = `edge-${i}`;
      if (edgeIdToTag.has(id)) continue;
      const e = enumerated[i];
      if (!e) continue;
      // Straight free edges only. `occ.addLine` takes two endpoints, so an arc
      // or spline would have to be approximated by its endpoint chord — a
      // silently wrong mesh. `addLine` and each `addPolyline` segment are
      // straight; curves are reported rather than approximated.
      const ends = straightLineEndpoints(oc, e.edge, cleanup);
      if (ends === null) {
        warnings?.push(
          `${id} is a curved free edge — only straight lines are forced onto the mesh. Rebuild it from straight segments (addLine / addPolyline), or place points along it instead.`
        );
        continue;
      }
      freeSpecs.push({ id, kind: "line", from: ends[0], to: ends[1] });
    }
    const { tags: freeTags } = addFreeEntitiesToGmshModel(gmsh, freeSpecs);
    for (const [id, tag] of freeTags) {
      if (id.startsWith("point-")) pointIdToTag.set(id, tag);
      else edgeIdToTag.set(id, tag);
    }

    const maps: PartGroupMaps = {
      volumeTagToPart: new Map(),
      surfaceTagToPart: new Map(),
      curveTagToPart: new Map(),
      pointTagToPart: new Map(),
    };
    const sizeFieldTags: number[] = [];

    for (const part of parts) {
      const info: PartGroupInfo = { name: part.name, color: part.color };
      const volTags = resolveTags(part.volumes, solidIdToTag);
      const surfTags = resolveTags(part.surfaces, faceIdToTag);
      const curveTags = resolveTags(part.lines, edgeIdToTag);
      const pointTags = resolveTags(part.points, pointIdToTag);

      // Gmsh's own default sentinel for "auto-assign a new physical tag" is -1
      // (the JS binding's `tag?: number` mirrors the Python API's `tag=-1`).
      if (volTags.length > 0) {
        gmsh.model.addPhysicalGroup(3, volTags, -1, part.name);
        for (const t of volTags) maps.volumeTagToPart.set(t, info);
      }
      if (surfTags.length > 0) {
        gmsh.model.addPhysicalGroup(2, surfTags, -1, part.name);
        for (const t of surfTags) maps.surfaceTagToPart.set(t, info);
      }
      if (curveTags.length > 0) {
        gmsh.model.addPhysicalGroup(1, curveTags, -1, part.name);
        for (const t of curveTags) maps.curveTagToPart.set(t, info);
      }
      if (pointTags.length > 0) {
        gmsh.model.addPhysicalGroup(0, pointTags, -1, part.name);
        for (const t of pointTags) maps.pointTagToPart.set(t, info);
      }

      const resolvedTags = { volTags, surfTags, curveTags, pointTags };
      const resolvedCount = volTags.length + surfTags.length + curveTags.length + pointTags.length;
      if (resolvedCount === 0) continue;

      if (part.meshSize != null) {
        const fieldTag = addConstantField(gmsh, resolvedTags, part.meshSize);
        if (fieldTag !== null) sizeFieldTags.push(fieldTag);
      }
      if (part.meshGrading != null) {
        const fieldTag = addDistanceThresholdField(gmsh, resolvedTags, part.meshGrading);
        if (fieldTag !== null) sizeFieldTags.push(fieldTag);
      }
    }

    setBackgroundMin(gmsh, sizeFieldTags);

    return maps;  } catch (err) {
    // This function touches both kernels (OCCT via `oc`, Gmsh via `gmsh.model.*`
    // above), so a WASM abort here could equally be either's fault with no
    // cheap way to attribute it — reset both conservatively. `wrapOcctFault`
    // only ever produces this specific message on a genuine detected abort
    // (see its doc comment); anything else passes through unchanged.
    const wrapped = wrapOcctFault(err);
    if (wrapped.message.startsWith("OCCT crashed")) resetGmsh();
    throw wrapped;
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try {
        cleanup[i].delete();
      } catch {
        /* ignore */
      }
    }
    try {
      oc.FS.unlink(CORR_TMP_PATH);
    } catch {
      /* ignore */
    }
  }
}

/**
 * The two endpoints of a STRAIGHT edge, as exact doubles, or `null` for a
 * curved one.
 *
 * **The endpoints must NOT be read off `enumerateEdges`' `positions`.** For a
 * straight edge that polyline IS its two endpoints — but `discretizeEdge`
 * returns a `Float32Array` (it feeds the render/wire-format path), so the
 * values are float32-quantized: measured against a line from (-0.9,-1.1,2.5),
 * the polyline's start was **3.37e-8** away from the true coordinate. That is
 * small enough to look harmless and is not: it is the difference between a
 * load node landing on the line and landing 2.4e-8 beside it, and it is
 * exactly why a curve built from the polyline produced NO node within 1e-9 of
 * the requested segment while a curve built from the true coordinates
 * produced them. Reading the curve's own parameter bounds instead gives a
 * start error of **0** and an end error of 3.8e-13 — i.e. the real double.
 *
 * The curve type is compared SYMBOLICALLY against the enum, never by a
 * hardcoded ordinal — the same convention `entityFacts.ts`'s `measureExact`
 * radius check uses, and for the same reason.
 *
 * Call shapes verified against the live WASM: `new BRepAdaptor_Curve_2(edge)`
 * takes the edge directly (`enumerateEdges` already returns `TopoDS.Edge_1`
 * casts); `FirstParameter()`/`LastParameter()` return doubles; and `Value(t)`
 * takes **exactly one** argument and returns a fresh `gp_Pnt` handle, which
 * this codebase's OCCT memory discipline requires us to `.delete()`. The
 * natural two-argument `Value(t, outPnt)` form is **not** bound ("expected 1
 * args").
 */
function straightLineEndpoints(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  oc: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  edge: any,
  cleanup: Array<{ delete(): void }>
): [Vec3, Vec3] | null {
  const curve = new oc.BRepAdaptor_Curve_2(edge);
  cleanup.push(curve);
  if (curve.GetType().value !== oc.GeomAbs_CurveType.GeomAbs_Line.value) return null;
  const a = curve.Value(curve.FirstParameter());
  const b = curve.Value(curve.LastParameter());
  cleanup.push(a, b);
  return [
    [a.X(), a.Y(), a.Z()],
    [b.X(), b.Y(), b.Z()],
  ];
}

function resolveTags(ids: string[], map: Map<string, number>): number[] {
  const tags: number[] = [];
  for (const id of ids) {
    const t = map.get(id);
    if (t !== undefined) tags.push(t);
  }
  return tags;
}

function addIndex(set: Set<number>, i: number | null): void {
  if (i !== null) set.add(i);
}

/** Every Gmsh entity's bbox-centre, cached per dimension, computed once. */
function collectGmshCandidates(gmsh: GmshApi): Map<number, Array<{ tag: number; center: Vec3 }>> {
  const byDim = new Map<number, Array<{ tag: number; center: Vec3 }>>();
  for (const dim of [0, 1, 2, 3]) {
    const dimTags = (gmsh.model.getEntities(dim).dimTags as number[]) ?? [];
    const list: Array<{ tag: number; center: Vec3 }> = [];
    for (let i = 0; i < dimTags.length; i += 2) {
      const tag = dimTags[i + 1];
      const bb = gmsh.model.getBoundingBox(dim, tag) as {
        xmin: number;
        ymin: number;
        zmin: number;
        xmax: number;
        ymax: number;
        zmax: number;
      };
      list.push({
        tag,
        center: [(bb.xmin + bb.xmax) / 2, (bb.ymin + bb.ymax) / 2, (bb.zmin + bb.zmax) / 2],
      });
    }
    byDim.set(dim, list);
  }
  return byDim;
}

/**
 * Nearest-centre match within `tol`, accepted only if unambiguous: either a
 * single candidate is within tolerance, or the best match is meaningfully
 * closer than the runner-up (< half its distance). Returns `null` (silent
 * skip, no match) otherwise.
 */
function matchNearest(center: Vec3, candidates: Array<{ tag: number; center: Vec3 }>, tol: number): number | null {
  let bestTag: number | null = null;
  let bestDist = Infinity;
  let secondDist = Infinity;
  for (const c of candidates) {
    const dist = distance(center, c.center);
    if (dist < bestDist) {
      secondDist = bestDist;
      bestDist = dist;
      bestTag = c.tag;
    } else if (dist < secondDist) {
      secondDist = dist;
    }
  }
  if (bestTag === null || bestDist >= tol) return null;
  if (secondDist < Infinity && bestDist >= 0.5 * secondDist) return null; // ambiguous
  return bestTag;
}

function distance(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** The bounding-box diagonal length of a shape (via `Bnd_Box` corners) —
 * sibling of `occtOperations.ts`'s `bboxCenter`, same underlying box. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bboxDiagonal(oc: any, shape: any, cleanup: Array<{ delete(): void }>): number {
  const box = new oc.Bnd_Box_1();
  cleanup.push(box);
  oc.BRepBndLib.Add(shape, box, false);
  const mn = box.CornerMin();
  cleanup.push(mn);
  const mx = box.CornerMax();
  cleanup.push(mx);
  const dx = mx.X() - mn.X();
  const dy = mx.Y() - mn.Y();
  const dz = mx.Z() - mn.Z();
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function faceIndex(id: string): number | null {
  const m = /^face-(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}
function edgeIndex(id: string): number | null {
  const m = /^edge-(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}
function solidIndex(id: string): number | null {
  const m = /^solid-(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}
function pointIndex(id: string): number | null {
  const m = /^point-(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}
