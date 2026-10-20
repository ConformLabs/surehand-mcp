import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { backupFile, readJsonFile, stripBom, writeFileAtomic } from "../fsutil.js";
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
/** VS Code's user-profile mcp.json (the default profile): top key "servers", entries with type "stdio". */
export const vscodeUserDir = () =>
  isWin ? join(APPDATA_(), "Code", "User")
  : isMac ? join(HOME_(), "Library", "Application Support", "Code", "User")
  : join(process.env.XDG_CONFIG_HOME || join(HOME_(), ".config"), "Code", "User");
export const vscodeConfig = () => join(vscodeUserDir(), "mcp.json");
/**
 * Windsurf was renamed Devin Desktop (June 2026), which reads ~/.config/devin/mcp_config.json (%APPDATA%\devin on
 * Windows; XDG_CONFIG_HOME is honoured), shared with the Devin CLI. Windsurf before the rename read
 * ~/.codeium/windsurf/mcp_config.json.
 */
export const devinConfig = () =>
  isWin ? join(APPDATA_(), "devin", "mcp_config.json") : join(process.env.XDG_CONFIG_HOME || join(HOME_(), ".config"), "devin", "mcp_config.json");
export const windsurfLegacyConfig = () => join(HOME_(), ".codeium", "windsurf", "mcp_config.json");
/** LM Studio's mcp.json (Cursor's notation; %USERPROFILE%\.lmstudio on Windows). */
export const lmStudioConfig = () => join(HOME_(), ".lmstudio", "mcp.json");

/** An app bundle in /Applications or ~/Applications (Mac), or one of these folders (Windows). */
const appThere = (mac: string[], win: string[]) =>
  isMac ? mac.some((a) => existsSync(join("/Applications", a)) || existsSync(join(HOME_(), "Applications", a)))
  : isWin ? win.some((p) => existsSync(p))
  : false;

/** VS Code: its settings folder (made on its first start), else the app (user or system install). */
export function vscodeInstalled(): boolean {
  return (
    existsSync(dirname(vscodeUserDir())) ||
    appThere(["Visual Studio Code.app"], [join(LOCALAPPDATA_(), "Programs", "Microsoft VS Code"), join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft VS Code")])
  );
}
/** Windsurf or Devin Desktop: their settings folders, else the app. */
export function windsurfInstalled(): boolean {
  const appData = isWin ? APPDATA_() : join(HOME_(), "Library", "Application Support");
  return (
    existsSync(dirname(windsurfLegacyConfig())) ||
    existsSync(dirname(devinConfig())) ||
    existsSync(join(appData, "Windsurf")) ||
    appThere(["Windsurf.app", "Devin.app"], [join(LOCALAPPDATA_(), "Programs", "Windsurf"), join(LOCALAPPDATA_(), "Programs", "Devin")])
  );
}
/** LM Studio: its ~/.lmstudio folder, else the app. */
export function lmStudioInstalled(): boolean {
  return existsSync(dirname(lmStudioConfig())) || appThere(["LM Studio.app"], [join(LOCALAPPDATA_(), "Programs", "LM Studio"), join(LOCALAPPDATA_(), "Programs", "lm-studio")]);
}
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

/** A JSON file's contents, or `fallback` when it is missing or unreadable (for display only: never write it back). */
export function readJson<T = any>(file: string, fallback: T): T {
  try {
    return JSON.parse(stripBom(readFileSync(file, "utf8")));
  } catch {
    return fallback;
  }
}

/** A timestamped backup (the newest five are kept) before every change of a settings file. */
export function backupBeforeWrite(file: string) {
  backupFile(file);
}

/** Write a text settings file: backup first, then an atomic replace that keeps the file's permissions. */
export function writeTextWithBackup(file: string, text: string) {
  backupFile(file);
  writeFileAtomic(file, text);
}

export { readJsonFile };

export function which(cmd: string): string | null {
  const r = spawnSync(isWin ? "where" : "which", [cmd], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.split(/\r?\n/).find(Boolean)?.trim() || null;
  return null;
}

// cmd.exe metacharacters: escaped with ^ (as cross-spawn does)
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
function cmdArg(arg: string): string {
  // Windows argv rules first (backslashes before a quote are doubled, the quote escaped), then cmd.exe's
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  a = `"${a}"`.replace(CMD_META, "^$1");
  // a .cmd / .bat shim (npm's claude.cmd) passes its arguments through cmd.exe a second time
  return a.replace(CMD_META, "^$1");
}

/**
 * The command line for `cmd.exe /d /s /c` that runs a .cmd/.bat with exactly these arguments (no
 * shell interpretation of &, |, %, quotes... in them).
 */
export function cmdExeLine(cmd: string, args: string[]): string {
  return `"${[cmd.replace(CMD_META, "^$1"), ...args.map(cmdArg)].join(" ")}"`;
}

export function run(cmd: string, args: string[]) {
  if (isWin && /\.(cmd|bat)$/i.test(cmd)) {
    const r = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", cmdExeLine(cmd, args)], { stdio: "pipe", encoding: "utf8", windowsVerbatimArguments: true });
    if (r.error) throw r.error;
    if (r.status !== 0) throw Object.assign(new Error(`${cmd} exited with ${r.status}: ${(r.stderr || r.stdout || "").trim()}`), { stderr: r.stderr, stdout: r.stdout, status: r.status });
    return r.stdout;
  }
  return execFileSync(cmd, args, { stdio: "pipe", encoding: "utf8" });
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
