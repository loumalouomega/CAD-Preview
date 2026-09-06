/**
 * Tests for src/scadService.ts.
 *
 * No `openscad` binary exists in this environment (or in CI), so every
 * binary interaction runs through committed stub scripts
 * (`src/test-fixtures/openscad-*.sh`, POSIX-only — CI is Linux-only per the
 * xvfb note in CLAUDE.md). The stubs go through the REAL `execFile`
 * plumbing (arg shape, cwd, timeout-kill, exit-code mapping all genuinely
 * exercised); only the flags' fidelity to a real openscad is untested here
 * (stated in scadService.ts — needs one manual run where openscad exists).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveOpenscadBinary,
  isOpenscadAvailable,
  convertScadToCsg,
  resolveEffectiveSource,
  ScadUnavailableError,
  DEFAULT_OPENSCAD_BINARY,
  OPENSCAD_BINARY_ENV,
} from "./scadService";

const FIXTURES = path.join(__dirname, "test-fixtures");
const STUB = path.join(FIXTURES, "openscad-stub.sh");
const FAIL = path.join(FIXTURES, "openscad-fail.sh");
const SLOW = path.join(FIXTURES, "openscad-slow.sh");

let savedEnv: string | undefined;
let tmpDirs: string[] = [];

beforeEach(() => {
  savedEnv = process.env[OPENSCAD_BINARY_ENV];
  delete process.env[OPENSCAD_BINARY_ENV];
  // Belt-and-braces: the stubs are committed +x, but a checkout that drops
  // the bit must not turn into a confusing ENOENT failure.
  for (const f of [STUB, FAIL, SLOW]) fs.chmodSync(f, 0o755);
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[OPENSCAD_BINARY_ENV];
  else process.env[OPENSCAD_BINARY_ENV] = savedEnv;
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

function makeModelDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "scad-service-test-"));
  tmpDirs.push(d);
  fs.writeFileSync(path.join(d, "model.scad"), "cube(size = [10, 10, 10], center = true);\n");
  return d;
}

function countScadTmpDirs(): number {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("cad-preview-scad-")).length;
}

describe("resolveOpenscadBinary", () => {
  it("prefers the explicit setting", () => {
    process.env[OPENSCAD_BINARY_ENV] = "/env/openscad";
    expect(resolveOpenscadBinary("/setting/openscad")).toBe("/setting/openscad");
  });
  it("falls back to the env var, then the PATH default", () => {
    expect(resolveOpenscadBinary()).toBe(DEFAULT_OPENSCAD_BINARY);
    process.env[OPENSCAD_BINARY_ENV] = "/env/openscad";
    expect(resolveOpenscadBinary()).toBe("/env/openscad");
  });
  it("treats empty strings as unset at every level", () => {
    process.env[OPENSCAD_BINARY_ENV] = "   ";
    expect(resolveOpenscadBinary("")).toBe(DEFAULT_OPENSCAD_BINARY);
    expect(resolveOpenscadBinary("  ")).toBe(DEFAULT_OPENSCAD_BINARY);
  });
});

describe("isOpenscadAvailable", () => {
  it("reports a missing binary as unavailable with an install hint, never throws", () => {
    return expect(isOpenscadAvailable("definitely-not-a-real-binary-xyz")).resolves.toMatchObject({
      available: false,
      reason: expect.stringMatching(/not found|openscad/i),
    });
  });
  it("reports the stub binary as available", () => {
    return expect(isOpenscadAvailable(STUB)).resolves.toEqual({ available: true });
  });
});

describe("convertScadToCsg", () => {
  it("converts through the stub and surfaces its stderr as warnings", async () => {
    const dir = makeModelDir();
    const { csgBytes, warnings } = await convertScadToCsg(path.join(dir, "model.scad"), { binary: STUB });
    expect(Buffer.from(csgBytes).toString("utf8")).toContain("cube(size = [10, 10, 10]");
    expect(warnings).toEqual([expect.stringMatching(/^openscad: /)]);
  });

  it("invokes with -o <tmp.csg> <real path> and cwd = the source directory", async () => {
    const dir = makeModelDir();
    const record = path.join(dir, "record.json");
    process.env.STUB_RECORD = record;
    try {
      await convertScadToCsg(path.join(dir, "model.scad"), { binary: STUB });
    } finally {
      delete process.env.STUB_RECORD;
    }
    const rec = JSON.parse(fs.readFileSync(record, "utf8")) as { argv: string[]; cwd: string };
    expect(rec.argv[0]).toBe("-o");
    expect(rec.argv[1].endsWith(".csg")).toBe(true);
    expect(rec.argv[2]).toBe(path.join(dir, "model.scad"));
    // The REAL path is passed (never a temp copy) so relative
    // use/include/import resolve exactly as a manual invocation would.
    expect(rec.cwd).toBe(dir);
  });

  it("maps a failing binary to a clear error carrying the stderr tail", async () => {
    const dir = makeModelDir();
    await expect(convertScadToCsg(path.join(dir, "model.scad"), { binary: FAIL })).rejects.toThrow(
      /openscad failed.*Can't open input file/
    );
  });

  it("kills a hung binary at the timeout and throws a timeout error", async () => {
    const dir = makeModelDir();
    await expect(convertScadToCsg(path.join(dir, "model.scad"), { binary: SLOW, timeoutMs: 200 })).rejects.toThrow(
      /timed out after .* \(child killed\)/
    );
  }, 10000);

  it("maps a vanishing binary to ScadUnavailableError (graceful path survives TOCTOU)", async () => {
    const dir = makeModelDir();
    const err = await convertScadToCsg(path.join(dir, "model.scad"), {
      binary: "definitely-not-a-real-binary-xyz",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ScadUnavailableError);
  });

  it("leaves no temp dirs behind", async () => {
    const dir = makeModelDir();
    const before = countScadTmpDirs();
    await convertScadToCsg(path.join(dir, "model.scad"), { binary: STUB });
    expect(countScadTmpDirs()).toBe(before);
  });
});

describe("resolveEffectiveSource", () => {
  it("passes non-scad formats through byte-identical with no warnings", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const warnings: string[] = [];
    const out = await resolveEffectiveSource({
      modelPath: "/fake/model.step",
      format: "step",
      readBytes: async () => bytes,
      warnings,
    });
    expect(out).toEqual({ bytes, format: "step" });
    expect(out.bytes).toBe(bytes);
    expect(warnings).toEqual([]);
  });

  it("converts .scad and returns format csg with warnings pushed", async () => {
    const dir = makeModelDir();
    const warnings: string[] = [];
    let readCalled = false;
    const out = await resolveEffectiveSource({
      modelPath: path.join(dir, "model.scad"),
      format: "scad",
      readBytes: async () => {
        readCalled = true;
        return new Uint8Array();
      },
      warnings,
      binary: STUB,
    });
    // The raw .scad bytes are never read — the binary works from the real
    // path, and downstream only ever sees converted .csg bytes as "csg".
    expect(readCalled).toBe(false);
    expect(out.format).toBe("csg");
    expect(Buffer.from(out.bytes).toString("utf8")).toContain("cube(");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("propagates ScadUnavailableError for callers to map to supported:false", async () => {
    await expect(
      resolveEffectiveSource({
        modelPath: "/fake/model.scad",
        format: "scad",
        readBytes: async () => new Uint8Array(),
        warnings: [],
        binary: "definitely-not-a-real-binary-xyz",
      })
    ).rejects.toBeInstanceOf(ScadUnavailableError);
  });
});
