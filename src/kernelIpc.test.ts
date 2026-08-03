import { describe, it, expect } from "vitest";
import { marshal, unmarshal } from "./kernelIpc";

describe("marshal/unmarshal", () => {
  it("round-trips a Uint8Array unchanged", () => {
    const src = new Uint8Array([0, 1, 2, 255, 128]);
    const out = unmarshal(marshal(src)) as Uint8Array;
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual(Array.from(src));
  });

  it("round-trips a Float32Array unchanged, including fractional values", () => {
    const src = new Float32Array([0, -1.5, 3.14159, 1e10]);
    const out = unmarshal(marshal(src)) as Float32Array;
    expect(out).toBeInstanceOf(Float32Array);
    expect(Array.from(out)).toEqual(Array.from(src));
  });

  it("round-trips a Uint32Array unchanged", () => {
    const src = new Uint32Array([0, 4294967295, 12345]);
    const out = unmarshal(marshal(src)) as Uint32Array;
    expect(out).toBeInstanceOf(Uint32Array);
    expect(Array.from(out)).toEqual(Array.from(src));
  });

  it("round-trips an Int32Array unchanged, including negative values", () => {
    const src = new Int32Array([-2147483648, 0, 2147483647]);
    const out = unmarshal(marshal(src)) as Int32Array;
    expect(out).toBeInstanceOf(Int32Array);
    expect(Array.from(out)).toEqual(Array.from(src));
  });

  it("round-trips a Buffer as a Buffer, not a plain Uint8Array", () => {
    const src = Buffer.from([10, 20, 30]);
    const out = unmarshal(marshal(src)) as Buffer;
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(Array.from(out)).toEqual([10, 20, 30]);
  });

  it("round-trips a typed array nested several levels deep in plain objects/arrays", () => {
    const src = {
      groups: [
        { id: "solid-0", faces: [{ buffers: { positions: new Float32Array([1, 2, 3]), indices: new Uint32Array([0, 1, 2]) } }] },
      ],
      edges: [{ edgeId: "edge-0", positions: new Float32Array([0, 0, 0, 1, 1, 1]), smooth: false }],
    };
    const out = unmarshal(marshal(src)) as typeof src;
    expect(out.groups[0].faces[0].buffers.positions).toBeInstanceOf(Float32Array);
    expect(Array.from(out.groups[0].faces[0].buffers.positions)).toEqual([1, 2, 3]);
    expect(out.groups[0].faces[0].buffers.indices).toBeInstanceOf(Uint32Array);
    expect(out.edges[0].smooth).toBe(false);
    expect(out.edges[0].edgeId).toBe("edge-0");
  });

  it("leaves plain JSON-shaped values (numbers, strings, booleans, null, nested arrays/objects) untouched", () => {
    const src = { a: 1, b: "x", c: true, d: null, e: [1, 2, { f: "g" }], h: undefined };
    expect(marshal(src)).toEqual(src);
    expect(unmarshal(src)).toEqual(src);
  });

  it("handles an empty typed array", () => {
    const src = new Float32Array([]);
    const out = unmarshal(marshal(src)) as Float32Array;
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(0);
  });

  it("marshal output is JSON.stringify-safe (no functions, no circular refs, no typed arrays left)", () => {
    const src = { bytes: new Uint8Array([1, 2, 3]), ops: [{ op: "translate", vec: [1, 2, 3] }] };
    const marshaled = marshal(src);
    expect(() => JSON.stringify(marshaled)).not.toThrow();
    const roundTripped = JSON.parse(JSON.stringify(marshaled));
    const out = unmarshal(roundTripped) as typeof src;
    expect(Array.from(out.bytes)).toEqual([1, 2, 3]);
    expect(out.ops).toEqual(src.ops);
  });

  it("does not mistake a plain object for an encoded buffer", () => {
    const notABuffer = { ctor: "Uint8Array", data: "not really" };
    expect(unmarshal(marshal(notABuffer))).toEqual(notABuffer);
  });

  it("preserves an explicit undefined ARRAY ELEMENT through a real JSON.stringify/parse round trip, distinct from null", () => {
    // A real bug caught by the Phase 0 spike: plain JSON.stringify([1, undefined, 3])
    // silently produces "[1,null,3]" — marshal must tag undefined so it comes
    // back as undefined, not null, which matters because a function's own
    // default parameter only applies to a genuinely-omitted/undefined
    // argument, never to an explicit null.
    const args = ["x", undefined, null, 5];
    const wire = JSON.parse(JSON.stringify(marshal(args)));
    const out = unmarshal(wire) as unknown[];
    expect(out).toEqual(["x", undefined, null, 5]);
    expect(out[1]).toBe(undefined);
    expect(out[2]).toBe(null);
  });

  it("an omitted (shortened) argument list still lets the callee's own default parameter apply — the common, expected case", () => {
    function withDefault(a: string, b = "default") {
      return `${a}/${b}`;
    }
    const args: unknown[] = ["a"]; // b omitted entirely, not passed as undefined
    const decoded = unmarshal(JSON.parse(JSON.stringify(marshal(args)))) as unknown[];
    expect(withDefault(...(decoded as [string]))).toBe("a/default");
  });
});
