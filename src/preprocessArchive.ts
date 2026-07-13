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
 * archive isn't structurally usable (missing manifest, or the manifest's own
 * source entry is absent) — a missing individual sidecar is not an error,
 * it just means that piece of state didn't exist when the archive was saved.
 */
export function readPreprocessZip(bytes: Uint8Array): PreprocessArchiveContents {
  const files = unzipSync(bytes);
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
  const version = (data as Partial<PreprocessManifest>).version;
  return { version: typeof version === "number" ? version : PREPROCESS_MANIFEST_VERSION, source };
}
