import { defineConfig } from "vitest/config";

export default defineConfig({
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
