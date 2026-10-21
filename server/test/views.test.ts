// In-chat views (MCP Apps): the built view HTML, the ui:// resource, the app-only tools (hidden from the AI,
// navigation only, in every permission mode), ae_preflight's view data, and the switch that loads the view
// tools only for AI apps that show views. After Effects is faked (runJsx is mocked); nothing reaches a bridge.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

// a temporary home and config, and a closed bridge port: nothing real is touched
const home = mkdtempSync(join(tmpdir(), "surehand-views-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SUREHAND_AE_CONFIG = join(home, "config.json");
process.env.SUREHAND_AE_BRIDGE_PORT = "1";
process.env.SUREHAND_AE_NO_ACTIVITY_LOG = "1";
afterAll(() => rmSync(home, { recursive: true, force: true }));

const jsx = vi.hoisted(() => ({ runJsx: vi.fn() }));
vi.mock("../src/jsx.js", async (orig) => ({ ...(await orig<typeof import("../src/jsx.js")>()), runJsx: jsx.runJsx }));

const { buildViews } = await import("../scripts/views.mjs");
const { createMcpServer } = await import("../src/server.js");
const { resolveProfile, CORE_TOOLS } = await import("../src/tools/profile.js");
const { FRAME_JSX, PREFLIGHT_VIEW_URI, REVEAL_JSX, stillSize, viewHtml } = await import("../src/tools/views.js");
const { RENDER_KIT_JSX } = await import("../src/tools/core.js");
const { FONT_SLOT, VIEW_FONTS } = await import("../src/views/fonts.js");
const { PREFLIGHT_JSX, jsxArgs, projectChecks } = await import("../src/preflight/project.js");
const { formatReport } = await import("../src/preflight/report.js");
const { loadSpec } = await import("../src/preflight/spec.js");
const { preflightView, requestedChecks } = await import("../src/preflight/view.js");
const { encodePng } = await import("../src/png.js");
const { BridgeError } = await import("../src/bridge.js");
const { fakeProject } = await import("./fake-ae.js");
const { fixtureInput, fixtureArgs } = await import("./fixtures/preflight-view.js");

const UI_CAPS = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [RESOURCE_MIME_TYPE] } } };
const CORE = resolveProfile(["node", "surehand-ae", "--tools", "core"]);
const FULL = resolveProfile(["node", "surehand-ae", "--tools", "full"]);
const APP_ONLY = ["ae_view_frame", "ae_view_proof_frame", "ae_view_reveal", "ae_view_stress_frame", "ae_view_xray_node"];
const WITH_VIEW = ["ae_preflight", "ae_project_xray", "ae_project_history", "ae_stress_test"];

async function connect(profile = CORE, capabilities: Record<string, unknown> = UI_CAPS) {
  const server = createMcpServer(profile);
  const client = new Client({ name: "views-test", version: "1" }, { capabilities: capabilities as any });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const textOf = (r: any) => r.content.find((c: any) => c.type === "text")?.text as string;
const setMode = (mode: string) => writeFileSync(process.env.SUREHAND_AE_CONFIG!, JSON.stringify({ token: "t", permissions: { mode } }));

beforeEach(() => {
  jsx.runJsx.mockReset();
  setMode("full");
});

describe("the built views", () => {
  const views = buildViews();
  const fontsFromDisk = (f: string) => readFileSync(new URL(`../../extension/fonts/${f}`, import.meta.url)).toString("base64");

  it("are complete HTML documents that load nothing from the network", () => {
    const html = views.preflight;
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(FONT_SLOT);
    // no external script, stylesheet, image, font or import (library strings such as JSON-schema ids load nothing)
    expect(html).not.toMatch(/<script[^>]+src=|<link\b|<img[^>]+src=["']?https?:|@import|url\(\s*["']?https?:|(?:src|href)=["']?https?:/i);
    // exactly one inline script, and the code can't end it early
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  it("get the panel's fonts inlined as data: URLs", () => {
    const html = viewHtml("preflight", fontsFromDisk);
    expect(html).not.toContain(FONT_SLOT);
    expect(html.match(/url\(data:font\/woff2;base64,/g)).toHaveLength(VIEW_FONTS.length);
    for (const f of VIEW_FONTS) expect(html).toContain(`font-family:"${f.family}"`);
  });

  it("carry both themes: the panel's dark tokens and the approved light ones", () => {
    const html = views.preflight;
    expect(html).toContain("--paper: #14161A");
    expect(html).toMatch(/:root\[data-theme="light"\][^}]*--paper: #FAF8F4/);
    expect(html).toContain("outline: 2px solid var(--focus)");
  });
});

describe("the core-profile switch", () => {
  it("an AI app with views gets the view tools and the app-only tools", async () => {
    const client = await connect(CORE);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of [...WITH_VIEW, ...APP_ONLY]) expect(names).toContain(n);
    expect(names.length).toBe(CORE_TOOLS.size + WITH_VIEW.length + APP_ONLY.length);
    const pf = tools.find((t) => t.name === "ae_preflight")!;
    expect((pf._meta as any).ui.resourceUri).toBe(PREFLIGHT_VIEW_URI);
    for (const n of APP_ONLY) expect((tools.find((t) => t.name === n)!._meta as any).ui.visibility).toEqual(["app"]);
    // the app-only tools are not in the AI's catalog
    const listed = textOf(await client.callTool({ name: "ae_tools", arguments: {} }));
    for (const n of APP_ONLY) expect(listed).not.toContain(n);
    expect(textOf(await client.callTool({ name: "ae_call", arguments: { tool: "ae_view_frame", args: {} } }))).toMatch(/Unknown tool/);
    // ae_tools says the view tools are loaded now (no "*")
    expect(listed).toMatch(/^ae_preflight: /m);
    await client.close();
  });

  it("an AI app without views keeps today's core set (no view tools, no app-only tools)", async () => {
    const client = await connect(CORE, {});
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...CORE_TOOLS].sort());
    expect(textOf(await client.callTool({ name: "ae_tools", arguments: {} }))).toMatch(/^ae_preflight\*: /m);
    await client.close();
  });

  it("turning the view tools on tells the AI app once (one tools/list_changed, not one per tool)", async () => {
    for (const [profile, caps, want] of [[CORE, UI_CAPS, 1], [FULL, UI_CAPS, 1], [CORE, {}, 0]] as const) {
      const server = createMcpServer(profile);
      const client = new Client({ name: "views-test", version: "1" }, { capabilities: caps as any });
      let changed = 0;
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => void changed++);
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      const names = (await client.listTools()).tools.map((t) => t.name);
      await new Promise((r) => setTimeout(r, 20));
      expect(changed).toBe(want);
      // the same tools as before
      for (const n of APP_ONLY) expect(names.includes(n)).toBe(want === 1);
      await client.close();
    }
  });

  it("the full profile: app-only tools only for AI apps with views", async () => {
    const withViews = (await (await connect(FULL)).listTools()).tools.map((t) => t.name);
    const without = (await (await connect(FULL, {})).listTools()).tools.map((t) => t.name);
    for (const n of APP_ONLY) expect(withViews).toContain(n), expect(without).not.toContain(n);
    expect(without).toContain("ae_preflight");
    expect(withViews.length).toBe(without.length + APP_ONLY.length);
  });
});

describe("the ui:// resource", () => {
  it("is registered as an MCP App page and serves the view", async () => {
    const client = await connect(CORE);
    const { resources } = await client.listResources();
    const r = resources.find((x) => x.uri === PREFLIGHT_VIEW_URI)!;
    expect(r).toBeDefined();
    expect(r.mimeType).toBe(RESOURCE_MIME_TYPE);
    const read = await client.readResource({ uri: PREFLIGHT_VIEW_URI });
    const c = read.contents[0] as { mimeType: string; text: string };
    expect(c.mimeType).toBe(RESOURCE_MIME_TYPE);
    expect(c.text.startsWith("<!doctype html>")).toBe(true);
    expect(c.text).not.toContain(FONT_SLOT);
    await client.close();
  });
});

// a comp with a title drifting out of title-safe (as in preflight-project.test.ts)
const PROJECT = {
  comps: [{ name: "Main", fps: 25, duration: 4, layers: [{ name: "Title", type: "text" as const, anchor: [0, 0], anim: { "ADBE Position": (t: number) => [1000 + 100 * t, 540] } }] }],
  activeComp: "Main",
};
const SPEC = { name: "Broadcast", video: { width: 1920, frameRate: 25 }, safeAreas: { title: 0.1 }, text: { maxCharsPerSecond: 17 } };

describe("ae_preflight with a view", () => {
  it("returns the report text exactly as before, and the view's data in _meta only", async () => {
    const fp = fakeProject(PROJECT as any);
    jsx.runJsx.mockImplementation(async (body: string, args: any) => {
      if (body !== PREFLIGHT_JSX) throw new Error("unexpected script");
      return fp.run(body, args);
    });
    const client = await connect(CORE);
    const r: any = await client.callTool({ name: "ae_preflight", arguments: { spec: SPEC } });
    // the text as the report has always been built
    const spec = loadSpec(SPEC), raw = fakeProject(PROJECT as any).run(PREFLIGHT_JSX, jsxArgs(spec, { timeBudgetSeconds: 120 }) as any).result;
    const d = typeof raw === "string" ? JSON.parse(raw) : raw;
    const pr = projectChecks(spec, d);
    const expected = formatReport({
      title: `Preflight against "Broadcast": comp "Main" (1920x1080, 25 fps, 4 s)`,
      findings: pr.findings,
      timeBase: { fps: 25, dropFrame: false, offset: 0 },
      notRun: pr.notRun,
      skipped: ["not in the spec: project, legalRange, black, frozen, audio, flash"],
      notes: pr.notes,
    });
    expect(r.content).toEqual([{ type: "text", text: expected }]);
    expect(r.structuredContent).toBeUndefined();
    const v = r._meta["surehand/view"];
    expect(v).toMatchObject({ view: "preflight", verdict: "FAIL", verdictLine: expected.split("\n")[0], spec: "Broadcast", target: "project" });
    expect(v.comp).toMatchObject({ name: "Main", width: 1920, height: 1080, fps: 25, duration: 4, durationTc: "00:00:04:00" });
    const safe = v.findings.find((f: any) => f.check === "safeAreas.title");
    expect(safe).toMatchObject({ group: "Safe areas", severity: "fail", where: "Main › Title", layer: 1, tc: "00:00:03:08", area: { name: "title", rect: [192, 108, 1728, 972] } });
    expect(safe.box).toHaveLength(4);
    expect(v.passed).toEqual(["frame size", "frame rate", "reading speed"]);
    expect(v.counts).toEqual({ failed: 1, warnings: 0, notRun: 0, passed: 3 });
    // the measured boxes never reach the text
    expect(expected).not.toContain("1728, 972");
    await client.close();
  });

  it("says when After Effects can't be reached, for the view", async () => {
    jsx.runJsx.mockRejectedValue(new BridgeError("Cannot reach After Effects.", "NOT_RUNNING"));
    const client = await connect(CORE);
    const r: any = await client.callTool({ name: "ae_preflight", arguments: { spec: SPEC } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("Cannot reach After Effects.");
    expect(r._meta["surehand/error"]).toBe("NOT_RUNNING");
    await client.close();
  });
});

describe("preflight view data", () => {
  it("the fixture: verdict, counts, passed and not-run checks, findings in view order", () => {
    const v = preflightView(fixtureInput);
    expect(v.verdict).toBe("FAIL");
    expect(v.counts).toEqual({ failed: 3, warnings: 1, notRun: 1, passed: v.passed.length });
    expect(v.notRun).toEqual([{ check: "legalRange", label: "legal range", reason: "the file is RGB (rgb48le); legal range is measured on YUV (Y'CbCr) video" }]);
    // failed checks are not "passed"; the info finding is left out of the view
    expect(v.passed).not.toContain("audio and loudness");
    expect(v.passed).not.toContain("cap height");
    expect(v.passed).not.toContain("legal range");
    expect(v.passed).toContain("flash");
    expect(v.findings.map((f) => f.check)).toEqual(["text.capHeight", "safeAreas.title", "safeAreas.3d", "loudness"]);
    expect(v.findings[1]).toMatchObject({ tc: "00:00:12:10", tcEnd: "00:00:14:02", where: "Main › LT_Name", layer: 3 });
    expect(v.spec).toBe("broadcast-spec.json");
    expect(v.file).toMatchObject({ name: "Main_v12.mov", width: 1920, height: 1080, fps: 25 });
  });

  it("a project-only check lists the file checks as not run (they need a render)", () => {
    const v = preflightView({ ...fixtureInput, target: "project", notRun: [], findings: [], verdictLine: "PASS" });
    const labels = v.notRun.map((n) => n.label);
    expect(labels).toEqual(expect.arrayContaining(["legal range", "black frames", "frozen frames", "audio and loudness", "flash"]));
    expect(v.notRun[0].reason).toBe("Needs a render of the file. Ask to check the rendered file too.");
    expect(v.passed).toEqual(requestedChecks(fixtureInput.spec).filter((q) => q.on === "project").map((q) => q.label));
  });

  it("stays small: the fixture's data is a few kB", () => {
    expect(JSON.stringify(preflightView(fixtureInput)).length).toBeLessThan(5000);
  });
});

describe("app-only tools: navigation only, in every permission mode", () => {
  for (const mode of ["full", "ask", "read-only"]) {
    it(`ae_view_reveal and ae_view_frame run in ${mode} mode without an approval or an undo step`, async () => {
      setMode(mode);
      const png = join(home, `frame-${mode}.png`);
      jsx.runJsx.mockImplementation(async (body: string) => {
        if (body === REVEAL_JSX) return { ok: true, result: { comp: "Main", id: 12, time: 12.4, fps: 25, dst: 0, df: false, layer: "LT_Name" } };
        if (body === FRAME_JSX) {
          // a 1920x1080 frame, as saveFrameToPng writes it
          const px = new Uint8Array(1920 * 1080 * 3).fill(128);
          writeFileSync(png, encodePng(1920, 1080, px, 3));
          return { ok: true, result: { path: png, comp: "Main", time: 12.4, width: 1920, height: 1080, par: 1 } };
        }
        throw new Error("unexpected script");
      });
      const client = await connect(CORE);
      const rv: any = await client.callTool({ name: "ae_view_reveal", arguments: { comp: 12, time: 12.4, layer: 3 } });
      expect(rv.isError).toBeFalsy();
      expect(textOf(rv)).toBe('Showed "Main" at 00:00:12:10 (12.4 s), layer "LT_Name" selected.');
      const fr: any = await client.callTool({ name: "ae_view_frame", arguments: { comp: 12, time: 12.4 } });
      expect(fr.isError).toBeFalsy();
      expect(fr.content[0].mimeType).toBe("image/jpeg");
      expect(Buffer.from(fr.content[0].data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(fr._meta["surehand/view"]).toEqual({ view: "frame", comp: "Main", time: 12.4, compWidth: 1920, compHeight: 1080, width: 480, height: 270 });
      expect(fr.content[0].data.length).toBeLessThan(150_000);
      expect(existsSync(png)).toBe(false); // the temporary PNG is removed
      for (const [body, , opts] of jsx.runJsx.mock.calls) {
        expect(opts.bridge?.approval).toBeUndefined();
        // the frame: in an undo group that is undone if it changed anything (only the color settings of a
        // 32 bpc / linear blending project), after the file is written
        if (body === FRAME_JSX) expect(opts).toMatchObject({ undoGroup: "Surehand MCP frame", rollback: "deferred", checkOnly: true });
        else expect([opts.undoGroup, opts.rollback]).toEqual([false, undefined]);
      }
      await client.close();
    });
  }

  it("a bridge error carries its kind for the view's message", async () => {
    jsx.runJsx.mockRejectedValue(new BridgeError("After Effects is busy", "BLOCKED"));
    const client = await connect(CORE);
    const r: any = await client.callTool({ name: "ae_view_reveal", arguments: { comp: 1 } });
    expect(r.isError).toBe(true);
    expect(r._meta["surehand/error"]).toBe("BLOCKED");
    await client.close();
  });
});

/** Runs an ExtendScript body against a small fake comp and records what it touched. */
function runOnFakeComp(body: string, args: Record<string, unknown>, color = { bpc: 8, lb: false }) {
  const calls: string[] = [];
  // the project's color settings (written ones are logged)
  const project = {
    get bitsPerChannel() {
      return color.bpc;
    },
    set bitsPerChannel(v: number) {
      calls.push(`bpc ${v}`);
      color.bpc = v;
    },
    get linearBlending() {
      return color.lb;
    },
    set linearBlending(v: boolean) {
      calls.push(`linear blending ${v}`);
      color.lb = v;
    },
  };
  const layers = [1, 2, 3].map((i) => {
    let sel = i === 1;
    return {
      index: i,
      name: ["BG", "Logo", "LT_Name"][i - 1],
      get selected() {
        return sel;
      },
      set selected(v: boolean) {
        calls.push(`select ${i} ${v}`);
        sel = v;
      },
    };
  });
  let time = 0;
  const comp = {
    id: 12, name: "Main", numLayers: 3, duration: 30, frameDuration: 0.04, frameRate: 25, displayStartTime: 0, dropFrame: false, width: 1920, height: 1080, pixelAspect: 1,
    layer: (i: number) => layers[i - 1],
    openInViewer: () => calls.push("open"),
    saveFrameToPng: (t: number, f: { fsName: string }) => calls.push(`save ${t} ${f.fsName}`),
    get time() {
      return time;
    },
    set time(v: number) {
      calls.push(`time ${v}`);
      time = v;
    },
  };
  const aemcp = { findComp: () => comp, findLayer: (_c: unknown, ref: number) => layers[ref - 1] };
  class File {
    fsName: string;
    exists = true;
    constructor(p: string) {
      this.fsName = p;
    }
    remove() {}
  }
  const app = new Proxy({}, { get: (_t, k) => (k === "project" ? project : (calls.push(`app.${String(k)}`), undefined)) });
  const result = new Function("args", "aemcp", "app", "File", "$", body)(args, aemcp, app, File, { sleep: () => undefined });
  return { result, calls, layers };
}

describe("the app-only tools' ExtendScript", () => {
  it("reveal opens the comp, moves the time and selects only that layer; nothing else", () => {
    const { result, calls, layers } = runOnFakeComp(REVEAL_JSX, { comp: 12, time: 12.4, layer: 3 });
    expect(calls).toEqual(["open", "time 12.4", "select 1 false", "select 3 true"]);
    expect(layers.map((l) => l.selected)).toEqual([false, false, true]);
    expect(result).toMatchObject({ comp: "Main", time: 12.4, layer: "LT_Name" });
  });

  it("frame saves the comp's own frame: no temporary comp; nothing else changes in an 8 / 16 bpc project", () => {
    const { result, calls } = runOnFakeComp(FRAME_JSX, { comp: 12, time: 40, tmpDir: "/tmp/x" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^save 29\.96 \/tmp\/x\/aemcp_view_\d+\.png$/); // clamped to the last frame
    expect(result).toMatchObject({ comp: "Main", width: 1920, height: 1080, cleanup: { comps: [], layers: [], color: null } });
    expect(REVEAL_JSX).not.toMatch(/UndoGroup|executeCommand|addComp|items\.add/);
    // the shared render kit aside, the frame script adds nothing to the project
    expect(FRAME_JSX.replace(RENDER_KIT_JSX, "")).not.toMatch(/UndoGroup|executeCommand|addComp|items\.add|tempComp|hideLayer/);
  });

  it("frame in a 32 bpc project with linear blending: saved at 16 bpc without it (undone afterwards), as the viewer shows it", () => {
    const { result, calls } = runOnFakeComp(FRAME_JSX, { comp: 12, time: 1, tmpDir: "/tmp/x" }, { bpc: 32, lb: true });
    expect(calls.slice(0, 2)).toEqual(["bpc 16", "linear blending false"]);
    expect(calls[2]).toMatch(/^save 1 /);
    expect(result.cleanup.color).toEqual({ bpc: 32, lb: true });
  });

  it("are ES3 (ExtendScript)", async () => {
    const { parse } = await import("acorn");
    for (const body of [REVEAL_JSX, FRAME_JSX]) expect(() => parse(`(function(args){${body}\n})`, { ecmaVersion: 3, allowReserved: false })).not.toThrow();
  });

  it("the still keeps the comp's display aspect, about 480 px", () => {
    expect(stillSize(1920, 1080, 1, 480)).toEqual({ width: 480, height: 270 });
    expect(stillSize(1080, 1920, 1, 480)).toEqual({ width: 270, height: 480 });
    expect(stillSize(1440, 1080, 1.333, 480)).toEqual({ width: 480, height: 270 });
    expect(stillSize(320, 180, 1, 480)).toEqual({ width: 320, height: 180 });
  });
});

describe("the Preflight view in a fake AI app (jsdom)", () => {
  /** Loads the built view with a fake parent window that answers the MCP Apps messages. */
  async function host(result: any, opts: { theme?: string; onCall?: (name: string, args: any) => any } = {}) {
    const { JSDOM } = await import("jsdom");
    const sent: any[] = [];
    let win: any;
    const parent = {
      postMessage(m: any) {
        sent.push(m);
        const reply = (data: any) => {
          const ev = new win.MessageEvent("message", { data });
          Object.defineProperty(ev, "source", { value: parent });
          win.dispatchEvent(ev);
        };
        setTimeout(() => {
          if (m.method === "ui/initialize")
            reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "fake", version: "1" }, hostCapabilities: { serverTools: {}, message: {} }, hostContext: { theme: opts.theme ?? "dark" } } });
          else if (m.method === "ui/notifications/initialized") {
            reply({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: fixtureArgs } });
            reply({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result });
          } else if (m.method === "tools/call") reply({ jsonrpc: "2.0", id: m.id, result: opts.onCall?.(m.params.name, m.params.arguments) ?? { content: [{ type: "text", text: "ok" }] } });
          else if (m.method === "ui/message") reply({ jsonrpc: "2.0", id: m.id, result: {} });
        }, 0);
      },
    };
    const dom = new JSDOM(buildViews().preflight, {
      runScripts: "dangerously",
      pretendToBeVisual: true,
      beforeParse(w: any) {
        win = w;
        Object.defineProperty(w, "parent", { value: parent });
        w.ResizeObserver = class {
          observe() {}
          disconnect() {}
        };
        w.console.debug = () => undefined;
      },
    });
    const doc = dom.window.document;
    const until = async (f: () => unknown) => {
      for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(f()).toBeTruthy();
    };
    return { doc, sent, until, win: dom.window };
  }
  const result = { content: [{ type: "text", text: "FAIL (3)" }], _meta: { "surehand/view": preflightView(fixtureInput) } };

  it("draws the verdict, the counts, the groups and the rows; follows the theme", async () => {
    const { doc, until } = await host(result, { theme: "light" });
    await until(() => doc.querySelector(".verdict"));
    expect(doc.querySelector(".verdict .big")!.textContent).toBe("FAIL");
    expect(doc.querySelector(".verdict .mono")!.textContent).toBe(`3 failed · 1 warning · 1 not run · ${preflightView(fixtureInput).passed.length} passed`);
    expect(doc.querySelector(".vh .t")!.textContent).toBe("Preflight · Main");
    expect(doc.querySelector(".vh .s")!.textContent).toBe("broadcast-spec.json · 1920×1080 · 25 fps · 00:00:30:00");
    expect([...doc.querySelectorAll(".gh .eyebrow")].map((e) => e.textContent)).toEqual(["Text size", "Safe areas", "Loudness", "Not run"]);
    expect(doc.querySelectorAll(".track .m").length).toBe(4); // three timed findings and the whole-comp bar
    expect(doc.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("opening a row fetches its frame once; Show in AE, Ask the AI and Run again call the right things", async () => {
    const calls: [string, any][] = [];
    const { doc, sent, until } = await host(result, {
      onCall: (name, args) => {
        calls.push([name, args]);
        if (name === "ae_view_frame") return { content: [{ type: "image", data: "AAAA", mimeType: "image/jpeg" }], _meta: { "surehand/view": { view: "frame", comp: "Main", time: 12.4, compWidth: 1920, compHeight: 1080, width: 480, height: 270 } } };
        if (name === "ae_view_reveal") return { isError: true, content: [{ type: "text", text: "Cannot reach After Effects." }], _meta: { "surehand/error": "NOT_RUNNING" } };
        if (name === "ae_preflight") return { content: [{ type: "text", text: "PASS" }], _meta: { "surehand/view": { ...result._meta["surehand/view"], verdict: "PASS", findings: [], notRun: [], counts: { failed: 0, warnings: 0, notRun: 0, passed: 3 } } } };
      },
    });
    await until(() => doc.querySelector('[data-k="row1"]'));
    (doc.querySelector('[data-k="row1"]') as any).click();
    await until(() => doc.querySelector(".still img"));
    expect(calls[0]).toEqual(["ae_view_frame", { comp: 12, time: 12.4 }]);
    expect(doc.querySelector(".frame .cap")!.textContent).toContain("Frame 00:00:12:10, title safe dashed.");
    expect(doc.querySelector(".still .safe")).not.toBeNull();
    expect(doc.querySelector(".still .hit")).not.toBeNull();
    // closed and opened again: from the cache
    (doc.querySelector('[data-k="row1"]') as any).click();
    (doc.querySelector('[data-k="row1"]') as any).click();
    await until(() => doc.querySelector(".still img"));
    expect(calls.filter((c) => c[0] === "ae_view_frame")).toHaveLength(1);

    (doc.querySelector('[data-k="show1"]') as any).click();
    await until(() => doc.querySelector(".row .err"));
    expect(calls.at(-1)).toEqual(["ae_view_reveal", { comp: 12, time: 12.4, layer: 3 }]);
    expect(doc.querySelector(".row .err")!.textContent).toBe("After Effects isn't open. Open it, then try again.");

    (doc.querySelector('[data-k="ask1"]') as any).click();
    await until(() => sent.some((m) => m.method === "ui/message"));
    expect(sent.find((m) => m.method === "ui/message").params.content[0].text).toBe(
      "Fix the Safe areas finding at 00:00:12:10 in Main › LT_Name: outside title-safe by up to 18 px on the bottom.",
    );

    (doc.querySelector('[data-k="run"]') as any).click();
    await until(() => doc.querySelector(".verdict .big")!.textContent === "PASS");
    expect(calls.at(-1)).toEqual(["ae_preflight", fixtureArgs]);
  });

  it("a result that isn't a report (the schema, guidance) is readable text under the Preflight header, never an error line", async () => {
    const { SCHEMA_GUIDANCE } = await import("../src/tools/preflight.js");
    const schema = `${SCHEMA_GUIDANCE}\n\nJSON schema:\n{"type":"object","properties":{}}`;
    const { doc, until } = await host({ content: [{ type: "text", text: schema }] });
    await until(() => doc.querySelector(".txtres"));
    expect(doc.querySelector(".vh .t")!.textContent).toBe("Preflight");
    expect(doc.querySelector(".verdict")).toBeNull();
    expect(doc.querySelector(".err")).toBeNull();
    const body = doc.querySelector(".txtres")!;
    expect(body.textContent).toBe(schema); // all of it, wrapping (only shown in part until Show all)
    expect(body.classList.contains("collapsed")).toBe(true);
    (doc.querySelector('[data-k="text-all"]') as any).click();
    expect(body.classList.contains("collapsed")).toBe(false);
    // the no-spec guidance comes back as an error result: still text
    const g = await host({ isError: true, content: [{ type: "text", text: 'Pass the delivery spec: a path to its JSON file or the spec object. action: "schema" describes its fields.' }] });
    await g.until(() => g.doc.querySelector(".txtres"));
    expect(g.doc.querySelector(".err")).toBeNull();
    expect(g.doc.querySelector('[data-k="text-all"]')).toBeNull();
    // only After Effects not reachable / busy is an error line
    const e = await host({ isError: true, content: [{ type: "text", text: "busy" }], _meta: { "surehand/error": "BLOCKED" } });
    await e.until(() => e.doc.querySelector(".err.note"));
    expect(e.doc.querySelector(".err.note")!.textContent).toBe("After Effects is busy. Try again in a moment.");
  });

  it("Show all lists every passed check", async () => {
    const { doc, until } = await host(result);
    await until(() => doc.querySelector('[data-k="all"]'));
    const passed = preflightView(fixtureInput).passed;
    expect(doc.querySelector(".foot .sum")!.textContent).toContain("…");
    (doc.querySelector('[data-k="all"]') as any).click();
    expect(doc.querySelector(".foot .sum")!.textContent).toBe(`${passed.length} checks passed · ${passed.join(", ")}`);
  });
});
