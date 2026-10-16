import * as path from "path";
import * as vscode from "vscode";
import { buildSnippets, type McpLaunch } from "./mcpClientSnippets";

/** Must equal `contributes.mcpServerDefinitionProviders[].id` in package.json. */
const PROVIDER_ID = "cad-preview.mcp";
const SERVER_NAME = "cad-preview";

/**
 * How to launch the bundled MCP server from this installed extension. The
 * editor's own binary is the Node (`process.execPath`), so no separate Node is
 * needed; `ELECTRON_RUN_AS_NODE=1` makes it behave as plain Node, and the
 * kernel-worker fork inherits that env so it does too.
 */
export function mcpLaunch(extensionPath: string): McpLaunch {
  return {
    command: process.execPath,
    args: [path.join(extensionPath, "dist", "mcp-server.js")],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    serverName: SERVER_NAME,
  };
}

export function registerMcpIntegration(context: vscode.ExtensionContext): void {
  const launch = mcpLaunch(context.extensionPath);
  const version = (context.extension.packageJSON as { version?: string }).version;

  // The `lm` namespace is absent on hosts older than the API (and in the unit-test stub).
  const lm = (vscode as { lm?: typeof vscode.lm }).lm;
  if (lm?.registerMcpServerDefinitionProvider) {
    context.subscriptions.push(
      lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
        provideMcpServerDefinitions: () => [
          new vscode.McpStdioServerDefinition("CAD Preview", launch.command, launch.args, launch.env, version),
        ],
      })
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("cad-preview.connectAgent", async () => {
      try {
        const snippets = buildSnippets(launch);
        const picked = await vscode.window.showQuickPick(
          snippets.map((s) => ({ label: s.label, description: s.target, snippet: s })),
          { placeHolder: "Copy the MCP server registration for which agent client?" }
        );
        if (!picked) return;
        await vscode.env.clipboard.writeText(picked.snippet.text);
        void vscode.window.showInformationMessage(
          `Copied the ${picked.snippet.label} snippet (${picked.snippet.target}).`
        );
      } catch (err) {
        void vscode.window.showErrorMessage(`Connect an agent: ${(err as Error).message}`);
      }
    })
  );
}
