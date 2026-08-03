import type { DisplayUnit } from "./lengthUnits";

/**
 * Rewrites a freshly-OCCT-written STEP file's textual unit declaration so it
 * correctly labels geometry that was already scaled (via
 * `occtOperations.ts`'s `scaleShapeForExport`, the same mechanism BREP/mesh
 * export targets use) to `unit` before the writer ran — vscode/OCCT-free,
 * pure text surgery, unit-tested.
 *
 * Why this exists: `Interface_Static`'s `"write.step.unit"` parameter never
 * registers in this OCCT WASM build (`IsPresent`/`SetCVal` both report
 * failure even after the full real-OCCT init sequence —
 * `STEPControl_Controller.Init()` + `XSControl_WorkSession.SelectNorm("STEP")`
 * + constructing `STEPControl_Writer_2(ws, true)` — re-probed against the
 * live WASM specifically for this feature, not assumed unfixable from the
 * original, shallower probe), and no writer-level unit-aware overload exists
 * either (`STEPControl_Writer`/`STEPControl_ActorWrite` expose no unit
 * setter; `STEPConstruct_UnitContext` is read-side only, used to interpret an
 * already-written model's declared unit, not to declare one on write). So
 * this OCCT WASM build's STEP writer ALWAYS emits a bare
 * `SI_UNIT(.MILLI.,.METRE.)` declaration regardless of the shape's actual
 * scale — confirmed unchanged even when fed shape data already pre-scaled to
 * a different unit's magnitude.
 *
 * Since the geometry itself is already correctly scaled before the writer
 * ever runs, every raw number in the output file (cartesian points, the
 * writer's own auto-computed uncertainty tolerance, everything) is ALREADY
 * expressed in the target unit's magnitude — this function's only job is to
 * relabel what unit those already-correct numbers are declared to be in. No
 * geometry-bearing entity is ever touched.
 *
 * Verified against the live WASM (`bull.stp` re-exported through this
 * codebase's own `exportBRep`): a single compound-shape STEP write emits
 * MULTIPLE independent `GLOBAL_UNIT_ASSIGNED_CONTEXT` blocks (one per
 * `ADVANCED_BREP_SHAPE_REPRESENTATION`/assembly component — 5 for `bull.stp`,
 * not 1), each with its own private bare-mm `LENGTH_UNIT()` entity, each
 * entity referenced from exactly two places: its own
 * `GLOBAL_UNIT_ASSIGNED_CONTEXT` tuple and a paired
 * `UNCERTAINTY_MEASURE_WITH_UNIT` — this function finds and redirects every
 * one of them, not just the first (an id string search restricted to "the
 * first `GLOBAL_UNIT_ASSIGNED_CONTEXT` in the file", `detectStepLengthUnit`'s
 * own — correct, for its purpose — convention, would silently miss the
 * other 4).
 */
export function patchStepUnitDeclaration(stepText: string, unit: DisplayUnit): string {
  if (unit === "mm") return stepText;

  const bareMmEntity = /#(\d+)\s*=\s*\(\s*LENGTH_UNIT\(\s*\)\s*NAMED_UNIT\(\s*\*\s*\)\s*SI_UNIT\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)\s*\)\s*;/g;
  const mmIds: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = bareMmEntity.exec(stepText))) mmIds.push(m[1]);
  if (mmIds.length === 0) return stepText; // Defensive: not OCCT-shaped output — leave untouched rather than guess.

  if (unit === "cm" || unit === "m") {
    const replacement = unit === "cm" ? "SI_UNIT(.CENTI.,.METRE.)" : "SI_UNIT($,.METRE.)";
    // Same entity ids stay valid — every existing reference (GLOBAL_UNIT_ASSIGNED_CONTEXT,
    // UNCERTAINTY_MEASURE_WITH_UNIT) keeps pointing at the same, now-relabeled entity.
    return stepText.replace(bareMmEntity, (whole) => whole.replace(/SI_UNIT\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/, replacement));
  }

  // "in" / "ft": a bare SI_UNIT can't express a named conversion-based unit —
  // append one shared CONVERSION_BASED_UNIT (+ its DIMENSIONAL_EXPONENTS and
  // LENGTH_MEASURE_WITH_UNIT conversion-factor entities), reusing the FIRST
  // found mm entity as its base (any one works — they're textually
  // identical), then redirect every mm entity's non-definition references to
  // it. This exact complex-entity shape (three cooperating entities, a
  // conversion factor referencing a base SI unit) is not invented — it's
  // copied from `bull.stp`'s own real, OCCT-independent, tool-authored INCH
  // declaration (`#121=(CONVERSION_BASED_UNIT('INCH',#117)LENGTH_UNIT()
  // NAMED_UNIT(#116));`), the same file `stepUnits.test.ts` already treats as
  // ground truth.
  let maxId = 0;
  const idRe = /#(\d+)\s*=/g;
  while ((m = idRe.exec(stepText))) maxId = Math.max(maxId, parseInt(m[1], 10));

  const baseId = mmIds[0];
  const dimId = maxId + 1;
  const measureId = maxId + 2;
  const unitId = maxId + 3;
  const factor = unit === "in" ? 25.4 : 304.8;
  const name = unit === "in" ? "INCH" : "FOOT";

  // Redirect every mm entity's non-definition references (word-boundary safe:
  // not followed by another digit, and not the entity's own `#N = (` line)
  // to the new conversion unit — done BEFORE the new block is appended, so
  // the new block's own fresh references to #baseId/#dimId/#measureId are
  // never touched by this pass.
  let patched = stepText;
  for (const id of mmIds) {
    const usageRe = new RegExp(`#${id}(?!\\d)(?!\\s*=)`, "g");
    patched = patched.replace(usageRe, `#${unitId}`);
  }

  const newBlock =
    `#${dimId} = DIMENSIONAL_EXPONENTS(1.0,0.0,0.0,0.0,0.0,0.0,0.0);\n` +
    `#${measureId} = LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(${factor}),#${baseId});\n` +
    `#${unitId} = ( CONVERSION_BASED_UNIT('${name}',#${measureId}) LENGTH_UNIT() NAMED_UNIT(#${dimId}) );\n`;

  const endOfData = /\nENDSEC;\s*\nEND-ISO-10303-21;/;
  if (!endOfData.test(patched)) return patched; // Defensive: unrecognized file shape — skip the insert rather than corrupt it.
  return patched.replace(endOfData, `\n${newBlock}ENDSEC;\nEND-ISO-10303-21;`);
}
