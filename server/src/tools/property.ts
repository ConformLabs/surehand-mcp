import { z } from "zod";
import { anyValue, compRef, layerRef, propPath, type JsxTool } from "./registry.js";

const easeSchema = z
  .union([z.number(), z.object({ speed: z.number().optional(), influence: z.number().optional() })])
  .describe("Temporal ease: influence % (e.g. 75 = strong easy-ease) or {speed, influence}.");

export const propertyTools: JsxTool[] = [
  {
    name: "ae_get_properties",
    title: "Get properties",
    description:
      "Inspect the property tree of a layer (or a sub-group via path): names, match names, values, keyframe counts, expressions. " +
      "Use this to discover property paths before setting values.",
    input: {
      comp: compRef,
      layer: layerRef,
      path: propPath.optional().describe("Start at this group/property (default: the whole layer)."),
      depth: z.number().int().min(0).max(10).optional().describe("Group depth to expand (default 2)."),
      keyframes: z.boolean().optional().describe("Include keyframe details."),
      includeHidden: z.boolean().optional().describe("Include NO_VALUE properties."),
    },
    readOnly: true,
    jsx: `
var c = aemcp.findComp(args.comp), l = aemcp.findLayer(c, args.layer);
var p = args.path !== undefined ? aemcp.resolveProp(l, args.path) : l;
return aemcp.propInfo(p, { depth: args.depth === undefined ? 2 : args.depth, keyframes: !!args.keyframes, includeHidden: !!args.includeHidden });`,
  },
  {
    name: "ae_find_properties",
    title: "Find properties",
    description:
      "Search every layer of a comp (or one layer) for properties whose name or match name contains the query, e.g. \"opacity\", " +
      "\"blur\", \"Source Text\", \"ADBE Fill Color\". Returns ready-to-use paths. Filter to animated or expression properties.",
    input: {
      comp: compRef,
      query: z.string().optional().describe("Case-insensitive text to match in the property name or match name. Omit to list all matches of the filters."),
      layer: layerRef.optional(),
      onlyAnimated: z.boolean().optional().describe("Only properties with keyframes."),
      onlyExpressions: z.boolean().optional().describe("Only properties with an expression."),
      limit: z.number().int().min(1).max(1000).optional().describe("Default 100."),
    },
    readOnly: true,
    jsx: `
var c = aemcp.findComp(args.comp), out = [], lim = args.limit || 100, q = args.query ? String(args.query).toLowerCase() : null, truncated = false;
if (!q && !args.onlyAnimated && !args.onlyExpressions) aemcp.fail("Give a query, onlyAnimated or onlyExpressions");
function walk(g, layer, path, depth) {
  if (depth > 12) return;
  for (var i = 1; i <= g.numProperties; i++) {
    if (out.length >= lim) { truncated = true; return; }
    var p = g.property(i), pp = path ? path + "/" + p.name : p.name;
    var hit = !q || p.name.toLowerCase().indexOf(q) >= 0 || p.matchName.toLowerCase().indexOf(q) >= 0;
    if (p.propertyType === PropertyType.PROPERTY) {
      if (p.propertyValueType === PropertyValueType.NO_VALUE) continue;
      var expr = false; try { expr = p.canSetExpression && p.expression !== ""; } catch (e) {}
      if (args.onlyAnimated && p.numKeys === 0) continue;
      if (args.onlyExpressions && !expr) continue;
      if (!hit) continue;
      var o = { layer: layer.index, layerName: layer.name, path: pp, matchName: p.matchName, numKeys: p.numKeys };
      try { o.value = aemcp.valueOf(p.value); } catch (e) {}
      if (expr) { o.expression = p.expression; try { o.expressionError = p.expressionError || undefined; } catch (e) {} }
      out.push(o);
    } else walk(p, layer, pp, depth + 1);
  }
}
if (args.layer !== undefined) { var l = aemcp.findLayer(c, args.layer); walk(l, l, "", 0); }
else for (var j = 1; j <= c.numLayers && out.length < lim; j++) walk(c.layer(j), c.layer(j), "", 0);
return { comp: c.name, count: out.length, truncated: truncated, results: out };`,
  },
  {
    name: "ae_set_property",
    title: "Set property value",
    description:
      "Set the value of any property (transform, effect parameter, shape attribute, text...). If `time` is given (or the property already has keyframes) a keyframe is set at that time. " +
      'Examples: path "Transform/Opacity" value 50; "Transform/Position" [960,540]; "Transform/Scale" [50,50]; "Effects/Fill/Color" "#ff0000".',
    input: { comp: compRef, layer: layerRef, path: propPath, value: anyValue, time: z.number().optional() },
    jsx: `
var c = aemcp.findComp(args.comp), l = aemcp.findLayer(c, args.layer), p = aemcp.resolveProp(l, args.path);
if (p.propertyType !== PropertyType.PROPERTY) aemcp.fail("'" + p.name + "' is a group, not a property");
var v = aemcp.toAEValue(p, args.value);
if (args.time !== undefined) p.setValueAtTime(args.time, v);
else if (p.numKeys > 0) p.setValueAtTime(c.time, v);
else p.setValue(v);
return aemcp.propInfo(p, {});`,
  },
  {
    name: "ae_set_keyframes",
    title: "Set keyframes",
    description:
      "Create keyframes on a property in one call, with optional interpolation (linear/bezier/hold) and temporal easing. " +
      'Example: path "Transform/Position", keyframes [{time:0,value:[0,540]},{time:1,value:[960,540],easeIn:80}].',
    input: {
      comp: compRef,
      layer: layerRef,
      path: propPath,
      keyframes: z
        .array(
          z.object({
            time: z.number().describe("Seconds (comp time)."),
            value: anyValue,
            interpolation: z.enum(["linear", "bezier", "hold"]).optional().describe("Both in and out."),
            inInterpolation: z.enum(["linear", "bezier", "hold"]).optional(),
            outInterpolation: z.enum(["linear", "bezier", "hold"]).optional(),
            easeIn: easeSchema.optional(),
            easeOut: easeSchema.optional(),
          }),
        )
        .min(1),
      clearExisting: z.boolean().optional().describe("Remove existing keyframes first."),
      easyEase: z.boolean().optional().describe("Apply easy ease (33%) to all new keyframes that don't specify easing."),
    },
    jsx: `
var c = aemcp.findComp(args.comp), l = aemcp.findLayer(c, args.layer), p = aemcp.resolveProp(l, args.path);
if (!p.canVaryOverTime) aemcp.fail("Property '" + p.name + "' cannot be animated");
if (args.clearExisting) while (p.numKeys > 0) p.removeKey(1);
var times = [], vals = [];
for (var i = 0; i < args.keyframes.length; i++) { times.push(args.keyframes[i].time); vals.push(aemcp.toAEValue(p, args.keyframes[i].value)); }
p.setValuesAtTimes(times, vals);
for (var j = 0; j < args.keyframes.length; j++) {
  var k = args.keyframes[j], idx = p.nearestKeyIndex(k.time);
  var ii = aemcp.interp(k.inInterpolation || k.interpolation), oi = aemcp.interp(k.outInterpolation || k.interpolation);
  if (ii || oi) p.setInterpolationTypeAtKey(idx, ii || p.keyInInterpolationType(idx), oi || p.keyOutInterpolationType(idx));
  var ei = k.easeIn !== undefined ? k.easeIn : (args.easyEase ? 33.333 : undefined);
  var eo = k.easeOut !== undefined ? k.easeOut : (args.easyEase ? 33.333 : undefined);
  if ((ei !== undefined || eo !== undefined) && p.propertyValueType !== PropertyValueType.NO_VALUE) {
    try {
      p.setTemporalEaseAtKey(idx, ei !== undefined ? aemcp.easeArr(p, ei) : p.keyInTemporalEase(idx), eo !== undefined ? aemcp.easeArr(p, eo) : p.keyOutTemporalEase(idx));
    } catch (e) { log("ease not applied at key " + idx + ": " + e.message); }
  }
}
return { property: p.name, numKeys: p.numKeys, keyframes: aemcp.keyframes(p) };`,
  },
  {
    name: "ae_remove_keyframes",
    title: "Remove keyframes",
    description: "Remove keyframes from a property: all of them, or those at specific times.",
    input: { comp: compRef, layer: layerRef, path: propPath, times: z.array(z.number()).optional().describe("Omit to remove all keyframes.") },
    destructive: true,
    jsx: `
var c = aemcp.findComp(args.comp), l = aemcp.findLayer(c, args.layer), p = aemcp.resolveProp(l, args.path), n = 0;
if (!args.times) { var v = p.numKeys ? p.valueAtTime(c.time, true) : null; while (p.numKeys > 0) { p.removeKey(1); n++; } if (v !== null) try { p.setValue(v); } catch (e) {} }
else for (var i = 0; i < args.times.length; i++) { var k = p.nearestKeyIndex(args.times[i]); if (p.numKeys && Math.abs(p.keyTime(k) - args.times[i]) < c.frameDuration / 2) { p.removeKey(k); n++; } }
return { removed: n, remaining: p.numKeys };`,
  },
  {
    name: "ae_set_expression",
    title: "Set expression",
    description: "Set (or clear with an empty string) an expression on a property. Returns any expression error AE reports.",
    input: { comp: compRef, layer: layerRef, path: propPath, expression: z.string(), enabled: z.boolean().optional() },
    jsx: `
var c = aemcp.findComp(args.comp), l = aemcp.findLayer(c, args.layer), p = aemcp.resolveProp(l, args.path);
if (!p.canSetExpression) aemcp.fail("Property '" + p.name + "' cannot have an expression");
p.expression = args.expression;
if (args.enabled !== undefined && args.expression) p.expressionEnabled = args.enabled;
var r = { property: p.name, expression: p.expression, enabled: p.expressionEnabled, error: p.expressionError || null };
try { r.valueNow = aemcp.valueOf(p.valueAtTime(c.time, false)); } catch (e) { r.error = r.error || e.message; }
return r;`,
  },
  {
    name: "ae_get_expressions",
    title: "List expressions",
    description: "List every expression in a comp (or one layer) with errors, useful for debugging expressions.",
    input: { comp: compRef, layer: layerRef.optional() },
    readOnly: true,
    jsx: `
var c = aemcp.findComp(args.comp), out = [];
function walk(g, layer, path) {
  for (var i = 1; i <= g.numProperties; i++) {
    var p = g.property(i), pp = path ? path + "/" + p.name : p.name;
    if (p.propertyType === PropertyType.PROPERTY) { try { if (p.canSetExpression && p.expression) out.push({ layer: layer.index + ": " + layer.name, path: pp, enabled: p.expressionEnabled, expression: p.expression, error: p.expressionError || null }); } catch (e) {} }
    else walk(p, layer, pp);
  }
}
if (args.layer !== undefined) { var l = aemcp.findLayer(c, args.layer); walk(l, l, ""); }
else for (var j = 1; j <= c.numLayers; j++) walk(c.layer(j), c.layer(j), "");
return out;`,
  },
];
