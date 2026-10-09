import type { Layer } from "./protocol";
import type { EditOp } from "./editOps";

/** Pure (vscode-free) parse/serialize for the layers sidecar — unit-testable. */

export const LAYERS_SIDECAR_VERSION = 1;

/** The default layer every document implicitly has: unassigned entities sit
 * here, and a deleted layer's members return here. It cannot be deleted. */
export function defaultLayer(): Layer {
  return {
    id: "layer-0",
    name: "Default",
    color: "#b8b8b8",
    visible: true,
    locked: false,
    volumes: [],
    surfaces: [],
    lines: [],
    points: [],
  };
}

interface SidecarFile {
  version: number;
  source: string;
  layers: Layer[];
  /**
   * Next `layer-N` suffix to allocate. Present from the first write that
   * allocates an id; absent in hand-written files (defaults to max+1, the
   * same rule allocation used before the counter existed). Persisted so a
   * deleted id is never recycled into a new meaning, which would silently
   * retarget a drawing filter naming it.
   */
  nextId?: number;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // A CSS hex colour — the same shape `Part.color` carries. Anything else is
  // a malformed entry, not a colour to guess at.
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) return null;
  return value;
}

/**
 * Parses + validates sidecar JSON into a clean `Layer[]`. Tolerant, same
 * discipline as `parsePartsJson`/`parsePlanesJson`: a malformed entry is
 * dropped individually rather than throwing, so a hand-edited or
 * partially-corrupt sidecar never blocks opening the model.
 *
 * An empty/missing file yields `[]` (not `[defaultLayer()]`) — the default
 * layer is implicit until the first real layer is created, so merely opening
 * a document never materializes a sidecar it never had.
 */
export function parseLayersJson(text: string): Layer[] {
  return parseLayersFile(text).layers;
}

/**
 * Full file parse: the layers plus the allocation counter. `nextId` is the
 * stored counter when valid, else max+1 over the parsed layers (so a
 * hand-written file without the field still allocates safely past its
 * highest id).
 */
export function parseLayersFile(text: string): { layers: Layer[]; nextId: number } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { layers: [], nextId: 0 };
  }
  const raw = data as Partial<SidecarFile> | null;
  const rawLayers = raw?.layers;
  if (!Array.isArray(rawLayers)) return { layers: [], nextId: 0 };

  const layers: Layer[] = [];
  for (const raw of rawLayers) {
    if (!raw || typeof raw !== "object") continue;
    const l = raw as Partial<Layer>;
    if (typeof l.id !== "string" || !l.id) continue;
    if (typeof l.name !== "string" || !l.name) continue;
    const color = asColor(l.color);
    if (!color) continue;
    layers.push({
      id: l.id,
      name: l.name,
      color,
      visible: asBoolean(l.visible, true),
      locked: asBoolean(l.locked, false),
      volumes: asStringArray(l.volumes),
      surfaces: asStringArray(l.surfaces),
      lines: asStringArray(l.lines),
      points: asStringArray(l.points),
    });
  }
  let max = -1;
  for (const l of layers) {
    const m = /^layer-(\d+)$/.exec(l.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const stored = typeof raw?.nextId === "number" && Number.isInteger(raw.nextId) && raw.nextId >= 0 ? raw.nextId : max + 1;
  return { layers, nextId: Math.max(stored, max + 1) };
}

/** Serializes layers to the sidecar JSON text (pretty-printed, trailing newline). */
export function serializeLayersJson(sourceName: string, layers: Layer[], nextId?: number): string {
  const file: SidecarFile = {
    version: LAYERS_SIDECAR_VERSION,
    source: sourceName,
    layers,
    ...(nextId !== undefined ? { nextId } : {}),
  };
  return JSON.stringify(file, null, 2) + "\n";
}

/**
 * One included layer's entity membership, resolved host-side from the sidecar
 * and passed to the drawing pipeline (roadmap "Layers, distinct from
 * Parts", second increment). Plain JSON — crosses the kernel-worker IPC
 * untouched via the generic marshalling, like `OpOutcome`.
 */
export interface LayerDrawSubset {
  id: string;
  name: string;
  color: string;
  faces: string[];
  volumes: string[];
  edges: string[];
}

/**
 * Resolves a caller's layer filter (names or ids) against the stored layers
 * into per-layer drawing subsets. Pure.
 *
 * An unknown name is a warning + skip (the same never-fail-on-ambiguous-input
 * convention `unit`/`view` use); the caller throws when nothing resolved at
 * all, so a filter can never silently produce an empty drawing.
 */
export function resolveLayerDrawFilter(
  layers: readonly Layer[],
  names: readonly string[]
): { subsets: LayerDrawSubset[]; warnings: string[] } {
  const full = layersWithDefault(layers);
  const subsets: LayerDrawSubset[] = [];
  const warnings: string[] = [];
  for (const name of names) {
    const layer = full.find((l) => l.id === name) ?? full.find((l) => l.name === name);
    if (!layer) {
      warnings.push(`Unknown layer "${name}" — known: ${full.map((l) => `"${l.name}" (${l.id})`).join(", ")}. Skipped.`);
      continue;
    }
    if (!subsets.some((s) => s.id === layer.id)) {
      subsets.push({
        id: layer.id,
        name: layer.name,
        color: layer.color,
        faces: [...layer.surfaces],
        volumes: [...layer.volumes],
        edges: [...layer.lines],
      });
    }
  }
  return { subsets, warnings };
}

/**
 * Allocates the next never-reused `layer-N` id: the counter wins over the
 * current max (a deleted highest id must not come back), and the returned
 * counter is the suffix after the allocated one. Allocation sites persist the
 * returned counter alongside the list — the sidecar carries it, so the rule
 * holds across sessions and across host/webview writers.
 */
export function allocateLayerId(layers: readonly Layer[], nextId: number): { id: string; nextId: number } {
  let max = -1;
  for (const l of layers) {
    const m = /^layer-(\d+)$/.exec(l.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const n = Math.max(nextId, max + 1);
  return { id: `layer-${n}`, nextId: n + 1 };
}

/**
 * The next free `layer-N` id for a set of existing layers.
 *
 * Ids are never reused: the highest existing N plus one, so deleting a layer
 * and creating another does not resurrect the old id under a new meaning —
 * which would silently retarget a drawing filter naming it. Same rule as
 * `planesSidecar.ts`'s `nextPlaneId`.
 */
export function nextLayerId(layers: readonly Layer[]): string {
  return allocateLayerId(layers, 0).id;
}

/** One entity id found on a locked layer. */
export interface LockedOperand {
  id: string;
  layerId: string;
  layerName: string;
}

const ENTITY_ID_RE = /^(solid|face|edge|point)-\d+$/;

function collectEntityIds(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (ENTITY_ID_RE.test(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectEntityIds(v, out);
  }
}

/**
 * Names the first of `op`'s entity-id operands sitting on a locked layer, if
 * any — the shared refusal both the headless `apply_edit_ops` path and the
 * webview's op builder use. A locked entity stays selectable for measurement
 * and inspection; it refuses as an edit operand (and as a Transform Gizmo
 * target, which the webview checks separately against the selection).
 *
 * Pure: the scan is structural over the op JSON (every operand field —
 * `targets`, `profile`, `edges`, `midplaneFaces`, … — is a string or string
 * array), so a future op kind is covered without updating a field list.
 */
export function lockedOperandForOp(op: EditOp, layers: readonly Layer[]): LockedOperand | null {
  const ids: string[] = [];
  const record = op as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === "op" || key === "exprs" || key === "targetQueries" || key === "targetQueryKinds") continue;
    collectEntityIds(record[key], ids);
  }
  const lockedById = new Map<string, Layer>();
  for (const layer of layers) {
    if (!layer.locked) continue;
    for (const id of [...layer.volumes, ...layer.surfaces, ...layer.lines, ...layer.points]) {
      if (!lockedById.has(id)) lockedById.set(id, layer);
    }
  }
  for (const id of ids) {
    const layer = lockedById.get(id);
    if (layer) return { id, layerId: layer.id, layerName: layer.name };
  }
  return null;
}

/**
 * The effective layer list for a document: the stored layers, or the
 * implicit default layer when no sidecar exists yet. Pure — callers that
 * persist (create/delete) materialize the default explicitly instead.
 */
export function layersWithDefault(layers: readonly Layer[]): Layer[] {
  if (layers.length > 0) return layers.map((l) => ({ ...l }));
  return [defaultLayer()];
}

/**
 * Moves every member id of the layer with `id` into the default layer and
 * removes that layer. The default layer itself cannot be deleted. Returns the
 * new list (a fresh array; the input is untouched).
 *
 * @throws when `id` names no layer, or names the default layer.
 */
export function deleteLayer(layers: readonly Layer[], id: string): Layer[] {
  const full = layersWithDefault(layers);
  if (id === "layer-0") throw new Error('The default layer cannot be deleted — its members have nowhere to return to.');
  const at = full.findIndex((l) => l.id === id);
  if (at === -1) throw new Error(`No layer with id "${id}".`);
  const [removed] = full.splice(at, 1);
  const home = full.find((l) => l.id === "layer-0")!;
  const absorb = (dst: string[], src: string[]): string[] => {
    const seen = new Set(dst);
    for (const e of src) if (!seen.has(e)) {
      seen.add(e);
      dst.push(e);
    }
    return dst;
  };
  absorb(home.volumes, removed.volumes);
  absorb(home.surfaces, removed.surfaces);
  absorb(home.lines, removed.lines);
  absorb(home.points, removed.points);
  return full;
}

/**
 * Assigns entity ids to the layer with `id`, removing each from whatever
 * other layer currently holds it — an entity belongs to at most one layer.
 * Returns the new list (fresh arrays throughout; the input is untouched).
 *
 * @throws when `id` names no layer.
 */
export function assignLayerEntities(
  layers: readonly Layer[],
  id: string,
  members: { volumes?: string[]; surfaces?: string[]; lines?: string[]; points?: string[] }
): Layer[] {
  const full = layersWithDefault(layers).map((l) => ({
    ...l,
    volumes: [...l.volumes],
    surfaces: [...l.surfaces],
    lines: [...l.lines],
    points: [...l.points],
  }));
  const target = full.find((l) => l.id === id);
  if (!target) throw new Error(`No layer with id "${id}".`);
  const kinds = ["volumes", "surfaces", "lines", "points"] as const;
  for (const kind of kinds) {
    const ids = members[kind] ?? [];
    for (const l of full) {
      if (l !== target) l[kind] = l[kind].filter((e) => !ids.includes(e));
    }
    for (const e of ids) {
      if (!target[kind].includes(e)) target[kind].push(e);
    }
  }
  return full;
}
