import { z } from "zod";
import { compRef, layerRef, type JsxTool } from "./registry.js";

// Reads values through AE's expression engine: one temporary text layer whose Source Text
// expression returns everything as a string, evaluated once. The expression is written in ES3
// style so it also works with the Legacy ExtendScript expression engine. The temporary layer
// is removed again in the same undo step (tempItems).
const evalViaExpression = `
function evalExpr(comp, expr, t) {
  var tl = comp.layers.addText("");
  tl.name = "__aemcp_probe";
  tl.moveToEnd();
  try {
    var st = tl.property("ADBE Text Properties").property("ADBE Text Document");
    st.expression = expr;
    var v = st.valueAtTime(t, false).text;
    var err = st.expressionError;
    if (err) aemcp.fail("Expression evaluation failed: " + err);
    return v;
  } finally { tl.remove(); }
}`;

export const inspectTools: JsxTool[] = [
  {
    name: "ae_get_layer_bounds",
    title: "Layer bounds",
    description:
      "Exact on-screen bounding boxes of layers in composition pixels at a time, after all transforms, parenting, 3D and the active camera " +
      "(via AE's own toComp()). Also reports whether each layer is visible at that time, fully/partly/not in frame, and inside action-safe (5% margin) " +
      "and title-safe (10% margin). Use it to check alignment, spacing, overlaps and safe areas with numbers.",
    input: {
      comp: compRef,
      layers: z.array(layerRef).optional().describe("Layers to measure (default: all layers, up to 300)."),
      selectedOnly: z.boolean().optional().describe("Measure only the layers selected in After Effects."),
      time: z.number().optional().describe("Seconds (default: the comp's current time)."),
      includeExtents: z.boolean().optional().describe("Include stroke widths, effects and other extents (default false = content box)."),
    },
    readOnly: true,
    tempItems: true,
    jsx: `${evalViaExpression}
var c = aemcp.findComp(args.comp), t = args.time === undefined ? c.time : args.time, idx = [];
if (args.layers) { for (var i = 0; i < args.layers.length; i++) idx.push(aemcp.findLayer(c, args.layers[i]).index); }
else if (args.selectedOnly) { for (var j = 0; j < c.selectedLayers.length; j++) idx.push(c.selectedLayers[j].index); if (!idx.length) aemcp.fail("No layers are selected"); }
else { for (var k = 1; k <= Math.min(c.numLayers, 300); k++) idx.push(k); }
if (!idx.length) aemcp.fail("The comp has no layers");
var expr = "var ids=[" + idx.join(",") + "],ext=" + (args.includeExtents ? "true" : "false") + ",s='';" +
  "for(var i=0;i<ids.length;i++){var L=thisComp.layer(ids[i]);s+=ids[i]+':';" +
  "try{var r=L.sourceRectAtTime(time,ext);var a=L.toComp([r.left,r.top]),b=L.toComp([r.left+r.width,r.top]),c=L.toComp([r.left+r.width,r.top+r.height]),d=L.toComp([r.left,r.top+r.height]);" +
  "s+=[r.left,r.top,r.width,r.height,a[0],a[1],b[0],b[1],c[0],c[1],d[0],d[1]].join(',');}catch(e){s+='ERR '+e.message;}s+='|';}s";
var raw = evalExpr(c, expr, t), out = [], W = c.width, H = c.height;
var parts = raw.split("|");
for (var p = 0; p < parts.length; p++) {
  if (!parts[p]) continue;
  var colon = parts[p].indexOf(":"), li = Number(parts[p].substr(0, colon)), body = parts[p].substr(colon + 1), L = c.layer(li);
  var o = { index: li, name: L.name, type: aemcp.layerType(L), visible: L.enabled && L.inPoint <= t && t < L.outPoint };
  if (body.indexOf("ERR") === 0) { o.bounds = null; o.note = L instanceof CameraLayer || L instanceof LightLayer ? "cameras and lights have no bounds" : body; out.push(o); continue; }
  var n = body.split(","), xs = [Number(n[4]), Number(n[6]), Number(n[8]), Number(n[10])], ys = [Number(n[5]), Number(n[7]), Number(n[9]), Number(n[11])];
  var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
  var r1 = function (v) { return Math.round(v * 10) / 10; };
  o.bounds = { left: r1(x0), top: r1(y0), right: r1(x1), bottom: r1(y1), width: r1(x1 - x0), height: r1(y1 - y0), centerX: r1((x0 + x1) / 2), centerY: r1((y0 + y1) / 2) };
  o.corners = [[r1(xs[0]), r1(ys[0])], [r1(xs[1]), r1(ys[1])], [r1(xs[2]), r1(ys[2])], [r1(xs[3]), r1(ys[3])]];
  o.layerRect = { left: r1(Number(n[0])), top: r1(Number(n[1])), width: r1(Number(n[2])), height: r1(Number(n[3])) };
  o.inFrame = x1 <= 0 || y1 <= 0 || x0 >= W || y0 >= H ? "outside" : (x0 >= 0 && y0 >= 0 && x1 <= W && y1 <= H ? "full" : "partial"); // parenthesized: ExtendScript nests ?: left-to-right
  o.actionSafe = x0 >= W * 0.05 && x1 <= W * 0.95 && y0 >= H * 0.05 && y1 <= H * 0.95;
  o.titleSafe = x0 >= W * 0.1 && x1 <= W * 0.9 && y0 >= H * 0.1 && y1 <= H * 0.9;
  if (o.bounds.width === 0 && o.bounds.height === 0) o.note = "empty at this time (no content)";
  out.push(o);
}
return { comp: c.name, size: [W, H], time: t, layers: out };`,
  },
  {
    name: "ae_sample_pixels",
    title: "Sample pixel colors",
    description:
      "Read the rendered color of the composition at given points (or the average over a small square), as RGBA 0-1 and hex. " +
      "Use it to verify colors against a spec or check contrast. Samples the final composite of the comp.",
    input: {
      comp: compRef,
      points: z.array(z.array(z.number()).length(2)).min(1).max(100).describe("Comp-pixel coordinates [[x,y],...]."),
      time: z.number().optional().describe("Seconds (default: the comp's current time)."),
      radius: z.number().min(0.5).max(200).optional().describe("Average over a square of this half-size in pixels (default 0.5 = one pixel)."),
    },
    readOnly: true,
    tempItems: true,
    jsx: `${evalViaExpression}
var c = aemcp.findComp(args.comp), t = args.time === undefined ? c.time : args.time, rad = args.radius || 0.5;
var wrap = app.project.items.addComp("__aemcp_sample", c.width, c.height, c.pixelAspect, c.duration, c.frameRate);
try {
  var src = wrap.layers.add(c);
  src.name = "__src";
  var pts = [];
  for (var i = 0; i < args.points.length; i++) pts.push("[" + Number(args.points[i][0]) + "," + Number(args.points[i][1]) + "]");
  var expr = "var p=[" + pts.join(",") + "],s='';for(var i=0;i<p.length;i++){var v=thisComp.layer('__src').sampleImage(p[i],[" + rad + "," + rad + "],true,time);s+=v.join(',')+'|';}s";
  var raw = evalExpr(wrap, expr, t);
} finally { wrap.remove(); }
var out = [], rows = raw.split("|");
function hex(v) { var h = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16); return h.length < 2 ? "0" + h : h; }
for (var k = 0; k < args.points.length; k++) {
  var v = rows[k].split(",");
  var rgba = [Number(v[0]), Number(v[1]), Number(v[2]), Number(v[3])];
  out.push({ point: args.points[k], rgba: [aemcp.round(rgba[0]), aemcp.round(rgba[1]), aemcp.round(rgba[2]), aemcp.round(rgba[3])], hex: "#" + hex(rgba[0]) + hex(rgba[1]) + hex(rgba[2]) });
}
return { comp: c.name, time: t, radius: rad, samples: out };`,
  },
  {
    name: "ae_get_comp_map",
    title: "Composition structure map",
    description:
      "Overview of how a composition is built: the tree of nested precomps (with how many times each is used), parenting chains, " +
      "track mattes, and which layers/comps each expression references. Use it to understand an unfamiliar project before editing.",
    input: {
      comp: compRef,
      depth: z.number().int().min(1).max(10).optional().describe("How deep to follow nested precomps (default 4)."),
    },
    readOnly: true,
    jsx: `
var root = aemcp.findComp(args.comp), maxDepth = args.depth || 4, seen = {}, comps = [], parenting = [], mattes = [], links = [];
function refs(expr) {
  var out = [], re = /(comp\\(\\s*("[^"]*"|'[^']*')\\s*\\))?\\s*\\.?\\s*layer\\(\\s*("[^"]*"|'[^']*'|\\d+)\\s*\\)|comp\\(\\s*("[^"]*"|'[^']*')\\s*\\)/g, m;
  while ((m = re.exec(expr))) {
    var cn = m[2] || m[4], ln = m[3];
    out.push((cn ? "comp " + cn.slice(1, -1) : "thisComp") + (ln ? " > layer " + (/^\\d/.test(ln) ? ln : ln.slice(1, -1)) : ""));
  }
  return out;
}
function walkProps(g, cb, path) {
  for (var i = 1; i <= g.numProperties; i++) {
    var p = g.property(i), pp = path ? path + "/" + p.name : p.name;
    if (p.propertyType === PropertyType.PROPERTY) { try { if (p.canSetExpression && p.expression) cb(pp, p); } catch (e) {} }
    else walkProps(p, cb, pp);
  }
}
function visit(c, d) {
  if (seen[c.id]) { seen[c.id].uses++; return; }
  var info = { id: c.id, name: c.name, depth: d, size: [c.width, c.height], duration: aemcp.round(c.duration), frameRate: aemcp.round(c.frameRate), layers: c.numLayers, uses: 1, precomps: [] };
  seen[c.id] = info; comps.push(info);
  for (var i = 1; i <= c.numLayers; i++) {
    var L = c.layer(i), tag = c.name + " > " + L.index + ": " + L.name;
    if (L.parent) parenting.push([tag, L.parent.index + ": " + L.parent.name]);
    try { if (L.hasTrackMatte || (L.trackMatteType !== undefined && L.trackMatteType !== TrackMatteType.NO_TRACK_MATTE)) mattes.push([tag, aemcp.enumName(TrackMatteType, L.trackMatteType), L.trackMatteLayer ? L.trackMatteLayer.name : null]); } catch (e) {}
    walkProps(L, function (path, p) { var r = refs(p.expression); links.push({ layer: tag, property: path, references: r, error: p.expressionError || undefined }); }, "");
    var src = null; try { src = L.source; } catch (e) {}
    if (src && src instanceof CompItem) {
      info.precomps.push({ layer: L.index + ": " + L.name, comp: src.name, id: src.id });
      if (d < maxDepth) visit(src, d + 1);
    }
  }
}
visit(root, 0);
return { root: root.name, comps: comps, parenting: parenting, trackMattes: mattes, expressions: links };`,
  },
];
