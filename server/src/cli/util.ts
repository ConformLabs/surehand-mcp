import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { mapLegacyPath } from "../migrate.js";
import { privateNodeDir, SERVER_NAME, surehandRoot } from "../paths.js";

export const isMac = platform() === "darwin";
export const isWin = platform() === "win32";
/** Read when used (tests and the uninstaller run with other home folders). */
const HOME_ = () => homedir();
export { SERVER_NAME, LEGACY_SERVER_NAME, appDir, configPath, installedServer } from "../paths.js";
export const EXTENSION_ID = "com.aemcp";
export const CSXS_VERSIONS = [9, 10, 11, 12, 13, 14];

const APPDATA_ = () => process.env.APPDATA || join(HOME_(), "AppData", "Roaming");
const LOCALAPPDATA_ = () => process.env.LOCALAPPDATA || join(HOME_(), "AppData", "Local");

export const cepExtensionsDir = () =>
  isWin ? join(APPDATA_(), "Adobe", "CEP", "extensions") : join(HOME_(), "Library", "Application Support", "Adobe", "CEP", "extensions");
export const extensionDir = () => join(cepExtensionsDir(), EXTENSION_ID);
export const claudeDesktopDir = () => (isWin ? join(APPDATA_(), "Claude") : join(HOME_(), "Library", "Application Support", "Claude"));
export const claudeDesktopConfig = () => join(claudeDesktopDir(), "claude_desktop_config.json");
export const claudeCodeConfig = () => join(HOME_(), ".claude.json");
export const cursorConfig = () => join(HOME_(), ".cursor", "mcp.json");
/** ChatGPT desktop and Codex share this file (CODEX_HOME overrides ~/.codex). */
export const codexConfig = () => join(process.env.CODEX_HOME || join(HOME_(), ".codex"), "config.toml");

/** True if the ChatGPT desktop app or Codex is installed, even if it hasn't created ~/.codex yet. */
export function chatgptDesktopInstalled(): boolean {
  if (which("codex")) return true;
  if (isMac)
    return ["/Applications/ChatGPT.app", "/Applications/Codex.app", join(HOME_(), "Applications", "ChatGPT.app")].some((p) => existsSync(p));
  if (isWin) {
    if ([join(LOCALAPPDATA_(), "Programs", "ChatGPT"), join(LOCALAPPDATA_(), "Microsoft", "WindowsApps", "ChatGPT.exe")].some((p) => existsSync(p))) return true;
    try {
      return readdirSync(join(LOCALAPPDATA_(), "Packages")).some((n) => /^OpenAI\.(ChatGPT|Codex)/i.test(n));
    } catch {
      return false;
    }
  }
  return false;
}
export const claudeDesktopExe = () => join(LOCALAPPDATA_(), "AnthropicClaude", "claude.exe");

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

/** Keep a one-time backup of a settings file before the first change (<file>.surehand.bak). 1.3 wrote
 *  <file>.aemcp.bak: an existing one already holds the original, so no second copy is made. */
export function backupOnce(file: string) {
  if (existsSync(file) && !existsSync(file + ".aemcp.bak") && !existsSync(file + ".surehand.bak")) copyFileSync(file, file + ".surehand.bak");
}

/** Write JSON, keeping a one-time backup of the original file. */
export function writeJsonWithBackup(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  backupOnce(file);
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

/** The private Node.js the installers put in ~/.surehand/node, if it is there. */
export function privateNode(): string | null {
  const p = join(privateNodeDir(), ...(isWin ? ["node.exe"] : ["bin", "node"]));
  return existsSync(p) ? p : null;
}

/** Prefer the node on PATH (often a stable symlink that survives upgrades) over the resolved binary. */
export function stableNodePath(execPath = process.execPath): string {
  // a private Node (installers, or the launcher's download) is already stable; one still in the
  // 1.3 folder (~/.aemcp/node) is used from where it moved to
  const mapped = mapLegacyPath(execPath);
  if (mapped !== execPath && existsSync(mapped)) return mapped;
  if (execPath.startsWith(privateNodeDir()) || execPath.startsWith(join(surehandRoot(), "node"))) return execPath;
  const onPath = which("node");
  return onPath && existsSync(onPath) ? onPath : execPath;
}

export function findClaudeCli(): string | null {
  const found = which("claude");
  if (found) return found;
  const candidates = isWin
    ? [join(APPDATA_(), "npm", "claude.cmd"), join(HOME_(), ".local", "bin", "claude.exe")]
    : [join(HOME_(), ".local", "bin", "claude"), join(HOME_(), ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
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

// --- Codex (TOML): only add/remove our own marked block (1.3 marked it "ae-mcp") ---
const CODEX_START = `# >>> ${SERVER_NAME} >>>`;
const CODEX_END = `# <<< ${SERVER_NAME} <<<`;
export function removeCodexBlock(text: string) {
  return text.replace(/\n?# >>> (?:ae-mcp|surehand-ae) >>>[\s\S]*?# <<< (?:ae-mcp|surehand-ae) <<<\n?/g, "\n");
}
/** True if the text has our block (either name). */
export const hasCodexBlock = (text: string) => /# >>> (?:ae-mcp|surehand-ae) >>>/.test(text);
export function codexBlock(nodePath: string, serverFile: string) {
  const q = (s: string) => JSON.stringify(s);
  return `${CODEX_START}\n[mcp_servers.${SERVER_NAME}]\ncommand = ${q(nodePath)}\nargs = [${q(serverFile)}]\nstartup_timeout_sec = 20\ntool_timeout_sec = 600\n${CODEX_END}\n`;
}
