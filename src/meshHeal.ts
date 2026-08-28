/**
 * "Mesh → B-rep promotion" — both phases of the roadmap item of the same
 * name now live in this module. Phase 1 (`checkMeshHealth`) is a READ-ONLY
 * heal-quality report for an STL/OBJ/PLY triangle mesh, answering "could
 * this be closed into a valid B-rep solid, and at what cost" — without
 * promoting anything. Phase 2 (`promoteMeshToBrep`) actually does it, but
 * DELIBERATELY as a one-shot EXPORT (write a brand-new `.step`/`.iges`/
 * `.brep` file) rather than reclassifying the currently-open mesh document
 * in place — see the "Mesh → B-rep promotion" section of CLAUDE.md for the
 * full reasoning: in-place reclassification would need two genuinely new
 * patterns this codebase has never needed before (a sidecar that persists
 * actual geometry, and a runtime override of `fileRouter.ts`'s otherwise
 * pure/static per-extension routing decision), while the export model
 * reuses `occtService.ts`'s existing B-rep writer pipeline wholesale and
 * needs neither. The promoted file is an ORDINARY B-rep document from the
 * moment it exists — `src/exportTargets.ts`'s "no path from a triangle mesh
 * back to a B-rep" policy line is now stale for the export-a-new-file sense,
 * though the ORIGINAL mesh document itself still can't use fillet/chamfer/
 * `measure_exact`/etc. directly, by design (a promoted copy, not a mutation).
 *
 * Every field in `ComponentHealthReport` is a FACT, never a computed
 * pass/fail verdict — matching `checkInterference`'s `hasOverlap: boolean`-
 * as-fact convention and the MCP layer's own `verdictConventions` ("Tools
 * report facts... you render the verdict, not the tool"). A component that
 * never closes reports `requiredTolerance/healedArea/healedVolume/
 * areaDeltaPct/volumeDeltaPct` as `null` — never a fabricated number for
 * geometry that isn't actually closed. `promoteMeshToBrep` mirrors this:
 * a component that never closes is SKIPPED (reported in `skippedComponents`/
 * `warnings`), never silently dropped or forced into an invalid solid; if
 * NO component closes, the function throws rather than writing an empty or
 * meaningless file.
 *
 * Live-WASM findings this module relies on (probed this session, see
 * CLAUDE.md for the full write-up):
 *   - Of `ShapeFix_Shape/Solid/Shell/Wireframe`, only `ShapeFix_Solid` is
 *     usable in this build — NOT used here, since the shell-closure check
 *     itself (via `BRepBuilderAPI_Sewing.NbFreeEdges()`) is what this report
 *     needs, not a repair pass.
 *   - `BRepBuilderAPI_Sewing.SetTolerance(t)` + re-`Perform()` on the SAME
 *     instance correctly re-evaluates `NbFreeEdges()` for a SINGLE retune
 *     (tight → loose, one transition) — but a separate integration test
 *     against a mesh that never closes, exercising all 5 ladder rungs in a
 *     row on one reused instance, crashed the WASM module outright. This
 *     module therefore builds a FRESH `Sewing` instance per rung (see
 *     `sewComponent`'s own doc comment) rather than relying on the untested
 *     "many repeated `Perform()` calls on one instance" behavior.
 *   - Triangle-soup → one tiny planar `BRepBuilderAPI_MakeFace` per triangle
 *     → `Sewing` → `NbFreeEdges()===0` → pull the `TopAbs_SHELL` →
 *     `BRepBuilderAPI_MakeSolid_3` → `volumePropertiesAdaptive` (`BRepGProp`'s adaptive overload, see `src/brepGProp.ts`) gives an
 *     exact volume match against a real STL fixture (verified against
 *     `examples/STL/cube.stl`, 1000 for a 10×10×10 cube, floating-point
 *     exact).
 */

import { getOcct, wrapOcctFault, writeShape } from "./occtService";
import { scaleShapeForExport, combineSolids } from "./occtOperations";
import { volumePropertiesAdaptive, surfacePropertiesAdaptive } from "./brepGProp";
import { parseStl } from "./stlParser";
import { parseObj } from "./objParser";
import { parsePly } from "./plyParser";
import { parseGltf, type GltfExternalBuffers } from "./gltfParser";
import type { MeshParseFormat } from "./fileRouter";
import { weldTriangleSoup, connectedComponents, areaOfTriangles, volumeOfTriangles, type WeldedMesh } from "./meshComponents";
import { analyzeMeshTopology } from "./meshTopology";
import { analyzeMeshioSurfaces } from "./meshioService";
import type { QualitySummary } from "./meshQuality";
import { patchStepUnitDeclaration } from "./stepUnitPatch";
import { unitScaleFactor, type DisplayUnit } from "./lengthUnits";
import type { BRepFormat } from "./massProperties";

/** Tolerance-ladder rungs tried in order, loosest reported as
 * `requiredTolerance` — the SAME ladder rung count/spacing this session's
 * live-WASM probe used, chosen to span "already essentially closed" (1e-6)
 * through "a real, non-trivial gap" (1e-2) without an unbounded search. */
const SEWING_TOLERANCE_LADDER = [1e-6, 1e-5, 1e-4, 1e-3, 1e-2];

export interface ComponentHealthReport {
  index: number;
  triangleCount: number;
  freeEdgeCount: number;
  nonManifoldEdgeCount: number;
  degenerateFaceCount: number;
  rawArea: number;
  rawVolume: number;
  /** The loosest-first tolerance-ladder rung at which OCCT sewing closed
   * this component (`NbFreeEdges() === 0`) — `null` if it never closed, even
   * at the ladder's loosest rung. */
  requiredTolerance: number | null;
  /** OCCT-computed area of the sewn+solidified shape — `null` unless it closed. */
  healedArea: number | null;
  /** OCCT-computed volume of the sewn+solidified shape — `null` unless it closed. */
  healedVolume: number | null;
  /** `(healedArea - rawArea) / rawArea * 100` — `null` unless it closed. */
  areaDeltaPct: number | null;
  /** `(healedVolume - rawVolume) / rawVolume * 100` — `null` unless it closed. */
  volumeDeltaPct: number | null;
  /**
   * Adjacent triangles wound in opposite directions, from meshio++'s
   * `surfaceWatertightCheck` — `null` if meshio++ could not analyze this
   * component.
   *
   * This is the one health signal `meshTopology.ts` structurally CANNOT
   * produce: it keys edges through `edgeKey(a, b)`, which sorts the pair, so
   * orientation is discarded before counting and an oppositely-wound
   * neighbour still registers as a clean manifold edge. A component can score
   * 0 free edges and 0 non-manifold edges here and still be inconsistently
   * wound.
   */
  inconsistentPairCount: number | null;
  /** Cells whose orientation is flipped relative to the rest (meshio++ `stats`). */
  invertedCellCount: number | null;
  /** Triangle-shape quality (meshio++ `attachQuality`) as normalized minimum
   * angle — 1.0 equilateral, →0 a sliver — folded through the same
   * `summarizeQuality` the FE-mesh panel renders. Scaled-Jacobian is NOT used:
   * it is NaN for every triangle cell (see `MeshioSurfaceAnalysis.quality`). */
  quality: QualitySummary | null;
}

export interface MeshHealthReport {
  componentCount: number;
  components: ComponentHealthReport[];
}

/**
 * Ceiling on the triangle count this module will attempt to sew.
 *
 * Both entry points build ONE tiny `BRepBuilderAPI_MakeFace` per triangle and
 * hand the lot to `BRepBuilderAPI_Sewing`, so cost scales directly with
 * triangle count — and every OCCT face is an Emscripten heap handle. The
 * hand-authored STL/OBJ/PLY meshes this pipeline was built against are tiny
 * (this repo's own fixtures are 12 triangles), but glTF is a *rendering*
 * interchange format whose real-world files routinely carry 100k–1M
 * triangles; handing one of those to the sewing pipeline would spend minutes
 * allocating faces before exhausting the WASM heap. Reporting an honest,
 * actionable "too large" up front beats an opaque out-of-memory abort — and
 * the same protection applies to a large STL, where the risk was always
 * present but far less likely to be hit.
 */
export const MAX_HEALABLE_TRIANGLES = 50_000;

/**
 * Parses any of the four dirty-mesh formats into a welded `{positions,
 * indices}` triangle soup, entirely host-side, no WASM. Exported (was
 * module-private) for `ftetwildService.ts`'s tetrahedralization path — it
 * needs exactly this shape as fTetWild's `tetrahedralize()` input, and this
 * is the one place all four formats already funnel into it uniformly.
 */
export function parseToWeldedMesh(bytes: Uint8Array, format: MeshParseFormat, external?: GltfExternalBuffers): WeldedMesh {
  if (format === "stl") return weldTriangleSoup(parseStl(bytes));
  if (format === "obj") return parseObj(bytes);
  if (format === "gltf") return parseGltf(bytes, external); // already welded internally
  return parsePly(bytes);
}

/** Throws the shared, actionable over-budget error both entry points use. */
function assertHealableSize(indices: Uint32Array): void {
  const triangleCount = Math.floor(indices.length / 3);
  if (triangleCount > MAX_HEALABLE_TRIANGLES) {
    throw new Error(
      `Mesh has ${triangleCount} triangles, above the ${MAX_HEALABLE_TRIANGLES}-triangle ceiling for the per-triangle sewing pipeline (it builds one OCCT face per triangle). Decimate the mesh before healing or promoting it.`
    );
  }
}

/** Builds one tiny planar `TopoDS_Face` from a single triangle's 3 corner
 * points — the exact `gp_Pnt_3` → 3×`BRepBuilderAPI_MakeEdge_3` →
 * `BRepBuilderAPI_MakeWire_1`+`.Add_1()` → `BRepBuilderAPI_MakeFace_15`
 * sequence this session's live-WASM probe verified end-to-end. Every
 * intermediate handle is pushed onto `cleanup` except the returned face
 * itself (the caller owns and cleans that up).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildFaceFromTriangle(oc: any, positions: Float32Array, indices: Uint32Array, triangleIndex: number, cleanup: Array<{ delete(): void }>): unknown {
  const corners = [indices[triangleIndex * 3], indices[triangleIndex * 3 + 1], indices[triangleIndex * 3 + 2]];
  const pnts = corners.map((vi) => {
    const p = new oc.gp_Pnt_3(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]);
    cleanup.push(p);
    return p;
  });
  const wireMaker = new oc.BRepBuilderAPI_MakeWire_1();
  cleanup.push(wireMaker);
  for (let i = 0; i < 3; i++) {
    const edge = new oc.BRepBuilderAPI_MakeEdge_3(pnts[i], pnts[(i + 1) % 3]).Edge();
    cleanup.push(edge);
    wireMaker.Add_1(edge);
  }
  const wire = wireMaker.Wire();
  cleanup.push(wire);
  const face = new oc.BRepBuilderAPI_MakeFace_15(wire, true).Face();
  return face;
}

/**
 * Runs the sewing-tolerance ladder for one component's triangles, stopping
 * at the first rung that closes (`NbFreeEdges() === 0`). Returns the closed
 * shape (a `TopAbs_SHELL`-bearing sewn result) and the rung that achieved
 * it, or `null` for both if no rung closed it. Reuses ONE
 * `BRepBuilderAPI_Sewing` instance PER RUNG, not one instance reused across
 * every rung. This session's live-WASM probe verified `SetTolerance` +
 * re-`Perform()` correctly picks up a SINGLE retune on one instance (tight →
 * loose, one transition) — but a separate integration test against a mesh
 * that never closes (a hole punched in `cube.stl`, exercising all 5 rungs in
 * a row on one instance) crashed the WASM module outright. Rebuilding a
 * fresh `Sewing` instance per rung avoids relying on that untested "N
 * repeated `Perform()` calls on one instance" behavior — cheap (5 small
 * instances instead of 1) and, empirically, does not crash on the same
 * never-closes fixture that reliably crashed the single-instance version.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sewComponent(oc: any, faces: unknown[], cleanup: Array<{ delete(): void }>): { shape: unknown; tolerance: number } | null {
  for (const tolerance of SEWING_TOLERANCE_LADDER) {
    const sewer = new oc.BRepBuilderAPI_Sewing(tolerance, true, true, true, false);
    cleanup.push(sewer);
    for (const f of faces) sewer.Add(f);
    sewer.Perform(new oc.Handle_Message_ProgressIndicator_1());
    if (sewer.NbFreeEdges() === 0) {
      const sewedShape = sewer.SewedShape();
      cleanup.push(sewedShape);
      return { shape: sewedShape, tolerance };
    }
  }
  return null;
}

/**
 * Pulls the (first) `TopAbs_SHELL` out of a sewed shape and builds a solid
 * from it — shared by `solidPropertiesFromSewedShape` (Phase 1's report,
 * which only needs the resulting area/volume) and `promoteMeshToBrep`
 * (Phase 2, which needs the solid itself to survive and be written to a
 * file). Returns `null` if no shell is found (shouldn't happen once
 * `NbFreeEdges() === 0`, but degrades gracefully rather than throwing).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildSolidFromSewedShape(oc: any, sewedShape: unknown, cleanup: Array<{ delete(): void }>): unknown | null {
  const shellExp = new oc.TopExp_Explorer_2(sewedShape, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  cleanup.push(shellExp);
  if (!shellExp.More()) return null;
  const shell = oc.TopoDS.Shell_1(shellExp.Current());
  cleanup.push(shell);

  const solid = new oc.BRepBuilderAPI_MakeSolid_3(shell).Solid();
  cleanup.push(solid);
  return solid;
}

/**
 * Computes a sewn+solidified shape's area/volume via `BRepGProp` — the same
 * 4/5-arg call shapes `massProperties.ts`/`entityFacts.ts` already use
 * elsewhere in this codebase. Returns `null` if `buildSolidFromSewedShape`
 * found no shell.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function solidPropertiesFromSewedShape(oc: any, sewedShape: unknown, cleanup: Array<{ delete(): void }>): { area: number; volume: number } | null {
  const solid = buildSolidFromSewedShape(oc, sewedShape, cleanup);
  if (!solid) return null;

  const volumeProps = new oc.GProp_GProps_1();
  cleanup.push(volumeProps);
  volumePropertiesAdaptive(oc, solid, volumeProps);
  const volume = volumeProps.Mass();

  const areaProps = new oc.GProp_GProps_1();
  cleanup.push(areaProps);
  surfacePropertiesAdaptive(oc, solid, areaProps);
  const area = areaProps.Mass();

  return { area, volume };
}

/**
 * Computes the read-only heal-quality report for a raw STL/OBJ/PLY/glTF mesh
 * — per connected component (mirroring `stlSolidSignatures.ts`'s existing
 * per-component convention, since a hypothetical future promotion would
 * naturally build one solid per component too): pure edge/degenerate-face
 * topology stats (`analyzeMeshTopology`, no WASM needed) plus the OCCT
 * sewing-tolerance-ladder closure check and, if closed, the healed
 * area/volume delta against the raw mesh's own (pure-JS) area/volume.
 *
 * Throws for a mesh above `MAX_HEALABLE_TRIANGLES` — see that constant.
 */
export async function checkMeshHealth(
  extensionPath: string,
  bytes: Uint8Array,
  format: MeshParseFormat,
  external?: GltfExternalBuffers
): Promise<MeshHealthReport> {
  const oc = await getOcct(extensionPath);
  const { positions, indices } = parseToWeldedMesh(bytes, format, external);
  assertHealableSize(indices);
  const componentTriangles = connectedComponents(indices);
  // Supplementary meshio++ diagnostics, one per component. Never throws — a
  // component meshio++ cannot analyze yields `null` and the OCCT-derived
  // fields below are unaffected. Computed up front because the map is
  // synchronous (it holds live OCCT handles) and this is async.
  const meshioAnalyses = await analyzeMeshioSurfaces(positions, indices, componentTriangles);

  const cleanup: Array<{ delete(): void }> = [];
  try {
    const components: ComponentHealthReport[] = componentTriangles.map((triangles, index) => {
      const topology = analyzeMeshTopology(positions, indices, triangles);
      const rawArea = areaOfTriangles(positions, indices, triangles);
      const rawVolume = volumeOfTriangles(positions, indices, triangles);

      const faces = triangles.map((t) => buildFaceFromTriangle(oc, positions, indices, t, cleanup));
      for (const f of faces) cleanup.push(f as { delete(): void });

      const sewn = sewComponent(oc, faces, cleanup);
      const solidProps = sewn ? solidPropertiesFromSewedShape(oc, sewn.shape, cleanup) : null;

      return {
        index,
        triangleCount: triangles.length,
        freeEdgeCount: topology.freeEdgeCount,
        nonManifoldEdgeCount: topology.nonManifoldEdgeCount,
        degenerateFaceCount: topology.degenerateFaceCount,
        rawArea,
        rawVolume,
        requiredTolerance: sewn?.tolerance ?? null,
        healedArea: solidProps?.area ?? null,
        healedVolume: solidProps?.volume ?? null,
        areaDeltaPct: solidProps && rawArea > 0 ? ((solidProps.area - rawArea) / rawArea) * 100 : null,
        volumeDeltaPct: solidProps && rawVolume > 0 ? ((solidProps.volume - rawVolume) / rawVolume) * 100 : null,
        inconsistentPairCount: meshioAnalyses[index]?.inconsistentPairCount ?? null,
        invertedCellCount: meshioAnalyses[index]?.invertedCellCount ?? null,
        quality: meshioAnalyses[index]?.quality ?? null,
      };
    });

    return { componentCount: components.length, components };
  } catch (err) {
    throw wrapOcctFault(err);
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

export interface PromoteMeshResult {
  bytes: Uint8Array;
  /** Connected-component indices that closed and were carried into the
   * output file. */
  promotedComponents: number[];
  /** Connected-component indices that never closed, even at the loosest
   * sewing-tolerance-ladder rung, and were therefore left out of the output
   * file entirely — never silently dropped without explanation. */
  skippedComponents: number[];
  warnings: string[];
}

/**
 * Phase 2: promotes a healed STL/OBJ/PLY/glTF mesh into a NEW B-rep file
 * (STEP/IGES/BREP bytes) — see this module's own top doc comment for why
 * this is a one-shot EXPORT rather than an in-place reclassification of the
 * source document. Reuses `checkMeshHealth`'s exact per-component
 * parse/weld/sew pipeline, but keeps the resulting solids (instead of just
 * reporting facts about them) and writes them out via `occtService.ts`'s
 * `writeShape` — the SAME writer paths (`STEPControl_Writer_1`/
 * `IGESControl_Writer_1|2`/`BRepTools.Write_2`, unit scaling via
 * `scaleShapeForExport`, STEP-unit relabeling via
 * `patchStepUnitDeclaration`) `exportBRep` already uses for a B-rep source,
 * so the output is byte-for-byte as trustworthy as any other export this
 * codebase produces.
 *
 * A component that never closes is skipped (`skippedComponents`/
 * `warnings`), never silently dropped or forced into an invalid solid. If
 * NO component closes, throws rather than writing an empty/meaningless
 * file — run `check_mesh_health` first to see why. `parts` is deliberately
 * never threaded through to `writeShape` here (unlike `exportBRep`) — a
 * mesh source's `node-N` Part assignments have no meaningful mapping onto
 * the newly-promoted `solid-N` ids, so no Part-name carryover is attempted.
 *
 * Throws for a mesh above `MAX_HEALABLE_TRIANGLES` — see that constant.
 */
export async function promoteMeshToBrep(
  extensionPath: string,
  bytes: Uint8Array,
  sourceFormat: MeshParseFormat,
  targetFormat: BRepFormat,
  unit: DisplayUnit = "mm",
  external?: GltfExternalBuffers
): Promise<PromoteMeshResult> {
  const oc = await getOcct(extensionPath);
  const { positions, indices } = parseToWeldedMesh(bytes, sourceFormat, external);
  assertHealableSize(indices);
  const componentTriangles = connectedComponents(indices);
  // Short path — this OCCT WASM build has an undocumented MEMFS path-length
  // cliff (roughly 11+ characters starts failing, per this codebase's own
  // prior findings for STEP/IGES export elsewhere); a live-WASM integration
  // test caught this the hard way: `/promoted.${targetFormat}` (14 chars for
  // "step") wrote successfully (writeShape's own STEP writer completed with
  // no error) but the immediately-following `oc.FS.readFile(outPath)`
  // consistently failed with an opaque low-level FS error. Mirrors
  // `exportBRep`'s own short `/o.${format}` convention.
  const outPath = `/p.${targetFormat}`;

  const cleanup: Array<{ delete(): void }> = [];
  try {
    const promotedSolids: unknown[] = [];
    const promotedComponents: number[] = [];
    const skippedComponents: number[] = [];
    const warnings: string[] = [];

    componentTriangles.forEach((triangles, index) => {
      const faces = triangles.map((t) => buildFaceFromTriangle(oc, positions, indices, t, cleanup));
      for (const f of faces) cleanup.push(f as { delete(): void });

      const sewn = sewComponent(oc, faces, cleanup);
      const solid = sewn ? buildSolidFromSewedShape(oc, sewn.shape, cleanup) : null;
      if (!solid) {
        skippedComponents.push(index);
        warnings.push(
          `Component ${index} (${triangles.length} triangles) did not close into a valid solid even at the loosest sewing tolerance (${SEWING_TOLERANCE_LADDER[SEWING_TOLERANCE_LADDER.length - 1]}) and was skipped — run check_mesh_health first to see why.`
        );
        return;
      }
      promotedSolids.push(solid);
      promotedComponents.push(index);
    });

    if (promotedSolids.length === 0) {
      throw new Error("No component of this mesh could be closed into a valid solid — run check_mesh_health first to see why.");
    }

    let shape = combineSolids(oc, promotedSolids, cleanup);
    const factor = unitScaleFactor(unit);
    if (factor !== 1 && targetFormat !== "iges") shape = scaleShapeForExport(oc, shape, factor, cleanup);

    writeShape(oc, shape, outPath, targetFormat, cleanup, unit, []);
    let outBytes: Uint8Array = oc.FS.readFile(outPath);
    if (targetFormat === "step" && unit !== "mm") {
      const text = Buffer.from(outBytes).toString("utf8");
      outBytes = new TextEncoder().encode(patchStepUnitDeclaration(text, unit));
    }

    return { bytes: outBytes, promotedComponents, skippedComponents, warnings };
  } catch (err) {
    throw wrapOcctFault(err);
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try {
        cleanup[i].delete();
      } catch {
        /* ignore */
      }
    }
    try {
      oc.FS.unlink(outPath);
    } catch {
      /* ignore */
    }
  }
}
