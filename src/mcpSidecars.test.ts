import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  readEdits,
  writeEdits,
  readParts,
  writeParts,
  readMeshOptions,
  writeMeshOptions,
  editsSidecarPath,
  partsSidecarPath,
  meshOptionsSidecarPath,
  geoScriptPath,
  assertNotSourcePath,
} from "./mcpSidecars";
import { parseEditsJson } from "./editsSidecar";
import { parsePartsJson } from "./partsSidecar";
import { parseMeshJson } from "./meshOptionsSidecar";
import { DEFAULT_MESH_OPTIONS } from "./meshOptions";
import type { EditOp } from "./editOps";
import type { Part } from "./protocol";

let dir: string;
let model: string;
const SOURCE_BYTES = "solid fake\nendsolid fake\n";

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-sidecars-"));
  model = path.join(dir, "model.stp");
  await fs.writeFile(model, SOURCE_BYTES, "utf8");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("path derivation", () => {
  it("matches the extension's sidecar filenames", () => {
    expect(editsSidecarPath("/a/b.stp")).toBe("/a/b.stp.edits.json");
    expect(partsSidecarPath("/a/b.stp")).toBe("/a/b.stp.parts.json");
    expect(meshOptionsSidecarPath("/a/b.stp")).toBe("/a/b.stp.mesh.json");
    expect(geoScriptPath("/a/b.stp")).toBe("/a/b.stp.geo");
  });
});

describe("edits store", () => {
  it("returns empty lists when the sidecar is missing", async () => {
    expect(await readEdits(model)).toEqual({ ops: [], variables: [] });
  });

  it("returns empty lists when the sidecar is corrupt", async () => {
    await fs.writeFile(editsSidecarPath(model), "{not json", "utf8");
    expect(await readEdits(model)).toEqual({ ops: [], variables: [] });
  });

  it("round-trips ops + variables byte-compatibly with parseEditsJson", async () => {
    const ops: EditOp[] = [{ op: "addBox", center: [0, 0, 0], size: [1, 2, 3] } as EditOp];
    const variables = [{ name: "L", expr: "20", value: 20 }];
    await writeEdits(model, ops, variables);
    const text = await fs.readFile(editsSidecarPath(model), "utf8");
    expect(parseEditsJson(text).ops).toEqual(ops);
    const read = await readEdits(model);
    expect(read.ops).toEqual(ops);
    expect(read.variables).toEqual(variables);
    expect(JSON.parse(text).source).toBe("model.stp");
  });

  it("never touches the model source file", async () => {
    await writeEdits(model, [], []);
    expect(await fs.readFile(model, "utf8")).toBe(SOURCE_BYTES);
  });
});

describe("parts store", () => {
  it("returns [] when missing or corrupt", async () => {
    expect(await readParts(model)).toEqual([]);
    await fs.writeFile(partsSidecarPath(model), "[", "utf8");
    expect(await readParts(model)).toEqual([]);
  });

  it("round-trips parts byte-compatibly with parsePartsJson", async () => {
    const parts: Part[] = [
      { name: "Inlet", color: "#ff0000", volumes: [], surfaces: ["face-1"], lines: [], points: [], meshSize: 0.5 },
    ];
    await writeParts(model, parts);
    const text = await fs.readFile(partsSidecarPath(model), "utf8");
    expect(parsePartsJson(text)).toEqual(parts);
    expect(await readParts(model)).toEqual(parts);
  });
});

describe("mesh options store", () => {
  it("returns DEFAULT_MESH_OPTIONS when missing or corrupt", async () => {
    expect(await readMeshOptions(model)).toEqual(DEFAULT_MESH_OPTIONS);
    await fs.writeFile(meshOptionsSidecarPath(model), "?", "utf8");
    expect(await readMeshOptions(model)).toEqual(DEFAULT_MESH_OPTIONS);
  });

  it("writes options AND regenerates the .geo script", async () => {
    const options = { ...DEFAULT_MESH_OPTIONS, dimension: 2 as const };
    await writeMeshOptions(model, options);
    const text = await fs.readFile(meshOptionsSidecarPath(model), "utf8");
    expect(parseMeshJson(text)).toEqual(options);
    const geo = await fs.readFile(geoScriptPath(model), "utf8");
    expect(geo).toContain('Merge "model.stp";');
    expect(geo).toContain("Mesh 2;");
  });

  it("overwrites a hand-edited .geo on the next options write (one-way rule)", async () => {
    await writeMeshOptions(model, DEFAULT_MESH_OPTIONS);
    await fs.writeFile(geoScriptPath(model), "// hand edit\n", "utf8");
    await writeMeshOptions(model, DEFAULT_MESH_OPTIONS);
    const geo = await fs.readFile(geoScriptPath(model), "utf8");
    expect(geo).not.toContain("hand edit");
  });
});

describe("assertNotSourcePath", () => {
  it("throws when the output path resolves to the source", () => {
    expect(() => assertNotSourcePath("/a/b.stp", "/a/b.stp")).toThrow(/source/i);
    expect(() => assertNotSourcePath("/a/b.stp", "/a/./b.stp")).toThrow(/source/i);
  });

  it("allows sibling paths", () => {
    expect(() => assertNotSourcePath("/a/b.stp", "/a/out.msh")).not.toThrow();
  });
});
