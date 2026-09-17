/**
 * Minimal in-memory `vscode` stand-in, used ONLY under vitest (see the
 * `resolve.alias` entry in `vitest.config.ts`).
 *
 * No unit test imported `vscode` before this file existed — the extension host
 * API is unresolvable outside a real VS Code — so every vscode-dependent
 * module (`customBackup.ts`, the `*Store.ts` modules via `dirtyGuard.ts`)
 * was untestable headless. This stub covers exactly what those modules touch:
 * `Uri` (file/joinPath/with/path/fsPath) and `workspace.fs` (an in-memory
 * file map) plus `workspace.textDocuments` (for `dirtyGuard.hasUnsavedChanges`).
 *
 * Deliberately NOT a faithful VS Code emulation: `fsPath === path` (no
 * Windows drive-letter handling), no events, no editors. Call
 * `__resetVscodeStub()` between tests — module state is shared per test file.
 */

import * as path from "node:path";

export class Uri {
  readonly scheme: string;
  readonly path: string;
  // Present only for structural compatibility with the real `vscode.Uri`
  // (tsc checks test files against `@types/vscode`): unused by the stub.
  readonly authority = "";
  readonly query = "";
  readonly fragment = "";

  constructor(scheme: string, path_: string) {
    this.scheme = scheme;
    this.path = path_;
  }

  get fsPath(): string {
    return this.path;
  }

  toJSON(): { scheme: string; authority: string; path: string; query: string; fragment: string } {
    return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment };
  }

  static file(p: string): Uri {
    return new Uri("file", p);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, path.posix.normalize(path.posix.join(base.path, ...segments)));
  }

  with(change: { path?: string }): Uri {
    return new Uri(this.scheme, change.path ?? this.path);
  }

  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
}

export interface TextDocumentStub {
  isDirty: boolean;
  uri: Uri;
}

class InMemoryFs {
  readonly files = new Map<string, Uint8Array>();

  async createDirectory(_uri: Uri): Promise<void> {
    // No-op: parent "directories" need no representation in a flat key map.
  }

  async readFile(uri: Uri): Promise<Uint8Array> {
    const bytes = this.files.get(uri.path);
    if (bytes === undefined) throw new Error(`ENOENT: no such file '${uri.path}'`);
    return bytes;
  }

  async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
    this.files.set(uri.path, content);
  }

  async delete(uri: Uri, _options?: { recursive?: boolean }): Promise<void> {
    for (const key of [...this.files.keys()]) {
      if (key === uri.path || key.startsWith(`${uri.path}/`)) this.files.delete(key);
    }
  }
}

export const workspace = {
  fs: new InMemoryFs(),
  textDocuments: [] as TextDocumentStub[],
};

/** Clears every file and open-document record — call in `beforeEach`. */
export function __resetVscodeStub(): void {
  workspace.fs.files.clear();
  workspace.textDocuments.length = 0;
}

/** Seeds one file, encoding text as UTF-8. */
export function __seedFile(uri: Uri, text: string): void {
  workspace.fs.files.set(uri.path, Buffer.from(text, "utf8"));
}

/** Reads one file back as UTF-8 text. */
export function __readFileText(uri: Uri): string {
  const bytes = workspace.fs.files.get(uri.path);
  if (bytes === undefined) throw new Error(`ENOENT: no such file '${uri.path}'`);
  return Buffer.from(bytes).toString("utf8");
}
