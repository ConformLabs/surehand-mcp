// Runs the real AE MCP panel (extension/index.html + js/panel.js) in jsdom against a fake bridge.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nodeRequire = createRequire(import.meta.url);
const ROOT = new URL("../../extension/", import.meta.url);
let server: Server;
let dom: JSDOM;
let pending: { id: string; at: string; tool: string; summary: string }[] = [];
const answers: { id: string; allow: boolean }[] = [];
const updateRuns: string[][] = [];
let home = "";

const waitFor = async (cond: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for the panel");
    await new Promise((r) => setTimeout(r, 25));
  }
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const json = (o: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
    if (req.url === "/health") return json({ ok: true, authorized: true, port: 1, busy: false, queue: 0, pendingApprovals: pending.length, permissionMode: "ask" });
    if (req.url === "/pending") return json({ ok: true, pending });
    if (req.url === "/approve") {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        const { id, allow } = JSON.parse(b);
        answers.push({ id, allow });
        pending = pending.filter((p) => p.id !== id);
        json({ ok: true });
      });
      return;
    }
    json({ ok: true, log: [] });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;

  home = mkdtempSync(join(tmpdir(), "aemcp-panel-"));
  mkdirSync(join(home, ".aemcp"), { recursive: true });
  // a newer release is known, and this is a standalone install the panel can update in place
  writeFileSync(join(home, ".aemcp", "update-check.json"), JSON.stringify({ latest: "99.0.0", url: "https://example.invalid/release" }));
  writeFileSync(join(home, ".aemcp", "runtime.json"), JSON.stringify({ node: process.execPath, server: __filename }));
  const html = readFileSync(new URL("index.html", ROOT), "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
  dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/" });
  const w = dom.window as any;
  w.alert = () => {};
  // the panel's Node APIs: real http/path, fs/os pointed at a temporary home folder
  const os = { ...nodeRequire("os"), homedir: () => home };
  const childProcess = {
    ...nodeRequire("child_process"),
    execFile: (file: string, args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => {
      updateRuns.push([file, ...args]);
      setTimeout(() => cb(null, "progress\n" + JSON.stringify({ ok: true, updated: true, to: "99.0.0", message: "Updated" })), 20);
    },
  };
  w.require = (m: string) => (m === "os" ? os : m === "child_process" ? childProcess : nodeRequire(m));
  w.process = process;
  w.Buffer = Buffer;
  w.AEMCPBridge = {
    VERSION: "test",
    CONFIG_FILE: join(home, ".aemcp", "config.json"),
    state: { port },
    loadConfig: () => ({ token: "t", bridgePort: port }),
    hostInfo: () => ({ appName: "AEFT", appVersion: "26.5" }),
    start: () => {},
  };
  w.eval(readFileSync(new URL("js/panel.js", ROOT), "utf8"));
});

afterAll(() => {
  dom?.window.close();
  server?.close();
});

describe("AE MCP panel approvals", () => {
  const doc = () => dom.window.document;
  const cards = () => doc().querySelectorAll("#approvalList .approval");

  it("shows a waiting request and removes it when Allow is clicked (regression)", async () => {
    pending = [{ id: "a1", at: new Date().toISOString(), tool: "Create composition", summary: '{"name":"Test"}' }];
    await waitFor(() => cards().length === 1);
    expect((doc().getElementById("approvals") as any).hidden).toBe(false);
    expect(cards()[0].textContent).toContain("Create composition");

    (cards()[0].querySelector(".allow") as any).click();
    // gone immediately, and still gone after the panel polls the bridge again
    expect(cards().length).toBe(0);
    expect((doc().getElementById("approvals") as any).hidden).toBe(true);
    await waitFor(() => answers.length === 1);
    expect(answers[0]).toEqual({ id: "a1", allow: true });
    await new Promise((r) => setTimeout(r, 1800));
    expect(cards().length).toBe(0);
  });

  it("keeps watching: the next request appears, and Deny works", async () => {
    pending = [{ id: "b2", at: new Date().toISOString(), tool: "Run script", summary: "app.project.numItems" }];
    await waitFor(() => cards().length === 1, 5000);
    (cards()[0].querySelector(".deny") as any).click();
    expect(cards().length).toBe(0);
    await waitFor(() => answers.length === 2);
    expect(answers[1]).toEqual({ id: "b2", allow: false });
  });

  it("removes cards for requests that disappear on their own (e.g. cancelled by the AI app)", async () => {
    pending = [{ id: "c3", at: new Date().toISOString(), tool: "Set property", summary: "{}" }];
    await waitFor(() => cards().length === 1, 5000);
    pending = [];
    await waitFor(() => cards().length === 0, 5000);
    expect((doc().getElementById("approvals") as any).hidden).toBe(true);
  });
});

describe("AE MCP panel update button", () => {
  const doc = () => dom.window.document;
  it("updates a standalone install in place and asks for a restart", async () => {
    await waitFor(() => !(doc().getElementById("update") as any).hidden);
    expect(doc().getElementById("updateText")!.textContent).toBe("Update available: v99.0.0");
    const btn = doc().getElementById("updateBtn") as any;
    expect(btn.textContent).toBe("Update");
    btn.click();
    expect(doc().getElementById("updateText")!.textContent).toBe("Updating to v99.0.0…");
    await waitFor(() => /Updated to v99\.0\.0/.test(doc().getElementById("updateText")!.textContent!));
    expect(updateRuns).toEqual([[process.execPath, __filename, "update", "--json"]]);
    expect(btn.hidden).toBe(true);
  });
});
