/** meshio++ 17.13 probe: `segment` method 'primitive', `refinePatches`, and the new `fitCad` options.
 * Run: npm run probe -- scripts/probe/examples/meshio-fitcad-1713.ts --run   (diagnostics: JSON on stderr)
 * Skins: examples/STL/cube.stl and bull.stp tessellated (fine preset). Records patch counts per method and
 * the fitCad report under backend occt/native, with refineSegmentation / freeformMode / faceDeviation.
 */
import * as fs from "fs";
import { getMeshio } from "../../../src/meshioService";
import { brepSkinStlBytes } from "../../../src/octreeService";

console.log = console.error.bind(console);
const out = (o: unknown): void => { console.error(JSON.stringify(o)); };
const strip = (r: any): any => {
  const { mesh, info, faces, ...rest } = r ?? {};
  return { ...rest, faceRecords: faces?.length, demotionReasons: faces ? [...new Set(faces.map((f: any) => f.demotionReason))] : undefined };
};

async function main(): Promise<void> {
  const m = await getMeshio();
  const root = process.cwd();
  const skins: Array<[string, Uint8Array]> = [
    ["cube.stl", fs.readFileSync("examples/STL/cube.stl")],
    ["bull.stp", await brepSkinStlBytes(root, fs.readFileSync("examples/STP/bull.stp"))],
  ];
  for (const [name, bytes] of skins) {
    m.FS.writeFile("/fc.stl", bytes);
    const skin = m.readMesh("/fc.stl", "stl");
    for (const method of ["angle", "primitive"] as const) {
      try {
        const t0 = Date.now();
        const seg = m.segment(skin, 30, 0, 0, 1, "", "patch", method, 0.01);
        out({ name, segment: method, ms: Date.now() - t0, numPatches: seg.numPatches, numMerged: seg.numMerged });
        const t1 = Date.now();
        const ref = m.refinePatches(seg.mesh, {});
        const { mesh, ...rest } = ref;
        out({ name, method, refine: { ms: Date.now() - t1, ...rest } });
        const fit = m.fitPrimitives(ref.mesh, "segment:patch", 0.01, true, 0.9, ["plane", "sphere", "cylinder", "cone", "torus"], 20);
        out({ name, method, fitAfterRefine: { plane: fit.numPlane, sphere: fit.numSphere, cylinder: fit.numCylinder, cone: fit.numCone, torus: fit.numTorus, unfitted: fit.numUnfitted } });
      } catch (e) { out({ name, method, error: String((e as Error).message).slice(0, 300) }); }
    }
    const seg = m.segment(skin, 30, 0, 0, 1, "", "patch");
    const fit = m.fitPrimitives(seg.mesh, "segment:patch", 0.01, true, 0.9, ["plane", "sphere", "cylinder", "cone", "torus"], 20);
    const variants: Array<[string, Record<string, unknown>]> = [
      ["occt-default", { backend: "occt" }],
      ["native", { backend: "native" }],
      ["occt-refine", { backend: "occt", refineSegmentation: true }],
      ["occt-faceDeviation", { backend: "occt", faceDeviation: true }],
      ["occt-adaptive", { backend: "occt", freeformMode: "adaptive" }],
      ["occt-mergeFalse", { backend: "occt", mergeFaces: false }],
    ];
    for (const [label, opts] of variants) {
      try {
        const t0 = Date.now();
        const r = m.fitCad(fit.mesh, { stepPath: "/f.step", ...opts });
        out({ name, fitCad: label, ms: Date.now() - t0, step: m.FS.readFile("/f.step").length, ...strip(r) });
      } catch (e) { out({ name, fitCad: label, error: String((e as Error).message).slice(0, 300) }); }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
