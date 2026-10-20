// A fake After Effects project for ae_reformat: several comps (precomps shown through layers), layers with the
// faithful keyframe model of fake-keys.ts (Position, Scale, Anchor Point, ease, spatial tangents), text, track
// mattes, parents, locked layers, comp.duplicate(), layer.replaceSource() and writable comp size / frame rate.
// The real Preflight reader (PREFLIGHT_JSX), and the reformat's tree reader and apply script, run against it.
// What it copies from After Effects:
// - text and shape layers are NOT AVLayer subclasses; a camera's Point of Interest is its "ADBE Anchor Point"
// - a locked layer's properties can't be changed by a script (setting one throws)
// - comp.duplicate() copies the layers and keys; precomp layers keep showing the same precomp
// - setting comp.width / height doesn't move any layer
import { helperSource } from "../src/jsx.js";
import { KeyframeEase, KIT, makeProp, PVT } from "./fake-keys.js";

class Item {}
class CompItem extends Item {}
class FootageItem extends Item {}
class SolidSource {}
class Layer {}
class AVLayer extends Layer {}
class TextLayer extends Layer {}
class ShapeLayer extends Layer {}
class CameraLayer extends Layer {}
class LightLayer extends Layer {}
class PropertyBase {}
const PT = { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 };
const AutoOrientType = { NO_AUTO_ORIENT: 4212, ALONG_PATH: 4213 };

export interface RLayer {
  name: string;
  type?: "solid" | "text" | "shape" | "null" | "precomp" | "footage" | "camera";
  /** a comp or footage item name (precomp / footage layers) */
  source?: string;
  /** sourceRectAtTime [left, top, width, height] (default: text [0,-50,400,60]; solids, footage and precomps their size) */
  rect?: number[];
  anchor?: number[];
  position?: number[];
  scale?: number[];
  rotation?: number;
  opacity?: number;
  parent?: string;
  threeD?: boolean;
  locked?: boolean;
  enabled?: boolean;
  separated?: boolean;
  positionExpression?: string;
  scaleExpression?: string;
  text?: string;
  fontSize?: number;
  /** the layer used as this layer's track matte */
  matte?: string;
  inPoint?: number;
  outPoint?: number;
  /** keys as [time, value] */
  keys?: { position?: [number, number[]][]; scale?: [number, number[]][]; x?: [number, number][]; y?: [number, number][] };
}
export interface RComp {
  name: string;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  layers: RLayer[];
}

function group(name: string, matchName: string, children: any[], type = PT.NAMED_GROUP): any {
  const g: any = Object.assign(new PropertyBase(), { name, matchName, propertyType: type, children });
  Object.defineProperty(g, "numProperties", { get: () => g.children.length });
  g.property = (k: number | string) => (typeof k === "number" ? g.children[k - 1] : g.children.find((c: any) => c.name === k || c.matchName === k)) ?? null;
  for (const [i, c] of children.entries()) Object.assign(c, { parentProperty: g, propertyIndex: i + 1 });
  return g;
}

/** a copy of a property with its keys (eases as After Effects reports them) */
function cloneProp(p: any, log: string[]): any {
  const q = makeProp(p.name, p.matchName, p.propertyValueType, p.numKeys ? p.keyValue(1) : p.value, log);
  for (const k of p._keys) {
    const e = (list: KeyframeEase[]) => list.map((x) => Object.assign(Object.create(KeyframeEase.prototype), { speed: x.speed, influence: x.influence }));
    q._keys.push({ ...k, v: Array.isArray(k.v) ? k.v.slice() : k.v, inE: e(k.inE), outE: e(k.outE), inTan: k.inTan.slice(), outTan: k.outTan.slice() });
  }
  Object.assign(q, { expression: p.expression, expressionEnabled: p.expressionEnabled, dimensionsSeparated: p.dimensionsSeparated });
  return q;
}
function cloneTree(g: any, log: string[]): any {
  if (g.propertyType === PT.PROPERTY) return cloneProp(g, log);
  return group(g.name, g.matchName, g.children.map((c: any) => cloneTree(c, log)), g.propertyType);
}

/** every property of a locked layer refuses changes, as in After Effects */
function guard(L: any, g: any) {
  for (const c of g.children ?? []) {
    if (c.propertyType !== PT.PROPERTY) {
      guard(L, c);
      continue;
    }
    for (const m of ["setValue", "setValueAtKey", "setValueAtTime", "setSpatialTangentsAtKey", "setTemporalEaseAtKey"]) {
      const f = c[m];
      c[m] = (...a: any[]) => {
        if (L.locked) throw new Error("After Effects error: Unable to set value, the layer is locked.");
        return f(...a);
      };
    }
  }
}

export function fakeReformatAE(opts: { comps: RComp[]; footage?: { name: string; width: number; height: number }[]; active?: string }) {
  const log: string[] = [];
  const items: any[] = [];
  let nextId = 1;
  const byName = (n: string) => items.find((i) => i.name === n);

  const mkComp = (name: string, w: number, h: number, fps: number, dur: number): any => {
    const c: any = Object.assign(new CompItem(), { id: nextId++, name, width: w, height: h, pixelAspect: 1, duration: dur, time: 0, displayStartTime: 0, layers: [] as any[], selectedLayers: [] });
    let rate = fps;
    Object.defineProperty(c, "frameRate", { get: () => rate, set: (v: number) => void (rate = v), enumerable: true });
    Object.defineProperty(c, "frameDuration", { get: () => 1 / rate });
    Object.defineProperty(c, "numLayers", { get: () => c.layers.length });
    c.layer = (k: number | string) => (typeof k === "number" ? c.layers[k - 1] : c.layers.find((l: any) => l.name === k)) ?? null;
    c.duplicate = () => {
      const d = mkComp(`${c.name} 2`, c.width, c.height, rate, c.duration);
      for (const L of c.layers) d.layers.push(cloneLayer(L, d));
      d.layers.forEach((l: any, i: number) => (l.index = i + 1));
      c.layers.forEach((L: any, i: number) => {
        if (L.parent) d.layers[i].parent = d.layers[L.parent.index - 1];
        if (L.trackMatteLayer) d.layers[i].trackMatteLayer = d.layers[L.trackMatteLayer.index - 1];
      });
      log.push(`duplicate ${c.name}`);
      return d;
    };
    items.push(c);
    return c;
  };
  const finish = (L: any, children: any[]) => {
    L.children = children;
    Object.defineProperty(L, "numProperties", { get: () => L.children.length });
    L.property = (k: number | string) => (typeof k === "number" ? L.children[k - 1] : L.children.find((x: any) => x.name === k || x.matchName === k)) ?? null;
    L.replaceSource = (src: any) => {
      L.source = src;
      log.push(`replaceSource ${L.name} -> ${src.name}`);
    };
    L.sourceRectAtTime = () => {
      const r = L._rect ?? (L.source ? [0, 0, L.source.width, L.source.height] : [0, 0, 100, 100]);
      return { left: r[0], top: r[1], width: r[2], height: r[3] };
    };
    for (const g of children) guard(L, g);
    return L;
  };
  function cloneLayer(L: any, comp: any): any {
    const Cls = L.constructor;
    const copy: any = Object.assign(new Cls(), {
      name: L.name, enabled: L.enabled, locked: L.locked, threeDLayer: L.threeDLayer, nullLayer: L.nullLayer, adjustmentLayer: false, guideLayer: false,
      inPoint: L.inPoint, outPoint: L.outPoint, startTime: 0, stretch: 100, source: L.source, collapseTransformation: false, timeRemapEnabled: false,
      autoOrient: AutoOrientType.NO_AUTO_ORIENT, isTrackMatte: L.isTrackMatte, hasTrackMatte: L.hasTrackMatte, trackMatteLayer: null, parent: null, _rect: L._rect, _comp: comp,
    });
    return finish(copy, L.children.map((g: any) => cloneTree(g, log)));
  }

  for (const f of opts.footage ?? []) items.push(Object.assign(new FootageItem(), { id: nextId++, name: f.name, width: f.width, height: f.height, mainSource: {} }));
  const comps = opts.comps.map((c) => mkComp(c.name, c.width ?? 1920, c.height ?? 1080, c.fps ?? 25, c.duration ?? 2));
  opts.comps.forEach((spec, ci) => {
    const comp = comps[ci];
    for (const ls of spec.layers) {
      const type = ls.type ?? "solid";
      const Cls = type === "text" ? TextLayer : type === "shape" ? ShapeLayer : type === "camera" ? CameraLayer : AVLayer;
      const pv = ls.position ?? [960, 540];
      const pos = makeProp("Position", "ADBE Position", ls.threeD || type === "camera" ? PVT.ThreeD_SPATIAL : PVT.TwoD_SPATIAL, [pv[0], pv[1], pv[2] ?? 0], log);
      const xp = makeProp("X Position", "ADBE Position_0", PVT.OneD, pv[0], log), yp = makeProp("Y Position", "ADBE Position_1", PVT.OneD, pv[1], log);
      pos.dimensionsSeparated = !!ls.separated;
      if (ls.positionExpression) Object.assign(ls.separated ? xp : pos, { expression: ls.positionExpression, expressionEnabled: true });
      const sc = makeProp("Scale", "ADBE Scale", PVT.ThreeD, ls.scale ? [ls.scale[0], ls.scale[1], 100] : [100, 100, 100], log);
      if (ls.scaleExpression) Object.assign(sc, { expression: ls.scaleExpression, expressionEnabled: true });
      const an = makeProp(type === "camera" ? "Point of Interest" : "Anchor Point", "ADBE Anchor Point", PVT.TwoD_SPATIAL, ls.anchor ? [ls.anchor[0], ls.anchor[1], 0] : [0, 0, 0], log);
      for (const [t, v] of ls.keys?.position ?? []) pos.setValueAtTime(t, [v[0], v[1], 0]);
      for (const [t, v] of ls.keys?.scale ?? []) sc.setValueAtTime(t, [v[0], v[1], 100]);
      for (const [t, v] of ls.keys?.x ?? []) xp.setValueAtTime(t, v);
      for (const [t, v] of ls.keys?.y ?? []) yp.setValueAtTime(t, v);
      const children = [
        group("Transform", "ADBE Transform Group", [an, pos, xp, yp, sc, makeProp("Rotation", "ADBE Rotate Z", PVT.OneD, ls.rotation ?? 0, log), makeProp("Opacity", "ADBE Opacity", PVT.OneD, ls.opacity ?? 100, log)]),
        group("Effects", "ADBE Effect Parade", [], PT.INDEXED_GROUP),
      ];
      if (type === "text")
        children.push(
          group("Text", "ADBE Text Properties", [
            makeProp("Source Text", "ADBE Text Document", PVT.TEXT_DOCUMENT, { text: ls.text ?? ls.name, fontSize: ls.fontSize ?? 50, font: "ArialMT" }, log),
            group("Animators", "ADBE Text Animators", [], PT.INDEXED_GROUP),
          ]),
        );
      const source = ls.source ? byName(ls.source) : undefined;
      const L: any = Object.assign(new Cls(), {
        name: ls.name, enabled: ls.enabled !== false, locked: false, threeDLayer: !!ls.threeD, nullLayer: type === "null", adjustmentLayer: false, guideLayer: false,
        inPoint: ls.inPoint ?? 0, outPoint: ls.outPoint ?? comp.duration, startTime: 0, stretch: 100, source: source ?? null, collapseTransformation: false, timeRemapEnabled: false,
        autoOrient: AutoOrientType.NO_AUTO_ORIENT, isTrackMatte: false, hasTrackMatte: false, trackMatteLayer: null, parent: null,
        _rect: ls.rect ?? (type === "text" ? [0, -50, 400, 60] : type === "null" ? [0, 0, 100, 100] : undefined), _comp: comp,
      });
      if (type === "solid" && !source) Object.assign(L, { source: { width: 1920, height: 1080, mainSource: new SolidSource() } });
      comp.layers.push(finish(L, children));
    }
    comp.layers.forEach((l: any, i: number) => (l.index = i + 1));
    spec.layers.forEach((ls, i) => {
      const L = comp.layers[i];
      if (ls.parent) L.parent = comp.layer(ls.parent);
      if (ls.matte) {
        const M = comp.layer(ls.matte);
        Object.assign(L, { hasTrackMatte: true, trackMatteLayer: M });
        M.isTrackMatte = true;
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
    itemByID: (id: number) => items.find((i) => i.id === id) ?? null,
    activeItem: opts.active ? byName(opts.active) : comps[0],
    bitsPerChannel: 8,
  };
  const app: any = { version: "26.5.0", project, beginSuppressDialogs() {}, endSuppressDialogs() {}, beginUndoGroup() {}, endUndoGroup() {}, effects: [] };
  const globals: Record<string, unknown> = {
    Item, CompItem, FootageItem, SolidSource, Layer, AVLayer, TextLayer, ShapeLayer, CameraLayer, LightLayer, PropertyBase, KeyframeEase,
    PropertyType: PT, PropertyValueType: PVT, KeyframeInterpolationType: KIT, AutoOrientType, TrackMatteType: { NO_TRACK_MATTE: 5012 },
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
  const comp = (name: string): any => items.find((i) => i instanceof CompItem && (i as any).name === name);
  const prop = (compName: string, layer: string, match: string) => {
    const L = comp(compName).layer(layer);
    for (const g of L.children) {
      const hit = g.children?.find((c: any) => c.matchName === match);
      if (hit) return hit;
    }
    throw new Error("no prop " + match);
  };
  return { app, items, run, comp, prop, log };
}
