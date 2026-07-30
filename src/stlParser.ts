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
