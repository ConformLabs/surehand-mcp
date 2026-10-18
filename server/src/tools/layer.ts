import { z } from "zod";
import { colorSchema, compRef, itemRef, layerRef, type JsxTool } from "./registry.js";

const textStyle = {
  font: z.string().optional().describe('PostScript font name, e.g. "Arial-BoldMT", "Helvetica", "Montserrat-Bold".'),
  fontSize: z.number().optional(),
  fillColor: colorSchema.optional(),
  strokeColor: colorSchema.optional(),
  strokeWidth: z.number().optional(),
  tracking: z.number().optional(),
  leading: z.number().optional(),
  justification: z.enum(["LEFT_JUSTIFY", "CENTER_JUSTIFY", "RIGHT_JUSTIFY", "FULL_JUSTIFY_LASTLINE_LEFT", "FULL_JUSTIFY_LASTLINE_CENTER", "FULL_JUSTIFY_LASTLINE_RIGHT", "FULL_JUSTIFY_LASTLINE_FULL"]).optional(),
  fauxBold: z.boolean().optional(),
  fauxItalic: z.boolean().optional(),
  allCaps: z.boolean().optional(),
};

export const layerTools: JsxTool[] = [
  {
    name: "ae_get_layer_info",
    title: "Get layer info",
    description: "Full info for one layer: switches, timing, parent, source, transform values, effects, masks count, markers, text, and every animated/expression property.",
    input: { comp: compRef, layer: layerRef },
    readOnly: true,
    jsx: `var c = aemcp.findComp(args.comp); return aemcp.layerInfo(aemcp.findLayer(c, args.layer), true);`,
  },
  {
    name: "ae_add_layer",
    title: "Add layer",
    description:
      "Add a layer to a composition: solid, text, shape (empty, use ae_add_shape to draw), null, adjustment, camera, light, or an existing project item (footage/comp).",
    input: {
      comp: compRef,
      type: z.enum(["solid", "text", "shape", "null", "adjustment", "camera", "light", "item"]),
      name: z.string().optional(),
      text: z.string().optional().describe("For text layers."),
      boxSize: z.array(z.number()).length(2).optional().describe("Paragraph (box) text size [w,h]; omit for point text."),
      ...textStyle,
      color: colorSchema.optional().describe("Solid/adjustment color, or light color."),
      width: z.number().int().optional().describe("Solid size (default comp size)."),
      height: z.number().int().optional(),
      item: itemRef.optional().describe("For type 'item': project item to add."),
      lightType: z.enum(["PARALLEL", "SPOT", "POINT", "AMBIENT"]).optional(),
      position: z.array(z.number()).min(2).max(3).optional(),
      startTime: z.number().optional(),
      duration: z.number().optional().describe("Layer duration in seconds (default comp duration)."),
      threeD: z.boolean().optional(),
      moveToIndex: z.number().int().optional().describe("Move the new layer to this 1-based index (new layers are added on top)."),
    },
    jsx: `
var c = aemcp.findComp(args.comp), L = c.layers, l, center = [c.width / 2, c.height / 2];
switch (args.type) {
  case "solid":
  case "adjustment":
    l = L.addSolid(args.color ? aemcp.color3(args.color) : (args.type === "adjustment" ? [1,1,1] : [0.5,0.5,0.5]), args.name || (args.type === "adjustment" ? "Adjustment Layer" : "Solid"), args.width || c.width, args.height || c.height, c.pixelAspect, args.duration || c.duration);
    if (args.type === "adjustment") l.adjustmentLayer = true;
    break;
  case "text":
    l = args.boxSize ? L.addBoxText(args.boxSize, args.text || "") : L.addText(args.text || "");
    var tp = l.property("ADBE Text Properties").property("ADBE Text Document");
    tp.setValue(aemcp.applyText(tp.value, args));
    break;
  case "shape": l = L.addShape(); break;
  case "null": l = L.addNull(args.duration || c.duration); break;
  case "camera": l = L.addCamera(args.name || "Camera", center); break;
  case "light":
    l = L.addLight(args.name || "Light", center);
    if (args.lightType) l.lightType = LightType[args.lightType];
    if (args.color) l.property("ADBE Light Options Group").property("ADBE Light Color").setValue(aemcp.color3(args.color));
    break;
  case "item":
    if (args.item === undefined) aemcp.fail("type 'item' requires item");
    l = L.add(aemcp.findItem(args.item));
    break;
}
if (args.name && args.type !== "camera" && args.type !== "light") l.name = args.name;
if (args.startTime !== undefined) l.startTime = args.startTime;
if (args.duration !== undefined && args.type !== "solid" && args.type !== "adjustment" && args.type !== "null") l.outPoint = l.inPoint + args.duration;
if (args.threeD && l.threeDLayer !== undefined) l.threeDLayer = true;
if (args.position) l.property("ADBE Transform Group").property("ADBE Position").setValue(args.position);
if (args.moveToIndex && args.moveToIndex > 1) l.moveAfter(c.layer(Math.min(args.moveToIndex, c.numLayers)));
return aemcp.layerInfo(l, false);`,
  },
  {
    name: "ae_set_layer_attributes",
    title: "Set layer attributes",
    description:
      "Change layer attributes: name, switches (enabled/solo/locked/shy/3D/motion blur/adjustment/guide), timing (in/out/start/stretch), parent, blend mode, track matte, label, comment, stacking order.",
    input: {
      comp: compRef,
      layer: layerRef,
      name: z.string().optional(),
      enabled: z.boolean().optional(),
      audioEnabled: z.boolean().optional(),
      solo: z.boolean().optional(),
      locked: z.boolean().optional(),
      shy: z.boolean().optional(),
      threeD: z.boolean().optional(),
      motionBlur: z.boolean().optional(),
      adjustmentLayer: z.boolean().optional(),
      guideLayer: z.boolean().optional(),
      collapseTransformation: z.boolean().optional(),
      inPoint: z.number().optional(),
      outPoint: z.number().optional(),
      startTime: z.number().optional(),
      stretch: z.number().optional().describe("Time stretch percent (100 = normal)."),
      parent: z.union([z.number().int(), z.string(), z.null()]).optional().describe("Parent layer index/name, or null to unparent."),
      blendingMode: z.string().optional().describe('BlendingMode enum name, e.g. "NORMAL", "ADD", "SCREEN", "MULTIPLY", "OVERLAY".'),
      trackMatte: z
        .object({ layer: z.union([z.number().int(), z.string()]).optional(), type: z.enum(["NO_TRACK_MATTE", "ALPHA", "ALPHA_INVERTED", "LUMA", "LUMA_INVERTED"]) })
        .optional()
        .describe("Track matte (AE 2023+: any layer; older: the layer above)."),
      label: z.number().int().min(0).max(16).optional(),
      comment: z.string().optional(),
      moveTo: z.number().int().optional().describe("New 1-based stacking index."),
      selected: z.boolean().optional(),
    },
    idempotent: true,
    jsx: `
var c = aemcp.findComp(args.comp), l = aemcp.findLayer(c, args.layer);
var keys = ["name","enabled","audioEnabled","solo","locked","shy","motionBlur","adjustmentLayer","guideLayer","collapseTransformation","inPoint","outPoint","startTime","stretch","label","comment","selected"];
var wasLocked = l.locked; if (wasLocked && args.locked !== true) l.locked = false;
for (var i = 0; i < keys.length; i++) if (args[keys[i]] !== undefined && keys[i] !== "locked") l[keys[i]] = args[keys[i]];
if (args.threeD !== undefined) l.threeDLayer = args.threeD;
if (args.parent !== undefined) l.parent = args.parent === null ? null : aemcp.findLayer(c, args.parent);
if (args.blendingMode) { var bm = BlendingMode[String(args.blendingMode).toUpperCase()]; if (bm === undefined) aemcp.fail("Unknown blending mode " + args.blendingMode); l.blendingMode = bm; }
if (args.trackMatte) {
  var tt = TrackMatteType[args.trackMatte.type];
  if (args.trackMatte.layer !== undefined && l.setTrackMatte) l.setTrackMatte(aemcp.findLayer(c, args.trackMatte.layer), tt);
  else if (tt === TrackMatteType.NO_TRACK_MATTE && l.removeTrackMatte) l.removeTrackMatte();
  else l.trackMatteType = tt;
}
if (args.moveTo !== undefined) { if (args.moveTo <= 1) l.moveToBeginning(); else if (args.moveTo >= c.numLayers) l.moveToEnd(); else if (args.moveTo < l.index) l.moveBefore(c.layer(args.moveTo)); else if (args.moveTo > l.index) l.moveAfter(c.layer(args.moveTo)); }
if (args.locked !== undefined) l.locked = args.locked; else if (wasLocked) l.locked = true;
return aemcp.layerInfo(l, false);`,
  },
  {
    name: "ae_delete_layers",
    title: "Delete layers",
    description: "Delete layers from a composition.",
    input: { comp: compRef, layers: z.array(layerRef).min(1) },
    destructive: true,
    jsx: `
var c = aemcp.findComp(args.comp), ls = [], names = [];
for (var i = 0; i < args.layers.length; i++) ls.push(aemcp.findLayer(c, args.layers[i]));
for (var j = 0; j < ls.length; j++) { names.push(ls[j].name); ls[j].locked = false; ls[j].remove(); }
return { removed: names };`,
  },
  {
    name: "ae_duplicate_layer",
    title: "Duplicate layer",
    description: "Duplicate a layer (placed above the original), optionally renaming it.",
    input: { comp: compRef, layer: layerRef, newName: z.string().optional() },
    jsx: `var c = aemcp.findComp(args.comp), d = aemcp.findLayer(c, args.layer).duplicate(); if (args.newName) d.name = args.newName; return aemcp.layerInfo(d, false);`,
  },
  {
    name: "ae_split_layer",
    title: "Split layer",
    description: "Split a layer at a time (like Edit > Split Layer). Returns the new layer.",
    input: { comp: compRef, layer: layerRef, time: z.number() },
    jsx: `var c = aemcp.findComp(args.comp), l = aemcp.findLayer(c, args.layer); var d = l.duplicate(); l.outPoint = args.time; d.inPoint = args.time; return { first: aemcp.layerInfo(l, false), second: aemcp.layerInfo(d, false) };`,
  },
  {
    name: "ae_get_selection",
    title: "Get selection",
    description: "What the user has selected: project items, and in the active comp the selected layers and selected properties (with paths).",
    input: {},
    readOnly: true,
    jsx: `
var o = { items: [], comp: null, layers: [], properties: [] };
for (var i = 0; i < app.project.selection.length; i++) o.items.push(aemcp.itemInfo(app.project.selection[i]));
var c = app.project.activeItem;
if (c && c instanceof CompItem) {
  o.comp = { id: c.id, name: c.name, time: c.time };
  for (var j = 0; j < c.selectedLayers.length; j++) o.layers.push(aemcp.layerInfo(c.selectedLayers[j], false));
  var sp = c.selectedProperties;
  for (var k = 0; k < sp.length; k++) {
    var p = sp[k], path = [];
    var q = p; while (q && q.parentProperty) { path.unshift(q.name); q = q.parentProperty; }
    o.properties.push({ layer: q ? q.name : null, path: path.join("/"), matchName: p.matchName, isGroup: p.propertyType !== PropertyType.PROPERTY });
  }
}
return o;`,
  },
  {
    name: "ae_select_layers",
    title: "Select layers",
    description: "Select layers in a composition (deselects others unless add is true).",
    input: { comp: compRef, layers: z.array(layerRef), add: z.boolean().optional() },
    uiState: true,
    readOnly: true,
    jsx: `
var c = aemcp.findComp(args.comp);
if (!args.add) for (var i = 1; i <= c.numLayers; i++) c.layer(i).selected = false;
for (var j = 0; j < args.layers.length; j++) aemcp.findLayer(c, args.layers[j]).selected = true;
return { selected: c.selectedLayers.length };`,
  },
  {
    name: "ae_set_text",
    title: "Set text",
    description: "Change the text content and/or character/paragraph style of a text layer (optionally at a time, creating a keyframe).",
    input: { comp: compRef, layer: layerRef, text: z.string().optional(), ...textStyle, time: z.number().optional().describe("Set as a Source Text keyframe at this time.") },
    idempotent: true,
    jsx: `
var c = aemcp.findComp(args.comp), l = aemcp.findLayer(c, args.layer);
var p = l.property("ADBE Text Properties"); if (!p) aemcp.fail("Layer '" + l.name + "' is not a text layer");
p = p.property("ADBE Text Document");
var td = args.time !== undefined ? p.valueAtTime(args.time, false) : p.value;
aemcp.applyText(td, args);
if (args.time !== undefined) p.setValueAtTime(args.time, td); else if (p.numKeys) p.setValueAtTime(c.time, td); else p.setValue(td);
return aemcp.textInfo(p.value);`,
  },
];
