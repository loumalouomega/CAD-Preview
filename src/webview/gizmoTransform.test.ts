import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  applyTranslateDelta, applyRotateDelta, applyScaleDelta, quaternionToAxisAngle,
  snapTranslateDelta, nearestSnapPoint,
  type TransformBase, type GizmoDelta,
} from "./gizmoTransform";

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
function v3(v: THREE.Vector3): [number, number, number] {
  return [round(v.x), round(v.y) || 0, round(v.z) || 0];
}

function identityBase(position: [number, number, number]): TransformBase {
  return {
    basePosition: new THREE.Vector3(...position),
    baseQuaternion: new THREE.Quaternion(),
    baseScale: new THREE.Vector3(1, 1, 1),
  };
}

function delta(overrides: Partial<GizmoDelta>): GizmoDelta {
  return {
    positionDelta: new THREE.Vector3(0, 0, 0),
    quaternionDelta: new THREE.Quaternion(),
    scaleDelta: new THREE.Vector3(1, 1, 1),
    pivot: new THREE.Vector3(0, 0, 0),
    ...overrides,
  };
}

describe("applyTranslateDelta", () => {
  it("moves the base position by the raw delta, ignoring the pivot", () => {
    const base = identityBase([1, 2, 3]);
    const d = delta({ positionDelta: new THREE.Vector3(10, 0, 0), pivot: new THREE.Vector3(99, 99, 99) });
    expect(v3(applyTranslateDelta(base, d).position)).toEqual([11, 2, 3]);
  });
});

describe("applyRotateDelta", () => {
  it("a target exactly at the pivot only reorients, never moves", () => {
    const base = identityBase([5, 0, 0]);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const d = delta({ quaternionDelta: q, pivot: new THREE.Vector3(5, 0, 0) });
    const result = applyRotateDelta(base, d);
    expect(v3(result.position)).toEqual([5, 0, 0]);
  });

  it("a target offset from the pivot revolves around it (90° about Z)", () => {
    const base = identityBase([5, 0, 0]); // 5 units from the pivot along +X
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const d = delta({ quaternionDelta: q, pivot: new THREE.Vector3(0, 0, 0) });
    const result = applyRotateDelta(base, d);
    expect(v3(result.position)).toEqual([0, 5, 0]); // +X rotated 90° about Z lands on +Y
  });

  it("composes with the target's existing orientation rather than replacing it", () => {
    const existing = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 4);
    const base: TransformBase = { basePosition: new THREE.Vector3(0, 0, 0), baseQuaternion: existing, baseScale: new THREE.Vector3(1, 1, 1) };
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const result = applyRotateDelta(base, delta({ quaternionDelta: q }));
    const expected = q.clone().multiply(existing);
    expect(round(result.quaternion.angleTo(expected))).toBe(0);
  });
});

describe("applyScaleDelta", () => {
  it("a target exactly at the pivot only scales, never moves", () => {
    const base = identityBase([0, 0, 0]);
    const d = delta({ scaleDelta: new THREE.Vector3(2, 1, 1), pivot: new THREE.Vector3(0, 0, 0) });
    const result = applyScaleDelta(base, d);
    expect(v3(result.position)).toEqual([0, 0, 0]);
    expect(v3(result.scale)).toEqual([2, 1, 1]);
  });

  it("a target offset from the pivot moves proportionally (matches the OCCT non-uniform-scale affine formula)", () => {
    const base = identityBase([10, 0, 0]); // 10 units from the pivot
    const d = delta({ scaleDelta: new THREE.Vector3(3, 1, 1), pivot: new THREE.Vector3(0, 0, 0) });
    const result = applyScaleDelta(base, d);
    expect(v3(result.position)).toEqual([30, 0, 0]); // pivot + 3*(10-0)
  });

  it("composes multiplicatively with the target's existing scale", () => {
    const base: TransformBase = {
      basePosition: new THREE.Vector3(0, 0, 0),
      baseQuaternion: new THREE.Quaternion(),
      baseScale: new THREE.Vector3(2, 2, 2),
    };
    const result = applyScaleDelta(base, delta({ scaleDelta: new THREE.Vector3(1.5, 1, 1) }));
    expect(v3(result.scale)).toEqual([3, 2, 2]);
  });
});

describe("snapTranslateDelta", () => {
  it("rounds each component to the nearest grid multiple", () => {
    const d = snapTranslateDelta(new THREE.Vector3(4.2, -3.6, 10.9), 2);
    expect(v3(d)).toEqual([4, -4, 10]);
  });

  it("leaves an already-aligned delta unchanged", () => {
    const d = snapTranslateDelta(new THREE.Vector3(6, -4, 0), 2);
    expect(v3(d)).toEqual([6, -4, 0]);
  });

  it("treats a non-positive grid size as disabled (no snapping)", () => {
    const raw = new THREE.Vector3(4.2, -3.6, 10.9);
    expect(v3(snapTranslateDelta(raw, 0))).toEqual(v3(raw));
    expect(v3(snapTranslateDelta(raw, -1))).toEqual(v3(raw));
  });
});

describe("nearestSnapPoint", () => {
  it("returns the closest candidate within tolerance", () => {
    const candidates = [new THREE.Vector3(10, 0, 0), new THREE.Vector3(0.3, 0, 0), new THREE.Vector3(5, 5, 5)];
    const result = nearestSnapPoint(new THREE.Vector3(0, 0, 0), candidates, 1);
    expect(result && v3(result)).toEqual([0.3, 0, 0]);
  });

  it("returns null when nothing is within tolerance", () => {
    const candidates = [new THREE.Vector3(10, 0, 0)];
    expect(nearestSnapPoint(new THREE.Vector3(0, 0, 0), candidates, 1)).toBeNull();
  });

  it("returns null for an empty candidate list", () => {
    expect(nearestSnapPoint(new THREE.Vector3(0, 0, 0), [], 100)).toBeNull();
  });

  it("picks the nearest among several within tolerance, not just the first", () => {
    const candidates = [new THREE.Vector3(0.9, 0, 0), new THREE.Vector3(0.2, 0, 0), new THREE.Vector3(0.5, 0, 0)];
    const result = nearestSnapPoint(new THREE.Vector3(0, 0, 0), candidates, 1);
    expect(result && v3(result)).toEqual([0.2, 0, 0]);
  });
});

describe("quaternionToAxisAngle", () => {
  it("recovers a 90° rotation about +Z", () => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const { axis, angleRad } = quaternionToAxisAngle(q);
    expect(round(angleRad)).toBe(round(Math.PI / 2));
    expect(v3(axis)).toEqual([0, 0, 1]);
  });

  it("recovers a 180° rotation about a normalized arbitrary axis", () => {
    const rawAxis = new THREE.Vector3(1, 1, 0).normalize();
    const q = new THREE.Quaternion().setFromAxisAngle(rawAxis, Math.PI);
    const { axis, angleRad } = quaternionToAxisAngle(q);
    expect(round(angleRad)).toBe(round(Math.PI));
    expect(v3(axis)).toEqual(v3(rawAxis));
  });

  it("degenerates gracefully (no NaN) at zero rotation", () => {
    const { axis, angleRad } = quaternionToAxisAngle(new THREE.Quaternion());
    expect(angleRad).toBe(0);
    expect(Number.isFinite(axis.x) && Number.isFinite(axis.y) && Number.isFinite(axis.z)).toBe(true);
  });
});
