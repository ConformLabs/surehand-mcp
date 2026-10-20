// "Allow Scripts to Write Files and Access Network" (After Effects > Settings > Scripting & Expressions): the helper
// library's check (the preference, else a test write), the refusal before an ExtendScript write, and the hint a
// failed call gets while it is off. Runs the real helper library on the fake After Effects.
import { describe, expect, it } from "vitest";
import { fakeAE, fakeWriteAccess, loadHelpers } from "./fake-ae.js";
import { formatResult } from "../src/tools/registry.js";
import { WRITE_ACCESS_HINT, WRITE_ACCESS_REFUSAL } from "../src/permissions.js";

/** The helpers in a fake After Effects whose setting is `state`; `disk`: the File / Folder the probe uses. */
function helpers(state: boolean | "unreadable" | undefined, disk: boolean | "unreadable" = state ?? false) {
  const f = fakeAE({ writeAccess: state });
  const fs = fakeWriteAccess(disk);
  return { aemcp: loadHelpers(f, { File: fs.File, Folder: fs.Folder }), files: fs.files };
}

describe("aemcp.canWriteFiles", () => {
  it("reads the preference: 1 = on, 0 = off", () => {
    expect(helpers(true).aemcp.canWriteFiles(true)).toBe(true);
    expect(helpers(false).aemcp.canWriteFiles(true)).toBe(false);
  });

  it("when the preference can't be read: a test write in Folder.temp tells (and is removed), only if asked to probe", () => {
    const on = helpers("unreadable", true);
    expect(on.aemcp.canWriteFiles(false)).toBeNull();
    expect(on.aemcp.canWriteFiles(true)).toBe(true);
    expect([...on.files]).toEqual([]); // the temporary file is gone
    expect(helpers("unreadable", false).aemcp.canWriteFiles(true)).toBe(false);
    // an After Effects without the preference: not known unless probed
    expect(helpers(undefined).aemcp.canWriteFiles(false)).toBeNull();
  });
});

describe("aemcp.needWriteAccess", () => {
  it("refuses with the plain-language text while the setting is off, and does nothing while it is on", () => {
    expect(() => helpers(true).aemcp.needWriteAccess("create the folder /out")).not.toThrow();
    let err: any;
    try {
      helpers(false).aemcp.needWriteAccess("create the folder /out");
    } catch (e) {
      err = e;
    }
    expect(err.aemcpUser).toBe(true);
    expect(err.message).toBe(WRITE_ACCESS_REFUSAL.replace("{what}", "create the folder /out"));
    expect(err.message).toBe(
      "Nothing ran. After Effects doesn't allow scripts to write files, and this call needs to create the folder /out. " +
        "Ask the user to turn on 'Allow Scripts to Write Files and Access Network' in After Effects > Settings > Scripting & Expressions " +
        "(Windows: Edit > Preferences > Scripting & Expressions), then try again.",
    );
  });
});

describe("a failed call while the setting is off", () => {
  const run = (state: boolean | undefined, fn: () => unknown) => JSON.parse(helpers(state).aemcp.run(fn, {}, { undoGroup: false }));

  it("is marked by the helper library (only when it failed and the setting is known to be off)", () => {
    const boom = () => {
      throw new Error("Unable to save the project");
    };
    expect(run(false, boom).writeAccess).toBe(false);
    expect(run(true, boom).writeAccess).toBeUndefined();
    expect(run(undefined, boom).writeAccess).toBeUndefined();
    expect(run(false, () => 1).writeAccess).toBeUndefined();
  });

  it("gets the hint that names the setting, unless its error already says so", () => {
    const r = run(false, () => {
      throw new Error("Unable to save the project");
    });
    const text = (formatResult(r).content[0] as any).text;
    expect(text).toBe(`Error: Unable to save the project\n\n${WRITE_ACCESS_HINT}`);
    expect(WRITE_ACCESS_HINT).toBe(
      "Note: 'Allow Scripts to Write Files and Access Network' is off in After Effects. If this call failed because it writes files, " +
        "uses the network or runs a shell command, ask the user to turn it on in After Effects > Settings > Scripting & Expressions " +
        "(Windows: Edit > Preferences > Scripting & Expressions).",
    );
    const refused = run(false, () => helpers(false).aemcp.needWriteAccess("replace the existing file /out/a.png"));
    const refusedText = (formatResult(refused).content[0] as any).text;
    expect(refusedText).toMatch(/^Nothing ran\. After Effects doesn't allow scripts to write files/);
    expect(refusedText).not.toContain("Note:");
    // on: no hint
    expect((formatResult(run(true, () => { throw new Error("x"); })).content[0] as any).text).toBe("Error: x");
  });
});
