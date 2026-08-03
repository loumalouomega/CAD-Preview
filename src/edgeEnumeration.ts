// Local duck-type interfaces mirroring `meshExtract.ts`'s (kept as an
// independent copy, not a shared import, so this file has no dependency on
// `meshExtract.ts` — only the reverse: `meshExtract.ts` imports the two
// functions below).
interface OcctPoint { X(): number; Y(): number; Z(): number; delete(): void; }
interface OcctDiscretizer { NbPoints(): number; Value(i: number): OcctPoint; }

/** Packs a discretizer's points into a flat xyz `Float32Array`, deleting each
 * OCCT point handle as it goes (they're not needed after copying out X/Y/Z). */
export function polylineFromDiscretizer(disc: OcctDiscretizer): Float32Array {
  const n = disc.NbPoints();
  const positions = new Float32Array(n * 3);
  for (let i = 1; i <= n; i++) {
    const pt = disc.Value(i);
    const base = (i - 1) * 3;
    positions[base] = pt.X();
    positions[base + 1] = pt.Y();
    positions[base + 2] = pt.Z();
    pt.delete();
  }
  return positions;
}

/**
 * The uniform-deflection tolerance that decides both (a) whether an edge is
 * "real" enough to expose as a distinct entity at all, and (b) how finely
 * it's discretized for display. THE single source of truth for this value —
 * previously the literal `0.1`, independently hardcoded in `meshExtract.ts`'s
 * `discretizeEdge` and `occtOperations.ts`'s `edgeHasPolyline`, which is
 * exactly the kind of drift `enumerateEdges` below exists to make impossible.
 */
export const EDGE_DEFLECTION = 0.1;

const HASH_UPPER = 1 << 30;

export interface EnumeratedEdge {
  /** Live `TopoDS_Edge` handle — owned by the caller's `cleanup` array, same
   * as every other handle `enumerateEdges` creates. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  edge: any;
  /** Already-discretized polyline (consecutive xyz points). */
  positions: Float32Array;
}

/**
 * THE single enumerator for every unique, discretizable edge of `shape`, in
 * deterministic order — the SAME order `edge-N` ids are assigned in
 * (`meshExtract.ts`'s `extractEdges`, the webview display path) and the SAME
 * order an `edge-N` id is resolved back to a live edge
 * (`occtOperations.ts`'s `collectEdges`, the op-resolution path). Both now
 * call this function directly rather than maintaining their own copies.
 *
 * This split used to be two independent, hand-duplicated implementations
 * that happened to agree only because both hardcoded the identical `0.1`
 * deflection constant — `edge-N` is a POSITIONAL index into whatever list
 * this function returns, referenced from every `.parts.json`, every
 * `fillet`/`chamfer`/`addSurfaceFromLines` operand in every `.edits.json`,
 * and every id an agent has recorded via `inspect`/`measure_exact`. The two
 * paths drifting even slightly — a different deflection, an edge kept by one
 * and dropped by the other — would silently repoint every one of those ids,
 * with no error at any layer. There must never be a second implementation of
 * this loop; see `doc/roadmap.md`'s "One shared edge/entity enumerator" item
 * for the full incident write-up this closes.
 *
 * This OCCT build does not bind `TopTools_IndexedMapOfShape`, hence the
 * manual `HashCode`+`IsSame` de-dup (a `TopExp_Explorer` over a solid visits
 * each shared edge once per adjacent face). An edge that fails to discretize
 * to ≥2 points is dropped entirely — never exposed as an entity in either
 * path — matching the behavior both hand-duplicated copies already had.
 *
 * Every live handle this creates (the explorer, every edge — both kept and
 * de-dup-tracked-but-rejected — and the per-edge curve/discretizer handles)
 * is pushed onto `cleanup`, per this codebase's OCCT memory discipline; the
 * caller deletes them all, in reverse order, in its own `finally`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function enumerateEdges(oc: any, shape: any, cleanup: Array<{ delete(): void }>): EnumeratedEdge[] {
  const out: EnumeratedEdge[] = [];
  // hashCode → list of edges already seen (TopoDS shapes) for IsSame checks.
  const seen = new Map<number, Array<{ IsSame(o: unknown): boolean }>>();

  const exp = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_EDGE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE
  );
  cleanup.push(exp);

  for (; exp.More(); exp.Next()) {
    const edge = oc.TopoDS.Edge_1(exp.Current());
    const hash = edge.HashCode(HASH_UPPER);
    const bucket = seen.get(hash);
    if (bucket && bucket.some((e) => e.IsSame(edge))) {
      edge.delete();
      continue;
    }
    // Keep this edge handle alive in `seen` for later IsSame comparisons; it
    // is released by the caller's cleanup, in reverse order, via `cleanup`.
    cleanup.push(edge);
    if (bucket) bucket.push(edge);
    else seen.set(hash, [edge]);

    const positions = discretizeEdge(oc, edge, cleanup);
    if (positions.length >= 6) {
      out.push({ edge, positions });
    }
  }
  return out;
}

/**
 * Discretizes a single edge to a flat xyz polyline via `BRepAdaptor_Curve` +
 * `GCPnts_UniformDeflection` at `EDGE_DEFLECTION` (verified against the live
 * WASM). Never throws — returns an empty array for a degenerate edge or a
 * construction failure, which `enumerateEdges` treats as "drop this edge".
 *
 * **Deliberately NOT varied by the configurable tessellation-quality feature
 * (roadmap item, closed) — investigated and rejected, not an oversight.**
 * `enumerateEdges` is the SAME enumerator `occtOperations.ts`'s `collectEdges`
 * uses to resolve an `edge-N` id back to a live edge, and the `positions.
 * length >= 6` filter just below is what decides whether an edge is kept as
 * an entity at all. If display tessellation (`extractEdges`) and op-operand
 * resolution (`collectEdges`) ever used a DIFFERENT deflection, they could
 * disagree on which edges pass that filter — silently repointing `edge-N`
 * ids between the two paths, exactly the drift hazard the shared-enumerator
 * refactor (see this file's own module doc comment) exists to prevent.
 * Correctly threading a quality-dependent deflection through `collectEdges`
 * would mean plumbing it through every `applyEditsBRep` call site across the
 * codebase (`occtOperations.ts`, `entityFacts.ts`, `modelDiffHost.ts`,
 * `massProperties.ts`, `gmshPartsMap.ts`, …) — disproportionate risk for a
 * feature whose real value (triangle density, the dominant cost for both
 * rendering and interactive responsiveness) is in FACE tessellation, not
 * edge polyline resolution. `tessellateByGroup`'s `quality` param is the
 * configurable one; this stays fixed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function discretizeEdge(oc: any, edge: any, cleanup: Array<{ delete(): void }>): Float32Array {
  try {
    const curve = new oc.BRepAdaptor_Curve_2(edge);
    cleanup.push(curve);
    const disc = new oc.GCPnts_UniformDeflection_2(curve, EDGE_DEFLECTION, false);
    cleanup.push(disc);
    if (!disc.IsDone() || disc.NbPoints() < 2) return new Float32Array(0);
    return polylineFromDiscretizer(disc);
  } catch {
    return new Float32Array(0);
  }
}

/**
 * Below this dihedral angle (degrees, between the two adjacent faces' surface
 * normals AT the shared edge), an edge is classified `smooth` — a tangent
 * continuation between two faces, not a real feature the user would call an
 * "edge" (the classic case: an imported STEP whose cylindrical/curved
 * surfaces are split into several NURBS patches draws a hard line at every
 * patch seam even though the surface is smooth there). Close to, but not
 * copied from, SketchForge-3D's own 0.75° threshold — chosen after finding a
 * real STEP fixture's genuine patch seams (`bull.stp`, 9 of its 96 edges)
 * cluster under 1° with a clean gap to the next-lowest real angle (~30°), so
 * 1° has margin on both sides without being copied from a citation.
 */
const SMOOTH_DIHEDRAL_THRESHOLD_DEG = 1.0;

/**
 * Classifies each of `edges` (already enumerated by {@link enumerateEdges},
 * in the SAME order — this function never re-derives or reorders them, only
 * annotates) as `smooth` or not (roadmap "Display-edge classification,
 * as a flag", closed). Returns a parallel `boolean[]`, never re-orders or
 * drops anything — `edge-N` id assignment stays entirely `enumerateEdges`'s
 * business, untouched by this function.
 *
 * Face adjacency (needed for the dihedral-angle test, but NOT needed by
 * `enumerateEdges` itself) is built by a SEPARATE, face-driven pass — walking
 * every face's own edges and bucketing by `HashCode`+`IsSame`, the same
 * pattern `enumerateEdges` already uses — deliberately kept independent of
 * `enumerateEdges`'s own shape-level `TopAbs_EDGE` explorer. The two
 * traversals are NOT guaranteed to visit edges in the same order (a
 * face-driven walk and a whole-shape edge walk are different algorithms), so
 * results here are correlated back to `enumerateEdges`'s edges by `IsSame`
 * identity, never by iteration-order assumption — the one thing that must
 * never regress is `edge-N`'s existing order, which this function cannot
 * influence since it takes the already-enumerated list as input.
 *
 * `TopTools_IndexedDataMapOfShapeListOfShape` and `TopExp.MapShapesAndAncestors`
 * — the "proper" OCCT tools for edge→face adjacency — are both confirmed
 * UNBOUND in this WASM build (probed directly, not assumed), hence the
 * hand-rolled bucket map. An edge with anything other than exactly 2 adjacent
 * faces (a free/boundary edge, or a non-manifold edge shared by 3+ faces) is
 * never classified smooth — there is no well-defined "tangent continuation"
 * dihedral angle for those cases, and both are genuinely real features a
 * user would want to see regardless.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function classifyEdgeSmoothness(
  oc: any,
  shape: any,
  edges: EnumeratedEdge[],
  cleanup: Array<{ delete(): void }>
): boolean[] {
  const faceExp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  cleanup.push(faceExp);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const faces: any[] = [];
  const faceSeen = new Map<number, Array<{ IsSame(o: unknown): boolean }>>();
  for (; faceExp.More(); faceExp.Next()) {
    const face = oc.TopoDS.Face_1(faceExp.Current());
    const hash = face.HashCode(HASH_UPPER);
    const bucket = faceSeen.get(hash);
    if (bucket && bucket.some((f) => f.IsSame(face))) {
      face.delete();
      continue;
    }
    cleanup.push(face);
    if (bucket) bucket.push(face);
    else faceSeen.set(hash, [face]);
    faces.push(face);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const edgeFaces = new Map<number, Array<{ edge: any; faceIdxs: number[] }>>();
  for (let fi = 0; fi < faces.length; fi++) {
    const edgeExp = new oc.TopExp_Explorer_2(faces[fi], oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    cleanup.push(edgeExp);
    for (; edgeExp.More(); edgeExp.Next()) {
      const edge = oc.TopoDS.Edge_1(edgeExp.Current());
      const hash = edge.HashCode(HASH_UPPER);
      let bucket = edgeFaces.get(hash);
      if (!bucket) {
        bucket = [];
        edgeFaces.set(hash, bucket);
      }
      let entry = bucket.find((b) => b.edge.IsSame(edge));
      if (!entry) {
        entry = { edge, faceIdxs: [] };
        bucket.push(entry);
        cleanup.push(edge);
      } else {
        edge.delete();
      }
      entry.faceIdxs.push(fi);
    }
  }

  return edges.map(({ edge }) => {
    const bucket = edgeFaces.get(edge.HashCode(HASH_UPPER));
    const entry = bucket?.find((b) => b.edge.IsSame(edge));
    if (!entry || entry.faceIdxs.length !== 2) return false;
    const angle = dihedralAngleDeg(oc, edge, faces[entry.faceIdxs[0]], faces[entry.faceIdxs[1]], cleanup);
    return angle !== null && angle < SMOOTH_DIHEDRAL_THRESHOLD_DEG;
  });
}

/**
 * The surface normal of `face` at the point where `edge` meets it — evaluated
 * via the edge's own 2D parametric curve ON that face (`BRepAdaptor_Curve2d`,
 * verified live against the WASM), not by projecting the edge's 3D midpoint
 * onto the face's surface: `GeomAPI_ProjectPointOnSurf`'s own UV-parameter
 * accessors (`Parameters`/`LowerDistanceParameters`) are confirmed UNBOUND in
 * this build ("null function or function signature mismatch"), so a 2D
 * pcurve lookup — the standard OCCT approach for exactly this "surface
 * property at a point on one of its edges" problem — is used instead. `null`
 * for any construction failure or an undefined normal (`GeomLProp_SLProps`
 * near a singular point), which the caller treats as "not smooth".
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function faceNormalAtEdge(oc: any, edge: any, face: any, cleanup: Array<{ delete(): void }>): [number, number, number] | null {
  try {
    const curve2d = new oc.BRepAdaptor_Curve2d_2(edge, face);
    cleanup.push(curve2d);
    const mid = (curve2d.FirstParameter() + curve2d.LastParameter()) / 2;
    const uv = curve2d.Value(mid);
    cleanup.push(uv);
    const surface = oc.BRep_Tool.Surface_2(face);
    const props = new oc.GeomLProp_SLProps_1(surface, uv.X(), uv.Y(), 1, 1e-6);
    cleanup.push(props);
    if (!props.IsNormalDefined()) return null;
    const normal = props.Normal();
    cleanup.push(normal);
    return [normal.X(), normal.Y(), normal.Z()];
  } catch {
    return null;
  }
}

/** The angle (degrees, 0-180) between `faceA`/`faceB`'s surface normals at
 * their shared `edge` — `null` if either normal couldn't be evaluated. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dihedralAngleDeg(oc: any, edge: any, faceA: any, faceB: any, cleanup: Array<{ delete(): void }>): number | null {
  const na = faceNormalAtEdge(oc, edge, faceA, cleanup);
  const nb = faceNormalAtEdge(oc, edge, faceB, cleanup);
  if (!na || !nb) return null;
  const dot = na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2];
  const clamped = Math.max(-1, Math.min(1, dot));
  return (Math.acos(clamped) * 180) / Math.PI;
}
