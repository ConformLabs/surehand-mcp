// The Project X-ray in-chat view: the tree and problems built from the X-ray's facts (the text unchanged), the
// node-by-node loading of a big project, the kept runs, Show in AE for a project item, and the view itself in a
// fake AI app (jsdom). After Effects is faked: runJsx returns the fixture's facts.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const home = mkdtempSync(join(tmpdir(), "surehand-xray-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SUREHAND_AE_CONFIG = join(home, "config.json");
process.env.SUREHAND_AE_BRIDGE_PORT = "1";
process.env.SUREHAND_AE_NO_ACTIVITY_LOG = "1";
afterAll(() => rmSync(home, { recursive: true, force: true }));

const fake = vi.hoisted(() => ({ data: undefined as unknown, calls: [] as { body: string; args: any; opts: any }[] }));
vi.mock("../src/jsx.js", async (orig) => ({
  ...(await orig<typeof import("../src/jsx.js")>()),
  // the X-ray JSX returns its facts as a JSON string; the others an object
  runJsx: async (body: string, args: any, opts: any) => (fake.calls.push({ body, args, opts }), { ok: true, logs: [], result: (fake.data as any)?.comps ? JSON.stringify(fake.data) : fake.data }),
}));

const { xrayView, xrayNodeView, xrayRun, _internal } = await import("../src/tools/xray-view.js");
const { formatXray } = await import("../src/tools/xray-analyze.js");
const { REVEAL_JSX } = await import("../src/tools/views.js");
const { XRAY_JSX } = await import("../src/tools/xray.js");
const { createMcpServer } = await import("../src/server.js");
const { resolveProfile } = await import("../src/tools/profile.js");
const { buildViews } = await import("../scripts/views.mjs");
const fx = await import("./fixtures/xray-view.js");

const UI_CAPS = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };
async function connect() {
  const server = createMcpServer(resolveProfile(["node", "surehand-ae", "--tools", "core"]));
  const client = new Client({ name: "xray-test", version: "1" }, { capabilities: UI_CAPS as any });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const textOf = (r: any) => r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

beforeEach(() => {
  fake.calls = [];
  writeFileSync(process.env.SUREHAND_AE_CONFIG!, JSON.stringify({ token: "t", permissions: { mode: "full" } }));
});

describe("X-ray view data", () => {
  it("the mockup's project: chips, render queue roots, the tree's first levels, the paths to every problem", () => {
    const v = xrayView(fx.mockupProject());
    expect(v.title).toBe("X-ray · Promo_Q4_v12.aep");
    expect(v.subtitle).toBe("11 comps · 40 layers · 2 footage items · 3 in the render queue");
    expect(v.chips).toEqual([
      { tag: "missing", count: 1 },
      { tag: "fragile", count: 4 },
      { tag: "heavy", count: 3 },
      { tag: "unused", count: 4 },
    ]);
    expect(v.roots).toEqual(["q1", "q2", "q3", "g:unused"]);
    expect(v.nodes.q1).toMatchObject({ kind: "rq", name: "RQ 1 · Main_16x9", meta: "→ Main_16x9.mov", children: [{ key: "c1" }] });
    expect(v.nodes.c1).toMatchObject({ name: "Main_16x9", meta: "30 s · 14 layers", children: [{ key: "c2" }, { key: "c3" }, { key: "c5" }] });
    expect(v.nodes.c3.tags).toEqual(["fragile"]);
    expect(v.nodes.f20).toMatchObject({ kind: "footage", name: "bg_plate.exr", tags: ["missing"], item: 20 });
    expect(v.nodes["g:unused"]).toMatchObject({ name: "Not rendered", meta: "4 comps nothing in the render queue uses", childCount: 4 });
    expect(v.paths.fragile).toEqual([["q1", "c1", "c3"]]);
    expect(v.paths.missing).toEqual([["q1", "c1", "c3", "f20"]]);
    expect(v.paths.heavy).toEqual([["q1", "c1", "c5"]]);
    expect(v.paths.unused!.length).toBe(4);
  });

  it("a comp's problems: links by name grouped, the name marked, precise requests for the AI", () => {
    const v = xrayView(fx.mockupProject());
    const n = xrayNodeView(v.run, "c3");
    if (typeof n === "string") throw new Error(n);
    expect(n.children.map((c) => c.key)).toEqual(["c4", "f20"]);
    const p = n.problems[0];
    expect(p).toMatchObject({
      tag: "fragile",
      title: "An expression finds a layer by its name",
      where: "Endcard › CTA_Text › Transform › Opacity",
      code: 'thisComp.layer("Logo").transform.opacity',
      mark: '"Logo"',
      text: "Renaming Logo breaks this with an expression error at render. 3 more expressions in this comp do the same.",
      reveal: { comp: 3, layer: 1 },
    });
    expect(p.ask).toEqual({ label: "Ask the AI to make it rename-safe", text: 'Make the expression on Endcard › CTA_Text › Transform › Opacity rename-safe: thisComp.layer("Logo") finds the layer "Logo" by its name.' });
    const plate = xrayNodeView(v.run, "f20");
    if (typeof plate === "string") throw new Error(plate);
    expect(plate.problems[0]).toMatchObject({ tag: "missing", title: "File not found", reveal: { item: 20 }, ask: { label: "Ask the AI to relink it", text: 'Relink the missing footage "bg_plate.exr" (it was at /Volumes/Plates/bg_plate.exr).' } });
    const lower = xrayNodeView(v.run, "c5");
    if (typeof lower === "string") throw new Error(lower);
    expect(lower.problems.map((x) => [x.tag, x.where])).toEqual([
      ["heavy", "Lower_Thirds › Glow pass"],
      ["heavy", "Lower_Thirds › Old glow"],
      ["heavy", "Lower_Thirds › Edge"],
    ]);
    expect(lower.problems[0].text).toMatch(/^A shy layer renders normally; it's only hidden in the timeline\. Its effects: Glow, Gaussian Blur\.$/);
    expect(xrayNodeView(v.run, "c999")).toBe('No node "c999" in this X-ray.');
    expect(xrayNodeView("nope", "c1")).toMatch(/isn't kept any more/);
  });

  it("an empty render queue: the top-level comps are the roots, labelled; no unused chip", () => {
    const v = xrayView(fx.emptyQueueProject());
    expect(v.roots).toEqual(["g:top"]);
    expect(v.nodes["g:top"]).toMatchObject({ kind: "group", name: "Top-level comps", meta: "the render queue is empty: comps no other comp uses" });
    expect(v.nodes["g:top"].children!.map((c) => c.key)).toEqual(["c1", "c6", "c7", "c10", "c11", "c12", "c13"]);
    expect(v.chips.map((c) => c.tag)).toEqual(["missing", "fragile", "heavy"]);
    expect(v.subtitle).toMatch(/render queue empty$/);
  });

  it("no problems: no chips, no paths", () => {
    const v = xrayView(fx.cleanProject());
    expect(v.chips).toEqual([]);
    expect(v.paths).toEqual({});
  });

  it("a big project (about 2,000 layers): the result stays small, deeper nodes load on demand, runs are kept on disk", () => {
    const d = fx.bigProject();
    expect(d.comps.reduce((n, c) => n + c.nl, 0)).toBe(2000);
    const v = xrayView(d);
    const size = JSON.stringify(v).length;
    expect(size).toBeLessThan(30_000);
    // the first levels only: the precomp chain is 40 deep
    expect(v.nodes.c104.children).toBeUndefined();
    // but the paths to the problems are there (the missing plate is at the bottom of the chain)
    expect(v.paths.missing![0].length).toBe(42);
    expect(v.paths.missing![0].every((k) => v.nodes[k])).toBe(true);
    const deep = xrayNodeView(v.run, "c120");
    if (typeof deep === "string") throw new Error(deep);
    expect(deep.children.map((c) => c.key)).toEqual(["c121"]);
    expect(deep.problems.length).toBeGreaterThan(5);
    expect(JSON.stringify(deep).length).toBeLessThan(40_000);
    // a new server (or the in-memory runs dropped): read back from ~/.surehand/ae/xray
    _internal.runs.clear();
    expect(typeof xrayRun(v.run)).toBe("object");
  });
});

describe("ae_project_xray with a view", () => {
  it("returns the report text exactly as before, the view's data in _meta, and the nodes load through ae_view_xray_node", async () => {
    fake.data = fx.mockupProject();
    const client = await connect();
    const r: any = await client.callTool({ name: "ae_project_xray", arguments: {} });
    expect(r.content).toEqual([{ type: "text", text: formatXray(fake.data as any, {}) }]);
    expect(r.structuredContent).toBeUndefined();
    const v = r._meta["surehand/view"];
    expect(v).toMatchObject({ view: "xray", roots: ["q1", "q2", "q3", "g:unused"] });
    expect(fake.calls[0]).toMatchObject({ body: XRAY_JSX, opts: { undoGroup: false } });
    const tools = (await client.listTools()).tools;
    expect((tools.find((t) => t.name === "ae_project_xray")!._meta as any).ui.resourceUri).toBe("ui://surehand/xray.html");
    const n: any = await client.callTool({ name: "ae_view_xray_node", arguments: { run: v.run, node: "c3" } });
    expect(n._meta["surehand/view"].problems[0].title).toBe("An expression finds a layer by its name");
    await client.close();
  });

  it("Show in AE selects a project item: in every permission mode, without an undo group", async () => {
    for (const mode of ["full", "ask", "read-only"]) {
      writeFileSync(process.env.SUREHAND_AE_CONFIG!, JSON.stringify({ token: "t", permissions: { mode } }));
      fake.data = { item: "bg_plate.exr", id: 20 };
      fake.calls = [];
      const client = await connect();
      const r: any = await client.callTool({ name: "ae_view_reveal", arguments: { item: 20 } });
      expect(textOf(r), mode).toBe('Selected "bg_plate.exr" in the Project panel.');
      expect(fake.calls[0].opts.undoGroup).toBe(false);
      expect(fake.calls[0].opts.bridge?.approval).toBeUndefined();
      await client.close();
    }
  });

  it("the reveal ExtendScript selects only that item", () => {
    const items = [10, 20, 30].map((id) => ({ id, name: `item ${id}`, selected: id === 10 }));
    const app = { project: { numItems: 3, item: (i: number) => items[i - 1] } };
    const aemcp = { fail: (m: string) => { throw new Error(m); }, findComp: () => { throw new Error("no comp"); } };
    const res = new Function("args", "aemcp", "app", REVEAL_JSX)({ item: 20 }, aemcp, app);
    expect(res).toEqual({ item: "item 20", id: 20 });
    expect(items.map((i) => i.selected)).toEqual([false, true, false]);
    expect(() => new Function("args", "aemcp", "app", REVEAL_JSX)({ item: 99 }, aemcp, app)).toThrow(/No project item with id 99/);
  });
});

describe("the X-ray view in a fake AI app (jsdom)", () => {
  /** delay: how long the server takes to answer a tool call (ms) */
  async function host(view: any, onCall: (name: string, args: any) => any, delay = 0) {
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
            reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "fake", version: "1" }, hostCapabilities: { serverTools: {}, message: {} }, hostContext: { theme: "dark" } } });
          else if (m.method === "ui/notifications/initialized") reply({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "Project X-ray" }], _meta: { "surehand/view": view } } });
          else if (m.method === "tools/call") reply({ jsonrpc: "2.0", id: m.id, result: onCall(m.params.name, m.params.arguments) ?? { content: [{ type: "text", text: "ok" }] } });
          else if (m.method === "ui/message") reply({ jsonrpc: "2.0", id: m.id, result: {} });
        }, m.method === "tools/call" ? delay : 0);
      },
    };
    const dom = new JSDOM(buildViews().xray, {
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
    return { doc, sent, until };
  }
  /** the server's answers to the view's calls, computed by the real code */
  const server = (calls: [string, any][]) => (name: string, args: any) => {
    calls.push([name, args]);
    if (name === "ae_view_xray_node") {
      const v = xrayNodeView(args.run, args.node);
      return typeof v === "string" ? { isError: true, content: [{ type: "text", text: v }] } : { content: [{ type: "text", text: "node" }], _meta: { "surehand/view": v } };
    }
  };
  const names = (doc: Document) => [...doc.querySelectorAll(".node .nm")].map((e) => e.textContent);

  it("chips, the tree, the first fragile comp selected with its expression marked", async () => {
    const calls: [string, any][] = [];
    const { doc, until } = await host(xrayView(fx.mockupProject()), server(calls));
    await until(() => doc.querySelector(".detail h4"));
    expect([...doc.querySelectorAll(".chip")].map((e) => e.textContent)).toEqual(["1 MISSING", "4 FRAGILE LINKS", "3 HEAVY HIDDEN", "4 UNUSED COMPS"]);
    expect(names(doc)).toEqual(["RQ 1 · Main_16x9", "Main_16x9", "Intro", "Endcard", "Logo_Lockup", "bg_plate.exr", "Lower_Thirds", "RQ 2 · Main_9x16", "RQ 3 · Main_1x1", "Not rendered"]);
    expect(doc.querySelector(".node.sel .nm")!.textContent).toBe("Endcard");
    expect(doc.querySelector(".node.sel .tag")!.textContent).toBe("FRAGILE");
    expect(doc.querySelector(".detail .eyebrow")!.textContent).toBe("Endcard · fragile link");
    expect(doc.querySelector(".detail h4")!.textContent).toBe("An expression finds a layer by its name");
    expect(doc.querySelector(".code mark")!.textContent).toBe('"Logo"');
    expect([...doc.querySelectorAll(".legend > span")].map((e) => e.textContent)).toEqual(["MISSING file not found", "FRAGILE breaks on rename", "HEAVY costs render time while hidden"]);
    expect(calls).toEqual([["ae_view_xray_node", { run: expect.any(String), node: "c3" }]]);
  });

  it("a chip filters the tree to the nodes with that problem; again clears it", async () => {
    const calls: [string, any][] = [];
    const { doc, until } = await host(xrayView(fx.mockupProject()), server(calls));
    await until(() => doc.querySelector(".detail h4"));
    (doc.querySelector('[data-k="chip-missing"]') as any).click();
    await until(() => doc.querySelector(".detail h4")?.textContent === "File not found");
    expect(names(doc)).toEqual(["RQ 1 · Main_16x9", "Main_16x9", "Endcard", "bg_plate.exr"]);
    expect(doc.querySelector('[data-k="chip-missing"]')!.getAttribute("aria-pressed")).toBe("true");
    (doc.querySelector('[data-k="chip-missing"]') as any).click();
    expect(names(doc).length).toBeGreaterThan(4);
    (doc.querySelector('[data-k="chip-unused"]') as any).click();
    expect(names(doc)).toEqual(["Not rendered", "Endcard_old", "Endcard_v2", "Test_comp", "Logo_alt"]);
  });

  it("the node a chip selects gets its full detail, as a click does (also while another node is still loading)", async () => {
    // the live case: a placeholder plate, a slow server, the chip clicked before the first node's detail arrived
    const d = fx.mockupProject();
    d.footage[0] = { ...d.footage[0], kind: "placeholder", missing: undefined };
    const calls: [string, any][] = [];
    const { doc, until } = await host(xrayView(d), server(calls), 60);
    await until(() => doc.querySelector('[data-k="chip-missing"]'));
    (doc.querySelector('[data-k="chip-missing"]') as any).click();
    await until(() => doc.querySelector(".detail h4")?.textContent === "A placeholder instead of footage");
    expect(doc.querySelector(".node.sel .nm")!.textContent).toBe("bg_plate.exr");
    expect(doc.querySelector(".detail .eyebrow")!.textContent).toBe("bg_plate.exr · missing");
    expect([...doc.querySelectorAll(".detail button")].map((b) => b.textContent)).toEqual(["Show in AE", "Ask the AI to replace it"]);
    // and the same after the first node's late answer came in
    await new Promise((r) => setTimeout(r, 150));
    expect(doc.querySelector(".detail h4")!.textContent).toBe("A placeholder instead of footage");
    // the same from a chip once everything is loaded: clear, then filter again
    (doc.querySelector('[data-k="chip-missing"]') as any).click();
    (doc.querySelector('[data-k="chip-fragile"]') as any).click();
    await until(() => doc.querySelector(".detail h4")?.textContent === "An expression finds a layer by its name");
  });

  it("a group with no problems: a click on its name, or Enter, opens and closes it", async () => {
    const { doc, until } = await host(xrayView(fx.mockupProject()), server([]));
    await until(() => doc.querySelector(".detail h4"));
    const row = () => doc.querySelector('[data-k="n:g:unused"]') as any;
    row().querySelector(".nm").click();
    await until(() => names(doc).includes("Endcard_old"));
    expect(row().getAttribute("aria-expanded")).toBe("true");
    row().dispatchEvent(new (doc.defaultView as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => !names(doc).includes("Endcard_old"));
  });

  it("a big project: opening a node beyond the first levels fetches it", async () => {
    const calls: [string, any][] = [];
    const { doc, until } = await host(xrayView(fx.bigProject()), server(calls));
    await until(() => doc.querySelector(".detail h4"));
    expect(names(doc)).toEqual(["RQ 1 · Comp_0", "Comp_0", "Comp_1"]);
    (doc.querySelector('[data-k="n:q1/c100/c101"] .car') as any).click();
    expect(names(doc)).toEqual(["RQ 1 · Comp_0", "Comp_0", "Comp_1", "Comp_2"]);
    (doc.querySelector('[data-k="n:q1/c100/c101/c102"] .car') as any).click();
    await until(() => names(doc).includes("Comp_3"));
    expect(calls.some((c) => c[0] === "ae_view_xray_node" && c[1].node === "c102")).toBe(true);
  });

  it("Show in AE and Ask the AI; a closed group opens", async () => {
    const calls: [string, any][] = [];
    const { doc, sent, until } = await host(xrayView(fx.mockupProject()), server(calls));
    await until(() => doc.querySelector(".detail h4"));
    (doc.querySelector('[data-k="show0"]') as any).click();
    await until(() => calls.some((c) => c[0] === "ae_view_reveal"));
    expect(calls.find((c) => c[0] === "ae_view_reveal")![1]).toEqual({ comp: 3, layer: 1 });
    (doc.querySelector('[data-k="ask0"]') as any).click();
    await until(() => sent.some((m) => m.method === "ui/message"));
    expect(sent.find((m) => m.method === "ui/message").params.content[0].text).toBe('Make the expression on Endcard › CTA_Text › Transform › Opacity rename-safe: thisComp.layer("Logo") finds the layer "Logo" by its name.');
    // "Not rendered" starts closed
    expect(names(doc)).not.toContain("Endcard_old");
    (doc.querySelector('[data-k="n:g:unused"] .car') as any).click();
    await until(() => names(doc).includes("Endcard_old"));
  });

  it("no problems: one neutral chip and a plain message", async () => {
    const { doc, until } = await host(xrayView(fx.cleanProject()), server([]));
    await until(() => doc.querySelector(".chips"));
    expect(doc.querySelector(".chips")!.textContent).toBe("NO PROBLEMS FOUND");
    expect(doc.querySelector(".detail")!.textContent).toBe("Nothing missing, fragile, heavy while hidden or unused was found in what was read.");
  });
});
