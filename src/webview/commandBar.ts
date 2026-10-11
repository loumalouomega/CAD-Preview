import type { EditOp } from "../editOps";
import { validateEditOp } from "../editOps";
import {
  buildCommandOp, commandIsBrepOnly, completeCommands, completeEntityId, echoCommandText, explainEditOpRejection,
  parseCommandLine, type CommandRow, type EntityInventory, type SelectionIds,
} from "../opCommands";

/**
 * The lower command bar (roadmap "Lower command bar"): type an edit command —
 * a name plus an optional JSON body — and it runs through the SAME
 * `validateEditOp` gate and `editsModel.push` commit the Edits panel's Apply
 * buttons use. Webview-only: it needs no host message of its own, so a typed
 * op and a panel-built op are indistinguishable once pushed.
 *
 * Plain DOM class, no unit test (the panel convention); the parsing, `$sel`
 * expansion, table and echo all live in the pure, tested `opCommands.ts`.
 */
export interface CommandBarCallbacks {
  getSelection(): SelectionIds;
  getInventory(): EntityInventory;
  /** "brep" | "mesh" | other — only "brep" accepts B-rep-only commands. */
  sourceKind(): string;
  /** The shared commit tail (guide/lock/preview-cancel/push). Returns an error message, or null on success. */
  commit(op: EditOp, row: CommandRow): string | null;
  /** Opens the row's form (like clicking its button), prefilled from `body` when given. Returns false if it cannot open. */
  openForm(row: CommandRow, body: Record<string, unknown> | null): boolean;
}

const HISTORY_LIMIT = 100;

export class CommandBar {
  private readonly input: HTMLInputElement;
  private readonly message: HTMLElement;
  private history: string[] = [];
  private historyIndex = -1;
  private draft = "";

  constructor(root: HTMLElement, private readonly cb: CommandBarCallbacks) {
    this.input = root.querySelector<HTMLInputElement>("#cmdbar-input")!;
    this.message = root.querySelector<HTMLElement>("#cmdbar-message")!;
    this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
    // Typing in the bar must never reach the viewer's shortcuts or an open dropdown's dismissal.
    this.input.addEventListener("keyup", (e) => e.stopPropagation());
    this.input.addEventListener("keypress", (e) => e.stopPropagation());
  }

  /** Shows a one-line message; `error` colours it as a problem. Empty clears it. */
  showMessage(text: string, error = false): void {
    this.message.textContent = text;
    this.message.dataset.tone = error ? "error" : "info";
    this.message.title = text;
  }

  /** Writes a panel-built op's command line into the bar (the two-way echo). */
  echo(op: EditOp): void {
    const text = echoCommandText(op);
    if (!text) return;
    this.input.value = text;
    this.showMessage("");
  }

  /** The current text — for tests and the echo assertions. */
  get value(): string { return this.input.value; }

  focus(): void { this.input.focus(); }

  private onKeyDown(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); this.run(); return; }
    if (e.key === "Escape") { e.preventDefault(); this.input.value = ""; this.showMessage(""); this.historyIndex = -1; this.input.blur(); return; }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); this.stepHistory(e.key === "ArrowUp" ? 1 : -1); return; }
    if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); this.complete(); }
  }

  private stepHistory(dir: 1 | -1): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) {
      if (dir === -1) return;
      this.draft = this.input.value;
    }
    const next = this.historyIndex + dir;
    if (next < -1 || next >= this.history.length) return;
    this.historyIndex = next;
    this.input.value = next === -1 ? this.draft : this.history[this.history.length - 1 - next];
  }

  private remember(line: string): void {
    this.history = this.history.filter((h) => h !== line);
    this.history.push(line);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.historyIndex = -1;
  }

  /** Tab: complete the command name, or the entity id under the caret. */
  private complete(): void {
    const value = this.input.value;
    const caret = this.input.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    const idMatch = /(?:^|[^\w-])((?:solid|face|edge|point)-?\d*)$/i.exec(before);
    let prefix: string; let options: string[]; let start: number;
    if (!/\s/.test(before.trimStart()) && !idMatch) {
      prefix = before.trimStart();
      start = before.length - prefix.length;
      options = completeCommands(prefix);
    } else if (idMatch) {
      prefix = idMatch[1];
      start = before.length - prefix.length;
      options = completeEntityId(prefix, this.cb.getInventory());
    } else { return; }
    if (options.length === 0) { this.showMessage(`Nothing to complete for "${prefix}".`, true); return; }
    const common = options.reduce((a, b) => { let i = 0; while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++; return a.slice(0, i); });
    const done = options.length === 1 ? options[0] : common;
    this.input.value = before.slice(0, start) + done + (options.length === 1 && start === 0 && !/\s/.test(after) ? " " : "") + after;
    const pos = start + done.length + (options.length === 1 && start === 0 && !/\s/.test(after) ? 1 : 0);
    this.input.setSelectionRange(pos, pos);
    this.showMessage(options.length > 1 ? options.slice(0, 12).join("  ") + (options.length > 12 ? "  …" : "") : "");
  }

  /** Executes the current line. Exposed so tests can drive it without synthesizing key events. */
  run(): void {
    const line = this.input.value.trim();
    if (line === "") return;
    this.remember(line);
    const parsed = parseCommandLine(line);
    if (!parsed.ok) { if (!parsed.empty) this.showMessage(parsed.error, true); return; }
    const { row, body } = parsed;
    if (commandIsBrepOnly(row) && this.cb.sourceKind() !== "brep") {
      this.showMessage(`${row.command} is B-rep only — this document is a mesh source. Mesh-legal commands: primitives, transforms, booleans, holes, patterns.`, true);
      return;
    }
    if (body === null) {
      if (!this.cb.openForm(row, null)) this.showMessage(`${row.command} cannot be opened right now.`, true);
      else this.showMessage(`${row.command}: fill the form and Apply, or type a JSON body here.`);
      return;
    }
    const built = buildCommandOp(row, body, this.cb.getSelection());
    if ("error" in built) {
      this.cb.openForm(row, null);
      this.showMessage(built.error, true);
      return;
    }
    const valid = validateEditOp(built.op);
    if (!valid) {
      this.cb.openForm(row, built.op);
      this.showMessage(explainEditOpRejection(built.op), true);
      return;
    }
    const error = this.cb.commit(valid, row);
    if (error) { this.showMessage(error, true); return; }
    this.input.value = "";
    this.showMessage(`${row.command} applied.`);
  }
}
