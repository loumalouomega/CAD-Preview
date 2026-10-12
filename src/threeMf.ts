/**
 * 3MF (3D Manufacturing Format) writer and unit reader — pure (no DOM, no
 * THREE, no vscode), Node-safe, unit-tested. `meshExporters.ts` collects the
 * triangles from the displayed model and hands them here; `meshLoaders.ts`
 * asks {@link threeMfMmPerUnit} how big the file's declared unit is, because
 * three's `3MFLoader` reads the `unit` attribute but never applies it.
 *
 * Geometry only: no colours/materials, one `<object type="model">` per solid.
 * The writer takes already-scaled coordinates plus the unit label, so the file
 * keeps its real-world size under a correct label (the STEP/IGES rule), never
 * a mislabelled-mm file.
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
  const parts: string[] = [];
  const buildItems: string[] = [];
  let id = 0;
  for (const obj of objects) {
    const pos = obj.positions;
    const idx = obj.indices;
    const triCount = idx ? Math.floor(idx.length / 3) : Math.floor(pos.length / 9);
    if (triCount === 0) continue;
    id++;
    const verts: string[] = [];
    const tris: string[] = [];
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
      tris.push(`<triangle v1="${vertexOf(a)}" v2="${vertexOf(b)}" v3="${vertexOf(c)}"/>`);
    }
    const name = obj.name ? ` name="${esc(obj.name)}"` : "";
    parts.push(
      `<object id="${id}" type="model"${name}><mesh><vertices>${verts.join("")}</vertices><triangles>${tris.join("")}</triangles></mesh></object>`
    );
    buildItems.push(`<item objectid="${id}"/>`);
  }
  if (id === 0) throw new Error("3MF export: the model has no triangles to write.");

  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="${THREE_MF_UNIT_NAMES[unit]}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<resources>${parts.join("")}</resources><build>${buildItems.join("")}</build></model>\n`;
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/${MODEL_PATH}" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  // A fixed timestamp keeps the output (and the committed fixtures) byte-stable.
  return zipSync(
    {
      "[Content_Types].xml": strToU8(contentTypes),
      "_rels/.rels": strToU8(rels),
      [MODEL_PATH]: strToU8(model),
    },
    { mtime: FIXED_MTIME }
  );
}

/**
 * Millimetres per unit of the `unit` a `.3mf` declares on its root model part.
 * `1` for a missing/unrecognized unit (the spec default is millimetres) or an
 * unreadable package — the loader then shows the geometry exactly as three
 * decoded it, never throws over a unit.
 */
export function threeMfMmPerUnit(bytes: Uint8Array): number {
  try {
    const files = unzipSync(bytes, {
      filter: (f) => /\.model$/i.test(f.name) && f.originalSize <= MAX_MODEL_PART_BYTES,
    });
    const names = Object.keys(files);
    const name = names.find((n) => n.toLowerCase() === MODEL_PATH.toLowerCase()) ?? names[0];
    if (!name) return 1;
    const m = /<model\b[^>]*?\bunit\s*=\s*"([^"]*)"/i.exec(strFromU8(files[name]));
    const unit = (m ? m[1] : DEFAULT_UNIT).toLowerCase();
    return MM_PER_THREE_MF_UNIT[unit] ?? 1;
  } catch {
    return 1;
  }
}
