import type { EditOp, PointRefs, Vec3 } from "./editOps";
import { setVec3Slot } from "./editOps";

/**
 * Pure helpers over the kernel's {@link PointRefResolution}s (roadmap "Define
 * lines, arcs and curves from preexisting points"): writing the resolved
 * positions back into the stored ops as each reference's `at` anchor, and
 * rendering rebinds as warnings. Kept free of OCCT/vscode so both the headless
 * MCP tools and the unit tests use it directly.
 */

/** Structural twin of `PointRefResolution` (`occtOperations.ts`) — duplicated so this module stays OCCT-free. */
export interface PointRefHit { opIndex: number; slot: string; id: string; position: Vec3; rebound?: { from: string }; }

const SAME_POSITION_EPS = 1e-9;

function samePosition(a: Vec3 | undefined, b: Vec3): boolean {
  return !!a && Math.abs(a[0] - b[0]) <= SAME_POSITION_EPS && Math.abs(a[1] - b[1]) <= SAME_POSITION_EPS && Math.abs(a[2] - b[2]) <= SAME_POSITION_EPS;
}

/**
 * Returns `ops` with every resolved reference's `id` and `at` brought up to
 * date (a bare id gains its `at`; a rebound id is rewritten to the point it
 * now names) and `changed` = whether anything differed. `indexOffset` maps the
 * resolutions' replay-relative `opIndex` onto `ops` (the baked-prefix length
 * when only the tail was replayed). Ops that need no change keep their object
 * identity; changed ops are copies, so a caller's list is never mutated.
 */
export function applyPointRefWriteback(
  ops: EditOp[], hits: readonly PointRefHit[], indexOffset = 0
): { ops: EditOp[]; changed: boolean } {
  let out: EditOp[] | null = null;
  for (const hit of hits) {
    const i = hit.opIndex + indexOffset;
    const base = (out ?? ops)[i];
    if (!base || !base.pointRefs) continue;
    const ref = base.pointRefs[hit.slot];
    if (!ref) continue;
    if (ref.id === hit.id && samePosition(ref.at, hit.position)) continue;
    if (!out) out = ops.slice();
    const next: EditOp = JSON.parse(JSON.stringify(base));
    const refs: PointRefs = next.pointRefs as PointRefs;
    refs[hit.slot] = { id: hit.id, at: [hit.position[0], hit.position[1], hit.position[2]] };
    setVec3Slot(next, hit.slot, hit.position);
    out[i] = next;
  }
  return { ops: out ?? ops, changed: out !== null };
}

/** One warning per rebound reference — a stored id that no longer sat at its authored position and was re-anchored by position. */
export function pointRefRebindWarnings(hits: readonly PointRefHit[], ops: readonly EditOp[], indexOffset = 0): string[] {
  const out: string[] = [];
  for (const hit of hits) {
    if (!hit.rebound) continue;
    const kind = ops[hit.opIndex + indexOffset]?.op ?? "op";
    out.push(`op ${hit.opIndex + indexOffset} (${kind}): ${hit.rebound.from} (${hit.slot}) was no longer at its authored position — re-anchored to ${hit.id} by position.`);
  }
  return out;
}
