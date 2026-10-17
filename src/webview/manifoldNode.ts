/**
 * Node-side manifold init for the kernel worker's headless mesh-edit replay (and
 * unit tests). The `.wasm` is read from the staged `dist/manifold/` beside the
 * bundle (carved into the VSIX), else from `node_modules` in a dev tree, and
 * passed as `wasmBinary` — the glue cannot locate its own file once bundled.
 * A rejected init is un-cached so a later call retries.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import ManifoldModule from "manifold-3d/manifold";
import { setManifoldEngine, manifoldReady } from "./manifoldBoolean";

let pending: Promise<boolean> | null = null;
let loaded: Parameters<typeof setManifoldEngine>[0] = null;

function wasmPath(): string | null {
  const candidates: string[] = [];
  try { candidates.push(path.join(__dirname, "manifold", "manifold.wasm")); } catch { /* no __dirname */ }
  try { candidates.push(createRequire(path.join(process.cwd(), "package.json")).resolve("manifold-3d/manifold.wasm")); } catch { /* not installed */ }
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** Resolves true when manifold is ready; false (never throws) when it cannot start. */
export function initManifoldNode(): Promise<boolean> {
  if (manifoldReady()) return Promise.resolve(true);
  if (loaded) {
    setManifoldEngine(loaded); // the slot was cleared (tests); the instance is still good
    return Promise.resolve(true);
  }
  if (!pending) {
    pending = (async () => {
      const file = wasmPath();
      if (!file) return false;
      const wasmBinary = fs.readFileSync(file);
      const module = await (ManifoldModule as unknown as (o: object) => Promise<Parameters<typeof setManifoldEngine>[0] & { setup(): void }>)({ wasmBinary });
      module!.setup();
      loaded = module;
      setManifoldEngine(module);
      return true;
    })().catch((error) => {
      console.error("[manifold] init failed:", (error as Error).message);
      pending = null;
      return false;
    });
  }
  return pending;
}
