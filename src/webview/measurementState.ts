import type { EntityType } from "../protocol";

export type MeasureTool = "distance" | "edgeLength" | "angle" | "radius";

/** How many picks each tool needs before it has enough data to compute a result. */
const REQUIRED_PICKS: Record<MeasureTool, number> = {
  distance: 2,
  edgeLength: 1,
  angle: 2,
  radius: 1,
};

/**
 * One raycast pick's data, as much as `Viewer` can cheaply compute from the
 * hit (`direction`/`polyline` are `null` when not applicable to the picked
 * entity kind — e.g. `direction` is only ever set for a `surface`/`line` hit,
 * never `point`).
 */
export interface MeasurementPick {
  point: [number, number, number];
  entityType: EntityType | null;
  entityId: string | null;
  /** World-space face normal or edge tangent at the pick — used by the "angle" tool. */
  direction: [number, number, number] | null;
  /** The full world-space polyline of a picked edge — used by "edgeLength"/"radius". */
  polyline: Float32Array | null;
}

/**
 * A dedicated 0–2-pick buffer for the in-progress measurement — deliberately
 * NOT `SelectionSet` (`src/webview/selection.ts`), so measurement clicks never
 * populate the Parts/Edits working selection. Pure state, no DOM/Three.js —
 * unit-tests headless like `selection.ts`.
 */
export class MeasurementState {
  private tool: MeasureTool = "distance";
  private picks: MeasurementPick[] = [];

  getTool(): MeasureTool {
    return this.tool;
  }

  /** Switching tools discards any in-progress (not-yet-complete) picks. */
  setTool(tool: MeasureTool): void {
    this.tool = tool;
    this.picks = [];
  }

  getPicks(): MeasurementPick[] {
    return this.picks;
  }

  /**
   * Records a pick. Once the active tool's required pick count is reached,
   * returns `{done: true, picks}` with the completed set AND resets the
   * buffer (ready for the next measurement); otherwise `{done: false, picks}`
   * with the picks gathered so far.
   */
  addPick(pick: MeasurementPick): { done: boolean; picks: MeasurementPick[] } {
    this.picks.push(pick);
    if (this.picks.length >= REQUIRED_PICKS[this.tool]) {
      const picks = this.picks;
      this.picks = [];
      return { done: true, picks };
    }
    return { done: false, picks: this.picks };
  }

  clear(): void {
    this.picks = [];
  }
}
