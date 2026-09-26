import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
// wasmPathPlugin, the shared `external` list and the import.meta.url shim live
// in scripts/nodeBundleConfig.mjs so the script-side bundles (screenshot
// fixtures, probes) can never drift from these configs again.
import {
  wasmPathPlugin,
  WASM_EXTERNALS,
  IMPORT_META_URL_BANNER,
  IMPORT_META_URL_DEFINE,
  kernelVersionsDefine,
} from "./scripts/nodeBundleConfig.mjs";

import { runtimePackages } from "./scripts/runtimeAssets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

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
// Exact installed kernel versions, stamped into the Node bundles as
// `__KERNEL_VERSIONS__` (read by `src/kernelVersions.ts`) — see
// kernelVersionsDefine() in scripts/nodeBundleConfig.mjs.
const KERNEL_VERSIONS_DEFINE = kernelVersionsDefine();

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
  // meshio++ and fTetWild use runtimePackage.ts's opaque native import.
  // Their ESM glue stays on disk, staged beside these bundles by copyWasm().
  // Keep them external as well for any future direct package imports.
  // "playwright" joined this list once modelComparePanel.ts's visual-diff
  // feature (roadmap item, closed) started importing src/renderService.ts
  // directly — previously only mcpServer.ts (a separate bundle, see
  // mcpConfig below) ever reached it. Same reason as mcpConfig's own
  // "playwright" entry: it's a devDependency, dynamically `import()`ed by
  // renderService.ts, and must resolve via real node_modules at runtime (or
  // fail gracefully, caught there) rather than getting inlined — inlining it
  // is what broke the build in the first place (playwright-core's own
  // optional chromium-bidi sub-dependency isn't resolvable by esbuild).
  // "node-hid" (src/spaceMouse.ts, the "Native 6-DOF SpaceMouse input" feature) is the fifth
  // external, on extensionConfig ONLY: a native NAPI addon (.node
  // prebuilds) that cannot bundle — esbuild would inline its JS loader
  // while leaving the .node binary behind, producing a bundle that
  // crashes on require. It is loaded via a lazy require() inside
  // connectSpaceMouse() (never top-level), so the extension activates
  // and runs fine where it is absent or unloadable. The MCP/kernel
  // bundles never import the HID path and need no entry.
  external: [...WASM_EXTERNALS, "node-hid"],
  plugins: [wasmPathPlugin],
  banner: { js: IMPORT_META_URL_BANNER },
  define: {
    ...IMPORT_META_URL_DEFINE,
    __KERNEL_VERSIONS__: KERNEL_VERSIONS_DEFINE,
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
  // See the matching comment in extensionConfig above (gmsh-wasm,
  // @meshioplusplus/wasm, and float-tetwild-wasm). "playwright" is a
  // devDependency, dynamically `import()`ed by src/renderService.ts for the
  // render_snapshot MCP tool — it must resolve via real node_modules at
  // runtime (or fail gracefully, caught there), never get inlined into the
  // bundle.
  external: [...WASM_EXTERNALS],
  plugins: [wasmPathPlugin],
  banner: { js: IMPORT_META_URL_BANNER },
  define: {
    ...IMPORT_META_URL_DEFINE,
    __KERNEL_VERSIONS__: KERNEL_VERSIONS_DEFINE,
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
  external: [...WASM_EXTERNALS],
  plugins: [wasmPathPlugin],
  banner: { js: IMPORT_META_URL_BANNER },
  define: {
    ...IMPORT_META_URL_DEFINE,
    __KERNEL_VERSIONS__: KERNEL_VERSIONS_DEFINE,
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
  for (const { name, directory, files } of runtimePackages) {
    const destination = path.join(__dirname, "dist", directory);
    fs.rmSync(destination, { recursive: true, force: true });
    for (const file of files) {
      const target = path.join(destination, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(__dirname, "node_modules", name, file), target);
    }
  }
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

/**
 * Copy the bundled starter macro library to dist/ so it ships with the
 * packaged extension AND is beside `dist/mcp-server.js` for headless use
 * (roadmap Tier 1 "A bundled starter macro library"). Same recipe as
 * `copyWasm()` above — a real file on disk, resolved at runtime via
 * `starterMacros.ts`'s `bundledMacrosPath(extensionPath)`, never bundled
 * into the JS (it is data an agent/panel reads as JSON, and bundling it
 * would fork a second copy that could drift from the reviewed source).
 */
function copyMacros() {
  const src = path.join(__dirname, "macros", "starter-library.json");
  const dst = path.join(__dirname, "dist", "macros", "starter-library.json");
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`Copied starter-library.json → dist/macros/starter-library.json (${(fs.statSync(dst).size / 1e3).toFixed(1)} KB)`);
}

/**
 * Copy the bundled starter meshing presets to dist/ so they ship with the
 * packaged extension AND are beside `dist/mcp-server.js` for headless use
 * (roadmap Tier 1 "Reusable meshing presets"). Same recipe as `copyMacros()`
 * above — data read as JSON at runtime, never bundled into the JS.
 */
function copyMeshPresets() {
  const src = path.join(__dirname, "mesh-presets", "starter-presets.json");
  const dst = path.join(__dirname, "dist", "mesh-presets", "starter-presets.json");
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`Copied starter-presets.json → dist/mesh-presets/starter-presets.json (${(fs.statSync(dst).size / 1e3).toFixed(1)} KB)`);
}

// Same for the bundled drawing-sheet templates (roadmap "Drawing-sheet
// settings and reusable templates"), resolved via `bundledSheetTemplatesPath`.
function copySheetTemplates() {
  const src = path.join(__dirname, "sheet-templates", "starter-templates.json");
  const dst = path.join(__dirname, "dist", "sheet-templates", "starter-templates.json");
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`Copied starter-templates.json → dist/sheet-templates/starter-templates.json (${(fs.statSync(dst).size / 1e3).toFixed(1)} KB)`);
}

if (watch) {
  const ctxExt = await esbuild.context(extensionConfig);
  const ctxMcp = await esbuild.context(mcpConfig);
  const ctxKernel = await esbuild.context(kernelConfig);
  const ctxWv = await esbuild.context(webviewConfig);
  await Promise.all([ctxExt.watch(), ctxMcp.watch(), ctxKernel.watch(), ctxWv.watch()]);
  copyWasm();
  copyMacros();
  copyMeshPresets();
  copySheetTemplates();
  console.log("esbuild: watching…");
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(mcpConfig),
    esbuild.build(kernelConfig),
    esbuild.build(webviewConfig),
  ]);
  copyWasm();
  copyMacros();
  copyMeshPresets();
  copySheetTemplates();
}
