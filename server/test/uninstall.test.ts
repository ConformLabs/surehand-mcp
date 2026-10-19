import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// a fake home folder, so nothing real is touched
const home = mkdtempSync(join(tmpdir(), "aemcp-uninstall-"));
vi.mock("node:os", async (orig) => ({ ...(await orig<typeof import("node:os")>()), homedir: () => home }));
vi.mock("../src/cli/util.js", async (orig) => ({ ...(await orig<typeof import("../src/cli/util.js")>()), findClaudeCli: () => null }));
process.env.CODEX_HOME = join(home, ".codex");
process.env.APPDATA = join(home, "AppData", "Roaming");

const { uninstall, OWN_FILES } = await import("../src/cli/uninstall.js");

function setup() {
  const dir = join(home, ".aemcp");
  for (const d of ["server", "node", "instances", "tmp", "renders", "checkpoints/abc", "backups"]) mkdirSync(join(dir, d), { recursive: true });
  for (const f of ["config.json", "runtime.json", "extension-hash", "activity.jsonl", "server/ae-mcp.mjs", "checkpoints/abc/v1.aep", "backups/client.aep", "notes.txt"])
    writeFileSync(join(dir, f), "x");
  return dir;
}

describe("uninstall", () => {
  vi.spyOn(console, "log").mockImplementation(() => {});

  it("removes only Surehand MCP's own files and keeps checkpoints and the user's files", () => {
    const dir = setup();
    uninstall([]);
    expect(readdirSync(dir).sort()).toEqual(["backups", "checkpoints", "node", "notes.txt"]);
    expect(existsSync(join(dir, "backups", "client.aep"))).toBe(true);
    expect(existsSync(join(dir, "checkpoints", "abc", "v1.aep"))).toBe(true);
  });

  it("--keep-config also keeps config.json", () => {
    const dir = setup();
    uninstall(["--keep-config"]);
    expect(readdirSync(dir).sort()).toEqual(["backups", "checkpoints", "config.json", "node", "notes.txt"]);
  });

  it("--all removes everything except the running Node", () => {
    const dir = setup();
    uninstall(["--all"]);
    expect(readdirSync(dir)).toEqual(["node"]);
  });

  it("never lists the user's data as its own", () => {
    expect(OWN_FILES).not.toContain("checkpoints");
    expect(OWN_FILES).not.toContain("node");
  });
});
