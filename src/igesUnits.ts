/**
 * Detects an IGES file's declared length unit by scanning its plain-text
 * Global section — vscode/OCCT-free, mirroring `stepUnits.ts`'s convention
 * and existing for the exact same reason: OCCT's IGES reader already
 * auto-converts every shape it transfers to the cascade unit (millimetres),
 * so there is nothing to *convert* — this only recovers the informational
 * "what unit was this authored in" label, which the STEP scanner already
 * provides but IGES did not (deliberately skipped when that feature shipped
 * — IGES's unit lives in a fixed-position Global-section parameter, not a
 * named entity, a different enough format to warrant its own scanner).
 *
 * IGES (up to and including 5.3) is fixed-width 80-column ASCII "card image"
 * text: columns 1-72 are content, columns 73-80 are a section letter (`S`
 * start, `G` global, `D` directory, `P` parameter, `T` terminate) plus a
 * sequence number. The Global section's actual parameter data is one logical
 * record split across as many `G`-lines as needed — reassembled here by
 * concatenating every line's first 72 columns, in file order, before parsing.
 */

/** Reassembles the Global section's logical parameter-data record from every
 * line whose column 73 (0-indexed 72) is `G`, concatenating each line's
 * first 72 columns in file order. Returns `undefined` if no `G` line exists.
 *
 * Trailing whitespace is stripped from EACH line's 72-column chunk before
 * concatenating — confirmed necessary against a real OCCT-written file: a
 * writer that finishes a field before column 72 pads the rest of the line
 * with spaces rather than packing the next field's start onto the same line,
 * and naively concatenating raw 72-column chunks spliced that padding into
 * the *middle* of the very next token (observed: `13HFilename.iges,` was
 * followed by 18 spaces of column padding, then `16HOpen CASCADE 7.4` began
 * on the next line — concatenated raw, the Hollerith-length regex no longer
 * matches at the token boundary). This trades away the (rare, unobserved)
 * case of a Hollerith string whose real content ends in a space exactly at a
 * 72-column boundary — an accepted best-effort limitation, same "recover an
 * informational label, not a compliance parser" scope `stepUnits.ts` has. */
function globalSectionText(text: string): string | undefined {
  const lines = text.split(/\r\n|\r|\n/);
  const globalLines = lines.filter((l) => l.length > 72 && l[72] === "G");
  if (globalLines.length === 0) return undefined;
  return globalLines.map((l) => l.slice(0, 72).replace(/\s+$/, "")).join("");
}

/**
 * Splits one IGES free-format parameter-data record into its raw parameter
 * tokens (Hollerith strings, `nHtext`, kept intact — their content may itself
 * contain the delimiter characters, which must NOT be treated as separators).
 * Always assumes the default `,`/`;` delimiters (IGES parameters 1/2 let a
 * file declare custom ones, but every real-world file this was verified
 * against — including this extension's own OCCT-written output — leaves them
 * blank/default; not attempting full spec generality here, same "recover an
 * informational label, not a compliance parser" scope `stepUnits.ts` has).
 */
function splitIgesParameters(record: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let i = 0;
  while (i < record.length) {
    const hollerith = /^(\d+)H/.exec(record.slice(i, i + 12));
    if (hollerith) {
      const len = Number(hollerith[1]);
      const headerLen = hollerith[0].length;
      const strStart = i + headerLen;
      cur += record.slice(i, strStart + len);
      i = strStart + len;
      continue;
    }
    const ch = record[i];
    if (ch === ",") {
      tokens.push(cur);
      cur = "";
    } else if (ch === ";") {
      tokens.push(cur);
      return tokens;
    } else {
      cur += ch;
    }
    i++;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/** IGES Global-section parameter 14 (the unit flag) mapped to the same
 * canonical STEP-style entity names `displayUnitFromUnitName` already
 * understands, so both formats' detectors feed the one shared mapper. Flags
 * 3 (custom, named in parameter 15), 5 (mile), 7 (kilometre), 8 (mil), 9
 * (micron), and 11 (microinch) aren't among the five units this UI offers —
 * left unmapped, same graceful "falls back to mm" degradation an
 * unrecognized STEP unit already gets. */
const IGES_UNIT_FLAG_NAMES: Record<number, string> = {
  1: "INCH",
  2: "MILLIMETRE",
  4: "FOOT",
  6: "METRE",
  10: "CENTIMETRE",
};

/** Human-readable label for a `detectIgesLengthUnit` result, or the raw name
 * if unrecognized — mirrors `stepUnits.ts`'s `stepUnitLabel`. */
export function igesUnitLabel(unit: string): string {
  switch (unit) {
    case "MILLIMETRE": return "mm";
    case "CENTIMETRE": return "cm";
    case "METRE": return "m";
    case "INCH": return "in";
    case "FOOT": return "ft";
    default: return unit;
  }
}

/**
 * Returns the canonical unit name (`"MILLIMETRE"`, `"INCH"`, etc. — the same
 * vocabulary `stepUnits.ts`'s `detectStepLengthUnit` returns, so both feed
 * `displayUnitFromUnitName`) declared by an IGES file's Global-section
 * parameter 14 (the 1-indexed unit flag), or `undefined` if the Global
 * section can't be found/parsed, the flag has no entry in
 * `IGES_UNIT_FLAG_NAMES`, or it isn't a valid integer.
 */
export function detectIgesLengthUnit(text: string): string | undefined {
  const record = globalSectionText(text);
  if (!record) return undefined;
  const params = splitIgesParameters(record);
  const flagToken = params[13]; // 1-indexed parameter 14
  if (flagToken === undefined) return undefined;
  const flag = Number(flagToken.trim());
  if (!Number.isInteger(flag)) return undefined;
  return IGES_UNIT_FLAG_NAMES[flag];
}
