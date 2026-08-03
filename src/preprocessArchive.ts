import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";

/**
 * Pure (vscode-free) builder/reader for the "preprocess archive" — a single
 * `.zip` bundling the CAD source file plus whichever of its
 * parts/edits/mesh-options/geo sidecars currently exist, so the whole working
 * state of a document can be packaged and restored elsewhere. Mirrors the
 * `*Sidecar.ts` convention: this module only holds pure parse/serialize
 * logic; `provider.ts` (vscode.workspace.fs) and `mcpTools.ts` (node fs) each
 * add their own I/O around it.
 */

export const PREPROCESS_MANIFEST_VERSION = 1;

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

export interface PreprocessManifest {
  version: number;
  /** The CAD source's original filename, e.g. "bull.stp" — also the key used
   * to derive every sidecar's zip entry name (`<source>.parts.json`, etc). */
  source: string;
}

/** Inputs for {@link buildPreprocessZip}. A sidecar field is included in the
 * archive only when its text is provided (`undefined` = doesn't exist on disk). */
export interface PreprocessArchiveInput {
  sourceName: string;
  source: Uint8Array;
  parts?: string;
  edits?: string;
  meshOptions?: string;
  geo?: string;
}

export interface PreprocessArchiveContents {
  manifest: PreprocessManifest;
  source: Uint8Array;
  parts?: string;
  edits?: string;
  meshOptions?: string;
  geo?: string;
}

/** Builds a `.zip` containing a `manifest.json` plus the CAD source and
 * whichever sidecar texts were passed. */
export function buildPreprocessZip(input: PreprocessArchiveInput): Uint8Array {
  const manifest: PreprocessManifest = { version: PREPROCESS_MANIFEST_VERSION, source: input.sourceName };
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2) + "\n"),
    [input.sourceName]: input.source,
  };
  if (input.parts !== undefined) files[`${input.sourceName}.parts.json`] = strToU8(input.parts);
  if (input.edits !== undefined) files[`${input.sourceName}.edits.json`] = strToU8(input.edits);
  if (input.meshOptions !== undefined) files[`${input.sourceName}.mesh.json`] = strToU8(input.meshOptions);
  if (input.geo !== undefined) files[`${input.sourceName}.geo`] = strToU8(input.geo);
  return zipSync(files, { level: 6 });
}

/**
 * Parses a `.zip` built by {@link buildPreprocessZip}. Throws only when the
 * archive isn't structurally usable (missing manifest, the manifest's own
 * source entry is absent, an entry violates the size/ratio caps above, or
 * `manifest.source` isn't a safe bare filename) — a missing individual
 * sidecar is not an error, it just means that piece of state didn't exist
 * when the archive was saved.
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

  const source = files[manifest.source];
  if (!source) throw new Error(`Preprocess archive is missing its source file "${manifest.source}"`);

  const readText = (name: string): string | undefined => {
    const entry = files[name];
    return entry ? strFromU8(entry) : undefined;
  };
  return {
    manifest,
    source,
    parts: readText(`${manifest.source}.parts.json`),
    edits: readText(`${manifest.source}.edits.json`),
    meshOptions: readText(`${manifest.source}.mesh.json`),
    geo: readText(`${manifest.source}.geo`),
  };
}

function parseManifest(text: string): PreprocessManifest {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Preprocess archive manifest.json is not valid JSON");
  }
  const source = (data as Partial<PreprocessManifest> | null)?.source;
  if (typeof source !== "string" || !source) {
    throw new Error("Preprocess archive manifest.json is missing its source filename");
  }
  if (!isSafeEntryName(source)) {
    throw new Error(
      `Preprocess archive manifest.json's source "${source}" is not a valid bare filename (no path separators or "." /".." segments allowed).`
    );
  }
  const version = (data as Partial<PreprocessManifest>).version;
  return { version: typeof version === "number" ? version : PREPROCESS_MANIFEST_VERSION, source };
}
