// Preflight checks on a rendered file, with ffprobe (format, codec, size, rate, color tags, audio) and one
// ffmpeg pass for the picture and sound (legal range, black, frozen, loudness, flash pre-check). Every check
// runs only when its section is in the user's spec.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { ensureFfmpeg, type FfmpegBuild, FfmpegMissingError, type FfmpegPaths, runTool } from "./ffmpeg.js";
import { FlashDetector, type FlashRun } from "./flash.js";
import type { Finding, NotRun, Spec } from "./spec.js";

export interface FileCheck {
  findings: Finding[];
  /** what ffprobe reported (codec, size, rate, duration, audio...) in a compact form */
  probe: Record<string, unknown>;
  /** JPEG frames at notable times (absolute paths, in ~/.aemcp/tmp), for the report */
  thumbnails?: { at: number; path: string; label: string }[];
  /** requested checks that did not run (or ran on incomplete data), and why: the verdict can't be PASS */
  notRun?: NotRun[];
  /** remarks on how something was measured */
  notes?: string[];
  /** checks that ran */
  ran?: string[];
  /** which ffmpeg was used, and how long the whole check took */
  tool?: { ffmpeg: string; source: string; seconds: number };
}

export interface CheckFileOptions {
  thumbnails?: boolean;
  signal?: AbortSignal;
  /** download the pinned FFmpeg build into ~/.aemcp/ffmpeg when none is found (ask the user first) */
  allowDownload?: boolean;
  /** asked right before the download starts (the approval in After Effects in "ask" mode); throw to refuse */
  confirmDownload?: (build: FfmpegBuild) => Promise<void>;
  /** use these instead of searching (tests) */
  ffmpeg?: FfmpegPaths;
}

// ---------------------------------------------------------------------------------------------------------
// ffprobe

export interface VideoInfo {
  index: number;
  codec: string;
  profile?: string;
  width: number;
  height: number;
  /** r_frame_rate as a number (30000/1001 -> 29.97003) */
  frameRate: number;
  frameRateText: string;
  /** avg_frame_rate, when it differs (variable frame rate) */
  avgFrameRate?: number;
  pixFmt: string;
  bitDepth: number;
  chroma: "4:2:0" | "4:2:2" | "4:4:4" | "4:1:1" | "4:4:0" | "gray" | "unknown";
  alpha: boolean;
  rgb: boolean;
  fieldOrder: "progressive" | "tff" | "bff" | "unknown";
  pixelAspect: number;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorMatrix?: string;
  colorRange?: "limited" | "full";
  duration?: number;
  frames?: number;
}

export interface AudioInfo {
  index: number;
  codec: string;
  sampleRate: number;
  channels: number;
  layout?: string;
  duration?: number;
}

export interface ProbeInfo {
  /** ffprobe format_name, e.g. "mov,mp4,m4a,3gp,3g2,mj2" */
  formatName: string;
  formatLongName?: string;
  /** file extension, lower case, without the dot */
  extension: string;
  duration?: number;
  sizeBytes?: number;
  bitRate?: number;
  video?: VideoInfo;
  audio: AudioInfo[];
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** 75.5 -> "1:15.50", 2 -> "2.00 s" */
export const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return m ? `${m}:${sec.toFixed(2).padStart(5, "0")}` : `${sec.toFixed(2)} s`;
};

/** "30000/1001" -> 29.97..., "25/1" -> 25; 0 for "0/0" / unreadable */
export function parseRate(s: string | undefined): number {
  if (!s) return 0;
  const [a, b] = s.split("/").map(Number);
  if (!Number.isFinite(a)) return 0;
  if (b === undefined) return a;
  return b ? a / b : 0;
}

type Chroma = VideoInfo["chroma"];
const SPECIAL_FMT: Record<string, [number, Chroma, string]> = {
  // pix_fmt: [bits per component, subsampling, planar format it's analysed in]
  nv12: [8, "4:2:0", "yuv420p"], nv21: [8, "4:2:0", "yuv420p"], nv16: [8, "4:2:2", "yuv422p"], nv24: [8, "4:4:4", "yuv444p"], nv42: [8, "4:4:4", "yuv444p"],
  p010le: [10, "4:2:0", "yuv420p10le"], p010be: [10, "4:2:0", "yuv420p10le"], p012le: [12, "4:2:0", "yuv420p12le"], p016le: [16, "4:2:0", "yuv420p16le"],
  p210le: [10, "4:2:2", "yuv422p10le"], p216le: [16, "4:2:2", "yuv422p16le"], p410le: [10, "4:4:4", "yuv444p10le"], p416le: [16, "4:4:4", "yuv444p16le"],
  yuyv422: [8, "4:2:2", "yuv422p"], uyvy422: [8, "4:2:2", "yuv422p"], yvyu422: [8, "4:2:2", "yuv422p"], y210le: [10, "4:2:2", "yuv422p10le"], y212le: [12, "4:2:2", "yuv422p12le"],
  v210: [10, "4:2:2", "yuv422p10le"], uyyvyy411: [8, "4:1:1", "yuv411p"], vuya: [8, "4:4:4", "yuv444p"], vuyx: [8, "4:4:4", "yuv444p"], ayuv64le: [16, "4:4:4", "yuv444p16le"],
  xv30le: [10, "4:4:4", "yuv444p10le"], xv36le: [12, "4:4:4", "yuv444p12le"], v30xle: [10, "4:4:4", "yuv444p10le"],
};

/** Bit depth, chroma subsampling, alpha and RGB-ness from an ffmpeg pix_fmt name. */
export function pixFmtInfo(pixFmt: string): { bitDepth: number; chroma: Chroma; alpha: boolean; rgb: boolean } {
  const f = pixFmt.toLowerCase();
  const alpha = /^(yuva|gbrap|rgba|bgra|argb|abgr|ya8|ya16|ayuv|vuya)/.test(f);
  if (SPECIAL_FMT[f]) return { bitDepth: SPECIAL_FMT[f][0], chroma: SPECIAL_FMT[f][1], alpha, rgb: false };
  const yuv = /^yuva?j?(\d{3})p(\d+)?(le|be)?$/.exec(f);
  if (yuv) {
    const c = ({ "420": "4:2:0", "422": "4:2:2", "444": "4:4:4", "411": "4:1:1", "440": "4:4:0", "410": "4:2:0" } as Record<string, Chroma>)[yuv[1]] ?? "unknown";
    return { bitDepth: yuv[2] ? Number(yuv[2]) : 8, chroma: c, alpha, rgb: false };
  }
  if (/^(gray|ya)/.test(f)) return { bitDepth: Number(/(\d+)(le|be)?$/.exec(f.replace(/^ya8$/, "gray"))?.[1] ?? 8), chroma: "gray", alpha, rgb: false };
  if (/^gbra?p(\d+)?/.test(f)) return { bitDepth: Number(/^gbra?p(\d+)/.exec(f)?.[1] ?? 8), chroma: "4:4:4", alpha, rgb: true };
  if (/^(rgb|bgr|argb|abgr|0rgb|0bgr|x2rgb|x2bgr)/.test(f)) {
    let bitDepth = 8;
    if (/^(rgb|bgr)a?(48|64)/.test(f)) bitDepth = 16;
    else if (/^x2(rgb|bgr)10/.test(f)) bitDepth = 10;
    else if (/^(rgb|bgr)a?f(16|32)/.test(f)) bitDepth = Number(/f(16|32)/.exec(f)![1]);
    return { bitDepth, chroma: "4:4:4", alpha, rgb: true };
  }
  return { bitDepth: 8, chroma: "unknown", alpha, rgb: false };
}

/** pix_fmt the picture is analysed in: the file's own depth and subsampling as planar YUV, no alpha. null = not YUV. */
export function analysisPixFmt(pixFmt: string): string | null {
  const f = pixFmt.toLowerCase();
  if (SPECIAL_FMT[f]) return SPECIAL_FMT[f][2];
  const m = /^yuva?(j?)(\d{3})p(\d+)?(le|be)?$/.exec(f);
  if (m) return `yuv${m[1]}${m[2]}p${m[3] ? `${m[3]}le` : ""}`;
  return null;
}

const FIELD: Record<string, VideoInfo["fieldOrder"]> = { progressive: "progressive", tt: "tff", bt: "tff", bb: "bff", tb: "bff" };

/** The compact picture of a file from `ffprobe -print_format json -show_format -show_streams`. */
export function parseProbe(json: string | any, path: string): ProbeInfo {
  const j = typeof json === "string" ? JSON.parse(json) : json;
  const streams: any[] = Array.isArray(j?.streams) ? j.streams : [];
  const fmt = j?.format ?? {};
  const v = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  let video: VideoInfo | undefined;
  if (v) {
    const pf = pixFmtInfo(String(v.pix_fmt ?? ""));
    const raw = num(v.bits_per_raw_sample);
    const sar = parseRate(String(v.sample_aspect_ratio ?? "").replace(":", "/"));
    const r = parseRate(v.r_frame_rate), avg = parseRate(v.avg_frame_rate);
    const known = (x: unknown) => (typeof x === "string" && x && x !== "unknown" && x !== "unspecified" ? x : undefined);
    video = {
      index: v.index,
      codec: String(v.codec_name ?? "unknown"),
      profile: v.profile,
      width: v.width,
      height: v.height,
      frameRate: r || avg,
      frameRateText: r ? v.r_frame_rate : v.avg_frame_rate,
      avgFrameRate: avg && r && Math.abs(avg - r) > 0.01 ? avg : undefined,
      pixFmt: String(v.pix_fmt ?? "unknown"),
      // bits_per_raw_sample is the coded depth (e.g. ProRes 10 in a 12-bit pix_fmt is rare; trust it for YUV)
      bitDepth: raw && raw >= 8 && raw <= 16 && !pf.rgb ? raw : pf.bitDepth,
      chroma: pf.chroma,
      alpha: pf.alpha,
      rgb: pf.rgb,
      fieldOrder: FIELD[v.field_order] ?? "unknown",
      pixelAspect: sar > 0 ? sar : 1,
      colorPrimaries: known(v.color_primaries),
      colorTransfer: known(v.color_transfer),
      colorMatrix: known(v.color_space),
      colorRange: v.color_range === "tv" ? "limited" : v.color_range === "pc" ? "full" : undefined,
      duration: num(v.duration),
      frames: num(v.nb_frames),
    };
  }
  const audio: AudioInfo[] = streams
    .filter((s) => s.codec_type === "audio")
    .map((s) => {
      const a: AudioInfo = { index: s.index, codec: String(s.codec_name ?? "unknown"), sampleRate: num(s.sample_rate) ?? 0, channels: num(s.channels) ?? 0, layout: s.channel_layout };
      const d = num(s.duration);
      if (d !== undefined) a.duration = d;
      return a;
    });
  return {
    formatName: String(fmt.format_name ?? "unknown"),
    formatLongName: fmt.format_long_name,
    extension: extname(path).slice(1).toLowerCase(),
    duration: num(fmt.duration) ?? video?.duration,
    sizeBytes: num(fmt.size),
    bitRate: num(fmt.bit_rate),
    video,
    audio,
  };
}

/**
 * The picture's duration: the video stream's own duration, else its frame count / frame rate, else the file's
 * (the container's duration is the longest stream: audio that runs past the picture would make it too long).
 */
export function videoDuration(p: ProbeInfo): number | undefined {
  const v = p.video;
  if (!v) return p.duration;
  if (v.duration !== undefined && v.duration > 0) return v.duration;
  if (v.frames && v.frameRate) return v.frames / v.frameRate;
  return p.duration;
}

/** What the spec's audio section asks to measure (for the "no audio stream" message). */
function audioAsks(sa: NonNullable<Spec["audio"]>): string[] {
  const asks: string[] = [];
  if (sa.sampleRate !== undefined) asks.push(`${sa.sampleRate} Hz`);
  if (sa.channels !== undefined) asks.push(`${sa.channels} channel${sa.channels === 1 ? "" : "s"}`);
  if (sa.integratedLUFS !== undefined) asks.push(`${sa.integratedLUFS} LUFS integrated`);
  if (sa.maxTruePeakDBTP !== undefined) asks.push(`true peak at most ${sa.maxTruePeakDBTP} dBTP`);
  if (sa.maxShortTermLUFS !== undefined) asks.push(`short-term loudness at most ${sa.maxShortTermLUFS} LUFS`);
  if (sa.loudnessRangeLU) asks.push("a loudness range");
  return asks;
}

/** Loudness is asked for (needs the ffmpeg pass over the audio). */
export const wantsLoudness = (sa: Spec["audio"]) => !!sa && (sa.integratedLUFS !== undefined || sa.maxTruePeakDBTP !== undefined || sa.maxShortTermLUFS !== undefined || !!sa.loudnessRangeLU);

export function compactProbe(p: ProbeInfo): Record<string, unknown> {
  const v = p.video;
  return {
    container: p.extension || p.formatName,
    format: p.formatName,
    duration: p.duration !== undefined ? round(p.duration, 3) : undefined,
    sizeBytes: p.sizeBytes,
    bitRate: p.bitRate,
    video: v && {
      codec: v.codec + (v.profile ? ` (${v.profile})` : ""),
      size: `${v.width}x${v.height}`,
      pixelAspect: round(v.pixelAspect, 4),
      frameRate: round(v.frameRate, 3),
      frameRateExact: v.frameRateText,
      ...(v.avgFrameRate ? { averageFrameRate: round(v.avgFrameRate, 3) } : {}),
      pixFmt: v.pixFmt,
      bitDepth: v.bitDepth,
      chroma: v.chroma,
      alpha: v.alpha,
      fieldOrder: v.fieldOrder,
      color: { primaries: v.colorPrimaries ?? "not signalled", transfer: v.colorTransfer ?? "not signalled", matrix: v.colorMatrix ?? "not signalled", range: v.colorRange ?? "not signalled" },
      frames: v.frames,
    },
    audio: p.audio.map((a) => ({ codec: a.codec, sampleRate: a.sampleRate, channels: a.channels, layout: a.layout, ...(a.duration !== undefined ? { duration: round(a.duration, 3) } : {}) })),
  };
}

/** Compares the probed file with spec.video / spec.audio. */
export function compareProbe(p: ProbeInfo, spec: Spec): Finding[] {
  const out: Finding[] = [];
  const fail = (check: string, message: string, fix?: string) => out.push({ check, severity: "fail", message, ...(fix ? { fix } : {}) });
  const warn = (check: string, message: string, fix?: string) => out.push({ check, severity: "warn", message, ...(fix ? { fix } : {}) });
  const sv = spec.video;
  const v = p.video;
  if (sv) {
    if (sv.container) {
      const list = sv.container.map((c) => c.toLowerCase().replace(/^\./, ""));
      const tokens = p.formatName.split(",");
      if (!list.includes(p.extension) && !(tokens.length === 1 && list.includes(tokens[0])))
        fail("file.container", `Container is ${p.extension ? `.${p.extension}` : "unknown"} (${p.formatName}); the spec allows ${list.join(", ")}.`, "Render with an output module that writes the required container.");
    }
    if (!v) {
      fail("file.video", "The file has no video stream.");
    } else {
      if (sv.codec) {
        const list = sv.codec.map((c) => c.toLowerCase());
        if (!list.includes(v.codec.toLowerCase()))
          fail("file.codec", `Video codec is ${v.codec}${v.profile ? ` (${v.profile})` : ""}; the spec allows ${sv.codec.join(", ")}.`, "Change the output module's format / codec.");
      }
      if ((sv.width !== undefined && v.width !== sv.width) || (sv.height !== undefined && v.height !== sv.height))
        fail("file.size", `Frame size is ${v.width}x${v.height}; the spec wants ${sv.width ?? v.width}x${sv.height ?? v.height}.`, "Check the comp size and the output module's Resize / Crop.");
      if (sv.pixelAspect !== undefined && Math.abs(v.pixelAspect - sv.pixelAspect) > 0.001) fail("file.pixelAspect", `Pixel aspect ratio is ${round(v.pixelAspect, 4)}; the spec wants ${sv.pixelAspect}.`);
      if (sv.frameRate !== undefined) {
        if (!v.frameRate) warn("file.frameRate", "The file's frame rate could not be read.");
        else if (Math.abs(v.frameRate - sv.frameRate) > 0.005)
          fail("file.frameRate", `Frame rate is ${round(v.frameRate, 3)} fps (${v.frameRateText}); the spec wants ${sv.frameRate}.`, "Check the comp frame rate and the render settings' Frame Rate.");
        if (v.avgFrameRate) warn("file.frameRate", `The average frame rate (${round(v.avgFrameRate, 3)}) differs from the nominal ${round(v.frameRate, 3)}: the file may have a variable frame rate.`);
      }
      if (sv.bitDepth !== undefined) {
        const allowed = Array.isArray(sv.bitDepth) ? sv.bitDepth : [sv.bitDepth];
        if (!allowed.includes(v.bitDepth)) fail("file.bitDepth", `Bit depth is ${v.bitDepth}-bit (${v.pixFmt}); the spec wants ${allowed.join(" or ")}-bit.`, "Change the codec / its depth setting in the output module.");
      }
      if (sv.chromaSubsampling && !(sv.chromaSubsampling as string[]).includes(v.chroma))
        fail("file.chroma", `Chroma subsampling is ${v.chroma} (${v.pixFmt}); the spec wants ${sv.chromaSubsampling.join(" or ")}.`);
      if (sv.alpha !== undefined && v.alpha !== sv.alpha)
        fail(
          "file.alpha",
          v.alpha ? `The file has an alpha channel (${v.pixFmt}); the spec wants none.` : `The file has no alpha channel (${v.pixFmt}); the spec wants one.`,
          v.alpha ? "Set the output module's Channels to RGB." : "Set the output module's Channels to RGB + Alpha (with a codec that keeps alpha).",
        );
      if (sv.fieldOrder) {
        if (v.fieldOrder === "unknown") warn("file.fieldOrder", `The file doesn't signal its field order; the spec wants ${sv.fieldOrder}.`);
        else if (v.fieldOrder !== sv.fieldOrder) fail("file.fieldOrder", `Field order is ${v.fieldOrder}; the spec wants ${sv.fieldOrder}.`, "Check Field Render in the render settings.");
      }
      const color: [string | undefined, string | undefined, string][] = [
        [v.colorPrimaries, sv.colorPrimaries, "color primaries"],
        [v.colorTransfer, sv.colorTransfer, "transfer characteristics"],
        [v.colorMatrix, sv.colorMatrix, "matrix coefficients"],
        [v.colorRange, sv.colorRange, "range"],
      ];
      for (const [got, want, label] of color) {
        if (want === undefined) continue;
        if (got === undefined) warn("file.color", `The file doesn't signal its ${label}; the spec wants ${want}.`, "Players will guess; set the output color space / tagging in the output module.");
        else if (got.toLowerCase() !== want.toLowerCase()) fail("file.color", `Signalled ${label}: ${got}; the spec wants ${want}.`, "Check the output module's color settings (output color space / tagging).");
      }
    }
    if (sv.duration !== undefined) {
      const d = videoDuration(p);
      const fps = v?.frameRate || 25;
      if (d === undefined) warn("file.duration", "The file's duration could not be read.");
      else if (typeof sv.duration === "number") {
        const tol = ((sv.durationToleranceFrames ?? 0) + 0.5) / fps;
        if (Math.abs(d - sv.duration) > tol)
          fail("file.duration", `Duration is ${round(d, 3)} s (${Math.round(d * fps)} frames); the spec wants ${sv.duration} s (${Math.round(sv.duration * fps)} frames).`, "Check the work area / comp duration you rendered.");
      } else {
        const half = 0.5 / fps;
        if (sv.duration.min !== undefined && d < sv.duration.min - half) fail("file.duration", `Duration is ${round(d, 3)} s; the spec wants at least ${sv.duration.min} s.`);
        if (sv.duration.max !== undefined && d > sv.duration.max + half) fail("file.duration", `Duration is ${round(d, 3)} s; the spec wants at most ${sv.duration.max} s.`);
      }
    }
  }
  const sa = spec.audio;
  if (sa) {
    const asks = audioAsks(sa);
    const n = p.audio.length;
    if (!n && (sa.required === true || (sa.required !== false && asks.length)))
      // the common slip: Audio Output was off in the output module
      fail("file.audio", `The file has no audio stream; the spec ${asks.length ? `asks for ${asks.join(", ")}` : "requires audio"}.`, "Turn on Audio Output in the output module and render again.");
    if (sa.required === false && n) fail("file.audio", `The file has audio (${n} stream${n > 1 ? "s" : ""}); the spec wants none.`, "Turn off Audio Output in the output module.");
    // every audio stream is compared (a file with several, e.g. stems, must have each one right)
    for (const [k, a] of p.audio.entries()) {
      const which = n > 1 ? `Audio stream ${k + 1} of ${n} (#${a.index})` : "Audio";
      if (sa.sampleRate !== undefined && a.sampleRate !== sa.sampleRate) fail("file.audio", `${which} sample rate is ${a.sampleRate} Hz; the spec wants ${sa.sampleRate} Hz.`, "Set the output module's audio sample rate.");
      if (sa.channels !== undefined && a.channels !== sa.channels)
        fail("file.audio", `${which} has ${a.channels} channel${a.channels === 1 ? "" : "s"}${a.layout ? ` (${a.layout})` : ""}; the spec wants ${sa.channels}.`, "Set the output module's audio channels.");
    }
  }
  // picture and sound of different lengths (more than a frame): usually a work-area / audio mismatch
  if ((sv || sa) && v && p.audio.length) {
    const vd = videoDuration(p), ad = p.audio[0].duration, fps = v.frameRate || 25;
    if (vd !== undefined && ad !== undefined && Math.abs(ad - vd) > 1 / fps + 1e-6)
      warn(
        "file.duration",
        `The audio (${round(ad, 3)} s) is ${ad > vd ? "longer" : "shorter"} than the picture (${round(vd, 3)} s) by ${round(Math.abs(ad - vd), 3)} s (${Math.round(Math.abs(ad - vd) * fps)} frames).`,
        "Check the audio layers' in / out points against the comp and the rendered range.",
      );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// the analysis pass

export interface Range8 {
  min: number;
  max: number;
}

export interface LegalPlan {
  /** planar YUV format the picture is analysed in */
  pixFmt: string;
  bitDepth: number;
  luma?: Range8;
  chroma?: Range8;
  /** the 16-bit grid values of "in range" / "out of range" (measured by calibrateLegal; default 16 / 200 << 8) */
  lo?: number;
  hi?: number;
}

/** the grid the marked picture is averaged down to (area average) before it is measured */
export const LEGAL_GRID = { width: 64, height: 36 };

export interface AnalysisPlan {
  legal?: LegalPlan;
  black?: { minRun: number; threshold: number };
  frozen?: { minRun: number; noise: number };
  loudness: boolean;
  /** the flash grid, and the frame rate it is resampled to (constant, so frame n is at n / rate) */
  flash?: { width: number; height: number; rate?: string };
}

export const FLASH_GRID = { width: 32, height: 18 };

/**
 * lutyuv expression marking out-of-range code values: 200 (scaled to the depth) outside [min, max] in 8-bit
 * terms, 16 inside (lutyuv clips its output to the video range; both stay inside it). The marked picture is
 * area-averaged to a small grid in 16 bits and measured there, so a plane's average is
 * lo + (hi - lo) * (out-of-range fraction): exact, and much faster than measuring every full-size frame.
 */
function lutExpr(r: Range8 | undefined, scale: number): string {
  if (!r) return `${16 * scale}`;
  return `'if(between(val/${scale},${r.min},${r.max}),${16 * scale},${200 * scale})'`;
}

function legalMarkChain(L: LegalPlan): string {
  const s = 2 ** (L.bitDepth - 8);
  return `lutyuv=y=${lutExpr(L.luma, s)}:u=${lutExpr(L.chroma, s)}:v=${lutExpr(L.chroma, s)},scale=${LEGAL_GRID.width}:${LEGAL_GRID.height}:flags=area,format=yuv444p16le`;
}

/**
 * The input path for ffmpeg / ffprobe: the file protocol and an absolute path, so a name that starts with "-"
 * or contains "proto:" is read as a file name.
 */
export const inputUrl = (file: string) => `file:${resolve(file)}`;

/** Counts every decoded frame (the coverage check), even when no other filter prints per frame. */
const COUNT_TAP = "metadata@cnt=mode=add:key=aemcp.f:value=1,metadata@count=mode=print:key=aemcp.f";

/** ffmpeg arguments for one pass over the file (null when nothing needs decoding). */
export function buildArgs(file: string, plan: AnalysisPlan, audioIndex: number | null): string[] | null {
  const graph: string[] = [];
  const nullMaps: string[] = [];
  const pipeMaps: string[] = [];
  if (plan.legal || plan.black || plan.frozen || plan.flash) {
    const chain: string[] = [];
    if (plan.legal) {
      chain.push(`format=${plan.legal.pixFmt}`);
    }
    if (plan.black) chain.push(`blackdetect@black=d=${plan.black.minRun}:pix_th=${plan.black.threshold}`);
    if (plan.frozen) chain.push(`freezedetect@frozen=n=${plan.frozen.noise}:d=${plan.frozen.minRun}`);
    chain.push(COUNT_TAP);
    const branches = [plan.legal && "legal", plan.flash && "flash"].filter(Boolean) as string[];
    if (!branches.length) branches.push("main");
    const head = `[0:v:0]${chain.length ? chain.join(",") : "null"}`;
    graph.push(branches.length === 1 ? `${head}[b_${branches[0]}]` : `${head},split=${branches.length}${branches.map((b) => `[b_${b}]`).join("")}`);
    if (plan.legal) {
      const L = plan.legal;
      graph.push(
        `[b_legal]${legalMarkChain(L)},signalstats@out,` +
          ["YAVG", "UAVG", "VAVG"].map((k) => `metadata@o${k.toLowerCase()}=print:key=lavfi.signalstats.${k}`).join(",") +
          "[o_legal]",
      );
      nullMaps.push("[o_legal]");
    }
    if (plan.flash) {
      // a constant frame rate (fps filter): on a variable-frame-rate file the flash timing is still right
      graph.push(`[b_flash]${plan.flash.rate ? `fps=${plan.flash.rate},` : ""}scale=${plan.flash.width}:${plan.flash.height}:flags=area,format=rgb24[o_flash]`);
      pipeMaps.push("[o_flash]");
    }
    if (branches[0] === "main") nullMaps.push("[b_main]");
  }
  if (plan.loudness && audioIndex !== null) {
    graph.push(`[0:a:${audioIndex}]ebur128@loud=peak=true:framelog=info[o_audio]`);
    nullMaps.push("[o_audio]");
  }
  if (!graph.length) return null;
  const args = ["-hide_banner", "-nostats", "-nostdin", "-loglevel", "repeat+info", "-i", inputUrl(file), "-filter_complex", graph.join(";")];
  if (nullMaps.length) {
    for (const m of nullMaps) args.push("-map", m);
    args.push("-f", "null", "-");
  }
  if (pipeMaps.length) {
    for (const m of pipeMaps) args.push("-map", m);
    // constant frame rate (the fps filter above): frame n is at n / rate
    args.push("-f", "rawvideo", "pipe:1");
  }
  return args;
}

export interface TimeRun {
  start: number;
  end: number;
}

export interface Analysis {
  /** per frame: time and the averages of the marked Y, U, V planes (see lutExpr) */
  frames: { t: number[]; oy: number[]; ou: number[]; ov: number[] };
  black: TimeRun[];
  frozen: { start: number; end?: number }[];
  /** shortTermLines: ebur128 per-100-ms lines seen (0: none could be read) */
  loudness: { integrated?: number; lra?: number; truePeak?: number; maxShortTerm?: number; maxShortTermAt?: number; shortTermLines?: number };
  /** every decoded video frame (the count tap): how many, and the first / last frame time */
  decoded: { frames: number; firstT?: number; lastT?: number };
  /** ffmpeg's messages about a damaged or incomplete file: how many, and the first */
  damage: { count: number; first?: string };
}

/** ffmpeg messages that mean the file is damaged or incomplete */
const DAMAGE = /partial file|invalid data|decoding error|corrupt|truncat|error while decoding|concealing \d+ (DC|AC|MV) errors/i;

const PREFIX = /^\[([A-Za-z0-9_]+)@([A-Za-z0-9_]+) @ [^\]]+\] ?(.*)$/;
const FRAME_KEYS: Record<string, keyof Analysis["frames"]> = { oyavg: "oy", ouavg: "ou", ovavg: "ov" };

/** Collects the per-frame metadata and the detector / loudness lines from ffmpeg's stderr, line by line. */
export class LogCollector {
  a: Analysis = { frames: { t: [], oy: [], ou: [], ov: [] }, black: [], frozen: [], loudness: {}, decoded: { frames: 0 }, damage: { count: 0 } };
  private frameOf: Record<string, number> = {};
  private summary = false;
  private section = "";
  /** the input's path: a line naming it (e.g. "Input #0 ... from 'corrupt.mov'") is not a damage message */
  constructor(private inputPath?: string) {}

  line(l: string) {
    const m = PREFIX.exec(l);
    if (DAMAGE.test(l) && !(m && m[1] === "metadata") && !/^Input #/.test(l) && !(this.inputPath && l.includes(this.inputPath))) {
      this.a.damage.count++;
      this.a.damage.first ??= l.trim().slice(0, 200);
    }
    if (!m) {
      if (this.summary) this.summaryLine(l);
      return;
    }
    const [, , name, rest] = m;
    if (name === "loud") return this.loudLine(rest);
    if (name === "black") {
      const b = /black_start:\s*([-\d.e+]+)\s+black_end:\s*([-\d.e+]+)/.exec(rest);
      if (b) this.a.black.push({ start: Number(b[1]), end: Number(b[2]) });
      return;
    }
    if (name === "frozen") {
      const f = /lavfi\.freezedetect\.freeze_(start|end):\s*([-\d.e+]+)/.exec(rest);
      if (f?.[1] === "start") this.a.frozen.push({ start: Number(f[2]) });
      else if (f?.[1] === "end") {
        const last = this.a.frozen[this.a.frozen.length - 1];
        if (last && last.end === undefined) last.end = Number(f[2]);
      }
      return;
    }
    const fr = /^frame:\s*(\d+)\s+pts:\s*\S+\s+pts_time:\s*([-\d.e+]+)/.exec(rest);
    if (fr && name === "count") {
      const d = this.a.decoded, t = Number(fr[2]);
      d.frames++;
      if (d.firstT === undefined) d.firstT = t;
      d.lastT = t;
      return;
    }
    if (fr) {
      const i = Number(fr[1]);
      this.frameOf[name] = i;
      if (this.a.frames.t[i] === undefined) this.a.frames.t[i] = Number(fr[2]);
      return;
    }
    const kv = /^lavfi\.signalstats\.\w+=([-\d.e+]+)/.exec(rest);
    if (kv) {
      const i = this.frameOf[name];
      const key = FRAME_KEYS[name];
      if (i !== undefined && key) this.a.frames[key][i] = Number(kv[1]);
    }
  }

  private loudLine(rest: string) {
    if (/^Summary:/.test(rest)) {
      this.summary = true;
      return;
    }
    const t = /^t:\s*([-\d.]+)/.exec(rest);
    const s = /\bS:\s*([-\d.]+)/.exec(rest);
    if (t && s) {
      this.a.loudness.shortTermLines = (this.a.loudness.shortTermLines ?? 0) + 1;
      const v = Number(s[1]);
      // -120.7 / -70 and below: no signal (yet)
      if (v > -70 && (this.a.loudness.maxShortTerm === undefined || v > this.a.loudness.maxShortTerm)) {
        this.a.loudness.maxShortTerm = v;
        this.a.loudness.maxShortTermAt = Math.max(0, Number(t[1]) - 3);
      }
    }
  }

  private summaryLine(l: string) {
    const s = l.trim();
    if (/^Integrated loudness:/.test(s)) this.section = "I";
    else if (/^Loudness range:/.test(s)) this.section = "LRA";
    else if (/^True peak:/.test(s)) this.section = "TP";
    else if (/^Sample peak:/.test(s)) this.section = "SP";
    const val = (re: RegExp) => {
      const v = re.exec(s)?.[1];
      return v === undefined ? undefined : /inf/.test(v) ? (v.startsWith("-") ? -Infinity : Infinity) : Number(v);
    };
    if (this.section === "I" && /^I:/.test(s)) this.a.loudness.integrated = val(/^I:\s*(-?inf|[-\d.]+)/);
    if (this.section === "LRA" && /^LRA:/.test(s)) this.a.loudness.lra = val(/^LRA:\s*([-\d.]+)/);
    if (this.section === "TP" && /^Peak:/.test(s)) this.a.loudness.truePeak = val(/^Peak:\s*(-?inf|[-\d.]+)/);
  }
}

/** Parses a block of ffmpeg stderr (tests / one-shot use). */
export function parseLog(text: string): Analysis {
  const c = new LogCollector();
  for (const l of text.split(/\r?\n/)) c.line(l);
  return c.a;
}

// ---------------------------------------------------------------------------------------------------------
// evaluation

/** A finding with the best time for a thumbnail (prio: lower = more important); `thumb` is removed before returning. */
export interface Marked extends Finding {
  thumb?: { at: number; prio: number; label: string };
}

const MAX_RANGES = 8;

/** Groups sorted frame indices into runs (a gap of up to `gap` frames joins them). */
function frameRuns(bad: number[], gap = 1): [number, number][] {
  const out: [number, number][] = [];
  for (const i of bad) {
    const last = out[out.length - 1];
    if (last && i - last[1] <= gap + 1) last[1] = i;
    else out.push([i, i]);
  }
  return out;
}

export interface LegalSection {
  first: number;
  last: number;
  /** frame with the largest out-of-range share, and the shares there (percent) */
  worst: number;
  /** frames in the section that are out of range (sections join runs less than a second apart) */
  badFrames?: number;
  lumaPct: number;
  chromaPct: number;
}

/** Code-value extremes of one frame, in 8-bit terms. */
export interface Extremes {
  ymin: number;
  ymax: number;
  cmin: number;
  cmax: number;
}

/** Frames whose out-of-range share is above `maxPct`, grouped into sections (from the marked plane averages). */
export function legalSections(a: Analysis, plan: LegalPlan, maxPct: number, gap = 1): { sections: LegalSection[]; frames: number; worst: { i: number; pct: number } } {
  const f = a.frames;
  const lo = plan.lo ?? 16 * 256, hi = plan.hi ?? 200 * 256;
  const frac = (avg: number | undefined) => (avg === undefined ? 0 : Math.min(1, Math.max(0, (avg - lo) / (hi - lo))));
  const pctY = (i: number) => (plan.luma ? frac(f.oy[i]) * 100 : 0);
  const pctC = (i: number) => (plan.chroma ? Math.max(frac(f.ou[i]), frac(f.ov[i])) * 100 : 0);
  const n = Math.max(f.oy.length, f.ou.length, f.ov.length);
  const bad: number[] = [];
  let worst = { i: -1, pct: 0 };
  for (let i = 0; i < n; i++) {
    const pct = Math.max(pctY(i), pctC(i));
    if (pct > maxPct + 1e-9) {
      bad.push(i);
      if (pct > worst.pct) worst = { i, pct };
    }
  }
  const sections = frameRuns(bad, gap).map(([first, last]) => {
    let w = first;
    for (let i = first; i <= last; i++) if (Math.max(pctY(i), pctC(i)) > Math.max(pctY(w), pctC(w))) w = i;
    const badFrames = bad.filter((i) => i >= first && i <= last).length;
    return { first, last, worst: w, lumaPct: pctY(w), chromaPct: pctC(w), badFrames };
  });
  return { sections, frames: bad.length, worst };
}

/** 0.5 -> "0.5%", 0.000123 -> "0.00012%" */
const pctText = (p: number) => `${p >= 1 ? round(p, 1) : p >= 0.01 ? round(p, 2) : Number(p.toPrecision(2))}%`;

/** Findings for the out-of-range sections; `extremes` (by worst frame) adds the code values found there. */
export function evaluateLegal(a: Analysis, plan: LegalPlan, maxPct: number, fps: number, extremes: Map<number, Extremes> = new Map()): Marked[] {
  // runs less than a second apart make one section: one finding per problem area, not one per flicker
  const { sections, frames, worst } = legalSections(a, plan, maxPct, Math.max(1, Math.round(fps)));
  if (!sections.length) return [];
  const time = (i: number) => a.frames.t[i] ?? i / fps;
  const depth = plan.bitDepth === 8 ? "8-bit code values" : `${plan.bitDepth}-bit code values, scaled to 8-bit`;
  const out: Marked[] = [];
  for (const sec of sections.slice(0, MAX_RANGES)) {
    const x = extremes.get(sec.worst);
    const parts: string[] = [];
    if (plan.luma && sec.lumaPct > maxPct)
      parts.push(`${pctText(sec.lumaPct)} of pixels have luma outside ${plan.luma.min}-${plan.luma.max}${x ? ` (luma ${round(x.ymin, 1)}-${round(x.ymax, 1)} in that frame)` : ""}`);
    if (plan.chroma && sec.chromaPct > maxPct)
      parts.push(`${pctText(sec.chromaPct)} have chroma outside ${plan.chroma.min}-${plan.chroma.max}${x ? ` (chroma ${round(x.cmin, 1)}-${round(x.cmax, 1)})` : ""}`);
    const t0 = time(sec.first), t1 = time(sec.last) + 1 / fps;
    const n = sec.last - sec.first + 1, nb = sec.badFrames ?? n;
    out.push({
      check: "legalRange",
      severity: "fail",
      message: `Out of legal range ${fmtTime(t0)}-${fmtTime(t1)} (${nb === n ? `${n} frame${n > 1 ? "s" : ""}` : `${nb} of ${n} frames`}); worst at ${fmtTime(time(sec.worst))}: ${parts.join("; ")}. Measured on the file's ${depth}${maxPct ? `; ${maxPct}% allowed per frame` : ""}.`,
      at: [round(t0, 3), round(t1, 3)],
      fix: "Find the bright / saturated element at that time and bring it into range (correct its color, or limit the output with a legalizer such as Broadcast Colors on an adjustment layer).",
      thumb: { at: time(sec.worst), prio: 1, label: `out of legal range at ${fmtTime(time(sec.worst))}` },
    });
  }
  if (sections.length > MAX_RANGES)
    out.push({ check: "legalRange", severity: "fail", message: `…and ${sections.length - MAX_RANGES} more out-of-range sections (${frames} frames in all; worst ${pctText(worst.pct)} at ${fmtTime(time(worst.i))}).` });
  return out;
}

/** The grid values of "in range" and "out of range" with this ffmpeg (how swscale widens the depth varies by version). */
export async function calibrateLegal(ff: FfmpegPaths, plan: LegalPlan, width: number, height: number, signal?: AbortSignal): Promise<{ lo: number; hi: number } | null> {
  const measure = async (r8: Range8) => {
    let avg: number | undefined;
    const r = await runTool(
      ff.ffmpeg,
      ["-hide_banner", "-nostats", "-nostdin", "-loglevel", "repeat+info", "-f", "lavfi", "-i", `color=c=gray:s=${width}x${height}:r=1:d=1,format=${plan.pixFmt}`,
        "-vf", `${legalMarkChain({ ...plan, luma: r8, chroma: undefined })},signalstats,metadata=print:key=lavfi.signalstats.YAVG`, "-frames:v", "1", "-f", "null", "-"],
      { signal, onStderrLine: (l) => {
        const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(l);
        if (m) avg = Number(m[1]);
      } },
    );
    return r.code === 0 ? avg : undefined;
  };
  // every code value is inside [0, 255] and none is inside the empty range [256, -1]
  const lo = await measure({ min: 0, max: 255 });
  const hi = await measure({ min: 256, max: -1 });
  return lo !== undefined && hi !== undefined && hi > lo ? { lo, hi } : null;
}

/** Code-value extremes of the frame at `t` (one-frame signalstats), in 8-bit terms. */
export async function measureExtremes(ff: FfmpegPaths, file: string, t: number, plan: LegalPlan, signal?: AbortSignal): Promise<Extremes | undefined> {
  const v: Record<string, number> = {};
  const r = await runTool(
    ff.ffmpeg,
    ["-hide_banner", "-nostats", "-nostdin", "-loglevel", "repeat+info", "-ss", t.toFixed(3), "-i", inputUrl(file), "-frames:v", "1", "-vf", `format=${plan.pixFmt},signalstats,metadata=print`, "-an", "-f", "null", "-"],
    { signal, onStderrLine: (l) => {
      const m = /lavfi\.signalstats\.([YUV](MIN|MAX))=([\d.]+)/.exec(l);
      if (m) v[m[1]] = Number(m[3]);
    } },
  );
  if (r.code !== 0 || v.YMIN === undefined) return undefined;
  const s = 2 ** (plan.bitDepth - 8);
  return { ymin: v.YMIN / s, ymax: v.YMAX / s, cmin: Math.min(v.UMIN, v.VMIN) / s, cmax: Math.max(v.UMAX, v.VMAX) / s };
}

export function evaluateBlack(runs: TimeRun[], spec: NonNullable<Spec["black"]>, duration: number | undefined, fps: number): Marked[] {
  const out: Marked[] = [];
  const half = 0.5 / fps;
  for (const run of runs) {
    // blackdetect ends a run that lasts to the end of the file at the last frame's start time
    const r = duration !== undefined && run.end >= duration - 3 * half - 1e-6 ? { start: run.start, end: Math.max(run.end, duration) } : run;
    const atStart = r.start <= half + 1e-6;
    const atEnd = duration !== undefined && r.end >= duration - 1e-6;
    let s = r.start, e = r.end;
    if (atStart && spec.allowAtStart) s = Math.min(e, spec.allowAtStart);
    if (atEnd && spec.allowAtEnd) e = Math.max(s, duration! - spec.allowAtEnd);
    if (e - s <= spec.maxSeconds + half) continue;
    const where = atStart ? " at the start" : atEnd ? " at the end" : "";
    const allowance = atStart && spec.allowAtStart ? ` (plus ${spec.allowAtStart} s at the start)` : atEnd && spec.allowAtEnd ? ` (plus ${spec.allowAtEnd} s at the end)` : "";
    out.push({
      check: "black",
      severity: "fail",
      message: `${round(r.end - r.start, 2)} s of black${where} (${fmtTime(r.start)}-${fmtTime(r.end)}); the spec allows ${spec.maxSeconds} s${allowance}.`,
      at: [round(r.start, 3), round(r.end, 3)],
      fix: "Check for a missing / disabled layer, a gap between layers, or an unintended fade at that time.",
      thumb: { at: (r.start + r.end) / 2, prio: 4, label: `black at ${fmtTime(r.start)}` },
    });
  }
  return out;
}

export function evaluateFrozen(runs: { start: number; end?: number }[], spec: NonNullable<Spec["frozen"]>, duration: number | undefined, black: TimeRun[] | null, fps: number): Marked[] {
  const out: Marked[] = [];
  const frame = 1 / fps;
  for (const r of runs) {
    // freezedetect doesn't report the end of a freeze that lasts to the end of the file
    const end = r.end ?? duration ?? r.start;
    if (end - r.start <= spec.maxSeconds + frame / 2) continue;
    // a black stretch is frozen too; the black check covers it
    if (black?.some((b) => b.start <= r.start + frame && b.end >= end - frame)) continue;
    out.push({
      check: "frozen",
      severity: "fail",
      message: `The picture doesn't change for ${round(end - r.start, 2)} s (${fmtTime(r.start)}-${fmtTime(end)}); the spec allows ${spec.maxSeconds} s.`,
      at: [round(r.start, 3), round(end, 3)],
      fix: "Check for a held / still frame, a precomp or footage that ends early, or a time-remapped layer at that time.",
      thumb: { at: r.start + Math.min(0.5, (end - r.start) / 2), prio: 3, label: `frozen from ${fmtTime(r.start)}` },
    });
  }
  return out;
}

/**
 * Loudness findings, and the values the spec asks for that couldn't be read from ffmpeg's output (not run: never
 * a pass). Silence (-inf / -70 LUFS and below) is a measurement: no integrated loudness to speak of.
 */
export function evaluateLoudness(l: Analysis["loudness"], spec: NonNullable<Spec["audio"]>): { findings: Finding[]; notRun: NotRun[] } {
  const out: Finding[] = [], notRun: NotRun[] = [];
  const fix = "Adjust the mix level and render again.";
  const unread = (check: string, what: string) => notRun.push({ check, reason: `the ${what} could not be read from ffmpeg's loudness measurement` });
  if (spec.integratedLUFS !== undefined) {
    const tol = spec.toleranceLU ?? 1;
    if (l.integrated === undefined || Number.isNaN(l.integrated)) unread("loudness.integrated", "integrated loudness");
    else if (!Number.isFinite(l.integrated) || l.integrated <= -70)
      out.push({ check: "loudness", severity: "fail", message: `Integrated loudness could not be measured: the audio is silent; the spec wants ${spec.integratedLUFS} LUFS.`, fix: "Check that the audio layers are on and audible in the rendered range." });
    else if (Math.abs(l.integrated - spec.integratedLUFS) > tol + 1e-9)
      out.push({ check: "loudness", severity: "fail", message: `Integrated loudness is ${l.integrated.toFixed(1)} LUFS; the spec wants ${spec.integratedLUFS} LUFS ±${tol} LU.`, fix });
  }
  if (spec.maxTruePeakDBTP !== undefined) {
    if (l.truePeak === undefined || Number.isNaN(l.truePeak)) unread("loudness.truePeak", "true peak");
    else if (l.truePeak > spec.maxTruePeakDBTP + 1e-9)
      out.push({ check: "loudness", severity: "fail", message: `True peak is ${l.truePeak.toFixed(1)} dBTP; the spec allows ${spec.maxTruePeakDBTP} dBTP.`, fix: "Lower the level or put a true-peak limiter on the mix." });
  }
  if (spec.maxShortTermLUFS !== undefined) {
    // no per-100-ms lines at all: not measured; lines but nothing above -70 LUFS: silent, so never too loud
    if (!l.shortTermLines) unread("loudness.maxShortTerm", "short-term loudness");
    else if (l.maxShortTerm !== undefined && l.maxShortTerm > spec.maxShortTermLUFS + 1e-9)
      out.push({
        check: "loudness",
        severity: "fail",
        message: `Short-term loudness reaches ${l.maxShortTerm.toFixed(1)} LUFS (the 3 s from ${fmtTime(l.maxShortTermAt ?? 0)}); the spec allows ${spec.maxShortTermLUFS} LUFS.`,
        ...(l.maxShortTermAt !== undefined ? { at: [round(l.maxShortTermAt, 2), round(l.maxShortTermAt + 3, 2)] as [number, number] } : {}),
        fix,
      });
  }
  if (spec.loudnessRangeLU) {
    const { min, max } = spec.loudnessRangeLU;
    if (l.lra === undefined || Number.isNaN(l.lra)) unread("loudness.range", "loudness range (LRA)");
    else if ((min !== undefined && l.lra < min - 1e-9) || (max !== undefined && l.lra > max + 1e-9))
      out.push({ check: "loudness", severity: "fail", message: `Loudness range (LRA) is ${l.lra.toFixed(1)} LU; the spec wants ${min ?? "any"} to ${max ?? "any"} LU.`, fix });
  }
  return { findings: out, notRun };
}

export function evaluateFlash(r: { general: FlashRun[]; red: FlashRun[] }, max: number): Marked[] {
  const out: Marked[] = [];
  for (const [kind, list] of [["general", r.general], ["red", r.red]] as const)
    for (const f of list.slice(0, MAX_RANGES))
      out.push({
        check: "flash",
        severity: "fail",
        message:
          `Flash pre-check (not a certified PSE / Harding test): ${kind === "red" ? "saturated red flashes" : "flashes"} ${fmtTime(f.start)}-${fmtTime(f.end)}, ` +
          `up to ${f.maxFlashesPerSecond} per second over a large part of the screen; the limit is ${max} per second.`,
        at: [round(f.start, 3), round(f.end, 3)],
        fix: "Slow the flashing down, lower the contrast between the states, or make the flashing area smaller; have the final file tested with a certified PSE / Harding test if it's for broadcast.",
        thumb: { at: f.start, prio: 0, label: `${kind === "red" ? "red " : ""}flashing from ${fmtTime(f.start)}` },
      });
  return out;
}

// ---------------------------------------------------------------------------------------------------------

function requestedChecks(spec: Spec): string[] {
  const c: string[] = [];
  if (spec.video) c.push("video properties");
  if (spec.audio) c.push("audio");
  if (spec.legalRange) c.push("legalRange");
  if (spec.black) c.push("black");
  if (spec.frozen) c.push("frozen");
  if (spec.flash) c.push("flash");
  return c;
}

function abortError(): Error {
  const e = new Error("The file check was cancelled.");
  e.name = "AbortError";
  return e;
}

/** Plans the ffmpeg pass for this file and spec; requested checks that can't run go to `notRun`. */
export function planAnalysis(info: ProbeInfo, spec: Spec, findings: Finding[], notRun: NotRun[]): AnalysisPlan {
  const v = info.video;
  const fps = v?.frameRate || 25;
  const plan: AnalysisPlan = { loudness: false };
  const videoChecks = (["legalRange", "black", "frozen", "flash"] as const).filter((k) => spec[k]);
  if (videoChecks.length && !v) for (const c of videoChecks) notRun.push({ check: c, reason: "the file has no video stream" });
  if (v && spec.legalRange) {
    const pf = analysisPixFmt(v.pixFmt);
    if (!pf) notRun.push({ check: "legalRange", reason: `the file is ${v.rgb ? "RGB" : "not Y'CbCr"} (${v.pixFmt}); legal range is measured on YUV (Y'CbCr) video` });
    else {
      const lr = spec.legalRange;
      const both = !lr.luma && !lr.chroma;
      plan.legal = {
        pixFmt: pf,
        bitDepth: Number(/p(\d+)le$/.exec(pf)?.[1] ?? 8),
        luma: lr.luma || both ? { min: lr.luma?.min ?? (both ? 16 : 0), max: lr.luma?.max ?? (both ? 235 : 255) } : undefined,
        chroma: lr.chroma || both ? { min: lr.chroma?.min ?? (both ? 16 : 0), max: lr.chroma?.max ?? (both ? 240 : 255) } : undefined,
      };
      if (v.colorRange === "full") findings.push({ check: "legalRange", severity: "info", message: "The file signals full range; the legal range was measured on its code values as they are." });
    }
  }
  if (v && spec.black) plan.black = { minRun: round(1 / fps, 6), threshold: spec.black.threshold ?? 0.1 };
  if (v && spec.frozen) plan.frozen = { minRun: round(Math.max(spec.frozen.maxSeconds, 1 / fps), 6), noise: spec.frozen.noise ?? 0.001 };
  if (v && spec.flash) plan.flash = { ...FLASH_GRID, rate: /^\d+(\/\d+)?$/.test(v.frameRateText) && parseRate(v.frameRateText) > 0 ? v.frameRateText : String(round(fps, 6)) };
  // no audio stream: compareProbe fails it (unless the spec says no audio); nothing to measure
  if (wantsLoudness(spec.audio) && info.audio.length) {
    plan.loudness = true;
    if (info.audio.length > 1)
      findings.push({ check: "loudness", severity: "info", message: `The file has ${info.audio.length} audio streams; loudness was measured on the first (stream #${info.audio[0].index}).` });
  }
  return plan;
}

/** Removes Preflight thumbnails left in ~/.aemcp/tmp for more than a day (a call that crashed). */
function sweepThumbnails(dir: string) {
  try {
    for (const n of readdirSync(dir))
      if (n.startsWith("preflight-"))
        try {
          if (Date.now() - statSync(join(dir, n)).mtimeMs > 24 * 3600_000) unlinkSync(join(dir, n));
        } catch {}
  } catch {}
}

/**
 * How much of the picture was decoded, against the file's own duration and frame count: a truncated or damaged
 * file fails (its end was never checked), and no frames at all is "not run", never a pass.
 */
export function coverage(a: Analysis, info: ProbeInfo, videoChecks: string[]): { findings: Finding[]; notRun: NotRun[] } {
  const findings: Finding[] = [], notRun: NotRun[] = [];
  const v = info.video;
  const damage = a.damage.count ? ` (ffmpeg: "${a.damage.first}"${a.damage.count > 1 ? ` and ${a.damage.count - 1} more` : ""})` : "";
  const fix = "Render the file again and check the copy: a render that stopped early, a full disk or an incomplete copy look like this.";
  let short = false;
  if (v && videoChecks.length) {
    const fps = v.frameRate || 25, vd = videoDuration(info), d = a.decoded;
    if (!d.frames) {
      for (const c of videoChecks) notRun.push({ check: c, reason: `no video frames could be read from ffmpeg's output${damage}` });
      if (a.damage.count) findings.push({ check: "file.decode", severity: "fail", message: `No frame of the picture could be decoded${damage}.`, fix });
      return { findings, notRun };
    }
    const covered = (d.lastT ?? 0) - (d.firstT ?? 0) + 1 / fps;
    const cfr = !v.avgFrameRate;
    if (vd !== undefined && covered < vd - 2 / fps - 1e-6) short = true;
    else if (cfr && v.frames && d.frames < v.frames - 2) short = true;
    if (short)
      findings.push({
        check: "file.decode",
        severity: "fail",
        message: `Only ${round(Math.min(covered, vd ?? covered), 2)} s of ${vd !== undefined ? `${round(vd, 2)} s` : "the picture"} could be decoded (${d.frames}${v.frames ? ` of ${v.frames}` : ""} frames): the file is truncated or damaged, and the rest was not checked${damage}.`,
        at: [round(covered, 3), round(vd ?? covered, 3)],
        fix,
      });
  }
  if (!short && a.damage.count)
    findings.push({ check: "file.decode", severity: "warn", message: `ffmpeg reported ${a.damage.count} decoding error${a.damage.count > 1 ? "s" : ""} in the file${damage}: parts of it may be damaged.`, fix });
  return { findings, notRun };
}

export async function checkFile(path: string, spec: Spec, opts: CheckFileOptions = {}): Promise<FileCheck> {
  const t0 = Date.now();
  const tmpDir = join(homedir(), ".aemcp", "tmp");
  sweepThumbnails(tmpDir);
  const allNotRun = (reason: string): NotRun[] => requestedChecks(spec).map((check) => ({ check, reason }));
  if (!existsSync(path) || !statSync(path).isFile())
    return { findings: [{ check: "file", severity: "fail", message: `The rendered file was not found: ${path}` }], probe: {}, notRun: allNotRun("no file") };

  let ff: FfmpegPaths;
  try {
    ff = opts.ffmpeg ?? (await ensureFfmpeg({ allowDownload: opts.allowDownload, signal: opts.signal, confirmDownload: opts.confirmDownload }));
  } catch (e: any) {
    if (opts.signal?.aborted) throw abortError();
    const why = e instanceof FfmpegMissingError ? e.message : String(e?.message ?? e);
    return { findings: [], probe: {}, notRun: allNotRun(why) };
  }

  // 1. ffprobe (stdout collected as bytes and decoded once: a multi-byte character can straddle two chunks)
  const chunks: Buffer[] = [];
  const pr = await runTool(ff.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-i", inputUrl(path)], { signal: opts.signal, onStdout: (b) => chunks.push(b) });
  if (pr.aborted) throw abortError();
  let info: ProbeInfo;
  try {
    if (pr.code !== 0) throw new Error(pr.stderrTail.trim().split("\n").pop() || `exit code ${pr.code}`);
    info = parseProbe(Buffer.concat(chunks).toString("utf8"), path);
  } catch (e: any) {
    return {
      findings: [{ check: "file", severity: "fail", message: `ffprobe could not read the file (${String(e?.message ?? e).slice(0, 200)}); it may be damaged, incomplete or not a media file.` }],
      probe: {},
      notRun: allNotRun("the file could not be read"),
    };
  }
  const findings: Marked[] = compareProbe(info, spec);
  const notRun: NotRun[] = [];
  const notes: string[] = [];
  const ran: string[] = [];
  if (spec.video) ran.push("video properties");
  if (spec.audio) ran.push("audio properties");
  const fps = info.video?.frameRate || 25;
  const vd = videoDuration(info);
  const audioIndex = info.audio.length ? 0 : null;
  const thumbnails: NonNullable<FileCheck["thumbnails"]> = [];
  try {
    // 2. one ffmpeg pass for everything that needs decoding
    const plan = planAnalysis(info, spec, findings, notRun);
    if (plan.legal && info.video) {
      const cal = await calibrateLegal(ff, plan.legal, info.video.width, info.video.height, opts.signal);
      if (opts.signal?.aborted) throw abortError();
      if (cal) Object.assign(plan.legal, cal);
      else notes.push("legal range: the measuring grid couldn't be calibrated with this ffmpeg; the standard values were used (percentages may be slightly off)");
    }
    const args = buildArgs(path, plan, audioIndex);
    if (args) {
      const col = new LogCollector(resolve(path));
      const det = plan.flash
        ? new FlashDetector({
            width: plan.flash.width,
            height: plan.flash.height,
            fps: plan.flash.rate ? parseRate(plan.flash.rate) || fps : fps,
            maxFlashesPerSecond: spec.flash?.maxFlashesPerSecond,
            minAreaFraction: spec.flash?.minAreaFraction,
            minLuminanceChange: spec.flash?.minLuminanceChange,
            redFlash: spec.flash?.redFlash !== false,
          })
        : null;
      let pending: Buffer = Buffer.alloc(0);
      const r = await runTool(ff.ffmpeg, args, {
        signal: opts.signal,
        onStderrLine: (l) => col.line(l),
        onStdout: (b) => {
          if (!det) return;
          pending = pending.length ? Buffer.concat([pending, b]) : b;
          const n = det.frameBytes;
          let off = 0;
          for (; pending.length - off >= n; off += n) det.push(pending.subarray(off, off + n));
          pending = pending.subarray(off);
        },
      });
      if (r.aborted) throw abortError();
      const videoNames = [plan.legal && "legalRange", plan.black && "black", plan.frozen && "frozen", plan.flash && "flash"].filter(Boolean) as string[];
      const names = [...videoNames, ...(plan.loudness ? ["loudness"] : [])];
      const a = col.a;
      if (r.code !== 0) {
        const why = `ffmpeg failed (${r.stderrTail.trim().split("\n").slice(-2).join(" ").slice(0, 300)})`;
        for (const c of names) notRun.push({ check: c, reason: why });
        if (a.damage.count) findings.push(...coverage({ ...a, decoded: { frames: 0 } }, info, []).findings);
      } else {
        const cov = coverage(a, info, videoNames);
        findings.push(...cov.findings);
        notRun.push(...cov.notRun);
        const blind = new Set(cov.notRun.map((n) => n.check));
        ran.push(...names.filter((n) => !blind.has(n)));
        if (plan.legal && !blind.has("legalRange")) {
          const measured = a.frames.oy.filter((x) => x !== undefined).length;
          if (measured < a.decoded.frames - 2)
            notRun.push({ check: "legalRange", reason: `only ${measured} of ${a.decoded.frames} frames could be measured (ffmpeg's per-frame output could not be read)` });
          if (measured) {
            const maxPct = spec.legalRange?.maxOutOfRangePercent ?? 0;
            const extremes = new Map<number, Extremes>();
            for (const sec of legalSections(a, plan.legal, maxPct).sections.slice(0, MAX_RANGES)) {
              const x = await measureExtremes(ff, path, a.frames.t[sec.worst] ?? sec.worst / fps, plan.legal, opts.signal);
              if (x) extremes.set(sec.worst, x);
            }
            if (opts.signal?.aborted) throw abortError();
            findings.push(...evaluateLegal(a, plan.legal, maxPct, fps, extremes));
          }
        }
        if (plan.black && !blind.has("black")) findings.push(...evaluateBlack(a.black, spec.black!, vd, fps));
        if (plan.frozen && !blind.has("frozen")) findings.push(...evaluateFrozen(a.frozen, spec.frozen!, vd, plan.black ? a.black : null, fps));
        if (plan.loudness) {
          const l = evaluateLoudness(a.loudness, spec.audio!);
          findings.push(...l.findings);
          notRun.push(...l.notRun);
        }
        if (det && !blind.has("flash")) {
          const fr = det.result();
          if (!fr.frames) notRun.push({ check: "flash", reason: "no frames reached the flash pre-check" });
          else {
            findings.push(...evaluateFlash(fr, spec.flash?.maxFlashesPerSecond ?? 3));
            findings.push({ check: "flash", severity: "info", message: `Flash pre-check on a ${FLASH_GRID.width}x${FLASH_GRID.height} grid over ${fr.frames} frames; not a certified PSE / Harding test.` });
          }
        }
      }
    }

    // 3. thumbnails at the most important failing times
    if (opts.thumbnails && info.video) {
      const picks = findings
        .filter((f) => f.thumb)
        .sort((a, b) => a.thumb!.prio - b.thumb!.prio || a.thumb!.at - b.thumb!.at)
        .filter((f, i, all) => all.findIndex((g) => Math.abs(g.thumb!.at - f.thumb!.at) < 0.5) === i)
        .slice(0, 4);
      if (picks.length) {
        mkdirSync(tmpDir, { recursive: true });
        const id = randomBytes(5).toString("hex");
        for (const [i, f] of picks.entries()) {
          const at = Math.max(0, Math.min(f.thumb!.at, (vd ?? f.thumb!.at + 1) - 1 / fps));
          // JPEG at 960 px: a full PNG frame is about 1 MB of base64 per image for the AI to read
          const out = join(tmpDir, `preflight-${id}-${i + 1}.jpg`);
          const r = await runTool(ff.ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", at.toFixed(3), "-i", inputUrl(path), "-frames:v", "1", "-vf", "scale='min(960,iw)':-2", "-q:v", "3", "-y", out], {
            signal: opts.signal,
          });
          if (existsSync(out)) {
            // written (perhaps in part) before a cancel: removed below with the others
            thumbnails.push({ at: round(at, 3), path: out, label: f.thumb!.label });
            if (r.code !== 0 && !r.aborted) {
              thumbnails.pop();
              try {
                unlinkSync(out);
              } catch {}
            }
          }
          if (r.aborted) throw abortError();
        }
      }
    }
  } catch (e) {
    // a cancel or an error: no thumbnail is left behind
    for (const t of thumbnails)
      try {
        unlinkSync(t.path);
      } catch {}
    throw e;
  }

  return {
    findings: findings.map(({ thumb: _thumb, ...f }) => f),
    probe: compactProbe(info),
    ...(thumbnails.length ? { thumbnails } : {}),
    ...(notRun.length ? { notRun } : {}),
    ...(notes.length ? { notes } : {}),
    ran,
    tool: { ffmpeg: ff.ffmpeg, source: ff.source, seconds: round((Date.now() - t0) / 1000, 2) },
  };
}
