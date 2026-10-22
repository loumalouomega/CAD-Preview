/**
 * Reusable drawing-sheet templates (roadmap "Drawing-sheet settings and
 * reusable templates") — the mesh-preset library pattern verbatim: pure
 * parse/serialize/merge here, a bundled read-only starter file
 * (`dist/sheet-templates/starter-templates.json`) plus a caller-owned
 * `cad-preview-sheet-templates.json` beside the model. A template is a
 * `SheetSettingsInput` with a name — views, projection, paper, scale and
 * title-block fields; never geometry.
 */
import type { TitleBlockFields } from "./drawingSheet";
import type { SheetSectionInput, SheetSettingsInput, SheetViewSectionInput } from "./sheetSettings";

export const SHEET_TEMPLATE_LIBRARY_VERSION = 1;
export const BUNDLED_SHEET_TEMPLATES_FILE = "starter-templates.json";
export const USER_SHEET_TEMPLATES_FILE = "cad-preview-sheet-templates.json";

export function bundledSheetTemplatesPath(extensionPath: string): string {
  return `${extensionPath}/dist/sheet-templates/${BUNDLED_SHEET_TEMPLATES_FILE}`;
}

export interface SheetTemplate extends SheetSettingsInput {
  name: string;
  description?: string;
}

export type SheetTemplateLibrary = Record<string, SheetTemplate>;

const MAX_TEMPLATES = 200;
const MAX_NAME_LENGTH = 120;

/** Tolerant: malformed entries/fields are dropped, never thrown. */
export function parseSheetTemplatesJson(text: string): SheetTemplateLibrary {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {};
  }
  const raw = (data as { templates?: unknown } | null)?.templates;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: SheetTemplateLibrary = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_TEMPLATES) break;
    const t = validateTemplate(key, value);
    if (t) out[t.name] = t;
  }
  return out;
}

function validateTemplate(key: string, value: unknown): SheetTemplate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const name = typeof r.name === "string" && r.name.trim() !== "" ? r.name.trim() : key.trim();
  if (name === "" || name.length > MAX_NAME_LENGTH) return null;
  const t: SheetTemplate = { name };
  if (typeof r.description === "string") t.description = r.description;
  if (Array.isArray(r.views) && r.views.every((v) => typeof v === "string")) t.views = r.views as string[];
  for (const k of ["format", "paper", "projection", "title"] as const) if (typeof r[k] === "string") t[k] = r[k] as string;
  if (typeof r.holeCallouts === "boolean") t.holeCallouts = r.holeCallouts;
  if (typeof r.scale === "number" || typeof r.scale === "string") t.scale = r.scale as number | string;
  if (Array.isArray(r.sections)) {
    const sections = r.sections.filter((s): s is SheetSectionInput => {
      if (!s || typeof s !== "object" || Array.isArray(s)) return false;
      const e = s as Record<string, unknown>;
      return (
        typeof e.id === "string" &&
        e.id.trim() !== "" &&
        typeof e.view === "string" &&
        e.view.trim() !== "" &&
        isVec3(e.origin) &&
        isVec3(e.normal) &&
        (e.label === undefined || typeof e.label === "string") &&
        (e.flip === undefined || typeof e.flip === "boolean")
      );
    });
    if (sections.length > 0) t.sections = sections;
  }
  if (r.viewSections && typeof r.viewSections === "object" && !Array.isArray(r.viewSections)) {
    const cuts: Record<string, SheetViewSectionInput> = {};
    for (const [key, value] of Object.entries(r.viewSections)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const e = value as Record<string, unknown>;
      if (isVec3(e.origin) && isVec3(e.normal) && (e.flip === undefined || typeof e.flip === "boolean")) {
        cuts[key] = { origin: e.origin, normal: e.normal, ...(e.flip === true ? { flip: true } : {}) };
      }
    }
    if (Object.keys(cuts).length > 0) t.viewSections = cuts;
  }
  if (r.fields && typeof r.fields === "object" && !Array.isArray(r.fields)) {
    const f: TitleBlockFields = {};
    for (const k of ["author", "drawingNumber", "revision", "material"] as const) {
      const v = (r.fields as Record<string, unknown>)[k];
      if (typeof v === "string") f[k] = v;
    }
    if (Object.keys(f).length) t.fields = f;
  }
  return t;
}

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

export function serializeSheetTemplatesJson(library: SheetTemplateLibrary): string {
  return JSON.stringify({ version: SHEET_TEMPLATE_LIBRARY_VERSION, templates: library }, null, 2) + "\n";
}

/** Caller wins on a name collision (the preset/macro precedent). */
export function mergeSheetTemplates(
  bundled: SheetTemplateLibrary,
  user: SheetTemplateLibrary
): { merged: SheetTemplateLibrary; collisions: string[] } {
  const collisions = Object.keys(user).filter((n) => n in bundled);
  return { merged: { ...bundled, ...user }, collisions };
}
