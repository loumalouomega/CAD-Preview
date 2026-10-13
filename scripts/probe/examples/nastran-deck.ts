/**
 * Nastran bulk-deck geometry probe — backs the claim that a deck is read
 * into the RIGHT mesh, not merely a non-empty one.
 *
 *   npm run probe -- scripts/probe/examples/nastran-deck.ts
 *
 * Opens each committed `.bdf` through the real `convertToStlBoundary` (the
 * same entry point the viewer and `generate_mesh` use, with `sourceName` set
 * so the stem convention and the `BEGIN BULK` normalization stage correctly),
 * then measures the produced boundary: extents, signed volume and facet count.
 * Every expected number comes from the fixture's geometry, not from the
 * reader's output:
 *
 *   - `block-tets.bdf`      — Gmsh's tetrahedralization of `block.stp`:
 *                             3 x 4 x 5 box, volume 60, 60 boundary facets.
 *   - `box-fixed-field.bdf` — hand-authored fixed-field deck, six 10-node
 *                             CTETRA with continuation lines: 2 x 3 x 4 box,
 *                             volume 24.
 *   - `box-free-field.bdf`  — the same model, comma-separated free field.
 *   - `box-large-field.bdf` — the same model, 16-column `GRID*` large field.
 *
 * Exits 1 on any mismatch. (A count-only check would pass a unit box.)
 */
import * as fs from "fs";
import * as path from "path";
import { convertToStlBoundary } from "../../../src/meshioService";
import { parseStl } from "../../../src/stlParser";
import { triangleMassProperties } from "../../../src/triangleMassProperties";
import { kernelVersions } from "../../../src/kernelVersions";

interface Expectation {
  file: string;
  extent: [number, number, number];
  volume: number;
  /** Exact boundary facet count, when the fixture pins one. */
  facets?: number;
}

const EXPECTED: Expectation[] = [
  { file: "block-tets.bdf", extent: [3, 4, 5], volume: 60, facets: 60 },
  { file: "box-fixed-field.bdf", extent: [2, 3, 4], volume: 24 },
  { file: "box-free-field.bdf", extent: [2, 3, 4], volume: 24 },
  { file: "box-large-field.bdf", extent: [2, 3, 4], volume: 24 },
];

const TOL = 1e-6;

async function main(): Promise<void> {
  let failed = false;
  const results: unknown[] = [];
  for (const exp of EXPECTED) {
    const fixture = path.join("examples", "Nastran", exp.file);
    const bytes = new Uint8Array(fs.readFileSync(fixture));
    const stl = await convertToStlBoundary(bytes, "nastran", exp.file);
    const soup = parseStl(stl);
    const mp = triangleMassProperties(soup);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < soup.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], soup[i + k]);
        hi[k] = Math.max(hi[k], soup[i + k]);
      }
    }
    const extent = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const facets = soup.length / 9;
    const problems: string[] = [];
    extent.forEach((e, k) => {
      if (Math.abs(e - exp.extent[k]) > TOL) problems.push(`extent[${k}] ${e} != ${exp.extent[k]}`);
    });
    if (Math.abs(mp.volume - exp.volume) > TOL * Math.max(1, exp.volume)) problems.push(`volume ${mp.volume} != ${exp.volume}`);
    if (exp.facets !== undefined && facets !== exp.facets) problems.push(`facets ${facets} != ${exp.facets}`);
    if (!mp.watertight) problems.push("boundary is not watertight");
    if (problems.length) failed = true;
    results.push({ file: exp.file, extent, volume: mp.volume, facets, watertight: mp.watertight, problems });
  }
  console.log(JSON.stringify({ versions: kernelVersions(), results }, null, 2));
  if (failed) {
    console.error("Nastran deck geometry mismatch");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
