// After the move from 1.3, Claude Code's settings are changed through its own `claude mcp` command (it
// owns ~/.claude.json and may rewrite it any time), not by editing the file. A fake `claude` records
// what it was asked; temporary home folder.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

let fakeClaude = "";
vi.mock("../src/cli/util.js", async (orig) => ({ ...(await orig<typeof import("../src/cli/util.js")>()), findClaudeCli: () => fakeClaude || null }));
const util = await import("../src/cli/util.js");
const clients = await import("../src/cli/clients.js");

let home = "";
const put = (file: string, data: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "surehand-claude-cli-"));
  process.env.HOME = process.env.USERPROFILE = home;
  process.env.CODEX_HOME = join(home, ".codex");
  process.env.APPDATA = join(home, "AppData", "Roaming");
  fakeClaude = join(home, "bin", "claude");
  put(fakeClaude, `#!/bin/sh\necho "$@" >> "${join(home, "claude-calls.txt")}"\n`);
  chmodSync(fakeClaude, 0o755);
});

describe.skipIf(process.platform === "win32")("repointing Claude Code", () => {
  it("uses `claude mcp remove/add` when the command line is there, and doesn't touch ~/.claude.json itself", () => {
    const L = join(home, ".aemcp");
    const before = JSON.stringify({ projects: { "/x": {} }, mcpServers: { "after-effects": { type: "stdio", command: join(L, "node", "bin", "node"), args: [join(L, "server", "ae-mcp.mjs")], env: {} } } }, null, 2);
    put(util.claudeCodeConfig(), before);
    expect(clients.repointLegacyClients()).toEqual(["Claude Code"]);
    const calls = readFileSync(join(home, "claude-calls.txt"), "utf8").trim().split("\n");
    expect(calls).toEqual([
      "mcp remove after-effects --scope user",
      `mcp add --scope user surehand-ae -- ${join(home, ".surehand", "node", "bin", "node")} ${join(home, ".surehand", "ae", "server", "surehand-ae.mjs")}`,
    ]);
    expect(readFileSync(util.claudeCodeConfig(), "utf8")).toBe(before);
  });

  it("does nothing when no entry names ~/.aemcp", () => {
    put(util.claudeCodeConfig(), { mcpServers: { "surehand-ae": { command: "node", args: [join(home, ".surehand", "ae", "server", "surehand-ae.mjs")] } } });
    expect(clients.repointLegacyClients()).toEqual([]);
    expect(() => readFileSync(join(home, "claude-calls.txt"), "utf8")).toThrow();
  });
});

describe("cmd.exe command lines (Windows: claude.cmd)", () => {
  it("quotes every argument so cmd.exe passes it through unchanged", () => {
    const line = util.cmdExeLine("C:\\Users\\Ron Y\\AppData\\Roaming\\npm\\claude.cmd", ["mcp", "add", "--", "C:\\Program Files\\nodejs\\node.exe", "C:\\a&b|c\\x %PATH% \"q\".mjs"]);
    // the whole line is one quoted string for /s /c; metacharacters are escaped with ^ (twice for a .cmd shim)
    expect(line.startsWith('"') && line.endsWith('"')).toBe(true);
    expect(line).toContain("C:\\Users\\Ron^ Y\\AppData");
    expect(line).not.toMatch(/[^^]&/);
    expect(line).not.toMatch(/[^^]\|/);
    expect(line).not.toMatch(/[^^]%PATH/);
    expect(line).toContain('^^^"mcp^^^"');
  });
});
