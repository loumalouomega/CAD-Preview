import * as THREE from "three";
import type { Viewer } from "./viewer";

/**
 * A small interactive orientation cube rendered in its own canvas. It mirrors the
 * main viewer's orientation each frame and, when a face is clicked, snaps the main
 * camera to the corresponding axis-aligned view.
 *
 * Self-contained (own renderer/scene/camera) and asset-free: face labels are drawn
 * onto 2D canvases as `CanvasTexture`s so nothing is fetched (CSP-safe).
 */
export class OrientationCube {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly cube: THREE.Mesh;
  private readonly raycaster = new THREE.Raycaster();
  private readonly materials: THREE.MeshBasicMaterial[];
  private readonly textures: THREE.CanvasTexture[];
  private rafId = 0;
  private readonly camDistance = 5;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly viewer: Viewer
  ) {
    const size = canvas.clientWidth || 90;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(size, size, false);

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

    canvas.addEventListener("pointerdown", this.onPointerDown);
    this.animate();
  }

  private animate = (): void => {
    this.rafId = requestAnimationFrame(this.animate);
    const dir = this.viewer.getViewDirection();
    this.camera.position.copy(dir).multiplyScalar(this.camDistance);
    this.camera.up.copy(this.viewer.getCameraUp());
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  };

  private onPointerDown = (event: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.cube)[0];
    if (!hit?.face) return;
    // The cube sits at identity, so its local face normal is the world view direction.
    const n = hit.face.normal;
    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    const dir = new THREE.Vector3();
    if (ax >= ay && ax >= az) dir.set(Math.sign(n.x), 0, 0);
    else if (ay >= az) dir.set(0, Math.sign(n.y), 0);
    else dir.set(0, 0, Math.sign(n.z));
    this.viewer.setViewDirection(dir);
  };

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.cube.geometry.dispose();
    this.materials.forEach((m) => m.dispose());
    this.textures.forEach((t) => t.dispose());
    this.renderer.dispose();
  }
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
