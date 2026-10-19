import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

  it("--keep-config keeps the config in use only: the token copy left in ~/.aemcp for the 1.3 extension goes (L8)", () => {
    const dir = setup();
    const L = join(home, ".aemcp");
    mkdirSync(L, { recursive: true });
    for (const f of ["MOVED.txt", "config.json"]) writeFileSync(join(L, f), "x");
    uninstall(["--keep-config"]);
    expect(existsSync(join(dir, "config.json"))).toBe(true);
    expect(existsSync(join(L, "config.json"))).toBe(false);
    expect(existsSync(L)).toBe(false);
  });
});

// The launchers' uninstall without Node.js (installer/run.sh, run.ps1) must remove only what the server's
// uninstaller would: never checkpoints, backups, history, proofs or unknown files (H4, L3).
describe("uninstall without Node.js (installer launchers)", () => {
  const ROOT = new URL("../../installer/", import.meta.url);
  const own = (text: string, re: RegExp) => [...(re.exec(text)?.[1] ?? "").matchAll(/[\w.-]+/g)].map((m) => m[0]);

  it("run.sh and run.ps1 carry the same list of our own files as the server", () => {
    const sh = readFileSync(new URL("run.sh", ROOT), "utf8");
    const ps = readFileSync(new URL("run.ps1", ROOT), "utf8");
    expect(own(sh, /^OWN_FILES="([^"]*)"/m)).toEqual(OWN_FILES);
    expect(own(ps, /^\$ownFiles = @\(([^)]*)\)/m).filter((x) => x !== "")).toEqual(OWN_FILES);
    // no wholesale removal of the data folders any more
    expect(sh).not.toMatch(/rm -rf[^\n]*"\$SUREHAND\/ae"/);
    expect(sh).not.toMatch(/rm -rf[^\n]*"\$HOME\/\.aemcp"/);
    expect(ps).not.toMatch(/Remove-Item[^\n]*\(Join-Path \$surehand "ae"\)/);
    // the Windows uninstaller keeps the shared Node.js for another Surehand app
    const nsi = readFileSync(new URL("windows/nsis/surehand-mcp.nsi", ROOT), "utf8");
    expect(nsi).toMatch(/another Surehand app uses it[\s\S]*RMDir \/r "\$\{NODE_DIR\}"/);
  });

  it.skipIf(process.platform === "win32")("run.sh uninstall (no Node.js) keeps the user's data and the Node.js another Surehand app uses", () => {
    const h = mkdtempSync(join(tmpdir(), "surehand-runsh-"));
    const A = join(h, ".surehand", "ae"), L = join(h, ".aemcp"), R = join(h, ".surehand");
    for (const d of ["server", "instances", "renders", "checkpoints/Spot-1", "history", "proofs/p1", "backups"]) mkdirSync(join(A, d), { recursive: true });
    for (const f of ["config.json", "runtime.json", "activity.jsonl", "server/surehand-ae.mjs", "checkpoints/Spot-1/v1.aep", "history/x.json", "proofs/p1/m.json", "backups/client.aep", "my notes.txt"])
      writeFileSync(join(A, f), "x");
    mkdirSync(join(L, "checkpoints", "Old-1"), { recursive: true });
    for (const f of ["MOVED.txt", "config.json", "checkpoints/Old-1/v.aep"]) writeFileSync(join(L, f), "x");
    mkdirSync(join(R, "node", "bin"), { recursive: true });
    mkdirSync(join(R, "ps"), { recursive: true }); // another Surehand app
    const run = () =>
      spawnSync("bash", [fileURLToPath(new URL("run.sh", ROOT)), "uninstall"], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", HOME: h, SUREHAND_AE_FORCE_NODE_DOWNLOAD: "1", SUREHAND_AE_BRIDGE_PORT: "1", AEMCP_BRIDGE_PORT: "1" },
      });
    const r = run();
    expect(r.status).toBe(0);
    expect(readdirSync(A).sort()).toEqual(["backups", "checkpoints", "history", "my notes.txt", "proofs"]);
    expect(readdirSync(L)).toEqual(["checkpoints"]);
    expect(r.stdout).toMatch(/Kept your files in .*\.surehand\/ae: .*checkpoints/);
    expect(existsSync(join(R, "node"))).toBe(true); // "ps" still needs it
    expect(r.stdout).toMatch(/another Surehand app uses it/);
    // without another app, the shared Node.js goes
    rmSync(join(R, "ps"), { recursive: true });
    run();
    expect(existsSync(join(R, "node"))).toBe(false);
    expect(readFileSync(join(A, "checkpoints", "Spot-1", "v1.aep"), "utf8")).toBe("x");
  });
});
