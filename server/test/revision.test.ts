// The change report's app.project.revision fast path, run against a small fake After Effects.
import { describe, expect, it } from "vitest";
import { formatChanges, helperSource, type Changes } from "../src/jsx.js";

// ---------- a fake After Effects: just what the snapshot reads ----------
class CompItem {}
class FolderItem {}
class FootageItem {}
class SolidSource {}
class PlaceholderSource {}
class AVLayer {}
const PropertyType = { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 };
const PropertyValueType = { NO_VALUE: 6412, OneD: 6417, TEXT_DOCUMENT: 6420 };
const BlendingMode = { NORMAL: 5212, ADD: 5220 };
const TrackMatteType = { NO_TRACK_MATTE: 5012 };

interface Fake {
  app: any;
  comp: any;
  layer: any;
  opacity: any;
  /** property values read so far (what makes a snapshot slow) */
  reads: { n: number };
  /** an edit: bumps the revision like AE does */
  edit: (f: () => void) => void;
}

function fakeAE(opts: { revision?: boolean } = {}): Fake {
  const reads = { n: 0 };
  let revision = 1;
  let opacityValue = 100;
  const opacity: any = {
    name: "Opacity",
    propertyType: PropertyType.PROPERTY,
    propertyValueType: PropertyValueType.OneD,
    canSetExpression: true,
    expression: "",
    numKeys: 0,
    get value() {
      reads.n++;
      return opacityValue;
    },
    set value(v: number) {
      opacityValue = v;
    },
  };
  const transform: any = { name: "Transform", propertyType: PropertyType.NAMED_GROUP, numProperties: 1, property: () => opacity };
  const layer: any = Object.assign(new AVLayer(), {
    id: 7, name: "BG", inPoint: 0, outPoint: 4, startTime: 0, stretch: 100, parent: null, enabled: true, solo: false, locked: false,
    shy: false, label: 1, threeDLayer: false, blendingMode: BlendingMode.NORMAL, trackMatteType: TrackMatteType.NO_TRACK_MATTE,
    adjustmentLayer: false, motionBlur: false, guideLayer: false, audioEnabled: false, numProperties: 1, property: () => transform,
  });
  const comp: any = Object.assign(new CompItem(), {
    id: 1, name: "Main", parentFolder: { name: "Root" }, label: 1, comment: "", width: 1920, height: 1080, duration: 4, frameRate: 25,
    pixelAspect: 1, bgColor: [0, 0, 0], workAreaStart: 0, workAreaDuration: 4, numLayers: 1, useProxy: false, time: 0,
    layer: () => layer,
  });
  const project: any = { numItems: 1, item: () => comp, itemByID: (id: number) => (id === 1 ? comp : null), activeItem: comp, bitsPerChannel: 8 };
  if (opts.revision !== false) Object.defineProperty(project, "revision", { get: () => revision });
  const app = { project, beginSuppressDialogs() {}, endSuppressDialogs() {} };
  return { app, comp, layer, opacity, reads, edit: (f) => (f(), revision++) };
}

function loadHelpers(f: Fake): any {
  const globals = { CompItem, FolderItem, FootageItem, SolidSource, PlaceholderSource, AVLayer, PropertyType, PropertyValueType, BlendingMode, TrackMatteType };
  const names = Object.keys(globals);
  const $ = { global: { ...globals } };
  return new Function("$", "app", ...names, "var aemcp;\n" + helperSource + "\nreturn aemcp;")($, f.app, ...names.map((n) => (globals as any)[n]));
}

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
