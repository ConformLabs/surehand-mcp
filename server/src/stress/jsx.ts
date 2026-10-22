// ae_stress_test: the ExtendScript side. Nothing here edits the user's comp: every value is set on a scratch duplicate
// ("<comp> [stress test]", CompItem.duplicate) that the same call removes again, so each call nets no change. The
// duplicate shares the comp's precomps, so only targets on the comp's own layers are set (a target inside a precomp
// is refused before anything runs). The measuring is Preflight's own collector (PREFLIGHT_JSX, run on the duplicate
// with the sampled frames), plus what Preflight doesn't read: lines, how far a paragraph overflows its box (the box
// made tall on the duplicate, then put back), the font actually used, direction and composer, the text a number shows,
// expression errors. The values were worked out in TypeScript (src/stress/cases.ts); the checks are src/stress/measure.ts.
import { PREFLIGHT_JSX, type PArgs } from "../preflight/project.js";

/** Scratch items carry this in their name (a leftover is easy to find and is removed by name). */
export const SCRATCH = "[stress test]";

/** What DISCOVER_JSX returns. */
export interface DTarget {
  /** Essential Graphics controller name (egp) or the layer name */
  name: string;
  source: "egp" | "layer";
  /** PropertyValueType name, or "LAYER" (media) */
  type: string;
  /** the effect a controller's property belongs to (match name), e.g. ADBE Dropdown Control */
  fx?: string;
  li?: number;
  ln?: string;
  /** property indexes from the layer */
  path?: number[];
  value?: unknown;
  items?: number;
  box?: 1;
  keyed?: 1;
  /** Source Text driven by an expression: 1, and 2 when it reads data (footage(...).dataValue / sourceData) */
  ex?: 1 | 2;
  err?: string;
}
export interface Discovery {
  comp: { id: number; name: string; w: number; h: number; fps: number; dur: number; fd: number; par: number; dst?: number; df?: boolean };
  ae?: string;
  /** the comp's Essential Graphics controllers, resolved to the property each one drives */
  egp: DTarget[];
  /** essentialPropertySource is missing in this After Effects (before 22.0) */
  noSource?: 1;
  /** the comp's own text layers */
  texts: DTarget[];
  /** explicitly named targets, resolved */
  named: DTarget[];
  /** keyframe times (seconds) of the comp's own layers, and where text layers start and stop */
  keys: number[];
  edges: number[];
}

const COMMON = `
function stType(p) { return String(aemcp.enumName(PropertyValueType, p.propertyValueType)); }
function stPath(p) { var a = []; for (var q = p; q.propertyDepth > 0; q = q.parentProperty) a.unshift(q.propertyIndex); return a; }
function stLayerOf(p) { return p.propertyDepth > 0 ? p.propertyGroup(p.propertyDepth) : p; }
function stProp(L, path) { var p = L; for (var k = 0; k < path.length; k++) p = p.property(path[k]); return p; }
function stExpr(p) { try { return p.canSetExpression && p.expressionEnabled && p.expression !== ""; } catch (e) { return false; } }
function stSource(L) { return L.property("ADBE Text Properties").property("ADBE Text Document"); }
// a target on a scratch comp: the property, or the layer itself (media)
function stTarget(d, t) { var L = d.layer(t.li); return t.kind === "media" ? L : stProp(L, t.path); }
`;

export const DISCOVER_JSX =
  COMMON +
  `
var c = aemcp.findComp(args.comp), P = app.project;
var D = { comp: { id: c.id, name: c.name, w: c.width, h: c.height, fps: c.frameRate, dur: c.duration, fd: c.frameDuration, par: c.pixelAspect }, egp: [], texts: [], named: [], keys: [], edges: [] };
try { D.ae = app.version; } catch (e) {}
try { D.comp.dst = c.displayStartTime; } catch (e) {}
try { D.comp.df = c.dropFrame; } catch (e) {}
function describe(o, p) {
  var L = stLayerOf(p);
  o.li = L.index; o.ln = L.name;
  if (p === L) { o.type = "LAYER"; return o; }
  o.path = stPath(p); o.type = stType(p);
  try { var g = p.parentProperty; if (g && g.matchName && g.propertyDepth >= 1) o.fx = g.matchName; } catch (e) {}
  try { o.value = o.type === "TEXT_DOCUMENT" ? String(p.value.text) : aemcp.valueOf(p.value); } catch (e) {}
  try { if (p.numKeys > 0) o.keyed = 1; } catch (e) {}
  if (stExpr(p)) o.ex = /footage\\s*\\(|dataValue|sourceData|dataKeyValue|\\.(csv|tsv|json|mgjson)\\b/.test(p.expression) ? 2 : 1;
  try { if (o.type === "TEXT_DOCUMENT" && p.value.boxText) o.box = 1; } catch (e) {}
  return o;
}
var temp = [];
try {
  // the controllers: a probe comp shows the comp as a layer, whose Essential Properties say which property each drives
  var n = 0;
  try { n = c.motionGraphicsTemplateControllerCount; } catch (e) {}
  if (n > 0) {
    var w = P.items.addComp(c.name + " ${SCRATCH} probe", 16, 16, 1, 1, c.frameRate);
    temp.push(w);
    var ep = w.layers.add(c).essentialProperty;
    for (var k = 1; ep && k <= ep.numProperties; k++) {
      var e = ep.property(k), o = { name: e.name, source: "egp" }, src = null;
      try { o.type = stType(e); } catch (x) {}
      try { src = e.essentialPropertySource; } catch (x) { D.noSource = 1; }
      if (!src) { o.err = D.noSource ? "this After Effects (before 22.0) can't tell scripts which property a controller drives" : "the property it drives could not be found"; D.egp.push(o); continue; }
      var SL = stLayerOf(src);
      if (SL.containingComp.id !== c.id) { o.err = "it drives a property inside a precomp, which a copy of the comp shares with yours"; D.egp.push(o); continue; }
      D.egp.push(describe(o, src));
    }
  }
  // dropdown menus: how many items (probed on a scratch copy: the highest value the menu keeps)
  var dd = [];
  for (var q = 0; q < D.egp.length; q++) if (D.egp[q].fx === "ADBE Dropdown Control" && D.egp[q].path) dd.push(D.egp[q]);
  if (dd.length) {
    var dup = c.duplicate();
    temp.push(dup);
    dup.name = c.name + " ${SCRATCH}";
    for (var q2 = 0; q2 < dd.length; q2++) {
      var mp = stProp(dup.layer(dd[q2].li), dd[q2].path), cnt = 0;
      for (var v = 1; v <= 30; v++) { try { mp.setValue(v); if (Math.round(mp.value) !== v) break; cnt = v; } catch (x) { break; } }
      dd[q2].items = cnt;
    }
  }
} finally {
  for (var r = temp.length - 1; r >= 0; r--) { try { temp[r].remove(); } catch (e) {} }
}
// text layers of the comp itself, and the animation's key frames
function keysOf(g, out) {
  for (var k = 1; k <= g.numProperties && out.length < 4000; k++) {
    var p = g.property(k);
    if (p.propertyType === PropertyType.PROPERTY) { try { for (var j = 1; j <= p.numKeys; j++) out.push(aemcp.round(p.keyTime(j))); } catch (e) {} }
    else keysOf(p, out);
  }
}
for (var i = 1; i <= c.numLayers; i++) {
  var L = c.layer(i);
  if (L instanceof TextLayer) {
    D.texts.push(describe({ name: L.name, source: "layer" }, stSource(L)));
    D.edges.push(aemcp.round(L.inPoint), aemcp.round(L.outPoint - c.frameDuration));
  }
  if (L.enabled) { try { keysOf(L, D.keys); } catch (e) {} }
}
for (var a = 0; a < (args.named || []).length; a++) {
  var t = args.named[a], o2 = { name: String(t.layer), source: "layer" };
  try {
    var NL = aemcp.findLayer(c, t.layer), p2;
    if (t.kind === "media") p2 = NL;
    else if (t.property !== undefined && t.property !== null) p2 = aemcp.resolveProp(NL, t.property);
    else if (NL instanceof TextLayer) p2 = stSource(NL);
    else aemcp.fail("layer '" + NL.name + "' is not a text layer: give property (the property to vary) or kind \\"media\\"");
    if (p2 !== NL && p2.propertyType !== PropertyType.PROPERTY) aemcp.fail("'" + p2.name + "' on layer '" + NL.name + "' is a group, not a property");
    o2.name = NL.name;
    D.named.push(describe(o2, p2));
  } catch (e) { o2.err = e.message || String(e); D.named.push(o2); }
}
return D;`;

/** One target as RUN_JSX / PREP_JSX get it. */
export interface JTarget {
  li: number;
  path: number[];
  kind: "text" | "number" | "checkbox" | "dropdown" | "color" | "media";
  /** switch an expression on the target off in the scratch copy (data-driven text: the variant replaces the data) */
  exprOff?: boolean;
}
export interface JVariant {
  id: string;
  sets: { t: number; v: unknown }[];
}

/** What RUN_JSX measures beyond Preflight, per text layer of the comp itself. */
export interface TextExtra {
  li: number;
  ln: string;
  /** the text at the measured time, its font, size, leading */
  text: string;
  font?: string;
  fs?: number;
  lead?: number;
  /** the font is a substitute (not installed) */
  sub?: 1;
  /** the font changed from the comp's own (After Effects switched it: a font that can't draw the text): the designed
   * font (PostScript and family name), the characters it has no glyph for, the family now used, and 1 when nothing is drawn */
  of?: string;
  ofam?: string;
  om?: string[];
  fam?: string;
  blank?: 1;
  dir?: string;
  ce?: string;
  /** composed lines (AE 24.3+), and the character each line ends at */
  lines?: number;
  ends?: number[];
  /** paragraph text: the box size, its top left in layer space (AE 23+), overflow (1/0) */
  box?: number[];
  bpos?: number[];
  ov?: 0 | 1;
  /** paragraph text that overflows: the text's [top, height] with the box made tall, and how many lines it then has */
  need?: number[];
  linesNeed?: number;
  /** the time (s) it was read at */
  t: number;
}
export interface RunResultJ {
  done: number;
  name: string;
  results: {
    id: string;
    /** Preflight's PData of the scratch copy, as JSON */
    pf?: string;
    pfErr?: string;
    x: TextExtra[];
    /** per set: [target index, value read back] */
    rb: [number, unknown][];
    /** per set that failed: [target index, error] */
    err: [number, string][];
    /** expressions in error after the variant: [layer index, layer name, property, error] */
    ee: [number, string, string, string][];
  }[];
  /** scratch items that couldn't be removed */
  left?: string[];
}

const APPLY = `
var stMedia = [];
function stSet(d, t, v, keep) {
  var p = stTarget(d, t);
  if (t.kind === "text") {
    var s = String(v);
    if (p.numKeys > 0) { for (var k = 1; k <= p.numKeys; k++) { var kd = p.keyValue(k); kd.text = s; p.setValueAtKey(k, kd); } }
    else { var td = p.value; td.text = s; p.setValue(td); }
    return String(p.value.text);
  }
  if (t.kind === "media") {
    var cw = d.width, ch = d.height, wh = v === "wide" ? [Math.min(30000, cw * 2), Math.max(4, Math.round(cw / 2))] : v === "tall" ? [Math.max(4, Math.round(ch / 2)), Math.min(30000, ch * 2)] : [64, 64];
    var sl = d.layers.addSolid([0.5, 0.5, 0.5], "__surehand_stress_media", wh[0], wh[1], 1), so = sl.source;
    stMedia.push(so);
    sl.remove();
    p.replaceSource(so, false);
    return wh;
  }
  if (t.kind === "color") { var cv = v; p.setValue(p.value.length === 4 ? [cv[0], cv[1], cv[2], 1] : cv); return aemcp.valueOf(p.value); }
  if (p.numKeys > 0) aemcp.fail("'" + p.name + "' has keyframes: a single value can't replace its animation");
  p.setValue(v);
  return p.value;
}
function stSave(d, t) {
  var p = stTarget(d, t);
  if (t.kind === "media") return { src: p.source };
  if (p.numKeys > 0) { var ks = []; for (var k = 1; k <= p.numKeys; k++) ks.push(p.keyValue(k)); return { keys: ks }; }
  return { v: p.value };
}
function stRestore(d, t, s) {
  var p = stTarget(d, t);
  if (t.kind === "media") { p.replaceSource(s.src, false); return; }
  if (s.keys) { for (var k = 1; k <= s.keys.length; k++) p.setValueAtKey(k, s.keys[k - 1]); return; }
  p.setValue(s.v);
}
function stScratch(c, targets) {
  var d = c.duplicate();
  d.name = c.name + " ${SCRATCH}";
  for (var k = 0; k < targets.length; k++) if (targets[k].exprOff) { var p = stTarget(d, targets[k]); try { p.expressionEnabled = false; } catch (e) {} }
  return d;
}
function stCleanup(d) {
  var left = [];
  if (d) { var nm = d.name; try { d.remove(); } catch (e) { left.push(nm); } }
  for (var k = 0; k < stMedia.length; k++) { var nm2 = ""; try { nm2 = stMedia[k].name; stMedia[k].remove(); } catch (e) { left.push(nm2); } }
  stMedia = [];
  return left;
}
`;

export const RUN_JSX =
  COMMON +
  APPLY +
  `
var __pf = function (args) {
${PREFLIGHT_JSX}
};
var c = aemcp.findComp(args.comp), T0 = new Date().getTime(), d = null;
var out = { done: 0, name: "", results: [] }, fr = args.frames, fd = c.frameDuration, baseFont = {};
// the expressions of the copy's own layers: their errors are read after each variant
var exprs = [];
function exWalk(g, path, L) {
  for (var k = 1; k <= g.numProperties; k++) {
    var p = g.property(k), pp = path ? path + "/" + p.name : p.name;
    if (p.propertyType === PropertyType.PROPERTY) { if (stExpr(p)) exprs.push([L, pp, p]); }
    else exWalk(p, pp, L);
  }
}
function timeFor(L) {
  for (var k = 0; k < fr.length; k++) { var t = fr[k] * fd; if (t >= L.inPoint - 1e-6 && t < L.outPoint - 1e-6) return t; }
  return Math.max(0, L.inPoint);
}
function lineInfo(td, o) {
  try { if (td.composedLineCount !== undefined) o.lines = td.composedLineCount; } catch (e) {}
  try {
    if (o.lines && typeof td.composedLineRange === "function" && o.lines <= 60) {
      o.ends = [];
      for (var k = 0; k < o.lines; k++) { var lr = td.composedLineRange(k); o.ends.push(lr.characterEnd); }
    }
  } catch (e) {}
}
function extras() {
  var x = [];
  for (var i = 1; i <= d.numLayers; i++) {
    var L = d.layer(i);
    if (!(L instanceof TextLayer)) continue;
    var st = stSource(L), t = timeFor(L), td = st.valueAtTime(t, false), o = { li: i, ln: L.name, text: String(td.text).substr(0, 400), t: aemcp.round(t) };
    try { o.font = td.font; o.fs = aemcp.round(td.fontSize); } catch (e) {}
    try { o.lead = td.autoLeading ? aemcp.round(td.fontSize * 1.2) : aemcp.round(td.leading); } catch (e) {}
    try { if (td.fontObject && td.fontObject.isSubstitute) o.sub = 1; } catch (e) {}
    // After Effects swaps the font of a text its font can't draw (seen in AE 26.5: CJK in a Latin font becomes Myriad Pro)
    var b0 = baseFont["l" + i];
    if (b0 && o.font !== undefined && o.font !== b0.font) {
      o.of = b0.font;
      if (b0.fam) o.ofam = b0.fam;
      try { o.fam = td.fontObject.familyName; } catch (e) {}
      if (b0.fo && b0.fo.hasGlyphsFor !== undefined) {
        var seenC = {}, om = [], s0 = String(td.text);
        for (var ci = 0; ci < s0.length && om.length < 40; ci++) {
          var ch = s0.charAt(ci), cc = s0.charCodeAt(ci);
          if (cc >= 0xD800 && cc <= 0xDBFF && ci + 1 < s0.length) { ch = s0.substr(ci, 2); ci++; }
          if (/^\\s$/.test(ch) || seenC["c" + ch]) continue;
          seenC["c" + ch] = true;
          try { if (!b0.fo.hasGlyphsFor(ch)) om.push(ch); } catch (e) {}
        }
        o.om = om;
      }
      try { if (/\\S/.test(String(td.text)) && !(L.sourceRectAtTime(t, false).width > 0)) o.blank = 1; } catch (e) {}
    }
    try { if (typeof ParagraphDirection !== "undefined") o.dir = String(aemcp.enumName(ParagraphDirection, td.direction)).replace("DIRECTION_", ""); } catch (e) {}
    try { if (typeof ComposerEngine !== "undefined") o.ce = String(aemcp.enumName(ComposerEngine, td.composerEngine)); } catch (e) {}
    lineInfo(td, o);
    try {
      if (td.boxText) {
        o.box = [aemcp.round(td.boxTextSize[0]), aemcp.round(td.boxTextSize[1])];
        try { if (td.boxTextPos) o.bpos = [aemcp.round(td.boxTextPos[0]), aemcp.round(td.boxTextPos[1])]; } catch (e) {}
        if (td.boxOverflow !== undefined) o.ov = td.boxOverflow ? 1 : 0;
      }
    } catch (e) {}
    // how much it overflows: the box made very tall on the copy, the text measured, the box put back
    if (o.ov === 1 && st.numKeys === 0 && !stExpr(st)) {
      var keep = st.value;
      try {
        var tall = st.value;
        tall.boxTextSize = [o.box[0], 30000];
        try { if (typeof BoxVerticalAlignment !== "undefined" && tall.boxVerticalAlignment !== undefined) tall.boxVerticalAlignment = BoxVerticalAlignment.TOP; } catch (e) {}
        st.setValue(tall);
        var r = L.sourceRectAtTime(t, false);
        o.need = [aemcp.round(r.top), aemcp.round(r.height)];
        var tl = {};
        lineInfo(st.valueAtTime(t, false), tl);
        if (tl.lines !== undefined) o.linesNeed = tl.lines;
      } catch (e) {}
      try { st.setValue(keep); } catch (e) {}
    }
    x.push(o);
  }
  return x;
}
try {
  d = stScratch(c, args.targets);
  out.name = d.name;
  // each text layer's own font, before any variant (After Effects may swap it for one variant's text)
  for (var bi = 1; bi <= d.numLayers; bi++) {
    var BL = d.layer(bi);
    if (!(BL instanceof TextLayer)) continue;
    try {
      var btd = stSource(BL).valueAtTime(timeFor(BL), false), bo = { font: btd.font };
      try { bo.fo = btd.fontObject; bo.fam = btd.fontObject.familyName; } catch (e) {}
      baseFont["l" + bi] = bo;
    } catch (e) {}
  }
  for (var li = 1; li <= d.numLayers; li++) exWalk(d.layer(li), "", d.layer(li));
  for (var vi = 0; vi < args.variants.length; vi++) {
    if (vi > 0 && new Date().getTime() - T0 > args.budgetMs) break;
    var V = args.variants[vi], res = { id: V.id, x: [], rb: [], err: [], ee: [] }, saved = [];
    for (var s = 0; s < V.sets.length; s++) {
      var S = V.sets[s], T = args.targets[S.t];
      try { saved.push([T, stSave(d, T)]); res.rb.push([S.t, aemcp.valueOf(stSet(d, T, S.v))]); } catch (e) { res.err.push([S.t, e.message || String(e)]); }
    }
    var pa = args.pf; pa.comp = d.id;
    try { res.pf = __pf(pa); } catch (e) { res.pfErr = e.message || String(e); }
    try { res.x = extras(); } catch (e) {}
    var t0 = fr.length ? fr[0] * fd : 0;
    for (var q = 0; q < exprs.length; q++) {
      try { exprs[q][2].valueAtTime(t0, false); var er = exprs[q][2].expressionError; if (er) res.ee.push([exprs[q][0].index, exprs[q][0].name, exprs[q][1], String(er).split("\\n")[0].substr(0, 200)]); } catch (e) {}
    }
    for (var s2 = saved.length - 1; s2 >= 0; s2--) { try { stRestore(d, saved[s2][0], saved[s2][1]); } catch (e) {} }
    out.results.push(res);
    out.done++;
  }
} finally {
  var left = stCleanup(d);
  if (left.length) out.left = left;
}
return out;`;

/** A scratch copy with one variant set, left in place for a render (removed by REMOVE_JSX). */
export const PREP_JSX =
  COMMON +
  APPLY +
  `
var c = aemcp.findComp(args.comp), d = stScratch(c, args.targets), media = [];
var refused = [];
for (var s = 0; s < args.sets.length; s++) { try { stSet(d, args.targets[args.sets[s].t], args.sets[s].v); } catch (e) { refused.push(e.message || String(e)); } }
for (var k = 0; k < stMedia.length; k++) media.push(stMedia[k].id);
return { id: d.id, name: d.name, media: media, refused: refused };`;

/** Removes scratch items by id (only items whose name marks them as scratch). */
export const REMOVE_JSX = `
var left = [];
for (var k = 0; k < args.ids.length; k++) {
  var it = app.project.itemByID(args.ids[k]);
  if (!it) continue;
  if (String(it.name).indexOf(${JSON.stringify(SCRATCH)}) < 0 && String(it.name).indexOf("__surehand_stress") < 0) continue;
  try { it.remove(); } catch (e) { left.push(it.name); }
}
return { left: left };`;

/**
 * Everything of the user's comp a stress test could touch, read as text: the comp's settings and Essential Graphics,
 * every layer's attributes and every property's value, expression and keyframes (raw values, not rounded), and the
 * project's items. Compared before and after the run: "unchanged" is read back, not assumed.
 */
export const FINGERPRINT_JSX = `
var c = aemcp.findComp(args.comp), P = app.project, out = [], n = 0, budget = args.budget || 40000, partial = false;
function enc(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return String(v);
  if (v instanceof Array) { var a = []; for (var k = 0; k < v.length; k++) a.push(enc(v[k])); return "[" + a.join(",") + "]"; }
  try { return aemcp.stringify(aemcp.valueOf(v)); } catch (e) { return "?"; }
}
out.push("comp|" + [c.name, c.width, c.height, c.pixelAspect, c.duration, c.frameRate, c.numLayers, c.workAreaStart, c.workAreaDuration].join("|"));
try { var eg = []; for (var g = 1; g <= c.motionGraphicsTemplateControllerCount; g++) eg.push(c.getMotionGraphicsTemplateControllerName(g)); out.push("egp|" + eg.join("|")); } catch (e) {}
function walk(G, path, li) {
  for (var k = 1; k <= G.numProperties; k++) {
    if (n >= budget) { partial = true; return; }
    var p = G.property(k), pp = path + "/" + p.name;
    if (p.propertyType === PropertyType.PROPERTY) {
      n++;
      var s = li + pp + "=";
      // the value at time 0 before expressions: the same wherever the playhead is (the test moves it to measure);
      // keyframes and the expression text are compared below
      try { if (p.propertyValueType !== PropertyValueType.NO_VALUE) { var v; try { v = p.valueAtTime(0, true); } catch (e) { v = p.value; } s += enc(v); } } catch (e) {}
      try { if (p.canSetExpression && p.expression !== "") s += "|x" + (p.expressionEnabled ? 1 : 0) + ":" + p.expression; } catch (e) {}
      try { for (var j = 1; j <= p.numKeys; j++) s += "|k" + p.keyTime(j) + ":" + enc(p.keyValue(j)); } catch (e) {}
      out.push(s);
    } else { try { walk(p, pp, li); } catch (e) {} }
  }
}
for (var i = 1; i <= c.numLayers; i++) {
  var L = c.layer(i), a = [L.name, L.enabled, L.inPoint, L.outPoint, L.startTime];
  try { a.push(L.source ? L.source.id : ""); } catch (e) {}
  try { a.push(L.parent ? L.parent.index : ""); } catch (e) {}
  out.push("layer|" + i + "|" + a.join("|"));
  walk(L, "", i);
}
var items = [], scratch = [];
for (var q = 1; q <= P.numItems; q++) {
  var it = P.item(q);
  items.push(it.id);
  if (String(it.name).indexOf(${JSON.stringify(SCRATCH)}) >= 0 || String(it.name).indexOf("__surehand_stress") >= 0) scratch.push({ id: it.id, name: it.name });
}
out.push("items|" + items.join(","));
return { parts: out, values: n, partial: partial, scratch: scratch };`;

export type { PArgs };
