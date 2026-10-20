// The localization round trip (ae_localize): the files (CSV with a BOM, XLIFF 1.2 written, 1.2 and 2.0 read, line
// breaks, Hebrew), and whole runs in the fake After Effects (test/fake-ae.ts): export with context, import as one
// version per language (the comp tree duplicated, right to left set up, fitting by the user's rules), the checks per
// language (Preflight's real collector), and the drift report. A temporary home: nothing real is touched.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fakeProject, type FakeProjectSpec } from "./fake-ae.js";

const home = mkdtempSync(join(tmpdir(), "surehand-localize-"));
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

const files = await import("../src/localize/files.js");
const { runLocalize, inputSchema } = await import("../src/tools/localize.js");
const { BUILD_JSX } = await import("../src/localize/jsx.js");

afterAll(() => rmSync(home, { recursive: true, force: true }));

const HEB = "אבגדהוזחטיכךלמםנןסעפףצץקרשת";
const text = (r: any) => r.content.map((c: any) => c.text).join("\n");

describe("the files", () => {
  const units = [
    { id: "c1:L10", comp: "Main", layer: "Title", source: "Two\rlines, \"quoted\"", onScreen: "00:00:00:00–00:00:05:00 (5.00 s)", box: "600 × 120", maxChars: 48, context: "paragraph text" },
    { id: "c2:L20", comp: "Main > Lower Third", layer: "Name", source: "Soft\u0003break", maxWidth: 1720 },
  ];
  it("CSV: a BOM, CRLF lines, a column per language, line breaks and quotes kept", () => {
    const csv = files.writeCsv(units, ["he", "fr"]);
    expect(csv.startsWith("\uFEFFid,comp,layer,source,he,fr,on screen,box (px),max width (px),max chars,context,notes\r\n")).toBe(true);
    expect(csv).toContain('c1:L10,Main,Title,"Two\nlines, ""quoted""",,,00:00:00:00–00:00:05:00 (5.00 s),600 × 120,,48,paragraph text,\r\n');
    const rows = files.csvRows(csv);
    expect(rows[2][3]).toBe("Soft\u2028break");
  });
  it("CSV back: languages from the header, After Effects line breaks, empty cells are untranslated", () => {
    const csv = files.writeCsv(units, ["he", "fr"]).replace(",,,00:00", `,"שתי\nשורות",,00:00`);
    const f = files.readCsv("/x/main.csv", csv);
    expect(f.languages).toEqual(["he", "fr"]);
    expect(f.root).toBe("Main");
    expect(f.units[0]).toMatchObject({ id: "c1:L10", source: 'Two\rlines, "quoted"', targets: { he: "שתי\rשורות" } });
    expect(f.units[1].source).toBe("Soft\u0003break");
    expect(f.units[1].targets).toEqual({});
    const odd = files.readCsv("/x/a.csv", "id,source,he,Reviewer\nc1:L1,Hi,שלום,Dana\n");
    expect(odd.notes).toEqual(['column "Reviewer" is not a language code (like he, ar, fr-CA): ignored']);
    expect(() => files.readCsv("/x/a.csv", "key,text\n1,2\n")).toThrow(/has no "id" column/);
  });
  it("a CSV that isn't UTF-8 (Excel's plain CSV on Windows) is refused with how to save it", () => {
    const dir = mkdtempSync(join(tmpdir(), "loc-enc-"));
    const p = join(dir, "he.csv");
    writeFileSync(p, Buffer.from([0x69, 0x64, 0x2c, 0x68, 0x65, 0x0a, 0x31, 0x2c, 0xf9, 0xec, 0xe5, 0xed, 0x0a])); // "שלום" in Windows-1255
    expect(() => files.readUtf8(p)).toThrow(/not UTF-8.*CSV UTF-8 \(Comma delimited\)/s);
  });
  it("XLIFF 1.2: well formed, one target language, the limit as maxwidth / size-unit, context as notes; read back", () => {
    const x = files.writeXliff(units, { sourceLanguage: "en", targetLanguage: "he", root: "Main & co" });
    expect(x).toContain('<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">');
    expect(x).toContain('<file original="Main &amp; co" source-language="en" target-language="he" datatype="plaintext">');
    expect(x).toContain('<trans-unit id="c1:L10" resname="Main &gt; Title" maxwidth="48" size-unit="char" xml:space="preserve">');
    expect(x).toContain("<source xml:lang=\"en\">Two\nlines, \"quoted\"</source>");
    expect(x).toMatch(/<note from="Surehand" priority="2">Main &gt; Title · on screen .* · paragraph box 600 × 120 px · at most 48 characters · paragraph text<\/note>/);
    // a CAT tool's answer: a target per unit, segmented with <mrk>, an entity, CDATA
    const back = x
      .replace('Two\nlines, "quoted"</source>', 'Two\nlines, "quoted"</source>\n        <target state="translated"><mrk mtype="seg" mid="1">שתי</mrk>\n<mrk mtype="seg" mid="2">שורות &amp; &#x5D0;</mrk></target>')
      .replace("Soft\u2028break</source>", "Soft\u2028break</source><target state=\"needs-review-translation\"><![CDATA[רך<b>]]></target>");
    const f = files.readXliff("/x/main_he.xlf", back);
    expect(f).toMatchObject({ root: "Main & co", sourceLanguage: "en", languages: ["he"] });
    expect(f.units[0]).toMatchObject({ id: "c1:L10", comp: "Main", layer: "Title", source: 'Two\rlines, "quoted"', targets: { he: "שתי\rשורות & א" } });
    expect(f.units[1]).toMatchObject({ source: "Soft\u0003break", targets: { he: "רך<b>" }, state: { he: "needs-review-translation" } });
  });
  it("XLIFF 2.0 is read too (segments joined)", () => {
    const x = `<?xml version="1.0"?><xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="en" trgLang="ar">
      <file id="f1" original="Main"><unit id="c1:L10" name="Main > Title"><segment><source>Hello </source><target>مرحبا </target></segment><segment state="final"><source>world</source><target>بالعالم</target></segment></unit></file></xliff>`;
    const f = files.readXliff("/x/a.xlf", x);
    expect(f.languages).toEqual(["ar"]);
    expect(f.units[0]).toMatchObject({ id: "c1:L10", layer: "Title", source: "Hello world", targets: { ar: "مرحبا بالعالم" } });
    expect(() => files.readXliff("/x/a.xlf", "<xliff><file><body></file>")).toThrow(/not valid XML/);
  });
  it("right to left by the language code, its script subtag first", () => {
    for (const l of ["he", "he-IL", "iw", "ar", "ar-EG", "fa", "ur", "yi", "ckb", "az-Arab"]) expect(files.isRtl(l)).toBe(true);
    for (const l of ["en", "fr-CA", "ru", "sd-Deva", "ku", "ja"]) expect(files.isRtl(l)).toBe(false);
  });
  it("line breaks and normalization don't count as a change", () => {
    expect(files.sameText("a\r\nb", "a\rb")).toBe(true);
    expect(files.sameText("é", "é")).toBe(true);
    expect(files.sameText("a", "b")).toBe(false);
  });
});

// ---------- whole runs in the fake After Effects ----------

// text metrics: a character is fontSize/2 wide (times horizontal scale and tracking); lines are 1.2 x fontSize
const charW = (d: any) => d.fontSize * 0.5 * (d.horizontalScale > 10 ? d.horizontalScale / 100 : d.horizontalScale) * (1 + (d.tracking ?? 0) / 1000);
const pointRect = (_t: number, s: string, d: any) => {
  const w = Array.from(s).length * charW(d) * 0.8, J = d.justification;
  return [J === 7414 ? -w : J === 7415 ? -w / 2 : 0, -d.fontSize * 0.8, w, s === "H" ? d.fontSize * 0.7 : d.fontSize];
};
const boxOver = (s: string, d: any) => {
  const [bw, bh] = d.boxTextSize, perLine = Math.floor(bw / charW(d)), lines = Math.floor(bh / (d.fontSize * 1.2));
  return Array.from(s).length > perLine * lines;
};
function project(extra: Partial<FakeProjectSpec> = {}): FakeProjectSpec {
  return {
    comps: [
      { name: "Lower Third", duration: 5, layers: [{ name: "Name", type: "text", text: "Ron Yitzhaki", position: [100, 900, 0], rect: pointRect }] },
      {
        name: "Main",
        duration: 5,
        layers: [
          { name: "Title", type: "text", text: "Summer sale", box: [600, 120], boxOverflow: boxOver, position: [200, 200, 0], rect: [0, -50, 300, 60] },
          { name: "Lower Third", source: "Lower Third", anchor: [960, 540, 0] },
          { name: "Count", type: "text", textKeys: [{ t: 0, text: "One" }, { t: 2, text: "Two" }] },
          { name: "Note", type: "text", text: "for the editor", enabled: false },
        ],
      },
    ],
    fontGlyphsMissing: { ArialMT: HEB, ArialHebrew: "" },
    activeComp: "Main",
    ...extra,
  };
}
let dir: string;
const comp = (name: string) => fake.items.find((c: any) => c.name === name);
const doc = (c: any, layer: string) => c.layer(layer).property("ADBE Text Properties").property("ADBE Text Document").value;

/** Fills the exported CSV like a translator in Excel would: id -> {lang: text}. */
function translate(csvPath: string, t: Record<string, Record<string, string>>) {
  const rows = files.csvRows(readFileSync(csvPath, "utf8"));
  const head = rows[0];
  for (const r of rows.slice(1)) for (const [l, v] of Object.entries(t[r[0]] ?? {})) r[head.indexOf(l)] = v;
  const esc = (s: string) => (/[",\n\r\u2028]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  writeFileSync(csvPath, "\uFEFF" + rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n");
}

describe("ae_localize in the fake After Effects", () => {
  let csv: string;
  let ids: Record<string, string>;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "loc-"));
    fake = fakeProject(project());
    jsxCalls.length = 0;
    csv = join(dir, "main.csv");
    const ex = await runLocalize({ action: "export", file: csv, languages: ["he", "fr"], maxChars: "fromBox", notes: { Title: "Headline, keep it short" } });
    expect(ex.isError).toBeFalsy();
    const rows = files.csvRows(readFileSync(csv, "utf8"));
    ids = Object.fromEntries(rows.slice(1).map((r) => [`${r[2]}${/:k\d$/.test(r[0]) ? r[0].slice(-3) : ""}`, r[0]]));
    jsxCalls.length = 0;
  });

  it("the input schema converts to JSON schema (ae_tools describe)", () => {
    expect(() => z.toJSONSchema(z.object(inputSchema))).not.toThrow();
  });

  it("export: every text of the tree (precomps, keyframes, hidden layers) with its context, and nothing in the project changed", async () => {
    const raw = readFileSync(csv, "utf8");
    expect(raw.charCodeAt(0)).toBe(0xfeff);
    const rows = files.csvRows(raw);
    expect(rows[0]).toEqual(["id", "comp", "layer", "source", "he", "fr", "on screen", "box (px)", "max width (px)", "max chars", "context", "notes"]);
    const by = (layer: string) => rows.find((r) => r[2] === layer)!;
    expect(by("Title")).toEqual([ids.Title, "Main", "Title", "Summer sale", "", "", "00:00:00:00–00:00:05:00 (5.00 s)", "600 × 120", "", "44", expect.stringContaining("paragraph text; aligned left"), "Headline, keep it short"]);
    expect(ids.Title).toMatch(/^c\d+:L\d+$/);
    // the precomp's text: its comp path, the room it has to the frame's right edge (comp px), a limit from its width
    expect(by("Name").slice(1, 4)).toEqual(["Main > Lower Third", "Name", "Ron Yitzhaki"]);
    expect(by("Name")[8]).toBe("1820");
    expect(by("Name")[9]).toBe("91");
    // keyframed text: one string per keyframe, its own time on screen
    const keys = rows.filter((r) => r[2] === "Count");
    expect(keys.map((r) => [r[0].replace(/^.*:/, ""), r[3], r[6]])).toEqual([
      ["k1", "One", "00:00:00:00–00:00:02:00 (2.00 s)"],
      ["k2", "Two", "00:00:02:00–00:00:05:00 (3.00 s)"],
    ]);
    expect(by("Note")[10]).toMatch(/layer is off/);
    expect(fake.writes).toEqual([]);
    expect(jsxCalls.every((c) => c.opts.undoGroup === false)).toBe(true);
  });

  it("export refuses to replace a file, needs {lang} for XLIFF of several languages; a dry run writes nothing", async () => {
    expect(text(await runLocalize({ action: "export", file: csv, languages: ["he"] }))).toMatch(/a file already exists at .*main\.csv\. To replace it, pass overwrite: true/);
    expect(text(await runLocalize({ action: "export", file: join(dir, "m.xlf"), languages: ["he", "ar"], sourceLanguage: "en" }))).toMatch(/put \{lang\} in the file name/);
    expect(text(await runLocalize({ action: "export", file: join(dir, "m.xlf"), languages: ["he"] }))).toMatch(/sourceLanguage: the master's language/);
    const d = await runLocalize({ action: "export", file: join(dir, "dry.csv"), languages: ["he"], dryRun: true });
    expect(text(d)).toMatch(/^Dry run: nothing was written\.\n5 strings of "Main" \(2 comps\) would be written for he/);
    expect(existsSync(join(dir, "dry.csv"))).toBe(false);
    const x = await runLocalize({ action: "export", file: join(dir, "m_{lang}.xlf"), languages: ["he", "ar"], sourceLanguage: "en" });
    expect(text(x)).toMatch(/m_he\.xlf \(XLIFF 1\.2, he\)\n.*m_ar\.xlf \(XLIFF 1\.2, ar\)/);
    expect(files.readXliff(join(dir, "m_ar.xlf"), readFileSync(join(dir, "m_ar.xlf"), "utf8")).units).toHaveLength(5);
  });

  it("import: a version per language, the tree duplicated, Hebrew right to left, checked like Preflight (PASS)", async () => {
    translate(csv, {
      [ids.Title]: { he: "מבצע קיץ", fr: "Soldes d'été" },
      [ids.Name]: { he: "רון יצחקי", fr: "Ron Yitzhaki" },
      [ids["Count:k1"]]: { he: "אחת", fr: "Un" },
      [ids["Count:k2"]]: { he: "שתיים", fr: "Deux" },
    });
    const r = await runLocalize({ action: "import", file: csv, fonts: { he: { "*": "ArialHebrew" } } });
    const t = text(r);
    expect(r.isError).toBeFalsy();
    expect(t.split("\n")[0]).toBe("PASS");
    expect(t).toMatch(/2 languages of "Main" from main\.csv: he -> "Main \[he\]", fr -> "Main \[fr\]"/);
    expect(t).toMatch(/checked per language: texts read back, fit by your rules, right-to-left direction, box overflow, text inside the frame on every frame, glyphs, fonts/);
    expect(t).toMatch(/\n +he +PASS +Main \[he\] \(RTL\)\n/);
    // the tree: the precomp is copied per language and the copy of Main uses it
    const he = comp("Main [he]"), lt = comp("Lower Third [he]");
    expect(he.layer("Lower Third").source).toBe(lt);
    expect(comp("Main [fr]").layer("Lower Third").source).toBe(comp("Lower Third [fr]"));
    expect(he.parentFolder.name).toBe("Main - he");
    // Hebrew: text, font, direction, the Universal composer, mirrored alignment; point text kept where it was
    const title = doc(he, "Title");
    expect(title.text).toBe("מבצע קיץ");
    expect(title.font).toBe("ArialHebrew");
    expect(title.direction).toBe(7613);
    expect(title.composerEngine).toBe(7813);
    expect(title.justification).toBe(7414);
    const name = doc(lt, "Name");
    expect(name.justification).toBe(7414);
    // the master's Name was 12 chars x 20 px = 240 px wide from x 0: right-aligned now, its right edge stays at 240
    expect(lt.layer("Name").property("ADBE Transform Group").property("ADBE Anchor Point").value[0]).toBe(-240);
    expect(t).toMatch(/alignment flipped, anchor point moved 240 px/);
    // keyframes set per keyframe
    const keys = he.layer("Count").property("ADBE Text Properties").property("ADBE Text Document").__keys;
    expect(keys.map((k: any) => k.v.text)).toEqual(["אחת", "שתיים"]);
    // French stays left to right, untouched alignment; the master is untouched
    expect(doc(comp("Main [fr]"), "Title").direction).toBe(7612);
    expect(doc(comp("Main [fr]"), "Title").justification).toBe(7413);
    expect(doc(comp("Main"), "Title").text).toBe("Summer sale");
    expect(doc(comp("Lower Third"), "Name").text).toBe("Ron Yitzhaki");
    // one undo group for the whole import
    const undo = jsxCalls.filter((c) => c.opts.undoGroup);
    expect(undo).toHaveLength(1);
    expect(undo[0].opts).toMatchObject({ undoGroup: "Localize: import", rollback: "requested" });
    expect(undo[0].body).toBe(BUILD_JSX);
    expect(t).toMatch(/One ae_undo removes every language version/);
  });

  it("missing Hebrew glyphs in the master's font FAIL (no font map), and untranslated strings FAIL by name", async () => {
    translate(csv, { [ids.Title]: { he: "מבצע קיץ" }, [ids.Name]: { he: "רון" } });
    const t = text(await runLocalize({ action: "import", file: csv, languages: ["he"] }));
    expect(t.split("\n")[0]).toBe("FAIL (1 of 1 language)");
    expect(t).toMatch(/Main \[he\] > Title: font ArialMT has no glyph for "מ" "ב" "צ" "ע" "ק" "י" "ץ"/);
    expect(t).toMatch(/Main > Count \(keyframe 1\): not translated; shows the master text "One"/);
    // a hidden layer's text is not required
    expect(t).not.toMatch(/Note: not translated/);
  });

  it("fitting by the user's rules, in order, never past a limit; when it can't fit: the best attempt and FAIL with why", async () => {
    const long = "א".repeat(60);
    translate(csv, { [ids.Title]: { he: long } });
    const fit = { steps: [{ adjust: "tracking" as const, min: -50 }, { adjust: "fontSize" as const, min: 40 }] };
    const ok = text(await runLocalize({ action: "import", file: csv, languages: ["he"], fonts: { he: { "*": "ArialHebrew" } }, allowUntranslated: true, fit }));
    expect(ok).toMatch(/adjusted within your rules\n +he +Main > Title: font size 50 -> 42, tracking 0 -> -50/);
    expect(doc(comp("Main [he]"), "Title").fontSize).toBe(42);
    expect(ok).not.toMatch(/overflows its box/);
    // stricter rules: it can't fit; left at the limits (never below 46), FAIL with what was tried
    rmSync(csv);
    fake = fakeProject(project());
    await runLocalize({ action: "export", file: csv, languages: ["he"] });
    translate(csv, Object.fromEntries([[files.csvRows(readFileSync(csv, "utf8"))[1][0], { he: long }]]));
    const bad = text(await runLocalize({ action: "import", file: csv, fonts: { he: { "*": "ArialHebrew" } }, allowUntranslated: true, fit: { steps: [{ adjust: "fontSize", min: 46 }, { adjust: "boxHeight", maxGrow: 10 }] } }));
    expect(bad.split("\n")[0]).toBe("FAIL (1 of 1 language)");
    expect(bad).toMatch(/Main > Title: overflows its box: still doesn't fit with every allowed adjustment at its limit \(left at that best attempt\) \(tried: font size 50 -> 46 \(the minimum\), box height \+10 px \(the maximum\)\)/);
    const td = doc(comp("Main [he]"), "Title");
    expect(td.fontSize).toBe(46);
    expect(td.boxTextSize).toEqual([600, 130]);
    // the overflow is that same failure, not counted again
    expect(bad).not.toMatch(/paragraph text overflows its box/);
  });

  it("box growth goes away from the aligned edge: a right-aligned (Hebrew) box grows to the left", async () => {
    translate(csv, { [ids.Title]: { he: "א".repeat(52) } });
    const t = text(await runLocalize({ action: "import", file: csv, languages: ["he"], fonts: { he: { "*": "ArialHebrew" } }, allowUntranslated: true, fit: { steps: [{ adjust: "boxWidth", maxGrow: 200 }] } }));
    expect(t).toMatch(/Main > Title: box 600 × 120 -> 650 × 120 px/);
    const td = doc(comp("Main [he]"), "Title");
    expect(td.boxTextSize).toEqual([650, 120]);
    expect(td.boxTextPos).toEqual([-50, -50]);
  });

  it("point text: the user's maxWidth (comp px) through the layer's scale, and a cap-height minimum measured on the font", async () => {
    translate(csv, { [ids.Name]: { he: "א".repeat(40) } });
    const t = text(await runLocalize({ action: "import", file: csv, languages: ["he"], fonts: { he: { "*": "ArialHebrew" } }, allowUntranslated: true, fitLayers: [{ layer: "Name", maxWidth: 600, steps: [{ adjust: "capHeight", min: 25 }] }] }));
    // 40 chars x 0.4 x fontSize <= 600 -> font size 37.5; cap height 25 px = font size 35.7 (0.7 of the size): fits at 37.5
    expect(t).toMatch(/Lower Third > Name: font size 50 -> 37\.5/);
    const tight = text(await runLocalize({ action: "import", file: csv, languages: ["he"], name: "{comp} v2 [{lang}]", folder: "v2", fonts: { he: { "*": "ArialHebrew" } }, allowUntranslated: true, fitLayers: [{ layer: "Name", maxWidth: 400, steps: [{ adjust: "capHeight", min: 25 }] }] }));
    expect(tight).toMatch(/Name: is 571\.4 px wide in the layer; the limit is 400: still doesn't fit .*font size \(cap height 25 px\) 50 -> 35\.7 \(the minimum\)/);
  });

  it("drift: the master text changed after export, per language", async () => {
    translate(csv, { [ids.Title]: { he: "מבצע קיץ", fr: "Soldes d'été" }, [ids.Name]: { fr: "Ron" } });
    const title = comp("Main").layer("Title").property("ADBE Text Properties").property("ADBE Text Document");
    title.value.text = "Winter sale";
    const t = text(await runLocalize({ action: "drift", file: csv }));
    expect(t.split("\n")[0]).toBe("DRIFT (1 of 5 strings changed since export)");
    expect(t).toMatch(/he: 1 translated string changed in the master since translation\n +c\d+:L\d+ +Main > Title: was "Summer sale", now "Winter sale"; translation "מבצע קיץ"/);
    expect(t).toMatch(/fr: 1 translated string changed/);
    // the import says so too (a warning: the translation may be stale)
    const imp = text(await runLocalize({ action: "import", file: csv, languages: ["fr"], allowUntranslated: true }));
    expect(imp).toMatch(/Main > Title: warning: the master text changed since export: translated from "Summer sale", the master now says "Winter sale"/);
    title.value.text = "Summer sale";
    expect(text(await runLocalize({ action: "drift", file: csv })).split("\n")[0]).toBe("NO DRIFT (5 strings unchanged since export)");
  });

  it("refuses to build over comps with the same names; overwrite: true replaces them; dry run changes nothing", async () => {
    translate(csv, { [ids.Title]: { fr: "Soldes" } });
    const dry = await runLocalize({ action: "import", file: csv, languages: ["fr"], allowUntranslated: true, dryRun: true });
    expect(text(dry)).toMatch(/^Dry run: the file fits the comp tree; nothing was changed\.\n1 language of "Main" from main\.csv: fr/);
    expect(text(dry)).toMatch(/fr: 1 string translated, 4 not; copies: "Main \[fr\]" in folder "Main - fr"/);
    expect(fake.writes).toEqual([]);
    await runLocalize({ action: "import", file: csv, languages: ["fr"], allowUntranslated: true });
    const again = await runLocalize({ action: "import", file: csv, languages: ["fr"], allowUntranslated: true });
    expect(again.isError).toBe(true);
    expect(text(again)).toMatch(/already in the project: "Main \[fr\]" .*overwrite: true/);
    const n = fake.items.filter((i: any) => i.name === "Main [fr]").length;
    const over = await runLocalize({ action: "import", file: csv, languages: ["fr"], allowUntranslated: true, overwrite: true });
    expect(over.isError).toBeFalsy();
    expect(fake.items.filter((i: any) => i.name === "Main [fr]").length).toBe(n);
  });

  it("an After Effects without the direction API (before 24.0): Hebrew FAILs with what to set by hand", async () => {
    fake = fakeProject(project({ noRtlApi: true }));
    translate(csv, { [ids.Title]: { he: "מבצע" } });
    const t = text(await runLocalize({ action: "import", file: csv, languages: ["he"], fonts: { he: { "*": "ArialHebrew" } }, allowUntranslated: true }));
    expect(t).toMatch(/Main > Title: the paragraph direction can't be set from scripts in this After Effects \(needs 24\.0\+\)/);
    // the alignment is still mirrored
    expect(doc(comp("Main [he]"), "Title").justification).toBe(7414);
  });

  it("a file from another copy of the project matches by comp and layer name", async () => {
    translate(csv, { [ids.Title]: { fr: "Soldes" } });
    fake = fakeProject(project({ comps: [{ name: "Spacer", layers: [] }, ...project().comps] }));
    const t = text(await runLocalize({ action: "import", file: csv, languages: ["fr"], allowUntranslated: true }));
    expect(t).toMatch(/strings? matched by comp and layer name/);
    expect(doc(comp("Main [fr]"), "Title").text).toBe("Soldes");
  });
});
