// Integration: real ffmpeg on tiny generated files. Skipped when ffmpeg / ffprobe aren't installed (CI).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findFfmpeg } from "../src/preflight/ffmpeg.js";
import { checkFile } from "../src/preflight/media.js";
import { loadSpec } from "../src/preflight/spec.js";

const ff = findFfmpeg();
const dir = mkdtempSync(join(tmpdir(), "aemcp-preflight-"));
const file = (n: string) => join(dir, n);

function make(name: string, args: string[]) {
  const r = spawnSync(ff!.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args, file(name)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`could not make ${name}: ${r.stderr}`);
}

const checks = (f: { check: string; severity: string }[]) => f.filter((x) => x.severity !== "info").map((x) => x.check);

describe.skipIf(!ff)("rendered-file checks with ffmpeg", () => {
  beforeAll(() => {
    // ProRes 422 HQ, 29.97, 10-bit, tagged bt709, with stereo 1 kHz sine at -20 dBFS (= -20 LUFS)
    make("props.mov", [
      "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30000/1001:d=2",
      "-f", "lavfi", "-i", "aevalsrc=0.1*sin(2*PI*1000*t)|0.1*sin(2*PI*1000*t):s=48000:d=2",
      "-vf", "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
      "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le",
      "-c:a", "pcm_s24le", "-shortest",
    ]);
    // left half luma 250 (out of range), right half 128
    make("legal8.mkv", ["-f", "lavfi", "-i", "color=gray:s=320x180:r=25:d=1,format=yuv420p,geq=lum='if(lt(X,W/2),250,128)':cb=128:cr=128", "-c:v", "ffv1"]);
    make("legal10.mov", ["-f", "lavfi", "-i", "color=gray:s=320x180:r=25:d=1,format=yuv422p10le,geq=lum='if(lt(X,W/2),1000,512)':cb=512:cr=512", "-c:v", "prores_ks", "-profile:v", "3"]);
    make("clean.mkv", ["-f", "lavfi", "-i", "color=gray:s=320x180:r=25:d=1,format=yuv420p", "-c:v", "ffv1"]);
    // 1 s black, 2 s moving, 2 s still red, 1 s moving, 1 s black
    make("blackfrozen.mkv", [
      "-f", "lavfi", "-i", "color=black:s=320x180:r=25:d=1",
      "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=2",
      "-f", "lavfi", "-i", "color=red:s=320x180:r=25:d=2",
      "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=1",
      "-f", "lavfi", "-i", "color=black:s=320x180:r=25:d=1",
      "-filter_complex", "[0:v][1:v][2:v][3:v][4:v]concat=n=5:v=1,format=yuv420p[v]", "-map", "[v]", "-c:v", "ffv1",
    ]);
    // mono 1 kHz sine at 0.1 = -23 LUFS, true peak -20 dBTP
    make("tone.wav", ["-f", "lavfi", "-i", "aevalsrc=0.1*sin(2*PI*1000*t):s=48000:d=5", "-c:a", "pcm_s16le"]);
    // full-screen black / white every frame at 20 fps = 10 Hz; every 5 frames = 2 Hz
    make("flash10.mkv", ["-f", "lavfi", "-i", "color=black:s=160x90:r=20:d=2,format=yuv420p,geq=lum='if(mod(N,2),235,16)':cb=128:cr=128", "-c:v", "ffv1"]);
    make("flash2.mkv", ["-f", "lavfi", "-i", "color=black:s=160x90:r=20:d=3,format=yuv420p,geq=lum='if(mod(floor(N/5),2),235,16)':cb=128:cr=128", "-c:v", "ffv1"]);
    // saturated red against a grey of the same luminance, every frame
    // picture only (Audio Output off), and picture with two audio streams (48 kHz stereo + 44.1 kHz mono)
    make("noaudio.mov", ["-f", "lavfi", "-i", "testsrc2=s=160x90:r=25:d=2", "-c:v", "ffv1"]);
    make("twoaudio.mkv", [
      "-f", "lavfi", "-i", "testsrc2=s=160x90:r=25:d=2",
      "-f", "lavfi", "-i", "aevalsrc=0.1*sin(2*PI*1000*t)|0.1*sin(2*PI*1000*t):s=48000:d=2",
      "-f", "lavfi", "-i", "aevalsrc=0.1*sin(2*PI*500*t):s=44100:d=2",
      "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "ffv1", "-c:a", "pcm_s16le",
    ]);
    // 2 s of picture ending in 1 s of black, 4 s of sound: the container says 4 s
    make("longaudio.mov", [
      "-f", "lavfi", "-i", "testsrc2=s=160x90:r=25:d=1",
      "-f", "lavfi", "-i", "color=black:s=160x90:r=25:d=1",
      "-f", "lavfi", "-i", "aevalsrc=0.1*sin(2*PI*1000*t):s=48000:d=4",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1,format=yuv420p[v]", "-map", "[v]", "-map", "2:a", "-c:v", "ffv1", "-c:a", "pcm_s16le",
    ]);
    // 8 s of moving picture, cut to a third of its bytes (a render that stopped / an incomplete copy)
    for (const n of ["trunc.mkv", "trunc.mp4"]) {
      make(n, ["-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=8", "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-pix_fmt", "yuv420p", ...(n.endsWith(".mp4") ? ["-movflags", "+faststart"] : [])]);
      truncateSync(file(n), Math.floor(statSync(file(n)).size / 3));
    }
    // a name that starts with "-" and looks like an option
    make("-i x.mkv", ["-f", "lavfi", "-i", "testsrc2=s=160x90:r=25:d=1", "-c:v", "ffv1"]);
    make("redflash.mkv", ["-f", "lavfi", "-i", "color=black:s=160x90:r=20:d=2,format=gbrp,geq=r='if(mod(N,2),255,127)':g='if(mod(N,2),0,127)':b='if(mod(N,2),0,127)'", "-pix_fmt", "yuv444p", "-c:v", "ffv1"]);
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the file properties and compares them", async () => {
    const ok = await checkFile(file("props.mov"), loadSpec({
      video: { width: 320, height: 180, frameRate: 29.97, codec: ["prores"], container: ["mov"], bitDepth: 10, chromaSubsampling: ["4:2:2"], alpha: false, colorPrimaries: "bt709", colorMatrix: "bt709", colorRange: "limited", duration: 2, durationToleranceFrames: 1 },
      audio: { sampleRate: 48000, channels: 2, required: true, integratedLUFS: -20, toleranceLU: 0.5, maxTruePeakDBTP: -19 },
    }), { ffmpeg: ff! });
    expect(ok.findings).toEqual([]);
    expect(ok.probe).toMatchObject({ container: "mov", video: { codec: "prores (HQ)", size: "320x180", bitDepth: 10, chroma: "4:2:2", alpha: false, frameRateExact: "30000/1001" }, audio: [{ sampleRate: 48000, channels: 2 }] });
    expect(ok.ran).toEqual(["video properties", "audio properties", "loudness"]);

    const bad = await checkFile(file("props.mov"), loadSpec({ video: { frameRate: 25, codec: ["h264"], bitDepth: 8, chromaSubsampling: ["4:2:0"] }, audio: { channels: 6, integratedLUFS: -23 } }), { ffmpeg: ff! });
    expect(checks(bad.findings)).toEqual(["file.codec", "file.frameRate", "file.bitDepth", "file.chroma", "file.audio", "loudness"]);
  });

  it("legal range in 8-bit and 10-bit files", async () => {
    const r8 = await checkFile(file("legal8.mkv"), loadSpec({ legalRange: { luma: { min: 16, max: 235 }, maxOutOfRangePercent: 10 } }), { ffmpeg: ff! });
    expect(checks(r8.findings)).toEqual(["legalRange"]);
    expect(r8.findings[0].message).toMatch(/50% of pixels have luma outside 16-235 \(luma 128-250 in that frame\)/);
    expect(r8.findings[0].at).toEqual([0, 1]);
    const lenient = await checkFile(file("legal8.mkv"), loadSpec({ legalRange: { luma: { min: 16, max: 235 }, maxOutOfRangePercent: 60 } }), { ffmpeg: ff! });
    expect(lenient.findings).toEqual([]);
    const wide = await checkFile(file("legal8.mkv"), loadSpec({ legalRange: { luma: { min: 0, max: 255 } } }), { ffmpeg: ff! });
    expect(wide.findings).toEqual([]);

    const r10 = await checkFile(file("legal10.mov"), loadSpec({ legalRange: {} }), { ffmpeg: ff! });
    expect(checks(r10.findings)).toEqual(["legalRange"]);
    expect(r10.findings[0].message).toMatch(/10-bit code values, scaled to 8-bit/);
    const pct = Number(/([\d.]+)% of pixels/.exec(r10.findings[0].message)![1]);
    expect(pct).toBeGreaterThan(45);
    expect(pct).toBeLessThan(55);

    const clean = await checkFile(file("clean.mkv"), loadSpec({ legalRange: {} }), { ffmpeg: ff! });
    expect(clean.findings).toEqual([]);
    expect(clean.ran).toEqual(["legalRange"]);
  });

  it("black and frozen sections", async () => {
    const r = await checkFile(file("blackfrozen.mkv"), loadSpec({ black: { maxSeconds: 0.5, allowAtStart: 1 }, frozen: { maxSeconds: 1 } }), { ffmpeg: ff! });
    expect(checks(r.findings)).toEqual(["black", "frozen"]);
    const [black, frozen] = r.findings;
    expect(black.message).toMatch(/at the end/);
    expect((black.at as number[])[0]).toBeCloseTo(6, 1);
    expect((frozen.at as number[])[0]).toBeCloseTo(3, 1);
    expect((frozen.at as number[])[1]).toBeCloseTo(5, 1);
    // without the start allowance the first second fails too
    const strict = await checkFile(file("blackfrozen.mkv"), loadSpec({ black: { maxSeconds: 0.5 } }), { ffmpeg: ff! });
    expect(checks(strict.findings)).toEqual(["black", "black"]);
  });

  it("loudness of an audio-only file; video checks are skipped", async () => {
    const r = await checkFile(file("tone.wav"), loadSpec({ audio: { integratedLUFS: -23, toleranceLU: 0.3, maxTruePeakDBTP: -19.5, maxShortTermLUFS: -22.5 }, black: { maxSeconds: 0 } }), { ffmpeg: ff! });
    expect(r.findings).toEqual([]);
    expect(r.notRun).toEqual([{ check: "black", reason: "the file has no video stream" }]);
    const loud = await checkFile(file("tone.wav"), loadSpec({ audio: { integratedLUFS: -16, maxTruePeakDBTP: -21 } }), { ffmpeg: ff! });
    expect(loud.findings.map((f) => f.message)).toEqual([
      expect.stringMatching(/Integrated loudness is -23\.0 LUFS; the spec wants -16 LUFS/),
      expect.stringMatching(/True peak is -20\.0 dBTP/),
    ]);
  });

  it("flash pre-check: 10 Hz fails, 2 Hz passes, red flashes are found", async () => {
    const spec = loadSpec({ flash: { check: true } });
    const f10 = await checkFile(file("flash10.mkv"), spec, { ffmpeg: ff! });
    expect(checks(f10.findings)).toEqual(["flash"]);
    expect(f10.findings[0].message).toMatch(/not a certified PSE \/ Harding test/);
    expect(f10.findings[0].message).toMatch(/up to 10 per second/);
    const f2 = await checkFile(file("flash2.mkv"), spec, { ffmpeg: ff! });
    expect(checks(f2.findings)).toEqual([]);
    expect(f2.findings[0]).toMatchObject({ severity: "info", check: "flash" });
    const red = await checkFile(file("redflash.mkv"), spec, { ffmpeg: ff! });
    expect(red.findings.filter((f) => f.severity === "fail").map((f) => f.message)).toEqual([expect.stringMatching(/saturated red flashes/)]);
  });

  it("thumbnails at the failing times, in ~/.surehand/ae/tmp", async () => {
    const home = mkdtempSync(join(tmpdir(), "aemcp-home-"));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = process.env.USERPROFILE = home;
    try {
      const r = await checkFile(file("blackfrozen.mkv"), loadSpec({ black: { maxSeconds: 0.5 }, frozen: { maxSeconds: 1 } }), { ffmpeg: ff!, thumbnails: true });
      expect(r.thumbnails).toHaveLength(3);
      // frozen before black (priority), then by time
      expect(r.thumbnails!.map((t) => t.label)).toEqual([expect.stringMatching(/^frozen/), expect.stringMatching(/^black/), expect.stringMatching(/^black/)]);
      for (const t of r.thumbnails!) {
        expect(t.path.startsWith(join(home, ".surehand", "ae", "tmp"))).toBe(true);
        expect([...readFileSync(t.path).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]); // JPEG
      }
    } finally {
      Object.assign(process.env, saved);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a missing or unreadable file is a finding, not an exception", async () => {
    const missing = await checkFile(file("nope.mov"), loadSpec({ video: { width: 1 } }), { ffmpeg: ff! });
    expect(missing.findings[0]).toMatchObject({ check: "file", severity: "fail" });
    const junk = file("junk.mov");
    spawnSync(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(junk)}, "not a movie")`]);
    const r = await checkFile(junk, loadSpec({ video: { width: 1 } }), { ffmpeg: ff! });
    expect(r.findings[0].message).toMatch(/ffprobe could not read the file/);
  });

  it("no audio stream when the spec asks for audio: FAIL (Audio Output off)", async () => {
    const r = await checkFile(file("noaudio.mov"), loadSpec({ audio: { sampleRate: 48000, integratedLUFS: -23 } }), { ffmpeg: ff! });
    expect(r.findings).toEqual([expect.objectContaining({ check: "file.audio", severity: "fail", message: "The file has no audio stream; the spec asks for 48000 Hz, -23 LUFS integrated." })]);
    expect(r.notRun).toBeUndefined();
  });

  it("several audio streams: each is compared; loudness names the one it measured", async () => {
    const r = await checkFile(file("twoaudio.mkv"), loadSpec({ audio: { sampleRate: 48000, integratedLUFS: -20, toleranceLU: 1 } }), { ffmpeg: ff! });
    expect(r.findings.filter((f) => f.severity === "fail").map((f) => f.message)).toEqual(["Audio stream 2 of 2 (#2) sample rate is 44100 Hz; the spec wants 48000 Hz."]);
    expect(r.findings.find((f) => f.severity === "info")?.message).toMatch(/measured on the first \(stream #1\)/);
  });

  it("durations come from the picture: black to its end, and a warning when the sound runs on", async () => {
    const r = await checkFile(file("longaudio.mov"), loadSpec({ video: { duration: 2 }, black: { maxSeconds: 0, allowAtEnd: 1 }, frozen: { maxSeconds: 0.5 } }), { ffmpeg: ff! });
    // the picture is 2 s (the container's 4 s is the audio); its last second is black, which the spec allows
    expect(r.findings.map((f) => `${f.severity}:${f.check}`)).toEqual(["warn:file.duration"]);
    expect(r.findings[0].message).toMatch(/The audio \(4 s\) is longer than the picture \(2 s\)/);
    expect(r.notRun).toBeUndefined();
  });

  it("a truncated file fails: only part of it could be decoded (also when only black is asked for)", async () => {
    for (const n of ["trunc.mkv", "trunc.mp4"]) {
      const r = await checkFile(file(n), loadSpec({ black: { maxSeconds: 1 } }), { ffmpeg: ff! });
      expect(r.findings.find((f) => f.check === "file.decode")?.message, n).toMatch(/^Only [\d.]+ s of 8 s could be decoded \(\d+( of 200)? frames\): the file is truncated or damaged/);
      expect(r.findings.find((f) => f.check === "file.decode")?.severity).toBe("fail");
    }
    const mkv = await checkFile(file("trunc.mkv"), loadSpec({ frozen: { maxSeconds: 1 } }), { ffmpeg: ff! });
    expect(mkv.findings.find((f) => f.check === "file.decode")?.message).toMatch(/^Only [\d.]+ s of 8 s could be decoded/);
  });

  it("a file name that starts with a dash is read as a file", async () => {
    const r = await checkFile(file("-i x.mkv"), loadSpec({ video: { width: 160 }, black: { maxSeconds: 0 } }), { ffmpeg: ff! });
    expect(r.findings).toEqual([]);
    expect(r.ran).toEqual(["video properties", "black"]);
  });

  it("old thumbnails left in ~/.surehand/ae/tmp are swept", async () => {
    const home = mkdtempSync(join(tmpdir(), "aemcp-home-"));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = process.env.USERPROFILE = home;
    try {
      const tmp = join(home, ".surehand", "ae", "tmp");
      mkdirSync(tmp, { recursive: true });
      const old = join(tmp, "preflight-old-1.jpg"), fresh = join(tmp, "preflight-new-1.jpg"), other = join(tmp, "other.jpg");
      for (const p of [old, fresh, other]) writeFileSync(p, "x");
      const twoDays = Date.now() / 1000 - 2 * 86400;
      utimesSync(old, twoDays, twoDays);
      utimesSync(other, twoDays, twoDays);
      await checkFile(file("clean.mkv"), loadSpec({ video: { width: 320 } }), { ffmpeg: ff! });
      expect([existsSync(old), existsSync(fresh), existsSync(other)]).toEqual([false, true, true]);
    } finally {
      Object.assign(process.env, saved);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("a cancel while thumbnails are written leaves none behind", async () => {
    const home = mkdtempSync(join(tmpdir(), "aemcp-home-"));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = process.env.USERPROFILE = home;
    // ffmpeg as it is, except that a thumbnail is written and then the program hangs
    const wrapper = join(home, "ffmpeg");
    writeFileSync(wrapper, `#!/bin/sh\nfor a in "$@"; do last="$a"; done\ncase "$last" in *.jpg) echo partial > "$last"; exec sleep 10;; esac\nexec "${ff!.ffmpeg}" "$@"\n`);
    spawnSync("chmod", ["755", wrapper]);
    try {
      const ac = new AbortController();
      const tmp = join(home, ".surehand", "ae", "tmp");
      const run = checkFile(file("blackfrozen.mkv"), loadSpec({ black: { maxSeconds: 0.5 } }), { ffmpeg: { ...ff!, ffmpeg: wrapper }, thumbnails: true, signal: ac.signal });
      for (let i = 0; i < 200 && !(existsSync(tmp) && readdirSync(tmp).length); i++) await new Promise((r) => setTimeout(r, 25));
      expect(readdirSync(tmp)).toHaveLength(1);
      ac.abort();
      await expect(run).rejects.toMatchObject({ name: "AbortError" });
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      Object.assign(process.env, saved);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("cancels: the ffmpeg process is killed and the check rejects", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(checkFile(file("props.mov"), loadSpec({ flash: { check: true } }), { ffmpeg: ff!, signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
