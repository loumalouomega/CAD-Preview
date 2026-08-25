/**
 * OCCT-touching half of SVG silhouette export (roadmap item, closed) — turns
 * any supported source into a 2D outline drawing, via the pure
 * `silhouetteEdges.ts` + `svgSilhouette.ts` pair.
 *
 * **`HLRAppli_ReflectLines` was probed against the live WASM and deliberately
 * NOT used** — the roadmap listed it as the one surviving door to a kernel-
 * computed outline (every `HLRBRep_*` class is red in this build), and it does
 * genuinely work: the unsuffixed constructor takes a `TopoDS_Shape`, and
 * `SetAxes`/`Perform`/`GetResult` are all bound and functional (249 ms on
 * `examples/STP/bull.stp`, returning a non-null compound that this codebase's
 * own `enumerateEdges` reads as 25 edges). It was rejected because the
 * RESULTING DRAWING IS WORSE, which is only visible by looking at it: rendered
 * side by side against the tessellation silhouette for the same view,
 * `GetResult()` produced the outer boundary and a few fragments while missing
 * the part's circular holes and interior cutout entirely, where the
 * tessellation path drew all of them. `GetResult()` returns reflect lines
 * only; the sharp feature edges live behind `GetCompoundOf3dEdges(type, …)`,
 * whose `type` argument is an `HLRBRep_TypeOfResultingEdge` from the entirely-
 * red `HLRBRep_*` family — calling it throws. So the one filter that would
 * make the kernel path competitive is unreachable, exactly the "green in the
 * manifest is necessary but not sufficient" pattern this codebase has hit
 * before. The tessellation path below also works for STL/OBJ/PLY/glTF, which
 * ReflectLines never could, and needs no WASM at all for those.
 */

import { getOcct, readShape, wrapOcctFault } from "./occtService";
import { applyEditsBRep } from "./occtOperations";
import { tessellateByGroup } from "./meshExtract";
import { tessellationParamsFor, type TessellationQuality } from "./tessellationQuality";
import { weldTriangleSoup, type WeldedMesh } from "./meshComponents";
import { parseStl } from "./stlParser";
import { parseObj } from "./objParser";
import { parsePly } from "./plyParser";
import { parseGltf } from "./gltfParser";
import { silhouetteEdges } from "./silhouetteEdges";
import { silhouetteSvg, scalePositions, type Vec3 } from "./svgSilhouette";
import { silhouetteDxf, polylinesDxf } from "./dxfSilhouette";
import { unitScaleFactor, type DisplayUnit } from "./lengthUnits";
import type { CompareSource } from "./modelDiffHost";

export interface SvgSilhouetteOptions {
  /** View direction, model → camera (the `ViewState.viewDirection` convention). */
  direction: Vec3;
  up?: Vec3;
  /** Real coordinate conversion applied before projection, exactly like every
   * other export in this codebase. Defaults to native mm. */
  unit?: DisplayUnit;
  strokeWidth?: number;
  title?: string;
  /**
   * B-rep sources only. Defaults to `"fine"` rather than `"standard"`: the
   * silhouette's smoothness IS the tessellation's resolution here, with no
   * shading or normals to hide faceting the way a rendered view does.
   */
  quality?: TessellationQuality;
  /** Output format — SVG (default) or DXF. DXF chains segments into
   * LWPOLYLINE (with bulges for arcs) plus LINE singletons. */
  format?: "svg" | "dxf";
}

export interface SvgSilhouetteResult {
  svg: string;
  /** DXF text when format === "dxf" (alias `svg` holds "" in that case). */
  dxf?: string;
  segmentCount: number;
  /** Triangles the silhouette was derived from — a useful sanity signal for a
   * caller deciding whether an empty drawing means "nothing to draw" or
   * "nothing parsed". */
  triangleCount: number;
  warnings: string[];
  /** DXF-specific chain/singleton counts when format === "dxf". */
  chainCount?: number;
  lineCount?: number;
}

/** Flattens every tessellated face into one unindexed triangle soup, then
 * welds it.
 *
 * The weld is REQUIRED, not an optimization: `tessellateByGroup` returns one
 * independent index space per face, so without it every face boundary in the
 * model looks like an open-boundary edge and the "silhouette" degenerates into
 * a full wireframe of every face in the model. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function weldedMeshFromTessellation(oc: any, shape: any, quality: TessellationQuality): WeldedMesh {
  const groups = tessellateByGroup(oc, shape, tessellationParamsFor(quality));
  const soup: number[] = [];
  for (const group of groups) {
    for (const face of group.faces) {
      const { positions, indices } = face.buffers;
      for (let i = 0; i < indices.length; i++) {
        const v = indices[i] * 3;
        soup.push(positions[v], positions[v + 1], positions[v + 2]);
      }
    }
  }
  return weldTriangleSoup(new Float32Array(soup));
}

function meshFromSource(source: CompareSource): WeldedMesh {
  switch (source.kind) {
    case "stl":
      return weldTriangleSoup(parseStl(source.bytes));
    case "obj":
      return parseObj(source.bytes);
    case "ply":
      return parsePly(source.bytes);
    case "gltf":
      return parseGltf(source.bytes, source.externalBuffers);
    default:
      throw new Error(`Unsupported source kind for SVG silhouette export: ${(source as { kind: string }).kind}`);
  }
}

/**
 * Renders one view of a model as an SVG outline.
 *
 * Reuses `CompareSource` (from `modelDiffHost.ts`) rather than declaring a
 * near-identical union: it already means exactly "a model to read geometry
 * from", and its `brep` variant carries `ops`, which this needs so the drawing
 * reflects the EDITED model rather than the file on disk. It also keeps both
 * features' format support in lockstep automatically.
 *
 * A mesh source never touches OCCT at all — the "opening a pure-mesh file must
 * never load the WASM" invariant holds here too.
 */
export async function exportSvgSilhouette(
  extensionPath: string,
  source: CompareSource,
  options: SvgSilhouetteOptions
): Promise<SvgSilhouetteResult> {
  const warnings: string[] = [];
  const factor = unitScaleFactor(options.unit ?? "mm");

  const render = (mesh: WeldedMesh): SvgSilhouetteResult => {
    const positions = scalePositions(mesh.positions, factor);
    const edges = silhouetteEdges(positions, mesh.indices, options.direction);
    const triangleCount = Math.floor(mesh.indices.length / 3);
    if (options.format === "dxf") {
      const { dxf, segmentCount, chainCount, lineCount } = silhouetteDxf(positions, edges, { direction: options.direction, up: options.up }, {
        title: options.title,
      });
      if (triangleCount === 0) warnings.push("The source produced no triangles — the drawing is empty.");
      else if (segmentCount === 0) warnings.push("No silhouette edges were found for this view direction — the drawing is empty.");
      return { svg: dxf, dxf, segmentCount, triangleCount, warnings, chainCount, lineCount };
    }
    const { svg, segmentCount } = silhouetteSvg(positions, edges, { direction: options.direction, up: options.up }, {
      strokeWidth: options.strokeWidth,
      title: options.title,
    });
    if (triangleCount === 0) warnings.push("The source produced no triangles — the drawing is empty.");
    else if (segmentCount === 0) warnings.push("No silhouette edges were found for this view direction — the drawing is empty.");
    return { svg, segmentCount, triangleCount, warnings };
  };

  if (source.kind !== "brep") return render(meshFromSource(source));

  const oc = await getOcct(extensionPath);
  // Short MEMFS path — this OCCT WASM build silently fails/corrupts at roughly
  // 11+ characters (see `exportBRep`'s own doc comment).
  const tmpName = `/sv.${source.format}`;
  oc.FS.writeFile(tmpName, source.bytes);
  const cleanup: Array<{ delete(): void }> = [];
  try {
    const baseShape = readShape(oc, tmpName, source.format, cleanup);
    const shape = applyEditsBRep(oc, baseShape, source.ops, cleanup);
    return render(weldedMeshFromTessellation(oc, shape, options.quality ?? "fine"));
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
      oc.FS.unlink(tmpName);
    } catch {
      /* ignore */
    }
  }
}
