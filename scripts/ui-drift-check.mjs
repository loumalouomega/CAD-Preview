#!/usr/bin/env node
// Compares the shared UI vocabulary (the `--ui-*` metric tokens and the
// toolbar icon ids) with VSCode-MDPA-Preview and prints the differences.
//
// Informational by design: drift exits 0 (the two extensions may legitimately
// diverge), a network failure or a missing remote file is reported as
// "skipped", and only a script error exits non-zero.
//
//   node scripts/ui-drift-check.mjs [--tokens-url <url>] [--icons-url <url>] [--tokens-file <path>] [--icons-file <path>]
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const RAW = "https://raw.githubusercontent.com/loumalouomega/VSCode-MDPA-Preview/master/";
export const DEFAULT_TOKENS_URL = `${RAW}webview/design-system.css`;
export const DEFAULT_ICONS_URL = `${RAW}src/toolbarIcons.ts`;

/** `--ui-*` custom properties declared in a stylesheet: name → trimmed value (last declaration wins). */
export function extractUiTokens(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = {};
  for (const m of stripped.matchAll(/(--ui-[\w-]+)\s*:\s*([^;]+);/g)) tokens[m[1]] = m[2].trim().replace(/\s+/g, " ");
  return tokens;
}

/** Icon ids from the generated `export type ToolbarIconId = | "a" | "b"` union. */
export function extractIconIds(src) {
  const m = /export type ToolbarIconId\s*=([^;]+);/.exec(src);
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
}

/** Differences between two name→value maps (here = this repository). */
export function diffTokens(here, there) {
  const names = new Set([...Object.keys(here), ...Object.keys(there)]);
  const out = { onlyHere: [], onlyThere: [], changed: [] };
  for (const n of [...names].sort()) {
    if (!(n in there)) out.onlyHere.push(n);
    else if (!(n in here)) out.onlyThere.push(n);
    else if (here[n] !== there[n]) out.changed.push({ name: n, here: here[n], there: there[n] });
  }
  return out;
}

export function diffIds(here, there) {
  const a = new Set(here);
  const b = new Set(there);
  return { onlyHere: [...a].filter((x) => !b.has(x)).sort(), onlyThere: [...b].filter((x) => !a.has(x)).sort() };
}

export function formatReport(tokens, icons) {
  const lines = [];
  const tokenDrift = tokens.onlyHere.length + tokens.onlyThere.length + tokens.changed.length;
  const iconDrift = icons.onlyHere.length + icons.onlyThere.length;
  lines.push(`Tokens: ${tokenDrift === 0 ? "in sync" : `${tokenDrift} difference(s)`}`);
  for (const n of tokens.onlyHere) lines.push(`  only here:  ${n}`);
  for (const n of tokens.onlyThere) lines.push(`  only there: ${n}`);
  for (const c of tokens.changed) lines.push(`  changed:    ${c.name}  here=${c.here}  there=${c.there}`);
  lines.push(`Icons: ${iconDrift === 0 ? "in sync" : `${iconDrift} difference(s)`}`);
  for (const n of icons.onlyHere) lines.push(`  only here:  ${n}`);
  for (const n of icons.onlyThere) lines.push(`  only there: ${n}`);
  return lines.join("\n");
}

async function load(url, file) {
  if (file) return readFile(file, "utf8");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function run(argv, root = new URL("../", import.meta.url)) {
  const here = {
    css: await readFile(new URL("media/viewer.css", root), "utf8"),
    icons: await readFile(new URL("src/toolbarIcons.ts", root), "utf8"),
  };
  let there;
  try {
    there = {
      css: await load(arg(argv, "--tokens-url") ?? DEFAULT_TOKENS_URL, arg(argv, "--tokens-file")),
      icons: await load(arg(argv, "--icons-url") ?? DEFAULT_ICONS_URL, arg(argv, "--icons-file")),
    };
  } catch (err) {
    console.log(`ui-drift-check: skipped (${err instanceof Error ? err.message : err})`);
    return 0;
  }
  console.log(formatReport(diffTokens(extractUiTokens(here.css), extractUiTokens(there.css)), diffIds(extractIconIds(here.icons), extractIconIds(there.icons))));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}
