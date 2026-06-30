import * as THREE from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { OBJExporter } from "three/examples/jsm/exporters/OBJExporter.js";
import { PLYExporter } from "three/examples/jsm/exporters/PLYExporter.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import type { CadFormat } from "../fileRouter";

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
 * Serializes the currently displayed Three.js model to one of the supported mesh
 * formats, reusing Three.js's bundled exporters. Works for any source format — the
 * webview always ends up with a triangulated `THREE.Object3D`, whether it came from a
 * native mesh loader or OCCT tessellation in the host.
 */
export async function exportModel(model: THREE.Object3D, format: CadFormat): Promise<ExportedMesh> {
  switch (format) {
    case "stl": {
      const view = new STLExporter().parse(model, { binary: true }) as DataView;
      return { data: arrayBufferToBase64(view.buffer), binary: true };
    }
    case "obj": {
      return { data: new OBJExporter().parse(model), binary: false };
    }
    case "ply": {
      return exportPly(model);
    }
    case "gltf": {
      const result = await new GLTFExporter().parseAsync(model, { binary: true });
      return { data: arrayBufferToBase64(result as ArrayBuffer), binary: true };
    }
    default:
      throw new Error(`Export to "${format}" is not supported.`);
  }
}
