// One inventory for staging and VSIX verification. Keep package-relative paths
// intact: upstream ESM glue resolves siblings and WASM via import.meta.url.
export const runtimePackages = [
  {
    name: "@meshioplusplus/wasm", directory: "meshio",
    files: ["package.json", "src/index.mjs", "dist/meshioplusplus_wasm.mjs", "dist/meshioplusplus_wasm.wasm"],
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
