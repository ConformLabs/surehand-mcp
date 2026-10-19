// The change report for mask settings (mode, inverted...): attributes of the mask group, not
// properties, so the property walk alone doesn't see them. Run against a small fake After Effects.
import { describe, expect, it } from "vitest";
import { formatChanges, type Changes } from "../src/jsx.js";
import { fakeAE, loadHelpers, MaskFeatherFalloff, MaskMode, MaskMotionBlur, type Fake } from "./fake-ae.js";

function run(f: Fake, fn: () => void): Changes {
  const aemcp = loadHelpers(f);
  return JSON.parse(aemcp.run(fn, {}, { undoGroup: false, report: ["*"] })).changes;
}

describe("change report: mask settings", () => {
  for (const revision of [true, false]) {
    it(`mode and inverted, readable${revision ? "" : " (AE without project.revision)"}`, () => {
      const f = fakeAE({ mask: true, revision });
      const text = formatChanges(
        run(f, () => {
          f.mask.maskMode = MaskMode.SUBTRACT;
          f.mask.inverted = true;
        }),
      );
      expect(text).toBe("Changes (layers/properties compared in: Main):\n~ BG > Masks/Mask 1: mode Add -> Subtract; inverted off -> on");
    });
  }

  it("the other mask settings", () => {
    const f = fakeAE({ mask: true });
    const text = formatChanges(
      run(f, () => {
        f.mask.maskFeatherFalloff = MaskFeatherFalloff.FFO_LINEAR;
        f.mask.maskMotionBlur = MaskMotionBlur.OFF;
        f.mask.rotoBezier = true;
        f.mask.locked = true;
        f.mask.color = [1, 0, 0];
      }),
    )!;
    expect(text).toContain(
      "~ BG > Masks/Mask 1: feather falloff Smooth -> Linear; motion blur Same as layer -> Off; RotoBezier off -> on; locked off -> on; color [0.5,0.25,1] -> [1,0,0]",
    );
  });

  it("an unchanged mask (and a value change elsewhere) reports no mask line", () => {
    const f = fakeAE({ mask: true });
    const text = formatChanges(run(f, () => (f.opacity.value = 50)))!;
    expect(text).toContain("~ BG > Transform/Opacity: 100 -> 50");
    expect(text).not.toContain("Mask 1");
  });

  it("layers without masks read no mask settings", () => {
    const f = fakeAE();
    expect(formatChanges(run(f, () => {}))).toBe("Changes: none");
  });
});
