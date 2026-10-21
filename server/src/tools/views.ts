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
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { z } from "zod";
import { BridgeError } from "../bridge.js";
import { runJsx } from "../jsx.js";
import { amplifiedDiff, downscale, encodeJpeg } from "../jpeg.js";
import { appFile } from "../paths.js";
import { decodePng } from "../png.js";
import { timecode } from "../preflight/report.js";
import { withFonts } from "../views/fonts.js";
import { STRESS_VIEW_URI, VIEW_ERROR_KEY, VIEW_META_KEY, XRAY_VIEW_URI, type FrameView } from "../views/types.js";
import { stressFramePath } from "../stress/files.js";
import { xrayNodeView } from "./xray-view.js";
import { RENDER_KIT_JSX, renderCleanupNote, runRender, waitForFiles } from "./core.js";
import { enableViewTools } from "./profile.js";
import { afterDir, loadManifest, proofDir } from "./prove.js";
import { compRef, errorResult, formatResult, layerRef } from "./registry.js";

export const PREFLIGHT_VIEW_URI = "ui://surehand/preflight.html";
export const CHANGES_VIEW_URI = "ui://surehand/changes.html";

/** The views: name (src/views/<name>.ts) -> resource. */
export const VIEWS: Record<string, { uri: string; title: string; description: string }> = {
  preflight: { uri: PREFLIGHT_VIEW_URI, title: "Preflight report", description: "The Preflight verdict, a timeline of the findings, and each finding's frame." },
  xray: {
    uri: XRAY_VIEW_URI,
    title: "Project X-ray",
    description: "What renders, from the render queue down to the footage, with what's missing, fragile, heavy while hidden or unused.",
  },
  stress: {
    uri: STRESS_VIEW_URI,
    title: "Stress test",
    description: "Which worst-case inputs break a template: a grid of variants and checks, each failing frame marked, and the expressions that break in other After Effects languages.",
  },
  changes: {
    uri: CHANGES_VIEW_URI,
    title: "What changed, and the proof",
    description: "A proven edit's verdict with before, after and difference frames, and what changed in the project (also for the history diff).",
  },
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

// Opens the comp, moves its time indicator, selects one layer; or selects one project item (footage) in the
// Project panel. Read-only for the project (as ae_open_comp / ae_select_layers): no undo group, nothing that
// Edit > Undo would list.
export const REVEAL_JSX = `
if (args.item !== undefined && args.item !== null) {
  var P = app.project, found = null;
  for (var k = 1; k <= P.numItems; k++) {
    var x = P.item(k);
    if (x.id === args.item) found = x;
    else { try { if (x.selected) x.selected = false; } catch (e) {} }
  }
  if (!found) aemcp.fail("No project item with id " + args.item + " (it may have been removed).");
  found.selected = true;
  return { item: found.name, id: found.id };
}
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

// Saves the comp's own frame as a PNG (CompItem.saveFrameToPng, written after the script returns): no temporary
// comp. Only in a 32 bpc / linear blending project are the color settings changed for it (as ae_render_frame),
// and set back by hand once the file is written (runRender); otherwise nothing changes.
export const FRAME_JSX = `${RENDER_KIT_JSX}
var c = aemcp.findComp(args.comp);
var t = args.time === undefined || args.time === null ? c.time : args.time;
t = Math.max(0, Math.min(c.duration - c.frameDuration, t));
var f = new File(args.tmpDir + "/aemcp_view_" + new Date().getTime() + ".png");
if (f.exists) f.remove();
displayColor();
c.saveFrameToPng(t, f);
return { path: f.fsName, comp: c.name, time: t, width: c.width, height: c.height, par: c.pixelAspect, cleanup: __clean };`;

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
      description:
        "For the in-chat views: open a comp in the viewer, move to a time and select a layer; or select a project item (footage) in the " +
        "Project panel. Navigation only; changes nothing in the project.",
      inputSchema: {
        comp: compRef,
        time: z.number().optional().describe("Time in seconds from the comp's start."),
        layer: layerRef.optional(),
        item: z.number().int().optional().describe("Select this project item (id) in the Project panel instead of opening a comp."),
      },
      // changes what the user sees (viewer, time, selection), never the project
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args: Record<string, any>) => {
      try {
        const r = await runJsx(REVEAL_JSX, args, { undoGroup: false, timeoutMs: 30_000 });
        if (!r.ok) return formatResult(r);
        if (args.item !== undefined) return { content: [{ type: "text", text: `Selected "${(r.result as { item: string }).item}" in the Project panel.` }] };
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
        const { r, missing } = await runRender(FRAME_JSX, { comp: args.comp, time: args.time, tmpDir }, { undoGroup: "Surehand MCP frame", timeoutMs: 120_000 }, (x) => waitForFiles([x.path]));
        if (!r.ok) return formatResult(r);
        const x = r.result as { path: string; comp: string; time: number; width: number; height: number; par: number };
        path = x.path;
        const note = renderCleanupNote(r, false, "");
        if (missing.length) return errorResult(`After Effects did not write the frame to ${x.path}${note ? `\n${note}` : ""}`);
        const size = stillSize(x.width, x.height, x.par, args.maxSize ?? 480);
        const jpeg = encodeJpeg(size.width, size.height, downscale(decodePng(readFileSync(x.path)), size.width, size.height), 80);
        const view: FrameView = { view: "frame", comp: x.comp, time: x.time, compWidth: x.width, compHeight: x.height, ...size };
        return {
          content: [
            { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" },
            { type: "text", text: `Frame of "${x.comp}" at ${secs(x.time)} (${size.width}x${size.height}).${note ? `\n${note}` : ""}` },
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

  registerViewTool(
    server,
    "ae_view_proof_frame",
    {
      title: "Proof frames for a view",
      description:
        "For the in-chat views: one compared frame of a proof as three small stills (JPEG): the reference (before), the latest comparison (after) " +
        "and their difference amplified ×50. Reads the proof's stored frames; doesn't use After Effects.",
      inputSchema: {
        id: z.string().regex(/^[\w-]+$/).describe("The proof id."),
        compared: z.string().regex(/^[\w-]+$/).describe("The comparison the view shows (a later comparison replaces its frames)."),
        comp: z.number().int().describe("The comp's id in the proof."),
        index: z.number().int().min(0).describe("The frame's index in that comp's reference frames."),
        maxSize: z.number().int().min(64).max(640).optional().describe("Longest side of each still in pixels (default 320)."),
      },
      // reads files under ~/.surehand/ae/proofs only
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args: { id: string; compared: string; comp: number; index: number; maxSize?: number }) => {
      try {
        return proofFrames(args);
      } catch (e) {
        return viewError(e);
      }
    },
  );

  registerXrayNode(server);

  registerViewTool(
    server,
    "ae_view_stress_frame",
    {
      title: "Stress test frame for a view",
      description: "For the in-chat views: the failing frame a stress test kept for a variant, as a small still (JPEG). Reads the run's own file; doesn't use After Effects.",
      inputSchema: {
        run: z.string().regex(/^[\w-]+$/).describe("The stress test run (from its result)."),
        file: z.string().regex(/^[\w.@+-]+\.png$/).describe("The variant's frame file (from its result)."),
        maxSize: z.number().int().min(64).max(960).optional().describe("Longest side of the still in pixels (default 480)."),
      },
      // reads files under ~/.surehand/ae/stress only
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args: { run: string; file: string; maxSize?: number }) => {
      try {
        const p = stressFramePath(args.run, args.file);
        if (!p) return errorResult("This stress test's frame is gone (only the latest runs are kept). Run the test again to see it.");
        const png = decodePng(readFileSync(p));
        const size = stillSize(png.width, png.height, 1, args.maxSize ?? 480);
        const jpeg = encodeJpeg(size.width, size.height, downscale(png, size.width, size.height), 80);
        const view: FrameView = { view: "frame", comp: args.file, time: 0, compWidth: png.width, compHeight: png.height, ...size };
        return { content: [{ type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" }, { type: "text", text: `Frame ${args.file} (${size.width}x${size.height}).` }], _meta: { [VIEW_META_KEY]: view } };
      } catch (e) {
        return viewError(e);
      }
    },
  );
}

export { XRAY_VIEW_URI };

/** Registers ae_view_xray_node (called from registerViews). */
function registerXrayNode(server: McpServer) {
  registerViewTool(
    server,
    "ae_view_xray_node",
    {
      title: "X-ray node for a view",
      description: "For the in-chat views: one node of a Project X-ray's tree (render queue item, comp, footage) with its children and problems. Reads the X-ray's kept analysis; doesn't use After Effects.",
      inputSchema: {
        run: z.string().regex(/^[\w-]+$/).describe("The X-ray run (from its result)."),
        node: z.string().max(40).describe('The node: "q1", "c12", "f33", "g:unused", "g:top".'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args: { run: string; node: string }) => {
      try {
        const v = xrayNodeView(args.run, args.node);
        if (typeof v === "string") return errorResult(v);
        return {
          content: [{ type: "text", text: `${v.node.name}: ${v.children.length} children, ${v.problems.length + v.moreProblems} problems.` }],
          _meta: { [VIEW_META_KEY]: v },
        };
      } catch (e) {
        return viewError(e);
      }
    },
  );
}

/** Before, after and the difference ×50 of one compared frame, from the proof's own files. */
export function proofFrames(args: { id: string; compared: string; comp: number; index: number; maxSize?: number }): CallToolResult {
  const m = loadManifest(args.id);
  if (typeof m === "string") return errorResult(m);
  const c = m.comps.find((x) => x.id === args.comp), ref = c?.frames[args.index];
  if (!c || !ref) return errorResult(`Proof ${m.id} has no frame ${args.index} of comp id ${args.comp}.`);
  let now: string | undefined;
  try {
    now = JSON.parse(readFileSync(join(afterDir(m.id), "compared.json"), "utf8")).compared;
  } catch {}
  if (now !== args.compared) return errorResult("A later comparison replaced these frames. Compare again to see them.");
  let after;
  try {
    after = decodePng(readFileSync(join(afterDir(m.id), `${c.id}_${args.index}.png`)));
  } catch {
    return errorResult("This frame wasn't rendered in the comparison.");
  }
  const before = decodePng(readFileSync(join(proofDir(m.id), ref.file)));
  const size = stillSize(before.width, before.height, 1, args.maxSize ?? 320);
  const jpeg = (px: Uint8Array) => ({ type: "image" as const, data: encodeJpeg(size.width, size.height, px, 80).toString("base64"), mimeType: "image/jpeg" });
  const content: CallToolResult["content"] = [jpeg(downscale(before, size.width, size.height))];
  const same = before.width === after.width && before.height === after.height;
  content.push(jpeg(downscale(after, size.width, size.height)));
  if (same) content.push(jpeg(downscale(amplifiedDiff(before, after, 50), size.width, size.height, "max")));
  content.push({ type: "text", text: `Before, after${same ? " and difference ×50" : ""} of "${c.name}" at ${secs(ref.time)} (${size.width}x${size.height}).` });
  const view: FrameView = { view: "frame", comp: c.name, time: ref.time, compWidth: c.width, compHeight: c.height, ...size };
  return { content, _meta: { [VIEW_META_KEY]: view } };
}
