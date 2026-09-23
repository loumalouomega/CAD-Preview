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
import type { SheetSettingsInput } from "./sheetSettings";

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
  if (typeof r.scale === "number" || typeof r.scale === "string") t.scale = r.scale as number | string;
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
