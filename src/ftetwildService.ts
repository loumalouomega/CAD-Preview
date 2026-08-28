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
// `exports: {".": "./index.js"}` (a bare string, no conditions map at all),
// so `require("float-tetwild-wasm")` throws `ERR_REQUIRE_ESM`. Same reason,
// same mechanism as `meshioService.ts`'s `getMeshio()`. Must stay `external`
// in esbuild.mjs for the identical two reasons gmsh-wasm/meshio++ must:
// nothing statically imports its `.wasm` (it self-locates via
// `import.meta.url`, and `Module.wasmBinary` is NOT honored by the glue —
// verified live, so real files on disk are mandatory, not an optimization),
// and its threaded variant has the same eager-worker-spawn risk.
//
// Loaded with `{ threads: false }` explicitly — NEVER the default
// (`threads` omitted). The package's own `threadsSupported()` helper
// (`node_modules/float-tetwild-wasm/index.js`) returns `true`
// UNCONDITIONALLY under Node (it never checks `crossOriginIsolated` there,
// unlike the browser branch) — so leaving it unset always picks the
// threaded build, which (a) needs a `libtbb.so.12.16` side-module loaded via
// dynamic linking, (b) spawns a 4-worker pthread pool that keeps Node's
// event loop alive (the package's own smoke test calls `process.exit(0)`
// explicitly, apparently for this reason), and, worst of all, (c) routes
// `std::cout`/`std::cerr` through a raw `fs.writeSync(1/2, ...)` in its
// Node glue rather than `console.log`/`console.error` — bypassing
// `mcpServer.ts`'s stdout rebinding entirely and corrupting the MCP
// JSON-RPC stream the instant a tetrahedralization runs. The serial build
// has none of this: verified live, zero `worker_threads`/`SharedArrayBuffer`
// references in its glue.
//
// `moduleArgs.print` is NOT optional — verified against the live WASM.
// fTetWild's own `Parameters::init()` (C++) writes 9 unconditional
// `std::cout` lines per call (`bbox_diag_length = ...`, `eps = ...`, ...),
// NOT gated by `is_quiet`, plus more from its simplification pass
// ("collapsing ...", "swapping ..."). Confirmed empirically: a probe run
// with no `print` override emitted 1181 bytes of this text straight onto
// real stdout per tetrahedralize() call; the identical call with
// `moduleArgs.print` set as below produced zero bytes on stdout. Both
// builds honor `Module["print"]`/`Module["printErr"]` (assigned during
// module init, before any export is callable), so this is a complete fix
// with no package patching needed.

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
      return loadFloatTetwild({
        threads: false,
        moduleArgs: {
          // Swallows Parameters::init()'s unconditional std::cout lines —
          // see this file's top-of-file comment. Deliberately a no-op, not
          // routed to console.error: this is normal per-call diagnostic
          // chatter (bbox/epsilon values), not an error, and would otherwise
          // spam stderr on every single generate.
          print: () => {
            /* intentionally silent — see top-of-file comment */
          },
          printErr: (...args: unknown[]) => console.error(...args),
        },
      });
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
 * `float-tetwild-wasm`'s own `tetrahedralize()` JSDoc exactly (v0.1.0's
 * binding exposes only these four of fTetWild's ~20 CLI parameters; the
 * rest — `disable_filtering`, `coarsen`, `manifold_surface`, `num_threads`,
 * a sizing field — are hardcoded in the package's own `Bindings.cpp` and
 * unreachable from JS as of this version). */
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
 * produces the INTERIOR volume mesh (fTetWild's own default winding-number
 * filtering, unconditional in this binding — there is no "disable
 * filtering" option reachable from JS in v0.1.0) — never a surface, never
 * the unfiltered convex hull.
 *
 * `vertices`/`indices` are handed to the WASM binding directly (not copied
 * to plain arrays first) — the package's own glue iterates them with a
 * plain `for...of`, which typed arrays support natively.
 */
export async function tetrahedralize(
  mesh: { positions: Float32Array; indices: Uint32Array },
  params: FtetwildParams = {}
): Promise<FtetwildResult> {
  const ft = await getFtetwild();
  let result: { status: number; vertices: number[]; tets: number[] };
  try {
    result = ft.tetrahedralize(mesh.positions, mesh.indices, params);
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
  return {
    vertices: Float64Array.from(result.vertices),
    tets: Uint32Array.from(result.tets),
  };
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
 * **The 3rd and 4th node of every tet are swapped relative to fTetWild's own
 * output order — a real, empirically-found winding mismatch, not a
 * stylistic choice.** Verified live: tetrahedralizing `examples/STL/cube.stl`
 * and computing each returned tet's signed volume via the standard
 * `(v1×v2)·v3` formula against fTetWild's raw `[a,b,c,d]` order gave
 * **negative volume for every single tet** (3393 of 3393 in one run); the
 * identical computation against `[a,b,c,d]` reordered to `[a,b,d,c]` gave
 * **positive volume for every tet** (3626 of 3626 in a second run) — i.e.
 * fTetWild's own tet node order is consistently the OPPOSITE of the
 * right-handed `(b-a)×(c-a)·(d-a) > 0` convention MSH `tet4`/Gmsh's own
 * `getElementQualities("minSICN")` expect. Left unswapped, every element
 * reads as inverted (`minSICN` comes back uniformly and severely negative —
 * confirmed: mean ≈ −0.87 on an otherwise perfectly ordinary cube
 * tetrahedralization) even though the geometry itself is completely
 * correct; swapping fixes it with no effect on which points/cells exist,
 * only their node ORDER within each element.
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
      // c/d swapped relative to fTetWild's own [a,b,c,d] order — see this
      // function's doc comment for the live-verified winding finding.
      const c = tets[i * 4 + 3] + 1;
      const d = tets[i * 4 + 2] + 1;
      lines.push(`${i + 1} ${a} ${b} ${c} ${d}`);
    }
  } else {
    lines.push("0 0 0 0");
  }
  lines.push("$EndElements", "");

  return lines.join("\n");
}
