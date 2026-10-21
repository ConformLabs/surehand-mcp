// ae_stress_test: the variant generators and sampling, the frame picker, the expression language scanner, the number
// and layout measurements, the read-back comparison, and whole runs in the fake After Effects (test/fake-ae.ts): the
// real ExtendScript discovers the controllers, sets every variant on a scratch copy and measures it with Preflight's
// own collector; the user's comp is read back unchanged. A temporary home: nothing real is touched.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProject, type FakeProjectSpec } from "./fake-ae.js";

const home = mkdtempSync(join(tmpdir(), "surehand-stress-"));
vi.mock("node:os", async (orig) => ({ ...(await orig<typeof import("node:os")>()), homedir: () => home }));
let fake: ReturnType<typeof fakeProject>;
const jsxCalls: { body: string; args: any; opts: any }[] = [];
vi.mock("../src/jsx.js", async (orig) => ({
  ...(await orig<typeof import("../src/jsx.js")>()),
  runJsx: async (body: string, args: any, opts: any) => {
    jsxCalls.push({ body, args, opts });
    return fake.run(body, args);
  },
}));

const cases = await import("../src/stress/cases.js");
const { scanExpression, languageRisks } = await import("../src/stress/expr-lang.js");
const { numberProblem, readShownNumber, layerOf, cells } = await import("../src/stress/measure.js");
const { runStress, chooseTargets, toTarget, compareFingerprints } = await import("../src/tools/stress.js");
const { orderVariants, runVerdict, stressText } = await import("../src/stress/report.js");
const { RUN_JSX, PREP_JSX } = await import("../src/stress/jsx.js");

afterAll(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => (jsxCalls.length = 0));

const text = (r: any) => r.content.map((c: any) => c.text).join("\n");
const viewOf = (r: any) => r._meta?.["surehand/view"];

describe("the generated cases", () => {
  it("text cases scale from the current text, every id is unique, and nothing is a look", () => {
    const short = cases.textCases("Sale");
    const long = cases.textCases("Our biggest spring sale of the year starts on Monday");
    const ids = short.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["de-long", "fi-long", "he-rtl", "ar-rtl", "ja", "zh", "ko", "th", "hi", "caps", "empty", "one-char", "emoji", "vi-combining", "no-spaces"]) expect(ids).toContain(id);
    const de = (cs: typeof short) => String(cs.find((c) => c.id === "de-long")!.value);
    // a one-word title still gets a whole compound; a sentence gets about 1.4x its length
    expect(de(short).length).toBeGreaterThanOrEqual("Rechtsschutzversicherungsgesellschaften".length);
    expect(de(long).length).toBeGreaterThanOrEqual(Math.round(52 * 1.4));
    expect(String(long.find((c) => c.id === "double")!.value).length).toBeGreaterThanOrEqual(104);
    expect(short.find((c) => c.id === "empty")!.value).toBe("");
    expect(String(short.find((c) => c.id === "no-spaces")!.value)).not.toMatch(/\s/);
    // combining marks are really decomposed
    const vi = String(short.find((c) => c.id === "vi-combining")!.value);
    expect(vi).not.toBe(vi.normalize("NFC"));
    expect(String(short.find((c) => c.id === "caps")!.value)).toMatch(/^SALE/);
  });

  it("numbers: a text that shows a number also gets number strings; a slider gets values past its range", () => {
    expect(cases.looksNumeric("$1,299.00")).toBe(true);
    expect(cases.looksNumeric("-15 %")).toBe(true);
    expect(cases.looksNumeric("Spring sale")).toBe(false);
    const price = cases.casesFor({ id: "P", name: "P", kind: "text", source: "egp", current: "$1,299" });
    expect(price.map((c) => c.id)).toContain("n-eu");
    const slider = cases.casesFor({ id: "S", name: "S", kind: "number", source: "egp", current: 5 });
    expect(slider.find((c) => c.id === "n-limit")!.value).toBeGreaterThan(1_000_000);
    expect(cases.casesFor({ id: "D", name: "D", kind: "dropdown", source: "egp", items: 3 }).map((c) => c.value)).toEqual([1, 2, 3]);
    expect(cases.casesFor({ id: "C", name: "C", kind: "checkbox", source: "egp" }).map((c) => c.value)).toEqual([1, 0]);
  });

  it("variants: the user's rows and values first, sets and exclude filter, ids are case@target", () => {
    const ts = [
      { id: "Title", name: "Title", kind: "text" as const, source: "egp" as const, current: "Sale" },
      { id: "Price", name: "Price", kind: "number" as const, source: "egp" as const, current: 5 },
    ];
    const p = cases.planVariants(ts, { maxVariants: 500, sets: ["rtl", "n-huge"], exclude: ["ar-mixed"], own: [{ target: "Title", values: ["Müller-Lüdenscheidt"] }], rows: [{ n: 2, cells: [{ target: "Title", value: "Rome" }] }] });
    expect(p.variants.map((v) => v.id)).toEqual(["row-2", "own-1@Title", "he-rtl@Title", "ar-rtl@Title", "n-huge@Price"]);
    expect(p.sampled).toBeUndefined();
  });

  it("over the cap, every control keeps cases (evenly spread) and the plan says what was kept", () => {
    const ts = ["A", "B", "C"].map((n) => ({ id: n, name: n, kind: "text" as const, source: "egp" as const, current: "x" }));
    const p = cases.planVariants(ts, { maxVariants: 12 });
    expect(p.variants).toHaveLength(12);
    for (const n of ["A", "B", "C"]) expect(p.variants.filter((v) => v.sets[0].target === n)).toHaveLength(4);
    expect(p.sampled!.how).toMatch(/12 of 54 generated cases/);
    // the same input samples the same way
    expect(cases.planVariants(ts, { maxVariants: 12 }).variants.map((v) => v.id)).toEqual(p.variants.map((v) => v.id));
  });

  it("combinations: together puts one case on every text; all samples the product evenly and says so", () => {
    const ts = ["A", "B"].map((n) => ({ id: n, name: n, kind: "text" as const, source: "egp" as const, current: n === "A" ? "Hi" : "A much longer title here that goes on and on" }));
    const t = cases.planVariants(ts, { maxVariants: 500, sets: ["de-long"], combinations: "together" });
    const all = t.variants.find((v) => v.id === "de-long@all")!;
    expect(all.sets.map((s) => s.target)).toEqual(["A", "B"]);
    // each text gets its own scaled version
    expect(all.sets[0].value).not.toEqual(all.sets[1].value);
    const c = cases.planVariants(ts, { maxVariants: 60, combinations: "all" });
    expect(c.variants).toHaveLength(60);
    expect(c.sampled!.how).toMatch(/combinations, evenly spread/);
    expect(c.variants.filter((v) => v.set === "combination")[0].id).toMatch(/@A\+.*@B$/);
  });

  it("frames: visibility edges always stay, key frames fill the rest evenly, the middle when nothing moves", () => {
    expect(cases.pickFrames({ frames: 100, keys: [], edges: [0, 99], max: 12 })).toEqual([0, 50, 99]);
    expect(cases.pickFrames({ frames: 100, keys: [10, 10.2, 20, 30], edges: [5, 80], max: 12 })).toEqual([0, 5, 10, 20, 30, 80, 99]);
    const many = cases.pickFrames({ frames: 300, keys: Array.from({ length: 40 }, (_, i) => i * 7), edges: [12, 200], max: 8 });
    expect(many).toHaveLength(8);
    for (const f of [0, 12, 200, 299]) expect(many).toContain(f);
  });
});

describe("expressions that break in other After Effects languages", () => {
  const fx = (list: { m: string; n: string; d?: 1 }[]) => () => list;
  it("an effect by its default name, a parameter and a property by display name; with the safe rewrite", () => {
    const f = scanExpression('effect("Slider Control")("Slider") * 2', fx([{ m: "ADBE Slider Control", n: "Slider Control", d: 1 }]));
    expect(f.map((x) => x.code)).toEqual(["effectDefaultName", "paramName"]);
    const p = scanExpression('thisLayer("Transform")("Opacity")', fx([]));
    expect(p.map((x) => [x.code, x.name])).toEqual([["propertyName", "Transform"], ["propertyName", "Opacity"]]);
    expect(p[0].suggestion).toBe("thisLayer.transform.opacity");
    const s = scanExpression('thisComp.layer("Controls").effect("Price")("Slider")', () => undefined);
    expect(s.map((x) => x.code)).toEqual(["paramName"]);
    expect(s[0].suggestion).toBe('thisComp.layer("Controls").effect("Price")(1)');
  });
  it("shape and mask default names are warnings; match names, indexes, attributes and the user's names are fine", () => {
    const w = scanExpression('content("Rectangle 1").content("Fill 1").color', fx([]));
    expect(w.map((x) => x.code)).toEqual(["shapeDefaultName", "shapeDefaultName"]);
    for (const ok of [
      'effect("Price")(1)',
      'effect("ADBE Slider Control")("ADBE Slider Control-0001")',
      "thisLayer.transform.opacity",
      'content("Badge").content("Outline").color',
      'thisComp.layer("Title").text.sourceText',
      '// effect("Slider Control")("Slider")\n5',
      'var s = "effect(\\"Slider Control\\")"; s',
    ])
      expect(scanExpression(ok, fx([{ m: "ADBE Slider Control", n: "Price" }])), ok).toEqual([]);
    expect(scanExpression('mask("Mask 1").maskPath', fx([])).map((x) => x.code)).toEqual(["maskDefaultName"]);
  });
  it("legacy ExtendScript Babel can't parse is read leniently", () => {
    const f = scanExpression('if (time > 1) effect("Price")("Slider") else 0', fx([]));
    expect(f.map((x) => x.code)).toEqual(["paramName"]);
  });
  it("over X-ray's facts: every enabled expression, with where it is", () => {
    const r = languageRisks({
      v: 1, sections: ["expressions"], footage: [], rq: [], layersScanned: 1, ms: 1,
      comps: [{ id: 3, name: "Main", w: 1920, h: 1080, fps: 25, dur: 4, nl: 1, usedIn: [], layers: [{ i: 2, id: 9, n: "Ctrl", t: "null", fx: [{ m: "ADBE Slider Control", n: "Slider Control", d: 1 }], ex: [["Transform/Opacity", 'effect("Slider Control")("Slider")', "", 1], ["Transform/Scale", 'effect("Slider Control")("Slider")', "", 0]] }] }],
    } as any);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ comp: "Main", layer: "Ctrl", layerIndex: 2, property: "Transform/Opacity", code: "effectDefaultName", severity: "fail" });
  });
});

describe("measuring", () => {
  it("reads a shown number in either separator style, and says what is wrong with it", () => {
    expect(readShownNumber("$1,234,567.89")).toBe(1234567.89);
    expect(readShownNumber("1.234.567,89 €")).toBe(1234567.89);
    expect(readShownNumber("(5.00)")).toBe(-5);
    expect(readShownNumber("1,234")).toBe(1234);
    expect(numberProblem("$1234567.89", 1234567.89)).toBeNull();
    expect(numberProblem("$1,234,568", 1234567.89)).toBeNull(); // rounded to what it shows
    expect(numberProblem("$1234.50", -1234.5)).toMatch(/minus sign is lost/);
    expect(numberProblem("1.2345e+6", 1234500)).toMatch(/scientific notation/);
    expect(numberProblem("NaN", 5)).toMatch(/shows "NaN"/);
    expect(numberProblem("$1,000,000.00", 9999999999)).toMatch(/reads as 1000000/);
    expect(numberProblem("$1,299.00", 1299, { decimals: 2, thousandsSeparator: ",", prefix: "$" })).toBeNull();
    expect(numberProblem("$1299", 1299, { decimals: 2, thousandsSeparator: ",", prefix: "$" })).toMatch(/your format gives "\$1,299.00"/);
  });
  it("layer paths of the scratch copy read as the user's layers", () => {
    expect(layerOf("Main [stress test] > 2: Title", "Main [stress test]")).toEqual({ name: "Title", index: 2 });
    expect(layerOf("Main [stress test] > 4: Lower > 1: Name", "Main [stress test]")).toEqual({ name: "Lower › Name", index: 4 });
  });
  it("cells: bad over warn over ok; a check that didn't run or doesn't apply is a dash", () => {
    const m = { findings: [{ check: "text.overflow", column: "fit" as const, severity: "fail" as const, message: "" }, { check: "text.break", column: "lines" as const, severity: "warn" as const, message: "" }], layers: [], notRun: [{ column: "glyphs" as const, reason: "AE 25.1" }], notes: [] };
    expect(cells(m, { fit: true, safe: true, size: true, glyphs: true, lines: true, other: true })).toEqual({ fit: "bad", safe: "ok", size: "ok", glyphs: "na", lines: "warn", other: "ok" });
    expect(cells(m, { fit: true, safe: false, size: true, glyphs: true, lines: true, other: true }).safe).toBe("na");
  });
  it("the read-back: identical lines verify; any difference is listed; scratch items don't count", () => {
    const a = { ok: true, parts: ["comp|Main", "1/Transform/Opacity=100", "items|1,2"], values: 1, scratch: [] };
    expect(compareFingerprints(a, { ...a, parts: [...a.parts.slice(0, 2), "items|1,2,9"], scratch: [{ id: 9, name: "Main [stress test]" }] }).verified).toBe(true);
    const b = compareFingerprints(a, { ...a, parts: ["comp|Main", "1/Transform/Opacity=50", "items|1,2"] });
    expect(b.verified).toBe(false);
    expect(b.differences[0]).toBe("1/Transform/Opacity=100 -> 1/Transform/Opacity=50");
    expect(compareFingerprints(a, { ok: false, error: "busy", parts: [], values: 0, scratch: [] }).differences[0]).toMatch(/could not be read after/);
  });
  it("targets: kinds from the property and its effect; problems say why", () => {
    expect(toTarget({ name: "Logo", source: "egp", type: "OneD", fx: "ADBE Checkbox Control", li: 3, path: [2, 1, 1] }).kind).toBe("checkbox");
    expect(toTarget({ name: "Pos", source: "egp", type: "TwoD_SPATIAL", li: 1, path: [1, 2] }).problem).toMatch(/no worst cases/);
    expect(toTarget({ name: "X", source: "egp", type: "OneD", keyed: 1, li: 1, path: [1] }).problem).toMatch(/keyframes/);
    expect(toTarget({ name: "Q", source: "egp", type: "OneD", err: "it drives a property inside a precomp" }).problem).toMatch(/precomp/);
    const d = { comp: { id: 1, name: "M" } as any, egp: [{ name: "Title", source: "egp" as const, type: "TEXT_DOCUMENT", li: 1, path: [2, 1] }], texts: [], named: [], keys: [], edges: [] };
    expect(chooseTargets(d, { targets: [{ egp: "Titel" }] }).problems[0]).toMatch(/no Essential Graphics controller named "Titel".*it has: Title/);
  });
});

// ---------- whole runs in the fake After Effects ----------

const need = (text: string, w: number) => Math.max(1, Math.ceil((Array.from(text).length * 30) / w));
const LEAD = 72;
function project(over: Partial<FakeProjectSpec> = {}): FakeProjectSpec {
  return {
    activeComp: "Lower third",
    installedEffects: [
      { matchName: "ADBE Slider Control", displayName: "Slider Control" },
      { matchName: "ADBE Checkbox Control", displayName: "Checkbox Control" },
    ],
    comps: [
      {
        name: "Lower third",
        duration: 4,
        layers: [
          {
            name: "Title",
            type: "text",
            text: "Spring sale",
            fontSize: 60,
            box: [400, 150],
            position: [100, 880],
            glyphsMissing: "東京都千代田区特別開催中キャンペーン",
            // 30 px a character; the box shows as many 72 px lines as fit
            boxOverflow: (t, d) => need(t, d.boxTextSize[0]) * LEAD > d.boxTextSize[1],
            lines: (t, d) => Math.min(need(t, d.boxTextSize[0]), Math.floor(d.boxTextSize[1] / LEAD)),
            rect: (_t, t, d) => [0, -60, d.boxTextSize[0], Math.min(need(t, d.boxTextSize[0]), Math.floor(d.boxTextSize[1] / LEAD)) * LEAD],
          },
          {
            name: "Price",
            type: "text",
            text: "$1299.00",
            position: [1400, 880],
            // the template's own expression: the slider's value with two decimals (and no sign)
            anim: { "ADBE Text Document": (_t, L) => "$" + Math.abs(L.containingComp.layer("Controls").property("Effects").property("Price").property("Slider").value).toFixed(2) },
            rect: (_t, t) => [0, -50, Array.from(t).length * 30, 60],
            expressions: { "Transform/Opacity": { expr: 'thisComp.layer("Controls").effect("Price")("Slider") > 0 ? 100 : 0' } },
          },
          {
            name: "Controls",
            type: "null",
            effects: [
              { matchName: "ADBE Slider Control", name: "Price" },
              { matchName: "ADBE Checkbox Control", name: "Show logo" },
              { matchName: "ADBE Slider Control", name: "Slider Control" },
            ],
            props: {
              "Effects/Price/Slider": { value: 1299, type: "OneD", max: 1_000_000 },
              "Effects/Show logo/Checkbox": { value: 1, type: "OneD" },
              "Effects/Slider Control/Slider": { value: 0, type: "OneD" },
            },
            expressions: { "Transform/Opacity": { expr: 'effect("Slider Control")("Slider") + 100' } },
          },
        ],
        egp: [
          { name: "Title", value: { text: "Spring sale" }, type: "TEXT_DOCUMENT", source: { layer: "Title", path: "Text/Source Text" } },
          { name: "Price", value: 1299, type: "OneD", source: { layer: "Controls", path: "Effects/Price/Slider" } },
          { name: "Show logo", value: 1, type: "OneD", source: { layer: "Controls", path: "Effects/Show logo/Checkbox" } },
        ],
      },
    ],
    ...over,
  };
}
const original = () => fake.comps[0];
const titleText = () => original().layer("Title").property("ADBE Text Properties").property("ADBE Text Document").value.text;
const priceValue = () => original().layer("Controls").property("Effects").property("Price").property("Slider").value;

describe("a whole run", () => {
  it("measures every variant on a scratch copy: what breaks, at which frame, by how much; the comp is read back unchanged", async () => {
    fake = fakeProject(project());
    const itemsBefore = fake.items.length;
    const r = await runStress({ contactSheets: false, sets: ["de-long", "ja", "one-char", "n-negative", "n-limit", "n-huge", "on", "off"] }, { mode: "full" });
    const t = text(r), v = viewOf(r);
    expect(r.isError).toBeFalsy();
    expect(t.split("\n")[0]).toMatch(/^FAIL \(5 of 8 variants break; 3 expressions break in other AE languages\)/);
    // overflow by how much, with lines: "Spring sale" 11 chars fits 1 line; German needs more than the box's 2
    const de = v.variants.find((x: any) => x.id === "de-long@Title");
    expect(de.status).toBe("fail");
    const ov = de.findings.find((f: any) => f.check === "text.overflow");
    expect(ov.message).toMatch(/^overflows its box by \d+ px; \d+ lines, the box shows 2 \(text is cut off\)$/);
    expect(ov.amountPx).toBeGreaterThan(0);
    expect(ov.frame).toBe(0);
    expect(ov.tc).toBe("00:00:00:00");
    expect(de.cells.fit).toBe("bad");
    expect(t).toMatch(/Title overflows its box by \d+ px; \d+ lines, the box shows 2 \(text is cut off\) at f0/);
    // Japanese: glyphs the font lacks
    const ja = v.variants.find((x: any) => x.id === "ja@Title");
    expect(ja.findings.some((f: any) => f.check === "text.glyphs")).toBe(true);
    expect(ja.cells.glyphs).toBe("bad");
    // numbers: the template drops the sign; a slider can't take the input
    expect(v.variants.find((x: any) => x.id === "n-negative@Price").findings.map((f: any) => f.message).join()).toMatch(/minus sign is lost/);
    expect(v.variants.find((x: any) => x.id === "n-limit@Price").findings.map((f: any) => f.message).join()).toMatch(/keeps 1000000 \(the control's range\)/);
    expect(v.variants.find((x: any) => x.id === "n-huge@Price").findings.map((f: any) => f.check)).toEqual(["number.input"]);
    // the passes and the checkbox states
    for (const id of ["one-char@Title", "on@Show logo", "off@Show logo"]) expect(v.variants.find((x: any) => x.id === id).status).toBe("pass");
    // failing first
    expect(v.variants.slice(0, 5).every((x: any) => x.status === "fail")).toBe(true);
    // the language scan: the effect's default name and the parameter's display name
    expect(v.languages.map((l: any) => l.code).sort()).toEqual(["effectDefaultName", "paramName", "paramName"]);
    expect(v.counts).toMatchObject({ variants: 8, failed: 5, passed: 3, targets: 3, languageRisks: 3 });
    // the user's comp: read back identical, the values as they were, no scratch item left
    expect(v.restore).toMatchObject({ verified: true, differences: [] });
    expect(t).toMatch(/Your comp is unchanged: \d+ values read back identical/);
    expect(titleText()).toBe("Spring sale");
    expect(priceValue()).toBe(1299);
    expect(fake.items.length).toBe(itemsBefore);
    expect(fake.items.some((i: any) => /stress/.test(i.name))).toBe(false);
    // every variant in one scratch call (the budget allows it), and every edit inside an undo group
    const runs = jsxCalls.filter((c) => c.body === RUN_JSX);
    expect(runs).toHaveLength(1);
    expect(runs[0].opts.undoGroup).toBe("Surehand MCP stress test");
  });

  it("a variant's sets are put back before the next one: each is measured against the comp as it is", async () => {
    fake = fakeProject(project());
    const r = await runStress({ contactSheets: false, sets: ["de-long", "one-char"] }, { mode: "full" });
    const v = viewOf(r);
    // one-char after de-long: no overflow left over from the variant before
    expect(v.variants.find((x: any) => x.id === "one-char@Title").status).toBe("pass");
    const run = jsxCalls.find((c) => c.body === RUN_JSX)!;
    expect(run.args.variants.map((x: any) => x.id)).toEqual(["baseline", "de-long@Title", "one-char@Title"]);
  });

  it("the read-back catches a comp that is not exactly as it was: the run is never a PASS then", async () => {
    fake = fakeProject(project());
    const run = fake.run;
    // something (not the stress test's own code) changes the user's comp while the variants run
    fake.run = (body: string, args: any) => {
      const r = run(body, args);
      if (body === RUN_JSX) original().layer("Controls").property("Effects").property("Price").property("Slider").setValue(5);
      return r;
    };
    const r = await runStress({ contactSheets: false, sets: ["one-char"] }, { mode: "full" });
    const v = viewOf(r);
    expect(v.restore.verified).toBe(false);
    expect(v.restore.differences.join()).toMatch(/Price\/Slider=1299 -> .*Price\/Slider=5/);
    expect(v.verdict).toBe("FAIL"); // the language risks still fail the run; never PASS
    expect(text(r)).toMatch(/Your comp could NOT be confirmed unchanged:/);
    fake.run = run;
  });

  it("what already fails without any variant is the baseline, not the variants' fault", async () => {
    const p = project();
    (p.comps[0].layers[0] as any).text = "A title far too long for its little box already";
    fake = fakeProject(p);
    const v = viewOf(await runStress({ contactSheets: false, sets: ["one-char", "double"] }, { mode: "full" }));
    expect(v.baseline.some((f: any) => f.check === "text.overflow")).toBe(true);
    // the long one still overflows, but that is the baseline's finding
    expect(v.variants.find((x: any) => x.id === "double@Title").findings.some((f: any) => f.check === "text.overflow")).toBe(false);
  });

  it("right to left and complex scripts: the paragraph's direction and composer as the template has them", async () => {
    fake = fakeProject(project());
    const v = viewOf(await runStress({ contactSheets: false, targets: [{ egp: "Title" }], sets: ["ar-rtl", "he-rtl", "hi"] }, { mode: "full" }));
    const ar = v.variants.find((x: any) => x.id === "ar-rtl@Title");
    expect(ar.findings.map((f: any) => [f.check, f.severity])).toEqual([["text.direction", "warn"], ["text.composer", "fail"]]);
    expect(ar.findings[1].message).toMatch(/^Arabic with the Latin and East Asian composer: the letters don't join \(it needs the Universal composer\)$/);
    expect(v.variants.find((x: any) => x.id === "he-rtl@Title").findings.map((f: any) => f.check)).toContain("text.direction");
    expect(v.variants.find((x: any) => x.id === "hi@Title").findings[0].message).toMatch(/^Devanagari .* vowel signs and conjuncts aren't shaped/);
    // the template's own text is untouched
    expect(titleText()).toBe("Spring sale");
  });

  it("the user's own data rows, by column", async () => {
    fake = fakeProject(project());
    const v = viewOf(await runStress({ contactSheets: false, sets: ["none"], data: [{ Name: "Ana", Cost: 5 }, { Name: "Bartholomew-Maximilian von Rechtsschutzversicherungsgesellschaften", Cost: -3 }], columns: { Name: "Title", Cost: "Price" } }, { mode: "full" }));
    expect(v.variants.map((x: any) => [x.id, x.status])).toEqual([["row-2", "fail"], ["row-1", "pass"]]);
    expect(v.variants[0].inputs).toEqual([{ target: "Title", value: "Bartholomew-Maximilian von Rechtsschutzversicherungsgesellschaften" }, { target: "Price", value: "-3" }]);
  });

  it("dry run and read-only mode: the plan and the expression scan, nothing set", async () => {
    fake = fakeProject(project());
    const dry = await runStress({ dryRun: true, sets: ["de-long"] }, { mode: "full" });
    expect(text(dry)).toMatch(/^Dry run: 1 variant planned; nothing was set/);
    expect(text(dry)).toMatch(/de-long@Title: Title = "Rechtsschutz/);
    expect(jsxCalls.some((c) => c.body === RUN_JSX || c.body === PREP_JSX)).toBe(false);
    jsxCalls.length = 0;
    const ro = await runStress({ sets: ["de-long"] }, { mode: "read-only" });
    expect(ro.isError).toBeFalsy();
    expect(text(ro)).toMatch(/^INCOMPLETE \(read-only mode: the variants were not applied\)/);
    expect(text(ro)).toMatch(/Read-only mode: the variants were not applied\. Testing one sets it on a scratch copy/);
    expect(text(ro)).toMatch(/effect "Slider Control" by its default name/);
    expect(jsxCalls.some((c) => c.body === RUN_JSX)).toBe(false);
  });

  it("refusals say what to give", async () => {
    fake = fakeProject({ activeComp: "Plain", comps: [{ name: "Plain", duration: 2, layers: [{ name: "Headline", type: "text", text: "Hi" }] }] });
    const none = await runStress({}, { mode: "full" });
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/exposes nothing variable.*targets: \[\{layer: "Headline"\}\]/);
    const safe = await runStress({ checks: { safeArea: "title" } }, { mode: "full" });
    expect(text(safe)).toMatch(/needs checks\.title: the margin per side from the user's spec/);
    fake = fakeProject(project());
    expect(text(await runStress({ targets: [{ egp: "Titel" }] }, { mode: "full" }))).toMatch(/no Essential Graphics controller named "Titel"/);
    expect(text(await runStress({ values: [{ target: "Nope", values: ["x"] }] }, { mode: "full" }))).toMatch(/values: no control named "Nope" \(controls: Title, Price, Show logo\)/);
    expect(text(await runStress({ data: [{ a: 1 }] }, { mode: "full" }))).toMatch(/data needs columns/);
  });

  it("a named text layer works without Essential Graphics; maxWidthPx and maxLines are the user's rules", async () => {
    fake = fakeProject({ activeComp: "Plain", comps: [{ name: "Plain", duration: 2, layers: [{ name: "Headline", type: "text", text: "Hi", position: [100, 500], rect: (_t, t) => [0, -50, Array.from(t).length * 30, 60], lines: () => 1 }] }] });
    const v = viewOf(await runStress({ contactSheets: false, targets: [{ layer: "Headline", maxWidthPx: 800, maxLines: 1 }], sets: ["de-long", "one-char"] }, { mode: "full" }));
    const de = v.variants.find((x: any) => x.id === "de-long@Headline");
    expect(de.findings.find((f: any) => f.check === "text.width").message).toMatch(/^is \d+ px wide; the most it may take is 800 px/);
    expect(v.variants.find((x: any) => x.id === "one-char@Headline").status).toBe("pass");
  });

  it("the expressions action only reads", async () => {
    fake = fakeProject(project());
    const r = await runStress({ action: "expressions" }, { mode: "read-only" });
    expect(text(r)).toMatch(/^FAIL \(3 expressions break in other AE languages; every variant fits\)/);
    expect(text(r)).toMatch(/fix: use the parameter's index \(expression controls: 1\) or its match name \(e\.g\. thisComp\.layer\("Controls"\)\.effect\("Price"\)\(1\)\)/);
    expect(jsxCalls.some((c) => c.body === RUN_JSX)).toBe(false);
  });
});

describe("the report", () => {
  const variant = (id: string, status: any, n = 0): any => ({ id, name: id, set: "generated", detail: "", inputs: [], status, cells: {}, findings: Array.from({ length: n }, () => ({ check: "x", column: "fit", severity: "fail", message: "m" })), layers: [], notRun: [] });
  it("orders failing first (most findings first), then warnings, incomplete, passed, not run", () => {
    expect(orderVariants([variant("p", "pass"), variant("f1", "fail", 1), variant("w", "warn"), variant("n", "notRun"), variant("f3", "fail", 3), variant("i", "incomplete")]).map((x) => x.id)).toEqual(["f3", "f1", "w", "i", "p", "n"]);
  });
  it("the verdict: an unconfirmed read-back is never a pass", () => {
    expect(runVerdict({ variants: [variant("p", "pass")], languages: [], restore: { verified: false, values: 1, differences: ["x"] } }).verdict).toBe("INCOMPLETE");
    expect(runVerdict({ variants: [variant("p", "pass")], languages: [], restore: { verified: true, values: 1, differences: [] } }).line).toBe("PASS (1 variant)");
  });
  it("the text says what was not confirmed", () => {
    const v: any = { verdictLine: "INCOMPLETE", comp: { name: "M", width: 1, height: 1, fps: 25 }, targets: [], counts: { variants: 0 }, frames: [0], columns: [], variants: [], baseline: [], languages: [], restore: { verified: false, values: 3, differences: ["1/Opacity=100 -> 1/Opacity=50"] }, notes: [] };
    expect(stressText(v)).toMatch(/Your comp could NOT be confirmed unchanged:\n {2}- 1\/Opacity=100 -> 1\/Opacity=50/);
  });
});
