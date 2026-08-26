/**
 * On-demand render scheduling (roadmap "Render on demand, not every frame").
 *
 * A tiny dirty-flag loop over an injectable frame source (requestAnimationFrame
 * in production). `request()` coalesces any number of invalidations into ONE
 * scheduled frame; after each frame the owner's `tick()` decides whether
 * another is needed — returning `true` keeps the loop alive (e.g.
 * OrbitControls damping still settling), `false` lets it go fully idle until
 * the next `request()`. Pure logic, injectable timers — unit-tested headless,
 * following the `opPreviewScheduler.ts` precedent.
 */

/** Runs one frame; returns true to keep the loop running for another. */
export type FrameTick = () => boolean;

export interface RenderScheduler {
  /** Marks work pending and schedules a frame if none is already queued. */
  request(): void;
  /** Drops any queued frame and goes idle (teardown path). */
  cancel(): void;
  /** True while a frame is scheduled or the loop is mid-run. */
  readonly pending: boolean;
}

export function createRenderScheduler(
  tick: FrameTick,
  scheduleFrame: (cb: () => void) => number,
  cancelFrame: (handle: number) => void
): RenderScheduler {
  let handle: number | null = null;

  const run = (): void => {
    // Clear BEFORE tick so a request() issued from inside tick() (e.g. a
    // "change" listener firing mid-frame) schedules a follow-up instead of
    // being coalesced into the frame that is currently executing.
    handle = null;
    if (tick()) request();
  };

  function request(): void {
    if (handle !== null) return;
    handle = scheduleFrame(run);
  }

  return {
    request,
    cancel(): void {
      if (handle !== null) {
        cancelFrame(handle);
        handle = null;
      }
    },
    get pending(): boolean {
      return handle !== null;
    },
  };
}
