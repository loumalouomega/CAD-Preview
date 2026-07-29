import { describe, it, expect, vi, afterEach } from "vitest";
import { searchStandardParts, downloadStandardPart } from "./stepPartsService";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
  } as unknown as Response;
}

const FAKE_PART = {
  id: "iso4017_hex_head_cap_screw_m6x25",
  name: "ISO 4017 hex head cap screw, M6 x 25",
  description: "ISO 4017, hex head cap screw, M6 x 25.",
  category: "fastener",
  family: "hex-head-cap-screw",
  tags: ["screw", "bolt"],
  aliases: [],
  attributes: { thread: "M6" },
  stepUrl: "https://media.githubusercontent.com/media/example/part.step",
  glbUrl: "https://example.com/part.glb",
  pngUrl: "https://example.com/part.png",
  byteSize: 1234,
  sha256: null,
  pageUrl: "https://www.step.parts/parts/iso4017_hex_head_cap_screw_m6x25",
  apiUrl: "https://api.step.parts/v1/parts/iso4017_hex_head_cap_screw_m6x25",
};

describe("searchStandardParts", () => {
  it("returns available:true with the parsed result on a 200 response", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("https://api.step.parts/v1/parts?");
      expect(url).toContain("q=bolt");
      return jsonResponse({
        items: [FAKE_PART],
        page: 1,
        pageSize: 100,
        total: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        facets: { tags: [], categories: [], families: [], standards: [] },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchStandardParts({ q: "bolt" });
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.value.items).toHaveLength(1);
      expect(result.value.items[0].id).toBe(FAKE_PART.id);
    }
  });

  it("builds repeatable query params for array filters", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("tag=screw");
      expect(url).toContain("tag=metric");
      expect(url).toContain("category=fastener");
      return jsonResponse({
        items: [],
        page: 1,
        pageSize: 100,
        total: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
        facets: { tags: [], categories: [], families: [], standards: [] },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await searchStandardParts({ tag: ["screw", "metric"], category: ["fastener"] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns available:false (never throws) on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND api.step.parts");
      })
    );
    const result = await searchStandardParts({ q: "bolt" });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toMatch(/unreachable/i);
  });

  it("returns available:false on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, false, 503))
    );
    const result = await searchStandardParts({ q: "bolt" });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toContain("503");
  });
});

describe("downloadStandardPart", () => {
  it("downloads and reports verifiedChecksum:false when the part has no sha256 on record", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(FAKE_PART))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => new TextEncoder().encode("ISO-10303-21;").buffer,
      } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadStandardPart(FAKE_PART.id);
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.value.sha256).toBeNull();
      expect(result.value.verifiedChecksum).toBe(false);
      expect(new TextDecoder().decode(result.value.bytes)).toBe("ISO-10303-21;");
    }
  });

  it("verifies a matching sha256", async () => {
    const bytes = new TextEncoder().encode("ISO-10303-21;");
    const { createHash } = await import("crypto");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const partWithHash = { ...FAKE_PART, sha256 };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(partWithHash))
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK", arrayBuffer: async () => bytes.buffer } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadStandardPart(partWithHash.id);
    expect(result.available).toBe(true);
    if (result.available) expect(result.value.verifiedChecksum).toBe(true);
  });

  it("detects a checksum mismatch", async () => {
    const partWithHash = { ...FAKE_PART, sha256: "0".repeat(64) };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(partWithHash))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => new TextEncoder().encode("not the expected bytes").buffer,
      } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadStandardPart(partWithHash.id);
    expect(result.available).toBe(true);
    if (result.available) expect(result.value.verifiedChecksum).toBe(false);
  });

  it("returns available:false when the part id lookup fails, without attempting the STEP download", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, false, 404));
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadStandardPart("nonexistent_part");
    expect(result.available).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the detail lookup, never the STEP fetch
  });

  it("returns available:false when the STEP file download itself fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(FAKE_PART))
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: "Internal Server Error" } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadStandardPart(FAKE_PART.id);
    expect(result.available).toBe(false);
  });
});
