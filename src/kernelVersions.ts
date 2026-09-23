/**
 * Exact installed kernel package versions, stamped in at build time by
 * `esbuild.mjs` (`__KERNEL_VERSIONS__`). Under vitest (no bundle) the define is
 * absent and every version reads `null` — never a guess.
 */
declare const __KERNEL_VERSIONS__: string | undefined;

export type KernelVersions = Record<"opencascade.js" | "@loumalouomega/gmsh-wasm" | "@meshioplusplus/wasm" | "float-tetwild-wasm", string | null>;

export function kernelVersions(): KernelVersions {
  const empty: KernelVersions = {
    "opencascade.js": null,
    "@loumalouomega/gmsh-wasm": null,
    "@meshioplusplus/wasm": null,
    "float-tetwild-wasm": null,
  };
  try {
    if (typeof __KERNEL_VERSIONS__ === "string") return { ...empty, ...(JSON.parse(__KERNEL_VERSIONS__) as Partial<KernelVersions>) };
  } catch {
    /* fall through */
  }
  return empty;
}
