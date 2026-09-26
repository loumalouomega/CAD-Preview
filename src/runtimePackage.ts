import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Native import must survive both esbuild and TypeScript CJS transforms.
// The imported packages contain ESM/top-level await and self-locate WASM.
const nativeImport = new Function("url", "return import(url)") as
  (url: string) => Promise<any>;

export function resolveRuntimePackage(
  packageName: string,
  stagedDirectory: string,
  entry: string,
  bundleUrl = import.meta.url,
): string {
  try {
    return createRequire(bundleUrl).resolve(packageName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
  }
  const directory = dirname(fileURLToPath(bundleUrl));
  const candidates = [
    join(directory, stagedDirectory, entry),
    join(directory, "..", "..", stagedDirectory, entry),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${packageName} was not found; install it or stage its runtime files. Tried: ${candidates.join(", ")}`);
}

export function importRuntimePackage(packageName: string, stagedDirectory: string, entry: string): Promise<any> {
  return nativeImport(pathToFileURL(resolveRuntimePackage(packageName, stagedDirectory, entry)).href);
}
