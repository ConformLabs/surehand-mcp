// A fake After Effects project for ae_precomp_surgery: comps with precomp layers, parents, track mattes, expressions on
// any property, effects with layer parameters, nulls, and what the surgery uses: layer.copyToComp, moveBefore / moveAfter,
// remove, setParentWithJump, setTrackMatte, comp.duplicate, layers.addNull, replaceSource, item.usedIn, folders.
// What it copies from After Effects:
// - copyToComp returns nothing and puts the copy at the top (index 1) of the other comp ("aboveSelection": above the
//   selected layer, as pasting does; new layers are selected); the copy has no parent. While an undo group is open it
//   refuses a layer with a parent or a linked expression (as AE 26.5: "Can't copy a layer with a parent or with a linked
//   expression, while an Undo Group is open"); here a track matte layer or a layer parameter counts as a link too
// - itemByID throws for an id that is gone ("internal verification failure, sorry! {Item Not Found}")
// - removing a comp leaves the solids of its nulls in the project
// - a layer's keyframes are in comp time and move with its startTime
// - a locked layer can't be changed (renaming, setting a property, removing it throws)
// - addNull makes a 100x100 solid ("Null 1") in the project and puts the null at the top
// - comp.duplicate() names the copy "<name> 2" and copies every layer; precomp layers keep showing the same precomp
// The picture of a comp at a time (picture()) is what its visible layers show, flattened through precomps: each leaf
// layer's identity (kept by copies), its 2D world transform and opacity. A correct un-precompose or deep duplicate
// leaves it unchanged; anything else changes it.
import { helperSource } from "../src/jsx.js";

class Item {
  [k: string]: any;
}
class CompItem extends Item {}
class FootageItem extends Item {}
class FolderItem extends Item {}
class SolidSource {}
class Layer {
  [k: string]: any;
}
class AVLayer extends Layer {}
class TextLayer extends Layer {}
class ShapeLayer extends Layer {}
class CameraLayer extends Layer {}
class LightLayer extends Layer {}
class PropertyBase {}
const PT = { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 };
const PVT = { NO_VALUE: 6412, ThreeD_SPATIAL: 6413, ThreeD: 6414, TwoD_SPATIAL: 6415, TwoD: 6416, OneD: 6417, COLOR: 6418, LAYER_INDEX: 6421, MARKER: 6420 };
const BlendingMode = { NORMAL: 5212, ADD: 5220, MULTIPLY: 5221, SCREEN: 5222 };
const FrameBlendingType = { NO_FRAME_BLEND: 4012, FRAME_MIX: 4013, PIXEL_MOTION: 4014 };
const TrackMatteType = { NO_TRACK_MATTE: 5012, ALPHA: 5013, ALPHA_INVERTED: 5014, LUMA: 5015, LUMA_INVERTED: 5016 };
const AutoOrientType = { NO_AUTO_ORIENT: 4212, ALONG_PATH: 4213 };

export interface SLayer {
  name: string;
  type?: "solid" | "text" | "shape" | "null" | "precomp" | "camera" | "adjustment";
  /** precomp: the comp's name */
  source?: string;
  /** solid / footage size (default 200x100); text and shape: their rect is [0, 0, w, h] */
  size?: [number, number];
  rect?: [number, number, number, number];
  anchor?: number[];
  position?: number[];
  scale?: number[];
  rotation?: number;
  opacity?: number;
  /** keyframes [time, value] in comp time */
  keys?: { position?: [number, number[]][]; opacity?: [number, number][]; scale?: [number, number[]][] };
  parent?: string;
  matte?: { layer: string; type?: keyof typeof TrackMatteType };
  inPoint?: number;
  outPoint?: number;
  startTime?: number;
  stretch?: number;
  enabled?: boolean;
  locked?: boolean;
  guide?: boolean;
  solo?: boolean;
  threeD?: boolean;
  blend?: keyof typeof BlendingMode;
  motionBlur?: boolean;
  collapse?: boolean;
  timeRemap?: boolean;
  preserveTransparency?: boolean;
  /** effects: count only, or with a Layer Control pointing at a layer index */
  effects?: { name: string; layerParam?: number }[];
  masks?: number;
  /** Essential Properties on a precomp layer */
  eps?: number;
  /** expressions: "Transform/Position" (display path) -> text, or { x, on, err } */
  expr?: Record<string, string | { x: string; on?: boolean; err?: string }>;
}
export interface SComp {
  name: string;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  motionBlur?: boolean;
  frameBlending?: boolean;
  preserveFrameRate?: boolean;
  egp?: number;
  folder?: string;
  layers: SLayer[];
}

// ---------- properties ----------

function prop(name: string, matchName: string, vt: number, value: any): any {
  const p: any = Object.assign(new PropertyBase(), {
    name, matchName, propertyType: PT.PROPERTY, propertyValueType: vt, isSpatial: vt === PVT.TwoD_SPATIAL, canSetExpression: true,
    expression: "", expressionEnabled: false, expressionError: "", dimensionsSeparated: false, _value: value, _keys: [] as { t: number; v: any }[], _layer: null as any,
  });
  const guard = () => {
    if (p._layer?.locked) throw new Error("After Effects error: Unable to set value, the layer is locked.");
  };
  const lerp = (a: any, b: any, u: number) => (Array.isArray(a) ? a.map((x: number, i: number) => x + (b[i] - x) * u) : typeof a === "number" ? a + (b - a) * u : a);
  p.valueAtTime = (t: number) => {
    const k = p._keys;
    if (!k.length) return p._value;
    if (t <= k[0].t) return k[0].v;
    for (let i = 0; i + 1 < k.length; i++) if (t <= k[i + 1].t) return lerp(k[i].v, k[i + 1].v, (t - k[i].t) / (k[i + 1].t - k[i].t));
    return k[k.length - 1].v;
  };
  Object.defineProperty(p, "value", { get: () => p.valueAtTime(0) });
  Object.defineProperty(p, "numKeys", { get: () => p._keys.length });
  p.setValue = (v: any) => {
    guard();
    if (p._keys.length) throw new Error("After Effects error: can't use setValue on a property with keyframes");
    p._value = Array.isArray(v) ? v.slice() : v;
  };
  p.keyTime = (i: number) => p._keys[i - 1].t;
  p.keyValue = (i: number) => p._keys[i - 1].v;
  p.addKey = (t: number) => {
    guard();
    const at = p._keys.findIndex((k: any) => Math.abs(k.t - t) < 1e-9);
    if (at >= 0) return at + 1;
    p._keys.push({ t, v: p.valueAtTime(t) });
    p._keys.sort((a: any, b: any) => a.t - b.t);
    return p._keys.findIndex((k: any) => k.t === t) + 1;
  };
  p.setValueAtKey = (i: number, v: any) => {
    guard();
    p._keys[i - 1].v = Array.isArray(v) ? v.slice() : v;
  };
  p.setValueAtTime = (t: number, v: any) => p.setValueAtKey(p.addKey(t), v);
  // expressions: a locked layer refuses
  let expr = "";
  Object.defineProperty(p, "expression", {
    get: () => expr,
    set: (v: string) => {
      guard();
      expr = v;
      p.expressionEnabled = v !== "";
    },
    enumerable: true,
  });
  return p;
}

function group(name: string, matchName: string, children: any[], type = PT.NAMED_GROUP): any {
  const g: any = Object.assign(new PropertyBase(), { name, matchName, propertyType: type, children, enabled: true });
  Object.defineProperty(g, "numProperties", { get: () => g.children.length });
  g.property = (k: number | string) => (typeof k === "number" ? g.children[k - 1] : g.children.find((c: any) => c.name === k || c.matchName === k)) ?? null;
  g.children.forEach((c: any, i: number) => Object.assign(c, { parentProperty: g, propertyIndex: i + 1 }));
  return g;
}

/** a deep copy of a property tree (values, keys, expressions) */
function cloneTree(g: any): any {
  if (g.propertyType === PT.PROPERTY) {
    const q = prop(g.name, g.matchName, g.propertyValueType, Array.isArray(g._value) ? g._value.slice() : g._value);
    q._keys = g._keys.map((k: any) => ({ t: k.t, v: Array.isArray(k.v) ? k.v.slice() : k.v }));
    q.expression = g.expression;
    q.expressionEnabled = g.expressionEnabled;
    q.expressionError = g.expressionError;
    q.dimensionsSeparated = g.dimensionsSeparated;
    return q;
  }
  const c = group(g.name, g.matchName, g.children.map(cloneTree), g.propertyType);
  c.enabled = g.enabled;
  return c;
}
function eachProp(g: any, f: (p: any) => void) {
  for (const c of g.children ?? []) (c.propertyType === PT.PROPERTY ? f(c) : eachProp(c, f));
}

// ---------- the project ----------

const LAYER_FIELDS = ["name", "enabled", "locked", "guideLayer", "solo", "threeDLayer", "blendingMode", "motionBlur", "collapseTransformation", "timeRemapEnabled", "preserveTransparency", "adjustmentLayer", "frameBlendingType", "autoOrient", "trackMatteType", "label", "stretch", "_in", "_out", "_start", "_parent", "_matte", "source", "_comp", "_ident"] as const;

export function fakeSurgeryAE(opts: { comps: SComp[]; file?: string | null; active?: string; rq?: string[]; copyInsert?: "top" | "aboveSelection"; /** a broken After Effects for tests: setParentWithJump with a layer does nothing */ jumpIgnored?: boolean }) {
  let nextId = 1;
  let groupOpen = false;
  /** a new layer is the only selected one in its comp */
  const select = (L: any) => {
    for (const x of L._comp.layers) x.selected = false;
    L.selected = true;
  };
  let items: any[] = [];
  const log: string[] = [];
  const byName = (n: string) => items.find((i) => i.name === n);

  const mkFolder = (name: string): any => {
    const f: any = Object.assign(new FolderItem(), { id: nextId++, name, parentFolder: null });
    Object.defineProperty(f, "numItems", { get: () => items.filter((i) => i.parentFolder === f).length });
    f.remove = () => {
      items = items.filter((i) => i !== f);
      log.push(`remove folder ${f.name}`);
    };
    items.push(f);
    return f;
  };
  const usedIn = (it: any) => items.filter((c) => c instanceof CompItem && c.layers.some((l: any) => l.source === it));

  const mkComp = (s: Omit<SComp, "layers">): any => {
    const c: any = Object.assign(new CompItem(), {
      id: nextId++, name: s.name, width: s.width ?? 1920, height: s.height ?? 1080, pixelAspect: 1, duration: s.duration ?? 4, frameRate: s.fps ?? 25,
      motionBlur: !!s.motionBlur, shutterAngle: 180, shutterPhase: -90, motionBlurSamplesPerFrame: 16, motionBlurAdaptiveSampleLimit: 128, frameBlending: !!s.frameBlending,
      preserveNestedFrameRate: !!s.preserveFrameRate, preserveNestedResolution: false, motionGraphicsTemplateControllerCount: s.egp ?? 0, motionGraphicsTemplateName: s.egp ? s.name : "",
      workAreaStart: 0, workAreaDuration: s.duration ?? 4, layers: [] as any[], parentFolder: s.folder ? byName(s.folder) ?? mkFolder(s.folder) : null, selectedLayers: [],
    });
    Object.defineProperty(c, "frameDuration", { get: () => 1 / c.frameRate });
    Object.defineProperty(c, "numLayers", { get: () => c.layers.length });
    Object.defineProperty(c, "usedIn", { get: () => usedIn(c) });
    c.layer = (k: number | string) => (typeof k === "number" ? c.layers[k - 1] : c.layers.find((l: any) => l.name === k)) ?? null;
    c.layers.addNull = (dur?: number) => {
      const solid = Object.assign(new FootageItem(), { id: nextId++, name: `Null ${items.filter((i) => /^Null \d+$/.test(i.name)).length + 1}`, width: 100, height: 100, mainSource: new SolidSource(), parentFolder: null });
      Object.defineProperty(solid, "usedIn", { get: () => usedIn(solid) });
      solid.remove = () => void (items = items.filter((i) => i !== solid));
      items.push(solid);
      const L = mkLayer(c, { name: solid.name, type: "null", anchor: [50, 50], outPoint: dur ?? c.duration });
      L.source = solid;
      c.layers.unshift(L);
      select(L);
      log.push(`addNull ${c.name}`);
      return L;
    };
    c.duplicate = () => {
      const d = mkComp({ ...s, name: `${c.name} 2`, width: c.width, height: c.height, duration: c.duration, fps: c.frameRate });
      d.parentFolder = c.parentFolder;
      d.motionGraphicsTemplateControllerCount = c.motionGraphicsTemplateControllerCount;
      for (const L of c.layers) d.layers.push(cloneLayer(L, d));
      c.layers.forEach((L: any, i: number) => {
        if (L._parent) d.layers[i]._parent = d.layers[L._parent.index - 1];
        if (L._matte) d.layers[i]._matte = d.layers[L._matte.index - 1];
      });
      log.push(`duplicate ${c.name}`);
      return d;
    };
    c.remove = () => {
      items = items.filter((i) => i !== c);
      for (const o of items) if (o instanceof CompItem) for (const L of [...o.layers]) if (L.source === c) o.layers.splice(o.layers.indexOf(L), 1);
      log.push(`remove comp ${c.name}`);
    };
    items.push(c);
    return c;
  };

  function finish(L: any, comp: any, groups: any[]) {
    L.children = groups;
    L._comp = comp;
    Object.defineProperty(L, "numProperties", { get: () => L.children.length });
    L.property = (k: number | string) => (typeof k === "number" ? L.children[k - 1] : L.children.find((x: any) => x.name === k || x.matchName === k)) ?? null;
    groups.forEach((g: any, i: number) => Object.assign(g, { parentProperty: L, propertyIndex: i + 1 }));
    eachProp(L, (p) => (p._layer = L));
    return L;
  }

  function layerBase(Cls: any): any {
    const L: any = new Cls();
    L.id = nextId++;
    L.selected = false;
    const guard = (what: string) => {
      if (L.locked) throw new Error(`After Effects error: can't ${what}, the layer is locked.`);
    };
    let name = "";
    Object.defineProperty(L, "name", { get: () => name, set: (v: string) => (L.locked && name ? guard("rename") : (name = v)), enumerable: true });
    Object.defineProperty(L, "index", { get: () => L._comp.layers.indexOf(L) + 1 });
    Object.defineProperty(L, "inPoint", { get: () => L._in, set: (v: number) => (guard("trim"), (L._in = v)) });
    Object.defineProperty(L, "outPoint", { get: () => L._out, set: (v: number) => (guard("trim"), (L._out = v)) });
    Object.defineProperty(L, "startTime", {
      get: () => L._start,
      set: (v: number) => {
        guard("move");
        const d = v - L._start;
        L._start = v;
        L._in += d;
        L._out += d;
        eachProp(L, (p) => p._keys.forEach((k: any) => (k.t += d)));
      },
    });
    Object.defineProperty(L, "parent", {
      get: () => L._parent,
      set: (v: any) => {
        guard("parent");
        L._parent = v; // (After Effects compensates the transform here; the surgery uses setParentWithJump)
        log.push(`parent= ${L.name}`);
      },
    });
    Object.defineProperty(L, "trackMatteLayer", { get: () => L._matte });
    Object.defineProperty(L, "hasTrackMatte", { get: () => !!L._matte });
    Object.defineProperty(L, "isTrackMatte", { get: () => L._comp.layers.some((x: any) => x._matte === L) });
    Object.defineProperty(L, "hasAudio", { get: () => false });
    Object.defineProperty(L, "hasVideo", { get: () => true });
    L.setParentWithJump = (p: any) => {
      guard("parent");
      if (opts.jumpIgnored && p) return;
      L._parent = p ?? null;
    };
    L.setTrackMatte = (m: any, type: number) => {
      L._matte = m;
      L.trackMatteType = type;
    };
    L.removeTrackMatte = () => {
      L._matte = null;
      L.trackMatteType = TrackMatteType.NO_TRACK_MATTE;
    };
    L.moveBefore = (o: any) => {
      const a = L._comp.layers;
      a.splice(a.indexOf(L), 1);
      a.splice(a.indexOf(o), 0, L);
    };
    L.moveAfter = (o: any) => {
      const a = L._comp.layers;
      a.splice(a.indexOf(L), 1);
      a.splice(a.indexOf(o) + 1, 0, L);
    };
    L.remove = () => {
      guard("remove");
      const a = L._comp.layers;
      a.splice(a.indexOf(L), 1);
      for (const x of a) {
        if (x._parent === L) x._parent = null;
        if (x._matte === L) x._matte = null;
      }
      log.push(`remove layer ${L.name}`);
    };
    L.copyToComp = (into: any) => {
      if (groupOpen) {
        let linked = !!L._parent || !!L._matte;
        eachProp(L, (p) => (linked ||= p.expression !== "" || (p.propertyValueType === PVT.LAYER_INDEX && !!p._value)));
        if (linked) throw new Error("After Effects error: Can't copy a layer with a parent or with a linked expression, while an Undo Group is open.");
      }
      const c = cloneLayer(L, into);
      c._parent = null;
      c._matte = null;
      const sel = into.layers.findIndex((x: any) => x.selected);
      if (opts.copyInsert === "aboveSelection" && sel >= 0) into.layers.splice(sel, 0, c);
      else into.layers.unshift(c);
      select(c);
      log.push(`copyToComp ${L.name} -> ${into.name}`);
    };
    L.replaceSource = (src: any, fix: boolean) => {
      guard("replace source");
      L.source = src;
      log.push(`replaceSource ${L.name} -> ${src.name}${fix ? " (fix)" : ""}`);
    };
    L.sourceRectAtTime = () => {
      const r = L._rect ?? (L.source ? [0, 0, L.source.width, L.source.height] : [0, 0, 100, 100]);
      return { left: r[0], top: r[1], width: r[2], height: r[3] };
    };
    return L;
  }

  function cloneLayer(L: any, comp: any): any {
    const c = layerBase(L.constructor);
    for (const k of LAYER_FIELDS) if (k !== "name" && k !== "locked") c[k] = L[k];
    c.name = L.name;
    c.nullLayer = L.nullLayer;
    c._rect = L._rect;
    c._eps = L._eps;
    finish(c, comp, L.children.map(cloneTree));
    c.locked = L.locked;
    return c;
  }

  function mkLayer(comp: any, s: SLayer): any {
    const type = s.type ?? "solid";
    const Cls = type === "text" ? TextLayer : type === "shape" ? ShapeLayer : type === "camera" ? CameraLayer : AVLayer;
    const L = layerBase(Cls);
    const size = s.size ?? [200, 100];
    Object.assign(L, {
      enabled: s.enabled !== false, guideLayer: !!s.guide, solo: !!s.solo, threeDLayer: !!s.threeD, blendingMode: BlendingMode[s.blend ?? "NORMAL"], motionBlur: !!s.motionBlur,
      collapseTransformation: !!s.collapse, timeRemapEnabled: !!s.timeRemap, preserveTransparency: !!s.preserveTransparency, adjustmentLayer: type === "adjustment",
      frameBlendingType: FrameBlendingType.NO_FRAME_BLEND, autoOrient: AutoOrientType.NO_AUTO_ORIENT, trackMatteType: TrackMatteType.NO_TRACK_MATTE, label: 1,
      stretch: s.stretch ?? 100, nullLayer: type === "null", _in: s.inPoint ?? 0, _out: s.outPoint ?? comp.duration, _start: s.startTime ?? 0, _parent: null, _matte: null,
      _rect: s.rect ?? (type === "text" || type === "shape" ? [0, 0, size[0], size[1]] : undefined), _ident: `${comp.name}/${s.name}`, _eps: s.eps ?? 0,
      source: type === "precomp" ? byName(s.source!) : type === "solid" || type === "adjustment" ? { width: size[0], height: size[1], mainSource: new SolidSource() } : null,
    });
    L.name = s.name;
    const pos = prop("Position", "ADBE Position", PVT.TwoD_SPATIAL, s.position ?? [960, 540]);
    for (const [t, v] of s.keys?.position ?? []) pos.setValueAtTime(t, v);
    const sc = prop("Scale", "ADBE Scale", PVT.ThreeD, s.scale ?? [100, 100, 100]);
    for (const [t, v] of s.keys?.scale ?? []) sc.setValueAtTime(t, v);
    const op = prop("Opacity", "ADBE Opacity", PVT.OneD, s.opacity ?? 100);
    for (const [t, v] of s.keys?.opacity ?? []) op.setValueAtTime(t, v);
    const transform = group("Transform", "ADBE Transform Group", [
      prop("Anchor Point", "ADBE Anchor Point", PVT.TwoD_SPATIAL, s.anchor ?? (L.source ? [L.source.width / 2, L.source.height / 2] : [0, 0])),
      pos,
      prop("X Position", "ADBE Position_0", PVT.OneD, (s.position ?? [960, 540])[0]),
      prop("Y Position", "ADBE Position_1", PVT.OneD, (s.position ?? [960, 540])[1]),
      sc,
      prop("Rotation", "ADBE Rotate Z", PVT.OneD, s.rotation ?? 0),
      op,
    ]);
    const effects = group(
      "Effects", "ADBE Effect Parade",
      (s.effects ?? []).map((e) => group(e.name, e.layerParam !== undefined ? "ADBE Layer Control" : "ADBE Gaussian Blur 2", e.layerParam !== undefined ? [prop("Layer", "ADBE Layer Control-0001", PVT.LAYER_INDEX, e.layerParam)] : [prop("Blurriness", "ADBE Gaussian Blur 2-0001", PVT.OneD, 10)])),
      PT.INDEXED_GROUP,
    );
    const masks = group("Masks", "ADBE Mask Parade", Array.from({ length: s.masks ?? 0 }, (_, i) => group(`Mask ${i + 1}`, "ADBE Mask Atom", [])), PT.INDEXED_GROUP);
    const marker = prop("Marker", "ADBE Marker", PVT.MARKER, null);
    marker.canSetExpression = false;
    const overrides = group("Essential Properties", "ADBE Layer Overrides", Array.from({ length: s.eps ?? 0 }, (_, i) => prop(`EP ${i + 1}`, "ADBE Layer Override", PVT.OneD, 1)), PT.INDEXED_GROUP);
    finish(L, comp, [marker, transform, effects, masks, overrides]);
    for (const [path, e] of Object.entries(s.expr ?? {})) {
      const p = path.split("/").reduce((g: any, seg) => g.property(seg), L);
      const x = typeof e === "string" ? { x: e } : e;
      p.expression = x.x;
      p.expressionEnabled = x.on !== false;
      p.expressionError = x.err ?? "";
    }
    return L;
  }

  const comps = opts.comps.map((c) => mkComp(c));
  opts.comps.forEach((spec, i) => {
    const comp = comps[i];
    for (const ls of spec.layers) comp.layers.push(mkLayer(comp, ls));
    spec.layers.forEach((ls, j) => {
      const L = comp.layers[j];
      if (ls.parent) L._parent = comp.layer(ls.parent);
      if (ls.matte) {
        L._matte = comp.layer(ls.matte.layer);
        L.trackMatteType = TrackMatteType[ls.matte.type ?? "ALPHA"];
      }
      L.locked = !!ls.locked;
    });
  });
  log.length = 0;

  const project: any = {
    get numItems() {
      return items.length;
    },
    item: (i: number) => items[i - 1],
    itemByID: (id: number) => {
      const it = items.find((i) => i.id === id);
      if (!it) throw new Error("After Effects error: internal verification failure, sorry! {Item Not Found}");
      return it;
    },
    get activeItem() {
      return opts.active ? byName(opts.active) : comps[comps.length - 1];
    },
    file: opts.file === null ? null : { fsName: opts.file ?? "/projects/spot.aep", name: "spot.aep" },
    renderQueue: { get numItems() { return (opts.rq ?? []).length; }, item: (i: number) => ({ comp: byName(opts.rq![i - 1]) }) },
    items: { addFolder: (name: string) => (log.push(`addFolder ${name}`), mkFolder(name)) },
    bitsPerChannel: 8,
  };
  const app: any = { version: "26.5.0", project, beginSuppressDialogs() {}, endSuppressDialogs() {}, beginUndoGroup() {}, endUndoGroup() {}, effects: [] };
  const globals: Record<string, unknown> = {
    Item, CompItem, FootageItem, FolderItem, SolidSource, Layer, AVLayer, TextLayer, ShapeLayer, CameraLayer, LightLayer, PropertyBase,
    PropertyType: PT, PropertyValueType: PVT, BlendingMode, FrameBlendingType, TrackMatteType, AutoOrientType,
  };
  const $ = { global: { ...globals }, sleep() {} };
  const names = Object.keys(globals);
  const values = names.map((n) => globals[n]);
  const aemcp = new Function("$", "app", ...names, "var aemcp;\n" + helperSource + "\nreturn aemcp;")($, app, ...values);

  // ---------- undo: the whole project's state, restorable (what a rolled-back call leaves) ----------
  function snapshot() {
    const its = [...items];
    const cs = its.filter((i) => i instanceof CompItem).map((c) => ({ c, layers: [...c.layers], name: c.name, folder: c.parentFolder }));
    const ls = cs.flatMap((x) => x.layers).map((L) => {
      const f: Record<string, unknown> = {};
      for (const k of LAYER_FIELDS) f[k] = k === "name" ? L.name : L[k];
      const ps: any[] = [];
      eachProp(L, (p) => ps.push({ p, v: p._value, k: p._keys.map((k: any) => ({ ...k })), x: p.expression, on: p.expressionEnabled }));
      return { L, f, ps };
    });
    return () => {
      items = its;
      // the comp's own layers array (it carries addNull)
      for (const x of cs) {
        x.c.layers.splice(0, x.c.layers.length, ...x.layers);
        Object.assign(x.c, { name: x.name, parentFolder: x.folder });
      }
      for (const { L, f, ps } of ls) {
        const lk = f.locked;
        L.locked = false;
        for (const k of LAYER_FIELDS) if (k !== "locked") (L as any)[k === "name" ? "name" : k] = f[k];
        for (const s of ps) {
          s.p._value = s.v;
          s.p._keys = s.k;
          s.p.expression = s.x;
          s.p.expressionEnabled = s.on;
        }
        L.locked = lk;
      }
    };
  }

  /** a JSX body run like the bridge does; `rollback: "requested"` puts the project back when the body asks for it */
  const run = (jsx: string, args: Record<string, unknown>, o: { rollback?: string; undoGroup?: string | false } = {}) => {
    const restore = snapshot();
    const fn = new Function("aemcp", "app", "$", ...names, `return function (args, log) {\n${jsx}\n};`)(aemcp, app, $, ...values);
    groupOpen = !!o.undoGroup;
    let res: any;
    try {
      res = JSON.parse(aemcp.run(fn, args, { undoGroup: false, depth: 10 }));
    } finally {
      groupOpen = false;
    }
    if (o.rollback === "requested" && res.ok && res.result?.rollback) {
      restore();
      res.rollback = { undone: true, verified: true };
    }
    return res;
  };

  /** A state of the whole project, for "nothing changed" checks. */
  const state = () =>
    JSON.stringify(
      items.map((i) => ({
        id: i.id, name: i.name, kind: i.constructor.name, folder: i.parentFolder?.name ?? null,
        layers: i instanceof CompItem ? i.layers.map((L: any) => {
          const ps: any[] = [];
          eachProp(L, (p) => ps.push([p.matchName, p._value, p._keys, p.expression, p.expressionEnabled]));
          return [L.name, L.index, L.enabled, L.inPoint, L.outPoint, L.startTime, L.parent?.index ?? 0, L.source?.id ?? null, L.blendingMode, L._matte?.index ?? 0, ps];
        }) : undefined,
      })),
    );

  // ---------- the picture ----------
  type M = number[];
  const mul = (A: M, B: M): M => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
  const local = (L: any, t: number): M => {
    const g = L.property("ADBE Transform Group"), v = (m: string) => g.property(m).valueAtTime(t);
    const a = v("ADBE Anchor Point"), s = v("ADBE Scale"), r = (v("ADBE Rotate Z") * Math.PI) / 180;
    const pp = g.property("ADBE Position"), p = pp.dimensionsSeparated ? [v("ADBE Position_0"), v("ADBE Position_1")] : v("ADBE Position");
    const cs = Math.cos(r), sn = Math.sin(r), m0 = (cs * s[0]) / 100, m1 = (sn * s[0]) / 100, m2 = (-sn * s[1]) / 100, m3 = (cs * s[1]) / 100;
    return [m0, m1, m2, m3, p[0] - (m0 * a[0] + m2 * a[1]), p[1] - (m1 * a[0] + m3 * a[1])];
  };
  const world = (L: any, t: number): M => (L.parent ? mul(world(L.parent, t), local(L, t)) : local(L, t));
  function leaves(comp: any, t: number, M0: M, op: number, out: string[]) {
    for (let i = comp.layers.length - 1; i >= 0; i--) {
      const L = comp.layers[i];
      if (!L.enabled || L.guideLayer || L.nullLayer || L instanceof CameraLayer || t < L.inPoint || t >= L.outPoint) continue;
      const W = mul(M0, world(L, t)), o = op * (L.property("ADBE Transform Group").property("ADBE Opacity").valueAtTime(t) / 100);
      if (L.source instanceof CompItem) leaves(L.source, t - L.startTime, W, o, out);
      else out.push([L._ident, ...W.map((x) => Math.round(x * 1e6) / 1e6), Math.round(o * 1e6) / 1e6, L.blendingMode].join(","));
    }
  }
  /** what a comp shows at time t, as a string (equal strings: the same picture) */
  const picture = (comp: any, t: number) => {
    const out: string[] = [];
    leaves(comp, t, [1, 0, 0, 1, 0, 0], 1, out);
    return out.join("|");
  };

  const comp = (name: string): any => items.find((i) => i instanceof CompItem && i.name === name);
  const items_ = () => items;
  return { app, run, state, picture, comp, items: items_, log };
}
