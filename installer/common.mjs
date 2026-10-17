import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const isMac = platform() === "darwin";
export const isWin = platform() === "win32";
export const HOME = homedir();
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const AEMCP_DIR = join(HOME, ".aemcp");
export const CONFIG_FILE = join(AEMCP_DIR, "config.json");
export const SERVER_FILE = join(AEMCP_DIR, "server", "ae-mcp.mjs");
export const SERVER_NAME = "after-effects";
export const EXTENSION_ID = "com.aemcp";
export const CSXS_VERSIONS = [9, 10, 11, 12, 13, 14];

const APPDATA = process.env.APPDATA || join(HOME, "AppData", "Roaming");

export function cepExtensionsDir() {
  return isWin ? join(APPDATA, "Adobe", "CEP", "extensions") : join(HOME, "Library", "Application Support", "Adobe", "CEP", "extensions");
}

export function claudeDesktopConfig() {
  return isWin ? join(APPDATA, "Claude", "claude_desktop_config.json") : join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json");
}

export const cursorConfig = () => join(HOME, ".cursor", "mcp.json");
/** Claude Code stores user-scoped MCP servers in ~/.claude.json (top-level "mcpServers"). */
export const claudeCodeConfig = () => join(HOME, ".claude.json");
export const codexConfig = () => join(HOME, ".codex", "config.toml");

const color = (c) => (s) => (process.stdout.isTTY || isWin ? `\x1b[${c}m${s}\x1b[0m` : s);
export const green = color(32), yellow = color(33), red = color(31), bold = color(1), dim = color(2);
export const ok = (m) => console.log(`  ${green("✔")} ${m}`);
export const warn = (m) => console.log(`  ${yellow("!")} ${m}`);
export const fail = (m) => console.log(`  ${red("✖")} ${m}`);
export const step = (m) => console.log(`\n${bold(m)}`);

export function readJson(file, fallback = {}) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Write JSON, keeping a one-time .bak of the original file. */
export function writeJsonWithBackup(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file) && !existsSync(file + ".aemcp.bak")) copyFileSync(file, file + ".aemcp.bak");
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export function which(cmd) {
  const r = spawnSync(isWin ? "where" : "which", [cmd], { encoding: "utf8", shell: false });
  if (r.status === 0) return r.stdout.split(/\r?\n/).find(Boolean)?.trim() || null;
  return null;
}

export function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: "pipe", encoding: "utf8", shell: isWin && /\.(cmd|bat)$/i.test(cmd), ...opts });
}

/** Prefer the node on PATH (often a stable symlink that survives upgrades) over the resolved binary. */
export function stableNodePath() {
  const onPath = which("node");
  return onPath && existsSync(onPath) ? onPath : process.execPath;
}

/** Locate the claude CLI (Claude Code), including common install locations not on PATH. */
export function findClaudeCli() {
  const found = which("claude");
  if (found) return found;
  const candidates = isWin
    ? [join(APPDATA, "npm", "claude.cmd"), join(HOME, ".local", "bin", "claude.exe")]
    : [join(HOME, ".local", "bin", "claude"), join(HOME, ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  return candidates.find((c) => existsSync(c)) || null;
}

// --- Codex (TOML) helpers: we only add/remove our own table, leaving the rest untouched ---
const CODEX_START = "# >>> ae-mcp >>>";
const CODEX_END = "# <<< ae-mcp <<<";

export function removeCodexBlock(text) {
  const re = new RegExp(`\\n?${CODEX_START}[\\s\\S]*?${CODEX_END}\\n?`, "g");
  return text.replace(re, "\n");
}

export function codexBlock(nodePath, serverFile) {
  const q = (s) => JSON.stringify(s);
  return `${CODEX_START}\n[mcp_servers.${SERVER_NAME}]\ncommand = ${q(nodePath)}\nargs = [${q(serverFile)}]\nstartup_timeout_sec = 20\ntool_timeout_sec = 600\n${CODEX_END}\n`;
}
