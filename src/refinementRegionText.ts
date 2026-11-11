import { validateRefinementRegions, type RefinementRegion } from "./meshOptions";

/**
 * Line-based text form of {@link RefinementRegion}s for the FE Mesh panel's
 * "Refinement regions" field (pure, DOM-free, so it is unit-tested):
 *
 *   sphere   cx cy cz  radius  size  [thickness]   [# name]
 *   box      x0 y0 z0  x1 y1 z1  size  [thickness]  [# name]
 *   cylinder cx cy cz  ax ay az  radius  size       [# name]
 *
 * Lengths are mm. `axis` is the HALF-length vector from the centre. A comma is
 * a separator or a decimal comma only when the whole token is one number, the
 * same rule as `localeNumber.ts` — here simply: tokens split on whitespace and
 * commas, so "1,5" is two numbers; use a point for decimals.
 */

const NUMBERS_BY_KIND = { sphere: [5, 6], box: [8, 7], cylinder: [8, 8] } as const;

export interface ParsedRegionText {
  regions: RefinementRegion[];
  /** One message per rejected non-blank line (1-based line number). */
  problems: string[];
}

export function parseRefinementRegionText(text: string): ParsedRegionText {
  const regions: RefinementRegion[] = [];
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const hash = rawLine.indexOf("#");
    const name = hash >= 0 ? rawLine.slice(hash + 1).trim() : "";
    const body = (hash >= 0 ? rawLine.slice(0, hash) : rawLine).trim();
    if (body === "") return;
    const tokens = body.split(/[\s,]+/).filter((t) => t !== "");
    const kind = tokens[0].toLowerCase();
    if (kind !== "sphere" && kind !== "box" && kind !== "cylinder") {
      problems.push(`Line ${i + 1}: unknown region "${tokens[0]}" (use sphere, box or cylinder).`);
      return;
    }
    const nums = tokens.slice(1).map(Number);
    const [min, max] = NUMBERS_BY_KIND[kind];
    if (nums.length < Math.min(min, max) || nums.length > Math.max(min, max) || nums.some((n) => !Number.isFinite(n))) {
      problems.push(`Line ${i + 1}: ${kind} takes ${kind === "sphere" ? "cx cy cz radius size [thickness]" : kind === "box" ? "x0 y0 z0 x1 y1 z1 size [thickness]" : "cx cy cz ax ay az radius size"}.`);
      return;
    }
    let raw: Record<string, unknown>;
    if (kind === "sphere") raw = { kind, center: nums.slice(0, 3), radius: nums[3], sizeIn: nums[4], thickness: nums[5] ?? 0 };
    else if (kind === "box") raw = { kind, min: nums.slice(0, 3), max: nums.slice(3, 6), sizeIn: nums[6], thickness: nums[7] ?? 0 };
    else raw = { kind, center: nums.slice(0, 3), axis: nums.slice(3, 6), radius: nums[6], sizeIn: nums[7] };
    if (name !== "") raw.name = name;
    const valid = validateRefinementRegions([raw]);
    if (!valid) problems.push(`Line ${i + 1}: ${kind} needs positive size${kind === "box" ? " and a non-empty extent" : kind === "cylinder" ? ", radius and a non-zero axis" : " and radius"}.`);
    else regions.push(valid[0]);
  });
  return { regions, problems };
}

/** The inverse of {@link parseRefinementRegionText}, one region per line. */
export function formatRefinementRegions(regions: readonly RefinementRegion[] | undefined): string {
  if (!regions) return "";
  return regions
    .map((r) => {
      const tail = r.name ? `  # ${r.name}` : "";
      if (r.kind === "sphere") return `sphere ${r.center.join(" ")}  ${r.radius}  ${r.sizeIn}${r.thickness ? ` ${r.thickness}` : ""}${tail}`;
      if (r.kind === "box") return `box ${r.min.join(" ")}  ${r.max.join(" ")}  ${r.sizeIn}${r.thickness ? ` ${r.thickness}` : ""}${tail}`;
      return `cylinder ${r.center.join(" ")}  ${r.axis.join(" ")}  ${r.radius}  ${r.sizeIn}${tail}`;
    })
    .join("\n");
}
