import type { ConstructionPlane } from "../protocol";

/**
 * In-webview store of named construction planes (roadmap "Reusable
 * construction planes") — pure data + operations (no DOM), mirroring
 * `PartsModel`/`AnnotationsModel`'s contract exactly: every mutation fires
 * `onChange` (which the wiring uses to re-render and persist the sidecar);
 * {@link load} replaces the data WITHOUT firing, since it is the
 * initial/reconciled load from disk and must not echo straight back as a
 * write.
 */
export class PlanesModel {
  private planes: ConstructionPlane[] = [];

  constructor(private readonly onChange: () => void) {}

  /** Replaces all planes from a freshly-loaded sidecar message (does not fire onChange). */
  load(planes: ConstructionPlane[]): void {
    this.planes = planes.map(clone);
  }

  list(): ConstructionPlane[] {
    return this.planes.map(clone);
  }

  get size(): number {
    return this.planes.length;
  }

  find(id: string): ConstructionPlane | undefined {
    const p = this.planes.find((x) => x.id === id);
    return p ? clone(p) : undefined;
  }

  /**
   * Adds a plane, assigning the next free id.
   *
   * Ids are never reused — the highest existing N plus one — so deleting a
   * plane and adding another cannot resurrect the old id under a new meaning,
   * which would silently retarget any `derivedFrom` string pointing at it.
   * Same rule as `planesSidecar.ts`'s `nextPlaneId`; duplicated rather than
   * imported because this module must stay webview-side and free of the
   * sidecar's parse/serialize surface.
   */
  add(plane: Omit<ConstructionPlane, "id">): ConstructionPlane {
    let max = -1;
    for (const p of this.planes) {
      const m = /^plane-(\d+)$/.exec(p.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    const created: ConstructionPlane = clone({ ...plane, id: `plane-${max + 1}` });
    this.planes.push(created);
    this.onChange();
    return clone(created);
  }

  rename(id: string, name: string): void {
    const p = this.planes.find((x) => x.id === id);
    if (!p) return;
    const trimmed = name.trim();
    if (!trimmed) return; // a plane always has a name; an empty one is a no-op, not a blank row
    p.name = trimmed;
    this.onChange();
  }

  remove(id: string): void {
    const at = this.planes.findIndex((x) => x.id === id);
    if (at === -1) return;
    this.planes.splice(at, 1);
    this.onChange();
  }
}

function clone(p: ConstructionPlane): ConstructionPlane {
  return {
    id: p.id,
    name: p.name,
    point: [...p.point],
    normal: [...p.normal],
    derivedFrom: p.derivedFrom,
  };
}
