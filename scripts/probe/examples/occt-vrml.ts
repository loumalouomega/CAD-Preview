/** Roadmap 3.11 probe: does VrmlAPI_Writer write a B-rep to a readable .wrl?
 * Run: npm run probe -- scripts/probe/examples/occt-vrml.ts --run   (JSON on stderr)
 * Enumerates VrmlAPI_Writer ctor/method suffixes, writes block.stp and bull.stp, reports size, Shape count
 * and IndexedFaceSet coordIndex triangle/polygon count to compare with the viewer's own tessellation. */
import * as fs from "fs";
import { getOcct } from "../../../src/occtService";
import { readShape } from "../../../src/occtService";

console.log = console.error.bind(console);
type Del = { delete(): void };

async function main() {
  const oc: any = await getOcct(process.cwd());
  const proto = Object.getOwnPropertyNames(oc.VrmlAPI_Writer?.prototype ?? {});
  const statics = Object.getOwnPropertyNames(oc.VrmlAPI ?? {});
  const out: any = { vrmlWriterBound: !!oc.VrmlAPI_Writer, proto, vrmlApiStatics: statics, files: [] };
  for (const f of ["block.stp", "bull.stp"]) {
    const cleanup: Del[] = [];
    const bytes = fs.readFileSync(`examples/STP/${f}`);
    oc.FS.writeFile("/in.step", bytes);
    try {
      const shape = readShape(oc, "/in.step", "step", cleanup);
      const rec: any = { file: f };
      const t0 = Date.now();
      try {
        // Meshing is required before Vrml writes triangles.
        new oc.BRepMesh_IncrementalMesh_2(shape, 0.1, false, 0.5, true);
        const w = new oc.VrmlAPI_Writer(); cleanup.push(w);
        const attempts: Array<[string, () => unknown]> = [
          ["w.Write(shape,path,2)", () => w.Write(shape, "/o.wrl", 2)],
          ["w.Write(shape,path)", () => w.Write(shape, "/o.wrl")],
          ["VrmlAPI.Write(shape,path,2)", () => oc.VrmlAPI.Write(shape, "/o.wrl", 2)],
          ["VrmlAPI.Write(shape,path)", () => oc.VrmlAPI.Write(shape, "/o.wrl")],
        ];
        rec.attempts = [];
        for (const [name, fn] of attempts) {
          try { rec.attempts.push({ name, result: String(fn()) }); if (oc.FS.analyzePath("/o.wrl").exists) break; }
          catch (e) { rec.attempts.push({ name, error: String((e as any)?.message ?? e).slice(0, 120) }); }
        }
        rec.ms = Date.now() - t0;
        if (oc.FS.analyzePath("/o.wrl").exists) {
          const text = Buffer.from(oc.FS.readFile("/o.wrl")).toString("utf8");
          fs.mkdirSync("scripts/probe/scratch", { recursive: true });
          fs.writeFileSync(`scripts/probe/scratch/${f}.wrl`, text);
          rec.bytes = text.length;
          rec.header = text.split("\n")[0];
          rec.shapes = (text.match(/\bShape\s*\{/g) ?? []).length;
          rec.indexedFaceSets = (text.match(/IndexedFaceSet/g) ?? []).length;
          rec.faceIndexEntries = (text.match(/-1/g) ?? []).length;
          rec.head = text.slice(0, 400);
        } else rec.written = false;
      } catch (e) { rec.error = String((e as any)?.message ?? e).slice(0, 300); }
      out.files.push(rec);
    } finally { for (let i = cleanup.length - 1; i >= 0; i--) { try { cleanup[i].delete(); } catch { /* */ } } try { oc.FS.unlink("/o.wrl"); } catch { /* */ } }
  }
  console.error(JSON.stringify(out, null, 1));
}
main();
