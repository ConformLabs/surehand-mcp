// The AI apps Surehand MCP connects to: Claude Desktop, Claude Code, ChatGPT desktop / Codex and Cursor.
// Used by `install` / `uninstall`, by the commands behind the panel's Connect screen (`clients`, `connect`,
// `disconnect`), and after moving a 1.3 installation (settings that still name ~/.aemcp are pointed at
// the new place).
//
// The server is registered as "surehand-ae". Version 1.3 used "after-effects": such an entry is only
// changed or removed when it runs our own server (its path mentions .aemcp, ae-mcp.mjs or surehand), so
// another "after-effects" server the user set up is left alone.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mapLegacyPath, migrateLegacy, type MigrationResult } from "../migrate.js";
import { installedServer, LEGACY_SERVER_NAME, migrationPending, SERVER_NAME } from "../paths.js";
import {
  backupOnce, chatgptDesktopInstalled, claudeCodeConfig, claudeDesktopConfig, claudeDesktopDir, codexBlock, codexConfig, cursorConfig, findClaudeCli,
  hasCodexBlock, isMac, isWin, readJson, removeCodexBlock, run, stableNodePath, writeJsonWithBackup,
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

const jsonFile = (id: ClientId) => (id === "claude-desktop" ? claudeDesktopConfig() : id === "claude-code" ? claudeCodeConfig() : cursorConfig());

/** Our entry in a JSON settings file: the new name, else a 1.3 entry that runs our server. */
function jsonEntry(file: string): { key: string; entry: any } | null {
  const servers = readJson<any>(file, null)?.mcpServers;
  if (!servers) return null;
  if (servers[SERVER_NAME]) return { key: SERVER_NAME, entry: servers[SERVER_NAME] };
  if (isOurEntry(servers[LEGACY_SERVER_NAME])) return { key: LEGACY_SERVER_NAME, entry: servers[LEGACY_SERVER_NAME] };
  return null;
}

/** Set our entry (and drop a 1.3 "after-effects" entry that runs our server). */
export function setJsonEntry(file: string, value: object) {
  const data = readJson<any>(file, {});
  data.mcpServers ||= {};
  if (isOurEntry(data.mcpServers[LEGACY_SERVER_NAME])) delete data.mcpServers[LEGACY_SERVER_NAME];
  data.mcpServers[SERVER_NAME] = value;
  writeJsonWithBackup(file, data);
}

/** Remove our entries; returns true if anything changed. */
export function removeJsonEntries(file: string): boolean {
  const data = readJson<any>(file, null);
  const servers = data?.mcpServers;
  if (!servers) return false;
  let changed = false;
  if (servers[SERVER_NAME]) {
    delete servers[SERVER_NAME];
    changed = true;
  }
  if (isOurEntry(servers[LEGACY_SERVER_NAME])) {
    delete servers[LEGACY_SERVER_NAME];
    changed = true;
  }
  if (changed) writeJsonWithBackup(file, data);
  return changed;
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

// ---------- connect / disconnect ----------

const RESTART: Record<ClientId, string> = {
  "claude-desktop": "Quit Claude Desktop completely (Cmd+Q on a Mac, tray icon > Quit on Windows) and open it again.",
  "claude-code": "Start a new Claude Code session.",
  codex: "Restart the ChatGPT desktop app (or Codex); it appears under Settings > Plugins > Servers.",
  cursor: "Restart Cursor.",
};

/** Our block in Codex's config.toml (the ChatGPT desktop app reads the same file). */
export function writeCodex(entry: { command: string; args: string[] }) {
  const file = codexConfig();
  mkdirSync(dirname(file), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  backupOnce(file);
  const rest = removeCodexBlock(text).trim();
  writeFileSync(file, (rest ? rest + "\n\n" : "") + codexBlock(entry.command, entry.args[0]));
}

/** Claude Code through its own command line when it is there (it owns ~/.claude.json), else the file. */
function connectClaudeCode(entry: { command: string; args: string[] }) {
  const claude = findClaudeCli();
  if (!claude) return setJsonEntry(claudeCodeConfig(), { type: "stdio", ...entry, env: {} });
  try {
    run(claude, ["mcp", "remove", SERVER_NAME, "--scope", "user"]);
  } catch {}
  if (isOurEntry(readJson<any>(claudeCodeConfig(), null)?.mcpServers?.[LEGACY_SERVER_NAME])) {
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
          backupOnce(file);
          writeFileSync(file, n.trimEnd() + "\n");
          changed = true;
        }
      }
    } else {
      if (cid === "claude-code") {
        const claude = findClaudeCli();
        const servers = readJson<any>(claudeCodeConfig(), null)?.mcpServers ?? {};
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
    return { ok: false, message: `${NAMES[cid]}: could not update its settings: ${e.message}`, restartHint: null };
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
 * "after-effects" entry becomes "surehand-ae"). Files only, no prompts, nothing else changes.
 * Returns the apps that were updated.
 */
export function repointLegacyClients(): string[] {
  const done: string[] = [];
  const mapEntry = (e: any) => ({ ...e, command: typeof e.command === "string" ? mapLegacyPath(e.command) : e.command, args: Array.isArray(e.args) ? e.args.map((a: unknown) => (typeof a === "string" ? mapLegacyPath(a) : a)) : e.args });
  for (const id of ["claude-desktop", "claude-code", "cursor"] as const) {
    const file = jsonFile(id);
    const data = readJson<any>(file, null);
    const servers = data?.mcpServers;
    if (!servers) continue;
    let changed = false;
    for (const name of [LEGACY_SERVER_NAME, SERVER_NAME]) {
      const e = servers[name];
      if (!isOurEntry(e)) continue;
      const mapped = mapEntry(e);
      if (JSON.stringify(mapped) === JSON.stringify(e)) continue; // not in ~/.aemcp (e.g. a source checkout): left as is
      if (name === LEGACY_SERVER_NAME) {
        delete servers[name];
        if (!servers[SERVER_NAME]) servers[SERVER_NAME] = mapped;
      } else servers[name] = mapped;
      changed = true;
    }
    if (changed) {
      writeJsonWithBackup(file, data);
      done.push(NAMES[id]);
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
  } catch {}
  return done;
}

export interface MoveReport extends MigrationResult {
  /** AI apps whose settings now point at the new place */
  repointed: string[];
}

/** Moves a 1.3 installation if there is one, then points AI app settings at the new place. */
export function moveFromLegacy(opts: { force?: boolean } = {}): MoveReport {
  if (!migrationPending()) return { status: "not-needed", moved: [], kept: [], notes: [], log: "", repointed: [] };
  const r = migrateLegacy({ force: opts.force });
  let repointed: string[] = [];
  if (r.status === "migrated") {
    try {
      repointed = repointLegacyClients();
    } catch (e: any) {
      r.notes.push(`AI app settings: ${e.message}`);
    }
  }
  return { ...r, repointed };
}
