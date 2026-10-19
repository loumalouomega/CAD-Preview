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
 *   - `box-hex.bdf`         — the same box as two 8-node CHEXA (volume 24).
 *   - `box-wedge.bdf`       — the same box as two 6-node CPENTA (volume 24).
 *   - `plate-shell.bdf`     — a flat shell of two CQUAD4 and one CTRIA3: extent 6 x 3 x 0,
 *                             surface area 15, no volume.
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
  /** Total surface area, for a deck with no volume cells (volume then reads 0). */
  area?: number;
}

const EXPECTED: Expectation[] = [
  { file: "block-tets.bdf", extent: [3, 4, 5], volume: 60, facets: 60 },
  { file: "box-fixed-field.bdf", extent: [2, 3, 4], volume: 24 },
  { file: "box-free-field.bdf", extent: [2, 3, 4], volume: 24 },
  { file: "box-large-field.bdf", extent: [2, 3, 4], volume: 24 },
  { file: "box-hex.bdf", extent: [2, 3, 4], volume: 24 },
  { file: "box-wedge.bdf", extent: [2, 3, 4], volume: 24 },
  { file: "plate-shell.bdf", extent: [6, 3, 0], volume: 0, area: 15 },
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
    let area = 0;
    for (let i = 0; i < soup.length; i += 9) {
      const ux = soup[i + 3] - soup[i], uy = soup[i + 4] - soup[i + 1], uz = soup[i + 5] - soup[i + 2];
      const vx = soup[i + 6] - soup[i], vy = soup[i + 7] - soup[i + 1], vz = soup[i + 8] - soup[i + 2];
      area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    }
    if (exp.area !== undefined) {
      if (Math.abs(area - exp.area) > TOL * Math.max(1, exp.area)) problems.push(`area ${area} != ${exp.area}`);
    } else if (!mp.watertight) problems.push("boundary is not watertight");
    if (problems.length) failed = true;
    results.push({ file: exp.file, extent, volume: mp.volume, area, facets, watertight: mp.watertight, problems });
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
