// The Chat screen's runner (src/chat): finding the agents and their sign-in, one turn with each agent, resume,
// Stop, errors and "not signed in", against fake agent command lines (test/fixtures/chat) in a temporary
// home folder. No real agent and no account is ever used.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agyConnected, codexOtherServers, turnCommand, type ChatEvent } from "../src/chat/agents.js";
import { agentEnv, connectAgy, detectAgents, disconnectAgy, disconnectAgySync, preface, runTurn } from "../src/chat/runner.js";

const FIX = fileURLToPath(new URL("./fixtures/chat/", import.meta.url));
const fake = (a: string) => join(FIX, `fake-${a}.mjs`);
const home = mkdtempSync(join(tmpdir(), "surehand-chat-"));
const log = join(home, "fake.log");
const saved: Record<string, string | undefined> = {};
const ENV = {
  HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"), SUREHAND_AE_CONFIG: undefined, AEMCP_CONFIG: undefined,
  SUREHAND_AE_CHAT_CODEX: fake("codex"), SUREHAND_AE_CHAT_CLAUDE: fake("claude"), SUREHAND_AE_CHAT_AGY: fake("agy"), FAKE_LOG: log,
  SUREHAND_AE_PANEL_SECRET: "panel-secret-never-to-the-agent", FAKE_SCENARIO: "ok",
} as Record<string, string | undefined>;

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  process.env.FAKE_SCENARIO = "ok";
  rmSync(log, { force: true });
});

const SERVER = { command: process.execPath, args: ["/opt/surehand/surehand-ae.mjs"] };
const dir = () => join(home, ".surehand", "ae", "chat");
async function turn(agent: "codex" | "claude" | "agy", text: string, extra: { session?: string; stopAfterMs?: number } = {}) {
  const events: ChatEvent[] = [];
  const t = runTurn({ agent, text, session: extra.session, server: SERVER, dir: dir(), project: "/work/Spot.aep" }, (e) => events.push(e));
  if (extra.stopAfterMs !== undefined) setTimeout(() => t.stop(), extra.stopAfterMs);
  await t.done;
  return events;
}
const runs = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const texts = (ev: ChatEvent[]) => ev.filter((e) => e.type === "text");
const last = <T>(a: T[]) => a[a.length - 1];

describe("finding the agents", () => {
  it("lists Codex, Claude Code and Antigravity, each with its own sign-in as its CLI says", async () => {
    const agents = await detectAgents();
    expect(agents.map((a) => [a.id, a.label, a.found, a.signedIn])).toEqual([
      ["codex", "Codex", true, true], ["claude", "Claude Code", true, true], ["agy", "Antigravity", true, true],
    ]);
    expect(agents[0].account).toBe("ChatGPT");
    expect(agents[2].connected).toBe(false);
    // the status commands, nothing else
    expect(runs().map((r) => [r.agent, r.args.join(" ")]).sort()).toEqual([["agy", "models"], ["claude", "auth status"], ["codex", "login status"]]);
  });

  it("not signed in: says so with the agent's own words", async () => {
    process.env.FAKE_SCENARIO = "auth";
    const agents = await detectAgents();
    expect(agents[0]).toMatchObject({ signedIn: false, authText: "Not logged in" });
    expect(agents[1]).toMatchObject({ signedIn: false, authText: "Not logged in" });
    // Antigravity has no login command: its model list needs the sign-in
    expect(agents[2]).toMatchObject({ signedIn: false, authText: "error: You are currently not signed in." });
  });

  it("an agent that isn't installed is listed as not found", async () => {
    process.env.SUREHAND_AE_CHAT_CLAUDE = join(home, "nope");
    try {
      const agents = await detectAgents();
      expect(agents[1]).toMatchObject({ id: "claude", found: false, signedIn: null });
    } finally {
      process.env.SUREHAND_AE_CHAT_CLAUDE = fake("claude");
    }
  });
});

describe("Codex (codex exec --json)", () => {
  it("runs a turn with Surehand as its only MCP server, no shell, and Surehand's tools not asked about by Codex", async () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), '[mcp_servers.github]\ncommand = "gh"\n\n[mcp_servers.surehand-ae]\ncommand = "node"\n\n[mcp_servers."web-tools".env]\nX = "1"\n');
    const ev = await turn("codex", "What's in Main?");
    expect(ev).toEqual([
      { type: "session", id: "thread-1" },
      { type: "tool", phase: "start", id: "item_1", name: "ae_get_comp_info", args: { comp: "Main" } },
      { type: "tool", phase: "end", id: "item_1", name: "ae_get_comp_info", ok: true },
      { type: "text", id: "item_2", text: "Main has 3 layers." },
      { type: "done", ok: true, session: "thread-1" },
    ]);
    const r = runs()[0];
    expect(r.stdin).toBe("What's in Main?");
    expect(r.secret).toBeNull(); // the panel's secret never reaches the agent
    expect(realpathSync(r.cwd)).toBe(realpathSync(join(dir(), "work")));
    const c = r.args.filter((_: string, i: number) => r.args[i - 1] === "-c");
    expect(r.args.slice(0, 3)).toEqual(["exec", "--json", "--skip-git-repo-check"]);
    expect(last(r.args)).toBe("-");
    expect(c).toEqual(expect.arrayContaining([
      'sandbox_mode="read-only"', 'approval_policy="never"', "features.shell_tool=false", 'web_search="disabled"',
      `mcp_servers.surehand-ae.command=${JSON.stringify(process.execPath)}`, 'mcp_servers.surehand-ae.args=["/opt/surehand/surehand-ae.mjs"]',
      'mcp_servers.surehand-ae.default_tools_approval_mode="approve"', "mcp_servers.surehand-ae.tool_timeout_sec=900",
      "mcp_servers.github.enabled=false", "mcp_servers.web-tools.enabled=false",
    ]));
    expect(c.find((x: string) => x.startsWith("developer_instructions="))).toContain("The open project is /work/Spot.aep.");
    // the user's config.toml is read, never written
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toMatch(/^\[mcp_servers\.github\]/);
    rmSync(join(home, ".codex", "config.toml"));
  });

  it("continues the same thread (exec resume) without the preface", async () => {
    const ev = await turn("codex", "And now?", { session: "thread-1" });
    expect(texts(ev)).toEqual([{ type: "text", id: "item_2", text: "Still 3 layers." }]);
    const r = runs()[0];
    expect(r.args.slice(-3)).toEqual(["resume", "thread-1", "-"]);
    expect(r.args.some((a: string) => a.startsWith("developer_instructions="))).toBe(false);
  });

  it("a failed turn is one error, not the retries before it", async () => {
    process.env.FAKE_SCENARIO = "error";
    const ev = await turn("codex", "hi");
    expect(ev.filter((e) => e.type === "error")).toEqual([{ type: "error", message: "stream disconnected before completion" }]);
    expect(last(ev)).toEqual({ type: "done", ok: false, session: "thread-1" });
  });

  it("not signed in: the error says so (auth) with Codex's own words", async () => {
    process.env.FAKE_SCENARIO = "auth";
    const ev = await turn("codex", "hi");
    expect(ev.find((e) => e.type === "error")).toEqual({ type: "error", auth: true, message: expect.stringMatching(/401 Unauthorized.*log in again/) });
  });

  it("a call Surehand refused (denied, read-only) ends as failed with its reason", async () => {
    process.env.FAKE_SCENARIO = "denied";
    const ev = await turn("codex", "Retime it");
    expect(ev.find((e) => e.type === "tool" && e.phase === "end")).toEqual({ type: "tool", phase: "end", id: "item_1", name: "ae_set_keyframes", ok: false, error: "You denied this change in the Surehand panel." });
  });

  it("Stop ends the agent: done says stopped, the session stays for the next turn", async () => {
    process.env.FAKE_SCENARIO = "slow";
    const t0 = Date.now();
    const ev = await turn("codex", "Render everything", { stopAfterMs: 300 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(ev.some((e) => e.type === "error")).toBe(false);
    expect(last(ev)).toEqual({ type: "done", ok: true, session: "thread-1", stopped: true });
  });

  it("keeps the last raw stream for diagnosis", () => {
    expect(readFileSync(join(dir(), "last-codex.log"), "utf8")).toMatch(/thread\.started/);
  });
});

describe("Claude Code (claude -p --output-format stream-json)", () => {
  it("streams the text, with only Surehand's tools and no built-in ones", async () => {
    const ev = await turn("claude", "What's in Main?");
    expect(ev).toEqual([
      { type: "session", id: "sess-1" },
      { type: "text", delta: "Reading " },
      { type: "text", delta: "the comp." },
      { type: "tool", phase: "start", id: "tu_1", name: "ae_get_comp_info", args: { comp: "Main" } },
      { type: "tool", phase: "end", id: "tu_1", name: "ae_get_comp_info", ok: true },
      { type: "text", text: "Main has 3 layers." },
      { type: "done", ok: true, session: "sess-1" },
    ]);
    const r = runs()[0];
    expect(r.stdin).toBe("What's in Main?");
    expect(r.secret).toBeNull();
    expect(r.toolTimeout).toBe("900000");
    const a: string[] = r.args;
    const after = (n: string) => a[a.indexOf(n) + 1];
    expect(a).toContain("--strict-mcp-config");
    expect(after("--tools")).toBe("");
    expect(after("--allowedTools")).toBe("mcp__surehand-ae");
    expect(after("--permission-mode")).toBe("dontAsk");
    expect(after("--append-system-prompt")).toMatch(/inside Adobe After Effects/);
    expect(JSON.parse(readFileSync(after("--mcp-config"), "utf8"))).toEqual({ mcpServers: { "surehand-ae": { type: "stdio", command: process.execPath, args: ["/opt/surehand/surehand-ae.mjs"], env: {} } } });
  });

  it("resumes the session", async () => {
    await turn("claude", "And now?", { session: "sess-1" });
    const a: string[] = runs()[0].args;
    expect(a[a.indexOf("--resume") + 1]).toBe("sess-1");
    expect(a).not.toContain("--append-system-prompt");
  });

  it("not signed in: one auth error with Claude Code's own words, not shown as its answer", async () => {
    process.env.FAKE_SCENARIO = "auth";
    const ev = await turn("claude", "hi");
    expect(texts(ev)).toEqual([]);
    expect(ev.filter((e) => e.type === "error")).toEqual([{ type: "error", auth: true, message: "Not logged in · Please run /login" }]);
  });

  it("an error result and a refused call", async () => {
    process.env.FAKE_SCENARIO = "error";
    expect((await turn("claude", "hi")).filter((e) => e.type === "error")).toEqual([{ type: "error", message: "API Error: overloaded" }]);
    process.env.FAKE_SCENARIO = "denied";
    expect((await turn("claude", "hi")).find((e) => e.type === "tool" && e.phase === "end")).toMatchObject({ ok: false, error: "Read-only mode: nothing was changed." });
  });

  it("Stop", async () => {
    process.env.FAKE_SCENARIO = "slow";
    const ev = await turn("claude", "Render", { stopAfterMs: 300 });
    expect(last(ev)).toEqual({ type: "done", ok: true, session: "sess-1", stopped: true });
  });
});

describe("Antigravity (agy -p --output-format stream-json)", () => {
  it("connects Surehand to its MCP servers on request (with a backup), and removes it again", async () => {
    const cfg = join(home, ".gemini", "config", "mcp_config.json");
    const settings = join(home, ".gemini", "antigravity-cli", "settings.json");
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(settings, '{\n  // the user\'s own settings\n  "theme": "dark",\n  "permissions": { "allow": ["command(git)"], "deny": ["command(sudo)"] },\n}\n');
    writeFileSync(cfg, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    expect(await connectAgy(SERVER)).toEqual({ ok: true, message: "Surehand is connected to Antigravity." });
    expect(agyConnected()).toBe(true);
    expect(JSON.parse(readFileSync(cfg, "utf8")).mcpServers).toEqual({ other: { command: "x" }, "surehand-ae": SERVER });
    expect(existsSync(cfg + ".surehand.bak")).toBe(true);
    // its headless runs refuse tools that would need a prompt: an allow rule for Surehand's tools only, other settings kept
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ theme: "dark", permissions: { allow: ["command(git)", "mcp(surehand-ae/*)"], deny: ["command(sudo)"] } });
    expect(existsSync(settings + ".surehand.bak")).toBe(true);
    expect(await disconnectAgy()).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(settings, "utf8")).permissions.allow).toEqual(["command(git)"]);
    expect(agyConnected()).toBe(false);
    await connectAgy(SERVER);
    expect(disconnectAgySync()).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(cfg, "utf8")).mcpServers).toEqual({ other: { command: "x" } });
    expect(JSON.parse(readFileSync(settings, "utf8")).permissions.allow).toEqual(["command(git)"]);
    // registered but without the rule (connected before the rule existed): not connected for chat
    await connectAgy(SERVER);
    writeFileSync(settings, "{}");
    expect(agyConnected()).toBe(false);
  });

  it("a tool its own permission settings refused: said, with its reason, not an empty reply", async () => {
    process.env.FAKE_SCENARIO = "denied";
    const ev = await turn("agy", "What's in this project?");
    expect(ev.find((e) => e.type === "tool" && e.phase === "start")).toMatchObject({ name: "ae_get_project_info" });
    expect(ev.find((e) => e.type === "tool" && e.phase === "end")).toMatchObject({ ok: false, error: expect.stringMatching(/^Antigravity's own permission settings refused it/) });
    expect(ev.filter((e) => e.type === "error")).toEqual([{ type: "error", title: "Antigravity refused Surehand's tools", message: expect.stringMatching(/headless mode cannot prompt for, so it was auto-denied/) }]);
    expect(last(ev)).toMatchObject({ type: "done", ok: false });
  });

  it("an empty reply is never nothing on screen", async () => {
    process.env.FAKE_SCENARIO = "empty";
    const ev = await turn("agy", "hi");
    expect(ev.filter((e) => e.type === "error")).toEqual([{ type: "error", title: "Antigravity ended without an answer", message: "It gave no reply." }]);
  });

  it("runs a turn: the preface in the first prompt, then --conversation to continue; never skips permissions", async () => {
    const ev = await turn("agy", "What's in Main?");
    expect(ev).toEqual([
      { type: "session", id: "conv-1" },
      { type: "tool", phase: "start", id: "1", name: "ae_get_comp_info", args: { comp: "Main" } },
      { type: "tool", phase: "end", id: "1", name: "ae_get_comp_info", ok: true },
      { type: "text", id: "agy-2", text: "Main has" },
      { type: "text", id: "agy-2", text: "Main has 3 layers." },
      { type: "done", ok: true, session: "conv-1" },
    ]);
    let a: string[] = runs()[0].args;
    expect(a[a.indexOf("-p") + 1]).toMatch(/inside Adobe After Effects[\s\S]*\n\nWhat's in Main\?$/);
    expect(a).not.toContain("--dangerously-skip-permissions");
    rmSync(log);
    await turn("agy", "And now?", { session: "conv-1" });
    a = runs()[0].args;
    expect(a[a.indexOf("-p") + 1]).toBe("And now?");
    expect(a[a.indexOf("--conversation") + 1]).toBe("conv-1");
  });

  it("not signed in (it has no status command): the turn's error is marked auth", async () => {
    process.env.FAKE_SCENARIO = "auth";
    const ev = await turn("agy", "hi");
    expect(ev.find((e) => e.type === "error")).toEqual({ type: "error", auth: true, message: "error: You are currently not signed in." });
  });
});

describe("pieces", () => {
  it("the preface is short and names the permission setting", () => {
    const p = preface();
    expect(p.split("\n").length).toBeLessThanOrEqual(6);
    expect(p).toMatch(/Full, Ask or Read-only/);
  });
  it("the agent's environment has no panel secret, and the usual tool folders on PATH", () => {
    const env = agentEnv("codex", { PATH: "/usr/bin", SUREHAND_AE_PANEL_SECRET: "s", AEMCP_PANEL_SECRET: "s", CLAUDECODE: "1" });
    expect(env.SUREHAND_AE_PANEL_SECRET).toBeUndefined();
    expect(env.AEMCP_PANEL_SECRET).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.PATH).toMatch(/\.local[\\/]bin/);
  });
  it("Codex's other MCP servers are read from config.toml tables", () => {
    expect(codexOtherServers('[mcp_servers.a]\n[mcp_servers.a.env]\n[mcp_servers."b-c"]\n[mcp_servers.surehand-ae]\n[other]\n')).toEqual(["a", "b-c"]);
  });
  it("Windows paths become valid TOML strings", () => {
    const { args } = turnCommand({ id: "codex", text: "x", preface: "p", server: { command: "C:\\Users\\Ron\\.surehand\\node\\node.exe", args: ["C:\\a b\\surehand-ae.mjs"] } });
    expect(args).toContain('mcp_servers.surehand-ae.command="C:\\\\Users\\\\Ron\\\\.surehand\\\\node\\\\node.exe"');
  });
});

describe("surehand-ae chat (the built command line the panel runs)", () => {
  const bundle = fileURLToPath(new URL("../dist/surehand-ae.mjs", import.meta.url));
  const env = () => ({ ...process.env, SUREHAND_AE_NO_UPDATE_CHECK: "1", SUREHAND_AE_NO_AUTOSETUP: "1" });
  it.skipIf(!existsSync(bundle))("chat --agents --json", () => {
    const r = spawnSync(process.execPath, [bundle, "chat", "--agents", "--json"], { encoding: "utf8", env: env(), timeout: 30000 });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).agents.map((a: any) => a.id)).toEqual(["codex", "claude", "agy"]);
  });
  it.skipIf(!existsSync(bundle))("chat --agent codex: the message on stdin, events as lines, and a stop line stops it", async () => {
    process.env.FAKE_SCENARIO = "slow";
    const p = spawn(process.execPath, [bundle, "chat", "--agent", "codex"], { env: env() });
    let out = "";
    p.stdout.on("data", (d) => {
      out += d;
      if (/"tool"/.test(out) && !p.stdin.writableEnded) p.stdin.write(JSON.stringify({ stop: true }) + "\n");
    });
    p.stdin.write(JSON.stringify({ text: "Render everything" }) + "\n");
    const code = await new Promise((r) => p.on("close", r));
    expect(code).toBe(0);
    const lines = out.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ type: "session", id: "thread-1" });
    expect(last(lines)).toEqual({ type: "done", ok: true, session: "thread-1", stopped: true });
  });
});
