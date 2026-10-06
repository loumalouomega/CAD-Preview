import type { Part } from "./protocol";
import { clean, envelope } from "./untrustedText";

/** Rebind by named regions, never by the old face-N numbering. Selectors
 * tied to the original CAD op history cannot apply to the remeshed file. */
export function remeshedParts(built: Part[], original: Part[], regionNames: string[]): { parts: Part[]; warnings: string[] } {
  const names = new Set(regionNames.map(name => clean(name, 100)));
  for (const part of original) {
    if ((part.surfaces.length || part.volumes.length || part.lines.length || part.points.length) && !names.has(part.name)) {
      throw new Error(`Part ${envelope(part.name, "part")} has no named cell region in this mesh. Export a generated mesh with Parts first; MMG cannot carry positional CAD/mesh ids across a remesh.`);
    }
  }
  const warnings: string[] = [];
  const parts = built.map(part => {
    const old = original.find(p => p.name === part.name);
    if (!old) return part;
    return { ...part, color: old.color, ...(old.meshSize !== undefined ? { meshSize: old.meshSize } : {}) };
  });
  for (const name of names) if (!parts.some(p => p.name === name)) warnings.push(`Region ${envelope(name, "region")} survives in the mesh but has no selectable boundary facet Part (interior-only, overlap or facet-count limit).`);
  if (original.some(p => p.selector || p.meshGrading)) warnings.push("CAD selectors and distance-grading metadata were not copied: the output has new mesh topology.");
  return { parts, warnings };
}
