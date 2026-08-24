import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import * as cam from "./cameraControls";
import type { ViewerCamera } from "./cameraControls";
import { OrientationCube } from "./orientationCube";
import { collectTargets, resolvePick, collectMeasureTargets, resolveMeasurePick, type PickResult } from "./picking";
import { DEFAULT_EDGE_COLOR, DEFAULT_FACE_COLOR, DEFAULT_POINT_COLOR } from "./geometryBuilder";
import { capCenterAndSize } from "./clipping";
import { buildClipCap, repositionClipCap, disposeClipCap } from "./clipCap";
import {
  makeMeasureLabelSprite,
  makeMeasureMarkerSprite,
  buildMeasureLine,
  disposeMeasureObject,
} from "./measurementOverlay";
import type { MeasurementPick } from "./measurementState";
import { drawLabel } from "./labelOverlay";
import { compositeCanvas } from "./canvasComposite";
import { type DisplayMode } from "./displayMode";
import {
  computePaneRects,
  glViewportForPane,
  ndcInPane,
  paneAtPoint,
  type PaneLayoutId,
  type PaneRect,
  paneCount,
} from "./viewerPanes";
import type { EntityType, PaneViewState } from "../protocol";
import type { SelectedEntity } from "./selection";
import type { UpAxis } from "../viewerDefaults";

/** Emissive tint applied to the transiently-selected entities. */
const SELECTION_COLOR = 0x3b82f6;

/**
 * One split-view pane's private state (roadmap "Split view", Phase 1): its
 * own perspective/orthographic camera pair (swapped per-pane by the
 * Persp/Ortho toggle — the projection mode is per-pane, like direction/up/
 * zoom), its own `OrbitControls` instance, and its own last-framed ortho
 * half-height. Everything else in the viewer (scene, model, overlays,
 * selection, clip plane, display mode) is deliberately GLOBAL — only camera
 * state is per-pane, per the roadmap's own scoping.
 */
interface PaneState {
  persp: THREE.PerspectiveCamera;
  ortho: THREE.OrthographicCamera;
  active: ViewerCamera;
  controls: OrbitControls;
  /** This pane's ortho camera's last-framed half-height (world units, before
   * zoom) — `framePane` sets it, `applyPaneAspect` reuses it to recompute
   * `left/right/top/bottom` for a new aspect ratio without a full reframe. */
  orthoHalfHeight: number;
}

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
  /** One `PaneState` per pane of the current {@link layout} — length 1 or 4
   * in Phase 1. Index 0 always exists; `focusedPane` selects which one every
   * no-argument camera API (fitView/resetView/orbit/pan/dolly/getViewDirection/
   * setOrthographic/…) acts on, so `main.ts`'s ~30 existing call sites keep
   * their exact semantics ("the view" = the focused pane) unchanged. */
  private panes: PaneState[];
  /** Index into {@link panes} of the pane every camera-affecting API targets
   * and into which the orientation cube renders. Moved by clicking a pane
   * (the capture-phase gate listener), never by hovering. */
  private focusedPane = 0;
  /** The active layout — `"1x1"` (the fresh-viewer default, which is what
   * keeps `renderService.ts`'s headless harness, which posts no layout
   * message, rendering exactly one full-canvas view) or `"2x2"`. */
  private layout: PaneLayoutId = "1x1";
  /** Each pane's rect in CSS pixels (top-left origin), recomputed on resize
   * and layout change — the one source both the GL viewport/scissor math and
   * the pointer→pane mapping read. */
  private paneRects: PaneRect[];
  private readonly renderer: THREE.WebGLRenderer;
  /** The Transform Gizmo (roadmap "Transform gizmo", closed) — Three.js's own
   * `TransformControls`, not hand-rolled drag math. Named distinctly from
   * `this.gizmo` (the unrelated corner orientation cube) to avoid confusion. */
  private transformControls: TransformControls;
  /** Invisible, geometry-free — the gizmo's actual attach target; see the
   * "Transform gizmo" section below for why a dedicated proxy is used
   * instead of attaching directly to a real model object. */
  private readonly gizmoProxy = new THREE.Object3D();
  private readonly gizmoBasePosition = new THREE.Vector3();
  private onGizmoChange: (() => void) | null = null;
  private onGizmoDraggingChanged: ((dragging: boolean) => void) | null = null;
  private readonly grid: THREE.GridHelper;
  private readonly axes: THREE.AxesHelper;
  private readonly gizmo = new OrientationCube();
  private readonly gizmoSize = 96;
  private readonly gizmoMargin = 10;
  private model: THREE.Object3D | null = null;
  /** The generated FE-mesh overlay (if any) — a scene sibling of `model`, never a child. */
  private meshOverlay: THREE.Object3D | null = null;
  /** The worst-quality-elements highlight overlay (if any) — a scene sibling
   * of `model`/`meshOverlay`, built from a depth-test-disabled "ghost"
   * material so it paints through occluding geometry. See
   * `setWorstElementsOverlay`. */
  private worstElementsOverlay: THREE.Object3D | null = null;
  /** The "colour by scalar field" overlay (if any, meshio++ sources only) —
   * a scene sibling of `model`/`meshOverlay`. See `setColorFieldOverlay`. */
  private colorFieldOverlay: THREE.Object3D | null = null;
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
  /** The solid stencil-buffer cap over `activeClippingPlane`'s cross-section
   * (`null` when clipping is off, or nothing is currently clipped) — a scene
   * sibling of `model`, same pattern as `meshOverlay`/`hiddenLineGhosts`. See
   * `rebuildClipCap`/`updateClipCapPlane`. */
  private clipCap: THREE.Group | null = null;
  /** The single mutable `Plane` instance every clip-cap material's
   * `clippingPlanes` array references. An offset-slider drag or axis switch
   * mutates this IN PLACE (`updateClipCapPlane`) instead of rebuilding the
   * cap's meshes/materials from scratch on every `input` event, which would
   * needlessly alloc+dispose dozens of THREE objects per drag tick — only a
   * genuine STRUCTURAL change (which meshes are being capped) rebuilds for
   * real. */
  private clipCapPlane: THREE.Plane | null = null;
  /** The model+overlay bounding box `rebuildClipCap` computed the cap's
   * center/size from — cached so `updateClipCapPlane` can reuse it on every
   * cheap plane move instead of re-walking the model's geometry per tick. */
  private clipCapBox: THREE.Box3 | null = null;
  /** The Appearance panel's display mode — session-only, re-applied to every
   * fresh material on `setModel()`, same "materials carry no baseline state
   * on rebuild" rule as opacity/clipping. See `setDisplayMode()`. */
  private displayMode: DisplayMode = "shaded";
  /**
   * `false` until the very first `setModel()` call for this document session
   * (a fresh webview page is created per open document tab, so this is a
   * reliable "has anything ever been displayed yet" signal). Distinguishes
   * the document's genuine first load from every subsequent `setModel()`
   * call, which also fires on every edit-driven re-tessellation (`case
   * "geometry":`) or mesh rebuild (`rebuildMeshModel`) in `main.ts` — camera
   * position used to unconditionally reset on EVERY one of those too, a
   * bigger, more-repeated friction than the roadmap item's literal "resets
   * on reopen" framing (roadmap "View-state persistence", closed). See its
   * use in `setModel()` below.
   */
  private hasModelEverLoaded = false;
  /** Hidden-lines-visible mode's dimmed, depth-test-disabled copies of every
   * edge line — a scene sibling of `model` (never a child, same pattern as
   * `meshOverlay`/`measurementOverlay`), built on demand and torn down the
   * moment the mode changes or the model reloads. See `setDisplayMode()`. */
  private hiddenLineGhosts: THREE.Group | null = null;
  /** The Markup annotation overlay's `<canvas>` (owned/drawn-to by
   * `main.ts`'s `setupMarkupControls()` — `Viewer` only needs a reference to
   * composite it into a screenshot; see `captureScreenshotBase64()`). `null`
   * until `setMarkupCanvas()` is called once at webview setup. */
  private markupCanvas: HTMLCanvasElement | null = null;

  constructor(private readonly container: HTMLElement) {
    const width = container.clientWidth;
    const height = container.clientHeight;

    this.scene.background = new THREE.Color(0x1e1e1e);

    // `stencil: true` is required for the clip-cap technique (`clipCap.ts`) —
    // this three.js version's WebGLRenderer defaults it to `false`, unlike
    // older versions; without it the stencil-marking passes are silent
    // no-ops and clipping falls back to looking uncapped/hollow.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(width, height);
    container.appendChild(this.renderer.domElement);

    this.paneRects = computePaneRects(this.layout, width, height);
    this.panes = [this.makePane(this.paneRects[0])];

    // Rotate mode operates in world space to match the `rotate` edit op's own
    // `axisPoint`/`axisDir` fields, which are world coordinates, not local to
    // whichever proxy object the gizmo happens to be attached to.
    this.transformControls = new TransformControls(this.panes[0].active, this.renderer.domElement);
    this.transformControls.setSpace("world");
    // The helper starts invisible (TransformControlsRoot's own default) and
    // attach()/detach() toggle it automatically — nothing to do here.
    this.scene.add(this.transformControls.getHelper());
    // `"dragging-changed"` isn't a literal string anywhere in this three.js
    // version's source — verified against the installed source (not assumed
    // from memory/docs) that it's still real: `dragging` is registered via
    // this class's generic `defineProperty(propName, default)` helper, whose
    // setter unconditionally dispatches `{type: propName + '-changed', value}`
    // on every value change, so assigning `this.dragging = true/false`
    // internally (on pointerdown/pointerup) does genuinely fire this event
    // with a real boolean `.value` payload — the standard three.js integration
    // pattern documented for TransformControls still applies unchanged here.
    this.transformControls.addEventListener("dragging-changed", (event) => {
      const dragging = event.value as boolean;
      // Standard three.js integration: suspend orbit while the gizmo is
      // being dragged so the two controls don't fight over the same drag.
      // With split view there are N controls — suspend ALL of them (a gizmo
      // drag is focused-pane interaction; any other pane's orbit would fight
      // over the same pointer). Restored per-pane by the next gate event.
      for (const pane of this.panes) pane.controls.enabled = !dragging;
      this.onGizmoDraggingChanged?.(dragging);
    });
    this.transformControls.addEventListener("objectChange", () => this.onGizmoChange?.());
    this.scene.add(this.gizmoProxy);
    this.syncTransformControlsToFocus();

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.0));
    const dir = new THREE.DirectionalLight(0xffffff, 1.5);
    dir.position.set(1, 1, 1);
    this.scene.add(dir);

    this.grid = new THREE.GridHelper(10, 10, 0x888888, 0x444444);
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(1);
    this.scene.add(this.axes);

    // Capture phase, registered BEFORE the cube's own capture listener so the
    // pane gate (focus + per-pane OrbitControls enable) has run before either
    // the cube hit-test or OrbitControls' bubble handlers see the event.
    this.renderer.domElement.addEventListener("pointerdown", this.onGatePointerDown, true);
    this.renderer.domElement.addEventListener("wheel", this.onGateWheel, { capture: true, passive: true });
    // Capture-phase so a face click is handled before OrbitControls starts a drag.
    this.renderer.domElement.addEventListener("pointerdown", this.onGizmoPointerDown, true);
    // Entity picking: select on a click (down+up without a drag) so orbit still works.
    this.renderer.domElement.addEventListener("pointerdown", this.onSelectPointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.onSelectPointerUp);
    window.addEventListener("resize", this.onResize);
    this.animate();
  }

  // ── Split-view pane management (roadmap "Split view", Phase 1) ──────────

  /** The focused pane — the target of every no-argument camera API below. */
  private get pane(): PaneState {
    return this.panes[this.focusedPane];
  }
  /** The focused pane's current camera (persp or ortho, per its own toggle
   * state) — the same role the old single `activeCamera` field played. */
  private get activeCamera(): ViewerCamera {
    return this.pane.active;
  }
  /** The focused pane's OrbitControls. Note the per-event pane gate
   * ({@link onGatePointerDown}) is what makes N of these coexist: only the
   * hovered pane's instance is enabled when a drag/wheel starts. */
  private get controls(): OrbitControls {
    return this.pane.controls;
  }

  /** Builds a fresh pane sized for `rect` — its own camera pair (positioned
   * at the same (5,5,5) seed the original single camera used) and its own
   * OrbitControls. Aspect/frustum come from the rect, not the container. */
  private makePane(rect: PaneRect): PaneState {
    const aspect = rect.width / rect.height;
    const persp = new THREE.PerspectiveCamera(45, aspect, 0.01, 1e6);
    persp.position.set(5, 5, 5);
    const orthoHalfHeight = 5;
    const ortho = new THREE.OrthographicCamera(
      -orthoHalfHeight * aspect,
      orthoHalfHeight * aspect,
      orthoHalfHeight,
      -orthoHalfHeight,
      0.01,
      1e6
    );
    ortho.position.set(5, 5, 5);
    const controls = new OrbitControls(persp, this.renderer.domElement);
    controls.enableDamping = true;
    // Panes created after `onViewChanged` was first called must subscribe the
    // already-registered callbacks too, or their camera movements would never
    // autosave — see `onViewChanged`'s doc comment.
    for (const cb of this.viewChangeCallbacks) controls.addEventListener("change", cb);
    const pane: PaneState = { persp, ortho, active: persp, controls, orthoHalfHeight };
    this.applySpeedCompensation(pane, rect);
    return pane;
  }

  /**
   * Recomputes one pane's projection frusta from its rect's aspect ratio —
   * the per-pane generalization of what `onResize` did for the single pair.
   * Ortho `left/right` derive from the pane's own `orthoHalfHeight × aspect`,
   * so each pane's frustum is independent (a tall pane and a wide pane show
   * the same vertical extent at the same zoom, as a quad view should).
   */
  private applyPaneAspect(index: number): void {
    const pane = this.panes[index];
    const rect = this.paneRects[index];
    const aspect = rect.width / rect.height;
    pane.persp.aspect = aspect;
    pane.persp.updateProjectionMatrix();
    pane.ortho.left = -pane.orthoHalfHeight * aspect;
    pane.ortho.right = pane.orthoHalfHeight * aspect;
    pane.ortho.top = pane.orthoHalfHeight;
    pane.ortho.bottom = -pane.orthoHalfHeight;
    pane.ortho.updateProjectionMatrix();
  }

  /**
   * Compensates OrbitControls' full-canvas sensitivity denominator for a
   * sub-viewport pane. OrbitControls divides drag deltas by the ELEMENT's
   * `clientHeight`/`clientWidth` (verified against the installed
   * `OrbitControls.js` — it has no viewport support, unlike TransformControls),
   * so a quadrant's drag would rotate/pan ~2× slower than the visual arc
   * suggests. `rotateSpeed`/`panSpeed` multiply the same terms, so setting
   * both to `canvasHeight / paneHeight` cancels the denominator exactly.
   * Exact for the uniform layouts Phase 1 ships (`1×1` → 1, `2×2` → 2) and for
   * rotation + perspective pan in the 1×2 variants (both divide by
   * `clientHeight`, which equals the pane height in `1×2` and needs
   * `canvasHeight/paneHeight` in `2×1`). Stops being exact for **orthographic
   * pan** in non-square pane layouts: ortho's horizontal pan divides by
   * `clientWidth` while the factor here only corrects for height. Concretely
   * `1×2` (half-width, full-height) leaves ortho horizontal pan ~2× slow;
   * `2×1` (full-width, half-height) leaves it ~2× fast. One `panSpeed` scalar
   * cannot express per-axis factors, so this height-based factor is kept as the
   * best single compromise — rotation (the primary interaction) and perspective
   * pan stay exact.
   */
  private applySpeedCompensation(pane: PaneState, rect: PaneRect): void {
    const canvasHeight = this.renderer.domElement.clientHeight || rect.height;
    const factor = rect.height >= canvasHeight ? 1 : canvasHeight / rect.height;
    pane.controls.rotateSpeed = factor;
    pane.controls.panSpeed = factor;
  }

  /** Points `TransformControls` at the focused pane: its `.camera` is a
   * reassignable accessor (verified against the installed three.js source),
   * and its `viewport` property — a `Vector4` in CSS pixels, bottom-left
   * origin — is natively honored by its internal `getPointer()` NDC math
   * (verified against the installed source), which is what makes gizmo
   * interaction correct inside a scissored sub-viewport with zero hacks. */
  private syncTransformControlsToFocus(): void {
    this.transformControls.camera = this.pane.active;
    const vp = glViewportForPane(this.paneRects[this.focusedPane], this.renderer.domElement.clientHeight);
    this.transformControls.viewport = new THREE.Vector4(vp.x, vp.y, vp.width, vp.height);
  }

  /** Moves focus to `index` — retargets the transform gizmo and notifies the
   * wiring layer (which re-syncs UI that reflects focused-pane state, e.g.
   * the Persp/Ortho button label). No-op when already focused. */
  setFocusedPane(index: number): void {
    if (index === this.focusedPane || index < 0 || index >= this.panes.length) return;
    this.focusedPane = index;
    this.syncTransformControlsToFocus();
    this.onFocusChangedCallback?.(index);
  }

  private onFocusChangedCallback: ((index: number) => void) | null = null;
  /** Registers a callback fired when the focused pane changes (a click in a
   * different pane). `main.ts` uses it to keep the Ortho button's label
   * truthful — projection is per-pane, so a new focus may need the other
   * label even though the user clicked no projection control. */
  onFocusChanged(callback: (index: number) => void): void {
    this.onFocusChangedCallback = callback;
  }

  /** The active layout id. */
  getPaneLayout(): PaneLayoutId {
    return this.layout;
  }

  /**
   * Switches between layouts (Phase 1: `"1x1"` ⇄ `"2x2"`; Phase 2 adds
   * `"1x2"` (two side-by-side columns) and `"2x1"` (two stacked rows)). The
   * FOCUSED pane's `PaneState` survives unchanged in both directions —
   * collapsing keeps exactly what the user was looking at; expanding seeds
   * every new pane with a copy of the focused view (all panes start
   * identical, then orbit independently).
   */
  setPaneLayout(layout: PaneLayoutId): void {
    if (layout === this.layout) return;
    const el = this.renderer.domElement;
    this.layout = layout;
    this.paneRects = computePaneRects(layout, el.clientWidth, el.clientHeight);
    const keep = this.panes[this.focusedPane];
    for (const pane of this.panes) if (pane !== keep) pane.controls.dispose();
    this.panes = [keep];
    this.focusedPane = 0;
    for (let i = 1; i < paneCount(layout); i++) {
      const pane = this.makePane(this.paneRects[i]);
      this.inheritCameraState(pane, keep);
      this.panes.push(pane);
    }
    for (let i = 0; i < this.panes.length; i++) this.applyPaneAspect(i);
    this.syncTransformControlsToFocus();
  }

  /** Copies `src`'s full camera state (both projections, up vectors, near/far,
   * ortho zoom/frustum height, orbit target) into `dst`, then orients dst's
   * controls. Used when a layout change creates panes — every new pane starts
   * as an exact copy of the focused view. */
  private inheritCameraState(dst: PaneState, src: PaneState): void {
    for (const [d, s] of [
      [dst.persp, src.persp],
      [dst.ortho, src.ortho],
    ] as const) {
      d.position.copy(s.position);
      d.up.copy(s.up);
      d.near = s.near;
      d.far = s.far;
    }
    dst.orthoHalfHeight = src.orthoHalfHeight;
    dst.ortho.zoom = src.ortho.zoom;
    dst.active = src.active === src.ortho ? dst.ortho : dst.persp;
    dst.controls.target.copy(src.controls.target);
    dst.controls.update();
  }

  /** Per-pane camera states — one entry per pane of the current layout, row-major. */
  getPaneViewStates(): PaneViewState[] {
    return this.panes.map((pane) => ({
      viewDirection: cam.viewDirection(pane.active, pane.controls.target).toArray() as [number, number, number],
      cameraUp: pane.active.up.clone().toArray() as [number, number, number],
      orthographic: pane.active instanceof THREE.OrthographicCamera,
    }));
  }

  /**
   * Applies `state`'s camera direction/up/ortho to pane `index` — the per-pane
   * primitive `main.ts`'s split-view restore (`applyViewState`) uses. On a
   * missing model this still records the desired direction/up/ortho (via
   * `setPaneOrthographic` + up copy), and `framePane` no-ops on the empty box;
   * the pane's stored state is then correct once a model later loads and
   * `fitAllPanes`/`framePane` is called with the same direction. Both camera
   * objects' `up` vectors are written so a later `setOrthographic` toggle
   * doesn't reveal a stale up on the inactive camera (the trap
   * `setOrthographic`'s own doc records).
   */
  applyPaneCameraState(index: number, state: PaneViewState): void {
    if (index < 0 || index >= this.panes.length) return;
    const pane = this.panes[index];
    const up = new THREE.Vector3(...state.cameraUp);
    // Keep both cameras' up vectors in sync — the inactive one will be swapped to later.
    pane.persp.up.copy(up);
    pane.ortho.up.copy(up);
    if (state.orthographic !== (pane.active instanceof THREE.OrthographicCamera)) {
      this.setPaneOrthographic(index, state.orthographic);
    }
    // `framePane` derives distance/frustum from the model's bbox, so the
    // persisted direction alone is sufficient — position/target are recomputed.
    if (this.model) {
      this.framePane(index, new THREE.Vector3(...state.viewDirection));
    } else {
      // No model yet: ensure the pane's active camera's up matches, even though
      // framing will happen later once `setModel` provides a box.
      pane.active.up.copy(up);
    }
    // Keep the gizmo pointed at the focused pane's camera; cheap to call even
    // when the changed pane isn't focused.
    if (index === this.focusedPane) this.syncTransformControlsToFocus();
  }

  /** Per-pane projection toggle — the indexed form of {@link setOrthographic}. */
  private setPaneOrthographic(index: number, enabled: boolean): void {
    const pane = this.panes[index];
    const next: ViewerCamera = enabled ? pane.ortho : pane.persp;
    if (next === pane.active) return;
    const prev = pane.active;
    next.position.copy(prev.position);
    next.near = prev.near;
    next.far = prev.far;
    next.up.copy(prev.up);
    const dir = cam.viewDirection(prev, pane.controls.target);
    pane.active = next;
    pane.controls.object = next;
    if (index === this.focusedPane) this.syncTransformControlsToFocus();
    if (this.model) this.framePane(index, dir);
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
    this.setWorstElementsOverlay(null);
    this.setColorFieldOverlay(null);
    this.clearMeasurementOverlay();
    this.clearModel();
    this.model = object;
    // Z-up source data displayed in this Three.js (Y-up) scene: rotate the model
    // ROOT, not THREE.Object3D.DEFAULT_UP (a static shared by every Object3D,
    // including the gizmo/helpers) — resetView()'s isometric direction is
    // defined in the camera's fixed Y-up world frame and stays meaningful either way.
    object.rotation.x = this.upAxis === "z" ? -Math.PI / 2 : 0;
    this.applyDisplayMode();
    this.scene.add(object);
    this.applyClippingPlane(); // fresh model materials carry no clipping state yet
    this.rebuildClipCap(); // fresh geometry — a no-op if clipping is currently off
    if (this.hasModelEverLoaded) {
      this.fitAllPanes(); // an edit-driven rebuild: preserve every pane's own view direction
    } else {
      this.hasModelEverLoaded = true;
      // Genuine first load: the caller (`main.ts`'s `applyInitialViewIfNeeded`)
      // applies either the persisted view state or the default isometric,
      // once the "viewState" sidecar message has arrived — no
      // resetView()/fitView() call here, so a persisted direction is never
      // framed-then-immediately-reframed.
    }
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
    this.clearHiddenLineGhosts(); // references the model's edge geometries, about to be disposed
    this.clearClipCap(); // ditto — its stencil markers reference the model's face geometries
    this.scene.remove(this.model);
    this.model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
      // Display-mode's Flat/Shaded material pair — dispose whichever one ISN'T
      // the currently-active `mat` already disposed above, so a mode never
      // used this session (or used and left behind) doesn't leak.
      const std = mesh.userData.standardMaterial as THREE.Material | undefined;
      const flat = mesh.userData.flatMaterial as THREE.Material | undefined;
      if (std && std !== mat) std.dispose();
      if (flat && flat !== mat) flat.dispose();
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
    this.clearClipCap(); // its stencil markers may reference the old overlay's geometry, about to be disposed
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
    this.refreshModelFacesVisibility();
    this.rebuildClipCap(); // overlay content/visibility changed — a no-op if clipping is off
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
    this.refreshModelFacesVisibility();
    this.rebuildClipCap(); // which content is capped just flipped — a no-op if clipping is off
  }

  /**
   * Replaces the "colour by scalar field" overlay (roadmap item, closed) —
   * disposes the previous one's geometry/material and removes it from the
   * scene, same dispose/replace pattern as `setMeshOverlay`. Pass `null` to
   * just clear it (e.g. picking "None" in the field selector, or a fresh
   * model load). Composes with `setMeshOverlay`/`setMeshOverlayVisible` via
   * `refreshModelFacesVisibility()` rather than unconditionally hiding/
   * showing the model's faces itself — either overlay being shown hides the
   * model's own faces, and both must independently clear before they
   * reappear (see that method's doc comment).
   */
  setColorFieldOverlay(obj: THREE.Object3D | null): void {
    if (this.colorFieldOverlay) {
      this.scene.remove(this.colorFieldOverlay);
      this.colorFieldOverlay.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      });
      this.colorFieldOverlay = null;
    }
    if (obj) {
      this.colorFieldOverlay = obj;
      this.scene.add(obj);
      this.applyClippingPlane();
    }
    this.refreshModelFacesVisibility();
    this.rebuildClipCap();
  }

  /**
   * Replaces the worst-quality-elements highlight overlay — disposes the
   * previous one's geometry/material and removes it from the scene (a
   * sibling of `model`/`meshOverlay`, never a child), same dispose/replace
   * pattern as `setMeshOverlay`. Deliberately independent of `meshOverlay`'s
   * own lifecycle otherwise (not auto-cleared by `setMeshOverlay(null)`) —
   * every call site that clears/replaces the FE-mesh overlay (a fresh
   * Generate, the panel's Clear button) is expected to also call this
   * explicitly with the matching new/absent highlight, the same way
   * `main.ts` already keeps `meshingEnabled`'s toggle state in sync
   * alongside `setMeshOverlay` rather than `Viewer` inferring it internally.
   */
  setWorstElementsOverlay(obj: THREE.Object3D | null): void {
    if (this.worstElementsOverlay) {
      this.scene.remove(this.worstElementsOverlay);
      this.worstElementsOverlay.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      });
      this.worstElementsOverlay = null;
    }
    if (obj) {
      this.worstElementsOverlay = obj;
      this.scene.add(obj);
      this.applyClippingPlane(); // fresh overlay material carries no clipping state yet
    }
  }

  /** Shows/hides the *current* highlight overlay in place, without disposing
   * it — the panel's "Highlight worst elements" toggle. A no-op if nothing
   * has been generated (or nothing scored below the quality threshold). */
  setWorstElementsOverlayVisible(visible: boolean): void {
    if (!this.worstElementsOverlay) return;
    this.worstElementsOverlay.visible = visible;
  }

  /** Shows/hides the model's shaded face meshes (`entityType === "surface"`), leaving edges/points untouched. */
  private setModelFacesVisible(visible: boolean): void {
    this.model?.traverse((obj) => {
      if (obj.userData.entityType === "surface") obj.visible = visible;
    });
  }

  /**
   * Recomputes whether the model's shaded faces should be visible from
   * scratch, based on every overlay that competes for the same space
   * (`meshOverlay`, `colorFieldOverlay`) — hidden whenever ANY of them is
   * currently shown (exists AND `.visible`), restored only once none are.
   * Centralizing this (rather than each overlay unconditionally calling
   * `setModelFacesVisible` itself, which is how `meshOverlay` alone used to
   * work before `colorFieldOverlay` existed) is what lets the two compose
   * correctly: one overlay's own set/clear/toggle can no longer stomp on
   * the other's "hide the faces" state.
   */
  private refreshModelFacesVisibility(): void {
    const meshOverlayShown = this.meshOverlay !== null && this.meshOverlay.visible;
    const colorFieldShown = this.colorFieldOverlay !== null && this.colorFieldOverlay.visible;
    this.setModelFacesVisible(!meshOverlayShown && !colorFieldShown);
  }

  /**
   * Frames the current model (or the scene) within pane `index` along
   * `direction`. The per-pane generalization of the old single-`frame()`: the
   * camera pair, ortho half-height, frustum aspect (from the PANE's rect, not
   * the container's) and orbit target it touches are all pane-scoped. The
   * model-derived helpers (grid/axes scale, pick threshold, point-sprite
   * scale) stay global — they're functions of the model, identical for every
   * pane, so re-setting them per pane is idempotent, not a conflict.
   */
  private framePane(index: number, direction: THREE.Vector3): void {
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

    const pane = this.panes[index];
    const camera = pane.active;
    const dir = direction.clone().normalize();
    if (camera instanceof THREE.OrthographicCamera) {
      // Parallel projection: apparent size comes from the frustum/zoom, not
      // distance — pick a distance just far enough to keep near/far sane, and
      // size the frustum from the model radius with the same 1.5x margin
      // perspective's fov-based distance uses.
      const distance = radius * 3;
      pane.orthoHalfHeight = radius * 1.5;
      const aspect = this.paneRects[index].width / this.paneRects[index].height;
      camera.left = -pane.orthoHalfHeight * aspect;
      camera.right = pane.orthoHalfHeight * aspect;
      camera.top = pane.orthoHalfHeight;
      camera.bottom = -pane.orthoHalfHeight;
      camera.zoom = 1;
      camera.position.copy(center).addScaledVector(dir, distance);
      camera.near = distance / 100;
      camera.far = distance * 100;
    } else {
      const fov = (camera.fov * Math.PI) / 180;
      const distance = (radius / Math.sin(fov / 2)) * 1.5;
      camera.position.copy(center).addScaledVector(dir, distance);
      camera.near = distance / 100;
      camera.far = distance * 100;
    }
    camera.updateProjectionMatrix();
    pane.controls.target.copy(center);
    pane.controls.update();
  }

  /** Frames the model keeping the focused pane's current viewing orientation. */
  fitView(): void {
    this.framePane(this.focusedPane, this.getViewDirection());
  }

  /**
   * Re-frames EVERY pane along its own current orientation — the split-view
   * generalization of the edit-driven-rebuild `fitView()` call in
   * `setModel()`: a model that grew or shrank must stay framed in all panes,
   * each keeping its own view direction (a quad view where three panes clip
   * the new bounds would be broken).
   */
  private fitAllPanes(): void {
    for (let i = 0; i < this.panes.length; i++) {
      const pane = this.panes[i];
      this.framePane(i, cam.viewDirection(pane.active, pane.controls.target));
    }
  }

  /**
   * Frames the model along an arbitrary view direction — the general form
   * `resetView()`'s hardcoded isometric now delegates to. Used to restore a
   * persisted `ViewState.viewDirection` on first load (`main.ts`'s
   * `applyInitialViewIfNeeded`), where — unlike `fitView()` — the desired
   * direction isn't the camera's current one.
   */
  frameFromDirection(direction: THREE.Vector3): void {
    this.framePane(this.focusedPane, direction);
  }

  /** Resets the FOCUSED pane to the default isometric orientation and frames the model. */
  resetView(): void {
    this.frameFromDirection(new THREE.Vector3(1, 0.8, 1));
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

  /** Whether `activeCamera` is currently the orthographic camera — the
   * single source of truth `main.ts`'s Persp/Ortho toggle and view-state
   * save/restore both read, rather than each maintaining their own boolean
   * that could drift from the real camera in use. */
  isOrthographic(): boolean {
    return this.activeCamera instanceof THREE.OrthographicCamera;
  }

  /** Sets the camera's up vector directly — needed by the headless
   * multi-view render service (`src/renderService.ts`) so a near-vertical
   * `setViewDirection` (e.g. a top view) doesn't produce a gimbal-lock-like
   * flip; interactive orbiting never needs this (three.js/OrbitControls
   * derive orientation from the existing up vector on their own). */
  setCameraUp(up: THREE.Vector3): void {
    this.activeCamera.up.copy(up);
    this.controls.update();
  }

  /**
   * Registers a callback for every camera movement in ANY pane — orbit/pan/
   * dolly (drag or the stepped toolbar buttons), `fitView`/`resetView`/
   * `frameFromDirection`, `setViewDirection`/`setCameraUp`, and
   * `setOrthographic`'s own re-frame — since every one of those ends in that
   * pane's `controls.update()`, which `OrbitControls` only actually
   * dispatches `"change"` for when the camera genuinely moved. The callback
   * is remembered in {@link viewChangeCallbacks} so panes created by a later
   * `setPaneLayout` are subscribed too — `main.ts`'s view-state autosave
   * (roadmap "View-state persistence", closed) registers exactly once at
   * startup, and without this a drag in a pane created after that point
   * would silently never autosave. It reads the FOCUSED pane in response,
   * which makes a non-focused pane's movement a harmless no-change save at
   * worst (the sidecar's content-compare watcher no-ops on identical
   * content).
   */
  private viewChangeCallbacks: (() => void)[] = [];
  onViewChanged(callback: () => void): void {
    this.viewChangeCallbacks.push(callback);
    for (const pane of this.panes) pane.controls.addEventListener("change", callback);
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
  /**
   * Toggles the FOCUSED pane between perspective and orthographic projection
   * (per-pane, like direction/up/zoom — the roadmap's own Phase-1 scoping).
   * NOT a reconstruction — each pane's `ortho` camera is a second object kept
   * alive the whole session; this only swaps which one is that pane's
   * `active` (and which one its OrbitControls targets, via `controls.object`
   * — three.js supports retargeting at runtime, and `OrbitControls`' own
   * dolly/zoom logic already branches on `camera.isPerspectiveCamera`/
   * `isOrthographicCamera`, so mouse-wheel zoom keeps working correctly
   * across the swap with no extra code). Copies position/near/far AND `up`
   * from the outgoing camera so neither the view nor the roll jumps (the up
   * copy matters since `setCameraUp` writes only the then-active camera —
   * without it, a restored orthographic TOP view would swap to a camera
   * still carrying the default up), then calls `framePane()` along the same
   * view direction to size the newly-active camera's fov-based distance
   * (perspective) or frustum/zoom (orthographic) correctly — `framePane()`
   * already contains that per-type logic, so this reuses it rather than
   * duplicating it.
   */
  setOrthographic(enabled: boolean): void {
    const pane = this.pane;
    const next: ViewerCamera = enabled ? pane.ortho : pane.persp;
    if (next === pane.active) return;
    const prev = pane.active;
    next.position.copy(prev.position);
    next.near = prev.near;
    next.far = prev.far;
    next.up.copy(prev.up);
    const dir = cam.viewDirection(prev, pane.controls.target);
    pane.active = next;
    pane.controls.object = next;
    // Retarget the transform gizmo (`.camera` is a reassignable accessor, and
    // `viewport` stays the focused pane's — both verified against the live
    // three.js source) — without this, the gizmo would keep raycasting
    // against the now-stale camera after the toggle.
    this.syncTransformControlsToFocus();
    this.framePane(this.focusedPane, dir);
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
    const xrayFactor = this.displayOpacityFactor();
    this.model?.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mat = obj.material as THREE.MeshStandardMaterial;
      const base = (mat.userData.baseOpacity as number | undefined) ?? 1;
      const selected = groupId === null || obj.userData.groupId === groupId;
      mat.opacity = base * xrayFactor * (selected ? 1 : 0.08);
      mat.transparent = mat.opacity < 1;
      mat.needsUpdate = true;
    });
  }

  /** Live, session-only background override — same "always wins once set"
   * precedent as `toggleGrid()` vs. `applyDefaults()`'s `showGridAndAxes`. */
  setBackground(hex: string): void {
    this.scene.background = new THREE.Color(hex);
  }

  /** The two edge-visibility toggles compose here rather than each writing
   * `.visible` directly — same "single writer, multiple inputs" discipline
   * `highlightGroup()`'s `baseOpacity` composition already established for
   * opacity, so `setEdgesVisible`/`setSmoothEdgesVisible` can't stomp on each
   * other regardless of click order. Like the pre-existing "Edges" toggle
   * this extends, neither survives a model rebuild on its own — a fresh
   * `THREE.Object3D` from `setModel()` starts every line visible, and
   * `main.ts`'s `refreshColors()` (called on every rebuild) does not
   * currently re-apply either; a known, pre-existing limitation of the
   * toggle this one mirrors, not a regression introduced here. */
  private edgesVisible = true;
  private smoothEdgesHidden = false;

  private applyEdgeVisibility(): void {
    this.model?.traverse((obj) => {
      if (obj.userData.entityType !== "line") return;
      obj.visible = this.edgesVisible && !(this.smoothEdgesHidden && obj.userData.smooth === true);
    });
  }

  /** Shows/hides every edge line, leaving faces and points untouched. */
  setEdgesVisible(visible: boolean): void {
    this.edgesVisible = visible;
    this.applyEdgeVisibility();
  }

  /**
   * Hides/shows edges classified `smooth` (tangent patch-seam continuations,
   * e.g. between adjacent NURBS patches of one conceptually-curved surface —
   * see `edgeEnumeration.ts`'s `classifyEdgeSmoothness`, roadmap "Display-edge
   * classification, as a flag", closed) while leaving genuine feature edges
   * alone. `visible: false` hides them (declutters patch seams); the default
   * is `true` (shown), matching every pre-existing document's current look —
   * this is an opt-in decluttering aid, not a default behavior change.
   */
  setSmoothEdgesVisible(visible: boolean): void {
    this.smoothEdgesHidden = !visible;
    this.applyEdgeVisibility();
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
   * The cut face is solid-filled via a stencil-buffer cap (`clipCap.ts`), not
   * left see-through/hollow. A structural rebuild (new target mesh set) only
   * happens when clipping is toggled on from off, or the model/overlay
   * changes; an axis switch or offset-slider drag — this method's highest-
   * frequency caller, firing on every `input` event — takes the cheap
   * `updateClipCapPlane` path instead, mutating the existing cap in place
   * rather than reallocating it every tick.
   */
  setClippingPlane(plane: THREE.Plane | null): void {
    this.activeClippingPlane = plane;
    this.renderer.localClippingEnabled = plane !== null;
    this.applyClippingPlane();
    if (plane && this.clipCap && this.clipCapPlane) this.updateClipCapPlane(plane);
    else this.rebuildClipCap();
  }

  /**
   * Full (re)build of the clip cap's stencil-marking meshes — one back/front
   * pair per currently-visible target mesh (`model`'s face meshes, plus the
   * FE-mesh overlay's fill mesh when it's the thing actually shown) — and the
   * cap quad itself. Called whenever WHICH meshes need capping could have
   * changed: clipping just turned on, or `model`/`meshOverlay` changed.
   *
   * Deliberately does NOT reactively track Parts/Components-tree per-entity
   * hide/isolate (`applyPartVisibility`/`setGroupVisible`, both of which set
   * `.visible` directly on the affected meshes with no hook into this class) —
   * a part hidden after the cap was last (re)built keeps showing its
   * cross-section until the next structural rebuild or plane move. Accepted,
   * not fixed: reactively tracking every visibility mutation site for a
   * display-only capping nicety was judged disproportionate complexity, the
   * same call this codebase already made for the FE-mesh overlay's
   * surface-scoped-part colouring gap and several other known, documented
   * edge cases (see CLAUDE.md's "Visualization & UX depth" section).
   */
  private rebuildClipCap(): void {
    this.clearClipCap();
    if (!this.activeClippingPlane || !this.model) return;

    // `matrixWorld` is only kept current by the render loop; force it here so
    // a rebuild triggered mid-frame (e.g. synchronously inside setModel(),
    // before the next animate() tick) still captures accurate transforms.
    this.model.updateMatrixWorld(true);
    this.meshOverlay?.updateMatrixWorld(true);
    this.colorFieldOverlay?.updateMatrixWorld(true);

    const targets: THREE.Mesh[] = [];
    this.model.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.userData.entityType === "surface" && obj.visible) targets.push(obj);
    });
    // Either overlay's own fill mesh, only when it's actually the thing being
    // shown — model faces are already hidden in that state (setModelFacesVisible),
    // so this and the branch above are naturally mutually exclusive in practice.
    if (this.meshOverlay?.visible) {
      this.meshOverlay.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj.userData.entityType === "mesh") targets.push(obj);
      });
    }
    if (this.colorFieldOverlay?.visible) {
      this.colorFieldOverlay.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj.userData.entityType === "mesh") targets.push(obj);
      });
    }
    if (targets.length === 0) return;

    const box = new THREE.Box3().setFromObject(this.model);
    if (this.meshOverlay?.visible) box.union(new THREE.Box3().setFromObject(this.meshOverlay));
    if (this.colorFieldOverlay?.visible) box.union(new THREE.Box3().setFromObject(this.colorFieldOverlay));
    if (box.isEmpty()) return;

    this.clipCapPlane = this.activeClippingPlane.clone();
    this.clipCapBox = box;
    const { center, size } = capCenterAndSize(this.clipCapPlane, box);
    this.clipCap = buildClipCap(targets, this.clipCapPlane, center, size, DEFAULT_FACE_COLOR);
    this.scene.add(this.clipCap);
  }

  /** Moves the existing cap to a new plane WITHOUT rebuilding its meshes —
   * see `setClippingPlane`'s doc comment for when this applies vs a full
   * `rebuildClipCap`. Reuses the bounding box `rebuildClipCap` cached, since
   * neither an axis switch nor an offset move changes the model's extents. */
  private updateClipCapPlane(plane: THREE.Plane): void {
    this.clipCapPlane!.copy(plane);
    if (!this.clipCap || !this.clipCapBox) return;
    const { center, size } = capCenterAndSize(this.clipCapPlane!, this.clipCapBox);
    repositionClipCap(this.clipCap.userData.capMesh as THREE.Mesh, this.clipCapPlane!, center, size);
  }

  private clearClipCap(): void {
    if (!this.clipCap) return;
    this.scene.remove(this.clipCap);
    disposeClipCap(this.clipCap);
    this.clipCap = null;
    this.clipCapPlane = null;
    this.clipCapBox = null;
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
    this.worstElementsOverlay?.traverse(apply);
    this.hiddenLineGhosts?.traverse(apply);
    this.colorFieldOverlay?.traverse(apply);
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

  // ── Transform gizmo (roadmap "Transform gizmo", closed) ─────────────────
  // Thin wrapper over three.js's own `TransformControls`, not hand-rolled
  // drag math. The gizmo is always attached to `this.gizmoProxy` — an
  // invisible, geometry-free pivot this class owns and keeps in the scene
  // graph permanently (so it always has a valid, auto-updated `matrixWorld`)
  // — never directly to a real model object, since a drag typically needs to
  // move a WHOLE selection (possibly several solids) as one rigid group
  // about their shared centroid, not just the one object TransformControls
  // natively supports attaching to. `main.ts` owns the actual per-target math
  // (resolving `node-N`/`solid-N` ids to live objects, applying each
  // target's share of {@link getGizmoDelta} to a captured pristine base —
  // the exact never-compound-onto-the-previous-frame discipline
  // `explodePreview.ts` already established — and pushing the live values
  // into the open translate/rotate/scale form); this class only owns the
  // proxy object and the raw attach/detach/mode/delta/event surface.

  /** Repositions the (already-scene-resident) proxy to `pivot` with an
   * identity transform, then attaches the gizmo to it in `mode` — this reset
   * is what makes `getGizmoDelta()` below correct: since the proxy's base is
   * ALWAYS position=pivot/quaternion=identity/scale=(1,1,1) at the moment of
   * attach, its CURRENT transform after any drag directly IS the delta,
   * with no separate "subtract the base" bookkeeping needed for rotation/
   * scale (only position needs the pivot subtracted back out). */
  attachTransformGizmo(pivot: THREE.Vector3, mode: "translate" | "rotate" | "scale"): void {
    this.gizmoProxy.position.copy(pivot);
    this.gizmoProxy.quaternion.identity();
    this.gizmoProxy.scale.set(1, 1, 1);
    this.gizmoBasePosition.copy(pivot);
    this.transformControls.setMode(mode);
    this.transformControls.attach(this.gizmoProxy);
  }

  /** Detaches the gizmo, hiding it. Safe to call even when nothing is attached. */
  detachTransformGizmo(): void {
    this.transformControls.detach();
  }

  /** True while the gizmo is actively being dragged — `onSelectPointerDown`/
   * `onSelectPointerUp` check this to avoid also firing an entity pick for
   * the same pointer interaction. */
  isGizmoDragging(): boolean {
    return this.transformControls.dragging;
  }

  /** The proxy's live transform relative to the base captured by the most
   * recent {@link attachTransformGizmo} call — `positionDelta` is the raw
   * world-space translation (pivot already subtracted out); `quaternionDelta`
   * and `scaleDelta` can be used directly (no subtraction needed) since the
   * proxy's base rotation/scale are always identity/(1,1,1) by construction.
   * `pivot` is the captured attach-time position, for callers that need the
   * rotation/scale centre (e.g. to push into the `rotate` op's `axisPoint`
   * or the `scale` op's `center` field). */
  getGizmoDelta(): { positionDelta: THREE.Vector3; quaternionDelta: THREE.Quaternion; scaleDelta: THREE.Vector3; pivot: THREE.Vector3 } {
    return {
      positionDelta: this.gizmoProxy.position.clone().sub(this.gizmoBasePosition),
      quaternionDelta: this.gizmoProxy.quaternion.clone(),
      scaleDelta: this.gizmoProxy.scale.clone(),
      pivot: this.gizmoBasePosition.clone(),
    };
  }

  /** Registers callbacks fired on every live change to the attached gizmo
   * object (mid-drag) and whenever a drag starts/stops. */
  setGizmoHandlers(onChange: () => void, onDraggingChanged: (dragging: boolean) => void): void {
    this.onGizmoChange = onChange;
    this.onGizmoDraggingChanged = onDraggingChanged;
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
    // Sprite scale defaults to 1 world unit — huge on a small (e.g. mm-scale)
    // model. Same proportional-to-model-radius sizing as point-mode vertex
    // sprites (`pointSpriteScale`, set in `frame()`), just a bit larger since
    // this marker is active pick feedback, not a passive vertex indicator.
    marker.scale.setScalar(this.pointSpriteScale * 3.0);
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
        const mat = obj.material as THREE.Material;
        // Flat mode's MeshBasicMaterial has no `.emissive` (unlike the
        // standard shaded material) — fall back to the same direct-colour
        // swap technique edges/points already use for selection.
        if ("emissive" in mat) {
          (mat as THREE.MeshStandardMaterial).emissive.setHex(on ? SELECTION_COLOR : 0x000000);
        } else {
          const base = (ud.baseColor as number | undefined) ?? DEFAULT_FACE_COLOR;
          (mat as THREE.MeshBasicMaterial).color.setHex(on ? SELECTION_COLOR : base);
        }
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

  /**
   * Whether an entity currently exists in the loaded model — the "detached"
   * check for a persisted {@link Annotation} (roadmap "Persisted,
   * topology-anchored annotations", closed): its anchor ids are rebound
   * best-effort across topology-changing edits, and a genuinely-unresolved
   * one is dropped from its id arrays by the host, so a mesh-format source
   * with no rebind engine (or a race before the next rebind pass) is exactly
   * why the webview double-checks here rather than trusting the arrays are
   * always current.
   */
  hasEntity(entityType: EntityType, entityId: string): boolean {
    if (!this.model) return false;
    let found = false;
    this.model.traverse((obj) => {
      if (found) return;
      if (obj.userData.entityType === entityType && obj.userData.entityId === entityId) found = true;
    });
    return found;
  }

  /** Forces an immediate render of the current frame (used right before a
   * screenshot capture). Renders EVERY pane — in split mode a screenshot is
   * the whole grid (the roadmap's stated reading: the canvas is one surface);
   * in the default 1×1 layout that is exactly the single full-canvas view
   * `renderService.ts`'s headless harness captures. */
  render(): void {
    this.renderFrame();
  }

  /** Registers the Markup overlay's canvas so screenshots composite it in —
   * see `markupCanvas`'s doc comment. Pass `null` to stop compositing it
   * (not used today; the canvas is registered once at setup and left
   * registered, since an empty/untouched markup canvas composites as a
   * no-op transparent layer). */
  setMarkupCanvas(canvas: HTMLCanvasElement | null): void {
    this.markupCanvas = canvas;
  }

  /**
   * Captures the current framebuffer — with the Markup annotation overlay
   * composited on top, if any strokes exist (`canvasComposite.ts`) — as a
   * base64 PNG (no `data:` prefix). Callers should call {@link render}
   * immediately before this to guarantee a fresh frame — the renderer has no
   * persistent `preserveDrawingBuffer`, so `toDataURL` reads whatever was
   * drawn most recently.
   */
  captureScreenshotBase64(): string {
    const merged = compositeCanvas(this.renderer.domElement, this.markupCanvas);
    const dataUrl = merged.toDataURL("image/png");
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
  }

  /** Same as {@link captureScreenshotBase64} (markup composited in too), with
   * `label` burned into the top-left corner (`labelOverlay.ts`'s
   * `drawLabel`) — used by `renderViewRequest`'s handler for the headless
   * `render_snapshot` MCP tool, which returns several same-shaped images and
   * needs each one self-identifying. */
  captureLabeledScreenshotBase64(label: string): string {
    const merged = compositeCanvas(this.renderer.domElement, this.markupCanvas);
    const labeled = drawLabel(merged, label);
    const dataUrl = labeled.toDataURL("image/png");
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
  }

  setWireframe(on: boolean): void {
    this.wireframe = on;
    this.applyWireframe();
  }

  /** Flips the grid + axis helpers, returning their new visibility so callers
   *  (the View ▾ menu's checkable item) can reflect it without tracking it. */
  toggleGrid(): boolean {
    this.grid.visible = !this.grid.visible;
    this.axes.visible = this.grid.visible;
    return this.grid.visible;
  }

  isGridVisible(): boolean {
    return this.grid.visible;
  }

  private applyWireframe(): void {
    this.model?.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      const mat = mesh.material as (THREE.Material & { wireframe?: boolean }) | undefined;
      if (mat && "wireframe" in mat) mat.wireframe = this.wireframe;
    });
  }

  /** The Appearance panel's current display mode. */
  getDisplayMode(): DisplayMode {
    return this.displayMode;
  }

  /**
   * Switches the whole-model display mode (Shaded/Wireframe/X-Ray/Hidden
   * Lines/Flat) — session-only, like every other Appearance control. Colours
   * and the current selection highlight are NOT reapplied here (Flat mode's
   * material swap means the newly-active material starts at its default
   * colour/no-emissive-highlight) — callers MUST follow this with
   * `Viewer.setEntityColors()` + `Viewer.renderSelection()` (or `main.ts`'s
   * `refreshColors()`, which already does both) to restore them, exactly the
   * same "caller re-applies after a material-affecting change" contract
   * `setModel()` already relies on for parts/selection.
   */
  setDisplayMode(mode: DisplayMode): void {
    this.displayMode = mode;
    this.applyDisplayMode();
  }

  /**
   * Re-derives every face/edge material property from `displayMode`:
   * - **Flat** swaps `mesh.material` to a lazily-built, cached unlit
   *   `MeshBasicMaterial` (`userData.flatMaterial`); every other mode swaps
   *   back to the original `userData.standardMaterial` (captured once, on
   *   this method's first run for a given mesh, from whatever `mesh.material`
   *   already is at that point — always the true original, since this runs
   *   from `setModel()` before any mode switch could have swapped it).
   * - **Wireframe** drives the existing `wireframe`/`applyWireframe()`
   *   primitive (also used standalone by `render_snapshot`'s per-call
   *   `wireframe` override — see `renderService.ts` — so it stays a public
   *   method, not inlined here).
   * - **X-Ray**'s extra translucency is folded into `highlightGroup()`'s
   *   existing `baseOpacity` composition (see its doc comment) via
   *   `displayOpacityFactor()`, rather than a separate opacity writer.
   * - **Hidden Lines** builds/tears down `hiddenLineGhosts` (see
   *   `buildHiddenLineGhosts()`'s doc comment for the layering trick).
   */
  private applyDisplayMode(): void {
    const flat = this.displayMode === "flat";
    this.model?.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh) || obj.userData.entityType !== "surface") return;
      if (!obj.userData.standardMaterial) obj.userData.standardMaterial = obj.material;
      const std = obj.userData.standardMaterial as THREE.MeshStandardMaterial;
      if (!flat) {
        obj.material = std;
        return;
      }
      if (!obj.userData.flatMaterial) {
        obj.userData.flatMaterial = new THREE.MeshBasicMaterial({ color: std.color.getHex(), side: THREE.DoubleSide });
      }
      obj.material = obj.userData.flatMaterial as THREE.MeshBasicMaterial;
    });
    this.wireframe = this.displayMode === "wireframe";
    this.applyWireframe();
    this.applyOpacityBaseline();
    this.highlightGroup(this.highlightedGroupId);
    this.applyClippingPlane();
    if (this.displayMode === "hiddenLines") this.buildHiddenLineGhosts();
    else this.clearHiddenLineGhosts();
  }

  /** X-Ray's extra opacity multiplier, composed into `highlightGroup()`'s
   * `baseOpacity` formula — see `setDisplayMode()`'s doc comment. */
  private displayOpacityFactor(): number {
    return this.displayMode === "xray" ? 0.35 : 1;
  }

  /**
   * Hidden-lines-visible: a dimmed, always-visible-through-solids copy of
   * every edge line, layered so real geometry naturally produces the correct
   * "crisp where visible, faint where hidden" look with NO per-pixel
   * occlusion logic of our own:
   * - Ghosts share their real counterpart's geometry (never their own —
   *   nothing here disposes it) and use `transparent: true`, which three.js
   *   always renders in a separate pass strictly AFTER every opaque object
   *   (faces, and the real, depth-tested edges) — so a ghost is guaranteed to
   *   paint (faintly) over an already-fully-rendered frame, everywhere its
   *   line passes, regardless of true 3D depth.
   * - The real edge (unchanged, depth-tested, drawn in the opaque pass) then
   *   already correctly painted a full-strength line at every screen pixel
   *   where it is genuinely unoccluded — since the ghost pass runs after,
   *   the crisp real line was already down first there's nothing on top of
   *   it, so it stays visually dominant even though the ghost technically
   *   also draws a faint tint there.
   * - `depthTest: false` is what lets the ghost paint through occluding
   *   faces at all; `depthWrite: false` keeps it from perturbing the depth
   *   buffer for anything rendered after it.
   * A scene sibling of `model` (never a child, same pattern as
   * `meshOverlay`/`measurementOverlay`) so it's excluded from picking
   * (`collectTargets` only ever traverses `this.model`) with no extra
   * `raycast` override needed.
   */
  private buildHiddenLineGhosts(): void {
    this.clearHiddenLineGhosts();
    if (!this.model) return;
    const group = new THREE.Group();
    this.model.traverse((obj) => {
      if (obj instanceof THREE.Line && obj.userData.entityType === "line") {
        const ghostMaterial = new THREE.LineBasicMaterial({
          color: 0x8fa8c9,
          transparent: true,
          opacity: 0.35,
          depthTest: false,
          depthWrite: false,
        });
        group.add(new THREE.Line(obj.geometry, ghostMaterial));
      }
    });
    this.hiddenLineGhosts = group;
    this.scene.add(group);
    this.applyClippingPlane(); // fresh ghost materials carry no clipping state yet
  }

  private clearHiddenLineGhosts(): void {
    if (!this.hiddenLineGhosts) return;
    this.scene.remove(this.hiddenLineGhosts);
    this.hiddenLineGhosts.traverse((obj) => {
      // Ghost geometry is SHARED with the real edge line — never dispose it here.
      const mat = (obj as THREE.Line).material as THREE.Material | undefined;
      mat?.dispose();
    });
    this.hiddenLineGhosts = null;
  }

  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    this.renderer.domElement.removeEventListener("pointerdown", this.onGatePointerDown, true);
    this.renderer.domElement.removeEventListener("wheel", this.onGateWheel, { capture: true });
    this.renderer.domElement.removeEventListener("pointerdown", this.onGizmoPointerDown, true);
    this.renderer.domElement.removeEventListener("pointerdown", this.onSelectPointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.onSelectPointerUp);
    this.gizmo.dispose();
    this.clearModel();
    for (const pane of this.panes) pane.controls.dispose();
    this.transformControls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private onResize = (): void => {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.renderer.setSize(width, height);
    // Per-pane aspects from each pane's own rect (a quadrant's aspect differs
    // from the container's) — the split-view generalization of the old
    // single-pair resize. Also refreshes the transform gizmo's viewport,
    // whose rect moved with the resize.
    this.paneRects = computePaneRects(this.layout, width, height);
    for (let i = 0; i < this.panes.length; i++) {
      this.applyPaneAspect(i);
      this.applySpeedCompensation(this.panes[i], this.paneRects[i]);
    }
    this.syncTransformControlsToFocus();
  };

  /**
   * The split-view pane gate — a capture-phase `pointerdown`/`wheel` listener
   * that runs BEFORE OrbitControls' bubble-phase handlers (verified against
   * the installed `OrbitControls.js`: its `_onPointerDown` first line is
   * `if (this.enabled === false) return;`, and its listeners are registered
   * bubble-phase on the canvas). It computes which pane the pointer is over
   * and enables ONLY that pane's controls before any of them can react, so
   * N coexisting instances never all drive the same drag; a `pointerdown`
   * additionally moves focus there. Registered before the cube's own capture
   * listener so focus is current by the time the cube hit-test runs.
   */
  private onGatePointerDown = (event: PointerEvent): void => {
    this.gateToPane(event.clientX, event.clientY, true);
  };

  private onGateWheel = (event: WheelEvent): void => {
    this.gateToPane(event.clientX, event.clientY, false);
  };

  private gateToPane(clientX: number, clientY: number, updateFocus: boolean): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const index = paneAtPoint(this.paneRects, clientX - rect.left, clientY - rect.top);
    if (index < 0) return;
    if (updateFocus) this.setFocusedPane(index);
    for (let i = 0; i < this.panes.length; i++) {
      this.panes[i].controls.enabled = i === index;
    }
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    this.renderFrame();
  };

  /**
   * The one shared frame routine — used by both the animation loop and the
   * forced `render()` before captures. Draws every pane of the current
   * layout into its scissored region of the single canvas (the invariant
   * `orientationCube.ts` established: exactly one WebGL context — panes are
   * `setViewport`/`setScissor` regions, not contexts), then overlays the
   * orientation cube into the focused pane's corner. With the scissor test
   * enabled, each pane's `render()` clears color+depth+STENCIL within its
   * own region before drawing — which is also what keeps the clip-cap's
   * stencil marking isolated per pane (a pane's cap evaluation can never see
   * another pane's stencil values, and the gizmo overlay's depth-only clear
   * below never disturbs stencil).
   */
  private renderFrame(): void {
    const el = this.renderer.domElement;
    const cssW = el.clientWidth;
    const cssH = el.clientHeight;
    this.renderer.setScissorTest(true);
    for (let i = 0; i < this.panes.length; i++) {
      const pane = this.panes[i];
      pane.controls.update();
      // The measurement label is ONE shared sprite but its on-screen size is
      // camera-dependent — rescale it for whichever pane is about to render
      // (each pass recomputes it; the last pane's value simply lingers until
      // the next frame, invisible between passes).
      if (this.measurementLabel) this.rescaleMeasurementLabel(pane.active);
      const rect = this.paneRects[i];
      const vp = glViewportForPane(rect, cssH);
      this.renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
      this.renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
      this.renderer.render(this.scene, pane.active);
    }
    this.renderGizmo();
  }

  /** Constant on-screen label size regardless of zoom — recomputed per pane
   * per frame (unlike the point-sprite scale in `framePane()`, which only
   * updates on fit/reset), since a label specifically needs to stay legible
   * while continuously zooming. Under orthographic projection apparent size
   * is NOT distance-dependent (unlike perspective), so the scale instead
   * derives from the current frustum height / zoom. */
  private rescaleMeasurementLabel(camera: ViewerCamera): void {
    if (!this.measurementLabel) return;
    const s = camera instanceof THREE.OrthographicCamera
      ? ((camera.top - camera.bottom) / camera.zoom) * 0.06
      : camera.position.distanceTo(this.measurementLabel.position) * 0.06;
    this.measurementLabel.scale.set(s, s * 0.25, 1); // 4:1 label aspect ratio
  }

  /** Draws the orientation gizmo into the FOCUSED pane's top-left corner via
   * a scissor viewport. One cube total (not one per pane): its hit-test
   * (`onGizmoPointerDown`) is scoped to the same focused-pane square, so
   * what you see and what you can click always agree. */
  private renderGizmo(): void {
    const el = this.renderer.domElement;
    const cssW = el.clientWidth;
    const cssH = el.clientHeight;
    const s = this.gizmoSize;
    const m = this.gizmoMargin;
    const paneRect = this.paneRects[this.focusedPane];

    this.gizmo.syncCamera(this.getViewDirection(), this.getCameraUp());

    // The cube square's top-left corner, offset inside the focused pane.
    const x = paneRect.x + m;
    // GL viewport origin is bottom-left → the pane's top edge is at
    // cssH - paneRect.y; step down one margin + size from there.
    const y = cssH - paneRect.y - m - s;
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
    this.renderer.setScissor(0, 0, cssW, cssH);
  }

  private onSelectPointerDown = (event: PointerEvent): void => {
    if (this.transformControls.dragging) return; // the gizmo owns this pointer interaction
    this.pointerDownPos = { x: event.clientX, y: event.clientY };
  };

  private onSelectPointerUp = (event: PointerEvent): void => {
    const down = this.pointerDownPos;
    this.pointerDownPos = null;
    if (this.transformControls.dragging) return; // ditto — a gizmo drag-release must never also pick an entity
    if (!down || (!this.measureMode && this.selectionMode === null) || !this.model) return;
    // Ignore drags (orbit/pan) — only a near-stationary click selects.
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const cssX = event.clientX - rect.left;
    const cssY = event.clientY - rect.top;
    // Pick in the pane UNDER THE POINTER (pane-relative NDC, that pane's own
    // camera) — a click both focuses (the capture gate did that already) and
    // picks in the same pane, so the two always agree.
    const index = paneAtPoint(this.paneRects, cssX, cssY);
    if (index < 0) return;
    const ndc = ndcInPane(this.paneRects[index], cssX, cssY);
    this.raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), this.panes[index].active);
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
    // The cube lives in the FOCUSED pane's top-left corner (the same square
    // `renderGizmo` draws it in) — clicks elsewhere never reach the pick.
    const paneRect = this.paneRects[this.focusedPane];
    const s = this.gizmoSize;
    const m = this.gizmoMargin;
    const gx = paneRect.x + m;
    const gy = paneRect.y + m;
    if (cssX < gx || cssX > gx + s || cssY < gy || cssY > gy + s) return;

    const ndcX = ((cssX - gx) / s) * 2 - 1;
    const ndcY = 1 - ((cssY - gy) / s) * 2;
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
