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
import { writeParts } from "../../../src/partsStore";
import { writePlanes } from "../../../src/planesStore";
import { ModelsTreeDataProvider } from "../../../src/modelsView";

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
    "cad-preview.refreshModels", "cad-preview.new",
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

/**
 * The GiD export chain, end to end — this is what `cad-preview.exportMesh`
 * exists to make reachable. FE-mesh export used to be driven only by the
 * webview's own Export button, and a test cannot post into another extension's
 * webview, so this flow was the last of the GiD manual-verification debt.
 *
 * The sibling MUST be `<stem>.post.res`. A last-segment strip — rather than
 * `companionSaveName`'s full compound-extension strip — would yield
 * `<stem>.post.post.res`, which is the specific bug this pins.
 */
test("Export FE Mesh… → GiD writes the .post.msh AND its .post.res sibling", async () => {
  const staged = stage(STEP_FIXTURE);
  const out = path.join(path.dirname(staged), "beam.post.msh");
  const sibling = path.join(path.dirname(staged), "beam.post.res");
  const sourceBefore = fs.readFileSync(staged);
  assert(await openDocument(staged), "the STEP fixture opens");

  const record = await withModals([pick("GiD Postprocess"), pick("Native"), save(out)], async () => {
    await vscode.commands.executeCommand("cad-preview.exportMesh");
    await waitForFile(out, 120000); // a real Gmsh generate runs first
  });

  const offered = record.quickPicks[0]?.labels ?? [];
  assert(offered.includes("GiD Postprocess (.post.msh)"), `the FE-mesh picker offers GiD (offered ${offered.length} formats)`);
  assert(offered[0] === "Kratos MDPA — Elements + Conditions (.mdpa)", "the picker preserves the registry's order");
  assert(fs.existsSync(out) && fs.statSync(out).size > 0, "the .post.msh geometry file is written");
  assert(await waitForFile(sibling, 20000), "the .post.res sibling is written beside it");
  assert(
    !fs.existsSync(path.join(path.dirname(staged), "beam.post.post.res")),
    "the sibling's stem strips the FULL compound extension (not beam.post.post.res)"
  );
  assert(fs.readFileSync(out, "utf8").includes("MESH"), "the .post.msh is a real GiD mesh document");
  assert(Buffer.compare(sourceBefore, fs.readFileSync(staged)) === 0, "the CAD source is untouched");
  await closeAll();
});

test("Export FE Mesh… explains itself rather than failing silently on a mesh source", async () => {
  // A mesh-format source's geometry lives in the webview; the host has no mesh
  // engine on this path, so the command must say which control to use.
  const staged = stage(GID_FIXTURE, [GID_SIBLING]);
  assert(await openDocument(staged), "the GiD (mesh-route) fixture opens");
  const session = installModalStubs([]); // any modal opened here would throw — none should
  let threw = false;
  try {
    await vscode.commands.executeCommand("cad-preview.exportMesh");
    await sleep(1500);
  } catch {
    threw = true;
  } finally {
    session.restore();
  }
  assert(!threw, "a mesh source opens no quick-pick — it reports the limitation instead");
  await closeAll();
});

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
 * events at all when that dir is NOT covered by any open workspace folder?
 * (The test host always opens with `runTest.ts`'s deliberately-empty launch
 * root; the watched dir here is a different temp dir outside it.) If it does
 * not, the whole sub-item is moot and no seam is worth adding.
 */
test("file-system watchers deliver events for files outside the open workspace", async () => {
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

/**
 * The sixth watcher. Same mechanism as the .parts.json case above; worth its
 * own test because a new watcher is easy to add to the list and forget to
 * register, and nothing else in the suite would notice.
 */
test("an external .planes.json edit is reconciled into the webview", async () => {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  const api = ext?.exports as { onDidPostMessage?: vscode.Event<{ type: string }> } | undefined;
  if (!api?.onDidPostMessage) return;

  const staged = stage(STEP_FIXTURE);
  assert(await openDocument(staged), "the STEP fixture opens for the planes watcher");

  const seen: string[] = [];
  const sub = api.onDidPostMessage((m) => { seen.push(m.type); });
  try {
    fs.writeFileSync(
      `${staged}.planes.json`,
      JSON.stringify({
        version: 1,
        source: path.basename(staged),
        planes: [{ id: "plane-0", name: "FromDisk", point: [1, 2, 3], normal: [0, 0, 1] }],
      })
    );
    const got = await waitFor(() => seen.includes("planes"), 15000); // 300ms debounce + async read
    assert(got, `the .planes.json watcher posts a "planes" message (saw ${JSON.stringify(seen.slice(-8))})`);
  } finally {
    sub.dispose();
  }
  await closeAll();
});

/**
 * File ▸ New Blank Model… — the whole point of the feature is that the file it
 * creates is an ORDINARY document, so this drives the real command through the
 * real provider rather than checking the write in isolation.
 *
 * Deliberately NOT added to the session-gated list below: like `open`, it
 * creates a document and so must work with no editor focused. This case runs
 * after `closeAll()` for exactly that reason.
 */
test("New Blank Model creates a readable .brep and opens it", async () => {
  await closeAll();
  const dest = path.join(tempDir(), "blank.brep");

  // Watch what the provider posts while the new document loads. This is what
  // proves the blank document actually TESSELLATES: its source shape is an
  // empty compound, which aborted the whole OCCT WASM instance inside
  // `BRepMesh_IncrementalMesh_2` until `tessellateByGroup` learned to return
  // early for a shape with no sub-shapes at all. Without that guard this posts
  // an `error` and never a `geometry`, and the tab would still open — so the
  // tab assertion alone would not catch it.
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  const api = ext?.exports as { onDidPostMessage?: vscode.Event<{ type: string }> } | undefined;
  const posted: string[] = [];
  const sub = api?.onDidPostMessage?.((m) => { posted.push(m.type); });

  let openedByCommand = false;
  let gotGeometry = false;
  await withModals([save(dest)], async () => {
    await vscode.commands.executeCommand("cad-preview.new");
    await waitForFile(dest);
    // Wait for the command's OWN `vscode.openWith` rather than issuing a
    // second one: a duplicate open on the same URI races the first and can
    // leave a tab behind that `closeAll()` has already run past, which then
    // wedges a later `updateWorkspaceFolders`. Waiting here also makes this a
    // stronger assertion — that the COMMAND opens the document, not just that
    // the file it wrote happens to be openable.
    openedByCommand = await waitFor(
      () => vscode.window.tabGroups.activeTabGroup.activeTab?.label === path.basename(dest),
      20000
    );
    // Wait for the actual `geometry` post, not a fixed sleep: a fixed sleep
    // turns a slow load into a flake and, worse, reports "no geometry"
    // identically for "webview never became ready" and "kernel failed to
    // tessellate" — two unrelated failures with unrelated fixes.
    gotGeometry = await waitFor(() => posted.includes("geometry"), 60000);
  });

  assert(fs.existsSync(dest), `a file was created at the chosen path (${dest})`);
  const bytes = fs.existsSync(dest) ? fs.readFileSync(dest) : Buffer.alloc(0);
  assert(bytes.byteLength > 0, `the blank model is non-empty (${bytes.byteLength} bytes)`);
  // Not just "some bytes": OCCT's own BREP serialization has a fixed header,
  // so this catches a zero-filled or half-written file that would still pass a
  // length check and then fail opaquely on open.
  assert(
    bytes.toString("latin1").startsWith("DBRep_DrawableShape"),
    "the bytes are a real OCCT BREP document, not a placeholder"
  );
  assert(openedByCommand, "the command opened the created file in the CAD Preview custom editor");

  sub?.dispose();
  // `posted` empty (not just missing `geometry`) means the webview never sent
  // `ready` at all — in CI that was a dead WebGL context (the webview module
  // dies in `new THREE.WebGLRenderer(...)` before posting `ready`), not a
  // tessellation failure; see `runTest.ts`'s `--enable-unsafe-swiftshader`.
  assert(
    gotGeometry,
    posted.length === 0
      ? `the empty document tessellated and posted geometry — saw NO posts at all (the webview never sent "ready"; suspect WebGL unavailable)`
      : `the empty document tessellated and posted geometry (saw ${JSON.stringify(posted.slice(-8))})`
  );
  assert(
    !posted.includes("error"),
    `no error was posted while loading the blank document (saw ${JSON.stringify(posted.slice(-8))})`
  );
  await closeAll();
});

test("New Blank Model refuses to overwrite an existing file", async () => {
  await closeAll();
  const dest = path.join(tempDir(), "existing.brep");
  const original = Buffer.from("PRE-EXISTING CONTENT, MUST NOT BE TOUCHED");
  fs.writeFileSync(dest, original);

  await withModals([save(dest)], async () => {
    await vscode.commands.executeCommand("cad-preview.new");
    await sleep(1500);
  });

  // Blanking an existing model would leave its own `.edits.json` replaying
  // against an empty base — geometry that looks plausible and is silently
  // wrong. The refusal must leave the file byte-identical.
  assert(
    fs.readFileSync(dest).equals(original),
    "the pre-existing file is byte-identical after the refused create"
  );
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

test("a sidecar write is refused while the user has unsaved changes to it open", async () => {
  // The one check that genuinely needs a real VS Code: it depends on
  // `vscode.workspace.textDocuments` actually being populated with a dirty
  // buffer, which no unit test or Playwright harness can produce.
  const model = stage(STEP_FIXTURE);
  const sidecar = vscode.Uri.file(`${model}.parts.json`);
  fs.writeFileSync(sidecar.fsPath, '{"version":1,"source":"block.stp","parts":[]}\n', "utf8");

  const doc = await vscode.workspace.openTextDocument(sidecar);
  const editor = await vscode.window.showTextDocument(doc);
  await editor.edit((e) => e.insert(new vscode.Position(0, 0), " "));
  assert(doc.isDirty, "the sidecar is open with unsaved changes");

  const before = fs.readFileSync(sidecar.fsPath, "utf8");
  let refused = false;
  let message = "";
  try {
    await writeParts(vscode.Uri.file(model), [
      { name: "Clobber", color: "#ff0000", volumes: [], surfaces: [], lines: [], points: [] },
    ]);
  } catch (err) {
    refused = true;
    message = (err as Error).message;
  }

  assert(refused, "writing the sidecar threw rather than overwriting unsaved work");
  assert(
    /unsaved changes/i.test(message) && /Save or revert/i.test(message),
    `the refusal says what happened AND what to do (got: ${message})`
  );
  assert(
    fs.readFileSync(sidecar.fsPath, "utf8") === before,
    "the file on disk is byte-identical — nothing was written"
  );

  // Fails OPEN: once the buffer is clean again, the write proceeds.
  await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  await new Promise((r) => setTimeout(r, 300));
  await writeParts(vscode.Uri.file(model), [
    { name: "Now allowed", color: "#00ff00", volumes: [], surfaces: [], lines: [], points: [] },
  ]);
  assert(
    fs.readFileSync(sidecar.fsPath, "utf8").includes("Now allowed"),
    "with no dirty buffer the write goes through normally"
  );
});

/**
 * The guard lives in each store module — the seam it was designed around — so
 * every store needs its own coverage: a new sidecar that forgets the guard
 * would otherwise clobber unsaved work with nothing to catch it.
 */
test("the dirty-buffer guard also protects .planes.json", async () => {
  const model = stage(STEP_FIXTURE);
  const sidecar = vscode.Uri.file(`${model}.planes.json`);
  fs.writeFileSync(sidecar.fsPath, '{"version":1,"source":"block.stp","planes":[]}\n', "utf8");

  const doc = await vscode.workspace.openTextDocument(sidecar);
  const editor = await vscode.window.showTextDocument(doc);
  await editor.edit((e) => e.insert(new vscode.Position(0, 0), " "));
  assert(doc.isDirty, "the planes sidecar is open with unsaved changes");

  const before = fs.readFileSync(sidecar.fsPath, "utf8");
  let refused = false;
  try {
    await writePlanes(vscode.Uri.file(model), [
      { id: "plane-0", name: "Clobber", point: [0, 0, 0], normal: [0, 0, 1] },
    ]);
  } catch {
    refused = true;
  }
  assert(refused, "writing .planes.json threw rather than overwriting unsaved work");
  assert(
    fs.readFileSync(sidecar.fsPath, "utf8") === before,
    "the planes file on disk is byte-identical — nothing was written"
  );

  await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  await new Promise((r) => setTimeout(r, 300));
  await writePlanes(vscode.Uri.file(model), [
    { id: "plane-0", name: "Now allowed", point: [0, 0, 0], normal: [0, 0, 1] },
  ]);
  assert(
    fs.readFileSync(sidecar.fsPath, "utf8").includes("Now allowed"),
    "with no dirty buffer the planes write goes through normally"
  );
});

/**
 * The Models activity-bar view — the only way to reach a CAD document without
 * the file dialog or an already-open editor. Drives a second provider instance
 * directly (the class is exported, so no production seam is needed for that),
 * pointed at a temp workspace folder added for exactly this case.
 */
test("Models view lists workspace CAD files, skips the rest, and opens on click", async () => {
  const dir = tempDir();
  fs.copyFileSync(STEP_FIXTURE, path.join(dir, "block.stp"));
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a model");
  fs.mkdirSync(path.join(dir, "sub", "deep"), { recursive: true });
  fs.copyFileSync(STEP_FIXTURE, path.join(dir, "sub", "deep", "nested.stp"));
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  fs.copyFileSync(STEP_FIXTURE, path.join(dir, "node_modules", "evil.stp"));

  const added = vscode.workspace.updateWorkspaceFolders(0, null, { uri: vscode.Uri.file(dir) });
  assert(added, "the temp folder joins the workspace for this case");
  // Wait for THIS folder, not just "length > 0": the test host always opens
  // with a (deliberately empty) launch root — see `runTest.ts` — so a bare
  // length check would pass without this case's folder ever propagating.
  // Generous timeout on purpose: CI's first attempt runs this after npm ci +
  // build + Playwright install + the full webview suite on a cold runner, and
  // failed twice there on a 10s timeout (both v1.10.0 runs' attempt #1;
  // retries passed). A slow propagation is not a product defect worth failing
  // the job over.
  assert(
    await waitFor(
      () => (vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.fsPath === dir),
      30000
    ),
    "the workspace change propagates before the tree is read"
  );
  const provider = new ModelsTreeDataProvider(VIEW_TYPE);
  try {
    // Other cases stage their own temp dirs, so the workspace may hold
    // several roots — descend from this case's folder node explicitly (which
    // also covers the multi-root path).
    const roots = await provider.getChildren();
    const mine = roots.find(
      (e) => e.kind === "folder" && (e.uri.fsPath === dir || e.uri.toString() === vscode.Uri.file(dir).toString())
    );
    assert(!!mine, `this case's folder node resolves (got ${JSON.stringify(roots.map((e) => e.label))})`);
    const root = await provider.getChildren(mine);
    const labels = root.map((e) => (e.kind === "file" ? e.label : `dir:${e.label}`));
    assert(labels.includes("block.stp"), `the root model is listed (got ${JSON.stringify(labels)})`);
    assert(!labels.some((l) => l.includes("notes.txt")), "a non-model file is not listed");
    assert(!labels.some((l) => l.includes("evil.stp")), "node_modules is never descended into");
    assert(labels.some((l) => l.includes("sub")), "a subfolder is listed");

    const sub = root.find((e) => e.kind === "folder" && e.label === "sub");
    assert(!!sub, "the sub folder node resolves");
    const deep = (await provider.getChildren(sub)).find((e) => e.kind === "folder" && e.label === "deep");
    assert(!!deep, "a nested folder node resolves");
    const nested = await provider.getChildren(deep);
    assert(nested.some((e) => e.kind === "file" && e.label === "nested.stp"), "a model three levels down is listed");

    const file = root.find((e) => e.kind === "file" && e.label === "block.stp");
    assert(!!file, "the file node resolves");
    const item = provider.getTreeItem(file!);
    const cmd = item.command as { command: string; arguments: unknown[] } | undefined;
    assert(cmd?.command === "vscode.openWith", "a file opens via vscode.openWith");
    assert(
      (cmd?.arguments?.[1] as string) === VIEW_TYPE &&
        ((cmd?.arguments?.[0] as vscode.Uri)?.fsPath ?? "").endsWith("block.stp"),
      "openWith targets the CAD Preview custom editor with the file's URI"
    );

    await vscode.commands.executeCommand("cad-preview.refreshModels");
    assert(true, "cad-preview.refreshModels runs without throwing");
  } finally {
    provider.dispose();
    vscode.workspace.updateWorkspaceFolders(0, 1);
  }
  await closeAll();
});

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
