// A small fake After Effects for running the real helper library (aemcp.jsxinc) in tests: one comp,
// one layer, one Opacity property (optionally a second comp "Other" with its own layer and Opacity),
// project folders, app.project.revision, and an undo stack that behaves like AE's (checked in AE 2025
// and 2026): an undo group becomes one undo step only if something changed in it (so writing a value
// that is already set moves the revision but leaves no undo step), an edit outside a group is a step of
// its own, an extra endUndoGroup() closes the group early, and Edit > Undo moves the revision forward
// (it doesn't restore it).
import { existsSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { helperSource } from "../src/jsx.js";

class CompItem {}
class FolderItem {}
class FootageItem {}
class SolidSource {}
class PlaceholderSource {}
class AVLayer {}
const PropertyType = { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 };
const PropertyValueType = { NO_VALUE: 6412, OneD: 6417, TEXT_DOCUMENT: 6420 };
export const BlendingMode = { NORMAL: 5212, ADD: 5220 };
export const MaskMode = { NONE: 6812, ADD: 6813, SUBTRACT: 6814, INTERSECT: 6815 };
export const MaskFeatherFalloff = { FFO_LINEAR: 7213, FFO_SMOOTH: 7212 };
export const MaskMotionBlur = { SAME_AS_LAYER: 7012, ON: 7013, OFF: 7014 };
const TrackMatteType = { NO_TRACK_MATTE: 5012 };

interface State { opacity: number[]; blend: number; layerLabel: number; compLabel: number; comment: string; folders: { id: number; name: string }[] }

export interface Fake {
  app: any;
  comp: any;
  layer: any;
  opacity: any;
  /** the layer's mask ("Masks/Mask 1": maskMode, inverted...; setting one is an edit), only with { mask: true } */
  mask?: any;
  /** the second comp ("Other", not active), only with { otherComp: true } */
  other?: { comp: any; layer: any; opacity: any };
  /** property values read so far (what makes a snapshot slow) */
  reads: { n: number };
  /** an edit: bumps the revision like AE does (outside an undo group it is an undo step of its own) */
  edit: (f: () => void) => void;
  /** the undo steps, oldest first (their names) */
  undoStack: () => string[];
  /** how many times Edit > Undo ran */
  undos: { n: number };
  /** names of the project's folders */
  folders: () => string[];
}

/**
 * revision: false = an AE without app.project.revision; undoWorks: false = Edit > Undo does nothing;
 * otherComp: a second comp; bigComp: the layer has more properties than a snapshot reads (partial);
 * mask: the layer has one mask; renameFails: renaming a folder silently keeps its name; throwAfterUndo: the first look at the project's
 * items after Edit > Undo throws (once); writeAccess: "Allow Scripts to Write Files and Access Network" (fakeWriteAccess;
 * default: app has no preferences, so the setting can't be told).
 */
export function fakeAE(
  opts: { revision?: boolean; undoWorks?: boolean; otherComp?: boolean; bigComp?: boolean; mask?: boolean; renameFails?: boolean; throwAfterUndo?: boolean; writeAccess?: boolean | "unreadable" } = {},
): Fake {
  const reads = { n: 0 };
  const undos = { n: 0 };
  let revision = 1;
  const opacityValues = [100, 100];
  const makeOpacity = (i: number): any => ({
    name: "Opacity",
    propertyType: PropertyType.PROPERTY,
    propertyValueType: PropertyValueType.OneD,
    canSetExpression: true,
    expression: "",
    numKeys: 0,
    get value() {
      reads.n++;
      return opacityValues[i];
    },
    set value(v: number) {
      edit(() => (opacityValues[i] = v));
    },
    setValue(v: number) {
      this.value = v;
    },
  });
  const makeMask = (): any => {
    const m: any = { name: "Mask 1", matchName: "ADBE Mask Atom", propertyType: PropertyType.NAMED_GROUP, numProperties: 0, property: () => null };
    const attrs: Record<string, unknown> = { maskMode: MaskMode.ADD, inverted: false, maskFeatherFalloff: MaskFeatherFalloff.FFO_SMOOTH, maskMotionBlur: MaskMotionBlur.SAME_AS_LAYER, rotoBezier: false, locked: false, color: [0.5, 0.25, 1] };
    for (const k of Object.keys(attrs))
      Object.defineProperty(m, k, { get: () => attrs[k], set: (v) => edit(() => (attrs[k] = v)), enumerable: true });
    return m;
  };
  const mask = opts.mask ? makeMask() : undefined;
  const makeLayer = (id: number, name: string, opacity: any, withMask = false): any => {
    const transform: any = { name: "Transform", propertyType: PropertyType.NAMED_GROUP, numProperties: opts.bigComp ? 30_000 : 1, property: () => opacity };
    const groups = [transform];
    if (withMask) groups.push({ name: "Masks", matchName: "ADBE Mask Parade", propertyType: PropertyType.INDEXED_GROUP, numProperties: 1, property: () => mask });
    return Object.assign(new AVLayer(), {
      id, name, inPoint: 0, outPoint: 4, startTime: 0, stretch: 100, parent: null, enabled: true, solo: false, locked: false,
      shy: false, label: 1, threeDLayer: false, blendingMode: BlendingMode.NORMAL, trackMatteType: TrackMatteType.NO_TRACK_MATTE,
      adjustmentLayer: false, motionBlur: false, guideLayer: false, audioEnabled: false, numProperties: groups.length, property: (i: number) => groups[i - 1],
    });
  };
  const makeComp = (id: number, name: string, layer: any): any =>
    Object.assign(new CompItem(), {
      id, name, parentFolder: { name: "Root" }, label: 1, comment: "", width: 1920, height: 1080, duration: 4, frameRate: 25,
      pixelAspect: 1, bgColor: [0, 0, 0], workAreaStart: 0, workAreaDuration: 4, numLayers: 1, useProxy: false, time: 0,
      layer: () => layer,
    });
  const opacity = makeOpacity(0);
  const layer = makeLayer(7, "BG", opacity, !!opts.mask);
  const comp = makeComp(1, "Main", layer);
  let other: Fake["other"];
  if (opts.otherComp) {
    const op2 = makeOpacity(1), l2 = makeLayer(8, "FG", op2);
    other = { comp: makeComp(2, "Other", l2), layer: l2, opacity: op2 };
  }

  // folders: what the rollback sentinel is made of
  let nextId = 100;
  let folders: { id: number; name: string }[] = [];
  const folderItem = (f: { id: number; name: string }): any => {
    const it: any = Object.assign(new FolderItem(), { id: f.id, parentFolder: { name: "Root" }, label: 0, comment: "", numItems: 0 });
    Object.defineProperty(it, "name", {
      get: () => folders.find((x) => x.id === f.id)?.name ?? f.name,
      set: (v: string) => {
        if (!opts.renameFails) edit(() => (folders = folders.map((x) => (x.id === f.id ? { ...x, name: v } : x))));
      },
    });
    it.remove = () => edit(() => (folders = folders.filter((x) => x.id !== f.id)));
    return it;
  };
  const items = () => [comp, ...(other ? [other.comp] : []), ...folders.map(folderItem)];
  let throwNext = false;
  const project: any = {
    get numItems() {
      if (throwNext) {
        throwNext = false;
        throw new Error("project busy");
      }
      return items().length;
    },
    item: (i: number) => items()[i - 1],
    itemByID: (id: number) => items().find((it) => it.id === id) ?? null,
    activeItem: comp,
    bitsPerChannel: 8,
    items: {
      addFolder(name: string) {
        const f = { id: nextId++, name };
        edit(() => (folders = [...folders, f]));
        return folderItem(f);
      },
    },
  };
  if (opts.revision !== false) Object.defineProperty(project, "revision", { get: () => revision });

  // ---------- undo ----------
  const state = (): State => ({ opacity: [...opacityValues], blend: layer.blendingMode, layerLabel: layer.label, compLabel: comp.label, comment: comp.comment, folders: [...folders] });
  const restore = (s: State) => {
    opacityValues.splice(0, 2, ...s.opacity);
    layer.blendingMode = s.blend;
    layer.label = s.layerLabel;
    comp.label = s.compLabel;
    comp.comment = s.comment;
    folders = [...s.folders];
  };
  const same = (a: State, b: State) => JSON.stringify(a) === JSON.stringify(b);
  const stack: { name: string; before: State; moved: boolean }[] = [];
  let group: { name: string; before: State; rev: number } | null = null;
  const app: any = {
    project,
    beginSuppressDialogs() {},
    endSuppressDialogs() {},
    beginUndoGroup(name: string) {
      if (!group) group = { name, before: state(), rev: revision }; // nested groups fold into the outer one
    },
    endUndoGroup() {
      if (!group) return;
      if (!same(group.before, state())) stack.push({ name: group.name, before: group.before, moved: revision !== group.rev });
      group = null;
    },
    executeCommand(id: number) {
      if (id === 16 && opts.throwAfterUndo) throwNext = true;
      if (id !== 16 || opts.undoWorks === false) return;
      undos.n++;
      const step = stack.pop();
      if (!step) return;
      restore(step.before);
      if (step.moved) revision++;
    },
  };
  if (opts.writeAccess !== undefined) app.preferences = fakeWriteAccess(opts.writeAccess).preferences;
  function edit(f: () => void) {
    const before = state(), rev = revision;
    f();
    if (revision !== rev) return; // an edit inside (setting the value) counted already
    revision++;
    if (!group) stack.push({ name: "(edit)", before, moved: true });
  }
  return { app, comp, layer, opacity, mask, other, reads, edit, undoStack: () => stack.map((s) => s.name), undos, folders: () => folders.map((f) => f.name) };
}

/**
 * After Effects' "Allow Scripts to Write Files and Access Network" (Settings > Scripting & Expressions): on, off,
 * or "unreadable" (the preference can't be read). As measured in AE 26.5 through the CEP bridge: off, scripts can
 * still read and write files (so File and Folder are not modelled here), but system.callSystem throws.
 * `preferences` goes on app; `system` is the ExtendScript global.
 */
export function fakeWriteAccess(state: boolean | "unreadable") {
  const preferences = {
    getPrefAsLong(section: string, key: string) {
      if (state !== "unreadable" && section === "Main Pref Section" && key === "Pref_SCRIPTING_FILE_NETWORK_SECURITY") return state ? 1 : 0;
      throw new Error(`After Effects error: preference "${key}" in section "${section}" could not be found`);
    },
  };
  const system = {
    callSystem(cmd: string) {
      if (state !== true) throw new Error("Permission denied (is Preferences > Scripting & Expressions > Allow Scripts to Write Files and Access Network enabled?)");
      return cmd.replace(/^echo /, "") + "\n";
    },
  };
  return { preferences, system };
}

/** The real helper library (aemcp.jsxinc), loaded into the fake After Effects. */
export function loadHelpers(f: Fake, extra: Record<string, unknown> = {}): any {
  const globals = { ...extra, CompItem, FolderItem, FootageItem, SolidSource, PlaceholderSource, AVLayer, PropertyType, PropertyValueType, BlendingMode, TrackMatteType, MaskMode, MaskFeatherFalloff, MaskMotionBlur };
  const names = Object.keys(globals);
  const $ = { global: { ...globals } };
  return new Function("$", "app", ...names, "var aemcp;\n" + helperSource + "\nreturn aemcp;")($, f.app, ...names.map((n) => (globals as any)[n]));
}

// ---------- a richer fake project, for read-only tools that walk the whole project (ae_project_xray) ----------
// Every object is wrapped in a Proxy that records writes, so a test can prove a tool changed nothing.

export interface FakeLayerSpec {
  name: string;
  type?: "text" | "shape" | "solid" | "null" | "adjustment" | "footage" | "precomp" | "camera";
  /** item name (footage or comp) */
  source?: string;
  enabled?: boolean;
  shy?: boolean;
  guide?: boolean;
  isTrackMatte?: boolean;
  /** 1-based index */
  parent?: number;
  effects?: { matchName: string; name: string; enabled?: boolean }[];
  /** property path ("Transform/Opacity", "Effects/Slider Control/Slider") -> expression */
  expressions?: Record<string, { expr: string; error?: string; enabled?: boolean }>;
  font?: string;
  scale?: number[];
  motionBlur?: boolean;
  threeD?: boolean;
  timeRemap?: boolean;
  collapse?: boolean;
  frameBlend?: "FRAME_MIX" | "PIXEL_MOTION";
  inPoint?: number;
  outPoint?: number;
  // geometry and text, for Preflight (defaults: anchor [0,0], position [960,540], rotation 0, opacity 100)
  anchor?: number[];
  position?: number[];
  rotation?: number;
  opacity?: number;
  startTime?: number;
  /** animated values by match name ("ADBE Position", "ADBE Opacity", "ADBE Text Document"...): value at a time */
  anim?: Record<string, (t: number) => unknown>;
  /** sourceRectAtTime [left, top, width, height] (default: text [0,-50,400,60], others the source size) */
  rect?: number[] | ((t: number, text: string) => number[]);
  /** text layers: the text (default: the layer name), font size (default 50), paragraph box overflow (or by the text shown) */
  text?: string;
  fontSize?: number;
  boxOverflow?: boolean | ((text: string) => boolean);
  /** text layers: fill colour (default white) */
  fillColor?: number[];
  /** more properties at a path ("Contents/Rectangle 1/Fill 1/Color"): value, type (PropertyValueType name), keyframes, expression */
  props?: Record<string, { value: unknown; type: string; keyed?: boolean; expression?: string }>;
  /** characters the text's font has no glyph for (the font gets hasGlyphsFor, as in AE 25.1+) */
  glyphsMissing?: string;
  /** per-character fonts (style runs, AE 24+ characterRange): the font of character i, and what it lacks */
  charFonts?: { font: string; missing?: string }[];
  /** auto-orient along the path */
  autoOrient?: boolean;
  /** reading threeDLayer throws */
  threeDThrows?: boolean;
}
export interface FakeCompSpec {
  name: string;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  layers: FakeLayerSpec[];
  motionBlur?: boolean;
  samples?: number;
  renderer?: string;
  /** Essential Graphics controllers (name, value and type of the Essential Property a precomp layer gets) */
  egp?: { name: string; value: unknown; type: string }[];
}
export interface FakeFootageSpec {
  name: string;
  kind?: "file" | "solid" | "placeholder";
  file?: string;
  missing?: boolean;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  still?: boolean;
  alpha?: boolean;
  proxy?: string;
}
export interface FakeProjectSpec {
  comps: FakeCompSpec[];
  footage?: FakeFootageSpec[];
  rq?: { comp: string; render: boolean }[];
  installedEffects?: { matchName: string; displayName: string }[];
  /** null: an After Effects without the font API */
  fonts?: { postScriptName: string; familyName: string; styleName: string; isSubstitute: boolean }[] | null;
  /** app.project.usedFonts: a font and the layers (by name) that use it; noIds: usedAt entries without layerID */
  usedFonts?: { ps: string; layers: string[]; noIds?: boolean }[];
  activeComp?: string;
  /** output module templates applyTemplate accepts (default: any) */
  outputModuleTemplates?: string[];
}

/** PropertyValueType with After Effects' own values. */
export const PVT_FULL = { NO_VALUE: 6412, ThreeD_SPATIAL: 6413, ThreeD: 6414, TwoD_SPATIAL: 6415, TwoD: 6416, OneD: 6417, COLOR: 6418, CUSTOM_VALUE: 6419, MARKER: 6420, LAYER_INDEX: 6421, MASK_INDEX: 6422, SHAPE: 6423, TEXT_DOCUMENT: 6424 };
const clone = <T>(v: T): T => (Array.isArray(v) ? (v.map(clone) as T) : v && typeof v === "object" ? (Object.defineProperties(Object.create(Object.getPrototypeOf(v)), Object.getOwnPropertyDescriptors(v)) as T) : v);

export function fakeProject(spec: FakeProjectSpec) {
  class Item {}
  class CompItem extends Item {}
  class FootageItem extends Item {}
  class FolderItem extends Item {}
  class FootageSource {}
  class FileSource extends FootageSource {}
  class SolidSource extends FootageSource {}
  class PlaceholderSource extends FootageSource {}
  class Layer {}
  class AVLayer extends Layer {}
  // as in After Effects: text and shape layers are NOT AVLayer subclasses (instanceof AVLayer is false)
  class TextLayer extends Layer {}
  class ShapeLayer extends Layer {}
  class CameraLayer extends Layer {}
  class LightLayer extends Layer {}
  class PropertyBase {}
  const globals: Record<string, unknown> = {
    File: Object.assign(
      function (this: any, path: string) {
        const full = resolvePath(String(path));
        return { fsName: full, name: basename(full), get exists() { return existsSync(full); } };
      },
      { decode: decodeURIComponent },
    ),
    ImportOptions: function (this: any, file: any) {
      this.file = file;
    },
    Item, CompItem, FootageItem, FolderItem, FootageSource, FileSource, SolidSource, PlaceholderSource, Layer, AVLayer, TextLayer, ShapeLayer, CameraLayer, LightLayer, PropertyBase,
    PropertyType, PropertyValueType: PVT_FULL, BlendingMode, TrackMatteType,
    AlphaMode: { IGNORE: 5412, STRAIGHT: 5413, PREMULTIPLIED: 5414 },
    RQItemStatus: { QUEUED: 3015, UNQUEUED: 3013, DONE: 3019 },
    AutoOrientType: { NO_AUTO_ORIENT: 4212, ALONG_PATH: 4213 },
    FrameBlendingType: { NO_FRAME_BLEND: 4012, FRAME_MIX: 4013, PIXEL_MOTION: 4014 },
  };
  const writes: string[] = [];
  const calls: string[] = [];
  const watch = <T extends object>(o: T, label: string): T =>
    new Proxy(o, {
      set(t, k, v) {
        writes.push(`${label}.${String(k)}`);
        (t as any)[k] = v;
        return true;
      },
    });
  const prop = (name: string, matchName: string, extra: Record<string, unknown> = {}, anim?: (t: number) => unknown) =>
    watch(
      Object.assign(new PropertyBase(), {
        name, matchName, propertyType: PropertyType.PROPERTY, canSetExpression: true, expression: "", expressionError: "", expressionEnabled: true, numKeys: anim ? 2 : 0,
        valueAtTime(this: any, t: number) {
          calls.push("valueAtTime");
          return anim ? anim(t) : this.value;
        },
        setValue(this: any, v: unknown) {
          if (this.numKeys > 0) throw new Error("After Effects error: can't use setValue on a property with keyframes");
          this.value = v;
        },
        ...extra,
      }),
      name,
    );
  const group = (name: string, matchName: string, children: any[], extra: Record<string, unknown> = {}): any => {
    const g: any = Object.assign(new PropertyBase(), { name, matchName, propertyType: PropertyType.NAMED_GROUP, children, ...extra });
    Object.defineProperty(g, "numProperties", { get: () => g.children.length });
    g.property = (k: number | string) => (typeof k === "number" ? g.children[k - 1] : g.children.find((c: any) => c.name === k || c.matchName === k)) ?? null;
    return watch(g, name);
  };

  const items: any[] = [];
  let nextId = 1;
  const root: any = Object.assign(new FolderItem(), { id: 0, name: "Root" });
  const byName = (n: string) => items.find((i) => i.name === n);
  for (const f of spec.footage ?? []) {
    const kind = f.kind ?? "file";
    const src = kind === "solid" ? new SolidSource() : kind === "placeholder" ? new PlaceholderSource() : new FileSource();
    Object.assign(src, { isStill: !!f.still, hasAlpha: !!f.alpha, alphaMode: globals.AlphaMode && (globals.AlphaMode as any).STRAIGHT, nativeFrameRate: f.fps ?? 25, missingFootagePath: f.missing ? f.file : "", conformFrameRate: 0 });
    const it: any = Object.assign(new FootageItem(), {
      id: nextId++, name: f.name, width: f.width ?? 1920, height: f.height ?? 1080, pixelAspect: 1, duration: f.duration ?? 10, frameRate: f.fps ?? 25,
      hasVideo: true, hasAudio: false, footageMissing: !!f.missing, file: f.file && !f.missing ? { fsName: f.file, exists: true } : null, mainSource: watch(src, "source"),
      useProxy: !!f.proxy, proxySource: f.proxy ? { file: { fsName: f.proxy, exists: false } } : null, usedIn: [],
    });
    items.push(watch(it, f.name));
  }
  const comps: any[] = [];
  const omTemplates = spec.outputModuleTemplates;
  const makeComp = (c: FakeCompSpec, name = c.name): any => {
    const it: any = Object.assign(new CompItem(), {
      id: nextId++, name, width: c.width ?? 1920, height: c.height ?? 1080, pixelAspect: 1, frameRate: c.fps ?? 25, duration: c.duration ?? 10,
      motionBlur: !!c.motionBlur, shutterAngle: 180, shutterPhase: -90, motionBlurSamplesPerFrame: c.samples ?? 16, motionBlurAdaptiveSampleLimit: 128,
      frameBlending: true, renderer: c.renderer ?? "ADBE Advanced 3d", usedIn: [], layers: [] as any[], time: 0, frameDuration: 1 / (c.fps ?? 25), displayStartTime: 0,
      bgColor: [0, 0, 0], workAreaStart: 0, workAreaDuration: c.duration ?? 10, parentFolder: root,
    });
    Object.defineProperty(it, "numLayers", { get: () => it.layers.length });
    it.layer = (k: number | string) => (typeof k === "number" ? it.layers[k - 1] : it.layers.find((l: any) => l.name === k)) ?? null;
    const egp = c.egp ?? [];
    it.motionGraphicsTemplateControllerCount = egp.length;
    it.getMotionGraphicsTemplateControllerName = (k: number) => egp[k - 1].name;
    // CompItem.duplicate: a new comp with copies of the layers and their current values (precomps stay shared)
    it.duplicate = () => {
      const d = makeComp(c, `${it.name} 2`);
      addLayers(d, c);
      it.layers.forEach((L: any, k: number) => copyInto(L, d.layers[k]));
      const w = watch(d, d.name);
      items.push(w);
      return w;
    };
    // comp.layers.add(item): a precomp layer, with the item's Essential Properties when it is a comp that has them
    it.layers.add = (item: any) => {
      const children: any[] = [group("Transform", "ADBE Transform Group", [prop("Scale", "ADBE Scale", { value: [100, 100, 100], propertyValueType: PVT_FULL.ThreeD })])];
      const L: any = Object.assign(new AVLayer(), { index: it.layers.length + 1, id: 1000 + nextId++, name: item.name, enabled: true, source: item, parent: null, inPoint: 0, outPoint: it.duration, startTime: 0, stretch: 100, children });
      L.property = (k: number | string) => (typeof k === "number" ? L.children[k - 1] : L.children.find((x: any) => x.name === k || x.matchName === k)) ?? null;
      const eg = item.__egp as FakeCompSpec["egp"];
      if (eg) L.essentialProperty = group("Essential Properties", "ADBE Layer Overrides", eg.map((e) => prop(e.name, e.name, { value: clone(e.value), propertyValueType: (PVT_FULL as any)[e.type] })));
      const w = watch(L, L.name);
      it.layers.push(w);
      return w;
    };
    it.__egp = c.egp;
    return it;
  };
  /** the values of a layer's properties (and its source) into the same layer of a duplicate */
  const copyInto = (a: any, b: any) => {
    b.source = a.source;
    const walk = (x: any, y: any) => {
      for (let k = 0; k < (x.children?.length ?? 0); k++) {
        const cx = x.children[k], cy = y.children[k];
        if (!cy) continue;
        if (cx.propertyType === PropertyType.PROPERTY) cy.value = clone(cx.value);
        else walk(cx, cy);
      }
    };
    walk(a, b);
  };
  const effectGroups = (l: FakeLayerSpec) =>
    (l.effects ?? []).map((e) => group(e.name, e.matchName, [], { enabled: e.enabled !== false }));
  const T = (n: string) => (PVT_FULL as any)[n];
  function addLayers(comp: any, c: FakeCompSpec) {
    c.layers.forEach((ls, li) => {
      const type = ls.type ?? "solid";
      const Cls = type === "text" ? TextLayer : type === "shape" ? ShapeLayer : type === "camera" ? CameraLayer : AVLayer;
      const source = ls.source ? byName(ls.source) : undefined;
      if (source && !source.usedIn.includes(comp)) source.usedIn.push(comp);
      const an = ls.anim ?? {};
      const transform = group("Transform", "ADBE Transform Group", [
        prop("Anchor Point", "ADBE Anchor Point", { value: clone(ls.anchor ?? [0, 0, 0]), propertyValueType: T("ThreeD_SPATIAL") }, an["ADBE Anchor Point"]),
        prop("Position", "ADBE Position", { value: clone(ls.position ?? [960, 540, 0]), propertyValueType: T("ThreeD_SPATIAL") }, an["ADBE Position"]),
        prop("Scale", "ADBE Scale", { value: clone(ls.scale ?? [100, 100, 100]), propertyValueType: T("ThreeD") }, an["ADBE Scale"]),
        prop("Z Rotation", "ADBE Rotate Z", { value: ls.rotation ?? 0, propertyValueType: T("OneD") }, an["ADBE Rotate Z"]),
        prop("Opacity", "ADBE Opacity", { value: ls.opacity ?? 100, propertyValueType: T("OneD") }, an["ADBE Opacity"]),
      ]);
      const children: any[] = [transform];
      if (type !== "camera") children.push(group("Effects", "ADBE Effect Parade", effectGroups(ls)));
      const fontObj = (ps: string, missing: string) => ({ postScriptName: ps, hasGlyphsFor: (ch: string) => !missing.includes(ch) });
      const doc = (text: string) => {
        const d: any = { font: ls.font ?? "ArialMT", text, fontSize: ls.fontSize ?? 50, boxText: ls.boxOverflow !== undefined, applyFill: true, fillColor: clone(ls.fillColor ?? [1, 1, 1]),
          ...(ls.glyphsMissing !== undefined ? { fontObject: fontObj(ls.font ?? "ArialMT", ls.glyphsMissing) } : {}),
          ...(ls.charFonts ? { characterRange: (i: number) => ({ font: ls.charFonts![i].font, fontObject: fontObj(ls.charFonts![i].font, ls.charFonts![i].missing ?? "") }) } : {}) };
        const bo = ls.boxOverflow;
        Object.defineProperty(d, "boxOverflow", { get() { return typeof bo === "function" ? bo(this.text) : bo; }, enumerable: true, configurable: true });
        return d;
      };
      const textAnim = an["ADBE Text Document"];
      if (type === "text") children.push(group("Text", "ADBE Text Properties", [prop("Source Text", "ADBE Text Document", { value: doc(ls.text ?? ls.name), propertyValueType: T("TEXT_DOCUMENT") }, textAnim && ((t: number) => doc(String(textAnim(t)))))]));
      const at = (path: string, leaf: (name: string) => any) => {
        const segs = path.split("/");
        let g: any = { children };
        for (const [k, s] of segs.entries()) {
          let next = g.children.find((x: any) => x.name === s);
          if (!next) {
            next = k === segs.length - 1 ? leaf(s) : group(s, s, []);
            g.children.push(next);
          }
          g = next;
        }
        return g;
      };
      for (const [path, p] of Object.entries(ls.props ?? {}))
        at(path, (s) => prop(s, s, { value: clone(p.value), propertyValueType: T(p.type), numKeys: p.keyed ? 2 : 0, ...(p.expression ? { expression: p.expression } : {}) }));
      for (const [path, e] of Object.entries(ls.expressions ?? {})) {
        const g = at(path, (s) => prop(s, s));
        Object.assign(g, { expression: e.expr, expressionError: e.error ?? "", expressionEnabled: e.enabled !== false });
      }
      const L: any = Object.assign(new Cls(), {
        index: li + 1, id: 1000 + nextId++, name: ls.name, enabled: ls.enabled !== false, shy: !!ls.shy, guideLayer: !!ls.guide, isTrackMatte: !!ls.isTrackMatte,
        nullLayer: type === "null", adjustmentLayer: type === "adjustment", source: source ?? null, collapseTransformation: !!ls.collapse, timeRemapEnabled: !!ls.timeRemap,
        frameBlendingType: ls.frameBlend ? (globals.FrameBlendingType as any)[ls.frameBlend] : (globals.FrameBlendingType as any).NO_FRAME_BLEND,
        motionBlur: !!ls.motionBlur, inPoint: ls.inPoint ?? 0, outPoint: ls.outPoint ?? comp.duration, parent: null, children,
        startTime: ls.startTime ?? 0, stretch: 100,
        sourceRectAtTime: (t: number) => {
          calls.push("sourceRectAtTime");
          const text = type === "text" ? String(L.property("ADBE Text Properties").property("ADBE Text Document").valueAtTime(t, false).text) : "";
          const src = L.source;
          const r = typeof ls.rect === "function" ? ls.rect(t, text) : (ls.rect ?? (type === "text" ? [0, -50, 400, 60] : [0, 0, src?.width ?? 100, src?.height ?? 100]));
          return { left: r[0], top: r[1], width: r[2], height: r[3] };
        },
        replaceSource(this: any, item: any) {
          this.source = item;
        },
      });
      Object.defineProperty(L, "threeDLayer", {
        get: () => {
          if (ls.threeDThrows) throw new Error("threeDLayer can't be read");
          return !!ls.threeD;
        },
        enumerable: true,
        configurable: true,
      });
      L.autoOrient = ls.autoOrient ? (globals.AutoOrientType as any).ALONG_PATH : (globals.AutoOrientType as any).NO_AUTO_ORIENT;
      L.blendingMode = BlendingMode.NORMAL;
      L.trackMatteType = TrackMatteType.NO_TRACK_MATTE;
      L.audioEnabled = false;
      Object.defineProperty(L, "numProperties", { get: () => L.children.length });
      L.property = (k: number | string) => (typeof k === "number" ? L.children[k - 1] : L.children.find((x: any) => x.name === k || x.matchName === k)) ?? null;
      comp.layers.push(watch(L, ls.name));
    });
    c.layers.forEach((ls, li) => {
      if (ls.parent) comp.layers[li].parent = comp.layers[ls.parent - 1];
    });
  }
  for (const c of spec.comps) {
    const it = makeComp(c);
    comps.push(it);
    items.push(watch(it, c.name));
  }
  spec.comps.forEach((c, ci) => addLayers(comps[ci], c));
  writes.length = 0; // setting up parents is not the tool's doing
  const imported: string[] = [];
  const RQS = globals.RQItemStatus as any;
  const rqItem = (comp: any, render: boolean, file: any): any => {
    const om: any = { name: "Lossless", file, applyTemplate(n: string) {
      if (omTemplates && !omTemplates.includes(n)) throw new Error(`After Effects error: no output module template named "${n}"`);
      om.name = n;
    } };
    const q: any = { comp, status: render ? RQS.QUEUED : RQS.UNQUEUED, outputModule: () => om, applyTemplate() {}, remove: () => rqItems.splice(rqItems.indexOf(q), 1) };
    Object.defineProperty(q, "render", { get: () => q.status === RQS.QUEUED, set: (v: boolean) => (q.status = v ? RQS.QUEUED : RQS.UNQUEUED), enumerable: true });
    return q;
  };
  const rqItems: any[] = (spec.rq ?? []).map((r) => rqItem(byName(r.comp), r.render, { fsName: `/renders/${r.comp}.mov` }));
  const rendered: string[] = [];
  const project: any = watch(
    {
      file: { name: "Inherited.aep", fsName: "/jobs/Inherited.aep" }, bitsPerChannel: 16, expressionEngine: "javascript-1.0",
      get numItems() { return items.length; },
      item: (i: number) => items[i - 1],
      itemByID: (id: number) => items.find((i) => i.id === id) ?? null,
      activeItem: spec.activeComp ? byName(spec.activeComp) : null,
      renderQueue: {
        get numItems() { return rqItems.length; },
        item: (i: number) => rqItems[i - 1],
        items: { add: (comp: any) => { const q = rqItem(comp, true, null); rqItems.push(q); return q; } },
        render: () => { for (const q of rqItems) if (q.render) { rendered.push(q.comp.name); q.status = RQS.DONE; } },
      },
      items: {
        addFolder: (name: string) => { const f = watch(Object.assign(new FolderItem(), { id: nextId++, name, parentFolder: root }), name); items.push(f); return f; },
        addComp: (name: string, w: number, h: number, _par: number, dur: number, fps: number) => {
          const c = makeComp({ name, width: w, height: h, duration: dur, fps, layers: [] });
          const wc = watch(c, name);
          items.push(wc);
          return wc;
        },
      },
      importFile: (o: any) => {
        const f = o.file;
        if (!f.exists) throw new Error(`After Effects error: file "${f.fsName}" can't be imported: it doesn't exist`);
        const it = watch(Object.assign(new FootageItem(), { id: nextId++, name: f.name, width: 1920, height: 1080, file: { fsName: f.fsName, exists: true }, footageMissing: false, mainSource: new FileSource(), usedIn: [], parentFolder: root }), f.name);
        items.push(it);
        imported.push(f.fsName);
        return it;
      },
    },
    "project",
  );
  const app: any = {
    version: "25.0.0", project, effects: spec.installedEffects ?? [],
    beginSuppressDialogs: () => calls.push("beginSuppressDialogs"),
    endSuppressDialogs: () => calls.push("endSuppressDialogs"),
    beginUndoGroup: () => calls.push("beginUndoGroup"),
    endUndoGroup: () => calls.push("endUndoGroup"),
    executeCommand: () => calls.push("executeCommand"),
  };
  if (spec.fonts !== null) app.fonts = { missingOrSubstitutedFonts: spec.fonts ?? [] };
  if (spec.usedFonts) {
    const layerId = (n: string) => comps.flatMap((c) => c.layers).find((l: any) => l.name === n)?.id;
    project.usedFonts = spec.usedFonts.map((u) => ({ font: { postScriptName: u.ps }, usedAt: u.layers.map((n) => (u.noIds ? { layerTimeD: {} } : { layerID: layerId(n), layerTimeD: {} })) }));
    writes.length = 0;
  }
  const names = Object.keys(globals);
  const values = names.map((n) => globals[n]);
  const aemcp = new Function("$", "app", ...names, "var aemcp;\n" + helperSource + "\nreturn aemcp;")({ global: { ...globals } }, app, ...values);
  /** run a tool's JSX body like the bridge does (no undo group: a read-only tool) */
  const run = (jsx: string, args: Record<string, unknown>) => {
    const fn = new Function("aemcp", "app", ...names, `return function (args, log) {\n${jsx}\n};`)(aemcp, app, ...values);
    return JSON.parse(aemcp.run(fn, args, { undoGroup: false }));
  };
  return { app, comps, items, writes, calls, run, rqItems, rendered, imported };
}
