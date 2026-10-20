// Localization round trip: the ExtendScript side. COLLECT_JSX only reads: every text layer of a comp tree (nested
// precomps too, visible or not), with what the files and the fitting need. BUILD_JSX makes one version per language
// in one undo group: the comp tree is duplicated (the root and every precomp that holds a translated text; other
// precomps stay shared, as CompItem.duplicate leaves them), the precomp layers of the copies point at the copies,
// the texts are set, right-to-left languages get their paragraph direction, composer and justification, and each text
// is fitted by the user's rules, in their order, never past their limits. The checks after building are Preflight's
// (src/preflight/project.ts) and Project X-ray's font list, run from TypeScript (src/tools/localize.ts).

/** A text layer of the tree, as COLLECT_JSX returns it. */
export interface LLayer {
  /** comp id, comp name, layer index, layer id (AE 22+), layer name */
  c: number;
  cn: string;
  li: number;
  lid?: number;
  ln: string;
  /** layer switched off / a guide layer */
  off?: 1;
  guide?: 1;
  /** paragraph text: box [w, h] and its top-left [x, y] in layer space */
  box?: number[];
  bp?: number[];
  /** ParagraphJustification name, ParagraphDirection name (AE 24+), ComposerEngine name (AE 24+) */
  j?: string;
  dir?: string;
  ce?: string;
  f?: string;
  fs?: number;
  tr?: number;
  hs?: number;
  /** an expression on Source Text */
  ex?: 1;
  /** keyframed Source Text: [time, text] per keyframe */
  keys?: [number, string][];
  text: string;
  /** source rect [l, t, w, h] at tm (the static text), and the time it was measured at (the comp's own time) */
  rect?: number[];
  tm: number;
  /** boxOverflow (AE 24.6+) of the master text */
  ov?: 0 | 1;
}
export interface LCollect {
  root: { id: number; name: string; w: number; h: number; fps: number; dur: number; fd: number; dst?: number; df?: boolean };
  ae?: string;
  /** what this After Effects can do from scripts: paragraph direction and composer (24.0+), boxOverflow (24.6+) */
  api: { dir?: 1; ce?: 1; ov?: 1 };
  layers: LLayer[];
  /** every place a text layer is seen: [path as Preflight writes it, comp id, layer index] */
  occ: [string, number, number][];
  /** precomp layers: [comp id, layer index, the precomp's id] */
  edges: [number, number, number][];
  comps: { id: number; name: string }[];
}

/** One fitting step, as the JSX gets it (limits already in the layer's own units). */
export interface JStep {
  adjust: "tracking" | "fontSize" | "capHeight" | "horizontalScale" | "boxWidth" | "boxHeight";
  /** tracking / fontSize / horizontalScale (percent) / capHeight (comp px) minimum; box growth maximum (px) */
  v: number;
}
export interface JUnit {
  c: number;
  li: number;
  /** keyframe index of keyframed Source Text (0: the text itself) */
  k: number;
  text: string;
  font?: string;
  /** the version's direction: 1 right to left, 0 left to right */
  rtl: 0 | 1;
  steps: JStep[];
  /** point text: the most width it may take, in layer px (from the user's maxWidth through the layer's scale) */
  lim?: number;
  /** comp px per layer px, vertically (for capHeight) */
  cs?: number;
}
export interface JLang {
  lang: string;
  folder: string;
  /** master comp id -> the version's name */
  names: Record<string, string>;
  /** the comps to duplicate (root first) */
  dup: number[];
  units: JUnit[];
}
export interface BuildArgs {
  root: number;
  langs: JLang[];
  rtl: { justification: "mirror" | "keep"; pointText: "keepExtent" | "keepAnchor"; composer: boolean; digits?: string };
  /** comps already named like a version, to remove first (overwrite: true) */
  remove: number[];
}
/** What BUILD_JSX returns per text it set. */
export interface BUnit {
  /** index into the language's units */
  i: number;
  err?: string;
  /** the text read back at the measuring time, expressions applied */
  rb?: string;
  /** direction / composer / justification after setting (names), and whether the API was there */
  dir?: string;
  ce?: string;
  j?: string;
  noDir?: 1;
  noCe?: 1;
  ceErr?: string;
  /** the font after setting (font map) */
  f?: string;
  /** before -> after */
  fs: [number, number];
  tr: [number, number];
  hs: [number, number];
  box?: [number[], number[]];
  /** point text: the anchor point moved to keep its extent when the justification flipped (layer px) */
  anc?: number;
  ancNote?: string;
  fit: { need: 0 | 1; ok: 0 | 1; done: string[]; why?: string; approx?: 1; w?: number };
}
export interface BLang {
  lang: string;
  folder: string;
  root: number;
  rootName: string;
  /** [master comp id, version comp id, name] */
  comps: [number, number, string][];
  /** where the translated texts are seen in the version: [path, version comp id, layer index] */
  occ: [string, number, number][];
  units: BUnit[];
}
export interface BBuilt {
  langs: BLang[];
  fatal?: string;
  rollback?: boolean;
}

const COMMON = `
function lzEnum(en, v) { if (typeof en === "undefined" || v === undefined || v === null) return undefined; var n = aemcp.enumName(en, v); return typeof n === "string" ? n : undefined; }
function lzST(L) { return L.property("ADBE Text Properties").property("ADBE Text Document"); }
function lzExpr(p) { try { return p.expressionEnabled && p.expression !== ""; } catch (e) { return false; } }
function lzKeys(p) { try { return p.numKeys; } catch (e) { return 0; } }
function lzTm(L, c) { var t = Math.min(L.outPoint, c.duration) - c.frameDuration; if (t < L.inPoint) t = L.inPoint; return t < 0 ? 0 : t; }
function lzRect(L, t) { var r = L.sourceRectAtTime(t, false); return [aemcp.round(r.left), aemcp.round(r.top), aemcp.round(r.width), aemcp.round(r.height)]; }
function lzGet(td, k) { try { var v = td[k]; return v; } catch (e) { return undefined; } }
`;

export const COLLECT_JSX =
  COMMON +
  `
var c0 = aemcp.findComp(args.comp);
var D = { root: { id: c0.id, name: c0.name, w: c0.width, h: c0.height, fps: c0.frameRate, dur: c0.duration, fd: c0.frameDuration }, api: {}, layers: [], occ: [], edges: [], comps: [] };
try { D.ae = app.version; } catch (e) {}
try { D.root.dst = c0.displayStartTime; } catch (e) {}
try { D.root.df = c0.dropFrame; } catch (e) {}
if (typeof ParagraphDirection !== "undefined") D.api.dir = 1;
if (typeof ComposerEngine !== "undefined") D.api.ce = 1;
var seenL = {}, seenC = {}, seenE = {};
function info(c, L) {
  var p = lzST(L), td = p.value, o = { c: c.id, cn: c.name, li: L.index, ln: L.name, text: String(td.text), tm: lzTm(L, c) };
  try { if (L.id !== undefined) o.lid = L.id; } catch (e) {}
  if (!L.enabled) o.off = 1;
  try { if (L.guideLayer) o.guide = 1; } catch (e) {}
  if (td.boxText) {
    try { var s = td.boxTextSize; o.box = [aemcp.round(s[0]), aemcp.round(s[1])]; } catch (e) {}
    try { var bp = td.boxTextPos; o.bp = [aemcp.round(bp[0]), aemcp.round(bp[1])]; } catch (e) {}
    var ov = lzGet(td, "boxOverflow");
    if (ov !== undefined) { D.api.ov = 1; o.ov = ov ? 1 : 0; }
  }
  o.j = lzEnum(typeof ParagraphJustification === "undefined" ? undefined : ParagraphJustification, lzGet(td, "justification"));
  if (D.api.dir) o.dir = lzEnum(ParagraphDirection, lzGet(td, "direction"));
  if (D.api.ce) o.ce = lzEnum(ComposerEngine, lzGet(td, "composerEngine"));
  o.f = lzGet(td, "font"); o.fs = lzGet(td, "fontSize"); o.tr = lzGet(td, "tracking"); o.hs = lzGet(td, "horizontalScale");
  if (lzExpr(p)) o.ex = 1;
  var nk = lzKeys(p);
  if (nk > 0) {
    o.keys = [];
    for (var k = 1; k <= nk; k++) o.keys.push([aemcp.round(p.keyTime(k)), String(p.keyValue(k).text)]);
  } else {
    try { o.rect = lzRect(L, o.tm); } catch (e) {}
  }
  return o;
}
function walk(c, path, depth) {
  if (!seenC["c" + c.id]) { seenC["c" + c.id] = true; D.comps.push({ id: c.id, name: c.name }); }
  for (var j = 1; j <= c.numLayers; j++) {
    var L = c.layer(j), here = path + " > " + j + ": " + L.name;
    if (L instanceof TextLayer) {
      if (!seenL[c.id + ":" + j]) { seenL[c.id + ":" + j] = true; D.layers.push(info(c, L)); }
      D.occ.push([here, c.id, j]);
      continue;
    }
    var src = null;
    try { src = L.source; } catch (e) {}
    if (src instanceof CompItem && depth < 8) {
      if (!seenE[c.id + ":" + j]) { seenE[c.id + ":" + j] = true; D.edges.push([c.id, j, src.id]); }
      walk(src, here, depth + 1);
    }
  }
}
walk(c0, c0.name, 0);
return D;`;

export const BUILD_JSX =
  COMMON +
  `
var c0 = aemcp.findComp(args.root), P = app.project, R = args.rtl;
var out = { langs: [] };
function folderNamed(name) {
  for (var k = 1; k <= P.numItems; k++) { var it = P.item(k); if (it instanceof FolderItem && it.name === name) return it; }
  return P.items.addFolder(name);
}
var JR = typeof ParagraphJustification === "undefined" ? null : ParagraphJustification;
// LEFT <-> RIGHT (and the last line of full justification); centre and full stay
function mirrored(j) {
  if (!JR || j === undefined || j === null) return j;
  if (j === JR.LEFT_JUSTIFY) return JR.RIGHT_JUSTIFY;
  if (j === JR.RIGHT_JUSTIFY) return JR.LEFT_JUSTIFY;
  if (j === JR.FULL_JUSTIFY_LASTLINE_LEFT) return JR.FULL_JUSTIFY_LASTLINE_RIGHT;
  if (j === JR.FULL_JUSTIFY_LASTLINE_RIGHT) return JR.FULL_JUSTIFY_LASTLINE_LEFT;
  return j;
}
function anim(p) { try { if (p.numKeys > 0) return true; } catch (e) {} return lzExpr(p); }
// one text to set and fit: a layer's Source Text, or one keyframe of it
function Unit(L, c, k) {
  var p = lzST(L), self = this;
  this.L = L; this.p = p; this.k = k;
  this.t = k ? p.keyTime(k) : lzTm(L, c);
  this.get = function () { return self.k ? self.p.keyValue(self.k) : self.p.value; };
  this.set = function (td) { if (self.k) self.p.setValueAtKey(self.k, td); else self.p.setValue(td); };
  this.num = function (field, v) { var td = self.get(); td[field] = v; self.set(td); };
}
// does it fit: paragraph text inside its box, point text within its width limit
function fits(u, lim, r) {
  var td = u.get(), ok = true;
  if (td.boxText) {
    var ov = lzGet(td, "boxOverflow");
    if (ov === undefined) {
      // before 24.6: the text's bounds against the box (an approximation)
      var s = td.boxTextSize, q = u.L.sourceRectAtTime(u.t, false);
      ov = q.height > s[1] + 0.5 || q.width > s[0] + 0.5;
      r.approx = 1;
    }
    if (ov) ok = false;
  }
  if (lim !== undefined && lim !== null) {
    var w = u.L.sourceRectAtTime(u.t, false).width;
    r.w = aemcp.round(w);
    if (w > lim + 0.01) ok = false;
  }
  return ok;
}
function r1(v) { return Math.round(v * 10) / 10; }
// the largest value in [lo, hi] that fits (lo fits, hi doesn't), to res
function largest(u, set, lo, hi, res, lim, r) {
  while (hi - lo > res + 1e-9) {
    var m = Math.round((lo + hi) / 2 / res) * res;
    if (m <= lo || m >= hi) m = lo + res;
    if (m >= hi) break;
    set(m);
    if (fits(u, lim, r)) lo = m; else hi = m;
  }
  set(lo);
  return lo;
}
// the smallest value in [lo, hi] that fits (hi fits, lo doesn't)
function smallest(u, set, lo, hi, res, lim, r) {
  while (hi - lo > res + 1e-9) {
    var m = Math.round((lo + hi) / 2 / res) * res;
    if (m <= lo || m >= hi) m = hi - res;
    if (m <= lo) break;
    set(m);
    if (fits(u, lim, r)) hi = m; else lo = m;
  }
  set(hi);
  return hi;
}
// the cap height of the text's font as a fraction of the font size: an "H" measured at the text's own size
function capRatio(u) {
  var td = u.get(), keep = td.text, fs = td.fontSize;
  td.text = "H"; u.set(td);
  var h = u.L.sourceRectAtTime(u.t, false).height;
  var back = u.get(); back.text = keep; u.set(back);
  return h > 0 && fs > 0 ? h / fs : null;
}
// one fitting step: changes one thing within the user's limit; returns true when the text fits
function step(u, s, j, lim, r, B) {
  var td = u.get(), name = s.adjust;
  if (name === "fontSize" || name === "capHeight") {
    var cur = td.fontSize, min = s.v;
    if (name === "capHeight") {
      var cr = capRatio(u);
      if (!cr || !j.cs) { r.done.push("capHeight: skipped (the cap height can't be measured here)"); return false; }
      min = s.v / (cr * j.cs);
    }
    if (cur <= min + 1e-6) { r.done.push(name + ": already at its minimum"); return false; }
    var setFs = function (v) { u.num("fontSize", v); };
    setFs(min);
    if (!fits(u, lim, r)) { r.done.push((name === "capHeight" ? "font size (cap height " + s.v + " px)" : "font size") + " " + r1(cur) + " -> " + r1(min) + " (the minimum)"); return false; }
    var got = largest(u, setFs, min, cur, 0.5, lim, r);
    r.done.push("font size " + r1(cur) + " -> " + r1(got));
    return true;
  }
  if (name === "tracking") {
    var t0 = td.tracking || 0;
    if (t0 <= s.v) { r.done.push("tracking: already at its minimum"); return false; }
    var setTr = function (v) { u.num("tracking", v); };
    setTr(s.v);
    if (!fits(u, lim, r)) { r.done.push("tracking " + r1(t0) + " -> " + s.v + " (the minimum)"); return false; }
    var gt = largest(u, setTr, s.v, t0, 1, lim, r);
    r.done.push("tracking " + r1(t0) + " -> " + r1(gt));
    return true;
  }
  if (name === "horizontalScale") {
    var h0 = td.horizontalScale, f = h0 > 10 ? 1 : 0.01, hmin = s.v * f;
    if (h0 <= hmin + 1e-9) { r.done.push("horizontal scale: already at its minimum"); return false; }
    var setHs = function (v) { u.num("horizontalScale", v); };
    setHs(hmin);
    if (!fits(u, lim, r)) { r.done.push("horizontal scale " + r1(h0 / f) + "% -> " + s.v + "% (the minimum)"); return false; }
    var gh = largest(u, setHs, hmin, h0, 0.5 * f, lim, r);
    r.done.push("horizontal scale " + r1(h0 / f) + "% -> " + r1(gh / f) + "%");
    return true;
  }
  if (name === "boxWidth" || name === "boxHeight") {
    if (!td.boxText) { r.done.push(name + ": not paragraph text"); return false; }
    var ax = name === "boxWidth" ? 0 : 1, s0 = td.boxTextSize, p0 = td.boxTextPos, size0 = [s0[0], s0[1]], pos0 = [p0[0], p0[1]];
    // the box grows away from the edge the text is aligned to
    var share = 0;
    if (ax === 0) {
      var jj = td.justification;
      if (JR && (jj === JR.RIGHT_JUSTIFY || jj === JR.FULL_JUSTIFY_LASTLINE_RIGHT)) share = 1;
      else if (JR && jj === JR.CENTER_JUSTIFY) share = 0.5;
    } else {
      var va = lzGet(td, "boxVerticalAlignment");
      if (typeof BoxVerticalAlignment !== "undefined" && va !== undefined) { if (va === BoxVerticalAlignment.BOTTOM) share = 1; else if (va === BoxVerticalAlignment.CENTER) share = 0.5; }
    }
    var setG = function (g) {
      var d = u.get(), sz = [size0[0], size0[1]], ps = [pos0[0], pos0[1]];
      sz[ax] = size0[ax] + g; ps[ax] = pos0[ax] - g * share;
      d.boxTextSize = sz;
      try { d.boxTextPos = ps; } catch (e) {}
      u.set(d);
    };
    setG(s.v);
    if (!fits(u, lim, r)) { r.done.push((ax ? "box height " : "box width ") + "+" + s.v + " px (the maximum)"); return false; }
    var gg = smallest(u, setG, 0, s.v, 1, lim, r);
    r.done.push((ax ? "box height " : "box width ") + r1(size0[ax]) + " -> " + r1(size0[ax] + gg) + " px");
    return true;
  }
  r.done.push(name + ": unknown");
  return false;
}
function names(m, id) { return m["" + id]; }
try {
  for (var x = 0; x < args.remove.length; x++) { var old = P.itemByID(args.remove[x]); if (old) old.remove(); }
  for (var g = 0; g < args.langs.length; g++) {
    var Lg = args.langs[g], fold = folderNamed(Lg.folder), map = {}, rec = { lang: Lg.lang, folder: fold.name, comps: [], occ: [], units: [] };
    out.langs.push(rec);
    // the tree: duplicates of the root and of every precomp that holds a translated text
    for (var d = 0; d < Lg.dup.length; d++) {
      var m0 = P.itemByID(Lg.dup[d]), cp = m0.duplicate();
      cp.name = names(Lg.names, m0.id);
      cp.parentFolder = fold;
      map["c" + m0.id] = cp;
      rec.comps.push([m0.id, cp.id, cp.name]);
    }
    for (var d2 = 0; d2 < Lg.dup.length; d2++) {
      var cc = map["c" + Lg.dup[d2]];
      for (var j2 = 1; j2 <= cc.numLayers; j2++) {
        var LL = cc.layer(j2), sr = null;
        try { sr = LL.source; } catch (e) {}
        if (sr instanceof CompItem && map["c" + sr.id]) LL.replaceSource(map["c" + sr.id], false);
      }
    }
    var vroot = map["c" + c0.id];
    rec.root = vroot.id; rec.rootName = vroot.name;
    // the texts
    for (var i = 0; i < Lg.units.length; i++) {
      var J = Lg.units[i], b = { i: i, fit: { need: 0, ok: 1, done: [] } };
      rec.units.push(b);
      try {
        var vc = map["c" + J.c];
        if (!vc) aemcp.fail("comp " + J.c + " was not duplicated");
        var L = vc.layer(J.li), u = new Unit(L, vc, J.k), td = u.get();
        var j0 = lzGet(td, "justification"), rect0 = null;
        if (!J.k && !td.boxText) { try { rect0 = L.sourceRectAtTime(u.t, false); } catch (e) {} }
        b.fs = [td.fontSize, td.fontSize]; b.tr = [td.tracking || 0, td.tracking || 0]; b.hs = [td.horizontalScale, td.horizontalScale];
        if (td.boxText) { var bs = td.boxTextSize; b.box = [[bs[0], bs[1]], [bs[0], bs[1]]]; }
        td.text = J.text;
        if (J.font) td.font = J.font;
        // direction: right to left for RTL languages, left to right otherwise (a Hebrew master into English too)
        var flip = false;
        if (typeof ParagraphDirection === "undefined" || lzGet(td, "direction") === undefined) { if (J.rtl) b.noDir = 1; }
        else {
          var wantDir = J.rtl ? ParagraphDirection.DIRECTION_RIGHT_TO_LEFT : ParagraphDirection.DIRECTION_LEFT_TO_RIGHT;
          if (td.direction !== wantDir) { flip = true; td.direction = wantDir; }
        }
        if (J.rtl && R.composer) {
          if (typeof ComposerEngine === "undefined" || lzGet(td, "composerEngine") === undefined) b.noCe = 1;
          else if (td.composerEngine !== ComposerEngine.UNIVERSAL_TYPE_ENGINE) { try { td.composerEngine = ComposerEngine.UNIVERSAL_TYPE_ENGINE; } catch (e) { b.ceErr = e.message || String(e); } }
        }
        if (J.rtl && R.digits && typeof DigitSet !== "undefined" && DigitSet[R.digits] !== undefined) { try { td.digitSet = DigitSet[R.digits]; } catch (e) {} }
        var jNew = j0;
        if ((flip || (b.noDir && J.rtl)) && R.justification === "mirror") { jNew = mirrored(j0); if (jNew !== j0) td.justification = jNew; }
        u.set(td);
        // point text whose justification flipped: keep the text where the master's text was (its far edge stays put)
        if (rect0 && JR && jNew !== j0 && R.pointText === "keepExtent") {
          var ap = L.property("ADBE Transform Group").property("ADBE Anchor Point"), dx = null;
          if (j0 === JR.LEFT_JUSTIFY && jNew === JR.RIGHT_JUSTIFY) dx = rect0.left + rect0.width;
          else if (j0 === JR.RIGHT_JUSTIFY && jNew === JR.LEFT_JUSTIFY) dx = rect0.left;
          if (dx !== null && Math.abs(dx) > 1e-6) {
            if (anim(ap)) b.ancNote = "its Anchor Point is animated, so it was not moved: the text now extends from the other side of its anchor";
            else { var av = ap.value; av[0] = av[0] - dx; ap.setValue(av); b.anc = aemcp.round(dx); }
          }
        }
        var after = u.get();
        b.dir = lzEnum(typeof ParagraphDirection === "undefined" ? undefined : ParagraphDirection, lzGet(after, "direction"));
        b.ce = lzEnum(typeof ComposerEngine === "undefined" ? undefined : ComposerEngine, lzGet(after, "composerEngine"));
        b.j = lzEnum(JR || undefined, lzGet(after, "justification"));
        b.f = lzGet(after, "font");
        // fitting: only when it doesn't fit, only the user's steps, in their order
        if (!fits(u, J.lim, b.fit)) {
          b.fit.need = 1; b.fit.ok = 0;
          if (!J.steps.length) b.fit.why = "no fit rules given";
          for (var s = 0; s < J.steps.length && !b.fit.ok; s++) if (step(u, J.steps[s], J, J.lim, b.fit, b)) b.fit.ok = 1;
          if (!b.fit.ok && J.steps.length) b.fit.why = "still doesn't fit with every allowed adjustment at its limit (left at that best attempt)";
        }
        var fin = u.get();
        b.fs[1] = fin.fontSize; b.tr[1] = fin.tracking || 0; b.hs[1] = fin.horizontalScale;
        if (fin.boxText) { var fs2 = fin.boxTextSize; b.box[1] = [fs2[0], fs2[1]]; }
        var shown = fin;
        try { shown = u.p.valueAtTime(u.t, false); } catch (e) {}
        b.rb = String(shown.text);
      } catch (e) { b.err = e.message || String(e); }
    }
    // where the translated texts are seen in the version (the paths Preflight writes)
    var want = {};
    for (var w = 0; w < Lg.units.length; w++) { var mc = map["c" + Lg.units[w].c]; if (mc) want[mc.id + ":" + Lg.units[w].li] = true; }
    var walkV = function (c, path, depth) {
      for (var j = 1; j <= c.numLayers; j++) {
        var L2 = c.layer(j), here = path + " > " + j + ": " + L2.name;
        if (L2 instanceof TextLayer) { if (want[c.id + ":" + j]) rec.occ.push([here, c.id, j]); continue; }
        var s2 = null;
        try { s2 = L2.source; } catch (e) {}
        if (s2 instanceof CompItem && depth < 8) walkV(s2, here, depth + 1);
      }
    };
    walkV(vroot, vroot.name, 0);
  }
} catch (e) {
  return { langs: out.langs, fatal: e.message || String(e), rollback: true };
}
return out;`;
