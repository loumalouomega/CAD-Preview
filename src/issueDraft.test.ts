import { describe, it, expect } from "vitest";
import { buildIssueDraft, redactText, issueUrl } from "./issueDraft";
import type { EditOp } from "./editOps";

const env = { extensionVersion: "3.36.1", vscodeVersion: "1.100.0", platform: "linux x64", kernels: { "opencascade.js": "1.1.1", "@meshioplusplus/wasm": "18.3.0" } };

describe("redactText", () => {
  it("scrubs the home prefix and any other absolute path to a basename", () => {
    const t = redactText("failed reading /home/alice/work/part.step and C:\\Users\\bob\\x\\y.stp", ["/home/alice"]);
    expect(t).not.toContain("alice");
    expect(t).not.toContain("bob");
    expect(t).toContain("<path>/");
    expect(t).toContain("y.stp");
  });
  it("leaves ordinary text alone and caps very long text", () => {
    expect(redactText("radius 5 on edge-3")).toBe("radius 5 on edge-3");
    expect(redactText("x".repeat(5000)).length).toBeLessThan(2100);
  });
});

describe("buildIssueDraft", () => {
  const op = { op: "fillet", edges: ["edge-3"], radius: 5, label: "/home/alice/secret/name" } as unknown as EditOp;
  const draft = buildIssueDraft({
    modelPath: "/home/alice/work/part.step",
    op,
    outcome: { index: 2, kind: "fillet", applied: false, diagnostic: "radius too large for /home/alice/work/part.step" },
    env,
    scrub: ["/home/alice"],
  });
  it("names the op, diagnostic and versions", () => {
    expect(draft.title).toBe("[fillet] fillet did not apply");
    expect(draft.body).toContain("radius too large");
    expect(draft.body).toContain("CAD Preview 3.36.1");
    expect(draft.body).toContain("@meshioplusplus/wasm 18.3.0");
    expect(draft.body).toContain("`part.step`");
  });
  it("contains no home or workspace path anywhere", () => {
    expect(draft.body).not.toMatch(/alice/);
    expect(draft.body).not.toMatch(/\/home\//);
  });
  it("builds a prefilled, length-capped issues/new URL", () => {
    const url = issueUrl("https://github.com/o/r.git", draft);
    expect(url.startsWith("https://github.com/o/r/issues/new?title=")).toBe(true);
    expect(decodeURIComponent(url)).toContain("did not apply");
  });
});
