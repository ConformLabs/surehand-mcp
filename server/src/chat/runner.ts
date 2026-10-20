// Runs one chat turn with an AI agent for the panel's Chat screen: starts the agent's command line with
// Surehand's MCP server for this session only, sends the message, and turns the agent's event stream into the
// panel's events (agents.ts). Stop ends the agent (its whole process tree). The next turn continues the
// agent's own session (resume). Nothing is written into the agents' settings, except Antigravity's MCP list
// when the user connects it (it has no per-session option): see connectAgy.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { backupFile, updateJsonFile } from "../fsutil.js";
import { appFile, SERVER_NAME } from "../paths.js";
import { cmdExeLine, codexConfig } from "../cli/util.js";
import {
  AGENT_IDS, AGENT_LABELS, AGY_RULE, agyAllowed, agyConnected, agyMcpConfig, agyRegistered, agySettings, checkSignIn, commonBinDirs, findAgent, parserFor, turnCommand,
  type AgentId, type AgentInfo, type ChatEvent, type QuickRun,
} from "./agents.js";

const isWin = process.platform === "win32";
/** The chat's own folder: the agents' working folder (so their sessions can be resumed) and the last turn's raw stream. */
export const chatDir = () => appFile("chat");

/** The panel's secret never reaches an agent or the server it starts: the agent's calls are the AI's, not the panel's. */
const SECRET_VARS = ["SUREHAND_AE_PANEL_SECRET", "AEMCP_PANEL_SECRET"];
/** The agent's environment: ours without the panel secret, PATH with the usual tool folders (a Dock-started app has a short PATH). */
export function agentEnv(id: AgentId, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of SECRET_VARS) delete env[k];
  // started from inside another agent session (development): the agent would refuse or join it
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const sep = isWin ? ";" : ":";
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  const have = (env[key] || "").split(sep).filter(Boolean);
  env[key] = [...have, dirname(process.execPath), ...commonBinDirs()].filter((d, i, a) => a.indexOf(d) === i).join(sep);
  if (id === "claude") {
    // an approval in Surehand's Ask mode can take up to 10 minutes
    env.MCP_TOOL_TIMEOUT = env.MCP_TOOL_TIMEOUT || "900000";
    env.MCP_TIMEOUT = env.MCP_TIMEOUT || "30000";
  }
  return env;
}

/** Starts an agent: a .js file (tests) with this Node, a .cmd shim on Windows through cmd.exe with exact arguments. */
export function spawnAgent(exe: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }): ChildProcess {
  const o = { cwd: opts.cwd, env: opts.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
  if (/\.(c|m)?js$/i.test(exe)) return spawn(process.execPath, [exe, ...args], o);
  if (isWin && /\.(cmd|bat)$/i.test(exe)) return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", cmdExeLine(exe, args)], { ...o, windowsVerbatimArguments: true });
  return spawn(exe, args, o);
}

/** Ends the agent and whatever it started (its MCP servers): taskkill /T on Windows, SIGINT then SIGKILL elsewhere. */
export function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (isWin) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      child.kill();
    }
    return;
  }
  // SIGINT ends a turn the way Ctrl+C does (the session is kept, so the chat can continue)
  child.kill("SIGINT");
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 3000);
  t.unref?.();
}

/** Runs a short command (a status check): { code, out } with stdout and stderr together. */
export const quickRun: QuickRun = (exe, args, timeoutMs) =>
  new Promise((resolve) => {
    let out = "";
    let child: ChildProcess;
    try {
      child = spawnAgent(exe, args, { env: agentEnv("codex") });
    } catch (e: any) {
      return resolve({ code: null, out: String(e?.message || e) });
    }
    const timer = setTimeout(() => stopProcess(child), timeoutMs);
    child.stdin?.end();
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, out: String(e.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });

/** The agents on this computer, each with its sign-in (checked in parallel). */
export async function detectAgents(run: QuickRun = quickRun): Promise<AgentInfo[]> {
  return Promise.all(
    AGENT_IDS.map(async (id): Promise<AgentInfo> => {
      const exe = findAgent(id);
      if (!exe) return { id, label: AGENT_LABELS[id], found: false, signedIn: null };
      const s = await checkSignIn(id, exe, run);
      return { id, label: AGENT_LABELS[id], found: true, path: exe, ...s, ...(id === "agy" ? { connected: agyConnected() } : {}) };
    }),
  );
}

/**
 * The short preface of a new chat. The server's own instructions and skills teach the tools; this only says
 * where the user is, and that Surehand's permission setting decides.
 */
export function preface(project?: string): string {
  return [
    "You are chatting with the user inside Adobe After Effects, in the Surehand panel.",
    "Work only through the surehand-ae MCP tools: they act on the After Effects project that is open now. You have no shell or file tools here.",
    "Start by looking (ae_get_project_info, ae_get_comp_info) to find the open project and the active comp.",
    "Every edit goes through the user's Surehand setting (Full, Ask or Read-only). If a call is refused or denied, say so and don't try another way.",
    "Answer briefly, in plain words.",
    project ? `The open project is ${project}.` : "",
  ].filter(Boolean).join("\n");
}

export interface TurnOptions {
  agent: AgentId;
  text: string;
  session?: string;
  project?: string;
  /** the agent's executable (default: found on this computer) */
  exe?: string;
  /** the MCP server for the agent (default: this very server, with this Node) */
  server?: { command: string; args: string[] };
  /** the folder for the agent's working directory, its settings file and the raw stream (default chatDir()) */
  dir?: string;
}

/** One turn: events go to `emit` as they come; ends with a "done" event. stop() ends the agent. */
export function runTurn(o: TurnOptions, emit: (e: ChatEvent) => void): { stop: () => void; done: Promise<void> } {
  const dir = o.dir || chatDir();
  const exe = o.exe || findAgent(o.agent);
  let child: ChildProcess | null = null, stopped = false, session = o.session, sessionSaid = "";
  const send = (e: ChatEvent) => {
    if (e.type === "session") {
      // agents repeat it (start and result): said once
      if (e.id === sessionSaid) return;
      session = sessionSaid = e.id;
    }
    emit(e);
  };
  const done = new Promise<void>((resolve) => {
    if (!exe) {
      send({ type: "error", message: `${AGENT_LABELS[o.agent]} isn't installed on this computer.` });
      send({ type: "done", ok: false });
      return resolve();
    }
    const work = join(dir, "work");
    let trace = "";
    try {
      mkdirSync(work, { recursive: true });
    } catch {}
    const server = o.server || { command: process.execPath, args: [process.argv[1]] };
    const serverEnv: Record<string, string> = {};
    for (const k of ["SUREHAND_AE_CONFIG", "AEMCP_CONFIG"]) if (process.env[k]) serverEnv[k] = process.env[k]!;
    let claudeMcpFile: string | undefined;
    if (o.agent === "claude") {
      claudeMcpFile = join(dir, "claude-mcp.json");
      writeFileSync(claudeMcpFile, JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: "stdio", command: server.command, args: server.args, env: serverEnv } } }, null, 2));
    }
    let codexConfigText = "";
    if (o.agent === "codex") {
      try {
        codexConfigText = readFileSync(codexConfig(), "utf8");
      } catch {}
    }
    const cmd = turnCommand({ id: o.agent, text: o.text, session: o.session, server, preface: preface(o.project), claudeMcpFile, codexConfigText, serverEnv });
    const parser = parserFor(o.agent);
    let stderr = "";
    try {
      child = spawnAgent(exe, cmd.args, { cwd: work, env: agentEnv(o.agent) });
    } catch (e: any) {
      send({ type: "error", message: `Could not start ${AGENT_LABELS[o.agent]}: ${e.message}` });
      send({ type: "done", ok: false });
      return resolve();
    }
    const c = child;
    let failed = false, answered = false;
    const out = (e: ChatEvent) => {
      if (e.type === "text") answered = true;
      // after Stop, the agent's "interrupted" isn't an error
      if (e.type === "error" && stopped) return;
      if (e.type === "error") failed = true;
      send(e);
    };
    c.on("error", (e) => {
      stderr += e.message;
    });
    c.stdin?.on("error", () => {});
    if (cmd.stdin !== null) c.stdin?.end(cmd.stdin);
    else c.stdin?.end();
    c.stderr?.on("data", (d) => {
      stderr += d;
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });
    const rl = createInterface({ input: c.stdout! });
    rl.on("line", (line) => {
      if (trace.length < 2 * 1024 * 1024) trace += line + "\n";
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        stderr += line + "\n"; // a line that isn't an event (a warning, an error printed as text)
        return;
      }
      if (obj && typeof obj === "object") for (const e of parser.line(obj)) out(e);
    });
    c.on("close", (code) => {
      rl.close();
      if (!stopped) for (const e of parser.end(code, stderr)) out(e);
      // it ended without a word and without an error: never nothing on screen
      if (!stopped && !failed && !answered)
        out({ type: "error", title: `${AGENT_LABELS[o.agent]} ended without an answer`, message: stderr.trim().split(/\r?\n/).filter((l) => l.trim()).slice(-2).join(" ").slice(0, 600) || "It gave no reply." });
      try {
        writeFileSync(join(dir, `last-${o.agent}.log`), trace + (stderr ? `\n--- stderr ---\n${stderr}` : ""));
      } catch {}
      send({ type: "done", ok: stopped || !failed, ...(session ? { session } : {}), ...(stopped ? { stopped: true } : {}) });
      resolve();
    });
  });
  return {
    stop() {
      stopped = true;
      if (child) stopProcess(child);
    },
    done,
  };
}

// ---------- Antigravity's MCP servers ----------
/**
 * Adds Surehand to Antigravity's MCP servers with its own command (`agy mcp add`), after a backup of its
 * mcp_config.json: Antigravity has no per-session MCP option. Only on the user's click in the panel; removed
 * again with disconnectAgy (also by the uninstaller).
 */
export async function connectAgy(entry: { command: string; args: string[] }, run: QuickRun = quickRun): Promise<{ ok: boolean; message: string }> {
  const exe = findAgent("agy");
  if (!exe) return { ok: false, message: "Antigravity isn't installed on this computer." };
  try {
    backupFile(agyMcpConfig());
  } catch {}
  const r = await run(exe, ["mcp", "add", SERVER_NAME, entry.command, ...entry.args], 30000);
  if (r.code !== 0 || !agyRegistered()) return { ok: false, message: `Antigravity did not add Surehand: ${r.out.trim().split(/\r?\n/).pop() || `exit code ${r.code}`}` };
  try {
    setAgyRule(true);
  } catch (e: any) {
    return { ok: false, message: `Surehand is in Antigravity's MCP servers, but its tools couldn't be allowed in ${agySettings()}: ${e.message}` };
  }
  return { ok: true, message: "Surehand is connected to Antigravity." };
}
/**
 * Adds (or removes) the allow rule for Surehand's tools in Antigravity's settings.json (backed up first; any other
 * setting is left as it is). Its headless runs refuse a tool that would need a prompt.
 */
export function setAgyRule(on: boolean): boolean {
  return updateJsonFile<any>(agySettings(), (d) => {
    if (!d || typeof d !== "object" || Array.isArray(d)) return false;
    const p = d.permissions && typeof d.permissions === "object" ? d.permissions : (d.permissions = {});
    const allow: unknown[] = Array.isArray(p.allow) ? p.allow : [];
    const has = allow.includes(AGY_RULE);
    if (on === has) return false;
    p.allow = on ? [...allow, AGY_RULE] : allow.filter((x) => x !== AGY_RULE);
    return true;
  }, { jsonc: true, missing: () => (on ? {} : (null as any)) });
}
function removeAgyRule(): string | null {
  try {
    setAgyRule(false);
    return null;
  } catch (e: any) {
    return `remove "${AGY_RULE}" from ${agySettings()} yourself (${e.message})`;
  }
}
export async function disconnectAgy(run: QuickRun = quickRun): Promise<{ ok: boolean; message: string }> {
  const ruleProblem = agyAllowed() ? removeAgyRule() : null;
  if (ruleProblem) return { ok: false, message: `Antigravity: ${ruleProblem}.` };
  if (!agyRegistered()) return { ok: true, message: "Surehand wasn't connected to Antigravity." };
  const exe = findAgent("agy");
  if (!exe) return { ok: false, message: `Antigravity isn't installed: remove "${SERVER_NAME}" from ${agyMcpConfig()} yourself.` };
  try {
    backupFile(agyMcpConfig());
  } catch {}
  const r = await run(exe, ["mcp", "remove", SERVER_NAME], 30000);
  return r.code === 0 && !agyRegistered() ? { ok: true, message: "Removed Surehand from Antigravity." } : { ok: false, message: `Antigravity did not remove Surehand: ${r.out.trim() || `exit code ${r.code}`}` };
}
/** The same for the uninstaller (which runs synchronously). */
export function disconnectAgySync(): { ok: boolean; message: string } {
  const ruleProblem = agyAllowed() ? removeAgyRule() : null;
  if (ruleProblem) return { ok: false, message: `Antigravity: ${ruleProblem}.` };
  if (!agyRegistered()) return { ok: true, message: "Surehand wasn't connected to Antigravity." };
  const exe = findAgent("agy");
  if (!exe) return { ok: false, message: `Antigravity isn't installed: remove "${SERVER_NAME}" from ${agyMcpConfig()} yourself.` };
  try {
    backupFile(agyMcpConfig());
  } catch {}
  const js = /\.(c|m)?js$/i.test(exe);
  const r = spawnSync(js ? process.execPath : exe, [...(js ? [exe] : []), "mcp", "remove", SERVER_NAME], { encoding: "utf8", timeout: 30000, windowsHide: true, env: agentEnv("agy") });
  return r.status === 0 && !agyRegistered() ? { ok: true, message: "Removed Surehand from Antigravity." } : { ok: false, message: `Antigravity did not remove Surehand: ${(r.stderr || r.stdout || "").trim() || `exit code ${r.status}`}` };
}
