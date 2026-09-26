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
import { installModalStubs, pick, save, cancel, open as openAnswer, waitForFile, waitFor, type ModalAnswer } from "./modalStubs";
import { writeParts } from "../../../src/partsStore";
import { serializeEditsJson } from "../../../src/editsSidecar";
import { hashBytes, serializeSaveJournal } from "../../../src/saveJournal";
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
  simulateWebviewMessage?: (uri: vscode.Uri, msg: unknown) => Promise<void>;
  setExportMeshStub?: (stub: ((format: string) => Uint8Array | undefined) | undefined) => void;
  setSheetFormAnswer?: (answer: ((opts: unknown) => Promise<unknown>) | undefined) => void;
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

/**
 * Mesh-format sources through the same command (roadmap Tier 1 "Parity
 * gaps"). The command used to refuse them — the geometry lived in the
 * webview — and now resolves it host-side through `meshSourceInput.ts`, the
 * resolver `export_mesh` uses. Covers both halves of that resolver: a native
 * STL (parsed host-side) and a meshio++ source (converted by the kernel worker).
 */
for (const [label, fixture, siblings] of [
  ["STL", STL_FIXTURE, [] as string[]],
  ["GiD (meshio)", GID_FIXTURE, [GID_SIBLING]],
] as const) {
  test(`Export FE Mesh… meshes a ${label} source host-side`, async () => {
    const staged = stage(fixture, [...siblings]);
    const out = path.join(path.dirname(staged), "from-mesh.msh");
    const before = fs.readFileSync(staged);
    assert(await openDocument(staged), `the ${label} fixture opens`);
    await withModals([pick("Gmsh Mesh (.msh)"), pick("Native"), save(out)], async () => {
      await vscode.commands.executeCommand("cad-preview.exportMesh");
      await waitForFile(out, 120000);
    });
    assert(fs.existsSync(out) && fs.statSync(out).size > 0, `the ${label} source exports a .msh`);
    assert(fs.readFileSync(out, "utf8").includes("$Elements"), `the ${label} export is a real Gmsh mesh`);
    assert(Buffer.compare(before, fs.readFileSync(staged)) === 0, "the source is byte-identical");
    await closeAll();
  });
}

/**
 * Headless mesh-edit replay through the same command: a pending translate in
 * the STL's sidecar is baked by the kernel worker before meshing, so the
 * exported FE mesh sits where the viewer displays the edited cube.
 */
test("Export FE Mesh… bakes a mesh source's pending edits", async () => {
  const minX = (msh: string): number => {
    const lines = msh.split(/\r?\n/);
    let i = lines.indexOf("$Nodes") + 2;
    let min = Infinity;
    while (lines[i] !== "$EndNodes") {
      const count = Number(lines[i].split(/\s+/)[3]);
      i += 1 + count;
      for (let k = 0; k < count; k++, i++) min = Math.min(min, Number(lines[i].split(/\s+/)[0]));
    }
    return min;
  };
  const exportOnce = async (staged: string, name: string): Promise<number> => {
    const out = path.join(path.dirname(staged), name);
    assert(await openDocument(staged), "the STL fixture opens");
    await withModals([pick("Gmsh Mesh (.msh)"), pick("Native"), save(out)], async () => {
      await vscode.commands.executeCommand("cad-preview.exportMesh");
      await waitForFile(out, 120000);
    });
    await closeAll();
    return minX(fs.readFileSync(out, "utf8"));
  };
  const raw = await exportOnce(stage(STL_FIXTURE), "raw.msh");
  const edited = stage(STL_FIXTURE);
  fs.writeFileSync(
    `${edited}.edits.json`,
    serializeEditsJson(path.basename(edited), [{ op: "translate", targets: ["node-0"], vec: [100, 0, 0] }])
  );
  const before = fs.readFileSync(edited);
  const api = await saveTestApi();
  const statuses: string[] = [];
  const sub = api?.onDidPostMessage?.((m) => {
    const msg = m as { type: string; text?: string; message?: string };
    if (msg.type === "status" || msg.type === "error") statuses.push(msg.text ?? msg.message ?? "");
  });
  let baked: number;
  try {
    baked = await exportOnce(edited, "baked.msh");
  } finally {
    sub?.dispose();
  }
  assert(
    Math.abs(baked - (raw + 100)) < 1e-3,
    `the exported mesh moved by the pending translate (min x ${raw} -> ${baked}; statuses ${JSON.stringify(statuses.filter((t) => /bake|Bake|edit/.test(t)))})`
  );
  assert(Buffer.compare(before, fs.readFileSync(edited)) === 0, "the source is byte-identical");
});

/**
 * Roadmap 1.5, "Recoverable mesh source saves" — recovery on open, driven
 * through a REAL save-in-place interruption.
 *
 * Each case stages the exact on-disk state a process death at one write
 * boundary would leave — the baked source, the one-deep `.bak`, the sidecar
 * with a STALE watermark, and (where relevant) the transaction marker — then
 * opens the document for real. Nothing here pushes ops through the webview or
 * reaches into `provider.ts`.
 *
 * **The geometric assertion is the whole point, so it goes through geometry.**
 * The staged source is the PRISTINE cube and the journal's `bakedSha256` is its
 * hash, which is a valid transaction whose baked output happened to equal its
 * input. That isolates the watermark as the only variable:
 *   - recovered   → the tail is empty  → the exported mesh sits at `raw`
 *   - not recovered → the tail replays → the exported mesh sits at `raw + 100`
 * `cad-preview.exportMesh` bakes the tail through the kernel worker
 * (`meshSourceInput.ts`), so the exported `.msh` node coordinates ARE the
 * geometry the user would be looking at. The un-recovered case doubles as the
 * sensitivity control: it proves this harness can see the double-apply at all.
 */
const mshMinX = (msh: string): number => {
  const lines = msh.split(/\r?\n/);
  let i = lines.indexOf("$Nodes") + 2;
  let min = Infinity;
  while (lines[i] !== "$EndNodes") {
    const count = Number(lines[i].split(/\s+/)[3]);
    i += 1 + count;
    for (let k = 0; k < count; k++, i++) min = Math.min(min, Number(lines[i].split(/\s+/)[0]));
  }
  return min;
};

/**
 * The fixture is an ASCII STL, so appending a space to its header line yields
 * a byte-different but geometrically IDENTICAL — and still valid, still
 * meshable — variant. That is what lets the three hashes a journal carries be
 * made genuinely distinct without hand-authoring any geometry: `PRE_BYTES` and
 * `OTHER_BYTES` differ from each other and from the pristine file, so each
 * recovery branch can be reached with a real, working mesh on disk.
 */
const preSaveBytes = (fixture: string): Buffer => Buffer.from(fs.readFileSync(fixture).toString("utf8").replace("solid cube", "solid cube "), "utf8");
const otherBytes = (fixture: string): Buffer => Buffer.from(fs.readFileSync(fixture).toString("utf8").replace("solid cube", "solid cube  "), "utf8");

/** Stages an interrupted mesh save-in-place at one of its write boundaries. */
function stageInterruptedSave(
  fixture: string,
  opts: { bakedThrough?: number; withJournal?: boolean; sourceBytes?: Buffer; preSave?: Buffer } = {}
): string {
  const staged = stage(fixture);
  const source = opts.sourceBytes ?? fs.readFileSync(fixture);
  fs.writeFileSync(staged, source);
  fs.writeFileSync(`${staged}.bak`, opts.preSave ?? preSaveBytes(fixture));
  fs.writeFileSync(
    `${staged}.edits.json`,
    serializeEditsJson(path.basename(staged), [{ op: "translate", targets: ["node-0"], vec: [100, 0, 0] }], [], opts.bakedThrough ?? 0)
  );
  if (opts.withJournal !== false) {
    fs.writeFileSync(
      `${staged}.save-journal.json`,
      serializeSaveJournal({
        version: 1,
        source: path.basename(staged),
        saveId: "save-1",
        startedAt: "2026-09-26T00:00:00.000Z",
        format: "stl",
        bakedThrough: 1,
        preSaveSha256: hashBytes(opts.preSave ?? preSaveBytes(fixture)),
        // The pristine fixture IS this transaction's baked output, so the
        // journal describes a real save whose result happened to equal its
        // input. That isolates the watermark as the only variable.
        bakedSha256: hashBytes(fs.readFileSync(fixture)),
      })
    );
  }
  return staged;
}

/**
 * Exports the focused STL's FE mesh and returns its minimum node x.
 *
 * `leading` scripts any modals raised BEFORE the export's own — notably the
 * recovery prompt, which fires while the document opens. The stub queue is
 * FIFO across every modal, so the whole flow is one flat script; nesting
 * `withModals` would return the inner *record* rather than the body value,
 * which is exactly the bug this shape avoids.
 */
async function exportMinX(staged: string, name: string, leading: ModalAnswer[] = []): Promise<number> {
  const out = path.join(path.dirname(staged), name);
  await withModals([...leading, pick("Gmsh Mesh (.msh)"), pick("Native"), save(out)], async () => {
    assert(await openDocument(staged), "the staged STL fixture opens");
    await vscode.commands.executeCommand("cad-preview.exportMesh");
    await waitForFile(out, 120000);
  });
  await closeAll();
  return mshMinX(fs.readFileSync(out, "utf8"));
}

test("An interrupted mesh save is completed on open, not replayed over the baked geometry", async () => {
  const raw = await exportMinX(stage(STL_FIXTURE), "raw.msh");
  const staged = stageInterruptedSave(STL_FIXTURE);
  const before = fs.readFileSync(staged);
  const api = await saveTestApi();
  const statuses: string[] = [];
  const sub = api?.onDidPostMessage?.((m) => {
    const msg = m as { type: string; text?: string; message?: string; bakedThrough?: number };
    if (msg.type === "status" || msg.type === "error") statuses.push(msg.text ?? msg.message ?? "");
  });
  let recovered: number;
  try {
    recovered = await exportMinX(staged, "recovered.msh");
  } finally {
    sub?.dispose();
  }
  assert(
    Math.abs(recovered - raw) < 1e-3,
    `the pending translate is NOT replayed over the already-baked geometry (min x ${raw} vs ${recovered})`
  );
  assert(
    statuses.some((t) => /interrupted save/i.test(t) && /completed/i.test(t)),
    `the user is told the save was completed (saw ${JSON.stringify(statuses)})`
  );
  assert(!fs.existsSync(`${staged}.save-journal.json`), "the transaction marker is cleared");
  assert(Buffer.compare(before, fs.readFileSync(staged)) === 0, "recovery never rewrites the source");
});

test("An interrupted mesh save with no marker double-applies — the sensitivity control", async () => {
  // The staged file is byte-identical to the recovered case above MINUS the
  // journal. If this does not show the +100 double-apply, the assertion above
  // is vacuous.
  const raw = await exportMinX(stage(STL_FIXTURE), "raw2.msh");
  const staged = stageInterruptedSave(STL_FIXTURE, { withJournal: false });
  const doubled = await exportMinX(staged, "doubled.msh");
  assert(
    Math.abs(doubled - (raw + 100)) < 1e-3,
    `a stale watermark with no marker replays the baked +100 op a second time (min x ${raw} -> ${doubled})`
  );
});

test("An interrupted save whose source was never rewritten leaves the pending edits alone", async () => {
  const raw = await exportMinX(stage(STL_FIXTURE), "raw3.msh");
  // The source holds the journal's PRE-SAVE bytes, so the transaction is
  // discarded: the stale watermark was already correct and the tail still
  // applies. This is end state 1 of the two the item allows — not a
  // double-apply, and not a silent change either.
  const staged = stageInterruptedSave(STL_FIXTURE, { sourceBytes: preSaveBytes(STL_FIXTURE) });
  const api = await saveTestApi();
  const statuses: string[] = [];
  const sub = api?.onDidPostMessage?.((m) => {
    const msg = m as { type: string; text?: string; message?: string };
    if (msg.type === "status" || msg.type === "error") statuses.push(msg.text ?? msg.message ?? "");
  });
  let applied: number;
  try {
    applied = await exportMinX(staged, "discarded.msh");
  } finally {
    sub?.dispose();
  }
  assert(
    Math.abs(applied - (raw + 100)) < 1e-3,
    `the pending edit still applies exactly once (min x ${raw} -> ${applied}, expected ${raw + 100})`
  );
  assert(
    statuses.some((t) => /interrupted save/i.test(t) && /never rewritten/i.test(t)),
    `the user is told the file was never rewritten (saw ${JSON.stringify(statuses)})`
  );
  assert(!fs.existsSync(`${staged}.save-journal.json`), "the stale marker is cleared");
});

test("An unrecognised source is reported, never silently overwritten, and does not prompt twice", async () => {
  const raw = await exportMinX(stage(STL_FIXTURE), "raw4.msh");
  // The source matches NEITHER hash: a torn write, or an external edit landing
  // inside the crash window. Headless this is a warning; interactively it is a
  // prompt, and "keep the file" must change nothing at all.
  const torn = otherBytes(STL_FIXTURE);
  const staged = stageInterruptedSave(STL_FIXTURE, { sourceBytes: torn });
  const api = await saveTestApi();
  const statuses: string[] = [];
  const sub = api?.onDidPostMessage?.((m) => {
    const msg = m as { type: string; text?: string; message?: string };
    if (msg.type === "status" || msg.type === "error") statuses.push(msg.text ?? msg.message ?? "");
  });
  let applied: number;
  try {
    applied = await exportMinX(staged, "kept.msh", [pick("Keep the current file")]);
  } finally {
    sub?.dispose();
  }
  assert(Buffer.compare(torn, fs.readFileSync(staged)) === 0, "the unrecognised source is left byte-identical");
  assert(
    statuses.some((t) => /interrupted save/i.test(t) && /Nothing has been changed/i.test(t)),
    `the unrecognised state is reported as an ERROR, not silently ignored (saw ${JSON.stringify(statuses)})`
  );
  assert(fs.existsSync(`${staged}.save-journal.json`), "the marker survives so the evidence is not destroyed");
  // The tail still applies — nothing was treated as baked.
  assert(Math.abs(applied - (raw + 100)) < 1e-3, `the pending edit still applies (min x ${raw} -> ${applied})`);
  // A second open asks nothing.
  const again = await exportMinX(staged, "kept2.msh");
  assert(Math.abs(again - applied) < 1e-6, "a second recovery is a no-op (and asks nothing)");
});

test("The unrecognised source can be rolled back to the pre-save backup", async () => {
  const staged = stageInterruptedSave(STL_FIXTURE, { sourceBytes: otherBytes(STL_FIXTURE) });
  const record = await withModals([pick("Restore the pre-save backup")], async () => {
    assert(await openDocument(staged), "the staged STL fixture opens");
  });
  const offered = record.warnings[0]?.buttons ?? [];
  assert(
    offered.includes("Restore the pre-save backup") && offered.includes("Keep the current file"),
    `the prompt offers both repairs by name (offered ${JSON.stringify(offered)})`
  );
  assert(
    Buffer.compare(preSaveBytes(STL_FIXTURE), fs.readFileSync(staged)) === 0,
    "the source is restored to the pre-save backup's bytes"
  );
  // The decision is recorded, so this cannot prompt again.
  assert(fs.existsSync(`${staged}.save-journal.json`), "the marker survives, carrying the recorded decision");
  await closeAll();
  const leftover = await withModals([], async () => {
    assert(await openDocument(staged), "the document reopens with no modal scripted");
  });
  assert(leftover.warnings.length === 0, `a second open asks nothing (saw ${JSON.stringify(leftover.warnings)})`);
  await closeAll();
});

test("Recovery is a no-op when the watermark already landed, and still cleans up", async () => {
  const staged = stageInterruptedSave(STL_FIXTURE, { bakedThrough: 1 });
  const before = fs.readFileSync(staged);
  const record = await withModals([], async () => {
    assert(await openDocument(staged), "the staged STL fixture opens");
  });
  assert(
    !record.warnings.some((w) => /interrupted save/i.test(w.message)),
    `a save that completed is not reported as an interruption (saw ${JSON.stringify(record.warnings)})`
  );
  assert(!fs.existsSync(`${staged}.save-journal.json`), "the leftover marker is swept");
  assert(Buffer.compare(before, fs.readFileSync(staged)) === 0, "the source is untouched");
  await closeAll();
});

test("A B-rep source is never touched by mesh-save recovery", async () => {
  const staged = stage(STEP_FIXTURE);
  // A mesh-only marker planted on a STEP document must be ignored outright.
  fs.writeFileSync(
    `${staged}.save-journal.json`,
    serializeSaveJournal({
      version: 1,
      source: path.basename(staged),
      saveId: "save-1",
      startedAt: "2026-09-26T00:00:00.000Z",
      format: "step",
      bakedThrough: 1,
      preSaveSha256: hashBytes(fs.readFileSync(STEP_FIXTURE)),
      bakedSha256: hashBytes(fs.readFileSync(staged)),
    })
  );
  const before = fs.readFileSync(staged);
  const record = await withModals([], async () => {
    assert(await openDocument(staged), "the STEP fixture opens");
  });
  assert(!record.warnings.some((w) => /interrupted save/i.test(w.message)), "a STEP document is not a mesh-save subject");
  assert(fs.existsSync(`${staged}.save-journal.json`), "the marker is left for a human to look at");
  assert(Buffer.compare(before, fs.readFileSync(staged)) === 0, "the STEP source is untouched");
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

  // The menubar's document chip, host side (`syncDocumentInfo` in provider.ts).
  // Asserted HERE rather than in a standalone case on purpose: this test already
  // opens a document with a pending sidecar op and then bakes it — exactly the
  // lifecycle the chip must track — and every webview the suite opens is a
  // cumulative cost. A standalone case that opened two extra documents pushed a
  // LATER case past whatever resource ceiling the suite sits under (its webview
  // never posted `ready`), a regression untouched HEAD does not have.
  type DocInfo = { type: string; name?: string; path?: string; format?: string | null; dirty?: boolean; unsavedEdits?: number };
  const infosOf = (posts: Array<{ type: string }>) => (posts as DocInfo[]).filter((m) => m.type === "documentInfo");
  const openInfos = infosOf(seen);
  assert(openInfos.length >= 1, "a documentInfo is posted on open");
  assert(
    openInfos[0]?.name === path.basename(staged) && openInfos[0]?.path === staged && openInfos[0]?.format === "step",
    `it names the file and its routed format (got ${JSON.stringify(openInfos[0])})`
  );
  // Deliberate: the sidecar holds an unbaked op, so the SOURCE FILE does not
  // contain what is on screen — even though VS Code shows the tab clean until
  // the next edit. The chip answers a different question from the tab dot.
  assert(
    openInfos.at(-1)?.dirty === true,
    `an unbaked sidecar tail reports dirty at open (got ${JSON.stringify(openInfos.at(-1))})`
  );
  // The chip's "N unsaved edits": the same predicate, so the sidecar's single
  // unbaked op reads as exactly one.
  assert(
    openInfos.at(-1)?.unsavedEdits === 1,
    `the chip counts the unbaked tail (got ${JSON.stringify(openInfos.at(-1))})`
  );
  // Kernel readiness (status bar): the ready handshake posts a state, and opening
  // a B-rep document must end with OCCT reported ready — inferred from the load
  // call actually succeeding in the worker, not from a flag.
  assert(
    (seen as Array<{ type: string }>).some((m) => m.type === "kernelStatus"),
    "a kernelStatus is posted in the ready handshake"
  );
  assert(
    await waitFor(() =>
      (seen as Array<{ type: string; state?: { occt?: string } }>).some(
        (m) => m.type === "kernelStatus" && m.state?.occt === "ready"
      )
    ),
    "opening a B-rep document leaves OCCT reported ready once the load has succeeded"
  );

  markDirty(api, staged);

  const uri = vscode.Uri.file(staged);
  const later: DocInfo[] = [];
  const infoSub = api.onDidPostMessage?.((m) => void later.push(m as DocInfo));
  const record = await withModals([pick("Save in place")], async () => {
    await api.saveDocument!(uri);
    const settled = await waitFor(() => readSidecarJson(`${staged}.edits.json`).bakedThrough === 1);
    assert(settled, "the sidecar watermark lands after Ctrl+S");
  });
  const cleared = await waitFor(() => infosOf(later).some((i) => i.dirty === false), 10000);
  infoSub?.dispose();
  assert(cleared, `the chip is told the document is clean once the bake lands (saw ${JSON.stringify(infosOf(later))})`);
  assert(
    infosOf(later).find((i) => i.dirty === false)?.unsavedEdits === 0,
    "and its unsaved-edit count drops to zero with it"
  );
  // The poster is called at every op-list/watermark transition and deduplicates
  // against the last value it actually sent: no two ADJACENT posts may match.
  const serialized = [...openInfos, ...infosOf(later)].map((i) => JSON.stringify(i));
  assert(
    serialized.every((s, i) => i === 0 || s !== serialized[i - 1]),
    `documentInfo is deduplicated — no back-to-back identical posts (${serialized.length} posts)`
  );
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
  // Same reopen, seen by the menubar's document chip: the watermark now equals
  // the op count, so nothing is unbaked and the chip must NOT claim unsaved
  // edits. Pairs with the "dirty at open" assertion in the Ctrl+S case above.
  const reopenInfos = (seen as Array<{ type: string; name?: string; dirty?: boolean; unsavedEdits?: number }>).filter(
    (m) => m.type === "documentInfo"
  );
  assert(
    reopenInfos.length >= 1 &&
      reopenInfos.at(-1)?.dirty === false &&
      reopenInfos.at(-1)?.unsavedEdits === 0 &&
      reopenInfos.at(-1)?.name === path.basename(staged),
    `a saved document (watermark == op count) reopens reporting clean (got ${JSON.stringify(reopenInfos.at(-1))})`
  );
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
 * Roadmap "Batch export with per-file results": the session-free command runs
 * over files on disk — a good STEP exports, a corrupt one and an STL (no
 * B-rep) become failed rows, sources stay byte-identical, and no editor tab
 * is ever opened for any of them.
 */
test("Batch Export… writes one row per file, never aborts on a bad file, and opens no editors", async () => {
  await closeAll();
  const good = stage(STEP_FIXTURE);
  const dir = path.dirname(good);
  const corrupt = path.join(dir, "corrupt.stp");
  fs.writeFileSync(corrupt, "ISO-10303-21;\nnot really a step file\n");
  const mesh = path.join(dir, "cube.stl");
  fs.copyFileSync(STL_FIXTURE, mesh);
  const outDir = path.join(dir, "out");
  const goodBefore = fs.readFileSync(good);
  const tabsBefore = vscode.window.tabGroups.all.reduce((n, g) => n + g.tabs.length, 0);

  const record = await withModals(
    [openAnswer(good, corrupt, mesh), pick("BREP (.brep)"), openAnswer(outDir), pick("Skip existing outputs")],
    async () => {
      fs.mkdirSync(outDir, { recursive: true });
      await vscode.commands.executeCommand("cad-preview.batchExport");
    }
  );
  assert(record.quickPicks[0]?.labels.includes("Drawing sheet — SVG") === true, "the target pick offers drawing sheets too");
  const written = fs.existsSync(outDir) ? fs.readdirSync(outDir).sort() : [];
  // On failure, name WHICH row failed and why. `saw []` on its own is what made
  // this test undiagnosable when it started failing on CI: the per-row results
  // live only in the report panel, and nothing asserted on them. Two files are
  // SUPPOSED to fail here (a corrupt STEP, and an STL that cannot be a BREP), so
  // "the good one exported" is a statement about the third row specifically.
  // On failure, name the tally. `saw []` on its own is what made this test
  // undiagnosable when it began failing on CI: the per-row results live only in
  // the report panel, and nothing observed them. Two files are SUPPOSED to fail
  // here (a corrupt STEP, and an STL that cannot become a BREP), so "the good
  // one exported" is a claim about the third row — and `0 ok, 3 failed` versus
  // `1 ok, 2 failed` separates "the good file failed" from anything else.
  const tally = record.infos.join(" | ") || "none";
  assert(
    JSON.stringify(written) === JSON.stringify(["block.brep"]),
    `exactly the good file was exported (saw ${JSON.stringify(written)}, tally: ${tally})`
  );
  assert(Buffer.compare(goodBefore, fs.readFileSync(good)) === 0, "the source file is byte-identical");
  // tabGroups updates asynchronously after createWebviewPanel returns, so
  // poll briefly instead of reading once (a single read raced in the full run).
  const countTabs = () => vscode.window.tabGroups.all.reduce((n, g) => n + g.tabs.length, 0);
  for (let i = 0; i < 40 && countTabs() < tabsBefore + 1; i++) await sleep(100);
  const tabsAfter = countTabs();
  // The report panel is the only new tab (a webview panel, not a CAD editor).
  const cadTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputCustom);
  assert(cadTabs.length === 0, `no CAD editor was opened (saw ${cadTabs.length})`);
  assert(tabsAfter === tabsBefore + 1, `one report panel opened (tabs ${tabsBefore} → ${tabsAfter})`);
  await closeAll();
});

/**
 * Roadmap "Preparation report bundle": with no tab focused, the command asks
 * for a model and a folder, and writes report.json + a script-free report.html
 * whose every section carries a status — none dropped.
 */
test("Preparation Report… writes report.json and a self-contained report.html with a status per section", async () => {
  await closeAll();
  const model = stage(STEP_FIXTURE);
  const outDir = path.join(path.dirname(model), "report");
  fs.mkdirSync(outDir, { recursive: true });
  await withModals([openAnswer(model), openAnswer(outDir)], async () => {
    await vscode.commands.executeCommand("cad-preview.prepReport");
  });
  const json = path.join(outDir, "report.json");
  const html = path.join(outDir, "report.html");
  assert(fs.existsSync(json) && fs.existsSync(html), "report.json and report.html are written");
  if (fs.existsSync(json)) {
    const report = JSON.parse(fs.readFileSync(json, "utf8"));
    const statuses = Object.fromEntries(report.sections.map((s: { id: string; status: string }) => [s.id, s.status]));
    assert(report.sections.length === 13 && report.sections.every((s: { status: string }) => ["ok", "partial", "unavailable", "skipped"].includes(s.status)), `every section carries a status (${JSON.stringify(statuses)})`);
    assert(statuses.identity === "ok" && statuses.mass === "ok" && statuses.mesh === "ok", `identity, mass and mesh sections ran (${JSON.stringify(statuses)})`);
    assert(statuses.meshHealth === "unavailable" && statuses.snapshots === "skipped", "inapplicable and opt-in sections are listed, not omitted");
  }
  if (fs.existsSync(html)) {
    const text = fs.readFileSync(html, "utf8");
    assert(!/<script/i.test(text) && !/(src|href)="https?:/.test(text), "report.html has no scripts and no network references");
  }
  await closeAll();
});

/**
 * Roadmap "Drawing-sheet settings and reusable templates": the form replaces
 * the two quick-picks. The suite answers it through the Test seam (the form is
 * a webview it cannot click) and checks that every setting reaches the sheet.
 */
test("Export Drawing Sheet applies the form's settings: views, scale, projection and title-block fields", async () => {
  const api = await saveTestApi();
  if (!api?.setSheetFormAnswer) return;
  const staged = stage(STEP_FIXTURE);
  const out = path.join(path.dirname(staged), "sheet.svg");
  assert(await openDocument(staged), "the STEP fixture opens");
  let offeredTemplates: string[] = [];
  api.setSheetFormAnswer(async (opts) => {
    const o = opts as { templates: () => Promise<Array<{ name: string }>> };
    offeredTemplates = (await o.templates()).map((t) => t.name);
    return { views: ["front", "top"], projection: "third", paper: "fit", scale: "2:1", format: "svg", title: "Bracket", fields: { author: "Ann", drawingNumber: "D-7" } };
  });
  try {
    await withModals([save(out)], async () => {
      await vscode.commands.executeCommand("cad-preview.exportSheet");
      await waitForFile(out);
    });
  } finally {
    api.setSheetFormAnswer(undefined);
  }
  assert(offeredTemplates.includes("iso-a3-first"), `the form is offered the bundled templates (got ${JSON.stringify(offeredTemplates)})`);
  const svg = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  assert(/id="view-front"/.test(svg) && /id="view-top"/.test(svg) && !/id="view-right"/.test(svg), "exactly the chosen views are drawn");
  assert(/Scale 2:1/.test(svg) && /Third-angle projection/.test(svg), "scale and projection reach the title block");
  assert(/Bracket/.test(svg) && /Drawn Ann/.test(svg) && /Dwg D-7/.test(svg), "the title and fields are drawn");
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
 * Roadmap "Explicit external-change conflict handling": an external sidecar
 * write that lands while this editor has an UNSAVED (debounce-pending)
 * change is a conflict, never a silent last-writer-wins. The suite injects
 * the local change through the Test seam (it cannot post into a webview),
 * then races an external write inside the 500 ms autosave window.
 */
test("a parts conflict prompts, and 'Keep mine' overwrites the disk version", async () => {
  const api = await saveTestApi();
  if (!api?.simulateWebviewMessage || !api.onDidPostMessage) return;
  const staged = stage(STEP_FIXTURE);
  assert(await openDocument(staged), "the STEP fixture opens for the parts conflict");
  await sleep(1500); // let the open settle (initial fingerprints, ready hydration)
  const partsFile = `${staged}.parts.json`;
  const part = (name: string) => ({ name, color: "#ff0000", volumes: [], surfaces: [], lines: [], points: [] });
  const record = await withModals([pick("Keep mine")], async () => {
    await api.simulateWebviewMessage!(vscode.Uri.file(staged), { type: "partsChanged", parts: [part("Mine")] });
    fs.writeFileSync(partsFile, JSON.stringify({ version: 1, source: path.basename(staged), parts: [part("Theirs"), part("Theirs2")] }));
    const settled = await waitFor(() => {
      try {
        return JSON.parse(fs.readFileSync(partsFile, "utf8")).parts?.[0]?.name === "Mine";
      } catch {
        return false;
      }
    }, 15000);
    assert(settled, "choosing 'Keep mine' writes this editor's parts over the external version");
  });
  assert(record.warnings.length === 1, `exactly one conflict prompt was shown (saw ${record.warnings.length})`);
  const msg = record.warnings[0]?.message ?? "";
  assert(/Parts for .*changed on disk/.test(msg), `the prompt names the kind and file (got "${msg}")`);
  assert(msg.includes("disk now has 2 parts") && msg.includes("this editor has 1 part"), `the prompt summarizes both sides (got "${msg}")`);
  await closeAll();
});

test("an edits conflict prompts, and 'Reload from disk' adopts the disk version without overwriting it", async () => {
  const api = await saveTestApi();
  if (!api?.simulateWebviewMessage || !api.onDidPostMessage) return;
  const staged = stage(STEP_FIXTURE);
  assert(await openDocument(staged), "the STEP fixture opens for the edits conflict");
  await sleep(1500);
  const editsFile = `${staged}.edits.json`;
  const box = (x: number) => ({ op: "addBox", center: [x, 0, 0], size: [1, 1, 1] });
  const diskOps = [box(10), box(20)];
  const seen: Array<{ type: string; ops?: unknown[] }> = [];
  const sub = api.onDidPostMessage((m) => seen.push(m as { type: string; ops?: unknown[] }));
  try {
    const record = await withModals([pick("Reload from disk")], async () => {
      await api.simulateWebviewMessage!(vscode.Uri.file(staged), { type: "editsChanged", ops: [box(5)], variables: [] });
      fs.writeFileSync(editsFile, JSON.stringify({ version: 1, source: path.basename(staged), ops: diskOps }));
      const adopted = await waitFor(() => seen.some((m) => m.type === "edits" && Array.isArray(m.ops) && m.ops.length === 2), 15000);
      assert(adopted, "choosing 'Reload from disk' posts the disk's two ops to the webview");
    });
    assert(record.warnings.length === 1, `exactly one conflict prompt was shown (saw ${record.warnings.length})`);
    assert((record.warnings[0]?.message ?? "").includes("disk now has 2 ops"), "the prompt counts the disk ops");
    await sleep(1500); // past the autosave debounce: the local op must NOT land on disk
    const onDisk = readSidecarJson(editsFile).ops ?? [];
    assert(onDisk.length === 2, `the external version survives on disk (found ${onDisk.length} ops)`);
  } finally {
    sub.dispose();
  }
  await api.revertDocument?.(vscode.Uri.file(staged));
  await closeAll();
});

test("replacing the source while unsaved edits exist asks instead of silently reloading", async () => {
  const api = await saveTestApi();
  if (!api?.simulateWebviewMessage) return;
  const staged = stage(STEP_FIXTURE);
  assert(await openDocument(staged), "the STEP fixture opens for the source-replacement prompt");
  await sleep(1500);
  const uri = vscode.Uri.file(staged);
  await api.simulateWebviewMessage(uri, { type: "editsChanged", ops: [{ op: "addBox", center: [5, 0, 0], size: [1, 1, 1] }], variables: [] });
  await sleep(1500); // the autosave lands — the tail is unsaved (not baked), not pending
  const record = await withModals([pick("Keep editing")], async () => {
    fs.writeFileSync(staged, fs.readFileSync(path.join(ROOT, "examples", "STP", "bull.stp")));
    await sleep(3000); // watcher debounce + prompt
  });
  assert(record.warnings.length === 1, `the replacement prompted once (saw ${record.warnings.length})`);
  assert(/replaced on disk while it has 1 unsaved edit/.test(record.warnings[0]?.message ?? ""), "the prompt counts the unsaved edits");
  await api.revertDocument?.(uri);
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
