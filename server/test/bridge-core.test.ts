// Runs the real CEP bridge (cep-panel/js/bridge-core.js) in Node against a simulated After Effects.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const SRC = readFileSync(new URL("../../cep-panel/js/bridge-core.js", import.meta.url), "utf8");

let home = "";
let blocker: Server;
let basePort = 0;
const token = "t".repeat(48);
const evaluated: string[] = [];
let opened = 0;

function loadBridge(appVersion: string, delayMs = 20) {
  const win: any = {
    __adobe_cep__: {
      getHostEnvironment: () => JSON.stringify({ appName: "AEFT", appVersion }),
      // simulated ExtendScript: asynchronous, one script at a time
      evalScript: (script: string, cb: (r: string) => void) => {
        evaluated.push(script);
        setTimeout(() => cb(script.startsWith("slow") ? "slow done" : "result:" + script), script.startsWith("slow") ? 400 : delayMs);
      },
      requestOpenExtension: () => opened++,
      addEventListener: () => {},
    },
    addEventListener: () => {},
  };
  new Function("window", "require", SRC)(win, require);
  return win.AEMCPBridge;
}

async function req(port: number, path: string, body?: unknown, signal?: AbortSignal) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  return { status: r.status, body: (await r.json()) as any };
}

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
};

let bridgeA: any, bridgeB: any;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "aemcp-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // occupy the configured port, so the bridges must move to the next free ones
  blocker = createServer(() => {});
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
  basePort = (blocker.address() as any).port;
  mkdirSync(join(home, ".aemcp"), { recursive: true });
  // httpPort sits right after the busy base port: the bridges must skip it
  writeFileSync(join(home, ".aemcp", "config.json"), JSON.stringify({ token, bridgePort: basePort, httpPort: basePort + 1 }));
  bridgeA = loadBridge("26.5");
  bridgeA.start();
  await waitFor(() => bridgeA.state.listening);
  bridgeB = loadBridge("25.6");
  bridgeB.start();
  await waitFor(() => bridgeB.state.listening);
});

afterAll(() => {
  blocker.close();
  bridgeA?.state.server.close();
  bridgeB?.state.server.close();
});

describe("CEP bridge", () => {
  it("skips busy ports and registers each After Effects instance", () => {
    // the configured port is taken, so each bridge moves up to a free one (other tests may hold some ports too)
    expect(bridgeA.state.port).toBeGreaterThan(basePort);
    expect([bridgeA.state.port, bridgeB.state.port]).not.toContain(basePort + 1); // the HTTP (ChatGPT) port
    expect(bridgeB.state.port).toBeGreaterThan(bridgeA.state.port);
    expect(bridgeB.state.port).toBeLessThan(basePort + 10);
    const a = JSON.parse(readFileSync(join(home, ".aemcp", "instances", `${bridgeA.state.port}.json`), "utf8"));
    expect(a.host.appVersion).toBe("26.5");
    expect(existsSync(join(home, ".aemcp", "instances", `${bridgeB.state.port}.json`))).toBe(true);
  });

  it("requires the token and evaluates scripts", async () => {
    const bad = await fetch(`http://127.0.0.1:${bridgeA.state.port}/eval`, { method: "POST", body: "{}" });
    expect(bad.status).toBe(401);
    const r = await req(bridgeA.state.port, "/eval", { script: "1+1", label: "test" });
    expect(r.body).toEqual({ ok: true, result: "result:1+1" });
  });

  it("rejects browser-originated requests", async () => {
    const r = await fetch(`http://127.0.0.1:${bridgeA.state.port}/health`, { headers: { origin: "https://evil.example" } });
    expect(r.status).toBe(403);
  });

  it("reports what it is busy with", async () => {
    const p = req(bridgeA.state.port, "/eval", { script: "slow job", label: "ae_render_queue_start" });
    await new Promise((r) => setTimeout(r, 150));
    const h = await req(bridgeA.state.port, "/health");
    expect(h.body.busy).toBe(true);
    expect(h.body.busyWith).toBe("ae_render_queue_start");
    expect(h.body.busyForMs).toBeGreaterThan(50);
    await p;
  });

  it("drops a queued script when the client cancels", async () => {
    const first = req(bridgeA.state.port, "/eval", { script: "slow first" });
    const ctrl = new AbortController();
    const second = req(bridgeA.state.port, "/eval", { script: "should-not-run" }, ctrl.signal).catch(() => "aborted");
    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();
    expect(await second).toBe("aborted");
    await first;
    await new Promise((r) => setTimeout(r, 100));
    expect(evaluated).not.toContain("should-not-run");
  });

  it("in ask mode holds edits until approved in the panel, and denies on request", async () => {
    const cfgFile = join(home, ".aemcp", "config.json");
    writeFileSync(cfgFile, JSON.stringify({ token, bridgePort: basePort, httpPort: basePort + 1, permissions: { mode: "ask" } }));
    const port = bridgeA.state.port;
    const before = opened;
    const pending = req(port, "/eval", { script: "edit 1", approval: { tool: "Set property", summary: "{...}" } });
    await waitFor(() => bridgeA.state.pending.length === 1);
    expect(opened).toBe(before + 1); // the panel was asked to open
    expect(evaluated).not.toContain("edit 1");
    const list = await req(port, "/pending");
    expect(list.body.pending[0]).toMatchObject({ tool: "Set property", summary: "{...}" });
    await req(port, "/approve", { id: list.body.pending[0].id, allow: true });
    expect((await pending).body).toEqual({ ok: true, result: "result:edit 1" });

    const denied = req(port, "/eval", { script: "edit 2", approval: { tool: "Run script", summary: "x" } });
    await waitFor(() => bridgeA.state.pending.length === 1);
    const id = (await req(port, "/pending")).body.pending[0].id;
    await req(port, "/approve", { id, allow: false });
    expect((await denied).body).toMatchObject({ ok: false, denied: true });
    expect(evaluated).not.toContain("edit 2");

    // reads are never held
    expect((await req(port, "/eval", { script: "read" })).body.result).toBe("result:read");
    writeFileSync(cfgFile, JSON.stringify({ token, bridgePort: basePort, httpPort: basePort + 1 }));
  });
});

describe("server-side instance discovery", () => {
  it("lists both instances and matches by year, version or port", async () => {
    process.env.AEMCP_CONFIG = join(home, ".aemcp", "config.json");
    delete process.env.AEMCP_BRIDGE_PORT;
    const { listInstances, matchInstance, resolvePort, selectInstance } = await import("../src/bridge.js");
    const list = await listInstances(true);
    expect(list.map((i) => i.appVersion).sort()).toEqual(["25.6", "26.5"]);
    expect(matchInstance(list, "2025")?.port).toBe(bridgeB.state.port);
    expect(matchInstance(list, "26.5")?.port).toBe(bridgeA.state.port);
    expect(matchInstance(list, String(bridgeB.state.port))?.appVersion).toBe("25.6");
    expect(list.find((i) => i.appVersion === "26.5")?.label).toBe("After Effects 2026");
    selectInstance(bridgeB.state.port);
    expect(await resolvePort()).toBe(bridgeB.state.port);
    selectInstance(null);
  });
});
