import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs build helper (outside the tsc `src` project)
import { postProcess, ACCENT_FILL } from "./svgIconPostProcess.mjs";

const wrap = (body: string) =>
  `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">${body}</svg>`;

describe("svgIconPostProcess accent mapping", () => {
  it("maps a pure blue fill to the accent variable at full opacity", () => {
    const out = postProcess(wrap('<path fill="rgb(0%, 0%, 100%)" fill-opacity="1" stroke="rgb(0%, 0%, 0%)" d="M0 0"/>'));
    expect(out).toContain(`fill="${ACCENT_FILL}" fill-opacity="1"`);
    expect(ACCENT_FILL).toBe("var(--ui-icon-accent, currentColor)");
    expect(out).toContain('stroke="currentColor"'); // strokes still follow the text colour
    expect(out).not.toMatch(/100%\)/);
  });

  it("keeps a blue!N tint as a proportional fill-opacity", () => {
    const out = postProcess(wrap('<path fill="rgb(60%, 60%, 100%)" fill-opacity="1" d="M0 0"/>'));
    expect(out).toContain(`fill="${ACCENT_FILL}" fill-opacity="0.4"`);
  });

  it("does not turn white or gray into the accent, and leaves gray mapping unchanged", () => {
    const white = postProcess(wrap('<path fill="rgb(100%, 100%, 100%)" fill-opacity="1" d="M0 0"/>'));
    expect(white).toContain('fill="rgb(100%, 100%, 100%)"');
    expect(white).not.toContain("--ui-icon-accent");
    const gray = postProcess(wrap('<path fill="rgb(75%, 75%, 75%)" fill-opacity="1" d="M0 0"/>'));
    expect(gray).toContain('fill="currentColor" fill-opacity="0.25"');
    expect(gray).not.toContain("--ui-icon-accent");
  });

  it("never maps a blue stroke to the accent", () => {
    const out = postProcess(wrap('<path fill="none" stroke="rgb(0%, 0%, 100%)" d="M0 0"/>'));
    expect(out).not.toContain("--ui-icon-accent");
  });
});
