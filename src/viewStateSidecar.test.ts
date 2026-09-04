import { describe, it, expect } from "vitest";
import { parseViewStateJson, serializeViewStateJson, VIEW_STATE_SIDECAR_VERSION } from "./viewStateSidecar";
import type { ViewState } from "./protocol";

const validView: ViewState = {
  viewDirection: [1, 0.8, 1],
  cameraUp: [0, 1, 0],
  orthographic: false,
  displayMode: "shaded",
  clip: { axis: "x", offsetFrac: 0.25 },
};

describe("parseViewStateJson", () => {
  it("parses a well-formed sidecar", () => {
    const text = JSON.stringify({ version: 1, source: "bull.stp", view: validView });
    expect(parseViewStateJson(text)).toEqual(validView);
  });

  it("returns null for invalid JSON or a missing view field", () => {
    expect(parseViewStateJson("not json")).toBeNull();
    expect(parseViewStateJson("{}")).toBeNull();
    expect(parseViewStateJson(JSON.stringify({ view: "nope" }))).toBeNull();
  });

  it("rejects the whole record when viewDirection or cameraUp is missing/malformed", () => {
    const { viewDirection, ...withoutDirection } = validView;
    expect(parseViewStateJson(JSON.stringify({ view: withoutDirection }))).toBeNull();
    expect(parseViewStateJson(JSON.stringify({ view: { ...validView, viewDirection: [1, 2] } }))).toBeNull();
    expect(parseViewStateJson(JSON.stringify({ view: { ...validView, viewDirection: [1, "x", 1] } }))).toBeNull();
    expect(parseViewStateJson(JSON.stringify({ view: { ...validView, cameraUp: [NaN, 1, 0] } }))).toBeNull();
  });

  it("rejects a degenerate (all-zero) viewDirection or cameraUp — can't orient a camera", () => {
    expect(parseViewStateJson(JSON.stringify({ view: { ...validView, viewDirection: [0, 0, 0] } }))).toBeNull();
    expect(parseViewStateJson(JSON.stringify({ view: { ...validView, cameraUp: [0, 0, 0] } }))).toBeNull();
  });

  it("falls back to safe defaults for an invalid displayMode/orthographic", () => {
    const view = parseViewStateJson(JSON.stringify({ view: { ...validView, displayMode: "bogus", orthographic: "yes" } }));
    expect(view?.displayMode).toBe("shaded");
    expect(view?.orthographic).toBe(false);
  });

  it("drops a malformed clip and clamps a valid offsetFrac to [-1, 1]", () => {
    expect(parseViewStateJson(JSON.stringify({ view: { ...validView, clip: { axis: "w", offsetFrac: 0.1 } } }))?.clip).toBeNull();
    expect(parseViewStateJson(JSON.stringify({ view: { ...validView, clip: { axis: "y", offsetFrac: "0.1" } } }))?.clip).toBeNull();
    expect(parseViewStateJson(JSON.stringify({ view: { ...validView, clip: { axis: "y", offsetFrac: 5 } } }))?.clip).toEqual({
      axis: "y",
      offsetFrac: 1,
    });
    expect(parseViewStateJson(JSON.stringify({ view: { ...validView, clip: null } }))?.clip).toBeNull();
  });
});

describe("serializeViewStateJson", () => {
  it("round-trips through parseViewStateJson", () => {
    const text = serializeViewStateJson("bull.stp", validView);
    expect(parseViewStateJson(text)).toEqual(validView);
  });

  it("includes the version and source name", () => {
    const text = serializeViewStateJson("bull.stp", validView);
    const parsed = JSON.parse(text);
    expect(parsed.version).toBe(VIEW_STATE_SIDECAR_VERSION);
    expect(parsed.source).toBe("bull.stp");
  });
});

describe("view-state clip: the optional arbitrary normal", () => {
  const withClip = (clip: unknown) =>
    parseViewStateJson(JSON.stringify({ version: 1, source: "bull.stp", view: { ...validView, clip } }));

  it("keeps a legacy axis-only clip byte-identical, writing no normal key", () => {
    // The overwhelmingly common on-disk shape. It must not gain a `normal`.
    const text = serializeViewStateJson("bull.stp", validView);
    expect(text).not.toContain("normal");
    expect(parseViewStateJson(text)).toEqual(validView);
  });

  it("normalizes a stored normal on read, so consumers can assume a unit vector", () => {
    const parsed = withClip({ axis: "x", offsetFrac: 0, normal: [2, 0, 0] });
    expect(parsed?.clip?.normal).toEqual([1, 0, 0]);
  });

  it("round-trips a custom normal", () => {
    const custom: ViewState = { ...validView, clip: { axis: "z", offsetFrac: -0.5, normal: [0, 0, 1] } };
    expect(parseViewStateJson(serializeViewStateJson("bull.stp", custom))).toEqual(custom);
  });

  it("drops ONLY the normal when it is degenerate, keeping the clip as its axis form", () => {
    // Deliberately unlike a bad `axis`, which drops the whole clip (below).
    const zero = withClip({ axis: "x", offsetFrac: 0.25, normal: [0, 0, 0] });
    expect(zero?.clip).toEqual({ axis: "x", offsetFrac: 0.25 });
    const nan = withClip({ axis: "x", offsetFrac: 0.25, normal: [1, 0, Number.NaN] });
    expect(nan?.clip).toEqual({ axis: "x", offsetFrac: 0.25 });
    const short = withClip({ axis: "x", offsetFrac: 0.25, normal: [1, 0] });
    expect(short?.clip).toEqual({ axis: "x", offsetFrac: 0.25 });
    const wrongType = withClip({ axis: "x", offsetFrac: 0.25, normal: "x" });
    expect(wrongType?.clip).toEqual({ axis: "x", offsetFrac: 0.25 });
  });

  it("still drops the WHOLE clip for a bad axis, even when a valid normal is present", () => {
    // The forward-compat contract: `axis` is always required, so an older build
    // reading this file restores a sensible neighbouring clip rather than none.
    expect(withClip({ axis: "w", offsetFrac: 0, normal: [1, 0, 0] })?.clip).toBeNull();
  });
});

describe("view-state: collapsed sidebar sections", () => {
  it("round-trips through serialize → parse", () => {
    const view: ViewState = { ...validView, collapsedPanels: ["parts-panel", "mass-panel"] };
    expect(parseViewStateJson(serializeViewStateJson("bull.stp", view))).toEqual(view);
  });

  it("writes collapsedPanels as a TOP-LEVEL sibling of `view`, never inside it", () => {
    // The serialize destructure is what enforces this; if it regressed, the
    // field would land inside `view` and the parse below would never find it.
    const file = JSON.parse(
      serializeViewStateJson("bull.stp", { ...validView, collapsedPanels: ["parts-panel"] })
    );
    expect(file.collapsedPanels).toEqual(["parts-panel"]);
    expect(file.view.collapsedPanels).toBeUndefined();
  });

  it("survives a SINGLE-PANE sidecar — the case the layout early-return would swallow", () => {
    // `parseViewStateJson` returns early for `layout: "1x1"`/absent, which is
    // the overwhelmingly common shape. Parsing collapsedPanels after that
    // return would silently drop it for almost every real document.
    const text = JSON.stringify({
      version: VIEW_STATE_SIDECAR_VERSION,
      source: "bull.stp",
      view: validView,
      collapsedPanels: ["edits-panel"],
    });
    expect(parseViewStateJson(text)?.collapsedPanels).toEqual(["edits-panel"]);

    const withLayout = JSON.stringify({
      version: VIEW_STATE_SIDECAR_VERSION,
      source: "bull.stp",
      view: validView,
      layout: "1x1",
      collapsedPanels: ["edits-panel"],
    });
    expect(parseViewStateJson(withLayout)?.collapsedPanels).toEqual(["edits-panel"]);
  });

  it("survives alongside a real split-view layout too", () => {
    const view: ViewState = {
      ...validView,
      layout: "1x2",
      panes: [
        { viewDirection: [1, 0, 0], cameraUp: [0, 1, 0], orthographic: false },
        { viewDirection: [0, 0, 1], cameraUp: [0, 1, 0], orthographic: true },
      ],
      collapsedPanels: ["macros-panel"],
    };
    expect(parseViewStateJson(serializeViewStateJson("bull.stp", view))?.collapsedPanels).toEqual(["macros-panel"]);
  });

  it("omits the key entirely when nothing is collapsed, so an untouched sidecar stays byte-stable", () => {
    const text = serializeViewStateJson("bull.stp", validView);
    expect(JSON.parse(text)).not.toHaveProperty("collapsedPanels");
    expect(parseViewStateJson(text)?.collapsedPanels).toBeUndefined();
    expect(serializeViewStateJson("bull.stp", { ...validView, collapsedPanels: [] })).toBe(text);
  });

  it("sanitizes a hand-edited list rather than trusting it", () => {
    const text = JSON.stringify({
      version: VIEW_STATE_SIDECAR_VERSION,
      source: "bull.stp",
      view: validView,
      collapsedPanels: ["app", "parts-panel", 7],
    });
    expect(parseViewStateJson(text)?.collapsedPanels).toEqual(["parts-panel"]);
  });

  it("ignores a non-array collapsedPanels without dropping the rest of the record", () => {
    const text = JSON.stringify({
      version: VIEW_STATE_SIDECAR_VERSION,
      source: "bull.stp",
      view: validView,
      collapsedPanels: "parts-panel",
    });
    const parsed = parseViewStateJson(text);
    expect(parsed).not.toBeNull();
    expect(parsed?.collapsedPanels).toBeUndefined();
    expect(parsed?.displayMode).toBe("shaded");
  });

  it("an older sidecar with no collapsedPanels parses exactly as before", () => {
    const text = JSON.stringify({ version: 1, source: "bull.stp", view: validView });
    expect(parseViewStateJson(text)).toEqual(validView);
  });
});
