import type { EntityType } from "../protocol";

export interface SelectedEntity {
  entityType: EntityType;
  entityId: string;
}

function key(e: SelectedEntity): string {
  return `${e.entityType}:${e.entityId}`;
}

/**
 * Holds the user's current (transient, not-yet-assigned) selection of entities.
 * Pure state container — the viewer renders the highlight, the parts UI consumes
 * {@link list} when assigning to a part.
 */
export class SelectionSet {
  private readonly items = new Map<string, SelectedEntity>();

  /** Adds `e` if absent, removes it if present. Returns the new membership. */
  toggle(e: SelectedEntity): boolean {
    const k = key(e);
    if (this.items.has(k)) {
      this.items.delete(k);
      return false;
    }
    this.items.set(k, e);
    return true;
  }

  add(e: SelectedEntity): void {
    this.items.set(key(e), e);
  }

  has(e: SelectedEntity): boolean {
    return this.items.has(key(e));
  }

  clear(): void {
    this.items.clear();
  }

  get size(): number {
    return this.items.size;
  }

  list(): SelectedEntity[] {
    return [...this.items.values()];
  }
}
