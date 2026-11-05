/**
 * Issue draft from a failure (roadmap "Issue draft from a failure"). Pure and
 * vscode-free so the redaction is unit-tested and the MCP `diagnostics_report`
 * tool returns the same text as the editor command.
 *
 * Nothing here sends anything. Absolute paths are reduced to a basename, the
 * home/workspace prefixes are scrubbed from every free-text field, and no
 * model bytes are ever included.
 */
import type { EditOp, OpOutcome } from "./editOps";

export interface DraftEnvironment {
  extensionVersion: string;
  vscodeVersion?: string;
  platform?: string;
  nodeVersion?: string;
  /** package name → installed/pinned version, e.g. `@meshioplusplus/wasm`. */
  kernels: Record<string, string>;
}

export interface IssueDraftInput {
  /** Path of the open model; reduced to its basename. */
  modelPath?: string;
  /** The failing op (kind and parameters are included, redacted). */
  op?: EditOp;
  outcome?: OpOutcome;
  /** A free-text error (kernel crash message, stack's first line). */
  error?: string;
  env: DraftEnvironment;
  /** Prefixes to scrub from any text (home dir, workspace folders). */
  scrub?: string[];
}

const MAX_FIELD = 2000;

/** Replace each scrub prefix and any remaining absolute path with its basename. */
export function redactText(text: string, scrub: readonly string[] = []): string {
  let out = text;
  for (const prefix of [...scrub].filter((p) => p.length > 1).sort((a, b) => b.length - a.length)) {
    out = out.split(prefix.replace(/[\\/]+$/, "")).join("<path>");
  }
  // POSIX absolute paths with at least two segments, and Windows drive paths.
  out = out.replace(/(?:[A-Za-z]:\\|\/)(?:[^\s"'`<>|:*?\\/]+[\\/])+([^\s"'`<>|:*?\\/]+)/g, (_m, base: string) => `<path>/${base}`);
  return out.length > MAX_FIELD ? `${out.slice(0, MAX_FIELD)}… (truncated)` : out;
}

function redactJson(value: unknown, scrub: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, scrub);
  if (Array.isArray(value)) return value.map((v) => redactJson(v, scrub));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactJson(v, scrub)]));
  }
  return value;
}

const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export interface IssueDraft {
  title: string;
  body: string;
}

export function buildIssueDraft(input: IssueDraftInput): IssueDraft {
  const scrub = input.scrub ?? [];
  const lines: string[] = [];
  const what = input.op ? `${input.op.op} did not apply` : input.error ? "Kernel error" : "Problem report";
  lines.push("## What happened", "", input.outcome?.diagnostic ? redactText(input.outcome.diagnostic, scrub) : input.error ? redactText(input.error, scrub) : "(describe what you did and what you expected)", "");
  if (input.outcome?.hint) lines.push(`Hint shown: ${redactText(input.outcome.hint, scrub)}`, "");
  if (input.modelPath) lines.push(`Model file: \`${basename(input.modelPath)}\` (attach it deliberately if it is needed — it is never included automatically)`, "");
  if (input.op) {
    lines.push("## Operation", "", "```json", JSON.stringify(redactJson(input.op, scrub), null, 2), "```", "");
  }
  const e = input.env;
  lines.push("## Environment", "", `- CAD Preview ${e.extensionVersion}`);
  if (e.vscodeVersion) lines.push(`- VS Code ${e.vscodeVersion}`);
  if (e.platform) lines.push(`- ${e.platform}`);
  if (e.nodeVersion) lines.push(`- Node ${e.nodeVersion}`);
  for (const [name, version] of Object.entries(e.kernels).sort(([a], [b]) => a.localeCompare(b))) lines.push(`- ${name} ${version}`);
  lines.push("", "_Review this draft before submitting; nothing was sent automatically._");
  return { title: `[${input.op?.op ?? "report"}] ${what}`, body: lines.join("\n") };
}

/** `issues/new` URL with the draft prefilled (GitHub truncates very long URLs, so the body is capped). */
export function issueUrl(repoUrl: string, draft: IssueDraft, maxBody = 6000): string {
  const base = repoUrl.replace(/\.git$/, "").replace(/\/+$/, "");
  const body = draft.body.length > maxBody ? `${draft.body.slice(0, maxBody)}\n\n… (draft truncated — paste the full text from the editor tab)` : draft.body;
  return `${base}/issues/new?title=${encodeURIComponent(draft.title)}&body=${encodeURIComponent(body)}`;
}

/**
 * True for the kernel-worker crash / watchdog messages (`kernelClient.ts`: "kernel worker exited unexpectedly …",
 * "… did not respond within N …"). The webview offers "Report issue…" beside such an error; any other message does not.
 * Deliberately a narrow match on those two phrases — it is not the per-kernel abort vocabulary.
 */
export function isKernelFailureMessage(message: string): boolean {
  return /kernel worker exited|did not respond within/i.test(message);
}
