/**
 * Client for the hosted [step.parts](https://www.step.parts) REST API
 * (`api.step.parts`) — off-the-shelf STEP parts (fasteners, bearings,
 * connectors, extrusions, ...). This is the extension's **first external
 * network dependency** (`doc/roadmap.md`'s "Standard-parts sourcing" item) —
 * every function here is opt-in by construction (nothing calls it except the
 * two MCP tools an agent explicitly invokes; no automatic/background
 * network activity anywhere in the extension) and degrades gracefully:
 * network/DNS failure or a non-2xx response returns `{available: false,
 * reason}` rather than throwing, and — per the roadmap's explicit adoption
 * of step.parts' own error semantics — that failure is reported as
 * *inconclusive*, never as "no matching parts" or "part unavailable". Only
 * `import type` from this module is used in `mcpTools.ts` (mirrors the
 * WASM-service DI convention — `Pipeline` injects `searchStandardParts`/
 * `downloadStandardPart` so tests can fake them with zero real network I/O).
 *
 * **API shape verified directly against the live service** (`GET
 * https://api.step.parts/v1/openapi.json`, and a real `GET .../v1/parts?
 * q=bolt&pageSize=3` search), not assumed from documentation alone — no
 * authentication required. `/v1/parts` (search, `q`/`tag`/`category`/
 * `family`/`standard` filters + `page`/`pageSize` pagination) and
 * `/v1/parts/{id}` (single-part detail) are the two endpoints this client
 * uses; `stepUrl` (the STEP file's own hosted URL, verified to live on a
 * different host — `media.githubusercontent.com` — than the API itself) and
 * `sha256` (nullable — some parts have no checksum on record) are the fields
 * `downloadStandardPart` needs.
 */

const BASE_URL = "https://api.step.parts";
const SEARCH_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export interface PartFacetValue {
  value: string;
  count: number;
}

export interface PartStandard {
  body: string;
  number: string;
  designation: string;
}

/** One catalog entry — the exact shape `/v1/parts` and `/v1/parts/{id}` both return. */
export interface StandardPart {
  id: string;
  name: string;
  description: string;
  category: string;
  family?: string;
  tags: string[];
  aliases: string[];
  standard?: PartStandard;
  stepSource?: string;
  productPage?: string;
  attributes: Record<string, unknown>;
  /** The STEP file's own download URL — a different host than `apiUrl`. */
  stepUrl: string;
  glbUrl: string;
  pngUrl: string;
  byteSize: number | null;
  /** Nullable — not every part has a recorded checksum. */
  sha256: string | null;
  pageUrl: string;
  apiUrl: string;
}

export interface SearchStandardPartsParams {
  q?: string;
  tag?: string[];
  category?: string[];
  family?: string[];
  standard?: string[];
  page?: number;
  pageSize?: number;
}

export interface PartSearchResult {
  items: StandardPart[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  facets: {
    tags: PartFacetValue[];
    categories: PartFacetValue[];
    families: PartFacetValue[];
    standards: PartFacetValue[];
  };
}

export type ServiceResult<T> = { available: true; value: T } | { available: false; reason: string };

function timeoutSignal(ms: number): AbortSignal {
  // AbortSignal.timeout() would be simpler, but isn't universally available
  // across the Node versions this extension targets — build it explicitly.
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<ServiceResult<T>> {
  try {
    const res = await fetch(url, { signal: timeoutSignal(timeoutMs) });
    if (!res.ok) {
      return { available: false, reason: `step.parts API returned ${res.status} ${res.statusText} for ${url}` };
    }
    return { available: true, value: (await res.json()) as T };
  } catch (err) {
    // Network/DNS failure, timeout, or malformed JSON — all inconclusive,
    // never "no results"/"part unavailable". See this file's doc comment.
    return { available: false, reason: `step.parts API unreachable (${(err as Error).message}).` };
  }
}

function buildSearchUrl(params: SearchStandardPartsParams): string {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  for (const t of params.tag ?? []) qs.append("tag", t);
  for (const c of params.category ?? []) qs.append("category", c);
  for (const f of params.family ?? []) qs.append("family", f);
  for (const s of params.standard ?? []) qs.append("standard", s);
  if (params.page !== undefined) qs.set("page", String(params.page));
  if (params.pageSize !== undefined) qs.set("pageSize", String(params.pageSize));
  const query = qs.toString();
  return `${BASE_URL}/v1/parts${query ? `?${query}` : ""}`;
}

/** Faceted search over the step.parts catalog. */
export async function searchStandardParts(params: SearchStandardPartsParams): Promise<ServiceResult<PartSearchResult>> {
  return fetchJson<PartSearchResult>(buildSearchUrl(params), SEARCH_TIMEOUT_MS);
}

export interface DownloadedPart {
  id: string;
  bytes: Uint8Array;
  /** The part record's own `sha256`, or `null` if it has none on record. */
  sha256: string | null;
  /** True only if `sha256` was present AND the downloaded bytes matched it —
   * never true for a part with no recorded checksum (nothing to verify
   * against, not the same as "verified and passed"). */
  verifiedChecksum: boolean;
  stepUrl: string;
  pageUrl: string;
}

/** Looks up `id`, downloads its STEP file, and verifies the bytes against
 * the part record's `sha256` if one is present. Two network round trips
 * (detail, then the STEP file itself, hosted on a different domain) — both
 * failures collapse to the same `{available: false}` shape so a caller
 * doesn't need to distinguish "part id not found" from "download failed". */
export async function downloadStandardPart(id: string): Promise<ServiceResult<DownloadedPart>> {
  const detail = await fetchJson<StandardPart>(`${BASE_URL}/v1/parts/${encodeURIComponent(id)}`, SEARCH_TIMEOUT_MS);
  if (!detail.available) return detail;

  const part = detail.value;
  try {
    const res = await fetch(part.stepUrl, { signal: timeoutSignal(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) {
      return { available: false, reason: `step.parts STEP file download returned ${res.status} ${res.statusText}.` };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const verifiedChecksum = part.sha256 !== null && (await sha256Hex(bytes)) === part.sha256.toLowerCase();
    return {
      available: true,
      value: { id: part.id, bytes, sha256: part.sha256, verifiedChecksum, stepUrl: part.stepUrl, pageUrl: part.pageUrl },
    };
  } catch (err) {
    return { available: false, reason: `step.parts STEP file download failed (${(err as Error).message}).` };
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(bytes).digest("hex");
}
