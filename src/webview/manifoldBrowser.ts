/**
 * Webview-side manifold init. The `.wasm` URL is derived from this bundle's own
 * script URL (`…/media/viewer.js` → `../dist/manifold/manifold.wasm`) exactly as
 * the Draco decoders are, so it works in the real webview and the Playwright
 * harness alike. Needs `'wasm-unsafe-eval'` in the CSP (already granted for
 * Draco). Must be captured at module load: `document.currentScript` is only set
 * while the script first runs. Any failure leaves the three-bvh-csg fallback.
 */
import ManifoldModule from "manifold-3d/manifold";
import { setManifoldEngine, manifoldReady } from "./manifoldBoolean";

const WASM_URL: string | null = (() => {
  try {
    const src = typeof document !== "undefined" ? (document.currentScript as HTMLScriptElement | null)?.src : undefined;
    return src ? new URL("../dist/manifold/manifold.wasm", src).toString() : null;
  } catch {
    return null;
  }
})();

let pending: Promise<boolean> | null = null;

export function initManifoldBrowser(): Promise<boolean> {
  if (manifoldReady()) return Promise.resolve(true);
  if (!WASM_URL) return Promise.resolve(false);
  if (!pending) {
    pending = (async () => {
      const module = await (ManifoldModule as unknown as (o: object) => Promise<any>)({ locateFile: () => WASM_URL });
      module.setup();
      setManifoldEngine(module);
      return true;
    })().catch((error) => {
      console.warn("[manifold] init failed, using three-bvh-csg:", (error as Error).message);
      pending = null;
      return false;
    });
  }
  return pending;
}
