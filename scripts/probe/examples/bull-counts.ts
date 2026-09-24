/**
 * Example probe — the skeleton every live-WASM probe should follow.
 *
 *   npm run probe -- scripts/probe/examples/bull-counts.ts
 *
 * Opens examples/STP/bull.stp through the real `readShape`, counts faces and
 * edges with the SAME enumerations that assign `face-N` / `edge-N` ids
 * (`collectFaces` / `collectEdges`), and checks the known 36 / 98. Exits 1 on
 * a mismatch, so it doubles as a smoke check that the harness itself works.
 *
 * Copy it to scripts/probe/scratch/ (git-ignored) to start a new probe.
 */
import * as fs from "fs";
import * as path from "path";
import { getOcct, readShape, wrapOcctFault } from "../../../src/occtService";
import { collectEdges, collectFaces } from "../../../src/occtOperations";
import { kernelVersions } from "../../../src/kernelVersions";

async function main(): Promise<void> {
  // run.mjs sets cwd to the repo root, where dist/*.wasm lives.
  const extensionPath = process.cwd();
  const fixture = path.join("examples", "STP", "bull.stp");

  const t0 = Date.now();
  const oc = await getOcct(extensionPath);
  const initMs = Date.now() - t0;

  // MEMFS paths stay at 10 characters or fewer — 11+ silently corrupts STEP
  // writes in this build (see CLAUDE.md).
  const memPath = "/p.step";
  oc.FS.writeFile(memPath, fs.readFileSync(fixture));

  // Every wrapped OCCT object is an Emscripten heap handle, never GC'd: push
  // each one here and delete them all, in reverse, in `finally`.
  const cleanup: Array<{ delete(): void }> = [];
  try {
    const t1 = Date.now();
    const shape = readShape(oc, memPath, "step", cleanup);
    const faces = collectFaces(oc, shape, cleanup).length;
    const edges = collectEdges(oc, shape, cleanup).length;
    const facts = {
      versions: kernelVersions(),
      fixture,
      faces,
      edges,
      initMs,
      probeMs: Date.now() - t1,
    };
    console.log(JSON.stringify(facts, null, 2));
    if (faces !== 36 || edges !== 98) {
      console.error(`expected 36 faces / 98 edges, got ${faces} / ${edges}`);
      process.exitCode = 1;
    }
  } catch (err) {
    // An abort leaves the Emscripten instance permanently corrupt.
    // wrapOcctFault recognizes one and calls resetOcct() itself, so a probe
    // that keeps going after a deliberate abort gets a fresh kernel on its
    // next getOcct(). Call resetOcct() directly only for a hang you detect
    // yourself. (Probing Gmsh? getGmsh/resetGmsh live in src/gmshService.)
    throw wrapOcctFault(err);
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try {
        cleanup[i].delete();
      } catch {
        /* already freed with its owner */
      }
    }
    try {
      oc.FS.unlink(memPath);
    } catch {
      /* not written */
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
