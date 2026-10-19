// The AI apps Surehand MCP connects to: Claude Desktop, Claude Code, ChatGPT desktop / Codex and Cursor.
// Used by `install` / `uninstall`, by the commands behind the panel's Connect screen (`clients`, `connect`,
// `disconnect`), and after moving a 1.3 installation (settings that still name ~/.aemcp are pointed at
// the new place).
//
// The server is registered as "surehand-ae". Version 1.3 used "after-effects": such an entry is only
// changed or removed when it runs our own server (its path mentions .aemcp, ae-mcp.mjs or surehand), so
// another "after-effects" server the user set up is left alone.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJsonFile, UnreadableFileError, updateJsonFile } from "../fsutil.js";
import { lateMerge, mapLegacyPath, migrateLegacy, type LateMergeResult, type MigrationResult } from "../migrate.js";
import { installedServer, LEGACY_SERVER_NAME, migrationPending, SERVER_NAME } from "../paths.js";
import {
  chatgptDesktopInstalled, claudeCodeConfig, claudeDesktopConfig, claudeDesktopDir, codexBlock, codexConfig, cursorConfig, findClaudeCli,
  hasCodexBlock, isMac, isWin, removeCodexBlock, run, stableNodePath, writeTextWithBackup,
} from "./util.js";
import { spawnSync } from "node:child_process";

export type ClientId = "claude-desktop" | "claude-code" | "codex" | "cursor";
export const CLIENT_IDS: ClientId[] = ["claude-desktop", "claude-code", "codex", "cursor"];
const NAMES: Record<ClientId | "chatgpt-web", string> = {
  "claude-desktop": "Claude Desktop",
  "claude-code": "Claude Code",
  codex: "ChatGPT desktop / Codex",
  cursor: "Cursor",
  "chatgpt-web": "ChatGPT (web)",
};

export interface ClientInfo {
  id: ClientId | "chatgpt-web";
  name: string;
  installed: boolean;
  configured: boolean;
  configPath: string | null;
  note: string | null;
  howTo?: string;
}

export interface ClientAction {
  ok: boolean;
  message: string;
  restartHint: string | null;
}

/** True if an MCP server entry runs Surehand MCP (any version, installed or from a source checkout). */
export function isOurEntry(e: any): boolean {
  if (!e || typeof e !== "object") return false;
  const s = [e.command, ...(Array.isArray(e.args) ? e.args : [])]
    .filter((x) => typeof x === "string")
    .join(" ")
    .replace(/\\/g, "/")
    .toLowerCase();
  return /(^|\/)\.aemcp(\/|$| )/.test(s) || s.includes("ae-mcp.mjs") || s.includes("surehand-ae.mjs") || /(^|\/)\.surehand\//.test(s);
}

/** The entry AI apps get: the stable Node.js and the installed server. */
export function serverEntry(): { command: string; args: string[] } {
  return { command: stableNodePath(), args: [installedServer()] };
}

/** The Claude Desktop extension (.mcpb) version of Surehand MCP (1.3: "after-effects", 1.4: "surehand-ae"). */
export function mcpbInstalled(): boolean {
  try {
    return readdirSync(join(claudeDesktopDir(), "Claude Extensions")).some((n) => /after-effects|surehand-ae/i.test(n) && !n.endsWith(".json"));
  } catch {
    return false;
  }
}

export function claudeDesktopRunning(): boolean {
  if (isMac)
    return (spawnSync("ps", ["-axo", "comm="], { encoding: "utf8" }).stdout || "").split("\n").some((l) => l.trim().endsWith(".app/Contents/MacOS/Claude"));
  if (isWin) return (spawnSync("tasklist", ["/FI", "IMAGENAME eq claude.exe", "/NH"], { encoding: "utf8" }).stdout || "").toLowerCase().includes("claude.exe");
  return false;
}

// ---------- JSON settings files (Claude Desktop, Claude Code, Cursor) ----------
//
// These files belong to the AI apps. They are only changed when they can be read: one that is there
// but can't be parsed (half-written, a typo...) is left alone and the problem reported, never
// replaced with just our entry. Every change makes a timestamped backup first (the newest five are
// kept) and is written atomically. Cursor (VS Code-style) accepts comments and trailing commas.

const jsonFile = (id: ClientId) => (id === "claude-desktop" ? claudeDesktopConfig() : id === "claude-code" ? claudeCodeConfig() : cursorConfig());
/** Settings files that may contain comments / trailing commas (JSONC). */
const jsoncFile = (file: string) => file === cursorConfig();

function readSettings(file: string) {
  return readJsonFile<any>(file, { jsonc: jsoncFile(file) });
}

/** Our entry in a JSON settings file: the new name, else a 1.3 entry that runs our server. */
function jsonEntry(file: string): { key: string; entry: any } | null {
  const r = readSettings(file);
  const servers = r.ok ? r.data?.mcpServers : null;
  if (!servers || typeof servers !== "object") return null;
  if (servers[SERVER_NAME]) return { key: SERVER_NAME, entry: servers[SERVER_NAME] };
  if (isOurEntry(servers[LEGACY_SERVER_NAME])) return { key: LEGACY_SERVER_NAME, entry: servers[LEGACY_SERVER_NAME] };
  return null;
}

/** Edits a settings file's mcpServers (refuses an unreadable file; backup + atomic write). */
function updateServers(file: string, change: (servers: Record<string, any>) => boolean, create: boolean): boolean {
  return updateJsonFile<any>(
    file,
    (data) => {
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new UnreadableFileError(file, "it doesn't hold a JSON object");
      if (data.mcpServers !== undefined && (typeof data.mcpServers !== "object" || data.mcpServers === null || Array.isArray(data.mcpServers)))
        throw new UnreadableFileError(file, '"mcpServers" in it isn\'t an object');
      const servers = data.mcpServers ?? {};
      if (!change(servers)) return false;
      data.mcpServers = servers;
      return true;
    },
    { jsonc: jsoncFile(file), missing: create ? () => ({}) : undefined },
  );
}

/** Set our entry (and drop a 1.3 "after-effects" entry that runs our server). */
export function setJsonEntry(file: string, value: object) {
  updateServers(
    file,
    (servers) => {
      const legacy = isOurEntry(servers[LEGACY_SERVER_NAME]);
      if (!legacy && JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(value)) return false;
      if (legacy) delete servers[LEGACY_SERVER_NAME];
      servers[SERVER_NAME] = value;
      return true;
    },
    true,
  );
}

/** Remove our entries; returns true if anything changed. */
export function removeJsonEntries(file: string): boolean {
  return updateServers(
    file,
    (servers) => {
      let changed = false;
      if (servers[SERVER_NAME]) {
        delete servers[SERVER_NAME];
        changed = true;
      }
      if (isOurEntry(servers[LEGACY_SERVER_NAME])) {
        delete servers[LEGACY_SERVER_NAME];
        changed = true;
      }
      return changed;
    },
    false,
  );
}

// ---------- status ----------

function installed(id: ClientId): boolean {
  switch (id) {
    case "claude-desktop":
      return existsSync(claudeDesktopDir());
    case "claude-code":
      return !!findClaudeCli() || existsSync(claudeCodeConfig());
    case "codex":
      return existsSync(dirname(codexConfig())) || chatgptDesktopInstalled();
    case "cursor":
      return existsSync(dirname(cursorConfig()));
  }
}

export function clientInfo(id: ClientId): ClientInfo {
  const base = { id, name: NAMES[id], installed: installed(id) };
  if (id === "codex") {
    const file = codexConfig();
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {}
    const configured = hasCodexBlock(text);
    return { ...base, configured, configPath: file, note: configured && /# >>> ae-mcp >>>/.test(text) ? "connected under the old name; Connect updates it" : null };
  }
  const file = jsonFile(id);
  const read = readSettings(file);
  if (!read.ok && !read.missing)
    return { ...base, configured: false, configPath: file, note: `its settings file can't be read (${read.error}); Surehand leaves it alone until it is fixed` };
  const e = jsonEntry(file);
  if (id === "claude-desktop" && !e && mcpbInstalled())
    return { ...base, configured: true, configPath: file, note: "connected through the Claude Desktop extension (.mcpb)" };
  let note: string | null = null;
  if (e?.key === LEGACY_SERVER_NAME) note = "connected under the old name (after-effects); Connect updates it";
  else if (e && typeof e.entry.command === "string" && !existsSync(e.entry.command)) note = `its Node.js no longer exists (${e.entry.command}); Connect fixes it`;
  else if (e && typeof e.entry.args?.[0] === "string" && !existsSync(e.entry.args[0])) note = `the server it runs no longer exists (${e.entry.args[0]}); Connect fixes it`;
  return { ...base, configured: !!e, configPath: file, note };
}

export const CHATGPT_WEB_HOWTO =
  "ChatGPT on the web can't start programs on this computer, so it connects over the internet: run the server's `chatgpt` command " +
  '(Mac/Windows folder: "3. Connect ChatGPT"), which starts a local server with a secure tunnel and prints a connector URL; ' +
  "in ChatGPT: Settings > Apps & Connectors > Advanced settings > Developer mode > Create, paste that URL. Keep that window open while you use it.";

export function listClients(): ClientInfo[] {
  return [
    ...CLIENT_IDS.map(clientInfo),
    { id: "chatgpt-web", name: NAMES["chatgpt-web"], installed: true, configured: false, configPath: null, note: null, howTo: CHATGPT_WEB_HOWTO },
  ];
}

/** The settings to paste into any other MCP app (the panel's "Copy the settings"). */
export function settingsSnippet(entry = serverEntry()): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2);
}

/**
 * `clients --json` for the panel's Connect screen:
 * {clients: [{id, name, installed, configured, inUse?, note?, action?: "start"}], snippet?}
 * (inUse: the app is running now, so a change needs a restart; chatgpt-web has action "start").
 */
export function clientsJson(): { clients: Record<string, unknown>[]; snippet?: string } {
  const clients = listClients().map((c) => {
    const o: Record<string, unknown> = { id: c.id, name: c.name, installed: c.installed, configured: c.configured };
    if (c.id === "claude-desktop" && c.installed && claudeDesktopRunning()) o.inUse = true;
    if (c.id === "chatgpt-web") {
      o.action = "start";
      o.note = c.howTo;
    } else if (c.note) o.note = c.note;
    return o;
  });
  return existsSync(installedServer()) ? { clients, snippet: settingsSnippet() } : { clients };
}

// ---------- connect / disconnect ----------

const RESTART: Record<ClientId, string> = {
  "claude-desktop": "Quit Claude Desktop completely (Cmd+Q on a Mac, tray icon > Quit on Windows) and open it again.",
  "claude-code": "Start a new Claude Code session.",
  codex: "Restart the ChatGPT desktop app (or Codex); it appears under Settings > Plugins > Servers.",
  cursor: "Restart Cursor.",
};

/** Our block in Codex's config.toml (the ChatGPT desktop app reads the same file). Backup + atomic write. */
export function writeCodex(entry: { command: string; args: string[] }) {
  const file = codexConfig();
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    const rest = removeCodexBlock(text).trim();
    const next = (rest ? rest + "\n\n" : "") + codexBlock(entry.command, entry.args[0]);
    if (next === text) return;
    // written by the app meanwhile? then again, on its newer content
    if ((existsSync(file) ? readFileSync(file, "utf8") : "") !== text) continue;
    writeTextWithBackup(file, next);
    return;
  }
  throw new Error(`${file} kept changing while it was being updated; try again`);
}

/** Claude Code through its own command line when it is there (it owns ~/.claude.json), else the file. */
function connectClaudeCode(entry: { command: string; args: string[] }) {
  const claude = findClaudeCli();
  if (!claude) return setJsonEntry(claudeCodeConfig(), { type: "stdio", ...entry, env: {} });
  try {
    run(claude, ["mcp", "remove", SERVER_NAME, "--scope", "user"]);
  } catch {}
  const cc = readSettings(claudeCodeConfig());
  if (cc.ok && isOurEntry(cc.data?.mcpServers?.[LEGACY_SERVER_NAME])) {
    try {
      run(claude, ["mcp", "remove", LEGACY_SERVER_NAME, "--scope", "user"]);
    } catch {}
  }
  run(claude, ["mcp", "add", "--scope", "user", SERVER_NAME, "--", entry.command, ...entry.args]);
}

export function connectClient(id: string, entry = serverEntry()): ClientAction {
  if (id === "chatgpt-web") return { ok: false, message: CHATGPT_WEB_HOWTO, restartHint: null };
  if (!CLIENT_IDS.includes(id as ClientId)) return { ok: false, message: `Unknown app "${id}". Known: ${[...CLIENT_IDS, "chatgpt-web"].join(", ")}.`, restartHint: null };
  const cid = id as ClientId;
  if (!existsSync(entry.args[0])) return { ok: false, message: `The server isn't installed at ${entry.args[0]}. Run the installer first.`, restartHint: null };
  try {
    if (cid === "codex") writeCodex(entry);
    else if (cid === "claude-code") connectClaudeCode(entry);
    else setJsonEntry(jsonFile(cid), entry);
  } catch (e: any) {
    return { ok: false, message: `${NAMES[cid]}: could not update its settings: ${String(e.stderr || e.message).split("\n")[0]}`, restartHint: null };
  }
  let restartHint = RESTART[cid];
  if (cid === "claude-desktop" && claudeDesktopRunning())
    restartHint = "Claude Desktop is open, and it can overwrite its settings when it quits: quit it completely, check it is still connected here (connect again if not), then open it.";
  return { ok: true, message: `${NAMES[cid]} is connected to Surehand MCP.`, restartHint };
}

export function disconnectClient(id: string): ClientAction {
  if (id === "chatgpt-web") return { ok: true, message: "ChatGPT on the web is connected only while the Connect ChatGPT window is open: close it, and remove the connector in ChatGPT's settings.", restartHint: null };
  if (!CLIENT_IDS.includes(id as ClientId)) return { ok: false, message: `Unknown app "${id}". Known: ${[...CLIENT_IDS, "chatgpt-web"].join(", ")}.`, restartHint: null };
  const cid = id as ClientId;
  let changed = false;
  try {
    if (cid === "codex") {
      const file = codexConfig();
      if (existsSync(file)) {
        const t = readFileSync(file, "utf8");
        const n = removeCodexBlock(t);
        if (n !== t) {
          writeTextWithBackup(file, n.trimEnd() + "\n");
          changed = true;
        }
      }
    } else {
      if (cid === "claude-code") {
        const claude = findClaudeCli();
        const cc = readSettings(claudeCodeConfig());
        const servers = (cc.ok && cc.data?.mcpServers) || {};
        if (claude) {
          for (const name of [SERVER_NAME, LEGACY_SERVER_NAME]) {
            if (!servers[name] || (name === LEGACY_SERVER_NAME && !isOurEntry(servers[name]))) continue;
            try {
              run(claude, ["mcp", "remove", name, "--scope", "user"]);
              changed = true;
            } catch {}
          }
        }
      }
      if (removeJsonEntries(jsonFile(cid))) changed = true;
    }
  } catch (e: any) {
    return { ok: false, message: `${NAMES[cid]}: could not update its settings: ${String(e.stderr || e.message).split("\n")[0]}`, restartHint: null };
  }
  const mcpb = cid === "claude-desktop" && mcpbInstalled() ? " The Claude Desktop extension (.mcpb) is still installed: remove it in Claude Desktop > Settings > Extensions." : "";
  return {
    ok: true,
    message: (changed ? `${NAMES[cid]} is no longer connected to Surehand MCP.` : `${NAMES[cid]} wasn't connected.`) + mcpb,
    restartHint: changed ? RESTART[cid] : null,
  };
}

// ---------- after moving from 1.3 ----------

/**
 * Settings that still run the server or Node.js from ~/.aemcp are pointed at the new place (and a 1.3
 * "after-effects" entry becomes "surehand-ae"). No prompts; nothing else changes. Only run right after
 * the move and by install / update / connect, never on every start. Claude Code is changed through its
 * own `claude mcp` command when it is there (it owns ~/.claude.json); files are re-read right before
 * they are written, backed up and replaced atomically; an unreadable file is skipped (see `problems`).
 * Returns the apps that were updated.
 */
export function repointLegacyClients(problems: string[] = []): string[] {
  const done: string[] = [];
  const mapEntry = (e: any) => ({ ...e, command: typeof e.command === "string" ? mapLegacyPath(e.command) : e.command, args: Array.isArray(e.args) ? e.args.map((a: unknown) => (typeof a === "string" ? mapLegacyPath(a) : a)) : e.args });
  // an entry of ours that isn't in ~/.aemcp (e.g. a source checkout) is left as it is
  const needs = (e: any) => isOurEntry(e) && JSON.stringify(mapEntry(e)) !== JSON.stringify(e);
  for (const id of ["claude-desktop", "claude-code", "cursor"] as const) {
    const file = jsonFile(id);
    const r = readSettings(file);
    if (!r.ok) {
      if (!r.missing) problems.push(`${NAMES[id]}: ${file} can't be read (${r.error}); left unchanged`);
      continue;
    }
    const servers = r.data?.mcpServers;
    if (!servers || typeof servers !== "object") continue;
    const todo = [LEGACY_SERVER_NAME, SERVER_NAME].filter((n) => needs(servers[n]));
    if (!todo.length) continue;
    try {
      if (id === "claude-code" && findClaudeCli()) {
        const claude = findClaudeCli()!;
        const target = mapEntry(isOurEntry(servers[SERVER_NAME]) ? servers[SERVER_NAME] : servers[LEGACY_SERVER_NAME]);
        for (const n of todo) {
          try {
            run(claude, ["mcp", "remove", n, "--scope", "user"]);
          } catch {}
        }
        run(claude, ["mcp", "add", "--scope", "user", SERVER_NAME, "--", target.command, ...(target.args ?? [])]);
        done.push(NAMES[id]);
        continue;
      }
      const changed = updateServers(
        file,
        (sv) => {
          let c = false;
          for (const name of [LEGACY_SERVER_NAME, SERVER_NAME]) {
            const e = sv[name];
            if (!needs(e)) continue;
            const mapped = mapEntry(e);
            if (name === LEGACY_SERVER_NAME) {
              delete sv[name];
              if (!sv[SERVER_NAME]) sv[SERVER_NAME] = mapped;
            } else sv[name] = mapped;
            c = true;
          }
          return c;
        },
        false,
      );
      if (changed) done.push(NAMES[id]);
    } catch (e: any) {
      problems.push(`${NAMES[id]}: ${String(e.stderr || e.message).split("\n")[0]}`);
    }
  }
  try {
    const file = codexConfig();
    const text = readFileSync(file, "utf8");
    if (hasCodexBlock(text)) {
      const block = /# >>> (?:ae-mcp|surehand-ae) >>>[\s\S]*?# <<< (?:ae-mcp|surehand-ae) <<</.exec(text)![0];
      const command = /^command = (".*")$/m.exec(block)?.[1];
      const arg = /^args = \[(".*")\]$/m.exec(block)?.[1];
      if (command && arg) {
        const c = JSON.parse(command) as string, a = JSON.parse(arg) as string;
        if (mapLegacyPath(c) !== c || mapLegacyPath(a) !== a || block.includes("# >>> ae-mcp >>>")) {
          writeCodex({ command: mapLegacyPath(c), args: [mapLegacyPath(a)] });
          done.push(NAMES.codex);
        }
      }
    }
  } catch (e: any) {
    if (e.code !== "ENOENT") problems.push(`${NAMES.codex}: ${e.message}`);
  }
  return done;
}

export interface MoveReport extends MigrationResult {
  /** after the move: what an older server or panel still wrote into ~/.aemcp, merged now */
  late?: LateMergeResult;
}

/**
 * Moves a 1.3 installation if there is one (pointing AI app settings at the new place as part of
 * the move), or finishes an interrupted move; after the move, merges what older copies still wrote
 * into ~/.aemcp. For the server's start, install and update only: commands that only read never call it.
 */
export function moveFromLegacy(opts: { force?: boolean } = {}): MoveReport {
  if (!migrationPending()) {
    let late: LateMergeResult | undefined;
    try {
      late = lateMerge();
    } catch {}
    return { status: "not-needed", moved: [], kept: [], renamed: [], notes: [], repointed: [], log: "", late };
  }
  const problems: string[] = [];
  const r = migrateLegacy({ force: opts.force, repoint: () => repointLegacyClients(problems) });
  r.notes.push(...problems.map((p) => `AI app settings: ${p}`));
  return r;
}
