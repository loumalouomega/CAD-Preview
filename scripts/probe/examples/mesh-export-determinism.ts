/**
 * Which bytes move between two `export_mesh` outputs of the same model?
 *
 *   npm run probe -- scripts/probe/examples/mesh-export-determinism.ts
 *   npm run probe -- scripts/probe/examples/mesh-export-determinism.ts --deterministic
 *
 * Meshes `block.stp` and writes EVERY registered export format twice (1.1 s
 * apart, one process) through the same kernel entry points `export_mesh`
 * uses, companions included, then reports for each whether the bytes are
 * identical and, when not, the differing lines (text) or the first differing
 * byte offsets (binary). A normaliser should target exactly what this finds
 * moving, not what the formats' specs suggest.
 *
 * With `--deterministic` the same pairs go through `normalizeMeshExport`
 * (`src/deterministicMesh.ts`) and every format in `PROMISED` must come out
 * byte-identical; exits 1 otherwise.
 */
import * as fs from "fs";
import { exportBRep } from "../../../src/occtService";
import { exportGeoUnrolled, exportMdpa, exportMeshFormat, generateMesh } from "../../../src/gmshService";
import type { MeshGenerationInput } from "../../../src/gmshService";
import { exportViaMeshio } from "../../../src/meshioService";
import { DEFAULT_MESH_OPTIONS } from "../../../src/meshOptions";
import { MESH_EXPORT_FORMATS } from "../../../src/meshExportFormats";
import type { MeshExportFormat } from "../../../src/meshExportFormats";
import { kernelVersions } from "../../../src/kernelVersions";
import { normalizeMeshExport } from "../../../src/deterministicMesh";

const EXT = process.cwd();
const deterministic = process.argv.includes("--deterministic");

interface Written {
  /** Role -> bytes: the primary file plus any companion. */
  files: Record<string, Uint8Array>;
}

const OPTIONS = { ...DEFAULT_MESH_OPTIONS, dimension: 3 as const, sizeMin: 0, sizeMax: 1.5 };

async function retry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    // A long run in one process can abort a WASM heap; the service has already
    // reset itself, so one clean retry is the documented recovery.
    if (/kernel has been reset/.test(String((err as Error).message))) return run();
    throw err;
  }
}

async function write(input: MeshGenerationInput, format: MeshExportFormat): Promise<Written> {
  const files: Record<string, Uint8Array> = {};
  const text = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
  if (format.id === "msh") {
    files.primary = text((await generateMesh(EXT, input, OPTIONS, [])).mshText);
  } else if (format.id === "geoUnrolled") {
    const geo = await exportGeoUnrolled(EXT, input, OPTIONS, []);
    files.primary = text(geo.text);
    if (geo.xao) files.xao = new Uint8Array(geo.xao);
  } else if (format.id === "mdpaElements" || format.id === "mdpaGeometries") {
    files.primary = text(await exportMdpa(EXT, input, OPTIONS, [], format.id === "mdpaElements" ? "elements" : "geometries"));
  } else if (format.via === "meshio") {
    const meshed = await generateMesh(EXT, input, OPTIONS, []);
    const { bytes, companion } = await exportViaMeshio(meshed.mshText, format.id, {
      extension: format.extension,
      companionExtension: format.companion?.extension,
      source: { name: "block.stp", format: "step" },
      deterministic,
    });
    files.primary = bytes;
    if (companion) files.companion = companion.bytes;
  } else {
    files.primary = text(await exportMeshFormat(EXT, input, OPTIONS, [], format.id as Parameters<typeof exportMeshFormat>[4]));
  }
  if (deterministic) {
    for (const [role, bytes] of Object.entries(files)) files[role] = normalizeMeshExport(format.id, role, bytes);
  }
  return { files };
}

function looksBinary(b: Uint8Array): boolean {
  const n = Math.min(b.length, 4096);
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}

function diff(a: Uint8Array, b: Uint8Array): { identical: boolean; detail: unknown } {
  if (Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0) return { identical: true, detail: null };
  if (looksBinary(a) || looksBinary(b)) {
    let differing = 0;
    const offsets: number[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        differing++;
        if (offsets.length < 8) offsets.push(i);
      }
    }
    return { identical: false, detail: { binary: true, lengths: [a.length, b.length], differingBytes: differing, firstOffsets: offsets } };
  }
  const la = Buffer.from(a).toString("latin1").split(/\r?\n/);
  const lb = Buffer.from(b).toString("latin1").split(/\r?\n/);
  const changed: Array<{ line: number; a: string; b: string }> = [];
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) changed.push({ line: i + 1, a: (la[i] ?? "<none>").slice(0, 140), b: (lb[i] ?? "<none>").slice(0, 140) });
  }
  return { identical: false, detail: { binary: false, changedLines: changed.length, first: changed.slice(0, 6) } };
}

async function main(): Promise<void> {
  const bytes = new Uint8Array(fs.readFileSync("examples/STP/block.stp"));
  const stepBytes = await retry(() => exportBRep(EXT, bytes, "step", "step", [], "mm", false));
  const input: MeshGenerationInput = { kind: "brep", stepBytes };

  const report: Array<{ format: string; file: string; bytes: number; identical: boolean; detail: unknown }> = [];
  const unstable = new Set<string>();
  for (const format of MESH_EXPORT_FORMATS) {
    let a: Written, b: Written;
    try {
      a = await retry(() => write(input, format));
      // Timestamps have one-second resolution: wait so a real one moves.
      await new Promise((r) => setTimeout(r, 1100));
      b = await retry(() => write(input, format));
    } catch (err) {
      report.push({ format: format.id, file: "-", bytes: 0, identical: false, detail: { error: String((err as Error).message).slice(0, 200) } });
      continue;
    }
    for (const role of Object.keys(a.files)) {
      const d = diff(a.files[role], b.files[role] ?? new Uint8Array());
      report.push({ format: format.id, file: role, bytes: a.files[role].length, identical: d.identical, detail: d.detail });
      if (!d.identical) unstable.add(format.id);
    }
  }
  console.log(JSON.stringify({ versions: kernelVersions(), deterministic, unstable: [...unstable], report }, null, 2));
  if (deterministic && unstable.size > 0) {
    console.error(`deterministic mesh exports differ: ${[...unstable].join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
