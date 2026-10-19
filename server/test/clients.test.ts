// AI app registration under "surehand-ae": the clients / connect / disconnect commands, the rename from
// 1.3's "after-effects" (only where it runs our server), and settings that named ~/.aemcp. Temporary home,
// fake settings files; the Claude Code command line is never run.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

vi.mock("../src/cli/util.js", async (orig) => ({ ...(await orig<typeof import("../src/cli/util.js")>()), findClaudeCli: () => null }));

const util = await import("../src/cli/util.js");
const clients = await import("../src/cli/clients.js");

let home = "";
const A = () => join(home, ".surehand", "ae");
const server = () => join(A(), "server", "surehand-ae.mjs");
const put = (file: string, data: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
};
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const ENTRY = () => ({ command: process.execPath, args: [server()] });
const FOREIGN = { command: "/opt/other/ae-bridge", args: ["--port", "9000"] };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "surehand-clients-"));
  process.env.HOME = process.env.USERPROFILE = home;
  process.env.CODEX_HOME = join(home, ".codex");
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.LOCALAPPDATA = join(home, "AppData", "Local");
  put(server(), "// server");
});

describe("isOurEntry", () => {
  it("knows our server on any platform, and nothing else", () => {
    expect(clients.isOurEntry({ command: "/usr/local/bin/node", args: ["/Users/ron/.aemcp/server/ae-mcp.mjs"] })).toBe(true);
    expect(clients.isOurEntry({ command: "C:\\Users\\Ron\\.aemcp\\node\\node.exe", args: ["C:\\Users\\Ron\\.aemcp\\server\\ae-mcp.mjs"] })).toBe(true);
    expect(clients.isOurEntry({ command: "node", args: ["/src/AfterEffectsMCP/server/dist/ae-mcp.mjs"] })).toBe(true);
    expect(clients.isOurEntry({ command: "C:\\Users\\Ron\\.surehand\\node\\node.exe", args: ["C:\\Users\\Ron\\.surehand\\ae\\server\\surehand-ae.mjs"] })).toBe(true);
    expect(clients.isOurEntry(FOREIGN)).toBe(false);
    expect(clients.isOurEntry({ command: "npx", args: ["-y", "some-after-effects-mcp"] })).toBe(false);
    expect(clients.isOurEntry(undefined)).toBe(false);
  });
});

describe("clients --json", () => {
  it("lists the four apps and ChatGPT on the web, with what is connected and where", () => {
    put(util.claudeDesktopConfig(), { mcpServers: { "surehand-ae": ENTRY() } });
    put(util.cursorConfig(), { mcpServers: { "after-effects": { command: "node", args: [join(home, ".aemcp", "server", "ae-mcp.mjs")] } } });
    put(util.codexConfig(), 'model = "o3"\n');
    const list = clients.listClients();
    expect(list.map((c) => c.id)).toEqual(["claude-desktop", "claude-code", "codex", "cursor", "chatgpt-web"]);
    const by = Object.fromEntries(list.map((c) => [c.id, c]));
    expect(by["claude-desktop"]).toEqual({ id: "claude-desktop", name: "Claude Desktop", installed: true, configured: true, configPath: util.claudeDesktopConfig(), note: null });
    expect(by["claude-code"]).toMatchObject({ installed: false, configured: false, configPath: util.claudeCodeConfig() });
    expect(by.codex).toMatchObject({ installed: true, configured: false, configPath: util.codexConfig() });
    expect(by.cursor).toMatchObject({ installed: true, configured: true, note: expect.stringMatching(/old name/) });
    expect(by["chatgpt-web"]).toMatchObject({ configured: false, configPath: null, howTo: expect.stringMatching(/Connect ChatGPT/) });
  });

  it("notes an entry whose Node.js is gone", () => {
    put(util.claudeDesktopConfig(), { mcpServers: { "surehand-ae": { command: join(home, "gone", "node"), args: [server()] } } });
    expect(clients.clientInfo("claude-desktop").note).toMatch(/Node\.js no longer exists/);
  });
});

describe("connect / disconnect", () => {
  it("connect registers surehand-ae, replaces our 1.3 after-effects entry and leaves everything else alone", () => {
    put(util.claudeDesktopConfig(), { globalShortcut: "x", mcpServers: { "after-effects": { command: "node", args: [join(home, ".aemcp", "server", "ae-mcp.mjs")] }, other: FOREIGN } });
    const r = clients.connectClient("claude-desktop", ENTRY());
    expect(r).toMatchObject({ ok: true, message: "Claude Desktop is connected to Surehand MCP.", restartHint: expect.any(String) });
    const cfg = json(util.claudeDesktopConfig());
    expect(cfg).toEqual({ globalShortcut: "x", mcpServers: { other: FOREIGN, "surehand-ae": ENTRY() } });
    expect(existsSync(util.claudeDesktopConfig() + ".surehand.bak")).toBe(true);
  });

  it("a foreign after-effects server is never removed", () => {
    put(util.cursorConfig(), { mcpServers: { "after-effects": FOREIGN } });
    clients.connectClient("cursor", ENTRY());
    expect(json(util.cursorConfig()).mcpServers).toEqual({ "after-effects": FOREIGN, "surehand-ae": ENTRY() });
    expect(clients.disconnectClient("cursor")).toMatchObject({ ok: true, message: "Cursor is no longer connected to Surehand MCP." });
    expect(json(util.cursorConfig()).mcpServers).toEqual({ "after-effects": FOREIGN });
    expect(clients.disconnectClient("cursor")).toEqual({ ok: true, message: "Cursor wasn't connected.", restartHint: null });
  });

  it("Claude Code without its command line: ~/.claude.json", () => {
    put(util.claudeCodeConfig(), { projects: {}, mcpServers: { "after-effects": { type: "stdio", command: "node", args: ["/Users/x/.aemcp/server/ae-mcp.mjs"], env: {} } } });
    expect(clients.connectClient("claude-code", ENTRY()).ok).toBe(true);
    expect(json(util.claudeCodeConfig()).mcpServers).toEqual({ "surehand-ae": { type: "stdio", ...ENTRY(), env: {} } });
    expect(clients.disconnectClient("claude-code").ok).toBe(true);
    expect(json(util.claudeCodeConfig())).toEqual({ projects: {}, mcpServers: {} });
  });

  it("Codex / ChatGPT desktop: our marked block (1.3's \"ae-mcp\" block is replaced), the rest of config.toml untouched", () => {
    const foreign = '[mcp_servers.after-effects]\ncommand = "/opt/other/ae-bridge"\n';
    put(util.codexConfig(), `model = "o3"\n\n${foreign}\n# >>> ae-mcp >>>\n[mcp_servers.after-effects]\ncommand = "node"\nargs = ["/old/.aemcp/server/ae-mcp.mjs"]\n# <<< ae-mcp <<<\n`);
    expect(clients.connectClient("codex", ENTRY()).ok).toBe(true);
    const t = readFileSync(util.codexConfig(), "utf8");
    expect(t).toContain(foreign);
    expect(t).not.toContain("ae-mcp");
    expect(t).toContain(`# >>> surehand-ae >>>\n[mcp_servers.surehand-ae]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(server())}]`);
    expect(clients.clientInfo("codex")).toMatchObject({ configured: true, note: null });
    expect(clients.disconnectClient("codex").ok).toBe(true);
    expect(readFileSync(util.codexConfig(), "utf8")).toBe(`model = "o3"\n\n${foreign}`);
  });

  it("unknown apps, ChatGPT on the web, and a missing server are explained, never half done", () => {
    expect(clients.connectClient("notepad")).toMatchObject({ ok: false, message: expect.stringMatching(/Unknown app "notepad"/) });
    expect(clients.connectClient("chatgpt-web")).toMatchObject({ ok: false, message: expect.stringMatching(/Developer mode/) });
    expect(clients.connectClient("cursor", { command: "node", args: [join(home, "missing.mjs")] })).toMatchObject({ ok: false, message: expect.stringMatching(/isn't installed/) });
    expect(existsSync(util.cursorConfig())).toBe(false);
  });
});

describe("after the move from 1.3", () => {
  it("settings that named ~/.aemcp point at the new server and Node.js; foreign and source-checkout entries are left alone", () => {
    const L = join(home, ".aemcp");
    const old = { command: join(L, "node", "bin", "node"), args: [join(L, "server", "ae-mcp.mjs")] };
    const moved = { command: join(home, ".surehand", "node", "bin", "node"), args: [server()] };
    put(util.claudeDesktopConfig(), { mcpServers: { "after-effects": old } });
    put(util.cursorConfig(), { mcpServers: { "after-effects": FOREIGN } });
    put(util.claudeCodeConfig(), { mcpServers: { "after-effects": { type: "stdio", command: "node", args: ["/src/repo/server/dist/ae-mcp.mjs"], env: {} } } });
    put(util.codexConfig(), `# >>> ae-mcp >>>\n[mcp_servers.after-effects]\ncommand = ${JSON.stringify(old.command)}\nargs = [${JSON.stringify(old.args[0])}]\nstartup_timeout_sec = 20\ntool_timeout_sec = 600\n# <<< ae-mcp <<<\n`);
    expect(clients.repointLegacyClients().sort()).toEqual(["ChatGPT desktop / Codex", "Claude Desktop"]);
    expect(json(util.claudeDesktopConfig()).mcpServers).toEqual({ "surehand-ae": moved });
    expect(json(util.cursorConfig()).mcpServers).toEqual({ "after-effects": FOREIGN });
    expect(json(util.claudeCodeConfig()).mcpServers["after-effects"].args).toEqual(["/src/repo/server/dist/ae-mcp.mjs"]);
    const t = readFileSync(util.codexConfig(), "utf8");
    expect(t).toContain(`[mcp_servers.surehand-ae]\ncommand = ${JSON.stringify(moved.command)}\nargs = [${JSON.stringify(server())}]`);
    expect(t).not.toContain("ae-mcp");
    // nothing left to do the second time
    expect(clients.repointLegacyClients()).toEqual([]);
  });

  it("moveFromLegacy moves the files, then the settings", () => {
    const L = join(home, ".aemcp");
    put(join(L, "server", "ae-mcp.mjs"), "1.3");
    put(join(L, "config.json"), { token: "t" });
    put(util.cursorConfig(), { mcpServers: { "after-effects": { command: "node", args: [join(L, "server", "ae-mcp.mjs")] } } });
    // the 1.4 server is already in place (as after `update`)
    const r = clients.moveFromLegacy();
    expect(r).toMatchObject({ status: "migrated", repointed: ["Cursor"] });
    expect(json(util.cursorConfig()).mcpServers).toEqual({ "surehand-ae": { command: "node", args: [server()] } });
    expect(clients.moveFromLegacy()).toMatchObject({ status: "not-needed", repointed: [] });
  });
});
