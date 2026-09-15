import { connectedComponents, boundsOfTriangles, boundsCenter, boundsDiagonal, type WeldedMesh } from "./meshComponents";
import { triangleMassProperties } from "./triangleMassProperties";
import type { Vec3 } from "./editOps";
import type { EntityFacts, MeasureResult } from "./entityFacts";

/** Headless ids intentionally differ from webview object/facet ids. Components
 * follow edge-connected triangle order; triangles and vertices use parser order.
 * Valid only for the same raw file. They are not edit/Part operands. */
export function meshInspection(mesh: WeldedMesh) {
  const components = connectedComponents(mesh.indices);
  const all = Array.from({length: mesh.indices.length / 3}, (_, i) => i);
  function resolve(id: string): { triangles: number[]; kind: EntityFacts["kind"]; point?: Vec3 } {
    if (id === "whole-model") return {triangles: all, kind: "solid"};
    const match = /^mesh-(component|triangle|vertex)-(\d+)$/.exec(id);
    if (!match) throw new Error(`Unknown headless mesh entity ${id}; use load_model's meshEntities inventory`);
    const n = Number(match[2]);
    if (match[1] === "component" && components[n]) return {triangles: components[n], kind: "solid"};
    if (match[1] === "triangle" && n < all.length) return {triangles: [n], kind: "face"};
    if (match[1] === "vertex" && n < mesh.positions.length / 3) return {triangles: [], kind: "point", point: Array.from(mesh.positions.slice(n*3, n*3+3)) as Vec3};
    throw new Error(`Unknown headless mesh entity ${id}; re-run load_model`);
  }
  function mass(id = "whole-model") {
    const selected = resolve(id);
    const soup: number[] = [];
    for (const t of selected.triangles) for (let c = 0; c < 3; c++) {
      const i = mesh.indices[t*3+c]*3;
      soup.push(mesh.positions[i], mesh.positions[i+1], mesh.positions[i+2]);
    }
    const p = triangleMassProperties(soup);
    return { volume: selected.kind === "solid" && selected.triangles.length > 0 ? p.volume : null,
      area: selected.kind === "point" ? null : p.area, length: null,
      centerOfMass: selected.point ?? (selected.kind === "solid" && p.watertight ? p.volumeCentroid : p.areaCentroid),
      momentsOfInertia: null, watertight: selected.triangles.length > 0 && p.watertight };
  }
  function inspect(id: string): EntityFacts {
    const selected = resolve(id);
    const bounds = selected.point ? {min: selected.point, max: selected.point} : boundsOfTriangles(mesh.positions, mesh.indices, selected.triangles);
    if (!bounds) throw new Error("Mesh entity contains no geometry");
    return {entityId: id, kind: selected.kind, bbox: {...bounds, diagonal: boundsDiagonal(bounds)}, center: boundsCenter(bounds),
      area: mass(id).area, length: null, normal: null, planeOrigin: null, surfaceType: null, surfaceParams: null, curveType: null};
  }
  function measure(from: string, to: string, axis?: Vec3): MeasureResult {
    const fromPoint = inspect(from).center, toPoint = inspect(to).center;
    const delta = toPoint.map((n, i) => n-fromPoint[i]) as Vec3;
    const result: MeasureResult = {from, to, fromPoint, toPoint, delta, distance: Math.hypot(...delta)};
    if (axis) {
      const length = Math.hypot(...axis);
      if (!Number.isFinite(length) || length === 0) throw new Error("Measurement axis must be finite and nonzero");
      result.axis = axis;
      result.axisComponent = delta.reduce((sum, n, i) => sum+n*(axis[i]/length), 0);
    }
    return result;
  }
  return {mass, inspect, measure, inventory: {
    components: components.map((triangles, i) => ({entityId: `mesh-component-${i}`, triangleCount: triangles.length})),
    triangleCount: all.length, triangleIdPattern: "mesh-triangle-N",
    vertexCount: mesh.positions.length / 3, vertexIdPattern: "mesh-vertex-N",
  }};
}
