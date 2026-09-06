/**
 * OpenSCAD `.csg` import — roadmap Tier 2 item 2, path (a).
 *
 * Pure, vscode/DOM/OCCT-free (no `DOMParser` — this project's vitest config
 * has no jsdom, same reasoning as `svgImport.ts`'s regex-based `<path d>`
 * extraction and `dxfImport.ts`'s line-pair scan). OpenSCAD's `.csg` export is
 * the fully evaluated model — loops unrolled, modules inlined, variables
 * literalised, `if` branches collapsed, every transform an explicit node — so
 * there is NO language to implement: no arithmetic, no variables, no control
 * flow (FreeCAD's own `.csg` lexer has 33 reserved words for exactly this
 * reason).
 *
 * Architecture: this module parses text into a cleaned AST (`CsgNode`) and
 * stops there. Geometry is built kernel-side by `csgModel.ts`, which walks
 * the AST with LIVE handles — so a `.csg` document's base shape is OPAQUE
 * (like a STEP import: user edits layer on top via the sidecar, the parsed
 * structure is not itself an edit history). Deliberately NOT lowered to
 * `EditOp`s: that would need positional `solid-N` index simulation across
 * nested booleans (fragile under graceful skips), a shear decomposition
 * (`multmatrix` is not guaranteed rigid and no shear op exists), and a brand
 * new `addPolyhedron` op kind complete with panel button + generated icon
 * (blocked: no TeX toolchain here). The opaque base needs none of it —
 * `multmatrix` applies raw via `gp_GTrsf`, polyhedron sews natively.
 *
 * Scope, stated plainly, not a silent gap (see `doc/roadmap.md` item 2):
 * - Built: `cube`, `sphere`, `cylinder`, `polyhedron`, `union`,
 *   `difference`, `intersection`, `group`, `color` (transparent — colour is
 *   not imported), `multmatrix`, `translate`, `rotate`, `scale`, `mirror`.
 * - Skipped with a warning (whole subtree dropped — placing children without
 *   the operation would be confidently-wrong geometry, not a graceful
 *   subset): `hull`/`minkowski` (no OCCT equivalent), `text`/`import`/
 *   `surface` (external files / fonts the reference WASM itself ships
 *   without), all 2D (`square`/`circle`/`polygon`, `linear_extrude`/
 *   `rotate_extrude`, `offset`/`projection`), `resize`/`render` (see below),
 *   and any unknown statement.
 * - `render` is transparent (a no-op for import); `color`'s `%`/`#`
 *   modifiers are transparent, `!` warns (siblings are NOT hidden on
 *   import), `*` disables (subtree skipped).
 *
 * Correctness decisions (per the roadmap item — getting these wrong is the
 * misleading-false-result failure mode the primitive-recognition work
 * describes):
 * - **Faceting dial.** OpenSCAD's `cylinder`/`sphere` are faceted prisms, not
 *   analytic surfaces. `$fn`/`$fa`/`$fs` survive into `.csg` (`$fn = 0` means
 *   unresolved — `resolveSegments` reimplements OpenSCAD's own rule).
 *   `useMaxFN` (default 16, FreeCAD's value and default) is the dial, applied
 *   kernel-side: at or below it a real N-gon prism, above it analytic.
 * - **Precision ceiling.** `.csg` prints at ~6 significant figures; exact
 *   axis alignment is recovered kernel-side with a tolerance snap, never
 *   exact float equality.
 */

export interface CsgParseOptions {
  /**
   * Faceting dial (default 16, FreeCAD's `useMaxFN` default): a cylinder
   * resolving to `n <= useMaxFN` segments builds a real N-gon prism; above
   * it an analytic cylinder. Passed through to `csgModel.ts`.
   */
  useMaxFN?: number;
}

export interface CsgNode {
  name: string;
  /** `%`/`#` transparent, `!` show-only, `*` disable, null ordinarily. */
  modifier: string | null;
  params: Record<string, CsgValue>;
  children: CsgNode[];
  /**
   * Pre-scanned `faces=[[..],[..]]` index lists for `polyhedron` (occurrence
   * order over the file). `parseValue` flattens nested vectors — sufficient
   * for points — which loses THESE boundaries, so they are recovered with a
   * dedicated regex before tokenizing. Absent when the node is not a
   * polyhedron or the scan found nothing (kernel skips with a warning).
   */
  faces?: number[][];
}

export type CsgValue = number | boolean | string | number[] | null;

export interface CsgParseResult {
  /** Top-level statements in file order (usually one `group`). */
  roots: CsgNode[];
  /** Human-readable warnings (skipped constructs, tokenizer complaints). */
  warnings: string[];
  /** Echo of the effective options (so the kernel side needs no defaults). */
  useMaxFN: number;
}

export const DEFAULT_USE_MAX_FN = 16;
/** OpenSCAD's own `$fa`/`$fs` defaults, used when a node omits them. */
export const DEFAULT_FA_DEG = 12;
export const DEFAULT_FS = 2;
/** Refuse absurd inputs before they cost anything (a `.csg` is small text). */
const MAX_CSG_BYTES = 10 * 1024 * 1024;

/** A Voronoi-free OpenSCAD `$fn` resolution: `$fn > 0` wins, else the
 * `$fa`/`$fs` rule (`max(5, ceil(360/fa), ceil(2πr/fs))` for a radius-`r`
 * circle — OpenSCAD's `get_fragments_from_r`). */
export function resolveSegments(r: number, fn: number | undefined, fa: number | undefined, fs: number | undefined): number {
  if (fn !== undefined && Number.isFinite(fn) && fn > 0) return Math.floor(fn);
  const faV = fa !== undefined && Number.isFinite(fa) && fa > 0 ? fa : DEFAULT_FA_DEG;
  const fsV = fs !== undefined && Number.isFinite(fs) && fs > 0 ? fs : DEFAULT_FS;
  if (!(r > 0)) return 5;
  return Math.max(5, Math.ceil(360 / faV), Math.ceil((2 * Math.PI * r) / fsV));
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Tok =
  | { t: "ident"; v: string }
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "punc"; v: string };

function tokenize(text: string, warnings: string[]): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // CSG debug modifiers prefixing a statement: % # ! *
    if ((c === "%" || c === "#" || c === "!" || c === "*") && /[A-Za-z_]/.test(text[i + 1] ?? "")) {
      toks.push({ t: "punc", v: c });
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\-]/.test(text[j])) j++;
      toks.push({ t: "ident", v: text.slice(i, j) });
      i = j;
      continue;
    }
    // numbers (incl. glued forms like 1.5.5 — greedy float first, the same
    // quirk `svgImport.ts`'s tokenizer handles)
    if (/[0-9.+\-]/.test(c) && /[0-9.]/.test(c === "+" || c === "-" ? (text[i + 1] ?? "") : c)) {
      const m = /^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?/.exec(text.slice(i));
      if (m) {
        toks.push({ t: "num", v: parseFloat(m[0]) });
        i += m[0].length;
        continue;
      }
      toks.push({ t: "punc", v: c });
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = "";
      while (j < n && text[j] !== '"') {
        if (text[j] === "\\" && j + 1 < n) { out += text[j + 1]; j += 2; }
        else { out += text[j]; j++; }
      }
      toks.push({ t: "str", v: out });
      i = Math.min(j + 1, n);
      continue;
    }
    if ("{}()[],;=".includes(c)) {
      toks.push({ t: "punc", v: c });
      i++;
      continue;
    }
    warnings.push(`skipping unexpected character ${JSON.stringify(c)}`);
    i++;
  }
  return toks;
}

// ---------------------------------------------------------------------------
// Recursive-descent statement parser
// ---------------------------------------------------------------------------

class Parser {
  pos = 0;
  constructor(private toks: Tok[], private warnings: string[]) { }

  peek(): Tok | null { return this.toks[this.pos] ?? null; }
  next(): Tok | null { return this.toks[this.pos++] ?? null; }
  expectPunc(v: string): boolean {
    const t = this.peek();
    if (t?.t === "punc" && t.v === v) { this.pos++; return true; }
    return false;
  }

  parseFile(): CsgNode[] {
    const out: CsgNode[] = [];
    while (this.peek()) {
      const s = this.parseStatement();
      if (s) out.push(s);
      else if (!this.next()) break; // resync past one token
    }
    return out;
  }

  parseStatement(): CsgNode | null {
    let modifier: string | null = null;
    const first = this.peek();
    if (first?.t === "punc" && (first.v === "%" || first.v === "#" || first.v === "!" || first.v === "*")) {
      modifier = first.v;
      this.pos++;
    }
    const head = this.next();
    if (!head || head.t !== "ident") return null;
    const name = head.v;
    let params: Record<string, CsgValue> = {};
    const open = this.peek();
    if (open?.t === "punc" && open.v === "(") {
      this.pos++;
      params = this.parseParams();
      if (!this.expectPunc(")")) {
        this.warnings.push(`unbalanced params on ${name} — skipping statement`);
        return null;
      }
    }
    const children: CsgNode[] = [];
    const nx = this.peek();
    if (nx?.t === "punc" && nx.v === "{") {
      this.pos++;
      while (true) {
        const c = this.peek();
        if (!c) { this.warnings.push(`unbalanced block on ${name}`); break; }
        if (c.t === "punc" && c.v === "}") { this.pos++; break; }
        const s = this.parseStatement();
        if (s) children.push(s);
        else this.next();
      }
    } else {
      this.expectPunc(";"); // terminal — tolerate a missing ;
    }
    return { name, modifier, params, children };
  }

  parseParams(): Record<string, CsgValue> {
    const out: Record<string, CsgValue> = {};
    let positional = 0;
    while (true) {
      const t = this.peek();
      if (!t) break;
      if (t.t === "punc" && (t.v === ")" || t.v === ";")) break;
      if (t.t === "punc" && t.v === ",") { this.pos++; continue; }
      if (t.t === "ident" && this.toks[this.pos + 1]?.t === "punc" && (this.toks[this.pos + 1] as { v: string }).v === "=") {
        const key = t.v;
        this.pos += 2;
        out[key] = this.parseValue();
      } else {
        out[`#${positional++}`] = this.parseValue(); // positional (rare)
      }
    }
    return out;
  }

  parseValue(): CsgValue {
    const t = this.next();
    if (!t) return null;
    if (t.t === "num") return t.v;
    if (t.t === "str") return t.v;
    if (t.t === "ident") {
      if (t.v === "true") return true;
      if (t.v === "false") return false;
      if (t.v === "undef") return null;
      return t.v;
    }
    if (t.t === "punc" && t.v === "[") {
      // Nested vectors flatten here (fine for points/vectors). Polyhedron
      // face boundaries are recovered separately (see extractPolyhedronFaces)
      // because flattening loses them. Depth-tracked so [[..],[..]] yields
      // all 16 numbers, not just the first row.
      const flat: number[] = [];
      let depth = 1;
      while (depth > 0) {
        const c = this.peek();
        if (!c) break;
        if (c.t === "punc" && c.v === "[") { depth++; this.pos++; continue; }
        if (c.t === "punc" && c.v === "]") { depth--; this.pos++; continue; }
        if (c.t === "punc" && c.v === ",") { this.pos++; continue; }
        if (c.t === "num") { flat.push(c.v); this.pos++; continue; }
        if (c.t === "ident" && (c.v === "true" || c.v === "false")) { flat.push(c.v === "true" ? 1 : 0); this.pos++; continue; }
        if (c.t === "punc" && c.v === "-") {
          this.pos++;
          const d = this.peek();
          if (d?.t === "num") { flat.push(-d.v); this.pos++; }
          continue;
        }
        this.warnings.push(`unexpected vector entry — skipping`);
        this.pos++;
      }
      return flat;
    }
    if (t.t === "punc" && t.v === "-") {
      const v = this.parseValue();
      return typeof v === "number" ? -v : v;
    }
    return null;
  }
}

/**
 * Pre-scan: nested vectors flatten in `parseValue`, which loses polyhedron
 * face boundaries. Recover `faces = [[..],[..]]` with a dedicated regex over
 * the raw text, keyed by `polyhedron(` occurrence order. A polyhedron whose
 * faces don't match is skipped kernel-side with a warning (never mis-split).
 */
function extractPolyhedronFaces(text: string): number[][][] {
  const out: number[][][] = [];
  // The outer faces=[...] holds one [...] row per face (no deeper nesting),
  // so match rows repeatedly inside the outer bracket pair. `triangles=` and
  // `polygons=` are accepted spellings of the same parameter (deprecated /
  // alternate OpenSCAD forms) — without them a faceless polyhedron would
  // consume another node's group below (see parseCsg's splice).
  const re = /polyhedron\s*\([\s\S]*?(?:faces|triangles|polygons)\s*=\s*\[((?:\s*\[[^\[\]]*\]\s*,?)+)\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const inner = m[1];
    const faces: number[][] = [];
    const rowRe = /\[([^\[\]]*)\]/g;
    let r: RegExpExecArray | null;
    while ((r = rowRe.exec(inner)) !== null) {
      const nums = r[1].split(",").map((s) => parseInt(s.trim(), 10)).filter((x) => Number.isFinite(x));
      if (nums.length >= 3) faces.push(nums);
    }
    out.push(faces);
  }
  return out;
}

export function parseCsg(text: string, options: CsgParseOptions = {}): CsgParseResult {
  const warnings: string[] = [];
  const useMaxFN = options.useMaxFN ?? DEFAULT_USE_MAX_FN;
  if (text.length > MAX_CSG_BYTES) {
    return { roots: [], warnings: ["refusing .csg over 10MB — likely machine-generated; split it first"], useMaxFN };
  }
  if (text.trim() === "") return { roots: [], warnings: ["empty .csg file — nothing to import"], useMaxFN };
  const faceGroups = extractPolyhedronFaces(text);
  const toks = tokenize(text, warnings);
  const roots = new Parser(toks, warnings).parseFile();
  if (roots.length === 0) return { roots: [], warnings: [...warnings, "no statements parsed — nothing to import"], useMaxFN };

  let polyCount = 0;
  const splice = (nodes: CsgNode[]): void => {
    for (const nd of nodes) {
      if (nd.name === "polyhedron") {
        // Only a polyhedron that actually DECLARES faces consumes a
        // pre-scanned group — otherwise occurrence order would misalign and
        // one node's faces would land on another's (a faceless polyhedron is
        // skipped kernel-side anyway, with a warning, never mis-built).
        if ("faces" in nd.params || "triangles" in nd.params || "polygons" in nd.params) {
          const g = faceGroups[polyCount++];
          if (g && g.length >= 4) nd.faces = g;
        }
      }
      if (nd.children.length > 0) splice(nd.children);
    }
  };
  splice(roots);
  return { roots, warnings, useMaxFN };
}

/** Test-only escape hatch. */
export const _test = { tokenize, Parser, resolveSegments, extractPolyhedronFaces };
