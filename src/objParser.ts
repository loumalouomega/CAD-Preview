/**
 * Pure host-side OBJ parser — vscode/OCCT/THREE-free, mirrors `stlParser.ts`'s
 * "no framework, just bytes in, plain data out" convention. Unlike STL, OBJ
 * already carries explicit shared-vertex indexing (`f` lines reference `v`
 * lines by index), so this parses directly into an indexed mesh — no
 * `weldTriangleSoup()` welding pass needed, unlike the STL path.
 */

export interface WeldedMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Resolves one `f` line's vertex-reference token (`v`, `v/vt`, `v/vt/vn`, or
 * `v//vn` — only the leading `v` part is ever used) to a 0-based position
 * index. OBJ indices are 1-based when positive; a negative index is relative
 * to the CURRENT vertex count at that point in the file (`-1` = the most
 * recently declared vertex) per the OBJ spec. */
function resolveObjIndex(token: string, vertexCount: number): number {
  const raw = parseInt(token.split("/")[0], 10);
  if (!Number.isFinite(raw)) return -1;
  return raw > 0 ? raw - 1 : vertexCount + raw;
}

/**
 * Parses raw OBJ bytes into a flat, shared-vertex indexed mesh. Only `v`
 * (vertex position) and `f` (face) lines are read — texture coordinates
 * (`vt`), normals (`vn`), groups/objects (`g`/`o`), materials (`usemtl`/
 * `mtllib`), and everything else are ignored. A face with more than 3
 * vertices is fan-triangulated `(v0,v1,v2), (v0,v2,v3), …` — the same
 * convention `three/examples/jsm/loaders/OBJLoader` uses. Never throws: a
 * face whose reference resolves out of range is skipped (same
 * graceful-degradation convention as every other host-side parser in this
 * codebase), and a file with no `v`/`f` lines at all just yields an empty
 * mesh.
 */
export function parseObj(bytes: Uint8Array): WeldedMesh {
  const text = Buffer.from(bytes).toString("utf8");
  const positions: number[] = [];
  const indices: number[] = [];

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const sp = line.indexOf(" ");
    const tag = sp === -1 ? line : line.slice(0, sp);

    if (tag === "v") {
      const parts = line.slice(sp + 1).trim().split(/\s+/);
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      const z = Number(parts[2]);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) positions.push(x, y, z);
    } else if (tag === "f") {
      const tokens = line.slice(sp + 1).trim().split(/\s+/).filter((t) => t.length > 0);
      if (tokens.length < 3) continue;
      const vertexCount = positions.length / 3;
      const resolved = tokens.map((t) => resolveObjIndex(t, vertexCount));
      if (resolved.some((i) => i < 0 || i >= vertexCount)) continue;
      for (let i = 1; i < resolved.length - 1; i++) {
        indices.push(resolved[0], resolved[i], resolved[i + 1]);
      }
    }
  }

  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
