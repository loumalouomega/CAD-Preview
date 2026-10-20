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

export interface SheetSectionInput {
  id: string;
  label?: string;
  view: string;
  origin: [number, number, number];
  normal: [number, number, number];
  flip?: boolean;
}

export interface SheetViewSectionInput {
  origin: [number, number, number];
  normal: [number, number, number];
  flip?: boolean;
}

export interface SheetSettingsInput {
  views?: string[];
  format?: string;
  paper?: string;
  projection?: string;
  /** Sheet mm per model mm, or a ratio string ("1:2", "2:1"). */
  scale?: number | string;
  title?: string;
  fields?: TitleBlockFields;
  /** Layer names/ids to restrict every view to. Absent = every layer. */
  layers?: string[];
  /**
   * Named section views (roadmap "Section views on drawing sheets"): each is
   * drawn looking along its plane normal from the clipped half-space, and its
   * cutting-plane mark is drawn in the parent `view`. Absent = no sections,
   * exactly as before.
   */
  sections?: SheetSectionInput[];
  /**
   * In-place cuts keyed by requested view name: the view draws the clipped
   * half-space instead of gaining a separate section view.
   */
  viewSections?: Record<string, SheetViewSectionInput>;
}

export interface ResolvedSheetSettings {
  views: Array<{ name: string; direction: Vec3; up?: Vec3 }>;
  format: "svg" | "dxf";
  paper: PaperSize;
  projection: ProjectionMethod;
  scale: number | undefined;
  title: string;
  fields: TitleBlockFields | undefined;
  /** Layer names/ids, carried through verbatim for the caller to resolve against the sidecar. */
  layers: string[] | undefined;
  /** Validated sections; a section whose parent view is absent is skipped with a warning. */
  sections: SheetSectionInput[];
  /** Validated in-place cuts, keyed by canonical view name. */
  viewSections: Array<{ view: string; origin: [number, number, number]; normal: [number, number, number]; flip: boolean }>;
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
  const rawLayers = pick("layers");
  const layers = rawLayers !== undefined && (!Array.isArray(rawLayers) || !rawLayers.every((s) => typeof s === "string"))
    ? undefined
    : (rawLayers as string[] | undefined);
  if (rawLayers !== undefined && layers === undefined) {
    warnings.push("layers must be an array of layer names/ids — drawing every layer.");
  }
  const sections = resolveSections(pick("sections"), views, warnings);
  const viewSections = resolveViewSections(pick("viewSections"), views, warnings);
  return { views, format, paper, projection, scale, title, fields, layers, sections, viewSections, warnings };
}

function resolveSections(
  raw: SheetSectionInput[] | undefined,
  views: ResolvedSheetSettings["views"],
  warnings: string[]
): SheetSectionInput[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push("sections must be an array of { id, view, origin, normal } — drawing no sections.");
    return [];
  }
  const seen = new Set<string>();
  const out: SheetSectionInput[] = [];
  raw.forEach((entry, i) => {
    const where = `sections[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      warnings.push(`${where} is not a section object — skipped.`);
      return;
    }
    const id = typeof entry.id === "string" ? entry.id.trim().slice(0, 120) : "";
    if (!id) {
      warnings.push(`${where} needs a non-empty id — skipped.`);
      return;
    }
    if (seen.has(id)) {
      warnings.push(`Section "${id}" is repeated — drawn once.`);
      return;
    }
    const named = typeof entry.view === "string" ? resolveNamedView(entry.view) : undefined;
    const parent = named ? views.find((v) => v.name === named.canonical) : undefined;
    if (!parent) {
      warnings.push(`Section "${id}" names view "${typeof entry.view === "string" ? entry.view : ""}" — valid: ${views.map((v) => v.name).join(", ")}. Skipped.`);
      return;
    }
    const origin = vec3(entry.origin);
    const normal = vec3(entry.normal);
    if (!origin || !normal) {
      warnings.push(`Section "${id}" needs a 3-number origin and normal — skipped.`);
      return;
    }
    if (normal.every((v) => v === 0)) {
      warnings.push(`Section "${id}" needs a non-zero normal — skipped.`);
      return;
    }
    seen.add(id);
    out.push({
      id,
      ...(typeof entry.label === "string" && entry.label.trim() !== "" ? { label: entry.label.trim().slice(0, 120) } : {}),
      view: parent.name,
      origin,
      normal,
      ...(entry.flip === true ? { flip: true } : {}),
    });
  });
  return out;
}

function vec3(raw: unknown): [number, number, number] | undefined {
  if (!Array.isArray(raw) || raw.length !== 3) return undefined;
  const v = raw.map(Number);
  return v.every((n) => Number.isFinite(n)) ? [v[0], v[1], v[2]] : undefined;
}

function resolveViewSections(
  raw: Record<string, SheetViewSectionInput> | undefined,
  views: ResolvedSheetSettings["views"],
  warnings: string[]
): ResolvedSheetSettings["viewSections"] {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("viewSections must be an object keyed by view name — drawing every view uncut.");
    return [];
  }
  const out: ResolvedSheetSettings["viewSections"] = [];
  for (const [key, entry] of Object.entries(raw)) {
    const named = resolveNamedView(key);
    const match = named ? views.find((v) => v.name === named.canonical) : undefined;
    if (!match) {
      warnings.push(`In-place section "${key}" matches no sheet view — valid: ${views.map((v) => v.name).join(", ")}. Drawn uncut.`);
      continue;
    }
    if (out.some((s) => s.view === match.name)) {
      warnings.push(`In-place section "${key}" repeats view "${match.name}" — kept once.`);
      continue;
    }
    const origin = vec3((entry as { origin?: unknown } | undefined)?.origin);
    const normal = vec3((entry as { normal?: unknown } | undefined)?.normal);
    if (!origin || !normal || normal.every((v) => v === 0)) {
      warnings.push(`In-place section "${key}" needs a 3-number origin and a non-zero normal — drawn uncut.`);
      continue;
    }
    out.push({ view: match.name, origin, normal, flip: (entry as { flip?: unknown }).flip === true });
  }
  return out;
}
