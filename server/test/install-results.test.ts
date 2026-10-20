// `surehand-ae install`: --clients (only the apps the installers' lists ticked), --connect-only steps that add to the
// results, --disconnect, --tunnel, and the results JSON (~/.surehand/ae/install-result.json) the Windows finish page
// and the top of the Mac install.log are made from. A temporary home; the AI apps, the extension and the cloudflared
// download are stand-ins, so nothing real is touched.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "surehand-install-results-"));
vi.mock("node:os", async (orig) => ({ ...(await orig<typeof import("node:os")>()), homedir: () => home }));

// what is "installed" on this fake computer, and what connecting does
const apps = { installed: new Set(["claude-desktop", "claude-code", "cursor", "vscode"]), fail: new Map<string, string>(), connected: [] as string[], disconnected: [] as string[] };
vi.mock("../src/cli/clients.js", async (orig) => {
  const real = await orig<typeof import("../src/cli/clients.js")>();
  return {
    ...real,
    clientInstalled: (id: string) => apps.installed.has(id),
    connectClient: (id: string) => {
      if (apps.fail.has(id)) return { ok: false, message: `${real.CLIENT_NAMES[id as "cursor"]}: ${apps.fail.get(id)}`, restartHint: null };
      apps.connected.push(id);
      return { ok: true, message: "connected", restartHint: null };
    },
    disconnectClient: (id: string) => {
      apps.disconnected.push(id);
      return { ok: true, message: `${id} is no longer connected`, restartHint: null };
    },
    claudeDesktopRunning: () => false,
    mcpbInstalled: () => false,
    moveFromLegacy: () => ({ status: "not-needed", notes: [], kept: [], repointed: [] }),
    repointLegacyClients: () => [],
  };
});
vi.mock("../src/cli/setup.js", async (orig) => ({
  ...(await orig<typeof import("../src/cli/setup.js")>()),
  ensureExtension: () => ({ installed: true, updated: false }),
  ensureDebugMode: () => false,
  ensureConfig: () => false,
}));
let tunnel: { ok: boolean; path?: string; error?: string; already?: boolean } = { ok: true, path: "/x/cloudflared" };
vi.mock("../src/cli/chatgpt.js", async (orig) => ({ ...(await orig<typeof import("../src/cli/chatgpt.js")>()), installTunnel: async () => tunnel }));

const { install, installResultView, installResultText, installResultFile } = await import("../src/cli/install.js");
const result = () => JSON.parse(readFileSync(installResultFile(), "utf8"));
const outcome = (id: string) => result().clients.find((c: any) => c.id === id)?.outcome;
const rows = () => result().summary.map((r: any) => `${r.kind}: ${r.text}`);

describe("install results and --clients", () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  beforeEach(() => {
    rmSync(join(home, ".surehand"), { recursive: true, force: true });
    apps.fail.clear();
    apps.connected.length = 0;
    apps.disconnected.length = 0;
    process.exitCode = undefined;
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("writes the skill zips either way, but says to upload them only when Claude Desktop is on this computer", async () => {
    const upload = (r: any) => r.next.filter((n: string) => n.startsWith("For Claude Desktop chat: upload the skills")).length;
    await install(["--clients", "none"]);
    expect(result().skills.zips).toHaveLength(4);
    expect(existsSync(result().skills.zips[0])).toBe(true);
    expect(upload(result())).toBe(1);
    apps.installed.delete("claude-desktop");
    try {
      await install(["--clients", "none"]);
      expect(result().skills.zips).toHaveLength(4); // claude.ai on the web takes them too
      expect(existsSync(result().skills.zips[0])).toBe(true);
      expect(result().skills.claudeDesktop).toBe(false);
      expect(upload(result())).toBe(0);
      // a later --connect-only step keeps it that way
      await install(["--connect-only", "--clients", "cursor"]);
      expect(upload(result())).toBe(0);
    } finally {
      apps.installed.add("claude-desktop");
    }
  });

  it("connects only the apps given with --clients, and says what happened to every app", async () => {
    apps.fail.set("cursor", "could not update its settings: EACCES");
    await install(["--clients", "claude-desktop,cursor"]);
    expect(apps.connected).toEqual(["claude-desktop"]);
    const r = result();
    expect(r).toMatchObject({ ok: true, setup: true, version: expect.any(String), afterEffects: expect.any(Array), afterEffectsRunning: expect.any(Boolean) });
    // in the installers' order (installer/ai-apps.json)
    expect(r.clients.map((c: any) => [c.id, c.outcome])).toEqual([
      ["claude-desktop", "connected"], ["claude-code", "not-chosen"], ["cursor", "failed"], ["codex", "not-found"],
      ["vscode", "not-chosen"], ["windsurf", "not-found"], ["lm-studio", "not-found"],
    ]);
    expect(r.clients.find((c: any) => c.id === "cursor").message).toBe("could not update its settings: EACCES");
    expect(rows()).toEqual(expect.arrayContaining([
      "done: Connected Claude Desktop",
      "failed: Cursor not connected: could not update its settings: EACCES",
      "skipped: Not ticked: Claude Code, VS Code",
      "skipped: Not found: ChatGPT desktop / Codex, Windsurf / Devin Desktop, LM Studio",
    ]));
    expect(r.next).toContain("Restart Claude Desktop.");
    expect(r.next).toContain("Ask it “What's in my project?” The Surehand panel (Window › Extensions › Surehand MCP) shows when it's connected.");
  });

  it("without --clients connects every app found (a silent Setup, the zip launchers); none connects none", async () => {
    await install([]);
    expect(apps.connected).toEqual(["claude-desktop", "claude-code", "cursor", "vscode"]);
    apps.connected.length = 0;
    await install(["--clients", "none"]);
    expect(apps.connected).toEqual([]);
    expect(result().clients.map((c: any) => c.outcome)).toEqual(["not-chosen", "not-chosen", "not-chosen", "not-found", "not-chosen", "not-found", "not-found"]);
  });

  it("the installers' steps (--connect-only) add each app to the results of the install before, and exit 3 when it failed", async () => {
    await install(["--clients", "none"]);
    await install(["--connect-only", "--clients", "claude-code"]);
    expect(process.exitCode).toBeUndefined();
    expect(apps.connected).toEqual(["claude-code"]);
    apps.fail.set("cursor", "its settings file can't be read");
    await install(["--connect-only", "--clients", "cursor"]);
    expect(process.exitCode).toBe(3);
    // the setup step's results stay; the steps' apps are updated, nothing else is connected
    expect(result().setup).toBe(true);
    expect([outcome("claude-desktop"), outcome("claude-code"), outcome("cursor"), outcome("codex")]).toEqual(["not-chosen", "connected", "failed", "not-found"]);
    expect(apps.connected).toEqual(["claude-code"]);
  });

  it("--disconnect (an app unticked when updating) disconnects it", async () => {
    await install(["--clients", "none"]);
    await install(["--connect-only", "--disconnect", "claude-desktop"]);
    expect(apps.disconnected).toEqual(["claude-desktop"]);
    expect(outcome("claude-desktop")).toBe("disconnected");
    expect(rows()).toContain("skipped: Disconnected: Claude Desktop");
  });

  it("--tunnel gets cloudflared and reports a failure with where to do it later", async () => {
    await install(["--clients", "none"]);
    tunnel = { ok: false, error: "fetch failed" };
    await install(["--connect-only", "--tunnel"]);
    expect(process.exitCode).toBe(3);
    expect(result().tunnel).toEqual({ outcome: "failed", error: "fetch failed" });
    expect(rows()).toContain("failed: cloudflared not downloaded: fetch failed. Panel › Menu › ChatGPT on the web installs it later.");
    tunnel = { ok: true, path: "/home/x/.surehand/bin/cloudflared" };
    process.exitCode = undefined;
    await install(["--connect-only", "--tunnel"]);
    expect(process.exitCode).toBeUndefined();
    expect(result().tunnel).toEqual({ outcome: "installed", path: "/home/x/.surehand/bin/cloudflared" });
    expect(rows()).toContain("done: cloudflared downloaded for ChatGPT on the web");
  });

  it("ignores an unknown app id (and says so)", async () => {
    const log = vi.mocked(console.log);
    log.mockClear();
    await install(["--clients", "claude-code,notepad"]);
    expect(apps.connected).toEqual(["claude-code"]);
    expect(log.mock.calls.flat().join("\n")).toMatch(/Unknown AI app "notepad"/);
  });

  it("install --summary prints the last results (the top of the Mac install.log)", async () => {
    await install(["--clients", "claude-desktop"]);
    const log = vi.mocked(console.log);
    log.mockClear();
    await install(["--summary"]);
    const text = log.mock.calls.flat().join("\n");
    expect(text).toMatch(/^Surehand MCP .* is installed/);
    expect(text).toContain("[done]    Connected Claude Desktop");
    expect(text).toMatch(/Next:\n {2}1\. /);
    rmSync(installResultFile());
    process.exitCode = undefined;
    await install(["--summary"]);
    expect(process.exitCode).toBe(1);
    expect(existsSync(installResultFile())).toBe(false);
  });
});

describe("the results as the installers show them", () => {
  const base = { ok: true, version: "1.4.0", at: "2026-10-20T00:00:00Z", setup: true, afterEffects: ["After Effects 2025", "After Effects 2026"], afterEffectsRunning: false };
  const three = [
    { id: "claude-desktop", name: "Claude Desktop", outcome: "connected" },
    { id: "claude-code", name: "Claude Code", outcome: "connected" },
    { id: "cursor", name: "Cursor", outcome: "connected" },
    { id: "codex", name: "ChatGPT desktop / Codex", outcome: "not-found" },
  ] as any;

  it("says to restart After Effects only when it is open", () => {
    expect(installResultView({ ...base, clients: three }).next[0]).toBe("Restart Claude Desktop, Claude Code and Cursor.");
    const open = installResultView({ ...base, afterEffectsRunning: true, clients: three });
    expect(open.next).toEqual([
      "Restart After Effects (it is open).",
      "Restart Claude Desktop, Claude Code and Cursor.",
      "Ask one of them “What's in my project?” The Surehand panel (Window › Extensions › Surehand MCP) shows when it's connected.",
    ]);
  });

  it("matches the finish page's rows: connected, not found, the After Effects versions, cloudflared", () => {
    const v = installResultView({ ...base, clients: three, tunnel: { outcome: "failed", error: "no internet" } });
    expect(v.summary).toEqual([
      { kind: "done", text: "Connected Claude Desktop, Claude Code, Cursor" },
      { kind: "skipped", text: "Not found: ChatGPT desktop / Codex" },
      { kind: "done", text: "Adobe® After Effects® 2025, 2026" },
      { kind: "failed", text: "cloudflared not downloaded: no internet. Panel › Menu › ChatGPT on the web installs it later." },
    ]);
    expect(installResultView({ ...base, afterEffects: [], clients: [] })).toEqual({
      summary: [{ kind: "skipped", text: "Adobe® After Effects® not found. The panel loads once it is installed." }],
      next: ["Open After Effects and connect an AI app in the Surehand panel (Window › Extensions › Surehand MCP)."],
    });
    expect(installResultText({ ...base, clients: three, ...installResultView({ ...base, clients: three }) })).toContain("[skipped] Not found: ChatGPT desktop / Codex");
  });
});
