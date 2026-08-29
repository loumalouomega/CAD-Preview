/**
 * DXF import — roadmap Tier 2 #1 Phase 1, closed. Pure, vscode/DOM-free
 * (no `DOMParser` — this project's vitest config has no jsdom, same reasoning
 * as `svgImport.ts`'s regex-based `<path d>` extraction). DXF is plain ASCII
 * group-code/value text, so a line-pair scan is sufficient and keeps the
 * module unit-testable headless.
 *
 * Genuinely no new kernel surface: the output is a list of `EditOp` objects
 * fed into the EXISTING `addLine`/`addPolyline`/`addCircleProfile`/`addArc`/
 * `addSpline` ops (`editOps.ts`) by the webview wiring (`main.ts`), exactly
 * as `svgImport.ts` does for `<path>` — this module never touches OCCT or
 * the mesh engine.
 *
 * **Scope, stated plainly, not a silent gap**: only model-space `ENTITIES`
 * (AutoCAD R12/2000 ASCII DXF, group-code/value pairs) are read. Blocks,
 * layers, INSERT, TEXT/MTEXT, DIMENSION, HATCH, 3D solids, paper-space
 * viewports, and `transform` are not applied — an entity drawn inside a
 * block/INSERT imports at its raw coordinates, same limitation as
 * `svgImport.ts`'s untransformed `<path>`. Only `LINE`, `LWPOLYLINE` (with
 * bulge arcs), `POLYLINE`/`VERTEX`/`SEQEND`, `CIRCLE`, `ARC`, and `SPLINE`
 * (control points) are handled; everything else is skipped. All geometry is
 * placed flat in the XY plane at z=0, 1 DXF drawing unit = 1mm, **Y-up native**
 * (no Y-negation — DXF is already Y-up, unlike SVG's Y-down), matching this
 * codebase's cascade unit. A poorly-scaled source is fixed afterward with the
 * EXISTING `scale`/`translate`/`rotate` ops, same as any other placement tweak.
 */

import type { EditOp } from "./editOps";
import type { Vec3 } from "./editOps";

type Point2 = [number, number];

export interface DxfParseResult {
  /** EditOps ready to push (already valid per `validateEditOp` where applicable). */
  ops: EditOp[];
  /** Human-readable warnings (e.g. skipped entities). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Low-level group-code/value pair extraction

interface RawEntity {
  type: string;
  pairs: Array<[number, string]>;
}

function extractPairs(text: string): Array<[number, string]> {
  // Split on any newline, keep empty trailing lines harmless — DXF is
  // code-line / value-line pairs, so an odd trailing line is ignored.
  const lines = text.split(/\r?\n/);
  const pairs: Array<[number, string]> = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const codeStr = lines[i].trim();
    if (codeStr === "") continue;
    const code = parseInt(codeStr, 10);
    if (Number.isNaN(code)) continue;
    const value = lines[i + 1].trim();
    // Value may legitimately be "" for some codes, but DXF pairs with an
    // empty value are still meaningful (don't skip).
    pairs.push([code, value]);
  }
  return pairs;
}

function findEntitiesRange(pairs: Array<[number, string]>): { start: number; end: number } | null {
  let startIdx: number | null = null;
  // Find "SECTION" -> "ENTITIES" start
  for (let i = 0; i < pairs.length - 1; i++) {
    const [code, value] = pairs[i];
    if (code === 0 && value === "SECTION") {
      const next = pairs[i + 1];
      if (next && next[0] === 2 && next[1].trim() === "ENTITIES") {
        startIdx = i + 2;
        break;
      }
    }
  }
  if (startIdx === null) {
    // No ENTITIES section header — some minimal DXF files omit SECTION/HEADER
    // entirely and just emit entities. Fall back to scanning all pairs for
    // entity starts, but still avoid false positives in a HEADER TABLE section.
    // We treat the whole file as the entities range so tests with bare entities
    // still work.
    let hasSection = false;
    for (const [c, v] of pairs) if (c === 0 && v === "SECTION") { hasSection = true; break; }
    if (!hasSection) return { start: 0, end: pairs.length };
    return null;
  }
  let endIdx = pairs.length;
  for (let i = startIdx; i < pairs.length; i++) {
    const [code, value] = pairs[i];
    if (code === 0 && value === "ENDSEC") { endIdx = i; break; }
    if (code === 0 && value === "EOF") { endIdx = i; break; }
  }
  return { start: startIdx, end: endIdx };
}

function splitRawEntities(pairs: Array<[number, string]>, range: { start: number; end: number }): RawEntity[] {
  const entities: RawEntity[] = [];
  let current: RawEntity | null = null;
  for (let i = range.start; i < range.end; i++) {
    const [code, value] = pairs[i];
    if (code === 0) {
      if (current) entities.push(current);
      current = { type: value.trim(), pairs: [] };
    } else {
      if (!current) continue; // stray pairs before first 0/type
      current.pairs.push([code, value]);
    }
  }
  if (current) entities.push(current);
  return entities;
}

// Helpers to read typed values from a RawEntity's pairs
function firstValue(entity: RawEntity, code: number): string | undefined {
  for (const [c, v] of entity.pairs) if (c === code) return v;
  return undefined;
}

function allValues(entity: RawEntity, code: number): string[] {
  const out: string[] = [];
  for (const [c, v] of entity.pairs) if (c === code) out.push(v);
  return out;
}

function parseDouble(s: string | undefined, fallback: number): number {
  if (s === undefined) return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

function parseIntCode(s: string | undefined, fallback: number): number {
  if (s === undefined) return fallback;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Bulge -> arc conversion
// DXF LWPOLYLINE / POLYLINE VERTEX bulge = tan(theta/4), where theta is the
// included angle. Positive bulge => arc bulges to the left of the segment
// direction. We compute the arc centre/radius/angles for an XY-plane arc
// (normal [0,0,1]) and map to addArc's CCW-about-normal convention.

function bulgeToArc(p0: Point2, p1: Point2, bulge: number): { center: Point2; radius: number; startAngleDeg: number; endAngleDeg: number } | null {
  if (bulge === 0) return null;
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const chordLen = Math.hypot(dx, dy);
  if (chordLen < 1e-9) return null;
  const bAbs = Math.abs(bulge);
  // Included angle magnitude
  // Use derived formulas via radius/centre without explicitly computing theta
  // to avoid atan small-angle loss: radius = chord * (1+b^2)/(4|b|)
  const radius = chordLen * (1 + bAbs * bAbs) / (4 * bAbs);
  if (!Number.isFinite(radius) || radius <= 0) return null;
  const mid: Point2 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  const half = chordLen / 2;
  const distCenterToMid = Math.sqrt(Math.max(0, radius * radius - half * half));
  // Unit left normal of chord direction
  const ux = -dy / chordLen;
  const uy = dx / chordLen;
  // Positive bulge => arc left of direction => centre right of chord (south for east chord)
  const sign = Math.sign(bulge);
  const cx = mid[0] - ux * distCenterToMid * sign;
  const cy = mid[1] - uy * distCenterToMid * sign;
  const a0 = (Math.atan2(p0[1] - cy, p0[0] - cx) * 180) / Math.PI;
  const a1 = (Math.atan2(p1[1] - cy, p1[0] - cx) * 180) / Math.PI;
  // Normalize to [0,360) for comparison, but keep signed for addArc which
  // allows any degree and wraps CCW.
  // The bulge arc's minor side is the bulge side; the CCW direction from a0
  // to a1 depends on which side the centre is. For positive bulge (centre
  // south of east chord), the minor north arc is CLOCKWISE (a0 135° -> 45°
  // CCW is 270° major, CW is 90° minor). addArc's convention is CCW, so
  // we must ensure the CCW sweep equals the minor angle when bulge>0.
  // Detect by computing both sweeps: ccw = (a1 - a0) normalized to (0,360),
  // cw = 360 - ccw. The bulge's included angle magnitude is 4*atan(|b|).
  const thetaDeg = (4 * Math.atan(bAbs) * 180) / Math.PI; // 0..360, but for |b|<=1, 0..180; for |b|>1, 180..360
  // Determine which sweep matches theta (minor vs major depends on |b|<=1 vs >1).
  // For |b| <=1, theta <=180 and we expect minor arc = theta. For |b|>1, theta>180
  // and the minor bulge still corresponds to theta, which is >180, so the arc
  // itself is major (>180) — still the bulge side is theta CCW or CW?
  // Simpler: decide desired CCW sweep: if bulge>0, the minor/major on the left
  // side corresponds to a CW sweep when centre south (above gives). So desired
  // CCW is 360 - theta. For bulge<0, CCW is theta.
  // Check: b=0.5 positive theta~106°, centre south, cw 106° is bulge north, ccw 254° major. So desired CCW for positive bulge is 360-theta.
  // For b=-0.5 negative theta~106°, centre north, cw 254° not bulge, ccw 106° is bulge south? Wait b negative bulges right (south for east chord), south bulge with centre north gives ccw? Let's see centre north case a0 -135°(225°) a1 -45°(315°), ccw 225->315 is 90°? Actually 225 to 315 ccw 90° (south side minor). That's bulge south minor CW? Hmm we need empirical.
  // Instead of reasoning, determine ccw sweep for our computed a0,a1 and compare
  // which of ccw/cw equals theta (within tolerance) — that tells which direction
  // is the bulge side.
  let ccw = a1 - a0;
  while (ccw < 0) ccw += 360;
  while (ccw >= 360) ccw -= 360;
  if (ccw === 0) ccw = 360;
  const cw = 360 - ccw;
  // theta is the included angle on bulge side (0..360)
  // If bulge positive and our centre south gave ccw=254°, cw=106°=theta, then
  // the bulge side is cw, not ccw. So to express as a CCW addArc, we must swap
  // start/end so CCW becomes the bulge side.
  const eps = 1e-6;
  const matchesCcw = Math.abs(ccw - thetaDeg) < 1e-4 || Math.abs(ccw - (360 - thetaDeg)) < 1e-4; // tolerate?
  // Actually ccw should be either theta or 360-theta. We want ccw == theta when bulge side is CCW.
  // Our computed ccw is directly from geometry. If abs(ccw - theta) < eps, bulge is CCW as is.
  // If abs(cw - theta) < eps (i.e. abs(ccw - (360-theta))<eps), bulge is CW, need swap.
  if (Math.abs(ccw - thetaDeg) < 1e-3) {
    // CCW already matches theta — keep a0->a1
    return { center: [cx, cy], radius, startAngleDeg: a0, endAngleDeg: a1 };
  } else if (Math.abs(cw - thetaDeg) < 1e-3) {
    // CW matches theta — swap to make CCW the bulge side
    return { center: [cx, cy], radius, startAngleDeg: a1, endAngleDeg: a0 };
  } else {
    // Fallback: choose the direction matching theta more closely
    if (Math.abs(ccw - thetaDeg) < Math.abs(cw - thetaDeg)) {
      return { center: [cx, cy], radius, startAngleDeg: a0, endAngleDeg: a1 };
    } else {
      return { center: [cx, cy], radius, startAngleDeg: a1, endAngleDeg: a0 };
    }
  }
}

function pointsEqual(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function hasRepeatedConsecutive(points: Vec3[]): boolean {
  for (let i = 1; i < points.length; i++) if (pointsEqual(points[i], points[i - 1])) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Entity handlers

function handleLine(entity: RawEntity, ops: EditOp[]): void {
  const x1 = parseDouble(firstValue(entity, 10), NaN);
  const y1 = parseDouble(firstValue(entity, 20), NaN);
  const x2 = parseDouble(firstValue(entity, 11), NaN);
  const y2 = parseDouble(firstValue(entity, 21), NaN);
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) return;
  const start: Vec3 = [x1, y1, 0];
  const end: Vec3 = [x2, y2, 0];
  if (pointsEqual(start, end)) return;
  ops.push({ op: "addLine", start, end });
}

function handleCircle(entity: RawEntity, ops: EditOp[]): void {
  const cx = parseDouble(firstValue(entity, 10), NaN);
  const cy = parseDouble(firstValue(entity, 20), NaN);
  const r = parseDouble(firstValue(entity, 40), NaN);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r) || r <= 0) return;
  ops.push({ op: "addCircleProfile", center: [cx, cy, 0], normal: [0, 0, 1], radius: r });
}

function handleArc(entity: RawEntity, ops: EditOp[]): void {
  const cx = parseDouble(firstValue(entity, 10), NaN);
  const cy = parseDouble(firstValue(entity, 20), NaN);
  const r = parseDouble(firstValue(entity, 40), NaN);
  const a0 = parseDouble(firstValue(entity, 50), NaN);
  const a1 = parseDouble(firstValue(entity, 51), NaN);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r) || r <= 0 || !Number.isFinite(a0) || !Number.isFinite(a1)) return;
  if (a0 === a1) return;
  ops.push({ op: "addArc", center: [cx, cy, 0], normal: [0, 0, 1], radius: r, startAngleDeg: a0, endAngleDeg: a1 });
}

function handleSpline(entity: RawEntity, ops: EditOp[]): void {
  // Collect control points: repeated 10/20/30 groups
  const xs = allValues(entity, 10).map(Number);
  const ys = allValues(entity, 20).map(Number);
  const zs = allValues(entity, 30).map(Number);
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return;
  const points: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i], z = zs[i] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    points.push([x, y, z]);
  }
  if (points.length < 2) return;
  if (hasRepeatedConsecutive(points)) return;
  ops.push({ op: "addSpline", points });
}

function handleLwPolyline(entity: RawEntity, ops: EditOp[]): void {
  // 70 closed flag bit 0
  const flags = parseIntCode(firstValue(entity, 70), 0);
  const closed = (flags & 1) !== 0;
  // Collect vertices: each 10 starts a new vertex, with paired 20 and following 42 (bulge for segment starting at this vertex)
  const vertices: Array<{ x: number; y: number; bulge: number }> = [];
  let cur: { x?: number; y?: number; bulge: number } | null = null;
  for (const [code, val] of entity.pairs) {
    if (code === 10) {
      if (cur && cur.x !== undefined && cur.y !== undefined) vertices.push({ x: cur.x, y: cur.y, bulge: cur.bulge });
      cur = { bulge: 0 };
      const n = Number(val);
      if (Number.isFinite(n)) cur.x = n;
    } else if (code === 20) {
      if (cur) {
        const n = Number(val);
        if (Number.isFinite(n)) cur.y = n;
      }
    } else if (code === 42) {
      if (cur) {
        const n = Number(val);
        if (Number.isFinite(n)) cur.bulge = n;
      }
    }
  }
  if (cur && cur.x !== undefined && cur.y !== undefined) vertices.push({ x: cur.x, y: cur.y, bulge: cur.bulge });
  if (vertices.length < 2) return;
  // Filter degenerate consecutive duplicate positions before processing
  const filtered: typeof vertices = [];
  for (const v of vertices) {
    if (filtered.length > 0 && filtered[filtered.length - 1].x === v.x && filtered[filtered.length - 1].y === v.y) continue;
    filtered.push(v);
  }
  if (filtered.length < 2) return;
  // If closed, ensure we don't have duplicate closing vertex that equals first
  let verts = filtered;
  if (closed && verts.length >= 2 && verts[0].x === verts[verts.length - 1].x && verts[0].y === verts[verts.length - 1].y) {
    // DXF may duplicate first vertex at end when closed — remove last to avoid zero-length closing segment
    verts = verts.slice(0, -1);
    if (verts.length < 2) return;
  }

  const hasBulge = verts.some((v) => v.bulge !== 0);
  if (!hasBulge) {
    // Single polyline op for the whole outline
    const points: Vec3[] = verts.map((v) => [v.x, v.y, 0] as Vec3);
    if (closed) {
      if (points.length < 3) return;
      if (pointsEqual(points[0], points[points.length - 1])) return;
    } else {
      if (points.length < 2) return;
    }
    if (hasRepeatedConsecutive(points)) return;
    ops.push({ op: "addPolyline", points, closed });
    return;
  }

  // Mixed straight/bulge: emit per-segment ops
  const segCount = closed ? verts.length : verts.length - 1;
  for (let i = 0; i < segCount; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    if (a.x === b.x && a.y === b.y) continue;
    if (a.bulge !== 0) {
      const arc = bulgeToArc([a.x, a.y], [b.x, b.y], a.bulge);
      if (!arc) {
        // Degenerate bulge -> fallback to straight line
        const start: Vec3 = [a.x, a.y, 0];
        const end: Vec3 = [b.x, b.y, 0];
        if (!pointsEqual(start, end)) ops.push({ op: "addLine", start, end });
        continue;
      }
      // Skip degenerate radius
      if (arc.radius <= 0) continue;
      if (arc.startAngleDeg === arc.endAngleDeg) continue;
      ops.push({ op: "addArc", center: [arc.center[0], arc.center[1], 0], normal: [0, 0, 1], radius: arc.radius, startAngleDeg: arc.startAngleDeg, endAngleDeg: arc.endAngleDeg });
    } else {
      const start: Vec3 = [a.x, a.y, 0];
      const end: Vec3 = [b.x, b.y, 0];
      if (pointsEqual(start, end)) continue;
      ops.push({ op: "addLine", start, end });
    }
  }
}

function handlePolylineWithVertices(polyline: RawEntity, vertexEntities: RawEntity[], ops: EditOp[]): void {
  const flags = parseIntCode(firstValue(polyline, 70), 0);
  const closed = (flags & 1) !== 0;
  const vertices: Array<{ x: number; y: number; bulge: number }> = [];
  for (const v of vertexEntities) {
    const x = parseDouble(firstValue(v, 10), NaN);
    const y = parseDouble(firstValue(v, 20), NaN);
    const bulge = parseDouble(firstValue(v, 42), 0);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    vertices.push({ x, y, bulge });
  }
  if (vertices.length < 2) return;
  // Filter consecutive duplicates
  const filtered: typeof vertices = [];
  for (const v of vertices) {
    if (filtered.length > 0 && filtered[filtered.length - 1].x === v.x && filtered[filtered.length - 1].y === v.y) continue;
    filtered.push(v);
  }
  if (filtered.length < 2) return;
  let verts = filtered;
  if (closed && verts.length >= 2 && verts[0].x === verts[verts.length - 1].x && verts[0].y === verts[verts.length - 1].y) {
    verts = verts.slice(0, -1);
    if (verts.length < 2) return;
  }
  const hasBulge = verts.some((v) => v.bulge !== 0);
  if (!hasBulge) {
    const points: Vec3[] = verts.map((v) => [v.x, v.y, 0] as Vec3);
    if (closed) {
      if (points.length < 3) return;
      if (pointsEqual(points[0], points[points.length - 1])) return;
    }
    if (hasRepeatedConsecutive(points)) return;
    ops.push({ op: "addPolyline", points, closed });
    return;
  }
  const segCount = closed ? verts.length : verts.length - 1;
  for (let i = 0; i < segCount; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    if (a.x === b.x && a.y === b.y) continue;
    if (a.bulge !== 0) {
      const arc = bulgeToArc([a.x, a.y], [b.x, b.y], a.bulge);
      if (!arc) {
        const start: Vec3 = [a.x, a.y, 0];
        const end: Vec3 = [b.x, b.y, 0];
        if (!pointsEqual(start, end)) ops.push({ op: "addLine", start, end });
        continue;
      }
      if (arc.radius <= 0) continue;
      if (arc.startAngleDeg === arc.endAngleDeg) continue;
      ops.push({ op: "addArc", center: [arc.center[0], arc.center[1], 0], normal: [0, 0, 1], radius: arc.radius, startAngleDeg: arc.startAngleDeg, endAngleDeg: arc.endAngleDeg });
    } else {
      const start: Vec3 = [a.x, a.y, 0];
      const end: Vec3 = [b.x, b.y, 0];
      if (pointsEqual(start, end)) continue;
      ops.push({ op: "addLine", start, end });
    }
  }
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Parses DXF text (ASCII R12/2000) and returns EditOps for the supported
 * entities found in the ENTITIES section. Flat XY at z=0, 1 unit = 1mm,
 * Y-up native. Degenerate/unknown entities are silently skipped, same
 * graceful-degradation rule as every other import path in this codebase.
 */
export function parseDxf(text: string): DxfParseResult {
  const ops: EditOp[] = [];
  const warnings: string[] = [];
  const pairs = extractPairs(text);
  const range = findEntitiesRange(pairs);
  if (!range) {
    return { ops, warnings: ["No ENTITIES section found — nothing to import."] };
  }
  const rawEntities = splitRawEntities(pairs, range);
  // Walk raw entities, grouping POLYLINE + VERTEX chains
  for (let i = 0; i < rawEntities.length; i++) {
    const e = rawEntities[i];
    const t = e.type.toUpperCase();
    try {
      switch (t) {
        case "LINE":
          handleLine(e, ops);
          break;
        case "CIRCLE":
          handleCircle(e, ops);
          break;
        case "ARC":
          handleArc(e, ops);
          break;
        case "SPLINE":
          handleSpline(e, ops);
          break;
        case "LWPOLYLINE":
          handleLwPolyline(e, ops);
          break;
        case "POLYLINE": {
          const verts: RawEntity[] = [];
          let j = i + 1;
          while (j < rawEntities.length) {
            const nxt = rawEntities[j];
            if (nxt.type.toUpperCase() === "VERTEX") { verts.push(nxt); j++; }
            else if (nxt.type.toUpperCase() === "SEQEND") { j++; break; }
            else break;
          }
          handlePolylineWithVertices(e, verts, ops);
          // Advance i to last consumed
          i = j - 1;
          break;
        }
        case "VERTEX":
        case "SEQEND":
          // Handled as part of POLYLINE above; standalone VERTEX outside a
          // POLYLINE chain is not meaningful — skip.
          break;
        default:
          // Unsupported entity (INSERT, TEXT, MTEXT, DIMENSION, HATCH, etc.)
          break;
      }
    } catch {
      warnings.push(`Skipped malformed ${t} entity.`);
    }
  }
  return { ops, warnings };
}

/**
 * Convenience: extract raw entities for testing low-level parsing without
 * going through the op-mapping layer.
 */
export function parseDxfRawEntities(text: string): RawEntity[] {
  const pairs = extractPairs(text);
  const range = findEntitiesRange(pairs);
  if (!range) return [];
  return splitRawEntities(pairs, range);
}

// Re-export for tests that need bulge math directly
export const _test = { bulgeToArc, extractPairs, findEntitiesRange, splitRawEntities };
