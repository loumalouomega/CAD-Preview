/** Real packaged-runtime MMG regression. No repo node_modules fallback:
 * extract a VSIX into /tmp/opencode, launch its own stdio MCP entry, remesh
 * and reopen the two-material MED fixture, remesh a planar triangle surface,
 * generate/remesh edited CAD with a boundary Part, and test refusals.
 * Every stdout line must be RPC.
 * Run: node scripts/compat/mmg-vsix.mjs /path/to/cad-preview.vsix */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { unzipSync } from "fflate";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const vsix = path.resolve(process.argv[2] ?? path.join(ROOT, "cad-preview.vsix"));
const temporary = fs.mkdtempSync("/tmp/opencode/mmg-vsix-");
const extension = path.join(temporary, "extension");
let child;
try {
  for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(fs.readFileSync(vsix))))) {
    if (!name.startsWith("extension/") || name.endsWith("/")) continue;
    const dest = path.resolve(temporary, name);
    assert(dest.startsWith(`${extension}${path.sep}`), "archive path must stay inside extension");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
  }
  const source = path.join(temporary, "input.med"), output = path.join(temporary, "remeshed.med");
  const original = fs.readFileSync(path.join(ROOT, "examples/MED/two-material-tets.med"));
  fs.writeFileSync(source, original);
  child = spawn(process.execPath, [path.join(extension, "dist/mcp-server.js")], {
    cwd: temporary, env: { ...process.env, NODE_PATH: "", CAD_PREVIEW_ROOT: extension }, stdio: ["pipe", "pipe", "pipe"],
  });
  let pending = "", stderr = "", nextId = 0, terminalError;
  const requests = new Map();
  function fail(error) { terminalError ??= error; for (const { reject } of requests.values()) reject(error); requests.clear(); }
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", text => { stderr = (stderr + text).slice(-12000); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", text => {
    pending += text;
    while (pending.includes("\n")) {
      const end = pending.indexOf("\n"), line = pending.slice(0, end); pending = pending.slice(end + 1);
      try {
        const response = JSON.parse(line);
        assert.equal(response.jsonrpc, "2.0", "MMG stdout must be JSON-RPC only");
        const waiting = requests.get(response.id);
        if (!waiting) continue;
        requests.delete(response.id);
        if (response.error) waiting.reject(new Error(JSON.stringify(response.error)));
        else waiting.resolve(response.result);
      } catch (error) { fail(error); }
    }
  });
  child.on("error", fail);
  child.on("exit", code => fail(new Error(`Packaged MCP exited ${code}: ${stderr}`)));
  async function request(method, params) {
    if (terminalError) throw terminalError;
    const id = ++nextId;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        requests.set(id, { resolve, reject });
        timer = setTimeout(() => { requests.delete(id); reject(new Error(`Packaged MCP timeout: ${stderr}`)); }, 60000);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    } finally { clearTimeout(timer); }
  }
  async function call(name, args) {
    const result = await request("tools/call", { name, arguments: args });
    assert(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
    return JSON.parse(result.content.find(item => item.type === "text").text);
  }
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mmg-vsix-check", version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const tools = await request("tools/list", {});
  assert(tools.tools.some(tool => tool.name === "remesh_mesh"));
  const result = await call("remesh_mesh", { path: source, outputPath: output, options: { hmax: 0.6 } });
  assert.equal(result.report.module, "mmg3d");
  assert(result.report.outputCells > result.report.inputCells);
  assert.equal(result.report.memoryMb, 128);
  assert(result.report.wasmBytes < 256 * 1024 ** 2);
  assert.deepEqual(result.regionNames.sort(), ["MaterialA", "MaterialB"]);
  assert(result.warnings.some(w => /data was dropped/.test(w)));
  assert(fs.readFileSync(source).equals(original));
  const reopened = await call("load_model", { path: output });
  assert.equal(reopened.sidecars.parts.length, 2);
  const state = await call("get_state", { path: output });
  assert(state.parts.every(part => part.surfaces.length > 0));
  console.log(`✓ isolated packaged MMG runtime: ${result.report.inputCells} → ${result.report.outputCells} tetrahedra, both material Parts reopen, stdout is JSON-RPC only`);

  const triangles = path.join(temporary, "surface.vtk"), surfaceOutput = path.join(temporary, "surface.med");
  fs.writeFileSync(triangles, "# vtk DataFile Version 3.0\nPlanar triangles\nASCII\nDATASET UNSTRUCTURED_GRID\nPOINTS 4 double\n0 0 0\n1 0 0\n1 1 0\n0 1 0\nCELLS 2 8\n3 0 1 2\n3 0 2 3\nCELL_TYPES 2\n5\n5\n");
  const surface = await call("remesh_mesh", { path: triangles, outputPath: surfaceOutput, options: { hmax: 0.2, hausd: 0.01, hausdRelative: false } });
  assert.equal(surface.report.module, "mmgs");
  assert(surface.report.outputCells > 2);
  assert.equal(surface.report.hausd, 0.01);
  console.log(`✓ packaged surface MMG: 2 → ${surface.report.outputCells} triangles, absolute hausd`);

  const cad = path.join(temporary, "edited.stp"), cadOutput = path.join(temporary, "generated.med");
  fs.copyFileSync(path.join(ROOT, "examples/STP/block.stp"), cad);
  const cadBytes = fs.readFileSync(cad);
  const translated = await call("apply_edit_ops", { path: cad, ops: [{ op: "translate", targets: ["solid-0"], vec: [10, 0, 0] }] });
  assert.equal(translated.applied, 1);
  await call("set_part", { path: cad, name: "Wall", surfaces: ["face-0"], color: "#ff0000", meshSize: 1 });
  const generated = await call("remesh_mesh", { path: cad, source: "generated", outputPath: cadOutput,
    options: { hmax: 1 }, meshOptions: { sizeMax: 2 } });
  assert(generated.regionNames.includes("Wall"));
  assert(generated.parts.some(part => part.name === "Wall" && part.color === "#ff0000" && part.meshSize === 1 && part.surfaces.length > 0));
  assert(fs.readFileSync(cad).equals(cadBytes));
  // meshio load_model intentionally reports bbox:null. Inspect the actual
  // MED coordinates through the archive's own staged reader instead of
  // adding a Gmsh re-generation that could obscure what was persisted.
  const { loadMeshioPlusPlus } = await import(pathToFileURL(path.join(extension, "dist/meshio/src/index.mjs")).href);
  const reader = await loadMeshioPlusPlus({}, { variant: "seq" });
  reader.FS.writeFile("/generated.med", fs.readFileSync(cadOutput));
  const moved = reader.readMesh("/generated.med", "med");
  let minX = Infinity;
  for (let i = 0; i < moved.points.length; i += moved.dim) minX = Math.min(minX, moved.points[i]);
  assert(minX > 5, "generated mode must include the pending translation, not the original CAD or a stale overlay");
  reader.FS.unlink("/generated.med");
  console.log("✓ packaged generated-mode MMG: current CAD edits/settings, rebound Wall colour/size and unchanged source");

  for (const args of [
    { path: source, outputPath: source },
    { path: source, outputPath: output },
    { path: source, outputPath: path.join(temporary, "invalid.med"), options: { optimOnly: true } },
    { path: cad, outputPath: path.join(temporary, "raw-cad.med") },
  ]) {
    const refusal = await request("tools/call", { name: "remesh_mesh", arguments: args });
    assert(refusal.isError);
  }
  assert(fs.readFileSync(source).equals(original));
  const hex = path.join(temporary, "hex.med"), hexOutput = path.join(temporary, "hex-output.med");
  fs.copyFileSync(path.join(ROOT, "examples/MED/single-hex.med"), hex);
  const unsupported = await request("tools/call", { name: "remesh_mesh", arguments: { path: hex, outputPath: hexOutput } });
  assert(unsupported.isError && !fs.existsSync(hexOutput));
  const healthy = await call("remesh_mesh", { path: source, outputPath: path.join(temporary, "after-refusal.med"), options: { hmax: 0.7 } });
  assert(healthy.report.outputCells > 0);
  assert.equal(terminalError, undefined);
  console.log("✓ packaged refusal paths: source/existing output, unknown options, raw CAD and hex; healthy call after refusal");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 5000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }
  fs.rmSync(temporary, { recursive: true, force: true });
}
