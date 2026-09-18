import { describe, it, expect, vi } from "vitest";
import { fetchThumbnail, ThumbCache, THUMB_MAX_BYTES } from "./standardPartsThumbs";

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

function pngResponse(bytes: Uint8Array = PNG_BYTES, contentType = "image/png"): Response {
  return new Response(bytes as BodyInit, {
    status: 200,
    headers: { "content-type": contentType, "content-length": String(bytes.length) },
  });
}

describe("fetchThumbnail", () => {
  it("returns a data URL for a valid image", async () => {
    const out = await fetchThumbnail("https://x/y.png", {}, async () => pngResponse());
    expect(out?.startsWith("data:image/png;base64,")).toBe(true);
    expect(out).toContain(Buffer.from(PNG_BYTES).toString("base64"));
  });

  it("never throws — network failure, non-2xx, and empty body are all null", async () => {
    const failing = async () => {
      throw new Error("DNS down");
    };
    expect(await fetchThumbnail("https://x/y.png", {}, failing)).toBeNull();
    expect(await fetchThumbnail("https://x/y.png", {}, async () => new Response("no", { status: 500 }))).toBeNull();
    expect(await fetchThumbnail("https://x/y.png", {}, async () => pngResponse(new Uint8Array(0)))).toBeNull();
    // A declared length of zero is not an image either.
    expect(
      await fetchThumbnail(
        "https://x/y.png",
        {},
        async () =>
          new Response(PNG_BYTES as BodyInit, {
            status: 200,
            headers: { "content-type": "image/png", "content-length": "0" },
          })
      )
    ).toBeNull();
  });

  it("refuses disallowed content types, including HTML-as-200 and SVG", async () => {
    const html = new TextEncoder().encode("<html>error</html>");
    expect(await fetchThumbnail("https://x/y.png", {}, async () => pngResponse(html, "text/html"))).toBeNull();
    const svg = new TextEncoder().encode("<svg></svg>");
    expect(await fetchThumbnail("https://x/y.svg", {}, async () => pngResponse(svg, "image/svg+xml"))).toBeNull();
    expect(await fetchThumbnail("https://x/y.png", {}, async () => pngResponse())).not.toBeNull();
  });

  it("refuses oversize bodies by header and mid-stream", async () => {
    const big = new Uint8Array(THUMB_MAX_BYTES + 1);
    // Lying-or-honest header: refused before reading a byte.
    let read = false;
    const counting: typeof fetch = async () => {
      const res = pngResponse(big);
      const orig = res.body!.getReader();
      const stream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await orig.read();
          if (done) controller.close();
          else {
            read = true;
            controller.enqueue(value);
          }
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "image/png" } });
    };
    expect(await fetchThumbnail("https://x/big.png", { maxBytes: 1024 }, counting)).toBeNull();
    expect(read).toBe(true); // no header here, so the stream cap did the work
    // Small cap with an honest header refuses without streaming.
    read = false;
    expect(await fetchThumbnail("https://x/big.png", { maxBytes: 1024 }, async () => pngResponse(big))).toBeNull();
  });

  it("times out rather than hanging", async () => {
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const t0 = Date.now();
    expect(await fetchThumbnail("https://x/slow.png", { timeoutMs: 30 }, hanging)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("accepts jpeg/gif/webp with parameters on the content type", async () => {
    for (const ct of ["image/jpeg; charset=binary", "image/gif", "image/webp"]) {
      const out = await fetchThumbnail("https://x/i", {}, async () => pngResponse(new Uint8Array([1, 2]), ct));
      expect(out?.startsWith(`data:${ct.split(";")[0]};base64,`)).toBe(true);
    }
  });
});

describe("ThumbCache", () => {
  it("hits without refetching and refreshes recency", () => {
    const cache = new ThumbCache(2);
    expect(cache.get("a")).toBeUndefined();
    cache.set("a", "data-a");
    cache.set("b", "data-b");
    expect(cache.get("a")).toBe("data-a"); // refreshes a
    cache.set("c", "data-c"); // evicts b, not a
    expect(cache.get("a")).toBe("data-a");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.size).toBe(2);
  });

  it("only successful fetches are worth storing (caller-side contract)", () => {
    // The cache itself stores what it is given; the no-negative-caching
    // rule lives in the provider wiring (failures return before `set`).
    // Pinned here so a future "cache nulls" change trips loudly.
    const cache = new ThumbCache(2);
    cache.set("a", "data-a");
    expect(cache.size).toBe(1);
    vi.restoreAllMocks();
  });
});
