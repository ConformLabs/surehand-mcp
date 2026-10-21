// ae_farm: render farm readiness and chunked renders, measured rather than guessed. manifest: what exactly a render
// needs (After Effects, colour, plug-ins, fonts, every file it pulls in, outputs); check: this machine against a
// manifest (also `surehand-ae farm check` without After Effects); plan: frame-range chunks with aerender commands and
// per-machine scripts, the join step and when it isn't lossless, a time estimate; run_local: the chunks as parallel
// aerender jobs here (the background-render jobs: logs, progress, cancel); verify: proof the chunks add up.
// Never runs anything on another machine: other machines get scripts to run there.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { BridgeError } from "../bridge.js";
import { callContext } from "../context.js";
import { runJsx } from "../jsx.js";
import { appFile } from "../paths.js";
import { permissions, READ_ONLY_REFUSAL } from "../permissions.js";
import { ensureFfmpeg, FfmpegMissingError, type FfmpegPaths } from "../preflight/ffmpeg.js";
import { checkManifest, formatCheck } from "../farm/check.js";
import { FARM_CHECK_JSX, FARM_SCAN_JSX } from "../farm/jsx.js";
import { buildManifest, formatManifest, manifestName, type FarmScan, type Manifest } from "../farm/manifest.js";
import { aerenderNextTo, platformOf, readMounts, type PathMapping } from "../farm/paths.js";
import { buildPlan, defaultPlanFolder, fileStamp, findProfile, fmtDuration, formatPlan, maxLocalProcesses, PlanRefusal, planFileName, planScripts, type FarmPlan, type MachineSpec } from "../farm/plan.js";
import { listFrames, parseTemplate, runsOf, runsText } from "../farm/seq.js";
import { compareProof, farmFrame, readPlanFile, sequenceProblems, verifyMovie, verifySequence, type ProofFrame } from "../farm/verify.js";
import { expandHome } from "./files.js";
import { approveDownload } from "./preflight.js";
import { captureProof, DEFAULT_TOLERANCE, proofDir } from "./prove.js";
import { errorResult, capText } from "./registry.js";
import { cancelJob, renderJob, startAerenderJob, type RenderJob } from "./renderjobs.js";
import { measure } from "./renderprofile.js";

export interface FarmInput {
  action: "manifest" | "check" | "plan" | "run_local" | "status" | "verify";
  rqIndex?: number | number[];
  sharedPaths?: string[];
  save?: boolean | string;
  manifest?: string | Record<string, unknown>;
  pathMap?: PathMapping[];
  aePath?: string;
  processes?: number;
  machines?: MachineSpec[];
  mfr?: "auto" | "on" | "off" | "leave";
  estimate?: "auto" | "profile" | "sample" | "none";
  folder?: string;
  plan?: string;
  run?: string;
  cancel?: boolean;
  join?: boolean;
  proveFrames?: number;
  tolerance?: number;
  allowFfmpegDownload?: boolean;
  overwrite?: boolean;
  dryRun?: boolean;
}

const text = (t: string, extra: Partial<CallToolResult> = {}): CallToolResult => ({ content: [{ type: "text", text: capText(t) }], ...extra });
const abs = (p: string, what: string) => {
  const e = expandHome(p);
  if (!isAbsolute(e)) throw new PlanRefusal(`${what} must be an absolute path (got "${p}").`);
  return e;
};
const parse = <T>(r: { result?: unknown }) => (typeof r.result === "string" ? JSON.parse(r.result) : r.result) as T;

async function scan(args: Record<string, unknown>): Promise<FarmScan> {
  const r = await runJsx(FARM_SCAN_JSX, args, { undoGroup: false, timeoutMs: 600_000 });
  if (!r.ok) throw new PlanRefusal(r.error?.message ?? "After Effects could not read the render queue.");
  return parse<FarmScan>(r);
}

// ---------- manifest ----------

async function manifestAction(a: FarmInput, mode: string): Promise<CallToolResult> {
  if (a.save && mode === "read-only") return errorResult(`${READ_ONLY_REFUSAL} (Saving the manifest writes a file; without save it is read-only.)`);
  const rq = a.rqIndex === undefined ? undefined : Array.isArray(a.rqIndex) ? a.rqIndex : [a.rqIndex];
  const s = await scan({ rq });
  const platform = platformOf();
  const m = buildManifest(s, { platform, classify: { platform, home: homedir(), shared: (a.sharedPaths ?? []).map((p) => expandHome(p)), mounts: readMounts(platform), systemDrive: process.env.SystemDrive } });
  let saved: string | undefined;
  if (a.save) {
    if (typeof a.save === "string") saved = abs(a.save, "save");
    else if (!s.file) return errorResult("The project has never been saved, so there is no folder to save the manifest next to. Pass save as an absolute file path, or save the project first.");
    else saved = join(dirname(s.file), manifestName(s.file));
    const txt = saved.replace(/\.json$/i, "") + ".txt";
    const exists = [saved, txt].filter((p) => existsSync(p));
    if (exists.length && !a.overwrite) return errorResult(`${exists.join(" and ")} ${exists.length > 1 ? "exist" : "exists"} already. Nothing was written. Pass overwrite: true to replace ${exists.length > 1 ? "them" : "it"}, or another save path.`);
    if (!a.dryRun) {
      mkdirSync(dirname(saved), { recursive: true });
      writeFileSync(saved, JSON.stringify(m, null, 1));
      writeFileSync(txt, formatManifest(m));
    }
  }
  const head = formatManifest(m, a.dryRun ? undefined : saved);
  return text(`${a.dryRun && saved ? `Dry run: would save ${saved} (+ .txt).\n` : ""}${head}\nJSON:\n${JSON.stringify(m)}`);
}

// ---------- check ----------

function loadManifest(src: string | Record<string, unknown>): { m: Manifest; source: string } {
  let m: any, source = "(passed in)";
  if (typeof src === "string") {
    source = abs(src, "manifest");
    try {
      m = JSON.parse(readFileSync(source, "utf8"));
    } catch (e: any) {
      throw new PlanRefusal(`The manifest ${source} can't be read: ${e?.message ?? e}.`);
    }
  } else m = src;
  if (m?.surehandFarmManifest !== 1) throw new PlanRefusal(`${source} is not a farm manifest (ae_farm {action: "manifest", save: true} writes one).`);
  return { m: m as Manifest, source };
}

async function checkAction(a: FarmInput): Promise<CallToolResult> {
  if (!a.manifest) return errorResult('Pass manifest: the path of a farm manifest (ae_farm {action: "manifest", save: true} writes one next to the project).');
  const { m, source } = loadManifest(a.manifest);
  const notes: string[] = [];
  let live: Parameters<typeof checkManifest>[1]["live"] = null;
  try {
    const r = await runJsx(FARM_CHECK_JSX, { effects: m.plugins.filter((p) => p.rendered).map((p) => p.matchName), fonts: m.fonts.filter((f) => f.rendered).map((f) => f.postScriptName) }, { undoGroup: false, timeoutMs: 120_000 });
    if (r.ok) {
      const d = parse<any>(r);
      live = { version: d.ae, app: d.app, effects: d.effects ?? {}, fonts: d.fonts ?? null };
    } else notes.push(`After Effects could not be asked (${r.error?.message}): checked from the disk only`);
  } catch (e) {
    notes.push(`After Effects is not reachable (${e instanceof BridgeError ? e.code : (e as Error).message}): checked from the disk only, as \`surehand-ae farm check\` does`);
  }
  const platform = platformOf();
  const r = checkManifest(m, { platform, home: homedir(), aeFolder: a.aePath ? abs(a.aePath, "aePath") : undefined, pathMap: a.pathMap, live });
  r.notes.unshift(...notes);
  return text(formatCheck(r, m, source));
}

// ---------- plan ----------

async function planFor(a: FarmInput, o: { forRun?: boolean } = {}): Promise<{ plan: FarmPlan; scan: FarmScan }> {
  if (Array.isArray(a.rqIndex) && a.rqIndex.length !== 1) throw new PlanRefusal("A plan is for one render queue item: pass rqIndex as one number.");
  const idx = Array.isArray(a.rqIndex) ? a.rqIndex[0] : a.rqIndex;
  const s = await scan({ rq: idx !== undefined ? [idx] : undefined, itemsOnly: true });
  if (!s.file) throw new PlanRefusal("The project has never been saved. aerender renders the project file: save it first (ae_save_project with a path).");
  const it = s.items[0];
  if (!it) throw new PlanRefusal(s.rqCount ? "No render queue item is queued. Pass rqIndex to choose one (any status)." : "The render queue is empty. Add the comp to the render queue with your output settings first (ae_add_to_render_queue).");
  if (o.forRun && a.machines?.length) throw new PlanRefusal("run_local renders on this machine only. For other machines, plan with machines and run the scripts there.");
  const platform = platformOf();
  const aerender = s.app ? aerenderNextTo(s.app, platform) : null;
  // the time estimate: a stored render profile of this comp, else a few frames sampled now (saying so)
  let profile = null as ReturnType<typeof findProfile>, profileSource: "profile" | "sampled" | undefined;
  const mode = a.estimate ?? "auto";
  if (mode !== "none" && !o.forRun) {
    profile = mode === "sample" ? null : findProfile(s.file, it.comp.id);
    if (profile) profileSource = "profile";
    else if (mode !== "profile") {
      const fd = it.comp.fd || 1 / it.comp.fps, f0 = Math.round(it.start / fd), f1 = f0 + Math.max(1, Math.round(it.dur / fd)) - 1;
      const r = await measure({ action: "measure", comp: it.comp.id, startFrame: f0, endFrame: f1, frames: Math.min(5, f1 - f0 + 1), runs: 1, layers: false, bitDepthCheck: false, timeBudgetSeconds: 120 }, { mode: "read-only" });
      if (!r.isError) {
        profile = findProfile(s.file, it.comp.id);
        if (profile) profileSource = "sampled";
      }
    }
  }
  const folder = a.folder ? abs(a.folder, "folder") : defaultPlanFolder(s.file, it.index);
  const plan = buildPlan({ item: it, project: s.file, aeVersion: s.ae ?? null, aeApp: s.app ?? null, aerender, platform, processes: a.processes, machines: a.machines, pathMap: a.pathMap, mfr: a.mfr, profile, profileSource, folder });
  if (s.dirty) plan.issues.unshift("the project has unsaved changes: aerender renders the file on disk, so save it before rendering (ae_save_project)");
  if (!aerender && plan.machines.some((m) => m.local)) plan.issues.unshift(`aerender was not found next to ${s.app ?? "After Effects"}`);
  return { plan, scan: s };
}

async function planAction(a: FarmInput, mode: string): Promise<CallToolResult> {
  if (mode === "read-only" && !a.dryRun) return errorResult(`${READ_ONLY_REFUSAL} (A plan writes its scripts; dryRun: true shows it without writing.)`);
  const { plan } = await planFor(a);
  const scripts = planScripts(plan, plan.folder!);
  const files = [join(plan.folder!, planFileName), ...scripts.map((s) => s.path)];
  if (a.dryRun) return text(formatPlan(plan, { dryRun: true }) + `\nWould write to ${plan.folder}: ${files.map((f) => basename(f)).join(", ")}.`);
  const exists = files.filter((f) => existsSync(f));
  if (exists.length && !a.overwrite) return errorResult(`${plan.folder} already has ${exists.map((f) => basename(f)).join(", ")}. Nothing was written. Pass overwrite: true to replace ${exists.length > 1 ? "them" : "it"}, or another folder.`);
  mkdirSync(plan.folder!, { recursive: true });
  plan.scripts = scripts.map((s) => s.path);
  for (const s of scripts) {
    writeFileSync(s.path, s.text);
    if (s.executable) chmodSync(s.path, 0o755);
  }
  writeFileSync(files[0], JSON.stringify(plan, null, 1));
  return text(formatPlan(plan, { written: files }) + `\nRun it here: ae_farm {action: "run_local", plan: "${files[0]}"}; afterwards ae_farm {action: "verify", plan: "${files[0]}"}.`);
}

// ---------- run_local and status ----------

interface Run { id: string; plan: FarmPlan; planFile: string | null; chunks: { index: number; job?: RenderJob; state: "waiting" | "started" }[]; max: number; startedAt: string; cancelled?: boolean }
const runs = new Map<string, Run>();

/** Files the plan's chunks would write that exist already. */
export function existingOutputs(plan: FarmPlan): string[] {
  if (plan.sequence) {
    const p = parseTemplate(plan.sequence.template);
    if (!p) return [];
    return listFrames(p).filter((f) => f.num >= plan.sequence!.firstFile && f.num <= plan.sequence!.lastFile).map((f) => join(p.dir, f.name));
  }
  const mv = plan.movie!;
  return [...new Set([...mv.parts, mv.final])].filter((f) => existsSync(f));
}

function startNext(run: Run) {
  if (run.cancelled) return;
  for (const c of run.chunks) {
    if (run.chunks.filter((x) => x.job?.status === "running").length >= run.max) break;
    if (c.state !== "waiting") continue;
    const ch = run.plan.chunks.find((x) => x.index === c.index)!;
    const m = run.plan.machines[0];
    if (ch.output) mkdirSync(dirname(ch.output), { recursive: true });
    c.state = "started";
    c.job = startAerenderJob({
      bin: m.aerender, cli: ch.args, comp: run.plan.comp.name, output: ch.output ?? run.plan.output.path ?? "", project: m.project, frames: ch.frames, group: run.id, chunk: ch.index,
      onExit: () => startNext(run),
    });
  }
}

async function runLocalAction(a: FarmInput, mode: string): Promise<CallToolResult> {
  if (mode === "read-only") return errorResult(`${READ_ONLY_REFUSAL} (run_local starts aerender processes that write the render.)`);
  let plan: FarmPlan, planFile: string | null = null;
  const notes: string[] = [];
  if (a.plan) {
    planFile = abs(a.plan, "plan");
    try {
      plan = readPlanFile(planFile);
    } catch (e: any) {
      return errorResult(`${e?.message ?? e}`);
    }
  } else plan = (await planFor({ ...a, estimate: "none" }, { forRun: true })).plan;
  if (plan.machines.length !== 1 || !plan.machines[0].local) return errorResult(`This plan is for ${plan.machines.map((m) => m.name).join(", ")}: run its scripts on those machines. run_local renders only on this machine (plan without machines).`);
  const now = fileStamp(plan.project.file);
  if (now.bytes === null) return errorResult(`The project ${plan.project.file} is not there. Nothing was started.`);
  if (planFile && (now.bytes !== plan.project.bytes || now.modified !== plan.project.modified)) return errorResult(`The project was saved again after this plan was made (${plan.createdAt}). Nothing was started. Plan again, so the chunks match the project.`);
  // the open project: aerender renders the file, so unsaved changes would not be in the render
  try {
    const r = await runJsx(`return { file: app.project.file ? app.project.file.fsName : null, dirty: app.project.dirty };`, {}, { undoGroup: false, timeoutMs: 30_000 });
    const d = r.ok ? parse<{ file: string | null; dirty: boolean }>(r) : null;
    if (d?.dirty && d.file && d.file === plan.project.file) return errorResult("The project has unsaved changes, and aerender renders the file on disk. Nothing was started. Save it first (ae_save_project), then plan again.");
  } catch {
    notes.push("After Effects is not reachable: unsaved changes in it were not checked (aerender renders the saved file)");
  }
  const bin = plan.machines[0].aerender;
  if (!existsSync(bin)) return errorResult(`aerender is not at ${bin}. Nothing was started.`);
  const existing = existingOutputs(plan);
  if (existing.length && !a.overwrite) {
    const what = plan.sequence ? `${existing.length} frame file${existing.length === 1 ? "" : "s"} of this render exist already (${basename(existing[0])}${existing.length > 1 ? ` ... ${basename(existing[existing.length - 1])}` : ""})` : `${existing.map((f) => basename(f)).join(", ")} exist${existing.length === 1 ? "s" : ""} already`;
    return errorResult(`${what}. Nothing was started. Pass overwrite: true to render over ${existing.length === 1 ? "it" : "them"}, or move ${existing.length === 1 ? "it" : "them"} away.`);
  }
  const lim = maxLocalProcesses();
  const max = Math.max(1, Math.min(plan.chunks.length, lim.max));
  if (plan.chunks.length > lim.max) notes.push(`${plan.chunks.length} chunks, at most ${lim.max} at once here (${lim.why}): the others start as these finish`);
  if (a.dryRun) return text(`Dry run: would start ${plan.chunks.length} aerender process${plan.chunks.length === 1 ? "" : "es"} (${max} at once) for "${plan.comp.name}" frames ${plan.frames.first}-${plan.frames.last}.\n${plan.chunks.map((c) => `  ${c.index}. frames ${c.first}-${c.last}`).join("\n")}${notes.length ? `\nNotes:\n${notes.map((n) => `  - ${n}`).join("\n")}` : ""}`);
  const id = `farm${Date.now().toString(36)}`;
  const run: Run = { id, plan, planFile, chunks: plan.chunks.map((c) => ({ index: c.index, state: "waiting" })), max, startedAt: new Date().toISOString() };
  runs.set(id, run);
  startNext(run);
  return text(
    `Started run ${id}: ${plan.chunks.length} chunk${plan.chunks.length === 1 ? "" : "s"} of "${plan.comp.name}" (frames ${plan.frames.first}-${plan.frames.last}), ${max} aerender process${max === 1 ? "" : "es"} at once on this machine.\n` +
      run.chunks.map((c) => `  ${c.index}. frames ${plan.chunks[c.index - 1].first}-${plan.chunks[c.index - 1].last}: ${c.job ? `job ${c.job.id} (log ${c.job.log})` : "waiting"}`).join("\n") +
      `\nProgress: ae_farm {action: "status", run: "${id}"} (or ae_render_jobs per job). When it is done: ae_farm {action: "verify"${planFile ? `, plan: "${planFile}"` : `, rqIndex: ${plan.rqIndex}`}}.` +
      (notes.length ? `\nNotes:\n${notes.map((n) => `  - ${n}`).join("\n")}` : ""),
  );
}

const medianOf = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN;
};

function statusAction(a: FarmInput): CallToolResult {
  const list = a.run ? [runs.get(a.run)].filter(Boolean) as Run[] : [...runs.values()];
  if (a.run && !list.length) return errorResult(`No run ${a.run} in this session (runs started with run_local; ae_render_jobs lists every background render).`);
  if (!list.length) return text("No chunked runs in this session.");
  const out: string[] = [];
  for (const run of list) {
    if (a.cancel) {
      run.cancelled = true;
      for (const c of run.chunks) if (c.job) cancelJob(c.job);
    }
    const all = run.chunks.map((c) => ({ c, ch: run.plan.chunks[c.index - 1], j: c.job ? renderJob(c.job.id) ?? c.job : undefined }));
    const spf = medianOf(all.flatMap((x) => x.j?.frameSeconds ?? []));
    const done = all.filter((x) => x.j?.status === "done").length, failed = all.filter((x) => x.j && ["failed", "cancelled"].includes(x.j.status)).length;
    const framesDone = all.reduce((n, x) => n + Math.min(x.ch.frames, x.j?.status === "done" ? x.ch.frames : x.j?.frameRendered ?? 0), 0);
    const left = all.filter((x) => !x.j || x.j.status === "running").reduce((n, x) => n + x.ch.frames - (x.j?.frameRendered ?? 0), 0);
    const state = run.cancelled ? "cancelled" : done === all.length ? "done" : failed && !all.some((x) => x.j?.status === "running" || x.c.state === "waiting") ? "finished with failures" : "running";
    out.push(`Run ${run.id}: ${state}. ${framesDone} of ${run.plan.frames.frames} frames rendered; ${done} of ${all.length} chunks done${failed ? `, ${failed} failed or cancelled` : ""}.${Number.isFinite(spf) && left > 0 && state === "running" ? ` About ${fmtDuration((left * spf) / run.max)} left at ${spf} s per frame (aerender reports whole seconds), ${run.max} at once.` : ""}`);
    for (const x of all) {
      const j = x.j;
      out.push(`  ${x.c.index}. frames ${x.ch.first}-${x.ch.last}: ${!j ? "waiting" : `${j.status}, ${Math.min(j.frameRendered, x.ch.frames)}/${x.ch.frames}${j.frameSeconds.length ? `, ${medianOf(j.frameSeconds)} s per frame` : ""}${j.status === "failed" ? ` (${j.tail.slice(-2).join(" | ")}; log ${j.log})` : ""}`}`);
    }
    if (state !== "running") out.push(`  Verify: ae_farm {action: "verify"${run.planFile ? `, plan: "${run.planFile}"` : `, rqIndex: ${run.plan.rqIndex}`}}`);
  }
  return text(out.join("\n"));
}

// ---------- verify ----------

async function verifyAction(a: FarmInput, mode: string): Promise<CallToolResult> {
  if (a.join && mode === "read-only") return errorResult(`${READ_ONLY_REFUSAL} (join writes the joined file; verify without join is read-only.)`);
  let plan: FarmPlan;
  if (a.plan) {
    try {
      plan = readPlanFile(abs(a.plan, "plan"));
    } catch (e: any) {
      return errorResult(e?.message ?? String(e));
    }
  } else plan = (await planFor({ ...a, estimate: "none" })).plan;
  const problems: string[] = [], notes: string[] = [], notRun: string[] = [];
  const out: string[] = [];
  let ff: FfmpegPaths | null = null;
  const needFf = !!plan.movie || ((a.proveFrames ?? 0) > 0 && !!plan.sequence && !/\.png$/i.test(plan.sequence.template));
  if (needFf) {
    try {
      ff = await ensureFfmpeg({ allowDownload: !!a.allowFfmpegDownload && mode !== "read-only", signal: callContext.getStore()?.signal, confirmDownload: mode === "ask" ? approveDownload : undefined });
    } catch (e: any) {
      notRun.push(`${plan.movie ? "the movie checks" : "the pixel proof"}: ${e instanceof FfmpegMissingError ? `${e.message} Ask the user before passing allowFfmpegDownload: true.` : e?.message ?? e}`);
    }
  }
  if (plan.sequence) {
    const s = verifySequence(plan.sequence.template, plan.sequence.firstFile, plan.sequence.lastFile);
    problems.push(...sequenceProblems(s));
    out.push(`Sequence ${s.template}: ${s.present} of ${s.expected[1] - s.expected[0] + 1} frames (${s.expected[0]}-${s.expected[1]}) present${s.checked === "header" ? "; files checked by their header and size (this format has no end marker)" : ", every file complete"}.`);
    if (s.small.length) notes.push(`${s.small.length} file(s) much smaller than the others (only worth a look: sizes vary with the picture): ${s.small.slice(0, 6).join(", ")}`);
  } else if (ff) {
    const mv = await verifyMovie(plan, ff, { join: a.join, signal: callContext.getStore()?.signal });
    problems.push(...mv.problems);
    notes.push(...mv.notes);
    for (const [i, p] of mv.parts.entries()) out.push(`Part ${i + 1}: ${p.exists ? `${p.frames ?? "?"} of ${p.expected} frames${p.codec ? `, ${p.codec}` : ""}${p.width ? `, ${p.width}x${p.height}` : ""}` : "not there"} (${basename(p.file)})`);
    if (mv.join) out.push(`Join: ${mv.join.safe === "yes" ? "lossless by stream copy" : mv.join.safe === "no" ? "NOT lossless" : "not known"}: ${mv.join.why.join("; ")}.`);
    if (mv.joined) out.push(`Joined file ${plan.movie!.final}${mv.joined.madeNow ? " (joined now)" : ""}: ${mv.joined.frames ?? "?"} frames, ${mv.joined.width}x${mv.joined.height}, ${mv.joined.fps ? Math.round(mv.joined.fps * 1000) / 1000 : "?"} fps, ${mv.joined.codec ?? "?"}.`);
  }
  // the pixel proof: sampled frames rendered here in After Effects and compared with what the farm wrote
  let proof: ProofFrame[] = [];
  if ((a.proveFrames ?? 0) > 0) {
    const n = Math.min(a.proveFrames!, plan.frames.frames);
    const frames = [...new Set(Array.from({ length: n }, (_, i) => plan.frames.first + Math.round((i * (plan.frames.frames - 1)) / Math.max(1, n - 1))))];
    const tol = a.tolerance ?? DEFAULT_TOLERANCE;
    try {
      const cur = await runJsx(`return app.project.file ? app.project.file.fsName : null;`, {}, { undoGroup: false, timeoutMs: 30_000 });
      if (!cur.ok || cur.result !== plan.project.file) notRun.push(`the pixel proof: After Effects has ${cur.ok ? cur.result ?? "an unsaved project" : "no answer"} open, not ${plan.project.file}`);
      else {
        const cap = await captureProof({ comps: [plan.comp.id], times: frames.map((f) => f / plan.comp.fps), maxSize: Math.max(plan.comp.width, plan.comp.height) * 2 });
        const dir = proofDir(cap.id);
        mkdirSync(appFile("tmp"), { recursive: true });
        const tmp = mkdtempSync(join(appFile("tmp"), "farm-proof-"));
        try {
          const local = cap.comps[0]?.frames ?? [];
          const pairs = [];
          for (const [i, f] of frames.entries()) {
            const got = await farmFrame(plan, f, ff, tmp, callContext.getStore()?.signal);
            pairs.push({ frame: f, farm: got.path, local: local[i] ? join(dir, local[i].file) : null, why: got.why });
          }
          proof = compareProof(pairs, tol);
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
        const bad = proof.filter((p) => p.result === "differs");
        if (bad.length) problems.push(`${bad.length} of ${proof.length} sampled frames differ from a render here: ${bad.map((p) => `f${p.frame} (max ${p.maxDiff}/255)`).join(", ")}`);
        const nc = proof.filter((p) => p.result === "not compared");
        if (nc.length) notRun.push(`the pixel proof for ${nc.map((p) => `f${p.frame}`).join(", ")}: ${nc[0].detail}`);
        out.push(`Pixel proof (tolerance ${tol}/255; the local render is After Effects' own frame render, without the render settings' quality, resolution or proxies): ${proof.map((p) => `f${p.frame} ${p.result}${p.maxDiff !== undefined ? ` (max ${p.maxDiff})` : ""}`).join(", ")}.`);
      }
    } catch (e: any) {
      notRun.push(`the pixel proof: ${e instanceof BridgeError ? "After Effects is not reachable" : e?.message ?? e}`);
    }
  }
  const verdict = problems.length ? `FAIL (${problems.length})` : notRun.length ? `INCOMPLETE (${notRun.length} not checked)` : "PASS";
  const head = problems.length
    ? `${verdict}: the chunked render of "${plan.comp.name}" (frames ${plan.frames.first}-${plan.frames.last}) is not complete.`
    : notRun.length
      ? `${verdict}: nothing wrong found, but not everything could be checked.`
      : `PASS: the chunked render of "${plan.comp.name}" is complete: ${plan.frames.frames} frames${plan.sequence ? ", every file present once and complete" : ""}${proof.length ? `, ${proof.length} sampled frames match a render here` : ""}.`;
  const lines = [head, ...out];
  if (problems.length) lines.push("", "Problems:", ...problems.map((p) => `  - ${p}`));
  if (notRun.length) lines.push("", "Not checked:", ...notRun.map((p) => `  - ${p}`));
  if (notes.length) lines.push("", "Notes:", ...notes.map((p) => `  - ${p}`));
  const missing = plan.sequence ? verifySequence(plan.sequence.template, plan.sequence.firstFile, plan.sequence.lastFile).missing : [];
  if (missing.length) {
    const back = runsOf(missing.map((n) => n - plan.sequence!.offset));
    lines.push("", `To render the missing frames again: aerender ... -rqindex ${plan.rqIndex} -s <first> -e <last> for frames ${runsText(back)} (counted from the comp start at 0).`);
  }
  return text(lines.join("\n"));
}

// ---------- the tool ----------

export async function farm(a: FarmInput): Promise<CallToolResult> {
  const mode = permissions().mode;
  try {
    switch (a.action) {
      case "manifest":
        return await manifestAction(a, mode);
      case "check":
        return await checkAction(a);
      case "plan":
        return await planAction(a, mode);
      case "run_local":
        return await runLocalAction(a, mode);
      case "status":
        return statusAction(a);
      case "verify":
        return await verifyAction(a, mode);
    }
  } catch (e) {
    if (e instanceof PlanRefusal) return errorResult(e.message);
    return errorResult(e);
  }
}

const mapping = z.array(z.object({ from: z.string(), to: z.string() })).max(20);

export function registerFarmTools(server: McpServer) {
  server.registerTool(
    "ae_farm",
    {
      title: "Render farm",
      description:
        "Render farm readiness and chunked renders, measured. manifest: what render queue items need on a node: AE version, bit depth, colour/OCIO, " +
        "expressions engine, plug-ins by match name, fonts, every file the render pulls in (sequence ranges and gaps; local vs shared paths), outputs; " +
        "save writes JSON + .txt. check: this machine against a manifest (also `surehand-ae farm check` without AE). plan: frame chunks for " +
        "processes here or named machines, aerender commands with the item's own settings, scripts, the movie join and whether it is lossless, a " +
        "time estimate. run_local: chunks as parallel aerender jobs here. status: progress. verify: every frame once and complete, movie parts and " +
        "joined file probed, optional pixel proof. Never runs anything on other machines.",
      inputSchema: {
        action: z.enum(["manifest", "check", "plan", "run_local", "status", "verify"]),
        rqIndex: z.union([z.number().int().min(1), z.array(z.number().int().min(1)).min(1).max(50)]).optional().describe("Render queue item(s); default the queued ones (plan/run_local/verify: one, the first queued)."),
        sharedPaths: z.array(z.string()).max(20).optional().describe("manifest: folders other machines see at the same path."),
        save: z.union([z.boolean(), z.string()]).optional().describe("manifest: true = next to the project, or an absolute .json path."),
        manifest: z.union([z.string(), z.record(z.string(), z.any())]).optional().describe("check: the manifest's path (or object)."),
        pathMap: mapping.optional().describe('check/plan: where another machine sees a folder, e.g. [{from: "/Volumes/Jobs", to: "J:\\\\Jobs"}].'),
        aePath: z.string().optional().describe("check: the After Effects install folder (default: found)."),
        processes: z.number().int().min(1).max(32).optional().describe("plan/run_local: chunks on this machine (default 1)."),
        machines: z
          .array(z.object({ name: z.string(), platform: z.enum(["mac", "windows"]).optional(), aerender: z.string().optional(), pathMap: mapping.optional(), weight: z.number().positive().optional(), processes: z.number().int().min(1).max(16).optional() }))
          .max(64)
          .optional()
          .describe("plan: named machines, one script each (weight: relative speed)."),
        mfr: z.enum(["auto", "on", "off", "leave"]).optional().describe("plan: aerender -mfr (auto: a CPU share per process when several share a machine)."),
        estimate: z.enum(["auto", "profile", "sample", "none"]).optional().describe("plan: from a render profile, else a few sampled frames (auto)."),
        folder: z.string().optional().describe("plan: where the plan and scripts go (default next to the project)."),
        plan: z.string().optional().describe("run_local/verify: the farm-plan.json path."),
        run: z.string().optional().describe("status: the run id."),
        cancel: z.boolean().optional().describe("status: cancel the run's chunks."),
        join: z.boolean().optional().describe("verify: join movie parts by stream copy when lossless (never over a file)."),
        proveFrames: z.number().int().min(0).max(12).optional().describe("verify: frames compared pixel by pixel with a render here."),
        tolerance: z.number().min(0).max(255).optional().describe("verify: per-channel tolerance for the pixel proof (default 0.5)."),
        allowFfmpegDownload: z.boolean().optional().describe("verify: only after the user agreed: download ffmpeg once."),
        overwrite: z.boolean().optional().describe("Replace existing files (default: refuse)."),
        dryRun: z.boolean().optional().describe("manifest/plan/run_local: show without writing or starting."),
      },
      // writes the manifest, the plan's scripts and the render (overwrite replaces files); verify can download ffmpeg
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (a: FarmInput) => farm(a),
  );
}

export { runs as farmRuns };
