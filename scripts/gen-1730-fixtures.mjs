/**
 * Regenerates `examples/<dir>/two-tets.<ext>` for the six formats meshio++
 * 17.3.0 newly learned to WRITE (PR #163) plus Medit's binary flavour — the
 * same two-tets shape the libMesh fixtures use (two tetrahedra sharing the
 * face (1,2,3): 5 points in, 8 boundary triangles out), so every fixture is
 * pinned against the same shape class. meshio++'s own writer produced every
 * committed file (the repo's fixture rule); outputs are committed, CI never
 * runs this. From the repo root:
 *
 *     node scripts/gen-1730-fixtures.mjs
 *
 * Each file is read straight back under the EXACT format string the
 * extension routes it as (`EXTENSION_MAP`'s value — the read side is pinned
 * against the bridge's call, not extension sniffing): the two tets come back
 * as one `tetra` block holding 8 cell nodes over 5 points. What the six
 * writers refuse — szplt/vtx (this build has no TecIO/ADIOS2; convert
 * refuses by name) and the pipeline's codec whitelist ('none', 'zlib',
 * 'lz4', 'zstd' or 'lzf', NOT lzma) — is asserted too so a build change
 * that un-refuses them fails here and gets re-adopted with fixtures instead
 * of slipping silently.
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

/** [extension key, meshio++ format string, examples directory]. */
const ROWS = [
  ["plt", "tecplot", "Tecplot"],
  ["xplt", "xplt", "FEBio"],
  ["meshb", "medit", "Medit"],
  ["t19", "marc_t19", "Marc"],
  ["fil", "abaqus_fil", "AbaqusFIL"],
  ["rst", "ansys_rst", "AnsysRST"],
  ["d3plot", "lsdyna_d3plot", "LsDyna"],
];

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
  const out = path.join(ROOT, "examples", dir, `two-tets.${ext}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bytes);
  console.log(`${out}: ${bytes.length} bytes, 2 tetra / 5 points round-tripped via ${format} (${cells.join("/")})`);
}

// The build-refusal pins, recorded where a fixture generator belongs: the two
// formats whose writer needs a library this build does not link, and the
// codec this build's own pipeline whitelist lacks. When one of these stops
// failing, the build gained the capability — add its row above with fixtures.
for (const [format, expectedText] of [
  ["szplt", "no TecIO support"],
  ["vtx", "no ADIOS2 support"],
]) {
  let refused = null;
  try {
    m.convert("/two-tets.xda", `/out-${format}.bin`, { inFormat: "libmesh", outFormat: format });
  } catch (error) {
    refused = String(error);
  }
  // szplt/vtx read binary+ADIOS2 outputs that no earlier row provides; feed a
  // read-only source path — the conversion is refused on the OUT format before
  // any reading happens, so a bogus input path stays safe.
  if (!refused || !refused.includes(expectedText)) {
    throw new Error(`${format}: expected refusal naming "${expectedText}", got ${refused ?? "success"}`);
  }
  console.log(`${format}: refused as expected (${refused.split("\n")[0].slice(0, 90)})`);
}
