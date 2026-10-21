// Small helper-library behaviours checked on a fake After Effects: ae_undo / ae_redo count only the steps AE really took
// (aemcp.undoRedo; a modal dialog makes Edit > Undo do nothing), and the project name as the user sees it.
import { describe, expect, it } from "vitest";
import { fakeAE, loadHelpers } from "./fake-ae.js";

function withSteps(opts: Parameters<typeof fakeAE>[0], n: number) {
  const f = fakeAE(opts);
  for (let i = 0; i < n; i++) f.edit(() => f.opacity.setValue(10 + i));
  return { f, aemcp: loadHelpers(f) };
}

describe("aemcp.undoRedo", () => {
  it("undoes the steps asked for and says so", () => {
    const { f, aemcp } = withSteps({}, 2);
    expect(aemcp.undoRedo(16, 2, "undo")).toEqual({ undone: 2 });
    expect(f.undoStack()).toEqual([]);
  });

  it("fails when After Effects undid nothing (a dialog open), instead of claiming it did", () => {
    const { aemcp } = withSteps({ undoWorks: false }, 1);
    expect(() => aemcp.undoRedo(16, 1, "undo")).toThrow(/After Effects didn't undo anything: a dialog may be open in After Effects/);
  });

  it("stops at the first step that did nothing and reports how many happened", () => {
    const { aemcp } = withSteps({}, 1);
    expect(aemcp.undoRedo(16, 3, "undo")).toEqual({ undone: 1, note: expect.stringMatching(/^Only 1 of 3 steps: then After Effects didn't undo anything/) });
  });

  it("without project.revision it can't check, and says so", () => {
    const { aemcp } = withSteps({ revision: false, undoWorks: false }, 1);
    expect(aemcp.undoRedo(16, 1, "undo")).toEqual({ undone: 1, unverified: expect.stringMatching(/couldn't be checked/) });
  });
});

describe("aemcp.projectInfo", () => {
  it("names the project as its file is called, not URL-encoded (ExtendScript's File.name is)", () => {
    const f = fakeAE();
    f.app.project.file = { name: "My%20Spot%20v2.aep", fsName: "/work/My Spot v2.aep" };
    f.app.project.renderQueue = { numItems: 0 };
    const info = loadHelpers(f).projectInfo();
    expect(info.name).toBe("My Spot v2.aep");
    expect(info.file).toBe("/work/My Spot v2.aep");
  });
});
