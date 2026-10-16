/**
 * Copy-paste registration snippets for the bundled MCP server, one per common
 * MCP client. Pure and vscode-free so it is unit-testable; `mcpRegistration.ts`
 * fills in the installed paths.
 */

export interface McpLaunch {
  /** Executable that runs the server (the editor's own Node via `process.execPath`). */
  command: string;
  /** Arguments — the absolute path of `dist/mcp-server.js`. */
  args: string[];
  /** Extra environment (e.g. `ELECTRON_RUN_AS_NODE=1` when `command` is the editor binary). */
  env: Record<string, string>;
  /** Name the server is registered under. */
  serverName: string;
}

export interface McpSnippet {
  client: string;
  label: string;
  /** Where the text goes (file to edit, or "run in a terminal"). */
  target: string;
  language: "bash" | "json" | "toml";
  text: string;
}

/** POSIX single-quote a shell word (always quoted when it has anything unusual). */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

function tomlString(s: string): string {
  return JSON.stringify(s); // a JSON string is a valid TOML basic string
}

function jsonServer(l: McpLaunch): Record<string, unknown> {
  const entry: Record<string, unknown> = { command: l.command, args: l.args };
  if (Object.keys(l.env).length > 0) entry.env = l.env;
  return entry;
}

function jsonDoc(key: "mcpServers" | "servers", l: McpLaunch): string {
  return JSON.stringify({ [key]: { [l.serverName]: jsonServer(l) } }, null, 2);
}

export function buildSnippets(l: McpLaunch): McpSnippet[] {
  const envFlags = Object.entries(l.env).map(([k, v]) => `--env ${shellQuote(`${k}=${v}`)}`);
  const claudeCode = [
    "claude mcp add",
    ...envFlags,
    shellQuote(l.serverName),
    "--",
    shellQuote(l.command),
    ...l.args.map(shellQuote),
  ].join(" ");

  const envToml = Object.entries(l.env)
    .map(([k, v]) => `${JSON.stringify(k)} = ${tomlString(v)}`)
    .join(", ");
  const codex = [
    `[mcp_servers.${l.serverName}]`,
    `command = ${tomlString(l.command)}`,
    `args = [${l.args.map(tomlString).join(", ")}]`,
    ...(envToml ? [`env = { ${envToml} }`] : []),
  ].join("\n");

  return [
    { client: "claude-code", label: "Claude Code (command)", target: "Run in a terminal", language: "bash", text: claudeCode },
    { client: "claude-code-json", label: "Claude Code (.mcp.json)", target: "Project .mcp.json", language: "json", text: jsonDoc("mcpServers", l) },
    { client: "claude-desktop", label: "Claude Desktop", target: "claude_desktop_config.json", language: "json", text: jsonDoc("mcpServers", l) },
    { client: "cursor", label: "Cursor", target: ".cursor/mcp.json", language: "json", text: jsonDoc("mcpServers", l) },
    { client: "vscode", label: "VS Code (workspace file)", target: ".vscode/mcp.json", language: "json", text: jsonDoc("servers", l) },
    { client: "windsurf", label: "Windsurf", target: "~/.codeium/windsurf/mcp_config.json", language: "json", text: jsonDoc("mcpServers", l) },
    { client: "codex", label: "Codex", target: "~/.codex/config.toml", language: "toml", text: codex },
  ];
}
