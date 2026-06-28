export interface GeometryBuffers {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
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

/**
 * Extracts position, (placeholder) normal, and index buffers from one OCCT face.
 *
 * @param tri  Poly_Triangulation for the face (from BRep_Tool.Triangulation)
 * @param trsf Transform from TopLoc_Location, or null when identity
 * @param isReversed Whether face orientation is TopAbs_REVERSED
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
    const n1 = t.Value(1) - 1; // convert from 1-based to 0-based
    const n2 = t.Value(2) - 1;
    const n3 = t.Value(3) - 1;
    t.delete();
    const base = (i - 1) * 3;
    if (isReversed) {
      indices[base] = n1;
      indices[base + 1] = n3;
      indices[base + 2] = n2;
    } else {
      indices[base] = n1;
      indices[base + 1] = n2;
      indices[base + 2] = n3;
    }
  }

  // Normals are computed on the webview side from the geometry (computeVertexNormals).
  const normals = new Float32Array(0);

  return { positions, normals, indices };
}

/**
 * Runs the full OCCT extraction pipeline on `shape`:
 * BRepMesh → face iteration → geometry buffers.
 *
 * Every OCCT handle created here is freed in a try/finally (reverse order).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tessellateShape(oc: any, shape: any): GeometryBuffers[] {
  const cleanup: Array<{ delete(): void }> = [];

  try {
    const mesher = new oc.BRepMesh_IncrementalMesh_2(shape, 0.1, false, 0.5, false);
    cleanup.push(mesher);

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

      const isReversed =
        face.Orientation_1().value === oc.TopAbs_Orientation.TopAbs_REVERSED.value;

      const loc = new oc.TopLoc_Location_1();
      cleanup.push(loc);

      const handle = oc.BRep_Tool.Triangulation(face, loc);
      if (handle.IsNull()) continue;

      const tri = handle.get();
      const hasTransform = !loc.IsIdentity();
      const trsf = hasTransform ? loc.Transformation() : null;
      if (trsf) cleanup.push(trsf);

      // Extract the 3×4 affine matrix from gp_Trsf once per face (Value(row,col)):
      //   cols 1-3 = scale*rotation, col 4 = translation.
      // Applying it in pure JS avoids any per-node WASM allocation.
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

      results.push(extractFaceGeometry(tri, trsfAdapter, isReversed));
    }

    return results;
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try { cleanup[i].delete(); } catch { /* ignore double-free */ }
    }
  }
}
