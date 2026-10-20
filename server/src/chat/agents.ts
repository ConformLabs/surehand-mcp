// The AI agents the panel's Chat screen can talk to: command-line agents the user already has installed and
// signed in to (Codex, Claude Code, Antigravity). Surehand never stores or handles their credentials: the
// agent runs on the user's own sign-in, and is given Surehand's MCP server for the session.
//
// For each agent: where its command is, whether it is signed in (the agent's own status command), the
// command line for one chat turn, and a parser that turns its JSON event stream into the panel's events.
// docs/chat-in-ae.md has the protocols and their sources.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFile } from "../fsutil.js";
import { SERVER_NAME } from "../paths.js";

export type AgentId = "codex" | "claude" | "agy";
export const AGENT_IDS: AgentId[] = ["codex", "claude", "agy"];
export const AGENT_LABELS: Record<AgentId, string> = { codex: "Codex", claude: "Claude Code", agy: "Antigravity" };

/** What the panel shows in its agent picker. */
export interface AgentInfo {
  id: AgentId;
  label: string;
  found: boolean;
  path?: string;
  /** true / false as the agent's own status command says; null when it can't tell (or has none) */
  signedIn: boolean | null;
  /** "ChatGPT", "claude.ai"...: how it is signed in, when it says */
  account?: string;
  /** the agent's own words about its sign-in, when it isn't signed in (or the check failed) */
  authText?: string;
  /** Antigravity only: whether Surehand is in its MCP servers (it has no per-session MCP option) */
  connected?: boolean;
}

/** One event of a chat turn, as the runner prints it (one JSON object per line) for the panel. */
export type ChatEvent =
  | { type: "session"; id: string }
  /** an assistant message: `text` is the whole text of message `id` so far, `delta` is more of the current one */
  | { type: "text"; id?: string; text?: string; delta?: string }
  | { type: "tool"; phase: "start" | "end"; id: string; name: string; args?: unknown; ok?: boolean; error?: string; builtin?: boolean }
  | { type: "notice"; text: string }
  /** `title`: what happened in a few words, when it isn't a plain error ("Antigravity refused Surehand's tools") */
  | { type: "error"; message: string; auth?: boolean; title?: string }
  | { type: "done"; ok: boolean; session?: string; stopped?: boolean };

const isWin = process.platform === "win32";
const HOME = () => homedir();
const LOCALAPPDATA = () => process.env.LOCALAPPDATA || join(HOME(), "AppData", "Local");
const APPDATA = () => process.env.APPDATA || join(HOME(), "AppData", "Roaming");

/** The agent's words when it isn't signed in (any of the three), as opposed to other failures. */
export const AUTH_RE =
  /not logged in|please run \/login|run [`'"]?(?:codex|claude|agy) login|log ?in again|login (?:expired|required)|session expired|oauth (?:session|token)|invalid api key|authentication (?:failed|required|error)|not signed in|sign[- ]in required|unauthori[sz]ed|\b401\b|refresh token/i;

/** Executables on PATH named `name` (with the Windows extensions). The panel's PATH can be short (apps started from the Dock). */
function onPath(name: string, extraDirs: string[] = []): string | null {
  const dirs = [...(process.env.PATH || "").split(isWin ? ";" : ":"), ...extraDirs].filter(Boolean);
  const exts = isWin ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const d of dirs)
    for (const x of exts) {
      const p = join(d, name + x);
      try {
        if (statSync(p).isFile()) return p;
      } catch {}
    }
  return null;
}

/** Folders where command-line tools usually are, also when PATH doesn't name them. */
export function commonBinDirs(): string[] {
  if (isWin) return [join(HOME(), ".local", "bin"), join(APPDATA(), "npm"), join(LOCALAPPDATA(), "Programs")];
  return [join(HOME(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", join(HOME(), ".npm-global", "bin"), join(HOME(), ".bun", "bin"), "/usr/bin"];
}

/**
 * Codex: the ChatGPT / Codex desktop app ships its own codex.exe in %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\
 * (not on PATH; the newest folder is the current one), the CLI may be on PATH or installed with npm.
 */
function findCodex(): string | null {
  const found = onPath("codex", commonBinDirs());
  if (found) return found;
  const cands: string[] = [];
  if (isWin) {
    for (const base of [join(LOCALAPPDATA(), "OpenAI", "Codex", "bin"), join(LOCALAPPDATA(), "Programs", "OpenAI", "Codex", "bin")]) {
      try {
        const dirs = readdirSync(base)
          .map((n) => join(base, n, "codex.exe"))
          .filter((p) => existsSync(p))
          .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
        cands.push(...dirs, join(base, "codex.exe"));
      } catch {}
    }
  } else {
    cands.push("/Applications/Codex.app/Contents/Resources/codex", "/Applications/ChatGPT.app/Contents/Resources/codex", join(HOME(), "Applications", "Codex.app", "Contents", "Resources", "codex"));
  }
  return cands.find((c) => existsSync(c)) || null;
}

function findClaude(): string | null {
  const found = onPath("claude", commonBinDirs());
  if (found) return found;
  const cands = isWin ? [join(HOME(), ".local", "bin", "claude.exe"), join(APPDATA(), "npm", "claude.cmd")] : [join(HOME(), ".claude", "local", "claude")];
  return cands.find((c) => existsSync(c)) || null;
}

function findAgy(): string | null {
  return onPath("agy", commonBinDirs()) || [join(LOCALAPPDATA(), "Programs", "agy", "agy.exe")].find((c) => isWin && existsSync(c)) || null;
}

/** SUREHAND_AE_CHAT_<AGENT>: another executable for an agent (tests, or an unusual install). */
export function findAgent(id: AgentId): string | null {
  const override = process.env[`SUREHAND_AE_CHAT_${id.toUpperCase()}`];
  if (override !== undefined) return override && existsSync(override) ? override : null;
  return id === "codex" ? findCodex() : id === "claude" ? findClaude() : findAgy();
}

// ---------- sign-in ----------
/** What the agent's status command said: { code, out } (stdout and stderr together). */
export type QuickRun = (exe: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; out: string }>;

/**
 * Is it signed in? Codex: `codex login status` (exit 0 "Logged in using ChatGPT", exit 1 "Not logged in").
 * Claude Code: `claude auth status` (JSON, exit 0 when logged in, 1 when not). Antigravity has no status
 * command: null (a turn says so if it isn't). A check that fails otherwise is null with its words, never "signed out".
 */
export async function checkSignIn(id: AgentId, exe: string, run: QuickRun): Promise<Pick<AgentInfo, "signedIn" | "account" | "authText">> {
  const args = id === "codex" ? ["login", "status"] : id === "claude" ? ["auth", "status"] : ["models"];
  const r = await run(exe, args, 20000).catch((e) => ({ code: null, out: String(e?.message || e) }));
  const text = r.out.trim();
  if (id === "agy") {
    // Antigravity has no login command (it signs in on its first interactive start): listing the account's models
    // needs the sign-in and costs nothing (seen live: exit 0 and one model per line)
    if (r.code === 0 && /\S+\t\S/.test(text)) return { signedIn: true };
    if (AUTH_RE.test(text)) return { signedIn: false, authText: firstLine(text.replace(/^Fetching available models\.*\s*/i, "")) };
    return { signedIn: null, authText: firstLine(text.replace(/^Fetching available models\.*\s*/i, "")) || undefined };
  }
  if (id === "codex") {
    const m = /Logged in using (.+)/i.exec(text);
    if (r.code === 0) return { signedIn: true, account: m ? m[1].trim().replace(/\.$/, "") : undefined };
    if (/not logged in/i.test(text)) return { signedIn: false, authText: firstLine(text) };
    return { signedIn: null, authText: firstLine(text) || undefined };
  }
  let j: any = null;
  try {
    j = JSON.parse(text.slice(text.indexOf("{")));
  } catch {}
  if (j && typeof j.loggedIn === "boolean") {
    if (j.loggedIn) return { signedIn: true, account: j.authMethod === "claude.ai" ? "Claude" : j.authMethod === "api_key" ? "an API key" : undefined };
    return { signedIn: false, authText: "Not logged in" };
  }
  if (r.code === 1 && AUTH_RE.test(text)) return { signedIn: false, authText: firstLine(text) };
  // an older Claude Code without `auth status`, or another failure: a turn will tell
  return { signedIn: null, authText: r.code === 0 ? undefined : firstLine(text) || undefined };
}
const firstLine = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 200) || "";

// ---------- Antigravity: Surehand in its MCP servers ----------
/** Antigravity's user-level MCP servers (`agy mcp add` writes it). */
export const agyMcpConfig = () => join(HOME(), ".gemini", "config", "mcp_config.json");
/** Surehand is in Antigravity's MCP servers. */
export function agyRegistered(): boolean {
  try {
    return new RegExp(`"${SERVER_NAME}"\\s*:`).test(readFileSync(agyMcpConfig(), "utf8"));
  } catch {
    return false;
  }
}

/**
 * Antigravity's CLI settings: its permission rules (`permissions.allow`, rules like "mcp(server/*)", per
 * antigravity.google/docs/permissions). Headless runs deny any tool that would need a prompt.
 */
export const agySettings = () => join(HOME(), ".gemini", "antigravity-cli", "settings.json");
/** The one rule Surehand adds: its own MCP tools only. Surehand's own mode (Full / Ask / Read-only) still decides on edits. */
export const AGY_RULE = `mcp(${SERVER_NAME}/*)`;
export function agyAllowed(): boolean {
  const r = readJsonFile<any>(agySettings(), { jsonc: true });
  return r.ok && Array.isArray(r.data?.permissions?.allow) && r.data.permissions.allow.includes(AGY_RULE);
}
/** Connected for chat: Surehand is in its MCP servers and its tools may run headless. */
export const agyConnected = () => agyRegistered() && agyAllowed();

// ---------- one turn's command line ----------
export interface TurnSpec {
  id: AgentId;
  text: string;
  /** the agent's session (thread, conversation) to continue; none for a new chat */
  session?: string;
  /** the MCP server to give the agent: Surehand itself */
  server: { command: string; args: string[] };
  /** the short preface for a new chat (docs/chat-in-ae.md) */
  preface: string;
  /** Claude Code reads its MCP settings from this file (written by the runner) */
  claudeMcpFile?: string;
  /** Codex: the user's config.toml, read only to switch its other MCP servers off for this session */
  codexConfigText?: string;
  /** the MCP server's environment (only what it needs; e.g. SUREHAND_AE_CONFIG in a test setup) */
  serverEnv?: Record<string, string>;
}

const toml = (s: string) => JSON.stringify(s); // a JSON string is a valid TOML basic string

/** Names of the MCP servers in a Codex config.toml ([mcp_servers.<name>] tables), other than Surehand's. */
export function codexOtherServers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))(?:\.[^\]]*)?\]\s*$/gm)) {
    const name = m[1] || m[2];
    if (name && name !== SERVER_NAME && /^[A-Za-z0-9_-]+$/.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The arguments for one turn and what goes to the agent's stdin. */
export function turnCommand(t: TurnSpec): { args: string[]; stdin: string | null } {
  if (t.id === "codex") {
    const s = `mcp_servers.${SERVER_NAME}`;
    const c = [
      // no shell, files or web: the agent works only through Surehand, whose own permission mode applies
      'sandbox_mode="read-only"', 'approval_policy="never"', "features.shell_tool=false", 'web_search="disabled"',
      "features.view_image=false", "features.multi_agent=false", "features.apps=false",
      `${s}.command=${toml(t.server.command)}`, `${s}.args=[${t.server.args.map(toml).join(", ")}]`,
      `${s}.enabled=true`, `${s}.required=true`, `${s}.startup_timeout_sec=30`,
      // an approval in Surehand's Ask mode can wait 10 minutes
      `${s}.tool_timeout_sec=900`,
      // Codex doesn't ask about Surehand's tools itself: Surehand's own mode (Full / Ask / Read-only) decides
      `${s}.default_tools_approval_mode="approve"`,
    ];
    if (t.serverEnv && Object.keys(t.serverEnv).length)
      c.push(`${s}.env={${Object.entries(t.serverEnv).map(([k, v]) => `${k}=${toml(v)}`).join(", ")}}`);
    // the user's other MCP servers stay out of this chat (their config.toml is not changed)
    for (const n of codexOtherServers(t.codexConfigText || "")) c.push(`mcp_servers.${n}.enabled=false`);
    if (!t.session) c.push(`developer_instructions=${toml(t.preface)}`);
    const args = ["exec", "--json", "--skip-git-repo-check", ...c.flatMap((x) => ["-c", x])];
    if (t.session) args.push("resume", t.session);
    args.push("-"); // the prompt from stdin
    return { args, stdin: t.text };
  }
  if (t.id === "claude") {
    const args = [
      "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--mcp-config", t.claudeMcpFile || "", "--strict-mcp-config",
      // no built-in tools (shell, files, web); only Surehand's, without Claude Code asking
      "--tools", "", "--allowedTools", `mcp__${SERVER_NAME}`, "--permission-mode", "dontAsk",
    ];
    if (t.session) args.push("--resume", t.session);
    else args.push("--append-system-prompt", t.preface);
    return { args, stdin: t.text };
  }
  // Antigravity: Surehand is in its MCP servers (connected once from the panel); no per-session MCP option
  const args = ["-p", t.session ? t.text : `${t.preface}\n\n${t.text}`, "--output-format", "stream-json", "--sandbox"];
  if (t.session) args.push("--conversation", t.session);
  return { args, stdin: null };
}

// ---------- event streams ----------
export interface Parser {
  line(o: any): ChatEvent[];
  /** the agent exited: anything left to say (an error it printed without an event) */
  end(code: number | null, stderr: string): ChatEvent[];
}

const SERVER_PREFIX = new RegExp(`^mcp__${SERVER_NAME.replace(/-/g, "[-_]")}__`);
const errorEvent = (message: string): ChatEvent => ({ type: "error", message: message.slice(0, 600), ...(AUTH_RE.test(message) ? { auth: true } : {}) });
/** The text of an MCP result's content (["text" blocks]), first lines only. */
function contentText(c: any): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : b && b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
  return "";
}
const short = (s: string) => {
  const l = s.trim().split(/\r?\n/)[0] || "";
  return l.length > 300 ? l.slice(0, 297) + "…" : l;
};
/** What a process printed on exit, for an error: its last meaningful lines. */
const tail = (s: string) => s.trim().split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(" ").slice(0, 600);

/** `codex exec --json`: thread.started, item.started / item.completed (agent_message, mcp_tool_call...), turn.failed, error. */
export function codexParser(): Parser {
  let failed = false, completed = false, lastError = "";
  const started = new Set<string>();
  const tool = (it: any, phase: "start" | "end"): ChatEvent[] => {
    const id = String(it.id);
    const out: ChatEvent[] = [];
    let name: string, args: unknown, builtin = false;
    if (it.type === "mcp_tool_call") {
      name = String(it.tool || "tool");
      args = it.arguments;
      builtin = it.server !== SERVER_NAME;
    } else {
      // shell, file edits, web search: switched off for the chat; listed if one happens anyway
      builtin = true;
      name = it.type === "command_execution" ? "shell" : it.type === "file_change" ? "file change" : it.type === "web_search" ? "web search" : String(it.type);
      args = it.type === "command_execution" ? { command: it.command } : it.type === "web_search" ? { query: it.query } : undefined;
    }
    if (phase === "start" || !started.has(id)) out.push({ type: "tool", phase: "start", id, name, args, ...(builtin ? { builtin } : {}) });
    started.add(id);
    if (phase === "end") {
      const ok = it.status === "completed" && !it.error;
      const err = it.error?.message || (!ok && it.result ? contentText(it.result.content) : "") || (!ok ? String(it.status || "failed") : "");
      out.push({ type: "tool", phase: "end", id, name, ok, ...(ok ? {} : { error: short(err) }), ...(builtin ? { builtin } : {}) });
    }
    return out;
  };
  return {
    line(o) {
      const it = o.item;
      switch (o.type) {
        case "thread.started":
          return o.thread_id ? [{ type: "session", id: String(o.thread_id) }] : [];
        case "item.started":
          return it && it.type !== "agent_message" && it.type !== "reasoning" && it.type !== "error" && it.type !== "todo_list" ? tool(it, "start") : [];
        case "item.completed":
          if (!it) return [];
          if (it.type === "agent_message") return it.text ? [{ type: "text", id: String(it.id), text: String(it.text) }] : [];
          if (it.type === "error") return [{ type: "notice", text: short(String(it.message || "")) }];
          if (it.type === "reasoning" || it.type === "todo_list") return [];
          return tool(it, "end");
        case "turn.completed":
          completed = true;
          return [];
        case "turn.failed":
          failed = true;
          return [errorEvent(String(o.error?.message || lastError || "The turn failed."))];
        case "error":
          lastError = String(o.message || "");
          return [];
      }
      return [];
    },
    end(code, stderr) {
      if (failed || completed) return [];
      if (lastError) return [errorEvent(lastError)];
      if (code !== 0) return [errorEvent(tail(stderr) || `Codex stopped (exit code ${code}).`)];
      return [];
    },
  };
}

/** `claude -p --output-format stream-json --verbose --include-partial-messages`: system/init, stream_event, assistant, user, result. */
export function claudeParser(): Parser {
  let streamed = false, result = false, authMessage = "";
  const names = new Map<string, string>();
  const nameOf = (n: string) => n.replace(SERVER_PREFIX, "");
  return {
    line(o) {
      const out: ChatEvent[] = [];
      if (o.type === "system" && o.subtype === "init") {
        if (o.session_id) out.push({ type: "session", id: String(o.session_id) });
        const ours = (o.mcp_servers || []).find((s: any) => s && s.name === SERVER_NAME);
        if (ours && ours.status && !/connected|pending/i.test(ours.status)) out.push({ type: "notice", text: `Surehand's tools didn't start in Claude Code (${ours.status}).` });
        return out;
      }
      if (o.type === "stream_event") {
        const ev = o.event || {};
        if (ev.type === "message_start") streamed = false;
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          streamed = true;
          out.push({ type: "text", delta: String(ev.delta.text) });
        }
        return out;
      }
      if (o.type === "assistant") {
        const blocks = o.message?.content || [];
        // a failed request (not signed in, billing...): its text is the error, said once by the result
        if (o.error) {
          authMessage = contentText(blocks.filter((b: any) => b.type === "text")) || String(o.error);
          return out;
        }
        for (const b of blocks) {
          if (b.type === "text" && b.text && !streamed) out.push({ type: "text", text: String(b.text) });
          if (b.type === "tool_use") {
            names.set(String(b.id), nameOf(String(b.name)));
            out.push({ type: "tool", phase: "start", id: String(b.id), name: nameOf(String(b.name)), args: b.input, ...(SERVER_PREFIX.test(String(b.name)) ? {} : { builtin: true }) });
          }
        }
        streamed = false;
        return out;
      }
      if (o.type === "user") {
        for (const b of o.message?.content || []) {
          if (b && b.type === "tool_result") {
            const id = String(b.tool_use_id), name = names.get(id) || "tool";
            out.push({ type: "tool", phase: "end", id, name, ok: !b.is_error, ...(b.is_error ? { error: short(contentText(b.content)) } : {}) });
          }
        }
        return out;
      }
      if (o.type === "result") {
        result = true;
        if (o.session_id) out.push({ type: "session", id: String(o.session_id) });
        if (o.is_error || (o.subtype && o.subtype !== "success")) {
          const msg = (typeof o.result === "string" && o.result) || (Array.isArray(o.errors) && o.errors.join(" ")) || authMessage || String(o.subtype || "The turn failed.");
          out.push(errorEvent(msg));
        }
        return out;
      }
      return out;
    },
    end(code, stderr) {
      if (result) return [];
      if (authMessage) return [errorEvent(authMessage)];
      if (code !== 0) return [errorEvent(tail(stderr) || `Claude Code stopped (exit code ${code}).`)];
      return [];
    },
  };
}

/**
 * `agy -p ... --output-format stream-json`: typed `init`, `step_update` (with a `step_type`) and a terminal
 * `result`. Its fields aren't documented yet, so this reads them loosely (docs/chat-in-ae.md); the runner
 * keeps the last raw stream in chat/last-agy.log to check against.
 */
export function agyParser(): Parser {
  let result = false, sawText = false, denied: string[] = [];
  const texts = new Map<string, string>();
  const tools = new Map<string, string>();
  const pick = (o: any, keys: string[]) => {
    for (const k of keys) if (o && typeof o[k] === "string" && o[k]) return o[k] as string;
    return "";
  };
  /** The Surehand tool a step is about, wherever the step names it ("mcp(surehand-ae/ae_get_project_info)", a tool_name...). */
  const toolOf = (step: any): string => {
    // agy 1.4: tool_info {name: "call_mcp_tool", parameters: {ServerName, ToolName}}; its own tools by tool_info.name
    const info = step.tool_info;
    if (info && typeof info === "object") {
      const p = info.parameters || {};
      if (typeof p.ToolName === "string" && p.ToolName) return p.ToolName;
      if (typeof info.name === "string" && info.name) return info.name;
    }
    const named = pick(step, ["tool_name", "toolName", "mcp_tool", "tool", "name"]) || (step.tool_call && pick(step.tool_call, ["name", "tool_name"])) || "";
    const m = new RegExp(`${SERVER_NAME}[/_.:]+(ae_[a-z0-9_]+)`).exec(named) || /\b(ae_[a-z0-9_]+)\b/.exec(named) ||
      new RegExp(`${SERVER_NAME}[/_.:]+(ae_[a-z0-9_]+)`).exec(JSON.stringify(step));
    return m ? m[1] : named.replace(SERVER_PREFIX, "");
  };
  return {
    line(o) {
      const out: ChatEvent[] = [];
      // agy 1.4 names the line's kind in "event" and nests its body under that name ({event: "result", result: {...}})
      const t = String(o.type || o.event || "");
      const body = o[t] && typeof o[t] === "object" && !Array.isArray(o[t]) ? o[t] : null;
      if (body && t !== "step_update") o = { ...body, ...o, [t]: undefined };
      const sid = pick(o, ["conversation_id", "conversationId", "session_id", "sessionId"]);
      if (t === "init") {
        if (sid) out.push({ type: "session", id: sid });
        return out;
      }
      if (t === "step_update") {
        const step = o.step || o.step_update || o;
        const kind = String(step.step_type || o.step_type || "");
        const id = String(step.step_id ?? step.stepIndex ?? step.step_index ?? step.id ?? o.step_index ?? kind);
        const status = String(step.status || step.state || o.status || o.state || "");
        const done = /done|complete|finish|success|fail|error|cancel|denied/i.test(status);
        // the answer streams as text_delta pieces of one agent_response step
        if (typeof step.text_delta === "string") {
          if (step.text_delta) {
            sawText = true;
            out.push({ type: "text", delta: step.text_delta });
          }
          return out;
        }
        const name = /tool|mcp/i.test(kind) || step.tool_info ? toolOf(step) : "";
        if (name) {
          const shown = name.replace(SERVER_PREFIX, "");
          const info = step.tool_info || {};
          const ours = info.name === "call_mcp_tool" ? info.parameters?.ServerName === SERVER_NAME : /^ae_/.test(shown);
          // agy reads the tool descriptions it keeps in its own folder before calling them: bookkeeping, not a step to show
          if (!ours && /[\\/]antigravity-cli[\\/]mcp[\\/]/.test(String(info.parameters?.Path || ""))) return out;
          if (!tools.has(id)) {
            tools.set(id, shown);
            out.push({ type: "tool", phase: "start", id, name: shown, args: info.parameters?.Arguments ?? (step.arguments || step.args || step.input || step.tool_call?.arguments), ...(ours ? {} : { builtin: true }) });
          }
          if (done) {
            const failed = /fail|error|cancel|denied/i.test(status);
            let why = pick(step, ["error", "error_message", "message", "reason"]) || (step.error && pick(step.error, ["message"])) || (failed && typeof info.output === "string" && info.output) || status;
            // Antigravity's own permission settings refused it (not Surehand's)
            if (/denied permission|auto-denied|permission/i.test(why)) why = `Antigravity's own permission settings refused it (${why}).`;
            out.push({ type: "tool", phase: "end", id, name: shown, ok: !failed, ...(failed ? { error: short(why) } : {}), ...(ours ? {} : { builtin: true }) });
          }
          return out;
        }
        const text = pick(step, ["text", "content", "response", "message", "output"]);
        if (text && /response|message|text|answer|planner|model/i.test(kind || "response")) {
          if (texts.get(id) !== text) {
            texts.set(id, text);
            sawText = true;
            out.push({ type: "text", id: `agy-${id}`, text });
          }
        }
        return out;
      }
      if (t === "result") {
        result = true;
        if (sid) out.push({ type: "session", id: sid });
        if (Array.isArray(o.denied_actions)) denied = o.denied_actions.map((d: any) => String(d?.target || d?.action || "")).filter(Boolean);
        const isError = o.is_error === true || o.subtype === "error" || (typeof o.status === "string" && /fail|error/i.test(o.status)) || !!o.error;
        const text = pick(o, ["result", "response", "text"]);
        if (isError) out.push(errorEvent(pick(o, ["error", "message"]) || (o.error && pick(o.error, ["message"])) || text || "The turn failed."));
        else if (text && !sawText) {
          sawText = true;
          out.push({ type: "text", id: "agy-result", text });
        }
        return out;
      }
      return out;
    },
    end(code, stderr) {
      // a tool it wasn't allowed: say so with its own reason (its stderr names the rule it wanted)
      const why = stderr.split(/\r?\n/).find((l) => /auto-denied|cannot prompt|denied permission/i.test(l));
      if (denied.length || why)
        return [{ type: "error", title: "Antigravity refused Surehand's tools", message: (why || `It denied: ${denied.join(", ")}`).trim().slice(0, 600) }];
      if (result) return [];
      if (code !== 0) return [errorEvent(tail(stderr) || `Antigravity stopped (exit code ${code}).`)];
      return [];
    },
  };
}

export const parserFor = (id: AgentId): Parser => (id === "codex" ? codexParser() : id === "claude" ? claudeParser() : agyParser());
