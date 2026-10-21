// ae_precomp_surgery: un-precompose a precomp layer, or deep-duplicate a comp with all its nested precomps unlinked,
// with every expression reference rewritten exactly (src/surgery/expr.ts, plan.ts), a refusal with the exact reason for
// what can't be done exactly, and pixel proof that the picture is unchanged (ae_prove_identical's engine).
// How it stays safe: read the facts (no undo step), plan in TypeScript, save a checkpoint, capture reference frames,
// REHEARSE the surgery on a scratch copy (un-precompose: a duplicate of the parent comp; deep duplicate: the copies
// themselves), compare the scratch with the reference, remove the scratch by hand, and only when the proof says
// IDENTICAL apply the same surgery to the project in one undo group. Its result must match the rehearsal's
// (layer by layer), otherwise it is undone at once. DIFFERS: the project was never changed. After Effects can split a
// call's undo group (seen live in AE 26.5: an ae_undo after an un-precompose took back only the precomp layer's removal;
// after a deep duplicate, single source replacements), so no single-undo promise is made: the way back is the checkpoint
// (un-precompose) or remove_copies (deep duplicate).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { appFile } from "../paths.js";
import { formatChanges, rollbackProblem, runJsx } from "../jsx.js";
import { approvalSummary, permissions, READ_ONLY_REFUSAL } from "../permissions.js";
import { blocking, planDeepDuplicate, planUnprecompose, type DFacts, type DPlan, type Override, type Problem, type Rewrite, type UFacts, type UPlan } from "../surgery/plan.js";
import { captureProof, compareProof, DEFAULT_TOLERANCE, type Comparison } from "./prove.js";
import { compRef, errorResult, layerRef, reportScope } from "./registry.js";
import { saveCheckpoint } from "./workflow.js";

// ---------- ExtendScript ----------

/** 2D layer-to-comp matrices [a, b, c, d, e, f] (x' = a x + c y + e, y' = b x + d y + f), through parents, from values */
const MATH_JSX = `
function val(p, t) { return p.valueAtTime(t, false); }
function local(x, t) {
  var g = x.property("ADBE Transform Group"), a = val(g.property("ADBE Anchor Point"), t), s = val(g.property("ADBE Scale"), t), r = val(g.property("ADBE Rotate Z"), t) * Math.PI / 180, pp = g.property("ADBE Position"), p;
  p = pp.dimensionsSeparated ? [val(g.property("ADBE Position_0"), t), val(g.property("ADBE Position_1"), t)] : val(pp, t);
  var cs = Math.cos(r), sn = Math.sin(r), m0 = cs * s[0] / 100, m1 = sn * s[0] / 100, m2 = -sn * s[1] / 100, m3 = cs * s[1] / 100;
  return [m0, m1, m2, m3, p[0] - (m0 * a[0] + m2 * a[1]), p[1] - (m1 * a[0] + m3 * a[1])];
}
function mul(A, B) { return [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]]; }
function world(x, t, d) { var m = local(x, t), p = null; try { p = x.parent; } catch (e) {} return p && d < 50 ? mul(world(p, t, d + 1), m) : m; }
`;

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
function allIds() { var o = []; for (var i = 1; i <= app.project.numItems; i++) o.push(app.project.item(i).id); return o; }
function allComps() { var o = [], P = app.project; for (var i = 1; i <= P.numItems; i++) { var it = P.item(i); if (it instanceof CompItem) o.push({ id: it.id, name: it.name }); } return o; }
function byPath(L, path) { var p = L; for (var k = 0; k < path.length; k++) p = p.property(path[k]); return p; }
function eps(L) { try { var g = L.property("ADBE Layer Overrides"); return g ? g.numProperties : 0; } catch (e) { return 0; } }
`;

/** Un-precompose facts: the parent comp P, the precomp layer L, its source C, and every expression in the project. */
export const UFACTS_JSX = `${COMMON_JSX}${MATH_JSX}
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
return { ids: allIds(), project: app.project.file ? app.project.file.fsName : null, P: compF(P), C: compF(C), L: Lf, pLayers: pl, cLayers: cl, comps: allComps(), rq: rq, exprs: ex, bounds: bounds, rotated: rotated };`;

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
return { ids: allIds(), project: app.project.file ? app.project.file.fsName : null, root: R.id, tree: tree, comps: allComps(), itemNames: names, exprs: ex };`;

/** helpers of the two surgeries: setting expressions on locked layers, the result's fingerprint, created items */
const EDIT_JSX = `${MATH_JSX}
function r4(n) { return aemcp.round(n); }
function byPath(L, path) { var p = L; for (var k = 0; k < path.length; k++) p = p.property(path[k]); return p; }
function unlocked(L, f) { var lk = L.locked; if (lk) L.locked = false; try { f(); } finally { if (lk) L.locked = true; } }
function setExpr(L, path, text) { unlocked(L, function () { byPath(L, path).expression = text; }); }
// itemByID throws ("internal verification failure {Item Not Found}") for an id that is gone: look it up by hand
function byId(id) { var P = app.project; for (var i = 1; i <= P.numItems; i++) if (P.item(i).id === id) return P.item(i); return null; }
function itemIds() { var o = {}, P = app.project; for (var i = 1; i <= P.numItems; i++) o["i" + P.item(i).id] = true; return o; }
function createdSince(before) {
  var o = [], P = app.project;
  for (var i = 1; i <= P.numItems; i++) { var it = P.item(i); if (!before["i" + it.id]) o.push(it.id); }
  return o;
}
function en0(v) { try { return v === AutoOrientType.NO_AUTO_ORIENT; } catch (e) { return true; } }
function mats(m) { var o = []; for (var i = 0; i < 6; i++) o.push(r4(m[i])); return "[" + o.join(", ") + "]"; }
function vstr(v) { if (v instanceof Array) { var o = []; for (var i = 0; i < v.length; i++) o.push(r4(v[i])); return "[" + o.join(", ") + "]"; } return String(r4(v)); }
// a layer's parent and local transform values, for a failed check
function diag(what, x, t) {
  var g = x.property("ADBE Transform Group"), pp = g.property("ADBE Position"), par = null;
  try { par = x.parent; } catch (e) {}
  return what + " " + JSON.stringify(x.name) + " (layer " + x.index + ", parent " + (par ? JSON.stringify(par.name) : "none") + "): anchor " + vstr(val(g.property("ADBE Anchor Point"), t)) +
    ", position " + (pp.dimensionsSeparated ? vstr([val(g.property("ADBE Position_0"), t), val(g.property("ADBE Position_1"), t)]) : vstr(val(pp, t))) +
    ", scale " + vstr(val(g.property("ADBE Scale"), t)) + ", rotation " + vstr(val(g.property("ADBE Rotate Z"), t));
}
function walkProps(g, ip, f) {
  for (var k = 1; k <= g.numProperties; k++) {
    var p = null;
    try { p = g.property(k); } catch (e) {}
    if (!p) continue;
    if (p.propertyType === PropertyType.PROPERTY) f(p, ip.concat([k])); else walkProps(p, ip.concat([k]), f);
  }
}
function layerIds(c) { var o = {}; for (var i = 1; i <= c.numLayers; i++) { var id = c.layer(i).id; if (id === undefined) return null; o["l" + id] = true; } return o; }
function newLayer(c, had) {
  if (!had) return c.layer(1); // no Layer.id (before AE 22): After Effects puts the copy at the top
  for (var i = 1; i <= c.numLayers; i++) if (!had["l" + c.layer(i).id]) return c.layer(i);
  return null;
}
// what links a layer to others: parent, track matte layer, expressions, layer parameters (Layer Control...)
function detach(L) {
  var d = { lk: L.locked, parent: null, matte: null, mtype: null, exprs: [], lidx: [] };
  if (d.lk) L.locked = false;
  try { if (L.parent) { d.parent = L.parent; L.setParentWithJump(null); } } catch (e) { d.parent = L.parent; L.parent = null; }
  try { if (L.trackMatteLayer && L.setTrackMatte) { d.matte = L.trackMatteLayer; d.mtype = L.trackMatteType; if (L.removeTrackMatte) L.removeTrackMatte(); else L.setTrackMatte(null, TrackMatteType.NO_TRACK_MATTE); } } catch (e) {}
  walkProps(L, [], function (p, ip) {
    var x = "";
    try { x = p.canSetExpression ? p.expression : ""; } catch (e) {}
    if (x) { d.exprs.push({ p: ip, x: x, on: !!p.expressionEnabled }); p.expression = ""; }
    try { if (p.propertyValueType === PropertyValueType.LAYER_INDEX && p.numKeys === 0 && p.value) { d.lidx.push({ p: ip, v: p.value }); p.setValue(0); } } catch (e) {}
  });
  return d;
}
function reattach(L, d) {
  if (d.parent) L.setParentWithJump(d.parent);
  if (d.matte) L.setTrackMatte(d.matte, d.mtype);
  for (var i = 0; i < d.exprs.length; i++) { var p = byPath(L, d.exprs[i].p); p.expression = d.exprs[i].x; p.expressionEnabled = d.exprs[i].on; }
  for (var k = 0; k < d.lidx.length; k++) byPath(L, d.lidx[k].p).setValue(d.lidx[k].v);
  if (d.lk) L.locked = true;
}
// the links of every layer of a comp, as text: compared before and after the copies
function linkState(c) {
  var o = [];
  for (var i = 1; i <= c.numLayers; i++) {
    var L = c.layer(i), row = [L.name, L.locked ? 1 : 0, L.parent ? L.parent.index : 0];
    try { row.push(L.trackMatteLayer ? L.trackMatteLayer.index : 0, L.trackMatteType); } catch (e) {}
    walkProps(L, [], function (p, ip) {
      try { if (p.canSetExpression && p.expression !== "") row.push(ip.join(".") + "=" + p.expression + (p.expressionEnabled ? "" : " (off)")); } catch (e) {}
      try { if (p.propertyValueType === PropertyValueType.LAYER_INDEX) row.push(ip.join(".") + "#" + p.value); } catch (e) {}
      try { if (p.propertyType === PropertyType.PROPERTY && p.matchName.indexOf("ADBE Transform Group") < 0 && p.parentProperty && p.parentProperty.matchName === "ADBE Transform Group") row.push(ip.join(".") + ":" + String(p.value)); } catch (e) {}
    });
    o.push(row.join("|"));
  }
  return o.join("\\n");
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
var before = itemIds(), P = byId(args.P), C = byId(args.C);
function stale(why) { return { rollback: true, error: "The project changed since the plan (" + why + "). Nothing was changed; plan again." }; }
if (!(P instanceof CompItem) || !(C instanceof CompItem)) return stale("a comp is gone");
if (P.numLayers !== args.pCount || C.numLayers !== args.cCount) return stale("the number of layers changed");
var L0 = P.layer(args.L), s0 = null;
try { s0 = L0.source; } catch (e) {}
if (L0.name !== args.Lname || !s0 || s0.id !== C.id) return stale("layer " + args.L + " is not the precomp layer any more");
for (var v = 0; v < args.edits.length; v++) {
  var ed = args.edits[v], cc = byId(ed.c);
  if (!cc || cc.numLayers < ed.l || byPath(cc.layer(ed.l), ed.p).expression !== ed.old) return stale("an expression changed");
}
try {
  var T = P, LT = L0;
  if (args.rehearsal) { T = P.duplicate(); T.name = P.name + " (Surehand rehearsal)"; LT = T.layer(args.L); }
  // 1. expressions on layers that stay where they are (in the rehearsal: only P's, on its scratch copy)
  for (var a = 0; a < args.edits.length; a++) {
    var e1 = args.edits[a];
    if (args.rehearsal && e1.c !== P.id) continue;
    var host = e1.c === P.id ? T : byId(e1.c);
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
  // 3. C's layers, copied into T at L's place. While an undo group is open, After Effects refuses to copy a layer
  // with a parent or a linked expression ("Can't copy a layer with a parent or with a linked expression, while an Undo
  // Group is open"): each source layer is detached first (parent with jump, track matte layer, expressions, layer
  // parameters), copied, and put back exactly; the copy gets them from the stash. The source is read back afterwards.
  var map = {}, locks = [], stash = {}, Ls = LT.startTime, Lin = LT.inPoint, Lout = LT.outPoint, srcBefore = linkState(C);
  for (var j = 1; j <= C.numLayers; j++) stash["c" + j] = detach(C.layer(j));
  try {
    for (var j2 = 1; j2 <= C.numLayers; j2++) {
      var had = layerIds(T);
      C.layer(j2).copyToComp(T);
      // the copy: the layer that wasn't there before (not "index 1": where it lands is not ours to assume)
      var X = newLayer(T, had);
      if (!X) throw new Error("After Effects did not add the copy of layer " + j2 + " to the comp");
      // the source was unlocked to detach it: the copy is locked again at the end like its original
      if (X.locked) X.locked = false;
      if (stash["c" + j2].lk) locks.push(X);
      map["c" + j2] = X;
    }
  } finally {
    for (var j3 = 1; j3 <= C.numLayers; j3++) reattach(C.layer(j3), stash["c" + j3], null, null);
  }
  if (linkState(C) !== srcBefore) throw new Error('the source comp "' + C.name + '" could not be put back exactly after copying its layers');
  // C's order, right above L, the null on top
  for (var o1 = 1; o1 <= C.numLayers; o1++) map["c" + o1].moveBefore(LT);
  if (N && C.numLayers) N.moveBefore(map["c1"]);
  // parents first, as the diagnostic does (proven live): from the source itself, not from the plan's arguments. The
  // original's parent inside C becomes its copy; a top-level layer goes on the null. Read back at once.
  var planned = {};
  for (var m0 = 0; m0 < args.moved.length; m0++) planned["c" + args.moved[m0].ci] = args.moved[m0].par;
  for (var p1 = 1; p1 <= C.numLayers; p1++) {
    var Yp = map["c" + p1], sp1 = C.layer(p1).parent, want = sp1 ? map["c" + sp1.index] : N;
    if (want) Yp.setParentWithJump(want);
    else if (Yp.parent) { try { Yp.setParentWithJump(null); } catch (e) { Yp.parent = null; } }
    var gotP = Yp.parent;
    if (want ? !gotP || gotP.index !== want.index : !!gotP)
      throw new Error("parenting " + JSON.stringify(Yp.name) + " failed: wanted " + (want ? JSON.stringify(want.name) + " (layer " + want.index + ")" : "none") + ", got " + (gotP ? JSON.stringify(gotP.name) + " (layer " + gotP.index + ")" : "none") + " (planned: " + JSON.stringify(planned["c" + p1]) + ")");
  }
  for (var m = 0; m < args.moved.length; m++) {
    var mv = args.moved[m], Y = map["c" + mv.ci];
    if (Y.name !== mv.to) Y.name = mv.to;
    // exact values from After Effects (the plan's are rounded, for the report): shifted by L's start, cut to L's span
    if (Ls !== 0) Y.startTime = Y.startTime + Ls;
    var nin = Math.max(Y.inPoint, Lin), nout = Math.min(Y.outPoint, Lout);
    if (!(nin < nout)) Y.enabled = false;
    else { if (nin !== Y.inPoint) Y.inPoint = nin; if (nout !== Y.outPoint) Y.outPoint = nout; }
    if (mv.matte && Y.setTrackMatte) Y.setTrackMatte(map["c" + mv.matte.ci], TrackMatteType[mv.matte.type]);
  }
  // the copies' expressions: the stashed ones, rewritten where the plan says
  var rewrite = {};
  for (var me = 0; me < args.movedEdits.length; me++) { var m1 = args.movedEdits[me]; rewrite[m1.ci + ":" + m1.p.join(",")] = m1.text; }
  for (var c2 = 1; c2 <= C.numLayers; c2++) {
    var ex = stash["c" + c2].exprs, Xc = map["c" + c2];
    for (var x1 = 0; x1 < ex.length; x1++) {
      var key = c2 + ":" + ex[x1].p.join(","), pr = byPath(Xc, ex[x1].p);
      pr.expression = rewrite[key] !== undefined ? rewrite[key] : ex[x1].x;
      pr.expressionEnabled = ex[x1].on;
    }
  }
  if (args.carry) {
    var Z = map["c" + args.carry.ci];
    if (args.carry.blend) Z.blendingMode = BlendingMode[args.carry.blend];
    if (args.carry.opacity !== undefined) Z.property("ADBE Transform Group").property("ADBE Opacity").setValue(args.carry.opacity);
  }
  // check the placement by the numbers before L goes: every moved layer must sit in P exactly where the precomp layer
  // showed it (L's matrix in P applied to the original's matrix in C), at the start, middle and end of L's span
  if (en0(LT.autoOrient)) {
    var tt = [Lin, (Lin + Lout) / 2, Math.max(Lin, Lout - T.frameDuration)];
    for (var c3 = 1; c3 <= C.numLayers; c3++) {
      for (var t3 = 0; t3 < tt.length; t3++) {
        var want3 = mul(world(LT, tt[t3], 0), world(C.layer(c3), tt[t3] - Ls, 0)), got3 = world(map["c" + c3], tt[t3], 0), off3 = 0;
        for (var q3 = 0; q3 < 6; q3++) off3 = Math.max(off3, Math.abs(want3[q3] - got3[q3]) * (q3 < 4 ? 1000 : 1));
        if (off3 > 0.01) {
          var Mv = map["c" + c3];
          throw new Error("placement check failed for " + JSON.stringify(Mv.name) + " at " + r4(tt[t3]) + "s (planned parent: " + planned["c" + c3] + ", actual: " + (Mv.parent ? JSON.stringify(Mv.parent.name) : "none") + "): expected matrix " + mats(want3) + ", got " + mats(got3) +
            "; " + diag("the layer", Mv, tt[t3]) + "; " + diag("its original in " + C.name, C.layer(c3), tt[t3] - Ls) + "; " + (N ? diag("the null", N, tt[t3]) + "; " : "") + diag("the precomp layer", LT, tt[t3]));
        }
      }
    }
  }
  // 4. L's children follow the null; L goes
  for (var i = 1; i <= T.numLayers; i++) { var ch = T.layer(i); if (i !== LT.index && ch.parent && ch.parent.index === LT.index) unlocked(ch, function () { ch.setParentWithJump(N); }); }
  if (LT.locked) LT.locked = false;
  LT.remove();
  // 5. effect parameters that point at a layer: the moved layer's final index
  for (var lp = 0; lp < args.layerParams.length; lp++) { var q = args.layerParams[lp]; byPath(map["c" + q.ci], q.p).setValue(map["c" + q.toCi].index); }
  for (var u = 0; u < locks.length; u++) locks[u].locked = true;
  // read the order back: the null, then C's layers in C's order, consecutive
  var first = C.numLayers ? map["c1"].index : 0;
  for (var v1 = 1; v1 <= C.numLayers; v1++) if (map["c" + v1].index !== first + v1 - 1) throw new Error("the moved layers did not end up in the precomp's order (layer " + v1 + " is at " + map["c" + v1].index + ")");
  if (N && C.numLayers && N.index !== first - 1) throw new Error("the null did not end up right above the moved layers");
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
for (var v = 0; v < args.copies.length; v++) { var c0 = byId(args.copies[v].id); if (!(c0 instanceof CompItem) || c0.name !== args.copies[v].from) return stale("a comp of the tree is gone or renamed"); }
for (var v2 = 0; v2 < args.edits.length; v2++) {
  var ed = args.edits[v2], cc = byId(ed.c);
  if (!cc || cc.numLayers < ed.l || byPath(cc.layer(ed.l), ed.p).expression !== ed.old) return stale("an expression changed");
}
try {
  var map = {}, made = [];
  for (var i = 0; i < args.copies.length; i++) {
    var src = byId(args.copies[i].id), d = src.duplicate();
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

/**
 * Remove by hand what the rehearsal (or a stopped surgery) left: every item that wasn't in the project before (`before`:
 * item ids), comps first, then footage nothing uses (a null's solid stays in the project when its comp is removed), then
 * empty folders. Items are looked up by hand each time (itemByID throws for an id that is gone).
 */
export const CLEANUP_JSX = `
var P = app.project, keep = {}, done = [], left = [];
for (var k = 0; k < args.before.length; k++) keep["i" + args.before[k]] = true;
function fresh(test) { var o = []; for (var i = 1; i <= P.numItems; i++) { var it = P.item(i); if (!keep["i" + it.id] && test(it)) o.push(it); } return o; }
function drop(it) { var nm = ""; try { nm = it.name; it.remove(); done.push(nm); } catch (e) { left.push(nm || "item"); } }
var cs = fresh(function (it) { return it instanceof CompItem; });
for (var a = 0; a < cs.length; a++) drop(cs[a]);
var fs = fresh(function (it) { return it instanceof FootageItem; });
for (var b = 0; b < fs.length; b++) { var used = 0; try { used = fs[b].usedIn.length; } catch (e) {} if (used) left.push(fs[b].name + " (in use)"); else drop(fs[b]); }
var ds = fresh(function (it) { return it instanceof FolderItem; });
for (var c = ds.length - 1; c >= 0; c--) { if (ds[c].numItems > 0) left.push(ds[c].name + " (not empty)"); else drop(ds[c]); }
return { removed: done, left: left };`;

// ---------- the tool ----------

export interface SurgeryInput {
  action: "unprecompose" | "deep_duplicate" | "remove_copies";
  /** remove_copies: the copy set id from the deep duplicate's result (default: the latest in this project) */
  id?: string;
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
export function describeUnprecompose(f: UFacts, p: UPlan, override: Override[] = [], risks = true): string[] {
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
  if (risks && p.risks.length) L.push("Could make the proof differ:", ...p.risks.map((r) => `  - ${r}`));
  return L;
}

export function describeDeepDuplicate(f: DFacts, p: DPlan, override: Override[] = [], risks = true): string[] {
  const L: string[] = [];
  const root = f.tree[0];
  L.push(`Deep duplicate "${root.name}": ${plural(p.copies.length, "comp")} copied, each once (next to their originals):`);
  for (const c of p.copies) L.push(`  - "${c.from}" → "${c.to}"${c.swaps.length ? `; ${plural(c.swaps.length, "precomp layer")} pointed at the copies (${c.swaps.map((s) => q(s.n)).join(", ")})` : ""}`);
  L.push(p.rewrites.length ? `Expressions rewritten in the copies (${p.rewrites.length}); references to comps outside the tree are kept:` : "Expressions rewritten: none needed (no expression in the tree names a comp of the tree).");
  L.push(...rewriteLines(p.rewrites));
  if (p.problems.length) L.push(`Problems (${p.problems.length}):`, ...problemLines(p.problems, override));
  if (p.warnings.length) L.push(...p.warnings.map((w) => `Note: ${w}`));
  if (p.notes.length) L.push(...p.notes.map((n) => `Note: ${n}`));
  if (risks && p.risks.length) L.push("Could make the proof differ:", ...p.risks.map((r) => `  - ${r}`));
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

/** a risk about resampling (a scaled, rotated or sub-pixel precomp layer) */
const RESAMPLING = /resampl/;

/**
 * What likely made the proof differ. Resampling (the precomp rendered, then transformed as a whole, against each layer
 * transformed once) only shows as small differences along edges: it is named only when the difference is small
 * (max channel difference up to 48/255 on at most 1% of a frame's pixels). A larger one means the layers are not
 * placed or shown as they were, whatever the plan's risks say.
 */
export function likelyCause(all: string[], diff: { maxDiff: number; share: number }): string {
  const risks = [...new Set(all)];
  const small = diff.maxDiff <= 48 && diff.share <= 0.01;
  const resampling = risks.filter((r) => RESAMPLING.test(r)), other = risks.filter((r) => !RESAMPLING.test(r));
  const size = `up to ${Math.round(diff.maxDiff * 100) / 100}/255 on ${Math.round(diff.share * 10000) / 100}% of a frame`;
  if (small && resampling.length)
    return `Likely cause (a small difference, ${size}, as resampling makes along edges):\n${[...resampling, ...other].map((r) => `  - ${r}`).join("\n")}`;
  if (!small)
    return (
      `Likely cause: the difference is too large for resampling (${size}): the moved layers are not placed, timed or shown as they were in the precomp. ` +
      "This is a bug or an After Effects behaviour the surgery doesn't handle; the frames and the area above show where." +
      (other.length ? `\nAlso in the plan:\n${other.map((r) => `  - ${r}`).join("\n")}` : "")
    );
  if (!other.length) return `Likely cause: nothing in the plan predicts a difference (${size}); look at the frames and the difference image (an expression reading the comp's name or index, an effect drawing outside a layer, or a render setting).`;
  return `Likely cause${other.length > 1 ? "s" : ""} (${size}), most likely first:\n${other.map((r) => `  - ${r}`).join("\n")}`;
}

// ---------- copy sets: what a deep duplicate made, so it can be removed exactly ----------

export interface CopySet {
  id: string;
  createdAt: string;
  project: string;
  /** root first: the original's id and the copy's id and name */
  copies: { from: number; id: number; name: string }[];
}
const copySets = () => appFile("copies");
const MAX_COPY_SETS = 50;

/** Store a deep duplicate's copies (ids and names) under ~/.surehand/ae/copies/<id>.json; keep the last 50. */
export function saveCopySet(project: string, made: { id: number; copy: number; name: string }[]): CopySet {
  const dir = copySets();
  mkdirSync(dir, { recursive: true });
  const set: CopySet = { id: `${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\..*$/, "")}-${randomBytes(2).toString("hex")}`, createdAt: new Date().toISOString(), project, copies: made.map((m) => ({ from: m.id, id: m.copy, name: m.name })) };
  writeFileSync(join(dir, `${set.id}.json`), JSON.stringify(set, null, 1));
  try {
    const all = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    for (const f of all.slice(0, Math.max(0, all.length - MAX_COPY_SETS))) rmSync(join(dir, f), { force: true });
  } catch {}
  return set;
}

/** A stored copy set: by id, else the latest one made in this project. */
export function loadCopySet(id: string | undefined, project: string | null): CopySet | string {
  const dir = copySets();
  if (id !== undefined && !/^[\w-]+$/.test(id)) return `"${id}" is not a copy set id.`;
  try {
    if (id) return JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
    const all = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse();
    for (const f of all) {
      const s: CopySet = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (s.project === project) return s;
    }
  } catch {}
  return id ? `Copy set ${id} not found (the last ${MAX_COPY_SETS} are kept).` : `No deep duplicate made by this tool is recorded for ${project ?? "this unsaved project"}.`;
}

const copiesLine = (s: CopySet) =>
  `Copies made (copy set ${s.id}): ${s.copies.map((c) => `"${c.name}" (id ${c.id})`).join(", ")}. To remove exactly these: ae_precomp_surgery {action: "remove_copies", id: "${s.id}"}.`;

/**
 * Remove a copy set's comps, only when each one is still the comp this tool made (same id, a comp) and nothing outside the
 * set uses it: no layer of another comp, no render queue item, no expression elsewhere naming it. Otherwise nothing is
 * removed and every reason is listed.
 */
export const REMOVE_COPIES_JSX = `
var P = app.project, inSet = {}, comps = [], problems = [], gone = [];
function byId(id) { for (var i = 1; i <= P.numItems; i++) if (P.item(i).id === id) return P.item(i); return null; }
for (var k = 0; k < args.copies.length; k++) inSet["i" + args.copies[k].id] = true;
for (var k2 = 0; k2 < args.copies.length; k2++) {
  var c = args.copies[k2], it = byId(c.id);
  if (!it) { gone.push(c.name); continue; }
  if (!(it instanceof CompItem)) { problems.push("item id " + c.id + " (\\"" + it.name + "\\") is not a comp any more"); continue; }
  comps.push(it);
}
for (var a = 0; a < comps.length; a++) {
  var u = comps[a].usedIn;
  for (var b = 0; b < u.length; b++) if (!inSet["i" + u[b].id]) problems.push("\\"" + comps[a].name + "\\" is used in \\"" + u[b].name + "\\", which is not one of the copies");
}
try { for (var r = 1; r <= P.renderQueue.numItems; r++) { var rc = P.renderQueue.item(r).comp; if (rc && inSet["i" + rc.id]) problems.push("\\"" + rc.name + "\\" is in the render queue (item " + r + ")"); } } catch (e) {}
function scan(g, where) {
  for (var q = 1; q <= g.numProperties; q++) {
    var p = g.property(q);
    if (p.propertyType !== PropertyType.PROPERTY) { scan(p, where); continue; }
    var x = "";
    try { x = p.canSetExpression ? p.expression : ""; } catch (e) {}
    if (!x) continue;
    for (var n = 0; n < comps.length; n++) if (x.indexOf(comps[n].name) >= 0) problems.push(where + ": an expression names \\"" + comps[n].name + "\\"");
  }
}
for (var i = 1; i <= P.numItems; i++) {
  var o = P.item(i);
  if (!(o instanceof CompItem) || inSet["i" + o.id]) continue;
  for (var l = 1; l <= o.numLayers; l++) scan(o.layer(l), "\\"" + o.name + "\\" > " + l + " \\"" + o.layer(l).name + "\\"");
}
if (problems.length) return { refused: problems, gone: gone };
var removed = [];
for (var d = 0; d < comps.length; d++) { removed.push(comps[d].name); comps[d].remove(); }
return { removed: removed, gone: gone };`;

async function removeCopies(a: SurgeryInput, perm: { mode: string; allowShell: boolean }): Promise<CallToolResult> {
  if (perm.mode === "read-only") return errorResult(READ_ONLY_REFUSAL);
  const pr = await runJsx("return app.project.file ? app.project.file.fsName : null;", {}, { undoGroup: false });
  const project = (pr.ok ? pr.result : null) as string | null;
  const set = loadCopySet(a.id, project);
  if (typeof set === "string") return errorResult(set);
  if (set.project !== project) return errorResult(`Copy set ${set.id} was made in ${set.project}; the open project is ${project ?? "unsaved"}. Nothing was removed.`);
  const r = await runJsx(REMOVE_COPIES_JSX, { copies: set.copies }, {
    undoGroup: "Surehand MCP remove copies",
    timeoutMs: 300_000,
    report: reportScope({}),
    bridge: perm.mode === "ask" ? { approval: { tool: "Remove copies", summary: `Remove the deep duplicate's copies (copy set ${set.id}): ${set.copies.map((c) => `"${c.name}"`).join(", ")}` } } : undefined,
  });
  if (!r.ok) return errorResult(r.error?.message ?? "After Effects could not remove the copies.");
  const res = parse<{ refused?: string[]; removed?: string[]; gone: string[] }>(r.result);
  const gone = res.gone.length ? `\nAlready gone: ${res.gone.map((n) => `"${n}"`).join(", ")}.` : "";
  if (res.refused)
    return { isError: true, content: [{ type: "text", text: `REFUSED: nothing was removed. Copy set ${set.id} is in use outside its own copies:\n${res.refused.map((p) => `  - ${p}`).join("\n")}${gone}` }] };
  const changes = formatChanges(r.changes);
  const removed = res.removed!.length ? `Removed copy set ${set.id}: ${res.removed!.map((n) => `"${n}"`).join(", ")}.` : `Nothing to remove for copy set ${set.id}.`;
  return { content: [{ type: "text", text: `${removed} The originals were never changed.${gone}${changes ? `\n\n${changes}` : ""}` }] };
}

export async function runSurgery(a: SurgeryInput, perm: { mode: string; allowShell: boolean }): Promise<CallToolResult> {
  if (a.action === "remove_copies") return removeCopies(a, perm);
  const override = a.override ?? [];
  const dup = a.action === "deep_duplicate";
  // seen live (AE 26.5): moving an item into a folder is an undo step of its own even inside an undo group, so a
  // folder would break the one-undo-step promise
  if (a.folder !== undefined)
    return errorResult(
      "folder isn't supported: After Effects records every move into a folder as an undo step of its own (even inside one undo group), so the copies couldn't be undone in one step. Nothing was changed. Run it without folder (the copies are made next to their originals), then move them with ae_move_items if wanted (separate undo steps).",
    );
  const read = await runJsx(dup ? DFACTS_JSX : UFACTS_JSX, { comp: a.comp, layer: a.layer }, { undoGroup: false, timeoutMs: 300_000, depth: 10 });
  if (!read.ok) return errorResult(read.error?.message ?? "After Effects could not read the project.");
  const uf = dup ? null : parse<UFacts>(read.result);
  const df = dup ? parse<DFacts>(read.result) : null;
  const plan: UPlan | DPlan = dup ? planDeepDuplicate(df!, { suffix: a.suffix, override }) : planUnprecompose(uf!, { removeSource: a.removeSource, bakeNull: a.bakeNull, override });
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
  let cp: string, cpId = "";
  try {
    const c = await saveCheckpoint(dup ? "before-deep-duplicate" : "before-unprecompose");
    cp = c.file;
    cpId = c.id;
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
      return { rehearsal, expect, copies: d.copies, edits: d.rewrites.map((r) => ({ c: r.c, l: r.l, p: r.p, old: r.old, text: r.new })) };
    }
    const u = plan as UPlan, f = uf!;
    const pick = (r: Rewrite) => (rehearsal ? r.rehearse : r.new);
    return {
      rehearsal, expect, P: f.P.id, C: f.C.id, L: f.L.i, Lname: f.L.n, pCount: f.pLayers.length, cCount: f.cLayers.length,
      edits: u.rewrites.filter((r) => pick(r) !== null && pick(r) !== r.old).map((r) => ({ c: r.c, l: r.l, p: r.p, old: r.old, text: pick(r) })),
      nullLayer: u.nullLayer,
      nullEdits: u.nullRewrites.map((r) => ({ m: r.p.length ? f.exprs.find((e) => e.c === r.c && e.l === r.l && e.p.join() === r.p.join())?.mp[1] : "", text: pick(r) ?? r.old })),
      // par: the planned parent, for messages only (the script takes parents from the source comp itself)
      moved: u.moved.map((m) => ({ ci: m.ci, to: m.to, par: m.parent === "null" ? "the null" : m.parent ? `layer ${m.parent} of the precomp` : "none", matte: m.matte ?? null })),
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
            summary: `${lines[0]}\nRehearsed on a scratch copy and proven first; applied only if the picture is identical.\n${approvalSummary("ae_precomp_surgery", a as unknown as Record<string, unknown>)}`,
          },
        }
      : undefined;
  // what the project held before: whatever a rehearsal or a stopped surgery leaves beyond it is removed by hand
  const before = (dup ? df!.ids : uf!.ids) ?? [];
  const sweep = async (what: string) => {
    if (!before.length) return "";
    try {
      const c = await runJsx(CLEANUP_JSX, { before }, { undoGroup: "Surehand MCP precomp surgery rehearsal", timeoutMs: 120_000 });
      const r = c.ok ? parse<{ removed: string[]; left: string[] }>(c.result) : { removed: [], left: [`(the cleanup failed: ${c.error?.message ?? ""})`] };
      return r.left.length ? `\nWhat ${what} left could not all be removed: ${r.left.join(", ")}. It can be deleted.` : "";
    } catch (e: any) {
      return `\nThe cleanup after ${what} failed: ${e?.message ?? e}`;
    }
  };
  // the rehearsal
  const reh = await runJsx(dup ? DEEPDUP_JSX : UNPRECOMPOSE_JSX, jsxArgs(true), { undoGroup: "Surehand MCP precomp surgery rehearsal", timeoutMs: 600_000, rollback: "requested", depth: 6, bridge: approval });
  if (!reh.ok) return errorResult(`${reh.error?.message ?? "The rehearsal failed"}\nNothing was changed (checkpoint ${cp}).${await sweep("the rehearsal")}`);
  const rr = parse<{ rollback?: true; error?: string; T?: number; root?: number; created: number[]; fingerprint: string }>(reh.result);
  if (rr.rollback) {
    const rb = reh.rollback;
    return errorResult(`The rehearsal on a scratch copy stopped: ${String(rr.error).replace(/\.$/, "")}. ${rb?.verified ? "It was undone: nothing changed." : rollbackProblem(rb ?? { undone: false, verified: false, problem: "no result" }, "the rehearsal")}\nCheckpoint: ${cp}${await sweep("the rehearsal")}`);
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
  const leftNote = await sweep("the rehearsal");
  const proofMs = Date.now() - t0;
  if (typeof cmp === "string" || !proven(cmp)) {
    const verdict = typeof cmp === "string" ? `NOT PROVEN: ${cmp}` : cmp.text;
    const differs = typeof cmp !== "string" && cmp.verdict === "differs";
    out.push(
      `${differs ? "DIFFERS" : "NOT PROVEN"}: the ${what} was NOT applied. It was rehearsed on a scratch copy, the copy did not render identical to the original, and the copy was removed: the project is as it was (checkpoint ${cp}).`,
      "",
      verdict,
      "",
      differs && typeof cmp !== "string" ? likelyCause(plan.risks, { maxDiff: cmp.view?.maxDiff ?? 255, share: cmp.share ?? 1 }) : "",
      "",
      "The plan that was rehearsed:",
      ...(dup ? describeDeepDuplicate(df!, plan as DPlan, override, false) : describeUnprecompose(uf!, plan as UPlan, override, false)),
    );
    const content: CallToolResult["content"] = [{ type: "text", text: out.filter((x, i, arr) => !(x === "" && arr[i - 1] === "")).join("\n") + leftNote }];
    if (typeof cmp !== "string" && cmp.image) content.push({ type: "image", data: cmp.image.data, mimeType: "image/png" }, { type: "text", text: cmp.image.label });
    return { isError: true, content };
  }
  // proven: the same surgery on the project, in one undo group, checked against the rehearsal
  const real = await runJsx(dup ? DEEPDUP_JSX : UNPRECOMPOSE_JSX, jsxArgs(false, rr.fingerprint), {
    undoGroup: dup ? "Surehand MCP deep duplicate" : "Surehand MCP un-precompose",
    timeoutMs: 600_000,
    rollback: "requested",
    depth: 6,
    report: reportScope({ comp: dup ? undefined : uf!.P.id }),
  });
  if (!real.ok) return errorResult(`The rehearsal was proven identical, but applying it failed: ${real.error?.message}\nCheckpoint: ${cp}${leftNote}${await sweep(`the ${what}`)}`);
  const rs = parse<{ rollback?: true; error?: string; root?: number; made?: { id: number; copy: number; name: string }[]; moved?: { ci: number; name: string; index: number }[]; nullIndex?: number }>(real.result);
  if (rs.rollback) {
    const rb = real.rollback;
    return errorResult(`The rehearsal was proven identical, but applying it stopped: ${String(rs.error).replace(/\.$/, "")}. ${rb?.verified ? (rb.undone ? "It was undone: nothing changed." : "Nothing had changed yet.") : rollbackProblem(rb ?? { undone: false, verified: false, problem: "no result" }, `the ${what}`)}\nCheckpoint: ${cp}${leftNote}${await sweep(`the ${what}`)}`);
  }
  const frames = cmp.view?.frames.filter((x) => !x.missing).length ?? 0;
  const head = cmp.text.split("\n")[0].replace(/^Verdict: /, "").replace(/\.$/, "");
  out.push(
    `DONE and proven: ${head} (${plural(frames, "frame")} compared, ${sec(proofMs)} including the rehearsal).`,
    `Checkpoint saved first: ${cp}`,
    dup ? `New root comp: "${(plan as DPlan).copies[0].to}" (id ${rs.root}).` : "",
    dup ? copiesLine(saveCopySet(df!.project!, rs.made ?? [])) : "",
    ...lines,
    rs.moved ? `Read back from "${uf!.P.name}" after the surgery: ${[...(rs.nullIndex ? [{ index: rs.nullIndex, name: (plan as UPlan).nullLayer?.name ?? "" }] : []), ...rs.moved].sort((x, y) => x.index - y.index).map((m) => `${m.index} "${m.name}"`).join(", ")}.` : "",
    "",
    "Proof (the rehearsal on a scratch copy against the original, then the same surgery applied and checked layer for layer against the rehearsal):",
    ...cmp.text.split("\n").slice(1),
    "",
    dup
      ? "The originals are unchanged: the deep duplicate only added the copies above (with their expressions rewritten inside them). Made in one undo group, but After Effects doesn't always keep comp duplicates and source replacements in one undo step, so ae_undo may take several steps; the exact way back is remove_copies."
      : `Made in one undo group ("Surehand MCP un-precompose"), but After Effects can split such a step (it was seen to undo only the removal of the precomp layer first), so ae_undo may take several steps and is not a reliable way back. The exact way back is the checkpoint saved first: ae_checkpoint {action: "restore", id: "${cpId}"} (opens it as a new file next to the project). Expression rewrites in other comps are exact text edits, listed above; the pixel proof covers the parent comp.`,
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
        "change in one undo group (After Effects may split it: the way back is the checkpoint, or remove_copies for a deep duplicate); DIFFERS: nothing is applied, with the frames that differ and the likely cause. remove_copies: " +
        "removes exactly the comps a deep duplicate made, refused if anything outside them uses one.",
      inputSchema: {
        action: z.enum(["unprecompose", "deep_duplicate", "remove_copies"]),
        comp: compRef.describe("unprecompose: the comp that holds the precomp layer; deep_duplicate: the comp to copy with its tree. Default: the active comp."),
        layer: layerRef.optional().describe("unprecompose: the precomp layer (index or name; default the selected layer)."),
        id: z.string().optional().describe("remove_copies: the copy set id a deep duplicate returned (default: the latest one made in this project)."),
        dryRun: z.boolean().optional().describe("Only plan: what would move, be renamed and rewritten, and every blocker. Nothing is changed."),
        removeSource: z.boolean().optional().describe("unprecompose: also remove the source comp, only if nothing else uses it (refused otherwise). Default: keep it."),
        bakeNull: z.boolean().optional().describe("unprecompose: leave out the null when the precomp layer's transform is the identity (exact); otherwise a null is kept and the result says why."),
        suffix: z.string().min(1).max(60).optional().describe('deep_duplicate: added to each copy\'s name (default " copy"; a number is added when the name is taken).'),
        folder: z.string().optional().describe("Not supported: After Effects records every move into a folder as an undo step of its own, so the copies stay next to their originals. Move them afterwards with ae_move_items."),
        override: z
          .array(z.enum(["expressions", "bounds"]))
          .optional()
          .describe("Go ahead despite these problems (they are still reported, left as they are, and the pixel proof decides): expressions = references that can't be rewritten safely; bounds = layers that reach outside the precomp's frame."),
        frames: z.number().int().min(1).max(24).optional().describe("Frames to prove (default: unprecompose 6 over the precomp layer's time span, first and last frame included; deep_duplicate 5 over the work area)."),
        times: z.array(z.number()).min(1).max(24).optional().describe("Exact times (seconds) to prove instead."),
        tolerance: z.number().min(0).max(255).optional().describe(`Allowed difference per channel, 0-255 (default ${DEFAULT_TOLERANCE}, as ae_prove_identical; 0 = bit-identical).`),
        maxSize: z.number().int().min(64).max(4096).optional().describe("Longest rendered side for the proof (default 1920)."),
      },
      // edits in one undo group (rehearsal on a scratch copy first; the project is saved for a checkpoint)
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
