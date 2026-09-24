/**
 * B-rep validity report — the kernel half (the read-only sibling of
 * `meshHeal.ts`'s `checkMeshHealth` for exact geometry). Facts only: OCCT's
 * own checkers decide validity, this module just enumerates and names what
 * they say. No repair — `ShapeFix_*` is mostly dead in this build and this
 * report is read-only by design.
 *
 * Call shapes, verified against the live WASM (opencascade.js 1.1.1) by the
 * probe recorded in CLAUDE.md's "B-rep validity report" section:
 * - `new oc.BRepCheck_Analyzer(shape, true)` — exactly 2 args (the 4-arg
 *   parallel/exact form is not bound); geometric controls on.
 * - `IsValid_2()` is the WHOLE-shape overload, `IsValid_1(sub)` the
 *   per-subshape one (the suffix order is the reverse of the header's).
 * - `Result(sub)` → `Handle_BRepCheck_Result`; `.get().Status()` for the
 *   subshape's own statuses, `InitContextIterator`/`MoreShapeInContext`/
 *   `StatusOnShape_2`/`NextShapeInContext` for statuses judged in a parent's
 *   context (daratech.stp's `UnorientableShape` faces surface there).
 * - `BRepCheck_ListOfStatus_3(list)` is the copy ctor (`_2` takes an
 *   allocator); a copy is drained with `First_1`/`RemoveFirst` so the
 *   analyzer's own list is never mutated.
 * - `ShapeAnalysis_ShapeContents` (unsuffixed) `.Perform(shape)` + `Nb*`.
 * - `ShapeAnalysis_Shell` (unsuffixed) `.LoadShells(s)` +
 *   `CheckOrientedShells(s, true, false)` + `.FreeEdges()` (a compound).
 */
import { getOcct, readShape, wrapOcctFault } from "./occtService";
import { applyEditsBRep, collectEdges, collectFaces, collectSolids } from "./occtOperations";
import type { EditOp } from "./editOps";
import type { BRepFormat } from "./massProperties";
import {
  capIssues,
  statusNameTable,
  statusNames,
  type BrepHealthCounters,
  type BrepHealthReport,
  type BrepSolidHealth,
  type BrepSubshapeIssue,
} from "./brepHealthReport";

type Cleanup = Array<{ delete(): void }>;

/** Drains a COPY of a `BRepCheck_ListOfStatus` into raw values. */
function statusValues(oc: any, list: any): number[] {
  const out: number[] = [];
  const copy = new oc.BRepCheck_ListOfStatus_3(list);
  try {
    // A status list is a handful of entries; the guard only protects against
    // a binding that never shrinks the list.
    for (let guard = 0; copy.Size() > 0 && guard < 256; guard++) {
      out.push(copy.First_1().value);
      copy.RemoveFirst();
    }
  } finally {
    copy.delete();
  }
  return out;
}

/** Own + contextual status values of one subshape (empty if no result). */
function subshapeStatusValues(oc: any, analyzer: any, sub: any): number[] {
  const handle = analyzer.Result(sub);
  if (!handle || handle.IsNull()) return [];
  const result = handle.get();
  const values = statusValues(oc, result.Status());
  result.InitContextIterator();
  for (let guard = 0; result.MoreShapeInContext() && guard < 1024; guard++) {
    values.push(...statusValues(oc, result.StatusOnShape_2()));
    result.NextShapeInContext();
  }
  return values;
}

function explore(oc: any, shape: any, kind: any, cleanup: Cleanup): any[] {
  const out: any[] = [];
  const ex = new oc.TopExp_Explorer_2(shape, kind, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  cleanup.push(ex);
  for (; ex.More(); ex.Next()) {
    const s = ex.Current();
    cleanup.push(s);
    out.push(s);
  }
  return out;
}

/** Open-boundary edges of every shell in `shape` (`null` if uncomputable). */
function openBoundaryEdges(oc: any, shape: any, cleanup: Cleanup): number | null {
  try {
    const sas = new oc.ShapeAnalysis_Shell();
    cleanup.push(sas);
    sas.LoadShells(shape);
    sas.CheckOrientedShells(shape, true, false);
    if (!sas.HasFreeEdges()) return 0;
    const free = sas.FreeEdges();
    cleanup.push(free);
    return explore(oc, free, oc.TopAbs_ShapeEnum.TopAbs_EDGE, cleanup).length;
  } catch {
    return null;
  }
}

function contentCounters(oc: any, shape: any, cleanup: Cleanup): BrepHealthCounters | null {
  try {
    const sc = new oc.ShapeAnalysis_ShapeContents();
    cleanup.push(sc);
    sc.Perform(shape);
    return {
      solids: sc.NbSolids(),
      shells: sc.NbShells(),
      faces: sc.NbFaces(),
      edges: sc.NbEdges(),
      looseEdges: sc.NbFreeEdges(),
      looseFaces: sc.NbFreeFaces(),
      looseWires: sc.NbFreeWires(),
      solidsWithVoids: sc.NbSolidsWithVoids(),
    };
  } catch {
    return null;
  }
}

export async function checkBrepHealth(
  extensionPath: string,
  bytes: Uint8Array,
  format: BRepFormat,
  ops: EditOp[]
): Promise<BrepHealthReport> {
  const oc = await getOcct(extensionPath);
  const tmpName = `/bh.${format}`; // ≤10 chars — the MEMFS path-length cliff
  oc.FS.writeFile(tmpName, bytes);
  const cleanup: Cleanup = [];
  const t0 = Date.now();
  try {
    const baseShape = readShape(oc, tmpName, format, cleanup);
    const shape = applyEditsBRep(oc, baseShape, ops, cleanup);
    const table = statusNameTable(oc.BRepCheck_Status);

    const analyzer = new oc.BRepCheck_Analyzer(shape, true);
    cleanup.push(analyzer);
    const valid: boolean = analyzer.IsValid_2();

    const shellKind = oc.TopAbs_ShapeEnum.TopAbs_SHELL;
    const solids = collectSolids(oc, shape, cleanup);
    const groups: Array<[string, any[]]> = [
      ["solid", solids.map((s) => s.solid)],
      ["shell", explore(oc, shape, shellKind, cleanup)],
      ["face", collectFaces(oc, shape, cleanup)],
      ["edge", collectEdges(oc, shape, cleanup)],
    ];

    const issues: BrepSubshapeIssue[] = [];
    let analyzed = 0;
    for (const [kind, subs] of groups) {
      subs.forEach((sub, i) => {
        analyzed++;
        const subValid: boolean = analyzer.IsValid_1(sub);
        const names = statusNames(subshapeStatusValues(oc, analyzer, sub), table);
        if (!subValid || names.length > 0) issues.push({ id: `${kind}-${i}`, statuses: names, valid: subValid });
      });
    }

    const solidReports: BrepSolidHealth[] = solids.map((s) => {
      const shells = explore(oc, s.solid, shellKind, cleanup);
      const openShellCount = shells.filter((sh) =>
        statusNames(subshapeStatusValues(oc, analyzer, sh), table).includes("NotClosed")
      ).length;
      return {
        solidId: s.id,
        valid: analyzer.IsValid_1(s.solid),
        shellCount: shells.length,
        openShellCount,
        openBoundaryEdgeCount: openBoundaryEdges(oc, s.solid, cleanup),
      };
    });

    return {
      valid,
      counters: contentCounters(oc, shape, cleanup),
      openBoundaryEdgeCount: openBoundaryEdges(oc, shape, cleanup),
      solids: solidReports,
      issues: capIssues(issues),
      issueCount: issues.length,
      analyzedSubshapes: analyzed,
      elapsedMs: Date.now() - t0,
    };
  } catch (err) {
    throw wrapOcctFault(err);
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try {
        cleanup[i].delete();
      } catch {
        /* already freed with its owner */
      }
    }
    try {
      oc.FS.unlink(tmpName);
    } catch {
      /* not written */
    }
  }
}
