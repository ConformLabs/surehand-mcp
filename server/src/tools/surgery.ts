// ae_precomp_surgery: un-precompose a precomp layer, or deep-duplicate a comp with all its nested precomps unlinked,
// with every expression reference rewritten exactly (src/surgery/expr.ts, plan.ts), a refusal with the exact reason for
// what can't be done exactly, and pixel proof that the picture is unchanged (ae_prove_identical's engine).
// How it stays safe: read the facts (no undo step), plan in TypeScript, save a checkpoint, capture reference frames,
// REHEARSE the surgery on a scratch copy (un-precompose: a duplicate of the parent comp; deep duplicate: the copies
// themselves), compare the scratch with the reference, remove the scratch by hand, and only when the proof says
// IDENTICAL apply the same surgery to the project in one undo step. Its result must match the rehearsal's
// (layer by layer), otherwise that step is undone at once. DIFFERS: the project was never changed.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { formatChanges, rollbackProblem, runJsx } from "../jsx.js";
import { approvalSummary, permissions, READ_ONLY_REFUSAL } from "../permissions.js";
import { blocking, planDeepDuplicate, planUnprecompose, type DFacts, type DPlan, type Override, type Problem, type Rewrite, type UFacts, type UPlan } from "../surgery/plan.js";
import { captureProof, compareProof, DEFAULT_TOLERANCE, type Comparison } from "./prove.js";
import { compRef, errorResult, layerRef, reportScope } from "./registry.js";
import { saveCheckpoint } from "./workflow.js";

// ---------- ExtendScript ----------

/** shared: every expression of a set of comps, with index and match-name paths; layer kinds */
const COMMON_JSX = `
function r4(n) { return aemcp.round(n); }
function en(E, v) { try { return String(aemcp.enumName(E, v)); } catch (e) { return String(v); } }
function ids(a) { var o = []; try { for (var k = 0; k < a.length; k++) o.push(a[k].id); } catch (e) {} return o; }
function kind(x) {
  var t = aemcp.layerType(x);
  if (t === "footage") { try { if (x.hasAudio && !x.hasVideo) return "audio"; } catch (e) {} return "av"; }
  if (t === "precomp" || t === "solid" || t === "layer") return "av";
  return t;
}
function exprsOf(g, ip, mp, np, out, base) {
  for (var k = 1; k <= g.numProperties; k++) {
    var p = null;
    try { p = g.property(k); } catch (e) {}
    if (!p) continue;
    var ip2 = ip.concat([k]), mp2 = mp.concat([p.matchName]), np2 = np ? np + "/" + p.name : p.name;
    if (p.propertyType !== PropertyType.PROPERTY) { exprsOf(p, ip2, mp2, np2, out, base); continue; }
    var x = "";
    try { x = p.canSetExpression ? p.expression : ""; } catch (e) {}
    if (x === "" || x === undefined || x === null) continue;
    var err = "";
    try { err = p.expressionError || ""; } catch (e) {}
    out.push({ c: base.c, l: base.l, ln: base.ln, p: ip2, mp: mp2, pn: np2, x: x, err: err, on: !!p.expressionEnabled });
  }
}
function compExprs(c, out) { for (var i = 1; i <= c.numLayers; i++) { var L = c.layer(i); exprsOf(L, [], [], "", out, { c: c.id, l: i, ln: L.name }); } }
function compF(c) {
  var o = { id: c.id, name: c.name, w: c.width, h: c.height, par: c.pixelAspect, fps: r4(c.frameRate), dur: r4(c.duration), nl: c.numLayers, usedIn: ids(c.usedIn) };
  try { o.mb = c.motionBlur; o.sa = c.shutterAngle; o.sp = c.shutterPhase; o.spf = c.motionBlurSamplesPerFrame; o.asl = c.motionBlurAdaptiveSampleLimit; o.fb = c.frameBlending; } catch (e) {}
  try { o.pnfr = !!c.preserveNestedFrameRate; o.pnr = !!c.preserveNestedResolution; } catch (e) {}
  try { o.egp = c.motionGraphicsTemplateControllerCount || 0; if (o.egp) o.egpName = c.motionGraphicsTemplateName || ""; } catch (e) {}
  return o;
}
function allComps() { var o = [], P = app.project; for (var i = 1; i <= P.numItems; i++) { var it = P.item(i); if (it instanceof CompItem) o.push({ id: it.id, name: it.name }); } return o; }
function byPath(L, path) { var p = L; for (var k = 0; k < path.length; k++) p = p.property(path[k]); return p; }
function eps(L) { try { var g = L.property("ADBE Layer Overrides"); return g ? g.numProperties : 0; } catch (e) { return 0; } }
`;

/** Un-precompose facts: the parent comp P, the precomp layer L, its source C, and every expression in the project. */
export const UFACTS_JSX = `${COMMON_JSX}
var P = aemcp.findComp(args.comp), L = aemcp.findLayer(P, args.layer), C = null;
try { C = L.source; } catch (e) {}
if (!(C instanceof CompItem)) aemcp.fail('Layer ' + L.index + ' "' + L.name + '" in "' + P.name + '" is not a precomp layer (its source is not a composition).');
var TF = ["ADBE Anchor Point", "ADBE Position", "ADBE Position_0", "ADBE Position_1", "ADBE Scale", "ADBE Rotate Z"];
function live(p) { try { return p.expression !== "" && p.expressionEnabled; } catch (e) { return false; } }
function opac(x) { var p = x.property("ADBE Transform Group").property("ADBE Opacity"); return { v: r4(p.value), keyed: p.numKeys > 0, expr: live(p) }; }
function sw(x, name) { try { return !!x[name]; } catch (e) { return false; } }
var tg = L.property("ADBE Transform Group"), pos = tg.property("ADBE Position");
var tf = { a: tg.property("ADBE Anchor Point").value, p: pos.value, s: tg.property("ADBE Scale").value, r: r4(tg.property("ADBE Rotate Z").value), keyed: false, expr: false };
var tps = [tg.property("ADBE Anchor Point"), tg.property("ADBE Scale"), tg.property("ADBE Rotate Z")];
if (pos.dimensionsSeparated) { tps.push(tg.property("ADBE Position_0")); tps.push(tg.property("ADBE Position_1")); } else tps.push(pos);
for (var k = 0; k < tps.length; k++) { if (tps[k].numKeys) tf.keyed = true; if (live(tps[k])) tf.expr = true; }
var lx = [];
exprsOf(L, [], [], "", lx, { c: P.id, l: L.index, ln: L.name });
var other = [];
for (var k2 = 0; k2 < lx.length; k2++) {
  var mp = lx[k2].mp, ok = mp.length === 2 && mp[0] === "ADBE Transform Group";
  if (ok) { ok = false; for (var t = 0; t < TF.length; t++) if (mp[1] === TF[t]) ok = true; }
  if (!ok && !(mp.length === 2 && mp[1] === "ADBE Opacity")) other.push(lx[k2].pn);
}
var styles = false;
try { var ls = L.property("ADBE Layer Styles"); if (ls && ls.enabled) for (var s1 = 1; s1 <= ls.numProperties; s1++) { var st = ls.property(s1); if (st.matchName !== "ADBE Blend Options Group" && st.enabled) styles = true; } } catch (e) {}
var audioChanged = false;
try { if (L.hasAudio && L.audioEnabled) { var al = L.property("ADBE Audio Group").property("ADBE Audio Levels"); audioChanged = al.numKeys > 0 || live(al) || al.value[0] !== 0 || al.value[1] !== 0; } } catch (e) {}
var children = [];
for (var i = 1; i <= P.numLayers; i++) { var y = P.layer(i); try { if (y.parent && y.parent.index === L.index) children.push(i); } catch (e) {} }
var Lf = {
  i: L.index, n: L.name, src: C.id, enabled: L.enabled, locked: L.locked, start: r4(L.startTime), "in": r4(L.inPoint), out: r4(L.outPoint), stretch: r4(L.stretch),
  timeRemap: sw(L, "timeRemapEnabled"), effects: L.property("ADBE Effect Parade").numProperties, masks: L.property("ADBE Mask Parade").numProperties, styles: styles,
  blend: en(BlendingMode, L.blendingMode), adj: sw(L, "adjustmentLayer"), d3: sw(L, "threeDLayer"), collapse: sw(L, "collapseTransformation"), mb: sw(L, "motionBlur"),
  fbt: en(FrameBlendingType, L.frameBlendingType), hasTM: sw(L, "hasTrackMatte"), isTM: sw(L, "isTrackMatte"), guide: sw(L, "guideLayer"), preserveT: sw(L, "preserveTransparency"),
  opacity: opac(L), tf: tf, par: L.parent ? L.parent.index : 0, children: children, eps: eps(L), autoOrient: en(AutoOrientType, L.autoOrient),
  markers: L.property("ADBE Marker").numKeys, otherExprs: other, audioChanged: audioChanged
};
var pl = [];
for (var j = 1; j <= P.numLayers; j++) { var pj = P.layer(j), o2 = { i: j, n: pj.name }; try { if (pj.source instanceof CompItem) o2.src = pj.source.id; } catch (e) {} pl.push(o2); }
function lindex(g, ip, np, out) {
  for (var k = 1; k <= g.numProperties; k++) {
    var p = g.property(k), ip2 = ip.concat([k]), np2 = np ? np + "/" + p.name : p.name;
    if (p.propertyType !== PropertyType.PROPERTY) { lindex(p, ip2, np2, out); continue; }
    try { if (p.propertyValueType === PropertyValueType.LAYER_INDEX) out.push({ p: ip2, pn: np2, v: p.value, keyed: p.numKeys > 0, expr: live(p) }); } catch (e) {}
  }
}
var cl = [];
for (var c1 = 1; c1 <= C.numLayers; c1++) {
  var x = C.layer(c1), kd = kind(x), li = [];
  try { var fx = x.property("ADBE Effect Parade"); if (fx) lindex(fx, [x.property("ADBE Effect Parade").propertyIndex], "Effects", li); } catch (e) {}
  var tmt = "NO_TRACK_MATTE", tml = 0;
  try { tmt = en(TrackMatteType, x.trackMatteType); } catch (e) {}
  try { if (x.trackMatteLayer) tml = x.trackMatteLayer.index; } catch (e) {}
  cl.push({
    i: c1, n: x.name, type: kd, enabled: x.enabled, locked: x.locked, start: r4(x.startTime), "in": r4(x.inPoint), out: r4(x.outPoint), par: x.parent ? x.parent.index : 0,
    blend: kd === "camera" || kd === "light" || kd === "null" ? "NORMAL" : en(BlendingMode, x.blendingMode), preserveT: sw(x, "preserveTransparency"), d3: sw(x, "threeDLayer"),
    guide: sw(x, "guideLayer"), solo: sw(x, "solo"), mb: sw(x, "motionBlur"), fbt: kd === "av" ? en(FrameBlendingType, x.frameBlendingType) : "NO_FRAME_BLEND",
    tm: tmt, tml: tml, isTM: sw(x, "isTrackMatte"), opacity: kd === "camera" || kd === "light" ? { v: 100, keyed: false, expr: false } : opac(x), li: li
  });
}
// what C's frame cut off: each visible layer's box (sourceRectAtTime through its transform and parents in C), and whether
// that part shows in P (exact when L isn't rotated: L's frame and the box are mapped into P)
function val(p, t) { return p.valueAtTime(t, false); }
function local(x, t) {
  var g = x.property("ADBE Transform Group"), a = val(g.property("ADBE Anchor Point"), t), s = val(g.property("ADBE Scale"), t), r = val(g.property("ADBE Rotate Z"), t) * Math.PI / 180, pp = g.property("ADBE Position"), p;
  p = pp.dimensionsSeparated ? [val(g.property("ADBE Position_0"), t), val(g.property("ADBE Position_1"), t)] : val(pp, t);
  var cs = Math.cos(r), sn = Math.sin(r), m0 = cs * s[0] / 100, m1 = sn * s[0] / 100, m2 = -sn * s[1] / 100, m3 = cs * s[1] / 100;
  return [m0, m1, m2, m3, p[0] - (m0 * a[0] + m2 * a[1]), p[1] - (m1 * a[0] + m3 * a[1])];
}
function mul(A, B) { return [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]]; }
function world(x, t, d) { var m = local(x, t), p = null; try { p = x.parent; } catch (e) {} return p && d < 50 ? mul(world(p, t, d + 1), m) : m; }
function box(m, x0, y0, w, h) {
  var xs = [x0, x0 + w, x0 + w, x0], ys = [y0, y0, y0 + h, y0 + h], b = [1e12, 1e12, -1e12, -1e12];
  for (var k = 0; k < 4; k++) { var X = m[0] * xs[k] + m[2] * ys[k] + m[4], Y = m[1] * xs[k] + m[3] * ys[k] + m[5]; b[0] = Math.min(b[0], X); b[1] = Math.min(b[1], Y); b[2] = Math.max(b[2], X); b[3] = Math.max(b[3], Y); }
  return b;
}
var bounds = [], rotated = false, Ls = L.startTime;
for (var b1 = 0; b1 < cl.length; b1++) {
  var f = cl[b1];
  if (!f.enabled || f.guide || f.type === "null" || f.type === "camera" || f.type === "light" || f.type === "audio") continue;
  var X1 = C.layer(f.i), t0 = Math.max(X1.inPoint, L.inPoint - Ls), t1 = Math.min(X1.outPoint, L.outPoint - Ls);
  if (!(t0 < t1)) continue;
  var worst = null;
  for (var q = 0; q < 9; q++) {
    var tt = t0 + (t1 - t0 - C.frameDuration) * q / 8, rc;
    if (tt < t0) tt = t0;
    try { rc = X1.sourceRectAtTime(tt, false); } catch (e) { continue; }
    var bb = box(world(X1, tt, 0), rc.left, rc.top, rc.width, rc.height);
    var by = Math.max(-bb[0], -bb[1], bb[2] - C.width, bb[3] - C.height);
    if (!(by > 0.5)) continue;
    var W = world(L, tt + Ls, 0);
    if (Math.abs(W[1]) > 1e-9 || Math.abs(W[2]) > 1e-9) { rotated = true; if (!worst || by > worst.by) worst = { ci: f.i, t: r4(tt), by: by }; continue; }
    var mc = box(W, 0, 0, C.width, C.height), mb = box(W, bb[0], bb[1], bb[2] - bb[0], bb[3] - bb[1]);
    var v0 = Math.max(mb[0], 0), v1 = Math.max(mb[1], 0), v2 = Math.min(mb[2], P.width), v3 = Math.min(mb[3], P.height);
    if (!(v0 < v2 && v1 < v3)) continue;
    if (v0 >= mc[0] - 0.5 && v1 >= mc[1] - 0.5 && v2 <= mc[2] + 0.5 && v3 <= mc[3] + 0.5) continue;
    if (!worst || by > worst.by) worst = { ci: f.i, t: r4(tt), by: by };
  }
  if (worst) bounds.push(worst);
}
var ex = [];
for (var n1 = 1; n1 <= app.project.numItems; n1++) { var it = app.project.item(n1); if (it instanceof CompItem) compExprs(it, ex); }
var rq = [];
try { for (var r1 = 1; r1 <= app.project.renderQueue.numItems; r1++) { try { rq.push(app.project.renderQueue.item(r1).comp.id); } catch (e) {} } } catch (e) {}
return { project: app.project.file ? app.project.file.fsName : null, P: compF(P), C: compF(C), L: Lf, pLayers: pl, cLayers: cl, comps: allComps(), rq: rq, exprs: ex, bounds: bounds, rotated: rotated };`;

/** Deep duplicate facts: the comp tree under the root (each comp once), the project's names, the tree's expressions. */
export const DFACTS_JSX = `${COMMON_JSX}
var R = aemcp.findComp(args.comp), seen = {}, order = [], tree = [];
function visit(c) {
  if (seen["i" + c.id]) return;
  seen["i" + c.id] = true;
  order.push(c);
  for (var i = 1; i <= c.numLayers; i++) { var s = null; try { s = c.layer(i).source; } catch (e) {} if (s instanceof CompItem) visit(s); }
}
visit(R);
for (var k = 0; k < order.length; k++) {
  var c = order[k], o = compF(c), ls = [];
  for (var i = 1; i <= c.numLayers; i++) {
    var L = c.layer(i), lo = { i: i, n: L.name }, s = null;
    try { s = L.source; } catch (e) {}
    if (s instanceof CompItem) { lo.src = s.id; var e1 = eps(L); if (e1) lo.eps = e1; }
    ls.push(lo);
  }
  o.layers = ls;
  try { o.folder = c.parentFolder ? c.parentFolder.name : ""; } catch (e) {}
  tree.push(o);
}
var names = [], ex = [];
for (var n1 = 1; n1 <= app.project.numItems; n1++) names.push(app.project.item(n1).name);
for (var k2 = 0; k2 < order.length; k2++) compExprs(order[k2], ex);
return { project: app.project.file ? app.project.file.fsName : null, root: R.id, tree: tree, comps: allComps(), itemNames: names, exprs: ex };`;

/** helpers of the two surgeries: setting expressions on locked layers, the result's fingerprint, created items */
const EDIT_JSX = `
function r4(n) { return aemcp.round(n); }
function byPath(L, path) { var p = L; for (var k = 0; k < path.length; k++) p = p.property(path[k]); return p; }
function unlocked(L, f) { var lk = L.locked; if (lk) L.locked = false; try { f(); } finally { if (lk) L.locked = true; } }
function setExpr(L, path, text) { unlocked(L, function () { byPath(L, path).expression = text; }); }
function itemIds() { var o = {}, P = app.project; for (var i = 1; i <= P.numItems; i++) o["i" + P.item(i).id] = true; return o; }
function createdSince(before) {
  var o = [], P = app.project;
  for (var i = 1; i <= P.numItems; i++) { var it = P.item(i); if (!before["i" + it.id]) o.push(it.id); }
  return o;
}
function fingerprint(c) {
  var o = [];
  for (var i = 1; i <= c.numLayers; i++) {
    var L = c.layer(i), s = 0, par = 0, tm = "", bl = "";
    try { if (!L.nullLayer && L.source) s = L.source.id; } catch (e) {}
    try { if (L.parent) par = L.parent.index; } catch (e) {}
    try { tm = String(L.trackMatteType); bl = String(L.blendingMode); } catch (e) {}
    o.push([L.name, L.enabled ? 1 : 0, r4(L.inPoint), r4(L.outPoint), r4(L.startTime), par, s, bl, tm].join("|"));
  }
  return o.join("\\n");
}
`;

/**
 * Un-precompose, from the plan: on a duplicate of P (rehearsal) or on P itself. Everything is checked against the
 * plan's facts before anything changes; any failure returns { rollback: true } (the call's undo group is undone).
 */
export const UNPRECOMPOSE_JSX = `${EDIT_JSX}
var before = itemIds(), P = app.project.itemByID(args.P), C = app.project.itemByID(args.C);
function stale(why) { return { rollback: true, error: "The project changed since the plan (" + why + "). Nothing was changed; plan again." }; }
if (!(P instanceof CompItem) || !(C instanceof CompItem)) return stale("a comp is gone");
if (P.numLayers !== args.pCount || C.numLayers !== args.cCount) return stale("the number of layers changed");
var L0 = P.layer(args.L), s0 = null;
try { s0 = L0.source; } catch (e) {}
if (L0.name !== args.Lname || !s0 || s0.id !== C.id) return stale("layer " + args.L + " is not the precomp layer any more");
for (var v = 0; v < args.edits.length; v++) {
  var ed = args.edits[v], cc = app.project.itemByID(ed.c);
  if (!cc || cc.numLayers < ed.l || byPath(cc.layer(ed.l), ed.p).expression !== ed.old) return stale("an expression changed");
}
try {
  var T = P, LT = L0;
  if (args.rehearsal) { T = P.duplicate(); T.name = P.name + " (Surehand rehearsal)"; LT = T.layer(args.L); }
  // 1. expressions on layers that stay where they are (in the rehearsal: only P's, on its scratch copy)
  for (var a = 0; a < args.edits.length; a++) {
    var e1 = args.edits[a];
    if (args.rehearsal && e1.c !== P.id) continue;
    var host = e1.c === P.id ? T : app.project.itemByID(e1.c);
    setExpr(host.layer(e1.l), e1.p, e1.text);
  }
  // 2. the null that carries L's transform, at L's index
  var N = null;
  if (args.nullLayer) {
    N = T.layers.addNull(T.duration);
    N.name = args.nullLayer.name;
    N.moveBefore(LT);
    N.startTime = LT.startTime;
    N.inPoint = LT.inPoint;
    N.outPoint = LT.outPoint;
    if (LT.parent) N.setParentWithJump(LT.parent);
    try { N.autoOrient = LT.autoOrient; } catch (e) {}
    try { N.label = LT.label; } catch (e) {}
    var sg = LT.property("ADBE Transform Group"), dg = N.property("ADBE Transform Group");
    var sep = sg.property("ADBE Position").dimensionsSeparated;
    if (sep) dg.property("ADBE Position").dimensionsSeparated = true;
    var names = ["ADBE Anchor Point", "ADBE Scale", "ADBE Rotate Z"].concat(sep ? ["ADBE Position_0", "ADBE Position_1"] : ["ADBE Position"]);
    for (var t = 0; t < names.length; t++) {
      var sp = sg.property(names[t]), dp = dg.property(names[t]);
      if (sp.numKeys) { for (var k = 1; k <= sp.numKeys; k++) aemcp.restoreKey(dp, aemcp.captureKey(sp, k)); }
      else dp.setValue(sp.value);
      if (sp.expression !== "") {
        var text = sp.expression;
        for (var ne = 0; ne < args.nullEdits.length; ne++) if (args.nullEdits[ne].m === names[t]) text = args.nullEdits[ne].text;
        dp.expression = text;
        dp.expressionEnabled = sp.expressionEnabled;
      }
    }
  }
  // 3. C's layers, copied into T in C's order at L's place
  var map = {}, locks = [], Ls = LT.startTime, Lin = LT.inPoint, Lout = LT.outPoint;
  for (var j = 1; j <= C.numLayers; j++) {
    C.layer(j).copyToComp(T);
    var X = T.layer(1);
    if (X.locked) { X.locked = false; locks.push(X); }
    X.moveBefore(LT);
    map["c" + j] = X;
  }
  for (var m = 0; m < args.moved.length; m++) {
    var mv = args.moved[m], Y = map["c" + mv.ci];
    if (Y.name !== mv.to) Y.name = mv.to;
    var want = mv.parent === "null" ? N : mv.parent ? map["c" + mv.parent] : null;
    if (want) Y.setParentWithJump(want);
    else if (Y.parent) { try { Y.setParentWithJump(null); } catch (e) { Y.parent = null; } }
    // exact values from After Effects (the plan's are rounded, for the report): shifted by L's start, cut to L's span
    if (Ls !== 0) Y.startTime = Y.startTime + Ls;
    var nin = Math.max(Y.inPoint, Lin), nout = Math.min(Y.outPoint, Lout);
    if (!(nin < nout)) Y.enabled = false;
    else { if (nin !== Y.inPoint) Y.inPoint = nin; if (nout !== Y.outPoint) Y.outPoint = nout; }
    if (mv.matte && Y.setTrackMatte) Y.setTrackMatte(map["c" + mv.matte.ci], TrackMatteType[mv.matte.type]);
  }
  for (var me = 0; me < args.movedEdits.length; me++) { var m1 = args.movedEdits[me]; byPath(map["c" + m1.ci], m1.p).expression = m1.text; }
  if (args.carry) {
    var Z = map["c" + args.carry.ci];
    if (args.carry.blend) Z.blendingMode = BlendingMode[args.carry.blend];
    if (args.carry.opacity !== undefined) Z.property("ADBE Transform Group").property("ADBE Opacity").setValue(args.carry.opacity);
  }
  // 4. L's children follow the null; L goes
  for (var i = 1; i <= T.numLayers; i++) { var ch = T.layer(i); if (ch !== LT && ch.parent && ch.parent.index === LT.index) unlocked(ch, function () { ch.setParentWithJump(N); }); }
  if (LT.locked) LT.locked = false;
  LT.remove();
  // 5. effect parameters that point at a layer: the moved layer's final index
  for (var lp = 0; lp < args.layerParams.length; lp++) { var q = args.layerParams[lp]; byPath(map["c" + q.ci], q.p).setValue(map["c" + q.toCi].index); }
  for (var u = 0; u < locks.length; u++) locks[u].locked = true;
  if (args.removeC && !args.rehearsal) C.remove();
  var fp = fingerprint(T);
  if (args.expect !== undefined && args.expect !== null && fp !== args.expect)
    return { rollback: true, error: "the result did not match the proven rehearsal layer for layer" };
  var out = [];
  for (var w = 0; w < args.moved.length; w++) { var M = map["c" + args.moved[w].ci]; out.push({ ci: args.moved[w].ci, name: M.name, index: M.index }); }
  return { T: T.id, created: createdSince(before), fingerprint: fp, moved: out, nullIndex: N ? N.index : 0 };
} catch (e) {
  return { rollback: true, error: e.message || String(e), line: e.line };
}`;

/** Deep duplicate, from the plan: each comp of the tree once, precomp layers pointed at the copies, expressions rewritten. */
export const DEEPDUP_JSX = `${EDIT_JSX}
var before = itemIds();
function stale(why) { return { rollback: true, error: "The project changed since the plan (" + why + "). Nothing was changed; plan again." }; }
for (var v = 0; v < args.copies.length; v++) { var c0 = app.project.itemByID(args.copies[v].id); if (!(c0 instanceof CompItem) || c0.name !== args.copies[v].from) return stale("a comp of the tree is gone or renamed"); }
for (var v2 = 0; v2 < args.edits.length; v2++) {
  var ed = args.edits[v2], cc = app.project.itemByID(ed.c);
  if (!cc || cc.numLayers < ed.l || byPath(cc.layer(ed.l), ed.p).expression !== ed.old) return stale("an expression changed");
}
try {
  var map = {}, made = [];
  for (var i = 0; i < args.copies.length; i++) {
    var src = app.project.itemByID(args.copies[i].id), d = src.duplicate();
    d.name = args.copies[i].to;
    map["i" + src.id] = d;
    made.push({ id: src.id, copy: d.id, name: d.name });
  }
  for (var k = 0; k < args.copies.length; k++) {
    var cp = args.copies[k], D = map["i" + cp.id];
    for (var s = 0; s < cp.swaps.length; s++) {
      var sw = cp.swaps[s], L = D.layer(sw.i);
      unlocked(L, function () { L.replaceSource(map["i" + sw.src], false); });
    }
  }
  for (var e = 0; e < args.edits.length; e++) { var x = args.edits[e]; setExpr(map["i" + x.c].layer(x.l), x.p, x.text); }
  if (args.folder) {
    var F = app.project.items.addFolder(args.folder);
    for (var f = 0; f < args.copies.length; f++) map["i" + args.copies[f].id].parentFolder = F;
  }
  var fp = [];
  for (var g = 0; g < args.copies.length; g++) {
    var Dc = map["i" + args.copies[g].id], rows = [Dc.name];
    for (var j = 1; j <= Dc.numLayers; j++) { var sid = 0; try { sid = Dc.layer(j).source ? Dc.layer(j).source.id : 0; } catch (e2) {} var back = 0; for (var h = 0; h < args.copies.length; h++) if (map["i" + args.copies[h].id].id === sid) back = "tree" + args.copies[h].id; rows.push(back || sid); }
    fp.push(rows.join("|"));
  }
  var fps = fp.join("\\n");
  if (args.expect !== undefined && args.expect !== null && fps !== args.expect) return { rollback: true, error: "the result did not match the proven rehearsal comp for comp" };
  return { root: map["i" + args.copies[0].id].id, made: made, created: createdSince(before), fingerprint: fps };
} catch (e) {
  return { rollback: true, error: e.message || String(e), line: e.line };
}`;

/** Remove the rehearsal's items by hand (comps first, then footage such as a null's solid, then empty folders). */
export const CLEANUP_JSX = `
var P = app.project, done = [], left = [];
for (var pass = 0; pass < 3; pass++) {
  for (var i = 0; i < args.ids.length; i++) {
    var it = P.itemByID(args.ids[i]);
    if (!it) continue;
    var isComp = it instanceof CompItem, isFolder = it instanceof FolderItem;
    if ((pass === 0 && !isComp) || (pass === 1 && (isComp || isFolder)) || (pass === 2 && !isFolder)) continue;
    if (isFolder && it.numItems > 0) { left.push(it.name); continue; }
    var nm = it.name;
    try { it.remove(); done.push(nm); } catch (e) { left.push(nm); }
  }
}
return { removed: done, left: left };`;

// ---------- the tool ----------

export interface SurgeryInput {
  action: "unprecompose" | "deep_duplicate";
  comp?: number | string;
  layer?: number | string;
  dryRun?: boolean;
  removeSource?: boolean;
  bakeNull?: boolean;
  suffix?: string;
  folder?: string;
  override?: Override[];
  frames?: number;
  times?: number[];
  tolerance?: number;
  maxSize?: number;
}

const q = (s: string) => `"${s}"`;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const parse = <T>(r: unknown): T => (typeof r === "string" ? JSON.parse(r) : r) as T;

function rewriteLines(list: Rewrite[], max = 40): string[] {
  const out = list.slice(0, max).map((r) => `  - ${r.where}${r.off ? " (switched off)" : ""}: ${r.snippet}`);
  if (list.length > max) out.push(`  - ... and ${list.length - max} more`);
  return out;
}

function problemLines(problems: Problem[], override: Override[]): string[] {
  return problems.map((p) => `  - ${p.text}${p.override ? ` [${override.includes(p.override) ? "overridden" : `override: "${p.override}"`}]` : ""}`);
}

/** The plan as text: what moves, what is renamed, every rewrite, every problem. */
export function describeUnprecompose(f: UFacts, p: UPlan, override: Override[] = []): string[] {
  const L: string[] = [];
  const lastMoved = p.moved.length ? Math.max(...p.moved.map((m) => m.index)) : 0;
  L.push(`Un-precompose ${q(f.L.n)} (layer ${f.L.i} in "${f.P.name}", source comp "${f.C.name}", ${plural(f.cLayers.length, "layer")}).`);
  if (p.nullLayer) L.push(`Null ${q(p.nullLayer.name)} at layer ${p.nullLayer.index} carries ${q(f.L.n)}'s anchor point, position, scale and rotation${f.L.tf.keyed || f.L.tf.expr ? " (keyframes and expressions included)" : ""}${f.L.par ? `, parented to layer ${f.L.par} like ${q(f.L.n)}` : ""}; the moved top-level layers are parented to it${f.L.children.length ? `, and so are ${q(f.L.n)}'s ${plural(f.L.children.length, "child")}` : ""}.`);
  if (p.nullNote) L.push(p.nullNote + ".");
  L.push(`Moved into "${f.P.name}" (layers ${p.moved.length ? `${Math.min(...p.moved.map((m) => m.index))}-${lastMoved}` : "none"}):`);
  for (const m of p.moved)
    L.push(`  - ${m.index}: ${q(m.from)}${m.to !== m.from ? ` renamed ${q(m.to)} (the name is taken in "${f.P.name}")` : ""}${m.timing ? `; ${m.timing}` : ""}`);
  if (p.carry) L.push(`${q(f.L.n)}'s ${[p.carry.blend ? `blend mode (${p.carry.blend.toLowerCase()})` : "", p.carry.opacity !== undefined ? `opacity (combined: ${p.carry.opacity}%)` : ""].filter(Boolean).join(" and ")} carried over to ${q(p.moved.find((m) => m.ci === p.carry!.ci)?.to ?? "")}, the precomp's only visible layer.`);
  if (p.shift) L.push(`"${f.P.name}"'s layers below ${q(f.L.n)} move ${p.shift > 0 ? "down" : "up"} by ${Math.abs(p.shift)}.`);
  if (p.layerParams.length) L.push(`Effect parameters pointing at a layer, re-pointed at the moved layers: ${p.layerParams.map((x) => `${q(p.moved.find((m) => m.ci === x.ci)!.to)} > ${x.pn}`).join(", ")}.`);
  const all = [...p.movedRewrites, ...p.nullRewrites, ...p.rewrites];
  L.push(all.length ? `Expressions rewritten (${all.length}):` : "Expressions rewritten: none needed.");
  if (p.movedRewrites.length) L.push(`  in the moved layers (copies; the originals in "${f.C.name}" are unchanged):`, ...rewriteLines(p.movedRewrites));
  if (p.nullRewrites.length) L.push(`  on ${q(f.L.n)}'s transform (copied to the null):`, ...rewriteLines(p.nullRewrites));
  if (p.rewrites.length) L.push("  elsewhere:", ...rewriteLines(p.rewrites));
  L.push(p.removeC ? `"${f.C.name}" will be removed (nothing else uses it).` : `"${f.C.name}" is kept${p.keepC ? ` (${p.keepC})` : ""}.`);
  if (p.problems.length) L.push(`Problems (${p.problems.length}):`, ...problemLines(p.problems, override));
  if (p.warnings.length) L.push(...p.warnings.map((w) => `Note: ${w}`));
  if (p.notes.length) L.push(...p.notes.map((n) => `Note: ${n}`));
  if (p.risks.length) L.push("Could make the proof differ:", ...p.risks.map((r) => `  - ${r}`));
  return L;
}

export function describeDeepDuplicate(f: DFacts, p: DPlan, override: Override[] = []): string[] {
  const L: string[] = [];
  const root = f.tree[0];
  L.push(`Deep duplicate "${root.name}": ${plural(p.copies.length, "comp")} copied, each once${p.folder ? `, into a new folder ${q(p.folder)}` : " (next to their originals)"}:`);
  for (const c of p.copies) L.push(`  - "${c.from}" → "${c.to}"${c.swaps.length ? `; ${plural(c.swaps.length, "precomp layer")} pointed at the copies (${c.swaps.map((s) => q(s.n)).join(", ")})` : ""}`);
  L.push(p.rewrites.length ? `Expressions rewritten in the copies (${p.rewrites.length}); references to comps outside the tree are kept:` : "Expressions rewritten: none needed (no expression in the tree names a comp of the tree).");
  L.push(...rewriteLines(p.rewrites));
  if (p.problems.length) L.push(`Problems (${p.problems.length}):`, ...problemLines(p.problems, override));
  if (p.warnings.length) L.push(...p.warnings.map((w) => `Note: ${w}`));
  if (p.notes.length) L.push(...p.notes.map((n) => `Note: ${n}`));
  if (p.risks.length) L.push("Could make the proof differ:", ...p.risks.map((r) => `  - ${r}`));
  return L;
}

/** Sample times for the un-precompose proof: the precomp layer's first and last frames and evenly between. */
export function unprecomposeTimes(f: UFacts, frames = 6): number[] {
  const fd = 1 / f.P.fps;
  const a = Math.max(0, f.L.in), b = Math.min(f.P.dur, f.L.out) - fd;
  if (!(b >= a)) return [a];
  const n = Math.max(1, Math.min(24, frames));
  return Array.from({ length: n }, (_, i) => (n === 1 ? a : a + ((b - a) * i) / (n - 1)));
}

const proven = (c: Comparison) => c.verdict === "identical" || c.verdict === "identical within tolerance";

/** What likely made the proof differ, from the plan's risks. */
function likelyCause(risks: string[]): string {
  if (!risks.length) return "Likely cause: nothing in the plan predicts a difference; look at the frames and the difference image (an expression reading the comp's name or index, an effect drawing outside a layer, or a render setting).";
  return `Likely cause${risks.length > 1 ? "s" : ""}, most likely first:\n${risks.map((r) => `  - ${r}`).join("\n")}`;
}

export async function runSurgery(a: SurgeryInput, perm: { mode: string; allowShell: boolean }): Promise<CallToolResult> {
  const override = a.override ?? [];
  const dup = a.action === "deep_duplicate";
  const read = await runJsx(dup ? DFACTS_JSX : UFACTS_JSX, { comp: a.comp, layer: a.layer }, { undoGroup: false, timeoutMs: 300_000, depth: 10 });
  if (!read.ok) return errorResult(read.error?.message ?? "After Effects could not read the project.");
  const uf = dup ? null : parse<UFacts>(read.result);
  const df = dup ? parse<DFacts>(read.result) : null;
  const plan: UPlan | DPlan = dup ? planDeepDuplicate(df!, { suffix: a.suffix, folder: a.folder, override }) : planUnprecompose(uf!, { removeSource: a.removeSource, bakeNull: a.bakeNull, override });
  const lines = dup ? describeDeepDuplicate(df!, plan as DPlan, override) : describeUnprecompose(uf!, plan as UPlan, override);
  const stop = blocking(plan, override);
  const what = dup ? "deep duplicate" : "un-precompose";
  if (a.dryRun) {
    const head = stop.length
      ? `PLAN (nothing was changed): the ${what} would be REFUSED: ${plural(stop.length, "problem")} below.`
      : `PLAN (nothing was changed): the ${what} can be done${plan.risks.length ? "; the proof will decide on the risks listed" : ""}.`;
    return { content: [{ type: "text", text: [head, ...lines].join("\n") }] };
  }
  if (stop.length)
    return { isError: true, content: [{ type: "text", text: [`REFUSED: the ${what} can't be done exactly, so nothing was changed. ${plural(stop.length, "problem")}:`, ...problemLines(stop, override), "", "The full plan:", ...lines].join("\n") }] };
  if (perm.mode === "read-only") return errorResult(READ_ONLY_REFUSAL);
  const project = dup ? df!.project : uf!.project;
  if (!project) return errorResult(`Save the project first: the ${what} saves a checkpoint before it changes anything. Nothing was changed.`);
  const out: string[] = [];
  const t0 = Date.now();
  let cp: string;
  try {
    const c = await saveCheckpoint(dup ? "before-deep-duplicate" : "before-unprecompose");
    cp = c.file;
  } catch (e: any) {
    return errorResult(`The checkpoint could not be saved, so nothing was changed: ${e?.message ?? e}`);
  }
  // the reference frames
  const target = dup ? df!.root : uf!.P.id;
  const times = a.times ?? (dup ? undefined : unprecomposeTimes(uf!, a.frames));
  const ref = await captureProof({ comps: [target], times, frames: dup ? a.frames : undefined, maxSize: a.maxSize });
  // the arguments of the surgery (the rehearsal's texts for the rehearsal)
  const jsxArgs = (rehearsal: boolean, expect?: string) => {
    if (dup) {
      const d = plan as DPlan;
      return { rehearsal, expect, copies: d.copies, folder: d.folder ?? null, edits: d.rewrites.map((r) => ({ c: r.c, l: r.l, p: r.p, old: r.old, text: r.new })) };
    }
    const u = plan as UPlan, f = uf!;
    const pick = (r: Rewrite) => (rehearsal ? r.rehearse : r.new);
    return {
      rehearsal, expect, P: f.P.id, C: f.C.id, L: f.L.i, Lname: f.L.n, pCount: f.pLayers.length, cCount: f.cLayers.length,
      edits: u.rewrites.filter((r) => pick(r) !== null && pick(r) !== r.old).map((r) => ({ c: r.c, l: r.l, p: r.p, old: r.old, text: pick(r) })),
      nullLayer: u.nullLayer,
      nullEdits: u.nullRewrites.map((r) => ({ m: r.p.length ? f.exprs.find((e) => e.c === r.c && e.l === r.l && e.p.join() === r.p.join())?.mp[1] : "", text: pick(r) ?? r.old })),
      moved: u.moved.map((m) => ({ ci: m.ci, to: m.to, parent: m.parent ?? 0, matte: m.matte ?? null })),
      movedEdits: u.movedRewrites.map((r) => ({ ci: r.l, p: r.p, text: pick(r) ?? r.old })),
      layerParams: u.layerParams,
      carry: u.carry ?? null,
      removeC: u.removeC,
    };
  };
  const approval =
    perm.mode === "ask"
      ? {
          approval: {
            tool: dup ? "Deep duplicate" : "Un-precompose",
            summary: `${lines[0]}\nRehearsed on a scratch copy and proven first; applied in one undo step only if the picture is identical.\n${approvalSummary("ae_precomp_surgery", a as unknown as Record<string, unknown>)}`,
          },
        }
      : undefined;
  // the rehearsal
  const reh = await runJsx(dup ? DEEPDUP_JSX : UNPRECOMPOSE_JSX, jsxArgs(true), { undoGroup: "Surehand MCP precomp surgery rehearsal", timeoutMs: 600_000, rollback: "requested", depth: 6, bridge: approval });
  if (!reh.ok) return errorResult(`${reh.error?.message ?? "The rehearsal failed"}\nNothing was changed (checkpoint ${cp}).`);
  const rr = parse<{ rollback?: true; error?: string; T?: number; root?: number; created: number[]; fingerprint: string }>(reh.result);
  if (rr.rollback) {
    const rb = reh.rollback;
    return errorResult(`The rehearsal on a scratch copy stopped: ${String(rr.error).replace(/\.$/, "")}. ${rb?.verified ? "It was undone: nothing changed." : rollbackProblem(rb ?? { undone: false, verified: false, problem: "no result" }, "the rehearsal")}\nCheckpoint: ${cp}`);
  }
  const scratch = dup ? rr.root! : rr.T!;
  let cmp: Comparison | string;
  try {
    cmp = await compareProof({ id: ref.id, tolerance: a.tolerance, against: { [target]: scratch } });
  } catch (e: any) {
    cmp = `the comparison failed: ${e?.message ?? e}`;
  } finally {
    // the scratch goes in every case, by hand (never Edit > Undo: the proof's renders are on the undo stack)
  }
  const clean = await runJsx(CLEANUP_JSX, { ids: rr.created }, { undoGroup: "Surehand MCP precomp surgery rehearsal", timeoutMs: 120_000 });
  const cleaned = clean.ok ? parse<{ removed: string[]; left: string[] }>(clean.result) : { removed: [], left: ["(the cleanup failed: " + (clean.error?.message ?? "") + ")"] };
  const leftNote = cleaned.left.length ? `\nThe rehearsal's scratch items could not all be removed: ${cleaned.left.join(", ")}. They can be deleted.` : "";
  const proofMs = Date.now() - t0;
  if (typeof cmp === "string" || !proven(cmp)) {
    const verdict = typeof cmp === "string" ? `NOT PROVEN: ${cmp}` : cmp.text;
    const differs = typeof cmp !== "string" && cmp.verdict === "differs";
    out.push(
      `${differs ? "DIFFERS" : "NOT PROVEN"}: the ${what} was NOT applied. It was rehearsed on a scratch copy, the copy did not render identical to the original, and the copy was removed: the project is as it was (checkpoint ${cp}).`,
      "",
      verdict,
      "",
      differs ? likelyCause(plan.risks) : "",
      "",
      "The plan that was rehearsed:",
      ...lines,
    );
    const content: CallToolResult["content"] = [{ type: "text", text: out.filter((x, i, arr) => !(x === "" && arr[i - 1] === "")).join("\n") + leftNote }];
    if (typeof cmp !== "string" && cmp.image) content.push({ type: "image", data: cmp.image.data, mimeType: "image/png" }, { type: "text", text: cmp.image.label });
    return { isError: true, content };
  }
  // proven: the same surgery on the project, one undo step, checked against the rehearsal
  const real = await runJsx(dup ? DEEPDUP_JSX : UNPRECOMPOSE_JSX, jsxArgs(false, rr.fingerprint), {
    undoGroup: dup ? "Surehand MCP deep duplicate" : "Surehand MCP un-precompose",
    timeoutMs: 600_000,
    rollback: "requested",
    depth: 6,
    report: reportScope({ comp: dup ? undefined : uf!.P.id }),
  });
  if (!real.ok) return errorResult(`The rehearsal was proven identical, but applying it failed: ${real.error?.message}\nCheckpoint: ${cp}${leftNote}`);
  const rs = parse<{ rollback?: true; error?: string; root?: number; made?: { id: number; copy: number; name: string }[]; moved?: { ci: number; name: string; index: number }[]; nullIndex?: number }>(real.result);
  if (rs.rollback) {
    const rb = real.rollback;
    return errorResult(`The rehearsal was proven identical, but applying it stopped: ${String(rs.error).replace(/\.$/, "")}. ${rb?.verified ? (rb.undone ? "It was undone: nothing changed." : "Nothing had changed yet.") : rollbackProblem(rb ?? { undone: false, verified: false, problem: "no result" }, `the ${what}`)}\nCheckpoint: ${cp}${leftNote}`);
  }
  const frames = cmp.view?.frames.filter((x) => !x.missing).length ?? 0;
  const head = cmp.text.split("\n")[0].replace(/^Verdict: /, "").replace(/\.$/, "");
  out.push(
    `DONE and proven: ${head} (${plural(frames, "frame")} compared, ${sec(proofMs)} including the rehearsal).`,
    `Checkpoint saved first: ${cp}`,
    dup ? `New root comp: "${(plan as DPlan).copies[0].to}" (id ${rs.root}).` : "",
    ...lines,
    "",
    "Proof (the rehearsal on a scratch copy against the original, then the same surgery applied and checked layer for layer against the rehearsal):",
    ...cmp.text.split("\n").slice(1),
    "",
    `One undo step ("${dup ? "Surehand MCP deep duplicate" : "Surehand MCP un-precompose"}"); ae_undo reverts it.${dup ? "" : " Expression rewrites in other comps are exact text edits, listed above; the pixel proof covers the parent comp."}`,
  );
  const changes = formatChanges(real.changes);
  return { content: [{ type: "text", text: out.filter((x) => x !== "").join("\n") + leftNote + (changes ? `\n\n${changes}` : "") }] };
}

export function registerSurgeryTools(server: McpServer) {
  server.registerTool(
    "ae_precomp_surgery",
    {
      title: "Precomp surgery, proven",
      description:
        "Restructure precomps without changing the picture, with every expression reference rewritten exactly and pixel proof. unprecompose: " +
        "bring a precomp layer's layers into its comp at its place (a null carries its transform; times shifted and trimmed; name clashes " +
        "renamed; thisComp / layer index references rewritten). deep_duplicate: copy a comp and every nested precomp (each once) as an " +
        "unlinked tree; comp(\"X\") references inside it point at the copies. Refuses, with the exact reason, what can't be done exactly " +
        "(effects, masks or time remap on the precomp layer, blend modes that would blend with other layers, computed references...). dryRun: " +
        "the plan only. Otherwise: checkpoint, rehearsal on a scratch copy, ae_prove_identical comparison, and only if IDENTICAL the same " +
        "change in one undo step; DIFFERS: nothing is applied, with the frames that differ and the likely cause.",
      inputSchema: {
        action: z.enum(["unprecompose", "deep_duplicate"]),
        comp: compRef.describe("unprecompose: the comp that holds the precomp layer; deep_duplicate: the comp to copy with its tree. Default: the active comp."),
        layer: layerRef.optional().describe("unprecompose: the precomp layer (index or name; default the selected layer)."),
        dryRun: z.boolean().optional().describe("Only plan: what would move, be renamed and rewritten, and every blocker. Nothing is changed."),
        removeSource: z.boolean().optional().describe("unprecompose: also remove the source comp, only if nothing else uses it (refused otherwise). Default: keep it."),
        bakeNull: z.boolean().optional().describe("unprecompose: leave out the null when the precomp layer's transform is the identity (exact); otherwise a null is kept and the result says why."),
        suffix: z.string().min(1).max(60).optional().describe('deep_duplicate: added to each copy\'s name (default " copy"; a number is added when the name is taken).'),
        folder: z.string().min(1).max(200).optional().describe("deep_duplicate: put the copies in a new folder with this name (default: next to their originals)."),
        override: z
          .array(z.enum(["expressions", "bounds"]))
          .optional()
          .describe("Go ahead despite these problems (they are still reported, left as they are, and the pixel proof decides): expressions = references that can't be rewritten safely; bounds = layers that reach outside the precomp's frame."),
        frames: z.number().int().min(1).max(24).optional().describe("Frames to prove (default: unprecompose 6 over the precomp layer's time span, first and last frame included; deep_duplicate 5 over the work area)."),
        times: z.array(z.number()).min(1).max(24).optional().describe("Exact times (seconds) to prove instead."),
        tolerance: z.number().min(0).max(255).optional().describe(`Allowed difference per channel, 0-255 (default ${DEFAULT_TOLERANCE}, as ae_prove_identical; 0 = bit-identical).`),
        maxSize: z.number().int().min(64).max(4096).optional().describe("Longest rendered side for the proof (default 1920)."),
      },
      // edits in one undo step (rehearsal on a scratch copy first; the project is saved for a checkpoint)
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input: SurgeryInput) => {
      try {
        return await runSurgery(input, permissions());
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
