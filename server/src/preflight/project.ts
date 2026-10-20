// Preflight: checks in the project, for the delivered comp (spec.comp or the active comp). The ExtendScript
// below only reads (no undo step, no temporary items): comp settings, and for every visible text layer (and the
// layers named in safeAreas.layersMustBeIn) its visible frames, its source rect and the transform values of
// every layer in its chain (its parents, and the precomp layers it is nested in), each as one constant when the
// property is not animated. The geometry (bounds through the chain), the runs of violations and the text checks
// are computed here in TypeScript (unit-tested in test/preflight-project.test.ts). Missing footage / fonts /
// effects, expression errors and disabled layers with effects come from Project X-ray's collector (xray.ts).
import type { XData } from "../tools/xray-analyze.js";
import { areaMargins, type Finding, type NotRun, type Spec } from "./spec.js";

// ---------- what the JSX returns (short keys: long comps send many samples) ----------

/** a value that is constant, or one value per visible sample of the item */
export type Track<T> = T | { v: T[] };
export interface PLevel {
  /** layer name (for notes) */
  n: string;
  /** anchor point, position, scale (percent), rotation (degrees, clockwise) */
  a: Track<number[]>;
  p: Track<number[]>;
  s: Track<number[]>;
  r: Track<number>;
}
/** the content is clipped to a precomp's frame here (the precomp layer doesn't collapse transformations) */
export interface PClip {
  clip: [number, number];
}
export interface PItem {
  /** layer name, and where it is: "Main > 2: Lower third > 1: Name" */
  n: string;
  w: string;
  /** a text layer */
  t?: 1;
  /** indexes of the layersMustBeIn patterns its name matches (delivered comp only, unless the pattern is in PArgs.deep) */
  m?: number[];
  /** the index of the layer in the delivered comp it is (or is seen through, when nested) */
  ti?: number;
  /** nested: in a precomp */
  nst?: 1;
  /** the global sample indexes where the layer is visible (enabled, active, opacity > 0, nesting visible too) */
  i: number[];
  /** the time budget ran out while reading this item */
  cut?: 1;
  /** a 3D layer is in the chain: its bounds are not computed */
  d3?: 1;
  /** a layer in the chain auto-orients (along its path / towards the camera): that rotation is not included */
  ao?: 1;
  /** effects / layer styles / text animators on the layer (or a precomp layer it is in) that move or scale pixels */
  px?: string[];
  /** source rect [left, top, width, height] in layer space */
  rect?: Track<number[]>;
  /** the transform chain, innermost first */
  lv?: (PLevel | PClip)[];
  /** text: font (PostScript name) at the first visible frame */
  f?: string;
  /** text changes: [sample position k in i, text, font size, box overflow (1/0, null = not a box / not available)] */
  tc?: [number, string, number, number | null][];
  /** characters the font has no glyph for */
  gm?: string[];
  /** the font each of gm is missing from (per-character fonts), when it isn't `f` */
  gmf?: string[];
}
export interface PData {
  v: number;
  ae?: string;
  comp: { id: number; name: string; w: number; h: number; fps: number; dur: number; par: number; fd: number; dst?: number; df?: boolean };
  project: { bpc?: number; ws?: string };
  /** sample every Nth frame; n samples (sample i is at frame i * step) */
  step: number;
  n: number;
  items: PItem[];
  /** features found in this After Effects: box text seen, boxOverflow readable, hasGlyphsFor available */
  feat: { box?: 1; overflow?: 1; glyphs?: 1; glyphFirst?: 1 };
  partial?: { reason: string; at?: number };
  /** indexes of the layersMustBeIn patterns that match any layer name in the delivered comp (visible or not) */
  pm?: number[];
}

/** What the JSX needs to know from the spec. */
export interface PArgs {
  comp?: string | number;
  step: number;
  /** collect text layers (in precomps too) */
  textAll: boolean;
  /** read bounds (source rect + transform chain) for text layers */
  bounds: boolean;
  /** layersMustBeIn patterns as regular expressions */
  patterns: string[];
  /** indexes of patterns that also match layers inside precomps (any depth); the others match in the delivered comp only */
  deep?: number[];
  glyphs: boolean;
  timeBudgetSeconds: number;
}

export const PREFLIGHT_JSX = `
var T0 = new Date().getTime(), budget = (args.timeBudgetSeconds || 120) * 1000;
var c = aemcp.findComp(args.comp), P = app.project;
var fd = c.frameDuration, step = args.step || 1, nF = Math.max(1, Math.round(c.duration / fd)), nS = Math.ceil(nF / step);
var D = { v: 1, comp: { id: c.id, name: c.name, w: c.width, h: c.height, fps: c.frameRate, dur: c.duration, par: c.pixelAspect, fd: fd }, project: {}, step: step, n: nS, items: [], feat: {} };
try { D.ae = app.version; } catch (e) {}
try { D.comp.dst = c.displayStartTime; } catch (e) {}
try { D.comp.df = c.dropFrame; } catch (e) {}
try { D.project.bpc = P.bitsPerChannel; } catch (e) {}
try { D.project.ws = P.workingSpace; } catch (e) {}
function r2(v) { return Math.round(v * 100) / 100; }
function over() { return new Date().getTime() - T0 > budget; }
function isAnim(p) {
  try { if (p.numKeys > 0) return true; } catch (e) {}
  try { if (p.expressionEnabled && p.expression !== "") return true; } catch (e) {}
  return false;
}
function xf(L, m) { return L.property("ADBE Transform Group").property(m); }
function xy(v) { return [r2(v[0]), r2(v[1])]; }
function num(v) { return r2(v); }
// a property's value at the item's visible samples: one constant when it isn't animated
function track(p, times, idx, f) {
  if (!isAnim(p)) return f(p.value);
  var o = [];
  for (var k = 0; k < idx.length; k++) o.push(f(p.valueAtTime(times[idx[k]], false)));
  return { v: o };
}
function posTrack(L, times, idx) {
  var pp = xf(L, "ADBE Position"), sep = false;
  try { sep = pp.dimensionsSeparated; } catch (e) {}
  if (!sep) return track(pp, times, idx, xy);
  var ax = track(xf(L, "ADBE Position_0"), times, idx, num), ay = track(xf(L, "ADBE Position_1"), times, idx, num);
  if (typeof ax === "number" && typeof ay === "number") return [ax, ay];
  var o = [];
  for (var k = 0; k < idx.length; k++) o.push([typeof ax === "number" ? ax : ax.v[k], typeof ay === "number" ? ay : ay.v[k]]);
  return { v: o };
}
function level(L, times, idx) {
  return { n: L.name, a: track(xf(L, "ADBE Anchor Point"), times, idx, xy), p: posTrack(L, times, idx), s: track(xf(L, "ADBE Scale"), times, idx, xy), r: track(xf(L, "ADBE Rotate Z"), times, idx, num) };
}
function is3D(L) {
  if (L instanceof CameraLayer || L instanceof LightLayer) return true;
  // can't tell: treat it as 3D (reported as not checked) rather than compute 2D bounds that may be wrong
  try { return L.threeDLayer !== false; } catch (e) { return true; }
}
// effects that move or scale the pixels (not in the transform chain), by match name
var PXFX = { "ADBE Geometry2": "Transform effect", "ADBE Offset": "Offset effect" };
function pxMovers(L, out) {
  try {
    var fx = L.property("ADBE Effect Parade");
    for (var k = 1; fx && k <= fx.numProperties; k++) { var ef = fx.property(k); if (ef.enabled && PXFX[ef.matchName]) out.push(L.name + ": " + PXFX[ef.matchName]); }
  } catch (e) {}
  try {
    var ls = L.property("ADBE Layer Styles");
    if (ls && ls.enabled !== false) {
      for (var k2 = 1; k2 <= ls.numProperties; k2++) { var st = ls.property(k2); if (st.matchName !== "ADBE Blend Options Group" && st.enabled === true) { out.push(L.name + ": layer styles"); break; } }
    }
  } catch (e) {}
  try {
    var an = L.property("ADBE Text Properties").property("ADBE Text Animators"), hit = false;
    for (var k3 = 1; an && k3 <= an.numProperties && !hit; k3++) {
      var A3 = an.property(k3);
      if (A3.enabled === false) continue;
      var ap = A3.property("ADBE Text Animator Properties");
      for (var k4 = 1; ap && k4 <= ap.numProperties; k4++) { var mn = ap.property(k4).matchName; if (mn === "ADBE Text Scale 3D" || mn === "ADBE Text Position 3D") { hit = true; break; } }
    }
    if (hit) out.push(L.name + ": text animator (position / scale)");
  } catch (e) {}
}
function autoOri(L) { try { return L.autoOrient !== AutoOrientType.NO_AUTO_ORIENT; } catch (e) { return false; } }
function active(L, t) { return t >= L.inPoint - 1e-6 && t < L.outPoint - 1e-6; }
function shown(L) {
  if (!L.enabled) return false;
  try { if (L.guideLayer) return false; } catch (e) {}
  // in After Effects TextLayer and ShapeLayer are not AVLayer subclasses (instanceof AVLayer is false for them)
  return L instanceof AVLayer || L instanceof TextLayer || L instanceof ShapeLayer;
}
// a nesting context: the delivered comp, or a precomp seen through a layer. times[i]: the local time of global
// sample i, or null where the context isn't visible (the precomp layer is inactive, transparent or past its source)
var root = { comp: c, times: [], path: c.name, up: null, via: null };
for (var i0 = 0; i0 < nS; i0++) root.times.push(i0 * step * fd);
function child(ctx, Lp) {
  var src = Lp.source, t = [], op = xf(Lp, "ADBE Opacity"), opA = isAnim(op), opC = op.value, rm = false, any = false, rmp = null;
  try { rm = Lp.timeRemapEnabled; } catch (e) {}
  if (rm) rmp = Lp.property("ADBE Time Remapping");
  for (var i = 0; i < nS; i++) {
    var tp = ctx.times[i];
    if (tp === null || !active(Lp, tp) || (opA ? op.valueAtTime(tp, false) : opC) <= 0) { t.push(null); continue; }
    var lt = rm ? rmp.valueAtTime(tp, false) : (tp - Lp.startTime) * 100 / Lp.stretch;
    if (lt < -1e-6 || lt >= src.duration) { t.push(null); continue; }
    t.push(lt); any = true;
  }
  return { comp: src, times: t, path: ctx.path + " > " + Lp.index + ": " + Lp.name, up: ctx, via: Lp, any: any };
}
function textAnimated(L) {
  var tp = L.property("ADBE Text Properties");
  if (isAnim(tp.property("ADBE Text Document"))) return true;
  try { if (tp.property("ADBE Text Animators").numProperties > 0) return true; } catch (e) {}
  return false;
}
function rect(L, times, idx, isText) {
  var anim = true;
  if (isText) anim = textAnimated(L);
  else if (!(L instanceof ShapeLayer)) { try { if (L.source) anim = false; } catch (e) {} }
  if (!anim) { var r = L.sourceRectAtTime(times[idx[0]], false); return [r2(r.left), r2(r.top), r2(r.width), r2(r.height)]; }
  var o = [];
  for (var k = 0; k < idx.length; k++) { var q = L.sourceRectAtTime(times[idx[k]], false); o.push([r2(q.left), r2(q.top), r2(q.width), r2(q.height)]); }
  return { v: o };
}
function tdInfo(td) {
  var ov = null;
  try {
    if (td.boxText) {
      D.feat.box = 1;
      if (td.boxOverflow !== undefined) { D.feat.overflow = 1; ov = td.boxOverflow ? 1 : 0; }
    }
  } catch (e) {}
  return [String(td.text), r2(td.fontSize), ov];
}
function textInfo(o, L, times) {
  var st = L.property("ADBE Text Properties").property("ADBE Text Document"), idx = o.i, first = st.valueAtTime(times[idx[0]], false), tc = [], last = null;
  try { o.f = first.font; } catch (e) {}
  if (!isAnim(st)) tc.push([0].concat(tdInfo(first)));
  else {
    for (var k = 0; k < idx.length; k++) {
      var e1 = tdInfo(st.valueAtTime(times[idx[k]], false)), key = e1.join("|");
      if (key !== last) { tc.push([k].concat(e1)); last = key; }
    }
  }
  o.tc = tc;
  if (!args.glyphs) return;
  var fo = null;
  try { fo = first.fontObject; } catch (e) {}
  if (!fo || fo.hasGlyphsFor === undefined) return;
  D.feat.glyphs = 1;
  // each character against its own font (style runs: AE 24+ characterRange), else against the text's first font
  var seen = {}, miss = [], missF = [], fonts = {};
  function fontFor(td, x0, x1) {
    if (typeof td.characterRange !== "function" || td.text.length > 2000) return null;
    try {
      var cr = td.characterRange(x0, x1), f = null;
      try { f = cr.fontObject; } catch (e) {}
      if (f && f.hasGlyphsFor !== undefined) return f;
      var ps = cr.font;
      if (!ps) return null;
      if (fonts["f" + ps] === undefined) {
        fonts["f" + ps] = null;
        try { var l = app.fonts.getFontsByPostScriptName(ps); if (l && l.length && l[0].hasGlyphsFor !== undefined) fonts["f" + ps] = l[0]; } catch (e) {}
      }
      return fonts["f" + ps];
    } catch (e) { return null; }
  }
  for (var j = 0; j < tc.length; j++) {
    var td = j === 0 ? first : st.valueAtTime(times[idx[tc[j][0]]], false), s = tc[j][1];
    for (var x = 0; x < s.length; x++) {
      var ch = s.charAt(x), code = s.charCodeAt(x), x0 = x;
      if (code >= 0xD800 && code <= 0xDBFF && x + 1 < s.length) { ch = s.substr(x, 2); x++; }
      if (/^\\s$/.test(ch)) continue;
      var f = fontFor(td, x0, x + 1), ps = o.f;
      if (f) { try { ps = f.postScriptName; } catch (e) {} } else { f = fo; D.feat.glyphFirst = 1; }
      if (seen["c" + ps + "|" + ch]) continue;
      seen["c" + ps + "|" + ch] = true;
      try { if (!f.hasGlyphsFor(ch)) { miss.push(ch); missF.push(ps); } } catch (e) {}
    }
  }
  if (miss.length) { o.gm = miss; for (var g = 0; g < missF.length; g++) if (missF[g] !== o.f) { o.gmf = missF; break; } }
}
function item(ctx, L, isText, m) {
  var o = { n: L.name, w: ctx.path + " > " + L.index + ": " + L.name, i: [] }, top = L;
  for (var xt = ctx; xt.via; xt = xt.up) top = xt.via;
  o.ti = top.index;
  if (ctx.up) o.nst = 1;
  if (isText) o.t = 1;
  if (m.length) o.m = m;
  D.items.push(o);
  var op = xf(L, "ADBE Opacity"), opA = isAnim(op), opC = op.value;
  for (var i = 0; i < nS; i++) {
    var t = ctx.times[i];
    if (t === null || !active(L, t)) continue;
    if ((opA ? op.valueAtTime(t, false) : opC) <= 0) continue;
    o.i.push(i);
    if (i % 64 === 0 && over()) { o.cut = 1; D.partial = { reason: "time budget (" + Math.round(budget / 1000) + " s) used up", at: t }; break; }
  }
  if (!o.i.length) return;
  // the chain: the layer and its parents, a clip to the precomp's frame, the precomp layer and its parents, ...
  var chain = [], x = ctx, LL = L;
  while (LL) {
    for (var A2 = LL; A2; A2 = A2.parent) chain.push([A2, x]);
    if (!x.up) break;
    var col = false;
    try { col = x.via.collapseTransformation; } catch (e) {}
    if (!col) chain.push([null, x]);
    LL = x.via; x = x.up;
  }
  for (var k = 0; k < chain.length; k++) if (chain[k][0] && is3D(chain[k][0])) { o.d3 = 1; break; }
  // effects that move pixels: on the layer itself and on the precomp layers it is seen through (not on parents)
  var px = [];
  pxMovers(L, px);
  for (var xc = ctx; xc.via; xc = xc.up) pxMovers(xc.via, px);
  if (px.length) o.px = px;
  if (isText) textInfo(o, L, ctx.times);
  if (o.d3 || !(args.bounds || m.length)) return;
  o.rect = rect(L, ctx.times, o.i, isText);
  o.lv = [];
  for (var k2 = 0; k2 < chain.length; k2++) {
    var e2 = chain[k2];
    if (!e2[0]) { o.lv.push({ clip: [e2[1].comp.width, e2[1].comp.height] }); continue; }
    if (autoOri(e2[0])) o.ao = 1;
    o.lv.push(level(e2[0], e2[1].times, o.i));
  }
}
var pats = [], plist = args.patterns || [], pmSeen = {}, deep = {}, anyDeep = false;
D.pm = [];
for (var q = 0; q < plist.length; q++) pats.push(new RegExp(plist[q]));
for (var q4 = 0; args.deep && q4 < args.deep.length; q4++) { deep["p" + args.deep[q4]] = true; anyDeep = true; }
function scan(ctx, depth) {
  var comp = ctx.comp;
  for (var j = 1; j <= comp.numLayers; j++) {
    if (D.partial) return;
    if (over()) { D.partial = { reason: "time budget (" + Math.round(budget / 1000) + " s) used up" }; return; }
    var L = comp.layer(j);
    for (var q3 = 0; q3 < pats.length; q3++) if (!pmSeen[q3] && (depth === 0 || deep["p" + q3]) && pats[q3].test(L.name)) { pmSeen[q3] = true; D.pm.push(q3); }
    if (!shown(L)) continue;
    var isText = L instanceof TextLayer, m = [];
    if (!L.nullLayer) { for (var q2 = 0; q2 < pats.length; q2++) if ((depth === 0 || deep["p" + q2]) && pats[q2].test(L.name)) m.push(q2); }
    if ((isText && args.textAll) || m.length) item(ctx, L, isText && args.textAll, m);
    var src = null;
    try { src = L.source; } catch (e) {}
    if ((args.textAll || anyDeep) && src instanceof CompItem && depth < 8) {
      var ch = child(ctx, L);
      if (ch.any) scan(ch, depth + 1);
    }
  }
}
if (args.textAll || pats.length) scan(root, 0);
D.ms = new Date().getTime() - T0;
return aemcp.stringify(D);`;

// ---------- geometry ----------

/** 2D affine map: x' = a x + c y + e, y' = b x + d y + f */
export type Affine = [number, number, number, number, number, number];
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** After Effects' 2D layer transform: layer space -> parent (or comp) space = position + R(rotation) S(scale) (p - anchor). */
export function layerMatrix(anchor: number[], position: number[], scale: number[], rotationDeg: number): Affine {
  const th = (rotationDeg * Math.PI) / 180, cs = Math.cos(th), sn = Math.sin(th);
  const sx = scale[0] / 100, sy = (scale[1] ?? scale[0]) / 100;
  const a = cs * sx, b = sn * sx, c = -sn * sy, d = cs * sy;
  return [a, b, c, d, position[0] - (a * anchor[0] + c * anchor[1]), position[1] - (b * anchor[0] + d * anchor[1])];
}
export const apply = (m: Affine, [x, y]: number[]): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const aabb = (pts: number[][]): Box => ({
  x0: Math.min(...pts.map((p) => p[0])),
  y0: Math.min(...pts.map((p) => p[1])),
  x1: Math.max(...pts.map((p) => p[0])),
  y1: Math.max(...pts.map((p) => p[1])),
});
const corners = (b: Box) => [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];

const isPerSample = <T>(t: Track<T>): t is { v: T[] } => typeof t === "object" && t !== null && !Array.isArray(t) && "v" in t;
export const trackAt = <T>(t: Track<T>, k: number): T => (isPerSample(t) ? t.v[Math.min(k, t.v.length - 1)] : t);

/**
 * The comp-space bounding box of a layer-space rect [left, top, width, height] through a chain of levels
 * (innermost first) at visible sample k. A clip intersects with a precomp's frame (null: nothing left).
 * Nested content is boxed at each clip, so rotated content inside a rotated precomp is slightly over-estimated.
 */
export function boundsThrough(rect: number[], levels: (PLevel | PClip)[], k: number): Box | null {
  const [l, t, w, h] = rect;
  if (!(w > 0) && !(h > 0)) return null;
  let pts: number[][] = [[l, t], [l + w, t], [l + w, t + h], [l, t + h]];
  for (const lv of levels) {
    if ("clip" in lv) {
      const b = aabb(pts), c: Box = { x0: Math.max(b.x0, 0), y0: Math.max(b.y0, 0), x1: Math.min(b.x1, lv.clip[0]), y1: Math.min(b.y1, lv.clip[1]) };
      if (c.x1 <= c.x0 || c.y1 <= c.y0) return null;
      pts = corners(c);
      continue;
    }
    const m = layerMatrix(trackAt(lv.a, k), trackAt(lv.p, k), trackAt(lv.s, k), trackAt(lv.r, k));
    pts = pts.map((p) => apply(m, p));
  }
  return aabb(pts);
}

/** How much a vertical unit in layer space measures in the comp (scale and rotation of the whole chain). */
export function verticalScale(levels: (PLevel | PClip)[], k: number): number {
  let v: [number, number] = [0, 1];
  for (const lv of levels) {
    if ("clip" in lv) continue;
    const m = layerMatrix(trackAt(lv.a, k), trackAt(lv.p, k), trackAt(lv.s, k), trackAt(lv.r, k));
    v = [m[0] * v[0] + m[2] * v[1], m[1] * v[0] + m[3] * v[1]];
  }
  return Math.hypot(v[0], v[1]);
}

export type Area = "title" | "action" | "frame";
export const AREA_NAME: Record<Area, string> = { title: "title-safe", action: "action-safe", frame: "the frame" };

/** The area in comp pixels for margins given as fractions of the width / height per side. */
export function areaBox(w: number, h: number, m: { x: number; y: number }): Box {
  return { x0: w * m.x, y0: h * m.y, x1: w - w * m.x, y1: h - h * m.y };
}

export interface Overshoot {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
/** How far a box reaches past each side of an area (0 where it doesn't). */
export function overshoot(b: Box, area: Box): Overshoot {
  const p = (v: number) => Math.max(0, v);
  return { left: p(area.x0 - b.x0), right: p(b.x1 - area.x1), top: p(area.y0 - b.y0), bottom: p(b.y1 - area.y1) };
}

// ---------- runs over time ----------

export interface Run<T> {
  /** first and last global sample index of the run */
  i0: number;
  i1: number;
  worst: T;
}
/**
 * Runs of consecutive bad samples. `samples` are in time order; a gap in the global sample index (the layer
 * wasn't visible there) ends a run. `bad` returns the value to keep for a bad sample (null: fine); `worse`
 * merges two values into the worst of both.
 */
export function runsOf<T>(samples: { i: number; value: T | null }[], worse: (a: T, b: T) => T): Run<T>[] {
  const out: Run<T>[] = [];
  let cur: Run<T> | null = null;
  for (const s of samples) {
    if (s.value === null) {
      cur = null;
      continue;
    }
    if (cur && s.i === cur.i1 + 1) {
      cur.i1 = s.i;
      cur.worst = worse(cur.worst, s.value);
    } else {
      cur = { i0: s.i, i1: s.i, worst: s.value };
      out.push(cur);
    }
  }
  return out;
}

/** "on the right", "on the left and bottom" */
export function sidesText(o: Overshoot): string {
  const sides = (["left", "right", "top", "bottom"] as const).filter((s) => o[s] > 0.5);
  return "on the " + (sides.length <= 1 ? sides.join("") : sides.slice(0, -1).join(", ") + " and " + sides[sides.length - 1]);
}

// ---------- text ----------

/** Cap height as a fraction of the font size. Typical Latin fonts are 0.66-0.75; this is an approximation. */
export const CAP_RATIO = 0.7;

export interface TextSegment {
  i0: number;
  i1: number;
  text: string;
}
/** What a text layer shows over time: runs of consecutive visible samples with the same text. */
export function textSegments(item: PItem): TextSegment[] {
  const out: TextSegment[] = [];
  const tc = item.tc ?? [];
  let c = 0;
  item.i.forEach((i, k) => {
    while (c + 1 < tc.length && tc[c + 1][0] <= k) c++;
    const text = tc[c]?.[1] ?? "";
    const last = out[out.length - 1];
    if (last && last.i1 === i - 1 && last.text === text) last.i1 = i;
    else out.push({ i0: i, i1: i, text });
  });
  return out;
}
/** Characters that count for reading speed: everything except line breaks (spaces and punctuation count). */
export const readChars = (text: string) => Array.from(text.replace(/[\r\n\u0003]/g, "")).length;

const textAt = (item: PItem, k: number) => {
  const tc = item.tc ?? [];
  let c = 0;
  while (c + 1 < tc.length && tc[c + 1][0] <= k) c++;
  return tc[c];
};

// ---------- the checks ----------

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const px = (n: number) => `${Math.round(n)} px`;

export interface ProjectResult {
  findings: Finding[];
  /** requested checks that couldn't run (the verdict can't be PASS) */
  notRun: NotRun[];
  notes: string[];
}

/** Comp settings against spec.video (size, frame rate, pixel aspect, duration). */
export function checkVideo(spec: Spec, comp: PData["comp"]): Finding[] {
  const v = spec.video, out: Finding[] = [], where = comp.name;
  if (!v) return out;
  const fix = "Composition > Composition Settings";
  if ((v.width !== undefined && v.width !== comp.w) || (v.height !== undefined && v.height !== comp.h))
    out.push({ check: "video.size", severity: "fail", where, message: `comp is ${comp.w}x${comp.h}; the spec asks for ${v.width ?? comp.w}x${v.height ?? comp.h}`, fix: `${fix}: Width / Height (or scale it to the delivery size in a new comp)` });
  if (v.frameRate !== undefined && Math.abs(comp.fps - v.frameRate) > 0.005)
    out.push({ check: "video.frameRate", severity: "fail", where, message: `comp frame rate is ${r2(comp.fps)} fps; the spec asks for ${v.frameRate} fps`, fix: `${fix}: Frame Rate (footage keeps its own rate; check retimed motion afterwards)` });
  if (v.pixelAspect !== undefined && Math.abs(comp.par - v.pixelAspect) > 0.0005)
    out.push({ check: "video.pixelAspect", severity: "fail", where, message: `pixel aspect ratio is ${r2(comp.par)}; the spec asks for ${v.pixelAspect}`, fix: `${fix}: Pixel Aspect Ratio` });
  if (v.duration !== undefined) {
    const fps = comp.fps, frames = Math.round(comp.dur * fps), have = `${r2(comp.dur)} s (${frames} frames)`;
    if (typeof v.duration === "number") {
      const want = Math.round(v.duration * fps), tol = v.durationToleranceFrames ?? 0;
      if (Math.abs(frames - want) > tol)
        out.push({ check: "video.duration", severity: "fail", where, message: `comp is ${have}; the spec asks for ${v.duration} s (${want} frames${tol ? `, ±${tol}` : ""}), ${frames > want ? "over" : "short"} by ${Math.abs(frames - want)} frames`, fix: `${fix}: Duration (and the work area / render range)` });
    } else {
      const half = 0.5 / fps, { min, max } = v.duration;
      if ((min !== undefined && comp.dur < min - half) || (max !== undefined && comp.dur > max + half))
        out.push({ check: "video.duration", severity: "fail", where, message: `comp is ${have}; the spec asks for ${min ?? "any"}–${max ?? "any"} s`, fix: `${fix}: Duration` });
    }
  }
  return out;
}

/** Bit depth and working space against spec.project. */
export function checkProjectSettings(spec: Spec, d: PData): { findings: Finding[]; notRun: NotRun[] } {
  const p = spec.project, findings: Finding[] = [], notRun: NotRun[] = [];
  if (!p) return { findings, notRun };
  if (p.bitsPerChannel !== undefined && d.project.bpc !== undefined && d.project.bpc !== p.bitsPerChannel)
    findings.push({ check: "project.bitsPerChannel", severity: "fail", message: `project is ${d.project.bpc} bits per channel; the spec asks for ${p.bitsPerChannel}`, fix: "File > Project Settings > Color: Bit Depth" });
  if (p.workingSpace !== undefined) {
    if (d.project.ws === undefined) notRun.push({ check: "project.workingSpace", reason: "this After Effects doesn't report the working space to scripts" });
    else {
      const norm = (s: string) => (s.trim() === "" ? "none" : s.trim().toLowerCase());
      if (norm(d.project.ws) !== norm(p.workingSpace))
        findings.push({ check: "project.workingSpace", severity: "fail", message: `working space is "${d.project.ws || "None"}"; the spec asks for "${p.workingSpace}"`, fix: "File > Project Settings > Color: Working Space" });
    }
  }
  return { findings, notRun };
}

/** Does the spec need Project X-ray's collector (missing items, expression errors, disabled layers with effects)? */
export const needsXray = (spec: Spec) => xrayChecks(spec).length > 0;

/** The project checks that come from X-ray's collector, as the spec names them. */
export function xrayChecks(spec: Spec): string[] {
  const p = spec.project ?? {};
  return (["noMissingFootage", "noMissingFonts", "noMissingEffects", "noExpressionErrors", "noDisabledLayersWithEffects"] as const).filter((k) => p[k]).map((k) => `project.${k}`);
}

/** Missing footage / fonts / effects, expression errors and disabled layers with effects in the comps X-ray read (the delivered comp and its precomps). */
export function checkFromXray(spec: Spec, x: XData): { findings: Finding[]; notRun: NotRun[] } {
  const p = spec.project ?? {}, findings: Finding[] = [], notRun: NotRun[] = [];
  const comps = x.comps.filter((c) => c.layers);
  const at = (c: (typeof comps)[number], l: { i: number; n: string }) => `${c.name} > ${l.i}: ${l.n}`;
  const layers = comps.flatMap((c) => (c.layers ?? []).map((l) => ({ c, l, where: at(c, l) })));
  const list = (ws: string[]) => ws.slice(0, 3).join("; ") + (ws.length > 3 ? ` (+${ws.length - 3} more)` : "");
  if (p.noMissingFootage) {
    const used = new Map<number, string[]>();
    for (const { l, where } of layers) if (l.src !== undefined) used.set(l.src, [...(used.get(l.src) ?? []), where]);
    for (const f of x.footage) {
      const ws = used.get(f.id);
      if (!ws) continue;
      if (f.kind === "file" && f.missing)
        findings.push({ check: "project.missingFootage", severity: "fail", where: list(ws), message: `missing footage "${f.name}"${f.missingPath || f.file ? ` (${f.missingPath ?? f.file})` : ""}`, fix: "relink it (File > Dependencies > Find Missing Footage, or ae_relink_footage)" });
      else if (f.kind === "placeholder")
        findings.push({ check: "project.missingFootage", severity: "fail", where: list(ws), message: `placeholder "${f.name}" instead of footage`, fix: "replace the placeholder with the real footage" });
    }
  }
  if (p.noMissingEffects) {
    const byFx = new Map<string, { name: string; ws: string[] }>();
    for (const { l, where } of layers) for (const f of l.fx ?? []) if (f.x) byFx.set(f.m, { name: f.n, ws: [...(byFx.get(f.m)?.ws ?? []), where] });
    for (const [m, { name, ws }] of byFx)
      findings.push({ check: "project.missingEffects", severity: "fail", where: list(ws), message: `effect "${name}" (${m}) is not installed: it renders nothing`, fix: "install the plug-in on this machine (and the render machine), or replace the effect" });
  }
  if (p.noMissingFonts) {
    if (!x.fonts) notRun.push({ check: "project.noMissingFonts", reason: "this After Effects can't list missing fonts to scripts (needs 24.0 or later)" });
    else {
      const missing = new Map(x.fonts.missing.map((f) => [f.ps, f]));
      const byFont = new Map<string, string[]>();
      const add = (ps: string, where: string) => {
        const ws = byFont.get(ps) ?? [];
        if (!ws.includes(where)) ws.push(where);
        byFont.set(ps, ws);
      };
      // the font at the comp's current time, per text layer
      for (const { l, where } of layers) if (l.font && missing.has(l.font)) add(l.font, where);
      // every font the project uses (style runs inside a text, Source Text keyframes): AE's usedFonts, by layer id
      const byId = new Map(layers.map(({ l, where }) => [l.id, where]));
      const unplaced: { ps: string; layers: number }[] = [];
      for (const u of x.fonts.used ?? []) {
        if (!missing.has(u.ps)) continue;
        if (u.ids) for (const id of u.ids) {
          const where = byId.get(id);
          if (where) add(u.ps, where);
        }
        else if (!byFont.has(u.ps)) unplaced.push(u);
      }
      const describe = (ps: string) => {
        const f = missing.get(ps)!;
        return `font ${ps}${f.family ? ` (${f.family}${f.style ? " " + f.style : ""})` : ""} is ${f.sub ? "substituted" : "missing"}`;
      };
      for (const [ps, ws] of byFont)
        findings.push({ check: "project.missingFonts", severity: "fail", where: list(ws), message: describe(ps), fix: "install or activate the font (e.g. in Adobe Fonts), or change the text's font" });
      for (const u of unplaced)
        findings.push({
          check: "project.missingFonts",
          severity: "warn",
          message: `${describe(u.ps)} and used in the project (${u.layers} text layer${u.layers === 1 ? "" : "s"}); this After Effects doesn't say which layers, so it may or may not be in the delivered comp`,
          fix: "find the text that uses it (a style run or a Source Text keyframe) and install the font or change it",
        });
    }
  }
  if (p.noExpressionErrors) {
    for (const { l, where } of layers)
      for (const [path, , err, enabled] of l.ex ?? [])
        if (err && enabled) findings.push({ check: "project.expressionErrors", severity: "fail", where: `${where} > ${path}`, message: `expression error: ${err.split("\n")[0].slice(0, 200)}`, fix: "fix the expression (ae_check_expression shows the error and value), or disable it" });
  }
  if (p.noDisabledLayersWithEffects) {
    for (const { l, where } of layers) {
      const fx = (l.fx ?? []).filter((f) => !f.off);
      if (l.off && !l.matte && fx.length)
        findings.push({ check: "project.disabledLayersWithEffects", severity: "fail", where, message: `disabled layer with ${fx.length} effect${fx.length > 1 ? "s" : ""} (${fx.slice(0, 3).map((f) => f.n).join(", ")})`, fix: "delete the layer if it isn't needed, or remove its effects" });
    }
  }
  // like the frame-by-frame budget: a warning (the verdict can't be PASS), with what to do about it
  if (x.partial)
    findings.push({ check: "project.partial", severity: "warn", message: `only part of the comp tree was read (${x.partial.reason}): missing items or expression errors further in may not be listed`, fix: "raise timeBudgetSeconds" });
  return { findings, notRun };
}

/** Safe areas over time and the text checks, from the items the JSX collected. */
export function checkItems(spec: Spec, d: PData): ProjectResult {
  const findings: Finding[] = [], notRun: NotRun[] = [], notes: string[] = [];
  const { w: W, h: H } = d.comp, tOf = (i: number) => Math.round(i * d.step * d.comp.fd * 1e6) / 1e6;
  const at = (i0: number, i1: number): number | [number, number] => (i0 === i1 ? tOf(i0) : [tOf(i0), tOf(i1)]);
  const sa = spec.safeAreas, tx = spec.text;
  const textArea: Area | undefined = sa && sa.textMustBeIn !== "none" ? (sa.textMustBeIn ?? "title") : undefined;
  const textMargins = textArea ? areaMargins(spec, textArea) : null;
  if (textArea && !textMargins) {
    // asked for explicitly: not run; the default (title) with no title margin: the spec only checks other layers
    if (sa?.textMustBeIn) notRun.push({ check: "safeAreas.textMustBeIn", reason: `"${textArea}" has no margin in the spec (add safeAreas.${textArea})` });
    else notes.push(`text layers were not checked against title-safe: the spec has no safeAreas.title`);
  }
  const patterns = (sa?.layersMustBeIn ?? []).map((p) => ({ ...p, margins: areaMargins(spec, p.area) }));
  for (const p of patterns) if (!p.margins) notRun.push({ check: `safeAreas.layersMustBeIn "${p.layer}"`, reason: `"${p.area}" has no margin in the spec (add safeAreas.${p.area})` });
  const matched = new Set<number>();

  for (const it of d.items) {
    if (!it.i.length) continue;
    // the areas this layer must stay in
    const areas = new Map<Area, Box>();
    if (it.t && textArea && textMargins) areas.set(textArea, areaBox(W, H, textMargins));
    for (const m of it.m ?? []) {
      matched.add(m);
      const p = patterns[m];
      if (p?.margins && !areas.has(p.area)) areas.set(p.area, areaBox(W, H, p.margins));
    }
    const wantCaps = !!(it.t && tx?.minCapHeightPx !== undefined);
    if (it.d3) {
      if (areas.size || wantCaps)
        findings.push({ check: "safeAreas.3d", severity: "warn", where: it.w, at: at(it.i[0], it.i[it.i.length - 1]), message: "3D layer (or parented to / nested in a 3D layer, or its 3D switch can't be read): safe areas and cap height not checked", fix: "check it at key times with ae_get_layer_bounds (it projects through the camera) or ae_render_frame" });
    } else if (it.rect && it.lv) {
      if (it.ao && (areas.size || wantCaps))
        findings.push({ check: "safeAreas.autoOrient", severity: "warn", where: it.w, at: at(it.i[0], it.i[it.i.length - 1]), message: "auto-orient is on (this layer or one it is parented to / nested in): that rotation isn't included, so its bounds may be off", fix: "check it at key times with ae_get_layer_bounds or ae_render_frame" });
      if (it.px?.length && (areas.size || wantCaps))
        findings.push({
          check: "safeAreas.bounds",
          severity: "warn",
          where: it.w,
          message: `bounds may be off: ${it.px.slice(0, 3).join("; ")}${it.px.length > 3 ? ` (+${it.px.length - 3} more)` : ""} move${it.px.length === 1 ? "s" : ""} or scale${it.px.length === 1 ? "s" : ""} the pixels, which isn't included in the layer's box`,
          fix: "check it at key times with ae_render_frame",
        });
      const boxes = it.i.map((i, k) => ({ i, k, box: boundsThrough(trackAt(it.rect!, k), it.lv!, k) }));
      // for the in-chat view: the layer's bounds where a run of samples starts
      const boxAt = (i: number): Finding["box"] => {
        const b = boxes.find((s) => s.i === i)?.box;
        return b ? [Math.round(b.x0), Math.round(b.y0), Math.round(b.x1), Math.round(b.y1)] : undefined;
      };
      for (const [area, ab] of areas) {
        const samples = boxes.map(({ i, box }) => {
          // not on screen at all (parked off-frame): not visible, so not a safe-area problem
          if (!box || box.x1 <= 0 || box.y1 <= 0 || box.x0 >= W || box.y0 >= H) return { i, value: null };
          const o = overshoot(box, ab);
          return { i, value: Math.max(o.left, o.right, o.top, o.bottom) > 0.5 ? o : null };
        });
        const worse = (a: Overshoot, b: Overshoot): Overshoot => ({ left: Math.max(a.left, b.left), right: Math.max(a.right, b.right), top: Math.max(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) });
        for (const r of runsOf(samples, worse)) {
          const most = Math.max(r.worst.left, r.worst.right, r.worst.top, r.worst.bottom);
          findings.push({
            check: `safeAreas.${area}`,
            severity: "fail",
            where: it.w,
            at: at(r.i0, r.i1),
            message: `outside ${AREA_NAME[area]} by up to ${px(most)} ${sidesText(r.worst)}`,
            fix: area === "frame" ? "keep it inside the frame (move or scale it)" : `keep it inside ${AREA_NAME[area]} (x ${Math.round(ab.x0)}–${Math.round(ab.x1)}, y ${Math.round(ab.y0)}–${Math.round(ab.y1)} px): move, scale or re-time it`,
            box: boxAt(r.i0),
            area: { name: area, rect: [Math.round(ab.x0), Math.round(ab.y0), Math.round(ab.x1), Math.round(ab.y1)] },
          });
        }
      }
      if (wantCaps) {
        const min = tx!.minCapHeightPx!;
        const samples = boxes.map(({ i, k, box }) => {
          const e = textAt(it, k);
          if (!box || !e || !e[1].trim()) return { i, value: null };
          const cap = e[2] * CAP_RATIO * verticalScale(it.lv!, k);
          return { i, value: cap < min - 0.05 ? cap : null };
        });
        for (const r of runsOf(samples, Math.min))
          findings.push({ check: "text.capHeight", severity: "fail", where: it.w, at: at(r.i0, r.i1), message: `cap height about ${r1(r.worst)} px (minimum ${min} px)`, fix: "make the text bigger (font size or scale)", box: boxAt(r.i0) });
      }
    }
    if (!it.t || !tx) continue;
    // reading speed and time on screen, per text shown
    const dt = d.step * d.comp.fd;
    for (const s of textSegments(it)) {
      if (!s.text.trim()) continue;
      const secs = (s.i1 - s.i0 + 1) * dt, chars = readChars(s.text), quote = JSON.stringify(s.text.length > 40 ? s.text.slice(0, 40) + "…" : s.text);
      if (tx.maxCharsPerSecond !== undefined && chars / secs > tx.maxCharsPerSecond + 1e-9)
        findings.push({ check: "text.readingSpeed", severity: "fail", where: it.w, at: at(s.i0, s.i1), message: `${quote}: ${chars} characters in ${r2(secs)} s = ${r1(chars / secs)} characters/s (maximum ${tx.maxCharsPerSecond})`, fix: `show it longer (at least ${r2(chars / tx.maxCharsPerSecond)} s) or shorten the text` });
      if (tx.minOnScreenSeconds !== undefined && secs < tx.minOnScreenSeconds - 1e-9)
        findings.push({ check: "text.onScreen", severity: "fail", where: it.w, at: at(s.i0, s.i1), message: `${quote} is visible for ${r2(secs)} s (minimum ${tx.minOnScreenSeconds} s)`, fix: "extend the layer (out point) or its fully visible part" });
    }
    if (tx.noOverflow) {
      const samples = it.i.map((i, k) => ({ i, value: textAt(it, k)?.[3] === 1 ? true : null }));
      for (const r of runsOf(samples, () => true))
        findings.push({ check: "text.overflow", severity: "fail", where: it.w, at: at(r.i0, r.i1), message: "paragraph text overflows its box (some text is cut off)", fix: "enlarge the text box, reduce the font size or shorten the text" });
    }
    if (tx.glyphs && it.gm?.length) {
      // one finding per font (a text with style runs can miss characters in several fonts)
      const byFont = new Map<string, string[]>();
      it.gm.forEach((c, k) => {
        const font = it.gmf?.[k] ?? it.f ?? "(unknown)";
        byFont.set(font, [...(byFont.get(font) ?? []), c]);
      });
      for (const [font, chars] of byFont)
        findings.push({ check: "text.glyphs", severity: "fail", where: it.w, message: `font ${font} has no glyph for ${chars.slice(0, 20).map((c) => JSON.stringify(c)).join(" ")}${chars.length > 20 ? ` (+${chars.length - 20} more)` : ""}`, fix: "use a font that covers these characters" });
    }
    if (it.cut) notes.push(`${it.w}: checked until the time budget ran out`);
  }
  for (const [m, p] of patterns.entries()) {
    if (matched.has(m)) continue;
    // a misspelt name must not pass silently; a layer that exists but is never visible is fine
    if (d.pm && d.pm.includes(m)) notes.push(`safeAreas.layersMustBeIn "${p.layer}": the matching layers in ${d.comp.name} are never visible`);
    else if (!d.partial)
      findings.push({ check: "safeAreas.layersMustBeIn", severity: "warn", where: d.comp.name, message: `no layer named "${p.layer}" in comp "${d.comp.name}"`, fix: "check the layer name in the spec (wildcards: Logo*)" });
  }

  const textItems = d.items.filter((it) => it.t);
  if (tx?.noOverflow && d.feat.box && !d.feat.overflow) notRun.push({ check: "text.noOverflow", reason: "not available in this After Effects (needs 24.6 or later)" });
  if (tx?.glyphs && textItems.length && !d.feat.glyphs) notRun.push({ check: "text.glyphs", reason: "not available in this After Effects (needs 25.1 or later)" });
  if (tx?.glyphs && d.feat.glyphFirst) notes.push("glyphs: some texts were checked against their first character's font only (this After Effects doesn't give scripts the font of each character)");
  if (tx?.minCapHeightPx !== undefined) notes.push(`cap height is estimated as ${CAP_RATIO} x font size x the layer's scale (real fonts: about 0.65-0.75; mixed sizes in one layer: the first character's size)`);
  if (d.step > 1) notes.push(`every ${d.step}th frame checked (safeAreas.sampleEveryFrames): times and durations are accurate to ${d.step} frames`);
  if (d.partial) findings.push({ check: "preflight.partial", severity: "warn", at: d.partial.at, message: `only part of the comp was checked: ${d.partial.reason}`, fix: "raise timeBudgetSeconds, or check every Nth frame (safeAreas.sampleEveryFrames)" });
  return { findings, notRun, notes };
}

/** The arguments for PREFLIGHT_JSX from a spec. */
export function jsxArgs(spec: Spec, opts: { comp?: string | number; timeBudgetSeconds?: number } = {}): PArgs {
  const sa = spec.safeAreas, tx = spec.text;
  const textBounds = !!sa || tx?.minCapHeightPx !== undefined;
  const textAll = textBounds || !!(tx && (tx.maxCharsPerSecond !== undefined || tx.minOnScreenSeconds !== undefined || tx.noOverflow || tx.glyphs));
  return {
    comp: opts.comp ?? spec.comp,
    step: sa?.sampleEveryFrames ?? 1,
    textAll,
    bounds: textBounds,
    patterns: (sa?.layersMustBeIn ?? []).map((p) => wildcard(p.layer)),
    glyphs: !!tx?.glyphs,
    timeBudgetSeconds: opts.timeBudgetSeconds ?? 120,
  };
}

/** A layer name pattern with * wildcards as a regular expression source (exact match otherwise). */
export function wildcard(pattern: string): string {
  return "^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")).join("[\\s\\S]*") + "$";
}

/** Every project check for one delivered comp. */
export function projectChecks(spec: Spec, d: PData, x?: XData): ProjectResult {
  const findings: Finding[] = [...checkVideo(spec, d.comp)], notRun: NotRun[] = [], notes: string[] = [];
  const ps = checkProjectSettings(spec, d);
  findings.push(...ps.findings);
  notRun.push(...ps.notRun);
  if (x) {
    const xr = checkFromXray(spec, x);
    findings.push(...xr.findings);
    notRun.push(...xr.notRun);
  }
  const it = checkItems(spec, d);
  findings.push(...it.findings);
  notRun.push(...it.notRun);
  notes.push(...it.notes);
  return { findings, notRun, notes };
}
