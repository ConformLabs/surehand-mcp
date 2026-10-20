// Runs the real Surehand panel (extension/index.html + its scripts) in jsdom against a fake bridge,
// with a home folder that has only the 1.3 location (~/.aemcp): the panel must use it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nodeRequire = createRequire(import.meta.url);
const ROOT = new URL("../../extension/", import.meta.url);
let server: Server;
let dom: JSDOM;
let pending: { id: string; at: string; deadline: string; tool: string; summary: string; client?: string }[] = [];
let paused: { since: string; refused: number } | null = null;
const answers: { id: string; allow: boolean; by: string }[] = [];
const evals: { script: string; fromPanel?: boolean; label?: string; secret?: string }[] = [];
const heartbeats: string[] = [];
const cli: string[][] = [];
const cliEnv: Record<string, string | undefined>[] = [];
const pauses: { paused: boolean; secret?: string }[] = [];
let home = "";
// the bridge's panel secret: handed to the panel only through the (simulated) CEP welcome event
const SECRET = "s".repeat(64);
let revision = 812;
// a test can answer server commands itself (undefined: the defaults below) and slow them down
let cliAnswer: ((cmd: string) => unknown) | null = null;
let cliDelay = 20;
// the bridge can't answer while After Effects runs a long script: /health then gets no answer
let healthDown = false;
let ownBridgeStarts = 0;

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
    const secret = req.headers["x-surehand-panel"] as string | undefined;
    if (url === "/health" && healthDown) return void req.socket.destroy();
    if (url === "/health") return json({ ok: true, authorized: true, port: 1, pid: 4242, busy: false, queue: 0, pendingApprovals: pending.length, permissionMode: "ask", paused });
    if (url.startsWith("/pending")) {
      heartbeats.push(url);
      return json({ ok: true, pending, paused });
    }
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const body = b ? JSON.parse(b) : {};
      // like the bridge: answering, pausing and the panel's own jobs need the panel secret
      if ((url === "/approve" || url === "/pause" || (url === "/eval" && body.fromPanel)) && secret !== SECRET) return json({ ok: false, error: "Only the Surehand panel" }, 403);
      if (url === "/approve") {
        const p = pending.find((x) => x.id === body.id);
        if (!p) return json({ ok: false, error: "no such request" }, 404);
        answers.push({ id: body.id, allow: body.allow, by: body.by });
        pending = pending.filter((x) => x.id !== body.id);
        return json({ ok: true });
      }
      if (url === "/pause") {
        pauses.push({ paused: body.paused, secret });
        paused = body.paused ? { since: new Date().toISOString(), refused: 0 } : null;
        return json({ ok: true, paused, saved: true });
      }
      if (url === "/eval") {
        evals.push({ ...body, secret });
        if (/project state/.test(body.label)) return json({ ok: true, result: `${revision}|/work/Spot.aep` });
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
    {
      at: at(60), client: "claude-ai", tool: "ae_set_keyframes", args: { layer: "Title", comp: "Main" }, ms: 120, ok: true, summary: '{"keys":2}', changes: 2,
      undoGroup: "Set keyframes", undoSteps: 1, revision: 812, project: "/work/Spot.aep", instance: { port, pid: 4242 },
    },
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
  let lastCfg: any = {};
  const childProcess = {
    ...nodeRequire("child_process"),
    execFile: (file: string, args: string[], opts: any, cb: (e: Error | null, out: string, err: string) => void) => {
      cli.push([file, ...args]);
      cliEnv.push(opts.env);
      const cmd = args.slice(1).join(" ");
      let out: unknown = { ok: true };
      const own = cliAnswer?.(cmd);
      if (own !== undefined) out = own;
      else if (cmd === "update --check --json") out = { ok: true, current: "test", latest: "99.0.0", updateAvailable: true, notes: ["Faster history"], checkedAt: new Date().toISOString() };
      else if (cmd === "update --json") out = { ok: true, updated: true, to: "99.0.0", message: "Updated" };
      else if (cmd === "clients --json")
        out = { ok: true, clients: [{ id: "claude-desktop", name: "Claude Desktop", installed: true, configured: true }, { id: "cursor", name: "Cursor", installed: true, configured: false }] };
      else if (cmd.startsWith("connect ")) out = { ok: true, message: "Cursor is set up. Restart Cursor." };
      else if (cmd === "test --json") out = { checks: [{ ok: true, name: "Bridge running" }] };
      setTimeout(() => cb(null, "progress\n" + JSON.stringify(out), ""), cliDelay);
      return undefined;
    },
  };
  w.require = (m: string) => (m === "os" ? os : m === "child_process" ? childProcess : nodeRequire(m));
  w.process = process;
  w.Buffer = Buffer;
  w.SUREHAND_ARM_MS = 150;
  w.SUREHAND_GONE_MS = 250;
  w.SUREHAND_CHAT_POLL_MS = 60;
  // CEP events: the bridge answers a hello with the panel secret
  const listeners: Record<string, ((e: any) => void)[]> = {};
  w.__adobe_cep__ = {
    getHostEnvironment: () => JSON.stringify({ appId: "AEFT", appVersion: "26.5" }),
    getExtensionId: () => "com.aemcp.panel",
    addEventListener: (type: string, fn: (e: any) => void) => (listeners[type] ||= []).push(fn),
    dispatchEvent: (e: any) => {
      // like After Effects: an event with an empty extensionId is dropped
      if (e.type === "com.surehand.ae.hello" && e.extensionId)
        setTimeout(() => (listeners["com.surehand.ae.welcome"] || []).forEach((fn) => fn({ type: "com.surehand.ae.welcome", data: JSON.stringify({ port, secret: SECRET }) })), 5);
    },
    invokeSync: () => "",
    getSystemPath: () => "file:///ext",
  };
  w.AEMCPBridge = {
    VERSION: "test",
    state: { port },
    // like the bridge's: the last good config while the file can't be read
    loadConfig: () => {
      try {
        return (lastCfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")));
      } catch {
        return lastCfg;
      }
    },
    hostInfo: () => ({ appName: "AEFT", appVersion: "26.5" }),
    start: () => {
      ownBridgeStarts++;
    },
  };
  for (const f of ["js/paths.js", "js/panel-model.js", "js/control.js", "js/panel.js"]) w.eval(readFileSync(new URL(f, ROOT), "utf8"));
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

  it("offers Undo for the newest change, checking the project once, not on a timer (a script during a dialog makes After Effects show an alert)", async () => {
    const undoButton = () => [...doc().querySelectorAll("#feed .acts button")].find((b: any) => b.textContent === "Undo") as any;
    await waitFor(() => !!undoButton(), 6000);
    const checks = () => evals.filter((e) => /project state/.test(e.label || "")).length;
    const n = checks();
    expect(n).toBe(1);
    await new Promise((r) => setTimeout(r, 4000));
    expect(checks()).toBe(n);
  });

  it("Undo on the newest change runs Edit > Undo in After Effects as the panel (checking project and revision again)", async () => {
    const undo = [...doc().querySelectorAll("#feed .acts button")].find((b: any) => b.textContent === "Undo") as any;
    expect(undo).toBeTruthy();
    undo.click();
    await waitFor(() => evals.some((e) => /executeCommand\(16\)/.test(e.script)));
    const call = evals.find((e) => /executeCommand\(16\)/.test(e.script))!;
    expect(call.fromPanel).toBe(true);
    expect(call.secret).toBe(SECRET);
    expect(call.script).toContain('"/work/Spot.aep"');
    expect(call.script).toContain("app.project.revision!==812");
    await waitFor(() => /^Undone: Set keyframes/.test($("toastText").textContent));
    await waitFor(() => ![...doc().querySelectorAll("#feed button")].some((b: any) => b.textContent === "Undo"));
  });

  it("Pause AI asks the bridge (with the panel secret), shows the refusals, and Resume lifts it", async () => {
    $("pause").click();
    await waitFor(() => pauses.length === 1);
    expect(pauses[0]).toEqual({ paused: true, secret: SECRET });
    await waitFor(() => $("statusText").textContent === "AI paused");
    expect($("tile").getAttribute("class")).toBe("tile amber");
    expect($("resume").hidden).toBe(false);
    paused = { since: paused!.since, refused: 3 };
    await waitFor(() => /3 refused so far/.test($("pausedNote").textContent));
    $("resume").click();
    await waitFor(() => pauses.length === 2 && $("pausedNote").hidden);
    expect(pauses[1]).toEqual({ paused: false, secret: SECRET });
    await waitFor(() => /Ready/.test($("statusText").textContent));
  });

  it("talks to the bridge extension's bridge, never to its own fallback bridge while that one runs (seen live: two bridges in one AE)", () => {
    const pick = (dom.window as any).SurehandPanel.pickPort;
    const inst = (port: number, startedAt: string) => ({ port, startedAt, listening: true });
    // the panel started its own bridge on 8767 while the real one listens on 8765: the real one
    expect(pick([inst(8765, "2026-10-19T22:31:18Z"), inst(8767, "2026-10-19T22:31:20Z")], 8767, 8765)).toBe(8765);
    // file order doesn't matter
    expect(pick([inst(8767, "2026-10-19T22:31:20Z"), inst(8765, "2026-10-19T22:31:18Z")], 8767, 8765)).toBe(8765);
    // no own bridge: the configured port, else the oldest
    expect(pick([inst(8770, "2026-10-19T22:00:00Z"), inst(8765, "2026-10-19T22:10:00Z")], null, 8765)).toBe(8765);
    expect(pick([inst(8771, "2026-10-19T22:10:00Z"), inst(8770, "2026-10-19T22:00:00Z")], null, 8765)).toBe(8770);
    // only its own bridge: that one
    expect(pick([inst(8767, "2026-10-19T22:31:20Z")], 8767, 8765)).toBe(8767);
    expect(pick([], null, 8765)).toBe(null);
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
  const armed = () => !$("allow").disabled && $("allow").textContent === "Allow";

  it("shows the oldest request as a card (the tool as title, the AI's comment quoted) and answers it with Allow", async () => {
    pending = [request("a1", "Run script", "// rebuild the lower thirds\nlayer.remove();"), request("a2", "Set property", '{"layer":"Title"}')];
    await waitFor(() => !$("ask").hidden);
    expect($("askWho").textContent).toBe("Claude Desktop asks");
    expect($("askTitle").textContent).toBe("Run script");
    expect($("askSays").textContent).toBe("rebuild the lower thirds");
    expect($("askSays").hidden).toBe(false);
    expect([...doc().querySelectorAll("#askChips .chip.danger")].map((c: any) => c.textContent)).toEqual(["deletes"]);
    expect($("askHint").textContent).toBe("Esc denies · 1 more after this");
    expect($("askTime").textContent).toMatch(/^0:4\d$/);
    expect($("statusText").textContent).toBe("Waiting for you · 2 requests");
    // it tells the bridge which request is on screen
    await waitFor(() => heartbeats.some((h) => /showing=a1/.test(h)));
    $("askShow").click();
    expect($("askCode").hidden).toBe(false);
    expect($("askCode").textContent).toMatch(/layer\.remove/);
    await waitFor(armed);
    $("allow").click();
    await waitFor(() => answers.length === 1);
    expect(answers[0]).toEqual({ id: "a1", allow: true, by: "panel" });
  });

  it("a new card can't be answered in its first moment (a click meant for the previous one does nothing)", async () => {
    await waitFor(() => $("askTitle").textContent === "Set property" && !$("ask").hidden);
    // just shown: the buttons wait ("…") and ignore clicks and Esc
    expect($("allow").disabled).toBe(true);
    expect($("allow").textContent).toBe("…");
    (dom.window as any).SurehandPanel.answer(true);
    key("Escape", 27);
    await new Promise((r) => setTimeout(r, 60));
    expect(answers).toHaveLength(1);
    await waitFor(armed);
  });

  it("Enter never allows; Esc denies", async () => {
    $("allow").focus();
    key("Enter", 13);
    $("allow").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true } as any));
    await new Promise((r) => setTimeout(r, 100));
    expect(answers).toHaveLength(1);
    key("Escape", 27);
    await waitFor(() => answers.length === 2);
    expect(answers[1]).toEqual({ id: "a2", allow: false, by: "panel" });
    await waitFor(() => $("ask").hidden);
  });

  it("says a request on screen was withdrawn (answered elsewhere or cancelled) before showing the next", async () => {
    pending = [request("c4", "Set property", "{}")];
    await waitFor(() => !$("ask").hidden, 5000);
    pending = [request("c5", "Run script", "app.project.save();")];
    await waitFor(() => !$("askGone").hidden, 5000);
    expect($("askGone").textContent).toBe("That request was withdrawn.");
    expect($("ask").hidden).toBe(true);
    await waitFor(() => !$("ask").hidden && $("askTitle").textContent === "Run script", 5000);
    expect($("askGone").hidden).toBe(true);
    expect($("allow").disabled).toBe(true); // the new one waits a moment too
    pending = [];
    await waitFor(() => $("ask").hidden && $("askGone").hidden, 5000);
  });
});

describe("Surehand panel: the settings file", () => {
  it("never saves over a config.json it can't read (torn or hand-broken), and shows the last good settings", async () => {
    const file = join(home, ".aemcp", "config.json");
    const good = readFileSync(file, "utf8");
    const panel = (dom.window as any).SurehandPanel;
    writeFileSync(file, '{"token": "t", "permiss');
    panel.menu("shellYes");
    expect(readFileSync(file, "utf8")).toBe('{"token": "t", "permiss');
    expect($("toastText").textContent).toMatch(/^Not saved: the settings file can’t be read/);
    panel.refresh();
    expect(panel.state.cfg.token).toBe("t"); // the last good copy, not defaults or a new token
    writeFileSync(file, good);
    panel.menu("shellYes");
    expect(JSON.parse(readFileSync(file, "utf8")).permissions.allowShell).toBe(true);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(home, ".aemcp")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("Surehand panel: ☰ menu", () => {
  const panel = () => (dom.window as any).SurehandPanel;

  it("builds After Effects' panel menu with checkable settings", () => {
    const xml = panel().menuXml(config());
    expect(xml).toContain('<MenuItem Id="shellYes" Label="Allowed" Enabled="true" Checkable="true" Checked="true"/>');
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

  it("Test the connection runs the server's checks as the panel (they work while the AI is paused)", async () => {
    panel().menu("test");
    await waitFor(() => /1 of 1 checks passed/.test($("screenBody").textContent));
    const i = cli.findIndex((c) => c.slice(2).join(" ") === "test --json");
    expect(cliEnv[i].SUREHAND_AE_PANEL_SECRET).toBe(SECRET);
    expect(cliEnv[i].SUREHAND_AE_BRIDGE_PORT).toBe(String((dom.window as any).AEMCPBridge.state.port));
    // other commands never get the secret
    const j = cli.findIndex((c) => c.slice(2).join(" ") === "clients --json");
    expect(cliEnv[j].SUREHAND_AE_PANEL_SECRET).toBeUndefined();
    $("back").click();
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

describe("Surehand panel: ☰ screens (live findings)", () => {
  const panel = () => (dom.window as any).SurehandPanel;
  const buttons = (text: string) => [...doc().querySelectorAll("#screenBody button, #screenAction button")].filter((b: any) => b.textContent === text) as any[];
  const after = (n: number) => cli.slice(n).map((c) => c.slice(2).join(" "));

  it("the panel's scripts stay ES5 (After Effects' older CEF)", async () => {
    const { parse } = await import("acorn");
    for (const f of ["js/panel.js", "js/panel-model.js", "js/control.js", "js/paths.js", "js/approval.js", "js/bridge-core.js"])
      expect(() => parse(readFileSync(new URL(f, ROOT), "utf8"), { ecmaVersion: 5 }), f).not.toThrow();
  });

  it("Connect: a set-up app says Connected (not \"Set up\" next to Remove); ChatGPT (web) has a short status and Start", async () => {
    cliAnswer = (cmd) =>
      cmd === "clients --json"
        ? {
            clients: [
              { id: "claude-desktop", name: "Claude Desktop", installed: true, configured: true, inUse: true },
              { id: "cursor", name: "Cursor", installed: true, configured: true, note: "connected under the old name (after-effects); Connect updates it" },
              { id: "codex", name: "ChatGPT desktop / Codex", installed: true, configured: false },
              { id: "chatgpt-web", name: "ChatGPT (web)", installed: true, configured: false, note: "Not running", action: "start", howTo: "a long explanation ".repeat(10) },
            ],
          }
        : undefined;
    panel().menu("connect");
    await waitFor(() => doc().querySelectorAll("#screenBody .client").length === 4);
    const rows = [...doc().querySelectorAll("#screenBody .client")].map((r: any) => ({ state: r.querySelector(".cstate").textContent, btn: r.querySelector("button")?.textContent }));
    expect(rows).toEqual([
      { state: "Connected \u00b7 in use now", btn: "Remove" },
      { state: "Connected \u00b7 connected under the old name", btn: "Remove" },
      { state: "Not connected", btn: "Set up" },
      { state: "Not running", btn: "Start" },
    ]);
    expect($("screenBody").textContent).not.toMatch(/Set up ·|long explanation/);
    // Start opens the ChatGPT screen (no "connect chatgpt-web", which only explained)
    const n = cli.length;
    cliAnswer = (cmd) => (cmd === "chatgpt --status --json" ? { ok: true, state: "stopped" } : undefined);
    buttons("Start")[0].click();
    expect($("screenTitle").textContent).toBe("ChatGPT on the web");
    await waitFor(() => buttons("Start").length === 1);
    expect(after(n)).not.toContain("connect chatgpt-web --json");
    // Back goes back to Connect
    $("back").click();
    expect($("screenTitle").textContent).toBe("Connect an AI app");
    $("back").click();
    expect($("screen").hidden).toBe(true);
    cliAnswer = null;
  });

  it("ChatGPT on the web: Start, starting (polls), running with the address, Copy, Stop", async () => {
    let state: any = { ok: true, state: "stopped" }, polls = 0;
    const URL_ = "https://fake-1.trycloudflare.com/mcp/" + "k".repeat(32);
    cliAnswer = (cmd) => {
      if (cmd === "chatgpt --background --json") return (state = { ok: true, state: "starting", pid: 7 });
      if (cmd === "chatgpt --status --json") {
        if (state.state === "starting" && ++polls >= 3) state = { ok: true, state: "running", url: URL_, tunnel: "cloudflared", pid: 7 };
        return state;
      }
      if (cmd === "chatgpt --stop --json") return (state = { ok: true, state: "stopped", stopped: true });
      return undefined;
    };
    panel().openScreen("chatgpt");
    await waitFor(() => buttons("Start").length === 1);
    expect($("screenBody").textContent).toMatch(/can\u2019t start programs on this computer/);
    buttons("Start")[0].click();
    await waitFor(() => /Starting the secure link/.test($("screenBody").textContent));
    await waitFor(() => !!doc().querySelector("#screenBody .urlbox"), 5000);
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(doc().querySelector("#screenBody .urlbox .mono")!.textContent).toBe(URL_);
    const steps = [...doc().querySelectorAll("#screenBody .steps li")].map((l: any) => l.textContent);
    expect(steps).toEqual([
      "In ChatGPT: Settings \u203a Apps & Connectors \u203a Advanced settings \u203a Developer mode on.",
      "Create a connector and paste this address. Authentication: No authentication.",
      "Keep this computer awake while you use it.",
    ]);
    let copied = "";
    const w = dom.window as any;
    const exec = w.document.execCommand;
    w.document.execCommand = () => ((copied = (doc().querySelector("textarea") as any)?.value ?? ""), true);
    buttons("Copy")[0].click();
    w.document.execCommand = exec;
    expect(copied).toBe(URL_);
    await waitFor(() => $("toastText").textContent === "Copied \u2014 keep it private: it contains your access key");
    // the address never lands in the feed
    expect($("feed")?.textContent ?? "").not.toContain(URL_);
    buttons("Stop")[0].click();
    await waitFor(() => buttons("Start").length === 1);
    expect(cli.map((c) => c.slice(2).join(" "))).toContain("chatgpt --stop --json");
    $("back").click();
    $("back").click();
    cliAnswer = null;
  });

  it("ChatGPT on the web: needs cloudflared (install command + Try again), and an error with Try again", async () => {
    let answer: any = { ok: false, state: "needs-tunnel", installCommand: "brew install cloudflared" };
    cliAnswer = (cmd) => (cmd.startsWith("chatgpt ") ? answer : undefined);
    panel().openScreen("chatgpt");
    await waitFor(() => /needs a free tunnel tool, cloudflared/.test($("screenBody").textContent));
    expect(doc().querySelector("#screenBody .urlbox .mono")!.textContent).toBe("brew install cloudflared");
    expect(buttons("Copy")).toHaveLength(1);
    answer = { ok: false, state: "error", error: "cloudflared stopped before giving an address (failed to dial)." };
    const n = cli.length;
    buttons("Try again")[0].click();
    await waitFor(() => /didn\u2019t start/.test($("screenBody").textContent));
    expect(after(n)).toContain("chatgpt --background --json");
    expect($("screenBody").textContent).toMatch(/failed to dial/);
    expect(buttons("Try again")).toHaveLength(1);
    panel().closeScreen();
    cliAnswer = null;
  });

  it("Connection test: shows each check's message (known names as a small readable label), a red row with Fix that connects the app", async () => {
    cliAnswer = (cmd) =>
      cmd === "test --json"
        ? {
            checks: [
              { ok: true, name: "update", message: "Surehand MCP 1.4.0 is the latest version." },
              { ok: false, name: "claude-desktop", message: "Claude Desktop: its settings name a server that no longer exists.", fix: { connect: "claude-desktop", label: "Reconnect Claude Desktop" } },
            ],
          }
        : cmd.startsWith("connect ")
          ? { ok: true, message: "Claude Desktop is connected to Surehand MCP." }
          : undefined;
    panel().menu("test");
    await waitFor(() => /1 of 2 checks passed/.test($("screenBody").textContent));
    const rows = [...doc().querySelectorAll("#screenBody .check")] as any[];
    expect(rows.map((r) => r.querySelector(".cmain").textContent)).toEqual(["Surehand MCP 1.4.0 is the latest version.", "Claude Desktop: its settings name a server that no longer exists."]);
    // known checks get a readable label; an app's check already names the app in its message
    expect(rows.map((r) => r.querySelector(".clabel")?.textContent ?? null)).toEqual(["Updates", null]);
    expect(rows[1].className).toBe("check bad");
    const fix = rows[1].querySelector("button");
    expect(fix.textContent).toBe("Fix");
    fix.click();
    await waitFor(() => cli.some((c) => c.slice(2).join(" ") === "connect claude-desktop --json"));
    await waitFor(() => /Claude Desktop is connected/.test($("toastText").textContent));
    panel().closeScreen();
    cliAnswer = null;
  });

  it("an answer that comes back late never draws its screen over another one (seen live: Connect over Checkpoints)", async () => {
    cliDelay = 300;
    panel().menu("connect");
    await waitFor(() => buttons("Set up").length > 0, 3000);
    buttons("Set up")[0].click();
    panel().menu("history"); // the user moves on before the connect answer arrives
    await new Promise((r) => setTimeout(r, 1000));
    expect($("screenTitle").textContent).toBe("Activity history");
    expect(doc().querySelector("#screenBody .client")).toBeNull();
    cliDelay = 20;
    panel().closeScreen();
  });

  it("Checkpoints: Save one now goes through the server (with its history snapshot) as the panel; Compare shows the summary first", async () => {
    const cps = [{ id: "2026-10-19-17-00-00", at: "2026-10-19T17:00:00.000Z", label: "old", file: "/cp/b.aep" }, { id: "2026-10-19-18-01-21", at: "2026-10-19T18:01:21.000Z", label: "v2", file: "/cp/a.aep", history: "h1" }];
    const DIFF = 'From: snapshot 2026-10-19-18-01-21 "v2" (checkpoint 2026-10-19-18-01-21), revision 5774\nTo:   the current project (revision 5910, not stored)\nSummary: 1 layer changed\n\n~ layer #1 "Title": Opacity 100 -> 50';
    cliAnswer = (cmd) => {
      if (cmd.startsWith("checkpoints --json")) return { checkpoints: cps };
      if (cmd.startsWith("checkpoint-save --json")) return { ok: true, checkpoint: { id: "2026-10-20-01-00-00", label: "saved in the panel", file: "/cp/c.aep", history: "h2" } };
      if (cmd.startsWith("checkpoint-diff ")) return { text: DIFF };
      return undefined;
    };
    panel().menu("checkpoints");
    await waitFor(() => doc().querySelectorAll("#screenBody .cp").length === 2);
    // newest first (the server lists oldest first)
    expect(doc().querySelectorAll("#screenBody .cp")[0].textContent).toMatch(/v2/);
    expect(doc().querySelectorAll("#screenBody .cp")[1].textContent).toMatch(/no history snapshot/);
    expect($("screenBody").textContent).not.toMatch(/saved before history existed/);
    const n = cli.length;
    buttons("Save one now")[0].click();
    await waitFor(() => $("toastText").textContent === "Checkpoint saved.");
    const i = cli.findIndex((c, k) => k >= n && c[2] === "checkpoint-save");
    expect(cli[i].slice(2)).toEqual(["checkpoint-save", "--json", "--label", "saved in the panel", "--project", expect.any(String)]);
    expect(cliEnv[i].SUREHAND_AE_PANEL_SECRET).toBe(SECRET); // works while the AI is paused
    await waitFor(() => doc().querySelectorAll("#screenBody .cp").length === 2 && buttons("Compare with now").length === 1);
    buttons("Compare with now")[0].click();
    await waitFor(() => !!doc().querySelector("#screenBody .diff-sum"));
    const out = doc().querySelector("#screenBody .diffout") as any;
    expect([...out.children].map((c: any) => c.className)).toEqual(["diff-sum", "details", "diff-meta"]);
    expect(out.children[0].textContent).toBe("1 layer changed");
    expect(out.children[1].textContent).toBe('~ layer #1 "Title": Opacity 100 -> 50');
    expect(out.children[2].textContent).toMatch(/^From: snapshot .*\nTo: the current project/);
    panel().closeScreen();
    cliAnswer = null;
  });
});

describe("Surehand panel: UX pass (menu button, refusals, long scripts)", () => {
  it("the ☰ button opens the panel's own menu; a screen opened there goes Back to it", async () => {
    $("menuBtn").click();
    expect($("screen").hidden).toBe(false);
    expect($("screenTitle").textContent).toBe("Surehand");
    const rows = [...doc().querySelectorAll("#screenBody .mrow .mlabel")].map((x: any) => x.textContent);
    expect(rows).toEqual(["Connect an AI app", "Checkpoints", "Activity history", "Test the connection", "Copy diagnostics", "Updates", "About & help"]);
    // the update that is ready shows on its row
    expect($("screenBody").textContent).toMatch(/99\.0\.0 is ready/);
    (doc().querySelectorAll("#screenBody .mrow")[0] as any).click();
    expect($("screenTitle").textContent).toBe("Connect an AI app");
    $("back").click();
    expect($("screenTitle").textContent).toBe("Surehand");
    $("back").click();
    expect($("screen").hidden).toBe(true);
    // from After Effects' own flyout, Back closes the screen
    (dom.window as any).SurehandPanel.menu("history");
    $("back").click();
    expect($("screen").hidden).toBe(true);
  });

  it("the menu's settings write the same config as the flyout", async () => {
    $("menuBtn").click();
    const seg = (label: string) => [...doc().querySelectorAll("#screenBody .mset")].find((x: any) => x.textContent.includes(label)) as any;
    [...seg("Shell commands").querySelectorAll("button")].find((b: any) => b.textContent === "Off")!.click();
    expect(config().permissions.allowShell).toBe(false);
    expect(seg("Shell commands").querySelector("button.on").textContent).toBe("Off");
    [...seg("Shell commands").querySelectorAll("button")].find((b: any) => b.textContent === "Allowed")!.click();
    expect(config().permissions.allowShell).toBe(true);
    [...seg("Tools the AI sees").querySelectorAll("button")].find((b: any) => b.textContent === "All")!.click();
    expect(config().toolProfile).toBe("full");
    [...seg("Tools the AI sees").querySelectorAll("button")].find((b: any) => b.textContent === "Core")!.click();
    expect(config().toolProfile).toBe("core");
    (dom.window as any).SurehandPanel.closeScreen();
  });

  it("Pause says so in words (not only an icon)", () => {
    expect($("pause").textContent).toBe("Pause");
  });

  it("a long script (the bridge stops answering after it answered) never starts a second bridge or says it's disconnected", async () => {
    await waitFor(() => /Ready/.test($("statusText").textContent));
    const starts = ownBridgeStarts;
    healthDown = true;
    await new Promise((r) => setTimeout(r, 4500)); // longer than the ~8 health checks after which a never-seen bridge is started
    expect($("statusText").textContent).toMatch(/Ready/);
    expect($("setup").hidden).toBe(true);
    healthDown = false;
    await new Promise((r) => setTimeout(r, 1700));
    expect(ownBridgeStarts).toBe(starts);
  }, 15_000);
});


describe("Surehand panel: which AI apps are connected", () => {
  const sessions = () => join(home, ".aemcp", "sessions");
  const statusText = () => $("statusText").textContent;
  it("says an app is connected as soon as its server runs (before its first request), and ignores a crashed one", async () => {
    mkdirSync(sessions(), { recursive: true });
    writeFileSync(join(sessions(), `${process.pid}.json`), JSON.stringify({ pid: process.pid, client: "claude-ai" }));
    writeFileSync(join(sessions(), "999999.json"), JSON.stringify({ pid: 999_999, client: "cursor" })); // gone
    await waitFor(() => statusText() === "Connected · Claude Desktop", 4000);
    // no app open any more: say so, and how to connect
    rmSync(join(sessions(), `${process.pid}.json`));
    await waitFor(() => statusText() === "No AI app open", 4000);
    await waitFor(() => !$("setup").hidden && /ask it something about your After Effects project/.test($("setupText").textContent), 4000);
    rmSync(sessions(), { recursive: true });
    await waitFor(() => /^Ready/.test(statusText()), 4000);
  });
});
