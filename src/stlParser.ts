/**
 * Parses raw STL bytes (binary or ASCII, auto-detected) into a flat,
 * ungrouped triangle soup — pure, vscode/OCCT/THREE-free (mirrors
 * `stepUnits.ts`/`igesUnits.ts`'s "no framework, just bytes/text in, plain
 * data out" convention). STL has no shared-vertex indexing at all — every
 * triangle repeats its 3 vertices verbatim — so the only useful shape to
 * parse into is 9 floats (3 vertices × xyz) per triangle, in file order; any
 * deduplication/indexing is a separate concern (see `meshComponents.ts`).
 *
 * This is the first host-side (Node, no `THREE.STLLoader`) STL parser in
 * this codebase — everything else either hands raw STL bytes opaquely to a
 * WASM module's own C++ parser (Gmsh's `gmsh.merge()`, meshio++'s
 * `convertSurface()` — neither ever exposes a triangle array back to JS) or
 * parses via `three/examples/jsm/loaders/STLLoader` in the webview. Written
 * for `stlSolidSignatures.ts`'s Compare-Models support, which needs the
 * triangle data as plain numbers on the extension host / MCP server, where
 * neither a WASM module nor a webview is available.
 */

/** Binary STL: 80-byte header, then a little-endian uint32 triangle count,
 * then exactly `count` 50-byte records (12-byte normal + 3×12-byte vertices
 * + 2-byte attribute byte count). Detected by exact expected-size match
 * (`84 + count * 50`) rather than sniffing the header text for `"solid"` —
 * a binary file's 80-byte header is free-form and may itself start with
 * `"solid"` by convention, the well-known trap naive sniffing falls into. */
function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < 84) return false;
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  return bytes.length === 84 + count * 50;
}

function parseBinaryStl(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  const positions = new Float32Array(count * 9);
  let offset = 84;
  let out = 0;
  for (let i = 0; i < count; i++) {
    offset += 12; // skip the facet normal — recomputed from winding order elsewhere, never trusted from the file
    for (let v = 0; v < 3; v++) {
      positions[out++] = view.getFloat32(offset, true);
      positions[out++] = view.getFloat32(offset + 4, true);
      positions[out++] = view.getFloat32(offset + 8, true);
      offset += 12;
    }
    offset += 2; // attribute byte count
  }
  return positions;
}

const ASCII_VERTEX_RE = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;

function parseAsciiStl(text: string): Float32Array {
  const out: number[] = [];
  for (const m of text.matchAll(ASCII_VERTEX_RE)) {
    out.push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  return new Float32Array(out);
}

/**
 * Returns a flat `Float32Array` of `9 * triangleCount` values (3 vertices ×
 * xyz per triangle, in file order). Throws neither on a malformed file — an
 * unparseable ASCII file simply yields zero `vertex` matches (an empty
 * array), and callers already treat "no triangles" as a degenerate,
 * non-crashing case (same graceful-skip convention as every other
 * unresolved-input path in this codebase).
 */
export function parseStl(bytes: Uint8Array): Float32Array {
  if (isBinaryStl(bytes)) return parseBinaryStl(bytes);
  return parseAsciiStl(Buffer.from(bytes).toString("latin1"));
}

/**
 * Rescales every vertex coordinate by `factor` and re-serializes as ASCII
 * STL text — the host-side STL vertex scaler `CLAUDE.md`'s unit-conversion
 * section notes this codebase never needed before item 1 (export-time unit
 * conversion for BREP/STL/OBJ/PLY/glTF export targets, which all run in the
 * webview or via OCCT) added a *second* consumer: the FE Mesh panel's
 * Gmsh-format export needs the SAME scaled geometry fed to Gmsh, for a
 * mesh-format (STL-sourced) document. Facet normals are always recomputed
 * from the (post-scale) vertex winding via a cross product — never read from
 * the input file — mirroring `parseStl`'s own "recomputed elsewhere, never
 * trusted from the file" convention (a uniform scale never flips winding, so
 * this is equivalent to scaling stored normals, just simpler to implement
 * without carrying them through `parseStl`'s triangle-soup shape at all).
 */
export function scaleStlBytes(bytes: Uint8Array, factor: number): Uint8Array {
  const positions = parseStl(bytes);
  const triangleCount = positions.length / 9;
  const lines: string[] = ["solid scaled"];
  for (let t = 0; t < triangleCount; t++) {
    const o = t * 9;
    const v0: [number, number, number] = [positions[o] * factor, positions[o + 1] * factor, positions[o + 2] * factor];
    const v1: [number, number, number] = [positions[o + 3] * factor, positions[o + 4] * factor, positions[o + 5] * factor];
    const v2: [number, number, number] = [positions[o + 6] * factor, positions[o + 7] * factor, positions[o + 8] * factor];
    const ux = v1[0] - v0[0], uy = v1[1] - v0[1], uz = v1[2] - v0[2];
    const wx = v2[0] - v0[0], wy = v2[1] - v0[1], wz = v2[2] - v0[2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    lines.push(
      `facet normal ${nx} ${ny} ${nz}`,
      "outer loop",
      `vertex ${v0[0]} ${v0[1]} ${v0[2]}`,
      `vertex ${v1[0]} ${v1[1]} ${v1[2]}`,
      `vertex ${v2[0]} ${v2[1]} ${v2[2]}`,
      "endloop",
      "endfacet"
    );
  }
  lines.push("endsolid scaled");
  return Buffer.from(lines.join("\n"), "utf8");
}
