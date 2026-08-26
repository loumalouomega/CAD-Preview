import { describe, expect, it, vi } from "vitest";
import { OpPreviewScheduler } from "./opPreviewScheduler";

/** A tiny deterministic fake-timer harness — real timers at ~10ms would work
 * but this keeps the tests synchronous and exact. */
function makeClock() {
  const tasks: Array<{ at: number; cb: () => void }> = [];
  let now = 0;
  const schedule = (cb: () => void, ms: number): unknown => {
    const task = { at: now + ms, cb };
    tasks.push(task);
    return task;
  };
  const clear = (handle: unknown): void => {
    const i = tasks.indexOf(handle as { at: number; cb: () => void });
    if (i >= 0) tasks.splice(i, 1);
  };
  const advance = (ms: number): void => {
    now += ms;
    for (const t of [...tasks].sort((a, b) => a.at - b.at)) {
      if (t.at <= now) {
        clear(t);
        t.cb();
      }
    }
  };
  return { schedule, clear, advance };
}

function makeScheduler(delay = 300) {
  const clock = makeClock();
  const runs: Array<{ draft: string; generation: number }> = [];
  const scheduler = new OpPreviewScheduler<string>(
    (draft, generation) => runs.push({ draft, generation }),
    delay,
    clock.schedule,
    clock.clear
  );
  return { scheduler, runs, advance: clock.advance };
}

describe("OpPreviewScheduler", () => {
  it("runs the draft exactly once, after the debounce elapses", () => {
    const { scheduler, runs, advance } = makeScheduler();
    scheduler.schedule("a");
    advance(299);
    expect(runs).toEqual([]);
    advance(1);
    expect(runs).toEqual([{ draft: "a", generation: 1 }]);
  });

  it("a later schedule replaces the pending one — only the LAST draft runs, once", () => {
    const { scheduler, runs, advance } = makeScheduler();
    scheduler.schedule("a");
    scheduler.schedule("b");
    scheduler.schedule("c");
    advance(300);
    expect(runs).toEqual([{ draft: "c", generation: 1 }]);
  });

  it("cancel() prevents a pending run entirely", () => {
    const { scheduler, runs, advance } = makeScheduler();
    scheduler.schedule("a");
    scheduler.cancel();
    advance(300);
    expect(runs).toEqual([]);
    expect(scheduler.hasPending()).toBe(false);
  });

  it("cancel() invalidates an already-fired run via the generation guard", () => {
    const { scheduler, runs, advance } = makeScheduler();
    scheduler.schedule("a");
    advance(300);
    expect(runs).toHaveLength(1);
    const fired = runs[0].generation;
    scheduler.cancel();
    expect(scheduler.isCurrent(fired)).toBe(false);
    expect(scheduler.isCurrent(fired + 1)).toBe(true);
  });

  it("each fired run gets a fresh, increasing generation", () => {
    const { scheduler, runs, advance } = makeScheduler();
    scheduler.schedule("a");
    advance(300);
    scheduler.schedule("b");
    advance(300);
    expect(runs.map((r) => r.generation)).toEqual([1, 2]);
    expect(scheduler.isCurrent(2)).toBe(true);
  });

  it("a schedule after cancel() runs normally with a bumped generation", () => {
    const { scheduler, runs, advance } = makeScheduler();
    scheduler.schedule("a");
    scheduler.cancel();
    scheduler.schedule("b");
    advance(300);
    expect(runs).toEqual([{ draft: "b", generation: 2 }]);
  });

  it("dispose() drops the pending timer like cancel (teardown path)", () => {
    const { scheduler, runs, advance } = makeScheduler();
    scheduler.schedule("a");
    scheduler.dispose();
    advance(300);
    expect(runs).toEqual([]);
  });
});
