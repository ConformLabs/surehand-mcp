// ae_reformat: the comp at another size, laid out by the user's own rules (src/reformat/plan.ts), applied to a
// duplicate in one undo step, then measured frame by frame: Preflight's project checks (safe areas over time,
// text cap height) plus the rules Preflight doesn't know (cover / fit, pins) and the plan against the real result.
// The source comp is never changed. dryRun reads and plans only, and predicts the checks from the source.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { formatChanges, rollbackProblem, runJsx } from "../jsx.js";
import { approvalSummary, permissions, READ_ONLY_REFUSAL } from "../permissions.js";
import { checkItems, jsxArgs, PREFLIGHT_JSX, projectChecks, wildcard, type PData } from "../preflight/project.js";
import { formatReport, type TimeBase } from "../preflight/report.js";
import { loadSpec, type Finding, type NotRun } from "../preflight/spec.js";
import { checkRules, checkSpec, decideJobs, forChecks, mergeIssues, planComp, planLines, predict, residuals, ruleShape, rulesProblems, rulesSchema, type CompPlan, type Op, type PrecompMode, type Rules, type Tree } from "../reformat/plan.js";
import { compRef, errorResult, formatResult, reportScope } from "./registry.js";
import { saveCheckpoint } from "./workflow.js";

/** The comp tree: every layer of the comp and of the precomps it shows (8 levels), with what the plan needs to know. */
export const TREE_JSX = `
var root = aemcp.findComp(args.comp), seen = {}, comps = [];
function pinfo(p) {
  var o = { k: 0 };
  try { o.k = p.numKeys; } catch (e) {}
  try { if (p.expressionEnabled && p.expression !== "") o.ex = 1; } catch (e) {}
  return o;
}
function readComp(c, depth) {
  if (seen["c" + c.id]) return;
  seen["c" + c.id] = true;
  var C = { id: c.id, name: c.name, w: c.width, h: c.height, fps: c.frameRate, layers: [] };
  comps.push(C);
  for (var i = 1; i <= c.numLayers; i++) {
    var L = c.layer(i), o = { i: i, n: L.name, ty: aemcp.layerType(L) };
    try { if (L.parent) o.par = L.parent.index; } catch (e) {}
    try { if (L.threeDLayer) o.d3 = 1; } catch (e) {}
    if (L.locked) o.lock = 1;
    if (!L.enabled) o.off = 1;
    try { if (L.isTrackMatte) o.isM = 1; } catch (e) {}
    try {
      if (L.hasTrackMatte) {
        // After Effects 23+: any layer can be the matte; before: the layer above
        var tm = null;
        try { tm = L.trackMatteLayer; } catch (e) {}
        o.mt = tm ? tm.index : i - 1;
      }
    } catch (e) {}
    var tr = L.property("ADBE Transform Group"), pos = tr.property("ADBE Position"), sep = false;
    try { sep = pos.dimensionsSeparated; } catch (e) {}
    o.pos = sep ? { sep: 1, x: pinfo(tr.property("ADBE Position_0")), y: pinfo(tr.property("ADBE Position_1")) } : pinfo(pos);
    o.sc = pinfo(tr.property("ADBE Scale"));
    o.an = pinfo(tr.property("ADBE Anchor Point"));
    var src = null;
    try { src = L.source; } catch (e) {}
    if (src instanceof CompItem) { o.src = src.id; if (depth < 8) readComp(src, depth + 1); }
    C.layers.push(o);
  }
}
readComp(root, 0);
var taken = false;
for (var j = 1; j <= app.project.numItems; j++) if (app.project.item(j).name === args.name) { taken = true; break; }
return aemcp.stringify({ root: root.id, comps: comps, nameTaken: taken });`;

/**
 * Duplicates the comps (children first), resizes the ones to reformat and applies each layer's op, reading every
 * value from the SOURCE comp (the duplicate has the same layers and keys), so what After Effects does to layers
 * when a comp is resized can't add to it. A failure part-way returns { rollback: true }: nothing is kept.
 */
export const APPLY_JSX = `
var made = {}, out = [], failed = [], KIT = KeyframeInterpolationType;
function inf01(v) { return v >= 0 && v < 0.1 ? 0.1 : v; }
function mul(v, k) { var o = []; for (var i = 0; i < v.length; i++) o.push(v[i] * k); return o; }
function ease(list, sf) {
  var o = [];
  for (var i = 0; i < list.length; i++) o.push(new KeyframeEase(list[i].speed * (sf[i] === undefined ? sf[0] : sf[i]), inf01(list[i].influence)));
  return o;
}
function bez(p, j) { try { return p.keyInInterpolationType(j) === KIT.BEZIER || p.keyOutInterpolationType(j) === KIT.BEZIER; } catch (e) { return false; } }
function autoT(p, j) { try { return p.keyTemporalAutoBezier(j); } catch (e) { return false; } }
function autoS(p, j) { try { return p.keySpatialAutoBezier(j); } catch (e) { return true; } }
// p (in the duplicate) gets f(value) of sp (the source) at every key, or as its value. tk scales spatial tangents and
// sf the ease speeds per dimension (null: unchanged): the motion keeps its shape. Auto-Bezier keys are left to AE.
function mapProp(p, sp, f, sf, tk) {
  var n = sp.numKeys;
  if (!n) { p.setValue(f(sp.value)); return; }
  for (var j = 1; j <= n; j++) {
    p.setValueAtKey(j, f(sp.keyValue(j)));
    var spatial = false;
    try { spatial = sp.isSpatial; } catch (e) {}
    if (tk !== 1 && spatial && !autoS(sp, j)) p.setSpatialTangentsAtKey(j, mul(sp.keyInSpatialTangent(j), tk), mul(sp.keyOutSpatialTangent(j), tk));
    if (sf && bez(sp, j) && !autoT(sp, j)) p.setTemporalEaseAtKey(j, ease(sp.keyInTemporalEase(j), sf), ease(sp.keyOutTemporalEase(j), sf));
  }
}
function moveXY(p, sp, d) { mapProp(p, sp, function (v) { var o = v.slice(0); o[0] += d[0]; o[1] += d[1]; return o; }, null, 1); }
function sepOf(p) { try { return p.dimensionsSeparated; } catch (e) { return false; } }
function applyOp(N, S, op) {
  var L = N.layer(op.i), SL = S.layer(op.i), relock = false, step = "";
  try {
    if (L.locked) { L.locked = false; relock = true; }
    var tr = L.property("ADBE Transform Group"), st = SL.property("ADBE Transform Group"), pos = tr.property("ADBE Position");
    if (op.d3) {
      step = "Position";
      if (sepOf(pos)) {
        mapProp(tr.property("ADBE Position_0"), st.property("ADBE Position_0"), function (v) { return v + op.d3[0]; }, null, 1);
        mapProp(tr.property("ADBE Position_1"), st.property("ADBE Position_1"), function (v) { return v + op.d3[1]; }, null, 1);
      } else moveXY(pos, st.property("ADBE Position"), op.d3);
      // a camera's / light's Point of Interest is its Anchor Point property
      if (op.poi) { step = "Point of Interest"; moveXY(tr.property("ADBE Anchor Point"), st.property("ADBE Anchor Point"), op.d3); }
    }
    if (op.u) {
      var k = op.k === undefined ? 1 : op.k, u = op.u, sf = k !== 1 ? [k] : null;
      step = "Position";
      if (sepOf(pos)) {
        mapProp(tr.property("ADBE Position_0"), st.property("ADBE Position_0"), function (v) { return k * v + u[0]; }, sf, k);
        mapProp(tr.property("ADBE Position_1"), st.property("ADBE Position_1"), function (v) { return k * v + u[1]; }, sf, k);
      } else mapProp(pos, st.property("ADBE Position"), function (v) { var o = v.slice(0); o[0] = k * v[0] + u[0]; o[1] = k * v[1] + u[1]; return o; }, sf, k);
      if (k !== 1) { step = "Scale"; mapProp(tr.property("ADBE Scale"), st.property("ADBE Scale"), function (v) { var o = v.slice(0); o[0] *= k; o[1] *= k; return o; }, [k, k, 1], 1); }
    }
    if (op.an) { step = "Anchor Point"; moveXY(tr.property("ADBE Anchor Point"), st.property("ADBE Anchor Point"), op.an); }
    if (op.hide) { step = "switch off"; L.enabled = false; }
  } catch (e) { failed.push({ comp: N.name, i: op.i, n: L.name, step: step, error: e.message || String(e) }); }
  if (relock) { try { L.locked = true; } catch (e) {} }
}
function freeName(n) {
  var taken = {}, p = app.project;
  for (var i = 1; i <= p.numItems; i++) taken["n" + p.item(i).name] = true;
  if (!taken["n" + n]) return n;
  for (var k = 2; ; k++) if (!taken["n" + n + " " + k]) return n + " " + k;
}
try {
  for (var j = 0; j < args.jobs.length; j++) {
    var J = args.jobs[j], S = app.project.itemByID(J.src);
    if (!(S instanceof CompItem)) aemcp.fail("The comp with id " + J.src + " is gone");
    var N = S.duplicate();
    N.name = J.exact ? J.name : freeName(J.name);
    if (J.w) { N.width = J.w; N.height = J.h; }
    if (J.fps) N.frameRate = J.fps;
    made["c" + J.src] = N;
    for (var s = 0; s < J.swaps.length; s++) {
      var sw = J.swaps[s], SLy = N.layer(sw.i), lk = SLy.locked;
      if (lk) SLy.locked = false;
      SLy.replaceSource(made["c" + sw.src], false);
      if (lk) SLy.locked = true;
    }
    for (var o = 0; o < J.ops.length; o++) applyOp(N, S, J.ops[o]);
    out.push({ src: J.src, id: N.id, name: N.name });
  }
} catch (e) {
  return { rollback: true, error: e.message || String(e), made: out };
}
return { made: out, failed: failed };`;

const parse = <T>(r: unknown): T => (typeof r === "string" ? JSON.parse(r) : r) as T;

async function readJsx<T>(body: string, args: Record<string, unknown>, timeoutMs = 300_000): Promise<T> {
  const r = await runJsx(body, args, { undoGroup: false, timeoutMs });
  if (!r.ok) throw new Error(r.error?.message ?? "After Effects could not read the project");
  return parse<T>(r.result);
}

export interface ReformatArgs extends Rules {
  comp?: string | number;
  width: number;
  height: number;
  frameRate?: number;
  name: string;
  precomps?: PrecompMode;
  sampleEveryFrames?: number;
  timeBudgetSeconds?: number;
  dryRun?: boolean;
  checkpoint?: boolean;
  maxFindings?: number;
}

const ruleKeys = Object.keys(ruleShape) as (keyof Rules)[];

export async function runReformat(a: ReformatArgs, perm: { mode: string }): Promise<CallToolResult> {
  const rules = rulesSchema.parse(Object.fromEntries(ruleKeys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]))) as Rules;
  const problems = rulesProblems(rules);
  if (problems.length) return errorResult(`The rules can't be used as they are (nothing was changed):\n- ${problems.join("\n- ")}`);
  if (!a.dryRun && perm.mode === "read-only") return errorResult(READ_ONLY_REFUSAL);
  const step = a.sampleEveryFrames ?? 1, budget = a.timeBudgetSeconds ?? 120, readMs = budget * 1000 + 120_000;
  const mode = a.precomps ?? "auto";

  // 1. read and plan (nothing changes)
  const tree = await readJsx<Tree>(TREE_JSX, { comp: a.comp, name: a.name });
  if (tree.nameTaken && !a.dryRun) return errorResult(`A project item named "${a.name}" already exists: choose another name for the new comp (nothing was changed).`);
  const byId = new Map(tree.comps.map((c) => [c.id, c]));
  const root = byId.get(tree.root)!;
  const dec = decideJobs(tree, rules, mode, a.name);
  const reformatted = new Set(dec.jobs.filter((j) => j.reformat).map((j) => j.src));
  const plans = new Map<number, { plan: CompPlan; data: PData }>();
  const notes: string[] = [];
  for (const job of dec.jobs.filter((j) => j.reformat)) {
    const comp = byId.get(job.src)!;
    const data = await readJsx<PData>(PREFLIGHT_JSX, { comp: comp.id, step, textAll: true, bounds: true, patterns: [wildcard("*")], glyphs: false, timeBudgetSeconds: budget }, readMs);
    if (data.partial) notes.push(`"${comp.name}" was read only in part for the plan (${data.partial.reason}): raise timeBudgetSeconds, or sampleEveryFrames`);
    plans.set(comp.id, { plan: planComp({ comp, data, target: { w: a.width, h: a.height }, rules, name: job.name, reformatted }), data });
  }
  const issues = [...dec.issues, ...[...plans.values()].flatMap((p) => p.plan.issues)];
  for (const p of plans.values()) notes.push(...p.plan.notes);
  // rule patterns no layer anywhere in the tree matches (safe rules: Preflight says so)
  const names = tree.comps.flatMap((c) => c.layers.map((l) => l.n));
  for (const p of [...(rules.background ?? []).map((b) => b.layer), ...(rules.pin ?? []).map((b) => b.layer), ...(rules.scale ?? []).map((b) => b.layer), ...(rules.hide ?? [])])
    if (!names.some((n) => new RegExp(wildcard(p)).test(n)))
      issues.push({ comp: root.name, where: root.name, check: "reformat.rule", severity: "warn", message: `no layer named "${p}" in "${root.name}" or its precomps`, fix: "check the layer name in the rule (wildcards: Logo*)" });

  const fps = a.frameRate ?? root.fps;
  const every = step > 1 ? `every ${step}th frame` : "every frame";
  const sizeLine = `"${root.name}" (${root.w}x${root.h}) as "${a.name}" (${a.width}x${a.height}, ${Math.round(fps * 1000) / 1000} fps)`;
  const rootPlan = plans.get(root.id)!.plan;
  const tail = (extra: string[] = []) => {
    const out = ["", "plan", ...[...plans.values()].flatMap(({ plan }) => [`  ${plan.name}${plan.src.id === root.id ? "" : ` (from "${plan.src.name}")`}:`, ...planLines(plan).map((l) => `  ${l}`)])];
    if (dec.precomps.length) out.push("", "precomps", ...dec.precomps.map((p) => `  - ${p}`));
    return [...out, ...extra].join("\n");
  };
  if (a.frameRate !== undefined && Math.abs(a.frameRate - root.fps) > 1e-6)
    notes.push(`frame rate ${Math.round(root.fps * 1000) / 1000} -> ${a.frameRate} fps (the new comp only; its precomps keep theirs): keys keep their times in seconds, so some may now sit between frames (ae_retime_keyframes mode "conform" puts them on whole frames)`);

  // 2. dry run: the checks predicted from the source measurements
  if (a.dryRun) {
    const findings: Finding[] = [], notRun: NotRun[] = [];
    for (const { plan, data } of plans.values()) {
      const p = predict(plan, data);
      notes.push(...p.notes);
      // the safe rules for this comp's layers (one that matches nothing anywhere: with the top comp, which says so)
      const here = plan.src.layers.map((l) => l.n), matches = (s: { layer: string }, ns: string[]) => ns.some((n) => new RegExp(wildcard(s.layer)).test(n));
      const own: Rules = { ...rules, safe: (rules.safe ?? []).filter((s) => matches(s, here) || (plan === rootPlan && !matches(s, names))) };
      const spec = loadSpec(checkSpec(own, step));
      const it = checkItems(spec, forChecks(p.data, own, here));
      findings.push(...it.findings, ...checkRules(plan, p.data));
      notRun.push(...it.notRun);
      if (plan === rootPlan) notes.push(...it.notes);
    }
    if (tree.nameTaken) notes.push(`a project item named "${a.name}" already exists: the reformat itself needs another name`);
    const text = formatReport({
      title: `Dry run (nothing changed): reformat of ${sizeLine}, predicted on ${every} from the source`,
      findings: mergeIssues(findings, issues),
      timeBase: { fps: root.fps },
      notRun,
      notes,
      maxFindings: a.maxFindings,
    });
    return { content: [{ type: "text", text: `PLAN: predicted ${text}${tail()}` }] };
  }

  // 3. apply, in one undo step (a checkpoint first when asked)
  let cp = "";
  if (a.checkpoint) {
    try {
      const c = await saveCheckpoint("before-reformat");
      cp = `Checkpoint saved first: ${c.file}\n${c.note ? `${c.note}\n` : ""}`;
    } catch (e: any) {
      return errorResult(`The checkpoint could not be saved, so nothing was changed: ${e?.message ?? e}`);
    }
  }
  const jobs = dec.jobs.map((j) => {
    const c = byId.get(j.src)!;
    const ops: Op[] = j.reformat ? plans.get(j.src)!.plan.layers.flatMap((l) => (l.op ? [l.op] : [])) : [];
    const swaps = c.layers.filter((l) => l.src !== undefined && dec.jobs.some((x) => x.src === l.src)).map((l) => ({ i: l.i, src: l.src }));
    return { src: j.src, name: j.name, exact: j.src === root.id, ...(j.reformat ? { w: a.width, h: a.height } : {}), ...(j.src === root.id && a.frameRate !== undefined ? { fps: a.frameRate } : {}), ops, swaps };
  });
  const r = await runJsx(APPLY_JSX, { jobs }, {
    undoGroup: "Surehand MCP Reformat",
    timeoutMs: 600_000,
    report: reportScope({ comp: root.id }),
    rollback: "requested",
    bridge:
      perm.mode === "ask"
        ? { approval: { tool: "Reformat", summary: `Reformat ${sizeLine}: duplicates ${jobs.length} comp${jobs.length === 1 ? "" : "s"}, the source is not changed.\n${approvalSummary("ae_reformat", a as unknown as Record<string, unknown>)}` } }
        : undefined,
  });
  if (!r.ok) return formatResult(r);
  const res = parse<{ made: { src: number; id: number; name: string }[]; failed?: { comp: string; i: number; n: string; step: string; error: string }[]; rollback?: true; error?: string }>(r.result);
  if (res.rollback) {
    const rb = r.rollback ?? { undone: false, verified: false, problem: "no result" };
    return errorResult(`${cp}The reformat stopped: ${res.error}. ${rb.verified ? (rb.undone ? "It was rolled back: nothing changed." : "Nothing had changed yet.") : rollbackProblem(rb, "the reformat")}`);
  }
  const madeId = new Map(res.made.map((m) => [m.src, m]));
  const newRoot = madeId.get(root.id)!;

  // 4. measure the result: Preflight on the new comp (safe rules also inside precomps), the rules, the plan
  const findings: Finding[] = [], notRun: NotRun[] = [];
  for (const f of res.failed ?? [])
    findings.push({ check: "reformat.apply", severity: "fail", where: `${f.comp} > ${f.i}: ${f.n}`, message: `${f.step} could not be changed: ${f.error}`, fix: "change it yourself, then check again with ae_preflight" });
  const spec = loadSpec(checkSpec(rules, step, newRoot.id));
  const pa = { ...jsxArgs(spec, { comp: newRoot.id, timeBudgetSeconds: budget }) };
  const safeN = pa.patterns.length;
  pa.patterns = [...pa.patterns, wildcard("*")];
  const d = await readJsx<PData>(PREFLIGHT_JSX, { ...pa, deep: Array.from({ length: safeN }, (_, i) => i) }, readMs);
  const pr = projectChecks(spec, d);
  findings.push(...pr.findings);
  notRun.push(...pr.notRun);
  notes.push(...pr.notes);
  for (const { plan, data } of plans.values()) {
    const made = madeId.get(plan.src.id);
    if (!made) continue;
    const actual = plan === rootPlan ? d : await readJsx<PData>(PREFLIGHT_JSX, { comp: made.id, step, textAll: false, bounds: false, patterns: [wildcard("*")], glyphs: false, timeBudgetSeconds: budget }, readMs);
    findings.push(...checkRules(plan, actual), ...residuals(predict(plan, data).data, actual));
  }
  const timeBase: TimeBase = { fps: d.comp.fps, dropFrame: !!d.comp.df, offset: d.comp.dst ?? 0 };
  const report = formatReport({
    title: `Reformat of ${sizeLine}, checked on ${every} against your rules`,
    findings: mergeIssues(findings, issues),
    timeBase,
    notRun,
    notes: [...new Set(notes)],
    maxFindings: a.maxFindings,
  });
  const created = ["", "created", ...res.made.map((m) => `  - "${m.name}" (id ${m.id})${m.src === root.id ? "" : ` from "${byId.get(m.src)?.name}"`}`)];
  const changes = formatChanges(r.changes);
  return { content: [{ type: "text", text: `${cp}${report}${tail(created)}${changes ? `\n\n${changes}` : ""}` }] };
}

export function registerReformatTools(server: McpServer) {
  server.registerTool(
    "ae_reformat",
    {
      title: "Reformat by your rules",
      description:
        "Reformat a comp to another size (16:9 to 9:16, 1:1, 4:5 or any) by the user's own rules, then check every frame. Rules: background " +
        "layers cover / fit, layers that stay in title- / action-safe, pins to an edge or corner with a margin, which layers may scale and how far, " +
        "a minimum text cap height, layers to switch off. Layers no rule names keep their offset from the frame centre. Works on a duplicate " +
        "(precomps reused unless a rule needs one changed) in one undo step; keyframes are mapped so the motion keeps its shape. Then Preflight " +
        "checks safe areas and cap height on every frame, plus cover / fit and pins; verdict PASS / FAIL (n) / INCOMPLETE / WARNINGS (n). A rule " +
        "that can't be met is a FAIL with the reason and what the user could decide; nothing is picked for them. dryRun plans without editing.",
      inputSchema: {
        comp: compRef.describe("The comp to reformat (it is never changed). Default: the active comp."),
        width: z.number().int().min(4).max(30000).describe("The new comp's width in px."),
        height: z.number().int().min(4).max(30000).describe("The new comp's height in px."),
        frameRate: z.number().min(1).max(999).optional().describe("The new comp's frame rate (default: the source's)."),
        name: z.string().min(1).describe("The new comp's name (must not exist yet)."),
        precomps: z
          .enum(["auto", "reuse", "duplicate"])
          .optional()
          .describe('"auto" (default): reuse precomps, except full-frame ones that hold a layer a rule names (duplicated and reformatted too). "reuse": never change them. "duplicate": copy the whole tree; full-frame precomps are reformatted.'),
        ...ruleShape,
        sampleEveryFrames: z.number().int().min(1).optional().describe("Plan and check every Nth frame (default 1: every frame)."),
        timeBudgetSeconds: z.number().min(5).max(1800).optional().describe("Time limit for each frame-by-frame read (default 120); a read cut short is reported."),
        dryRun: z.boolean().optional().describe("Only read and plan: the plan and the predicted checks; nothing is changed."),
        checkpoint: z.boolean().optional().describe("Save a project checkpoint first (see ae_checkpoint)."),
        maxFindings: z.number().int().min(1).max(500).optional().describe("Most findings listed (default 60); counts stay complete."),
      },
      // makes a new comp (and precomp copies) in one undo step; checkpoint: true saves the project (overwrites the .aep) first
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args: Record<string, any>) => {
      try {
        return await runReformat(args as ReformatArgs, permissions());
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
