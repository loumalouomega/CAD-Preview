// Regenerates the VRML fixtures in examples/VRML/:
//   cube.wrl         10 x 10 x 10 cube as one IndexedFaceSet of 6 quads (12 triangles)
//   cube-colour.wrl  the same cube with a red diffuseColor Material
//   cube-twice.wrl   DEF/USE: one Shape defined once, placed twice (Transform translation)
//
//   node scripts/vrml-fixtures/make-wrl.mjs
//
// Nothing is hand-edited; change this script and regenerate.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(ROOT, "examples", "VRML");

const V = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
// Outward-wound (counter-clockwise seen from outside) quads.
const QUADS = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];

const shape = (appearance) => `Shape {
  ${appearance}
  geometry IndexedFaceSet {
    solid TRUE
    coord Coordinate { point [ ${V.map((v) => v.map((c) => c * 10).join(" ")).join(", ")} ] }
    coordIndex [ ${QUADS.map((q) => `${q.join(" ")} -1`).join(", ")} ]
  }
}`;

const header = "#VRML V2.0 utf8\n";
const files = {
  "cube.wrl": `${header}${shape("")}\n`,
  "cube-colour.wrl": `${header}${shape("appearance Appearance { material Material { diffuseColor 1 0 0 } }")}\n`,
  "cube-twice.wrl": `${header}DEF Cube ${shape("")}\nTransform {\n  translation 20 0 0\n  children [ USE Cube ]\n}\n`,
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), text);
console.log(`wrote ${Object.keys(files).length} files to ${path.relative(ROOT, OUT)}`);
