// Background renders with aerender (After Effects' command-line renderer): After Effects stays
// usable while a separate render process works, with progress, status and cancel.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
  exitCode?: number | null;
  /** a chunked render (ae_farm run_local): the run it belongs to and its chunk */
  group?: string;
  chunk?: number;
  /** each frame's render time in seconds, as aerender prints it ("PROGRESS: ... (n): 3 Seconds") */
  frameSeconds: number[];
  onExit?: (j: Job) => void;
}

const jobs = new Map<string, Job>();
export type RenderJob = Job;
export const renderJob = (id: string) => jobs.get(id);
export const renderJobs = () => [...jobs.values()];
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
 * {id, comp, frames, done, status, output, startedAt, endedAt?} (done = frames rendered so far).
 */
export function writeJobFile(j: Pick<Job, "id" | "comp" | "frames" | "frameRendered" | "status" | "output" | "startedAt" | "endedAt">) {
  try {
    mkdirSync(LOG_DIR(), { recursive: true });
    const o = { id: j.id, comp: j.comp, frames: j.frames, done: j.status === "done" ? j.frames || j.frameRendered : j.frameRendered, status: j.status, output: j.output, startedAt: j.startedAt, ...(j.endedAt ? { endedAt: j.endedAt } : {}) };
    writeFileSync(join(LOG_DIR(), `${j.id}.json`), JSON.stringify(o));
  } catch {} // never fails a render
}

/** One line of aerender's output: the frame count (the number in brackets) and that frame's time. */
export function parseProgress(line: string): { frame: number; seconds: number | null } | null {
  const m = line.match(/PROGRESS:.*\((\d+)\)(?::\s*([\d.]+)\s*Seconds?)?/i);
  return m ? { frame: Number(m[1]), seconds: m[2] !== undefined ? Number(m[2]) : null } : null;
}

export interface StartJob { bin: string; cli: string[]; comp: string; output: string; project: string; frames: number; group?: string; chunk?: number; onExit?: (j: Job) => void }

/** Starts aerender as a background job: its log, the panel's renders/<id>.json, progress and cancel (ae_render_jobs). */
export function startAerenderJob(o: StartJob): Job {
  mkdirSync(LOG_DIR(), { recursive: true });
  // keep the folder from growing forever: the newest renders only (never one still running)
  pruneRenders(LOG_DIR(), RENDERS_KEPT - 1, new Set([...jobs.values()].filter((j) => j.status === "running").map((j) => j.id)));
  let id = `r${Date.now().toString(36)}`;
  for (let k = 1; jobs.has(id); k++) id = `r${Date.now().toString(36)}${k.toString(36)}`;
  const logPath = join(LOG_DIR(), `${id}.log`);
  const logStream = createWriteStream(logPath);
  const job: Job = {
    id, comp: o.comp, output: o.output, project: o.project, status: "running",
    startedAt: new Date().toISOString(), frames: o.frames, frameRendered: 0, log: logPath, tail: [], frameSeconds: [],
    ...(o.group ? { group: o.group, chunk: o.chunk } : {}), onExit: o.onExit,
  };
  const proc = spawn(o.bin, o.cli, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  job.proc = proc;
  writeJobFile(job);
  let written = 0;
  const onData = (d: Buffer) => {
    const text = d.toString();
    logStream.write(text);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      // e.g. "PROGRESS:  0;00;00;05 (6): 0 Seconds"
      const pr = parseProgress(line);
      if (pr) {
        if (pr.frame > job.frameRendered && pr.seconds !== null && job.frameSeconds.length < 100_000) job.frameSeconds.push(pr.seconds);
        job.frameRendered = Math.max(job.frameRendered, pr.frame);
      }
      job.tail.push(line.trim());
      if (job.tail.length > 50) job.tail.shift();
    }
    // progress for the panel, at most twice a second
    if (Date.now() - written > 500) {
      written = Date.now();
      writeJobFile(job);
    }
  };
  proc.stdout!.on("data", onData);
  proc.stderr!.on("data", onData);
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
    job.status = "failed";
    job.tail.push(String(e));
    job.endedAt = new Date().toISOString();
    logStream.end();
    end();
  });
  proc.on("exit", (code) => {
    logStream.end();
    job.exitCode = code;
    job.endedAt = new Date().toISOString();
    if (job.status === "running") job.status = code === 0 && !job.tail.some((l) => /aerender ERROR|^ERROR/i.test(l)) ? "done" : "failed";
    end();
  });
  jobs.set(id, job);
  return job;
}

/** Stops a running job (its status becomes "cancelled"). */
export function cancelJob(j: Job) {
  if (j.status === "running" && j.proc) {
    j.status = "cancelled";
    j.proc.kill();
    writeJobFile(j);
  }
}

const medianOf = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function view(j: Job) {
  const pct = j.frames ? Math.min(100, Math.round((j.frameRendered / j.frames) * 100)) : null;
  const rendering = j.tail.some((l) => /PROGRESS:.*\(\d+\)/.test(l));
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
    ...(j.frameSeconds.length ? { secondsPerFrame: medianOf(j.frameSeconds) } : {}),
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
