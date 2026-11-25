/**
 * Pure model of the sidebar **Browser** (roadmap "Unified Browser tree"): one
 * tree that is a VIEW over models that already exist (tree leaves, Parts,
 * Layers, construction planes, bookmarks, the edit history). It stores no
 * state of its own — `buildBrowser` is a function of its inputs, and every row
 * action is dispatched by id to the same function the mirrored panel calls.
 *
 * DOM- and Three.js-free so vitest can pin the grouping, the guide/Sketches
 * split, the filter and the Expand/Collapse bookkeeping.
 */

export type BrowserGroupId = "document" | "views" | "origin" | "bodies" | "sketches" | "features" | "parts" | "layers";

/** `on`/`off` draws an eye; `null` means the row has no visibility to toggle. */
export type EyeState = "on" | "off" | null;

export interface BrowserRow {
  /** Typed id the host dispatches on: `body:solid-0`, `view:2`, `op:3`, … */
  id: string;
  label: string;
  /** Right-aligned small text (a face count, a unit, "baked"). */
  detail?: string;
  /** Hex colour swatch (Part / Layer / body colour). */
  color?: string;
  eye: EyeState;
  /** Dimmed (guide geometry, a suppressed or baked feature). */
  muted?: boolean;
}

export interface BrowserGroup {
  id: BrowserGroupId;
  title: string;
  rows: BrowserRow[];
  /** Group eye: `mixed` when some but not all rows are visible; `null` = no group eye. */
  eye: EyeState | "mixed";
}

export interface BrowserBody {
  id: string;
  label: string;
  faceCount?: number;
  hidden: boolean;
  /** Hex colour of the Part listing this solid, when one does. */
  color?: string;
}

export interface BrowserOriginState {
  grid: boolean;
  axes: { x: boolean; y: boolean; z: boolean };
  planes: { xy: boolean; xz: boolean; yz: boolean };
}

export interface BrowserSketchOp {
  op: number;
  label: string;
  faceCount: number;
  edgeCount: number;
  hidden: boolean;
  guide: boolean;
}

export interface BrowserInputs {
  document: { name: string; format: string | null; unit: string; unsavedEdits: number; tessellation?: string };
  bookmarkNames: string[];
  planes: { id: string; name: string; visible: boolean }[];
  origin: BrowserOriginState;
  /** Tree leaves WITHOUT the synthetic "Sketches" group. */
  bodies: BrowserBody[];
  /** Individual sketch/2D op rows mapped from final free faces and edges. */
  sketchOps?: BrowserSketchOp[];
  /** Fallback synthetic "Sketches" leaf when unmapped free faces remain. */
  sketches: { id: string; hidden: boolean; faceCount?: number; guide: boolean } | null;
  ops: { label: string; suppressed: boolean; baked: boolean; guide: boolean; folder?: string }[];
  parts: { name: string; color: string; hidden: boolean }[];
  layers: { id: string; name: string; color: string; visible: boolean }[];
}

/** Title shown for each group, in display order. */
export const BROWSER_GROUPS: readonly { id: BrowserGroupId; title: string }[] = [
  { id: "document", title: "Document" },
  { id: "views", title: "Named Views" },
  { id: "origin", title: "Origin" },
  { id: "bodies", title: "Bodies" },
  { id: "sketches", title: "Sketches" },
  { id: "features", title: "Features" },
  { id: "parts", title: "Parts" },
  { id: "layers", title: "Layers" },
];

const row = (r: BrowserRow): BrowserRow => r;

function aggregate(eyes: EyeState[]): EyeState | "mixed" {
  const states = eyes.filter((e): e is "on" | "off" => e !== null);
  if (states.length === 0) return null;
  if (states.every((s) => s === "on")) return "on";
  if (states.every((s) => s === "off")) return "off";
  return "mixed";
}

/** Splits tree leaves into real bodies and the synthetic free-face "Sketches" group. */
export function splitSketches<T extends { label: string }>(leaves: T[]): { bodies: T[]; sketches: T | null } {
  const sketches = leaves.find((l) => l.label === "Sketches") ?? null;
  return { bodies: leaves.filter((l) => l !== sketches), sketches };
}

export function buildBrowser(inp: BrowserInputs): BrowserGroup[] {
  const sketchOpRows = (inp.sketchOps ?? []).map((s) =>
    row({
      id: `sketch:op:${s.op}`,
      label: s.guide ? `${s.label} (guide)` : s.label,
      detail: s.faceCount > 0 ? `${s.faceCount} f` : s.edgeCount > 0 ? `${s.edgeCount} e` : undefined,
      eye: s.hidden ? "off" : "on",
      muted: s.guide,
    })
  );
  const fallbackSketchRows = inp.sketches
    ? [
        row({
          id: `sketch:${inp.sketches.id}`,
          label: inp.sketches.guide ? "Sketches (guide)" : "Sketches",
          detail: inp.sketches.faceCount !== undefined ? `${inp.sketches.faceCount} f` : undefined,
          eye: inp.sketches.hidden ? "off" : "on",
          muted: inp.sketches.guide,
        }),
      ]
    : [];
  const groups: Record<BrowserGroupId, BrowserRow[]> = {
    document: [
      row({ id: "doc:name", label: inp.document.name || "Untitled", detail: inp.document.format ?? undefined, eye: null }),
      row({ id: "doc:unit", label: "Display unit", detail: inp.document.unit, eye: null }),
      row({ id: "doc:tessellation", label: "Tessellation", detail: inp.document.tessellation ?? "standard", eye: null }),
      row({
        id: "doc:save",
        label: inp.document.unsavedEdits > 0 ? "Unsaved edits" : "Saved",
        detail: inp.document.unsavedEdits > 0 ? String(inp.document.unsavedEdits) : undefined,
        eye: null,
      }),
    ],
    views: inp.bookmarkNames.map((name, i) => row({ id: `view:${i}`, label: name, eye: null })),
    origin: [
      row({ id: "origin:grid", label: "Grid", eye: inp.origin.grid ? "on" : "off" }),
      row({ id: "origin:axis-x", label: "X axis", eye: inp.origin.axes.x ? "on" : "off" }),
      row({ id: "origin:axis-y", label: "Y axis", eye: inp.origin.axes.y ? "on" : "off" }),
      row({ id: "origin:axis-z", label: "Z axis", eye: inp.origin.axes.z ? "on" : "off" }),
      row({ id: "origin:plane-xy", label: "XY plane", eye: inp.origin.planes.xy ? "on" : "off" }),
      row({ id: "origin:plane-xz", label: "XZ plane", eye: inp.origin.planes.xz ? "on" : "off" }),
      row({ id: "origin:plane-yz", label: "YZ plane", eye: inp.origin.planes.yz ? "on" : "off" }),
      ...inp.planes.map((p) => row({ id: `plane:${p.id}`, label: p.name, eye: p.visible ? "on" : "off" })),
    ],
    bodies: inp.bodies.map((b) =>
      row({
        id: `body:${b.id}`,
        label: b.label,
        detail: b.faceCount !== undefined ? `${b.faceCount} f` : undefined,
        color: b.color,
        eye: b.hidden ? "off" : "on",
      })
    ),
    sketches: [...sketchOpRows, ...fallbackSketchRows],
    features: inp.ops.map((o, i) =>
      row({
        id: `op:${i}`,
        label: o.label,
        detail: o.baked ? "baked" : o.folder,
        // A baked op is part of the source and cannot be suppressed.
        eye: o.baked ? null : o.suppressed ? "off" : "on",
        muted: o.suppressed || o.guide,
      })
    ),
    parts: inp.parts.map((p, i) => row({ id: `part:${i}`, label: p.name, color: p.color, eye: p.hidden ? "off" : "on" })),
    layers: inp.layers.map((l) => row({ id: `layer:${l.id}`, label: l.name, color: l.color, eye: l.visible ? "on" : "off" })),
  };
  return BROWSER_GROUPS.map(({ id, title }) => ({
    id,
    title,
    rows: groups[id],
    // The Document group has no eyes; the others aggregate their rows.
    eye: id === "document" || id === "views" ? null : aggregate(groups[id].map((r) => r.eye)),
  }));
}

/**
 * Case-insensitive substring filter. A group whose title matches keeps all its
 * rows; otherwise it keeps its matching rows and is dropped when none match.
 * A blank query returns the groups untouched.
 */
export function filterBrowser(groups: BrowserGroup[], query: string): BrowserGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  const out: BrowserGroup[] = [];
  for (const g of groups) {
    if (g.title.toLowerCase().includes(q)) {
      out.push(g);
      continue;
    }
    const rows = g.rows.filter((r) => r.label.toLowerCase().includes(q) || (r.detail ?? "").toLowerCase().includes(q));
    if (rows.length > 0) out.push({ ...g, rows });
  }
  return out;
}

/**
 * Groups that start collapsed: the sidebar is a fixed-height column shared with
 * Components, Parts, Layers, Edits and FE Mesh, so only Bodies opens by default
 * and the rest are one click away (or Expand All).
 */
export const DEFAULT_COLLAPSED: readonly BrowserGroupId[] = ["document", "views", "origin", "sketches", "features", "parts", "layers"];

/** Expand/Collapse All: the set of collapsed group ids after the action. */
export function collapseAll(groups: BrowserGroup[]): Set<BrowserGroupId> {
  return new Set(groups.map((g) => g.id));
}
export function expandAll(): Set<BrowserGroupId> {
  return new Set();
}

/** Parses a typed row id (`body:solid-0` → `{kind:"body", key:"solid-0"}`); `null` when malformed. */
export function parseRowId(id: string): { kind: string; key: string } | null {
  const i = id.indexOf(":");
  if (i <= 0 || i === id.length - 1) return null;
  return { kind: id.slice(0, i), key: id.slice(i + 1) };
}
