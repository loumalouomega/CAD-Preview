/**
 * Quotable entity references (roadmap "Quotable entity references for agent
 * chats") — pure, DOM-free, unit-tested.
 *
 * The MCP server is a separate process and cannot see what the user selected,
 * so telling an agent "this face" used to mean reading an id off the hover
 * tooltip and typing it. A reference is one self-describing line per entity:
 *
 *   examples/STP/bull.stp#face-12 — planar, 8,119.27 mm² (valid for 3 ops)
 *
 * **The op count is part of the reference, not decoration.** Entity ids are
 * positional (an index into the shape as it exists after N ops), so a bare id is
 * meaningful only against the op list it was read from. The line says which, and
 * an agent resolves it against exactly that state (`render_ops_prefix` /
 * `inspect` after the same number of ops).
 */
import type { EntityFacts } from "../entityFacts";
import { summaryLine } from "./entityExplain";
import type { OpBucket } from "../opBuckets";
import type { SelectorQuery } from "../selectorQuery";

export interface EntityReferenceInput {
  /** Workspace-relative path when the file is inside a workspace folder, else the full path. */
  path: string;
  entityId: string;
  /** Length of the full op list the id was read against (baked ops included). */
  opCount: number;
  /** Facts the inspector already fetched for this entity, if any — never fetched just for a copy. */
  facts?: EntityFacts | null;
  /** Stored query that re-derives this face by role, when one was synthesized — appended as compact JSON so the reference survives renumbering. */
  query?: SelectorQuery | null;
}

/**
 * The (op, role) bucket a face id can be synthesized from, or null. Ids in a
 * bucket are valid only against that op's own state, so only the LAST bucket
 * qualifies: any later topology-changing op may have renumbered the id, and a
 * query synthesized against the wrong face would be a confident lie.
 */
export function producingBucketFor(buckets: readonly OpBucket[] | null | undefined, faceId: string): { op: number; role: string } | null {
  if (!buckets || buckets.length === 0 || !faceId.startsWith("face-")) return null;
  const last = buckets.reduce((a, b) => (b.op > a.op ? b : a));
  for (const [role, ids] of Object.entries(last.roles)) if (ids.includes(faceId)) return { op: last.op, role };
  return null;
}

/** One reference line. Facts are included only when supplied; nothing is guessed. */
export function formatEntityReference(input: EntityReferenceInput): string {
  const { path, entityId, opCount, facts } = input;
  const noun = opCount === 1 ? "op" : "ops";
  let detail = "";
  if (facts && facts.entityId === entityId) {
    const s = summaryLine(facts);
    detail = ` — ${[s.descriptor, s.measure].filter(Boolean).join(", ")}`;
  }
  const q = input.query ? ` — query ${JSON.stringify(input.query)}` : "";
  return `${path}#${entityId}${detail} (valid for ${opCount} ${noun})${q}`;
}

/**
 * References for a whole selection, one line per entity in the given order.
 * The caller is responsible for putting the right-clicked entity first/only;
 * this just formats and de-duplicates.
 */
export function formatEntityReferences(inputs: readonly EntityReferenceInput[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const i of inputs) {
    if (seen.has(i.entityId)) continue;
    seen.add(i.entityId);
    lines.push(formatEntityReference(i));
  }
  return lines.join("\n");
}
