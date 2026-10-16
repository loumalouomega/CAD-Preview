/**
 * Regenerates `examples/CadJson/cube.cad.json` — a Kratos CAD JSON NURBS
 * B-rep of the STL cube, built by meshio++ itself: the FULL artifact's
 * `fitCad` turns `examples/STL/cube.stl`'s six plane patches into an exact
 * analytic solid, and the solid's `info` side channel is written back as CAD
 * JSON (the `iga_*` tools' input format). The script also prints the facts
 * `npm run mcp:smoke` and the corpus rows pin (plain-read cell inventory,
 * `igaSample`'s defaults, a `igaRefine(elevate 1, subdivisions 1)` round and
 * one `igaEvaluate` point), so the assertions stay derived from the live
 * module rather than guessed. Outputs are committed; from the repo root:
 *
 *     node scripts/gen-cadjson-fixtures.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT = path.join(ROOT, "examples", "CadJson");

const { loadMeshioPlusPlus } = await import(
  pathToFileURL(path.join(ROOT, "node_modules", "@meshioplusplus", "wasm", "src", "index.mjs")).href
);
const m = await loadMeshioPlusPlus({}, { variant: "seq", full: true });
if (!m.hasOcct()) throw new Error("the installed @meshioplusplus/wasm is not the full artifact (hasOcct false)");

m.FS.writeFile("/cube.stl", fs.readFileSync(path.join(ROOT, "examples", "STL", "cube.stl")));
const skin = m.readMesh("/cube.stl");
const fitted = m.fitPrimitives(m.segment(skin).mesh).mesh;
const fit = m.fitCad(fitted);
if (!fit.valid) throw new Error("fitCad on the STL cube did not produce a valid solid");

fs.mkdirSync(OUT, { recursive: true });
m.writeMesh("/cube.cad.json", fit.mesh, "cad_json", { info: fit.info });
fs.writeFileSync(path.join(OUT, "cube.cad.json"), m.FS.readFile("/cube.cad.json"));

// The facts the smoke/corpus pin, straight from the live module.
const plain = m.readMesh("/cube.cad.json");
console.log(
  "plain readMesh cells:",
  plain.cells.map((c) => `${c.type}×${c.data.length / (c.nodesPerCell ?? 1)}`).join(", "),
  `points=${plain.points.length / 3}`
);
const sel = m.readMeshSelective("/cube.cad.json", { format: "cad_json", info: true });
const info = sel.info;
console.log(
  "info: faces", info.faces.length,
  "patches", info.patches.length,
  "edges", info.edges.length,
  "vertices", info.vertices.length,
  "breps", info.breps.length,
  "trimmed", info.faces.filter((f) => f.trimmed).length,
  "rational", info.faces.filter((f) => f.rational).length
);
const sampled = m.igaSample(info);
console.log(
  "igaSample(default):",
  sampled.mesh.cells.map((c) => `${c.type}×${c.data.length / (c.nodesPerCell ?? 1)}`).join(", "),
  `points=${sampled.mesh.points.length / 3}`
);
const fine = m.igaRefine(info, { elevate: 1, subdivisions: 1 });
console.log(
  "igaRefine(elevate 1, subdivisions 1):",
  fine.mesh.cells.map((c) => `${c.type}×${c.data.length / (c.nodesPerCell ?? 1)}`).join(", "),
  `points=${fine.mesh.points.length / 3}`,
  "degrees", JSON.stringify(fine.info.patches[0].degrees)
);
const ev = m.igaEvaluate(info, 0, [0.5, 0.5], { derivatives: 1 });
console.log(
  "igaEvaluate(face 0, uv [0.5,0.5], derivatives 1):",
  "spaceDim", ev.spaceDim,
  "points", Array.from(ev.points),
  "normals", Array.from(ev.normals ?? []).map((v) => Number(v.toFixed(6))),
  "inside", ev.inside ? Array.from(ev.inside) : undefined
);
console.log(`wrote ${path.join(OUT, "cube.cad.json")}`);
