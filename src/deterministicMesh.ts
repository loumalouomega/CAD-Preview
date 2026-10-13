/**
 * Byte-reproducible mesh exports (roadmap "Reproducible exports") — pure text
 * surgery, vscode/WASM-free, unit-tested. The sibling of `deterministicHeader.ts`.
 *
 * What moves between two `export_mesh` outputs of one model was MEASURED
 * (`scripts/probe/examples/mesh-export-determinism.ts`: every registered format
 * written twice, 1.1 s apart, in one process), not assumed from the formats'
 * specs:
 *
 *   - **A process-global Gmsh model counter.** Every Gmsh model is named
 *     `model-<n>` (`gmshService.ts`), so the Nth mesh of a session differs from
 *     the first. It leaks into exactly two outputs: the second line of a Gmsh
 *     `.vtk` (`model-11, Created by Gmsh …`) and the `<geometry name="model-9">`
 *     of the `.xao` companion that `geoUnrolled` writes for a B-rep source. The
 *     name is a label nothing else references, so both are rewritten to
 *     `model-1`.
 *   - **meshio++'s export time**, in two shapes:
 *       1. object timestamps inside the HDF5 containers (MED, CGNS, XDMF's
 *          `.h5`, HMF). NOT handled here: rewriting binary containers would
 *          also have to fix their metadata checksums, so `exportViaMeshio` pins
 *          the clock instead (`MeshioExportOptions.deterministic`) — measured to
 *          make all four byte-identical;
 *       2. a `Timestamp: <ISO>Z` line in the provenance block of the text
 *          formats (VTU, AVS UCD, COMSOL, Netgen, FLAC3D, Flux, GiD and its
 *          `.post.res` sibling). Measured: pinning `Date.now` does NOT reach this
 *          one (those files still differed with the pin in place), so it is
 *          rewritten here to a same-length fixed instant.
 *   - **Everything else was byte-identical** across the two exports: MSH 4.1,
 *     MSH 2, both Kratos MDPA modes, `.geo_unrolled` itself, UNV, Abaqus,
 *     Nastran, SU2, Medit, STL, Diffpack, OFF and WKT. Nothing is normalised
 *     for them.
 *
 * Unrecognised input is returned unchanged, and every function is idempotent.
 */

// Line 2 of a Gmsh legacy VTK file: `<model name>, Created by Gmsh <version> `.
const VTK_TITLE = /^(model-)\d+(, Created by Gmsh)/m;
// `<geometry name="model-9">` in the XAO written beside a B-rep `.geo_unrolled`.
const XAO_GEOMETRY_NAME = /(<geometry name=")model-\d+(")/;

// meshio++ provenance block: `Timestamp: 2026-10-13T21:22:57Z`, behind a
// format-specific comment leader (`# `, `* `, ` `, `# meshio++_3: `).
const PROVENANCE_TIMESTAMP = /(Timestamp: )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/;
/** The instant text provenance blocks are rewritten to — same length as a real one. */
export const DETERMINISTIC_MESH_TIMESTAMP = "1970-01-01T00:00:00Z";
/** Export-format ids whose files carry the provenance `Timestamp:` line. */
const TIMESTAMPED_TEXT_FORMATS = new Set(["vtu", "avsucd", "mphtxt", "netgen", "flac3d", "flux", "gid"]);

function hasNul(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** Replaces `re` in `bytes` (decoded as latin1 so every byte round-trips), or returns `bytes` itself when nothing matches. */
function rewrite(bytes: Uint8Array, re: RegExp, replacement: (match: string, ...groups: string[]) => string): Uint8Array {
  if (hasNul(bytes)) return bytes;
  const text = Buffer.from(bytes).toString("latin1");
  const out = text.replace(re, replacement);
  return out === text ? bytes : new Uint8Array(Buffer.from(out, "latin1"));
}

/**
 * Rewrites the moving fields of one file of an `export_mesh` output.
 *
 * @param formatId a `MESH_EXPORT_FORMATS` id
 * @param role `"primary"` for the file the user named, `"companion"` for the
 *   meshio++ sibling (`.h5` / `.post.res`), `"xao"` for `geoUnrolled`'s companion
 */
export function normalizeMeshExport(formatId: string, role: string, bytes: Uint8Array): Uint8Array {
  if (formatId === "vtk" && role === "primary") return rewrite(bytes, VTK_TITLE, (_m, _pre, post) => `model-1${post}`);
  if (formatId === "geoUnrolled" && role === "xao") return rewrite(bytes, XAO_GEOMETRY_NAME, (_m, pre, post) => `${pre}model-1${post}`);
  if (TIMESTAMPED_TEXT_FORMATS.has(formatId)) return rewrite(bytes, PROVENANCE_TIMESTAMP, (_m, pre) => `${pre}${DETERMINISTIC_MESH_TIMESTAMP}`);
  return bytes;
}
