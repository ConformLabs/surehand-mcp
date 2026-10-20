// The built command line (dist/surehand-ae.mjs, kept in sync with the source by CI): commands the panel
// spawns answer and exit; an unknown command never starts the MCP server. Temporary home, no After Effects.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bundle = fileURLToPath(new URL("../dist/surehand-ae.mjs", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "surehand-cli-"));
const run = (...args: string[]) =>
  spawnSync(process.execPath, [bundle, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), CODEX_HOME: join(home, ".codex"), SUREHAND_AE_NO_UPDATE_CHECK: "1", SUREHAND_AE_NO_AUTOSETUP: "1", SUREHAND_AE_BRIDGE_PORT: "1" },
  });

describe.skipIf(!existsSync(bundle))("surehand-ae command line", () => {
  it("an unknown command is an error, not a server waiting on stdin", () => {
    const r = run("frobnicate");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Unknown command "frobnicate"/);
    const j = run("frobnicate", "--json");
    expect(j.status).toBe(2);
    expect(JSON.parse(j.stdout)).toEqual({ ok: false, error: expect.stringMatching(/Unknown command/) });
  });

  it("clients --json and connect --json answer with the panel's shapes", () => {
    const c = run("clients", "--json");
    expect(c.status).toBe(0);
    expect(JSON.parse(c.stdout).clients.map((x: any) => x.id)).toEqual(["claude-desktop", "claude-code", "codex", "cursor", "vscode", "windsurf", "lm-studio", "chatgpt-web"]);
    const k = run("connect", "nope", "--json");
    expect(k.status).toBe(1);
    expect(JSON.parse(k.stdout)).toEqual({ ok: false, message: expect.stringMatching(/Unknown app "nope"/) });
  });

  it("clients --json tells the panel why the last install could not connect an app, while it still isn't connected", () => {
    mkdirSync(join(home, ".surehand", "ae"), { recursive: true });
    writeFileSync(join(home, ".surehand", "ae", "install-result.json"), JSON.stringify({ clients: [{ id: "cursor", outcome: "failed", message: "its settings file can't be read" }, { id: "codex", outcome: "not-found" }] }));
    const c = JSON.parse(run("clients", "--json").stdout).clients;
    expect(c.find((x: any) => x.id === "cursor").note).toBe("not connected during setup: its settings file can't be read");
    expect(c.find((x: any) => x.id === "codex").note).toBeUndefined();
    rmSync(join(home, ".surehand", "ae", "install-result.json"));
  });
});
