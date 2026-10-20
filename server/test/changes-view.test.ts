// The "What changed, and the proof" in-chat view: the change report and the history diff as structured rows
// (the text unchanged), ae_prove_identical's view data and kept comparison frames, ae_view_proof_frame, and
// the view itself in a fake AI app (jsdom). After Effects is faked: runJsx "renders" PNGs as prove.test.ts does.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const home = mkdtempSync(join(tmpdir(), "surehand-changes-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SUREHAND_AE_CONFIG = join(home, "config.json");
process.env.SUREHAND_AE_BRIDGE_PORT = "1";
process.env.SUREHAND_AE_NO_ACTIVITY_LOG = "1";
afterAll(() => rmSync(home, { recursive: true, force: true }));

const { encodePng } = await import("../src/png.js");
/** the fake comp: 32x16, a 4x4 square at x = square; shade = its red */
const scene = { square: 10, shade: 200 };
const draw = () => {
  const px = new Uint8Array(32 * 16 * 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 32; x++) px.set(x >= scene.square && x < scene.square + 4 && y >= 2 && y < 6 ? [scene.shade, 40, 40, 255] : [0, 0, 0, 255], (y * 32 + x) * 4);
  return encodePng(32, 16, px, 4);
};
const batchChanges = {
  items: [],
  layers: [["-", "Main", "Logo_Lockup"], ["~", "Main", "Logo_Type", "parent none -> Logo_Null"]],
  props: [["~", "Logo_Mark", "Transform/Scale", "[100,100] -> [64,64]", "Main"]],
  scope: ["Main"],
};

vi.mock("../src/jsx.js", async (orig) => {
  const real = await orig<typeof import("../src/jsx.js")>();
  return {
    ...real,
    runJsx: async (body: string, args: any) => {
      const { PROVE_RENDER_JSX } = await import("../src/tools/prove.js");
      if (body === PROVE_RENDER_JSX) {
        const out = args.comps.map((spec: any) => {
          const times = spec.times ?? (args.times ?? [0, 1, 2, 3]);
          const frames = times.map((time: number, j: number) => {
            const path = join(args.dir, `${args.prefix}12_${j}.png`);
            writeFileSync(path, draw());
            return { time, path };
          });
          return { id: 12, name: "Main", width: 32, height: 16, pixelAspect: 1, frameRate: 25, renderW: 32, renderH: 16, frames };
        });
        return { ok: true, logs: [], result: { project: "/work/spot.aep", comps: out }, rollback: { undone: true, verified: true } };
      }
      // the ae_batch body: moves the square from the third frame on (here: every frame), reports its changes
      scene.square = 14;
      return { ok: true, logs: [], result: { steps: args.stepArgs.map(() => ({ ok: true })), failed: -1 }, changes: batchChanges };
    },
  };
});

const { changesFromReport, splitChange, splitField } = await import("../src/view-changes.js");
const { prettyChange, prettyValue } = await import("../src/views/format.js");
const { diffSnapshots, formatDiff } = await import("../src/history-diff.js");
const { historyView } = await import("../src/tools/history.js");
const { proofView } = await import("../src/tools/prove.js");
const { createMcpServer } = await import("../src/server.js");
const { resolveProfile } = await import("../src/tools/profile.js");
const { buildViews } = await import("../scripts/views.mjs");
const fx = await import("./fixtures/changes-view.js");

const UI_CAPS = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };
async function connect() {
  const server = createMcpServer(resolveProfile(["node", "surehand-ae", "--tools", "core"]));
  const client = new Client({ name: "changes-test", version: "1" }, { capabilities: UI_CAPS as any });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const setMode = (mode: string) => writeFileSync(process.env.SUREHAND_AE_CONFIG!, JSON.stringify({ token: "t", permissions: { mode } }));
const textOf = (r: any) => r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

beforeEach(() => {
  scene.square = 10;
  scene.shade = 200;
  setMode("full");
});

describe("values in the panel's units (view only)", () => {
  it("scale, position, opacity, rotation, colour; z only for 3D; anything else as it is", () => {
    expect(prettyChange("Scale", "[80,80,100]", "[70,70,100]")).toEqual({ from: "80 %", to: "70 %" });
    expect(prettyChange("Scale", "[80,60,100]", "[70,70,50]")).toEqual({ from: "80 × 60 × 100 %", to: "70 × 70 × 50 %" });
    expect(prettyChange("Position", "default", "[1210,388,0]")).toEqual({ from: "default", to: "1210, 388 px" });
    expect(prettyChange("Position", "[960,540,0]", "[960,540,-200]")).toEqual({ from: "960, 540, 0 px", to: "960, 540, -200 px" });
    expect(prettyChange("Opacity", "100", "37.5")).toEqual({ from: "100 %", to: "37.5 %" });
    expect(prettyChange("Z Rotation", "0", "-12.25")).toEqual({ from: "0°", to: "-12.25°" });
    expect(prettyChange("Fill Color", "[1,0.541,0.361,1]", "[0,0,0,1]")).toEqual({ from: "#FF8A5C", to: "#000000" });
    expect(prettyChange("parent", "none", "Logo_Null")).toEqual({ from: "none", to: "Logo_Null" });
    expect(prettyChange("Source Text", '"Hello"', '"Hi"')).toEqual({ from: '"Hello"', to: '"Hi"' });
    expect(prettyValue("Opacity", "[1,2]")).toBe("[1,2]");
  });
});

describe("changes as view rows", () => {
  it("one change splits into old and new; anything else stays a phrase", () => {
    expect(splitChange("[100,100] -> [64,64]")).toEqual({ from: "[100,100]", to: "[64,64]" });
    expect(splitChange("keyframes 2 -> 3, expression added")).toBeNull();
    expect(splitChange("a -> b; c -> d")).toBeNull();
    expect(splitField("parent none -> Logo_Null")).toEqual({ what: "parent", from: "none", to: "Logo_Null" });
  });

  it("the change report: comp › layer › property, a removed layer only opens its comp", () => {
    expect(changesFromReport(fx.editChanges).slice(0, 2)).toEqual([
      { op: "-", comp: "Endcard", layer: "Logo_Lockup", what: "Logo_Lockup removed" },
      { op: "+", comp: "Endcard", layer: "Logo_Mark", what: "Logo_Mark added" },
    ]);
    const rows = changesFromReport(fx.editChanges);
    expect(rows).toContainEqual({ op: "~", comp: "Endcard", layer: "Logo_Type", what: "parent", from: "none", to: "Logo_Null" });
    expect(rows).toContainEqual({ op: "~", comp: "Endcard", layer: "Logo_Mark", path: "Transform", what: "Scale", from: "[100,100]", to: "[64,64]" });
    expect(rows).toContainEqual({ op: "~", comp: "Endcard", layer: "Logo_Type", path: "Transform", what: "Opacity: keyframes 2 -> 3, expression added" });
    expect(changesFromReport({ items: [], layers: [], props: [], scope: [], unlisted: true })).toEqual([]);
  });

  it("the history diff: the same changes as rows beside the unchanged text", () => {
    const d = diffSnapshots(fx.historyFrom, fx.historyTo);
    const text = formatDiff(d);
    expect(text).toContain('~ layer #4 "Logo_Mark": renamed from "Logo_Lockup"');
    expect(text).toContain("~ Logo_Mark > Transform/Scale: [100,100,100] -> [64,64,100]");
    const rows = d.sections.flatMap((s) => s.changes);
    expect(rows).toContainEqual({ op: "~", comp: "Endcard", layer: "Logo_Mark", layerIndex: 4, what: "Renamed", from: "Logo_Lockup", to: "Logo_Mark" });
    expect(rows).toContainEqual({ op: "~", comp: "Endcard", layer: "Logo_Mark", layerIndex: 4, path: "Transform", what: "Scale", from: "[100,100,100]", to: "[64,64,100]" });
    expect(rows).toContainEqual({ op: "+", comp: "Endcard", layer: "Logo_Null", layerIndex: 7, what: "Logo_Null added (shape)" });
    // one row per text change line
    expect(rows.length).toBe(d.sections.reduce((n, s) => n + s.lines.filter((l) => /^[+~-] /.test(l)).length, 0));
    const v = historyView("/Jobs/Promo_Q4_v12.aep", { snapshot: fx.historyFrom, current: false }, { snapshot: fx.historyTo, current: true }, d);
    expect(v).toMatchObject({ view: "changes", source: "history", title: "What changed · Promo_Q4_v12.aep", subtitle: 'checkpoint "before un-precompose" → now', moreChanges: 0 });
    expect(v.footnote).toBe("3 layers added, 1 layer renamed, 2 values changed");
    expect(historyView("/p.aep", { snapshot: fx.historyFrom, current: false }, { snapshot: fx.historyTo, current: true }, d, "Nope").changes).toEqual([]);
  });
});

describe("ae_prove_identical with a view", () => {
  it("compare: the text and difference image as before, the view's data in _meta, the frames kept for the view", async () => {
    const client = await connect();
    const cap: any = await client.callTool({ name: "ae_prove_identical", arguments: { action: "capture", times: [0, 1, 2] } });
    const id = /proof (\S+?):/.exec(textOf(cap))![1];
    expect(cap._meta).toBeUndefined(); // capture has no view data
    scene.square = 14;
    const r: any = await client.callTool({ name: "ae_prove_identical", arguments: { action: "compare", id } });
    expect(r.content.map((c: any) => c.type)).toEqual(["text", "image", "text"]);
    expect(r.content[0].text).toMatch(/^Verdict: DIFFERS in 3 of 3 frames/);
    expect(r.structuredContent).toBeUndefined();
    const v = r._meta["surehand/view"];
    expect(v).toMatchObject({ view: "changes", source: "proof", title: "Proof · Main", changes: [], footnote: "" });
    expect(v.subtitle).toMatch(/^reference \d\d:\d\d → now · 3 frames compared$/);
    expect(v.proof).toMatchObject({ id, verdict: "DIFFERS", tolerance: 0.5, maxDiff: 200 });
    expect(v.proof.frames.map((f: any) => [f.index, f.tc, f.differs])).toEqual([[0, "00:00:00:00", true], [1, "00:00:01:00", true], [2, "00:00:02:00", true]]);
    const after = join(home, ".surehand", "ae", "proofs", id, "after");
    expect(JSON.parse(readFileSync(join(after, "compared.json"), "utf8")).compared).toBe(v.proof.compared);
    expect(existsSync(join(after, "12_2.png"))).toBe(true);

    // the frames, in every permission mode (they're only read from the proof)
    for (const mode of ["full", "ask", "read-only"]) {
      setMode(mode);
      const f: any = await client.callTool({ name: "ae_view_proof_frame", arguments: { id, compared: v.proof.compared, comp: 12, index: 1 } });
      expect(f.isError, mode).toBeFalsy();
      expect(f.content.filter((c: any) => c.type === "image").map((c: any) => c.mimeType)).toEqual(["image/jpeg", "image/jpeg", "image/jpeg"]);
      expect(f._meta["surehand/view"]).toMatchObject({ view: "frame", comp: "Main", time: 1, width: 32, height: 16 });
    }
    // a later comparison replaces them
    setMode("full");
    const again: any = await client.callTool({ name: "ae_prove_identical", arguments: { action: "compare", id } });
    expect(again._meta["surehand/view"].proof.compared).not.toBe(v.proof.compared);
    const stale: any = await client.callTool({ name: "ae_view_proof_frame", arguments: { id, compared: v.proof.compared, comp: 12, index: 1 } });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toBe("A later comparison replaced these frames. Compare again to see them.");
    await client.close();
  });

  it("run: identical, with the edit's changes and one undo step", async () => {
    const client = await connect();
    scene.shade = 200;
    // the fake batch moves the square: make it a no-op for this run by drawing the same picture
    const r: any = await client.callTool({ name: "ae_prove_identical", arguments: { action: "run", times: [0, 1], steps: [{ tool: "ae_set_property", args: { layer: 1, property: "Transform/Opacity", value: 50 } }] } });
    const v = r._meta["surehand/view"];
    expect(v.title).toBe("Proven edit · Main");
    expect(v.footnote).toBe("One undo step in After Effects");
    expect(v.changes).toContainEqual({ op: "~", comp: "Main", layer: "Logo_Mark", path: "Transform", what: "Scale", from: "[100,100]", to: "[64,64]" });
    expect(textOf(r)).toContain("Edits (one undo step):");
    await client.close();
  });

  it("proofView: IDENTICAL within tolerance, DIFFERS, and the edit", () => {
    const a = proofView(fx.identical, { changes: fx.editChanges })!;
    expect(a.proof).toMatchObject({ verdict: "IDENTICAL", maxDiff: 0.4, tolerance: 1 });
    expect(a.changes.length).toBe(11);
    expect(proofView(fx.differs)!.proof!.verdict).toBe("DIFFERS");
    expect(proofView({ ...fx.differs, verdict: "incomplete" })!.proof!.verdict).toBe("NOT PROVEN");
    expect(JSON.stringify(a).length).toBeLessThan(10_000);
  });
});

describe("the changes view in a fake AI app (jsdom)", () => {
  async function host(view: unknown, onCall: (name: string, args: any) => any = () => undefined, toolResult?: any, tool?: string) {
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
            reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "fake", version: "1" }, hostCapabilities: { serverTools: {} }, hostContext: { theme: "dark", ...(tool ? { toolInfo: { tool: { name: tool, inputSchema: { type: "object" } } } } : {}) } } });
          else if (m.method === "ui/notifications/initialized")
            reply({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: toolResult ?? { content: [{ type: "text", text: "Verdict" }], _meta: { "surehand/view": view } } });
          else if (m.method === "tools/call") reply({ jsonrpc: "2.0", id: m.id, result: onCall(m.params.name, m.params.arguments) ?? { content: [{ type: "text", text: "ok" }] } });
        }, 0);
      },
    };
    const dom = new JSDOM(buildViews().changes, {
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
  const stills = { content: [1, 2, 3].map(() => ({ type: "image", data: "AAAA", mimeType: "image/jpeg" })) };

  it("IDENTICAL: the verdict, the first frame's stills, the changes, Show all", async () => {
    const calls: [string, any][] = [];
    const { doc, until } = await host(proofView(fx.identical, { changes: fx.editChanges }), (n, a) => (calls.push([n, a]), n === "ae_view_proof_frame" ? stills : undefined));
    await until(() => doc.querySelectorAll(".cmp img").length === 3);
    expect(doc.querySelector(".verdict .big")!.textContent).toBe("IDENTICAL");
    expect(doc.querySelector(".verdict .big")!.className).toContain("ok");
    expect(doc.querySelector(".verdict .mono")!.textContent).toBe("max difference 0.4 / 255 · tolerance 1");
    expect(calls[0]).toEqual(["ae_view_proof_frame", { id: fx.identical.view!.id, compared: fx.identical.view!.compared, comp: 7, index: 0 }]);
    expect([...doc.querySelectorAll(".cmp figcaption")].map((e) => e.textContent)).toEqual(["Before · 00:00:24:00", "After", "Difference ×50"]);
    expect(doc.querySelector(".gh .eyebrow")!.textContent).toBe("Changes · 1 comp · 6 layers · 3 properties");
    expect(doc.querySelectorAll(".ch").length).toBe(6);
    expect(doc.querySelector(".ch .val s")).toBeNull(); // the first six are layers added / removed
    (doc.querySelector('[data-k="all"]') as any).click();
    expect(doc.querySelectorAll(".ch").length).toBe(11);
    const vals = [...doc.querySelectorAll(".ch .val")].map((e) => e.textContent);
    expect(vals).toContain("Scale 100 % → 64 %");
    expect(vals).toContain("Position 960, 540 px → 1210, 388 px");
    expect(doc.querySelector(".foot .sum")!.textContent).toBe("One undo step in After Effects");
    // a removed layer: Show in AE opens its comp
    (doc.querySelector('[data-k="show0"]') as any).click();
    await until(() => calls.some((c) => c[0] === "ae_view_reveal"));
    expect(calls.find((c) => c[0] === "ae_view_reveal")![1]).toEqual({ comp: "Endcard" });
  });

  it("DIFFERS: refused colour, the slider at the first differing frame, moving it fetches that frame", async () => {
    const calls: [string, any][] = [];
    const { doc, until } = await host(proofView(fx.differs), (n, a) => (calls.push([n, a]), n === "ae_view_proof_frame" ? stills : undefined));
    await until(() => doc.querySelectorAll(".cmp img").length === 3);
    expect(doc.querySelector(".verdict .big")!.className).toContain("bad");
    expect(doc.querySelector(".verdict .mono")!.textContent).toBe("3 of 24 frames differ · max difference 38 / 255 · tolerance 0.5");
    const slider = doc.querySelector('[data-k="slider"]') as HTMLInputElement;
    expect(slider.value).toBe("10");
    expect(calls[0][1].index).toBe(10);
    expect(doc.querySelectorAll(".slider .d").length).toBe(3);
    slider.value = "11";
    slider.dispatchEvent(new (slider.ownerDocument.defaultView as any).Event("input"));
    await until(() => calls.length === 2);
    expect(calls[1][1].index).toBe(11);
  });

  it("errors: a frame that can't be fetched, Show in AE without After Effects", async () => {
    const { doc, until } = await host(proofView(fx.identical, { changes: fx.editChanges }), (n) =>
      n === "ae_view_proof_frame"
        ? { isError: true, content: [{ type: "text", text: "A later comparison replaced these frames. Compare again to see them." }] }
        : { isError: true, content: [{ type: "text", text: "Cannot reach After Effects." }], _meta: { "surehand/error": "NOT_RUNNING" } },
    );
    await until(() => doc.querySelector(".err.note"));
    expect(doc.querySelector(".err.note")!.textContent).toBe("A later comparison replaced these frames. Compare again to see them.");
    (doc.querySelector('[data-k="show1"]') as any).click();
    await until(() => doc.querySelector(".ch .err"));
    expect(doc.querySelector(".ch .err")!.textContent).toBe("After Effects isn't open. Open it, then try again.");
  });

  it("the history diff: no proof, the changes, Show in AE by layer index", async () => {
    const calls: [string, any][] = [];
    const d = diffSnapshots(fx.historyFrom, fx.historyTo);
    const v = historyView("/Jobs/Promo_Q4_v12.aep", { snapshot: fx.historyFrom, current: false }, { snapshot: fx.historyTo, current: true }, d);
    const { doc, until } = await host(v, (n, a) => void calls.push([n, a]));
    await until(() => doc.querySelector(".ch"));
    expect(doc.querySelector(".verdict")).toBeNull();
    expect(doc.querySelector(".cmp")).toBeNull();
    expect(doc.querySelector(".vh .t")!.textContent).toBe("What changed · Promo_Q4_v12.aep");
    const i = v.changes.findIndex((c) => c.what === "Scale");
    (doc.querySelector(`[data-k="show${i}"]`) as any).click();
    await until(() => calls.length);
    expect(calls[0]).toEqual(["ae_view_reveal", { comp: "Endcard", layer: 4 }]);
  });

  it("results that aren't a comparison or a diff (capture, snapshot, list, guidance) are readable text, never an error", async () => {
    const cap = await host(undefined, undefined, { content: [{ type: "text", text: "Captured proof 1: ...\nmore" }] }, "ae_prove_identical");
    await cap.until(() => cap.doc.querySelector(".txtres"));
    expect(cap.doc.querySelector(".vh .t")!.textContent).toBe("Proof");
    expect(cap.doc.querySelector(".txtres")!.textContent).toBe("Captured proof 1: ...\nmore");
    expect(cap.doc.querySelector(".err")).toBeNull();
    expect(cap.doc.querySelector('[data-k="text-all"]')).toBeNull(); // short: all of it, no button
    // a long list: the first lines, then Show all
    const list = Array.from({ length: 30 }, (_, i) => `2026101${i}  snapshot "v${i}"  revision ${i}, 12 comps, 400 layers`).join("\n");
    const h = await host(undefined, undefined, { content: [{ type: "text", text: `History of /Jobs/Spot.aep (newest first):\n${list}` }] }, "ae_project_history");
    await h.until(() => h.doc.querySelector(".txtres"));
    expect(h.doc.querySelector(".vh .t")!.textContent).toBe("Project history");
    expect(h.doc.querySelector(".txtres")!.classList.contains("collapsed")).toBe(true);
    (h.doc.querySelector('[data-k="text-all"]') as any).click();
    expect(h.doc.querySelector(".txtres")!.classList.contains("collapsed")).toBe(false);
    expect(h.doc.querySelector('[data-k="text-all"]')!.textContent).toBe("Show less");
    // guidance returned as an error (no snapshot to compare with) is still just text
    const g = await host(undefined, undefined, { isError: true, content: [{ type: "text", text: 'from: There are no snapshots of this project yet. Take one with ae_project_history {action: "snapshot", label: "..."}.' }] });
    await g.until(() => g.doc.querySelector(".txtres"));
    expect(g.doc.querySelector(".err")).toBeNull();
    expect(g.doc.querySelector(".vh .t")!.textContent).toBe("Surehand");
    // After Effects not reachable: the short message, in the error style
    const e = await host(undefined, undefined, { isError: true, content: [{ type: "text", text: "Cannot reach After Effects. Make sure ..." }], _meta: { "surehand/error": "NOT_RUNNING" } });
    await e.until(() => e.doc.querySelector(".err.note"));
    expect(e.doc.querySelector(".err.note")!.textContent).toBe("After Effects isn't open. Open it, then try again.");
    expect(e.doc.querySelector(".txtres")).toBeNull();
  });
});
