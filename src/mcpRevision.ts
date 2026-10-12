/**
 * Optimistic revision guard for MCP sidecar writes (node-fs, no MCP SDK, no
 * WASM, no vscode).
 *
 * The interactive editor already detects a disk change that races a pending
 * local edit (`sidecarRevision.ts`). The MCP server did not: two callers that
 * read the same op list and both append silently lost one op. Now `get_state`
 * reports a `revision` per sidecar (the same sha256 {@link fingerprint} the
 * editor uses), every guarded write tool accepts an optional
 * `expectedRevision`, and a mismatch is refused with the coded error
 * `stale-revision` carrying the current revision. Omitting it keeps the
 * previous last-writer-wins behaviour.
 *
 * Honest limits: the lock below serialises guarded calls inside ONE server
 * process (check + handler + write happen under it). A second MCP server
 * process, or the VS Code editor writing the same file, can still race —
 * the same stated TOCTOU limit as `sidecarRevision.ts`; this is detection,
 * not a cross-process transaction.
 */
import * as fs from "fs/promises";
import * as path from "path";
import { fingerprint, type SidecarKind } from "./sidecarRevision";
import {
  annotationsSidecarPath,
  editsSidecarPath,
  layersSidecarPath,
  meshOptionsSidecarPath,
  partsSidecarPath,
  planesSidecarPath,
} from "./mcpSidecars";

/** The sidecar each guarded tool writes. A tool's primary sidecar only:
 * incidental rebind writes (e.g. `apply_edit_ops` re-pointing Parts) are
 * covered by the edits guard, not guarded independently. */
export const REVISION_GUARDED_TOOLS: Readonly<Record<string, SidecarKind>> = {
  apply_edit_ops: "edits",
  run_parametric_script: "edits",
  remove_edit_op: "edits",
  set_variables: "edits",
  set_part: "parts",
  set_plane: "planes",
  set_layer: "layers",
  assign_layer: "layers",
  pin_annotation: "annotations",
  set_mesh_options: "mesh",
  apply_mesh_preset: "mesh",
};

export const SIDECAR_REVISION_KINDS: readonly SidecarKind[] = ["edits", "parts", "layers", "planes", "annotations", "mesh"];

function sidecarPathFor(modelPath: string, kind: SidecarKind): string {
  switch (kind) {
    case "edits":
      return editsSidecarPath(modelPath);
    case "parts":
      return partsSidecarPath(modelPath);
    case "layers":
      return layersSidecarPath(modelPath);
    case "planes":
      return planesSidecarPath(modelPath);
    case "annotations":
      return annotationsSidecarPath(modelPath);
    case "mesh":
      return meshOptionsSidecarPath(modelPath);
  }
}

/** Current revision of one sidecar: sha256 of its bytes, or `"absent"`. */
export async function currentRevision(modelPath: string, kind: SidecarKind): Promise<string> {
  try {
    return fingerprint(await fs.readFile(sidecarPathFor(modelPath, kind)));
  } catch {
    return fingerprint(null);
  }
}

/** Revision of every sidecar kind, as `get_state` reports them. */
export async function revisionsOf(modelPath: string): Promise<Record<SidecarKind, string>> {
  const out = {} as Record<SidecarKind, string>;
  for (const kind of SIDECAR_REVISION_KINDS) out[kind] = await currentRevision(modelPath, kind);
  return out;
}

/** Thrown when a write's `expectedRevision` no longer matches the sidecar.
 * Classified by `name` in `mcpErrors.ts` (which does not import this module). */
export class StaleRevisionError extends Error {
  constructor(
    readonly kind: SidecarKind,
    readonly expectedRevision: string,
    readonly currentRevision: string
  ) {
    super(
      `The ${kind} sidecar changed since revision ${expectedRevision.slice(0, 12)}… (current ${currentRevision.slice(0, 12)}…) — refusing the write so a concurrent change is not silently overwritten.`
    );
    this.name = "StaleRevisionError";
  }
}

/** Throws {@link StaleRevisionError} unless `expected` matches the sidecar now. */
export async function assertRevision(modelPath: string, kind: SidecarKind, expected: string): Promise<void> {
  const current = await currentRevision(modelPath, kind);
  if (current !== expected) throw new StaleRevisionError(kind, expected, current);
}

const tails = new Map<string, Promise<unknown>>();

/** Runs `fn` after every earlier call with the same key has settled (success
 * or failure), so a check-then-write sequence is atomic against other callers
 * in this process. The map entry is dropped once the chain is idle. */
export function withSidecarLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

export function lockKey(modelPath: string, kind: SidecarKind): string {
  return `${path.resolve(modelPath)}\u0000${kind}`;
}
