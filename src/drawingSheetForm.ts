/**
 * Export Drawing Sheet settings form (roadmap "Drawing-sheet settings and
 * reusable templates") — a small standalone webview panel replacing the two
 * quick-picks: template, views, projection, paper, scale (auto / standard /
 * custom ratio), title and title-block fields, and format. It only COLLECTS
 * settings; `provider.ts` resolves them through the same `resolveSheetSettings`
 * the `export_drawing_sheet` MCP tool uses, so the two paths cannot drift.
 *
 * Resolves to the chosen settings, or `undefined` on Cancel / close. "Save as
 * template…" is delegated to the caller (it owns the name prompt and the
 * library file) and re-renders the template list.
 */
import * as vscode from "vscode";
import { getNonce } from "./nonce";
import { NAMED_VIEW_NAMES } from "./viewDirections";
import { PAPER_SIZES } from "./drawingSheet";
import { DEFAULT_SHEET_VIEWS, STANDARD_SCALE_LABELS, type SheetSettingsInput } from "./sheetSettings";
import type { SheetTemplate } from "./sheetTemplates";

export interface SheetFormOptions {
  defaultTitle: string;
  templates: () => Promise<Array<SheetTemplate & { readOnly: boolean }>>;
  /** Persist a template from the current form values; returns its saved name or undefined. */
  saveTemplate: (settings: SheetSettingsInput) => Promise<string | undefined>;
  /** Pre-fill (the last settings used in this session). */
  initial?: SheetSettingsInput;
}

/** Test-only: when set, the form is not shown and this answer is returned. */
export let testSheetFormAnswer: ((opts: SheetFormOptions) => Promise<SheetSettingsInput | undefined>) | undefined;
export function setTestSheetFormAnswer(fn: typeof testSheetFormAnswer): void {
  testSheetFormAnswer = fn;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function showDrawingSheetForm(opts: SheetFormOptions): Promise<SheetSettingsInput | undefined> {
  if (testSheetFormAnswer) return testSheetFormAnswer(opts);
  const panel = vscode.window.createWebviewPanel("cadPreviewDrawingSheet", "Export Drawing Sheet", vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [],
  });
  const nonce = getNonce();
  const initial = opts.initial ?? {};
  const views = new Set(initial.views ?? DEFAULT_SHEET_VIEWS);
  const scaleOptions = ["auto", ...STANDARD_SCALE_LABELS, "custom"];
  const initialScale = initial.scale === undefined ? "auto" : typeof initial.scale === "string" && scaleOptions.includes(initial.scale) ? initial.scale : "custom";
  const f = initial.fields ?? {};
  panel.webview.html = /* html */ `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'" />
<title>Export Drawing Sheet</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px 20px; max-width: 560px; }
  fieldset { border: 1px solid var(--vscode-widget-border, #444); border-radius: 4px; margin: 0 0 10px; padding: 6px 10px; }
  legend { opacity: 0.8; }
  label { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
  .grid { display: grid; grid-template-columns: 120px 1fr; gap: 4px 8px; align-items: center; }
  .views { display: flex; flex-wrap: wrap; gap: 2px 12px; }
  input[type=text], select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 2px 4px; font: inherit; }
  .row { display: flex; gap: 8px; margin-top: 10px; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 12px; cursor: pointer; font: inherit; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #warn { color: var(--vscode-errorForeground); min-height: 1.2em; }
</style></head><body>
<fieldset><legend>Template</legend>
  <label><select id="template"><option value="">(none — current settings)</option></select></label>
</fieldset>
<fieldset><legend>Views</legend><div class="views">
  ${NAMED_VIEW_NAMES.map((v) => `<label><input type="checkbox" class="view" value="${esc(v)}" ${views.has(v) ? "checked" : ""}/> ${esc(v)}</label>`).join("")}
</div></fieldset>
<fieldset><legend>Sheet</legend><div class="grid">
  <span>Projection</span><select id="projection"><option value="first" ${initial.projection !== "third" ? "selected" : ""}>First-angle (ISO)</option><option value="third" ${initial.projection === "third" ? "selected" : ""}>Third-angle (ASME)</option></select>
  <span>Paper</span><select id="paper">${PAPER_SIZES.map((p) => `<option value="${p}" ${(initial.paper ?? "fit") === p ? "selected" : ""}>${p === "fit" ? "Fit to views" : p}</option>`).join("")}</select>
  <span>Scale</span><span><select id="scale">${scaleOptions.map((s) => `<option value="${esc(s)}" ${s === initialScale ? "selected" : ""}>${s === "auto" ? "Auto (largest standard that fits)" : s === "custom" ? "Custom…" : s}</option>`).join("")}</select>
    <input id="scaleCustom" type="text" size="6" placeholder="e.g. 3:4" value="${initialScale === "custom" ? esc(String(initial.scale)) : ""}" /></span>
  <span>Format</span><select id="format"><option value="svg" ${initial.format !== "dxf" ? "selected" : ""}>SVG</option><option value="dxf" ${initial.format === "dxf" ? "selected" : ""}>DXF</option></select>
</div></fieldset>
<fieldset><legend>Title block</legend><div class="grid">
  <span>Title</span><input id="title" type="text" value="${esc(initial.title ?? opts.defaultTitle)}" />
  <span>Drawn by</span><input id="author" type="text" value="${esc(f.author ?? "")}" />
  <span>Drawing no.</span><input id="drawingNumber" type="text" value="${esc(f.drawingNumber ?? "")}" />
  <span>Revision</span><input id="revision" type="text" value="${esc(f.revision ?? "")}" />
  <span>Material</span><input id="material" type="text" value="${esc(f.material ?? "")}" />
</div></fieldset>
<div id="warn"></div>
<div class="row"><button id="export" class="primary">Export…</button><button id="save">Save as template…</button><button id="cancel">Cancel</button></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let templates = [];
  function read() {
    const views = [...document.querySelectorAll(".view")].filter((c) => c.checked).map((c) => c.value);
    const scaleSel = $("scale").value;
    const scale = scaleSel === "auto" ? undefined : scaleSel === "custom" ? $("scaleCustom").value.trim() : scaleSel;
    const fields = {};
    for (const k of ["author", "drawingNumber", "revision", "material"]) { const v = $(k).value.trim(); if (v) fields[k] = v; }
    return { views, projection: $("projection").value, paper: $("paper").value, scale, format: $("format").value, title: $("title").value.trim(), fields };
  }
  function apply(t) {
    if (t.views) for (const c of document.querySelectorAll(".view")) c.checked = t.views.includes(c.value);
    if (t.projection) $("projection").value = t.projection;
    if (t.paper) $("paper").value = t.paper;
    if (t.format) $("format").value = t.format;
    if (t.scale !== undefined) {
      const opts = [...$("scale").options].map((o) => o.value);
      if (opts.includes(String(t.scale))) $("scale").value = String(t.scale);
      else { $("scale").value = "custom"; $("scaleCustom").value = String(t.scale); }
    }
    if (t.title) $("title").value = t.title;
    for (const k of ["author", "drawingNumber", "revision", "material"]) if (t.fields && t.fields[k] !== undefined) $(k).value = t.fields[k];
  }
  $("template").addEventListener("change", () => { const t = templates.find((x) => x.name === $("template").value); if (t) apply(t); });
  $("export").addEventListener("click", () => {
    const s = read();
    if (s.views.length === 0) { $("warn").textContent = "Pick at least one view."; return; }
    vscode.postMessage({ type: "export", settings: s });
  });
  $("save").addEventListener("click", () => vscode.postMessage({ type: "saveTemplate", settings: read() }));
  $("cancel").addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
  window.addEventListener("message", (e) => {
    if (e.data?.type !== "templates") return;
    templates = e.data.templates;
    const sel = $("template"); const keep = sel.value;
    sel.innerHTML = '<option value="">(none — current settings)</option>' + templates.map((t) => '<option value="' + t.name.replace(/"/g, "&quot;") + '">' + t.name.replace(/</g, "&lt;") + (t.readOnly ? " (built-in)" : "") + "</option>").join("");
    sel.value = keep;
  });
  vscode.postMessage({ type: "ready" });
</script></body></html>`;

  return new Promise<SheetSettingsInput | undefined>((resolve) => {
    let done = false;
    const finish = (v: SheetSettingsInput | undefined) => {
      if (done) return;
      done = true;
      resolve(v);
      panel.dispose();
    };
    const sendTemplates = async () => void panel.webview.postMessage({ type: "templates", templates: await opts.templates() });
    panel.onDidDispose(() => finish(undefined));
    panel.webview.onDidReceiveMessage(async (msg: { type: string; settings?: SheetSettingsInput }) => {
      if (msg.type === "ready") await sendTemplates();
      else if (msg.type === "export") finish(msg.settings);
      else if (msg.type === "cancel") finish(undefined);
      else if (msg.type === "saveTemplate" && msg.settings) {
        const name = await opts.saveTemplate(msg.settings);
        if (name) {
          await sendTemplates();
          void vscode.window.showInformationMessage(`Saved drawing-sheet template "${name}".`);
        }
      }
    });
  });
}
