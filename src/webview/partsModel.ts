import type { Part } from "../protocol";
import type { SelectedEntity } from "./selection";
import type { EntityColorMap } from "./viewer";

/** Distinct, high-contrast colours cycled as new parts are created. Exported
 * so `meshioRegionParts.ts`'s host-side auto-created Parts use the same
 * palette a manually-created part would. */
export const PALETTE = [
  "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
  "#42d4f4", "#f032e6", "#bfef45", "#fabed4", "#469990",
];

/**
 * In-webview store of user-defined parts and the entities assigned to them.
 * Pure data + operations (no DOM). Every mutation fires `onChange`, which the
 * wiring uses to re-render the panel, recolour the model, and persist the
 * sidecar. {@link load} replaces the data WITHOUT firing — it is the initial
 * load from disk and must not echo straight back as a write.
 */
export class PartsModel {
  private parts: Part[] = [];

  constructor(private readonly onChange: () => void) {}

  /** Replaces all parts from a freshly-loaded sidecar (does not fire onChange). */
  load(parts: Part[]): void {
    this.parts = parts.map(clone);
  }

  list(): Part[] {
    return this.parts.map(clone);
  }

  get size(): number {
    return this.parts.length;
  }

  create(name?: string): void {
    const color = PALETTE[this.parts.length % PALETTE.length];
    this.parts.push({
      name: name?.trim() || `Part ${this.parts.length + 1}`,
      color,
      volumes: [],
      surfaces: [],
      lines: [],
      points: [],
    });
    this.onChange();
  }

  rename(index: number, name: string): void {
    const p = this.parts[index];
    if (!p) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    p.name = trimmed;
    this.onChange();
  }

  recolor(index: number, color: string): void {
    const p = this.parts[index];
    if (!p) return;
    p.color = color;
    this.onChange();
  }

  setMeshSize(index: number, size: number | undefined): void {
    const p = this.parts[index];
    if (!p) return;
    p.meshSize = size;
    this.onChange();
  }

  remove(index: number): void {
    if (index < 0 || index >= this.parts.length) return;
    this.parts.splice(index, 1);
    this.onChange();
  }

  /** Assigns the given entities to a part, de-duplicating per kind. */
  assign(index: number, entities: SelectedEntity[]): void {
    const p = this.parts[index];
    if (!p || entities.length === 0) return;
    for (const e of entities) {
      const bucket = bucketFor(p, e.entityType);
      if (!bucket.includes(e.entityId)) bucket.push(e.entityId);
    }
    this.onChange();
  }

  /** Removes a single entity id from a part. */
  removeEntity(index: number, entityType: SelectedEntity["entityType"], entityId: string): void {
    const p = this.parts[index];
    if (!p) return;
    const bucket = bucketFor(p, entityType);
    const at = bucket.indexOf(entityId);
    if (at === -1) return;
    bucket.splice(at, 1);
    this.onChange();
  }

  /** Resolves per-part colours for the whole model, last part winning on overlap. */
  colorMap(): EntityColorMap {
    const solids = new Map<string, string>();
    const faces = new Map<string, string>();
    const edges = new Map<string, string>();
    const points = new Map<string, string>();
    for (const p of this.parts) {
      for (const id of p.volumes) solids.set(id, p.color);
      for (const id of p.surfaces) faces.set(id, p.color);
      for (const id of p.lines) edges.set(id, p.color);
      for (const id of p.points) points.set(id, p.color);
    }
    return { solids, faces, edges, points };
  }

  /** The entities of one part as a flat selection list (for highlighting). */
  entitiesOf(index: number): SelectedEntity[] {
    const p = this.parts[index];
    if (!p) return [];
    return [
      ...p.volumes.map((id) => ({ entityType: "volume" as const, entityId: id })),
      ...p.surfaces.map((id) => ({ entityType: "surface" as const, entityId: id })),
      ...p.lines.map((id) => ({ entityType: "line" as const, entityId: id })),
      ...p.points.map((id) => ({ entityType: "point" as const, entityId: id })),
    ];
  }
}

function bucketFor(p: Part, type: SelectedEntity["entityType"]): string[] {
  return type === "volume" ? p.volumes : type === "surface" ? p.surfaces : type === "line" ? p.lines : p.points;
}

function clone(p: Part): Part {
  return {
    name: p.name,
    color: p.color,
    volumes: [...p.volumes],
    surfaces: [...p.surfaces],
    lines: [...p.lines],
    points: [...p.points],
    meshSize: p.meshSize,
    // A stored selector is data, not derived state — dropping it here would
    // silently unpersist the query on the next autosave (the exact
    // `AnnotationsModel.clone`-omitted-`tolerance` defect class). The query
    // object itself is treated as immutable downstream (never mutated in
    // place — resolution returns new arrays), so a shared reference is safe.
    ...(p.selector && p.selectorOpKind ? { selector: p.selector, selectorOpKind: p.selectorOpKind } : {}),
  };
}
