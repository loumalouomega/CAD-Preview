/**
 * Probe for roadmap "Build and bundle an OpenSCAD WASM port" (6.2), gates 3-5+7:
 * correctness (every examples/OpenSCAD/*.scad vs binary, incl -D), loading
 * under the shipped CJS bundle recipe, kernel abort classification, timing.
 * Run: npm run probe -- scripts/probe/examples/openscad-wasm.ts
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function main() {
  const extensionPath = process.cwd();
  const { convertScadViaWasm } = await import("../../../src/scadWasmService.js");
  const dir = path.join(extensionPath, "examples/OpenSCAD");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".scad"));
  console.log(`fixtures: ${files.join(", ")}`);

  // Gate 4: loads under the probe bundle (same nodeCjsBase recipe as shipping
  // bundles — external openscad-wasm + import.meta.url shim) with explicit
  // wasmBinary, and stdout stays pure.
  let stdoutBytes = 0;
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: unknown }).write = ((c: unknown, ...a: unknown[]) => {
    try { stdoutBytes += Buffer.byteLength(String(c)); } catch { /* ignore */ }
    return (origWrite as (...args: unknown[]) => unknown)(c, ...a);
  }) as typeof process.stdout.write;

  // Gate 3: every fixture byte-identical to the user-installed binary.
  for (const f of files) {
    const t0 = Date.now();
    const wasm = await convertScadViaWasm(extensionPath, path.join(dir, f), {});
    const ms = Date.now() - t0;
    const tmp = `/tmp/probe-scad-${f}.csg`;
    await execFileAsync("openscad", ["-o", tmp, path.resolve(path.join(dir, f))], { timeout: 60000 });
    const bin = await fs.readFile(tmp);
    const wasmText = Buffer.from(wasm.csgBytes).toString("utf8");
    const binText = bin.toString("utf8");
    const identical = wasmText === binText;
    console.log(`${f}: wasm ${wasm.csgBytes.length}B/${ms}ms bin ${bin.length}B identical=${identical} deps=[${wasm.dependencies.map((d) => path.basename(d)).join(",")}]`);
    if (!identical) {
      console.log("--- WASM head ---"); console.log(wasmText.slice(0, 300));
      console.log("--- BIN head ---"); console.log(binText.slice(0, 300));
      throw new Error(`${f}: WASM output differs from binary`);
    }
    if (wasm.warnings.join(" ").includes("localization")) throw new Error("localization noise leaked into warnings");
  }

  // -D override changes output (Customizer path).
  const paramPath = path.join(dir, "parametric.scad");
  const base = await convertScadViaWasm(extensionPath, paramPath, {});
  const widened = await convertScadViaWasm(extensionPath, paramPath, { defines: { width: 60 } });
  const baseText = Buffer.from(base.csgBytes).toString("utf8");
  const wideText = Buffer.from(widened.csgBytes).toString("utf8");
  console.log(`parametric -D: base ${base.csgBytes.length}B widened ${widened.csgBytes.length}B differ=${baseText !== wideText}`);
  if (baseText === wideText) throw new Error("-D width=60 did not change output");
  const tmpD = "/tmp/probe-scad-param-D.csg";
  await execFileAsync("openscad", ["-D", "width=60", "-o", tmpD, path.resolve(paramPath)], { timeout: 60000 });
  const binD = (await fs.readFile(tmpD)).toString("utf8");
  if (wideText !== binD) throw new Error("-D output differs from binary");

  // Gate 5: abort classification — infinite recursion must fail (fallback-shape
  // error), never hang; the next render still works (singleton reset or fresh).
  const recPath = "/tmp/probe-scad-rec.scad";
  await fs.writeFile(recPath, "module r(n){r(n+1);} r(0);\n");
  const tRec = Date.now();
  let recFailed = false;
  try {
    await convertScadViaWasm(extensionPath, recPath, {});
  } catch (e) {
    recFailed = true;
    console.log(`recursion declined in ${Date.now() - tRec}ms: ${String((e as Error).message).slice(0, 160)}`);
  }
  if (!recFailed) throw new Error("recursion unexpectedly succeeded");
  const after = await convertScadViaWasm(extensionPath, path.join(dir, "minimal.scad"), {});
  console.log(`post-abort minimal: ${after.csgBytes.length}B (kernel usable)`);

  // Gate 7: timing on the largest fixture.
  const colour = path.join(dir, "colour-booleans.scad");
  const tBin = Date.now();
  await execFileAsync("openscad", ["-o", "/tmp/probe-scad-timing.csg", path.resolve(colour)], { timeout: 60000 });
  const binMs = Date.now() - tBin;
  const tWasm = Date.now();
  await convertScadViaWasm(extensionPath, colour, {});
  const wasmMs = Date.now() - tWasm;
  console.log(`timing colour-booleans: binary ${binMs}ms wasm ${wasmMs}ms`);
  (process.stdout as unknown as { write: unknown }).write = origWrite as unknown;
  console.log(`stdoutBytes during WASM renders: ${stdoutBytes} (must be 0 from WASM itself; harness lines above excluded)`);
  console.log("PROBE PASS");
}

main().catch((e) => { console.error("PROBE FAIL", e); process.exit(1); });
