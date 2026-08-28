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
  ctor: "Buffer" | "Uint8Array" | "Float32Array" | "Uint32Array" | "Int32Array" | "Float64Array" | "Int8Array" | "Uint16Array" | "Int16Array";
  data: string; // base64
}

function isEncodedBuffer(value: unknown): value is EncodedBuffer {
  return !!value && typeof value === "object" && (value as EncodedBuffer).__kernelBuf__ === true;
}

/**
 * A non-finite NUMBER (`NaN`/`Infinity`/`-Infinity`) — as opposed to a
 * missing VALUE (`EncodedUndefined` above) — silently becomes `null` under
 * plain JSON serialization, the identical class of gap `EncodedUndefined`
 * was added for. This matters starting with the meshio++ integration
 * (`meshioService.ts`'s `dataInfo`-derived stats: a field's `min`/`max`
 * legitimately comes back `NaN` when every value is itself `NaN`, and
 * `dataIntegrate`'s `meanPerComponent` is documented `NaN` when its
 * denominator is zero) — every OTHER kernel function's numeric outputs
 * happen to always be finite, which is exactly why this gap went unnoticed
 * until now, not because it was previously impossible to hit.
 */
interface EncodedNumber {
  __kernelNumber__: "NaN" | "Infinity" | "-Infinity";
}

function isEncodedNumber(value: unknown): value is EncodedNumber {
  return !!value && typeof value === "object" && typeof (value as EncodedNumber).__kernelNumber__ === "string";
}

function encodeNonFiniteNumber(value: number): EncodedNumber | undefined {
  if (Number.isNaN(value)) return { __kernelNumber__: "NaN" };
  if (value === Infinity) return { __kernelNumber__: "Infinity" };
  if (value === -Infinity) return { __kernelNumber__: "-Infinity" };
  return undefined;
}

function decodeEncodedNumber(value: EncodedNumber): number {
  switch (value.__kernelNumber__) {
    case "NaN":
      return NaN;
    case "Infinity":
      return Infinity;
    case "-Infinity":
      return -Infinity;
  }
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

/**
 * `default:` deliberately THROWS rather than falling back to `"Uint8Array"`
 * — a real, previously-silent hazard closed alongside the meshio++ work: any
 * `ArrayBufferView` this codebase hadn't already special-cased (the obvious
 * one being `Float64Array`, meshio++'s own native array type for
 * `Mesh.points`/`point_data`/`cell_data`) would marshal with the right BYTES
 * but the WRONG element width, unmarshaling as a `Uint8Array` roughly 2-8×
 * too long — silent numeric corruption, not a thrown error, and exactly the
 * kind of bug this file's own doc comment says the generic recursive walk
 * exists to avoid needing per-function vigilance against. A loud throw here
 * is far preferable: it fails the very first call that returns an unmapped
 * view type, at the boundary, with a clear message — not three call sites
 * downstream where a length mismatch looks like a data-model bug.
 */
function ctorNameOf(view: ArrayBufferView): EncodedBuffer["ctor"] {
  if (Buffer.isBuffer(view)) return "Buffer";
  if (view instanceof Float32Array) return "Float32Array";
  if (view instanceof Float64Array) return "Float64Array";
  if (view instanceof Uint32Array) return "Uint32Array";
  if (view instanceof Int32Array) return "Int32Array";
  if (view instanceof Uint8Array) return "Uint8Array";
  if (view instanceof Int8Array) return "Int8Array";
  if (view instanceof Uint16Array) return "Uint16Array";
  if (view instanceof Int16Array) return "Int16Array";
  throw new Error(`kernelIpc.marshal: unrecognized ArrayBufferView constructor "${view.constructor?.name ?? "?"}" — add it to ctorNameOf before returning it across the kernel-worker IPC boundary.`);
}

/** Replaces every typed-array/Buffer in `value` with a tagged base64 wrapper, every `undefined` ARRAY ELEMENT with a tagged sentinel (see {@link EncodedUndefined}), and every non-finite NUMBER with a tagged sentinel (see {@link EncodedNumber}) — the result is always plain-JSON-safe. */
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
  if (typeof value === "number") {
    return encodeNonFiniteNumber(value) ?? value;
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

/** The inverse of {@link marshal} — reconstructs the original typed-array types, `undefined` array elements, and non-finite numbers from their tagged wrappers. */
export function unmarshal(value: unknown): unknown {
  if (isEncodedBuffer(value)) {
    const buf = Buffer.from(value.data, "base64");
    switch (value.ctor) {
      case "Buffer":
        return buf;
      case "Float32Array":
        return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / Float32Array.BYTES_PER_ELEMENT);
      case "Float64Array":
        return new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / Float64Array.BYTES_PER_ELEMENT);
      case "Uint32Array":
        return new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength / Uint32Array.BYTES_PER_ELEMENT);
      case "Int32Array":
        return new Int32Array(buf.buffer, buf.byteOffset, buf.byteLength / Int32Array.BYTES_PER_ELEMENT);
      case "Int8Array":
        return new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      case "Uint16Array":
        return new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength / Uint16Array.BYTES_PER_ELEMENT);
      case "Int16Array":
        return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / Int16Array.BYTES_PER_ELEMENT);
      default:
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
  }
  if (isEncodedNumber(value)) return decodeEncodedNumber(value);
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
