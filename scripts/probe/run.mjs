/**
 * Runs a TypeScript probe against the REAL OCCT / Gmsh / meshio++ / fTetWild
 * WASM kernels:
 *
 *   npm run probe -- scripts/probe/examples/bull-counts.ts [probe args…]
 *   node scripts/probe/run.mjs [--no-build] <entry.ts> [probe args…]
 *
 * Bundles <entry.ts> with the shared Node/CJS recipe (scripts/nodeBundleConfig.mjs
 * — the same one esbuild.mjs uses, so a probe can never drift from the shipped
 * bundles) to scripts/probe/.build/, then runs it with cwd = the repo root, so
 * a probe passes `process.cwd()` as `extensionPath` and the kernels read their
 * binaries from `dist/*.wasm`. Unless --no-build, `esbuild.mjs` runs first so
 * those binaries exist and match the current sources.
 *
 * The child is spawned with `process.execPath` and the environment INHERITED
 * unchanged — deliberately NOT deleting ELECTRON_RUN_AS_NODE (unlike
 * test/integration/run.mjs, which must). Under the Flatpak recipe in
 * doc/development.md, execPath is VS Code's Electron and that variable is the
 * only thing making it behave as Node.
 *
 * See scripts/probe/README.md for the probe protocol and where write-ups go.
 */
import * as esbuild from "esbuild";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { nodeCjsBase, kernelVersionsDefine } from "../nodeBundleConfig.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

const args = process.argv.slice(2);
let build = true;
if (args[0] === "--no-build") {
  build = false;
  args.shift();
}
const entryArg = args.shift();
if (!entryArg || !/\.(ts|mts|js|mjs)$/.test(entryArg)) {
  console.error("usage: node scripts/probe/run.mjs [--no-build] <entry.ts> [probe args…]");
  process.exit(2);
}
const entry = path.resolve(process.cwd(), entryArg);
if (!fs.existsSync(entry)) {
  console.error(`probe entry not found: ${entry}`);
  process.exit(2);
}

if (build) {
  const res = spawnSync(process.execPath, [path.join(ROOT, "esbuild.mjs")], { cwd: ROOT, stdio: "inherit" });
  if (res.status !== 0) process.exit(res.status ?? 1);
} else if (!fs.existsSync(path.join(ROOT, "dist", "opencascade.wasm.wasm"))) {
  console.error("dist/opencascade.wasm.wasm is missing — run without --no-build (or `node esbuild.mjs`) first.");
  process.exit(2);
}

const outfile = path.join(HERE, ".build", `${path.basename(entry).replace(/\.[^.]+$/, "")}.cjs`);
await esbuild.build(
  nodeCjsBase({
    entryPoints: [entry],
    outfile,
    // Inline so a thrown error's stack points at the probe's own .ts lines.
    sourcemap: "inline",
    define: {
      ...nodeCjsBase().define,
      __KERNEL_VERSIONS__: kernelVersionsDefine(),
    },
  }),
);

const res = spawnSync(process.execPath, ["--enable-source-maps", outfile, ...args], {
  cwd: ROOT,
  stdio: "inherit",
  env: process.env,
});
if (res.error) {
  console.error(res.error);
  process.exit(1);
}
process.exit(res.status ?? 1);
