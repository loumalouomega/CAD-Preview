import type { Annotation, EntityType } from "../protocol";

/**
 * In-webview store of persisted, topology-anchored measurements (roadmap
 * "Persisted, topology-anchored annotations", closed) — pure data +
 * operations (no DOM), mirroring `PartsModel`'s push/onChange/`load()`
 * contract exactly: every mutation fires `onChange` (which the wiring uses
 * to re-render the list and persist the sidecar); {@link load} replaces the
 * data WITHOUT firing, since it's the initial/reconciled load from disk and
 * must not echo straight back as a write.
 */
export class AnnotationsModel {
  private annotations: Annotation[] = [];

  constructor(private readonly onChange: () => void) {}

  /** Replaces all annotations from a freshly-loaded (or rebound) sidecar
   * message (does not fire onChange). */
  load(annotations: Annotation[]): void {
    this.annotations = annotations.map(clone);
  }

  list(): Annotation[] {
    return this.annotations.map(clone);
  }

  get size(): number {
    return this.annotations.length;
  }

  /** Pins a completed measurement as a new, persisted annotation. */
  push(annotation: Annotation): void {
    this.annotations.push(clone(annotation));
    this.onChange();
  }

  rename(id: string, label: string): void {
    const a = this.annotations.find((x) => x.id === id);
    if (!a) return;
    const trimmed = label.trim();
    a.label = trimmed || undefined;
    this.onChange();
  }

  remove(id: string): void {
    const at = this.annotations.findIndex((x) => x.id === id);
    if (at === -1) return;
    this.annotations.splice(at, 1);
    this.onChange();
  }

  /** The anchored entities of one annotation, as a flat selection list —
   * mirrors `PartsModel.entitiesOf` (same four-bucket shape). */
  static entitiesOf(a: Annotation): { entityType: EntityType; entityId: string }[] {
    return [
      ...a.volumes.map((entityId) => ({ entityType: "volume" as const, entityId })),
      ...a.surfaces.map((entityId) => ({ entityType: "surface" as const, entityId })),
      ...a.lines.map((entityId) => ({ entityType: "line" as const, entityId })),
      ...a.points.map((entityId) => ({ entityType: "point" as const, entityId })),
    ];
  }
}

function clone(a: Annotation): Annotation {
  return {
    id: a.id,
    tool: a.tool,
    label: a.label,
    text: a.text,
    anchorPoint: [...a.anchorPoint],
    linePoints: a.linePoints.map((p) => [...p] as [number, number, number]),
    volumes: [...a.volumes],
    surfaces: [...a.surfaces],
    lines: [...a.lines],
    points: [...a.points],
  };
}
