import * as vscode from "vscode";
import { routeFile, ROUTED_EXTENSIONS } from "./fileRouter";

/**
 * The Models activity-bar view: every CAD document `routeFile()` recognizes,
 * under each open workspace folder. Clicking a file opens it in the CAD
 * Preview custom editor — the same `vscode.openWith` call
 * `cad-preview.open`'s file dialog ends with, so there is exactly one open
 * path regardless of trigger surface.
 *
 * Discovery mirrors `list_workspace_models`' rules (depth cap, never
 * `.git`/`node_modules`, caps reported rather than quietly partial) but over
 * `vscode.workspace.fs` instead of node `fs`, so it also works on
 * Remote/SSH where the extension host has no local disk. The extension
 * lists live in `ROUTED_EXTENSIONS` (`src/fileRouter.ts`) — never a second
 * hand-maintained copy.
 */

const WALK_MAX_DEPTH = 6;
const SKIP_DIRS = new Set([".git", "node_modules"]);

type ModelItem = FolderItem | FileItem;

interface FolderItem {
  kind: "folder";
  uri: vscode.Uri;
  label: string;
}

interface FileItem {
  kind: "file";
  uri: vscode.Uri;
  label: string;
}

function isModelFile(name: string): boolean {
  return routeFile(name) !== undefined;
}

/** `**\/*.{stl,obj,…}` for the watcher — compound keys need their own pattern. */
function watcherPatterns(): vscode.GlobPattern[] {
  const simple = ROUTED_EXTENSIONS.filter((e) => !e.includes("."));
  const compound = ROUTED_EXTENSIONS.filter((e) => e.includes("."));
  const patterns: vscode.GlobPattern[] = [`**/*.{${simple.join(",")}}`];
  for (const ext of compound) patterns.push(`**/*.${ext}`);
  return patterns;
}

export class ModelsTreeDataProvider implements vscode.TreeDataProvider<ModelItem> {
  private readonly didChange = new vscode.EventEmitter<ModelItem | undefined | null | void>();
  readonly onDidChangeTreeData = this.didChange.event;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;

  /**
   * `viewType` is injected (not imported from `provider.ts`) so this module
   * stays a leaf: `test/integration` bundles the suite with only `vscode`
   * external, and importing the provider would drag the whole extension
   * graph (gmsh/meshio/playwright) into that bundle. The single source of
   * truth stays `CadPreviewProvider.viewType`; `extension.ts` passes it.
   */
  constructor(private readonly viewType: string) {
    const refresh = (): void => this.scheduleRefresh();
    for (const pattern of watcherPatterns()) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate(refresh, null, this.disposables);
      watcher.onDidDelete(refresh, null, this.disposables);
      this.disposables.push(watcher);
    }
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(refresh, null, undefined)
    );
  }

  dispose(): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    for (const d of this.disposables) d.dispose();
  }

  refresh(): void {
    this.didChange.fire();
  }

  private scheduleRefresh(): void {
    // Watcher bursts (checkout, unzip) collapse into one refresh, mirroring
    // the debounced sidecar writes elsewhere in this codebase.
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.didChange.fire();
    }, 300);
  }

  getTreeItem(element: ModelItem): vscode.TreeItem {
    if (element.kind === "folder") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.resourceUri = element.uri;
      item.contextValue = "cadPreview.modelFolder";
      return item;
    }
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.resourceUri = element.uri;
    item.contextValue = "cadPreview.modelFile";
    item.command = {
      command: "vscode.openWith",
      title: "Open in CAD Preview",
      arguments: [element.uri, this.viewType],
    };
    return item;
  }

  async getChildren(element?: ModelItem): Promise<ModelItem[]> {
    if (element && element.kind === "file") return [];
    if (element) return this.childrenOf(element.uri, this.depthOf(element.uri));
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 1) return this.childrenOf(folders[0].uri, 0);
    return folders.map(
      (f): FolderItem => ({ kind: "folder", uri: f.uri, label: f.name })
    );
  }

  /** Directories below the containing workspace root (the root itself is 0). */
  private depthOf(uri: vscode.Uri): number {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder = folders.find((f) => uri.toString().startsWith(f.uri.toString() + "/"));
    if (!folder || uri.toString() === folder.uri.toString()) return 0;
    return uri.toString().slice(folder.uri.toString().length + 1).split("/").length - 1;
  }

  /** Depth counts directories below the workspace root (root itself is 0). */
  private async childrenOf(dir: vscode.Uri, depth: number): Promise<ModelItem[]> {
    let entries: Array<[string, vscode.FileType]>;
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return []; // deleted mid-refresh — next refresh heals, never a throw
    }
    const out: ModelItem[] = [];
    for (const [name, type] of entries.sort(([a], [b]) => a.localeCompare(b))) {
      const uri = vscode.Uri.joinPath(dir, name);
      if (type === vscode.FileType.Directory) {
        if (SKIP_DIRS.has(name) || depth + 1 > WALK_MAX_DEPTH) continue;
        out.push({ kind: "folder", uri, label: name });
      } else if (type === vscode.FileType.File && isModelFile(name)) {
        out.push({ kind: "file", uri, label: name });
      }
    }
    return out;
  }

  /**
   * Parent lookup for `reveal()`. Routing is by URI prefix, so this is pure
   * string work — no fs calls, never throws.
   */
  getParent(element: ModelItem): vscode.ProviderResult<ModelItem> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder = folders.find((f) => element.uri.toString().startsWith(f.uri.toString() + "/"));
    if (!folder) return undefined;
    const rest = element.uri.toString().slice(folder.uri.toString().length + 1);
    if (!rest.includes("/")) {
      return folders.length === 1 ? undefined : { kind: "folder", uri: folder.uri, label: folder.name };
    }
    const parentPath = rest.slice(0, rest.lastIndexOf("/"));
    const parentUri = vscode.Uri.joinPath(folder.uri, parentPath);
    return { kind: "folder", uri: parentUri, label: parentPath.split("/").pop() ?? parentPath };
  }
}

export function registerModelsView(context: vscode.ExtensionContext, viewType: string): ModelsTreeDataProvider {
  const provider = new ModelsTreeDataProvider(viewType);
  context.subscriptions.push(
    provider,
    vscode.window.registerTreeDataProvider("cad-preview.models", provider),
    vscode.commands.registerCommand("cad-preview.refreshModels", () => provider.refresh())
  );
  return provider;
}
