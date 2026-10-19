// ae_project_xray: explains an inherited project instead of tidying it. The ExtendScript below only
// collects raw facts, fast and read-only (no undo step, no temporary items, no UI changes), and stops
// at a time budget; parsing expressions, building the graphs and the summary happen in TypeScript
// (xray-analyze.ts, xray-expr.ts).
import { z } from "zod";
import type { JsxTool } from "./registry.js";
import { formatXray, SECTIONS, type XData } from "./xray-analyze.js";

export const XRAY_JSX = `
var P = app.project, t0 = new Date().getTime();
var secs = args.sections && args.sections.length ? args.sections : ["render", "expressions", "missing", "footage", "weight"], want = {};
for (var s = 0; s < secs.length; s++) want["k:" + secs[s]] = true;
function has(k) { return want["k:" + k] === true; }
var budget = (args.timeBudgetSeconds || 90) * 1000, maxLayers = args.maxLayers || 20000, MAXSRC = 20000;
var D = { v: 1, sections: secs, comps: [], footage: [], rq: [], layersScanned: 0 };
try { D.ae = app.version; } catch (e) {}
try { D.engine = P.expressionEngine; } catch (e) {}
D.project = { name: P.file ? File.decode(P.file.name) : "(unsaved)", file: P.file ? P.file.fsName : null, items: P.numItems, bpc: P.bitsPerChannel };
function r4(n) { return aemcp.round(n); }
function ids(a) { var o = []; try { for (var k = 0; k < a.length; k++) o.push(a[k].id); } catch (e) {} return o; }
// color-related interpretation attributes, as far as this After Effects version scripts them
function colorOf(ms) {
  var o = {}, n = 0;
  try {
    var props = ms.reflect.properties;
    for (var k = 0; k < props.length; k++) {
      var nm = String(props[k].name);
      if (!/colou?r|profile|space|lut/i.test(nm)) continue;
      try { var v = ms[nm], tv = typeof v; if (tv === "string" || tv === "number" || tv === "boolean") { o[nm] = v; n++; } } catch (e) {}
    }
  } catch (e) {}
  return n ? o : undefined;
}
function footage(it) {
  var o = { id: it.id, name: it.name, kind: "file", usedIn: ids(it.usedIn) }, ms = it.mainSource;
  if (ms instanceof SolidSource) { o.kind = "solid"; return o; }
  if (ms instanceof PlaceholderSource) o.kind = "placeholder";
  o.w = it.width; o.h = it.height; o.par = it.pixelAspect; o.dur = r4(it.duration); o.video = it.hasVideo; o.audio = it.hasAudio;
  try { o.fps = r4(it.frameRate); } catch (e) {}
  try { o.still = ms.isStill; } catch (e) {}
  if (o.kind === "file") {
    o.missing = it.footageMissing;
    try { o.file = it.file ? it.file.fsName : null; } catch (e) {}
    try { if (it.footageMissing && ms.missingFootagePath) o.missingPath = ms.missingFootagePath; } catch (e) {}
    try { o.alpha = ms.hasAlpha; if (ms.hasAlpha) o.alphaMode = aemcp.enumName(AlphaMode, ms.alphaMode); } catch (e) {}
    try { o.nativeFps = r4(ms.nativeFrameRate); } catch (e) {}
    if (has("footage")) o.color = colorOf(ms);
  }
  try {
    if (it.proxySource) {
      var pf = it.proxySource.file;
      o.proxy = { file: pf ? pf.fsName : null, inUse: it.useProxy };
      if (pf && !pf.exists) o.proxy.missing = true;
    }
  } catch (e) {}
  return o;
}
// installed effects: match name -> display name (missing plug-ins; untouched default effect names)
var inst = {};
if (has("missing") || has("expressions") || has("weight")) { var all = app.effects; for (var e1 = 0; e1 < all.length; e1++) inst["m:" + all[e1].matchName] = all[e1].displayName; }

// a plain function declaration: ExtendScript mishandles recursive named function expressions inside loops
function walk(g, path, out) {
  for (var k = 1; k <= g.numProperties; k++) {
    try {
      var p = g.property(k), pp = path ? path + "/" + p.name : p.name;
      if (p.propertyType !== PropertyType.PROPERTY) walk(p, pp, out);
      else if (p.canSetExpression && p.expression !== "") {
        var x = p.expression, rec = [pp, x.length > MAXSRC ? x.substr(0, MAXSRC) : x, p.expressionError || "", p.expressionEnabled ? 1 : 0];
        if (x.length > MAXSRC) rec.push(1);
        out.push(rec);
      }
    } catch (e) {}
  }
}
function layer(L) {
  var o = { i: L.index, id: L.id, n: L.name, t: aemcp.layerType(L) }, src = null;
  if (!L.enabled) o.off = 1;
  if (L.shy) o.shy = 1;
  try { if (L.guideLayer) o.guide = 1; } catch (e) {}
  try { if (L.isTrackMatte) o.matte = 1; } catch (e) {}
  try { if (L.parent) o.par = L.parent.index; } catch (e) {}
  try { src = L.source; } catch (e) {}
  if (src) o.src = src.id;
  // TextLayer and ShapeLayer are not AVLayer subclasses in After Effects
  if (L instanceof AVLayer || L instanceof TextLayer || L instanceof ShapeLayer) {
    try { if (L.adjustmentLayer) { o.adj = 1; o.inP = r4(L.inPoint); o.outP = r4(L.outPoint); } } catch (e) {}
    if (has("weight")) {
      try { if (L.collapseTransformation) o.cl = 1; } catch (e) {}
      try { if (L.timeRemapEnabled) o.tr = 1; } catch (e) {}
      try { if (L.frameBlendingType !== FrameBlendingType.NO_FRAME_BLEND) o.fb = aemcp.enumName(FrameBlendingType, L.frameBlendingType); } catch (e) {}
      try { if (L.motionBlur) o.mb = 1; } catch (e) {}
      try { if (L.threeDLayer) o.d3 = 1; } catch (e) {}
      try { if (src instanceof FootageItem && !(src.mainSource instanceof SolidSource) && src.width) { var sc = L.property("ADBE Transform Group").property("ADBE Scale").value; o.sc = [r4(sc[0]), r4(sc[1])]; } } catch (e) {}
    }
  }
  if (has("missing") || has("weight") || has("expressions")) {
    try {
      var fx = L.property("ADBE Effect Parade");
      if (fx && fx.numProperties) {
        o.fx = [];
        for (var f = 1; f <= fx.numProperties; f++) {
          var ef = fx.property(f), fo = { m: ef.matchName, n: ef.name }, dn = inst["m:" + ef.matchName];
          if (!ef.enabled) fo.off = 1;
          if (dn === undefined) { if (ef.matchName.indexOf("Pseudo/") !== 0) fo.x = 1; }
          else if (dn === ef.name) fo.d = 1;
          o.fx.push(fo);
        }
      }
    } catch (e) {}
  }
  if (has("missing") && o.t === "text") { try { o.font = L.property("ADBE Text Properties").property("ADBE Text Document").value.font; } catch (e) {} }
  if (has("expressions")) { var ex = []; walk(L, "", ex); if (ex.length) o.ex = ex; }
  return o;
}

// items: every comp and footage item (cheap); layers are read below, within the budget
var comps = {}, byId = {}, compList = [];
for (var i = 1; i <= P.numItems; i++) {
  var it = P.item(i);
  if (it instanceof CompItem) {
    var c = { id: it.id, name: it.name, w: it.width, h: it.height, fps: r4(it.frameRate), dur: r4(it.duration), par: it.pixelAspect, nl: it.numLayers, usedIn: ids(it.usedIn) };
    if (has("weight")) { try { c.mb = it.motionBlur; c.sa = it.shutterAngle; c.spf = it.motionBlurSamplesPerFrame; c.asl = it.motionBlurAdaptiveSampleLimit; c.fb = it.frameBlending; c.rend = it.renderer; } catch (e) {} }
    D.comps.push(c); comps["i:" + it.id] = it; byId["i:" + it.id] = c; compList.push(it.id);
  } else if (it instanceof FootageItem) D.footage.push(footage(it));
}
try {
  var RQ = P.renderQueue;
  for (var q = 1; q <= RQ.numItems; q++) {
    // one unreadable item doesn't stop the rest from being read
    try {
      var ri = RQ.item(q), ro = { comp: ri.comp.id, status: aemcp.enumName(RQItemStatus, ri.status), render: ri.render };
      try { var om = ri.outputModule(1); if (om.file) ro.file = om.file.fsName; } catch (e) {}
      D.rq.push(ro);
    } catch (e) {}
  }
} catch (e) {}
if (has("missing")) {
  D.fonts = null;
  try {
    var mf = app.fonts.missingOrSubstitutedFonts, fl = [];
    for (var m = 0; m < mf.length; m++) fl.push({ ps: mf[m].postScriptName, family: mf[m].familyName, style: mf[m].styleName, sub: mf[m].isSubstitute });
    D.fonts = { missing: fl };
    try { var uf = P.usedFonts; if (uf) { D.fonts.used = []; for (var u = 0; u < uf.length; u++) D.fonts.used.push({ ps: uf[u].font.postScriptName, layers: uf[u].usedAt ? uf[u].usedAt.length : 0 }); } } catch (e) {}
  } catch (e) {}
}

// layers: the render queue's trees first (or the requested comps and their precomps), breadth first
var order = [], queued = {};
function enqueue(id) { if (queued["i:" + id] || !byId["i:" + id]) return; queued["i:" + id] = true; order.push(id); }
if (args.comps && args.comps.length) {
  D.scope = [];
  for (var a = 0; a < args.comps.length; a++) {
    var ci = args.comps[a] === "active" ? P.activeItem : aemcp.findItem(args.comps[a]);
    if (!(ci instanceof CompItem)) aemcp.fail(args.comps[a] === "active" ? "No active composition." : "'" + ci.name + "' is not a composition");
    D.scope.push(ci.id); enqueue(ci.id);
  }
} else { for (var q2 = 0; q2 < D.rq.length; q2++) enqueue(D.rq[q2].comp); }
var stopped = null, pos = 0, nextAll = 0;
while (!stopped) {
  if (pos >= order.length) {
    if (D.scope) break;
    while (nextAll < compList.length && queued["i:" + compList[nextAll]]) nextAll++;
    if (nextAll >= compList.length) break;
    enqueue(compList[nextAll]);
  }
  var cid = order[pos++], comp = comps["i:" + cid], rec = byId["i:" + cid];
  rec.layers = []; rec.scanned = 0;
  for (var j = 1; j <= comp.numLayers; j++) {
    if (D.layersScanned >= maxLayers) { stopped = "layer limit (" + maxLayers + ") reached"; break; }
    if (new Date().getTime() - t0 > budget) { stopped = "time budget (" + Math.round(budget / 1000) + " s) used up"; break; }
    var lr = layer(comp.layer(j));
    rec.layers.push(lr); rec.scanned++; D.layersScanned++;
    if (lr.src !== undefined) enqueue(lr.src);
  }
}
if (stopped) D.partial = { reason: stopped };
D.ms = new Date().getTime() - t0;
return aemcp.stringify(D);`;

export const xrayTools: JsxTool[] = [
  {
    name: "ae_project_xray",
    title: "Project X-ray",
    description:
      "Explain how an unfamiliar (inherited) project works, without changing anything. Sections: render (what the render queue pulls in: " +
      "precomp trees and depth, comps nothing renders, comps used in many places), expressions (what every expression reads, dependency hubs " +
      "and cross-comp links, broken links, links that break on rename / reorder / in another AE language, expressions with errors), missing " +
      "(plug-ins, footage, fonts, proxies, placeholders), footage (specs, frame-rate mismatches, very large sources), weight (heavy effects, " +
      "effects on disabled/shy/guide layers, motion blur samples, 3D renderer, frame blending, time remap, full-length adjustment layers, " +
      "footage scaled far down). Returns a summary line plus compact JSON; big projects return partial results within the time budget.",
    input: {
      sections: z.array(z.enum(SECTIONS)).optional().describe("Sections to include (default: all)."),
      comps: z
        .array(z.union([z.number().int(), z.string()]))
        .optional()
        .describe('Only these comps and the precomps they pull in: ids or exact names, "active" for the open comp. Default: the whole project.'),
      limit: z.number().int().min(1).max(200).optional().describe('Longest list per finding (default 25); "cut" in the result counts what was left out.'),
      maxLayers: z.number().int().min(100).max(200000).optional().describe("Stop reading after this many layers (default 20000)."),
      timeBudgetSeconds: z.number().min(5).max(600).optional().describe("Stop reading after this long and report what was read (default 90)."),
    },
    readOnly: true,
    timeoutMs: 720_000,
    jsx: XRAY_JSX,
    format: (result, args) => formatXray((typeof result === "string" ? JSON.parse(result) : result) as XData, { limit: args.limit as number | undefined }),
  },
];
