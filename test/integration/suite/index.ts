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
 *
 * **What is still F5-only** (narrower than it was — the quick-pick/save-dialog
 * chains above are now covered): the Export command's mesh targets end to end
 * through the save dialog (the serialization itself IS covered by the webview
 * harness; the host's save/write half is covered for B-rep targets — but the
 * join of the two, in one VS Code, is not); FE-mesh export for mesh-format
 * sources (the command covers B-rep sources; a mesh source's geometry lives in
 * the webview); whether the render looks *right* (framing invariants catch a
 * blank/off-screen/full-bleed viewport, not shading/colour); and anything
 * needing a real user gesture through VS Code chrome (menus, drag-and-drop,
 * the orientation gizmo).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { installModalStubs, pick, save, cancel, waitForFile, waitFor, type ModalAnswer } from "./modalStubs";
import { writeParts } from "../../../src/partsStore";
import { writePlanes } from "../../../src/planesStore";
import { writeCustomBackup, restoreCustomBackup } from "../../../src/customBackup";
import { ModelsTreeDataProvider } from "../../../src/modelsView";

const EXTENSION_ID = "kratos-multiphysics.cad-preview";
const VIEW_TYPE = "cad-preview.mesh";

/**
 * The `ExtensionMode.Test` seam (`src/extension.ts`) — the only way to reach
 * `saveCustomDocument`/`revertCustomDocument` joins from the host side. The
 * suite cannot push ops through the webview, so without this the Ctrl+S path
 * (as opposed to the Export-menu path) would be entirely uncovered.
 */
interface SaveTestApi {
  onDidPostMessage?: vscode.Event<{ type: string }>;
  saveDocument?: (uri: vscode.Uri) => Promise<void>;
  revertDocument?: (uri: vscode.Uri) => Promise<void>;
  markDirtyDocument?: (uri: vscode.Uri) => void;
  setExportMeshStub?: (stub: ((format: string) => Uint8Array | undefined) | undefined) => void;
}

async function saveTestApi(): Promise<SaveTestApi | undefined> {
  // The activation case normally runs first, but a filtered run
  // (`/tmp/cad-preview-test-only`) may reach here without it — activate
  // explicitly so the seam is available either way.
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  if (ext && !ext.isActive) await ext.activate();
  return ext?.exports as SaveTestApi | undefined;
}

/** Smallest x-coordinate across every mesh of the last `geometry` post seen. */
function minXOfPosts(seen: Array<{ type: string; meshes?: Array<{ positions?: string }> }>): number | null {
  const last = [...seen].reverse().find((m) => m.type === "geometry" && Array.isArray(m.meshes));
  if (!last?.meshes) return null;
  let min = Infinity;
  for (const mesh of last.meshes) {
    if (!mesh.positions) continue;
    const buf = Buffer.from(mesh.positions, "base64");
    const arr = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    for (let i = 0; i < arr.length; i += 3) if (arr[i] < min) min = arr[i];
  }
  return min === Infinity ? null : min;
}

/** Opens a document with the post observer attached from before the open. */
async function openAndWaitGeometry(
  file: string,
  api: SaveTestApi | undefined,
  seen: Array<{ type: string; meshes?: Array<{ positions?: string }> }>
): Promise<boolean> {
  const sub = api?.onDidPostMessage?.((m) => {
    seen.push(m as { type: string });
  });
  try {
    if (!(await openDocument(file))) return false;
    return await waitFor(() => seen.some((m) => m.type === "geometry"), 60000);
  } finally {
    sub?.dispose();
  }
}

function readSidecarJson(file: string): { ops?: unknown[]; bakedThrough?: unknown } {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Marks the open CAD document dirty through the Test seam — what a webview
 * `editsChanged` post does in production and the suite cannot do any other
 * way. Beyond fidelity, a dirty tab is LOAD-BEARING for every save test:
 * the save's temp-sibling rename-overwrite momentarily reads as a file
 * delete, and VS Code auto-closes a *clean* tab on delete — the panel dies
 * mid-save and every later post throws "Webview is disposed". A real save
 * always runs on a dirty tab, so it never meets that path.
 */
function markDirty(api: SaveTestApi | undefined, file: string): void {
  api?.markDirtyDocument?.(vscode.Uri.file(file));
}

/**
 * Clears VS Code's dirty dot after a seam-driven save (which bypasses the
 * platform save flow that would clear it): a real save that bakes nothing
 * because the tail is empty. Without this, `closeAll` prompts to save.
 * Guarded on an active editor — with nothing open the platform save throws
 * "No custom document found", which is harness noise, not a product signal.
 */
async function clearDirtyViaNoopSave(): Promise<void> {
  if (!vscode.window.activeTextEditor && !vscode.window.tabGroups.activeTabGroup.activeTab) return;
  try {
    await vscode.commands.executeCommand("workbench.action.files.save");
  } catch {
    /* nothing dirty or nothing open — either way the dot is clear */
  }
  await sleep(500);
}

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
const STL_FIXTURE = path.join(ROOT, "examples", "STL", "cube.stl");

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
  // Tier 0 Phase 1: a B-rep source offers its OWN format first — a confirmed
  // save-in-place, not an export. Mesh sources keep the exclusion.
  assert(offered[0] === "STEP", `the source's own B-rep format leads the quick-pick (save in place), offered ${JSON.stringify(offered)}`);
  assert(record.quickPicks.length >= 2, "a second quick-pick asked for the export unit");
  assert(fs.existsSync(out) && fs.statSync(out).size > 0, "the chosen format is written to the chosen path");
  await closeAll();
});

test("Save in place bakes ops into the source with .bak + watermark", async () => {
  // Tier 0 Phase 1: picking the source's own B-rep format writes back to the
  // open document instead of exporting. Pre-write a one-op sidecar so there
  // is something to bake (the webview cannot push ops in this harness).
  const staged = stage(STEP_FIXTURE);
  fs.writeFileSync(
    `${staged}.edits.json`,
    JSON.stringify({
      version: 1,
      source: path.basename(staged),
      ops: [{ op: "translate", targets: ["solid-0"], vec: [5, 0, 0] }],
    })
  );
  const before = fs.readFileSync(staged);
  assert(await openDocument(staged), "the STEP fixture opens with a sidecar op");
  // Dirty like production (see `markDirty`): keeps the tab alive across the
  // save's rename-overwrite and the post-save reload's posts deliverable.
  markDirty(await saveTestApi(), staged);
  const record = await withModals([pick("STEP"), pick("Save in place")], async () => {
    await vscode.commands.executeCommand("cad-preview.export");
    const settled = await waitFor(() => {
      try {
        return JSON.parse(fs.readFileSync(`${staged}.edits.json`, "utf8")).bakedThrough === 1;
      } catch {
        return false;
      }
    });
    assert(settled, "the sidecar watermark lands after the save");
  });
  // No save dialog and no unit pick for a save-in-place — the destination IS
  // the source, at the file's own declared unit.
  assert(record.saveDialogs.length === 0, "save-in-place shows no save dialog");
  assert(record.quickPicks.length === 1, "save-in-place shows no unit quick-pick");
  assert(
    record.warnings.length === 1 && /re-emitted/.test(record.warnings[0]?.message ?? ""),
    "the modal confirmation names the data-loss contract"
  );
  assert(!fs.readFileSync(staged).equals(before), "the source file itself is rewritten");
  assert(fs.existsSync(`${staged}.bak`) && fs.readFileSync(`${staged}.bak`).equals(before), "a one-deep .bak holds the pre-save bytes");
  const sidecar = JSON.parse(fs.readFileSync(`${staged}.edits.json`, "utf8"));
  assert(
    sidecar.bakedThrough === 1 && sidecar.ops.length === 1,
    `the sidecar keeps the full list with the watermark (got bakedThrough=${sidecar.bakedThrough}, ops=${sidecar.ops?.length})`
  );
  await clearDirtyViaNoopSave();
  await closeAll();
});

/**
 * The Ctrl+S join (`saveCustomDocument` → `savers.save()`), as opposed to the
 * Export-menu path above. Same kernel bake, `.bak` and watermark — reached
 * through the Test seam because the suite cannot dirty a document any other
 * way (dirty fires only on webview `editsChanged`, and nothing here can post
 * into the webview).
 */
test("Ctrl+S bakes through the same join as Export save-in-place", async () => {
  const api = await saveTestApi();
  assert(!!api?.saveDocument, "the test-only saveDocument seam is exposed");
  if (!api?.saveDocument) return;

  const staged = stage(STEP_FIXTURE);
  fs.writeFileSync(
    `${staged}.edits.json`,
    JSON.stringify({
      version: 1,
      source: path.basename(staged),
      ops: [{ op: "translate", targets: ["solid-0"], vec: [5, 0, 0] }],
    })
  );
  const before = fs.readFileSync(staged);
  const seen: Array<{ type: string }> = [];
  assert(await openAndWaitGeometry(staged, api, seen as never), "the STEP fixture opens and posts geometry");
  markDirty(api, staged);

  const uri = vscode.Uri.file(staged);
  const record = await withModals([pick("Save in place")], async () => {
    await api.saveDocument!(uri);
    const settled = await waitFor(() => readSidecarJson(`${staged}.edits.json`).bakedThrough === 1);
    assert(settled, "the sidecar watermark lands after Ctrl+S");
  });
  assert(
    record.warnings.length === 1 && /re-emitted/.test(record.warnings[0]?.message ?? ""),
    "the first Ctrl+S still confirms with the data-loss modal"
  );
  assert(!fs.readFileSync(staged).equals(before), "the source file itself is rewritten");
  assert(fs.existsSync(`${staged}.bak`) && fs.readFileSync(`${staged}.bak`).equals(before), "a one-deep .bak holds the pre-save bytes");
  await clearDirtyViaNoopSave();
  await closeAll();
});

test("Save modal cancellation writes nothing", async () => {
  const api = await saveTestApi();
  if (!api?.saveDocument) return;

  const staged = stage(STEP_FIXTURE);
  fs.writeFileSync(
    `${staged}.edits.json`,
    JSON.stringify({
      version: 1,
      source: path.basename(staged),
      ops: [{ op: "translate", targets: ["solid-0"], vec: [5, 0, 0] }],
    })
  );
  const before = fs.readFileSync(staged);
  const seen: Array<{ type: string }> = [];
  assert(await openAndWaitGeometry(staged, api, seen as never), "the STEP fixture opens");
  markDirty(api, staged);

  const record = await withModals([cancel()], async () => {
    await api.saveDocument!(vscode.Uri.file(staged));
    await sleep(1500);
  });
  assert(record.warnings.length === 1, "the confirmation modal was shown before cancelling");
  assert(fs.readFileSync(staged).equals(before), "a cancelled save leaves the source byte-identical");
  // Compared parsed, not byte-for-byte: `saveDocumentSource` flushes the
  // sidecars (normalizing JSON formatting) BEFORE the modal, so the file's
  // bytes may be re-serialized even though nothing was baked.
  const sidecarAfterCancel = readSidecarJson(`${staged}.edits.json`);
  assert(
    sidecarAfterCancel.bakedThrough !== 1 && (sidecarAfterCancel.ops as unknown[])?.length === 1,
    "a cancelled save advances no watermark and drops no op"
  );
  assert(!fs.existsSync(`${staged}.bak`), "a cancelled save creates no .bak");
  // Still dirty (nothing baked): revert-and-close discards the dot without a save prompt.
  await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  await sleep(500);
  await closeAll();
});

test("A second save advances the watermark without rotating .bak or re-asking", async () => {
  const api = await saveTestApi();
  if (!api?.saveDocument) return;

  const staged = stage(STEP_FIXTURE);
  const op1 = { op: "translate", targets: ["solid-0"], vec: [5, 0, 0] };
  fs.writeFileSync(`${staged}.edits.json`, JSON.stringify({ version: 1, source: path.basename(staged), ops: [op1] }));
  const seen: Array<{ type: string }> = [];
  assert(await openAndWaitGeometry(staged, api, seen as never), "the STEP fixture opens");
  markDirty(api, staged);
  const uri = vscode.Uri.file(staged);

  await withModals([pick("Save in place")], async () => {
    await api.saveDocument!(uri);
    assert(await waitFor(() => readSidecarJson(`${staged}.edits.json`).bakedThrough === 1), "the first save lands");
  });
  const bakAfterFirst = fs.readFileSync(`${staged}.bak`);
  const sourceAfterFirst = fs.readFileSync(staged);

  // A new op arrives the way an MCP agent's would — an external sidecar write
  // the watcher reconciles (the suite cannot push ops through the webview).
  seen.length = 0;
  const sub = api.onDidPostMessage?.((m) =>
    void seen.push(m.type === "status" ? (m as unknown as { text: string }).text : m.type)
  );
  try {
    const op2 = { op: "translate", targets: ["solid-0"], vec: [0, 5, 0] };
    fs.writeFileSync(
      `${staged}.edits.json`,
      JSON.stringify({ version: 1, source: path.basename(staged), ops: [op1, op2], bakedThrough: 1 })
    );
    assert(
      await waitFor(() => seen.includes("Edits updated externally"), 15000),
      "the external op is reconciled before the second save"
    );
  } finally {
    sub?.dispose();
  }

  // No modal scripted: the second save in a session must not re-confirm, and
  // an unscripted modal would throw via the stub — so reaching the watermark
  // also proves the suppression.
  await withModals([], async () => {
    await api.saveDocument!(uri);
    assert(await waitFor(() => readSidecarJson(`${staged}.edits.json`).bakedThrough === 2, 60000), "the second save advances the watermark to 2");
  });
  const sidecar = readSidecarJson(`${staged}.edits.json`);
  assert((sidecar.ops as unknown[])?.length === 2, "the sidecar keeps both ops after the second save");
  assert(fs.readFileSync(`${staged}.bak`).equals(bakAfterFirst), ".bak stays one-deep (pre-first-save bytes)");
  assert(!fs.readFileSync(staged).equals(sourceAfterFirst), "the source is re-baked with the second op");
  await clearDirtyViaNoopSave();
  await closeAll();
});

test("Reopening a save is stable; a stale watermark double-applies (sensitivity control)", async () => {
  const api = await saveTestApi();
  if (!api?.saveDocument) return;

  const staged = stage(STEP_FIXTURE);
  const op1 = { op: "translate", targets: ["solid-0"], vec: [5, 0, 0] };
  fs.writeFileSync(`${staged}.edits.json`, JSON.stringify({ version: 1, source: path.basename(staged), ops: [op1] }));
  const uri = vscode.Uri.file(staged);

  let seen: Array<{ type: string; meshes?: Array<{ positions?: string }> }> = [];
  assert(await openAndWaitGeometry(staged, api, seen), "the STEP fixture opens");
  markDirty(api, staged);
  await withModals([pick("Save in place")], async () => {
    await api.saveDocument!(uri);
    assert(await waitFor(() => readSidecarJson(`${staged}.edits.json`).bakedThrough === 1), "the save lands");
  });
  await sleep(1500); // let the post-save reload's geometry post land
  const g1 = minXOfPosts(seen);
  assert(g1 !== null, "a post-save geometry baseline is recorded");
  await clearDirtyViaNoopSave();
  await closeAll();

  // Clean reopen: the baked tail must NOT replay again.
  seen = [];
  assert(await openAndWaitGeometry(staged, api, seen), "the saved file reopens");
  await sleep(1500);
  const g2 = minXOfPosts(seen);
  assert(g1 !== null && g2 !== null && Math.abs(g2 - g1) < 1e-6, `reopening is geometrically stable (Δx ${g1} → ${g2})`);
  await closeAll();

  // Negative control: forge a stale watermark and confirm this harness CAN
  // see the double-apply — otherwise the stability assertion above is vacuous.
  const forged = JSON.parse(fs.readFileSync(`${staged}.edits.json`, "utf8"));
  forged.bakedThrough = 0;
  fs.writeFileSync(`${staged}.edits.json`, JSON.stringify(forged));
  seen = [];
  assert(await openAndWaitGeometry(staged, api, seen), "the forged-watermark file reopens");
  await sleep(1500);
  const g3 = minXOfPosts(seen);
  assert(
    g1 !== null && g3 !== null && g3 - g1 > 4 && g3 - g1 < 6,
    `a stale watermark replays the baked +5 op a second time (Δx ${g1} → ${g3})`
  );
  await closeAll();

  // Restore the true watermark: stability returns, proving the file itself
  // was never corrupted by the experiment.
  forged.bakedThrough = 1;
  fs.writeFileSync(`${staged}.edits.json`, JSON.stringify(forged));
  seen = [];
  assert(await openAndWaitGeometry(staged, api, seen), "the repaired file reopens");
  await sleep(1500);
  const g4 = minXOfPosts(seen);
  assert(g1 !== null && g4 !== null && Math.abs(g4 - g1) < 1e-6, "the repaired file is stable again");
  await closeAll();
});

test("Save As copies source and sidecars; cross-format is refused", async () => {
  const api = await saveTestApi();
  if (!api?.saveDocumentAs) return;

  const staged = stage(STEP_FIXTURE);
  fs.writeFileSync(
    `${staged}.edits.json`,
    JSON.stringify({
      version: 1,
      source: path.basename(staged),
      ops: [{ op: "translate", targets: ["solid-0"], vec: [5, 0, 0] }],
      bakedThrough: 1,
    })
  );
  fs.writeFileSync(
    `${staged}.parts.json`,
    JSON.stringify({ version: 1, source: path.basename(staged), parts: [] })
  );
  assert(await openDocument(staged), "the STEP fixture opens");

  // The workbench's own Save As dialog is native UI the modal stubs cannot
  // intercept, so the Test seam calls the copy join directly — the dialog
  // itself is not what's under test here.
  const dest = path.join(path.dirname(staged), "copy.stp");
  await api.saveDocumentAs(vscode.Uri.file(staged), vscode.Uri.file(dest));
  assert(fs.readFileSync(dest).equals(fs.readFileSync(staged)), "Save As copies the source bytes verbatim");
  assert(fs.existsSync(`${dest}.edits.json`), "the edits sidecar lands beside the destination");
  const copied = readSidecarJson(`${dest}.edits.json`);
  assert(copied.bakedThrough === 1 && (copied.ops as unknown[])?.length === 1, "the copy keeps the watermark verbatim");
  assert(fs.existsSync(`${dest}.parts.json`), "present sidecars copy alongside");

  const crossDest = path.join(path.dirname(staged), "copy.stl");
  let threw = false;
  try {
    await api.saveDocumentAs(vscode.Uri.file(staged), vscode.Uri.file(crossDest));
  } catch (err) {
    threw = /keeps the source format/.test((err as Error).message);
  }
  assert(!fs.existsSync(crossDest), "a cross-format Save As writes nothing");
  assert(threw, "a cross-format Save As fails loudly naming Export instead");
  await closeAll();
});

test("Revert drops the op list to the save point", async () => {
  const api = await saveTestApi();
  if (!api?.saveDocument || !api?.revertDocument) return;

  const staged = stage(STEP_FIXTURE);
  const op1 = { op: "translate", targets: ["solid-0"], vec: [5, 0, 0] };
  fs.writeFileSync(`${staged}.edits.json`, JSON.stringify({ version: 1, source: path.basename(staged), ops: [op1] }));
  const seen: Array<{ type: string }> = [];
  assert(await openAndWaitGeometry(staged, api, seen as never), "the STEP fixture opens");
  markDirty(api, staged);
  const uri = vscode.Uri.file(staged);

  await withModals([pick("Save in place")], async () => {
    await api.saveDocument!(uri);
    assert(await waitFor(() => readSidecarJson(`${staged}.edits.json`).bakedThrough === 1), "the save lands");
  });

  // An unbaked op arrives externally, then File: Revert File must drop it.
  seen.length = 0;
  const sub = api.onDidPostMessage?.((m) =>
    void seen.push(m.type === "status" ? (m as unknown as { text: string }).text : m.type)
  );
  try {
    const op2 = { op: "translate", targets: ["solid-0"], vec: [0, 5, 0] };
    fs.writeFileSync(
      `${staged}.edits.json`,
      JSON.stringify({ version: 1, source: path.basename(staged), ops: [op1, op2], bakedThrough: 1 })
    );
    assert(await waitFor(() => seen.includes("Edits updated externally"), 15000), "the external op is reconciled");
  } finally {
    sub?.dispose();
  }

  seen.length = 0;
  const sub2 = api.onDidPostMessage?.((m) =>
    void seen.push(m.type === "status" ? (m as unknown as { text: string }).text : m.type)
  );
  try {
    await api.revertDocument!(uri);
    const reverted = await waitFor(() => {
      const s = readSidecarJson(`${staged}.edits.json`);
      return s.bakedThrough === 1 && (s.ops as unknown[])?.length === 1;
    });
    assert(reverted, "revert truncates the sidecar to the watermark");
    assert(await waitFor(() => seen.includes("geometry"), 30000), "revert re-tessellates the saved state");
    assert(seen.includes("Reverted to the last save."), "revert reports itself on the status line");
  } finally {
    sub2?.dispose();
  }
  await clearDirtyViaNoopSave();
  await closeAll();
});

test("Hot-exit backup round-trips through the real filesystem and reopens", async () => {
  const staged = stage(STEP_FIXTURE);
  fs.writeFileSync(
    `${staged}.edits.json`,
    JSON.stringify({
      version: 1,
      source: path.basename(staged),
      ops: [{ op: "translate", targets: ["solid-0"], vec: [5, 0, 0] }],
    })
  );
  const sourceUri = vscode.Uri.file(staged);
  const dest = vscode.Uri.file(path.join(tempDir(), "backup"));
  const backup = await writeCustomBackup(sourceUri, [vscode.Uri.file(`${staged}.edits.json`)], dest);
  assert(!!backup.id, "a backup snapshot is written");

  // Mutate past the snapshot (an unsaved tail plus a dirty sidecar edit).
  fs.writeFileSync(staged, Buffer.from("MUTATED SOURCE — MUST BE RESTORED OVER"));
  fs.writeFileSync(`${staged}.edits.json`, JSON.stringify({ version: 1, source: "x", ops: [] }));
  await restoreCustomBackup(backup.id, sourceUri);
  assert(fs.readFileSync(staged).toString("utf8").startsWith("ISO-10303-21"), "restore brings back the real STEP source");
  const restored = readSidecarJson(`${staged}.edits.json`);
  assert((restored.ops as unknown[])?.length === 1, "restore brings back the snapshotted sidecar");
  backup.delete();

  const api = await saveTestApi();
  const seen: Array<{ type: string }> = [];
  assert(await openAndWaitGeometry(staged, api, seen as never), "the restored file opens and posts geometry");
  await closeAll();
});

test("Source-write failure preserves bytes and advances nothing", async () => {
  const api = await saveTestApi();
  if (!api?.saveDocument) return;

  const staged = stage(STEP_FIXTURE);
  fs.writeFileSync(
    `${staged}.edits.json`,
    JSON.stringify({
      version: 1,
      source: path.basename(staged),
      ops: [{ op: "translate", targets: ["solid-0"], vec: [5, 0, 0] }],
    })
  );
  const before = fs.readFileSync(staged);
  const seen: Array<{ type: string }> = [];
  assert(await openAndWaitGeometry(staged, api, seen as never), "the STEP fixture opens");
  markDirty(api, staged);
  const uri = vscode.Uri.file(staged);

  // Fail exactly the temp-sibling write: `vscode.workspace.fs` is a frozen
  // API object (assignment throws), so the fault is injected with the real
  // filesystem instead — a directory where the temp file would land makes
  // `writeFile` fail, and every other path still works.
  const tmpPath = path.join(path.dirname(staged), `${path.basename(staged, ".stp")}.save-tmp.step`);
  fs.mkdirSync(tmpPath);
  const errors: string[] = [];
  const sub = api.onDidPostMessage?.((m) => {
    if (m.type === "error") errors.push((m as { message?: string }).message ?? "");
  });
  try {
    await withModals([pick("Save in place")], async () => {
      await api.saveDocument!(uri);
      await sleep(1500);
    });
  } finally {
    fs.rmSync(tmpPath, { recursive: true, force: true });
    sub?.dispose();
  }
  assert(fs.readFileSync(staged).equals(before), "a failed source write leaves the source byte-identical");
  assert(readSidecarJson(`${staged}.edits.json`).bakedThrough !== 1, "a failed source write advances no watermark");
  assert(fs.existsSync(`${staged}.bak`) && fs.readFileSync(`${staged}.bak`).equals(before), ".bak (written before the temp file) still holds the pre-save bytes");
  assert(errors.some((e) => /Save in place failed/.test(e)), "the failure surfaces instead of reading as a save");
  // Still dirty (nothing baked): revert-and-close discards the dot without a save prompt.
  await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  await sleep(500);
  await closeAll();
});

test("Watermark-write failure rolls the source back; retry then succeeds", async () => {
  const api = await saveTestApi();
  if (!api?.saveDocument) return;

  const staged = stage(STEP_FIXTURE);
  fs.writeFileSync(
    `${staged}.edits.json`,
    JSON.stringify({
      version: 1,
      source: path.basename(staged),
      ops: [{ op: "translate", targets: ["solid-0"], vec: [5, 0, 0] }],
    })
  );
  const before = fs.readFileSync(staged);
  const seen: Array<{ type: string }> = [];
  assert(await openAndWaitGeometry(staged, api, seen as never), "the STEP fixture opens");
  markDirty(api, staged);
  const uri = vscode.Uri.file(staged);

  // Fail exactly the watermark write: the source IS rewritten first, so
  // without the rollback this would leave a baked file with a stale sidecar.
  // `vscode.workspace.fs` is frozen (assignment throws), so the fault is
  // injected with the real filesystem: a directory where the sidecar lives
  // makes its `writeFile` fail. Note the save's own `flushSidecars()` also
  // fails on it first — that posts "Save failed" but does not stop the bake,
  // which is exactly the partial state under test.
  const sidecarPath = `${staged}.edits.json`;
  const sidecarContent = fs.readFileSync(sidecarPath);
  fs.rmSync(sidecarPath);
  fs.mkdirSync(sidecarPath);
  const errors: string[] = [];
  const reconciles: string[] = [];
  const sub = api.onDidPostMessage?.((m) => {
    if (m.type === "error") errors.push((m as { message?: string }).message ?? "");
    if (m.type === "status") reconciles.push((m as unknown as { text: string }).text);
  });
  try {
    await withModals([pick("Save in place")], async () => {
      await api.saveDocument!(uri);
      await sleep(1500);
    });
  } finally {
    fs.rmSync(sidecarPath, { recursive: true, force: true });
    fs.writeFileSync(sidecarPath, sidecarContent);
    sub?.dispose();
  }
  assert(fs.readFileSync(staged).equals(before), "the source is rolled back to its pre-save bytes");
  assert(readSidecarJson(sidecarPath).bakedThrough !== 1, "the watermark stays down after the rollback");
  assert(
    errors.some((e) => /watermark write failed/.test(e) && /restored to its pre-save bytes/.test(e)),
    "the rollback reports itself loudly instead of claiming a save"
  );

  // While the sidecar was a directory, the edits watcher read it as
  // unreadable — and `readEdits` degrades an unreadable file to an EMPTY op
  // list, so the session's in-memory ops were wiped (a retry right now would
  // see an empty tail and correctly no-op). Restoring the file re-fires the
  // watcher; the retry must wait for that reconcile first. This is genuine
  // coverage of recovery-through-reconciliation, not test choreography.
  const reconciledBefore = reconciles.filter((t) => t === "Edits updated externally").length;
  const sub2 = api.onDidPostMessage?.((m) => {
    if (m.type === "status" && (m as unknown as { text: string }).text === "Edits updated externally") reconciles.push("Edits updated externally");
  });
  try {
    // Best-effort (no assert): if the wipe happened, this restores the ops
    // before the retry; if it didn't, the retry works immediately and the
    // final watermark assertion below discriminates either way.
    await waitFor(
      () => reconciles.filter((t) => t === "Edits updated externally").length > reconciledBefore,
      15000
    );
  } finally {
    sub2?.dispose();
  }

  // The documented recovery is simply saving again: no modal (the `.bak`
  // already exists from the failed attempt), watermark lands, source bakes.
  await withModals([], async () => {
    await api.saveDocument!(uri);
    assert(await waitFor(() => readSidecarJson(sidecarPath).bakedThrough === 1, 60000), "retrying the save after the rollback succeeds");
  });
  assert(!fs.readFileSync(staged).equals(before), "the retried save rewrites the source");
  await clearDirtyViaNoopSave();
  await closeAll();
});

test("A dirty edits sidecar fails the save before any write or modal", async () => {
  const api = await saveTestApi();
  if (!api?.saveDocument) return;

  const staged = stage(STEP_FIXTURE);
  fs.writeFileSync(
    `${staged}.edits.json`,
    JSON.stringify({
      version: 1,
      source: path.basename(staged),
      ops: [{ op: "translate", targets: ["solid-0"], vec: [5, 0, 0] }],
    })
  );
  const before = fs.readFileSync(staged);
  const seen: Array<{ type: string }> = [];
  assert(await openAndWaitGeometry(staged, api, seen as never), "the STEP fixture opens");
  markDirty(api, staged);

  const sidecar = vscode.Uri.file(`${staged}.edits.json`);
  const doc = await vscode.workspace.openTextDocument(sidecar);
  const editor = await vscode.window.showTextDocument(doc);
  await editor.edit((e) => e.insert(new vscode.Position(0, 0), " "));
  assert(doc.isDirty, "the edits sidecar is open with unsaved changes");

  const errors: string[] = [];
  const sub = api.onDidPostMessage?.((m) => {
    if (m.type === "error") errors.push((m as { message?: string }).message ?? "");
  });
  // No modal scripted: the pre-check must trip before the confirmation, and
  // an unscripted modal would throw via the stub.
  const record = await withModals([], async () => {
    await api.saveDocument!(vscode.Uri.file(staged));
    await sleep(1500);
  });
  sub?.dispose();
  assert(record.warnings.length === 0, "no confirmation modal opens when the sidecar is dirty");
  assert(fs.readFileSync(staged).equals(before), "the source is untouched");
  assert(!fs.existsSync(`${staged}.bak`), "no .bak is created for a pre-check refusal");
  assert(errors.some((e) => /unsaved changes/i.test(e)), "the refusal names the dirty sidecar");

  await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  await sleep(300);
  await withModals([pick("Save in place")], async () => {
    await api.saveDocument!(vscode.Uri.file(staged));
    assert(await waitFor(() => readSidecarJson(`${staged}.edits.json`).bakedThrough === 1, 60000), "the save goes through once the buffer is clean");
  });
  await clearDirtyViaNoopSave();
  await closeAll();
});

test("Save-time rebind keeps Part and annotation ids on a translated save", async () => {
  const api = await saveTestApi();
  if (!api?.saveDocument) return;

  const staged = stage(STEP_FIXTURE);
  fs.writeFileSync(
    `${staged}.edits.json`,
    JSON.stringify({
      version: 1,
      source: path.basename(staged),
      ops: [{ op: "translate", targets: ["solid-0"], vec: [5, 0, 0] }],
    })
  );
  fs.writeFileSync(
    `${staged}.parts.json`,
    JSON.stringify({
      version: 1,
      source: path.basename(staged),
      parts: [{ name: "Body", color: "#ff0000", volumes: ["solid-0"], surfaces: [], lines: [], points: [] }],
    })
  );
  fs.writeFileSync(
    `${staged}.annotations.json`,
    JSON.stringify({
      version: 1,
      source: path.basename(staged),
      annotations: [
        {
          id: "ann-1",
          tool: "distance",
          text: "5 mm",
          anchorPoint: [0, 0, 0],
          linePoints: [],
          volumes: ["solid-0"],
          surfaces: [],
          lines: [],
          points: [],
        },
      ],
    })
  );
  const seen: Array<{ type: string }> = [];
  const errors: string[] = [];
  assert(await openAndWaitGeometry(staged, api, seen as never), "the STEP fixture opens");
  markDirty(api, staged);
  const sub = api.onDidPostMessage?.((m) => {
    if (m.type === "error") errors.push((m as { message?: string }).message ?? "");
  });
  try {
    await withModals([pick("Save in place")], async () => {
      await api.saveDocument!(vscode.Uri.file(staged));
      assert(await waitFor(() => readSidecarJson(`${staged}.edits.json`).bakedThrough === 1, 60000), "the save lands");
    });
    await sleep(2000); // the two-byte rebind runs after the watermark write
  } finally {
    sub?.dispose();
  }
  const parts = JSON.parse(fs.readFileSync(`${staged}.parts.json`, "utf8"));
  assert(
    parts.parts?.[0]?.volumes?.join(",") === "solid-0",
    `the Part still references solid-0 after the save (got ${JSON.stringify(parts.parts?.[0]?.volumes)})`
  );
  const annotations = JSON.parse(fs.readFileSync(`${staged}.annotations.json`, "utf8"));
  assert(
    annotations.annotations?.[0]?.volumes?.join(",") === "solid-0",
    "the annotation anchor survives the save"
  );
  assert(!errors.some((e) => /Could not rebind/.test(e)), "no rebind-failure warning is posted for an identical-shape save");
  await clearDirtyViaNoopSave();
  await closeAll();
});

test("Mesh save-in-place (STL) bakes with .bak + watermark; second save is a no-op", async () => {
  const api = await saveTestApi();
  if (!api?.saveDocument || !api?.setExportMeshStub) return;

  const staged = stage(STL_FIXTURE);
  fs.writeFileSync(
    `${staged}.edits.json`,
    JSON.stringify({
      version: 1,
      source: path.basename(staged),
      ops: [{ op: "translate", targets: ["node-0"], vec: [5, 0, 0] }],
    })
  );
  const before = fs.readFileSync(staged);
  const stubBytes = fs.readFileSync(STL_FIXTURE);
  api.setExportMeshStub(() => stubBytes);
  const seen: Array<{ type: string; bakedThrough?: number }> = [];
  const sub = api.onDidPostMessage?.((m) => void seen.push(m as never));
  try {
    // Mesh sources post `loadUrl`, never `geometry` (see `loadModel`'s route
    // branch) — so this waits for the tab plus sidecar hydration, not a
    // geometry post. The stub covers the serialization the harness cannot
    // reach (no code here can answer a webview `exportMesh` round trip).
    assert(await openDocument(staged), "the STL fixture opens");
    await sleep(4000);
    markDirty(api, staged);
    // Tier 0 Phase 3: a mesh source offers its OWN format first, like B-rep.
    const record = await withModals([pick("STL"), pick("Save in place")], async () => {
      await vscode.commands.executeCommand("cad-preview.export");
      assert(await waitFor(() => readSidecarJson(`${staged}.edits.json`).bakedThrough === 1, 60000), "the mesh watermark lands");
    });
    const offered = record.quickPicks[0]?.labels ?? [];
    assert(offered[0] === "STL", `the source's own mesh format leads the quick-pick (offered ${JSON.stringify(offered)})`);
    assert(record.saveDialogs.length === 0, "mesh save-in-place shows no save dialog");
    assert(fs.readFileSync(staged).equals(stubBytes), "the source is replaced by the serialized bytes");
    assert(fs.existsSync(`${staged}.bak`) && fs.readFileSync(`${staged}.bak`).equals(before), "a one-deep .bak holds the pre-save bytes");
    const editsPost = [...seen].reverse().find((m) => m.type === "edits");
    assert(editsPost?.bakedThrough === 1, "the webview is told the new save point so its replay slices the tail");

    // Empty tail: no modal (unscripted would throw), no rewrite.
    const savedOnce = fs.readFileSync(staged);
    await withModals([], async () => {
      await api.saveDocument!(vscode.Uri.file(staged));
      await sleep(1500);
    });
    assert(fs.readFileSync(staged).equals(savedOnce), "a second save with an empty tail rewrites nothing");
  } finally {
    sub?.dispose();
    api.setExportMeshStub(undefined);
  }
  await clearDirtyViaNoopSave();
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
    for (const id of ["cad-preview.export", "cad-preview.saveAs", "cad-preview.exportSvg", "cad-preview.savePreprocess", "cad-preview.zoomToSelection"]) {
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

  // `/tmp/cad-preview-test-only` (a substring) runs only matching cases —
  // iterating on one kernel-slow case without paying for the whole suite
  // each time. The launcher does not forward env into the test VS Code, so a
  // file (written from the shell before spawning) is the channel. Absent file
  // runs everything; delete it afterwards.
  let only: string | undefined;
  try {
    only = fs.readFileSync("/tmp/cad-preview-test-only", "utf8").trim() || undefined;
  } catch {
    only = undefined;
  }
  for (const c of CASES) {
    if (only && !c.name.includes(only)) continue;
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
