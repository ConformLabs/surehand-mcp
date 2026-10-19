// `surehand-ae chatgpt --background / --status / --stop` (the panel's ChatGPT screen), with the built command
// line, a temporary home and a fake `cloudflared` on the PATH (it prints a trycloudflare address and waits).
// The real HTTP server runs on a free port; nothing reaches the internet or After Effects.
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bundle = fileURLToPath(new URL("../dist/surehand-ae.mjs", import.meta.url));
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as any).port;
      s.close(() => resolve(p));
    });
  });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (cond: () => boolean, ms = 15_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
};

function setup(withTunnel: boolean, port: number) {
  const home = mkdtempSync(join(tmpdir(), "surehand-chatgpt-"));
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  if (withTunnel) {
    // like cloudflared: the address on stderr, then it keeps running (exec: the same process, its pid recorded)
    writeFileSync(
      join(bin, "cloudflared"),
      `#!/bin/sh\necho $$ > "${join(home, "tunnel.pid")}"\necho "INF |  https://fake-tunnel-42.trycloudflare.com  |" >&2\nexec sleep 300\n`,
    );
    chmodSync(join(bin, "cloudflared"), 0o755);
  }
  const dir = join(home, ".surehand", "ae");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ token: "tok123secret", bridgePort: 1, httpPort: port }), { mode: 0o600 });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [bundle, ...args], {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: `${bin}:/usr/bin:/bin`, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"),
        SUREHAND_AE_NO_UPDATE_CHECK: "1", SUREHAND_AE_NO_AUTOSETUP: "1", SUREHAND_AE_BRIDGE_PORT: "1", SUREHAND_AE_TUNNEL_PATH_ONLY: "1",
      },
    });
  const json = (...args: string[]) => {
    const r = run(...args, "--json");
    return JSON.parse(r.stdout.trim().split("\n").pop()!);
  };
  return { home, run, json, statusFile: join(dir, "chatgpt.json") };
}

const homes: { json: (...a: string[]) => any }[] = [];
afterAll(() => {
  for (const h of homes) try { h.json("chatgpt", "--stop"); } catch {}
});

describe.skipIf(!existsSync(bundle) || process.platform === "win32")("chatgpt in the background", () => {
  it("starts server + tunnel detached, reports the address, reuses the running one, and stops everything", async () => {
    const port = await freePort();
    const h = setup(true, port);
    homes.push(h);
    expect(h.json("chatgpt", "--status")).toMatchObject({ state: "stopped" });

    const first = h.json("chatgpt", "--background");
    expect(first).toMatchObject({ ok: true, state: "starting" });
    const pid = first.pid;
    expect(alive(pid)).toBe(true);

    let st: any;
    await waitFor(() => (st = h.json("chatgpt", "--status")).state === "running");
    expect(st).toMatchObject({ ok: true, state: "running", tunnel: "cloudflared", pid, url: "https://fake-tunnel-42.trycloudflare.com/mcp/tok123secret" });
    // the address contains the token: only the user can read the status file
    expect(statSync(h.statusFile).mode & 0o777).toBe(0o600);
    // the HTTP server is really up
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    expect(health).toMatchObject({ ok: true });

    // never two at once
    expect(h.json("chatgpt", "--background")).toMatchObject({ ok: true, state: "running", pid, reused: true });

    // clients: ChatGPT (web) is connected now
    const web = h.json("clients").clients.find((c: any) => c.id === "chatgpt-web");
    expect(web).toMatchObject({ configured: true, note: "Running", action: "start" });
    expect(web.note).not.toMatch(/tok123/);

    const tunnelPid = Number(readFileSync(join(h.home, "tunnel.pid"), "utf8"));
    expect(alive(tunnelPid)).toBe(true);
    expect(h.json("chatgpt", "--stop")).toEqual({ ok: true, state: "stopped", stopped: true });
    await waitFor(() => !alive(pid) && !alive(tunnelPid), 5000);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    expect(existsSync(h.statusFile)).toBe(false);
    expect(h.json("chatgpt", "--status")).toMatchObject({ state: "stopped" });
    // the plain-text start doesn't print the address
    const text = h.run("chatgpt", "--background");
    expect(text.stdout).not.toMatch(/tok123/);
    h.json("chatgpt", "--stop");
  }, 40_000);

  it("a status file whose process is gone says stopped", () => {
    const h = setup(true, 1);
    writeFileSync(h.statusFile, JSON.stringify({ state: "running", pid: 999_999, url: "https://x.trycloudflare.com/mcp/t" }));
    expect(h.json("chatgpt", "--status")).toEqual({ ok: true, state: "stopped" });
  });

  it("without a tunnel tool: needs-tunnel with the install command, and nothing keeps running", () => {
    const h = setup(false, 1);
    const r = h.json("chatgpt", "--background");
    expect(r).toMatchObject({ ok: false, state: "needs-tunnel", installCommand: process.platform === "win32" ? expect.stringMatching(/winget/) : "brew install cloudflared" });
    expect(r.pid).toBeUndefined();
    expect(h.json("chatgpt", "--status")).toMatchObject({ state: "needs-tunnel" });
    expect(h.json("clients").clients.find((c: any) => c.id === "chatgpt-web")).toMatchObject({ configured: false, note: "Needs cloudflared" });
    expect(h.json("chatgpt", "--stop")).toMatchObject({ ok: true, stopped: false });
  });
});
