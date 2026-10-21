// The farm scan: what the render queue items a farm will render need, read from the open project (read-only, no undo
// step). From each render queue item's comp down through its precomps (as X-ray follows the render queue): the footage
// and proxies its layers pull in, the effects by match name, the fonts of its text layers, plus the item's own render
// settings and output modules. Which item reaches which comp is worked out in Node from each comp's precomps (`sub`);
// everything is checked against the disk and the network in Node too (src/farm/manifest.ts).

export const FARM_SCAN_JSX = `
var P = app.project, t0 = new Date().getTime(), budget = (args.timeBudgetSeconds || 90) * 1000, maxLayers = args.maxLayers || 50000;
var D = { v: 1, items: [], comps: [], footage: [], effects: [], layers: 0 };
try { D.ae = app.version; } catch (e) {}
try { D.build = app.buildName; } catch (e) {}
try { D.os = $.os; } catch (e) {}
try { D.app = Folder.appPackage.fsName; } catch (e) {}
D.file = P.file ? P.file.fsName : null;
D.dirty = P.dirty;
try { D.engine = P.expressionEngine; } catch (e) {}
try { D.gpu = aemcp.enumName(GpuAccelType, P.gpuAccelType); } catch (e) {}
D.color = {};
var ck = ["bitsPerChannel", "colorManagementSystem", "workingSpace", "workingGamma", "linearBlending", "linearizeWorkingSpace", "compensateForSceneReferredProfiles", "ocioConfigurationFile", "workingColorSpace", "displayColorSpace"];
for (var c0 = 0; c0 < ck.length; c0++) { try { var cv = P[ck[c0]]; if (cv !== undefined && cv !== null) D.color[ck[c0]] = cv; } catch (e) {} }
// Multi-Frame Rendering is a preference: read only where this After Effects has one of these keys (never guessed)
D.mfr = null;
try {
  var MK = [["Main Pref Section v2", "Pref_MFR_ENABLED"], ["Main Pref Section", "Pref_MFR_ENABLED"], ["Main Pref Section v2", "Enable Multi-Frame Rendering"]];
  for (var mk = 0; mk < MK.length && D.mfr === null; mk++) {
    if (app.preferences.havePref(MK[mk][0], MK[mk][1], PREFType.PREF_Type_MACHINE_SPECIFIC)) D.mfr = { on: app.preferences.getPrefAsBool(MK[mk][0], MK[mk][1], PREFType.PREF_Type_MACHINE_SPECIFIC), key: MK[mk][1] };
  }
} catch (e) {}
function r4(n) { return aemcp.round(n); }
// a settings object (GetSettingsFormat.STRING) as flat "Key" / "Group/Key" strings
function flat(o, pre, out) {
  for (var k in o) {
    if (!o.hasOwnProperty(k)) continue;
    var v = o[k], key = pre ? pre + "/" + k : k;
    if (v !== null && typeof v === "object") flat(v, key, out); else out[key] = String(v);
  }
  return out;
}
var SEQ = /\\.(png|jpe?g|tiff?|exr|dpx|tga|bmp|cin|hdr|sgi|rgb|iff|psd|pct|pict|jp2|j2c|rla|rpf|webp|avif|heic)$/i;
function isSeq(f, still) { return !!f && !still && SEQ.test(f.fsName) && /\\d+\\.[^.\\/\\\\]+$/.test(f.fsName); }
function addTo(a, v) { for (var x = 0; x < a.length; x++) if (a[x] === v) return; a.push(v); }

// the render queue items asked for (default: the queued ones)
var RQ = P.renderQueue, want = [];
if (args.rq && args.rq.length) {
  for (var a = 0; a < args.rq.length; a++) {
    if (args.rq[a] < 1 || args.rq[a] > RQ.numItems) aemcp.fail("The render queue has no item " + args.rq[a] + " (it has " + RQ.numItems + ").");
    want.push(args.rq[a]);
  }
} else for (var q = 1; q <= RQ.numItems; q++) { try { if (RQ.item(q).status === RQItemStatus.QUEUED) want.push(q); } catch (e) {} }
D.rqCount = RQ.numItems;

var order = [], seen = {};
function addComp(c) { var k = "i:" + c.id; if (seen[k]) return; seen[k] = true; order.push(c); }
for (var w = 0; w < want.length; w++) {
  var ri = RQ.item(want[w]), comp = ri.comp;
  var it = { index: want[w], status: aemcp.enumName(RQItemStatus, ri.status), comp: { id: comp.id, name: comp.name, w: comp.width, h: comp.height, par: r4(comp.pixelAspect), fps: comp.frameRate, fd: comp.frameDuration, dur: comp.duration, dst: comp.displayStartTime, was: comp.workAreaStart, wad: comp.workAreaDuration }, start: ri.timeSpanStart, dur: ri.timeSpanDuration, oms: [] };
  try { it.comp.df = comp.dropFrame; } catch (e) {}
  try { it.rs = flat(ri.getSettings(GetSettingsFormat.STRING), "", {}); } catch (e) { it.rsError = e.message; }
  var nom = 1;
  try { nom = ri.numOutputModules; } catch (e) {}
  for (var o = 1; o <= nom; o++) {
    try {
      var om = ri.outputModule(o), oo = { index: o, name: om.name };
      try { if (om.file) oo.file = om.file.fsName; } catch (e) {}
      try { oo.settings = flat(om.getSettings(GetSettingsFormat.STRING), "", {}); } catch (e) { oo.settingsError = e.message; }
      it.oms.push(oo);
    } catch (e) {}
  }
  D.items.push(it);
  addComp(comp);
}

// installed effects by match name (display name, category, version where this After Effects has it)
var inst = {};
try { var all = app.effects; for (var e1 = 0; e1 < all.length; e1++) { var ae = all[e1], io = { n: ae.displayName, c: ae.category }; try { if (ae.version !== undefined) io.v = String(ae.version); } catch (e) {} inst["m:" + ae.matchName] = io; } } catch (e) {}

// from the render queue's comps down through their precomps (breadth first), within the budget
var fx = {}, fxList = [], ft = {}, ftList = [], layerAt = {}, texts = [], stopped = null, pos = 0;
function footage(src, on, at, cid) {
  var k = "f:" + src.id, rec = ft[k];
  if (!rec) {
    rec = ft[k] = { id: src.id, name: src.name, on: 0, uses: 0, at: [], cs: [] };
    var ms = src.mainSource;
    if (ms instanceof SolidSource) rec.kind = "solid";
    else if (ms instanceof PlaceholderSource) rec.kind = "placeholder";
    else {
      rec.kind = "file";
      rec.missing = !!src.footageMissing;
      try { if (src.file) rec.file = src.file.fsName; } catch (e) {}
      try { if (rec.missing && ms.missingFootagePath) rec.missingPath = ms.missingFootagePath; } catch (e) {}
      try { rec.still = ms.isStill; } catch (e) {}
      rec.seq = isSeq(src.file, rec.still);
      try { rec.w = src.width; rec.h = src.height; rec.fps = r4(src.frameRate); rec.dur = r4(src.duration); } catch (e) {}
    }
    try {
      if (src.proxySource && src.proxySource.file) {
        var pf = src.proxySource.file, pst = false;
        try { pst = src.proxySource.isStill; } catch (e) {}
        rec.proxy = { file: pf.fsName, inUse: !!src.useProxy, missing: !pf.exists, seq: isSeq(pf, pst) };
      }
    } catch (e) {}
    ftList.push(rec);
  }
  rec.uses++;
  if (on) rec.on++;
  if (rec.at.length < 12 && rec.at[rec.at.length - 1] !== at) rec.at.push(at);
  addTo(rec.cs, cid);
}
while (pos < order.length && !stopped && !args.itemsOnly) {
  var C = order[pos++], crec = { id: C.id, name: C.name, layers: C.numLayers, sub: [] };
  D.comps.push(crec);
  for (var j = 1; j <= C.numLayers; j++) {
    if (D.layers >= maxLayers) { stopped = "layer limit (" + maxLayers + ") reached"; break; }
    if (new Date().getTime() - t0 > budget) { stopped = "time budget (" + Math.round(budget / 1000) + " s) used up"; break; }
    var L = C.layer(j), at = C.name + " > " + L.name, on = true;
    D.layers++;
    try { if (!L.enabled) on = false; } catch (e) {}
    try { if (L.guideLayer) on = false; } catch (e) {}
    try { layerAt["i:" + L.id] = { at: at, on: on, c: C.id }; } catch (e) {}
    var src = null;
    try { src = L.source; } catch (e) {}
    if (src instanceof CompItem) { addComp(src); addTo(crec.sub, src.id); }
    else if (src instanceof FootageItem) footage(src, on, at, C.id);
    try {
      var par = L.property("ADBE Effect Parade");
      for (var f = 1; par && f <= par.numProperties; f++) {
        var ef = par.property(f), key = "m:" + ef.matchName, rec = fx[key];
        if (ef.matchName.indexOf("Pseudo/") === 0) continue;
        if (!rec) { rec = fx[key] = { m: ef.matchName, n: ef.name, k: 0, on: 0, at: [], cs: [] }; var io2 = inst[key]; if (io2) { rec.dn = io2.n; rec.cat = io2.c; if (io2.v !== undefined) rec.v = io2.v; } else rec.x = 1; fxList.push(rec); }
        rec.k++;
        var eon = on;
        try { if (!ef.enabled) eon = false; } catch (e) {}
        if (eon) rec.on++;
        if (rec.at.length < 12 && rec.at[rec.at.length - 1] !== at) rec.at.push(at);
        addTo(rec.cs, C.id);
      }
    } catch (e) {}
    // older After Effects (no project.usedFonts): the font of each text layer at the comp's current time
    try { if (L instanceof TextLayer) { var td = L.property("ADBE Text Properties").property("ADBE Text Document").value, tf = { ps: td.font, at: at, on: on, c: C.id }; try { tf.family = td.fontFamily; tf.style = td.fontStyle; } catch (e) {} texts.push(tf); } } catch (e) {}
  }
}
D.effects = fxList;
D.footage = ftList;
if (stopped) D.partial = stopped;

// fonts: those the render's text layers use (style runs and Source Text keyframes included where After Effects lists them)
D.fonts = null;
if (args.itemsOnly) { D.ms = new Date().getTime() - t0; return aemcp.stringify(D); }
try {
  var miss = {}, mf = app.fonts.missingOrSubstitutedFonts;
  for (var m = 0; m < mf.length; m++) miss["p:" + mf[m].postScriptName] = mf[m].isSubstitute ? "substituted" : "missing";
  D.fonts = { used: null, missing: [] };
  for (var m2 = 0; m2 < mf.length; m2++) D.fonts.missing.push({ ps: mf[m2].postScriptName, family: mf[m2].familyName, style: mf[m2].styleName, sub: !!mf[m2].isSubstitute });
  var uf = null;
  try { uf = P.usedFonts; } catch (e) {}
  if (uf) {
    D.fonts.used = [];
    for (var u = 0; u < uf.length; u++) {
      var fo = uf[u].font, ue = { ps: fo.postScriptName, at: [], n: 0, on: 0, cs: [] }, ua = uf[u].usedAt, inReach = false, noIds = false;
      try { ue.family = fo.familyName; ue.style = fo.styleName; } catch (e) {}
      try { if (fo.version) ue.v = String(fo.version); } catch (e) {}
      try { if (fo.isFromAdobeFonts !== undefined) ue.adobe = !!fo.isFromAdobeFonts; } catch (e) {}
      try { if (fo.location) ue.loc = String(fo.location); } catch (e) {}
      if (miss["p:" + ue.ps]) ue.here = miss["p:" + ue.ps];
      for (var w2 = 0; ua && w2 < ua.length; w2++) {
        var lid = null;
        try { lid = ua[w2].layerID; } catch (e) {}
        if (typeof lid !== "number") { noIds = true; continue; }
        var la = layerAt["i:" + lid];
        if (!la) continue;
        inReach = true;
        ue.n++;
        if (la.on) ue.on++;
        if (ue.at.length < 12 && ue.at[ue.at.length - 1] !== la.at) ue.at.push(la.at);
        addTo(ue.cs, la.c);
      }
      // without layer ids the fonts can't be tied to the render: the text layers below are read instead
      if (noIds) { D.fonts.used = null; break; }
      if (inReach) D.fonts.used.push(ue);
    }
  }
} catch (e) {}
if (!D.fonts || !D.fonts.used) D.textFonts = texts;
D.ms = new Date().getTime() - t0;
return aemcp.stringify(D);`;

/**
 * What a node's own After Effects says about a manifest's needs (the parts that need After Effects): its version, the
 * effects installed by match name, and fonts by PostScript name (24.0+). Read-only.
 */
export const FARM_CHECK_JSX = `
var D = { effects: {}, fonts: null };
try { D.ae = app.version; } catch (e) {}
try { D.build = app.buildName; } catch (e) {}
try { D.app = Folder.appPackage.fsName; } catch (e) {}
var inst = {};
try { var all = app.effects; for (var i = 0; i < all.length; i++) inst["m:" + all[i].matchName] = all[i]; } catch (e) {}
for (var k = 0; k < args.effects.length; k++) {
  var e = inst["m:" + args.effects[k]];
  D.effects[args.effects[k]] = e ? { n: e.displayName } : null;
  try { if (e && e.version !== undefined) D.effects[args.effects[k]].v = String(e.version); } catch (x) {}
}
try {
  if (app.fonts && app.fonts.getFontsByPostScriptName) {
    D.fonts = {};
    for (var f = 0; f < args.fonts.length; f++) { var hit = app.fonts.getFontsByPostScriptName(args.fonts[f]); D.fonts[args.fonts[f]] = !!(hit && hit.length); }
  }
} catch (e) { D.fonts = null; }
return aemcp.stringify(D);`;
