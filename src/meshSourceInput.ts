/**
 * Host-side FE-meshing input for MESH-format sources (STL/OBJ/PLY/glTF and
 * the meshio++ formats), shared by the MCP server and the extension host.
 *
 * This used to be the non-B-rep half of `mcpTools.ts`'s
 * `resolveMeshInputHeadless`, reachable only headlessly. The
 * `cad-preview.exportMesh` command refused every mesh-format source because
 * the extension got that geometry from the webview's serialized STL (roadmap
 * Tier 1 "Parity gaps"). Moving it here — with the file reads and the two
 * meshio conversions injected — lets both layers resolve it the same way:
 * `mcpTools.ts` passes `node:fs` readers and its pipeline, `provider.ts`
 * passes `vscode.workspace.fs` readers and the document-scoped kernel client.
 *
 * WASM-free and vscode-free on purpose: the parse is `meshParse.ts`'s pure
 * `parseToWeldedMesh`, and the meshio conversions go through the injected
 * (kernel-worker) functions, so `provider.ts` can import this without
 * bundling a kernel.
 *
 * Pending mesh edits ARE baked in when the caller supplies `bakeEdits` (the
 * kernel worker's `bakeMeshEdits` — the same three.js engine the webview
 * replays with; roadmap "Headless mesh-edit replay"). Without it, or when the
 * bake fails, the raw file is meshed with a named warning — never a silent
 * raw-file mesh.
 */

import type { FileRoute, MeshParseFormat } from "./fileRouter";
import type { MeshGenerationInput } from "./gmshService";
import type { MeshioCompanion } from "./meshioService";
import type { GltfExternalBuffers } from "./gltfParser";
import type { EditOp, OpOutcome } from "./editOps";
import { parseToWeldedMesh } from "./meshParse";
import { weldedMeshToStlBytes } from "./meshComponents";
import { scaleStlBytes } from "./stlParser";
import { unitScaleFactor, type DisplayUnit } from "./lengthUnits";

export interface MeshSourceInputDeps {
  /** The source file's bytes. */
  readBytes: () => Promise<Uint8Array>;
  /** A glTF's external `.bin` buffers (only called for glTF). */
  resolveGltfBuffers: (bytes: Uint8Array) => Promise<GltfExternalBuffers | undefined>;
  /** A meshio source's sibling files (XDMF `.h5`, GiD `.post.res`, …). */
  resolveMeshioCompanions: (bytes: Uint8Array) => Promise<MeshioCompanion[]>;
  convertToStlBoundary: (bytes: Uint8Array, format: string, sourceName: string, companions: MeshioCompanion[]) => Promise<Uint8Array>;
  convertFoamCaseToStlBoundary: (markerPath: string) => Promise<Uint8Array>;
  /**
   * Replays `ops` over a mesh source and returns the edited model as binary
   * STL (the kernel worker's `bakeMeshEdits`). Optional: without it pending
   * edits are reported as not baked.
   */
  bakeEdits?: (
    bytes: Uint8Array,
    format: "stl" | "obj" | "ply" | "gltf",
    ops: EditOp[],
    externalBuffers?: GltfExternalBuffers
  ) => Promise<{ bytes: Uint8Array; outcomes: OpOutcome[]; messages: string[] }>;
}

/**
 * Bakes `ops` over `bytes` through `deps.bakeEdits`, pushing factual warnings
 * (baked count, each skipped op, engine messages). Returns `undefined` — and
 * the not-baked warning — when there is nothing to bake with or the bake
 * failed, so the caller keeps the raw bytes.
 */
export async function bakeMeshSourceEdits(
  bytes: Uint8Array,
  format: "stl" | "obj" | "ply" | "gltf",
  ops: EditOp[],
  deps: Pick<MeshSourceInputDeps, "bakeEdits">,
  warnings: string[],
  label: string,
  externalBuffers?: GltfExternalBuffers
): Promise<Uint8Array | undefined> {
  if (ops.length === 0) return undefined;
  if (!deps.bakeEdits) {
    warnings.push(`${ops.length} edit op(s) exist but are NOT baked in — ${label}.`);
    return undefined;
  }
  try {
    const result = await deps.bakeEdits(bytes, format, ops, externalBuffers);
    warnings.push(...bakeWarnings(result.outcomes, result.messages, ops.length));
    return result.bytes;
  } catch (err) {
    warnings.push(
      `${ops.length} edit op(s) could NOT be baked (${(err as Error).message}) — ${label}.`
    );
    return undefined;
  }
}

/** Factual warning lines for a bake: how many ops applied, which skipped, and why. */
export function bakeWarnings(outcomes: OpOutcome[], messages: string[], total: number): string[] {
  const skipped = outcomes.filter((o) => !o.applied);
  const out = [`Baked ${total - skipped.length} of ${total} pending mesh edit op(s) headlessly (the same engine the viewer replays with).`];
  for (const o of skipped) {
    out.push(`Edit op #${o.index + 1} (${o.kind}) was skipped — ${o.diagnostic ?? "it did not apply"}.${o.hint ? ` Hint: ${o.hint}` : ""}`);
  }
  for (const m of new Set(messages)) out.push(m);
  return out;
}

/** True for a route this module can resolve (everything but a B-rep source). */
export function isMeshSourceRoute(route: FileRoute): boolean {
  return route.strategy === "meshio" || route.format === "stl" || route.format === "obj" || route.format === "ply" || route.format === "gltf";
}

/**
 * Resolves a mesh-format source to STL meshing input, scaled by `unit`
 * (default native mm). `sourcePath` is the source's filesystem path — its
 * basename is the meshio staging name, and for OpenFOAM it is the `.foam`
 * marker the case is staged from. `ops` is the unbaked edit tail: baked in
 * through `deps.bakeEdits` when given (a meshio source is baked over its
 * converted STL boundary — exactly the `node-0` mesh the viewer edits).
 * Throws for a B-rep route — callers resolve those through the kernel's STEP
 * re-export instead.
 */
export async function resolveMeshSourceInput(
  route: FileRoute,
  sourcePath: string,
  ops: EditOp[],
  deps: MeshSourceInputDeps,
  warnings: string[],
  unit: DisplayUnit = "mm"
): Promise<MeshGenerationInput> {
  if (!isMeshSourceRoute(route)) {
    throw new Error(`${route.format} is not a mesh-format source — resolve it through the B-rep STEP re-export.`);
  }
  const notBaked =
    route.strategy === "meshio"
      ? "the raw file's boundary surface is meshed"
      : `the raw ${route.format.toUpperCase()} file bytes are meshed`;
  let stlBytes: Uint8Array;
  if (route.strategy === "meshio") {
    // meshio++ runs host-side: converted to an STL boundary surface and meshed
    // like a native `.stl`. OpenFOAM's `.foam` marker holds no mesh — the case
    // lives under `<parent>/constant/polyMesh/`, so it is staged from the path.
    if (route.format === "openfoam") {
      stlBytes = await deps.convertFoamCaseToStlBoundary(sourcePath);
    } else {
      const bytes = await deps.readBytes();
      const companions = await deps.resolveMeshioCompanions(bytes);
      stlBytes = await deps.convertToStlBoundary(bytes, route.format, baseName(sourcePath), companions);
    }
    stlBytes = (await bakeMeshSourceEdits(stlBytes, "stl", ops, deps, warnings, notBaked)) ?? stlBytes;
  } else if (route.format === "stl") {
    const raw = await deps.readBytes();
    stlBytes = (await bakeMeshSourceEdits(raw, "stl", ops, deps, warnings, notBaked)) ?? raw;
  } else {
    const bytes = await deps.readBytes();
    const format = route.format as MeshParseFormat;
    const external = format === "gltf" ? await deps.resolveGltfBuffers(bytes) : undefined;
    stlBytes =
      (await bakeMeshSourceEdits(bytes, format, ops, deps, warnings, notBaked, external)) ??
      weldedMeshToStlBytes(parseToWeldedMesh(bytes, format, external));
  }
  const factor = unitScaleFactor(unit);
  return { kind: "stl", stlBytes: factor === 1 ? stlBytes : scaleStlBytes(stlBytes, factor) };
}

function baseName(p: string): string {
  return p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
}
