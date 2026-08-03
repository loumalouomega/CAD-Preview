import * as fs from "fs";
import * as path from "path";
// Use the raw emscripten factory directly (NOT the initOpenCascade wrapper from
// index.js, which takes no arguments and ignores wasmBinary). Passing wasmBinary
// bypasses Node 18's built-in fetch(), which fails to parse filesystem paths.
import openCascadeFactory from "opencascade.js/dist/opencascade.wasm.js";
import { tessellateByGroup, extractEdges, extractVertices, type SolidGroup, type EdgeLine, type PointEntity } from "./meshExtract";
import { applyEditsBRep, scaleShapeForExport, collectSolids, bboxCenter } from "./occtOperations";
import { readXcafAssembly, correlateAssemblyTree, type XcafAssemblyInfo } from "./xcafTree";
import { buildXcafDocumentForExport, writeXcafStep, readXcafFallbackShape } from "./xcafWrite";
import type { TreeNode, Part } from "./protocol";
import type { CadFormat } from "./fileRouter";
import type { EditOp } from "./editOps";
import { type DisplayUnit, unitScaleFactor, igesUnitName } from "./lengthUnits";
import { patchStepUnitDeclaration } from "./stepUnitPatch";
import { TESSELLATION_PRESETS, type TessellationParams } from "./tessellationQuality";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _ocPromise: Promise<any> | null = null;

/**
 * Returns the OpenCascade.js module, initializing it lazily on first call and
 * memoizing the resolved promise as a module singleton. A REJECTED init is
 * deliberately NOT memoized (the `.catch` below un-caches it before
 * rethrowing) — without this, a single transient init failure (e.g. a
 * momentary FS/allocation error) would poison every later `getOcct()` call
 * in the same extension-host process forever, since `_ocPromise` would keep
 * resolving to the same rejection. `fs.readFileSync` itself already fails
 * this way "for free" (it throws synchronously before the assignment), so
 * this only closes the gap for a rejection from `openCascadeFactory` itself.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getOcct(extensionPath: string): Promise<any> {
  if (!_ocPromise) {
    const wasmPath = path.join(extensionPath, "dist", "opencascade.wasm.wasm");
    const wasmBinary = fs.readFileSync(wasmPath);
    _ocPromise = openCascadeFactory({ wasmBinary }).catch((err) => {
      _ocPromise = null;
      throw err;
    });
  }
  return _ocPromise;
}

/** Resets the singleton — called by `wrapOcctFault` after a WASM abort, and
 * from tests. */
export function resetOcct(): void {
  _ocPromise = null;
}

/**
 * Emscripten aborts (out-of-bounds access, unreachable, null function
 * pointer, heap exhaustion) surface as opaque `RuntimeError`s — same
 * vocabulary `gmshService.ts`'s `isWasmAbort` recognizes for the identical
 * reason, kept as its own local copy here rather than shared, matching this
 * codebase's convention of each kernel's fault handling staying self-
 * contained in its own service file.
 */
function isOcctWasmAbort(message: string): boolean {
  return /out of bounds|abort|RuntimeError|unreachable|null function|table index/i.test(message);
}

/**
 * Every OCCT-touching entry point in this codebase (this file's `loadBRep`/
 * `exportBRep`, plus `massProperties.ts`, `modelDiffHost.ts`,
 * `gmshPartsMap.ts`, and `entityFacts.ts`'s five functions) wraps its body's
 * `catch` with this. A WASM abort mid-operation leaves the Emscripten
 * instance permanently corrupt — every later call would keep throwing the
 * same opaque "memory access out of bounds" — so this resets the singleton
 * (`resetOcct()`) to force a fresh module on the next attempt, mirroring
 * `gmshService.ts`'s `runMeshGenerate` exactly. A non-abort error (e.g. an
 * "Unknown entity id" thrown deliberately inside a `try`) passes through
 * unchanged — `isOcctWasmAbort`'s vocabulary never matches ordinary
 * application errors.
 */
export function wrapOcctFault(err: unknown): Error {
  const raw = ((err as Error)?.message ?? String(err)).trim();
  if (!isOcctWasmAbort(raw)) return err instanceof Error ? err : new Error(raw);
  resetOcct();
  return new Error(`OCCT crashed (${raw || "WASM abort"}) — the kernel has been reset; try the operation again.`);
}

export interface BRepResult {
  groups: SolidGroup[];
  edges: EdgeLine[];
  points: PointEntity[];
  tree: TreeNode;
}

/**
 * A cached, still-live parse-plus-replay result for one document, held by
 * `provider.ts` across successive `editsChanged` calls (roadmap "Base-shape
 * caching and incremental replay", closed) — see `loadBRepCached` below for
 * the reuse rules and `disposeBRepCache` for the required teardown.
 * `baseShape`/`shape` are live OCCT heap handles, not JS data; every field
 * here is opaque outside this file except for what `loadBRepCached`'s own
 * bytes/ops comparisons need, which is why this type isn't exported as
 * anything richer than "a token you hold and pass back".
 */
export interface BRepCacheEntry {
  /** Reference to the resolved `oc` module this entry's handles belong to —
   * an abort-triggered `resetOcct()` replaces `_ocPromise`, so a STALE
   * entry's handles would point into a now-discarded WASM instance. Compared
   * by identity (`===`), never touched otherwise. */
  ocInstance: unknown;
  bytes: Uint8Array;
  format: Extract<CadFormat, "step" | "iges" | "brep">;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  baseShape: any;
  baseCleanup: Array<{ delete(): void }>;
  /** The XCAF assembly hierarchy read from the BASE shape's own file bytes
   * (roadmap "XCAF read — assembly structure", closed) — `null` when
   * unavailable (non-STEP source, no genuine assembly structure, or any
   * parse failure). Cached alongside `baseShape` since it comes from an
   * entirely separate, relatively expensive `STEPCAFControl_Reader` parse
   * that doesn't need repeating on every edit — only re-CORRELATING it
   * against the current (possibly edited) solid list is cheap enough to
   * redo every call. See `src/xcafTree.ts`. */
  assemblyTreeCache: XcafAssemblyInfo | null;
  ops: EditOp[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shape: any;
  opsCleanup: Array<{ delete(): void }>;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Frees every OCCT handle a {@link BRepCacheEntry} owns, base-shape handles
 * last (reverse of creation order, same discipline every other cleanup array
 * in this codebase follows). Callers must call this exactly once per entry
 * whenever it's discarded WITHOUT being replaced by a call into
 * `loadBRepCached` that already reused/superseded it — i.e. on document
 * close, or after `loadBRepCached` itself throws (see its doc comment for
 * why a thrown call does NOT already dispose its own stale state). */
export function disposeBRepCache(cache: BRepCacheEntry): void {
  for (let i = cache.opsCleanup.length - 1; i >= 0; i--) {
    try { cache.opsCleanup[i].delete(); } catch { /* ignore */ }
  }
  for (let i = cache.baseCleanup.length - 1; i >= 0; i--) {
    try { cache.baseCleanup[i].delete(); } catch { /* ignore */ }
  }
}

/**
 * Caching counterpart of `loadBRep` below — for the interactive extension's
 * per-edit hot path ONLY (`provider.ts`, one entry per open document). The
 * MCP server stays on plain `loadBRep`, deliberately stateless per call (see
 * CLAUDE.md's MCP section) — introducing cross-call state for a long-lived
 * headless process serving arbitrary/many paths over its lifetime is a
 * different, harder problem this item's own scope (`editsChanged`'s
 * per-keystroke-in-an-open-editor cost) doesn't need to solve.
 *
 * Reuses the parsed base shape across calls whenever the source bytes+format
 * are unchanged from `previous` — this is the dominant win, since parsing a
 * STEP/IGES file into OCCT's internal B-rep representation is real
 * geometric/topological work, independent of how many edit ops exist.
 * Additionally reuses `previous`'s fully-replayed shape as a starting point
 * when `ops` is a pure append of `previous.ops` (by far the common case for
 * interactive editing: apply one op, then another) — the base-shape reuse
 * alone already skips the parse, but this ALSO skips re-replaying every op
 * before the new one(s). Any other relationship between `ops` and
 * `previous.ops` (undo, `remove_edit_op` at a non-last index, redo down a
 * different branch, a parametric-variable change re-resolving every op's
 * numeric fields) falls back to a full replay of `ops` from the (still
 * reused, if the bytes didn't change) base shape — deliberately NOT trying
 * to diff/patch the op list itself, which would need the same unwind/rewind
 * reasoning `entityRebind.ts`'s id-rebinding already had to solve once and
 * is out of scope for a caching layer.
 *
 * On success, returns the tessellated result AND the new cache entry the
 * caller must retain and pass back in as `previous` on the next call. A
 * discarded-and-superseded `previous` (bytes/format changed, or its ops
 * turned out not to be reusable as a base for the new replay) is disposed
 * INTERNALLY before this function returns — the caller only ever needs to
 * dispose the entry it currently holds, never an intermediate one.
 *
 * **Reused fields are shared by reference, not copied** — when base and/or
 * op-replay reuse happens, the returned entry's `baseShape`/`baseCleanup`/
 * `shape`/`opsCleanup` are the EXACT SAME objects/arrays `previous` held
 * (verified live, not just by type: the confirmed-working call sequence
 * `loadBRepCached(...) → loadBRepCached(..., c1) → disposeBRepCache(c1)`
 * crashes OCCT with "Cannot pass deleted object as a pointer" — c1 and its
 * successor alias the SAME handles, so disposing the "old" one frees the
 * "new" one's still-live state too). Never call `disposeBRepCache` on
 * anything except the single, latest entry you are CURRENTLY holding — an
 * intermediate result you've already replaced with a newer call's return
 * value must simply be dropped (reassigned over), never disposed.
 *
 * On failure (including a WASM abort — `wrapOcctFault` still fires and
 * resets the singleton exactly as `loadBRep` does), this function
 * deliberately does NOT attempt to `.delete()` any handle it touched during
 * this call: an abort can leave the WASM heap itself in an undefined state,
 * so calling back into it to free handles is not obviously safe, unlike the
 * "just discarding a stale-but-healthy cache" case above. The caller must
 * drop its reference to whatever cache entry it was holding (never re-pass
 * it as `previous`) on any error from this function — the orphaned OCCT
 * module (already unreachable via `getOcct()` once `resetOcct()` ran) then
 * becomes eligible for normal JS garbage collection once nothing, including
 * this discarded cache entry, still references it.
 */
export async function loadBRepCached(
  extensionPath: string,
  bytes: Uint8Array,
  format: Extract<CadFormat, "step" | "iges" | "brep">,
  ops: EditOp[],
  previous: BRepCacheEntry | undefined,
  quality: TessellationParams = TESSELLATION_PRESETS.standard
): Promise<{ result: BRepResult; cache: BRepCacheEntry }> {
  const oc = await getOcct(extensionPath);

  const baseReusable =
    previous !== undefined &&
    previous.ocInstance === oc &&
    previous.format === format &&
    bytesEqual(previous.bytes, bytes);

  if (previous && !baseReusable) disposeBRepCache(previous);

  let baseShape: unknown;
  let baseCleanup: Array<{ delete(): void }>;
  let assemblyTreeCache: XcafAssemblyInfo | null;
  if (baseReusable && previous) {
    baseShape = previous.baseShape;
    baseCleanup = previous.baseCleanup;
    assemblyTreeCache = previous.assemblyTreeCache;
  } else {
    baseCleanup = [];
    const tmpName = `/in.${format}`;
    oc.FS.writeFile(tmpName, bytes);
    try {
      baseShape = readShape(oc, tmpName, format, baseCleanup);
      // Independent second parse, only for STEP — see xcafTree.ts's doc
      // comment for why this can't reuse `baseShape`/the plain reader's
      // shape. Best-effort: any failure degrades to `null` (flat tree),
      // never blocks the primary read.
      assemblyTreeCache = format === "step" ? readXcafAssembly(oc, tmpName) : null;
    } catch (err) {
      throw wrapOcctFault(err);
    } finally {
      try { oc.FS.unlink(tmpName); } catch { /* ignore */ }
    }
  }

  const appendReusable =
    baseReusable &&
    previous !== undefined &&
    ops.length >= previous.ops.length &&
    previous.ops.every((op, i) => JSON.stringify(op) === JSON.stringify(ops[i]));

  try {
    let opsCleanup: Array<{ delete(): void }>;
    let shape: unknown;
    if (appendReusable && previous) {
      opsCleanup = previous.opsCleanup;
      const suffix = ops.slice(previous.ops.length);
      shape = applyEditsBRep(oc, previous.shape, suffix, opsCleanup);
    } else {
      // Base reused but the replay isn't (or there was no previous entry at
      // all) — free only the now-superseded op-replay handles; the base
      // shape/cleanup (still referenced by `baseShape`/`baseCleanup` above)
      // is untouched either way.
      if (baseReusable && previous) {
        for (let i = previous.opsCleanup.length - 1; i >= 0; i--) {
          try { previous.opsCleanup[i].delete(); } catch { /* ignore */ }
        }
      }
      opsCleanup = [];
      shape = applyEditsBRep(oc, baseShape, ops, opsCleanup);
    }

    const groups = tessellateByGroup(oc, shape, quality);
    const edges = extractEdges(oc, shape);
    const points = extractVertices(oc, shape);
    const tree = buildTree(oc, format, groups, shape, assemblyTreeCache);
    const cache: BRepCacheEntry = { ocInstance: oc, bytes, format, baseShape, baseCleanup, assemblyTreeCache, ops, shape, opsCleanup };
    return { result: { groups, edges, points, tree }, cache };
  } catch (err) {
    throw wrapOcctFault(err);
  }
}

/**
 * Reads `bytes`, parses with the appropriate OCCT reader, applies the replayable
 * edit op-list (if any), tessellates grouped by solid, and returns geometry
 * groups alongside the component tree. With an empty `ops` this is the original
 * read-only path; the source bytes are never modified.
 */
export async function loadBRep(
  extensionPath: string,
  bytes: Uint8Array,
  format: Extract<CadFormat, "step" | "iges" | "brep">,
  ops: EditOp[] = [],
  quality: TessellationParams = TESSELLATION_PRESETS.standard
): Promise<BRepResult> {
  const oc = await getOcct(extensionPath);

  const tmpName = `/in.${format}`;
  oc.FS.writeFile(tmpName, bytes);

  const cleanup: Array<{ delete(): void }> = [];
  try {
    const baseShape = readShape(oc, tmpName, format, cleanup);
    const assemblyTreeCache = format === "step" ? readXcafAssembly(oc, tmpName) : null;
    const shape = applyEditsBRep(oc, baseShape, ops, cleanup);
    const groups = tessellateByGroup(oc, shape, quality);
    const edges = extractEdges(oc, shape);
    const points = extractVertices(oc, shape);
    const tree = buildTree(oc, format, groups, shape, assemblyTreeCache);
    return { groups, edges, points, tree };
  } catch (err) {
    throw wrapOcctFault(err);
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try { cleanup[i].delete(); } catch { /* ignore */ }
    }
    try { oc.FS.unlink(tmpName); } catch { /* ignore */ }
  }
}

/**
 * Builds the Components tree — a genuine nested assembly hierarchy when
 * `assemblyTreeCache` is available AND cleanly correlates against the
 * CURRENT (possibly edited) solid list (roadmap "XCAF read — assembly
 * structure", closed), falling back to the original flat per-solid list
 * otherwise. The flat fallback is deliberately the SAME shape this function
 * always returned before this feature — a document with no XCAF structure,
 * a non-STEP source, or a topology-changing edit the cached XCAF read can't
 * reflect all degrade to it with no visible regression.
 *
 * Known, accepted limitation: a synthetic group-node id (`xcaf-asm-N`, an
 * "Assembly N"/"Component N" header row) doesn't correspond to any real
 * `groupId` in the scene, so clicking it or its eye-toggle is inert (no
 * highlight, no hide) — only LEAF rows, which always carry a real `solid-N`
 * id, behave identically to the flat tree's rows.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildTree(oc: any, format: string, groups: SolidGroup[], shape: unknown, assemblyTreeCache: XcafAssemblyInfo | null): TreeNode {
  if (assemblyTreeCache) {
    try {
      const cleanup: Array<{ delete(): void }> = [];
      const currentSolids = collectSolids(oc, shape, cleanup).map(({ id, solid }) => {
        const props = new oc.GProp_GProps_1();
        cleanup.push(props);
        oc.BRepGProp.VolumeProperties_1(solid, props, false, false, false);
        return { id, centre: bboxCenter(oc, solid, cleanup), volume: props.Mass() };
      });
      const correlated = correlateAssemblyTree(assemblyTreeCache, currentSolids);
      for (let i = cleanup.length - 1; i >= 0; i--) {
        try { cleanup[i].delete(); } catch { /* ignore */ }
      }
      if (correlated?.children) {
        const withFaceCounts = correlated.children.map(attachFaceCounts.bind(null, groups));
        return { id: "root", label: format.toUpperCase(), children: withFaceCounts };
      }
    } catch {
      /* falls through to the flat tree below */
    }
  }
  return {
    id: "root",
    label: format.toUpperCase(),
    children: groups.map((g) => ({
      id: g.id,
      label: g.label,
      faceCount: g.faceCount,
    })),
  };
}

/** Copies a matched leaf's `faceCount` (and its original flat label, e.g.
 * `"Solid 3"` — reused as-is rather than the synthetic "Component N"
 * assembly-tree placeholder, since it's already the ONLY per-solid label
 * this codebase has ever had, and stays more informative than a meaningless
 * renumbering) from the flat `groups` list onto an assembly-tree node,
 * recursing into group (`children`) nodes unchanged. */
function attachFaceCounts(groups: SolidGroup[], node: TreeNode): TreeNode {
  if (node.children) {
    return { ...node, children: node.children.map(attachFaceCounts.bind(null, groups)) };
  }
  const match = groups.find((g) => g.id === node.id);
  return match ? { ...node, label: match.label, faceCount: match.faceCount } : node;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readShape(oc: any, filePath: string, format: string, cleanup: Array<{ delete(): void }>): any {
  const retDone = oc.IFSelect_ReturnStatus.IFSelect_RetDone.value;

  if (format === "step") {
    const reader = new oc.STEPControl_Reader_1();
    cleanup.push(reader);
    const ret = reader.ReadFile(filePath);
    if (ret.value !== retDone) throw new Error(`STEP ReadFile failed (code ${ret.value})`);
    reader.TransferRoots();
    const shape = reader.OneShape();
    cleanup.push(shape);
    // A STEP file this codebase's own XCAF writer produced (see
    // xcafWrite.ts's doc comment) reads as zero shapes through the plain
    // reader — its content is wrapped in AP242 "document management"
    // bookkeeping the plain STEPControl_Reader can't unwrap. Fall back to
    // the document-aware reader ONLY in that case; every ordinary STEP file
    // (including every existing fixture) reports NbShapes() > 0 here and
    // never reaches this branch.
    if (reader.NbShapes() === 0) {
      const fallback = readXcafFallbackShape(oc, filePath, cleanup);
      if (fallback) return fallback;
    }
    return shape;
  }

  if (format === "iges") {
    const reader = new oc.IGESControl_Reader_1();
    cleanup.push(reader);
    const ret = reader.ReadFile(filePath);
    if (ret.value !== retDone) throw new Error(`IGES ReadFile failed (code ${ret.value})`);
    reader.TransferRoots();
    const shape = reader.OneShape();
    cleanup.push(shape);
    return shape;
  }

  if (format === "brep") {
    const builder = new oc.BRep_Builder();
    cleanup.push(builder);
    const shape = new oc.TopoDS_Shape();
    cleanup.push(shape);
    // Not `Message_ProgressRange_1` — that constructor doesn't exist in this OCCT
    // build and throws immediately. `Read_2`'s 4th param is actually a
    // `Handle_Message_ProgressIndicator`.
    const progress = new oc.Handle_Message_ProgressIndicator_1();
    cleanup.push(progress);
    oc.BRepTools.Read_2(shape, filePath, builder, progress);
    return shape;
  }

  throw new Error(`Unknown B-rep format: ${format}`);
}

type BRepFormat = Extract<CadFormat, "step" | "iges" | "brep">;

/**
 * Re-parses `bytes` as `sourceFormat`, applies the edit op-list, and writes the
 * resulting shape out as `targetFormat`, returning the output file's bytes — so
 * Export bakes in the same edits the view shows. Writer calls are verified against
 * the live OCCT build — see `writeShape` below for the per-format quirks.
 *
 * `unit` (default `"mm"`, i.e. no-op) applies a real geometric unit-conversion
 * scale right after edits and before the writer, so the *exported file's*
 * coordinates are in the chosen unit while the live, in-memory model (and
 * every other caller of this function — meshing input, `compare_models`, mass
 * properties, etc.) stays untouched at the cascade unit (mm). Only
 * `provider.ts`'s `handleExport`/`resolveMeshInput` and `mcpTools.ts`'s
 * `exportBRepTool`/`resolveMeshInputHeadless` ever pass a non-default value.
 *
 * Per target format, this is genuinely three different mechanisms, not one
 * scale applied uniformly — see `writeShape`'s doc comment for the two
 * writer-level quirks this dispatches around:
 * - `"brep"`: `scaleShapeForExport` only (BREP has no unit metadata at all).
 * - `"step"`: `scaleShapeForExport`, THEN — when `labelStepUnit` is `true`
 *   (the default) — a text-only header patch (`stepUnitPatch.ts`'s
 *   `patchStepUnitDeclaration`) after writing, since this OCCT WASM build's
 *   STEP writer has no unit-aware API at all (see that module's doc comment
 *   for the full probing trail) — the geometry is already correctly scaled by
 *   the time the writer runs, so every raw number in the file (including the
 *   writer's own auto-computed tolerance) is already correct; only the
 *   *label* needs fixing.
 * - `"iges"`: NEVER `scaleShapeForExport` — `IGESControl_Writer_2`'s
 *   unit-aware overload scales the geometry internally when given a
 *   non-native unit name, so pre-scaling would double-convert.
 *
 * `labelStepUnit` (default `true`) exists SOLELY for `resolveMeshInput`/
 * `resolveMeshInputHeadless`'s meshing-input STEP, which must pass `false`.
 * Verified against the live WASM: Gmsh's own `gmsh.model.occ.importShapes`
 * (unlike this codebase's own OCCT reader, confirmed by comparison) DOES
 * reinterpret a STEP file's declared unit — feeding it a correctly-scaled AND
 * correctly-labeled `"in"` file makes Gmsh silently convert the geometry BACK
 * to its original (larger) real-world size, undoing the scale entirely, while
 * `MeshOptions.sizeMin`/`sizeMax` stay at the (smaller, already-rescaled)
 * requested values — a real, confirmed regression (mesh density mismatch,
 * `mm`-vs-`in`-scale disagreement) this flag exists to prevent. The
 * meshing-input STEP is never shown to the user (discarded immediately after
 * Gmsh reads it), so keeping its header at the OCCT-native `"mm"` label while
 * still scaling its geometry — the exact behavior this codebase already had
 * before STEP-header-patching existed — has zero externally-visible effect.
 *
 * `parts` (default `[]`, i.e. no-op) is used ONLY for a `"step"` target —
 * when at least one part names a solid, the file is written via
 * `xcafWrite.ts`'s XCAF-aware path instead of the plain writer, carrying
 * assembly structure and per-part NAMES (color export is investigated and
 * confirmed non-functional in this OCCT build — see that module's doc
 * comment). Every OTHER caller (meshing input, mass properties, `compare_
 * models`, …) passes no `parts` and gets byte-for-byte the same plain
 * writer output as before this feature existed.
 */
export async function exportBRep(
  extensionPath: string,
  bytes: Uint8Array,
  sourceFormat: BRepFormat,
  targetFormat: BRepFormat,
  ops: EditOp[] = [],
  unit: DisplayUnit = "mm",
  labelStepUnit = true,
  parts: Part[] = []
): Promise<Uint8Array> {
  const oc = await getOcct(extensionPath);

  // Short, single-character-basename paths: this OCCT WASM build's STEP
  // path-handling (STEPControl_Reader/Writer, or lower-level XSTEP/IFSelect
  // infrastructure) has a fixed-size internal C string buffer — total MEMFS
  // path strings of 11+ characters consistently fail to read (`STEP ReadFile
  // failed (code 2)`) and, worse, can *silently* corrupt writes (the writer
  // reports success but the file is unreadable afterward). Verified: 10 chars
  // OK, 11 FAIL, for all of step/iges/brep (each a 4-char extension). Distinct
  // from loadBRep()'s `/in.${format}` since both run on the same shared,
  // long-lived `getOcct()` singleton.
  const inPath = `/e.${sourceFormat}`;
  const outPath = `/o.${targetFormat}`;
  oc.FS.writeFile(inPath, bytes);

  const cleanup: Array<{ delete(): void }> = [];
  try {
    const baseShape = readShape(oc, inPath, sourceFormat, cleanup);
    let shape = applyEditsBRep(oc, baseShape, ops, cleanup);
    const factor = unitScaleFactor(unit);
    if (factor !== 1 && targetFormat !== "iges") shape = scaleShapeForExport(oc, shape, factor, cleanup);
    writeShape(oc, shape, outPath, targetFormat, cleanup, unit, parts);
    const outBytes: Uint8Array = oc.FS.readFile(outPath);
    if (targetFormat === "step" && unit !== "mm" && labelStepUnit) {
      const text = Buffer.from(outBytes).toString("utf8");
      return new TextEncoder().encode(patchStepUnitDeclaration(text, unit));
    }
    return outBytes;
  } catch (err) {
    throw wrapOcctFault(err);
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try { cleanup[i].delete(); } catch { /* ignore */ }
    }
    try { oc.FS.unlink(inPath); } catch { /* ignore */ }
    try { oc.FS.unlink(outPath); } catch { /* ignore */ }
  }
}

/**
 * `unit` only matters for `"iges"` — picks between the plain `_1` writer
 * (native mm) and the unit-aware `_2` overload (`IGESControl_Writer_2(name,
 * modeCreation)`), verified against the live WASM to both correctly declare
 * AND correctly scale the output for all five `DisplayUnit`s (round-tripped
 * through this codebase's own reader, recovering the source model's exact
 * bounding box in every case — see `igesUnitName`'s doc comment in
 * `lengthUnits.ts` for the full trail). The original CLAUDE.md write-up
 * calling this overload's output "unconfirmed" was a false negative caused
 * by feeding it an 11+ character MEMFS path (this build's undocumented
 * path-length limit, documented above in `exportBRep`), not a real limitation
 * of the writer itself.
 *
 * `parts` (STEP only) routes through `xcafWrite.ts`'s `buildXcafDocumentForExport`
 * — a `null` result (no parts, no named solids, or a structural surprise
 * `buildXcafDocumentForExport` isn't confident about) falls through to the
 * exact same plain `STEPControl_Writer_1` path this function always used.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeShape(oc: any, shape: any, filePath: string, format: BRepFormat, cleanup: Array<{ delete(): void }>, unit: DisplayUnit = "mm", parts: Part[] = []): void {
  const retDone = oc.IFSelect_ReturnStatus.IFSelect_RetDone.value;

  if (format === "step") {
    const docHandle = parts.length > 0 ? buildXcafDocumentForExport(oc, shape, parts, cleanup) : null;
    if (docHandle) {
      writeXcafStep(oc, docHandle, filePath, cleanup);
      return;
    }
    const writer = new oc.STEPControl_Writer_1();
    cleanup.push(writer);
    const transferStatus = writer.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true);
    if (transferStatus.value !== retDone) throw new Error(`STEP Transfer failed (code ${transferStatus.value})`);
    const writeStatus = writer.Write(filePath);
    if (writeStatus.value !== retDone) throw new Error(`STEP Write failed (code ${writeStatus.value})`);
    return;
  }

  if (format === "iges") {
    const writer = unit === "mm" ? new oc.IGESControl_Writer_1() : new oc.IGESControl_Writer_2(igesUnitName(unit), 0);
    cleanup.push(writer);
    writer.AddShape(shape);
    writer.ComputeModel();
    const ok = writer.Write_2(filePath, false);
    if (!ok) throw new Error("IGES Write failed");
    return;
  }

  if (format === "brep") {
    const progress = new oc.Handle_Message_ProgressIndicator_1();
    cleanup.push(progress);
    const ok = oc.BRepTools.Write_2(shape, filePath, progress);
    if (!ok) throw new Error("BREP Write failed");
    return;
  }

  throw new Error(`Unknown B-rep export format: ${format}`);
}
