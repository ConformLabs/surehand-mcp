// Background renders with aerender (After Effects' command-line renderer): After Effects stays
// usable while a separate render process works, with progress, status and cancel.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, createWriteStream, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { runJsx } from "../jsx.js";
import { permissions, READ_ONLY_REFUSAL } from "../permissions.js";
import { errorResult, formatResult } from "./registry.js";
import { appFile } from "../paths.js";

interface Job {
  id: string;
  comp: string;
  output: string;
  project: string;
  status: "running" | "done" | "failed" | "cancelled";
  startedAt: string;
  endedAt?: string;
  frames: number;
  frameRendered: number;
  log: string;
  tail: string[];
  proc?: ChildProcess;
  /** the aerender process (a detached job outlives this server; after a restart it is found again by its pid) */
  pid?: number;
  exitCode?: number | null;
  /** a chunked render (ae_farm run_local): the run it belongs to and its chunk */
  group?: string;
  chunk?: number;
  /** each frame's render time in seconds, as aerender prints it ("PROGRESS: ... (n): 3 Seconds": whole seconds only) */
  frameSeconds: number[];
  /** when the first and the latest progress line came (ms), and their frame counts: the measured time per frame */
  progressAt?: { first: number; firstFrame: number; last: number; lastFrame: number };
  /** "Total Time Elapsed: N Seconds" at the end of aerender's log */
  totalSeconds?: number;
  /** found again from its files after the server restarted (no exit code seen) */
  recovered?: boolean;
  onExit?: (j: Job) => void;
  /** called once, when aerender reports its first rendered frame (it has started up) */
  onFirstFrame?: (j: Job) => void;
}

const jobs = new Map<string, Job>();
export type RenderJob = Job;
export const renderJobs = () => [...jobs.values()];
/** Tests: forget this session's jobs, as a restarted server would (they are found again from their files). */
export const forgetJobs = () => jobs.clear();
const LOG_DIR = () => appFile("renders");

/** How many background renders keep their files (renders/<id>.log and .json). */
export const RENDERS_KEPT = 50;

/**
 * Removes the files of all but the newest `keep` renders in `dir` (by the newest of each job's
 * files); `active` jobs (still running) are never removed.
 */
export function pruneRenders(dir: string, keep = RENDERS_KEPT, active: Set<string> = new Set()) {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const jobs = new Map<string, { files: string[]; at: number }>();
  for (const n of names) {
    const m = /^(r[0-9a-z]+)\.(log|json)$/.exec(n);
    if (!m) continue;
    let at = 0;
    try {
      at = statSync(join(dir, n)).mtimeMs;
    } catch {}
    const j = jobs.get(m[1]) ?? { files: [], at: 0 };
    j.files.push(n);
    j.at = Math.max(j.at, at);
    jobs.set(m[1], j);
  }
  const old = [...jobs.entries()].sort((a, b) => b[1].at - a[1].at).slice(keep);
  for (const [id, j] of old) {
    if (active.has(id)) continue;
    for (const f of j.files) {
      try {
        unlinkSync(join(dir, f));
      } catch {}
    }
  }
}

/** aerender lives next to the After Effects app (macOS) or AfterFX.exe (Windows). */
export function aerenderPath(appPackage: string): string | null {
  const candidates =
    process.platform === "win32"
      ? [join(appPackage, "aerender.exe"), join(dirname(appPackage), "aerender.exe"), join(appPackage, "Support Files", "aerender.exe")]
      : [join(dirname(appPackage), "aerender"), join(appPackage, "..", "aerender")];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * renders/<id>.json for the Surehand MCP panel, kept up to date while the job runs:
 * {id, comp, frames, done, status, output, startedAt, endedAt?} (done = frames rendered so far), plus what finds a
 * detached job again after a restart (pid, log, group, chunk, project).
 */
export function writeJobFile(j: Pick<Job, "id" | "comp" | "frames" | "frameRendered" | "status" | "output" | "startedAt" | "endedAt"> & Partial<Job>) {
  try {
    mkdirSync(LOG_DIR(), { recursive: true });
    const o = {
      id: j.id, comp: j.comp, frames: j.frames, done: j.status === "done" ? j.frames || j.frameRendered : j.frameRendered, status: j.status, output: j.output, startedAt: j.startedAt, ...(j.endedAt ? { endedAt: j.endedAt } : {}),
      ...(j.pid ? { pid: j.pid } : {}), ...(j.log ? { log: j.log } : {}), ...(j.project ? { project: j.project } : {}), ...(j.group ? { group: j.group, chunk: j.chunk } : {}),
    };
    writeFileSync(join(LOG_DIR(), `${j.id}.json`), JSON.stringify(o));
  } catch {} // never fails a render
}

/** One line of aerender's output: the frame count (the number in brackets) and that frame's time. */
export function parseProgress(line: string): { frame: number; seconds: number | null } | null {
  const m = line.match(/PROGRESS:.*\((\d+)\)(?::\s*([\d.]+)\s*Seconds?)?/i);
  return m ? { frame: Number(m[1]), seconds: m[2] !== undefined ? Number(m[2]) : null } : null;
}
/** "PROGRESS:  Total Time Elapsed: 2 Seconds" (also minutes and hours). */
export function parseTotal(line: string): number | null {
  const m = /Total Time Elapsed:\s*(.+)$/i.exec(line);
  if (!m) return null;
  let s = 0, any = false;
  for (const [, n, u] of m[1].matchAll(/([\d.]+)\s*(hour|hr|minute|min|second|sec)/gi)) {
    any = true;
    s += Number(n) * (/^h/i.test(u) ? 3600 : /^m/i.test(u) ? 60 : 1);
  }
  return any ? s : null;
}

/** The measured render time per frame (s): aerender's total over the frames, else the time between progress lines, else its whole-second figures. */
export function secondsPerFrame(j: Pick<Job, "frameRendered" | "frameSeconds" | "progressAt" | "totalSeconds" | "status">): number | null {
  if (j.totalSeconds !== undefined && j.frameRendered > 0 && j.status !== "running") return j.totalSeconds / j.frameRendered;
  const p = j.progressAt;
  if (p && p.lastFrame > p.firstFrame) return (p.last - p.first) / 1000 / (p.lastFrame - p.firstFrame);
  return j.frameSeconds.length ? medianOf(j.frameSeconds) : null;
}
/** "0.06 s" / "62 ms" / "2.4 s" */
export const perFrameText = (s: number) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${Math.round(s * 10) / 10} s`);

/** Reads aerender's output into the job: progress, per-frame times, the last lines. */
function ingest(job: Job, text: string, at = Date.now()) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // e.g. "PROGRESS:  0;00;00;05 (6): 0 Seconds"
    const pr = parseProgress(line);
    if (pr) {
      if (pr.frame > job.frameRendered && pr.seconds !== null && job.frameSeconds.length < 100_000) job.frameSeconds.push(pr.seconds);
      if (pr.frame > job.frameRendered) {
        if (!job.progressAt) {
          job.progressAt = { first: at, firstFrame: pr.frame, last: at, lastFrame: pr.frame };
          if (job.onFirstFrame) setImmediate(() => job.onFirstFrame?.(job));
        }
        else Object.assign(job.progressAt, { last: at, lastFrame: pr.frame });
      }
      job.frameRendered = Math.max(job.frameRendered, pr.frame);
    }
    const total = parseTotal(line);
    if (total !== null) job.totalSeconds = total;
    job.tail.push(line.trim());
    if (job.tail.length > 50) job.tail.shift();
  }
}
const failedLog = (j: Job) => j.tail.some((l) => /aerender ERROR|^ERROR/i.test(l));

export interface StartJob {
  bin: string; cli: string[]; comp: string; output: string; project: string; frames: number; group?: string; chunk?: number; onExit?: (j: Job) => void; onFirstFrame?: (j: Job) => void;
  /** a process of its own that writes straight into its log and outlives this server (a reload of the AI app) */
  detached?: boolean;
}

/** Starts aerender as a background job: its log, the panel's renders/<id>.json, progress and cancel (ae_render_jobs). */
export function startAerenderJob(o: StartJob): Job {
  mkdirSync(LOG_DIR(), { recursive: true });
  // keep the folder from growing forever: the newest renders only (never one still running)
  pruneRenders(LOG_DIR(), RENDERS_KEPT - 1, new Set([...jobs.values()].filter((j) => j.status === "running").map((j) => j.id)));
  let id = `r${Date.now().toString(36)}`;
  for (let k = 1; jobs.has(id) || existsSync(join(LOG_DIR(), `${id}.json`)); k++) id = `r${Date.now().toString(36)}${k.toString(36)}`;
  const logPath = join(LOG_DIR(), `${id}.log`);
  const job: Job = {
    id, comp: o.comp, output: o.output, project: o.project, status: "running",
    startedAt: new Date().toISOString(), frames: o.frames, frameRendered: 0, log: logPath, tail: [], frameSeconds: [],
    ...(o.group ? { group: o.group, chunk: o.chunk } : {}), onExit: o.onExit, onFirstFrame: o.onFirstFrame,
  };
  let written = 0;
  const progress = () => {
    // progress for the panel, at most twice a second
    if (Date.now() - written > 500) {
      written = Date.now();
      writeJobFile(job);
    }
  };
  let proc: ChildProcess, poll: ReturnType<typeof setInterval> | undefined, finish: () => void = () => {};
  if (o.detached) {
    // aerender writes into its log file itself (no pipe to this server), so it goes on when the server stops;
    // the log is read as it grows
    const fd = openSync(logPath, "w");
    try {
      proc = spawn(o.bin, o.cli, { stdio: ["ignore", fd, fd], detached: true, windowsHide: true });
    } finally {
      closeSync(fd);
    }
    proc.unref();
    let offset = 0;
    const read = () => {
      try {
        const rfd = openSync(logPath, "r");
        try {
          const size = fstatSync(rfd).size;
          if (size > offset) {
            const b = Buffer.alloc(size - offset);
            readSync(rfd, b, 0, b.length, offset);
            offset = size;
            ingest(job, b.toString());
            progress();
          }
        } finally {
          closeSync(rfd);
        }
      } catch {}
    };
    poll = setInterval(read, 250);
    poll.unref?.();
    finish = () => {
      clearInterval(poll);
      read();
    };
  } else {
    const logStream = createWriteStream(logPath);
    proc = spawn(o.bin, o.cli, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const onData = (d: Buffer) => {
      const text = d.toString();
      logStream.write(text);
      ingest(job, text);
      progress();
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    finish = () => logStream.end();
  }
  job.proc = proc;
  job.pid = proc.pid;
  writeJobFile(job);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    job.proc = undefined;
    writeJobFile(job);
    try {
      job.onExit?.(job);
    } catch {}
  };
  proc.on("error", (e) => {
    finish();
    job.status = "failed";
    job.tail.push(String(e));
    job.endedAt = new Date().toISOString();
    end();
  });
  proc.on("exit", (code) => {
    finish();
    job.exitCode = code;
    job.endedAt = new Date().toISOString();
    if (job.status === "running") job.status = code === 0 && !failedLog(job) && !(job.group && job.frameRendered < job.frames) ? "done" : "failed";
    if (job.group && code === 0 && job.frameRendered < job.frames) job.tail.push(`(aerender ended after ${job.frameRendered} of ${job.frames} frames)`);
    end();
  });
  jobs.set(id, job);
  return job;
}

/**
 * Whether a job's process still runs. Windows: asked with tasklist, by pid and image name (a signal-0 check said
 * "running" for a detached aerender that was gone, seen live on Windows 11), so a reused pid doesn't count either.
 */
export const processCheck = {
  alive(pid?: number): boolean {
    if (!pid) return false;
    if (process.platform === "win32") {
      try {
        const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
        if (r.status !== 0 || r.error) return true; // can't tell: don't call it dead
        return r.stdout.split(/\r?\n/).some((l) => l.includes(`"${pid}"`) && /aerender|afterfx/i.test(l));
      } catch {
        return true;
      }
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: any) {
      return e?.code === "EPERM";
    }
  },
};
const alive = (pid?: number) => processCheck.alive(pid);

/**
 * A job this server did not start (it started before a restart): its renders/<id>.json and log, and whether its
 * process still runs. A job whose process is gone counts as done when every frame was rendered and the log has no error.
 */
function recover(id: string): Job | undefined {
  if (!/^r[0-9a-z]+$/.test(id)) return undefined;
  let d: any;
  try {
    d = JSON.parse(readFileSync(join(LOG_DIR(), `${id}.json`), "utf8"));
  } catch {
    return undefined;
  }
  const job: Job = {
    id, comp: d.comp, output: d.output, project: d.project ?? "", status: d.status, startedAt: d.startedAt, endedAt: d.endedAt, frames: d.frames, frameRendered: 0,
    log: d.log ?? join(LOG_DIR(), `${id}.log`), tail: [], frameSeconds: [], pid: d.pid, recovered: true, ...(d.group ? { group: d.group, chunk: d.chunk } : {}),
  };
  refresh(job);
  jobs.set(id, job);
  return job;
}

/** A recovered job: its log read again, and whether its process still runs. */
function refresh(job: Job) {
  if (!job.recovered) {
    // a job of this session whose process is gone but whose exit was never seen: failed, with its log's last lines
    if (job.status === "running" && job.pid && Date.now() - Date.parse(job.startedAt) > 3000 && !alive(job.pid)) {
      job.status = job.frameRendered >= job.frames && !failedLog(job) ? "done" : "failed";
      job.endedAt ??= new Date().toISOString();
      job.tail.push(`(aerender is gone after ${job.frameRendered} of ${job.frames} frames; its exit was not seen)`);
      job.proc = undefined;
      writeJobFile(job);
    }
    return;
  }
  const st = { status: job.status, frameRendered: job.frameRendered };
  job.tail = [];
  job.frameSeconds = [];
  job.frameRendered = 0;
  try {
    ingest(job, readFileSync(job.log, "utf8"), Date.parse(job.startedAt));
  } catch {}
  if (job.status === "running" && !alive(job.pid)) {
    job.status = job.frameRendered >= job.frames && !failedLog(job) ? "done" : "failed";
    job.endedAt ??= new Date().toISOString();
    job.tail.push(`(aerender ended while the server was restarting; its exit code was not seen)`);
  }
  if (st.status !== job.status || st.frameRendered !== job.frameRendered) writeJobFile(job);
}

/** A job of this session, or one found again from its files after the server restarted. */
export function renderJob(id: string): Job | undefined {
  const j = jobs.get(id);
  if (j) {
    refresh(j);
    return j;
  }
  return recover(id);
}

/** Stops a running job (its status becomes "cancelled"). */
export function cancelJob(j: Job) {
  if (j.status !== "running") return;
  if (j.proc) j.proc.kill();
  else if (j.pid && alive(j.pid)) {
    try {
      process.kill(j.pid);
    } catch {}
  } else return;
  j.status = "cancelled";
  j.endedAt ??= new Date().toISOString();
  writeJobFile(j);
}

const medianOf = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function view(j: Job) {
  const pct = j.frames ? Math.min(100, Math.round((j.frameRendered / j.frames) * 100)) : null;
  const rendering = j.tail.some((l) => /PROGRESS:.*\(\d+\)/.test(l));
  const spf = secondsPerFrame(j);
  return {
    id: j.id,
    comp: j.comp,
    status: j.status,
    // aerender starts its own copy of After Effects first, which often takes a minute or two
    phase: j.status !== "running" ? undefined : rendering ? "rendering" : "starting the render engine (can take a minute or two)",
    elapsedSeconds: Math.round(((j.endedAt ? Date.parse(j.endedAt) : Date.now()) - Date.parse(j.startedAt)) / 1000),
    progress: j.status === "done" ? 100 : pct,
    framesRendered: j.frameRendered,
    totalFrames: j.frames || null,
    output: j.output,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
    log: j.log,
    lastLines: j.tail.slice(-6),
    ...(j.group ? { group: j.group, chunk: j.chunk } : {}),
    ...(spf !== null ? { secondsPerFrame: Math.round(spf * 1000) / 1000 } : {}),
  };
}


export function registerRenderJobs(server: McpServer) {
  server.registerTool(
    "ae_render_background",
    {
      title: "Render in background",
      description:
        "Render a composition (or a render queue item) with aerender in a separate process, so After Effects stays usable. " +
        "It renders the project as saved on disk: pass save:true to save the open project first (required when it has unsaved changes). " +
        "Returns a job id; check progress with ae_render_jobs and cancel there.",
      inputSchema: {
        comp: z.union([z.number().int(), z.string()]).optional().describe("Composition to render (id or name; default: the active comp)."),
        rqIndex: z.number().int().min(1).optional().describe("Render this render queue item with its own settings instead of a comp."),
        output: z.string().optional().describe("Absolute output path (with comp). Extension should match the output module."),
        renderSettingsTemplate: z.string().optional().describe('e.g. "Best Settings".'),
        outputModuleTemplate: z.string().optional().describe('e.g. "High Quality", "H.264 - Match Render Settings - 15 Mbps".'),
        startFrame: z.number().int().optional(),
        endFrame: z.number().int().optional(),
        save: z.boolean().optional().describe("Save the open project first (needed if it has unsaved changes)."),
      },
      // writes the output file; save:true saves the project
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        if (permissions().mode === "read-only" && args.save) return errorResult(READ_ONLY_REFUSAL);
        if (!args.rqIndex && !args.output) return errorResult("Pass output (an absolute file path) when rendering a comp.");
        const r = await runJsx(
          `
var p = app.project;
if (!p.file) aemcp.fail("The project has never been saved. Save it first (ae_save_project with a path), then render.");
if (p.dirty) { if (args.save) p.save(); else aemcp.fail("The project has unsaved changes; aerender renders the file on disk. Pass save:true to save first."); }
var name = null, frames = 0;
if (args.rqIndex) {
  if (args.rqIndex > p.renderQueue.numItems) aemcp.fail("No render queue item " + args.rqIndex);
  var it = p.renderQueue.item(args.rqIndex); name = it.comp.name;
  frames = Math.round(it.timeSpanDuration / it.comp.frameDuration);
} else {
  var c = aemcp.findComp(args.comp); name = c.name;
  var dupes = 0; for (var i = 1; i <= p.numItems; i++) if (p.item(i) instanceof CompItem && p.item(i).name === name) dupes++;
  if (dupes > 1) aemcp.fail("Several comps are named '" + name + "'; aerender needs a unique name. Rename one, or use rqIndex.");
  frames = Math.round(c.workAreaDuration / c.frameDuration);
}
if (args.startFrame !== undefined && args.endFrame !== undefined) frames = args.endFrame - args.startFrame + 1;
return { project: p.file.fsName, comp: name, frames: frames, app: Folder.appPackage.fsName };`,
          args,
          { undoGroup: false, timeoutMs: 120_000 },
        );
        if (!r.ok) return formatResult(r);
        const info = r.result as { project: string; comp: string; frames: number; app: string };
        const bin = aerenderPath(info.app);
        if (!bin) return errorResult(`aerender was not found next to ${info.app}.`);
        const cli = ["-project", info.project, "-v", "ERRORS_AND_PROGRESS"];
        if (args.rqIndex) cli.push("-rqindex", String(args.rqIndex));
        else cli.push("-comp", info.comp);
        if (args.output) cli.push("-output", args.output);
        if (args.renderSettingsTemplate) cli.push("-RStemplate", args.renderSettingsTemplate);
        if (args.outputModuleTemplate) cli.push("-OMtemplate", args.outputModuleTemplate);
        if (args.startFrame !== undefined) cli.push("-s", String(args.startFrame));
        if (args.endFrame !== undefined) cli.push("-e", String(args.endFrame));
        if (args.output) mkdirSync(dirname(args.output), { recursive: true });
        const { id, log: logPath } = startAerenderJob({ bin, cli, comp: info.comp, output: args.output || "(render queue item output)", project: info.project, frames: info.frames });
        return {
          content: [
            {
              type: "text",
              text: `Background render started: job ${id} (${info.comp}, ${info.frames || "?"} frames) from ${info.project}.\n` +
                `Check progress with ae_render_jobs. Log: ${logPath}`,
            },
          ],
        };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "ae_render_jobs",
    {
      title: "Background render jobs",
      description: "Status and progress of background renders started with ae_render_background (this session), or cancel one.",
      inputSchema: {
        id: z.string().optional().describe("Only this job."),
        cancel: z.string().optional().describe("Cancel this job id."),
      },
      // cancel stops a render
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, cancel }) => {
      if (cancel) {
        const j = jobs.get(cancel);
        if (!j) return errorResult(`No job ${cancel}`);
        cancelJob(j);
        return { content: [{ type: "text", text: JSON.stringify(view(j)) }] };
      }
      const list = [...jobs.values()].filter((j) => !id || j.id === id).map(view);
      if (id && !list.length) return errorResult(`No job ${id}`);
      return { content: [{ type: "text", text: list.length ? JSON.stringify(id ? list[0] : list) : "No background renders in this session." }] };
    },
  );
}
