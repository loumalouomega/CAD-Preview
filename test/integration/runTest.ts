/**
 * Launches a real VS Code with this extension loaded and runs
 * `suite/index.ts` inside it (`@vscode/test-electron`).
 *
 * Requires a display server. On a headless Linux CI box that means
 * `xvfb-run -a npm run test:integration`; the workflow does this.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  // This file is bundled to `test/integration/.build/`, so the repo root is
  // three levels up — the same cwd-independent anchoring `fixtures-entry.ts`
  // documents for its own bundled output.
  const extensionDevelopmentPath = path.resolve(__dirname, "..", "..", "..");
  const extensionTestsPath = path.resolve(__dirname, "suite.js");

  // A fresh user-data dir per run. `@vscode/test-electron` otherwise reuses
  // `.vscode-test/user-data`, whose persisted workspace state survives across
  // runs on the same machine: deleted `/tmp/cad-preview-integration-*` dirs
  // linger as dead workspace roots (visible as "Ignoring the error while
  // validating workspace folder ... ENOENT" noise), and the Models-view case
  // would inherit whatever folders a previous run left behind instead of the
  // workspace it assumes.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-preview-vscode-user-data-"));
  // The window opens WITH a workspace folder (an empty staging root, deleted
  // with everything else afterwards). A window that starts with NO workspace
  // at all never delivers `updateWorkspaceFolders` to the extension host —
  // the call returns true and the main side even records the folder, but no
  // `onDidChangeWorkspaceFolders` event ever fires and
  // `vscode.workspace.workspaceFolders` stays empty indefinitely (probed:
  // every deleteCount shape, 60s+ of polling, zero events — while the same
  // calls propagate fine in a window that started non-empty). Starting
  // non-empty keeps the Models-view case's add/remove flow on the working
  // path.
  const launchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cad-preview-integration-launch-"));
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // NOTE: the first launchArg is a positional folder path (per the
      // `launchArgs` docs, the launched instance opens it). It must stay
      // first — everything after it is flags.
      //
      // `--enable-unsafe-swiftshader`: the webview's three.js renderer needs
      // WebGL2, which CI's xvfb box has no hardware for (its GPU process logs
      // "WebGL2 blocklisted"). Without software GL the webview module dies in
      // `new THREE.WebGLRenderer(...)` before ever posting `ready`, so the
      // host never loads the model and NO host→webview message is ever
      // posted — which reads as an empty assertion log (`saw []`), not an
      // error, and every check that doesn't need a live webview still passes,
      // hiding the outage. Verified by running the suite locally with
      // `--disable-gpu`: the blank-model geometry assertion fails with
      // exactly CI's `saw []`; adding this flag back restores software WebGL
      // and the assertion passes. A no-op on machines with working GL.
      //
      // If a launch ever fails here with `bad option: --extensionTestsPath=…`,
      // the cause is `ELECTRON_RUN_AS_NODE` leaking in from a VS Code integrated
      // terminal, NOT the arguments — see `run.mjs`, which strips it.
      launchArgs: [launchRoot, `--user-data-dir=${userDataDir}`, "--enable-unsafe-swiftshader"],
    });
  } finally {
    for (const dir of [userDataDir, launchRoot]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort: the OS reaps tmp either way, and CI runners are ephemeral */
      }
    }
  }
}

main().catch((err) => {
  console.error("Integration tests failed:", err);
  process.exit(1);
});
