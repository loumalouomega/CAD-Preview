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
    // Milestones M2–M5 implement these against the live WASM. Until then they are
    // intentional no-ops so an op-list never hard-fails.
    case "boolean":
    case "fillet":
    case "chamfer":
    case "extrude":
    case "revolve":
    case "sweep":
    case "loft":
    case "explode":
    case "mate":
      return shape;
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
