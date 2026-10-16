// Regenerates the AMF fixtures in examples/AMF/:
//   cube.amf         10 mm cube, unit="millimeter", no material
//   cube-inch.amf    a 1 inch cube (unit="inch"); must measure 25.4 mm
//   cube-colour.amf  the 10 mm cube with a red <material> bound to its volume
//   cube-zip.amf     cube.amf, zipped (AMF's compressed container: a ZIP holding one .amf)
//
//   node scripts/amf-fixtures/make-amf.mjs
//
// Nothing is hand-edited; change this script and regenerate. The files are
// plain AMF 1.1 text: one object, one mesh, one volume of 12 outward-wound
// triangles over 8 vertices.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(ROOT, "examples", "AMF");

const V = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const IDX = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];

function amf({ scale, unit, colour }) {
  const verts = V.map(
    (p) => `        <vertex><coordinates><x>${p[0] * scale}</x><y>${p[1] * scale}</y><z>${p[2] * scale}</z></coordinates></vertex>`
  ).join("\n");
  const tris = [];
  for (let i = 0; i < IDX.length; i += 3)
    tris.push(`        <triangle><v1>${IDX[i]}</v1><v2>${IDX[i + 1]}</v2><v3>${IDX[i + 2]}</v3></triangle>`);
  const material = colour
    ? `  <material id="1">
    <metadata type="name">red</metadata>
    <color><r>${colour[0]}</r><g>${colour[1]}</g><b>${colour[2]}</b></color>
  </material>
`
    : "";
  const volAttr = colour ? ' materialid="1"' : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<amf unit="${unit}" version="1.1">
  <metadata type="author">CAD-Preview scripts/amf-fixtures/make-amf.mjs</metadata>
${material}  <object id="0">
    <mesh>
      <vertices>
${verts}
      </vertices>
      <volume${volAttr}>
${tris.join("\n")}
      </volume>
    </mesh>
  </object>
</amf>
`;
}

fs.mkdirSync(OUT, { recursive: true });
const cube = amf({ scale: 10, unit: "millimeter" });
const files = {
  "cube.amf": cube,
  "cube-inch.amf": amf({ scale: 1, unit: "inch" }),
  "cube-colour.amf": amf({ scale: 10, unit: "millimeter", colour: [1, 0, 0] }),
  "cube-zip.amf": Buffer.from(zipSync({ "cube.amf": strToU8(cube) }, { mtime: new Date(Date.UTC(2020, 0, 1)) })),
};
for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), data);
console.log(`wrote ${Object.keys(files).map((n) => "examples/AMF/" + n).join(", ")}`);
