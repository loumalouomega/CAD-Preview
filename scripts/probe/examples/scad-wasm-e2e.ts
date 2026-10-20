/** Targeted WASM end-to-end: .scad converts with NO binary (WASM-first), via the real kernel worker. */
import * as fs from "node:fs/promises";

async function main() {
  process.env.OPENSCAD_BINARY = "/nonexistent-openscad-xyz-12345";
  const { createKernelClient } = await import("../../../src/kernelClient.js");
  const { convertScadToCsg, clearScadConversionCache } = await import("../../../src/scadService.js");
  const extensionPath = process.cwd();
  clearScadConversionCache();

  const client = createKernelClient(extensionPath);
  const wasm = {
    extensionPath,
    convertScadViaWasm: (...args: [string, string, Record<string, unknown>]) =>
      (client.convertScadViaWasm as (...a: unknown[]) => Promise<never>)(...args),
  };

  // 1. minimal.scad with a missing binary must still convert (WASM, not ScadUnavailableError).
  const r = await convertScadToCsg("examples/OpenSCAD/minimal.scad", { wasm });
  console.log(`minimal via WASM with missing binary: ${r.csgBytes.length}B cached=${r.cached ?? false} deps=${r.dependencies.length}`);
  if (r.csgBytes.length !== 339) throw new Error(`expected 339B, got ${r.csgBytes.length}`);

  // 2. Same through loadBRep (full pipeline, like load_model): 2 solids / 30 faces.
  const { loadBRep } = await import("../../../src/occtService.js");
  // loadBRep runs in-process here (not via worker); use worker for the full path:
  const loaded = await client.loadBRep(extensionPath, r.csgBytes, "csg", []);
  const faces = loaded.groups.reduce((a, g) => a + g.faces.length, 0);
  console.log(`loadBRep: ${loaded.groups.length} groups ${faces} faces`);
  const { computeMassProperties } = await import("../../../src/massProperties.js");
  void computeMassProperties;

  // 3. include-main tracks its library (watcher contract) even via WASM.
  clearScadConversionCache();
  const inc = await convertScadToCsg("examples/OpenSCAD/include-main.scad", { wasm });
  console.log(`include-main: ${inc.csgBytes.length}B deps=${inc.dependencies.map((d) => d.split("/").pop()).join(",")}`);
  if (inc.csgBytes.length !== 56) throw new Error(`expected 56B, got ${inc.csgBytes.length}`);
  if (!inc.dependencies.some((d) => d.endsWith("include-lib.scad"))) throw new Error("missing include-lib dependency");

  // 4. import() still falls back to the binary (and with a missing binary, surfaces ScadUnavailableError).
  const tmp = "/tmp/probe-wasm-import.scad";
  await fs.writeFile(tmp, 'import("cube.stl");\n');
  clearScadConversionCache();
  try {
    await convertScadToCsg(tmp, { wasm });
    throw new Error("import() unexpectedly succeeded via WASM");
  } catch (e) {
    console.log(`import() via WASM with missing binary: ${(e as Error).name}: ${String((e as Error).message).slice(0, 120)}`);
    if ((e as Error).name !== "ScadUnavailableError") throw new Error(`expected ScadUnavailableError, got ${(e as Error).name}`);
  }

  (client as { cancelCurrent?: () => void }).cancelCurrent?.();
  console.log("WASM-E2E PASS");
  process.exit(0);
}

main().catch((e) => { console.error("WASM-E2E FAIL", e); process.exit(1); });
