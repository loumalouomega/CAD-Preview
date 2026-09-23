import { describe, it, expect } from "vitest";
import { SidecarRevisionTracker, fingerprint, summarizeConflict } from "./sidecarRevision";

describe("fingerprint", () => {
  it("distinguishes content and treats a missing file as its own value", () => {
    const a = fingerprint(new TextEncoder().encode("a"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint(new TextEncoder().encode("a"))).toBe(a);
    expect(fingerprint(new TextEncoder().encode("b"))).not.toBe(a);
    expect(fingerprint(null)).toBe("absent");
  });
});

describe("SidecarRevisionTracker", () => {
  it("an echo of our own write is never a conflict, even with a pending change", () => {
    const t = new SidecarRevisionTracker();
    t.markLocalPending("edits");
    expect(t.classifyDiskChange("edits", true)).toBe("echo");
  });

  it("adopts an external change when nothing is pending, conflicts when something is", () => {
    const t = new SidecarRevisionTracker();
    expect(t.classifyDiskChange("parts", false)).toBe("adopt");
    t.markLocalPending("parts");
    expect(t.classifyDiskChange("parts", false)).toBe("conflict");
    expect(t.classifyDiskChange("edits", false)).toBe("adopt"); // kinds are independent
  });

  it("canWrite blocks a write when disk moved past the known revision or the kind is paused", () => {
    const t = new SidecarRevisionTracker();
    expect(t.canWrite("mesh", "x")).toBe(true); // never read: unknown never blocks
    t.noteSynced("mesh", "r1");
    expect(t.canWrite("mesh", "r1")).toBe(true);
    expect(t.canWrite("mesh", "r2")).toBe(false);
    t.pause("mesh");
    expect(t.canWrite("mesh", "r1")).toBe(false);
    expect(t.classifyDiskChange("mesh", false)).toBe("conflict"); // paused still conflicts
    t.resolve("mesh");
    expect(t.isPaused("mesh")).toBe(false);
    expect(t.isLocalPending("mesh")).toBe(false);
    expect(t.canWrite("mesh", "r1")).toBe(true);
  });
});

describe("summarizeConflict", () => {
  it("names the kind, the file and both counts", () => {
    expect(summarizeConflict("edits", "bull.stp", { local: 4, disk: 5 })).toBe(
      "Edits for bull.stp changed on disk while you had unsaved changes — disk now has 5 ops, this editor has 4 ops with unsaved changes."
    );
    expect(summarizeConflict("parts", "a.stl", { local: 1, disk: 1 })).toContain("1 part,");
    expect(summarizeConflict("mesh", "a.stl", { local: null, disk: null })).toContain("both the file on disk and this editor changed");
  });
});
