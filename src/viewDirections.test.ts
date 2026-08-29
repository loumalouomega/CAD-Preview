import { describe, expect, it } from "vitest";
import { NAMED_VIEWS, NAMED_VIEW_NAMES, orbitDirection, resolveNamedView, type Vec3 } from "./viewDirections";
import { SVG_VIEWS } from "./svgSilhouette";

describe("resolveNamedView", () => {
  it("is case-insensitive, which existing callers depend on", () => {
    // The previous lookup was SVG_VIEWS[name.toUpperCase()] against uppercase
    // keys. If canonical lowercase keys were matched case-sensitively, an
    // existing `view: "TOP"` would silently fall through to a fallback.
    for (const spelling of ["top", "TOP", "Top", "  top  "]) {
      expect(resolveNamedView(spelling)?.canonical, spelling).toBe("top");
    }
  });

  it("resolves the historical aliases to exactly what they always meant", () => {
    expect(resolveNamedView("iso")?.direction).toEqual([1, 0.8, 1]);
    expect(resolveNamedView("iso-a")?.direction).toEqual([1, 0.8, 1]);
    expect(resolveNamedView("iso-b")?.direction).toEqual([-1, -0.8, -1]);
  });

  it("returns null for anything unknown rather than throwing", () => {
    expect(resolveNamedView("nope")).toBeNull();
    expect(resolveNamedView("")).toBeNull();
  });

  it("hands back copies, so a caller cannot mutate the table", () => {
    const v = resolveNamedView("top")!;
    v.direction[0] = 99;
    expect(resolveNamedView("top")!.direction[0]).toBe(0);
  });

  it("carries `up` only where the direction is near-vertical", () => {
    expect(resolveNamedView("top")!.up).toEqual([0, 0, -1]);
    expect(resolveNamedView("bottom")!.up).toEqual([0, 0, 1]);
    expect(resolveNamedView("front")!.up).toBeUndefined();
  });
});

describe("NAMED_VIEWS", () => {
  it("covers 6 cardinal directions plus all 8 isometric octants", () => {
    expect(NAMED_VIEW_NAMES).toHaveLength(14);
    for (const sx of ["r", "l"]) {
      for (const sy of ["t", "b"]) {
        for (const sz of ["f", "b"]) {
          expect(NAMED_VIEWS[`iso-${sz}${sy}${sx}`], `iso-${sz}${sy}${sx}`).toBeDefined();
        }
      }
    }
  });

  it("keeps every isometric at ±0.8 in Y", () => {
    // Load-bearing: writing these as [±1,±1,±1] would change SVG_VIEWS.ISO and
    // therefore every silhouette this repo emits, plus renderService's two
    // default isometrics.
    for (const name of NAMED_VIEW_NAMES.filter((n) => n.startsWith("iso-"))) {
      expect(Math.abs(NAMED_VIEWS[name].direction[1]), name).toBe(0.8);
    }
  });

  it("uses the front=+Z, top=+Y, right=+X frame", () => {
    expect(NAMED_VIEWS.front.direction).toEqual([0, 0, 1]);
    expect(NAMED_VIEWS.top.direction).toEqual([0, 1, 0]);
    expect(NAMED_VIEWS.right.direction).toEqual([1, 0, 0]);
  });
});

describe("SVG_VIEWS, now derived from NAMED_VIEWS", () => {
  it("is unchanged in keys and order — provider.ts builds a QuickPick from it", () => {
    // Growing this list grows a user-facing menu, which is exactly why the full
    // 14-entry vocabulary lives in viewDirections.ts instead.
    expect(Object.keys(SVG_VIEWS)).toEqual(["FRONT", "BACK", "TOP", "BOTTOM", "RIGHT", "LEFT", "ISO"]);
  });

  it("is unchanged in values — every silhouette this repo emits depends on these", () => {
    expect(SVG_VIEWS.FRONT).toEqual({ direction: [0, 0, 1] });
    expect(SVG_VIEWS.BACK).toEqual({ direction: [0, 0, -1] });
    expect(SVG_VIEWS.TOP).toEqual({ direction: [0, 1, 0], up: [0, 0, -1] });
    expect(SVG_VIEWS.BOTTOM).toEqual({ direction: [0, -1, 0], up: [0, 0, 1] });
    expect(SVG_VIEWS.RIGHT).toEqual({ direction: [1, 0, 0] });
    expect(SVG_VIEWS.LEFT).toEqual({ direction: [-1, 0, 0] });
    expect(SVG_VIEWS.ISO).toEqual({ direction: [1, 0.8, 1] });
  });
});

const close = (a: Vec3, b: Vec3, p = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], p));

describe("orbitDirection", () => {
  it("is the identity at zero", () => {
    close(orbitDirection([0, 0, 1], [0, 1, 0], 0, 0).direction, [0, 0, 1]);
  });

  it("azimuth swings around the up axis", () => {
    // +90° azimuth from front lands on right, in the front=+Z/right=+X frame.
    close(orbitDirection([0, 0, 1], [0, 1, 0], 90, 0).direction, [1, 0, 0]);
    close(orbitDirection([0, 0, 1], [0, 1, 0], -90, 0).direction, [-1, 0, 0]);
    close(orbitDirection([0, 0, 1], [0, 1, 0], 180, 0).direction, [0, 0, -1]);
  });

  it("elevation tilts toward the up axis", () => {
    close(orbitDirection([0, 0, 1], [0, 1, 0], 0, 45).direction, [0, Math.SQRT1_2, Math.SQRT1_2]);
  });

  it("clamps elevation just shy of the poles, where the basis would collapse", () => {
    const at90 = orbitDirection([0, 0, 1], [0, 1, 0], 0, 90).direction;
    const at89 = orbitDirection([0, 0, 1], [0, 1, 0], 0, 89).direction;
    close(at90, at89);
    expect(at90.every(Number.isFinite)).toBe(true);
  });

  it("always returns a unit direction", () => {
    for (const [az, el] of [[37, 12], [-140, -60], [0, 0], [359, 89]]) {
      const d = orbitDirection([1, 0.8, 1], [0, 1, 0], az, el).direction;
      expect(Math.hypot(...d)).toBeCloseTo(1, 9);
    }
  });

  it("degrades rather than producing NaN for degenerate input", () => {
    // A zero direction, or an `up` parallel to it, has no orbit frame at all.
    expect(orbitDirection([0, 0, 0], [0, 1, 0], 45, 0).direction).toEqual([0, 0, 0]);
    expect(orbitDirection([0, 1, 0], [0, 1, 0], 45, 0).direction).toEqual([0, 1, 0]);
  });
});
