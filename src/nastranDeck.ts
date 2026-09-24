/**
 * Nastran bulk-data normalization for meshio++'s reader (pure, WASM-free).
 *
 * meshio++ (16.x) reads any Nastran bulk-data deck, but only after a
 * `BEGIN BULK` line — without one it throws `Nastran: "BEGIN BULK" statement
 * not found`. Gmsh's own `.bdf` writer (the FE Mesh panel's export) emits a
 * bare bulk-data section (`GRID`/`CTETRA`/… … `ENDDATA`) with no executive or
 * case-control header and no `BEGIN BULK`, so this extension could not reopen
 * its own export. Verified live: prepending the line to a Gmsh-written deck
 * reads back with exactly the generated mesh's point and cell counts. A
 * bulk-only deck is also a common hand-authored/include shape, so the fix
 * belongs on the read side rather than in the exporter.
 */

const BEGIN_BULK = /^[ \t]*BEGIN[ \t]+BULK\b/im;

/** Returns `bytes` unchanged when a `BEGIN BULK` line is present, otherwise a
 * copy with `BEGIN BULK\n` prepended. Decoded as latin1 (1 byte = 1 char) so a
 * non-ASCII comment can never shift or corrupt the scan. */
export function ensureNastranBulkHeader(bytes: Uint8Array): Uint8Array {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  if (BEGIN_BULK.test(text)) return bytes;
  const header = Buffer.from("BEGIN BULK\n", "latin1");
  const out = new Uint8Array(header.length + bytes.length);
  out.set(header, 0);
  out.set(bytes, header.length);
  return out;
}
