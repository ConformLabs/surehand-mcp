import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  rmSync(join(home, ".aemcp"), { recursive: true, force: true });
  const dir = join(home, ".surehand", "ae");
  for (const d of ["server", "node", "instances", "tmp", "renders", "checkpoints/abc", "backups"]) mkdirSync(join(dir, d), { recursive: true });
  for (const f of ["config.json", "runtime.json", "extension-hash", "activity.jsonl", "server/surehand-ae.mjs", "checkpoints/abc/v1.aep", "backups/client.aep", "notes.txt"])
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

  it("after the move from 1.3: also removes what was left in ~/.aemcp for the old extension, and the shared Node.js when no other Surehand app uses it", () => {
    const dir = setup();
    rmSync(join(dir, "node"), { recursive: true, force: true });
    const R = join(home, ".surehand");
    mkdirSync(join(R, "node", "bin"), { recursive: true });
    writeFileSync(join(R, "node", "bin", "node"), "node");
    const L = join(home, ".aemcp");
    for (const d of ["server", "instances"]) mkdirSync(join(L, d), { recursive: true });
    for (const f of ["MOVED.txt", "config.json", "runtime.json", "server/ae-mcp.mjs"]) writeFileSync(join(L, f), "x");
    symlinkSync(join(R, "node"), join(L, "node"), process.platform === "win32" ? "junction" : "dir");
    uninstall([]);
    expect(existsSync(L)).toBe(false);
    expect(existsSync(join(R, "node"))).toBe(false); // not running this process (else the launcher removes it after us)
    expect(readdirSync(dir).sort()).toEqual(["backups", "checkpoints", "notes.txt"]);
  });

  it("keeps the shared Node.js while another Surehand app is installed", () => {
    setup();
    const R = join(home, ".surehand");
    mkdirSync(join(R, "node", "bin"), { recursive: true });
    mkdirSync(join(R, "ps"), { recursive: true });
    writeFileSync(join(R, "node", "bin", "node"), "node");
    uninstall([]);
    expect(readdirSync(R).sort()).toEqual(["ae", "node", "ps"]);
    rmSync(join(R, "ps"), { recursive: true });
  });

  it("removes both names from AI apps, and only ours", () => {
    setup();
    const cursor = join(home, ".cursor", "mcp.json");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const foreign = { command: "/opt/x", args: [] };
    writeFileSync(cursor, JSON.stringify({ mcpServers: { "surehand-ae": { command: "node", args: ["/h/.surehand/ae/server/surehand-ae.mjs"] }, "after-effects": foreign, other: foreign } }));
    uninstall([]);
    expect(JSON.parse(readFileSync(cursor, "utf8")).mcpServers).toEqual({ "after-effects": foreign, other: foreign });
    writeFileSync(cursor, JSON.stringify({ mcpServers: { "after-effects": { command: "node", args: ["/h/.aemcp/server/ae-mcp.mjs"] } } }));
    uninstall([]);
    expect(JSON.parse(readFileSync(cursor, "utf8")).mcpServers).toEqual({});
  });

  it("never lists the user's data as its own", () => {
    expect(OWN_FILES).not.toContain("checkpoints");
    expect(OWN_FILES).not.toContain("node");
  });
});
