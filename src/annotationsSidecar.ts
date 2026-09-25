import type { Annotation, AnnotationTool } from "./protocol";
import type { AnnotatedTolerance } from "./toleranceBand";

/** Pure (vscode-free) parse/serialize for the annotations sidecar — unit-testable. */

export const SIDECAR_VERSION = 1;

interface SidecarFile {
  version: number;
  source: string;
  annotations: Annotation[];
}

/** Every `Annotation.tool` the sidecar accepts — the four measurement kinds
 * plus the free-text `"note"`. Shared with `pin_annotation`. */
export const ANNOTATION_TOOLS: readonly AnnotationTool[] = ["distance", "edgeLength", "angle", "radius", "note"];

/** Longest note text kept (a note is a label on a model, not a document). */
export const MAX_NOTE_LENGTH = 500;

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
 * Tolerantly parses an annotation's optional tolerance band. A malformed band
 * (any field missing/non-numeric/non-finite, or a negative allowance) drops
 * the BAND only — the annotation itself survives, rendering exactly like a
 * plain untoleranced pin.
 */
function asTolerance(value: unknown): AnnotatedTolerance | undefined {
  if (!value || typeof value !== "object") return undefined;
  const t = value as Partial<AnnotatedTolerance>;
  const fields = [t.nominal, t.plus, t.minus, t.measured];
  if (!fields.every((v) => typeof v === "number" && Number.isFinite(v))) return undefined;
  if ((t.plus as number) < 0 || (t.minus as number) < 0) return undefined;
  return { nominal: t.nominal as number, plus: t.plus as number, minus: t.minus as number, measured: t.measured as number };
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
    if (typeof a.tool !== "string" || !ANNOTATION_TOOLS.includes(a.tool as AnnotationTool)) continue;
    if (typeof a.text !== "string") continue;
    const anchorPoint = asVec3(a.anchorPoint);
    if (!anchorPoint) continue;
    // A note is text at a point: no measured line, no band. An empty note
    // describes nothing and is dropped.
    const isNote = a.tool === "note";
    if (isNote && !a.text.trim()) continue;
    annotations.push({
      id: a.id,
      tool: a.tool as AnnotationTool,
      label: typeof a.label === "string" && a.label ? a.label : undefined,
      text: a.text,
      anchorPoint,
      linePoints: isNote ? [] : asLinePoints(a.linePoints),
      volumes: asStringArray(a.volumes),
      surfaces: asStringArray(a.surfaces),
      lines: asStringArray(a.lines),
      points: asStringArray(a.points),
      tolerance: isNote ? undefined : asTolerance(a.tolerance),
    });
  }
  return annotations;
}

/** Serializes annotations to the sidecar JSON text (pretty-printed, trailing newline). */
export function serializeAnnotationsJson(sourceName: string, annotations: Annotation[]): string {
  const file: SidecarFile = { version: SIDECAR_VERSION, source: sourceName, annotations };
  return JSON.stringify(file, null, 2) + "\n";
}
