import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseSampleIndex, isSafeSampleName, bundledSamplesDir } from "./samples";
import { routeFile } from "./fileRouter";

const ROOT = path.resolve(__dirname, "..");

describe("sample index", () => {
  it("drops unsafe, duplicate and label-less entries", () => {
    const out = parseSampleIndex(JSON.stringify({ samples: [
      { file: "a.stl", label: "A" },
      { file: "a.stl", label: "dup" },
      { file: "../evil.stl", label: "x" },
      { file: "sub/b.stl", label: "x" },
      { file: ".hidden", label: "x" },
      { file: "index.json", label: "x" },
      { file: "c.stl", label: " " },
      { file: "d.stl", label: "D", description: 3 },
    ] }));
    expect(out).toEqual([{ file: "a.stl", label: "A", description: "" }, { file: "d.stl", label: "D", description: "" }]);
    expect(parseSampleIndex("not json")).toEqual([]);
    expect(isSafeSampleName("x.stp")).toBe(true);
    expect(bundledSamplesDir("/ext")).toBe(path.join("/ext", "dist", "samples"));
  });
});

describe("the shipped samples", () => {
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, "samples", "index.json"), "utf8")) as { samples: Array<{ file: string; from: string }> };
  const samples = parseSampleIndex(JSON.stringify(index));

  it("every entry parses, routes to a viewer format, exists and stays under the 100 KB budget", () => {
    expect(samples.length).toBe(index.samples.length);
    for (const e of index.samples) {
      expect(routeFile(e.file), e.file).not.toBeNull();
      const stat = fs.statSync(path.join(ROOT, e.from));
      expect(stat.size, e.from).toBeLessThan(100 * 1024);
    }
  });

  it(".vscodeignore carves out exactly the staged files (a missing one would drop a sample from the VSIX)", () => {
    const ignore = fs.readFileSync(path.join(ROOT, ".vscodeignore"), "utf8").split("\n").map((l) => l.trim());
    for (const name of ["index.json", ...samples.map((s) => s.file)]) expect(ignore, name).toContain(`!dist/samples/${name}`);
    const carved = ignore.filter((l) => l.startsWith("!dist/samples/")).map((l) => l.slice("!dist/samples/".length));
    expect(carved.sort()).toEqual(["index.json", ...samples.map((s) => s.file)].sort());
  });
});
