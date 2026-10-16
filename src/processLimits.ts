/**
 * Bundled process-limits and build-plate table for `check_printability` —
 * pure (no fs, no vscode). The JSON ships as `dist/process-limits/
 * starter-limits.json` (copied by `esbuild.mjs`, like the mesh presets); the
 * caller can always pass explicit numbers instead, and those win. Every row
 * carries a `source` so a report can say where a number came from.
 */
import type { BuildPlate, ProcessLimits } from "./printability";

export const BUNDLED_PROCESS_LIMITS_FILE = "starter-limits.json";

export function bundledProcessLimitsPath(extensionPath: string): string {
  return `${extensionPath}/dist/process-limits/${BUNDLED_PROCESS_LIMITS_FILE}`;
}

export interface ProcessLimitsLibrary {
  processes: Record<string, ProcessLimits>;
  plates: Record<string, BuildPlate & { source: string }>;
}

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Tolerant parse: a bad row is dropped, never the file. */
export function parseProcessLimits(text: string): ProcessLimitsLibrary {
  const out: ProcessLimitsLibrary = { processes: {}, plates: {} };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return out;
  }
  if (!doc || typeof doc !== "object") return out;
  const d = doc as { processes?: Record<string, Record<string, unknown>>; plates?: Record<string, Record<string, unknown>> };
  for (const [name, row] of Object.entries(d.processes ?? {})) {
    if (!row || typeof row !== "object" || typeof row.source !== "string" || row.source.trim() === "") continue;
    const limits: ProcessLimits = { name, source: row.source };
    if (positive(row.minWallMm)) limits.minWallMm = row.minWallMm;
    if (positive(row.maxOverhangDeg) && row.maxOverhangDeg < 90) limits.maxOverhangDeg = row.maxOverhangDeg;
    if (limits.minWallMm === undefined && limits.maxOverhangDeg === undefined) continue;
    out.processes[name.toLowerCase()] = limits;
  }
  for (const [name, row] of Object.entries(d.plates ?? {})) {
    if (!row || typeof row !== "object" || typeof row.source !== "string") continue;
    if (positive(row.x) && positive(row.y) && positive(row.z)) out.plates[name.toLowerCase()] = { x: row.x, y: row.y, z: row.z, source: row.source };
  }
  return out;
}

/** A process by bundled name or inline numbers (inline numbers must state a basis or default to "caller-supplied"). */
export function resolveProcess(
  value: string | { name?: string; minWallMm?: number; maxOverhangDeg?: number; source?: string } | undefined,
  library: ProcessLimitsLibrary
): ProcessLimits | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const row = library.processes[value.trim().toLowerCase()];
    if (!row) throw new Error(`Unknown process "${value}" (bundled: ${Object.keys(library.processes).join(", ") || "none"}). Pass explicit minWallMm / maxOverhangDeg instead.`);
    return row;
  }
  if (value.minWallMm !== undefined && !positive(value.minWallMm)) throw new Error(`process.minWallMm must be a positive number (got ${value.minWallMm})`);
  if (value.maxOverhangDeg !== undefined && !(positive(value.maxOverhangDeg) && value.maxOverhangDeg < 90))
    throw new Error(`process.maxOverhangDeg must be between 0 and 90 (got ${value.maxOverhangDeg})`);
  if (value.minWallMm === undefined && value.maxOverhangDeg === undefined) throw new Error("A process needs minWallMm and/or maxOverhangDeg");
  return {
    name: value.name ?? "custom",
    ...(value.minWallMm !== undefined ? { minWallMm: value.minWallMm } : {}),
    ...(value.maxOverhangDeg !== undefined ? { maxOverhangDeg: value.maxOverhangDeg } : {}),
    source: value.source ?? "caller-supplied",
  };
}

export function resolvePlate(value: string | BuildPlate | undefined, library: ProcessLimitsLibrary): BuildPlate | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const row = library.plates[value.trim().toLowerCase()];
    if (!row) throw new Error(`Unknown build plate "${value}" (bundled: ${Object.keys(library.plates).join(", ") || "none"}). Pass {x, y, z} in mm instead.`);
    return { x: row.x, y: row.y, z: row.z };
  }
  if (!(positive(value.x) && positive(value.y) && positive(value.z))) throw new Error("plate needs positive x, y and z (mm)");
  return { x: value.x, y: value.y, z: value.z };
}
