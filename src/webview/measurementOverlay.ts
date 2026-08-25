import * as THREE from "three";
import {
  computeExtensionLinePositions,
  computeArrowheadVertices,
  computeWitnessMarks,
  formatMeasureValue,
} from "./dimensionGlyph";

/** Accent color for measurement overlays — matches the selection highlight (`viewer.ts`'s `SELECTION_COLOR`). */
const MEASURE_COLOR = 0x3b82f6;

/** How far extension lines stop short of the model edge, as a factor of the bbox diagonal. Used by the glyph renderer. */
const GAP_FACTOR = 0.02;

/** How far arrowheads extend past the endpoint, as a factor of the segment length. */
const ARROW_TIP_LENGTH_FACTOR = 0.15;
/** Arrowhead "spike" length relative to the segment (fraction of segment length). */
const ARROW_BASE_WIDTH_FACTOR = 0.3;

/** Label canvas size in px — a 4:1 aspect ratio the sprite scale below preserves. */
const LABEL_W = 256;
const LABEL_H = 64;

/**
 * Lazily built and memoized on first use (NOT at module load) — same
 * discipline `geometryBuilder.ts`'s `dotTexture()` follows, and for the same
 * reason: this module is reachable from pure-function tests with zero
 * DOM/jsdom available, and a module-scope `document.createElement("canvas")`
 * would break them on import alone.
 */
let _labelCanvas: HTMLCanvasElement | null = null;
function labelCanvas(): HTMLCanvasElement {
  if (!_labelCanvas) {
    _labelCanvas = document.createElement("canvas");
    _labelCanvas.width = LABEL_W;
    _labelCanvas.height = LABEL_H;
  }
  return _labelCanvas;
}

let _markerCanvas: HTMLCanvasElement | null = null;
function markerCanvas(): HTMLCanvasElement {
  if (!_markerCanvas) {
    const s = 32;
    _markerCanvas = document.createElement("canvas");
    _markerCanvas.width = s;
    _markerCanvas.height = s;
    const ctx = _markerCanvas.getContext("2d")!;
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s / 2 - 3, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#" + MEASURE_COLOR.toString(16).padStart(6, "0");
    ctx.stroke();
  }
  return _markerCanvas;
}

/**
 * A floating text label at the origin, camera-facing (a Sprite). Only ONE
 * measurement overlay is ever live at a time (a new pick or mode toggle
 * disposes the previous one — see `Viewer.showMeasurementOverlay`/
 * `clearMeasurementOverlay`), so repainting the single shared canvas and
 * wrapping it in a fresh `CanvasTexture` per call is safe — no two labels
 * coexist. `depthTest: false` keeps the label legible in front of the model
 * regardless of what's behind it, matching the overlay's "annotation, not
 * scene geometry" role.
 */
export function makeMeasureLabelSprite(text: string): THREE.Sprite {
  const canvas = labelCanvas();
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(20, 20, 24, 0.85)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#" + MEASURE_COLOR.toString(16).padStart(6, "0");
  ctx.strokeRect(1.5, 1.5, canvas.width - 3, canvas.height - 3);
  ctx.font = "bold 30px sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.userData.isMeasureLabel = true;
  sprite.renderOrder = 999;
  return sprite;
}

/** A small ring marker at a picked point — shown while a multi-pick measurement is still in progress. */
export function makeMeasureMarkerSprite(): THREE.Sprite {
  const material = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(markerCanvas()), depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 999;
  return sprite;
}

/** A straight line between two picked points (e.g. the distance/angle overlay). */
export function buildMeasureLine(a: THREE.Vector3, b: THREE.Vector3): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints([a, b]);
  const material = new THREE.LineBasicMaterial({ color: MEASURE_COLOR, depthTest: false });
  const line = new THREE.Line(geometry, material);
  line.renderOrder = 999;
  return line;
}

/** Create a THREE.Line for an extension line, stopping short of the model edge. */
export function buildMeasureExtensionLine(start: THREE.Vector3, end: THREE.Vector3, gap: number): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
  const material = new THREE.LineBasicMaterial({ color: MEASURE_COLOR, depthTest: false });
  const line = new THREE.Line(geometry, material);
  line.renderOrder = 998; // behind the main measurement line
  return line;
}

/** Build a full dimension-glyph group for a 2-point measurement (distance).
 *  Includes the measurement line, extension lines, arrowheads, and a value label.
 *
 * @param p0 first pick position (world space)
 * @param p1 second pick position (world space)
 * @param bboxDiagonal model bbox diagonal, for gap scaling
 * @returns a THREE.Group with all glyph components, or null if the measurement
 * is not a valid 2-point distance measurement
 */
export function buildMeasureGlyphGroup(
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  bboxDiagonal: number,
): THREE.Group | null {
  const gap = Math.max(1e-3, bboxDiagonal * GAP_FACTOR);

  // Compute extension line positions using the dimensionGlyph module
  // (returns { extensionLine0, extensionLine1, gap }) and convert to THREE.Vector3
  const { extensionLine0, extensionLine1 } = computeExtensionLinePositions(
    [p0.x, p0.y, p0.z],
    [p1.x, p1.y, p1.z],
    bboxDiagonal,
  );
  // extensionLine0/1 are offset positions from each pick; the extension line
  // goes from the pick to that offset point.
  const extLine0 = new THREE.Vector3(extensionLine0[0], extensionLine0[1], extensionLine0[2]);
  const extLine1 = new THREE.Vector3(extensionLine1[0], extensionLine1[1], extensionLine1[2]);

  // Create the measurement line between the two picks
  const lineGeometry = new THREE.BufferGeometry().setFromPoints([p0, p1]);
  const lineMaterial = new THREE.LineBasicMaterial({ color: MEASURE_COLOR, depthTest: false });
  const measurementLine = new THREE.Line(lineGeometry, lineMaterial);
  measurementLine.renderOrder = 999;

  // Create extension lines (from pick to offset position)
  const extGeom0 = new THREE.BufferGeometry().setFromPoints([p0, extLine0]);
  const extMat0 = new THREE.LineBasicMaterial({ color: MEASURE_COLOR, depthTest: false });
  const lineEx0 = new THREE.Line(extGeom0, extMat0);
  lineEx0.renderOrder = 998;

  const extGeom1 = new THREE.BufferGeometry().setFromPoints([p1, extLine1]);
  const extMat1 = new THREE.LineBasicMaterial({ color: MEASURE_COLOR, depthTest: false });
  const lineEx1 = new THREE.Line(extGeom1, extMat1);
  lineEx1.renderOrder = 998;

  // Compute arrowhead positions using dimensionGlyph
  const segX = p1.x - p0.x;
  const segY = p1.y - p0.y;
  const segLen = Math.hypot(segX, segY);
  const safeSegLen = segLen > 0 ? segLen : 1;
  const tipLen = Math.max(1, segLen * ARROW_TIP_LENGTH_FACTOR);

  const arrowTip0 = computeArrowheadVertices([p0.x, p0.y, p0.z], [p1.x, p1.y, p1.z], tipLen);
  const arrowTip1 = computeArrowheadVertices([p1.x, p1.y, p1.z], [p0.x, p0.y, p0.z], tipLen);

  // Arrowhead at p1
  const arrow1 = new THREE.Mesh(
    new THREE.ConeGeometry(tipLen * 0.4, tipLen, 8, 1, true),
    new THREE.MeshBasicMaterial({ color: MEASURE_COLOR, depthTest: false }),
  );
  arrow1.position.set(arrowTip1.p[0], arrowTip1.p[1]); // 2D arrowhead, z dropped
  // Rotate to align with segment direction
  const unitDir1 = new THREE.Vector3(segX / safeSegLen, segY / safeSegLen, 0);
  const up1 = new THREE.Vector3(0, 0, 1);
  const cross1 = new THREE.Vector3().crossVectors(unitDir1, up1);
  if (cross1.lengthSq() > 0) {
    cross1.normalize();
    const dot1 = unitDir1.dot(up1);
    const angle1 = Math.acos(Math.min(1, Math.max(-1, dot1))) * (Math.sign(cross1.z) || 1);
    arrow1.rotation.z = angle1; // rotate around Z axis for 2D rendering
  }

  // Arrowhead at p0 (use the first computed arrow tip, from p0→p1 direction)
  const arrow0 = new THREE.Mesh(
    new THREE.ConeGeometry(tipLen * 0.4, tipLen, 8, 1, true),
    new THREE.MeshBasicMaterial({ color: MEASURE_COLOR, depthTest: false }),
  );
  arrow0.position.set(arrowTip0.p[0], arrowTip0.p[1]); // 2D arrowhead, z dropped
  // Rotate to align with segment direction (reversed)
  const unitDir0 = new THREE.Vector3(-segX / safeSegLen, -segY / safeSegLen, 0);
  const up0 = new THREE.Vector3(0, 0, 1);
  const cross0 = new THREE.Vector3().crossVectors(unitDir0, up0);
  if (cross0.lengthSq() > 0) {
    cross0.normalize();
    const dot0 = unitDir0.dot(up0);
    const angle0 = Math.acos(Math.min(1, Math.max(-1, dot0))) * (Math.sign(cross0.z) || 1);
    arrow0.rotation.z = angle0; // simplify: rotate around Z axis
  }

  // Create the value label at the midpoint
  const midX = (p0.x + p1.x) / 2;
  const midY = (p0.y + p1.y) / 2;
  const value = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
  const labelText = formatMeasureValue(value);
  const labelSprite = makeMeasureLabelSprite(labelText);
  labelSprite.position.set(midX, midY, 0);
  labelSprite.renderOrder = 1000; // in front of lines/arrows

  // Build the group
  const group = new THREE.Group();
  group.add(measurementLine);
  group.add(lineEx0);
  group.add(lineEx1);
  group.add(arrow0);
  group.add(arrow1);
  group.add(labelSprite);

  return group;
}

/** Dispose every geometry/material (and its texture, for label/marker sprites) under `obj`. */
export function disposeMeasureObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const geometry = (o as THREE.Line).geometry;
    if (geometry) geometry.dispose();
    const material = (o as THREE.Sprite | THREE.Line).material as
      | THREE.Material
      | THREE.Material[]
      | undefined;
    const materials = Array.isArray(material) ? material : material ? [material] : [];
    for (const m of materials) {
      const withMap = m as THREE.SpriteMaterial;
      withMap.map?.dispose();
      m.dispose();
    }
  });
}