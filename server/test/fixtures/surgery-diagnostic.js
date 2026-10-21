// Precomp surgery diagnostic (ae_run_script, args: { comp: "Main1", layer: "Pre1" }).
// Repeats the un-precompose steps of tools/surgery.ts on a throwaway duplicate of the comp and prints, after each step,
// every moved layer's and the null's parent and local anchor / position / scale / rotation at t (default 0), its matrix
// and the comp-space position of its anchor point (math from the values, not expressions), and what the precomp layer
// showed there (expected). Then removes the duplicate and the null's solid. The source comp's links are detached for
// copyToComp (refused for parented / expression layers inside an undo group) and put back; the result says if not.
var t = args.t || 0, out = [];
function r4(n) { return Math.round(n * 10000) / 10000; }
function v(p, tt) { return p.valueAtTime(tt, false); }
function local(x, tt) {
  var g = x.property("ADBE Transform Group"), a = v(g.property("ADBE Anchor Point"), tt), s = v(g.property("ADBE Scale"), tt), r = v(g.property("ADBE Rotate Z"), tt) * Math.PI / 180, pp = g.property("ADBE Position");
  var p = pp.dimensionsSeparated ? [v(g.property("ADBE Position_0"), tt), v(g.property("ADBE Position_1"), tt)] : v(pp, tt);
  var cs = Math.cos(r), sn = Math.sin(r), m0 = cs * s[0] / 100, m1 = sn * s[0] / 100, m2 = -sn * s[1] / 100, m3 = cs * s[1] / 100;
  return [m0, m1, m2, m3, p[0] - (m0 * a[0] + m2 * a[1]), p[1] - (m1 * a[0] + m3 * a[1])];
}
function mul(A, B) { return [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]]; }
function world(x, tt) { var m = local(x, tt), p = x.parent; return p ? mul(world(p, tt), m) : m; }
function apply(m, a) { return [r4(m[0] * a[0] + m[2] * a[1] + m[4]), r4(m[1] * a[0] + m[3] * a[1] + m[5])]; }
function arr(a) { var o = []; for (var i = 0; i < a.length; i++) o.push(r4(a[i])); return "[" + o.join(", ") + "]"; }
function stashExprs(g, d) {
  for (var q = 1; q <= g.numProperties; q++) {
    var pr = g.property(q);
    if (pr.propertyType !== PropertyType.PROPERTY) stashExprs(pr, d);
    else if (pr.canSetExpression && pr.expression !== "") { d.exprs.push({ pr: pr, x: pr.expression, on: pr.expressionEnabled }); pr.expression = ""; }
  }
}
function show(step, x, expected) {
  var g = x.property("ADBE Transform Group"), a = v(g.property("ADBE Anchor Point"), t), pp = g.property("ADBE Position");
  var p = pp.dimensionsSeparated ? [v(g.property("ADBE Position_0"), t), v(g.property("ADBE Position_1"), t)] : v(pp, t);
  var w = world(x, t), line = step + " | " + x.index + " " + x.name + " | parent " + (x.parent ? x.parent.index + " " + x.parent.name : "none") +
    " | anchor " + arr(a) + " position " + arr(p) + " scale " + arr(v(g.property("ADBE Scale"), t)) + " rotation " + r4(v(g.property("ADBE Rotate Z"), t)) +
    " | matrix " + arr(w) + " | anchor in comp " + arr(apply(w, a));
  if (expected) line += " | EXPECTED " + arr(apply(expected, a)) + (Math.abs(apply(expected, a)[0] - apply(w, a)[0]) + Math.abs(apply(expected, a)[1] - apply(w, a)[1]) > 0.01 ? "  <-- OFF" : "  ok");
  out.push(line);
}
var P = aemcp.findComp(args.comp), L0 = aemcp.findLayer(P, args.layer), C = L0.source;
if (!(C instanceof CompItem)) aemcp.fail("not a precomp layer");
var had = {};
for (var i = 1; i <= app.project.numItems; i++) had["i" + app.project.item(i).id] = true;
out.push("After Effects " + app.version + "; " + P.name + " " + P.width + "x" + P.height + "; " + C.name + " " + C.width + "x" + C.height + "; t = " + t);
var T = P.duplicate();
try {
  T.name = P.name + " (Surehand diagnostic)";
  var LT = T.layer(L0.index), Ls = LT.startTime;
  show("precomp layer", LT);
  var N = T.layers.addNull(T.duration);
  N.name = LT.name + " (null)";
  N.moveBefore(LT);
  show("null as added", N);
  N.startTime = LT.startTime; N.inPoint = LT.inPoint; N.outPoint = LT.outPoint;
  if (LT.parent) N.setParentWithJump(LT.parent);
  var sg = LT.property("ADBE Transform Group"), dg = N.property("ADBE Transform Group"), sep = sg.property("ADBE Position").dimensionsSeparated;
  if (sep) dg.property("ADBE Position").dimensionsSeparated = true;
  var names = ["ADBE Anchor Point", "ADBE Scale", "ADBE Rotate Z"].concat(sep ? ["ADBE Position_0", "ADBE Position_1"] : ["ADBE Position"]);
  for (var n1 = 0; n1 < names.length; n1++) {
    var sp = sg.property(names[n1]), dp = dg.property(names[n1]);
    if (sp.numKeys) { for (var k = 1; k <= sp.numKeys; k++) aemcp.restoreKey(dp, aemcp.captureKey(sp, k)); } else dp.setValue(sp.value);
  }
  show("null with the precomp layer's values", N, world(LT, t));
  // copy C's layers (detached, as the surgery does)
  var map = [], stash = [];
  for (var j = 1; j <= C.numLayers; j++) {
    var S = C.layer(j), d = { lk: S.locked, parent: S.parent, exprs: [] };
    if (d.lk) S.locked = false;
    if (d.parent) S.setParentWithJump(null);
    stashExprs(S, d);
    stash.push(d);
  }
  for (var j2 = 1; j2 <= C.numLayers; j2++) {
    var ids = {};
    for (var y = 1; y <= T.numLayers; y++) ids["l" + T.layer(y).id] = true;
    C.layer(j2).copyToComp(T);
    var X = null;
    for (var y2 = 1; y2 <= T.numLayers; y2++) if (!ids["l" + T.layer(y2).id]) X = T.layer(y2);
    out.push("copyToComp " + C.layer(j2).name + ": the copy landed at index " + X.index + " (layer 1 is " + T.layer(1).name + ")");
    if (X.locked) X.locked = false;
    map.push(X);
    show("copy as pasted", X);
  }
  for (var j3 = 0; j3 < stash.length; j3++) {
    var S2 = C.layer(j3 + 1), d2 = stash[j3];
    if (d2.parent) S2.setParentWithJump(d2.parent);
    for (var e = 0; e < d2.exprs.length; e++) { d2.exprs[e].pr.expression = d2.exprs[e].x; d2.exprs[e].pr.expressionEnabled = d2.exprs[e].on; }
    if (d2.lk) S2.locked = true;
  }
  for (var o1 = 0; o1 < map.length; o1++) map[o1].moveBefore(LT);
  if (map.length) N.moveBefore(map[0]);
  for (var m = 0; m < map.length; m++) {
    var src = C.layer(m + 1);
    map[m].setParentWithJump(src.parent ? map[src.parent.index - 1] : N);
  }
  for (var m2 = 0; m2 < map.length; m2++) show("moved and parented", map[m2], mul(world(LT, t), world(C.layer(m2 + 1), t - Ls)));
  show("null before the precomp layer goes", N, world(LT, t));
  var expect = [];
  for (var m3 = 0; m3 < map.length; m3++) expect.push(mul(world(LT, t), world(C.layer(m3 + 1), t - Ls)));
  LT.remove();
  for (var m4 = 0; m4 < map.length; m4++) show("after the precomp layer was removed", map[m4], expect[m4]);
} finally {
  // the duplicate and anything else this script added (the null's solid)
  try { T.remove(); } catch (e2) { out.push("could not remove the duplicate: " + e2.message); }
  var left = [];
  for (var i2 = app.project.numItems; i2 >= 1; i2--) { var it = app.project.item(i2); if (!had["i" + it.id]) left.push(it); }
  for (var i3 = 0; i3 < left.length; i3++) { try { left[i3].remove(); } catch (e3) { out.push("could not remove " + left[i3].name); } }
}
return out.join("\n");
