/**
 * Preparation report bundle (roadmap "Preparation report bundle") — one
 * self-contained JSON + HTML summary of a model's preparation facts, assembled
 * from the SAME tools an agent would call one by one (mass properties, BOM,
 * hole table, mesh health, passages, budget, mesh quality, deviation, handoff
 * manifest, snapshots). Pure: sections in, documents out.
 *
 * Every section states its own status — `ok`, `partial`, `unavailable` (with
 * the reason) or `skipped` (not requested / needs an input) — and which
 * geometry it describes, so a missing fact is visible rather than silently
 * omitted. The HTML has inline CSS, inlined images, no scripts and no network
 * references; every document-derived string is escaped.
 */
import { escapeHtml } from "./html";

export type SectionStatus = "ok" | "partial" | "unavailable" | "skipped";

export interface ReportSection {
  id: string;
  title: string;
  status: SectionStatus;
  reason?: string;
  /** Which geometry the facts describe, e.g. "edited B-rep (edits replayed)". */
  geometry?: string;
  /** Unit the numbers are in, e.g. "mm" or "file units". */
  units?: string;
  data?: unknown;
  warnings?: string[];
}

export interface ReportImage {
  label: string;
  mimeType: string;
  dataBase64: string;
}

export interface PrepReport {
  version: 1;
  kind: "cad-preview-prep-report";
  createdAt: string;
  source: { path: string; format: string; sha256: string; sizeBytes: number };
  sections: ReportSection[];
  images: ReportImage[];
  notes: string[];
}

const STATUS_LABEL: Record<SectionStatus, string> = {
  ok: "OK",
  partial: "Partial",
  unavailable: "Unavailable",
  skipped: "Skipped",
};

const MAX_TABLE_ROWS = 200;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isFinite(v) ? String(Number(v.toPrecision(8))) : String(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** Generic, escaped rendering of a section's data: objects as key/value
 * tables, arrays of objects as row tables (capped), scalars inline. */
export function renderValueHtml(value: unknown, depth = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return `<span class="empty">none</span>`;
    if (value.every(isPlainObject)) {
      const cols = [...new Set(value.flatMap((r) => Object.keys(r as Record<string, unknown>)))];
      const rows = value.slice(0, MAX_TABLE_ROWS).map(
        (r) => `<tr>${cols.map((c) => `<td>${depth > 2 ? escapeHtml(formatScalar((r as Record<string, unknown>)[c])) : renderCell((r as Record<string, unknown>)[c], depth)}</td>`).join("")}</tr>`
      );
      const more = value.length > MAX_TABLE_ROWS ? `<p class="more">${value.length - MAX_TABLE_ROWS} more row(s) in report.json</p>` : "";
      return `<table><thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>${more}`;
    }
    return escapeHtml(value.map(formatScalar).join(", "));
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return `<span class="empty">none</span>`;
    return `<table class="kv"><tbody>${entries
      .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${depth > 2 ? escapeHtml(formatScalar(v)) : renderValueHtml(v, depth + 1)}</td></tr>`)
      .join("")}</tbody></table>`;
  }
  return escapeHtml(formatScalar(value));
}

function renderCell(v: unknown, depth: number): string {
  if (Array.isArray(v) && v.every((x) => !isPlainObject(x))) return escapeHtml(v.map(formatScalar).join(", "));
  if (Array.isArray(v) || isPlainObject(v)) return renderValueHtml(v, depth + 1);
  return escapeHtml(formatScalar(v));
}

/** Only images whose MIME type is a raster we can inline safely. */
function safeImage(img: ReportImage): boolean {
  return /^image\/(png|jpeg)$/.test(img.mimeType) && /^[A-Za-z0-9+/=]+$/.test(img.dataBase64);
}

export function renderPrepReportHtml(report: PrepReport): string {
  const sections = report.sections
    .map((s) => {
      const meta = [s.geometry ? `Geometry: ${s.geometry}` : "", s.units ? `Units: ${s.units}` : ""].filter(Boolean).join(" · ");
      const warnings = s.warnings?.length ? `<ul class="warn">${s.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>` : "";
      const body =
        s.status === "ok" || s.status === "partial"
          ? renderValueHtml(s.data)
          : `<p class="reason">${escapeHtml(s.reason ?? STATUS_LABEL[s.status])}</p>`;
      return `<section id="${escapeHtml(s.id)}"><h2>${escapeHtml(s.title)} <span class="badge st-${s.status}">${STATUS_LABEL[s.status]}</span></h2>${
        meta ? `<p class="meta">${escapeHtml(meta)}</p>` : ""
      }${s.status === "partial" && s.reason ? `<p class="reason">${escapeHtml(s.reason)}</p>` : ""}${body}${warnings}</section>`;
    })
    .join("\n");
  const images = report.images.filter(safeImage);
  const gallery = images.length
    ? `<section id="snapshots-gallery"><h2>Snapshots</h2><p class="meta">Diagnostic only — use the measured facts above for any decision.</p><div class="gallery">${images
        .map((i) => `<figure><img alt="${escapeHtml(i.label)}" src="data:${i.mimeType};base64,${i.dataBase64}"/><figcaption>${escapeHtml(i.label)}</figcaption></figure>`)
        .join("")}</div></section>`
    : "";
  const summary = report.sections.map((s) => `<li><a href="#${escapeHtml(s.id)}">${escapeHtml(s.title)}</a> <span class="badge st-${s.status}">${STATUS_LABEL[s.status]}</span></li>`).join("");
  const notes = report.notes.length ? `<ul class="notes">${report.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>` : "";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"/>
<title>Preparation report — ${escapeHtml(report.source.path.split(/[\\\\/]/).pop() ?? "")}</title>
<style>
  body { font: 14px/1.45 system-ui, sans-serif; margin: 24px; color: #1d1d1f; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #ddd; background: #1e1e1e; } th { background: #2a2a2a !important; } td, th { border-color: #444 !important; } }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 24px 0 6px; }
  table { border-collapse: collapse; margin: 4px 0; } td, th { border: 1px solid #ccc; padding: 3px 8px; text-align: left; vertical-align: top; }
  th { background: #f2f2f2; font-weight: 600; } table.kv th { width: 1%; white-space: nowrap; }
  .badge { font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 8px; vertical-align: middle; }
  .st-ok { background: #d8f5dd; color: #145a24; } .st-partial { background: #fff1c2; color: #6b4e00; }
  .st-unavailable { background: #fbdada; color: #7a1616; } .st-skipped { background: #e6e6e6; color: #444; }
  .meta, .reason, .more, .empty { color: #777; } .warn li { color: #8a5a00; }
  .gallery { display: flex; flex-wrap: wrap; gap: 12px; } figure { margin: 0; } img { max-width: 320px; border: 1px solid #ccc; }
</style></head>
<body>
<h1>Preparation report</h1>
<p class="meta">${escapeHtml(report.source.path)} · ${escapeHtml(report.source.format)} · ${report.source.sizeBytes} bytes · sha256 ${escapeHtml(report.source.sha256)} · ${escapeHtml(report.createdAt)}</p>
<ul class="summary">${summary}</ul>
${notes}
${sections}
${gallery}
</body></html>
`;
}

export function serializePrepReport(report: PrepReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}
