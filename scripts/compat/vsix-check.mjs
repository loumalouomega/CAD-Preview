/**
 * Packaged-VSIX runtime-file check (`npm run compat:vsix [path.vsix]`).
 *
 * A clean `npm ci` says nothing about what actually ships: the kernels are
 * loaded from real files the loaders resolve at runtime (meshio++ and
 * fTetWild self-locate via `import.meta.url`; gmsh-wasm and OCCT read
 * `dist/*.wasm`), and `.vscodeignore` carves exactly those files back in.
 * This asserts the packaged archive contains every carved-back file plus the
 * built bundles and data dirs, and none of what must never ship.
 *
 * Required files combine `.vscodeignore` re-includes with the shared staged
 * runtime inventory, so accidentally deleting a carve-out cannot silently
 * remove a kernel asset. Other bundles/data are listed below.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { stagedRuntimeFiles } from "../runtimeAssets.mjs";
import { unzipSync } from "fflate";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const vsix = path.resolve(process.argv[2] ?? path.join(ROOT, "cad-preview.vsix"));
if (!fs.existsSync(vsix)) {
  console.error(`✗ ${vsix} not found — run \`npm run package -- --out cad-preview.vsix\` first.`);
  process.exit(1);
}

const entries = new Set(
  listNames(fs.readFileSync(vsix))
    .filter((n) => n.startsWith("extension/"))
    .map((n) => n.slice("extension/".length))
);

/** Central-directory filenames without inflating anything (unzipSync's
 * filter is called per entry with its name; we collect and reject all). */
function listNames(bytes) {
  const names = [];
  unzipSync(new Uint8Array(bytes), {
    filter: (f) => {
      names.push(f.name);
      return false;
    },
  });
  return names;
}

const carveOuts = fs
  .readFileSync(path.join(ROOT, ".vscodeignore"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("!") && !l.includes("*"))
  .map((l) => l.slice(1));

const required = [...new Set([
  "package.json",
  "dist/extension.js",
  "dist/mcp-server.js",
  "dist/kernel-worker.js",
  "dist/opencascade.wasm.wasm",
  "dist/gmsh-core.wasm",
  "dist/macros/starter-library.json",
  "dist/mesh-presets/starter-presets.json",
  "dist/sheet-templates/starter-templates.json",
  "media/viewer.js",
  "media/viewer.css",
  ...carveOuts,
  ...stagedRuntimeFiles,
])];

const forbidden = [
  /^src\//,
  /^dist\/meshio\/dist\/meshioplusplus_wasm_mt\./,
  /^node_modules\/(?:@meshioplusplus\/wasm|float-tetwild-wasm)\//,
  /^examples\//,
  /^scripts\//,
  /^doc\//,
  /\.ts$/,
  /\.map$/,
  /^node_modules\/@meshioplusplus\/wasm\/dist\/meshioplusplus_wasm_mt\./,
];

const missing = required.filter((f) => !entries.has(f));
const requiredSet = new Set(required);
const leaked = [...entries].filter(
  (f) =>
    (forbidden.some((re) => re.test(f)) && !f.endsWith(".d.ts")) ||
    // Any node_modules file not explicitly carved back in is a leak (a stray
    // local tool dir once shipped 1194 files this way).
    (f.includes("node_modules/") && !requiredSet.has(f) && !f.endsWith(".d.ts"))
);

console.log(`VSIX ${path.basename(vsix)}: ${entries.size} files, ${required.length} required (${carveOuts.length} from .vscodeignore carve-outs)`);
for (const f of missing) console.log(`✗ missing ${f}`);
for (const f of leaked) console.log(`✗ must not ship ${f}`);
if (missing.length || leaked.length) process.exit(1);
console.log("✓ every runtime file the loaders resolve is packaged, nothing forbidden leaked");
