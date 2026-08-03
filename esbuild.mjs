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
  // @loumalouomega/gmsh-wasm must NEVER be bundled — see the long comment in
  // gmshService.ts. Its Emscripten pthread pool spawns Node worker_threads
  // that re-execute whatever file they believe is their own script; bundled
  // into dist/extension.js, that's the whole VS Code extension, which crashes
  // every spawned worker on `require("vscode")` and hangs mesh generation
  // forever. Left external + shipped as real node_modules files (see the
  // `!node_modules/...` carve-out in .vscodeignore), its workers correctly
  // re-execute the real, standalone, vscode-free gmsh-core.cjs instead.
  // @meshioplusplus/wasm must ALSO stay external, for two reasons verified
  // against the live package (see meshioService.ts's long comment): it's
  // ESM-only with no `require` condition at all (unlike gmsh-wasm, which is
  // dual CJS/ESM — meshioService.ts loads it via a dynamic `await import()`,
  // not a static import, specifically because of this), and its threaded
  // build variant has the identical eager-worker-spawn risk gmsh-wasm's does
  // if ever bundled. `meshioService.ts` forces the sequential variant, so
  // that risk is avoided regardless, but staying external is still required
  // for the ESM/CJS reason alone.
  // "playwright" joined this list once modelComparePanel.ts's visual-diff
  // feature (roadmap item, closed) started importing src/renderService.ts
  // directly — previously only mcpServer.ts (a separate bundle, see
  // mcpConfig below) ever reached it. Same reason as mcpConfig's own
  // "playwright" entry: it's a devDependency, dynamically `import()`ed by
  // renderService.ts, and must resolve via real node_modules at runtime (or
  // fail gracefully, caught there) rather than getting inlined — inlining it
  // is what broke the build in the first place (playwright-core's own
  // optional chromium-bidi sub-dependency isn't resolvable by esbuild).
  external: ["vscode", "@loumalouomega/gmsh-wasm", "@meshioplusplus/wasm", "playwright"],
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

/** MCP server bundle: same Node/CJS recipe as the extension host (it reuses
 *  the exact same OCCT/GMSH pipeline modules, so it needs the same wasm-path
 *  plugin and `import.meta.url` restoration), but entered from the stdio
 *  server instead of `activate()`. Ships to `dist/` so the WASM binaries
 *  copied by `copyWasm()` sit beside it. */
const mcpConfig = {
  entryPoints: ["src/mcpServer.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "dist/mcp-server.js",
  // See the matching comment in extensionConfig above (both gmsh-wasm and
  // @meshioplusplus/wasm). "playwright" is a devDependency, dynamically
  // `import()`ed by src/renderService.ts for the render_snapshot MCP tool —
  // it must resolve via real node_modules at runtime (or fail gracefully,
  // caught there), never get inlined into the bundle.
  external: ["vscode", "@loumalouomega/gmsh-wasm", "@meshioplusplus/wasm", "playwright"],
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

/** Kernel-worker bundle: the child-process entry for the OCCT/Gmsh/meshio++
 *  fault-isolation work (roadmap "OCCT in a forked child process", Phase
 *  0+1 — see CLAUDE.md). Same Node/CJS recipe as mcpConfig (it bundles the
 *  identical pipeline modules), forked by `kernelClient.ts` rather than
 *  invoked as its own top-level process. Ships to `dist/` so `copyWasm()`'s
 *  binaries sit beside it too. */
const kernelConfig = {
  entryPoints: ["src/kernelWorker.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "dist/kernel-worker.js",
  // See the matching comment in extensionConfig/mcpConfig above.
  external: ["vscode", "@loumalouomega/gmsh-wasm", "@meshioplusplus/wasm", "playwright"],
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
  const ctxMcp = await esbuild.context(mcpConfig);
  const ctxKernel = await esbuild.context(kernelConfig);
  const ctxWv = await esbuild.context(webviewConfig);
  await Promise.all([ctxExt.watch(), ctxMcp.watch(), ctxKernel.watch(), ctxWv.watch()]);
  copyWasm();
  console.log("esbuild: watching…");
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(mcpConfig),
    esbuild.build(kernelConfig),
    esbuild.build(webviewConfig),
  ]);
  copyWasm();
}
