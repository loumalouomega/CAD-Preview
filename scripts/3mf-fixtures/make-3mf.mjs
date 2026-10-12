// Regenerates examples/3MF/cube.3mf (a 10 mm cube, unit="millimeter") and
// examples/3MF/cube-inch.3mf (the same idea as a 1 inch cube, unit="inch")
// with the SAME writer the viewer's Export uses (src/threeMf.ts), so the
// committed bytes are exactly what the exporter produces.
//
//   node scripts/3mf-fixtures/make-3mf.mjs
//
// Neither fixture is hand-edited; change this script and regenerate.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(ROOT, "examples", "3MF");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "3mf-fixtures-"));
const bundle = path.join(tmp, "threeMf.mjs");
await build({ entryPoints: [path.join(ROOT, "src", "threeMf.ts")], bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent" });
const { build3mf } = await import(pathToFileURL(bundle).href);

/** Outward-wound (counter-clockwise from outside) unit cube scaled by `s`. */
function cube(s) {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const positions = v.flatMap((p) => p.map((c) => c * s));
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { name: "cube", positions, indices };
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "cube.3mf"), build3mf([cube(10)], "mm"));
fs.writeFileSync(path.join(OUT, "cube-inch.3mf"), build3mf([cube(1)], "in"));
fs.rmSync(tmp, { recursive: true, force: true });
console.log("wrote examples/3MF/cube.3mf and cube-inch.3mf");
