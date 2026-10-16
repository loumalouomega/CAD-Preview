import { describe, expect, it } from "vitest";
import { buildSnippets, shellQuote, type McpLaunch } from "./mcpClientSnippets";

const launch = (over: Partial<McpLaunch> = {}): McpLaunch => ({
  command: "/usr/share/code/code",
  args: ["/home/u/.vscode/extensions/cad/dist/mcp-server.js"],
  env: { ELECTRON_RUN_AS_NODE: "1" },
  serverName: "cad-preview",
  ...over,
});

const byClient = (l: McpLaunch, c: string) => buildSnippets(l).find((s) => s.client === c)!;

describe("buildSnippets", () => {
  it("covers every client once", () => {
    expect(buildSnippets(launch()).map((s) => s.client)).toEqual([
      "claude-code", "claude-code-json", "claude-desktop", "cursor", "vscode", "windsurf", "codex",
    ]);
  });

  it("emits parseable JSON with env, and VS Code uses `servers` not `mcpServers`", () => {
    for (const c of ["claude-code-json", "claude-desktop", "cursor", "windsurf"]) {
      const doc = JSON.parse(byClient(launch(), c).text);
      expect(doc.mcpServers["cad-preview"]).toEqual({
        command: "/usr/share/code/code",
        args: ["/home/u/.vscode/extensions/cad/dist/mcp-server.js"],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      });
    }
    const vs = JSON.parse(byClient(launch(), "vscode").text);
    expect(vs.servers["cad-preview"].command).toBe("/usr/share/code/code");
    expect(vs.mcpServers).toBeUndefined();
  });

  it("omits env when empty", () => {
    const doc = JSON.parse(byClient(launch({ env: {} }), "cursor").text);
    expect(doc.mcpServers["cad-preview"].env).toBeUndefined();
    expect(byClient(launch({ env: {} }), "claude-code").text).not.toContain("--env");
    expect(byClient(launch({ env: {} }), "codex").text).not.toContain("env =");
  });

  it("builds the Claude Code command with env flag and quoting for spaces", () => {
    const l = launch({ command: "/opt/My Editor/code", args: ["/p with space/it's/mcp-server.js"] });
    expect(byClient(l, "claude-code").text).toBe(
      "claude mcp add --env ELECTRON_RUN_AS_NODE=1 cad-preview -- '/opt/My Editor/code' '/p with space/it'\\''s/mcp-server.js'"
    );
  });

  it("escapes Windows backslashes in JSON and TOML", () => {
    const l = launch({ command: "C:\\Program Files\\Code\\Code.exe", args: ["C:\\ext\\dist\\mcp-server.js"] });
    expect(JSON.parse(byClient(l, "claude-desktop").text).mcpServers["cad-preview"].command).toBe(
      "C:\\Program Files\\Code\\Code.exe"
    );
    const toml = byClient(l, "codex").text;
    expect(toml).toContain('command = "C:\\\\Program Files\\\\Code\\\\Code.exe"');
    expect(toml).toContain('env = { "ELECTRON_RUN_AS_NODE" = "1" }');
    expect(toml.startsWith("[mcp_servers.cad-preview]")).toBe(true);
  });
});

describe("shellQuote", () => {
  it("leaves safe words bare and quotes the rest", () => {
    expect(shellQuote("/a/b-c.js")).toBe("/a/b-c.js");
    expect(shellQuote("a b")).toBe("'a b'");
  });
});
