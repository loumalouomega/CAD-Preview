import type { Annotation, MeasureTool } from "./protocol";

/** Pure (vscode-free) parse/serialize for the annotations sidecar — unit-testable. */

export const SIDECAR_VERSION = 1;

interface SidecarFile {
  version: number;
  source: string;
  annotations: Annotation[];
}

const MEASURE_TOOLS: readonly MeasureTool[] = ["distance", "edgeLength", "angle", "radius"];

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function asVec3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, z] = value;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

function asLinePoints(value: unknown): [number, number, number][] {
  if (!Array.isArray(value)) return [];
  const out: [number, number, number][] = [];
  for (const v of value) {
    const p = asVec3(v);
    if (p) out.push(p);
  }
  return out;
}

/**
 * Parses + validates sidecar JSON into a clean `Annotation[]`. Tolerant, same
 * discipline as `parsePartsJson`: unknown/malformed entries are dropped
 * rather than throwing, so a hand-edited or partially-corrupt sidecar never
 * blocks opening the model.
 */
export function parseAnnotationsJson(text: string): Annotation[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const rawAnnotations = (data as Partial<SidecarFile> | null)?.annotations;
  if (!Array.isArray(rawAnnotations)) return [];

  const annotations: Annotation[] = [];
  for (const raw of rawAnnotations) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Partial<Annotation>;
    if (typeof a.id !== "string" || !a.id) continue;
    if (typeof a.tool !== "string" || !MEASURE_TOOLS.includes(a.tool as MeasureTool)) continue;
    if (typeof a.text !== "string") continue;
    const anchorPoint = asVec3(a.anchorPoint);
    if (!anchorPoint) continue;
    annotations.push({
      id: a.id,
      tool: a.tool as MeasureTool,
      label: typeof a.label === "string" && a.label ? a.label : undefined,
      text: a.text,
      anchorPoint,
      linePoints: asLinePoints(a.linePoints),
      volumes: asStringArray(a.volumes),
      surfaces: asStringArray(a.surfaces),
      lines: asStringArray(a.lines),
      points: asStringArray(a.points),
    });
  }
  return annotations;
}

/** Serializes annotations to the sidecar JSON text (pretty-printed, trailing newline). */
export function serializeAnnotationsJson(sourceName: string, annotations: Annotation[]): string {
  const file: SidecarFile = { version: SIDECAR_VERSION, source: sourceName, annotations };
  return JSON.stringify(file, null, 2) + "\n";
}
