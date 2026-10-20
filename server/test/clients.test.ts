// AI app registration under "surehand-ae": the clients / connect / disconnect commands, the rename from
// 1.3's "after-effects" (only where it runs our server), and settings that named ~/.aemcp. Temporary home,
// fake settings files; the Claude Code command line is never run.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
const web = () => clients.clientsJson().clients.find((c) => c.id === "chatgpt-web")!;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "surehand-clients-"));
  process.env.HOME = process.env.USERPROFILE = home;
  process.env.CODEX_HOME = join(home, ".codex");
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.LOCALAPPDATA = join(home, "AppData", "Local");
  delete process.env.XDG_CONFIG_HOME;
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
  it("lists the seven apps and ChatGPT on the web, with what is connected and where", () => {
    put(util.claudeDesktopConfig(), { mcpServers: { "surehand-ae": ENTRY() } });
    put(util.cursorConfig(), { mcpServers: { "after-effects": { command: "node", args: [join(home, ".aemcp", "server", "ae-mcp.mjs")] } } });
    put(util.codexConfig(), 'model = "o3"\n');
    const list = clients.listClients();
    expect(list.map((c) => c.id)).toEqual(["claude-desktop", "claude-code", "codex", "cursor", "vscode", "windsurf", "lm-studio", "chatgpt-web"]);
    const by = Object.fromEntries(list.map((c) => [c.id, c]));
    expect(by["claude-desktop"]).toEqual({ id: "claude-desktop", name: "Claude Desktop", installed: true, configured: true, configPath: util.claudeDesktopConfig(), note: null });
    expect(by["claude-code"]).toMatchObject({ installed: false, configured: false, configPath: util.claudeCodeConfig() });
    expect(by.codex).toMatchObject({ installed: true, configured: false, configPath: util.codexConfig() });
    expect(by.cursor).toMatchObject({ installed: true, configured: true, note: expect.stringMatching(/old name/) });
    expect(by["chatgpt-web"]).toMatchObject({ configured: false, configPath: null, howTo: expect.stringMatching(/Connect ChatGPT/) });
  });

  it("--json is {clients: [{id, name, installed, configured, inUse?, note?, action?}], snippet}", () => {
    put(util.cursorConfig(), { mcpServers: {} });
    const out = clients.clientsJson();
    expect(out.clients.map((c) => c.id)).toEqual(["claude-desktop", "claude-code", "codex", "cursor", "vscode", "windsurf", "lm-studio", "chatgpt-web"]);
    for (const c of out.clients) expect(Object.keys(c).every((k) => ["id", "name", "installed", "configured", "inUse", "note", "action", "howTo"].includes(k))).toBe(true);
    expect(out.clients[3]).toEqual({ id: "cursor", name: "Cursor", installed: true, configured: false });
    expect(out.clients[7]).toMatchObject({ id: "chatgpt-web", configured: false, action: "start", howTo: expect.stringMatching(/Developer mode/) });
    // a short status for the row; the long how-to stays out of the note
    expect(["Not running", "Needs cloudflared"]).toContain(out.clients[7].note);
    expect(JSON.parse(out.snippet!)).toEqual({ mcpServers: { "surehand-ae": { command: expect.any(String), args: [server()] } } });
  });

  it("ChatGPT (web) is connected while its background server runs, from the status file", () => {
    const file = join(home, ".surehand", "ae", "chatgpt.json");
    // a live supervisor is checked by its process: this test process isn't one, so a "running" file says stopped
    put(file, { state: "running", pid: process.pid, url: "https://x.trycloudflare.com/mcp/t" });
    expect(web()).toMatchObject({ configured: false });
    put(file, { state: "needs-tunnel" });
    const n = web().note;
    expect(n === "Needs cloudflared" || n === "Not running").toBe(true); // "Not running" when this computer has a tunnel tool
    put(file, { state: "error", error: "cloudflared stopped" });
    expect(web()).toMatchObject({ configured: false, note: "Didn\u2019t start" });
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

  it("VS Code: its user mcp.json, under \"servers\" with type stdio; comments read, everything else kept", () => {
    const other = { type: "stdio", ...FOREIGN };
    put(util.vscodeConfig(), '{\n  // mine\n  "inputs": [],\n  "servers": {\n    "other": { "type": "stdio", "command": "/opt/other/ae-bridge", "args": ["--port", "9000"] },\n  },\n}\n');
    expect(clients.clientInfo("vscode")).toMatchObject({ installed: true, configured: false, configPath: util.vscodeConfig() });
    expect(clients.connectClient("vscode", ENTRY())).toMatchObject({ ok: true, message: "VS Code is connected to Surehand MCP.", restartHint: expect.stringMatching(/Agent mode/) });
    expect(json(util.vscodeConfig())).toEqual({ inputs: [], servers: { other, "surehand-ae": { type: "stdio", ...ENTRY() } } });
    expect(readFileSync(util.vscodeConfig() + ".surehand.bak", "utf8")).toMatch(/\/\/ mine/);
    expect(clients.clientInfo("vscode")).toMatchObject({ configured: true, note: null });
    expect(clients.disconnectClient("vscode")).toMatchObject({ ok: true, message: "VS Code is no longer connected to Surehand MCP." });
    expect(json(util.vscodeConfig())).toEqual({ inputs: [], servers: { other } });
  });

  it("VS Code: a settings file it can't read is left alone", () => {
    put(util.vscodeConfig(), '{ "servers": { "other": ');
    expect(clients.connectClient("vscode", ENTRY())).toMatchObject({ ok: false, message: expect.stringMatching(/could not be read/) });
    expect(readFileSync(util.vscodeConfig(), "utf8")).toBe('{ "servers": { "other": ');
    expect(clients.clientInfo("vscode").note).toMatch(/can't be read/);
  });

  it("Windsurf / Devin Desktop: Devin's mcp_config.json, and Windsurf's from before the rename while its folder is there", () => {
    // a Windsurf from before the rename: only ~/.codeium/windsurf
    put(util.windsurfLegacyConfig(), { mcpServers: { other: FOREIGN } });
    expect(clients.clientInfo("windsurf")).toMatchObject({ installed: true, configured: false });
    expect(clients.connectClient("windsurf", ENTRY())).toMatchObject({ ok: true, message: "Windsurf / Devin Desktop is connected to Surehand MCP." });
    expect(json(util.windsurfLegacyConfig()).mcpServers).toEqual({ other: FOREIGN, "surehand-ae": ENTRY() });
    expect(json(util.devinConfig())).toEqual({ mcpServers: { "surehand-ae": ENTRY() } });
    expect(clients.disconnectClient("windsurf").ok).toBe(true);
    expect(json(util.windsurfLegacyConfig()).mcpServers).toEqual({ other: FOREIGN });
    expect(json(util.devinConfig()).mcpServers).toEqual({});
    // connected only in the old file (by an older Surehand, or by hand): connected, and shown there
    put(util.windsurfLegacyConfig(), { mcpServers: { "surehand-ae": ENTRY() } });
    expect(clients.clientInfo("windsurf")).toMatchObject({ configured: true, configPath: util.windsurfLegacyConfig() });
  });

  it("Devin Desktop alone: only its own file is written", () => {
    put(util.devinConfig(), { mcpServers: {}, other: 1 });
    expect(clients.clientInfo("windsurf").installed).toBe(true);
    expect(clients.connectClient("windsurf", ENTRY()).ok).toBe(true);
    expect(json(util.devinConfig())).toEqual({ mcpServers: { "surehand-ae": ENTRY() }, other: 1 });
    expect(existsSync(dirname(util.windsurfLegacyConfig()))).toBe(false);
  });

  it("LM Studio: ~/.lmstudio/mcp.json in Cursor's notation", () => {
    put(util.lmStudioConfig(), { mcpServers: { other: FOREIGN } });
    expect(clients.clientInfo("lm-studio")).toMatchObject({ installed: true, configured: false, configPath: join(home, ".lmstudio", "mcp.json") });
    expect(clients.connectClient("lm-studio", ENTRY())).toMatchObject({ ok: true, message: "LM Studio is connected to Surehand MCP." });
    expect(json(util.lmStudioConfig())).toEqual({ mcpServers: { other: FOREIGN, "surehand-ae": ENTRY() } });
    expect(clients.clientInfo("lm-studio").configured).toBe(true);
    expect(clients.disconnectClient("lm-studio").ok).toBe(true);
    expect(json(util.lmStudioConfig())).toEqual({ mcpServers: { other: FOREIGN } });
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

describe("AI app settings files are never lost (unreadable, BOM, comments)", () => {
  it("refuses to write a settings file it can't read (half-written, hand-broken) and says which and why", () => {
    const broken = '{\n  "globalShortcut": "x",\n  "mcpServers": { "mine": { "command": "/opt/x"';
    put(util.claudeDesktopConfig(), broken);
    const r = clients.connectClient("claude-desktop", ENTRY());
    expect(r.ok).toBe(false);
    expect(r.message).toContain(util.claudeDesktopConfig());
    expect(r.message).toMatch(/isn't valid JSON.*left unchanged/);
    expect(readFileSync(util.claudeDesktopConfig(), "utf8")).toBe(broken);
    expect(clients.disconnectClient("claude-desktop").ok).toBe(false);
    expect(readFileSync(util.claudeDesktopConfig(), "utf8")).toBe(broken);
    expect(clients.clientInfo("claude-desktop").note).toMatch(/can't be read/);
    // the move from 1.3 skips it too, and says so
    const problems: string[] = [];
    expect(clients.repointLegacyClients(problems)).toEqual([]);
    expect(problems.join()).toMatch(/Claude Desktop: .* can't be read/);
    expect(readFileSync(util.claudeDesktopConfig(), "utf8")).toBe(broken);
  });

  it("a BOM (Windows editors) is read and the rest of the file kept", () => {
    put(util.claudeDesktopConfig(), "﻿" + JSON.stringify({ globalShortcut: "x", mcpServers: { other: FOREIGN } }));
    expect(clients.connectClient("claude-desktop", ENTRY()).ok).toBe(true);
    expect(json(util.claudeDesktopConfig())).toEqual({ globalShortcut: "x", mcpServers: { other: FOREIGN, "surehand-ae": ENTRY() } });
  });

  it("Cursor's mcp.json may have comments and trailing commas: read, and everything else in it kept", () => {
    put(util.cursorConfig(), '{\n  // my servers\n  "mcpServers": {\n    "other": { "command": "/opt/other/ae-bridge", "args": ["--port", "9000"], },\n  },\n}\n');
    expect(clients.connectClient("cursor", ENTRY()).ok).toBe(true);
    expect(json(util.cursorConfig()).mcpServers).toEqual({ other: FOREIGN, "surehand-ae": ENTRY() });
    expect(readFileSync(util.cursorConfig() + ".surehand.bak", "utf8")).toMatch(/\/\/ my servers/); // the original, comments and all
  });

  it("every change is backed up first (timestamped, the newest five kept) and written atomically", () => {
    put(util.cursorConfig(), { mcpServers: { other: FOREIGN } });
    for (let i = 0; i < 4; i++) {
      clients.connectClient("cursor", ENTRY());
      clients.disconnectClient("cursor");
    }
    const dir = dirname(util.cursorConfig());
    const names = readdirSync(dir);
    expect(names.filter((n) => /^mcp\.json\.surehand-\d{8}-\d{6}-\d{3}(-\d+)?\.bak$/.test(n))).toHaveLength(5);
    expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(json(util.cursorConfig()).mcpServers).toEqual({ other: FOREIGN });
  });
});
