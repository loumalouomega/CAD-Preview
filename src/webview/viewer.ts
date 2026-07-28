import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as cam from "./cameraControls";
import type { ViewerCamera } from "./cameraControls";
import { OrientationCube } from "./orientationCube";
import { collectTargets, resolvePick, collectMeasureTargets, resolveMeasurePick, type PickResult } from "./picking";
import { DEFAULT_EDGE_COLOR, DEFAULT_FACE_COLOR, DEFAULT_POINT_COLOR } from "./geometryBuilder";
import {
  makeMeasureLabelSprite,
  makeMeasureMarkerSprite,
  buildMeasureLine,
  disposeMeasureObject,
} from "./measurementOverlay";
import type { MeasurementPick } from "./measurementState";
import type { EntityType } from "../protocol";
import type { SelectedEntity } from "./selection";
import type { UpAxis } from "../viewerDefaults";

/** Emissive tint applied to the transiently-selected entities. */
const SELECTION_COLOR = 0x3b82f6;

/** `"type:id"` key, same convention `renderSelection`/`SelectionSet` use. */
function entityKey(e: SelectedEntity): string {
  return `${e.entityType}:${e.entityId}`;
}

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
  /** A second camera kept in sync with `camera`'s position/target, swapped in
   * as `activeCamera` by `setOrthographic` — NOT reconstructed on toggle, so
   * `frame()`/`orbit`/`pan`/`dolly` all operate on `activeCamera` (a
   * `PerspectiveCamera | OrthographicCamera` union) rather than the hardcoded
   * perspective camera directly. */
  private readonly orthoCamera: THREE.OrthographicCamera;
  private activeCamera: ViewerCamera;
  /** The ortho camera's last-framed half-height (world units, before zoom) —
   * `frame()` sets it, `onResize` reuses it to recompute `left/right/top/
   * bottom` for the new aspect ratio without needing a full reframe. */
  private orthoHalfHeight = 5;
  private readonly renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
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
  /** Measurement is a parallel interaction mode, deliberately independent of
   * `selectionMode`/`SelectionSet` — see `setMeasureMode`. */
  private measureMode = false;
  private onMeasurePick: ((pick: MeasurementPick) => void) | null = null;
  /** Display-only overlay (marker, line, label) for the in-progress/completed
   * measurement — a scene sibling of `model`, same pattern as `meshOverlay`. */
  private measurementOverlay: THREE.Object3D | null = null;
  /** The overlay's label sprite, if any — rescaled every frame in `animate()`
   * to stay a constant on-screen size regardless of camera distance/zoom
   * (unlike point sprites, which only need to stay visible, a label
   * specifically needs to stay legible while continuously zooming). */
  private measurementLabel: THREE.Sprite | null = null;
  /** Applied to the model ROOT (not `THREE.Object3D.DEFAULT_UP`, which is a
   * static shared by every `Object3D` including the gizmo/helpers) on the next
   * `setModel()` — see `applyDefaults()`. */
  private upAxis: UpAxis = "y";
  /** The last `groupId` passed to `highlightGroup` (or `null`) — remembered so
   * `setOpacity` can re-apply the same spotlight state on top of a new opacity
   * baseline, since both features write `material.opacity` and must compose
   * rather than clobber each other (see `setOpacity`'s doc comment). */
  private highlightedGroupId: string | null = null;
  /** The Appearance panel's global opacity (0–1, default fully opaque) —
   * session-only, re-applied to every fresh material on `setModel()` (a model
   * rebuild after an edit creates brand-new materials with no baseline). */
  private modelOpacity = 1;
  /** The live clipping plane (or `null` when clipping is off) — session-only,
   * display-only, re-applied to `model`/`meshOverlay` materials whenever
   * either is (re)built, since fresh materials carry no clipping state. */
  private activeClippingPlane: THREE.Plane | null = null;

  constructor(private readonly container: HTMLElement) {
    const width = container.clientWidth;
    const height = container.clientHeight;

    this.scene.background = new THREE.Color(0x1e1e1e);

    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 1e6);
    this.camera.position.set(5, 5, 5);

    const aspect = width / height;
    this.orthoCamera = new THREE.OrthographicCamera(
      -this.orthoHalfHeight * aspect,
      this.orthoHalfHeight * aspect,
      this.orthoHalfHeight,
      -this.orthoHalfHeight,
      0.01,
      1e6
    );
    this.orthoCamera.position.set(5, 5, 5);
    this.activeCamera = this.camera;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(width, height);
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.activeCamera, this.renderer.domElement);
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

  /**
   * The current model's world-space bounding-box dimensions and diagonal, or
   * `null` if no model is loaded. Recomputed on demand (same `Box3` math
   * `frame()` uses) so it automatically tracks edit-driven model rebuilds.
   * Feeds the FE Mesh panel's bbox-derived default size and element-count
   * estimate — display-only, never mutates geometry.
   */
  getModelExtents(): { size: [number, number, number]; diagonal: number } | null {
    if (!this.model) return null;
    const box = new THREE.Box3().setFromObject(this.model);
    if (box.isEmpty()) return null;
    const size = box.getSize(new THREE.Vector3());
    return {
      size: [size.x, size.y, size.z],
      diagonal: size.length(),
    };
  }

  /** Replaces the current model with `object`, recenters and fits the camera to it. */
  setModel(object: THREE.Object3D): void {
    // A previously-generated FE mesh overlay was computed from the OLD geometry;
    // it's now stale and must not linger looking valid over the new model. Any
    // in-progress/completed measurement is equally stale (its points refer to
    // the old geometry) and must not linger either.
    this.setMeshOverlay(null);
    this.clearMeasurementOverlay();
    this.clearModel();
    this.model = object;
    // Z-up source data displayed in this Three.js (Y-up) scene: rotate the model
    // ROOT, not THREE.Object3D.DEFAULT_UP (a static shared by every Object3D,
    // including the gizmo/helpers) — resetView()'s isometric direction is
    // defined in the camera's fixed Y-up world frame and stays meaningful either way.
    object.rotation.x = this.upAxis === "z" ? -Math.PI / 2 : 0;
    this.applyWireframe();
    this.applyOpacityBaseline();
    this.scene.add(object);
    this.applyClippingPlane(); // fresh model materials carry no clipping state yet
    this.resetView();
  }

  /**
   * Applies the `cadPreview.*` cross-document settings: background color and
   * grid/axes visibility take effect immediately (scene-level, independent of
   * whether a model is loaded yet); up-axis is stored and applied at the next
   * `setModel()` call (rotating a not-yet-loaded model root is meaningless).
   * Only ever *initial* state — the toolbar Grid toggle remains a per-session
   * runtime override on top of this, never persisted.
   */
  applyDefaults(d: { background: string; showGridAndAxes: boolean; upAxis: UpAxis }): void {
    this.scene.background = new THREE.Color(d.background);
    this.grid.visible = d.showGridAndAxes;
    this.axes.visible = d.showGridAndAxes;
    this.upAxis = d.upAxis;
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
      this.applyClippingPlane(); // fresh overlay materials carry no clipping state yet
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

    const dir = direction.clone().normalize();
    if (this.activeCamera instanceof THREE.OrthographicCamera) {
      // Parallel projection: apparent size comes from the frustum/zoom, not
      // distance — pick a distance just far enough to keep near/far sane, and
      // size the frustum from the model radius with the same 1.5x margin
      // frame() uses for perspective's fov-based distance.
      const distance = radius * 3;
      this.orthoHalfHeight = radius * 1.5;
      const aspect = this.container.clientWidth / this.container.clientHeight;
      this.activeCamera.left = -this.orthoHalfHeight * aspect;
      this.activeCamera.right = this.orthoHalfHeight * aspect;
      this.activeCamera.top = this.orthoHalfHeight;
      this.activeCamera.bottom = -this.orthoHalfHeight;
      this.activeCamera.zoom = 1;
      this.activeCamera.position.copy(center).addScaledVector(dir, distance);
      this.activeCamera.near = distance / 100;
      this.activeCamera.far = distance * 100;
    } else {
      const fov = (this.activeCamera.fov * Math.PI) / 180;
      const distance = (radius / Math.sin(fov / 2)) * 1.5;
      this.activeCamera.position.copy(center).addScaledVector(dir, distance);
      this.activeCamera.near = distance / 100;
      this.activeCamera.far = distance * 100;
    }
    this.activeCamera.updateProjectionMatrix();
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
    cam.orbit(this.activeCamera, this.controls.target, azimuthDeg, polarDeg);
    this.controls.update();
  }

  /** Pans the camera and target by fractions of the framed extent. */
  panView(dxFrac: number, dyFrac: number): void {
    cam.pan(this.activeCamera, this.controls.target, dxFrac, dyFrac);
    this.controls.update();
  }

  /** Dollies the camera toward (`factor` < 1) or away from (`> 1`) the target. */
  zoomView(factor: number): void {
    cam.dolly(this.activeCamera, this.controls.target, factor);
    this.controls.update();
  }

  /** Repositions the camera along `dir`, keeping the current target and distance. */
  setViewDirection(dir: THREE.Vector3): void {
    cam.setDirection(this.activeCamera, this.controls.target, dir);
    this.controls.update();
  }

  /** Normalized direction from the orbit target to the camera. */
  getViewDirection(): THREE.Vector3 {
    return cam.viewDirection(this.activeCamera, this.controls.target);
  }

  /** The camera's current up vector. */
  getCameraUp(): THREE.Vector3 {
    return this.activeCamera.up.clone();
  }

  /**
   * Toggles between perspective and orthographic projection. NOT a
   * reconstruction — `orthoCamera` is a second camera object kept alive the
   * whole session; this only swaps which one is `activeCamera` (and which one
   * `OrbitControls` targets, via `controls.object` — three.js supports
   * retargeting at runtime, and `OrbitControls`' own dolly/zoom logic already
   * branches on `camera.isPerspectiveCamera`/`isOrthographicCamera`, so mouse-
   * wheel zoom keeps working correctly across the swap with no extra code).
   * Copies position/near/far from the outgoing camera so the view doesn't
   * jump, then calls `frame()` along the same view direction to size the
   * newly-active camera's fov-based distance (perspective) or frustum/zoom
   * (orthographic) correctly — `frame()` already contains that per-type
   * logic, so this reuses it rather than duplicating it.
   */
  setOrthographic(enabled: boolean): void {
    const next: ViewerCamera = enabled ? this.orthoCamera : this.camera;
    if (next === this.activeCamera) return;
    const prev = this.activeCamera;
    next.position.copy(prev.position);
    next.near = prev.near;
    next.far = prev.far;
    const dir = cam.viewDirection(prev, this.controls.target);
    this.activeCamera = next;
    this.controls.object = next;
    this.frame(dir);
  }

  /**
   * Isolates `groupId` by dimming all other meshes, or restores full opacity
   * when called with `null`. Composes with the Appearance panel's global
   * opacity slider (`setOpacity`) rather than clobbering it: both write
   * `material.opacity`, so dimming multiplies against each material's
   * `userData.baseOpacity` (the slider's chosen value, defaulting to 1) rather
   * than overwriting it outright — dragging the slider to 0.5 then spotlighting
   * a group keeps the rest at 0.5×0.08, not a hardcoded 0.08 that ignores the
   * slider, and the spotlighted group stays at the slider's 0.5, not a
   * hardcoded 1.0 that overrides it.
   */
  highlightGroup(groupId: string | null): void {
    this.highlightedGroupId = groupId;
    this.model?.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mat = obj.material as THREE.MeshStandardMaterial;
      const base = (mat.userData.baseOpacity as number | undefined) ?? 1;
      const selected = groupId === null || obj.userData.groupId === groupId;
      mat.opacity = selected ? base : base * 0.08;
      mat.transparent = mat.opacity < 1;
      mat.needsUpdate = true;
    });
  }

  /** Live, session-only background override — same "always wins once set"
   * precedent as `toggleGrid()` vs. `applyDefaults()`'s `showGridAndAxes`. */
  setBackground(hex: string): void {
    this.scene.background = new THREE.Color(hex);
  }

  /** Shows/hides every edge line, leaving faces and points untouched. */
  setEdgesVisible(visible: boolean): void {
    this.model?.traverse((obj) => {
      if (obj.userData.entityType === "line") obj.visible = visible;
    });
  }

  /**
   * Sets every face material's baseline opacity (0–1), then re-applies
   * whatever `highlightGroup` spotlight is currently active on top of it —
   * see `highlightGroup`'s doc comment for why this composition, not a raw
   * overwrite, is required.
   */
  setOpacity(value: number): void {
    this.modelOpacity = value;
    this.applyOpacityBaseline();
    this.highlightGroup(this.highlightedGroupId);
  }

  /** Writes `modelOpacity` onto every current face material's `userData.baseOpacity`. */
  private applyOpacityBaseline(): void {
    this.model?.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mat = obj.material as THREE.MeshStandardMaterial;
      mat.userData.baseOpacity = this.modelOpacity;
    });
  }

  /**
   * Sets/clears the live clipping plane — display-only, distinct from the
   * `section` edit op (which produces real geometry through the op stack);
   * this never touches the model. `null` disables clipping entirely. Applied
   * to every material on both `model` AND `meshOverlay` (the FE-mesh overlay
   * needs the same plane, per the roadmap's explicit note) — re-applied
   * automatically from `setModel()`/`setMeshOverlay()` too, since fresh
   * materials from a model/overlay rebuild carry no clipping state.
   *
   * v1 is deliberately UNCAPPED: `MeshStandardMaterial` + `clippingPlanes`
   * does not auto-cap the cut cross-section (three.js needs a separate
   * stencil-buffer technique for a solid-looking cut) — a clipped solid is
   * see-through/hollow at the cut face, not filled. Still useful for "see
   * inside the model"; capping is a documented follow-up, not in this cut.
   */
  setClippingPlane(plane: THREE.Plane | null): void {
    this.activeClippingPlane = plane;
    this.renderer.localClippingEnabled = plane !== null;
    this.applyClippingPlane();
  }

  private applyClippingPlane(): void {
    const planes = this.activeClippingPlane ? [this.activeClippingPlane] : [];
    const apply = (obj: THREE.Object3D) => {
      const mat = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
      for (const m of mats) {
        m.clippingPlanes = planes;
        m.needsUpdate = true;
      }
    };
    this.model?.traverse(apply);
    this.meshOverlay?.traverse(apply);
  }

  /**
   * Fully hides/shows every object tagged with `groupId` (a solid — the
   * Components tree's per-node eye-toggle operates at this whole-solid
   * granularity, the only depth the tree currently has). Distinct from
   * `highlightGroup`'s opacity-dimming: this is `Object3D.visible`, gone
   * entirely, not translucent — a different code path, not a parameterization.
   */
  setGroupVisible(groupId: string, visible: boolean): void {
    this.model?.traverse((obj) => {
      if (obj.userData.groupId === groupId) obj.visible = visible;
    });
  }

  /**
   * Applies the Parts panel's hide/isolate state in one pass: `hiddenEntities`
   * are forced invisible; if `isolatedEntities` is non-null, ONLY those
   * entities (and nothing else) are visible, overriding `hiddenEntities`
   * entirely for this call — composition across repeated calls is the
   * caller's job (`main.ts` recomputes both sets fresh from `VisibilityState`
   * + `PartsModel.entitiesOf()` on every hide/isolate change, so a part
   * hidden before an isolate stays hidden once isolate is cleared, without
   * this method needing to remember any prior call). Handles surfaces (their
   * own id OR their owning solid's `groupId`, matching `renderSelection`'s
   * existing membership check), lines, and points — unlike `highlightGroup`,
   * which only ever touches `THREE.Mesh`.
   */
  applyPartVisibility(hiddenEntities: SelectedEntity[], isolatedEntities: SelectedEntity[] | null): void {
    const hideKeys = new Set(hiddenEntities.map(entityKey));
    const isolateKeys = isolatedEntities ? new Set(isolatedEntities.map(entityKey)) : null;
    this.model?.traverse((obj) => {
      const ud = obj.userData;
      let key: string | null = null;
      let groupKey: string | null = null;
      if (obj instanceof THREE.Mesh && ud.entityType === "surface") {
        key = `surface:${ud.entityId}`;
        groupKey = `volume:${ud.groupId}`;
      } else if (obj instanceof THREE.Line && ud.entityType === "line") {
        key = `line:${ud.entityId}`;
      } else if (obj instanceof THREE.Sprite && ud.entityType === "point") {
        key = `point:${ud.entityId}`;
      } else {
        return;
      }
      const owns = (set: Set<string>) => (key !== null && set.has(key)) || (groupKey !== null && set.has(groupKey));
      obj.visible = isolateKeys ? owns(isolateKeys) : !owns(hideKeys);
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

  // ── Measurement (display-only overlay, never an edit op, never persisted) ──

  /** Toggles measurement picking. Takes priority over `selectionMode` for a
   * click when both happen to be active — see `onSelectPointerUp`. */
  setMeasureMode(on: boolean): void {
    this.measureMode = on;
  }

  /** Registers the callback fired on every measurement raycast hit. */
  setOnMeasurePick(onPick: ((pick: MeasurementPick) => void) | null): void {
    this.onMeasurePick = onPick;
  }

  /** Shows a single marker at `point` — an in-progress measurement's first pick(s). */
  showMeasurementMarker(point: THREE.Vector3): void {
    this.clearMeasurementOverlay();
    const marker = makeMeasureMarkerSprite();
    marker.position.copy(point);
    this.measurementOverlay = marker;
    this.scene.add(marker);
  }

  /**
   * Shows the completed measurement: an optional line between `linePoints`
   * (2 points — omit for a single-pick tool like edge length/radius, which
   * has nothing to connect) plus a text label at `anchor`. Replaces (disposes)
   * whatever marker/overlay was showing before.
   */
  showMeasurementOverlay(linePoints: THREE.Vector3[], anchor: THREE.Vector3, text: string): void {
    this.clearMeasurementOverlay();
    const group = new THREE.Group();
    if (linePoints.length === 2) {
      group.add(buildMeasureLine(linePoints[0], linePoints[1]));
    }
    const label = makeMeasureLabelSprite(text);
    label.position.copy(anchor);
    group.add(label);
    this.measurementOverlay = group;
    this.measurementLabel = label;
    this.scene.add(group);
  }

  /** Disposes and removes the current measurement overlay (marker or line+label), if any. */
  clearMeasurementOverlay(): void {
    if (!this.measurementOverlay) return;
    this.scene.remove(this.measurementOverlay);
    disposeMeasureObject(this.measurementOverlay);
    this.measurementOverlay = null;
    this.measurementLabel = null;
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

  /** Forces an immediate render of the current frame (used right before a screenshot capture). */
  render(): void {
    this.renderer.render(this.scene, this.activeCamera);
  }

  /**
   * Captures the current framebuffer as a base64 PNG (no `data:` prefix).
   * Callers should call {@link render} immediately before this to guarantee a
   * fresh frame — the renderer has no persistent `preserveDrawingBuffer`, so
   * `toDataURL` reads whatever was drawn most recently.
   */
  captureScreenshotBase64(): string {
    const dataUrl = this.renderer.domElement.toDataURL("image/png");
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
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
    const aspect = width / height;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.orthoCamera.left = -this.orthoHalfHeight * aspect;
    this.orthoCamera.right = this.orthoHalfHeight * aspect;
    this.orthoCamera.top = this.orthoHalfHeight;
    this.orthoCamera.bottom = -this.orthoHalfHeight;
    this.orthoCamera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    if (this.measurementLabel) {
      // Constant on-screen size regardless of zoom — recomputed every frame
      // (unlike the point-sprite scale in `frame()`, which only updates on
      // fit/reset), since a label specifically needs to stay legible while
      // continuously zooming. Under orthographic projection apparent size is
      // NOT distance-dependent (unlike perspective), so the scale instead
      // derives from the current frustum height / zoom.
      const s = this.activeCamera instanceof THREE.OrthographicCamera
        ? ((this.activeCamera.top - this.activeCamera.bottom) / this.activeCamera.zoom) * 0.06
        : this.activeCamera.position.distanceTo(this.measurementLabel.position) * 0.06;
      this.measurementLabel.scale.set(s, s * 0.25, 1); // 4:1 label aspect ratio
    }
    this.renderer.render(this.scene, this.activeCamera);
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
    if (!down || (!this.measureMode && this.selectionMode === null) || !this.model) return;
    // Ignore drags (orbit/pan) — only a near-stationary click selects.
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((event.clientY - rect.top) / rect.height) * 2;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.activeCamera);
    this.raycaster.params.Line.threshold = this.pickThreshold;

    // Measurement takes priority for this click over the normal Parts/Edits
    // selection pick — the two are deliberately independent modes, but a
    // single click can only feed one of them.
    if (this.measureMode) {
      const targets = collectMeasureTargets(this.model);
      const hits = this.raycaster.intersectObjects(targets, false);
      for (const h of hits) {
        const r = resolveMeasurePick(h.object.userData);
        if (r) {
          this.onMeasurePick?.(this.buildMeasurementPick(h, r));
          return;
        }
      }
      return;
    }

    if (this.selectionMode === null) return; // guaranteed non-null by the guard above, but keeps TS narrowing honest
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

  /**
   * Builds a {@link MeasurementPick} from a raycast intersection: the
   * world-space hit point (discarded by the normal `onEntityPick` path, but
   * exactly what a distance/angle measurement needs) plus, when applicable to
   * the picked entity kind, a world-space direction (face normal via the
   * intersection's local-space `face.normal` + normal matrix, or edge tangent
   * from the two polyline points straddling the hit) and the picked edge's
   * full world-space polyline (for edge length / radius).
   */
  private buildMeasurementPick(h: THREE.Intersection, r: PickResult): MeasurementPick {
    const point: [number, number, number] = [h.point.x, h.point.y, h.point.z];
    let direction: [number, number, number] | null = null;
    let polyline: Float32Array | null = null;

    if (r.entityType === "surface" && h.face) {
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(h.object.matrixWorld);
      const n = h.face.normal.clone().applyMatrix3(normalMatrix).normalize();
      direction = [n.x, n.y, n.z];
    } else if (r.entityType === "line") {
      const line = h.object as THREE.Line;
      const pos = line.geometry.getAttribute("position");
      const world = new Float32Array(pos.count * 3);
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(line.matrixWorld);
        world[i * 3] = v.x;
        world[i * 3 + 1] = v.y;
        world[i * 3 + 2] = v.z;
      }
      polyline = world;

      if (typeof h.index === "number" && pos.count >= 2) {
        const i0 = Math.max(0, Math.min(h.index, pos.count - 2));
        const a = new THREE.Vector3(world[i0 * 3], world[i0 * 3 + 1], world[i0 * 3 + 2]);
        const b = new THREE.Vector3(world[(i0 + 1) * 3], world[(i0 + 1) * 3 + 1], world[(i0 + 1) * 3 + 2]);
        const t = b.clone().sub(a).normalize();
        direction = [t.x, t.y, t.z];
      }
    }

    return { point, entityType: r.entityType, entityId: r.entityId, direction, polyline };
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
