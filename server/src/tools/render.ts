import { z } from "zod";
import { compRef, type JsxTool } from "./registry.js";

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
var c = aemcp.findComp(args.comp), it = app.project.renderQueue.items.add(c);
if (args.renderSettingsTemplate) it.applyTemplate(args.renderSettingsTemplate);
var om = it.outputModule(1);
if (args.outputModuleTemplate) om.applyTemplate(args.outputModuleTemplate);
if (args.outputPath) om.file = new File(args.outputPath);
if (args.workAreaOnly === false) { it.timeSpanStart = 0; it.timeSpanDuration = c.duration; }
return { index: app.project.renderQueue.numItems, comp: c.name, output: om.file ? om.file.fsName : null, template: om.name };`,
  },
  {
    name: "ae_render_queue_start",
    title: "Start render",
    description:
      "Render all queued items (blocks After Effects until finished). Use timeoutSeconds for long renders. For background renders prefer aerender via a shell.",
    input: { timeoutSeconds: z.number().min(10).max(86400).optional().describe("Default 3600.") },
    timeoutMs: 3600 * 1000,
    noUndo: true,
    jsx: `
var rq = app.project.renderQueue; if (rq.numItems === 0) aemcp.fail("Render queue is empty");
rq.render();
var out = []; for (var i = 1; i <= rq.numItems; i++) out.push({ comp: rq.item(i).comp.name, status: aemcp.enumName(RQItemStatus, rq.item(i).status), file: rq.item(i).outputModule(1).file ? rq.item(i).outputModule(1).file.fsName : null });
return out;`,
  },
  {
    name: "ae_clear_render_queue",
    title: "Clear render queue",
    description: "Remove items from the render queue (all, or only finished ones).",
    input: { onlyFinished: z.boolean().optional() },
    destructive: true,
    jsx: `
var rq = app.project.renderQueue, n = 0;
for (var i = rq.numItems; i >= 1; i--) { var it = rq.item(i); if (!args.onlyFinished || it.status === RQItemStatus.DONE) { it.remove(); n++; } }
return { removed: n };`,
  },
];
