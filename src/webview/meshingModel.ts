import { DEFAULT_MESH_OPTIONS, type MeshOptions } from "../meshOptions";

/**
 * In-webview store of the current mesh-generation options. Pure data +
 * operations (no DOM), mirroring {@link EditsModel}/{@link PartsModel}. Unlike
 * those two (a list/op-stack), this wraps a single flat options bag, so there's
 * no undo/redo — just a current value that {@link update} patches in place.
 *
 * Every mutation ({@link update}) fires `onChange`, which the wiring uses to
 * post `meshingChanged`, persist the sidecar, and/or re-render the panel.
 * {@link load} replaces the value WITHOUT firing — it is the initial hydration
 * from the host (or a freshly-loaded sidecar) and must not echo straight back
 * as a write.
 */
export class MeshingModel {
  private options: MeshOptions = clone(DEFAULT_MESH_OPTIONS);

  constructor(private readonly onChange: () => void) {}

  /** Replaces the current options from the host (does not fire onChange). */
  load(options: MeshOptions): void {
    this.options = clone(options);
  }

  /** The current mesh options (a copy — mutating it does not affect internal state). */
  get(): MeshOptions {
    return clone(this.options);
  }

  /** Merges a partial patch into the current options; fires onChange. */
  update(patch: Partial<MeshOptions>): void {
    this.options = { ...this.options, ...patch };
    this.onChange();
  }
}

function clone(options: MeshOptions): MeshOptions {
  // MeshOptions is a plain JSON-serializable value; a structured clone keeps
  // the returned/stored object from aliasing across the model boundary.
  return JSON.parse(JSON.stringify(options)) as MeshOptions;
}
