// Runs the real CEP bridge (extension/js/bridge-core.js) in Node against a simulated After Effects.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
// the bridge page loads paths.js and panel-model.js (risk chips) first, then bridge-core.js
const SRC =
  readFileSync(new URL("../../extension/js/paths.js", import.meta.url), "utf8") +
  "\n" +
  readFileSync(new URL("../../extension/js/panel-model.js", import.meta.url), "utf8") +
  "\n" +
  readFileSync(new URL("../../extension/js/bridge-core.js", import.meta.url), "utf8");

let home = "";
let blocker: Server;
let basePort = 0;
const token = "t".repeat(48);
const evaluated: string[] = [];
let opened = 0;
const openedIds: string[] = [];

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
      requestOpenExtension: (id: string) => {
        opened++;
        openedIds.push(id);
      },
      // CEP events: what the bridge listens to and what it sends (inside After Effects only)
      addEventListener: (type: string, fn: (e: any) => void) => (win.listeners[type] ||= []).push(fn),
      dispatchEvent: (e: any) => win.dispatched.push(e),
    },
    listeners: {} as Record<string, ((e: any) => void)[]>,
    dispatched: [] as any[],
    addEventListener: () => {},
  };
  new Function("window", "require", SRC)(win, require);
  win.AEMCPBridge.win = win;
  return win.AEMCPBridge;
}

/** Headers of the panel / pop-up of this After Effects (they know the panel secret). */
const asUI = (bridge: any) => ({ "x-surehand-panel": bridge.state.panelSecret });

/** Answers a request as the panel does: it is shown first (and was on screen long enough), then answered. */
async function answerAsUI(bridge: any, id: string, allow: boolean, by = "panel") {
  await req(bridge.state.port, `/pending?ui=${by}&visible=1&showing=${id}`, undefined, undefined, asUI(bridge));
  const p = bridge.state.pending.find((x: any) => x.id === id);
  if (p) p.shownAt = Date.now() - 2000;
  return req(bridge.state.port, "/approve", { id, allow, by }, undefined, asUI(bridge));
}

async function req(port: number, path: string, body?: unknown, signal?: AbortSignal, extra: Record<string, string> = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra },
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
    // which After Effects ran it (the panel's Undo checks it)
    expect(r.body).toEqual({ ok: true, result: "result:1+1", instance: { port: bridgeA.state.port, pid: process.pid } });
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
    expect(opened).toBe(before + 1); // no panel showing: the approval pop-up was asked to open
    expect(openedIds[openedIds.length - 1]).toBe("com.aemcp.approval");
    expect(evaluated).not.toContain("edit 1");
    const list = await req(port, "/pending");
    expect(list.body.pending[0]).toMatchObject({ tool: "Set property", summary: "{...}" });
    await answerAsUI(bridgeA, list.body.pending[0].id, true);
    expect((await pending).body).toMatchObject({ ok: true, result: "result:edit 1" });

    const denied = req(port, "/eval", { script: "edit 2", approval: { tool: "Run script", summary: "x" } });
    await waitFor(() => bridgeA.state.pending.length === 1);
    const id = (await req(port, "/pending")).body.pending[0].id;
    await answerAsUI(bridgeA, id, false);
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
    expect((await req(bridge.state.port, "/eval", { script: "after" })).body).toMatchObject({ ok: true, result: "result:after" });
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
    expect((await req(bridge.state.port, "/eval", { script: "after b", startTimeoutMs: 600 })).body).toMatchObject({ ok: true, result: "result:after b" });
  });

  it("never cuts short a script that has started, nor one queued behind it", async () => {
    // "late" scripts take 1.5s in the simulated AE: well past the 500ms start window
    const long = req(bridge.state.port, "/eval", { script: "late render", timeoutMs: 10_000, startTimeoutMs: 500 });
    await waitFor(() => bridge.state.busy);
    const next = req(bridge.state.port, "/eval", { script: "after render", timeoutMs: 10_000, startTimeoutMs: 500 });
    expect((await long).body).toMatchObject({ ok: true, result: "result:late render" });
    expect((await next).body).toMatchObject({ ok: true, result: "result:after render" });
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

describe("Pause AI (the bridge refuses AI calls while paused)", () => {
  const cfgFile = () => join(home, ".aemcp", "config.json");
  const writeCfg = (extra: object) => writeFileSync(cfgFile(), JSON.stringify({ token, bridgePort: basePort, httpPort: basePort + 1, ...extra }));
  afterAll(() => writeCfg({}));

  it("refuses at once, runs nothing, counts the refusals, and still runs the panel's own calls", async () => {
    const port = bridgeA.state.port;
    writeCfg({ paused: true, pausedAt: "2026-10-19T10:00:00.000Z" });
    const r = await req(port, "/eval", { script: "paused edit", label: "ae_set_property" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: false, paused: true, error: bridgeA.PAUSED_MESSAGE });
    expect(bridgeA.PAUSED_MESSAGE).toBe("Paused in the Surehand panel: nothing was run. Ask the user to resume.");
    await req(port, "/eval", { script: "paused edit 2" });
    expect(evaluated).not.toContain("paused edit");
    expect(evaluated).not.toContain("paused edit 2");
    const h = (await req(port, "/health")).body;
    expect(h.paused).toEqual({ since: "2026-10-19T10:00:00.000Z", refused: 2 });
    expect((await req(port, "/pending")).body.paused.refused).toBe(2);
    // the panel's own calls (undo, diagnostics...) are not the AI's: they carry the panel secret
    expect((await req(port, "/eval", { script: "panel call", fromPanel: true }, undefined, asUI(bridgeA))).body).toMatchObject({ ok: true, result: "result:panel call" });
    // resumed in the panel: the pause is lifted (and the config saved without it)
    const off = await req(port, "/pause", { paused: false }, undefined, asUI(bridgeA));
    expect(off.body).toMatchObject({ ok: true, paused: null, saved: true });
    expect(JSON.parse(readFileSync(cfgFile(), "utf8")).paused).toBeUndefined();
    // a new pause starts a new count
    const on = await req(port, "/pause", { paused: true }, undefined, asUI(bridgeA));
    expect(on.body.paused).toEqual({ since: expect.any(String), refused: 0 });
    expect(JSON.parse(readFileSync(cfgFile(), "utf8"))).toMatchObject({ paused: true, token });
    await req(port, "/eval", { script: "x" });
    expect((await req(port, "/health")).body.paused.refused).toBe(1);
    await req(port, "/pause", { paused: false }, undefined, asUI(bridgeA));
    expect((await req(port, "/health")).body.paused).toBeNull();
    expect((await req(port, "/eval", { script: "after resume" })).body.result).toBe("result:after resume");
  });

  it("the AI app (it has the token) can't get past a pause: fromPanel, /pause and editing config.json are refused", async () => {
    const port = bridgeA.state.port;
    expect((await req(port, "/pause", { paused: true }, undefined, asUI(bridgeA))).body.ok).toBe(true);
    // fromPanel without the panel secret
    const r = await req(port, "/eval", { script: "sneaky", fromPanel: true });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/Only the Surehand panel/);
    // a wrong secret
    expect((await req(port, "/eval", { script: "sneaky", fromPanel: true }, undefined, { "x-surehand-panel": "f".repeat(64) })).status).toBe(403);
    // resuming over HTTP without the secret
    expect((await req(port, "/pause", { paused: false })).status).toBe(403);
    // removing the flag from config.json doesn't resume either: the pause is held in the bridge
    writeCfg({});
    expect((await req(port, "/eval", { script: "sneaky 2" })).body).toMatchObject({ ok: false, paused: true });
    expect(evaluated).not.toContain("sneaky");
    expect(evaluated).not.toContain("sneaky 2");
    await req(port, "/pause", { paused: false }, undefined, asUI(bridgeA));
  });

  it("hands the panel secret only to a CEP hello (inside After Effects), never over HTTP", async () => {
    const win = bridgeA.win;
    const before = win.dispatched.length;
    for (const fn of win.listeners[bridgeA.HELLO_EVENT]) fn({ type: bridgeA.HELLO_EVENT, data: "{}" });
    const ev = win.dispatched.slice(before).find((e: any) => e.type === bridgeA.WELCOME_EVENT);
    expect(JSON.parse(ev.data)).toMatchObject({ port: bridgeA.state.port, secret: bridgeA.state.panelSecret });
    expect(bridgeA.state.panelSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(bridgeB.state.panelSecret).not.toBe(bridgeA.state.panelSecret);
    for (const path of ["/health", "/pending", "/log"]) expect(JSON.stringify((await req(bridgeA.state.port, path)).body)).not.toContain(bridgeA.state.panelSecret);
  });

  it("lets a running script finish, and refuses the calls queued behind it", async () => {
    const port = bridgeA.state.port;
    const running = req(port, "/eval", { script: "slow running" });
    await waitFor(() => bridgeA.state.busy);
    const queued = req(port, "/eval", { script: "queued while running" });
    await new Promise((r) => setTimeout(r, 50));
    await req(port, "/pause", { paused: true }, undefined, asUI(bridgeA));
    expect((await running).body).toMatchObject({ ok: true, result: "slow done" });
    expect((await queued).body).toMatchObject({ ok: false, paused: true });
    expect(evaluated).not.toContain("queued while running");
    await req(port, "/pause", { paused: false }, undefined, asUI(bridgeA));
  });

  it("the server passes the clean message to the AI (BridgeError PAUSED)", async () => {
    process.env.AEMCP_CONFIG = cfgFile();
    const { evalRaw, selectInstance, BridgeError, PAUSED_MESSAGE } = await import("../src/bridge.js");
    selectInstance(bridgeA.state.port);
    await req(bridgeA.state.port, "/pause", { paused: true }, undefined, asUI(bridgeA));
    try {
      const e: any = await evalRaw("1+1", 5000, { label: "ae_run_script" }).catch((x) => x);
      expect(e).toBeInstanceOf(BridgeError);
      expect(e.code).toBe("PAUSED");
      expect(e.message).toBe(PAUSED_MESSAGE);
      expect(PAUSED_MESSAGE).toBe(bridgeA.PAUSED_MESSAGE);
    } finally {
      await req(bridgeA.state.port, "/pause", { paused: false }, undefined, asUI(bridgeA));
      selectInstance(null);
    }
  });
});

describe("approvals: one answer, one place", () => {
  const cfgFile = () => join(home, ".aemcp", "config.json");
  const writeCfg = (extra: object) => writeFileSync(cfgFile(), JSON.stringify({ token, bridgePort: basePort, httpPort: basePort + 1, ...extra }));
  beforeAll(() => writeCfg({ permissions: { mode: "ask" } }));
  afterAll(() => writeCfg({}));

  it("accepts only the first answer (panel and pop-up both open) and runs the edit once", async () => {
    const port = bridgeA.state.port;
    const call = req(port, "/eval", { script: "edit once", approval: { tool: "Set property", summary: "{}", client: "claude-ai" } });
    await waitFor(() => bridgeA.state.pending.length === 1);
    const p = (await req(port, "/pending")).body.pending[0];
    expect(p.client).toBe("claude-ai");
    expect(Date.parse(p.deadline) - Date.parse(p.at)).toBe(10 * 60 * 1000);
    await req(port, `/pending?ui=panel&visible=1&showing=${p.id}`, undefined, undefined, asUI(bridgeA));
    bridgeA.state.pending[0].shownAt = Date.now() - 2000;
    const [a, b] = await Promise.all([
      req(port, "/approve", { id: p.id, allow: true, by: "panel" }, undefined, asUI(bridgeA)),
      req(port, "/approve", { id: p.id, allow: false, by: "popup" }, undefined, asUI(bridgeA)),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    expect((await call).body).toMatchObject({ ok: true, result: "result:edit once" });
    expect(evaluated.filter((s) => s === "edit once")).toHaveLength(1);
    // a late answer for it is refused too
    expect((await req(port, "/approve", { id: p.id, allow: true }, undefined, asUI(bridgeA))).status).toBe(404);
  });

  it("the AI app can't answer its own request: /approve needs the panel secret", async () => {
    const port = bridgeA.state.port;
    const call = req(port, "/eval", { script: "self approved", approval: { tool: "Run script", summary: "x" } });
    await waitFor(() => bridgeA.state.pending.length === 1);
    const id = bridgeA.state.pending[0].id;
    bridgeA.state.pending[0].shownAt = Date.now() - 5000;
    const r = await req(port, "/approve", { id, allow: true });
    expect(r.status).toBe(403);
    expect(bridgeA.state.pending).toHaveLength(1);
    // nor can it fake "shown" to start the clock: only the panel's report counts
    bridgeA.state.pending[0].shownAt = 0;
    await req(port, `/pending?ui=panel&showing=${id}`);
    expect(bridgeA.state.pending[0].shownAt).toBe(0);
    await answerAsUI(bridgeA, id, false);
    expect((await call).body).toMatchObject({ denied: true });
    expect(evaluated).not.toContain("self approved");
  });

  it("an answer counts only for the request on screen, the oldest one, after it was shown for a second", async () => {
    const port = bridgeA.state.port;
    const c1 = req(port, "/eval", { script: "first edit", approval: { tool: "Set property", summary: "{}" } });
    await waitFor(() => bridgeA.state.pending.length === 1);
    const c2 = req(port, "/eval", { script: "second edit", approval: { tool: "Set property", summary: "{}" } });
    await waitFor(() => bridgeA.state.pending.length === 2);
    const [p1, p2] = bridgeA.state.pending.map((p: any) => p.id);
    // shown just now: too soon (a click meant for the previous card)
    await req(port, `/pending?ui=panel&showing=${p1}`, undefined, undefined, asUI(bridgeA));
    const soon = await req(port, "/approve", { id: p1, allow: true }, undefined, asUI(bridgeA));
    expect(soon.status).toBe(409);
    expect(soon.body.tooSoon).toBe(true);
    // the newer one, while the older one waits: refused
    bridgeA.state.pending[1].shownAt = Date.now() - 5000;
    expect((await req(port, "/approve", { id: p2, allow: true }, undefined, asUI(bridgeA))).status).toBe(409);
    expect(evaluated).not.toContain("second edit");
    await new Promise((r) => setTimeout(r, bridgeA.MIN_SHOWN_MS + 50));
    expect((await req(port, "/approve", { id: p1, allow: false }, undefined, asUI(bridgeA))).status).toBe(200);
    expect((await req(port, "/approve", { id: p2, allow: false }, undefined, asUI(bridgeA))).status).toBe(200);
    expect((await c1).body).toMatchObject({ denied: true });
    expect((await c2).body).toMatchObject({ denied: true });
  });

  it("shows a long request shortened (saying how much is not shown) but finds risks in all of it", async () => {
    const port = bridgeA.state.port;
    const code = "// tidy up\n" + "var a = 1;\n".repeat(1000) + "app.project.item(1).remove();\nsystem.callSystem('rm -rf ~');";
    const call = req(port, "/eval", { script: "long", approval: { tool: "Run script", summary: code } });
    await waitFor(() => bridgeA.state.pending.length === 1);
    const p = (await req(port, "/pending")).body.pending[0];
    expect(p.summary.length).toBeLessThan(code.length);
    expect(p.summary).toMatch(new RegExp(`… ${code.length - bridgeA.SUMMARY_MAX} more characters not shown$`));
    expect(p.summary).not.toContain("callSystem");
    expect(p.chips.map((c: any) => c.text)).toEqual(expect.arrayContaining(["deletes", "runs a shell command"]));
    // a script file: what is shown is its start; risks come from the whole file ("full")
    await answerAsUI(bridgeA, p.id, false);
    await call;
    const file = req(port, "/eval", { script: "file", approval: { tool: "Run script file", summary: "/x.jsx\n\nvar a;", full: "/x.jsx\n\nvar a;\napp.project.save();" } });
    await waitFor(() => bridgeA.state.pending.length === 1);
    expect(bridgeA.state.pending[0].chips.map((c: any) => c.text)).toContain("saves the project");
    await answerAsUI(bridgeA, bridgeA.state.pending[0].id, false);
    await file;
  });

  it("opens the pop-up only when the panel isn't showing, and only once per request", async () => {
    const port = bridgeA.state.port;
    bridgeA.state.ui.requestedAt = 0;
    // the panel is open and visible: it shows the card, no pop-up
    await req(port, "/pending?ui=panel&visible=1");
    const before = openedIds.length;
    const c1 = req(port, "/eval", { script: "edit p1", approval: { tool: "Set property", summary: "{}" } });
    await waitFor(() => bridgeA.state.pending.length === 1);
    expect(openedIds.length).toBe(before);
    await answerAsUI(bridgeA, bridgeA.state.pending[0].id, false);
    await c1;

    // the panel is closed (no poll for a while): the pop-up opens, once
    bridgeA.state.ui.panel = { at: Date.now() - 10_000, visible: true };
    const c2 = req(port, "/eval", { script: "edit p2", approval: { tool: "Set property", summary: "{}" } });
    await waitFor(() => bridgeA.state.pending.length === 1);
    expect(openedIds.slice(before)).toEqual(["com.aemcp.approval"]);
    await req(port, "/pending?ui=popup"); // the pop-up reports in
    bridgeA.checkPopup();
    expect(openedIds.slice(before)).toEqual(["com.aemcp.approval"]);
    await answerAsUI(bridgeA, bridgeA.state.pending[0].id, false, "popup");
    expect((await c2).body).toMatchObject({ ok: false, denied: true });
    expect(bridgeA.state.log[0].preview).toMatch(/pop-up/);
  });
});

describe("popupDecision (pure)", () => {
  const d = (s: object) => bridgeA.popupDecision({ now: 100_000, pending: ["a"], presented: {}, ...s });
  it("does nothing without a waiting request", () => {
    expect(d({ pending: [] })).toEqual({ open: false, openPanel: false, present: false });
  });
  it("leaves it to a panel that is open and visible", () => {
    expect(d({ panel: { at: 99_000, visible: true } })).toEqual({ open: false, openPanel: false, present: true });
  });
  it("opens the pop-up when the panel is closed, hidden or silent", () => {
    expect(d({}).open).toBe(true);
    expect(d({ panel: { at: 99_000, visible: false } }).open).toBe(true);
    expect(d({ panel: { at: 90_000, visible: true } }).open).toBe(true);
  });
  it("doesn't open it again while it shows, while it loads, or for a request already shown", () => {
    expect(d({ popup: { at: 99_500 } })).toEqual({ open: false, openPanel: false, present: true });
    expect(d({ requestedAt: 97_000 }).open).toBe(false);
    expect(d({ presented: { a: true } }).open).toBe(false);
    // a newer request opens it again (the user closed the pop-up without answering)
    expect(d({ pending: ["a", "b"], presented: { a: true } }).open).toBe(true);
  });
  it("opens the panel instead, once, when the pop-up never reported in", () => {
    expect(d({ requestedAt: 90_000, presented: { a: true } })).toEqual({ open: false, openPanel: true, present: true });
    expect(d({ requestedAt: 90_000, fellBackFor: 90_000, presented: { a: true } }).openPanel).toBe(false);
    expect(d({ requestedAt: 90_000, popup: { at: 91_000 }, presented: { a: true } }).openPanel).toBe(false);
  });
});

describe("config.json in the bridge: torn reads never reset it", () => {
  it("never regenerates a config it can't read, uses the last good one, and fails closed without one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "surehand-bridge-cfg-"));
    const f = join(dir, "config.json");
    process.env.SUREHAND_AE_CONFIG = f;
    try {
      // there but unreadable, and never read before: nothing is accepted, and the file is left alone
      writeFileSync(f, '{"token": "abc", "permis');
      const r = await req(bridgeA.state.port, "/eval", { script: "while unreadable" });
      expect(r.status).toBe(503);
      expect(r.body.error).toMatch(/settings file can't be read/);
      expect(readFileSync(f, "utf8")).toBe('{"token": "abc", "permis');
      expect(bridgeA.loadConfig()).toMatchObject({ unreadable: expect.stringMatching(/not valid JSON/) });
      expect(bridgeA.loadConfig().token).toBeUndefined();
      expect(bridgeA.permissionMode()).toBe("unreadable");
      expect(evaluated).not.toContain("while unreadable");

      // readable, then torn again (another process writing it): the last good copy is used, nothing is rewritten
      writeFileSync(f, JSON.stringify({ token, bridgePort: basePort, httpPort: basePort + 1, permissions: { mode: "ask" } }));
      expect(bridgeA.loadConfig().permissions).toEqual({ mode: "ask" });
      writeFileSync(f, "{");
      expect(bridgeA.loadConfig()).toMatchObject({ token, permissions: { mode: "ask" } });
      expect(bridgeA.permissionMode()).toBe("ask");
      expect(readFileSync(f, "utf8")).toBe("{");
      // a setting can't be saved over it either (the pause is held in memory, the file stays)
      expect(bridgeA.setPaused(true)).toMatchObject({ saved: false });
      expect(readFileSync(f, "utf8")).toBe("{");
      bridgeA.setPaused(false);

      // a BOM is fine; what the bridge writes is written atomically and readable only by the user
      writeFileSync(f, "﻿" + JSON.stringify({ bridgePort: basePort, httpPort: basePort + 1, permissions: { mode: "full" } }));
      const cfg = bridgeA.loadConfig();
      expect(cfg.token).toMatch(/^[0-9a-f]{48}$/);
      expect(JSON.parse(readFileSync(f, "utf8"))).toMatchObject({ token: cfg.token, permissions: { mode: "full" } });
      if (process.platform !== "win32") expect(statSync(f).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir)).toEqual(["config.json"]); // no temporary file left behind
    } finally {
      delete process.env.SUREHAND_AE_CONFIG;
    }
  });
});
