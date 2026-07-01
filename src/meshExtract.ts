export interface GeometryBuffers {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/** One face's triangulation plus its stable per-face entity id. */
export interface FaceMesh {
  faceId: string;
  buffers: GeometryBuffers;
}

/** One edge discretized to a polyline plus its stable per-edge entity id. */
export interface EdgeLine {
  edgeId: string;
  /** Consecutive xyz points; pairs (i, i+1) form line segments. */
  positions: Float32Array;
}

export interface SolidGroup {
  id: string;
  label: string;
  faceCount: number;
  faces: FaceMesh[];
}

/**
 * Minimal duck-type interfaces so extractFaceGeometry can be unit-tested without
 * loading the WASM. The real OCCT objects satisfy these interfaces at runtime.
 */
interface OcctPoint { X(): number; Y(): number; Z(): number; delete(): void; }
interface OcctTriangle { Value(j: 1 | 2 | 3): number; delete(): void; }
interface OcctPolyTriangulation {
  NbNodes(): number;
  NbTriangles(): number;
  Node(i: number): OcctPoint;
  Triangle(i: number): OcctTriangle;
}
interface OcctTrsf { TransformCoord(x: number, y: number, z: number): [number, number, number]; }
interface OcctDiscretizer { NbPoints(): number; Value(i: number): OcctPoint; }

/** Bucket capacity for `HashCode`-based shape de-dup (shared by face + edge dedup). */
const HASH_UPPER = 1 << 30;

/**
 * Extracts position and index buffers from one OCCT face.
 * Normals are computed on the webview side via computeVertexNormals().
 */
export function extractFaceGeometry(
  tri: OcctPolyTriangulation,
  trsf: OcctTrsf | null,
  isReversed: boolean
): GeometryBuffers {
  const nbNodes = tri.NbNodes();
  const nbTris = tri.NbTriangles();

  const positions = new Float32Array(nbNodes * 3);

  for (let i = 1; i <= nbNodes; i++) {
    const pt = tri.Node(i);
    let x = pt.X(), y = pt.Y(), z = pt.Z();
    pt.delete();
    if (trsf) {
      [x, y, z] = trsf.TransformCoord(x, y, z);
    }
    const base = (i - 1) * 3;
    positions[base] = x;
    positions[base + 1] = y;
    positions[base + 2] = z;
  }

  const indices = new Uint32Array(nbTris * 3);
  for (let i = 1; i <= nbTris; i++) {
    const t = tri.Triangle(i);
    const n1 = t.Value(1) - 1;
    const n2 = t.Value(2) - 1;
    const n3 = t.Value(3) - 1;
    t.delete();
    const base = (i - 1) * 3;
    if (isReversed) {
      indices[base] = n1; indices[base + 1] = n3; indices[base + 2] = n2;
    } else {
      indices[base] = n1; indices[base + 1] = n2; indices[base + 2] = n3;
    }
  }

  return { positions, normals: new Float32Array(0), indices };
}

/**
 * Packs a discretized edge's points into a flat xyz `Float32Array`. The points
 * are returned in curve order; the webview pairs consecutive points into the
 * segments of a `THREE.LineSegments`/`Line`.
 */
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

/** Triangulates one already-`BRepMesh`'d face, or null when it has no triangulation. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function triangulateFace(oc: any, face: any, cleanup: Array<{ delete(): void }>): GeometryBuffers | null {
  const isReversed =
    face.Orientation_1().value === oc.TopAbs_Orientation.TopAbs_REVERSED.value;

  const loc = new oc.TopLoc_Location_1();
  cleanup.push(loc);

  const handle = oc.BRep_Tool.Triangulation(face, loc);
  if (handle.IsNull()) return null;

  const tri = handle.get();
  const trsf = loc.IsIdentity() ? null : loc.Transformation();
  if (trsf) cleanup.push(trsf);

  const m = trsf
    ? [
        trsf.Value(1, 1), trsf.Value(1, 2), trsf.Value(1, 3), trsf.Value(1, 4),
        trsf.Value(2, 1), trsf.Value(2, 2), trsf.Value(2, 3), trsf.Value(2, 4),
        trsf.Value(3, 1), trsf.Value(3, 2), trsf.Value(3, 3), trsf.Value(3, 4),
      ]
    : null;

  const trsfAdapter = m
    ? {
        TransformCoord(x: number, y: number, z: number): [number, number, number] {
          return [
            m[0] * x + m[1] * y + m[2] * z + m[3],
            m[4] * x + m[5] * y + m[6] * z + m[7],
            m[8] * x + m[9] * y + m[10] * z + m[11],
          ];
        },
      }
    : null;

  return extractFaceGeometry(tri, trsfAdapter, isReversed);
}

/**
 * Extract face geometry buffers from all faces in `shape` (no BRepMesh call).
 *
 * When `claim` is given, every visited face is recorded into `claim.map`
 * (`HashCode` bucket → face handles for later `IsSame` checks) so a later
 * {@link extractFreeFaces} pass can tell which faces are already "owned" by a
 * solid. Those claimed face handles must outlive this single call (they're
 * compared again later), so they're pushed into `claim.cleanup` — the *caller's*
 * longer-lived cleanup array — instead of this function's own, which is deleted
 * when it returns.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractFacesFromShape(
  oc: any,
  shape: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  claim?: { map: Map<number, any[]>; cleanup: Array<{ delete(): void }> }
): GeometryBuffers[] {
  const cleanup: Array<{ delete(): void }> = [];
  try {
    const results: GeometryBuffers[] = [];
    const exp = new oc.TopExp_Explorer_2(
      shape,
      oc.TopAbs_ShapeEnum.TopAbs_FACE,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE
    );
    cleanup.push(exp);

    for (; exp.More(); exp.Next()) {
      const face = oc.TopoDS.Face_1(exp.Current());
      if (claim) {
        claim.cleanup.push(face);
        const hash = face.HashCode(HASH_UPPER);
        const bucket = claim.map.get(hash);
        if (bucket) bucket.push(face); else claim.map.set(hash, [face]);
      } else {
        cleanup.push(face);
      }

      const g = triangulateFace(oc, face, cleanup);
      if (g) results.push(g);
    }
    return results;
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try { cleanup[i].delete(); } catch { /* ignore */ }
    }
  }
}

/**
 * Faces of the whole `shape` NOT already present in `claimed` (`HashCode` bucket
 * + `IsSame`, matching the de-dup technique {@link extractEdges} already uses).
 * Surfaces standalone 2D profile faces (e.g. `addCircleProfile`/
 * `addRectangleProfile`/`addPolygonProfile`) that live in the model compound
 * alongside real solids — without this, `tessellateByGroup`'s solid-only pass
 * would silently drop them and they'd never become visible/pickable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractFreeFaces(oc: any, shape: any, claimed: Map<number, any[]>): GeometryBuffers[] {
  const cleanup: Array<{ delete(): void }> = [];
  try {
    const results: GeometryBuffers[] = [];
    const exp = new oc.TopExp_Explorer_2(
      shape,
      oc.TopAbs_ShapeEnum.TopAbs_FACE,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE
    );
    cleanup.push(exp);

    for (; exp.More(); exp.Next()) {
      const face = oc.TopoDS.Face_1(exp.Current());
      cleanup.push(face);
      const bucket = claimed.get(face.HashCode(HASH_UPPER));
      if (bucket && bucket.some((f) => f.IsSame(face))) continue; // owned by a solid

      const g = triangulateFace(oc, face, cleanup);
      if (g) results.push(g);
    }
    return results;
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try { cleanup[i].delete(); } catch { /* ignore */ }
    }
  }
}

/**
 * Tessellates `shape` and groups the result by solid.
 * Falls back to a single "Shape" group when the shape has no solid sub-shapes
 * (e.g. surface/shell models).
 *
 * BRepMesh is run once on the whole shape before face exploration begins.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tessellateByGroup(oc: any, shape: any): SolidGroup[] {
  const cleanup: Array<{ delete(): void }> = [];
  try {
    const mesher = new oc.BRepMesh_IncrementalMesh_2(shape, 0.1, false, 0.5, false);
    cleanup.push(mesher);

    const groups: SolidGroup[] = [];

    const solidExp = new oc.TopExp_Explorer_2(
      shape,
      oc.TopAbs_ShapeEnum.TopAbs_SOLID,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE
    );
    cleanup.push(solidExp);

    // Global face counter so faceIds are stable across reopen (explorer order is
    // deterministic for an unchanged shape) and unique across the whole model.
    let faceCounter = 0;
    const toFaceMeshes = (buffers: GeometryBuffers[]): FaceMesh[] =>
      buffers.map((b) => ({ faceId: `face-${faceCounter++}`, buffers: b }));

    // Face handles claimed by a solid are recorded here so the free-face pass
    // below (run only when solids exist) can skip them. The claimed handles are
    // pushed into THIS function's `cleanup` (not extractFacesFromShape's own,
    // per-call one) so they stay alive until the free-face IsSame comparisons run.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const claimedMap = new Map<number, any[]>();
    const claim = { map: claimedMap, cleanup };

    let idx = 0;
    for (; solidExp.More(); solidExp.Next()) {
      const solidRef = solidExp.Current();
      const faces = toFaceMeshes(extractFacesFromShape(oc, solidRef, claim));
      groups.push({
        id: `solid-${idx}`,
        label: `Solid ${idx + 1}`,
        faceCount: faces.length,
        faces,
      });
      idx++;
    }

    if (groups.length === 0) {
      // No solids at all — treat every face of the shape as one group (a bare
      // surface/shell model, or a document holding only 2D profile faces).
      const faces = toFaceMeshes(extractFacesFromShape(oc, shape));
      groups.push({ id: "solid-0", label: "Shape", faceCount: faces.length, faces });
    } else {
      // Solids exist — also surface any standalone 2D profile faces (added via
      // addCircleProfile/addRectangleProfile/addPolygonProfile) that aren't owned
      // by any solid, grouped together so they stay visible/pickable (Surf mode)
      // and usable as extrude/revolve/sweep/loft profiles. `collectFaces` in
      // occtOperations.ts mirrors this exact algorithm so face-N ids resolve to
      // the same live face on both the read and edit-replay paths.
      const freeFaces = toFaceMeshes(extractFreeFaces(oc, shape, claimedMap));
      if (freeFaces.length > 0) {
        groups.push({ id: `solid-${idx}`, label: "Sketches", faceCount: freeFaces.length, faces: freeFaces });
      }
    }

    return groups;
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try { cleanup[i].delete(); } catch { /* ignore */ }
    }
  }
}

/**
 * Discretizes every unique edge of `shape` to a polyline. A `TopExp_Explorer`
 * over a solid visits each shared edge once per adjacent face, so edges are
 * de-duplicated by HashCode bucket + `IsSame`; the first appearance (in the
 * deterministic explorer order) fixes the edgeId, keeping ids stable across
 * reopen of an unchanged file.
 *
 * This OCCT build does not bind `TopTools_IndexedMapOfShape`, hence the manual
 * de-dup. Edges are discretized independently of face triangulation via
 * `BRepAdaptor_Curve` + `GCPnts_UniformDeflection` (verified against the live WASM).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractEdges(oc: any, shape: any): EdgeLine[] {
  const cleanup: Array<{ delete(): void }> = [];
  try {
    const edges: EdgeLine[] = [];
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
      // Keep this edge handle alive in `seen` for later IsSame comparisons;
      // it is released in the finally block via `cleanup`.
      cleanup.push(edge);
      if (bucket) bucket.push(edge);
      else seen.set(hash, [edge]);

      const positions = discretizeEdge(oc, edge, cleanup);
      if (positions.length >= 6) {
        edges.push({ edgeId: `edge-${edges.length}`, positions });
      }
    }
    return edges;
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try { cleanup[i].delete(); } catch { /* ignore */ }
    }
  }
}

/** Discretizes a single edge to a flat xyz polyline. Returns empty on failure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function discretizeEdge(oc: any, edge: any, cleanup: Array<{ delete(): void }>): Float32Array {
  try {
    const curve = new oc.BRepAdaptor_Curve_2(edge);
    cleanup.push(curve);
    const disc = new oc.GCPnts_UniformDeflection_2(curve, 0.1, false);
    cleanup.push(disc);
    if (!disc.IsDone() || disc.NbPoints() < 2) return new Float32Array(0);
    return polylineFromDiscretizer(disc);
  } catch {
    return new Float32Array(0);
  }
}

/**
 * Flat tessellation — kept for unit-test compatibility.
 * New callers should prefer tessellateByGroup.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tessellateShape(oc: any, shape: any): GeometryBuffers[] {
  const cleanup: Array<{ delete(): void }> = [];
  try {
    const mesher = new oc.BRepMesh_IncrementalMesh_2(shape, 0.1, false, 0.5, false);
    cleanup.push(mesher);
    return extractFacesFromShape(oc, shape);
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try { cleanup[i].delete(); } catch { /* ignore */ }
    }
  }
}
