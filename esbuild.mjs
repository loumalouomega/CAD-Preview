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
 *  so esbuild converts its ESM to CJS. `vscode` stays external.
 *
 *  `banner` + `define` restore a real `import.meta.url` for bundled ESM deps.
 *  esbuild's ESM→CJS conversion replaces `import.meta` with an empty stub
 *  object, so any bundled code that reads `import.meta.url` (e.g.
 *  @loumalouomega/gmsh-wasm's emscripten-generated gmsh-core.mjs, which uses
 *  it to locate its own script directory under Node) gets `undefined` and
 *  throws. This is esbuild's documented workaround: inject a real file URL
 *  for the bundle's own location, and substitute every `import.meta.url`
 *  reference in the bundle (including inside third-party deps) with it.
 *  opencascade.js has no `import.meta` references, so this is a no-op there. */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "dist/extension.js",
  external: ["vscode"],
  plugins: [wasmPathPlugin],
  banner: {
    js: `const import_meta_url = require("url").pathToFileURL(__filename).href;`,
  },
  define: {
    "import.meta.url": "import_meta_url",
  },
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

/** Copy the WASM binaries to dist/ so they ship with the packaged extension. */
function copyWasm() {
  const binaries = [
    ["node_modules/opencascade.js/dist/opencascade.wasm.wasm", "dist/opencascade.wasm.wasm"],
    ["node_modules/@loumalouomega/gmsh-wasm/dist/gmsh-core.wasm", "dist/gmsh-core.wasm"],
  ];
  for (const [srcRel, dstRel] of binaries) {
    const src = path.join(__dirname, srcRel);
    const dst = path.join(__dirname, dstRel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    console.log(`Copied ${srcRel.split("/").pop()} → ${dstRel} (${(fs.statSync(dst).size / 1e6).toFixed(1)} MB)`);
  }
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
