// Versions from data (ae_versions_from_data): the data side (CSV / JSON, number formats, colours and rules, the
// value-to-pixels mapping, name and output patterns), the per-row checks, and whole runs in the fake After Effects
// (test/fake-ae.ts): the real ExtendScript builds the versions, Preflight's real collector measures them. A temporary
// home: nothing real is touched.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fakeProject, type FakeProjectSpec } from "./fake-ae.js";

const home = mkdtempSync(join(tmpdir(), "surehand-versions-"));
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

const data = await import("../src/versions/data.js");
const { checkRow, prepareRow, runVerdict, rowLine, valueMatches } = await import("../src/versions/checks.js");
const { runVersions, inputSchema } = await import("../src/tools/versions.js");
const { BUILD_JSX } = await import("../src/versions/jsx.js");
const { RENDER_QUEUE_JSX } = await import("../src/tools/render.js");

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("reading the data", () => {
  it("CSV: quotes, quoted line breaks and delimiters, a BOM, CRLF, blank lines", () => {
    const t = data.csvTable('﻿City,Note\r\n"Paris, France","two\nlines"\r\n\r\nRome,"say ""ciao"""\r\n', "t.csv");
    expect(t.columns).toEqual(["City", "Note"]);
    expect(t.rows).toEqual([
      { City: "Paris, France", Note: "two\nlines" },
      { City: "Rome", Note: 'say "ciao"' },
    ]);
  });
  it("CSV: semicolon and tab files are recognised by their header line", () => {
    expect(data.csvTable("a;b\n1,5;2", "x").rows).toEqual([{ a: "1,5", b: "2" }]);
    expect(data.csvTable("a\tb\n1\t2", "x").rows).toEqual([{ a: "1", b: "2" }]);
  });
  it("CSV: a row with the wrong number of fields, an unclosed quote, a duplicate column are errors", () => {
    expect(() => data.csvTable("a,b\n1", "x")).toThrow(/data row 1 has 1 fields; the header has 2/);
    expect(() => data.csvTable('a\n"open', "x")).toThrow(/never closed/);
    expect(() => data.csvTable("a,a\n1,2", "x")).toThrow(/two columns are named "a"/);
  });
  it("JSON: an array or {rows}, flat values only; columns in order of first appearance", () => {
    const t = data.jsonTable({ rows: [{ a: 1 }, { b: "x", a: null }] }, "j");
    expect(t.columns).toEqual(["a", "b"]);
    expect(() => data.jsonTable([{ a: [1] }], "j")).toThrow(/row 1, column "a" holds a list/);
    expect(() => data.jsonTable({ x: 1 }, "j")).toThrow(/expected an array/);
  });
  it("rows to build", () => {
    expect(data.pickRows(undefined, 3)).toEqual([1, 2, 3]);
    expect(data.pickRows("3, 1-2", 5)).toEqual([1, 2, 3]);
    expect(() => data.pickRows("4-9", 5)).toThrow(/past the last row/);
    expect(() => data.pickRows("x", 5)).toThrow(/not a row number/);
  });
});

describe("numbers in the user's format", () => {
  it("parses cells, with either decimal separator", () => {
    expect(data.parseNumber("1,200.5")).toBe(1200.5);
    expect(data.parseNumber(" -15 ")).toBe(-15);
    expect(data.parseNumber("1.234,5", ",")).toBe(1234.5);
    expect(data.parseNumber("12 %")).toBeNull();
    expect(data.parseNumber("1,5")).toBeNull(); // not a number with "." as the decimal separator
    expect(data.parseNumber(null)).toBeNull();
  });
  it("rounds half away from zero without binary surprises", () => {
    expect(data.roundTo(1.005, 2)).toBe(1.01);
    expect(data.roundTo(-2.5, 0)).toBe(-3);
  });
  it("formats with the user's decimals, separators, prefix, suffix and sign style", () => {
    const f = { decimals: 2, thousandsSeparator: ",", prefix: "$" };
    expect(data.formatNumber(1200.5, f)).toBe("$1,200.50");
    expect(data.formatNumber(-15, f)).toBe("-$15.00");
    expect(data.formatNumber(-15, { ...f, negative: "minus-after-prefix" })).toBe("$-15.00");
    expect(data.formatNumber(-15, { ...f, negative: "parentheses" })).toBe("($15.00)");
    expect(data.formatNumber(1234567.891, { decimals: 1, thousandsSeparator: ".", decimalSeparator: ",", suffix: " €" })).toBe("1.234.567,9 €");
    expect(data.formatNumber(3.2, { plusSign: true, suffix: "%" })).toBe("+3.2%");
    expect(data.formatNumber(-0.001, { decimals: 2 })).toBe("0.00"); // rounds to zero: no minus
    expect(data.formatNumber(1e21)).toBe("1000000000000000000000");
  });
});

describe("colours and rules", () => {
  it("parses #rgb, #rrggbb, r,g,b in 0-255 or 0-1", () => {
    expect(data.parseColor("#f00")).toEqual([1, 0, 0]);
    expect(data.hex(data.parseColor("2e7d32")!)).toBe("#2E7D32");
    expect(data.parseColor("255, 128, 0")![1]).toBeCloseTo(128 / 255, 6);
    expect(data.parseColor("0.5,0.5,0.5")).toEqual([0.5, 0.5, 0.5]);
    expect(data.parseColor("red")).toBeNull();
  });
  it("the first matching rule wins; numbers compare as numbers; otherwise, or keep", () => {
    const rules = [
      { op: "<" as const, value: 0, color: "#C62828" },
      { op: "=" as const, value: "n/a", color: "#888888" },
    ];
    expect(data.colorByRules("-1.5", rules, "#2E7D32")).toEqual({ color: "#C62828", rule: "< 0" });
    expect(data.colorByRules("n/a", rules, "#2E7D32")).toEqual({ color: "#888888", rule: '= "n/a"' });
    expect(data.colorByRules("4", rules, "#2E7D32")).toEqual({ color: "#2E7D32", rule: "otherwise" });
    expect(data.colorByRules("4", rules, undefined)).toBeNull();
  });
});

describe("sizes, names and outputs", () => {
  it("maps values to pixels linearly between the user's points, and says when a value is outside them", () => {
    expect(data.mapToPx(50, [[0, 0], [100, 800]])).toEqual({ px: 400, outside: false });
    expect(data.mapToPx(150, [[100, 800], [0, 0]])).toEqual({ px: 1200, outside: true });
    expect(data.mapToPx(75, [[0, 0], [50, 100], [100, 500]]).px).toBe(300);
  });
  it("fills name and path patterns; values in a path lose characters a file name can't have", () => {
    const row = { City: "Paris/Île", Score: 3 };
    expect(data.fillPattern("{comp} - {City} {#3}", row, 7, "Card", ["City", "Score"])).toBe("Card - Paris/Île 007");
    expect(data.fillPattern("/out/{City}.mov", row, 1, "Card", ["City"], true)).toBe("/out/Paris_Île.mov");
    expect(() => data.fillPattern("{Town}", row, 1, "Card", ["City"])).toThrow(/names \{Town\}, which is not a column/);
    expect(data.patternColumns("{City}_{#}_{comp}")).toEqual(["City"]);
  });
  it("an output is taken by its file, or by any frame of an image sequence", () => {
    const dir = mkdtempSync(join(tmpdir(), "vfd-out-"));
    writeFileSync(join(dir, "a.mov"), "");
    writeFileSync(join(dir, "seq_0001.png"), "");
    expect(data.outputTaken(join(dir, "a.mov"))).toBe(join(dir, "a.mov"));
    expect(data.outputTaken(join(dir, "b.mov"))).toBeNull();
    expect(data.outputTaken(join(dir, "seq_[####].png"))).toBe(join(dir, "seq_0001.png"));
    expect(data.outputTaken(join(dir, "other_[####].png"))).toBeNull();
  });
});

describe("checks of one row", () => {
  const template: any = { comp: { id: 1, name: "Card", w: 1920, h: 1080, fps: 25, dur: 5, fd: 0.04 }, t: [{ ln: "Score", li: 2, pt: "TEXT_DOCUMENT", ex: 1 }, { ln: "Bar", li: 3, pt: "COLOR" }, { ln: "Bar", li: 3, pt: "OneD" }], clash: [] };
  const map: any[] = [
    { column: "Score", layer: "Score", kind: "number", format: { decimals: 2 } },
    { column: "Change", layer: "Bar", kind: "color", property: "Contents/Rectangle 1/Fill 1/Color", rules: [{ op: "<", value: 0, color: "#ff0000" }], otherwise: "#00ff00" },
    { column: "Opacity", layer: "Bar", kind: "value", property: "Transform/Opacity" },
  ];
  const checks = { overflow: false, textMustBeIn: "none" as const, glyphs: false, fonts: false };
  const prep = prepareRow(1, { Score: "12", Change: "-1", Opacity: "50" }, map, { name: "Card 1", t: template.t, numericTarget: (i) => template.t[i].pt !== "TEXT_DOCUMENT" && i !== 0 });
  const run = (rb: Record<string, unknown>, err: [number, string][] = []) =>
    checkRow({ prep, built: { n: 1, id: 9, name: "Card 1", err, rb }, map, template, mode: "duplicate", checks, checkAt: 4.96 });

  it("PASS when every value reads back as expected", () => {
    const r = run({ "0": "12.00", "1": [1, 0, 0, 1], "2": 50 });
    expect(r.verdict).toBe("PASS");
  });
  it("FAIL with what and where: text that renders differently (an expression), a wrong colour, a wrong value", () => {
    const r = run({ "0": "12", "1": [0, 1, 0, 1], "2": 49 });
    expect(r.verdict).toBe("FAIL (3)");
    const line = rowLine(r);
    expect(line).toMatch(/"Score": shows "12"; expected "12.00" \(an expression on it changes the value\)/);
    expect(line).toMatch(/"Bar" colour: is #00FF00; rule < 0 gives #FF0000/);
    expect(line).toMatch(/is 49; expected "50"/);
  });
  it("a value that could not be set fails and is not compared", () => {
    const r = run({ "1": [1, 0, 0, 1], "2": 50 }, [[0, "the layer is locked"]]);
    expect(r.findings.map((f) => f.check)).toEqual(["set"]);
    expect(rowLine(r)).toMatch(/could not be set: the layer is locked/);
  });
  it("Essential Graphics mode: layout checks that were asked for didn't run (INCOMPLETE, never PASS)", () => {
    const r = checkRow({ prep, built: { n: 1, id: 9, name: "Card 1", err: [], rb: { "0": "12.00", "1": [1, 0, 0, 1], "2": 50 } }, map, template, mode: "essentialGraphics", checks: { ...checks, overflow: true }, checkAt: 4.96 });
    expect(r.verdict).toBe("INCOMPLETE (1 check not run)");
  });
  it("values compare by value: numbers, lists of numbers, colours, text", () => {
    expect(valueMatches("10, 20", [10, 20, 0])).toBe(true);
    expect(valueMatches("#ff0000", [1, 0, 0, 1])).toBe(true);
    expect(valueMatches("3", 3.00001)).toBe(true);
    expect(valueMatches("a\nb", "a\rb")).toBe(true);
    expect(valueMatches("3", 4)).toBe(false);
  });
  it("the run's verdict is the worst row's, with how many rows have it", () => {
    const rows: any[] = [{ verdict: "PASS" }, { verdict: "INCOMPLETE (1 check not run)" }, { verdict: "FAIL (2)" }];
    expect(runVerdict(rows)).toBe("FAIL (1 of 3 rows)");
    expect(runVerdict(rows.slice(0, 2))).toBe("INCOMPLETE (1 of 2 rows)");
    expect(runVerdict([rows[0]])).toBe("PASS");
  });
});

// ---------- whole runs in the fake After Effects ----------

const LONG = "Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch";
let dir: string;
function project(extra: Partial<FakeProjectSpec> = {}): FakeProjectSpec {
  return {
    footage: [{ name: "placeholder.png", file: join(dir, "placeholder.png") }],
    comps: [
      {
        name: "Score Card",
        duration: 5,
        fps: 25,
        layers: [
          // point text 40 px per character from x = 100
          { name: "City", type: "text", position: [100, 200, 0], rect: (_t, text) => [0, -50, text.length * 40, 60], glyphsMissing: "Ł" },
          // paragraph text: overflows its box beyond 10 characters
          { name: "Score", type: "text", rect: [0, -50, 300, 60], boxOverflow: (text) => text.length > 10, glyphsMissing: "" },
          { name: "Bar", type: "shape", position: [100, 600, 0], rect: [0, 0, 100, 40], props: { "Contents/Rectangle 1/Fill 1/Color": { value: [1, 1, 1, 1], type: "COLOR" } } },
          { name: "Photo", type: "footage", source: "placeholder.png" },
        ],
      },
    ],
    ...extra,
  };
}
const MAP = [
  { column: "City", layer: "City", kind: "text" },
  { column: "Score", layer: "Score", kind: "number", format: { decimals: 2, thousandsSeparator: ",", prefix: "$" } },
  { column: "Change", layer: "Bar", kind: "color", property: "Contents/Rectangle 1/Fill 1/Color", rules: [{ op: "<", value: 0, color: "#C62828" }], otherwise: "#2E7D32" },
  { column: "Change", layer: "Bar", kind: "size", px: [[0, 0], [10, 800]] },
  { column: "Photo", layer: "Photo", kind: "footage" },
  { column: "Opacity", layer: "Bar", kind: "value", property: "Transform/Opacity" },
] as any[];
const CSV = `City,Score,Change,Photo,Opacity
Berlin,1200.5,3.2,berlin.png,100
"Paris, France",-15,-1.5,missing.png,50
Rome,12345678,0,rome.png,80
Łódź,7,1,berlin.png,100
${LONG},7,1,berlin.png,100
`;
const text = (r: any) => r.content.map((c: any) => c.text).join("\n");
const comp = (name: string) => fake.comps.concat(fake.items).find((c: any) => c.name === name);
const layerValue = (c: any, layer: string, ...path: string[]) => {
  let p = c.layer(layer);
  for (const s of path) p = p.property(s);
  return p.value;
};

describe("ae_versions_from_data in the fake After Effects", () => {
  let csv: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vfd-"));
    for (const f of ["placeholder.png", "berlin.png", "rome.png"]) writeFileSync(join(dir, f), "png");
    csv = join(dir, "scores.csv");
    writeFileSync(csv, CSV);
    fake = fakeProject(project());
    jsxCalls.length = 0;
  });

  it("the input schema converts to JSON schema (ae_tools describe)", () => {
    expect(() => z.toJSONSchema(z.object(inputSchema))).not.toThrow();
  });

  it("dryRun: what each row would get, data problems named, nothing changed", async () => {
    const r = await runVersions({ data: csv, comp: "Score Card", map: MAP, name: "{comp} - {City}", dryRun: true });
    const t = text(r);
    expect(t).toMatch(/^Dry run: the mapping fits the template and the data; nothing was changed\./);
    expect(t).toMatch(/5 rows of scores\.csv -> 5 versions of "Score Card" \(mode duplicate\), values read back at 00:00:04:24 \(4\.96s\)/);
    expect(t).toMatch(/1  Score Card - Berlin: "City" = "Berlin"; "Score" = "\$1,200\.50"; "Bar" colour = #2E7D32 \(rule otherwise\); "Bar" width = 256 px/);
    expect(t).toMatch(/PROBLEM "Photo" footage: Photo "missing\.png": no file at .*missing\.png/);
    expect(t).toMatch(/PROBLEM "Bar" width: Change "-1\.5": outside the mapped values \(0 to 10\)/);
    expect(fake.writes).toEqual([]);
    expect(fake.comps.length).toBe(1);
    expect(jsxCalls.every((c) => c.opts.undoGroup === false)).toBe(true);
  });

  it("dryRun: mapping problems before anything is read in After Effects, and target problems after", async () => {
    const r1 = await runVersions({ data: csv, map: [{ column: "Town", layer: "City", kind: "text" }], dryRun: true });
    expect(text(r1)).toMatch(/there is no column "Town"/);
    expect(jsxCalls).toHaveLength(0);
    const r2 = await runVersions({ data: csv, comp: "Score Card", map: [{ column: "City", layer: "Bar", kind: "text" }, { column: "City", layer: "Nope", kind: "text" }], dryRun: true });
    expect(text(r2)).toMatch(/layer 'Bar' is not a text layer/);
    expect(text(r2)).toMatch(/No layer named 'Nope'/);
  });

  it("builds every row as a duplicate, sets the values, and checks every row", async () => {
    const r = await runVersions({ data: csv, comp: "Score Card", map: MAP, name: "{comp} - {City}", checks: { title: 0.1 } });
    const t = text(r);
    expect(r.isError).toBeFalsy();
    expect(t.split("\n")[0]).toBe("FAIL (4 of 5 rows)");
    expect(t).toMatch(/5 versions of "Score Card" from scores\.csv \(mode duplicate\) in folder "Score Card versions"/);
    expect(t).toMatch(/checked per row: 5 values read back, 1 size measured, box overflow, text inside the frame on every frame, glyphs, fonts/);
    expect(t).toMatch(/5 rows: 1 PASS, 4 FAIL/);
    expect(t).toMatch(/\n +1  PASS +Score Card - Berlin\n/);
    // data problems: the missing file and the value outside the mapping
    expect(t).toMatch(/2  FAIL \(2\) +Score Card - Paris, France: .*Photo "missing\.png": no file at/);
    // the size check on a measured bar (Berlin passed); a bar that renders at the wrong size fails
    expect(t).not.toMatch(/wide on screen/);
    expect(t).toMatch(/Change "-1\.5": outside the mapped values/);
    // Preflight's box overflow, glyphs and frame checks on the version's own layers
    expect(t).toMatch(/3  FAIL \(1\) +Score Card - Rome: Score: paragraph text overflows its box/);
    expect(t).toMatch(/4  FAIL \(1\) +Score Card - Łódź: City: font ArialMT has no glyph for "Ł"/);
    expect(t).toMatch(new RegExp(`5  FAIL \\(1\\) +Score Card - ${LONG}: City: outside the frame by up to \\d+ px on the right at 00:00:00:00–00:00:04:24`));

    const berlin = comp("Score Card - Berlin");
    expect(layerValue(berlin, "City", "ADBE Text Properties", "ADBE Text Document").text).toBe("Berlin");
    expect(layerValue(berlin, "Score", "ADBE Text Properties", "ADBE Text Document").text).toBe("$1,200.50");
    expect(data.hex(layerValue(berlin, "Bar", "Contents", "Rectangle 1", "Fill 1", "Color"))).toBe("#2E7D32");
    expect(layerValue(berlin, "Bar", "ADBE Transform Group", "ADBE Scale")[0]).toBeCloseTo(256, 6);
    expect(berlin.layer("Photo").source.file.fsName).toBe(join(dir, "berlin.png"));
    // the template is untouched; berlin.png is imported once for three rows
    const tpl = comp("Score Card");
    expect(layerValue(tpl, "City", "ADBE Text Properties", "ADBE Text Document").text).toBe("City");
    expect(layerValue(tpl, "Bar", "ADBE Transform Group", "ADBE Scale")).toEqual([100, 100, 100]);
    expect(fake.imported.filter((f) => f.endsWith("berlin.png"))).toHaveLength(1);
    // one undo group for the build, read-only calls for the checks
    const undo = jsxCalls.filter((c) => c.opts.undoGroup);
    expect(undo).toHaveLength(1);
    expect(undo[0].opts).toMatchObject({ undoGroup: "Versions from data", rollback: "requested" });
    expect(undo[0].body).toBe(BUILD_JSX);
    expect(t).toMatch(/One ae_undo removes every version/);
  });

  it("refuses to build over names already in the project, and over output files that exist", async () => {
    await runVersions({ data: csv, comp: "Score Card", map: MAP.slice(0, 1), rows: "1" });
    const again = await runVersions({ data: csv, comp: "Score Card", map: MAP.slice(0, 1), rows: "1" });
    expect(again.isError).toBe(true);
    expect(text(again)).toMatch(/Nothing was built:\n- already in the project: "Score Card 1"/);
    const out = join(dir, "renders");
    mkdirSync(out);
    writeFileSync(join(out, "Rome.mov"), "x");
    const taken = await runVersions({ data: csv, comp: "Score Card", map: MAP.slice(0, 1), rows: "3", name: "{City} v2", queue: { output: join(out, "{City}.mov") } });
    expect(text(taken)).toMatch(/row 3: a file already exists at .*Rome\.mov\. To replace it, pass overwrite: true/);
  });

  it("queues every version with the user's output module, and renders only the rows that pass", async () => {
    const out = join(dir, "renders");
    const r = await runVersions({
      data: csv, comp: "Score Card", map: MAP, name: "{City}", queue: { output: join(out, "{#2}_{City}.mov"), outputModuleTemplate: "ProRes 422 HQ" }, render: true,
    });
    const t = text(r);
    expect(fake.rqItems).toHaveLength(5);
    expect(fake.rqItems[0].outputModule(1).name).toBe("ProRes 422 HQ");
    expect(fake.rqItems[1].outputModule(1).file.fsName).toBe(join(out, "02_Paris, France.mov"));
    expect(fake.rendered).toEqual(["Berlin"]);
    expect(t).toMatch(/render queue: 5 versions queued with "ProRes 422 HQ"/);
    expect(t).toMatch(/rendered: 1 of 1/);
    expect(t).toMatch(/not rendered \(did not pass; still queued\): rows 2, 3, 4, 5/);
    expect(jsxCalls.find((c) => c.body === RENDER_QUEUE_JSX)!.args).toEqual({ only: [1] });
  });

  it("without render: true nothing is rendered", async () => {
    const r = await runVersions({ data: csv, comp: "Score Card", map: MAP.slice(0, 1), rows: "1", queue: { output: join(dir, "{City}.mov") } });
    expect(fake.rendered).toEqual([]);
    expect(text(r)).toMatch(/not rendered \(render: true renders the versions that pass\)/);
  });

  it("a missing font fails every row that uses it (Project X-ray's font list)", async () => {
    fake = fakeProject(project({ fonts: [{ postScriptName: "ArialMT", familyName: "Arial", styleName: "Regular", isSubstitute: true }] }));
    const r = await runVersions({ data: csv, comp: "Score Card", map: MAP.slice(0, 1), rows: "1" });
    expect(text(r)).toMatch(/1  FAIL \(1\) +Score Card 1: City: font ArialMT \(Arial Regular\) is substituted/);
  });

  it("read-only mode refuses to build (the dry run still works)", async () => {
    mkdirSync(join(home, ".surehand", "ae"), { recursive: true });
    writeFileSync(join(home, ".surehand", "ae", "config.json"), JSON.stringify({ permissions: { mode: "read-only" } }));
    try {
      const r = await runVersions({ data: csv, comp: "Score Card", map: MAP.slice(0, 1) });
      expect(r.isError).toBe(true);
      expect(fake.comps).toHaveLength(1);
      const d = await runVersions({ data: csv, comp: "Score Card", map: MAP.slice(0, 1), dryRun: true });
      expect(d.isError).toBeFalsy();
    } finally {
      rmSync(join(home, ".surehand"), { recursive: true, force: true });
    }
  });

  it("Essential Graphics mode: a precomp per row with the row's Essential Properties, values read back", async () => {
    fake = fakeProject({
      comps: [{ name: "Lower Third", duration: 4, layers: [{ name: "Name", type: "text" }], egp: [{ name: "Headline", value: { text: "", applyFill: true, fillColor: [1, 1, 1] }, type: "TEXT_DOCUMENT" }, { name: "Value", value: 0, type: "OneD" }] }],
    });
    const rows = [{ Who: "Ada", N: "1.5" }, { Who: "Grace", N: "2" }];
    const r = await runVersions({ data: rows, comp: "Lower Third", map: [{ column: "Who", egp: "Headline", kind: "text" }, { column: "N", egp: "Value", kind: "number" }], name: "LT {Who}" } as any);
    const t = text(r);
    expect(t.split("\n")[0]).toBe("PASS");
    expect(t).toMatch(/2 versions of "Lower Third" from inline rows \(mode essentialGraphics\)/);
    const ada = comp("LT Ada");
    expect(ada.layer(1).source.name).toBe("Lower Third");
    expect(ada.layer(1).essentialProperty.property("Headline").value.text).toBe("Ada");
    expect(ada.layer(1).essentialProperty.property("Value").value).toBe(1.5);
    // asked for a layout check that can't run there: INCOMPLETE, not PASS
    fake = fakeProject({ comps: [{ name: "Lower Third", duration: 4, layers: [], egp: [{ name: "Headline", value: { text: "" }, type: "TEXT_DOCUMENT" }] }] });
    const r2 = await runVersions({ data: rows, comp: "Lower Third", map: [{ column: "Who", egp: "Headline", kind: "text" }], checks: { overflow: true } } as any);
    expect(text(r2).split("\n")[0]).toBe("INCOMPLETE (2 of 2 rows)");
    expect(text(r2)).toMatch(/not checked: text\.overflow: Essential Graphics mode/);
  });

  it("bar sizes are measured on screen: through the parent's scale (PASS), a rotated parent (FAIL), not visible at checkAt (INCOMPLETE)", async () => {
    const bars = (parent: Partial<import("./fake-ae.js").FakeLayerSpec>, bar: Partial<import("./fake-ae.js").FakeLayerSpec> = {}) =>
      fakeProject({ comps: [{ name: "Chart", duration: 5, layers: [{ name: "Rig", type: "null", ...parent }, { name: "Bar", type: "shape", parent: 1, position: [0, 0, 0], rect: [0, 0, 100, 40], ...bar }] }] });
    const run = () => runVersions({ data: [{ v: "5" }], comp: "Chart", map: [{ column: "v", layer: "Bar", kind: "size", px: [[0, 0], [10, 800]] }], name: "C {#}" } as any);
    fake = bars({ position: [200, 500, 0], scale: [50, 50, 100] });
    expect(text(await run()).split("\n")[0]).toBe("PASS");
    expect(comp("C 1").layer("Bar").property("ADBE Transform Group").property("ADBE Scale").value[0]).toBeCloseTo(800, 6); // 400 px through a 50% parent
    fake = bars({ position: [200, 500, 0], rotation: 90 });
    expect(text(await run())).toMatch(/1  FAIL \(1\) +C 1: "Bar" width: 40 px wide on screen; v 5 maps to 400 px \(±1 px\) at 00:00:04:24/);
    fake = bars({ position: [200, 500, 0] }, { outPoint: 2 });
    expect(text(await run())).toMatch(/1  INCOMPLETE .*not checked: size "Bar" width: the layer isn't visible at 4\.96 s \(checkAt\)/);
  });

  it("keyframed targets are refused before anything is built", async () => {
    fake = fakeProject(project({ comps: [{ name: "Score Card", layers: [{ name: "Bar", type: "shape", anim: { "ADBE Scale": () => [50, 50, 100] } }] }] }));
    const r = await runVersions({ data: csv, comp: "Score Card", map: [{ column: "Change", layer: "Bar", kind: "size", px: [[0, 0], [10, 800]] }] as any });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/'Scale' on layer 'Bar' has keyframes/);
    expect(fake.comps).toHaveLength(1);
  });
});
