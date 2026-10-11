/**
 * Cheap, dependency-free check for whether a glTF/GLB uses Draco or meshopt
 * compression — so the webview only builds a decoder (and instantiates its
 * WebAssembly) for a file that actually needs one. An ordinary uncompressed
 * glTF must load exactly as it always has, with no decoder code touched and no
 * dependence on the CSP's WebAssembly allowance.
 *
 * Deliberately a substring test over the JSON text, not a parse: a false
 * positive costs one unneeded decoder init, a false negative would surface as
 * three's own "No DRACOLoader instance provided" — and the extension names are
 * long enough that neither happens in practice. (`src/gltfParser.ts`'s precise
 * `gltfCompression` uses Node's `Buffer`, so it cannot run in the webview.)
 */

const GLB_MAGIC = 0x46546c67; // "glTF"
const COMPRESSION = /KHR_draco_mesh_compression|EXT_meshopt_compression/;

export function gltfUsesCompression(bytes: ArrayBuffer | Uint8Array): boolean {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let json = data;
  if (data.byteLength >= 20) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(0, true) === GLB_MAGIC) {
      // The first chunk of a GLB is the JSON chunk; decode only that, never
      // the (possibly huge) binary payload behind it.
      const length = view.getUint32(12, true);
      json = data.subarray(20, Math.min(20 + length, data.byteLength));
    }
  }
  return COMPRESSION.test(new TextDecoder().decode(json));
}
