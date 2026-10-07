/** Shared, WASM-free MMG boundary: lengths are in source units except hausd
 * when hausdRelative is true (the default: 0.5% of the bbox diagonal). */
export interface MmgOptions {
  hausd?: number;
  hausdRelative?: boolean;
  hmin?: number;
  hmax?: number;
  hgrad?: number;
}

export const MMG_MEMORY_MB = 128;

export function validateMmgOptions(value: unknown): MmgOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MMG options must be an object");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!["hausd", "hausdRelative", "hmin", "hmax", "hgrad"].includes(key)) throw new Error(`Unknown MMG option: ${key}`);
  const result: MmgOptions = {};
  for (const key of ["hausd", "hmin", "hmax", "hgrad"] as const) {
    const n = raw[key];
    if (n === undefined) continue;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || (key === "hgrad" && n < 1)) throw new Error(`MMG ${key} must be finite and ${key === "hgrad" ? ">= 1" : "positive"}`);
    result[key] = n;
  }
  if (raw.hausdRelative !== undefined) {
    if (typeof raw.hausdRelative !== "boolean") throw new Error("MMG hausdRelative must be boolean");
    result.hausdRelative = raw.hausdRelative;
  }
  if (result.hmin !== undefined && result.hmax !== undefined && result.hmin > result.hmax) throw new Error("MMG hmin must not exceed hmax");
  return result;
}
