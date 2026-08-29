import * as THREE from "three";
import { computeDistanceGlyph, type ArrowheadSpec } from "./dimensionGlyph";
import { paletteColor } from "./palette";

/** Accent color for measurement overlays. Shares ONE palette entry with the
 * selection highlight (`viewer.ts`'s `selectionColor()`) — these were two
 * constants holding the same value in two files, the second commented as
 * "matches the selection highlight", which is exactly the drift a shared
 * palette removes. */
const measureColor = (): number => paletteColor("accent");

/** Accent used for an OUT-of-tolerance toleranced pin — a presentation choice
 * derived at render time from the annotation's frozen facts (the annotation
 * itself stores facts only). */
export const measureFailColor = (): number => paletteColor("accentFail");

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

/**
 * The marker bakes its accent into PIXELS, unlike `geometryBuilder.ts`'s
 * `dotTexture()` (white-filled and tinted per instance via `SpriteMaterial.color`,
 * so that one is theme-safe for free). Memoizing it therefore has to be keyed on
 * the colour it was drawn with, or a theme change would keep serving a stale
 * bitmap — invalidating a cache, not swapping a material.
 */
let _markerCanvas: HTMLCanvasElement | null = null;
let _markerCanvasColor: number | null = null;
function markerCanvas(): HTMLCanvasElement {
  const color = measureColor();
  if (!_markerCanvas || _markerCanvasColor !== color) {
    const s = 32;
    _markerCanvas ??= document.createElement("canvas");
    _markerCanvas.width = s;
    _markerCanvas.height = s;
    const ctx = _markerCanvas.getContext("2d")!;
    ctx.clearRect(0, 0, s, s);
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s / 2 - 3, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#" + color.toString(16).padStart(6, "0");
    ctx.stroke();
    _markerCanvasColor = color;
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
 *
 * `accent` recolors the frame for a derived tone (an out-of-tolerance
 * toleranced pin passes {@link measureFailColor}); it never changes the
 * stored measurement text, which stays a frozen fact.
 */
export function makeMeasureLabelSprite(text: string, accent?: number): THREE.Sprite {
  const accentHex = "#" + (accent ?? measureColor()).toString(16).padStart(6, "0");
  const canvas = labelCanvas();
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(20, 20, 24, 0.85)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineWidth = 3;
  ctx.strokeStyle = accentHex;
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
  sprite.renderOrder = 1001;
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
function buildGlyphLine(a: THREE.Vector3, b: THREE.Vector3, color: number, renderOrder: number): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints([a, b]);
  const material = new THREE.LineBasicMaterial({ color, depthTest: false });
  const line = new THREE.Line(geometry, material);
  line.renderOrder = renderOrder;
  return line;
}

/** One arrowhead cone: tip EXACTLY at `spec.tip`, axis along `spec.axis`.
 * `ConeGeometry`'s apex sits at +Y·height/2 in local space, so the mesh is
 * oriented by rotating +Y onto the spec axis and backing off half the height
 * along it. Same quaternion-alignment precedent as `meshEdits.ts`'s
 * primitive placement. */
function buildArrowhead(spec: ArrowheadSpec): THREE.Mesh {
  const geometry = new THREE.ConeGeometry(spec.halfWidth, spec.length, 12, 1, true);
  const material = new THREE.MeshBasicMaterial({ color: measureColor(), depthTest: false, depthWrite: false });
  const cone = new THREE.Mesh(geometry, material);
  const axis = new THREE.Vector3(...spec.axis);
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  cone.position.copy(new THREE.Vector3(...spec.tip)).addScaledVector(axis, -spec.length / 2);
  cone.renderOrder = 999;
  return cone;
}

/**
 * Builds the dimension-glyph group for a completed 2-point measurement:
 * the measured line, outward-pointing arrowheads at both ends, and short
 * perpendicular witness stubs. Geometry comes entirely from the pure,
 * unit-tested `dimensionGlyph.ts`; sizes derive from `scale` (the model's
 * bbox diagonal) and are capped against the segment length there.
 *
 * Deliberately view-independent (on-segment style): a pinned annotation's
 * glyph must stay put while the camera orbits, so no screen-facing offset is
 * computed. The classic offset-dimension look belongs to the fixed-view SVG/
 * DXF export path, which runs the SAME math with an `offsetDir`.
 */
export function buildMeasureDimensionGroup(p0: THREE.Vector3, p1: THREE.Vector3, scale: number): THREE.Group {
  const group = new THREE.Group();
  const glyph = computeDistanceGlyph([p0.x, p0.y, p0.z], [p1.x, p1.y, p1.z], { scale });
  if (glyph.line[0].some(Number.isFinite) && glyph.line[1].some(Number.isFinite)) {
    group.add(buildGlyphLine(new THREE.Vector3(...glyph.line[0]), new THREE.Vector3(...glyph.line[1]), measureColor(), 999));
  }
  for (const stub of glyph.witnesses) {
    group.add(buildGlyphLine(new THREE.Vector3(...stub[0]), new THREE.Vector3(...stub[1]), measureColor(), 998));
  }
  for (const head of glyph.arrowheads) {
    group.add(buildArrowhead(head));
  }
  return group;
}

/** Dispose every geometry/material (and its texture, for label/marker sprites) under `obj`. */
export function disposeMeasureObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const geometry = (o as THREE.Line).geometry;
    if (geometry) geometry.dispose();
    const material = (o as THREE.Sprite | THREE.Line | THREE.Mesh).material as
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
