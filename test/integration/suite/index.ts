/**
 * The host-side integration suite — the half `scripts/webview-test/` cannot
 * reach.
 *
 * Playwright drives the webview and nothing else: quick-picks, save dialogs,
 * `vscode.workspace.fs`, custom-editor registration, the file watchers and the
 * command palette all live in the extension host process. This suite runs
 * INSIDE a real VS Code instance (launched by `../runTest.ts` via
 * `@vscode/test-electron`), so it can call the `vscode` API directly.
 *
 * **No mocha.** `@vscode/test-electron` only requires this module to export a
 * `run(): Promise<void>` that rejects on failure — it does not mandate a test
 * framework. Hand-rolled `assert`/`fail` keeps this consistent with
 * `scripts/mcp-smoke/run.mjs` and `scripts/perf/run.mjs`, and avoids adding a
 * second test framework alongside vitest.
 *
 * This is deliberately a FIRST GATE, not broad coverage: it proves the harness
 * itself works end to end (VS Code boots, the extension activates, a document
 * opens through the real provider) so later cases have somewhere to live.
 */
import * as path from "path";
import * as vscode from "vscode";

const EXTENSION_ID = "kratos-multiphysics.cad-preview";
const VIEW_TYPE = "cad-preview.mesh";

let failures = 0;
let checks = 0;

function assert(cond: boolean, message: string): void {
  checks++;
  if (cond) {
    console.log(`  ✓ ${message}`);
  } else {
    failures++;
    console.error(`  ✗ ${message}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Repo root — this bundle runs from `test/integration/.build/`. */
const ROOT = path.resolve(__dirname, "..", "..", "..");

export async function run(): Promise<void> {
  console.log("CAD Preview integration suite\n");

  // ── The extension is present and activates ──────────────────────────────
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert(!!ext, `the extension is installed (${EXTENSION_ID})`);
  if (ext && !ext.isActive) await ext.activate();
  assert(ext?.isActive === true, "the extension activates without throwing");

  // ── Commands are registered ─────────────────────────────────────────────
  // `cad-preview.open` is the one command registered standalone (not gated on
  // a focused editor), so it must exist the moment the extension is active.
  const commands = await vscode.commands.getCommands(true);
  for (const id of ["cad-preview.open", "cad-preview.compareModels", "cad-preview.whatsNew"]) {
    assert(commands.includes(id), `command ${id} is registered`);
  }

  // ── A document opens through the REAL custom-editor provider ────────────
  // The GiD fixture is deliberately the one used here: `.post.msh` is a
  // COMPOUND extension whose tail (`.msh`) is registered to a DIFFERENT format
  // (Gmsh), so this is the first exercise of `routeFile`'s longest-suffix
  // matching through the real provider rather than a unit test — the automated
  // half of the GiD verification gap this whole roadmap item exists for.
  const fixture = vscode.Uri.file(path.join(ROOT, "examples", "GiD", "two-tets.post.msh"));
  let opened = true;
  try {
    await vscode.commands.executeCommand("vscode.openWith", fixture, VIEW_TYPE);
    // Give the webview a moment to resolve; we are asserting that opening does
    // not throw and that the custom editor takes the tab, not that geometry
    // rendered (that is the webview harness's job).
    await sleep(3000);
  } catch (err) {
    opened = false;
    console.error(`  (openWith threw: ${(err as Error).message})`);
  }
  assert(opened, "a .post.msh document opens in the custom editor without throwing");
  assert(
    vscode.window.tabGroups.activeTabGroup.activeTab?.label === "two-tets.post.msh",
    `the opened tab is the fixture (got ${JSON.stringify(vscode.window.tabGroups.activeTabGroup.activeTab?.label)})`
  );

  console.log(
    failures ? `\nIntegration suite FAILED: ${failures} of ${checks} checks.` : `\nIntegration suite passed (${checks} checks).`
  );
  if (failures) throw new Error(`${failures} of ${checks} integration checks failed`);
}
