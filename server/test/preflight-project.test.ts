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
    expect(cut).toContain("safeAreas (20, showing 5)");
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
    expect(r.skipped).toContain("text.glyphs: not available in this After Effects (needs 25.1 or later)");
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

// ---------- the tool ----------

const fake = vi.hoisted(() => ({ fp: null as any, file: null as any }));
vi.mock("../src/jsx.js", async (orig) => ({
  ...(await orig<typeof import("../src/jsx.js")>()),
  runJsx: async (body: string, args: any) => fake.fp.run(body, args),
}));
vi.mock("../src/preflight/media.js", () => ({
  checkFile: async () => {
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
    fake.fp = null;
    fake.file = null;
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
      skipped: ["flash: no ffmpeg"],
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

  it("file checks that can't run: an error for target file, a warning for both", async () => {
    fake.fp = fakeProject(DELIVERY);
    const { fileURLToPath } = await import("node:url");
    const file = fileURLToPath(import.meta.url);
    const r1 = await callTool({ spec: {}, target: "file", file });
    expect(r1.isError).toBe(true);
    expect(r1.content[0].text).toBe("The file checks could not run: no ffmpeg");
    const r2 = await callTool({ spec: {}, target: "both", file });
    expect(r2.content[0].text.split("\n")[0]).toBe("WARNINGS (1)");
    expect((await callTool({ spec: {}, target: "file" })).content[0].text).toMatch(/needs file/);
    expect((await callTool({ spec: { video: { widht: 1 } } })).content[0].text).toMatch(/video/);
  });
});
