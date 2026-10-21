// ae_precomp_surgery against a fake After Effects (fake-surgery.ts): the real ExtendScript (facts, rehearsal, surgery,
// cleanup) runs there; ae_prove_identical's renders are faked from the fake's picture of a comp (what its visible layers
// show, flattened through precomps), so a correct surgery is IDENTICAL and anything else DIFFERS. A temporary home:
// proofs and checkpoints never touch the real ~/.surehand.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePng } from "../src/png.js";
import { fakeSurgeryAE, type SComp } from "./fake-surgery.js";

const home = mkdtempSync(join(tmpdir(), "surehand-surgery-"));
vi.mock("node:os", async (orig) => ({ ...(await orig<typeof import("node:os")>()), homedir: () => home }));

const projectFile = join(home, "spot.aep");
writeFileSync(projectFile, "aep");
let fake: ReturnType<typeof fakeSurgeryAE>;
/** test hooks: a picture that differs for some comps; something to do when the proof compares */
let skew: ((comp: any) => boolean) | null = null;
let onCompare: (() => void) | null = null;
let calls: { kind: string; args: any; opts: any }[] = [];
/** test hooks: change a script's arguments on the way to After Effects; run before every script */
let mangle: ((args: any) => void) | null = null;
let onJsx: (() => void) | null = null;

function png(text: string): Buffer {
  let h = 7;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 251;
  return encodePng(4, 4, new Uint8Array(4 * 4 * 4).map((_, i) => (i % 4 === 3 ? 255 : h)), 4);
}

vi.mock("../src/jsx.js", async (orig) => {
  const real = await orig<typeof import("../src/jsx.js")>();
  return {
    ...real,
    runJsx: async (body: string, args: any, opts: any) => {
      const { PROVE_RENDER_JSX } = await import("../src/tools/prove.js");
      const kind = body === PROVE_RENDER_JSX ? "render" : body.includes("nothing to checkpoint") ? "checkpoint" : "jsx";
      calls.push({ kind, args, opts });
      if (kind === "checkpoint") return { ok: true, logs: [], result: projectFile };
      if (kind === "render") {
        if (args.comps.some((c: any) => c.id !== undefined)) onCompare?.();
        const out = args.comps.map((spec: any) => {
          const byId = (id: number) => fake.items().find((i: any) => i.id === id);
          const c = spec.id !== undefined ? byId(spec.id) : typeof spec.ref === "number" ? byId(spec.ref) : fake.comp(spec.ref);
          if (!c) return { id: spec.id, missing: true };
          const times: number[] = spec.times ?? args.times ?? Array.from({ length: args.frames ?? 5 }, (_, i) => (i * (c.duration - 1 / c.frameRate)) / Math.max(1, (args.frames ?? 5) - 1));
          const frames = times.map((t: number, j: number) => {
            const path = join(args.dir, `${args.prefix}${c.id}_${j}.png`);
            writeFileSync(path, png(fake.picture(c, t) + (skew?.(c) ? "|skewed" : "")));
            return { time: t, path };
          });
          return { id: c.id, name: c.name, width: c.width, height: c.height, pixelAspect: 1, frameRate: c.frameRate, renderW: 4, renderH: 4, frames };
        });
        return { ok: true, logs: [], result: { project: projectFile, comps: out, tmpLeft: false } };
      }
      onJsx?.();
      if (mangle) {
        args = JSON.parse(JSON.stringify(args));
        mangle(args);
      }
      return fake.run(body, args, opts);
    },
  };
});

const { runSurgery, likelyCause, UFACTS_JSX, DFACTS_JSX, UNPRECOMPOSE_JSX, DEEPDUP_JSX, CLEANUP_JSX, REMOVE_COPIES_JSX } = await import("../src/tools/surgery.js");
const { planUnprecompose, planDeepDuplicate, blocking } = await import("../src/surgery/plan.js");

const FULL = { mode: "full", allowShell: false };
const text = (r: any) => r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
const names = (c: any) => c.layers.map((l: any) => l.name);
const ae = (comps: SComp[], more: Partial<Parameters<typeof fakeSurgeryAE>[0]> = {}) => (fake = fakeSurgeryAE({ comps, file: projectFile, ...more }));
const times = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5];
const pictures = (c: any) => times.map((t) => fake.picture(c, t));
const checkpoints = () => {
  try {
    return readdirSync(join(home, ".surehand", "ae", "checkpoints")).flatMap((d) => readdirSync(join(home, ".surehand", "ae", "checkpoints", d)).filter((f) => f.endsWith(".aep")));
  } catch {
    return [];
  }
};

beforeEach(() => {
  mangle = null;
  onJsx = null;
  skew = null;
  onCompare = null;
  calls = [];
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** Main: a top layer, the precomp layer "Logo" (moved and scaled), a bottom layer. Logo comp: Title, Mark, Glow (Mark's child). */
const spot = (logo: Partial<SComp["layers"][number]> = {}, inner: Partial<SComp["layers"][number]>[] = [], more: Partial<SComp> = {}): SComp[] => [
  {
    name: "Logo Comp", width: 800, height: 400,
    layers: [
      { name: "Title", type: "text", position: [400, 100], rect: [-100, -20, 200, 40], ...inner[0] },
      { name: "Mark", position: [400, 250], size: [100, 100], keys: { position: [[0, [300, 250]], [2, [500, 250]]] }, ...inner[1] },
      { name: "Glow", parent: "Mark", position: [0, 0], size: [50, 50], ...inner[2] },
    ],
    ...more,
  },
  {
    name: "Main",
    layers: [
      { name: "Top", position: [100, 100] },
      { name: "Logo", type: "precomp", source: "Logo Comp", position: [960, 540], scale: [50, 50, 100], ...logo },
      { name: "Title", type: "text", position: [960, 900], expr: { "Transform/Position": 'thisComp.layer("Logo").transform.position + [0, 300]' } },
      { name: "BG", size: [1920, 1080] },
    ],
  },
];

describe("the scripts", () => {
  it("are valid ES3", async () => {
    const { parse } = await import("acorn");
    for (const body of [UFACTS_JSX, DFACTS_JSX, UNPRECOMPOSE_JSX, DEEPDUP_JSX, CLEANUP_JSX, REMOVE_COPIES_JSX]) expect(() => parse(`(function(args, log){${body}\n})`, { ecmaVersion: 3, allowReserved: false })).not.toThrow();
  });
});

describe("un-precompose: the plan", () => {
  const facts = (comps: SComp[], layer: string | number = "Logo", comp = "Main") => {
    ae(comps);
    const r = fake.run(UFACTS_JSX, { comp, layer });
    if (!r.ok) throw new Error(r.error.message);
    return r.result;
  };

  it("reads the precomp layer, its comp's layers and every expression, and changes nothing", () => {
    const before = (ae(spot()), fake.state());
    const f = fake.run(UFACTS_JSX, { comp: "Main", layer: "Logo" }).result;
    expect(fake.state()).toBe(before);
    expect(f.L).toMatchObject({ i: 2, n: "Logo", start: 0, in: 0, out: 4, blend: "NORMAL", effects: 0, tf: { s: [50, 50, 100], keyed: false } });
    expect(f.cLayers.map((x: any) => [x.i, x.n, x.type, x.par])).toEqual([[1, "Title", "text", 0], [2, "Mark", "av", 0], [3, "Glow", "av", 2]]);
    expect(f.exprs).toEqual([expect.objectContaining({ ln: "Title", pn: "Transform/Position", mp: ["ADBE Transform Group", "ADBE Position"] })]);
  });

  it("a layer that is not a precomp layer is refused by the read itself", () => {
    ae(spot());
    expect(fake.run(UFACTS_JSX, { comp: "Main", layer: "Top" }).error.message).toMatch(/not a precomp layer/);
  });

  it("names: a clash in the parent comp gets a unique name; the null goes at the precomp layer's index; the layers below move down", () => {
    const p = planUnprecompose(facts(spot()));
    expect(p.nullLayer).toEqual({ name: "Logo (null)", index: 2 });
    expect(p.moved.map((m) => [m.from, m.to, m.index, m.parent])).toEqual([["Title", "Title 2", 3, "null"], ["Mark", "Mark", 4, "null"], ["Glow", "Glow", 5, 2]]);
    expect(p.shift).toBe(3);
    // the comp's own Title referred to the precomp layer: that blocks
    expect(blocking(p).map((x) => x.text)).toEqual([expect.stringMatching(/Main > 3 "Title" > Transform\/Position: thisComp.layer\("Logo"\): refers to the precomp layer "Logo", which the un-precompose removes/)]);
  });

  it("rewrites thisComp references in the moved layers to the new names, indices and comp(\"C\")", () => {
    const f = facts(spot({}, [{ expr: { "Transform/Position": 'thisComp.layer("Mark").transform.position + [thisComp.width / 4, 0] + thisComp.layer(3).transform.anchorPoint' } }, {}, { expr: { "Transform/Opacity": 'thisComp.layer("Title").transform.opacity' } }]).map((c) => (c.name === "Main" ? { ...c, layers: c.layers.map((l) => (l.name === "Title" ? { ...l, expr: undefined } : l)) } : c)));
    const p = planUnprecompose(f);
    expect(blocking(p)).toEqual([]);
    expect(p.movedRewrites.map((r) => [r.ln, r.new])).toEqual([
      ["Title", 'thisComp.layer("Mark").transform.position + [comp("Logo Comp").width / 4, 0] + thisComp.layer(5).transform.anchorPoint'],
      ["Glow", 'thisComp.layer("Title 2").transform.opacity'],
    ]);
    expect(p.movedRewrites[1].snippet).toBe('thisComp.layer("Title").transform.opacity → thisComp.layer("Title 2").transform.opacity');
  });

  it("rewrites references to the parent comp's layers by index (they move down), here and in other comps; L by index or name blocks", () => {
    const comps = spot();
    comps[1].layers[2].expr = { "Transform/Position": "thisComp.layer(4).transform.position + thisComp.layer(1).transform.position" };
    comps.push({ name: "Other", layers: [{ name: "A", expr: { "Transform/Position": 'comp("Main").layer(3).transform.position', "Transform/Opacity": 'comp("Main").layer(2).transform.opacity' } }] });
    const p = planUnprecompose(facts(comps));
    expect(p.rewrites.map((r) => r.new)).toEqual(["thisComp.layer(7).transform.position + thisComp.layer(1).transform.position", 'comp("Main").layer(6).transform.position']);
    // in the rehearsal (a scratch copy of Main), comp("Main") still means the real, unchanged Main: not rewritten there
    expect(p.rewrites.map((r) => r.rehearse)).toEqual(["thisComp.layer(7).transform.position + thisComp.layer(1).transform.position", 'comp("Main").layer(3).transform.position']);
    expect(blocking(p).map((x) => x.text)).toEqual([expect.stringMatching(/Other > 1 "A" > Transform\/Opacity: comp\("Main"\).layer\(2\): refers to the precomp layer "Logo" by index/)]);
  });

  it("refuses what can't be reproduced exactly, each with its reason", () => {
    const cases: [Partial<SComp["layers"][number]>, RegExp][] = [
      [{ effects: [{ name: "Blur" }] }, /"Logo" has 1 effect; they apply to the precomp's whole picture/],
      [{ masks: 2 }, /"Logo" has 2 masks/],
      [{ timeRemap: true }, /time remapping/],
      [{ stretch: 50 }, /time-stretched \(50%\)/],
      [{ blend: "ADD" }, /"Logo" uses the add blend mode, and "Logo Comp" has 3 visible layers/],
      [{ opacity: 50 }, /"Logo"'s opacity is 50%, and "Logo Comp" has 3 visible layers: opacity applies to their combined picture/],
      [{ threeD: true }, /is a 3D layer/],
      [{ collapse: true }, /collapses transformations/],
      [{ motionBlur: true }, /motion blur on in "Main"/],
      [{ preserveTransparency: true }, /Preserve Underlying Transparency/],
      [{ eps: 2 }, /2 Essential Properties \(master properties\)/],
      [{ enabled: false }, /switched off/],
    ];
    for (const [logo, re] of cases) {
      const comps = spot(logo);
      comps[1].layers[2].expr = undefined;
      comps[1].motionBlur = true;
      const p = planUnprecompose(facts(comps));
      expect(blocking(p).map((x) => x.text).join("\n"), String(re)).toMatch(re);
    }
  });

  it("refuses layers in the precomp that would interact with the parent comp's layers", () => {
    const cases: [Partial<SComp["layers"][number]>[], RegExp][] = [
      [[{ blend: "SCREEN" }], /"Logo Comp" > 1 "Title" uses the screen blend mode: in "Main" it would blend with the layers below "Logo"/],
      [[{ type: "adjustment" }], /is an adjustment layer: in "Main" it would also adjust the layers below "Logo"/],
      [[{ type: "camera" }], /is a camera/],
      [[{ threeD: true }], /3D layer: it is seen through "Logo Comp"'s camera/],
      [[{ solo: true }], /is soloed/],
      [[{}, { motionBlur: true }], /motion blur on, and "Logo Comp" and "Main" have different motion blur settings/],
    ];
    for (const [inner, re] of cases) {
      const comps = spot({}, inner);
      comps[1].layers[2].expr = undefined;
      comps[1].motionBlur = true;
      expect(blocking(planUnprecompose(facts(comps))).map((x) => x.text).join("\n"), String(re)).toMatch(re);
    }
    const fps = spot();
    fps[0].fps = 30;
    fps[1].layers[2].expr = undefined;
    expect(blocking(planUnprecompose(facts(fps))).map((x) => x.text).join("\n")).toMatch(/"Logo Comp" is 30 fps and "Main" is 25 fps/);
  });

  it("expressions that can't be rewritten safely block, unless overridden (still reported)", () => {
    const comps = spot({ startTime: 1, inPoint: 1 }, [
      { expr: { "Transform/Position": "thisComp.layer(index + 1).transform.position" } },
      { expr: { "Transform/Rotation": "time * 10 + index" } },
      { expr: { "Transform/Opacity": "wiggle(2, 10)" } },
    ]);
    comps[1].layers[2].expr = undefined;
    const f = facts(comps);
    const p = planUnprecompose(f);
    const t = blocking(p).map((x) => x.text).join("\n");
    expect(t).toMatch(/thisComp.layer\(index \+ 1\): picks a layer of "Logo Comp" by a computed name or index/);
    expect(t).toMatch(/uses time, which is 1s later in "Main" than in "Logo Comp"/);
    expect(t).toMatch(/uses its own layer index \(index\), which changes from 2 to 4/);
    expect(t).toMatch(/uses wiggle: its random seed depends on the layer's index, which changes from 3 to 5/);
    expect(p.problems.every((x) => x.override === "expressions")).toBe(true);
    const o = planUnprecompose(f, { override: ["expressions"] });
    expect(blocking(o, ["expressions"])).toEqual([]);
    expect(o.risks).toEqual(expect.arrayContaining(p.problems.map((x) => x.text)));
    expect(p.problems).toHaveLength(5); // Title also uses index itself
  });

  it("an expression with an error before the surgery is reported and blocks (it could start working); a switched-off one never blocks", () => {
    const comps = spot({}, [{ expr: { "Transform/Position": { x: 'thisComp.layer("Nope").position', err: "Layer named Nope is missing" } } }, { expr: { "Transform/Opacity": { x: "thisComp.layer(index - 1).opacity", on: false } } }]);
    comps[1].layers[2].expr = undefined;
    const p = planUnprecompose(facts(comps));
    expect(blocking(p).map((x) => x.text)).toEqual([expect.stringMatching(/Logo Comp > 1 "Title" > Transform\/Position: has an error before the surgery \("Layer named Nope is missing"\)/)]);
    // the broken reference is kept broken exactly: it points at "Logo Comp", which has no such layer
    expect(p.movedRewrites[0].new).toBe('comp("Logo Comp").layer("Nope").position');
    expect(p.notes.join("\n")).toMatch(/Mark" > Transform\/Opacity: the expression is switched off/);
  });

  it("layers outside the precomp's frame (where it shows in the parent comp) block unless overridden; inside or cut by the parent's frame anyway, fine", () => {
    const wide = spot({ scale: [100, 100, 100] }, [{}, { position: [790, 250], keys: undefined }]);
    wide[1].layers[2].expr = undefined;
    const p = planUnprecompose(facts(wide));
    expect(blocking(p).map((x) => x.text)).toEqual([expect.stringMatching(/"Logo Comp" > 2 "Mark" reaches up to 40 px outside "Logo Comp"'s 800x400 frame .* the precomp cut that part off, and in "Main" it would show/)]);
    expect(blocking(p, ["bounds"])).toEqual([]);
    // the same comp filling the parent's frame exactly: what C cut off is outside the parent's frame too
    const full = spot({ scale: [100, 100, 100], anchor: [400, 200], position: [400, 200] }, [{}, { position: [790, 250], keys: undefined }]);
    full[0].width = 1920;
    full[0].height = 1080;
    full[1].layers[2].expr = undefined;
    full[0].layers[1].position = [1910, 250];
    expect(blocking(planUnprecompose(facts(full)))).toEqual([]);
  });

  it("one visible layer: the precomp layer's opacity and blend mode carry over exactly", () => {
    const comps: SComp[] = [
      { name: "Badge", width: 400, height: 400, layers: [{ name: "Star", opacity: 80, position: [200, 200] }] },
      { name: "Main", layers: [{ name: "Badge", type: "precomp", source: "Badge", opacity: 50, blend: "SCREEN" }, { name: "BG", size: [1920, 1080] }] },
    ];
    const p = planUnprecompose(facts(comps, "Badge"));
    expect(blocking(p)).toEqual([]);
    expect(p.carry).toEqual({ ci: 1, blend: "SCREEN", opacity: 40 });
  });

  it("removeSource: only when nothing else uses the comp", () => {
    const comps = spot();
    comps[1].layers[2].expr = undefined;
    expect(planUnprecompose(facts(comps), { removeSource: true }).removeC).toBe(true);
    comps.push({ name: "Other", layers: [{ name: "Again", type: "precomp", source: "Logo Comp" }] });
    const p = planUnprecompose(facts(comps), { removeSource: true });
    expect(p.removeC).toBe(false);
    expect(blocking(p).map((x) => x.text)).toEqual([expect.stringMatching(/"Logo Comp" can't be removed: used in "Other"/)]);
    // a rewrite to comp("Logo Comp") needs it
    const w = spot({}, [{ expr: { "Transform/Position": "[thisComp.width, 0]" } }]);
    w[1].layers[2].expr = undefined;
    expect(blocking(planUnprecompose(facts(w), { removeSource: true })).map((x) => x.text).join("\n")).toMatch(/thisComp.width means "Logo Comp"'s width; it would have to become comp\("Logo Comp"\).width, but "Logo Comp" is to be removed/);
  });

  it("bakeNull: only for an identity transform with no children", () => {
    const comps: SComp[] = [
      { name: "Full", layers: [{ name: "A" }, { name: "B" }] },
      { name: "Main", layers: [{ name: "Full", type: "precomp", source: "Full" }, { name: "BG", size: [1920, 1080] }] },
    ];
    const p = planUnprecompose(facts(comps, "Full"), { bakeNull: true });
    expect(p.nullLayer).toBeNull();
    expect(p.moved.map((m) => m.index)).toEqual([1, 2]);
    const q = planUnprecompose(facts(spot(), "Logo"), { bakeNull: true });
    expect(q.nullLayer).not.toBeNull();
    expect(q.nullNote).toMatch(/A null is kept: baking it away is exact only when "Logo"'s transform is the identity/);
  });

  it("a precomp layer named like its comp: comp(\"Logo\") and thisComp.layer(\"Logo\") are told apart", () => {
    const comps = spot();
    comps[0].name = "Logo";
    comps[1].layers[1].source = "Logo";
    comps[1].layers[2].expr = { "Transform/Opacity": 'comp("Logo").layer("Title").transform.opacity' };
    comps[0].layers[0].expr = { "Transform/Opacity": 'comp("Logo").layer("Mark").transform.opacity + thisComp.layer("Mark").transform.opacity' };
    const p = planUnprecompose(facts(comps));
    // comp("Logo") is the source comp, which stays: nothing to rewrite or block
    expect(blocking(p)).toEqual([]);
    expect(p.movedRewrites.map((r) => r.new)).toEqual([]);
    expect(p.rewrites).toEqual([]);
    // the layer by that name blocks; the comp by that name doesn't
    comps[1].layers[2].expr = { "Transform/Opacity": 'thisComp.layer("Logo").transform.opacity + comp("Logo").width' };
    expect(blocking(planUnprecompose(facts(comps))).map((x) => x.text)).toEqual([expect.stringMatching(/thisComp.layer\("Logo"\): refers to the precomp layer "Logo"/)]);
    // removing the comp: comp("Logo") references to it keep it
    comps[1].layers[2].expr = { "Transform/Opacity": 'comp("Logo").layer("Title").transform.opacity' };
    expect(blocking(planUnprecompose(facts(comps), { removeSource: true })).map((x) => x.text).join("\n")).toMatch(/"Logo" can't be removed: expressions refer to it by name/);
  });

  it("names the resampling risk of a scaled precomp layer", () => {
    expect(planUnprecompose(facts(spot())).risks.join("\n")).toMatch(/"Logo" is scaled \(50%, 50%\): the precomp was rendered first and then resampled/);
  });
});

describe("un-precompose: the tool", () => {
  const plain = (logo: Partial<SComp["layers"][number]> = {}, inner: Partial<SComp["layers"][number]>[] = []) => {
    const comps = spot(logo, inner);
    comps[1].layers[2].expr = undefined;
    return comps;
  };

  it("dryRun: the plan, nothing changed, no checkpoint", async () => {
    ae(plain());
    const before = fake.state(), cps = checkpoints().length;
    const r = await runSurgery({ action: "unprecompose", comp: "Main", layer: "Logo", dryRun: true }, FULL);
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/^PLAN \(nothing was changed\): the un-precompose can be done/);
    expect(text(r)).toMatch(/3: "Title" renamed "Title 2" \(the name is taken in "Main"\)/);
    expect(fake.state()).toBe(before);
    expect(checkpoints().length).toBe(cps);
  });

  it("does it: proven identical, one step, the rehearsal removed; the picture is unchanged", async () => {
    ae(plain({}, [{ expr: { "Transform/Opacity": 'thisComp.layer("Mark").transform.opacity' } }, { locked: true }]));
    const main = fake.comp("Main");
    const before = pictures(main), start = fake.state();
    const itemsBefore = fake.items().length;
    const r = await runSurgery({ action: "unprecompose", comp: "Main", layer: "Logo" }, FULL);
    expect(r.isError, text(r)).toBeFalsy();
    const t = text(r);
    expect(t).toMatch(/^DONE and proven: IDENTICAL: all 6 frames are bit-identical to the reference \(6 frames compared/);
    expect(t).toMatch(/Checkpoint saved first: /);
    expect(t).not.toMatch(/One undo step/);
    expect(t).toMatch(/Made in one undo group \("Surehand MCP un-precompose"\), but After Effects can split such a step .* ae_undo may take several steps and is not a reliable way back\. The exact way back is the checkpoint saved first: ae_checkpoint \{action: "restore", id: "[\w-]+"\}/);
    expect(names(main)).toEqual(["Top", "Logo (null)", "Title 2", "Mark", "Glow", "Title", "BG"]);
    expect(pictures(main)).toEqual(before);
    // parents: top-level layers on the null, Glow still on Mark; Mark stays locked
    expect(main.layers.map((l: any) => l.parent?.name ?? null)).toEqual([null, null, "Logo (null)", "Logo (null)", "Mark", null, null]);
    expect(main.layer("Mark").locked).toBe(true);
    // the rehearsal's scratch comp and its null solid are gone; the real null's solid stays
    expect(fake.items().map((i: any) => i.name)).not.toContain("Main (Surehand rehearsal)");
    expect(fake.items().length).toBe(itemsBefore + 1);
    // the source comp is kept and unchanged
    expect(names(fake.comp("Logo Comp"))).toEqual(["Title", "Mark", "Glow"]);
    // order of the calls: facts, checkpoint, reference, rehearsal, comparison, cleanup, the surgery (one undo group)
    expect(calls.map((c) => c.kind)).toEqual(["jsx", "checkpoint", "render", "jsx", "render", "jsx", "jsx"]);
    expect(calls[6].opts).toMatchObject({ undoGroup: "Surehand MCP un-precompose", rollback: "requested" });
    expect(calls[6].args.expect).toEqual(expect.any(String));
    // in the fake (an After Effects that keeps the group whole) one undo step puts the parent comp back exactly, the null's solid included
    expect(fake.undo()).toBe("Surehand MCP un-precompose");
    expect(fake.state()).toBe(start);
  });

  it("time: the layers move by the precomp layer's start and are trimmed to its span; one entirely outside is switched off", async () => {
    ae(plain({ startTime: 1, inPoint: 1.5, outPoint: 3 }, [{ inPoint: 0, outPoint: 4 }, { inPoint: 2.5, outPoint: 4 }, {}]));
    const main = fake.comp("Main");
    const before = pictures(main);
    const r = await runSurgery({ action: "unprecompose", comp: "Main", layer: "Logo" }, FULL);
    expect(r.isError, text(r)).toBeFalsy();
    expect(pictures(main)).toEqual(before);
    const L = (n: string) => main.layer(n);
    expect([L("Title 2").startTime, L("Title 2").inPoint, L("Title 2").outPoint]).toEqual([1, 1.5, 3]);
    expect(L("Mark").enabled).toBe(false);
    expect(text(r)).toMatch(/4: "Mark"; moved later by 1s, outside "Logo"'s time span \(1.5s-3s\), so switched off/);
    // keyframes moved with the layer
    expect(L("Glow").property("ADBE Transform Group").property("ADBE Position").valueAtTime(0)).toEqual([0, 0]);
    expect(L("Mark").property("ADBE Transform Group").property("ADBE Position").keyTime(1)).toBe(1);
  });

  it("expressions are rewritten in the project: the moved copies, the parent comp's index references, other comps", async () => {
    const comps = plain({}, [{ expr: { "Transform/Opacity": 'thisComp.layer("Glow").transform.opacity * thisComp.height / 400' } }]);
    comps[1].layers[3].expr = { "Transform/Rotation": "thisComp.layer(1).transform.rotation + thisComp.layer(3).transform.rotation" };
    comps.push({ name: "Other", layers: [{ name: "A", expr: { "Transform/Position": 'comp("Main").layer(4).transform.position' } }] });
    ae(comps);
    const r = await runSurgery({ action: "unprecompose", comp: "Main", layer: "Logo" }, FULL);
    expect(r.isError, text(r)).toBeFalsy();
    const main = fake.comp("Main");
    const ex = (c: any, l: string, m: string) => c.layer(l).property("ADBE Transform Group").property(m).expression;
    expect(ex(main, "Title 2", "ADBE Opacity")).toBe('thisComp.layer("Glow").transform.opacity * comp("Logo Comp").height / 400');
    expect(ex(main, "BG", "ADBE Rotate Z")).toBe("thisComp.layer(1).transform.rotation + thisComp.layer(6).transform.rotation");
    expect(ex(fake.comp("Other"), "A", "ADBE Position")).toBe('comp("Main").layer(7).transform.position');
    // the original in Logo Comp keeps its text
    expect(ex(fake.comp("Logo Comp"), "Title", "ADBE Opacity")).toBe('thisComp.layer("Glow").transform.opacity * thisComp.height / 400');
    expect(text(r)).toMatch(/Expressions rewritten \(3\):/);
    expect(text(r)).toMatch(/elsewhere:\n {2}- Main > 4 "BG" > Transform\/Rotation: ….transform.rotation \+ thisComp.layer\(3\).transform.rotation → ….transform.rotation \+ thisComp.layer\(6\).transform.rotation/);
  });

  it("the null carries the precomp layer's animated transform and its children", async () => {
    const comps = plain({ keys: { position: [[0, [800, 500]], [2, [1100, 600]]] } });
    comps[1].layers.push({ name: "Follower", parent: "Logo", position: [10, 10] });
    ae(comps);
    const main = fake.comp("Main");
    const before = pictures(main);
    const r = await runSurgery({ action: "unprecompose", comp: "Main", layer: "Logo" }, FULL);
    expect(r.isError, text(r)).toBeFalsy();
    expect(pictures(main)).toEqual(before);
    expect(main.layer("Follower").parent.name).toBe("Logo (null)");
    expect(main.layer("Logo (null)").property("ADBE Transform Group").property("ADBE Position").numKeys).toBe(2);
  });

  it("Layer Control parameters and track mattes point at the moved layers", async () => {
    const comps = plain({}, [{ matte: { layer: "Glow", type: "LUMA" } }, { effects: [{ name: "Ctrl", layerParam: 1 }] }]);
    ae(comps);
    const r = await runSurgery({ action: "unprecompose", comp: "Main", layer: "Logo" }, FULL);
    expect(r.isError, text(r)).toBeFalsy();
    const main = fake.comp("Main");
    expect(main.layer("Title 2").trackMatteLayer.name).toBe("Glow");
    expect(main.layer("Mark").property("ADBE Effect Parade").property(1).property(1).value).toBe(3);
  });

  it("copyToComp's rule (no parent or linked expression while an undo group is open) is enforced by the fake", () => {
    ae(plain());
    const r = fake.run('app.project.item(1).layer("Glow").copyToComp(app.project.item(2)); return 1;', {}, { undoGroup: "x" });
    expect(r.error.message).toMatch(/Can't copy a layer with a parent or with a linked expression, while an Undo Group is open/);
  });

  it("linked layers (parent, expressions, track matte, Layer Control) are detached to copy them and put back exactly in the source", async () => {
    const comps = plain({}, [
      { matte: { layer: "Glow", type: "ALPHA" }, expr: { "Transform/Opacity": 'thisComp.layer("Mark").transform.opacity' } },
      { effects: [{ name: "Ctrl", layerParam: 3 }], expr: { "Transform/Rotation": { x: "time * 0", on: false } } },
      { locked: true },
    ]);
    ae(comps);
    const src = fake.comp("Logo Comp");
    const snap = () => JSON.stringify(src.layers.map((l: any) => [l.name, l.locked, l.parent?.name ?? null, l.trackMatteLayer?.name ?? null, l.trackMatteType]));
    const before = snap(), main = fake.comp("Main"), pics = pictures(main);
    const ex = (c: any, l: string, m: string) => c.layer(l).property("ADBE Transform Group").property(m);
    const r = await runSurgery({ action: "unprecompose", comp: "Main", layer: "Logo" }, FULL);
    expect(r.isError, text(r)).toBeFalsy();
    expect(pictures(main)).toEqual(pics);
    // the source is as it was: links, expressions (and their switches), layer parameters, locks
    expect(snap()).toBe(before);
    expect(ex(src, "Title", "ADBE Opacity").expression).toBe('thisComp.layer("Mark").transform.opacity');
    expect([ex(src, "Mark", "ADBE Rotate Z").expression, ex(src, "Mark", "ADBE Rotate Z").expressionEnabled]).toEqual(["time * 0", false]);
    expect(src.layer("Mark").property("ADBE Effect Parade").property(1).property(1).value).toBe(3);
    // the copies have them too, pointed at the moved layers
    expect(main.layer("Glow").parent.name).toBe("Mark");
    expect(main.layer("Glow").locked).toBe(true);
    expect(main.layer("Title 2").trackMatteLayer.name).toBe("Glow");
    expect(ex(main, "Title 2", "ADBE Opacity").expression).toBe('thisComp.layer("Mark").transform.opacity');
    expect([ex(main, "Mark", "ADBE Rotate Z").expression, ex(main, "Mark", "ADBE Rotate Z").expressionEnabled]).toEqual(["time * 0", false]);
    expect(main.layer("Mark").property("ADBE Effect Parade").property(1).property(1).value).toBe(5);
  });

  it("the source can't be put back exactly: refused loudly, undone, and nothing is left behind (no stray null solid)", async () => {
    ae(plain());
    const glow = fake.comp("Logo Comp").layer("Glow"), jump = glow.setParentWithJump;
    // After Effects keeps the layer unparented
    glow.setParentWithJump = (p: any) => (p ? undefined : jump(p));
    const before = fake.state();
    const r = await runSurgery({ action: "unprecompose", comp: "Main", layer: "Logo" }, FULL);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/The rehearsal on a scratch copy stopped: the source comp "Logo Comp" could not be put back exactly after copying its layers\. It was undone: nothing changed\./);
    expect(fake.state()).toBe(before);
    expect(fake.items().map((i: any) => i.name).filter((n: string) => /^Null/.test(n))).toEqual([]);
  });

  it("stacking order: right wherever After Effects puts a copy (here: above the selected layer, as pasting does), read back in the report", async () => {
    const comps: SComp[] = [
      { name: "Pre1b", layers: [{ name: "Title", type: "text", position: [960, 540], rect: [-100, -30, 200, 60] }, { name: "Box", size: [300, 300], keys: { position: [[0, [400, 400]], [4, [1500, 700]]] } }] },
      { name: "Main1b", layers: [{ name: "Pre1b", type: "precomp", source: "Pre1b" }] },
    ];
    ae(comps, { copyInsert: "aboveSelection" });
    const main = fake.comp("Main1b"), pics = pictures(main);
    const r = await runSurgery({ action: "unprecompose", comp: "Main1b", layer: "Pre1b" }, FULL);
    expect(r.isError, text(r)).toBeFalsy();
    expect(names(main)).toEqual(["Pre1b (null)", "Title", "Box"]);
    expect(pictures(main)).toEqual(pics);
    expect(text(r)).toMatch(/Read back from "Main1b" after the surgery: 1 "Pre1b \(null\)", 2 "Title", 3 "Box"\./);
  });

  it("the placement is checked by the numbers before the precomp layer goes: a moved layer that isn't where the precomp showed it stops the rehearsal, with the values", async () => {
    const comps: SComp[] = [
      { name: "Pre", layers: [{ name: "Title", type: "text", position: [960, 540] }, { name: "Box", size: [300, 300], position: [400, 400] }] },
      { name: "Main", layers: [{ name: "Pre", type: "precomp", source: "Pre", position: [700, 500], scale: [50, 50, 100] }] },
    ];
    ae(comps, { jumpIgnored: true });
    const before = fake.state();
    const r = await runSurgery({ action: "unprecompose", comp: "Main", layer: "Pre" }, FULL);
    expect(r.isError).toBe(true);
    const t = text(r);
    expect(t).toMatch(/The rehearsal on a scratch copy stopped: parenting "Title" failed: wanted "Pre \(null\)" \(layer 1\), got none \(planned: "the null"\)/);
  });

  it("parents come from the source comp, not from the plan's arguments (a lost or wrong argument changes nothing)", async () => {
    const comps: SComp[] = [
      { name: "Pre", layers: [{ name: "Title", type: "text", position: [960, 300] }, { name: "Box", size: [300, 300], position: [400, 400] }, { name: "Child", parent: "Box", position: [10, 10] }] },
      { name: "Main", layers: [{ name: "Pre", type: "precomp", source: "Pre", position: [700, 500] }] },
    ];
    ae(comps);
    const main = fake.comp("Main"), pics = pictures(main);
    // the arguments' planned parents are dropped on the way to After Effects
    mangle = (args) => args.moved && args.moved.forEach((m: any) => delete m.par);
    const r = await runSurgery({ action: "unprecompose", comp: "Main", layer: "Pre" }, FULL);
    expect(r.isError, text(r)).toBeFalsy();
    expect(pictures(main)).toEqual(pics);
    expect(main.layers.map((l: any) => [l.name, l.parent?.name ?? null])).toEqual([["Pre (null)", null], ["Title", "Pre (null)"], ["Box", "Pre (null)"], ["Child", "Box"]]);
  });

  it("the placement check names the planned and actual parent", async () => {
    const comps: SComp[] = [
      { name: "Pre", layers: [{ name: "Title", type: "text", position: [960, 540] }] },
      { name: "Main", layers: [{ name: "Pre", type: "precomp", source: "Pre", position: [700, 500], scale: [50, 50, 100] }] },
    ];
    // an After Effects that moves the copy when it is parented
    ae(comps, { afterJump: (L: any, p: any) => p && L._comp.name.endsWith("(Surehand rehearsal)") && L.property("ADBE Transform Group").property("ADBE Position").setValue([0, 0]) });
    const before = fake.state();
    const r = await runSurgery({ action: "unprecompose", comp: "Main", layer: "Pre" }, FULL);
    expect(r.isError).toBe(true);
    const t = text(r);
    expect(t).toMatch(/placement check failed for "Title" at 0s \(planned parent: the null, actual: "Pre \(null\)"\): expected matrix \[0\.5, 0, 0, 0\.5, 700, 500\], got \[0\.5, 0, 0, 0\.5, 220, 230\]/);
    expect(t).toMatch(/the layer "Title" \(layer 2, parent "Pre \(null\)"\): anchor \[0, 0\], position \[0, 0\], scale \[100, 100, 100\], rotation 0; its original in Pre "Title" \(layer 1, parent none\): anchor \[0, 0\], position \[960, 540\].*the null "Pre \(null\)" \(layer 1, parent none\): anchor \[960, 540\], position \[700, 500\], scale \[50, 50, 100\]/);
    expect(fake.state()).toBe(before);
  });

  it("the diagnostic script (test/fixtures/surgery-diagnostic.js) runs the steps on a throwaway duplicate and leaves the project as it was", async () => {
    const { readFileSync } = await import("node:fs");
    const { transpileUserCode } = await import("../src/transpile.js");
    const code = readFileSync(new URL("./fixtures/surgery-diagnostic.js", import.meta.url), "utf8");
    ae(plain());
    const before = fake.state();
    const t = transpileUserCode(code);
    expect(t.syntaxError).toBeUndefined();
    const r = fake.run(`var __fn = eval(${JSON.stringify(t.source)});\nreturn __fn(args, log);`, { comp: "Main", layer: "Logo", t: 1 }, { undoGroup: "Surehand MCP" });
    expect(r.ok, r.error?.message).toBe(true);
    const lines: string[] = r.result.split("\n");
    const after = lines.filter((l) => l.startsWith("after the precomp layer was removed"));
    expect(after).toHaveLength(3);
    expect(after.every((l) => l.endsWith("ok"))).toBe(true);
    expect(r.result).toMatch(/null with the precomp layer's values \| \d+ Logo \(null\) \| parent none \| anchor \[400, 200\] position \[960, 540\] scale \[50, 50, 100\]/);
    expect(fake.state()).toBe(before);
  });

  it("the rehearsal's null solid is removed with its scratch comp; a missing id never stops the cleanup", async () => {
    ae(plain());
    const n = fake.items().length;
    const r = await runSurgery({ action: "unprecompose", comp: "Main", layer: "Logo" }, FULL);
    expect(r.isError, text(r)).toBeFalsy();
    expect(text(r)).not.toMatch(/could not all be removed/);
    // the real null's solid is the only new item
    expect(fake.items().map((i: any) => i.name).filter((x: string) => /^Null/.test(x))).toHaveLength(1);
    expect(fake.items().length).toBe(n + 1);
  });

  it("refused: nothing changed, no checkpoint, the reason for each problem", async () => {
    ae(spot({ effects: [{ name: "Blur" }] }));
    const before = fake.state(), cps = checkpoints().length;
    const r = await runSurgery({ action: "unprecompose", comp: "Main", layer: "Logo" }, FULL);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^REFUSED: the un-precompose can't be done exactly, so nothing was changed. 2 problems:/);
    expect(text(r)).toMatch(/"Logo" has 1 effect/);
    expect(text(r)).toMatch(/thisComp.layer\("Logo"\): refers to the precomp layer "Logo", which the un-precompose removes \[override: "expressions"\]/);
    expect(fake.state()).toBe(before);
    expect(checkpoints().length).toBe(cps);
    expect(calls.map((c) => c.kind)).toEqual(["jsx"]);
  });

  it("DIFFERS: never applied; the scratch copy is removed, the project is as it was; frames and the likely cause are reported", async () => {
    ae(plain());
    skew = (c) => / \(Surehand rehearsal\)$/.test(c.name);
    const before = fake.state();
    const r = await runSurgery({ action: "unprecompose", comp: "Main", layer: "Logo" }, FULL);
    expect(r.isError).toBe(true);
    const t = text(r);
    expect(t).toMatch(/^DIFFERS: the un-precompose was NOT applied\. It was rehearsed on a scratch copy, the copy did not render identical to the original, and the copy was removed: the project is as it was \(checkpoint /);
    expect(t).toMatch(/Verdict: DIFFERS in 6 of 6 frames/);
    expect(t).toMatch(/"Main" \(id \d+\) against "Main \(Surehand rehearsal\)" \(id \d+\)/);
    // the whole frame differs: far too much for resampling, which is not named as the cause
    expect(t).toMatch(/Likely cause: the difference is too large for resampling \(up to \d+(\.\d+)?\/255 on 100% of a frame\): the moved layers are not placed, timed or shown as they were/);
    expect(r.content.some((c: any) => c.type === "image")).toBe(true);
    expect(t).not.toMatch(/Could make the proof differ/);
    expect(fake.state()).toBe(before);
  });

  it("the project changed between the proof and applying it: the surgery is undone at once and says so", async () => {
    ae(plain());
    onCompare = () => fake.comp("Main").layers.addNull(4);
    const r = await runSurgery({ action: "unprecompose", comp: "Main", layer: "Logo" }, FULL);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/The rehearsal was proven identical, but applying it stopped: The project changed since the plan \(the number of layers changed\)\. Nothing was changed; plan again\. It was undone: nothing changed\./);
  });

  it("override: goes ahead with the problem reported, the proof decides", async () => {
    ae(plain({}, [{ expr: { "Transform/Opacity": 'var n = "Mark"; thisComp.layer(n).transform.opacity' } }]));
    const r = await runSurgery({ action: "unprecompose", comp: "Main", layer: "Logo", override: ["expressions"] }, FULL);
    expect(r.isError, text(r)).toBeFalsy();
    expect(text(r)).toMatch(/\[overridden\]/);
    expect(text(r)).toMatch(/Note: Overridden \(expressions\)/);
  });

  it("removeSource: the source comp goes in the same step", async () => {
    ae(plain());
    const r = await runSurgery({ action: "unprecompose", comp: "Main", layer: "Logo", removeSource: true }, FULL);
    expect(r.isError, text(r)).toBeFalsy();
    expect(fake.comp("Logo Comp")).toBeUndefined();
    expect(text(r)).toMatch(/"Logo Comp" will be removed \(nothing else uses it\)/);
  });

  it("an unsaved project and read-only mode are refused before anything changes", async () => {
    ae(plain(), { file: null });
    expect(text(await runSurgery({ action: "unprecompose", comp: "Main", layer: "Logo" }, FULL))).toMatch(/Save the project first/);
    ae(plain());
    const before = fake.state();
    const r = await runSurgery({ action: "unprecompose", comp: "Main", layer: "Logo" }, { mode: "read-only", allowShell: false });
    expect(r.isError).toBe(true);
    expect(fake.state()).toBe(before);
  });
});

describe("the likely cause of a DIFFERS", () => {
  const risks = ['"L" is scaled (50%, 50%): the precomp was rendered first and then resampled once as a whole', 'Main > 1 "A" > Opacity: reads the comp\'s name'];
  it("resampling only for a small difference along edges", () => {
    expect(likelyCause(risks, { maxDiff: 20, share: 0.004 })).toMatch(/^Likely cause \(a small difference, up to 20\/255 on 0.4% of a frame, as resampling makes along edges\):\n {2}- "L" is scaled/);
  });
  it("a large difference is the placement, whatever the plan's risks say", () => {
    const t = likelyCause(risks, { maxDiff: 229, share: 0.07 });
    expect(t).toMatch(/^Likely cause: the difference is too large for resampling \(up to 229\/255 on 7% of a frame\): the moved layers are not placed/);
    expect(t).not.toMatch(/scaled/);
    expect(t).toMatch(/Also in the plan:\n {2}- Main > 1 "A" > Opacity: reads the comp's name/);
  });
  it("each risk once, even when the plan lists it twice; the DIFFERS report doesn't repeat the plan's risks", () => {
    const t = likelyCause([risks[0], risks[0], risks[1]], { maxDiff: 14.75, share: 0.002 });
    expect(t.split("is scaled").length - 1).toBe(1);
  });
  it("a small difference with no resampling risk lists the other risks", () => {
    expect(likelyCause([risks[1]], { maxDiff: 3, share: 0.001 })).toMatch(/^Likely cause \(up to 3\/255 on 0.1% of a frame\), most likely first:\n {2}- Main > 1 "A"/);
  });
});

describe("deep duplicate", () => {
  it("folder is refused before anything changes: moves into a folder are undo steps of their own", async () => {
    ae(tree());
    const before = fake.state();
    const r = await runSurgery({ action: "deep_duplicate", comp: "Main", folder: "Copies" }, FULL);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^folder isn't supported: After Effects records every move into a folder as an undo step of its own/);
    expect(fake.state()).toBe(before);
    expect(calls).toHaveLength(0);
  });

  it("the fake keeps a move into a folder out of the call's undo step, as After Effects does", () => {
    ae(tree());
    const before = fake.state();
    fake.run('var f = app.project.items.addFolder("F"); app.project.item(1).parentFolder = f; return 1;', {}, { undoGroup: "x" });
    expect(fake.undoSteps()).toEqual(["x", "move Outside"]);
    fake.undo();
    expect(fake.state()).not.toBe(before);
    fake.undo();
    expect(fake.state()).toBe(before);
  });

  /** Main -> Scene A, Scene B; both show Shared; Scene A's expression names Shared and an outside comp */
  const tree = (): SComp[] => [
    { name: "Outside", layers: [{ name: "Ref" }] },
    { name: "Shared", width: 400, height: 400, layers: [{ name: "Dot", position: [200, 200] }] },
    { name: "Scene A", layers: [{ name: "S1", type: "precomp", source: "Shared", position: [300, 300], expr: { "Transform/Position": 'comp("Shared").layer("Dot").transform.position + comp(\'Outside\').layer(1).transform.position' } }] },
    { name: "Scene B", layers: [{ name: "S2", type: "precomp", source: "Shared", position: [900, 300] }, { name: "S3", type: "precomp", source: "Shared", position: [900, 700] }] },
    { name: "Main", layers: [{ name: "A", type: "precomp", source: "Scene A" }, { name: "B", type: "precomp", source: "Scene B", locked: true }, { name: "Label", type: "text", expr: { "Transform/Opacity": "thisComp.name.length" } }] },
  ];
  const facts = () => fake.run(DFACTS_JSX, { comp: "Main" }).result;

  it("the plan: every comp of the tree once (shared ones too), new unique names, rewrites inside the tree only", () => {
    ae(tree());
    const p = planDeepDuplicate(facts());
    expect(p.copies.map((c) => [c.from, c.to])).toEqual([["Main", "Main copy"], ["Scene A", "Scene A copy"], ["Shared", "Shared copy"], ["Scene B", "Scene B copy"]]);
    expect(p.rewrites.map((r) => r.new)).toEqual(['comp("Shared copy").layer("Dot").transform.position + comp(\'Outside\').layer(1).transform.position']);
    expect(p.notes.join("\n")).toMatch(/Shared inside the tree, copied once: "Shared"/);
    expect(p.risks.join("\n")).toMatch(/reads the comp's name, which is "Main copy" in the copy/);
    // a name that is taken gets a number
    ae([...tree(), { name: "Main copy", layers: [] }]);
    expect(planDeepDuplicate(facts()).copies[0].to).toBe("Main copy 2");
    expect(planDeepDuplicate(facts(), { suffix: " v2" }).copies.map((c) => c.to)).toEqual(["Main v2", "Scene A v2", "Shared v2", "Scene B v2"]);
  });

  it("refuses computed and ambiguous comp names, unless overridden", () => {
    const t = tree();
    t[2].layers[0].expr = { "Transform/Position": 'comp("Sha" + "red").layer(1).transform.position' };
    ae(t);
    expect(blocking(planDeepDuplicate(facts())).map((x) => x.text)).toEqual([expect.stringMatching(/comp\("Sha" \+ "red"\): the comp's name is computed/)]);
    const u = tree();
    u.push({ name: "Shared", layers: [] });
    ae(u);
    expect(blocking(planDeepDuplicate(facts())).map((x) => x.text)).toEqual([expect.stringMatching(/2 comps are named "Shared"/)]);
  });

  it("does it: copies unlinked from the originals, proven identical against the original", async () => {
    ae(tree());
    const main = fake.comp("Main");
    const before = pictures(main);
    const start = fake.state();
    const r = await runSurgery({ action: "deep_duplicate", comp: "Main" }, FULL);
    expect(r.isError, text(r)).toBeFalsy();
    const t = text(r);
    expect(t).toMatch(/^DONE and proven: IDENTICAL: all 5 frames are bit-identical to the reference/);
    expect(t).toMatch(/New root comp: "Main copy"/);
    const copy = fake.comp("Main copy");
    expect(pictures(copy)).toEqual(before);
    expect(copy.layers.map((l: any) => l.source?.name ?? null)).toEqual(["Scene A copy", "Scene B copy", null]);
    expect(fake.comp("Scene B copy").layers.map((l: any) => l.source.name)).toEqual(["Shared copy", "Shared copy"]);
    expect(fake.comp("Scene A copy").layer("S1").property("ADBE Transform Group").property("ADBE Position").expression).toBe('comp("Shared copy").layer("Dot").transform.position + comp(\'Outside\').layer(1).transform.position');
    // the originals are untouched
    expect(fake.comp("Main").layers.map((l: any) => l.source?.name ?? null)).toEqual(["Scene A", "Scene B", null]);
    expect(fake.comp("Scene A").layer("S1").property("ADBE Transform Group").property("ADBE Position").expression).toMatch(/^comp\("Shared"\)/);
    // each comp copied once, next to its original; the rehearsal's copies are gone
    expect(fake.items().filter((i: any) => / copy$/.test(i.name)).map((i: any) => i.name)).toEqual(["Main copy", "Scene A copy", "Shared copy", "Scene B copy"]);
    expect(fake.comp("Main copy").layer("B").locked).toBe(true);
    // in the fake (an After Effects that keeps the group whole) one undo step takes everything back
    expect(fake.undo()).toBe("Surehand MCP deep duplicate");
    expect(fake.state()).toBe(start);
  });

  it("the report is honest about undo and names the copy set; remove_copies takes exactly the copies away", async () => {
    ae(tree());
    const start = fake.state();
    const r = await runSurgery({ action: "deep_duplicate", comp: "Main" }, FULL);
    expect(r.isError, text(r)).toBeFalsy();
    const t = text(r);
    expect(t).not.toMatch(/One undo step/);
    expect(t).toMatch(/The originals are unchanged: the deep duplicate only added the copies above .* ae_undo may take several steps; the exact way back is remove_copies\./);
    const id = /Copies made \(copy set ([\w-]+)\): "Main copy" \(id \d+\), "Scene A copy" \(id \d+\), "Shared copy" \(id \d+\), "Scene B copy" \(id \d+\)\. To remove exactly these: ae_precomp_surgery \{action: "remove_copies", id: "([\w-]+)"\}/.exec(t);
    expect(id).not.toBeNull();
    const rm = await runSurgery({ action: "remove_copies", id: id![1] }, FULL);
    expect(rm.isError, text(rm)).toBeFalsy();
    expect(text(rm)).toMatch(/^Removed copy set [\w-]+: "Main copy", "Scene A copy", "Shared copy", "Scene B copy"\. The originals were never changed\./);
    expect(fake.state()).toBe(start);
    // nothing left to remove: the latest set's comps are gone
    expect(text(await runSurgery({ action: "remove_copies" }, FULL))).toMatch(/^Nothing to remove for copy set [\w-]+\. The originals were never changed\.\nAlready gone: "Main copy", "Scene A copy", "Shared copy", "Scene B copy"/);
  });

  it("remove_copies refuses while anything outside the copies uses one, and in another project", async () => {
    ae(tree());
    await runSurgery({ action: "deep_duplicate", comp: "Main" }, FULL);
    // a comp outside the set shows a copy; an expression elsewhere names one
    const other = fake.comp("Outside");
    other.layer(1).property("ADBE Transform Group").property("ADBE Opacity").expression = 'comp("Shared copy").layer(1).transform.opacity';
    fake.comp("Main").layers[0].replaceSource(fake.comp("Scene A copy"), false);
    const before = fake.state();
    const r = await runSurgery({ action: "remove_copies" }, FULL);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^REFUSED: nothing was removed\. Copy set [\w-]+ is in use outside its own copies:/);
    expect(text(r)).toMatch(/"Scene A copy" is used in "Main", which is not one of the copies/);
    expect(text(r)).toMatch(/"Outside" > 1 "Ref": an expression names "Shared copy"/);
    expect(fake.state()).toBe(before);
    expect(text(await runSurgery({ action: "remove_copies", id: "nope" }, FULL))).toMatch(/Copy set nope not found/);
    expect(text(await runSurgery({ action: "remove_copies", id: "../x" }, FULL))).toMatch(/is not a copy set id/);
  });

  it("DIFFERS: no copy is left in the project", async () => {
    ae(tree());
    skew = (c) => / copy$/.test(c.name);
    const before = fake.state();
    const r = await runSurgery({ action: "deep_duplicate", comp: "Main" }, FULL);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^DIFFERS: the deep duplicate was NOT applied/);
    expect(text(r)).toMatch(/Likely cause[\s\S]*reads the comp's name/);
    expect(fake.state()).toBe(before);
  });
});
