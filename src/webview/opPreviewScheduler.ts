/**
 * Pure debounce/cancel/generation state machine for the live operation
 * preview (roadmap item "Live operation preview — show the result before
 * Apply, coloured by intent"). No DOM, no THREE, no timers of its own —
 * `setTimeout`/`clearTimeout` are injected, which is what makes it
 * deterministically unit-testable (real ~20ms timers rather than
 * `vi.useFakeTimers()`, whose interaction with promise-chain sequencing hung
 * a test suite once before in this codebase — see `kernelClient.test.ts`).
 *
 * The two invariants it exists to enforce, both documented failure modes the
 * roadmap item calls out:
 *
 * 1. **A later schedule replaces the pending one** — typing in a form field
 *    fires many `schedule()` calls; only the LAST draft may run, and exactly
 *    once, after the debounce elapses. (The "must not compound" regression
 *    shape `explodePreview.test.ts` pins for its own domain.)
 * 2. **`cancel()` kills both the pending timer AND the in-flight result** —
 *    a preview response arriving after a cancel/form-switch/model-rebuild
 *    must be silently ignored (the generation guard), never rendered.
 */
export class OpPreviewScheduler<Draft> {
  private pendingTimer: unknown | null = null;
  private pendingDraft: Draft | null = null;
  private generation = 0;

  constructor(
    private readonly run: (draft: Draft, generation: number) => void,
    private readonly delayMs: number,
    private readonly scheduleTimer: (cb: () => void, ms: number) => unknown = (cb, ms) => setTimeout(cb, ms),
    private readonly clearTimer: (handle: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
  ) {}

  /**
   * Debounces a draft: (re)starts the timer, keeping only this draft. Any
   * previously-pending draft is dropped, never run.
   */
  schedule(draft: Draft): void {
    this.clearPending();
    this.pendingDraft = draft;
    this.pendingTimer = this.scheduleTimer(() => {
      this.pendingTimer = null;
      const draftToRun = this.pendingDraft;
      this.pendingDraft = null;
      if (draftToRun !== null) {
        // Generation captured by the caller via the callback argument — the
        // in-flight request carries it so a later cancel() can invalidate it.
        this.run(draftToRun, ++this.generation);
      }
    }, this.delayMs);
  }

  /**
   * Discards any pending timer AND bumps the generation, invalidating any
   * in-flight request. The runner must check the generation it was handed
   * before rendering; `isCurrent(generation)` is that check.
   */
  cancel(): void {
    this.clearPending();
    this.generation++;
  }

  /** True when `generation` is still the live one — the runner's stale-guard. */
  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  /** True while a debounced run is still pending (never yet fired). */
  hasPending(): boolean {
    return this.pendingTimer !== null;
  }

  /** Tears down timers without bumping the generation (webview teardown). */
  dispose(): void {
    this.clearPending();
  }

  private clearPending(): void {
    if (this.pendingTimer !== null) {
      this.clearTimer(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.pendingDraft = null;
  }
}
