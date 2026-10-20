// Runs the real Surehand panel (extension/index.html + its scripts) in jsdom against a fake bridge,
// with a home folder that has only the 1.3 location (~/.aemcp): the panel must use it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { EventEmitter } from "node:events";
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
// the chat's turns (`surehand-ae chat --agent ...`): spawned processes the test speaks for
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  written: string[] = [];
  killed = false;
  stdin = { write: (s: string) => void this.written.push(s), on: () => undefined };
  kill() {
    this.killed = true;
    this.emit("close", null);
  }
  /** the runner's events, as lines */
  say(...events: unknown[]) {
    this.stdout.emit("data", events.map((e) => JSON.stringify(e) + "\n").join(""));
  }
}
const spawned: { file: string; args: string[]; env: Record<string, string | undefined>; child: FakeChild }[] = [];

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
      else if (cmd === "update --check --json")
        out = { ok: true, current: "test", latest: "99.0.0", updateAvailable: true, notes: ["Faster history"], url: "https://example.invalid/release/v99.0.0", checkedAt: new Date().toISOString() };
      else if (cmd === "update --json") out = { ok: true, updated: true, to: "99.0.0", message: "Updated" };
      else if (cmd === "clients --json")
        out = { ok: true, clients: [{ id: "claude-desktop", name: "Claude Desktop", installed: true, configured: true }, { id: "cursor", name: "Cursor", installed: true, configured: false }] };
      else if (cmd.startsWith("connect ")) out = { ok: true, message: "Cursor is set up. Restart Cursor." };
      else if (cmd === "test --json") out = { checks: [{ ok: true, name: "Bridge running" }] };
      setTimeout(() => cb(null, "progress\n" + JSON.stringify(out), ""), cliDelay);
      return undefined;
    },
    spawn: (file: string, args: string[], opts: any) => {
      const child = new FakeChild();
      spawned.push({ file, args, env: opts.env, child });
      return child;
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
    expect($("statusGlyph").className).toBe("g g-sm g-verified");
    expect(heartbeats.some((h) => /ui=panel/.test(h))).toBe(true);
    const titles = [...doc().querySelectorAll("#feed .title")].map((t: any) => t.textContent);
    expect(titles).toEqual(["Set keyframes", "Preflight: 3 problems", "Read comp Main"]);
    // a status square and word on each row (plain reads have none), then the time
    const rows = [...doc().querySelectorAll("#feed .item")] as any[];
    expect(rows.map((r) => r.querySelector(".g").className)).toEqual(["g g-changed", "g g-failed", "g g-pending"]);
    expect(rows.map((r) => r.querySelector(".st")?.textContent ?? null)).toEqual(["Changed", "Failed", null]);
    expect(rows[0].querySelector(".meta .time").textContent).toMatch(/^\d\d:\d\d$/);
    // the panel never shows the endorsement
    expect(doc().body.textContent).not.toMatch(/Conform Labs product/);
    expect($("hostLabel").textContent).toBe("After Effects 2026");
    expect($("ver").textContent).toBe("test · update ready");
  });

  it("switches the mode and says what it means", async () => {
    const radios = () => [...doc().querySelectorAll("#modes [role=radio]")] as any[];
    expect(radios().map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect($("modeDesc").textContent).toBe("Edits directly; every step can be undone.");
    radios()[1].click();
    expect(config().permissions).toEqual({ mode: "ask", allowShell: true });
    expect(radios()[1].getAttribute("aria-checked")).toBe("true");
    expect($("modeDesc").textContent).toBe("Every change waits for your OK here.");
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
    expect($("statusGlyph").className).toBe("g g-sm g-waiting");
    expect($("resume").hidden).toBe(false);
    expect($("resume").className).toBe("btn main"); // the green main button while paused
    // the mode block is dimmed and says when it applies
    expect($("modeBox").className).toBe("modes dim");
    expect($("modeDesc").textContent).toBe("Applies when you resume.");
    expect($("pausedCount").hidden).toBe(true);
    paused = { since: paused!.since, refused: 3 };
    await waitFor(() => /3 refused so far/.test($("pausedNote").textContent));
    expect($("pausedCount").textContent).toBe("3 refused so far");
    $("resume").click();
    await waitFor(() => pauses.length === 2 && $("pausedNote").hidden);
    expect($("modeBox").className).toBe("modes");
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
    expect([...doc().querySelectorAll("#modes [role=radio]")].map((r: any) => r.textContent)).toEqual(["Full", "Ask", "Read-only"]);
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
    expect($("askHint").textContent).toBe("Esc denies · no key allows · 1 more after this");
    expect($("askTime").textContent).toMatch(/^0:4\d left$/);
    expect($("askTime").className).toBe("time num urgent"); // under a minute: amber
    expect($("statusText").textContent).toBe("Waiting for you · 2");
    expect($("statusGlyph").className).toBe("g g-sm g-waiting");
    // the card says enough: the mode's line goes while it waits
    expect($("modeDesc").hidden).toBe(true);
    // it tells the bridge which request is on screen
    await waitFor(() => heartbeats.some((h) => /showing=a1/.test(h)));
    // a danger chip ("deletes"): the script is open by itself; it is short, so there's nothing more to show
    expect($("askCode").hidden).toBe(false);
    expect($("askCode").textContent).toMatch(/layer\.remove/);
    expect($("askShow").hidden).toBe(true);
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
    expect(xml).toContain('Label="About and help…"');
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

  it("Updates shows the release notes' Markdown as formatting, and never their HTML", async () => {
    cliAnswer = (cmd) =>
      cmd === "update --check --json"
        ? {
            current: "test", latest: "99.0.0", updateAvailable: true, url: "https://example.invalid/r", checkedAt: new Date().toISOString(),
            notes: ["**Surehand MCP 99.0.0**: the release", "### In-chat views", "**Preflight report** (`ae_preflight`)", "<img src=x onerror=\"window.pwned=1\">"],
          }
        : undefined;
    const panel = () => (dom.window as any).SurehandPanel;
    panel().menu("update");
    await waitFor(() => doc().querySelectorAll("#screenBody .upd li").length === 4);
    const li = [...doc().querySelectorAll("#screenBody .upd li")] as any[];
    expect(li.map((l) => l.textContent)).toEqual(["Surehand MCP 99.0.0: the release", "In-chat views", "Preflight report (ae_preflight)", '<img src=x onerror="window.pwned=1">']);
    expect(li[0].querySelector("b").textContent).toBe("Surehand MCP 99.0.0");
    expect(li[1].className).toBe("h");
    expect(li[1].querySelector("b").textContent).toBe("In-chat views");
    expect(li[2].querySelector(".mono").textContent).toBe("ae_preflight");
    expect(doc().querySelector("#screenBody img")).toBeNull();
    expect((dom.window as any).pwned).toBeUndefined();
    cliAnswer = null;
    panel().closeScreen();
  });

  it("Updates: checks, then updates in place and asks for a restart", async () => {
    panel().menu("update");
    // the cached result first, then the server's answer (with what's new)
    await waitFor(() => /99\.0\.0 is ready/.test($("screenBody").textContent) && /Faster history/.test($("screenBody").textContent));
    // "What's new" opens the release's page
    const opened: string[] = [];
    (dom.window as any).cep = { util: { openURLInDefaultBrowser: (u: string) => opened.push(u) } };
    ([...doc().querySelectorAll("#screenBody button")].find((b: any) => b.textContent === "What’s new") as any).click();
    expect(opened).toEqual(["https://example.invalid/release/v99.0.0"]);
    delete (dom.window as any).cep;
    const btn = [...doc().querySelectorAll("#screenBody button")].find((b: any) => b.textContent === "Update now") as any;
    btn.click();
    await waitFor(() => /Updated to 99\.0\.0/.test($("screenBody").textContent));
    expect($("screenBody").textContent).toMatch(/Restart After Effects and your AI apps to finish\./);
    expect($("toastText").textContent).toBe("Updated to 99.0.0. Restart After Effects and your AI apps to finish.");
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

  it('Test: "Allow Scripts to Write Files and Access Network" off is a passed "Shell and network" row, no standing notice', async () => {
    const msg = "'Allow Scripts to Write Files and Access Network' is off: scripts can't run shell commands or use the network (Surehand's tools don't need either). " +
      "If a script needs that, turn it on in After Effects > Settings > Scripting & Expressions (Windows: Edit > Preferences > Scripting & Expressions).";
    cliAnswer = (cmd) => (cmd === "test --json" ? { checks: [{ ok: true, name: "bridge", message: "Bridge running" }, { ok: true, name: "scripting-prefs", message: msg }] } : undefined);
    try {
      panel().menu("test");
      await waitFor(() => /2 of 2 checks passed/.test($("screenBody").textContent));
      const row = [...doc().querySelectorAll("#screenBody .check")].find((c: any) => /Shell and network/.test(c.textContent)) as any;
      expect(row.className).toBe("check");
      expect(row.textContent).toMatch(/^Shell and network · 'Allow Scripts to Write Files and Access Network' is off: scripts can't run shell commands/);
      expect($("working").hidden).toBe(true);
      $("back").click();
    } finally {
      cliAnswer = null;
    }
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

  it("ChatGPT on the web: Install it for me downloads cloudflared, shows a failure, and starts once it is installed", async () => {
    let install: any = { ok: false, error: "checksum mismatch for cloudflared-darwin-arm64.tgz" };
    let state: any = { ok: false, state: "needs-tunnel", installCommand: "brew install cloudflared" };
    cliAnswer = (cmd) => (cmd === "chatgpt --install-tunnel --json" ? install : cmd.startsWith("chatgpt ") ? state : undefined);
    panel().openScreen("chatgpt");
    await waitFor(() => buttons("Install it for me").length === 1);
    // the copy-a-command route stays as the alternative
    expect(doc().querySelector("#screenBody .urlbox .mono")!.textContent).toBe("brew install cloudflared");
    let n = cli.length;
    buttons("Install it for me")[0].click();
    await waitFor(() => /Could not install cloudflared: checksum mismatch/.test($("screenBody").textContent));
    expect(after(n)).toEqual(["chatgpt --install-tunnel --json"]);
    expect((buttons("Install it for me")[0] as any).disabled).toBe(false);
    install = { ok: true, path: "/Users/x/.surehand/bin/cloudflared", version: "2026.9.3" };
    state = { ok: true, state: "starting" };
    n = cli.length;
    buttons("Install it for me")[0].click();
    await waitFor(() => after(n).includes("chatgpt --background --json"));
    expect(after(n)[0]).toBe("chatgpt --install-tunnel --json");
    await waitFor(() => $("toastText").textContent === "cloudflared is installed.");
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
    expect(doc().querySelector("#screenBody .tsum .mono-s")!.textContent).toMatch(/^1 to fix · checked \d\d:\d\d$/);
    // failing checks first, open with the message and the fix; passing ones one line: "Label · message" PASSED
    const rows = [...doc().querySelectorAll("#screenBody .check")] as any[];
    expect(rows.map((r) => r.className)).toEqual(["check bad", "check"]);
    expect(rows[0].querySelector(".clabel").textContent).toBe("Claude Desktop");
    expect(rows[0].querySelector(".cmain").textContent).toBe("Its settings name a server that no longer exists.");
    expect(rows[0].querySelector(".st").textContent).toBe("Failed");
    expect(rows[1].querySelector(".ctext").textContent).toBe("Updates · Surehand MCP 1.4.0 is the latest version");
    expect(rows[1].querySelector(".ctext .mono").textContent).toBe("1.4.0");
    expect(rows[1].querySelector(".st").textContent).toBe("Passed");
    const fix = rows[0].querySelector("button");
    expect(fix.textContent).toBe("Reconnect Claude Desktop");
    expect(fix.className).toBe("btn small main");
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
    expect(rows).toEqual(["Chat with your AI app", "Connect an AI app", "ChatGPT on the web", "Checkpoints", "Activity history", "Test the connection", "Copy diagnostics", "Updates", "About and help"]);
    // the update that is ready shows on its row
    expect($("screenBody").textContent).toMatch(/99\.0\.0 is ready · you have test/);
    expect($("screenBody").textContent).not.toMatch(/&/);
    (doc().querySelectorAll("#screenBody .mrow")[1] as any).click();
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

  it("Settings › Beta updates switches the channel and checks on it through the server, never through After Effects", async () => {
    $("menuBtn").click();
    const seg = () => [...doc().querySelectorAll("#screenBody .mset")].find((x: any) => x.textContent.includes("Beta updates")) as any;
    expect(seg().querySelector("button.on").textContent).toBe("Off");
    expect(seg().querySelector(".msub").textContent).toBe("Stable releases only.");
    const evalsBefore = evals.length, checksBefore = cli.filter((c) => c.slice(2).join(" ") === "update --check --json").length;
    cliAnswer = (cmd) =>
      cmd === "update --check --json" ? { current: "test", latest: "99.1.0-beta.2", updateAvailable: true, channel: "beta", url: "https://example.invalid/release/v99.1.0-beta.2", checkedAt: new Date().toISOString() } : undefined;
    [...seg().querySelectorAll("button")].find((b: any) => b.textContent === "On")!.click();
    expect(config().updateChannel).toBe("beta");
    expect(config().token).toBe("t"); // the rest of the settings stay
    expect($("toastText").textContent).toBe("Beta updates on: Surehand offers pre-releases too.");
    expect(seg().querySelector("button.on").textContent).toBe("On");
    expect(seg().querySelector(".msub").textContent).toBe("Pre-releases too: new features first, less tested.");
    // the stable check in update-check.json doesn't count on beta; the server's answer on beta does
    await waitFor(() => /99\.1\.0-beta\.2 is ready/.test($("screenBody").textContent));
    expect($("ver").textContent).toBe("test · update ready");
    expect(cli.filter((c) => c.slice(2).join(" ") === "update --check --json").length).toBe(checksBefore + 1);
    // and it stays through the panel's refreshes (which read files only)
    await new Promise((r) => setTimeout(r, 1700));
    expect($("ver").textContent).toBe("test · update ready");
    expect(evals.slice(evalsBefore).filter((e) => /update/i.test(e.script + (e.label || "")))).toEqual([]);
    // Off again: the beta answer no longer counts until the stable check comes back
    cliAnswer = (cmd) => (cmd === "update --check --json" ? { current: "test", latest: "99.0.0", updateAvailable: true, channel: "stable", checkedAt: new Date().toISOString() } : undefined);
    [...seg().querySelectorAll("button")].find((b: any) => b.textContent === "Off")!.click();
    expect(config().updateChannel).toBeUndefined();
    expect($("toastText").textContent).toBe("Beta updates off: stable releases only.");
    await waitFor(() => /99\.0\.0 is ready/.test($("screenBody").textContent));
    cliAnswer = null;
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

describe("Surehand panel: the menu in the Conform Labs style", () => {
  const panel = () => (dom.window as any).SurehandPanel;
  const row = (label: string) => [...doc().querySelectorAll("#screenBody .mrow")].find((r: any) => r.querySelector(".mlabel").textContent === label) as any;

  it("names the connected AI apps and ChatGPT on the web's state, from the clients it loaded", async () => {
    cliAnswer = (cmd) =>
      cmd === "clients --json"
        ? {
            clients: [
              { id: "claude-desktop", name: "Claude Desktop", installed: true, configured: true },
              { id: "cursor", name: "Cursor", installed: true, configured: true },
              { id: "codex", name: "Codex", installed: true, configured: false },
              { id: "chatgpt-web", name: "ChatGPT (web)", installed: true, configured: false, note: "Off · needs cloudflared", action: "start" },
            ],
          }
        : undefined;
    panel().menu("connect"); // loads the clients
    await waitFor(() => doc().querySelectorAll("#screenBody .client").length === 4);
    panel().closeScreen();
    $("menuBtn").click();
    expect(row("Connect an AI app").querySelector(".msub").textContent).toBe("Claude Desktop, Cursor connected");
    expect(row("ChatGPT on the web").querySelector(".msub").textContent).toBe("Off · needs cloudflared");
    // ChatGPT on the web opens its screen, and Back comes back to the menu
    cliAnswer = (cmd) => (cmd === "chatgpt --status --json" ? { ok: true, state: "stopped" } : undefined);
    row("ChatGPT on the web").click();
    expect($("screenTitle").textContent).toBe("ChatGPT on the web");
    $("back").click();
    expect($("screenTitle").textContent).toBe("Surehand");
    cliAnswer = null;
    panel().closeScreen();
  });

  it("Copy diagnostics says COPIED in its row for 2 s, in the verified colour", async () => {
    $("menuBtn").click();
    row("Copy diagnostics").click();
    await waitFor(() => row("Copy diagnostics").lastChild.textContent === "Copied");
    expect(row("Copy diagnostics").lastChild.className).toBe("st st-verified");
    await waitFor(() => row("Copy diagnostics").lastChild.textContent === "", 3000);
    panel().closeScreen();
  });
});

describe("Surehand panel: Chat with your AI app", () => {
  const panel = () => (dom.window as any).SurehandPanel;
  const row = (label: string) => [...doc().querySelectorAll("#screenBody .mrow")].find((r: any) => r.querySelector(".mlabel").textContent === label) as any;
  const body = () => $("screenBody");
  const statusText = () => $("screenStatusText").textContent;
  const send = () => [...doc().querySelectorAll("#screenBody .cbar button")][0] as any;
  const toolRows = () => [...doc().querySelectorAll("#screenBody .ctool")].map((r: any) => [r.querySelector(".title").textContent, r.querySelector(".st")?.textContent ?? null]);
  const agents = (claude: Record<string, unknown> = { signedIn: true, account: "Claude" }) => ({
    ok: true,
    agents: [
      { id: "codex", label: "Codex", found: true, signedIn: true, account: "ChatGPT", path: "/opt/homebrew/bin/codex" },
      { id: "claude", label: "Claude Code", found: true, path: "/u/.local/bin/claude", ...claude },
      { id: "agy", label: "Antigravity", found: false, signedIn: null },
    ],
  });
  const lastChild = () => spawned[spawned.length - 1].child;

  it("☰ › Work starts with the chat, saying which AI app it uses", async () => {
    Object.assign(panel().chat, { agents: null, error: null, loading: false, agent: null });
    cliAnswer = (cmd) => (cmd === "chat --agents --json" ? agents() : undefined);
    $("menuBtn").click();
    await waitFor(() => row("Chat with your AI app")?.querySelector(".msub").textContent === "Codex · signed in");
    row("Chat with your AI app").click();
    expect($("screenTitle").textContent).toBe("Chat");
    expect($("screenStatus").hidden).toBe(false);
  });

  it("a new chat: the agents found, what the chat does, what to try, Enter sends", () => {
    expect(statusText()).toBe("Codex · signed in with ChatGPT");
    expect($("screenStatusGlyph").className).toBe("g g-sm g-verified");
    const seg = [...body().querySelectorAll(".seg [role=radio]")] as any[];
    expect(seg.map((b) => [b.textContent, b.getAttribute("aria-checked")])).toEqual([["Codex", "true"], ["Claude Code", "false"]]);
    expect(body().querySelector(".modes .label").textContent).toBe("Chat with");
    expect(body().querySelector(".modes .desc").textContent).toBe("Only AI apps that are installed and signed in are listed. Each runs on its own sign-in and works in this project through Surehand, under the same Full / Ask / Read-only setting.");
    expect(body().querySelector(".modes .link").textContent).toBe("Add another AI app ›");
    expect([...body().querySelectorAll(".tries .btn")].map((b: any) => b.textContent)).toEqual(["What’s in this project?", "Check the active comp against my delivery spec", "Why does this project render slowly?"]);
    expect($("chatInput").placeholder).toBe("Ask about this project, or describe an edit…");
    expect(body().querySelector(".cbar .time").textContent).toBe("Enter sends · Shift+Enter new line");
    expect(send().textContent).toBe("Send");
    expect(send().className).toBe("btn main");
    expect(($("screenAction").querySelector("button") as any).disabled).toBe(true); // New chat
  });

  it("sends the message to `surehand-ae chat` without the panel secret, and shows the reply as it comes", async () => {
    $("chatInput").value = "Make the title land on frame 12";
    $("chatInput").dispatchEvent(new dom.window.KeyboardEvent("keydown", { keyCode: 13, bubbles: true } as any));
    expect(spawned.length).toBe(1);
    const s = spawned[0];
    expect(s.args.slice(1)).toEqual(["chat", "--agent", "codex"]);
    expect(s.env.SUREHAND_AE_PANEL_SECRET).toBeUndefined();
    expect(JSON.parse(s.child.written[0])).toEqual({ text: "Make the title land on frame 12", project: "/work/Spot.aep" });
    expect($("chatInput").value).toBe("");
    // working: the header, the disabled field, Stop
    expect(statusText()).toBe("Codex is working…");
    expect($("screenStatusGlyph").className).toBe("g g-sm g-waiting");
    expect($("chatInput").disabled).toBe(true);
    expect($("chatInput").placeholder).toBe("Codex is working…");
    expect(body().querySelector(".cbar .time").textContent).toBe("Every edit is also in the activity list");
    expect(send().textContent).toBe("Stop");
    expect(body().querySelector(".seg")).toBeNull();
    expect([...body().querySelectorAll(".cmsg.user .label, .cmsg.user .ctext")].map((x: any) => x.textContent)).toEqual(["You", "Make the title land on frame 12"]);
    s.child.say({ type: "session", id: "thread-1" }, { type: "tool", phase: "start", id: "i1", name: "ae_get_keyframes", args: { comp: "Main", layer: "Title" } });
    await waitFor(() => toolRows().length === 1);
    expect(body().querySelector(".cmsg.rhead .label").textContent).toBe("Codex");
    expect(toolRows()).toEqual([["Get keyframes", "Running"]]);
    expect(body().querySelector(".ctool .line").textContent).toBe("Main › Title");
  });

  it("in Ask mode the approval card shows in the chat; Esc there denies", async () => {
    pending = [request("chat1", "Set keyframe table", '{"layer":"Title"}')];
    pending[0].client = "codex-mcp-client";
    await waitFor(() => !$("ask").hidden && body().contains($("ask")));
    expect($("askWho").textContent).toBe("Codex asks");
    await waitFor(() => statusText() === "Waiting for you · Ask mode");
    expect($("chatInput").placeholder).toBe("Codex is waiting for your OK…");
    expect(body().querySelector(".cbar .time").textContent).toBe("Deny tells Codex it wasn’t allowed");
    await new Promise((r) => setTimeout(r, 200)); // the card arms
    doc().dispatchEvent(new dom.window.KeyboardEvent("keydown", { keyCode: 27, bubbles: true } as any));
    await waitFor(() => answers.some((a) => a.id === "chat1"));
    expect(answers.find((a) => a.id === "chat1")).toMatchObject({ allow: false });
    expect($("screenTitle").textContent).toBe("Chat"); // Esc denied, it didn't go back
    await waitFor(() => statusText() === "Codex is working…");
  });

  it("the reply, the call's end, done; the next message continues the session", async () => {
    const c = lastChild();
    c.say(
      { type: "tool", phase: "end", id: "i1", name: "ae_get_keyframes", ok: true },
      { type: "text", id: "m1", text: "Both keys now sit on **frames 12 and 24**:\n\n- `Position` key 1\n- key 2 <img src=x onerror=alert(1)>" },
      { type: "done", ok: true, session: "thread-1" },
    );
    await waitFor(() => send().textContent === "Send");
    expect(toolRows()).toEqual([["Get keyframes", null]]);
    expect([...body().querySelectorAll(".cmsg .ctext")].map((x: any) => x.textContent)).toEqual(["Make the title land on frame 12", "Both keys now sit on frames 12 and 24:Position key 1key 2 <img src=x onerror=alert(1)>"]);
    // the answer's Markdown as the panel's own text: bold, code, a list; nothing becomes HTML
    const md = [...body().querySelectorAll(".ctext.md")].pop() as any;
    expect(md.querySelector(".mp b").textContent).toBe("frames 12 and 24");
    expect([...md.querySelectorAll("ul li")].length).toBe(2);
    expect(md.querySelector("li .mono").textContent).toBe("Position");
    expect(md.querySelector("img")).toBeNull();
    // whose conversation this is, and how to switch
    expect(statusText()).toBe("Codex · New chat to switch");
    expect(($("screenAction").querySelector("button") as any).disabled).toBe(false);
    $("chatInput").value = "Thanks, check it";
    send().click();
    expect(spawned[spawned.length - 1].args.slice(1)).toEqual(["chat", "--agent", "codex", "--session", "thread-1"]);
  });

  it("Stop asks the runner to end the agent", async () => {
    const c = lastChild();
    send().click();
    expect(c.written.map((w) => JSON.parse(w))).toContainEqual({ stop: true });
    c.say({ type: "done", ok: true, session: "thread-1", stopped: true });
    await waitFor(() => send().textContent === "Send");
    expect([...body().querySelectorAll(".cmsg .muted")].map((x: any) => x.textContent)).toContain("Stopped.");
  });

  it("Back puts the approval card back in the main view", async () => {
    $("back").click();
    expect($("ask").parentNode).toBe(doc().querySelector("main.right"));
    pending = [];
    panel().closeScreen();
  });

  it("only the AI apps that are ready are offered; Add another AI app opens AI apps for chat", async () => {
    Object.assign(panel().chat, { agents: null, error: null, loading: false, items: [], session: null });
    cliAnswer = (cmd) => (cmd === "chat --agents --json" ? agents({ signedIn: false, authText: "Not logged in" }) : undefined);
    panel().openScreen("chat", "menu");
    await waitFor(() => !!body().querySelector(".modes"));
    // one ready: its name, not a choice
    expect(body().querySelector(".seg")).toBeNull();
    expect(body().querySelector(".modes .title").textContent).toBe("Codex");
    const link = [...body().querySelectorAll(".modes .link")].find((b: any) => b.textContent === "Add another AI app ›") as any;
    link.click();
    expect($("screenTitle").textContent).toBe("AI apps for chat");
    expect(statusText()).toBe("1 ready · 2 need setting up");
    expect($("screenStatusGlyph").hidden).toBe(true);
    expect(($("screenAction").querySelector("button") as any).textContent).toBe("Check again");
    const rows = [...body().querySelectorAll(".capps .item")] as any[];
    expect(rows.map((r) => [r.querySelector(".title").textContent, r.querySelector(".st").textContent, r.querySelector(".g").className])).toEqual([
      ["Codex", "Ready", "g g-verified"], ["Claude Code", "Not signed in", "g g-notrun"], ["Antigravity", "Not installed", "g g-pending"],
    ]);
    expect(rows[1].querySelector(".report").textContent).toBe("claude auth login");
    expect([...rows[1].querySelectorAll(".line")].map((l: any) => l.textContent)).toEqual([
      "Installed. To sign in, open Terminal and run:", "Sign in in the browser, then press Check again.", "Claude Code says: Not logged in",
    ]);
    expect(rows[2].querySelector(".report").textContent).toBe("agy");
    expect(body().querySelector(".sfoot").textContent).toBe("Surehand never sees your sign-in. Each AI app keeps its own.");
    // Back: the chat
    $("back").click();
    expect($("screenTitle").textContent).toBe("Chat");
    $("back").click();
    expect($("screenTitle").textContent).toBe("Surehand");
    panel().closeScreen();
  });

  it("no AI app ready: the chat opens AI apps for chat; Check again asks again", async () => {
    Object.assign(panel().chat, { agents: null, error: null, loading: false, items: [], session: null, from: null });
    const signedOut: any = agents({ signedIn: false, authText: "Not logged in" });
    signedOut.agents[0] = { ...signedOut.agents[0], signedIn: false };
    cliAnswer = (cmd) => (cmd === "chat --agents --json" ? signedOut : undefined);
    panel().openScreen("chat");
    await waitFor(() => $("screenTitle").textContent === "AI apps for chat" && !!body().querySelector(".capps"));
    expect(statusText()).toBe("0 ready · 3 need setting up");
    const asked = cli.filter((c) => c.join(" ").includes("chat --agents")).length;
    cliAnswer = (cmd) => (cmd === "chat --agents --json" ? agents() : undefined);
    ($("screenAction").querySelector("button") as any).click();
    await waitFor(() => statusText() === "2 ready · 1 need setting up");
    expect(cli.filter((c) => c.join(" ").includes("chat --agents")).length).toBe(asked + 1);
    $("back").click();
    expect($("screen").hidden).toBe(true);
    cliAnswer = null;
  });
});

describe("Surehand panel: the chat button and Panel opens on", () => {
  const panel = () => (dom.window as any).SurehandPanel;
  it("the header's chat button (between Pause and ☰) opens the chat; Back returns", async () => {
    const head = [...doc().querySelectorAll(".head button:not([hidden])")].map((b: any) => b.id);
    expect(head.slice(-2)).toEqual(["chatBtn", "menuBtn"]);
    expect($("chatBtn").getAttribute("aria-label")).toBe("Chat with your AI app");
    $("chatBtn").click();
    expect($("screenTitle").textContent).toBe("Chat");
    $("back").click();
    expect($("screen").hidden).toBe(true);
  });
  it("Settings › Panel opens on: Activity (default) or Chat, saved in the config", async () => {
    const seg = () => [...doc().querySelectorAll("#screenBody .mset")].find((x: any) => x.textContent.includes("Panel opens on")) as any;
    $("menuBtn").click();
    expect(seg().querySelector(".msub").textContent).toBe("What you see first when After Effects starts.");
    expect(seg().querySelector("button.on").textContent).toBe("Activity");
    [...seg().querySelectorAll("button")].find((b: any) => b.textContent === "Chat")!.click();
    expect(config().panelOpensOn).toBe("chat");
    expect(seg().querySelector("button.on").textContent).toBe("Chat");
    [...seg().querySelectorAll("button")].find((b: any) => b.textContent === "Activity")!.click();
    expect(config().panelOpensOn).toBeUndefined();
    panel().closeScreen();
  });
});
