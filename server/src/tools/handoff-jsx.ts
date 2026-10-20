// The handoff packager's ExtendScript: SCAN reads what the manifest needs from the open project (read-only, no undo
// step); WRITE makes the package's copy of the project, and for the proof two more copies with a render queue for
// aerender. The open project is never edited: every change is made in a copy after a Save As, and the user's project
// is opened again from disk at the end (also when something fails half way).

export const HANDOFF_SCAN_JSX = `
var P = app.project, t0 = new Date().getTime(), budget = (args.timeBudgetSeconds || 90) * 1000, maxLayers = args.maxLayers || 50000;
var D = { v: 1, comps: [], footage: [], rq: [], layers: 0 };
try { D.ae = app.version; } catch (e) {}
try { D.build = app.buildName; } catch (e) {}
try { D.os = $.os; } catch (e) {}
try { D.app = Folder.appPackage.fsName; } catch (e) {}
D.file = P.file ? P.file.fsName : null;
D.dirty = P.dirty;
D.items = P.numItems;
try { D.engine = P.expressionEngine; } catch (e) {}
// bit depth and color management, as far as this After Effects version scripts them
D.color = {};
var ck = ["bitsPerChannel", "colorManagementSystem", "workingSpace", "workingGamma", "linearBlending", "linearizeWorkingSpace", "compensateForSceneReferredProfiles", "ocioConfigurationFile", "workingColorSpace", "displayColorSpace"];
for (var c0 = 0; c0 < ck.length; c0++) { try { var cv = P[ck[c0]]; if (cv !== undefined && cv !== null) D.color[ck[c0]] = cv; } catch (e) {} }
function r4(n) { return aemcp.round(n); }
function folderPath(it) {
  // by id: two references to the same folder need not be the same object in ExtendScript
  var a = [], f = null, guard = 0, root = null;
  try { root = P.rootFolder.id; } catch (e) {}
  try { f = it.parentFolder; while (f && f.id !== root && f.parentFolder && guard++ < 64) { a.unshift(f.name); f = f.parentFolder; } } catch (e) {}
  return a;
}
// still images numbered like name_0001.png that are not stills: an image sequence (scripting has no flag for it)
var SEQ = /\\.(png|jpe?g|tiff?|exr|dpx|tga|bmp|cin|hdr|sgi|rgb|iff|psd|pct|pict|jp2|j2c|rla|rpf|webp|avif|heic)$/i;
function isSeq(f, still) { return !!f && !still && SEQ.test(f.fsName) && /\\d+\\.[^.\\/\\\\]+$/.test(f.fsName); }
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
  var o = { id: it.id, name: it.name, kind: "file", folder: folderPath(it), used: 0 }, ms = it.mainSource;
  try { o.used = it.usedIn.length; } catch (e) {}
  if (ms instanceof SolidSource) { o.kind = "solid"; return o; }
  if (ms instanceof PlaceholderSource) o.kind = "placeholder";
  o.w = it.width; o.h = it.height; o.par = r4(it.pixelAspect); o.dur = r4(it.duration); o.video = it.hasVideo; o.audio = it.hasAudio;
  try { o.fps = r4(it.frameRate); } catch (e) {}
  try { o.still = ms.isStill; } catch (e) {}
  if (o.kind !== "file") return o;
  o.missing = !!it.footageMissing;
  try { if (it.file) o.file = it.file.fsName; } catch (e) {}
  try { if (o.missing && ms.missingFootagePath) o.missingPath = ms.missingFootagePath; } catch (e) {}
  o.seq = isSeq(it.file, o.still);
  try { o.alpha = ms.hasAlpha; if (ms.hasAlpha) o.alphaMode = aemcp.enumName(AlphaMode, ms.alphaMode); } catch (e) {}
  try { o.nativeFps = r4(ms.nativeFrameRate); } catch (e) {}
  try { if (ms.conformFrameRate) o.conformFps = r4(ms.conformFrameRate); } catch (e) {}
  o.color = colorOf(ms);
  try {
    if (it.proxySource && it.proxySource.file) {
      var pf = it.proxySource.file, pstill = false;
      try { pstill = it.proxySource.isStill; } catch (e) {}
      o.proxy = { file: pf.fsName, inUse: it.useProxy, missing: !pf.exists, seq: isSeq(pf, pstill) };
    }
  } catch (e) {}
  return o;
}
var lid = {}, compItems = [];
for (var i = 1; i <= P.numItems; i++) {
  var it = P.item(i);
  if (it instanceof CompItem) {
    compItems.push(it);
    D.comps.push({ id: it.id, name: it.name, w: it.width, h: it.height, par: r4(it.pixelAspect), fps: r4(it.frameRate), dur: r4(it.duration), was: r4(it.workAreaStart), wad: r4(it.workAreaDuration), nl: it.numLayers });
  } else if (it instanceof FootageItem) D.footage.push(footage(it));
}
try { if (P.activeItem instanceof CompItem) D.active = P.activeItem.id; } catch (e) {}
try {
  for (var q = 1; q <= P.renderQueue.numItems; q++) {
    try { var ri = P.renderQueue.item(q); D.rq.push({ comp: ri.comp.id, queued: ri.status === RQItemStatus.QUEUED }); } catch (e) {}
  }
} catch (e) {}

// effects by match name: installed ones (display name, category, version where this AE has it) and every instance
var inst = {};
try { var all = app.effects; for (var e1 = 0; e1 < all.length; e1++) { var ae = all[e1], io = { n: ae.displayName, c: ae.category }; try { if (ae.version !== undefined) io.v = String(ae.version); } catch (e) {} inst["m:" + ae.matchName] = io; } } catch (e) {}
var fx = {}, fxList = [], texts = [], stopped = null;
for (var ci = 0; ci < compItems.length && !stopped; ci++) {
  var comp = compItems[ci];
  for (var j = 1; j <= comp.numLayers; j++) {
    if (D.layers >= maxLayers) { stopped = "layer limit (" + maxLayers + ") reached"; break; }
    if (new Date().getTime() - t0 > budget) { stopped = "time budget (" + Math.round(budget / 1000) + " s) used up"; break; }
    var L = comp.layer(j), at = comp.name + " > " + L.name;
    D.layers++;
    try { lid["i:" + L.id] = at; } catch (e) {}
    try {
      var par = L.property("ADBE Effect Parade");
      for (var f = 1; par && f <= par.numProperties; f++) {
        var ef = par.property(f), key = "m:" + ef.matchName, rec = fx[key];
        if (!rec) { rec = fx[key] = { m: ef.matchName, n: ef.name, k: 0, at: [] }; var io2 = inst[key]; if (io2) { rec.dn = io2.n; rec.cat = io2.c; if (io2.v !== undefined) rec.v = io2.v; } else rec.x = 1; fxList.push(rec); }
        rec.k++;
        if (rec.at.length < 12 && rec.at[rec.at.length - 1] !== at) rec.at.push(at);
      }
    } catch (e) {}
    // older After Effects (no project.usedFonts): the font of each text layer at the comp's current time
    try { if (L instanceof TextLayer) { var td = L.property("ADBE Text Properties").property("ADBE Text Document").value, tf = { ps: td.font, at: at }; try { tf.family = td.fontFamily; tf.style = td.fontStyle; } catch (e) {} texts.push(tf); } } catch (e) {}
  }
}
D.effects = fxList;
if (stopped) D.partial = stopped;

// fonts: every font the project uses and the layers that use it (24.0+), and which are missing or substituted here
D.fonts = null;
try {
  var miss = {}, mf = app.fonts.missingOrSubstitutedFonts;
  for (var m = 0; m < mf.length; m++) miss["p:" + mf[m].postScriptName] = mf[m].isSubstitute ? "substituted" : "missing";
  D.fonts = { missing: [] };
  for (var m2 = 0; m2 < mf.length; m2++) D.fonts.missing.push({ ps: mf[m2].postScriptName, family: mf[m2].familyName, style: mf[m2].styleName, sub: !!mf[m2].isSubstitute });
  var uf = null;
  try { uf = P.usedFonts; } catch (e) {}
  if (uf) {
    D.fonts.used = [];
    for (var u = 0; u < uf.length; u++) {
      var fo = uf[u].font, ue = { ps: fo.postScriptName, at: [], n: 0 }, ua = uf[u].usedAt;
      try { ue.family = fo.familyName; ue.style = fo.styleName; } catch (e) {}
      try { if (fo.version) ue.v = String(fo.version); } catch (e) {}
      try { if (fo.isFromAdobeFonts !== undefined) ue.adobe = !!fo.isFromAdobeFonts; } catch (e) {}
      try { if (fo.location) ue.loc = String(fo.location); } catch (e) {}
      if (miss["p:" + ue.ps]) ue.here = miss["p:" + ue.ps];
      for (var w = 0; ua && w < ua.length; w++) {
        ue.n++;
        var name = null;
        try { name = lid["i:" + ua[w].layerID]; } catch (e) {}
        if (name && ue.at.length < 12 && ue.at[ue.at.length - 1] !== name) ue.at.push(name);
      }
      D.fonts.used.push(ue);
    }
  }
} catch (e) {}
if (!D.fonts || !D.fonts.used) D.textFonts = texts;
D.ms = new Date().getTime() - t0;
return aemcp.stringify(D);`;

/**
 * args: {original, dest, relink: [{id, path, seq, proxy?: {path, seq}}], reduce, root (the package folder), ref?, col?}
 * where ref / col = {path, comps: [{id, times, dirs}]}: a copy for aerender with only the proof frames queued (PNG,
 * one folder per frame). Order: [reference copy] -> reopen -> package copy (relink, reduce, save) -> [verification
 * copy of the package] -> reopen. Returns what it did and checked; an error is returned in `error`, never thrown, so
 * the result still says which project After Effects has open.
 */
export const HANDOFF_WRITE_JSX = `
var orig = args.original, res = { relinked: 0, relinkFailed: [], steps: [] };
function cur() { try { return app.project.file ? app.project.file.fsName : null; } catch (e) { return null; } }
function byId(id) { var P = app.project; for (var i = 1; i <= P.numItems; i++) { var it = P.item(i); if (it.id === id) return it; } return null; }
// open the user's project again (from a copy: a copy that wasn't saved is closed without saving, never the original)
function reopen() {
  if (cur() === orig) return;
  if (app.project.dirty) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
  app.open(new File(orig));
  if (cur() !== orig) throw new Error("After Effects did not open " + orig + " again");
}
var INTERP = ["conformFrameRate", "alphaMode", "premulColor", "invertAlpha", "fieldSeparationType", "highQualityFieldSeparation", "removePulldown", "loop"];
function interp(ms) { var o = {}; for (var k = 0; k < INTERP.length; k++) { try { o[INTERP[k]] = ms[INTERP[k]]; } catch (e) {} } return o; }
function restoreInterp(ms, o) {
  for (var k = 0; k < INTERP.length; k++) {
    var n = INTERP[k];
    if (o[n] === undefined) continue;
    try { var now = ms[n]; if (String(now) !== String(o[n])) ms[n] = o[n]; } catch (e) {}
  }
}
// every expression evaluated once at its comp's work area start; [comp, layer, property, error]
function exprErrors() {
  var P = app.project, out = { errors: [], n: 0 }, t0 = new Date().getTime(), lim = args.maxExpressions || 20000;
  function walk(g, path, c, L) {
    for (var k = 1; k <= g.numProperties; k++) {
      if (out.stopped) return;
      try {
        var p = g.property(k), pp = path ? path + "/" + p.name : p.name;
        if (p.propertyType !== PropertyType.PROPERTY) { walk(p, pp, c, L); continue; }
        if (!p.canSetExpression || !p.expressionEnabled || p.expression === "") continue;
        out.n++;
        try { p.valueAtTime(c.workAreaStart, false); } catch (e) {}
        if (p.expressionError) out.errors.push([c.name, L.name, pp, String(p.expressionError)]);
        if (out.n >= lim) out.stopped = "the first " + lim + " expressions were checked";
        else if (new Date().getTime() - t0 > 60000) out.stopped = "the time budget (60 s) was used up after " + out.n + " expressions";
      } catch (e) {}
    }
  }
  for (var i = 1; i <= P.numItems && !out.stopped; i++) {
    var c = P.item(i);
    if (!(c instanceof CompItem)) continue;
    for (var j = 1; j <= c.numLayers && !out.stopped; j++) walk(c.layer(j), "", c, c.layer(j));
  }
  return out;
}
function isPng(om) { try { return /png/i.test(String(om.getSettings(GetSettingsFormat.STRING)["Format"])); } catch (e) { return false; } }
function png(om) {
  try { om.setSettings({ "Format": "PNG Sequence" }); } catch (e) {}
  if (isPng(om)) return true;
  var ts = [];
  try { ts = om.templates; } catch (e) {}
  for (var k = 0; k < ts.length; k++) {
    if (!/png/i.test(ts[k])) continue;
    try { om.applyTemplate(ts[k]); } catch (e) {}
    if (isPng(om)) return true;
  }
  return false;
}
// a copy's render queue: only the proof frames (the user's own queued renders must not run, or write their files)
function proofQueue(spec) {
  var RQ = app.project.renderQueue, out = { frames: [], missing: [] };
  for (var i = RQ.numItems; i >= 1; i--) RQ.item(i).remove();
  for (var c = 0; c < spec.comps.length; c++) {
    var s = spec.comps[c], comp = byId(s.id);
    if (!(comp instanceof CompItem)) { out.missing.push(s.id); continue; }
    for (var j = 0; j < s.times.length; j++) {
      var ri = RQ.items.add(comp);
      ri.timeSpanStart = s.times[j];
      ri.timeSpanDuration = comp.frameDuration;
      var om = ri.outputModule(1);
      if (!png(om)) { out.noPng = true; return out; }
      try { om.setSettings({ "Video Output": { "Channels": "RGB + Alpha" } }); } catch (e) {}
      om.file = new File(s.dirs[j] + "/frame_[#####].png");
      out.frames.push({ id: comp.id, j: j, time: s.times[j] });
    }
  }
  return out;
}
try {
  if (cur() !== orig) aemcp.fail("The open project is no longer " + orig + ". Nothing was written.");
  if (app.project.dirty) aemcp.fail("The project has unsaved changes. Nothing was written.");
  if (args.ref) {
    // Save As: from here on the open project is the reference copy, not the user's project
    app.project.save(new File(args.ref.path));
    res.steps.push("reference copy");
    res.refExpr = exprErrors();
    res.refQueue = proofQueue(args.ref);
    app.project.save();
    reopen();
  }
  app.project.save(new File(args.dest));
  res.steps.push("package copy");
  for (var r = 0; r < args.relink.length; r++) {
    var rl = args.relink[r], it = byId(rl.id);
    if (!(it instanceof FootageItem)) { res.relinkFailed.push([rl.id, "", "item not found"]); continue; }
    var name = it.name;
    try {
      var keep = interp(it.mainSource);
      // replace() also renames the item after the file: expressions may refer to the item's name
      if (rl.seq) it.replaceWithSequence(new File(rl.path), false); else it.replace(new File(rl.path));
      if (it.name !== name) it.name = name;
      restoreInterp(it.mainSource, keep);
      res.relinked++;
    } catch (e) { res.relinkFailed.push([rl.id, name, e.message]); }
    if (rl.proxy) {
      try {
        var use = it.useProxy;
        if (rl.proxy.seq) it.setProxyWithSequence(new File(rl.proxy.path), false); else it.setProxy(new File(rl.proxy.path));
        if (it.useProxy !== use) it.useProxy = use;
      } catch (e) { res.relinkFailed.push([rl.id, name, "proxy: " + e.message]); }
    }
  }
  if (args.reduce) {
    var keepComps = [], P2 = app.project;
    for (var q = 1; q <= P2.numItems; q++) if (P2.item(q) instanceof CompItem) keepComps.push(P2.item(q));
    var before = P2.numItems;
    try { P2.reduceProject(keepComps); res.reduced = before - P2.numItems; } catch (e) { res.reduceError = e.message; }
  }
  app.project.save();
  res.steps.push("package saved");
  // what the copy refers to now (the paths are checked against the package folder in Node)
  var P3 = app.project, fl = [];
  for (var f = 1; f <= P3.numItems; f++) {
    var fi = P3.item(f);
    if (!(fi instanceof FootageItem) || fi.mainSource instanceof SolidSource) continue;
    var fo = { id: fi.id, name: fi.name, placeholder: fi.mainSource instanceof PlaceholderSource, missing: !!fi.footageMissing, used: 0 };
    try { fo.used = fi.usedIn.length; } catch (e) {}
    try { if (fi.file) fo.file = fi.file.fsName; } catch (e) {}
    try { if (fi.proxySource && fi.proxySource.file) fo.proxy = fi.proxySource.file.fsName; } catch (e) {}
    fl.push(fo);
  }
  res.copy = { footage: fl, items: P3.numItems };
  try { var mf = app.fonts.missingOrSubstitutedFonts; res.copy.fontsMissing = []; for (var m = 0; m < mf.length; m++) res.copy.fontsMissing.push(mf[m].postScriptName); } catch (e) {}
  res.colExpr = exprErrors();
  if (args.col) {
    res.colQueue = proofQueue(args.col);
    app.project.save(new File(args.col.path));
    res.steps.push("verification copy");
  }
} catch (e) {
  res.error = e.message || String(e);
} finally {
  try { reopen(); } catch (e) { res.reopenError = e.message || String(e); }
  res.open = cur();
  try { res.dirty = app.project.dirty; } catch (e) {}
}
return aemcp.stringify(res);`;
