/**
 * "Mesh → B-rep promotion, diagnostic-first" — Phase 1 of the roadmap item
 * of the same name: a READ-ONLY heal-quality report for an STL/OBJ/PLY
 * triangle mesh, answering "could this be closed into a valid B-rep solid,
 * and at what cost" — WITHOUT actually promoting anything. `src/
 * exportTargets.ts` states "no path from a triangle mesh back to a B-rep" as
 * policy, not a kernel limitation; this module is deliberately the first
 * half only. Phase 2 (an actual `EditOpKind` that promotes a healed shell to
 * a real solid, unlocking `BREP_ONLY_OPS` for mesh sources) is explicitly
 * NOT built here — the roadmap item is explicit that shipping promotion
 * before a trustworthy diagnostic would risk feeding `get_mass_properties`/
 * `measure_exact` a confidently-wrong number from a shell that only closed
 * because a tolerance ladder reached its loosest, least-trustworthy rung.
 *
 * Every field in `ComponentHealthReport` is a FACT, never a computed
 * pass/fail verdict — matching `checkInterference`'s `hasOverlap: boolean`-
 * as-fact convention and the MCP layer's own `verdictConventions` ("Tools
 * report facts... you render the verdict, not the tool"). A component that
 * never closes reports `requiredTolerance/healedArea/healedVolume/
 * areaDeltaPct/volumeDeltaPct` as `null` — never a fabricated number for
 * geometry that isn't actually closed.
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
 *     `BRepBuilderAPI_MakeSolid_3` → `BRepGProp.VolumeProperties_1` gives an
 *     exact volume match against a real STL fixture (verified against
 *     `examples/STL/cube.stl`, 1000 for a 10×10×10 cube, floating-point
 *     exact).
 */

import { getOcct, wrapOcctFault } from "./occtService";
import { parseStl } from "./stlParser";
import { parseObj } from "./objParser";
import { parsePly } from "./plyParser";
import { weldTriangleSoup, connectedComponents, areaOfTriangles, volumeOfTriangles, type WeldedMesh } from "./meshComponents";
import { analyzeMeshTopology } from "./meshTopology";

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
}

export interface MeshHealthReport {
  componentCount: number;
  components: ComponentHealthReport[];
}

function parseToWeldedMesh(bytes: Uint8Array, format: "stl" | "obj" | "ply"): WeldedMesh {
  if (format === "stl") return weldTriangleSoup(parseStl(bytes));
  if (format === "obj") return parseObj(bytes);
  return parsePly(bytes);
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
 * Pulls the (first) `TopAbs_SHELL` out of a sewed shape, builds a solid from
 * it, and computes its area/volume via `BRepGProp` — the same 4/5-arg call
 * shapes `massProperties.ts`/`entityFacts.ts` already use elsewhere in this
 * codebase. Returns `null` if no shell is found (shouldn't happen once
 * `NbFreeEdges() === 0`, but degrades gracefully rather than throwing).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function solidPropertiesFromSewedShape(oc: any, sewedShape: unknown, cleanup: Array<{ delete(): void }>): { area: number; volume: number } | null {
  const shellExp = new oc.TopExp_Explorer_2(sewedShape, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  cleanup.push(shellExp);
  if (!shellExp.More()) return null;
  const shell = oc.TopoDS.Shell_1(shellExp.Current());
  cleanup.push(shell);

  const solid = new oc.BRepBuilderAPI_MakeSolid_3(shell).Solid();
  cleanup.push(solid);

  const volumeProps = new oc.GProp_GProps_1();
  cleanup.push(volumeProps);
  oc.BRepGProp.VolumeProperties_1(solid, volumeProps, false, false, false);
  const volume = volumeProps.Mass();

  const areaProps = new oc.GProp_GProps_1();
  cleanup.push(areaProps);
  oc.BRepGProp.SurfaceProperties_1(solid, areaProps, false, false);
  const area = areaProps.Mass();

  return { area, volume };
}

/**
 * Computes the read-only heal-quality report for a raw STL/OBJ/PLY mesh —
 * per connected component (mirroring `stlSolidSignatures.ts`'s existing
 * per-component convention, since a hypothetical future promotion would
 * naturally build one solid per component too): pure edge/degenerate-face
 * topology stats (`analyzeMeshTopology`, no WASM needed) plus the OCCT
 * sewing-tolerance-ladder closure check and, if closed, the healed
 * area/volume delta against the raw mesh's own (pure-JS) area/volume.
 */
export async function checkMeshHealth(extensionPath: string, bytes: Uint8Array, format: "stl" | "obj" | "ply"): Promise<MeshHealthReport> {
  const oc = await getOcct(extensionPath);
  const { positions, indices } = parseToWeldedMesh(bytes, format);
  const componentTriangles = connectedComponents(indices);

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
