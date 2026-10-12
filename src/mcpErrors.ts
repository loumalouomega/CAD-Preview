/**
 * Coded MCP tool errors and unknown-parameter warnings (pure — no MCP SDK,
 * no WASM, no vscode).
 *
 * A thrown tool error used to reach an agent as prose only, so it had to
 * guess whether to retry the same call, change its input, or change the
 * model. {@link classifyToolError} maps an error to a stable
 * `{code, message, hint?, retryable}` that `mcpServer.ts`'s `wrap()` returns
 * in `structuredContent` (the text block keeps the original message first, so
 * every existing client and assertion keeps matching).
 *
 * Classification is by error `name` and by the stable phrases the kernel
 * client and the four `wrap*Fault` helpers already produce — deliberately not
 * by importing `kernelClient.ts` / `scadService.ts` / `dirtyGuard.ts`, which
 * would drag the kernel graph (or `vscode`) into this module and its tests.
 *
 * Unknown tool-input keys are *warned about*, never rejected: some MCP
 * clients add keys of their own, so strict mode is a decision to make after
 * measuring (see the roadmap's coded-errors item).
 */
import { nearestName } from "./opCommands";

export type McpErrorCode =
  | "kernel-timeout"
  | "job-cancelled"
  | "kernel-reset"
  | "kernel-crashed"
  | "source-timeout"
  | "source-conversion-failed"
  | "unsupported-source"
  | "dirty-buffer"
  | "stale-revision"
  | "invalid-op"
  | "tool-error";

export interface McpErrorInfo {
  code: McpErrorCode;
  message: string;
  hint?: string;
  /** True when repeating the SAME call, unchanged, can reasonably succeed. */
  retryable: boolean;
  /** `stale-revision` only: the sidecar's revision right now, to re-apply against. */
  currentRevision?: string;
}

const RETRY_HINT = "Transient kernel condition — repeat the same call unchanged; do not change the model or its inputs.";

export function classifyToolError(err: unknown): McpErrorInfo {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  const kind = (err as { kind?: unknown } | null)?.kind;

  if (name === "JobCancelledError") {
    return { code: "job-cancelled", message, hint: "The call was cancelled before it finished. Repeat it if the result is still wanted.", retryable: true };
  }
  if (name === "ScadUnavailableError") {
    return { code: "unsupported-source", message, hint: "No usable openscad binary. Install OpenSCAD or set OPENSCAD_BINARY; retrying without it will fail the same way.", retryable: false };
  }
  if (name === "ScadConvertError") {
    return kind === "timeout"
      ? { code: "source-timeout", message, hint: "The OpenSCAD evaluation exceeded its time budget and would again — simplify the model (fewer $fn segments, smaller imports) rather than retrying.", retryable: false }
      : { code: "source-conversion-failed", message, hint: "OpenSCAD rejected the source. Fix the .scad file (see the quoted openscad output); retrying unchanged will fail the same way.", retryable: false };
  }
  if (name === "DirtyBufferError") {
    return { code: "dirty-buffer", message, hint: "Save or revert the open editor tab for that file, then repeat the call.", retryable: false };
  }
  if (name === "StaleRevisionError") {
    const currentRevision = (err as { currentRevision?: unknown } | null)?.currentRevision;
    return {
      code: "stale-revision",
      message,
      hint: "Another writer changed this sidecar. Re-read it with get_state, re-apply your change to the current state, then repeat the call with the new revision (or omit expectedRevision to overwrite).",
      retryable: false,
      ...(typeof currentRevision === "string" ? { currentRevision } : {}),
    };
  }
  if (/did not respond within/i.test(message)) {
    return { code: "kernel-timeout", message, hint: `${RETRY_HINT} If it times out again the input is too heavy — use a coarser size or a smaller model.`, retryable: true };
  }
  if (/kernel worker exited unexpectedly/i.test(message)) {
    return { code: "kernel-crashed", message, hint: RETRY_HINT, retryable: true };
  }
  if (/kernel has been reset/i.test(message)) {
    return { code: "kernel-reset", message, hint: RETRY_HINT, retryable: true };
  }
  return { code: "tool-error", message, retryable: false };
}

/** The `isError` tool result for a coded failure: original message first
 * (plus the hint on a second line), the code object in `structuredContent`. */
export function errorToolResult(err: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: McpErrorInfo;
} {
  const info = classifyToolError(err);
  const text = info.hint ? `${info.message}\nHint: ${info.hint}` : info.message;
  return { isError: true, content: [{ type: "text", text }], structuredContent: info };
}

/** One warning per input key the tool does not declare, naming the nearest
 * declared key when there is a genuine near-miss. */
export function unknownKeyWarnings(provided: readonly string[], known: readonly string[]): string[] {
  const knownSet = new Set(known);
  const out: string[] = [];
  for (const key of provided) {
    if (knownSet.has(key)) continue;
    const near = nearestName(key, known);
    out.push(`Unknown parameter "${key}" was ignored${near ? ` — did you mean "${near}"?` : "."}`);
  }
  return out;
}

/** Splits a raw argument object into the declared keys (kept) and the
 * unknown ones (reported). The kept object is what the handler sees, so a
 * handler's view of its arguments is identical to the pre-warning behaviour. */
export function splitUnknownKeys(
  args: unknown,
  known: readonly string[]
): { kept: Record<string, unknown>; unknown: string[] } {
  const kept: Record<string, unknown> = {};
  const unknown: string[] = [];
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    const knownSet = new Set(known);
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      if (knownSet.has(k)) kept[k] = v;
      else unknown.push(k);
    }
  }
  return { kept, unknown };
}

/** Merges top-level fields into a tool result's first text block when that
 * block is a JSON object; a result that is not (an error message, an image
 * block first) is returned unchanged. */
export function mergeFieldsIntoResult<R extends { content: Array<{ type: string; text?: string }> }>(
  result: R,
  fields: Record<string, unknown>
): R {
  const first = result.content[0];
  if (first?.type !== "text" || typeof first.text !== "string") return result;
  try {
    const parsed = JSON.parse(first.text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return result;
    return { ...result, content: [{ ...first, text: JSON.stringify({ ...parsed, ...fields }, null, 2) }, ...result.content.slice(1)] };
  } catch {
    return result;
  }
}

/** Merges warnings into a tool result's first text block when that block is a
 * JSON object (extends an existing `warnings` array, or creates one);
 * otherwise appends a plain text block so nothing is lost. */
export function mergeWarningsIntoResult<R extends { content: Array<{ type: string; text?: string }> }>(
  result: R,
  warnings: string[]
): R {
  if (warnings.length === 0) return result;
  const first = result.content[0];
  if (first?.type === "text" && typeof first.text === "string") {
    try {
      const parsed = JSON.parse(first.text);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const existing = Array.isArray(parsed.warnings) ? parsed.warnings : [];
        parsed.warnings = [...existing, ...warnings];
        return { ...result, content: [{ ...first, text: JSON.stringify(parsed, null, 2) }, ...result.content.slice(1)] };
      }
    } catch {
      /* not JSON (an error message) — fall through to the plain block */
    }
  }
  return { ...result, content: [...result.content, { type: "text", text: warnings.join("\n") }] };
}
