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
import { silhouetteSvg, scalePositions, type Vec3, type DimensionSource } from "./svgSilhouette";
import { silhouetteDxf, polylinesDxf } from "./dxfSilhouette";
import { unitScaleFactor, type DisplayUnit } from "./lengthUnits";
import type { CompareSource } from "./modelDiffHost";
import { hiddenLineDrawing } from "./hiddenLineRemoval";
import { technicalDrawingSvg, viewBasis } from "./svgSilhouette";
import { technicalDrawingDxf } from "./dxfSilhouette";

/**
 * Tangent-continuity threshold for a given tessellation quality.
 *
 * A cross-face edge whose measured dihedral is below the tessellation's own
 * angular deflection carries no real information — the angle IS the faceting.
 * 1.5x the deflection keeps clear of it: 12.9 degrees at "fine" (0.15 rad),
 * 43 at "standard" (0.5), 51.6 at "draft" (0.6).
 */
function tangentAngleForQuality(quality: TessellationQuality): number {
  const rad = tessellationParamsFor(quality).angularDeflectionRad;
  return (rad * 1.5 * 180) / Math.PI;
}

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
  /**
   * Pinned annotations to bake into the drawing as dimension glyphs
   * (roadmap "Dimension-style rendering", Phase 2) — extension lines,
   * arrowheads, and the frozen value label, projected through this export's
   * own view basis. Optional; absent = a plain outline exactly as before.
   */
  annotations?: DimensionSource[];
  /**
   * Produce a technical DRAWING rather than an outline: feature edges split
   * into visible and occluded runs, the latter drawn dashed (SVG) or on a
   * `HIDDEN` layer (DXF).
   */
  hiddenLines?: boolean;
  /** Crease angle for a mesh source with no face ids; see `hiddenLineRemoval.ts`. */
  creaseAngleDeg?: number;
}

export interface SvgSilhouetteResult {
  svg: string;
  /** DXF text when format === "dxf" (alias `svg` holds "" in that case). */
  dxf?: string;
  segmentCount: number;
  /** Occluded segments, when `hiddenLines` was requested. */
  hiddenSegmentCount?: number;
  /** Feature edges considered before the visible/hidden split. */
  featureEdgeCount?: number;
  /** Triangles the silhouette was derived from — a useful sanity signal for a
   * caller deciding whether an empty drawing means "nothing to draw" or
   * "nothing parsed". */
  triangleCount: number;
  warnings: string[];
  /** DXF-specific chain/singleton counts when format === "dxf". */
  chainCount?: number;
  lineCount?: number;
  /** Annotations whose dimension glyphs were rendered (absent when none were supplied). */
  dimensionCount?: number;
}

/** Flattens every tessellated face into one unindexed triangle soup, then
 * welds it.
 *
 * The weld is REQUIRED, not an optimization: `tessellateByGroup` returns one
 * independent index space per face, so without it every face boundary in the
 * model looks like an open-boundary edge and the "silhouette" degenerates into
 * a full wireframe of every face in the model. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function weldedMeshFromTessellation(
  oc: any,
  shape: any,
  quality: TessellationQuality
): { mesh: WeldedMesh; triangleFace: Uint32Array } {
  const groups = tessellateByGroup(oc, shape, tessellationParamsFor(quality));
  const soup: number[] = [];
  // Which OCCT face each triangle came from. Welding maps VERTICES but
  // preserves triangle order, so this parallel array stays aligned — and it is
  // what lets hidden-line removal decide creases by face identity instead of a
  // dihedral threshold, which cannot distinguish a real edge from a tessellation
  // facet on a curved surface.
  const triangleFace: number[] = [];
  let faceOrdinal = 0;
  for (const group of groups) {
    for (const face of group.faces) {
      const { positions, indices } = face.buffers;
      for (let i = 0; i < indices.length; i++) {
        const v = indices[i] * 3;
        soup.push(positions[v], positions[v + 1], positions[v + 2]);
        if (i % 3 === 0) triangleFace.push(faceOrdinal);
      }
      faceOrdinal++;
    }
  }
  return { mesh: weldTriangleSoup(new Float32Array(soup)), triangleFace: new Uint32Array(triangleFace) };
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

/** Bbox diagonal of a flat position soup — the glyph-sizing reference. */
function diagonalOf(positions: Float32Array): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return 0;
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
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

  const render = (mesh: WeldedMesh, triangleFace?: Uint32Array): SvgSilhouetteResult => {
    const positions = scalePositions(mesh.positions, factor);
    const triangleCount = Math.floor(mesh.indices.length / 3);
    const dimensionScaleHintHL = options.annotations?.length ? diagonalOf(positions) : undefined;

    if (options.hiddenLines) {
      const view = { direction: options.direction, up: options.up };
      const basis = viewBasis(options.direction, options.up);
      const drawing = hiddenLineDrawing({ positions, indices: mesh.indices, triangleFace }, basis, {
        creaseAngleDeg: options.creaseAngleDeg,
        // A cross-face edge below the tessellation's own angular deflection is
        // tessellation noise, not a real angle — so the tangent threshold has to
        // track the quality the caller chose rather than being a constant.
        tangentAngleDeg: tangentAngleForQuality(options.quality ?? "fine"),
      });
      warnings.push(...drawing.warnings);
      const shared = {
        title: options.title,
        annotations: options.annotations,
        dimensionScaleHint: dimensionScaleHintHL,
      };
      if (options.format === "dxf") {
        const r = technicalDrawingDxf(drawing.visible, drawing.hidden, view, shared);
        if (triangleCount === 0) warnings.push("The source produced no triangles — the drawing is empty.");
        return {
          svg: r.dxf, dxf: r.dxf, segmentCount: r.segmentCount, hiddenSegmentCount: r.hiddenSegmentCount,
          featureEdgeCount: drawing.featureEdgeCount, triangleCount, warnings,
          chainCount: r.chainCount, lineCount: r.lineCount,
          ...(r.dimensionCount !== undefined ? { dimensionCount: r.dimensionCount } : {}),
        };
      }
      const r = technicalDrawingSvg(drawing.visible, drawing.hidden, view, { ...shared, strokeWidth: options.strokeWidth });
      if (triangleCount === 0) warnings.push("The source produced no triangles — the drawing is empty.");
      else if (drawing.featureEdgeCount === 0) warnings.push("No feature edges were found for this view direction — the drawing is empty.");
      return {
        svg: r.svg, segmentCount: r.segmentCount, hiddenSegmentCount: r.hiddenSegmentCount ?? 0,
        featureEdgeCount: drawing.featureEdgeCount, triangleCount, warnings,
        ...(r.dimensionCount !== undefined ? { dimensionCount: r.dimensionCount } : {}),
      };
    }

    const edges = silhouetteEdges(positions, mesh.indices, options.direction);
    // Glyph sizing reference: the model bbox diagonal in OUTPUT units (the
    // same converted space the projection runs in).
    const dimensionScaleHint = options.annotations?.length ? diagonalOf(positions) : undefined;
    if (options.format === "dxf") {
      const { dxf, segmentCount, chainCount, lineCount, dimensionCount } = silhouetteDxf(
        positions,
        edges,
        { direction: options.direction, up: options.up },
        {
          title: options.title,
          annotations: options.annotations,
          dimensionScaleHint,
        }
      );
      if (triangleCount === 0) warnings.push("The source produced no triangles — the drawing is empty.");
      else if (segmentCount === 0 && !dimensionCount) warnings.push("No silhouette edges were found for this view direction — the drawing is empty.");
      return { svg: dxf, dxf, segmentCount, triangleCount, warnings, chainCount, lineCount, ...(dimensionCount !== undefined ? { dimensionCount } : {}) };
    }
    const { svg, segmentCount, dimensionCount } = silhouetteSvg(positions, edges, { direction: options.direction, up: options.up }, {
      strokeWidth: options.strokeWidth,
      title: options.title,
      annotations: options.annotations,
      dimensionScaleHint,
    });
    if (triangleCount === 0) warnings.push("The source produced no triangles — the drawing is empty.");
    else if (segmentCount === 0 && !dimensionCount) warnings.push("No silhouette edges were found for this view direction — the drawing is empty.");
    return { svg, segmentCount, triangleCount, warnings, ...(dimensionCount !== undefined ? { dimensionCount } : {}) };
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
    const { mesh, triangleFace } = weldedMeshFromTessellation(oc, shape, options.quality ?? "fine");
    return render(mesh, triangleFace);
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
