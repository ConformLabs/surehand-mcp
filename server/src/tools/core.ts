import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { health } from "../bridge.js";
import { lastSetup } from "../cli/setup.js";
import { checkForUpdate, updateMessage } from "../update.js";
import { VERSION } from "../config.js";
import { ensureHelpers, runJsx, userCodeBody } from "../jsx.js";
import { compRef, errorResult, formatResult } from "./registry.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a JSX body that saves a PNG (it receives args.tmpDir and returns {path, ...}),
 * wait until AE has finished writing it, and return it base64-encoded.
 */
async function renderPng(body: string, args: Record<string, unknown>): Promise<{ error: CallToolResult } | { info: any; data: string }> {
  // A folder both AE and this process can access (system temp dirs can be sandboxed per app on macOS)
  const tmpDir = join(homedir(), ".aemcp", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  // One undo group, so the temporary comps are created and removed in a single, invisible step
  // (otherwise Edit > Undo in AE could bring a temporary comp back).
  const r = await runJsx(body, { ...args, tmpDir }, { undoGroup: "AE MCP preview", timeoutMs: 180_000 });
  if (!r.ok) return { error: formatResult(r) };
  const info = r.result as any;
  // saveFrameToPng may finish writing asynchronously; wait for a stable non-empty file
  let last = -1;
  for (let i = 0; i < 150; i++) {
    if (existsSync(info.path)) {
      const size = statSync(info.path).size;
      if (size > 0 && size === last) break;
      last = size;
    }
    await sleep(100);
  }
  if (!existsSync(info.path)) return { error: errorResult(`After Effects did not write the image to ${info.path}`) };
  const data = readFileSync(info.path).toString("base64");
  if (!args.outputPath) {
    try {
      unlinkSync(info.path);
    } catch {}
  }
  return { info, data };
}

export function registerCoreTools(server: McpServer) {
  server.registerTool(
    "ae_run_script",
    {
      title: "Run ExtendScript",
      description:
        "Execute ExtendScript (JSX, ES3 JavaScript) inside After Effects and return the result. This is the most powerful tool: " +
        "anything in the After Effects scripting API is available (app, app.project, CompItem, layers, properties, render queue, File/Folder, system.callSystem...).\n" +
        "- The code runs as the body of a function: use `return value` to send data back. Returned AE objects (comps, layers, properties, items) are summarized to JSON automatically.\n" +
        "- `args` (the JSON you pass in `args`) and `log(...)` are available; log output is returned too.\n" +
        "- The `aemcp` helper library is available: aemcp.findComp(idOrName), aemcp.findLayer(comp, indexOrName), aemcp.findItem(ref), " +
        "aemcp.resolveProp(layer, 'Transform/Position'), aemcp.color('#ff0000'), aemcp.compInfo(comp, true), aemcp.layerInfo(layer, true), aemcp.propInfo(prop, {depth:2}), aemcp.projectInfo().\n" +
        "- ES3 only: use var (not let/const), no arrow functions, no template strings, no Array.map/forEach/filter, no JSON object (use aemcp.stringify).\n" +
        "- Collections are 1-based: app.project.item(1), comp.layer(1), prop.property(1).\n" +
        "- The whole script is one undo step. Read the 'aemcp://docs/extendscript' resource for an API cheat sheet.",
      inputSchema: {
        code: z.string().describe("ExtendScript source; function body, use `return` to return data."),
        args: z.record(z.string(), z.any()).optional().describe("JSON object exposed to the script as `args`."),
        undoGroup: z.string().optional().describe('Undo step name (default "AE MCP Script"). Pass "" to skip the undo group.'),
        depth: z.number().int().min(0).max(8).optional().describe("How deep to serialize the returned value (default 4)."),
        timeoutSeconds: z.number().min(1).max(3600).optional().describe("Max seconds to wait for the result (default 120)."),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ code, args, undoGroup, depth, timeoutSeconds }) => {
      try {
        const r = await runJsx(userCodeBody(code), args ?? {}, {
          undoGroup: undoGroup === "" ? false : undoGroup || "AE MCP Script",
          depth,
          timeoutMs: (timeoutSeconds ?? 120) * 1000,
        });
        return formatResult(r);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "ae_run_script_file",
    {
      title: "Run JSX file",
      description:
        "Run an existing .jsx/.jsxbin script file from disk inside After Effects (like File > Scripts > Run Script File). " +
        "`args` is exposed to the script as the global AEMCP_ARGS. Returns the value of the script's last expression.",
      inputSchema: {
        path: z.string().describe("Absolute path to the .jsx / .jsxbin file."),
        args: z.record(z.string(), z.any()).optional(),
        timeoutSeconds: z.number().min(1).max(3600).optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ path, args, timeoutSeconds }) => {
      try {
        if (!existsSync(path)) return errorResult(`File not found: ${path}`);
        const body =
          "var f = new File(args.path); if (!f.exists) aemcp.fail('File not found in AE: ' + args.path);\n" +
          "$.global.AEMCP_ARGS = args.args || {};\nreturn $.evalFile(f);";
        return formatResult(await runJsx(body, { path, args: args ?? {} }, { undoGroup: "AE MCP Script File", timeoutMs: (timeoutSeconds ?? 300) * 1000 }));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "ae_status",
    {
      title: "After Effects status",
      description: "Check the connection to After Effects and get app version, OS, open project and active item. Call this first if unsure AE is reachable.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const h = await health();
        const r = await runJsx(
          "return { appVersion: app.version, buildName: app.buildName, language: String(app.isoLanguage), os: $.os, extendScriptVersion: $.version, " +
            "memoryInUse: app.memoryInUse, isRenderEngine: app.isRenderEngine, project: aemcp.projectInfo(), " +
            "canWriteFiles: (function(){ try { return app.preferences.getPrefAsLong('Main Pref Section', 'Pref_SCRIPTING_FILE_NETWORK_SECURITY') === 1; } catch (e) { return null; } })() };",
          {},
          { undoGroup: false },
        );
        const out = formatResult(r);
        if (r.ok && (r.result as any)?.canWriteFiles === false)
          out.content.push({
            type: "text",
            text:
              "WARNING: 'Allow Scripts to Write Files and Access Network' is OFF in After Effects, so scripts cannot write files (frame previews, exports, File.write). " +
              "Ask the user to enable it: After Effects > Settings > Scripting & Expressions (Windows: Edit > Preferences > Scripting & Expressions).",
          });
        out.content.unshift({ type: "text", text: `Connected to After Effects bridge v${h.version} (MCP server v${VERSION}).` });
        const upd = updateMessage(await checkForUpdate());
        if (upd) out.content.push({ type: "text", text: `${upd}\nTell the user about this update.` });
        if (lastSetup?.extensionUpdated)
          out.content.push({ type: "text", text: "Note: the After Effects extension was updated on disk; ask the user to restart After Effects when convenient to load the new version." });
        return out;
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "ae_reload_helpers",
    {
      title: "Reload helper library",
      description: "Force re-loading the aemcp ExtendScript helper library into After Effects (normally automatic).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        await ensureHelpers();
        return { content: [{ type: "text", text: "aemcp helpers loaded." }] };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "ae_render_frame",
    {
      title: "Preview frame",
      description:
        "Render a single frame of a composition to PNG and return it as an image, so you can SEE the result of your changes. " +
        "Large comps are downscaled to maxSize. Optionally also keep the PNG at outputPath.",
      inputSchema: {
        comp: compRef,
        time: z.number().optional().describe("Time in seconds (default: the comp's current time)."),
        maxSize: z.number().int().min(64).max(4096).optional().describe("Longest side in pixels of the returned image (default 1280)."),
        outputPath: z.string().optional().describe("Optional absolute path to also save the PNG to."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ comp, time, maxSize, outputPath }) => {
      try {
        const body = `
var c = aemcp.findComp(args.comp);
var t = args.time === undefined ? c.time : args.time;
var max = args.maxSize || 1280;
var target = c, tmp = null;
var scale = Math.min(1, max / Math.max(c.width, c.height));
if (scale < 1) {
  var w = Math.max(4, Math.round(c.width * scale)), h = Math.max(4, Math.round(c.height * scale));
  tmp = app.project.items.addComp("__aemcp_preview", w, h, 1, c.duration, c.frameRate);
  tmp.displayStartTime = c.displayStartTime;
  var l = tmp.layers.add(c);
  l.property("ADBE Transform Group").property("ADBE Scale").setValue([scale * 100 * c.pixelAspect, scale * 100, 100]);
  l.property("ADBE Transform Group").property("ADBE Position").setValue([w / 2, h / 2]);
  l.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([c.width / 2, c.height / 2]);
  target = tmp;
}
try {
  var f = new File(args.outputPath || (args.tmpDir + "/aemcp_frame_" + new Date().getTime() + ".png"));
  if (f.exists) f.remove();
  target.saveFrameToPng(t, f);
  var info = { path: f.fsName, width: target.width, height: target.height, time: t, comp: c.name };
  var waited = 0; while (!f.exists && waited < 10000) { $.sleep(50); waited += 50; }
  if (tmp) $.sleep(100);
} finally {
  // never leave the temporary comp behind, even if rendering fails
  if (tmp) try { tmp.remove(); } catch (e) {}
}
return info;`;
        const out = await renderPng(body, { comp, time, maxSize, outputPath });
        if ("error" in out) return out.error;
        const { info, data } = out;
        return {
          content: [
            { type: "image", data, mimeType: "image/png" },
            { type: "text", text: `Frame of "${info.comp}" at ${info.time}s (${info.width}x${info.height})${outputPath ? ` saved to ${info.path}` : ""}` },
          ],
        };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "ae_render_contact_sheet",
    {
      title: "Preview animation (contact sheet)",
      description:
        "Render several frames of a composition into ONE image (a grid, each cell labelled with its time and frame number), " +
        "so you can judge motion, timing and easing, not just a single frame. Defaults to 9 frames spread over the work area.",
      inputSchema: {
        comp: compRef,
        frames: z.number().int().min(2).max(36).optional().describe("Number of evenly spaced frames (default 9)."),
        start: z.number().optional().describe("Start time in seconds (default: work area start)."),
        end: z.number().optional().describe("End time in seconds (default: work area end)."),
        times: z.array(z.number()).min(1).max(36).optional().describe("Exact times (seconds) instead of evenly spaced frames."),
        columns: z.number().int().min(1).max(12).optional().describe("Grid columns (default: square-ish)."),
        width: z.number().int().min(320).max(4096).optional().describe("Width of the returned image in pixels (default 1600)."),
        outputPath: z.string().optional().describe("Optional absolute path to also save the PNG to."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const body = `
var c = aemcp.findComp(args.comp);
var fd = c.frameDuration, times = [];
if (args.times) { for (var k = 0; k < args.times.length; k++) times.push(args.times[k]); }
else {
  var n = args.frames || 9;
  var t0 = args.start !== undefined ? args.start : c.workAreaStart;
  var t1 = args.end !== undefined ? args.end : c.workAreaStart + c.workAreaDuration;
  if (t1 <= t0) aemcp.fail("end must be after start");
  var last = Math.max(t0, t1 - fd);
  for (var i = 0; i < n; i++) times.push(t0 + (last - t0) * i / (n - 1));
}
for (var q = 0; q < times.length; q++) times[q] = Math.max(0, Math.min(c.duration - fd, Math.round(times[q] / fd) * fd));
var count = times.length;
var cols = args.columns || Math.ceil(Math.sqrt(count)), rows = Math.ceil(count / cols);
var W = args.width || 1600, gap = 8, labelH = 26;
var cellW = Math.floor((W - gap * (cols + 1)) / cols);
var cellH = Math.round(cellW * c.height / (c.width * c.pixelAspect));
var H = rows * (cellH + labelH + gap) + gap;
var sheet = app.project.items.addComp("__aemcp_contact_sheet", W, H, 1, 1, c.frameRate);
try {
  // opaque dark background (a shape layer, so no solid is left in the project)
  var bg = sheet.layers.addShape();
  var bgv = bg.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group").property("ADBE Vectors Group");
  bgv.addProperty("ADBE Vector Shape - Rect").property("ADBE Vector Rect Size").setValue([W, H]);
  bgv.addProperty("ADBE Vector Graphic - Fill").property("ADBE Vector Fill Color").setValue([0.09, 0.09, 0.1]);
  bg.property("ADBE Transform Group").property("ADBE Position").setValue([W / 2, H / 2]);
  var sc = cellW / (c.width * c.pixelAspect) * 100;
  for (var j = 0; j < count; j++) {
    var col = j % cols, row = Math.floor(j / cols);
    var x0 = gap + col * (cellW + gap), y0 = gap + row * (cellH + labelH + gap);
    var l = sheet.layers.add(c);
    l.startTime = -times[j];
    var tr = l.property("ADBE Transform Group");
    tr.property("ADBE Anchor Point").setValue([c.width / 2, c.height / 2]);
    tr.property("ADBE Scale").setValue([sc, sc, 100]);
    tr.property("ADBE Position").setValue([x0 + cellW / 2, y0 + cellH / 2]);
    var t = sheet.layers.addText((Math.round(times[j] * 100) / 100) + "s  \u00b7  f" + Math.round(times[j] / fd));
    var src = t.property("ADBE Text Properties").property("ADBE Text Document"), td = src.value;
    try { td.font = "ArialMT"; } catch (e) {}
    td.fontSize = 15; td.applyFill = true; td.fillColor = [0.85, 0.85, 0.85]; td.applyStroke = false;
    try { td.fauxBold = false; td.fauxItalic = false; td.allCaps = false; td.tracking = 0; } catch (e) {}
    td.justification = ParagraphJustification.CENTER_JUSTIFY;
    src.setValue(td);
    // center the label under its cell using its real bounds (independent of AE's last-used text settings)
    var rc = t.sourceRectAtTime(0, false), ttr = t.property("ADBE Transform Group");
    ttr.property("ADBE Anchor Point").setValue([rc.left + rc.width / 2, rc.top + rc.height / 2]);
    ttr.property("ADBE Position").setValue([x0 + cellW / 2, y0 + cellH + labelH / 2]);
    t.moveToBeginning();
  }
  var f = new File(args.outputPath || (args.tmpDir + "/aemcp_sheet_" + new Date().getTime() + ".png"));
  if (f.exists) f.remove();
  sheet.saveFrameToPng(0, f);
  var waited = 0; while (!f.exists && waited < 20000) { $.sleep(50); waited += 50; }
  $.sleep(150);
  var r = { path: f.fsName, comp: c.name, times: times, columns: cols, rows: rows, width: W, height: H };
} finally { sheet.remove(); }
return r;`;
        const out = await renderPng(body, args);
        if ("error" in out) return out.error;
        const { info, data } = out;
        return {
          content: [
            { type: "image", data, mimeType: "image/png" },
            {
              type: "text",
              text: `Contact sheet of "${info.comp}": ${info.times.length} frames (${info.columns}x${info.rows}, left-to-right, top-to-bottom) at ` +
                `${info.times.map((t: number) => Math.round(t * 100) / 100 + "s").join(", ")}${args.outputPath ? `; saved to ${info.path}` : ""}`,
            },
          ],
        };
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
