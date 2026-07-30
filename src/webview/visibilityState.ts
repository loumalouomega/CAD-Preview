/**
 * Transient, session-only visibility state for the Parts panel's eye-toggle
 * and Isolate action, and the Components tree's per-node eye-toggle. Pure
 * state container — display-only, never written to any sidecar (mirrors
 * `SelectionSet`'s "transient, not persisted" precedent) and deliberately
 * kept separate from `PartsModel`'s persisted `Part[]` list.
 */
export class VisibilityState {
  private hiddenParts = new Set<number>();
  private isolatedPart: number | null = null;
  private hiddenTreeGroups = new Set<string>();

  toggleHiddenPart(index: number): void {
    if (this.hiddenParts.has(index)) this.hiddenParts.delete(index);
    else this.hiddenParts.add(index);
  }

  isPartHidden(index: number): boolean {
    return this.hiddenParts.has(index);
  }

  hiddenPartIndices(): number[] {
    return [...this.hiddenParts];
  }

  /** Isolating a part clears no other state — hidden parts stay hidden once isolate is cleared. */
  setIsolatedPart(index: number | null): void {
    this.isolatedPart = index;
  }

  /** Toggles: clicking Isolate on the already-isolated part clears isolation. */
  toggleIsolatedPart(index: number): void {
    this.isolatedPart = this.isolatedPart === index ? null : index;
  }

  isolatedPartIndex(): number | null {
    return this.isolatedPart;
  }

  isPartIsolated(index: number): boolean {
    return this.isolatedPart === index;
  }

  /** Drops any state referring to a part index that no longer exists (e.g. after a delete). */
  onPartCountChanged(count: number): void {
    this.hiddenParts = new Set([...this.hiddenParts].filter((i) => i < count));
    if (this.isolatedPart !== null && this.isolatedPart >= count) this.isolatedPart = null;
  }

  toggleTreeGroupHidden(groupId: string): void {
    if (this.hiddenTreeGroups.has(groupId)) this.hiddenTreeGroups.delete(groupId);
    else this.hiddenTreeGroups.add(groupId);
  }

  isTreeGroupHidden(groupId: string): boolean {
    return this.hiddenTreeGroups.has(groupId);
  }

  hiddenTreeGroupIds(): string[] {
    return [...this.hiddenTreeGroups];
  }
}
