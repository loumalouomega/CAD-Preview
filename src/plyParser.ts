/**
 * Pure host-side PLY (Stanford Polygon File Format) parser — vscode/OCCT/
 * THREE-free, the third member of the `stlParser.ts`/`objParser.ts` "no
 * framework, just bytes in, plain data out" family. Handles all three PLY
 * body encodings (`ascii`, `binary_little_endian`, `binary_big_endian`) over
 * one shared header parser, since the header itself is always plain ASCII
 * text regardless of the body's own encoding.
 *
 * Scope: only the `vertex` element's `x`/`y`/`z` scalar properties and the
 * `face` element's `vertex_indices`/`vertex_index` list property are read —
 * every other declared property (normals, colours, texture coordinates,
 * confidence, …) is still correctly parsed (so the byte/token cursor stays
 * in sync) but discarded, since Compare Models only needs geometry.
 */

export interface WeldedMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

type PlyFormat = "ascii" | "binary_little_endian" | "binary_big_endian";

interface PlyProperty {
  name: string;
  isList: boolean;
  /** Scalar type, or the list's VALUE type when `isList`. */
  type: string;
  /** The list's COUNT type — only set when `isList`. */
  countType?: string;
}

interface PlyElement {
  name: string;
  count: number;
  properties: PlyProperty[];
}

/** Byte width per PLY scalar type name, covering both the modern
 * (`int8`/`uint16`/`float32`/…) and legacy (`char`/`short`/`float`/…)
 * spellings the format allows interchangeably. */
const TYPE_SIZES: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
  float: 4, float32: 4,
  double: 8, float64: 8,
};

function readScalar(view: DataView, offset: number, type: string, little: boolean): number {
  switch (type) {
    case "char":
    case "int8":
      return view.getInt8(offset);
    case "uchar":
    case "uint8":
      return view.getUint8(offset);
    case "short":
    case "int16":
      return view.getInt16(offset, little);
    case "ushort":
    case "uint16":
      return view.getUint16(offset, little);
    case "int":
    case "int32":
      return view.getInt32(offset, little);
    case "uint":
    case "uint32":
      return view.getUint32(offset, little);
    case "float":
    case "float32":
      return view.getFloat32(offset, little);
    case "double":
    case "float64":
      return view.getFloat64(offset, little);
    default:
      throw new Error(`Unknown PLY scalar type: ${type}`);
  }
}

/** Parses the ASCII header (from byte 0 up to and including the
 * `end_header` line's newline) and returns it alongside the exact BYTE
 * offset the body starts at. Decoding the whole buffer as `latin1` first is
 * what makes that offset trustworthy even for a binary body: latin1 maps
 * exactly 1 byte to 1 char with no multi-byte sequences, so a char index
 * into the decoded string is always identical to the byte index into the
 * original buffer — and the header itself is guaranteed pure ASCII by the
 * PLY spec regardless of the body's own encoding. */
function parseHeader(bytes: Uint8Array): { format: PlyFormat; elements: PlyElement[]; bodyStart: number } {
  const text = Buffer.from(bytes).toString("latin1");
  const marker = text.indexOf("end_header");
  if (marker === -1) throw new Error("Not a PLY file: missing end_header");
  const bodyStart = text.indexOf("\n", marker) + 1;
  const headerLines = text
    .slice(0, bodyStart)
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let format: PlyFormat = "ascii";
  const elements: PlyElement[] = [];
  let current: PlyElement | null = null;
  for (const line of headerLines) {
    const tokens = line.split(/\s+/);
    if (tokens[0] === "format") {
      format = tokens[1] as PlyFormat;
    } else if (tokens[0] === "element") {
      current = { name: tokens[1], count: parseInt(tokens[2], 10), properties: [] };
      elements.push(current);
    } else if (tokens[0] === "property" && current) {
      if (tokens[1] === "list") {
        current.properties.push({ name: tokens[4], isList: true, type: tokens[3], countType: tokens[2] });
      } else {
        current.properties.push({ name: tokens[2], isList: false, type: tokens[1] });
      }
    }
    // "ply", "comment", "obj_info", and anything else are ignored.
  }
  return { format, elements, bodyStart };
}

/**
 * Parses raw PLY bytes (ASCII or either binary endianness, auto-detected
 * from the header's `format` line) into a flat, shared-vertex indexed mesh —
 * like `objParser.ts`, PLY's `vertex_indices` are already shared references,
 * so no separate welding pass is needed. A face with more than 3 indices is
 * fan-triangulated, same convention `objParser.ts` uses. Never throws on a
 * malformed body: a face resolving out of range, or a vertex/face count that
 * runs past the actual data, degrades to whatever was successfully parsed
 * before the mismatch (the loops below simply stop consuming what isn't
 * there) rather than corrupting later reads — an actually-missing/garbled
 * header (no `end_header`, an unrecognized scalar type) still throws, same
 * as `plyParser.ts`'s sibling `stlParser.ts`/`objParser.ts` do for content
 * that isn't parseable as their format at all.
 */
export function parsePly(bytes: Uint8Array): WeldedMesh {
  const { format, elements, bodyStart } = parseHeader(bytes);
  const vertexEl = elements.find((e) => e.name === "vertex");
  const faceEl = elements.find((e) => e.name === "face");

  const positions: number[] = [];
  const indices: number[] = [];

  const emitVertex = (record: Record<string, number | number[]>) => {
    positions.push(Number(record.x) || 0, Number(record.y) || 0, Number(record.z) || 0);
  };
  const emitFace = (record: Record<string, number | number[]>, vertexCount: number) => {
    const raw = record.vertex_indices ?? record.vertex_index;
    if (!Array.isArray(raw) || raw.length < 3) return;
    if (raw.some((i) => i < 0 || i >= vertexCount)) return;
    for (let k = 1; k < raw.length - 1; k++) indices.push(raw[0], raw[k], raw[k + 1]);
  };

  if (format === "ascii") {
    const tokens = Buffer.from(bytes)
      .toString("utf8")
      .slice(bodyStart)
      .split(/\s+/)
      .filter((t) => t.length > 0);
    let cursor = 0;
    for (const el of elements) {
      for (let i = 0; i < el.count && cursor < tokens.length; i++) {
        const record: Record<string, number | number[]> = {};
        for (const prop of el.properties) {
          if (prop.isList) {
            const n = parseInt(tokens[cursor++], 10);
            const vals: number[] = [];
            for (let k = 0; k < n; k++) vals.push(Number(tokens[cursor++]));
            record[prop.name] = vals;
          } else {
            record[prop.name] = Number(tokens[cursor++]);
          }
        }
        if (el === vertexEl) emitVertex(record);
        else if (el === faceEl) emitFace(record, positions.length / 3);
      }
    }
  } else {
    const little = format === "binary_little_endian";
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = bodyStart;
    for (const el of elements) {
      for (let i = 0; i < el.count; i++) {
        const record: Record<string, number | number[]> = {};
        for (const prop of el.properties) {
          if (prop.isList) {
            if (offset + TYPE_SIZES[prop.countType!] > bytes.length) return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
            const n = readScalar(view, offset, prop.countType!, little);
            offset += TYPE_SIZES[prop.countType!];
            const vals: number[] = [];
            for (let k = 0; k < n; k++) {
              if (offset + TYPE_SIZES[prop.type] > bytes.length) return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
              vals.push(readScalar(view, offset, prop.type, little));
              offset += TYPE_SIZES[prop.type];
            }
            record[prop.name] = vals;
          } else {
            if (offset + TYPE_SIZES[prop.type] > bytes.length) return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
            record[prop.name] = readScalar(view, offset, prop.type, little);
            offset += TYPE_SIZES[prop.type];
          }
        }
        if (el === vertexEl) emitVertex(record);
        else if (el === faceEl) emitFace(record, positions.length / 3);
      }
    }
  }

  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
