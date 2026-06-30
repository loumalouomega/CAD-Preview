import { validateEditOp, type EditOp } from "./editOps";

/**
 * Pure (vscode-free) parse/serialize for the edits sidecar `<model>.edits.json`
 * — unit-testable. Mirrors `partsSidecar.ts`. The sidecar holds the ordered,
 * replayable op-list; the source CAD file is never modified.
 */

export const EDITS_SIDECAR_VERSION = 1;

interface EditsSidecarFile {
  version: number;
  source: string;
  ops: EditOp[];
}

/**
 * Parses + validates sidecar JSON into a clean `EditOp[]`. Tolerant: malformed
 * ops are dropped (via {@link validateEditOp}) rather than throwing, so a
 * hand-edited or partially-corrupt sidecar never blocks opening the model. Op
 * order is preserved — replay depends on it.
 */
export function parseEditsJson(text: string): EditOp[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const rawOps = (data as Partial<EditsSidecarFile> | null)?.ops;
  if (!Array.isArray(rawOps)) return [];

  const ops: EditOp[] = [];
  for (const raw of rawOps) {
    const op = validateEditOp(raw);
    if (op) ops.push(op);
  }
  return ops;
}

/** Serializes ops to the sidecar JSON text (pretty-printed, trailing newline). */
export function serializeEditsJson(sourceName: string, ops: EditOp[]): string {
  const file: EditsSidecarFile = { version: EDITS_SIDECAR_VERSION, source: sourceName, ops };
  return JSON.stringify(file, null, 2) + "\n";
}
