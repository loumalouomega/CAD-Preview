/**
 * Regenerates `examples/libMesh/two-tets.{xda,xdr,xda.gz,xda.bz2}` with
 * meshio++'s own libMesh writer (@meshioplusplus/wasm 17.2.0+). The mesh is
 * two tetrahedra sharing the face (1,2,3) — the same shape class as the MED
 * fixture, so the boundary-conversion expectations are known: 5 points in,
 * 8 boundary triangles out.
 *
 * Every flavour is read straight back by extension sniffing (no explicit
 * format) so the fixtures pin the read side at generation time, not just the
 * write side; the compressed flavours additionally assert their container
 * magic. The `.bz2` flavour requires the FULL artifact's bzip2 (a lean
 * install throws naming the build flag — exactly the behavior the corpus
 * documents). Outputs are committed; CI never runs this. From the repo root:
 *
 *     node scripts/gen-libmesh-fixtures.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT = path.join(ROOT, "examples", "libMesh");

const { loadMeshioPlusPlus } = await import(
  pathToFileURL(path.join(ROOT, "node_modules", "@meshioplusplus", "wasm", "src", "index.mjs")).href
);
const m = await loadMeshioPlusPlus({}, { variant: "seq", full: true });

const twoTets = {
  points: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]),
  dim: 3,
  cells: [
    { type: "tetra", data: new Int32Array([0, 1, 2, 3]), nodesPerCell: 4 },
    { type: "tetra", data: new Int32Array([1, 2, 3, 4]), nodesPerCell: 4 },
  ],
};

const FLAVOURS = ["xda", "xdr", "xda.gz", "xda.bz2"];
fs.mkdirSync(OUT, { recursive: true });
for (const flavour of FLAVOURS) {
  const memfsPath = `/two-tets.${flavour}`;
  m.writeMesh(memfsPath, twoTets, "libmesh");
  const bytes = m.FS.readFile(memfsPath);
  if (flavour === "xda.bz2") {
    if (String.fromCharCode(bytes[0], bytes[1], bytes[2]) !== "BZh") throw new Error(`two-tets.${flavour}: missing BZh magic`);
  } else if (flavour === "xda.gz") {
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error(`two-tets.${flavour}: missing gzip magic`);
  }
  // Read straight back by extension sniffing — pins the READ side, not just
  // the write side, for each committed flavour. meshio++ groups same-type
  // cells into one block, so the two tets come back as one `tetra` block
  // holding both.
  const back = m.readMesh(memfsPath);
  const cells = back.cells.map((c) => c.type);
  if (JSON.stringify(cells) !== JSON.stringify(["tetra"])) throw new Error(`two-tets.${flavour}: read back as ${cells}`);
  if (back.cells[0].data.length !== 8) throw new Error(`two-tets.${flavour}: read back with ${back.cells[0].data.length} cell nodes, expected 8 (2 tets)`);
  if (back.points.length !== 15) throw new Error(`two-tets.${flavour}: read back with ${back.points.length / 3} points, expected 5`);
  const out = path.join(OUT, `two-tets.${flavour}`);
  fs.writeFileSync(out, bytes);
  console.log(`${out}: ${bytes.length} bytes, 2 tetra / 5 points round-tripped`);
}
