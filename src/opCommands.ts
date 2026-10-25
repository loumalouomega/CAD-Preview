import { BREP_ONLY_OPS, type EditOpKind, type EditOp } from "./editOps";
import { OP_CATALOG, AGENT_ONLY_OPS, allCatalogEntries, type PanelOpId } from "./webview/opCatalog";

/**
 * Pure, host- AND webview-safe command vocabulary shared by the MCP tools and
 * the lower command bar (roadmap "Lower command bar for manual geometry
 * ops"): the per-kind parameter docs, the rejection explainer with its
 * "did you mean" matcher, and the command table that maps a typed command
 * name onto a panel button and an `EditOp` kind.
 *
 * Moved out of `mcpTools.ts` (which re-exports them, so every existing import
 * keeps working) because `mcpTools.ts` pulls in the whole Node tool surface and
 * cannot be bundled into the webview. This module imports only `editOps` and
 * `opCatalog`, both already shared by the two bundles.
 */

/**
 * One-line JSON-shape documentation per op kind, surfaced by
 * `describe_capabilities` so an agent can author raw `EditOp` objects without
 * reading `editOps.ts`. Keys are locked against the op catalog by
 * `mcpTools.test.ts` — a new op kind fails the test until documented here.
 */
export const OP_PARAM_DOCS: Record<EditOpKind, string> = {
  translate: '{targets: id[], vec: [x,y,z]} (the viewer\'s Move gizmo commits the snapped vec for a single target when "Snap to points" is on; a multi-target drag previews snapping only)',
  rotate: '{targets: id[], axisPoint: [x,y,z], axisDir: [x,y,z], angleDeg: n}',
  scale: '{targets: id[], center: [x,y,z], factors: [sx,sy,sz]}',
  mirror: '{targets: id[], planePoint?: [x,y,z], planeNormal?: [x,y,z], planeId?: string (plane-N from planes sidecar — XOR with planePoint/planeNormal and midplaneFaces; planePoint/planeNormal may ride alongside as cache), midplaneFaces?: [faceId, faceId] (planar, parallel — XOR with planePoint/planeNormal)}',
  boolean: '{kind: "union"|"subtract"|"intersect", a: solidId[], b: solidId[]}',
  fillet: '{edges: edgeId[], radius: n>0 (start radius), radius2?: n>0 (end radius: variable-radius fillet; a chain of edges is ordered end-to-start and interpolated by length)}',
  chamfer: '{edges: edgeId[], distance: n>0, distance2?: n>0 (asymmetric, needs face), angleDeg?: 0<n<90 (distance-angle, needs face), face?: faceId}',

  extrude: '{profile: faceId | profileEdges: edgeId[] (exactly one), dir: [x,y,z], length: n>0 | upToFace: faceId (exactly one of length/upToFace; planar terminator — extrusion runs to its plane, miss/parallel skips), thin?: n>0, thinOuter?: 0<=n<=thin}',
  revolve: '{profile: faceId | profileEdges: edgeId[] (exactly one), axisPoint: [x,y,z], axisDir: [x,y,z], angleDeg: n, thin?: n>0, thinOuter?: 0<=n<=thin}',
  sweep: '{profile: faceId | profileEdges: edgeId[] (exactly one), path: edgeId, thin?: n>0, thinOuter?: 0<=n<=thin}',
  loft: '{profiles: faceId[] (>=2) | profileEdgeSets: edgeId[][] (>=2, exactly one form), guides?: edgeId[] (one guide-rail wire steering the loft — resampled intermediates through plain ThruSections, NOT kernel rail wiring; exactly 2 closed sections, no thin), thin?: n>0, thinOuter?: 0<=n<=thin, smoothing?: boolean (surface smoothing across sections — the only loft quality knob with a measured effect; continuity/par-type/max-degree settings are accepted by the kernel but change nothing, so they are not exposed)}',
  explode: '{factor: n}',
  mate: '{faceA: faceId, faceB: faceId (both planar)}',
  shell: '{thickness: n!=0 (negative hollows inward), openingFaces: faceId[] (>=1), join?: "arc"|"intersection"|"tangent" (default arc)}',
  draft: '{faces: faceId[], angleDeg: 0<n<90, planePoint?: [x,y,z], planeNormal?: [x,y,z], planeId?: string (plane-N from planes sidecar; planePoint/planeNormal may ride alongside as cache) (neutral plane + pull direction; omitted = each face\'s own plane). NOTE: this WASM build\'s draft engine (BRepOffsetAPI_DraftAngle.Build) is kernel-broken — the op validates but reports applied:false with a diagnostic}',
  unifySameDomain: '{} (no parameters): merge adjacent faces and edges that lie on the same underlying surface/curve — e.g. the seam a boolean union leaves between coplanar faces — via ShapeUpgrade_UnifySameDomain. Acts on the whole model; a model with nothing to merge is left unchanged and reported as not applied. Renumbers face/edge ids (Parts are rebound or dropped, never repointed)',
  defeature: '{faces: faceId[] (>=1): faces to remove as recognized features (fillets, chamfers) via BRepAlgoAPI_Defeaturing; the solid heals behind them}',
  splitByPlane: '{targets: solidId[], planePoint?: [x,y,z], planeNormal?: [x,y,z], planeId?: string (plane-N — XOR with planePoint/planeNormal and midplaneFaces; cache may ride alongside), midplaneFaces?: [faceId, faceId] (XOR with planePoint/planeNormal), keep: "both"|"positive"|"negative"}',
  splitFace: '{face: faceId, edgeIds: edgeId[] (>=1, on the face) | points: [[x,y,z],[x,y,z]] (straight segment, distinct — exactly one of edgeIds/points): splits the face into two regions along the splitting edge via BRepFeat_SplitShape; the edge must lie on the face and reach its boundary, else the op is skipped with a diagnostic. Renumbers face/edge ids (Parts/annotations rebind; a Part on a split half is dropped with a warning when its centroid no longer matches)}',
  rib: '{spineEdges: edgeId[] (open wire, assembled in any order), dir: [x,y,z], thin: n>0 (required; symmetric — thinOuter must be absent or exactly thin/2), upTo: faceId (planar terminator — wall runs to its plane plus one thin of embed, then fuses), blendRadius?: n>=0 (junction blend; default thin/4; 0 = fuse only)}',
  wrap: '{profile: faceId (flat sketch face — face-only, no profileEdges form; holed profiles supported, e.g. a letter with a counter — each hole is cut out of the developed shell), target: "cylinder"|"cone", axisPoint: [x,y,z], axisDir: [x,y,z], radius: n>0, halfAngleDeg?: 0<n<90 (cone only, required; refused on cylinder), thickness: n>0 (total, symmetric about the developed surface), variant: "emboss"|"engrave"|"standalone", targets?: solidId[] (required for emboss/engrave, refused for standalone)}',
  section: '{targets: solidId[], planePoint?: [x,y,z], planeNormal?: [x,y,z], planeId?: string (plane-N — XOR; cache may ride alongside), midplaneFaces?: [faceId, faceId] (XOR)}',
  addBox: '{center: [x,y,z], size: [dx,dy,dz] (full extents)}',
  addSphere: '{center: [x,y,z], radius: n>0}',
  addCylinder: '{center: [x,y,z] (base), axis: [x,y,z], radius: n>0, height: n>0}',
  addCone: '{center: [x,y,z] (base), axis: [x,y,z], radius1: n>0, radius2: n>=0 (0 = apex), height: n>0}',
  addTorus: '{center: [x,y,z], axis: [x,y,z], majorRadius: n>0, minorRadius: n>0 (< majorRadius)}',
  addPrism: '{center: [x,y,z] (base), axis: [x,y,z], radius: n>0 (circumradius, or apothem when circumscribed), sides: int>=3, height: n>0, circumscribed?: boolean}',

  addWedge: '{center: [x,y,z], axis: [x,y,z], up: [x,y,z], dx: n>0, dy: n>0, dz: n>0, ltx: n>=0}',
  addHole: '{targets: solidId[], position: [x,y,z] (mouth), axis: [x,y,z] (into material), radius: n>0, depth: n>0}',
  addCounterboreHole:
    '{targets: solidId[], position: [x,y,z], axis: [x,y,z], radius: n>0, depth: n>0, cbRadius: n>radius, cbDepth: n<depth}',
  addCountersinkHole:
    '{targets: solidId[], position: [x,y,z], axis: [x,y,z], radius: n>0, depth: n>0, csRadius: n>radius, csAngleDeg: 0<n<180}',
  addCircleProfile: '{center: [x,y,z], normal: [x,y,z], radius: n>0, planeId?: "plane-N" (with optional offsetU/offsetV in-plane offsets; center/normal then ride as resolved cache and may be omitted when authoring)}',
  addRectangleProfile: '{center: [x,y,z], normal: [x,y,z], up: [x,y,z], width: n>0, height: n>0, planeId?: "plane-N" (with optional offsetU/offsetV and rotationDeg about the plane normal; center/normal/up then ride as resolved cache and may be omitted when authoring)}',
  addPolygonProfile: '{center: [x,y,z], normal: [x,y,z], up: [x,y,z], radius: n>0 (circumradius, or apothem when circumscribed), sides: int>=3, circumscribed?: boolean, planeId?: "plane-N" (with optional offsetU/offsetV and rotationDeg; center/normal/up then ride as resolved cache and may be omitted when authoring)}',

  addEllipseProfile: '{center: [x,y,z], normal: [x,y,z], up: [x,y,z], radiusX: n>0, radiusY: n>0}',
  addRoundedRectangleProfile:
    '{center: [x,y,z], normal: [x,y,z], up: [x,y,z], width: n>0, height: n>0, cornerRadius: 0<2r<min(w,h)}',
  addSlotProfile: '{center: [x,y,z], normal: [x,y,z], up: [x,y,z], length: n (> width), width: n>0}',
  addTrapezoidProfile:
    '{center: [x,y,z], normal: [x,y,z], up: [x,y,z], bottomWidth: n>0, topWidth: n>0, height: n>0}',
  addPoint: '{position: [x,y,z], coincident?: "reuse"|"independent"} (coincident: what to do when position matches an existing point-N — reuse adds no entity, independent adds a second point; default independent, with a note)',
  addLine: '{start: [x,y,z] | "point-N", end: [x,y,z] | "point-N", coincident?: "reuse"|"independent"} — coincident (addLine/addThreePointArc/addPolyline/addSpline/addBezier): what to do when a RAW (non-point-N) first/last position matches an existing point-N — reuse snaps it there and shares that vertex (no new point), independent builds its own vertex (default, with a note). any position slot of the curve ops (addLine/addArc/addPolyline/addThreePointArc/addSpline/addBezier/addEllipseArc/addHelix) may be a point-N id (or {id: "point-N", at: [x,y,z]}) naming an existing point, resolved against the model as of that op; an id whose point has moved or been renumbered is re-anchored by its recorded position (a warning), else the op is skipped with a diagnostic',
  addArc: '{center: [x,y,z] | "point-N", normal: [x,y,z], radius: n>0, startAngleDeg: n, endAngleDeg: n (CCW about normal)}',
  addPolyline: '{points: ([x,y,z] | "point-N")[] (>=2; >=3 when closed), closed: boolean}',
  addThreePointArc: '{p1, p2, p3: each [x,y,z] | "point-N" (non-collinear)}',
  addSpline: '{points: ([x,y,z] | "point-N")[] (>=2; approximating fit, endpoint-exact)}',
  addBezier: '{controlPoints: ([x,y,z] | "point-N")[] (>=2)}',
  addEllipseArc:
    '{center: [x,y,z] | "point-N", normal: [x,y,z], up: [x,y,z], radiusX: n>0, radiusY: n>0, startAngleDeg: n, endAngleDeg: n}',
  addHelix: '{center: [x,y,z] | "point-N" (base), axis: [x,y,z], radius: n>0, pitch: n>0, turns: n>0}',
  addSurfaceFromLines: '{edges: edgeId[] (a single connected loop, or several disjoint closed loops forming exactly ONE outer boundary plus its holes — e.g. a letter "O"\'s outer ring + inner ring build one holed face; a set spanning more than one outer loop is refused)}',
  addVolumeFromSurfaces: '{faces: faceId[] (must sew into a closed shell)}',
  addEdgeSlot: '{edge: edgeId, width: n>0}',
  filletProfile: '{edges: [edgeId, edgeId] (two adjacent straight segments of one sketch wire, e.g. an addPolyline — they meet at the corner), radius: n>0 (arc fillet) XOR chamfer: n>0 (bevel; distance along edges[0]), chamfer2?: n>0 (distance along edges[1]; chamfer only)}. Trims both segments and inserts the arc/bevel inside the same wire, so an extrude afterwards has the analytic area; apply once per corner. Radius/chamfer must be shorter than the adjacent segments (skipped with a diagnostic otherwise); straight segments only',
  align: '{targets: solidId[], axis: "x"|"y"|"z", extent: "min"|"center"|"max", to: n}',
  patternLinear: '{targets: solidId[], direction: [x,y,z], spacing: n!=0, count: int>=2 (total instances, incl. original)}',
  patternCircular: '{targets: solidId[], axisPoint?: [x,y,z], axisDir?: [x,y,z], midaxisOf?: [faceId|edgeId, faceId|edgeId] (parallel cylinder axes or straight edges — XOR with axisPoint/axisDir), angleDeg: n, count: int>=2 (total instances, incl. original)}',
  drill: '{targets: solidId[], profile: faceId | profileEdges: edgeId[] (exactly one), pick?: "outer"|"all"|region indices (0 = outer boundary, 1..N = inner loops in order — omitted = face as modeled, holes preserved), dir: [x,y,z], length: n (explicit only, no up-to-face variant)}',
};

/**
 * Why an op was rejected, and — where it can be determined — the corrected
 * value, not just a diagnosis.
 *
 * Runs **only on the already-failed path**: `validateEditOp` returns
 * `EditOp | null` with no reason channel, and widening that would churn eight
 * call sites including the hot sidecar-parse path (hundreds of ops on every
 * document open). A separate explainer costs nothing when validation succeeds,
 * which is the overwhelmingly common case.
 *
 * Lives here rather than in `editOps.ts` so it can quote {@link OP_PARAM_DOCS}'s
 * exact expected shape for the kind — the most paste-ready fix available.
 */
export function explainEditOpRejection(raw: unknown): string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return `Expected an op object, got ${Array.isArray(raw) ? "an array" : typeof raw}. Each op is a JSON object with an "op" field, e.g. {"op": "translate", "targets": ["solid-0"], "vec": [1,0,0]}.`;
  }

  const kindRaw = (raw as { op?: unknown }).op;
  if (typeof kindRaw !== "string" || kindRaw === "") {
    return 'Missing the "op" field, which names the kind. Call describe_capabilities for the full catalog.';
  }

  const kinds = allOpKinds();
  if (!(kinds as string[]).includes(kindRaw)) {
    const near = nearestOpKind(kindRaw, kinds);
    return (
      `Unknown op kind "${kindRaw}".` +
      (near ? ` Did you mean "${near}"? Expected shape: ${OP_PARAM_DOCS[near]}` : " Call describe_capabilities for the full catalog.")
    );
  }

  // A known kind that still failed: the fields are wrong. Quoting the exact
  // expected shape is the most actionable thing available without duplicating
  // validateEditOpCore's per-kind checks (which would drift against it).
  const kind = kindRaw as EditOpKind;
  return `"${kind}" is a valid op kind, but its fields did not validate. Expected: ${OP_PARAM_DOCS[kind]}${
    BREP_ONLY_OPS.has(kind) ? " (B-rep sources only)" : ""
  }. Every numeric field must be a finite number, and every id an existing entity id.`;
}

/**
 * The closest op kind by edit distance, or `null` when nothing is near enough
 * to suggest — a wrong guess is worse than none, so this only fires for a
 * genuine near-miss (a third of the name's length).
 */
export function nearestOpKind(input: string, kinds: EditOpKind[]): EditOpKind | null {
  return nearestName(input, kinds);
}

/**
 * Generic form of {@link nearestOpKind}: the closest candidate by
 * case-insensitive edit distance, or `null` when nothing is a genuine
 * near-miss (a third of the input's length, at least 2). Shared with the MCP
 * unknown-parameter warning so both suggest by one rule.
 */
export function nearestName<T extends string>(input: string, candidates: readonly T[]): T | null {
  const needle = input.toLowerCase();
  let best: T | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const d = editDistance(needle, candidate.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  const limit = Math.max(2, Math.floor(input.length / 3));
  return best !== null && bestDistance <= limit ? best : null;
}

export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const row = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev.splice(0, prev.length, ...row);
  }
  return prev[b.length];
}

export function allOpKinds(): EditOpKind[] {
  const kinds = new Set<EditOpKind>();
  for (const entry of allCatalogEntries()) for (const k of entry.kinds) kinds.add(k);
  for (const k of AGENT_ONLY_OPS) kinds.add(k);
  return [...kinds];
}

// ---------------------------------------------------------------------------
// Command table — the lower command bar's vocabulary

/** The kinds of entity a `$sel` token can expand to, matching the pick modes. */
export type SelEntityKind = "solid" | "face" | "edge" | "point";

/** The live selection as the bar sees it: ids grouped by entity kind, each in pick order. */
export interface SelectionIds { solid: string[]; face: string[]; edge: string[]; point: string[]; }

export interface CommandRow {
  /** The canonical typed name (case-insensitive when matched). */
  command: string;
  /** The panel button this command opens / is echoed from. */
  panelId: PanelOpId;
  /** The `EditOp` kind it emits. */
  kind: EditOpKind;
  /** Body fields fixed by the command itself (the three boolean buttons share one kind). */
  fixed?: Record<string, unknown>;
  /** Extra accepted spellings (lower-cased on lookup). */
  aliases: string[];
  /** The catalog category title, for grouping in help output. */
  group: string;
}

/** Aliases the roadmap table names; everything else is reachable by its panel id or op kind. */
const ALIASES: Partial<Record<PanelOpId, string[]>> = {
  booleanUnion: ["booleanUnion"],
  booleanSubtract: ["booleanSubtract"],
  booleanIntersect: ["booleanIntersect"],
  buildSurface: ["surface"],
  edgeSlot: ["slot"],
  buildVolume: ["volume"],
};

/** Canonical command names that differ from the panel id: the three boolean buttons are typed `union` / `subtract` / `intersect`. */
const COMMAND_NAME: Partial<Record<PanelOpId, string>> = {
  booleanUnion: "union",
  booleanSubtract: "subtract",
  booleanIntersect: "intersect",
};

const BOOLEAN_KIND: Partial<Record<PanelOpId, string>> = {
  booleanUnion: "union",
  booleanSubtract: "subtract",
  booleanIntersect: "intersect",
};

function buildCommandTable(): CommandRow[] {
  const rows: CommandRow[] = [];
  const categories = [...OP_CATALOG.geometry2d, ...OP_CATALOG.geometry3d, ...OP_CATALOG.edit];
  for (const cat of categories) {
    for (const entry of cat.ops) {
      const booleanKind = BOOLEAN_KIND[entry.id];
      rows.push({
        command: COMMAND_NAME[entry.id] ?? entry.id,
        panelId: entry.id,
        kind: entry.kinds[0],
        ...(booleanKind ? { fixed: { kind: booleanKind } } : {}),
        aliases: ALIASES[entry.id] ?? [],
        group: cat.title,
      });
    }
  }
  return rows;
}

/** One row per panel button (57 today) — locked to `allCatalogEntries()` by `opCommands.test.ts`. */
export const COMMAND_TABLE: readonly CommandRow[] = buildCommandTable();

const COMMAND_LOOKUP: ReadonlyMap<string, CommandRow> = (() => {
  const m = new Map<string, CommandRow>();
  const ambiguousKinds = new Map<string, number>();
  for (const row of COMMAND_TABLE) ambiguousKinds.set(row.kind, (ambiguousKinds.get(row.kind) ?? 0) + 1);
  for (const row of COMMAND_TABLE) {
    for (const key of [row.command, row.panelId, ...row.aliases]) m.set(key.toLowerCase(), row);
    // The raw op kind is accepted too (`addSurfaceFromLines`), but only where it names exactly one button.
    if (ambiguousKinds.get(row.kind) === 1) m.set(row.kind.toLowerCase(), row);
  }
  return m;
})();

/** Looks a typed command name up (case-insensitive, accepts the canonical name, the panel id, an alias, or an unambiguous op kind). */
export function findCommand(name: string): CommandRow | null {
  return COMMAND_LOOKUP.get(name.trim().toLowerCase()) ?? null;
}

/** Every typed spelling, for completion and "did you mean". */
export function allCommandNames(): string[] {
  return [...new Set(COMMAND_TABLE.flatMap((r) => [r.command, ...r.aliases]))];
}

/** Command names starting with `prefix` (case-insensitive), canonical names first, alphabetical. */
export function completeCommands(prefix: string): string[] {
  const p = prefix.toLowerCase();
  const names = allCommandNames().filter((n) => n.toLowerCase().startsWith(p));
  return names.sort((a, b) => a.localeCompare(b));
}

/** The closest command name for a typo, or `null` when nothing is near (same rule as {@link nearestOpKind}). */
export function nearestCommand(input: string): string | null {
  const names = allCommandNames();
  const needle = input.toLowerCase();
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const n of names) {
    const d = editDistance(needle, n.toLowerCase());
    if (d < bestDistance) { bestDistance = d; best = n; }
  }
  const limit = Math.max(2, Math.floor(input.length / 3));
  return best !== null && bestDistance <= limit ? best : null;
}

export type ParsedCommandLine =
  | { ok: true; row: CommandRow; body: string | null }
  | { ok: false; error: string; empty?: boolean };

/** Splits `<command> [<json-body>]` and resolves the command. A bare command has `body: null`. */
export function parseCommandLine(text: string): ParsedCommandLine {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: "", empty: true };
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  const name = m ? m[1] : trimmed;
  const rest = m && m[2] !== undefined ? m[2].trim() : "";
  const row = findCommand(name);
  if (!row) {
    const near = nearestCommand(name);
    return {
      ok: false,
      error: `Unknown command "${name}".` + (near ? ` Did you mean "${near}"?` : " Type a command name (Tab completes) or use the panel buttons."),
    };
  }
  return { ok: true, row, body: rest === "" ? null : rest };
}

/** How each operand field name maps to the entity kind a `$sel` token expands to; `single` fields take exactly one id. */
const OPERAND_FIELD_TYPES: Readonly<Record<string, { type: SelEntityKind; single?: boolean }>> = {
  targets: { type: "solid" },
  a: { type: "solid" },
  b: { type: "solid" },
  edges: { type: "edge" },
  guides: { type: "edge" },
  profileEdges: { type: "edge" },
  spineEdges: { type: "edge" },
  path: { type: "edge", single: true },
  edge: { type: "edge", single: true },
  faces: { type: "face" },
  face: { type: "face", single: true },
  edgeIds: { type: "edge" },
  openingFaces: { type: "face" },
  midplaneFaces: { type: "face" },
  profiles: { type: "face" },
  profile: { type: "face", single: true },
  faceA: { type: "face", single: true },
  faceB: { type: "face", single: true },
  upToFace: { type: "face", single: true },
  upTo: { type: "face", single: true },
};

/** Curve-op coordinate slots that take a picked point (`point-N`) — see `POINT_REF_KINDS` in `editOps.ts`. */
const POINT_SLOT_ARRAYS = new Set(["points", "controlPoints"]);
const POINT_SLOT_SCALARS = new Set(["start", "end", "p1", "p2", "p3", "center"]);
const POINT_SLOT_KINDS: ReadonlySet<EditOpKind> = new Set<EditOpKind>([
  "addLine", "addArc", "addPolyline", "addThreePointArc", "addSpline", "addBezier", "addEllipseArc", "addHelix",
]);

const SEL_LABEL: Record<SelEntityKind, string> = {
  solid: "volumes (Vol mode)", face: "faces (Surf mode)", edge: "edges (Line mode)", point: "points (Point mode)",
};

/**
 * Makes a bare `$sel` token valid JSON by quoting it — `{"targets":$sel}` is
 * the roadmap's spelling, which `JSON.parse` would reject. String contents are
 * skipped, so a `$sel` inside quotes is left alone.
 */
export function quoteSelTokens(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) { out += text[++i]; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (text.startsWith("$sel", i) && !/[A-Za-z0-9_]/.test(text[i + 4] ?? "")) { out += '"$sel"'; i += 3; continue; }
    out += ch;
  }
  return out;
}

function selSlot(kind: EditOpKind, field: string): { type: SelEntityKind; single?: boolean } | null {
  if (POINT_SLOT_KINDS.has(kind)) {
    if (POINT_SLOT_ARRAYS.has(field)) return { type: "point" };
    if (POINT_SLOT_SCALARS.has(field)) return { type: "point", single: true };
  }
  return OPERAND_FIELD_TYPES[field] ?? null;
}

/**
 * Builds the raw op object a command line describes: parses the body (with
 * `$sel` tokens), stamps the row's `op` kind and fixed fields, and expands
 * every `$sel` from `selection` according to the FIELD it appears in — the
 * field decides which entity kind is meant, so a mixed selection is never
 * ambiguous. The result is still unvalidated: the caller runs `validateEditOp`
 * and, on `null`, {@link explainEditOpRejection}.
 */
export function buildCommandOp(
  row: CommandRow, bodyText: string | null, selection: SelectionIds
): { op: Record<string, unknown> } | { error: string } {
  let body: Record<string, unknown> = {};
  if (bodyText !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(quoteSelTokens(bodyText));
    } catch (err) {
      return { error: `The body is not valid JSON (${err instanceof Error ? err.message : String(err)}). Expected: ${OP_PARAM_DOCS[row.kind]}` };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: `The body must be a JSON object. Expected: ${OP_PARAM_DOCS[row.kind]}` };
    }
    body = parsed as Record<string, unknown>;
  }
  const op: Record<string, unknown> = { ...body, op: row.kind, ...(row.fixed ?? {}) };

  for (const [field, value] of Object.entries(op)) {
    const hasSel = value === "$sel" || (Array.isArray(value) && value.includes("$sel"));
    if (!hasSel) continue;
    const slot = selSlot(row.kind, field);
    if (!slot) return { error: `$sel cannot be used for "${field}" — it expands to selected ids and only fits id fields (${Object.keys(OPERAND_FIELD_TYPES).join(", ")}).` };
    const ids = selection[slot.type];
    if (ids.length === 0) return { error: `$sel in "${field}" needs selected ${SEL_LABEL[slot.type]} — nothing of that kind is selected.` };
    if (slot.single || value === "$sel" && POINT_SLOT_SCALARS.has(field)) {
      if (ids.length !== 1) return { error: `"${field}" takes one id but ${ids.length} ${SEL_LABEL[slot.type]} are selected.` };
      op[field] = ids[0];
    } else if (value === "$sel") {
      op[field] = [...ids];
    } else {
      op[field] = (value as unknown[]).flatMap((v) => (v === "$sel" ? ids : [v]));
    }
  }
  return { op };
}

/** The command row an op was (or would be) typed as, or `null` for an unknown kind. */
export function commandForOp(op: Pick<EditOp, "op"> & { kind?: unknown }): CommandRow | null {
  const matches = COMMAND_TABLE.filter((r) => r.kind === op.op);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  return matches.find((r) => r.fixed?.kind === op.kind) ?? null;
}

/**
 * The command-line text equivalent to a persisted op — what the bar shows when
 * a panel button applies one (`union {"a":[…],"b":[…]}`), so it can be edited
 * and re-run. The `op` field is the command itself and a fixed `kind` is
 * implied by the command name, so both are left out of the body.
 */
export function echoCommandText(op: EditOp): string {
  const row = commandForOp(op as Pick<EditOp, "op"> & { kind?: unknown });
  if (!row) return "";
  const body: Record<string, unknown> = { ...(op as unknown as Record<string, unknown>) };
  delete body.op;
  for (const k of Object.keys(row.fixed ?? {})) delete body[k];
  return Object.keys(body).length === 0 ? row.command : `${row.command} ${JSON.stringify(body)}`;
}

/** Entity ids available for completion, grouped like {@link SelectionIds}. */
export type EntityInventory = SelectionIds;

/** Completes an id prefix (`fa` → `face-0`, `face-1`, …) against the inventory, capped for display. */
export function completeEntityId(prefix: string, inventory: EntityInventory, limit = 50): string[] {
  const p = prefix.toLowerCase();
  const all = [...inventory.solid, ...inventory.face, ...inventory.edge, ...inventory.point];
  return all.filter((id) => id.toLowerCase().startsWith(p)).slice(0, limit);
}

/** True when the command's op cannot run on a mesh source (the bar mirrors the panel's greying). */
export function commandIsBrepOnly(row: CommandRow): boolean {
  return BREP_ONLY_OPS.has(row.kind);
}

