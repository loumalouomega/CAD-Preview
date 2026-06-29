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

  constructor() {
    const frustum = 1.8;
    this.camera = new THREE.OrthographicCamera(-frustum, frustum, frustum, -frustum, 0.1, 100);

    // Material order matches BoxGeometry faces: +X, -X, +Y, -Y, +Z, -Z.
    const labels = ["RIGHT", "LEFT", "TOP", "BOTTOM", "FRONT", "BACK"];
    this.textures = labels.map((l) => makeLabelTexture(l));
    this.materials = this.textures.map((map) => new THREE.MeshBasicMaterial({ map }));
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.materials);
    this.scene.add(this.cube);

    // RGB axis arrows (X red, Y green, Z blue) — matches the main AxesHelper.
    const len = 1.3;
    this.scene.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), len, 0xff3653, 0.3, 0.2));
    this.scene.add(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), len, 0x8adb00, 0.3, 0.2));
    this.scene.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), len, 0x2c8fff, 0.3, 0.2));
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
   * Raycasts the cube at gizmo-local NDC coordinates and returns the axis-aligned
   * direction to snap to, or `null` if no face was hit.
   */
  pick(ndcX: number, ndcY: number): THREE.Vector3 | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hit = this.raycaster.intersectObject(this.cube)[0];
    if (!hit?.face) return null;
    // The cube sits at identity, so its local face normal is the world view direction.
    return faceNormalToDirection(hit.face.normal);
  }

  dispose(): void {
    this.cube.geometry.dispose();
    this.materials.forEach((m) => m.dispose());
    this.textures.forEach((t) => t.dispose());
  }
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
