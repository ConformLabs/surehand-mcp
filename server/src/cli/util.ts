import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

export const isMac = platform() === "darwin";
export const isWin = platform() === "win32";
export const HOME = homedir();
export const AEMCP_DIR = join(HOME, ".aemcp");
export const CONFIG_FILE = join(AEMCP_DIR, "config.json");
export const INSTALLED_SERVER = join(AEMCP_DIR, "server", "ae-mcp.mjs");
export const SERVER_NAME = "after-effects";
export const EXTENSION_ID = "com.aemcp";
export const CSXS_VERSIONS = [9, 10, 11, 12, 13, 14];

const APPDATA = process.env.APPDATA || join(HOME, "AppData", "Roaming");
const LOCALAPPDATA = process.env.LOCALAPPDATA || join(HOME, "AppData", "Local");

export const cepExtensionsDir = () =>
  isWin ? join(APPDATA, "Adobe", "CEP", "extensions") : join(HOME, "Library", "Application Support", "Adobe", "CEP", "extensions");
export const extensionDir = () => join(cepExtensionsDir(), EXTENSION_ID);
export const claudeDesktopDir = () => (isWin ? join(APPDATA, "Claude") : join(HOME, "Library", "Application Support", "Claude"));
export const claudeDesktopConfig = () => join(claudeDesktopDir(), "claude_desktop_config.json");
export const claudeCodeConfig = () => join(HOME, ".claude.json");
export const cursorConfig = () => join(HOME, ".cursor", "mcp.json");
/** ChatGPT desktop and Codex share this file (CODEX_HOME overrides ~/.codex). */
export const codexConfig = () => join(process.env.CODEX_HOME || join(HOME, ".codex"), "config.toml");

/** True if the ChatGPT desktop app or Codex is installed, even if it hasn't created ~/.codex yet. */
export function chatgptDesktopInstalled(): boolean {
  if (which("codex")) return true;
  if (isMac)
    return ["/Applications/ChatGPT.app", "/Applications/Codex.app", join(HOME, "Applications", "ChatGPT.app")].some((p) => existsSync(p));
  if (isWin) {
    if ([join(LOCALAPPDATA, "Programs", "ChatGPT"), join(LOCALAPPDATA, "Microsoft", "WindowsApps", "ChatGPT.exe")].some((p) => existsSync(p))) return true;
    try {
      return readdirSync(join(LOCALAPPDATA, "Packages")).some((n) => /^OpenAI\.(ChatGPT|Codex)/i.test(n));
    } catch {
      return false;
    }
  }
  return false;
}
export const claudeDesktopExe = () => join(LOCALAPPDATA, "AnthropicClaude", "claude.exe");

const useColor = process.stdout.isTTY || isWin;
const color = (c: number) => (s: string) => (useColor ? `\x1b[${c}m${s}\x1b[0m` : s);
export const green = color(32), yellow = color(33), red = color(31), bold = color(1), dim = color(2);
export const ok = (m: string) => console.log(`  ${green("✔")} ${m}`);
export const warn = (m: string) => console.log(`  ${yellow("!")} ${m}`);
export const fail = (m: string) => console.log(`  ${red("✖")} ${m}`);
export const step = (m: string) => console.log(`\n${bold(m)}`);

export function readJson<T = any>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Write JSON, keeping a one-time .aemcp.bak of the original file. */
export function writeJsonWithBackup(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file) && !existsSync(file + ".aemcp.bak")) copyFileSync(file, file + ".aemcp.bak");
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export function which(cmd: string): string | null {
  const r = spawnSync(isWin ? "where" : "which", [cmd], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.split(/\r?\n/).find(Boolean)?.trim() || null;
  return null;
}

export function run(cmd: string, args: string[]) {
  return execFileSync(cmd, args, { stdio: "pipe", encoding: "utf8", shell: isWin && /\.(cmd|bat)$/i.test(cmd) });
}

/** Prefer the node on PATH (often a stable symlink that survives upgrades) over the resolved binary. */
export function stableNodePath(): string {
  // a Node the wrapper downloaded into ~/.aemcp/node is already stable
  if (process.execPath.startsWith(join(AEMCP_DIR, "node"))) return process.execPath;
  const onPath = which("node");
  return onPath && existsSync(onPath) ? onPath : process.execPath;
}

export function findClaudeCli(): string | null {
  const found = which("claude");
  if (found) return found;
  const candidates = isWin
    ? [join(APPDATA, "npm", "claude.cmd"), join(HOME, ".local", "bin", "claude.exe")]
    : [join(HOME, ".local", "bin", "claude"), join(HOME, ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  return candidates.find((c) => existsSync(c)) || null;
}

/** Yes/no prompt. Without a terminal (nobody to answer) it returns false: never act unasked. */
export async function ask(question: string, def = true): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a: string = await new Promise((r) => rl.question(`  ${question} ${def ? "[Y/n]" : "[y/N]"} `, r));
  rl.close();
  return a.trim() === "" ? def : /^y/i.test(a.trim());
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Codex (TOML): only add/remove our own marked block ---
const CODEX_START = "# >>> ae-mcp >>>";
const CODEX_END = "# <<< ae-mcp <<<";
export function removeCodexBlock(text: string) {
  return text.replace(new RegExp(`\\n?${CODEX_START}[\\s\\S]*?${CODEX_END}\\n?`, "g"), "\n");
}
export function codexBlock(nodePath: string, serverFile: string) {
  const q = (s: string) => JSON.stringify(s);
  return `${CODEX_START}\n[mcp_servers.${SERVER_NAME}]\ncommand = ${q(nodePath)}\nargs = [${q(serverFile)}]\nstartup_timeout_sec = 20\ntool_timeout_sec = 600\n${CODEX_END}\n`;
}
