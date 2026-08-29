/**
 * Builds and runs the host-side integration suite.
 *
 * Bundles `runTest.ts` (the launcher) and `suite/index.ts` (the tests that run
 * INSIDE VS Code) to CJS, then spawns the launcher — the same
 * esbuild-bundle-then-`spawnSync` recipe `scripts/screenshots/make-fixtures.mjs`
 * uses for TypeScript that imports from `src/` but runs outside the extension.
 *
 * `vscode` is external in BOTH bundles: it is not an npm package at all, it is
 * injected by the VS Code runtime. `@vscode/test-electron` is external in the
 * launcher because it spawns a real Electron and must resolve from
 * `node_modules` at runtime.
 *
 * Needs a display server — on headless Linux, `xvfb-run -a`.
 */
import * as esbuild from "esbuild";
import { spawnSync } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, ".build");

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  logLevel: "warning",
};

// The suite runs inside VS Code's own Node, which provides `vscode`.
await esbuild.build({
  ...shared,
  entryPoints: [path.join(HERE, "suite", "index.ts")],
  outfile: path.join(OUT, "suite.js"),
  external: ["vscode"],
});

// The launcher runs in plain Node and drives Electron.
await esbuild.build({
  ...shared,
  entryPoints: [path.join(HERE, "runTest.ts")],
  outfile: path.join(OUT, "runTest.js"),
  external: ["vscode", "@vscode/test-electron"],
});

// `ELECTRON_RUN_AS_NODE` MUST NOT reach the spawned VS Code.
//
// VS Code's own integrated terminal (and its extension host) export
// `ELECTRON_RUN_AS_NODE=1` for child processes. The VS Code this downloads is
// an Electron binary, and with that variable set it starts as PLAIN NODE
// instead — so every VS Code CLI flag becomes an unrecognized Node option and
// the launch dies with `bad option: --extensionTestsPath=…` / `bad option:
// --user-data-dir=…` (exit 9), or, with a positional path, tries to `require()`
// the workspace folder and fails MODULE_NOT_FOUND. Both look like argument
// bugs and are not; deleting the variable for the child fixes both.
// Running `npm run test:integration` from a normal terminal never hits this,
// which is exactly why it is easy to misdiagnose.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const res = spawnSync(process.execPath, [path.join(OUT, "runTest.js")], { stdio: "inherit", env });
process.exit(res.status ?? 1);
