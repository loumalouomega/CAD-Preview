/**
 * Arithmetic-expression evaluator for parametric edit-op fields, plus the
 * field-path addressing used to patch evaluated numbers back into an op. Pure
 * and vscode/DOM-free so it unit-tests headless and is imported by both the
 * host (sidecar parsing) and the webview (input parsing, resolve-on-read).
 *
 * Hand-written recursive descent — webview CSP blocks `eval()`, and we want a
 * closed grammar anyway: numbers, variable identifiers, `+ - * / ^`, unary
 * minus, parentheses, and a small fixed function/constant set. Trig works in
 * DEGREES to match every angle field in the op model (`angleDeg` etc.).
 */

export type EvalResult = { ok: true; value: number } | { ok: false; error: string };

/** Functions callable in expressions. Trig is degree-based (op angles are `*Deg`). */
const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sin: (d) => Math.sin((d * Math.PI) / 180),
  cos: (d) => Math.cos((d * Math.PI) / 180),
  tan: (d) => Math.tan((d * Math.PI) / 180),
};

const CONSTANTS: Record<string, number> = { pi: Math.PI };

const RESERVED = new Set([...Object.keys(FUNCTIONS), ...Object.keys(CONSTANTS)]);

/** A legal user variable name: identifier-shaped and not a reserved function/constant. */
export function isValidVariableName(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !RESERVED.has(s);
}

type Token =
  | { kind: "num"; value: number }
  | { kind: "ident"; name: string }
  | { kind: "punct"; ch: string };

/** Tokenize `src`; returns null on any illegal character or malformed number. */
function tokenize(src: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t") { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) return null;
      const value = Number(m[0]);
      if (!Number.isFinite(value)) return null;
      tokens.push({ kind: "num", value });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      tokens.push({ kind: "ident", name: m[0] });
      i += m[0].length;
      continue;
    }
    if ("+-*/^(),".includes(c)) {
      tokens.push({ kind: "punct", ch: c });
      i++;
      continue;
    }
    return null;
  }
  return tokens;
}

/**
 * Parser/evaluator over the token stream. In `syntaxOnly` mode unknown
 * identifiers evaluate as 0 and no lookup errors are raised — used to accept
 * an expression whose variables may only be defined later.
 */
class Parser {
  private pos = 0;
  constructor(
    private tokens: Token[],
    private vars: Record<string, number>,
    private syntaxOnly: boolean,
    private idents: Set<string> | null = null
  ) {}

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private isPunct(ch: string): boolean {
    const t = this.peek();
    return !!t && t.kind === "punct" && t.ch === ch;
  }
  private fail(msg: string): never { throw new Error(msg); }

  parse(): number {
    const v = this.expr();
    if (this.pos !== this.tokens.length) this.fail("unexpected trailing input");
    return v;
  }

  private expr(): number {
    let v = this.term();
    while (this.isPunct("+") || this.isPunct("-")) {
      const op = (this.tokens[this.pos++] as { ch: string }).ch;
      const rhs = this.term();
      v = op === "+" ? v + rhs : v - rhs;
    }
    return v;
  }

  private term(): number {
    let v = this.factor();
    while (this.isPunct("*") || this.isPunct("/")) {
      const op = (this.tokens[this.pos++] as { ch: string }).ch;
      const rhs = this.factor();
      v = op === "*" ? v * rhs : v / rhs;
    }
    return v;
  }

  private factor(): number {
    if (this.isPunct("-") || this.isPunct("+")) {
      const op = (this.tokens[this.pos++] as { ch: string }).ch;
      const v = this.factor();
      return op === "-" ? -v : v;
    }
    let v = this.primary();
    if (this.isPunct("^")) {
      this.pos++;
      v = Math.pow(v, this.factor()); // right-associative: 2^3^2 = 2^9
    }
    return v;
  }

  private primary(): number {
    const t = this.peek();
    if (!t) this.fail("unexpected end of expression");
    if (t.kind === "num") { this.pos++; return t.value; }
    if (t.kind === "punct" && t.ch === "(") {
      this.pos++;
      const v = this.expr();
      if (!this.isPunct(")")) this.fail("missing ')'");
      this.pos++;
      return v;
    }
    if (t.kind === "ident") {
      this.pos++;
      if (this.isPunct("(")) {
        const fn = FUNCTIONS[t.name];
        if (!fn) this.fail(`unknown function '${t.name}'`);
        this.pos++;
        const args: number[] = [this.expr()];
        while (this.isPunct(",")) { this.pos++; args.push(this.expr()); }
        if (!this.isPunct(")")) this.fail("missing ')'");
        this.pos++;
        return fn(...args);
      }
      if (t.name in CONSTANTS) return CONSTANTS[t.name];
      this.idents?.add(t.name);
      if (t.name in this.vars) return this.vars[t.name];
      if (this.syntaxOnly) return 0;
      this.fail(`unknown variable '${t.name}'`);
    }
    this.fail(`unexpected '${(t as { ch: string }).ch}'`);
  }
}

/** Evaluate `src` against `vars`. A non-finite result (div by zero, sqrt(-1)) is an error. */
export function evalExpr(src: string, vars: Record<string, number>): EvalResult {
  const tokens = tokenize(src);
  if (!tokens) return { ok: false, error: "invalid character in expression" };
  if (tokens.length === 0) return { ok: false, error: "empty expression" };
  try {
    const value = new Parser(tokens, vars, false).parse();
    if (!Number.isFinite(value)) return { ok: false, error: "expression is not a finite number" };
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Whether `src` is syntactically valid — unknown identifiers are allowed. */
export function parseExprSyntax(src: string): boolean {
  const tokens = tokenize(src);
  if (!tokens || tokens.length === 0) return false;
  try {
    new Parser(tokens, {}, true).parse();
    return true;
  } catch {
    return false;
  }
}

/** The variable identifiers referenced by `src` (functions/constants excluded); [] if unparseable. */
export function extractIdentifiers(src: string): string[] {
  const tokens = tokenize(src);
  if (!tokens) return [];
  const idents = new Set<string>();
  try {
    new Parser(tokens, {}, true, idents).parse();
  } catch {
    return [];
  }
  return [...idents];
}

// ---------------------------------------------------------------------------
// Field-path addressing — how an `exprs` entry names the numeric slot it
// drives: `length`, `size[1]`, `points[2][0]`. Kept here (not editVariables)
// so editOps can sanitize paths without a module cycle.
// ---------------------------------------------------------------------------

export type FieldPath = Array<string | number>;

/**
 * Parse `name`, `name[i]`, or `name[i][j]` into path segments. The key regex
 * deliberately excludes `_` (no real op field uses it), which also rules out
 * `__proto__`-style prototype pollution through a hand-edited sidecar.
 */
export function parseFieldPath(path: string): FieldPath | null {
  const m = /^([A-Za-z][A-Za-z0-9]*)((?:\[\d+\]){0,2})$/.exec(path);
  if (!m) return null;
  const segs: FieldPath = [m[1]];
  for (const idx of m[2].matchAll(/\[(\d+)\]/g)) segs.push(Number(idx[1]));
  return segs;
}

/** The finite number at `path` in `op`, or null if the slot doesn't hold one. */
export function getNumericField(op: unknown, path: FieldPath): number | null {
  let cur: unknown = op;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return null;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return typeof cur === "number" && Number.isFinite(cur) ? cur : null;
}

/** Write `value` at `path` in `op` only if the slot currently holds a finite number. */
export function setNumericField(op: unknown, path: FieldPath, value: number): boolean {
  if (getNumericField(op, path) === null) return false;
  let cur = op as Record<string | number, unknown>;
  for (const seg of path.slice(0, -1)) cur = cur[seg] as Record<string | number, unknown>;
  cur[path[path.length - 1]] = value;
  return true;
}
