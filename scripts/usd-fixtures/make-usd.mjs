// Regenerates the USD fixtures in examples/USD/:
//   cube.usda         10 mm cube (metersPerUnit = 0.001, Y-up), no material
//   cube-cm.usda      a 1 cm cube (metersPerUnit = 0.01); must measure 10 mm
//   cube-zup.usda     the 10 mm cube authored Z-up (upAxis = "Z"), tall box 10 x 10 x 30
//   cube-colour.usda  the 10 mm cube with primvars:displayColor red
//   cube.usdz         cube.usda in a USDZ package (stored zip, root layer first)
//
//   node scripts/usd-fixtures/make-usd.mjs
//
// Nothing is hand-edited; change this script and regenerate. Each file is one
// Mesh of 6 quads over 8 vertices (the loader triangulates to 12 triangles).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(ROOT, "examples", "USD");

const V = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
// Outward-wound (counter-clockwise seen from outside) quads.
const QUADS = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];

function usda({ mpu, up = "Y", scale = [1, 1, 1], colour }) {
  const pts = V.map((v) => `(${v.map((c, i) => c * scale[i]).join(", ")})`).join(", ");
  return `#usda 1.0
(
    defaultPrim = "Cube"
    metersPerUnit = ${mpu}
    upAxis = "${up}"
)

def Xform "Cube"
{
    def Mesh "Body"
    {
        int[] faceVertexCounts = [${QUADS.map(() => 4).join(", ")}]
        int[] faceVertexIndices = [${QUADS.flat().join(", ")}]
        point3f[] points = [${pts}]
        uniform token subdivisionScheme = "none"${colour ? `\n        color3f[] primvars:displayColor = [(${colour.join(", ")})]` : ""}
    }
}
`;
}

fs.mkdirSync(OUT, { recursive: true });
// The cube is 10 units on a side in each file; metersPerUnit makes it 10 mm
// (0.001), 1 cm = 10 mm (0.01, edge 1) or a 10 x 10 x 30 mm Z-up box.
const cube = usda({ mpu: 0.001, scale: [10, 10, 10] });
fs.writeFileSync(path.join(OUT, "cube.usda"), cube);
fs.writeFileSync(path.join(OUT, "cube-cm.usda"), usda({ mpu: 0.01, scale: [1, 1, 1] }));
fs.writeFileSync(path.join(OUT, "cube-zup.usda"), usda({ mpu: 0.001, up: "Z", scale: [10, 10, 30] }));
fs.writeFileSync(path.join(OUT, "cube-colour.usda"), usda({ mpu: 0.001, scale: [10, 10, 10], colour: [1, 0, 0] }));
// USDZ: members must be stored (level 0) and the root layer is the first entry.
fs.writeFileSync(path.join(OUT, "cube.usdz"), zipSync({ "cube.usda": [strToU8(cube), { level: 0 }] }));
console.log("wrote", fs.readdirSync(OUT).join(", "));
