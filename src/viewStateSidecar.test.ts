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
