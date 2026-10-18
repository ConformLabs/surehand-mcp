import { z } from "zod";
import { colorSchema, compRef, layerRef, propPath, type JsxTool } from "./registry.js";

const vec = z.array(z.number()).min(2).max(3);

// camera zoom (pixels) <-> focal length (mm) on a 36 mm wide film back, the After Effects default
const cameraInfo = `
function cameraInfo(c, cam) {
  var o = cam.property("ADBE Camera Options Group"), tr = cam.property("ADBE Transform Group");
  var zoom = o.property("ADBE Camera Zoom").value;
  var info = { layer: cam.name, index: cam.index, type: cam.autoOrient === AutoOrientType.CAMERA_OR_POINT_OF_INTEREST ? "two-node" : "one-node",
    zoom: aemcp.round(zoom), focalLength: aemcp.round(zoom * 36 / c.width), angleOfView: aemcp.round(2 * Math.atan(c.width / 2 / zoom) * 180 / Math.PI),
    position: aemcp.valueOf(tr.property("ADBE Position").value), depthOfField: o.property("ADBE Camera Depth of Field").value === 1,
    focusDistance: aemcp.round(o.property("ADBE Camera Focus Distance").value), aperture: aemcp.round(o.property("ADBE Camera Aperture").value),
    blurLevel: o.property("ADBE Camera Blur Level").value, activeCamera: c.activeCamera === cam };
  try { info.pointOfInterest = aemcp.valueOf(tr.property("ADBE Anchor Point").value); } catch (e) {}
  return info;
}`;

export const sceneTools: JsxTool[] = [
  // ---------- 3D ----------
  {
    name: "ae_set_camera",
    title: "Camera",
    description:
      "Create or change a camera: one- or two-node, focal length (mm, 36 mm film) or zoom, position / point of interest, depth of field " +
      "(focus distance, aperture, blur level). Without settings it reports the camera (focal length, angle of view...). Default: the comp's active camera, created if missing.",
    input: {
      comp: compRef,
      layer: layerRef.optional().describe("Camera layer (default: the active camera)."),
      create: z.boolean().optional().describe("Always create a new camera."),
      name: z.string().optional(),
      type: z.enum(["one-node", "two-node"]).optional(),
      focalLength: z.number().min(1).optional().describe("Millimetres (e.g. 24, 35, 50, 85)."),
      zoom: z.number().min(1).optional().describe("Zoom in pixels (alternative to focalLength)."),
      position: vec.optional(),
      pointOfInterest: vec.optional(),
      depthOfField: z.boolean().optional(),
      focusDistance: z.number().optional(),
      aperture: z.number().optional().describe("Aperture in pixels."),
      blurLevel: z.number().optional().describe("Percent."),
    },
    jsx: `${cameraInfo}
var c = aemcp.findComp(args.comp), cam = null;
if (!args.create) {
  if (args.layer !== undefined) { cam = aemcp.findLayer(c, args.layer); if (!(cam instanceof CameraLayer)) aemcp.fail("'" + cam.name + "' is not a camera"); }
  else cam = c.activeCamera;
}
if (!cam) cam = c.layers.addCamera(args.name || "Camera", [c.width / 2, c.height / 2]);
else if (args.name) cam.name = args.name;
var o = cam.property("ADBE Camera Options Group"), tr = cam.property("ADBE Transform Group");
if (args.type) cam.autoOrient = args.type === "two-node" ? AutoOrientType.CAMERA_OR_POINT_OF_INTEREST : AutoOrientType.NO_AUTO_ORIENT;
if (args.focalLength !== undefined) o.property("ADBE Camera Zoom").setValue(args.focalLength * c.width / 36);
else if (args.zoom !== undefined) o.property("ADBE Camera Zoom").setValue(args.zoom);
if (args.position) tr.property("ADBE Position").setValue(args.position.length === 2 ? [args.position[0], args.position[1], tr.property("ADBE Position").value[2]] : args.position);
if (args.pointOfInterest) tr.property("ADBE Anchor Point").setValue(args.pointOfInterest.length === 2 ? [args.pointOfInterest[0], args.pointOfInterest[1], 0] : args.pointOfInterest);
if (args.depthOfField !== undefined) o.property("ADBE Camera Depth of Field").setValue(args.depthOfField ? 1 : 0);
if (args.focusDistance !== undefined) o.property("ADBE Camera Focus Distance").setValue(args.focusDistance);
if (args.aperture !== undefined) o.property("ADBE Camera Aperture").setValue(args.aperture);
if (args.blurLevel !== undefined) o.property("ADBE Camera Blur Level").setValue(args.blurLevel);
return cameraInfo(c, cam);`,
  },
  {
    name: "ae_set_light",
    title: "Light",
    description:
      "Create or change a light: type (parallel, spot, point, ambient, environment), color, intensity, cone angle/feather, falloff, " +
      "shadows (darkness, diffusion), position and point of interest.",
    input: {
      comp: compRef,
      layer: layerRef.optional().describe("Existing light (omit to create one)."),
      name: z.string().optional(),
      type: z.enum(["PARALLEL", "SPOT", "POINT", "AMBIENT", "ENVIRONMENT"]).optional(),
      color: colorSchema.optional(),
      intensity: z.number().optional().describe("Percent."),
      coneAngle: z.number().optional(),
      coneFeather: z.number().optional(),
      falloff: z.enum(["none", "smooth", "inverseSquareClamped"]).optional(),
      radius: z.number().optional().describe("Falloff start."),
      falloffDistance: z.number().optional(),
      castsShadows: z.boolean().optional(),
      shadowDarkness: z.number().optional(),
      shadowDiffusion: z.number().optional(),
      position: vec.optional(),
      pointOfInterest: vec.optional(),
    },
    jsx: `
var c = aemcp.findComp(args.comp), L;
if (args.layer !== undefined) { L = aemcp.findLayer(c, args.layer); if (!(L instanceof LightLayer)) aemcp.fail("'" + L.name + "' is not a light"); }
else L = c.layers.addLight(args.name || "Light", [c.width / 2, c.height / 2]);
if (args.name && args.layer !== undefined) L.name = args.name;
if (args.type) { if (LightType[args.type] === undefined) aemcp.fail("Light type " + args.type + " is not available in this After Effects version"); L.lightType = LightType[args.type]; }
var o = L.property("ADBE Light Options Group"), tr = L.property("ADBE Transform Group"), skipped = [];
function set(mn, v) { if (v === undefined) return; var p = o.property(mn); if (!p) { skipped.push(mn); return; } try { p.setValue(v); } catch (e) { skipped.push(mn + " (" + e.message + ")"); } }
set("ADBE Light Intensity", args.intensity);
if (args.color !== undefined) set("ADBE Light Color", aemcp.color3(args.color));
set("ADBE Light Cone Angle", args.coneAngle);
set("ADBE Light Cone Feather 2", args.coneFeather);
if (args.falloff) set("ADBE Light Falloff Type", { none: 1, smooth: 2, inverseSquareClamped: 3 }[args.falloff]);
set("ADBE Light Falloff Start", args.radius);
set("ADBE Light Falloff Distance", args.falloffDistance);
if (args.castsShadows !== undefined) set("ADBE Casts Shadows", args.castsShadows ? 1 : 0);
set("ADBE Light Shadow Darkness", args.shadowDarkness);
set("ADBE Light Shadow Diffusion", args.shadowDiffusion);
if (args.position) tr.property("ADBE Position").setValue(args.position.length === 2 ? [args.position[0], args.position[1], -500] : args.position);
if (args.pointOfInterest) { try { tr.property("ADBE Anchor Point").setValue(args.pointOfInterest.length === 2 ? [args.pointOfInterest[0], args.pointOfInterest[1], 0] : args.pointOfInterest); } catch (e) { skipped.push("pointOfInterest (" + e.message + ")"); } }
var out = { layer: L.name, type: aemcp.enumName(LightType, L.lightType), options: aemcp.propInfo(o, { depth: 1 }) };
if (skipped.length) out.notApplied = skipped;
return out;`,
  },
  {
    name: "ae_set_material",
    title: "3D material options",
    description:
      "Make layers 3D and set their Material Options: cast/accept shadows, accept lights, appears in reflections, ambient, diffuse, specular, " +
      "shininess, metal, reflection, glossiness, transparency, index of refraction, light transmission. Also lists the comp's 3D renderers.",
    input: {
      comp: compRef,
      layers: z.array(layerRef).min(1),
      threeD: z.boolean().optional().describe("Default true."),
      castsShadows: z.enum(["off", "on", "only"]).optional(),
      acceptsShadows: z.enum(["off", "on", "only"]).optional(),
      acceptsLights: z.boolean().optional(),
      appearsInReflections: z.enum(["off", "on", "only"]).optional(),
      ambient: z.number().optional(),
      diffuse: z.number().optional(),
      specular: z.number().optional(),
      shininess: z.number().optional(),
      metal: z.number().optional(),
      reflection: z.number().optional(),
      glossiness: z.number().optional(),
      transparency: z.number().optional(),
      indexOfRefraction: z.number().optional(),
      lightTransmission: z.number().optional(),
    },
    idempotent: true,
    jsx: `
var c = aemcp.findComp(args.comp), done = [];
var tri = { off: 0, on: 1, only: 2 };
var map = { ambient: "ADBE Ambient Coefficient", diffuse: "ADBE Diffuse Coefficient", specular: "ADBE Specular Coefficient", shininess: "ADBE Shininess Coefficient",
  metal: "ADBE Metal Coefficient", reflection: "ADBE Reflection Coefficient", glossiness: "ADBE Glossiness Coefficient", transparency: "ADBE Transparency Coefficient",
  indexOfRefraction: "ADBE Index of Refraction", lightTransmission: "ADBE Light Transmission" };
for (var i = 0; i < args.layers.length; i++) {
  var L = aemcp.findLayer(c, args.layers[i]);
  if (args.threeD !== false) { if (L.threeDLayer === undefined) aemcp.fail("'" + L.name + "' can't be a 3D layer"); L.threeDLayer = true; }
  var m = L.property("ADBE Material Options Group"); if (!m) aemcp.fail("'" + L.name + "' has no material options");
  if (args.castsShadows) m.property("ADBE Casts Shadows").setValue(tri[args.castsShadows]);
  if (args.acceptsShadows) m.property("ADBE Accepts Shadows").setValue(tri[args.acceptsShadows]);
  if (args.acceptsLights !== undefined) m.property("ADBE Accepts Lights").setValue(args.acceptsLights ? 1 : 0);
  if (args.appearsInReflections) { var ar = m.property("ADBE Appears in Reflections"); if (ar) ar.setValue(tri[args.appearsInReflections]); }
  for (var k in map) if (map.hasOwnProperty(k) && args[k] !== undefined) { var p = m.property(map[k]); if (p) p.setValue(args[k]); else log(k + " is not available in this version"); }
  done.push(L.name);
}
return { layers: done, renderer: c.renderer, availableRenderers: c.renderers, material: aemcp.propInfo(aemcp.findLayer(c, args.layers[0]).property("ADBE Material Options Group"), { depth: 1 }) };`,
  },

  // ---------- audio ----------
  {
    name: "ae_audio_to_keyframes",
    title: "Audio to keyframes",
    description:
      "Run Animation > Keyframe Assistant > Convert Audio to Keyframes on a layer with audio: adds an \"Audio Amplitude\" null with Left, Right " +
      "and Both Channels sliders keyed every frame, ready to drive animation with expressions.",
    input: { comp: compRef, layer: layerRef },
    jsx: `
var c = aemcp.findComp(args.comp), L = aemcp.findLayer(c, args.layer);
if (!L.hasAudio) aemcp.fail("'" + L.name + "' has no audio");
c.openInViewer();
for (var i = 1; i <= c.numLayers; i++) c.layer(i).selected = false;
L.selected = true;
var before = c.numLayers;
app.executeCommand(aemcp.commandId("convert audio to keyframes")); // command id: works in any AE language
if (c.numLayers === before) aemcp.fail("Convert Audio to Keyframes did not run (is the comp open and the layer's audio enabled?)");
var amp = c.layer(1), fx = amp.property("ADBE Effect Parade"), out = { layer: amp.name, sliders: [] };
for (var j = 1; j <= fx.numProperties; j++) { var s = fx.property(j).property(1); out.sliders.push({ name: fx.property(j).name, keyframes: s.numKeys, path: "Effects/" + fx.property(j).name + "/Slider" }); }
out.hint = 'Use in an expression: thisComp.layer("' + amp.name + '").effect("' + fx.property(fx.numProperties).name + '")(1)';
return out;`,
  },
  {
    name: "ae_audio_markers",
    title: "Markers from audio",
    description:
      "Find beats/peaks in a layer's audio (via Convert Audio to Keyframes) and add markers at them on the comp or the layer. " +
      "threshold = fraction of the loudest level (default 0.6), minGap = seconds between markers (default 0.25).",
    input: {
      comp: compRef,
      layer: layerRef,
      threshold: z.number().min(0.05).max(1).optional(),
      minGap: z.number().min(0.01).optional(),
      channel: z.enum(["both", "left", "right"]).optional(),
      target: z.enum(["comp", "layer"]).optional().describe("Where to add the markers (default comp)."),
      keepAmplitudeLayer: z.boolean().optional(),
      maxMarkers: z.number().int().min(1).max(2000).optional().describe("Default 300."),
    },
    jsx: `
var c = aemcp.findComp(args.comp), L = aemcp.findLayer(c, args.layer);
if (!L.hasAudio) aemcp.fail("'" + L.name + "' has no audio");
c.openInViewer();
for (var i = 1; i <= c.numLayers; i++) c.layer(i).selected = false;
L.selected = true;
var before = c.numLayers;
app.executeCommand(aemcp.commandId("convert audio to keyframes")); // command id: works in any AE language
if (c.numLayers === before) aemcp.fail("Convert Audio to Keyframes did not run");
var amp = c.layer(1), fx = amp.property("ADBE Effect Parade");
// the amplitude null's effects are Left, Right, Both Channels in that order (by index: their names are translated)
var chIndex = { left: 1, right: 2, both: 3 }[args.channel || "both"];
var sl = fx.property(chIndex).property(1), n = sl.numKeys, vals = [], times = [], max = 0;
for (var k = 1; k <= n; k++) { var v = sl.keyValue(k); vals.push(v); times.push(sl.keyTime(k)); if (v > max) max = v; }
var thr = (args.threshold || 0.6) * max, gap = args.minGap || 0.25, lim = args.maxMarkers || 300, beats = [], last = -1e9;
for (var q = 1; q < n - 1; q++) {
  if (vals[q] >= thr && vals[q] >= vals[q - 1] && vals[q] > vals[q + 1] && times[q] - last >= gap) { beats.push({ time: aemcp.round(times[q]), level: aemcp.round(vals[q] / max) }); last = times[q]; if (beats.length >= lim) break; }
}
if (!args.keepAmplitudeLayer) { var src = amp.source; amp.remove(); try { if (src && src.usedIn.length === 0) src.remove(); } catch (e) {} } // also the null's solid
var mp = args.target === "layer" ? L.property("ADBE Marker") : c.markerProperty;
for (var b = 0; b < beats.length; b++) { var m = new MarkerValue("beat " + (b + 1)); mp.setValueAtTime(beats[b].time, m); }
return { markers: beats.length, on: args.target === "layer" ? L.name : c.name, peakLevel: aemcp.round(max), beats: beats.slice(0, 50) };`,
  },

  // ---------- expressions ----------
  {
    name: "ae_check_expression",
    title: "Check expression",
    description:
      "Try an expression on a property WITHOUT keeping it: reports After Effects' error (if any) and the values it produces at a few times, " +
      "then restores the property exactly as it was. Use before ae_set_expression.",
    input: {
      comp: compRef,
      layer: layerRef,
      path: propPath,
      expression: z.string(),
      times: z.array(z.number()).max(20).optional().describe("Times to evaluate (default: start, current time, end)."),
    },
    readOnly: true,
    tempItems: true,
    jsx: `
var c = aemcp.findComp(args.comp), l = aemcp.findLayer(c, args.layer), p = aemcp.resolveProp(l, args.path);
if (!p.canSetExpression) aemcp.fail("'" + p.name + "' can't have an expression");
var oldExpr = p.expression, oldEnabled = p.expressionEnabled, out = {};
try {
  p.expression = args.expression;
  out.error = p.expressionError || null;
  if (!out.error) {
    var ts = args.times || [0, c.time, c.duration - c.frameDuration], vals = [];
    for (var i = 0; i < ts.length; i++) { try { vals.push({ time: aemcp.round(ts[i]), value: aemcp.valueOf(p.valueAtTime(ts[i], false)) }); } catch (e) { out.error = e.message; break; } }
    out.values = vals;
    if (!out.error && p.expressionError) out.error = p.expressionError;
  }
} finally {
  p.expression = oldExpr;
  if (oldExpr) { try { p.expressionEnabled = oldEnabled; } catch (e) {} }
}
out.ok = !out.error;
out.property = p.name;
return out;`,
  },
  {
    name: "ae_replace_in_expressions",
    title: "Find & replace in expressions",
    description:
      "Find and replace text in every expression of the project (or the given comps), e.g. after renaming a layer or comp. " +
      "dryRun lists the matches without changing anything. Reports expressions that have errors after the change.",
    input: {
      find: z.string().min(1),
      replace: z.string(),
      regex: z.boolean().optional().describe("Treat find as a regular expression."),
      caseSensitive: z.boolean().optional().describe("Default true."),
      comps: z.array(z.union([z.number().int(), z.string()])).optional().describe("Only these comps (default: all)."),
      dryRun: z.boolean().optional(),
    },
    jsx: `
var flags = "g" + (args.caseSensitive === false ? "i" : "");
var esc = function (t) { return t.replace(/[.*+?^$()|[\\]{}\\\\]/g, "\\\\$&"); };
var re = new RegExp(args.regex ? args.find : esc(args.find), flags);
var comps = [];
if (args.comps) { for (var i = 0; i < args.comps.length; i++) comps.push(aemcp.findComp(args.comps[i])); }
else for (var j = 1; j <= app.project.numItems; j++) if (app.project.item(j) instanceof CompItem) comps.push(app.project.item(j));
var hits = [], errors = [];
function walk(g, comp, layer, path) {
  for (var q = 1; q <= g.numProperties; q++) {
    var p = g.property(q), pp = path ? path + "/" + p.name : p.name;
    if (p.propertyType !== PropertyType.PROPERTY) { walk(p, comp, layer, pp); continue; }
    var ex = ""; try { ex = p.canSetExpression ? p.expression : ""; } catch (e) {}
    if (!ex) continue;
    re.lastIndex = 0;
    if (!re.test(ex)) continue;
    re.lastIndex = 0;
    var next = ex.replace(re, args.replace);
    hits.push({ comp: comp.name, layer: layer.name, property: pp, before: ex.length > 160 ? ex.substr(0, 157) + "..." : ex, after: next.length > 160 ? next.substr(0, 157) + "..." : next });
    if (!args.dryRun) { p.expression = next; if (p.expressionError) errors.push({ comp: comp.name, layer: layer.name, property: pp, error: p.expressionError }); }
  }
}
for (var k = 0; k < comps.length; k++) for (var m = 1; m <= comps[k].numLayers; m++) walk(comps[k].layer(m), comps[k], comps[k].layer(m), "");
return { dryRun: !!args.dryRun, matches: hits.length, changed: args.dryRun ? 0 : hits.length, errorsAfter: errors, details: hits.slice(0, 100) };`,
  },

  // ---------- color ----------
  {
    name: "ae_color_settings",
    title: "Color settings",
    description:
      "Read or change the project's color management: color engine (Adobe or OCIO), working space, bit depth, linear blending, " +
      "linearize working space, scene-referred compensation, OCIO config and working/display color spaces. listProfiles returns the available working spaces.",
    input: {
      bitsPerChannel: z.union([z.literal(8), z.literal(16), z.literal(32)]).optional(),
      workingSpace: z.string().optional().describe('Adobe engine: e.g. "sRGB IEC61966-2.1", "Rec.709 Gamma 2.4", "None".'),
      linearBlending: z.boolean().optional(),
      linearizeWorkingSpace: z.boolean().optional(),
      compensateForSceneReferredProfiles: z.boolean().optional(),
      colorManagementSystem: z.enum(["adobe", "ocio"]).optional(),
      ocioConfigurationFile: z.string().optional(),
      workingColorSpace: z.string().optional().describe("OCIO working color space."),
      displayColorSpace: z.string().optional().describe("OCIO display color space."),
      listProfiles: z.boolean().optional(),
    },
    idempotent: true,
    jsx: `
var P = app.project, skipped = [];
function set(k, v) { if (v === undefined) return; try { P[k] = v; } catch (e) { skipped.push(k + ": " + e.message.replace(/^After Effects error: /, "")); } }
if (args.colorManagementSystem) set("colorManagementSystem", args.colorManagementSystem === "ocio" ? 1 : 0);
set("ocioConfigurationFile", args.ocioConfigurationFile);
set("bitsPerChannel", args.bitsPerChannel);
set("workingSpace", args.workingSpace);
set("linearBlending", args.linearBlending);
set("linearizeWorkingSpace", args.linearizeWorkingSpace);
set("compensateForSceneReferredProfiles", args.compensateForSceneReferredProfiles);
set("workingColorSpace", args.workingColorSpace);
set("displayColorSpace", args.displayColorSpace);
var o = {};
var keys = ["colorManagementSystem", "bitsPerChannel", "workingSpace", "workingGamma", "linearBlending", "linearizeWorkingSpace", "compensateForSceneReferredProfiles", "ocioConfigurationFile", "workingColorSpace", "displayColorSpace"];
for (var i = 0; i < keys.length; i++) { try { o[keys[i]] = P[keys[i]]; } catch (e) {} }
if (o.colorManagementSystem !== undefined) o.colorManagementSystem = o.colorManagementSystem === 1 ? "ocio" : "adobe";
if (args.listProfiles) { try { o.availableWorkingSpaces = P.listColorProfiles(); } catch (e) {} }
if (skipped.length) o.notApplied = skipped;
return o;`,
  },
];
