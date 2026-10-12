import { describe, it, expect } from "vitest";
import { parseToWeldedMesh } from "./meshParse";
import { stlBytesForHeal } from "./meshioService";
import type { MeshParseFormat } from "./fileRouter";

// Defense in depth for the display-only mesh formats: callers gate on
// COMPARABLE_MESH_FORMATS, but a format with no host-side parser must fail
// loudly here rather than fall through to a parser built for another format.
describe("host triangle parsers refuse a format they do not parse", () => {
  const bogus = "3mf" as unknown as MeshParseFormat;

  it("parseToWeldedMesh does not fall into the PLY parser", () => {
    expect(() => parseToWeldedMesh(new Uint8Array([0x50, 0x4b, 3, 4]), bogus)).toThrow(/3mf has no host-side triangle parser/);
  });

  it("stlBytesForHeal does not fall into the glTF parser", () => {
    expect(() => stlBytesForHeal(new Uint8Array([0x50, 0x4b, 3, 4]), bogus)).toThrow(/3mf has no host-side triangle parser/);
  });
});
