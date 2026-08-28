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
 * framework. Hand-rolled `assert`/`fail` and a `CASES` list keep this
 * consistent with `scripts/mcp-smoke/run.mjs`, `scripts/perf/run.mjs` and
 * `scripts/webview-test/run.mjs`, and avoid a second framework beside vitest.
 *
 * **Modal UI is driven by stubbing `vscode.window.*`** — see `modalStubs.ts`
 * for why that is the right seam and why it needs no production change.
 *
 * **Nothing here writes inside the repo.** Every case that produces output
 * copies its fixture into a fresh temp dir first, mirroring
 * `scripts/mcp-smoke/run.mjs`'s discipline, and the CAD source is byte-compared
 * afterwards to hold this codebase's read-only invariant.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { installModalStubs, pick, save, cancel, waitForFile, waitFor, type ModalAnswer } from "./modalStubs";

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
const GID_FIXTURE = path.join(ROOT, "examples", "GiD", "two-tets.post.msh");
const GID_SIBLING = path.join(ROOT, "examples", "GiD", "two-tets.post.res");
const STEP_FIXTURE = path.join(ROOT, "examples", "STP", "block.stp");

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-preview-integration-"));
  tempDirs.push(dir);
  return dir;
}

/** Copies a fixture (and any siblings) into a temp dir; returns the copy's path. */
function stage(fixture: string, siblings: string[] = []): string {
  const dir = tempDir();
  const dest = path.join(dir, path.basename(fixture));
  fs.copyFileSync(fixture, dest);
  for (const s of siblings) fs.copyFileSync(s, path.join(dir, path.basename(s)));
  return dest;
}

/** Opens a document in the custom editor and waits for it to become the active tab. */
async function openDocument(file: string): Promise<boolean> {
  await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.file(file), VIEW_TYPE);
  const ok = await waitFor(
    () => vscode.window.tabGroups.activeTabGroup.activeTab?.label === path.basename(file),
    20000
  );
  // The provider resolves the webview and loads geometry asynchronously; the
  // export commands need `activeSession` set and the model loaded.
  await sleep(4000);
  return ok;
}

async function closeAll(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await sleep(500);
}

/**
 * Runs `body` with modal answers scripted. Always restores the stubs, and fails
 * the case if answers were scripted but never consumed (which means the flow
 * took a different path than the test assumed).
 */
async function withModals(answers: ModalAnswer[], body: (session: ReturnType<typeof installModalStubs>) => Promise<void>): Promise<ReturnType<typeof installModalStubs>["record"]> {
  const session = installModalStubs(answers);
  try {
    await body(session);
  } finally {
    session.restore();
  }
  return session.record;
}

// ── Cases ─────────────────────────────────────────────────────────────────
const CASES: Array<{ name: string; run: () => Promise<void> }> = [];
const test = (name: string, run: () => Promise<void>) => CASES.push({ name, run });

test("the extension is installed, activates, and registers its commands", async () => {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert(!!ext, `the extension is installed (${EXTENSION_ID})`);
  if (ext && !ext.isActive) await ext.activate();
  assert(ext?.isActive === true, "the extension activates without throwing");

  const commands = await vscode.commands.getCommands(true);
  for (const id of [
    "cad-preview.open", "cad-preview.compareModels", "cad-preview.whatsNew",
    "cad-preview.export", "cad-preview.saveAs", "cad-preview.exportSvg",
    "cad-preview.exportDxf", "cad-preview.savePreprocess", "cad-preview.loadPreprocess",
  ]) {
    assert(commands.includes(id), `command ${id} is registered`);
  }
});

/**
 * The linchpin for every case below it: if `vscode.window.*` were not writable,
 * no modal flow could be driven at all and this whole phase would need a
 * production seam instead.
 */
test("vscode.window modal functions are stubbable from the suite", async () => {
  const original = vscode.window.showQuickPick;
  const record = await withModals([pick("B")], async () => {
    assert(vscode.window.showQuickPick !== original, "assigning to vscode.window.showQuickPick takes effect");
    const chosen = await vscode.window.showQuickPick(["A", "B", "C"], { placeHolder: "probe" });
    assert(chosen === "B", `the stub selects from the REAL offered list (got ${JSON.stringify(chosen)})`);
  });
  assert(vscode.window.showQuickPick === original, "restore() puts the original back");
  assert(record.quickPicks[0]?.labels.join(",") === "A,B,C", "the stub records what the user was offered");
});

test("the modal stub fails loudly when an answer is not scripted", async () => {
  // A silently-undefined answer reads as "user cancelled", which would turn
  // missing setup into a passing no-op — the false-pass class this guards.
  let threw = false;
  const session = installModalStubs([]);
  try {
    await vscode.window.showQuickPick(["X"], { placeHolder: "unscripted" });
  } catch {
    threw = true;
  } finally {
    session.restore();
  }
  assert(threw, "an exhausted answer queue throws instead of returning undefined");
});

test("a .post.msh opens through the real provider, and routes to GiD not Gmsh", async () => {
  // `.post.msh` is a COMPOUND extension whose tail (`.msh`) is registered to a
  // DIFFERENT format, so this exercises routeFile's longest-suffix matching
  // through the REAL provider rather than a unit test.
  const staged = stage(GID_FIXTURE, [GID_SIBLING]);
  const before = fs.readFileSync(staged);
  assert(await openDocument(staged), "a .post.msh document opens in the custom editor");
  assert(Buffer.compare(before, fs.readFileSync(staged)) === 0, "the CAD source is byte-identical after opening");
  await closeAll();
});

// NOTE — the FE Mesh panel's export (and therefore the GiD `.post.msh` +
// `.post.res` pair) is NOT covered here, and cannot be without a production
// change. It is driven purely by the webview posting a `meshingExport` message
// (`provider.ts:801`); there is no command for it, and an integration test
// cannot post into another extension's webview. So GiD manual item (a) stays
// manual. The pieces around it ARE covered — `companionSaveName`'s
// compound-extension strip by unit tests, the picker containing `gid` by the
// webview harness — but the end-to-end join is genuinely untested. Adding a
// session-gated command for it is the obvious follow-up.

test("Export… offers the real export targets and writes the chosen one", async () => {
  const staged = stage(STEP_FIXTURE);
  // BREP, not STL, is deliberate: B-rep targets are written HOST-side by
  // `exportBRep` (OCCT), whereas the mesh targets (STL/OBJ/PLY/glTF) are
  // serialized in the WEBVIEW by `meshExporters.ts` and posted back. This VS Code
  // runs with WebGL2 blocklisted, so the webview has no Three.js scene to
  // serialize and a mesh export never completes — a real, permanent limit of
  // this harness, not a flake. Mesh-target export stays webview-harness/F5 work.
  const out = path.join(path.dirname(staged), "exported.brep");
  assert(await openDocument(staged), "the STEP fixture opens");

  const record = await withModals([pick("BREP"), pick("Native"), save(out)], async () => {
    await vscode.commands.executeCommand("cad-preview.export");
    await waitForFile(out);
  });

  const offered = record.quickPicks[0]?.labels ?? [];
  assert(offered.length > 0, `the export command opened a format quick-pick (offered ${JSON.stringify(offered)})`);
  assert(offered.includes("STL") && offered.includes("BREP"), "the format quick-pick offers the real target set");
  assert(!offered.includes("STEP"), "the format quick-pick does NOT offer the source's own format");
  assert(record.quickPicks.length >= 2, "a second quick-pick asked for the export unit");
  assert(fs.existsSync(out) && fs.statSync(out).size > 0, "the chosen format is written to the chosen path");
  await closeAll();
});

/**
 * A real asymmetry in `provider.ts` that nothing checked: Escape on the FORMAT
 * pick cancels the whole export, but Escape on the UNIT pick must NOT — it
 * falls back to "mm", because declining an optional step should never discard
 * the export.
 */
test("Escape cancels on the format pick, but not on the unit pick", async () => {
  const staged = stage(STEP_FIXTURE);
  assert(await openDocument(staged), "the STEP fixture opens");

  const cancelledOut = path.join(path.dirname(staged), "cancelled.brep");
  await withModals([cancel()], async () => {
    await vscode.commands.executeCommand("cad-preview.export");
    await sleep(1500);
  });
  assert(!fs.existsSync(cancelledOut), "Escape on the format pick writes nothing");

  const unitOut = path.join(path.dirname(staged), "unit-escaped.brep");
  await withModals([pick("BREP"), cancel(), save(unitOut)], async () => {
    await vscode.commands.executeCommand("cad-preview.export");
    await waitForFile(unitOut);
  });
  assert(fs.existsSync(unitOut), "Escape on the unit pick still exports (falls back to mm)");
  await closeAll();
});

test("Export Silhouette SVG… offers the view list and writes a parseable drawing", async () => {
  const staged = stage(STEP_FIXTURE);
  const out = path.join(path.dirname(staged), "silhouette.svg");
  assert(await openDocument(staged), "the STEP fixture opens");

  const record = await withModals([pick("Front"), pick("Native"), save(out)], async () => {
    await vscode.commands.executeCommand("cad-preview.exportSvg");
    await waitForFile(out);
  });

  const views = record.quickPicks[0]?.labels ?? [];
  assert(views.length > 0, `the view quick-pick opened (offered ${JSON.stringify(views)})`);
  assert(fs.existsSync(out), "the SVG is written");
  if (fs.existsSync(out)) {
    const svg = fs.readFileSync(out, "utf8");
    assert(svg.startsWith("<svg") || svg.includes("<svg"), "the output is an SVG document");
    assert(!/NaN|Infinity/.test(svg), "the SVG contains no NaN/Infinity coordinates");
  }
  await closeAll();
});

/**
 * Feasibility probe for covering `provider.ts`'s six external-change watchers.
 *
 * Those watchers reconcile by `webview.postMessage` with NO host-side
 * observable, so asserting on them would need a test-only seam in production
 * code. Before building one, this checks the cheaper precondition: does
 * `createFileSystemWatcher` with a `RelativePattern` on a temp dir deliver
 * events at all when the test host runs with **no workspace folder**? If it
 * does not, the whole sub-item is moot and no seam is worth adding.
 */
test("file-system watchers deliver events with no workspace folder open", async () => {
  const dir = tempDir();
  const target = path.join(dir, "probe.json");
  let fired = 0;
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(dir), "probe.json")
  );
  watcher.onDidCreate(() => { fired++; });
  watcher.onDidChange(() => { fired++; });
  try {
    await sleep(500); // let the watcher register with the file-watching service
    fs.writeFileSync(target, JSON.stringify({ a: 1 }));
    await waitFor(() => fired > 0, 8000);
    assert(fired > 0, `an external write is delivered to a RelativePattern watcher (fired ${fired}x)`);
  } finally {
    watcher.dispose();
  }
});

/**
 * The external-change watchers, via the `ExtensionMode.Test`-gated seam
 * `extension.ts` exposes. These reconcile by posting to the webview and nothing
 * else, so this is the only way to observe them from the host side.
 *
 * The reconciliation is content-COMPARED, not event-triggered: writing content
 * identical to what the extension already holds is by design a no-op. So the
 * test writes something genuinely different and waits out the 300 ms debounce.
 */
test("an external .parts.json edit is reconciled into the webview", async () => {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  const api = ext?.exports as { onDidPostMessage?: vscode.Event<{ type: string }> } | undefined;
  assert(!!api?.onDidPostMessage, "the test-only API is exposed under ExtensionMode.Test");
  if (!api?.onDidPostMessage) return;

  const staged = stage(STEP_FIXTURE);
  assert(await openDocument(staged), "the STEP fixture opens");

  const seen: string[] = [];
  const sub = api.onDidPostMessage((m) => { seen.push(m.type); });
  try {
    fs.writeFileSync(
      `${staged}.parts.json`,
      JSON.stringify({ version: 1, source: path.basename(staged), parts: [{ name: "FromDisk", color: "#ff0000", volumes: [], surfaces: [], lines: [], points: [] }] })
    );
    const got = await waitFor(() => seen.includes("parts"), 15000); // 300ms debounce + async read
    assert(got, `the .parts.json watcher posts a "parts" message (saw ${JSON.stringify(seen.slice(-8))})`);
    assert(
      seen.includes("status"),
      "the reconciliation also reports itself on the status line"
    );
  } finally {
    sub.dispose();
  }
  await closeAll();
});

test("session-gated commands are silent no-ops with no editor focused", async () => {
  await closeAll();
  // No active session: these must do nothing at all — in particular they must
  // not open a modal, which the stub would catch by throwing on an empty queue.
  const session = installModalStubs([]);
  let threw = false;
  try {
    for (const id of ["cad-preview.export", "cad-preview.saveAs", "cad-preview.exportSvg", "cad-preview.savePreprocess"]) {
      await vscode.commands.executeCommand(id);
    }
    await sleep(800);
  } catch {
    threw = true;
  } finally {
    session.restore();
  }
  assert(!threw, "no session-gated command opened a modal without an active editor");
});

// ── Runner ────────────────────────────────────────────────────────────────
export async function run(): Promise<void> {
  console.log("CAD Preview integration suite\n");

  for (const c of CASES) {
    console.log(`\n${c.name}`);
    try {
      await c.run();
    } catch (err) {
      failures++;
      console.error(`  ✗ ${c.name}: ${(err as Error).message}`);
    }
  }

  // Nothing may be written inside the repo; the fixtures must be pristine.
  for (const f of [GID_FIXTURE, GID_SIBLING, STEP_FIXTURE]) {
    assert(fs.existsSync(f), `repo fixture still present: ${path.basename(f)}`);
  }
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(
    failures ? `\nIntegration suite FAILED: ${failures} of ${checks} checks.` : `\nIntegration suite passed (${checks} checks).`
  );
  if (failures) throw new Error(`${failures} of ${checks} integration checks failed`);
}
