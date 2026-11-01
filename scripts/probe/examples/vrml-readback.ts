/** Roadmap 3.11 probe, read-back half: three's VRMLLoader parses OCCT's .wrl (run after occt-vrml.ts). */
import * as fs from "fs";
import { VRMLLoader } from "three/examples/jsm/loaders/VRMLLoader.js";
console.log = console.error.bind(console);
for (const f of ["block.stp", "bull.stp"]) {
  const text = fs.readFileSync(`scripts/probe/scratch/${f}.wrl`, "utf8");
  try {
    const scene = new VRMLLoader().parse(text, "");
    let meshes = 0, tris = 0;
    scene.traverse((o: any) => { if (o.isMesh) { meshes++; const g = o.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3; } });
    console.error(JSON.stringify({ f, meshes, tris }));
  } catch (e) { console.error(JSON.stringify({ f, error: String((e as any)?.message ?? e).slice(0, 200) })); }
}
