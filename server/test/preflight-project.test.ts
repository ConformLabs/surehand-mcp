import { afterEach, describe, expect, it, vi } from "vitest";
import {
  areaBox,
  boundsThrough,
  checkFromXray,
  checkItems,
  checkVideo,
  jsxArgs,
  layerMatrix,
  apply,
  overshoot,
  PREFLIGHT_JSX,
  projectChecks,
  readChars,
  runsOf,
  sidesText,
  verticalScale,
  wildcard,
  type PData,
  type PLevel,
} from "../src/preflight/project.js";
import { formatAt, formatReport, timecode, verdict } from "../src/preflight/report.js";
import { loadSpec, type Finding } from "../src/preflight/spec.js";
import { XRAY_JSX } from "../src/tools/xray.js";
import { fakeProject, type FakeProjectSpec } from "./fake-ae.js";

const lv = (a: number[], p: number[], s: number[] = [100, 100], r = 0): PLevel => ({ n: "L", a, p, s, r });
const close = (b: any, e: any) => {
  for (const k of ["x0", "y0", "x1", "y1"]) expect(b[k]).toBeCloseTo(e[k], 6);
};

describe("bounds through the transform chain", () => {
  it("position and anchor", () => {
    close(boundsThrough([0, 0, 100, 50], [lv([0, 0], [100, 200])], 0), { x0: 100, y0: 200, x1: 200, y1: 250 });
    close(boundsThrough([0, 0, 100, 50], [lv([50, 25], [960, 540])], 0), { x0: 910, y0: 515, x1: 1010, y1: 565 });
  });
  it("scale around the anchor, non-uniform and negative (flipped)", () => {
    close(boundsThrough([0, 0, 100, 50], [lv([50, 25], [960, 540], [200, 200])], 0), { x0: 860, y0: 490, x1: 1060, y1: 590 });
    close(boundsThrough([0, 0, 100, 50], [lv([0, 0], [0, 0], [50, 300])], 0), { x0: 0, y0: 0, x1: 50, y1: 150 });
    close(boundsThrough([0, 0, 100, 50], [lv([0, 0], [500, 500], [-100, 100])], 0), { x0: 400, y0: 500, x1: 500, y1: 550 });
  });
  it("rotation is clockwise on screen (y down), around the anchor", () => {
    // (100,0) -> (0,100): a point to the right of the anchor ends up below it
    expect(apply(layerMatrix([0, 0], [0, 0], [100, 100], 90), [100, 0]).map((v) => Math.round(v))).toEqual([0, 100]);
    close(boundsThrough([0, 0, 100, 50], [lv([0, 0], [0, 0], [100, 100], 90)], 0), { x0: -50, y0: 0, x1: 0, y1: 100 });
    // 45 degrees around the center of a 100x100 square: a diamond 141 px across
    const b = boundsThrough([0, 0, 100, 100], [lv([50, 50], [500, 500], [100, 100], 45)], 0)!;
    expect(b.x1 - b.x0).toBeCloseTo(100 * Math.SQRT2, 6);
    expect((b.x0 + b.x1) / 2).toBeCloseTo(500, 6);
  });
  it("parent chain: the child's position is in the parent's layer space", () => {
    const child = lv([0, 0], [100, 0]), parent = lv([0, 0], [500, 500], [50, 50]);
    close(boundsThrough([0, 0, 100, 100], [child, parent], 0), { x0: 550, y0: 500, x1: 600, y1: 550 });
    // a rotated parent swings the child around the parent's anchor
    const b = boundsThrough([0, 0, 10, 10], [lv([0, 0], [100, 0]), lv([0, 0], [500, 500], [100, 100], 90)], 0)!;
    close(b, { x0: 490, y0: 600, x1: 500, y1: 610 });
  });
  it("animated tracks pick the value of the sample", () => {
    const moving: PLevel = { n: "L", a: [0, 0], p: { v: [[0, 0], [10, 0], [20, 0]] }, s: [100, 100], r: 0 };
    expect(boundsThrough([0, 0, 1, 1], [moving], 2)!.x0).toBe(20);
  });
  it("a precomp clips its content to its frame, unless nothing is left", () => {
    const levels = [lv([0, 0], [150, 150]), { clip: [200, 200] as [number, number] }, lv([0, 0], [1000, 0], [50, 50])];
    close(boundsThrough([0, 0, 100, 100], levels, 0)!, { x0: 1075, y0: 75, x1: 1100, y1: 100 });
    expect(boundsThrough([0, 0, 10, 10], [lv([0, 0], [300, 300]), { clip: [200, 200] }], 0)).toBeNull();
    expect(boundsThrough([0, 0, 0, 0], [lv([0, 0], [0, 0])], 0)).toBeNull();
  });
  it("vertical scale through the chain (for cap height)", () => {
    expect(verticalScale([lv([0, 0], [0, 0], [100, 50]), lv([0, 0], [0, 0], [200, 200], 30)], 0)).toBeCloseTo(1, 6);
  });
});

describe("violations over time", () => {
  it("overshoot per side, and the side text", () => {
    const area = areaBox(1920, 1080, { x: 0.1, y: 0.1 });
    expect(area).toEqual({ x0: 192, y0: 108, x1: 1728, y1: 972 });
    const o = overshoot({ x0: 150, y0: 200, x1: 1774, y1: 1000 }, area);
    expect(o).toEqual({ left: 42, right: 46, top: 0, bottom: 28 });
    expect(sidesText(o)).toBe("on the left, right and bottom");
    expect(sidesText({ left: 0, right: 46, top: 0, bottom: 0 })).toBe("on the right");
  });
  it("runs end at good samples and at gaps where the layer isn't visible", () => {
    const s = [1, 2, 3, 5, 6, 8, 9].map((i) => ({ i, value: i === 8 ? null : i * 10 }));
    expect(runsOf(s, Math.max)).toEqual([
      { i0: 1, i1: 3, worst: 30 },
      { i0: 5, i1: 6, worst: 60 },
      { i0: 9, i1: 9, worst: 90 },
    ]);
  });
  it("wildcards match whole names", () => {
    const re = new RegExp(wildcard("Logo*"));
    expect(re.test("Logo bug")).toBe(true);
    expect(re.test("Old Logo")).toBe(false);
    expect(new RegExp(wildcard("a.b (1)")).test("a.b (1)")).toBe(true);
    expect(new RegExp(wildcard("a.b")).test("axb")).toBe(false);
  });
});

const comp: PData["comp"] = { id: 1, name: "Main", w: 1920, h: 1080, fps: 25, dur: 30, par: 1, fd: 0.04 };

describe("video and duration", () => {
  it("size, frame rate, pixel aspect", () => {
    const f = checkVideo(loadSpec({ video: { width: 1920, height: 1080, frameRate: 29.97, pixelAspect: 1 } }), { ...comp, fps: 25 });
    expect(f.map((x) => x.check)).toEqual(["video.frameRate"]);
    expect(f[0].message).toBe("comp frame rate is 25 fps; the spec asks for 29.97 fps");
    // AE's 29.97 is 29.97002997...
    expect(checkVideo(loadSpec({ video: { frameRate: 29.97 } }), { ...comp, fps: 30000 / 1001 })).toEqual([]);
    expect(checkVideo(loadSpec({ video: { width: 3840 } }), comp)[0].message).toBe("comp is 1920x1080; the spec asks for 3840x1080");
  });
  it("exact duration in frames, with a tolerance", () => {
    expect(checkVideo(loadSpec({ video: { duration: 30 } }), comp)).toEqual([]);
    const f = checkVideo(loadSpec({ video: { duration: 30 } }), { ...comp, dur: 30.08 });
    expect(f[0].message).toBe("comp is 30.08 s (752 frames); the spec asks for 30 s (750 frames), over by 2 frames");
    expect(checkVideo(loadSpec({ video: { duration: 30, durationToleranceFrames: 2 } }), { ...comp, dur: 30.08 })).toEqual([]);
  });
  it("duration ranges", () => {
    expect(checkVideo(loadSpec({ video: { duration: { min: 29.5, max: 30 } } }), comp)).toEqual([]);
    expect(checkVideo(loadSpec({ video: { duration: { min: 31 } } }), comp)[0].message).toBe("comp is 30 s (750 frames); the spec asks for 31–any s");
    expect(checkVideo(loadSpec({ video: { duration: { max: 20 } } }), comp)).toHaveLength(1);
  });
});

describe("reading speed and time on screen", () => {
  const data = (i: number[], tc: PData["items"][number]["tc"]): PData => ({ v: 1, comp, project: {}, step: 1, n: 750, feat: {}, items: [{ n: "Sub", w: "Main > 1: Sub", t: 1, i, tc }] });
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => a + k);
  it("characters per second per text shown, line breaks don't count", () => {
    expect(readChars("Hello,\rworld")).toBe(11);
    // 50 frames = 2 s; 40 characters -> 20 cps
    const text = "This line has exactly forty characters!!";
    expect(text.length).toBe(40);
    const r = checkItems(loadSpec({ text: { maxCharsPerSecond: 17, minOnScreenSeconds: 1 } }), data(range(25, 74), [[0, text, 50, null]]));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ check: "text.readingSpeed", at: [1, 2.96], where: "Main > 1: Sub" });
    expect(r.findings[0].message).toContain("40 characters in 2 s = 20 characters/s (maximum 17)");
  });
  it("a text that changes is checked per text; a gap splits it", () => {
    const r = checkItems(loadSpec({ text: { minOnScreenSeconds: 1 } }), data([...range(0, 49), ...range(60, 69)], [[0, "First", 50, null], [30, "Second", 50, null]]));
    // "First" 30 frames = 1.2 s ok; "Second" 20 frames + 10 frames after the gap: 0.8 s and 0.4 s
    expect(r.findings.map((f) => [f.at, f.message])).toEqual([
      [[1.2, 1.96], '"Second" is visible for 0.8 s (minimum 1 s)'],
      [[2.4, 2.76], '"Second" is visible for 0.4 s (minimum 1 s)'],
    ]);
  });
});

describe("the report", () => {
  it("timecode, also drop-frame", () => {
    expect(timecode(2.12, 25)).toBe("00:00:02:03");
    expect(timecode(3661.5, 25)).toBe("01:01:01:12");
    expect(timecode(0, 25, false, 3600)).toBe("01:00:00:00");
    // 29.97 drop-frame: frame 1800 is 00;01;00;02 (frames 0 and 1 of minute 1 are skipped)
    expect(timecode(1800 / (30000 / 1001), 30000 / 1001, true)).toBe("00;01;00;02");
    expect(timecode(17982 / (30000 / 1001), 30000 / 1001, true)).toBe("00;10;00;00");
    expect(timecode(1800 / (30000 / 1001), 30000 / 1001, false)).toBe("00:01:00:00");
    expect(formatAt([2.12, 3.4], { fps: 25 })).toBe("00:00:02:03–00:00:03:10 (2.12s–3.40s)");
    expect(formatAt(1, undefined)).toBe("1.00s");
  });
  it("verdict", () => {
    const f = (severity: Finding["severity"]): Finding => ({ check: "x", severity, message: "m" });
    expect(verdict([])).toBe("PASS");
    expect(verdict([f("info")])).toBe("PASS");
    expect(verdict([f("warn"), f("warn")])).toBe("WARNINGS (2)");
    expect(verdict([f("warn"), f("fail")])).toBe("FAIL (1)");
    // a requested check that didn't run: never PASS (and never WARNINGS alone)
    const nr = [{ check: "legalRange", reason: "RGB" }, { check: "loudness.truePeak", reason: "not read" }, { check: "legalRange", reason: "again" }];
    expect(verdict([], nr)).toBe("INCOMPLETE (2 checks not run)");
    expect(verdict([f("warn")], nr.slice(0, 1))).toBe("INCOMPLETE (1 check not run, 1 warning)");
    expect(verdict([f("fail")], nr)).toBe("FAIL (1)");
  });
  it("requested checks that didn't run come right under the verdict, one line per reason", () => {
    const text = formatReport({ title: "t", findings: [], notRun: [{ check: "black", reason: "no ffmpeg" }, { check: "flash", reason: "no ffmpeg" }, { check: "legalRange", reason: "the file is RGB" }] });
    expect(text.split("\n").slice(0, 6)).toEqual(["INCOMPLETE (3 checks not run)", "t", "", "requested but NOT checked", "  - black, flash: no ffmpeg", "  - legalRange: the file is RGB"]);
  });
  it("a cut list keeps the failures: fails first, counts by severity in the header", () => {
    const list: Finding[] = [
      ...Array.from({ length: 5 }, (_, k): Finding => ({ check: "text.onScreen", severity: "warn", at: k, message: `w${k}` })),
      { check: "text.glyphs", severity: "fail", at: 9, message: "the fail" },
      { check: "text.note", severity: "info", message: "i" },
    ];
    const text = formatReport({ title: "t", findings: list, maxFindings: 3 });
    const lines = text.split("\n");
    expect(lines).toContain("text (7: 1 fail, 5 warnings, 1 note; showing 3)");
    expect(lines[lines.indexOf("text (7: 1 fail, 5 warnings, 1 note; showing 3)") + 1]).toBe("  FAIL  9.00s the fail");
    // even when the overall limit is used up by an earlier group, a group with failures shows one
    const two = formatReport({ title: "t", findings: [...Array.from({ length: 5 }, (_, k): Finding => ({ check: "video.x", severity: "warn", message: `v${k}` })), { check: "text.glyphs", severity: "fail", message: "late fail" }], maxFindings: 3 });
    expect(two).toContain("text (1)\n  FAIL late fail");
  });
  it("groups by check, sorted by time, with fixes, skipped and notes; maxFindings cuts per group", () => {
    const findings: Finding[] = [
      { check: "text.readingSpeed", severity: "fail", at: [5, 6], where: "Main > 2: Sub", message: "too fast" },
      { check: "safeAreas.title", severity: "fail", at: [2.12, 3.4], where: "Main > 3: Title", message: "outside title-safe by up to 46 px on the right", fix: "move it" },
      { check: "safeAreas.title", severity: "fail", at: 1, where: "Main > 4: Logo", message: "outside" },
      { check: "video.frameRate", severity: "fail", where: "Main", message: "comp frame rate is 29.97 fps; the spec asks for 25 fps" },
      { check: "black", severity: "warn", at: 0, message: "black at the start" },
    ];
    const text = formatReport({ title: 'Preflight against "Spec": comp "Main"', findings, timeBase: { fps: 25 }, skipped: ["audio: no ffmpeg"], notes: ["n1"], probe: { codec: "prores", size: [1920, 1080] } });
    expect(text).toBe(
      [
        "FAIL (4)",
        'Preflight against "Spec": comp "Main"',
        "",
        "video (1)",
        "  FAIL  Main: comp frame rate is 29.97 fps; the spec asks for 25 fps",
        "",
        "safeAreas (2)",
        "  FAIL  00:00:01:00 (1.00s)  Main > 4: Logo: outside",
        "  FAIL  00:00:02:03–00:00:03:10 (2.12s–3.40s)  Main > 3: Title: outside title-safe by up to 46 px on the right",
        "        fix: move it",
        "",
        "text (1)",
        "  FAIL  00:00:05:00–00:00:06:00 (5.00s–6.00s)  Main > 2: Sub: too fast",
        "",
        "black (1)",
        "  WARN  00:00:00:00 (0.00s) black at the start",
        "",
        "file",
        '  codec: prores; size: [1920,1080]',
        "",
        "not checked",
        "  - audio: no ffmpeg",
        "",
        "notes",
        "  - n1",
      ].join("\n"),
    );
    const many = Array.from({ length: 20 }, (_, k): Finding => ({ check: "safeAreas.title", severity: "fail", at: k, message: `m${k}` }));
    const cut = formatReport({ title: "t", findings: many, maxFindings: 5 });
    expect(cut).toContain("safeAreas (20 fails; showing 5)");
    expect(cut).toContain("... 15 more (raise maxFindings to see them)");
    expect(cut.split("\n")[0]).toBe("FAIL (20)");
  });
});

// ---------- the real JSX on a fake After Effects ----------

const DELIVERY: FakeProjectSpec = {
  fonts: [{ postScriptName: "Gotham-Bold", familyName: "Gotham", styleName: "Bold", isSubstitute: false }],
  footage: [{ name: "logo.png", file: "/f/logo.png", width: 200, height: 100, still: true }],
  comps: [
    {
      name: "Main", fps: 25, duration: 4,
      layers: [
        // drifts right: its right edge (x + 400) passes title-safe (1728) after 3.28 s
        { name: "Title", type: "text", anchor: [0, 0], anim: { "ADBE Position": (t) => [1000 + 100 * t, 540] } },
        // 37 characters for 0.6 s
        { name: "Sub", type: "text", text: "Hello there, how are you doing today?", inPoint: 1, outPoint: 1.6, position: [600, 900] },
        { name: "Lower", type: "precomp", source: "Lower", anchor: [960, 540], position: [960, 540] },
        { name: "Logo bug", type: "footage", source: "logo.png", position: [1850, 60] },
        { name: "Hidden", type: "text", opacity: 0, position: [-100, -100] },
        { name: "Spin", type: "text", threeD: true, font: "Gotham-Bold" },
      ],
    },
    { name: "Lower", fps: 25, duration: 4, layers: [{ name: "Name", type: "text", position: [1500, 1000], inPoint: 2 }] },
  ],
  activeComp: "Main",
};
const SPEC = loadSpec({
  video: { frameRate: 25, width: 1920 },
  safeAreas: { title: 0.1, action: 0.05, layersMustBeIn: [{ layer: "Logo*", area: "action" }] },
  text: { maxCharsPerSecond: 17, minOnScreenSeconds: 1, minCapHeightPx: 30, glyphs: true },
  project: { noMissingFonts: true },
});

describe("preflight JSX (fake After Effects)", () => {
  it("is ES3 (ExtendScript)", async () => {
    const { parse } = await import("acorn");
    expect(() => parse(`(function(args, log){${PREFLIGHT_JSX}\n})`, { ecmaVersion: 3, allowReserved: false })).not.toThrow();
    expect(() => parse(`(function(args, log){${XRAY_JSX}\n})`, { ecmaVersion: 3, allowReserved: false })).not.toThrow();
  });

  it("reads only: no writes, no undo group", () => {
    const fp = fakeProject(DELIVERY);
    const r = fp.run(PREFLIGHT_JSX, jsxArgs(SPEC) as any);
    expect(r.ok).toBe(true);
    expect(fp.writes).toEqual([]);
    expect(fp.calls.filter((c: string) => /UndoGroup|executeCommand/.test(c))).toEqual([]);
  });

  it("finds a title drifting out of title-safe, a fast subtitle, text in a precomp, a logo outside action-safe, a 3D layer", () => {
    const fp = fakeProject(DELIVERY);
    const d = JSON.parse(fp.run(PREFLIGHT_JSX, jsxArgs(SPEC) as any).result) as PData;
    expect(d.comp).toMatchObject({ name: "Main", w: 1920, h: 1080, fps: 25 });
    expect(d.n).toBe(100);
    expect(d.items.map((i) => i.w)).toEqual(["Main > 1: Title", "Main > 2: Sub", "Main > 3: Lower > 1: Name", "Main > 4: Logo bug", "Main > 5: Hidden", "Main > 6: Spin"]);
    // only the animated position is sent per sample; the rest are constants
    const title = d.items[0];
    expect(title.i).toHaveLength(100);
    expect((title.lv![0] as PLevel).p).toHaveProperty("v");
    expect((title.lv![0] as PLevel).s).toEqual([100, 100]);
    expect(title.rect).toEqual([0, -50, 400, 60]);
    expect(d.items[4].i).toEqual([]); // opacity 0: never visible
    expect(d.items[5].d3).toBe(1);

    const r = projectChecks(SPEC, d);
    const by = (check: string) => r.findings.filter((f) => f.check === check);
    const safe = by("safeAreas.title");
    expect(safe.find((f) => f.where === "Main > 1: Title")).toMatchObject({ at: [3.32, 3.96], message: "outside title-safe by up to 68 px on the right" });
    // the precomp's text, through the precomp layer, from 2 s (its in point)
    expect(safe.find((f) => f.where === "Main > 3: Lower > 1: Name")).toMatchObject({ at: [2, 3.96], message: "outside title-safe by up to 172 px on the right and bottom" });
    expect(by("safeAreas.action")).toEqual([expect.objectContaining({ where: "Main > 4: Logo bug", at: [0, 3.96], message: "outside action-safe by up to 226 px on the right" })]);
    expect(by("safeAreas.3d")).toEqual([expect.objectContaining({ where: "Main > 6: Spin", severity: "warn" })]);
    expect(by("text.readingSpeed")).toEqual([expect.objectContaining({ where: "Main > 2: Sub", at: [1, 1.56] })]);
    expect(by("text.readingSpeed")[0].message).toContain("37 characters in 0.6 s = 61.7 characters/s");
    expect(by("text.onScreen")).toHaveLength(1);
    // 50 px font x 0.7 = 35 px cap height: above 30
    expect(by("text.capHeight")).toEqual([]);
    expect(r.notRun).toContainEqual({ check: "text.glyphs", reason: "not available in this After Effects (needs 25.1 or later)" });
    expect(r.findings.filter((f) => f.check.startsWith("video"))).toEqual([]);
  });

  it("cap height, glyphs, box overflow, every Nth frame", () => {
    const fp = fakeProject({
      comps: [{ name: "Main", fps: 25, duration: 2, layers: [{ name: "Small", type: "text", text: "Ab→", fontSize: 40, scale: [50, 50], glyphsMissing: "→", boxOverflow: true, position: [600, 500] }] }],
      activeComp: "Main",
    });
    const spec = loadSpec({ safeAreas: { title: 0.1, sampleEveryFrames: 5 }, text: { minCapHeightPx: 20, glyphs: true, noOverflow: true } });
    const d = JSON.parse(fp.run(PREFLIGHT_JSX, jsxArgs(spec) as any).result) as PData;
    expect(d.step).toBe(5);
    expect(d.n).toBe(10);
    const r = checkItems(spec, d);
    expect(r.findings.map((f) => [f.check, f.at, f.message])).toEqual([
      ["text.capHeight", [0, 1.8], "cap height about 14 px (minimum 20 px)"],
      ["text.overflow", [0, 1.8], "paragraph text overflows its box (some text is cut off)"],
      ["text.glyphs", undefined, 'font ArialMT has no glyph for "→"'],
    ]);
    expect(r.notes.join("\n")).toContain("every 5th frame checked");
  });

  it("stops at the time budget and says so", () => {
    const fp = fakeProject(DELIVERY);
    const d = JSON.parse(fp.run(PREFLIGHT_JSX, { ...jsxArgs(SPEC), timeBudgetSeconds: -1 } as any).result) as PData;
    expect(d.partial?.reason).toMatch(/time budget/);
    const r = checkItems(SPEC, d);
    expect(r.findings.find((f) => f.check === "preflight.partial")?.severity).toBe("warn");
  });

  it("missing font, footage, effects, expression errors and disabled layers with effects, from X-ray's collector", () => {
    const fp = fakeProject({
      installedEffects: [{ matchName: "ADBE Gaussian Blur 2", displayName: "Gaussian Blur" }],
      fonts: [{ postScriptName: "Gotham-Bold", familyName: "Gotham", styleName: "Bold", isSubstitute: false }],
      footage: [{ name: "plate.mov", file: "/f/plate.mov", missing: true }, { name: "unused.mov", file: "/f/u.mov", missing: true }],
      comps: [
        {
          name: "Main",
          layers: [
            { name: "Title", type: "text", font: "Gotham-Bold", expressions: { "Transform/Opacity": { expr: "x", error: "x is not defined" } } },
            { name: "Plate", type: "footage", source: "plate.mov" },
            { name: "Old FX", type: "solid", enabled: false, effects: [{ matchName: "ADBE Gaussian Blur 2", name: "Gaussian Blur" }, { matchName: "tc Particular", name: "Particular" }] },
          ],
        },
      ],
      activeComp: "Main",
    });
    const x = JSON.parse(fp.run(XRAY_JSX, { sections: ["missing", "expressions"], comps: ["Main"] }).result);
    const spec = loadSpec({ project: { noMissingFootage: true, noMissingFonts: true, noMissingEffects: true, noExpressionErrors: true, noDisabledLayersWithEffects: true } });
    const r = checkFromXray(spec, x);
    expect(r.findings.map((f) => [f.check, f.where, f.message])).toEqual([
      ["project.missingFootage", "Main > 2: Plate", 'missing footage "plate.mov" (/f/plate.mov)'],
      ["project.missingEffects", "Main > 3: Old FX", 'effect "Particular" (tc Particular) is not installed: it renders nothing'],
      ["project.missingFonts", "Main > 1: Title", "font Gotham-Bold (Gotham Bold) is missing"],
      ["project.expressionErrors", "Main > 1: Title > Transform/Opacity", "expression error: x is not defined"],
      ["project.disabledLayersWithEffects", "Main > 3: Old FX", "disabled layer with 2 effects (Gaussian Blur, Particular)"],
    ]);
    expect(fp.writes).toEqual([]);
  });
});

describe("review fixes: what must not pass silently", () => {
  it("a layersMustBeIn name that matches no layer is a warning; one that is never visible is a note", () => {
    const fp = fakeProject({ comps: [{ name: "Main", fps: 25, duration: 1, layers: [{ name: "Logo off", type: "solid", enabled: false }] }], activeComp: "Main" });
    const spec = loadSpec({ safeAreas: { action: 0.05, layersMustBeIn: [{ layer: "Logo*", area: "action" }, { layer: "Bug", area: "action" }] } });
    const d = JSON.parse(fp.run(PREFLIGHT_JSX, jsxArgs(spec) as any).result) as PData;
    const r = checkItems(spec, d);
    expect(r.findings).toEqual([expect.objectContaining({ check: "safeAreas.layersMustBeIn", severity: "warn", message: 'no layer named "Bug" in comp "Main"' })]);
    expect(r.notes).toContain('safeAreas.layersMustBeIn "Logo*": the matching layers in Main are never visible');
    // the default text area (title) without a title margin: a note, not a check that didn't run
    expect(r.notRun).toEqual([]);
    expect(checkItems(loadSpec({ safeAreas: { action: 0.05, textMustBeIn: "title" } }), d).notRun).toEqual([{ check: "safeAreas.textMustBeIn", reason: '"title" has no margin in the spec (add safeAreas.title)' }]);
  });

  it("auto-orient and pixel-moving effects warn that the bounds may be off; an unreadable 3D switch counts as 3D", () => {
    const fp = fakeProject({
      comps: [
        {
          name: "Main", fps: 25, duration: 1,
          layers: [
            { name: "Orient", type: "text", autoOrient: true, position: [600, 500] },
            { name: "Shifted", type: "text", position: [600, 500], effects: [{ matchName: "ADBE Geometry2", name: "Transform" }] },
            { name: "Unknown", type: "text", threeDThrows: true, position: [600, 500] },
            { name: "Plain", type: "text", position: [600, 500], effects: [{ matchName: "ADBE Offset", name: "Offset", enabled: false }] },
          ],
        },
      ],
      activeComp: "Main",
    });
    const spec = loadSpec({ safeAreas: { title: 0.1 } });
    const d = JSON.parse(fp.run(PREFLIGHT_JSX, jsxArgs(spec) as any).result) as PData;
    const r = checkItems(spec, d);
    expect(r.findings.map((f) => [f.check, f.severity, f.where])).toEqual([
      ["safeAreas.autoOrient", "warn", "Main > 1: Orient"],
      ["safeAreas.bounds", "warn", "Main > 2: Shifted"],
      ["safeAreas.3d", "warn", "Main > 3: Unknown"],
    ]);
    expect(r.findings[1].message).toBe("bounds may be off: Shifted: Transform effect moves or scales the pixels, which isn't included in the layer's box");
    expect(verdict(r.findings, r.notRun)).toBe("WARNINGS (3)");
  });

  it("glyphs are checked per character against its own font (style runs)", () => {
    const fp = fakeProject({
      comps: [{ name: "Main", fps: 25, duration: 1, layers: [{ name: "Mixed", type: "text", text: "A→Ω", font: "Main-Regular", glyphsMissing: "", charFonts: [{ font: "Main-Regular" }, { font: "Main-Regular", missing: "→" }, { font: "Greek-Bold", missing: "Ω" }] }] }],
      activeComp: "Main",
    });
    const spec = loadSpec({ text: { glyphs: true } });
    const d = JSON.parse(fp.run(PREFLIGHT_JSX, jsxArgs(spec) as any).result) as PData;
    const r = checkItems(spec, d);
    expect(r.findings.map((f) => f.message)).toEqual(['font Main-Regular has no glyph for "→"', 'font Greek-Bold has no glyph for "Ω"']);
    expect(r.notes.join("\n")).not.toMatch(/first character's font/);
  });

  it("missing fonts from AE's used-fonts list: style runs / keyframes in the delivered comp fail, unplaced ones warn", () => {
    const base: FakeProjectSpec = {
      fonts: [{ postScriptName: "Gotham-Bold", familyName: "Gotham", styleName: "Bold", isSubstitute: false }],
      comps: [{ name: "Main", layers: [{ name: "Title", type: "text", font: "ArialMT" }] }, { name: "Elsewhere", layers: [{ name: "Other", type: "text", font: "ArialMT" }] }],
      activeComp: "Main",
    };
    const spec = loadSpec({ project: { noMissingFonts: true } });
    const run = (p: FakeProjectSpec) => checkFromXray(spec, JSON.parse(fakeProject(p).run(XRAY_JSX, { sections: ["missing"], comps: ["Main"] }).result));
    // the layer's font at the current time is fine, but a style run uses the missing font
    const placed = run({ ...base, usedFonts: [{ ps: "Gotham-Bold", layers: ["Title"] }] });
    expect(placed.findings).toEqual([expect.objectContaining({ check: "project.missingFonts", severity: "fail", where: "Main > 1: Title" })]);
    // used only outside the delivered comp: not this delivery's problem
    expect(run({ ...base, usedFonts: [{ ps: "Gotham-Bold", layers: ["Other"] }] }).findings).toEqual([]);
    // this AE doesn't say where: a warning, never silence
    const unplaced = run({ ...base, usedFonts: [{ ps: "Gotham-Bold", layers: ["Title"], noIds: true }] });
    expect(unplaced.findings).toEqual([expect.objectContaining({ check: "project.missingFonts", severity: "warn" })]);
    // no font API: not run
    expect(run({ ...base, fonts: null }).notRun).toEqual([{ check: "project.noMissingFonts", reason: expect.stringMatching(/24\.0/) }]);
  });

  it("an X-ray read cut short by its budget is a warning, like the frame scan", () => {
    const x = JSON.parse(fakeProject(DELIVERY).run(XRAY_JSX, { sections: ["missing"], comps: ["Main"] }).result);
    x.partial = { reason: "time budget (90 s) used up" };
    const r = checkFromXray(loadSpec({ project: { noMissingFootage: true } }), x);
    expect(r.findings).toEqual([expect.objectContaining({ check: "project.partial", severity: "warn" })]);
  });

  it("a working space this AE doesn't report is not run", () => {
    const d: PData = { v: 1, comp, project: {}, step: 1, n: 1, feat: {}, items: [] };
    expect(projectChecks(loadSpec({ project: { workingSpace: "sRGB" } }), d).notRun).toEqual([{ check: "project.workingSpace", reason: "this After Effects doesn't report the working space to scripts" }]);
  });
});

describe("ae_get_layer_info on text and shape layers (not AVLayers in After Effects)", () => {
  it("has the 3D switch, blending mode, track matte and collapse fields", () => {
    const fp = fakeProject({ comps: [{ name: "Main", layers: [{ name: "T", type: "text", threeD: true }, { name: "S", type: "shape", collapse: true }] }], activeComp: "Main" });
    const info = (i: number) => JSON.parse(fp.run(`return aemcp.stringify(aemcp.layerInfo(aemcp.findComp("Main").layer(${i}), false));`, {}).result);
    expect(info(1)).toMatchObject({ type: "text", threeD: true, blendingMode: "NORMAL", trackMatteType: "NO_TRACK_MATTE", collapseTransformation: false });
    expect(info(2)).toMatchObject({ type: "shape", threeD: false, blendingMode: "NORMAL", collapseTransformation: true });
  });
});

// ---------- the tool ----------

const fake = vi.hoisted(() => ({
  fp: null as any,
  file: null as any,
  /** the options ae_preflight passed to checkFile */
  opts: null as any,
  mode: "full" as "full" | "ask" | "read-only",
  /** runJsx calls with an approval request, and what the user answers */
  approvals: [] as any[],
  deny: false,
  xrayFails: false,
}));
vi.mock("../src/jsx.js", async (orig) => ({
  ...(await orig<typeof import("../src/jsx.js")>()),
  runJsx: async (body: string, args: any, opts: any) => {
    if (opts?.bridge?.approval) {
      fake.approvals.push(opts.bridge.approval);
      if (fake.deny) throw new Error("The change was denied in After Effects.");
      return { ok: true, result: "ok", logs: [] };
    }
    if (fake.xrayFails && /D\.fonts = null/.test(body)) return { ok: false, error: { message: "X-ray broke" }, logs: [] };
    return fake.fp.run(body, args);
  },
}));
vi.mock("../src/permissions.js", async (orig) => ({
  ...(await orig<typeof import("../src/permissions.js")>()),
  permissions: () => ({ mode: fake.mode, allowShell: true }),
}));
vi.mock("../src/preflight/media.js", () => ({
  checkFile: async (_path: string, _spec: unknown, opts: unknown) => {
    fake.opts = opts;
    if (!fake.file) throw new Error("no ffmpeg");
    return fake.file;
  },
}));

async function callTool(args: Record<string, unknown>) {
  const { registerPreflightTools } = await import("../src/tools/preflight.js");
  let handler: any;
  registerPreflightTools({ registerTool: (_n: string, _c: unknown, h: unknown) => void (handler = h) } as any);
  return handler(args, {});
}

describe("ae_preflight", () => {
  afterEach(() => {
    Object.assign(fake, { fp: null, file: null, opts: null, mode: "full", approvals: [], deny: false, xrayFails: false });
  });

  it("schema: the JSON schema and guidance with placeholders, no example values", async () => {
    const r = await callTool({ action: "schema" });
    const text: string = r.content[0].text;
    const schema = JSON.parse(text.slice(text.indexOf("JSON schema:\n") + 13));
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["video", "safeAreas", "text", "project", "audio", "flash"]));
    const shape = text.slice(text.indexOf("Shape"), text.indexOf("JSON schema:"));
    expect(shape).not.toMatch(/\d/);
    expect(text).toMatch(/not a certified PSE/);
  });

  it("project: verdict first, timecoded findings, what was skipped", async () => {
    fake.fp = fakeProject(DELIVERY);
    const r = await callTool({ spec: { ...SPEC, video: { frameRate: 30 }, legalRange: { luma: { min: 16, max: 235 } } } });
    const text: string = r.content[0].text;
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^FAIL \(\d+\)$/);
    expect(lines[1]).toBe('Preflight against the delivery spec: comp "Main" (1920x1080, 25 fps, 4 s)');
    expect(text).toContain("  FAIL  Main: comp frame rate is 25 fps; the spec asks for 30 fps");
    expect(text).toContain("  FAIL  00:00:03:08–00:00:03:24 (3.32s–3.96s)  Main > 1: Title: outside title-safe by up to 68 px on the right");
    expect(text).toContain('  - legalRange: checked on a rendered file (target "file" or "both" with file)');
    expect(text).toContain("  - not in the spec: black, frozen, audio, flash");
    expect(fake.fp.writes).toEqual([]);
  });

  it("file: findings and probe from checkFile, at most 4 thumbnails, failing ones first", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "pf-"));
    const png = (n: number) => {
      const p = join(dir, `t${n}.png`);
      writeFileSync(p, Buffer.from([n]));
      return p;
    };
    fake.file = {
      findings: [{ check: "legalRange", severity: "fail", at: [10, 11], message: "luma above 235" }],
      probe: { codec: "prores", frameRate: 25 },
      thumbnails: [0, 1, 2, 3, 4].map((n) => ({ at: n === 4 ? 10.5 : n, path: png(n), label: `t${n}` })),
      notRun: [{ check: "flash", reason: "no ffmpeg" }],
    };
    const file = png(9);
    const r = await callTool({ spec: { legalRange: { luma: { max: 235 } } }, target: "file", file });
    const text: string = r.content[0].text;
    expect(text.split("\n")[0]).toBe("FAIL (1)");
    expect(text).toContain("00:00:10:00–00:00:11:00 (10.00s–11.00s) luma above 235");
    expect(text).toContain("codec: prores; frameRate: 25");
    expect(text).toContain("  - flash: no ffmpeg");
    const images = r.content.filter((c: any) => c.type === "image");
    expect(images).toHaveLength(4);
    expect(r.content[2].text).toBe("t4 (10.5 s)");
  });

  it("file checks that can't run: an error for target file, INCOMPLETE for both", async () => {
    fake.fp = fakeProject(DELIVERY);
    const { fileURLToPath } = await import("node:url");
    const file = fileURLToPath(import.meta.url);
    const r1 = await callTool({ spec: {}, target: "file", file });
    expect(r1.isError).toBe(true);
    expect(r1.content[0].text).toBe("The file checks could not run: no ffmpeg");
    const r2 = await callTool({ spec: {}, target: "both", file });
    expect(r2.content[0].text.split("\n")[0]).toBe("INCOMPLETE (1 check not run)");
    expect(r2.content[0].text).toContain("  - file: the file checks could not run: no ffmpeg");
    expect((await callTool({ spec: {}, target: "file" })).content[0].text).toMatch(/needs file/);
    expect((await callTool({ spec: { video: { widht: 1 } } })).content[0].text).toMatch(/video/);
  });

  it("no ffmpeg: never PASS, one line for the skipped checks, and a hint to ask about the download", async () => {
    const { fileURLToPath } = await import("node:url");
    const why = "ffmpeg / ffprobe were not found, so the rendered file can't be checked.";
    fake.file = { findings: [], probe: {}, notRun: ["black", "flash", "legalRange"].map((check) => ({ check, reason: why })) };
    try {
      const r = await callTool({ spec: { black: { maxSeconds: 0.5 }, flash: { check: true } }, target: "file", file: fileURLToPath(import.meta.url) });
      const t: string = r.content[0].text;
      expect(t.split("\n")[0]).toBe("INCOMPLETE (3 checks not run)");
      expect(t).toMatch(/requested but NOT checked/);
      expect(t).toContain(`black, flash, legalRange: ${why}`);
      expect(t.split(why).length - 1).toBe(1);
      expect(t).toMatch(/allowFfmpegDownload: true/);
    } finally {
      fake.file = null;
    }
  });

  it("target project ignores a file argument (even one that doesn't exist) and says so", async () => {
    fake.fp = fakeProject(DELIVERY);
    const r = await callTool({ spec: { video: { frameRate: 25 } }, file: "/nonexistent/render.mov" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text.split("\n")[0]).toBe("PASS");
    expect(r.content[0].text).toContain('file /nonexistent/render.mov was not checked: target "project" checks the project only');
  });

  it("an X-ray read that fails: its checks are not run (INCOMPLETE), not passed", async () => {
    fake.fp = fakeProject(DELIVERY);
    fake.xrayFails = true;
    const r = await callTool({ spec: { project: { noMissingFootage: true, noExpressionErrors: true } } });
    const t: string = r.content[0].text;
    expect(t.split("\n")[0]).toBe("INCOMPLETE (2 checks not run)");
    expect(t).toContain("  - project.noMissingFootage, project.noExpressionErrors: the project could not be read: X-ray broke");
  });

  it("the ffmpeg download: refused in read-only mode, approved in After Effects in ask mode, the AI's flag in full mode", async () => {
    const { fileURLToPath } = await import("node:url");
    const file = fileURLToPath(import.meta.url);
    const build = { version: "9.0.2", publisher: "p", licence: "l", archives: [{ url: "https://x/ffmpeg.zip", sha256: "0".repeat(64), maxBytes: 1, programs: ["ffmpeg" as const] }] };
    fake.file = { findings: [], probe: {}, notRun: [{ check: "black", reason: "ffmpeg / ffprobe were not found" }] };

    fake.mode = "read-only";
    const ro = await callTool({ spec: { black: { maxSeconds: 1 } }, target: "file", file, allowFfmpegDownload: true });
    expect(fake.opts.allowDownload).toBe(false);
    expect(ro.content[0].text).toMatch(/read-only mode, which doesn't download programs/);
    expect(ro.content[0].text.split("\n")[0]).toBe("INCOMPLETE (1 check not run)");

    fake.mode = "ask";
    await callTool({ spec: { black: { maxSeconds: 1 } }, target: "file", file, allowFfmpegDownload: true });
    expect(fake.opts.allowDownload).toBe(true);
    await fake.opts.confirmDownload(build);
    expect(fake.approvals).toEqual([{ tool: "Download FFmpeg", summary: expect.stringMatching(/^Download FFmpeg 9\.0\.2 once into ~\/\.surehand\/ffmpeg[\s\S]*https:\/\/x\/ffmpeg\.zip/) }]);
    fake.deny = true;
    await expect(fake.opts.confirmDownload(build)).rejects.toThrow(/not approved in After Effects .*nothing was downloaded/);

    fake.mode = "full";
    await callTool({ spec: { black: { maxSeconds: 1 } }, target: "file", file, allowFfmpegDownload: true });
    expect(fake.opts).toMatchObject({ allowDownload: true, confirmDownload: undefined });
    await callTool({ spec: { black: { maxSeconds: 1 } }, target: "file", file });
    expect(fake.opts.allowDownload).toBe(false);
  });
});
