/**
 * The single Node/CJS esbuild recipe every bundle that reaches the WASM
 * kernels shares: `esbuild.mjs`'s extension / MCP-server / kernel-worker
 * configs, `scripts/screenshots/make-fixtures.mjs`, and `scripts/probe/run.mjs`.
 *
 * It lives here, not inline in each script, because the `external` list has
 * already drifted once: `float-tetwild-wasm` joined `esbuild.mjs`'s arrays but
 * not `make-fixtures.mjs`'s hand-copied one, and `npm run docs:screenshots`
 * then failed with "Top-level await is currently not supported with the cjs
 * output format" — unnoticed until the pipeline was next run by hand. The WHY
 * of each external entry is documented beside `extensionConfig` in
 * `esbuild.mjs`; the list itself is defined once, here.
 *
 * Pure: importing this module builds nothing.
 */

import * as fs from "fs";

/** Intercepts opencascade.js's `.wasm` import and returns a CJS stub that
 *  resolves the binary beside the bundle at runtime (`dist/` in production).
 *  OCCT/Gmsh actually read their binaries via `fs` from
 *  `<extensionPath>/dist/*.wasm`, so the stub's path is only a formality for
 *  the scripts that bundle elsewhere. */
export const wasmPathPlugin = {
  name: "wasm-path",
  setup(build) {
    build.onLoad({ filter: /\.wasm$/ }, () => ({
      contents: `module.exports = require("path").join(__dirname, "opencascade.wasm.wasm");`,
      loader: "js",
    }));
  },
};

/** Packages that must never be inlined into a Node/CJS bundle (see the long
 *  comment beside `extensionConfig` in `esbuild.mjs` for each one's reason).
 *  The extension bundle adds `node-hid` on top — native, extension-only. */
export const WASM_EXTERNALS = Object.freeze([
  "vscode",
  "@loumalouomega/gmsh-wasm",
  "@meshioplusplus/wasm",
  "float-tetwild-wasm",
  "playwright",
]);

/** Restores a real `import.meta.url` inside a CJS bundle: esbuild's ESM→CJS
 *  conversion stubs `import.meta` out, and bundled Emscripten glue reads it to
 *  locate its own directory. */
export const IMPORT_META_URL_BANNER = `const import_meta_url = require("url").pathToFileURL(__filename).href;`;
export const IMPORT_META_URL_DEFINE = Object.freeze({ "import.meta.url": "import_meta_url" });

/** A complete Node/CJS build options object for a script-side bundle
 *  (fixtures, probes). `extra` is shallow-merged last. */
export function nodeCjsBase(extra = {}) {
  return {
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    external: [...WASM_EXTERNALS],
    plugins: [wasmPathPlugin],
    banner: { js: IMPORT_META_URL_BANNER },
    define: { ...IMPORT_META_URL_DEFINE },
    logLevel: "warning",
    ...extra,
  };
}

/** Exact installed kernel package versions, as the `__KERNEL_VERSIONS__`
 *  define value `src/kernelVersions.ts` reads. Read from the INSTALLED
 *  packages (the declared ranges in package.json are not what shipped), so a
 *  handoff manifest — or a probe write-up — records what actually ran. */
export function kernelVersions() {
  const read = (name) => {
    try {
      return JSON.parse(fs.readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8")).version;
    } catch {
      return null;
    }
  };
  return {
    "opencascade.js": read("opencascade.js"),
    "@loumalouomega/gmsh-wasm": read("@loumalouomega/gmsh-wasm"),
    "@meshioplusplus/wasm": read("@meshioplusplus/wasm"),
    "float-tetwild-wasm": read("float-tetwild-wasm"),
  };
}

/** `kernelVersions()` encoded for an esbuild `define` entry. */
export function kernelVersionsDefine() {
  return JSON.stringify(JSON.stringify(kernelVersions()));
}
