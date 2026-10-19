// Professional workflow: batch edits (one undo step, all or nothing), project checkpoints,
// and the user's own script library.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { evalBody, formatChanges, rollbackProblem, runJsx } from "../jsx.js";
import { approvalSummary, permissions, READ_ONLY_REFUSAL, SHELL_REFUSAL, usesShell } from "../permissions.js";
import { reservedGlobalsHint, transpileUserCode } from "../transpile.js";
import { ALL_JSX_TOOLS } from "./all.js";
import { errorResult, formatResult, reportScope } from "./registry.js";

// ---------- checkpoints ----------

const CHECKPOINTS = join(homedir(), ".aemcp", "checkpoints");
const MAX_CHECKPOINTS = 50;

interface Checkpoint { id: string; at: string; label?: string; file: string; project: string }

function projectDir(projectPath: string) {
  const name = basename(projectPath, extname(projectPath)).replace(/[^\w.-]+/g, "_").slice(0, 60);
  return join(CHECKPOINTS, `${name}-${createHash("sha1").update(projectPath).digest("hex").slice(0, 8)}`);
}

function readIndex(dir: string): Checkpoint[] {
  try {
    return JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
  } catch {
    return [];
  }
}

const stamp = () => new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+$/, "");

/** Run after every saved checkpoint (project history links a snapshot to it); returns a note for the user. */
const checkpointHooks: ((cp: Checkpoint) => Promise<string | undefined>)[] = [];
export function onCheckpointSaved(hook: (cp: Checkpoint) => Promise<string | undefined>) {
  checkpointHooks.push(hook);
}

/** Save the open project and copy it into the checkpoint folder. */
export async function saveCheckpoint(label?: string): Promise<Checkpoint & { note?: string }> {
  const r = await runJsx(
    `var p = app.project;
if (!p.file) aemcp.fail("The project has never been saved, so there is nothing to checkpoint yet. Save it first (ae_save_project with a path).");
p.save();
return p.file.fsName;`,
    {},
    { undoGroup: false, timeoutMs: 300_000 },
  );
  if (!r.ok) throw new Error(r.error?.message || "could not save the project");
  const project = String(r.result);
  const dir = projectDir(project);
  mkdirSync(dir, { recursive: true });
  const id = stamp();
  const file = join(dir, `${id}${label ? "-" + label.replace(/[^\w.-]+/g, "_").slice(0, 40) : ""}.aep`);
  copyFileSync(project, file);
  const index = readIndex(dir);
  index.push({ id, at: new Date().toISOString(), label, file, project });
  while (index.length > MAX_CHECKPOINTS) {
    const old = index.shift()!;
    try {
      unlinkSync(old.file);
    } catch {}
  }
  writeFileSync(join(dir, "index.json"), JSON.stringify(index, null, 2));
  const cp: Checkpoint & { note?: string } = { ...index[index.length - 1] };
  const notes: string[] = [];
  for (const hook of checkpointHooks) {
    try {
      const n = await hook(cp);
      if (n) notes.push(n);
    } catch {} // a hook never fails the checkpoint
  }
  if (notes.length) cp.note = notes.join("\n");
  return cp;
}

/** A restore target next to the project that does not exist yet (an earlier restore is never overwritten). */
function restoreTarget(project: string, id: string) {
  const base = join(dirname(project), `${basename(project, extname(project))} (restored ${id}`);
  for (let n = 1; ; n++) {
    const target = `${base}${n > 1 ? ` ${n}` : ""}).aep`;
    if (!existsSync(target)) return target;
  }
}

export const RESTORE_JSX = `
var f = new File(args.path);
if (app.project.dirty) {
  if (!args.discardChanges) aemcp.fail("The open project has unsaved changes. Save it (or checkpoint it) first, or pass discardChanges: true.");
  // with unsaved changes app.open would silently do nothing (its save prompt is suppressed)
  app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
}
app.open(f);
if (!app.project.file || app.project.file.fsName !== f.fsName) aemcp.fail("After Effects did not open the restored copy " + f.fsName + ".");
return app.project.file.fsName;`;

/**
 * Copy a checkpoint next to the project under a new name and open it. Succeeds only when the
 * copy is verified to be the open project; otherwise the copy is removed again.
 */
export async function restoreCheckpoint(project: string, cp: Checkpoint, discardChanges?: boolean): Promise<string> {
  // check before copying, so a refused restore leaves no file behind
  const dirty = await runJsx("return app.project.dirty;", {}, { undoGroup: false });
  if (dirty.result === true && !discardChanges) throw new Error("The open project has unsaved changes. Save it (or checkpoint it) first, or pass discardChanges: true.");
  const target = restoreTarget(project, cp.id);
  copyFileSync(cp.file, target, constants.COPYFILE_EXCL);
  let problem: string | undefined;
  try {
    const o = await runJsx(RESTORE_JSX, { path: target, discardChanges: !!discardChanges }, { undoGroup: false, timeoutMs: 300_000 });
    if (!o.ok) problem = o.error?.message || "After Effects did not open the restored copy";
  } catch (e: any) {
    problem = e?.message || String(e);
  }
  if (problem === undefined) return target;
  try {
    unlinkSync(target);
  } catch {}
  throw new Error(`${problem} Nothing was restored (the checkpoint is unchanged: ${cp.file}).`);
}

// ---------- user scripts ----------

const SCRIPT_EXT = /\.(jsx|jsxbin|js)$/i;

function scanScripts(root: string, origin: string, depth = 2, out: any[] = []) {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(root, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // AE's own "(support)" / "(instructional)" folders hold helpers, not scripts to run
      if (depth > 0 && !/^\(.*\)$/.test(name)) scanScripts(p, origin === "After Effects" && name === "ScriptUI Panels" ? "ScriptUI Panels" : origin, depth - 1, out);
      continue;
    }
    if (!SCRIPT_EXT.test(name)) continue;
    let description: string | undefined;
    if (/\.jsx?$/i.test(name) && st.size < 2_000_000) {
      // first comment block as a description
      const head = readFileSync(p, "utf8").slice(0, 2000);
      const m = head.match(/\/\*+([\s\S]*?)\*\//) || head.match(/((?:^\s*\/\/.*\n?){1,6})/m);
      if (m) description = m[1].replace(/^\s*(\*|\/\/)\s?/gm, "").replace(/\s+/g, " ").trim().slice(0, 200) || undefined;
    }
    out.push({ name: name.replace(SCRIPT_EXT, ""), path: p, origin, folder: basename(dirname(p)), kind: origin === "ScriptUI Panels" ? "panel (opens a window)" : "script", description, sizeKB: Math.round(st.size / 1024) });
  }
  return out;
}

// ---------- batch ----------

const batchable = new Map(ALL_JSX_TOOLS.filter((t) => !t.noUndo).map((t) => [t.name, t]));

export interface BatchInput { steps: { tool: string; args?: Record<string, unknown> }[]; atomic?: boolean; name?: string; checkpoint?: boolean; verbose?: boolean }

/** ae_batch: every step in one undo group; atomic = a failed step rolls the whole batch back (guarded, see aemcp.jsxinc). */
export async function runBatch({ steps, atomic, name, checkpoint, verbose }: BatchInput, perm: { mode: string; allowShell: boolean }): Promise<CallToolResult> {
  const bodies: string[] = [];
  const stepArgs: unknown[] = [];
  const hints: (string | null)[] = [];
  let edits = false;
  for (const [i, s] of steps.entries()) {
    if (s.tool === "ae_run_script") {
      const code = String(s.args?.code ?? "");
      if (!perm.allowShell && usesShell(code)) return errorResult(`Step ${i + 1}: ${SHELL_REFUSAL}`);
      const t = transpileUserCode(code);
      if (t.syntaxError && !t.transpiled) return errorResult(`Step ${i + 1} (ae_run_script) has a syntax error: ${t.syntaxError}`);
      hints[i] = reservedGlobalsHint(t.reservedGlobals);
      bodies.push(evalBody(t.source));
      stepArgs.push(s.args?.args ?? {});
      edits = true;
      continue;
    }
    const tool = batchable.get(s.tool);
    if (!tool) return errorResult(`Step ${i + 1}: "${s.tool}" can't be used in a batch (unknown, or it can't be part of an undo step such as open/save project or undo).`);
    if (!tool.readOnly && !tool.tempItems) edits = true;
    bodies.push(tool.jsx);
    stepArgs.push(s.args ?? {});
  }
  if (edits && perm.mode === "read-only") return errorResult(READ_ONLY_REFUSAL);
  let cp = "";
  if (checkpoint) cp = `Checkpoint saved first: ${(await saveCheckpoint("before-batch")).file}\n`;

  const isAtomic = atomic !== false;
  const body =
    "var __steps = [\n" +
    bodies.map((b) => `function (args, log) {\n${b}\n}`).join(",\n") +
    `\n], __out = [], __failed = -1;
for (var __i = 0; __i < __steps.length; __i++) {
  try { __out.push({ ok: true, result: aemcp.serialize(__steps[__i](args.stepArgs[__i], log), 2) }); }
  catch (e) { __out.push({ ok: false, error: e.message || String(e), line: e.aemcpUser ? undefined : e.line }); if (__failed < 0) __failed = __i; if (args.atomic) break; }
}
return { steps: __out, failed: __failed, rollback: args.atomic && __failed >= 0 };`;
  const scope = [...new Set(steps.map((s) => s.args?.comp).filter((c) => c !== undefined && c !== null))];
  const showReport = loadConfig().changeReport !== false;
  const r = await runJsx(body, { stepArgs, atomic: isAtomic }, {
    undoGroup: name || "Surehand MCP Batch",
    timeoutMs: 600_000,
    depth: 6,
    // an atomic batch always compares before/after: that is what makes its rollback safe
    report: showReport || isAtomic ? (scope.length ? scope : reportScope({})) : undefined,
    rollback: isAtomic ? "requested" : undefined,
    bridge: edits && perm.mode === "ask" ? { approval: { tool: `Batch (${steps.length} steps)`, summary: steps.map((s, i) => `${i + 1}. ${s.tool} ${approvalSummary(s.tool, s.args).slice(0, 300)}`).join("\n") } } : undefined,
  });
  if (!r.ok) return formatResult(r);
  const res = r.result as { steps: { ok: boolean; result?: unknown; error?: string; line?: number }[]; failed: number };
  const lines = res.steps.map((s, i) => {
    if (!s.ok) return `${i + 1}. ${steps[i].tool}: FAILED: ${s.error}${s.line ? ` (line ${s.line})` : ""}${hints[i] ? `\n   Hint: ${hints[i]}` : ""}`;
    const format = batchable.get(steps[i].tool)?.format;
    const txt = s.result === undefined || s.result === null ? "ok" : format ? format(s.result, steps[i].args ?? {}) : JSON.stringify(s.result);
    return `${i + 1}. ${steps[i].tool}: ${verbose ? txt : txt.length > 160 ? txt.slice(0, 157) + "..." : txt}`;
  });
  const changes = showReport ? formatChanges(r.changes) : null;
  if (res.failed >= 0 && isAtomic) {
    const at = `Batch stopped at step ${res.failed + 1} of ${steps.length}`;
    const rb = r.rollback ?? { undone: false, verified: false, problem: "no result" };
    // a step that opened or closed undo groups itself split the batch into several undo steps
    const ownGroups =
      !rb.verified &&
      (/not this call/.test(rb.problem ?? "") || steps.some((s) => s.tool === "ae_run_script" && /\b(?:begin|end)UndoGroup\b/.test(String(s.args?.code ?? ""))));
    const groupHint = ownGroups
      ? "\nHint: steps in a batch must not open or close undo groups themselves (beginUndoGroup / endUndoGroup): that splits the batch into several undo steps, and it can't be rolled back as one."
      : "";
    const text = !rb.verified
      ? `${at}. ${rollbackProblem(rb, "the batch")}${groupHint}\n${lines.join("\n")}` + (changes && changes !== "Changes: none" ? `\n\nThe batch made these changes:\n${changes}` : "")
      : rb.undone
        ? `${at} and was rolled back (nothing changed).\n${lines.join("\n")}` + (changes && changes !== "Changes: none" ? `\n\nRolled back:\n${changes}` : "")
        : `${at}. It hadn't changed anything yet, so there was nothing to undo.\n${lines.join("\n")}`;
    return { isError: true, content: [{ type: "text", text: cp + text }] };
  }
  const head = res.failed >= 0 ? `Batch finished with errors (atomic: false, successful steps were kept).` : `Batch done: ${steps.length} steps in one undo step.`;
  return { content: [{ type: "text", text: `${cp}${head}\n${lines.join("\n")}${changes ? `\n\n${changes}` : ""}` }] };
}

export function registerWorkflowTools(server: McpServer) {
  server.registerTool(
    "ae_batch",
    {
      title: "Batch edits",
      description:
        "Run many steps in ONE call: each step is a tool with its arguments (any project/comp/layer/property/keyframe/effect/text/footage tool) " +
        "or {tool: \"ae_run_script\", args: {code}}. All steps form a single undo step and return one change report. " +
        "Atomic by default: if any step fails, everything is undone and you get the error of the failing step. " +
        "Use it for repetitive or multi-part edits (e.g. style 30 layers, build a scene) to save round trips.",
      inputSchema: {
        steps: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.any()).optional() })).min(1).max(200),
        atomic: z.boolean().optional().describe("Undo everything if a step fails (default true). false = keep successful steps and continue."),
        name: z.string().optional().describe('Undo step name shown in After Effects (default "Surehand MCP Batch").'),
        checkpoint: z.boolean().optional().describe("Save a project checkpoint before running (see ae_checkpoint)."),
        verbose: z.boolean().optional().describe("Return each step's full result (default: short summaries)."),
      },
      // steps can be ae_run_script
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        return await runBatch(input, permissions());
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // ---------- checkpoints ----------
  server.registerTool(
    "ae_checkpoint",
    {
      title: "Project checkpoints",
      description:
        "Safety copies of the project: save (saves the open project, then keeps a timestamped copy), list the checkpoints of this project, " +
        "or restore one (opens it as a NEW file next to the original; neither the original nor an earlier restore is ever overwritten). Use before large or risky changes.",
      inputSchema: {
        action: z.enum(["save", "list", "restore"]),
        label: z.string().optional().describe("Short label for a new checkpoint."),
        id: z.string().optional().describe("Checkpoint id to restore (from list)."),
        discardChanges: z.boolean().optional().describe("Restore even if the open project has unsaved changes (they are discarded)."),
      },
      // save overwrites the .aep; restore closes the open project
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ action, label, id, discardChanges }) => {
      try {
        if (action === "save") {
          if (permissions().mode === "read-only") return errorResult(READ_ONLY_REFUSAL);
          const c = await saveCheckpoint(label);
          return { content: [{ type: "text", text: `Checkpoint ${c.id}${c.label ? ` (${c.label})` : ""} saved: ${c.file}${c.note ? `\n${c.note}` : ""}` }] };
        }
        const r = await runJsx("return app.project.file ? app.project.file.fsName : null;", {}, { undoGroup: false });
        const project = r.result as string | null;
        if (!project) return errorResult("The open project has never been saved, so it has no checkpoints.");
        const index = readIndex(projectDir(project));
        if (action === "list") {
          if (!index.length) return { content: [{ type: "text", text: `No checkpoints yet for ${project}.` }] };
          return { content: [{ type: "text", text: JSON.stringify({ project, checkpoints: index.map(({ id, at, label, file }) => ({ id, at, label, file })).reverse() }) }] };
        }
        if (permissions().mode === "read-only") return errorResult(READ_ONLY_REFUSAL);
        const cp = id ? index.find((c) => c.id === id) : index[index.length - 1];
        if (!cp || !existsSync(cp.file)) return errorResult(`Checkpoint ${id ?? "(latest)"} not found. Use action "list".`);
        const target = await restoreCheckpoint(project, cp, discardChanges);
        return { content: [{ type: "text", text: `Restored checkpoint ${cp.id}${cp.label ? ` (${cp.label})` : ""} as a new file and opened it: ${target}\nThe original project file was not changed.` }] };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // ---------- user scripts ----------
  server.registerTool(
    "ae_list_scripts",
    {
      title: "List scripts",
      description:
        "List the user's own After Effects scripts: AE's Scripts folder (and ScriptUI Panels) plus folders configured as \"scriptFolders\" " +
        "in ~/.aemcp/config.json, with each script's description from its header comment. Run one with ae_run_script_file.",
      inputSchema: { nameContains: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ nameContains }) => {
      try {
        const r = await runJsx("return Folder.appPackage.parent.fsName;", {}, { undoGroup: false });
        if (!r.ok) return formatResult(r);
        const aeRoot = String(r.result);
        const aeScripts = [join(aeRoot, "Scripts"), join(aeRoot, "Support Files", "Scripts")].find((p) => existsSync(p));
        const folders: [string, string][] = [];
        if (aeScripts) folders.push([aeScripts, "After Effects"]);
        for (const f of loadConfig().scriptFolders ?? []) folders.push([f.replace(/^~(?=\/|\\|$)/, homedir()), "your folder"]);
        let list = folders.flatMap(([dir, origin]) => scanScripts(dir, origin));
        // skip AE's startup/shutdown hooks: they are not meant to be run by hand
        list = list.filter((s) => !/[\\/](Startup|Shutdown)$/.test(dirname(s.path)));
        if (nameContains) list = list.filter((s) => s.name.toLowerCase().includes(nameContains.toLowerCase()));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ folders: folders.map(([d, o]) => ({ folder: d, origin: o, exists: existsSync(d) })), scripts: list }) +
                (folders.length < 2 ? '\n\nTip: add your own folders with "scriptFolders": ["/path/to/scripts"] in ~/.aemcp/config.json.' : ""),
            },
          ],
        };
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}

// exported for tests
export const _internal = { projectDir, restoreTarget, scanScripts };
