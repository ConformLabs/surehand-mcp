import { z } from "zod";
import { colorSchema, compRef, itemRef, layerRef, type JsxTool } from "./registry.js";

export const compTools: JsxTool[] = [
  {
    name: "ae_list_comps",
    title: "List compositions",
    description: "List all compositions with id, size, duration, frame rate and layer count.",
    input: { nameContains: z.string().optional() },
    readOnly: true,
    jsx: `
var out = [], q = args.nameContains ? String(args.nameContains).toLowerCase() : null;
for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof CompItem && (!q || it.name.toLowerCase().indexOf(q) >= 0)) out.push(aemcp.itemInfo(it)); }
return out;`,
  },
  {
    name: "ae_get_comp_info",
    title: "Get composition info",
    description:
      "Composition settings plus a summary of its layers (index, id, name, type, timing, parent, switches). " +
      "Large comps are paged: use layerOffset/layerLimit (see totalLayers / nextLayerOffset in the result).",
    input: {
      comp: compRef,
      includeLayers: z.boolean().optional().describe("Default true."),
      layerOffset: z.number().int().min(0).optional().describe("Skip this many layers (default 0)."),
      layerLimit: z.number().int().min(1).max(1000).optional().describe("Max layers to return (default 150)."),
    },
    readOnly: true,
    jsx: `
var c = aemcp.findComp(args.comp), o = aemcp.compInfo(c, false);
o.markers = aemcp.markers(c.markerProperty);
if (args.includeLayers !== false) {
  var off = args.layerOffset || 0, lim = args.layerLimit || 150, end = Math.min(c.numLayers, off + lim);
  o.layers = [];
  for (var i = off + 1; i <= end; i++) o.layers.push(aemcp.layerInfo(c.layer(i), false));
  o.totalLayers = c.numLayers;
  if (end < c.numLayers) o.nextLayerOffset = end;
}
return o;`,
  },
  {
    name: "ae_create_comp",
    title: "Create composition",
    description: "Create a new composition and (by default) open it in the viewer.",
    input: {
      name: z.string(),
      width: z.number().int().min(4).max(30000).optional().describe("Default 1920."),
      height: z.number().int().min(4).max(30000).optional().describe("Default 1080."),
      duration: z.number().min(0.01).optional().describe("Seconds, default 10."),
      frameRate: z.number().min(1).max(999).optional().describe("Default 30."),
      pixelAspect: z.number().optional().describe("Default 1."),
      bgColor: colorSchema.optional(),
      folder: itemRef.optional(),
      open: z.boolean().optional().describe("Open in viewer (default true)."),
    },
    jsx: `
var c = app.project.items.addComp(args.name, args.width || 1920, args.height || 1080, args.pixelAspect || 1, args.duration || 10, args.frameRate || 30);
if (args.bgColor) c.bgColor = aemcp.color3(args.bgColor);
if (args.folder !== undefined) c.parentFolder = aemcp.findItem(args.folder);
if (args.open !== false) c.openInViewer();
return aemcp.compInfo(c, false);`,
  },
  {
    name: "ae_set_comp_settings",
    title: "Set composition settings",
    description: "Change composition settings: name, size, duration, frame rate, background, work area, current time, motion blur, renderer, start timecode.",
    input: {
      comp: compRef,
      name: z.string().optional(),
      width: z.number().int().optional(),
      height: z.number().int().optional(),
      pixelAspect: z.number().optional(),
      duration: z.number().optional(),
      frameRate: z.number().optional(),
      bgColor: colorSchema.optional(),
      workAreaStart: z.number().optional(),
      workAreaDuration: z.number().optional(),
      time: z.number().optional().describe("Move the current-time indicator (seconds)."),
      displayStartTime: z.number().optional(),
      motionBlur: z.boolean().optional(),
      shutterAngle: z.number().optional(),
      renderer: z.string().optional().describe('e.g. "ADBE Advanced 3d" (Classic 3D), "ADBE Ernst" (Cinema 4D), "ADBE Calder" (Advanced 3D).'),
      resolutionFactor: z.array(z.number().int()).length(2).optional().describe("Preview resolution, [1,1]=Full, [2,2]=Half."),
    },
    idempotent: true,
    jsx: `
var c = aemcp.findComp(args.comp), keys = ["name","width","height","pixelAspect","duration","frameRate","displayStartTime","motionBlur","shutterAngle","renderer","resolutionFactor"];
for (var i = 0; i < keys.length; i++) if (args[keys[i]] !== undefined) c[keys[i]] = args[keys[i]];
if (args.bgColor) c.bgColor = aemcp.color3(args.bgColor);
if (args.workAreaStart !== undefined) c.workAreaStart = args.workAreaStart;
if (args.workAreaDuration !== undefined) c.workAreaDuration = args.workAreaDuration;
if (args.time !== undefined) c.time = args.time;
return aemcp.compInfo(c, false);`,
  },
  {
    name: "ae_duplicate_comp",
    title: "Duplicate composition",
    description: "Duplicate a composition (layers reference the same sources).",
    input: { comp: compRef, newName: z.string().optional() },
    jsx: `var c = aemcp.findComp(args.comp).duplicate(); if (args.newName) c.name = args.newName; return aemcp.compInfo(c, false);`,
  },
  {
    name: "ae_open_comp",
    title: "Open composition",
    description: "Open a composition in the Composition viewer / timeline and make it active.",
    input: { comp: compRef },
    uiState: true,
    readOnly: true,
    jsx: `var c = aemcp.findComp(args.comp); c.openInViewer(); return { opened: c.name, id: c.id };`,
  },
  {
    name: "ae_precompose",
    title: "Pre-compose layers",
    description: "Pre-compose the given layers into a new composition.",
    input: {
      comp: compRef,
      layers: z.array(layerRef).min(1),
      name: z.string(),
      moveAllAttributes: z.boolean().optional().describe("Default true. false = leave attributes in the original comp (single layer only)."),
      open: z.boolean().optional(),
    },
    jsx: `
var c = aemcp.findComp(args.comp), idx = [];
for (var i = 0; i < args.layers.length; i++) idx.push(aemcp.findLayer(c, args.layers[i]).index);
var nc = c.layers.precompose(idx, args.name, args.moveAllAttributes !== false);
if (args.open) nc.openInViewer();
return aemcp.compInfo(nc, true);`,
  },
  {
    name: "ae_add_comp_marker",
    title: "Add marker",
    description: "Add a marker to the composition, or to a layer if `layer` is given.",
    input: {
      comp: compRef,
      layer: layerRef.optional(),
      time: z.number().describe("Seconds."),
      comment: z.string().optional(),
      duration: z.number().optional(),
      chapter: z.string().optional(),
      label: z.number().int().min(0).max(16).optional(),
    },
    jsx: `
var c = aemcp.findComp(args.comp);
var mp = args.layer !== undefined ? aemcp.findLayer(c, args.layer).property("ADBE Marker") : c.markerProperty;
var m = new MarkerValue(args.comment || "");
if (args.duration) m.duration = args.duration;
if (args.chapter) m.chapter = args.chapter;
if (args.label !== undefined) { try { m.label = args.label; } catch (e) {} }
mp.setValueAtTime(args.time, m);
return aemcp.markers(mp);`,
  },
];
