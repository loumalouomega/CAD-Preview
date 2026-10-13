/**
 * Byte-reproducible STEP output (roadmap "Reproducible exports") — pure text
 * surgery, vscode/OCCT-free, unit-tested.
 *
 * What actually moves between two exports of the same model was MEASURED
 * (`scripts/probe/examples/export-determinism.ts`, two exports of `bull.stp`
 * 1.1 s apart in one process), not assumed from the formats' specs:
 *
 *   - **STEP** — three things move, none of which is geometry:
 *       1. the `FILE_NAME` timestamp (second resolution);
 *       2. a process-global counter OCCT's STEP translator bakes into every
 *          product name: `'Open CASCADE STEP translator 7.4 1.2.1'` becomes
 *          `... 7.4 2.2.1` on the next write in the same process. Its first
 *          integer is the counter, the rest is the product's place in the
 *          assembly. So the SAME model exported as the Nth file of a session
 *          differs from the first;
 *       3. the same counter again in `NEXT_ASSEMBLY_USAGE_OCCURRENCE('1', ...)`
 *          ids (observed `'1'`/`'2'` then `'5'`/`'6'`).
 *     The XCAF (named-Part) path moves only the timestamp: its product names
 *     are the Part names.
 *   - **IGES and BREP** — byte-identical across the two exports. The roadmap
 *     assumed IGES carries a date field that moves; in this build it does not.
 *     Nothing is normalised for them.
 *
 * Every replacement here touches only an opaque id string no other entity
 * references (statements that carry one are also unwrapped, since OCCT's line
 * wrapping depends on the id's length), so entity numbering and every
 * geometry-bearing record are untouched. Unrecognised input is returned
 * unchanged, and the function is idempotent.
 */

/** The fixed timestamp written in place of the export time. */
export const DETERMINISTIC_STEP_TIMESTAMP = "1970-01-01T00:00:00";

const FILE_NAME_TIMESTAMP = /(FILE_NAME\('[^']*',')\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(')/;
// 'Open CASCADE STEP translator 7.4 <counter>[.<k>[.<j>...]]' — only the first integer is the counter.
const TRANSLATOR_COUNTER = /(Open CASCADE STEP translator \d+\.\d+ )\d+/g;
const NAUO_ID = /(NEXT_ASSEMBLY_USAGE_OCCURRENCE\(')[^']*(')/g;

// An entity statement as OCCT writes it: a `#N = ...` line plus any number of
// continuation lines indented by two spaces (its writer wraps long statements).
const STATEMENT = /^#\d+ = [^\n]*(?:\n {2}[^\n]*)*/gm;
const MOVING_STATEMENT = /NEXT_ASSEMBLY_USAGE_OCCURRENCE\(|Open CASCADE STEP translator/;

/**
 * OCCT wraps a statement where it passes a column limit, and the limit is hit
 * or missed depending on how many digits the counters above happened to need
 * (measured: `...,#4022,$` / `);` on one line in one export, split in the next).
 * Rewriting the counter without also unwrapping would leave the wrapping, i.e.
 * the bytes, dependent on the original counter. Only statements carrying a
 * moving field are unwrapped; a wrap sits at a token boundary, so dropping the
 * newline and its two-space indent restores the unwrapped statement exactly.
 */
function unwrapMovingStatements(text: string): string {
  return text.replace(STATEMENT, (stmt) => (MOVING_STATEMENT.test(stmt) ? stmt.replace(/\r?\n {2}/g, "") : stmt));
}

/** Rewrites the moving fields of a STEP file written by this extension's OCCT build. */
export function normalizeStepForDeterminism(text: string): string {
  let n = 0;
  return unwrapMovingStatements(text)
    .replace(FILE_NAME_TIMESTAMP, `$1${DETERMINISTIC_STEP_TIMESTAMP}$2`)
    .replace(TRANSLATOR_COUNTER, "$11")
    // The occurrence ids are free-form labels that nothing else references;
    // renumbering them in file order keeps them unique and independent of how
    // many occurrences earlier exports in the process consumed.
    .replace(NAUO_ID, (_m, pre: string, post: string) => `${pre}${++n}${post}`);
}

/**
 * True when a STEP file contains a number OCCT wrote as `NAN`/`-NAN`/`INF`
 * (token-delimited, so a name like 'BANANA' does not count). Observed in
 * practice as `(          -NAN,1.)` where a knot `(0.,1.)` belongs.
 */
export function stepHasNonFiniteNumber(text: string): boolean {
  return /[,(\s]-?(?:NAN|INF)(?=[,)\s])/i.test(text);
}
