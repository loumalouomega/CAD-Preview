import type { EditOp, Vec3 } from "./editOps";

/**
 * Host-side (OCCT) edit engine. Folds the replayable op-list over a freshly-read
 * base `TopoDS_Shape`, returning the edited shape to tessellate + display +
 * export. The webview never sees OCCT — it only receives the re-tessellated
 * geometry, exactly as for an unedited B-rep file.
 *
 * Memory discipline (the project's top bug source): every wrapped OCCT handle
 * created while applying an op is pushed into `cleanup` and `.delete()`d in
 * reverse order by the caller's `try/finally`. The *returned* shape must NOT be
 * deleted here — its lifetime belongs to the caller, which tessellates it and
 * then frees it alongside everything in `cleanup`.
 *
 * OCCT transform API, verified against the live WASM (see CLAUDE.md):
 *   translate → `gp_Trsf.SetTranslation_1(gp_Vec_4)`
 *   rotate    → `gp_Trsf.SetRotation_1(gp_Ax1_2(pnt, dir), angleRad)`
 *   mirror    → `gp_Trsf.SetMirror_3(gp_Ax2_3(pnt, normal))`  (plane mirror)
 *   uniform scale     → `gp_Trsf.SetScale(gp_Pnt_3(center), s)`
 *   non-uniform scale → `gp_GTrsf.SetValue(r, c, v)` (1-based 3×4) + `BRepBuilderAPI_GTransform_2`
 * applied via `BRepBuilderAPI_Transform_2(shape, trsf, true).Shape()`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyEditsBRep(oc: any, baseShape: any, ops: EditOp[], cleanup: Array<{ delete(): void }>): any {
  let shape = baseShape;
  for (const op of ops) {
    shape = applyOneOp(oc, shape, op, cleanup);
  }
  return shape;
}

/** A function that returns a transformed copy of the shape/solid it is given. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Transformer = (s: any) => any;

/**
 * Applies a single op to `shape`, returning the resulting shape (possibly the
 * same handle when the op is a no-op). Unimplemented ops are skipped so a sidecar
 * authored against a newer build never hard-fails an older one.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyOneOp(oc: any, shape: any, op: EditOp, cleanup: Array<{ delete(): void }>): any {
  switch (op.op) {
    case "translate":
    case "rotate":
    case "scale":
    case "mirror": {
      const transform = makeTransformer(oc, op, cleanup);
      return transform ? transformSolids(oc, shape, op.targets, transform, cleanup) : shape;
    }
    case "boolean":
      return booleanSolids(oc, shape, op, cleanup);
    case "fillet":
    case "chamfer":
      return filletEdges(oc, shape, op, cleanup);
    case "extrude":
    case "revolve":
    case "sweep":
    case "loft":
      return featureModel(oc, shape, op, cleanup);
    case "explode":
      return explodeSolids(oc, shape, op.factor, cleanup);
    case "mate":
      return mateShape(oc, shape, op, cleanup);
    case "addBox":
    case "addSphere":
    case "addCylinder":
    case "addCone":
    case "addTorus":
    case "addPrism":
      return addPrimitive(oc, shape, op, cleanup);
    default:
      return shape;
  }
}

/** Builds the geometric transformer for a transform op, or null if unsupported. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeTransformer(oc: any, op: EditOp, cleanup: Array<{ delete(): void }>): Transformer | null {
  const push = <T extends { delete(): void }>(o: T): T => (cleanup.push(o), o);

  switch (op.op) {
    case "translate": {
      const t = push(new oc.gp_Trsf_1());
      t.SetTranslation_1(push(vec(oc, op.vec)));
      return rigid(oc, t, cleanup);
    }
    case "rotate": {
      const t = push(new oc.gp_Trsf_1());
      const ax = push(new oc.gp_Ax1_2(push(pnt(oc, op.axisPoint)), push(dir(oc, op.axisDir))));
      t.SetRotation_1(ax, (op.angleDeg * Math.PI) / 180);
      return rigid(oc, t, cleanup);
    }
    case "mirror": {
      const t = push(new oc.gp_Trsf_1());
      const ax2 = push(new oc.gp_Ax2_3(push(pnt(oc, op.planePoint)), push(dir(oc, op.planeNormal))));
      t.SetMirror_3(ax2);
      return rigid(oc, t, cleanup);
    }
    case "scale": {
      const [sx, sy, sz] = op.factors;
      if (sx === sy && sy === sz) {
        const t = push(new oc.gp_Trsf_1());
        t.SetScale(push(pnt(oc, op.center)), sx);
        return rigid(oc, t, cleanup);
      }
      // Non-uniform scale about `center`: x' = s·x + (c − s·c). `gp_GTrsf` is a
      // general 3×4 affine, applied with BRepBuilderAPI_GTransform.
      const g = push(new oc.gp_GTrsf_1());
      const [cx, cy, cz] = op.center;
      g.SetValue(1, 1, sx); g.SetValue(2, 2, sy); g.SetValue(3, 3, sz);
      g.SetValue(1, 4, cx - sx * cx);
      g.SetValue(2, 4, cy - sy * cy);
      g.SetValue(3, 4, cz - sz * cz);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (s: any) => {
        const b = push(new oc.BRepBuilderAPI_GTransform_2(s, g, true));
        return push(b.Shape());
      };
    }
    default:
      return null;
  }
}

/** Wraps a `gp_Trsf` into a transformer via `BRepBuilderAPI_Transform`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rigid(oc: any, trsf: any, cleanup: Array<{ delete(): void }>): Transformer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (s: any) => {
    const b = new oc.BRepBuilderAPI_Transform_2(s, trsf, true);
    cleanup.push(b);
    const r = b.Shape();
    cleanup.push(r);
    return r;
  };
}

/**
 * Applies `transform` to just the targeted solids, identified by the same
 * deterministic `solid-N` explorer order the read pipeline uses. When every
 * solid is targeted (or the shape has no solids, i.e. a single `solid-0`
 * surface model) the whole shape is transformed directly; otherwise a new
 * compound is assembled from the transformed targets plus the untouched rest.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transformSolids(oc: any, shape: any, targets: string[], transform: Transformer, cleanup: Array<{ delete(): void }>): any {
  const want = new Set(targets);
  const solids = collectSolids(oc, shape, cleanup);

  if (solids.length === 0) {
    return want.has("solid-0") ? transform(shape) : shape;
  }
  if (solids.every((s) => want.has(s.id))) {
    return transform(shape);
  }

  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  for (const { id, solid } of solids) {
    builder.Add(comp, want.has(id) ? transform(solid) : solid);
  }
  return comp;
}

/**
 * Combines two solid sets with a boolean operator, identified by the same stable
 * `solid-N` ids. Operand shapes are built from the selected solids (a compound
 * when more than one); the operands are removed from the model and replaced by the
 * single boolean result, with all untargeted solids preserved.
 *
 * OCCT boolean API, verified against the live WASM (see CLAUDE.md): the useful
 * overload is the `_3` constructor `new BRepAlgoAPI_{Fuse,Cut,Common}_3(s1, s2)`
 * (its 3rd `Message_ProgressRange` arg is optional and not constructible in this
 * build) → `.Shape()`. A boolean whose operands don't resolve, or that doesn't
 * complete (`IsDone()` false), is skipped so replay never hard-fails.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function booleanSolids(oc: any, shape: any, op: Extract<EditOp, { op: "boolean" }>, cleanup: Array<{ delete(): void }>): any {
  const solids = collectSolids(oc, shape, cleanup);
  const byId = new Map(solids.map((s) => [s.id, s.solid]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aShapes = op.a.map((id) => byId.get(id)).filter((s): s is any => s != null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bShapes = op.b.map((id) => byId.get(id)).filter((s): s is any => s != null);
  if (aShapes.length === 0 || bShapes.length === 0) return shape;

  const a = combineSolids(oc, aShapes, cleanup);
  const b = combineSolids(oc, bShapes, cleanup);
  const Ctor =
    op.kind === "union" ? oc.BRepAlgoAPI_Fuse_3
      : op.kind === "subtract" ? oc.BRepAlgoAPI_Cut_3
        : oc.BRepAlgoAPI_Common_3;
  const algo = new Ctor(a, b);
  cleanup.push(algo);
  if (!algo.IsDone()) return shape;
  const result = algo.Shape();
  cleanup.push(result);

  // Preserve solids not consumed by either operand.
  const used = new Set([...op.a, ...op.b]);
  const leftovers = solids.filter((s) => !used.has(s.id)).map((s) => s.solid);
  if (leftovers.length === 0) return result;

  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  builder.Add(comp, result);
  for (const s of leftovers) builder.Add(comp, s);
  return comp;
}

/** A single operand shape from one-or-more solids (compound when more than one). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function combineSolids(oc: any, shapes: any[], cleanup: Array<{ delete(): void }>): any {
  if (shapes.length === 1) return shapes[0];
  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  for (const s of shapes) builder.Add(comp, s);
  return comp;
}

/**
 * Rounds (fillet) or bevels (chamfer) the selected edges of `shape`.
 *
 * OCCT fillet/chamfer API, verified against the live WASM (see CLAUDE.md):
 *   fillet  → `new BRepFilletAPI_MakeFillet(shape, ChFi3d_FilletShape.ChFi3d_Rational)`
 *   chamfer → `new BRepFilletAPI_MakeChamfer(shape)`
 * both then `.Add_2(amount, edge)` per edge → `.Shape()` (auto-builds; `.Build()`
 * needs the unbound `Message_ProgressRange`, so rely on `.Shape()`). An op whose
 * edges don't resolve, or that doesn't complete (`IsDone()` false / `.Shape()`
 * throws), is skipped so replay never hard-fails.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function filletEdges(oc: any, shape: any, op: Extract<EditOp, { op: "fillet" | "chamfer" }>, cleanup: Array<{ delete(): void }>): any {
  const edges = collectEdges(oc, shape, cleanup);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const picked = op.edges.map((id) => edges[edgeIndex(id)]).filter((e): e is any => e != null);
  if (picked.length === 0) return shape;

  const isFillet = op.op === "fillet";
  const maker = isFillet
    ? new oc.BRepFilletAPI_MakeFillet(shape, oc.ChFi3d_FilletShape.ChFi3d_Rational)
    : new oc.BRepFilletAPI_MakeChamfer(shape);
  cleanup.push(maker);
  const amount = isFillet ? op.radius : op.distance;
  for (const e of picked) maker.Add_2(amount, e);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any;
  try {
    result = maker.Shape();
  } catch {
    return shape; // e.g. radius too large for the geometry
  }
  if (!maker.IsDone()) return shape;
  cleanup.push(result);
  return result;
}

/** Parses an `edge-N` id to its index, or -1. */
function edgeIndex(id: string): number {
  const m = /^edge-(\d+)$/.exec(id);
  return m ? Number(m[1]) : -1;
}

/** Parses a `face-N` id to its index, or -1. */
function faceIndex(id: string): number {
  const m = /^face-(\d+)$/.exec(id);
  return m ? Number(m[1]) : -1;
}

/**
 * Feature modeling: builds a new solid from a selected profile face/wire and
 * **appends** it to the model as an additional body (a compound of the existing
 * shape + the new solid) — non-destructive, B-rep only. A feature whose operands
 * don't resolve, or whose builder throws, is skipped so replay never hard-fails.
 *
 * OCCT feature API, verified against the live WASM (see CLAUDE.md):
 *   extrude → `BRepPrimAPI_MakePrism_1(face, gp_Vec_4, false, true).Shape()`
 *   revolve → `BRepPrimAPI_MakeRevol_1(face, gp_Ax1_2(pnt, dir), angleRad, false).Shape()`
 *   sweep   → `BRepOffsetAPI_MakePipe_1(spineWire, profileFace).Shape()`
 *             (spine wire `BRepBuilderAPI_MakeWire_2(edge).Wire()` from the path edge)
 *   loft    → `new BRepOffsetAPI_ThruSections(true, false, 1e-6)` + `.AddWire(
 *             BRepTools.OuterWire(face))` per profile + `.Build()` + `.Shape()`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function featureModel(oc: any, shape: any, op: EditOp, cleanup: Array<{ delete(): void }>): any {
  const solid = buildFeatureSolid(oc, shape, op, cleanup);
  if (!solid) return shape;
  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  builder.Add(comp, shape);
  builder.Add(comp, solid);
  return comp;
}

/** Builds the new solid for a feature op, or null on unresolved operands / failure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildFeatureSolid(oc: any, shape: any, op: EditOp, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    switch (op.op) {
      case "extrude": {
        const face = collectFaces(oc, shape, cleanup)[faceIndex(op.profile)];
        if (!face) return null;
        const [dx, dy, dz] = op.dir;
        const len = Math.hypot(dx, dy, dz) || 1;
        const s = op.length / len; // dir scaled so |vec| == length
        const vec = keep(new oc.gp_Vec_4(dx * s, dy * s, dz * s));
        return keep(keep(new oc.BRepPrimAPI_MakePrism_1(face, vec, false, true)).Shape());
      }
      case "revolve": {
        const face = collectFaces(oc, shape, cleanup)[faceIndex(op.profile)];
        if (!face) return null;
        const ax = keep(new oc.gp_Ax1_2(keep(pnt(oc, op.axisPoint)), keep(dir(oc, op.axisDir))));
        const angle = (op.angleDeg * Math.PI) / 180;
        return keep(keep(new oc.BRepPrimAPI_MakeRevol_1(face, ax, angle, false)).Shape());
      }
      case "sweep": {
        const faces = collectFaces(oc, shape, cleanup);
        const face = faces[faceIndex(op.profile)];
        const edge = collectEdges(oc, shape, cleanup)[edgeIndex(op.path)];
        if (!face || !edge) return null;
        const wire = keep(new oc.BRepBuilderAPI_MakeWire_2(edge)).Wire();
        keep(wire);
        return keep(keep(new oc.BRepOffsetAPI_MakePipe_1(wire, face)).Shape());
      }
      case "loft": {
        const faces = collectFaces(oc, shape, cleanup);
        const wires = op.profiles
          .map((id) => faces[faceIndex(id)])
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((f): f is any => f != null)
          .map((f) => keep(oc.BRepTools.OuterWire(f)));
        if (wires.length < 2) return null;
        const ts = keep(new oc.BRepOffsetAPI_ThruSections(true, false, 1.0e-6));
        for (const w of wires) ts.AddWire(w);
        ts.Build();
        if (!ts.IsDone()) return null;
        return keep(ts.Shape());
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Primitive creation: builds a new solid from scratch (no existing operands) and
 * **appends** it to the model as an extra body — same non-destructive
 * `compound(existing shape + new solid)` pattern as {@link featureModel}. A
 * primitive whose builder throws is skipped so replay never hard-fails.
 *
 * OCCT primitive API, verified against the live WASM (see CLAUDE.md):
 *   box      → `BRepPrimAPI_MakeBox_3(gp_Pnt_3 corner1, gp_Pnt_3 corner2)`
 *   sphere   → `BRepPrimAPI_MakeSphere_5(gp_Pnt_3 center, radius)`
 *   cylinder → `BRepPrimAPI_MakeCylinder_3(gp_Ax2_3(pnt, dir), radius, height)`
 *   cone     → `BRepPrimAPI_MakeCone_3(gp_Ax2_3(pnt, dir), radius1, radius2, height)`
 *   torus    → `BRepPrimAPI_MakeTorus_5(gp_Ax2_3(pnt, dir), majorRadius, minorRadius)`
 * (`gp_Ax2` placement means cylinder/cone/torus are addressed as an OCCT
 * `location`+`direction` pair — the base for cylinder/cone, the ring centre/normal
 * for torus. `Bnd_Box` confirms cylinder/cone are **base-centred**, matching this
 * op family's `center` semantics.) There is no OCCT "regular polygon" primitive,
 * so the N-gon prism is built manually: N points around `center` in the plane
 * perpendicular to `axis` → `BRepBuilderAPI_MakeWire_1` + `.Add_1()` per
 * `BRepBuilderAPI_MakeEdge_3(pnt, pnt)` edge → `BRepBuilderAPI_MakeFace_15(wire,
 * true)` → the already-verified `BRepPrimAPI_MakePrism_1(face, vec, false, true)`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addPrimitive(oc: any, shape: any, op: EditOp, cleanup: Array<{ delete(): void }>): any {
  const solid = buildPrimitiveSolid(oc, op, cleanup);
  if (!solid) return shape;
  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  builder.Add(comp, shape);
  builder.Add(comp, solid);
  return comp;
}

/** Builds the new primitive solid, or null on builder failure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildPrimitiveSolid(oc: any, op: EditOp, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    switch (op.op) {
      case "addBox": {
        const [cx, cy, cz] = op.center;
        const [sx, sy, sz] = op.size;
        const c1 = keep(pnt(oc, [cx - sx / 2, cy - sy / 2, cz - sz / 2]));
        const c2 = keep(pnt(oc, [cx + sx / 2, cy + sy / 2, cz + sz / 2]));
        return keep(keep(new oc.BRepPrimAPI_MakeBox_3(c1, c2)).Shape());
      }
      case "addSphere": {
        const center = keep(pnt(oc, op.center));
        return keep(keep(new oc.BRepPrimAPI_MakeSphere_5(center, op.radius)).Shape());
      }
      case "addCylinder": {
        const ax2 = keep(new oc.gp_Ax2_3(keep(pnt(oc, op.center)), keep(dir(oc, op.axis))));
        return keep(keep(new oc.BRepPrimAPI_MakeCylinder_3(ax2, op.radius, op.height)).Shape());
      }
      case "addCone": {
        const ax2 = keep(new oc.gp_Ax2_3(keep(pnt(oc, op.center)), keep(dir(oc, op.axis))));
        return keep(keep(new oc.BRepPrimAPI_MakeCone_3(ax2, op.radius1, op.radius2, op.height)).Shape());
      }
      case "addTorus": {
        const ax2 = keep(new oc.gp_Ax2_3(keep(pnt(oc, op.center)), keep(dir(oc, op.axis))));
        return keep(keep(new oc.BRepPrimAPI_MakeTorus_5(ax2, op.majorRadius, op.minorRadius)).Shape());
      }
      case "addPrism": {
        const [ux, vx] = planeBasis(op.axis);
        const points = [];
        for (let i = 0; i < op.sides; i++) {
          const a = (2 * Math.PI * i) / op.sides;
          const c = Math.cos(a) * op.radius;
          const s = Math.sin(a) * op.radius;
          points.push(keep(pnt(oc, [
            op.center[0] + c * ux[0] + s * vx[0],
            op.center[1] + c * ux[1] + s * vx[1],
            op.center[2] + c * ux[2] + s * vx[2],
          ])));
        }
        const mkWire = keep(new oc.BRepBuilderAPI_MakeWire_1());
        for (let i = 0; i < points.length; i++) {
          const edge = keep(new oc.BRepBuilderAPI_MakeEdge_3(points[i], points[(i + 1) % points.length])).Edge();
          keep(edge);
          mkWire.Add_1(edge);
        }
        if (!mkWire.IsDone()) return null;
        const wire = keep(mkWire.Wire());
        const face = keep(keep(new oc.BRepBuilderAPI_MakeFace_15(wire, true)).Face());
        const [ax, ay, az] = op.axis;
        const len = Math.hypot(ax, ay, az) || 1;
        const s = op.height / len;
        const extrudeVec = keep(new oc.gp_Vec_4(ax * s, ay * s, az * s));
        return keep(keep(new oc.BRepPrimAPI_MakePrism_1(face, extrudeVec, false, true)).Shape());
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Two unit vectors spanning the plane perpendicular to `axis` (for building the
 * N-gon prism's base polygon). Pure JS math — no OCCT handles involved.
 */
function planeBasis(axis: Vec3): [Vec3, Vec3] {
  const [ax, ay, az] = axis;
  const len = Math.hypot(ax, ay, az) || 1;
  const n: Vec3 = [ax / len, ay / len, az / len];
  // Pick a helper vector not parallel to n (avoid near-zero cross product).
  const helper: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = cross(helper, n);
  normalize(u);
  const v = cross(n, u);
  normalize(v);
  return [u, v];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): void {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  v[0] /= len; v[1] /= len; v[2] /= len;
}

/**
 * Enumerates faces in the SAME global `face-N` order `tessellateByGroup`
 * (`src/meshExtract.ts`) assigns: solids in `TopExp_Explorer` order, faces within
 * each in explorer order, with a fallback to the whole shape's faces when there are
 * no solids. (It does not replay tessellation's skip-untriangulated-faces step, so
 * in the rare degenerate-face case an index could shift — accepted.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectFaces(oc: any, shape: any, cleanup: Array<{ delete(): void }>): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  const solidExp = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_SOLID,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE
  );
  cleanup.push(solidExp);
  let anySolid = false;
  for (; solidExp.More(); solidExp.Next()) {
    anySolid = true;
    addFacesOf(oc, solidExp.Current(), out, cleanup);
  }
  if (!anySolid) addFacesOf(oc, shape, out, cleanup);
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addFacesOf(oc: any, shapeRef: any, out: any[], cleanup: Array<{ delete(): void }>): void {
  const exp = new oc.TopExp_Explorer_2(
    shapeRef,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE
  );
  cleanup.push(exp);
  for (; exp.More(); exp.Next()) {
    const face = oc.TopoDS.Face_1(exp.Current());
    cleanup.push(face);
    out.push(face);
  }
}

/**
 * Assembly **explode**: spreads every solid radially from the model's bounding-box
 * centre by `factor` (0 = no move). Each solid is translated by
 * `(solidCentre − modelCentre) · factor`; single-solid models are returned
 * unchanged. Centres are bbox centres via `Bnd_Box`/`CornerMin`/`CornerMax`
 * (`Bnd_Box.Get()` is unbound — see CLAUDE.md).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function explodeSolids(oc: any, shape: any, factor: number, cleanup: Array<{ delete(): void }>): any {
  const solids = collectSolids(oc, shape, cleanup);
  if (solids.length < 2) return shape;
  const c = bboxCenter(oc, shape, cleanup);

  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  for (const { solid } of solids) {
    const ci = bboxCenter(oc, solid, cleanup);
    const t = new oc.gp_Trsf_1();
    cleanup.push(t);
    const off = new oc.gp_Vec_4((ci[0] - c[0]) * factor, (ci[1] - c[1]) * factor, (ci[2] - c[2]) * factor);
    cleanup.push(off);
    t.SetTranslation_1(off);
    builder.Add(comp, rigid(oc, t, cleanup)(solid));
  }
  return comp;
}

/**
 * Assembly **mate**: aligns planar face `faceA` onto planar face `faceB` (opposing
 * normals), moving the solid that owns `faceA` and leaving the rest in place.
 * Verified API (see CLAUDE.md): face plane via `BRepAdaptor_Surface_2(face, true)`
 * → `GetType()===GeomAbs_Plane` → `.Plane()` (`Location()` + `Axis().Direction()`);
 * rigid motion `gp_Trsf.SetDisplacement(gp_Ax3_4(ptA, nA), gp_Ax3_4(ptB, −nB))`.
 * Non-planar faces, unresolved ids, or a failed displacement are skipped.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mateShape(oc: any, shape: any, op: Extract<EditOp, { op: "mate" }>, cleanup: Array<{ delete(): void }>): any {
  const faces = collectFaces(oc, shape, cleanup);
  const fa = faces[faceIndex(op.faceA)];
  const fb = faces[faceIndex(op.faceB)];
  if (!fa || !fb) return shape;
  const pa = facePlane(oc, fa, cleanup);
  const pb = facePlane(oc, fb, cleanup);
  if (!pa || !pb) return shape;

  const t = new oc.gp_Trsf_1();
  cleanup.push(t);
  try {
    const ax3A = new oc.gp_Ax3_4(pnt(oc, pa.pt), dir(oc, pa.nl));
    cleanup.push(ax3A);
    const ax3B = new oc.gp_Ax3_4(pnt(oc, pb.pt), dir(oc, [-pb.nl[0], -pb.nl[1], -pb.nl[2]]));
    cleanup.push(ax3B);
    t.SetDisplacement(ax3A, ax3B);
  } catch {
    return shape;
  }
  const transform = rigid(oc, t, cleanup);

  const own = owningSolid(oc, shape, fa, cleanup);
  if (!own) return transform(shape); // no solids — move the whole shape

  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  builder.Add(comp, transform(own.owner));
  for (const o of own.others) builder.Add(comp, o);
  return comp;
}

/** The bounding-box centre of a shape (via `Bnd_Box` corners). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bboxCenter(oc: any, s: any, cleanup: Array<{ delete(): void }>): Vec3 {
  const box = new oc.Bnd_Box_1();
  cleanup.push(box);
  oc.BRepBndLib.Add(s, box, false);
  const mn = box.CornerMin();
  cleanup.push(mn);
  const mx = box.CornerMax();
  cleanup.push(mx);
  return [(mn.X() + mx.X()) / 2, (mn.Y() + mx.Y()) / 2, (mn.Z() + mx.Z()) / 2];
}

/** The (point, normal) of a planar face, or null if the face is not planar. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function facePlane(oc: any, face: any, cleanup: Array<{ delete(): void }>): { pt: Vec3; nl: Vec3 } | null {
  try {
    const surf = new oc.BRepAdaptor_Surface_2(face, true);
    cleanup.push(surf);
    if (surf.GetType().value !== oc.GeomAbs_SurfaceType.GeomAbs_Plane.value) return null;
    const pln = surf.Plane();
    const loc = pln.Location();
    const axis = pln.Axis();
    const d = axis.Direction();
    const pt: Vec3 = [loc.X(), loc.Y(), loc.Z()];
    const nl: Vec3 = [d.X(), d.Y(), d.Z()];
    for (const h of [pln, loc, axis, d]) { if (h && typeof h.delete === "function") cleanup.push(h); }
    return { pt, nl };
  } catch {
    return null;
  }
}

/** The solid that contains `face` plus the remaining solids, or null if none. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function owningSolid(oc: any, shape: any, face: any, cleanup: Array<{ delete(): void }>): { owner: any; others: any[] } | null {
  const solids = collectSolids(oc, shape, cleanup);
  for (const s of solids) {
    const exp = new oc.TopExp_Explorer_2(s.solid, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    cleanup.push(exp);
    for (; exp.More(); exp.Next()) {
      const f = oc.TopoDS.Face_1(exp.Current());
      cleanup.push(f);
      if (f.IsSame(face)) {
        return { owner: s.solid, others: solids.filter((x) => x !== s).map((x) => x.solid) };
      }
    }
  }
  return null;
}

/**
 * Enumerates unique, discretizable edges in the SAME order `extractEdges`
 * (`src/meshExtract.ts`) assigns `edge-N` ids, so picked edge ids resolve to the
 * right live edge: de-dup by `HashCode` + `IsSame`, then keep only edges that
 * discretize to ≥2 points (matching extractEdges' `positions.length >= 6` filter).
 * Deduped handles are kept alive in `cleanup` so `IsSame` stays valid.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectEdges(oc: any, shape: any, cleanup: Array<{ delete(): void }>): any[] {
  const HASH_UPPER = 1 << 30;
  const seen = new Map<number, Array<{ IsSame(o: unknown): boolean }>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
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
    if (bucket && bucket.some((e) => e.IsSame(edge))) { edge.delete(); continue; }
    cleanup.push(edge);
    if (bucket) bucket.push(edge);
    else seen.set(hash, [edge]);
    if (edgeHasPolyline(oc, edge, cleanup)) out.push(edge);
  }
  return out;
}

/** True when an edge discretizes to ≥2 points (same check extractEdges applies). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function edgeHasPolyline(oc: any, edge: any, cleanup: Array<{ delete(): void }>): boolean {
  try {
    const curve = new oc.BRepAdaptor_Curve_2(edge);
    cleanup.push(curve);
    const disc = new oc.GCPnts_UniformDeflection_2(curve, 0.1, false);
    cleanup.push(disc);
    return disc.IsDone() && disc.NbPoints() >= 2;
  } catch {
    return false;
  }
}

/** Enumerates solids in deterministic explorer order, tagged `solid-N`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectSolids(oc: any, shape: any, cleanup: Array<{ delete(): void }>): Array<{ id: string; solid: any }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Array<{ id: string; solid: any }> = [];
  const exp = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_SOLID,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE
  );
  cleanup.push(exp);
  let i = 0;
  for (; exp.More(); exp.Next()) {
    const solid = oc.TopoDS.Solid_1(exp.Current());
    cleanup.push(solid);
    out.push({ id: `solid-${i++}`, solid });
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function vec(oc: any, v: Vec3): any { return new oc.gp_Vec_4(v[0], v[1], v[2]); }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pnt(oc: any, v: Vec3): any { return new oc.gp_Pnt_3(v[0], v[1], v[2]); }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dir(oc: any, v: Vec3): any { return new oc.gp_Dir_4(v[0], v[1], v[2]); }
