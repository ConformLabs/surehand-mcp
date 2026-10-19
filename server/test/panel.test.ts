// Runs the real Surehand panel (extension/index.html + its scripts) in jsdom against a fake bridge,
// with a home folder that has only the 1.3 location (~/.aemcp): the panel must use it.
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
let pending: { id: string; at: string; deadline: string; tool: string; summary: string; client?: string }[] = [];
let paused: { since: string; refused: number } | null = null;
const answers: { id: string; allow: boolean; by: string }[] = [];
const evals: { script: string; fromPanel?: boolean; label?: string }[] = [];
const heartbeats: string[] = [];
const cli: string[][] = [];
let home = "";

const waitFor = async (cond: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for the panel");
    await new Promise((r) => setTimeout(r, 25));
  }
};
const request = (id: string, tool: string, summary: string) => {
  const now = Date.now();
  return { id, at: new Date(now).toISOString(), deadline: new Date(now + 42_000).toISOString(), tool, summary, client: "claude-ai" };
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const json = (o: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(o));
    const url = req.url || "";
    if (url === "/health") return json({ ok: true, authorized: true, port: 1, busy: false, queue: 0, pendingApprovals: pending.length, permissionMode: "ask", paused });
    if (url.startsWith("/pending")) {
      heartbeats.push(url);
      return json({ ok: true, pending, paused });
    }
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const body = b ? JSON.parse(b) : {};
      if (url === "/approve") {
        const p = pending.find((x) => x.id === body.id);
        if (!p) return json({ ok: false, error: "no such request" }, 404);
        answers.push({ id: body.id, allow: body.allow, by: body.by });
        pending = pending.filter((x) => x.id !== body.id);
        return json({ ok: true });
      }
      if (url === "/eval") {
        evals.push(body);
        return json({ ok: true, result: /executeCommand\(16\)/.test(body.script) ? "undone" : "After Effects 26.5" });
      }
      json({ ok: true, log: [] });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;

  home = mkdtempSync(join(tmpdir(), "aemcp-panel-"));
  const dir = join(home, ".aemcp"); // a 1.3 install, not migrated to ~/.surehand/ae yet
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ token: "t", bridgePort: port, permissions: { mode: "full", allowShell: true } }));
  writeFileSync(join(dir, "update-check.json"), JSON.stringify({ latest: "99.0.0", url: "https://example.invalid/release", checkedAt: new Date().toISOString() }));
  writeFileSync(join(dir, "runtime.json"), JSON.stringify({ node: process.execPath, server: __filename }));
  const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  const log = [
    { at: at(600), client: "claude-ai", tool: "ae_get_comp_info", args: { comp: "Main" }, ms: 30, ok: true, summary: "{}" },
    { at: at(300), client: "claude-ai", tool: "ae_preflight", args: { comp: "Main" }, ms: 3000, ok: true, summary: "FAIL (3)" },
    { at: at(60), client: "claude-ai", tool: "ae_set_keyframes", args: { layer: "Title", comp: "Main" }, ms: 120, ok: true, summary: '{"keys":2}', changes: 2 },
  ];
  writeFileSync(join(dir, "activity.jsonl"), log.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const html = readFileSync(new URL("index.html", ROOT), "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
  dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/" });
  const w = dom.window as any;
  w.alert = () => {
    throw new Error("the panel must not use alert()");
  };
  w.document.execCommand = () => true; // clipboard
  // the panel's Node APIs: real http/path/fs, os pointed at a temporary home folder, a fake server CLI
  const os = { ...nodeRequire("os"), homedir: () => home };
  const childProcess = {
    ...nodeRequire("child_process"),
    execFile: (file: string, args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      cli.push([file, ...args]);
      const cmd = args.slice(1).join(" ");
      let out: unknown = { ok: true };
      if (cmd === "update --check --json") out = { ok: true, current: "test", latest: "99.0.0", updateAvailable: true, notes: ["Faster history"], checkedAt: new Date().toISOString() };
      else if (cmd === "update --json") out = { ok: true, updated: true, to: "99.0.0", message: "Updated" };
      else if (cmd === "clients --json")
        out = { ok: true, clients: [{ id: "claude-desktop", name: "Claude Desktop", installed: true, configured: true }, { id: "cursor", name: "Cursor", installed: true, configured: false }] };
      else if (cmd.startsWith("connect ")) out = { ok: true, message: "Cursor is set up. Restart Cursor." };
      setTimeout(() => cb(null, "progress\n" + JSON.stringify(out), ""), 20);
      return undefined;
    },
  };
  w.require = (m: string) => (m === "os" ? os : m === "child_process" ? childProcess : nodeRequire(m));
  w.process = process;
  w.Buffer = Buffer;
  w.AEMCPBridge = {
    VERSION: "test",
    state: { port },
    loadConfig: () => JSON.parse(readFileSync(join(dir, "config.json"), "utf8")),
    hostInfo: () => ({ appName: "AEFT", appVersion: "26.5" }),
    start: () => {},
  };
  for (const f of ["js/paths.js", "js/panel-model.js", "js/panel.js"]) w.eval(readFileSync(new URL(f, ROOT), "utf8"));
});

afterAll(() => {
  dom?.window.close();
  server?.close();
});

const doc = () => dom.window.document;
const $ = (id: string) => doc().getElementById(id) as any;
const config = () => JSON.parse(readFileSync(join(home, ".aemcp", "config.json"), "utf8"));
const key = (k: string, keyCode: number) => doc().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, keyCode, bubbles: true } as any));

describe("Surehand panel: main view", () => {
  it("uses the 1.3 files in ~/.aemcp, shows the AI app and the feed, and reports in to the bridge", async () => {
    await waitFor(() => /Ready/.test($("statusText").textContent) && heartbeats.length > 0);
    expect($("statusText").textContent).toBe("Ready · Claude Desktop");
    expect($("tile").getAttribute("class")).toBe("tile green");
    expect(heartbeats.some((h) => /ui=panel/.test(h))).toBe(true);
    const titles = [...doc().querySelectorAll("#feed .title")].map((t: any) => t.textContent);
    expect(titles).toEqual(["Set keyframes", "Preflight: 3 problems", "Read comp Main"]);
    expect($("hostLabel").textContent).toBe("After Effects 2026");
    expect($("ver").textContent).toBe("test · update ready");
  });

  it("switches the mode and says what it means", async () => {
    const radios = () => [...doc().querySelectorAll("#modes [role=radio]")] as any[];
    expect(radios().map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect($("modeDesc").textContent).toMatch(/^The AI edits your project directly/);
    radios()[1].click();
    expect(config().permissions).toEqual({ mode: "ask", allowShell: true });
    expect(radios()[1].getAttribute("aria-checked")).toBe("true");
    expect($("modeDesc").textContent).toMatch(/^Every change waits for your OK/);
  });

  it("Undo on the newest change runs Edit > Undo in After Effects as the panel", async () => {
    const undo = [...doc().querySelectorAll("#feed .acts button")].find((b: any) => b.textContent === "Undo") as any;
    expect(undo).toBeTruthy();
    undo.click();
    await waitFor(() => evals.some((e) => /executeCommand\(16\)/.test(e.script)));
    expect(evals.find((e) => /executeCommand\(16\)/.test(e.script))!.fromPanel).toBe(true);
    await waitFor(() => /^Undone: Set keyframes/.test($("toastText").textContent));
    await waitFor(() => ![...doc().querySelectorAll("#feed button")].some((b: any) => b.textContent === "Undo"));
  });

  it("Pause AI writes the flag the bridge enforces, shows the refusals, and Resume clears it", async () => {
    $("pause").click();
    expect(config()).toMatchObject({ paused: true });
    expect(typeof config().pausedAt).toBe("string");
    expect($("statusText").textContent).toBe("AI paused");
    expect($("tile").getAttribute("class")).toBe("tile amber");
    expect($("resume").hidden).toBe(false);
    paused = { since: config().pausedAt, refused: 3 };
    await waitFor(() => /3 refused so far/.test($("pausedNote").textContent));
    $("resume").click();
    paused = null;
    expect(config().paused).toBeUndefined();
    expect($("pausedNote").hidden).toBe(true);
    await waitFor(() => /Ready/.test($("statusText").textContent));
  });

  it("picks the layout from the panel's size", async () => {
    const w = dom.window as any;
    const size = (width: number, height: number) => {
      Object.defineProperty(w, "innerWidth", { value: width, configurable: true });
      Object.defineProperty(w, "innerHeight", { value: height, configurable: true });
      w.dispatchEvent(new w.Event("resize"));
    };
    size(220, 560);
    expect(doc().body.className).toMatch(/layout-narrow/);
    await waitFor(() => $("statusText").textContent === "Ready");
    expect([...doc().querySelectorAll("#modes [role=radio]")].map((r: any) => r.textContent)).toEqual(["Full", "Ask", "Read"]);
    size(760, 200);
    expect(doc().body.className).toMatch(/layout-wide/);
    size(320, 560);
    expect(doc().body.className).toMatch(/layout-default/);
    expect(doc().body.className).not.toMatch(/layout-wide/);
  });
});

describe("Surehand panel: approvals", () => {
  it("shows the oldest request as a card and answers it with Allow", async () => {
    pending = [request("a1", "Run script", "// rebuild the lower thirds\nlayer.remove();"), request("a2", "Set property", '{"layer":"Title"}')];
    await waitFor(() => !$("ask").hidden);
    expect($("askWho").textContent).toBe("Claude Desktop asks");
    expect($("askTitle").textContent).toBe("Run script: rebuild the lower thirds");
    expect([...doc().querySelectorAll("#askChips .chip.danger")].map((c: any) => c.textContent)).toEqual(["deletes"]);
    expect($("askHint").textContent).toBe("Enter allows · Esc denies · 1 more after this");
    expect($("askTime").textContent).toMatch(/^0:4\d$/);
    expect($("statusText").textContent).toBe("Waiting for you · 2 requests");
    $("askShow").click();
    expect($("askCode").hidden).toBe(false);
    expect($("askCode").textContent).toMatch(/layer\.remove/);
    $("allow").click();
    // the next one shows at once
    expect($("askTitle").textContent).toBe("Set property");
    await waitFor(() => answers.length === 1);
    expect(answers[0]).toEqual({ id: "a1", allow: true, by: "panel" });
  });

  it("Enter allows and Esc denies", async () => {
    await waitFor(() => $("askTitle").textContent === "Set property" && !$("ask").hidden);
    key("Enter", 13);
    await waitFor(() => answers.length === 2);
    expect(answers[1]).toEqual({ id: "a2", allow: true, by: "panel" });
    pending = [request("b3", "Set property", "{}")];
    await waitFor(() => !$("ask").hidden && $("askTitle").textContent === "Set property", 5000);
    key("Escape", 27);
    await waitFor(() => answers.length === 3);
    expect(answers[2]).toEqual({ id: "b3", allow: false, by: "panel" });
    await waitFor(() => $("ask").hidden);
  });

  it("removes cards for requests answered elsewhere (the pop-up) or cancelled", async () => {
    pending = [request("c4", "Set property", "{}")];
    await waitFor(() => !$("ask").hidden, 5000);
    pending = [];
    await waitFor(() => $("ask").hidden, 5000);
  });
});

describe("Surehand panel: ☰ menu", () => {
  const panel = () => (dom.window as any).SurehandPanel;

  it("builds After Effects' panel menu with checkable settings", () => {
    const xml = panel().menuXml(config());
    expect(xml).toContain('<MenuItem Id="shellYes" Label="Yes" Enabled="true" Checkable="true" Checked="true"/>');
    expect(xml).toContain('<MenuItem Id="toolsCore" Label="Core (faster)" Enabled="true" Checkable="true" Checked="true"/>');
    expect(xml).toContain('Label="About &amp; help…"');
    panel().menu("shellNo");
    expect(config().permissions.allowShell).toBe(false);
    panel().menu("toolsAll");
    expect(config().toolProfile).toBe("full");
    expect(panel().menuXml(config())).toContain('Id="toolsAll" Label="All tools" Enabled="true" Checkable="true" Checked="true"');
  });

  it("Copy diagnostics says so in a toast", async () => {
    panel().menu("diag");
    await waitFor(() => /^Diagnostics copied/.test($("toastText").textContent));
  });

  it("Connect: lists the AI apps and sets one up through the server's CLI", async () => {
    panel().menu("connect");
    expect($("screen").hidden).toBe(false);
    expect($("screenTitle").textContent).toBe("Connect an AI app");
    await waitFor(() => doc().querySelectorAll("#screenBody .client").length === 2);
    const btn = [...doc().querySelectorAll("#screenBody .client button")].find((b: any) => b.textContent === "Set up") as any;
    btn.click();
    await waitFor(() => cli.some((c) => c.slice(2).join(" ") === "connect cursor --json"));
    await waitFor(() => /Cursor is set up/.test($("toastText").textContent));
    key("Escape", 27);
    expect($("screen").hidden).toBe(true);
  });

  it("Updates: checks, then updates in place and asks for a restart", async () => {
    panel().menu("update");
    // the cached result first, then the server's answer (with what's new)
    await waitFor(() => /99\.0\.0 is ready/.test($("screenBody").textContent) && /Faster history/.test($("screenBody").textContent));
    const btn = [...doc().querySelectorAll("#screenBody button")].find((b: any) => b.textContent === "Update now") as any;
    btn.click();
    await waitFor(() => /Updated to 99\.0\.0/.test($("screenBody").textContent));
    expect(cli.map((c) => c.slice(2).join(" "))).toEqual(expect.arrayContaining(["update --check --json", "update --json"]));
    expect(cli.every((c) => c[0] === process.execPath && c[1] === __filename)).toBe(true);
    $("back").click();
    expect($("screen").hidden).toBe(true);
  });

  it("Activity history: search and filters", async () => {
    panel().menu("history");
    const rows = () => [...doc().querySelectorAll("#screenBody .hrow .htitle")].map((t: any) => t.textContent);
    expect(rows()).toEqual(["Set keyframes", "Preflight: 3 problems", "Read comp Main"]);
    const problems = [...doc().querySelectorAll("#screenBody .filters button")].find((b: any) => /Problems/.test(b.textContent)) as any;
    expect(problems.textContent).toBe("Problems 1");
    problems.click();
    expect(rows()).toEqual(["Preflight: 3 problems"]);
    const all = doc().querySelector("#screenBody .filters button") as any;
    all.click();
    const search = $("hsearch");
    search.value = "title";
    search.dispatchEvent(new (dom.window as any).Event("input"));
    expect(rows()).toEqual(["Set keyframes"]);
    $("back").click();
  });
});
