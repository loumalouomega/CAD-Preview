import * as THREE from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { OBJExporter } from "three/examples/jsm/exporters/OBJExporter.js";
import { PLYExporter } from "three/examples/jsm/exporters/PLYExporter.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import type { CadFormat } from "../fileRouter";
import { unitScaleFactor, type DisplayUnit } from "../lengthUnits";
import { build3mf, type ThreeMfObject } from "../threeMf";

export interface ExportedMesh {
  data: string;
  binary: boolean;
}

/** Browser-side counterpart to the `atob`-based decode in geometryBuilder.ts. */
export function arrayBufferToBase64(buf: ArrayBufferLike): string {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function exportPly(model: THREE.Object3D): Promise<ExportedMesh> {
  return new Promise((resolve) => {
    new PLYExporter().parse(
      model,
      (result) => resolve({ data: result as string, binary: false }),
      { binary: false }
    );
  });
}

/**
 * A shallow clone of `model` (children cloned too, but geometries/materials
 * stay shared references — cheap, and the live displayed model is never
 * mutated) with its root scaled by `unit`'s mm factor — the geometric half of
 * "unit conversion on export", distinct from `units.ts`'s presentation-only
 * display rescale. `updateMatrixWorld(true)` is required immediately: every
 * exporter below bakes `matrixWorld` into its output, and that's normally
 * only refreshed by the render loop, which never runs on a parentless,
 * off-scene clone. Returns `model` itself, untouched, for `undefined`/`"mm"`
 * (the common case — no clone/scale cost for a plain export).
 */
function applyExportScale(model: THREE.Object3D, unit: DisplayUnit | undefined): THREE.Object3D {
  if (!unit || unit === "mm") return model;
  const clone = model.clone(true);
  clone.scale.multiplyScalar(unitScaleFactor(unit));
  clone.updateMatrixWorld(true);
  return clone;
}

/**
 * Collects the displayed triangles as 3MF objects in world space (so
 * `applyExportScale`'s root scale is baked in). Meshes sharing a
 * `userData.groupId` (every face of one B-rep solid, every facet of one mesh
 * node) become ONE object; a mesh without one is its own object. Lines and
 * sprites are ignored.
 */
function threeMfObjects(root: THREE.Object3D): ThreeMfObject[] {
  root.updateMatrixWorld(true);
  const byGroup = new Map<string, { positions: number[]; indices: number[] }>();
  const order: string[] = [];
  let anon = 0;
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const pos = o.geometry?.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const gid = (o.userData as { groupId?: string }).groupId;
    const key = gid ?? `mesh-${anon++}`;
    let bucket = byGroup.get(key);
    if (!bucket) {
      bucket = { positions: [], indices: [] };
      byGroup.set(key, bucket);
      order.push(key);
    }
    const base = bucket.positions.length / 3;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      bucket.positions.push(v.x, v.y, v.z);
    }
    const index = o.geometry.getIndex();
    if (index) for (let i = 0; i < index.count; i++) bucket.indices.push(base + index.getX(i));
    else for (let i = 0; i < pos.count; i++) bucket.indices.push(base + i);
  });
  return order.map((name) => ({ name, positions: byGroup.get(name)!.positions, indices: byGroup.get(name)!.indices }));
}

/**
 * Serializes the currently displayed Three.js model to one of the supported mesh
 * formats, reusing Three.js's bundled exporters. Works for any source format — the
 * webview always ends up with a triangulated `THREE.Object3D`, whether it came from a
 * native mesh loader or OCCT tessellation in the host. `unit` (default
 * `undefined`/`"mm"`, a no-op) applies a real geometric scale before
 * serializing — see `applyExportScale` above.
 */
export async function exportModel(model: THREE.Object3D, format: CadFormat, unit?: DisplayUnit): Promise<ExportedMesh> {
  const target = applyExportScale(model, unit);
  switch (format) {
    case "stl": {
      const view = new STLExporter().parse(target, { binary: true }) as DataView;
      return { data: arrayBufferToBase64(view.buffer), binary: true };
    }
    case "obj": {
      return { data: new OBJExporter().parse(target), binary: false };
    }
    case "ply": {
      return exportPly(target);
    }
    case "gltf": {
      const result = await new GLTFExporter().parseAsync(target, { binary: true });
      return { data: arrayBufferToBase64(result as ArrayBuffer), binary: true };
    }
    case "3mf": {
      // Geometry is already scaled by `applyExportScale`; the unit label must
      // match so the file keeps its real-world size under a correct label.
      const bytes = build3mf(threeMfObjects(target), unit ?? "mm");
      return { data: arrayBufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), binary: true };
    }
    default:
      throw new Error(`Export to "${format}" is not supported.`);
  }
}
