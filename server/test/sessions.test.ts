// The server tells the Surehand panel which AI app is connected: sessions/<pid>.json from the app's hello (MCP
// initialize) until it disconnects. Runs the built server with a temporary home; After Effects is never reached.
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bundle = fileURLToPath(new URL("../dist/surehand-ae.mjs", import.meta.url));
const waitFor = async (cond: () => boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe.skipIf(!existsSync(bundle))("connected AI apps (sessions)", () => {
  it("writes the app's name when it says hello and removes it when it disconnects", async () => {
    const home = mkdtempSync(join(tmpdir(), "surehand-sessions-"));
    const dir = join(home, ".surehand", "ae");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ token: "t", bridgePort: 1, httpPort: 1 }));
    const p = spawn(process.execPath, [bundle], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, SUREHAND_AE_NO_UPDATE_CHECK: "1", SUREHAND_AE_NO_AUTOSETUP: "1", SUREHAND_AE_BRIDGE_PORT: "1" },
    });
    const file = join(dir, "sessions", `${p.pid}.json`);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "0.14.1" } } }) + "\n");
    await waitFor(() => out.includes('"id":1'));
    expect(existsSync(file)).toBe(false); // not before the app confirms
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await waitFor(() => existsSync(file));
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ pid: p.pid, client: "claude-ai", clientVersion: "0.14.1" });
    p.stdin.end(); // the AI app quits
    await waitFor(() => !existsSync(file));
    await new Promise((r) => (p.exitCode !== null ? r(null) : p.on("exit", r)));
  }, 20_000);

  it("a server that was killed (as an AI app ending it on Windows does) leaves its file: the next one removes it", async () => {
    const home = mkdtempSync(join(tmpdir(), "surehand-sessions-"));
    const dir = join(home, ".surehand", "ae");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ token: "t", bridgePort: 1, httpPort: 1 }));
    const start = async () => {
      const p = spawn(process.execPath, [bundle], {
        stdio: ["pipe", "pipe", "ignore"],
        env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, SUREHAND_AE_NO_UPDATE_CHECK: "1", SUREHAND_AE_NO_AUTOSETUP: "1", SUREHAND_AE_BRIDGE_PORT: "1" },
      });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } } }) + "\n");
      await waitFor(() => out.includes('"id":1'));
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      await waitFor(() => existsSync(join(dir, "sessions", `${p.pid}.json`)));
      return p;
    };
    const first = await start();
    first.kill("SIGKILL");
    await new Promise((r) => (first.exitCode !== null || first.signalCode !== null ? r(null) : first.on("exit", r)));
    const stale = join(dir, "sessions", `${first.pid}.json`);
    expect(existsSync(stale)).toBe(true);
    const second = await start();
    await waitFor(() => !existsSync(stale));
    expect(existsSync(join(dir, "sessions", `${second.pid}.json`))).toBe(true);
    second.stdin.end();
    await new Promise((r) => (second.exitCode !== null ? r(null) : second.on("exit", r)));
  }, 30_000);
});
