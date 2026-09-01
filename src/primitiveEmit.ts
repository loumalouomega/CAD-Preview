import type { PrimitiveReport } from "./primitiveReport";
import type { Primitive } from "./primitiveSdf";
import type { EditOp } from "./editOps";
import { validateEditOp } from "./editOps";
import type { ParamVariable } from "./editVariables";

export interface EmittedPerSolid {
  solidId: string;
  faceCount: number;
  inventory: Record<string, number>;
  candidateKind: string | null;
  fitResidual: number | null;
  fitResidualFrac: number | null;
  emitted: boolean;
  reason?: string;
  opIndices?: number[];
  variableNames?: string[];
}

export interface PrimitiveEmission {
  variables: ParamVariable[];
  ops: EditOp[];
  perSolid: EmittedPerSolid[];
  warnings: string[];
}

function roundForEmit(v: number): number {
  if (!Number.isFinite(v)) return v;
  return Number(v.toPrecision(12));
}

function isValidVarName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function nextUniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

function normalizeVec(v: [number, number, number]): [number, number, number] | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(len) || len < 1e-12) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function axisAlignedPermutation(axes: [number, number, number][]): number[] | null {
  const world: [number, number, number][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const used = new Set<number>();
  const perm: number[] = [];
  for (const ax of axes) {
    let found = -1;
    for (let w = 0; w < 3; w++) {
      if (used.has(w)) continue;
      const d = Math.abs(dot(ax, world[w]));
      if (Math.abs(d - 1) < 1e-6) {
        found = w;
        break;
      }
    }
    if (found === -1) return null;
    used.add(found);
    perm.push(found);
  }
  return perm;
}

function rotationMatrixToAxisAngle(m: number[][]): { axis: [number, number, number]; angleDeg: number } | null {
  const trace = m[0][0] + m[1][1] + m[2][2];
  let cosAngle = (trace - 1) / 2;
  cosAngle = Math.max(-1, Math.min(1, cosAngle));
  const angle = Math.acos(cosAngle);
  if (!Number.isFinite(angle)) return null;
  if (Math.abs(angle) < 1e-9) return null;
  if (Math.abs(angle - Math.PI) < 1e-9) {
    const xx = (m[0][0] + 1) / 2;
    const yy = (m[1][1] + 1) / 2;
    const zz = (m[2][2] + 1) / 2;
    let axis: [number, number, number];
    if (xx > yy && xx > zz) {
      const x = Math.sqrt(Math.max(0, xx));
      const y = (m[0][1] + m[1][0]) / (4 * x);
      const z = (m[0][2] + m[2][0]) / (4 * x);
      axis = [x, y, z];
    } else if (yy > zz) {
      const y = Math.sqrt(Math.max(0, yy));
      const x = (m[0][1] + m[1][0]) / (4 * y);
      const z = (m[1][2] + m[2][1]) / (4 * y);
      axis = [x, y, z];
    } else {
      const z = Math.sqrt(Math.max(0, zz));
      const x = (m[0][2] + m[2][0]) / (4 * z);
      const y = (m[1][2] + m[2][1]) / (4 * z);
      axis = [x, y, z];
    }
    const n = normalizeVec(axis);
    if (!n) return null;
    return { axis: n, angleDeg: (angle * 180) / Math.PI };
  }
  const sinAngle = Math.sin(angle);
  if (Math.abs(sinAngle) < 1e-12) return null;
  const x = (m[2][1] - m[1][2]) / (2 * sinAngle);
  const y = (m[0][2] - m[2][0]) / (2 * sinAngle);
  const z = (m[1][0] - m[0][1]) / (2 * sinAngle);
  const axis = normalizeVec([x, y, z]);
  if (!axis) return null;
  return { axis, angleDeg: (angle * 180) / Math.PI };
}

function boxRotationAxisAngle(box: Extract<Primitive, { kind: "box" }>): { axis: [number, number, number]; angleDeg: number } | null {
  const m = [
    [box.xAxis[0], box.yAxis[0], box.zAxis[0]],
    [box.xAxis[1], box.yAxis[1], box.zAxis[1]],
    [box.xAxis[2], box.yAxis[2], box.zAxis[2]],
  ];
  return rotationMatrixToAxisAngle(m);
}

export function emitPrimitiveOps(
  report: PrimitiveReport,
  opts?: { existingVariableNames?: string[]; maxFitResidualFrac?: number }
): PrimitiveEmission {
  const taken = new Set<string>(opts?.existingVariableNames ?? []);
  const variables: ParamVariable[] = [];
  const ops: EditOp[] = [];
  const perSolid: EmittedPerSolid[] = [];
  const warnings: string[] = [];

  const maxFrac = opts?.maxFitResidualFrac;

  for (const solid of report.solids) {
    const baseEntry: EmittedPerSolid = {
      solidId: solid.solidId,
      faceCount: solid.faceCount,
      inventory: solid.inventory as unknown as Record<string, number>,
      candidateKind: solid.candidate?.kind ?? null,
      fitResidual: solid.fitResidual,
      fitResidualFrac: solid.fitResidualFrac,
      emitted: false,
    };

    if (!solid.candidate) {
      baseEntry.reason = "no signature match — not a recognized primitive";
      perSolid.push(baseEntry);
      continue;
    }

    if (maxFrac !== undefined && solid.fitResidualFrac !== null && solid.fitResidualFrac > maxFrac) {
      baseEntry.reason = `fitResidualFrac ${solid.fitResidualFrac.toExponential(2)} exceeds maxFitResidualFrac ${maxFrac}`;
      perSolid.push(baseEntry);
      warnings.push(`${solid.solidId}: skipped — ${baseEntry.reason}`);
      continue;
    }

    const candidate = solid.candidate;
    const emittedOps: EditOp[] = [];
    const varNames: string[] = [];
    const emitIndex = ops.length;

    const allocVar = (base: string, value: number): string => {
      const rounded = roundForEmit(value);
      let name = base;
      name = nextUniqueName(name, taken);
      taken.add(name);
      const expr = String(rounded);
      variables.push({ name, expr, value: rounded });
      varNames.push(name);
      return name;
    };

    const pushOp = (raw: unknown): boolean => {
      const validated = validateEditOp(raw);
      if (!validated) {
        warnings.push(`${solid.solidId}: emitted ${candidate.kind} op did not validate — skipped`);
        return false;
      }
      emittedOps.push(validated);
      return true;
    };

    if (candidate.kind === "box") {
      const sizeRounded: [number, number, number] = [
        roundForEmit(candidate.size[0]),
        roundForEmit(candidate.size[1]),
        roundForEmit(candidate.size[2]),
      ];
      const centerRounded: [number, number, number] = [
        roundForEmit(candidate.center[0]),
        roundForEmit(candidate.center[1]),
        roundForEmit(candidate.center[2]),
      ];
      const n = perSolid.filter((p) => p.emitted && p.candidateKind === "box").length + 1;
      const baseName = `box${n}`;
      const axes: [number, number, number][] = [candidate.xAxis, candidate.yAxis, candidate.zAxis].map((a) => {
        const nn = normalizeVec(a);
        return nn ?? a;
      });
      const perm = axisAlignedPermutation(axes);
      if (perm) {
        const permutedSize: [number, number, number] = [0, 0, 0];
        for (let i = 0; i < 3; i++) permutedSize[perm[i]] = sizeRounded[i];
        const vx = allocVar(`${baseName}_x`, permutedSize[0]);
        const vy = allocVar(`${baseName}_y`, permutedSize[1]);
        const vz = allocVar(`${baseName}_z`, permutedSize[2]);
        const rawBox: Record<string, unknown> = {
          op: "addBox",
          center: centerRounded,
          size: permutedSize as [number, number, number],
          exprs: { "size[0]": vx, "size[1]": vy, "size[2]": vz },
        };
        if (!pushOp(rawBox)) {
          for (const nm of varNames) {
            const idx = variables.findIndex((v) => v.name === nm);
            if (idx !== -1) variables.splice(idx, 1);
            taken.delete(nm);
          }
          baseEntry.reason = "box op validation failed";
          perSolid.push(baseEntry);
          continue;
        }
      } else {
        const vx = allocVar(`${baseName}_x`, sizeRounded[0]);
        const vy = allocVar(`${baseName}_y`, sizeRounded[1]);
        const vz = allocVar(`${baseName}_z`, sizeRounded[2]);
        const rawBox: Record<string, unknown> = {
          op: "addBox",
          center: centerRounded,
          size: sizeRounded,
          exprs: { "size[0]": vx, "size[1]": vy, "size[2]": vz },
        };
        if (!pushOp(rawBox)) {
          for (const nm of varNames) {
            const idx = variables.findIndex((v) => v.name === nm);
            if (idx !== -1) variables.splice(idx, 1);
            taken.delete(nm);
          }
          baseEntry.reason = "box op validation failed";
          perSolid.push(baseEntry);
          continue;
        }
        const rot = boxRotationAxisAngle(candidate);
        if (rot) {
          const targetId = `solid-${emitIndex}`;
          const rawRotate: Record<string, unknown> = {
            op: "rotate",
            targets: [targetId],
            axisPoint: centerRounded,
            axisDir: [roundForEmit(rot.axis[0]), roundForEmit(rot.axis[1]), roundForEmit(rot.axis[2])],
            angleDeg: roundForEmit(rot.angleDeg),
          };
          if (!pushOp(rawRotate)) {
            warnings.push(`${solid.solidId}: box rotation did not validate — box emitted axis-aligned only`);
          }
        } else {
          warnings.push(`${solid.solidId}: box is rotated but axis-angle could not be determined — emitted axis-aligned`);
        }
      }
    } else if (candidate.kind === "sphere") {
      const n = perSolid.filter((p) => p.emitted && p.candidateKind === "sphere").length + 1;
      const baseName = `sph${n}`;
      const r = roundForEmit(candidate.radius);
      const center: [number, number, number] = [
        roundForEmit(candidate.center[0]),
        roundForEmit(candidate.center[1]),
        roundForEmit(candidate.center[2]),
      ];
      const vr = allocVar(`${baseName}_r`, r);
      const raw: Record<string, unknown> = {
        op: "addSphere",
        center,
        radius: r,
        exprs: { radius: vr },
      };
      if (!pushOp(raw)) {
        for (const nm of varNames) {
          const idx = variables.findIndex((v) => v.name === nm);
          if (idx !== -1) variables.splice(idx, 1);
          taken.delete(nm);
        }
        baseEntry.reason = "sphere op validation failed";
        perSolid.push(baseEntry);
        continue;
      }
    } else if (candidate.kind === "cylinder") {
      const n = perSolid.filter((p) => p.emitted && p.candidateKind === "cylinder").length + 1;
      const baseName = `cyl${n}`;
      const r = roundForEmit(candidate.radius);
      const h = roundForEmit(candidate.height);
      const vr = allocVar(`${baseName}_r`, r);
      const vh = allocVar(`${baseName}_h`, h);
      const center: [number, number, number] = [
        roundForEmit(candidate.base[0]),
        roundForEmit(candidate.base[1]),
        roundForEmit(candidate.base[2]),
      ];
      const axis: [number, number, number] = [
        roundForEmit(candidate.axis[0]),
        roundForEmit(candidate.axis[1]),
        roundForEmit(candidate.axis[2]),
      ];
      const raw: Record<string, unknown> = {
        op: "addCylinder",
        center,
        axis,
        radius: r,
        height: h,
        exprs: { radius: vr, height: vh },
      };
      if (!pushOp(raw)) {
        for (const nm of varNames) {
          const idx = variables.findIndex((v) => v.name === nm);
          if (idx !== -1) variables.splice(idx, 1);
          taken.delete(nm);
        }
        baseEntry.reason = "cylinder op validation failed";
        perSolid.push(baseEntry);
        continue;
      }
    } else if (candidate.kind === "cone") {
      const n = perSolid.filter((p) => p.emitted && p.candidateKind === "cone").length + 1;
      const baseName = `cone${n}`;
      const r1 = roundForEmit(candidate.radius1);
      const r2 = roundForEmit(candidate.radius2);
      const h = roundForEmit(candidate.height);
      const vr1 = allocVar(`${baseName}_r1`, r1);
      const vr2 = allocVar(`${baseName}_r2`, r2);
      const vh = allocVar(`${baseName}_h`, h);
      const center: [number, number, number] = [
        roundForEmit(candidate.base[0]),
        roundForEmit(candidate.base[1]),
        roundForEmit(candidate.base[2]),
      ];
      const axis: [number, number, number] = [
        roundForEmit(candidate.axis[0]),
        roundForEmit(candidate.axis[1]),
        roundForEmit(candidate.axis[2]),
      ];
      const raw: Record<string, unknown> = {
        op: "addCone",
        center,
        axis,
        radius1: r1,
        radius2: r2,
        height: h,
        exprs: { radius1: vr1, radius2: vr2, height: vh },
      };
      if (!pushOp(raw)) {
        for (const nm of varNames) {
          const idx = variables.findIndex((v) => v.name === nm);
          if (idx !== -1) variables.splice(idx, 1);
          taken.delete(nm);
        }
        baseEntry.reason = "cone op validation failed";
        perSolid.push(baseEntry);
        continue;
      }
    } else if (candidate.kind === "torus") {
      const n = perSolid.filter((p) => p.emitted && p.candidateKind === "torus").length + 1;
      const baseName = `tor${n}`;
      const R = roundForEmit(candidate.majorRadius);
      const r = roundForEmit(candidate.minorRadius);
      const vr = allocVar(`${baseName}_R`, R);
      const vm = allocVar(`${baseName}_r`, r);
      const center: [number, number, number] = [
        roundForEmit(candidate.center[0]),
        roundForEmit(candidate.center[1]),
        roundForEmit(candidate.center[2]),
      ];
      const axis: [number, number, number] = [
        roundForEmit(candidate.axis[0]),
        roundForEmit(candidate.axis[1]),
        roundForEmit(candidate.axis[2]),
      ];
      const raw: Record<string, unknown> = {
        op: "addTorus",
        center,
        axis,
        majorRadius: R,
        minorRadius: r,
        exprs: { majorRadius: vr, minorRadius: vm },
      };
      if (!pushOp(raw)) {
        for (const nm of varNames) {
          const idx = variables.findIndex((v) => v.name === nm);
          if (idx !== -1) variables.splice(idx, 1);
          taken.delete(nm);
        }
        baseEntry.reason = "torus op validation failed";
        perSolid.push(baseEntry);
        continue;
      }
    } else if (candidate.kind === "plane") {
      baseEntry.reason = "plane candidate — no solid to emit";
      perSolid.push(baseEntry);
      warnings.push(`${solid.solidId}: plane candidate skipped`);
      continue;
    }

    const startIdx = ops.length;
    ops.push(...emittedOps);
    baseEntry.emitted = true;
    baseEntry.opIndices = emittedOps.map((_, i) => startIdx + i);
    baseEntry.variableNames = [...varNames];
    perSolid.push(baseEntry);
  }

  return { variables, ops, perSolid, warnings };
}
