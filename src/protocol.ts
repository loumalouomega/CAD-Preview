import type { CadFormat } from "./fileRouter";

/** Messages sent from the extension host to the webview. */
export type HostToWebview =
  | { type: "loadUrl"; url: string; format: CadFormat }
  | { type: "status"; text: string }
  | { type: "error"; message: string };

/** Messages sent from the webview to the extension host. */
export type WebviewToHost =
  | { type: "ready" }
  | { type: "log"; message: string };
