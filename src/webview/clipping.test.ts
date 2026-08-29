import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  planeForAxis,
  capCenterAndSize,
  planeForNormal,
  planeForClip,
  offsetFracForPoint,
  orientTowardBulk,
  planeFromThreePoints,
  dominantAxis,
} from "./clipping";

const box = new THREE.Box3(new THREE.Vector3(-2, -4, -6), new THREE.Vector3(2, 4, 6));

describe("planeForAxis", () => {
  it("passes through the box centre at offset 0", () => {
    const plane = planeForAxis("x", 0, box);
    expect(plane.distanceToPoint(new THREE.Vector3(0, 0, 0))).toBeCloseTo(0, 6);
  });

  it("lands on the max face at offset 1, and the min face at offset -1", () => {
    const px = planeForAxis("x", 1, box);
    expect(plane_distanceAt(px, [2, 0, 0])).toBeCloseTo(0, 6);
    const nx = planeForAxis("x", -1, box);
    expect(plane_distanceAt(nx, [-2, 0, 0])).toBeCloseTo(0, 6);
  });

  it("clamps offsets outside [-1, 1] to the box faces", () => {
    const over = planeForAxis("y", 5, box);
    expect(plane_distanceAt(over, [0, 4, 0])).toBeCloseTo(0, 6);
    const under = planeForAxis("y", -5, box);
    expect(plane_distanceAt(under, [0, -4, 0])).toBeCloseTo(0, 6);
  });

  it("the normal points in the positive axis direction, one axis at a time", () => {
    expect(planeForAxis("x", 0, box).normal.toArray()).toEqual([1, 0, 0]);
    expect(planeForAxis("y", 0, box).normal.toArray()).toEqual([0, 1, 0]);
    expect(planeForAxis("z", 0, box).normal.toArray()).toEqual([0, 0, 1]);
  });

  it("keeps the positive-axis side (distance >= 0) at the box's min face", () => {
    // offset -1 -> plane at min face; the box's max-axis point should be kept (positive distance)
    const plane = planeForAxis("x", -1, box);
    expect(plane.distanceToPoint(new THREE.Vector3(2, 0, 0))).toBeGreaterThan(0);
  });
});

function plane_distanceAt(plane: THREE.Plane, point: [number, number, number]): number {
  return plane.distanceToPoint(new THREE.Vector3(...point));
}

describe("capCenterAndSize", () => {
  it("centres on the box centre, projected onto the plane, for a plane through the box centre", () => {
    const plane = planeForAxis("x", 0, box);
    const { center } = capCenterAndSize(plane, box);
    expect(center.toArray()).toEqual([0, 0, 0]); // box centre is already on this plane
  });

  it("projects the box centre onto an off-centre plane along the plane's own normal", () => {
    const plane = planeForAxis("x", 1, box); // x = 2 plane
    const { center } = capCenterAndSize(plane, box);
    // x snaps onto the plane; y/z stay at the box centre's own coordinates
    expect(center.x).toBeCloseTo(2, 6);
    expect(center.y).toBeCloseTo(0, 6);
    expect(center.z).toBeCloseTo(0, 6);
    expect(plane.distanceToPoint(center)).toBeCloseTo(0, 6); // genuinely on the plane
  });

  it("is unaffected by the box being far from the world origin", () => {
    const farBox = box.clone().translate(new THREE.Vector3(1000, -1000, 500));
    const plane = planeForAxis("x", 1, farBox);
    const { center } = capCenterAndSize(plane, farBox);
    // Would be nowhere near the model if centred on the plane's closest point to
    // the origin instead of the box's own centre — assert it tracks the box.
    const farCenter = farBox.getCenter(new THREE.Vector3());
    expect(center.distanceTo(farCenter)).toBeLessThan(farBox.getSize(new THREE.Vector3()).length());
  });

  it("sizes to the box's full 3D diagonal", () => {
    const plane = planeForAxis("z", 0, box);
    const { size } = capCenterAndSize(plane, box);
    expect(size).toBeCloseTo(box.getSize(new THREE.Vector3()).length(), 6);
  });
});

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe("planeForNormal", () => {
  it("agrees with the axis presets bit-for-bit, which is what lets the webview harness assert pixel identity", () => {
    // Not `toBeCloseTo`: the general formula reduces to the original float ops
    // for a unit axis normal (see the doc comment). If this ever becomes only
    // approximately true, the harness's exact-hash P1 case must be downgraded
    // too — so assert the strong property here rather than the weak one.
    for (const t of [-1, -0.7, -0.333, 0, 0.2, 1]) {
      expect(planeForNormal(v(1, 0, 0), t, box).constant).toBe(planeForAxis("x", t, box).constant);
      expect(planeForNormal(v(0, 1, 0), t, box).constant).toBe(planeForAxis("y", t, box).constant);
      expect(planeForNormal(v(0, 0, 1), t, box).constant).toBe(planeForAxis("z", t, box).constant);
    }
  });

  it("passes through the box centre at offset 0 for a tilted normal", () => {
    const plane = planeForNormal(v(1, 1, 1), 0, box);
    expect(plane.distanceToPoint(v(0, 0, 0))).toBeCloseTo(0, 6);
  });

  it("lands on the box's support planes at ±1, touching but never cutting a corner", () => {
    const n = v(1, 1, 1).normalize();
    const max = planeForNormal(n, 1, box);
    const min = planeForNormal(n, -1, box);
    // Every corner is on the kept side of the min plane and the clipped side of
    // the max one, with the extreme corner exactly on each.
    let touchedMax = 0;
    let touchedMin = 0;
    for (const x of [-2, 2]) {
      for (const y of [-4, 4]) {
        for (const z of [-6, 6]) {
          expect(max.distanceToPoint(v(x, y, z))).toBeLessThanOrEqual(1e-9);
          expect(min.distanceToPoint(v(x, y, z))).toBeGreaterThanOrEqual(-1e-9);
          if (Math.abs(max.distanceToPoint(v(x, y, z))) < 1e-9) touchedMax++;
          if (Math.abs(min.distanceToPoint(v(x, y, z))) < 1e-9) touchedMin++;
        }
      }
    }
    expect(touchedMax).toBe(1);
    expect(touchedMin).toBe(1);
  });

  it("normalizes, so a non-unit normal gives the same plane as its unit form", () => {
    const a = planeForNormal(v(3, 0, 0), 0.4, box);
    const b = planeForNormal(v(1, 0, 0), 0.4, box);
    expect(a.normal.toArray()).toEqual(b.normal.toArray());
    expect(a.constant).toBeCloseTo(b.constant, 9);
  });

  it("falls back to +X for a degenerate normal rather than producing a NaN plane", () => {
    const plane = planeForNormal(v(0, 0, 0), 0, box);
    expect(plane.normal.toArray()).toEqual([1, 0, 0]);
    expect(Number.isFinite(plane.constant)).toBe(true);
  });
});

describe("planeForClip", () => {
  it("uses the axis preset when no normal is stored", () => {
    const a = planeForClip({ axis: "y", offsetFrac: 0.3 }, box);
    expect(a.normal.toArray()).toEqual([0, 1, 0]);
    expect(a.constant).toBe(planeForAxis("y", 0.3, box).constant);
  });

  it("lets an explicit normal win over the axis", () => {
    const plane = planeForClip({ axis: "x", offsetFrac: 0, normal: [0, 0, 1] }, box);
    expect(plane.normal.toArray()).toEqual([0, 0, 1]);
  });
});

describe("offsetFracForPoint", () => {
  it("inverts planeForNormal's offset math", () => {
    const n = v(1, 2, 3).normalize();
    for (const t of [-1, -0.5, 0, 0.25, 1]) {
      const plane = planeForNormal(n, t, box);
      // A point on that plane must map back to the same fraction.
      const onPlane = plane.projectPoint(box.getCenter(new THREE.Vector3()), new THREE.Vector3());
      expect(offsetFracForPoint(n, onPlane, box)).toBeCloseTo(t, 9);
    }
  });

  it("clamps a point beyond the box to the sweep ends", () => {
    expect(offsetFracForPoint(v(1, 0, 0), v(500, 0, 0), box)).toBe(1);
    expect(offsetFracForPoint(v(1, 0, 0), v(-500, 0, 0), box)).toBe(-1);
  });

  it("returns 0 rather than dividing by zero for a box flat along the normal", () => {
    const flat = new THREE.Box3(v(-2, -4, 0), v(2, 4, 0));
    expect(offsetFracForPoint(v(0, 0, 1), v(0, 0, 0), flat)).toBe(0);
  });
});

describe("orientTowardBulk", () => {
  it("flips an outward face normal so the model is kept, not discarded", () => {
    // The +X face of the box, with its genuine outward normal. Left unflipped
    // this plane would keep the empty half and the model would vanish.
    const r = orientTowardBulk(v(1, 0, 0), v(2, 0, 0), box);
    expect(r.normal.toArray()).toEqual([-1, -0, -0]);
    expect(r.offsetFrac).toBe(-1);
  });

  it("always lands offsetFrac <= 0, keeping at least half the box", () => {
    const corners = [v(2, 0, 0), v(-2, 0, 0), v(0, 4, 0), v(0, -4, 0), v(1, 2, 3), v(0, 0, 0)];
    for (const p of corners) {
      for (const n of [v(1, 0, 0), v(-1, 0, 0), v(1, 1, 1), v(-1, 2, -3)]) {
        expect(orientTowardBulk(n, p, box).offsetFrac).toBeLessThanOrEqual(0);
      }
    }
  });

  it("gives exactly -1 for a face on the box's extreme, so the slider starts uncut", () => {
    // This is what makes "clip from this face" read correctly: nothing is cut
    // until the user drags, and dragging sweeps inward from that face.
    expect(orientTowardBulk(v(0, 0, 1), v(0, 0, 6), box).offsetFrac).toBe(-1);
    expect(orientTowardBulk(v(0, 0, -1), v(0, 0, -6), box).offsetFrac).toBe(-1);
  });

  it("cuts immediately for an interior face", () => {
    const r = orientTowardBulk(v(0, 1, 0), v(0, 2, 0), box);
    expect(r.offsetFrac).toBeGreaterThan(-1);
    expect(r.offsetFrac).toBeLessThan(0);
  });
});

describe("planeFromThreePoints", () => {
  it("finds the plane through three points", () => {
    const r = planeFromThreePoints(v(0, 0, 0), v(1, 0, 0), v(0, 1, 0));
    expect(r).not.toBeNull();
    expect(Math.abs(r!.normal.z)).toBeCloseTo(1, 9);
    expect(r!.normal.length()).toBeCloseTo(1, 9);
  });

  it("is click-order independent once oriented toward the bulk", () => {
    // The raw normal's sign depends on the order the user clicked; after
    // orientTowardBulk the resulting cut must not. Points offset from the box
    // centre, so the bulk rule is what decides.
    const pts: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [v(-2, -4, 3), v(2, -4, 3), v(2, 4, 3)];
    const orders: [number, number, number][] = [
      [0, 1, 2],
      [2, 1, 0],
      [1, 2, 0],
      [0, 2, 1],
    ];
    const results = orders.map((o) => {
      const r = planeFromThreePoints(pts[o[0]], pts[o[1]], pts[o[2]])!;
      const b = orientTowardBulk(r.normal, r.point, box);
      return `${b.normal.toArray().map((x) => x.toFixed(6))}|${b.offsetFrac.toFixed(6)}`;
    });
    expect(new Set(results).size).toBe(1);
  });

  it("stays click-order independent for a plane through the box centre, where the bulk rule ties", () => {
    // Both orientations keep exactly half here, so the bulk rule cannot decide
    // and the canonical tie-break is what makes this deterministic. Found by
    // the test above failing on these very points, not anticipated.
    const pts: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [v(-2, -4, 0), v(2, -4, 0), v(2, 4, 0)];
    const orders: [number, number, number][] = [
      [0, 1, 2],
      [2, 1, 0],
      [1, 2, 0],
    ];
    const results = orders.map((o) => {
      const r = planeFromThreePoints(pts[o[0]], pts[o[1]], pts[o[2]])!;
      return orientTowardBulk(r.normal, r.point, box).normal.toArray().map((x) => x.toFixed(6)).join(",");
    });
    expect(new Set(results).size).toBe(1);
  });

  it("rejects collinear points rather than silently returning a zero-normal plane", () => {
    // three's setFromCoplanarPoints would give a ZERO normal here, not NaN —
    // a plausible-looking Plane that clips nothing.
    expect(planeFromThreePoints(v(0, 0, 0), v(1, 1, 1), v(2, 2, 2))).toBeNull();
  });

  it("rejects collinearity identically at very different model scales", () => {
    // The test is on normalized edges, so the threshold is an angle, not a
    // length — a 2 mm bracket and a 40 m assembly must behave the same.
    for (const s of [0.001, 1, 40000]) {
      expect(planeFromThreePoints(v(0, 0, 0), v(s, 0, 0), v(2 * s, 0, 0))).toBeNull();
      expect(planeFromThreePoints(v(0, 0, 0), v(s, 0, 0), v(0, s, 0))).not.toBeNull();
    }
  });

  it("rejects coincident points", () => {
    expect(planeFromThreePoints(v(1, 1, 1), v(1, 1, 1), v(2, 3, 4))).toBeNull();
  });
});

describe("dominantAxis", () => {
  it("picks the largest-magnitude component, sign-insensitively", () => {
    expect(dominantAxis(v(0.9, 0.1, 0.2))).toBe("x");
    expect(dominantAxis(v(-0.9, 0.1, 0.2))).toBe("x");
    expect(dominantAxis(v(0.1, 0.9, 0.2))).toBe("y");
    expect(dominantAxis(v(0.1, 0.2, -0.9))).toBe("z");
  });

  it("is deterministic on a tie", () => {
    expect(dominantAxis(v(1, 1, 1))).toBe("x");
    expect(dominantAxis(v(0, 1, 1))).toBe("y");
  });
});
