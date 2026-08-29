/**
 * Pure, vscode/WASM-free helpers for meshio++ multi-file formats — a
 * companion-file DEFECT this module fixes and a companion-file FEATURE it
 * enables, both with the same root cause: `meshioService.ts` used to write
 * only a source's own bytes into meshio++'s MEMFS, under a synthetic renamed
 * path (`/in.<fmt>`), and never any sibling file a format's reader might
 * need.
 *
 * **The defect, verified against the live WASM:** XDMF's `.xdmf` XML embeds
 * `<DataItem Format="HDF">name.h5:/path</DataItem>` references, resolved by
 * meshio++'s own HDF5 reader relative to the `.xdmf`'s OWN MEMFS directory —
 * confirmed live: writing an XDMF pair via `writeMesh()` and then reading
 * the `.xdmf` back with its `.h5` sibling deleted throws
 * `HDF5: could not open file /model.h5`. Since `exportViaMeshio()` (this
 * codebase's own writer) deliberately produces exactly that pair, and
 * `.xdmf` is a supported IMPORT format (`MESHIO_FORMATS`), CAD-Preview could
 * not previously re-open the files it itself exports.
 *
 * **The feature:** TetGen (`.node`/`.ele`), Triangle (`.node`/`.ele`/`.poly`)
 * and EnSight Gold (`.case`/`.geo`) all discover their sibling purely by
 * STEM/extension convention (verified against meshio++'s own format docs,
 * `doc/formats/{tetgen,triangle,ensight}.md` in the meshio++ checkout) —
 * `readMesh("mesh.node")` looks for `mesh.ele` beside it. Both this
 * convention and XDMF's content-driven one are handled the SAME way at the
 * MEMFS level: write every sibling under its own real/referenced basename,
 * in the same flat root directory as the primary file (verified: a
 * synthetic-renamed primary at `/in.xdmf` alongside a companion written as
 * `/model.h5` reads correctly, since HDF5 resolution is relative to the
 * *reading* file's directory, which for a flat MEMFS root is always `/` —
 * no MEMFS subdirectory juggling is needed for either convention).
 */

/** Formats whose reader discovers a sibling file purely from the primary
 * file's own basename (swap the extension) — as opposed to XDMF, whose
 * sibling is named by whatever the file's OWN content references. */
const STEM_COMPANION_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  tetgen: ["node", "ele"],
  triangle: ["node", "ele", "poly"],
  ensight: ["case", "geo"],
  // GiD postprocess ascii: geometry in `<stem>.post.msh`, results in the
  // `<stem>.post.res` sibling. Only the FINAL segment is listed, because
  // `stemCompanionCandidates` splits on the last dot — for `beam.post.msh` that
  // yields stem `beam.post` + primary ext `msh`, so `"res"` correctly produces
  // `beam.post.res`. (The `.post` segment travels along inside the stem, which
  // is exactly right: GiD's own convention swaps only that final segment.)
  gid: ["msh", "res"],
};

/**
 * Returns the sibling basenames a stem-convention format's reader may need,
 * given the PRIMARY file's own basename — every extension in that format's
 * family, in the same directory, MINUS the primary's own extension (already
 * present). Returns `[]` for every format with no stem-sibling convention
 * (i.e. everything else, including XDMF — see {@link extractXdmfHdfReferences}).
 *
 * `primaryBasename` must include its extension (e.g. `"mesh.node"`); the
 * returned names share `primaryBasename`'s stem.
 */
export function stemCompanionCandidates(primaryBasename: string, meshioFormat: string): string[] {
  const extensions = STEM_COMPANION_EXTENSIONS[meshioFormat];
  if (!extensions) return [];
  const dot = primaryBasename.lastIndexOf(".");
  const stem = dot === -1 ? primaryBasename : primaryBasename.slice(0, dot);
  const primaryExt = dot === -1 ? "" : primaryBasename.slice(dot + 1).toLowerCase();
  return extensions.filter((ext) => ext !== primaryExt).map((ext) => `${stem}.${ext}`);
}

/**
 * Extracts every distinct HDF5 filename an XDMF document's `Format="HDF"`
 * `<DataItem>` elements reference (e.g. `"out.h5:/data0"` -> `"out.h5"`).
 *
 * A plain regex scan, not a real XML parser — mirrors `svgImport.ts`'s own
 * documented choice for the identical reason (this project's vitest config
 * has no `DOMParser`, so a regex keeps the module unit-testable headless).
 * An XDMF using the `"XML"`/`"Binary"` data formats (no `Format="HDF"`
 * attribute at all) correctly yields `[]` — those are self-contained and
 * need no companion.
 */
export function extractXdmfHdfReferences(xdmfText: string): string[] {
  const names = new Set<string>();
  const dataItemRe = /<DataItem\b[^>]*\bFormat\s*=\s*"HDF"[^>]*>([^<]*)<\/DataItem>/gi;
  let match: RegExpExecArray | null;
  while ((match = dataItemRe.exec(xdmfText)) !== null) {
    const inner = match[1].trim();
    const colon = inner.indexOf(":");
    const ref = (colon === -1 ? inner : inner.slice(0, colon)).trim();
    if (!ref) continue;
    // Strip any directory component — meshio++ resolves companions relative
    // to the primary file's own MEMFS directory, and this module always
    // writes companions flat alongside it under their basename alone.
    const slash = Math.max(ref.lastIndexOf("/"), ref.lastIndexOf("\\"));
    const basename = slash === -1 ? ref : ref.slice(slash + 1);
    if (basename) names.add(basename);
  }
  return Array.from(names);
}

/**
 * Returns the companion basenames `meshioFormat` might need for
 * `primaryBasename`/`primaryText` — the single dispatch point both
 * `provider.ts`'s `handleMeshio` and `mcpTools.ts`'s meshio call sites use
 * before reading any sibling file from disk. `primaryText` is only read for
 * `"xdmf"` (and only if the caller has it decoded — passing `undefined`
 * there just yields `[]`, i.e. "no known companions", never a crash).
 */
export function meshioCompanionCandidates(primaryBasename: string, meshioFormat: string, primaryText?: string): string[] {
  if (meshioFormat === "xdmf") return primaryText ? extractXdmfHdfReferences(primaryText) : [];
  return stemCompanionCandidates(primaryBasename, meshioFormat);
}
