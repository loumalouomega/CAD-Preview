/**
 * Tests for src/scadService.ts.
 *
 * Binary interaction runs through committed stub scripts
 * (`src/test-fixtures/openscad-*.sh`, POSIX-only — CI is Linux-only per the
 * xvfb note in CLAUDE.md). The stubs go through the REAL `execFile`
 * plumbing (arg shape, cwd, timeout-kill, exit-code mapping all genuinely
 * exercised). Flag fidelity was verified against a real OpenSCAD 2021.01
 * binary on 2026-09-07 (see scadService.ts header); the stubs stay
 * plumbing-only by design — they never check input existence, so the
 * relative-path argv regression test below asserts the argv shape, while the
 * live run is what proved the original failure.
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
  OPENSCAD_BACKEND_ENV,
  OPENSCAD_LIBRARY_ENV,
  resolveScadBackend,
  scadChildEnv,
  scadArgs,
} from "./scadService";

const FIXTURES = path.join(__dirname, "test-fixtures");
const STUB = path.join(FIXTURES, "openscad-stub.sh");
const FAIL = path.join(FIXTURES, "openscad-fail.sh");
const SLOW = path.join(FIXTURES, "openscad-slow.sh");
const ARGV_STUB = path.join(FIXTURES, "openscad-argv-stub.sh");

let savedEnv: string | undefined;
let savedBackend: string | undefined;
let savedLibs: string | undefined;
let tmpDirs: string[] = [];

beforeEach(() => {
  savedEnv = process.env[OPENSCAD_BINARY_ENV];
  savedBackend = process.env[OPENSCAD_BACKEND_ENV];
  savedLibs = process.env[OPENSCAD_LIBRARY_ENV];
  delete process.env[OPENSCAD_BINARY_ENV];
  delete process.env[OPENSCAD_BACKEND_ENV];
  delete process.env[OPENSCAD_LIBRARY_ENV];
  // Belt-and-braces: the stubs are committed +x, but a checkout that drops
  // the bit must not turn into a confusing ENOENT failure.
  for (const f of [STUB, FAIL, SLOW, ARGV_STUB]) fs.chmodSync(f, 0o755);
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[OPENSCAD_BINARY_ENV];
  else process.env[OPENSCAD_BINARY_ENV] = savedEnv;
  if (savedBackend === undefined) delete process.env[OPENSCAD_BACKEND_ENV];
  else process.env[OPENSCAD_BACKEND_ENV] = savedBackend;
  if (savedLibs === undefined) delete process.env[OPENSCAD_LIBRARY_ENV];
  else process.env[OPENSCAD_LIBRARY_ENV] = savedLibs;
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

  it("passes an absolute input path even when given a relative one", async () => {
    // Live-binary finding: argv carried the raw (possibly relative) path
    // while cwd was already the source dir, so a relative call resolved to
    // `<dir>/<relpath>` and openscad failed with "Can't open input file".
    // The stub never checks input existence, so only the argv shape is
    // assertable here — the live run is what proved the failure.
    const dir = makeModelDir();
    const rel = path.relative(process.cwd(), path.join(dir, "model.scad"));
    const record = path.join(dir, "record-rel.json");
    process.env.STUB_RECORD = record;
    try {
      await convertScadToCsg(rel, { binary: STUB });
    } finally {
      delete process.env.STUB_RECORD;
    }
    const rec = JSON.parse(fs.readFileSync(record, "utf8")) as { argv: string[]; cwd: string };
    expect(path.isAbsolute(rec.argv[2])).toBe(true);
    expect(rec.argv[2]).toBe(path.resolve(rel));
    expect(rec.cwd).toBe(path.dirname(path.resolve(rel)));
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

describe("resolveScadBackend", () => {
  it("is unset by default and for auto/blank/unknown values", () => {
    expect(resolveScadBackend()).toBeUndefined();
    expect(resolveScadBackend("auto")).toBeUndefined();
    expect(resolveScadBackend("  ")).toBeUndefined();
    expect(resolveScadBackend("fast")).toBeUndefined();
  });
  it("accepts cgal and manifold case-insensitively, explicit before env", () => {
    expect(resolveScadBackend("Manifold")).toBe("manifold");
    process.env[OPENSCAD_BACKEND_ENV] = "cgal";
    expect(resolveScadBackend()).toBe("cgal");
    expect(resolveScadBackend("manifold")).toBe("manifold");
  });
  it("lets an explicit auto beat the env var", () => {
    process.env[OPENSCAD_BACKEND_ENV] = "manifold";
    expect(resolveScadBackend("auto")).toBeUndefined();
  });
});

describe("scadChildEnv", () => {
  it("returns the base environment untouched with no paths", () => {
    const base = { A: "1" };
    expect(scadChildEnv(undefined, base)).toBe(base);
    expect(scadChildEnv(["", "  "], base)).toBe(base);
  });
  it("prepends paths to an inherited OPENSCADPATH using the platform delimiter", () => {
    const env = scadChildEnv(["/libs/a", "/libs/b"], { OPENSCADPATH: "/old" });
    expect(env[OPENSCAD_LIBRARY_ENV]).toBe(["/libs/a", "/libs/b", "/old"].join(path.delimiter));
  });
  it("does not mutate the base", () => {
    const base = { OPENSCADPATH: "/old" };
    scadChildEnv(["/x"], base);
    expect(base.OPENSCADPATH).toBe("/old");
  });
});

describe("scadArgs", () => {
  it("is exactly -o <out> <in> with nothing configured", () => {
    expect(scadArgs("/o.csg", "/in.scad")).toEqual(["-o", "/o.csg", "/in.scad"]);
  });
  it("puts the backend flag and -D pairs before -o", () => {
    expect(scadArgs("/o.csg", "/in.scad", { backend: "manifold", defines: { w: 3, s: "a b", $fn: 32 } })).toEqual([
      "--backend=manifold",
      "-D", "w=3",
      "-D", 's="a b"',
      "-D", "$fn=32",
      "-o", "/o.csg", "/in.scad",
    ]);
  });
  it("refuses an invalid variable name rather than building argv from it", () => {
    expect(() => scadArgs("/o", "/i", { defines: { "x=1;y": 2 } })).toThrow(/Invalid OpenSCAD variable name/);
  });
});

describe("convertScadToCsg with backend, libraries and overrides", () => {
  async function run(extra: Parameters<typeof convertScadToCsg>[1]) {
    const dir = makeModelDir();
    const argv = path.join(dir, "argv.txt");
    const envFile = path.join(dir, "env.txt");
    process.env.STUB_ARGV = argv;
    process.env.STUB_ENV = envFile;
    try {
      await convertScadToCsg(path.join(dir, "model.scad"), { binary: ARGV_STUB, ...extra });
    } finally {
      delete process.env.STUB_ARGV;
      delete process.env.STUB_ENV;
    }
    return {
      dir,
      args: fs.readFileSync(argv, "utf8").split("\n").filter((l) => l !== ""),
      libs: fs.readFileSync(envFile, "utf8"),
    };
  }

  it("passes the backend flag, -D overrides and library paths through the real execFile", async () => {
    const { dir, args, libs } = await run({ backend: "manifold", defines: { wall: 4, name: "x" }, libraryPaths: ["/opt/bosl2"] });
    expect(args.slice(0, 5)).toEqual(["--backend=manifold", "-D", "wall=4", "-D", 'name="x"']);
    expect(args[5]).toBe("-o");
    expect(args[7]).toBe(path.join(dir, "model.scad"));
    expect(libs).toBe("/opt/bosl2");
  });

  it("passes none of it by default (stock invocation unchanged)", async () => {
    const { args, libs } = await run({});
    expect(args[0]).toBe("-o");
    expect(args).toHaveLength(3);
    expect(libs).toBe("");
  });

  it("reads the backend from the environment when unset", async () => {
    process.env[OPENSCAD_BACKEND_ENV] = "cgal";
    const { args } = await run({});
    expect(args[0]).toBe("--backend=cgal");
  });

  it("names the backend when an older openscad rejects the flag", async () => {
    const dir = makeModelDir();
    process.env.STUB_FAIL_STDERR = "openscad: unrecognised option '--backend=manifold'";
    process.env.STUB_ARGV = path.join(dir, "a.txt");
    try {
      await expect(convertScadToCsg(path.join(dir, "model.scad"), { binary: ARGV_STUB, backend: "manifold" })).rejects.toThrow(
        /may not support --backend=manifold/
      );
    } finally {
      delete process.env.STUB_FAIL_STDERR;
      delete process.env.STUB_ARGV;
    }
  });

  it("does not blame the backend for an unrelated failure", async () => {
    const dir = makeModelDir();
    process.env.STUB_FAIL_STDERR = "ERROR: Parser error in line 3";
    try {
      const err = await convertScadToCsg(path.join(dir, "model.scad"), { binary: ARGV_STUB, backend: "manifold" }).catch((e) => e);
      expect(String(err.message)).toMatch(/Parser error/);
      expect(String(err.message)).not.toMatch(/--backend/);
    } finally {
      delete process.env.STUB_FAIL_STDERR;
    }
  });
});
