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
