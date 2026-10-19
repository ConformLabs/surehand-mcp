import { describe, expect, it } from "vitest";
import {
  analysisPixFmt,
  buildArgs,
  compareProbe,
  coverage,
  inputUrl,
  LogCollector,
  videoDuration,
  evaluateBlack,
  evaluateFrozen,
  evaluateLegal,
  evaluateLoudness,
  parseLog,
  parseProbe,
  parseRate,
  pixFmtInfo,
  planAnalysis,
} from "../src/preflight/media.js";
import { loadSpec, type Finding } from "../src/preflight/spec.js";

// trimmed `ffprobe -print_format json -show_format -show_streams` of an After Effects ProRes 422 HQ render
const PRORES = {
  streams: [
    {
      index: 0,
      codec_name: "prores",
      profile: "HQ",
      codec_type: "video",
      width: 1920,
      height: 1080,
      sample_aspect_ratio: "1:1",
      pix_fmt: "yuv422p10le",
      color_range: "tv",
      color_space: "bt709",
      color_transfer: "bt709",
      color_primaries: "bt709",
      field_order: "progressive",
      r_frame_rate: "30000/1001",
      avg_frame_rate: "30000/1001",
      duration: "10.010000",
      bits_per_raw_sample: "10",
      nb_frames: "300",
    },
    { index: 1, codec_name: "pcm_s24le", codec_type: "audio", sample_rate: "48000", channels: 2, channel_layout: "stereo" },
  ],
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "10.010000", size: "123456789", bit_rate: "98000000" },
};

const checks = (f: Finding[]) => f.map((x) => `${x.severity}:${x.check}`);

describe("ffprobe parsing", () => {
  it("reads a ProRes render", () => {
    const p = parseProbe(JSON.stringify(PRORES), "/x/out.MOV");
    expect(p.extension).toBe("mov");
    expect(p.duration).toBeCloseTo(10.01);
    expect(p.video).toMatchObject({ codec: "prores", profile: "HQ", width: 1920, height: 1080, bitDepth: 10, chroma: "4:2:2", alpha: false, fieldOrder: "progressive", colorRange: "limited", colorMatrix: "bt709" });
    expect(p.video!.frameRate).toBeCloseTo(29.97, 2);
    expect(p.audio).toEqual([{ index: 1, codec: "pcm_s24le", sampleRate: 48000, channels: 2, layout: "stereo" }]);
  });

  it("frame rates", () => {
    expect(parseRate("30000/1001")).toBeCloseTo(29.97003, 4);
    expect(parseRate("24000/1001")).toBeCloseTo(23.976, 3);
    expect(parseRate("25/1")).toBe(25);
    expect(parseRate("0/0")).toBe(0);
  });

  it("pixel formats", () => {
    expect(pixFmtInfo("yuv420p")).toEqual({ bitDepth: 8, chroma: "4:2:0", alpha: false, rgb: false });
    expect(pixFmtInfo("yuva444p12le")).toEqual({ bitDepth: 12, chroma: "4:4:4", alpha: true, rgb: false });
    expect(pixFmtInfo("yuvj422p")).toMatchObject({ bitDepth: 8, chroma: "4:2:2" });
    expect(pixFmtInfo("p010le")).toMatchObject({ bitDepth: 10, chroma: "4:2:0" });
    expect(pixFmtInfo("rgb24")).toEqual({ bitDepth: 8, chroma: "4:4:4", alpha: false, rgb: true });
    expect(pixFmtInfo("argb")).toMatchObject({ bitDepth: 8, alpha: true, rgb: true });
    expect(pixFmtInfo("rgba64le")).toMatchObject({ bitDepth: 16, alpha: true, rgb: true });
    expect(pixFmtInfo("gbrp10le")).toMatchObject({ bitDepth: 10, rgb: true });
    expect(analysisPixFmt("yuva444p12le")).toBe("yuv444p12le");
    expect(analysisPixFmt("yuv422p10le")).toBe("yuv422p10le");
    expect(analysisPixFmt("nv12")).toBe("yuv420p");
    expect(analysisPixFmt("yuvj420p")).toBe("yuvj420p");
    expect(analysisPixFmt("rgb48le")).toBeNull();
  });

  it("field order and missing color tags", () => {
    const s = structuredClone(PRORES);
    Object.assign(s.streams[0], { field_order: "tb", color_primaries: "unknown", color_range: undefined });
    const p = parseProbe(s, "a.mov");
    expect(p.video!.fieldOrder).toBe("bff");
    expect(p.video!.colorPrimaries).toBeUndefined();
    expect(p.video!.colorRange).toBeUndefined();
  });
});

describe("file properties against the spec", () => {
  const p = parseProbe(PRORES, "/x/out.mov");

  it("passes a matching spec", () => {
    const spec = loadSpec({
      video: { width: 1920, height: 1080, frameRate: 29.97, codec: ["prores"], container: ["mov", "mxf"], bitDepth: 10, chromaSubsampling: ["4:2:2"], alpha: false, fieldOrder: "progressive", colorPrimaries: "bt709", colorTransfer: "bt709", colorMatrix: "bt709", colorRange: "limited", duration: 10, durationToleranceFrames: 1 },
      audio: { sampleRate: 48000, channels: 2, required: true },
    });
    expect(compareProbe(p, spec)).toEqual([]);
  });

  it("names every mismatch", () => {
    const spec = loadSpec({
      video: { width: 3840, frameRate: 30, codec: ["h264"], container: ["mp4"], bitDepth: [8], chromaSubsampling: ["4:2:0"], alpha: true, fieldOrder: "tff", colorPrimaries: "bt2020", colorRange: "full", duration: { max: 9 } },
      audio: { sampleRate: 44100, channels: 6 },
    });
    const f = compareProbe(p, spec);
    expect(checks(f)).toEqual([
      "fail:file.container",
      "fail:file.codec",
      "fail:file.size",
      "fail:file.frameRate",
      "fail:file.bitDepth",
      "fail:file.chroma",
      "fail:file.alpha",
      "fail:file.fieldOrder",
      "fail:file.color",
      "fail:file.color",
      "fail:file.duration",
      "fail:file.audio",
      "fail:file.audio",
    ]);
    expect(f[3].message).toMatch(/29\.97 fps \(30000\/1001\); the spec wants 30/);
    expect(f[2].message).toMatch(/1920x1080; the spec wants 3840x1080/);
  });

  it("29.97 is not 30, 23.976 matches 24000/1001", () => {
    expect(compareProbe(p, loadSpec({ video: { frameRate: 30 } }))).toHaveLength(1);
    const q = parseProbe({ ...PRORES, streams: [{ ...PRORES.streams[0], r_frame_rate: "24000/1001", avg_frame_rate: "24000/1001" }] }, "a.mov");
    expect(compareProbe(q, loadSpec({ video: { frameRate: 23.976 } }))).toEqual([]);
  });

  it("duration tolerance in frames", () => {
    // 10.01 s at 29.97 = 300 frames; 10 s = 299.7 frames
    expect(compareProbe(p, loadSpec({ video: { duration: 10 } }))).toEqual([]);
    expect(compareProbe(p, loadSpec({ video: { duration: 9.9 } }))).toHaveLength(1);
    expect(compareProbe(p, loadSpec({ video: { duration: 9.9, durationToleranceFrames: 3 } }))).toEqual([]);
  });

  it("warns when a required tag isn't signalled", () => {
    const q = parseProbe({ ...PRORES, streams: [{ ...PRORES.streams[0], color_primaries: undefined, field_order: undefined }] }, "a.mov");
    expect(checks(compareProbe(q, loadSpec({ video: { colorPrimaries: "bt709", fieldOrder: "progressive" } })))).toEqual(["warn:file.fieldOrder", "warn:file.color"]);
  });

  it("audio required / forbidden", () => {
    const silent = parseProbe({ ...PRORES, streams: [PRORES.streams[0]] }, "a.mov");
    expect(checks(compareProbe(silent, loadSpec({ audio: { required: true } })))).toEqual(["fail:file.audio"]);
    expect(checks(compareProbe(p, loadSpec({ audio: { required: false } })))).toEqual(["fail:file.audio"]);
    // loudness / sample rate asked for and no audio stream (Audio Output off): a failure, not a skip
    const noAudio = compareProbe(silent, loadSpec({ audio: { integratedLUFS: -23, sampleRate: 48000 } }));
    expect(checks(noAudio)).toEqual(["fail:file.audio"]);
    expect(noAudio[0].message).toBe("The file has no audio stream; the spec asks for 48000 Hz, -23 LUFS integrated.");
    expect(noAudio[0].fix).toMatch(/Audio Output/);
    const notRun: { check: string; reason: string }[] = [];
    expect(planAnalysis(silent, loadSpec({ audio: { integratedLUFS: -23 } }), [], notRun).loudness).toBe(false);
    expect(notRun).toEqual([]);
    // the spec says no audio: nothing to measure, nothing wrong
    expect(compareProbe(silent, loadSpec({ audio: { required: false, integratedLUFS: -23 } }))).toEqual([]);
  });

  it("several audio streams: each one is compared, loudness says which one it measured", () => {
    const two = parseProbe({ ...PRORES, streams: [...PRORES.streams, { index: 2, codec_name: "pcm_s24le", codec_type: "audio", sample_rate: "44100", channels: 1 }] }, "a.mov");
    const f = compareProbe(two, loadSpec({ audio: { sampleRate: 48000, channels: 2 } }));
    expect(f.map((x) => x.message)).toEqual(["Audio stream 2 of 2 (#2) sample rate is 44100 Hz; the spec wants 48000 Hz.", "Audio stream 2 of 2 (#2) has 1 channel; the spec wants 2."]);
    const notes: Finding[] = [];
    planAnalysis(two, loadSpec({ audio: { integratedLUFS: -23 } }), notes, []);
    expect(notes[0].message).toMatch(/2 audio streams; loudness was measured on the first \(stream #1\)/);
  });

  it("durations: the picture's own duration, and a warning when the sound is longer", () => {
    // the container says 12 s (the audio runs on); the picture is 300 frames at 29.97 = 10.01 s
    const long = parseProbe({ ...PRORES, streams: [PRORES.streams[0], { ...PRORES.streams[1], duration: "12.0" }], format: { ...PRORES.format, duration: "12.0" } }, "a.mov");
    expect(long.duration).toBe(12);
    expect(videoDuration(long)).toBeCloseTo(10.01);
    const f = compareProbe(long, loadSpec({ video: { duration: 10 } }));
    expect(checks(f)).toEqual(["warn:file.duration"]);
    expect(f[0].message).toMatch(/The audio \(12 s\) is longer than the picture \(10\.01 s\) by 1\.99 s \(60 frames\)/);
    // no stream duration: nb_frames / fps
    const noDur = parseProbe({ ...PRORES, streams: [{ ...PRORES.streams[0], duration: undefined }], format: { ...PRORES.format, duration: "12.0" } }, "a.mov");
    expect(videoDuration(noDur)).toBeCloseTo(300 / (30000 / 1001));
    // within a frame: fine
    const ok = parseProbe({ ...PRORES, streams: [PRORES.streams[0], { ...PRORES.streams[1], duration: "10.02" }] }, "a.mov");
    expect(compareProbe(ok, loadSpec({ audio: { channels: 2 } }))).toEqual([]);
  });

  it("legal range is skipped for RGB files", () => {
    const rgb = parseProbe({ ...PRORES, streams: [{ ...PRORES.streams[0], codec_name: "qtrle", pix_fmt: "argb" }] }, "a.mov");
    const notRun: { check: string; reason: string }[] = [];
    const plan = planAnalysis(rgb, loadSpec({ legalRange: {} }), [], notRun);
    expect(plan.legal).toBeUndefined();
    expect(notRun).toEqual([{ check: "legalRange", reason: expect.stringMatching(/^the file is RGB \(argb\)/) }]);
  });
});

describe("the ffmpeg pass", () => {
  it("builds one graph for every check that's asked for", () => {
    const p = parseProbe(PRORES, "/x/out.mov");
    const spec = loadSpec({ legalRange: { luma: { min: 16, max: 235 } }, black: { maxSeconds: 0 }, frozen: { maxSeconds: 2 }, audio: { integratedLUFS: -23 }, flash: { check: true } });
    const plan = planAnalysis(p, spec, [], []);
    expect(plan.legal).toEqual({ pixFmt: "yuv422p10le", bitDepth: 10, luma: { min: 16, max: 235 }, chroma: undefined });
    const args = buildArgs("/x/out.mov", plan, 0)!;
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("[0:v:0]format=yuv422p10le,blackdetect@black");
    expect(graph).toContain("blackdetect@black=d=0.033367:pix_th=0.1");
    expect(graph).toContain("freezedetect@frozen=n=0.001:d=2");
    expect(graph).toContain("split=2[b_legal][b_flash]");
    expect(graph).toContain("[b_legal]lutyuv=y='if(between(val/4,16,235),64,800)':u=64:v=64,scale=64:36:flags=area,format=yuv444p16le,signalstats@out,");
    // a constant frame rate for the flash grid (frame n at n / rate, also on a variable-frame-rate file)
    expect(graph).toContain("[b_flash]fps=30000/1001,scale=32:18:flags=area,format=rgb24[o_flash]");
    // every decoded frame is counted (coverage), before the branches
    expect(graph).toContain("freezedetect@frozen=n=0.001:d=2,metadata@cnt=mode=add:key=aemcp.f:value=1,metadata@count=mode=print:key=aemcp.f,split=2");
    expect(args[args.indexOf("-i") + 1]).toBe("file:/x/out.mov");
    expect(graph).toContain("[0:a:0]ebur128@loud=peak=true:framelog=info[o_audio]");
    expect(args.slice(-6)).toEqual(["-", "-map", "[o_flash]", "-f", "rawvideo", "pipe:1"]);
  });

  it("only audio: no video decoding", () => {
    const p = parseProbe(PRORES, "/x/out.mov");
    const args = buildArgs("/x/out.mov", planAnalysis(p, loadSpec({ audio: { maxTruePeakDBTP: -1 } }), [], []), 0)!;
    expect(args.join(" ")).not.toContain("0:v");
    // black alone still counts frames
    expect(buildArgs("/x/out.mov", planAnalysis(p, loadSpec({ black: { maxSeconds: 1 } }), [], []), 0)!.join(" ")).toContain("metadata@count=mode=print");
    expect(buildArgs("/x/out.mov", planAnalysis(p, loadSpec({ video: { width: 1920 } }), [], []), 0)).toBeNull();
  });

  const LOG = `
[metadata@oyavg @ 0x3] frame:0    pts:0       pts_time:0
[metadata@oyavg @ 0x3] lavfi.signalstats.YAVG=27648
[metadata@ouavg @ 0x4] frame:0    pts:0       pts_time:0
[metadata@ouavg @ 0x4] lavfi.signalstats.UAVG=4096
[metadata@oyavg @ 0x3] frame:1    pts:1001    pts_time:0.0333667
[metadata@oyavg @ 0x3] lavfi.signalstats.YAVG=4096.02
[blackdetect@black @ 0x5] black_start:0 black_end:1.5 black_duration:1.5
[blackdetect@black @ 0x5] black_start:58.5 black_end:60 black_duration:1.5
[freezedetect@frozen @ 0x6] lavfi.freezedetect.freeze_start: 10.01
[freezedetect@frozen @ 0x6] lavfi.freezedetect.freeze_duration: 3.003
[freezedetect@frozen @ 0x6] lavfi.freezedetect.freeze_end: 13.013
[freezedetect@frozen @ 0x6] lavfi.freezedetect.freeze_start: 57
[ebur128@loud @ 0x7] t: 3.09998    TARGET:-23 LUFS    M: -21.0 S: -20.4     I: -22.0 LUFS       LRA:   2.0 LU  FTPK: -3.0 -3.1 dBFS  TPK: -0.5 -0.6 dBFS
[ebur128@loud @ 0x7] t: 3.19998    TARGET:-23 LUFS    M: -21.0 S: -18.2     I: -22.0 LUFS       LRA:   2.0 LU  FTPK: -3.0 -3.1 dBFS  TPK: -0.5 -0.6 dBFS
[ebur128@loud @ 0x7] Summary:

  Integrated loudness:
    I:         -21.4 LUFS
    Threshold: -31.4 LUFS

  Loudness range:
    LRA:         6.2 LU
    Threshold: -41.4 LUFS
    LRA low:   -25.0 LUFS
    LRA high:  -18.8 LUFS

  True peak:
    Peak:       -0.4 dBFS
[out#0/null @ 0x8] video:1KiB audio:2KiB
`;

  it("parses signalstats, blackdetect, freezedetect and ebur128 output", () => {
    const a = parseLog(LOG);
    expect(a.frames.t).toEqual([0, 0.0333667]);
    expect(a.frames.oy).toEqual([27648, 4096.02]);
    expect(a.frames.ou[0]).toBe(4096);
    expect(a.black).toEqual([{ start: 0, end: 1.5 }, { start: 58.5, end: 60 }]);
    expect(a.frozen).toEqual([{ start: 10.01, end: 13.013 }, { start: 57 }]);
    expect(a.loudness).toEqual({ integrated: -21.4, lra: 6.2, truePeak: -0.4, maxShortTerm: -18.2, maxShortTermAt: expect.closeTo(0.2, 3), shortTermLines: 2 });
    expect(a.decoded).toEqual({ frames: 0 });
    expect(a.damage).toEqual({ count: 0 });
  });

  it("counts decoded frames and notes damage messages (not the file's own name)", () => {
    const c = new LogCollector("/r/corrupt take.mov");
    for (const l of [
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'file:/r/corrupt take.mov':",
      "[metadata@count @ 0x1] frame:0    pts:0       pts_time:0",
      "[metadata@count @ 0x1] aemcp.f=1",
      "[metadata@count @ 0x1] frame:1    pts:1       pts_time:0.04",
      "[mov,mp4,m4a,3gp,3g2,mj2 @ 0x2] stream 0, offset 0x30: partial file",
      "[prores @ 0x3] Invalid data found when processing input",
    ])
      c.line(l);
    expect(c.a.decoded).toEqual({ frames: 2, firstT: 0, lastT: 0.04 });
    expect(c.a.damage).toEqual({ count: 2, first: "[mov,mp4,m4a,3gp,3g2,mj2 @ 0x2] stream 0, offset 0x30: partial file" });
    expect(c.a.frames.t).toEqual([]);
  });

  it("coverage: a truncated file fails, no frames is not run, damage alone warns", () => {
    const p = parseProbe(PRORES, "/x/out.mov"); // 300 frames, 10.01 s
    const a = (frames: number, lastT: number, damage = 0) => ({ ...parseLog(""), decoded: { frames, firstT: 0, lastT }, damage: { count: damage, ...(damage ? { first: "partial file" } : {}) } });
    expect(coverage(a(300, 299 / (30000 / 1001)), p, ["black"])).toEqual({ findings: [], notRun: [] });
    // half the file
    const half = coverage(a(150, 149 / (30000 / 1001), 1), p, ["black"]);
    expect(half.findings).toEqual([expect.objectContaining({ check: "file.decode", severity: "fail" })]);
    expect(half.findings[0].message).toMatch(/^Only 5.01 s of 10\.01 s could be decoded \(150 of 300 frames\): the file is truncated or damaged, and the rest was not checked \(ffmpeg: "partial file"\)/);
    // a frame short is fine (rounding); three short is not
    expect(coverage(a(299, 298 / (30000 / 1001)), p, ["frozen"]).findings).toEqual([]);
    expect(coverage(a(297, 296 / (30000 / 1001)), p, ["frozen"]).findings).toHaveLength(1);
    // nothing read (e.g. another ffmpeg's log format): not run, never a pass
    expect(coverage(a(0, 0), p, ["black", "flash"]).notRun.map((n) => n.check)).toEqual(["black", "flash"]);
    // whole, but ffmpeg complained: a warning
    expect(coverage(a(300, 299 / (30000 / 1001), 3), p, ["black"]).findings).toEqual([expect.objectContaining({ check: "file.decode", severity: "warn" })]);
    expect(inputUrl("-odd name.mov")).toMatch(/^file:\/.*-odd name\.mov$/);
  });

  it("legal range: the out-of-range share from the marked grid's average", () => {
    const a = parseLog(LOG);
    // (27648 - 4096) / (51200 - 4096) = 50%; frame 1: one pixel in 2 million (0.02 / 47104)
    const plan = { pixFmt: "yuv422p10le", bitDepth: 10, luma: { min: 16, max: 235 } };
    const f = evaluateLegal(a, plan, 0, 29.97, new Map([[0, { ymin: 16, ymax: 250.25, cmin: 16, cmax: 240 }]]));
    expect(f).toHaveLength(1);
    expect(f[0].message).toMatch(/worst at 0\.00 s: 50% of pixels have luma outside 16-235 \(luma 16-250\.3 in that frame\)/);
    expect(f[0].message).toMatch(/10-bit code values, scaled to 8-bit/);
    expect(f[0].at).toEqual([0, 0.067]);
    expect(f[0].message).toMatch(/\(2 frames\)/);
    // with a calibrated grid (another ffmpeg widening 10 -> 16 bits differently)
    expect(evaluateLegal(a, { ...plan, lo: 4100, hi: 51250 }, 0, 29.97)[0].message).toMatch(/49\.9% of pixels/);
    expect(evaluateLegal(a, { pixFmt: "yuv422p10le", bitDepth: 10, luma: { min: 16, max: 235 } }, 60, 29.97)).toEqual([]);
  });

  it("black: allowances at the start and end", () => {
    const runs = [{ start: 0, end: 1.5 }, { start: 20, end: 20.2 }, { start: 58.5, end: 60 }];
    expect(checks(evaluateBlack(runs, { maxSeconds: 0.5 }, 60, 25))).toEqual(["fail:black", "fail:black"]);
    expect(evaluateBlack(runs, { maxSeconds: 0.5, allowAtStart: 1.5, allowAtEnd: 0.5 }, 60, 25).map((f) => f.at)).toEqual([[58.5, 60]]);
    expect(evaluateBlack(runs, { maxSeconds: 0.5, allowAtStart: 1.5, allowAtEnd: 1.5 }, 60, 25)).toEqual([]);
    expect(evaluateBlack(runs, { maxSeconds: 0 }, 60, 25)).toHaveLength(3);
  });

  it("frozen: open-ended freezes run to the end; black stretches are left to the black check", () => {
    const f = evaluateFrozen([{ start: 10.01, end: 13.013 }, { start: 57 }], { maxSeconds: 2 }, 60, null, 29.97);
    expect(f.map((x) => x.at)).toEqual([[10.01, 13.013], [57, 60]]);
    expect(evaluateFrozen([{ start: 57 }], { maxSeconds: 2 }, 60, [{ start: 57, end: 60 }], 29.97)).toEqual([]);
    expect(evaluateFrozen([{ start: 1, end: 3 }], { maxSeconds: 2 }, 60, null, 25)).toEqual([]);
  });

  it("loudness against the spec", () => {
    const l = parseLog(LOG).loudness;
    const ev = (x: typeof l, s: Parameters<typeof evaluateLoudness>[1]) => evaluateLoudness(x, s).findings;
    expect(ev(l, { integratedLUFS: -23 }).map((f) => f.message)).toEqual(["Integrated loudness is -21.4 LUFS; the spec wants -23 LUFS ±1 LU."]);
    expect(evaluateLoudness(l, { integratedLUFS: -23, toleranceLU: 2 })).toEqual({ findings: [], notRun: [] });
    expect(ev(l, { maxTruePeakDBTP: -1 })[0].message).toMatch(/True peak is -0\.4 dBTP/);
    expect(ev(l, { maxShortTermLUFS: -20 })[0].message).toMatch(/reaches -18\.2 LUFS/);
    expect(ev(l, { loudnessRangeLU: { max: 5 } })[0].message).toMatch(/LRA\) is 6\.2 LU/);
    expect(ev({ integrated: -70 }, { integratedLUFS: -23 })[0].message).toMatch(/could not be measured: the audio is silent/);
    // silent: no short-term value above -70, but the lines were there: never too loud
    expect(evaluateLoudness({ integrated: -Infinity, shortTermLines: 30, truePeak: -Infinity }, { maxShortTermLUFS: -20, maxTruePeakDBTP: -1 })).toEqual({ findings: [], notRun: [] });
  });

  it("loudness values that couldn't be read are not run, never a pass", () => {
    const r = evaluateLoudness({ integrated: -23 }, { integratedLUFS: -23, maxTruePeakDBTP: -1, maxShortTermLUFS: -18, loudnessRangeLU: { max: 10 } });
    expect(r.findings).toEqual([]);
    expect(r.notRun.map((n) => n.check)).toEqual(["loudness.truePeak", "loudness.maxShortTerm", "loudness.range"]);
    expect(r.notRun[0].reason).toBe("the true peak could not be read from ffmpeg's loudness measurement");
    expect(evaluateLoudness({}, { integratedLUFS: -23 }).notRun.map((n) => n.check)).toEqual(["loudness.integrated"]);
  });
});
