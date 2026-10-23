// Regenerates the FBX fixtures in examples/FBX/ (ASCII FBX 7.4):
//   cube.fbx         10-unit cube, UnitScaleFactor 0.1 (millimetres), Y-up, no material: 10 mm
//   cube-cm.fbx      a 1-unit cube with the default UnitScaleFactor 1 (centimetres): must measure 10 mm
//   cube-zup.fbx     tall box 10 x 10 x 30 mm authored Z-up (UpAxis 2)
//   cube-colour.fbx  the 10 mm cube with a red Lambert material
//
//   node scripts/fbx-fixtures/make-fbx.mjs
//
// Nothing is hand-edited; change this script and regenerate. Each file is one
// Mesh of 6 quads over 8 vertices (the loader triangulates to 12 triangles).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(ROOT, "examples", "FBX");

const V = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
// Outward-wound (counter-clockwise seen from outside) quads.
const QUADS = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];

function fbx({ up = 1, unit = 0.1, scale = [10, 10, 10], colour }) {
  const verts = V.flatMap((v) => v.map((c, i) => c * scale[i]));
  const indices = QUADS.flatMap((q) => [q[0], q[1], q[2], -q[3] - 1]);
  const material = colour
    ? `\tMaterial: 3000, "Material::Red", "" {
\t\tVersion: 102
\t\tShadingModel: "lambert"
\t\tProperties70:  {
\t\t\tP: "DiffuseColor", "Color", "", "A",${colour.join(",")}
\t\t}
\t}
`
    : "";
  const matConn = colour ? '\tC: "OO",3000,2000\n' : "";
  return `; FBX 7.4.0 project file
FBXHeaderExtension:  {
\tFBXHeaderVersion: 1003
\tFBXVersion: 7400
}
GlobalSettings:  {
\tVersion: 1000
\tProperties70:  {
\t\tP: "UpAxis", "int", "Integer", "",${up}
\t\tP: "UnitScaleFactor", "double", "Number", "",${unit}
\t}
}
Objects:  {
\tGeometry: 1000, "Geometry::Cube", "Mesh" {
\t\tVertices: *${verts.length} {
\t\t\ta: ${verts.join(",")}
\t\t}
\t\tPolygonVertexIndex: *${indices.length} {
\t\t\ta: ${indices.join(",")}
\t\t}
\t\tGeometryVersion: 124
\t}
\tModel: 2000, "Model::Cube", "Mesh" {
\t\tVersion: 232
\t\tProperties70:  {
\t\t}
\t}
${material}}
Connections:  {
\tC: "OO",2000,0
\tC: "OO",1000,2000
${matConn}}
`;
}

const files = {
  "cube.fbx": fbx({}),
  "cube-cm.fbx": fbx({ unit: 1, scale: [1, 1, 1] }),
  "cube-zup.fbx": fbx({ up: 2, scale: [10, 10, 30] }),
  "cube-colour.fbx": fbx({ colour: [1, 0, 0] }),
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), text);
console.log(`wrote ${Object.keys(files).length} files to ${path.relative(ROOT, OUT)}`);
