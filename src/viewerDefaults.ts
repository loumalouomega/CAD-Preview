/**
 * The cross-document defaults sourced from VS Code's `cadPreview.*` settings
 * (`contributes.configuration` in `package.json`) — pure and `vscode`-free so
 * it unit-tests headless, mirroring `meshOptions.ts`'s parse-vs-store split.
 * `provider.ts` reads the raw `workspace.getConfiguration("cadPreview")`
 * object and passes it through {@link normalizeViewerDefaults} before
 * sending it to the webview. These are only ever *initial* state for a newly
 * opened document — per-document choices (sidecar values, the toolbar Grid
 * toggle) always win once set; see `doc/extension-host-api.md`.
 */

export type MeshSizePreset = "coarse" | "medium" | "fine";
export type UpAxis = "y" | "z";

export interface ViewerDefaults {
  background: string; // CSS hex color
  meshSizePreset: MeshSizePreset;
  showGridAndAxes: boolean;
  upAxis: UpAxis;
}

export const DEFAULT_VIEWER_DEFAULTS: ViewerDefaults = {
  background: "#1e1e1e",
  meshSizePreset: "medium",
  showGridAndAxes: true,
  upAxis: "y",
};

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Validates a raw `workspace.getConfiguration("cadPreview")` snapshot into a
 * clean {@link ViewerDefaults}. Same tolerance-gate style as
 * `validateMeshOptions`: each field individually falls back to its default
 * rather than rejecting the whole object.
 */
export function normalizeViewerDefaults(raw: unknown): ViewerDefaults {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const background =
    typeof o.background === "string" && HEX_COLOR_RE.test(o.background)
      ? o.background
      : DEFAULT_VIEWER_DEFAULTS.background;

  const meshSizePreset: MeshSizePreset =
    o.meshSizePreset === "coarse" || o.meshSizePreset === "medium" || o.meshSizePreset === "fine"
      ? o.meshSizePreset
      : DEFAULT_VIEWER_DEFAULTS.meshSizePreset;

  const showGridAndAxes =
    typeof o.showGridAndAxes === "boolean" ? o.showGridAndAxes : DEFAULT_VIEWER_DEFAULTS.showGridAndAxes;

  const upAxis: UpAxis = o.upAxis === "y" || o.upAxis === "z" ? o.upAxis : DEFAULT_VIEWER_DEFAULTS.upAxis;

  return { background, meshSizePreset, showGridAndAxes, upAxis };
}
