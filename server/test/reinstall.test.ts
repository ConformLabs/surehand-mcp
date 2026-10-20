// Reinstalling after an uninstall that kept the settings, on a computer that had moved from 1.3 (~/.aemcp). Seen on
// Windows with 1.4.0-beta.3: the uninstall left only ~/.aemcp/node (a copy of Node.js the move left because it was
// in use), the next install took that for a 1.3 installation and wrote its results, a server and compatibility
// files into ~/.aemcp. A temporary home; AI apps and the extension are stand-ins, so nothing real is touched.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "surehand-reinstall-"));
vi.mock("node:os", async (orig) => ({ ...(await orig<typeof import("node:os")>()), homedir: () => home }));
vi.mock("../src/cli/util.js", async (orig) => ({ ...(await orig<typeof import("../src/cli/util.js")>()), findClaudeCli: () => null }));
process.env.CODEX_HOME = join(home, ".codex");
process.env.APPDATA = join(home, "AppData", "Roaming");
delete process.env.AEMCP_CONFIG;
delete process.env.SUREHAND_AE_CONFIG;

// what install gave each AI app to run
const entries = new Map<string, { command: string; args: string[] }>();
vi.mock("../src/cli/clients.js", async (orig) => {
  const real = await orig<typeof import("../src/cli/clients.js")>();
  return {
    ...real,
    clientInstalled: (id: string) => id === "cursor",
    connectClient: (id: string, entry: { command: string; args: string[] }) => (entries.set(id, entry), { ok: true, message: "connected", restartHint: null }),
    disconnectClient: () => ({ ok: true, message: "", restartHint: null }),
    claudeDesktopRunning: () => false,
    mcpbInstalled: () => false,
  };
});
vi.mock("../src/cli/setup.js", async (orig) => ({
  ...(await orig<typeof import("../src/cli/setup.js")>()),
  ensureExtension: () => ({ installed: true, updated: false }),
  ensureDebugMode: () => false,
}));

const { install } = await import("../src/cli/install.js");
const { uninstall } = await import("../src/cli/uninstall.js");
const { migrateLegacy, lateMerge } = await import("../src/migrate.js");
const { appDir, configPath, installedServer, migrationPending, privateNodeDir } = await import("../src/paths.js");

const L = join(home, ".aemcp"), R = join(home, ".surehand"), A = join(R, "ae");
const TOKEN = "t".repeat(48);
const put = (file: string, text = "x") => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const read = (file: string) => readFileSync(file, "utf8");
const ls = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

/** Node.js as each platform lays it out: bin/node (macOS), node.exe (Windows). */
const LAYOUTS = { mac: join("bin", "node"), win: "node.exe" } as const;

/** A 1.3 installation with the user's settings, checkpoints and history. */
function legacyInstall(nodeExe: string) {
  put(join(L, "node", nodeExe), "node 22");
  put(join(L, "server", "ae-mcp.mjs"), "server 1.3.4");
  put(join(L, "config.json"), JSON.stringify({ token: TOKEN, bridgePort: 8765, httpPort: 8766, permissions: { mode: "read-only" } }));
  put(join(L, "runtime.json"), JSON.stringify({ node: join(L, "node", nodeExe), server: join(L, "server", "ae-mcp.mjs") }));
  put(join(L, "instances", "8765.json"), "{}");
  put(join(L, "extension-hash"), "abc");
  const cp = join(L, "checkpoints", "Spot-1");
  put(join(cp, "v1.aep"), "aep v1");
  put(join(cp, "index.json"), JSON.stringify([{ id: "1", file: join(cp, "v1.aep"), project: "/work/Spot.aep" }]));
  put(join(L, "history", "Spot-1", "index.json"), '["h"]');
}

/** What the Windows Setup puts in place before it runs `surehand-ae install`: Node.js and the server. */
function setupCopiesFiles(nodeExe: string) {
  put(join(R, "node", nodeExe), "node 24");
  put(join(A, "server", "surehand-ae.mjs"), "server 1.4");
}

/** The move from 1.3 with a Node.js in use (Windows): it is copied, the original stays as a real folder. */
function moveWithNodeInUse() {
  const r = migrateLegacy({
    platform: "win32",
    rename: (from, to) => {
      if (path.basename(from) === "node") throw Object.assign(new Error("in use"), { code: "EPERM" });
      renameSync(from, to);
    },
  });
  expect(r.status).toBe("migrated");
  expect(lstatSync(join(L, "node")).isSymbolicLink()).toBe(false);
}

/** After an install everything is in ~/.surehand/ae, and AI apps run the server from there. */
function expectInstalledInNewPlace() {
  expect(appDir()).toBe(A);
  expect(existsSync(join(A, "install-result.json"))).toBe(true);
  expect(JSON.parse(read(join(A, "config.json"))).token).toBe(TOKEN);
  expect(configPath()).toBe(join(A, "config.json"));
  expect(installedServer()).toBe(join(A, "server", "surehand-ae.mjs"));
  expect(entries.get("cursor")?.args).toEqual([join(A, "server", "surehand-ae.mjs")]);
  expect(read(join(A, "checkpoints", "Spot-1", "v1.aep"))).toBe("aep v1");
  expect(read(join(A, "history", "Spot-1", "index.json"))).toBe('["h"]');
  for (const n of ["install-result.json", "activity.jsonl", "checkpoints", "history"]) expect(existsSync(join(L, n)), n).toBe(false);
}

describe("reinstall after an uninstall that kept the settings", () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  beforeEach(() => {
    for (const d of [L, R, join(home, ".claude"), join(home, ".agents")]) rmSync(d, { recursive: true, force: true });
    entries.clear();
    process.exitCode = undefined;
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  for (const [os, nodeExe] of Object.entries(LAYOUTS)) {
    it(`${os}: the sequence seen on Windows: moved install, uninstall /S (keeps settings), Setup /S`, async () => {
      legacyInstall(nodeExe);
      moveWithNodeInUse();
      expect(ls(L)).toEqual(["MOVED.txt", "config.json", "instances", "node", "runtime.json", "server"]);

      // Uninstall /S: `surehand-ae uninstall --keep-config`, run by ~/.surehand/node (not by ~/.aemcp/node)
      uninstall(["--keep-config"]);
      expect(existsSync(L)).toBe(false); // the copy of Node.js is ours and goes with the rest
      expect(JSON.parse(read(join(A, "config.json"))).token).toBe(TOKEN);

      // Setup /S
      setupCopiesFiles(nodeExe);
      await install([]);
      expectInstalledInNewPlace();
      expect(existsSync(L)).toBe(false);
    });

    it(`${os}: a Node.js copy that stays in ~/.aemcp (in use during the uninstall) never makes it a 1.3 installation again`, async () => {
      legacyInstall(nodeExe);
      moveWithNodeInUse();
      uninstall(["--keep-config"]);
      // what 1.4.0-beta.3's uninstall left: only ~/.aemcp/node, a real folder
      put(join(L, "node", nodeExe), "node 22");
      expect(migrationPending()).toBe(false);
      expect(appDir()).toBe(A);
      expect(privateNodeDir()).toBe(join(R, "node"));

      setupCopiesFiles(nodeExe);
      await install([]);
      expectInstalledInNewPlace();
      expect(ls(L)).toEqual(["node"]); // nothing was written next to it
    });
  }

  it("a 1.3 installation with real data still moves on install (and the results land in ~/.surehand/ae)", async () => {
    legacyInstall(LAYOUTS.win);
    setupCopiesFiles(LAYOUTS.win);
    expect(migrationPending()).toBe(true);
    await install([]);
    expectInstalledInNewPlace();
    expect(JSON.parse(read(join(A, "config.json"))).permissions).toEqual({ mode: "read-only" });
    expect(ls(L)).toEqual(["MOVED.txt", "config.json", "instances", "node", "runtime.json", "server"]);
    expect(read(join(L, "server", "ae-mcp.mjs"))).toMatch(/await import/);
  });

  it("repair: a computer the bug already wrote into ~/.aemcp comes out right on the next install, keeping the settings", async () => {
    // after the move and an uninstall that kept config.json, checkpoints and history
    const cp = join(A, "checkpoints", "Spot-1");
    put(join(cp, "v1.aep"), "aep v1");
    put(join(cp, "index.json"), "[]");
    put(join(A, "history", "Spot-1", "index.json"), '["h"]');
    put(join(A, "config.json"), JSON.stringify({ token: TOKEN, bridgePort: 8765, httpPort: 8766, permissions: { mode: "full" } }));
    setupCopiesFiles(LAYOUTS.win);
    // what beta.3's install wrote into ~/.aemcp (after moving the leftover Node.js "away")
    put(join(L, "MOVED.txt"), "moved");
    put(join(L, "config.json"), read(join(A, "config.json")));
    put(join(L, "install-result.json"), '{"version":"1.4.0-beta.3"}');
    mkdirSync(join(L, "instances"), { recursive: true });
    put(join(L, "server", "ae-mcp.mjs"), "the whole 1.4.0-beta.3 server");
    put(join(L, "node", "node.exe"), "node 22");
    // and a checkpoint the server it registered wrote there meanwhile
    put(join(L, "checkpoints", "Late-2", "v.aep"), "late aep");
    put(join(L, "checkpoints", "Late-2", "index.json"), JSON.stringify([{ file: join(L, "checkpoints", "Late-2", "v.aep") }]));
    expect(migrationPending()).toBe(false);

    await install([]);
    expectInstalledInNewPlace();
    expect(JSON.parse(read(join(A, "config.json"))).permissions).toEqual({ mode: "full" });
    // the stale results went, the server file forwards to the real one again, the checkpoint moved with its index
    expect(JSON.parse(read(join(A, "install-result.json"))).version).not.toBe("1.4.0-beta.3");
    expect(read(join(L, "server", "ae-mcp.mjs"))).toMatch(/await import\(".*surehand-ae\.mjs"\)/);
    expect(read(join(A, "checkpoints", "Late-2", "v.aep"))).toBe("late aep");
    expect(JSON.parse(read(join(A, "checkpoints", "Late-2", "index.json")))[0].file).toBe(join(A, "checkpoints", "Late-2", "v.aep"));
    expect(ls(L)).toEqual(["MOVED.txt", "config.json", "instances", "node", "server"]);
    expect(read(join(R, "migration.log"))).toMatch(/merged checkpoints, install-result\.json .*repaired in .*server\/ae-mcp\.mjs forwards again/);
    // and the next start has nothing left to do
    expect(lateMerge()).toMatchObject({ merged: [], repaired: [] });
    // an uninstall now leaves nothing in ~/.aemcp
    uninstall(["--keep-config"]);
    expect(existsSync(L)).toBe(false);
  });

  it("repair, when ~/.aemcp got data and no MOVED.txt: it is merged back, the settings in ~/.surehand/ae win, nothing is lost", async () => {
    put(join(A, "config.json"), JSON.stringify({ token: TOKEN, bridgePort: 8765, httpPort: 8766 }));
    put(join(A, "history", "Spot-1", "index.json"), '["h"]');
    put(join(A, "checkpoints", "Spot-1", "v1.aep"), "aep v1");
    setupCopiesFiles(LAYOUTS.win);
    put(join(L, "config.json"), JSON.stringify({ token: "o".repeat(48), bridgePort: 8765, httpPort: 8766 }));
    put(join(L, "install-result.json"), "{}");
    put(join(L, "server", "ae-mcp.mjs"), "the whole server");
    put(join(L, "node", "node.exe"), "node 22");
    put(join(L, "activity.jsonl"), '{"tool":"ae_status"}\n');
    expect(migrationPending()).toBe(true);

    await install([]);
    expectInstalledInNewPlace();
    expect(JSON.parse(read(join(A, "config.json.from-aemcp"))).token).toBe("o".repeat(48)); // kept under the usual clash name
    expect(read(join(A, "activity.jsonl"))).toMatch(/ae_status/);
    expect(read(join(L, "server", "ae-mcp.mjs"))).toMatch(/await import/);
  });

  it("on macOS the move's link at ~/.aemcp/node is only a leftover too", () => {
    put(join(R, "node", "bin", "node"), "node 24");
    mkdirSync(L, { recursive: true });
    symlinkSync(join(R, "node"), join(L, "node"), "dir");
    expect(migrationPending()).toBe(false);
    expect(appDir()).toBe(A);
  });
});
