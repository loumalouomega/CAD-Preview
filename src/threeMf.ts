/**
 * 3MF (3D Manufacturing Format) writer and unit reader — pure (no DOM, no
 * THREE, no vscode), Node-safe, unit-tested. `meshExporters.ts` collects the
 * triangles from the displayed model and hands them here; `meshLoaders.ts`
 * asks {@link threeMfMmPerUnit} how big the file's declared unit is, because
 * three's `3MFLoader` reads the `unit` attribute but never applies it.
 *
 * One `<object type="model">` per solid. Colour is optional and per triangle
 * (`ThreeMfObject.colors`): written as a single `<basematerials>` resource, and
 * only when at least one triangle carries a colour, so an uncoloured export is
 * byte-identical to a geometry-only one. The writer takes already-scaled
 * coordinates plus the unit label, so the file keeps its real-world size under
 * a correct label (the STEP/IGES rule), never a mislabelled-mm file.
 */
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import type { DisplayUnit } from "./lengthUnits";

/** One 3MF object: a triangle mesh in the file's declared unit. */
export interface ThreeMfObject {
  name?: string;
  /** Flat xyz triples. */
  positions: ArrayLike<number>;
  /** Flat vertex-index triples, or `null` for a non-indexed triangle soup. */
  indices: ArrayLike<number> | null;
  /**
   * Optional `0xRRGGBB` per triangle (one entry per triangle, in triangle
   * order); a negative entry, or a missing array, means "no colour".
   */
  colors?: ArrayLike<number>;
}

const MODEL_PATH = "3D/3dmodel.model";

/** `DisplayUnit` → the 3MF `unit` attribute value. */
export const THREE_MF_UNIT_NAMES: Record<DisplayUnit, string> = {
  mm: "millimeter",
  cm: "centimeter",
  m: "meter",
  in: "inch",
  ft: "foot",
};

/** Millimetres per 3MF unit, for every unit the spec allows. */
const MM_PER_THREE_MF_UNIT: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

/** The spec's default when `unit` is absent. */
const DEFAULT_UNIT = "millimeter";

/** 2000-01-01 UTC: inside the zip DOS-date range. */
const FIXED_MTIME = Date.UTC(2000, 0, 1);
/** The DOS date/time fields that mean 2000-01-01 00:00 — year 1980+20, month 1, day 1, midnight. */
const DOS_DATE_2000_01_01 = 0x2821;
const DOS_TIME_MIDNIGHT = 0x0000;

/**
 * fflate encodes the `mtime` option through the Date's LOCAL-time getters, so
 * the same fixed timestamp writes different DOS time bytes on machines in
 * different timezones (0x0000 under UTC, 0x0800 one hour east, 0x1000 two —
 * and a negative-UTC zone even moves the DATE to 1999-12-31), which made the
 * writer's output — and the committed fixture's byte-equality — depend on the
 * machine the test ran on. The DOS fields themselves are timezone-free, so
 * after zipping every local-file-header and central-directory entry's
 * time+date is overwritten with the 2000-01-01 00:00 value the option
 * intends, and the output is byte-identical everywhere. Walks the archive
 * header-by-header (signature, then the entry's own name/extra/comment
 * lengths) rather than pattern-matching signatures, so a `PK\x01\x02` byte
 * sequence inside a compressed stream can never be mistaken for a header.
 */
function normalizeZipTimestamps(bytes: Uint8Array): Uint8Array {
  const u16 = (o: number) => bytes[o]! | (bytes[o + 1]! << 8);
  const u32 = (o: number) => u16(o) | (u16(o + 2) << 16);
  const writeTimeDate = (timeAt: number, dateAt: number) => {
    bytes[timeAt] = DOS_TIME_MIDNIGHT & 0xff;
    bytes[timeAt + 1] = DOS_TIME_MIDNIGHT >>> 8;
    bytes[dateAt] = DOS_DATE_2000_01_01 & 0xff;
    bytes[dateAt + 1] = DOS_DATE_2000_01_01 >>> 8;
  };
  let p = 0;
  while (p + 4 <= bytes.length && bytes[p] === 0x50 && bytes[p + 1] === 0x4b) {
    if (bytes[p + 2] === 0x03 && bytes[p + 3] === 0x04) {
      if (u16(p + 6) & 8) break; // data-descriptor sizes — never fflate's zipSync layout; leave untouched
      writeTimeDate(p + 10, p + 12);
      p += 30 + u16(p + 26) + u16(p + 28) + u32(p + 18);
    } else if (bytes[p + 2] === 0x01 && bytes[p + 3] === 0x02) {
      writeTimeDate(p + 12, p + 14);
      p += 46 + u16(p + 28) + u16(p + 30) + u16(p + 32);
    } else break; // end of central directory (PK\x05\x06) — no more per-entry timestamps
  }
  return bytes;
}

const MAX_MODEL_PART_BYTES = 200 * 1024 * 1024;

function num(v: number): string {
  // 9 significant digits comfortably exceeds float32; trims noise like 0.30000000000000004.
  return String(Number(v.toPrecision(9)));
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Builds a `.3mf` package. Vertices that coincide exactly are shared, so a
 * triangle-soup source (STL) still produces an indexed mesh; the triangle
 * count is never changed.
 */
export function build3mf(objects: readonly ThreeMfObject[], unit: DisplayUnit = "mm"): Uint8Array {
  // Distinct colours across all objects, in first-seen order: the one shared
  // `<basematerials>` resource. Present only when some triangle is coloured,
  // so a colourless model keeps today's ids and bytes.
  const palette: number[] = [];
  const paletteIndex = new Map<number, number>();
  for (const obj of objects) {
    for (let t = 0; obj.colors && t < obj.colors.length; t++) {
      const c = obj.colors[t];
      if (c >= 0 && !paletteIndex.has(c)) {
        paletteIndex.set(c, palette.length);
        palette.push(c);
      }
    }
  }
  const materialsId = palette.length > 0 ? 1 : 0;

  const parts: string[] = [];
  const buildItems: string[] = [];
  let id = materialsId;
  for (const obj of objects) {
    const pos = obj.positions;
    const idx = obj.indices;
    const triCount = idx ? Math.floor(idx.length / 3) : Math.floor(pos.length / 9);
    if (triCount === 0) continue;
    id++;
    const verts: string[] = [];
    const tris: string[] = [];
    // Colour of triangle `t` as a palette index, or -1 for none.
    const paletteOf = (t: number): number => {
      const c = obj.colors && t < obj.colors.length ? obj.colors[t] : -1;
      return c >= 0 ? paletteIndex.get(c)! : -1;
    };
    // A uniform, fully coloured object carries its colour once on the object
    // (pid/pindex); anything else is written per triangle (pid/p1).
    let uniform = paletteOf(0);
    for (let t = 1; t < triCount && uniform >= 0; t++) if (paletteOf(t) !== uniform) uniform = -1;
    const objectColour = uniform >= 0 ? ` pid="${materialsId}" pindex="${uniform}"` : "";
    const weld = new Map<string, number>();
    const vertexOf = (src: number): number => {
      const x = pos[src * 3], y = pos[src * 3 + 1], z = pos[src * 3 + 2];
      const key = `${x},${y},${z}`;
      let v = weld.get(key);
      if (v === undefined) {
        v = verts.length;
        weld.set(key, v);
        verts.push(`<vertex x="${num(x)}" y="${num(y)}" z="${num(z)}"/>`);
      }
      return v;
    };
    for (let t = 0; t < triCount; t++) {
      const a = idx ? idx[t * 3] : t * 3;
      const b = idx ? idx[t * 3 + 1] : t * 3 + 1;
      const c = idx ? idx[t * 3 + 2] : t * 3 + 2;
      const pc = uniform >= 0 ? -1 : paletteOf(t);
      const colourAttrs = pc >= 0 ? ` pid="${materialsId}" p1="${pc}"` : "";
      tris.push(`<triangle v1="${vertexOf(a)}" v2="${vertexOf(b)}" v3="${vertexOf(c)}"${colourAttrs}/>`);
    }
    const name = obj.name ? ` name="${esc(obj.name)}"` : "";
    parts.push(
      `<object id="${id}" type="model"${objectColour}${name}><mesh><vertices>${verts.join("")}</vertices><triangles>${tris.join("")}</triangles></mesh></object>`
    );
    buildItems.push(`<item objectid="${id}"/>`);
  }
  if (id === materialsId) throw new Error("3MF export: the model has no triangles to write.");

  const hex = (c: number): string => `#${c.toString(16).padStart(6, "0").toUpperCase()}`;
  const materials =
    palette.length > 0
      ? `<basematerials id="${materialsId}">${palette.map((c) => `<base name="${hex(c)}" displaycolor="${hex(c)}"/>`).join("")}</basematerials>`
      : "";

  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="${THREE_MF_UNIT_NAMES[unit]}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<resources>${materials}${parts.join("")}</resources><build>${buildItems.join("")}</build></model>\n`;
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/${MODEL_PATH}" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  // A fixed timestamp keeps the output (and the committed fixtures) byte-stable,
  // on any machine: fflate's own local-time encoding is normalized afterwards.
  return normalizeZipTimestamps(
    zipSync(
      {
        "[Content_Types].xml": strToU8(contentTypes),
        "_rels/.rels": strToU8(rels),
        [MODEL_PATH]: strToU8(model),
      },
      { mtime: FIXED_MTIME }
    )
  );
}

/** The `unit` a `.3mf` declares on its root model part, lower-cased; the spec default when absent, `undefined` for an unreadable package. */
function declaredUnitName(bytes: Uint8Array): string | undefined {
  try {
    const files = unzipSync(bytes, {
      filter: (f) => /\.model$/i.test(f.name) && f.originalSize <= MAX_MODEL_PART_BYTES,
    });
    const names = Object.keys(files);
    const name = names.find((n) => n.toLowerCase() === MODEL_PATH.toLowerCase()) ?? names[0];
    if (!name) return undefined;
    const m = /<model\b[^>]*?\bunit\s*=\s*"([^"]*)"/i.exec(strFromU8(files[name]));
    return (m ? m[1] : DEFAULT_UNIT).toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Millimetres per unit of the `unit` a `.3mf` declares on its root model part.
 * `1` for a missing/unrecognized unit (the spec default is millimetres) or an
 * unreadable package — the loader then shows the geometry exactly as three
 * decoded it, never throws over a unit.
 */
export function threeMfMmPerUnit(bytes: Uint8Array): number {
  const unit = declaredUnitName(bytes);
  return (unit && MM_PER_THREE_MF_UNIT[unit]) || 1;
}

/**
 * The Units-dropdown entry matching the file's declared unit, or `undefined`
 * (micron, an unknown unit, an unreadable package) — the caller then leaves
 * the selector on millimetres. Presentation only: the loader has already
 * scaled the geometry by {@link threeMfMmPerUnit}.
 */
export function threeMfDeclaredUnit(bytes: Uint8Array): DisplayUnit | undefined {
  const unit = declaredUnitName(bytes);
  return (Object.keys(THREE_MF_UNIT_NAMES) as DisplayUnit[]).find((k) => THREE_MF_UNIT_NAMES[k] === unit);
}
