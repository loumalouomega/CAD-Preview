import { describe, expect, it } from "vitest";
import { ensureNastranBulkHeader } from "./nastranDeck";

const enc = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));
const dec = (b: Uint8Array) => Buffer.from(b).toString("latin1");

describe("ensureNastranBulkHeader", () => {
  it("prepends BEGIN BULK to a Gmsh-style bulk-only deck", () => {
    const deck = "$ Created by Gmsh\nGRID    1       0       0.0     0.0     0.0\nENDDATA\n";
    expect(dec(ensureNastranBulkHeader(enc(deck)))).toBe(`BEGIN BULK\n${deck}`);
  });

  it("returns the same bytes when a BEGIN BULK line already exists", () => {
    const bytes = enc("SOL 101\nCEND\nBEGIN BULK\nGRID,1,,0.,0.,0.\nENDDATA\n");
    expect(ensureNastranBulkHeader(bytes)).toBe(bytes);
  });

  it("leaves a full deck (executive + case control + BEGIN BULK) byte-identical", () => {
    const deck =
      "ID EXAMPLE,BOXDECK\nSOL 101\nCEND\nTITLE = A BOX\nSUBCASE 1\n  LOAD = 1\nBEGIN BULK\n" +
      "GRID    101     0       0.0     0.0     0.0\nCTETRA  1       1       101     102     103     104     105     106     +T1\n" +
      "+T1     107     108     109     110\nENDDATA\n";
    const bytes = enc(deck);
    const out = ensureNastranBulkHeader(bytes);
    expect(out).toBe(bytes);
    expect(dec(out)).toBe(deck);
  });

  it("matches case-insensitively, with leading whitespace and extra spacing", () => {
    const bytes = enc("  begin   bulk\nGRID,1,,0.,0.,0.\n");
    expect(ensureNastranBulkHeader(bytes)).toBe(bytes);
  });

  it("does not treat BEGIN BULK inside a comment or mid-line as a header", () => {
    const deck = "$ BEGIN BULK is missing here\nGRID,1,,0.,0.,0.\n";
    expect(dec(ensureNastranBulkHeader(enc(deck)))).toBe(`BEGIN BULK\n${deck}`);
  });

  it("respects a non-zero byteOffset view (pooled Buffer)", () => {
    const pool = enc("XXXXBEGIN BULK\nENDDATA\n");
    const view = pool.subarray(4);
    expect(ensureNastranBulkHeader(view)).toBe(view);
  });
});
