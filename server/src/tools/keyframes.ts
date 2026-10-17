import { z } from "zod";
import { anyValue, compRef, layerRef, propPath, type JsxTool } from "./registry.js";

const ease = z
  .union([z.number(), z.object({ speed: z.number().optional(), influence: z.number().optional() }), z.array(z.object({ speed: z.number(), influence: z.number() }))])
  .describe("Temporal ease: influence % (number), {speed, influence}, or one {speed, influence} per dimension (Graph Editor values).");
const interp = z.enum(["linear", "bezier", "hold"]);
const pair = z.array(z.number()).min(2).max(3);

const findKey = `
function keyIndex(p, k) {
  if (k.index !== undefined) { if (k.index < 1 || k.index > p.numKeys) aemcp.fail("Keyframe index " + k.index + " out of range 1-" + p.numKeys); return k.index; }
  if (k.time === undefined) aemcp.fail("Each keyframe needs index or time");
  var i = p.nearestKeyIndex(k.time);
  if (!p.numKeys || Math.abs(p.keyTime(i) - k.time) > 0.0005) aemcp.fail("No keyframe at " + k.time + "s on " + p.name);
  return i;
}
function easeList(p, e) {
  if (e instanceof Array) { var a = []; for (var i = 0; i < e.length; i++) a.push(new KeyframeEase(e[i].speed, Math.max(0.1, Math.min(100, e[i].influence)))); return a; }
  return aemcp.easeArr(p, e);
}`;

export const keyframeTools: JsxTool[] = [
  {
    name: "ae_edit_keyframes",
    title: "Edit keyframes",
    description:
      "Graph Editor-level control of existing keyframes on a property: change value, move in time, in/out interpolation, temporal ease " +
      "(speed + influence per dimension), temporal/spatial continuous and auto-Bezier, spatial tangents (motion path handles), roving, " +
      "keyframe label color, and remove keyframes. Address keys by index or exact time. ae_get_properties with keyframes:true shows all of these.",
    input: {
      comp: compRef,
      layer: layerRef,
      path: z.string().describe('Property path, e.g. "Transform/Position".'),
      keys: z
        .array(
          z.object({
            index: z.number().int().optional(),
            time: z.number().optional().describe("Find the key at this time (seconds) if no index."),
            value: anyValue.optional(),
            moveTo: z.number().optional().describe("New time in seconds (all attributes are kept)."),
            interpolation: interp.optional(),
            inInterpolation: interp.optional(),
            outInterpolation: interp.optional(),
            easeIn: ease.optional(),
            easeOut: ease.optional(),
            temporalContinuous: z.boolean().optional(),
            temporalAutoBezier: z.boolean().optional(),
            spatialContinuous: z.boolean().optional(),
            spatialAutoBezier: z.boolean().optional(),
            inSpatialTangent: pair.optional().describe("Incoming motion-path handle, relative to the key's position."),
            outSpatialTangent: pair.optional(),
            roving: z.boolean().optional(),
            label: z.number().int().min(0).max(16).optional().describe("Keyframe color label (0 = none)."),
          }),
        )
        .optional(),
      remove: z.array(z.union([z.number().int(), z.object({ time: z.number() })])).optional().describe("Keyframes to delete: indices or {time}."),
    },
    jsx: `${findKey}
var c = aemcp.findComp(args.comp), l = aemcp.findLayer(c, args.layer), p = aemcp.resolveProp(l, args.path);
if (p.propertyType !== PropertyType.PROPERTY) aemcp.fail("'" + p.name + "' is a group");
var I = function (n) { return aemcp.interp(n); };
// resolve all targets to times first: moving/removing keys changes indices
var edits = [], keys = args.keys || [];
for (var i = 0; i < keys.length; i++) edits.push({ spec: keys[i], time: p.keyTime(keyIndex(p, keys[i])) });
var removeTimes = [];
for (var r = 0; r < (args.remove || []).length; r++) { var rm = args.remove[r]; removeTimes.push(p.keyTime(keyIndex(p, typeof rm === "number" ? { index: rm } : rm))); }
for (var j = 0; j < edits.length; j++) {
  var e = edits[j], k = e.spec, idx = p.nearestKeyIndex(e.time);
  if (k.moveTo !== undefined && Math.abs(k.moveTo - e.time) > 0.0005) {
    var d = aemcp.captureKey(p, idx);
    p.removeKey(idx);
    idx = aemcp.restoreKey(p, d, k.moveTo);
  }
  if (k.value !== undefined) p.setValueAtKey(idx, aemcp.toAEValue(p, k.value));
  var ii = I(k.inInterpolation || k.interpolation), oi = I(k.outInterpolation || k.interpolation);
  if (ii || oi) p.setInterpolationTypeAtKey(idx, ii || p.keyInInterpolationType(idx), oi || p.keyOutInterpolationType(idx));
  if (k.easeIn !== undefined || k.easeOut !== undefined)
    p.setTemporalEaseAtKey(idx, k.easeIn !== undefined ? easeList(p, k.easeIn) : p.keyInTemporalEase(idx), k.easeOut !== undefined ? easeList(p, k.easeOut) : p.keyOutTemporalEase(idx));
  if (k.temporalContinuous !== undefined) p.setTemporalContinuousAtKey(idx, k.temporalContinuous);
  if (k.temporalAutoBezier !== undefined) p.setTemporalAutoBezierAtKey(idx, k.temporalAutoBezier);
  if (p.isSpatial) {
    if (k.spatialContinuous !== undefined) p.setSpatialContinuousAtKey(idx, k.spatialContinuous);
    if (k.spatialAutoBezier !== undefined) p.setSpatialAutoBezierAtKey(idx, k.spatialAutoBezier);
    if (k.inSpatialTangent || k.outSpatialTangent) {
      // AE wants as many values as the property has dimensions (3 for Position, even in 2D)
      var dims = p.keyValue(idx).length, pad = function (v) { var a = v.slice(0); while (a.length < dims) a.push(0); return a.slice(0, dims); };
      p.setSpatialTangentsAtKey(idx, k.inSpatialTangent ? pad(k.inSpatialTangent) : p.keyInSpatialTangent(idx), k.outSpatialTangent ? pad(k.outSpatialTangent) : p.keyOutSpatialTangent(idx));
    }
    if (k.roving !== undefined) p.setRovingAtKey(idx, k.roving);
  } else if (k.inSpatialTangent || k.outSpatialTangent || k.roving !== undefined || k.spatialContinuous !== undefined) {
    log("'" + p.name + "' is not a spatial property: spatial settings ignored");
  }
  if (k.label !== undefined) p.setLabelAtKey(idx, k.label);
}
for (var q = 0; q < removeTimes.length; q++) { var ri = p.nearestKeyIndex(removeTimes[q]); if (Math.abs(p.keyTime(ri) - removeTimes[q]) < 0.0005) p.removeKey(ri); }
return { property: p.name, numKeys: p.numKeys, keyframes: aemcp.keyframes(p) };`,
  },
  {
    name: "ae_copy_keyframes",
    title: "Copy keyframes",
    description:
      "Copy keyframes (with interpolation, ease, tangents and labels) from one property to one or more others, in the same or other layers/comps. " +
      "Optionally only a time range, shifted in time, replacing existing keys.",
    input: {
      from: z.object({ comp: z.union([z.number().int(), z.string()]).optional(), layer: layerRef, path: z.string() }),
      to: z.array(z.object({ comp: z.union([z.number().int(), z.string()]).optional(), layer: layerRef, path: z.string() })).min(1),
      startTime: z.number().optional().describe("Only keys at or after this time."),
      endTime: z.number().optional().describe("Only keys at or before this time."),
      offset: z.number().optional().describe("Shift the copies by this many seconds (e.g. to place them at the target's time)."),
      replace: z.boolean().optional().describe("Remove the target's existing keyframes first."),
    },
    jsx: `
var sc = aemcp.findComp(args.from.comp), src = aemcp.resolveProp(aemcp.findLayer(sc, args.from.layer), args.from.path);
if (!src.numKeys) aemcp.fail("'" + src.name + "' has no keyframes");
var keys = [];
for (var k = 1; k <= src.numKeys; k++) {
  var t = src.keyTime(k);
  if ((args.startTime === undefined || t >= args.startTime - 0.0005) && (args.endTime === undefined || t <= args.endTime + 0.0005)) keys.push(aemcp.captureKey(src, k));
}
if (!keys.length) aemcp.fail("No keyframes in that time range");
var out = [];
for (var i = 0; i < args.to.length; i++) {
  var tc = aemcp.findComp(args.to[i].comp), dst = aemcp.resolveProp(aemcp.findLayer(tc, args.to[i].layer), args.to[i].path);
  if (dst.propertyValueType !== src.propertyValueType) aemcp.fail("Can't copy " + aemcp.enumName(PropertyValueType, src.propertyValueType) + " keyframes to '" + dst.name + "' (" + aemcp.enumName(PropertyValueType, dst.propertyValueType) + ")");
  if (args.replace) while (dst.numKeys) dst.removeKey(1);
  for (var j = 0; j < keys.length; j++) aemcp.restoreKey(dst, keys[j], keys[j].time + (args.offset || 0));
  out.push({ comp: tc.name, property: dst.name, numKeys: dst.numKeys });
}
return { copied: keys.length, targets: out };`,
  },
  {
    name: "ae_set_time_remap",
    title: "Time remapping",
    description:
      "Enable or disable time remapping on a layer (footage or precomp) and set its keyframes: each maps a comp time to a source time. " +
      "Use freezeAt to hold a single source frame for the whole layer.",
    input: {
      comp: compRef,
      layer: layerRef,
      enabled: z.boolean().optional().describe("Default true."),
      keyframes: z.array(z.object({ time: z.number(), sourceTime: z.number(), interpolation: interp.optional() })).optional(),
      freezeAt: z.number().optional().describe("Freeze on this source time (seconds) for the whole layer."),
    },
    jsx: `
var c = aemcp.findComp(args.comp), l = aemcp.findLayer(c, args.layer);
if (!l.canSetTimeRemapEnabled) aemcp.fail("Layer '" + l.name + "' can't be time-remapped (only footage and precomp layers)");
if (args.enabled === false) { l.timeRemapEnabled = false; return { layer: l.name, timeRemap: false }; }
l.timeRemapEnabled = true;
var tr = l.property("ADBE Time Remapping");
// Time Remap is hidden while it has no keyframes, so new keys are added before old ones are removed
var wanted = [];
if (args.freezeAt !== undefined) wanted.push({ time: l.inPoint, sourceTime: args.freezeAt, interpolation: "hold" });
else if (args.keyframes) wanted = args.keyframes;
if (wanted.length) {
  var keep = {};
  for (var i = 0; i < wanted.length; i++) {
    var k = wanted[i];
    tr.setValueAtTime(k.time, k.sourceTime);
    var idx = tr.nearestKeyIndex(k.time);
    keep[String(Math.round(tr.keyTime(idx) * 10000))] = true;
    var mode = aemcp.interp(k.interpolation);
    if (mode) tr.setInterpolationTypeAtKey(idx, mode, mode);
  }
  for (var r = tr.numKeys; r >= 1; r--) if (!keep[String(Math.round(tr.keyTime(r) * 10000))]) tr.removeKey(r);
}
return { layer: l.name, timeRemap: true, keyframes: aemcp.keyframes(tr) };`,
  },
];
