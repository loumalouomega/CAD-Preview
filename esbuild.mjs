import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

/**
 * Plugin: intercepts `.wasm` file imports from opencascade.js/index.js and
 * returns a CJS module that resolves the WASM path relative to __dirname at
 * runtime (i.e. the `dist/` folder where we copy the WASM file).
 */
const wasmPathPlugin = {
  name: "wasm-path",
  setup(build) {
    build.onLoad({ filter: /\.wasm$/ }, () => ({
      contents: `module.exports = require("path").join(__dirname, "opencascade.wasm.wasm");`,
      loader: "js",
    }));
  },
};

/** Extension host bundle: Node/CJS.  opencascade.js is bundled (not external)
 *  so esbuild converts its ESM to CJS. `vscode` stays external. */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "dist/extension.js",
  external: ["vscode"],
  plugins: [wasmPathPlugin],
  sourcemap: true,
  logLevel: "info",
};

/** Webview bundle: browser/IIFE, Three.js bundled in.  No OCCT here. */
const webviewConfig = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2020",
  outfile: "media/viewer.js",
  sourcemap: true,
  logLevel: "info",
};

/** Copy the WASM binary to dist/ so it ships with the packaged extension. */
function copyWasm() {
  const src = path.join(
    __dirname,
    "node_modules/opencascade.js/dist/opencascade.wasm.wasm"
  );
  const dst = path.join(__dirname, "dist/opencascade.wasm.wasm");
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`Copied opencascade.wasm.wasm → dist/ (${(fs.statSync(dst).size / 1e6).toFixed(1)} MB)`);
}

if (watch) {
  const ctxExt = await esbuild.context(extensionConfig);
  const ctxWv = await esbuild.context(webviewConfig);
  await Promise.all([ctxExt.watch(), ctxWv.watch()]);
  copyWasm();
  console.log("esbuild: watching…");
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(webviewConfig),
  ]);
  copyWasm();
}
