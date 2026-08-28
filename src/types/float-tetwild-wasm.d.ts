/**
 * Hand-written ambient types for `float-tetwild-wasm` (v0.1.0) — the package
 * ships NO `.d.ts` at all (verified: `node_modules/float-tetwild-wasm/`
 * contains only `index.js`, `package.json`, `README.md`, `dist/`), unlike
 * `@meshioplusplus/wasm`/`@loumalouomega/gmsh-wasm`, which both ship real
 * types. Kept minimal and matching `node_modules/float-tetwild-wasm/
 * index.js`'s own JSDoc exactly — `src/ftetwildService.ts` is the only
 * consumer, and itself still types the loaded module as `any` internally
 * (matching this codebase's convention for every other WASM kernel service
 * — see `occtService.ts`/`gmshService.ts`/`meshioService.ts`'s own `type
 * ...Api = any`), so this file exists solely to make the top-level `await
 * import("float-tetwild-wasm")` itself type-check.
 */
declare module "float-tetwild-wasm" {
  export interface FloatTetwildLoadOptions {
    /** Force the threaded (true) or serial (false) build. Defaults to
     * auto-detection — which, under Node, always resolves to threaded (see
     * `ftetwildService.ts`'s top-of-file comment for why this codebase
     * always passes `false` explicitly). */
    threads?: boolean;
    /** Forwarded verbatim to the Emscripten module factory — e.g. `print`/
     * `printErr` to override stdout/stderr routing, `locateFile` to
     * customize where the `.wasm` is fetched from. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    moduleArgs?: Record<string, any>;
  }

  export interface FloatTetwildTetrahedralizeParams {
    epsRel?: number;
    idealEdgeLengthRel?: number;
    stopEnergy?: number;
    maxIts?: number;
  }

  export interface FloatTetwildTetrahedralizeResult {
    status: number;
    /** Flat (x, y, z, ...) — plain JS numbers, not a typed array. */
    vertices: number[];
    /** Flat groups of 4 0-based vertex indices — plain JS numbers, not a typed array. */
    tets: number[];
  }

  export interface FloatTetwildInstance {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Module: any;
    threaded: boolean;
    tetrahedralize(
      vertices: number[] | Float64Array,
      faces: number[] | Int32Array | Uint32Array,
      params?: FloatTetwildTetrahedralizeParams
    ): FloatTetwildTetrahedralizeResult;
  }

  export function loadFloatTetwild(options?: FloatTetwildLoadOptions): Promise<FloatTetwildInstance>;
  export default loadFloatTetwild;
}
