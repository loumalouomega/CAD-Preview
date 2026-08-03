import type { Vec3 } from "./editOps";
import type { TreeNode } from "./protocol";
import { bboxCenter } from "./occtOperations";
import { rebindEntities, type EntitySignature } from "./entityRebind";

/**
 * XCAF (Extended CAF) assembly-structure reading — roadmap "XCAF read —
 * assembly structure and colors", closed. **Product names and colors are
 * out of scope**: names are confirmed kernel-blocked in this OCCT WASM build
 * (`TCollection_ExtendedString` → JS string extraction is dead every way
 * tried — `.ToExtString()`/`.ToUTF8CString()` throw on unbound raw-pointer
 * return types, `.Value(i)` throws on an unbound `Standard_ExtCharacter`,
 * and no `TCollection_AsciiString` constructor overload accepts an extended
 * string), and colors remain genuinely unresolved (the one `XCAFDoc_ColorTool
 * .GetColor` overload's real argument shape wasn't found by probing). Only
 * the confirmed-working piece — real assembly/component hierarchy instead of
 * a flat `"Solid N"` list — is implemented here.
 *
 * B-rep entity ids (`solid-N`) are the single most-referenced string in this
 * codebase (`.parts.json`, `.edits.json`, every op operand, every id an agent
 * has recorded) and their enumeration order/count is a strict invariant this
 * module must never touch. `readXcafAssembly` is therefore entirely
 * SEPARATE from that pipeline: it does its own independent
 * `STEPCAFControl_Reader` parse (of the SAME file, already sitting on
 * MEMFS), builds a tree with SYNTHETIC leaf ids, and computes each leaf's
 * own geometric fingerprint (bbox centre + volume). `correlateAssemblyTree`
 * then matches those fingerprints against the REAL, already-established
 * `solid-N` list via the exact same greedy nearest-neighbor bipartite
 * matcher `src/entityRebind.ts` already uses for the unrelated (but
 * structurally identical) "did this id drift after an edit" problem — a
 * clean 1:1 bijection is required, or the caller falls back to the flat
 * tree entirely, since a partially-correlated tree would confuse a user
 * worse than the flat list it replaces. Both halves are split so the
 * (relatively expensive — a full second STEP parse) XCAF read can be cached
 * independently of the (cheap — pure JS, no OCCT calls) correlation, which
 * must re-run on every edit since a topology-changing op changes which
 * `solid-N` a given real-world solid maps to.
 */

/** One leaf's geometric fingerprint, keyed by its synthetic tree-node id
 * (e.g. `"xcaf-leaf-3"`) — the `EntitySignature.id` `correlateAssemblyTree`
 * matches against the real `solid-N` list. */
export interface XcafLeafSignature {
  id: string;
  centre: Vec3;
  volume: number;
}

export interface XcafAssemblyInfo {
  /** The tree with synthetic leaf ids — not yet meaningful to the webview
   * until `correlateAssemblyTree` relabels every leaf to a real `solid-N`. */
  tree: TreeNode;
  sigs: XcafLeafSignature[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function volumeOf(oc: any, shape: any, cleanup: Array<{ delete(): void }>): number {
  const props = new oc.GProp_GProps_1();
  cleanup.push(props);
  oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
  return props.Mass();
}

/**
 * Reads a STEP file's XCAF assembly hierarchy — an entirely independent
 * `STEPCAFControl_Reader` parse of `filePath` (which must still be present
 * on MEMFS; callers own writing/unlinking it, same as `readShape`'s own
 * `tmpName` convention). Returns `null` on ANY failure (no XCAF structure,
 * a parse error, an unbound API in a future OCCT build) — this is always a
 * best-effort enhancement over the flat tree, never a hard requirement.
 *
 * **`GetShape_2(label)` on a component/reference label returns a shape that
 * already carries THAT component's own local placement baked in as its
 * `.Location_1()`** — verified against the live WASM the hard way: a first
 * attempt applied `outerLoc.Multiplied(ownLoc)` via `.Moved()` to this
 * already-located shape, which DOUBLE-applied `ownLoc` (`.Moved()` COMPOSES
 * with a shape's existing location, confirmed via a plain box:
 * `shapeAt100.Moved(loc2)` gives `loc1+loc2`, not `loc2` alone) — silently
 * correct only for the two leaves whose own placement happened to be
 * identity, and silently WRONG (some leaves landing on identical, and
 * therefore un-bijectable, world positions) for every rotated/offset one.
 * The fix: apply only the ANCESTOR-accumulated `outerLoc` via `.Moved()`
 * (the leaf's own placement is already part of what `GetShape_2` returned),
 * while still folding `ownLoc` into what's passed DOWN to children
 * (`combinedLoc = outerLoc.Multiplied(ownLoc)`) — verified end-to-end on
 * `as1_pe.stp` (a real 2-level-deep, 12-solid assembly with 2 repeated
 * sub-assembly instances and 3 rotated, repeated-geometry bolts): every one
 * of the 12 leaves' corrected world position now matches its corresponding
 * flat `solid-N`'s bbox centre exactly, where the buggy version only
 * matched 3 (the two identity-placement leaves plus one coincidence).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readXcafAssembly(oc: any, filePath: string): XcafAssemblyInfo | null {
  const cleanup: Array<{ delete(): void }> = [];
  try {
    const app = new oc.TDocStd_Application();
    cleanup.push(app);
    const docHandle = new oc.Handle_TDocStd_Document_1();
    cleanup.push(docHandle);
    app.NewDocument(new oc.TCollection_ExtendedString_2("XmlXCAF", true), docHandle);
    const doc = docHandle.get();
    if (!doc) return null;

    const reader = new oc.STEPCAFControl_Reader_1();
    cleanup.push(reader);
    const retDone = oc.IFSelect_ReturnStatus.IFSelect_RetDone.value;
    const ret = reader.ReadFile(filePath);
    if (ret.value !== retDone) return null;
    if (!reader.Transfer_1(docHandle)) return null;

    const shapesLabel = oc.XCAFDoc_DocumentTool.ShapesLabel(doc.Main());
    cleanup.push(shapesLabel);

    let assemblyCounter = 0;
    let leafCounter = 0;
    const sigs: XcafLeafSignature[] = [];
    const identityLoc = new oc.TopLoc_Location_1();
    cleanup.push(identityLoc);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolveComponent = (label: any, outerLoc: any, depth: number): TreeNode | null => {
      if (depth > 32) return null; // defensive circuit breaker against a malformed/cyclic document, not a design choice
      const shape = oc.XCAFDoc_ShapeTool.GetShape_2(label);
      cleanup.push(shape);
      const ownLoc = shape.Location_1();
      cleanup.push(ownLoc);
      const combinedLoc = outerLoc.Multiplied(ownLoc);
      cleanup.push(combinedLoc);

      const referredLabel = new oc.TDF_Label();
      cleanup.push(referredLabel);
      const hasReferred = oc.XCAFDoc_ShapeTool.GetReferredShape(label, referredLabel);
      const targetLabel = hasReferred ? referredLabel : label;

      if (oc.XCAFDoc_ShapeTool.IsAssembly(targetLabel)) {
        assemblyCounter++;
        const children: TreeNode[] = [];
        const it = new oc.TDF_ChildIterator_2(targetLabel, false);
        cleanup.push(it);
        while (it.More()) {
          const child = resolveComponent(it.Value(), combinedLoc, depth + 1);
          if (child) children.push(child);
          it.Next();
        }
        return children.length > 0 ? { id: `xcaf-asm-${assemblyCounter}`, label: `Assembly ${assemblyCounter}`, children } : null;
      }

      // Leaf (simple shape). `shape` already carries its own local placement
      // — apply only the ancestor-accumulated transform (see doc comment above).
      const positioned = shape.Moved(outerLoc);
      cleanup.push(positioned);
      const exp = new oc.TopExp_Explorer_2(positioned, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      cleanup.push(exp);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const solids: any[] = [];
      while (exp.More()) {
        const s = oc.TopoDS.Solid_1(exp.Current());
        cleanup.push(s);
        solids.push(s);
        exp.Next();
      }
      if (solids.length === 0) return null;
      if (solids.length === 1) {
        leafCounter++;
        const id = `xcaf-leaf-${leafCounter}`;
        sigs.push({ id, centre: bboxCenter(oc, solids[0], cleanup), volume: volumeOf(oc, solids[0], cleanup) });
        return { id, label: `Component ${leafCounter}` };
      }
      // A "simple shape" label whose own shape is itself a multi-solid
      // compound — nest each solid as its own leaf under a synthetic group.
      assemblyCounter++;
      const children: TreeNode[] = [];
      for (const s of solids) {
        leafCounter++;
        const id = `xcaf-leaf-${leafCounter}`;
        sigs.push({ id, centre: bboxCenter(oc, s, cleanup), volume: volumeOf(oc, s, cleanup) });
        children.push({ id, label: `Solid ${leafCounter}` });
      }
      return { id: `xcaf-asm-${assemblyCounter}`, label: `Component ${assemblyCounter}`, children };
    };

    const rootChildren: TreeNode[] = [];
    const rootIt = new oc.TDF_ChildIterator_2(shapesLabel, false);
    cleanup.push(rootIt);
    while (rootIt.More()) {
      const label = rootIt.Value();
      if (oc.XCAFDoc_ShapeTool.IsFree(label)) {
        const child = resolveComponent(label, identityLoc, 0);
        if (child) rootChildren.push(child);
      }
      rootIt.Next();
    }
    if (rootChildren.length === 0 || sigs.length === 0) return null;

    return { tree: { id: "root", label: "root", children: rootChildren }, sigs };
  } catch {
    return null;
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try {
        cleanup[i].delete();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Correlates an `XcafAssemblyInfo`'s synthetic-id leaves against the
 * CURRENT, real `solid-N` fingerprints (pure JS — no OCCT calls, so this is
 * cheap enough to re-run on every `loadBRep`/`loadBRepCached` call even
 * though `readXcafAssembly` itself is cached across them). Requires a
 * CLEAN BIJECTION — every XCAF leaf matched to exactly one real solid and
 * vice versa, with none left over — or returns `null`, in which case the
 * caller falls back to the flat tree. This is deliberately strict: a
 * topology-changing edit op (an added primitive, a boolean, …) changes the
 * real solid count/positions in ways `readXcafAssembly`'s cached, ops-
 * unaware structure has no way to reflect, and a partially-stale assembly
 * tree would be actively misleading rather than merely incomplete.
 */
export function correlateAssemblyTree(
  info: XcafAssemblyInfo,
  currentSolids: XcafLeafSignature[]
): TreeNode | null {
  if (info.sigs.length !== currentSolids.length) return null;
  const oldSigs: EntitySignature[] = info.sigs.map((s) => ({ id: s.id, kind: "solid", centre: s.centre, measure: s.volume }));
  const newSigs: EntitySignature[] = currentSolids.map((s) => ({ id: s.id, kind: "solid", centre: s.centre, measure: s.volume }));
  const diag = Math.hypot(...(boundingExtent(currentSolids.map((s) => s.centre)) as Vec3));
  const toleranceAbs = Math.max(1e-3 * diag, 1e-6);
  const matches = rebindEntities(oldSigs, newSigs, toleranceAbs);
  if (matches.length !== info.sigs.length) return null; // not a clean bijection

  const idMap = new Map(matches.map((m) => [m.oldId, m.newId]));
  const relabel = (node: TreeNode): TreeNode | null => {
    if (node.children) {
      const children = node.children.map(relabel).filter((n): n is TreeNode => n !== null);
      return children.length > 0 ? { ...node, children } : null;
    }
    const mapped = idMap.get(node.id);
    return mapped ? { ...node, id: mapped } : null;
  };
  const relabeled = info.tree.children!.map(relabel).filter((n): n is TreeNode => n !== null);
  if (relabeled.length === 0) return null;
  return { id: "root", label: info.tree.label, children: relabeled };
}

/** The span of a point cloud's own bounding box (max - min per axis) — used
 * as a scale reference for the correlation tolerance above, since the
 * fingerprints here are bare centre/volume pairs with no live `Bnd_Box` to
 * measure a diagonal from directly. */
function boundingExtent(points: Vec3[]): Vec3 {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [x, y, z] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return [0, 0, 0];
  return [maxX - minX, maxY - minY, maxZ - minZ];
}
