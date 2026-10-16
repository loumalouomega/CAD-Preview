import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { AMFLoader } from "three/examples/jsm/loaders/AMFLoader.js";
import type { CadFormat } from "../fileRouter";
import { isSafeRelativePath } from "../safeRelativePath";
import { applyDefaultMaterial, convertAmfMaterials, convertColladaMaterials, convertThreeMfMaterials, parseMeshObject, parseObjObject } from "./meshObject";
import { threeMfDeclaredUnit, threeMfMmPerUnit } from "../threeMf";
import { colladaDeclaredUnit, colladaMmPerUnit } from "../colladaUnits";
import { amfDeclaredUnit } from "../amfUnits";
import { gltfUsesCompression } from "./gltfSniff";

/**
 * Where the staged Draco decoder files live (`dist/draco/`, written by
 * `esbuild.mjs`'s `copyDracoDecoders`), as an absolute webview-resource URL.
 *
 * Derived from this bundle's own script URL — `…/media/viewer.js`, so the
 * decoder is `../dist/draco/` — rather than a message or a template value,
 * because it then works unchanged in the real webview AND in the Playwright
 * harness, which serves the repo tree at its root. `document.currentScript` is
 * only set WHILE the script first runs, so this must be captured at module
 * load; `null` (no document, or no script element) simply disables Draco.
 */
const DRACO_DECODER_BASE: string | null = (() => {
  try {
    const src = typeof document !== "undefined" ? (document.currentScript as HTMLScriptElement | null)?.src : undefined;
    return src ? new URL("../dist/draco/", src).toString() : null;
  } catch {
    return null;
  }
})();

/** How long a `.mtl` texture may take to decode before the model shows without it. */
const TEXTURE_WAIT_MS = 10_000;

/**
 * The `.mtl` file names an OBJ's `mtllib` statements declare, in order. A
 * statement may list several names; names with spaces are not supported by
 * the format's common writers, so whitespace splits.
 */
export function objMaterialLibraries(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*mtllib\s+(.+?)\s*$/.exec(line);
    if (m) names.push(...m[1].split(/\s+/).filter(Boolean));
  }
  return names;
}

/**
 * Loads an OBJ with its `.mtl` materials (roadmap "Mesh display fidelity").
 * The `.mtl` and its textures are fetched relative to the model's own URL —
 * the same sibling-file rule glTF external buffers follow, so the model's
 * folder (already a webview resource root) is the only place read, and a name
 * that is not a plain relative path is never fetched. Anything that goes
 * wrong degrades to the default material and says why through `onNote`; it
 * never fails the open.
 */
async function loadObj(url: string, onNote?: (message: string) => void): Promise<THREE.Object3D> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const text = new TextDecoder().decode(await res.arrayBuffer());
  const libraries = objMaterialLibraries(text);
  if (libraries.length === 0) return parseObjObject(text);

  // `url` is absolute in a real webview; resolving against the page keeps a
  // server-relative URL (the test harness) working too.
  const dir = new URL(".", new URL(url, globalThis.location?.href ?? "http://localhost/")).href;
  let lastProblem = "";
  for (const name of libraries) {
    if (!isSafeRelativePath(name)) {
      lastProblem = `OBJ material library "${name}" is not a plain relative path beside the model — using the default material.`;
      continue;
    }
    try {
      const mtl = await fetch(new URL(name, dir).href);
      if (!mtl.ok) {
        lastProblem = `OBJ material library "${name}" not found beside the model — using the default material.`;
        continue;
      }
      const manager = new THREE.LoadingManager();
      const creator = new MTLLoader(manager).parse(await mtl.text(), dir);
      creator.preload();
      await waitForTextures(manager, creator);
      return parseObjObject(text, creator);
    } catch (err) {
      lastProblem = `OBJ material library "${name}" could not be read (${(err as Error).message}) — using the default material.`;
    }
  }
  if (lastProblem) onNote?.(lastProblem);
  return parseObjObject(text);
}

/** Resolves when every texture a preloaded material creator requested has finished (or failed). */
function waitForTextures(manager: THREE.LoadingManager, creator: MTLLoader.MaterialCreator): Promise<void> {
  const hasTextures = Object.values(creator.materials).some((m) => (m as THREE.MeshPhongMaterial).map);
  if (!hasTextures) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, TEXTURE_WAIT_MS);
    manager.onLoad = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

/**
 * Loads a mesh-format source for display. STL/OBJ/PLY fetch the bytes and go
 * through `meshObject.ts`'s `parseMeshObject` — the SAME function the kernel
 * worker's headless mesh-edit bake uses, so the object hierarchy (and with it
 * every `node-N` edit-op target) is identical on both sides. glTF keeps
 * `loadAsync` for URL-relative resources; the scene graph is the loader's
 * either way.
 */
export async function loadMeshFromUrl(
  url: string,
  format: CadFormat,
  onNote?: (message: string) => void
): Promise<THREE.Object3D> {
  switch (format) {
    case "obj":
      return loadObj(url, onNote);
    case "stl":
    case "ply": {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
      return parseMeshObject(await res.arrayBuffer(), format);
    }
    case "gltf":
      return loadGltf(url);
    case "3mf":
      return load3mf(url);
    case "dae":
      return loadDae(url);
    case "amf":
      return loadAmf(url);
    default:
      throw new Error(`Mesh loader for "${format}" is not implemented.`);
  }
}

/**
 * Loads a glTF/GLB. Fetches the bytes itself (what `GLTFLoader.loadAsync` does)
 * so it can tell whether the file is Draco/meshopt-compressed BEFORE choosing
 * a loader: an uncompressed file gets the plain loader and never touches a
 * decoder, so it cannot depend on the CSP's WebAssembly allowance or on the
 * staged decoder files.
 *
 * A compressed file needs both: `worker-src blob:` (DRACOLoader runs its WASM
 * in a Blob Worker) and `'wasm-unsafe-eval'` (both decoders compile WASM) in
 * `provider.ts`'s `getHtml` CSP. The `test:webview` harness sets no CSP, so
 * only the `test:integration` suite proves those two directives.
 */
async function loadGltf(url: string): Promise<THREE.Object3D> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const data = await res.arrayBuffer();
  // Sibling .bin / image URIs resolve against the model's own directory, as
  // `loadAsync` did.
  const base = url.substring(0, url.lastIndexOf("/") + 1);
  const loader = new GLTFLoader();
  let draco: DRACOLoader | undefined;
  if (gltfUsesCompression(data)) {
    if (DRACO_DECODER_BASE) {
      draco = new DRACOLoader();
      // The object form names the two files directly; it also disables the
      // asm.js fallback, which we do not stage (every webview runtime has WASM).
      draco.setDecoderPath({
        js: `${DRACO_DECODER_BASE}draco_wasm_wrapper.js`,
        wasm: `${DRACO_DECODER_BASE}draco_decoder.wasm`,
      });
      draco.setWorkerLimit(1);
      loader.setDRACOLoader(draco);
    }
    // Imported only now: the module instantiates its WebAssembly at import
    // time, which an uncompressed glTF must never pay for.
    const { MeshoptDecoder } = await import("three/examples/jsm/libs/meshopt_decoder.module.js");
    loader.setMeshoptDecoder(MeshoptDecoder);
  }
  try {
    const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
      loader.parse(data, base, (g) => resolve(g as { scene: THREE.Group }), reject);
    });
    return gltf.scene;
  } finally {
    // Terminates the decoder worker and revokes its blob URL; a later load
    // builds a fresh one.
    draco?.dispose();
  }
}

/**
 * Loads a 3MF. `3MFLoader` uses `DOMParser`, so it lives here and nowhere the
 * kernel worker imports. It reads the model's `unit` attribute but never
 * applies it, so the declared unit is read separately and applied as a root
 * scale (the viewer works in millimetres) and recorded on
 * `userData.declaredUnit` so the caller can seed the Units dropdown. The
 * file's `basematerials`/`colorgroup` colours are kept as native colours
 * (`convertThreeMfMaterials`); everything else gets the default material.
 */
async function load3mf(url: string): Promise<THREE.Object3D> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const data = await res.arrayBuffer();
  const group = new ThreeMFLoader().parse(data);
  convertThreeMfMaterials(group);
  applyDefaultMaterial(group);
  const bytes = new Uint8Array(data);
  const mm = threeMfMmPerUnit(bytes);
  if (mm !== 1) group.scale.multiplyScalar(mm);
  const unit = threeMfDeclaredUnit(bytes);
  if (unit) group.userData.declaredUnit = unit;
  return group;
}

/**
 * Loads a Collada `.dae`. `ColladaLoader` needs `DOMParser`, so it lives here
 * and nowhere the kernel worker imports. Two loader behaviours are replaced
 * rather than trusted:
 * - **Units:** the loader scales the scene by the raw `<unit meter>` (metres),
 *   `NaN` if malformed. That scale is reset and the scene is scaled to
 *   millimetres from {@link colladaMmPerUnit}; the declared unit seeds the
 *   (presentation-only) Units dropdown through `userData.declaredUnit`.
 * - **Up axis:** for `Z_UP` the loader rotates the scene to Y-up, but
 *   `Viewer.setModel` owns the root rotation (the user's up-axis setting), so
 *   the rotation is dropped and the vertices are shown raw, like STL/OBJ/glTF.
 * The scene is wrapped in a fresh Group so the viewer's root rotation never
 * collides with the loader's. Textures are ignored (no `path` is passed) and
 * only flat material colours are kept (`convertColladaMaterials`).
 */
async function loadDae(url: string): Promise<THREE.Object3D> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const text = await res.text();
  const result = new ColladaLoader().parse(text, "");
  if (!result) throw new Error("Could not parse the Collada file (invalid or empty XML).");
  const scene = result.scene;
  scene.rotation.set(0, 0, 0);
  scene.scale.set(1, 1, 1);
  const group = new THREE.Group();
  group.add(scene);
  convertColladaMaterials(group);
  applyDefaultMaterial(group);
  const mm = colladaMmPerUnit(text);
  if (mm !== 1) group.scale.multiplyScalar(mm);
  const unit = colladaDeclaredUnit(text);
  if (unit) group.userData.declaredUnit = unit;
  return group;
}

/**
 * Loads an AMF `.amf` (plain or zipped). `AMFLoader` needs `DOMParser`, so it
 * lives here and nowhere the kernel worker imports. The loader already scales
 * the geometry to millimetres from the root `unit` attribute, so — unlike
 * 3MF/Collada — NO scale is applied here (doing so would double-scale); the
 * declared unit only seeds the presentation-only Units dropdown through
 * `userData.declaredUnit`. `parse` returns `null` for a document whose root is
 * not `<amf>`. Material and mesh colours are kept as native colours
 * (`convertAmfMaterials`); textures and constellations are not supported.
 */
async function loadAmf(url: string): Promise<THREE.Object3D> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const data = await res.arrayBuffer();
  const scene = new AMFLoader().parse(data);
  if (!scene) throw new Error("Could not parse the AMF file (no <amf> document found).");
  const group = new THREE.Group();
  group.add(scene);
  convertAmfMaterials(group);
  applyDefaultMaterial(group);
  const unit = amfDeclaredUnit(new Uint8Array(data));
  if (unit) group.userData.declaredUnit = unit;
  return group;
}
