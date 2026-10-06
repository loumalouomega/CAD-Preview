/** Throwaway builds of the REAL worker/client/MCP entries with one injected
 * probe method. Never changes src/, dist/, or the production Pipeline.
 * Run AFTER npm run probe -- scripts/probe/examples/mmg-core.ts --run:
 * node scripts/probe/examples/mmg-transport.mjs
 */
import { build } from "esbuild";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fork, spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { nodeCjsBase, kernelVersionsDefine } from "../../nodeBundleConfig.mjs";

const root = process.cwd();
const scratch = resolve("scripts/probe/.build/mmg-transport");
mkdirSync(`${scratch}/dist`, { recursive: true });
const probe = resolve("scripts/probe/examples/mmg-core.ts");
const inject = {
  name: "probe-only-mmg-seam",
  setup(builder) {
    builder.onLoad({ filter: /src\/(kernelWorker|kernelClient|mcpServer)\.ts$/ }, args => {
      let contents = readFileSync(args.path, "utf8");
      if (args.path.endsWith("kernelWorker.ts")) {
        contents = `import { runMmgProbe } from ${JSON.stringify(probe)};\n` + contents;
        contents = contents.replace("const handlers: Record<keyof DocumentPipeline, Handler> = {", "const handlers: Record<keyof DocumentPipeline, Handler> = { mmgProbe: () => runMmgProbe(false),");
      } else if (args.path.endsWith("kernelClient.ts")) {
        // Add only at the existing returned function table's stable seam.
        assert(contents.includes('...methods(),'));
        contents = contents.replace('...methods(),', '...methods(), mmgProbe: () => callKernel("mmgProbe", []),');
      } else {
        contents = contents.replace("createKernelClient(extensionPath)", `createKernelClient(${JSON.stringify(scratch)})`);
        contents = contents.replace("async function main(): Promise<void> {", `
server.registerTool("mmg_probe", { description: "Temporary MMG feasibility probe", inputSchema: {} }, async () => {
  const facts = await kernelClient.mmgProbe();
  if (!(facts.harvest.vertices instanceof Float64Array) || !(facts.harvest.cells instanceof Int32Array) || !(facts.harvest.refs instanceof Int32Array) || facts.harvest.cells.length !== 37 * 4) throw new Error("MMG typed-array IPC did not round-trip");
  delete facts.harvest;
  return { content: [{ type: "text", text: JSON.stringify(facts) }] };
});
async function main(): Promise<void> {`);
      }
      return { contents, loader: "ts", resolveDir: resolve("src") };
    });
  },
};
await Promise.all(["kernelWorker", "mcpServer"].map((entry, i) => build(nodeCjsBase({
  entryPoints: [`src/${entry}.ts`], outfile: `${scratch}/dist/${i ? "mcp-server" : "kernel-worker"}.js`,
  plugins: [...nodeCjsBase().plugins, inject],
  define: { ...nodeCjsBase().define, __KERNEL_VERSIONS__: kernelVersionsDefine() },
}))));

await build(nodeCjsBase({ entryPoints: [probe], outfile: `${scratch}/mmg-core.cjs`,
  define: { ...nodeCjsBase().define, __KERNEL_VERSIONS__: kernelVersionsDefine() } }));
const standalone = spawnSync(process.execPath, [`${scratch}/mmg-core.cjs`, "--run"], { cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
assert.equal(standalone.status, 0, standalone.stderr);
assert.equal(standalone.stdout.length, 0, standalone.stdout);
const factsStart = standalone.stderr.indexOf('{\n  "versions"');
assert(factsStart >= 0, standalone.stderr);
const standaloneFacts = JSON.parse(standalone.stderr.slice(factsStart));
console.error(JSON.stringify({ standaloneStdoutBytes: 0, decision: standaloneFacts.decision, optim: standaloneFacts.optim, surface: standaloneFacts.surface }, null, 2));

// Capture worker stdout rather than discarding it as production does: zero
// bytes here rules out a leak hidden by the normal ignore stdio setting.
const worker = fork(`${scratch}/dist/kernel-worker.js`, [], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"] });
let workerOut = "", workerErr = "";
worker.stdout.on("data", data => { workerOut += data; });
worker.stderr.on("data", data => { workerErr += data; });
const timer = setTimeout(() => { worker.kill("SIGKILL"); }, 120_000);
try {
  const message = await new Promise((resolveMessage, reject) => {
    worker.once("message", resolveMessage);
    worker.once("exit", (code, signal) => reject(new Error(`worker exited: ${code}/${signal}: ${workerErr}`)));
    worker.send({ id: "mmg-probe", fn: "mmgProbe", args: [] });
  });
  assert.equal(message.ok, true, JSON.stringify(message));
  assert.equal(message.id, "mmg-probe");
  // Wire buffers are tagged base64 by the REAL marshal implementation.
  assert.equal(message.result.harvest.vertices.ctor, "Float64Array");
  assert.equal(message.result.harvest.cells.ctor, "Int32Array");
  assert.equal(Buffer.from(message.result.harvest.cells.data, "base64").byteLength, 37 * 4 * 4);
} finally {
  clearTimeout(timer);
  const exited = new Promise(resolveExit => worker.once("exit", resolveExit));
  worker.kill("SIGKILL");
  await exited;
}
assert.equal(workerOut.length, 0, workerOut);

// Drive actual MCP JSON-RPC over pipes. Strictly parse every stdout line,
// including startup/shutdown; any extra library logging fails the check.
const server = spawn(process.execPath, [`${scratch}/dist/mcp-server.js`], { cwd: root, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CAD_PREVIEW_ROOT: root } });
let stdout = "", stderr = "", pending = "";
const waiters = new Map();
let parseError;
server.stderr.on("data", data => { stderr += data; });
server.stdout.on("data", data => {
  stdout += data;
  pending += data;
  while (pending.includes("\n")) {
    const end = pending.indexOf("\n"), line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    try {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, "2.0");
      waiters.get(message.id)?.(message);
    } catch (error) { parseError = error; }
  }
});
function request(id, method, params) {
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolveReply, reject) => {
    const timeout = setTimeout(() => reject(new Error(`MCP timeout: ${stderr}`)), 120_000);
    waiters.set(id, message => { clearTimeout(timeout); resolveReply(message); });
  });
}
try {
  const init = await request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mmg-probe", version: "1" } });
  assert(!init.error, JSON.stringify(init));
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const reply = await request(2, "tools/call", { name: "mmg_probe", arguments: {} });
  assert(!reply.error && !reply.result.isError, JSON.stringify(reply));
  const facts = JSON.parse(reply.result.content[0].text);
  assert.equal(facts.failure.resetAndRecovery, true);
  assert.equal(facts.volume.outputTets, 37);
  console.error(JSON.stringify({ workerStdoutBytes: workerOut.length, mcpVolume: facts.volume, mcpRecovery: facts.failure }, null, 2));
} finally {
  const exited = new Promise(resolveExit => server.once("exit", resolveExit));
  server.kill("SIGTERM");
  await exited;
}
assert.equal(parseError, undefined);
assert.equal(pending, "");
assert.equal(stdout.trim().split("\n").length, 2);
console.error("MMG worker IPC and MCP stdout discipline passed");
