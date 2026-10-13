import { isValidScadName, type ScadValue } from "./scadParams";

/** Pure (vscode-free) parse/serialize for the OpenSCAD Customizer overrides sidecar — unit-testable. */

export const SCAD_OVERRIDES_SIDECAR_VERSION = 1;

interface SidecarFile {
  version: number;
  source: string;
  overrides: Record<string, unknown>;
}

function asScadValue(value: unknown): ScadValue | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const out: Array<number | string> = [];
    for (const v of value) {
      if (typeof v === "number" && Number.isFinite(v)) out.push(v);
      else if (typeof v === "string") out.push(v);
      else return null;
    }
    return out;
  }
  return null;
}

/**
 * Parses + validates sidecar JSON into clean overrides. Tolerant, same
 * discipline as `parsePartsJson`/`parsePlanesJson`: a malformed entry is
 * dropped individually rather than throwing, so a hand-edited or
 * partially-corrupt sidecar never blocks opening the model.
 */
export function parseScadOverridesJson(text: string): Record<string, ScadValue> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {};
  }
  const raw = (data as Partial<SidecarFile> | null)?.overrides;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, ScadValue> = {};
  for (const [name, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    if (!isValidScadName(name)) continue;
    const value = asScadValue(rawValue);
    if (value === null) continue;
    out[name] = value;
  }
  return out;
}

/** Serializes overrides to the sidecar JSON text (pretty-printed, trailing newline). */
export function serializeScadOverridesJson(sourceName: string, overrides: Record<string, ScadValue>): string {
  const file: SidecarFile = { version: SCAD_OVERRIDES_SIDECAR_VERSION, source: sourceName, overrides };
  return JSON.stringify(file, null, 2) + "\n";
}
