import { describe, it, expect } from "vitest";
import * as THREE from "three";
import type { OpBucket } from "../opBuckets";
import {
  draftBucketFor,
  bandFaceIds,
  previewBandLegend,
  tintDisplayName,
  applyPreviewTint,
  PREVIEW_TINTS,
  PREVIEW_CONTEXT_GREY,
} from "./opPreviewBands";

function bucket(op: number, roles: Record<string, string[]>): OpBucket {
  return { op, kind: "extrude", roles };
}

describe("draftBucketFor", () => {
  it("returns the bucket at the replay-tail draft index", () => {
    const tail = bucket(0, { body: ["face-0"] });
    const draft = bucket(1, { endCap: ["face-5"], side: ["face-6"] });
    expect(draftBucketFor([tail, draft], 2)).toBe(draft);
  });

  it("returns null when the draft recorded no bucket", () => {
    const tail = bucket(0, { body: ["face-0"] });
    expect(draftBucketFor([tail], 2)).toBeNull();
  });

  it("returns null for missing/empty inputs", () => {
    expect(draftBucketFor(undefined, 2)).toBeNull();
    expect(draftBucketFor([], 1)).toBeNull();
    expect(draftBucketFor([bucket(0, { body: ["face-0"] })], 0)).toBeNull();
  });

  it("returns null for a bucket with no classified faces", () => {
    expect(draftBucketFor([bucket(0, {})], 1)).toBeNull();
    expect(draftBucketFor([bucket(0, { side: [] })], 1)).toBeNull();
  });
});

describe("bandFaceIds", () => {
  it("unions every role's ids", () => {
    expect(bandFaceIds(bucket(0, { endCap: ["face-5"], side: ["face-6", "face-7"] }))).toEqual(
      new Set(["face-5", "face-6", "face-7"])
    );
  });
});

describe("previewBandLegend", () => {
  it("names the full-history op with the tint word and role summary", () => {
    expect(previewBandLegend(bucket(0, { endCap: ["face-5"], side: ["face-6"] }), 5, "green")).toBe(
      "Preview op 5 — green: end cap ×1, side walls ×1; grey: retained"
    );
  });

  it("uses 'highlighted' for neutral-tint bands", () => {
    expect(previewBandLegend(bucket(0, { band: ["face-3"] }), 1, "highlighted")).toBe(
      "Preview op 1 — highlighted: band ×1; grey: retained"
    );
  });
});

describe("tintDisplayName", () => {
  it("maps intent tints to colour words, undefined to highlighted", () => {
    expect(tintDisplayName("add")).toBe("green");
    expect(tintDisplayName("cut")).toBe("red");
    expect(tintDisplayName("ref")).toBe("blue");
    expect(tintDisplayName(undefined)).toBe("highlighted");
  });
});

describe("applyPreviewTint", () => {
  function faceMesh(entityId: string, colorHex: number): THREE.Mesh {
    const m = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({ color: colorHex })
    );
    m.userData.entityType = "surface";
    m.userData.entityId = entityId;
    return m;
  }

  function group(): { root: THREE.Group; band: THREE.Mesh; context: THREE.Mesh } {
    const root = new THREE.Group();
    const band = faceMesh("face-1", 0xffffff);
    const context = faceMesh("face-2", 0xffffff);
    root.add(band, context);
    return { root, band, context };
  }

  const matOf = (m: THREE.Mesh) => m.material as THREE.MeshStandardMaterial;

  it("band faces take the intent tint at full strength, context recedes to grey", () => {
    const { root, band, context } = group();
    applyPreviewTint(root, "add", new Set(["face-1"]));
    // Band: white lerped 0.65 toward green.
    const expectedBand = new THREE.Color(0xffffff).lerp(new THREE.Color(PREVIEW_TINTS.add), 0.65);
    expect(matOf(band).color.getHex()).toBe(expectedBand.getHex());
    expect(matOf(band).opacity).toBeCloseTo(0.75, 9);
    // Context: white lerped 0.55 toward grey, fainter.
    const expectedCtx = new THREE.Color(0xffffff).lerp(new THREE.Color(PREVIEW_CONTEXT_GREY), 0.55);
    expect(matOf(context).color.getHex()).toBe(expectedCtx.getHex());
    expect(matOf(context).opacity).toBeCloseTo(0.45, 9);
    expect(matOf(context).transparent).toBe(true);
  });

  it("null band reproduces the uniform treatment exactly", () => {
    const { root, band, context } = group();
    applyPreviewTint(root, "cut", null);
    const expected = new THREE.Color(0xffffff).lerp(new THREE.Color(PREVIEW_TINTS.cut), 0.65);
    expect(matOf(band).color.getHex()).toBe(expected.getHex());
    expect(matOf(context).color.getHex()).toBe(expected.getHex());
    expect(matOf(band).opacity).toBeCloseTo(0.75, 9);
    expect(matOf(context).opacity).toBeCloseTo(0.75, 9);
  });

  it("neutral tint keeps band colours, greys only the context", () => {
    const { root, band, context } = group();
    applyPreviewTint(root, undefined, new Set(["face-1"]));
    expect(matOf(band).color.getHex()).toBe(0xffffff);
    expect(matOf(band).opacity).toBeCloseTo(0.75, 9);
    expect(matOf(context).color.getHex()).not.toBe(0xffffff);
    expect(matOf(context).opacity).toBeCloseTo(0.45, 9);
  });

  it("composes with a user-set baseOpacity instead of clobbering it", () => {
    const { root, band } = group();
    matOf(band).userData.baseOpacity = 0.5;
    applyPreviewTint(root, "add", new Set(["face-1"]));
    expect(matOf(band).opacity).toBeCloseTo(0.5 * 0.75, 9);
  });

  it("ignores non-mesh objects", () => {
    const root = new THREE.Group();
    const line = new THREE.Line(new THREE.BufferGeometry());
    root.add(line);
    expect(() => applyPreviewTint(root, "add", new Set(["face-1"]))).not.toThrow();
  });
});
