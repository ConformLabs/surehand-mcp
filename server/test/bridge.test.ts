import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: Server;
let port = 0;
const calls: string[] = [];
const bodies: any[] = [];
let helpersLoaded = false;

beforeAll(async () => {
  // fake bridge emulating the CEP extension + an ExtendScript engine
  server = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer secret") return void res.writeHead(401).end("{}");
    if (req.url === "/health") return void res.end(JSON.stringify({ ok: true, name: "aemcp-bridge", version: "1.0.0" }));
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const { script } = JSON.parse(b);
      bodies.push(JSON.parse(b));
      if (script === "blocked") {
        res.writeHead(503);
        return void res.end(
          JSON.stringify({ ok: false, blocked: true, waitingForMs: 3200, waitingFor: "ae_set_property", queue: 2, startedAt: new Date(Date.now() - 3600_000).toISOString(), error: "x" }),
        );
      }
      calls.push(script);
      let result: string;
      if (script.includes("return 'aemcp loaded '")) {
        helpersLoaded = true;
        result = "aemcp loaded test";
      } else if (!helpersLoaded) result = "__AEMCP_NEED_HELPERS__";
      else result = JSON.stringify({ ok: true, result: { echoed: true }, logs: [] });
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as any).port;
  const dir = mkdtempSync(join(tmpdir(), "aemcp-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ bridgePort: port, token: "secret" }));
  process.env.AEMCP_CONFIG = join(dir, "config.json");
});
afterAll(() => server.close());

describe("bridge + runJsx", () => {
  it("loads helpers on demand, then retries", async () => {
    const { runJsx } = await import("../src/jsx.js");
    const r = await runJsx("return 1;");
    expect(r).toEqual({ ok: true, result: { echoed: true }, logs: [] });
    expect(calls.length).toBe(3); // script -> helpers -> script
  });

  it("reports auth failures clearly", async () => {
    const { health, BridgeError } = await import("../src/bridge.js");
    process.env.AEMCP_TOKEN = "wrong";
    await expect(health()).rejects.toBeInstanceOf(BridgeError);
    delete process.env.AEMCP_TOKEN;
    expect((await health()).ok).toBe(true);
  });

  it("reports AE not running", async () => {
    const { evalRaw } = await import("../src/bridge.js");
    process.env.AEMCP_BRIDGE_PORT = "1";
    await expect(evalRaw("1")).rejects.toThrow(/Cannot reach After Effects/);
    delete process.env.AEMCP_BRIDGE_PORT;
  });
});

describe("After Effects blocked or starting", () => {
  it("asks the bridge to give up early when AE doesn't take the script (configurable, 0 = off)", async () => {
    const { evalRaw } = await import("../src/bridge.js");
    await evalRaw("1");
    expect(bodies.at(-1).startTimeoutMs).toBe(3000);
    process.env.AEMCP_BLOCKED_AFTER_SECONDS = "5";
    await evalRaw("1");
    expect(bodies.at(-1).startTimeoutMs).toBe(5000);
    process.env.AEMCP_BLOCKED_AFTER_SECONDS = "0";
    await evalRaw("1");
    expect(bodies.at(-1).startTimeoutMs).toBeUndefined();
    delete process.env.AEMCP_BLOCKED_AFTER_SECONDS;
    // the tool's own timeout is unchanged: long scripts that started keep it
    await evalRaw("1", 600_000);
    expect(bodies.at(-1).timeoutMs).toBe(600_000);
  });

  it("explains a blocked After Effects with what the bridge knows", async () => {
    const { evalRaw, BridgeError } = await import("../src/bridge.js");
    const e: any = await evalRaw("blocked").catch((x) => x);
    expect(e).toBeInstanceOf(BridgeError);
    expect(e.code).toBe("BLOCKED");
    expect(e.message).toBe(
      "After Effects is busy or showing a dialog (it has not accepted a script for 3s; waiting to run ae_set_property; 2 more calls queued). " +
        "Check After Effects: close any open dialog or settings window (Project Settings, Preferences, an error or alert, a startup prompt) and retry. " +
        "This call did not run and will not run later.",
    );
  });

  it("says when the bridge just started (AE may still be starting)", async () => {
    const { explainBlocked } = await import("../src/bridge.js");
    expect(explainBlocked({ waitingForMs: 4000, startedAt: new Date(Date.now() - 10_000).toISOString() })).toMatch(
      /\(it has not accepted a script for 4s\)\. The Surehand MCP bridge started 10s ago, so After Effects may still be starting up\./,
    );
  });

  it("ae_status connection: not running is reported at once when there is no After Effects process", async () => {
    const { waitForBridge } = await import("../src/bridge.js");
    const t0 = Date.now();
    const e: any = await waitForBridge({ port: 1, waitMs: 5000, isAERunning: () => false }).catch((x) => x);
    expect(e.code).toBe("NOT_RUNNING");
    expect(e.message).toMatch(/^After Effects is not running\. Cannot reach After Effects/);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("ae_status connection: waits while After Effects is starting, then says so", async () => {
    const { waitForBridge } = await import("../src/bridge.js");
    const t0 = Date.now();
    const e: any = await waitForBridge({ port: 1, waitMs: 1200, intervalMs: 200, isAERunning: () => true }).catch((x) => x);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(e.code).toBe("STARTING");
    expect(e.message).toMatch(/^After Effects is running, but its Surehand MCP bridge did not start within 1s\. AE may still be starting, or be showing a startup dialog/);
    expect(e.message).not.toMatch(/frozen or quitting/);
  });

  it("ae_status connection: connects as soon as the bridge comes up during the wait", async () => {
    const { waitForBridge } = await import("../src/bridge.js");
    // a bridge that starts listening 500ms into the wait
    const late = createServer((req, res) => res.end(JSON.stringify({ ok: true, name: "aemcp-bridge", version: "1.3.5", startedAt: new Date().toISOString() })));
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const latePort = (probe.address() as any).port;
    probe.close();
    setTimeout(() => late.listen(latePort, "127.0.0.1"), 500);
    try {
      const r = await waitForBridge({ port: latePort, waitMs: 5000, intervalMs: 100, isAERunning: () => true });
      expect(r.port).toBe(latePort);
      expect(r.health.version).toBe("1.3.5");
    } finally {
      late.close();
    }
  });
});
