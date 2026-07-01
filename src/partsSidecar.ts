import type { Part } from "./protocol";

/** Pure (vscode-free) parse/serialize for the parts sidecar — unit-testable. */

export const SIDECAR_VERSION = 1;

interface SidecarFile {
  version: number;
  source: string;
  parts: Part[];
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Parses + validates sidecar JSON into a clean `Part[]`. Tolerant: unknown or
 * malformed entries are dropped rather than throwing, so a hand-edited or
 * partially-corrupt sidecar never blocks opening the model.
 */
export function parsePartsJson(text: string): Part[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const rawParts = (data as Partial<SidecarFile> | null)?.parts;
  if (!Array.isArray(rawParts)) return [];

  const parts: Part[] = [];
  for (const raw of rawParts) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Partial<Part>;
    if (typeof p.name !== "string" || typeof p.color !== "string") continue;
    parts.push({
      name: p.name,
      color: p.color,
      volumes: asStringArray(p.volumes),
      surfaces: asStringArray(p.surfaces),
      lines: asStringArray(p.lines),
      points: asStringArray(p.points), // [] for sidecars written before points existed
    });
  }
  return parts;
}

/** Serializes parts to the sidecar JSON text (pretty-printed, trailing newline). */
export function serializePartsJson(sourceName: string, parts: Part[]): string {
  const file: SidecarFile = { version: SIDECAR_VERSION, source: sourceName, parts };
  return JSON.stringify(file, null, 2) + "\n";
}
