import { describe, it, expect } from "vitest";
import { strToU8, unzipSync, zipSync, strFromU8 } from "fflate";
import { buildPreprocessZip, readPreprocessZip, PREPROCESS_MANIFEST_VERSION } from "./preprocessArchive";

const SOURCE_BYTES = new Uint8Array([1, 2, 3, 4, 5]);

describe("buildPreprocessZip", () => {
  it("always includes the manifest and source, omitting absent sidecars", () => {
    const zip = buildPreprocessZip({ sourceName: "model.stp", source: SOURCE_BYTES });
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(["manifest.json", "model.stp"]);
    expect(files["model.stp"]).toEqual(SOURCE_BYTES);
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    expect(manifest.version).toBe(PREPROCESS_MANIFEST_VERSION);
    expect(manifest.minimumReaderVersion).toBe(1);
    expect(manifest.source).toBe("model.stp");
    expect(Object.keys(manifest.checksums)).toEqual(["model.stp"]);
  });

  it("includes every provided sidecar under <source>.<ext>, and never packages .geo", () => {
    const zip = buildPreprocessZip({
      sourceName: "model.stp",
      source: SOURCE_BYTES,
      parts: '{"parts":[]}',
      annotations: '{"annotations":[]}',
      edits: '{"ops":[]}',
      meshOptions: '{"options":{}}',
    });
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual([
      "manifest.json",
      "model.stp",
      "model.stp.annotations.json",
      "model.stp.edits.json",
      "model.stp.mesh.json",
      "model.stp.parts.json",
    ]);
    expect(strFromU8(files["model.stp.parts.json"])).toBe('{"parts":[]}');
    expect(strFromU8(files["model.stp.annotations.json"])).toBe('{"annotations":[]}');
    expect(strFromU8(files["model.stp.edits.json"])).toBe('{"ops":[]}');
    expect(strFromU8(files["model.stp.mesh.json"])).toBe('{"options":{}}');
  });

  it("records a SHA-256 checksum for every included entry", () => {
    const zip = buildPreprocessZip({ sourceName: "model.stp", source: SOURCE_BYTES, parts: '{"parts":[]}' });
    const files = unzipSync(zip);
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    expect(Object.keys(manifest.checksums).sort()).toEqual(["model.stp", "model.stp.parts.json"]);
    expect(manifest.checksums["model.stp"]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("readPreprocessZip", () => {
  it("round-trips everything buildPreprocessZip wrote", () => {
    const built = buildPreprocessZip({
      sourceName: "cube.stl",
      source: SOURCE_BYTES,
      parts: '{"parts":[]}',
      annotations: '{"annotations":[]}',
      edits: '{"ops":[]}',
      meshOptions: '{"options":{}}',
    });
    const contents = readPreprocessZip(built);
    expect(contents.manifest.version).toBe(PREPROCESS_MANIFEST_VERSION);
    expect(contents.manifest.source).toBe("cube.stl");
    expect(contents.source).toEqual(SOURCE_BYTES);
    expect(contents.parts).toBe('{"parts":[]}');
    expect(contents.annotations).toBe('{"annotations":[]}');
    expect(contents.edits).toBe('{"ops":[]}');
    expect(contents.meshOptions).toBe('{"options":{}}');
  });

  it("leaves absent sidecars undefined rather than throwing", () => {
    const built = buildPreprocessZip({ sourceName: "model.stp", source: SOURCE_BYTES });
    const contents = readPreprocessZip(built);
    expect(contents.parts).toBeUndefined();
    expect(contents.annotations).toBeUndefined();
    expect(contents.edits).toBeUndefined();
    expect(contents.meshOptions).toBeUndefined();
  });

  it("throws when manifest.json is missing", () => {
    const zip = zipSync({ "model.stp": SOURCE_BYTES });
    expect(() => readPreprocessZip(zip)).toThrow(/missing manifest\.json/i);
  });

  it("throws when manifest.json is corrupt", () => {
    const zip = zipSync({ "manifest.json": strToU8("{not json"), "model.stp": SOURCE_BYTES });
    expect(() => readPreprocessZip(zip)).toThrow(/not valid JSON/i);
  });

  it("throws when the manifest's source filename is missing/blank", () => {
    const zip = zipSync({ "manifest.json": strToU8(JSON.stringify({ version: 1 })), "model.stp": SOURCE_BYTES });
    expect(() => readPreprocessZip(zip)).toThrow(/missing its source filename/i);
  });

  it("throws when the manifest's referenced source entry is absent from the zip", () => {
    const zip = zipSync({
      "manifest.json": strToU8(JSON.stringify({ version: 1, source: "model.stp" })),
    });
    expect(() => readPreprocessZip(zip)).toThrow(/missing its source file/i);
  });

  it("defaults a missing manifest version/minimumReaderVersion to 1 (the pre-versioning legacy shape)", () => {
    const zip = zipSync({
      "manifest.json": strToU8(JSON.stringify({ source: "model.stp" })),
      "model.stp": SOURCE_BYTES,
    });
    const manifest = readPreprocessZip(zip).manifest;
    expect(manifest.version).toBe(1);
    expect(manifest.minimumReaderVersion).toBe(1);
    expect(manifest.checksums).toBeUndefined();
  });

  describe("archive integrity (roadmap 'Archive integrity', closed)", () => {
    it("verifies per-entry SHA-256 checksums and rejects a tampered entry", () => {
      const built = buildPreprocessZip({ sourceName: "model.stp", source: SOURCE_BYTES });
      const files = unzipSync(built);
      files["model.stp"] = new Uint8Array([...files["model.stp"], 0xff]); // corrupt the source bytes
      const tampered = zipSync(files);
      expect(() => readPreprocessZip(tampered)).toThrow(/checksum/i);
    });

    it("accepts a genuine archive built by buildPreprocessZip (checksums match)", () => {
      const built = buildPreprocessZip({ sourceName: "model.stp", source: SOURCE_BYTES, parts: '{"parts":[]}' });
      expect(() => readPreprocessZip(built)).not.toThrow();
    });

    it("skips checksum verification entirely for a legacy archive with no checksums field", () => {
      const zip = zipSync({
        "manifest.json": strToU8(JSON.stringify({ version: 1, source: "model.stp" })),
        "model.stp": new Uint8Array([9, 9, 9]), // whatever bytes — nothing to compare against
      });
      expect(() => readPreprocessZip(zip)).not.toThrow();
    });

    it("rejects an archive whose minimumReaderVersion exceeds this reader's capability", () => {
      const zip = zipSync({
        "manifest.json": strToU8(JSON.stringify({ version: 99, minimumReaderVersion: 99, source: "model.stp" })),
        "model.stp": SOURCE_BYTES,
      });
      expect(() => readPreprocessZip(zip)).toThrow(/newer version of CAD Preview/i);
    });

    it("a legacy v1 archive (no minimumReaderVersion field at all) still opens", () => {
      const zip = zipSync({
        "manifest.json": strToU8(JSON.stringify({ version: 1, source: "model.stp" })),
        "model.stp": SOURCE_BYTES,
      });
      expect(() => readPreprocessZip(zip)).not.toThrow();
    });
  });

  describe("hardening (roadmap 'Preprocess archive hardening', closed)", () => {
    it.each([
      "../../../.ssh/authorized_keys",
      "../evil.stp",
      "a/b.stp",
      "a\\b.stp",
      "..",
      ".",
      "",
    ])("rejects a manifest source of %j as unsafe", (source) => {
      const zip = zipSync({
        "manifest.json": strToU8(JSON.stringify({ version: 1, source })),
        "model.stp": SOURCE_BYTES,
      });
      expect(() => readPreprocessZip(zip)).toThrow(/valid bare filename|missing its source filename/i);
    });

    it("accepts an ordinary bare filename", () => {
      const built = buildPreprocessZip({ sourceName: "bull.stp", source: SOURCE_BYTES });
      expect(() => readPreprocessZip(built)).not.toThrow();
    });

    it("rejects an entry whose declared uncompressed size exceeds the per-entry cap", () => {
      // A real >200MB payload would be slow to build/compress in a unit test —
      // fflate's filter fires from the entry's DECLARED size in the zip's
      // central directory, before any inflation, so a hand-crafted local
      // zip with a tiny real payload but an inflated declared size exercises
      // the same code path without needing 200MB of real data. Simplest way
      // to get a mismatched declared size: zip a real large-ish buffer, then
      // patch the local + central directory uncompressed-size fields.
      const bigButReal = new Uint8Array(1024).fill(1); // compresses trivially (all-1s)
      const zip = zipSync(
        {
          "manifest.json": strToU8(JSON.stringify({ version: 1, source: "model.stp" })),
          "model.stp": bigButReal,
        },
        { level: 0 } // store (no compression) — makes the byte offsets below predictable
      );
      const patched = new Uint8Array(zip);
      // Every little-endian uint32 "1024" (the real uncompressed size) becomes
      // a value comfortably over MAX_ENTRY_UNCOMPRESSED_BYTES, in every local
      // file header + central directory record that declares it.
      const from = new DataView(new ArrayBuffer(4));
      from.setUint32(0, 1024, true);
      const fromBytes = new Uint8Array(from.buffer);
      const to = new DataView(new ArrayBuffer(4));
      to.setUint32(0, 300 * 1024 * 1024, true);
      const toBytes = new Uint8Array(to.buffer);
      for (let i = 0; i <= patched.length - 4; i++) {
        if (fromBytes.every((b, j) => patched[i + j] === b)) {
          patched.set(toBytes, i);
        }
      }
      expect(() => readPreprocessZip(patched)).toThrow(/too large/i);
    });
  });
});
