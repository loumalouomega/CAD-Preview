/** Roadmap 3.16 probe: does text() work in the bundled OpenSCAD WASM, with and without a mounted font?
 * Run: npm run probe -- scripts/probe/examples/scad-text.ts --run
 * Font path comes from FONT env (a TTF on disk; the probe does NOT bundle one). */
import * as fs from "fs";
import { createRequire } from "module";
console.log = console.error.bind(console);
async function main() {
  const req = createRequire(process.cwd() + "/package.json");
  const mod: any = req("@loumalouomega/openscad-wasm");
  const wasmBinary = fs.readFileSync("node_modules/@loumalouomega/openscad-wasm/dist/openscad-core.wasm");
  const scad = 'text("KKSS A", size=10);';
  const fmt = process.env.FMT ?? "svg";
  const fontPath = process.env.FONT;
  const runs: Array<[string, any]> = [["no-font", {}]];
  if (fontPath) runs.push(["font", { fonts: { [fontPath.split("/").pop()!]: new Uint8Array(fs.readFileSync(fontPath)) } }]);
  for (const [name, extra] of runs) {
    const t0 = Date.now();
    try {
      const r = await mod.render(scad, { format: fmt, backend: "manifold", wasmBinary, ...extra });
      const out = typeof r.output === "string" ? r.output : Buffer.from(r.output).toString("utf8");
      console.error(JSON.stringify({ name, ms: Date.now() - t0, bytes: out.length, paths: (out.match(/<path/g) ?? []).length, subpaths: (out.match(/M/g) ?? []).length, head: out.slice(0, 300), stderr: String(r.stderr ?? "").slice(0, 300), diag: r.diagnostics?.slice?.(0, 3) }));
    } catch (e) { console.error(JSON.stringify({ name, error: String((e as any)?.message ?? e).slice(0, 300) })); }
  }
}
main();
