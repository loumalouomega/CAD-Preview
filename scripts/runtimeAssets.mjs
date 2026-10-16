// One inventory for staging and VSIX verification. Keep package-relative paths
// intact: upstream ESM glue resolves siblings and WASM via import.meta.url.
//
// The meshio++ row stages the package's FULL artifact only (v17.2.0+): it is a
// strict superset of the lean one (the same core plus OpenCASCADE 7.6.3,
// zstd, lz4 and bzip2 — STEP/IGES reading, fitCad, the extra VTK XML codecs
// and libMesh .bz2), and `getMeshio()` loads it with `{ variant: "seq",
// full: true }`. Staging both would double the VSIX's biggest file for no
// capability; the lean pair is deliberately not shipped. The `_mt` flavours
// of BOTH pairs stay out — see `meshioService.ts`'s header for why "auto"
// (which picks the pthread build under Node) must never be used.
export const runtimePackages = [
  {
    name: "@meshioplusplus/wasm", directory: "meshio",
    files: ["package.json", "src/index.mjs", "THIRD_PARTY_NOTICES.md", "dist/meshioplusplus_wasm_full.mjs", "dist/meshioplusplus_wasm_full.wasm"],
  },
  {
    name: "float-tetwild-wasm", directory: "ftetwild",
    files: ["package.json", "index.js", "dist/floattetwild.serial.mjs", "dist/floattetwild.serial.wasm",
      "dist/floattetwild.threaded.mjs", "dist/floattetwild.threaded.wasm",
      "dist/libtbb.so", "dist/libtbb.so.12", "dist/libtbb.so.12.16"],
  },
];
export const stagedRuntimeFiles = runtimePackages.flatMap(({ directory, files }) =>
  files.map(file => `dist/${directory}/${file}`));
