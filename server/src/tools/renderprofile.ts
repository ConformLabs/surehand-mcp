// ae_render_profile: where a comp's render time goes over the whole timeline (After Effects' own profiler shows one
// frame), and speed-ups that are only kept when ae_prove_identical shows the picture unchanged.
// measure: timed renders of sampled frames (image cache purged before each, median of N), then each layer and effect
// switched off in turn at the slowest frames (A/B), then findings with their evidence. optimize: applies chosen findings
// one at a time (checkpoint first), proves each, reverts any that isn't proven identical, and re-measures.
// comp.saveFrameToPng is asynchronous (measured in AE 26.5: it returns in ~1.5 ms, and After Effects renders and writes
// the PNG after the script has returned), so a render is timed across calls: a short call purges the image cache and
// starts it, and Node times until the file is written, minus the measured round trip of a call that starts nothing.
// Switches are set in their own short calls, put back explicitly and read back; Edit > Undo is never run.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { z } from "zod";
import { runJsx } from "../jsx.js";
import { appFile } from "../paths.js";
import { completePngSize } from "../png.js";
import { permissions, READ_ONLY_REFUSAL } from "../permissions.js";
import { captureProof, compareProof } from "./prove.js";
import { errorResult } from "./registry.js";
import { runBatch, saveCheckpoint } from "./workflow.js";
import { analyzeXray, type XData } from "./xray-analyze.js";
import { XRAY_JSX } from "./xray.js";

export const MAX_PROFILES = 30;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const profilesRoot = () => appFile("profiles");

/**
 * Read-only facts for the profile (no undo group): the comp, the frames to sample, and per layer its switches,
 * effects, source, opacity and scale at the sampled frames, and its expressions (by index path). args.constants:
 * on layers with motion blur in a comp with motion blur, also which expressions give the same value at every
 * sampled frame and between frames (where motion blur samples them), with that value.
 */
export const PROFILE_INFO_JSX = `
var P = app.project, c = aemcp.findComp(args.comp), fd = c.frameDuration, last = Math.max(0, Math.round(c.duration / fd) - 1);
var f0 = args.startFrame !== undefined ? args.startFrame : Math.round(c.workAreaStart / fd);
var f1 = args.endFrame !== undefined ? args.endFrame : Math.round((c.workAreaStart + c.workAreaDuration) / fd) - 1;
f0 = Math.max(0, Math.min(last, f0)); f1 = Math.max(f0, Math.min(last, f1));
var frames = [];
if (args.frameList) { for (var a = 0; a < args.frameList.length; a++) frames.push(args.frameList[a]); }
else {
  var n = Math.min(args.frames || 24, f1 - f0 + 1);
  for (var q = 0; q < n; q++) { var fr = n === 1 ? f0 : Math.round(f0 + (f1 - f0) * q / (n - 1)); if (!frames.length || frames[frames.length - 1] !== fr) frames.push(fr); }
}
var times = [], ctimes = [];
for (var b = 0; b < frames.length; b++) { times.push(frames[b] * fd); ctimes.push(frames[b] * fd, (frames[b] + 0.37) * fd, (frames[b] + 0.71) * fd); }
var mbOn = false; try { mbOn = !!c.motionBlur; } catch (e) {}
function numeric(v) {
  if (typeof v === "number") return true;
  if (!(v instanceof Array) || !v.length) return false;
  for (var i = 0; i < v.length; i++) if (typeof v[i] !== "number") return false;
  return true;
}
function same(x, y) {
  if (typeof x === "number") return x === y;
  if (!(y instanceof Array) || x.length !== y.length) return false;
  for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
// a plain function declaration: ExtendScript mishandles recursive named function expressions inside loops
function walk(g, idx, names, consts, out) {
  for (var k = 1; k <= g.numProperties; k++) {
    try {
      var p = g.property(k), pi = idx.concat([k]), pn = names.concat([p.name]);
      if (p.propertyType !== PropertyType.PROPERTY) { walk(p, pi, pn, consts, out); continue; }
      if (!p.canSetExpression || p.expression === "" || !p.expressionEnabled) continue;
      var rec = { path: pi, name: pn.join("/") };
      if (p.expressionError) rec.err = 1;
      if (p.numKeys) rec.keys = p.numKeys;
      if (consts && !rec.err && !p.numKeys) {
        var v0 = p.valueAtTime(ctimes[0], false), cst = numeric(v0);
        for (var s = 1; cst && s < ctimes.length; s++) if (!same(v0, p.valueAtTime(ctimes[s], false))) cst = false;
        // a color above 1.0 (32 bpc) would be read as 0-255 when it is set again
        if (cst && v0 instanceof Array && PropertyValueType.COLOR !== undefined && p.propertyValueType === PropertyValueType.COLOR) { for (var cc = 0; cc < v0.length; cc++) if (v0[cc] > 1) cst = false; }
        if (cst) { rec.constant = 1; rec.value = v0; rec.expr = p.expression; rec.pre = p.valueAtTime(ctimes[0], true); }
      }
      out.push(rec);
    } catch (e) {}
  }
}
var layers = [];
for (var i = 1; i <= c.numLayers; i++) {
  var L = c.layer(i), t = aemcp.layerType(L), o = { i: i, id: L.id, n: L.name, t: t, on: L.enabled ? 1 : 0, inP: L.inPoint, outP: L.outPoint }, src = null;
  if (L.locked) o.lock = 1;
  if (L.shy) o.shy = 1;
  try { if (L.guideLayer) o.guide = 1; } catch (e) {}
  try { if (L.isTrackMatte) o.matte = 1; } catch (e) {}
  try { if (L.hasVideo === false) o.noVideo = 1; } catch (e) {}
  try { if (L.motionBlur) o.mb = 1; } catch (e) {}
  try { if (L.collapseTransformation) o.cl = 1; } catch (e) {}
  try { src = L.source; } catch (e) {}
  if (src && (src instanceof CompItem || src instanceof FootageItem)) o.src = { id: src.id, name: src.name, w: src.width, h: src.height, comp: src instanceof CompItem ? 1 : 0 };
  var fx = null; try { fx = L.property("ADBE Effect Parade"); } catch (e) {}
  if (fx && fx.numProperties) {
    o.fx = [];
    for (var f = 1; f <= fx.numProperties; f++) { var ef = fx.property(f); o.fx.push({ i: f, n: ef.name, m: ef.matchName, on: ef.enabled ? 1 : 0 }); }
  }
  // at the sampled frames inside the layer's time: opacity 0 at every one = invisible; the largest scale
  var tr = null; try { tr = L.property("ADBE Transform Group"); } catch (e) {}
  if (tr && t !== "camera" && t !== "light") {
    var op = null, sc = null, zero = true, seen = 0, smax = 0;
    try { op = tr.property("ADBE Opacity"); sc = tr.property("ADBE Scale"); } catch (e) {}
    for (var s2 = 0; s2 < times.length; s2++) {
      if (times[s2] < L.inPoint || times[s2] >= L.outPoint) continue;
      seen++;
      try { if (op.valueAtTime(times[s2], false) !== 0) zero = false; } catch (e) { zero = false; }
      try { var sv = sc.valueAtTime(times[s2], false); smax = Math.max(smax, Math.abs(sv[0]), Math.abs(sv[1])); } catch (e) {}
    }
    if (seen && zero) o.zero = 1;
    if (seen && smax) o.scale = smax;
  }
  if (t !== "camera") { var ex = []; walk(L, [], [], !!args.constants && mbOn && !!o.mb, ex); if (ex.length) o.ex = ex; }
  layers.push(o);
}
var rq = [];
try { for (var r = 1; r <= P.renderQueue.numItems; r++) { var it = P.renderQueue.item(r); if (it.render) rq.push(it.comp.id); } } catch (e) {}
var C = { id: c.id, name: c.name, w: c.width, h: c.height, fps: c.frameRate, fd: fd, mb: mbOn, f0: f0, f1: f1 };
try { C.spf = c.motionBlurSamplesPerFrame; C.asl = c.motionBlurAdaptiveSampleLimit; C.sa = c.shutterAngle; } catch (e) {}
try { C.res = c.resolutionFactor; } catch (e) {}
var dirty = null; try { dirty = P.dirty; } catch (e) {}
return { project: P.file ? P.file.fsName : null, dirty: dirty, bpc: P.bitsPerChannel, comp: C, frames: frames, layers: layers, rq: rq };`;

/**
 * Starts one render of the comp itself: purges the image cache (PurgeTarget.IMAGE_CACHES only: the undo history
 * stays), then comp.saveFrameToPng, which returns at once; After Effects writes the file after this call returns, so
 * nothing waits for it here. Without args.path only the purge runs (the calibration call: the same round trip).
 */
export const PROFILE_TRIGGER_JSX = `
var c = aemcp.findItem(args.comp);
if (!(c instanceof CompItem)) aemcp.fail("The comp (id " + args.comp + ") is not in the project any more.");
try { app.purge(PurgeTarget.IMAGE_CACHES); } catch (e) {}
if (args.path) { var f = new File(args.path); if (f.exists) f.remove(); c.saveFrameToPng(args.time, f); }
return true;`;

/**
 * Sets switches to exact values: args.set [{layer: id, effect?: index, on}] in args.comp, args.bpc the project bit
 * depth. A locked layer is unlocked for it and locked again. Only what differs is written.
 */
export const PROFILE_SWITCH_JSX = `
var P = app.project, c = aemcp.findItem(args.comp), set = args.set || [];
if (args.bpc && P.bitsPerChannel !== args.bpc) P.bitsPerChannel = args.bpc;
for (var i = 0; i < set.length; i++) {
  var s = set[i], L = null;
  for (var j = 1; j <= c.numLayers; j++) if (c.layer(j).id === s.layer) L = c.layer(j);
  if (!L) aemcp.fail("The layer (id " + s.layer + ") is not in the comp any more.");
  var x = s.effect !== undefined ? L.property("ADBE Effect Parade").property(s.effect) : L;
  if (x.enabled === !!s.on) continue;
  var lk = L.locked;
  if (lk) L.locked = false;
  try { x.enabled = !!s.on; } finally { if (lk) L.locked = true; }
}
return true;`;

// ---------- types ----------

interface InfoFx { i: number; n: string; m: string; on: number }
interface InfoExpr { path: number[]; name: string; err?: number; keys?: number; constant?: number; value?: number | number[]; pre?: number | number[]; expr?: string }
interface InfoLayer {
  i: number; id: number; n: string; t: string; on: number; inP: number; outP: number; lock?: number; shy?: number; guide?: number; matte?: number;
  noVideo?: number; mb?: number; cl?: number; src?: { id: number; name: string; w: number; h: number; comp: number }; fx?: InfoFx[]; zero?: number; scale?: number; ex?: InfoExpr[];
}
export interface Info {
  project: string | null;
  /** project.dirty (null when it can't be read) */
  dirty: boolean | null;
  bpc: number;
  comp: { id: number; name: string; w: number; h: number; fps: number; fd: number; mb: boolean; f0: number; f1: number; spf?: number; asl?: number; sa?: number; res?: number[] };
  frames: number[];
  layers: InfoLayer[];
  rq: number[];
}
interface Timed { t: number; base: number[]; off?: number[] }
export interface Cost { layer: number; name: string; effect?: number; effectName?: string; frames: number[]; ms: number; pct: number; base: number }
export interface Finding {
  id: string;
  kind: "invisible-layer" | "bit-depth" | "constant-expressions" | "motion-blur-expressions" | "oversized-precomp" | "multi-frame-rendering" | "hidden-cost";
  /** can be applied by optimize (and is kept only when proven identical) */
  applicable: boolean;
  text: string;
  /** what optimize changes: layer ids / expression paths (resolved again from fresh facts when applied) */
  layers?: number[];
  exprs?: { layer: number; path: number[] }[];
}
export interface Profile {
  id: string;
  createdAt: string;
  project: string | null;
  comp: { id: number; name: string; fps: number; f0: number; f1: number };
  runs: number;
  /** sampled frames and their median render time (ms); frames the budget didn't reach are left out */
  frames: { frame: number; ms: number }[];
  slow: number[];
  costs: Cost[];
  findings: Finding[];
}

// ---------- numbers ----------

export const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN;
};
const r1 = (n: number) => Math.round(n * 10) / 10;
export const ms = (n: number) => (Math.abs(n) >= 1000 ? `${r1(n / 1000)} s` : `${Math.round(n)} ms`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** A difference counts only beyond twice the spread of repeat renders of the same frame (at least 1 ms). */
export const spreadOf = (noise: number) => Math.max(1, 2 * noise);

/** What a measured cost means: within the spread, a real cost (""), or switching it off made the frame slower. */
export function costNote(v: number, noise: number): string {
  const s = spreadOf(noise);
  if (Math.abs(v) <= s) return ` (within the ±${ms(s)} spread)`;
  return v < 0 ? ": switching it off made the frame slower here (caching or interaction, not a saving)" : "";
}
const quote = (s: string) => `"${s}"`;

/** Heat map rows: each sampled frame stands for the frames up to halfway to its neighbours. */
export function heatMap(frames: { frame: number; ms: number }[], f0: number, f1: number) {
  const top = Math.max(...frames.map((f) => f.ms), 1), blocks = "▏▎▍▌▋▊▉█";
  return frames.map((f, i) => {
    const from = i === 0 ? f0 : Math.floor((frames[i - 1].frame + f.frame) / 2) + 1;
    const to = i === frames.length - 1 ? f1 : Math.floor((f.frame + frames[i + 1].frame) / 2);
    const w = (f.ms / top) * 20, full = Math.floor(w), part = Math.floor((w - full) * 8);
    const bar = "█".repeat(full) + (part > 0 ? blocks[part - 1] : full ? "" : "▏");
    return { from, to, ms: f.ms, line: `  ${`f${from}-f${to}`.padEnd(12)} ${bar.padEnd(21)} ${ms(f.ms)}` };
  });
}

/** The slowest stretches: neighbouring rows at or above the 75th percentile, merged, slowest first (at most 3). */
export function slowestRanges(rows: { from: number; to: number; ms: number }[]) {
  if (rows.length < 2) return [];
  const cut = [...rows.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor((rows.length - 1) * 0.75)];
  const out: { from: number; to: number; lo: number; hi: number }[] = [];
  for (const r of rows) {
    if (r.ms < cut) continue;
    const prev = out[out.length - 1];
    if (prev && prev.to + 1 >= r.from) Object.assign(prev, { to: r.to, lo: Math.min(prev.lo, r.ms), hi: Math.max(prev.hi, r.ms) });
    else out.push({ from: r.from, to: r.to, lo: r.ms, hi: r.ms });
  }
  return out.sort((a, b) => b.hi - a.hi).slice(0, 3);
}

// ---------- storage ----------

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\.(\d{3})Z$/, "$1");

export function pruneProfiles(keep = MAX_PROFILES, now = Date.now()) {
  let names: string[] = [];
  try {
    names = readdirSync(profilesRoot()).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return;
  }
  const live = names.filter((n) => {
    try {
      if (now - statSync(join(profilesRoot(), n)).mtimeMs <= MAX_AGE_MS) return true;
    } catch {}
    rmSync(join(profilesRoot(), n), { force: true });
    return false;
  });
  for (const n of live.slice(0, Math.max(0, live.length - keep))) rmSync(join(profilesRoot(), n), { force: true });
}

function saveProfile(p: Profile) {
  pruneProfiles(MAX_PROFILES - 1);
  mkdirSync(profilesRoot(), { recursive: true });
  writeFileSync(join(profilesRoot(), `${p.id}.json`), JSON.stringify(p, null, 1));
}

export function loadProfile(id?: string): Profile | string {
  if (id !== undefined && !/^[\w-]+$/.test(id)) return `"${id}" is not a profile id.`;
  let pick = id;
  if (pick === undefined) {
    try {
      pick = readdirSync(profilesRoot()).filter((n) => n.endsWith(".json")).sort().pop()?.replace(/\.json$/, "");
    } catch {}
    if (!pick) return 'No render profile yet. Run ae_render_profile {action: "measure"} first.';
  }
  try {
    return JSON.parse(readFileSync(join(profilesRoot(), `${pick}.json`), "utf8"));
  } catch {
    return `Render profile ${pick} not found (profiles are kept for 7 days, at most ${MAX_PROFILES}). Measure again.`;
  }
}

// ---------- After Effects calls ----------

async function readInfo(args: Record<string, unknown>): Promise<Info> {
  const r = await runJsx(PROFILE_INFO_JSX, args, { undoGroup: false, timeoutMs: 300_000, depth: 8 });
  if (!r.ok) throw new Error(r.error?.message || "After Effects could not read the comp.");
  return r.result as Info;
}

/** Clock and wait, replaceable in tests (the fake After Effects writes its frames on a virtual clock). */
export const timing = { now: () => performance.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };

interface Toggle { layer?: number; effect?: number; bpc?: number; back?: number }
let timers = 0;

/** Timed renders across calls (see PROFILE_TRIGGER_JSX) and switches in their own short calls (PROFILE_SWITCH_JSX). */
class Timer {
  /** the round trip of a call that starts no render (ms), subtracted from every render */
  overhead = 0;
  /** switch calls made (each is one undo step) */
  switchCalls = 0;
  private dir = appFile("tmp");
  private prefix = `aemcp_profile_${process.pid}_${++timers}_${randomBytes(2).toString("hex")}_`;
  private n = 0;
  constructor(private comp: number, private approval?: { tool: string; summary: string }) {}

  async calibrate() {
    const rt: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = timing.now();
      const r = await runJsx(PROFILE_TRIGGER_JSX, { comp: this.comp }, { undoGroup: false, timeoutMs: 60_000 });
      if (!r.ok) throw new Error(r.error?.message || "After Effects did not answer.");
      rt.push(timing.now() - t0);
    }
    this.overhead = median(rt);
  }

  /**
   * One render: from the start of the call that starts it until its PNG is completely written (signature and IEND,
   * then the same size one poll later), minus the round trip. A new path for every render, removed before it starts:
   * a file from an earlier render can't count. Measured live: a size that holds still for 5 ms can still be a half
   * written PNG, and stopping there let the next render queue behind the rest of the write.
   */
  async render(time: number): Promise<number> {
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, `${this.prefix}${this.n++}.png`);
    rmSync(path, { force: true });
    const t0 = timing.now();
    const r = await runJsx(PROFILE_TRIGGER_JSX, { comp: this.comp, time, path }, { undoGroup: false, timeoutMs: 60_000 });
    if (!r.ok) throw new Error(r.error?.message || "After Effects could not start the render.");
    let size = -1, at = 0;
    for (;;) {
      const now = timing.now(), s = completePngSize(path);
      if (s > 0 && s === size) break;
      if (s !== size) {
        size = s;
        at = now;
      }
      if (now - t0 > 600_000) throw new Error(`After Effects did not write the frame at ${time} s within 10 minutes.`);
      // short polls while it is quick to answer; at most 10 ms late on a long render
      await timing.sleep(s > 0 ? 5 : Math.min(10, 1 + (now - t0) / 100));
    }
    rmSync(path, { force: true });
    return Math.round(Math.max(0, at - t0 - this.overhead) * 100) / 100;
  }

  /** samples redone because they were far below the frame's other samples, and those still too low after the redo (dropped) */
  redone = 0;
  dropped = 0;

  /**
   * With 3 or more samples of a frame: one far below the others (under half their median) is a render that wasn't
   * measured right (a file seen too early, a cache hit): it is rendered again once, and dropped if it is still low.
   */
  private async clean(samples: number[], again: () => Promise<number>): Promise<number[]> {
    if (samples.length < 3) return samples;
    const low = (i: number, a: number[]) => a[i] < 0.5 * median(a.filter((_, j) => j !== i));
    const out = [...samples];
    for (let i = 0; i < out.length; i++) {
      if (!low(i, out)) continue;
      this.redone++;
      out[i] = await again();
      if (low(i, out)) out[i] = NaN;
    }
    const kept = out.filter((x) => !Number.isNaN(x));
    this.dropped += out.length - kept.length;
    return kept;
  }

  async set(args: { set?: { layer: number; effect?: number; on: boolean }[]; bpc?: number }) {
    // in "ask" mode the user approves the first switch, with what the profile will do
    const approval = this.approval;
    this.approval = undefined;
    const r = await runJsx(PROFILE_SWITCH_JSX, { comp: this.comp, ...args }, { undoGroup: "Surehand MCP render profile switch", timeoutMs: 60_000, bridge: approval ? { approval } : undefined });
    this.switchCalls++;
    if (!r.ok) throw new Error(r.error?.message || "After Effects could not set the switch.");
  }

  /** `runs` renders at each time; with a toggle, A/B in alternating order (a slow drift favours neither), switched back after each B. */
  async frames(times: number[], runs: number, toggle: Toggle | null, until: number): Promise<{ frames: Timed[]; stopped: boolean }> {
    const out: Timed[] = [];
    const off = async (t: number) => {
      const g = toggle!;
      await this.set(g.bpc ? { bpc: g.bpc } : { set: [{ layer: g.layer!, effect: g.effect, on: false }] });
      try {
        return await this.render(t);
      } finally {
        await this.set(g.bpc ? { bpc: g.back } : { set: [{ layer: g.layer!, effect: g.effect, on: true }] });
      }
    };
    for (const t of times) {
      const base: number[] = [], alt: number[] = [];
      for (let r = 0; r < runs; r++) {
        // a frame counts only with all its runs
        if (timing.now() > until) return { frames: out, stopped: true };
        if (toggle && r % 2 === 1) alt.push(await off(t));
        base.push(await this.render(t));
        if (toggle && r % 2 === 0) alt.push(await off(t));
      }
      const b = await this.clean(base, () => this.render(t));
      out.push(toggle ? { t, base: b, off: await this.clean(alt, () => off(t)) } : { t, base: b });
    }
    return { frames: out, stopped: false };
  }

  cleanup() {
    try {
      for (const f of readdirSync(this.dir)) if (f.startsWith(this.prefix)) rmSync(join(this.dir, f), { force: true });
    } catch {}
  }
}

/** Put every layer and effect switch and the bit depth back as `before` says (only what differs is written), and read them back. */
async function restoreSwitches(timer: Timer, before: Info): Promise<{ ok: boolean; after: Info; wrote: boolean }> {
  const read = () => readInfo({ comp: before.comp.id, frameList: before.frames });
  let after = await read();
  if (switches(after) === switches(before)) return { ok: true, after, wrote: false };
  const set = before.layers.flatMap((l) => [{ layer: l.id, on: !!l.on }, ...(l.fx ?? []).map((f) => ({ layer: l.id, effect: f.i, on: !!f.on }))]);
  await timer.set({ set, bpc: before.bpc });
  after = await read();
  return { ok: switches(after) === switches(before), after, wrote: true };
}

/** What optimize and the end of measure compare: every switch the profile touches (layers, effects, bit depth). */
export const switches = (i: Info) =>
  JSON.stringify([i.bpc, i.layers.map((l) => [l.id, l.on, l.lock ?? 0, (l.fx ?? []).map((f) => f.on)])]);

// ---------- measure ----------

export interface ProfileInput {
  action: "measure" | "optimize";
  comp?: number | string;
  startFrame?: number;
  endFrame?: number;
  frames?: number;
  runs?: number;
  slowFrames?: number;
  layers?: boolean;
  bitDepthCheck?: boolean;
  timeBudgetSeconds?: number;
  id?: string;
  findings?: string[];
}

const probeable = (l: InfoLayer) => !!l.on && !l.noVideo && !l.guide && l.t !== "null" && l.t !== "camera";
const activeAt = (l: InfoLayer, t: number) => t >= l.inP && t < l.outP;

export async function measure(input: ProfileInput, perm: { mode: string } = { mode: "full" }): Promise<CallToolResult> {
  const t0 = timing.now(), budget = (input.timeBudgetSeconds ?? 300) * 1000, deadline = t0 + budget, left = () => deadline - timing.now();
  const runs = input.runs ?? 3;
  const info = await readInfo({ comp: input.comp, startFrame: input.startFrame, endFrame: input.endFrame, frames: input.frames, constants: true });
  const C = info.comp, fd = C.fd;
  const notes: string[] = [];
  // switching layers, effects or the bit depth is an edit (put back): not in read-only mode
  const readOnly = perm.mode === "read-only";
  if (readOnly && (input.layers !== false || (info.bpc === 32 && input.bitDepthCheck !== false)))
    notes.push("Read-only mode: only the frame times were measured. Measuring layers, effects and the bit depth switches them off and back, which read-only mode doesn't allow.");
  const timer = new Timer(
    C.id,
    perm.mode === "ask" && !readOnly
      ? { tool: "Render profile", summary: `Switch layers and effects of "${C.name}" off one at a time${info.bpc === 32 ? " (and the project to 16 bpc)" : ""} to time them, and back; every switch is put back and read back.` }
      : undefined,
  );
  const findings: Finding[] = [];
  const add = (f: Omit<Finding, "id">) => findings.push({ id: `F${findings.length + 1}`, ...f } as Finding);
  const costs: Cost[] = [];
  const skipped: string[] = [];
  let frames: { frame: number; ms: number; runs: number[] }[] = [], noise = 0, slow: number[] = [], bitDepth: string | null = null;
  let restored: { ok: boolean; after: Info; wrote: boolean } | null = null, restoreError = "";
  try {
    await timer.calibrate();
    // 1. per-frame render times (at most 40% of the budget)
    const heat = await timer.frames(info.frames.map((f) => f * fd), runs, null, t0 + budget * 0.4);
    frames = heat.frames.map((f) => ({ frame: Math.round(f.t / fd), ms: median(f.base), runs: f.base }));
    if (heat.stopped) notes.push(`Time budget: ${frames.length} of ${info.frames.length} sampled frames were measured (40% of the budget goes to the frame times).`);
    // spread of repeated renders of the same frame: below it, a difference is noise
    noise = frames.length ? median(frames.map((f) => (Math.max(...f.runs) - Math.min(...f.runs)) / 2)) : 0;
    const warm = frames.filter((f) => f.runs.length > 1 && f.runs[0] > 1.5 * median(f.runs.slice(1)));
    if (warm.length > frames.length / 2)
      notes.push(`The first render of a frame was much slower than the repeats at ${warm.length} of ${frames.length} frames: something is cached that purging the image cache doesn't clear (disk cache, footage or plug-in caches), so the medians lean toward cached renders.`);
    slow = [...frames].sort((a, b) => b.ms - a.ms).slice(0, input.slowFrames ?? 2).map((f) => f.frame).sort((a, b) => a - b);
    const slowTimes = slow.map((f) => f * fd);

    // 2. the bit depth check: 32 bpc, proven identical at 16 bpc before it is suggested (16 bpc is set in its own call
    // and set back after the comparison: After Effects renders after a call returns, so the setting must stay meanwhile)
    if (info.bpc === 32 && input.bitDepthCheck !== false && !readOnly && slow.length && left() > 0) {
      const times = frames.length <= 8 ? frames.map((f) => f.frame * fd) : [...new Set([...slow, ...frames.filter((_, i) => i % Math.ceil(frames.length / 6) === 0).map((f) => f.frame)])].slice(0, 12).map((f) => f * fd);
      const proof = await captureProof({ comps: [C.id], times });
      await timer.set({ bpc: 16 });
      let cmp: Awaited<ReturnType<typeof compareProof>>;
      try {
        cmp = await compareProof({ id: proof.id });
      } finally {
        await timer.set({ bpc: 32 });
      }
      if (typeof cmp === "string") bitDepth = `16 bpc could not be checked: ${cmp}`;
      else if (cmp.verdict === "identical" || cmp.verdict === "identical within tolerance") {
        const ab = await timer.frames(slowTimes, runs, { bpc: 16, back: 32 }, deadline);
        const pairs = ab.frames.map((f) => [median(f.base), median(f.off!)]);
        const speed = pairs.length
          ? `at ${plural(pairs.length, "slow frame")} it renders in ${ms(pairs.reduce((s, p) => s + p[1], 0) / pairs.length)} instead of ${ms(pairs.reduce((s, p) => s + p[0], 0) / pairs.length)}`
          : "its speed was not measured (time budget)";
        add({
          kind: "bit-depth",
          applicable: true,
          text: `The project is 32 bpc, and 16 bpc gives the same picture: ${cmp.text.split("\n")[0].replace(/^Verdict: /, "")} (proof ${proof.id}, "${C.name}" at ${times.length} frames). At 16 bpc ${speed}. Fix: project bit depth 16 bpc (all comps; optimize proves the render queue's comps too).`,
        });
      } else bitDepth = `32 bpc → 16 bpc was checked and changes the picture (${cmp.text.split("\n")[0].replace(/^Verdict: /, "")}; proof ${proof.id}): 32 bpc is needed here, so it isn't suggested.`;
    }

    // 3. per-layer, then per-effect cost at the slow frames
    const probe = async (l: InfoLayer, effect?: InfoFx) => {
      const ts = slowTimes.filter((t) => activeAt(l, t));
      if (!ts.length) return;
      const res = await timer.frames(ts, runs, { layer: l.id, effect: effect?.i }, deadline);
      if (!res.frames.length) return void skipped.push(`${quote(l.n)}${effect ? ` > ${quote(effect.n)}` : ""}`);
    const each = res.frames.map((f) => ({ frame: Math.round(f.t / fd), cost: median(f.base) - median(f.off!), base: median(f.base) }));
    const cost = each.reduce((s, e) => s + e.cost, 0) / each.length, base = each.reduce((s, e) => s + e.base, 0) / each.length;
    costs.push({ layer: l.id, name: l.n, effect: effect?.i, effectName: effect?.n, frames: each.map((e) => e.frame), ms: r1(cost), pct: r1((100 * cost) / base), base: r1(base) });
  };
    if (input.layers !== false && !readOnly && slow.length) {
    // precomps and layers with many effects first, so a short budget measures what likely matters; invisible layers too
    const order = info.layers.filter(probeable).sort((a, b) => (b.zero ?? 0) - (a.zero ?? 0) || (b.src?.comp ?? 0) - (a.src?.comp ?? 0) || (b.fx?.filter((f) => f.on).length ?? 0) - (a.fx?.filter((f) => f.on).length ?? 0) || a.i - b.i);
    for (const l of order) {
      if (left() <= 0) {
        skipped.push(quote(l.n));
        continue;
      }
      await probe(l);
    }
    const costly = costs.filter((c) => c.effect === undefined && c.ms >= Math.max(2, 2 * noise, 0.05 * c.base)).sort((a, b) => b.ms - a.ms);
    for (const c of costly) {
      const l = info.layers.find((x) => x.id === c.layer)!;
      for (const fx of (l.fx ?? []).filter((f) => f.on)) {
        if (left() <= 0) skipped.push(`${quote(l.n)} > ${quote(fx.n)}`);
        else await probe(l, fx);
      }
    }
  }
  } catch (e: any) {
    notes.push(`Measuring stopped: ${e?.message ?? e}. Only what was measured before is reported.`);
  } finally {
    // every switch back as it was, and read back (also after an error)
    try {
      restored = await restoreSwitches(timer, info);
    } catch (e: any) {
      restoreError = e?.message ?? String(e);
    }
    timer.cleanup();
  }
  const costOf = (id: number) => costs.find((c) => c.layer === id && c.effect === undefined);
  const real = (c?: Cost) => !!c && c.ms > spreadOf(noise);
  const costText = (c?: Cost) => (c ? `${ms(c.ms)} (${c.pct}% of the frame) at ${c.frames.map((f) => `f${f}`).join(", ")}` : "cost not measured");

  // 4. findings
  for (const l of info.layers) {
    if (!(l.zero && probeable(l) && !l.matte && l.t !== "light")) continue;
    const c = costOf(l.id);
    if (c && !real(c)) continue;
    add({
      kind: "invisible-layer",
      applicable: true,
      layers: [l.id],
      text: `Layer ${l.i} ${quote(l.n)} (${l.t}) has opacity 0 at every sampled frame where it is active, but is switched on: ${costText(c)}. Fix: switch it off (an effect or expression that uses it can still change the picture: optimize proves it).`,
    });
  }
  const mbLayers = C.mb ? info.layers.filter((l) => l.on && l.mb && l.ex?.length) : [];
  if (mbLayers.length) {
    const samples = `${C.spf ?? 16} samples per frame (adaptive up to ${C.asl ?? 128})`;
    const consts = mbLayers.flatMap((l) => (l.ex ?? []).filter((e) => e.constant).map((e) => ({ l, e })));
    const moving = mbLayers.flatMap((l) => (l.ex ?? []).filter((e) => !e.constant).map((e) => ({ l, e })));
    if (moving.length)
      add({
        kind: "motion-blur-expressions",
        applicable: false,
        text: `Motion blur is on with ${samples}, and ${plural(moving.length, "expression")} on ${plural(new Set(moving.map((m) => m.l.id)).size, "motion-blurred layer")} change over time, so After Effects evaluates them for every motion blur sample: ` +
          `${moving.slice(0, 6).map((m) => `${quote(m.l.n)} > ${m.e.name}`).join(", ")}${moving.length > 6 ? ", ..." : ""}. Layer cost: ${[...new Set(moving.map((m) => m.l))].slice(0, 4).map((l) => `${quote(l.n)} ${costText(costOf(l.id))}`).join("; ")}. ` +
          `Not applied automatically: baking them to keyframes per frame changes the motion between frames, so the blur would differ. Fewer samples or simpler expressions are the user's call.`,
      });
    if (consts.length)
      add({
        kind: "constant-expressions",
        applicable: true,
        exprs: consts.map((c) => ({ layer: c.l.id, path: c.e.path })),
        text: `${plural(consts.length, "expression")} on motion-blurred layers give the same value at every sampled frame and between frames, yet are evaluated for every motion blur sample (${samples}): ` +
          `${consts.slice(0, 6).map((c) => `${quote(c.l.n)} > ${c.e.name}`).join(", ")}${consts.length > 6 ? ", ..." : ""}. Fix: set the value and switch the expression off (its text is kept).`,
      });
  }
  for (const l of info.layers) {
    if (!l.on || l.t !== "precomp" || !l.src || l.cl) continue;
    const s = (l.scale ?? 100) / 100, shown = s * s, area = (l.src.w * l.src.h) / (C.w * C.h);
    if (shown > 0.25 && area < 4) continue;
    const why = shown <= 0.25
      ? `it is ${l.src.w}x${l.src.h} but shown at most at ${Math.round(s * 100)}% (about ${Math.round(l.src.w * s)}x${Math.round(l.src.h * s)}), so it renders ${r1(1 / shown)}x the pixels it shows`
      : `it is ${l.src.w}x${l.src.h}, ${r1(area)}x the area of this ${C.w}x${C.h} comp`;
    add({ kind: "oversized-precomp", applicable: false, layers: [l.id], text: `Precomp layer ${l.i} ${quote(l.n)}: ${why}. Layer cost: ${costText(costOf(l.id))}. Not applied automatically: resizing a precomp moves and crops its content, which can't be proven identical in general.` });
  }
  for (const l of info.layers) {
    const c = costOf(l.id);
    if (l.shy && real(c)) add({ kind: "hidden-cost", applicable: false, layers: [l.id], text: `Layer ${l.i} ${quote(l.n)} is shy (hidden in the timeline) but renders: ${costText(c)}.` });
  }
  // X-ray's facts about this comp (read-only, fast): effects on disabled, shy or guide layers
  try {
    const x = await runJsx(XRAY_JSX, { sections: ["weight"], comps: [C.id], timeBudgetSeconds: 20 }, { undoGroup: false, timeoutMs: 120_000 });
    if (x.ok) {
      const w = analyzeXray((typeof x.result === "string" ? JSON.parse(x.result) : x.result) as XData).weight;
      const hidden = (w?.hiddenCost as { at: string; is: string[]; effects: string[] }[] | undefined) ?? [];
      if (hidden.length)
        add({
          kind: "hidden-cost",
          applicable: false,
          text: `X-ray: effects on hidden layers: ${hidden.slice(0, 5).map((h) => `${h.at} (${h.is.join(", ")}: ${h.effects.join(", ")})`).join("; ")}. ${w?.hiddenCostNote ?? ""}`.trim(),
        });
    }
  } catch {} // the profile doesn't depend on it
  add({
    kind: "multi-frame-rendering",
    applicable: false,
    text: "Multi-Frame Rendering: not knowable from scripting. Whether an effect supports it is a flag the plug-in gives After Effects; the scripting API doesn't expose it, so no effect is named here. After Effects marks such effects with a warning icon in the Effect Controls panel.",
  });

  // 5. the project is as it was: every switch read back; no Edit > Undo was run
  let unchanged: string;
  if (!restored || !restored.ok)
    unchanged = `PROJECT CHANGED: the layer or effect switches${info.bpc === 32 ? " or the bit depth" : ""} don't read back as before the profile${restoreError ? ` (${restoreError})` : ""}. Check the comp before going on; Edit > Undo history lists the "Surehand MCP render profile switch" steps.`;
  else {
    const steps = timer.switchCalls;
    unchanged =
      `Project unchanged: all ${plural(info.layers.length, "layer")}' and their effects' switches${info.bpc === 32 ? " and the bit depth" : ""} read back as before` +
      (restored.wrote ? " (after putting back what an interrupted measurement had left switched)." : ".") +
      (steps ? ` Edit > Undo history now has ${plural(steps, '"Surehand MCP render profile switch" step')} (each switch off and its switch back); they cancel each other, and nothing was undone.` : "");
    if (info.dirty === false && restored.after.dirty === true)
      unchanged += " After Effects now marks the project as having unsaved changes (the switches were edits, though they were put back); a script can't clear that mark without saving, which the profile never does.";
  }

  const profile: Profile = {
    id: `${stamp()}-${randomBytes(2).toString("hex")}`,
    createdAt: new Date().toISOString(),
    project: info.project,
    comp: { id: C.id, name: C.name, fps: C.fps, f0: C.f0, f1: C.f1 },
    runs,
    frames: frames.map(({ frame, ms }) => ({ frame, ms })),
    slow,
    costs,
    findings,
  };
  saveProfile(profile);
  return { content: [{ type: "text", text: report(profile, info, { noise, notes, skipped, bitDepth, unchanged, overhead: timer.overhead, redone: timer.redone, dropped: timer.dropped, seconds: (timing.now() - t0) / 1000 }) }] };
}

function report(p: Profile, info: Info, o: { noise: number; notes: string[]; skipped: string[]; bitDepth: string | null; unchanged: string; overhead: number; redone: number; dropped: number; seconds: number }) {
  const C = info.comp, L: string[] = [];
  const count = C.f1 - C.f0 + 1;
  L.push(
    `Render profile ${p.id} of ${quote(C.name)} (${C.w}x${C.h}, ${r1(C.fps)} fps, ${info.bpc} bpc${C.res && (C.res[0] > 1 || C.res[1] > 1) ? `, comp resolution 1/${C.res[0]}` : ""}), frames ${C.f0}-${C.f1}: ` +
      `${plural(p.frames.length, "frame")} measured, median of ${p.runs} renders each, image cache purged before every render; ${r1(o.seconds)} s.`,
  );
  if (!p.frames.length) L.push("No frame was measured (time budget). Raise timeBudgetSeconds, or measure fewer frames.");
  else {
    const all = p.frames.map((f) => f.ms), mean = all.reduce((s, x) => s + x, 0) / all.length;
    const top = p.frames.reduce((a, b) => (b.ms > a.ms ? b : a)), low = p.frames.reduce((a, b) => (b.ms < a.ms ? b : a));
    L.push(`Frame time: median ${ms(median(all))}, slowest ${ms(top.ms)} at f${top.frame}, fastest ${ms(low.ms)} at f${low.frame}; repeat renders vary by about ±${ms(o.noise)}. Estimated for all ${count} frames: ${ms(mean * count)} (mean of the samples; not a full render).`);
    const rows = heatMap(p.frames, C.f0, C.f1);
    L.push("", "Heat map (render time per frame; each row is one sampled frame and the frames around it):", ...rows.map((r) => r.line));
    const ranges = slowestRanges(rows);
    if (ranges.length) L.push(`Slowest: ${ranges.map((r) => `f${r.from}-f${r.to} (${r.lo === r.hi ? ms(r.hi) : `${ms(r.lo)}-${ms(r.hi)}`})`).join(", ")}.`);
  }
  if (p.costs.length) {
    L.push("", `Cost at the slowest frames ${p.slow.map((f) => `f${f}`).join(", ")} (each switched off in turn, A/B, median of ${p.runs}; the frame's time minus its time without it):`);
    const layerCosts = p.costs.filter((c) => c.effect === undefined).sort((a, b) => b.ms - a.ms);
    for (const c of layerCosts) {
      const l = info.layers.find((x) => x.id === c.layer);
      L.push(`  ${String(l?.i ?? "?").padStart(3)}. ${quote(c.name)}${l ? ` (${l.t})` : ""}: ${ms(c.ms)}, ${c.pct}%${costNote(c.ms, o.noise)}`);
      for (const e of p.costs.filter((x) => x.layer === c.layer && x.effect !== undefined).sort((a, b) => b.ms - a.ms))
        L.push(`         effect ${quote(e.effectName!)}: ${ms(e.ms)}, ${e.pct}%${costNote(e.ms, o.noise)}`);
    }
    L.push("  Costs overlap (layers interact: mattes, adjustment layers, expressions), so they don't add up to the frame time.");
  }
  if (o.skipped.length) L.push(`Not measured (time budget): ${o.skipped.slice(0, 12).join(", ")}${o.skipped.length > 12 ? `, and ${o.skipped.length - 12} more` : ""}.`);
  L.push("", "Findings:");
  for (const f of p.findings) L.push(`  ${f.id} [${f.applicable ? "can apply" : f.kind === "multi-frame-rendering" ? "unknown" : "advice"}] ${f.text}`);
  if (o.bitDepth) L.push(`  (bit depth) ${o.bitDepth}`);
  L.push("", o.unchanged);
  L.push(
    `Accuracy: wall-clock time from the call that starts a render until its PNG is written (PNG encoding included), minus the measured round trip of a call (${ms(o.overhead)}); ` +
      "polled every 1-10 ms; After Effects' disk cache and plug-in caches are not purged; " +
      "times between the sampled frames are estimates; another app using the CPU or GPU shows up as noise.",
  );
  if (o.redone) L.push(`${plural(o.redone, "render")} far below the other renders of the same frame ${o.redone === 1 ? "was" : "were"} rendered again${o.dropped ? `; ${o.dropped} still too low ${o.dropped === 1 ? "was" : "were"} left out of the medians` : ""}.`);
  if (o.notes.length) L.push(...o.notes);
  const ids = p.findings.filter((f) => f.applicable).map((f) => f.id);
  if (ids.length) L.push(`Apply with proof: ae_render_profile {action: "optimize", id: "${p.id}", findings: ${JSON.stringify(ids)}}.`);
  return L.join("\n");
}

// ---------- optimize ----------

type Step = { tool: string; args: Record<string, unknown> };

/**
 * The batch steps for a finding, from fresh facts, and the steps that put it back exactly (the reason instead when it
 * no longer applies). A change that isn't proven is reverted with these, never with Edit > Undo.
 */
export function stepsFor(f: Finding, info: Info): { steps: Step[]; revert: Step[] } | { why: string } {
  const C = info.comp.id;
  if (f.kind === "bit-depth")
    return info.bpc === 32
      ? { steps: [{ tool: "ae_color_settings", args: { bitsPerChannel: 16 } }], revert: [{ tool: "ae_color_settings", args: { bitsPerChannel: 32 } }] }
      : { why: `the project is ${info.bpc} bpc now` };
  if (f.kind === "invisible-layer") {
    const l = info.layers.find((x) => x.id === f.layers?.[0]);
    if (!l) return { why: "the layer is not in the comp any more" };
    if (!l.on) return { why: "the layer is already switched off" };
    if (!l.zero) return { why: "the layer is not at opacity 0 at every sampled frame any more" };
    return { steps: [{ tool: "ae_set_layer_attributes", args: { comp: C, layer: l.i, enabled: false } }], revert: [{ tool: "ae_set_layer_attributes", args: { comp: C, layer: l.i, enabled: true } }] };
  }
  if (f.kind === "constant-expressions") {
    const steps: Step[] = [], revert: Step[] = [];
    for (const x of f.exprs ?? []) {
      const l = info.layers.find((y) => y.id === x.layer), e = l?.ex?.find((y) => y.path.join("/") === x.path.join("/"));
      if (!l || !e?.constant || e.expr === undefined) return { why: `an expression on ${l ? quote(l.n) : "a layer that is gone"} is not constant (or not there) any more` };
      steps.push({ tool: "ae_set_property", args: { comp: C, layer: l.i, path: e.path, value: e.value } });
      steps.push({ tool: "ae_set_expression", args: { comp: C, layer: l.i, path: e.path, expression: e.expr, enabled: false } });
      // back: the value under the expression as it was, and the expression on
      revert.push({ tool: "ae_set_property", args: { comp: C, layer: l.i, path: e.path, value: e.pre } });
      revert.push({ tool: "ae_set_expression", args: { comp: C, layer: l.i, path: e.path, expression: e.expr, enabled: true } });
    }
    return { steps, revert };
  }
  return { why: "it is advice only; optimize applies only findings marked [can apply]" };
}

/** Whether a finding's change is in the project (true), not there (false). */
function isApplied(f: Finding, info: Info): boolean {
  if (f.kind === "bit-depth") return info.bpc === 16;
  if (f.kind === "invisible-layer") return info.layers.find((x) => x.id === f.layers?.[0])?.on === 0;
  // a switched-off expression is no longer listed (only enabled expressions are)
  return (f.exprs ?? []).every((x) => !info.layers.find((y) => y.id === x.layer)?.ex?.some((e) => e.path.join("/") === x.path.join("/")));
}

/** The finding's targets read the same in both (switches, and the expressions with their values under them). */
const sameAs = (f: Finding, a: Info, b: Info) =>
  switches(a) === switches(b) &&
  (f.exprs ?? []).every((x) => {
    const get = (i: Info) => JSON.stringify(i.layers.find((y) => y.id === x.layer)?.ex?.find((e) => e.path.join("/") === x.path.join("/")) ?? null);
    return get(a) === get(b);
  });

const evenly = (a: number[], n: number) => (a.length <= n ? a : Array.from({ length: n }, (_, i) => a[Math.round((i * (a.length - 1)) / (n - 1))]));

export async function optimize(input: ProfileInput, perm: { mode: string; allowShell: boolean }): Promise<CallToolResult> {
  if (perm.mode === "read-only") return errorResult(READ_ONLY_REFUSAL);
  const p = loadProfile(input.id);
  if (typeof p === "string") return errorResult(p);
  if (!input.findings?.length) return errorResult(`Pass findings: the ids to apply (from profile ${p.id}: ${p.findings.filter((f) => f.applicable).map((f) => f.id).join(", ") || "none can be applied"}).`);
  const chosen: Finding[] = [];
  for (const id of input.findings) {
    const f = p.findings.find((x) => x.id === id);
    if (!f) return errorResult(`Profile ${p.id} has no finding ${id}.`);
    if (!f.applicable) return errorResult(`${id} is ${f.kind === "multi-frame-rendering" ? "a note" : "advice"}, not a change optimize can prove and apply.`);
    if (!chosen.includes(f)) chosen.push(f);
  }
  const t0 = timing.now(), budget = (input.timeBudgetSeconds ?? 300) * 1000, deadline = t0 + budget, left = () => deadline - timing.now();
  const frameList = p.frames.map((f) => f.frame);
  let info = await readInfo({ comp: p.comp.id, frameList, constants: true });
  if (info.project !== p.project || info.comp.name !== p.comp.name)
    return errorResult(`Profile ${p.id} was measured in ${p.project ?? "an unsaved project"} ("${p.comp.name}"); the open project is ${info.project ?? "unsaved"}${info.comp.name !== p.comp.name ? ` and comp id ${p.comp.id} is "${info.comp.name}"` : ""}. Measure again.`);
  if (!info.project) return errorResult("Save the project first: optimize saves a checkpoint before it changes anything.");
  const fd = info.comp.fd, runs = p.runs;
  // the same frames before and after, slowest first, so a short budget measures the frames that matter
  const order = [...p.frames].sort((a, b) => b.ms - a.ms).map((f) => f.frame * fd);
  const timer = new Timer(p.comp.id);
  let before: { frames: Timed[] } = { frames: [] }, beforeProblem = "";
  try {
    await timer.calibrate();
    before = await timer.frames(order, runs, null, t0 + budget * 0.3);
  } catch (e: any) {
    beforeProblem = ` (${e?.message ?? e})`;
  }
  const lines: string[] = [];
  let cp: string | null = null, kept = 0, stop: string | null = null;
  const proveTimes = evenly([...new Set([...p.slow, ...frameList])].sort((a, b) => a - b), 24).map((f) => f * fd);
  for (const f of chosen) {
    if (stop) {
      lines.push(`${f.id}: not applied (${stop}).`);
      continue;
    }
    if (left() <= 0) {
      lines.push(`${f.id}: not applied (time budget used up; nothing was changed for it).`);
      continue;
    }
    info = await readInfo({ comp: p.comp.id, frameList, constants: true });
    const s = stepsFor(f, info);
    if ("why" in s) {
      lines.push(`${f.id}: not applied (${s.why}).`);
      continue;
    }
    if (!cp) {
      const c = await saveCheckpoint("before-render-optimize");
      cp = c.file;
    }
    const comps = f.kind === "bit-depth" ? [...new Set([p.comp.id, ...info.rq])].slice(0, 4) : [p.comp.id];
    const proof = await captureProof({ comps, times: proveTimes });
    const b = await runBatch({ steps: s.steps, name: `Surehand MCP render optimization ${f.id}` }, perm);
    const batchText = b.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    if (b.isError) {
      lines.push(`${f.id}: not applied: the edit failed and was rolled back.\n${batchText}`);
      continue;
    }
    let verdict = "", proofLine = "";
    try {
      const cmp = await compareProof({ id: proof.id });
      if (typeof cmp === "string") throw new Error(cmp);
      verdict = cmp.verdict;
      proofLine = cmp.text.split("\n")[0].replace(/^Verdict: /, "");
    } catch (e: any) {
      proofLine = `the comparison failed: ${e?.message ?? e}`;
    }
    if (verdict === "identical" || verdict === "identical within tolerance") {
      kept++;
      lines.push(`${f.id}: KEPT: ${proofLine.replace(/\.$/, "")} (proof ${proof.id}; one undo step).`);
      continue;
    }
    // not proven: put it back with its own steps (never Edit > Undo, which could revert something else), and read it back
    let reverted = false;
    try {
      const now = await readInfo({ comp: p.comp.id, frameList, constants: true });
      if (isApplied(f, now) || !sameAs(f, now, info)) {
        const rb = await runBatch({ steps: s.revert, name: `Surehand MCP render optimization ${f.id} (put back)` }, perm);
        const back = await readInfo({ comp: p.comp.id, frameList, constants: true });
        reverted = !rb.isError && !isApplied(f, back) && sameAs(f, back, info);
      } else reverted = true;
    } catch {}
    const word = verdict === "differs" ? "DIFFERS" : "NOT PROVEN";
    if (reverted) lines.push(`${f.id}: NOT KEPT, put back automatically: ${proofLine.replace(/\.$/, "")} (proof ${proof.id}; compare it again with ae_prove_identical {action: "compare", id: "${proof.id}"} to see where).`);
    else {
      stop = `stopped after ${f.id} could not be put back`;
      lines.push(`${f.id}: ${word}: ${proofLine.replace(/\.$/, "")}. The change could NOT be put back automatically: restore the checkpoint ${cp} (ae_checkpoint restore), or undo it by hand.`);
    }
  }
  // after: the same frames as before (only frames measured both times count)
  let after: { frames: Timed[] } = { frames: [] }, afterProblem = "";
  try {
    if (kept && before.frames.length) after = await timer.frames(before.frames.map((f) => f.t), runs, null, deadline);
  } catch (e: any) {
    afterProblem = ` (${e?.message ?? e})`;
  } finally {
    timer.cleanup();
  }
  const pairs = after.frames.map((a) => ({ t: a.t, after: median(a.base), before: median(before.frames.find((b) => b.t === a.t)!.base) }));
  const head: string[] = [`Render optimization of "${p.comp.name}" from profile ${p.id}: ${kept} of ${chosen.length} finding${chosen.length === 1 ? "" : "s"} kept.`];
  if (cp) head.push(`Checkpoint saved before the first change: ${cp}`);
  if (!kept) head.push("Nothing was kept, so the render time is unchanged.");
  else if (!pairs.length) head.push(`Time saved: not measured (${beforeProblem ? `the measurement before failed${beforeProblem}` : afterProblem ? `the re-measure failed${afterProblem}` : "time budget"}). The kept changes are proven identical; measure again to see the time.`);
  else {
    const b = pairs.reduce((s, x) => s + x.before, 0), a = pairs.reduce((s, x) => s + x.after, 0), count = p.comp.f1 - p.comp.f0 + 1;
    const per = (b - a) / pairs.length, how = `median of ${runs}, cache purged, before and after in this run`;
    // spread of repeat renders of the same frame, before and after: a smaller difference per frame is no measured change
    const spread = spreadOf(median([...before.frames, ...after.frames].map((f) => (f.base.length > 1 ? (Math.max(...f.base) - Math.min(...f.base)) / 2 : 0))));
    if (Math.abs(per) <= spread)
      head.push(`No measurable speed-up at the ${plural(pairs.length, "sampled frame")} (${how}): the difference is ${ms(per)} per frame, within the ±${ms(spread)} spread of repeat renders.`);
    else if (per < 0)
      head.push(`Not faster at the ${plural(pairs.length, "sampled frame")} (${how}): ${ms(-per)} per frame slower, beyond the ±${ms(spread)} spread of repeat renders (caching or other work on this computer can do that; the kept changes are still proven identical).`);
    else
      head.push(
        `Time saved at ${plural(pairs.length, "measured frame")} (${how}): ${ms(b - a)} of ${ms(b)} (${r1((100 * (b - a)) / b)}%), ` +
          `${ms(per)} per frame (repeat renders vary by ±${ms(spread)}); about ${ms(per * count)} over all ${count} frames (estimate from the sampled frames).`,
      );
    head.push(...pairs.sort((x, y) => x.t - y.t).map((x) => `  f${Math.round(x.t / fd)}: ${ms(x.before)} → ${ms(x.after)}`));
  }
  if (timer.redone) head.push(`${plural(timer.redone, "render")} far below the other renders of the same frame rendered again${timer.dropped ? `, ${timer.dropped} still too low left out` : ""}.`);
  return { content: [{ type: "text", text: [...head, "", ...lines, "", "Every kept change was proven with ae_prove_identical at the default tolerance (only the sampled frames are compared; not audio or the times between them)."].join("\n") }] };
}

export function registerRenderProfileTools(server: McpServer) {
  server.registerTool(
    "ae_render_profile",
    {
      title: "Render profile",
      description:
        "Where a comp's render time goes over the whole timeline, and proven speed-ups. measure: times sampled frames (cache purged, median of runs) " +
        "as a text heat map with the slowest ranges, then each layer and effect switched off in turn at the slowest frames (cost in ms and %), and " +
        "findings with evidence (invisible layers that cost time, 32 bpc where 16 bpc is proven identical, expressions under motion blur, oversized " +
        "precomps, hidden costs). The project is left exactly as it was. optimize: applies chosen findings one at a time after a checkpoint, proves " +
        "each with ae_prove_identical, puts back any that isn't identical, and reports the time saved.",
      inputSchema: {
        action: z.enum(["measure", "optimize"]),
        comp: z.union([z.number().int(), z.string()]).optional().describe("measure: comp id or exact name (default the active comp)."),
        startFrame: z.number().int().min(0).optional().describe("measure: first frame (counted from the comp start at 0; default the work area)."),
        endFrame: z.number().int().min(0).optional().describe("measure: last frame (default the work area)."),
        frames: z.number().int().min(1).max(120).optional().describe("measure: frames sampled evenly over the range (default 24)."),
        runs: z.number().int().min(1).max(9).optional().describe("measure: renders per measurement, the median counts (default 3)."),
        slowFrames: z.number().int().min(1).max(5).optional().describe("measure: slowest frames at which layers and effects are measured (default 2)."),
        layers: z.boolean().optional().describe("measure: measure each layer and effect (default true)."),
        bitDepthCheck: z.boolean().optional().describe("measure: in a 32 bpc project, prove whether 16 bpc gives the same picture (default true)."),
        timeBudgetSeconds: z.number().min(10).max(3600).optional().describe("Stop starting new measurements after this long and report what was measured (default 300)."),
        id: z.string().optional().describe("optimize: the profile id from measure (default the latest)."),
        findings: z.array(z.string()).min(1).max(20).optional().describe('optimize: finding ids to apply, e.g. ["F1", "F3"] (only those marked [can apply]).'),
      },
      // optimize edits (each change is one undo step, checkpoint first); measure switches layers off and back, and reads them back
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input: ProfileInput) => {
      try {
        return input.action === "measure" ? await measure(input, permissions()) : await optimize(input, permissions());
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
