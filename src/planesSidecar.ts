import type { ConstructionPlane } from "./protocol";

/** Pure (vscode-free) parse/serialize for the construction-planes sidecar — unit-testable. */

export const PLANES_SIDECAR_VERSION = 1;

interface SidecarFile {
  version: number;
  source: string;
  planes: ConstructionPlane[];
}

function asVec3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, z] = value;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

/**
 * Normalizes a stored normal, or `null` if it is degenerate.
 *
 * A zero-length normal describes no plane at all, so it drops that plane
 * rather than being stored as-is — the same per-field tolerance
 * `annotationsSidecar.ts`'s `asTolerance` applies. Normalizing on READ (rather
 * than trusting the file) means a hand-edited sidecar with a convenient
 * `[0, 0, 10]` still yields a usable unit normal.
 */
function asUnitNormal(value: unknown): [number, number, number] | null {
  const n = asVec3(value);
  if (!n) return null;
  const len = Math.hypot(n[0], n[1], n[2]);
  if (!Number.isFinite(len) || len < 1e-12) return null;
  return [n[0] / len, n[1] / len, n[2] / len];
}

/**
 * Parses + validates sidecar JSON into a clean `ConstructionPlane[]`. Tolerant,
 * same discipline as `parsePartsJson`/`parseAnnotationsJson`: a malformed entry
 * is dropped individually rather than throwing, so a hand-edited or
 * partially-corrupt sidecar never blocks opening the model.
 */
export function parsePlanesJson(text: string): ConstructionPlane[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const rawPlanes = (data as Partial<SidecarFile> | null)?.planes;
  if (!Array.isArray(rawPlanes)) return [];

  const planes: ConstructionPlane[] = [];
  for (const raw of rawPlanes) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Partial<ConstructionPlane>;
    if (typeof p.id !== "string" || !p.id) continue;
    const point = asVec3(p.point);
    if (!point) continue;
    const normal = asUnitNormal(p.normal);
    if (!normal) continue;
    planes.push({
      id: p.id,
      name: typeof p.name === "string" && p.name ? p.name : p.id,
      point,
      normal,
      derivedFrom: typeof p.derivedFrom === "string" && p.derivedFrom ? p.derivedFrom : undefined,
    });
  }
  return planes;
}

/** Serializes planes to the sidecar JSON text (pretty-printed, trailing newline). */
export function serializePlanesJson(sourceName: string, planes: ConstructionPlane[]): string {
  const file: SidecarFile = { version: PLANES_SIDECAR_VERSION, source: sourceName, planes };
  return JSON.stringify(file, null, 2) + "\n";
}

/**
 * The next free `plane-N` id for a set of existing planes.
 *
 * Ids are never reused: the highest existing N plus one, so deleting a plane
 * and creating another does not resurrect the old id under a new meaning. That
 * matters because `derivedFrom` strings and any future op reference would
 * otherwise silently retarget.
 */
export function nextPlaneId(planes: readonly ConstructionPlane[]): string {
  let max = -1;
  for (const p of planes) {
    const m = /^plane-(\d+)$/.exec(p.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `plane-${max + 1}`;
}
