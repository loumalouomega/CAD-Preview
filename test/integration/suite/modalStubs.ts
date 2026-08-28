/**
 * Drives VS Code's modal UI from inside the integration suite.
 *
 * **Why stubbing `vscode.window.*` works, and why it is the right seam.** The
 * suite is bundled with `external: ["vscode"]`, so at runtime it
 * `require("vscode")` and receives the SAME module singleton the extension
 * itself holds — assigning `vscode.window.showQuickPick` here changes what
 * `provider.ts` calls. This is the standard VS Code extension-testing pattern
 * (normally spelled with sinon) and needs **zero production changes**.
 *
 * The alternative seams were considered and are worse: `provider.ts`'s modal
 * calls are not centralized enough to intercept at the helper level
 * (`promptSaveAndWrite`/`pickExportUnit` cover the destination and unit steps,
 * but ~8 more inline `vscode.window.*` calls make the format/view/import
 * choices, and both helpers are `private`), and no command accepts arguments —
 * `withSession` returns a zero-arg closure, so `executeCommand` cannot smuggle
 * a test value in.
 *
 * **A quick-pick response selects from the REAL offered list by label, never by
 * constructing the item.** Fabricating the item the provider expects would let
 * a test pass even if the picker no longer offers it — the picker's contents
 * are half of what is being tested. `pick("STL")` fails loudly if nothing
 * labelled "STL" was offered.
 *
 * **An exhausted queue fails loudly rather than returning `undefined`.**
 * `undefined` is VS Code's "user cancelled" signal, so a silently-empty queue
 * would turn missing test setup into a *passing* no-op — the exact false-pass
 * class that produced two bogus green assertions in the webview harness.
 */
import * as fs from "fs";
import * as vscode from "vscode";

/** One scripted answer to a modal prompt. */
export type ModalAnswer =
  /** Choose the offered quick-pick item whose label equals (or contains) this. */
  | { kind: "pick"; label: string }
  /** Answer a save dialog with this filesystem path. */
  | { kind: "save"; path: string }
  /** Answer an open dialog with these filesystem paths. */
  | { kind: "open"; paths: string[] }
  /** Simulate Escape / dismissal on whichever modal comes next. */
  | { kind: "cancel" };

export const pick = (label: string): ModalAnswer => ({ kind: "pick", label });
export const save = (path: string): ModalAnswer => ({ kind: "save", path });
export const open = (...paths: string[]): ModalAnswer => ({ kind: "open", paths });
export const cancel = (): ModalAnswer => ({ kind: "cancel" });

/** What the user was actually shown — assertable, not just the outcome. */
export interface ModalRecord {
  quickPicks: Array<{ placeHolder?: string; labels: string[] }>;
  saveDialogs: Array<{ defaultPath?: string; filters?: Record<string, string[]> }>;
  openDialogs: Array<{ openLabel?: string; filters?: Record<string, string[]> }>;
  errors: string[];
  /** Answers still unconsumed when `restore()` ran — a test that over-scripted. */
  leftover: number;
}

export interface ModalSession {
  record: ModalRecord;
  restore: () => void;
}

const labelOf = (item: unknown): string =>
  typeof item === "string" ? item : String((item as { label?: unknown })?.label ?? "");

/**
 * Installs stubs for the duration of one test case. ALWAYS call `restore()` in a
 * `finally` — these are process-global mutations on a shared singleton, so a
 * leaked stub would corrupt every later case.
 */
export function installModalStubs(answers: ModalAnswer[]): ModalSession {
  const queue = [...answers];
  const record: ModalRecord = { quickPicks: [], saveDialogs: [], openDialogs: [], errors: [], leftover: 0 };

  const win = vscode.window as unknown as Record<string, unknown>;
  const original = {
    showQuickPick: win.showQuickPick,
    showSaveDialog: win.showSaveDialog,
    showOpenDialog: win.showOpenDialog,
    showErrorMessage: win.showErrorMessage,
  };

  const next = (expected: ModalAnswer["kind"], context: string): ModalAnswer => {
    const answer = queue.shift();
    if (!answer) {
      throw new Error(
        `Modal stub: the extension opened a ${expected} (${context}) but no answer was scripted. ` +
          `Add one to installModalStubs(...) — returning undefined here would silently look like a user cancellation.`
      );
    }
    if (answer.kind !== expected && answer.kind !== "cancel") {
      throw new Error(`Modal stub: expected to answer a ${expected} (${context}) but the next scripted answer is "${answer.kind}".`);
    }
    return answer;
  };

  // The real signatures are heavily overloaded; a cast is unavoidable here and
  // is contained to these four assignments.
  win.showQuickPick = async (items: unknown, options?: { placeHolder?: string }) => {
    const resolved = (await items) as unknown[];
    const labels = resolved.map(labelOf);
    record.quickPicks.push({ placeHolder: options?.placeHolder, labels });
    const answer = next("pick", options?.placeHolder ?? "no placeholder");
    if (answer.kind === "cancel") return undefined;
    const hit = resolved.find((i) => labelOf(i) === answer.label) ?? resolved.find((i) => labelOf(i).includes(answer.label));
    if (!hit) {
      throw new Error(
        `Modal stub: nothing labelled "${answer.label}" was offered by the quick-pick ` +
          `(${options?.placeHolder ?? "no placeholder"}). Offered: ${JSON.stringify(labels)}`
      );
    }
    return hit;
  };

  win.showSaveDialog = async (options?: { defaultUri?: vscode.Uri; filters?: Record<string, string[]> }) => {
    record.saveDialogs.push({ defaultPath: options?.defaultUri?.fsPath, filters: options?.filters });
    const answer = next("save", options?.defaultUri?.fsPath ?? "no default");
    return answer.kind === "cancel" ? undefined : vscode.Uri.file(answer.path);
  };

  win.showOpenDialog = async (options?: { openLabel?: string; filters?: Record<string, string[]> }) => {
    record.openDialogs.push({ openLabel: options?.openLabel, filters: options?.filters });
    const answer = next("open", options?.openLabel ?? "no label");
    return answer.kind === "cancel" ? undefined : answer.paths.map((p) => vscode.Uri.file(p));
  };

  // Not queued: error messages are fire-and-forget (`void showErrorMessage(...)`)
  // and are an OUTCOME to assert on, not a prompt to answer.
  win.showErrorMessage = async (message: string) => {
    record.errors.push(message);
    return undefined;
  };

  return {
    record,
    restore: () => {
      record.leftover = queue.length;
      Object.assign(win, original);
    },
  };
}

/** Waits until `predicate()` holds or `timeoutMs` elapses; returns whether it held. */
export async function waitFor(predicate: () => boolean, timeoutMs = 20000, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
}

/** Waits for a file to exist and be non-empty (writes are async and debounced). */
export const waitForFile = (p: string, timeoutMs = 20000): Promise<boolean> =>
  waitFor(() => fs.existsSync(p) && fs.statSync(p).size > 0, timeoutMs);
