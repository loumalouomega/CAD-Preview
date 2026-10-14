/**
 * Software-rendered snapshots of mesh sources via meshio++'s deterministic
 * rasterizer (`render_snapshot` for stl/obj/ply/gltf). No WebGL, Chromium or
 * Playwright, so it works wherever the kernel worker does.
 *
 * Deliberately a SEPARATE engine from the Playwright viewer render, never a
 * silent substitute for it: results carry `engine: "meshio-software"`, the
 * picture is of the raw file's triangles (pending edit ops are not baked), and
 * viewer-only options (focus/hide/clip/display modes) are not honoured — the
 * tool says so in `warnings`.
 */

import { getMeshio, componentMesh, wrapMeshioFault } from "./meshioService";
import { parseToWeldedMesh } from "./meshHeal";
import type { GltfExternalBuffers } from "./gltfParser";
import type { MeshParseFormat } from "./fileRouter";

export interface SoftwareRenderView {
  label: string;
  /** meshio++ `RenderOptions.view`: the side the camera sits on. */
  side: "iso" | "+x" | "-x" | "+y" | "-y" | "+z" | "-z";
}

/** Axes are the FILE's own (a mesh has no up-axis convention), so labels name the axis. */
export const SOFTWARE_DEFAULT_VIEWS: SoftwareRenderView[] = [
  { label: "ISO", side: "iso" },
  { label: "+Z", side: "+z" },
  { label: "-Y", side: "-y" },
  { label: "+X", side: "+x" },
];

export interface SoftwareRenderResult {
  triangleCount: number;
  images: Array<{ label: string; mimeType: "image/png"; dataBase64: string }>;
  warnings: string[];
}

export async function renderMeshSoftware(
  bytes: Uint8Array,
  format: MeshParseFormat,
  options: { views?: SoftwareRenderView[]; width?: number; height?: number; wireframe?: boolean } = {},
  external?: GltfExternalBuffers
): Promise<SoftwareRenderResult> {
  const width = Math.min(1600, Math.max(64, Math.floor(options.width ?? 640)));
  const height = Math.min(1600, Math.max(64, Math.floor(options.height ?? 480)));
  const views = options.views && options.views.length > 0 ? options.views : SOFTWARE_DEFAULT_VIEWS;
  const { positions, indices } = parseToWeldedMesh(bytes, format, external);
  const triangleCount = indices.length / 3;
  if (triangleCount === 0) throw new Error("The mesh has no triangles to render.");
  const m = await getMeshio();
  try {
    const { mesh } = componentMesh(positions, indices, Array.from({ length: triangleCount }, (_, i) => i));
    const images = views.map((v) => {
      const png: Uint8Array = m.renderPng(
        mesh,
        { width, height, view: v.side, shading: "smooth", edges: options.wireframe ? "all" : "feature", axes: false },
        6
      );
      return { label: v.label, mimeType: "image/png" as const, dataBase64: Buffer.from(png).toString("base64") };
    });
    return { triangleCount, images, warnings: [] };
  } catch (err) {
    throw wrapMeshioFault(err);
  }
}
