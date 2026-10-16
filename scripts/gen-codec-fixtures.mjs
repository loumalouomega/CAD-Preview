/**
 * Regenerates `examples/VTKXML/cube-zstd.vtu` and `examples/VTKXML/cube-lz4.vtu`
 * with meshio++'s own VTK XML writer: `examples/STL/cube.stl` is read into the
 * module's virtual filesystem and written once per block codec, so the two
 * fixtures are genuinely meshio++ output and exercise exactly the read path
 * the extension's bridge uses (`convertToStlBoundary`).
 *
 * Needs the FULL artifact (zstd/lz4 are linked only there — `hasZstd()` /
 * `hasLz4()` assert it) at the lockfile's `@meshioplusplus/wasm`; a lean
 * install refuses with the codec's build-flag name. The outputs are
 * committed: CI (Node 20) has no zstd in `node:zlib`, but it never needs one —
 * decompression happens inside the WASM. Run from the repo root:
 *
 *     node scripts/gen-codec-fixtures.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT = path.join(ROOT, "examples", "VTKXML");

const { loadMeshioPlusPlus } = await import(
  pathToFileURL(path.join(ROOT, "node_modules", "@meshioplusplus", "wasm", "src", "index.mjs")).href
);
const m = await loadMeshioPlusPlus({}, { variant: "seq", full: true });
if (!m.hasZstd() || !m.hasLz4()) {
  throw new Error("the installed @meshioplusplus/wasm is not the full artifact (hasZstd/hasLz4 false)");
}

fs.mkdirSync(OUT, { recursive: true });
m.FS.writeFile("/cube.stl", fs.readFileSync(path.join(ROOT, "examples", "STL", "cube.stl")));
const mesh = m.readMesh("/cube.stl", "stl");

for (const codec of ["zstd", "lz4"]) {
  m.writeMesh("/cube.vtu", mesh, "vtu", { encoding: "binary", codec });
  const bytes = m.FS.readFile("/cube.vtu");
  const header = Buffer.from(bytes.slice(0, 600)).toString("latin1");
  const marker = codec === "zstd" ? "vtkZSTDDataCompressor" : "vtkLZ4DataCompressor";
  if (!header.includes(marker)) throw new Error(`/cube.vtu (${codec}): header does not name ${marker}`);
  const out = path.join(OUT, `cube-${codec}.vtu`);
  fs.writeFileSync(out, bytes);
  console.log(`${out}: ${bytes.length} bytes, ${marker}`);
}
