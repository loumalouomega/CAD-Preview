import * as THREE from "three";

/**
 * An orientation gizmo: a small labeled cube with RGB axes that indicates the
 * current view orientation and snaps the camera to a standard view when clicked.
 *
 * It owns **no renderer or canvas** — the {@link Viewer} draws it into a corner of
 * the main canvas via a scissor viewport, so only a single WebGL context exists.
 * Asset-free: face labels are drawn onto 2D canvases as `CanvasTexture`s (CSP-safe).
 */
export class OrientationCube {
  readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly cube: THREE.Mesh;
  private readonly raycaster = new THREE.Raycaster();
  private readonly materials: THREE.MeshBasicMaterial[];
  private readonly textures: THREE.CanvasTexture[];
  private readonly camDistance = 5;
  /** Arrow heads, clickable as axis tips: each looks along its own axis. */
  private readonly tips: Array<{ cone: THREE.Object3D; dir: THREE.Vector3 }> = [];

  constructor() {
    const frustum = 1.8;
    this.camera = new THREE.OrthographicCamera(-frustum, frustum, frustum, -frustum, 0.1, 100);

    // Material order matches BoxGeometry faces: +X, -X, +Y, -Y, +Z, -Z.
    const labels = ["RIGHT", "LEFT", "TOP", "BOTTOM", "FRONT", "REAR"];
    this.textures = labels.map((l) => makeLabelTexture(l));
    this.materials = this.textures.map((map) => new THREE.MeshBasicMaterial({ map }));
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.materials);
    this.scene.add(this.cube);

    // RGB axis arrows (X red, Y green, Z blue) — matches the main AxesHelper.
    const len = 1.3;
    const arrow = (dir: THREE.Vector3, color: number): void => {
      const a = new THREE.ArrowHelper(dir, new THREE.Vector3(), len, color, 0.3, 0.2);
      this.scene.add(a);
      this.tips.push({ cone: a.cone, dir: dir.clone() });
    };
    arrow(new THREE.Vector3(1, 0, 0), 0xff3653);
    arrow(new THREE.Vector3(0, 1, 0), 0x8adb00);
    arrow(new THREE.Vector3(0, 0, 1), 0x2c8fff);
  }

  /** The gizmo's camera (kept in sync via {@link syncCamera}). */
  get viewCamera(): THREE.Camera {
    return this.camera;
  }

  /** Aims the gizmo camera along `dir` (with `up`) so the cube mirrors the main view. */
  syncCamera(dir: THREE.Vector3, up: THREE.Vector3): void {
    this.camera.position.copy(dir).normalize().multiplyScalar(this.camDistance);
    this.camera.up.copy(up);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
  }

  /**
   * Raycasts the gizmo at gizmo-local NDC coordinates and returns the unit view
   * direction to snap to, or `null` if nothing was hit. An axis arrow head looks
   * along its axis; otherwise the cube's 3×3 hit grid gives 6 faces, 12 edges
   * and 8 corners ({@link snapDirectionFromHit}).
   */
  pick(ndcX: number, ndcY: number): THREE.Vector3 | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const tip = this.raycaster.intersectObjects(this.tips.map((t) => t.cone), false)[0];
    if (tip) return this.tips.find((t) => t.cone === tip.object)!.dir.clone();
    const hit = this.raycaster.intersectObject(this.cube)[0];
    if (!hit) return null;
    // The cube sits at identity, so a local hit point maps straight to a world view direction.
    return snapDirectionFromHit(hit.point);
  }

  dispose(): void {
    this.cube.geometry.dispose();
    this.materials.forEach((m) => m.dispose());
    this.textures.forEach((t) => t.dispose());
  }
}

/** Fraction of a face (from each edge) that counts as the edge/corner band: the 3×3 grid's outer thirds. */
const EDGE_BAND = 0.5 - 1 / 6;

/**
 * Maps a point on the surface of the unit cube (half-size 0.5, centred at the
 * origin) to one of the 26 standard view directions: a coordinate beyond the
 * band contributes its sign, the rest contribute 0 — so the middle of a face
 * is a face view, the strips along its borders are edge views and the square
 * corners are corner views. The result is a unit vector.
 */
export function snapDirectionFromHit(p: THREE.Vector3): THREE.Vector3 {
  const q = (v: number): number => (Math.abs(v) > EDGE_BAND ? Math.sign(v) : 0);
  const d = new THREE.Vector3(q(p.x), q(p.y), q(p.z));
  // A point on the surface always has one coordinate at ±0.5, so d is never zero; keep a safe fallback.
  return d.lengthSq() === 0 ? faceNormalToDirection(p) : d.normalize();
}

/** Snaps a (near axis-aligned) face normal to the dominant unit axis direction. */
export function faceNormalToDirection(n: THREE.Vector3): THREE.Vector3 {
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  if (ax >= ay && ax >= az) return new THREE.Vector3(Math.sign(n.x), 0, 0);
  if (ay >= az) return new THREE.Vector3(0, Math.sign(n.y), 0);
  return new THREE.Vector3(0, 0, Math.sign(n.z));
}

/** Draws a face label onto a canvas and returns it as a texture. */
function makeLabelTexture(text: string): THREE.CanvasTexture {
  const s = 128;
  const canvas = document.createElement("canvas");
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#2b6cb0";
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = "#1a4a7a";
  ctx.lineWidth = 6;
  ctx.strokeRect(0, 0, s, s);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 26px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, s / 2, s / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  return texture;
}
