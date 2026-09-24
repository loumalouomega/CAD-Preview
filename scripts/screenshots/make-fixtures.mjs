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
import { nodeCjsBase } from "../nodeBundleConfig.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(HERE, ".build", "fixtures-entry.cjs");

// The wasm-path plugin, `external` list and import.meta.url shim come from the
// shared scripts/nodeBundleConfig.mjs, which esbuild.mjs also uses. This script
// used to hand-copy that list and it fell behind once: `float-tetwild-wasm`
// joined gmshService.ts's import graph, nothing here listed it, and all of
// `npm run docs:screenshots` failed with "Top-level await is currently not
// supported with the cjs output format" until the pipeline was next run.
await esbuild.build(nodeCjsBase({
  entryPoints: [path.join(HERE, "fixtures-entry.ts")],
  outfile,
}));

const res = spawnSync(process.execPath, [outfile], { stdio: "inherit" });
process.exit(res.status ?? 1);
