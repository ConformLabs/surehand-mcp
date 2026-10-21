// ae_undo / ae_redo count only the steps After Effects really took (aemcp.undoRedo): a modal dialog in AE makes
// Edit > Undo do nothing, and the tool used to report it as done anyway.
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
