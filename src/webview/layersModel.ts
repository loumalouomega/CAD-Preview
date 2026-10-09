import type { Layer } from "../protocol";
import type { SelectedEntity } from "./selection";

/** The implicit default layer's id — unassigned entities sit here, and a
 * deleted layer's members return here. It cannot be deleted. */
export const DEFAULT_LAYER_ID = "layer-0";

function defaultLayer(): Layer {
  return {
    id: DEFAULT_LAYER_ID,
    name: "Default",
    color: "#b8b8b8",
    visible: true,
    locked: false,
    volumes: [],
    surfaces: [],
    lines: [],
    points: [],
  };
}

/**
 * In-webview store of presentation/drawing layers (roadmap "Layers, distinct
 * from Parts") — pure data + operations (no DOM), mirroring
 * `PartsModel`/`PlanesModel`'s contract exactly: every mutation fires
 * `onChange` (which the wiring uses to re-render, re-apply visibility, and
 * persist the sidecar); {@link load} replaces the data WITHOUT firing, since
 * it is the initial/reconciled load from disk and must not echo straight back
 * as a write.
 *
 * The default layer is implicit until the first real mutation: `load([])`
 * materializes it silently (so the panel always has something to render),
 * but nothing is ever persisted until the user actually changes something —
 * merely opening a file must never create a sidecar it never had.
 */
export class LayersModel {
  private layers: Layer[] = [];
  /**
   * Allocation counter for `layer-N` ids, adopted from the sidecar on every
   * silent load — the same never-recycle rule the host's `allocateLayerId`
   * enforces, so a webview-created layer can never collide with (or resurrect)
   * an id the host already handed out or retired.
   */
  private nextId = 0;

  constructor(private readonly onChange: () => void) {}

  /** Replaces all layers from a freshly-loaded sidecar message (does not fire onChange). */
  load(layers: Layer[], nextId = 0): void {
    this.layers = layers.length > 0 ? layers.map(clone) : [defaultLayer()];
    let max = -1;
    for (const l of this.layers) {
      const m = /^layer-(\d+)$/.exec(l.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    this.nextId = Math.max(nextId, max + 1);
  }

  list(): Layer[] {
    return this.layers.map(clone);
  }

  /** The counter to persist alongside the list (see `onChange` wiring). */
  counter(): number {
    return this.nextId;
  }

  get size(): number {
    return this.layers.length;
  }

  find(id: string): Layer | undefined {
    const l = this.layers.find((x) => x.id === id);
    return l ? clone(l) : undefined;
  }

  create(name?: string): Layer {
    // Seeded on first use when no hydration ever arrived (same materialized
    // default `load([])` produces) — so the first real layer is layer-1,
    // never a second layer-0 colliding with the implicit default.
    if (this.layers.length === 0) this.load([], this.nextId);
    const created: Layer = {
      ...defaultLayer(),
      id: `layer-${this.nextId++}`,
      name: name?.trim() || `Layer ${this.layers.length}`,
      color: "#7fb3d5",
      visible: true,
      locked: false,
    };
    this.layers.push(created);
    this.onChange();
    return clone(created);
  }

  rename(id: string, name: string): void {
    const l = this.layers.find((x) => x.id === id);
    if (!l) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    l.name = trimmed;
    this.onChange();
  }

  recolor(id: string, color: string): void {
    const l = this.layers.find((x) => x.id === id);
    if (!l) return;
    l.color = color;
    this.onChange();
  }

  setVisible(id: string, visible: boolean): void {
    const l = this.layers.find((x) => x.id === id);
    if (!l || l.visible === visible) return;
    l.visible = visible;
    this.onChange();
  }

  setLocked(id: string, locked: boolean): void {
    const l = this.layers.find((x) => x.id === id);
    if (!l || l.locked === locked) return;
    l.locked = locked;
    this.onChange();
  }

  /**
   * Deletes a layer, returning its members to the default layer. The default
   * layer itself cannot be deleted — returns `false` (and changes nothing)
   * for it or an unknown id, so the caller can explain rather than assume.
   */
  remove(id: string): boolean {
    if (id === DEFAULT_LAYER_ID) return false;
    const at = this.layers.findIndex((x) => x.id === id);
    if (at === -1) return false;
    const [removed] = this.layers.splice(at, 1);
    const home = this.layers.find((x) => x.id === DEFAULT_LAYER_ID)!;
    for (const kind of ["volumes", "surfaces", "lines", "points"] as const) {
      for (const e of removed[kind]) {
        if (!home[kind].includes(e)) home[kind].push(e);
      }
    }
    this.onChange();
    return true;
  }

  /**
   * Assigns the given entities to a layer, removing each from whatever other
   * layer currently holds it — an entity belongs to at most one layer.
   */
  assign(id: string, entities: SelectedEntity[]): void {
    const target = this.layers.find((x) => x.id === id);
    if (!target || entities.length === 0) return;
    for (const e of entities) {
      const kind = kindFor(e.entityType);
      for (const l of this.layers) {
        if (l === target) continue;
        const at = l[kind].indexOf(e.entityId);
        if (at !== -1) l[kind].splice(at, 1);
      }
      if (!target[kind].includes(e.entityId)) target[kind].push(e.entityId);
    }
    this.onChange();
  }

  /** Removes a single entity id from a layer. */
  removeEntity(id: string, entityType: SelectedEntity["entityType"], entityId: string): void {
    const l = this.layers.find((x) => x.id === id);
    if (!l) return;
    const bucket = l[kindFor(entityType)];
    const at = bucket.indexOf(entityId);
    if (at === -1) return;
    bucket.splice(at, 1);
    this.onChange();
  }

  /** The entities of one layer as a flat selection list (for highlighting/visibility). */
  entitiesOf(id: string): SelectedEntity[] {
    const l = this.layers.find((x) => x.id === id);
    if (!l) return [];
    return [
      ...l.volumes.map((eid) => ({ entityType: "volume" as const, entityId: eid })),
      ...l.surfaces.map((eid) => ({ entityType: "surface" as const, entityId: eid })),
      ...l.lines.map((eid) => ({ entityType: "line" as const, entityId: eid })),
      ...l.points.map((eid) => ({ entityType: "point" as const, entityId: eid })),
    ];
  }

  /** Every entity id sitting on a locked layer — the Transform Gizmo and op-builder refusal set. */
  lockedEntityIds(): Set<string> {
    const out = new Set<string>();
    for (const l of this.layers) {
      if (!l.locked) continue;
      for (const eid of [...l.volumes, ...l.surfaces, ...l.lines, ...l.points]) out.add(eid);
    }
    return out;
  }
}

function kindFor(type: SelectedEntity["entityType"]): "volumes" | "surfaces" | "lines" | "points" {
  return type === "volume" ? "volumes" : type === "surface" ? "surfaces" : type === "line" ? "lines" : "points";
}

function clone(l: Layer): Layer {
  return {
    id: l.id,
    name: l.name,
    color: l.color,
    visible: l.visible,
    locked: l.locked,
    volumes: [...l.volumes],
    surfaces: [...l.surfaces],
    lines: [...l.lines],
    points: [...l.points],
  };
}
