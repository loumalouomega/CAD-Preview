/**
 * SVG path import — roadmap "SVG import → profile ops", closed. Pure,
 * vscode/DOM-free (no `DOMParser`/`document` — this project's vitest config
 * has no jsdom, so parsing the SVG's own `<path d="...">` attributes via a
 * small regex-based extraction, rather than a real XML parser, is what
 * keeps this module unit-testable headless, matching the roadmap item's own
 * framing: "a pure-TypeScript path parser, testable without the WASM").
 *
 * Genuinely no new kernel surface: the output is a plain list of flattened
 * 2D polylines, fed into the EXISTING `addPolyline` edit op (`{points:
 * Vec3[], closed: boolean}`, already "straight edges through points in
 * order" per its own doc comment in `editOps.ts`) by the webview wiring
 * (`main.ts`) — this module never touches OCCT or the mesh engine.
 *
 * **Scope, stated plainly, not a silent gap**: only `<path d="...">`
 * elements are read — no `<rect>`/`<circle>`/`<ellipse>`/`<polygon>`/
 * `<polyline>` primitive shapes, and no `transform` attribute support (a
 * path drawn under a `translate`/`scale`/`rotate`/`matrix` transform
 * imports at its RAW, untransformed coordinates). Real-world Inkscape/
 * Illustrator "trace outline" exports overwhelmingly use `<path>` with no
 * transform on the traced element itself, which is the case this targets;
 * anything else silently imports at the wrong position/shape rather than
 * failing loudly, so this is worth restating here for future maintenance.
 * Bezier/arc curves are flattened into straight line segments at a fixed
 * sample count — `addPolyline` has no curved-edge representation, so exact
 * curve fidelity was never on the table regardless of parser effort.
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

/** Parses every `<path>` in an SVG document into flattened subpaths. */
export function parseSvgPaths(svgText: string): SvgSubpath[] {
  return extractPathData(svgText).flatMap(parsePathData);
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
