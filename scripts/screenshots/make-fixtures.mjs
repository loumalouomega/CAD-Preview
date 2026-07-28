/**
 * Bundles `fixtures-entry.ts` (which imports the real OCCT/Gmsh host modules)
 * to a Node CJS file and runs it, producing the JSON message fixtures under
 * `fixtures/` that `capture.mjs` posts into the webview.
 *
 * Mirrors `esbuild.mjs`'s extension-host config: `vscode` is external (never
 * hit by these modules) and the opencascade.js `.wasm` import is stubbed to a
 * runtime path — but OCCT/Gmsh actually read the WASM binaries from
 * `<root>/dist/*.wasm` via `fs`, so `npm run build` must have populated `dist/`
 * first (the `docs:screenshots` npm script chains `build` ahead of this).
 */
import * as esbuild from "esbuild";
import { spawnSync } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(HERE, ".build", "fixtures-entry.cjs");

const wasmPathPlugin = {
  name: "wasm-path",
  setup(build) {
    build.onLoad({ filter: /\.wasm$/ }, () => ({
      contents: `module.exports = require("path").join(__dirname, "opencascade.wasm.wasm");`,
      loader: "js",
    }));
  },
};

await esbuild.build({
  entryPoints: [path.join(HERE, "fixtures-entry.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile,
  // This entry imports gmshService.ts (for the FE-mesh overlay fixture), so it
  // needs the same external-ize-gmsh-wasm fix esbuild.mjs's extension/mcp
  // configs already document: @loumalouomega/gmsh-wasm's Emscripten pthread
  // bootstrap has a top-level `await import('worker_threads')` in its .mjs
  // build that this "cjs" output format cannot represent.
  external: ["vscode", "@loumalouomega/gmsh-wasm"],
  plugins: [wasmPathPlugin],
  banner: { js: `const import_meta_url = require("url").pathToFileURL(__filename).href;` },
  define: { "import.meta.url": "import_meta_url" },
  logLevel: "warning",
});

const res = spawnSync(process.execPath, [outfile], { stdio: "inherit" });
process.exit(res.status ?? 1);
