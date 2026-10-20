// Which AI apps are on this computer (`clients --json`, the installers' app lists, `install`): on a Mac and on
// Windows the app itself, never a data folder an uninstalled app left behind (~/.lmstudio, Code/User, ~/.codeium,
// ~/.cursor, ~/.codex, Application Support/Claude). Runs as a Mac and as Windows on any machine: the platform is
// faked, the home folder is temporary and /Applications is a stand-in, so nothing real is looked at.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

let plat: NodeJS.Platform = "darwin";
vi.mock("node:os", async (orig) => ({ ...(await orig<typeof import("node:os")>()), platform: () => plat }));
// /Applications: what this fake Mac has there
const systemApps = new Set<string>();
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  const existsSync = (p: any) => (String(p).startsWith("/Applications/") ? systemApps.has(String(p)) : real.existsSync(p));
  return { ...real, existsSync, default: { ...real, existsSync } };
});
// no command on PATH (`which` / `where`)
vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), spawnSync: () => ({ status: 1, stdout: "", stderr: "" }) }));

let home = "";
const dir = (...p: string[]) => mkdirSync(join(home, ...p), { recursive: true });
const file = (p: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "{}");
};

async function load(p: NodeJS.Platform) {
  plat = p;
  vi.resetModules();
  return { clients: await import("../src/cli/clients.js"), util: await import("../src/cli/util.js") };
}

/** The data folders the apps leave behind when they are uninstalled. */
function leftovers(util: typeof import("../src/cli/util.js")) {
  file(util.lmStudioConfig());
  dir(".lmstudio", "conversations");
  file(util.vscodeConfig());
  file(util.windsurfLegacyConfig());
  file(util.devinConfig());
  file(util.cursorConfig());
  file(util.codexConfig());
  file(util.claudeDesktopConfig());
}

const APPS = ["claude-desktop", "codex", "cursor", "vscode", "windsurf", "lm-studio"] as const;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "surehand-apps-"));
  process.env.HOME = process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.LOCALAPPDATA = join(home, "AppData", "Local");
  process.env.ProgramFiles = join(home, "Program Files");
  delete process.env.CODEX_HOME;
  delete process.env.XDG_CONFIG_HOME;
  systemApps.clear();
});

describe("Mac", () => {
  it("a leftover data folder of an uninstalled app doesn't count as the app", async () => {
    const { clients, util } = await load("darwin");
    leftovers(util);
    for (const id of APPS) expect([id, clients.clientInstalled(id)]).toEqual([id, false]);
  });

  it("the app in /Applications or ~/Applications does", async () => {
    const { clients } = await load("darwin");
    for (const a of ["LM Studio", "Visual Studio Code", "Cursor", "Claude", "ChatGPT"]) systemApps.add(`/Applications/${a}.app`);
    dir("Applications", "Windsurf.app");
    for (const id of APPS) expect([id, clients.clientInstalled(id)]).toEqual([id, true]);
  });

  it("an existing connection still counts as connected without the app", async () => {
    const { clients, util } = await load("darwin");
    mkdirSync(dirname(util.lmStudioConfig()), { recursive: true });
    writeFileSync(util.lmStudioConfig(), JSON.stringify({ mcpServers: { "surehand-ae": { command: "node", args: ["/x/surehand-ae.mjs"] } } }));
    expect(clients.clientInfo("lm-studio")).toMatchObject({ installed: false, configured: true });
  });

  it("Codex and the Cursor CLI without an app: their command in its usual place", async () => {
    const { clients } = await load("darwin");
    file(join(home, ".local", "bin", "cursor-agent"));
    file(join(home, ".nvm", "versions", "node", "v22.1.0", "bin", "codex"));
    expect(clients.clientInstalled("cursor")).toBe(true);
    expect(clients.clientInstalled("codex")).toBe(true);
  });
});

describe("Windows", () => {
  it("a leftover data folder of an uninstalled app doesn't count as the app", async () => {
    const { clients, util } = await load("win32");
    leftovers(util);
    for (const id of APPS) expect([id, clients.clientInstalled(id)]).toEqual([id, false]);
  });

  it("the app where its installer puts it does", async () => {
    const { clients } = await load("win32");
    for (const p of ["LM Studio", "Microsoft VS Code", "cursor", "Windsurf", "ChatGPT"]) dir("AppData", "Local", "Programs", p);
    dir("AppData", "Local", "AnthropicClaude");
    for (const id of APPS) expect([id, clients.clientInstalled(id)]).toEqual([id, true]);
  });

  it("Claude Desktop from the Microsoft Store package, VS Code for all users", async () => {
    const { clients } = await load("win32");
    dir("AppData", "Local", "Packages", "Claude_pzs8sxrjxfjjc");
    dir("Program Files", "Microsoft VS Code");
    expect(clients.clientInstalled("claude-desktop")).toBe(true);
    expect(clients.clientInstalled("vscode")).toBe(true);
  });
});

describe("LM Studio without its app: llmster, the headless LM Studio", () => {
  for (const p of ["darwin", "win32"] as const)
    it(`${p}: llmster installed counts (it runs mcp.json's servers for the REST API); an empty llmster folder doesn't`, async () => {
      const { clients, util } = await load(p);
      leftovers(util);
      dir(".lmstudio", "bin");
      dir(".lmstudio", "llmster");
      expect(clients.clientInstalled("lm-studio")).toBe(false);
      dir(".lmstudio", "llmster", "0.0.12-3");
      expect(clients.clientInstalled("lm-studio")).toBe(true);
    });
});

describe("Linux (no one place for apps)", () => {
  it("the settings folders, as before", async () => {
    const { clients, util } = await load("linux");
    leftovers(util);
    for (const id of APPS) expect([id, clients.clientInstalled(id)]).toEqual([id, true]);
  });
});
