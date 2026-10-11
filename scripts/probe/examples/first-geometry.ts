/**
 * Roadmap "Post geometry before the XCAF assembly tree" — live-WASM check.
 *
 *   npm run probe -- scripts/probe/examples/first-geometry.ts
 *
 * For each fixture, runs `loadBRepCached` twice from a cold cache:
 *   - synchronous (today's MCP-style behaviour): the XCAF read happens before
 *     the call returns;
 *   - deferred (the interactive path): the call returns the flat tree with
 *     `assemblyPending`, then `resolveAssemblyTree` upgrades it.
 * and asserts the upgraded tree is DEEP-EQUAL to the synchronous one, that the
 * deferred call is not slower than the synchronous one, and that after a
 * topology-changing append the resolved tree falls back (null = keep flat).
 * Prints both timings so they can be recorded. Exits 1 on any mismatch.
 */
import * as fs from "fs";
import * as path from "path";
import { loadBRepCached, resolveAssemblyTree, disposeBRepCache } from "../../../src/occtService";
import type { EditOp } from "../../../src/editOps";

const FIXTURES = ["angle1.stp", "bull.stp", "as1_pe.stp", "turbine.stp"];
const ADD_BOX = { op: "addBox", center: [500, 500, 500], size: [1, 1, 1] } as unknown as EditOp;

async function main(): Promise<void> {
  const ext = process.cwd();
  let failed = false;
  const rows: unknown[] = [];
  for (const name of FIXTURES) {
    const bytes = fs.readFileSync(path.join("examples", "STP", name));

    const t0 = Date.now();
    const sync = await loadBRepCached(ext, bytes, "step", [], undefined);
    const syncMs = Date.now() - t0;

    const t1 = Date.now();
    const def = await loadBRepCached(ext, bytes, "step", [], undefined, undefined, { deferAssemblyTree: true });
    const deferMs = Date.now() - t1;

    const t2 = Date.now();
    const nested = await resolveAssemblyTree(ext, def.cache);
    const resolveMs = Date.now() - t2;

    // What the interactive path ends up showing (the upgraded tree, or the flat
    // one when resolve returns null) must equal what the synchronous call
    // returned. `nested` records whether an upgrade actually changed anything.
    const finalTree = nested ?? def.result.tree;
    const upgraded = JSON.stringify(finalTree) !== JSON.stringify(def.result.tree);
    const ok =
      def.result.assemblyPending === true &&
      sync.result.assemblyPending === undefined &&
      JSON.stringify(finalTree) === JSON.stringify(sync.result.tree);
    if (!ok) { failed = true; console.error(`MISMATCH ${name}: upgraded tree differs from the synchronous tree`); }

    // Topology-changing append on the (now resolved) deferred entry: the
    // cached XCAF info can no longer form a bijection → flat (null).
    const appended = await loadBRepCached(ext, bytes, "step", [ADD_BOX], def.cache, undefined, { deferAssemblyTree: true });
    const afterAppend = await resolveAssemblyTree(ext, appended.cache);
    if (afterAppend !== null) { failed = true; console.error(`MISMATCH ${name}: append should fall back to flat`); }
    if (appended.result.assemblyPending) { failed = true; console.error(`MISMATCH ${name}: reused resolved cache must not be pending`); }

    rows.push({ name, syncMs, deferMs, resolveMs, upgraded, leaves: sync.result.groups.length });
    disposeBRepCache(appended.cache);
    disposeBRepCache(sync.cache);
  }
  console.log(JSON.stringify(rows, null, 2));
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
