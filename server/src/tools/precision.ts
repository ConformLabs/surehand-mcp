// Precision editing primitives: keyframe tables (frames or seconds, exact ease), copying and auditing easing,
// exact retiming, and layout from measured bounds. Exact numbers throughout: key times, values, speeds and
// influences come back as After Effects stores them (not rounded), and frames are whole numbers with any key
// that sits between frames reported, never silently rounded.
import { z } from "zod";
import { anyValue, compRef, layerRef, propPath, type JsxTool } from "./registry.js";
import { MEASURE_JSX } from "./inspect.js";
import { auditEasing, withCurves, type PropRows } from "./easing.js";

// ---------- shared ExtendScript ----------

/** Frames <-> seconds. Frame n is at n * frameDuration from the comp's time 0. */
export const FRAMES_JSX = `
function specTime(c, o, what) {
  if (o.frame !== undefined && o.frame !== null) return o.frame * c.frameDuration;
  if (o.time !== undefined && o.time !== null) return o.time;
  aemcp.fail((what || "Each key") + " needs frame (whole frames from the comp start) or time (seconds)");
}
function frameOf(c, t) {
  var f = t / c.frameDuration, r = Math.round(f), o = { frame: r };
  if (Math.abs(f - r) > 0.001) o.off = Math.round((f - r) * 10000) / 10000;
  return o;
}
function layerList(c, refs, selectedOnly) {
  var out = [], i;
  if (refs && refs.length) { for (i = 0; i < refs.length; i++) out.push(aemcp.findLayer(c, refs[i])); }
  else if (selectedOnly) { for (i = 0; i < c.selectedLayers.length; i++) out.push(c.selectedLayers[i]); if (!out.length) aemcp.fail("No layers are selected"); }
  else { for (i = 1; i <= c.numLayers; i++) out.push(c.layer(i)); }
  return out;
}`;

/** A key as a table row: every attribute, numbers exactly as After Effects stores them. */
export const KEY_ROW_JSX = `
function exactVal(v) {
  if (typeof v === "number") return v;
  if (v instanceof Array) { var a = []; for (var i = 0; i < v.length; i++) a.push(typeof v[i] === "number" ? v[i] : aemcp.valueOf(v[i])); return a; }
  return aemcp.valueOf(v);
}
function easeRows(list) { var a = []; for (var i = 0; i < list.length; i++) a.push({ speed: list[i].speed, influence: list[i].influence }); return a; }
function interpName(v) { var n = aemcp.enumName(KeyframeInterpolationType, v); return n ? String(n).toLowerCase() : n; }
function keyRow(c, p, k) {
  var t = p.keyTime(k), fr = frameOf(c, t), r = { index: k, frame: fr.frame, time: t };
  if (fr.off !== undefined) r.offFrame = fr.off;
  r.value = exactVal(p.keyValue(k));
  try { r.inInterpolation = interpName(p.keyInInterpolationType(k)); r.outInterpolation = interpName(p.keyOutInterpolationType(k)); } catch (e) {}
  try { r.easeIn = easeRows(p.keyInTemporalEase(k)); r.easeOut = easeRows(p.keyOutTemporalEase(k)); } catch (e) {}
  try { r.temporalContinuous = p.keyTemporalContinuous(k); r.temporalAutoBezier = p.keyTemporalAutoBezier(k); } catch (e) {}
  if (p.isSpatial) {
    try { r.inSpatialTangent = exactVal(p.keyInSpatialTangent(k)); r.outSpatialTangent = exactVal(p.keyOutSpatialTangent(k)); } catch (e) {}
    try { r.spatialContinuous = p.keySpatialContinuous(k); r.spatialAutoBezier = p.keySpatialAutoBezier(k); r.roving = p.keyRoving(k); } catch (e) {}
  }
  try { r.label = p.keyLabel(k); } catch (e) {}
  return r;
}
function propHead(L, p, path, name) {
  var o = { layer: L.index, layerName: L.name, path: path, name: name, matchName: p.matchName, valueType: aemcp.enumName(PropertyValueType, p.propertyValueType), spatial: !!p.isSpatial };
  try { if (p.numKeys) o.easeDimensions = p.keyInTemporalEase(1).length; } catch (e) {}
  try { if (p.expressionEnabled && p.expression) o.expression = true; } catch (e) {}
  return o;
}`;

/**
 * The animated properties of a layer: [{ prop, path, name }]. path: match names, with the 1-based index under
 * indexed groups (effects, masks, shape contents), so it resolves in any AE language and with duplicate names.
 */
export const ANIMATED_JSX = `
function animatedOf(L, out) {
  function walk(g, path, names, isLayer, depth) {
    if (depth > 12) return;
    for (var i = 1; i <= g.numProperties; i++) {
      var p = null; try { p = g.property(i); } catch (e) {}
      if (!p) continue;
      var seg = (!isLayer && g.propertyType === PropertyType.INDEXED_GROUP) ? String(i) : p.matchName;
      var pp = path ? path + "/" + seg : seg, nn = names ? names + "/" + p.name : p.name;
      if (p.propertyType === PropertyType.PROPERTY) {
        var vt = p.propertyValueType;
        if (vt === PropertyValueType.NO_VALUE || vt === PropertyValueType.MARKER) continue;
        if (p.numKeys > 0) out.push({ prop: p, path: pp, name: nn });
      } else walk(p, pp, nn, false, depth + 1);
    }
  }
  walk(L, "", "", true, 0);
  return out;
}
function targetsOf(L, paths) {
  var out = [];
  if (!paths || !paths.length) return animatedOf(L, out);
  for (var i = 0; i < paths.length; i++) {
    var p = aemcp.resolveProp(L, paths[i]), label = paths[i] instanceof Array ? paths[i].join("/") : String(paths[i]);
    if (p.propertyType === PropertyType.PROPERTY) out.push({ prop: p, path: label, name: p.name });
    else { var sub = animatedOf(p, []); for (var j = 0; j < sub.length; j++) out.push({ prop: sub[j].prop, path: label + "/" + sub[j].path, name: p.name + "/" + sub[j].name }); }
  }
  return out;
}`;

/** ExtendScript that reads keyframe tables (ae_get_keyframes, ae_audit_easing). */
export const COLLECT_KEYS_JSX = `${FRAMES_JSX}${KEY_ROW_JSX}${ANIMATED_JSX}
function collect(c, layers, paths, t0, t1, budget, out) {
  for (var i = 0; i < layers.length; i++) {
    var L = layers[i], ts = targetsOf(L, paths);
    for (var j = 0; j < ts.length; j++) {
      var p = ts[j].prop, o = propHead(L, p, ts[j].path, ts[j].name), rows = [];
      for (var k = 1; k <= p.numKeys; k++) {
        var t = p.keyTime(k);
        if ((t0 !== null && t < t0 - 1e-6) || (t1 !== null && t > t1 + 1e-6)) continue;
        if (budget.n >= budget.max) { budget.truncated = true; break; }
        var row = keyRow(c, p, k);
        if (row.offFrame !== undefined) budget.off++;
        rows.push(row); budget.n++;
      }
      o.keys = rows;
      if (out.length < 2000) out.push(o); else budget.truncated = true;
    }
  }
  return out;
}`;

// ---------- schemas ----------

const easeObj = z.object({ speed: z.number().describe("Property units per second (px/s for Position, %/s for Opacity, degrees/s for Rotation)."), influence: z.number().min(0.1).max(100).describe("0.1-100 (%).") });
const exactEase = z
  .union([easeObj, z.array(easeObj).min(1).max(3)])
  .describe(
    "Temporal ease, exactly: {speed, influence} for every dimension, or one per dimension. The count per key is fixed by After Effects: " +
      "2 for 2D and 3 for 3D values (Scale), 1 for everything else, including spatial properties (Position, Anchor Point: speed along the motion path) and colors.",
  );
const interp = z.enum(["linear", "bezier", "hold"]);
const tangent = z.array(z.number()).min(2).max(3);
const keyAt = {
  frame: z.number().int().optional().describe("Whole frame number from the comp's start (frame 0 = time 0)."),
  time: z.number().optional().describe("Seconds, instead of frame."),
};

const tableKey = z.object({
  ...keyAt,
  value: anyValue.optional().describe("Value at this key. Omit to change only the attributes of a key that already exists there."),
  interpolation: interp.optional().describe("In and out."),
  inInterpolation: interp.optional(),
  outInterpolation: interp.optional(),
  easeIn: exactEase.optional(),
  easeOut: exactEase.optional(),
  temporalContinuous: z.boolean().optional(),
  temporalAutoBezier: z.boolean().optional().describe("true makes After Effects recalculate the ease, replacing easeIn/easeOut."),
  inSpatialTangent: tangent.optional().describe("Spatial properties only: incoming motion-path handle, relative to the key (pixels)."),
  outSpatialTangent: tangent.optional(),
  spatialContinuous: z.boolean().optional(),
  spatialAutoBezier: z.boolean().optional(),
  roving: z.boolean().optional().describe("Spatial properties only; not on the first or last key."),
  label: z.number().int().min(0).max(16).optional(),
});

const layerSel = {
  layers: z.array(layerRef).optional().describe("Layers (default: every layer of the comp)."),
  selectedOnly: z.boolean().optional().describe("Only the layers selected in After Effects."),
};

// ---------- tools ----------

export const precisionTools: JsxTool[] = [
  {
    name: "ae_get_keyframes",
    title: "Keyframe table",
    description:
      "Read keyframes as a table across many layers and properties in one call: for every key its whole frame number AND exact time in seconds, " +
      "exact value, in/out interpolation, temporal ease per dimension (speed in the property's units per second, influence %) exactly as After Effects stores them, " +
      "continuous/auto-Bezier, spatial tangents and roving (spatial properties), label. A key that is not on a whole frame is flagged with offFrame (fraction of a frame). " +
      "curves: true adds, per segment between keys, the normalised curve (cubic-bezier x1,y1,x2,y2 per dimension; along the path for spatial properties). " +
      "The output's properties[] can be edited and written back with ae_set_keyframe_table.",
    input: {
      comp: compRef,
      ...layerSel,
      paths: z.array(propPath).optional().describe("Properties or groups to read on each layer (default: every animated property). The returned paths resolve in any AE language."),
      startFrame: z.number().int().optional().describe("Only keys at or after this frame."),
      endFrame: z.number().int().optional().describe("Only keys at or before this frame."),
      curves: z.boolean().optional().describe("Add the normalised curve numbers of every segment."),
      maxKeys: z.number().int().min(1).max(20000).optional().describe("Stop after this many keys (default 5000)."),
    },
    readOnly: true,
    jsx: `${COLLECT_KEYS_JSX}
var c = aemcp.findComp(args.comp), fd = c.frameDuration;
var budget = { n: 0, max: args.maxKeys || 5000, off: 0, truncated: false };
var props = collect(c, layerList(c, args.layers, args.selectedOnly), args.paths, args.startFrame === undefined ? null : args.startFrame * fd, args.endFrame === undefined ? null : args.endFrame * fd, budget, []);
var r = { comp: c.name, frameRate: c.frameRate, frameDuration: fd, properties: props, keys: budget.n };
if (budget.off) r.offFrameKeys = budget.off;
if (budget.truncated) r.truncated = "more keys than maxKeys: narrow layers/paths/frames or raise maxKeys";
return r;`,
    format: (result, args) => JSON.stringify(args.curves ? withCurves(result as { properties: PropRows[] }) : result),
  },
  {
    name: "ae_set_keyframe_table",
    title: "Write keyframe table",
    description:
      "Write keyframes on many properties and layers in one call (one undo step), with every attribute exact: keys at whole frames or at times in seconds, " +
      "values, interpolation, temporal ease per dimension ({speed, influence} as in the Graph Editor), continuous/auto-Bezier, spatial tangents, roving, labels. " +
      "The input matches ae_get_keyframes' output, so a table can be read, edited and written back. Existing keys at the same time are updated; " +
      "replace: true clears the property's keys first. Ease must have the dimension count After Effects uses for that property (see easeIn), else the call fails " +
      "before anything is written to that property. Returns the resulting keys.",
    input: {
      comp: compRef,
      properties: z
        .array(
          z.object({
            comp: z.union([z.number().int(), z.string()]).optional().describe("Other comp for this entry (default: comp)."),
            layer: layerRef,
            path: propPath,
            replace: z.boolean().optional().describe("Remove this property's existing keys first."),
            keys: z.array(tableKey).min(1),
          }),
        )
        .min(1)
        .max(500),
    },
    destructive: true,
    idempotent: true,
    jsx: `${FRAMES_JSX}${KEY_ROW_JSX}
function checkInf(p, v) { if (!(v >= 0.1 && v <= 100)) aemcp.fail("Influence must be 0.1-100 (%) on '" + p.name + "', got " + v); return v; }
function easeFor(p, idx, e, side) {
  var cur = side === "in" ? p.keyInTemporalEase(idx) : p.keyOutTemporalEase(idx), n = cur.length, a = [], i;
  if (e instanceof Array) {
    if (e.length !== n) aemcp.fail("'" + p.name + "' takes " + n + " ease value" + (n === 1 ? "" : "s") + " per key side (" + (p.isSpatial ? "a spatial property: one ease along the motion path" : (n === 1 ? "one for this value type" : "one per dimension")) + "), got " + e.length);
    for (i = 0; i < n; i++) a.push(new KeyframeEase(e[i].speed, checkInf(p, e[i].influence)));
  } else { for (i = 0; i < n; i++) a.push(new KeyframeEase(e.speed, checkInf(p, e.influence))); }
  return a;
}
function pad(v, n) { var a = v.slice(0); while (a.length < n) a.push(0); return a.slice(0, n); }
function applyKey(p, idx, k) {
  var ii = aemcp.interp(k.inInterpolation || k.interpolation), oi = aemcp.interp(k.outInterpolation || k.interpolation);
  if (ii || oi) p.setInterpolationTypeAtKey(idx, ii || p.keyInInterpolationType(idx), oi || p.keyOutInterpolationType(idx));
  if (k.temporalContinuous !== undefined) p.setTemporalContinuousAtKey(idx, k.temporalContinuous);
  if (k.temporalAutoBezier !== undefined) p.setTemporalAutoBezierAtKey(idx, k.temporalAutoBezier);
  if (k.easeIn !== undefined || k.easeOut !== undefined)
    p.setTemporalEaseAtKey(idx, k.easeIn !== undefined ? easeFor(p, idx, k.easeIn, "in") : p.keyInTemporalEase(idx), k.easeOut !== undefined ? easeFor(p, idx, k.easeOut, "out") : p.keyOutTemporalEase(idx));
  var spatial = k.inSpatialTangent || k.outSpatialTangent || k.spatialContinuous !== undefined || k.spatialAutoBezier !== undefined || k.roving !== undefined;
  if (spatial && !p.isSpatial) aemcp.fail("'" + p.name + "' is not a spatial property: spatial tangents, spatial continuous/auto-Bezier and roving don't apply");
  if (p.isSpatial) {
    if (k.spatialContinuous !== undefined) p.setSpatialContinuousAtKey(idx, k.spatialContinuous);
    if (k.spatialAutoBezier !== undefined) p.setSpatialAutoBezierAtKey(idx, k.spatialAutoBezier);
    if (k.inSpatialTangent || k.outSpatialTangent) {
      var dims = p.keyValue(idx).length; // After Effects wants as many values as the property has (3 for Position, also in 2D)
      p.setSpatialTangentsAtKey(idx, k.inSpatialTangent ? pad(k.inSpatialTangent, dims) : p.keyInSpatialTangent(idx), k.outSpatialTangent ? pad(k.outSpatialTangent, dims) : p.keyOutSpatialTangent(idx));
    }
  }
  if (k.label !== undefined) p.setLabelAtKey(idx, k.label);
}
var c0 = aemcp.findComp(args.comp), out = [];
for (var i = 0; i < args.properties.length; i++) {
  var spec = args.properties[i], c = spec.comp !== undefined ? aemcp.findComp(spec.comp) : c0;
  var L = aemcp.findLayer(c, spec.layer), p = aemcp.resolveProp(L, spec.path), where = "'" + L.name + "' > " + (spec.path instanceof Array ? spec.path.join("/") : spec.path);
  if (p.propertyType !== PropertyType.PROPERTY) aemcp.fail(where + " is a group, not a property");
  if (!p.canVaryOverTime) aemcp.fail(where + " can't be animated");
  // times first: duplicates and keys to change that don't exist fail before this property is touched
  var times = [], seen = {};
  for (var j = 0; j < spec.keys.length; j++) {
    var t = specTime(c, spec.keys[j], "Each key of " + where), tk = "t" + Math.round(t / c.frameDuration * 1000);
    if (seen[tk]) aemcp.fail(where + ": two keys at the same time (" + t + "s, frame " + frameOf(c, t).frame + ")");
    seen[tk] = true; times.push(t);
    if (spec.keys[j].value === undefined && (spec.replace || !p.numKeys || Math.abs(p.keyTime(p.nearestKeyIndex(t)) - t) > 0.0005))
      aemcp.fail(where + ": no keyframe at frame " + frameOf(c, t).frame + " (" + t + "s) to change; give a value to create one");
  }
  if (spec.replace) while (p.numKeys) p.removeKey(1);
  for (var v = 0; v < spec.keys.length; v++) if (spec.keys[v].value !== undefined) p.setValueAtTime(times[v], aemcp.toAEValue(p, spec.keys[v].value));
  // attributes once every key exists (roving needs its neighbours); roving last
  var idxs = [];
  for (var a = 0; a < spec.keys.length; a++) { idxs.push(p.nearestKeyIndex(times[a])); applyKey(p, idxs[a], spec.keys[a]); }
  for (var rv = 0; rv < spec.keys.length; rv++) if (spec.keys[rv].roving !== undefined) {
    try { p.setRovingAtKey(p.nearestKeyIndex(times[rv]), spec.keys[rv].roving); }
    catch (e) { aemcp.fail(where + ": roving can't be set on the key at frame " + frameOf(c, times[rv]).frame + " (" + e.message + "); the first and last keys can't rove"); }
  }
  var rows = []; for (var q = 1; q <= p.numKeys; q++) rows.push(keyRow(c, p, q));
  out.push({ comp: c.name, layer: L.index, layerName: L.name, path: spec.path, numKeys: p.numKeys, keys: rows });
}
return { properties: out };`,
  },
  {
    name: "ae_copy_ease",
    title: "Copy easing",
    description:
      "Copy the exact easing of one reference keyframe onto keys of other properties and layers: temporal ease (speed + influence), interpolation types, " +
      "temporal continuous/auto-Bezier, and optionally spatial tangents. Dimension rule: same ease count -> copied per dimension; a reference with 1 ease -> " +
      "used for every target dimension; otherwise pass sourceDimension (0-based) and that one ease goes to every target dimension. Speed is in the " +
      "property's units per second, so copying it between properties of different units (Opacity %/s to Position px/s) rarely makes sense: use speed \"keep\" " +
      "(only the influence and interpolation are copied) or \"zero\". Returns the reference numbers and every changed key's ease before and after.",
    input: {
      from: z
        .object({
          comp: z.union([z.number().int(), z.string()]).optional(),
          layer: layerRef,
          path: propPath,
          key: z.number().int().min(1).optional().describe("Key index (1-based)."),
          ...keyAt,
        })
        .describe("The reference key: by key index, frame or time."),
      to: z
        .array(
          z.object({
            comp: z.union([z.number().int(), z.string()]).optional(),
            layer: layerRef,
            path: propPath,
            keys: z.array(z.number().int().min(1)).optional().describe("Key indices (default: every key)."),
            frames: z.array(z.number().int()).optional().describe("Keys at these whole frames."),
          }),
        )
        .min(1)
        .max(500),
      which: z.enum(["in", "out", "both"]).optional().describe("Which side of the keys (default both)."),
      speed: z.enum(["copy", "keep", "zero"]).optional().describe('"copy" the reference speed (default), "keep" each target key\'s own speed, or set it to 0.'),
      interpolation: z.boolean().optional().describe("Also copy in/out interpolation and temporal continuous/auto-Bezier (default true)."),
      spatial: z.boolean().optional().describe("Also copy spatial tangents and spatial continuous/auto-Bezier (spatial properties only; default false)."),
      sourceDimension: z.number().int().min(0).max(2).optional().describe("Reference dimension to use when the ease counts differ."),
    },
    idempotent: true,
    jsx: `${FRAMES_JSX}${KEY_ROW_JSX}
function keyIdx(c, p, o, where) {
  if (!p.numKeys) aemcp.fail(where + " has no keyframes");
  if (o.key !== undefined) { if (o.key > p.numKeys) aemcp.fail(where + ": key " + o.key + " out of range 1-" + p.numKeys); return o.key; }
  var t = specTime(c, o, "The reference"), i = p.nearestKeyIndex(t);
  if (Math.abs(p.keyTime(i) - t) > 0.0005) aemcp.fail(where + ": no keyframe at frame " + frameOf(c, t).frame + " (" + t + "s)");
  return i;
}
var which = args.which || "both", spd = args.speed || "copy", sd = args.sourceDimension;
var sc = aemcp.findComp(args.from.comp), sL = aemcp.findLayer(sc, args.from.layer), sp = aemcp.resolveProp(sL, args.from.path);
var sWhere = "'" + sL.name + "' > " + sp.name, si = keyIdx(sc, sp, args.from, sWhere);
var src = { inEase: sp.keyInTemporalEase(si), outEase: sp.keyOutTemporalEase(si), inI: sp.keyInInterpolationType(si), outI: sp.keyOutInterpolationType(si) };
try { src.tc = sp.keyTemporalContinuous(si); src.tab = sp.keyTemporalAutoBezier(si); } catch (e) {}
if (args.spatial) {
  if (!sp.isSpatial) aemcp.fail(sWhere + " is not a spatial property: there are no spatial tangents to copy");
  src.inTan = sp.keyInSpatialTangent(si); src.outTan = sp.keyOutSpatialTangent(si); src.sc = sp.keySpatialContinuous(si); src.sab = sp.keySpatialAutoBezier(si);
}
if (sd !== undefined && sd >= src.inEase.length) aemcp.fail("sourceDimension " + sd + " doesn't exist: the reference key has " + src.inEase.length + " ease value(s)");
function mapEase(list, cur, where) {
  var n = list.length, m = cur.length, a = [];
  if (n !== m && n !== 1 && sd === undefined)
    aemcp.fail("The reference key has " + n + " ease values per side, " + where + " has " + m + ": pass sourceDimension (0-" + (n - 1) + ") to copy one reference dimension to every target dimension");
  for (var i = 0; i < m; i++) {
    var s = n === m && sd === undefined ? list[i] : list[n === 1 ? 0 : sd];
    a.push(new KeyframeEase(spd === "copy" ? s.speed : (spd === "keep" ? cur[i].speed : 0), s.influence));
  }
  return a;
}
var out = [];
for (var i = 0; i < args.to.length; i++) {
  var T = args.to[i], tc = T.comp !== undefined ? aemcp.findComp(T.comp) : sc, L = aemcp.findLayer(tc, T.layer), p = aemcp.resolveProp(L, T.path);
  var where = "'" + L.name + "' > " + p.name;
  if (p.propertyType !== PropertyType.PROPERTY || !p.numKeys) aemcp.fail(where + " has no keyframes");
  if (args.spatial && !p.isSpatial) aemcp.fail(where + " is not a spatial property: spatial tangents can't be copied to it (leave spatial off for this target)");
  var ks = [];
  if (T.keys) { for (var a = 0; a < T.keys.length; a++) { if (T.keys[a] > p.numKeys) aemcp.fail(where + ": key " + T.keys[a] + " out of range 1-" + p.numKeys); ks.push(T.keys[a]); } }
  else if (T.frames) { for (var b = 0; b < T.frames.length; b++) ks.push(keyIdx(tc, p, { frame: T.frames[b] }, where)); }
  else { for (var k = 1; k <= p.numKeys; k++) ks.push(k); }
  var changed = [];
  for (var j = 0; j < ks.length; j++) {
    var idx = ks[j], before = { easeIn: easeRows(p.keyInTemporalEase(idx)), easeOut: easeRows(p.keyOutTemporalEase(idx)) };
    if (args.interpolation !== false) {
      p.setInterpolationTypeAtKey(idx, which === "out" ? p.keyInInterpolationType(idx) : src.inI, which === "in" ? p.keyOutInterpolationType(idx) : src.outI);
      if (src.tc !== undefined) { try { p.setTemporalContinuousAtKey(idx, src.tc); p.setTemporalAutoBezierAtKey(idx, src.tab); } catch (e) {} }
    }
    var curIn = p.keyInTemporalEase(idx), curOut = p.keyOutTemporalEase(idx);
    p.setTemporalEaseAtKey(idx, which === "out" ? curIn : mapEase(src.inEase, curIn, where), which === "in" ? curOut : mapEase(src.outEase, curOut, where));
    if (args.spatial) {
      var dims = p.keyValue(idx).length, padT = function (v) { var x = v.slice(0); while (x.length < dims) x.push(0); return x.slice(0, dims); };
      p.setSpatialTangentsAtKey(idx, which === "out" ? p.keyInSpatialTangent(idx) : padT(src.inTan), which === "in" ? p.keyOutSpatialTangent(idx) : padT(src.outTan));
      p.setSpatialContinuousAtKey(idx, src.sc); p.setSpatialAutoBezierAtKey(idx, src.sab);
    }
    var row = keyRow(tc, p, idx);
    changed.push({ index: idx, frame: row.frame, before: before, after: { easeIn: row.easeIn, easeOut: row.easeOut, inInterpolation: row.inInterpolation, outInterpolation: row.outInterpolation } });
  }
  out.push({ comp: tc.name, layer: L.index, layerName: L.name, path: T.path, keys: changed });
}
var ref = keyRow(sc, sp, si);
if (src.tab) log("The reference key is temporal auto-Bezier: After Effects recalculates its ease from the neighbouring keys, so targets that copy auto-Bezier will too.");
return { reference: { layer: sL.name, property: sp.name, key: si, frame: ref.frame, easeIn: ref.easeIn, easeOut: ref.easeOut, inInterpolation: ref.inInterpolation, outInterpolation: ref.outInterpolation }, targets: out };`,
  },
  {
    name: "ae_audit_easing",
    title: "Easing consistency audit",
    description:
      "Motion consistency audit against the project's OWN norms (no external standard): measures the normalised curve of every animated segment " +
      "(cubic-bezier numbers from the exact speed/influence and the value change; along the motion path for spatial properties), finds the curves this " +
      "comp uses most (overall and per property type), and lists the segments that match none of them, with layer, frames, exact ease numbers and the " +
      "nearest norm. Also counts linear and hold segments. Read-only. To fix an outlier, copy a conforming key's ease with ae_copy_ease.",
    input: {
      comp: compRef,
      ...layerSel,
      comps: z.array(z.union([z.number().int(), z.string()])).max(50).optional().describe("Audit several comps together (instead of comp)."),
      tolerance: z.number().min(0.001).max(0.5).optional().describe("Max difference per curve number to count as the same curve (default 0.05)."),
      minShare: z.number().min(0).max(1).optional().describe("Share of segments a curve needs to count as a norm (default 0.1)."),
      maxKeys: z.number().int().min(1).max(50000).optional().describe("Default 20000."),
    },
    readOnly: true,
    jsx: `${COLLECT_KEYS_JSX}
var cs = [], all = [], budget = { n: 0, max: args.maxKeys || 20000, off: 0, truncated: false };
if (args.comps && args.comps.length) { for (var i = 0; i < args.comps.length; i++) cs.push(aemcp.findComp(args.comps[i])); } else cs.push(aemcp.findComp(args.comp));
for (var j = 0; j < cs.length; j++) {
  var props = collect(cs[j], layerList(cs[j], cs.length > 1 ? null : args.layers, cs.length > 1 ? false : args.selectedOnly), null, null, null, budget, []);
  for (var k = 0; k < props.length; k++) { props[k].comp = cs[j].name; all.push(props[k]); }
}
var names = []; for (var q = 0; q < cs.length; q++) names.push(cs[q].name);
return { comps: names, properties: all, keys: budget.n, truncated: budget.truncated };`,
    format: (result, args) => {
      const r = result as { comps: string[]; properties: PropRows[]; keys: number; truncated: boolean };
      const audit = auditEasing(r.properties, { tolerance: args.tolerance as number | undefined, minShare: args.minShare as number | undefined });
      return JSON.stringify({ comps: r.comps, keys: r.keys, ...(r.truncated ? { truncated: "more keys than maxKeys: not every key was audited" } : {}), ...audit });
    },
  },
  {
    name: "ae_retime_keyframes",
    title: "Retime keyframes",
    description:
      "Exact timing changes on keyframes, landing on whole frames: " +
      "scale (stretch/compress timing by factor, or to durationFrames, around an anchor: the first/last key or anchorFrame), " +
      "offset (shift by N frames), stagger (shift layer i by i x N frames in layer order: the order given, by index, or reversed), " +
      "conform (change the comp's frame rate and move every key, layer start/in/out point to the nearest whole frame of the new rate). " +
      "keepCurves (default true) rescales each key's ease speeds by how much its segments were stretched, so the curves keep their exact shape. " +
      "Two keys of a property landing on the same frame is refused before anything changes. move: \"layers\" (offset/stagger) shifts the layers in time " +
      "instead of their keys. Applies to all keys of the chosen properties (default: every animated property of the chosen layers). " +
      "Reports how far keys were rounded to reach whole frames.",
    input: {
      comp: compRef,
      mode: z.enum(["scale", "offset", "stagger", "conform"]),
      ...layerSel,
      paths: z.array(propPath).optional().describe("Properties or groups on each layer (default: every animated property)."),
      factor: z.number().positive().optional().describe("scale: 2 = twice as long, 0.5 = twice as fast."),
      durationFrames: z.number().int().positive().optional().describe("scale: make the span from the first to the last key this many frames (instead of factor)."),
      anchor: z.enum(["first", "last"]).optional().describe("scale: the key time that stays put (default first)."),
      anchorFrame: z.number().int().optional().describe("scale: a frame that stays put (instead of anchor)."),
      frames: z.number().int().optional().describe("offset: frames to shift by (negative = earlier); stagger: frames between consecutive layers."),
      order: z.enum(["given", "index", "reverse"]).optional().describe("stagger: layer order (default: the order of layers, else by index)."),
      move: z.enum(["keys", "layers"]).optional().describe("offset/stagger: shift the keys (default) or the layers' start times."),
      frameRate: z.number().positive().max(999).optional().describe("conform: the new frame rate."),
      snap: z.boolean().optional().describe("Round new key times to whole frames (default true)."),
      keepCurves: z.boolean().optional().describe("Rescale ease speeds so each segment keeps its curve (default true)."),
    },
    jsx: `${FRAMES_JSX}${ANIMATED_JSX}
var c = aemcp.findComp(args.comp), fd = c.frameDuration, mode = args.mode, snap = args.snap !== false, keep = args.keepCurves !== false;
var newFd = fd;
if (mode === "conform") { if (!args.frameRate) aemcp.fail("conform needs frameRate"); newFd = 1 / args.frameRate; }
var layers = mode === "conform" ? layerList(c, null, false) : layerList(c, args.layers, args.selectedOnly);
if (mode === "stagger" || mode === "offset") { if (args.frames === undefined) aemcp.fail(mode + " needs frames"); }
if (mode === "stagger") {
  var ord = args.order || (args.layers && args.layers.length ? "given" : "index");
  if (ord !== "given") { layers.sort(function (a, b) { return a.index - b.index; }); if (ord === "reverse") layers.reverse(); }
}
var round = { n: 0, max: 0 };
function place(t) {
  if (!snap) return t;
  var s = Math.round(t / newFd) * newFd, d = Math.abs(s - t) / newFd;
  if (d > 1e-6) { round.n++; if (d > round.max) round.max = d; }
  return s;
}
// layers instead of keys: offset/stagger move: "layers"
if ((mode === "offset" || mode === "stagger") && args.move === "layers") {
  var moved = [];
  for (var m = 0; m < layers.length; m++) {
    var sh = (mode === "offset" ? args.frames : m * args.frames) * fd;
    if (!sh) continue;
    if (layers[m].locked) aemcp.fail("Layer '" + layers[m].name + "' is locked");
    layers[m].startTime = layers[m].startTime + sh;
    moved.push({ layer: layers[m].index, name: layers[m].name, shiftFrames: Math.round(sh / fd), startFrame: frameOf(c, layers[m].startTime).frame });
  }
  return { mode: mode, moved: "layers", layers: moved };
}
// every property's keys with their new times, checked before anything changes
var jobs = [], all = [];
for (var i = 0; i < layers.length; i++) {
  var ts = mode === "conform" ? animatedOf(layers[i], []) : targetsOf(layers[i], args.paths);
  for (var j = 0; j < ts.length; j++) { jobs.push({ L: layers[i], li: i, prop: ts[j].prop, path: ts[j].path }); for (var k = 1; k <= ts[j].prop.numKeys; k++) all.push(ts[j].prop.keyTime(k)); }
}
if (!jobs.length && mode !== "conform") aemcp.fail("No keyframes on the chosen layers/properties");
var anchor = 0, factor = 1;
if (mode === "scale") {
  var t0 = Math.min.apply(null, all), t1 = Math.max.apply(null, all);
  if (args.durationFrames !== undefined) { if (t1 <= t0) aemcp.fail("durationFrames needs keys at two different times"); factor = args.durationFrames * fd / (t1 - t0); }
  else if (args.factor !== undefined) factor = args.factor;
  else aemcp.fail("scale needs factor or durationFrames");
  anchor = args.anchorFrame !== undefined ? args.anchorFrame * fd : (args.anchor === "last" ? t1 : t0);
}
function mapTime(t, li) {
  if (mode === "scale") return anchor + (t - anchor) * factor;
  if (mode === "offset") return t + args.frames * fd;
  if (mode === "stagger") return t + li * args.frames * fd;
  return t; // conform: same time, on the new rate's frames
}
for (var q = 0; q < jobs.length; q++) {
  var J = jobs[q], p = J.prop, olds = [], news = [];
  for (var kk = 1; kk <= p.numKeys; kk++) { olds.push(p.keyTime(kk)); news.push(place(mapTime(p.keyTime(kk), J.li))); }
  for (var s = 1; s < news.length; s++) if (news[s] - news[s - 1] < newFd / 2)
    aemcp.fail("Keys " + s + " and " + (s + 1) + " of '" + J.L.name + "' > " + p.name + " would land on the same frame (" + Math.round(news[s] / newFd) + "). Nothing was changed. Use a larger factor or frame rate.");
  if (J.L.locked) aemcp.fail("Layer '" + J.L.name + "' is locked. Nothing was changed.");
  J.olds = olds; J.news = news;
}
// apply: capture every key, remove them, add them back at the new times, then their attributes (roving last)
if (mode === "conform") c.frameRate = args.frameRate;
var report = [];
for (var w = 0; w < jobs.length; w++) {
  var J2 = jobs[w], P = J2.prop, caps = [], n = P.numKeys, changed = false;
  for (var a = 1; a <= n; a++) caps.push(aemcp.captureKey(P, a));
  for (var e = 0; e < n; e++) if (Math.abs(J2.news[e] - J2.olds[e]) > 1e-9) changed = true;
  if (!changed) continue;
  if (keep) {
    // a key's out-speed belongs to the segment after it, its in-speed to the one before: scale each by its own stretch
    var scaleEase = function (list, ratio) { var r = []; for (var x = 0; x < list.length; x++) r.push(new KeyframeEase(list[x].speed * ratio, list[x].influence)); return r; };
    for (var g = 0; g < n; g++) {
      var d = caps[g];
      if (!d.inEase) continue;
      if (g > 0) { var dOld = J2.olds[g] - J2.olds[g - 1], dNew = J2.news[g] - J2.news[g - 1]; d.inEase = scaleEase(d.inEase, dNew > 0 ? dOld / dNew : 1); }
      if (g < n - 1) { var oOld = J2.olds[g + 1] - J2.olds[g], oNew = J2.news[g + 1] - J2.news[g]; d.outEase = scaleEase(d.outEase, oNew > 0 ? oOld / oNew : 1); }
    }
  }
  while (P.numKeys) P.removeKey(P.numKeys);
  var rov = [];
  for (var h = 0; h < n; h++) { var kidx = P.addKey(J2.news[h]); P.setValueAtKey(kidx, caps[h].value); }
  for (var u = 0; u < n; u++) { var cap = caps[u]; rov.push(!!cap.roving); cap.roving = false; aemcp.applyKeyAttrs(P, P.nearestKeyIndex(J2.news[u]), cap); }
  for (var rr = 0; rr < n; rr++) if (rov[rr]) { try { P.setRovingAtKey(P.nearestKeyIndex(J2.news[rr]), true); } catch (er) {} }
  var firstOld = Math.round(J2.olds[0] / fd), firstNew = Math.round(J2.news[0] / newFd), lastNew = Math.round(J2.news[n - 1] / newFd);
  report.push({ layer: J2.L.index, layerName: J2.L.name, path: J2.path, keys: n, firstFrame: firstOld + " -> " + firstNew, lastFrame: Math.round(J2.olds[n - 1] / fd) + " -> " + lastNew });
}
var res = { mode: mode, properties: report.length, changed: report };
if (mode === "scale") { res.factor = factor; res.anchorFrame = Math.round(anchor / fd); }
if (mode === "conform") {
  // layers' timing on whole frames of the new rate
  var snapped = [];
  for (var y = 0; y < layers.length; y++) {
    var Ly = layers[y], ip = Ly.inPoint, op = Ly.outPoint, st = Ly.startTime, nst = Math.round(st / newFd) * newFd;
    if (Ly.locked) continue;
    var sip = Math.round(ip / newFd) * newFd, sop = Math.round(op / newFd) * newFd;
    if (Math.abs(nst - st) > 1e-9 || Math.abs(sip - ip) > 1e-9 || Math.abs(sop - op) > 1e-9) {
      try { Ly.startTime = nst; Ly.inPoint = sip; Ly.outPoint = sop; snapped.push(Ly.name); } catch (ey) { log("Layer '" + Ly.name + "': timing not snapped (" + ey.message + ")"); }
    }
  }
  res.frameRate = c.frameRate; res.layersSnapped = snapped;
  log("Nested precomps keep their own frame rates; conform them separately if needed.");
}
if (round.n) res.rounded = { keys: round.n, maxFrames: Math.round(round.max * 10000) / 10000, note: "new times rounded to the nearest whole frame" };
return res;`,
  },
  {
    name: "ae_align_layers",
    title: "Align and distribute (measured)",
    description:
      "Align, distribute or centre layers by their REAL on-screen bounds at a time (the same measurement as ae_get_layer_bounds: sourceRectAtTime through " +
      "all transforms and parents, so text is aligned by its glyph box and scaled/rotated/parented layers by what you see), not by anchor points. " +
      "align: left/right/top/bottom/hcenter/vcenter/center to the selection's combined box (default with 2+ layers), the comp, the title/action-safe area, " +
      "another layer, or a point {x, y}. distribute: horizontal/vertical with equal gaps (default), equal centre spacing, or a fixed gap in pixels; " +
      "the outermost layers stay put. Moves Position (or X/Y Position when separated) in the parent's space; keyframed Position moves every key by the same amount. " +
      "3D layers (or layers with a 3D parent), locked layers and Position with an expression are left alone and listed. Reports bounds after the move and any residual.",
    input: {
      comp: compRef,
      ...layerSel,
      time: z.number().optional().describe("Seconds at which to measure (default: the comp's current time)."),
      frame: z.number().int().optional().describe("Whole frame at which to measure, instead of time."),
      align: z.enum(["left", "right", "top", "bottom", "hcenter", "vcenter", "center"]).optional(),
      to: z
        .union([z.enum(["selection", "comp", "titleSafe", "actionSafe"]), z.object({ layer: layerRef }), z.object({ x: z.number().optional(), y: z.number().optional() })])
        .optional()
        .describe('What to align to (default "selection" for 2+ layers, else "comp"). A point aligns the chosen edge or centre to that x / y in comp pixels.'),
      distribute: z.enum(["horizontal", "vertical"]).optional(),
      by: z.enum(["gaps", "centers"]).optional().describe("distribute: equal gaps between the boxes (default) or equal centre spacing."),
      spacing: z.number().optional().describe("distribute: a fixed gap in pixels between boxes, starting from the first (leftmost/topmost) layer."),
      includeExtents: z.boolean().optional().describe("Measure with strokes and effect extents (default false)."),
      dryRun: z.boolean().optional().describe("Only report the planned moves."),
    },
    idempotent: true,
    jsx: `${MEASURE_JSX}
var c = aemcp.findComp(args.comp), t = args.frame !== undefined ? args.frame * c.frameDuration : (args.time === undefined ? c.time : args.time);
if (!args.align && !args.distribute) aemcp.fail("Give align and/or distribute");
var layers = [], i;
if (args.layers && args.layers.length) { for (i = 0; i < args.layers.length; i++) layers.push(aemcp.findLayer(c, args.layers[i])); }
else if (args.selectedOnly) { for (i = 0; i < c.selectedLayers.length; i++) layers.push(c.selectedLayers[i]); }
if (!layers.length) aemcp.fail("Give layers (or selectedOnly with layers selected)");
var dAxis = args.distribute === "horizontal" ? "x" : (args.distribute === "vertical" ? "y" : null);
var aAxis = args.align === "left" || args.align === "right" || args.align === "hcenter" ? "x" : (args.align === "center" ? "xy" : (args.align ? "y" : null));
if (dAxis && aAxis && aAxis.indexOf(dAxis) >= 0) aemcp.fail("align " + args.align + " and distribute " + args.distribute + " work on the same axis: choose one, or align on the other axis");
var to = args.to || (layers.length > 1 ? "selection" : "comp"), idx = [], refLayer = null;
for (i = 0; i < layers.length; i++) idx.push(layers[i].index);
if (to && typeof to === "object" && to.layer !== undefined) { refLayer = aemcp.findLayer(c, to.layer); idx.push(refLayer.index); }
var m = measureLayers(c, idx, t, !!args.includeExtents), items = [], skipped = [];
for (i = 0; i < layers.length; i++) {
  var L = layers[i], b = m["i" + L.index];
  if (!b || b.err) { skipped.push({ layer: L.index, name: L.name, why: "no bounds (" + (b ? b.err : "not measured") + ")" }); continue; }
  if (b.x1 - b.x0 === 0 && b.y1 - b.y0 === 0) { skipped.push({ layer: L.index, name: L.name, why: "empty at this time" }); continue; }
  items.push({ L: L, b: b, dx: 0, dy: 0 });
}
if (!items.length) aemcp.fail("None of the layers could be measured");
var W = c.width, H = c.height, ref;
if (refLayer) { var rb = m["i" + refLayer.index]; if (!rb || rb.err) aemcp.fail("The reference layer '" + refLayer.name + "' has no bounds"); ref = rb; }
else if (typeof to === "object") ref = { x0: to.x, x1: to.x, y0: to.y, y1: to.y };
else if (to === "comp") ref = { x0: 0, y0: 0, x1: W, y1: H };
else if (to === "titleSafe") ref = { x0: W * 0.1, y0: H * 0.1, x1: W * 0.9, y1: H * 0.9 };
else if (to === "actionSafe") ref = { x0: W * 0.05, y0: H * 0.05, x1: W * 0.95, y1: H * 0.95 };
else {
  ref = { x0: items[0].b.x0, y0: items[0].b.y0, x1: items[0].b.x1, y1: items[0].b.y1 };
  for (i = 1; i < items.length; i++) { var bb = items[i].b; ref.x0 = Math.min(ref.x0, bb.x0); ref.y0 = Math.min(ref.y0, bb.y0); ref.x1 = Math.max(ref.x1, bb.x1); ref.y1 = Math.max(ref.y1, bb.y1); }
}
function need(v, what) { if (v === undefined || v === null || isNaN(v)) aemcp.fail("align " + args.align + " to a point needs " + what); return v; }
if (args.align) for (i = 0; i < items.length; i++) {
  var it = items[i], B = it.b, al = args.align;
  if (al === "left") it.dx = need(ref.x0, "x") - B.x0;
  else if (al === "right") it.dx = need(ref.x1, "x") - B.x1;
  else if (al === "hcenter" || al === "center") it.dx = (need(ref.x0, "x") + ref.x1) / 2 - (B.x0 + B.x1) / 2;
  if (al === "top") it.dy = need(ref.y0, "y") - B.y0;
  else if (al === "bottom") it.dy = need(ref.y1, "y") - B.y1;
  else if (al === "vcenter" || al === "center") it.dy = (need(ref.y0, "y") + ref.y1) / 2 - (B.y0 + B.y1) / 2;
}
if (dAxis) {
  if (items.length < 2 || (items.length < 3 && args.spacing === undefined)) aemcp.fail("distribute needs at least 3 measurable layers (2 with spacing)");
  var lo = dAxis === "x" ? "x0" : "y0", hi = dAxis === "x" ? "x1" : "y1", dk = dAxis === "x" ? "dx" : "dy";
  var order = items.slice(0);
  order.sort(function (p, q) { return (p.b[lo] + p.b[hi]) - (q.b[lo] + q.b[hi]); });
  var n = order.length, first = order[0].b, last = order[n - 1].b;
  if (args.by === "centers") {
    var c0 = (first[lo] + first[hi]) / 2, c1 = (last[lo] + last[hi]) / 2;
    for (i = 1; i < n - 1; i++) order[i][dk] = c0 + (c1 - c0) * i / (n - 1) - (order[i].b[lo] + order[i].b[hi]) / 2;
  } else {
    var total = 0; for (i = 0; i < n; i++) total += order[i].b[hi] - order[i].b[lo];
    var gap = args.spacing !== undefined ? args.spacing : (last[hi] - first[lo] - total) / (n - 1), pos = first[lo];
    for (i = 0; i < n; i++) { if (i > 0) order[i][dk] = pos - order[i].b[lo]; pos += order[i].b[hi] - order[i].b[lo] + gap; }
  }
}
// what can move: 2D layers with a settable Position
var movers = [];
for (i = 0; i < items.length; i++) {
  var I = items[i], Lr = I.L, why = null;
  if (Math.abs(I.dx) < 1e-9 && Math.abs(I.dy) < 1e-9) continue;
  if (I.b.threeD) why = "3D layer (or a 3D parent): moving it on screen needs depth; not moved";
  else if (Lr.locked) why = "locked";
  var tr = Lr.property("ADBE Transform Group"), pos = tr.property("ADBE Position"), sep = false;
  try { sep = pos.dimensionsSeparated; } catch (e) {}
  var props = sep ? [tr.property("ADBE Position_0"), tr.property("ADBE Position_1")] : [pos];
  for (var pi = 0; pi < props.length && !why; pi++) { try { if (props[pi].expressionEnabled && props[pi].expression) why = "Position has an expression"; } catch (e) {} }
  if (why) { skipped.push({ layer: Lr.index, name: Lr.name, why: why }); continue; }
  movers.push({ it: I, props: props, sep: sep });
}
// comp-space moves -> the parent's space (Position lives there), through AE's own fromComp()
var deltas = {};
if (movers.length) {
  var ex = "var s='';";
  for (i = 0; i < movers.length; i++) {
    var M = movers[i];
    ex += "(function(){var L=thisComp.layer(" + M.it.L.index + "),dx=" + M.it.dx + ",dy=" + M.it.dy + ";if(L.hasParent){var a=L.parent.fromComp([0,0]),b=L.parent.fromComp([dx,dy]);s+=" + M.it.L.index + "+':'+(b[0]-a[0])+','+(b[1]-a[1])+'|';}else s+=" + M.it.L.index + "+':'+dx+','+dy+'|';})();";
  }
  ex += "s";
  var raw = evalExpr(c, ex, t).split("|");
  for (i = 0; i < raw.length; i++) { if (!raw[i]) continue; var cl = raw[i].indexOf(":"), xy = raw[i].substr(cl + 1).split(","); deltas["i" + raw[i].substr(0, cl)] = [Number(xy[0]), Number(xy[1])]; }
}
var plan = [];
for (i = 0; i < movers.length; i++) {
  var Mv = movers[i], dl = deltas["i" + Mv.it.L.index];
  plan.push({ layer: Mv.it.L.index, name: Mv.it.L.name, moveX: Mv.it.dx, moveY: Mv.it.dy, positionDelta: dl, keyframed: Mv.props[0].numKeys > 0 || (Mv.props.length > 1 && Mv.props[1].numKeys > 0) });
  if (args.dryRun) continue;
  for (var pj = 0; pj < Mv.props.length; pj++) {
    var P = Mv.props[pj], d = Mv.sep ? dl[pj] : dl;
    var add = function (v) { if (typeof v === "number") return v + d; var o = v.slice(0); o[0] += d[0]; o[1] += d[1]; return o; };
    if (P.numKeys) { for (var k = 1; k <= P.numKeys; k++) P.setValueAtKey(k, add(P.keyValue(k))); }
    else P.setValue(add(P.value));
  }
}
var res = { comp: c.name, time: t, frame: Math.round(t / c.frameDuration), to: refLayer ? "layer " + refLayer.name : to, dryRun: !!args.dryRun, moves: plan };
if (skipped.length) res.notMoved = skipped;
if (!args.dryRun && plan.length) {
  var after = measureLayers(c, idx, t, !!args.includeExtents), out = [], worst = 0;
  for (i = 0; i < movers.length; i++) {
    var mi = movers[i].it, ab = after["i" + mi.L.index];
    if (!ab || ab.err) continue;
    var rx = ab.x0 - (mi.b.x0 + mi.dx), ry = ab.y0 - (mi.b.y0 + mi.dy);
    worst = Math.max(worst, Math.abs(rx), Math.abs(ry));
    out.push({ layer: mi.L.index, name: mi.L.name, left: ab.x0, top: ab.y0, right: ab.x1, bottom: ab.y1 });
  }
  res.after = out; res.maxResidualPx = Math.round(worst * 10000) / 10000;
}
return res;`,
  },
];
