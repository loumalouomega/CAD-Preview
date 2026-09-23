/**
 * Simulation handoff manifest (roadmap "Simulation handoff manifest and
 * boundary coverage") — a receipt written beside an exported mesh as
 * `<output>.handoff.json`, recording what produced it and how the model's
 * Parts landed in the mesh. Pure: facts in, JSON out. It is NOT a document
 * sidecar (nothing reads it back on open); `check_handoff_manifest` re-derives
 * the source and replay fingerprints to say whether it still describes the
 * current model.
 *
 * Coverage is reported, never judged: an empty Part, a Part whose ids resolved
 * to nothing, a boundary surface in no surface group, or an entity in two
 * groups are all listed as facts — whether they matter is the solver setup's
 * call, not this file's.
 */
import { sha256Hex } from "./hash";
import type { HandoffFacts } from "./gmshService";
import type { KernelVersions } from "./kernelVersions";
import type { MeshOptions } from "./meshOptions";
import type { Part } from "./protocol";

export const HANDOFF_MANIFEST_VERSION = 1;
export const HANDOFF_MANIFEST_SUFFIX = ".handoff.json";

export interface ManifestPart {
  name: string;
  requested: { volumes: number; surfaces: number; lines: number; points: number };
  /** "empty": no ids at all; "unresolved": ids that landed in no physical group; "resolved": at least one group. */
  status: "resolved" | "unresolved" | "empty";
  groups: Array<{ dim: number; physicalTag: number; entityCount: number; elementCount: number }>;
  subModelPart?: { nodeCount: number; volumeCellCount: number; surfaceCellCount: number };
}

export interface HandoffManifest {
  version: number;
  kind: "cad-preview-handoff";
  createdAt: string;
  source: { path: string; format: string; sha256: string };
  replay: { opCount: number; bakedThrough: number; fingerprint: string; editsBaked: boolean };
  /** Stated once: `meshOptions` sizes are native mm; geometry AND sizes were scaled by `scaleFactor` into `unit` at export. */
  unit: { unit: string; scaleFactor: number };
  meshOptions: MeshOptions;
  engineUsed: string;
  kernels: KernelVersions;
  outputs: Array<{ path: string; format: string; sha256: string }>;
  mesh: { nodeCount: number; elementCount: number };
  parts: ManifestPart[];
  coverage: {
    emptyParts: string[];
    unresolvedParts: string[];
    unassignedSurfaceCount: number;
    unassignedSurfaceTags: number[];
    overlaps: Array<{ dim: number; entityTag: number; groups: string[] }>;
  };
  notes: string[];
}

/** Stable fingerprint of the op list a replay would apply (order- and value-sensitive). */
export function replayFingerprint(ops: readonly unknown[], bakedThrough: number): string {
  return sha256Hex(new TextEncoder().encode(JSON.stringify({ ops, bakedThrough })));
}

export interface ManifestInput {
  createdAt: string;
  source: { path: string; format: string; bytes: Uint8Array };
  ops: readonly unknown[];
  bakedThrough: number;
  editsBaked: boolean;
  unit: string;
  scaleFactor: number;
  meshOptions: MeshOptions;
  kernels: KernelVersions;
  outputs: Array<{ path: string; format: string; bytes: Uint8Array }>;
  parts: readonly Part[];
  facts: HandoffFacts;
  notes?: string[];
}

export function buildHandoffManifest(input: ManifestInput): HandoffManifest {
  const { facts } = input;
  const parts: ManifestPart[] = input.parts.map((p) => {
    const requested = { volumes: p.volumes.length, surfaces: p.surfaces.length, lines: p.lines.length, points: p.points.length };
    const total = requested.volumes + requested.surfaces + requested.lines + requested.points;
    const groups = facts.groups
      .filter((g) => g.name === p.name)
      .map((g) => ({ dim: g.dim, physicalTag: g.physicalTag, entityCount: g.entityTags.length, elementCount: g.elementCount }));
    const smp = facts.subModelParts?.find((s) => s.name === p.name);
    return {
      name: p.name,
      requested,
      status: total === 0 ? "empty" : groups.length === 0 ? "unresolved" : "resolved",
      groups,
      ...(smp ? { subModelPart: { nodeCount: smp.nodeCount, volumeCellCount: smp.volumeCellCount, surfaceCellCount: smp.surfaceCellCount } } : {}),
    };
  });
  const notes = [...(input.notes ?? []), ...facts.warnings];
  if (input.scaleFactor !== 1) {
    notes.push(`Geometry and mesh sizes were scaled by ${input.scaleFactor} (mm → ${input.unit}) at export; meshOptions are recorded in native mm.`);
  }
  return {
    version: HANDOFF_MANIFEST_VERSION,
    kind: "cad-preview-handoff",
    createdAt: input.createdAt,
    source: { path: input.source.path, format: input.source.format, sha256: sha256Hex(input.source.bytes) },
    replay: {
      opCount: input.ops.length,
      bakedThrough: input.bakedThrough,
      fingerprint: replayFingerprint(input.ops, input.bakedThrough),
      editsBaked: input.editsBaked,
    },
    unit: { unit: input.unit, scaleFactor: input.scaleFactor },
    meshOptions: input.meshOptions,
    engineUsed: facts.engineUsed,
    kernels: input.kernels,
    outputs: input.outputs.map((o) => ({ path: o.path, format: o.format, sha256: sha256Hex(o.bytes) })),
    mesh: { nodeCount: facts.nodeCount, elementCount: facts.elementCount },
    parts,
    coverage: {
      emptyParts: parts.filter((p) => p.status === "empty").map((p) => p.name),
      unresolvedParts: parts.filter((p) => p.status === "unresolved").map((p) => p.name),
      unassignedSurfaceCount: facts.unassignedSurfaceTags.length,
      unassignedSurfaceTags: facts.unassignedSurfaceTags,
      overlaps: facts.overlaps,
    },
    notes,
  };
}

export function serializeHandoffManifest(m: HandoffManifest): string {
  return JSON.stringify(m, null, 2) + "\n";
}

/** Tolerant read: returns null for anything that is not a v1 handoff manifest. */
export function parseHandoffManifest(text: string): HandoffManifest | null {
  try {
    const raw = JSON.parse(text) as Partial<HandoffManifest>;
    if (raw?.kind !== "cad-preview-handoff" || typeof raw.version !== "number") return null;
    if (!raw.source || typeof raw.source.sha256 !== "string" || !raw.replay || typeof raw.replay.fingerprint !== "string") return null;
    return raw as HandoffManifest;
  } catch {
    return null;
  }
}

export interface ManifestCheck {
  current: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

/** Compares a manifest against freshly re-derived fingerprints; `null` means "could not be read". */
export function checkHandoffManifest(
  m: HandoffManifest,
  now: { sourceSha256: string | null; replayFingerprint: string | null; outputs: Array<{ path: string; sha256: string | null }> }
): ManifestCheck {
  const checks: ManifestCheck["checks"] = [];
  checks.push(
    now.sourceSha256 === null
      ? { name: "source", ok: false, detail: `source ${m.source.path} could not be read` }
      : now.sourceSha256 === m.source.sha256
        ? { name: "source", ok: true, detail: "source bytes unchanged" }
        : { name: "source", ok: false, detail: "source bytes changed since export" }
  );
  checks.push(
    now.replayFingerprint === null
      ? { name: "edits", ok: false, detail: "edits sidecar could not be read" }
      : now.replayFingerprint === m.replay.fingerprint
        ? { name: "edits", ok: true, detail: "edit history unchanged" }
        : { name: "edits", ok: false, detail: "edit history changed since export (ops added, removed, edited, or baked)" }
  );
  for (const o of m.outputs) {
    const cur = now.outputs.find((x) => x.path === o.path);
    const sha = cur?.sha256 ?? null;
    checks.push(
      sha === null
        ? { name: `output ${o.path}`, ok: false, detail: "output missing or unreadable" }
        : sha === o.sha256
          ? { name: `output ${o.path}`, ok: true, detail: "output unchanged" }
          : { name: `output ${o.path}`, ok: false, detail: "output modified after export" }
    );
  }
  return { current: checks.every((c) => c.ok), checks };
}
