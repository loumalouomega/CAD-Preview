import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as cam from "./cameraControls";
import { OrientationCube } from "./orientationCube";

/**
 * A self-contained Three.js viewer: scene, lights, helpers, orbit controls and
 * a render loop. Renders a single model `Object3D` at a time.
 */
export class Viewer {
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly grid: THREE.GridHelper;
  private readonly axes: THREE.AxesHelper;
  private readonly gizmo = new OrientationCube();
  private readonly gizmoSize = 96;
  private readonly gizmoMargin = 10;
  private model: THREE.Object3D | null = null;
  private wireframe = false;

  constructor(private readonly container: HTMLElement) {
    const width = container.clientWidth;
    const height = container.clientHeight;

    this.scene.background = new THREE.Color(0x1e1e1e);

    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 1e6);
    this.camera.position.set(5, 5, 5);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(width, height);
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.0));
    const dir = new THREE.DirectionalLight(0xffffff, 1.5);
    dir.position.set(1, 1, 1);
    this.scene.add(dir);

    this.grid = new THREE.GridHelper(10, 10, 0x888888, 0x444444);
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(1);
    this.scene.add(this.axes);

    // Capture-phase so a face click is handled before OrbitControls starts a drag.
    this.renderer.domElement.addEventListener("pointerdown", this.onGizmoPointerDown, true);
    window.addEventListener("resize", this.onResize);
    this.animate();
  }

  /** The currently displayed model, or `null` if none has been loaded yet. */
  getModel(): THREE.Object3D | null {
    return this.model;
  }

  /** Replaces the current model with `object`, recenters and fits the camera to it. */
  setModel(object: THREE.Object3D): void {
    this.clearModel();
    this.model = object;
    this.applyWireframe();
    this.scene.add(object);
    this.resetView();
  }

  private clearModel(): void {
    if (!this.model) return;
    this.scene.remove(this.model);
    this.model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
    this.model = null;
  }

  /** Frames the current model (or the scene) within the view along `direction`. */
  private frame(direction: THREE.Vector3): void {
    const target = this.model ?? this.scene;
    const box = new THREE.Box3().setFromObject(target);
    if (box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;

    // Scale helpers to the model so the grid/axes stay meaningful.
    this.grid.scale.setScalar(radius / 5);
    this.axes.scale.setScalar(radius);

    const fov = (this.camera.fov * Math.PI) / 180;
    const distance = (radius / Math.sin(fov / 2)) * 1.5;
    const dir = direction.clone().normalize();
    this.camera.position.copy(center).addScaledVector(dir, distance);
    this.camera.near = distance / 100;
    this.camera.far = distance * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
  }

  /** Frames the model keeping the current viewing orientation. */
  fitView(): void {
    const dir = this.getViewDirection();
    this.frame(dir);
  }

  /** Resets to the default isometric orientation and frames the model. */
  resetView(): void {
    this.frame(new THREE.Vector3(1, 0.8, 1));
  }

  /** Orbits the camera around the target by the given degrees (azimuth, polar). */
  rotateView(azimuthDeg: number, polarDeg: number): void {
    cam.orbit(this.camera, this.controls.target, azimuthDeg, polarDeg);
    this.controls.update();
  }

  /** Pans the camera and target by fractions of the framed extent. */
  panView(dxFrac: number, dyFrac: number): void {
    cam.pan(this.camera, this.controls.target, dxFrac, dyFrac);
    this.controls.update();
  }

  /** Dollies the camera toward (`factor` < 1) or away from (`> 1`) the target. */
  zoomView(factor: number): void {
    cam.dolly(this.camera, this.controls.target, factor);
    this.controls.update();
  }

  /** Repositions the camera along `dir`, keeping the current target and distance. */
  setViewDirection(dir: THREE.Vector3): void {
    cam.setDirection(this.camera, this.controls.target, dir);
    this.controls.update();
  }

  /** Normalized direction from the orbit target to the camera. */
  getViewDirection(): THREE.Vector3 {
    return cam.viewDirection(this.camera, this.controls.target);
  }

  /** The camera's current up vector. */
  getCameraUp(): THREE.Vector3 {
    return this.camera.up.clone();
  }

  /**
   * Isolates `groupId` by dimming all other meshes, or restores full opacity
   * when called with `null`.
   */
  highlightGroup(groupId: string | null): void {
    this.model?.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mat = obj.material as THREE.MeshStandardMaterial;
      const selected = groupId === null || obj.userData.groupId === groupId;
      mat.opacity = selected ? 1.0 : 0.08;
      mat.transparent = !selected;
      mat.needsUpdate = true;
    });
  }

  setWireframe(on: boolean): void {
    this.wireframe = on;
    this.applyWireframe();
  }

  toggleGrid(): void {
    this.grid.visible = !this.grid.visible;
    this.axes.visible = this.grid.visible;
  }

  private applyWireframe(): void {
    this.model?.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      const mat = mesh.material as (THREE.Material & { wireframe?: boolean }) | undefined;
      if (mat && "wireframe" in mat) mat.wireframe = this.wireframe;
    });
  }

  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    this.renderer.domElement.removeEventListener("pointerdown", this.onGizmoPointerDown, true);
    this.gizmo.dispose();
    this.clearModel();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private onResize = (): void => {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.renderGizmo();
  };

  /** Draws the orientation gizmo into the top-left corner via a scissor viewport. */
  private renderGizmo(): void {
    const el = this.renderer.domElement;
    const cssW = el.clientWidth;
    const cssH = el.clientHeight;
    const s = this.gizmoSize;
    const m = this.gizmoMargin;

    this.gizmo.syncCamera(this.getViewDirection(), this.getCameraUp());

    const x = m;
    const y = cssH - m - s; // GL viewport origin is bottom-left → place at top-left.
    this.renderer.setViewport(x, y, s, s);
    this.renderer.setScissor(x, y, s, s);
    this.renderer.setScissorTest(true);
    // Overlay on the scene: clear only depth in this region, keep the scene's colors.
    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.gizmo.scene, this.gizmo.viewCamera);
    this.renderer.autoClear = prevAutoClear;
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, cssW, cssH);
  }

  private onGizmoPointerDown = (event: PointerEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const cssX = event.clientX - rect.left;
    const cssY = event.clientY - rect.top;
    const s = this.gizmoSize;
    const m = this.gizmoMargin;
    if (cssX < m || cssX > m + s || cssY < m || cssY > m + s) return;

    const ndcX = ((cssX - m) / s) * 2 - 1;
    const ndcY = 1 - ((cssY - m) / s) * 2;
    this.gizmo.syncCamera(this.getViewDirection(), this.getCameraUp());
    const dir = this.gizmo.pick(ndcX, ndcY);
    if (dir) {
      this.setViewDirection(dir);
      // Stop OrbitControls (a listener on the same element) from also reacting.
      event.stopImmediatePropagation();
      event.preventDefault();
    }
  };
}

/** Builds a standard-material mesh for a raw geometry, computing normals if absent. */
export function meshFromGeometry(geometry: THREE.BufferGeometry): THREE.Mesh {
  if (!geometry.getAttribute("normal")) {
    geometry.computeVertexNormals();
  }
  const material = new THREE.MeshStandardMaterial({
    color: 0xc0c4cc,
    metalness: 0.1,
    roughness: 0.7,
    side: THREE.DoubleSide,
    flatShading: false,
  });
  return new THREE.Mesh(geometry, material);
}
