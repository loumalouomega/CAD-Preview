/**
 * Wire format for `kernelWorker.ts`/`kernelClient.ts`'s IPC boundary (roadmap
 * "OCCT in a forked child process", Phase 0+1 — see CLAUDE.md). Pure,
 * vscode/WASM-free, unit-tested.
 *
 * The 21 `Pipeline` functions (`mcpTools.ts`) only ever take/return plain
 * JSON-shaped values (numbers, strings, booleans, arrays, nested plain
 * objects) PLUS typed-array buffers (`Uint8Array` file bytes in;
 * `Float32Array`/`Uint32Array` geometry buffers and `Uint8Array` export
 * bytes out, sometimes nested several levels deep — e.g. `BRepResult`'s
 * `groups[].faces[].buffers.positions`) — this is a deliberate, load-bearing
 * invariant of every kernel service's return shape (the same one that lets
 * these values round-trip through `<model>.*.json` sidecars and the webview
 * postMessage boundary), not an accident. No `Date`/`Map`/`Set`/class
 * instance/function ever appears in this surface, so a generic recursive
 * walk — replace any `ArrayBuffer` view with a tagged base64 wrapper, leave
 * everything else untouched — is complete and correct for the whole
 * `Pipeline` surface without per-function field enumeration (which would
 * need updating every time a function's return shape changes, e.g. the
 * nested `SolidGroup -> FaceMesh -> buffers.positions/indices` chain).
 */

export interface EncodedBuffer {
  __kernelBuf__: true;
  ctor: "Buffer" | "Uint8Array" | "Float32Array" | "Uint32Array" | "Int32Array";
  data: string; // base64
}

function isEncodedBuffer(value: unknown): value is EncodedBuffer {
  return !!value && typeof value === "object" && (value as EncodedBuffer).__kernelBuf__ === true;
}

/**
 * `undefined` array ELEMENTS (as opposed to object keys, which `JSON.stringify`
 * simply omits and which round-trip correctly for free — a missing key reads
 * back as `undefined` either way, no tagging needed) silently become `null`
 * under plain JSON serialization — a real bug caught by the Phase 0 spike
 * script: an OMITTED trailing optional argument reconstructs fine (the
 * function's own default parameter applies, since nothing was passed at that
 * position at all), but an EXPLICIT `undefined` passed for an optional arg
 * (e.g. `measureEntities`'s `axis?`, or any positional call that pads with
 * `undefined` rather than shortening the array) would silently arrive as
 * `null` in the child — not the same value a default parameter treats
 * specially. Tagging `undefined` only where it appears as an array element
 * (see `marshal`/`unmarshal`'s array branches below) closes that gap for
 * every call shape, not just the one the spike happened to hit.
 */
interface EncodedUndefined {
  __kernelUndefined__: true;
}

function isEncodedUndefined(value: unknown): value is EncodedUndefined {
  return !!value && typeof value === "object" && (value as EncodedUndefined).__kernelUndefined__ === true;
}

function ctorNameOf(view: ArrayBufferView): EncodedBuffer["ctor"] {
  if (Buffer.isBuffer(view)) return "Buffer";
  if (view instanceof Float32Array) return "Float32Array";
  if (view instanceof Uint32Array) return "Uint32Array";
  if (view instanceof Int32Array) return "Int32Array";
  return "Uint8Array";
}

/** Replaces every typed-array/Buffer in `value` with a tagged base64 wrapper (and every `undefined` ARRAY ELEMENT with a tagged sentinel — see {@link EncodedUndefined}) — the result is always plain-JSON-safe. */
export function marshal(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    const encoded: EncodedBuffer = {
      __kernelBuf__: true,
      ctor: ctorNameOf(view),
      data: Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64"),
    };
    return encoded;
  }
  if (Array.isArray(value)) {
    return value.map((v) => {
      if (v === undefined) {
        const encoded: EncodedUndefined = { __kernelUndefined__: true };
        return encoded;
      }
      return marshal(v);
    });
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = marshal(v);
    return out;
  }
  return value;
}

/** The inverse of {@link marshal} — reconstructs the original typed-array types and `undefined` array elements from their tagged wrappers. */
export function unmarshal(value: unknown): unknown {
  if (isEncodedBuffer(value)) {
    const buf = Buffer.from(value.data, "base64");
    switch (value.ctor) {
      case "Buffer":
        return buf;
      case "Float32Array":
        return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / Float32Array.BYTES_PER_ELEMENT);
      case "Uint32Array":
        return new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength / Uint32Array.BYTES_PER_ELEMENT);
      case "Int32Array":
        return new Int32Array(buf.buffer, buf.byteOffset, buf.byteLength / Int32Array.BYTES_PER_ELEMENT);
      default:
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
  }
  if (Array.isArray(value)) return value.map((v) => (isEncodedUndefined(v) ? undefined : unmarshal(v)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = unmarshal(v);
    return out;
  }
  return value;
}

/** Parent → child. `args` are already `marshal()`ed. `fn` is a `Pipeline` key (kept as a plain string, not `keyof Pipeline`, so this file stays free of any dependency on `mcpTools.ts`). */
export interface KernelRequest {
  id: number;
  fn: string;
  args: unknown[];
}

/** Child → parent. `result`/`error` carry already-`marshal()`ed payloads. */
export type KernelResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { message: string } };
