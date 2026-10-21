import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { aeLabel, BridgeError, health, restartToFinishUpdate, listInstances, matchInstance, selectInstance, startupWaitMs, waitForBridge, type Health } from "../bridge.js";
import { lastSetup } from "../cli/setup.js";
import { checkForUpdate, updateMessage } from "../update.js";
import { VERSION } from "../config.js";
import { codeExcerpt, ensureHelpers, errorHint, evalBody, formatChanges, rollbackProblem, runJsx, type Rollback, type RunOptions, type RunResult } from "../jsx.js";
import { reservedGlobalsHint, transpileUserCode, withoutComments } from "../transpile.js";
import { approvalSummary, permissions, READ_ONLY_REFUSAL, scriptFileApproval, SHELL_REFUSAL, usesShell, WRITE_ACCESS_WHERE } from "../permissions.js";
import { compRef, errorResult, formatResult, layerRef, reportScope } from "./registry.js";
import { appFile } from "../paths.js";
import { completePngSize } from "../png.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A preview never replaces an existing file at outputPath unless overwrite is true
const OUTPUT_GUARD_JSX = `
if (args.outputPath && !args.overwrite && new File(args.outputPath).exists)
  aemcp.fail("A file already exists at " + new File(args.outputPath).fsName + ". Nothing was rendered. To replace it, pass overwrite: true (or choose another outputPath).");`;

/**
 * Shared by every render (preview, contact sheet, export, proof, the in-chat frame). saveFrameToPng is
 * asynchronous (seen in AE 26.5: it returns at once and AE writes the PNG after the script ends), so a render
 * leaves its temporary comps, the layers it switched off and the settings it changed in place, records them in
 * __clean, and returns; Node waits for the files, then FINISH_JSX (aemcp.finishRollback) removes and sets back all of
 * it by hand and compares the project with how it was. A render never runs Edit > Undo: seen in AE 26.5, that Undo
 * could revert the user's own last step. If the render fails, cleanNow() puts everything back at once.
 */
export const RENDER_KIT_JSX = `
var __clean = { comps: [], layers: [], res: [], color: null };
// 32 bpc, or "Blend Colors Using 1.0 Gamma": saveFrameToPng writes such frames far too dark (seen in AE 26.5: white
// text at about 40/255). Render at 16 bpc without linear blending, so colors look as in the viewer; the undo puts
// the project settings back.
function displayColor() {
  var P = app.project, s;
  try { s = { bpc: P.bitsPerChannel, lb: !!P.linearBlending }; } catch (e) { return null; }
  if (s.bpc !== 32 && !s.lb) return null;
  __clean.color = s;
  if (s.bpc === 32) P.bitsPerChannel = 16;
  if (s.lb) P.linearBlending = false;
  return s;
}
function tempComp(name, w, h, par, dur, fps) { var t = app.project.items.addComp(name, w, h, par, dur, fps); __clean.comps.push(t.id); return t; }
function hideLayer(comp, L) {
  var lk = L.locked;
  if (lk) L.locked = false;
  L.enabled = false;
  if (lk) L.locked = true;
  __clean.layers.push({ comp: comp.id, i: L.index, locked: lk });
}
function fullRes(comp) {
  var rf = comp.resolutionFactor;
  if (rf[0] === 1 && rf[1] === 1) return;
  __clean.res.push({ comp: comp.id, rf: [rf[0], rf[1]] });
  comp.resolutionFactor = [1, 1];
}
// what a render left that is still there, put back (returns what it did); also FINISH_JSX's cleanup by hand
function cleanNow(c) {
  var done = [], P = app.project, k, it;
  for (k = 0; k < c.layers.length; k++) {
    try {
      var x = c.layers[k], cc = P.itemByID(x.comp), L = cc ? cc.layer(x.i) : null;
      if (L && !L.enabled) { if (x.locked) L.locked = false; L.enabled = true; if (x.locked) L.locked = true; done.push('layer "' + L.name + '" switched on again'); }
    } catch (e) {}
  }
  for (k = 0; k < c.res.length; k++) {
    try { var y = c.res[k], rc = P.itemByID(y.comp); if (rc && (rc.resolutionFactor[0] !== y.rf[0] || rc.resolutionFactor[1] !== y.rf[1])) { rc.resolutionFactor = y.rf; done.push('resolution of "' + rc.name + '"'); } } catch (e) {}
  }
  for (k = 0; k < c.comps.length; k++) { try { it = P.itemByID(c.comps[k]); if (it) { var nm = it.name; it.remove(); done.push('temporary comp "' + nm + '" removed'); } } catch (e) {} }
  if (c.color) {
    try { if (P.bitsPerChannel !== c.color.bpc) { P.bitsPerChannel = c.color.bpc; done.push("bit depth " + c.color.bpc + " bpc"); } } catch (e) {}
    try { if (!!P.linearBlending !== c.color.lb) { P.linearBlending = c.color.lb; done.push("linear blending " + (c.color.lb ? "on" : "off")); } } catch (e) {}
  }
  return done;
}`;

/** The second call of a render: what it changed removed and set back by hand, then the project compared with how it was. */
export const FINISH_JSX = `${RENDER_KIT_JSX}
var c = args.cleanup || {};
c.comps = c.comps || []; c.layers = c.layers || []; c.res = c.res || [];
return aemcp.finishRollback(args.token, function () { return cleanNow(c); });`;

// ExtendScript bodies of the preview tools (exported so tests can check them)
export const RENDER_FRAME_JSX = `${OUTPUT_GUARD_JSX}${RENDER_KIT_JSX}
var c = aemcp.findComp(args.comp);
var t = args.time === undefined ? c.time : args.time;
var max = args.maxSize || 1280, par = c.pixelAspect;
var reg = args.region || [0, 0, c.width, c.height];
if (reg[2] <= 0 || reg[3] <= 0) aemcp.fail("region width and height must be positive");
var dispW = reg[2] * par, fit = max / Math.max(dispW, reg[3]);
var zoom = args.region ? Math.min(8, fit) : Math.min(1, fit);
var W = Math.max(4, Math.round(dispW * zoom)), H = Math.max(4, Math.round(reg[3] * zoom));
var tmp = tempComp("__aemcp_preview", W, H, 1, c.duration, c.frameRate);
var info = null, done = false;
try {
  displayColor();
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
  // only some layers: hide the others for the render (put back by the undo)
  if (args.layers && args.layers.length) {
    var keep = {};
    for (var i = 0; i < args.layers.length; i++) keep[aemcp.findLayer(c, args.layers[i]).index] = true;
    for (var j = 1; j <= c.numLayers; j++) {
      var L = c.layer(j);
      if (keep[j] || !L.enabled) continue;
      hideLayer(c, L);
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
  // written after this script returns: Node waits for the file, then the render is undone
  tmp.saveFrameToPng(t, f);
  info = { path: f.fsName, width: W, height: H, time: t, comp: c.name, zoom: aemcp.round(zoom), region: args.region || null, compare: cmp, cleanup: __clean };
  done = true;
} finally {
  // a failed render leaves nothing behind
  if (!done) cleanNow(__clean);
}
return info;`;

export const CONTACT_SHEET_JSX = `${OUTPUT_GUARD_JSX}${RENDER_KIT_JSX}
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
var sheet = tempComp("__aemcp_contact_sheet", W, H, 1, 1, c.frameRate), r = null, done = false;
try {
  displayColor();
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
    aemcp.textDirection(td, String(td.text), null, true);
    src.setValue(td);
    // center the label under its cell using its real bounds (independent of AE's last-used text settings)
    var rc = t.sourceRectAtTime(0, false), ttr = t.property("ADBE Transform Group");
    ttr.property("ADBE Anchor Point").setValue([rc.left + rc.width / 2, rc.top + rc.height / 2]);
    ttr.property("ADBE Position").setValue([x0 + cellW / 2, y0 + cellH + labelH / 2]);
    t.moveToBeginning();
  }
  var f = new File(args.outputPath || (args.tmpDir + "/aemcp_sheet_" + new Date().getTime() + ".png"));
  if (f.exists) f.remove();
  // written after this script returns: Node waits for the file, then the render is undone
  sheet.saveFrameToPng(0, f);
  r = { path: f.fsName, comp: c.name, times: times, columns: cols, rows: rows, width: W, height: H, cleanup: __clean };
  done = true;
} finally { if (!done) cleanNow(__clean); }
return r;`;

/**
 * The size of a written file, else -1 (missing or empty). A PNG counts only once it is complete (signature and IEND,
 * completePngSize): a size that holds still can still be a half-written PNG. Callers remove an old file first or use a
 * new path, so a complete PNG at the path is the one being rendered.
 */
export function writtenSize(path: string): number {
  if (/\.png$/i.test(path)) return completePngSize(path);
  try {
    const s = statSync(path).size;
    return s > 0 ? s : -1;
  } catch {
    return -1;
  }
}

/** saveFrameToPng may finish writing asynchronously: wait (up to ~15 s) for a written file (writtenSize) whose size is stable. */
export async function waitForFile(path: string, tries = 150): Promise<boolean> {
  let last = -1;
  for (let i = 0; i < tries; i++) {
    const size = writtenSize(path);
    if (size > 0 && size === last) return true;
    last = size;
    await sleep(100);
  }
  return /\.png$/i.test(path) ? writtenSize(path) > 0 : existsSync(path);
}

/** Waits for each file (waitForFile); returns the ones that weren't written. */
export async function waitForFiles(paths: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const p of paths) if (!(await waitForFile(p))) missing.push(p);
  return missing;
}

/** The render's second call: what it changed removed and set back by hand (FINISH_JSX), then checked. Never cancelled: it is what puts the project back. */
export async function finishRender(token: string, cleanup: unknown, step: string): Promise<Rollback> {
  try {
    // the cleanup by hand, in an undo step named like the render's own (never Edit > Undo)
    const f = await runJsx(FINISH_JSX, { token, cleanup: cleanup ?? {} }, { undoGroup: step, timeoutMs: 120_000, bridge: { cancel: undefined } });
    if (f.ok && f.result && typeof f.result === "object") return { ...(f.result as Rollback), step };
    return { undone: false, verified: false, problem: `failed: ${f.error?.message ?? "no result"}` };
  } catch (e: any) {
    return { undone: false, verified: false, problem: `failed: ${e?.message ?? e}` };
  }
}

/**
 * A render in two calls: the body (in its undo group) sets up and calls saveFrameToPng, which writes after the
 * script returns; Node waits until the files are written (`wait(result)`: the files it didn't get), then
 * finishRender cleans up by hand, also when waiting fails. `missing`: files After Effects didn't write in time.
 */
export async function runRender(body: string, args: Record<string, unknown>, opts: { undoGroup: string; timeoutMs: number }, wait: (result: any) => Promise<string[]>): Promise<{ r: RunResult; missing: string[] }> {
  const r = await runJsx(body, args, { ...RENDER_RUN_OPTIONS, depth: 8, ...opts });
  let missing: string[] = [];
  if (!r.ok) return { r, missing };
  try {
    missing = await wait(r.result);
  } finally {
    if (r.pending) r.rollback = await finishRender(r.pending, (r.result as any)?.cleanup, opts.undoGroup);
  }
  return { r, missing };
}

/** The note when a render used other color settings than the project's (32 bpc or linear blending). */
export function colorNote(result: any): string {
  const c = result?.cleanup?.color;
  if (!c) return "";
  const was = [c.bpc === 32 && "32 bpc", c.lb && "linear blending"].filter(Boolean).join(" with ");
  return `Rendered at ${c.bpc === 32 ? "16" : c.bpc} bpc without linear blending (the project uses ${was}, which saveFrameToPng writes far too dark), so colors look as in the viewer; blended edges can differ slightly. The project settings were put back.`;
}

/**
 * Run a JSX body that saves a PNG (it receives args.tmpDir and returns {path, ...}),
 * wait until AE has finished writing it, and return it base64-encoded.
 */
async function renderPng(body: string, args: Record<string, unknown>): Promise<{ error: CallToolResult } | { info: any; data: string; note: string }> {
  // A folder both AE and this process can access (system temp dirs can be sandboxed per app on macOS)
  const tmpDir = appFile("tmp");
  mkdirSync(tmpDir, { recursive: true });
  // The temporary comp is created in one undo group and removed by hand once the PNG is written (never Edit > Undo).
  const { r, missing } = await runRender(body, { ...args, tmpDir }, { undoGroup: "Surehand MCP preview", timeoutMs: 180_000 }, (x) => waitForFiles([x.path]));
  if (!r.ok) return { error: formatResult(r) };
  const info = r.result as any;
  const note = [colorNote(info), renderCleanupNote(r, info?.tmpLeft, "__aemcp_preview")].filter(Boolean).join("\n");
  if (missing.length) return { error: errorResult(`After Effects did not write the image to ${info.path}${note ? `\n${note}` : ""}`) };
  const data = readFileSync(info.path).toString("base64");
  if (!args.outputPath) {
    try {
      unlinkSync(info.path);
    } catch {}
  }
  return { info, data, note };
}

// What read-only mode refuses before a script runs (the one list): calls that change the undo history
// outside Surehand MCP's control (its own undo groups, Edit > Undo/Redo via executeCommand, purging the undo
// history), and calls whose effect can't be undone or happens after the rollback (opening, closing or
// saving projects, quitting, rendering, saving preferences, code scheduled to run later). A text check on
// the code with its comments removed and \u, \x and octal escapes decoded, and again on the transpiled
// code; a name inside a string counts too. Member calls are matched as .name(, ?.name(, ["name"], ['name']
// and [`name`]; the generic ones (save, quit, render) on any object, so obj.save() is refused too (the
// reply says the script "mentions" it). A call built at runtime (app["execute" + "Command"]) gets past it:
// the guarded rollback is the backstop.
const UNDO_HISTORY = "changes the undo history outside Surehand MCP's control, so read-only mode couldn't reliably put the project back afterwards";
const word = (name: string) => new RegExp(`\\b${name}\\b`);
/** obj.name, obj?.name, obj["name"], obj?.['name'], obj[`name`] (`call`: the dot forms only when called) */
function member(obj: string | null, name: string, call: boolean): RegExp {
  const o = obj ? `\\b${obj}\\s*` : "";
  const dot = `${o}(?:\\?\\.|\\.)\\s*${name}${call ? "\\s*(?:\\?\\.\\s*)?\\(" : "\\b"}`;
  const bracket = `${o}${obj ? "(?:\\?\\.\\s*)?" : ""}\\[\\s*["'\`]${name}["'\`]\\s*\\]`;
  return new RegExp(`${dot}|${bracket}`);
}
const READ_ONLY_BLOCKED: { name: string; re: RegExp; why: string }[] = [
  { name: "beginUndoGroup", re: word("beginUndoGroup"), why: UNDO_HISTORY },
  { name: "endUndoGroup", re: word("endUndoGroup"), why: UNDO_HISTORY },
  { name: "executeCommand", re: word("executeCommand"), why: UNDO_HISTORY },
  { name: "purge", re: word("purge"), why: UNDO_HISTORY },
  { name: "scheduleTask", re: word("scheduleTask"), why: "runs code later, after the rollback, which read-only mode can't undo" },
  { name: "newProject", re: word("newProject"), why: "replaces the open project, which read-only mode can't undo" },
  { name: "app.open", re: member("app", "open", false), why: "replaces the open project, which read-only mode can't undo" },
  { name: "openFast", re: word("openFast"), why: "replaces the open project, which read-only mode can't undo" },
  { name: "project.close", re: member("project", "close", false), why: "closes the project, which read-only mode can't undo" },
  { name: "quit", re: member(null, "quit", true), why: "quits After Effects, which read-only mode can't undo" },
  { name: "save", re: member(null, "save", true), why: "writes the project to disk, which read-only mode can't undo" },
  { name: "saveWithDialog", re: word("saveWithDialog"), why: "writes the project to disk, which read-only mode can't undo" },
  { name: "render", re: member(null, "render", true), why: "renders files to disk (renderQueue.render), which read-only mode can't undo" },
  { name: "savePrefAs*", re: /\bsavePrefAs\w*/, why: "changes After Effects preferences, which read-only mode can't undo (Edit > Undo doesn't revert them)" },
  { name: "saveSetting", re: word("saveSetting"), why: "changes After Effects preferences, which read-only mode can't undo (Edit > Undo doesn't revert them)" },
  { name: "saveToDisk", re: word("saveToDisk"), why: "changes After Effects preferences, which read-only mode can't undo (Edit > Undo doesn't revert them)" },
];

/**
 * \uXXXX, \u{X}, \xXX and octal (\101) escapes decoded: an escaped identifier is the same name to the
 * JavaScript engine, and an escaped string is the same member key (app["\x6fpen"]).
 */
function decodeEscapes(code: string): string {
  return code
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g, (m, a, b) => {
      const cp = parseInt(a ?? b, 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/\\x([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([0-3][0-7]{0,2}|[4-7][0-7]?)/g, (_m, o) => String.fromCharCode(parseInt(o, 8)));
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
  // each reason once, with the refused names it is about
  const why = new Map<string, string[]>();
  for (const b of READ_ONLY_BLOCKED) if (names.includes(b.name)) why.set(b.why, [...(why.get(b.why) ?? []), b.name]);
  const reasons = [...why].map(([w, ns]) => `${ns.join(", ")}: ${w}.`);
  return (
    `Nothing ran. Surehand MCP is in read-only mode, and this script mentions ${names.join(", ")}.\n${reasons.join("\n")}\n` +
    "Scripts that mention these names are refused (the check reads the code, so a name in a string counts too, and so does " +
    "the same method name on another object, such as obj.save()). " +
    "To run it on purpose, the user can switch to Full or Ask with the mode selector at the top of the " +
    "Surehand panel in After Effects (Window > Extensions > Surehand MCP)."
  );
}

/**
 * How ae_run_script runs a script in read-only mode (after readOnlyScriptRefusal): in its own undo group,
 * compared over every comp, and undone in the same call if it changed anything (aemcp.jsxinc). Where AE
 * has app.project.revision only items and layer attributes are compared (checkOnly), not property values.
 */
/**
 * Rendering tools: what they change is removed and set back by hand once the files are written, and the project
 * compared with how it was (runRender: saveFrameToPng writes after the script returns); never Edit > Undo.
 */
export const RENDER_RUN_OPTIONS: RunOptions = { report: ["*"], checkOnly: true, rollback: "deferred" };

/**
 * What a render left behind that the user should know about ("" when nothing): a temporary comp the
 * JSX couldn't remove (`tmpLeft`) that the rollback didn't take away either, or a rollback that couldn't
 * be verified.
 */
export function renderCleanupNote(r: RunResult, tmpLeft: unknown, tmpName: string): string {
  const rb = r.rollback, notes: string[] = [];
  if (tmpLeft && !(rb?.undone && rb.verified)) notes.push(`The temporary comp "${tmpName}" could not be removed; it can be deleted from the Project panel.`);
  if (rb && !rb.verified) notes.push(rollbackProblem(rb, "the render"));
  else if (rb?.verified === "cleaned")
    notes.push(`After Effects lists "${rb.step ?? "Surehand MCP preview"}" in Edit > Undo; undoing it only brings back the render's own temporary comp and settings, nothing of yours.`);
  return notes.join("\n");
}
export const READ_ONLY_RUN_OPTIONS: RunOptions = { undoGroup: "Surehand MCP Script (read-only check)", report: ["*"], checkOnly: true, rollback: "changes" };

/** The refusal for a read-only script that changed the project (or may have), else null. */
export function readOnlyRefusal(r: RunResult): string | null {
  const rb = r.rollback;
  if (!rb || (!rb.undone && rb.verified)) return null;
  if (!rb.verified) return `${READ_ONLY_REFUSAL}\n${rollbackProblem(rb, "the script")}`;
  // light snapshot: the undo marker shows the Undo reverted the script's undo step; values weren't compared
  const how = rb.verified === "sentinel" ? " (checked by Surehand MCP's undo marker; property values were not compared)" : "";
  const ch = r.changes;
  if (ch && !ch.unlisted && (ch.items.length || ch.layers.length || ch.props.length))
    return `${READ_ONLY_REFUSAL}\nThis script changed the project, so its changes were undone${how}:\n${formatChanges(ch)}`;
  // app.project.revision moved, but nothing was listed: an edit not compared, or only a value written unchanged
  return `${READ_ONLY_REFUSAL}\nThis script wrote to the project (perhaps only values that were already set), so its changes were undone${how}.`;
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

/** What ae_status adds while "Allow Scripts to Write Files and Access Network" is off. */
export const WRITE_ACCESS_STATUS =
  "Note: 'Allow Scripts to Write Files and Access Network' is OFF in After Effects. Surehand's tools don't need it, and scripts can still " +
  "read and write files, but they can't run shell commands (system.callSystem fails with \"Permission denied\") or use the network. " +
  `If a script needs that, ask the user to turn it on: ${WRITE_ACCESS_WHERE}.`;

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
        undoGroup: z.string().optional().describe('Undo step name (default "Surehand MCP Script"). Pass "" to skip the undo group.'),
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
            : { undoGroup: undoGroup === "" ? false : undoGroup || "Surehand MCP Script", report: report === false ? undefined : reportScope(args) }),
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
            undoGroup: "Surehand MCP Script File",
            timeoutMs: (timeoutSeconds ?? 300) * 1000,
            report: reportScope(args),
            bridge: perm.mode === "ask" ? { approval: scriptFileApproval(path, source) } : undefined,
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
          "canWriteFiles: aemcp.canWriteFiles() };";
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
              `The Surehand MCP bridge answers (${aeLabel(h.host?.appVersion)}, bridge v${h.version} on port ${port}), but After Effects is not taking scripts. ${e.message}`,
            );
          }
        }
        const out = formatResult(r);
        const head: string[] = [];
        // updated while After Effects kept running: it says so first, in one line
        if (h.version && h.version !== VERSION) head.push(restartToFinishUpdate(h.version));
        head.push(`Connected to ${aeLabel(h.host?.appVersion)} (bridge v${h.version} on port ${port}, MCP server v${VERSION}).`);
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
        if (r.ok && (r.result as any)?.canWriteFiles === false) out.content.push({ type: "text", text: WRITE_ACCESS_STATUS });
        const upd = updateMessage(await checkForUpdate());
        if (upd) out.content.push({ type: "text", text: `${upd}\nTell the user about this update.` });
        if (lastSetup?.extensionUpdated && h.version === VERSION)
          out.content.push({ type: "text", text: "Note: the After Effects extension was just updated; ask the user to restart After Effects when convenient to load it." });
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
        const { info, data, note } = out;
        const parts = [`Frame of "${info.comp}" at ${info.time}s (${info.width}x${info.height}`];
        if (info.region) parts.push(`, region ${info.region.join(",")} at ${info.zoom}x`);
        parts.push(")");
        if (args.layers?.length) parts.push(`, only layers ${args.layers.join(", ")}`);
        if (info.compare) parts.push(`; difference vs "${info.compare.comp}" at ${info.compare.time}s (black = identical)`);
        if (args.outputPath) parts.push(`; saved to ${info.path}`);
        if (note) parts.push(`\n${note}`);
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
        const { info, data, note } = out;
        return {
          content: [
            { type: "image", data, mimeType: "image/png" },
            {
              type: "text",
              text: `Contact sheet of "${info.comp}": ${info.times.length} frames (${info.columns}x${info.rows}, left-to-right, top-to-bottom) at ` +
                `${info.times.map((t: number) => Math.round(t * 100) / 100 + "s").join(", ")}${args.outputPath ? `; saved to ${info.path}` : ""}${note ? `\n${note}` : ""}`,
            },
          ],
        };
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
