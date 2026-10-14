// Regenerates the Collada fixtures in examples/Collada/:
//   cube.dae         10 mm cube, <unit meter="0.001" name="millimeter">, Z_UP, no material
//   cube-metre.dae   the same cube authored in metres (0.01 units, <unit meter="1">), Y_UP
//   cube-inch.dae    a 1 inch cube (<unit meter="0.0254" name="inch">); must measure 25.4 mm
//   cube-colour.dae  the 10 mm cube with a red Phong material
//
//   node scripts/dae-fixtures/make-dae.mjs
//
// Nothing is hand-edited; change this script and regenerate. The files are
// plain Collada 1.4.1 text: one geometry, one indexed <triangles> block of
// 12 outward-wound triangles.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(ROOT, "examples", "Collada");

const V = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const IDX = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];

function dae({ scale, unit, upAxis, colour }) {
  const pos = V.flatMap((p) => p.map((c) => String(Number((c * scale).toPrecision(9))))).join(" ");
  const effects = colour
    ? `  <library_effects>
    <effect id="red-fx"><profile_COMMON><technique sid="common"><phong>
      <diffuse><color>${colour.join(" ")} 1</color></diffuse>
    </phong></technique></profile_COMMON></effect>
  </library_effects>
  <library_materials>
    <material id="red" name="red"><instance_effect url="#red-fx"/></material>
  </library_materials>
`
    : "";
  const matAttr = colour ? ' material="red-sym"' : "";
  const bind = colour
    ? `<bind_material><technique_common><instance_material symbol="red-sym" target="#red"/></technique_common></bind_material>`
    : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset>
    <contributor><authoring_tool>CAD-Preview scripts/dae-fixtures/make-dae.mjs</authoring_tool></contributor>
    <unit meter="${unit.meter}" name="${unit.name}"/>
    <up_axis>${upAxis}</up_axis>
  </asset>
${effects}  <library_geometries>
    <geometry id="cube-mesh" name="cube">
      <mesh>
        <source id="cube-pos">
          <float_array id="cube-pos-array" count="24">${pos}</float_array>
          <technique_common><accessor source="#cube-pos-array" count="8" stride="3">
            <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>
          </accessor></technique_common>
        </source>
        <vertices id="cube-vtx"><input semantic="POSITION" source="#cube-pos"/></vertices>
        <triangles count="12"${matAttr}>
          <input semantic="VERTEX" source="#cube-vtx" offset="0"/>
          <p>${IDX.join(" ")}</p>
        </triangles>
      </mesh>
    </geometry>
  </library_geometries>
  <library_visual_scenes>
    <visual_scene id="scene">
      <node id="cube-node" name="cube">
        <instance_geometry url="#cube-mesh">${bind}</instance_geometry>
      </node>
    </visual_scene>
  </library_visual_scenes>
  <scene><instance_visual_scene url="#scene"/></scene>
</COLLADA>
`;
}

fs.mkdirSync(OUT, { recursive: true });
const files = {
  "cube.dae": dae({ scale: 10, unit: { meter: 0.001, name: "millimeter" }, upAxis: "Z_UP" }),
  "cube-metre.dae": dae({ scale: 0.01, unit: { meter: 1, name: "meter" }, upAxis: "Y_UP" }),
  "cube-inch.dae": dae({ scale: 1, unit: { meter: 0.0254, name: "inch" }, upAxis: "Z_UP" }),
  "cube-colour.dae": dae({ scale: 10, unit: { meter: 0.001, name: "millimeter" }, upAxis: "Z_UP", colour: [1, 0, 0] }),
};
for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), text);
console.log(`wrote ${Object.keys(files).map((n) => "examples/Collada/" + n).join(", ")}`);
