// No silent overwrites: Save As, preview outputPath and checkpoint restore, run against a small
// fake of the ExtendScript objects they use (File, app.project, CloseOptions).
import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jsx = vi.hoisted(() => ({ runJsx: vi.fn() }));
vi.mock("../src/jsx.js", async (orig) => ({ ...(await orig<typeof import("../src/jsx.js")>()), runJsx: jsx.runJsx }));

const { ALL_JSX_TOOLS } = await import("../src/tools/all.js");
const { CONTACT_SHEET_JSX, RENDER_FRAME_JSX } = await import("../src/tools/core.js");
const { RESTORE_JSX, restoreCheckpoint, _internal } = await import("../src/tools/workflow.js");

/** A fake After Effects: files on "disk", one open project, and a log of what was called. */
function fakeAE(opts: { files?: string[]; projectFile?: string; dirty?: boolean; openWorks?: boolean } = {}) {
  const files = new Set(opts.files ?? []);
  const calls: string[] = [];
  class File {
    fsName: string;
    constructor(p: string) {
      this.fsName = p;
    }
    get exists() {
      return files.has(this.fsName);
    }
  }
  const project: any = {
    file: opts.projectFile ? new File(opts.projectFile) : null,
    dirty: !!opts.dirty,
    save(f?: File) {
      calls.push(`save ${f ? f.fsName : "(own file)"}`);
      if (f) project.file = f;
      if (project.file) files.add(project.file.fsName);
      project.dirty = false;
    },
    close(how: string) {
      calls.push(`close ${how}`);
      project.file = null;
      project.dirty = false;
    },
  };
  const app = {
    project,
    open(f: File) {
      calls.push(`open ${f.fsName}`);
      // like AE: with unsaved changes (and the save prompt suppressed) open does nothing
      if (opts.openWorks === false || project.dirty) return;
      project.file = f;
    },
  };
  const aemcp = {
    fail(msg: string): never {
      throw Object.assign(new Error(msg), { aemcpUser: true });
    },
    findComp() {
      calls.push("render");
      return { name: "Comp" };
    },
  };
  const run = (body: string, args: Record<string, unknown>) =>
    new Function("args", "log", "aemcp", "app", "File", "CloseOptions", body)(args, () => {}, aemcp, app, File, { DO_NOT_SAVE_CHANGES: "DO_NOT_SAVE_CHANGES" });
  return { run, calls, project, files };
}

const SAVE_JSX = ALL_JSX_TOOLS.find((t) => t.name === "ae_save_project")!.jsx;

describe("ae_save_project Save As", () => {
  it("refuses to overwrite an existing file and says to pass overwrite: true", () => {
    const ae = fakeAE({ files: ["/work/other.aep"], projectFile: "/work/spot.aep" });
    expect(() => ae.run(SAVE_JSX, { path: "/work/other.aep" })).toThrow(/already exists at \/work\/other\.aep\. Nothing was saved\..*overwrite: true/);
    expect(ae.calls).toEqual([]);
    expect(ae.project.file.fsName).toBe("/work/spot.aep");
  });

  it("overwrites with overwrite: true", () => {
    const ae = fakeAE({ files: ["/work/other.aep"], projectFile: "/work/spot.aep" });
    expect(ae.run(SAVE_JSX, { path: "/work/other.aep", overwrite: true })).toEqual({ file: "/work/other.aep" });
    expect(ae.calls).toEqual(["save /work/other.aep"]);
  });

  it("saves to a new path, and onto the project's own file, without overwrite", () => {
    const ae = fakeAE({ files: ["/work/spot.aep"], projectFile: "/work/spot.aep" });
    expect(ae.run(SAVE_JSX, { path: "/work/spot.aep" })).toEqual({ file: "/work/spot.aep" });
    expect(ae.run(SAVE_JSX, { path: "/work/spot v2.aep" })).toEqual({ file: "/work/spot v2.aep" });
    expect(ae.run(SAVE_JSX, {})).toEqual({ file: "/work/spot v2.aep" });
    expect(ae.calls).toEqual(["save /work/spot.aep", "save /work/spot v2.aep", "save (own file)"]);
  });
});

describe("preview outputPath", () => {
  for (const [name, body] of [["ae_render_frame", RENDER_FRAME_JSX], ["ae_render_contact_sheet", CONTACT_SHEET_JSX]] as const) {
    it(`${name} refuses an existing outputPath before rendering anything`, () => {
      const ae = fakeAE({ files: ["/out/frame.png"] });
      expect(() => ae.run(body, { comp: 1, outputPath: "/out/frame.png" })).toThrow(/already exists at \/out\/frame\.png\. Nothing was rendered\..*overwrite: true/);
      expect(ae.calls).toEqual([]);
    });

    it(`${name} renders with overwrite: true, a new outputPath, or none`, () => {
      for (const args of [{ outputPath: "/out/frame.png", overwrite: true }, { outputPath: "/out/new.png" }, {}]) {
        const ae = fakeAE({ files: ["/out/frame.png"] });
        // the fake stops at the first real AE call: reaching it means the guard let the render through
        try {
          ae.run(body, { comp: 1, ...args });
        } catch {}
        expect(ae.calls[0]).toBe("render");
      }
    });
  }
});

describe("checkpoint restore", () => {
  it("never reuses the name of an earlier restore", () => {
    const dir = mkdtempSync(join(tmpdir(), "aemcp-restore-"));
    const project = join(dir, "Spot.aep");
    const first = _internal.restoreTarget(project, "2026-10-18-10-00-00");
    expect(first).toBe(join(dir, "Spot (restored 2026-10-18-10-00-00).aep"));
    writeFileSync(first, "earlier restore");
    const second = _internal.restoreTarget(project, "2026-10-18-10-00-00");
    expect(second).toBe(join(dir, "Spot (restored 2026-10-18-10-00-00 2).aep"));
    writeFileSync(second, "x");
    expect(_internal.restoreTarget(project, "2026-10-18-10-00-00")).toBe(join(dir, "Spot (restored 2026-10-18-10-00-00 3).aep"));
  });

  it("refuses a dirty project without discardChanges, before closing or opening anything", () => {
    const ae = fakeAE({ files: ["/w/Spot (restored 1).aep"], projectFile: "/w/Spot.aep", dirty: true });
    expect(() => ae.run(RESTORE_JSX, { path: "/w/Spot (restored 1).aep" })).toThrow(/unsaved changes.*discardChanges: true/);
    expect(ae.calls).toEqual([]);
  });

  it("with discardChanges closes the dirty project first, then opens the copy", () => {
    const ae = fakeAE({ files: ["/w/Spot (restored 1).aep"], projectFile: "/w/Spot.aep", dirty: true });
    expect(ae.run(RESTORE_JSX, { path: "/w/Spot (restored 1).aep", discardChanges: true })).toBe("/w/Spot (restored 1).aep");
    expect(ae.calls).toEqual(["close DO_NOT_SAVE_CHANGES", "open /w/Spot (restored 1).aep"]);
  });

  it("fails if After Effects did not actually open the copy", () => {
    const ae = fakeAE({ files: ["/w/Spot (restored 1).aep"], projectFile: "/w/Spot.aep", openWorks: false });
    expect(() => ae.run(RESTORE_JSX, { path: "/w/Spot (restored 1).aep" })).toThrow(/did not open the restored copy/);
  });

  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "aemcp-restore-"));
    const cpFile = join(dir, "checkpoint.aep");
    writeFileSync(cpFile, "checkpoint");
    const earlier = join(dir, "Spot (restored 1).aep");
    writeFileSync(earlier, "earlier restore");
    return { dir, cp: { id: "1", at: "", file: cpFile, project: join(dir, "Spot.aep") }, earlier };
  };

  it("restores to a new file, keeps an earlier restore, and reports the verified path", async () => {
    const { dir, cp, earlier } = setup();
    jsx.runJsx.mockReset();
    jsx.runJsx.mockResolvedValueOnce({ ok: true, result: false, logs: [] }); // dirty?
    jsx.runJsx.mockImplementationOnce(async (_body: string, args: any) => ({ ok: true, result: args.path, logs: [] }));
    const target = await restoreCheckpoint(cp.project, cp);
    expect(target).toBe(join(dir, "Spot (restored 1 2).aep"));
    expect(readFileSync(target, "utf8")).toBe("checkpoint");
    expect(readFileSync(earlier, "utf8")).toBe("earlier restore");
    expect(jsx.runJsx.mock.calls[1][0]).toBe(RESTORE_JSX);
    expect(jsx.runJsx.mock.calls[1][1]).toEqual({ path: target, discardChanges: false });
  });

  it("refuses a dirty project without discardChanges and leaves no file behind", async () => {
    const { dir, cp } = setup();
    jsx.runJsx.mockReset();
    jsx.runJsx.mockResolvedValueOnce({ ok: true, result: true, logs: [] });
    await expect(restoreCheckpoint(cp.project, cp)).rejects.toThrow(/discardChanges: true/);
    expect(existsSync(join(dir, "Spot (restored 1 2).aep"))).toBe(false);
    expect(jsx.runJsx).toHaveBeenCalledTimes(1);
  });

  it("removes the copy and fails when After Effects did not open it", async () => {
    const { dir, cp, earlier } = setup();
    jsx.runJsx.mockReset();
    jsx.runJsx.mockResolvedValueOnce({ ok: true, result: true, logs: [] });
    jsx.runJsx.mockResolvedValueOnce({ ok: false, logs: [], error: { message: "After Effects did not open the restored copy X." } });
    await expect(restoreCheckpoint(cp.project, cp, true)).rejects.toThrow(/did not open the restored copy X\. Nothing was restored/);
    expect(existsSync(join(dir, "Spot (restored 1 2).aep"))).toBe(false);
    expect(existsSync(earlier)).toBe(true);
    expect(jsx.runJsx.mock.calls[1][1]).toEqual({ path: join(dir, "Spot (restored 1 2).aep"), discardChanges: true });
  });
});
