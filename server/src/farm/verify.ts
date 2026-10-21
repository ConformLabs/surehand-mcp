// Proof that chunked renders add up, wherever they ran: an image sequence has every frame, no extras, no empty or cut
// off files (complete PNG, JPEG end marker, DPX size field...); movie parts have the frames they should (ffprobe), and
// the joined file has the total frame count, size, frame rate and codec of the comp and the output module. Optional:
// sampled frames compared pixel by pixel with a fresh render in After Effects (the prove engine).
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng, completePngSize, type Image } from "../png.js";
import { inputUrl } from "../preflight/media.js";
import { runTool, type FfmpegPaths } from "../preflight/ffmpeg.js";
import { appFile } from "../paths.js";
import { diffImages } from "../tools/prove.js";
import { concatArgs, concatList, joinSafety, type FarmPlan, type JoinSafety } from "./plan.js";
import { frameName, listFrames, parseTemplate, runsOf, runsText, type SeqFile } from "./seq.js";

// ---------- one image file ----------

function headTail(path: string, n = 32): { head: Buffer; tail: Buffer; size: number } | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(n, size)), tail = Buffer.alloc(Math.min(n, size));
    readSync(fd, head, 0, head.length, 0);
    readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
    return { head, tail, size };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export type FileState = "ok" | "empty" | "truncated" | "not this format" | "header only";

/** Whether an image file is complete, as far as its format can tell (an end marker or a size field); else its header. */
export function imageFileState(path: string): { state: FileState; detail?: string } {
  const ext = (/\.([^.]+)$/.exec(path)?.[1] ?? "").toLowerCase();
  const ht = headTail(path);
  if (!ht) return { state: "truncated", detail: "can't be read" };
  if (ht.size === 0) return { state: "empty" };
  const { head, tail, size } = ht;
  switch (ext) {
    case "png":
      if (!head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { state: "not this format" };
      return completePngSize(path) > 0 ? { state: "ok" } : { state: "truncated", detail: "no IEND at the end" };
    case "jpg":
    case "jpeg": {
      if (head[0] !== 0xff || head[1] !== 0xd8) return { state: "not this format" };
      let end = tail.length;
      while (end > 2 && tail[end - 1] === 0) end--;
      return tail[end - 2] === 0xff && tail[end - 1] === 0xd9 ? { state: "ok" } : { state: "truncated", detail: "no JPEG end marker" };
    }
    case "dpx": {
      const magic = head.toString("latin1", 0, 4);
      if (magic !== "SDPX" && magic !== "XPDS") return { state: "not this format" };
      const declared = magic === "SDPX" ? head.readUInt32BE(16) : head.readUInt32LE(16);
      return declared === size ? { state: "ok" } : { state: "truncated", detail: `${size} bytes, the header says ${declared}` };
    }
    case "tif":
    case "tiff": {
      const le = head.toString("latin1", 0, 4) === "II*\u0000", be = head.toString("latin1", 0, 4) === "MM\u0000*";
      if (!le && !be) return { state: "not this format" };
      const ifd = le ? head.readUInt32LE(4) : head.readUInt32BE(4);
      return ifd > 0 && ifd < size ? { state: "header only", detail: "TIFF header and first directory offset ok" } : { state: "truncated", detail: "the first directory is past the end" };
    }
    case "exr":
      return head.readUInt32LE(0) === 20000630 ? { state: "header only" } : { state: "not this format" };
    case "psd":
      return head.toString("latin1", 0, 4) === "8BPS" ? { state: "header only" } : { state: "not this format" };
    case "tga":
      return size >= 18 ? { state: "header only" } : { state: "truncated" };
    default:
      return { state: "header only", detail: "format not checked beyond its size" };
  }
}

// ---------- sequences ----------

export interface SequenceReport {
  template: string;
  expected: [number, number];
  present: number;
  /** file numbers to render again: missing, empty, cut off or damaged */
  rerender: number[];
  missing: number[];
  /** files whose number is outside the range */
  extra: string[];
  /** the same frame number written more than once (e.g. with another number of digits) */
  duplicates: string[][];
  empty: string[];
  truncated: { file: string; detail?: string }[];
  /** much smaller than the median of the others (only reported: sizes vary with the picture) */
  small: string[];
  checked: "complete" | "header";
}

export function verifySequence(template: string, first: number, last: number): SequenceReport {
  const p = parseTemplate(template);
  if (!p) throw new Error(`${template} has no [####] frame number.`);
  const files = listFrames(p);
  const byNum = new Map<number, SeqFile[]>();
  for (const f of files) byNum.set(f.num, [...(byNum.get(f.num) ?? []), f]);
  const missing: number[] = [], extra: string[] = [], duplicates: string[][] = [], empty: string[] = [], truncated: SequenceReport["truncated"] = [];
  const bad = new Set<number>();
  let checked: SequenceReport["checked"] = "complete";
  for (let n = first; n <= last; n++) if (!byNum.has(n)) missing.push(n);
  const inRange: SeqFile[] = [];
  for (const [n, fs] of byNum) {
    if (n < first || n > last) {
      extra.push(...fs.map((f) => f.name));
      continue;
    }
    if (fs.length > 1) duplicates.push(fs.map((f) => f.name));
    for (const f of fs) {
      inRange.push(f);
      if (f.bytes === 0) {
        empty.push(f.name);
        bad.add(n);
        continue;
      }
      const st = imageFileState(join(p.dir, f.name));
      if (st.state === "truncated" || st.state === "empty" || st.state === "not this format") (truncated.push({ file: f.name, detail: st.state === "not this format" ? "not a file of this format" : st.detail }), bad.add(n));
      if (st.state === "header only") checked = "header";
    }
  }
  const sizes = inRange.map((f) => f.bytes).filter((b) => b > 0).sort((a, b) => a - b);
  const med = sizes.length ? sizes[sizes.length >> 1] : 0;
  const small = sizes.length >= 5 ? inRange.filter((f) => f.bytes > 0 && f.bytes < med * 0.25 && !truncated.some((t) => t.file === f.name)).map((f) => f.name) : [];
  return { template, expected: [first, last], present: last - first + 1 - missing.length, rerender: [...new Set([...missing, ...bad])].sort((a, b) => a - b), missing, extra, duplicates, empty, truncated, small, checked };
}

// ---------- movies ----------

export interface Probe { file: string; frames: number | null; duration: number | null; width?: number; height?: number; fps?: number; codec?: string; audioCodec?: string; sampleRate?: number; error?: string }

const rate = (s?: string) => {
  const m = /^(\d+)(?:\/(\d+))?$/.exec(s ?? "");
  return m ? Number(m[1]) / Number(m[2] ?? 1) : undefined;
};

/** ffprobe a movie: its picture's packet count (no decoding), duration, size, rate and codecs. */
export async function probeMovie(ff: FfmpegPaths, file: string, signal?: AbortSignal): Promise<Probe> {
  const chunks: Buffer[] = [];
  const r = await runTool(ff.ffprobe, ["-v", "error", "-count_packets", "-print_format", "json", "-show_format", "-show_streams", "-i", inputUrl(file)], { signal, onStdout: (b) => chunks.push(b), timeoutMs: 600_000 });
  if (r.code !== 0) return { file, frames: null, duration: null, error: r.stderrTail.trim().split("\n").pop() || `ffprobe exit code ${r.code}` };
  try {
    const j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const v = (j.streams ?? []).find((s: any) => s.codec_type === "video" && !s.disposition?.attached_pic);
    const a = (j.streams ?? []).find((s: any) => s.codec_type === "audio");
    const frames = Number(v?.nb_read_packets ?? v?.nb_frames);
    return {
      file, frames: Number.isFinite(frames) ? frames : null, duration: Number(v?.duration ?? j.format?.duration) || null,
      width: v?.width, height: v?.height, fps: rate(v?.r_frame_rate) ?? rate(v?.avg_frame_rate), codec: v?.codec_name, audioCodec: a?.codec_name, sampleRate: a ? Number(a.sample_rate) || undefined : undefined,
    };
  } catch (e: any) {
    return { file, frames: null, duration: null, error: `ffprobe's answer could not be read (${e?.message ?? e})` };
  }
}

export interface MovieReport {
  parts: (Probe & { expected: number; exists: boolean })[];
  joined: (Probe & { exists: boolean; madeNow?: boolean }) | null;
  join: JoinSafety | null;
  problems: string[];
  notes: string[];
}

/** Each part's frames, then the joined file (made now when asked and safe, never over an existing file). */
export async function verifyMovie(plan: FarmPlan, ff: FfmpegPaths, o: { join?: boolean; signal?: AbortSignal } = {}): Promise<MovieReport> {
  const mv = plan.movie!;
  const problems: string[] = [], notes: string[] = [];
  const many = plan.chunks.length > 1;
  const parts: MovieReport["parts"] = [];
  if (many)
    for (const [i, c] of plan.chunks.entries()) {
      const f = mv.parts[i];
      if (!existsSync(f)) {
        parts.push({ file: f, frames: null, duration: null, expected: c.frames, exists: false });
        problems.push(`part ${i + 1} (${f}) is not there`);
        continue;
      }
      const p = await probeMovie(ff, f, o.signal);
      parts.push({ ...p, expected: c.frames, exists: true });
      if (p.error) problems.push(`part ${i + 1} can't be read: ${p.error}`);
      else if (p.frames !== c.frames) problems.push(`part ${i + 1} has ${p.frames ?? "?"} frames, it should have ${c.frames} (frames ${c.first}-${c.last})`);
    }
  // join safety from what was actually written
  let safety: JoinSafety | null = null;
  if (many && parts.every((p) => p.exists && !p.error)) {
    const codecs = new Set(parts.map((p) => `${p.codec}/${p.width}x${p.height}/${p.fps}/${p.audioCodec ?? "-"}`));
    if (codecs.size > 1) problems.push(`the parts differ in codec, size, frame rate or audio (${[...codecs].join(" | ")}): they can't be joined by stream copy`);
    const p0 = parts[0];
    safety = joinSafety({ format: plan.output.format, codec: p0.codec ?? null, audio: p0.audioCodec ? "on" : "off", audioCodec: p0.audioCodec, sampleRate: p0.sampleRate, fps: plan.comp.fps, chunkFrames: plan.chunks.map((c) => c.frames) });
    if (codecs.size > 1) safety = { safe: "no", why: [...safety.why, "the parts don't match each other"] };
  }
  // the joined file
  let joined: MovieReport["joined"] = null;
  const final = mv.final;
  if (existsSync(final)) joined = { ...(await probeMovie(ff, final, o.signal)), exists: true };
  else if (many && o.join) {
    if (!safety) notes.push("the parts were not joined: not every part is there and readable");
    else if (safety.safe !== "yes") notes.push(`the parts were not joined: ${safety.why.join("; ")}`);
    else {
      mkdirSync(appFile("tmp"), { recursive: true });
      const tmp = mkdtempSync(join(appFile("tmp"), "farm-join-"));
      try {
        const list = join(tmp, "parts.txt");
        writeFileSync(list, concatList(mv.parts));
        const r = await runTool(ff.ffmpeg, concatArgs(list, final, !!parts[0].audioCodec), { signal: o.signal, timeoutMs: 3_600_000 });
        if (r.code !== 0) problems.push(`ffmpeg could not join the parts: ${r.stderrTail.trim().split("\n").pop()}`);
        else joined = { ...(await probeMovie(ff, final, o.signal)), exists: true, madeNow: true };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  } else if (!many) problems.push(`${final} is not there`);
  if (joined && !joined.error) {
    const e = plan.expected;
    if (joined.frames !== plan.frames.frames) problems.push(`${final} has ${joined.frames ?? "?"} frames, the render should have ${plan.frames.frames}`);
    if (e.width && e.height && (joined.width !== e.width || joined.height !== e.height)) problems.push(`${final} is ${joined.width}x${joined.height}, the render should be ${e.width}x${e.height}`);
    if (joined.fps && Math.abs(joined.fps - e.fps) > 0.01) problems.push(`${final} runs at ${Math.round(joined.fps * 1000) / 1000} fps, the comp at ${e.fps}`);
    if (many && parts[0]?.codec && joined.codec && joined.codec !== parts[0].codec) problems.push(`${final} is ${joined.codec}, the parts are ${parts[0].codec}`);
  } else if (joined?.error) problems.push(`${final} can't be read: ${joined.error}`);
  else if (many && !o.join) notes.push(`the parts are not joined yet (${final} is not there): run the plan's join_parts script, or verify with join: true`);
  return { parts, joined, join: safety, problems, notes };
}

// ---------- pixel proof ----------

/** "0.02%", "3.4%" */
export const areaPct = (n: number, total: number) => {
  const p = (100 * n) / Math.max(1, total);
  return `${p >= 1 ? Math.round(p * 10) / 10 : p >= 0.01 ? Math.round(p * 100) / 100 : "<0.01"}%`;
};

/**
 * A difference that is a different picture, not local detail: more than 1% of the frame beyond the tolerance, or
 * spread over a quarter of the frame and more than 0.1% of it. Seen live on Windows: aerender and the app anti-alias
 * text edges a little differently (206 px of 921,600, max 209/255) — that is local detail.
 */
export function substantial(p: ProofFrame): boolean {
  if (p.result !== "differs" || !p.over || !p.total) return false;
  const boxArea = p.box ? (p.box[2] * p.box[3]) / p.total : 0;
  return p.over / p.total > 0.01 || (boxArea > 0.25 && p.over / p.total > 0.001);
}

export interface ProofFrame {
  frame: number; result: "identical" | "within tolerance" | "differs" | "not compared"; maxDiff?: number; detail?: string;
  /** pixels beyond the tolerance, of all, and the box around them [x, y, w, h] */
  over?: number; total?: number; box?: [number, number, number, number];
}

/** An image without alpha in its file: the local render (straight alpha) composited over black, as an RGB render is. */
export function overBlack(img: Image): Image {
  const d = img.data, out = img.max === 255 ? new Uint8Array(d.length) : new Uint16Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / img.max;
    out[i] = Math.round(d[i] * a);
    out[i + 1] = Math.round(d[i + 1] * a);
    out[i + 2] = Math.round(d[i + 2] * a);
    out[i + 3] = img.max;
  }
  return { ...img, data: out };
}
const opaque = (img: Image) => {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== img.max) return false;
  return true;
};

/** Compare frames the farm wrote (PNG paths) with frames rendered here (PNG paths), frame by frame. */
export function compareProof(pairs: { frame: number; farm: string | null; local: string | null; why?: string }[], tolerance: number): ProofFrame[] {
  return pairs.map((p) => {
    if (!p.farm || !p.local) return { frame: p.frame, result: "not compared", detail: p.why ?? (!p.farm ? "no frame from the render" : "no local render") };
    try {
      const a = decodePng(readFileSync(p.farm));
      let b = decodePng(readFileSync(p.local));
      if (a.width !== b.width || a.height !== b.height) return { frame: p.frame, result: "not compared", detail: `the render is ${a.width}x${a.height}, the local render ${b.width}x${b.height} (output resized or rendered at another resolution)` };
      if (opaque(a) && !opaque(b)) b = overBlack(b);
      const d = diffImages(a, b, tolerance);
      const where = d.box ? `x ${d.box[0]}-${d.box[0] + d.box[2] - 1}, y ${d.box[1]}-${d.box[1] + d.box[3] - 1}` : "";
      return { frame: p.frame, result: d.over ? "differs" : d.changed ? "within tolerance" : "identical", maxDiff: Math.round(d.maxDiff * 100) / 100, over: d.over, total: d.total, ...(d.box ? { box: d.box } : {}), ...(d.over ? { detail: `${d.over} px beyond the tolerance (${areaPct(d.over, d.total)} of the frame) inside ${where}` } : {}) };
    } catch (e: any) {
      return { frame: p.frame, result: "not compared", detail: String(e?.message ?? e) };
    }
  });
}

/** A frame of the farm's output as a PNG: the sequence's own PNG, or one extracted with ffmpeg (other formats, movies). */
export async function farmFrame(plan: FarmPlan, frame: number, ff: FfmpegPaths | null, dir: string, signal?: AbortSignal): Promise<{ path: string | null; why?: string }> {
  if (plan.sequence) {
    const p = parseTemplate(plan.sequence.template)!;
    const file = join(p.dir, frameName(p, frame + plan.sequence.offset));
    if (!existsSync(file)) return { path: null, why: `${file} is not there` };
    if (/\.png$/i.test(file)) return { path: file };
    if (!ff) return { path: null, why: "ffmpeg is needed to read this format" };
    const out = join(dir, `farm_${frame}.png`);
    const r = await runTool(ff.ffmpeg, ["-v", "error", "-y", "-i", inputUrl(file), "-frames:v", "1", "-pix_fmt", "rgba", out], { signal });
    return r.code === 0 ? { path: out } : { path: null, why: `ffmpeg could not read ${file}` };
  }
  if (!ff) return { path: null, why: "ffmpeg is needed to read a frame from a movie" };
  const mv = plan.movie!;
  const final = existsSync(mv.final) ? mv.final : null;
  let file: string | null = final, k = frame - plan.frames.first;
  if (!final) {
    const c = plan.chunks.find((x) => frame >= x.first && frame <= x.last);
    const i = c ? plan.chunks.indexOf(c) : -1;
    file = i >= 0 && existsSync(mv.parts[i]) ? mv.parts[i] : null;
    k = c ? frame - c.first : 0;
  }
  if (!file) return { path: null, why: "neither the joined file nor the part with this frame is there" };
  const out = join(dir, `farm_${frame}.png`);
  const r = await runTool(ff.ffmpeg, ["-v", "error", "-y", "-i", inputUrl(file), "-vf", `select=eq(n\\,${k})`, "-frames:v", "1", "-pix_fmt", "rgba", out], { signal });
  return r.code === 0 && existsSync(out) ? { path: out } : { path: null, why: `ffmpeg could not extract frame ${k} of ${file}` };
}

// ---------- the report ----------

export function sequenceProblems(s: SequenceReport): string[] {
  const out: string[] = [];
  if (s.missing.length) out.push(`${s.missing.length} frame${s.missing.length === 1 ? "" : "s"} missing: ${runsText(runsOf(s.missing))}`);
  if (s.duplicates.length) out.push(`${s.duplicates.length} frame number${s.duplicates.length === 1 ? "" : "s"} written twice: ${s.duplicates.slice(0, 6).map((d) => d.join(" + ")).join("; ")}`);
  if (s.empty.length) out.push(`${s.empty.length} empty (0-byte) file${s.empty.length === 1 ? "" : "s"}: ${s.empty.slice(0, 8).join(", ")}`);
  if (s.truncated.length) out.push(`${s.truncated.length} cut-off or damaged file${s.truncated.length === 1 ? "" : "s"}: ${s.truncated.slice(0, 8).map((t) => `${t.file}${t.detail ? ` (${t.detail})` : ""}`).join(", ")}`);
  if (s.extra.length) out.push(`${s.extra.length} file${s.extra.length === 1 ? "" : "s"} outside frames ${s.expected[0]}-${s.expected[1]}: ${s.extra.slice(0, 8).join(", ")}${s.extra.length > 8 ? " ..." : ""}`);
  return out;
}

export function readPlanFile(path: string): FarmPlan {
  const p = JSON.parse(readFileSync(path, "utf8"));
  if (p?.surehandFarmPlan !== 1) throw new Error(`${path} is not an ae_farm plan (farm-plan.json).`);
  return p as FarmPlan;
}

// ---------- is there a picture at all ----------

export interface PictureFacts { frame: number; flat: boolean; transparent: boolean; key: string }

/** Whether a frame is one flat colour (or fully transparent), and a key to tell identical frames apart. */
export function pictureFacts(frame: number, png: string): PictureFacts {
  const img = decodePng(readFileSync(png));
  const d = img.data;
  let flat = true, transparent = true, h = 2166136261;
  for (let i = 0; i < d.length; i++) {
    if (flat && d[i] !== d[i % 4]) flat = false;
    if (transparent && i % 4 === 3 && d[i] !== 0) transparent = false;
    h = Math.imul(h ^ d[i], 16777619) >>> 0;
  }
  return { frame, flat, transparent, key: `${img.width}x${img.height}:${h.toString(16)}` };
}

/**
 * Sampled frames that are all the same flat picture (empty, transparent, one colour): what a render of frames outside
 * the comp, or with its layers missing, looks like. null when the samples show a picture.
 */
export function blankRender(facts: PictureFacts[]): string | null {
  if (facts.length < 2 || !facts.every((f) => f.flat) || new Set(facts.map((f) => f.key)).size !== 1) return null;
  return `the sampled frames ${facts.map((f) => `${f.frame}`).join(", ")} are all the same flat picture (${facts[0].transparent ? "fully transparent" : "one colour"}): frames outside the comp (a wrong -s / -e) or missing layers render like this. If the comp really is one flat colour there, ignore this`;
}
