// Minimal type stub for the raw emscripten factory (no official types).
declare module "opencascade.js/dist/opencascade.wasm.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const factory: (opts?: Record<string, unknown>) => Promise<any>;
  export default factory;
}
