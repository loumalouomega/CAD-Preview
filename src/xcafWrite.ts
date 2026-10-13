import type { Part } from "./protocol";
import { collectSolids } from "./occtOperations";

/**
 * XCAF (Extended CAF) assembly-structure WRITING — roadmap "XCAF write —
 * assembly structure and per-part colors", closed as assembly-structure +
 * per-part NAMES only. This is the write-side mirror of `xcafTree.ts`'s
 * `readXcafAssembly`, and reuses none of its code (reading and writing go
 * through entirely different OCCT classes), but follows its exact
 * conventions: pure-effort enhancement over the plain `STEPControl_Writer`
 * path, `null` on anything it can't confidently do, never a hard failure.
 *
 * **Per-part COLOR export was declared "genuinely non-functional in this
 * build" here, and that conclusion was WRONG — it was an artefact of a
 * different bug.** Every attempt (label- and shape-based `SetColor`, RGB and
 * RGBA, `Transfer_1`+`Write` vs `Perform_1`, `STEPCAFControl_Controller.Init()`)
 * emitted no `COLOUR_RGB`/`STYLED_ITEM` because the writer was being driven in
 * OCCT's MULTI-FILE mode (see {@link writeXcafStep}), which writes the main
 * file as a bare product tree with no geometry at all — a style has nothing to
 * attach to. Re-probed with the single-file `Perform_2` (2026-10-13):
 * `XCAFDoc_ColorTool.SetColor_2(label, Quantity_Color_3(r, g, b,
 * Quantity_TOC_RGB), XCAFDoc_ColorSurf)` and the shape-based `SetColor_5`
 * both produce one `COLOUR_RGB` and one `STYLED_ITEM` beside the solid.
 * Adopting it (and then re-checking the READ side, whose "colours dead"
 * finding in `xcafTree.ts` may share the cause) is a separate, roadmap-tracked
 * step; this module still writes names only, and still sets
 * `SetColorMode(true)` so colours flow the moment a caller sets them.
 *
 * **Assembly structure + names DO work and are what this module ships.**
 * `shapeTool.AddShape(shape, makeAssembly, makePrepare)` (no `_N` suffix —
 * unlike almost every other OCCT class in this codebase, this method has
 * exactly one bound overload) on a multi-solid shape with `makeAssembly:
 * true` auto-decomposes it into one assembly label + one component label
 * per solid — **verified, not assumed, to walk components in the SAME
 * order `collectSolids`'s `TopExp_Explorer` gives** (a hand-built compound
 * of a box/sphere/cylinder, walked via `TDF_ChildIterator` after
 * `AddShape`, gave back volumes in the exact box/sphere/cylinder creation
 * order, matching a direct `TopExp_Explorer` pass over the same compound)
 * — this correlation is what lets `names[idx]` (from {@link namesForSolids})
 * below assign the right name to the right component with zero extra
 * geometric matching. `TDataStd_Name.Set_1(label, TCollection_ExtendedString)` works
 * for writing (unlike the READ side's confirmed-dead `TCollection_
 * ExtendedString` → JS string extraction — this direction only ever
 * CONSTRUCTS one from a JS string, never reads one back).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pushGet(handle: any, cleanup: Array<{ delete(): void }>): any {
  cleanup.push(handle);
  return handle.get();
}

/**
 * Pure matching logic, split out from {@link buildXcafDocumentForExport} so
 * it unit-tests without OCCT: for each id in `solidIds` (expected to be
 * `solid-N` ids in `collectSolids`'s own deterministic order), returns the
 * name of whichever `Part` lists that id in its `volumes`, or `undefined`
 * if no part claims it. A solid claimed by more than one part (a
 * sidecar-editing edge case `validateEditOp`/the Parts panel don't
 * otherwise prevent) takes the FIRST matching part's name, same
 * first-match convention `Array.prototype.find` already gives every other
 * "resolve an id against a Part list" call site in this codebase.
 */
export function namesForSolids(solidIds: string[], parts: Part[]): Array<string | undefined> {
  return solidIds.map((id) => parts.find((p) => p.volumes.includes(id))?.name);
}

/**
 * Builds an XCAF document carrying `shape`'s assembly structure and, for
 * each solid whose `solid-N` id is assigned to a `Part`, that part's name.
 * Returns `null` (never throws) when there's nothing meaningful to do —
 * no parts, no solids, or no part actually names any solid — so callers
 * fall back to the plain `STEPControl_Writer`, a zero-behavior-change
 * default for the overwhelming majority of exports (no parts assigned).
 * A structural surprise (the multi-solid `AddShape` call not producing an
 * assembly, or its component count not matching `collectSolids`) also
 * returns `null` rather than risk silently mislabeling a component —
 * same "never guess, degrade instead" rule as every other op in this
 * codebase.
 *
 * Every OCCT handle this function creates is pushed onto `cleanup`; the
 * returned `Handle_TDocStd_Document` (needed by `STEPCAFControl_Writer.
 * Transfer_1`) is included, so the caller must NOT dispose it separately.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildXcafDocumentForExport(oc: any, shape: any, parts: Part[], cleanup: Array<{ delete(): void }>): unknown | null {
  if (parts.length === 0) return null;
  const solids = collectSolids(oc, shape, cleanup);
  if (solids.length === 0) return null;

  const names = namesForSolids(solids.map((s) => s.id), parts);
  if (names.every((n) => n === undefined)) return null;

  const app = new oc.TDocStd_Application();
  cleanup.push(app);
  const docHandle = new oc.Handle_TDocStd_Document_1();
  cleanup.push(docHandle);
  app.NewDocument(new oc.TCollection_ExtendedString_2("XmlXCAF", true), docHandle);
  const doc = docHandle.get();
  if (!doc) return null;

  const shapeTool = pushGet(oc.XCAFDoc_DocumentTool.ShapeTool(doc.Main()), cleanup);

  const setName = (label: unknown, name: string) => {
    oc.TDataStd_Name.Set_1(label, new oc.TCollection_ExtendedString_2(name, true));
  };

  if (solids.length === 1) {
    const label = shapeTool.AddShape(solids[0].solid, false, true);
    cleanup.push(label);
    if (names[0]) setName(label, names[0]);
    return docHandle;
  }

  const topLabel = shapeTool.AddShape(shape, true, true);
  cleanup.push(topLabel);
  if (!oc.XCAFDoc_ShapeTool.IsAssembly(topLabel)) return null;

  const it = new oc.TDF_ChildIterator_2(topLabel, false);
  cleanup.push(it);
  let idx = 0;
  while (it.More()) {
    const childLabel = it.Value();
    const referredLabel = new oc.TDF_Label();
    cleanup.push(referredLabel);
    const hasReferred = oc.XCAFDoc_ShapeTool.GetReferredShape(childLabel, referredLabel);
    const targetLabel = hasReferred ? referredLabel : childLabel;
    if (idx < names.length && names[idx]) setName(targetLabel, names[idx] as string);
    idx++;
    it.Next();
  }
  if (idx !== solids.length) return null;

  shapeTool.UpdateAssemblies();
  return docHandle;
}

/**
 * Writes `docHandle` (from {@link buildXcafDocumentForExport}) to
 * `filePath` as STEP via `STEPCAFControl_Writer`. Throws on a genuine
 * writer failure, same convention as `occtService.ts`'s plain
 * `STEPControl_Writer` path.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function writeXcafStep(oc: any, docHandle: unknown, filePath: string, cleanup: Array<{ delete(): void }>): void {
  const writer = new oc.STEPCAFControl_Writer_1();
  cleanup.push(writer);
  writer.SetNameMode(true);
  // Set even though color export doesn't currently work in this build (see
  // module doc comment) — harmless, and free if a future fix lands.
  writer.SetColorMode(true);
  writer.SetLayerMode(false);
  // `Perform_2(doc, path)` (a C string) transfers the whole document and
  // writes ONE self-contained file. The two-step `Transfer_1(doc, mode, multi)`
  // + `Write` form cannot be used here: its third argument is a `std::string`
  // in this binding (null/undefined/0 are all rejected — "Cannot pass
  // non-string to std::string"), and the only value it accepts, `""`, selects
  // OCCT's MULTI-FILE mode. That mode writes the main file as a bare product
  // tree with NO geometry (every shape representation empty) and puts each
  // part into a separate `<PartName>.stp` beside it — here, in the MEMFS root,
  // where the files leaked and where a reload in the same long-lived process
  // quietly found them again. A fresh process saw 0 solids. This was the
  // "AP242 document management quirk" the read-side fallback below was written
  // for; it was the multi-file output, not an inherent property of the writer.
  const ok = writer.Perform_2(docHandle, filePath);
  if (!ok) throw new Error("STEP (XCAF) Write failed");
}

/**
 * Read-side counterpart. HISTORY, corrected 2026-10-13: this was written
 * because this module's own STEP output unconditionally carried AP242
 * "document management" entities (`DOCUMENT_FILE`/`APPLIED_EXTERNAL_
 * IDENTIFICATION_ASSIGNMENT`, one per named part, e.g. `SOLID.stp`) that the
 * plain `STEPControl_Reader` could not turn into shapes, and it was attributed
 * to "an unconditional default of this build's writer". It was not: those
 * entities, and the empty shape representations, were the MULTI-FILE output of
 * `Transfer_1(..., "")` (see {@link writeXcafStep}). The writer now produces a
 * single self-contained file the plain reader reads directly, so this fallback
 * is no longer reached for this module's own output; it stays, harmless and
 * unreachable for ordinary files, for any other document-wrapped STEP. The
 * original description follows; its claim that the CAF reader "recovers every
 * solid's exact volume" was observed in a long-lived process where the
 * multi-file siblings were still sitting in MEMFS, so treat it as UNVERIFIED
 * for a genuinely geometry-less file (a fresh process read 0 solids):
 * the SAME bytes that make
 * `STEPControl_Reader`'s `TransferRoots()`/`NbShapes()` come back `0`
 * (confirmed correlated: `NbRootsForTransfer()` still finds `1` — the
 * "document" root — but transferring it yields no shape) parse CLEANLY
 * through `STEPCAFControl_Reader`, recovering every solid's exact volume.
 * A real externally-authored assembly file (`examples/STP/bull.stp`) has
 * NONE of this "document" wrapper and reads fine via the plain reader —
 * this fallback exists ONLY for STEP files this codebase's own XCAF writer
 * produced (or any other document-management-wrapped STEP), and is a
 * no-op (never even constructs a `TDocStd_Application`) for every file
 * that already reads normally.
 *
 * Returns `null` (never throws) on any failure — same best-effort
 * convention as `readXcafAssembly`. `occtService.ts`'s `readShape` calls
 * this ONLY when the plain `STEPControl_Reader` recovers zero shapes
 * (`NbShapes() === 0`), so every pre-existing STEP file in this codebase's
 * fixtures/tests is completely unaffected — this fallback path was never
 * reachable before this feature existed and, since it's newly added, has
 * exactly one real caller: reopening a file this codebase itself just
 * exported with named parts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readXcafFallbackShape(oc: any, filePath: string, cleanup: Array<{ delete(): void }>): unknown | null {
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
    const it = new oc.TDF_ChildIterator_2(shapesLabel, false);
    cleanup.push(it);

    const freeShapes: unknown[] = [];
    while (it.More()) {
      const label = it.Value();
      if (oc.XCAFDoc_ShapeTool.IsFree(label)) {
        const shape = oc.XCAFDoc_ShapeTool.GetShape_2(label);
        cleanup.push(shape);
        freeShapes.push(shape);
      }
      it.Next();
    }
    if (freeShapes.length === 0) return null;
    if (freeShapes.length === 1) return freeShapes[0];

    const builder = new oc.BRep_Builder();
    cleanup.push(builder);
    const compound = new oc.TopoDS_Compound();
    cleanup.push(compound);
    builder.MakeCompound(compound);
    for (const s of freeShapes) builder.Add(compound, s);
    return compound;
  } catch {
    return null;
  }
}
