/**
 * Which bytes move between two exports of the same model?
 *
 *   npm run probe -- scripts/probe/examples/export-determinism.ts
 *
 * Exports `bull.stp` twice per B-rep format (STEP, IGES, BREP; STEP also with a
 * named Part, which routes through the XCAF writer) and reports, for each pair,
 * whether the bytes are identical and — when they are not — the differing
 * lines, so a normaliser targets exactly the fields that actually change rather
 * than ones assumed from the formats' specs. With `deterministic` (when the
 * export takes the flag) the same pairs must come out byte-identical.
 *
 * Exits 1 only if a `deterministic` pair differs.
 */
import * as fs from "fs";
import { exportBRep } from "../../../src/occtService";
import type { BRepFormat } from "../../../src/occtService";
import type { Part } from "../../../src/protocol";
import { kernelVersions } from "../../../src/kernelVersions";

const EXT = process.cwd();
const deterministic = process.argv.includes("--deterministic");

function lines(b: Uint8Array): string[] {
  return Buffer.from(b).toString("latin1").split(/\r?\n/);
}

function diff(a: Uint8Array, b: Uint8Array): { identical: boolean; changed: Array<{ line: number; a: string; b: string }> } {
  if (Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0) return { identical: true, changed: [] };
  const la = lines(a), lb = lines(b);
  const changed: Array<{ line: number; a: string; b: string }> = [];
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) changed.push({ line: i + 1, a: (la[i] ?? "<none>").slice(0, 160), b: (lb[i] ?? "<none>").slice(0, 160) });
  }
  return { identical: false, changed: changed.slice(0, 12) };
}

async function once(bytes: Uint8Array, target: BRepFormat, parts: Part[]): Promise<Uint8Array> {
  // The trailing argument is the `deterministic` flag once it exists.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = exportBRep as any;
  return fn(EXT, bytes, "step", target, [], "mm", true, parts, deterministic);
}

async function main(): Promise<void> {
  const bytes = new Uint8Array(fs.readFileSync("examples/STP/bull.stp"));
  const part: Part = { name: "Body", color: "#ff8800", volumes: ["solid-0"], surfaces: [], lines: [], points: [] };
  const cases: Array<[string, BRepFormat, Part[]]> = [
    ["step", "step", []],
    ["step+parts(xcaf)", "step", [part]],
    ["iges", "iges", []],
    ["brep", "brep", []],
  ];
  const report: unknown[] = [];
  let failed = false;
  for (const [name, fmt, parts] of cases) {
    const a = await once(bytes, fmt, parts);
    // The timestamps have one-second resolution: wait so a real timestamp moves.
    await new Promise((r) => setTimeout(r, 1100));
    const b = await once(bytes, fmt, parts);
    const d = diff(a, b);
    report.push({ case: name, bytes: a.length, identical: d.identical, changed: d.changed });
    if (deterministic && !d.identical) failed = true;
  }
  console.log(JSON.stringify({ versions: kernelVersions(), deterministic, report }, null, 2));
  if (failed) {
    console.error("deterministic exports differ");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
