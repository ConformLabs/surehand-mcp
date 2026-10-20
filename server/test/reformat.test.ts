// ae_reformat: the planner (src/reformat/plan.ts) and the whole tool against a fake After Effects (test/fake-reformat.ts):
// the real tree reader, Preflight's reader and the apply script run on it, so a plan is checked on the comp it made.
import { afterEach, describe, expect, it, vi } from "vitest";
import { coverScale, decideJobs, fitScale, mergeIssues, residuals, rulesProblems, type Tree } from "../src/reformat/plan.js";
import { fakeReformatAE, type RComp } from "./fake-reformat.js";

const fake = vi.hoisted(() => ({ ae: null as any, calls: [] as any[], mode: "full" as string }));
vi.mock("../src/jsx.js", async (orig) => ({
  ...(await orig<typeof import("../src/jsx.js")>()),
  runJsx: async (body: string, args: any, opts: any) => {
    fake.calls.push({ body, args, opts });
    return fake.ae.run(body, args);
  },
}));

const { APPLY_JSX, TREE_JSX, runReformat } = await import("../src/tools/reformat.js");
const { PREFLIGHT_JSX } = await import("../src/preflight/project.js");

const text = (r: any) => r.content.map((c: any) => c.text).join("\n");
const reformat = (args: Record<string, unknown>, mode = "full") => runReformat({ width: 1080, height: 1920, name: "Main 9x16", ...args } as any, { mode });
const val = (p: any) => (p.numKeys ? p.keyValue(1) : p.value);

/** 16:9, 25 fps, 2 s: a full-frame background, a title, a logo, a lower element no rule names */
const SPOT: RComp = {
  name: "Main",
  layers: [
    { name: "Title", type: "text", rect: [0, -60, 800, 80], position: [700, 900], fontSize: 80 },
    { name: "Logo", rect: [0, 0, 200, 100], position: [1680, 40], source: "LogoArt", type: "footage" },
    { name: "Bug", rect: [0, 0, 100, 100], position: [910, 490] },
    { name: "BG", anchor: [960, 540], position: [960, 540] },
  ],
};

afterEach(() => {
  fake.ae = null;
  fake.calls = [];
});

describe("the planner's pieces", () => {
  it("cover and fit scale about the frame centre", () => {
    const full = { x0: 0, y0: 0, x1: 1920, y1: 1080 };
    expect(coverScale(full, [960, 540], [540, 960])).toBeCloseTo(1920 / 1080, 9);
    expect(fitScale(full, [960, 540], [540, 960])).toBeCloseTo(1080 / 1920, 9);
    // a box that doesn't reach the centre can't cover by scaling about it
    expect(coverScale({ x0: 1000, y0: 0, x1: 1920, y1: 1080 }, [960, 540], [540, 960])).toBeNull();
  });

  it("the rules need their margins from the user, and min <= max", () => {
    expect(rulesProblems({ safe: [{ layer: "T", area: "title" }], scale: [{ layer: "T", min: 80, max: 50 }] })).toEqual([
      'safe rule "T" uses title-safe: give safeAreas.title (the margin per side, from the user\'s delivery spec)',
      'scale rule "T": min 80 is above max 50',
    ]);
    expect(rulesProblems({ safe: [{ layer: "T", area: "frame" }] })).toEqual([]);
  });

  it("precomps: reused unless a rule names a layer in a full-frame one; duplicate copies the whole tree", () => {
    const L = (i: number, n: string, src?: number) => ({ i, n, ty: src ? "precomp" : "solid", pos: { k: 0 }, sc: { k: 0 }, an: { k: 0 }, ...(src ? { src } : {}) });
    const tree: Tree = {
      root: 1,
      comps: [
        { id: 1, name: "Main", w: 1920, h: 1080, fps: 25, layers: [L(1, "Scene", 2), L(2, "Badge", 3)] },
        { id: 2, name: "Scene", w: 1920, h: 1080, fps: 25, layers: [L(1, "Title"), L(2, "Inner", 4)] },
        { id: 3, name: "Badge", w: 400, h: 400, fps: 25, layers: [L(1, "Star")] },
        { id: 4, name: "Inner", w: 1920, h: 1080, fps: 25, layers: [L(1, "Plate")] },
      ],
    };
    const auto = decideJobs(tree, { pin: [{ layer: "Title", to: "top", margin: 10 }] }, "auto", "V");
    expect(auto.jobs).toEqual([
      { src: 2, name: "Scene (V)", reformat: true },
      { src: 1, name: "V", reformat: true },
    ]);
    expect(auto.precomps).toEqual(['"Scene": reformatted as "Scene (V)": a rule names "Title" inside it', '"Inner": reused (no rule names a layer inside it)', '"Badge": reused (400x400, not the frame size)']);
    // deeper: the chain of full-frame precomps to the layer is reformatted
    expect(decideJobs(tree, { hide: ["Plate"] }, "auto", "V").jobs.map((j) => j.src)).toEqual([4, 2, 1]);
    // a rule inside a precomp that isn't the frame size can't be applied: a FAIL with the reason
    const badge = decideJobs(tree, { pin: [{ layer: "Star", to: "top", margin: 0 }] }, "auto", "V");
    expect(badge.issues).toEqual([expect.objectContaining({ check: "reformat.precomp", severity: "fail", where: "Badge > 1: Star", message: expect.stringMatching(/400x400, not the frame size.*not applied/) })]);
    const reuse = decideJobs(tree, { pin: [{ layer: "Title", to: "top", margin: 10 }] }, "reuse", "V");
    expect(reuse.jobs).toEqual([{ src: 1, name: "V", reformat: true }]);
    expect(reuse.issues[0]).toMatchObject({ severity: "fail", fix: expect.stringMatching(/precomps "auto" or "duplicate"/) });
    const dup = decideJobs(tree, {}, "duplicate", "V");
    expect(dup.jobs).toEqual([
      { src: 4, name: "Inner (V)", reformat: true },
      { src: 2, name: "Scene (V)", reformat: true },
      { src: 3, name: "Badge (V)", reformat: false },
      { src: 1, name: "V", reformat: true },
    ]);
  });

  it("a reason goes on the measured finding it explains, once; the rest stand alone", () => {
    const f = [
      { check: "safeAreas.title", severity: "fail" as const, where: "V > 1: Title", message: "outside title-safe by up to 90 px on the left and right", fix: "keep it inside" },
      { check: "safeAreas.title", severity: "fail" as const, where: "V > 1: Title", message: "again later", fix: "keep it inside" },
    ];
    const out = mergeIssues(f, [
      { comp: "V", i: 1, n: "Title", where: "V > 1: Title", check: "safeAreas.title", severity: "fail", message: "can't fit title-safe", fix: "Decide: a shorter text" },
      { comp: "V", i: 2, n: "Logo", where: "V > 2: Logo", check: "reformat.pin", severity: "fail", message: "pin conflict" },
    ]);
    expect(out.map((x) => x.fix)).toEqual(["can't fit title-safe. Decide: a shorter text", "keep it inside", undefined]);
    expect(out[2]).toMatchObject({ check: "reformat.pin", where: "V > 2: Logo" });
  });

  it("the plan against the result: a layer that ended up elsewhere is a FAIL, with where it is furthest off", () => {
    const item = (p: number[]) => ({ n: "T", w: "V > 1: T", ti: 1, m: [0], i: [0, 1], rect: [0, 0, 10, 10], lv: [{ n: "T", a: [0, 0], p: { v: [p, [p[0] + 5, p[1]]] }, s: [100, 100], r: 0 }] });
    const d = (p: number[]) => ({ v: 1, comp: { id: 1, name: "V", w: 100, h: 100, fps: 25, dur: 1, par: 1, fd: 0.04 }, project: {}, step: 1, n: 2, feat: {}, items: [item(p)] }) as any;
    expect(residuals(d([10, 10]), d([10, 10]))).toEqual([]);
    expect(residuals(d([10, 10]), d([10, 13]))).toEqual([expect.objectContaining({ check: "reformat.result", severity: "fail", where: "V > 1: T", at: 0, message: "the result is up to 3 px away from the plan" })]);
  });

  it("the scripts are valid ES3", async () => {
    const { parse } = await import("acorn");
    for (const body of [TREE_JSX, APPLY_JSX, PREFLIGHT_JSX]) expect(() => parse(`(function(args, log){${body}\n})`, { ecmaVersion: 3, allowReserved: false })).not.toThrow();
  });
});

describe("ae_reformat", () => {
  const rules = {
    background: [{ layer: "BG", mode: "cover" }],
    safeAreas: { title: 0.1, action: 0.05 },
    safe: [{ layer: "Title", area: "title" }],
    pin: [{ layer: "Logo", to: "top-right", margin: 40 }],
  };
  const spot = () => fakeReformatAE({ comps: [SPOT], footage: [{ name: "LogoArt", width: 200, height: 100 }] });

  it("16:9 to 9:16 by the rules: cover, title-safe, a pin; checked PASS; the source is untouched", async () => {
    fake.ae = spot();
    const r = await reformat(rules);
    const t = text(r);
    expect(r.isError).toBeUndefined();
    expect(t.split("\n")[0]).toBe("PASS");
    expect(t.split("\n")[1]).toBe('Reformat of "Main" (1920x1080) as "Main 9x16" (1080x1920, 25 fps), checked on every frame against your rules');
    const N = fake.ae.comp("Main 9x16");
    expect([N.width, N.height]).toEqual([1080, 1920]);
    // cover: scaled 1920/1080 about the centre
    expect(val(fake.ae.prop("Main 9x16", "BG", "ADBE Scale"))[0]).toBeCloseTo((100 * 1920) / 1080, 6);
    expect(val(fake.ae.prop("Main 9x16", "BG", "ADBE Position")).slice(0, 2)).toEqual([540, 960]);
    // the title (800 px wide, at x 280-1080 after the centre move) moved the least it takes into title-safe (x 108-972)
    const tp = val(fake.ae.prop("Main 9x16", "Title", "ADBE Position"));
    expect(tp[0]).toBeCloseTo(972 - 800, 6);
    expect(tp[1]).toBeCloseTo(900 + 420, 6);
    // the logo (200x100) at 40 px from the top and right edges
    expect(val(fake.ae.prop("Main 9x16", "Logo", "ADBE Position")).slice(0, 2)).toEqual([1080 - 40 - 200, 40]);
    // no rule: the same offset from the frame centre
    expect(val(fake.ae.prop("Main 9x16", "Bug", "ADBE Position")).slice(0, 2)).toEqual([910 - 420, 490 + 420]);
    // the source comp is not changed
    expect(val(fake.ae.prop("Main", "Title", "ADBE Position")).slice(0, 2)).toEqual([700, 900]);
    expect(fake.ae.comp("Main").width).toBe(1920);
    expect(t).toMatch(/plan\n {2}Main 9x16:\n {4}1: Title \[safe title\]: moved into title-safe/);
    expect(t).toContain("4: BG [background cover]: cover: scaled to 177.8% about the frame centre");
    expect(t).toContain("3: Bug: no rule: kept their offset from the frame centre (moved -420, 420 px)");
    // one undo step that rolls back if it fails part-way, and the change report on the source comp's scope
    const apply = fake.calls.find((c) => c.body === APPLY_JSX);
    expect(apply.opts).toMatchObject({ undoGroup: "Surehand MCP Reformat", rollback: "requested" });
  });

  it("dry run: the plan and the predicted checks, nothing created", async () => {
    fake.ae = spot();
    const before = fake.ae.items.length;
    const t = text(await reformat({ ...rules, dryRun: true }));
    expect(t.split("\n")[0]).toBe("PLAN: predicted PASS");
    expect(t).toMatch(/Dry run \(nothing changed\)/);
    expect(fake.ae.items.length).toBe(before);
    expect(fake.calls.some((c) => c.body === APPLY_JSX)).toBe(false);
  });

  it("a title too wide for title-safe and no scale rule: FAIL with the reason and the decisions, best attempt centred", async () => {
    fake.ae = fakeReformatAE({ comps: [{ name: "Main", layers: [{ name: "Title", type: "text", rect: [0, -60, 1200, 80], position: [360, 900] }] }] });
    const t = text(await reformat({ safeAreas: { title: 0.1 }, safe: [{ layer: "Title", area: "title" }] }));
    expect(t.split("\n")[0]).toBe("FAIL (1)");
    expect(t).toMatch(/FAIL {2}00:00:00:00–00:00:01:24 \(0\.00s–1\.96s\) {2}Main 9x16 > 1: Title: outside title-safe by up to 168 px on the left and right/);
    expect(t).toContain("fix: can't fit title-safe (1200 px wide; title-safe is 864 px) and no scale rule lets it scale; it is centred in title-safe. Decide: a shorter text, a line break, a smaller minimum cap height, a lower scale limit, or other safe margins");
    // centred: (1080 - 1200) / 2
    expect(val(fake.ae.prop("Main 9x16", "Title", "ADBE Position"))[0]).toBeCloseTo(-60, 6);
  });

  it("scaling stops at the minimum cap height: FAIL that says so; within the limit it fits and passes", async () => {
    const comp = (): RComp => ({ name: "Main", layers: [{ name: "Title", type: "text", rect: [0, -60, 1200, 80], position: [360, 900], fontSize: 60 }] });
    // cap 0.7 x 60 = 42 px; fitting needs 72%: 30.2 px, below 40
    fake.ae = fakeReformatAE({ comps: [comp()] });
    const t = text(await reformat({ safeAreas: { title: 0.1 }, safe: [{ layer: "Title", area: "title" }], scale: [{ layer: "Title" }], minCapHeightPx: 40 }));
    expect(t.split("\n")[0]).toBe("FAIL (1)");
    expect(t).toMatch(/fix: can't fit title-safe: it needs 72% of its size \(1200 px wide; title-safe is 864 px\), but the minimum cap height \(40 px\) keeps it at 95\.2% or more \(its cap height is about 42 px in the source\); it is at 95\.2%, centred/);
    expect(val(fake.ae.prop("Main 9x16", "Title", "ADBE Scale"))[0]).toBeCloseTo(95.238, 2);
    // a lower minimum: it fits at 72% and passes (cap 30.2 px)
    fake.ae = fakeReformatAE({ comps: [comp()] });
    const ok = text(await reformat({ safeAreas: { title: 0.1 }, safe: [{ layer: "Title", area: "title" }], scale: [{ layer: "Title" }], minCapHeightPx: 30 }));
    expect(ok.split("\n")[0]).toBe("PASS");
    expect(val(fake.ae.prop("Main 9x16", "Title", "ADBE Scale"))[0]).toBeCloseTo(72, 6);
  });

  it("keyframes: Position and Scale keys are mapped by the same scale and move, tangents and ease speeds scaled", async () => {
    const { KeyframeEase, KIT } = await import("./fake-keys.js");
    fake.ae = fakeReformatAE({ comps: [{ name: "Main", layers: [{ name: "BG", anchor: [960, 540], keys: { position: [[0, [860, 540]], [1, [1060, 540]]], scale: [[0, [100, 100]], [1, [110, 110]]] } }] }] });
    const pos = fake.ae.prop("Main", "BG", "ADBE Position");
    pos.setInterpolationTypeAtKey(1, KIT.BEZIER, KIT.BEZIER);
    pos.setTemporalEaseAtKey(1, [new KeyframeEase(0, 33)], [new KeyframeEase(150, 40)]);
    pos.setSpatialTangentsAtKey(1, [0, 0, 0], [60, 0, 0]);
    pos.setSpatialAutoBezierAtKey(1, false);
    const t = text(await reformat({ background: [{ layer: "BG", mode: "cover" }] }));
    // the covering scale over both keys: the smallest frame (at 0 s, shifted left by 100 px) needs 960 / 860 of... the worst side
    const k = Number(/cover: scaled to ([\d.]+)%/.exec(t)![1]) / 100;
    const np = fake.ae.prop("Main 9x16", "BG", "ADBE Position"), ns = fake.ae.prop("Main 9x16", "BG", "ADBE Scale");
    expect(np.numKeys).toBe(2);
    const kk = ns.keyValue(1)[0] / 100;
    expect(kk).toBeCloseTo(k, 3);
    expect(np.keyValue(1)[0]).toBeCloseTo(540 + kk * (860 - 960), 6);
    expect(np.keyValue(2)[0]).toBeCloseTo(540 + kk * (1060 - 960), 6);
    expect(ns.keyValue(2)[0]).toBeCloseTo(110 * kk, 6);
    expect(np.keyOutSpatialTangent(1)[0]).toBeCloseTo(60 * kk, 6);
    expect(np.keyOutTemporalEase(1)[0].speed).toBeCloseTo(150 * kk, 6);
    expect(np.keyOutTemporalEase(1)[0].influence).toBe(40);
    expect(t.split("\n")[0]).toBe("PASS");
    expect(t).toContain("2 Position keys and 2 Scale keys mapped the same way");
  });

  it("a rule on a layer inside a full-frame precomp: the precomp is duplicated and reformatted, its layer's anchor follows", async () => {
    fake.ae = fakeReformatAE({
      comps: [
        { name: "Scene", layers: [{ name: "Title", type: "text", rect: [0, -60, 400, 80], position: [1400, 900] }] },
        { name: "Main", layers: [{ name: "Scene", type: "precomp", source: "Scene", anchor: [960, 540], position: [960, 540] }] },
      ],
      active: "Main",
    });
    const t = text(await reformat({ safeAreas: { title: 0.1 }, safe: [{ layer: "Title", area: "title" }] }));
    expect(t.split("\n")[0]).toBe("PASS");
    expect(t).toContain('"Scene": reformatted as "Scene (Main 9x16)": a rule names "Title" inside it');
    const inner = fake.ae.comp("Scene (Main 9x16)");
    expect([inner.width, inner.height]).toEqual([1080, 1920]);
    const L = fake.ae.comp("Main 9x16").layer(1);
    expect(L.source).toBe(inner);
    expect(val(fake.ae.prop("Main 9x16", "Scene", "ADBE Anchor Point")).slice(0, 2)).toEqual([540, 960]);
    expect(val(fake.ae.prop("Main 9x16", "Scene", "ADBE Position")).slice(0, 2)).toEqual([540, 960]);
    // inside: the title moved into title-safe (right edge to 972)
    expect(val(fake.ae.prop("Scene (Main 9x16)", "Title", "ADBE Position"))[0]).toBeCloseTo(972 - 400, 6);
    // the original precomp is untouched
    expect(fake.ae.comp("Scene").width).toBe(1920);
  });

  it("precomps reuse: a rule inside one is not applied, and that is a FAIL, not silence", async () => {
    fake.ae = fakeReformatAE({
      comps: [
        { name: "Scene", layers: [{ name: "Title", type: "text", rect: [0, -60, 400, 80], position: [1400, 900] }] },
        { name: "Main", layers: [{ name: "Scene", type: "precomp", source: "Scene", anchor: [960, 540], position: [960, 540] }] },
      ],
      active: "Main",
    });
    const t = text(await reformat({ precomps: "reuse", pin: [{ layer: "Title", to: "bottom", margin: 100 }] }));
    expect(t.split("\n")[0]).toBe("FAIL (1)");
    expect(t).toMatch(/Scene > 1: Title: a rule names this layer, but it is inside precomp "Scene" and precomps "reuse" keeps it as it is: the rule was not applied/);
  });

  it("a parented layer: the move is made in its parent's space; the result matches the plan", async () => {
    fake.ae = fakeReformatAE({
      comps: [{ name: "Main", layers: [{ name: "Logo", rect: [0, 0, 200, 100], position: [100, 100], parent: "Rig" }, { name: "Rig", type: "null", position: [1000, 500], scale: [50, 50] }] }],
    });
    const t = text(await reformat({ pin: [{ layer: "Logo", to: "bottom-left", margin: 30 }] }));
    expect(t.split("\n")[0]).toBe("PASS");
    // on screen the logo is 100x50 at (1050, 550); pinned: left 30, bottom 1920 - 30. Parent (moved by the centre) at (580, 920), 50%
    const p = val(fake.ae.prop("Main 9x16", "Logo", "ADBE Position"));
    expect(580 + p[0] * 0.5).toBeCloseTo(30, 6);
    expect(920 + p[1] * 0.5 + 50).toBeCloseTo(1890, 6);
    expect(t).not.toMatch(/reformat\.result|away from the plan/);
  });

  it("hide, a track matte that follows its layer, a locked layer, a Position expression", async () => {
    fake.ae = fakeReformatAE({
      comps: [
        {
          name: "Main",
          layers: [
            { name: "Matte", rect: [0, 0, 300, 300], position: [1500, 300] },
            { name: "Photo", rect: [0, 0, 300, 300], position: [1500, 300], matte: "Matte", locked: true },
            { name: "Promo", rect: [0, 0, 100, 100] },
            { name: "Wiggly", rect: [0, 0, 100, 100], positionExpression: "wiggle(2, 10)" },
          ],
        },
      ],
    });
    const t = text(await reformat({ pin: [{ layer: "Photo", to: "top-right", margin: 0 }], hide: ["Promo"] }));
    const N = fake.ae.comp("Main 9x16");
    expect(N.layer("Promo").enabled).toBe(false);
    expect(val(fake.ae.prop("Main 9x16", "Photo", "ADBE Position")).slice(0, 2)).toEqual([780, 0]);
    expect(val(fake.ae.prop("Main 9x16", "Matte", "ADBE Position")).slice(0, 2)).toEqual([780, 0]);
    expect(N.layer("Photo").locked).toBe(true);
    expect(t).toContain('1: Matte: track matte of "Photo": moved with it');
    expect(t).toContain("locked (unlocked to change it, then locked again)");
    expect(t).toMatch(/WARN.*Wiggly: Position has an expression: not moved/);
    expect(t.split("\n")[0]).toBe("WARNINGS (1)");
  });

  it("fit, and notes (not failures) for layers no rule names: a full-frame plate that no longer covers, a layer pushed out", async () => {
    fake.ae = fakeReformatAE({
      comps: [
        {
          name: "Main",
          layers: [
            { name: "Side", rect: [0, 0, 200, 200], position: [100, 400] },
            { name: "Plate", anchor: [960, 540], position: [960, 540] },
            { name: "BG", anchor: [960, 540], position: [960, 540] },
          ],
        },
      ],
    });
    const t = text(await reformat({ background: [{ layer: "BG", mode: "fit" }] }));
    expect(t.split("\n")[0]).toBe("PASS");
    expect(val(fake.ae.prop("Main 9x16", "BG", "ADBE Scale"))[0]).toBeCloseTo(56.25, 6);
    expect(t).toContain("\nreformat (2)\n");
    expect(t).toMatch(/INFO {2}Main 9x16 > 2: Plate: covered the whole frame in the source; now leaves up to 420 px uncovered on the top and bottom/);
    expect(t).toMatch(/INFO {2}Main 9x16 > 1: Side: was inside the frame in the source; now up to 320 px outside it on the left/);
    expect(t).toContain("fix: Decide: a background rule (cover or fit) for it, if it should fill the new frame");
  });

  it('precomps "duplicate": the whole tree is copied, full-frame precomps reformatted, others copied unchanged', async () => {
    fake.ae = fakeReformatAE({
      comps: [
        { name: "Badge", width: 400, height: 400, layers: [{ name: "Star", rect: [0, 0, 100, 100] }] },
        { name: "Scene", layers: [{ name: "Plate", rect: [0, 0, 100, 100], position: [100, 100] }] },
        { name: "Main", layers: [{ name: "Badge", type: "precomp", source: "Badge", position: [200, 200] }, { name: "Scene", type: "precomp", source: "Scene" , anchor: [960, 540], position: [960, 540] }] },
      ],
      active: "Main",
    });
    const t = text(await reformat({ precomps: "duplicate" }));
    const N = fake.ae.comp("Main 9x16");
    expect(N.layer(1).source).toBe(fake.ae.comp("Badge (Main 9x16)"));
    expect(fake.ae.comp("Badge (Main 9x16)").width).toBe(400);
    expect(N.layer(2).source).toBe(fake.ae.comp("Scene (Main 9x16)"));
    expect(fake.ae.comp("Scene (Main 9x16)").height).toBe(1920);
    expect(t).toContain('"Badge": copied unchanged as "Badge (Main 9x16)" (400x400, not the frame size)');
    expect(t).toContain('"Scene": reformatted as "Scene (Main 9x16)": precomps "duplicate"');
    expect(t.split("\n")[0]).toBe("PASS");
  });

  it("3D layers move with the frame centre; a rule on one is a FAIL (it needs depth); a new frame rate is noted", async () => {
    fake.ae = fakeReformatAE({ comps: [{ name: "Main", layers: [{ name: "Card", threeD: true, position: [960, 540, 200] }, { name: "Cam", type: "camera", position: [960, 540, -2000], anchor: [960, 540] }] }] });
    const t = text(await reformat({ frameRate: 30, safeAreas: { title: 0.1 }, safe: [{ layer: "Card", area: "title" }] }));
    expect(val(fake.ae.prop("Main 9x16", "Card", "ADBE Position"))).toEqual([540, 960, 200]);
    expect(val(fake.ae.prop("Main 9x16", "Cam", "ADBE Anchor Point")).slice(0, 2)).toEqual([540, 960]);
    expect(fake.ae.comp("Main 9x16").frameRate).toBe(30);
    expect(t).toMatch(/FAIL {2}Main 9x16 > 1: Card: 3D layer: the rules aren't applied to 3D layers/);
    expect(t).toMatch(/frame rate 25 -> 30 fps/);
  });

  it("a checkpoint that can't be saved stops before anything changes", async () => {
    fake.ae = spot();
    const before = fake.ae.items.length;
    const r = await reformat({ checkpoint: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/checkpoint could not be saved, so nothing was changed: The project has never been saved/);
    expect(fake.ae.items.length).toBe(before);
  });

  it("refuses before changing anything: a name in use, read-only mode, rules without their margins", async () => {
    fake.ae = spot();
    expect(text(await reformat({ name: "Main" }))).toMatch(/already exists.*nothing was changed/);
    expect(text(await reformat({ safe: [{ layer: "Title", area: "title" }] }))).toMatch(/give safeAreas\.title/);
    const ro = await reformat({}, "read-only");
    expect(ro.isError).toBe(true);
    expect((await reformat({ dryRun: true }, "read-only")).isError).toBeUndefined();
    expect(fake.calls.some((c) => c.body === APPLY_JSX)).toBe(false);
  });
});
