// ae_find_files (Node, real temp folders), ae_export_frames (its ExtendScript on the fake After Effects, and the
// handler with a mocked bridge), and ae_import_files reporting a rejected "import as".
import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jsx = vi.hoisted(() => ({ runJsx: vi.fn() }));
vi.mock("../src/jsx.js", async (orig) => ({ ...(await orig<typeof import("../src/jsx.js")>()), runJsx: jsx.runJsx }));

const { EXPORT_FRAMES_JSX, expandHome, findFiles, globToRegExp, registerFileTools } = await import("../src/tools/files.js");
const { ALL_JSX_TOOLS } = await import("../src/tools/all.js");
const { fakeKeysAE } = await import("./fake-keys.js");
const { FINISH_JSX, RENDER_KIT_JSX } = await import("../src/tools/core.js");

describe("globs", () => {
  const m = (g: string, p: string) => globToRegExp(g).test(p.normalize("NFC").toLowerCase());
  it("**, *, ?, classes, alternatives", () => {
    expect(m("**/*.{mov,mp4}", "a/b/c.MOV".toLowerCase())).toBe(true);
    expect(m("**/*.{mov,mp4}", "c.mp4")).toBe(true);
    expect(m("**/*.{mov,mp4}", "c.mxf")).toBe(false);
    expect(m("shots/*/plate_v[0-9][0-9].exr", "shots/010/plate_v03.exr")).toBe(true);
    expect(m("shots/*/plate_v[0-9][0-9].exr", "shots/010/x/plate_v03.exr")).toBe(false);
    expect(m("[!a]?.png", "b1.png")).toBe(true);
    expect(m("[!a]?.png", "a1.png")).toBe(false);
    expect(m("logo(1).png", "logo(1).png")).toBe(true); // regex characters are literal
  });
  it("~ expands to the home folder", () => {
    expect(expandHome("~/x/y.png", "/Users/me")).toBe(join("/Users/me", "x/y.png"));
    expect(expandHome("/abs/~x")).toBe("/abs/~x");
  });
});

describe("ae_find_files", () => {
  const tree = () => {
    const root = mkdtempSync(join(tmpdir(), "surehand-find-"));
    mkdirSync(join(root, "shots", "010"), { recursive: true });
    mkdirSync(join(root, "deep", "a", "b", "c"), { recursive: true });
    mkdirSync(join(root, ".cache"));
    writeFileSync(join(root, "shots", "010", "plate_v03.exr"), "x");
    writeFileSync(join(root, "shots", "010", "Plate_v04.EXR"), "xy");
    writeFileSync(join(root, "deep", "a", "b", "c", "far.png"), "");
    writeFileSync(join(root, ".cache", "hidden.png"), "");
    writeFileSync(join(root, "Café.mov"), ""); // decomposed (NFD) name, as macOS may store it
    symlinkSync(root, join(root, "shots", "loop")); // a symlink back to the root
    return root;
  };
  it("matches globs case-insensitively below the root, with sizes", () => {
    const root = tree();
    const r = findFiles([root], { pattern: "shots/*/plate_v*.exr" });
    expect(r.results.map((f) => f.path)).toEqual([join(root, "shots", "010", "Plate_v04.EXR"), join(root, "shots", "010", "plate_v03.exr")]);
    expect(r.results[1].size).toBe(1);
  });
  it("a name-only pattern matches at any depth, within maxDepth; hidden only on request", () => {
    const root = tree();
    expect(findFiles([root], { pattern: "*.png" }).results.map((f) => f.path)).toEqual([join(root, "deep", "a", "b", "c", "far.png")]);
    expect(findFiles([root], { pattern: "*.png", maxDepth: 3 }).count).toBe(0);
    expect(findFiles([root], { pattern: "*.png", includeHidden: true }).count).toBe(2);
  });
  it("finds names whatever their Unicode normalisation", () => {
    const root = tree();
    const r = findFiles([root], { pattern: "café.mov" }); // composed (NFC) in the query
    expect(r.count).toBe(1);
    expect(findFiles([root], { nameContains: "CAFÉ" }).count).toBe(1);
  });
  it("never loops through symlinks, and stops at maxResults saying so", () => {
    const root = tree();
    const r = findFiles([root], { pattern: "**/*.exr", maxDepth: 30 });
    expect(r.count).toBe(2);
    expect(r.skippedRepeatFolders).toBeGreaterThan(0);
    const one = findFiles([root], { pattern: "**/*", maxResults: 1 });
    expect(one.count).toBe(1);
    expect(one.stopped).toMatch(/maxResults/);
    expect(findFiles([join(root, "nope")], { pattern: "*" }).missingRoots).toEqual([join(root, "nope")]);
  });
});

describe("ae_export_frames (ExtendScript)", () => {
  const comp = () => fakeKeysAE({ layers: [{ name: "Title" }, { name: "BG" }], footage: [{ name: "clip.mov", width: 3840, height: 2160, fps: 50, duration: 2 }] });
  // what the export's undo puts back (no undo model in this fake): the cleanup FINISH_JSX does by hand
  const cleanup = (ae: ReturnType<typeof comp>, c: unknown) => ae.run(`${RENDER_KIT_JSX}\nreturn cleanNow(args.c);`, { c }).result;
  it("writes several frames with a frame token, at full resolution, only the chosen layers; all of it stays until the files are written", () => {
    const ae = comp();
    const r = ae.run(EXPORT_FRAMES_JSX, { exports: [{ layers: ["Title"], frameRange: { start: 0, end: 20, step: 10 }, outputPath: "/out/title_[###].png" }] });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    // written after the script returned (saveFrameToPng is asynchronous), still with only Title, at full resolution
    expect(ae.saved.map((s) => [s.path, s.t, s.enabled, s.res])).toEqual([
      ["/out/title_000.png", 0, ["Title"], [1, 1]],
      ["/out/title_010.png", 0.4, ["Title"], [1, 1]],
      ["/out/title_020.png", 0.8, ["Title"], [1, 1]],
    ]);
    expect(r.result.passes).toBe(1);
    expect(ae.comp.layer("BG").enabled).toBe(false);
    expect(cleanup(ae, r.result.cleanup)).toEqual(['layer "BG" switched on again', 'resolution of "Main"']);
    expect(ae.comp.layer("BG").enabled).toBe(true);
    expect(ae.comp.resolutionFactor).toEqual([2, 2]);
  });
  it("one comp with different layers shown: a pass each (the frames are written with the project's last state)", () => {
    const ae = comp();
    const exports = [{ layers: ["Title"], frames: [0], outputPath: "/out/t.png" }, { frames: [0], outputPath: "/out/all.png" }, { layers: ["BG"], frames: [0], outputPath: "/out/bg.png" }];
    const p0 = ae.run(EXPORT_FRAMES_JSX, { exports, pass: 0 });
    expect(p0.result).toMatchObject({ passes: 3, files: [{ path: "/out/t.png" }] });
    cleanup(ae, p0.result.cleanup);
    // a later pass doesn't refuse the files of the earlier ones
    for (const pass of [1, 2]) {
      const p = ae.run(EXPORT_FRAMES_JSX, { exports, pass });
      expect(p.ok, JSON.stringify(p.error)).toBe(true);
      expect(p.result.files).toHaveLength(1);
      cleanup(ae, p.result.cleanup);
    }
    expect(ae.saved.map((s) => [s.path, s.enabled])).toEqual([["/out/t.png", ["Title"]], ["/out/all.png", ["Title", "BG"]], ["/out/bg.png", ["BG"]]]);
  });
  it("footage goes through a temporary comp at its own size, removed after the file is written", () => {
    const ae = comp();
    const r = ae.run(EXPORT_FRAMES_JSX, { exports: [{ item: "clip.mov", frames: [99], outputPath: "/out/clip_{frame}.png" }] });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.result.files[0]).toMatchObject({ path: "/out/clip_00099.png", width: 3840, height: 2160, frame: 99 });
    expect(ae.saved.map((s) => s.path)).toEqual(["/out/clip_00099.png"]);
    expect(cleanup(ae, r.result.cleanup)).toContain('temporary comp "__aemcp_export" removed');
    expect(ae.items.some((i: any) => i.name === "__aemcp_export")).toBe(false);
  });
  it("a 32 bpc project with linear blending is written at 16 bpc without it, and set back afterwards", () => {
    const ae = fakeKeysAE({ layers: [{ name: "Title" }], color: { bpc: 32, lb: true } });
    const r = ae.run(EXPORT_FRAMES_JSX, { exports: [{ frames: [0], outputPath: "/out/a.png" }] });
    expect(ae.saved[0].color).toEqual({ bpc: 16, lb: false });
    expect(r.result.cleanup.color).toEqual({ bpc: 32, lb: true });
    expect(cleanup(ae, r.result.cleanup)).toEqual(['resolution of "Main"', "bit depth 32 bpc", "linear blending on"]);
    expect([ae.app.project.bitsPerChannel, ae.app.project.linearBlending]).toEqual([32, true]);
    // an 8 bpc project without linear blending is left alone
    const plain = fakeKeysAE({ layers: [{ name: "Title" }] });
    expect(plain.run(EXPORT_FRAMES_JSX, { exports: [{ frames: [0], outputPath: "/out/b.png" }] }).result.cleanup.color).toBeNull();
    expect(plain.saved[0].color).toEqual({ bpc: 8, lb: false });
  });
  it("refuses before writing anything: existing files, missing frame token, duplicates, frames outside", () => {
    const ae = fakeKeysAE({ layers: [{ name: "a" }], files: ["/out/b.png"] });
    const run = (exports: unknown[], overwrite?: boolean) => ae.run(EXPORT_FRAMES_JSX, { exports, overwrite });
    expect(run([{ frames: [0], outputPath: "/out/a.png" }, { frames: [1], outputPath: "/out/b.png" }]).error.message).toMatch(/already exists at \/out\/b.png\. Nothing was exported.*overwrite: true/);
    expect(run([{ frames: [0, 1], outputPath: "/out/x.png" }]).error.message).toMatch(/needs a frame token/);
    expect(run([{ frames: [0], outputPath: "/out/a.png" }, { frames: [0], outputPath: "/out/a.png" }]).error.message).toMatch(/same file/);
    expect(run([{ frames: [250], outputPath: "/out/z.png" }]).error.message).toMatch(/outside 'Main' \(frames 0-249\)/);
    expect(run([{ frames: [0], outputPath: "/out/z.jpg" }]).error.message).toMatch(/must end in \.png/);
    expect(ae.saved).toEqual([]);
    expect(run([{ frames: [3], outputPath: "/out/b.png" }], true).ok).toBe(true);
  });
  it('works with "Allow Scripts to Write Files and Access Network" off: new folders and replaced files too (as in AE 26.5 through CEP)', () => {
    const ae = fakeKeysAE({ layers: [{ name: "a" }], files: ["/out/b.png"], dirs: ["/out"], writeAccess: false });
    expect(ae.app.preferences.getPrefAsLong("Main Pref Section", "Pref_SCRIPTING_FILE_NETWORK_SECURITY")).toBe(0);
    const r = ae.run(EXPORT_FRAMES_JSX, { exports: [{ frames: [0], outputPath: "/out/b.png" }, { frames: [1], outputPath: "/new/c.png" }], overwrite: true });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(ae.saved.map((s) => s.path)).toEqual(["/out/b.png", "/new/c.png"]);
  });
});

describe("ae_export_frames (handler)", () => {
  it("expands ~, waits for the files and lists them; leaves no undo step (rollback options)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "surehand-export-"));
    const file = join(dir, "f.png");
    let handler: any;
    registerFileTools({ registerTool: (n: string, _c: unknown, h: unknown) => void (n === "ae_export_frames" && (handler = h)) } as any);
    const calls: string[] = [];
    jsx.runJsx.mockImplementation(async (body: string, args: any, opts: any) => {
      if (body === FINISH_JSX) {
        // the second call: only once the file is there
        calls.push(`finish ${args.token} ${existsSync(file)}`);
        expect(opts.undoGroup).toBe(false);
        return { ok: true, logs: [], result: { undone: true, verified: "sentinel", note: "values were not compared" } };
      }
      expect(args.exports[0].outputPath.startsWith("~")).toBe(false);
      expect(opts).toMatchObject({ rollback: "deferred", checkOnly: true });
      calls.push("render");
      // written a moment after the script returned
      setTimeout(() => writeFileSync(file, "png"), 250);
      return { ok: true, logs: [], result: { files: [{ path: file, source: "Main", frame: 3, width: 1920, height: 1080 }], cleanup: {}, passes: 1 }, pending: "r1" };
    });
    const r = await handler({ exports: [{ frames: [3], outputPath: "~/f.png" }] });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe(`Exported 1 PNG file:\n${file} (Main, frame 3, 1920x1080)`);
    expect(calls).toEqual(["render", "finish r1 true"]);
  });
});

describe("ae_import_files: a rejected import-as", () => {
  const body = ALL_JSX_TOOLS.find((t) => t.name === "ae_import_files")!.jsx;
  function fake() {
    const imported: string[] = [];
    class File { constructor(public fsName: string) {} get exists() { return true; } }
    class ImportOptions {
      importAs: unknown = "FOOTAGE";
      sequence = false;
      constructor(public file: File) {}
      canImportAs(t: string) { return t === "FOOTAGE" || /\.psd$/.test(this.file.fsName); }
    }
    class FootageItem {}
    class CompItem {}
    const aemcp = {
      fail(m: string): never { throw new Error(m); },
      itemInfo: (it: any) => ({ name: it.name }),
      itemType: () => "footage",
    };
    const app = { project: { importFile: (io: ImportOptions) => { imported.push(`${io.file.fsName} as ${io.importAs}`); return Object.assign(new FootageItem(), { name: io.file.fsName }); } } };
    const run = (args: Record<string, unknown>) =>
      new Function("args", "aemcp", "app", "File", "ImportOptions", "ImportAsType", "FootageItem", "CompItem", body)(args, aemcp, app, File, ImportOptions, { FOOTAGE: "FOOTAGE", COMP: "COMP", COMP_CROPPED_LAYERS: "CCL", PROJECT: "PROJECT" }, FootageItem, CompItem);
    return { run, imported };
  }
  it("imports it as what After Effects can and says so", () => {
    const f = fake();
    const out = f.run({ paths: ["/a/logo.png", "/a/art.psd"], importAs: "comp" });
    expect(out[0]).toMatchObject({ importAsRejected: "comp", note: expect.stringMatching(/can't import this file as comp; it was imported as footage/) });
    expect(out[1].importAsRejected).toBeUndefined();
    expect(f.imported).toEqual(["/a/logo.png as FOOTAGE", "/a/art.psd as COMP"]);
  });
  it("strictImportAs refuses the whole call before importing anything", () => {
    const f = fake();
    expect(() => f.run({ paths: ["/a/art.psd", "/a/logo.png"], importAs: "comp", strictImportAs: true })).toThrow(/can't import \/a\/logo.png as comp.*Nothing was imported/);
    expect(f.imported).toEqual([]);
  });
});
