/**
 * Launches a real VS Code with this extension loaded and runs
 * `suite/index.ts` inside it (`@vscode/test-electron`).
 *
 * Requires a display server. On a headless Linux CI box that means
 * `xvfb-run -a npm run test:integration`; the workflow does this.
 */
import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  // This file is bundled to `test/integration/.build/`, so the repo root is
  // three levels up — the same cwd-independent anchoring `fixtures-entry.ts`
  // documents for its own bundled output.
  const extensionDevelopmentPath = path.resolve(__dirname, "..", "..", "..");
  const extensionTestsPath = path.resolve(__dirname, "suite.js");

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    // No `launchArgs`: the suite opens its fixture by absolute URI, so it needs
    // no workspace root, and `@vscode/test-electron` already isolates the run
    // in its own user-data/extensions dirs.
    //
    // If a launch ever fails here with `bad option: --extensionTestsPath=…`,
    // the cause is `ELECTRON_RUN_AS_NODE` leaking in from a VS Code integrated
    // terminal, NOT the arguments — see `run.mjs`, which strips it.
  });
}

main().catch((err) => {
  console.error("Integration tests failed:", err);
  process.exit(1);
});
