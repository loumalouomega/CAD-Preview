import { getOcct, wrapOcctFault, writeShape } from "./occtService";
import { applyEditsBRep, scaleShapeForExport } from "./occtOperations";
import { patchStepUnitDeclaration } from "./stepUnitPatch";
import { unitScaleFactor, type DisplayUnit } from "./lengthUnits";
import type { EditOp, OpOutcome } from "./editOps";
import type { CadFormat } from "./fileRouter";

type BRepFormat = Extract<CadFormat, "step" | "iges" | "brep">;

export async function buildPrimitivesFile(
  extensionPath: string,
  ops: EditOp[],
  targetFormat: BRepFormat,
  unit: DisplayUnit = "mm"
): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  if (ops.length === 0) throw new Error("No primitives to write — nothing was recognized.");
  const oc = await getOcct(extensionPath);
  const outPath = `/p.${targetFormat}`;
  const cleanup: Array<{ delete(): void }> = [];
  try {
    const base = new oc.TopoDS_Compound();
    cleanup.push(base);
    const builder = new oc.BRep_Builder();
    cleanup.push(builder);
    builder.MakeCompound(base);

    const outcomes: OpOutcome[] = [];
    let shape: unknown = applyEditsBRep(oc, base, ops, cleanup, outcomes);

    const warnings: string[] = [];
    for (const o of outcomes) {
      if (!o.applied) warnings.push(`op ${o.index} (${(ops[o.index] as any)?.op}) did not apply: ${o.diagnostic ?? "no reason"}`);
    }

    const factor = unitScaleFactor(unit);
    if (factor !== 1 && targetFormat !== "iges") {
      shape = scaleShapeForExport(oc, shape, factor, cleanup);
    }

    writeShape(oc, shape as any, outPath, targetFormat as any, cleanup, unit, []);

    let outBytes: Uint8Array = oc.FS.readFile(outPath);
    if (targetFormat === "step" && unit !== "mm") {
      const text = Buffer.from(outBytes).toString("utf8");
      outBytes = new TextEncoder().encode(patchStepUnitDeclaration(text, unit));
    }
    return { bytes: outBytes, warnings };
  } catch (err) {
    throw wrapOcctFault(err);
  } finally {
    for (let i = cleanup.length - 1; i >= 0; i--) {
      try {
        cleanup[i].delete();
      } catch {
        /* ignore */
      }
    }
    try {
      oc.FS.unlink(outPath);
    } catch {
      /* ignore */
    }
  }
}
