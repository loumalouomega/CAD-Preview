import type { EditOp, Vec3, OpOutcome, OutcomeFail } from "./editOps";
// TYPE-ONLY, and that is load-bearing: `entityFacts.ts` imports this module
// at runtime, so a value import here would close a genuine require() cycle in
// the CJS bundle.
import type { SurfaceType, SurfaceParams } from "./entityFacts";
import { enumerateEdges } from "./edgeEnumeration";

/** Bucket capacity for `HashCode`-based shape de-dup (shared by face + vertex dedup; edge dedup has its own copy in `edgeEnumeration.ts`). */
const HASH_UPPER = 1 << 30;

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
export function applyEditsBRep(oc: any, baseShape: any, ops: EditOp[], cleanup: Array<{ delete(): void }>, outcomes?: OpOutcome[]): any {
  let shape = baseShape;
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    const before = shape;
    const outcome: OpOutcome = { index, kind: op.op, applied: true };
    // First `fail` call wins for this op; every helper calls it immediately
    // before returning the unmodified shape at a skip site.
    const fail: OutcomeFail = (diagnostic, hint) => {
      if (!outcome.applied) return;
      outcome.applied = false;
      outcome.diagnostic = diagnostic;
      if (hint) outcome.hint = hint;
    };
    try {
      shape = applyOneOp(oc, shape, op, cleanup, fail);
    } catch (err) {
      // A helper's own builder throws are caught internally; reaching here is
      // an unexpected fault. Record it, then re-throw to preserve the existing
      // "a hard kernel error fails the whole load" behavior.
      fail(`threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
      outcomes?.push(outcome);
      throw err;
    }
    // Every helper signals a skip by returning the SAME shape handle (its own
    // documented convention), so identity is the universal backstop for any
    // skip site without its own `fail` reason yet.
    if (outcome.applied && shape === before) {
      fail("returned the model unchanged");
    }
    outcomes?.push(outcome);
  }
  return shape;
}

/** A function that returns a transformed copy of the shape/solid it is given. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Transformer = (s: any) => any;

/**
 * Applies a single op to `shape`, returning the resulting shape (possibly the
 * same handle when the op is a no-op). Unimplemented ops are skipped so a sidecar
 * authored against a newer build never hard-fails an older one. A skip calls
 * `fail` with a reason (see {@link OpOutcome}) before returning.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyOneOp(oc: any, shape: any, op: EditOp, cleanup: Array<{ delete(): void }>, fail: OutcomeFail): any {
  switch (op.op) {
    case "translate":
    case "rotate":
    case "scale":
    case "mirror": {
      const transform = makeTransformer(oc, op, cleanup);
      return transform ? transformSolids(oc, shape, op.targets, transform, cleanup, fail) : shape;
    }
    case "boolean":
      return booleanSolids(oc, shape, op, cleanup, fail);
    case "fillet":
    case "chamfer":
      return filletEdges(oc, shape, op, cleanup, fail);
    case "extrude":
    case "revolve":
    case "sweep":
    case "loft":
      return featureModel(oc, shape, op, cleanup, fail);
    case "explode":
      return explodeSolids(oc, shape, op.factor, cleanup, fail);
    case "mate":
      return mateShape(oc, shape, op, cleanup, fail);
    case "shell":
      return shellSolids(oc, shape, op, cleanup, fail);
    case "splitByPlane":
      return splitSolidsByPlane(oc, shape, op, cleanup, fail);
    case "section":
      return sectionSolids(oc, shape, op, cleanup, fail);
    case "addBox":
    case "addSphere":
    case "addCylinder":
    case "addCone":
    case "addTorus":
    case "addPrism":
    case "addWedge":
      return addPrimitive(oc, shape, op, cleanup, fail);
    case "addHole":
    case "addCounterboreHole":
    case "addCountersinkHole":
      return cutHole(oc, shape, op, cleanup, fail);
    case "addCircleProfile":
    case "addRectangleProfile":
    case "addPolygonProfile":
    case "addEllipseProfile":
    case "addRoundedRectangleProfile":
    case "addSlotProfile":
    case "addTrapezoidProfile":
      return addProfile(oc, shape, op, cleanup, fail);
    case "addPoint":
    case "addLine":
    case "addArc":
    case "addPolyline":
    case "addThreePointArc":
    case "addSpline":
    case "addBezier":
    case "addEllipseArc":
    case "addHelix":
      return addWireframePrimitive(oc, shape, op, cleanup, fail);
    case "addSurfaceFromLines":
      return addSurfaceFromLines(oc, shape, op, cleanup, fail);
    case "addVolumeFromSurfaces":
      return addVolumeFromSurfaces(oc, shape, op, cleanup, fail);
    case "align":
      return alignSolids(oc, shape, op, cleanup, fail);
    case "patternLinear":
      return patternLinear(oc, shape, op, cleanup, fail);
    case "patternCircular":
      return patternCircular(oc, shape, op, cleanup, fail);
    default:
      // Exhaustive over the current union — reachable only against a sidecar
      // authored on a NEWER build (the tolerant-replay case this guards).
      fail(`op kind "${(op as { op: string }).op}" is not implemented in this build`);
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

/**
 * Uniformly scales `shape` about the origin by `factor` — the geometric half
 * of "unit conversion on export" (`src/occtService.ts`'s `exportBRep`), reusing
 * the exact verified `gp_Trsf.SetScale` + `BRepBuilderAPI_Transform` call
 * shape the `"scale"` edit op above already uses. Scaling about the origin
 * (not the shape's centroid, and not exposed as a per-op `center` the way the
 * edit op is) is deliberate: unit conversion means "multiply every coordinate
 * by this factor," not "resize the shape around some point" — scaling about
 * any other point would also translate the shape.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function scaleShapeForExport(oc: any, shape: any, factor: number, cleanup: Array<{ delete(): void }>): any {
  const push = <T extends { delete(): void }>(o: T): T => (cleanup.push(o), o);
  const t = push(new oc.gp_Trsf_1());
  t.SetScale(push(new oc.gp_Pnt_3(0, 0, 0)), factor);
  return rigid(oc, t, cleanup)(shape);
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
function transformSolids(oc: any, shape: any, targets: string[], transform: Transformer, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const want = new Set(targets);
  const solids = collectSolids(oc, shape, cleanup);

  if (solids.length === 0) {
    if (want.has("solid-0")) return transform(shape);
    fail?.(`none of the target ids (${[...want].join(", ")}) resolve — the model has no solids`);
    return shape;
  }
  if (solids.every((s) => want.has(s.id))) {
    return transform(shape);
  }
  const targeted = solids.filter((s) => want.has(s.id));
  if (targeted.length === 0) {
    fail?.(
      `none of the target ids (${[...want].join(", ")}) resolve to a solid`,
      "re-check solid-N ids after topology-changing ops — load_model re-lists them"
    );
    return shape;
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

const AXIS_INDEX: Record<"x" | "y" | "z", 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

/**
 * Translates each targeted solid along `op.axis` so its OWN bbox `op.extent`
 * (min/center/max) lands at the absolute coordinate `op.to`. Deliberately
 * ALWAYS aligns every targeted solid independently — unlike `transformSolids`
 * above, there is no "transform the whole shape as one unit" fast path even
 * when every solid is targeted, since that would use the COMBINED bbox
 * extent of all solids together rather than each solid's own extent,
 * silently changing behavior based on how many solids happen to be
 * selected. A solid already at the target coordinate (`|delta| < 1e-9`) is
 * left untouched rather than producing a wasted zero-length transform.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function alignSolids(oc: any, shape: any, op: Extract<EditOp, { op: "align" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const solids = collectSolids(oc, shape, cleanup);
  const want = new Set(op.targets);
  const idx = AXIS_INDEX[op.axis];
  let moved = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const alignOne = (s: any): any => {
    const ext = bboxExtent(oc, s, cleanup);
    const current = op.extent === "min" ? ext.min[idx] : op.extent === "max" ? ext.max[idx] : (ext.min[idx] + ext.max[idx]) / 2;
    const delta = op.to - current;
    if (Math.abs(delta) < 1e-9) return s;
    moved++;
    const v: Vec3 = [0, 0, 0];
    v[idx] = delta;
    const t = new oc.gp_Trsf_1();
    cleanup.push(t);
    t.SetTranslation_1(vec(oc, v));
    return rigid(oc, t, cleanup)(s);
  };

  if (solids.length === 0) {
    if (want.has("solid-0")) return alignOne(shape);
    fail?.(`none of the target ids (${[...want].join(", ")}) resolve — the model has no solids`);
    return shape;
  }
  if (!solids.some((s) => want.has(s.id))) {
    fail?.(
      `none of the target ids (${[...want].join(", ")}) resolve to a solid`,
      "re-check solid-N ids after topology-changing ops — load_model re-lists them"
    );
    return shape;
  }

  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  for (const { id, solid } of solids) {
    builder.Add(comp, want.has(id) ? alignOne(solid) : solid);
  }
  if (moved === 0) {
    // Every targeted solid was already at the requested coordinate.
    fail?.(`all targeted solids are already ${op.extent}-aligned to ${op.to} on ${op.axis}`);
  }
  return comp;
}

/**
 * Shared linear/circular-pattern assembly: keeps every targeted solid in
 * place AND appends `count - 1` additional copies (`copyAt(solid, k)` for
 * k = 1..count-1) alongside the untouched rest — a hybrid of
 * `transformSolids`'s "resolve targets" and `addPrimitive`'s "compound
 * (existing + new)" append, since pattern is the one op family that needs
 * both at once (every other transform op replaces a target in place; every
 * other append op has no pre-existing target to keep).
 */
function patternSolids(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  oc: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shape: any,
  targets: string[],
  count: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  copyAt: (solid: any, k: number) => any,
  cleanup: Array<{ delete(): void }>,
  fail?: OutcomeFail
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const solids = collectSolids(oc, shape, cleanup);
  const want = new Set(targets);

  if (count < 2) {
    fail?.(`count is ${count} — a pattern's count INCLUDES the original, so fewer than 2 instances adds no copies`);
    return shape;
  }

  if (solids.length === 0) {
    if (!want.has("solid-0")) {
      fail?.(`none of the target ids (${[...want].join(", ")}) resolve — the model has no solids`);
      return shape;
    }
    const comp = new oc.TopoDS_Compound();
    cleanup.push(comp);
    const builder = new oc.BRep_Builder();
    cleanup.push(builder);
    builder.MakeCompound(comp);
    builder.Add(comp, shape);
    for (let k = 1; k < count; k++) builder.Add(comp, copyAt(shape, k));
    return comp;
  }

  const targeted = solids.filter((s) => want.has(s.id));
  if (targeted.length === 0) {
    fail?.(
      `none of the target ids (${[...want].join(", ")}) resolve to a solid`,
      "re-check solid-N ids after topology-changing ops — load_model re-lists them"
    );
    return shape;
  }

  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  for (const { id, solid } of solids) {
    if (!want.has(id)) {
      builder.Add(comp, solid);
      continue;
    }
    builder.Add(comp, solid); // original, kept in place
    for (let k = 1; k < count; k++) builder.Add(comp, copyAt(solid, k));
  }
  return comp;
}

/** Linear array: `op.count` total instances (the original plus `count - 1` new
 * copies), each `op.spacing` further along the normalized `op.direction`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function patternLinear(oc: any, shape: any, op: Extract<EditOp, { op: "patternLinear" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const [dx, dy, dz] = op.direction;
  const len = Math.hypot(dx, dy, dz);
  const unit: Vec3 = [dx / len, dy / len, dz / len];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const copyAt = (s: any, k: number): any => {
    const v: Vec3 = [unit[0] * op.spacing * k, unit[1] * op.spacing * k, unit[2] * op.spacing * k];
    const t = new oc.gp_Trsf_1();
    cleanup.push(t);
    t.SetTranslation_1(vec(oc, v));
    return rigid(oc, t, cleanup)(s);
  };
  return patternSolids(oc, shape, op.targets, op.count, copyAt, cleanup, fail);
}

/** Circular array: `op.count` total instances (the original plus `count - 1`
 * new copies), each a further `op.angleDeg` rotated about the axis through
 * `op.axisPoint` along `op.axisDir`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function patternCircular(oc: any, shape: any, op: Extract<EditOp, { op: "patternCircular" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const angleRad = (op.angleDeg * Math.PI) / 180;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const copyAt = (s: any, k: number): any => {
    const t = new oc.gp_Trsf_1();
    cleanup.push(t);
    const ax = new oc.gp_Ax1_2(pnt(oc, op.axisPoint), dir(oc, op.axisDir));
    cleanup.push(ax);
    t.SetRotation_1(ax, angleRad * k);
    return rigid(oc, t, cleanup)(s);
  };
  return patternSolids(oc, shape, op.targets, op.count, copyAt, cleanup, fail);
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
function booleanSolids(oc: any, shape: any, op: Extract<EditOp, { op: "boolean" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const solids = collectSolids(oc, shape, cleanup);
  const byId = new Map(solids.map((s) => [s.id, s.solid]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aShapes = op.a.map((id) => byId.get(id)).filter((s): s is any => s != null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bShapes = op.b.map((id) => byId.get(id)).filter((s): s is any => s != null);
  if (aShapes.length === 0 || bShapes.length === 0) {
    fail?.(
      `operand ${aShapes.length === 0 ? "A" : "B"} ids (${(aShapes.length === 0 ? op.a : op.b).join(", ")}) did not resolve to solids`,
      "re-check solid-N ids after topology-changing ops — load_model re-lists them"
    );
    return shape;
  }

  const a = combineSolids(oc, aShapes, cleanup);
  const b = combineSolids(oc, bShapes, cleanup);
  const Ctor =
    op.kind === "union" ? oc.BRepAlgoAPI_Fuse_3
      : op.kind === "subtract" ? oc.BRepAlgoAPI_Cut_3
        : oc.BRepAlgoAPI_Common_3;
  const algo = new Ctor(a, b);
  cleanup.push(algo);
  if (!algo.IsDone()) {
    fail?.(`the ${op.kind} boolean did not complete (IsDone() false)`, "operands may not intersect or may be degenerate");
    return shape;
  }
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

/**
 * Cuts a hole (plain / counterbored / countersunk) into the target solids: the
 * tool solid — a cylinder, optionally fused (`BRepAlgoAPI_Fuse_3`) with a wider
 * mouth cylinder (counterbore) or a mouth cone (countersink) — is subtracted
 * via the already-verified `BRepAlgoAPI_Cut_3`, and the result replaces the
 * targets in a rebuilt compound alongside the untargeted solids (the exact
 * {@link booleanSolids} skeleton). Unresolved targets / a failed tool build /
 * `IsDone()` false all skip gracefully.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cutHole(oc: any, shape: any, op: Extract<EditOp, { op: "addHole" | "addCounterboreHole" | "addCountersinkHole" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const solids = collectSolids(oc, shape, cleanup);
  const byId = new Map(solids.map((s) => [s.id, s.solid]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const targets = op.targets.map((id) => byId.get(id)).filter((s): s is any => s != null);
  if (targets.length === 0) {
    fail?.(
      `target ids (${op.targets.join(", ")}) did not resolve to solids`,
      "re-check solid-N ids after topology-changing ops — load_model re-lists them"
    );
    return shape;
  }

  const tool = buildHoleTool(oc, op, cleanup);
  if (!tool) {
    fail?.("the hole's cutting tool could not be built", "check radius/depth values are positive and the axis is a non-zero direction");
    return shape;
  }

  const a = combineSolids(oc, targets, cleanup);
  const algo = new oc.BRepAlgoAPI_Cut_3(a, tool);
  cleanup.push(algo);
  if (!algo.IsDone()) {
    fail?.("the hole subtraction did not complete (IsDone() false)", "the hole may lie entirely outside the target solid");
    return shape;
  }
  const result = algo.Shape();
  cleanup.push(result);

  const used = new Set(op.targets);
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

/** Builds the hole's tool solid (to subtract), or null on builder failure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildHoleTool(oc: any, op: Extract<EditOp, { op: "addHole" | "addCounterboreHole" | "addCountersinkHole" }>, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    const ax2 = keep(new oc.gp_Ax2_3(keep(pnt(oc, op.position)), keep(dir(oc, op.axis))));
    const main = keep(keep(new oc.BRepPrimAPI_MakeCylinder_3(ax2, op.radius, op.depth)).Shape());
    if (op.op === "addHole") return main;

    // The mouth feature: a wider coaxial cylinder (counterbore) or a cone
    // tapering from csRadius at the surface down to the hole radius
    // (countersink; depth from the included angle).
    const mouth =
      op.op === "addCounterboreHole"
        ? keep(keep(new oc.BRepPrimAPI_MakeCylinder_3(ax2, op.cbRadius, op.cbDepth)).Shape())
        : keep(keep(new oc.BRepPrimAPI_MakeCone_3(
          ax2, op.csRadius, op.radius,
          (op.csRadius - op.radius) / Math.tan((op.csAngleDeg * Math.PI) / 360)
        )).Shape());
    const fuse = keep(new oc.BRepAlgoAPI_Fuse_3(main, mouth));
    if (!fuse.IsDone()) return null;
    return keep(fuse.Shape());
  } catch {
    return null;
  }
}

/** A single operand shape from one-or-more solids (compound when more than
 * one) — exported alongside `collectSolids` for `entityFacts.ts`'s
 * `checkInterference`, which needs the exact same "compound the operand's
 * solids together first" framing this file's own `booleanSolids` already
 * established, read-only. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function combineSolids(oc: any, shapes: any[], cleanup: Array<{ delete(): void }>): any {
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
function filletEdges(oc: any, shape: any, op: Extract<EditOp, { op: "fillet" | "chamfer" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const edges = collectEdges(oc, shape, cleanup);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const picked = op.edges.map((id) => edges[edgeIndex(id)]).filter((e): e is any => e != null);
  if (picked.length === 0) {
    fail?.(
      `none of the edge ids (${op.edges.join(", ")}) resolve`,
      "re-check edge-N ids after topology-changing ops — load_model re-lists them"
    );
    return shape;
  }

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
    fail?.(
      `the ${op.op} build threw — the ${isFillet ? "radius" : "distance"} ${amount} is likely too large for the geometry`,
      `try a smaller value, or fewer edges at once`
    );
    return shape;
  }
  if (!maker.IsDone()) {
    fail?.(`the ${op.op} did not complete (IsDone() false)`, `the ${isFillet ? "radius" : "distance"} may be too large for the selected edges`);
    return shape;
  }
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
function featureModel(oc: any, shape: any, op: EditOp, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const solid = buildFeatureSolid(oc, shape, op, cleanup);
  if (!solid) {
    fail?.(`${op.op} could not build a new body`, "check that the profile face-N (and, for sweep, the path edge-N) resolve to real entities");
    return shape;
  }
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
function addPrimitive(oc: any, shape: any, op: EditOp, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const solid = buildPrimitiveSolid(oc, op, cleanup);
  if (!solid) {
    fail?.(`could not build the ${op.op} body`, "check the primitive's parameters (radii/sizes must be positive, axis a non-zero direction)");
    return shape;
  }
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
        const points = regularPolygonPoints(op.center, ux, vx, op.radius, op.sides);
        const face = buildFlatFace(oc, points, cleanup);
        if (!face) return null;
        const [ax, ay, az] = op.axis;
        const len = Math.hypot(ax, ay, az) || 1;
        const s = op.height / len;
        const extrudeVec = keep(new oc.gp_Vec_4(ax * s, ay * s, az * s));
        return keep(keep(new oc.BRepPrimAPI_MakePrism_1(face, extrudeVec, false, true)).Shape());
      }
      case "addWedge": {
        // `BRepPrimAPI_MakeWedge_2(gp_Ax2, dx, dy, dz, ltx)`, verified against
        // the live WASM: the Ax2 location is the wedge's local ORIGIN corner
        // (local x → Ax2 X-dir, local z → Ax2 main dir), so offset it by
        // −dx/2·u −dy/2·v to make `center` the centre of the base rectangle —
        // matching the base-centre convention of the other extruded primitives.
        const [u, v] = inPlaneBasis(op.axis, op.up);
        const origin = addScaled(op.center, u, -op.dx / 2, v, -op.dy / 2);
        const ax2 = keep(new oc.gp_Ax2_2(keep(pnt(oc, origin)), keep(dir(oc, op.axis)), keep(dir(oc, u))));
        return keep(keep(new oc.BRepPrimAPI_MakeWedge_2(ax2, op.dx, op.dy, op.dz, op.ltx)).Shape());
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Builds a closed planar face from an ordered loop of points, connecting them
 * with straight edges — the shared wire/face pattern behind the N-gon prism
 * (subsequently extruded) and the flat rectangle/polygon profiles (used as-is).
 * OCCT API, verified against the live WASM (see CLAUDE.md):
 * `BRepBuilderAPI_MakeWire_1` + `.Add_1()` per `BRepBuilderAPI_MakeEdge_3(pnt,
 * pnt)` edge → `BRepBuilderAPI_MakeFace_15(wire, true)`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildFlatFace(oc: any, points: Vec3[], cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  const pts = points.map((p) => keep(pnt(oc, p)));
  const mkWire = keep(new oc.BRepBuilderAPI_MakeWire_1());
  for (let i = 0; i < pts.length; i++) {
    const edge = keep(new oc.BRepBuilderAPI_MakeEdge_3(pts[i], pts[(i + 1) % pts.length])).Edge();
    keep(edge);
    mkWire.Add_1(edge);
  }
  if (!mkWire.IsDone()) return null;
  const wire = keep(mkWire.Wire());
  const face = keep(new oc.BRepBuilderAPI_MakeFace_15(wire, true)).Face();
  return face.IsNull() ? null : keep(face);
}

/** N points evenly spaced around `center` on the circle of `radius` spanned by
 * orthonormal in-plane basis (`u`, `v`). */
function regularPolygonPoints(center: Vec3, u: Vec3, v: Vec3, radius: number, sides: number): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (2 * Math.PI * i) / sides;
    points.push(addScaled(center, u, Math.cos(a) * radius, v, Math.sin(a) * radius));
  }
  return points;
}

/**
 * 2D profile creation: builds a new standalone flat face (no thickness) and
 * **appends** it to the model — same non-destructive `compound(existing + new)`
 * pattern as {@link addPrimitive}/{@link featureModel}, except the appended body
 * here is a bare `TopoDS_Face`, not a solid. `tessellateByGroup`'s free-face pass
 * (`src/meshExtract.ts`) is what makes it visible/pickable afterward — without
 * that, a loose face mixed into a compound alongside real solids would be
 * silently dropped from tessellation. A profile whose builder throws is skipped.
 *
 * OCCT circle API, verified against the live WASM: `gp_Circ_2(gp_Ax2_3(pnt,
 * normal), radius)` → `BRepBuilderAPI_MakeEdge_8(circ)` → `BRepBuilderAPI_
 * MakeWire_1` + `.Add_1()` → `BRepBuilderAPI_MakeFace_15(wire, true)`.
 * Rectangle/polygon use {@link buildFlatFace} with corners computed via
 * {@link inPlaneBasis} (unlike the 3D primitives' `planeBasis`, this derives the
 * in-plane `u` axis from the op's `up` vector so orientation is user-controlled,
 * not arbitrary — needed here because width ≠ height / polygon phase matters for
 * a flat sketch in a way it mostly doesn't for a solid of revolution).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addProfile(oc: any, shape: any, op: EditOp, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const face = buildProfileFace(oc, op, cleanup);
  if (!face) {
    fail?.(`could not build the ${op.op} sketch face`, "check the profile's parameters (radius/width/height must be positive, normal a non-zero direction)");
    return shape;
  }
  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  builder.Add(comp, shape);
  builder.Add(comp, face);
  return comp;
}

/** Builds the new profile face, or null on builder failure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildProfileFace(oc: any, op: EditOp, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    switch (op.op) {
      case "addCircleProfile": {
        const ax2 = keep(new oc.gp_Ax2_3(keep(pnt(oc, op.center)), keep(dir(oc, op.normal))));
        const circ = keep(new oc.gp_Circ_2(ax2, op.radius));
        const edge = keep(keep(new oc.BRepBuilderAPI_MakeEdge_8(circ)).Edge());
        const mkWire = keep(new oc.BRepBuilderAPI_MakeWire_1());
        mkWire.Add_1(edge);
        if (!mkWire.IsDone()) return null;
        const wire = keep(mkWire.Wire());
        const face = keep(new oc.BRepBuilderAPI_MakeFace_15(wire, true)).Face();
        return face.IsNull() ? null : keep(face);
      }
      case "addRectangleProfile": {
        const [u, v] = inPlaneBasis(op.normal, op.up);
        const hw = op.width / 2, hh = op.height / 2;
        const corners: Vec3[] = [
          addScaled(op.center, u, -hw, v, -hh),
          addScaled(op.center, u, hw, v, -hh),
          addScaled(op.center, u, hw, v, hh),
          addScaled(op.center, u, -hw, v, hh),
        ];
        return buildFlatFace(oc, corners, cleanup);
      }
      case "addPolygonProfile": {
        const [u, v] = inPlaneBasis(op.normal, op.up);
        return buildFlatFace(oc, regularPolygonPoints(op.center, u, v, op.radius, op.sides), cleanup);
      }
      case "addEllipseProfile": {
        // `gp_Elips_2(ax2, major, minor)` requires major ≥ minor; when radiusY
        // is the larger, rotate the in-plane basis 90° (major axis along `v`)
        // and swap the radii instead. `gp_Ax2_2(pnt, normal, xdir)` pins the
        // ellipse's major axis to an explicit in-plane X direction (verified:
        // it projects/normalizes the given X into the plane).
        const [u, v] = inPlaneBasis(op.normal, op.up);
        const swap = op.radiusY > op.radiusX;
        const major = swap ? op.radiusY : op.radiusX;
        const minor = swap ? op.radiusX : op.radiusY;
        const xdir = swap ? v : u;
        const ax2 = keep(new oc.gp_Ax2_2(keep(pnt(oc, op.center)), keep(dir(oc, op.normal)), keep(dir(oc, xdir))));
        const elips = keep(new oc.gp_Elips_2(ax2, major, minor));
        const edge = keep(keep(new oc.BRepBuilderAPI_MakeEdge_12(elips)).Edge());
        return faceFromEdges(oc, [edge], cleanup);
      }
      case "addRoundedRectangleProfile": {
        // 4 straight edges + 4 quarter-circle corner arcs. Corner-arc angles
        // are measured from each arc's own `gp_Ax2_2` explicit X direction
        // (`u`), which makes the quadrant math deterministic pure JS.
        const [u, v] = inPlaneBasis(op.normal, op.up);
        const at = (du: number, dv: number): Vec3 => addScaled(op.center, u, du, v, dv);
        const hw = op.width / 2, hh = op.height / 2, r = op.cornerRadius;
        const arc = (c: Vec3, a1: number, a2: number) => cornerArcEdge(oc, c, op.normal, u, r, a1, a2, cleanup);
        const line = (p1: Vec3, p2: Vec3) =>
          keep(keep(new oc.BRepBuilderAPI_MakeEdge_3(keep(pnt(oc, p1)), keep(pnt(oc, p2)))).Edge());
        const edges = [
          line(at(-(hw - r), -hh), at(hw - r, -hh)),          // bottom
          arc(at(hw - r, -(hh - r)), -Math.PI / 2, 0),        // bottom-right corner
          line(at(hw, -(hh - r)), at(hw, hh - r)),            // right
          arc(at(hw - r, hh - r), 0, Math.PI / 2),            // top-right corner
          line(at(hw - r, hh), at(-(hw - r), hh)),            // top
          arc(at(-(hw - r), hh - r), Math.PI / 2, Math.PI),   // top-left corner
          line(at(-hw, hh - r), at(-hw, -(hh - r))),          // left
          arc(at(-(hw - r), -(hh - r)), Math.PI, Math.PI * 1.5), // bottom-left corner
        ];
        return faceFromEdges(oc, edges, cleanup);
      }
      case "addSlotProfile": {
        // A stadium: two straight edges + two semicircular end caps, overall
        // `length` along `u` (so `up` is the slot's long axis).
        const [u, v] = inPlaneBasis(op.normal, op.up);
        const at = (du: number, dv: number): Vec3 => addScaled(op.center, u, du, v, dv);
        const r = op.width / 2;
        const cx = op.length / 2 - r; // end-cap centres at ±cx
        const arc = (c: Vec3, a1: number, a2: number) => cornerArcEdge(oc, c, op.normal, u, r, a1, a2, cleanup);
        const line = (p1: Vec3, p2: Vec3) =>
          keep(keep(new oc.BRepBuilderAPI_MakeEdge_3(keep(pnt(oc, p1)), keep(pnt(oc, p2)))).Edge());
        const edges = [
          line(at(-cx, -r), at(cx, -r)),                   // bottom
          arc(at(cx, 0), -Math.PI / 2, Math.PI / 2),       // right cap
          line(at(cx, r), at(-cx, r)),                     // top
          arc(at(-cx, 0), Math.PI / 2, Math.PI * 1.5),     // left cap
        ];
        return faceFromEdges(oc, edges, cleanup);
      }
      case "addTrapezoidProfile": {
        const [u, v] = inPlaneBasis(op.normal, op.up);
        const hb = op.bottomWidth / 2, ht = op.topWidth / 2, hh = op.height / 2;
        const corners: Vec3[] = [
          addScaled(op.center, u, -hb, v, -hh),
          addScaled(op.center, u, hb, v, -hh),
          addScaled(op.center, u, ht, v, hh),
          addScaled(op.center, u, -ht, v, hh),
        ];
        return buildFlatFace(oc, corners, cleanup);
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * A circular-arc edge for rounded-wire profiles: the circle of `radius` at
 * `center`, in the plane of `normal`, with angles measured from the explicit
 * in-plane X direction `xdir` — `gp_Ax2_2(pnt, normal, xdir)` (verified against
 * the live WASM: the given X is projected into the plane and normalized) +
 * the already-verified `gp_Circ_2` + `BRepBuilderAPI_MakeEdge_9(circ, a1, a2)`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cornerArcEdge(oc: any, center: Vec3, normal: Vec3, xdir: Vec3, radius: number, a1: number, a2: number, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  const ax2 = keep(new oc.gp_Ax2_2(keep(pnt(oc, center)), keep(dir(oc, normal)), keep(dir(oc, xdir))));
  const circ = keep(new oc.gp_Circ_2(ax2, radius));
  return keep(keep(new oc.BRepBuilderAPI_MakeEdge_9(circ, a1, a2)).Edge());
}

/**
 * Assembles pre-built edges into a wire and caps it with a face — the shared
 * tail of every mixed line/arc profile (`MakeWire_1` auto-orders the edges by
 * shared vertices, so build order is forgiving; `MakeFace_15(wire, true)`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function faceFromEdges(oc: any, edges: any[], cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  const mkWire = keep(new oc.BRepBuilderAPI_MakeWire_1());
  for (const e of edges) mkWire.Add_1(e);
  if (!mkWire.IsDone()) return null;
  const wire = keep(mkWire.Wire());
  const face = keep(new oc.BRepBuilderAPI_MakeFace_15(wire, true)).Face();
  return face.IsNull() ? null : keep(face);
}

/**
 * Wireframe primitive creation (Point/Line/Arc): builds a bare `TopoDS_Vertex`
 * or `TopoDS_Edge` — no existing operands, no thickness — and **appends** it,
 * same non-destructive `compound(existing shape + new vertex/edge)` pattern as
 * {@link addPrimitive}/{@link addProfile}. Points are display-only (surfaced by
 * `extractVertices` in `src/meshExtract.ts`) and are never resolved as an
 * operand by any other op, so unlike faces this has no lockstep-pipeline
 * counterpart to keep in sync — appending a bare vertex/edge just works with
 * the existing unconditional whole-shape vertex/edge extraction. A wireframe
 * primitive whose builder throws is skipped.
 *
 * OCCT API, verified against the live WASM:
 *   point → `BRepBuilderAPI_MakeVertex(gp_Pnt)` (unsuffixed — this class has no
 *           `_N` overloads, unlike almost everything else in this codebase)
 *           → `.Vertex()`.
 *   line  → the already-verified `BRepBuilderAPI_MakeEdge_3(pnt, pnt)`.
 *   arc   → the already-verified `gp_Circ_2(gp_Ax2_3(pnt, normal), radius)`,
 *           trimmed via `BRepBuilderAPI_MakeEdge_9(circ, alpha1, alpha2)` (of
 *           35 total `MakeEdge` overloads — found by probing each index with a
 *           `(gp_Circ, number, number)` argument shape). Sweeps from
 *           `alpha1` to `alpha2` in the increasing (counterclockwise about
 *           `normal`) direction, wrapping through 0 if `alpha2 < alpha1` —
 *           confirmed against the live WASM, not assumed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addWireframePrimitive(oc: any, shape: any, op: EditOp, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const entity = buildWireframePrimitive(oc, op, cleanup);
  if (!entity) {
    fail?.(`could not build the ${op.op} entity`, "check the coordinates (a collinear 3-point arc, for example, cannot build an edge)");
    return shape;
  }
  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  builder.Add(comp, shape);
  builder.Add(comp, entity);
  return comp;
}

/** Builds the new vertex/edge, or null on builder failure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildWireframePrimitive(oc: any, op: EditOp, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    switch (op.op) {
      case "addPoint": {
        const p = keep(pnt(oc, op.position));
        const vertex = keep(new oc.BRepBuilderAPI_MakeVertex(p)).Vertex();
        return vertex.IsNull() ? null : keep(vertex);
      }
      case "addLine": {
        const edge = keep(new oc.BRepBuilderAPI_MakeEdge_3(keep(pnt(oc, op.start)), keep(pnt(oc, op.end)))).Edge();
        return edge.IsNull() ? null : keep(edge);
      }
      case "addArc": {
        const ax2 = keep(new oc.gp_Ax2_3(keep(pnt(oc, op.center)), keep(dir(oc, op.normal))));
        const circ = keep(new oc.gp_Circ_2(ax2, op.radius));
        const alpha1 = (op.startAngleDeg * Math.PI) / 180;
        const alpha2 = (op.endAngleDeg * Math.PI) / 180;
        const edge = keep(new oc.BRepBuilderAPI_MakeEdge_9(circ, alpha1, alpha2)).Edge();
        return edge.IsNull() ? null : keep(edge);
      }
      case "addPolyline": {
        // A wire of straight segments (the wire's edges are individually
        // enumerated by the unrestricted edge extraction, so each segment gets
        // its own pickable `edge-N`).
        const pts = op.points.map((p) => keep(pnt(oc, p)));
        const mkWire = keep(new oc.BRepBuilderAPI_MakeWire_1());
        const last = op.closed ? pts.length : pts.length - 1;
        for (let i = 0; i < last; i++) {
          const edge = keep(keep(new oc.BRepBuilderAPI_MakeEdge_3(pts[i], pts[(i + 1) % pts.length])).Edge());
          mkWire.Add_1(edge);
        }
        if (!mkWire.IsDone()) return null;
        const wire = keep(mkWire.Wire());
        return wire.IsNull() ? null : wire;
      }
      case "addThreePointArc": {
        // `GC_MakeArcOfCircle_4(p1, p2, p3)` (verified against the live WASM) —
        // `IsDone()` is false for a collinear triple, the graceful-skip gate.
        const mk = keep(new oc.GC_MakeArcOfCircle_4(keep(pnt(oc, op.p1)), keep(pnt(oc, op.p2)), keep(pnt(oc, op.p3))));
        if (!mk.IsDone()) return null;
        return edgeFromCurveHandle(oc, keep(mk.Value()), cleanup);
      }
      case "addSpline": {
        // `GeomAPI_PointsToBSpline_2(arr, 3, 8, GeomAbs_C2, 1e-6)` (verified):
        // an approximating fit through the points, endpoint-exact —
        // `GeomAPI_Interpolate` is not bound in this build.
        const arr = keep(new oc.TColgp_Array1OfPnt_2(1, op.points.length));
        op.points.forEach((p, i) => arr.SetValue(i + 1, keep(pnt(oc, p))));
        const fit = keep(new oc.GeomAPI_PointsToBSpline_2(arr, 3, 8, oc.GeomAbs_Shape.GeomAbs_C2, 1e-6));
        return edgeFromCurveHandle(oc, keep(fit.Curve()), cleanup);
      }
      case "addBezier": {
        // `TColgp_Array1OfPnt_2(1, n)` + `Geom_BezierCurve_1(arr)` (verified).
        const arr = keep(new oc.TColgp_Array1OfPnt_2(1, op.controlPoints.length));
        op.controlPoints.forEach((p, i) => arr.SetValue(i + 1, keep(pnt(oc, p))));
        const bez = new oc.Geom_BezierCurve_1(arr); // owned by the handle below
        const hCurve = keep(new oc.Handle_Geom_Curve_2(bez));
        const mkEdge = keep(new oc.BRepBuilderAPI_MakeEdge_24(hCurve));
        if (!mkEdge.IsDone()) return null;
        const edge = keep(mkEdge.Edge());
        return edge.IsNull() ? null : edge;
      }
      case "addEllipseArc": {
        // Same major≥minor radii-swap as addEllipseProfile; when swapped the
        // parametric angle is measured from the rotated major axis (`v`), so
        // shift both trim angles by −90° to keep them measured from `up`.
        const [u, v] = inPlaneBasis(op.normal, op.up);
        const swap = op.radiusY > op.radiusX;
        const major = swap ? op.radiusY : op.radiusX;
        const minor = swap ? op.radiusX : op.radiusY;
        const xdir = swap ? v : u;
        const shift = swap ? -Math.PI / 2 : 0;
        const ax2 = keep(new oc.gp_Ax2_2(keep(pnt(oc, op.center)), keep(dir(oc, op.normal)), keep(dir(oc, xdir))));
        const elips = keep(new oc.gp_Elips_2(ax2, major, minor));
        const a1 = (op.startAngleDeg * Math.PI) / 180 + shift;
        const a2 = (op.endAngleDeg * Math.PI) / 180 + shift;
        const edge = keep(keep(new oc.BRepBuilderAPI_MakeEdge_13(elips, a1, a2)).Edge());
        return edge.IsNull() ? null : edge;
      }
      case "addHelix": {
        // Verified chain: a 2D line segment in the (angle, height) parameter
        // space of a `Geom_CylindricalSurface`, turned into a real 3D edge by
        // `BRepLib.BuildCurves3d_2`. `MakeEdge_30(h2dcurve, hsurface)` is the
        // curve-on-surface overload (found by probing all 35 indices).
        const ax3 = keep(new oc.gp_Ax3_4(keep(pnt(oc, op.center)), keep(dir(oc, op.axis))));
        const cyl = new oc.Geom_CylindricalSurface_1(ax3, op.radius); // owned by the handle below
        const hSurf = keep(new oc.Handle_Geom_Surface_2(cyl));
        const p2a = keep(new oc.gp_Pnt2d_3(0, 0));
        const p2b = keep(new oc.gp_Pnt2d_3(2 * Math.PI * op.turns, op.pitch * op.turns));
        const seg = keep(new oc.GCE2d_MakeSegment_1(p2a, p2b));
        if (!seg.IsDone()) return null;
        const hSeg = keep(seg.Value());
        const h2d = keep(new oc.Handle_Geom2d_Curve_2(hSeg.get()));
        const mkEdge = keep(new oc.BRepBuilderAPI_MakeEdge_30(h2d, hSurf));
        if (!mkEdge.IsDone()) return null;
        const edge = keep(mkEdge.Edge());
        if (edge.IsNull()) return null;
        oc.BRepLib.BuildCurves3d_2(edge);
        return edge;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Wraps a `Handle_Geom_TrimmedCurve`/`Handle_Geom_BSplineCurve` (any Geom curve
 * handle with `.get()`) into a `TopoDS_Edge` via `Handle_Geom_Curve_2` +
 * `BRepBuilderAPI_MakeEdge_24` (both verified against the live WASM).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function edgeFromCurveHandle(oc: any, handle: any, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  const hCurve = keep(new oc.Handle_Geom_Curve_2(handle.get()));
  const mkEdge = keep(new oc.BRepBuilderAPI_MakeEdge_24(hCurve));
  if (!mkEdge.IsDone()) return null;
  const edge = keep(mkEdge.Edge());
  return edge.IsNull() ? null : edge;
}

/**
 * Builds a standalone flat face from the wire formed by the selected edges and
 * **appends** it — same non-destructive `compound(existing shape + new face)`
 * pattern as {@link addProfile}, and it likewise benefits from the free-face
 * tessellation pass with zero further changes needed there. Edge `edge-N` ids
 * are resolved via the **existing** `collectEdges`.
 *
 * OCCT wire-assembly API, verified against the live WASM: `BRepBuilderAPI_
 * MakeWire_1` + `.Add_1()` per selected edge — confirmed to auto-assemble
 * edges added in an arbitrary (shuffled) order by their shared vertices, not
 * just sequential order, so the pick order in the view doesn't matter. `.Add_1
 * ()`'s connectivity check is what rejects a genuinely unrelated/disconnected
 * edge set (`.IsDone()` false) — the primary graceful-skip gate. **Caveat,
 * verified not assumed:** a chain of edges that connects but does not loop
 * back to its own start (an "almost closed" open polyline) may still succeed
 * through `.IsDone()` and `BRepBuilderAPI_MakeFace_15` in this OCCT build —
 * OCCT wires are not required to be closed, and no reliable "is this wire a
 * closed loop" API was found in this binding (`BRepTools.IsReallyClosed`/
 * `DetectClosedness` need extra args this binding doesn't expose usefully;
 * `ShapeAnalysis_Wire.CheckClosed` did not distinguish the two cases in
 * testing). Accepted: a best-effort face from an open chain is harmless
 * (never a crash), consistent with this codebase's graceful-degradation rule.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addSurfaceFromLines(oc: any, shape: any, op: Extract<EditOp, { op: "addSurfaceFromLines" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const face = buildSurfaceFromLines(oc, shape, op, cleanup);
  if (!face) {
    fail?.(
      "the selected edges did not form a buildable face",
      "at least 3 edge-N ids that connect into a chain are required (a genuinely disconnected set is rejected)"
    );
    return shape;
  }
  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  builder.Add(comp, shape);
  builder.Add(comp, face);
  return comp;
}

/** Builds the new face from the selected edges, or null on unresolved operands / failure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildSurfaceFromLines(oc: any, shape: any, op: Extract<EditOp, { op: "addSurfaceFromLines" }>, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    const edges = collectEdges(oc, shape, cleanup);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const picked = op.edges.map((id) => edges[edgeIndex(id)]).filter((e): e is any => e != null);
    if (picked.length < 3) return null; // a closed loop needs at least 3 edges

    const mkWire = keep(new oc.BRepBuilderAPI_MakeWire_1());
    for (const e of picked) mkWire.Add_1(e);
    if (!mkWire.IsDone()) return null; // edges don't connect into a wire at all

    const wire = keep(mkWire.Wire());
    const face = keep(new oc.BRepBuilderAPI_MakeFace_15(wire, true)).Face();
    return face.IsNull() ? null : keep(face);
  } catch {
    return null;
  }
}

/**
 * Builds a new solid by sewing the selected faces into a closed shell and
 * **appends** it — the standard extra-body append pattern used throughout this
 * file. Face `face-N` ids are resolved via the **existing** `collectFaces`
 * (already includes the free-face pass, so a face built by `addSurfaceFromLines`
 * is naturally selectable here too — zero further changes needed).
 *
 * OCCT sewing API, verified against the live WASM (probed with a realistic
 * input: 6 mutually-disconnected faces, built independently — not from
 * `BRepPrimAPI_MakeBox` — matching what a user actually selects):
 *   `new BRepBuilderAPI_Sewing(tolerance, true, true, true, false)` (this
 *   class's only constructor takes all 5 params — no defaulted overload in
 *   this binding) → `.Add(face)` per face → `.Perform(new Handle_Message_
 *   ProgressIndicator_1())` (the unsuffixed `Perform` needs this progress
 *   handle arg, unlike most single-shape ops in this codebase, which skip a
 *   progress arg entirely) → `.SewedShape()`, then an explorer pulls the
 *   `TopAbs_SHELL` out of the result (`TopoDS.Shell_1`).
 *
 * **Closure check — verified NOT to be `.IsNull()`/volume sign/`BRepCheck_
 * Analyzer`** (all tried and rejected during probing): `BRepBuilderAPI_
 * MakeSolid` happily builds a non-null "solid" from an OPEN shell, and
 * `BRepGProp.VolumeProperties` returns a plausible-looking (wrong) number for
 * an open shell too — neither is a reliable skip signal. The reliable one is
 * `sew.NbFreeEdges()`: exactly 0 for a properly closed shell, > 0 (the
 * boundary edges of whatever's missing) for an open one — confirmed with a
 * unit box built from all 6 faces (0 free edges) vs. 5-of-6 (4 free edges) vs.
 * 3-of-6 (8 free edges). This is the gate `addVolumeFromSurfaces` uses.
 *
 * `BRepBuilderAPI_MakeSolid_3(shell)` builds the solid from the verified-closed
 * shell (found by brute-force probing all 7 numbered overloads against a real
 * shell argument).
 *
 * **Unlike `extrude`'s `Copy=false` (which reuses and thereby consumes its
 * source face), sewing does NOT consume the input faces** — verified end-to-end
 * on `bull.stp`: after sewing 6 rectangle-profile faces into a box solid, all 6
 * original faces are still present as free faces (visible in "Sketches")
 * alongside the new solid's own 6. This is accepted, not a bug: the sewn shell
 * is built from copies, so the original sketches remain available to reuse for
 * another operation. Not worth suppressing — doing so would mean excluding
 * specific faces from the compound rebuild, extra complexity for a purely
 * cosmetic concern.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addVolumeFromSurfaces(oc: any, shape: any, op: Extract<EditOp, { op: "addVolumeFromSurfaces" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const solid = buildVolumeFromSurfaces(oc, shape, op, cleanup);
  if (!solid) {
    fail?.(
      "the selected faces did not sew into a CLOSED shell",
      "at least 4 face-N ids forming a closed volume are required — run a smaller selection or check for missing faces"
    );
    return shape;
  }
  const comp = new oc.TopoDS_Compound();
  cleanup.push(comp);
  const builder = new oc.BRep_Builder();
  cleanup.push(builder);
  builder.MakeCompound(comp);
  builder.Add(comp, shape);
  builder.Add(comp, solid);
  return comp;
}

/** Builds the new solid from the selected faces, or null on unresolved operands / an open shell / failure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildVolumeFromSurfaces(oc: any, shape: any, op: Extract<EditOp, { op: "addVolumeFromSurfaces" }>, cleanup: Array<{ delete(): void }>): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    const faces = collectFaces(oc, shape, cleanup);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const picked = op.faces.map((id) => faces[faceIndex(id)]).filter((f): f is any => f != null);
    if (picked.length < 4) return null; // a closed volume needs at least 4 faces

    const sew = keep(new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false));
    for (const f of picked) sew.Add(f);
    sew.Perform(keep(new oc.Handle_Message_ProgressIndicator_1()));
    if (sew.NbFreeEdges() > 0) return null; // open/non-manifold shell — can't make a solid

    const sewn = keep(sew.SewedShape());
    const shellExp = keep(new oc.TopExp_Explorer_2(
      sewn, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE
    ));
    if (!shellExp.More()) return null;
    const shell = keep(oc.TopoDS.Shell_1(shellExp.Current()));

    const solid = keep(new oc.BRepBuilderAPI_MakeSolid_3(shell)).Solid();
    return solid.IsNull() ? null : keep(solid);
  } catch {
    return null;
  }
}

/**
 * Orthonormal in-plane basis (`u`, `v`) perpendicular to `normal`, with `u`
 * derived from `up` (projected off `normal`, then normalized) so rectangle/
 * polygon profiles orient predictably from a user-supplied reference direction,
 * unlike {@link planeBasis}'s arbitrary perpendicular. Callers must ensure `up`
 * is not (anti-)parallel to `normal` (`validateEditOp` already enforces this).
 */
function inPlaneBasis(normal: Vec3, up: Vec3): [Vec3, Vec3] {
  const n = normalized(normal);
  const d = up[0] * n[0] + up[1] * n[1] + up[2] * n[2]; // up · n
  const proj: Vec3 = [up[0] - d * n[0], up[1] - d * n[1], up[2] - d * n[2]];
  const u = normalized(proj);
  const v = normalized(cross(n, u));
  return [u, v];
}

/** A new, normalized copy of `v` (pure — does not mutate the input). */
function normalized(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** `base + u*du + v*dv`. */
function addScaled(base: Vec3, u: Vec3, du: number, v: Vec3, dv: number): Vec3 {
  return [base[0] + u[0] * du + v[0] * dv, base[1] + u[1] * du + v[1] * dv, base[2] + u[2] * du + v[2] * dv];
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
 * no solids — and, when solids DO exist, any standalone 2D profile faces (added via
 * `addCircleProfile`/`addRectangleProfile`/`addPolygonProfile`) not owned by any
 * solid, appended last in whole-shape explorer order. This mirrors
 * `tessellateByGroup`'s free-face pass exactly (same `HashCode`+`IsSame` claiming
 * algorithm) so a `face-N` id picked in the view always resolves to the same live
 * face here. (It does not replay tessellation's skip-untriangulated-faces step, so
 * in the rare degenerate-face case an index could shift — accepted.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function collectFaces(oc: any, shape: any, cleanup: Array<{ delete(): void }>): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const claimed = new Map<number, any[]>();
  const solidExp = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_SOLID,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE
  );
  cleanup.push(solidExp);
  let anySolid = false;
  for (; solidExp.More(); solidExp.Next()) {
    anySolid = true;
    addFacesOf(oc, solidExp.Current(), out, cleanup, claimed);
  }
  if (!anySolid) addFacesOf(oc, shape, out, cleanup);
  else addFreeFacesOf(oc, shape, out, cleanup, claimed);
  return out;
}

/** Appends every face of `shapeRef`; when `claim` is given, also records each
 * face's identity into it (`HashCode` bucket) so {@link addFreeFacesOf} can skip
 * faces already owned by a solid. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addFacesOf(oc: any, shapeRef: any, out: any[], cleanup: Array<{ delete(): void }>, claim?: Map<number, any[]>): void {
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
    if (claim) {
      const hash = face.HashCode(HASH_UPPER);
      const bucket = claim.get(hash);
      if (bucket) bucket.push(face); else claim.set(hash, [face]);
    }
  }
}

/** Appends faces of the whole `shape` not already present in `claimed` — the
 * `collectFaces` mirror of `meshExtract.ts`'s `extractFreeFaces`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addFreeFacesOf(oc: any, shape: any, out: any[], cleanup: Array<{ delete(): void }>, claimed: Map<number, any[]>): void {
  const exp = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE
  );
  cleanup.push(exp);
  for (; exp.More(); exp.Next()) {
    const face = oc.TopoDS.Face_1(exp.Current());
    const bucket = claimed.get(face.HashCode(HASH_UPPER));
    if (bucket && bucket.some((f) => f.IsSame(face))) { face.delete(); continue; } // owned by a solid
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
function explodeSolids(oc: any, shape: any, factor: number, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const solids = collectSolids(oc, shape, cleanup);
  if (solids.length < 2) {
    fail?.("explode spreads multiple bodies apart — the model has fewer than two solids");
    return shape;
  }
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
function mateShape(oc: any, shape: any, op: Extract<EditOp, { op: "mate" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const faces = collectFaces(oc, shape, cleanup);
  const fa = faces[faceIndex(op.faceA)];
  const fb = faces[faceIndex(op.faceB)];
  if (!fa || !fb) {
    fail?.(
      `face id${!fa && !fb ? "s" : ""} ${[!fa ? op.faceA : null, !fb ? op.faceB : null].filter(Boolean).join(", ")} did not resolve`,
      "re-check face-N ids after topology-changing ops — load_model re-lists them"
    );
    return shape;
  }
  const pa = facePlane(oc, fa, cleanup);
  const pb = facePlane(oc, fb, cleanup);
  if (!pa || !pb) {
    fail?.(
      `face ${!pa ? op.faceA : op.faceB} is not planar`,
      "mate aligns two PLANAR faces onto each other — pick flat faces"
    );
    return shape;
  }

  const t = new oc.gp_Trsf_1();
  cleanup.push(t);
  try {
    const ax3A = new oc.gp_Ax3_4(pnt(oc, pa.pt), dir(oc, pa.nl));
    cleanup.push(ax3A);
    const ax3B = new oc.gp_Ax3_4(pnt(oc, pb.pt), dir(oc, [-pb.nl[0], -pb.nl[1], -pb.nl[2]]));
    cleanup.push(ax3B);
    t.SetDisplacement(ax3A, ax3B);
  } catch {
    fail?.("the rigid displacement between the two face planes could not be built");
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

/**
 * Hollows out the solid(s) owning the selected opening faces: those faces are
 * removed and the rest of each owning solid's boundary grows walls of
 * `|thickness|` (negative = inward, the usual hollow — verified: closing the
 * top of a 10-box with thickness −1 leaves volume 1000 − 8·8·9 = 424).
 *
 * OCCT API, verified against the live WASM: `new BRepOffsetAPI_MakeThickSolid_1()`
 * (no-arg ctor) → `.MakeThickSolidByJoin(solid, closingFaces, offset, tol,
 * BRepOffset_Mode.BRepOffset_Skin, false, false, GeomAbs_JoinType.GeomAbs_Arc,
 * false)` — exactly 9 args; the 10th `Message_ProgressRange` is not
 * constructible in this build (the same quirk as booleans/BREP read) and must
 * be omitted. Closing faces travel in a `TopTools_ListOfShape_1()` via
 * `.Append_1(face)` (`.Size()`, not `.Extent()`, reads it back). **An EMPTY
 * closing list does NOT hollow** — it returns the plain inner offset solid
 * (verified: volume 512, i.e. the shrunk 8-box, not 1000−512) — which is why
 * `validateEditOp` requires ≥ 1 opening face. Unresolved faces, faces not
 * owned by any solid, or a failed/`!IsDone()` build skip gracefully (the
 * affected solid stays unshelled).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shellSolids(oc: any, shape: any, op: Extract<EditOp, { op: "shell" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    const faces = collectFaces(oc, shape, cleanup);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const picked = op.openingFaces.map((id) => faces[faceIndex(id)]).filter((f): f is any => f != null);
    if (picked.length === 0) {
      fail?.(
        `none of the opening-face ids (${op.openingFaces.join(", ")}) resolve`,
        "re-check face-N ids after topology-changing ops — load_model re-lists them"
      );
      return shape;
    }
    const solids = collectSolids(oc, shape, cleanup);
    if (solids.length === 0) {
      fail?.("the model has no solids to shell");
      return shape;
    }

    // Group the opening faces by owning solid (a face can only belong to one).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const openingsBySolid = new Map<number, any[]>();
    for (const face of picked) {
      for (let i = 0; i < solids.length; i++) {
        const exp = keep(new oc.TopExp_Explorer_2(
          solids[i].solid, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE
        ));
        let owned = false;
        for (; exp.More(); exp.Next()) {
          const f = keep(oc.TopoDS.Face_1(exp.Current()));
          if (f.IsSame(face)) { owned = true; break; }
        }
        if (owned) {
          const list = openingsBySolid.get(i) ?? [];
          list.push(face);
          openingsBySolid.set(i, list);
          break;
        }
      }
    }
    if (openingsBySolid.size === 0) {
      fail?.("no opening face is owned by a solid");
      return shape;
    }

    const mode = oc.BRepOffset_Mode.BRepOffset_Skin;
    const join = oc.GeomAbs_JoinType.GeomAbs_Arc;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const replaced = new Map<number, any>();
    for (const [i, openings] of openingsBySolid) {
      try {
        const list = keep(new oc.TopTools_ListOfShape_1());
        for (const f of openings) list.Append_1(f);
        const mk = keep(new oc.BRepOffsetAPI_MakeThickSolid_1());
        mk.MakeThickSolidByJoin(solids[i].solid, list, op.thickness, 1e-3, mode, false, false, join, false);
        if (mk.IsDone()) replaced.set(i, keep(mk.Shape()));
      } catch {
        // this solid stays unshelled
      }
    }
    if (replaced.size === 0) {
      fail?.("the hollow build failed for every opening solid", "the thickness may be too large for the solid's walls");
      return shape;
    }
    if (solids.length === 1) return replaced.get(0) ?? shape;

    const comp = new oc.TopoDS_Compound();
    cleanup.push(comp);
    const builder = new oc.BRep_Builder();
    cleanup.push(builder);
    builder.MakeCompound(comp);
    solids.forEach((s, i) => builder.Add(comp, replaced.get(i) ?? s.solid));
    return comp;
  } catch {
    fail?.("the shell builder threw");
    return shape;
  }
}

/**
 * Splits the target solids by a plane, keeping the piece on the normal side
 * ("positive"), the opposite piece ("negative"), or both. Implemented as a
 * **half-space cut with only already-verified bindings** (deliberately avoiding
 * a `BRepAlgoAPI_Splitter` binding probe): an axis-aligned box spanning the
 * NEGATIVE side of the canonical z=0 plane (extent 10× the model's bbox
 * diagonal) is moved onto the split plane with the mate-verified
 * `gp_Trsf.SetDisplacement(gp_Ax3, gp_Ax3)`, then `positive → Cut_3(targets,
 * box)`, `negative → Common_3(targets, box)`, `both → compound of both`.
 * Unresolved targets or a failed boolean skip gracefully.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function splitSolidsByPlane(oc: any, shape: any, op: Extract<EditOp, { op: "splitByPlane" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    const solids = collectSolids(oc, shape, cleanup);
    const byId = new Map(solids.map((s) => [s.id, s.solid]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const targets = op.targets.map((id) => byId.get(id)).filter((s): s is any => s != null);
    if (targets.length === 0) {
      fail?.(
        `target ids (${op.targets.join(", ")}) did not resolve to solids`,
        "re-check solid-N ids after topology-changing ops — load_model re-lists them"
      );
      return shape;
    }

    const d = Math.max(bboxDiagonal(oc, shape, cleanup), 1) * 10;
    const rawBox = keep(keep(new oc.BRepPrimAPI_MakeBox_3(
      keep(pnt(oc, [-d / 2, -d / 2, -d])), keep(pnt(oc, [d / 2, d / 2, 0]))
    )).Shape());
    const t = keep(new oc.gp_Trsf_1());
    t.SetDisplacement(
      keep(new oc.gp_Ax3_4(keep(pnt(oc, [0, 0, 0])), keep(dir(oc, [0, 0, 1])))),
      keep(new oc.gp_Ax3_4(keep(pnt(oc, op.planePoint)), keep(dir(oc, op.planeNormal))))
    );
    const halfSpace = rigid(oc, t, cleanup)(rawBox);

    const a = combineSolids(oc, targets, cleanup);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pieces: any[] = [];
    if (op.keep === "positive" || op.keep === "both") {
      const cut = keep(new oc.BRepAlgoAPI_Cut_3(a, halfSpace));
      if (!cut.IsDone()) {
        fail?.("the positive-side cut did not complete (IsDone() false)");
        return shape;
      }
      pieces.push(keep(cut.Shape()));
    }
    if (op.keep === "negative" || op.keep === "both") {
      const common = keep(new oc.BRepAlgoAPI_Common_3(a, halfSpace));
      if (!common.IsDone()) {
        fail?.("the negative-side intersection did not complete (IsDone() false)");
        return shape;
      }
      pieces.push(keep(common.Shape()));
    }

    const used = new Set(op.targets);
    const leftovers = solids.filter((s) => !used.has(s.id)).map((s) => s.solid);
    if (pieces.length === 1 && leftovers.length === 0) return pieces[0];

    const comp = new oc.TopoDS_Compound();
    cleanup.push(comp);
    const builder = new oc.BRep_Builder();
    cleanup.push(builder);
    builder.MakeCompound(comp);
    for (const p of pieces) builder.Add(comp, p);
    for (const s of leftovers) builder.Add(comp, s);
    return comp;
  } catch {
    fail?.("the split builder threw");
    return shape;
  }
}

/**
 * Appends the planar cross-section of the target solids as a standalone flat
 * face — non-destructive (the solids stay untouched); the section face shows
 * up under "Sketches" via the free-face tessellation pass, pickable for
 * extrude/revolve like any other sketch. Implemented with verified bindings
 * only: a large plane face (`buildFlatFace`, 10× bbox diagonal) intersected
 * with the targets via `BRepAlgoAPI_Common_3(planeFace, targets)` (probe:
 * exactly the trimmed cross-section face). A plane that misses the targets
 * (no faces in the result) or a failed boolean skips gracefully.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sectionSolids(oc: any, shape: any, op: Extract<EditOp, { op: "section" }>, cleanup: Array<{ delete(): void }>, fail?: OutcomeFail): any {
  const keep = <T extends { delete(): void }>(h: T): T => { cleanup.push(h); return h; };
  try {
    const solids = collectSolids(oc, shape, cleanup);
    const byId = new Map(solids.map((s) => [s.id, s.solid]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const targets = op.targets.map((id) => byId.get(id)).filter((s): s is any => s != null);
    if (targets.length === 0) {
      fail?.(
        `target ids (${op.targets.join(", ")}) did not resolve to solids`,
        "re-check solid-N ids after topology-changing ops — load_model re-lists them"
      );
      return shape;
    }

    const d = Math.max(bboxDiagonal(oc, shape, cleanup), 1) * 10;
    const [u, v] = planeBasis(op.planeNormal);
    const corners: Vec3[] = [
      addScaled(op.planePoint, u, -d / 2, v, -d / 2),
      addScaled(op.planePoint, u, d / 2, v, -d / 2),
      addScaled(op.planePoint, u, d / 2, v, d / 2),
      addScaled(op.planePoint, u, -d / 2, v, d / 2),
    ];
    const planeFace = buildFlatFace(oc, corners, cleanup);
    if (!planeFace) {
      fail?.("the cutting plane face could not be built", "the planeNormal must be a non-zero direction");
      return shape;
    }

    const a = combineSolids(oc, targets, cleanup);
    const algo = keep(new oc.BRepAlgoAPI_Common_3(planeFace, a));
    if (!algo.IsDone()) {
      fail?.("the section intersection did not complete (IsDone() false)");
      return shape;
    }
    const section = keep(algo.Shape());

    // The plane must actually cross the targets — an empty result appends nothing.
    const faceExp = keep(new oc.TopExp_Explorer_2(
      section, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE
    ));
    if (!faceExp.More()) {
      fail?.(
        "the plane does not cross the targeted solids — there is no cross-section",
        "move planePoint onto/through the model"
      );
      return shape;
    }

    const comp = new oc.TopoDS_Compound();
    cleanup.push(comp);
    const builder = new oc.BRep_Builder();
    cleanup.push(builder);
    builder.MakeCompound(comp);
    builder.Add(comp, shape);
    builder.Add(comp, section);
    return comp;
  } catch {
    fail?.("the section builder threw");
    return shape;
  }
}

/** The bounding-box diagonal length of a shape (via `Bnd_Box` corners). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bboxDiagonal(oc: any, s: any, cleanup: Array<{ delete(): void }>): number {
  const box = new oc.Bnd_Box_1();
  cleanup.push(box);
  oc.BRepBndLib.Add(s, box, false);
  const mn = box.CornerMin();
  cleanup.push(mn);
  const mx = box.CornerMax();
  cleanup.push(mx);
  return Math.hypot(mx.X() - mn.X(), mx.Y() - mn.Y(), mx.Z() - mn.Z());
}

/** The bounding-box centre of a shape (via `Bnd_Box` corners). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bboxCenter(oc: any, s: any, cleanup: Array<{ delete(): void }>): Vec3 {
  const box = new oc.Bnd_Box_1();
  cleanup.push(box);
  oc.BRepBndLib.Add(s, box, false);
  const mn = box.CornerMin();
  cleanup.push(mn);
  const mx = box.CornerMax();
  cleanup.push(mx);
  return [(mn.X() + mx.X()) / 2, (mn.Y() + mx.Y()) / 2, (mn.Z() + mx.Z()) / 2];
}

/** The bounding-box min/max corners of a shape (via `Bnd_Box` corners) — used
 * by `alignSolids` to read a per-axis extent that `bboxCenter`/`bboxDiagonal`
 * don't expose, and by `entityFacts.ts`'s `checkInterferenceAll` for its cheap
 * AABB pair pre-filter (promoted from module-private to exported for that
 * caller, the same convention combineSolids/facePlane/bboxCenter each followed
 * for their own first cross-file caller). `Bnd_Box.Get()` is NOT bound in this
 * WASM build (see CLAUDE.md); `CornerMin`/`CornerMax` is the established
 * workaround every bbox reader here uses. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bboxExtent(oc: any, s: any, cleanup: Array<{ delete(): void }>): { min: Vec3; max: Vec3 } {
  const box = new oc.Bnd_Box_1();
  cleanup.push(box);
  oc.BRepBndLib.Add(s, box, false);
  const mn = box.CornerMin();
  cleanup.push(mn);
  const mx = box.CornerMax();
  cleanup.push(mx);
  return { min: [mn.X(), mn.Y(), mn.Z()], max: [mx.X(), mx.Y(), mx.Z()] };
}

/**
 * The analytic classification AND parameters of a face's surface, from ONE
 * `BRepAdaptor_Surface`.
 *
 * **Every accessor here was verified against the live WASM**, since none of
 * `.Cylinder()`/`.Cone()`/`.Sphere()`/`.Torus()` had a single call site in
 * this codebase and the bindings manifest lists class names only, with no
 * method-level information (this repo's history is full of green-but-broken
 * bindings — `ShapeFix_Shape`, `Message_ProgressRange_1`, `HLRBRep_*`).
 * Confirmed members: `gp_Cylinder{Radius,Location,Axis}`,
 * `gp_Cone{RefRadius,SemiAngle,Apex,Location,Axis}`,
 * `gp_Sphere{Radius,Location}` (note: **no `Axis()`**), and
 * `gp_Torus{MajorRadius,MinorRadius,Location,Axis}` — each round-tripped
 * against a primitive built with known parameters, and additionally against a
 * fillet-generated cylindrical face, which is the case that matters for
 * imported STEP (its faces come from someone else's kernel, not
 * `BRepPrimAPI`).
 *
 * **Every sub-accessor returns its own handle needing `.delete()`** — the
 * `gp_*` itself and each `Location()`/`Axis()`/`Direction()`/`Apex()` — hence
 * the cleanup discipline below, copied from what `facePlane` already did.
 *
 * **The type gate is symbolic and mandatory.** Calling the wrong accessor
 * (e.g. `.Cylinder()` on a plane) throws a raw JS `number` — an OCCT
 * exception pointer, not an `Error`, with no decoder available in this build
 * — so an escaped throw would surface to the user as the literal string
 * `"16412792"`. It is also not matched by `isOcctWasmAbort`, so it would not
 * trigger a (spurious) kernel reset. The `try/catch` below is what keeps that
 * contained; the parameter read degrades to `params: null` while `type` is
 * still reported.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function faceSurfaceInfo(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  oc: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  face: any,
  cleanup: Array<{ delete(): void }>
): { type: SurfaceType; params: SurfaceParams | null } {
  const surf = new oc.BRepAdaptor_Surface_2(face, true);
  cleanup.push(surf);
  const t = surf.GetType().value;
  const E = oc.GeomAbs_SurfaceType;

  // Keeps every handle a sub-accessor hands back, so the caller's `finally`
  // frees them in reverse order.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const keep = (...handles: any[]) => {
    for (const h of handles) if (h && typeof h.delete === "function") cleanup.push(h);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pointOf = (h: any): Vec3 => [h.X(), h.Y(), h.Z()];
  /** A `gp_Ax1`'s location + direction, both kept for cleanup. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const axisOf = (g: any): { loc: Vec3; dir: Vec3 } => {
    const ax = g.Axis();
    const l = ax.Location();
    const d = ax.Direction();
    const out = { loc: pointOf(l), dir: pointOf(d) };
    keep(ax, l, d);
    return out;
  };

  let type: SurfaceType = "other";
  let params: SurfaceParams | null = null;
  try {
    if (t === E.GeomAbs_Plane.value) {
      type = "plane";
      const pln = surf.Plane();
      const loc = pln.Location();
      const a = axisOf(pln);
      params = { kind: "plane", origin: pointOf(loc), normal: a.dir };
      keep(pln, loc);
    } else if (t === E.GeomAbs_Cylinder.value) {
      type = "cylinder";
      const cyl = surf.Cylinder();
      const a = axisOf(cyl);
      params = { kind: "cylinder", radius: cyl.Radius(), axisLocation: a.loc, axisDirection: a.dir };
      keep(cyl);
    } else if (t === E.GeomAbs_Cone.value) {
      type = "cone";
      const cone = surf.Cone();
      const a = axisOf(cone);
      const apex = cone.Apex();
      params = {
        kind: "cone",
        axisLocation: a.loc,
        axisDirection: a.dir,
        refRadius: cone.RefRadius(),
        apex: pointOf(apex),
        // Radians -> degrees, sign preserved (see SurfaceParams' doc).
        semiAngleDeg: cone.SemiAngle() * (180 / Math.PI),
      };
      keep(cone, apex);
    } else if (t === E.GeomAbs_Sphere.value) {
      type = "sphere";
      const sph = surf.Sphere();
      const loc = sph.Location();
      params = { kind: "sphere", center: pointOf(loc), radius: sph.Radius() };
      keep(sph, loc);
    } else if (t === E.GeomAbs_Torus.value) {
      type = "torus";
      const tor = surf.Torus();
      const a = axisOf(tor);
      params = {
        kind: "torus",
        axisLocation: a.loc,
        axisDirection: a.dir,
        majorRadius: tor.MajorRadius(),
        minorRadius: tor.MinorRadius(),
      };
      keep(tor);
    }
  } catch {
    // A parameter read failed; the classification stands on its own.
    params = null;
  }
  return { type, params };
}

/**
 * The (point, normal) of a planar face, or null if the face is not planar.
 *
 * A projection of {@link faceSurfaceInfo} — deliberately not a second reader,
 * so a plane's normal can never disagree with `surfaceParams`. Consumers:
 * `mateShape` below, and `entityFacts.ts`'s `measureExact` planar face-pair
 * branch.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function facePlane(oc: any, face: any, cleanup: Array<{ delete(): void }>): { pt: Vec3; nl: Vec3 } | null {
  try {
    const { params } = faceSurfaceInfo(oc, face, cleanup);
    return params?.kind === "plane" ? { pt: params.origin, nl: params.normal } : null;
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
 * Resolves an `edge-N` id back to its live edge — a thin wrapper around
 * `edgeEnumeration.ts`'s shared `enumerateEdges`, which is also what
 * `meshExtract.ts`'s `extractEdges` calls to assign `edge-N` ids in the first
 * place. Both paths now call the SAME enumerator, so a picked edge id is
 * guaranteed to resolve to the right live edge — see that module's doc
 * comment for why the two used to be independent, hand-duplicated copies and
 * why that was a latent id-corruption hazard.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function collectEdges(oc: any, shape: any, cleanup: Array<{ delete(): void }>): any[] {
  return enumerateEdges(oc, shape, cleanup).map((e) => e.edge);
}

/** Enumerates solids in deterministic explorer order, tagged `solid-N`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function collectSolids(oc: any, shape: any, cleanup: Array<{ delete(): void }>): Array<{ id: string; solid: any }> {
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

/**
 * Enumerates unique vertices in the SAME order `extractVertices`
 * (`src/meshExtract.ts`) assigns `point-N` ids: `HashCode`+`IsSame` de-dup,
 * unconditional over the whole shape (no solid-ownership split, unlike faces).
 * Unlike `collectFaces`/`collectEdges`, this has no other caller today — points
 * are never resolved as edit-op operands — but the Gmsh parts-correlation
 * pipeline (`src/gmshPartsMap.ts`) needs it to resolve a part's `point-N` ids
 * back to live vertices for physical-group/sizing-field creation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function collectVertices(oc: any, shape: any, cleanup: Array<{ delete(): void }>): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  const seen = new Map<number, Array<{ IsSame(o: unknown): boolean }>>();
  const exp = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_VERTEX,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE
  );
  cleanup.push(exp);
  for (; exp.More(); exp.Next()) {
    const vertex = oc.TopoDS.Vertex_1(exp.Current());
    const hash = vertex.HashCode(HASH_UPPER);
    const bucket = seen.get(hash);
    if (bucket && bucket.some((v) => v.IsSame(vertex))) { vertex.delete(); continue; }
    cleanup.push(vertex);
    if (bucket) bucket.push(vertex); else seen.set(hash, [vertex]);
    out.push(vertex);
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function vec(oc: any, v: Vec3): any { return new oc.gp_Vec_4(v[0], v[1], v[2]); }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pnt(oc: any, v: Vec3): any { return new oc.gp_Pnt_3(v[0], v[1], v[2]); }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dir(oc: any, v: Vec3): any { return new oc.gp_Dir_4(v[0], v[1], v[2]); }
