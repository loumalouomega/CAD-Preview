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
import { installModalStubs, pick, save, cancel, input, open as openAnswer, waitForFile, waitFor, type ModalAnswer } from "./modalStubs";
import { writeParts } from "../../../src/partsStore";
import { serializeEditsJson } from "../../../src/editsSidecar";
import { hashBytes, serializeSaveJournal } from "../../../src/saveJournal";
import { writePlanes } from "../../../src/planesStore";
import { writeCustomBackup, restoreCustomBackup } from "../../../src/customBackup";
import { ModelsTreeDataProvider } from "../../../src/modelsView";
import { DEFAULT_MESH_OPTIONS } from "../../../src/meshOptions";
import { parsePartsJson } from "../../../src/partsSidecar";

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

/**
 * The world-space bounding box of the last `geometry` post seen, as
 * `{min, max}` in millimetres.
 *
 * The viewer's own unit is millimetres and the host posts model-space
 * millimetres, so an extent here is directly comparable with a fixture's
 * documented size — which is what makes it usable as an *assertion* rather
 * than a smoke signal ("the model changed" proves nothing; "the plate is now
 * 60 mm wide" does).
 */
function extentOfPosts(seen: Array<{ type: string; meshes?: Array<{ positions?: string }> }>): { min: number[]; max: number[] } | null {
  const last = [...seen].reverse().find((m) => m.type === "geometry" && Array.isArray(m.meshes));
  if (!last?.meshes) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of last.meshes) {
    if (!mesh.positions) continue;
    const buf = Buffer.from(mesh.positions, "base64");
    const arr = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    for (let i = 0; i < arr.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = arr[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
  }
  if (min.some((v) => !Number.isFinite(v))) return null;
  return { min, max };
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
 * Reads a JSON file, or `null` when it is missing or unreadable.
 *
 * Distinct from `readSidecarJson` on purpose: a case that ASSERTS a file was
 * written must fail as a clean assertion, not as an ENOENT exception thrown
 * half-way through the case (which would hide every later assertion and make
 * the failure read like a harness problem).
 */
function readJsonIfExists(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
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
    "cad-preview.refreshModels", "cad-preview.new", "cad-preview.connectAgent",
  ]) {
    assert(commands.includes(id), `command ${id} is registered`);
  }
});

test("Connect an agent copies a registration snippet naming the installed MCP server", async () => {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert(!!ext, "the extension is installed");
  const record = await withModals([pick("Cursor")], async () => {
    await vscode.commands.executeCommand("cad-preview.connectAgent");
  });
  assert(
    (record.quickPicks[0]?.labels ?? []).some((l) => l.includes("Claude Code")),
    `the picker offers Claude Code (offered ${JSON.stringify(record.quickPicks[0]?.labels)})`
  );
  const text = await vscode.env.clipboard.readText();
  const doc = JSON.parse(text) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
  const server = doc.mcpServers["cad-preview"];
  assert(!!server && server.args[0]?.endsWith("mcp-server.js"), `the snippet points at dist/mcp-server.js (${text})`);
  assert(
    server.args[0] === path.join(ext!.extensionPath, "dist", "mcp-server.js"),
    "the path is the installed extension's own dist/mcp-server.js"
  );
  assert(server.env.ELECTRON_RUN_AS_NODE === "1", "the snippet sets ELECTRON_RUN_AS_NODE=1");
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

/** Stages an interrupted B-rep save whose source already holds the baked bytes. */
function stageBRepInterruptedSave(modelPath: string, format: "step" | "iges" | "brep"): Buffer {
  const before = fs.readFileSync(modelPath);
  // The pre-save variant only needs to be byte-distinct so the two hashes
  // identify different states; recovery never reads it in the `finish` branch.
  const preSave = Buffer.concat([before, Buffer.from("\n", "utf8")]);
  fs.writeFileSync(`${modelPath}.bak`, preSave);
  fs.writeFileSync(
    `${modelPath}.edits.json`,
    serializeEditsJson(
      path.basename(modelPath),
      [{ op: "translate", targets: ["solid-0"], vec: [100, 0, 0] }],
      [],
      0
    )
  );
  fs.writeFileSync(
    `${modelPath}.save-journal.json`,
    serializeSaveJournal({
      version: 1,
      source: path.basename(modelPath),
      saveId: `save-${format}-1`,
      startedAt: "2026-09-26T00:00:00.000Z",
      format,
      bakedThrough: 1,
      preSaveSha256: hashBytes(preSave),
      bakedSha256: hashBytes(before),
    })
  );
  return before;
}

/** Exports the STEP fixture to IGES or BREP, for the recovery loop below. */
async function exportBRepFixture(label: "IGES" | "BREP", ext: string): Promise<string> {
  const staged = stage(STEP_FIXTURE);
  const out = path.join(path.dirname(staged), `recover-source.${ext}`);
  assert(await openDocument(staged), "the STEP fixture opens for export");
  await withModals([pick(label), pick("Native"), save(out)], async () => {
    await vscode.commands.executeCommand("cad-preview.export");
    await waitForFile(out);
  });
  await closeAll();
  return out;
}

test("An interrupted B-rep save is completed on open, not replayed over the baked geometry", async () => {
  const staged = stage(STEP_FIXTURE);
  const before = stageBRepInterruptedSave(staged, "step");
  const api = await saveTestApi();
  const statuses: string[] = [];
  const sub = api?.onDidPostMessage?.((m) => {
    const msg = m as { type: string; text?: string; message?: string };
    if (msg.type === "status" || msg.type === "error") statuses.push(msg.text ?? msg.message ?? "");
  });
  let record: Awaited<ReturnType<typeof withModals>> | undefined;
  try {
    record = await withModals([], async () => {
      assert(await openDocument(staged), "the STEP fixture opens");
    });
  } finally {
    sub?.dispose();
  }
  assert(
    !record?.warnings.some((w) => /interrupted save/i.test(w.message)),
    `a recoverable B-rep save does not ask the user to guess (saw ${JSON.stringify(record?.warnings)})`
  );
  assert(
    statuses.some((t) => /interrupted save/i.test(t) && /completed/i.test(t)),
    `the user is told the B-rep save was completed (saw ${JSON.stringify(statuses)})`
  );
  assert(
    statuses.some((t) => /verify them/i.test(t)),
    `the B-rep id-rebind caveat is surfaced (saw ${JSON.stringify(statuses)})`
  );
  assert(!fs.existsSync(`${staged}.save-journal.json`), "the transaction marker is cleared");
  assert(Buffer.compare(before, fs.readFileSync(staged)) === 0, "recovery never rewrites the source");
  await closeAll();
});

test("An interrupted B-rep save is completed for IGES and BREP too", async () => {
  for (const [label, ext, format] of [["IGES", "iges", "iges"], ["BREP", "brep", "brep"]] as const) {
    const staged = await exportBRepFixture(label, ext);
    const before = stageBRepInterruptedSave(staged, format);
    const api = await saveTestApi();
    const statuses: string[] = [];
    const sub = api?.onDidPostMessage?.((m) => {
      const msg = m as { type: string; text?: string; message?: string };
      if (msg.type === "status" || msg.type === "error") statuses.push(msg.text ?? msg.message ?? "");
    });
    let record: Awaited<ReturnType<typeof withModals>> | undefined;
    try {
      record = await withModals([], async () => {
        assert(await openDocument(staged), `the exported ${label} fixture opens`);
      });
    } finally {
      sub?.dispose();
    }
    assert(
      !record?.warnings.some((w) => /interrupted save/i.test(w.message)),
      `${label}: recovery does not prompt (saw ${JSON.stringify(record?.warnings)})`
    );
    assert(
      statuses.some((t) => /interrupted save/i.test(t) && /completed/i.test(t)),
      `${label}: the save is completed (saw ${JSON.stringify(statuses)})`
    );
    assert(!fs.existsSync(`${staged}.save-journal.json`), `${label}: the transaction marker is cleared`);
    assert(Buffer.compare(before, fs.readFileSync(staged)) === 0, `${label}: recovery never rewrites the source`);
    await closeAll();
  }
});

test("Export… offers the real export targets and writes the chosen one", async () => {
  const staged = stage(STEP_FIXTURE);
  // BREP here: B-rep targets are written HOST-side by `exportBRep` (OCCT),
  // whereas the mesh targets (STL/OBJ/PLY/glTF) are serialized in the WEBVIEW by
  // `meshExporters.ts` and posted back — that join is the next two cases, which
  // reuse THIS case's open document (see `sharedExportDoc`).
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
  // Deliberately NOT closed: the two mesh-export cases below run against this
  // same live webview. The suite can only hold a limited number of live
  // webviews (a standalone case here made the unrelated "Save modal
  // cancellation" case never see its webview post `ready`, twice in CI), so new
  // assertions piggyback on an existing document lifecycle instead of opening a
  // fresh one.
  sharedExportDoc = staged;
});

/** The STEP document the "Export… offers the real export targets" case leaves open. */
let sharedExportDoc: string | undefined;

/** That document if its tab is still the active one, else a freshly staged + opened one. */
async function exportDocument(): Promise<string> {
  if (sharedExportDoc && vscode.window.tabGroups.activeTabGroup.activeTab?.label === path.basename(sharedExportDoc)) {
    return sharedExportDoc;
  }
  const staged = stage(STEP_FIXTURE);
  assert(await openDocument(staged), "the STEP fixture opens");
  return staged;
}

// Mesh-target export — the join `test:webview` cannot reach. The serializers
// (`meshExporters.ts`) are asserted structurally in `test:webview`, and the
// host's save/write half is asserted above for B-rep targets; what no harness
// had ever driven is the two together in ONE VS Code: command → format pick →
// unit pick → the REAL webview serializes its Three.js scene → `exportResult`
// posts back → save dialog → bytes on disk. This VS Code now gets software GL
// (`--enable-unsafe-swiftshader` in `runTest.ts`), so the scene exists.
// No `setExportMeshStub` here — the stub would defeat the very join under test.
test("Export… writes a structurally valid binary STL serialized by the real webview", async () => {
  const staged = await exportDocument();
  const out = path.join(path.dirname(staged), "exported.stl");
  const before = fs.readFileSync(staged);

  await withModals([pick("STL"), pick("Native"), pick("As displayed"), save(out)], async () => {
    await vscode.commands.executeCommand("cad-preview.export");
    await waitForFile(out);
  });

  const buf = fs.readFileSync(out);
  assert(buf.length > 84, `the STL has a header and at least one triangle (${buf.length} bytes)`);
  const count = buf.readUInt32LE(80);
  assert(count > 0, `the header declares a non-zero triangle count (${count})`);
  assert(buf.length === 84 + count * 50, `the byte length is exactly 84 + 50 x triangles (${buf.length} vs ${84 + count * 50}) — an empty or truncated scene would not satisfy this`);
  assert(fs.readFileSync(staged).equals(before), "the source file is byte-identical — an export never writes it");
});

test("Export… writes a glTF Binary (.glb) serialized by the real webview", async () => {
  const staged = await exportDocument();
  const out = path.join(path.dirname(staged), "exported.glb");

  await withModals([pick("glTF Binary"), pick("Native"), save(out)], async () => {
    await vscode.commands.executeCommand("cad-preview.export");
    await waitForFile(out);
  });

  const buf = fs.readFileSync(out);
  assert(buf.length > 20, `the .glb has a header and chunks (${buf.length} bytes)`);
  assert(buf.toString("latin1", 0, 4) === "glTF", "the file starts with the glTF binary magic");
  assert(buf.readUInt32LE(4) === 2, "glTF container version 2");
  assert(buf.readUInt32LE(8) === buf.length, "the header's declared total length equals the file size");
  await closeAll();
});

// Compressed glTF under the REAL webview CSP (roadmap "Compressed glTF").
// `test:webview` serves the viewer with no Content-Security-Policy, so it
// proves the decoder logic and staged paths but cannot prove the two
// directives a real webview needs — `script-src 'wasm-unsafe-eval'` (both
// decoders compile WebAssembly) and `worker-src blob:` (DRACOLoader's Blob
// Worker). Observed the way the mesh-export cases above are: export what the
// webview DISPLAYS. A load blocked by the CSP leaves an empty scene, so an STL
// with exactly the cube's 12 triangles proves the decode ran inside the CSP.
test("Compressed glTF (Draco and meshopt) loads under the real webview CSP", async () => {
  await closeAll();
  for (const name of ["cube-draco.glb", "cube-meshopt.glb"]) {
    const staged = stage(path.join(ROOT, "examples", "GLTF", name));
    const out = path.join(path.dirname(staged), "from-compressed.stl");
    assert(await openDocument(staged), `${name} opens`);
    await withModals([pick("STL"), pick("Native"), save(out)], async () => {
      await vscode.commands.executeCommand("cad-preview.export");
      await waitForFile(out);
    });
    const buf = fs.readFileSync(out);
    const count = buf.length >= 84 ? buf.readUInt32LE(80) : 0;
    assert(count === 12, `${name}: the displayed model carries the cube's 12 triangles (got ${count}) — a decoder blocked by the CSP leaves an empty scene`);
    assert(buf.length === 84 + count * 50, `${name}: a well-formed binary STL (${buf.length} bytes)`);
    await closeAll();
  }

  // 3MF rides this case rather than getting its own: the suite holds a limited
  // number of live webviews (see `sharedExportDoc`), and what it proves is the
  // same shape — three's `3MFLoader` (DOMParser) and `fflate` run under the
  // real CSP, and the displayed scene is non-empty. The inch file also pins the
  // unit scaling (`3MFLoader` reads `unit` but never applies it).
  for (const [name, edge] of [["cube.3mf", 10], ["cube-inch.3mf", 25.4]] as const) {
    const staged = stage(path.join(ROOT, "examples", "3MF", name));
    const out = path.join(path.dirname(staged), "from-3mf.stl");
    assert(await openDocument(staged), `${name} opens`);
    await withModals([pick("STL"), pick("Native"), save(out)], async () => {
      await vscode.commands.executeCommand("cad-preview.export");
      await waitForFile(out);
    });
    const buf = fs.readFileSync(out);
    const count = buf.length >= 84 ? buf.readUInt32LE(80) : 0;
    assert(count === 12, `${name}: the displayed model carries the cube's 12 triangles (got ${count})`);
    let max = -Infinity;
    let min = Infinity;
    for (let i = 0; i < count; i++) {
      for (let v = 0; v < 3; v++) {
        const x = buf.readFloatLE(84 + i * 50 + 12 + v * 12);
        max = Math.max(max, x);
        min = Math.min(min, x);
      }
    }
    assert(Math.abs(max - min - edge) < 1e-3, `${name}: the cube measures ${edge} mm along x (got ${max - min})`);
    await closeAll();
  }

  // Collada rides the same case for the same reason: `ColladaLoader` needs
  // `DOMParser`, and the unit scale (metres in the loader, mm in the viewer) is
  // what the metre and inch files pin.
  for (const [name, edge] of [["cube.dae", 10], ["cube-metre.dae", 10], ["cube-inch.dae", 25.4]] as const) {
    const staged = stage(path.join(ROOT, "examples", "Collada", name));
    const out = path.join(path.dirname(staged), "from-dae.stl");
    assert(await openDocument(staged), `${name} opens`);
    await withModals([pick("STL"), pick("Native"), save(out)], async () => {
      await vscode.commands.executeCommand("cad-preview.export");
      await waitForFile(out);
    });
    const buf = fs.readFileSync(out);
    const count = buf.length >= 84 ? buf.readUInt32LE(80) : 0;
    assert(count === 12, `${name}: the displayed model carries the cube's 12 triangles (got ${count})`);
    let max = -Infinity;
    let min = Infinity;
    for (let i = 0; i < count; i++) {
      for (let v = 0; v < 3; v++) {
        const x = buf.readFloatLE(84 + i * 50 + 12 + v * 12);
        max = Math.max(max, x);
        min = Math.min(min, x);
      }
    }
    assert(Math.abs(max - min - edge) < 1e-3, `${name}: the cube measures ${edge} mm along x (got ${max - min})`);
    await closeAll();
  }

  // AMF rides the same case too: `AMFLoader` needs `DOMParser`, and (unlike
  // 3MF/Collada) it already scales to mm itself, so the inch file pins that the
  // viewer does not scale a second time.
  for (const [name, edge] of [["cube.amf", 10], ["cube-inch.amf", 25.4], ["cube-zip.amf", 10]] as const) {
    const staged = stage(path.join(ROOT, "examples", "AMF", name));
    const out = path.join(path.dirname(staged), "from-amf.stl");
    assert(await openDocument(staged), `${name} opens`);
    await withModals([pick("STL"), pick("Native"), save(out)], async () => {
      await vscode.commands.executeCommand("cad-preview.export");
      await waitForFile(out);
    });
    const buf = fs.readFileSync(out);
    const count = buf.length >= 84 ? buf.readUInt32LE(80) : 0;
    assert(count === 12, `${name}: the displayed model carries the cube's 12 triangles (got ${count})`);
    let max = -Infinity;
    let min = Infinity;
    for (let i = 0; i < count; i++) {
      for (let v = 0; v < 3; v++) {
        const x = buf.readFloatLE(84 + i * 50 + 12 + v * 12);
        max = Math.max(max, x);
        min = Math.min(min, x);
      }
    }
    assert(Math.abs(max - min - edge) < 1e-3, `${name}: the cube measures ${edge} mm along x (got ${max - min})`);
    await closeAll();
  }

  // USD rides it too: `USDLoader` scales by metersPerUnit itself, so the viewer
  // resets that scale and applies millimetres once (the cm file pins it).
  for (const [name, edge] of [["cube.usda", 10], ["cube-cm.usda", 10], ["cube.usdz", 10]] as const) {
    const staged = stage(path.join(ROOT, "examples", "USD", name));
    const out = path.join(path.dirname(staged), "from-usd.stl");
    assert(await openDocument(staged), `${name} opens`);
    await withModals([pick("STL"), pick("Native"), save(out)], async () => {
      await vscode.commands.executeCommand("cad-preview.export");
      await waitForFile(out);
    });
    const buf = fs.readFileSync(out);
    const count = buf.length >= 84 ? buf.readUInt32LE(80) : 0;
    assert(count === 12, `${name}: the displayed model carries the cube's 12 triangles (got ${count})`);
    let max = -Infinity;
    let min = Infinity;
    for (let i = 0; i < count; i++) {
      for (let v = 0; v < 3; v++) {
        const x = buf.readFloatLE(84 + i * 50 + 12 + v * 12);
        max = Math.max(max, x);
        min = Math.min(min, x);
      }
    }
    assert(Math.abs(max - min - edge) < 1e-3, `${name}: the cube measures ${edge} mm along x (got ${max - min})`);
    await closeAll();
  }
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
  type DocInfo = { type: string; name?: string; path?: string; relativePath?: string; format?: string | null; dirty?: boolean; unsavedEdits?: number };
  const infosOf = (posts: Array<{ type: string }>) => (posts as DocInfo[]).filter((m) => m.type === "documentInfo");
  const openInfos = infosOf(seen);
  assert(openInfos.length >= 1, "a documentInfo is posted on open");
  assert(
    openInfos[0]?.name === path.basename(staged) && openInfos[0]?.path === staged && openInfos[0]?.format === "step",
    `it names the file and its routed format (got ${JSON.stringify(openInfos[0])})`
  );
  // Copy reference quotes this (roadmap "Quotable entity references for agent chats").
  assert(
    typeof openInfos[0]?.relativePath === "string" && openInfos[0].relativePath.endsWith(path.basename(staged)),
    `it carries the workspace-relative path a copied entity reference quotes (got ${JSON.stringify(openInfos[0]?.relativePath)})`
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
  const externalFroms: Array<number | undefined> = [];
  const sub = api.onDidPostMessage?.((m) => {
    if (m.type === "edits") externalFroms.push((m as unknown as { externalFrom?: number }).externalFrom);
    seen.push(m.type === "status" ? (m as unknown as { text: string }).text : m.type);
  });
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
    // Mark agent-made edits: a pure append by another writer reaches the
    // webview with the index of the first appended op (1 = after op1).
    assert(externalFroms.includes(1), `the reconciled append is posted with externalFrom=1 (saw ${JSON.stringify(externalFroms)})`);
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

  let batchResult: { rows?: Array<{ input?: string; status?: string; error?: string }> } | undefined;
  const record = await withModals(
    [openAnswer(good, corrupt, mesh), pick("BREP (.brep)"), openAnswer(outDir), pick("Skip existing outputs")],
    async () => {
      fs.mkdirSync(outDir, { recursive: true });
      batchResult = await vscode.commands.executeCommand("cad-preview.batchExport");
    }
  );
  assert(record.quickPicks[0]?.labels.includes("Drawing sheet — SVG") === true, "the target pick offers drawing sheets too");
  const written = fs.existsSync(outDir) ? fs.readdirSync(outDir).sort() : [];
  // On failure, name every row and its error. `saw []` on its own is what made
  // this test undiagnosable when it began failing on CI: the per-row results
  // live only in the report panel, and nothing observed them. Two of the three
  // inputs are SUPPOSED to fail (a corrupt STEP, and an STL that cannot become
  // a BREP), so this is a claim about the third row — and the rows say exactly
  // which one went wrong and why. `runBatchExportCommand` returns its result
  // and the registration forwards it, purely so this is observable.
  const rows = (batchResult?.rows ?? [])
    .map((r) => `${path.basename(String(r.input))}=${r.status}${r.error ? `(${r.error})` : ""}`)
    .join(", ");
  assert(
    JSON.stringify(written) === JSON.stringify(["block.brep"]),
    `exactly the good file was exported (saw ${JSON.stringify(written)}) — rows: ${rows || "(no result)"}`
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
    return { views: ["front", "top"], projection: "third", paper: "fit", scale: "2:1", format: "svg", title: "Bracket", fields: { author: "Ann", drawingNumber: "D-7" }, holeCallouts: true };
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
  assert(!/need a B-rep source/.test(svg), "hole callouts on a B-rep source are accepted without a mesh-source warning");
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

test("MMG host remesh writes a new mesh and rebound material Parts without touching the source", async () => {
  const api = await saveTestApi();
  assert(!!api?.simulateWebviewMessage && !!api.onDidPostMessage, "MMG host test seams are available");
  const staged = stage(path.join(ROOT, "examples/MED/two-material-tets.med"));
  const sourceBytes = fs.readFileSync(staged);
  assert(await openDocument(staged), "MMG MED source opens");
  const dest = path.join(path.dirname(staged), "mmg-host.med");
  const seen: Array<{ type: string; written?: string; warnings?: string[] }> = [];
  const sub = api!.onDidPostMessage!(m => seen.push(m));
  try {
    const record = await withModals([save(dest)], async () => {
      await api!.simulateWebviewMessage!(vscode.Uri.file(staged), { type: "remeshRequest", requestId: "mmg-host", source: "file", options: { hmax: 0.6 }, meshOptions: DEFAULT_MESH_OPTIONS });
    });
    assert(record.saveDialogs[0]?.filters?.["MED mesh (named regions)"]?.[0] === "med", "MMG save dialog offers its region-preserving format");
    assert(seen.some(m => m.type === "remeshResult" && m.written === dest), "MMG handler posts the actual output path");
    assert(fs.existsSync(dest) && fs.statSync(dest).size > 0, "MMG handler writes the remeshed FE file");
    const parts = parsePartsJson(fs.readFileSync(`${dest}.parts.json`, "utf8"));
    assert(parts.length === 2 && parts.every(p => p.surfaces.length > 0), "MMG handler rebinds both material Parts to new facet ids");
    assert(fs.readFileSync(staged).equals(sourceBytes), "MMG host flow leaves the source unchanged");
    assert(seen.some(m => m.warnings?.some(w => /data was dropped/.test(w))), "MMG host flow reports dropped field data");
  } finally { sub.dispose(); await closeAll(); }
});

test("MMG host generated mode preserves a CAD boundary Part", async () => {
  const api = await saveTestApi();
  assert(!!api?.simulateWebviewMessage && !!api.onDidPostMessage, "MMG generated host seams are available");
  const staged = stage(STEP_FIXTURE);
  fs.writeFileSync(`${staged}.parts.json`, JSON.stringify({ version: 1, source: path.basename(staged), parts: [{ name: "Wall", color: "#ff0000", volumes: [], surfaces: ["face-0"], lines: [], points: [] }] }));
  assert(await openDocument(staged), "MMG CAD source opens");
  const dest = path.join(path.dirname(staged), "mmg-generated.med");
  await withModals([save(dest)], async () => {
    await api!.simulateWebviewMessage!(vscode.Uri.file(staged), { type: "remeshRequest", requestId: "mmg-generated", source: "generated", options: { hmax: 1 }, meshOptions: { ...DEFAULT_MESH_OPTIONS, sizeMax: 2 } });
  });
  assert(fs.existsSync(dest), "MMG generated host flow writes its remeshed result");
  const parts = parsePartsJson(fs.readFileSync(`${dest}.parts.json`, "utf8"));
  assert(parts.some(p => p.name === "Wall" && p.color === "#ff0000" && p.surfaces.length > 0), "MMG generated host flow preserves boundary Part name, colour and membership");
  await closeAll();
});

test("MMG host dismissal and source-path refusal do not write", async () => {
  const api = await saveTestApi();
  assert(!!api?.simulateWebviewMessage && !!api.onDidPostMessage, "MMG refusal host seams are available");
  const staged = stage(path.join(ROOT, "examples/MED/two-material-tets.med"));
  const bytes = fs.readFileSync(staged);
  assert(await openDocument(staged), "MMG source opens for dismissal/refusal");
  const seen: Array<{ type: string; cancelled?: boolean; message?: string }> = [];
  const sub = api!.onDidPostMessage!(m => seen.push(m));
  const message = { type: "remeshRequest", requestId: "mmg-dismiss", source: "file", options: {}, meshOptions: DEFAULT_MESH_OPTIONS };
  try {
    await withModals([cancel()], () => api!.simulateWebviewMessage!(vscode.Uri.file(staged), message));
    assert(seen.some(m => m.type === "remeshResult" && m.cancelled), "MMG dismissed save is explicitly cancelled");
    await withModals([save(staged)], () => api!.simulateWebviewMessage!(vscode.Uri.file(staged), { ...message, requestId: "mmg-refuse" }));
    assert(seen.some(m => m.type === "remeshError" && /new file/.test(m.message ?? "")), "MMG refuses the original source as output");
    assert(fs.readFileSync(staged).equals(bytes), "MMG dismissal/refusal leaves the source byte-identical");
  } finally { sub.dispose(); await closeAll(); }
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


test("an external layers write reconciles, a dirty layers buffer refuses the write, and a filtered export draws one group", async () => {
  const api = await saveTestApi();
  if (!api?.simulateWebviewMessage || !api.onDidPostMessage) return;
  const staged = stage(STEP_FIXTURE);
  assert(await openDocument(staged), "the STEP fixture opens for the layers round trip");
  await sleep(1500); // let the open settle (initial fingerprints, ready hydration)
  const layersFile = `${staged}.layers.json`;
  const layer = (id: string, name: string) => ({ id, name, color: "#ff0000", visible: true, locked: false, volumes: [], surfaces: [], lines: [], points: [] });
  const seen: string[] = [];
  const sub = api.onDidPostMessage?.((m) => {
    void seen.push(m.type === "status" ? (m as unknown as { text: string }).text : m.type);
  });
  try {
    // An MCP agent's write lands the way edits/parts do — content-compared,
    // then posted to the webview with a status line.
    fs.writeFileSync(
      layersFile,
      JSON.stringify({ version: 1, source: path.basename(staged), nextId: 2, layers: [layer("layer-0", "Default"), layer("layer-1", "Dims")] })
    );
    assert(await waitFor(() => seen.includes("Layers updated externally"), 15000), "the external layers write is reconciled");
  } finally {
    sub?.dispose();
  }

  // A dirty layers buffer refuses the debounced write instead of clobbering
  // hand-typed JSON — the same DirtyBufferError seam every other sidecar has.
  const before = fs.readFileSync(layersFile);
  const sidecar = vscode.Uri.file(layersFile);
  const doc = await vscode.workspace.openTextDocument(sidecar);
  const editor = await vscode.window.showTextDocument(doc);
  await editor.edit((e) => e.insert(new vscode.Position(0, 0), " "));
  assert(doc.isDirty, "the layers sidecar is open with unsaved changes");
  const errors: string[] = [];
  const sub2 = api.onDidPostMessage?.((m) => {
    if (m.type === "error") errors.push((m as { message?: string }).message ?? "");
  });
  try {
    await withModals([], async () => {
      await api.simulateWebviewMessage!(vscode.Uri.file(staged), {
        type: "layersChanged",
        layers: [layer("layer-0", "Default"), layer("layer-1", "Renamed")],
        nextId: 2,
      });
      await sleep(1500); // past the autosave debounce
    });
  } finally {
    sub2?.dispose();
  }
  assert(fs.readFileSync(layersFile).equals(before), "the dirty buffer's disk bytes are untouched");
  assert(errors.some((e) => /unsaved changes/i.test(e)), "the refusal names the dirty sidecar");
  await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  await sleep(300);

  // Filtered drawing export through the real provider (same session, so this
  // adds no second open): the view/layers/unit picks, the save dialog, and
  // the real kernel-worker export — the host half no webview harness can
  // reach. block.stp is one 3×4×5 box (face-0..5).
  //
  // Positioned late on purpose: this suite's live-webview/kernel budget is
  // order-sensitive (bisected — this same flow placed early deterministically
  // starved the save/reopen block's kernel windows here, while late it is
  // green), so young heavyweight flows live down here with the other
  // kernel-touching tail tests rather than up front.
  const out = path.join(path.dirname(staged), "layer-one.svg");
  const sourceBefore = fs.readFileSync(staged);
  const one = { id: "layer-1", name: "One", color: "#ff0000", visible: true, locked: false, volumes: [], surfaces: ["face-0"], lines: [], points: [] };
  const none = { id: "layer-0", name: "Default", color: "#b8b8b8", visible: true, locked: false, volumes: [], surfaces: [], lines: [], points: [] };
  await api.simulateWebviewMessage!(vscode.Uri.file(staged), { type: "layersChanged", layers: [none, one], nextId: 2 });
  const record = await withModals([pick("Front"), pick("One"), pick("Native"), save(out)], async () => {
    await api.simulateWebviewMessage!(vscode.Uri.file(staged), { type: "exportSvgRequest" });
    await waitForFile(out, 120000); // a real OCCT tessellation + projection runs first
  });
  const layersPick = record.quickPicks.find((q) => q.placeHolder === "Drawing layers…");
  assert(
    layersPick !== undefined && layersPick.labels.includes("One") && layersPick.labels[0] === "All layers",
    `the layers pick offers All layers first plus the named layer (got ${JSON.stringify(layersPick?.labels)})`
  );
  const svg = fs.readFileSync(out, "utf8");
  assert(svg.includes('<g id="layer-1">'), "the filtered drawing groups its output per layer");
  assert(!svg.includes('<g id="layer-0">'), "only the picked layer is drawn, not Default");
  assert(Buffer.compare(sourceBefore, fs.readFileSync(staged)) === 0, "the CAD source is untouched");
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

test("a splitFace op pushed through the provider replays in the host, persists, and renumbers face ids", async () => {
  const api = await saveTestApi();
  if (!api?.simulateWebviewMessage || !api.onDidPostMessage) return;
  const staged = stage(STEP_FIXTURE); // block.stp: one 3x4x5 box; face-0 is the top (z = 2.5)
  assert(await openDocument(staged), "the STEP fixture opens for the splitFace replay");
  await sleep(1500);
  let geometryPosts = 0;
  const errors: string[] = [];
  const sub = api.onDidPostMessage((m) => {
    if (m.type === "geometry") geometryPosts++;
    if (m.type === "error") errors.push((m as { message?: string }).message ?? "error");
  });
  try {
    const before = geometryPosts;
    await api.simulateWebviewMessage!(vscode.Uri.file(staged), {
      type: "editsChanged",
      ops: [{ op: "splitFace", face: "face-0", points: [[-1.5, 0, 2.5], [1.5, 0, 2.5]] }],
      variables: [],
    });
    assert(await waitFor(() => geometryPosts > before, 30000), "the host replay reposts geometry");
    assert(errors.length === 0, `no error is posted for the split (saw ${JSON.stringify(errors)})`);
    await sleep(1500); // past the edits autosave debounce
    const onDisk = readSidecarJson(`${staged}.edits.json`).ops ?? [];
    assert(onDisk.length === 1 && (onDisk[0] as { op?: string }).op === "splitFace", `the splitFace op persists to the sidecar (found ${JSON.stringify(onDisk)})`);
  } finally {
    sub.dispose();
  }
  await api.revertDocument?.(vscode.Uri.file(staged));
  await closeAll();
});

/**
 * Roadmap "OpenSCAD include tracking and conversion cache": a `.scad` model that
 * `use`s another file must reload when THAT file changes. Two tests, one per
 * conversion path (roadmap "Build and bundle an OpenSCAD WASM port"):
 *
 * - WASM-first: no binary configured at all (a nonexistent path) — the model
 *   must still open and must repost geometry when the include changes, with
 *   the watcher fed by the WASM path's own dependency list. This is the
 *   no-install headline; it needs no stub.
 * - Binary fallback: a model with `import()` (which the WASM path declines)
 *   converts through the committed counting stub (`openscad-deps-stub.sh`)
 *   because no real openscad exists on CI; the stub writes the same Make-style
 *   dependency list real OpenSCAD 2021.01 does. The spawn count is the second
 *   assertion: the edit's reload must really re-evaluate (a cache hit would
 *   show the stale geometry), and the open itself must have spawned exactly
 *   once.
 */
test("a .scad model opens with no binary and editing an include reloads it (WASM-first)", async () => {
  const api = await saveTestApi();
  const hook = (vscode.extensions.getExtension(EXTENSION_ID)?.exports as { onDidPostMessage?: vscode.Event<{ type: string }> } | undefined)
    ?.onDidPostMessage;
  if (!hook || !api) return;
  const dir = tempDir();
  const model = path.join(dir, "model.scad");
  const lib = path.join(dir, "lib.scad");
  fs.writeFileSync(lib, "module m() { cube(1); }\n");
  fs.writeFileSync(model, "include <lib.scad>\nm();\n");
  const config = vscode.workspace.getConfiguration("cadPreview");
  const previous = config.inspect<string>("openscadBinary")?.globalValue;
  await config.update("openscadBinary", "/nonexistent-openscad-binary-for-tests", vscode.ConfigurationTarget.Global);
  let geometryPosts = 0;
  const sub = hook((m) => {
    if (m.type === "geometry") geometryPosts++;
  });
  try {
    assert(await openDocument(model), "the .scad model opens through the bundled WASM with no binary installed");
    assert(await waitFor(() => geometryPosts >= 1, 30000), "the open posts geometry");
    const before = geometryPosts;
    fs.writeFileSync(lib, "module m() { cube(2); }\n");
    assert(await waitFor(() => geometryPosts > before, 30000), "editing the included file reposts geometry (the WASM dependency watcher fired)");
  } finally {
    sub.dispose();
    await config.update("openscadBinary", previous, vscode.ConfigurationTarget.Global);
  }
  await closeAll();
});

test("editing an included .scad file reloads the open document (binary fallback)", async () => {
  const api = await saveTestApi();
  const hook = (vscode.extensions.getExtension(EXTENSION_ID)?.exports as { onDidPostMessage?: vscode.Event<{ type: string }> } | undefined)
    ?.onDidPostMessage;
  if (!hook || !api) return;
  const dir = tempDir();
  const model = path.join(dir, "model.scad");
  const lib = path.join(dir, "lib.scad");
  fs.writeFileSync(lib, "module m() { cube(1); }\n");
  // import() is declined by the WASM path, so this model converts through the
  // stub binary below — exercising the fallback, its depfile-driven watcher
  // and the spawn-counted cache assertions.
  fs.writeFileSync(model, "import(\"mesh.stl\");\ninclude <lib.scad>\nm();\n");
  const stub = path.join(ROOT, "src", "test-fixtures", "openscad-deps-stub.sh");
  fs.chmodSync(stub, 0o755);
  const config = vscode.workspace.getConfiguration("cadPreview");
  const previous = config.inspect<string>("openscadBinary")?.globalValue;
  const savedEnv = { STUB_COUNT: process.env.STUB_COUNT, STUB_DEPS: process.env.STUB_DEPS };
  const count = path.join(dir, "count.txt");
  process.env.STUB_COUNT = count;
  process.env.STUB_DEPS = lib;
  await config.update("openscadBinary", stub, vscode.ConfigurationTarget.Global);
  let geometryPosts = 0;
  const sub = hook((m) => {
    if (m.type === "geometry") geometryPosts++;
  });
  try {
    assert(await openDocument(model), "the .scad model opens through the stub binary");
    assert(await waitFor(() => geometryPosts >= 1, 30000), "the open posts geometry");
    const spawnsAfterOpen = fs.existsSync(count) ? fs.readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0;
    assert(spawnsAfterOpen === 1, `opening evaluated the model exactly once (saw ${spawnsAfterOpen})`);
    const before = geometryPosts;
    fs.writeFileSync(lib, "module m() { cube(2); }\n");
    const reloaded = await waitFor(() => geometryPosts > before, 30000); // 300 ms debounce + conversion
    assert(reloaded, "editing the included file reposts geometry (the dependency watcher fired)");
    const spawnsAfterEdit = fs.readFileSync(count, "utf8").split("\n").filter(Boolean).length;
    assert(spawnsAfterEdit === 2, `the reload re-evaluated rather than serving a stale cache hit (saw ${spawnsAfterEdit})`);
  } finally {
    sub.dispose();
    await config.update("openscadBinary", previous, vscode.ConfigurationTarget.Global);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  await closeAll();
});

/**
 * Roadmap 1.1 / registry `openscad-backend-and-libraries`: the three
 * `cadPreview.openscad*` settings are read by `readScadSettings()` and must
 * reach the BINARY conversion path, not just the compiled argv helper. A
 * recording stub captures the real child argv and environment; the model uses
 * `import()`, which the WASM path declines, so the fallback is the only path
 * that can have produced the geometry.
 */
test("the OpenSCAD backend and library-path settings reach the fallback binary and never write the source", async () => {
  const api = await saveTestApi();
  if (!api) return;
  const dir = tempDir();
  const libs = path.join(dir, "libs");
  fs.mkdirSync(libs);
  const model = path.join(dir, "settings.scad");
  fs.writeFileSync(model, 'import("mesh.stl");\n');
  const stub = path.join(ROOT, "src", "test-fixtures", "openscad-deps-stub.sh");
  fs.chmodSync(stub, 0o755);
  const argsFile = path.join(dir, "args.txt");
  const config = vscode.workspace.getConfiguration("cadPreview");
  const previousBinary = config.inspect<string>("openscadBinary")?.globalValue;
  const previousBackend = config.inspect<string>("openscadBackend")?.globalValue;
  const previousLibraries = config.inspect<string[]>("openscadLibraryPaths")?.globalValue;
  const savedArgsEnv = process.env.STUB_ARGS;
  process.env.STUB_ARGS = argsFile;
  const sourceBefore = fs.readFileSync(model);
  await config.update("openscadBinary", stub, vscode.ConfigurationTarget.Global);
  await config.update("openscadBackend", "manifold", vscode.ConfigurationTarget.Global);
  await config.update("openscadLibraryPaths", [libs], vscode.ConfigurationTarget.Global);
  try {
    assert(await openDocument(model), "the .scad model opens through the configured fallback binary");
    assert(await waitFor(() => fs.existsSync(argsFile), 30000), "the configured fallback binary ran");
    const lines = fs.readFileSync(argsFile, "utf8").split("\n").filter(Boolean);
    const argsLine = lines.find((l) => l.startsWith("args=")) ?? "";
    assert(argsLine.includes("--backend=manifold"), `the backend setting reaches argv (got ${JSON.stringify(argsLine)})`);
    assert(
      /\s-o\s/.test(` ${argsLine} `) && /\s-d\s/.test(` ${argsLine} `),
      `the conversion still asks for -o and a depfile (got ${JSON.stringify(argsLine)})`
    );
    const pathLine = lines.find((l) => l.startsWith("openscadpath=")) ?? "";
    const first = pathLine.slice("openscadpath=".length).split(path.delimiter).filter(Boolean)[0];
    assert(first === libs, `the library folder is first on OPENSCADPATH (got ${JSON.stringify(pathLine)})`);
    assert(fs.readFileSync(model).equals(sourceBefore), "opening the model does not write the .scad source");
  } finally {
    await config.update("openscadBinary", previousBinary, vscode.ConfigurationTarget.Global);
    await config.update("openscadBackend", previousBackend, vscode.ConfigurationTarget.Global);
    await config.update("openscadLibraryPaths", previousLibraries, vscode.ConfigurationTarget.Global);
    if (savedArgsEnv === undefined) delete process.env.STUB_ARGS;
    else process.env.STUB_ARGS = savedArgsEnv;
  }
  await closeAll();
});

/**
 * Roadmap "OpenSCAD `color()` and top-level objects become Parts": opening a
 * `.csg` with coloured solids creates one Part per distinct colour — through
 * the real provider, kernel worker and parts sidecar — exactly once.
 * `two-colour.csg` is real OpenSCAD 2021.01 output (red = solid-0 + solid-4,
 * blue = solid-1 + solid-2, solid-3 uncoloured).
 */
test("opening a coloured .csg creates one Part per colour, once", async () => {
  const hook = (vscode.extensions.getExtension(EXTENSION_ID)?.exports as { onDidPostMessage?: vscode.Event<{ type: string; parts?: Array<{ name: string; volumes: string[] }> }> } | undefined)
    ?.onDidPostMessage;
  if (!hook) return;
  const staged = stage(path.join(ROOT, "examples", "OpenSCAD", "two-colour.csg"));
  let announced: Array<{ name: string; volumes: string[] }> | undefined;
  const sub = hook((m) => {
    if (m.type === "parts" && m.parts && m.parts.length > 0) announced = m.parts;
  });
  try {
    assert(await openDocument(staged), "the coloured .csg opens");
    assert(await waitFor(() => announced !== undefined, 30000), "the webview is told about the new Parts");
    assert(
      JSON.stringify(announced?.map((p) => [p.name, p.volumes])) ===
        JSON.stringify([["Part red", ["solid-0", "solid-4"]], ["Part blue", ["solid-1", "solid-2"]]]),
      `one Part per colour, listing the right solids (got ${JSON.stringify(announced)})`
    );
    const onDisk = JSON.parse(fs.readFileSync(`${staged}.parts.json`, "utf8")) as { parts: unknown[] };
    assert(onDisk.parts.length === 2, `the Parts are persisted (got ${onDisk.parts.length})`);
  } finally {
    sub.dispose();
  }
  await closeAll();
  assert(await openDocument(staged), "the coloured .csg reopens");
  await sleep(2000);
  const again = JSON.parse(fs.readFileSync(`${staged}.parts.json`, "utf8")) as { parts: unknown[] };
  assert(again.parts.length === 2, `a reopen does not duplicate the Parts (got ${again.parts.length})`);
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

/**
 * Roadmap 1.1 "Verification-debt burn-down", first increment: ten host-side
 * entries with the highest data-loss or write-path risk, each closed by one
 * `test:integration` case below (the webview harness structurally cannot
 * reach quick-picks, save dialogs, `provider.ts` handlers or the file
 * watchers). Every case runs inside the real VS Code instance and asserts on
 * bytes/sidecars/posts, never on "did not throw".
 */

test("Empty-tail Export save-in-place still confirms and stays consistent", async () => {
  // Tier 0 Phase 1: the Export flow always confirms a same-format save — even
  // when the op tail is empty. Skipping the modal on an empty tail would be
  // a silent path around the data-loss contract, so this pins the modal AND
  // the consistency (watermark stays 0, .bak matches the source it copied).
  const staged = stage(STEP_FIXTURE);
  const before = fs.readFileSync(staged);
  assert(await openDocument(staged), "the STEP fixture opens with no sidecar");
  const record = await withModals([pick("STEP"), pick("Save in place"), pick("Save in place")], async () => {
    await vscode.commands.executeCommand("cad-preview.export");
    await sleep(2000);
  });
  assert(
    record.warnings.length === 1 && /0 edit op\(s\)/.test(record.warnings[0]?.message ?? ""),
    `the empty tail still confirms by name (saw ${JSON.stringify(record.warnings.map((w) => w.message))})`
  );
  assert(record.saveDialogs.length === 0, "save-in-place shows no save dialog");
  assert(fs.existsSync(`${staged}.bak`) && fs.readFileSync(`${staged}.bak`).equals(before), "a one-deep .bak holds the pre-save bytes");
  assert((readSidecarJson(`${staged}.edits.json`).bakedThrough ?? 0) === 0, "the watermark stays 0 with nothing baked");
  await clearDirtyViaNoopSave();
  await closeAll();
});

test("The tab dirties on an op and the chip clears on save", async () => {
  // Tier 0 Phase 2: the tab dot is the user's unsaved signal (it lights here
  // through the real platform event), and the menubar chip is the host's —
  // `syncDocumentInfo` is the only writer both consumers share, so the chip
  // going clean with zero unsaved edits is the save-settled proof. (Tab-dot
  // clearing itself is VS Code platform behavior this suite has never pinned
  // and does not assert.)
  const api = await saveTestApi();
  if (!api?.saveDocument || !api?.simulateWebviewMessage) return;
  const staged = stage(STEP_FIXTURE);
  assert(await openDocument(staged), "the STEP fixture opens");
  const isDirty = () => vscode.window.tabGroups.activeTabGroup.activeTab?.isDirty === true;
  assert(!isDirty(), "the tab starts clean");
  await api.simulateWebviewMessage!(vscode.Uri.file(staged), {
    type: "editsChanged",
    ops: [{ op: "translate", targets: ["solid-0"], vec: [5, 0, 0] }],
    variables: [],
  });
  assert(await waitFor(() => isDirty(), 15000), "an unbaked op dirties the tab");
  // Through the platform save flow (the real Ctrl+S join).
  type DocInfo = { type: string; dirty?: boolean; unsavedEdits?: number };
  const later: DocInfo[] = [];
  const infoSub = api.onDidPostMessage?.((m) => void later.push(m as DocInfo));
  const before = fs.readFileSync(staged);
  try {
    await withModals([pick("Save in place")], async () => {
      await vscode.commands.executeCommand("workbench.action.files.save");
      assert(await waitFor(() => readSidecarJson(`${staged}.edits.json`).bakedThrough === 1, 30000), "the watermark lands");
    });
    assert(
      await waitFor(() => later.some((i) => i.type === "documentInfo" && i.dirty === false && i.unsavedEdits === 0), 15000),
      "the chip reports clean with zero unsaved edits once the bake lands"
    );
    assert(!fs.readFileSync(staged).equals(before), "the source file itself is rewritten");
  } finally {
    infoSub?.dispose();
  }
  await clearDirtyViaNoopSave();
  await closeAll();
});

test("A glTF source is never written by save", async () => {
  // Tier 0 Phase 3: glTF has no same-format writer (its exporter emits only
  // `.glb`), so even a pending edit tail must never reach the source file —
  // no modal, no .bak, bytes identical.
  const api = await saveTestApi();
  if (!api?.saveDocument || !api?.simulateWebviewMessage) return;
  const staged = stage(path.join(ROOT, "examples", "GLTF", "cube.glb"));
  const before = fs.readFileSync(staged);
  assert(await openDocument(staged), "the glTF fixture opens");
  await api.simulateWebviewMessage!(vscode.Uri.file(staged), {
    type: "editsChanged",
    ops: [{ op: "translate", targets: ["node-0"], vec: [1, 0, 0] }],
    variables: [],
  });
  await sleep(1000);
  await withModals([], async () => {
    await api.saveDocument!(vscode.Uri.file(staged));
    await sleep(1500);
  });
  assert(fs.readFileSync(staged).equals(before), "the glTF source is byte-identical — nothing was written");
  assert(!fs.existsSync(`${staged}.bak`), "no .bak beside a glTF source");
  await closeAll();
});

test("Promote to B-rep writes a new STEP file and leaves the source alone", async () => {
  // Roadmap "Mesh → B-rep promotion" Phase 2 host half: the panel button's
  // quick-picks + save dialog + one-shot write, driven through the same
  // seam the button uses. The source keeps its mesh identity (never
  // reclassified in place).
  const api = await saveTestApi();
  if (!api?.simulateWebviewMessage) return;
  const staged = stage(STL_FIXTURE);
  const before = fs.readFileSync(staged);
  assert(await openDocument(staged), "the STL fixture opens");
  const out = path.join(path.dirname(staged), "promoted.step");
  await withModals([pick("STEP"), pick("Native"), save(out)], async () => {
    await api.simulateWebviewMessage!(vscode.Uri.file(staged), { type: "promoteToBrepButtonClicked", mergeFacets: false });
    assert(await waitForFile(out, 120000), "the promoted STEP is written");
  });
  assert(fs.readFileSync(out, "utf8").startsWith("ISO-10303-21;"), "the output is a STEP file");
  assert(fs.readFileSync(staged).equals(before), "the STL source is byte-identical");
  assert(!fs.existsSync(`${staged}.edits.json`), "promotion creates no sidecar");
  await closeAll();
});

test("A clean-tail external source rewrite reloads silently", async () => {
  // Sidecar/source reconciliation, the no-conflict branch: with no pending
  // edits the extension's own write is impossible (nothing was written), so
  // an external rewrite must reload — content-compared, no prompt. An
  // unscripted modal throws, so reaching the repost proves the silence.
  const api = await saveTestApi();
  if (!api?.onDidPostMessage) return;
  const staged = stage(STEP_FIXTURE);
  const seen: string[] = [];
  const sub = api.onDidPostMessage((m) => {
    seen.push((m as { type: string }).type);
  });
  try {
    assert(await openDocument(staged), "the STEP fixture opens");
    assert(await waitFor(() => seen.includes("geometry"), 30000), "the initial geometry posts");
    const n = seen.filter((t) => t === "geometry").length;
    await withModals([], async () => {
      fs.copyFileSync(path.join(ROOT, "examples", "STP", "cylcub.stp"), staged);
      assert(await waitFor(() => seen.filter((t) => t === "geometry").length > n, 30000), "the external rewrite reposts geometry with no prompt");
    });
  } finally {
    sub.dispose();
  }
  await closeAll();
});

test("View state persists to .view.json and replays on reopen", async () => {
  // View-state persistence host half: the `viewChanged` post debounces into
  // the sidecar, and the stored view replays on the next open. No unit-test
  // path exists (`vscode`-API-dependent throughout), so this is the coverage.
  const api = await saveTestApi();
  if (!api?.simulateWebviewMessage || !api?.onDidPostMessage) return;
  const staged = stage(STEP_FIXTURE);
  assert(await openDocument(staged), "the STEP fixture opens");
  await api.simulateWebviewMessage!(vscode.Uri.file(staged), {
    type: "viewChanged",
    view: { viewDirection: [1, 0, 0], cameraUp: [0, 1, 0], orthographic: true, displayMode: "wireframe", clip: null },
  });
  const sidecar = `${staged}.view.json`;
  assert(await waitForFile(sidecar, 15000), "the view sidecar is written");
  const saved = JSON.parse(fs.readFileSync(sidecar, "utf8"));
  assert(saved.view?.displayMode === "wireframe" && saved.view?.orthographic === true, `the sidecar carries the posted view (got ${JSON.stringify(saved.view)})`);
  await closeAll();
  const seen: Array<{ type: string; view?: { displayMode?: string } }> = [];
  const sub = api.onDidPostMessage((m) => void seen.push(m as never));
  try {
    assert(await openDocument(staged), "the document reopens");
    assert(
      await waitFor(() => seen.some((m) => m.type === "viewState" && m.view?.displayMode === "wireframe"), 30000),
      `the stored view replays on open (saw ${JSON.stringify(seen.map((m) => m.type).slice(-8))})`
    );
  } finally {
    sub.dispose();
  }
  await closeAll();
});

test("A Nastran .bdf opens through the meshio bridge with the right extents", async () => {
  // meshio++ Nastran route, host half: the deck converts to an STL boundary
  // the viewer loads (`loadMeshBytes`), and those posted bytes span the
  // independently known 3×4×5 extents — the same pin `mcp:smoke` asserts
  // headlessly, here through the real provider and webview posts.
  const api = await saveTestApi();
  if (!api?.onDidPostMessage) return;
  const staged = stage(path.join(ROOT, "examples", "Nastran", "block-tets.bdf"));
  const seen: Array<{ type: string; dataBase64?: string }> = [];
  const sub = api.onDidPostMessage((m) => void seen.push(m as never));
  let minX = Infinity;
  let maxX = -Infinity;
  try {
    assert(await openDocument(staged), "the Nastran deck opens");
    assert(
      await waitFor(() => seen.some((m) => m.type === "loadMeshBytes" && !!m.dataBase64), 120000),
      `the meshio boundary posts for the Nastran source (saw ${JSON.stringify(seen.map((m) => m.type).slice(-6))})`
    );
    const stl = [...seen].reverse().find((m) => m.type === "loadMeshBytes" && !!m.dataBase64)!;
    const text = Buffer.from(stl.dataBase64!, "base64").toString("utf8");
    assert(/^solid/.test(text) && /endsolid/.test(text), "the posted boundary is an STL document");
    for (const m of text.matchAll(/^\s*vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/gm)) {
      const x = Number(m[1]);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
    assert(Math.abs(minX - -1.5) < 1e-3 && Math.abs(maxX - 1.5) < 1e-3, `the boundary spans x in [-1.5, 1.5] (got [${minX}, ${maxX}])`);
  } finally {
    sub.dispose();
  }
  assert(fs.readFileSync(staged).equals(fs.readFileSync(path.join(ROOT, "examples", "Nastran", "block-tets.bdf"))), "the deck source is byte-identical");
  await closeAll();
});

test("Hole-table copy data comes from the host pipeline", async () => {
  // Parity gaps, hole-table half: the panel's Copy button reads the host's
  // `holeTableResult`, so this drives the request and pins the rows + TSV
  // the button would copy — over the same kernel key as `generate_hole_table`.
  const api = await saveTestApi();
  if (!api?.simulateWebviewMessage || !api?.onDidPostMessage) return;
  const staged = stage(STEP_FIXTURE);
  fs.writeFileSync(
    `${staged}.edits.json`,
    JSON.stringify({
      version: 1,
      source: path.basename(staged),
      ops: [{ op: "addHole", targets: ["solid-0"], position: [0, 0, 2.5], axis: [0, 0, -1], radius: 1, depth: 5 }],
    })
  );
  assert(await openDocument(staged), "the STEP fixture opens with a hole op");
  const seen: Array<{ type: string; rows?: unknown; requestId?: string }> = [];
  const sub = api.onDidPostMessage((m) => void seen.push(m as never));
  try {
    await api.simulateWebviewMessage!(vscode.Uri.file(staged), { type: "holeTableRequest", requestId: "holes-1" });
    assert(
      await waitFor(() => seen.some((m) => m.type === "holeTableResult"), 120000),
      `a holeTableResult posts (saw ${JSON.stringify(seen.map((m) => m.type).slice(-6))})`
    );
    const res = [...seen].reverse().find((m) => m.type === "holeTableResult") as unknown as { rows: Array<{ diameter?: number; count?: number }> };
    assert(
      Array.isArray(res.rows) && res.rows.length === 1 && Math.abs((res.rows[0].diameter ?? 0) - 2) < 1e-9 && res.rows[0].count === 1,
      `one Ø2 hole group with count 1 (got ${JSON.stringify(res.rows)})`
    );
  } finally {
    sub.dispose();
  }
  await closeAll();
});

test("Refinement sweep with outputs asks for a folder and writes one mesh per size", async () => {
  // Parity gaps, sweep half: the folder dialog (`showOpenDialog`) is the one
  // branch of the sweep flow no harness had ever driven — a write-path
  // prompt, so it belongs here rather than in the webview suite.
  const api = await saveTestApi();
  if (!api?.simulateWebviewMessage || !api?.onDidPostMessage) return;
  const staged = stage(STEP_FIXTURE);
  assert(await openDocument(staged), "the STEP fixture opens");
  const outDir = path.join(path.dirname(staged), "sweep");
  fs.mkdirSync(outDir, { recursive: true });
  const seen: Array<{ type: string; runs?: Array<{ size?: number }>; outputDir?: string | null }> = [];
  const sub = api.onDidPostMessage((m) => void seen.push(m as never));
  try {
    const record = await withModals([openAnswer(outDir)], async () => {
      await api.simulateWebviewMessage!(vscode.Uri.file(staged), {
        type: "meshSweepRequest",
        requestId: "sweep-1",
        sizes: [4, 2],
        options: { ...DEFAULT_MESH_OPTIONS },
        writeOutputs: true,
      });
      assert(
        await waitFor(() => seen.some((m) => m.type === "meshSweepResult"), 300000),
        `a meshSweepResult posts (saw ${JSON.stringify(seen.map((m) => m.type).slice(-6))})`
      );
    });
    assert(record.openDialogs.length === 1 && /sweep/i.test(record.openDialogs[0]?.openLabel ?? ""), `the sweep asked for an output folder (saw ${JSON.stringify(record.openDialogs)})`);
    const res = [...seen].reverse().find((m) => m.type === "meshSweepResult")!;
    assert(res.runs?.length === 2, `two runs, one per size (got ${JSON.stringify(res.runs?.map((r) => r.size))})`);
    for (const size of [4, 2]) {
      const f = path.join(outDir, `block-size-${size}.msh`);
      assert(fs.existsSync(f) && fs.statSync(f).size > 0, `size ${size} wrote ${path.basename(f)}`);
    }
  } finally {
    sub.dispose();
  }
  await closeAll();
});

test("Preparation Report covers a mesh source end to end", async () => {
  // Preparation-report bundle, mesh half: the existing case runs a B-rep
  // source; a mesh source takes different sections (mesh health available,
  // B-rep-only facts unavailable) through the same model+folder command.
  await closeAll();
  const model = stage(STL_FIXTURE);
  const outDir = path.join(path.dirname(model), "report-mesh");
  fs.mkdirSync(outDir, { recursive: true });
  await withModals([openAnswer(model), openAnswer(outDir)], async () => {
    await vscode.commands.executeCommand("cad-preview.prepReport");
  });
  const json = path.join(outDir, "report.json");
  const html = path.join(outDir, "report.html");
  assert(fs.existsSync(json) && fs.existsSync(html), "report.json and report.html are written for a mesh source");
  if (fs.existsSync(json)) {
    const report = JSON.parse(fs.readFileSync(json, "utf8"));
    assert(
      report.sections.length > 0 && report.sections.every((s: { status: string }) => ["ok", "partial", "unavailable", "skipped"].includes(s.status)),
      "every section carries a status"
    );
    const statuses = Object.fromEntries(report.sections.map((s: { id: string; status: string }) => [s.id, s.status]));
    assert(statuses.identity === "ok", `identity ran (got ${JSON.stringify(statuses)})`);
  }
  if (fs.existsSync(html)) {
    const text = fs.readFileSync(html, "utf8");
    assert(!/<script/i.test(text) && !/(src|href)="https?:/.test(text), "report.html has no scripts and no network references");
  }
  await closeAll();
});

test("FE-mesh export with a handoff manifest records Parts and coverage", async () => {
  // Handoff-manifest bundle: the panel export with `manifest: true` writes
  // `<output>.handoff.json` beside the mesh and reports the Part/coverage
  // line — the status text IS the product surface for unresolved parts.
  const api = await saveTestApi();
  if (!api?.simulateWebviewMessage || !api?.onDidPostMessage) return;
  const staged = stage(STEP_FIXTURE);
  assert(await openDocument(staged), "the STEP fixture opens");
  await api.simulateWebviewMessage!(vscode.Uri.file(staged), {
    type: "partsChanged",
    parts: [{ name: "Body", color: "#ff0000", volumes: ["solid-0"], surfaces: [], lines: [], points: [] }],
  });
  await sleep(1500);
  const statuses: string[] = [];
  const sub = api.onDidPostMessage?.((m) => {
    const msg = m as { type: string; text?: string };
    if (msg.type === "status" && msg.text) statuses.push(msg.text);
  });
  const out = path.join(path.dirname(staged), "body.msh");
  const manifestPath = `${out}.handoff.json`;
  try {
    await withModals([save(out)], async () => {
      await api.simulateWebviewMessage!(vscode.Uri.file(staged), {
        type: "meshingExport",
        requestId: "handoff-1",
        target: "msh",
        options: { ...DEFAULT_MESH_OPTIONS, sizeMax: 2 },
        manifest: true,
      });
      assert(await waitForFile(manifestPath, 180000), "the handoff manifest is written beside the mesh");
    });
    assert(
      statuses.some((t) => /Handoff manifest written/.test(t) && /1 Part\(s\)/.test(t)),
      `the Part/coverage line is reported (saw ${JSON.stringify(statuses)})`
    );
    const handoff = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert(handoff.parts?.length === 1 && handoff.parts[0]?.name === "Body", `the manifest carries the Part (got ${JSON.stringify(handoff.parts)})`);
    assert(typeof handoff.coverage?.unassignedSurfaceCount === "number", "the manifest carries boundary coverage");
  } finally {
    sub?.dispose();
  }
  await closeAll();
});

/**
 * Roadmap "Embedded points and curves" / registry
 * `free-points-and-lines-are-meshed-on`: the host half of the panel flow.
 * `test:webview` drives the Point/Line composers and the Part assignment;
 * this case proves the real kernel puts nodes exactly on the free entities,
 * which is the claim the feature exists for.
 *
 * The fixture is the one `gmshEmbed.ts` measured: `block.stp` + one
 * `addPoint` (point-8) + one `addLine` (edge-12). The line's own endpoints
 * are interior coordinates with exact half-millimetre values, so a Float32
 * mesh node can be compared without a tolerance debate.
 */
test("a free point and a free line assigned to a Part become mesh nodes at their own coordinates", async () => {
  const api = await saveTestApi();
  if (!api?.simulateWebviewMessage || !api.onDidPostMessage) return;
  const staged = stage(STEP_FIXTURE);
  const point: [number, number, number] = [1.5, 2, 2.5];
  const lineStart: [number, number, number] = [0.5, 0.5, 0.5];
  const lineEnd: [number, number, number] = [2.5, 3.5, 4.5];
  fs.writeFileSync(
    `${staged}.edits.json`,
    JSON.stringify({
      version: 1,
      source: path.basename(staged),
      ops: [
        { op: "addPoint", position: point },
        { op: "addLine", start: lineStart, end: lineEnd },
      ],
    })
  );
  await writeParts(vscode.Uri.file(staged), [
    {
      name: "Free",
      color: "#ff0000",
      volumes: ["solid-0"],
      surfaces: [],
      lines: ["edge-12"],
      points: ["point-8"],
    },
  ]);
  const sourceBefore = fs.readFileSync(staged);
  const geometry: Array<{ type: string }> = [];
  assert(await openAndWaitGeometry(staged, api, geometry), "the STEP fixture opens with the free point and line ops");
  type MeshMsg = {
    type: string;
    requestId?: string;
    message?: string;
    positions?: string;
    nodeCount?: number;
    elementCount?: number;
    elementGroups?: Array<{ name?: string | null }>;
  };
  const posted: MeshMsg[] = [];
  const sub = api.onDidPostMessage((m) => posted.push(m as MeshMsg));
  try {
    await api.simulateWebviewMessage!(vscode.Uri.file(staged), {
      type: "meshingGenerate",
      requestId: "free-1",
      options: { ...DEFAULT_MESH_OPTIONS, sizeMax: 1 },
    });
    assert(
      await waitFor(
        () => posted.some((m) => (m.type === "meshingResult" || m.type === "meshingError") && m.requestId === "free-1"),
        180000
      ),
      "Generate answers"
    );
    const error = posted.find((m) => m.type === "meshingError" && m.requestId === "free-1");
    assert(error === undefined, `Generate reports no error (got ${JSON.stringify(error?.message)})`);
    const result = posted.find((m) => m.type === "meshingResult" && m.requestId === "free-1");
    assert((result?.nodeCount ?? 0) > 0 && (result?.elementCount ?? 0) > 0, `the volume is meshed (${result?.nodeCount} nodes, ${result?.elementCount} elements)`);
    assert(
      result?.elementGroups?.some((g) => g.name === "Free"),
      `the Part survives as a physical group (got ${JSON.stringify(result?.elementGroups)})`
    );
    const buf = Buffer.from(result?.positions ?? "", "base64");
    const positions = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    const hasNode = (p: [number, number, number]): boolean => {
      for (let i = 0; i + 2 < positions.length; i += 3) {
        if (
          Math.abs(positions[i] - p[0]) < 1e-5 &&
          Math.abs(positions[i + 1] - p[1]) < 1e-5 &&
          Math.abs(positions[i + 2] - p[2]) < 1e-5
        ) {
          return true;
        }
      }
      return false;
    };
    assert(hasNode(point), `a mesh node sits exactly on the free point (${JSON.stringify(point)})`);
    assert(hasNode(lineStart) && hasNode(lineEnd), "mesh nodes sit on both endpoints of the free line");
    assert(fs.readFileSync(staged).equals(sourceBefore), "meshing never writes the source");
  } finally {
    sub.dispose();
  }
  await closeAll();
});

/**
 * Roadmap "Robust volumetric meshing from a skin mesh" / registry
 * `ftetwild-robust-volume-meshing`: the FE Mesh panel's Engine select is
 * covered by `test:webview`; this is the host half — the real fTetWild WASM
 * tetrahedralizing the one-facet-holed cube that Gmsh's own path renders as
 * zero elements. If the engine choice is ignored, the gate fails on an empty
 * mesh rather than passing on a Gmsh result.
 */
test("the FE Mesh fTetWild engine generates a tetrahedral mesh from a holed skin", async () => {
  const api = await saveTestApi();
  if (!api?.simulateWebviewMessage || !api.onDidPostMessage) return;
  const staged = stage(path.join(ROOT, "examples", "STL", "holed-cube.stl"));
  const stl = fs.readFileSync(staged).toString("base64");
  assert(await openDocument(staged), "the holed-cube STL opens");
  type MeshMsg = {
    type: string;
    requestId?: string;
    message?: string;
    nodeCount?: number;
    elementCount?: number;
    positions?: string;
    indices?: string;
    quality?: { min?: number } | null;
  };
  const posted: MeshMsg[] = [];
  const sub = api.onDidPostMessage((m) => posted.push(m as MeshMsg));
  try {
    await api.simulateWebviewMessage!(vscode.Uri.file(staged), {
      type: "meshingGenerate",
      requestId: "ftw-1",
      stl,
      options: { ...DEFAULT_MESH_OPTIONS, engine: "ftetwild", ftetwildEpsRel: 5e-3 },
    });
    assert(
      await waitFor(
        () => posted.some((m) => (m.type === "meshingResult" || m.type === "meshingError") && m.requestId === "ftw-1"),
        180000
      ),
      "fTetWild Generate answers"
    );
    const error = posted.find((m) => m.type === "meshingError" && m.requestId === "ftw-1");
    assert(error === undefined, `fTetWild reports no error (got ${JSON.stringify(error?.message)})`);
    const result = posted.find((m) => m.type === "meshingResult" && m.requestId === "ftw-1");
    assert(
      (result?.nodeCount ?? 0) > 0 && (result?.elementCount ?? 0) > 0,
      `the holed cube tetrahedralizes (${result?.nodeCount} nodes, ${result?.elementCount} elements)`
    );
    assert((result?.quality?.min ?? 0) > -1e-6, `the elements are non-inverted (min quality ${result?.quality?.min})`);
    assert(Buffer.from(result?.indices ?? "", "base64").length > 0, "the result carries element indices");
  } finally {
    sub.dispose();
  }
  await closeAll();
});

/**
 * Roadmap "OpenSCAD Customizer panel in the viewer": Apply is a HOST flow.
 * The provider validates the form's values against the SOURCE TEXT, persists
 * the validated set to `<model>.scad-params.json` and reloads the model with
 * those values as `-D` overrides — the source itself is never written.
 *
 * `examples/OpenSCAD/parametric.scad` is analytic: a `width × depth ×
 * thickness` plate minus a hole, so widening it by 20 mm moves the X extent
 * by exactly 20 and leaves everything else alone. The width is the assertion
 * (a "the model changed" signal would prove nothing).
 */
test("the OpenSCAD Customizer's Apply persists the overrides, reloads the model wider and never writes the source", async () => {
  const api = await saveTestApi();
  if (!api?.simulateWebviewMessage || !api.onDidPostMessage) return;
  const staged = stage(path.join(ROOT, "examples", "OpenSCAD", "parametric.scad"));
  const sourceBefore = fs.readFileSync(staged);
  const sidecar = `${staged}.scad-params.json`;

  const seen: Array<{ type: string; meshes?: Array<{ positions?: string }> }> = [];
  const statuses: string[] = [];
  // Attached BEFORE the open: the WASM conversion is fast enough to post the
  // first geometry inside `openDocument`'s own settle wait, and a listener
  // attached afterwards would miss it entirely.
  const sub = api.onDidPostMessage((m) => {
    seen.push(m as { type: string });
    const msg = m as { type: string; text?: string };
    if (msg.type === "status" && msg.text) statuses.push(msg.text);
  });
  try {
    assert(await openDocument(staged), "the parametric .scad opens through the bundled WASM");
    // The WASM conversion plus the first tessellation is not instant — wait
    // for the geometry instead of guessing a delay (a fixed sleep reports
    // "no geometry" identically for "still converting" and "failed").
    assert(await waitFor(() => seen.some((m) => m.type === "geometry"), 60000), "the open posts geometry");
    const before = extentOfPosts(seen);
    assert(before !== null, "the open posted geometry");
    assert(
      before !== null && Math.abs(before.max[0] - before.min[0] - 40) < 1e-3,
      `the plate is 40 mm wide at the defaults (got ${JSON.stringify(before && [before.min[0], before.max[0]])})`
    );

    const geometryBefore = seen.filter((m) => m.type === "geometry").length;
    await api.simulateWebviewMessage!(vscode.Uri.file(staged), {
      type: "scadApplyOverrides",
      overrides: { width: 60, notAParameter: 7 },
    });
    assert(
      await waitFor(() => seen.filter((m) => m.type === "geometry").length > geometryBefore, 60000),
      "Apply reloads the model with the override"
    );
    const after = extentOfPosts(seen);
    assert(
      after !== null && Math.abs(after.max[0] - after.min[0] - 60) < 1e-3,
      `the plate is 60 mm wide after the override (got ${JSON.stringify(after && [after.min[0], after.max[0]])})`
    );
    assert(fs.existsSync(sidecar), "the overrides sidecar is written beside the model");
    const persisted = (readJsonIfExists(sidecar) ?? {}) as { overrides?: Record<string, unknown> };
    assert(persisted.overrides?.width === 60, `the validated override is persisted (got ${JSON.stringify(persisted.overrides)})`);
    assert(
      !("notAParameter" in (persisted.overrides ?? {})),
      `an unknown parameter never reaches the -D set (got ${JSON.stringify(persisted.overrides)})`
    );
    assert(
      statuses.some((s) => /notAParameter/.test(s) && /ignored/i.test(s)),
      `the dropped parameter is reported to the user (saw ${JSON.stringify(statuses)})`
    );
    assert(fs.readFileSync(staged).equals(sourceBefore), "the .scad source is byte-identical — Apply never writes it");
  } finally {
    sub.dispose();
  }
  await closeAll();
});

/**
 * Roadmap "Saved parametric scripts — the macro library": saving a macro is a
 * HOST flow with a text prompt, and the library it writes is a real file
 * beside the model — the thing a user can lose. Three facts matter: the
 * prompt is the naming step, the recorded script is the document's op list,
 * and a dismissed prompt writes NOTHING (a silent write would be worse than
 * no write).
 */
test("saving a macro writes the library beside the model, records the op list, and a dismissed prompt writes nothing", async () => {
  const api = await saveTestApi();
  if (!api?.simulateWebviewMessage || !api.onDidPostMessage) return;
  const staged = stage(STEP_FIXTURE);
  const library = path.join(path.dirname(staged), "cad-preview-macros.json");
  assert(await openDocument(staged), "the STEP fixture opens");
  await sleep(1500);

  // One op, so "the recorded script IS the op list" is checkable.
  await api.simulateWebviewMessage!(vscode.Uri.file(staged), {
    type: "editsChanged",
    ops: [{ op: "translate", targets: ["solid-0"], vec: [5, 0, 0] }],
    variables: [],
  });
  await sleep(1500);

  const record = await withModals([input("my-macro")], async () => {
    await api.simulateWebviewMessage!(vscode.Uri.file(staged), { type: "macroSaveCurrent" });
    await waitForFile(library, 15000);
  });
  assert(record.inputBoxes.length === 1, `the name prompt opened once (saw ${JSON.stringify(record.inputBoxes)})`);
  assert(/name/i.test(record.inputBoxes[0]?.prompt ?? ""), `the prompt asks for a name (got ${JSON.stringify(record.inputBoxes[0])})`);
  assert(fs.existsSync(library), "the macro library is written beside the model");  const saved = (readJsonIfExists(library) ?? {}) as {
    scripts?: Record<string, { name?: string; script?: { steps?: Array<{ op?: { op?: string } }> } }>;
  };
  const entry = saved.scripts?.["my-macro"];
  assert(entry !== undefined, `the macro is stored under its name (got ${JSON.stringify(Object.keys(saved.scripts ?? {}))})`);
  assert(entry?.name === "my-macro", `the entry carries its name (got ${JSON.stringify(entry?.name)})`);
  assert(
    entry?.script?.steps?.[0]?.op?.op === "translate",
    `the recorded script IS the document's op list (got ${JSON.stringify(entry?.script?.steps)})`
  );

  // A dismissed prompt is a quiet no-op — and must not write.
  const before = fs.readFileSync(library);
  const dismissed = await withModals([cancel()], async () => {
    await api.simulateWebviewMessage!(vscode.Uri.file(staged), { type: "macroSaveCurrent" });
    await sleep(1500);
  });
  assert(dismissed.inputBoxes.length === 1, "the dismissed save still opened the prompt");
  assert(fs.existsSync(library) && fs.readFileSync(library).equals(before), "a dismissed prompt writes nothing");
  await api.revertDocument?.(vscode.Uri.file(staged));
  await closeAll();
});

/**
 * Roadmap 1.1 / registry `primitive-recognition-panel`: the host half of the
 * panel's click-through. `test:webview` already drives Recognize's request
 * shape and Apply's emitted ops; what it cannot reach is the real kernel
 * report, the Export quick-picks/save dialog, and the Save-macro prompt. The
 * source must stay byte-identical throughout.
 */
test("the primitives panel recognizes a box, exports it as STEP, and saves it as a macro", async () => {
  const api = await saveTestApi();
  if (!api?.simulateWebviewMessage || !api.onDidPostMessage) return;
  const staged = stage(STEP_FIXTURE);
  const out = path.join(path.dirname(staged), "recognized.step");
  const library = path.join(path.dirname(staged), "cad-preview-macros.json");
  const sourceBefore = fs.readFileSync(staged);
  type PrimitiveMsg = {
    type: string;
    requestId?: string;
    report?: { solidCount?: number; solids?: Array<{ candidate?: { kind?: string } | null }> };
    message?: string;
  };
  const seen: PrimitiveMsg[] = [];
  const sub = api.onDidPostMessage((m) => seen.push(m as PrimitiveMsg));
  try {
    assert(await openDocument(staged), "the STEP fixture opens");
    await sleep(2000);
    await api.simulateWebviewMessage!(vscode.Uri.file(staged), { type: "primitiveRecognizeRequest", requestId: "prim-1" });
    assert(
      await waitFor(() => seen.some((m) => m.type === "primitiveRecognizeResult" || m.type === "primitiveRecognizeError"), 60000),
      "Recognize answers"
    );
    const error = seen.find((m) => m.type === "primitiveRecognizeError");
    assert(error === undefined, `Recognize reports no error (got ${JSON.stringify(error?.message)})`);
    const result = seen.find((m) => m.type === "primitiveRecognizeResult");
    assert(result?.report?.solidCount === 1, `the box fixture reports one solid (got ${JSON.stringify(result?.report?.solidCount)})`);
    assert(
      result?.report?.solids?.[0]?.candidate?.kind === "box",
      `and recognizes it as a box (got ${JSON.stringify(result?.report?.solids?.[0]?.candidate)})`
    );

    const exportRecord = await withModals([pick("STEP"), pick("Native (mm)"), save(out)], async () => {
      await api.simulateWebviewMessage!(vscode.Uri.file(staged), { type: "decomposeExportClicked" });
      assert(await waitForFile(out, 60000), "Export writes the chosen STEP file");
    });
    assert(
      exportRecord.quickPicks[0]?.placeHolder === "Export recognized primitives as…",
      `Export offers the format picker (got ${JSON.stringify(exportRecord.quickPicks[0])})`
    );
    assert(fs.existsSync(out) && fs.statSync(out).size > 0, "the exported file is non-empty");
    assert(/^ISO-10303-21;/.test(fs.readFileSync(out, "latin1").slice(0, 32)), "the export is a real STEP file");
    assert(fs.readFileSync(staged).equals(sourceBefore), "Export does not write the source");

    const macroRecord = await withModals([input("recognized-block")], async () => {
      await api.simulateWebviewMessage!(vscode.Uri.file(staged), { type: "decomposeSaveMacroClicked" });
      assert(await waitForFile(library, 30000), "Save macro writes the library");
    });
    assert(
      macroRecord.inputBoxes[0]?.title === "Save primitives as macro",
      `Save macro asks for a name (got ${JSON.stringify(macroRecord.inputBoxes[0])})`
    );
    const saved = readJsonIfExists(library) as {
      scripts?: Record<string, { name?: string; script?: { steps?: Array<{ op?: { op?: string } }> } }>;
    } | null;
    const entry = saved?.scripts?.["recognized-block"];
    assert(entry !== undefined, `the macro is stored under its name (got ${JSON.stringify(Object.keys(saved?.scripts ?? {}))})`);
    assert(
      entry?.script?.steps?.[0]?.op?.op === "addBox",
      `the macro records the emitted addBox (got ${JSON.stringify(entry?.script?.steps)})`
    );
    assert(fs.readFileSync(staged).equals(sourceBefore), "Save macro does not write the source");

    const beforeDismiss = fs.readFileSync(library);
    const dismissed = await withModals([cancel()], async (session) => {
      await api.simulateWebviewMessage!(vscode.Uri.file(staged), { type: "decomposeSaveMacroClicked" });
      assert(await waitFor(() => session.record.inputBoxes.length === 1, 30000), "the dismissed save still opened the prompt");
    });
    assert(dismissed.inputBoxes.length === 1, "the dismissed save still opened the prompt");
    assert(fs.readFileSync(library).equals(beforeDismiss), "a dismissed prompt writes nothing");
  } finally {
    sub.dispose();
  }
  await closeAll();
});

/**
 * Roadmap "Bundled starter macro library": a bundled starter is READ-ONLY.
 * Two halves, both host-side: Run pushes the macro's ops onto the same op
 * stack as hand edits (so the model really changes), and Delete is refused
 * for a bundled name — a refusal that must not touch the shipped library
 * file.
 *
 * The starter's own description says it is "designed for a blank model" (its
 * pattern and boolean reference the solids its first two steps create on an
 * empty base), so the run happens on a blank model.
 */
test("a bundled starter macro runs on a blank model and cannot be deleted", async () => {
  const api = await saveTestApi();
  if (!api?.simulateWebviewMessage || !api.onDidPostMessage) return;
  const dest = path.join(tempDir(), "blank.brep");
  const bundled = path.join(ROOT, "dist", "macros", "starter-library.json");
  const bundledBefore = fs.existsSync(bundled) ? fs.readFileSync(bundled) : null;

  const seen: Array<{ type: string; meshes?: Array<{ positions?: string }> }> = [];
  const statuses: string[] = [];
  const errors: string[] = [];
  const sub = api.onDidPostMessage((m) => {
    seen.push(m as { type: string });
    const msg = m as { type: string; text?: string; message?: string };
    if (msg.type === "status" && msg.text) statuses.push(msg.text);
    if (msg.type === "error" && msg.message) errors.push(msg.message);
  });
  try {
    await withModals([save(dest)], async () => {
      await vscode.commands.executeCommand("cad-preview.new");
      await waitForFile(dest, 20000);
      assert(
        await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.label === path.basename(dest), 20000),
        "the blank model is open"
      );
      await sleep(1500);
      const geometryBefore = seen.filter((m) => m.type === "geometry").length;
      await api.simulateWebviewMessage!(vscode.Uri.file(dest), { type: "macroRun", name: "bolt-circle-flange" });
      assert(
        await waitFor(() => seen.filter((m) => m.type === "geometry").length > geometryBefore, 60000),
        "running the macro rebuilds the model"
      );
      assert(
        statuses.some((s) => /Ran "bolt-circle-flange"/.test(s)),
        `the run is reported (saw ${JSON.stringify(statuses)})`
      );
      const extent = extentOfPosts(seen);
      // The starter's first step is a r=40, h=10 cylinder centred on the
      // origin. The extent is a TESSELLATED one: a 32-facet cylinder's
      // extreme point sits a chord-error inside the true radius (39.95 mm
      // here), so the tolerance is a fraction of a millimetre, not exact.
      assert(
        extent !== null && Math.abs(extent.max[0] - extent.min[0] - 80) < 0.5,
        `the flange is 80 mm across (got ${JSON.stringify(extent && [extent.min[0], extent.max[0]])})`
      );
      assert(
        extent !== null && Math.abs(extent.max[2] - extent.min[2] - 10) < 1e-2,
        `the flange is 10 mm tall (got ${JSON.stringify(extent && [extent.min[2], extent.max[2]])})`
      );

      // Delete is refused for a bundled starter — and the shipped file is untouched.
      await api.simulateWebviewMessage!(vscode.Uri.file(dest), { type: "macroDelete", name: "bolt-circle-flange" });
      await sleep(1000);
      assert(
        errors.some((e) => /bundled starter macro and cannot be deleted/.test(e)),
        `the delete is refused by name (saw ${JSON.stringify(errors)})`
      );
      if (bundledBefore) {
        assert(fs.readFileSync(bundled).equals(bundledBefore), "the shipped starter library is untouched");
      }
    });
  } finally {
    sub.dispose();
  }
  await api.revertDocument?.(vscode.Uri.file(dest));
  await closeAll();
});

/**
 * Roadmap "Reusable meshing presets": the preset library is a real file beside
 * the model, and Apply is what makes it worth having — it must put the
 * preset's options back on the document (the `.mesh.json` sidecar AND the
 * generated `.geo`), not merely acknowledge the name.
 */
test("a meshing preset saves beside the model and Apply restores its options", async () => {
  const api = await saveTestApi();
  if (!api?.simulateWebviewMessage || !api.onDidPostMessage) return;
  const staged = stage(STEP_FIXTURE);
  const library = path.join(path.dirname(staged), "cad-preview-mesh-presets.json");
  assert(await openDocument(staged), "the STEP fixture opens");
  await sleep(1500);

  const statuses: string[] = [];
  const sub = api.onDidPostMessage((m) => {
    const msg = m as { type: string; text?: string };
    if (msg.type === "status" && msg.text) statuses.push(msg.text);
  });
  try {
    await api.simulateWebviewMessage!(vscode.Uri.file(staged), {
      type: "meshingChanged",
      options: { ...DEFAULT_MESH_OPTIONS, sizeMax: 3 },
    });
    await sleep(1500);

    const record = await withModals([input("my-preset")], async () => {
      await api.simulateWebviewMessage!(vscode.Uri.file(staged), { type: "meshPresetSaveCurrent" });
      await waitForFile(library, 15000);
    });
    assert(record.inputBoxes.length === 1, `the name prompt opened once (saw ${JSON.stringify(record.inputBoxes)})`);
    assert(fs.existsSync(library), "the preset library is written beside the model");
    const saved = (readJsonIfExists(library) ?? {}) as {
      presets?: Record<string, { name?: string; unit?: string; options?: { sizeMax?: number } }>;
    };
    const preset = saved.presets?.["my-preset"];
    assert(preset !== undefined, `the preset is stored under its name (got ${JSON.stringify(Object.keys(saved.presets ?? {}))})`);
    assert(preset?.options?.sizeMax === 3, `the preset carries the options at save time (got ${JSON.stringify(preset?.options?.sizeMax)})`);
    assert(preset?.unit === "mm", `the preset is stored in mm (got ${JSON.stringify(preset?.unit)})`);

    // Change the options, then Apply the preset: the preset's values must win.
    await api.simulateWebviewMessage!(vscode.Uri.file(staged), {
      type: "meshingChanged",
      options: { ...DEFAULT_MESH_OPTIONS, sizeMax: 9 },
    });
    await sleep(1500);
    await api.simulateWebviewMessage!(vscode.Uri.file(staged), { type: "meshPresetApply", name: "my-preset" });
    await sleep(1500);
    assert(
      statuses.some((s) => /Applied mesh preset "my-preset"/.test(s)),
      `the apply is reported (saw ${JSON.stringify(statuses)})`
    );
    const applied = (readJsonIfExists(`${staged}.mesh.json`) ?? {}) as { options?: { sizeMax?: number } };
    assert(applied.options?.sizeMax === 3, `the preset's sizeMax is back on the document (got ${JSON.stringify(applied.options?.sizeMax)})`);
    const geo = fs.existsSync(`${staged}.geo`) ? fs.readFileSync(`${staged}.geo`, "utf8") : "";
    assert(/Mesh\.MeshSizeMax = 3;/.test(geo), `the generated .geo carries the preset's size (got ${/Mesh\.MeshSizeMax = [^;]+;/.exec(geo)?.[0]})`);
  } finally {
    sub.dispose();
  }
  await closeAll();
});

/**
 * Roadmap "Mesh operations panel for meshio sources": the Run action is a host
 * flow that ends in a real file. Two facts matter — the operation's output
 * lands in a NEW file (the source is never the target), and the source stays
 * byte-identical afterwards.
 */
test("a meshio operation writes a new mesh and leaves the source untouched", async () => {
  const api = await saveTestApi();
  if (!api?.simulateWebviewMessage || !api.onDidPostMessage) return;
  const staged = stage(path.join(ROOT, "examples", "MED", "two-material-tets.med"));
  const sourceBefore = fs.readFileSync(staged);
  const out = path.join(path.dirname(staged), "smoothed.med");
  assert(await openDocument(staged), "the MED fixture opens through the meshio bridge");
  await sleep(2000);

  let result: { steps?: Array<{ op?: string; applied?: boolean }> } | undefined;
  const sub = api.onDidPostMessage((m) => {
    const msg = m as { type: string; steps?: Array<{ op?: string; applied?: boolean }> };
    if (msg.type === "meshioOpsResult") result = { steps: msg.steps };
  });
  try {
    await withModals([save(out)], async () => {
      await api.simulateWebviewMessage!(vscode.Uri.file(staged), {
        type: "meshioOpsRequest",
        requestId: "meshio-ops-1",
        ops: [{ op: "smooth", iterations: 1 }],
      });
      await waitForFile(out, 60000);
    });
    assert(fs.existsSync(out), "the operation's output is written to the chosen path");
    const written = fs.readFileSync(out);
    // The output keeps the SOURCE's format (the save dialog's extension
    // follows the routed one), and MED is an HDF5 container — so this is the
    // real file header, not a text mesh.
    assert(
      written.length > 8 && written.subarray(0, 4).toString("latin1") === "\x89HDF",
      `the output is a real MED (HDF5) document (got ${written.subarray(0, 8).toString("latin1")})`
    );
    assert(result?.steps?.some((s) => s.op === "smooth"), `the op is reported back (got ${JSON.stringify(result?.steps)})`);
    assert(fs.readFileSync(staged).equals(sourceBefore), "the source mesh is byte-identical — the op wrote a new file");
  } finally {
    sub.dispose();
  }
  await closeAll();
});

/**
 * Roadmap "Snapshot display modes, section clip, compare_models quality and
 * clearance": the Clash panel's Clearance field is a HOST value — the provider
 * validates it and forwards it to the kernel, which answers with the exact
 * gap between the two operands.
 *
 * The fixture is analytic: `block.stp` is a 3×4×5 box centred on the origin
 * (x −1.5…1.5) and the added box is 3×4×5 centred at x = 10 (x 8.5…11.5), so
 * the gap between them is exactly 7 mm.
 */
test("the clash check validates the clearance, forwards it to the kernel and reports the exact gap", async () => {
  const api = await saveTestApi();
  if (!api?.simulateWebviewMessage || !api.onDidPostMessage) return;
  const staged = stage(STEP_FIXTURE);
  assert(await openDocument(staged), "the STEP fixture opens");
  await sleep(1500);

  const results: Array<{ requestId?: string; result?: { hasOverlap?: boolean; clearance?: number; withinClearance?: boolean } }> = [];
  const errors: Array<{ requestId?: string; message?: string }> = [];
  const sub = api.onDidPostMessage((m) => {
    const msg = m as { type: string; requestId?: string; result?: { hasOverlap?: boolean; clearance?: number; withinClearance?: boolean }; message?: string };
    if (msg.type === "clashCheckResult") results.push({ requestId: msg.requestId, result: msg.result });
    if (msg.type === "clashCheckError") errors.push({ requestId: msg.requestId, message: msg.message });
  });
  try {
    // A second solid, 7 mm clear of the box.
    await api.simulateWebviewMessage!(vscode.Uri.file(staged), {
      type: "editsChanged",
      ops: [{ op: "addBox", center: [10, 0, 0], size: [3, 4, 5] }],
      variables: [],
    });
    await sleep(2000);
    await api.simulateWebviewMessage!(vscode.Uri.file(staged), {
      type: "partsChanged",
      parts: [
        { name: "A", color: "#ff0000", volumes: ["solid-0"], surfaces: [], lines: [], points: [] },
        { name: "B", color: "#00ff00", volumes: ["solid-1"], surfaces: [], lines: [], points: [] },
      ],
    });
    await sleep(1500); // the parts sidecar is debounced — the tool reads it from disk

    const ask = async (requestId: string, minClearance: unknown) => {
      await api.simulateWebviewMessage!(vscode.Uri.file(staged), {
        type: "clashCheckRequest",
        requestId,
        partA: "A",
        partB: "B",
        minClearance,
      });
      return waitFor(
        () => results.some((r) => r.requestId === requestId) || errors.some((e) => e.requestId === requestId),
        60000
      );
    };

    assert(await ask("clash-wide", 8), "the check answers");
    const wide = results.find((r) => r.requestId === "clash-wide")?.result;
    assert(wide?.hasOverlap === false, `the two boxes do not overlap (got ${JSON.stringify(wide)})`);
    assert(
      wide?.clearance !== undefined && Math.abs(wide.clearance - 7) < 1e-3,
      `the exact gap is 7 mm (got ${JSON.stringify(wide?.clearance)})`
    );
    assert(wide?.withinClearance === true, "a 7 mm gap is inside an 8 mm clearance");

    // Control: the same pair with a clearance the gap already satisfies.
    assert(await ask("clash-narrow", 1), "the narrow check answers");
    const narrow = results.find((r) => r.requestId === "clash-narrow")?.result;
    assert(narrow?.withinClearance === false, `a 7 mm gap is outside a 1 mm clearance (got ${JSON.stringify(narrow)})`);

    // A bad value never reaches the kernel.
    assert(await ask("clash-bad", -1), "the invalid check answers");
    const bad = errors.find((e) => e.requestId === "clash-bad");
    assert(
      bad?.message !== undefined && /clearance/i.test(bad.message),
      `the invalid clearance is refused by name (got ${JSON.stringify(bad?.message)})`
    );
    assert(!results.some((r) => r.requestId === "clash-bad"), "the refused request produces no result");
  } finally {
    sub.dispose();
  }
  await api.revertDocument?.(vscode.Uri.file(staged));
  await closeAll();
});

/**
 * Roadmap "Interactive half — pin-as-query row": the synthesis is SERVER-side
 * — the provider replays the op's prefix in the kernel and asks for a query
 * bound to the picked face. The host half is what the webview cannot prove:
 * that a face produced by an op really does synthesize a query, and that an
 * op index the host cannot replay is refused rather than answered.
 */
test("pinning a produced face as a query synthesizes it server-side", async () => {
  const api = await saveTestApi();
  if (!api?.simulateWebviewMessage || !api.onDidPostMessage) return;
  const staged = stage(STEP_FIXTURE);
  assert(await openDocument(staged), "the STEP fixture opens");
  await sleep(1500);

  const results: Array<{ requestId?: string; results?: Array<{ entityId?: string; query?: unknown; kind?: string | null; reason?: string }> }> = [];
  const errors: Array<{ requestId?: string; message?: string }> = [];
  const sub = api.onDidPostMessage((m) => {
    const msg = m as { type: string; requestId?: string; results?: Array<{ entityId?: string; query?: unknown; kind?: string | null; reason?: string }>; message?: string };
    if (msg.type === "selectorSynthesizeResult") results.push({ requestId: msg.requestId, results: msg.results });
    if (msg.type === "selectorSynthesizeError") errors.push({ requestId: msg.requestId, message: msg.message });
  });
  try {
    // One op that produces faces (an added box → six new faces, ids 6…11).
    await api.simulateWebviewMessage!(vscode.Uri.file(staged), {
      type: "editsChanged",
      ops: [{ op: "addBox", center: [10, 0, 0], size: [3, 4, 5] }],
      variables: [],
    });
    await sleep(2000);

    await api.simulateWebviewMessage!(vscode.Uri.file(staged), {
      type: "selectorSynthesizeRequest",
      requestId: "pin-1",
      op: 0,
      role: "body",
      entityIds: ["face-6", "face-7", "face-8", "face-9", "face-10", "face-11"],
    });
    assert(
      results.find((r) => r.requestId === "pin-1") !== undefined,
      "the synthesis answers"
    );
    assert(
      errors.length === 0,
      `a well-formed request is answered, not refused wholesale (saw ${JSON.stringify(errors)})`
    );
    const entries = results.find((r) => r.requestId === "pin-1")?.results ?? [];
    assert(entries.length === 6, `every picked face is answered (got ${entries.length})`);
    const synthesized = entries.filter((e) => e.query);
    assert(synthesized.length > 0, `at least one face synthesizes a query (got ${JSON.stringify(entries)})`);
    assert(
      synthesized.every((e) => e.kind === "addBox"),
      `the query is stamped with the producing op (got ${JSON.stringify(synthesized.map((e) => e.kind))})`
    );

    // An op index the host cannot replay is refused per face, not answered
    // with a query: the reply carries the reason instead.
    await api.simulateWebviewMessage!(vscode.Uri.file(staged), {
      type: "selectorSynthesizeRequest",
      requestId: "pin-2",
      op: 99,
      role: "body",
      entityIds: ["face-6"],
    });
    assert(
      await waitFor(() => results.some((r) => r.requestId === "pin-2"), 30000),
      "the impossible op index is answered"
    );
    const refused = results.find((r) => r.requestId === "pin-2")?.results ?? [];
    assert(refused.length === 1, `the refused request answers per face (got ${JSON.stringify(refused)})`);
    assert(refused[0]?.query === null, `no query is synthesized for an op the host cannot replay (got ${JSON.stringify(refused[0])})`);
    assert(
      /Bucket op 99/.test(refused[0]?.reason ?? ""),
      `the refusal names the op it cannot replay (got ${JSON.stringify(refused[0]?.reason)})`
    );
  } finally {
    sub.dispose();
  }
  await api.revertDocument?.(vscode.Uri.file(staged));
  await closeAll();
});

  // `/tmp/cad-preview-test-only` (a substring) runs only matching cases —
  // iterating on one kernel-slow case without paying for the whole suite
  // each time. The launcher does not forward env into the test VS Code, so a
  // file (written from the shell before spawning) is the channel. Absent file
  // runs everything; delete it afterwards. One substring PER LINE, so a
  // group of related cases can be run together.
  let only: string[] = [];
  try {
    only = fs
      .readFileSync("/tmp/cad-preview-test-only", "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    only = [];
  }
  for (const c of CASES) {
    if (only.length > 0 && !only.some((o) => c.name.includes(o))) continue;
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
