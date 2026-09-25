import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { bakeMeshEdits } from "./meshEditBake";
import { parseMeshObject, parseGltfObject, tagMeshEntities } from "./webview/meshObject";
import { parseToWeldedMesh } from "./meshParse";
import { boundsOfTriangles } from "./meshComponents";
import type { EditOp } from "./editOps";

const EX = path.resolve(__dirname, "../examples");
const read = (rel: string) => new Uint8Array(fs.readFileSync(path.join(EX, rel)));

function bounds(bytes: Uint8Array, format: "stl" | "obj" | "ply") {
  const mesh = parseToWeldedMesh(bytes, format);
  const tris = Array.from({ length: mesh.indices.length / 3 }, (_, i) => i);
  return boundsOfTriangles(mesh.positions, mesh.indices, tris)!;
}

function ids(root: { traverse: (cb: (o: { userData: Record<string, unknown> }) => void) => void }): string[] {
  const out: string[] = [];
  root.traverse((o) => out.push(o.userData.groupId as string));
  return out;
}

const translate = (target: string, vec: [number, number, number]): EditOp =>
  ({ op: "translate", targets: [target], vec }) as EditOp;

describe("bakeMeshEdits", () => {
  it("applies a translate to an STL (the roadmap's done-when)", async () => {
    const raw = read("STL/cube.stl");
    const before = bounds(raw, "stl");
    const { bytes, outcomes } = await bakeMeshEdits(raw, "stl", [translate("node-0", [100, 0, 0])], "stl");
    const after = bounds(bytes, "stl");
    expect(outcomes).toEqual([expect.objectContaining({ applied: true })]);
    expect(after.min[0]).toBeCloseTo(before.min[0] + 100, 4);
    expect(after.max[1]).toBeCloseTo(before.max[1], 4);
  });

  it("reads a Buffer that is a view into a larger allocation (the IPC-unmarshalled shape)", async () => {
    // kernelIpc unmarshals small payloads into pooled Buffers; Buffer#slice is a
    // view, so a `.slice().buffer` copy would hand STLLoader the whole pool.
    const raw = read("STL/cube.stl");
    const view = Buffer.concat([Buffer.alloc(13, 0xff), Buffer.from(raw)]).subarray(13);
    const before = bounds(raw, "stl");
    const { bytes } = await bakeMeshEdits(view, "stl", [translate("node-0", [100, 0, 0])], "stl");
    expect(bounds(bytes, "stl").min[0]).toBeCloseTo(before.min[0] + 100, 4);
  });

  it("round-trips OBJ and PLY in their own format", async () => {
    for (const [rel, fmt] of [["OBJ/cube.obj", "obj"], ["PLY/cube.ply", "ply"]] as const) {
      const raw = read(rel);
      const before = bounds(raw, fmt);
      const root = parseMeshObject(raw, fmt);
      tagMeshEntities(root);
      const all = ids(root);
      const target = all[all.length - 1]; // the mesh itself (an OBJ root is a Group)
      const { bytes } = await bakeMeshEdits(raw, fmt, [translate(target, [0, 0, 5])], fmt);
      const after = bounds(bytes, fmt);
      expect(after.min[2]).toBeCloseTo(before.min[2] + 5, 4);
    }
  });

  it("moves only the targeted node of a glTF hierarchy", async () => {
    const raw = read("GLTF/two-boxes.gltf");
    const root = await parseGltfObject(raw);
    tagMeshEntities(root);
    const meshIds: string[] = [];
    root.traverse((o) => {
      if ((o as { isMesh?: boolean }).isMesh) meshIds.push(o.userData.groupId as string);
    });
    expect(meshIds.length).toBe(2);
    const plain = await bakeMeshEdits(raw, "gltf", [], "stl");
    const moved = await bakeMeshEdits(raw, "gltf", [translate(meshIds[0], [0, 0, 50])], "stl");
    const b0 = bounds(plain.bytes, "stl");
    const b1 = bounds(moved.bytes, "stl");
    expect(b1.max[2]).toBeCloseTo(b0.max[2] + 50, 4); // one box rose
    expect(b1.min[2]).toBeCloseTo(b0.min[2], 4); // the other stayed put
  });

  it("records a skipped op instead of throwing", async () => {
    const raw = read("STL/cube.stl");
    const { outcomes } = await bakeMeshEdits(raw, "stl", [translate("node-99", [1, 0, 0])], "stl");
    expect(outcomes[0].applied).toBe(false);
  });

  it("keeps the webview's node-N ids for every fixture", async () => {
    const stl = parseMeshObject(read("STL/cube.stl"), "stl");
    tagMeshEntities(stl);
    expect(ids(stl)).toEqual(["node-0"]);
    const obj = parseMeshObject(read("OBJ/cube.obj"), "obj");
    tagMeshEntities(obj);
    expect(ids(obj)[0]).toBe("node-0");
    expect(ids(obj).length).toBeGreaterThan(1); // Group + child mesh(es), NOT a welded single mesh
  });
});
