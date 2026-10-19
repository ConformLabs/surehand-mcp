import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { aeLabel, BridgeError, health, listInstances, matchInstance, selectInstance, startupWaitMs, waitForBridge, type Health } from "../bridge.js";
import { lastSetup } from "../cli/setup.js";
import { checkForUpdate, updateMessage } from "../update.js";
import { VERSION } from "../config.js";
import { codeExcerpt, ensureHelpers, errorHint, evalBody, formatChanges, rollbackProblem, runJsx, type RunOptions, type RunResult } from "../jsx.js";
import { reservedGlobalsHint, transpileUserCode, withoutComments } from "../transpile.js";
import { approvalSummary, permissions, READ_ONLY_REFUSAL, SHELL_REFUSAL, usesShell } from "../permissions.js";
import { compRef, errorResult, formatResult, layerRef, reportScope } from "./registry.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A preview never replaces an existing file at outputPath unless overwrite is true
const OUTPUT_GUARD_JSX = `
if (args.outputPath && !args.overwrite && new File(args.outputPath).exists)
  aemcp.fail("A file already exists at " + new File(args.outputPath).fsName + ". Nothing was rendered. To replace it, pass overwrite: true (or choose another outputPath).");`;

// ExtendScript bodies of the preview tools (exported so tests can check them)
export const RENDER_FRAME_JSX = `${OUTPUT_GUARD_JSX}
var c = aemcp.findComp(args.comp);
var t = args.time === undefined ? c.time : args.time;
var max = args.maxSize || 1280, par = c.pixelAspect;
var reg = args.region || [0, 0, c.width, c.height];
if (reg[2] <= 0 || reg[3] <= 0) aemcp.fail("region width and height must be positive");
var dispW = reg[2] * par, fit = max / Math.max(dispW, reg[3]);
var zoom = args.region ? Math.min(8, fit) : Math.min(1, fit);
var W = Math.max(4, Math.round(dispW * zoom)), H = Math.max(4, Math.round(reg[3] * zoom));
var tmp = app.project.items.addComp("__aemcp_preview", W, H, 1, c.duration, c.frameRate);
var restore = [], info = null;
try {
  // a difference image needs an opaque black base, or "identical" areas show as transparent
  var bgSpec = args.background || (args.compareWith ? "#000000" : null);
  if (bgSpec) {
    var bg = tmp.layers.addShape(), bv = bg.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group").property("ADBE Vectors Group");
    bv.addProperty("ADBE Vector Shape - Rect").property("ADBE Vector Rect Size").setValue([W, H]);
    var checker = String(bgSpec).toLowerCase() === "checkerboard";
    bv.addProperty("ADBE Vector Graphic - Fill").property("ADBE Vector Fill Color").setValue(checker ? [0.8, 0.8, 0.8] : aemcp.color3(bgSpec));
    bg.property("ADBE Transform Group").property("ADBE Position").setValue([W / 2, H / 2]);
    if (checker) {
      var cb = bg.property("ADBE Effect Parade").addProperty("ADBE Checkerboard");
      try { cb.property("ADBE Checkerboard-0004").setValue(Math.max(4, Math.round(Math.max(W, H) / 64))); cb.property("ADBE Checkerboard-0010").setValue([0.6, 0.6, 0.6]); } catch (e) {} // Width, Color
    }
  }
  // only some layers: hide the others for the render (restored in finally)
  if (args.layers && args.layers.length) {
    var keep = {};
    for (var i = 0; i < args.layers.length; i++) keep[aemcp.findLayer(c, args.layers[i]).index] = true;
    for (var j = 1; j <= c.numLayers; j++) {
      var L = c.layer(j);
      if (keep[j] || !L.enabled) continue;
      var wasLocked = L.locked; if (wasLocked) L.locked = false;
      L.enabled = false; restore.push([L, wasLocked]);
      if (wasLocked) L.locked = true;
    }
  }
  var place = function (src, srcTime) { // (a function declaration inside a block isn't valid ES3)
    var l = tmp.layers.add(src);
    var tr = l.property("ADBE Transform Group");
    tr.property("ADBE Anchor Point").setValue([reg[0] + reg[2] / 2, reg[1] + reg[3] / 2]);
    tr.property("ADBE Position").setValue([W / 2, H / 2]);
    tr.property("ADBE Scale").setValue([zoom * 100, zoom * 100, 100]);
    l.startTime = t - srcTime;
    return l;
  };
  place(c, t);
  var cmp = null;
  if (args.compareWith) {
    var c2 = args.compareWith.comp !== undefined ? aemcp.findComp(args.compareWith.comp) : c;
    var t2 = args.compareWith.time === undefined ? t : args.compareWith.time;
    var l2 = place(c2, t2);
    l2.blendingMode = BlendingMode.DIFFERENCE;
    cmp = { comp: c2.name, time: t2 };
  }
  var f = new File(args.outputPath || (args.tmpDir + "/aemcp_frame_" + new Date().getTime() + ".png"));
  if (f.exists) f.remove();
  tmp.saveFrameToPng(t, f);
  var waited = 0; while (!f.exists && waited < 10000) { $.sleep(50); waited += 50; }
  $.sleep(100);
  info = { path: f.fsName, width: W, height: H, time: t, comp: c.name, zoom: aemcp.round(zoom), region: args.region || null, compare: cmp };
} finally {
  // never leave anything behind, even if rendering fails
  for (var k = 0; k < restore.length; k++) { try { var R = restore[k][0]; if (restore[k][1]) R.locked = false; R.enabled = true; if (restore[k][1]) R.locked = true; } catch (e) {} }
  try { tmp.remove(); } catch (e) {}
}
return info;`;

export const CONTACT_SHEET_JSX = `${OUTPUT_GUARD_JSX}
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

// What read-only mode refuses before a script runs (the one list): calls that change the undo history
// outside AE MCP's control (its own undo groups, Edit > Undo/Redo via executeCommand, purging the undo
// history), and calls whose effect can't be undone or happens after the rollback (opening, closing or
// saving projects, code scheduled to run later). A text check on the code with its comments removed and
// \u escapes decoded, and again on the transpiled code; a name inside a string counts too. A call built at
// runtime (app["execute" + "Command"]) gets past it: the guarded rollback is the backstop.
const READ_ONLY_BLOCKED: { name: string; re: RegExp; undoHistory?: true }[] = [
  { name: "beginUndoGroup", re: /\bbeginUndoGroup\b/, undoHistory: true },
  { name: "endUndoGroup", re: /\bendUndoGroup\b/, undoHistory: true },
  { name: "executeCommand", re: /\bexecuteCommand\b/, undoHistory: true },
  { name: "purge", re: /\bpurge\b/, undoHistory: true },
  { name: "scheduleTask", re: /\bscheduleTask\b/ },
  { name: "newProject", re: /\bnewProject\b/ },
  { name: "app.open", re: /\bapp\s*\.\s*open\s*\(/ },
  { name: "project.close", re: /\bproject\s*\.\s*close\s*\(/ },
  { name: "save", re: /\.\s*save\s*\(/ },
  { name: "saveWithDialog", re: /\bsaveWithDialog\b/ },
];

/** \uXXXX and \u{X} escapes decoded (an escaped identifier is the same name to the JavaScript engine). */
function decodeEscapes(code: string): string {
  return code.replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g, (m, a, b) => {
    const cp = parseInt(a ?? b, 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

/**
 * The calls read-only mode refuses that the code names (comments ignored), each once. `transpiled`: the
 * code as it is sent to After Effects (transpileUserCode().source), checked as well.
 */
export function readOnlyBlockedCalls(code: string, transpiled?: string): string[] {
  const texts = [decodeEscapes(withoutComments(code))];
  if (transpiled !== undefined) texts.push(decodeEscapes(transpiled));
  return READ_ONLY_BLOCKED.filter((b) => texts.some((t) => b.re.test(t))).map((b) => b.name);
}

/** Read-only mode: the refusal for a script that names a refused call (nothing has run yet), else null. */
export function readOnlyScriptRefusal(code: string, transpiled?: string): string | null {
  const names = readOnlyBlockedCalls(code, transpiled);
  if (!names.length) return null;
  const blocked = READ_ONLY_BLOCKED.filter((b) => names.includes(b.name));
  const why: string[] = [];
  if (blocked.some((b) => b.undoHistory))
    why.push(
      "executeCommand, beginUndoGroup, endUndoGroup and purge change the undo history outside AE MCP's control, " +
        "so read-only mode couldn't reliably put the project back afterwards.",
    );
  if (blocked.some((b) => !b.undoHistory))
    why.push(
      "app.open, newProject, project.close, save, saveWithDialog and scheduleTask open, close or save projects or run code later, " +
        "which read-only mode can't undo.",
    );
  return (
    `Nothing ran. AE MCP is in read-only mode, and this script mentions ${names.join(", ")}. ${why.join(" ")} ` +
    "Scripts that mention these names are refused (the check reads the code, so a name in a string counts too). " +
    "To run it on purpose, the user can switch to edit mode (Full access, or Ask before every change) in " +
    "After Effects: Window > Extensions > AE MCP > Permissions."
  );
}

/**
 * How ae_run_script runs a script in read-only mode (after readOnlyScriptRefusal): in its own undo group,
 * compared over every comp, and undone in the same call if it changed anything (aemcp.jsxinc). Where AE
 * has app.project.revision only items and layer attributes are compared (checkOnly), not property values.
 */
export const READ_ONLY_RUN_OPTIONS: RunOptions = { undoGroup: "AE MCP Script (read-only check)", report: ["*"], checkOnly: true, rollback: "changes" };

/** The refusal for a read-only script that changed the project (or may have), else null. */
export function readOnlyRefusal(r: RunResult): string | null {
  const rb = r.rollback;
  if (!rb || (!rb.undone && rb.verified)) return null;
  if (!rb.verified) return `${READ_ONLY_REFUSAL}\n${rollbackProblem(rb, "the script")}`;
  const ch = r.changes;
  if (ch && !ch.unlisted && (ch.items.length || ch.layers.length || ch.props.length))
    return `${READ_ONLY_REFUSAL}\nThis script changed the project, so its changes were undone:\n${formatChanges(ch)}`;
  // app.project.revision moved, but nothing was listed: an edit not compared, or only a value written unchanged
  return `${READ_ONLY_REFUSAL}\nThis script wrote to the project (perhaps only values that were already set), so its changes were undone.`;
}

/**
 * Added to a timeout or cancel in read-only mode: if the script had started, it and then its rollback still run to the end in AE.
 * (A script that had not started is dropped by the bridge and never runs. A BLOCKED error is not a timeout: nothing ran, so
 * nothing needs rolling back, and this text is not added.)
 */
export const READ_ONLY_STILL_RUNNING =
  "Read-only mode: if After Effects had already started the script, it can't be interrupted, and when it ends, the read-only rollback " +
  "still runs inside After Effects in the same run (whatever the script changed is undone, once, as usual), but this reply can't show " +
  "its result. Check the project (ae_status, ae_get_project_info) before going on.";

/** ae_run_script's read-only path, for the self-test: refused before anything runs, or run and rolled back. */
export async function runReadOnly(code: string, timeoutMs = 120_000): Promise<{ refusal: string | null; r?: RunResult }> {
  const t = transpileUserCode(code);
  const refused = readOnlyScriptRefusal(code, t.source);
  if (refused) return { refusal: refused };
  const r = await runJsx(evalBody(t.source), {}, { ...READ_ONLY_RUN_OPTIONS, timeoutMs });
  return { refusal: readOnlyRefusal(r), r };
}

export function registerCoreTools(server: McpServer) {
  server.registerTool(
    "ae_run_script",
    {
      title: "Run ExtendScript",
      description:
        "Execute JavaScript inside After Effects (its ExtendScript scripting API) and return the result. This is the most powerful tool: " +
        "anything in the After Effects scripting API is available (app, app.project, CompItem, layers, properties, render queue, File/Folder, system.callSystem...).\n" +
        "- The code runs as the body of a function: use `return value` to send data back. Returned AE objects (comps, layers, properties, items) are summarized to JSON automatically.\n" +
        "- `args` (the JSON you pass in `args`) and `log(...)` are available; log output is returned too.\n" +
        "- Modern JavaScript is fine: let/const, arrow functions, template strings, destructuring, spread, classes, ?. and ??, for...of, " +
        "plus map/filter/forEach/find/includes, Object.keys/assign and JSON (converted for AE automatically). Not available: async/await, Promise, Map/Set, generators.\n" +
        "- The `aemcp` helper library is available: aemcp.findComp(idOrName), aemcp.findLayer(comp, indexOrName), aemcp.findItem(ref), " +
        "aemcp.resolveProp(layer, 'Transform/Position'), aemcp.color('#ff0000'), aemcp.compInfo(comp, true), aemcp.layerInfo(layer, true), aemcp.propInfo(prop, {depth:2}), aemcp.projectInfo().\n" +
        "- Collections are 1-based: app.project.item(1), comp.layer(1), prop.property(1).\n" +
        "- The whole script is one undo step. Errors come back with the failing line and code around it. ae_get_scripting_guide has an API cheat sheet.",
      inputSchema: {
        code: z.string().describe("JavaScript source; a function body, use `return` to return data."),
        args: z.record(z.string(), z.any()).optional().describe("JSON object exposed to the script as `args`."),
        undoGroup: z.string().optional().describe('Undo step name (default "AE MCP Script"). Pass "" to skip the undo group.'),
        depth: z.number().int().min(0).max(8).optional().describe("How deep to serialize the returned value (default 4)."),
        timeoutSeconds: z.number().min(1).max(3600).optional().describe("Max seconds to wait for the result (default 120)."),
        transpile: z.boolean().optional().describe("Convert modern JS for ExtendScript (default true). Set false to send the code exactly as written."),
        report: z.boolean().optional().describe("List what the script changed in the project (default true). Set false for read-only queries on huge projects."),
      },
      // arbitrary code, incl. shell commands and the network
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ code, args, undoGroup, depth, timeoutSeconds, transpile, report }) => {
      let readOnly = false;
      try {
        const perm = permissions();
        if (!perm.allowShell && usesShell(code)) return errorResult(SHELL_REFUSAL);
        readOnly = perm.mode === "read-only";
        const t = transpileUserCode(code, transpile !== false);
        const refused = readOnly ? readOnlyScriptRefusal(code, t.source) : null;
        if (refused) return errorResult(refused);
        const r = await runJsx(evalBody(t.source), args ?? {}, {
          ...(readOnly
            ? READ_ONLY_RUN_OPTIONS
            : { undoGroup: undoGroup === "" ? false : undoGroup || "AE MCP Script", report: report === false ? undefined : reportScope(args) }),
          depth,
          timeoutMs: (timeoutSeconds ?? 120) * 1000,
          bridge: perm.mode === "ask" ? { approval: { tool: "Run script", summary: approvalSummary("ae_run_script", { code }) } } : undefined,
        });
        const refusal = readOnly ? readOnlyRefusal(r) : null;
        if (refusal) return errorResult(refusal);
        if (!r.ok && r.error) {
          // AE rejected code that wasn't valid JavaScript either: Babel's message is far clearer
          if (t.syntaxError && /does not have a value|syntax|expected|illegal|unterminated/i.test(r.error.message)) {
            return { isError: true, content: [{ type: "text", text: `Syntax error: ${t.syntaxError}` }] };
          }
          const extra: string[] = [];
          if (r.error.line && !r.error.user) {
            const ex = codeExcerpt(code, r.error.line);
            if (ex) extra.push(ex);
          }
          const hint = reservedGlobalsHint(t.reservedGlobals) ?? errorHint(r.error.message);
          if (hint) extra.push(`Hint: ${hint}`);
          const out = formatResult(r, { quietNoChanges: true });
          if (extra.length) out.content.push({ type: "text", text: extra.join("\n\n") });
          return out;
        }
        return formatResult(r, { quietNoChanges: true });
      } catch (e) {
        const out = errorResult(e);
        if (readOnly && e instanceof BridgeError && (e.code === "TIMEOUT" || e.code === "CANCELLED")) out.content.push({ type: "text", text: READ_ONLY_STILL_RUNNING });
        return out;
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
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ path, args, timeoutSeconds }) => {
      try {
        if (!existsSync(path)) return errorResult(`File not found: ${path}`);
        const perm = permissions();
        if (perm.mode === "read-only") return errorResult(READ_ONLY_REFUSAL);
        let source = "";
        try {
          source = readFileSync(path, "utf8");
        } catch {}
        if (!perm.allowShell && usesShell(source)) return errorResult(SHELL_REFUSAL);
        const body =
          "var f = new File(args.path); if (!f.exists) aemcp.fail('File not found in AE: ' + args.path);\n" +
          "$.global.AEMCP_ARGS = args.args || {};\nreturn $.evalFile(f);";
        return formatResult(
          await runJsx(body, { path, args: args ?? {} }, {
            undoGroup: "AE MCP Script File",
            timeoutMs: (timeoutSeconds ?? 300) * 1000,
            report: reportScope(args),
            bridge: perm.mode === "ask" ? { approval: { tool: "Run script file", summary: `${path}\n\n${source.slice(0, 1500)}` } } : undefined,
          }),
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "ae_status",
    {
      title: "After Effects status",
      description:
        "Check the connection to After Effects: app version, OS, open project, active item, permission mode, and whether AE is busy. " +
        "Lists every running After Effects instance when several are open; pass `instance` (e.g. \"2025\", \"2026\" or a port) to choose which one " +
        "this session controls. Call this first if unsure AE is reachable.",
      inputSchema: {
        instance: z.string().optional().describe('Switch to another running After Effects: "2026", "26.5", or a bridge port. Omit to keep the current one.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ instance }) => {
      try {
        const list = await listInstances(true);
        if (instance) {
          const m = matchInstance(list, instance);
          if (!m) return errorResult(`No running After Effects matches "${instance}". Running: ${list.map((i) => `${i.label} (port ${i.port})`).join(", ") || "none"}.`);
          selectInstance(m.port);
        }
        // not running / still starting (waits up to ~15s) / bridge up: see which
        const deadline = Date.now() + startupWaitMs();
        const conn = await waitForBridge();
        const port = conn.port;
        let h: Health = conn.health;
        const statusScript =
          "return { appVersion: app.version, buildName: app.buildName, language: String(app.isoLanguage), os: $.os, extendScriptVersion: $.version, " +
          "memoryInUse: app.memoryInUse, isRenderEngine: app.isRenderEngine, project: aemcp.projectInfo(), " +
          "canWriteFiles: (function(){ try { return app.preferences.getPrefAsLong('Main Pref Section', 'Pref_SCRIPTING_FILE_NETWORK_SECURITY') === 1; } catch (e) { return null; } })() };";
        let r;
        for (;;) {
          try {
            r = await runJsx(statusScript, {}, { undoGroup: false, timeoutMs: 15_000, bridge: { label: "ae_status" } });
            break;
          } catch (e) {
            if (!(e instanceof BridgeError) || (e.code !== "BLOCKED" && e.code !== "TIMEOUT")) throw e;
            // bridge up, but After Effects isn't taking scripts. While it may still be starting, wait for it.
            const up = h.startedAt ? Date.now() - Date.parse(h.startedAt) : NaN;
            if (e.code === "BLOCKED" && up >= 0 && up < 120_000 && Date.now() + 1000 < deadline) {
              while (Date.now() + 1000 < deadline) {
                await new Promise((res) => setTimeout(res, 1000));
                h = await health(port).catch(() => h);
                if (!h.waitingForAE) break;
              }
              if (!h.waitingForAE) continue;
            }
            return errorResult(
              `The AE MCP bridge answers (${aeLabel(h.host?.appVersion)}, bridge v${h.version} on port ${port}), but After Effects is not taking scripts. ${e.message}`,
            );
          }
        }
        const out = formatResult(r);
        const head: string[] = [`Connected to ${aeLabel(h.host?.appVersion)} (bridge v${h.version} on port ${port}, MCP server v${VERSION}).`];
        if (list.length > 1)
          head.push(
            `${list.length} After Effects instances are running: ${list.map((i) => `${i.label} (port ${i.port}${i.port === port ? ", in use" : ""})`).join(", ")}. ` +
              "Pass instance to ae_status to switch.",
          );
        const perm = permissions();
        if (perm.mode !== "full" || !perm.allowShell)
          head.push(
            `Permissions: ${perm.mode === "ask" ? "every edit waits for the user's approval in After Effects" : perm.mode === "read-only" ? "read-only (edits are refused)" : "full"}` +
              `${perm.allowShell ? "" : "; shell commands disabled"}.`,
          );
        out.content.unshift({ type: "text", text: head.join("\n") });
        if (r.ok && (r.result as any)?.canWriteFiles === false)
          out.content.push({
            type: "text",
            text:
              "Note: 'Allow Scripts to Write Files and Access Network' is OFF in After Effects. Frame previews and the built-in tools still work, " +
              "but your own scripts can't write files (File.write, exporting data) or use the network. If you need that, ask the user to enable it: " +
              "After Effects > Settings > Scripting & Expressions (Windows: Edit > Preferences > Scripting & Expressions).",
          });
        const upd = updateMessage(await checkForUpdate());
        if (upd) out.content.push({ type: "text", text: `${upd}\nTell the user about this update.` });
        if (lastSetup?.extensionUpdated || (h.version && h.version !== VERSION))
          out.content.push({
            type: "text",
            text: `Note: After Effects is running bridge v${h.version} but v${VERSION} is installed; ask the user to restart After Effects when convenient to load it.`,
          });
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
        "Render a frame of a composition and return it as an image, so you can SEE the result. Inspection options: zoom into a region, " +
        "render only some layers, show transparency on a checkerboard or a color, and compare against another time or comp as a difference image " +
        "(black = identical). Large frames are downscaled to maxSize.",
      inputSchema: {
        comp: compRef,
        time: z.number().optional().describe("Time in seconds (default: the comp's current time)."),
        maxSize: z.number().int().min(64).max(4096).optional().describe("Longest side in pixels of the returned image (default 1280)."),
        region: z.array(z.number()).length(4).optional().describe("Zoom into [x, y, width, height] in comp pixels (scaled up to maxSize, at most 8x)."),
        layers: z.array(layerRef).optional().describe("Render only these layers (others are hidden for the render and restored)."),
        background: z.string().optional().describe('"checkerboard" to show transparency, or a color like "#808080" behind the comp.'),
        compareWith: z
          .object({ comp: z.union([z.number().int(), z.string()]).optional(), time: z.number().optional() })
          .optional()
          .describe("Difference image against another time and/or comp (black where identical)."),
        outputPath: z.string().optional().describe("Optional absolute path to also save the PNG to."),
        overwrite: z.boolean().optional().describe("Replace an existing file at outputPath (default false: refuse)."),
      },
      // not read-only: a temporary comp in an undo step, and outputPath replaces an existing file
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const body = RENDER_FRAME_JSX;
        const out = await renderPng(body, args);
        if ("error" in out) return out.error;
        const { info, data } = out;
        const parts = [`Frame of "${info.comp}" at ${info.time}s (${info.width}x${info.height}`];
        if (info.region) parts.push(`, region ${info.region.join(",")} at ${info.zoom}x`);
        parts.push(")");
        if (args.layers?.length) parts.push(`, only layers ${args.layers.join(", ")}`);
        if (info.compare) parts.push(`; difference vs "${info.compare.comp}" at ${info.compare.time}s (black = identical)`);
        if (args.outputPath) parts.push(`; saved to ${info.path}`);
        return { content: [{ type: "image", data, mimeType: "image/png" }, { type: "text", text: parts.join("") }] };
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
        overwrite: z.boolean().optional().describe("Replace an existing file at outputPath (default false: refuse)."),
      },
      // as ae_render_frame
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const body = CONTACT_SHEET_JSX;
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
