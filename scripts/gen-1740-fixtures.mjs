/**
 * Regenerates `examples/Nastran/two-tets.op2` — the Nastran OP2 result-writer
 * fixture for meshio++ 17.4.0 (PR #164; CVISC dampers #165), adopted with the
 * 17.7.0 bump. Same two-tets shape as every result-format fixture (two
 * tetrahedra sharing the face (1,2,3): 5 points in, 8 boundary triangles
 * out), so the pin stays comparable across the family. meshio++'s own writer
 * produced the committed file (the repo's fixture rule); output is committed,
 * CI never runs this. From the repo root:
 *
 *     node scripts/gen-1740-fixtures.mjs
 *
 * The file is read straight back under the EXACT format string the extension
 * routes it as (`EXTENSION_MAP`'s `op2` entry → `nastran_op2` — the read side
 * is pinned against the bridge's call, not extension sniffing): the two tets
 * come back as one merged `tetra` block holding 8 cell nodes over 5 points
 * (results-file writers merge blocks per cell type), with the reader's
 * `nastran:*` cell-data columns present.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

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

// [extension, meshio++ format string, examples directory].
const ROWS = [["op2", "nastran_op2", "Nastran"]];

for (const [ext, format, dir] of ROWS) {
  const memfsPath = `/two-tets.${ext}`;
  m.writeMesh(memfsPath, twoTets, format);
  const bytes = m.FS.readFile(memfsPath);
  if (!(bytes.length > 0)) throw new Error(`two-tets.${ext}: empty output from ${format}`);
  const back = m.readMesh(memfsPath, format);
  const cells = back.cells.map((c) => c.type);
  if (!cells.every((t) => t === "tetra") || cells.length === 0) throw new Error(`two-tets.${ext}: read back as [${cells}]`);
  const cellNodes = back.cells.reduce((n, c) => n + c.data.length, 0);
  if (cellNodes !== 8) throw new Error(`two-tets.${ext}: ${cellNodes} cell nodes, expected 8 (2 tets)`);
  if (back.points.length !== 15) throw new Error(`two-tets.${ext}: ${back.points.length / 3} points, expected 5`);
  const cellData = Object.keys(back.cell_data ?? {});
  for (const key of ["nastran:card", "nastran:eid", "nastran:pid"]) {
    if (!cellData.includes(key)) throw new Error(`two-tets.${ext}: reader cell data lacks ${key} (got [${cellData}])`);
  }
  const out = path.join(ROOT, "examples", dir, `two-tets.${ext}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bytes);
  console.log(`${out}: ${bytes.length} bytes, 2 tetra / 5 points round-tripped via ${format} (${cells.join("/")})`);
}
