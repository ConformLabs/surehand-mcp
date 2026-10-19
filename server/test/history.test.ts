// Project history: the diff engine on hand-written snapshots, the snapshot ExtendScript against a small
// read-only fake After Effects, storage (prune, references) and the checkpoint hook.
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { helperSource } from "../src/jsx.js";
import { canonical, diffKeys, diffSnapshots, fmt, formatDiff, lineDiff, parseSnapshotLines, summary, type Item, type Layer, type Prop, type Snapshot } from "../src/history-diff.js";

// snapshots and checkpoints go to a temporary home (read lazily via os.homedir())
const home = mkdtempSync(join(tmpdir(), "aemcp-history-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

// ---------- hand-written snapshots ----------

function snap(items: Item[], extra: Partial<Snapshot> = {}): Snapshot {
  return canonical({
    format: 1, id: "s", at: "2026-10-19T10:00:00.000Z", project: "/p.aep", revision: 1,
    stats: { comps: 1, layers: 1, visited: 1, stored: 1, ms: 1, pruning: "on" },
    settings: { bitsPerChannel: 8 }, items: Object.fromEntries(items.map((i) => [String(i.id), i])), rq: {}, ...extra,
  }) as Snapshot;
}
function layer(key: string, index: number, name: string, props: Record<string, Prop> = {}, more: Partial<Layer> = {}): Layer {
  return { key, index, name, type: "shape", attrs: { inPoint: 0, outPoint: 10, parent: null }, props, groups: {}, ...more };
}
function comp(id: number, name: string, layers: Layer[], more: Partial<Item> = {}): Item {
  return { id, type: "comp", name, folder: "", fields: { width: 1920, height: 1080, duration: 10, frameRate: 25 }, layers: Object.fromEntries(layers.map((l) => [l.key, l])), ...more };
}
const P = (path: string, o: Omit<Prop, "path">): Prop => ({ path, ...o });
const POS = "ADBE Transform Group/ADBE Position", OPA = "ADBE Transform Group/ADBE Opacity";
const diffText = (a: Snapshot, b: Snapshot, o = {}) => formatDiff(diffSnapshots(a, b), o);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("history diff engine", () => {
  const base = () => snap([comp(1, "Main", [layer("L1", 1, "Title", { [POS]: P("Transform/Position", { v: [960, 540] }) }), layer("L2", 2, "BG")])]);

  it("identical snapshots: no differences", () => {
    expect(diffText(base(), base())).toBe("Summary: No differences.");
  });

  it("values: changed, set from default, reset to default", () => {
    const a = base(), b = clone(a);
    b.items["1"].layers!.L1.props[POS].v = [960, 600];
    b.items["1"].layers!.L1.props[OPA] = P("Transform/Opacity", { v: 50 });
    const t = diffText(a, b);
    expect(t).toContain('~ Title > Transform/Position: [960,540] -> [960,600]');
    expect(t).toContain("~ Title > Transform/Opacity: default -> 50");
    expect(t).toMatch(/^Summary: 2 values changed/);
    expect(diffText(b, a)).toContain("~ Title > Transform/Opacity: 50 -> default");
  });

  it("layers: added, removed, renamed, attributes with parent names, and only the layer that really moved", () => {
    const a = snap([comp(1, "Main", [layer("L1", 1, "A"), layer("L2", 2, "B"), layer("L3", 3, "C"), layer("L4", 4, "D"), layer("L9", 5, "Gone")])]);
    const b = snap([comp(1, "Main", [layer("L2", 1, "B"), layer("L3", 2, "C"), layer("L4", 3, "Dee", {}, { attrs: { inPoint: 1, outPoint: 10, parent: "L2" } }), layer("L1", 4, "A"), layer("L5", 5, "New")])]);
    const t = diffText(a, b);
    expect(t).toContain('+ layer #5 "New" (shape)');
    expect(t).toContain('- layer #5 "Gone" (shape)');
    expect(t).toContain('~ layer #3 "Dee": renamed from "D"; inPoint 0 -> 1; parent none -> "B"');
    expect(t).toContain('~ layer #4 "A": moved #1 -> #4');
    expect(t.match(/moved #/g)).toHaveLength(1); // B, C, D shifted up but didn't move relative to each other
    expect(t).toMatch(/1 layer added, 1 layer removed, 1 layer renamed, 1 layer moved, 1 layer changed/);
  });

  it("keyframes: value at a time, added, moved, easing; static <-> animated", () => {
    const k = (t: number, v: unknown, e = "0/33.3 | 0/33.3") => ({ t, v, ip: "bezier/bezier", e });
    const a = snap([comp(1, "Main", [layer("L1", 1, "T", { [OPA]: P("Transform/Opacity", { k: [k(0, 0), k(1, 100), k(2, 50)] }), [POS]: P("Transform/Position", { v: [1, 2] }) })])]);
    const b = clone(a);
    b.items["1"].layers!.L1.props[OPA].k = [k(0, 10), k(1, 100, "0/33.3 | 0/75"), k(2.5, 50), k(3, 0)];
    b.items["1"].layers!.L1.props[POS] = P("Transform/Position", { k: [k(0, [1, 2]), k(1, [5, 5])] });
    const t = diffText(a, b);
    expect(t).toContain("~ T > Transform/Opacity: keyframes 3 -> 4: moved @2s -> @2.5s; @0s 0 -> 10; @1s ease 0/33.3 | 0/33.3 -> 0/33.3 | 0/75; + @3s 0");
    expect(t).toContain("~ T > Transform/Position: now animated, 2 keyframes (was [1,2])");
    expect(diffText(b, a)).toContain("~ T > Transform/Position: keyframes removed (2), now [1,2]");
    expect(diffKeys([k(0, 1)], [k(0, 1), k(1, 2), k(2, 3), k(3, 4), k(4, 5), k(5, 6)])).toEqual(["+ @1s 2", "+ @2s 3", "+ @3s 4", "+ @4s 5", "1 more"]);
  });

  it("expressions: added, a compact line diff when changed, removed, disabled", () => {
    const a = snap([comp(1, "Main", [layer("L1", 1, "T", { [POS]: P("Transform/Position", { v: [1, 1], x: "var a = 1;\nwiggle(2, 10)" }), [OPA]: P("Transform/Opacity", { v: 1, x: "50" }) })])]);
    const b = clone(a);
    b.items["1"].layers!.L1.props[POS].x = "var a = 1;\nwiggle(3, 10)";
    b.items["1"].layers!.L1.props[OPA].xoff = true;
    const t = diffText(a, b);
    expect(t).toContain("~ T > Transform/Position: expression changed:\n        - wiggle(2, 10)\n        + wiggle(3, 10)");
    expect(t).toContain("~ T > Transform/Opacity: expression disabled");
    const c = clone(a);
    delete c.items["1"].layers!.L1.props[OPA].x;
    expect(diffText(a, c)).toContain("~ T > Transform/Opacity: expression removed");
    expect(diffText(c, a)).toContain('~ T > Transform/Opacity: expression added: "50"');
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual(["- b", "+ B", "+ d"]);
  });

  it("effects: added with its settings (outermost only), removed, renamed in place (params still compared), reordered, switched off", () => {
    const fx = (k: string, path: string, match: string, i: number, on?: boolean) => [`ADBE Effect Parade/${k}`, { path: `Effects/${path}`, match, i, ...(on === false ? { on } : {}) }] as [string, any];
    const L = (groups: [string, any][], props: Record<string, Prop>) => layer("L1", 1, "T", props, { groups: Object.fromEntries(groups) });
    const a = snap([comp(1, "Main", [L([fx("Blur", "Blur", "ADBE Gaussian Blur 2", 1), fx("Glow", "Glow", "ADBE Glo2", 2), fx("Tint", "Tint", "ADBE Tint", 3), fx("Old", "Old", "ADBE Fill", 4)], {
      "ADBE Effect Parade/Blur/ADBE Gaussian Blur 2-0001": P("Effects/Blur/Blurriness", { v: 10 }),
    })])]);
    const b = snap([comp(1, "Main", [L([fx("Big Blur", "Big Blur", "ADBE Gaussian Blur 2", 1), fx("Tint", "Tint", "ADBE Tint", 2, false), fx("Glow", "Glow", "ADBE Glo2", 3), fx("Curves", "Curves", "ADBE CurvesCustom", 4)], {
      "ADBE Effect Parade/Big Blur/ADBE Gaussian Blur 2-0001": P("Effects/Big Blur/Blurriness", { v: 20 }),
      "ADBE Effect Parade/Curves/x": P("Effects/Curves/Channel", { v: 2 }),
    })])]);
    const t = diffText(a, b);
    expect(t).toContain('~ T > Effects/Blur: renamed "Blur" -> "Big Blur"');
    expect(t).toContain("~ T > Effects/Big Blur/Blurriness: 10 -> 20");
    expect(t).toContain("+ T > Effects/Curves (ADBE CurvesCustom): Channel 2");
    expect(t).not.toContain("Effects/Curves/Channel"); // inside an added effect: not listed again
    expect(t).toContain("- T > Effects/Old");
    expect(t).toContain("~ T > Effects/Tint: turned off");
    expect(t).toContain("~ T > Effects: reordered (Blur, Glow, Tint -> Big Blur, Tint, Glow)");
    expect(t).toMatch(/1 effect added, 1 effect removed, 1 effect reordered/);
  });

  it("project items, comp settings, footage paths, folders, render queue and project settings", () => {
    const foot = (file: string, folder = ""): Item => ({ id: 5, type: "footage", name: "plate.mov", folder, fields: { file, width: 1920 } });
    const rq = (file: string) => ({ "c1#1": { index: 1, comp: 1, compName: "Main", status: "QUEUED", render: true, oms: [{ template: "ProRes", file }] } });
    const a = snap([comp(1, "Main", []), foot("/a/plate_v1.mov"), comp(2, "Old", [])], { rq: rq("/out/v1.mov") });
    const b = snap([comp(1, "Main v2", [], { fields: { width: 1920, height: 1080, duration: 12, frameRate: 25 } }), foot("/a/plate_v2.mov", "Footage"), comp(3, "End Card", [layer("L1", 1, "Logo")])], { rq: rq("/out/v2.mov"), settings: { bitsPerChannel: 16 } });
    const t = diffText(a, b);
    expect(t).toContain('~ comp "Main v2": renamed from "Main"; duration 10 -> 12');
    expect(t).toContain('~ footage "plate.mov": moved to folder "Footage" (was "(root)"); file "/a/plate_v1.mov" -> "/a/plate_v2.mov"');
    expect(t).toContain('+ comp "End Card" (1920x1080, 10s, 25 fps, 1 layers)');
    expect(t).toContain('- comp "Old"');
    expect(t).toContain('~ #1 "Main": output 1 file "/out/v1.mov" -> "/out/v2.mov"');
    expect(t).toContain("~ bitsPerChannel 8 -> 16");
  });

  it("comps not captured on both sides are named, not silently skipped", () => {
    const a = snap([comp(1, "Main", [layer("L1", 1, "T")]), comp(2, "Big", [], { partial: true })]);
    const b = clone(a);
    delete b.items["1"].layers;
    expect(diffText(a, b)).toContain('Note: Layers not compared in 2 comps (not captured in both snapshots: limited with comps, or the time budget ran out): "Main", "Big"');
  });

  it("long diffs are capped with a count and a pointer to detail; detail shows one comp in full", () => {
    const props = (v: number) => Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`p${i}`, P(`Effects/X/P${i}`, { v: v + i })]));
    const a = snap([comp(1, "Main", [layer("L1", 1, "T", props(0))]), comp(2, "Side", [layer("L1", 1, "U", { [OPA]: P("Transform/Opacity", { v: 1 }) })])]);
    const b = snap([comp(1, "Main", [layer("L1", 1, "T", props(1000))]), comp(2, "Side", [layer("L1", 1, "U", { [OPA]: P("Transform/Opacity", { v: 2 }) })])]);
    const t = diffText(a, b);
    expect(t.split("\n").filter((l) => l.startsWith("  ~")).length).toBe(150);
    expect(t).toContain('... 51 more change lines not shown. Show one comp in full with detail: "Main" (50 more), "Side" (1 more).');
    const d = diffText(a, b, { detail: "Side" });
    expect(d).toContain("~ U > Transform/Opacity: 1 -> 2");
    expect(d).not.toContain("Comp \"Main\"");
    expect(diffText(a, b, { detail: 1 }).split("\n").filter((l) => l.startsWith("  ~")).length).toBe(200);
    expect(diffText(a, b, { detail: "Nope" })).toMatch(/^No layer changes in comp "Nope" \(comps with changes: "Main", "Side"\)/);
  });

  it("formats values readably", () => {
    expect(fmt(0.123456)).toBe("0.123");
    expect(fmt([1, 2, 3, 4, 5])).toBe("[5 values]");
    expect(fmt({ text: "Hello", font: "Arial" })).toBe('"Hello"');
    expect(fmt({ closed: true, points: 4, sum: 1 })).toBe("path (4 points, closed)");
    expect(summary({ "layers added": 1, "values changed": 2, "render queue changes": 1 })).toBe("1 layer added, 2 values changed, 1 render queue change");
  });
});

// ---------- the snapshot ExtendScript, against a small read-only fake After Effects ----------

class CompItem {}
class FolderItem {}
class FootageItem {}
class SolidSource {}
class PlaceholderSource {}
class AVLayer {}
class ShapeLayer extends AVLayer {}
class TextLayer extends AVLayer {}
class TextDocument {}
class Shape {}
class MarkerValue {}
const PT = { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 };
const PVT = { NO_VALUE: 6412, ThreeD_SPATIAL: 6413, ThreeD: 6414, TwoD_SPATIAL: 6415, TwoD: 6416, OneD: 6417, COLOR: 6418, CUSTOM_VALUE: 6419, MARKER: 6420, LAYER_INDEX: 6421, MASK_INDEX: 6422, SHAPE: 6423, TEXT_DOCUMENT: 6424 };
const KIT = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 };
const BlendingMode = { NORMAL: 5212, ADD: 5220 };
const TrackMatteType = { NO_TRACK_MATTE: 5012 };
const GLOBALS: Record<string, unknown> = { CompItem, FolderItem, FootageItem, SolidSource, PlaceholderSource, AVLayer, ShapeLayer, TextLayer, TextDocument, Shape, MarkerValue, PropertyType: PT, PropertyValueType: PVT, KeyframeInterpolationType: KIT, BlendingMode, TrackMatteType };

/** Every object is behind a proxy that throws on any write or edit method: the snapshot must only read. */
const writes: string[] = [];
function guard<T>(o: T, path = "app"): T {
  if (!o || typeof o !== "object") return o;
  return new Proxy(o as any, {
    get(t, k) {
      const v = t[k];
      if (typeof v === "function") {
        return (...a: unknown[]) => {
          if (/^(set|add|remove|move|duplicate|apply|beginUndo|endUndo|execute|save|close|open)/.test(String(k))) {
            writes.push(`${path}.${String(k)}()`);
            throw new Error(`write: ${String(k)}`);
          }
          return guard(v.apply(t, a), `${path}.${String(k)}()`);
        };
      }
      return guard(v, `${path}.${String(k)}`);
    },
    set(_t, k) {
      writes.push(`${path}.${String(k)} =`);
      throw new Error(`write: ${String(k)}`);
    },
  });
}

let reads = 0;
interface FProp { name: string; matchName: string; propertyType: number; [k: string]: any }
function prop(name: string, matchName: string, value: unknown, o: { mod?: boolean; keys?: { t: number; v: unknown }[]; expr?: string; vt?: number } = {}): FProp {
  const keys = o.keys ?? [];
  return {
    name, matchName, propertyType: PT.PROPERTY, propertyValueType: o.vt ?? PVT.OneD,
    get isModified() { return o.mod ?? (value !== 0 || keys.length > 0 || !!o.expr); },
    get value() { reads++; return value; },
    valueAtTime: () => value, numKeys: keys.length, isSpatial: false,
    keyTime: (k: number) => keys[k - 1].t, keyValue: (k: number) => keys[k - 1].v,
    keyInInterpolationType: () => KIT.BEZIER, keyOutInterpolationType: () => KIT.HOLD,
    keyInTemporalEase: () => [{ speed: 0, influence: 33.333333 }], keyOutTemporalEase: () => [{ speed: 0, influence: 75 }],
    keyTemporalContinuous: () => false, keyTemporalAutoBezier: () => false, keyLabel: () => 0,
    canSetExpression: true, expression: o.expr ?? "", expressionEnabled: true,
  };
}
function group(name: string, matchName: string, children: FProp[], o: { indexed?: boolean; mod?: boolean; enabled?: boolean } = {}): FProp {
  return {
    name, matchName, propertyType: o.indexed ? PT.INDEXED_GROUP : PT.NAMED_GROUP, numProperties: children.length, property: (i: number) => children[i - 1],
    get isModified() { return o.mod ?? children.some((c) => c.isModified); },
    canSetEnabled: o.enabled !== undefined, enabled: o.enabled ?? true,
  };
}
function fakeLayer(id: number, index: number, name: string, opts: { opacity?: number; position?: number[]; effects?: FProp[]; text?: string; expr?: string; brokenGroups?: boolean; extra?: FProp[] } = {}) {
  const C = opts.text !== undefined ? TextLayer : ShapeLayer;
  const transform = group("Transform", "ADBE Transform Group", [
    prop("Anchor Point", "ADBE Anchor Point", [0, 0], { mod: false, vt: PVT.TwoD }),
    prop("Position", "ADBE Position", opts.position ?? [960, 540], { vt: PVT.TwoD, expr: opts.expr }),
    prop("Opacity", "ADBE Opacity", opts.opacity ?? 100, { mod: opts.opacity !== undefined && opts.opacity !== 100, keys: opts.opacity === 0 ? [{ t: 0, v: 0 }, { t: 1, v: 100 }] : undefined }),
  ], opts.brokenGroups ? { mod: false } : {});
  const unmodified = group("Material Options", "ADBE Material Options Group", [prop("Casts Shadows", "ADBE Casts Shadows", 0, { mod: false })]);
  const children: FProp[] = [
    prop("Marker", "ADBE Marker", null, { mod: false, vt: PVT.MARKER }),
    group("Effects", "ADBE Effect Parade", opts.effects ?? [], { indexed: true }),
    transform, unmodified, ...(opts.extra ?? []),
  ];
  if (opts.text !== undefined) children.unshift(group("Text", "ADBE Text Properties", [prop("Source Text", "ADBE Text Document", Object.assign(new TextDocument(), { text: opts.text, font: "Inter", fontSize: 40 }), { vt: PVT.TEXT_DOCUMENT })]));
  return Object.assign(new C(), {
    id, index, name, parent: null, inPoint: 0, outPoint: 10, startTime: 0, stretch: 100, enabled: true, solo: false, locked: false, shy: false, label: 1,
    threeDLayer: false, blendingMode: BlendingMode.NORMAL, trackMatteType: TrackMatteType.NO_TRACK_MATTE, nullLayer: false, adjustmentLayer: false,
    numProperties: children.length, property: (i: number | string) => (typeof i === "number" ? children[i - 1] : children.find((c) => c.matchName === i)),
  });
}
function fakeProject(layers: any[], o: { otherComp?: boolean } = {}) {
  const root = Object.assign(new FolderItem(), { id: 0, name: "Root", parentFolder: null });
  const comp = Object.assign(new CompItem(), { id: 1, name: "Main", parentFolder: root, label: 1, comment: "", width: 1920, height: 1080, pixelAspect: 1, duration: 10, frameRate: 25, bgColor: [0, 0, 0], numLayers: layers.length, layer: (i: number) => layers[i - 1], markerProperty: { numKeys: 0 } });
  const items: any[] = [comp];
  if (o.otherComp) items.push(Object.assign(new CompItem(), { id: 2, name: "Other", parentFolder: root, width: 100, height: 100, duration: 1, frameRate: 25, numLayers: 1, layer: () => fakeLayer(20, 1, "X"), markerProperty: { numKeys: 0 } }));
  const project = {
    file: { fsName: "/work/Spot.aep" }, revision: 42, rootFolder: root, numItems: items.length, item: (i: number) => items[i - 1], itemByID: (id: number) => items.find((x) => x.id === id) ?? null,
    activeItem: comp, bitsPerChannel: 8, expressionEngine: "javascript-1.0",
    renderQueue: { numItems: 1, item: () => ({ comp, status: 3015, render: true, numOutputModules: 1, outputModule: () => ({ name: "ProRes 422", file: { fsName: "/out/Main.mov" } }) }) },
  };
  return { version: "26.0", project, beginUndoGroup() {}, endUndoGroup() {}, beginSuppressDialogs() {}, endSuppressDialogs() {} };
}

async function runSnapshotJsx(app: any, args: Record<string, unknown> = {}): Promise<string> {
  const { SNAPSHOT_JSX } = await import("../src/tools/history.js");
  const names = Object.keys(GLOBALS);
  const $ = { global: GLOBALS };
  const g = guard(app);
  const aemcp = new Function("$", "app", ...names, "var aemcp;\n" + helperSource + "\nreturn aemcp;")($, g, ...names.map((n) => GLOBALS[n]));
  const body = new Function("$", "app", "aemcp", ...names, `return function (args, log) {\n${SNAPSHOT_JSX}\n};`)($, g, aemcp, ...names.map((n) => GLOBALS[n]));
  const raw = aemcp.run(body, args, { undoGroup: false });
  const r = JSON.parse(raw);
  if (!r.ok) throw new Error(r.error.message);
  return r.result;
}
const capture = async (app: any, args: Record<string, unknown> = {}) => parseSnapshotLines(await runSnapshotJsx(app, args), { id: "x", at: "2026-10-19T10:00:00.000Z" });

describe("snapshot ExtendScript", () => {
  it("is valid ES3 (what After Effects' engine accepts)", async () => {
    const { SNAPSHOT_JSX } = await import("../src/tools/history.js");
    const { parse } = await import("acorn");
    expect(() => parse(`(function(args, log){${SNAPSHOT_JSX}\n})`, { ecmaVersion: 3, allowReserved: false })).not.toThrow();
  });

  it("captures items, layers, non-default properties, keyframes, expressions, effects, text and the render queue, and only reads", async () => {
    writes.length = 0;
    const blur = group("Gaussian Blur", "ADBE Gaussian Blur 2", [prop("Blurriness", "ADBE Gaussian Blur 2-0001", 12)]);
    const app = fakeProject([
      fakeLayer(7, 1, "Title", { text: "Hello", opacity: 0, expr: "wiggle(2, 10)", effects: [blur] }),
      fakeLayer(8, 2, "BG", { position: [100, 100] }),
    ]);
    const s = await capture(app);
    expect(writes).toEqual([]);
    expect(s.project).toBe("/work/Spot.aep");
    expect(s.revision).toBe(42);
    expect(s.stats.revisionAfter).toBe(42);
    const L = s.items["1"].layers!;
    expect(Object.keys(L)).toEqual(["L7", "L8"]);
    expect(L.L7).toMatchObject({ index: 1, name: "Title", type: "text", attrs: { blendingMode: "NORMAL", parent: null } });
    expect(L.L7.props["ADBE Transform Group/ADBE Position"]).toEqual({ path: "Transform/Position", v: [960, 540], x: "wiggle(2, 10)" });
    expect(L.L7.props["ADBE Transform Group/ADBE Opacity"]).toEqual({ path: "Transform/Opacity", k: [{ t: 0, v: 0, ip: "bezier/hold", e: "0/33.3333 | 0/75" }, { t: 1, v: 100, ip: "bezier/hold", e: "0/33.3333 | 0/75" }] });
    expect(L.L7.props["ADBE Text Properties/ADBE Text Document"].v).toMatchObject({ text: "Hello", font: "Inter", fontSize: 40 });
    expect(L.L7.groups["ADBE Effect Parade/Gaussian Blur"]).toEqual({ path: "Effects/Gaussian Blur", match: "ADBE Gaussian Blur 2", i: 1 });
    expect(L.L7.props["ADBE Effect Parade/Gaussian Blur/ADBE Gaussian Blur 2-0001"]).toEqual({ path: "Effects/Gaussian Blur/Blurriness", v: 12 });
    expect(L.L7.props["ADBE Transform Group/ADBE Anchor Point"]).toBeUndefined(); // at its default
    expect(L.L8.props["ADBE Transform Group/ADBE Opacity"]).toBeUndefined();
    expect(s.rq["c1#1"]).toMatchObject({ compName: "Main", render: true, oms: [{ template: "ProRes 422", file: "/out/Main.mov" }] });
    expect(s.settings).toMatchObject({ bitsPerChannel: 8, expressionEngine: "javascript-1.0" });
  });

  it("snapshot, change a keyframe + rename a layer + add an effect, diff", async () => {
    const before = await capture(fakeProject([fakeLayer(7, 1, "Headline", { opacity: 0 }), fakeLayer(8, 2, "BG")]));
    const title = fakeLayer(7, 1, "Title", { opacity: 0 });
    const op = title.property("ADBE Transform Group")!.property(3);
    op.keyValue = (k: number) => [0, 80][k - 1];
    const bg = fakeLayer(8, 2, "BG", { effects: [group("Glow", "ADBE Glo2", [prop("Glow Radius", "ADBE Glo2-0003", 20)])] });
    const after = await capture(fakeProject([title, bg]));
    const t = formatDiff(diffSnapshots(before, after));
    expect(t).toContain('~ layer #1 "Title": renamed from "Headline"');
    expect(t).toContain("~ Title > Transform/Opacity: keyframes: @1s 100 -> 80");
    expect(t).toContain("+ BG > Effects/Glow (ADBE Glo2): Glow Radius 20");
    expect(t).toMatch(/^Summary: 1 layer renamed, 1 keyframe change, 1 effect added$/m);
  });

  it("skips unmodified groups once isModified on groups is confirmed, and gets the same result as a full walk", async () => {
    const layers = Array.from({ length: 40 }, (_, i) => fakeLayer(i + 1, i + 1, `L${i + 1}`, { position: [i, i] }));
    const pruned = await capture(fakeProject(layers));
    const full = await capture(fakeProject(layers), { full: true });
    expect(pruned.stats.pruning).toBe("on");
    expect(full.stats.pruning).toBe("off (full)");
    expect(pruned.stats.visited).toBeLessThan(full.stats.visited);
    expect(formatDiff(diffSnapshots(pruned, full))).toBe("Summary: No differences.");
  });

  it("doesn't skip groups when isModified on a group misses a changed property inside it", async () => {
    const layers = Array.from({ length: 30 }, (_, i) => fakeLayer(i + 1, i + 1, `L${i + 1}`, { position: [i, i], brokenGroups: true }));
    const s = await capture(fakeProject(layers));
    expect(s.stats.pruning).toBe("off (isModified unreliable on groups)");
    expect(s.items["1"].layers!.L30.props["ADBE Transform Group/ADBE Position"].v).toEqual([29, 29]);
  });

  it("limits to some comps, and reports comps not reached in the time budget", async () => {
    const app = fakeProject([fakeLayer(7, 1, "A")], { otherComp: true });
    const scoped = await capture(app, { comps: ["Other"] });
    expect(scoped.scope).toEqual([2]);
    expect(scoped.items["1"].layers).toBeUndefined();
    expect(scoped.items["2"].layers).toBeDefined();
    await expect(runSnapshotJsx(app, { comps: ["Nope"] })).rejects.toThrow();
    expect((await capture(app, { comps: ["Nope", 2], lenient: true })).scope).toEqual([2]);
    const late = await capture(app, { budgetMs: -1 });
    expect(late.skipped).toEqual([1, 2]);
  });
});

// ---------- storage, references, checkpoint hook ----------

let fakeApp: any;
vi.mock("../src/jsx.js", async (original) => {
  const real = await original<typeof import("../src/jsx.js")>();
  return {
    ...real,
    runJsx: async (body: string, args: any) => {
      if (body.includes("p.save();")) {
        return { ok: true, result: fakeApp.__projectFile, logs: [] };
      }
      if (body.includes("aemcp.revision()")) return { ok: true, result: await runSnapshotJsx(fakeApp, args), logs: [] };
      return { ok: true, result: fakeApp.project.file.fsName, logs: [] };
    },
  };
});

describe("history storage", () => {
  it("stores snapshots next to the project's checkpoints, keeps the last 100, resolves references", async () => {
    const { saveSnapshot, historyDir, loadSnapshot, resolveRef } = await import("../src/tools/history.js");
    const { _internal } = await import("../src/tools/workflow.js");
    fakeApp = fakeProject([fakeLayer(7, 1, "A")]);
    const dir = historyDir("/work/Spot.aep");
    expect(dir.startsWith(join(home, ".aemcp", "history"))).toBe(true);
    expect(dir.split(/[\\/]/).pop()).toBe(_internal.projectDir("/work/Spot.aep").split(/[\\/]/).pop());
    const first = await saveSnapshot({ label: "v11" });
    expect(loadSnapshot("/work/Spot.aep", first.id).items["1"].name).toBe("Main");
    for (let i = 0; i < 101; i++) await saveSnapshot({ label: i === 100 ? "v12" : undefined });
    const files = readdirSync(dir).filter((f) => f.endsWith(".json.gz"));
    expect(files).toHaveLength(100);
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
    expect(index).toHaveLength(100);
    expect(new Set(index.map((e: any) => e.id)).size).toBe(100); // same-second ids get a suffix
    expect(resolveRef("v12", index, [])).toEqual({ entry: index[99] });
    expect(resolveRef("latest", index, [])).toEqual({ entry: index[99] });
    expect(resolveRef("previous", index, [])).toEqual({ entry: index[98] });
    expect(resolveRef("current", index, [])).toEqual({ current: true });
    expect(resolveRef("v11", index, [])).toMatch(/No snapshot or checkpoint "v11"/); // pruned
    const cps = [{ id: "2026-01-01-00-00-00", label: "before", file: "/cp/old.aep" }];
    expect(resolveRef("before", index, cps)).toMatch(/has no snapshot: .*\/cp\/old\.aep.*replaces the project open in After Effects, so that is not done automatically/);
  });

  it("ae_checkpoint save also stores a snapshot linked to the checkpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "aemcp-proj-"));
    const file = join(root, "Linked.aep");
    writeFileSync(file, "aep");
    fakeApp = fakeProject([fakeLayer(7, 1, "A")]);
    fakeApp.__projectFile = file;
    fakeApp.project.file = { fsName: file };
    const { saveCheckpoint } = await import("../src/tools/workflow.js");
    const { historyDir, resolveRef } = await import("../src/tools/history.js");
    const cp = await saveCheckpoint("v13");
    expect(cp.note).toMatch(/^History snapshot \S+ linked to this checkpoint \(1 layers/);
    const index = JSON.parse(readFileSync(join(historyDir(file), "index.json"), "utf8"));
    expect(index[0]).toMatchObject({ checkpoint: cp.id, label: "v13" });
    expect(resolveRef(cp.id, index, [{ id: cp.id, label: "v13", file: cp.file }])).toEqual({ entry: index[0] });
  });
});

describe("ae_project_history tool", () => {
  it("snapshot, edit, list, diff against the current project", async () => {
    const { registerHistoryTools } = await import("../src/tools/history.js");
    let handler: any;
    registerHistoryTools({ registerTool: (_n: string, _c: unknown, h: unknown) => (handler = h) } as any);
    const file = join(mkdtempSync(join(tmpdir(), "aemcp-proj-")), "Tool.aep");
    const make = (opacity?: number, name = "Title") => {
      fakeApp = fakeProject([fakeLayer(7, 1, name, { opacity }), fakeLayer(8, 2, "BG")]);
      fakeApp.project.file = { fsName: file };
    };
    make();
    const snap = await handler({ action: "snapshot", label: "v11" });
    expect(snap.content[0].text).toMatch(/^Snapshot \S+ \("v11"\) saved: 1 comp, 2 layers, \d+ non-default properties .*project revision 42/);
    expect((await handler({ action: "diff", from: "v11" })).content[0].text).toMatch(/To: {3}the current project \(revision 42, not stored\)\nSummary: No differences\.$/);
    make(50, "Headline");
    const d = (await handler({ action: "diff", from: "v11", to: "current" })).content[0].text;
    expect(d).toMatch(/^From: snapshot \S+ "v11", .* UTC, revision 42/);
    expect(d).toContain('~ layer #1 "Headline": renamed from "Title"');
    expect(d).toContain("~ Headline > Transform/Opacity: default -> 50");
    expect((await handler({ action: "list" })).content[0].text).toMatch(/^History of .*Tool\.aep \(newest first\):\n\S+ {2}snapshot "v11" {2}revision 42, 1 comps, 2 layers$/);
    const bad = await handler({ action: "diff", from: "v99" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/^from: No snapshot or checkpoint "v99"/);
  });
});
