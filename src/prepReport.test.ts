import { describe, it, expect } from "vitest";
import { renderPrepReportHtml, renderValueHtml, type PrepReport } from "./prepReport";

const report = (sections: PrepReport["sections"], images: PrepReport["images"] = []): PrepReport => ({
  version: 1,
  kind: "cad-preview-prep-report",
  createdAt: "2026-09-23T00:00:00.000Z",
  source: { path: "/w/<bad>.step", format: "step", sha256: "ab".repeat(32), sizeBytes: 10 },
  sections,
  images,
  notes: [],
});

describe("renderPrepReportHtml", () => {
  it("renders every status with its reason — unavailable and skipped sections are shown, not omitted", () => {
    const html = renderPrepReportHtml(
      report([
        { id: "mass", title: "Mass properties", status: "ok", data: { volume: 1000 }, units: "mm", geometry: "edited B-rep" },
        { id: "health", title: "Mesh health", status: "unavailable", reason: "B-rep source — nothing to heal" },
        { id: "deviation", title: "Deviation", status: "skipped", reason: "needs a tolerance" },
        { id: "bom", title: "BOM", status: "partial", reason: "2 Parts had no volumes", data: [{ part: "A", volume: 1 }] },
      ])
    );
    expect(html).toMatch(/Mass properties <span class="badge st-ok">OK/);
    expect(html).toContain("B-rep source — nothing to heal");
    expect(html).toContain("needs a tolerance");
    expect(html).toContain("2 Parts had no volumes");
    expect(html).toContain("Geometry: edited B-rep · Units: mm");
    expect(html).toContain("<td>1000</td>");
  });

  it("is self-contained: no scripts, no external URLs, and document text is escaped", () => {
    const html = renderPrepReportHtml(
      report(
        [{ id: "bom", title: "BOM", status: "ok", data: [{ part: "<script>alert(1)</script>", note: "see https://evil.example" }] }],
        [
          { label: "ISO", mimeType: "image/png", dataBase64: "iVBORw0KGgo=" },
          { label: "evil", mimeType: "image/svg+xml", dataBase64: "PHN2Zz4=" },
        ]
      )
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\bsrc="https?:|href="https?:/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;bad&gt;.step");
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(html).not.toContain("image/svg+xml;base64");
  });

  it("caps long tables and says where the rest is", () => {
    const rows = Array.from({ length: 205 }, (_, i) => ({ i }));
    expect(renderValueHtml(rows)).toContain("5 more row(s) in report.json");
  });
});
