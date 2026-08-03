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
    expect(JSON.parse(strFromU8(files["manifest.json"]))).toEqual({
      version: PREPROCESS_MANIFEST_VERSION,
      source: "model.stp",
    });
  });

  it("includes every provided sidecar under <source>.<ext>", () => {
    const zip = buildPreprocessZip({
      sourceName: "model.stp",
      source: SOURCE_BYTES,
      parts: '{"parts":[]}',
      edits: '{"ops":[]}',
      meshOptions: '{"options":{}}',
      geo: "Merge \"model.stp\";\n",
    });
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual([
      "manifest.json",
      "model.stp",
      "model.stp.edits.json",
      "model.stp.geo",
      "model.stp.mesh.json",
      "model.stp.parts.json",
    ]);
    expect(strFromU8(files["model.stp.parts.json"])).toBe('{"parts":[]}');
    expect(strFromU8(files["model.stp.edits.json"])).toBe('{"ops":[]}');
    expect(strFromU8(files["model.stp.mesh.json"])).toBe('{"options":{}}');
    expect(strFromU8(files["model.stp.geo"])).toBe("Merge \"model.stp\";\n");
  });
});

describe("readPreprocessZip", () => {
  it("round-trips everything buildPreprocessZip wrote", () => {
    const built = buildPreprocessZip({
      sourceName: "cube.stl",
      source: SOURCE_BYTES,
      parts: '{"parts":[]}',
      edits: '{"ops":[]}',
      meshOptions: '{"options":{}}',
      geo: "Merge \"cube.stl\";\n",
    });
    const contents = readPreprocessZip(built);
    expect(contents.manifest).toEqual({ version: PREPROCESS_MANIFEST_VERSION, source: "cube.stl" });
    expect(contents.source).toEqual(SOURCE_BYTES);
    expect(contents.parts).toBe('{"parts":[]}');
    expect(contents.edits).toBe('{"ops":[]}');
    expect(contents.meshOptions).toBe('{"options":{}}');
    expect(contents.geo).toBe("Merge \"cube.stl\";\n");
  });

  it("leaves absent sidecars undefined rather than throwing", () => {
    const built = buildPreprocessZip({ sourceName: "model.stp", source: SOURCE_BYTES });
    const contents = readPreprocessZip(built);
    expect(contents.parts).toBeUndefined();
    expect(contents.edits).toBeUndefined();
    expect(contents.meshOptions).toBeUndefined();
    expect(contents.geo).toBeUndefined();
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

  it("defaults a missing manifest version to PREPROCESS_MANIFEST_VERSION", () => {
    const zip = zipSync({
      "manifest.json": strToU8(JSON.stringify({ source: "model.stp" })),
      "model.stp": SOURCE_BYTES,
    });
    expect(readPreprocessZip(zip).manifest.version).toBe(PREPROCESS_MANIFEST_VERSION);
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
