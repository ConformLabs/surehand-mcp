import { z } from "zod";
import { compRef, type JsxTool } from "./registry.js";

/**
 * Renders the queued items. args.only (render queue indexes; ae_versions_from_data, not in the tool's schema):
 * render just those; the other queued items are switched off while it renders, then queued again as they were.
 */
export const RENDER_QUEUE_JSX = `
var rq = app.project.renderQueue; if (rq.numItems === 0) aemcp.fail("Render queue is empty");
var off = [], want = null;
if (args.only) {
  want = {};
  for (var k = 0; k < args.only.length; k++) want["i" + args.only[k]] = true;
  for (var i0 = 1; i0 <= rq.numItems; i0++) { var q = rq.item(i0); if (!want["i" + i0] && q.render) { q.render = false; off.push(i0); } }
}
try { rq.render(); } finally { for (var j = 0; j < off.length; j++) { try { rq.item(off[j]).render = true; } catch (e) {} } }
var out = [];
for (var i = 1; i <= rq.numItems; i++) {
  if (want && !want["i" + i]) continue;
  var it = rq.item(i), f = it.outputModule(1).file;
  out.push({ index: i, comp: it.comp.name, status: aemcp.enumName(RQItemStatus, it.status), file: f ? f.fsName : null });
}
return out;`;

export const renderTools: JsxTool[] = [
  {
    name: "ae_list_render_queue",
    title: "List render queue",
    description: "List render queue items with status, output paths, and available render-settings / output-module templates.",
    input: {},
    readOnly: true,
    jsx: `
var rq = app.project.renderQueue, out = { rendering: rq.rendering, items: [], renderSettingsTemplates: [], outputModuleTemplates: [] };
for (var i = 1; i <= rq.numItems; i++) {
  var it = rq.item(i), o = { index: i, comp: it.comp.name, status: aemcp.enumName(RQItemStatus, it.status), render: it.render, outputs: [] };
  try { o.elapsedSeconds = it.elapsedSeconds; } catch (e) {}
  for (var j = 1; j <= it.numOutputModules; j++) { var om = it.outputModule(j); o.outputs.push({ file: om.file ? om.file.fsName : null, template: om.name }); }
  out.items.push(o);
}
if (rq.numItems > 0) { out.renderSettingsTemplates = rq.item(1).templates; out.outputModuleTemplates = rq.item(1).outputModule(1).templates; }
return out;`,
  },
  {
    name: "ae_add_to_render_queue",
    title: "Add to render queue",
    description: "Add a composition to the render queue with an output path and optional templates (see ae_list_render_queue for template names).",
    input: {
      comp: compRef,
      outputPath: z.string().optional().describe("Absolute output file path (extension should match the output module)."),
      renderSettingsTemplate: z.string().optional().describe('e.g. "Best Settings".'),
      outputModuleTemplate: z.string().optional().describe('e.g. "High Quality", "H.264 - Match Render Settings - 15 Mbps", "Lossless with Alpha".'),
      workAreaOnly: z.boolean().optional(),
    },
    jsx: `
var c = aemcp.findComp(args.comp), om = aemcp.addToRenderQueue(c, args).om;
return { index: app.project.renderQueue.numItems, comp: c.name, output: om.file ? om.file.fsName : null, template: om.name };`,
  },
  {
    name: "ae_get_render_settings",
    title: "Get render settings",
    description:
      "Read the exact render settings and output-module settings of a render queue item (resolution, quality, time span, frame rate, " +
      "motion blur, color depth, format, codec/video output, audio, resize, crop...), as editable key/value pairs for ae_set_render_settings.",
    input: { index: z.number().int().min(1).optional().describe("Render queue item (default: the last one).") },
    readOnly: true,
    jsx: `
var rq = app.project.renderQueue; if (!rq.numItems) aemcp.fail("Render queue is empty");
var it = rq.item(args.index || rq.numItems), oms = [];
for (var i = 1; i <= it.numOutputModules; i++) {
  var om = it.outputModule(i);
  oms.push({ index: i, template: om.name, file: om.file ? om.file.fsName : null, settings: om.getSettings(GetSettingsFormat.STRING_SETTABLE) });
}
return { index: args.index || rq.numItems, comp: it.comp.name, status: aemcp.enumName(RQItemStatus, it.status),
  renderSettings: it.getSettings(GetSettingsFormat.STRING_SETTABLE), outputModules: oms,
  renderSettingsTemplates: it.templates, outputModuleTemplates: it.outputModule(1).templates };`,
  },
  {
    name: "ae_set_render_settings",
    title: "Set render settings",
    description:
      "Change render settings and/or output-module settings of a render queue item using the keys from ae_get_render_settings " +
      '(e.g. renderSettings {"Quality": "Best", "Resolution": "Full", "Time Span": "Custom", "Time Span Start": "1.0"}; ' +
      'outputModule {"Output File Info": {"Full Flat Path": "/out/a.mov"}, "Format": "QuickTime"}). Returns the resulting settings.',
    input: {
      index: z.number().int().min(1).optional().describe("Render queue item (default: the last one)."),
      renderSettings: z.record(z.string(), z.any()).optional(),
      outputModule: z.record(z.string(), z.any()).optional(),
      outputModuleIndex: z.number().int().min(1).optional().describe("Default 1."),
      renderSettingsTemplate: z.string().optional().describe("Apply a template first."),
      outputModuleTemplate: z.string().optional().describe("Apply a template first."),
    },
    idempotent: true,
    jsx: `
var rq = app.project.renderQueue; if (!rq.numItems) aemcp.fail("Render queue is empty");
var it = rq.item(args.index || rq.numItems), om = it.outputModule(args.outputModuleIndex || 1);
if (args.renderSettingsTemplate) it.applyTemplate(args.renderSettingsTemplate);
if (args.outputModuleTemplate) om.applyTemplate(args.outputModuleTemplate);
if (args.renderSettings) it.setSettings(args.renderSettings);
if (args.outputModule) om.setSettings(args.outputModule);
return { comp: it.comp.name, renderSettings: it.getSettings(GetSettingsFormat.STRING_SETTABLE), outputModule: om.getSettings(GetSettingsFormat.STRING_SETTABLE), file: om.file ? om.file.fsName : null };`,
  },
  {
    name: "ae_queue_in_media_encoder",
    title: "Queue in Media Encoder",
    description: "Send the queued render queue items to Adobe Media Encoder (Composition > Add to Adobe Media Encoder Queue), optionally starting the encode.",
    input: { start: z.boolean().optional().describe("Start encoding immediately in Media Encoder (default false).") },
    destructive: true,
    noUndo: true,
    jsx: `
var rq = app.project.renderQueue;
if (!rq.numItems) aemcp.fail("Render queue is empty");
if (!rq.canQueueInAME) aemcp.fail("Media Encoder can't be used: it may not be installed, or no render queue item is queued");
rq.queueInAME(!!args.start);
return { sentToMediaEncoder: true, started: !!args.start };`,
  },
  {
    name: "ae_render_queue_start",
    title: "Start render",
    description:
      "Render all queued items (blocks After Effects until finished). Use timeoutSeconds for long renders. For background renders prefer aerender via a shell.",
    input: { timeoutSeconds: z.number().min(10).max(86400).optional().describe("Default 3600.") },
    destructive: true,
    timeoutMs: 3600 * 1000,
    noUndo: true,
    jsx: RENDER_QUEUE_JSX,
  },
  {
    name: "ae_clear_render_queue",
    title: "Clear render queue",
    description: "Remove items from the render queue (all, or only finished ones).",
    input: { onlyFinished: z.boolean().optional() },
    idempotent: true,
    destructive: true,
    jsx: `
var rq = app.project.renderQueue, n = 0;
for (var i = rq.numItems; i >= 1; i--) { var it = rq.item(i); if (!args.onlyFinished || it.status === RQItemStatus.DONE) { it.remove(); n++; } }
return { removed: n };`,
  },
];
