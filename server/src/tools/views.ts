// In-chat views (MCP Apps, spec 2026-01-26): HTML pages that AI apps such as Claude Desktop, ChatGPT, VS Code
// and Cursor show in the chat for a tool's result. A tool names its view in _meta.ui.resourceUri; the view
// gets the result (its data is in the result's _meta, src/views/types.ts) and may call the app-only tools
// below, which only navigate and look: they never change the project. Every edit goes through the chat.
// AI apps without views (Claude Code, Windsurf, LM Studio) get the same text as always, and never see the
// app-only tools: they are turned on only for an AI app that says it shows views (profile.ts).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getUiCapability, registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { z } from "zod";
import { BridgeError } from "../bridge.js";
import { runJsx } from "../jsx.js";
import { downscale, encodeJpeg } from "../jpeg.js";
import { appFile } from "../paths.js";
import { decodePng } from "../png.js";
import { timecode } from "../preflight/report.js";
import { withFonts } from "../views/fonts.js";
import { VIEW_ERROR_KEY, VIEW_META_KEY, type FrameView } from "../views/types.js";
import { waitForFile } from "./core.js";
import { enableViewTools } from "./profile.js";
import { compRef, errorResult, formatResult, layerRef } from "./registry.js";

export const PREFLIGHT_VIEW_URI = "ui://surehand/preflight.html";

/** The views: name (src/views/<name>.ts) -> resource. */
export const VIEWS: Record<string, { uri: string; title: string; description: string }> = {
  preflight: { uri: PREFLIGHT_VIEW_URI, title: "Preflight report", description: "The Preflight verdict, a timeline of the findings, and each finding's frame." },
};

let unpacked: Record<string, string> | undefined;
/** The built views (scripts/views.mjs), brotli-compressed in the bundle: the views share most of their code. */
function builtViews(): Record<string, string> {
  unpacked ??= JSON.parse(brotliDecompressSync(Buffer.from(__SUREHAND_VIEWS__, "base64")).toString("utf8"));
  return unpacked!;
}

/** A view's complete HTML document, with the extension's fonts (embedded in the bundle once, for both). */
export function viewHtml(name: string, readFont: (file: string) => string | undefined = (f) => __AEMCP_CEP_BINARY__[`fonts/${f}`]): string {
  const html = builtViews()[name];
  if (!html) throw new Error(`no view "${name}"`);
  return withFonts(html, readFont);
}

/** registerTool for a tool with a view, or an app-only tool (MCP Apps _meta.ui, normalised by the ext-apps SDK). */
export const registerViewTool: (server: McpServer, name: string, config: any, cb: (args: any, extra: any) => any) => unknown = (server, name, config, cb) =>
  registerAppTool(server, name, config, cb as any);

/** An error result that also says, for a view, whether After Effects isn't reachable or is busy (VIEW_ERROR_KEY). */
export function viewError(e: unknown): CallToolResult {
  const out = errorResult(e);
  if (e instanceof BridgeError) out._meta = { [VIEW_ERROR_KEY]: e.code };
  return out;
}

/** The AI app shows in-chat views (MCP Apps), from the capabilities it sent at initialize. */
export function supportsViews(capabilities: unknown): boolean {
  const ui = getUiCapability(capabilities as any);
  return !!ui && (!ui.mimeTypes || ui.mimeTypes.includes(RESOURCE_MIME_TYPE));
}

// The HTTP server is stateless (a new server per request), so the request that says the AI app shows views is
// not the one that lists tools: index.ts notes it here for the process (HTTP is for one AI app, ChatGPT, at a
// time). Over stdio there is one server per AI app and it reads the capabilities at initialize.
let viewClientSeen = false;
export function noteViewClient(capabilities: unknown) {
  if (supportsViews(capabilities)) viewClientSeen = true;
}

/** Turn the view tools on when the AI app shows views (at initialize, or already seen over HTTP). */
export function watchViewClient(server: McpServer) {
  if (viewClientSeen) enableViewTools(server);
  const inner = server.server as any;
  const before = inner.oninitialized;
  inner.oninitialized = () => {
    try {
      before?.();
    } catch {}
    if (supportsViews(inner.getClientCapabilities?.())) enableViewTools(server);
  };
}

// ---------- the app-only tools: navigation and looking only ----------

// Opens the comp, moves its time indicator, selects one layer. Read-only for the project (as ae_open_comp /
// ae_select_layers): no undo group, nothing that Edit > Undo would list.
export const REVEAL_JSX = `
var c = aemcp.findComp(args.comp);
c.openInViewer();
if (args.time !== undefined && args.time !== null) c.time = Math.max(0, Math.min(c.duration, args.time));
var sel = null;
if (args.layer !== undefined && args.layer !== null) {
  var L = aemcp.findLayer(c, args.layer);
  for (var i = 1; i <= c.numLayers; i++) { try { if (c.layer(i).selected && i !== L.index) c.layer(i).selected = false; } catch (e) {} }
  try { L.selected = true; sel = L.name; } catch (e) { sel = null; }
}
return { comp: c.name, id: c.id, time: c.time, fps: c.frameRate, dst: c.displayStartTime, df: !!c.dropFrame, layer: sel };`;

// Saves the comp's own frame as a PNG (CompItem.saveFrameToPng): no temporary comp, no undo step, nothing to roll back.
export const FRAME_JSX = `
var c = aemcp.findComp(args.comp);
var t = args.time === undefined || args.time === null ? c.time : args.time;
t = Math.max(0, Math.min(c.duration - c.frameDuration, t));
var f = new File(args.tmpDir + "/aemcp_view_" + new Date().getTime() + ".png");
if (f.exists) f.remove();
c.saveFrameToPng(t, f);
var waited = 0; while (!f.exists && waited < 10000) { $.sleep(50); waited += 50; }
return { path: f.fsName, comp: c.name, time: t, width: c.width, height: c.height, par: c.pixelAspect };`;

/** The still's size: the comp's display aspect (pixel aspect applied), its longest side at most `max`. */
export function stillSize(w: number, h: number, par: number, max: number): { width: number; height: number } {
  const dispW = w * (par || 1), fit = Math.min(1, max / Math.max(dispW, h));
  return { width: Math.max(1, Math.round(dispW * fit)), height: Math.max(1, Math.round(h * fit)) };
}

const secs = (s: number) => `${Math.round(s * 100) / 100} s`;

export function registerViews(server: McpServer) {
  for (const [name, v] of Object.entries(VIEWS))
    registerAppResource(server, v.title, v.uri, { description: v.description, _meta: { ui: { prefersBorder: false } } }, async () => ({
      contents: [{ uri: v.uri, mimeType: RESOURCE_MIME_TYPE, text: viewHtml(name), _meta: { ui: { prefersBorder: false } } }],
    }));

  registerViewTool(
    server,
    "ae_view_reveal",
    {
      title: "Show in After Effects",
      description: "For the in-chat views: open a comp in the viewer, move to a time and select a layer. Navigation only; changes nothing in the project.",
      inputSchema: {
        comp: compRef,
        time: z.number().optional().describe("Time in seconds from the comp's start."),
        layer: layerRef.optional(),
      },
      // changes what the user sees (viewer, time, selection), never the project
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args: Record<string, any>) => {
      try {
        const r = await runJsx(REVEAL_JSX, args, { undoGroup: false, timeoutMs: 30_000 });
        if (!r.ok) return formatResult(r);
        const x = r.result as { comp: string; time: number; fps: number; dst: number; df: boolean; layer: string | null };
        const at = `${timecode(x.time, x.fps, x.df, x.dst)} (${secs(x.time)})`;
        return { content: [{ type: "text", text: `Showed "${x.comp}" at ${at}${x.layer ? `, layer "${x.layer}" selected` : ""}.` }] };
      } catch (e) {
        return viewError(e);
      }
    },
  );

  registerViewTool(
    server,
    "ae_view_frame",
    {
      title: "Frame for a view",
      description: "For the in-chat views: one small still (JPEG, about 480 px) of a comp at a time. Changes nothing in the project.",
      inputSchema: {
        comp: compRef,
        time: z.number().optional().describe("Time in seconds from the comp's start (default: the comp's current time)."),
        maxSize: z.number().int().min(64).max(960).optional().describe("Longest side of the still in pixels (default 480)."),
      },
      // writes (and removes) a temporary PNG; the project is not touched
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args: Record<string, any>) => {
      let path: string | undefined;
      try {
        // a folder both AE and this process can access (as ae_render_frame)
        const tmpDir = appFile("tmp");
        mkdirSync(tmpDir, { recursive: true });
        const r = await runJsx(FRAME_JSX, { comp: args.comp, time: args.time, tmpDir }, { undoGroup: false, timeoutMs: 120_000 });
        if (!r.ok) return formatResult(r);
        const x = r.result as { path: string; comp: string; time: number; width: number; height: number; par: number };
        path = x.path;
        if (!(await waitForFile(x.path))) return errorResult(`After Effects did not write the frame to ${x.path}`);
        const size = stillSize(x.width, x.height, x.par, args.maxSize ?? 480);
        const jpeg = encodeJpeg(size.width, size.height, downscale(decodePng(readFileSync(x.path)), size.width, size.height), 80);
        const view: FrameView = { view: "frame", comp: x.comp, time: x.time, compWidth: x.width, compHeight: x.height, ...size };
        return {
          content: [
            { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" },
            { type: "text", text: `Frame of "${x.comp}" at ${secs(x.time)} (${size.width}x${size.height}).` },
          ],
          _meta: { [VIEW_META_KEY]: view },
        };
      } catch (e) {
        return viewError(e);
      } finally {
        if (path)
          try {
            unlinkSync(path);
          } catch {}
      }
    },
  );
}
