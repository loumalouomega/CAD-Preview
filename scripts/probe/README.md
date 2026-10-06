# Probe harness

Runs a TypeScript file against the real OCCT, Gmsh, meshio++ and fTetWild WASM
kernels, so a probe can establish a fact about a binding without writing a
build script first.

The MMG feasibility probe additionally uses the pinned **devDependency**
`@loumalouomega/mmg-wasm` (LGPL-3.0-or-later); it is not a shipped kernel.

```sh
npm run probe -- scripts/probe/examples/bull-counts.ts          # builds first
node scripts/probe/run.mjs --no-build path/to/probe.ts [args…]   # reuse dist/
```

### MMG core and transport experiment

```sh
npm run probe -- scripts/probe/examples/mmg-core.ts --run
node scripts/probe/examples/mmg-transport.mjs
```

The core experiment checks region references and volumes, fTetWild-output
optimisation through Gmsh minSICN, sphere coarsening, STRONGFAILURE recovery,
empty-harvest rejection and 20 repeated remeshes. It prints JSON facts to
**stderr**. An exit code of zero means the experiment completed, **not** that
every admission gate passed: read `decision` and `optim.nonDecreasing`.

The transport experiment also runs the complete core experiment and asserts
zero stdout bytes. It builds temporary copies of the real kernel-worker,
kernel-client and MCP entries under the ignored `.build/mmg-transport/`,
injecting one probe-only method with an esbuild plugin (no source or shipped
bundle is rewritten). It captures the worker's otherwise-discarded stdout,
checks typed-array wire tags, and strictly parses every MCP stdout line as
JSON-RPC. The temporary `mmg_probe` tool is **not** part of the product API.

The measured outcome is **partial**: both remeshers work, but `optim` has
lowered minSICN on the motivating fixture. Exact call shapes and measurements
are in `CLAUDE.md`'s "MMG core feasibility probe" section; remaining scope is
in the roadmap's "MMG remeshing of FE meshes" item. The core run can retain
roughly 1.3 GB RSS with all three exercised kernels; use the isolated process,
not a long-lived development host.

`run.mjs` bundles the entry with `scripts/nodeBundleConfig.mjs`, the same
Node/CJS recipe `esbuild.mjs` uses for the shipped bundles. It then runs the
bundle with the repo root as `cwd`, so a probe passes `process.cwd()` as
`extensionPath`. Without `--no-build` it runs `esbuild.mjs` first, so
`dist/*.wasm` exist and match the sources. Stack traces point at the `.ts`
lines (inline source maps). `kernelVersions()` from `src/kernelVersions.ts`
reports the installed package versions.

The environment is passed through unchanged, so the harness also runs under
the Flatpak recipe in `doc/development.md`
(`ELECTRON_RUN_AS_NODE=1 …/code scripts/probe/run.mjs …`).

## Starting a probe

Copy `examples/bull-counts.ts` into `scratch/`, which is git-ignored. The
example shows the three things every probe needs:

- Push every OCCT handle onto a `cleanup` list and `.delete()` it in reverse
  order in `finally`.
- Keep MEMFS paths to 10 characters or fewer. Longer paths silently corrupt
  STEP writes in this build.
- Throw a caught error through `wrapOcctFault`, which resets a corrupt kernel.
  The Gmsh equivalents are `getGmsh`/`resetGmsh` in `src/gmshService.ts`.

Commit a probe under `examples/` only when it is worth rerunning, for example
when it pins a fact a later dependency bump could change.

## Protocol

Every probe write-up records:

1. The installed artifact versions (print `kernelVersions()`).
2. The fixture path.
3. The exact call shapes that worked: overload suffix (`_1`, `_2`, …) and
   argument count. OCCT has no `.d.ts`, so signatures are found by listing a
   prototype and trying suffixes. Record the ones that failed too, and how
   they failed.
4. The output facts, checked against an analytic or independently measured
   value where one exists. A method that accepts its arguments and changes
   nothing counts as a failed probe.
5. Cleanup behaviour, and a kernel reset after any deliberate abort.
6. Wall-clock timing on the largest fixture that fits.

## Where results go

- **Pass:** the item's "If admitted" phases move into the roadmap's Tier 1
  with firm estimates, and the verified call shapes go into `CLAUDE.md`.
- **Fail:** the item moves to the roadmap's Non-goals (Kernel-blocked for a
  dead binding, Rejected scope for a product judgement), with the calls that
  failed and what would change our mind.
- **Partial:** the item stays in the roadmap, narrowed to the part that
  survived, and the failed part is recorded under Non-goals.

The write-up belongs in those documents. The scratch script can be thrown
away.
