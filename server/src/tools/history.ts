// Project history: snapshots of the open project (stored under ~/.surehand/ae/history/<project>/) and
// "what changed between v11 and v12?" diffs between snapshots, checkpoints and the current project.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { diffSnapshots, formatDiff, parseSnapshotLines, summary, type DiffResult, type Snapshot } from "../history-diff.js";
import { runJsx } from "../jsx.js";
import { capChanges } from "../view-changes.js";
import { VIEW_META_KEY, type ChangesView } from "../views/types.js";
import { capText, errorResult } from "./registry.js";
import { CHANGES_VIEW_URI, registerViewTool, viewError } from "./views.js";
import { onCheckpointSaved } from "./workflow.js";
import { appFile } from "../paths.js";

const MAX_SNAPSHOTS = 100;
const DEFAULT_BUDGET_S = 90;
/** the snapshot every checkpoint save takes (ae_checkpoint, ae_batch / ae_prove_identical checkpoint: true) */
export const CHECKPOINT_BUDGET_S = 15;

// The snapshot, read-only: items, comp settings, layers, every property that is not at its default
// (isModified), animated or has an expression, indexed-group children (effects, masks, shape groups,
// animators), markers, render queue. Output: one JSON array per line (no object graph kept in
// ExtendScript, whose garbage collector slows down with many small objects).
// By default every property group is walked: After Effects' isModified on a group ignores expressions inside
// it (seen in AE 26.5 on Mac and Windows), so skipping unmodified groups can miss an expression. With
// args.fast, groups whose isModified is false are skipped (with their whole subtree) once a calibration over the
// first layers has confirmed that isModified on groups covers every changed property inside them. Leaves of
// the groups that are entered are always checked for keyframes and an expression, whatever isModified says;
// a leaf whose isModified is false although it has an expression means isModified ignores expressions here,
// and then groups are not skipped either.
export const SNAPSHOT_JSX = `
var P = app.project, T0 = new Date().getTime(), LIMIT = args.budgetMs || 90000, FULL = !args.fast, out = [], KEYCAP = 500;
var st = { comps: 0, layers: 0, visited: 0, stored: 0 }, rev0 = aemcp.revision(), trustGroups = !FULL, exprIgnored = false, calib = !FULL, calibLayers = 0, confirmed = false;
function E(n) { try { return $.global[n]; } catch (e) {} }
var PT = E("PropertyType"), PVT = E("PropertyValueType"), TD = E("TextDocument"), SH = E("Shape"), MV = E("MarkerValue");
function line(a) { out.push(aemcp.stringify(a)); }
function g(o, k) { try { return o[k]; } catch (e) {} }
function r(n) { return Math.round(n * 10000) / 10000; }
function en(name, v) { var x = E(name); return x && typeof v === "number" ? aemcp.enumName(x, v) : v; }
function is(v, C) { try { return !!C && v instanceof C; } catch (e) { return false; } }
function text(td, light) {
  if (light) return { text: g(td, "text"), font: g(td, "font"), fontSize: g(td, "fontSize") };
  var o = aemcp.textInfo(td); try { var sg = aemcp.textStyleSig(td); if (sg) o.styles = sg; } catch (e) {}
  return o;
}
function pts(a) { var o = []; for (var i = 0; i < a.length; i++) o.push([Math.round(a[i][0] * 100) / 100, Math.round(a[i][1] * 100) / 100]); return o; }
function shape(s, light) {
  var ls = [s.vertices, s.inTangents, s.outTangents], o = { closed: s.closed, points: ls[0].length }, h = 0;
  if (!light && ls[0].length <= 64) { o.v = pts(ls[0]); o.i = pts(ls[1]); o.o = pts(ls[2]); return o; }
  for (var a = 0; a < 3; a++) for (var i = 0; i < ls[a].length; i++) h = ((h * 31 + Math.round(ls[a][i][0] * 100)) * 31 + Math.round(ls[a][i][1] * 100)) % 2147483647;
  o.sum = h;
  return o;
}
function val(v, light) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return r(v);
  if (typeof v !== "object") return v;
  if (v instanceof Array) { var a = []; for (var i = 0; i < v.length; i++) a.push(val(v[i], light)); return a; }
  if (is(v, TD)) return text(v, light);
  if (is(v, SH)) return shape(v, light);
  if (is(v, MV)) { var o = {}; fields(o, v, "comment duration chapter url frameTarget cuePointName eventCuePoint label protectedRegion", null, true); return o; }
  return String(v);
}
// fields of src into o (enum values by name); skipDefault: leave out "", 0, false
function fields(o, src, list, enums, skipDefault) {
  list = list.split(" ");
  for (var i = 0; i < list.length; i++) { var v = g(src, list[i]); if (v !== undefined && v !== null && !(skipDefault && !v)) o[list[i]] = enums && enums[list[i]] ? en(enums[list[i]], v) : val(v); }
}
// a cheap string checksum (fits in a double: below 2^31 * 31 + 2^16)
function hs(s, h) { for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 2147483647; return h; }
// checksum of the times and values of the keys beyond KEYCAP (the first KEYCAP are stored in full)
function keySum(p) {
  var h = 7;
  for (var k = KEYCAP + 1; k <= p.numKeys; k++) { var kv = p.keyValue(k); h = hs(r(p.keyTime(k)) + "=" + aemcp.stringify(val(kv, !is(kv, TD))) + ";", h); }
  return h;
}
function ease(a) { var s = []; for (var i = 0; i < a.length; i++) s.push(r(a[i].speed) + "/" + r(a[i].influence)); return s.join(","); }
function interp(v) { return String(en("KeyframeInterpolationType", v)).toLowerCase(); }
function keys(p) {
  var ks = [], sp = !!g(p, "isSpatial");
  for (var k = 1; k <= Math.min(p.numKeys, KEYCAP); k++) {
    var kv = p.keyValue(k), o = { t: r(p.keyTime(k)), v: val(kv, !is(kv, TD)) }, f = "";
    try { o.ip = interp(p.keyInInterpolationType(k)) + "/" + interp(p.keyOutInterpolationType(k)); o.e = ease(p.keyInTemporalEase(k)) + " | " + ease(p.keyOutTemporalEase(k)); } catch (e) {}
    try { if (p.keyTemporalContinuous(k)) f += "C"; if (p.keyTemporalAutoBezier(k)) f += "A"; } catch (e) {}
    if (sp) { try { o.tan = val(p.keyInSpatialTangent(k)).concat(val(p.keyOutSpatialTangent(k))); if (p.keySpatialContinuous(k)) f += "c"; if (p.keySpatialAutoBezier(k)) f += "a"; if (p.keyRoving(k)) f += "R"; } catch (e) {} }
    if (f) o.f = f;
    try { if (p.keyLabel(k)) o.lb = p.keyLabel(k); } catch (e) {}
    ks.push(o);
  }
  return ks;
}
function lkey(L) { return L.id !== undefined ? "L" + L.id : "i" + L.index + ":" + L.name; }
// a property not at its default, animated or with an expression: one "p" line; returns 1 if stored
function leaf(c, cid, lk, kp, dp) {
  var vt = c.propertyValueType, mod = g(c, "isModified"), nk, ex = "", o = {};
  if (vt === PVT.NO_VALUE) return 0;
  nk = g(c, "numKeys") || 0;
  try { if (c.canSetExpression && c.expression) ex = c.expression; } catch (e) {}
  if (mod === false) {
    if (!nk && !ex) return 0;
    // isModified ignores expressions (or keys): an unmodified group may hide one, so groups are walked from now on
    if (ex && !nk) { exprIgnored = true; trustGroups = false; }
  }
  if (nk) { o.k = keys(c); if (nk > KEYCAP) { o.n = nk; o.ks = keySum(c); } }
  else if (vt === PVT.CUSTOM_VALUE) o.v = "(custom)";
  else { try { o.v = val(ex ? c.valueAtTime(0, true) : c.value); } catch (e) { return 0; } }
  // AE says the static value is at its default (only the expression is set)
  if (ex && !nk && mod === false) o.vd = true;
  if (ex) { o.x = ex; try { if (!c.expressionEnabled) o.xoff = true; } catch (e) {} }
  line(["p", cid, lk, kp, dp, o]);
  st.stored++;
  return 1;
}
// keys: match names, except children of indexed groups (effects, masks, shape groups): their names
function walk(grp, cid, lk, kp, dp) {
  var indexed = grp.propertyType === PT.INDEXED_GROUP, used = {}, stored = 0;
  for (var i = 1; i <= grp.numProperties; i++) {
    var c = grp.property(i);
    if (!c) continue;
    st.visited++;
    var k = String(indexed ? c.name : c.matchName).replace(/\\//g, "%2F");
    if (indexed) { if (used[k]) { var d = 2; while (used[k + "#" + d]) d++; k += "#" + d; } used[k] = true; }
    var ckp = kp ? kp + "/" + k : k, cdp = dp ? dp + "/" + c.name : c.name;
    if (c.propertyType === PT.PROPERTY) { stored += leaf(c, cid, lk, ckp, cdp); continue; }
    if (indexed) {
      var gl = ["g", cid, lk, ckp, cdp, c.matchName, i, g(c, "canSetEnabled") ? g(c, "enabled") : true];
      if (c.matchName === "ADBE Mask Atom") { var ma = {}; fields(ma, c, "maskMode inverted maskFeatherFalloff maskMotionBlur rotoBezier locked color", MASK_ENUMS); gl.push(ma); }
      line(gl);
    }
    var mod = c.propertyType === PT.NAMED_GROUP ? g(c, "isModified") : undefined;
    if (trustGroups && !calib && mod === false) continue;
    var inside = walk(c, cid, lk, ckp, cdp);
    stored += inside;
    if (calib && inside) { if (mod === false) trustGroups = false; else if (mod === true) confirmed = true; }
  }
  return stored;
}
var MASK_ENUMS = { maskMode: "MaskMode", maskFeatherFalloff: "MaskFeatherFalloff", maskMotionBlur: "MaskMotionBlur" };
var LE = { blendingMode: "BlendingMode", trackMatteType: "TrackMatteType", quality: "LayerQuality", samplingQuality: "LayerSamplingQuality", frameBlendingType: "FrameBlendingType", autoOrient: "AutoOrientType", lightType: "LightType" };
function layer(L, cid) {
  var a = {}, lk = lkey(L), tm = g(L, "trackMatteLayer");
  fields(a, L, "inPoint outPoint startTime stretch enabled solo locked shy label comment threeDLayer threeDPerChar blendingMode trackMatteType adjustmentLayer motionBlur guideLayer audioEnabled collapseTransformation quality samplingQuality frameBlendingType effectsActive timeRemapEnabled preserveTransparency autoOrient environmentLayer lightType", LE);
  a.parent = L.parent ? lkey(L.parent) : null;
  if (tm) a.matteLayer = lkey(tm);
  try { if (L.source) a.source = L.source.id; } catch (e) {}
  line(["L", cid, lk, { index: L.index, name: L.name, type: aemcp.layerType(L), attrs: a }]);
  walk(L, cid, lk, "", "");
  st.layers++;
  if (calib && ++calibLayers >= 25 && confirmed) calib = false;
}
function folderPath(it) {
  var f = it.parentFolder, up = f && f.parentFolder ? folderPath(f) : "";
  return !f || !f.parentFolder ? "" : (up ? up + "/" : "") + f.name;
}
var comps = [], wanted = null, skipped = [], scope = null, ps = {}, rq = g(P, "renderQueue"), GS = E("GetSettingsFormat"), seen = {};
if (args.comps && args.comps.length) { wanted = {}; scope = []; for (var w = 0; w < args.comps.length; w++) { try { wanted[aemcp.findComp(args.comps[w]).id] = true; } catch (e) { if (!args.lenient) throw e; } } }
for (var ii = 1; ii <= P.numItems; ii++) {
  var it = P.item(ii), type = aemcp.itemType(it), fo = { label: g(it, "label"), comment: g(it, "comment") };
  if (type === "comp") {
    fields(fo, it, "width height pixelAspect duration frameRate bgColor workAreaStart workAreaDuration displayStartTime dropFrame frameBlending motionBlur shutterAngle shutterPhase motionBlurSamplesPerFrame motionBlurAdaptiveSampleLimit renderer preserveNestedFrameRate preserveNestedResolution useProxy");
    if (!wanted || wanted[it.id]) comps.push(it);
  } else if (type !== "folder") {
    fields(fo, it, "width height pixelAspect duration frameRate useProxy footageMissing");
    fields(fo, g(it, "mainSource"), "conformFrameRate alphaMode premulColor invertAlpha fieldSeparationType highQualityFieldSeparation removePulldown loop color", { alphaMode: "AlphaMode", fieldSeparationType: "FieldSeparationType", removePulldown: "PulldownPhase" });
    try { if (it.file) fo.file = it.file.fsName; } catch (e) {}
    try { var px = it.proxySource; if (px) fo.proxy = px.file ? px.file.fsName : "placeholder"; } catch (e) {}
  }
  line(["I", it.id, { type: type, name: it.name, folder: folderPath(it), fields: fo }]);
}
for (var ci = 0; ci < comps.length; ci++) {
  var c = comps[ci], partial = false, mk = [];
  if (scope) scope.push(c.id);
  if (new Date().getTime() - T0 > LIMIT) { skipped.push(c.id); continue; }
  for (var li = 1; li <= c.numLayers; li++) {
    if (li > 1 && new Date().getTime() - T0 > LIMIT) { partial = true; break; }
    layer(c.layer(li), c.id);
  }
  try { if (c.markerProperty.numKeys) mk = keys(c.markerProperty); } catch (e) {}
  line(["C", c.id, { markers: mk, partial: partial }]);
  st.comps++;
}
fields(ps, P, "bitsPerChannel workingSpace linearBlending linearizeWorkingSpace compensateForSceneReferredProfiles colorManagementSystem ocioConfigurationFile workingColorSpace displayColorSpace expressionEngine timeDisplayType framesCountType displayStartFrame footageTimecodeDisplayStartType");
line(["X", ps]);
for (var qi = 1; rq && qi <= Math.min(rq.numItems, 50); qi++) {
  var qq = rq.item(qi), qc = g(qq, "comp"), qk = "c" + (qc ? qc.id : 0), qo = { index: qi, comp: qc ? qc.id : null, compName: qc ? qc.name : null, oms: [] };
  seen[qk] = (seen[qk] || 0) + 1;
  fields(qo, qq, "status render timeSpanStart timeSpanDuration skipFrames", { status: "RQItemStatus" });
  try { qo.rs = qq.getSettings(GS.STRING); } catch (e) {}
  for (var m = 1; m <= (g(qq, "numOutputModules") || 0); m++) {
    var om = qq.outputModule(m), mo = { template: g(om, "name") };
    try { mo.file = om.file ? om.file.fsName : null; mo.settings = om.getSettings(GS.STRING); } catch (e) {}
    qo.oms.push(mo);
  }
  line(["Q", qk + "#" + seen[qk], qo]);
}
if (rq && rq.numItems > 50) st.rqNotRead = rq.numItems - 50;
st.ms = new Date().getTime() - T0;
// if/else, not a chain of ?: (ExtendScript evaluates "a ? x : b ? y : z" wrongly: seen live in AE 26.5)
if (FULL) st.pruning = "off (every group read)";
else if (trustGroups) st.pruning = confirmed ? "on" : "unconfirmed";
else if (exprIgnored) st.pruning = "off (isModified ignores expressions)";
else st.pruning = "off (isModified unreliable on groups)";
st.revisionAfter = aemcp.revision();
line(["M", { project: P.file ? P.file.fsName : null, revision: rev0, ae: app.version, scope: scope, skipped: skipped, stats: st }]);
return out.join("\\n");`;

// ---------- storage ----------

const HISTORY = () => appFile("history");

/** Same folder name as the project's checkpoints (~/.surehand/ae/checkpoints/<name>-<hash>). */
export function historyDir(projectPath: string) {
  const name = basename(projectPath, extname(projectPath)).replace(/[^\w.-]+/g, "_").slice(0, 60);
  return join(HISTORY(), `${name}-${createHash("sha1").update(projectPath).digest("hex").slice(0, 8)}`);
}

export interface SnapshotEntry { id: string; at: string; label?: string; checkpoint?: string; revision: number | null; scope?: number[]; partial?: boolean; comps: number; layers: number }

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
const readIndex = (dir: string) => readJson<SnapshotEntry[]>(join(dir, "index.json"), []);
const checkpointsOf = (project: string) =>
  readJson<{ id: string; at: string; label?: string; file: string }[]>(appFile("checkpoints", basename(historyDir(project)), "index.json"), []);

export function loadSnapshot(project: string, id: string): Snapshot {
  return JSON.parse(gunzipSync(readFileSync(join(historyDir(project), `${id}.json.gz`))).toString("utf8"));
}

const stamp = () => new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+$/, "");

export interface CaptureOptions { comps?: (string | number)[]; timeBudgetSeconds?: number; /** skip unmodified groups (faster; can miss expressions inside them) */ fast?: boolean; /** skip comps that no longer exist */ lenient?: boolean }

/** Read the open project into a snapshot (not stored). Read-only: no undo group, no edits. */
export async function captureSnapshot(o: CaptureOptions, meta: { id: string; label?: string }): Promise<Snapshot> {
  const budgetMs = (o.timeBudgetSeconds ?? DEFAULT_BUDGET_S) * 1000;
  const r = await runJsx(SNAPSHOT_JSX, { comps: o.comps, budgetMs, fast: o.fast, lenient: o.lenient }, { undoGroup: false, timeoutMs: budgetMs + 120_000 });
  if (!r.ok) throw new Error(r.error?.message || "the snapshot failed");
  return parseSnapshotLines(String(r.result), { ...meta, at: new Date().toISOString() });
}

/** Store a snapshot of the open project; keeps the last 100 per project. */
export async function saveSnapshot(o: CaptureOptions & { label?: string; checkpoint?: string }): Promise<Snapshot> {
  const snap = await captureSnapshot(o, { id: "", label: o.label });
  if (!snap.project) throw new Error("The project has never been saved, so it has no history yet. Save it first (ae_save_project with a path).");
  if (o.checkpoint) snap.checkpoint = o.checkpoint;
  const dir = historyDir(snap.project);
  mkdirSync(dir, { recursive: true });
  const index = readIndex(dir);
  let id = stamp();
  for (let n = 2; index.some((e) => e.id === id); n++) id = `${stamp()}-${n}`;
  snap.id = id;
  writeFileSync(join(dir, `${id}.json.gz`), gzipSync(JSON.stringify(snap)));
  const comps = Object.values(snap.items).filter((i) => i.layers);
  index.push({ id, at: snap.at, label: snap.label, checkpoint: snap.checkpoint, revision: snap.revision, scope: snap.scope, partial: !!snap.skipped || comps.some((c) => c.partial) || undefined, comps: comps.length, layers: snap.stats.layers });
  while (index.length > MAX_SNAPSHOTS) {
    try {
      unlinkSync(join(dir, `${index.shift()!.id}.json.gz`));
    } catch {}
  }
  writeFileSync(join(dir, "index.json"), JSON.stringify(index, null, 1));
  return snap;
}

function describe(s: Snapshot): string {
  const st = s.stats, notes: string[] = [];
  if (s.skipped) notes.push(`the time budget ran out: ${s.skipped.length} comp${s.skipped.length > 1 ? "s were" : " was"} not captured (raise timeBudgetSeconds or limit it with comps)`);
  const part = Object.values(s.items).filter((i) => i.partial).map((i) => JSON.stringify(i.name));
  if (part.length) notes.push(`comp ${part.join(", ")} was captured only partly (time budget)`);
  if (st.revisionAfter != null && s.revision != null && st.revisionAfter !== s.revision) notes.push("the project changed while the snapshot was taken");
  if (st.rqNotRead) notes.push(`only the first 50 render queue items were read (${st.rqNotRead} more not read)`);
  return (
    `${st.comps} comp${st.comps === 1 ? "" : "s"}${s.scope ? " (limited with comps)" : ""}, ${st.layers} layers, ${st.stored} non-default properties ` +
    `(${st.visited} looked at in ${(st.ms / 1000).toFixed(1)} s; skipping unmodified groups: ${st.pruning}), project revision ${s.revision ?? "n/a"}` +
    (notes.length ? `\nNote: ${notes.join("; ")}.` : "")
  );
}

/** Comps whose layers a snapshot didn't (fully) read: not reached in the time budget, or cut short. */
export const compsNotRead = (s: Snapshot) => (s.skipped?.length ?? 0) + Object.values(s.items).filter((i) => i.partial).length;

// a snapshot for every checkpoint, so checkpoints can be diffed; never fails the checkpoint itself, and
// has a short time budget of its own so a checkpoint save stays quick on big projects
onCheckpointSaved(async (cp) => {
  try {
    const s = await saveSnapshot({ label: cp.label, checkpoint: cp.id, timeBudgetSeconds: CHECKPOINT_BUDGET_S });
    const missing = compsNotRead(s);
    if (missing)
      return `History snapshot ${s.id} linked to this checkpoint is partial (${missing} comp${missing > 1 ? "s" : ""} not read in ${CHECKPOINT_BUDGET_S} s): take a full one with ae_project_history {action: "snapshot"}.`;
    return `History snapshot ${s.id} linked to this checkpoint (${s.stats.layers} layers, ${(s.stats.ms / 1000).toFixed(1)} s).`;
  } catch (e: any) {
    return `No history snapshot for this checkpoint: ${e?.message || e}`;
  }
});

// ---------- references ----------

type Ref = { current: true } | { current?: false; entry: SnapshotEntry };

export function resolveRef(ref: string, index: SnapshotEntry[], checkpoints: { id: string; label?: string; file: string }[]): Ref | string {
  const r = ref.trim(), lc = r.toLowerCase();
  if (lc === "current" || lc === "now") return { current: true };
  const byTime = [...index].reverse();
  if (lc === "latest" || lc === "last") return byTime[0] ? { entry: byTime[0] } : `There are no snapshots of this project yet. Take one with ae_project_history {action: "snapshot", label: "..."}.`;
  if (lc === "previous") return byTime[1] ? { entry: byTime[1] } : "There is no previous snapshot.";
  const exact = index.find((e) => e.id === r);
  if (exact) return { entry: exact };
  const cp = checkpoints.find((c) => c.id === r);
  const label = byTime.find((e) => e.label?.toLowerCase() === lc);
  if (!cp && label) return { entry: label };
  const cpl = cp ?? [...checkpoints].reverse().find((c) => c.label?.toLowerCase() === lc);
  if (cpl) {
    const linked = index.find((e) => e.checkpoint === cpl.id);
    if (linked) return { entry: linked };
    return (
      `Checkpoint ${cpl.id}${cpl.label ? ` ("${cpl.label}")` : ""} has no snapshot: it was saved before project history existed, or its snapshot failed. ` +
      `Its project file is ${cpl.file}. Comparing it would mean opening that file, which replaces the project open in After Effects, so that is not done automatically. ` +
      "Checkpoints saved from now on get a snapshot automatically."
    );
  }
  const prefix = index.filter((e) => e.id.startsWith(r));
  if (prefix.length === 1) return { entry: prefix[0] };
  return `No snapshot or checkpoint "${r}"${prefix.length > 1 ? ` (${prefix.length} snapshots start with it; give more of the id)` : ""}. Use action "list".`;
}

export class HistoryRefError extends Error {}

/**
 * The diff between two snapshots / checkpoints / "current" of a project (the open one in After Effects
 * when either side is "current"). Throws HistoryRefError when a reference can't be resolved.
 */
export async function historyDiff(
  project: string,
  a: { from?: string; to?: string; timeBudgetSeconds?: number; detail?: number | string; limit?: number },
  /** gets the in-chat view's data (the same changes as structured rows) */
  out?: { view?: ChangesView },
): Promise<string> {
  const index = readIndex(historyDir(project)), cps = checkpointsOf(project);
  const from = resolveRef(a.from ?? "latest", index, cps), to = resolveRef(a.to ?? "current", index, cps);
  if (typeof from === "string") throw new HistoryRefError(`from: ${from}`);
  if (typeof to === "string") throw new HistoryRefError(`to: ${to}`);
  const sa = from.current ? undefined : loadSnapshot(project, from.entry.id), sb = to.current ? undefined : loadSnapshot(project, to.entry.id);
  // the current project is read for the comps the stored side covers
  const scope = (sa ?? sb)?.scope;
  const live = from.current || to.current ? await captureSnapshot({ comps: scope, timeBudgetSeconds: a.timeBudgetSeconds, lenient: true }, { id: "current" }) : undefined;
  const A = sa ?? live!, B = sb ?? live!;
  const moving =
    live && live.revision != null && live.stats.revisionAfter != null && live.revision !== live.stats.revisionAfter
      ? `\nNote: the project changed while the current project was being read (revision ${live.revision} -> ${live.stats.revisionAfter}), so parts of it may be from before and parts from after that change; run the diff again for a consistent result.`
      : "";
  const diff = diffSnapshots(A, B);
  const text = `From: ${title(A, !sa)}\nTo:   ${title(B, !sb)}\n` + formatDiff(diff, { detail: a.detail, limit: a.limit }) + moving;
  if (out) out.view = historyView(project, { snapshot: A, current: !sa }, { snapshot: B, current: !sb }, diff, a.detail);
  return capText(text);
}

/** The history diff as the "What changed" view's data: every change (or one comp's, as `detail` asks), as the text has them. */
export function historyView(project: string, from: { snapshot: Snapshot; current: boolean }, to: { snapshot: Snapshot; current: boolean }, diff: DiffResult, detail?: string | number): ChangesView {
  const want = detail === undefined ? undefined : String(detail);
  const sections = want === undefined ? diff.sections : diff.sections.filter((s) => s.comp && (String(s.comp.id) === want || s.comp.name === want));
  return {
    view: "changes",
    source: "history",
    title: `What changed · ${basename(project)}`,
    subtitle: `${shortTitle(from.snapshot, from.current)} → ${shortTitle(to.snapshot, to.current)}`,
    ...capChanges(sections.flatMap((s) => s.changes)),
    footnote: summary(diff.counts),
  };
}

/** A side of a diff in the view's header: `checkpoint "before un-precompose"`, `snapshot "v12"`, now. */
const shortTitle = (s: Snapshot, current: boolean) =>
  current ? "now" : s.checkpoint ? `checkpoint "${s.label ?? s.checkpoint}"` : `snapshot "${s.label ?? s.id}"`;

/** The project's snapshots (oldest first). */
export const snapshotIndex = (project: string) => readIndex(historyDir(project));

const title = (s: Snapshot, current: boolean) =>
  current
    ? `the current project (revision ${s.revision ?? "n/a"}, not stored)`
    : `snapshot ${s.id}${s.label ? ` "${s.label}"` : ""}${s.checkpoint ? ` (checkpoint ${s.checkpoint})` : ""}, ${s.at.replace("T", " ").slice(0, 16)} UTC, revision ${s.revision ?? "n/a"}`;

export function registerHistoryTools(server: McpServer) {
  // diff is shown as the "What changed" view where the AI app has in-chat views (MCP Apps)
  registerViewTool(
    server,
    "ae_project_history",
    {
      _meta: { ui: { resourceUri: CHANGES_VIEW_URI } },
      title: "Project history",
      description:
        "Snapshots of the project and what changed between them. snapshot: store a read-only record of the open project (items, comp settings, " +
        "layers, every non-default or animated property with keyframes and easing, expressions, effects, masks, text, markers, render queue). " +
        "list: snapshots and checkpoints of this project (ae_checkpoint save also stores a snapshot). diff: what changed between two of them or the " +
        'current project ("What changed between v11 and v12?"): comps, layers, values, keyframes, expressions (line diff), effects, render queue. ' +
        "Doesn't change the project; snapshots are kept under ~/.surehand/ae/history (last 100 per project).",
      inputSchema: {
        action: z.enum(["snapshot", "list", "diff"]),
        label: z.string().max(80).optional().describe('snapshot: a short label, e.g. "v12" (diff can refer to it).'),
        comps: z.array(z.union([z.number().int(), z.string()])).max(200).optional().describe("snapshot: capture the layers of only these comps (id or name; default all). Items are always captured."),
        timeBudgetSeconds: z.number().min(5).max(900).optional().describe(`snapshot/diff: stop reading layers after this long (default ${DEFAULT_BUDGET_S}); comps not reached are reported.`),
        fast: z.boolean().optional().describe("snapshot: skip property groups After Effects reports as unmodified (faster on big projects, but an expression inside such a group can be missed: AE's group isModified ignores expressions). Default: read every group."),
        from: z.string().optional().describe('diff: snapshot id, label, checkpoint id/label, "latest", "previous" or "current" (default: latest snapshot).'),
        to: z.string().optional().describe('diff: same choices (default "current").'),
        detail: z.union([z.number().int(), z.string()]).optional().describe("diff: show every change in this one comp (id or name)."),
        limit: z.number().int().min(10).max(5000).optional().describe("diff: max change lines (default 150)."),
      },
      // writes snapshot files under ~/.surehand/ae only; the project is never changed
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (a) => {
      try {
        if (a.action === "snapshot") {
          const s = await saveSnapshot({ label: a.label, comps: a.comps, timeBudgetSeconds: a.timeBudgetSeconds, fast: a.fast });
          return { content: [{ type: "text", text: `Snapshot ${s.id}${s.label ? ` ("${s.label}")` : ""} saved: ${describe(s)}\nCompare later with ae_project_history {action: "diff", from: "${s.label ?? s.id}"}.` }] };
        }
        const pr = await runJsx("return app.project.file ? app.project.file.fsName : null;", {}, { undoGroup: false });
        const project = pr.result as string | null;
        if (!project) return errorResult("The open project has never been saved, so it has no history.");
        const dir = historyDir(project), index = readIndex(dir), cps = checkpointsOf(project);
        if (a.action === "list") {
          const rows = [
            ...index.map((e) => ({ at: e.at, line: `${e.id}  snapshot${e.label ? ` "${e.label}"` : ""}${e.checkpoint ? ` (checkpoint ${e.checkpoint})` : ""}  revision ${e.revision ?? "n/a"}, ${e.scope ? `${e.comps} comps (limited)` : `${e.comps} comps`}, ${e.layers} layers${e.partial ? ", incomplete" : ""}` })),
            ...cps.filter((c) => !index.some((e) => e.checkpoint === c.id)).map((c) => ({ at: c.at, line: `${c.id}  checkpoint${c.label ? ` "${c.label}"` : ""}  no snapshot (can't be diffed)` })),
          ].sort((x, y) => y.at.localeCompare(x.at));
          if (!rows.length) return { content: [{ type: "text", text: `No snapshots or checkpoints yet for ${project}. Take one with ae_project_history {action: "snapshot", label: "..."}.` }] };
          return { content: [{ type: "text", text: `History of ${project} (newest first):\n${rows.map((r) => r.line).join("\n")}` }] };
        }
        const out: { view?: ChangesView } = {};
        const text = await historyDiff(project, a, out);
        return { content: [{ type: "text", text }], ...(out.view ? { _meta: { [VIEW_META_KEY]: out.view } } : {}) };
      } catch (e) {
        return viewError(e);
      }
    },
  );
}
