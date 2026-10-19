// Runs the real approval pop-up (extension/approval.html + js/approval.js) in jsdom against a fake bridge.
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
let pending: any[] = [];
const answers: { id: string; allow: boolean; by: string }[] = [];
const polls: string[] = [];
const opened: string[] = [];
let closed = 0;
const SECRET = "p".repeat(64);

const waitFor = async (cond: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for the pop-up");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const request = (id: string, tool: string, summary: string) => ({
  id, at: new Date().toISOString(), deadline: new Date(Date.now() + 78_000).toISOString(), tool, summary, client: "claude-ai",
});

let popupPort = 0, popupHome = "";
/** A pop-up window as After Effects opens it (the real approval.html and scripts). */
function openPopup(): JSDOM {
  const port = popupPort, home = popupHome;
  const html = readFileSync(new URL("approval.html", ROOT), "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
  const d = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/" });
  const w = d.window as any;
  const os = { ...nodeRequire("os"), homedir: () => home };
  w.require = (m: string) => (m === "os" ? os : nodeRequire(m));
  w.process = process;
  w.Buffer = Buffer;
  w.SUREHAND_POPUP_CLOSE_MS = 200;
  w.SUREHAND_ARM_MS = 150;
  w.SUREHAND_GONE_MS = 250;
  const listeners: Record<string, ((e: any) => void)[]> = {};
  w.__adobe_cep__ = {
    getHostEnvironment: () => JSON.stringify({ appId: "AEFT", appVersion: "26.5" }),
    closeExtension: () => closed++,
    requestOpenExtension: (id: string) => opened.push(id),
    // the bridge answers a hello with the panel secret (a CEP event: inside After Effects only)
    addEventListener: (type: string, fn: (e: any) => void) => (listeners[type] ||= []).push(fn),
    dispatchEvent: (e: any) => {
      if (e.type === "com.surehand.ae.hello")
        setTimeout(() => (listeners["com.surehand.ae.welcome"] || []).forEach((fn) => fn({ data: JSON.stringify({ port, secret: SECRET }) })), 5);
    },
  };
  for (const f of ["js/paths.js", "js/panel-model.js", "js/control.js", "js/approval.js"]) w.eval(readFileSync(new URL(f, ROOT), "utf8"));
  return d;
}

beforeAll(async () => {
  pending = [request("p1", "Run script", "// rebuild the lower thirds\nl.remove()"), request("p2", "Set property", "{}")];
  server = createServer((req, res) => {
    const json = (o: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(o));
    if (req.url!.startsWith("/pending")) {
      polls.push(req.url!);
      return json({ ok: true, pending });
    }
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const body = JSON.parse(b || "{}");
      // like the bridge: only the panel / pop-up (with the panel secret) can answer
      if (req.headers["x-surehand-panel"] !== SECRET) return json({ ok: false, error: "Only the Surehand panel" }, 403);
      const p = pending.find((x) => x.id === body.id);
      if (!p) return json({ ok: false }, 404);
      answers.push({ id: body.id, allow: body.allow, by: body.by });
      pending = pending.filter((x) => x !== p);
      json({ ok: true });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  const home = mkdtempSync(join(tmpdir(), "surehand-popup-"));
  mkdirSync(join(home, ".surehand", "ae"), { recursive: true });
  writeFileSync(join(home, ".surehand", "ae", "config.json"), JSON.stringify({ token: "t", bridgePort: port }));

  popupPort = port;
  popupHome = home;
  dom = openPopup();
});


afterAll(() => {
  dom?.window.close();
  server?.close();
});

const $ = (id: string) => dom.window.document.getElementById(id) as any;

const armed = () => !$("pAllow").disabled && $("pAllow").textContent === "Allow";
const key = (keyCode: number, target?: any) =>
  (target ?? dom.window.document).dispatchEvent(new dom.window.KeyboardEvent("keydown", { keyCode, bubbles: true } as any));

describe("approval pop-up", () => {
  it("shows the oldest request, with who asks, the tool as title, the AI's comment quoted, chips and the time left", async () => {
    await waitFor(() => $("pWhat").textContent !== "");
    expect($("pAsks").textContent).toBe("Claude Desktop asks to");
    expect($("pWhat").textContent).toBe("Run script");
    expect($("pSays").textContent).toBe("rebuild the lower thirds");
    expect($("pChips").textContent).toBe("deletes");
    expect($("pTime").textContent).toMatch(/^1:1\d$/);
    expect($("pMore").textContent).toBe("1 more after this");
    expect(polls[0]).toBe("/pending?ui=popup");
    // it reports which request is on screen (the bridge accepts an answer only after a moment)
    await waitFor(() => polls.some((p) => p === "/pending?ui=popup&showing=p1"));
  });

  it("can't be answered in its first moment, and Enter never allows", async () => {
    $("pAllow").click(); // still "…"
    await waitFor(armed);
    expect(answers).toHaveLength(0);
    key(13);
    key(13, $("pAllow"));
    await new Promise((r) => setTimeout(r, 60));
    expect(answers).toHaveLength(0);
  });

  it("Allow answers once (with the panel secret), says so, then shows the next request", async () => {
    $("pAllow").click();
    $("pAllow").click(); // a double click is one answer
    await waitFor(() => !$("pDone").hidden);
    expect($("pDoneMsg").textContent).toBe("Allowed · closing");
    await waitFor(() => $("pWhat").textContent === "Set property" && $("pDone").hidden);
    expect(answers).toEqual([{ id: "p1", allow: true, by: "popup" }]);
    expect(closed).toBe(0);
  });

  it("Esc denies the last one, and the pop-up closes itself", async () => {
    await waitFor(armed);
    key(27);
    await waitFor(() => !$("pDone").hidden);
    expect($("pDoneMsg").textContent).toBe("Denied · closing");
    await waitFor(() => closed === 1);
    expect(answers[1]).toEqual({ id: "p2", allow: false, by: "popup" });
  });

  it("'Show details in the panel' opens the panel", async () => {
    $("pDetails").click();
    expect(opened).toEqual(["com.aemcp.panel"]);
  });

  it("says a request on screen was withdrawn (answered in the panel, cancelled) before the next one", async () => {
    dom.window.close();
    pending = [request("w1", "Run script", "app.project.save();")];
    dom = openPopup();
    await waitFor(() => $("pWhat").textContent === "Run script");
    pending = [request("w2", "Set property", "{}")];
    await waitFor(() => !$("pDone").hidden && $("pDoneMsg").textContent === "That request was withdrawn");
    await waitFor(() => $("pWhat").textContent === "Set property" && $("pDone").hidden);
    expect($("pAllow").textContent).toBe("…"); // the next one can't be answered in its first moment either
    pending = [];
    await waitFor(() => $("pDoneMsg").textContent === "That request was withdrawn" && !$("pDone").hidden);
    await waitFor(() => closed === 2);
  });
});
