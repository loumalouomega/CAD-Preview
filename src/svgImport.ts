/**
 * SVG path import — roadmap "SVG import → profile ops", closed, then widened
 * for "3D text via outline import". Pure, vscode/DOM-free (no `DOMParser`/
 * `document` — this project's vitest config has no jsdom, so a small
 * tag-stream tokenizer + regex-based attribute extraction, rather than a
 * real XML parser, is what keeps this module unit-testable headless,
 * matching the roadmap item's own framing: "a pure-TypeScript path parser,
 * testable without the WASM").
 *
 * Genuinely no new kernel surface: the output is a plain list of flattened
 * 2D polylines, fed into the EXISTING `addPolyline` edit op (`{points:
 * Vec3[], closed: boolean}`, already "straight edges through points in
 * order" per its own doc comment in `editOps.ts`) by the webview wiring
 * (`main.ts`) and the `import_svg` MCP tool — this module never touches
 * OCCT or the mesh engine.
 *
 * **Scope, stated plainly, not a silent gap**: `parseSvgDocument()` walks
 * `<path>`, `<rect>` (rounded corners included), `<circle>`, `<ellipse>`,
 * `<line>`, `<polyline>`, `<polygon>`, and composes every ancestor's `transform`
 * attribute (`matrix`/`translate`/`scale`/`rotate`/`skewX`/`skewY`, the full
 * SVG transform-list grammar) with each element's own — this is what makes a
 * real Inkscape/Illustrator "convert text to outlines" export (which nearly
 * always wraps the traced glyphs in one or more `<g transform="...">`
 * groups) import at the right position and scale, not the raw-untransformed
 * coordinates an earlier version of this module produced. `<defs>`/
 * `<clipPath>`/`<mask>`/`<symbol>`/`<marker>`/`<pattern>` subtrees are
 * skipped entirely (their content is template geometry, not drawn shapes);
 * `<use>` and `<text>` are recognized and produce a collected `warnings`
 * entry rather than silently importing nothing or mis-tracing — a `<use>`'s
 * referenced content is never dereferenced, and `<text>`'s own glyph
 * outlines aren't in the file at all (the warning says to convert text to
 * outlines/paths first, e.g. Inkscape's Path ▸ Object to Path). Any other
 * unrecognized element (a raster `<image>`, `<foreignObject>`, …)
 * contributes no geometry and no warning — it's simply not a shape.
 * Bezier/arc curves (and rounded-rect corners) are flattened into straight
 * line segments at a fixed sample count — `addPolyline` has no curved-edge
 * representation, so exact curve fidelity was never on the table regardless
 * of parser effort.
 */

export interface SvgSubpath {
  /** 2D points in the SVG document's own coordinate space (Y-down, as SVG
   * defines it) — `main.ts` is responsible for flipping Y and choosing a
   * placement plane/scale before building `addPolyline` ops from these. */
  points: [number, number][];
  /** True when the subpath had an explicit `Z`/`z` close command. */
  closed: boolean;
}

const PATH_ELEMENT_RE = /<path\b[^>]*\bd\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;

/** Extracts every `<path>` element's raw `d` attribute value, in document order. */
export function extractPathData(svgText: string): string[] {
  const out: string[] = [];
  PATH_ELEMENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_ELEMENT_RE.exec(svgText)) !== null) {
    out.push(m[1] ?? m[2] ?? "");
  }
  return out;
}

/** Bezier/arc flattening resolution — straight-segment count per curve. Fixed
 * rather than adaptive (arc-length/curvature based) for simplicity; a
 * `addPolyline` result has no curved-edge representation to be more exact
 * FOR, so a uniform sample count is a reasonable, simple default. */
const CURVE_SEGMENTS = 16;

type Point = [number, number];

/** Tokenizes and interprets one path's `d` attribute into flattened
 * subpaths. Supports M/m L/l H/h V/v C/c S/s Q/q T/t A/a Z/z — the
 * complete SVG path command set actually used by real path data (the other
 * SVG shape ELEMENTS — rect/circle/etc. — are out of scope, see the module
 * doc comment, but every command a `<path>` itself can contain is handled). */
export function parsePathData(d: string): SvgSubpath[] {
  const tokens = tokenize(d);
  const subpaths: SvgSubpath[] = [];
  let points: Point[] = [];
  let closed = false;
  let cur: Point = [0, 0];
  let start: Point = [0, 0];
  let prevControl: Point | null = null; // reflected control point for S/T shorthand
  let prevCommand = "";

  const flush = () => {
    if (points.length > 0) subpaths.push({ points, closed });
    points = [];
    closed = false;
  };

  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i] as string;
    i++;
    const isRelative = cmd === cmd.toLowerCase();
    const upper = cmd.toUpperCase();

    const nextNum = (): number => {
      const v = Number(tokens[i]);
      i++;
      return v;
    };
    const resolve = (x: number, y: number): Point => (isRelative ? [cur[0] + x, cur[1] + y] : [x, y]);

    switch (upper) {
      case "M": {
        flush();
        cur = resolve(nextNum(), nextNum());
        start = cur;
        points.push(cur);
        // Subsequent coordinate pairs with no repeated command letter are
        // implicit `L`/`l` commands, per the SVG spec.
        while (i < tokens.length && isNumericToken(tokens[i])) {
          cur = resolve(nextNum(), nextNum());
          points.push(cur);
        }
        break;
      }
      case "L": {
        do {
          cur = resolve(nextNum(), nextNum());
          points.push(cur);
        } while (i < tokens.length && isNumericToken(tokens[i]));
        break;
      }
      case "H": {
        do {
          const x = isRelative ? cur[0] + nextNum() : nextNum();
          cur = [x, cur[1]];
          points.push(cur);
        } while (i < tokens.length && isNumericToken(tokens[i]));
        break;
      }
      case "V": {
        do {
          const y = isRelative ? cur[1] + nextNum() : nextNum();
          cur = [cur[0], y];
          points.push(cur);
        } while (i < tokens.length && isNumericToken(tokens[i]));
        break;
      }
      case "C": {
        do {
          const p1 = resolve(nextNum(), nextNum());
          const p2 = resolve(nextNum(), nextNum());
          const p3 = resolve(nextNum(), nextNum());
          points.push(...sampleCubic(cur, p1, p2, p3));
          prevControl = p2;
          cur = p3;
        } while (i < tokens.length && isNumericToken(tokens[i]));
        break;
      }
      case "S": {
        do {
          const p1 = reflectControl(cur, prevControl, prevCommand, "CS");
          const p2 = resolve(nextNum(), nextNum());
          const p3 = resolve(nextNum(), nextNum());
          points.push(...sampleCubic(cur, p1, p2, p3));
          prevControl = p2;
          cur = p3;
          prevCommand = upper;
        } while (i < tokens.length && isNumericToken(tokens[i]));
        break;
      }
      case "Q": {
        do {
          const p1 = resolve(nextNum(), nextNum());
          const p2 = resolve(nextNum(), nextNum());
          points.push(...sampleQuadratic(cur, p1, p2));
          prevControl = p1;
          cur = p2;
        } while (i < tokens.length && isNumericToken(tokens[i]));
        break;
      }
      case "T": {
        do {
          const p1 = reflectControl(cur, prevControl, prevCommand, "QT");
          const p2 = resolve(nextNum(), nextNum());
          points.push(...sampleQuadratic(cur, p1, p2));
          prevControl = p1;
          cur = p2;
          prevCommand = upper;
        } while (i < tokens.length && isNumericToken(tokens[i]));
        break;
      }
      case "A": {
        do {
          const rx = nextNum();
          const ry = nextNum();
          const xAxisRotDeg = nextNum();
          const largeArc = nextNum() !== 0;
          const sweep = nextNum() !== 0;
          const end = resolve(nextNum(), nextNum());
          points.push(...sampleArc(cur, rx, ry, xAxisRotDeg, largeArc, sweep, end));
          cur = end;
        } while (i < tokens.length && isNumericToken(tokens[i]));
        break;
      }
      case "Z": {
        cur = start;
        closed = true;
        flush();
        break;
      }
      default:
        // Unknown command — skip its one presumed coordinate-pair-like token
        // set is unsafe to guess; bail out of this path entirely rather
        // than risk silently misinterpreting the rest of the stream.
        i = tokens.length;
        break;
    }
    // Curve-control reflection (S/T shorthand) only looks back at an
    // IMMEDIATELY preceding C/S or Q/T — anything else resets it to "no
    // reflection available," matching the SVG spec's own rule. C/S/Q/T
    // already set `prevControl` to the right point inside their own case
    // above; every other command must clear it here.
    if (!"CSQT".includes(upper)) prevControl = null;
    prevCommand = upper;
  }
  flush();
  return subpaths;
}

/**
 * Placement options shared by every SVG import call site — the interactive
 * webview import (`main.ts`'s `importSvgPaths`) and the `import_svg` MCP
 * tool — so the two can never drift apart on what "import this SVG" means.
 */
export interface SvgPlacementOptions {
  /** Uniform scale applied AFTER the Y-flip (default 1). */
  scale?: number;
  /** World-space `[x,y,z]` offset applied after scaling (default `[0,0,0]`). */
  origin?: [number, number, number];
}

/** One subpath, already flattened, Y-flipped, scaled and offset — the exact
 * shape an `addPolyline` op's `points`/`closed` fields need, minus the `op`
 * tag itself (left to each caller, since one lives in the webview and the
 * other in the MCP server, with no shared `EditOp` import worth forcing on
 * this otherwise kernel-free module). */
export interface SvgPolylinePlacement {
  points: [number, number, number][];
  closed: boolean;
}

function pointsEqual3(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * Converts parsed SVG subpaths into placed 3D polylines — SVG's Y axis
 * points DOWN; every other coordinate this codebase ever shows the user
 * (view axes, typed op fields, …) is Y-up, so Y is negated on the way in.
 * Imports flat into the XY plane at `origin`'s z (0 by default), 1 SVG user
 * unit = 1mm × `scale` (this codebase's cascade unit) — a deliberate, simple
 * default matching how Inkscape/Illustrator "trace outline" exports are
 * typically already sized for downstream CAD use; a poorly-scaled/-placed
 * import can be fixed afterward with the EXISTING `translate`/`scale` ops,
 * same as any other placement adjustment.
 *
 * Degenerate subpaths (fewer than 2 points; fewer than 3 for a closed one,
 * or a closed one whose first/last point are exactly equal after the flip)
 * are silently skipped rather than returning a shape `validateEditOp` would
 * reject anyway — same graceful-degradation rule as every other import path
 * in this codebase.
 */
export function svgSubpathsToPolylineOps(subpaths: SvgSubpath[], options?: SvgPlacementOptions): SvgPolylinePlacement[] {
  const scale = options?.scale ?? 1;
  const [ox, oy, oz] = options?.origin ?? [0, 0, 0];
  const out: SvgPolylinePlacement[] = [];
  for (const sub of subpaths) {
    const points: [number, number, number][] = sub.points.map(([x, y]) => [x * scale + ox, -y * scale + oy, oz]);
    if (points.length < 2) continue;
    if (sub.closed && (points.length < 3 || pointsEqual3(points[0], points[points.length - 1]))) continue;
    out.push({ points, closed: sub.closed });
  }
  return out;
}

/** Parses every `<path>` in an SVG document into flattened subpaths — a
 * compatibility wrapper over {@link parseSvgDocument} that drops its
 * `warnings` and (since that function now also walks `<rect>`/`<circle>`/…
 * and composes `transform` attributes) is a strict superset of what this
 * function originally did for a plain `<path>`-only, transform-free SVG. */
export function parseSvgPaths(svgText: string): SvgSubpath[] {
  return parseSvgDocument(svgText).subpaths;
}

export interface SvgParseResult {
  subpaths: SvgSubpath[];
  /** Human-readable notes about content this parser recognized but could not
   * trace (`<use>`, `<text>`) — never a parse failure, since a malformed or
   * unsupported document still degrades to whatever WAS extractable. */
  warnings: string[];
}

/** A 2D affine transform as SVG's own `matrix(a,b,c,d,e,f)` six numbers:
 * `x' = a*x + c*y + e`, `y' = b*x + d*y + f`. */
type Mat = [number, number, number, number, number, number];
const IDENTITY_MAT: Mat = [1, 0, 0, 1, 0, 0];

/** `outer ∘ inner` — the matrix that applies `inner` first, then `outer`. */
function matMultiply(outer: Mat, inner: Mat): Mat {
  const [a1, b1, c1, d1, e1, f1] = inner;
  const [a2, b2, c2, d2, e2, f2] = outer;
  return [
    a2 * a1 + c2 * b1,
    b2 * a1 + d2 * b1,
    a2 * c1 + c2 * d1,
    b2 * c1 + d2 * d1,
    a2 * e1 + c2 * f1 + e2,
    b2 * e1 + d2 * f1 + f2,
  ];
}

function matApply(m: Mat, [x, y]: Point): Point {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * Parses one element's `transform` attribute value into a single composed
 * matrix — the full SVG transform-list grammar (`matrix`/`translate`/
 * `scale`/`rotate`/`skewX`/`skewY`, space- or comma-separated functions
 * applied left-to-right as the spec requires, i.e. the RIGHTMOST function in
 * the list is applied to a point first). An unrecognized function name, or
 * one with the wrong argument count, contributes the identity rather than
 * throwing — same graceful-degradation rule as the rest of this module.
 */
function parseTransformAttr(value: string): Mat {
  let m: Mat = IDENTITY_MAT;
  const fnRe = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
  let fm: RegExpExecArray | null;
  while ((fm = fnRe.exec(value)) !== null) {
    const fn = fm[1].toLowerCase();
    const args = fm[2]
      .trim()
      .split(/[\s,]+/)
      .filter((s) => s.length > 0)
      .map(Number);
    let t: Mat = IDENTITY_MAT;
    switch (fn) {
      case "matrix":
        if (args.length === 6 && args.every(Number.isFinite)) t = args as Mat;
        break;
      case "translate": {
        const [tx, ty] = args;
        if (Number.isFinite(tx)) t = [1, 0, 0, 1, tx, Number.isFinite(ty) ? ty : 0];
        break;
      }
      case "scale": {
        const [sx, sy] = args;
        if (Number.isFinite(sx)) t = [sx, 0, 0, Number.isFinite(sy) ? sy : sx, 0, 0];
        break;
      }
      case "rotate": {
        const [deg, cx, cy] = args;
        if (!Number.isFinite(deg)) break;
        const rad = (deg * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const rot: Mat = [cos, sin, -sin, cos, 0, 0];
        t = Number.isFinite(cx) && Number.isFinite(cy)
          ? matMultiply(matMultiply([1, 0, 0, 1, cx, cy], rot), [1, 0, 0, 1, -cx, -cy])
          : rot;
        break;
      }
      case "skewx": {
        const [deg] = args;
        if (Number.isFinite(deg)) t = [1, 0, Math.tan((deg * Math.PI) / 180), 1, 0, 0];
        break;
      }
      case "skewy": {
        const [deg] = args;
        if (Number.isFinite(deg)) t = [1, Math.tan((deg * Math.PI) / 180), 0, 1, 0, 0];
        break;
      }
      default:
        break;
    }
    m = matMultiply(m, t);
  }
  return m;
}

/** Extracts one `name="..."`/`name='...'` attribute's raw string value from a
 * tag's attribute text, or `undefined` if absent. Fixed, internally-authored
 * attribute names only — never built from untrusted input. */
function attrValue(attrs: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const m = attrs.match(re);
  if (!m) return undefined;
  return m[1] ?? m[2];
}

function attrNum(attrs: string, name: string, fallback: number): number {
  const raw = attrValue(attrs, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Elements whose entire subtree is template/reference geometry, never drawn
 * directly — skipped wholesale rather than mis-traced. */
const SKIP_SUBTREE_TAGS = new Set(["defs", "clippath", "mask", "symbol", "marker", "pattern"]);

function rectSubpaths(attrs: string): SvgSubpath[] {
  const x = attrNum(attrs, "x", 0);
  const y = attrNum(attrs, "y", 0);
  const width = attrNum(attrs, "width", 0);
  const height = attrNum(attrs, "height", 0);
  if (!(width > 0) || !(height > 0)) return [];
  const hasRx = attrValue(attrs, "rx") !== undefined;
  const hasRy = attrValue(attrs, "ry") !== undefined;
  let rx = hasRx ? attrNum(attrs, "rx", 0) : hasRy ? attrNum(attrs, "ry", 0) : 0;
  let ry = hasRy ? attrNum(attrs, "ry", 0) : hasRx ? attrNum(attrs, "rx", 0) : 0;
  rx = Math.min(Math.max(rx, 0), width / 2);
  ry = Math.min(Math.max(ry, 0), height / 2);
  if (!(rx > 0) || !(ry > 0)) {
    return [{ points: [[x, y], [x + width, y], [x + width, y + height], [x, y + height]], closed: true }];
  }
  // A quarter-ellipse per corner (CCW-in-SVG-Y-down winding), sampled the
  // same way an SVG `A` command's own arc-flattening would.
  const quarter = (cx: number, cy: number, from: number, to: number): Point[] => {
    const out: Point[] = [];
    for (let s = 1; s <= CURVE_SEGMENTS; s++) {
      const t = from + ((to - from) * s) / CURVE_SEGMENTS;
      out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
    }
    return out;
  };
  const points: Point[] = [
    [x + rx, y],
    [x + width - rx, y],
    ...quarter(x + width - rx, y + ry, -Math.PI / 2, 0),
    [x + width, y + height - ry],
    ...quarter(x + width - rx, y + height - ry, 0, Math.PI / 2),
    [x + rx, y + height],
    ...quarter(x + rx, y + height - ry, Math.PI / 2, Math.PI),
    [x, y + ry],
    ...quarter(x + rx, y + ry, Math.PI, (3 * Math.PI) / 2),
  ];
  return [{ points, closed: true }];
}

function ellipsePoints(cx: number, cy: number, rx: number, ry: number): Point[] {
  const n = CURVE_SEGMENTS * 2;
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return pts;
}

function circleSubpaths(attrs: string): SvgSubpath[] {
  const cx = attrNum(attrs, "cx", 0);
  const cy = attrNum(attrs, "cy", 0);
  const r = attrNum(attrs, "r", 0);
  return r > 0 ? [{ points: ellipsePoints(cx, cy, r, r), closed: true }] : [];
}

function ellipseSubpaths(attrs: string): SvgSubpath[] {
  const cx = attrNum(attrs, "cx", 0);
  const cy = attrNum(attrs, "cy", 0);
  const rx = attrNum(attrs, "rx", 0);
  const ry = attrNum(attrs, "ry", 0);
  return rx > 0 && ry > 0 ? [{ points: ellipsePoints(cx, cy, rx, ry), closed: true }] : [];
}

function lineSubpaths(attrs: string): SvgSubpath[] {
  const x1 = attrNum(attrs, "x1", 0);
  const y1 = attrNum(attrs, "y1", 0);
  const x2 = attrNum(attrs, "x2", 0);
  const y2 = attrNum(attrs, "y2", 0);
  return [{ points: [[x1, y1], [x2, y2]], closed: false }];
}

function polyPointsAttr(attrs: string): Point[] {
  const raw = attrValue(attrs, "points");
  if (!raw) return [];
  const nums = raw
    .trim()
    .split(/[\s,]+/)
    .filter((s) => s.length > 0)
    .map(Number);
  const pts: Point[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    if (Number.isFinite(nums[i]) && Number.isFinite(nums[i + 1])) pts.push([nums[i], nums[i + 1]]);
  }
  return pts;
}

function polylineSubpaths(attrs: string, closed: boolean): SvgSubpath[] {
  const pts = polyPointsAttr(attrs);
  return pts.length >= 2 ? [{ points: pts, closed }] : [];
}

/**
 * Walks an SVG document as a flat stream of tags (open/close/self-closing —
 * no real XML/DOM parser, per this module's own doc comment), tracking an
 * ancestor-transform stack and a skip-subtree stack, and returns every
 * recognized shape element's points in WORLD (document) space, plus any
 * warnings about content it recognized but could not trace.
 */
export function parseSvgDocument(svgText: string): SvgParseResult {
  const cleaned = svgText.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  const subpaths: SvgSubpath[] = [];
  const warnings: string[] = [];
  const seenWarnings = new Set<string>();
  const warnOnce = (msg: string): void => {
    if (!seenWarnings.has(msg)) {
      seenWarnings.add(msg);
      warnings.push(msg);
    }
  };

  const transformStack: Mat[] = [IDENTITY_MAT];
  const skipStack: string[] = [];

  const tagRe = /<(\/)?([A-Za-z_][\w:-]*)([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(cleaned)) !== null) {
    const closing = m[1] === "/";
    const rawName = m[2];
    const name = rawName.includes(":") ? (rawName.split(":").pop() as string) : rawName;
    const lower = name.toLowerCase();
    const rawInner = m[3] ?? "";
    const selfClosing = !closing && /\/\s*$/.test(rawInner);
    const attrs = selfClosing ? rawInner.replace(/\/\s*$/, "") : rawInner;

    if (skipStack.length > 0) {
      if (!selfClosing) {
        if (closing) {
          if (skipStack[skipStack.length - 1] === lower) skipStack.pop();
        } else if (lower === skipStack[skipStack.length - 1]) {
          skipStack.push(lower); // same tag nested inside its own skipped subtree
        }
      }
      continue;
    }

    if (closing) {
      if (transformStack.length > 1) transformStack.pop();
      continue;
    }

    if (SKIP_SUBTREE_TAGS.has(lower)) {
      if (!selfClosing) skipStack.push(lower);
      continue;
    }

    if (lower === "use") {
      warnOnce("<use> elements are not supported — their referenced content is not traced.");
      if (!selfClosing) skipStack.push(lower);
      continue;
    }

    if (lower === "text") {
      warnOnce("<text> elements are not supported — convert text to outlines/paths first (e.g. Inkscape's Path ▸ Object to Path).");
      if (!selfClosing) skipStack.push(lower);
      continue;
    }

    const ownAttr = attrValue(attrs, "transform");
    const cumulative = ownAttr
      ? matMultiply(transformStack[transformStack.length - 1], parseTransformAttr(ownAttr))
      : transformStack[transformStack.length - 1];

    let local: SvgSubpath[] = [];
    switch (lower) {
      case "path": {
        const d = attrValue(attrs, "d");
        if (d) local = parsePathData(d);
        break;
      }
      case "rect":
        local = rectSubpaths(attrs);
        break;
      case "circle":
        local = circleSubpaths(attrs);
        break;
      case "ellipse":
        local = ellipseSubpaths(attrs);
        break;
      case "line":
        local = lineSubpaths(attrs);
        break;
      case "polyline":
        local = polylineSubpaths(attrs, false);
        break;
      case "polygon":
        local = polylineSubpaths(attrs, true);
        break;
      default:
        break;
    }
    for (const sub of local) {
      subpaths.push({ points: sub.points.map((p) => matApply(cumulative, p)), closed: sub.closed });
    }

    if (!selfClosing) transformStack.push(cumulative);
  }

  return { subpaths, warnings };
}

function isNumericToken(t: string): boolean {
  return /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t);
}

/** Splits path data into command-letter and numeric tokens — numbers may run
 * together with no separator (`1.5.5` means `1.5` then `.5`, a real SVG
 * authoring quirk) or be separated by commas/whitespace/a leading minus
 * acting as its own separator; this regex-based scan handles all three. */
function tokenize(d: string): string[] {
  const tokens: string[] = [];
  const re = /[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.\d+|\.\d+|\d+)(?:[eE][-+]?\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) tokens.push(m[0]);
  return tokens;
}

function reflectControl(cur: Point, prevControl: Point | null, prevCommand: string, allowedPrev: string): Point {
  if (!prevControl || !allowedPrev.includes(prevCommand)) return cur;
  return [2 * cur[0] - prevControl[0], 2 * cur[1] - prevControl[1]];
}

function lerp(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function sampleCubic(p0: Point, p1: Point, p2: Point, p3: Point): Point[] {
  const out: Point[] = [];
  for (let s = 1; s <= CURVE_SEGMENTS; s++) {
    const t = s / CURVE_SEGMENTS;
    const a = lerp(p0, p1, t);
    const b = lerp(p1, p2, t);
    const c = lerp(p2, p3, t);
    const d = lerp(a, b, t);
    const e = lerp(b, c, t);
    out.push(lerp(d, e, t));
  }
  return out;
}

function sampleQuadratic(p0: Point, p1: Point, p2: Point): Point[] {
  const out: Point[] = [];
  for (let s = 1; s <= CURVE_SEGMENTS; s++) {
    const t = s / CURVE_SEGMENTS;
    const a = lerp(p0, p1, t);
    const b = lerp(p1, p2, t);
    out.push(lerp(a, b, t));
  }
  return out;
}

/** SVG elliptical-arc endpoint-to-centre parameterization, per SVG spec
 * Appendix F.6.5 — converts the (start, rx, ry, x-axis-rotation, large-arc,
 * sweep, end) endpoint form into a centre + angle range, then samples it
 * uniformly. A degenerate arc (rx or ry ~0, or start≈end) degrades to a
 * straight line rather than dividing by zero. */
function sampleArc(start: Point, rx: number, ry: number, xAxisRotDeg: number, largeArc: boolean, sweep: boolean, end: Point): Point[] {
  if (Math.abs(rx) < 1e-9 || Math.abs(ry) < 1e-9 || (start[0] === end[0] && start[1] === end[1])) {
    return [end];
  }
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (xAxisRotDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx2 = (start[0] - end[0]) / 2;
  const dy2 = (start[1] - end[1]) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  // Correct out-of-range radii (spec F.6.6).
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const sign = largeArc !== sweep ? 1 : -1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * (rx * y1p)) / ry;
  const cyp = (coef * -(ry * x1p)) / rx;

  const cx = cosPhi * cxp - sinPhi * cyp + (start[0] + end[0]) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (start[1] + end[1]) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const sgn = ux * vy - uy * vx < 0 ? -1 : 1;
    const dot = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy))));
    return sgn * Math.acos(dot);
  };

  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const out: Point[] = [];
  for (let s = 1; s <= CURVE_SEGMENTS; s++) {
    const t = theta1 + (dTheta * s) / CURVE_SEGMENTS;
    const x = cx + rx * Math.cos(t) * cosPhi - ry * Math.sin(t) * sinPhi;
    const y = cy + rx * Math.cos(t) * sinPhi + ry * Math.sin(t) * cosPhi;
    out.push([x, y]);
  }
  // Exact endpoint, not the last sampled approximation — avoids float drift.
  out[out.length - 1] = end;
  return out;
}
