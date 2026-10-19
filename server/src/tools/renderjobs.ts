// Background renders with aerender (After Effects' command-line renderer): After Effects stays
// usable while a separate render process works, with progress, status and cancel.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
}

const jobs = new Map<string, Job>();
const LOG_DIR = () => appFile("renders");

/** aerender lives next to the After Effects app (macOS) or AfterFX.exe (Windows). */
function aerenderPath(appPackage: string): string | null {
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

        mkdirSync(LOG_DIR(), { recursive: true });
        const id = `r${Date.now().toString(36)}`;
        const logPath = join(LOG_DIR(), `${id}.log`);
        const logStream = createWriteStream(logPath);
        const job: Job = {
          id, comp: info.comp, output: args.output || "(render queue item output)", project: info.project, status: "running",
          startedAt: new Date().toISOString(), frames: info.frames, frameRendered: 0, log: logPath, tail: [],
        };
        const proc = spawn(bin, cli, { stdio: ["ignore", "pipe", "pipe"] });
        job.proc = proc;
        writeJobFile(job);
        let written = 0;
        const onData = (d: Buffer) => {
          const text = d.toString();
          logStream.write(text);
          for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            // e.g. "PROGRESS:  0;00;00;05 (6): 0 Seconds"
            const m = line.match(/PROGRESS:.*\((\d+)\)/);
            if (m) job.frameRendered = Math.max(job.frameRendered, Number(m[1]));
            job.tail.push(line.trim());
            if (job.tail.length > 50) job.tail.shift();
          }
          // progress for the panel, at most twice a second
          if (Date.now() - written > 500) {
            written = Date.now();
            writeJobFile(job);
          }
        };
        proc.stdout.on("data", onData);
        proc.stderr.on("data", onData);
        proc.on("error", (e) => {
          job.status = "failed";
          job.tail.push(String(e));
          job.endedAt = new Date().toISOString();
          writeJobFile(job);
        });
        proc.on("exit", (code) => {
          logStream.end();
          job.exitCode = code;
          job.endedAt = new Date().toISOString();
          if (job.status === "running") job.status = code === 0 && !job.tail.some((l) => /aerender ERROR|^ERROR/i.test(l)) ? "done" : "failed";
          job.proc = undefined;
          writeJobFile(job);
        });
        jobs.set(id, job);
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
        if (j.status === "running" && j.proc) {
          j.status = "cancelled";
          j.proc.kill();
          writeJobFile(j);
        }
        return { content: [{ type: "text", text: JSON.stringify(view(j)) }] };
      }
      const list = [...jobs.values()].filter((j) => !id || j.id === id).map(view);
      if (id && !list.length) return errorResult(`No job ${id}`);
      return { content: [{ type: "text", text: list.length ? JSON.stringify(id ? list[0] : list) : "No background renders in this session." }] };
    },
  );
}
