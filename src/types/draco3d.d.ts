// The `draco3d` package ships no types. Only the decoder entry point is used
// (bundled into the kernel worker), and only through the narrow surface
// `gltfDecode.ts` declares for itself — keep this loose.
declare module "draco3d/draco_decoder_nodejs" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createDecoderModule: (options?: { wasmBinary?: ArrayBuffer | Uint8Array }) => Promise<any>;
  export default createDecoderModule;
}
