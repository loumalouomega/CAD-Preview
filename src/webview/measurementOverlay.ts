import * as THREE from "three";

/** Accent color for measurement overlays — matches the selection highlight (`viewer.ts`'s `SELECTION_COLOR`). */
const MEASURE_COLOR = 0x3b82f6;

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

/** Disposes every geometry/material (and its texture, for label/marker sprites) under `obj`. */
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
