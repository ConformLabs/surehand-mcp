// A fake After Effects with a faithful keyframe model, 2D layer transforms (toComp/fromComp through parents) and
// an expression probe, for the precision tools (keyframe tables, easing, retiming, measured layout, PNG export).
// What it copies from After Effects (checked against the scripting guide):
// - text and shape layers are NOT AVLayer subclasses; cameras and lights have no sourceRectAtTime
// - temporal ease: one KeyframeEase per side for 1D, spatial (Position...) and colors; 2 for TwoD; 3 for ThreeD;
//   setTemporalEaseAtKey throws on a wrong count or an influence outside 0.1..100
// - Position's value has 3 numbers also on 2D layers; spatial tangents need as many numbers as the value
// - setValue on a property with keyframes throws; roving can't be set on the first or last key
// - comp.layers.addText adds the new layer at the top (index 1); moveToEnd moves it to the bottom
import { helperSource } from "../src/jsx.js";

export const PVT = { NO_VALUE: 6412, ThreeD_SPATIAL: 6413, ThreeD: 6414, TwoD_SPATIAL: 6415, TwoD: 6416, OneD: 6417, COLOR: 6418, CUSTOM_VALUE: 6419, MARKER: 6420, LAYER_INDEX: 6421, MASK_INDEX: 6422, SHAPE: 6423, TEXT_DOCUMENT: 6424 };
export const KIT = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 };
const PT = { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 };

export class KeyframeEase {
  constructor(public speed: number, public influence: number) {}
}
class Item {}
class CompItem extends Item {}
class FootageItem extends Item {}
class Layer {}
class AVLayer extends Layer {}
class TextLayer extends Layer {}
class ShapeLayer extends Layer {}
class CameraLayer extends Layer {}
class LightLayer extends Layer {}
class PropertyBase {}

interface Key {
  t: number;
  v: any;
  inI: number;
  outI: number;
  inE: KeyframeEase[];
  outE: KeyframeEase[];
  tc: boolean;
  tab: boolean;
  sc: boolean;
  sab: boolean;
  inTan: number[];
  outTan: number[];
  roving: boolean;
  label: number;
  sel: boolean;
}

const easeDims = (vt: number) => (vt === PVT.TwoD ? 2 : vt === PVT.ThreeD ? 3 : 1);
const copyE = (a: KeyframeEase[]) => a.map((e) => new KeyframeEase(e.speed, e.influence));

export function makeProp(name: string, matchName: string, vt: number, value: any, log: string[] = []): any {
  const keys: Key[] = [];
  const spatial = vt === PVT.TwoD_SPATIAL || vt === PVT.ThreeD_SPATIAL;
  const dims = easeDims(vt);
  const chk = (i: number) => {
    if (!(i >= 1 && i <= keys.length)) throw new Error(`After Effects error: key index ${i} out of range`);
    return keys[i - 1];
  };
  const p: any = Object.assign(new PropertyBase(), {
    name, matchName, propertyType: PT.PROPERTY, propertyValueType: vt, isSpatial: spatial, canVaryOverTime: true, canSetExpression: true,
    expression: "", expressionEnabled: false, expressionError: "", dimensionsSeparated: false, parentProperty: null, _keys: keys,
    setValue(v: any) {
      if (keys.length) throw new Error("After Effects error: can't use setValue on a property with keyframes");
      log.push(`set ${name}`);
      value = v;
    },
    valueAtTime(t: number) {
      if (!keys.length) return value;
      if (t <= keys[0].t) return keys[0].v;
      for (let i = 0; i + 1 < keys.length; i++) {
        const a = keys[i], b = keys[i + 1];
        if (t <= b.t) {
          if (typeof a.v !== "number" && !Array.isArray(a.v)) return a.v;
          const u = (t - a.t) / (b.t - a.t);
          return Array.isArray(a.v) ? a.v.map((x: number, k: number) => x + (b.v[k] - x) * u) : a.v + (b.v - a.v) * u;
        }
      }
      return keys[keys.length - 1].v;
    },
    keyTime: (i: number) => chk(i).t,
    keyValue: (i: number) => (Array.isArray(chk(i).v) ? chk(i).v.slice() : chk(i).v),
    nearestKeyIndex(t: number) {
      if (!keys.length) throw new Error("After Effects error: no keyframes");
      let best = 0;
      for (let i = 1; i < keys.length; i++) if (Math.abs(keys[i].t - t) < Math.abs(keys[best].t - t)) best = i;
      return best + 1;
    },
    addKey(t: number) {
      const at = keys.findIndex((k) => Math.abs(k.t - t) < 1e-9);
      if (at >= 0) return at + 1;
      const v = p.valueAtTime(t);
      const k: Key = {
        t, v: Array.isArray(v) ? v.slice() : v, inI: KIT.LINEAR, outI: KIT.LINEAR,
        inE: Array.from({ length: dims }, () => new KeyframeEase(0, 16.666667)), outE: Array.from({ length: dims }, () => new KeyframeEase(0, 16.666667)),
        tc: false, tab: false, sc: spatial, sab: spatial, inTan: spatial ? [0, 0, 0] : [], outTan: spatial ? [0, 0, 0] : [], roving: false, label: 0, sel: false,
      };
      keys.push(k);
      keys.sort((a, b) => a.t - b.t);
      log.push(`addKey ${name} ${t}`);
      return keys.indexOf(k) + 1;
    },
    removeKey(i: number) {
      chk(i);
      const [k] = keys.splice(i - 1, 1);
      if (!keys.length) value = k.v;
      log.push(`removeKey ${name}`);
    },
    setValueAtTime(t: number, v: any) {
      p.setValueAtKey(p.addKey(t), v);
    },
    setValuesAtTimes(ts: number[], vs: any[]) {
      ts.forEach((t, i) => p.setValueAtTime(t, vs[i]));
    },
    setValueAtKey(i: number, v: any) {
      chk(i).v = Array.isArray(v) ? v.slice() : v;
      log.push(`setValueAtKey ${name} ${i}`);
    },
    keyInInterpolationType: (i: number) => chk(i).inI,
    keyOutInterpolationType: (i: number) => chk(i).outI,
    setInterpolationTypeAtKey(i: number, a: number, b?: number) {
      chk(i).inI = a;
      chk(i).outI = b ?? a;
    },
    keyInTemporalEase: (i: number) => copyE(chk(i).inE),
    keyOutTemporalEase: (i: number) => copyE(chk(i).outE),
    setTemporalEaseAtKey(i: number, a: KeyframeEase[], b?: KeyframeEase[]) {
      for (const list of [a, b ?? a]) {
        if (!Array.isArray(list) || list.length !== dims) throw new Error(`After Effects error: ease must be an array of ${dims} KeyframeEase`);
        for (const e of list) if (!(e.influence >= 0.1 && e.influence <= 100)) throw new Error("After Effects error: influence out of range");
      }
      chk(i).inE = copyE(a);
      chk(i).outE = copyE(b ?? a);
      chk(i).tab = false;
    },
    keyTemporalContinuous: (i: number) => chk(i).tc,
    setTemporalContinuousAtKey: (i: number, v: boolean) => void (chk(i).tc = v),
    keyTemporalAutoBezier: (i: number) => chk(i).tab,
    setTemporalAutoBezierAtKey: (i: number, v: boolean) => void (chk(i).tab = v),
    keyLabel: (i: number) => chk(i).label,
    setLabelAtKey: (i: number, v: number) => void (chk(i).label = v),
    keySelected: (i: number) => chk(i).sel,
    setSelectedAtKey: (i: number, v: boolean) => void (chk(i).sel = v),
  });
  // getters (Object.assign above would copy their current values)
  Object.defineProperty(p, "numKeys", { get: () => keys.length });
  Object.defineProperty(p, "value", { get: () => (keys.length ? p.valueAtTime(0, true) : value) });
  const notSpatial = () => {
    throw new Error("After Effects error: not a spatial property");
  };
  Object.assign(p, {
    keyInSpatialTangent: (i: number) => (spatial ? chk(i).inTan.slice() : notSpatial()),
    keyOutSpatialTangent: (i: number) => (spatial ? chk(i).outTan.slice() : notSpatial()),
    setSpatialTangentsAtKey(i: number, a: number[], b?: number[]) {
      if (!spatial) notSpatial();
      const n = Array.isArray(chk(i).v) ? chk(i).v.length : 1;
      if (a.length !== n || (b && b.length !== n)) throw new Error(`After Effects error: tangents need ${n} values`);
      chk(i).inTan = a.slice();
      chk(i).outTan = (b ?? a).slice();
    },
    keySpatialContinuous: (i: number) => (spatial ? chk(i).sc : notSpatial()),
    setSpatialContinuousAtKey: (i: number, v: boolean) => (spatial ? void (chk(i).sc = v) : notSpatial()),
    keySpatialAutoBezier: (i: number) => (spatial ? chk(i).sab : notSpatial()),
    setSpatialAutoBezierAtKey: (i: number, v: boolean) => (spatial ? void (chk(i).sab = v) : notSpatial()),
    keyRoving: (i: number) => (spatial ? chk(i).roving : notSpatial()),
    setRovingAtKey(i: number, v: boolean) {
      if (!spatial) notSpatial();
      if (v && (i === 1 || i === keys.length)) throw new Error("After Effects error: the first and last keyframes can't rove");
      chk(i).roving = v;
    },
  });
  return p;
}

function group(name: string, matchName: string, children: any[], type = PT.NAMED_GROUP): any {
  const g: any = Object.assign(new PropertyBase(), { name, matchName, propertyType: type, children });
  Object.defineProperty(g, "numProperties", { get: () => g.children.length });
  g.property = (k: number | string) => (typeof k === "number" ? g.children[k - 1] : g.children.find((c: any) => c.name === k || c.matchName === k)) ?? null;
  for (const [i, c] of children.entries()) Object.assign(c, { parentProperty: g, propertyIndex: i + 1 });
  return g;
}

export interface LayerSpec {
  name: string;
  type?: "solid" | "text" | "shape" | "camera" | "null";
  /** sourceRectAtTime: [left, top, width, height] */
  rect?: number[];
  anchor?: number[];
  position?: number[];
  scale?: number[];
  rotation?: number;
  parent?: string;
  threeD?: boolean;
  locked?: boolean;
  enabled?: boolean;
  separated?: boolean;
  positionExpression?: string;
}

export function fakeKeysAE(opts: { fps?: number; layers: LayerSpec[]; files?: string[]; footage?: { name: string; width: number; height: number; fps: number; duration: number }[] }) {
  const log: string[] = [];
  const files = new Set(opts.files ?? []);
  const saved: { comp: string; t: number; path: string; enabled: string[]; res: number[] }[] = [];
  class File {
    fsName: string;
    constructor(p: string) {
      this.fsName = p;
    }
    get exists() {
      return files.has(this.fsName);
    }
    get parent() {
      const dir = this.fsName.replace(/\/[^/]*$/, "");
      return { exists: true, create: () => true, fsName: dir };
    }
    remove() {
      files.delete(this.fsName);
      return true;
    }
  }
  const items: any[] = [];
  let nextId = 1;
  const mkComp = (name: string, w: number, h: number, par: number, dur: number, fps: number): any => {
    const c: any = Object.assign(new CompItem(), { id: nextId++, name, width: w, height: h, pixelAspect: par, duration: dur, time: 0, layers: [] as any[], resolutionFactor: [2, 2], selectedLayers: [] });
    let rate = fps;
    Object.defineProperty(c, "frameRate", { get: () => rate, set: (v: number) => void (rate = v) });
    Object.defineProperty(c, "frameDuration", { get: () => 1 / rate });
    Object.defineProperty(c, "numLayers", { get: () => c.layers.length });
    c.layer = (k: number | string) => (typeof k === "number" ? c.layers[k - 1] : c.layers.find((l: any) => l.name === k)) ?? null;
    c.saveFrameToPng = (t: number, f: File) => {
      files.add(f.fsName);
      saved.push({ comp: c.name, t, path: f.fsName, enabled: c.layers.filter((l: any) => l.enabled).map((l: any) => l.name), res: c.resolutionFactor.slice() });
    };
    c.remove = () => void items.splice(items.indexOf(c), 1);
    const reindex = () => c.layers.forEach((l: any, i: number) => (l.index = i + 1));
    c._reindex = reindex;
    c.layers.addText = () => {
      const st = makeProp("Source Text", "ADBE Text Document", PVT.TEXT_DOCUMENT, { text: "" });
      let expr = "";
      Object.defineProperty(st, "expression", { get: () => expr, set: (v: string) => void (expr = v) });
      st.valueAtTime = (t: number) => ({ text: String(evalExpression(c, expr, t)) });
      const tl: any = Object.assign(new TextLayer(), { name: "", enabled: true, locked: false, threeDLayer: false, parent: null, children: [group("Text", "ADBE Text Properties", [st])] });
      tl.property = (k: string) => tl.children.find((x: any) => x.name === k || x.matchName === k) ?? null;
      tl.moveToEnd = () => {
        c.layers.splice(c.layers.indexOf(tl), 1);
        c.layers.push(tl);
        reindex();
      };
      tl.remove = () => {
        c.layers.splice(c.layers.indexOf(tl), 1);
        reindex();
      };
      c.layers.unshift(tl);
      reindex();
      return tl;
    };
    c.layers.add = (src: any) => {
      const l: any = Object.assign(new AVLayer(), { name: src.name, source: src, enabled: true, locked: false, threeDLayer: false, parent: null });
      c.layers.unshift(l);
      reindex();
      return l;
    };
    items.push(c);
    return c;
  };
  const comp = mkComp("Main", 1920, 1080, 1, 10, opts.fps ?? 25);
  for (const f of opts.footage ?? []) items.push(Object.assign(new FootageItem(), { id: nextId++, name: f.name, width: f.width, height: f.height, pixelAspect: 1, frameRate: f.fps, duration: f.duration }));

  for (const ls of opts.layers) {
    const type = ls.type ?? "solid";
    const Cls = type === "text" ? TextLayer : type === "shape" ? ShapeLayer : type === "camera" ? CameraLayer : AVLayer;
    const posVal = ls.position ?? [960, 540, 0];
    const pos = makeProp("Position", "ADBE Position", ls.threeD ? PVT.ThreeD_SPATIAL : PVT.TwoD_SPATIAL, posVal.length === 2 ? [...posVal, 0] : posVal, log);
    if (ls.positionExpression) Object.assign(pos, { expression: ls.positionExpression, expressionEnabled: true });
    const xPos = makeProp("X Position", "ADBE Position_0", PVT.OneD, posVal[0], log), yPos = makeProp("Y Position", "ADBE Position_1", PVT.OneD, posVal[1], log);
    pos.dimensionsSeparated = !!ls.separated;
    const tr = group("Transform", "ADBE Transform Group", [
      makeProp("Anchor Point", "ADBE Anchor Point", PVT.TwoD_SPATIAL, ls.anchor ? [...ls.anchor, 0].slice(0, 3) : [0, 0, 0], log),
      pos, xPos, yPos,
      makeProp("Scale", "ADBE Scale", PVT.ThreeD, ls.scale ? [...ls.scale, 100].slice(0, 3) : [100, 100, 100], log),
      makeProp("Rotation", "ADBE Rotate Z", PVT.OneD, ls.rotation ?? 0, log),
      makeProp("Opacity", "ADBE Opacity", PVT.OneD, 100, log),
    ]);
    const fx = group("Effects", "ADBE Effect Parade", [], PT.INDEXED_GROUP);
    const children = [tr, fx];
    if (type === "shape") children.push(group("Contents", "ADBE Root Vectors Group", [], PT.INDEXED_GROUP));
    const L: any = Object.assign(new Cls(), {
      name: ls.name, enabled: ls.enabled !== false, locked: !!ls.locked, threeDLayer: !!ls.threeD, parent: null, children,
      inPoint: 0, outPoint: 10, startTime: 0, _rect: ls.rect ?? [0, 0, 100, 100], _type: type,
    });
    Object.defineProperty(L, "numProperties", { get: () => L.children.length });
    L.property = (k: number | string) => (typeof k === "number" ? L.children[k - 1] : L.children.find((x: any) => x.name === k || x.matchName === k)) ?? null;
    comp.layers.push(L);
  }
  comp._reindex();
  for (const ls of opts.layers) if (ls.parent) comp.layer(ls.name).parent = comp.layer(ls.parent);

  const project: any = {
    get numItems() {
      return items.length;
    },
    item: (i: number) => items[i - 1],
    itemByID: (id: number) => items.find((i) => i.id === id) ?? null,
    activeItem: comp,
    items: { addComp: (n: string, w: number, h: number, par: number, d: number, f: number) => mkComp(n, w, h, par, d, f) },
  };
  const app: any = { project, beginSuppressDialogs() {}, endSuppressDialogs() {}, beginUndoGroup() {}, endUndoGroup() {}, effects: [] };
  const globals: Record<string, unknown> = {
    Item, CompItem, FootageItem, Layer, AVLayer, TextLayer, ShapeLayer, CameraLayer, LightLayer, PropertyBase, KeyframeEase, File,
    PropertyType: PT, PropertyValueType: PVT, KeyframeInterpolationType: KIT, TrackMatteType: { NO_TRACK_MATTE: 5012 },
  };
  const $ = { global: { ...globals }, sleep() {} };
  const names = Object.keys(globals);
  const values = names.map((n) => globals[n]);
  const aemcp = new Function("$", "app", ...names, "var aemcp;\n" + helperSource + "\nreturn aemcp;")($, app, ...values);
  /** a tool's JSX body, run like the bridge does (no undo group), parsed result */
  const run = (jsx: string, args: Record<string, unknown>) => {
    const fn = new Function("aemcp", "app", "$", ...names, `return function (args, log) {\n${jsx}\n};`)(aemcp, app, $, ...values);
    return JSON.parse(aemcp.run(fn, args, { undoGroup: false }));
  };
  const prop = (layer: string, match: string) => {
    const L = comp.layer(layer);
    for (const g of L.children) {
      const hit = g.children?.find((c: any) => c.matchName === match);
      if (hit) return hit;
    }
    throw new Error("no prop " + match);
  };
  return { app, comp, items, run, prop, log, files, saved };
}

// ---------- 2D transforms and the expression probe ----------
type M = [number, number, number, number, number, number]; // a b c d e f: x' = a x + c y + e, y' = b x + d y + f
const mul = (m: M, n: M): M => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const ap = (m: M, p: number[]) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const inv = (m: M): M => {
  const det = m[0] * m[3] - m[1] * m[2];
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
};
function val(L: any, match: string, t: number) {
  const tr = L.property("ADBE Transform Group");
  const p = tr.property(match);
  if (match === "ADBE Position" && p.dimensionsSeparated) return [tr.property("ADBE Position_0").valueAtTime(t), tr.property("ADBE Position_1").valueAtTime(t)];
  return p.valueAtTime(t);
}
function matrix(L: any, t: number): M {
  const a = val(L, "ADBE Anchor Point", t), p = val(L, "ADBE Position", t), s = val(L, "ADBE Scale", t), r = (val(L, "ADBE Rotate Z", t) * Math.PI) / 180;
  const own = mul(mul([1, 0, 0, 1, p[0], p[1]], [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]), mul([s[0] / 100, 0, 0, s[1] / 100, 0, 0], [1, 0, 0, 1, -a[0], -a[1]]));
  return L.parent ? mul(matrix(L.parent, t), own) : own;
}
function exprLayer(L: any, t: number): any {
  return {
    sourceRectAtTime: () => {
      if (L._type === "camera") throw new Error("camera has no source");
      const r = L._rect;
      return { left: r[0], top: r[1], width: r[2], height: r[3] };
    },
    toComp: (pt: number[]) => ap(matrix(L, t), pt),
    fromComp: (pt: number[]) => ap(inv(matrix(L, t)), pt),
    hasParent: !!L.parent,
    parent: L.parent ? exprLayer(L.parent, t) : null,
  };
}
function evalExpression(c: any, expr: string, t: number): unknown {
  const thisComp = { layer: (i: number) => exprLayer(c.layer(i), t) };
  return new Function("thisComp", "time", "__e", "return eval(__e)")(thisComp, t, expr);
}
