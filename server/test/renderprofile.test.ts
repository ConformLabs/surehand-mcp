// ae_render_profile against the fake After Effects (fake-ae.ts fakeProject): the real ExtendScript bodies run there,
// with deterministic render times (each layer and effect that is on adds its cost). As in After Effects 26.5,
// saveFrameToPng is asynchronous: the PNG appears only after the call has returned, here on a virtual clock (every call
// costs CALL_MS, a render's file appears its cost later), so the heat map, the per-layer costs, the budget and the
// "project unchanged" guarantee are checked exactly. ae_prove_identical's renders are faked here: a frame's picture is
// what is visible in it (layers on with opacity above 0, and layers marked as used by others).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePng } from "../src/png.js";
import { fakeProject, type FakeProjectSpec } from "./fake-ae.js";

let fake: ReturnType<typeof fakeProject>;
/** layers whose switch changes the picture whatever their opacity (an effect or a matte uses them) */
let usedByOthers: Set<string>;
/** 32 bpc renders a different picture than 16 bpc */
let bpcVisible: boolean;
let jsxLog: { kind: string; opts: any; args: any }[];
let checkpointFile: string;
/** switch calls that fail (1-based: the n-th switch call of the test) */
let failSwitch: Set<number>;

// the virtual clock: a call costs CALL_MS; a render's file is written its cost after the call that started it returned
const CALL_MS = 2;
let vnow = 0;
let pending: { path: string; at: number }[] = [];
function flush() {
  for (const p of pending.filter((x) => x.at <= vnow)) writeFileSync(p.path, "png-bytes");
  pending = pending.filter((x) => x.at > vnow);
}

function picture(comp: any, t: number, bpc: number): Buffer {
  const seen = comp.layers
    .filter((l: any) => l.enabled && t >= l.inPoint && t < l.outPoint && (usedByOthers.has(l.name) || l.property("ADBE Transform Group").property("ADBE Opacity").valueAtTime(t) > 0))
    .map((l: any) => l.name)
    .join("|") + (bpcVisible && bpc === 32 ? "|hdr" : "");
  let h = 7;
  for (const ch of seen) h = (h * 31 + ch.charCodeAt(0)) % 251;
  const px = new Uint8Array(8 * 8 * 4).map((_, i) => (i % 4 === 3 ? 255 : h));
  return encodePng(8, 8, px, 4);
}

async function proveRender(args: any) {
  const bpc = fake.app.project.bitsPerChannel;
  const out = [];
  for (const spec of args.comps) {
    const id = spec.id ?? spec.ref;
    const c = fake.comps.find((k: any) => k.id === id || k.name === id);
    if (!c) {
      out.push({ id, missing: true });
      continue;
    }
    const times: number[] = spec.times ?? args.times;
    const frames = times.map((time, j) => {
      const path = join(args.dir, `${args.prefix}${c.id}_${j}.png`);
      writeFileSync(path, picture(c, time, bpc));
      return { time, path };
    });
    out.push({ id: c.id, name: c.name, width: c.width, height: c.height, pixelAspect: 1, frameRate: c.frameRate, renderW: 8, renderH: 8, frames });
  }
  return { ok: true, logs: [], result: { project: fake.app.project.file.fsName, comps: out, tmpLeft: false } };
}

vi.mock("../src/jsx.js", async (original) => {
  const real = await original<typeof import("../src/jsx.js")>();
  return {
    ...real,
    runJsx: async (body: string, args: any, opts: any) => {
      const { PROVE_RENDER_JSX } = await import("../src/tools/prove.js");
      const { PROFILE_TRIGGER_JSX, PROFILE_SWITCH_JSX, PROFILE_INFO_JSX } = await import("../src/tools/renderprofile.js");
      const kind = body === PROVE_RENDER_JSX ? "prove" : body === PROFILE_TRIGGER_JSX ? "trigger" : body === PROFILE_SWITCH_JSX ? "switch" : body === PROFILE_INFO_JSX ? "info" : body.includes("nothing to checkpoint") ? "checkpoint" : body.includes("__steps") ? "batch" : "other";
      jsxLog.push({ kind, opts, args });
      vnow += CALL_MS;
      flush();
      if (kind === "prove") return proveRender(args);
      if (kind === "checkpoint") return { ok: true, logs: [], result: checkpointFile };
      if (kind === "switch") {
        if (failSwitch.has(jsxLog.filter((c) => c.kind === "switch").length)) return { ok: false, logs: [], error: { message: "After Effects is busy", user: true } };
      }
      return fake.run(body, args);
    },
  };
});

const { measure, optimize, median, heatMap, slowestRanges, timing, PROFILE_INFO_JSX, PROFILE_TRIGGER_JSX, PROFILE_SWITCH_JSX } = await import("../src/tools/renderprofile.js");
const FULL = { mode: "full", allowShell: false };
const text = (r: any) => r.content.map((c: any) => c.text).join("\n");

let home: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "aemcp-profile-"));
  process.env.HOME = process.env.USERPROFILE = home;
  checkpointFile = join(home, "spot.aep");
  writeFileSync(checkpointFile, "aep");
  timing.now = () => vnow;
  // wakes at the end of the sleep, or when a pending file is due, whichever is first
  timing.sleep = async (ms: number) => {
    const next = Math.min(vnow + ms, ...pending.map((p) => p.at));
    vnow = Math.max(vnow, next);
    flush();
  };
});
afterAll(() => {
  process.env.HOME = saved.HOME;
  process.env.USERPROFILE = saved.USERPROFILE;
});

/** a fake project whose renders write their file `cost` ms after the call that started them returned */
function project(spec: FakeProjectSpec) {
  const f = fakeProject(spec);
  f.clock.onRender = (path, ms) => pending.push({ path, at: vnow + ms });
  // the fake marks the project as changed once anything is written (as After Effects does)
  expect(f.app.project.dirty).toBe(false);
  return f;
}

/** Main (4 s, 100 frames): a 4K precomp at 25%, a layer with two effects, an invisible layer, a title that gets slow after 2 s, a shy locked layer. */
const spot = (more: Partial<FakeProjectSpec> = {}, mainMore: Record<string, unknown> = {}): FakeProjectSpec => ({
  activeComp: "Main",
  comps: [
    { name: "Sim", width: 3840, height: 2160, duration: 4, renderMs: 100, layers: [{ name: "Particles", costMs: 50 }] },
    {
      name: "Main", duration: 4, renderMs: 10,
      layers: [
        { name: "Sim layer", type: "precomp", source: "Sim", scale: [25, 25, 100] },
        { name: "Glow", effects: [{ matchName: "ADBE Glo2", name: "Glow", costMs: 80 }, { matchName: "ADBE Gaussian Blur 2", name: "Blur", costMs: 6 }], costMs: 4 },
        { name: "Ghost", opacity: 0, costMs: 40 },
        { name: "Title", type: "text", costMs: (t: number) => (t >= 2 ? 300 : 10) },
        { name: "Notes", shy: true, costMs: 30, locked: true },
        { name: "Null", type: "null" },
      ],
      ...mainMore,
    },
  ],
  ...more,
});

const switchesOf = () => JSON.stringify([fake.app.project.bitsPerChannel, fake.comps.map((c: any) => c.layers.map((l: any) => [l.enabled, l.locked, (l.property("ADBE Effect Parade")?.children ?? []).map((e: any) => e.enabled)]))]);

beforeEach(() => {
  usedByOthers = new Set();
  bpcVisible = false;
  jsxLog = [];
  failSwitch = new Set();
  pending = [];
});

describe("ae_render_profile helpers", () => {
  it("the ExtendScript bodies are valid ES3", async () => {
    const { parse } = await import("acorn");
    for (const b of [PROFILE_INFO_JSX, PROFILE_TRIGGER_JSX, PROFILE_SWITCH_JSX]) expect(() => parse(`(function(args, log){${b}\n})`, { ecmaVersion: 3, allowReserved: false })).not.toThrow();
  });

  it("the trigger starts the render and returns: nothing waits for the file inside the call", () => {
    fake = project(spot());
    const path = join(home, "trigger-test.png");
    const r = fake.run(PROFILE_TRIGGER_JSX, { comp: fake.comps[1].id, time: 1, path });
    expect(r.ok).toBe(true);
    expect(pending.map((p) => p.path)).toEqual([path]);
    expect(fake.calls.filter((c) => c.startsWith("purge"))).toEqual(["purge 4"]);
  });

  it("median, heat map rows and the slowest ranges", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    const rows = heatMap([{ frame: 0, ms: 100 }, { frame: 10, ms: 100 }, { frame: 20, ms: 400 }, { frame: 30, ms: 380 }], 0, 30);
    expect(rows.map((r) => [r.from, r.to])).toEqual([[0, 5], [6, 15], [16, 25], [26, 30]]);
    expect(rows[2].line).toMatch(/f16-f25\s+█{20}\s+400 ms/);
    expect(slowestRanges(rows)).toEqual([{ from: 16, to: 30, lo: 380, hi: 400 }]);
  });
});

describe("ae_render_profile measure", () => {
  it("maps the frame times, measures layers and effects, finds the invisible layer and the oversized precomp, and puts every switch back", async () => {
    fake = project(spot());
    const before = switchesOf();
    const r = await measure({ action: "measure", frames: 8, runs: 3 });
    const t = text(r);
    expect(r.isError).toBeFalsy();
    // frame times (the call's round trip subtracted): comp 10 + precomp (100 + 50) + Glow 4+80+6 + Ghost 40 + Title 10 / 300 + Notes 30
    expect(t).toMatch(/8 frames measured, median of 3 renders each/);
    expect(t).toMatch(/slowest 620 ms at f\d+, fastest 330 ms at f0/);
    expect(t).toMatch(/f0-f\d+\s+█+\S*\s+330 ms/);
    expect(t).toMatch(/Slowest: f\d+-f99 \(620 ms\)/);
    expect(t).toMatch(/minus the measured round trip of a call \(2 ms\)/);
    // layer costs at the slowest frames, exact in the fake
    expect(t).toMatch(/4\. "Title" \(text\): 300 ms, 48\.4%/);
    expect(t).toMatch(/1\. "Sim layer" \(precomp\): 150 ms/);
    expect(t).toMatch(/2\. "Glow" \(footage\): 90 ms/);
    expect(t).toMatch(/effect "Glow": 80 ms/);
    expect(t).toMatch(/effect "Blur": 6 ms/);
    expect(t).toMatch(/3\. "Ghost" \(footage\): 40 ms/);
    expect(t).not.toMatch(/"Null"/);
    // findings
    expect(t).toMatch(/F1 \[can apply\] Layer 3 "Ghost" \(footage\) has opacity 0 at every sampled frame .* 40 ms/);
    expect(t).toMatch(/\[advice\] Precomp layer 1 "Sim layer": it is 3840x2160 but shown at most at 25% .* 16x the pixels/);
    expect(t).toMatch(/\[advice\] Layer 5 "Notes" is shy \(hidden in the timeline\) but renders: 30 ms/);
    expect(t).toMatch(/\[unknown\] Multi-Frame Rendering: not knowable from scripting/);
    expect(t).toMatch(/Apply with proof: ae_render_profile \{action: "optimize", id: "[\w-]+", findings: \["F1"\]\}/);
    // every switch is back, read back; the switch steps are named, Edit > Undo was never run
    expect(switchesOf()).toBe(before);
    expect(t).toMatch(/Project unchanged: all 6 layers' and their effects' switches read back as before\. Edit > Undo history now has \d+ "Surehand MCP render profile switch" steps/);
    expect(fake.calls).not.toContain("executeCommand");
    for (const c of jsxLog.filter((x) => x.kind === "switch")) expect(c.opts.undoGroup).toBe("Surehand MCP render profile switch");
    for (const c of jsxLog.filter((x) => x.kind === "trigger")) expect(c.opts.undoGroup).toBe(false);
    // the project is marked as changed, and the report says so instead of claiming nothing changed
    expect(t).toMatch(/After Effects now marks the project as having unsaved changes/);
    // only the image cache is purged (4), never the undo history; every rendered frame was removed again
    expect(fake.calls.filter((c) => c.startsWith("purge")).every((c) => c === "purge 4")).toBe(true);
    expect(fake.writes).toContain("Notes.locked");
    expect(pending).toEqual([]);
  });

  it("takes the median of the runs (an outlier render doesn't count)", async () => {
    fake = project({ ...spot(), jitter: [0, 0, 500] });
    const t = text(await measure({ action: "measure", frames: 3, runs: 3, layers: false }));
    expect(t).toMatch(/fastest 330 ms at f0/);
  });

  it("stops at the time budget and reports only what was measured", async () => {
    fake = project(spot());
    const t = text(await measure({ action: "measure", frames: 24, runs: 3, timeBudgetSeconds: 10 }));
    const m = /Time budget: (\d+) of 24 sampled frames were measured/.exec(t);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(24);
    expect(t).toMatch(new RegExp(`${m![1]} frames measured`));
    expect(t).toMatch(/Not measured \(time budget\): /);
  });

  it("puts every switch back and says so when measuring stops halfway", async () => {
    fake = project(spot());
    const before = switchesOf();
    failSwitch = new Set([2]); // the first switch off works, switching it back fails once
    const t = text(await measure({ action: "measure", frames: 4, runs: 1 }));
    expect(t).toMatch(/Measuring stopped: After Effects is busy/);
    expect(t).toMatch(/Project unchanged: .* \(after putting back what an interrupted measurement had left switched\)/);
    expect(switchesOf()).toBe(before);
    // when the restore's own switch call fails too, it must not claim the project is unchanged
    jsxLog = [];
    failSwitch = new Set([2, 3]);
    const bad = text(await measure({ action: "measure", frames: 4, runs: 1 }));
    expect(bad).toMatch(/PROJECT CHANGED: the layer or effect switches don't read back as before the profile \(After Effects is busy\)/);
    expect(bad).not.toMatch(/Project unchanged/);
  });

  it("asks for approval once in ask mode; read-only mode measures only the frame times", async () => {
    fake = project(spot());
    await measure({ action: "measure", frames: 2, runs: 1 }, { mode: "ask" });
    const sw = jsxLog.filter((c) => c.kind === "switch");
    expect(sw[0].opts.bridge?.approval?.summary).toMatch(/Switch layers and effects of "Main" off one at a time/);
    expect(sw.slice(1).every((c) => !c.opts.bridge)).toBe(true);
    jsxLog = [];
    const t = text(await measure({ action: "measure", frames: 2, runs: 1 }, { mode: "read-only" }));
    expect(t).toMatch(/Read-only mode: only the frame times were measured/);
    expect(jsxLog.filter((c) => c.kind === "switch")).toHaveLength(0);
  });

  it("in a 32 bpc project, proves 16 bpc identical (16 bpc set in its own call) before suggesting it, with the time it saves", async () => {
    fake = project(spot({ bpc: 32 }));
    const t = text(await measure({ action: "measure", frames: 4, runs: 1, layers: false }));
    expect(t).toMatch(/\[can apply\] The project is 32 bpc, and 16 bpc gives the same picture: IDENTICAL: all \d+ frames are bit-identical/);
    expect(t).toMatch(/At 16 bpc at 2 slow frames it renders in 620 ms instead of 930 ms/);
    // the comparison ran while the project was 16 bpc; it is 32 bpc again
    const kinds = jsxLog.map((c) => (c.kind === "switch" ? `switch ${c.args.bpc}` : c.kind)).filter((k) => /switch|prove/.test(k));
    expect(kinds.slice(0, 4)).toEqual(["prove", "switch 16", "prove", "switch 32"]);
    expect(fake.app.project.bitsPerChannel).toBe(32);
  });

  it("doesn't suggest 16 bpc when it changes the picture", async () => {
    bpcVisible = true;
    fake = project(spot({ bpc: 32 }));
    const t = text(await measure({ action: "measure", frames: 4, runs: 1, layers: false }));
    expect(t).toMatch(/32 bpc → 16 bpc was checked and changes the picture \(DIFFERS/);
    expect(t).not.toMatch(/\[can apply\] The project is 32 bpc/);
    expect(fake.app.project.bitsPerChannel).toBe(32);
  });

  it("motion blur: lists expressions evaluated per sample, and finds the constant ones", async () => {
    fake = project(spot({}, {
      motionBlur: true,
      layers: [
        { name: "Logo", motionBlur: true, costMs: 20, expressions: { "Transform/Opacity": { expr: "100" }, "Transform/Position": { expr: "wiggle(2, 30)" } }, anim: { "ADBE Position": (t: number) => [960 + t, 540, 0] } },
      ],
    }));
    const t = text(await measure({ action: "measure", frames: 4, runs: 1 }));
    expect(t).toMatch(/\[advice\] Motion blur is on with 16 samples per frame .*1 expression on 1 motion-blurred layer change over time.*"Logo" > Transform\/Position/);
    expect(t).toMatch(/\[can apply\] 1 expression on motion-blurred layers give the same value .*"Logo" > Transform\/Opacity/);
  });
});

describe("ae_render_profile optimize", () => {
  it("applies a finding, proves it identical, keeps it and reports the time saved", async () => {
    fake = project(spot({ bpc: 32 }));
    const m = text(await measure({ action: "measure", frames: 4, runs: 1 }));
    const id = /Render profile (\S+) of/.exec(m)![1];
    const ids = [...m.matchAll(/(F\d+) \[can apply\]/g)].map((x) => x[1]);
    expect(ids).toHaveLength(2); // the invisible layer and the bit depth
    jsxLog = [];
    const r = await optimize({ action: "optimize", id, findings: ids }, FULL);
    const t = text(r);
    expect(r.isError).toBeFalsy();
    expect(t).toMatch(/2 of 2 findings kept/);
    expect(t).toMatch(/Checkpoint saved before the first change: .*spot.*\.aep/);
    expect(t).toMatch(/F\d: KEPT: IDENTICAL: all \d+ frames are bit-identical to the reference \(proof [\w-]+; one undo step\)/);
    // 32 bpc 930 ms → 16 bpc without Ghost 580 ms, at the slow frames
    expect(t).toMatch(/Time saved at 4 measured frames/);
    expect(t).toMatch(/f\d+: 930 ms → 580 ms/);
    expect(fake.app.project.bitsPerChannel).toBe(16);
    expect(fake.comps[1].layers[2].enabled).toBe(false);
    expect(jsxLog.filter((c) => c.kind === "checkpoint")).toHaveLength(1);
    expect(fake.calls).not.toContain("executeCommand");
  });

  it("puts back a change that isn't proven identical with its own steps (never Edit > Undo), and keeps nothing", async () => {
    usedByOthers.add("Ghost");
    fake = project(spot());
    const m = text(await measure({ action: "measure", frames: 4, runs: 1 }));
    const id = /Render profile (\S+) of/.exec(m)![1];
    jsxLog = [];
    const t = text(await optimize({ action: "optimize", id, findings: ["F1"] }, FULL));
    expect(t).toMatch(/0 of 1 finding kept/);
    expect(t).toMatch(/F1: NOT KEPT, put back automatically: DIFFERS in \d+ of \d+ frames/);
    expect(t).toMatch(/Nothing was kept, so the render time is unchanged/);
    expect(fake.comps[1].layers[2].enabled).toBe(true);
    expect(jsxLog.filter((c) => c.kind === "batch")).toHaveLength(2);
    expect(jsxLog.filter((c) => c.kind === "batch")[1].opts.undoGroup).toMatch(/F1 \(put back\)/);
    expect(fake.calls).not.toContain("executeCommand");
  });

  it("freezes constant expressions under motion blur, proven; puts the value and the expression back when not identical", async () => {
    fake = project(spot({}, { motionBlur: true, layers: [{ name: "Logo", motionBlur: true, costMs: 20, opacity: 60, expressions: { "Transform/Opacity": { expr: "100" } } }] }));
    // the fake's expression doesn't change the value it reads: the value under it (60) is what it reads, constant
    const m = text(await measure({ action: "measure", frames: 4, runs: 1 }));
    const id = /Render profile (\S+) of/.exec(m)![1];
    const f = /(F\d+) \[can apply\] 1 expression/.exec(m)![1];
    const t = text(await optimize({ action: "optimize", id, findings: [f] }, FULL));
    expect(t).toMatch(/KEPT: IDENTICAL/);
    const op = fake.comps[1].layers[0].property("ADBE Transform Group").property("ADBE Opacity");
    expect([op.value, op.expression, op.expressionEnabled]).toEqual([60, "100", false]);
  });

  it("refuses read-only mode, advice, unknown ids and a profile from another comp", async () => {
    fake = project(spot());
    const m = text(await measure({ action: "measure", frames: 2, runs: 1, layers: false }));
    const id = /Render profile (\S+) of/.exec(m)![1];
    expect(text(await optimize({ action: "optimize", id, findings: ["F1"] }, { mode: "read-only", allowShell: false }))).toMatch(/read-only/i);
    const advice = /(F\d+) \[advice\]/.exec(m)![1];
    expect(text(await optimize({ action: "optimize", id, findings: [advice] }, FULL))).toMatch(/is advice, not a change optimize can prove and apply/);
    expect(text(await optimize({ action: "optimize", id, findings: ["F99"] }, FULL))).toMatch(/has no finding F99/);
    fake.comps[1].name = "Renamed";
    expect(text(await optimize({ action: "optimize", id, findings: ["F1"] }, FULL))).toMatch(/comp id \d+ is "Renamed"\. Measure again/);
  });
});
