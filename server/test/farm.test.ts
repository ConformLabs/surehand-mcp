// ae_farm without After Effects or a real aerender: the scan JSX runs in the fake After Effects project (fake-ae.ts),
// a fake aerender (a small Node script) writes the frames or movie parts of the chunk it is given, and fake ffprobe /
// ffmpeg read and join those "movies" (JSON files). A temporary HOME: nothing real is touched.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProject, type FakeProjectSpec } from "./fake-ae.js";

let fp: ReturnType<typeof fakeProject>;
vi.mock("../src/jsx.js", async (original) => {
  const real = await original<typeof import("../src/jsx.js")>();
  return { ...real, runJsx: async (body: string, args: any) => fp.run(body, args ?? {}) };
});

const { farm, farmRuns, existingOutputs } = await import("../src/tools/farm.js");
const { FARM_SCAN_JSX, FARM_CHECK_JSX } = await import("../src/farm/jsx.js");
const { splitFrames, buildPlan, planScripts, joinSafety, commandLine, aerenderArgs, maxLocalProcesses, frameCost, PlanRefusal } = await import("../src/farm/plan.js");
const { itemFrames, outputInfo, buildManifest, reachOf } = await import("../src/farm/manifest.js");
const { classifyPath, parseMountOutput, parseNetUse, mapPath, shQuote, batQuote, plistVersion, exeVersion, readAeInstall, defaultAerender } = await import("../src/farm/paths.js");
const { postScriptNames, indexFonts } = await import("../src/farm/fonts.js");
const { findMatchNames } = await import("../src/farm/plugins.js");
const { checkManifest } = await import("../src/farm/check.js");
const { verifySequence, imageFileState, compareProof } = await import("../src/farm/verify.js");
const { footageSequence } = await import("../src/farm/seq.js");
const { farmCommand } = await import("../src/cli/farm.js");
const { parseProgress, renderJobs } = await import("../src/tools/renderjobs.js");
const { encodePng } = await import("../src/png.js");
const { resetConfigCache } = await import("../src/config.js");

const text = (r: any) => r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
const posix = process.platform !== "win32";

// ---------- fakes ----------

// writes the frames -s..-e of the render queue item (-rqindex) into its output ([####] = the frame number), or one
// "movie" (a JSON file ffprobe below reads) for a movie format; FAKE_SKIP / FAKE_TRUNC: frames left out / cut off
const FAKE_AERENDER = `#!/usr/bin/env node
const fs = require("fs"), zlib = require("zlib"), path = require("path");
const a = process.argv.slice(2), arg = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
if (process.env.FAKE_AERENDER_LOG) fs.appendFileSync(process.env.FAKE_AERENDER_LOG, JSON.stringify(a) + "\\n");
const p = JSON.parse(fs.readFileSync(arg("-project"), "utf8")), rq = p.rq[Number(arg("-rqindex")) - 1];
const s = Number(arg("-s")), e = Number(arg("-e")), out = arg("-output") || rq.out;
const skip = (process.env.FAKE_SKIP || "").split(",").filter(Boolean).map(Number), trunc = (process.env.FAKE_TRUNC || "").split(",").filter(Boolean).map(Number);
const T = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const png = (v) => { const ih = Buffer.alloc(13); ih.writeUInt32BE(4, 0); ih.writeUInt32BE(2, 4); ih[8] = 8; ih[9] = 2; const rows = []; for (let y = 0; y < 2; y++) rows.push(Buffer.from([0]), Buffer.alloc(12, v)); return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]); };
fs.mkdirSync(path.dirname(out), { recursive: true });
if (/\\[#+\\]/.test(out)) {
  for (let f = s; f <= e; f++) {
    if (skip.includes(f)) continue;
    const name = out.replace(/\\[(#+)\\]/, (m, h) => String(f).padStart(h.length, "0"));
    const b = png(f & 255);
    fs.writeFileSync(name, trunc.includes(f) ? b.subarray(0, b.length - 12) : b);
    console.log("PROGRESS:  0;00;00;" + f + " (" + (f - s + 1) + "): 2 Seconds");
  }
} else {
  fs.writeFileSync(out, JSON.stringify({ fakeMovie: 1, frames: e - s + 1 - skip.length, codec: process.env.FAKE_CODEC || "prores", width: 1920, height: 1080, fps: rq.fps, audio: process.env.FAKE_AUDIO || null }));
  console.log("PROGRESS:  0;00;00;" + e + " (" + (e - s + 1) + "): 1 Seconds");
}
`;
const FAKE_FFPROBE = `#!/usr/bin/env node
const fs = require("fs"); const a = process.argv.slice(2); const f = a[a.indexOf("-i") + 1].replace(/^file:/, "");
let m; try { m = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { console.error(f + ": Invalid data found when processing input"); process.exit(1); }
const streams = [{ index: 0, codec_type: "video", codec_name: m.codec, width: m.width, height: m.height, r_frame_rate: m.fps + "/1", nb_read_packets: String(m.frames) }];
if (m.audio) streams.push({ index: 1, codec_type: "audio", codec_name: m.audio, sample_rate: "48000" });
console.log(JSON.stringify({ streams, format: { duration: String(m.frames / m.fps) } }));
`;
const FAKE_FFMPEG = `#!/usr/bin/env node
const fs = require("fs"); const a = process.argv.slice(2); const out = a[a.length - 1];
if (a.includes("-n") && fs.existsSync(out)) { console.error("File '" + out + "' already exists. Exiting."); process.exit(1); }
const list = a[a.indexOf("-i") + 1];
const parts = fs.readFileSync(list, "utf8").trim().split("\\n").map((l) => JSON.parse(fs.readFileSync(l.replace(/^file '/, "").replace(/'$/, "").replace(/'\\\\''/g, "'"), "utf8")));
fs.writeFileSync(out, JSON.stringify({ ...parts[0], frames: parts.reduce((n, p) => n + p.frames, 0) }));
`;

let home: string, work: string, aerenderLog: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CONFIG: process.env.SUREHAND_AE_CONFIG };
const exe = (p: string, body: string) => {
  writeFileSync(p, body);
  chmodSync(p, 0o755);
};
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "surehand-farm-"));
  process.env.HOME = process.env.USERPROFILE = home;
  delete process.env.SUREHAND_AE_CONFIG;
  mkdirSync(join(home, "bin"), { recursive: true });
  exe(join(home, "bin", "ffprobe"), FAKE_FFPROBE);
  exe(join(home, "bin", "ffmpeg"), FAKE_FFMPEG);
  mkdirSync(join(home, ".surehand", "ae"), { recursive: true });
  writeFileSync(join(home, ".surehand", "ae", "config.json"), JSON.stringify({ ffmpegPath: join(home, "bin", "ffmpeg"), ffprobePath: join(home, "bin", "ffprobe") }));
  resetConfigCache();
});
afterAll(() => {
  process.env.HOME = saved.HOME;
  process.env.USERPROFILE = saved.USERPROFILE;
  if (saved.CONFIG !== undefined) process.env.SUREHAND_AE_CONFIG = saved.CONFIG;
  for (const k of ["FAKE_AERENDER_LOG", "FAKE_SKIP", "FAKE_TRUNC", "FAKE_CODEC", "FAKE_AUDIO"]) delete process.env[k];
  resetConfigCache();
  rmSync(home, { recursive: true, force: true });
});

const spec = (o: Partial<FakeProjectSpec> = {}): FakeProjectSpec => ({
  file: join(work, "Spot.aep"),
  appPackage: join(work, "AE", "Adobe After Effects 2025.app"),
  footage: [
    { name: "Plate", file: join(work, "media", "plate.mov") },
    { name: "Burst", file: join(work, "media", "burst", "shot_0001.png") },
    { name: "Shared logo", file: join(work, "shared", "logo.png"), still: true },
    { name: "Elsewhere", file: join(work, "media", "elsewhere.mov") },
    { name: "Gone", file: join(work, "media", "gone.mov"), missing: true },
  ],
  comps: [
    { name: "Main", fps: 25, duration: 4, layers: [{ name: "Title", type: "text", font: "Gotham-Bold" }, { name: "Pre", type: "precomp", source: "Pre" }, { name: "Plate", type: "footage", source: "Plate", effects: [{ matchName: "ADBE Gaussian Blur 2", name: "Gaussian Blur" }] }] },
    { name: "Pre", fps: 25, duration: 4, layers: [{ name: "Burst", type: "footage", source: "Burst", effects: [{ matchName: "VIDEOCOPILOT OpticalFlares", name: "Optical Flares" }] }, { name: "Logo", type: "footage", source: "Shared logo" }, { name: "Gone", type: "footage", source: "Gone", enabled: false }] },
    { name: "Other", fps: 25, duration: 2, layers: [{ name: "Other title", type: "text", font: "Futura" }, { name: "Elsewhere", type: "footage", source: "Elsewhere", effects: [{ matchName: "RG Universe Glow", name: "Glow" }] }] },
  ],
  rq: [
    { comp: "Main", render: true, file: join(work, "out", "main_[####].png"), om: { Format: "PNG Sequence", "Use Comp Frame Number": "true", "Starting #": "0" } },
    { comp: "Other", render: false },
  ],
  installedEffects: [
    { matchName: "ADBE Gaussian Blur 2", displayName: "Gaussian Blur", category: "Blur & Sharpen" } as any,
    { matchName: "VIDEOCOPILOT OpticalFlares", displayName: "Optical Flares", category: "Video Copilot", version: "1.3.5" } as any,
  ],
  fonts: [],
  usedFonts: [
    { ps: "Gotham-Bold", layers: ["Title"], family: "Gotham", style: "Bold" },
    { ps: "Futura", layers: ["Other title"], family: "Futura", style: "Medium" },
  ],
  ...o,
});

beforeEach(() => {
  work = mkdtempSync(join(home, "work-"));
  for (const d of ["media/burst", "shared", "out", "AE"]) mkdirSync(join(work, d), { recursive: true });
  writeFileSync(join(work, "media", "plate.mov"), "plate");
  writeFileSync(join(work, "media", "elsewhere.mov"), "elsewhere");
  writeFileSync(join(work, "shared", "logo.png"), "logo");
  for (const n of [1, 2, 4]) writeFileSync(join(work, "media", "burst", `shot_000${n}.png`), `frame ${n}`);
  exe(join(work, "AE", "aerender"), FAKE_AERENDER);
  aerenderLog = join(work, "aerender.log");
  process.env.FAKE_AERENDER_LOG = aerenderLog;
  for (const k of ["FAKE_SKIP", "FAKE_TRUNC", "FAKE_CODEC", "FAKE_AUDIO"]) delete process.env[k];
  fp = fakeProject(spec());
  fp.app.project.save(); // the project on disk, for the fake aerender
});

const aerenderRuns = (): string[][] => (existsSync(aerenderLog) ? readFileSync(aerenderLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
async function waitForRun(id: string) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const run = farmRuns.get(id)!;
    if (run.chunks.every((c: any) => c.job && c.job.status !== "running")) return run;
    if (Date.now() > deadline) throw new Error("the run did not finish");
    await new Promise((r) => setTimeout(r, 50));
  }
}
const runIdOf = (t: string) => /Started run (farm\w+)/.exec(t)![1];

// ---------- pure parts ----------

describe("splitting frames into chunks", () => {
  it("equal parts differ by at most one frame and cover the range exactly", () => {
    const c = splitFrames(0, 99, [1, 1, 1]);
    expect(c.map((x) => [x.first, x.last])).toEqual([[0, 32], [33, 66], [67, 99]]);
    expect(c.reduce((n, x) => n + x.frames, 0)).toBe(100);
    const d = splitFrames(10, 20, [1, 1, 1, 1]);
    expect(d[0].first).toBe(10);
    expect(d[d.length - 1].last).toBe(20);
    for (let i = 1; i < d.length; i++) expect(d[i].first).toBe(d[i - 1].last + 1);
    expect(Math.max(...d.map((x) => x.frames)) - Math.min(...d.map((x) => x.frames))).toBeLessThanOrEqual(1);
  });

  it("one frame is one chunk; fewer frames than chunks gives one frame each, never an empty range", () => {
    expect(splitFrames(5, 5, [1, 1, 1])).toEqual([{ part: 0, first: 5, last: 5, frames: 1 }]);
    const c = splitFrames(0, 1, [1, 1, 1, 1, 1]);
    expect(c.map((x) => [x.first, x.last])).toEqual([[0, 0], [1, 1]]);
    expect(splitFrames(0, -1, [1])).toEqual([]);
  });

  it("weights give faster machines more frames", () => {
    const c = splitFrames(0, 99, [3, 1]);
    expect(c.map((x) => x.frames)).toEqual([75, 25]);
  });

  it("frames of a render queue item: odd frame rates, the work area against the whole comp", () => {
    const ntsc = { comp: { fps: 30000 / 1001, fd: 1001 / 30000 } } as any;
    expect(itemFrames({ ...ntsc, start: 0, dur: (300 * 1001) / 30000 })).toMatchObject({ first: 0, last: 299, count: 300 });
    expect(itemFrames({ ...ntsc, start: (48 * 1001) / 30000, dur: (24 * 1001) / 30000 })).toMatchObject({ first: 48, last: 71, count: 24 });
    const film = { comp: { fps: 24000 / 1001, fd: 1001 / 24000 } } as any;
    expect(itemFrames({ ...film, start: (10 * 1001) / 24000, dur: (1 * 1001) / 24000 })).toMatchObject({ first: 10, last: 10, count: 1 });
    const hfr = { comp: { fps: 60000 / 1001, fd: 1001 / 60000 } } as any;
    expect(itemFrames({ ...hfr, start: 0, dur: 10.01 })).toMatchObject({ count: 600 });
    // the work area (frames 25-74 of a 100-frame comp) is what the item renders, not the comp's length
    expect(itemFrames({ comp: { fps: 25, fd: 0.04 }, start: 1, dur: 2 } as any)).toMatchObject({ first: 25, last: 74, count: 50 });
  });

  it("a sensible maximum of processes from cores and memory", () => {
    expect(maxLocalProcesses(16, 64 * 1024 ** 3).max).toBe(4);
    expect(maxLocalProcesses(32, 16 * 1024 ** 3).max).toBe(2);
    expect(maxLocalProcesses(2, 8 * 1024 ** 3).max).toBe(1);
    expect(maxLocalProcesses(128, 1024 * 1024 ** 3).max).toBe(8);
  });
});

describe("commands and quoting", () => {
  it("aerender's arguments: the item's own settings (-rqindex), the chunk's frames, its own output when given", () => {
    expect(aerenderArgs({ project: "/p.aep", rqIndex: 2, first: 10, last: 19, output: "/o_part01of02.mov", mfr: ["ON", 50] })).toEqual(["-project", "/p.aep", "-rqindex", "2", "-s", "10", "-e", "19", "-output", "/o_part01of02.mov", "-v", "ERRORS_AND_PROGRESS", "-mfr", "ON", "50"]);
  });

  it("macOS: words with spaces or quotes in single quotes", () => {
    expect(shQuote("/Volumes/Jobs/My Spot.aep")).toBe("'/Volumes/Jobs/My Spot.aep'");
    expect(shQuote("/Jobs/Rob's spot.aep")).toBe("'/Jobs/Rob'\\''s spot.aep'");
    expect(shQuote("-rqindex")).toBe("-rqindex");
    expect(commandLine("mac", "/Applications/Adobe After Effects 2025/aerender", ["-project", "/a b.aep", "-s", "0"])).toBe("'/Applications/Adobe After Effects 2025/aerender' -project '/a b.aep' -s 0");
  });

  it("Windows .bat: double quotes, % doubled, & and ^ literal inside quotes; a double quote is refused", () => {
    expect(batQuote("C:\\Program Files\\Adobe\\Adobe After Effects 2025\\Support Files\\aerender.exe")).toBe('"C:\\Program Files\\Adobe\\Adobe After Effects 2025\\Support Files\\aerender.exe"');
    expect(batQuote("D:\\Jobs\\100% & done\\spot.aep")).toBe('"D:\\Jobs\\100%% & done\\spot.aep"');
    expect(batQuote("-rqindex")).toBe("-rqindex");
    expect(() => batQuote('D:\\a"b')).toThrow(/double quote/);
    expect(commandLine("windows", "C:\\AE\\aerender.exe", ["-project", "J:\\My Jobs\\spot.aep", "-s", "0"])).toBe('C:\\AE\\aerender.exe -project "J:\\My Jobs\\spot.aep" -s 0');
  });

  it("default aerender per platform and version", () => {
    expect(defaultAerender("mac", 25)).toBe("/Applications/Adobe After Effects 2025/aerender");
    expect(defaultAerender("windows", 24)).toBe("C:\\Program Files\\Adobe\\Adobe After Effects 2024\\Support Files\\aerender.exe");
    expect(defaultAerender("mac", 18)).toBe("/Applications/Adobe After Effects 2021/aerender");
  });

  it("aerender's progress lines: the frame count and the frame's time", () => {
    expect(parseProgress("PROGRESS:  0;00;00;05 (6): 3 Seconds")).toEqual({ frame: 6, seconds: 3 });
    expect(parseProgress("PROGRESS:  0:00:01:00 (26): 1 Second")).toEqual({ frame: 26, seconds: 1 });
    expect(parseProgress("PROGRESS:  Total Time Elapsed: 2 Seconds")).toBeNull();
  });
});

describe("local or shared paths", () => {
  const mounts = parseMountOutput(
    "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n//ron@nas._smb._tcp.local/Jobs on /Volumes/Jobs (smbfs, nodev, nosuid, mounted by ron)\n/dev/disk5s1 on /Volumes/Raid (apfs, local, nodev, journaled)\nnas:/export on /mnt/nfs type nfs (rw)",
  );
  const mac = { platform: "mac" as const, home: "/Users/ron", mounts, shared: ["/Volumes/Raid/Shared"] };

  it("reads mount and net use", () => {
    expect(mounts.find((m) => m.path === "/Volumes/Jobs")).toMatchObject({ network: true, type: "smbfs" });
    expect(mounts.find((m) => m.path === "/Volumes/Raid")).toMatchObject({ network: false });
    expect(mounts.find((m) => m.path === "/mnt/nfs")).toMatchObject({ network: true });
    expect(parseNetUse("Status       Local     Remote                    Network\n-------------\nOK           Z:        \\\\nas\\Jobs                 Microsoft Windows Network\n")).toEqual([{ path: "Z:", source: "\\\\nas\\Jobs", network: true, type: "smb" }]);
  });

  it("macOS: home and Desktop are local, a share is shared, an attached disk is external, said folders are shared", () => {
    expect(classifyPath("/Users/ron/Desktop/plate.mov", mac)).toMatchObject({ where: "local", why: expect.stringMatching(/home folder.*Desktop/) });
    expect(classifyPath("/Volumes/Jobs/Spot/plate.mov", mac)).toMatchObject({ where: "shared", why: expect.stringMatching(/nas/) });
    expect(classifyPath("/Volumes/Raid/plates/a.mov", mac)).toMatchObject({ where: "external" });
    expect(classifyPath("/Volumes/Raid/Shared/a.mov", mac)).toMatchObject({ where: "shared", why: expect.stringMatching(/you said/) });
    expect(classifyPath("/Volumes/Gone/a.mov", mac)).toMatchObject({ where: "unknown" });
    expect(classifyPath("/Users/other/x.mov", mac).where).toBe("local");
  });

  it("Windows: UNC and mapped drives are shared, C: and other disks are local", () => {
    const win = { platform: "windows" as const, home: "C:\\Users\\ron", mounts: [{ path: "Z:", source: "\\\\nas\\Jobs", network: true }], systemDrive: "C:" };
    expect(classifyPath("\\\\nas\\Jobs\\spot.aep", win).where).toBe("shared");
    expect(classifyPath("Z:\\Spot\\plate.mov", win)).toMatchObject({ where: "shared", why: expect.stringMatching(/nas/) });
    expect(classifyPath("C:\\Users\\ron\\Desktop\\plate.mov", win)).toMatchObject({ where: "local", why: expect.stringMatching(/Desktop/) });
    expect(classifyPath("D:\\Media\\plate.mov", win)).toMatchObject({ where: "local" });
    // a Windows path seen from a Mac can't be told
    expect(classifyPath("E:\\Media\\a.mov", { platform: "mac", home: "/Users/ron" }).where).toBe("unknown");
  });

  it("maps a path the way another machine sees it", () => {
    expect(mapPath("/Volumes/Jobs/Spot/a b.mov", [{ from: "/Volumes/Jobs", to: "J:\\Jobs" }])).toBe("J:\\Jobs\\Spot\\a b.mov");
    expect(mapPath("J:\\Jobs\\Spot\\a.mov", [{ from: "J:\\Jobs", to: "/Volumes/Jobs" }])).toBe("/Volumes/Jobs/Spot/a.mov");
    expect(mapPath("/other/a.mov", [{ from: "/Volumes/Jobs", to: "J:\\Jobs" }])).toBe("/other/a.mov");
  });
});

describe("joining movie chunks", () => {
  const base = { format: "QuickTime", audio: "off" as const, fps: 25, chunkFrames: [50, 50] };
  it("intra-frame codecs join by stream copy; long-GOP codecs don't; unknown is decided after the render", () => {
    expect(joinSafety({ ...base, codec: "Apple ProRes 422 HQ" }).safe).toBe("yes");
    expect(joinSafety({ ...base, codec: "prores" }).safe).toBe("yes");
    expect(joinSafety({ ...base, format: "H.264", codec: null }).safe).toBe("no");
    expect(joinSafety({ ...base, codec: "hevc" }).why.join(" ")).toMatch(/long-GOP/);
    expect(joinSafety({ ...base, codec: null }).safe).toBe("unknown");
  });

  it("audio: AAC never joins cleanly; PCM only where every join falls on a whole sample", () => {
    expect(joinSafety({ ...base, codec: "prores", audio: "on", audioCodec: "aac" }).safe).toBe("no");
    expect(joinSafety({ ...base, codec: "prores", audio: "on", audioCodec: "pcm_s24le", sampleRate: 48000 }).safe).toBe("yes");
    const ntsc = joinSafety({ ...base, fps: 30000 / 1001, chunkFrames: [101, 100], codec: "prores", audio: "on", audioCodec: "pcm_s16le", sampleRate: 48000 });
    expect(ntsc.safe).toBe("no");
    expect(ntsc.why.join(" ")).toMatch(/between audio samples/);
  });
});

// a minimal TrueType font with only a name table (nameID 6 = PostScript name)
function fontFile(ps: string): Buffer {
  const str = Buffer.from(ps, "utf16le").swap16();
  const name = Buffer.alloc(6 + 12 + str.length);
  name.writeUInt16BE(0, 0);
  name.writeUInt16BE(1, 2);
  name.writeUInt16BE(18, 4);
  name.writeUInt16BE(3, 6);
  name.writeUInt16BE(1, 8);
  name.writeUInt16BE(0x409, 10);
  name.writeUInt16BE(6, 12);
  name.writeUInt16BE(str.length, 14);
  name.writeUInt16BE(0, 16);
  str.copy(name, 18);
  const head = Buffer.alloc(12 + 16);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt16BE(1, 4);
  head.write("name", 12, "latin1");
  head.writeUInt32BE(28, 20);
  head.writeUInt32BE(name.length, 24);
  return Buffer.concat([head, name]);
}

describe("fonts, plug-ins and After Effects on disk", () => {
  it("reads PostScript names from TrueType / OpenType files and Type 1 headers", () => {
    const d = mkdtempSync(join(home, "fonts-"));
    writeFileSync(join(d, "Gotham.otf"), fontFile("Gotham-Bold"));
    writeFileSync(join(d, "Old.pfa"), "%!PS-AdobeFont-1.0: Old\n/FontName /OldStyle-Roman def\n");
    writeFileSync(join(d, "broken.ttf"), "nope");
    expect(postScriptNames(join(d, "Gotham.otf"))).toEqual(["Gotham-Bold"]);
    const idx = indexFonts([d]);
    expect([...idx.byName.keys()].sort()).toEqual(["Gotham-Bold", "OldStyle-Roman"]);
    expect(idx).toMatchObject({ files: 3, unreadable: 1 });
  });

  it("finds a plug-in by the match name in its files", () => {
    const d = mkdtempSync(join(home, "plugins-"));
    mkdirSync(join(d, "VC", "Optical Flares.plugin", "Contents", "Resources"), { recursive: true });
    writeFileSync(join(d, "VC", "Optical Flares.plugin", "Contents", "Resources", "OF.rsrc"), Buffer.concat([Buffer.alloc(100), Buffer.from("\u0019VIDEOCOPILOT OpticalFlares", "latin1"), Buffer.alloc(10)]));
    writeFileSync(join(d, "VC", "Preset.ffx"), "RG Universe Glow"); // a preset that names it doesn't count
    const r = findMatchNames([d], ["VIDEOCOPILOT OpticalFlares", "RG Universe Glow"]);
    expect(r.found.get("VIDEOCOPILOT OpticalFlares")).toMatch(/OF\.rsrc$/);
    expect(r.found.get("RG Universe Glow")).toBeNull();
  });

  it("reads the After Effects version from Info.plist (macOS) and AfterFX.exe (Windows)", () => {
    expect(plistVersion("<key>CFBundleShortVersionString</key>\n<string>25.2</string><key>CFBundleVersion</key><string>25.2.0.110</string>")).toBe("25.2.0.110");
    const mac = mkdtempSync(join(home, "ae-mac-"));
    mkdirSync(join(mac, "Adobe After Effects 2025.app", "Contents"), { recursive: true });
    writeFileSync(join(mac, "Adobe After Effects 2025.app", "Contents", "Info.plist"), "<key>CFBundleShortVersionString</key><string>25.2</string>");
    exe(join(mac, "aerender"), "#!/bin/sh\n");
    expect(readAeInstall(mac, "mac")).toMatchObject({ version: "25.2", aerender: join(mac, "aerender") });
    const win = mkdtempSync(join(home, "ae-win-"));
    mkdirSync(join(win, "Support Files"), { recursive: true });
    writeFileSync(join(win, "Support Files", "AfterFX.exe"), Buffer.concat([Buffer.alloc(64), Buffer.from("ProductVersion\u0000\u0000", "utf16le"), Buffer.from("24.6.2.2\u0000", "utf16le")]));
    writeFileSync(join(win, "Support Files", "aerender.exe"), "");
    expect(exeVersion(join(win, "Support Files", "AfterFX.exe"))).toBe("24.6.2.2");
    expect(readAeInstall(win, "windows")).toMatchObject({ version: "24.6.2.2", aerender: join(win, "Support Files", "aerender.exe") });
  });
});

// ---------- the manifest ----------

describe("manifest", () => {
  it("the scan JSX is valid ES3", async () => {
    const { parse } = await import("acorn");
    for (const body of [FARM_SCAN_JSX, FARM_CHECK_JSX]) expect(() => parse(`(function(args, log){${body}\n})`, { ecmaVersion: 3, allowReserved: false })).not.toThrow();
  });

  it("follows the queued item down through its precomps: only what it renders, local versus shared paths, sequence gaps", async () => {
    const r = await farm({ action: "manifest", sharedPaths: [join(work, "shared")] });
    expect(r.isError).toBeFalsy();
    const t = text(r);
    const m = JSON.parse(t.slice(t.indexOf("JSON:\n") + 6));
    expect(m.items.map((i: any) => i.rqIndex)).toEqual([1]);
    expect(m.items[0]).toMatchObject({ comp: { name: "Main", fps: 25 }, frames: { first: 0, last: 99, count: 100 }, comps: ["Main", "Pre"] });
    expect(m.items[0].outputs[0]).toMatchObject({ format: "PNG Sequence", sequence: true, pad: 4, useCompFrameNumber: true, folderExists: true });
    // the other comp (not queued) brings nothing in
    expect(m.footage.map((f: any) => f.name).sort()).toEqual(["Burst", "Gone", "Plate", "Shared logo"]);
    expect(m.plugins.map((p: any) => p.matchName).sort()).toEqual(["ADBE Gaussian Blur 2", "VIDEOCOPILOT OpticalFlares"]);
    expect(m.plugins.find((p: any) => p.matchName === "VIDEOCOPILOT OpticalFlares")).toMatchObject({ vendor: "third party", version: "1.3.5", installedHere: true, comps: ["Pre"], rqItems: [1] });
    expect(m.fonts.map((f: any) => f.postScriptName)).toEqual(["Gotham-Bold"]);
    const burst = m.footage.find((f: any) => f.name === "Burst");
    expect(burst).toMatchObject({ kind: "sequence", exists: true, sequence: { first: 1, last: 4, count: 3, gaps: [[3, 3]] }, location: { where: "local" } });
    expect(m.footage.find((f: any) => f.name === "Shared logo").location.where).toBe("shared");
    // missing footage only on a layer that is off: a warning, not a failure
    expect(m.footage.find((f: any) => f.name === "Gone")).toMatchObject({ exists: false, rendered: false });
    expect(m.problems).toEqual([]);
    expect(m.warnings.join("\n")).toMatch(/footage "Gone" is missing here.*only on layers that are off/);
    expect(m.warnings.join("\n")).toMatch(/"Burst" has gaps \(not on disk: frame 3\)/);
    expect(m.notShared.join("\n")).toMatch(/footage "Plate"/);
    expect(m.notShared.join("\n")).not.toMatch(/Shared logo/);
    expect(t).toMatch(/^Renders on this machine\./);
    expect(t).toMatch(/LOCAL: in your home folder/);
    expect(fp.writes).toEqual([]);
  });

  it("reach per item: a precomp both items use counts for both", () => {
    const scan = { items: [{ index: 1, comp: { id: 1 } }, { index: 2, comp: { id: 2 } }], comps: [{ id: 1, sub: [3] }, { id: 2, sub: [4] }, { id: 4, sub: [3] }, { id: 3, sub: [] }] } as any;
    const reach = reachOf(scan);
    expect([...reach.get(1)!].sort()).toEqual([1, 3]);
    expect([...reach.get(2)!].sort()).toEqual([2, 3, 4]);
  });

  it("chosen items in any status; a not-installed plug-in and a missing font fail here", async () => {
    fp = fakeProject(spec({ fonts: [{ postScriptName: "Futura", familyName: "Futura", styleName: "Medium", isSubstitute: true }] }));
    const r = await farm({ action: "manifest", rqIndex: [2] });
    const t = text(r);
    expect(t).toMatch(/^Does not render here as it is: plug-in RG Universe Glow is not installed here, font Futura is substituted here/);
    const m = JSON.parse(t.slice(t.indexOf("JSON:\n") + 6));
    expect(m.items[0]).toMatchObject({ rqIndex: 2, status: "UNQUEUED" });
    expect(m.footage.map((f: any) => f.name)).toEqual(["Elsewhere"]);
  });

  it("saves next to the project, never over an existing manifest unless asked", async () => {
    const r = await farm({ action: "manifest", save: true });
    expect(text(r)).toMatch(/Saved: .*Spot\.farm-manifest\.json/);
    expect(JSON.parse(readFileSync(join(work, "Spot.farm-manifest.json"), "utf8")).surehandFarmManifest).toBe(1);
    expect(readFileSync(join(work, "Spot.farm-manifest.txt"), "utf8")).toMatch(/^Renders on this machine/);
    const again = await farm({ action: "manifest", save: true });
    expect(again.isError).toBe(true);
    expect(text(again)).toMatch(/exist already\. Nothing was written\. Pass overwrite: true/);
    expect((await farm({ action: "manifest", save: true, overwrite: true })).isError).toBeFalsy();
  });
});

// ---------- check ----------

describe("check", () => {
  async function savedManifest() {
    await farm({ action: "manifest", save: true });
    return join(work, "Spot.farm-manifest.json");
  }

  it("the command line, without After Effects: fonts, plug-ins, footage, aerender and the version from disk", async () => {
    const file = await savedManifest();
    const ae = join(work, "AEInstall");
    mkdirSync(join(ae, "Adobe After Effects 2025.app", "Contents"), { recursive: true });
    writeFileSync(join(ae, "Adobe After Effects 2025.app", "Contents", "Info.plist"), "<key>CFBundleShortVersionString</key><string>25.0.0</string>");
    exe(join(ae, "aerender"), "#!/bin/sh\n");
    const fonts = mkdtempSync(join(home, "nodefonts-"));
    writeFileSync(join(fonts, "Gotham-Bold.otf"), fontFile("Gotham-Bold"));
    const plug = mkdtempSync(join(home, "nodeplug-"));
    writeFileSync(join(plug, "OpticalFlares.aex"), "....VIDEOCOPILOT OpticalFlares....");
    let r = farmCommand(["check", file, "--ae", ae, "--fonts", fonts, "--plugins", plug, "--json"], { systemFonts: false });
    let j = JSON.parse(r.out);
    // footage only on a layer that is off: a warning
    expect(j.lines.filter((l: any) => l.status !== "ok").map((l: any) => [l.status, l.what])).toEqual([["warning", "footage \"Gone\""]]);
    expect(r.code).toBe(0);
    expect(j.verdict).toBe("WARNINGS (1)");
    // a node without the plug-in, the font, a frame of the sequence and the right version
    unlinkSync(join(plug, "OpticalFlares.aex"));
    unlinkSync(join(fonts, "Gotham-Bold.otf"));
    unlinkSync(join(work, "media", "burst", "shot_0002.png"));
    writeFileSync(join(ae, "Adobe After Effects 2025.app", "Contents", "Info.plist"), "<key>CFBundleShortVersionString</key><string>24.6</string>");
    r = farmCommand(["check", file, "--ae", ae, "--fonts", fonts, "--plugins", plug], { systemFonts: false });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^FAIL \(4\)/);
    expect(r.out).toMatch(/\[DIFFERENT\] After Effects: version - 24\.6 here, the project was saved in 25\.0\.0: an older After Effects can't open it/);
    expect(r.out).toMatch(/\[MISSING\] fonts: Gotham-Bold/);
    expect(r.out).toMatch(/\[MISSING\] plug-ins: VIDEOCOPILOT OpticalFlares/);
    expect(r.out).toMatch(/\[DIFFERENT\] files: footage "Burst" - 1 of 3 frames are not here: 2/);
  });

  it("a path map: the node sees the share somewhere else", async () => {
    const file = await savedManifest();
    const m = JSON.parse(readFileSync(file, "utf8"));
    const moved = join(home, "node-mount");
    mkdirSync(moved, { recursive: true });
    rmSync(moved, { recursive: true });
    // the node mounts the whole work folder elsewhere
    const { cpSync } = await import("node:fs");
    cpSync(work, moved, { recursive: true });
    rmSync(join(work, "media"), { recursive: true });
    const r = checkManifest(m, { platform: "mac", home, pathMap: [{ from: work, to: moved }], installs: [{ folder: join(work, "AE"), version: "25.0.0", aerender: join(work, "AE", "aerender") }], fontFolders: [], systemFonts: false, pluginFolders: [] });
    const files = r.lines.filter((l) => l.area === "files");
    expect(files.every((l) => l.status === "ok" || l.status === "warning")).toBe(true);
    expect(files.find((l) => l.what === "project")!.detail).toContain(`(as ${join(moved, "Spot.aep")})`);
  });

  it("the tool asks the running After Effects too, and says when it can't", async () => {
    const file = await savedManifest();
    const t = text(await farm({ action: "check", manifest: file }));
    expect(t).toMatch(/\[ok\] plug-ins: VIDEOCOPILOT OpticalFlares - Optical Flares/);
    expect(t).toMatch(/\[ok\] aerender: aerender/);
    expect(t).toMatch(/\[ok\] After Effects: version - 25\.0\.0/);
    expect((await farm({ action: "check" })).isError).toBe(true);
    const bad = join(work, "bad.json");
    writeFileSync(bad, "{}");
    expect(text(await farm({ action: "check", manifest: bad }))).toMatch(/is not a farm manifest/);
  });

  it("the command line's usage errors", () => {
    expect(farmCommand([]).code).toBe(2);
    expect(farmCommand(["check"]).out).toMatch(/usage: surehand-ae farm check/);
    expect(farmCommand(["check", "x.json", "--map", "nonsense"]).out).toMatch(/--map takes <from>=<to>/);
    expect(JSON.parse(farmCommand(["check", join(work, "none.json"), "--json"]).out)).toMatchObject({ ok: false, error: expect.stringMatching(/can't be read/) });
  });
});

// ---------- plan ----------

const item = (o: any = {}) => ({
  index: 1, status: "QUEUED", comp: { id: 7, name: "Main", w: 1920, h: 1080, par: 1, fps: 25, fd: 0.04, dur: 4, dst: 0, was: 0, wad: 4 }, start: 0, dur: 4,
  rs: { "Frame Rate": "Use comp's frame rate", Resolution: "Full" },
  oms: [{ index: 1, name: "Lossless", file: "/Jobs/out/main_[####].png", settings: { Format: "PNG Sequence", "Use Comp Frame Number": "true" } }],
  ...o,
});
const planIn = (o: any = {}) => ({ item: item(o.item), project: "/Jobs/Spot.aep", aeVersion: "25.0.0", aeApp: "/Applications/Adobe After Effects 2025/Adobe After Effects 2025.app", aerender: "/Applications/Adobe After Effects 2025/aerender", platform: "mac" as const, folder: "/Jobs/Spot farm/rq1", ...o, ...(o.item ? { item: item(o.item) } : {}) });

describe("plan", () => {
  it("sequences: every chunk writes into the same sequence, numbered by comp frame", () => {
    const p = buildPlan(planIn({ processes: 3 }));
    expect(p.kind).toBe("sequence");
    expect(p.chunks.map((c) => [c.first, c.last])).toEqual([[0, 32], [33, 66], [67, 99]]);
    expect(p.chunks[0].args).toEqual(["-project", "/Jobs/Spot.aep", "-rqindex", "1", "-s", "0", "-e", "32", "-v", "ERRORS_AND_PROGRESS", "-mfr", "ON", "33"]);
    expect(p.sequence).toMatchObject({ pad: 4, numbering: "comp frame", firstFile: 0, lastFile: 99 });
  });

  it("refuses what would overwrite or not line up: Starting # numbering, several output modules, the render settings' own frame rate, no [####]", () => {
    expect(() => buildPlan(planIn({ processes: 2, item: { oms: [{ index: 1, name: "x", file: "/o/a_[####].png", settings: { Format: "PNG Sequence", "Use Comp Frame Number": "false", "Starting #": "1" } }] } }))).toThrow(/every chunk would write the same file names.*Use Comp Frame Number/);
    // one chunk is fine
    expect(buildPlan(planIn({ processes: 1, item: { oms: [{ index: 1, name: "x", file: "/o/a_[####].png", settings: { Format: "PNG Sequence", "Use Comp Frame Number": "false", "Starting #": "1" } }] } })).sequence).toMatchObject({ firstFile: 1, lastFile: 100 });
    expect(() => buildPlan(planIn({ item: { oms: [item().oms[0], { index: 2, name: "y", file: "/o/b.mov" }] } }))).toThrow(PlanRefusal);
    expect(() => buildPlan(planIn({ item: { rs: { "Frame Rate": "Use this frame rate", "Use this frame rate": "12" } } }))).toThrow(/their own frame rate \(12 fps/);
    expect(() => buildPlan(planIn({ item: { oms: [{ index: 1, name: "x", file: "/o/a.png", settings: { Format: "PNG Sequence" } }] } }))).toThrow(/no \[####\]/);
  });

  it("the comp's start frame, the work area and padding that is too short", () => {
    const p = buildPlan(planIn({ processes: 2, item: { comp: { ...item().comp, dst: 400, dur: 8 }, start: 2, dur: 4, oms: [{ index: 1, name: "x", file: "/o/a_[##].png", settings: { Format: "PNG Sequence", "Use Comp Frame Number": "true" } }] } }));
    expect(p.frames).toEqual({ first: 50, last: 149, frames: 100 });
    expect(p.chunks.map((c) => [c.first, c.last])).toEqual([[50, 99], [100, 149]]);
    expect(p.sequence).toMatchObject({ firstFile: 10050, lastFile: 10149 });
    expect(p.issues.join("\n")).toMatch(/more digits than the file name's \[##\]/);
  });

  it("movies: a file per chunk and the join, lossless for an intra codec, refused for H.264", () => {
    const mov = buildPlan(planIn({ processes: 2, item: { oms: [{ index: 1, name: "x", file: "/Jobs/out/Main.mov", settings: { Format: "QuickTime", "Video Codec": "Apple ProRes 422 HQ", "Output Audio": "Off" } }] } }));
    expect(mov.kind).toBe("movie");
    expect(mov.movie!.parts).toEqual(["/Jobs/out/Main_part01of02.mov", "/Jobs/out/Main_part02of02.mov"]);
    expect(mov.chunks[1].args).toContain("/Jobs/out/Main_part02of02.mov");
    expect(mov.movie!.join.safe).toBe("yes");
    expect(mov.movie!.command).toEqual(["-hide_banner", "-n", "-f", "concat", "-safe", "0", "-i", "/Jobs/Spot farm/rq1/Main_parts.txt", "-map", "0:v", "-c", "copy", "/Jobs/out/Main.mov"]);
    const h264 = buildPlan(planIn({ processes: 2, item: { oms: [{ index: 1, name: "x", file: "/Jobs/out/Main.mp4", settings: { Format: "H.264" } }] } }));
    expect(h264.movie!.join.safe).toBe("no");
    expect(h264.movie!.command).toBeUndefined();
    expect(h264.issues.join("\n")).toMatch(/can't be joined without loss.*Render an image sequence/);
    // one chunk writes the user's own file
    const one = buildPlan(planIn({ item: { oms: [{ index: 1, name: "x", file: "/Jobs/out/Main.mov", settings: { Format: "QuickTime" } }] } }));
    expect(one.chunks[0].args).not.toContain("-output");
  });

  it("named machines: per-machine scripts with their own aerender and paths, .command and .bat", () => {
    const p = buildPlan(planIn({ machines: [{ name: "mac-studio", weight: 2 }, { name: "Render PC", platform: "windows", pathMap: [{ from: "/Jobs", to: "J:\\Jobs 100%" }] }] }));
    expect(p.chunks.map((c) => [c.machine, c.first, c.last])).toEqual([["mac-studio", 0, 66], ["Render PC", 67, 99]]);
    expect(p.machines[1]).toMatchObject({ platform: "windows", aerender: "C:\\Program Files\\Adobe\\Adobe After Effects 2025\\Support Files\\aerender.exe", project: "J:\\Jobs 100%\\Spot.aep" });
    // the sequence written where that machine sees it
    expect(p.chunks[1].args).toContain("J:\\Jobs 100%\\out\\main_[####].png");
    const files = planScripts(p, "/Jobs/Spot farm/rq1");
    expect(files.map((f) => f.path)).toEqual(["/Jobs/Spot farm/rq1/render_mac-studio.command", "/Jobs/Spot farm/rq1/render_Render_PC.bat"]);
    expect(files[0].text).toMatch(/^#!\/bin\/bash\n/);
    expect(files[0].text).toContain("/Applications/Adobe After Effects 2025/aerender' -project /Jobs/Spot.aep -rqindex 1 -s 0 -e 66");
    expect(files[1].text).toContain('"C:\\Program Files\\Adobe\\Adobe After Effects 2025\\Support Files\\aerender.exe" -project "J:\\Jobs 100%%\\Spot.aep" -rqindex 1 -s 67 -e 99');
    expect(files[1].text).toMatch(/\r\n/);
  });

  it("a Windows machine with two processes: each in its own window, the whole command quoted for cmd /c", () => {
    const p = buildPlan(planIn({ machines: [{ name: "PC", platform: "windows", processes: 2, aerender: "C:\\AE 2025\\aerender.exe", pathMap: [{ from: "/Jobs", to: "J:\\Jobs" }] }] }));
    const bat = planScripts(p, "/Jobs/Spot farm/rq1")[0].text;
    expect(bat).toContain('start "chunk 1 (frames 0-49)" cmd /c ""C:\\AE 2025\\aerender.exe" -project J:\\Jobs\\Spot.aep -rqindex 1 -s 0 -e 49 -output \"J:\\Jobs\\out\\main_[####].png\" -v ERRORS_AND_PROGRESS -mfr ON 50"\r\n');
    expect(bat.split("\r\n").filter((l) => l.startsWith("start ")).length).toBe(2);
  });

  it("several processes on this machine: in parallel in one script; movie parts are never replaced by the script", () => {
    const p = buildPlan(planIn({ processes: 2, item: { oms: [{ index: 1, name: "x", file: "/Jobs/out/Main.mov", settings: { Format: "QuickTime", "Video Codec": "Apple ProRes 4444" } }] } }));
    const files = planScripts(p, "/Jobs/Spot farm/rq1");
    const sh = files.find((f) => f.path.endsWith("render_chunks.command"))!.text;
    expect(sh).toMatch(/if \[ -e \/Jobs\/out\/Main_part01of02\.mov \]; then echo .* exists already: not replacing it\.'; exit 1; fi/);
    expect(sh).toMatch(/> chunk_01\.log 2>&1 &\npids\+=\(\$!\)/);
    expect(files.map((f) => f.path.split("/").pop())).toEqual(["render_chunks.command", "Main_parts.txt", "join_parts.command"]);
    expect(files[1].text).toBe("file '/Jobs/out/Main_part01of02.mov'\nfile '/Jobs/out/Main_part02of02.mov'\n");
  });

  it("the estimate from a render profile's sampled frames", () => {
    const profile = { id: "p1", createdAt: "x", project: "/Jobs/Spot.aep", comp: { id: 7, name: "Main", fps: 25, f0: 0, f1: 99 }, runs: 3, frames: [{ frame: 0, ms: 100 }, { frame: 50, ms: 300 }, { frame: 99, ms: 100 }], slow: [], costs: [], findings: [] } as any;
    expect(frameCost(profile, 20)).toBe(100);
    expect(frameCost(profile, 40)).toBe(300);
    const p = buildPlan(planIn({ processes: 2, profile, profileSource: "profile" }));
    expect(p.estimate).toMatchObject({ source: "profile", profileId: "p1" });
    // frames 0-25 cost 100 ms (the nearest sample), 26-74 300 ms, 75-99 100 ms
    expect(p.estimate.seconds).toBe(20);
    expect(p.chunks[0].estimateSeconds).toBe(9.8);
    expect(p.estimate.note).toMatch(/without aerender's start-up/);
    expect(buildPlan(planIn({})).estimate.source).toBe("none");
  });

  it("the tool writes the plan and its scripts, never over existing ones; dryRun writes nothing", async () => {
    const dry = await farm({ action: "plan", processes: 2, estimate: "none", dryRun: true });
    expect(text(dry)).toMatch(/^Dry run: Render queue item 1 \("Main", frames 0-99, 100 frames\) in 2 chunks for 2 processes on this machine/);
    expect(existsSync(join(work, "Spot farm"))).toBe(false);
    const r = await farm({ action: "plan", processes: 2, estimate: "none" });
    expect(r.isError).toBeFalsy();
    const folder = join(work, "Spot farm", "rq1");
    expect(readdirSync(folder).sort()).toEqual(["farm-plan.json", "render_chunks.command"]);
    expect(text(await farm({ action: "plan", processes: 2, estimate: "none" }))).toMatch(/already has farm-plan\.json, render_chunks\.command\. Nothing was written/);
  });

  it("a stored render profile of this comp gives the estimate", async () => {
    const comp = fp.comps[0];
    mkdirSync(join(home, ".surehand", "ae", "profiles"), { recursive: true });
    writeFileSync(join(home, ".surehand", "ae", "profiles", "20991231-000000000-abcd.json"), JSON.stringify({ id: "20991231-000000000-abcd", createdAt: "now", project: join(work, "Spot.aep"), comp: { id: comp.id, name: "Main", fps: 25, f0: 0, f1: 99 }, runs: 3, frames: [{ frame: 0, ms: 2000 }], slow: [], costs: [], findings: [] }));
    const t = text(await farm({ action: "plan", processes: 2, estimate: "profile", dryRun: true }));
    expect(t).toMatch(/Estimate: about 3\.3 min of rendering in total; about 1\.7 min with the chunks in parallel \(from render profile 20991231-000000000-abcd/);
    rmSync(join(home, ".surehand", "ae", "profiles"), { recursive: true });
  });
});

// ---------- run_local and verify ----------

describe.skipIf(!posix)("run_local and verify (fake aerender)", () => {
  async function planFile(o: any = {}) {
    const r = await farm({ action: "plan", processes: 3, estimate: "none", ...o });
    expect(r.isError).toBeFalsy();
    return join(work, "Spot farm", "rq1", "farm-plan.json");
  }

  it("renders the chunks in parallel as background jobs, then verify proves the sequence complete", async () => {
    const plan = await planFile();
    const r = await farm({ action: "run_local", plan });
    expect(r.isError).toBeFalsy();
    const id = runIdOf(text(r));
    await waitForRun(id);
    expect(aerenderRuns().map((a) => [a[a.indexOf("-s") + 1], a[a.indexOf("-e") + 1]]).sort()).toEqual([["0", "32"], ["33", "66"], ["67", "99"]]);
    const jobs = renderJobs().filter((j) => j.group === id);
    expect(jobs.map((j) => j.status)).toEqual(["done", "done", "done"]);
    expect(jobs[0].frameSeconds.every((s) => s === 2)).toBe(true);
    const st = text(await farm({ action: "status", run: id }));
    expect(st).toMatch(/^Run farm\w+: done\. 100 of 100 frames rendered; 3 of 3 chunks done\./);
    expect(st).toMatch(/1\. frames 0-32: done, 33\/33, 2 s per frame/);
    const v = text(await farm({ action: "verify", plan }));
    expect(v).toMatch(/^PASS: the chunked render of "Main" is complete: 100 frames, every file present once and complete/);
    // the panel's job files
    expect(readdirSync(join(home, ".surehand", "ae", "renders")).some((n) => n === `${jobs[0].id}.json`)).toBe(true);
  });

  it("never renders over existing output unless asked; refuses a plan for other machines", async () => {
    const plan = await planFile();
    writeFileSync(join(work, "out", "main_0050.png"), "old");
    const r = await farm({ action: "run_local", plan });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/1 frame file of this render exist already \(main_0050\.png\)\. Nothing was started\. Pass overwrite: true/);
    expect(aerenderRuns()).toEqual([]);
    const other = await farm({ action: "plan", machines: [{ name: "node1" }], estimate: "none", folder: join(work, "nodes") });
    expect(other.isError).toBeFalsy();
    expect(text(await farm({ action: "run_local", plan: join(work, "nodes", "farm-plan.json") }))).toMatch(/This plan is for node1: run its scripts on those machines/);
  });

  it("refuses a plan made before the project was saved again", async () => {
    const plan = await planFile();
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(work, "Spot.aep"), readFileSync(join(work, "Spot.aep"), "utf8") + " ");
    expect(text(await farm({ action: "run_local", plan }))).toMatch(/saved again after this plan was made.*Plan again/);
  });

  it("verify names the exact missing, cut-off, duplicated and extra frames", async () => {
    const plan = await planFile();
    process.env.FAKE_SKIP = "40,41,42,77";
    process.env.FAKE_TRUNC = "10";
    const id = runIdOf(text(await farm({ action: "run_local", plan })));
    await waitForRun(id);
    writeFileSync(join(work, "out", "main_00012.png"), readFileSync(join(work, "out", "main_0012.png")));
    writeFileSync(join(work, "out", "main_0100.png"), readFileSync(join(work, "out", "main_0012.png"))); // past the last frame
    writeFileSync(join(work, "out", "main_0005.png"), "");
    const v = text(await farm({ action: "verify", plan }));
    expect(v).toMatch(/^FAIL \(5\): the chunked render of "Main" \(frames 0-99\) is not complete\./);
    expect(v).toMatch(/4 frames missing: 40-42, 77/);
    expect(v).toMatch(/1 frame number written twice: main_0012\.png \+ main_00012\.png|1 frame number written twice: main_00012\.png \+ main_0012\.png/);
    expect(v).toMatch(/1 empty \(0-byte\) file: main_0005\.png/);
    expect(v).toMatch(/1 cut-off or damaged file: main_0010\.png \(no IEND at the end\)/);
    expect(v).toMatch(/1 file outside frames 0-99: main_0100\.png/);
    expect(v).toMatch(/To render the missing frames again: .* for frames 40-42, 77/);
  });

  it("movies: a part per chunk, probed; joined by stream copy when it is lossless; the total checked", async () => {
    fp = fakeProject(spec({ rq: [{ comp: "Main", render: true, file: join(work, "out", "Main.mov"), om: { Format: "QuickTime", "Video Codec": "Apple ProRes 422 HQ", "Output Audio": "Off" } }] }));
    fp.app.project.save();
    const plan = await planFile({ processes: 2 });
    expect(readdirSync(join(work, "Spot farm", "rq1")).sort()).toEqual(["Main_parts.txt", "farm-plan.json", "join_parts.command", "render_chunks.command"]);
    const id = runIdOf(text(await farm({ action: "run_local", plan })));
    await waitForRun(id);
    expect(existsSync(join(work, "out", "Main_part01of02.mov"))).toBe(true);
    let v = text(await farm({ action: "verify", plan }));
    expect(v).toMatch(/^PASS/);
    expect(v).toMatch(/Part 1: 50 of 50 frames, prores, 1920x1080/);
    expect(v).toMatch(/the parts are not joined yet/);
    v = text(await farm({ action: "verify", plan, join: true }));
    expect(v).toMatch(/Joined file .*Main\.mov \(joined now\): 100 frames, 1920x1080, 25 fps, prores\./);
    expect(v).toMatch(/^PASS/);
    // the joined file is never replaced
    v = text(await farm({ action: "verify", plan, join: true }));
    expect(v).not.toMatch(/joined now/);
    // a part with a frame short
    writeFileSync(join(work, "out", "Main_part02of02.mov"), JSON.stringify({ fakeMovie: 1, frames: 49, codec: "prores", width: 1920, height: 1080, fps: 25 }));
    expect(text(await farm({ action: "verify", plan }))).toMatch(/part 2 has 49 frames, it should have 50 \(frames 50-99\)/);
  });

  it("movies in a long-GOP codec or with AAC audio are not joined", async () => {
    fp = fakeProject(spec({ rq: [{ comp: "Main", render: true, file: join(work, "out", "Main.mov"), om: { Format: "QuickTime" } }] }));
    fp.app.project.save();
    process.env.FAKE_CODEC = "h264";
    process.env.FAKE_AUDIO = "aac";
    const plan = await planFile({ processes: 2 });
    const id = runIdOf(text(await farm({ action: "run_local", plan })));
    await waitForRun(id);
    const v = text(await farm({ action: "verify", plan, join: true }));
    expect(v).toMatch(/Join: NOT lossless: h264 is a long-GOP codec.*the audio is aac/);
    expect(v).toMatch(/the parts were not joined/);
    expect(existsSync(join(work, "out", "Main.mov"))).toBe(false);
  });

  it("dry run and read-only mode start nothing", async () => {
    const plan = await planFile();
    expect(text(await farm({ action: "run_local", plan, dryRun: true }))).toMatch(/^Dry run: would start 3 aerender processes/);
    expect(aerenderRuns()).toEqual([]);
    expect(existingOutputs(JSON.parse(readFileSync(plan, "utf8")))).toEqual([]);
  });
});

describe("verify on its own", () => {
  it("image files: complete PNG, JPEG end marker, DPX size field", () => {
    const d = mkdtempSync(join(home, "img-"));
    const png = encodePng(2, 2, new Uint8Array(12));
    writeFileSync(join(d, "a.png"), png);
    writeFileSync(join(d, "b.png"), png.subarray(0, png.length - 5));
    writeFileSync(join(d, "c.jpg"), Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]));
    writeFileSync(join(d, "d.jpg"), Buffer.from([0xff, 0xd8, 1, 2, 3]));
    const dpx = Buffer.alloc(2048);
    dpx.write("SDPX", 0, "latin1");
    dpx.writeUInt32BE(2048, 16);
    writeFileSync(join(d, "e.dpx"), dpx);
    writeFileSync(join(d, "f.dpx"), dpx.subarray(0, 1000));
    expect(imageFileState(join(d, "a.png")).state).toBe("ok");
    expect(imageFileState(join(d, "b.png")).state).toBe("truncated");
    expect(imageFileState(join(d, "c.jpg")).state).toBe("ok");
    expect(imageFileState(join(d, "d.jpg")).state).toBe("truncated");
    expect(imageFileState(join(d, "e.dpx")).state).toBe("ok");
    expect(imageFileState(join(d, "f.dpx"))).toMatchObject({ state: "truncated", detail: "1000 bytes, the header says 2048" });
  });

  it("a sequence with every frame: PASS-worthy; footage sequences report their gaps", () => {
    const d = mkdtempSync(join(home, "seq-"));
    const png = encodePng(2, 2, new Uint8Array(12));
    for (let n = 1001; n <= 1010; n++) writeFileSync(join(d, `s_${n}.png`), png);
    const s = verifySequence(join(d, "s_[####].png"), 1001, 1010);
    expect(s).toMatchObject({ present: 10, missing: [], extra: [], duplicates: [], empty: [], truncated: [], checked: "complete" });
    unlinkSync(join(d, "s_1005.png"));
    expect(footageSequence(join(d, "s_1001.png"))).toMatchObject({ first: 1001, last: 1010, count: 9, gaps: [[1005, 1005]] });
    truncateSync(join(d, "s_1006.png"), 10);
    const t = verifySequence(join(d, "s_[####].png"), 1001, 1010);
    expect(t.missing).toEqual([1005]);
    expect(t.truncated.map((x) => x.file)).toEqual(["s_1006.png"]);
  });

  it("the pixel proof: identical, beyond the tolerance, a size that doesn't match, an RGB render against an RGBA local one", () => {
    const d = mkdtempSync(join(home, "proof-"));
    const a = encodePng(2, 1, new Uint8Array([10, 20, 30, 10, 20, 30]));
    const b = encodePng(2, 1, new Uint8Array([10, 20, 30, 90, 20, 30]));
    const c = encodePng(1, 1, new Uint8Array([10, 20, 30]));
    // straight alpha 255 and 0: over black, the second pixel is black
    const rgba = encodePng(2, 1, new Uint8Array([10, 20, 30, 255, 99, 99, 99, 0]), 4);
    const black = encodePng(2, 1, new Uint8Array([10, 20, 30, 0, 0, 0]));
    for (const [n, buf] of Object.entries({ a, b, c, rgba, black })) writeFileSync(join(d, `${n}.png`), buf);
    const r = compareProof(
      [
        { frame: 1, farm: join(d, "a.png"), local: join(d, "a.png") },
        { frame: 2, farm: join(d, "a.png"), local: join(d, "b.png") },
        { frame: 3, farm: join(d, "a.png"), local: join(d, "c.png") },
        { frame: 4, farm: join(d, "black.png"), local: join(d, "rgba.png") },
        { frame: 5, farm: null, local: join(d, "a.png"), why: "the file is not there" },
      ],
      0.5,
    );
    expect(r.map((x) => x.result)).toEqual(["identical", "differs", "not compared", "identical", "not compared"]);
    expect(r[1]).toMatchObject({ maxDiff: 80, detail: "1 px beyond the tolerance" });
    expect(r[2].detail).toMatch(/2x1, the local render 1x1/);
  });
});

describe("manifest building (pure)", () => {
  it("an output module's own settings: format, codec, numbering, audio, resize", () => {
    expect(outputInfo({ index: 1, name: "x", file: "/o/a_[#####].exr", settings: { Format: "OpenEXR Sequence", "Use Comp Frame Number": "false", "Starting #": "1001", "Output Audio": "Off", Resize: "true", "Resize to/x": "960", "Resize to/y": "540" } })).toEqual({
      index: 1, format: "OpenEXR Sequence", codec: null, sequence: true, path: "/o/a_[#####].exr", pad: 5, useCompFrameNumber: false, startingNumber: 1001, audio: "Off", resize: { w: 960, h: 540 },
    });
  });

  it("an unsaved project and an OCIO config outside the project folder", () => {
    const m = buildManifest(
      { file: null, dirty: true, color: { colorManagementSystem: 1, ocioConfigurationFile: "/Users/ron/ocio/aces.ocio", bitsPerChannel: 32 }, mfr: null, rqCount: 0, items: [], comps: [], footage: [], effects: [], layers: 0, fonts: null } as any,
      { platform: "mac", classify: { platform: "mac", home: "/Users/ron" } },
    );
    expect(m.problems.join("\n")).toMatch(/never been saved/);
    expect(m.color).toMatchObject({ management: "OCIO", ocioConfig: { path: "/Users/ron/ocio/aces.ocio", exists: false, insideProjectFolder: false } });
    expect(m.notShared.join("\n")).toMatch(/OCIO config/);
    expect(m.multiFrameRendering.on).toBeNull();
  });
});
