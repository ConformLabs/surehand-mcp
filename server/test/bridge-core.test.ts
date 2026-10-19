// Runs the real CEP bridge (extension/js/bridge-core.js) in Node against a simulated After Effects.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const SRC = readFileSync(new URL("../../extension/js/bridge-core.js", import.meta.url), "utf8");

let home = "";
let blocker: Server;
let basePort = 0;
const token = "t".repeat(48);
const evaluated: string[] = [];
let opened = 0;

type EvalScript = (script: string, cb: (r: string) => void) => void;

function loadBridge(appVersion: string, delayMs = 20, evalScript?: EvalScript) {
  const win: any = {
    __adobe_cep__: {
      getHostEnvironment: () => JSON.stringify({ appName: "AEFT", appVersion }),
      // simulated ExtendScript: asynchronous, one script at a time
      evalScript:
        evalScript ??
        ((script: string, cb: (r: string) => void) => {
          evaluated.push(script);
          setTimeout(() => cb(script.startsWith("slow") ? "slow done" : "result:" + script), script.startsWith("slow") ? 400 : delayMs);
        }),
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

// A simulated After Effects that a modal dialog can block: CEP still accepts scripts, but
// ExtendScript runs none of them (and answers none) until the dialog closes.
function blockableAE() {
  const ae = {
    blocked: false,
    ran: [] as string[],
    held: [] as Array<() => void>,
    evalScript(script: string, cb: (r: string) => void) {
      const run = () => {
        ae.ran.push(script);
        setTimeout(() => cb("result:" + script), script.startsWith("late") ? 1500 : 5);
      };
      if (ae.blocked) ae.held.push(run);
      else run();
    },
    closeDialog() {
      ae.blocked = false;
      ae.held.splice(0).forEach((run) => run());
    },
  };
  return ae;
}

describe("stale jobs", () => {
  let ae: ReturnType<typeof blockableAE>;
  let bridge: any;
  beforeAll(async () => {
    ae = blockableAE();
    bridge = loadBridge("26.5", 20, ae.evalScript);
    bridge.start();
    await waitFor(() => bridge.state.listening);
  });
  afterAll(() => bridge?.state.server.close());
  const log = async () => (await req(bridge.state.port, "/log")).body.log as any[];

  it("never runs a job after it timed out while a dialog blocked After Effects", async () => {
    ae.blocked = true;
    const first = await req(bridge.state.port, "/eval", { script: "edit 1", label: "ae_set_property", timeoutMs: 1000 });
    expect(first.status).toBe(504);
    expect(first.body.error).toMatch(/did not run and will not run/);
    // queued behind it in the bridge: also given up on
    const second = await req(bridge.state.port, "/eval", { script: "edit 2", timeoutMs: 1000 });
    expect(second.status).toBe(504);
    ae.closeDialog();
    await waitFor(() => !bridge.state.busy && !bridge.state.queue.length);
    expect(ae.ran).not.toContain("edit 1");
    expect(ae.ran).not.toContain("edit 2");
    expect((await log()).find((e) => e.label === "ae_set_property")).toMatchObject({ ok: false, skipped: true });
    // and the bridge carries on normally
    expect((await req(bridge.state.port, "/eval", { script: "after" })).body).toEqual({ ok: true, result: "result:after" });
  });

  it("never runs a job the client cancelled while a dialog blocked After Effects", async () => {
    ae.blocked = true;
    const ctrl = new AbortController();
    const call = req(bridge.state.port, "/eval", { script: "edit 3" }, ctrl.signal).catch(() => "aborted");
    await waitFor(() => bridge.state.busy);
    ctrl.abort();
    expect(await call).toBe("aborted");
    await new Promise((r) => setTimeout(r, 50));
    ae.closeDialog();
    await waitFor(() => !bridge.state.busy);
    expect(ae.ran).not.toContain("edit 3");
    expect((await req(bridge.state.port, "/eval", { script: "after 2" })).body.result).toBe("result:after 2");
  });

  it("logs a script that After Effects had started and finished after the AI gave up", async () => {
    const r = await req(bridge.state.port, "/eval", { script: "late edit", label: "ae_run_script", timeoutMs: 1000 });
    expect(r.status).toBe(504);
    expect(r.body.error).toMatch(/already started/);
    await waitFor(() => !bridge.state.busy);
    const entry = (await log()).find((e) => e.label === "ae_run_script");
    expect(entry).toMatchObject({ ok: true, late: true });
    expect(entry.preview).toMatch(/^ran after the AI gave up/);
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

describe("blocked After Effects is reported fast", () => {
  let ae: ReturnType<typeof blockableAE>;
  let bridge: any;
  beforeAll(async () => {
    ae = blockableAE();
    bridge = loadBridge("26.5", 20, ae.evalScript);
    bridge.start();
    await waitFor(() => bridge.state.listening);
  });
  afterAll(() => bridge?.state.server.close());
  const log = async () => (await req(bridge.state.port, "/log")).body.log as any[];

  it("answers 'blocked' after the start window instead of waiting for the timeout, and never runs the job", async () => {
    ae.blocked = true;
    const t0 = Date.now();
    const r = await req(bridge.state.port, "/eval", { script: "edit b1", label: "ae_set_property", timeoutMs: 20_000, startTimeoutMs: 600 });
    const took = Date.now() - t0;
    expect(r.status).toBe(503);
    expect(took).toBeGreaterThanOrEqual(550);
    expect(took).toBeLessThan(3000);
    expect(r.body).toMatchObject({ ok: false, blocked: true, waitingFor: "ae_set_property", queue: 0 });
    expect(r.body.waitingForMs).toBeGreaterThanOrEqual(600);
    expect(r.body.error).toMatch(/did not run and will not run later/);

    const h = (await req(bridge.state.port, "/health")).body;
    expect(h.waitingForAE).toBe(true);
    expect(h.waitingForMs).toBeGreaterThanOrEqual(600);

    // while AE is still blocked, the next call is turned away at once
    const t1 = Date.now();
    const again = await req(bridge.state.port, "/eval", { script: "edit b2", timeoutMs: 20_000, startTimeoutMs: 600 });
    expect(again.status).toBe(503);
    expect(Date.now() - t1).toBeLessThan(500);

    ae.closeDialog();
    await waitFor(() => !bridge.state.busy && !bridge.state.queue.length);
    expect(ae.ran).not.toContain("edit b1");
    expect(ae.ran).not.toContain("edit b2");
    expect((await log()).find((e) => e.label === "ae_set_property")).toMatchObject({ ok: false, skipped: true });
    expect((await req(bridge.state.port, "/health")).body.waitingForAE).toBe(false);
    expect((await req(bridge.state.port, "/eval", { script: "after b", startTimeoutMs: 600 })).body).toEqual({ ok: true, result: "result:after b" });
  });

  it("never cuts short a script that has started, nor one queued behind it", async () => {
    // "late" scripts take 1.5s in the simulated AE: well past the 500ms start window
    const long = req(bridge.state.port, "/eval", { script: "late render", timeoutMs: 10_000, startTimeoutMs: 500 });
    await waitFor(() => bridge.state.busy);
    const next = req(bridge.state.port, "/eval", { script: "after render", timeoutMs: 10_000, startTimeoutMs: 500 });
    expect((await long).body).toEqual({ ok: true, result: "result:late render" });
    expect((await next).body).toEqual({ ok: true, result: "result:after render" });
  });

  it("without startTimeoutMs (older servers) it waits for the normal timeout", async () => {
    ae.blocked = true;
    const t0 = Date.now();
    const r = await req(bridge.state.port, "/eval", { script: "edit old", timeoutMs: 1000 });
    expect(r.status).toBe(504);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
    ae.closeDialog();
    await waitFor(() => !bridge.state.busy);
    expect(ae.ran).not.toContain("edit old");
  });

  describe("ae_status", () => {
    let status: (args?: any) => Promise<{ isError: boolean; text: string }>;
    beforeAll(async () => {
      process.env.AEMCP_CONFIG = join(home, ".aemcp", "config.json");
      process.env.AEMCP_NO_UPDATE_CHECK = "1";
      process.env.AEMCP_BLOCKED_AFTER_SECONDS = "0.5";
      process.env.AEMCP_STARTUP_WAIT_SECONDS = "2";
      delete process.env.AEMCP_BRIDGE_PORT;
      const { registerCoreTools } = await import("../src/tools/core.js");
      const { selectInstance } = await import("../src/bridge.js");
      let handler: any;
      registerCoreTools({ registerTool: (name: string, _def: unknown, h: unknown) => void (name === "ae_status" && (handler = h)) } as any);
      selectInstance(bridge.state.port);
      status = async (args = {}) => {
        const r = await handler(args);
        return { isError: !!r.isError, text: r.content.map((c: any) => c.text).join("\n") };
      };
    });
    afterAll(async () => {
      for (const k of ["AEMCP_NO_UPDATE_CHECK", "AEMCP_BLOCKED_AFTER_SECONDS", "AEMCP_STARTUP_WAIT_SECONDS"]) delete process.env[k];
      (await import("../src/bridge.js")).selectInstance(null);
    });

    it("says the bridge is up but After Effects is blocked, with what the bridge knows", async () => {
      ae.blocked = true;
      const t0 = Date.now();
      const r = await status();
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/The Surehand MCP bridge answers \(After Effects 2026/);
      expect(r.text).toMatch(/busy or showing a dialog \(it has not accepted a script for \d+s; waiting to run ae_status/);
      // the bridge started moments ago: it may still be starting up
      expect(r.text).toMatch(/may still be starting up/);
      ae.closeDialog();
      await waitFor(() => !bridge.state.busy);
    });

    it("waits while After Effects finishes starting (dialog closes during the wait)", async () => {
      ae.blocked = true;
      setTimeout(() => ae.closeDialog(), 900);
      const r = await status();
      expect(r.isError).toBe(false);
      expect(r.text).toMatch(/^Connected to After Effects 2026/);
    });

    it("reports ready when After Effects takes scripts", async () => {
      const r = await status();
      expect(r.isError).toBe(false);
      expect(r.text).toMatch(/^Connected to After Effects 2026 \(bridge v.* on port \d+/);
    });
  });
});
