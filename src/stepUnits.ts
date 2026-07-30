/**
 * Detects a STEP file's declared length unit by scanning its plain-text
 * `DATA` section — vscode/OCCT-free (mirrors `src/massProperties.ts`'s
 * host-module convention). No embind call is involved: OCCT's STEP reader
 * already auto-converts every shape it transfers to one internal "cascade"
 * unit (millimetres, verified against the live WASM by comparing `bull.stp`'s
 * — declared `INCH` per this scanner — post-`TransferRoots()` bounding box,
 * 161.29mm, against its expected ~6.35in extent: 161.29 / 25.4 = 6.35, a
 * plausible size for the toy-bull model it renders as). So there is nothing
 * to *convert*; this only recovers the informational "what unit was this
 * authored in" label OCCT itself doesn't expose (`Standard_Type.Name()` on
 * the downcast model hits this build's usual unbound-`PKc`-return-type gap).
 * STEP (ISO-10303-21) is ASCII text, so scanning it directly is legitimate,
 * not a hack — and far simpler than the embind route.
 */

const SI_UNIT_LABELS: Record<string, string> = {
  METRE: "m",
  DECIMETRE: "dm",
  CENTIMETRE: "cm",
  MILLIMETRE: "mm",
  MICROMETRE: "µm",
  KILOMETRE: "km",
};

const NAMED_UNIT_LABELS: Record<string, string> = {
  INCH: "in",
  FOOT: "ft",
  YARD: "yd",
  MILE: "mi",
};

/** Human-readable label for a `detectStepLengthUnit` result, or the raw STEP name if unrecognized. */
export function stepUnitLabel(unit: string): string {
  return SI_UNIT_LABELS[unit] ?? NAMED_UNIT_LABELS[unit] ?? unit;
}

function parseUnitBody(body: string): string | undefined {
  if (!/LENGTH_UNIT\s*\(\s*\)/i.test(body)) return undefined;
  const conv = /CONVERSION_BASED_UNIT\s*\(\s*'([^']+)'/i.exec(body);
  if (conv) return conv[1].toUpperCase();
  const si = /SI_UNIT\s*\(\s*\.?([A-Z]*)\.?\s*,\s*\.([A-Z]+)\.\s*\)/i.exec(body);
  if (si) {
    const prefix = si[1] ?? "";
    const base = si[2].toUpperCase();
    return prefix ? `${prefix}${base}` : base;
  }
  return undefined;
}

/**
 * Returns the STEP entity name for the model's declared length unit (e.g.
 * `"MILLIMETRE"`, `"INCH"`), or `undefined` if the file has no
 * `GLOBAL_UNIT_ASSIGNED_CONTEXT` (or an unparseable one) — some minimal/older
 * STEP files omit unit declarations entirely, and this never throws for that.
 *
 * Prefers the unit(s) actually referenced by `GLOBAL_UNIT_ASSIGNED_CONTEXT`
 * (the context governing the shape's coordinate values) over the first bare
 * `LENGTH_UNIT()` entity in the file — a `CONVERSION_BASED_UNIT` like `INCH`
 * is itself defined *in terms of* an intermediate SI unit (e.g. `CENTIMETRE`)
 * elsewhere in the file, and naively taking "the first `LENGTH_UNIT()` entity"
 * would report that intermediate conversion basis instead of the unit the
 * model was actually authored in — confirmed wrong on `bull.stp` before this
 * fix (reported `CENTIMETRE`; the file's assigned context is `INCH`).
 */
export function detectStepLengthUnit(text: string): string | undefined {
  const ctxMatch = /GLOBAL_UNIT_ASSIGNED_CONTEXT\s*\(\s*\(([^)]*)\)\s*\)/is.exec(text);
  if (ctxMatch) {
    const candidateIds = [...ctxMatch[1].matchAll(/#(\d+)/g)].map((m) => m[1]);
    for (const id of candidateIds) {
      const entityRe = new RegExp(`#${id}\\s*=\\s*\\(([^;]*?)\\)\\s*;`, "is");
      const entityMatch = entityRe.exec(text);
      if (!entityMatch) continue;
      const unit = parseUnitBody(entityMatch[1]);
      if (unit) return unit;
    }
  }

  // Fallback (no context found, or none of its ids resolved to a length
  // unit): scan every LENGTH_UNIT() entity, preferring a CONVERSION_BASED_UNIT
  // (almost always the "real" assigned unit) over a bare SI_UNIT (often just
  // a conversion basis for some other unit elsewhere in the file).
  const allRe = /#\d+\s*=\s*\(([^;]*?LENGTH_UNIT\s*\(\s*\)[^;]*?)\)\s*;/gis;
  let m: RegExpExecArray | null;
  let siFallback: string | undefined;
  while ((m = allRe.exec(text))) {
    const unit = parseUnitBody(m[1]);
    if (!unit) continue;
    if (/CONVERSION_BASED_UNIT/i.test(m[1])) return unit;
    if (!siFallback) siFallback = unit;
  }
  return siFallback;
}
