// The chunk plan: a render queue item split into frame ranges, for N processes on this machine or for named machines,
// each with its aerender command line (the user's own render settings and output modules: -rqindex, never a canned
// output), per-machine scripts (.command / .sh and .bat), the join step for movie formats and when it is (not) safe, and
// a time estimate from the render profiler's measurements.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { cpus as osCpus, totalmem } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { VERSION } from "../config.js";
import { appFile } from "../paths.js";
import type { Profile } from "../tools/renderprofile.js";
import { displayStart, itemFrames, outputInfo, renderInfo, type OutputInfo, type ScanItem } from "./manifest.js";
import { batQuote, defaultAerender, mapPath, shQuote, type PathMapping, type Platform } from "./paths.js";
import { parseTemplate } from "./seq.js";

// ---------- splitting ----------

export interface Range { first: number; last: number; frames: number }

/**
 * first..last split into contiguous ranges in proportion to the weights (equal weights: sizes differ by at most one
 * frame). Fewer frames than parts: one frame per part, and the extra parts are left out (never an empty range).
 */
export function splitFrames(first: number, last: number, weights: number[]): (Range & { part: number })[] {
  const total = last - first + 1;
  if (total < 1 || !weights.length) return [];
  if (total < weights.length) return Array.from({ length: total }, (_, i) => ({ part: i, first: first + i, last: first + i, frames: 1 }));
  const w = weights.map((x) => (x > 0 && Number.isFinite(x) ? x : 1));
  const sum = w.reduce((a, b) => a + b, 0);
  const out: (Range & { part: number })[] = [];
  let acc = 0, start = first;
  for (let i = 0; i < w.length; i++) {
    acc += w[i];
    const end = i === w.length - 1 ? last : first + Math.round((total * acc) / sum) - 1;
    if (end >= start) {
      out.push({ part: i, first: start, last: end, frames: end - start + 1 });
      start = end + 1;
    }
  }
  return out;
}

/** How many aerender processes this machine runs at once: each is a whole After Effects (memory) and uses several cores. */
export function maxLocalProcesses(cpus = osCpus().length, memBytes = totalmem()): { max: number; why: string } {
  const gb = memBytes / 1024 ** 3;
  const byCpu = Math.max(1, Math.floor(cpus / 4)), byMem = Math.max(1, Math.floor((gb - 4) / 6));
  const max = Math.min(8, byCpu, byMem);
  return { max, why: `${cpus} cores (one process per 4) and ${Math.round(gb)} GB of memory (4 GB for the system, about 6 GB per process); at most 8` };
}

// ---------- joining movie chunks ----------

const INTRA = /prores|apch|apcn|apcs|apco|ap4h|ap4x|dnx|avid|qtrle|animation|\bpng\b|uncompressed|rawvideo|\bnone\b|v210|v410|r210|r10k|cineform|cfhd|jpeg ?2000|jpeg2000|j2k|mjpeg|photo.?jpeg|\bhap\b|ffv1|utvideo|\btiff?\b|\bdpx\b/i;
const LONG_GOP = /h\.?264|\bavc\b|x264|hevc|h\.?265|x265|mpeg-?2|mpeg2video|xdcam|mpeg-?4|\bav1\b|vp9|vp8|\bxvid\b/i;

export interface JoinSafety {
  safe: "yes" | "no" | "unknown";
  why: string[];
}

/**
 * Whether movie chunks join without loss by stream copy (ffmpeg concat, -c copy). Intra-frame codecs (ProRes, DNx,
 * Animation, PNG, uncompressed, CineForm...): yes. Long-GOP codecs (H.264, HEVC, MPEG-2...): no (each chunk restarts the
 * encoder: its own GOP and rate control; timestamps and B-frame reordering at the joins are not those of one render).
 * Audio: PCM joins exactly only where a join falls on a whole audio sample; AAC / MP3 / AC-3 add encoder delay at every
 * join (gaps or clicks). Unknown codec: decided after the render, from the parts (verify probes them).
 */
export function joinSafety(o: { format: string | null; codec: string | null; audio: "off" | "on" | "unknown"; audioCodec?: string | null; sampleRate?: number; fps: number; chunkFrames: number[] }): JoinSafety {
  const why: string[] = [];
  const v = `${o.codec ?? ""} ${o.format ?? ""}`;
  let safe: JoinSafety["safe"];
  if (o.codec && INTRA.test(o.codec)) {
    safe = "yes";
    why.push(`${o.codec} is an intra-frame codec: the parts join by stream copy, frame for frame`);
  } else if (LONG_GOP.test(v)) {
    safe = "no";
    why.push(`${o.codec ?? o.format} is a long-GOP codec: every part restarts the encoder (its own keyframes and rate control), so the joined file is not what one render makes and can stutter or glitch at the joins`);
  } else {
    safe = "unknown";
    why.push(`the codec ${o.codec ? `"${o.codec}" ` : ""}is ${o.codec ? "not one this knows" : "not exposed by scripting"}: verify probes the rendered parts and says whether they join by stream copy`);
  }
  if (o.audio === "on" || o.audio === "unknown") {
    const ac = o.audioCodec ?? null;
    if (ac && /^(aac|mp3|mp2|ac3|eac3|opus|vorbis)/i.test(ac)) {
      safe = "no";
      why.push(`the audio is ${ac}: every part starts with encoder delay, which leaves gaps or clicks at the joins (render the audio once, whole, and add it to the joined picture)`);
    } else if (ac && /^pcm/i.test(ac) && o.sampleRate) {
      const bad = o.chunkFrames.slice(0, -1).filter((f) => !Number.isInteger(Math.round(((f * o.sampleRate!) / o.fps) * 1e6) / 1e6));
      if (bad.length) {
        if (safe === "yes") safe = "no";
        why.push(`the audio is PCM at ${o.sampleRate} Hz, but ${bad.length} join(s) fall between audio samples at ${o.fps} fps: each shifts the audio by part of a sample (not lossless; render the audio whole, or pick chunk sizes whose length is a whole number of samples)`);
      } else why.push(`the audio is PCM and every join falls on a whole sample`);
    } else if (o.audio === "on") {
      if (safe === "yes") safe = "unknown";
      why.push("the audio codec is not known before the render: verify probes the parts (PCM joins on whole samples only; AAC never joins cleanly)");
    }
  }
  return { safe, why };
}

/** ffmpeg's concat list: one `file '<path>'` line per part ( ' written as '\'' ). */
export const concatList = (parts: string[]) => parts.map((p) => `file '${p.replace(/'/g, `'\\''`)}'`).join("\n") + "\n";
/** The join: ffmpeg's concat demuxer and stream copy; -n never replaces an existing file. */
export const concatArgs = (list: string, out: string, audio: boolean) => ["-hide_banner", "-n", "-f", "concat", "-safe", "0", "-i", list, "-map", "0:v", ...(audio ? ["-map", "0:a?"] : []), "-c", "copy", out];

// ---------- the estimate ----------

/** The newest render profile of this project's comp (ae_render_profile measure), if any. */
export function findProfile(project: string, compId: number, dir = appFile("profiles")): Profile | null {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort().reverse();
  } catch {
    return null;
  }
  for (const n of names) {
    try {
      const p = JSON.parse(readFileSync(join(dir, n), "utf8")) as Profile;
      if (p.comp?.id === compId && p.project === project && p.frames?.length) return p;
    } catch {}
  }
  return null;
}

/** Each frame's render time from the profile's samples: a sample stands for the frames up to halfway to its neighbours. */
export function frameCost(p: Pick<Profile, "frames">, frame: number): number {
  const fs = p.frames;
  let best = fs[0];
  for (const f of fs) if (Math.abs(f.frame - frame) < Math.abs(best.frame - frame)) best = f;
  return best.ms;
}
export const rangeCost = (p: Pick<Profile, "frames">, r: Range) => {
  let ms = 0;
  for (let f = r.first; f <= r.last; f++) ms += frameCost(p, f);
  return ms;
};

// ---------- the plan ----------

export interface MachineSpec { name: string; platform?: Platform; aerender?: string; pathMap?: PathMapping[]; weight?: number; processes?: number }

export interface Chunk extends Range {
  index: number;
  machine: string;
  /** a movie chunk's own file (sequences write into the user's own sequence) */
  output?: string;
  args: string[];
  estimateSeconds?: number;
}
export interface PlanMachine { name: string; platform: Platform; aerender: string; project: string; chunks: number[]; script?: string; local: boolean }

export interface FarmPlan {
  surehandFarmPlan: 1;
  createdAt: string;
  createdBy: string;
  project: { file: string; bytes: number | null; modified: string | null };
  afterEffects: { version: string | null; major: number | null };
  rqIndex: number;
  comp: { id: number; name: string; width: number; height: number; fps: number; displayStartFrame: number };
  frames: Range;
  output: OutputInfo;
  kind: "sequence" | "movie";
  sequence?: { template: string; pad: number; numbering: "comp frame" | "starting number" | "unknown"; firstFile: number; lastFile: number; offset: number };
  movie?: { final: string; parts: string[]; list: string; join: JoinSafety; command?: string[] };
  expected: { width: number | null; height: number | null; fps: number };
  machines: PlanMachine[];
  chunks: Chunk[];
  estimate: { source: "profile" | "sampled" | "none"; profileId?: string; seconds?: number; wallSeconds?: number; note: string };
  folder: string | null;
  scripts: string[];
  issues: string[];
  notes: string[];
}

export interface PlanInput {
  item: ScanItem;
  project: string;
  aeVersion: string | null;
  aeApp: string | null;
  /** this machine's aerender (local runs) */
  aerender: string | null;
  platform: Platform;
  processes?: number;
  machines?: MachineSpec[];
  pathMap?: PathMapping[];
  /** "auto": -mfr on with a share of the CPU when several processes run on one machine (After Effects 22+) */
  mfr?: "auto" | "on" | "off" | "leave";
  profile?: Profile | null;
  profileSource?: "profile" | "sampled";
  folder?: string | null;
  now?: Date;
  /** the project's own render queue item count: aerender's -rqindex is the position in the whole queue */
}

export class PlanRefusal extends Error {}

const r1 = (n: number) => Math.round(n * 10) / 10;
export const fmtDuration = (s: number) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${r1(s / 60)} min` : `${r1(s / 3600)} h`);

/** The aerender arguments for one chunk (no program name). */
export function aerenderArgs(o: { project: string; rqIndex: number; first: number; last: number; output?: string; mfr?: [string, number?] }): string[] {
  return ["-project", o.project, "-rqindex", String(o.rqIndex), "-s", String(o.first), "-e", String(o.last), ...(o.output ? ["-output", o.output] : []), "-v", "ERRORS_AND_PROGRESS", ...(o.mfr ? ["-mfr", o.mfr[0], ...(o.mfr[1] !== undefined ? [String(o.mfr[1])] : [])] : [])];
}

/** One command line for a script on that platform (paths with spaces quoted; % doubled in .bat). */
export const commandLine = (platform: Platform, bin: string, args: string[]) => (platform === "windows" ? [bin, ...args].map(batQuote).join(" ") : [bin, ...args].map(shQuote).join(" "));

export function buildPlan(o: PlanInput): FarmPlan {
  const it = o.item;
  const issues: string[] = [], notes: string[] = [];
  const rs = renderInfo(it.rs);
  const fr = itemFrames(it);
  const major = o.aeVersion ? Number(/^(\d+)/.exec(o.aeVersion)?.[1]) : null;
  if (it.oms.length !== 1)
    throw new PlanRefusal(`Render queue item ${it.index} has ${it.oms.length} output modules. aerender's -output sets only the first, so every chunk would write the others to the same files. Nothing was planned. Keep one output module on this item (duplicate the item for the others), then plan again.`);
  const out = outputInfo(it.oms[0]);
  if (!out.path) throw new PlanRefusal(`Render queue item ${it.index} has no output file. Set one in its output module, then plan again.`);
  if (out.format && /^(wav|aiff?|mp3)\b/i.test(out.format)) throw new PlanRefusal(`Render queue item ${it.index} renders audio only (${out.format}): audio isn't split into chunks. Render it whole (ae_render_background).`);
  if (rs.fpsOverride && Math.abs(rs.fpsOverride - it.comp.fps) > 1e-3)
    throw new PlanRefusal(`Render queue item ${it.index}'s render settings use their own frame rate (${rs.fpsOverride} fps, the comp is ${it.comp.fps} fps). aerender's -s / -e count the comp's frames, so the chunks would not line up with the frames this item renders. Nothing was planned. Render it whole, or set the frame rate in the comp.`);
  const raw = it.rs ?? {};
  const fields = Object.entries(raw).find(([k, v]) => /^Field Render$/i.test(k) && !/off/i.test(v));
  const pulldown = Object.entries(raw).find(([k, v]) => /pulldown/i.test(k) && !/off/i.test(v));
  if (fields || pulldown) issues.push(`the render settings use ${fields ? "field rendering" : "3:2 pulldown"}: a chunk boundary can break the field order or the pulldown cadence; check the joins, or render it whole`);

  // who renders what
  const local = !o.machines?.length;
  const machinesIn: MachineSpec[] = local ? [{ name: "this machine", platform: o.platform, aerender: o.aerender ?? undefined, processes: Math.max(1, o.processes ?? 1) }] : o.machines!;
  const slots: { m: number; weight: number }[] = [];
  machinesIn.forEach((m, i) => {
    const n = local ? Math.max(1, m.processes ?? 1) : Math.max(1, m.processes ?? 1);
    for (let k = 0; k < n; k++) slots.push({ m: i, weight: (m.weight ?? 1) / n });
  });
  const parts = splitFrames(fr.first, fr.last, slots.map((s) => s.weight));
  if (parts.length < slots.length) notes.push(`${fr.count} frame${fr.count === 1 ? "" : "s"} for ${slots.length} chunks: ${parts.length} chunk${parts.length === 1 ? "" : "s"} of one frame each; the others were left out`);

  // sequences: the files are numbered by the output module ("Use Comp Frame Number", or "Starting #" counted from each render's first frame)
  const many = parts.length > 1;
  let sequence: FarmPlan["sequence"], movie: FarmPlan["movie"];
  const kind: FarmPlan["kind"] = out.sequence ? "sequence" : "movie";
  const dstart = displayStart(it);
  if (kind === "sequence") {
    const tpl = parseTemplate(out.path);
    if (!tpl) throw new PlanRefusal(`Render queue item ${it.index} writes a sequence, but its file name ${out.path} has no [####] for the frame number. Add one in the output module, then plan again.`);
    const numbering = out.useCompFrameNumber === true ? "comp frame" : out.useCompFrameNumber === false ? "starting number" : "unknown";
    if (numbering === "starting number" && many)
      throw new PlanRefusal(
        `Render queue item ${it.index}'s output module numbers files from "Starting #" (${out.startingNumber ?? 0}), counted from each render's first frame, so every chunk would write the same file names and overwrite the others. Nothing was planned. ` +
          "Turn on \"Use Comp Frame Number\" in its Output Module Settings (or ae_set_render_settings), then plan again.",
      );
    if (numbering === "unknown") issues.push('the output module\'s "Use Comp Frame Number" could not be read: chunks only write one sequence when it is on (verify shows what was written)');
    const offset = numbering === "starting number" ? (out.startingNumber ?? 0) - fr.first : dstart;
    const firstFile = fr.first + offset, lastFile = fr.last + offset;
    if (String(Math.abs(lastFile)).length > tpl.pad) issues.push(`frame numbers reach ${lastFile}, more digits than the file name's [${"#".repeat(tpl.pad)}]: names get longer past ${"9".repeat(tpl.pad)} and sort out of order in some tools`);
    if (firstFile < 0) issues.push(`the files start at a negative frame number (${firstFile})`);
    sequence = { template: out.path, pad: tpl.pad, numbering, firstFile, lastFile, offset };
  } else {
    const ext = extname(out.path), stem = out.path.slice(0, out.path.length - ext.length);
    const partPaths = parts.map((_, i) => `${stem}_part${String(i + 1).padStart(2, "0")}of${String(parts.length).padStart(2, "0")}${ext}`);
    const audio = out.audio ? (/off/i.test(out.audio) ? "off" : /on/i.test(out.audio) ? "on" : "unknown") : "unknown";
    const safety = joinSafety({ format: out.format, codec: out.codec, audio, fps: it.comp.fps, sampleRate: out.audioSampleRate, chunkFrames: parts.map((p) => p.frames) });
    const list = o.folder ? join(o.folder, `${basename(stem)}_parts.txt`) : `${stem}_parts.txt`;
    movie = { final: out.path, parts: many ? partPaths : [out.path], list, join: safety, ...(many && safety.safe !== "no" ? { command: concatArgs(list, out.path, audio !== "off") } : {}) };
    if (many && safety.safe === "no") issues.push(`the chunks can't be joined without loss: ${safety.why.join("; ")}. Render an image sequence (or an intra-frame codec such as ProRes) in chunks instead, and make the final file from it in one go`);
  }

  // machines, commands, mfr
  const mfrMode = o.mfr ?? "auto";
  const mfrFor = (n: number): [string, number?] | undefined => {
    if (mfrMode === "leave" || (major !== null && major < 22)) return undefined;
    if (mfrMode === "off") return ["OFF"];
    if (mfrMode === "on") return ["ON"];
    return n > 1 ? ["ON", Math.max(10, Math.floor(100 / n))] : undefined;
  };
  if (major !== null && major < 22 && mfrMode !== "leave" && mfrMode !== "auto") notes.push("-mfr needs After Effects 22.0 or later; it was left out");
  const machines: PlanMachine[] = machinesIn.map((m) => {
    const platform = m.platform ?? o.platform;
    const map = [...(m.pathMap ?? []), ...(o.pathMap ?? [])];
    const project = mapPath(o.project, map);
    const aer = m.aerender ?? (local ? o.aerender : null) ?? (major !== null ? defaultAerender(platform, major) : null);
    if (!aer) throw new PlanRefusal(`No aerender for ${m.name}: pass its path (machines[].aerender).`);
    return { name: m.name, platform, aerender: aer, project, chunks: [], local };
  });
  const chunks: Chunk[] = parts.map((p, i) => {
    const mi = slots[p.part].m, m = machines[mi], spec = machinesIn[mi];
    const map = [...(spec.pathMap ?? []), ...(o.pathMap ?? [])];
    const procs = slots.filter((s) => s.m === mi).length;
    let output: string | undefined;
    if (kind === "movie") output = many ? movie!.parts[i] : undefined;
    // another machine that sees the output under another path writes there (for a sequence: its [####] name kept)
    const mappedOut = mapPath(out.path!, map);
    const outArg = output ? mapPath(output, map) : mappedOut !== out.path ? mappedOut : undefined;
    m.chunks.push(i + 1);
    return { index: i + 1, first: p.first, last: p.last, frames: p.frames, machine: m.name, ...(output ? { output } : {}), args: aerenderArgs({ project: m.project, rqIndex: it.index, first: p.first, last: p.last, output: outArg, mfr: mfrFor(procs) }) };
  });
  if (!local) for (const m of machines) if (m.project === o.project && !/^(\\\\|\/\/|\/Volumes\/)/.test(o.project)) notes.push(`${m.name} opens the project at ${o.project}: make sure that path (and the output ${out.path}) exists there, on a share or the same folder, or pass a pathMap`);

  // the estimate
  let estimate: FarmPlan["estimate"];
  if (o.profile) {
    const total = rangeCost(o.profile, { first: fr.first, last: fr.last, frames: fr.count }) / 1000;
    for (const c of chunks) c.estimateSeconds = Math.round(rangeCost(o.profile, c) / 100) / 10;
    const perMachine = machines.map((m) => {
      const cs = chunks.filter((c) => c.machine === m.name);
      return Math.max(0, ...cs.map((c) => c.estimateSeconds ?? 0));
    });
    estimate = {
      source: o.profileSource ?? "profile", profileId: o.profile.id, seconds: Math.round(total), wallSeconds: Math.round(Math.max(...perMachine)),
      note: `${o.profileSource === "sampled" ? `sampled now: ${o.profile.frames.length} frames rendered once each in After Effects` : `from render profile ${o.profile.id} (${o.profile.frames.length} sampled frames, ${o.profile.createdAt})`}; ` +
        "in-app frame renders, without aerender's start-up (often 30 s to a few minutes per process), output encoding or disk writes; processes on one machine share its CPU, GPU and memory, so they rarely scale fully",
    };
  } else estimate = { source: "none", note: "no render profile for this comp: run ae_render_profile {action: \"measure\"} (or plan with estimate: \"sample\") for a time estimate" };

  return {
    surehandFarmPlan: 1,
    createdAt: (o.now ?? new Date()).toISOString(),
    createdBy: `Surehand MCP ${VERSION}`,
    project: { file: o.project, ...fileStamp(o.project) },
    afterEffects: { version: o.aeVersion, major },
    rqIndex: it.index,
    comp: { id: it.comp.id, name: it.comp.name, width: it.comp.w, height: it.comp.h, fps: it.comp.fps, displayStartFrame: dstart },
    frames: { first: fr.first, last: fr.last, frames: fr.count },
    output: out,
    kind,
    ...(sequence ? { sequence } : {}),
    ...(movie ? { movie } : {}),
    expected: expectedSize(it, out, rs.resolution),
    machines,
    chunks,
    estimate,
    folder: o.folder ?? null,
    scripts: [],
    issues,
    notes,
  };
}

export function fileStamp(p: string): { bytes: number | null; modified: string | null } {
  try {
    const st = statSync(p);
    return { bytes: st.size, modified: st.mtime.toISOString() };
  } catch {
    return { bytes: null, modified: null };
  }
}

/** The frame size the output should have: the comp at the render settings' resolution, or the output module's resize. */
function expectedSize(it: ScanItem, out: OutputInfo, resolution: string | null): FarmPlan["expected"] {
  if (out.resize) return { width: out.resize.w, height: out.resize.h, fps: it.comp.fps };
  const f = !resolution || /full|current/i.test(resolution) ? 1 : /half/i.test(resolution) ? 2 : /third/i.test(resolution) ? 3 : /quarter/i.test(resolution) ? 4 : null;
  if (!f) return { width: null, height: null, fps: it.comp.fps };
  return { width: Math.ceil(it.comp.w / f), height: Math.ceil(it.comp.h / f), fps: it.comp.fps };
}

// ---------- scripts ----------

export interface ScriptFile { path: string; text: string; executable: boolean }

const shHead = (title: string) => `#!/bin/bash\n# ${title}\n# Made by Surehand MCP ${VERSION} (ae_farm plan). Runs aerender with the project's own render settings.\ncd "$(dirname "$0")" || exit 1\n`;
const batHead = (title: string) => `@echo off\r\nrem ${title}\r\nrem Made by Surehand MCP ${VERSION} (ae_farm plan). Runs aerender with the project's own render settings.\r\nsetlocal\r\n`;

/** The scripts a plan writes: one per machine (its chunks, in parallel when it runs several), and the join for movies. */
export function planScripts(plan: FarmPlan, folder: string, ffmpeg = "ffmpeg"): ScriptFile[] {
  const files: ScriptFile[] = [];
  const safeName = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "machine";
  for (const m of plan.machines) {
    const cs = plan.chunks.filter((c) => c.machine === m.name);
    if (!cs.length) continue;
    const name = m.local ? "render_chunks" : `render_${safeName(m.name)}`;
    const title = `"${plan.comp.name}" frames ${cs.map((c) => `${c.first}-${c.last}`).join(", ")} on ${m.name}`;
    const guard = (c: Chunk, win: boolean) => {
      if (!c.output) return "";
      const o = c.args[c.args.indexOf("-output") + 1];
      return win ? `if exist ${batQuote(o)} (echo ${batQuote(o)} exists already: not replacing it. & exit /b 1)\r\n` : `if [ -e ${shQuote(o)} ]; then echo ${shQuote(`${o} exists already: not replacing it.`)}; exit 1; fi\n`;
    };
    if (m.platform === "windows") {
      let t = batHead(title);
      for (const c of cs) t += guard(c, true);
      if (cs.length === 1) t += `${commandLine("windows", m.aerender, cs[0].args)}\r\nexit /b %ERRORLEVEL%\r\n`;
      // several processes: each in its own window (cmd /c ends it when aerender finishes)
      else for (const c of cs) t += `start "chunk ${c.index} (frames ${c.first}-${c.last})" cmd /c "${commandLine("windows", m.aerender, c.args)}"\r\n`;
      files.push({ path: join(folder, `${name}.bat`), text: t, executable: false });
    } else {
      let t = shHead(title) + cs.map((c) => guard(c, false)).join("");
      if (cs.length === 1) t += `${commandLine("mac", m.aerender, cs[0].args)}\n`;
      else {
        t += "pids=()\n";
        for (const c of cs) t += `${commandLine("mac", m.aerender, c.args)} > ${shQuote(`chunk_${String(c.index).padStart(2, "0")}.log`)} 2>&1 &\npids+=($!)\n`;
        t += 'status=0\nfor p in "${pids[@]}"; do wait "$p" || status=1; done\nexit $status\n';
      }
      files.push({ path: join(folder, `${name}.command`), text: t, executable: true });
    }
  }
  if (plan.movie && plan.movie.command && plan.chunks.length > 1) {
    files.push({ path: plan.movie.list, text: concatList(plan.movie.parts), executable: false });
    const args = plan.movie.command;
    const caution = plan.movie.join.safe === "unknown" ? "Check first: ae_farm verify probes the parts and says whether they join by stream copy." : "The parts join by stream copy (no re-encoding).";
    const winOnly = plan.machines.every((m) => m.platform === "windows");
    files.push({ path: join(folder, "join_parts.command"), text: `${shHead(`join the ${plan.chunks.length} parts into ${plan.movie.final}`)}# ${caution}\n${commandLine("mac", ffmpeg, args)}\n`, executable: true });
    if (winOnly || plan.machines.some((m) => m.platform === "windows"))
      files.push({ path: join(folder, "join_parts.bat"), text: `${batHead(`join the ${plan.chunks.length} parts into ${plan.movie.final}`)}rem ${caution}\r\n${commandLine("windows", "ffmpeg", args)}\r\n`, executable: false });
  }
  return files;
}

// ---------- the readable plan ----------

export function formatPlan(p: FarmPlan, o: { dryRun?: boolean; written?: string[] } = {}): string {
  const out: string[] = [];
  const who = p.machines.length === 1 && p.machines[0].local ? `${p.chunks.length} process${p.chunks.length === 1 ? "" : "es"} on this machine` : `${p.machines.length} machines`;
  out.push(`${o.dryRun ? "Dry run: " : ""}Render queue item ${p.rqIndex} ("${p.comp.name}", frames ${p.frames.first}-${p.frames.last}, ${p.frames.frames} frames) in ${p.chunks.length} chunk${p.chunks.length === 1 ? "" : "s"} for ${who}.`);
  out.push(`Output: ${p.output.format ?? "?"}${p.output.codec ? ` / ${p.output.codec}` : ""} -> ${p.output.path} (${p.kind}).`);
  if (p.sequence) out.push(`Sequence: every chunk writes into the same sequence, files ${p.sequence.firstFile}-${p.sequence.lastFile} ([${"#".repeat(p.sequence.pad)}], numbered by ${p.sequence.numbering}).`);
  if (p.movie && p.chunks.length > 1) {
    out.push(`Movie: each chunk writes its own file (${basename(p.movie.parts[0])} ...); join: ${p.movie.join.safe === "yes" ? "lossless stream copy" : p.movie.join.safe === "no" ? "NOT LOSSLESS" : "decided after the render"}.`);
    for (const w of p.movie.join.why) out.push(`  - ${w}`);
    if (p.movie.command) out.push(`  join: ffmpeg ${p.movie.command.join(" ")}`);
  }
  if (p.estimate.seconds !== undefined) out.push(`Estimate: about ${fmtDuration(p.estimate.seconds)} of rendering in total; about ${fmtDuration(p.estimate.wallSeconds!)} with the chunks in parallel (${p.estimate.note}).`);
  else out.push(`Estimate: none (${p.estimate.note}).`);
  out.push("", "Chunks:");
  for (const c of p.chunks) {
    const m = p.machines.find((x) => x.name === c.machine)!;
    out.push(`  ${c.index}. frames ${c.first}-${c.last} (${c.frames})${p.machines.length > 1 || !m.local ? ` on ${c.machine}` : ""}${c.estimateSeconds !== undefined ? `, ~${fmtDuration(c.estimateSeconds)}` : ""}${c.output ? ` -> ${basename(c.output)}` : ""}`);
    out.push(`     ${commandLine(m.platform, m.aerender, c.args)}`);
  }
  if (o.written?.length) out.push("", `Written to ${p.folder}:`, ...o.written.map((w) => `  ${basename(w)}`));
  if (p.issues.length) out.push("", "Check before rendering:", ...p.issues.map((i) => `  - ${i}`));
  if (p.notes.length) out.push("", "Notes:", ...p.notes.map((n) => `  - ${n}`));
  out.push("", "aerender renders the project as saved on disk. -s / -e count frames from the comp's start at 0.");
  return out.join("\n") + "\n";
}

export const planFileName = "farm-plan.json";
export const defaultPlanFolder = (project: string, rqIndex: number) => join(dirname(project), `${basename(project).replace(/\.aepx?$/i, "")} farm`, `rq${rqIndex}`);
export const planExists = (folder: string) => existsSync(join(folder, planFileName));
