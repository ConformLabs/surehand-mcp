import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: Server;
let port = 0;
const calls: string[] = [];
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
      calls.push(script);
      let result: string;
      if (script.startsWith("// aemcp helper")) {
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
