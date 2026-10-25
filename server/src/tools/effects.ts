import { z } from "zod";
import { colorSchema, compRef, layerRef, type JsxTool } from "./registry.js";

const params = z
  .record(z.string(), z.any())
  .optional()
  .describe('Effect parameters by display name or match name, e.g. {"Blurriness": 20, "Repeat Edge Pixels": true} or {"Color": "#ff0000"}.');

const setParams = `
function setParams(fx, params) {
  var done = {};
  for (var k in params) {
    if (!params.hasOwnProperty(k)) continue;
    var p = aemcp.resolveProp(fx, [k]);
    var v = params[k];
    if (typeof v === "boolean") v = v ? 1 : 0;
    p.setValue(aemcp.toAEValue(p, v));
    done[p.name] = aemcp.valueOf(p.value);
  }
  return done;
}`;

export const effectTools: JsxTool[] = [
  {
    name: "ae_list_available_effects",
    title: "List available effects",
    description: "List effects installed in After Effects (display name, match name, category). Filter by name or category to keep it short.",
    input: { nameContains: z.string().optional(), category: z.string().optional(), limit: z.number().int().optional().describe("Default 300.") },
    readOnly: true,
    jsx: `
var out = [], q = args.nameContains ? args.nameContains.toLowerCase() : null, cat = args.category ? args.category.toLowerCase() : null, lim = args.limit || 300;
var all = app.effects; // app.effects builds a new array on every access: read it once
for (var i = 0; i < all.length && out.length < lim; i++) {
  var e = all[i];
  if (q && e.displayName.toLowerCase().indexOf(q) < 0 && e.matchName.toLowerCase().indexOf(q) < 0) continue;
  if (cat && String(e.category).toLowerCase().indexOf(cat) < 0) continue;
  out.push({ name: e.displayName, matchName: e.matchName, category: e.category });
}
return { total: all.length, returned: out.length, effects: out };`,
  },
  {
    name: "ae_get_effect_params",
    title: "Inspect effect parameters",
    description:
      "List an effect's parameters (names, match names, value types, defaults, min/max) so you know the exact parameter names for " +
      "ae_apply_effect / ae_set_effect_params (via ae_call). By default it reads a fresh instance: it applies the effect on a temporary comp " +
      "and removes that comp again in the same undo step, so your comps and layers are left as they were. Pass comp+layer to read an effect " +
      "already applied to that layer instead (current values). Unknown effect names fail with suggestions.",
    input: {
      effect: z.union([z.string(), z.number().int()]).describe('Match name (e.g. "ADBE Glo2") or display name ("Glow"); with comp+layer, also an index in the stack.'),
      comp: compRef,
      layer: layerRef.optional().describe("Inspect the effect on this layer instead of a fresh default instance."),
    },
    readOnly: true,
    tempItems: true,
    jsx: `
function describe(fx) {
  var out = [];
  for (var i = 1; i <= fx.numProperties; i++) {
    var p = fx.property(i);
    var o = { index: i, name: p.name, matchName: p.matchName };
    if (p.propertyType === PropertyType.PROPERTY) {
      o.type = aemcp.enumName(PropertyValueType, p.propertyValueType);
      if (p.propertyValueType === PropertyValueType.NO_VALUE) { o.type = "group start/end or button"; }
      else {
        try { o.value = aemcp.valueOf(p.value); } catch (e) {}
        try { if (p.hasMin) o.min = p.minValue; if (p.hasMax) o.max = p.maxValue; } catch (e) {}
        try { if (p.isDropdownEffect) o.dropdown = true; } catch (e) {}
        try { o.animatable = p.canVaryOverTime; } catch (e) {}
      }
    } else { o.type = "group"; o.children = describe(p); }
    if (o.type !== "group start/end or button") out.push(o);
  }
  return out;
}
if (args.layer !== undefined) {
  var lc = aemcp.findComp(args.comp), ll = aemcp.findLayer(lc, args.layer);
  var efx = aemcp.resolveProp(ll, ["ADBE Effect Parade", args.effect]);
  return { effect: efx.name, matchName: efx.matchName, layer: ll.name, params: describe(efx) };
}
var info = aemcp.effectMatchName(args.effect), mn = info.matchName;
var c = app.project.items.addComp("__aemcp_inspect", 100, 100, 1, 1, 30);
try {
  var s = c.layers.addSolid([0, 0, 0], "tmp", 100, 100, 1);
  var fx = s.property("ADBE Effect Parade").addProperty(mn);
  var res = { effect: info.displayName, matchName: mn, category: info.category, params: describe(fx) };
} finally {
  var src = null; try { src = s.source; } catch (e) {}
  c.remove(); if (src) try { src.remove(); } catch (e) {}
}
return res;`,
  },
  {
    name: "ae_apply_effect",
    title: "Apply effect",
    description:
      'Apply an effect to a layer by match name (preferred, e.g. "ADBE Gaussian Blur 2", "ADBE Fill", "ADBE Glo2", "ADBE Drop Shadow") or display name, optionally setting parameters. ' +
      "Each call adds a new instance at the bottom of the layer's effect stack. Returns its index in the stack, its parameters and the values set; " +
      "an unknown effect name fails with suggestions. Check parameter names first with ae_get_effect_params; change an applied effect with " +
      "ae_set_effect_params, search installed effects with ae_list_available_effects (both via ae_call).",
    input: {
      comp: compRef,
      layer: layerRef,
      effect: z.string().describe('Match name (e.g. "ADBE Gaussian Blur 2", works in every AE language) or display name ("Gaussian Blur").'),
      name: z.string().optional().describe("Name for the new effect instance (default: After Effects' name for it)."),
      params,
    },
    jsx: `${setParams}
var c = aemcp.findComp(args.comp), l = aemcp.findLayer(c, args.layer), parade = l.property("ADBE Effect Parade");
var mn = parade.canAddProperty(args.effect) ? args.effect : aemcp.effectMatchName(args.effect).matchName;
var fx = parade.addProperty(mn);
if (args.name) fx.name = args.name;
var set = args.params ? setParams(fx, args.params) : {};
return { layer: l.name, effectIndex: fx.propertyIndex, effect: aemcp.propInfo(fx, { depth: 1 }), set: set };`,
  },
  {
    name: "ae_set_effect_params",
    title: "Set effect parameters",
    description: "Set parameters on an effect already applied to a layer (effect by name, match name or 1-based index in the effect stack).",
    input: { comp: compRef, layer: layerRef, effect: z.union([z.string(), z.number().int()]), params: params.unwrap(), enabled: z.boolean().optional() },
    idempotent: true,
    jsx: `${setParams}
var c = aemcp.findComp(args.comp), l = aemcp.findLayer(c, args.layer);
var fx = aemcp.resolveProp(l, ["ADBE Effect Parade", args.effect]);
if (args.enabled !== undefined) fx.enabled = args.enabled;
return { effect: fx.name, set: setParams(fx, args.params || {}) };`,
  },
  {
    name: "ae_remove_effect",
    title: "Remove effect",
    description: "Remove an effect from a layer (by name, match name or index).",
    input: { comp: compRef, layer: layerRef, effect: z.union([z.string(), z.number().int()]) },
    destructive: true,
    jsx: `var c = aemcp.findComp(args.comp), l = aemcp.findLayer(c, args.layer); var fx = aemcp.resolveProp(l, ["ADBE Effect Parade", args.effect]); var n = fx.name; fx.remove(); return { removed: n };`,
  },
  {
    name: "ae_apply_preset",
    title: "Apply animation preset",
    description: "Apply an animation preset (.ffx) to a layer.",
    input: { comp: compRef, layer: layerRef, path: z.string().describe("Absolute path to the .ffx file.") },
    jsx: `
var c = aemcp.findComp(args.comp), l = aemcp.findLayer(c, args.layer), f = new File(args.path);
if (!f.exists) aemcp.fail("Preset not found: " + args.path);
l.applyPreset(f); return aemcp.layerInfo(l, true);`,
  },
  {
    name: "ae_add_shape",
    title: "Add shape",
    description:
      "Draw a shape (rectangle, ellipse, polygon, star, or custom path) with fill and/or stroke, as a new shape group on a new shape layer or " +
      "added to an existing shape layer (its other groups are kept). Positions are relative to the layer (new layers are centered in the comp, " +
      "so [0,0] is the comp center). Returns the layer and the new group. To cut out part of a layer use ae_add_mask (via ae_call).",
    input: {
      comp: compRef,
      layer: layerRef.optional().describe("Existing shape layer to add to (other layer types fail); omit to create a new one."),
      name: z.string().optional().describe('Name of the new shape group, and of a new layer (default "Shape Layer").'),
      shape: z.enum(["rectangle", "ellipse", "polygon", "star", "path"]),
      size: z.array(z.number()).length(2).optional().describe("[w,h] in pixels for rectangle/ellipse (default [400,400]); polygon/star radii default from its width."),
      position: z.array(z.number()).length(2).optional().describe("Shape center within the layer (default [0,0]); not used for 'path'."),
      roundness: z.number().optional().describe("Rectangle corner roundness in pixels (default 0)."),
      points: z.number().optional().describe("Polygon/star: number of points (default 5)."),
      outerRadius: z.number().optional().describe("Polygon/star: outer radius in pixels (default size[0]/2)."),
      innerRadius: z.number().optional().describe("Star: inner radius in pixels (default size[0]/4)."),
      vertices: z.array(z.array(z.number()).length(2)).optional().describe("For 'path' (required): points [[x,y],...] in layer coordinates."),
      inTangents: z.array(z.array(z.number()).length(2)).optional().describe("For 'path': incoming Bezier handle per vertex, [[x,y],...] relative to the vertex (default: straight segments)."),
      outTangents: z.array(z.array(z.number()).length(2)).optional().describe("For 'path': outgoing Bezier handle per vertex, relative to the vertex."),
      closed: z.boolean().optional().describe("For 'path': close the path (default true)."),
      fill: colorSchema.optional().describe("Fill color; omit for no fill (unless no stroke either: defaults to white)."),
      stroke: colorSchema.optional().describe("Stroke color; omit for no stroke."),
      strokeWidth: z.number().optional().describe("Stroke width in pixels (default 4); only with stroke."),
    },
    jsx: `
var c = aemcp.findComp(args.comp), l;
if (args.layer !== undefined) l = aemcp.findLayer(c, args.layer); else { l = c.layers.addShape(); l.name = args.name || "Shape Layer"; l.property("ADBE Transform Group").property("ADBE Position").setValue([c.width / 2, c.height / 2]); }
var contents = l.property("ADBE Root Vectors Group");
if (!contents) aemcp.fail("Layer is not a shape layer");
var grp = contents.addProperty("ADBE Vector Group");
if (args.name) grp.name = args.name;
var vecs = grp.property("ADBE Vectors Group"), sz = args.size || [400, 400], geo;
switch (args.shape) {
  case "rectangle": geo = vecs.addProperty("ADBE Vector Shape - Rect"); geo.property("ADBE Vector Rect Size").setValue(sz); if (args.roundness) geo.property("ADBE Vector Rect Roundness").setValue(args.roundness); break;
  case "ellipse": geo = vecs.addProperty("ADBE Vector Shape - Ellipse"); geo.property("ADBE Vector Ellipse Size").setValue(sz); break;
  case "polygon":
  case "star":
    geo = vecs.addProperty("ADBE Vector Shape - Star");
    geo.property("ADBE Vector Star Type").setValue(args.shape === "polygon" ? 2 : 1);
    geo.property("ADBE Vector Star Points").setValue(args.points || 5);
    geo.property("ADBE Vector Star Outer Radius").setValue(args.outerRadius || sz[0] / 2);
    if (args.shape === "star") geo.property("ADBE Vector Star Inner Radius").setValue(args.innerRadius || sz[0] / 4);
    break;
  case "path":
    if (!args.vertices) aemcp.fail("shape 'path' requires vertices");
    geo = vecs.addProperty("ADBE Vector Shape - Group");
    var s = new Shape(); s.vertices = args.vertices; if (args.inTangents) s.inTangents = args.inTangents; if (args.outTangents) s.outTangents = args.outTangents; s.closed = args.closed !== false;
    geo.property("ADBE Vector Shape").setValue(s);
    break;
}
if (args.position && geo.property("ADBE Vector Rect Position")) geo.property("ADBE Vector Rect Position").setValue(args.position);
else if (args.position && geo.property("ADBE Vector Ellipse Position")) geo.property("ADBE Vector Ellipse Position").setValue(args.position);
else if (args.position && geo.property("ADBE Vector Star Position")) geo.property("ADBE Vector Star Position").setValue(args.position);
if (args.stroke) { var st = vecs.addProperty("ADBE Vector Graphic - Stroke"); st.property("ADBE Vector Stroke Color").setValue(aemcp.color3(args.stroke)); st.property("ADBE Vector Stroke Width").setValue(args.strokeWidth || 4); }
if (args.fill || !args.stroke) { var fl = vecs.addProperty("ADBE Vector Graphic - Fill"); fl.property("ADBE Vector Fill Color").setValue(aemcp.color3(args.fill || [1,1,1])); }
return { layer: aemcp.layerInfo(l, false), group: aemcp.propInfo(grp, { depth: 2 }) };`,
  },
  {
    name: "ae_add_mask",
    title: "Add mask",
    description: "Add a mask to a layer: rectangle, ellipse, or custom path (layer coordinates).",
    input: {
      comp: compRef,
      layer: layerRef,
      shape: z.enum(["rectangle", "ellipse", "path"]),
      rect: z.array(z.number()).length(4).optional().describe("[left, top, width, height]; default full layer."),
      vertices: z.array(z.array(z.number()).length(2)).optional(),
      inTangents: z.array(z.array(z.number()).length(2)).optional(),
      outTangents: z.array(z.array(z.number()).length(2)).optional(),
      mode: z.enum(["NONE", "ADD", "SUBTRACT", "INTERSECT", "LIGHTEN", "DARKEN", "DIFFERENCE"]).optional(),
      feather: z.number().optional(),
      expansion: z.number().optional(),
      opacity: z.number().optional(),
      inverted: z.boolean().optional(),
      name: z.string().optional(),
    },
    jsx: `
var c = aemcp.findComp(args.comp), l = aemcp.findLayer(c, args.layer);
var m = l.property("ADBE Mask Parade").addProperty("ADBE Mask Atom"), s = new Shape();
var w = l.width || c.width, h = l.height || c.height, r = args.rect || [0, 0, w, h];
if (args.shape === "rectangle") { s.vertices = [[r[0], r[1]], [r[0] + r[2], r[1]], [r[0] + r[2], r[1] + r[3]], [r[0], r[1] + r[3]]]; }
else if (args.shape === "ellipse") {
  var cx = r[0] + r[2] / 2, cy = r[1] + r[3] / 2, rx = r[2] / 2, ry = r[3] / 2, k = 0.5523;
  s.vertices = [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]];
  s.inTangents = [[-rx * k, 0], [0, -ry * k], [rx * k, 0], [0, ry * k]];
  s.outTangents = [[rx * k, 0], [0, ry * k], [-rx * k, 0], [0, -ry * k]];
} else { if (!args.vertices) aemcp.fail("path mask requires vertices"); s.vertices = args.vertices; if (args.inTangents) s.inTangents = args.inTangents; if (args.outTangents) s.outTangents = args.outTangents; }
s.closed = true;
m.property("ADBE Mask Shape").setValue(s);
if (args.mode) m.maskMode = MaskMode[args.mode];
if (args.feather !== undefined) m.property("ADBE Mask Feather").setValue([args.feather, args.feather]);
if (args.expansion !== undefined) m.property("ADBE Mask Offset").setValue(args.expansion);
if (args.opacity !== undefined) m.property("ADBE Mask Opacity").setValue(args.opacity);
if (args.inverted) m.inverted = true;
if (args.name) m.name = args.name;
return aemcp.propInfo(m, { depth: 1 });`,
  },
];
