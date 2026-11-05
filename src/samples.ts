/**
 * Bundled sample models ("Open Sample…"). Pure and vscode-free: the index is
 * `samples/index.json` (staged to `dist/samples/` by `esbuild.mjs`'s
 * `copySamples()`), and this module is its tolerance gate.
 *
 * Samples ship from `dist/samples/`, never from `examples/` (the VSIX forbids
 * `examples/`), and are only ever COPIED into a folder the user picks —
 * opening the bundled original would write `.edits.json` / `.view.json`
 * sidecars inside the extension directory.
 */
import * as path from "path";

export interface Sample {
  /** Bare file name inside `dist/samples/` and in the destination folder. */
  file: string;
  label: string;
  description: string;
}

/** Directory the samples are staged in, beside the other bundled data. */
export function bundledSamplesDir(extensionPath: string): string {
  return path.join(extensionPath, "dist", "samples");
}

/** True for a bare, non-hidden file name (no separators, no traversal). */
export function isSafeSampleName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 80 && !/[\\/\u0000-\u001f]/.test(name) && !name.startsWith(".") && name !== "index.json";
}

/** Tolerant parse of the index: drops entries with an unsafe name or no label, never throws. */
export function parseSampleIndex(text: string): Sample[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const list = (raw as { samples?: unknown } | null)?.samples;
  if (!Array.isArray(list)) return [];
  const out: Sample[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (!isSafeSampleName(o.file) || seen.has(o.file)) continue;
    if (typeof o.label !== "string" || o.label.trim() === "") continue;
    seen.add(o.file);
    out.push({ file: o.file, label: o.label.trim(), description: typeof o.description === "string" ? o.description : "" });
  }
  return out;
}
