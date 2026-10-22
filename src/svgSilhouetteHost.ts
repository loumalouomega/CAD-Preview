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
import { applyEditsBRep, collectFaces, faceSurfaceInfo } from "./occtOperations";
import { extractHoles, groupHoleCallouts, type CylinderFace } from "./holeCallouts";
import { enumerateEdges } from "./edgeEnumeration";
import { tessellateByGroup } from "./meshExtract";
import { tessellationParamsFor, type TessellationQuality } from "./tessellationQuality";
import { weldTriangleSoup, type WeldedMesh } from "./meshComponents";
import { parseStl } from "./stlParser";
import { parseObj } from "./objParser";
import { parsePly } from "./plyParser";
import { parseGltf } from "./gltfParser";
import { silhouetteEdges } from "./silhouetteEdges";
import { silhouetteSvg, layeredSilhouetteSvg, scalePositions, type Vec3, type DimensionSource } from "./svgSilhouette";
import { silhouetteDxf, polylinesDxf, layeredDxf } from "./dxfSilhouette";
import type { LayerDrawSubset } from "./layersSidecar";
import { unitScaleFactor, type DisplayUnit } from "./lengthUnits";
import type { CompareSource } from "./modelDiffHost";
import { hiddenLineDrawing } from "./hiddenLineRemoval";
import { technicalDrawingSvg, viewBasis, dimensionDrawings, drawingBounds, sheetSvg } from "./svgSilhouette";
import { technicalDrawingDxf, sheetDxf } from "./dxfSilhouette";
import { resolveNamedView } from "./viewDirections";
import {
  assignDimensionsToViews,
  layoutSheet,
  isOrthographic,
  type HoleMarksInput,
  type PaperSize,
  type ProjectionMethod,
  type SheetViewInput,
  type SectionCutInput,
  type TitleBlockFields,
} from "./drawingSheet";
import {
  buildCutLoops,
  clipTrianglesToPlane,
  cuttingPlaneMark,
  type SectionPlane,
  type SectionSpec,
} from "./drawingSection";

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
  /**
   * Restrict the drawing to these layers' members (roadmap "Layers, distinct
   * from Parts", second increment): one output group per subset. Absent = the
   * whole model, exactly as before. B-rep sources only — a mesh source has no
   * host-side entity correlation for its members, so the caller refuses the
   * combination before this is ever reached.
   */
  layerFilter?: LayerDrawSubset[];
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
): { mesh: WeldedMesh; triangleFace: Uint32Array; triangleFaceId: string[]; triangleGroupId: string[] } {
  const groups = tessellateByGroup(oc, shape, tessellationParamsFor(quality));
  const soup: number[] = [];
  // Which OCCT face each triangle came from. Welding maps VERTICES but
  // preserves triangle order, so this parallel array stays aligned — and it is
  // what lets hidden-line removal decide creases by face identity instead of a
  // dihedral threshold, which cannot distinguish a real edge from a tessellation
  // facet on a curved surface.
  const triangleFace: number[] = [];
  // The same, as stable `face-N` / `solid-N` entity ids (the groups
  // `tessellateByGroup` returns already carry them — see `FaceMesh.faceId`
  // and the per-solid group ids). Lets a drawing export restrict itself to a
  // layer's members (roadmap "Layers, distinct from Parts") without
  // re-deriving any numbering.
  const triangleFaceId: string[] = [];
  const triangleGroupId: string[] = [];
  let faceOrdinal = 0;
  for (const group of groups) {
    for (const face of group.faces) {
      const { positions, indices } = face.buffers;
      for (let i = 0; i < indices.length; i++) {
        const v = indices[i] * 3;
        soup.push(positions[v], positions[v + 1], positions[v + 2]);
        if (i % 3 === 0) triangleFace.push(faceOrdinal);
      }
      const tris = Math.floor(indices.length / 3);
      for (let t = 0; t < tris; t++) {
        triangleFaceId.push(face.faceId);
        triangleGroupId.push(group.id);
      }
      faceOrdinal++;
    }
  }
  return { mesh: weldTriangleSoup(new Float32Array(soup)), triangleFace: new Uint32Array(triangleFace), triangleFaceId, triangleGroupId };
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

  const render = (
    mesh: WeldedMesh,
    triangleFace?: Uint32Array,
    triangleFaceId?: string[],
    triangleGroupId?: string[],
    edgeLines?: Array<{ id: string; positions: Float32Array }>
  ): SvgSilhouetteResult => {
    const positions = scalePositions(mesh.positions, factor);
    const triangleCount = Math.floor(mesh.indices.length / 3);
    /**
     * Layer-restricted drawing (roadmap "Layers, distinct from Parts", second
     * increment): one extraction per included layer over that layer's
     * triangle subset, plus its member edges' own projected polylines — then
     * one grouped document. B-rep only: a mesh source has no host-side
     * entity correlation, so the caller refuses that combination first and
     * this throws as a backstop rather than drawing something unfiltered.
     */
    const renderFiltered = (
      indices: Uint32Array,
      faceIds: string[],
      groupIds: string[],
      lines: Array<{ id: string; positions: Float32Array }>
    ): SvgSilhouetteResult => {
      const subsets = options.layerFilter ?? [];
      if (source.kind !== "brep") {
        throw new Error("Layer filtering in drawing exports is B-rep only in this version — mesh sources draw unfiltered.");
      }
      const knownFaces = new Set(faceIds);
      const knownGroups = new Set(groupIds);
      const edgeById = new Map(lines.map((e) => [e.id, e.positions]));
      const basis = viewBasis(options.direction, options.up);
      const projectPt = (x: number, y: number, z: number): [number, number] | null => {
        const px = x * basis.right[0] + y * basis.right[1] + z * basis.right[2];
        const py = -(x * basis.up[0] + y * basis.up[1] + z * basis.up[2]);
        return Number.isFinite(px) && Number.isFinite(py) ? [px, py] : null;
      };
      const seenWarnings = new Set<string>();
      const groups: LayerDrawingGroup[] = subsets.map((sub) => {
        const faces = new Set(sub.faces);
        const volumes = new Set(sub.volumes);
        const kept: number[] = [];
        const keptFace: number[] = [];
        for (let t = 0; t * 3 + 2 < indices.length; t++) {
          if (faces.has(faceIds[t]) || volumes.has(groupIds[t])) {
            kept.push(indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]);
            keptFace.push(triangleFace?.[t] ?? 0);
          }
        }
        const subIndices = new Uint32Array(kept);
        const subFace = new Uint32Array(keptFace);
        // Members that resolve to nothing are reported, never silently
        // dropped into an empty group without explanation.
        for (const id of [...sub.faces, ...sub.volumes]) {
          if (!knownFaces.has(id) && !knownGroups.has(id)) {
            const w = `Layer "${sub.name}" names ${id}, which resolves to no face or solid in this model — skipped.`;
            if (!seenWarnings.has(w)) {
              seenWarnings.add(w);
              warnings.push(w);
            }
          }
        }
        let visible: Array<[[number, number], [number, number]]> = [];
        let hidden: Array<[[number, number], [number, number]]> = [];
        if (options.hiddenLines) {
          const drawing = hiddenLineDrawing({ positions, indices: subIndices, triangleFace: subFace }, basis, {
            creaseAngleDeg: options.creaseAngleDeg,
            tangentAngleDeg: tangentAngleForQuality(options.quality ?? "fine"),
          });
          for (const w of drawing.warnings) {
            if (!seenWarnings.has(w)) {
              seenWarnings.add(w);
              warnings.push(w);
            }
          }
          visible = drawing.visible;
          hidden = drawing.hidden;
        } else if (subIndices.length > 0) {
          for (const [a, b] of silhouetteEdges(positions, subIndices, options.direction)) {
            const pa = projectPt(positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]);
            const pb = projectPt(positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]);
            if (pa && pb) visible.push([pa, pb]);
          }
        }
        // Member edges draw as their own projected polylines — triangle
        // adjacency only yields face boundaries, never a lone edge.
        for (const id of sub.edges) {
          const poly = edgeById.get(id);
          if (!poly) {
            const w = `Layer "${sub.name}" names ${id}, which resolves to no edge in this model — skipped.`;
            if (!seenWarnings.has(w)) {
              seenWarnings.add(w);
              warnings.push(w);
            }
            continue;
          }
          const scaled = scalePositions(poly, factor);
          let prev: [number, number] | null = null;
          for (let i = 0; i + 2 < scaled.length; i += 3) {
            const p = projectPt(scaled[i], scaled[i + 1], scaled[i + 2]);
            if (!p) {
              prev = null;
              continue;
            }
            if (prev) visible.push([prev, p]);
            prev = p;
          }
        }
        if (visible.length === 0 && hidden.length === 0) {
          warnings.push(`Layer "${sub.name}" produced no drawable geometry — drawn as an empty group.`);
        }
        return { id: sub.id, name: sub.name, color: sub.color, visible, hidden };
      });
      const view = { direction: options.direction, up: options.up };
      const dimensionScaleHint = options.annotations?.length ? diagonalOf(positions) : undefined;
      const shared = {
        title: options.title,
        annotations: options.annotations,
        dimensionScaleHint,
      };
      if (options.format === "dxf") {
        const r = layeredDxf(
          groups.map((g) => ({ name: g.name, color: g.color, segments: g.visible, hiddenSegments: g.hidden })),
          view,
          shared
        );
        return {
          svg: r.dxf, dxf: r.dxf,
          segmentCount: r.segmentCount, hiddenSegmentCount: groups.reduce((n, g) => n + g.hidden.length, 0),
          triangleCount, warnings,
          chainCount: r.chainCount, lineCount: r.lineCount,
          ...(r.dimensionCount !== undefined ? { dimensionCount: r.dimensionCount } : {}),
        };
      }
      const r = layeredSilhouetteSvg(
        groups.map((g) => ({ id: g.id, segments: g.visible, hiddenSegments: options.hiddenLines ? g.hidden : undefined })),
        view,
        { ...shared, strokeWidth: options.strokeWidth }
      );
      return {
        svg: r.svg, segmentCount: r.segmentCount, hiddenSegmentCount: groups.reduce((n, g) => n + g.hidden.length, 0),
        triangleCount, warnings,
        ...(r.dimensionCount !== undefined ? { dimensionCount: r.dimensionCount } : {}),
      };
    };
    if (options.layerFilter && options.layerFilter.length > 0) {
      return renderFiltered(mesh.indices, triangleFaceId ?? [], triangleGroupId ?? [], edgeLines ?? []);
    }
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

  const { mesh, triangleFace, triangleFaceId, triangleGroupId, edgeLines } = await loadDrawingMesh(extensionPath, source, options.quality ?? "fine");
  return render(mesh, triangleFace, triangleFaceId, triangleGroupId, edgeLines);
}

/** One included layer's drawing runs, in the export's own 2D frame. */
export interface LayerDrawingGroup {
  id: string;
  name: string;
  color: string;
  visible: Array<[[number, number], [number, number]]>;
  hidden: Array<[[number, number], [number, number]]>;
}

/**
 * Reads any drawable source into one welded triangle mesh — the view-
 * independent half of every drawing export, split out so a multi-view sheet
 * parses and replays the model ONCE and projects it N times.
 *
 * The returned arrays are ordinary JS typed arrays (the weld copies out of the
 * tessellation), so they stay valid after the OCCT handles are freed below.
 *
 * For a B-rep source this also returns the per-triangle owning `face-N` /
 * group ids (the groups `tessellateByGroup` returns already carry them) and
 * the discretized edge polylines in `edge-N` order (see `enumerateEdges`) —
 * which is what lets a drawing export restrict itself to a layer's members
 * (roadmap "Layers, distinct from Parts") without re-deriving any numbering.
 */
async function loadDrawingMesh(
  extensionPath: string,
  source: CompareSource,
  quality: TessellationQuality,
  wantCylinders = false
): Promise<{
  mesh: WeldedMesh;
  triangleFace?: Uint32Array;
  triangleFaceId?: string[];
  triangleGroupId?: string[];
  edgeLines?: Array<{ id: string; positions: Float32Array }>;
  /** Analytic cylinder facts per `face-N` (only when `wantCylinders`). */
  cylinders?: CylinderFace[];
}> {
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
    const tessellated = weldedMeshFromTessellation(oc, shape, quality);
    // Edge discretization in `edge-N` order — `enumerateEdges` is the same
    // shared enumerator the viewer and every op-resolution path use, so index
    // `i` IS `edge-i`.
    const edgeLines = enumerateEdges(oc, shape, cleanup).map((e, i) => ({ id: `edge-${i}`, positions: e.positions }));
    let cylinders: CylinderFace[] | undefined;
    if (wantCylinders) {
      // `collectFaces` order IS the `face-N` numbering `tessellateByGroup`
      // stamped on every triangle, so index `i` is `face-i`.
      cylinders = [];
      const faces = collectFaces(oc, shape, cleanup);
      for (let i = 0; i < faces.length; i++) {
        const info = faceSurfaceInfo(oc, faces[i], cleanup);
        if (info.params?.kind === "cylinder") {
          cylinders.push({
            faceId: `face-${i}`,
            radius: info.params.radius,
            axisLocation: info.params.axisLocation,
            axisDirection: info.params.axisDirection,
          });
        }
      }
    }
    return { ...tessellated, edgeLines, ...(cylinders ? { cylinders } : {}) };
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
  /** Cut this view in place instead of adding a separate section view. */
  sectionPlane?: SectionPlane;
}

export interface DrawingSheetOptions {
  views: DrawingSheetView[];
  /** Named section views, each cut from the same tessellation as its parent. */
  sections?: SectionSpec[];
  quality?: TessellationQuality;
  format?: "svg" | "dxf";
  annotations?: DimensionSource[];
  /** Technical drawing (default) or outline-only views. */
  hiddenLines?: boolean;
  creaseAngleDeg?: number;
  /**
   * Centre marks and one leader callout per hole group in each orthographic
   * view looking down the hole axis (`holeCallouts.ts`). B-rep sources only;
   * a mesh source draws without marks and says so in `warnings`. Off by
   * default so existing sheets stay byte-identical.
   */
  holeCallouts?: boolean;
  /**
   * Restrict every view to these layers' members (roadmap "Layers, distinct
   * from Parts", second increment): one group per layer inside each view.
   * Absent = the whole model, exactly as before. B-rep sources only.
   */
  layerFilter?: LayerDrawSubset[];
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
  views: Array<{
    name: string;
    segmentCount: number;
    hiddenSegmentCount: number;
    dimensionCount: number;
    sectionLoopCount?: number;
    /** Holes marked in this view (only when `holeCallouts` was on). */
    holeMarkCount?: number;
  }>;
  /** Every section in the sheet, its parent view and its cut-loop count. */
  sections: Array<{ id: string; label: string; parentView: string; loopCount: number; hatchLineCount: number }>;
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
  const wantHoles = options.holeCallouts === true;
  const { mesh, triangleFace, triangleFaceId, triangleGroupId, edgeLines, cylinders } = await loadDrawingMesh(
    extensionPath,
    source,
    quality,
    wantHoles && source.kind === "brep"
  );
  if (wantHoles && source.kind !== "brep") {
    warnings.push("Hole callouts need a B-rep source — this mesh source is drawn without hole marks.");
  }
  const holeGroups =
    wantHoles && cylinders && triangleFaceId
      ? groupHoleCallouts(extractHoles(mesh.positions, mesh.indices, triangleFaceId, cylinders))
      : [];
  /** Centre marks + callouts for one orthographic view looking along a hole axis. */
  const holeMarksFor = (
    basis: ReturnType<typeof viewBasis>,
    direction: Vec3,
    visible: Array<[[number, number], [number, number]]>
  ): HoleMarksInput | undefined => {
    if (holeGroups.length === 0 || !isOrthographic(direction)) return undefined;
    const fwd = basis.forward;
    const groups = holeGroups.filter((g) => Math.abs(g.axis[0] * fwd[0] + g.axis[1] * fwd[1] + g.axis[2] * fwd[2]) > 0.9999);
    if (groups.length === 0) return undefined;
    let minY = Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const [a, b] of visible) {
      for (const p of [a, b]) {
        if (p[1] < minY) minY = p[1];
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
      }
    }
    if (!Number.isFinite(minY)) return undefined;
    const crosses: Array<[[number, number], [number, number]]> = [];
    const callouts: HoleMarksInput["callouts"] = [];
    let holeCount = 0;
    const pad = 0.08 * Math.max(maxX - minX, 1);
    groups.forEach((g, gi) => {
      for (const h of g.holes) {
        const c = project3(h.centre, basis);
        const arm = Math.max(1.5 * h.radius, 1e-3);
        crosses.push([[c[0] - arm, c[1]], [c[0] + arm, c[1]]]);
        crosses.push([[c[0], c[1] - arm], [c[0], c[1] + arm]]);
        holeCount++;
      }
      const c0 = project3(g.holes[0].centre, basis);
      const at: [number, number] = [c0[0], minY - pad * (gi + 1)];
      callouts.push({ text: g.text, at, leader: [c0, at] });
    });
    return { crosses, callouts, holeCount };
  };
  const positions = mesh.positions;
  const triangleCount = Math.floor(mesh.indices.length / 3);
  if (triangleCount === 0) warnings.push("The source produced no triangles — the sheet is empty.");
  const layerFilter = options.layerFilter ?? [];
  if (layerFilter.length > 0 && source.kind !== "brep") {
    throw new Error("Layer filtering in drawing exports is B-rep only in this version — mesh sources draw unfiltered.");
  }

  const annotations = options.annotations ?? [];
  const assignment = assignDimensionsToViews(annotations, options.views);
  const modelDiag = diagonalOf(positions);
  const glyphScale = annotations.length > 0 ? modelDiag : 0;
  const hiddenLines = options.hiddenLines ?? true;

  // Named sections and in-place view cuts are validated by
  // `resolveSheetSettings` on the tool path; the kernel entry validates
  // defensively so a direct pipeline call gets the same contract.
  const rawSections = options.sections ?? [];
  const inPlacePlanes = options.views.map((v) => v.sectionPlane);
  const hasSections = rawSections.length > 0 || inPlacePlanes.some((p) => p !== undefined);
  if (hasSections && layerFilter.length > 0) {
    throw new Error("Sections and layer filters cannot be combined in this version — omit layers to draw a section, or omit sections to draw filtered layers.");
  }
  const matchParentIndex = (name: string): number => {
    const named = resolveNamedView(name);
    if (named) {
      const exact = options.views.findIndex((v) => v.name.toLowerCase() === named.canonical.toLowerCase());
      if (exact >= 0) return exact;
    }
    return options.views.findIndex((v) => v.name.toLowerCase() === name.toLowerCase());
  };
  interface BuiltSection {
    spec: SectionSpec;
    parentIndex: number;
  }
  const builtSections: BuiltSection[] = [];
  const sectionIds = new Set<string>();
  const project3 = (p: readonly [number, number, number], basis: ReturnType<typeof viewBasis>): [number, number] => [
    p[0] * basis.right[0] + p[1] * basis.right[1] + p[2] * basis.right[2],
    -(p[0] * basis.up[0] + p[1] * basis.up[1] + p[2] * basis.up[2]),
  ];
  rawSections.forEach((spec, i) => {
    const where = `sections[${i}]`;
    const id = typeof spec.id === "string" ? spec.id.trim() : "";
    if (!id) {
      warnings.push(`${where} needs a non-empty id — skipped.`);
      return;
    }
    if (sectionIds.has(id)) {
      warnings.push(`Section "${id}" is repeated — drawn once.`);
      return;
    }
    const parentIndex = typeof spec.view === "string" ? matchParentIndex(spec.view) : -1;
    if (parentIndex < 0) {
      warnings.push(`Section "${id}" names view "${typeof spec.view === "string" ? spec.view : ""}" — valid: ${options.views.map((v) => v.name).join(", ")}. Skipped.`);
      return;
    }
    const origin = spec.origin, normal = spec.normal;
    if (!Array.isArray(origin) || origin.length !== 3 || !origin.every(Number.isFinite) || !Array.isArray(normal) || normal.length !== 3 || !normal.every(Number.isFinite)) {
      warnings.push(`Section "${id}" needs a 3-number origin and normal — skipped.`);
      return;
    }
    if (normal.every((v) => v === 0)) {
      warnings.push(`Section "${id}" needs a non-zero normal — skipped.`);
      return;
    }
    sectionIds.add(id);
    builtSections.push({ spec: { ...spec, id, label: spec.label?.trim() || id }, parentIndex });
  });
  const clipOrThrow = (
    plane: { origin: Vec3; normal: Vec3; flip?: boolean },
    name: string
  ): {
    clipped: ReturnType<typeof clipTrianglesToPlane>;
    loops: Array<{ points: Vec3[]; closed: boolean }>;
    open: Array<{ points: Vec3[]; closed: boolean }>;
  } => {
    const clipped = clipTrianglesToPlane(positions, mesh.indices, triangleFace, plane);
    if (!clipped.crossed || clipped.cutSegments.length === 0) {
      throw new Error(`Section "${name}" misses the model — no triangle crosses its plane, so it was refused rather than drawn empty.`);
    }
    const chains = buildCutLoops(clipped.cutSegments, Math.max(1e-9, modelDiag * 1e-7));
    const loops = chains.filter((c) => c.closed && c.points.length >= 3);
    const open = chains.filter((c) => !c.closed && c.points.length >= 2);
    if (loops.length === 0 && open.length === 0) {
      throw new Error(`Section "${name}" produces no cut loop — it was refused rather than drawn empty.`);
    }
    return { clipped, loops, open };
  };

  const inputs: SheetViewInput[] = [];
  const seen = new Set<string>();
  const edgeById = new Map((edgeLines ?? []).map((e) => [e.id, e.positions]));
  /** Visible/hidden 2D runs of one triangle subset (plus owned edge polylines)
   * in one view — shared by the flat path and each filtered layer below. */
  const runsFor = (
    indices: Uint32Array,
    face: Uint32Array | undefined,
    basis: ReturnType<typeof viewBasis>,
    direction: Vec3,
    extraEdges: string[],
    verts: Float32Array = positions
  ): { visible: Array<[[number, number], [number, number]]>; hidden: Array<[[number, number], [number, number]]> } => {
    let visible: Array<[[number, number], [number, number]]> = [];
    let hidden: Array<[[number, number], [number, number]]> = [];
    if (hiddenLines) {
      const drawing = hiddenLineDrawing({ positions: verts, indices, triangleFace: face }, basis, {
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
      const p = (v: number): [number, number] => {
        const x = verts[v * 3], y = verts[v * 3 + 1], z = verts[v * 3 + 2];
        return [
          x * basis.right[0] + y * basis.right[1] + z * basis.right[2],
          -(x * basis.up[0] + y * basis.up[1] + z * basis.up[2]),
        ];
      };
      for (const [a, b] of silhouetteEdges(verts, indices, direction)) {
        const pa = p(a), pb = p(b);
        if ([...pa, ...pb].every(Number.isFinite)) visible.push([pa, pb]);
      }
    }
    // Member edges draw as their own projected polylines (same rule as the
    // single-view filtered path above).
    for (const id of extraEdges) {
      const poly = edgeById.get(id);
      if (!poly) continue;
      let prev: [number, number] | null = null;
      for (let i = 0; i + 2 < poly.length; i += 3) {
        const q: [number, number] = [
          poly[i] * basis.right[0] + poly[i + 1] * basis.right[1] + poly[i + 2] * basis.right[2],
          -(poly[i] * basis.up[0] + poly[i + 1] * basis.up[1] + poly[i + 2] * basis.up[2]),
        ];
        if (!Number.isFinite(q[0]) || !Number.isFinite(q[1])) {
          prev = null;
          continue;
        }
        if (prev) visible.push([prev, q]);
        prev = q;
      }
    }
    return { visible, hidden };
  };
  /** Triangle subset (indices + face ordinals) for one layer's members. */
  const subsetFor = (sub: LayerDrawSubset): { indices: Uint32Array; face: Uint32Array } => {
    const faces = new Set(sub.faces);
    const volumes = new Set(sub.volumes);
    const kept: number[] = [];
    const keptFace: number[] = [];
    const ids = triangleFaceId ?? [];
    const groups = triangleGroupId ?? [];
    for (let t = 0; t * 3 + 2 < mesh.indices.length; t++) {
      if (faces.has(ids[t]) || volumes.has(groups[t])) {
        kept.push(mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]);
        keptFace.push(triangleFace?.[t] ?? 0);
      }
    }
    return { indices: new Uint32Array(kept), face: new Uint32Array(keptFace) };
  };
  const validPlane = (
    plane: { origin: Vec3; normal: Vec3; flip?: boolean } | undefined,
    owner: string
  ): { origin: Vec3; normal: Vec3; flip?: boolean } | undefined => {
    if (!plane) return undefined;
    const ok =
      Array.isArray(plane.origin) &&
      plane.origin.length === 3 &&
      plane.origin.every(Number.isFinite) &&
      Array.isArray(plane.normal) &&
      plane.normal.length === 3 &&
      plane.normal.every(Number.isFinite) &&
      plane.normal.some((v) => v !== 0);
    if (!ok) {
      warnings.push(`${owner} has an invalid section plane — drawn uncut.`);
      return undefined;
    }
    return plane;
  };
  options.views.forEach((view, i) => {
    const basis = viewBasis(view.direction, view.up);
    const subset = assignment[i].map((ai) => annotations[ai]);
    if (layerFilter.length > 0) {
      const layerGroups = layerFilter.map((sub) => {
        const { indices, face } = subsetFor(sub);
        const runs = runsFor(indices, face, basis, view.direction, sub.edges);
        return { id: sub.id, name: sub.name, color: sub.color, visible: runs.visible, hidden: runs.hidden };
      });
      inputs.push({
        name: view.name,
        direction: view.direction,
        visible: [],
        hidden: [],
        layerGroups,
        ...(subset.length > 0 ? { dimensions: dimensionDrawings(subset, view, glyphScale) } : {}),
      });
      return;
    }
    const plane = validPlane(view.sectionPlane, `View "${view.name}"`);
    if (!plane) {
      const runs = runsFor(mesh.indices, triangleFace, basis, view.direction, []);
      const holeMarks = holeMarksFor(basis, view.direction, runs.visible);
      inputs.push({
        name: view.name,
        direction: view.direction,
        visible: runs.visible,
        hidden: runs.hidden,
        ...(holeMarks ? { holeMarks } : {}),
        ...(subset.length > 0 ? { dimensions: dimensionDrawings(subset, view, glyphScale) } : {}),
      });
      return;
    }
    // In-place cut: this view draws the retained half-space, with the cut
    // loops hatched. A miss names the view, like a named section names itself.
    const { clipped, loops, open } = clipOrThrow(plane, `view "${view.name}"`);
    const runs = runsFor(clipped.indices, clipped.triangleFace, basis, view.direction, [], clipped.positions);
    const loops2D = loops.map((loop) => loop.points.map((p) => project3(p, basis)));
    const open2D: Array<[[number, number], [number, number]]> = [];
    for (const chain of open) {
      const pts = chain.points.map((p) => project3(p, basis));
      for (let k = 0; k + 1 < pts.length; k++) open2D.push([pts[k], pts[k + 1]]);
    }
    inputs.push({
      name: view.name,
      direction: view.direction,
      visible: [...runs.visible, ...open2D],
      hidden: runs.hidden,
      section: { id: `view-${view.name}`, label: view.name, loops: loops2D },
      ...(subset.length > 0 ? { dimensions: dimensionDrawings(subset, view, glyphScale) } : {}),
    });
  });

  // Named sections, each appended as its own view looking along the plane
  // normal (face-on to the cut) — the same direction the parent mark's
  // arrows point. The parent keeps its full-model runs and gains the
  // cutting-plane mark.
  for (const built of builtSections) {
    const parent = options.views[built.parentIndex];
    const parentInput = inputs[built.parentIndex];
    const parentBasis = viewBasis(parent.direction, parent.up);
    const label = built.spec.label?.trim() || built.spec.id;
    const bounds = drawingBounds(parentInput.visible, parentInput.hidden, []);
    const mark = bounds
      ? cuttingPlaneMark(
          { origin: built.spec.origin, normal: built.spec.normal, flip: built.spec.flip },
          parentBasis,
          bounds,
          label
        )
      : null;
    if (mark) {
      parentInput.sectionMarks = [...(parentInput.sectionMarks ?? []), mark];
    } else {
      warnings.push(
        `Section "${built.spec.id}" is face-on to view "${parent.name}" — drawn without a cutting-plane mark.`
      );
    }
    const nlen = Math.hypot(built.spec.normal[0], built.spec.normal[1], built.spec.normal[2]);
    const sectionDir: Vec3 =
      built.spec.flip === true
        ? [-built.spec.normal[0] / nlen, -built.spec.normal[1] / nlen, -built.spec.normal[2] / nlen]
        : [built.spec.normal[0] / nlen, built.spec.normal[1] / nlen, built.spec.normal[2] / nlen];
    const sectionBasis = viewBasis(sectionDir);
    const { clipped, loops, open } = clipOrThrow(
      { origin: built.spec.origin, normal: built.spec.normal, flip: built.spec.flip },
      built.spec.id
    );
    const runs = runsFor(clipped.indices, clipped.triangleFace, sectionBasis, sectionDir, [], clipped.positions);
    const loops2D = loops.map((loop) => loop.points.map((p) => project3(p, sectionBasis)));
    const open2D: Array<[[number, number], [number, number]]> = [];
    for (const chain of open) {
      const pts = chain.points.map((p) => project3(p, sectionBasis));
      for (let k = 0; k + 1 < pts.length; k++) open2D.push([pts[k], pts[k + 1]]);
    }
    inputs.push({
      name: `section-${built.spec.id}`,
      labelText: `SECTION ${label}`,
      direction: sectionDir,
      visible: [...runs.visible, ...open2D],
      hidden: runs.hidden,
      section: { id: built.spec.id, label, loops: loops2D },
    });
  }

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
  const placedByName = new Map(layout.views.map((v) => [v.name, v]));
  const sections = builtSections.map((built) => {
    const placed = placedByName.get(`section-${built.spec.id}`);
    const label = built.spec.label?.trim() || built.spec.id;
    if (!placed?.section) {
      warnings.push(`Section "${built.spec.id}" produced no drawable geometry and was omitted from the sheet.`);
      return { id: built.spec.id, label, parentView: options.views[built.parentIndex].name, loopCount: 0, hatchLineCount: 0 };
    }
    return {
      id: built.spec.id,
      label,
      parentView: options.views[built.parentIndex].name,
      loopCount: placed.section.loopCount,
      hatchLineCount: placed.section.hatch.length,
    };
  });
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
      segmentCount: v.visible.length + (v.layerGroups ?? []).reduce((n, g) => n + g.visible.length, 0),
      hiddenSegmentCount: v.hidden.length + (v.layerGroups ?? []).reduce((n, g) => n + g.hidden.length, 0),
      dimensionCount: v.dimensions?.drawings.length ?? 0,
      ...(wantHoles && cylinders ? { holeMarkCount: v.holeMarks?.holeCount ?? 0 } : {}),
      ...(v.section ? { sectionLoopCount: v.section.loopCount } : {}),
    })),
    sections,
    triangleCount,
    warnings,
  };
}
