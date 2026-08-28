// fTetWild WASM module (`float-tetwild-wasm`) — the fourth host-side WASM
// singleton alongside OCCT (occtService.ts), Gmsh (gmshService.ts), and
// meshio++ (meshioService.ts). Used ONLY as an alternative, opt-in volume
// mesher for mesh-format ("skin mesh") sources whose triangle boundary is
// too dirty (holes, self-intersections, non-manifold edges) for Gmsh's own
// `classifySurfaces`/`createGeometry`/`addSurfaceLoop`/`addVolume` path to
// handle — see `gmshService.ts`'s `populateMeshedModel` for the dispatch and
// CLAUDE.md's "fTetWild robust volume meshing" section for the full design.
//
// UNLIKE gmsh-wasm, loaded with a DYNAMIC `await import(...)`, not a static
// top-of-file `import` — verified against the live package
// (`node_modules/float-tetwild-wasm/package.json`): `"type": "module"`,
// `exports: {".": {"types": "./index.d.ts", "default": "./index.js"}}` (no
// `require` condition, in either v0.1.0 or v0.2.0), so
// `require("float-tetwild-wasm")` throws `ERR_REQUIRE_ESM`. Same reason,
// same mechanism as `meshioService.ts`'s `getMeshio()`. Must stay `external`
// in esbuild.mjs for the identical two reasons gmsh-wasm/meshio++ must:
// nothing statically imports its `.wasm` (it self-locates via
// `import.meta.url`, and `Module.wasmBinary` is NOT honored by the glue —
// verified live against both v0.1.0 and v0.2.0, so real files on disk are
// mandatory, not an optimization), and its threaded variant has the same
// eager-worker-spawn risk.
//
// Loaded with `{ threads: false }` explicitly — NEVER the default
// (`threads` omitted). The package's own `threadsSupported()` helper
// (`node_modules/float-tetwild-wasm/index.js`) returns `true`
// UNCONDITIONALLY under Node (it never checks `crossOriginIsolated` there,
// unlike the browser branch) — STILL true as of v0.2.0, byte-identical to
// v0.1.0's own implementation — so leaving it unset always picks the
// threaded build, which (a) needs a `libtbb.so.12.16` side-module loaded via
// dynamic linking and (b) spawns a 4-worker pthread pool that keeps Node's
// event loop alive (the package's own smoke test calls `process.exit(0)`
// explicitly, apparently for this reason). v0.2.0 DID fix a third reason
// this used to matter — the threaded build's Node glue used to route
// `std::cout`/`std::cerr` through a raw `fs.writeSync(1/2, ...)` instead of
// `console.log`/`console.error`, bypassing `mcpServer.ts`'s stdout
// rebinding; `index.js` now defaults BOTH builds' Node stdio through
// `console.log`/`console.error` — but (a)/(b) alone are still enough reason
// to keep forcing the serial build.
//
// `moduleArgs.print`/`printErr` overrides are NO LONGER NEEDED as of
// v0.2.0 — a real, verified fix, not a workaround kept defensively.
// fTetWild's own `Parameters::init()` (C++) used to write 9 unconditional
// `std::cout` lines per call (`bbox_diag_length = ...`, `eps = ...`, ...)
// regardless of `is_quiet`, plus more from its simplification pass
// ("collapsing ...", "swapping ..."); v0.1.0's own binding hardcoded
// `is_quiet = true` but that flag had no effect on any of these prints.
// v0.2.0 gates every one of them behind `if (!is_quiet)` at the source
// (`src/Parameters.h`/`src/Simplification.cpp` and others in the fTetWild
// checkout), so with `is_quiet` forced `true` by `Bindings.cpp`, a call now
// produces zero bytes on stdout/stderr with no override needed at all.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FtetwildApi = any;

let _ftetwildPromise: Promise<FtetwildApi> | null = null;

/**
 * Returns the fTetWild WASM module, initializing it lazily on first call.
 *
 * A REJECTED init is deliberately NOT memoized — same fix `getOcct`/
 * `getGmsh`/`getMeshio` all need. Without it, a single transient failure
 * (e.g. a momentary dynamic-`import()` resolution error) would poison every
 * later `getFtetwild()` call in this process forever.
 */
export function getFtetwild(): Promise<FtetwildApi> {
  if (!_ftetwildPromise) {
    _ftetwildPromise = (async () => {
      const { loadFloatTetwild } = await import("float-tetwild-wasm");
      // `threads: false` is still load-bearing as of v0.2.0 — see the
      // top-of-file comment for why. No `moduleArgs` override needed
      // anymore: v0.2.0 is quiet by default (see top-of-file comment).
      return loadFloatTetwild({ threads: false });
    })().catch((err) => {
      _ftetwildPromise = null;
      throw err;
    });
  }
  return _ftetwildPromise;
}

/** Resets the singleton — called by `wrapFtetwildFault` after a WASM abort,
 * and from tests. */
export function resetFtetwild(): void {
  _ftetwildPromise = null;
}

/**
 * Emscripten aborts surface as opaque `RuntimeError`s — same vocabulary
 * `occtService.ts`'s `isOcctWasmAbort` / `gmshService.ts`'s `isWasmAbort` /
 * `meshioService.ts`'s `isMeshioWasmAbort` recognize, kept as its own local
 * copy per this codebase's convention of each kernel's fault handling
 * staying self-contained in its own service file.
 */
function isFtetwildWasmAbort(message: string): boolean {
  return /out of bounds|abort|RuntimeError|unreachable|null function|table index/i.test(message);
}

function resetFtetwildIfAbort(err: unknown): boolean {
  const raw = ((err as Error)?.message ?? String(err)).trim();
  if (!isFtetwildWasmAbort(raw)) return false;
  resetFtetwild();
  return true;
}

/**
 * Every fTetWild-touching entry point that rethrows wraps its body's
 * `catch` with this — same pattern as `wrapOcctFault`/`wrapMeshioFault`. A
 * WASM abort mid-tetrahedralization (plausible: fTetWild is research-grade
 * code deliberately fed adversarial/degenerate input) leaves the module
 * instance permanently corrupt, so this resets the singleton to force a
 * fresh one on the next call. A non-abort error (e.g. a plain "status !== 0"
 * rejection below) passes through completely unchanged.
 *
 * The message's trailing phrasing ("...the kernel has been reset; try the
 * operation again.") deliberately matches `wrapOcctFault`/`wrapMeshioFault`
 * verbatim — `scripts/mcp-smoke/run.mjs`'s `callWithCleanRetry` matches on
 * `/kernel has been reset/i` to distinguish a self-healing transient abort
 * from a genuine failure worth failing the whole smoke run over.
 */
function wrapFtetwildFault(err: unknown): Error {
  if (!resetFtetwildIfAbort(err)) return err instanceof Error ? err : new Error(String(err));
  const raw = ((err as Error)?.message ?? String(err)).trim();
  return new Error(`fTetWild crashed (${raw || "WASM abort"}) — the kernel has been reset; try the operation again.`);
}

/** Optional tuning params for {@link tetrahedralize} — mirrors
 * `float-tetwild-wasm`'s own shipped `TetParams` JSDoc (`index.d.ts`)
 * exactly. v0.1.0's binding exposed only the first four of these; v0.2.0
 * additionally exposes `disableFiltering`/`coarsen`/`manifoldSurface`/
 * `numThreads`, which used to be hardcoded in the package's own
 * `Bindings.cpp` and unreachable from JS. None of the four new fields are
 * currently threaded through by any caller in this codebase — they're
 * available for a future, measured use (e.g. `manifoldSurface` for the
 * mesh-repair path) rather than wired in speculatively. */
export interface FtetwildParams {
  /** Envelope size, as a fraction of the input's bounding-box diagonal.
   * Smaller = more faithful to the input surface, slower. Default `1e-3`. */
  epsRel?: number;
  /** Target tetrahedron edge length, as a fraction of the bbox diagonal.
   * Default `0.05`. */
  idealEdgeLengthRel?: number;
  /** Stop optimizing once the max AMIPS energy is below this. Default `10`. */
  stopEnergy?: number;
  /** Max optimization iterations. Default `80`. */
  maxIts?: number;
  /** Skip winding-number/flood-fill interior-exterior filtering, returning
   * the raw (unfiltered) tetrahedralization. Default `false`. */
  disableFiltering?: boolean;
  /** Coarsen the output mesh after optimization. Default `false`. */
  coarsen?: boolean;
  /** Force the output boundary to be manifold. Default `false`. */
  manifoldSurface?: boolean;
  /** Max TBB threads to use (0 = library default). No effect on the serial
   * build this codebase always loads. Default `0`. */
  numThreads?: number;
}

export interface FtetwildResult {
  /** Flat (x, y, z, ...) tetrahedron vertex positions. */
  vertices: Float64Array;
  /** Flat groups of 4 0-based vertex indices, one group per tetrahedron. */
  tets: Uint32Array;
}

/**
 * Tetrahedralizes a welded triangle boundary mesh — deliberately survives
 * the dirty input Gmsh's `classifySurfaces` rejects (holes, self-
 * intersections, non-manifold edges), since that robustness against exactly
 * that input class is fTetWild's whole reason for existing here. Always
 * produces the INTERIOR volume mesh by default (fTetWild's own winding-
 * number filtering) — never a surface. As of v0.2.0 the unfiltered
 * convex-hull tetrahedralization IS reachable via `params.disableFiltering`
 * (see {@link FtetwildParams}), unlike v0.1.0, but this function's callers
 * don't currently set it.
 *
 * Calls the package's `tetrahedralizeTyped()` entry point (v0.2.0+), not
 * `tetrahedralize()` — the plain-array entry point's shipped types accept
 * only `number[] | Float64Array` for vertices and `number[] | Int32Array`
 * for faces, neither of which matches this function's actual inputs
 * (`Float32Array` positions, `Uint32Array` indices); `tetrahedralizeTyped`
 * accepts both and returns `Float64Array`/`Uint32Array` directly (a
 * zero-copy heap-view path, per the package's own README: ~49x faster
 * input marshaling and ~9x faster output unmarshaling than the old
 * per-element embind-vector loop on an ~82k-triangle mesh), which already
 * matches {@link FtetwildResult} with no conversion needed.
 */
export async function tetrahedralize(
  mesh: { positions: Float32Array; indices: Uint32Array },
  params: FtetwildParams = {}
): Promise<FtetwildResult> {
  const ft = await getFtetwild();
  let result: { status: number; vertices: Float64Array; tets: Uint32Array };
  try {
    result = ft.tetrahedralizeTyped(mesh.positions, mesh.indices, params);
  } catch (err) {
    throw wrapFtetwildFault(err);
  }
  // status !== 0 (EXIT_FAILURE) is fTetWild's own "the input was empty or
  // malformed" signal, per its own JSDoc — a normal rejection, not a WASM
  // abort, so this does NOT go through wrapFtetwildFault/resetFtetwild.
  if (result.status !== 0 || result.tets.length === 0) {
    throw new Error(
      `fTetWild could not tetrahedralize this mesh (status=${result.status}, produced ${result.tets.length / 4} tetrahedra) — the input may be empty, degenerate, or too small relative to its own envelope size.`
    );
  }
  return { vertices: result.vertices, tets: result.tets };
}

/**
 * Serializes a raw tetrahedron mesh (fTetWild's own output shape) to ASCII
 * MSH 4.1 text — pure, WASM-free, independently unit-testable. This is the
 * hand-off format `gmshService.ts`'s `populateMeshedModel` writes into
 * Gmsh's own MEMFS and `gmsh.merge()`s, which is what lets every existing
 * read-back path (`buildIndices`, `buildEdges`, `computeQualityAndWorstElements`,
 * `gmsh.write()` for `mshText`, the MDPA/export-format bridges) work
 * unchanged on an fTetWild-produced mesh — verified live: `gmsh.merge()` of
 * a hand-written single-tet MSH 4.1 file creates a genuine discrete-volume
 * 3D entity, `getEntities(3)`/`getElements(3, undefined)`/`getNodes()`/
 * `getElementQualities(..., "minSICN")` all resolve correctly against it,
 * and `gmsh.write()` round-trips it back to equivalent MSH 4.1 text.
 *
 * One entity block each for `$Nodes`/`$Elements` (dim 3, tag 1) — fTetWild
 * produces one connected tetrahedral mesh per call, so there's never a
 * reason for more than one. Node tags are 1-based sequential (MSH
 * convention); fTetWild's own `tets` indices are 0-based (matching its
 * `faces` input convention), so every element's node reference is offset by
 * `+1` here. An empty result (`vertices`/`tets` both length 0) still
 * produces a structurally valid, empty MSH file (`0 0 0 0` entity-block
 * counts) rather than a malformed `minTag=1 maxTag=0` range — `tetrahedralize`
 * itself already rejects a genuinely empty result before this is ever
 * called with one, but this function stays correct on its own regardless.
 *
 * **No node reordering is applied — as of `float-tetwild-wasm` v0.2.0,
 * `tets` already uses the standard positive-signed-volume convention MSH
 * `tet4`/VTK_TETRA/Gmsh's `getElementQualities("minSICN")` expect.** This
 * WAS not true in v0.1.0: this function used to swap each tet's 3rd/4th
 * node to compensate for a real, empirically-found winding bug (every
 * returned tet had negative signed volume — confirmed live at the time via
 * `(b-a)×(c-a)·(d-a)`, `minSICN` mean ≈ −0.87 on an otherwise ordinary
 * cube). fTetWild fixed the bug at its source in v0.2.0
 * (`src/MeshIO.cpp`'s `extract_volume_mesh` now ends with
 * `T.col(2).swap(T.col(3))`, applying exactly the reorder this function
 * used to do by hand) and ships a `assertPositiveWinding()` smoke check in
 * its own CI gating publication — so re-applying the old swap here would
 * silently re-invert every element. Re-verified against the live WASM
 * post-upgrade via `scripts/mcp-smoke/run.mjs`'s `quality.min > -1e-6`
 * assertion on `engine:"ftetwild"`.
 */
export function tetsToMsh41(vertices: ArrayLike<number>, tets: ArrayLike<number>): string {
  const nodeCount = Math.floor(vertices.length / 3);
  const tetCount = Math.floor(tets.length / 4);
  const lines: string[] = ["$MeshFormat", "4.1 0 8", "$EndMeshFormat"];

  lines.push("$Nodes");
  if (nodeCount > 0) {
    lines.push(`1 ${nodeCount} 1 ${nodeCount}`);
    lines.push(`3 1 0 ${nodeCount}`);
    for (let i = 1; i <= nodeCount; i++) lines.push(String(i));
    for (let i = 0; i < nodeCount; i++) {
      lines.push(`${vertices[i * 3]} ${vertices[i * 3 + 1]} ${vertices[i * 3 + 2]}`);
    }
  } else {
    lines.push("0 0 0 0");
  }
  lines.push("$EndNodes");

  lines.push("$Elements");
  if (tetCount > 0) {
    lines.push(`1 ${tetCount} 1 ${tetCount}`);
    lines.push(`3 1 4 ${tetCount}`); // dim=3, tag=1, elementType=4 (tet4, linear tetrahedron)
    for (let i = 0; i < tetCount; i++) {
      const a = tets[i * 4] + 1;
      const b = tets[i * 4 + 1] + 1;
      const c = tets[i * 4 + 2] + 1;
      const d = tets[i * 4 + 3] + 1;
      lines.push(`${i + 1} ${a} ${b} ${c} ${d}`);
    }
  } else {
    lines.push("0 0 0 0");
  }
  lines.push("$EndElements", "");

  return lines.join("\n");
}
