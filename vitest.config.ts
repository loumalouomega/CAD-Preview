import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Unit tests run outside VS Code, where the `vscode` module is
    // unresolvable — every previous test simply never imported it. Modules
    // under test that DO import it (`customBackup.ts`, the `*Store.ts`
    // modules via `dirtyGuard.ts`) resolve to the in-memory
    // `src/vscodeStub.ts` instead. Production bundles are unaffected (esbuild
    // keeps `vscode` external; this alias applies to vitest only).
    alias: [{ find: /^vscode$/, replacement: new URL("./src/vscodeStub.ts", import.meta.url).pathname }],
  },
  test: {
    // `.vscode-test/` is where `@vscode/test-electron` downloads a real VS Code
    // build for `npm run test:integration`. That tree ships VS Code's OWN
    // `*.test.mts` files, which vitest's default glob happily picks up and then
    // fails on ("No test suite found") — so running the integration suite once
    // would break every later `npm test`. Exclude it, plus vitest's own defaults
    // (which are replaced, not merged, when this option is set).
    exclude: ["**/node_modules/**", "**/dist/**", "**/.vscode-test/**", "**/.{idea,git,cache,output,temp}/**"],
  },
});
