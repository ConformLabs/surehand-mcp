import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { health } from "../bridge.js";
import { lastSetup } from "../cli/setup.js";
import { VERSION } from "../config.js";
import { ensureHelpers, runJsx, userCodeBody } from "../jsx.js";
import { compRef, errorResult, formatResult } from "./registry.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
var f = new File(args.outputPath || (args.tmpDir + "/aemcp_frame_" + new Date().getTime() + ".png"));
if (f.exists) f.remove();
target.saveFrameToPng(t, f);
var info = { path: f.fsName, width: target.width, height: target.height, time: t, comp: c.name };
var waited = 0; while (!f.exists && waited < 10000) { $.sleep(50); waited += 50; }
if (tmp) { $.sleep(100); tmp.remove(); }
return info;`;
        // A folder both AE and this process can access (system temp dirs can be sandboxed per app on macOS)
        const tmpDir = join(homedir(), ".aemcp", "tmp");
        mkdirSync(tmpDir, { recursive: true });
        const r = await runJsx(body, { comp, time, maxSize, outputPath, tmpDir }, { undoGroup: false, timeoutMs: 120_000 });
        if (!r.ok) return formatResult(r);
        const info = r.result as { path: string; width: number; height: number; time: number; comp: string };
        // saveFrameToPng may finish writing asynchronously; wait for a stable non-empty file
        let last = -1;
        for (let i = 0; i < 100; i++) {
          if (existsSync(info.path)) {
            const size = statSync(info.path).size;
            if (size > 0 && size === last) break;
            last = size;
          }
          await sleep(100);
        }
        if (!existsSync(info.path)) return errorResult(`After Effects did not write the frame to ${info.path}`);
        const data = readFileSync(info.path).toString("base64");
        if (!outputPath) {
          try {
            unlinkSync(info.path);
          } catch {}
        }
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
}
