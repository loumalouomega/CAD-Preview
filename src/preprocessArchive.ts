import { createHash } from "crypto";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";

/**
 * Pure (vscode-free, but Node-only — never imported by the webview) builder/
 * reader for the "preprocess archive" — a single `.zip` bundling the CAD
 * source file plus whichever of its parts/annotations/edits/mesh-options
 * sidecars currently exist, so the whole working state of a document can be
 * packaged and restored elsewhere. Mirrors the `*Sidecar.ts` convention: this
 * module only holds pure parse/serialize logic; `provider.ts`
 * (vscode.workspace.fs) and `mcpTools.ts` (node fs) each add their own I/O
 * around it. Uses Node's built-in `crypto.createHash("sha256")` for
 * per-entry checksums below — the same convention `stepPartsService.ts`
 * already established for verifying a downloaded standard part.
 */

/** The manifest schema version this writer produces. Bumped to 2 for the
 * "Archive integrity" roadmap item (closed): `minimumReaderVersion` +
 * per-entry `checksums` are new, additive fields. */
export const PREPROCESS_MANIFEST_VERSION = 2;

/** The newest manifest version THIS reader knows how to interpret. Distinct
 * from {@link PREPROCESS_MANIFEST_VERSION} on purpose — the writer constant
 * says what this build PRODUCES, this one says what it can CONSUME, so the
 * two can diverge cleanly if a future format ever needs a reader that's
 * ahead of (or deliberately behind) the writer. */
const READER_VERSION = 2;

/** Per-entry and archive-wide caps for {@link readPreprocessZip} (roadmap
 * "Preprocess archive hardening", closed) — bound how much memory a hostile
 * `.zip` can force `unzipSync` to allocate. `MAX_COMPRESSION_RATIO` is the
 * classic zip-bomb signal (a few KB of compressed data claiming to expand to
 * gigabytes); genuine STEP/JSON text under deflate rarely exceeds ~10x, so
 * 1000x has wide margin without ever tripping on real content. */
const MAX_ENTRY_UNCOMPRESSED_BYTES = 200 * 1024 * 1024; // 200 MB
const MAX_TOTAL_UNCOMPRESSED_BYTES = 500 * 1024 * 1024; // 500 MB
const MAX_COMPRESSION_RATIO = 1000;

/**
 * A zip entry name shaped like a bare filename — no path separators, no `.`/
 * `..` traversal segments. `manifest.source` must satisfy this: it's
 * documented as "the CAD source's original filename, e.g. bull.stp", and
 * both readers (`provider.ts`'s `loadPreprocessDialog`, which feeds it
 * straight into `vscode.Uri.joinPath(zipUri, "..", source)` as a save
 * dialog's default path) trust it completely. A manifest crafted with
 * `source: "../../../../home/user/.ssh/authorized_keys"` would otherwise
 * pre-populate that dialog pointing outside the archive's own directory —
 * user confirmation is the only remaining barrier, and a benign-looking
 * trailing filename can make the leading traversal easy to miss. Rejecting
 * outright (never "normalizing" a hostile value) is the safer invariant.
 */
function isSafeEntryName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface PreprocessManifest {
  version: number;
  /** The oldest {@link READER_VERSION} required to open this archive without
   * misinterpreting it — a forward-compatibility gate, not a backward one.
   * `1` for archives written before this field existed (every field this
   * reader added in v2 is purely additive, so a hypothetical old v1 reader
   * could still correctly extract everything it knew about from a v2
   * archive) — bump this only if a FUTURE format change is ever genuinely
   * breaking for an older reader. */
  minimumReaderVersion: number;
  /** The CAD source's original filename, e.g. "bull.stp" — also the key used
   * to derive every sidecar's zip entry name (`<source>.parts.json`, etc). */
  source: string;
  /** SHA-256 hex digest per entry name (excluding `manifest.json` itself),
   * for every entry the writer included — cryptographic tamper-evidence on
   * top of zip's own CRC32 (error-detection only, not integrity: it's not
   * designed to resist deliberate tampering). Absent entirely for a legacy
   * v1 archive, which never computed these — verification is skipped for
   * those, not treated as a failure. */
  checksums?: Record<string, string>;
}

/** Inputs for {@link buildPreprocessZip}. A sidecar field is included in the
 * archive only when its text is provided (`undefined` = doesn't exist on disk). */
export interface PreprocessArchiveInput {
  sourceName: string;
  source: Uint8Array;
  parts?: string;
  annotations?: string;
  edits?: string;
  meshOptions?: string;
}

export interface PreprocessArchiveContents {
  manifest: PreprocessManifest;
  source: Uint8Array;
  parts?: string;
  annotations?: string;
  edits?: string;
  meshOptions?: string;
}

/** Builds a `.zip` containing a `manifest.json` (with per-entry SHA-256
 * checksums) plus the CAD source and whichever sidecar texts were passed.
 * The generated `.geo` script is deliberately NOT packaged — the roadmap
 * "Archive integrity" item's own investigation found neither reader ever
 * restored it verbatim (mesh options are always re-written through
 * `writeMeshOptions()`/`writeGeoScript()`, which regenerates `.geo` fresh),
 * so packing it was pure dead weight. */
export function buildPreprocessZip(input: PreprocessArchiveInput): Uint8Array {
  const entries: Record<string, Uint8Array> = { [input.sourceName]: input.source };
  if (input.parts !== undefined) entries[`${input.sourceName}.parts.json`] = strToU8(input.parts);
  if (input.annotations !== undefined) entries[`${input.sourceName}.annotations.json`] = strToU8(input.annotations);
  if (input.edits !== undefined) entries[`${input.sourceName}.edits.json`] = strToU8(input.edits);
  if (input.meshOptions !== undefined) entries[`${input.sourceName}.mesh.json`] = strToU8(input.meshOptions);

  const checksums: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(entries)) checksums[name] = sha256Hex(bytes);

  const manifest: PreprocessManifest = {
    version: PREPROCESS_MANIFEST_VERSION,
    minimumReaderVersion: 1,
    source: input.sourceName,
    checksums,
  };
  const files: Record<string, Uint8Array> = { "manifest.json": strToU8(JSON.stringify(manifest, null, 2) + "\n"), ...entries };
  return zipSync(files, { level: 6 });
}

/**
 * Parses a `.zip` built by {@link buildPreprocessZip}. Throws when the
 * archive isn't structurally usable (missing manifest, the manifest's own
 * source entry is absent, an entry violates the size/ratio caps above,
 * `manifest.source` isn't a safe bare filename, the archive declares a
 * `minimumReaderVersion` newer than this build supports, or a present
 * entry's SHA-256 doesn't match its recorded checksum) — a missing
 * individual sidecar is not an error, it just means that piece of state
 * didn't exist when the archive was saved.
 *
 * The size/ratio filter runs BEFORE `unzipSync` inflates each entry (fflate
 * reads an entry's declared uncompressed size from the zip's central
 * directory and only calls `inflateSync` — the actual allocation — after the
 * filter returns `true`), so a filter that throws on an oversized/suspicious
 * entry stops the expensive decompression from ever happening, not just from
 * being returned — confirmed against the installed fflate version's source,
 * not assumed from its type declarations alone.
 */
export function readPreprocessZip(bytes: Uint8Array): PreprocessArchiveContents {
  let totalUncompressed = 0;
  const files = unzipSync(bytes, {
    filter(file) {
      if (file.originalSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
        throw new Error(
          `Preprocess archive entry "${file.name}" is too large (${file.originalSize} bytes, max ${MAX_ENTRY_UNCOMPRESSED_BYTES}).`
        );
      }
      const ratio = file.originalSize / Math.max(file.size, 1);
      if (ratio > MAX_COMPRESSION_RATIO) {
        throw new Error(
          `Preprocess archive entry "${file.name}" has a suspicious compression ratio (${ratio.toFixed(0)}x, max ${MAX_COMPRESSION_RATIO}x) — possible zip bomb.`
        );
      }
      totalUncompressed += file.originalSize;
      if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
        throw new Error(
          `Preprocess archive's total uncompressed size exceeds the ${MAX_TOTAL_UNCOMPRESSED_BYTES}-byte limit.`
        );
      }
      return true;
    },
  });
  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) throw new Error("Not a CAD Preview preprocess archive: missing manifest.json");
  const manifest = parseManifest(strFromU8(manifestBytes));

  if (manifest.minimumReaderVersion > READER_VERSION) {
    throw new Error(
      `This preprocess archive requires a newer version of CAD Preview to open (needs reader v${manifest.minimumReaderVersion}, this build supports up to v${READER_VERSION}).`
    );
  }

  const source = files[manifest.source];
  if (!source) throw new Error(`Preprocess archive is missing its source file "${manifest.source}"`);

  if (manifest.checksums) {
    for (const [name, bytes] of Object.entries(files)) {
      if (name === "manifest.json") continue;
      const expected = manifest.checksums[name];
      if (expected === undefined) continue; // an entry the manifest never claimed (e.g. a hand-added extra file) — not our concern
      const actual = sha256Hex(bytes);
      if (actual !== expected) {
        throw new Error(`Preprocess archive entry "${name}" failed its checksum — the archive may be corrupted or tampered with.`);
      }
    }
  }

  const readText = (name: string): string | undefined => {
    const entry = files[name];
    return entry ? strFromU8(entry) : undefined;
  };
  return {
    manifest,
    source,
    parts: readText(`${manifest.source}.parts.json`),
    annotations: readText(`${manifest.source}.annotations.json`),
    edits: readText(`${manifest.source}.edits.json`),
    meshOptions: readText(`${manifest.source}.mesh.json`),
  };
}

/** Tolerant parse, same discipline as every other sidecar in this codebase —
 * a missing/non-numeric `version` or `minimumReaderVersion` is treated as
 * "v1, before this field existed" (the v1→v2 migration this item asked
 * for), not an error; a missing/malformed `checksums` object is simply
 * absent (skips verification) rather than rejected. */
function parseManifest(text: string): PreprocessManifest {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Preprocess archive manifest.json is not valid JSON");
  }
  const raw = data as Partial<PreprocessManifest> | null;
  const source = raw?.source;
  if (typeof source !== "string" || !source) {
    throw new Error("Preprocess archive manifest.json is missing its source filename");
  }
  if (!isSafeEntryName(source)) {
    throw new Error(
      `Preprocess archive manifest.json's source "${source}" is not a valid bare filename (no path separators or "." /".." segments allowed).`
    );
  }
  const version = typeof raw?.version === "number" ? raw.version : 1;
  const minimumReaderVersion = typeof raw?.minimumReaderVersion === "number" ? raw.minimumReaderVersion : 1;
  const checksums =
    raw?.checksums && typeof raw.checksums === "object"
      ? Object.fromEntries(
          Object.entries(raw.checksums as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        )
      : undefined;
  return { version, minimumReaderVersion, source, checksums };
}
