// The stress test view: its model (the grid's rows and order, the cap, the columns, the verdict bar's counts, the
// footer, the frame's marks, the fix request), the built view in a fake AI app (the first failing variant open with its
// kept frame, Show all, Show in AE, Ask the AI, the language rows), ae_view_stress_frame, and the text report, which the
// view leaves exactly as it is. A temporary home: nothing real is touched.
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildViews } from "../scripts/views.mjs";
import { encodePng } from "../src/png.js";
import { stressFixture } from "./fixtures/stress-view.js";

const home = mkdtempSync(join(tmpdir(), "surehand-stress-view-"));
vi.mock("node:os", async (orig) => ({ ...(await orig<typeof import("node:os")>()), homedir: () => home }));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const M = await import("../src/views/stress-model.js");
const { stressText } = await import("../src/stress/report.js");
const { stressRoot, stressFramePath } = await import("../src/stress/files.js");

describe("the view's model", () => {
  it("failing first, then warnings; passed ones fill the grid up to the cap, the rest go to the footer", () => {
    const d = stressFixture();
    const g = M.gridModel(d);
    expect(g.rows.map((v) => v.status)).toEqual(["fail", "fail", "fail", "warn", "pass", "pass"]);
    expect(g.rows).toHaveLength(M.GRID_CAP);
    expect(g.hidden).toHaveLength(8);
    expect(M.footerText(g, false, 14)).toBe("8 more variants passed · English, French, Hebrew, emoji, 1 character …");
    const all = M.gridModel(d, true);
    expect(all.rows).toHaveLength(14);
    expect(all.hidden).toEqual([]);
    expect(M.footerText(all, true, 14)).toBe("14 variants shown");
  });
  it("problems are never capped away", () => {
    const d = stressFixture();
    d.variants = d.variants.map((v) => ({ ...v, status: "fail" as const }));
    expect(M.gridModel(d).rows).toHaveLength(14);
  });
  it("the grid's columns: the five checks, and Other only when something is there", () => {
    const d = stressFixture();
    expect(M.gridModel(d).columns).toEqual(["fit", "safe", "size", "glyphs", "lines"]);
    d.variants[2].cells.other = "bad";
    expect(M.gridModel(d).columns).toEqual(["fit", "safe", "size", "glyphs", "lines", "other"]);
  });
  it("the header and verdict bar counts", () => {
    const d = stressFixture();
    expect(M.metaText(d)).toBe("3 controls · 14 variants · 6 frames each · 1920×1080");
    expect(M.verdictText(d)).toBe("3 of 14 variants break · 1 warning · 2 language risks");
    d.counts = { ...d.counts, failed: 0, warnings: 0, languageRisks: 0, notRun: 2 };
    d.restore = { verified: false, values: 1, differences: ["x"] };
    expect(M.verdictText(d)).toBe("14 variants, none break · 2 not measured · comp not confirmed unchanged");
  });
  it("the open frame marks the box and the safe area dashed and outlines what is cut off", () => {
    const de = stressFixture().variants[0];
    expect(M.leadFinding(de)!.check).toBe("text.overflow");
    expect(M.frameMarks(de.findings[0])).toEqual({ dashed: [[200, 830, 1060, 900]], hit: { rect: [200, 900, 1060, 1084], warn: false } });
    expect(M.frameMarks(de.findings[1])).toEqual({ dashed: [[192, 108, 1728, 972]], hit: { rect: [200, 830, 1824, 900], warn: false } });
    expect(M.openMessage(de)).toBe("Name overflows its box by 184 px; 3 lines, the box shows 2 (text is cut off); outside title-safe by up to 96 px on the right; 3 lines; the limit is 2.");
    expect(M.fixRequest(stressFixture(), de)).toMatch(/^Fix the stress test failure "German · longest" \[de-long@Name\] in "Lower_Third" at 00:00:01:23 \(Name = "Maximilian Donaudampfschifffahrtsgesellschaft"\): Name overflows its box by 184 px/);
  });
});

describe("ae_view_stress_frame's files", () => {
  it("only names inside a run's folder; a gone run is null", () => {
    const dir = join(stressRoot(), "20261021-101500-ab12");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "de-long@Name_frame.png"), encodePng(2, 2, new Uint8Array(12)));
    expect(stressFramePath("20261021-101500-ab12", "de-long@Name_frame.png")).toBe(join(dir, "de-long@Name_frame.png"));
    expect(stressFramePath("../x", "a.png")).toBeNull();
    expect(stressFramePath("20261021-101500-ab12", "../../config.json")).toBeNull();
    expect(stressFramePath("gone", "a.png")).toBeNull();
  });
});

describe("the text report is the same with the view", () => {
  it("the text is built from the view's data, with no view markup in it", () => {
    const t = stressText(stressFixture());
    expect(t.split("\n")[0]).toBe("FAIL (3 of 14 variants break; 1 expression breaks in other AE languages)");
    expect(t).toMatch(/what breaks\n {2}FAIL {2}German · longest \[de-long@Name\]: Name = "Maximilian Donaudampfschifffahrtsgesellschaft"\n {8}- Name overflows its box by 184 px; 3 lines, the box shows 2 \(text is cut off\) at f48 \(00:00:01:23\)/);
    expect(t).toMatch(/contact sheet: \/Users\/ron\/\.surehand\/ae\/stress\/20261021-101500-ab12\/de-long@Name\.png/);
    expect(t).not.toMatch(/surehand\/view|<div/);
  });
});

describe("the built view in an AI app", () => {
  async function host(data: unknown, onCall: (name: string, args: any) => any = () => undefined) {
    const { JSDOM } = await import("jsdom");
    const sent: any[] = [];
    let win: any;
    const parent = {
      postMessage(m: any) {
        sent.push(m);
        const reply = (d: any) => {
          const ev = new win.MessageEvent("message", { data: d });
          Object.defineProperty(ev, "source", { value: parent });
          win.dispatchEvent(ev);
        };
        setTimeout(() => {
          if (m.method === "ui/initialize")
            reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "fake", version: "1" }, hostCapabilities: { serverTools: {} }, hostContext: { theme: "light" } } });
          else if (m.method === "ui/notifications/initialized") reply({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "FAIL" }], _meta: { "surehand/view": data } } });
          else if (m.method === "tools/call") reply({ jsonrpc: "2.0", id: m.id, result: onCall(m.params.name, m.params.arguments) ?? { content: [{ type: "text", text: "ok" }] } });
          else if (m.method === "ui/message") reply({ jsonrpc: "2.0", id: m.id, result: {} });
        }, 0);
      },
    };
    const dom = new JSDOM(buildViews().stress, {
      runScripts: "dangerously",
      pretendToBeVisual: true,
      beforeParse(w: any) {
        win = w;
        Object.defineProperty(w, "parent", { value: parent });
        w.ResizeObserver = class {
          observe() {}
          disconnect() {}
        };
        if (!w.CSS) w.CSS = { escape: (s: string) => s.replace(/["\\]/g, "\\$&") };
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
  const still = { content: [{ type: "image", data: "AAAA", mimeType: "image/jpeg" }] };

  it("the grid failing first, the first failing variant open with its kept frame marked, the language rows, Show all", async () => {
    const calls: [string, any][] = [];
    const { doc, until } = await host(stressFixture(), (n, a) => (calls.push([n, a]), n === "ae_view_stress_frame" ? still : undefined));
    await until(() => doc.querySelector(".mx table"));
    const text = (s: string) => doc.querySelector(s)?.textContent ?? "";
    expect(text(".vh .t")).toBe("Stress test · Lower_Third");
    expect(text(".vh .s")).toBe("3 controls · 14 variants · 6 frames each · 1920×1080");
    expect(text(".verdict")).toBe("FAIL3 of 14 variants break · 1 warning · 2 language risks");
    const head = [...doc.querySelectorAll(".mx th")].map((t) => t.textContent);
    expect(head).toEqual(["Input", "Fits box", "Safe area", "Text size", "Glyphs", "Lines"]);
    const rows = [...doc.querySelectorAll(".mx tr[data-k]")];
    expect(rows.map((r) => r.querySelector(".vn")!.textContent)).toEqual(["German · longest", "Arabic · with digits", "Number · 1,234,567.89", "No spaces", "Japanese", "Your data · row 7"]);
    expect(rows[0].querySelector(".vs")!.textContent).toBe("Name · 41 chars");
    expect([...rows[0].querySelectorAll("td .g")].map((g) => g.className)).toEqual(["g bad", "g bad", "g ok", "g ok", "g bad"]);
    // open: the first failing variant, its kept frame fetched
    expect(rows[0].className).toBe("sel");
    await until(() => doc.querySelector(".still img"));
    expect(calls[0]).toEqual(["ae_view_stress_frame", { run: "20261021-101500-ab12", file: "de-long@Name_frame.png" }]);
    expect(doc.querySelectorAll(".still .safe")).toHaveLength(1);
    expect((doc.querySelector(".still .hit") as HTMLElement).style.left).toBe(`${(200 / 1920) * 100}%`);
    expect(text(".frame .mono")).toBe("German · longest · 00:00:01:23");
    expect(text(".frame .input")).toBe("Maximilian Donaudampfschifffahrtsgesellschaft");
    // the language rows, Preflight style
    const lang = [...doc.querySelectorAll(".grp .row")];
    expect(lang.map((r) => r.querySelector(".tc")!.textContent)).toEqual(["Price › Opacity", "Bar › Size"]);
    expect(lang[1].querySelector(".g")!.className).toBe("g warn");
    // footer and Show all
    expect(text(".foot .sum")).toBe("8 more variants passed · English, French, Hebrew, emoji, 1 character …");
    (doc.querySelector('[data-k="all"]') as HTMLElement).click();
    await until(() => doc.querySelectorAll(".mx tr[data-k]").length === 14);
    // another row: its own frame; a row without a kept frame shows no still
    (doc.querySelector('[data-k="row-no-spaces@Title"]') as HTMLElement).click();
    await until(() => doc.querySelector(".frame.noimg"));
  });

  it("Show in AE only navigates; Ask the AI writes the request into the chat", async () => {
    const calls: [string, any][] = [];
    const { doc, sent, until } = await host(stressFixture(), (n, a) => (calls.push([n, a]), n === "ae_view_stress_frame" ? still : undefined));
    await until(() => doc.querySelector('[data-k="show-de-long@Name"]'));
    (doc.querySelector('[data-k="show-de-long@Name"]') as HTMLElement).click();
    await until(() => calls.some(([n]) => n === "ae_view_reveal"));
    expect(calls.find(([n]) => n === "ae_view_reveal")![1]).toEqual({ comp: 12, time: 1.92, layer: 2 });
    (doc.querySelector('[data-k="lang0"]') as HTMLElement).click();
    await until(() => calls.filter(([n]) => n === "ae_view_reveal").length === 2);
    expect(calls.filter(([n]) => n === "ae_view_reveal")[1][1]).toEqual({ comp: 12, layer: 4 });
    (doc.querySelector('[data-k="ask-de-long@Name"]') as HTMLElement).click();
    await until(() => sent.some((m) => m.method === "ui/message"));
    expect(sent.find((m) => m.method === "ui/message").params.content[0].text).toMatch(/^Fix the stress test failure "German · longest"/);
    // nothing but navigation and the frame was called
    expect(new Set(calls.map(([n]) => n))).toEqual(new Set(["ae_view_stress_frame", "ae_view_reveal"]));
  });

  it("a result without view data (a refusal) shows its text", async () => {
    const { doc, until } = await host(undefined);
    await until(() => doc.querySelector(".txtres"));
    expect(doc.querySelector(".vh .t")!.textContent).toBe("Stress test");
  });
});
