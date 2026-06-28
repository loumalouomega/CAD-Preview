import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** Extension host bundle: Node/CJS, `vscode` is provided by the runtime. */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "dist/extension.js",
  external: ["vscode", "opencascade.js"],
  sourcemap: true,
  logLevel: "info",
};

/** Webview bundle: browser/IIFE, Three.js is bundled in. */
const webviewConfig = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2020",
  outfile: "media/viewer.js",
  sourcemap: true,
  logLevel: "info",
};

if (watch) {
  const ctxExt = await esbuild.context(extensionConfig);
  const ctxWv = await esbuild.context(webviewConfig);
  await Promise.all([ctxExt.watch(), ctxWv.watch()]);
  console.log("esbuild: watching...");
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(webviewConfig),
  ]);
}
