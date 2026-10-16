/**
 * AMF (`.amf`) unit reader — pure (no DOM, no THREE, no vscode), Node-safe,
 * unit-tested. Unlike 3MF and Collada, three's `AMFLoader` already scales the
 * geometry to millimetres from the root `<amf unit="…">` attribute
 * (millimeter / inch / feet / meter / micron; an unknown value silently
 * scales by 1), so nothing here rescales: this only mirrors that reading to
 * seed the (presentation-only) Units dropdown through `userData.declaredUnit`.
 * A zipped AMF (`PK` magic) holds the document as its first `*.amf` entry.
 */
import { strFromU8, unzipSync } from "fflate";
import type { DisplayUnit } from "./lengthUnits";

/** AMF unit name → dropdown entry (a micron has none). */
const UNITS: Readonly<Record<string, DisplayUnit | undefined>> = {
  millimeter: "mm",
  inch: "in",
  feet: "ft",
  meter: "m",
};

/** The document text of an AMF file (inflating a zipped one), or undefined if unreadable. */
function amfText(bytes: Uint8Array): string | undefined {
  try {
    if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
      const zip = unzipSync(bytes);
      const name = Object.keys(zip).find((n) => n.toLowerCase().endsWith(".amf"));
      return name ? strFromU8(zip[name]) : undefined;
    }
    return strFromU8(bytes);
  } catch {
    return undefined;
  }
}

/** The lower-cased `unit` attribute of the root `<amf>` element, if present. */
function declaredUnitName(bytes: Uint8Array): string | undefined {
  const text = amfText(bytes);
  if (!text) return undefined;
  const root = /<amf\b[^>]*>/i.exec(text);
  const m = root ? /\bunit\s*=\s*["']([^"']*)["']/i.exec(root[0]) : null;
  return m ? m[1].trim().toLowerCase() : undefined;
}

/**
 * The Units-dropdown entry matching the declared unit, or `undefined` for no
 * `unit` attribute (the AMF default is millimetres, which would be a surprising
 * thing to *select* for a file that never said so), a micron, or an unknown name.
 */
export function amfDeclaredUnit(bytes: Uint8Array): DisplayUnit | undefined {
  const name = declaredUnitName(bytes);
  return name === undefined ? undefined : UNITS[name];
}
