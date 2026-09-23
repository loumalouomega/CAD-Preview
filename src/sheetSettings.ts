/**
 * Drawing-sheet settings — the ONE resolver both the interactive Export
 * Drawing Sheet form and the `export_drawing_sheet` MCP tool call (roadmap
 * "Drawing-sheet settings and reusable templates"), so identical settings
 * produce identical layouts by construction. Pure: views resolve through
 * `viewDirections.ts`, constants through `drawingSheet.ts`.
 *
 * Precedence: an explicit input field wins over the template's, which wins
 * over the defaults. Every invalid value falls back with a warning, never a
 * throw — except a sheet with no usable view at all.
 */
import {
  PAPER_SIZES,
  PROJECTION_METHODS,
  STANDARD_SCALES,
  scaleLabel,
  type PaperSize,
  type ProjectionMethod,
  type TitleBlockFields,
} from "./drawingSheet";
import { NAMED_VIEW_NAMES, resolveNamedView } from "./viewDirections";

type Vec3 = [number, number, number];

export const DEFAULT_SHEET_VIEWS: readonly string[] = ["front", "top", "right", "iso"];

export interface SheetSettingsInput {
  views?: string[];
  format?: string;
  paper?: string;
  projection?: string;
  /** Sheet mm per model mm, or a ratio string ("1:2", "2:1"). */
  scale?: number | string;
  title?: string;
  fields?: TitleBlockFields;
}

export interface ResolvedSheetSettings {
  views: Array<{ name: string; direction: Vec3; up?: Vec3 }>;
  format: "svg" | "dxf";
  paper: PaperSize;
  projection: ProjectionMethod;
  scale: number | undefined;
  title: string;
  fields: TitleBlockFields | undefined;
  warnings: string[];
}

/** "1:2" → 0.5, "2:1" → 2, "0.5" → 0.5; null for anything else. */
export function parseScale(raw: number | string | undefined): number | null {
  if (raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(raw);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    return a > 0 && b > 0 ? a / b : null;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && raw.trim() !== "" ? n : null;
}

/** The standard ISO 5455 scales as ratio labels, largest first. */
export const STANDARD_SCALE_LABELS: readonly string[] = STANDARD_SCALES.map(scaleLabel);

function cleanFields(f: TitleBlockFields | undefined): TitleBlockFields | undefined {
  if (!f) return undefined;
  const out: TitleBlockFields = {};
  for (const k of ["author", "drawingNumber", "revision", "material"] as const) {
    const v = f[k];
    if (typeof v === "string" && v.trim() !== "") out[k] = v.trim().slice(0, 120);
  }
  return Object.keys(out).length ? out : undefined;
}

export function resolveSheetSettings(
  input: SheetSettingsInput,
  template: SheetSettingsInput | undefined,
  defaults: { title: string }
): ResolvedSheetSettings {
  const warnings: string[] = [];
  const pick = <K extends keyof SheetSettingsInput>(k: K) => (input[k] !== undefined ? input[k] : template?.[k]);

  const views: ResolvedSheetSettings["views"] = [];
  for (const requested of pick("views") ?? DEFAULT_SHEET_VIEWS) {
    const named = resolveNamedView(requested);
    if (!named) {
      warnings.push(`Unknown view "${requested}" — valid: ${NAMED_VIEW_NAMES.join(", ")}. Skipped.`);
      continue;
    }
    if (views.some((v) => v.name === named.canonical)) {
      warnings.push(`View "${requested}" is repeated — drawn once.`);
      continue;
    }
    views.push({ name: named.canonical, direction: named.direction, ...(named.up ? { up: named.up } : {}) });
  }
  if (views.length === 0) throw new Error("No usable view was given — a drawing sheet needs at least one named view.");

  const rawFormat = pick("format");
  const format = rawFormat === "dxf" ? "dxf" : "svg";
  if (rawFormat != null && rawFormat !== "svg" && rawFormat !== "dxf") warnings.push(`Unknown format "${rawFormat}" — valid: svg, dxf. Falling back to "svg".`);

  let paper: PaperSize = "fit";
  const rawPaper = pick("paper");
  if (rawPaper != null) {
    if ((PAPER_SIZES as readonly string[]).includes(rawPaper)) paper = rawPaper as PaperSize;
    else warnings.push(`Unknown paper "${rawPaper}" — valid: ${PAPER_SIZES.join(", ")}. Falling back to "fit".`);
  }
  let projection: ProjectionMethod = "first";
  const rawProjection = pick("projection");
  if (rawProjection != null) {
    if ((PROJECTION_METHODS as readonly string[]).includes(rawProjection)) projection = rawProjection as ProjectionMethod;
    else warnings.push(`Unknown projection "${rawProjection}" — valid: first, third. Falling back to "first".`);
  }
  let scale: number | undefined;
  const rawScale = pick("scale");
  if (rawScale !== undefined && !(typeof rawScale === "string" && rawScale.trim().toLowerCase() === "auto")) {
    const parsed = parseScale(rawScale);
    if (parsed !== null) scale = parsed;
    else warnings.push(`Invalid scale ${JSON.stringify(rawScale)} — use a ratio like "1:2" or a positive number. Choosing one automatically.`);
  }
  const title = (pick("title") ?? "").trim() || defaults.title;
  const fields = cleanFields({ ...(template?.fields ?? {}), ...(input.fields ?? {}) });
  return { views, format, paper, projection, scale, title, fields, warnings };
}
