import { describe, it, expect } from "vitest";
import { parseChangelog, compareVersions, entriesSince, renderEntryHtml } from "./changelogParser";

const SAMPLE = `# Changelog

All notable changes to the "CAD Preview" extension are documented in this file.

## [1.0.3] - 2026-07-17

### Changed
- Dependency maintenance: bumped \`esbuild\`, \`typescript\`, and several
  GitHub Actions to their latest compatible versions.

## [1.0.2] - 2026-07-13

### Fixed
- Adjusted gmsh-wasm handling in the esbuild config and \`.vscodeignore\` so the
  packaged extension bundles it correctly.

## [1.0.0] - 2026-07-13

### Changed
- First stable 1.0 release.

[1.0.3]: https://github.com/example/repo/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/example/repo/compare/v1.0.0...v1.0.2
[1.0.0]: https://github.com/example/repo/releases/tag/v1.0.0
`;

describe("parseChangelog", () => {
  it("parses entries newest-first, matching file order", () => {
    const entries = parseChangelog(SAMPLE);
    expect(entries.map((e) => e.version)).toEqual(["1.0.3", "1.0.2", "1.0.0"]);
    expect(entries[0].date).toBe("2026-07-17");
  });

  it("strips the trailing reference-link block out of the last entry's body", () => {
    const entries = parseChangelog(SAMPLE);
    const last = entries[entries.length - 1];
    expect(last.bodyMarkdown).not.toContain("compare/v1.0.0");
    expect(last.bodyMarkdown).toContain("First stable 1.0 release.");
  });

  it("captures each entry's body up to (not including) the next heading", () => {
    const entries = parseChangelog(SAMPLE);
    expect(entries[1].bodyMarkdown).toContain("Adjusted gmsh-wasm handling");
    expect(entries[1].bodyMarkdown).not.toContain("First stable 1.0 release");
  });

  it("returns [] for a document with no version headings", () => {
    expect(parseChangelog("# Changelog\n\nNothing here yet.\n")).toEqual([]);
  });
});

describe("compareVersions", () => {
  it("orders numerically, not lexicographically", () => {
    expect(compareVersions("1.0.10", "1.0.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.9", "1.0.10")).toBeLessThan(0);
  });

  it("treats equal versions as 0", () => {
    expect(compareVersions("1.0.3", "1.0.3")).toBe(0);
  });

  it("treats a missing trailing component as 0", () => {
    expect(compareVersions("1.1", "1.1.0")).toBe(0);
    expect(compareVersions("1.1.1", "1.1")).toBeGreaterThan(0);
  });
});

describe("entriesSince", () => {
  it("keeps only entries strictly newer than the given version", () => {
    const entries = parseChangelog(SAMPLE);
    expect(entriesSince(entries, "1.0.2").map((e) => e.version)).toEqual(["1.0.3"]);
  });

  it("returns [] when the given version is already the newest", () => {
    const entries = parseChangelog(SAMPLE);
    expect(entriesSince(entries, "1.0.3")).toEqual([]);
  });

  it("returns every entry when the given version predates all of them", () => {
    const entries = parseChangelog(SAMPLE);
    expect(entriesSince(entries, "0.1.0")).toHaveLength(3);
  });
});

describe("renderEntryHtml", () => {
  it("renders the version/date heading, subheadings, bullets, and inline code", () => {
    const entries = parseChangelog(SAMPLE);
    const html = renderEntryHtml(entries[0]);
    expect(html).toContain("<h3>1.0.3");
    expect(html).toContain("2026-07-17");
    expect(html).toContain("<h4>Changed</h4>");
    expect(html).toContain("<code>esbuild</code>");
    expect(html).toContain("<li>");
  });

  it("merges a wrapped bullet's continuation line into the same <li>", () => {
    const entries = parseChangelog(SAMPLE);
    const html = renderEntryHtml(entries[1]);
    expect(html).toMatch(/<li>Adjusted gmsh-wasm handling in the esbuild config and <code>\.vscodeignore<\/code> so the packaged extension bundles it correctly\.<\/li>/);
  });

  it("escapes HTML-significant characters in raw text", () => {
    const entry = { version: "1.0.0", date: "2026-01-01", bodyMarkdown: "### Fixed\n- a <script>alert(1)</script> & \"quote\"" };
    const html = renderEntryHtml(entry);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;quote&quot;");
  });
});
