/**
 * Host-side thumbnail fetching for the Standard Parts panel (roadmap Tier 1
 * "Standard-parts thumbnails").
 *
 * `StandardPart.pngUrl` is a remote `https://` image the webview's CSP has
 * no allowance for — and must never get one — so the host fetches the bytes
 * and pipes them over postMessage as `data:` URLs (which `img-src` already
 * permits). Every failure mode returns `null`, never throws: a failed image
 * degrades to the panel's existing text row rather than blocking search or
 * insertion.
 *
 * Bounds (all load-bearing, all unit-tested): a 10 s timeout (the search
 * timeout precedent in `stepPartsService.ts`), a 256 KiB cap enforced both
 * on the `content-length` header AND while streaming (a lying header must
 * not bypass the cap), and a strict content-type allowlist — an HTML error
 * page served as a 200, or an SVG (XML with its own parsing surface), is
 * not a thumbnail. `fetchImpl` is injectable so tests never touch the real
 * network.
 */

export const THUMB_TIMEOUT_MS = 10_000;
export const THUMB_MAX_BYTES = 256 * 1024;

const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export interface ThumbFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

function timeoutSignal(ms: number): AbortSignal {
  // Same explicit-construction precedent as `stepPartsService.ts`:
  // `AbortSignal.timeout()` isn't universally available across the Node
  // versions this extension targets.
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

function baseContentType(header: string | null): string {
  if (!header) return "";
  return header.split(";")[0].trim().toLowerCase();
}

/**
 * Fetches one thumbnail URL and returns a `data:` URL, or `null` for every
 * failure or policy refusal (timeout, oversize, disallowed content type,
 * network/DNS error, empty body). Never throws.
 */
export async function fetchThumbnail(
  url: string,
  options?: ThumbFetchOptions,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const timeoutMs = options?.timeoutMs ?? THUMB_TIMEOUT_MS;
  const maxBytes = options?.maxBytes ?? THUMB_MAX_BYTES;
  try {
    const res = await fetchImpl(url, { signal: timeoutSignal(timeoutMs) });
    if (!res.ok) return null;
    const contentType = baseContentType(res.headers.get("content-type"));
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) return null;
    const declared = res.headers.get("content-length");
    if (declared !== null) {
      const n = Number(declared);
      if (!Number.isFinite(n) || n <= 0 || n > maxBytes) return null;
    }
    const reader = res.body?.getReader();
    if (!reader) {
      // No streaming body (some polyfills) — fall back to a bounded buffer
      // read rather than an unbounded `arrayBuffer()`.
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > maxBytes) return null;
      return `data:${contentType};base64,${toBase64(buf)}`;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          return null;
        }
        chunks.push(value);
      }
    }
    if (total === 0) return null;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    return `data:${contentType};base64,${toBase64(merged)}`;
  } catch {
    return null;
  }
}

function toBase64(bytes: Uint8Array): string {
  // Chunked conversion — `String.fromCharCode(...bytes)` overflows the
  // argument limit on large buffers.
  let s = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  // `Buffer` exists in the extension host; `btoa` covers hypothetical
  // non-Node runtimes the same way.
  if (typeof Buffer !== "undefined") return Buffer.from(s, "binary").toString("base64");
  return btoa(s);
}

/**
 * Bounded in-memory cache (LRU by insertion order — a `Map` re-set
 * refreshes recency) so paging back and forth over search results never
 * refetches. Session-scoped by construction: the provider owns one
 * instance, and nothing persists it. Stores only successful fetches —
 * a failure stays a failure and is retried next time (cheap, and a
 * transient network blip should not permanently blank a row).
 */
export class ThumbCache {
  private readonly map = new Map<string, string>();
  constructor(private readonly capacity = 50) {}

  get(url: string): string | undefined {
    const hit = this.map.get(url);
    if (hit === undefined) return undefined;
    this.map.delete(url);
    this.map.set(url, hit);
    return hit;
  }

  set(url: string, dataUrl: string): void {
    if (this.map.has(url)) this.map.delete(url);
    this.map.set(url, dataUrl);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  get size(): number {
    return this.map.size;
  }
}
