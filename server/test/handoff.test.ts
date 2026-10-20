// ae_handoff_package end to end without After Effects: the real JSX runs in the fake After Effects project (fake-ae.ts:
// Save As, open, replace, the render queue), the footage is copied on a temporary disk, and a fake aerender (a small
// Node script) renders the queued PNG frames from the saved copies. A temporary HOME: nothing real is touched.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProject, type FakeProjectSpec } from "./fake-ae.js";

let fp: ReturnType<typeof fakeProject>;
let calls: { body: string; args: any; opts: any }[];
vi.mock("../src/jsx.js", async (original) => {
  const real = await original<typeof import("../src/jsx.js")>();
  return {
    ...real,
    runJsx: async (body: string, args: any, opts: any) => {
      calls.push({ body, args, opts });
      return fp.run(body, args ?? {});
    },
  };
});

const { handoff, planPackage, sampleTimes, sequenceFrames, compareFrames } = await import("../src/tools/handoff.js");
const { HANDOFF_SCAN_JSX, HANDOFF_WRITE_JSX } = await import("../src/tools/handoff-jsx.js");
const { encodePng } = await import("../src/png.js");
const FULL = { mode: "full" };
const text = (r: any) => r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
const posix = process.platform !== "win32";

// a fake aerender: renders every queued item of a saved fake project as an 8x4 PNG whose color comes from the bytes of the
// footage its comp uses (so a wrong copy renders differently); FAKE_AERENDER_TINT: projects whose path contains it render
// differently anyway; it stops at missing footage unless -continueOnMissingFootage
const FAKE_AERENDER = `#!/usr/bin/env node
const fs = require("fs"), zlib = require("zlib");
const a = process.argv.slice(2), proj = a[a.indexOf("-project") + 1];
if (process.env.FAKE_AERENDER_LOG) fs.appendFileSync(process.env.FAKE_AERENDER_LOG, JSON.stringify(a) + "\\n");
const p = JSON.parse(fs.readFileSync(proj, "utf8"));
for (const f of p.footage) if (!f.file || !fs.existsSync(f.file)) if (!a.includes("-continueOnMissingFootage")) { console.log("aerender ERROR: footage missing: " + f.name); process.exit(1); }
const T = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const png = (w, h, px) => { const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6; const rows = []; for (let y = 0; y < h; y++) rows.push(Buffer.from([0]), px.subarray(y * w * 4, (y + 1) * w * 4)); return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]); };
for (const r of p.rq) {
  if (!r.render) continue;
  if (!/png/i.test(r.format)) { console.log("aerender ERROR: output is not PNG"); process.exit(1); }
  const comp = p.comps.find((c) => c.id === r.compId);
  let h = 7;
  for (const id of comp.sources) { const f = p.footage.find((x) => x.id === id); if (f && f.file && fs.existsSync(f.file)) for (const b of fs.readFileSync(f.file)) h = (h * 31 + b) >>> 0; }
  if (process.env.FAKE_AERENDER_TINT && proj.includes(process.env.FAKE_AERENDER_TINT)) h ^= 0x3f;
  const frame = Math.round(r.start * r.fps), px = Buffer.alloc(8 * 4 * 4);
  for (let i = 0; i < 32; i++) px.set([h & 255, (h >> 8) & 255, (frame * 20) & 255, 255], i * 4);
  fs.writeFileSync(r.out.replace("[#####]", String(frame).padStart(5, "0")), png(8, 4, px));
  console.log("PROGRESS:  0;00;00;" + frame + " (1): 0 Seconds");
}
`;

let home: string, work: string, pkg: string, aerenderLog: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "surehand-handoff-"));
  process.env.HOME = process.env.USERPROFILE = home;
});
afterAll(() => {
  process.env.HOME = saved.HOME;
  process.env.USERPROFILE = saved.USERPROFILE;
  delete process.env.FAKE_AERENDER_LOG;
  rmSync(home, { recursive: true, force: true });
});

const spec = (o: Partial<FakeProjectSpec> = {}): FakeProjectSpec => ({
  file: join(work, "Spot.aep"),
  appPackage: join(work, "AE", "Adobe After Effects.app"),
  footage: [
    { name: "Hero plate", file: join(work, "media", "plate.mov"), folder: ["Footage", "Plates"] },
    { name: "Burst", file: join(work, "media", "burst", "shot_0001.png"), folder: ["Footage"] },
    { name: "Logo", file: join(work, "media", "logo.png"), still: true },
  ],
  comps: [
    {
      name: "Main", fps: 25, duration: 4,
      layers: [
        { name: "Title", type: "text", font: "Gotham-Bold", expressions: { "Transform/Opacity": { expr: "100" } } },
        { name: "Plate", type: "footage", source: "Hero plate", effects: [{ matchName: "ADBE Gaussian Blur 2", name: "Gaussian Blur" }, { matchName: "VIDEOCOPILOT OpticalFlares", name: "Optical Flares" }] },
        { name: "Burst", type: "footage", source: "Burst" },
        { name: "Logo", type: "footage", source: "Logo" },
      ],
    },
  ],
  rq: [{ comp: "Main", render: true }],
  activeComp: "Main",
  installedEffects: [
    { matchName: "ADBE Gaussian Blur 2", displayName: "Gaussian Blur", category: "Blur & Sharpen", version: "1.2" } as any,
    { matchName: "VIDEOCOPILOT OpticalFlares", displayName: "Optical Flares", category: "Video Copilot", version: "1.3.5" } as any,
  ],
  fonts: [],
  usedFonts: [{ ps: "Gotham-Bold", layers: ["Title"], family: "Gotham", style: "Bold", version: "2.0" }],
  ...o,
});

beforeEach(() => {
  work = mkdtempSync(join(home, "work-"));
  pkg = join(work, "Handoff");
  mkdirSync(join(work, "media", "burst"), { recursive: true });
  writeFileSync(join(work, "Spot.aep"), "the user's project");
  writeFileSync(join(work, "media", "plate.mov"), "plate bytes");
  writeFileSync(join(work, "media", "logo.png"), "logo bytes");
  for (const n of [1, 2, 3]) writeFileSync(join(work, "media", "burst", `shot_000${n}.png`), `frame ${n}`);
  writeFileSync(join(work, "media", "burst", "other_0001.png"), "not this sequence");
  mkdirSync(join(work, "AE"), { recursive: true });
  writeFileSync(join(work, "AE", "aerender"), FAKE_AERENDER);
  chmodSync(join(work, "AE", "aerender"), 0o755);
  aerenderLog = join(work, "aerender.log");
  process.env.FAKE_AERENDER_LOG = aerenderLog;
  delete process.env.FAKE_AERENDER_TINT;
  calls = [];
  fp = fakeProject(spec());
});

const savedJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const aerenderRuns = () => (existsSync(aerenderLog) ? readFileSync(aerenderLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

describe("ae_handoff_package", () => {
  it("both scripts are valid ES3", async () => {
    const { parse } = await import("acorn");
    for (const body of [HANDOFF_SCAN_JSX, HANDOFF_WRITE_JSX]) expect(() => parse(`(function(args, log){${body}\n})`, { ecmaVersion: 3, allowReserved: false })).not.toThrow();
  });

  it("collects the used footage like Collect Files, relinks a copy, writes the manifest, and leaves the user's project alone", async () => {
    const before = statSync(join(work, "Spot.aep"));
    const r = await handoff({ folder: pkg }, FULL);
    expect(r.isError).toBeFalsy();
    const t = text(r);
    expect(t).toMatch(/^Opens clean\. Needs: 1 font \(Gotham-Bold\), plug-in "Optical Flares" \(VIDEOCOPILOT OpticalFlares, version 1\.3\.5\)\./);
    expect(t).toMatch(/Verification: NOT VERIFIED: not requested/);
    expect(t).toMatch(/Your project: unchanged on disk \(same size, date and SHA-256\), open again in After Effects with no unsaved changes; its undo history starts fresh\./);
    // the folders of the Project panel, a sequence in its own folder (only its own frames)
    expect(readFileSync(join(pkg, "(Footage)", "Footage", "Plates", "plate.mov"), "utf8")).toBe("plate bytes");
    expect(readdirSync(join(pkg, "(Footage)", "Footage", "burst")).sort()).toEqual(["shot_0001.png", "shot_0002.png", "shot_0003.png"]);
    expect(existsSync(join(pkg, "(Footage)", "logo.png"))).toBe(true);
    // the package's copy points into the package, with the items' own names (replace() renames them)
    const copy = savedJson(join(pkg, "Spot.aep"));
    expect(copy.footage.map((f: any) => [f.name, f.file])).toEqual([
      ["Hero plate", join(pkg, "(Footage)", "Footage", "Plates", "plate.mov")],
      ["Burst", join(pkg, "(Footage)", "Footage", "burst", "shot_0001.png")],
      ["Logo", join(pkg, "(Footage)", "logo.png")],
    ]);
    // the user's project: never saved, opened again at the end, the open project back as it was, the file untouched
    expect(fp.saves).toEqual([join(pkg, "Spot.aep"), join(pkg, "Spot.aep")]);
    expect(fp.opens).toEqual([join(work, "Spot.aep")]);
    expect(fp.app.project.file.fsName).toBe(join(work, "Spot.aep"));
    expect(fp.app.project.dirty).toBe(false);
    expect(fp.items.filter((i: any) => i.file).map((i: any) => [i.name, i.file.fsName])).toEqual([
      ["Hero plate", join(work, "media", "plate.mov")],
      ["Burst", join(work, "media", "burst", "shot_0001.png")],
      ["Logo", join(work, "media", "logo.png")],
    ]);
    expect(readFileSync(join(work, "Spot.aep"), "utf8")).toBe("the user's project");
    expect(statSync(join(work, "Spot.aep")).mtimeMs).toBe(before.mtimeMs);
    // reading takes no undo step; writing has none either (Save As and open can't be in one)
    expect(calls.map((c) => c.opts.undoGroup)).toEqual([false, false]);

    const m = JSON.parse(readFileSync(join(pkg, "handoff.json"), "utf8"));
    expect(m).toMatchObject({ surehandHandoff: 1, opensClean: true, problems: [], afterEffects: { version: "25.0.0" }, project: { bitsPerChannel: 16, expressionEngine: "javascript-1.0" } });
    expect(m.project.color).toEqual({ bitsPerChannel: 16, colorManagementSystem: 0, workingSpace: "Rec.709 Gamma 2.4", linearBlending: true, linearizeWorkingSpace: false });
    expect(t).toMatch(/Color: colorManagementSystem Adobe, workingSpace "Rec.709 Gamma 2.4", linearBlending true, linearizeWorkingSpace false\./);
    expect(m.fonts).toEqual([{ postScriptName: "Gotham-Bold", family: "Gotham", style: "Bold", version: "2.0", here: "installed", uses: 1, usedBy: ["Main > Title"] }]);
    expect(m.effects).toEqual([
      { matchName: "ADBE Gaussian Blur 2", displayName: "Gaussian Blur", category: "Blur & Sharpen", version: "1.2", vendor: "Adobe", installedHere: true, instances: 1, usedBy: ["Main > Plate"] },
      { matchName: "VIDEOCOPILOT OpticalFlares", displayName: "Optical Flares", category: "Video Copilot", version: "1.3.5", vendor: "third party", installedHere: true, instances: 1, usedBy: ["Main > Plate"] },
    ]);
    expect(m.footage.map((f: any) => [f.name, f.kind, f.status, f.packaged, f.files])).toEqual([
      ["Hero plate", "file", "collected", "(Footage)/Footage/Plates/plate.mov", 1],
      ["Burst", "sequence", "collected", "(Footage)/Footage/burst", 3],
      ["Logo", "file", "collected", "(Footage)/logo.png", 1],
    ]);
    expect(m.verification.verdict).toBe("NOT VERIFIED");
    // the size counts every file of the package, the manifest included
    const all = (d: string): number => readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? all(join(d, e.name)) : statSync(join(d, e.name)).size), 0);
    expect(m.package.totalBytes).toBe(all(pkg));
    expect(readFileSync(join(pkg, "HANDOFF.txt"), "utf8")).toBe(t);
    expect(t).toMatch(/Gotham-Bold \(Gotham Bold\), version 2\.0: Main > Title/);
    expect(t).toMatch(/Optical Flares \[VIDEOCOPILOT OpticalFlares\], third party, version 1\.3\.5: 1 instance \(Main > Plate\)/);
  });

  it("refuses a project with unsaved changes, or one never saved, before writing anything", async () => {
    fp = fakeProject(spec({ dirty: true }));
    const r = await handoff({ folder: pkg }, FULL);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/unsaved changes\. Nothing was written/);
    expect(existsSync(pkg)).toBe(false);
    expect(fp.saves).toEqual([]);
  });

  it("never replaces existing package files without overwrite, and never writes over the project or its footage", async () => {
    mkdirSync(join(pkg, "(Footage)"), { recursive: true });
    writeFileSync(join(pkg, "(Footage)", "logo.png"), "someone else's logo");
    const r = await handoff({ folder: pkg }, FULL);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/already has 1 file the package would write \(\(Footage\)[\\/]logo\.png\)\. Nothing was written\. Pass overwrite: true/);
    expect(readFileSync(join(pkg, "(Footage)", "logo.png"), "utf8")).toBe("someone else's logo");
    expect(fp.saves).toEqual([]);

    const ok = await handoff({ folder: pkg, overwrite: true }, FULL);
    expect(ok.isError).toBeFalsy();
    expect(readFileSync(join(pkg, "(Footage)", "logo.png"), "utf8")).toBe("logo bytes");

    // the project's own folder: the package's project would be the user's project
    const own = await handoff({ folder: work, overwrite: true }, FULL);
    expect(own.isError).toBe(true);
    expect(text(own)).toMatch(/would be written over your project/);
    expect(readFileSync(join(work, "Spot.aep"), "utf8")).toBe("the user's project");
  });

  it("says what doesn't open clean: missing and unused footage, missing fonts and plug-ins, expression errors; reduce leaves unused items out", async () => {
    const base = spec();
    fp = fakeProject({
      ...base,
      footage: [...base.footage!, { name: "Old cut", file: join(work, "media", "plate.mov") }, { name: "Gone", file: join(work, "media", "gone.mov"), missing: true }],
      comps: [{ ...base.comps[0], layers: [...base.comps[0].layers, { name: "Gone", type: "footage", source: "Gone", expressions: { "Transform/Opacity": { expr: "thisComp.layer('X')", error: "layer named 'X' is missing" } } }, { name: "Glow", effects: [{ matchName: "RG Universe Glow", name: "Glow" }] }] }],
      fonts: [{ postScriptName: "Gotham-Bold", familyName: "Gotham", styleName: "Bold", isSubstitute: false }],
    });
    const r = await handoff({ folder: pkg }, FULL);
    const t = text(r);
    expect(t).toMatch(/^Does not open clean: 1 footage item missing \("Gone"\); 1 unused footage item not collected, which will show as missing \("Old cut"\): pass reduce: true/);
    expect(t).toMatch(/1 font missing or substituted here \(Gotham-Bold\); 1 plug-in not installed here \(RG Universe Glow\); 1 expression error \(Main > Gone > Transform\/Opacity: layer named 'X' is missing\)/);
    expect(t).toMatch(/Gotham-Bold \(Gotham Bold\), version 2\.0, MISSING HERE/);
    const m = JSON.parse(readFileSync(join(pkg, "handoff.json"), "utf8"));
    expect(m.missing).toEqual({ footage: ["Gone"], placeholders: [], fonts: ["Gotham-Bold"], effects: ["RG Universe Glow"] });
    expect(m.footage.find((f: any) => f.name === "Old cut").status).toBe("not collected (unused)");
    expect(m.footage.find((f: any) => f.name === "Gone")).toMatchObject({ status: "missing", source: join(work, "media", "gone.mov"), packaged: null });

    fp = fakeProject({ ...base, footage: [...base.footage!, { name: "Old cut", file: join(work, "media", "plate.mov") }] });
    const reduced = await handoff({ folder: join(work, "Reduced"), reduce: true }, FULL);
    expect(text(reduced)).toMatch(/^Opens clean\./);
    expect(savedJson(join(work, "Reduced", "Spot.aep")).footage.map((f: any) => f.name)).toEqual(["Hero plate", "Burst", "Logo"]);
    expect(JSON.parse(readFileSync(join(work, "Reduced", "handoff.json"), "utf8")).footage.find((f: any) => f.name === "Old cut").status).toBe("removed (unused, reduce)");
    // and the user's project still has it
    expect(fp.items.some((i: any) => i.name === "Old cut")).toBe(true);
  });

  it.skipIf(!posix)("verify: aerender renders the same frames from a copy of the project and from the package: IDENTICAL", async () => {
    const r = await handoff({ folder: pkg, verify: true, frames: 3 }, FULL);
    expect(r.isError).toBeFalsy();
    const t = text(r);
    expect(t).toMatch(/^Opens clean\. Needs:/);
    expect(t).toMatch(/Verification: IDENTICAL: all 3 sample frames \(1 comp\) are bit-identical from the package and from your project\./);
    expect(t).toMatch(/"Main" at 0s \(f0\): identical\n {2}"Main" at 2s \(f50\): identical\n {2}"Main" at 3\.96s \(f99\): identical/);
    // two separate aerender runs, one per copy; the user's queued render never runs
    const runs = aerenderRuns();
    expect(runs.map((a: string[]) => a[a.indexOf("-project") + 1].split(/[\\/]/).pop())).toEqual(["reference.aep", "package.aep"]);
    // the order of copies: reference, back to the project, the package, its verification copy, back to the project
    expect(fp.saves.map((p) => p.split(/[\\/]/).pop())).toEqual(["reference.aep", "reference.aep", "Spot.aep", "Spot.aep", "package.aep"]);
    expect(fp.opens).toEqual([join(work, "Spot.aep"), join(work, "Spot.aep")]);
    // the user's render queue is as it was; the package's copy keeps it too (only the verification copies are emptied)
    expect(fp.rq().map((q: any) => [q.comp.name, q.render, q.om.file?.fsName])).toEqual([["Main", true, "/renders/Main.mov"]]);
    expect(savedJson(join(pkg, "Spot.aep")).rq).toEqual([expect.objectContaining({ comp: "Main", out: "/renders/Main.mov" })]);
    // the temporary copies and frames are removed
    expect(readdirSync(join(home, ".surehand", "ae", "tmp"))).toEqual([]);
    const m = JSON.parse(readFileSync(join(pkg, "handoff.json"), "utf8"));
    expect(m.verification).toMatchObject({ verdict: "IDENTICAL", method: expect.stringMatching(/^aerender/) });
    expect(m.verification.frames).toHaveLength(3);
  });

  it.skipIf(!posix)("verify: a package that renders differently is DIFFERS, with a difference image", async () => {
    process.env.FAKE_AERENDER_TINT = "package.aep";
    const r = await handoff({ folder: pkg, verify: true, frames: 2 }, FULL);
    const t = text(r);
    expect(t).toMatch(/^Does not open clean: the package renders differently from your project/);
    expect(t).toMatch(/Verification: DIFFERS in 2 of 2 frames \(default|tolerance 0\.5/);
    expect(r.content.some((c: any) => c.type === "image")).toBe(true);
  });

  it.skipIf(!posix)("verify: what can't be proven is NOT VERIFIED, with the reason", async () => {
    fp = fakeProject(spec({ appPackage: join(work, "nowhere", "AE.app") }));
    let t = text(await handoff({ folder: join(work, "A"), verify: true }, FULL));
    expect(t).toMatch(/Verification: NOT VERIFIED: aerender was not found next to .*nowhere/);
    expect(t).toMatch(/Not verified:\n {2}- rendering: aerender was not found/);

    fp = fakeProject(spec({ png: "none" }));
    t = text(await handoff({ folder: join(work, "B"), verify: true }, FULL));
    expect(t).toMatch(/Verification: NOT VERIFIED: After Effects could not set a PNG output module/);
    expect(aerenderRuns()).toEqual([]);

    // a PNG output module only by its template: still proven
    fp = fakeProject(spec({ png: "template" }));
    t = text(await handoff({ folder: join(work, "C"), verify: true, frames: 1 }, FULL));
    expect(t).toMatch(/Verification: IDENTICAL: all 1 sample frames/);

    // footage missing in the user's project: aerender would stop, so both renders continue past it, and say so
    const base = spec();
    fp = fakeProject({ ...base, footage: [...base.footage!, { name: "Gone", file: join(work, "media", "gone.mov"), missing: true }], comps: [{ ...base.comps[0], layers: [...base.comps[0].layers, { name: "Gone", type: "footage", source: "Gone" }] }] });
    t = text(await handoff({ folder: join(work, "D"), verify: true, frames: 1 }, FULL));
    expect(t).toMatch(/Missing footage renders as color bars in both renders/);
    expect(aerenderRuns().slice(-2).every((a: string[]) => a.includes("-continueOnMissingFootage"))).toBe(true);
  });

  it("read-only mode refuses; ask mode asks once, before anything is written", async () => {
    const ro = await handoff({ folder: pkg }, { mode: "read-only" });
    expect(ro.isError).toBe(true);
    expect(calls).toEqual([]);
    await handoff({ folder: pkg }, { mode: "ask" });
    expect(calls[0].opts.bridge.approval.summary).toMatch(/^Collect the project and its footage into .*Handoff/);
    expect(calls[1].opts.bridge).toBeUndefined();
  });

  it("a verify comp that isn't there is refused before anything is written", async () => {
    const r = await handoff({ folder: pkg, verify: true, verifyComps: ["Nope"] }, FULL);
    expect(text(r)).toMatch(/No comp "Nope" in the project\. Nothing was written\./);
    expect(existsSync(pkg)).toBe(false);
  });
});

describe("planning and comparing", () => {
  it("two different files with one name get ' 2'; one file used twice is copied once; sequences keep only their own frames", () => {
    mkdirSync(join(work, "other"), { recursive: true });
    writeFileSync(join(work, "other", "plate.mov"), "another plate");
    const scan: any = {
      file: join(work, "Spot.aep"),
      footage: [
        { id: 1, name: "A", kind: "file", folder: [], used: 1, file: join(work, "media", "plate.mov") },
        { id: 2, name: "B", kind: "file", folder: [], used: 1, file: join(work, "other", "plate.mov") },
        { id: 3, name: "C", kind: "file", folder: [], used: 2, file: join(work, "media", "plate.mov") },
        { id: 4, name: "Unused", kind: "file", folder: [], used: 0, file: join(work, "media", "logo.png") },
        { id: 5, name: "Solid", kind: "solid", folder: [], used: 1 },
      ],
    };
    const plan = planPackage(scan, pkg, "used");
    expect(plan.items.map((i) => [i.name, i.rel])).toEqual([
      ["A", join("(Footage)", "plate.mov")],
      ["B", join("(Footage)", "plate 2.mov")],
      ["C", join("(Footage)", "plate.mov")],
    ]);
    expect(plan.jobs).toHaveLength(2);
    expect(plan.skipped.map(([f, why]) => [f.name, why])).toEqual([["Unused", "unused"]]);
    expect(planPackage(scan, pkg, "all").items.map((i) => i.name)).toContain("Unused");
    expect(sequenceFrames(join(work, "media", "burst", "shot_0002.png")).map((p) => p.split(/[\\/]/).pop())).toEqual(["shot_0001.png", "shot_0002.png", "shot_0003.png"]);
  });

  it("sample times are whole frames over the work area", () => {
    expect(sampleTimes({ fps: 25, dur: 4, was: 1, wad: 2 }, 3)).toEqual([1, 2, 2.96]);
    expect(sampleTimes({ fps: 25, dur: 4, was: 0, wad: 4 }, 1)).toEqual([0]);
  });

  it("a frame missing on one side is not compared, and says which", () => {
    const d = (n: string) => mkdtempSync(join(work, n));
    const a = d("a"), b = d("b"), px = new Uint8Array(4 * 4 * 4).fill(200);
    writeFileSync(join(a, "frame_00000.png"), encodePng(4, 4, px, 4));
    const r = compareFrames([{ comp: "Main", compId: 1, time: 0, fps: 25, ref: a, col: b }], 0.5);
    expect(r.frames[0]).toMatchObject({ result: "not compared", detail: "no frame from the package" });
    expect(r.unread).toEqual(['"Main" at 0s (f0)']);
  });
});
