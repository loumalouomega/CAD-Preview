import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as cam from "./cameraControls";
import { OrientationCube } from "./orientationCube";
import { collectTargets, resolvePick, type PickResult } from "./picking";
import { DEFAULT_EDGE_COLOR, DEFAULT_FACE_COLOR, DEFAULT_POINT_COLOR } from "./geometryBuilder";
import type { EntityType } from "../protocol";
import type { SelectedEntity } from "./selection";

/** Emissive tint applied to the transiently-selected entities. */
const SELECTION_COLOR = 0x3b82f6;

/** Per-part colouring of entities, resolved by id. */
export interface EntityColorMap {
  solids: Map<string, string>; // solidId → colour (applies to all its faces)
  faces: Map<string, string>;  // faceId → colour (overrides the solid colour)
  edges: Map<string, string>;  // edgeId → colour
  points: Map<string, string>; // pointId → colour
}

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
  /** The generated FE-mesh overlay (if any) — a scene sibling of `model`, never a child. */
  private meshOverlay: THREE.Object3D | null = null;
  private wireframe = false;
  private readonly raycaster = new THREE.Raycaster();
  /** World-space half-thickness for picking thin edge lines; scaled per model. */
  private pickThreshold = 0.05;
  /** World-space scale for point sprites; scaled per model (see `frame()`). */
  private pointSpriteScale = 0.02;
  private selectionMode: EntityType | null = null;
  private onEntityPick: ((r: PickResult, additive: boolean) => void) | null = null;
  private onEmptyPick: (() => void) | null = null;
  private pointerDownPos: { x: number; y: number } | null = null;

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
    // Entity picking: select on a click (down+up without a drag) so orbit still works.
    this.renderer.domElement.addEventListener("pointerdown", this.onSelectPointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.onSelectPointerUp);
    window.addEventListener("resize", this.onResize);
    this.animate();
  }

  /** The currently displayed model, or `null` if none has been loaded yet. */
  getModel(): THREE.Object3D | null {
    return this.model;
  }

  /** Replaces the current model with `object`, recenters and fits the camera to it. */
  setModel(object: THREE.Object3D): void {
    // A previously-generated FE mesh overlay was computed from the OLD geometry;
    // it's now stale and must not linger looking valid over the new model.
    this.setMeshOverlay(null);
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

  /**
   * Replaces the generated FE-mesh overlay. Disposes the previous overlay's
   * geometries/materials and removes it from the scene (a sibling of `model`,
   * never one of its children), so toggling meshing off leaves the original
   * geometry completely untouched. Pass `null` to just clear the overlay.
   */
  setMeshOverlay(obj: THREE.Object3D | null): void {
    if (this.meshOverlay) {
      this.scene.remove(this.meshOverlay);
      this.meshOverlay.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      });
      this.meshOverlay = null;
    }
    if (obj) {
      this.meshOverlay = obj;
      this.scene.add(obj);
    }
    // Shaded faces and the FE-mesh overlay are both opaque solids at the same
    // location — showing both makes neither legible (see the screenshot in the
    // originating bug report). Hide the model's faces while an overlay is shown,
    // keeping edges/points visible as a feature-line reference; restore them the
    // moment the overlay is cleared. Display-only (Object3D.visible), never
    // touches geometry.
    this.setModelFacesVisible(this.meshOverlay === null);
  }

  /**
   * Shows/hides the *current* overlay in place (`Object3D.visible`), without
   * disposing it — unlike `setMeshOverlay(null)`, which tears the overlay down
   * entirely. This is what the toolbar's FE Mesh toggle uses: switching it off
   * then back on redisplays the same generated mesh instantly, with no need to
   * re-run Generate. A no-op if nothing has been generated yet (`meshOverlay`
   * is `null`) — the model's faces are left exactly as they were in that case.
   */
  setMeshOverlayVisible(visible: boolean): void {
    if (!this.meshOverlay) return;
    this.meshOverlay.visible = visible;
    this.setModelFacesVisible(!visible);
  }

  /** Shows/hides the model's shaded face meshes (`entityType === "surface"`), leaving edges/points untouched. */
  private setModelFacesVisible(visible: boolean): void {
    this.model?.traverse((obj) => {
      if (obj.userData.entityType === "surface") obj.visible = visible;
    });
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
    // Edge lines are infinitely thin; pick them within ~2% of the model radius.
    this.pickThreshold = radius * 0.02;
    // Point sprites don't share the raycaster's Line.threshold mechanism — their
    // own world-space scale is what makes them proportionally hit-testable/visible.
    this.pointSpriteScale = radius * 0.01;
    this.model?.traverse((obj) => {
      if (obj instanceof THREE.Sprite && obj.userData.entityType === "point") {
        obj.scale.setScalar(this.pointSpriteScale);
      }
    });

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

  // ── Entity selection & per-part colouring ──────────────────────────────

  /** Sets the active pick mode (`null` disables picking). */
  setSelectionMode(mode: EntityType | null): void {
    this.selectionMode = mode;
  }

  /** Registers callbacks for entity clicks and clicks on empty space. */
  setEntityPickHandler(onPick: (r: PickResult, additive: boolean) => void, onEmpty: () => void): void {
    this.onEntityPick = onPick;
    this.onEmptyPick = onEmpty;
  }

  /**
   * Applies persistent per-part colours. Faces use their direct colour, else
   * their solid's colour, else the default; edges use their colour or default.
   * The base colour is stashed in `userData.baseColor` so the transient
   * selection highlight can restore it.
   */
  setEntityColors(map: EntityColorMap): void {
    this.model?.traverse((obj) => {
      const ud = obj.userData;
      if (obj instanceof THREE.Mesh && ud.entityType === "surface") {
        const hex = map.faces.get(ud.entityId) ?? map.solids.get(ud.groupId);
        const color = hex ? new THREE.Color(hex) : new THREE.Color(DEFAULT_FACE_COLOR);
        ud.baseColor = color.getHex();
        (obj.material as THREE.MeshStandardMaterial).color.copy(color);
      } else if (obj instanceof THREE.Line && ud.entityType === "line") {
        const hex = map.edges.get(ud.entityId);
        const color = hex ? new THREE.Color(hex) : new THREE.Color(DEFAULT_EDGE_COLOR);
        ud.baseColor = color.getHex();
        (obj.material as THREE.LineBasicMaterial).color.copy(color);
      } else if (obj instanceof THREE.Sprite && ud.entityType === "point") {
        const hex = map.points.get(ud.entityId);
        const color = hex ? new THREE.Color(hex) : new THREE.Color(DEFAULT_POINT_COLOR);
        ud.baseColor = color.getHex();
        (obj.material as THREE.SpriteMaterial).color.copy(color);
      }
    });
  }

  /** Highlights the transiently-selected entities over their base colours. */
  renderSelection(selected: SelectedEntity[]): void {
    const keys = new Set(selected.map((e) => `${e.entityType}:${e.entityId}`));
    this.model?.traverse((obj) => {
      const ud = obj.userData;
      if (obj instanceof THREE.Mesh && ud.entityType === "surface") {
        const on = keys.has(`surface:${ud.entityId}`) || keys.has(`volume:${ud.groupId}`);
        const mat = obj.material as THREE.MeshStandardMaterial;
        mat.emissive.setHex(on ? SELECTION_COLOR : 0x000000);
      } else if (obj instanceof THREE.Line && ud.entityType === "line") {
        const mat = obj.material as THREE.LineBasicMaterial;
        const base = (ud.baseColor as number | undefined) ?? DEFAULT_EDGE_COLOR;
        mat.color.setHex(keys.has(`line:${ud.entityId}`) ? SELECTION_COLOR : base);
      } else if (obj instanceof THREE.Sprite && ud.entityType === "point") {
        const mat = obj.material as THREE.SpriteMaterial;
        const base = (ud.baseColor as number | undefined) ?? DEFAULT_POINT_COLOR;
        mat.color.setHex(keys.has(`point:${ud.entityId}`) ? SELECTION_COLOR : base);
      }
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
    this.renderer.domElement.removeEventListener("pointerdown", this.onSelectPointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.onSelectPointerUp);
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

  private onSelectPointerDown = (event: PointerEvent): void => {
    this.pointerDownPos = { x: event.clientX, y: event.clientY };
  };

  private onSelectPointerUp = (event: PointerEvent): void => {
    const down = this.pointerDownPos;
    this.pointerDownPos = null;
    if (!down || this.selectionMode === null || !this.model) return;
    // Ignore drags (orbit/pan) — only a near-stationary click selects.
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((event.clientY - rect.top) / rect.height) * 2;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    this.raycaster.params.Line.threshold = this.pickThreshold;

    const targets = collectTargets(this.model, this.selectionMode);
    const hits = this.raycaster.intersectObjects(targets, false);
    for (const h of hits) {
      const r = resolvePick(h.object.userData, this.selectionMode);
      if (r) {
        this.onEntityPick?.(r, event.shiftKey);
        return;
      }
    }
    this.onEmptyPick?.();
  };

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
