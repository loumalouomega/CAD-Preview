// meshio++ 20 scan / surface-editing operations as `transform_mesh` / Mesh Ops
// steps. Pure over an injected meshio++ module (`m`), so this file does not
// import `meshioService.ts` (which imports it): the executor there owns the
// staging, the write and the per-step try/catch.
//
// Every option is forwarded only when the spec set it, so a default call is the
// upstream default. Facts go into `detail` (and `warnings` for upstream's own
// words), never a verdict.

import type { MeshioOpSpec } from "./meshioOps";

export interface ScanOpOutcome {
  mesh: any;
  detail: string;
  warnings: string[];
}

/** Ops this module runs; `meshioService.runMeshioOps` delegates these and keeps its own switch for the rest. */
export const SCAN_OP_IDS: ReadonlySet<string> = new Set([
  "flipNormals", "removeIslands", "offsetSurface", "thicken", "hollow", "clip", "autoAlign", "silhouette", "thickness", "colorize", "exaggerate",
]);

function pick(spec: MeshioOpSpec, keys: readonly (keyof MeshioOpSpec)[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of keys) if (spec[k] !== undefined) o[k as string] = spec[k];
  return o;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.map((w) => String(w)) : [];
}

function sig(v: unknown, digits = 5): string {
  const x = Number(v);
  return Number.isFinite(x) ? x.toPrecision(digits) : "n/a";
}

/** Runs one scan op over `mesh`. Returns `null` for an op id that is not a scan op. */
export function applyScanOp(m: any, mesh: any, spec: MeshioOpSpec): ScanOpOutcome | null {
  switch (spec.op) {
    case "flipNormals": {
      const r = m.flipNormals(mesh, spec.region);
      return { mesh: r.mesh, detail: `reversed ${r.numFlipped} cell(s)${spec.region ? ` of region "${spec.region}"` : ""}`, warnings: [] };
    }
    case "removeIslands": {
      const r = m.removeIslands(mesh, pick(spec, ["connectivity", "minDiagonal", "minArea", "minCells", "relative", "dryRun"]));
      const dry = spec.dryRun === true;
      return {
        mesh: r.mesh,
        detail: `${r.numComponents} component(s); ${dry ? "would remove" : "removed"} ${r.numRemoved} (${r.numCellsRemoved} cell(s)${dry ? ", marked in cell data islands:removed" : `, ${r.numPointsRemoved} point(s)`})`,
        warnings: [],
      };
    }
    case "offsetSurface": {
      if (spec.distance === undefined) throw new Error("offsetSurface needs a distance");
      const r = m.offsetSurface(mesh, spec.distance, pick(spec, ["smoothIterations"]));
      return { mesh: r.mesh, detail: `offset ${spec.distance}; largest point move ${sig(r.maxMove)}, ${r.numClamped} clamped, ${r.numFolded} folded`, warnings: strings(r.warnings) };
    }
    case "thicken": {
      if (spec.distance === undefined) throw new Error("thicken needs a distance (the wall thickness)");
      const r = m.thicken(mesh, spec.distance, pick(spec, ["side", "smoothIterations"]));
      return { mesh: r.mesh, detail: `shell ${spec.distance} thick (${spec.side ?? "inward"}), ${r.numRimQuads} rim quad(s), ${r.numFolded} folded`, warnings: strings(r.warnings) };
    }
    case "hollow": {
      if (spec.distance === undefined) throw new Error("hollow needs a distance (the wall)");
      const r = m.hollow(mesh, spec.distance, pick(spec, ["smoothIterations"]));
      return { mesh: r.mesh, detail: `inner wall ${spec.distance} inside, ${r.numFolded} folded`, warnings: strings(r.warnings) };
    }
    case "clip": {
      if (!spec.origin || !spec.normal) throw new Error("clip needs an origin and a normal");
      const r = m.clip(mesh, spec.origin, spec.normal, pick(spec, ["keepBelow", "cap"]));
      const open = Number(r.numOpenChains);
      return {
        mesh: r.mesh,
        detail: `kept ${r.numKept} cell(s), split ${r.numSplit}, ${r.numCapTriangles} cap triangle(s) over ${r.numLoops} loop(s)${open > 0 ? `, ${open} open chain(s) left uncapped` : ""}`,
        warnings: strings(r.warnings),
      };
    }
    case "autoAlign": {
      const r = m.autoAlign(mesh, pick(spec, ["angleTolerance", "region"]));
      return { mesh: r.mesh, detail: `posed on its ${r.mode}; flat-face share ${sig(r.faceShare, 3)}, axis share ${sig(r.axisShare, 3)}`, warnings: strings(r.warnings) };
    }
    case "silhouette": {
      const o = pick(spec, ["normal", "clearance", "roundAngle", "extrude", "region"]);
      const r = m.silhouette(mesh, o);
      return {
        mesh: r.mesh,
        detail: `${r.numLoops} loop(s) (${r.numOuter} outer, ${r.numHoles} hole(s)), area ${sig(r.area)}, perimeter ${sig(r.perimeter)}${spec.extrude ? `, ${r.numTriangles} prism triangle(s)` : ""}`,
        warnings: strings(r.warnings),
      };
    }
    case "thickness": {
      const o: Record<string, unknown> = pick(spec, ["direction", "maxDistance", "coneAngle", "twoSided", "region"]);
      if (spec.probe !== undefined) o.method = spec.probe;
      const r = m.thickness(mesh, o);
      return {
        mesh: r.mesh,
        detail: `${r.method ?? "ray"} ${r.direction}: ${r.numHit} hit / ${r.numMissed} missed, min ${sig(r.min)}, mean ${sig(r.mean)}, p95 ${sig(r.p95)} → cell data "thickness:distance"`,
        warnings: strings(r.warnings),
      };
    }
    case "colorize": {
      if (!spec.field) throw new Error("colorize needs a field");
      const o: Record<string, unknown> = { field: spec.field };
      if (spec.cmap !== undefined) o.cmap = spec.cmap;
      const r = m.colorize(mesh, o);
      return { mesh: r.mesh, detail: `"${spec.field}" ${sig(r.vmin)}…${sig(r.vmax)} through ${spec.cmap ?? "viridis"} → ${r.location} data red/green/blue`, warnings: [] };
    }
    case "exaggerate": {
      const o = pick(spec, ["field", "scale", "clamp"]);
      const r = m.exaggerate(mesh, o);
      return { mesh: r.mesh, detail: `moved ${r.numMoved} point(s) by ${spec.scale ?? 10} × the deviation (clamped at ${sig(r.clamp)}, smoothing radius ${sig(r.radius)})`, warnings: strings(r.warnings) };
    }
    default:
      return null;
  }
}
