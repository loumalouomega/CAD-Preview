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
import { technicalDrawingSvg, viewBasis, dimensionDrawings, sheetSvg } from "./svgSilhouette";
import { technicalDrawingDxf, sheetDxf } from "./dxfSilhouette";
import {
  assignDimensionsToViews,
  layoutSheet,
  type PaperSize,
  type ProjectionMethod,
  type SheetViewInput,
  type TitleBlockFields,
} from "./drawingSheet";

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

  const { mesh, triangleFace } = await loadDrawingMesh(extensionPath, source, options.quality ?? "fine");
  return render(mesh, triangleFace);
}

/**
 * Reads any drawable source into one welded triangle mesh — the view-
 * independent half of every drawing export, split out so a multi-view sheet
 * parses and replays the model ONCE and projects it N times.
 *
 * The returned arrays are ordinary JS typed arrays (the weld copies out of the
 * tessellation), so they stay valid after the OCCT handles are freed below.
 */
async function loadDrawingMesh(
  extensionPath: string,
  source: CompareSource,
  quality: TessellationQuality
): Promise<{ mesh: WeldedMesh; triangleFace?: Uint32Array }> {
  if (source.kind !== "brep") return { mesh: meshFromSource(source) };

  const oc = await getOcct(extensionPath);
  // Short MEMFS path — this OCCT WASM build silently fails/corrupts at roughly
  // 11+ characters (see `exportBRep`'s own doc comment).
  const tmpName = `/sv.${source.format}`;
  oc.FS.writeFile(tmpName, source.bytes);
  const cleanup: Array<{ delete(): void }> = [];
  try {
    const baseShape = readShape(oc, tmpName, source.format, cleanup);
    const shape = applyEditsBRep(oc, baseShape, source.ops, cleanup);
    return weldedMeshFromTessellation(oc, shape, quality);
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

export interface DrawingSheetView {
  /** Canonical view name — drives slot placement and the view label. */
  name: string;
  direction: Vec3;
  up?: Vec3;
}

export interface DrawingSheetOptions {
  views: DrawingSheetView[];
  quality?: TessellationQuality;
  format?: "svg" | "dxf";
  annotations?: DimensionSource[];
  /** Technical drawing (default) or outline-only views. */
  hiddenLines?: boolean;
  creaseAngleDeg?: number;
  paper?: PaperSize;
  projection?: ProjectionMethod;
  /** Sheet mm per model mm; overrides the standard-scale search. */
  scale?: number;
  title?: string;
  date?: string;
  /** Optional title-block fields (author, drawing number, revision, material). */
  fields?: TitleBlockFields;
}

export interface DrawingSheetResult {
  content: string;
  format: "svg" | "dxf";
  width: number;
  height: number;
  scale: number;
  scaleLabel: string;
  paper: PaperSize;
  projection: ProjectionMethod;
  views: Array<{ name: string; segmentCount: number; hiddenSegmentCount: number; dimensionCount: number }>;
  triangleCount: number;
  warnings: string[];
}

/**
 * Several views of one model on a single drafting sheet (roadmap "Multi-view
 * sheet layout") — see `drawingSheet.ts` for the layout rules.
 *
 * **No unit conversion, deliberately.** A sheet's scale is a ratio of drawn
 * size to REAL size; drawing inch-converted coordinates onto a millimetre
 * sheet would make "1:2" mean nothing. The geometry stays in the cascade unit
 * (mm) and the scale carries the real-world relationship.
 *
 * Each pinned annotation is drawn ONCE, in the view where it reads truest
 * (`assignDimensionsToViews`), rather than repeated foreshortened in every view.
 */
export async function exportDrawingSheet(
  extensionPath: string,
  source: CompareSource,
  options: DrawingSheetOptions
): Promise<DrawingSheetResult> {
  const warnings: string[] = [];
  if (options.views.length === 0) throw new Error("A drawing sheet needs at least one view.");
  const quality = options.quality ?? "fine";
  const { mesh, triangleFace } = await loadDrawingMesh(extensionPath, source, quality);
  const positions = mesh.positions;
  const triangleCount = Math.floor(mesh.indices.length / 3);
  if (triangleCount === 0) warnings.push("The source produced no triangles — the sheet is empty.");

  const annotations = options.annotations ?? [];
  const assignment = assignDimensionsToViews(annotations, options.views);
  const glyphScale = annotations.length > 0 ? diagonalOf(positions) : 0;
  const hiddenLines = options.hiddenLines ?? true;

  const inputs: SheetViewInput[] = [];
  const seen = new Set<string>();
  options.views.forEach((view, i) => {
    const basis = viewBasis(view.direction, view.up);
    let visible: SheetViewInput["visible"];
    let hidden: SheetViewInput["hidden"] = [];
    if (hiddenLines) {
      const drawing = hiddenLineDrawing({ positions, indices: mesh.indices, triangleFace }, basis, {
        creaseAngleDeg: options.creaseAngleDeg,
        tangentAngleDeg: tangentAngleForQuality(quality),
      });
      for (const w of drawing.warnings) {
        if (!seen.has(w)) warnings.push(w); // the same crease warning for every view is noise
        seen.add(w);
      }
      visible = drawing.visible;
      hidden = drawing.hidden;
    } else {
      visible = [];
      const p = (v: number): [number, number] => {
        const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
        return [
          x * basis.right[0] + y * basis.right[1] + z * basis.right[2],
          -(x * basis.up[0] + y * basis.up[1] + z * basis.up[2]),
        ];
      };
      for (const [a, b] of silhouetteEdges(positions, mesh.indices, view.direction)) {
        const pa = p(a), pb = p(b);
        if ([...pa, ...pb].every(Number.isFinite)) visible.push([pa, pb]);
      }
    }
    const subset = assignment[i].map((ai) => annotations[ai]);
    inputs.push({
      name: view.name,
      direction: view.direction,
      visible,
      hidden,
      ...(subset.length > 0 ? { dimensions: dimensionDrawings(subset, view, glyphScale) } : {}),
    });
  });

  const layout = layoutSheet(inputs, {
    paper: options.paper,
    projection: options.projection,
    scale: options.scale,
    title: options.title,
    unit: "mm",
    date: options.date,
    fields: options.fields,
  });
  warnings.push(...layout.warnings);

  const format = options.format === "dxf" ? "dxf" : "svg";
  const content = format === "dxf" ? sheetDxf(layout, { title: options.title }).dxf : sheetSvg(layout, { title: options.title });
  return {
    content,
    format,
    width: layout.width,
    height: layout.height,
    scale: layout.scale,
    scaleLabel: layout.scaleLabel,
    paper: layout.paper,
    projection: layout.projection,
    views: layout.views.map((v) => ({
      name: v.name,
      segmentCount: v.visible.length,
      hiddenSegmentCount: v.hidden.length,
      dimensionCount: v.dimensions?.drawings.length ?? 0,
    })),
    triangleCount,
    warnings,
  };
}
