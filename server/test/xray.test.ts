import { describe, expect, it } from "vitest";
import { parseExpression, tokenize, type ExprRef } from "../src/tools/xray-expr.js";
import { analyzeXray, formatXray, heavyEffect, type XData } from "../src/tools/xray-analyze.js";
import { xrayTools } from "../src/tools/xray.js";
import { fakeProject, type FakeProjectSpec } from "./fake-ae.js";

const kinds = (src: string) => parseExpression(src).refs.map((r) => r.kind);
/** short readable form of each reference */
function show(r: ExprRef): string {
  const sel = (s: any) => (s === "this" ? "this" : s.by === "name" ? `"${s.v}"` : s.by === "index" ? `#${s.v}` : `${s.by}(${s.text})`);
  const comp = (c: any): string => (c.k === "this" ? "thisComp" : c.k === "sel" ? `comp ${sel(c.sel)}` : `source of [${layer(c.layer)}]`);
  const layer = (l: any): string => `${comp(l.comp)} > ${sel(l.base)}${l.parents ? ` ^${l.parents}` : ""}`;
  switch (r.kind) {
    case "comp":
      return comp(r.comp);
    case "footage":
      return `footage ${sel(r.item)}`;
    case "layer":
    case "parent":
      return `${r.kind} ${layer(r.layer)}`;
    case "effect":
      return `effect ${sel(r.effect)} on ${layer(r.layer)}`;
    case "param":
      return `param ${sel(r.param)} of ${sel(r.effect)} on ${layer(r.layer)}`;
    default:
      return `${r.kind} ${r.path.map(sel).join("/")} on ${layer(r.layer)}`;
  }
}
const refs = (src: string) => parseExpression(src).refs.map(show);

describe("expression tokenizer", () => {
  it("skips comments and reads strings with escapes and quotes", () => {
    const t = tokenize(`// thisComp.layer("no")\n/* comp("no") */ comp("It's \\"Main\\"") + 'a\\'b' + "\\u0041\\x42"`);
    expect(t.filter((x) => x.t === "str").map((x) => x.v)).toEqual([`It's "Main"`, "a'b", "AB"]);
    expect(t.some((x) => x.t === "id" && x.v === "no")).toBe(false);
    expect(t[0].nl).toBe(true); // after the comments' line break
    expect(t[1].v).toBe("(");
  });

  it("tells regex literals from division", () => {
    const t = tokenize(`var a = x / 2 / y; var r = /layer\\("x"\\)/g; s.replace(/[/]/, "")`);
    expect(t.filter((x) => x.t === "re").map((x) => x.v)).toEqual([`/layer\\("x"\\)/g`, "/[/]/"]);
    expect(t.filter((x) => x.t === "str").map((x) => x.v)).toEqual([""]);
  });

  it("reads template literals, including nested substitutions", () => {
    const t = tokenize("`a ${thisComp.layer(`L${i}`).name} b` + `plain`");
    expect(t.filter((x) => x.t === "str").map((x) => x.v)).toEqual(["plain"]);
    expect(t.some((x) => x.t === "id" && x.v === "thisComp")).toBe(true);
    expect(t.filter((x) => x.t === "tpl").length).toBe(4);
  });

  it("marks line breaks and never throws on broken input", () => {
    const t = tokenize("a\nb");
    expect(t[1].nl).toBe(true);
    expect(() => tokenize('comp("unterminated\n thisComp.layer(')).not.toThrow();
    expect(() => tokenize("`open ${ never closed")).not.toThrow();
    expect(() => tokenize("/* open comment")).not.toThrow();
  });
});

describe("expression references", () => {
  it("classic links", () => {
    expect(refs(`thisComp.layer("CTRL").effect("Size")("Slider")`)).toEqual([
      'layer thisComp > "CTRL"',
      'effect "Size" on thisComp > "CTRL"',
      'param "Slider" of "Size" on thisComp > "CTRL"',
    ]);
    expect(refs(`comp("Main").layer("Cam").transform.position`)).toEqual(['comp "Main"', 'layer comp "Main" > "Cam"']);
    expect(refs(`effect("Glow")(2)`)).toEqual(['effect "Glow" on thisComp > this', 'param #2 of "Glow" on thisComp > this']);
    expect(refs(`footage("data.json").sourceData.title`)).toEqual(['footage "data.json"']);
    expect(refs(`comp('Main').layer('He said "hi"').effect("x").param("ADBE Slider Control-0001")`)).toEqual([
      'comp "Main"',
      'layer comp "Main" > "He said "hi""',
      'effect "x" on comp "Main" > "He said "hi""',
      'param "ADBE Slider Control-0001" of "x" on comp "Main" > "He said "hi""',
    ]);
    expect(refs(`value / thisComp.layer("A").transform.opacity * 100 / 2`)).toEqual(['layer thisComp > "A"']);
    expect(refs(`thisComp.layer("A").name == "B" ? 1 : 0`)).toEqual(['layer thisComp > "A"']);
  });

  it("index and relative-index layers", () => {
    expect(refs("thisComp.layer(3).opacity")).toEqual(["layer thisComp > #3"]);
    expect(refs("thisComp.layer(index - 1).position")).toEqual(["layer thisComp > relative(index - 1)"]);
    expect(refs("thisComp.layer(thisLayer, -1).position")).toEqual(["layer thisComp > relative(thisLayer, -1)"]);
    expect(refs('thisComp.layer("L" + n)')).toEqual(['layer thisComp > dynamic("L" + n)']);
  });

  it("parents, sources, content, masks and properties by name", () => {
    expect(refs("thisLayer.parent.parent.transform.rotation")).toEqual(["parent thisComp > this ^1", "parent thisComp > this ^2"]);
    expect(refs("parent.scale")).toEqual(["parent thisComp > this ^1"]);
    expect(refs(`thisComp.layer("Pre").source.layer("Inner").opacity`)).toEqual(['layer thisComp > "Pre"', 'layer source of [thisComp > "Pre"] > "Inner"']);
    expect(refs(`content("Group 1").content("Rect").size`)).toEqual(['content "Group 1"/"Rect" on thisComp > this']);
    expect(refs(`thisComp.layer("Shape").mask(1).maskPath`)).toEqual(['layer thisComp > "Shape"', 'mask #1 on thisComp > "Shape"']);
    expect(refs(`thisLayer("ADBE Transform Group")("ADBE Position")`)).toEqual(['property "ADBE Transform Group"/"ADBE Position" on thisComp > this']);
    expect(refs(`thisComp.layer("A")("Effects")("Glow")("Glow Radius")`)).toEqual(['layer thisComp > "A"', 'property "Effects"/"Glow"/"Glow Radius" on thisComp > "A"']);
  });

  it("variables holding comps, layers and effects (ES3 and modern)", () => {
    const src = `
      const ctrl = thisComp.layer("CTRL"); // the rig
      let fx = ctrl.effect("Wiggle Amount");
      var c = comp("Other");
      var amt = fx("Slider");
      c.layer("Target").position + amt`;
    expect(refs(src)).toEqual([
      'layer thisComp > "CTRL"',
      'effect "Wiggle Amount" on thisComp > "CTRL"',
      'comp "Other"',
      'param "Slider" of "Wiggle Amount" on thisComp > "CTRL"',
      'layer comp "Other" > "Target"',
    ]);
  });

  it("constants as names, but not loop counters", () => {
    expect(refs(`var n = "Null 1"; thisComp.layer(n).position`)).toEqual(['layer thisComp > "Null 1"']);
    expect(refs(`for (var i = 1; i <= 3; i++) s += thisComp.layer(i).opacity;`)).toEqual(["layer thisComp > dynamic(i)"]);
  });

  it("multi-line chains, optional chaining and nested references in arguments", () => {
    expect(refs(`thisComp\n  .layer("A")\n  .effect("B")\n  ("C")`)).toEqual(['layer thisComp > "A"', 'effect "B" on thisComp > "A"', 'param "C" of "B" on thisComp > "A"']);
    expect(refs(`thisComp.layer(thisComp.layer("Index Source").index + 1)`)).toEqual([
      'layer thisComp > relative(thisComp.layer("Index Source").index + 1)',
      'layer thisComp > "Index Source"',
    ]);
    expect(refs(`thisComp?.layer("A")?.position`)).toEqual(['layer thisComp > "A"']);
  });

  it("ignores names in comments, strings, regexes, object keys, members and function names", () => {
    expect(
      kinds(`
      // comp("Commented").layer("Out")
      /* thisComp.layer("Block") */
      var s = 'thisComp.layer("InString")';
      var r = /comp\\("InRegex"\\)/;
      var o = { layer: 1, effect: 2 };
      obj.comp("Member"); x.layer("M2");
      function effect(n) { return n; }
      s`),
    ).toEqual([]);
  });

  it("handles real-world rig expressions", () => {
    const wiggle = `
      // wiggle driven by a controller
      freq = thisComp.layer("Controls").effect("Freq")("ADBE Slider Control-0001");
      amp = thisComp.layer("Controls").effect("Amp")("Slider");
      wiggle(freq, amp)`;
    expect(refs(wiggle)).toEqual([
      'layer thisComp > "Controls"',
      'effect "Freq" on thisComp > "Controls"',
      'param "ADBE Slider Control-0001" of "Freq" on thisComp > "Controls"',
      'layer thisComp > "Controls"',
      'effect "Amp" on thisComp > "Controls"',
      'param "Slider" of "Amp" on thisComp > "Controls"',
    ]);
    const follow = `
      const target = thisComp.layer("Target");
      const offset = effect("Offset")("Point");
      if (hasParent) { parent.toComp(target.anchorPoint) + offset } else { target.position + offset }`;
    const p = parseExpression(follow);
    expect(p.parentGuard).toBe(true);
    expect(p.refs.map(show)).toEqual(['layer thisComp > "Target"', 'effect "Offset" on thisComp > this', 'param "Point" of "Offset" on thisComp > this', "parent thisComp > this ^1"]);
    expect(parseExpression(`try { comp("X").layer(1) } catch (e) { 0 }`).guarded).toBe(true);
    expect(refs(`text.sourceText + " " + thisComp.layer(\`Name \${index}\`).text.sourceText`)).toEqual(["layer thisComp > relative(`Name ${index}`)"]);
  });
});

// ---------- analysis on collected data ----------

function data(over: Partial<XData> = {}): XData {
  const base: XData = {
    v: 1,
    sections: ["render", "expressions", "missing", "footage", "weight"],
    ae: "25.0",
    engine: "javascript-1.0",
    comps: [
      {
        id: 1, name: "Main", w: 1920, h: 1080, fps: 25, dur: 10, nl: 4, usedIn: [], scanned: 4, mb: true, spf: 64, asl: 256, rend: "ADBE Ernst",
        layers: [
          { i: 1, id: 11, n: "CTRL", t: "null", fx: [{ m: "ADBE Slider Control", n: "Slider Control", d: 1 }, { m: "ADBE Slider Control", n: "Size" }] },
          { i: 2, id: 12, n: "Shot", t: "precomp", src: 2, mb: 1, ex: [["Transform/Opacity", 'thisComp.layer("CTRL").effect("Slider Control")("Slider")', "", 1]] },
          {
            i: 3, id: 13, n: "Title", t: "text", par: 1, d3: 1,
            ex: [
              ["Transform/Position", 'thisComp.layer(1).position + comp("Gone").layer("X").position', "", 1],
              ["Transform/Scale", 'thisComp.layer("Ctrl Renamed").effect("Size")("ADBE Slider Control-0001")', "Error: layer named 'Ctrl Renamed' is missing", 1],
              ["Transform/Rotation", 'parent.rotation + thisComp.layer("CTRL").effect("Size")(1)', "", 1],
            ],
          },
          { i: 4, id: 14, n: "Grade", t: "adjustment", adj: 1, inP: 0, outP: 10, shy: 1, fx: [{ m: "ADBE Turbulent Displace", n: "Turbulent Displace", d: 1 }, { m: "tc Particular", n: "Particular", x: 1 }] },
        ],
      },
      { id: 2, name: "Shot", w: 1920, h: 1080, fps: 25, dur: 10, nl: 1, usedIn: [1, 3], scanned: 1, layers: [{ i: 1, id: 21, n: "Plate", t: "footage", src: 10, sc: [25, 25] }] },
      { id: 3, name: "Old Version", w: 1920, h: 1080, fps: 25, dur: 10, nl: 2, usedIn: [], scanned: 1, layers: [{ i: 1, id: 31, n: "Shot", t: "precomp", src: 2 }] },
      { id: 4, name: "Leftover", w: 1920, h: 1080, fps: 30, dur: 5, nl: 0, usedIn: [3], scanned: 0, layers: [] },
    ],
    footage: [
      { id: 10, name: "plate.mov", kind: "file", file: "/f/plate.mov", w: 7680, h: 4320, fps: 23.976, dur: 10, par: 1, video: true, usedIn: [2] },
      { id: 11, name: "logo.png", kind: "file", file: null, missing: true, missingPath: "/old/logo.png", w: 500, h: 500, still: true, video: true, usedIn: [] },
      { id: 12, name: "Black Solid 1", kind: "solid", usedIn: [1] },
    ],
    rq: [{ comp: 1, status: "QUEUED", render: true }],
    fonts: { missing: [{ ps: "Gotham-Bold", family: "Gotham", style: "Bold", sub: true }] },
    layersScanned: 7,
    ms: 12,
  };
  return { ...base, ...over };
}

describe("X-ray analysis", () => {
  it("render reachability: trees, dead branches, depth, multi-use", () => {
    const r: any = analyzeXray(data()).render;
    expect(r.tree).toEqual(["Main [render queue: queued]", "  Shot"]);
    expect(r.reachable).toEqual({ fromRenderQueue: 2, fromQueuedItems: 2, of: 4 });
    expect(r.topLevelNotInRenderQueue).toEqual(["Old Version"]);
    expect(r.deadBranches).toEqual(["Leftover"]);
    expect(r.maxPrecompDepth).toBe(1);
    expect(r.deepestChain).toEqual(["Main", "Shot"]);
    expect(r.usedInManyPlaces).toEqual([{ comp: "Shot", layers: 2, inComps: 2 }]);
  });

  it("render queue empty: starts from the top-level comps", () => {
    const r: any = analyzeXray(data({ rq: [] })).render;
    expect(r.note).toMatch(/empty/);
    expect(r.tree[0]).toBe("Main [top level]");
    expect(r.tree).toContain("Old Version [top level] (partly read)");
    // Shot is used by both, but has no comps inside: listed twice, not "expanded above"
    expect(r.tree.filter((l: string) => l === "  Shot").length).toBe(2);
    // Old Version isn't fully read: Leftover comes from AE's own list of users
    expect(r.tree).toContain("  Leftover");
  });

  it("expressions: broken links, fragile links, errors, rename-sensitive names, dependencies", () => {
    const e: any = analyzeXray(data()).expressions;
    expect(e.total).toBe(4);
    expect(e.withErrors).toBe(1);
    expect(e.errors[0].at).toBe("Main > 3: Title > Transform/Scale");
    const broken = e.broken.map((b: any) => b.problem);
    expect(broken).toContain('no comp named "Gone"');
    expect(broken).toContain('no layer named "Ctrl Renamed" in comp "Main"');
    expect(e.fragile.map((x: any) => [x.ref, x.why, x.now])).toEqual([
      ["thisComp.layer(1)", "index", "CTRL"],
      ['thisComp.layer("CTRL").effect("Slider Control")', "effectDefaultName", "ADBE Slider Control"],
      ['thisComp.layer("CTRL").effect("Slider Control")("Slider")', "paramName", undefined],
    ]);
    expect(e.fragileCounts).toEqual({ effectDefaultName: 1, paramName: 1, index: 1 });
    expect(Object.keys(analyzeXray(data()).legend!).sort()).toEqual(["effectDefaultName", "index", "paramName"]);
    // "Size" was renamed by the user: rename-sensitive, not language-sensitive; param by index / match name is safe
    expect(e.renameSensitive[0]).toMatchObject({ target: 'layer "CTRL" in "Main"', expressions: 2, fromLayers: 2 });
    expect(e.renameSensitive.map((x: any) => x.target)).toContain('effect "Size" on "CTRL" in "Main"');
    expect(e.dependencies.hubs).toEqual([{ layer: "Main > 1: CTRL", readBy: 2 }]);
    expect(e.dependencies.edges.find((x: any) => x.from === "Main > 3: Title" && x.to === "Main > 1: CTRL").via).toEqual(["layer", "parent", 'effect "Size"']);
  });

  it("a parent reference on a layer without a parent is broken unless guarded", () => {
    const d = data();
    d.comps[0].layers![1].ex = [["Transform/Rotation", "parent.rotation", "", 1], ["Transform/Scale", "hasParent ? parent.scale : value", "", 1]];
    const e: any = analyzeXray(d).expressions;
    expect(e.broken.filter((b: any) => /has no parent/.test(b.problem)).map((b: any) => b.at)).toEqual(["Main > 2: Shot > Transform/Rotation"]);
  });

  it("missing: plug-ins, footage, fonts with their text layers", () => {
    const d = data();
    d.comps[0].layers![2].font = "Gotham-Bold";
    const mi: any = analyzeXray(d).missing;
    expect(mi.effects).toEqual([{ matchName: "tc Particular", name: "Particular", layers: 1, examples: ["Main > 4: Grade"] }]);
    expect(mi.footage).toEqual([{ name: "logo.png", path: "/old/logo.png", usedIn: [] }]);
    expect(mi.fonts.missingOrSubstituted[0]).toMatchObject({ font: "Gotham-Bold", substituted: true, textLayers: 1, examples: ["Main > 3: Title"] });
    const old: any = analyzeXray(data({ fonts: null })).missing;
    expect(old.fonts.note).toMatch(/24\.0/);
  });

  it("footage: frame-rate mismatch, very large, unused", () => {
    const f: any = analyzeXray(data()).footage;
    expect(f.total).toBe(2);
    expect(f.missing).toBe(1);
    expect(f.mixedFrameRates).toEqual([{ footage: "plate.mov", fps: 23.98, comps: ["Shot (25)"] }]);
    expect(f.veryLarge).toEqual(["plate.mov (7680x4320)"]);
    expect(f.items[0].flags).toEqual(["frame rate differs from comps", "very large"]);
  });

  it("weight: heavy effects, hidden cost, comp settings, oversized footage", () => {
    const w: any = analyzeXray(data()).weight;
    expect(w.heavyEffects.map((h: any) => h.matchName)).toEqual(["ADBE Turbulent Displace"]); // Particular isn't installed
    expect(w.hiddenCost).toEqual([{ at: "Main > 4: Grade", is: ["shy"], effects: ["Turbulent Displace", "Particular"] }]);
    expect(w.comps[0]).toMatchObject({ comp: "Main", highSamples: true, renderer: "Cinema 4D", layers3D: 1, fullLengthAdjustment: ["4: Grade (2 effects)"] });
    expect(w.oversizedFootage[0]).toMatch(/^Shot > 1: Plate: 7680x4320 shown at 25%/);
    expect(heavyEffect({ m: "ADBE SubspaceStabilizer", n: "Warp Stabilizer" })).toMatch(/Warp/);
    expect(heavyEffect({ m: "ADBE Gaussian Blur 2", n: "Gaussian Blur" })).toBeNull();
  });

  it("caps lists, counts what was cut, and stays within one tool result", () => {
    const d = data();
    const many = Array.from({ length: 400 }, (_, k) => ({ i: k + 1, id: 5000 + k, n: `L${k}`, t: "solid", ex: [["Transform/Opacity", `thisComp.layer(${k + 1}).opacity`, "", 1]] as [string, string, string, number][] }));
    d.comps.push({ id: 9, name: "Big", w: 100, h: 100, fps: 25, dur: 1, nl: 400, usedIn: [], scanned: 400, layers: many });
    const rep: any = analyzeXray(d, { limit: 10 });
    expect(rep.expressions.fragile.length).toBe(10);
    expect(rep.expressions.fragileCounts.index).toBe(401);
    expect(rep.cut["expressions.fragile"]).toBe(393); // + 2 language-dependent
    const text = formatXray(d, {}, 8000);
    const [line, ...rest] = text.split("\n");
    expect(line).toMatch(/^Project X-ray: 5 comps/);
    expect(line).toMatch(/401 index-based/);
    expect(rest.join("\n").length).toBeLessThan(9000);
    expect(() => JSON.parse(rest[rest.length - 1])).not.toThrow();
  });

  it("is fast on big projects (5,000 layers, 15,000 expressions)", () => {
    const layers = Array.from({ length: 5000 }, (_, k) => ({
      i: k + 1, id: 9000 + k, n: `Layer ${k + 1}`, t: "shape", par: k ? 1 : undefined,
      fx: [{ m: "ADBE Slider Control", n: `Amount ${k}` }],
      ex: [
        ["Transform/Opacity", `thisComp.layer("Layer 1").effect("Amount 0")("Slider") * 100`, "", 1],
        ["Transform/Rotation", `// spin\nconst c = thisComp.layer(index - 1);\nc ? c.rotation + 5 : 0`, "", 1],
        ["Transform/Position", `comp("Main").layer("CTRL").position + [${k}, 0]`, "", 1],
      ] as [string, string, string, number][],
    }));
    const d = data();
    d.comps.push({ id: 50, name: "Huge", w: 1920, h: 1080, fps: 25, dur: 10, nl: 5000, usedIn: [], scanned: 5000, layers });
    const t0 = Date.now();
    const text = formatXray(d);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(text.length).toBeLessThan(60_000);
    expect(text.split("\n")[0]).toMatch(/15004 expressions/);
  });

  it("partial scans say so, and unscanned comps are not reported as broken targets", () => {
    const d = data({ partial: { reason: "time budget (5 s) used up" } });
    d.comps[1].layers = undefined;
    d.comps[1].scanned = undefined;
    d.comps[0].layers![0].ex = [["Transform/Opacity", 'comp("Shot").layer("Anything").opacity', "", 1]];
    const rep: any = analyzeXray(d);
    expect(rep.partial.reason).toMatch(/time budget/);
    expect(rep.expressions.broken.filter((b: any) => /Anything/.test(b.ref))).toEqual([]);
    expect(formatXray(d).split("\n")[0]).toMatch(/PARTIAL: time budget/);
  });
});

// ---------- the JSX collector, against a fake After Effects ----------

const INHERITED: FakeProjectSpec = {
  installedEffects: [
    { matchName: "ADBE Slider Control", displayName: "Slider Control" },
    { matchName: "ADBE Gaussian Blur 2", displayName: "Gaussian Blur" },
    { matchName: "CC Particle World", displayName: "CC Particle World" },
  ],
  fonts: [{ postScriptName: "Gotham-Bold", familyName: "Gotham", styleName: "Bold", isSubstitute: true }],
  footage: [
    { name: "plate.mov", file: "/f/plate.mov", width: 3840, height: 2160, fps: 24 },
    { name: "logo.png", file: "/old/logo.png", missing: true, still: true },
    { name: "proxy me.mov", file: "/f/big.mov", proxy: "/proxies/big_proxy.mov" },
  ],
  comps: [
    {
      name: "Main", motionBlur: true, samples: 32,
      layers: [
        { name: "CTRL", type: "null", effects: [{ matchName: "ADBE Slider Control", name: "Slider Control" }] },
        { name: "Title", type: "text", font: "Gotham-Bold", parent: 1, expressions: { "Transform/Opacity": { expr: 'thisComp.layer("CTRL").effect("Slider Control")("Slider")' } } },
        { name: "Shot", type: "precomp", source: "Shot", motionBlur: true, expressions: { "Transform/Position": { expr: 'thisComp.layer("Controller").position', error: "Layer named 'Controller' is missing" } } },
        { name: "FX", type: "solid", shy: true, effects: [{ matchName: "CC Particle World", name: "CC Particle World" }, { matchName: "tc Particular", name: "Particular" }] },
      ],
    },
    { name: "Shot", fps: 25, layers: [{ name: "Plate", type: "footage", source: "plate.mov", scale: [40, 40] }] },
    { name: "Unused Comp", layers: [{ name: "Old", type: "footage", source: "logo.png" }] },
  ],
  rq: [{ comp: "Main", render: true }],
  activeComp: "Shot",
};

describe("ae_project_xray JSX (fake After Effects)", () => {
  const tool = xrayTools[0];

  it("collects the project read-only and the analysis explains it", () => {
    const fp = fakeProject(INHERITED);
    const res = fp.run(tool.jsx, {});
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(fp.writes).toEqual([]);
    expect(fp.calls.filter((c) => c !== "beginSuppressDialogs" && c !== "endSuppressDialogs")).toEqual([]);
    const raw = JSON.parse(res.result);
    expect(raw.layersScanned).toBe(6);
    expect(raw.comps.map((c: any) => c.name)).toEqual(["Main", "Shot", "Unused Comp"]);
    expect(raw.comps[0].layers[3].fx).toEqual([{ m: "CC Particle World", n: "CC Particle World", d: 1 }, { m: "tc Particular", n: "Particular", x: 1 }]);

    const text = tool.format!(res.result, {});
    if (process.env.XRAY_SHOW) console.log(text);
    const [line, json] = text.split("\n");
    expect(line).toMatch(/^Project X-ray: 3 comps, 3 footage items, 6 layers read; render queue 1 item\(s\) reaching 2 of 3 comps/);
    const rep = JSON.parse(json);
    expect(rep.render.tree).toEqual(["Main [render queue: queued]", "  Shot"]);
    expect(rep.render.topLevelNotInRenderQueue).toEqual(["Unused Comp"]);
    expect(rep.expressions.errors).toEqual([{ at: "Main > 3: Shot > Transform/Position", error: "Layer named 'Controller' is missing" }]);
    expect(rep.expressions.broken.map((b: any) => b.problem)).toEqual(['no layer named "Controller" in comp "Main"']);
    expect(rep.expressions.fragile.map((f: any) => f.why)).toEqual(["effectDefaultName", "paramName"]);
    expect(rep.missing.effects.map((e: any) => e.matchName)).toEqual(["tc Particular"]);
    expect(rep.missing.footage).toEqual([{ name: "logo.png", path: "/old/logo.png", usedIn: ["Unused Comp"] }]);
    expect(rep.missing.fonts.missingOrSubstituted[0]).toMatchObject({ font: "Gotham-Bold", textLayers: 1 });
    expect(rep.missing.proxies).toEqual([{ item: "proxy me.mov", proxy: "/proxies/big_proxy.mov", inUse: true, missing: true }]);
    expect(rep.footage.mixedFrameRates).toEqual([{ footage: "plate.mov", fps: 24, comps: ["Shot (25)"] }]);
    expect(rep.weight.heavyEffects.map((h: any) => h.matchName)).toEqual(["CC Particle World"]); // not Particular: not installed
    expect(rep.weight.hiddenCost[0]).toMatchObject({ at: "Main > 4: FX", is: ["shy"] });
    expect(rep.weight.comps[0]).toMatchObject({ comp: "Main", highSamples: true, motionBlur: { layers: 1, samplesPerFrame: 32 } });
    expect(rep.weight.oversizedFootage[0]).toMatch(/Shot > 1: Plate: 3840x2160 shown at 40%/);
  });

  it("scopes to comps and their precomps, and picks sections", () => {
    const fp = fakeProject(INHERITED);
    const res = fp.run(tool.jsx, { comps: ["active"], sections: ["footage"] });
    const raw = JSON.parse(res.result);
    expect(raw.scope).toEqual([fp.comps[1].id]);
    expect(raw.comps.filter((c: any) => c.layers).map((c: any) => c.name)).toEqual(["Shot"]);
    expect(raw.comps[1].layers[0].ex).toBeUndefined();
    const rep = JSON.parse(tool.format!(res.result, {}).split("\n")[1]);
    expect(Object.keys(rep).sort()).toEqual(["footage", "project"]);
    expect(rep.project.scope).toEqual(["Shot"]);
    const byName = fp.run(tool.jsx, { comps: ["Main"], sections: ["render"] });
    expect(JSON.parse(byName.result).comps.filter((c: any) => c.layers).map((c: any) => c.name)).toEqual(["Main", "Shot"]);
    expect(fp.run(tool.jsx, { comps: ["plate.mov"] }).error.message).toMatch(/not a composition/);
  });

  it("stops at the layer limit and reports a partial result", () => {
    const fp = fakeProject(INHERITED);
    const res = fp.run(tool.jsx, { maxLayers: 2 });
    const raw = JSON.parse(res.result);
    expect(raw.partial).toEqual({ reason: "layer limit (2) reached" });
    expect(raw.layersScanned).toBe(2);
    expect(tool.format!(res.result, {}).split("\n")[0]).toMatch(/PARTIAL: layer limit/);
  });

  it("works without the font API (before AE 24)", () => {
    const fp = fakeProject({ ...INHERITED, fonts: null });
    const rep = JSON.parse(tool.format!(fp.run(tool.jsx, { sections: ["missing"] }).result, {}).split("\n")[1]);
    expect(rep.missing.fonts.note).toMatch(/24\.0/);
    expect(rep.missing.fonts.textLayerFonts).toEqual([{ font: "Gotham-Bold", textLayers: 1 }]);
  });
});
