// The change report's app.project.revision fast path, run against a small fake After Effects.
import { describe, expect, it } from "vitest";
import { formatChanges, type Changes } from "../src/jsx.js";
import { BlendingMode, fakeAE, loadHelpers, type Fake } from "./fake-ae.js";

/** aemcp.run with a change report, as the server calls it; returns the parsed result. */
function run(f: Fake, fn: () => void, opts: Record<string, unknown> = {}): { ok: boolean; changes: Changes } {
  const aemcp = loadHelpers(f);
  return JSON.parse(aemcp.run(fn, {}, { undoGroup: false, report: ["*"], ...opts }));
}

describe("aemcp.revision", () => {
  it("reads app.project.revision, null where AE doesn't have it", () => {
    expect(loadHelpers(fakeAE()).revision()).toBe(1);
    expect(loadHelpers(fakeAE({ revision: false })).revision()).toBe(null);
    const throwing = fakeAE({ revision: false });
    Object.defineProperty(throwing.app.project, "revision", { get: () => { throw new Error("no"); } });
    expect(loadHelpers(throwing).revision()).toBe(null);
  });
});

describe("change report with app.project.revision (edit tools)", () => {
  it("revision unchanged: no property is read after the call, Changes: none", () => {
    const f = fakeAE();
    const r = run(f, () => {});
    expect(f.reads.n).toBe(1); // the "before" snapshot only
    expect(r.changes.fast).toBe(true);
    expect(formatChanges(r.changes)).toBe("Changes: none");
  });

  it("revision unchanged still catches the attributes revision misses (blend mode, label, comment)", () => {
    const f = fakeAE();
    const r = run(f, () => {
      f.layer.blendingMode = BlendingMode.ADD;
      f.comp.label = 3;
      f.comp.comment = "note";
    });
    expect(r.changes.fast).toBe(true);
    const text = formatChanges(r.changes)!;
    expect(text).toContain('~ layer "BG" in "Main": blend mode');
    expect(text).toContain('~ comp "Main": label 1 -> 3; comment');
  });

  it("revision moved: the full report, property changes included", () => {
    const f = fakeAE();
    const r = run(f, () => f.edit(() => (f.opacity.value = 50)));
    expect(r.changes.fast).toBeUndefined();
    expect(formatChanges(r.changes)).toContain("~ BG > Transform/Opacity: 100 -> 50");
  });

  it("a script that fails after an edit still reports it", () => {
    const f = fakeAE();
    const r = run(f, () => {
      f.edit(() => (f.opacity.value = 20));
      throw new Error("boom");
    });
    expect(r.ok).toBe(false);
    expect(formatChanges(r.changes)).toContain("100 -> 20");
  });

  it("AE without revision: today's behaviour (full snapshot after the call)", () => {
    const f = fakeAE({ revision: false });
    const unchanged = run(f, () => {});
    expect(f.reads.n).toBe(2);
    expect(unchanged.changes.fast).toBeUndefined();
    expect(formatChanges(unchanged.changes)).toBe("Changes: none");
    const changed = run(f, () => (f.opacity.value = 10));
    expect(formatChanges(changed.changes)).toContain("100 -> 10");
  });
});

describe("read-only check (checkOnly) with app.project.revision", () => {
  it("a script that only reads: no property is read at all, Changes: none", () => {
    const f = fakeAE();
    const r = run(f, () => void f.comp.name, { checkOnly: true });
    expect(f.reads.n).toBe(0);
    expect(formatChanges(r.changes)).toBe("Changes: none");
  });

  it("a script that edited something: changed, not listed (Board Q3: short message)", () => {
    const f = fakeAE();
    const r = run(f, () => f.edit(() => (f.opacity.value = 0)), { checkOnly: true });
    expect(f.reads.n).toBe(0);
    expect(r.changes.unlisted).toBe(true);
    expect(formatChanges(r.changes)).toBe("Changes: the project changed (not listed)");
  });

  it("an attribute change revision misses is still caught and listed", () => {
    const f = fakeAE();
    const r = run(f, () => (f.layer.blendingMode = BlendingMode.ADD), { checkOnly: true });
    expect(r.changes.unlisted).toBeUndefined();
    expect(formatChanges(r.changes)).toContain('~ layer "BG" in "Main": blend mode');
  });

  it("AE without revision: the full report, as today", () => {
    const f = fakeAE({ revision: false });
    const r = run(f, () => (f.opacity.value = 0), { checkOnly: true });
    expect(r.changes.unlisted).toBeUndefined();
    expect(formatChanges(r.changes)).toContain("~ BG > Transform/Opacity: 100 -> 0");
  });
});
