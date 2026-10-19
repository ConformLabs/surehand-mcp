// Runs the real Surehand panel (extension/index.html + its scripts) in jsdom against a fake bridge,
// with a home folder that has only the 1.3 location (~/.aemcp): the panel must use it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
      if (cmd === "update --check --json") out = { ok: true, current: "test", latest: "99.0.0", updateAvailable: true, notes: ["Faster history"], checkedAt: new Date().toISOString() };
      else if (cmd === "update --json") out = { ok: true, updated: true, to: "99.0.0", message: "Updated" };
      else if (cmd === "clients --json")
        out = { ok: true, clients: [{ id: "claude-desktop", name: "Claude Desktop", installed: true, configured: true }, { id: "cursor", name: "Cursor", installed: true, configured: false }] };
      else if (cmd.startsWith("connect ")) out = { ok: true, message: "Cursor is set up. Restart Cursor." };
      else if (cmd === "test --json") out = { checks: [{ ok: true, name: "Bridge running" }] };
      setTimeout(() => cb(null, "progress\n" + JSON.stringify(out), ""), 20);
      return undefined;
    },
  };
  w.require = (m: string) => (m === "os" ? os : m === "child_process" ? childProcess : nodeRequire(m));
  w.process = process;
  w.Buffer = Buffer;
  w.SUREHAND_ARM_MS = 150;
  w.SUREHAND_GONE_MS = 250;
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
    start: () => {},
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

  it("offers Undo only while the project is as the newest change left it", async () => {
    const undoButton = () => [...doc().querySelectorAll("#feed .acts button")].find((b: any) => b.textContent === "Undo") as any;
    await waitFor(() => !!undoButton(), 6000);
    // something else changed the project since: no Undo
    revision = 813;
    (dom.window as any).SurehandPanel.state.current = null;
    await waitFor(() => !undoButton(), 8000);
    revision = 812;
    await waitFor(() => !!undoButton(), 8000);
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
